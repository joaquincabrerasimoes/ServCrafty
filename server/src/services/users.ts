import { config } from '../config.js';
import { query, queryOne, type Queryable } from '../db/pool.js';
import { hashPassword } from '../auth/passwords.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { Quotas, Role, UserRow } from './types.js';

export async function getUser(id: string): Promise<UserRow> {
  const u = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  if (!u) throw notFound('User not found', 'user_not_found');
  return u;
}

export async function findUserByUsername(username: string): Promise<UserRow | null> {
  return queryOne<UserRow>('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
}

export async function createUser(input: {
  username: string;
  password: string;
  email?: string | null;
  role: Role;
  quotas?: Partial<Quotas>;
  locale?: string;
}): Promise<UserRow> {
  if (await findUserByUsername(input.username)) throw conflict('Username already exists', 'username_taken');
  const hash = await hashPassword(input.password);
  const q = input.quotas ?? {};
  const row = await queryOne<UserRow>(
    `INSERT INTO users (username, email, password_hash, role, locale, max_servers, max_ram_mb, max_cpu, max_disk_mb)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      input.username,
      input.email ?? null,
      hash,
      input.role,
      input.locale ?? 'en',
      q.maxServers ?? null,
      q.maxRamMb ?? null,
      q.maxCpu ?? null,
      q.maxDiskMb ?? null,
    ],
  );
  return row!;
}

/** Create the bootstrap admin from env when the users table is empty. */
export async function ensureAdmin(log: (m: string) => void): Promise<void> {
  const row = await queryOne<{ n: number }>('SELECT count(*)::int AS n FROM users');
  if ((row?.n ?? 0) > 0) return;
  const c = config();
  if (!c.adminPassword) {
    log('[bootstrap] no users exist and ADMIN_PASSWORD is not set; set it to create the admin account');
    return;
  }
  await createUser({
    username: c.adminUsername,
    password: c.adminPassword,
    email: c.adminEmail ?? null,
    role: 'admin',
  });
  log(`[bootstrap] created admin user "${c.adminUsername}"`);
}

export async function countAdmins(excludeId?: string): Promise<number> {
  const r = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND NOT disabled AND id <> $1`,
    [excludeId ?? '00000000-0000-0000-0000-000000000000'],
  );
  return r?.n ?? 0;
}

export interface QuotaUsage {
  servers: number;
  ram_mb: number;
  cpu: number;
  disk_mb: number;
}

export async function quotaUsage(userId: string, excludeServerId?: string, client?: Queryable): Promise<QuotaUsage> {
  const r = await queryOne<{ servers: number; ram: number; cpu: number; disk: number }>(
    `SELECT count(*)::int AS servers, coalesce(sum(memory_mb), 0)::int AS ram,
            coalesce(sum(cpu), 0)::float8 AS cpu, coalesce(sum(coalesce(disk_mb, 0)), 0)::int AS disk
     FROM servers WHERE owner_id = $1 AND id::text <> $2`,
    [userId, excludeServerId ?? ''],
    client,
  );
  return { servers: r?.servers ?? 0, ram_mb: r?.ram ?? 0, cpu: r?.cpu ?? 0, disk_mb: r?.disk ?? 0 };
}

/**
 * Enforce owner's quotas for a prospective server config. `excludeServerId` is the
 * server being updated (its current allocation is not counted).
 */
export async function assertQuota(
  owner: UserRow,
  want: { memoryMb: number; cpu: number; diskMb: number | null },
  excludeServerId?: string,
  client?: Queryable,
): Promise<void> {
  const usage = await quotaUsage(owner.id, excludeServerId, client);
  const fail = (what: string) => {
    throw badRequest(`Quota exceeded: ${what}`, 'quota_exceeded');
  };
  if (owner.max_servers != null && !excludeServerId && usage.servers + 1 > owner.max_servers)
    fail(`max ${owner.max_servers} servers`);
  if (owner.max_ram_mb != null && usage.ram_mb + want.memoryMb > owner.max_ram_mb)
    fail(`RAM ${usage.ram_mb + want.memoryMb} MB > ${owner.max_ram_mb} MB`);
  if (owner.max_cpu != null && usage.cpu + want.cpu > owner.max_cpu + 1e-9)
    fail(`CPU ${(usage.cpu + want.cpu).toFixed(2)} > ${owner.max_cpu} cores`);
  if (owner.max_disk_mb != null) {
    if (want.diskMb == null) fail('a disk limit is required because your account has a disk quota');
    else if (usage.disk_mb + want.diskMb > owner.max_disk_mb)
      fail(`disk ${usage.disk_mb + want.diskMb} MB > ${owner.max_disk_mb} MB`);
  }
}
