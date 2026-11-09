import { queryOne, type Queryable } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { getSetting, setSetting, SettingKeys } from './settings.js';

/** Host-wide caps shared by every user's servers combined. null = no cap. */
export interface GlobalLimits {
  maxServers: number | null;
  maxRamMb: number | null;
  maxCpu: number | null;
  maxDiskMb: number | null;
}

export interface HostUsage {
  servers: number;
  ram_mb: number;
  cpu: number;
  disk_mb: number;
}

const NONE: GlobalLimits = { maxServers: null, maxRamMb: null, maxCpu: null, maxDiskMb: null };

export async function getGlobalLimits(): Promise<GlobalLimits> {
  const v = await getSetting<Partial<GlobalLimits>>(SettingKeys.globalLimits);
  return { ...NONE, ...(v ?? {}) };
}

export async function setGlobalLimits(limits: Partial<GlobalLimits>): Promise<GlobalLimits> {
  const merged = { ...(await getGlobalLimits()), ...limits };
  await setSetting(SettingKeys.globalLimits, merged);
  return merged;
}

export async function hostUsage(excludeServerId?: string, client?: Queryable): Promise<HostUsage> {
  const r = await queryOne<{ servers: number; ram: number; cpu: number; disk: number }>(
    `SELECT count(*)::int AS servers, coalesce(sum(memory_mb), 0)::int AS ram,
            coalesce(sum(cpu), 0)::float8 AS cpu, coalesce(sum(coalesce(disk_mb, 0)), 0)::int AS disk
     FROM servers WHERE id::text <> $1`,
    [excludeServerId ?? ''],
    client,
  );
  return { servers: r?.servers ?? 0, ram_mb: r?.ram ?? 0, cpu: r?.cpu ?? 0, disk_mb: r?.disk ?? 0 };
}

/**
 * Enforce the host-wide caps for everyone, admins included. `current` is the server's present allocation
 * when it is being edited: a resource is only checked when the edit increases it, so lowering a cap
 * never blocks an unrelated change or a shrink.
 */
export async function assertHostCap(
  want: { memoryMb: number; cpu: number; diskMb: number | null },
  opts: { excludeServerId?: string; current?: { memoryMb: number; cpu: number; diskMb: number | null }; client?: Queryable } = {},
): Promise<void> {
  const caps = await getGlobalLimits();
  if (Object.values(caps).every((v) => v == null)) return;
  // Serialize concurrent creations so two requests cannot both squeeze under the cap.
  if (opts.client) await opts.client.query(`SELECT pg_advisory_xact_lock(hashtext('servcrafty-host-cap'))`);
  const used = await hostUsage(opts.excludeServerId, opts.client);
  const cur = opts.current;
  const fail = (what: string) => {
    throw badRequest(`Host capacity exceeded: ${what}`, 'host_capacity_exceeded');
  };
  if (caps.maxServers != null && !cur && used.servers + 1 > caps.maxServers) fail(`the host allows at most ${caps.maxServers} servers`);
  if (caps.maxRamMb != null && (!cur || want.memoryMb > cur.memoryMb) && used.ram_mb + want.memoryMb > caps.maxRamMb)
    fail(`RAM ${used.ram_mb + want.memoryMb} MB > ${caps.maxRamMb} MB`);
  if (caps.maxCpu != null && (!cur || want.cpu > cur.cpu) && used.cpu + want.cpu > caps.maxCpu + 1e-9)
    fail(`CPU ${(used.cpu + want.cpu).toFixed(2)} > ${caps.maxCpu} cores`);
  if (caps.maxDiskMb != null && (!cur || (want.diskMb !== cur.diskMb && (want.diskMb == null || cur.diskMb == null || want.diskMb > cur.diskMb)))) {
    if (want.diskMb == null) fail('a disk limit is required because the host has a disk cap');
    else if (used.disk_mb + want.diskMb > caps.maxDiskMb) fail(`disk ${used.disk_mb + want.diskMb} MB > ${caps.maxDiskMb} MB`);
  }
}
