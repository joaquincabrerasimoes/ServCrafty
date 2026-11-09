import { query } from '../db/pool.js';
import { readJson } from '../lib/fsutil.js';
import path from 'node:path';
import { serverDir } from './docker.js';

const KEEP_PER_SERVER = 100;

export interface JoinAttempt {
  name: string;
  uuid: string | null;
  ip: string | null;
  attempts: number;
  firstSeen: string;
  lastSeen: string;
}

export async function recordAttempt(serverId: string, name: string, ip: string | null, uuid: string | null): Promise<void> {
  await query(
    `INSERT INTO whitelist_attempts (server_id, name_lower, name, uuid, ip)
     VALUES ($1, lower($2), $2, $3, $4)
     ON CONFLICT (server_id, name_lower) DO UPDATE
       SET name = EXCLUDED.name,
           uuid = COALESCE(EXCLUDED.uuid, whitelist_attempts.uuid),
           ip = COALESCE(EXCLUDED.ip, whitelist_attempts.ip),
           attempts = whitelist_attempts.attempts + 1,
           last_seen = now()`,
    [serverId, name, uuid, ip],
  );
  // Bound the table: a public server can be scanned by many accounts.
  await query(
    `DELETE FROM whitelist_attempts WHERE server_id = $1 AND name_lower NOT IN
       (SELECT name_lower FROM whitelist_attempts WHERE server_id = $1 ORDER BY last_seen DESC LIMIT $2)`,
    [serverId, KEEP_PER_SERVER],
  );
}

export async function dismissAttempt(serverId: string, name: string): Promise<void> {
  await query('DELETE FROM whitelist_attempts WHERE server_id = $1 AND name_lower = lower($2)', [serverId, name]);
}

/** Attempts of players that are not on the whitelist (any more), newest first. */
export async function listAttempts(serverId: string): Promise<JoinAttempt[]> {
  const rows = await query<{
    name: string;
    uuid: string | null;
    ip: string | null;
    attempts: number;
    first_seen: Date;
    last_seen: Date;
  }>('SELECT name, uuid, ip, attempts, first_seen, last_seen FROM whitelist_attempts WHERE server_id = $1 ORDER BY last_seen DESC', [
    serverId,
  ]);
  // Players added to the whitelist by any means (this UI, the console, a file edit) no longer need approval.
  const wl = await readJson<Array<{ name?: string }>>(path.join(serverDir(serverId), 'whitelist.json'), []);
  const listed = new Set((Array.isArray(wl) ? wl : []).map((e) => (e.name ?? '').toLowerCase()));
  const pending = rows.filter((r) => !listed.has(r.name.toLowerCase()));
  const done = rows.filter((r) => listed.has(r.name.toLowerCase()));
  if (done.length) await Promise.all(done.map((r) => dismissAttempt(serverId, r.name)));
  return pending.map((r) => ({
    name: r.name,
    uuid: r.uuid,
    ip: r.ip,
    attempts: r.attempts,
    firstSeen: r.first_seen.toISOString(),
    lastSeen: r.last_seen.toISOString(),
  }));
}
