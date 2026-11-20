import { EventEmitter } from 'node:events';
import type { ServerStatus, Stats } from './types.js';

/** Webhook-visible event names. */
export const webhookEvents = [
  'server.starting',
  'server.running',
  'server.stopped',
  'server.crashed',
  'server.restarted',
  'player.join',
  'player.leave',
  'backup.created',
  'backup.failed',
  'schedule.failed',
  'disk.exceeded',
] as const;
export type WebhookEvent = (typeof webhookEvents)[number];

export interface BusEvents {
  /** `ts`: when the line was written, in docker's format (2026-11-20T07:46:00.589825612Z). */
  log: [serverId: string, line: string, ts: string];
  status: [serverId: string, status: ServerStatus];
  stats: [serverId: string, stats: Stats];
  notify: [serverId: string, event: WebhookEvent, data: Record<string, unknown>];
}

class TypedBus extends EventEmitter<BusEvents> {}

/** Process-wide event bus connecting orchestration, WS streaming and webhooks. */
export const bus = new TypedBus();
bus.setMaxListeners(0);
