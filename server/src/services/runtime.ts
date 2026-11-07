import fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { query, queryOne } from '../db/pool.js';
import { badRequest, conflict, errorMessage, notFound, unavailable } from '../lib/errors.js';
import { dirSize } from '../lib/fsutil.js';
import { detectMcVersion } from '../lib/mcVersion.js';
import { parseProperties } from '../lib/properties.js';
import {
  containerName,
  createServerContainer,
  demuxBuffer,
  docker,
  execIn,
  LABEL_SERVER,
  rconAddress,
  serverDir,
} from './docker.js';
import { bus } from './events.js';
import { RconClient, stripFormatting } from './rcon.js';
import { getCurseforgeKey } from './settings.js';
import type { ServerRow, ServerStatus, Stats } from './types.js';

const LOG_BUFFER = 1000;
const CRASH_WINDOW_MS = 10 * 60_000;
const MAX_CRASH_RESTARTS = 3;

interface DockerSample {
  memUsedMb: number;
  memLimitMb: number;
  cpuPercent: number;
  at: number;
}

interface RuntimeState {
  id: string;
  status: ServerStatus;
  startedAt: number | null;
  logs: string[];
  partial: string;
  logStream: Readable | null;
  statsStream: Readable | null;
  docker: DockerSample | null;
  rcon: RconClient | null;
  rconFailedAt: number;
  players: Set<string>;
  maxPlayers: number;
  tps: number | null;
  mspt: { avg: number | null; p95: number | null };
  tickMode: 'tick' | 'paper' | 'none' | null;
  version: string | null;
  motd: string | null;
  diskMb: number;
  diskAt: number;
  diskExceededNotified: boolean;
  expectedStop: boolean;
  crashes: number[];
  watchers: number;
  lastRconPoll: number;
  opLock: Promise<unknown>;
}

const states = new Map<string, RuntimeState>();
/** Containers ServCrafty replaced or removed itself; their `die` events are not crashes. */
const retiredContainers = new Set<string>();
let log: FastifyBaseLogger | Console = console;

function state(id: string): RuntimeState {
  let s = states.get(id);
  if (!s) {
    s = {
      id,
      status: 'stopped',
      startedAt: null,
      logs: [],
      partial: '',
      logStream: null,
      statsStream: null,
      docker: null,
      rcon: null,
      rconFailedAt: 0,
      players: new Set(),
      maxPlayers: 0,
      tps: null,
      mspt: { avg: null, p95: null },
      tickMode: null,
      version: null,
      motd: null,
      diskMb: 0,
      diskAt: 0,
      diskExceededNotified: false,
      expectedStop: false,
      crashes: [],
      watchers: 0,
      lastRconPoll: 0,
      opLock: Promise.resolve(),
    };
    states.set(id, s);
  }
  return s;
}

async function loadServer(id: string): Promise<ServerRow> {
  const row = await queryOne<ServerRow>('SELECT * FROM servers WHERE id = $1', [id]);
  if (!row) throw notFound('Server not found', 'server_not_found');
  return row;
}

/** Serialize power operations per server. */
function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const s = state(id);
  const p = s.opLock.then(fn, fn);
  s.opLock = p.catch(() => undefined);
  return p;
}

/** Update in-memory + DB status and broadcast it. Returns false if unchanged. */
export async function setStatus(id: string, status: ServerStatus): Promise<boolean> {
  const s = state(id);
  if (s.status === status) return false;
  const prev = s.status;
  s.status = status;
  await query('UPDATE servers SET status = $2 WHERE id = $1', [id, status]).catch((err: unknown) =>
    log.error({ err }, 'status update failed'),
  );
  bus.emit('status', id, status);
  if (status === 'running' && prev !== 'running') bus.emit('notify', id, 'server.running', {});
  if (status === 'starting' && prev !== 'installing') bus.emit('notify', id, 'server.starting', {});
  return true;
}

