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
  log: [serverId: string, line: string];
  status: [serverId: string, status: ServerStatus];
  stats: [serverId: string, stats: Stats];
  notify: [serverId: string, event: WebhookEvent, data: Record<string, unknown>];
}

class TypedBus extends EventEmitter<BusEvents> {}

/** Process-wide event bus connecting orchestration, WS streaming and webhooks. */
export const bus = new TypedBus();
bus.setMaxListeners(0);
