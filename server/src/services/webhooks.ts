import type { FastifyBaseLogger } from 'fastify';
import { USER_AGENT } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { hmacSha256 } from '../lib/crypto.js';
import { AppError, errorMessage } from '../lib/errors.js';
import { assertPublicUrl } from '../lib/ssrf.js';
import { bus, type WebhookEvent } from './events.js';
import { getPublicUrl } from './settings.js';
import type { ServerRow } from './types.js';

export interface WebhookRow {
  id: string;
  server_id: string | null;
  owner_id: string;
  name: string | null;
  url: string;
  kind: 'discord' | 'generic';
  events: string[];
  enabled: boolean;
  secret: string | null;
  created_at: Date;
}

export function toPublicWebhook(w: WebhookRow) {
  return {
    id: w.id,
    serverId: w.server_id,
    ownerId: w.owner_id,
    name: w.name,
    url: w.url,
    kind: w.kind,
    events: w.events,
    enabled: w.enabled,
    hasSecret: !!w.secret,
    createdAt: w.created_at.toISOString(),
  };
}

const COLORS: Partial<Record<WebhookEvent, number>> = {
  'server.running': 0x2ecc71,
  'server.starting': 0x3498db,
  'server.stopped': 0x95a5a6,
  'server.crashed': 0xe74c3c,
  'server.restarted': 0xf1c40f,
  'backup.failed': 0xe74c3c,
  'backup.created': 0x1abc9c,
  'schedule.failed': 0xe67e22,
  'disk.exceeded': 0xe67e22,
  'player.join': 0x2ecc71,
  'player.leave': 0x7f8c8d,
};

function describe(event: WebhookEvent | 'test', data: Record<string, unknown>): string {
  switch (event) {
    case 'server.starting':
      return 'Server is starting';
    case 'server.running':
      return 'Server is online';
    case 'server.stopped':
      return 'Server stopped';
    case 'server.crashed':
      return `Server crashed (exit code ${String(data.exitCode ?? '?')}${data.oom ? ', out of memory' : ''})`;
    case 'server.restarted':
      return 'Server was restarted automatically after a crash';
    case 'player.join':
      return `${String(data.player)} joined the game`;
    case 'player.leave':
      return `${String(data.player)} left the game`;
    case 'backup.created':
      return `Backup created: ${String(data.file)}`;
    case 'backup.failed':
      return `Backup failed: ${String(data.error)}`;
    case 'schedule.failed':
      return `Scheduled ${String(data.action)} failed: ${String(data.error)}`;
    case 'disk.exceeded':
      return `Disk usage ${String(data.usedMb)} MB exceeds the ${String(data.limitMb)} MB limit`;
    case 'test':
      return 'This is a test notification from ServCrafty';
  }
}

/** Turn undici's opaque "fetch failed" into a message that says what actually went wrong. */
export function describeFetchError(err: unknown, url: string): string {
  if (err instanceof AppError) return err.message;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep raw url */
  }
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `${host} did not respond in time`;
  const code = e?.cause?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return `Connection refused by ${host}`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Could not resolve host ${host}`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `Connection to ${host} timed out`;
    case 'ECONNRESET':
      return `Connection to ${host} was reset`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${host} is unreachable`;
  }
  if (code?.startsWith('ERR_TLS') || code?.startsWith('CERT_') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    return `TLS error talking to ${host} (${code})`;
  const detail = e?.cause?.message ?? e?.message;
  return `Could not reach ${host}${detail && detail !== 'fetch failed' ? `: ${detail}` : ''}`;
}

export interface PostOptions {
  /** Delivery attempts (default 3, with backoff). The test endpoint uses 1 so it fails fast. */
  attempts?: number;
  timeoutMs?: number;
}

async function post(w: WebhookRow, body: string, opts: PostOptions = {}): Promise<void> {
  const attempts = opts.attempts ?? 3;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT };
  if (w.secret && w.kind === 'generic') headers['X-ServCrafty-Signature'] = `sha256=${hmacSha256(w.secret, body)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      // Re-check at delivery time (DNS may have changed since the webhook was saved) and never follow redirects.
      await assertPublicUrl(w.url);
      const res = await fetch(w.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
      if (res.ok) return;
      if (res.status === 429) {
        lastErr = new Error('HTTP 429 (rate limited)');
        if (attempt >= attempts - 1) break;
        const retry = Number(res.headers.get('retry-after') ?? '2');
        await new Promise((r) => setTimeout(r, Math.min(30, retry || 2) * 1000));
        continue;
      }
      lastErr = new Error(`The webhook endpoint responded HTTP ${res.status}`);
      if (res.status < 500) break;
    } catch (err) {
      if (err instanceof AppError) throw err; // blocked target: no point retrying
      lastErr = new Error(describeFetchError(err, w.url));
    }
    if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function deliver(
  w: WebhookRow,
  server: Pick<ServerRow, 'id' | 'name'>,
  event: WebhookEvent | 'test',
  data: Record<string, unknown>,
  opts: PostOptions = {},
): Promise<void> {
  const text = describe(event, data);
  const ts = new Date().toISOString();
  const publicUrl = await getPublicUrl();
  const body =
    w.kind === 'discord'
      ? JSON.stringify({
          username: 'ServCrafty',
          embeds: [
            {
              title: server.name,
              description: text,
              color: event === 'test' ? 0x9b59b6 : (COLORS[event] ?? 0x3498db),
              url: `${publicUrl}/servers/${server.id}`,
              footer: { text: event },
              timestamp: ts,
            },
          ],
        })
      : JSON.stringify({ event, message: text, server: { id: server.id, name: server.name }, data, timestamp: ts });
  await post(w, body, opts);
}

async function targetsFor(server: ServerRow, event: WebhookEvent): Promise<WebhookRow[]> {
  return query<WebhookRow>(
    `SELECT w.* FROM webhooks w JOIN users u ON u.id = w.owner_id
     WHERE w.enabled AND (cardinality(w.events) = 0 OR $2 = ANY(w.events))
       AND (w.server_id = $1 OR (w.server_id IS NULL AND (w.owner_id = $3 OR u.role = 'admin')))`,
    [server.id, event, server.owner_id],
  );
}

export function initWebhooks(log: FastifyBaseLogger): void {
  bus.on('notify', (serverId, event, data) => {
    void (async () => {
      const server = await queryOne<ServerRow>('SELECT * FROM servers WHERE id = $1', [serverId]);
      if (!server) return;
      const hooks = await targetsFor(server, event);
      await Promise.all(
        hooks.map((w) =>
          deliver(w, server, event, data).catch((err: unknown) =>
            log.warn({ webhookId: w.id, event, err: errorMessage(err) }, 'webhook delivery failed'),
          ),
        ),
      );
    })().catch((err: unknown) => log.error({ err }, 'webhook dispatch failed'));
  });
}
