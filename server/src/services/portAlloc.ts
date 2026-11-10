import type pg from 'pg';
import { badRequest, conflict } from '../lib/errors.js';
import { parsePortPool } from '../lib/ports.js';
import { getPortPoolSpec } from './settings.js';

/** Advisory lock serializing every host-port allocation. */
export const PORT_LOCK = 727_002;

/**
 * Host ports taken by servers other than `excludeServerId`: each server's main `port` plus the
 * values of its `extra_ports` (SteamCMD servers publish several ports).
 */
export async function usedHostPorts(client: pg.PoolClient, excludeServerId?: string): Promise<Set<number>> {
  const r = await client.query<{ port: number }>(
    `SELECT port FROM servers WHERE id::text <> $1
     UNION ALL
     SELECT (e.value)::int AS port FROM servers s, jsonb_each_text(coalesce(s.extra_ports, '{}'::jsonb)) e
     WHERE s.id::text <> $1`,
    [excludeServerId ?? ''],
  );
  return new Set(r.rows.map((x) => Number(x.port)));
}

/** Pure: choose `count` free ports from `pool`, the first one being `wanted` when given. */
export function choosePorts(
  pool: number[],
  used: Set<number>,
  count: number,
  wanted: number | undefined,
  exhaustedCode: string,
): number[] {
  const out: number[] = [];
  const taken = new Set(used);
  if (wanted !== undefined) {
    if (!pool.includes(wanted)) throw badRequest(`Port ${wanted} is not in the port pool`, 'port_not_in_pool');
    if (taken.has(wanted)) throw conflict(`Port ${wanted} is already in use`, 'port_in_use');
    out.push(wanted);
    taken.add(wanted);
  }
  for (const p of pool) {
    if (out.length >= count) break;
    if (taken.has(p)) continue;
    out.push(p);
    taken.add(p);
  }
  if (out.length < count) {
    throw conflict(
      count > 1 ? `Not enough free ports left in the pool (this game needs ${count})` : 'No free ports left in the pool',
      exhaustedCode,
    );
  }
  return out;
}

/**
 * Allocate `count` host ports inside a transaction (takes the allocation lock). `reserved` are ports
 * the caller already holds for the same server and must not be handed out again.
 */
export async function allocatePorts(
  client: pg.PoolClient,
  opts: { count: number; wanted?: number; excludeServerId?: string; reserved?: number[]; exhaustedCode?: string },
): Promise<number[]> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [PORT_LOCK]);
  const pool = parsePortPool(await getPortPoolSpec());
  const used = await usedHostPorts(client, opts.excludeServerId);
  for (const p of opts.reserved ?? []) used.add(p);
  return choosePorts(pool, used, opts.count, opts.wanted, opts.exhaustedCode ?? 'port_pool_exhausted');
}

/** A published port and the ports declared as offsets of it (they get exactly base + by). */
export interface PortGroup {
  id: string;
  offsets: { id: string; by: number }[];
}

/**
 * Pure: host ports for groups of ports. Each group's base takes the first free pool port for which
 * every `base + by` is also in the pool and free; groups are placed in order (main first).
 */
export function chooseGroupPorts(pool: number[], used: Set<number>, groups: PortGroup[], exhaustedCode: string): Record<string, number> {
  const inPool = new Set(pool);
  const taken = new Set(used);
  const out: Record<string, number> = {};
  for (const g of groups) {
    const fits = (c: number) =>
      !taken.has(c) &&
      g.offsets.every((o) => inPool.has(c + o.by) && !taken.has(c + o.by)) &&
      new Set(g.offsets.map((o) => o.by)).size === g.offsets.length;
    const base = pool.find(fits);
    if (base === undefined) {
      throw conflict(
        g.offsets.length
          ? `No free block of ports left in the pool for "${g.id}" and its offset port(s)`
          : 'Not enough free ports left in the pool for this game',
        exhaustedCode,
      );
    }
    out[g.id] = base;
    taken.add(base);
    for (const o of g.offsets) {
      out[o.id] = base + o.by;
      taken.add(base + o.by);
    }
  }
  return out;
}

/** Allocate host ports for port groups inside a transaction (takes the allocation lock). */
export async function allocatePortGroups(
  client: pg.PoolClient,
  opts: { groups: PortGroup[]; excludeServerId?: string; reserved?: number[]; exhaustedCode?: string },
): Promise<Record<string, number>> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [PORT_LOCK]);
  const pool = parsePortPool(await getPortPoolSpec());
  const used = await usedHostPorts(client, opts.excludeServerId);
  for (const p of opts.reserved ?? []) used.add(p);
  return chooseGroupPorts(pool, used, opts.groups, opts.exhaustedCode ?? 'no_free_ports');
}
