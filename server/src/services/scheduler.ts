import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { badRequest, errorMessage } from '../lib/errors.js';
import { createBackup, pruneBackups } from './backups.js';
import { bus } from './events.js';
import * as runtime from './runtime.js';
import type { ServerRow } from './types.js';

export const scheduleActions = ['restart', 'command', 'backup', 'start', 'stop'] as const;
export type ScheduleAction = (typeof scheduleActions)[number];

export interface ScheduleRow {
  id: string;
  server_id: string;
  cron: string;
  action: ScheduleAction;
  payload: { command?: string; keep?: number; warnSeconds?: number; note?: string };
  enabled: boolean;
  last_run_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

export const schedulePayloadSchema = z
  .object({
    command: z.string().min(1).max(1000).optional(),
    keep: z.number().int().min(1).max(1000).optional(),
    warnSeconds: z.number().int().min(0).max(600).optional(),
    note: z.string().max(200).optional(),
  })
  .strict();

export function validateCron(expr: string): void {
  if (!cron.validate(expr)) throw badRequest('Invalid cron expression', 'invalid_cron');
}

export function validateSchedule(action: ScheduleAction, payload: ScheduleRow['payload']): void {
  if (action === 'command' && !payload.command) throw badRequest('payload.command is required', 'command_required');
}

export function toPublicSchedule(s: ScheduleRow) {
  return {
    id: s.id,
    serverId: s.server_id,
    cron: s.cron,
    action: s.action,
    payload: s.payload,
    enabled: s.enabled,
    lastRunAt: s.last_run_at?.toISOString() ?? null,
    lastError: s.last_error,
    createdAt: s.created_at.toISOString(),
  };
}

const tasks = new Map<string, cron.ScheduledTask>();
let log: FastifyBaseLogger | Console = console;

async function warn(serverId: string, seconds: number, what: string): Promise<void> {
  if (seconds <= 0 || runtime.getStatus(serverId) !== 'running') return;
  await runtime.tryRcon(serverId, `say Server ${what} in ${seconds} seconds`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
}

export async function runSchedule(s: ScheduleRow): Promise<void> {
  const server = await queryOne<ServerRow>('SELECT * FROM servers WHERE id = $1', [s.server_id]);
  if (!server) return;
  let error: string | null = null;
  try {
    switch (s.action) {
      case 'start':
        if (!runtime.isRunning(server.id)) await runtime.start(server.id);
        break;
      case 'stop':
        await warn(server.id, s.payload.warnSeconds ?? 0, 'stopping');
        if (runtime.isRunning(server.id)) await runtime.stop(server.id);
        break;
      case 'restart':
        await warn(server.id, s.payload.warnSeconds ?? 0, 'restarting');
        await runtime.restart(server.id);
        break;
      case 'command':
        await runtime.sendCommand(server.id, s.payload.command ?? '');
        break;
      case 'backup':
        await createBackup(server, 'scheduled', null, s.payload.note ?? 'Scheduled backup');
        if (s.payload.keep) await pruneBackups(server.id, s.payload.keep, 'scheduled');
        break;
    }
  } catch (err) {
    error = errorMessage(err);
    log.warn({ scheduleId: s.id, err: error }, 'scheduled task failed');
    bus.emit('notify', server.id, 'schedule.failed', { scheduleId: s.id, action: s.action, error });
  }
  await query('UPDATE schedules SET last_run_at = now(), last_error = $2 WHERE id = $1', [s.id, error]);
}

export function register(s: ScheduleRow): void {
  unregister(s.id);
  if (!s.enabled || !cron.validate(s.cron)) return;
  const task = cron.schedule(
    s.cron,
    () => {
      // Reload so edits made since registration are honored.
      void queryOne<ScheduleRow>('SELECT * FROM schedules WHERE id = $1', [s.id])
        .then((fresh) => (fresh && fresh.enabled ? runSchedule(fresh) : undefined))
        .catch((err: unknown) => log.error({ err }, 'schedule run failed'));
    },
    { scheduled: true },
  );
  tasks.set(s.id, task);
}

export function unregister(id: string): void {
  tasks.get(id)?.stop();
  tasks.delete(id);
}

export async function unregisterServer(serverId: string): Promise<void> {
  const rows = await query<{ id: string }>('SELECT id FROM schedules WHERE server_id = $1', [serverId]);
  for (const r of rows) unregister(r.id);
}

export async function initScheduler(logger: FastifyBaseLogger): Promise<void> {
  log = logger;
  const rows = await query<ScheduleRow>('SELECT * FROM schedules WHERE enabled');
  for (const r of rows) register(r);
  logger.info(`scheduler: ${tasks.size} task(s) registered`);
}

export function stopScheduler(): void {
  for (const t of tasks.values()) t.stop();
  tasks.clear();
}
