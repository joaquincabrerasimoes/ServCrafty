import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { requireUser } from '../auth/plugin.js';
import { notFound } from '../lib/errors.js';
import { idParam, parse } from '../lib/validation.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import {
  register,
  runSchedule,
  scheduleActions,
  schedulePayloadSchema,
  toPublicSchedule,
  unregister,
  validateCron,
  validateSchedule,
  type ScheduleRow,
} from '../services/scheduler.js';
import type { UserRow } from '../services/types.js';

async function loadSchedule(user: UserRow, id: string): Promise<ScheduleRow> {
  const s = await queryOne<ScheduleRow>('SELECT * FROM schedules WHERE id = $1', [id]);
  if (!s) throw notFound('Schedule not found', 'schedule_not_found');
  await loadServerFor(user, s.server_id, 'manager');
  return s;
}

export default async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/servers/:id/schedules', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    const rows = await query<ScheduleRow>('SELECT * FROM schedules WHERE server_id = $1 ORDER BY created_at', [server.id]);
    return rows.map(toPublicSchedule);
  });

  app.post<{ Params: { id: string } }>('/servers/:id/schedules', async (req, reply) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(
      z.object({
        cron: z.string().min(9).max(120),
        action: z.enum(scheduleActions),
        payload: schedulePayloadSchema.default({}),
        enabled: z.boolean().default(true),
      }),
      req.body,
    );
    validateCron(body.cron);
    validateSchedule(body.action, body.payload);
    const row = await queryOne<ScheduleRow>(
      `INSERT INTO schedules (server_id, cron, action, payload, enabled) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [server.id, body.cron, body.action, JSON.stringify(body.payload), body.enabled],
    );
    register(row!);
    await audit(req, 'schedule.created', 'schedule', row!.id, { serverId: server.id, action: body.action, cron: body.cron });
    reply.code(201);
    return toPublicSchedule(row!);
  });

  app.patch('/schedules/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const s = await loadSchedule(user, id);
    const body = parse(
      z
        .object({
          cron: z.string().min(9).max(120),
          action: z.enum(scheduleActions),
          payload: schedulePayloadSchema,
          enabled: z.boolean(),
        })
        .partial(),
      req.body,
    );
    const cron = body.cron ?? s.cron;
    const action = body.action ?? s.action;
    const payload = body.payload ?? s.payload;
    validateCron(cron);
    validateSchedule(action, payload);
    const row = await queryOne<ScheduleRow>(
      `UPDATE schedules SET cron=$2, action=$3, payload=$4, enabled=$5 WHERE id=$1 RETURNING *`,
      [id, cron, action, JSON.stringify(payload), body.enabled ?? s.enabled],
    );
    register(row!);
    await audit(req, 'schedule.updated', 'schedule', id, { fields: Object.keys(body) });
    return toPublicSchedule(row!);
  });

  app.delete('/schedules/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadSchedule(user, id);
    unregister(id);
    await query('DELETE FROM schedules WHERE id = $1', [id]);
    await audit(req, 'schedule.deleted', 'schedule', id);
    return { ok: true };
  });

  /** Run a schedule immediately (extra endpoint, useful for testing). */
  app.post('/schedules/:id/run', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const s = await loadSchedule(user, id);
    await runSchedule(s);
    const fresh = await queryOne<ScheduleRow>('SELECT * FROM schedules WHERE id = $1', [id]);
    await audit(req, 'schedule.run', 'schedule', id);
    return toPublicSchedule(fresh!);
  });
}