export function getStatus(id: string): ServerStatus {
  return state(id).status;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

function pushLine(s: RuntimeState, rawLine: string): void {
  // eslint-disable-next-line no-control-regex
  const line = rawLine.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r$/, '');
  if (!line) return;
  s.logs.push(line);
  if (s.logs.length > LOG_BUFFER) s.logs.splice(0, s.logs.length - LOG_BUFFER);
  bus.emit('log', s.id, line);
  analyzeLine(s, line);
}

/** Append a ServCrafty-originated line to the server log. */
export function systemLog(id: string, line: string): void {
  pushLine(state(id), line);
}

function feed(s: RuntimeState, chunk: string): void {
  const data = s.partial + chunk;
  const lines = data.split('\n');
  s.partial = lines.pop() ?? '';
  for (const l of lines) pushLine(s, l);
}

const RE_DONE = /Done \([\d.,]+s\)!|Server started\.|\bServer started\b/;
const RE_JOIN = /: (\.?[A-Za-z0-9_]{1,16}) joined the game/;
const RE_LEFT = /: (\.?[A-Za-z0-9_]{1,16}) left the game/;
const RE_BEDROCK_JOIN = /Player connected: ([^,]+),/;
const RE_BEDROCK_LEFT = /Player disconnected: ([^,]+),/;

function analyzeLine(s: RuntimeState, line: string): void {
  if (s.status === 'starting' && /^\[(init|mc-image-helper)\]/.test(line)) void setStatus(s.id, 'installing');
  if (s.status === 'installing' && /Starting minecraft server|Loading libraries|Starting net\.minecraft|Environment:/i.test(line))
    void setStatus(s.id, 'starting');
  if ((s.status === 'starting' || s.status === 'installing') && RE_DONE.test(line)) void setStatus(s.id, 'running');
  if (/Stopping (the )?server|Stopping server/i.test(line) && s.status === 'running') {
    // An in-game/console "stop": treat as an expected shutdown.
    s.expectedStop = true;
    void setStatus(s.id, 'stopping');
  }
  if (!s.version) s.version = detectMcVersion(line);
  const j = RE_JOIN.exec(line) ?? RE_BEDROCK_JOIN.exec(line);
  if (j?.[1]) {
    s.players.add(j[1].trim());
    bus.emit('notify', s.id, 'player.join', { player: j[1].trim() });
    return;
  }
  const l = RE_LEFT.exec(line) ?? RE_BEDROCK_LEFT.exec(line);
  if (l?.[1]) {
    s.players.delete(l[1].trim());
    bus.emit('notify', s.id, 'player.leave', { player: l[1].trim() });
  }
}

async function attachLogs(s: RuntimeState, containerId: string, tty: boolean, sinceSec?: number): Promise<void> {
  s.logStream?.destroy();
  const c = docker().getContainer(containerId);
  const stream = (await c.logs({
    follow: true,
    stdout: true,
    stderr: true,
    since: sinceSec ?? 0,
  })) as unknown as Readable;
  s.logStream = stream;
  s.partial = '';
  if (tty) {
    stream.on('data', (d: Buffer) => feed(s, d.toString('utf8')));
  } else {
    const out = new PassThrough();
    out.on('data', (d: Buffer) => feed(s, d.toString('utf8')));
    docker().modem.demuxStream(stream, out, out);
    stream.on('end', () => out.end());
  }
  stream.on('error', () => undefined);
}

/** Last `tail` log lines (from memory, or docker logs of the last container run). */
export async function getLogs(server: ServerRow, tail: number): Promise<string[]> {
  const s = state(server.id);
  if (s.logs.length) return s.logs.slice(-tail);
  const id = server.container_id;
  if (!id) return [];
  try {
    const buf = (await docker().getContainer(id).logs({
      follow: false,
      stdout: true,
      stderr: true,
      tail,
    })) as unknown as Buffer;
    return demuxBuffer(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)))
      .split('\n')
      // eslint-disable-next-line no-control-regex
      .map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r$/, ''))
      .filter(Boolean)
      .slice(-tail);
  } catch {
    return [];
  }
}

export function backlog(id: string, n = 200): string[] {
  return state(id).logs.slice(-n);
}

// ---------------------------------------------------------------------------
// Docker stats
// ---------------------------------------------------------------------------

