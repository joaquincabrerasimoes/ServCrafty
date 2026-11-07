import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { requireUser } from '../auth/plugin.js';
import { errorMessage, notFound, upstream } from '../lib/errors.js';
import { assertPublicUrl } from '../lib/ssrf.js';
import { idParam, parse } from '../lib/validation.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import { webhookEvents } from '../services/events.js';
import type { UserRow } from '../services/types.js';
import { deliver, toPublicWebhook, type WebhookRow } from '../services/webhooks.js';

const urlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), 'URL must be http(s)');

const createSchema = z.object({
  name: z.string().trim().max(64).nullable().optional(),
  url: urlSchema,
  kind: z.enum(['discord', 'generic']).default('generic'),
  events: z.array(z.enum(webhookEvents)).default([]),
  enabled: z.boolean().default(true),
  secret: z.string().max(200).nullable().optional(),
});

async function loadWebhook(user: UserRow, id: string): Promise<WebhookRow> {
  const w = await queryOne<WebhookRow>('SELECT * FROM webhooks WHERE id = $1', [id]);
  if (!w) throw notFound('Webhook not found', 'webhook_not_found');
  if (w.server_id) await loadServerFor(user, w.server_id, 'manager');
  else if (w.owner_id !== user.id && user.role !== 'admin') throw notFound('Webhook not found', 'webhook_not_found');
  return w;
}

async function insert(user: UserRow, serverId: string | null, body: z.infer<typeof createSchema>): Promise<WebhookRow> {
  const row = await queryOne<WebhookRow>(
    `INSERT INTO webhooks (server_id, owner_id, name, url, kind, events, enabled, secret) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [serverId, user.id, body.name ?? null, body.url, body.kind, body.events, body.enabled, body.secret || null],
  );
  return row!;
}

export default async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.get('/webhooks/events', async (req) => {
    requireUser(req);
    return webhookEvents;
  });

  /** Account-wide webhooks (fire for all servers the user owns; for admins: all servers). */
  app.get('/webhooks', async (req) => {
    const user = requireUser(req);
    const rows = await query<WebhookRow>('SELECT * FROM webhooks WHERE server_id IS NULL AND owner_id = $1 ORDER BY created_at', [
      user.id,
    ]);
    return rows.map(toPublicWebhook);
  });

  app.post('/webhooks', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(createSchema, req.body);
    await assertPublicUrl(body.url);
    const row = await insert(user, null, body);
    await audit(req, 'webhook.created', 'webhook', row.id, { global: true });
    reply.code(201);
    return toPublicWebhook(row);
  });

  app.get<{ Params: { id: string } }>('/servers/:id/webhooks', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const rows = await query<WebhookRow>('SELECT * FROM webhooks WHERE server_id = $1 ORDER BY created_at', [server.id]);
    return rows.map(toPublicWebhook);
  });

  app.post<{ Params: { id: string } }>('/servers/:id/webhooks', async (req, reply) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(createSchema, req.body);
    await assertPublicUrl(body.url);
    const row = await insert(user, server.id, body);
    await audit(req, 'webhook.created', 'webhook', row.id, { serverId: server.id });
    reply.code(201);
    return toPublicWebhook(row);
  });

  app.patch('/webhooks/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const w = await loadWebhook(user, id);
    const body = parse(
      z
        .object({
          name: z.string().trim().max(64).nullable(),
          url: urlSchema,
          kind: z.enum(['discord', 'generic']),
          events: z.array(z.enum(webhookEvents)),
          enabled: z.boolean(),
          secret: z.string().max(200).nullable(),
        })
        .partial(),
      req.body,
    );
    if (body.url) await assertPublicUrl(body.url);
    const row = await queryOne<WebhookRow>(
      `UPDATE webhooks SET name=$2, url=$3, kind=$4, events=$5, enabled=$6, secret=$7 WHERE id=$1 RETURNING *`,
      [
        id,
        body.name !== undefined ? body.name : w.name,
        body.url ?? w.url,
        body.kind ?? w.kind,
        body.events ?? w.events,
        body.enabled ?? w.enabled,
        body.secret !== undefined ? body.secret || null : w.secret,
      ],
    );
    await audit(req, 'webhook.updated', 'webhook', id, { fields: Object.keys(body) });
    return toPublicWebhook(row!);
  });

  app.delete('/webhooks/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadWebhook(user, id);
    await query('DELETE FROM webhooks WHERE id = $1', [id]);
    await audit(req, 'webhook.deleted', 'webhook', id);
    return { ok: true };
  });

  app.post('/webhooks/:id/test', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const w = await loadWebhook(user, id);
    const server = w.server_id
      ? await queryOne<{ id: string; name: string }>('SELECT id, name FROM servers WHERE id = $1', [w.server_id])
      : { id: '00000000-0000-0000-0000-000000000000', name: 'ServCrafty' };
    try {
      await deliver(w, server ?? { id: w.server_id ?? '', name: 'ServCrafty' }, 'test', {});
    } catch (err) {
      throw upstream(`Webhook test failed: ${errorMessage(err)}`, 'webhook_failed');
    }
    return { ok: true };
  });
}
