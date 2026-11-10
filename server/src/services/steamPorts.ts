import { tx } from '../db/pool.js';
import { mainPort, type GameDefinition } from '../lib/gameDefinition.js';
import { isSteamType } from '../lib/games.js';
import { parsePortPool } from '../lib/ports.js';
import { brokenPortGroups, portGroups, publishedPorts } from '../lib/steamPlan.js';
import { requireDefinition } from './gameDefinitions.js';
import { chooseGroupPorts, PORT_LOCK, usedHostPorts } from './portAlloc.js';
import { getPortPoolSpec } from './settings.js';
import type { ServerRow } from './types.js';

export interface PortRepair {
  /** New host ports by port id (main included). */
  ports: Record<string, number>;
  /** Groups whose base port was moved (only allowed while the server is stopped). */
  moved: string[];
  /** Groups that need moving but could not be moved because the server runs. */
  blocked: string[];
}

/**
 * Pure: bring a server's host ports in line with its definition. Allocations of ports the definition
 * still has are kept when they satisfy the offsets; an offset port that is missing or wrong is set to
 * `base + by` when that number is free; only otherwise the whole group (base included) is re-allocated,
 * and only when `running` is false.
 */
export function repairSteamPorts(
  def: Pick<GameDefinition, 'ports'>,
  current: Record<string, number | undefined>,
  pool: number[],
  usedByOthers: Set<number>,
  running: boolean,
): PortRepair {
  const published = new Set(publishedPorts(def).map((p) => p.id));
  const ports: Record<string, number> = {};
  for (const [k, v] of Object.entries(current)) if (published.has(k) && Number.isInteger(v)) ports[k] = v!;
  const inPool = new Set(pool);
  const groups = portGroups(def);
  const moved: string[] = [];
  const blocked: string[] = [];
  const broken = new Set(brokenPortGroups(def, ports));
  // Ports of the groups that are fine stay reserved.
  const taken = new Set(usedByOthers);
  for (const g of groups) {
    if (broken.has(g.id)) continue;
    taken.add(ports[g.id]!);
    for (const o of g.offsets) taken.add(ports[o.id]!);
  }
  for (const g of groups) {
    if (!broken.has(g.id)) continue;
    const base = ports[g.id];
    // 1) Keep the base and fix only the offset ports, when the right numbers are free.
    if (base !== undefined && !taken.has(base)) {
      const others = new Set(taken);
      others.add(base);
      const ok = g.offsets.every((o) => {
        const want = base + o.by;
        if (ports[o.id] === want) return !others.has(want) && (others.add(want), true);
        return inPool.has(want) && !others.has(want) && (others.add(want), true);
      });
      if (ok) {
        taken.add(base);
        for (const o of g.offsets) {
          ports[o.id] = base + o.by;
          taken.add(base + o.by);
        }
        continue;
      }
    }
    // 2) A whole new block. A group that had no host port at all is new and can always be allocated.
    if (base !== undefined && running) {
      blocked.push(g.id);
      continue;
    }
    const got = chooseGroupPorts(pool, taken, [g], 'no_free_ports');
    for (const [k, v] of Object.entries(got)) {
      ports[k] = v;
      taken.add(v);
    }
    if (base !== undefined) moved.push(g.id);
  }
  return { ports, moved, blocked };
}

/**
 * Make sure every published port of the definition has a host port that satisfies its offsets (a
 * definition may gain ports or offsets after the server was created) and drop allocations of ports
 * it no longer has. Returns the current row. `log` receives a line for every moved/blocked group.
 */
export async function ensureSteamPorts(
  server: ServerRow,
  opts: { running?: boolean; log?: (line: string) => void } = {},
): Promise<ServerRow> {
  if (!isSteamType(server.type) || !server.steam) return server;
  const def = requireDefinition(server.steam.gameId);
  const main = mainPort(def);
  const want = publishedPorts(def);
  const extra = server.extra_ports ?? {};
  const current: Record<string, number | undefined> = { ...extra, [main.id]: server.port };
  const stale = Object.keys(extra).filter((k) => k === main.id || !want.some((p) => p.id === k));
  const missing = want.some((p) => !Number.isInteger(current[p.id]));
  if (!missing && !stale.length && brokenPortGroups(def, current).length === 0) return server;
  return tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [PORT_LOCK]);
    const pool = parsePortPool(await getPortPoolSpec());
    const used = await usedHostPorts(client, server.id);
    const r = repairSteamPorts(def, current, pool, used, !!opts.running);
    for (const g of r.moved) opts.log?.(`[servcrafty] port "${g}" and its offset ports were re-allocated to match the game definition`);
    for (const g of r.blocked) opts.log?.(`[servcrafty] port "${g}" no longer matches the game definition's offsets; stop the server to re-allocate it`);
    const nextExtra: Record<string, number> = {};
    for (const p of want) if (p !== main && r.ports[p.id] !== undefined) nextExtra[p.id] = r.ports[p.id]!;
    const port = r.ports[main.id] ?? server.port;
    const row = await client.query<ServerRow>('UPDATE servers SET port = $2, extra_ports = $3 WHERE id = $1 RETURNING *', [
      server.id,
      port,
      JSON.stringify(nextExtra),
    ]);
    if (port !== server.port) opts.log?.(`[servcrafty] main port changed from ${server.port} to ${port}`);
    return row.rows[0]!;
  });
}