interface DockerStatsJson {
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
  cpu_stats?: { cpu_usage?: { total_usage?: number; percpu_usage?: number[] }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
}

function attachStats(s: RuntimeState, containerId: string, cpuLimit: number): void {
  s.statsStream?.destroy();
  void docker()
    .getContainer(containerId)
    .stats({ stream: true })
    .then((stream) => {
      const rs = stream as unknown as Readable;
      s.statsStream = rs;
      let buf = '';
      rs.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const j = JSON.parse(line) as DockerStatsJson;
            const mem = j.memory_stats ?? {};
            const cache = mem.stats?.inactive_file ?? mem.stats?.total_inactive_file ?? mem.stats?.cache ?? 0;
            const used = Math.max(0, (mem.usage ?? 0) - cache);
            const cpuDelta = (j.cpu_stats?.cpu_usage?.total_usage ?? 0) - (j.precpu_stats?.cpu_usage?.total_usage ?? 0);
            const sysDelta = (j.cpu_stats?.system_cpu_usage ?? 0) - (j.precpu_stats?.system_cpu_usage ?? 0);
            const cpus = j.cpu_stats?.online_cpus ?? j.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
            const rawPct = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
            s.docker = {
              memUsedMb: Math.round(used / 1048576),
              memLimitMb: Math.round((mem.limit ?? 0) / 1048576),
              // Percentage of the server's allotted CPU (100 = all allotted cores busy).
              cpuPercent: Math.round((rawPct / Math.max(cpuLimit, 0.01)) * 10) / 10,
              at: Date.now(),
            };
          } catch {
            /* partial or invalid frame */
          }
        }
      });
      rs.on('error', () => undefined);
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// RCON
// ---------------------------------------------------------------------------

async function rconFor(server: ServerRow): Promise<RconClient> {
  if (server.type === 'BEDROCK') throw badRequest('Bedrock servers have no RCON', 'rcon_unsupported');
  const s = state(server.id);
  if (s.rcon?.connected) return s.rcon;
  if (!server.container_id) throw conflict('Server is not running', 'not_running');
  const addr = await rconAddress(server.container_id);
  if (!addr) throw unavailable('Cannot determine container address for RCON', 'rcon_unavailable');
  s.rcon?.close();
  const client = new RconClient(addr.host, addr.port, server.rcon_password);
  s.rcon = client;
  await client.connect();
  return client;
}

/**
 * Send a console command. Java uses RCON; Bedrock uses itzg's `send-command`.
 * Returns command output (Bedrock output appears in the log stream instead).
 */
export async function sendCommand(serverId: string, command: string): Promise<string> {
  const server = await loadServer(serverId);
  const s = state(serverId);
  if (!['running', 'starting'].includes(s.status) || !server.container_id) {
    throw conflict('Server is not running', 'not_running');
  }
  const cmd = command.replace(/^\//, '').trim();
  if (!cmd) throw badRequest('Empty command');
  if (server.type === 'BEDROCK') {
    await execIn(server.container_id, ['send-command', ...cmd.split(/\s+/)]);
    pushLine(s, `> ${cmd}`);
    return '';
  }
  try {
    const rcon = await rconFor(server);
    const out = stripFormatting(await rcon.command(cmd));
    pushLine(s, `> ${cmd}`);
    for (const l of out.split('\n')) if (l.trim()) pushLine(s, `[rcon] ${l}`);
    return out;
  } catch (err) {
    s.rcon?.close();
    s.rcon = null;
    throw unavailable(`RCON error: ${errorMessage(err)}`, 'rcon_error');
  }
}

/** RCON command with no logging; returns null on failure. Used by pollers. */
async function quietRcon(server: ServerRow, cmd: string): Promise<string | null> {
  const s = state(server.id);
  if (Date.now() - s.rconFailedAt < 15_000 && !s.rcon?.connected) return null;
  try {
    const r = await rconFor(server);
    return stripFormatting(await r.command(cmd));
  } catch {
    s.rconFailedAt = Date.now();
    s.rcon?.close();
    s.rcon = null;
    return null;
  }
}

/** Run an RCON command only if the server is up; ignore errors. */
export async function tryRcon(serverId: string, cmd: string): Promise<string | null> {
  const s = state(serverId);
  if (s.status !== 'running') return null;
  const server = await loadServer(serverId);
  if (server.type === 'BEDROCK') return null;
  return quietRcon(server, cmd);
}

function parseList(out: string): { online: number; max: number; names: string[] } | null {
  const m = /There are (\d+) (?:of a max(?: of)? |\/)(\d+) players online:?\s*(.*)$/is.exec(out.trim());
  if (!m) return null;
  const names = (m[3] ?? '')
    .split(/[,\n]/)
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => n.replace(/^\[[^\]]*\]\s*/, ''));
  return { online: Number(m[1]), max: Number(m[2]), names };
}

