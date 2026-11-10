import os from 'node:os';
import { query } from '../db/pool.js';
import { gameOf, serverGameKey } from '../lib/games.js';
import { createProcessMonitor, MAX_SERVERS, type MonitoredServer, type ProcessSnapshot } from '../lib/processTop.js';
import { docker, dockerAvailable } from './docker.js';
import * as runtime from './runtime.js';
import type { ServerRow } from './types.js';

/** Statuses with a live container worth listing. */
const LIVE = new Set(['running', 'starting', 'installing', 'stopping']);

async function listRunningServers(): Promise<MonitoredServer[]> {
  const rows = await query<Pick<ServerRow, 'id' | 'name' | 'type' | 'steam' | 'container_id' | 'cpu'>>(
    'SELECT id, name, type, steam, container_id, cpu FROM servers ORDER BY name',
  );
  const out: MonitoredServer[] = [];
  for (const r of rows) {
    const status = runtime.getStatus(r.id);
    if (!LIVE.has(status) || !r.container_id) continue;
    const d = runtime.dockerSample(r.id);
    out.push({
      serverId: r.id,
      name: r.name,
      game: gameOf(r.type),
      gameKey: serverGameKey(r),
      status,
      containerId: r.container_id,
      cpuLimit: Number(r.cpu),
      stats: d ? { cpuPercent: d.cpuPercent, memUsedMb: d.memUsedMb, memLimitMb: d.memLimitMb } : null,
    });
    if (out.length >= MAX_SERVERS) break;
  }
  return out;
}

const monitor = createProcessMonitor({
  listServers: listRunningServers,
  top: async (containerId, psArgs) => (await docker().getContainer(containerId).top({ ps_args: psArgs })) as { Titles?: string[]; Processes?: string[][] },
  dockerAvailable,
  host: () => ({ cpuCount: os.cpus().length, memTotalMb: Math.round(os.totalmem() / 1048576) }),
  now: () => Date.now(),
});

/** `GET /admin/processes` payload (cached ~1.5 s). */
export function processSnapshot(): Promise<ProcessSnapshot> {
  return monitor.snapshot();
}
