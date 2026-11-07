import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { forbidden, notFound } from '../lib/errors.js';
import { serializeProperties } from '../lib/properties.js';
import { createServer, serverConfigSchema } from './servers.js';
import type { ServerRow, UserRow } from './types.js';

export interface TemplateRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  shared: boolean;
  created_at: Date;
}

export const templateConfigSchema = serverConfigSchema.extend({
  properties: z.record(z.string()).optional(),
});

export function toPublicTemplate(t: TemplateRow & { owner_name?: string | null }, viewer: UserRow) {
  return {
    id: t.id,
    ownerId: t.owner_id,
    ownerName: t.owner_name ?? null,
    name: t.name,
    description: t.description,
    config: t.config,
    shared: t.shared,
    createdAt: t.created_at.toISOString(),
    canDelete: viewer.role === 'admin' || viewer.id === t.owner_id,
  };
}

export async function createTemplate(
  user: UserRow,
  name: string,
  description: string | null,
  config: Record<string, unknown>,
  shared: boolean,
) {
  const cfg = templateConfigSchema.parse(config);
  const row = await queryOne<TemplateRow>(
    `INSERT INTO templates (owner_id, name, description, config, shared) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [user.id, name, description, JSON.stringify(cfg), shared],
  );
  return toPublicTemplate({ ...row!, owner_name: user.username }, user);
}

export async function listTemplates(user: UserRow) {
  const rows = await query<TemplateRow & { owner_name: string | null }>(
    `SELECT t.*, u.username AS owner_name FROM templates t LEFT JOIN users u ON u.id = t.owner_id
     WHERE t.owner_id = $1 OR t.shared OR $2 ORDER BY t.created_at DESC`,
    [user.id, user.role === 'admin'],
  );
  return rows.map((r) => toPublicTemplate(r, user));
}

export async function getTemplateFor(user: UserRow, id: string): Promise<TemplateRow> {
  const t = /^[0-9a-f-]{36}$/i.test(id) ? await queryOne<TemplateRow>('SELECT * FROM templates WHERE id = $1', [id]) : null;
  if (!t || (!t.shared && t.owner_id !== user.id && user.role !== 'admin')) throw notFound('Template not found', 'template_not_found');
  return t;
}

export async function deleteTemplate(user: UserRow, id: string): Promise<void> {
  const t = await getTemplateFor(user, id);
  if (t.owner_id !== user.id && user.role !== 'admin') throw forbidden('Only the owner can delete this template');
  await query('DELETE FROM templates WHERE id = $1', [id]);
}

export const instantiateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  port: z.number().int().min(1).max(65535).optional(),
  memoryMb: z.number().int().min(512).max(1_048_576).optional(),
  cpu: z.number().min(0.1).max(256).optional(),
  diskMb: z.number().int().min(256).nullable().optional(),
  mcVersion: z.string().min(1).max(64).optional(),
  loaderVersion: z.string().max(128).nullable().optional(),
  env: z.record(z.string()).optional(),
  autoRestart: z.boolean().optional(),
  eula: z.literal(true, { errorMap: () => ({ message: 'You must accept the Minecraft EULA' }) }),
  ownerId: z.string().uuid().optional(),
});

export async function instantiateTemplate(
  user: UserRow,
  t: TemplateRow,
  overrides: z.infer<typeof instantiateSchema>,
): Promise<ServerRow> {
  const cfg = templateConfigSchema.parse(t.config);
  const { properties, ...base } = cfg;
  return createServer(
    user,
    {
      ...base,
      name: overrides.name,
      port: overrides.port,
      memoryMb: overrides.memoryMb ?? base.memoryMb,
      cpu: overrides.cpu ?? base.cpu,
      diskMb: overrides.diskMb !== undefined ? overrides.diskMb : (base.diskMb ?? null),
      mcVersion: overrides.mcVersion ?? base.mcVersion,
      loaderVersion: overrides.loaderVersion !== undefined ? overrides.loaderVersion : base.loaderVersion,
      env: { ...(base.env ?? {}), ...(overrides.env ?? {}) },
      autoRestart: overrides.autoRestart ?? base.autoRestart,
      ownerId: overrides.ownerId,
    },
    async (dir) => {
      if (properties && Object.keys(properties).length) {
        await fsp.writeFile(path.join(dir, 'server.properties'), serializeProperties(properties));
      }
    },
  );
}