function parseTickQuery(out: string): { avg: number; p95: number | null; target: number } | null {
  const avg = /Average time per tick:\s*([\d.]+)\s*ms/i.exec(out);
  if (!avg) return null;
  const p95 = /P95:\s*([\d.]+)\s*ms/i.exec(out);
  const target = /Target tick rate:\s*([\d.]+)/i.exec(out);
  return { avg: Number(avg[1]), p95: p95 ? Number(p95[1]) : null, target: target ? Number(target[1]) : 20 };
}

async function pollRcon(server: ServerRow, s: RuntimeState): Promise<void> {
  const list = await quietRcon(server, 'list');
  if (list === null) return;
  const parsed = parseList(list);
  if (parsed) {
    s.players = new Set(parsed.names);
    s.maxPlayers = parsed.max;
  }
  if (s.tickMode !== 'none' && s.tickMode !== 'paper') {
    const tq = await quietRcon(server, 'tick query');
    const t = tq ? parseTickQuery(tq) : null;
    if (t) {
      s.tickMode = 'tick';
      s.mspt = { avg: t.avg, p95: t.p95 };
      s.tps = Math.round(Math.min(t.target, 1000 / Math.max(t.avg, 0.001)) * 100) / 100;
      return;
    }
    if (tq !== null) s.tickMode = ['PAPER', 'PURPUR', 'FOLIA'].includes(server.type) ? 'paper' : 'none';
  }
  if (s.tickMode === 'paper') {
    const tps = await quietRcon(server, 'tps');
    const m = tps ? /:\s*\*?([\d.]+),/.exec(tps) : null;
    if (m) s.tps = Math.min(20, Number(m[1]));
    const mspt = await quietRcon(server, 'mspt');
    const mm = mspt ? /([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(mspt) : null;
    if (mm) s.mspt = { avg: Number(mm[1]), p95: null };
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async function refreshDisk(server: ServerRow, s: RuntimeState, force = false): Promise<void> {
  if (!force && Date.now() - s.diskAt < 30_000) return;
  s.diskAt = Date.now();
  s.diskMb = Math.round((await dirSize(serverDir(server.id))) / 1048576);
  if (server.disk_mb != null && s.diskMb > server.disk_mb) {
    if (!s.diskExceededNotified) {
      s.diskExceededNotified = true;
      systemLog(server.id, `[servcrafty] WARNING: disk usage ${s.diskMb} MB exceeds the ${server.disk_mb} MB limit`);
      bus.emit('notify', server.id, 'disk.exceeded', { usedMb: s.diskMb, limitMb: server.disk_mb });
    }
  } else s.diskExceededNotified = false;
}

export async function diskUsageMb(server: ServerRow, force = false): Promise<number> {
  const s = state(server.id);
  await refreshDisk(server, s, force);
  return s.diskMb;
}

async function readProps(serverId: string): Promise<Record<string, string>> {
  try {
    return parseProperties(await fsp.readFile(path.join(serverDir(serverId), 'server.properties'), 'utf8'));
  } catch {
    return {};
  }
}

export async function getStats(server: ServerRow): Promise<Stats> {
  const s = state(server.id);
  const running = s.status === 'running';
  if (running && server.type !== 'BEDROCK' && Date.now() - s.lastRconPoll > 4000) {
    s.lastRconPoll = Date.now();
    await pollRcon(server, s);
  }
  await refreshDisk(server, s).catch(() => undefined);
  const props = await readProps(server.id);
  if (!s.maxPlayers && props['max-players']) s.maxPlayers = Number(props['max-players']) || 0;
  s.motd = props.motd ?? props['server-name'] ?? s.motd;
  const alive = ['running', 'starting', 'installing', 'stopping'].includes(s.status);
  const dockerFresh = alive && s.docker && Date.now() - s.docker.at < 10_000 ? s.docker : null;
  const rconOk = running && !!s.rcon?.connected;
  return {
    status: s.status,
    uptimeSec: alive && s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0,
    memory: {
      usedMb: dockerFresh?.memUsedMb ?? 0,
      limitMb: dockerFresh?.memLimitMb || server.memory_mb,
    },
    cpuPercent: dockerFresh?.cpuPercent ?? 0,
    tps: rconOk ? s.tps : null,
    mspt: rconOk ? s.mspt : { avg: null, p95: null },
    players: {
      online: running ? s.players.size : 0,
      max: s.maxPlayers,
      list: running ? [...s.players].map((name) => ({ name })) : [],
    },
    motd: s.motd,
    version: s.version ?? (server.mc_version === 'LATEST' ? null : server.mc_version),
    packName: server.modpack?.name ?? null,
    packVersion: server.modpack?.versionName ?? null,
    source: rconOk ? 'rcon' : 'docker',
    diskMb: s.diskMb,
    agent: null,
  };
}

export function onlinePlayers(serverId: string): string[] {
  return [...state(serverId).players];
}

/** Increase/decrease the number of live stats subscribers for a server. */
export function watch(serverId: string, delta: 1 | -1): void {
  const s = state(serverId);
  s.watchers = Math.max(0, s.watchers + delta);
}

let ticker: NodeJS.Timeout | undefined;
function startTicker(): void {
  if (ticker) return;
  ticker = setInterval(() => {
    for (const s of states.values()) {
      if (s.watchers <= 0) continue;
      void loadServer(s.id)
        .then((srv) => getStats(srv))
        .then((stats) => bus.emit('stats', s.id, stats))
        .catch(() => undefined);
    }
  }, 2000);
  ticker.unref();
}

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

function resetRuntime(s: RuntimeState): void {
  s.logStream?.destroy();
  s.statsStream?.destroy();
  s.logStream = null;
  s.statsStream = null;
  s.rcon?.close();
  s.rcon = null;
  s.docker = null;
  s.players.clear();
  s.tps = null;
  s.mspt = { avg: null, p95: null };
  s.tickMode = null;
}

export function start(serverId: string): Promise<void> {
  return withLock(serverId, async () => {
    const server = await loadServer(serverId);
    const s = state(serverId);
    if (['running', 'starting', 'installing'].includes(s.status)) throw conflict('Server is already running', 'already_running');
    await fsp.mkdir(serverDir(serverId), { recursive: true });
    s.expectedStop = false;
    s.logs = [];
    s.version = null;
    await setStatus(serverId, 'starting');
    try {
      // The previous container (if still alive) is force-removed when the new one is created. Its
      // `die` event (exit 137) must not be mistaken for a crash that triggers an auto-restart.
      if (server.container_id) retiredContainers.add(server.container_id);
      const container = await createServerContainer(server, await getCurseforgeKey(), (l) => systemLog(serverId, l));
      await query('UPDATE servers SET container_id = $2 WHERE id = $1', [serverId, container.id]);
      await container.start();
      s.startedAt = Date.now();
      resetRuntime(s);
      await attachLogs(s, container.id, server.type === 'BEDROCK');
      attachStats(s, container.id, server.cpu);
      systemLog(serverId, `[servcrafty] container ${containerName(serverId)} started`);
    } catch (err) {
      systemLog(serverId, `[servcrafty] failed to start: ${errorMessage(err)}`);
      await setStatus(serverId, 'stopped');
      throw unavailable(`Failed to start server: ${errorMessage(err)}`, 'start_failed');
    }
  });
}

async function stopContainer(server: ServerRow, s: RuntimeState, kill: boolean): Promise<void> {
  if (!server.container_id) {
    await setStatus(server.id, 'stopped');
    return;
  }
  s.expectedStop = true;
  const c = docker().getContainer(server.container_id);
  let running = false;
  try {
    running = (await c.inspect()).State.Running;
  } catch {
    running = false;
  }
  if (!running) {
    resetRuntime(s);
    await setStatus(server.id, 'stopped');
    return;
  }
  await setStatus(server.id, 'stopping');
  try {
    if (kill) await c.kill();
    else await c.stop({ t: 90 }); // itzg forwards SIGTERM to a graceful "stop"
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 304) throw err; // 304 = already stopped
  }
  await c.wait({ condition: 'not-running' }).catch(() => undefined);
  resetRuntime(s);
  if (await setStatus(server.id, 'stopped')) bus.emit('notify', server.id, 'server.stopped', { reason: kill ? 'kill' : 'stop' });
}

export function stop(serverId: string, kill = false): Promise<void> {
  return withLock(serverId, async () => {
    const server = await loadServer(serverId);
    await stopContainer(server, state(serverId), kill);
  });
}

export async function restart(serverId: string): Promise<void> {
  await stop(serverId);
  await start(serverId);
}

export async function power(serverId: string, action: 'start' | 'stop' | 'restart' | 'kill'): Promise<void> {
  switch (action) {
    case 'start':
      return start(serverId);
    case 'stop':
      return stop(serverId);
    case 'kill':
      return stop(serverId, true);
    case 'restart':
      return restart(serverId);
  }
}

export function isRunning(serverId: string): boolean {
  return ['running', 'starting', 'installing', 'stopping'].includes(state(serverId).status);
}

/** Stop (if needed) and remove the container and runtime state of a server. */
export async function destroy(server: ServerRow): Promise<void> {
  const s = state(server.id);
  s.expectedStop = true;
  resetRuntime(s);
  for (const id of [server.container_id, containerName(server.id)]) {
    if (!id) continue;
    try {
      await docker().getContainer(id).remove({ force: true, v: true });
    } catch {
      /* already gone */
    }
  }
  states.delete(server.id);
}

// ---------------------------------------------------------------------------
// Crash detection / docker events
// ---------------------------------------------------------------------------

async function onContainerDie(serverId: string, containerId: string | undefined, exitCode: number, oom: boolean): Promise<void> {
  const s = state(serverId);
  if (containerId && retiredContainers.delete(containerId)) return;
  const server = await queryOne<ServerRow>('SELECT * FROM servers WHERE id = $1', [serverId]);
  if (!server) return;
  // Ignore late events from a previous container (the server was recreated since).
  if (containerId && server.container_id && containerId !== server.container_id) return;
  // Flush any trailing partial line.
  if (s.partial) {
    pushLine(s, s.partial);
    s.partial = '';
  }
  const expected = s.expectedStop || exitCode === 0 || exitCode === 143;
  resetRuntime(s);
  if (expected) {
    s.expectedStop = false;
    if (await setStatus(serverId, 'stopped')) bus.emit('notify', serverId, 'server.stopped', { exitCode });
    return;
  }
  const phase = s.status === 'installing' || s.status === 'starting' ? s.status : 'running';
  systemLog(
    serverId,
    `[servcrafty] server exited unexpectedly (code ${exitCode}${oom ? ', out of memory - raise the memory limit' : ''}${phase !== 'running' ? `, during ${phase}` : ''})`,
  );
  const lastLines = s.logs.slice(-15);
  log.warn({ serverId, exitCode, oom, phase, lastLines }, 'server container exited unexpectedly');
  await setStatus(serverId, 'crashed');
  bus.emit('notify', serverId, 'server.crashed', { exitCode, oom });
  if (!server.auto_restart) return;
  const now = Date.now();
  s.crashes = s.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
  s.crashes.push(now);
  if (s.crashes.length > MAX_CRASH_RESTARTS) {
    systemLog(serverId, `[servcrafty] auto-restart disabled: ${s.crashes.length} crashes in 10 minutes`);
    return;
  }
  const delay = 5000 * s.crashes.length;
  systemLog(serverId, `[servcrafty] auto-restarting in ${delay / 1000}s`);
  setTimeout(() => {
    if (state(serverId).status !== 'crashed') return;
    start(serverId)
      .then(() => bus.emit('notify', serverId, 'server.restarted', { reason: 'crash' }))
      .catch((err: unknown) => log.error({ err, serverId }, 'auto-restart failed'));
  }, delay).unref();
}

let eventsStream: Readable | null = null;
const oomSeen = new Set<string>();

async function watchDockerEvents(): Promise<void> {
  try {
    const stream = (await docker().getEvents({
      filters: JSON.stringify({ type: ['container'], event: ['die', 'oom'], label: [LABEL_SERVER] }),
    })) as unknown as Readable;
    eventsStream = stream;
    let buf = '';
    stream.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as { Action?: string; Actor?: { ID?: string; Attributes?: Record<string, string> } };
          const sid = evt.Actor?.Attributes?.[LABEL_SERVER];
          if (!sid) continue;
          if (evt.Action === 'oom') oomSeen.add(sid);
          if (evt.Action === 'die') {
            const code = Number(evt.Actor?.Attributes?.exitCode ?? 0);
            const oom = oomSeen.delete(sid);
            void onContainerDie(sid, evt.Actor?.ID, code, oom).catch((err: unknown) => log.error({ err }, 'die handler failed'));
          }
        } catch {
          /* ignore */
        }
      }
    });
    const reconnect = () => {
      eventsStream = null;
      setTimeout(() => void watchDockerEvents(), 5000).unref();
    };
    stream.on('end', reconnect);
    stream.on('error', reconnect);
  } catch (err) {
    log.warn({ err: errorMessage(err) }, 'docker events unavailable; retrying in 10s');
    setTimeout(() => void watchDockerEvents(), 10_000).unref();
  }
}

/**
 * Boot-time reconciliation: sync DB status with actual containers and re-attach
 * log/stats streams for containers still running.
 */
export async function initRuntime(logger: FastifyBaseLogger): Promise<void> {
  log = logger;
  startTicker();
  const servers = await query<ServerRow>('SELECT * FROM servers');
  let dockerOk = true;
  try {
    await docker().ping();
  } catch {
    dockerOk = false;
    logger.warn('Docker daemon not reachable; servers will be shown as stopped until it is available');
  }
  for (const server of servers) {
    const s = state(server.id);
    s.status = server.status;
    if (!dockerOk) {
      if (server.status !== 'stopped') await setStatus(server.id, 'stopped');
      continue;
    }
    try {
      const info = server.container_id ? await docker().getContainer(server.container_id).inspect() : null;
      if (info?.State.Running) {
        s.startedAt = new Date(info.State.StartedAt).getTime();
        // Prefill the backlog without re-analyzing old lines, then follow new output only.
        s.logs = [];
        s.logs = await getLogs(server, 500);
        await attachLogs(s, info.Id, server.type === 'BEDROCK', Math.floor(Date.now() / 1000));
        attachStats(s, info.Id, server.cpu);
        // Assume running if it has been up for a while; log analysis will confirm otherwise.
        s.status = 'starting';
        await setStatus(server.id, Date.now() - s.startedAt > 60_000 ? 'running' : 'starting');
      } else if (server.status !== 'stopped' && server.status !== 'crashed') {
        await setStatus(server.id, 'stopped');
      }
    } catch {
      if (server.status !== 'stopped') await setStatus(server.id, 'stopped');
    }
  }
  if (dockerOk) void watchDockerEvents();
  else setTimeout(() => void watchDockerEvents(), 10_000).unref();
}

export async function shutdownRuntime(): Promise<void> {
  eventsStream?.destroy();
  if (ticker) clearInterval(ticker);
  for (const s of states.values()) {
    s.logStream?.destroy();
    s.statsStream?.destroy();
    s.rcon?.close();
  }
}
