import fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { query, queryOne } from '../db/pool.js';
import { badRequest, conflict, errorMessage, notFound, unavailable } from '../lib/errors.js';
import { dirSize } from '../lib/fsutil.js';
import { queryA2s, type A2sInfo, type A2sPlayer } from '../lib/a2s.js';
import { gameOf, isSteamType, terrariaVariant, type Game } from '../lib/games.js';
import type { GameDefinition } from '../lib/gameDefinition.js';
import {
  cleanSteamLine,
  INSTALL_PHASES,
  matchPlayer,
  MAX_MATCH_LEN,
  parseSteamLine,
  replaySteamLog,
  steamMatchers,
  type SteamMatchers,
  type SteamPhase,
} from '../lib/steamLog.js';
import { fillGeneratedVars, resolvePorts } from '../lib/steamPlan.js';
import { parseRejectedJoin, parseUuidLine } from '../lib/joinAttempts.js';
import { detectMcVersion } from '../lib/mcVersion.js';
import { parseProperties } from '../lib/properties.js';
import { cleanTerrariaLine, parseTerrariaLine } from '../lib/terrariaLog.js';
import {
  containerIp,
  containerName,
  createServerContainer,
  demuxBuffer,
  docker,
  execIn,
  LABEL_SERVER,
  rconAddress,
  serverDir,
} from './docker.js';
import { prepareBluemap, watchBluemapMaps } from './bluemap.js';
import { bus } from './events.js';
import { getDefinition } from './gameDefinitions.js';
import { assertServerCanStart } from './gameAccess.js';
import { ensureSteamPorts } from './steamPorts.js';
import { recordAttempt } from './joinAttempts.js';
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

/** Runtime state of a SteamCMD server (install progress, matchers, A2S cache). */
interface SteamRuntime {
  phase: SteamPhase | null;
  progress: number | null;
  error: string | null;
  matchers: SteamMatchers;
  /** No ready regex: running 20 s after phase=launch. */
  readyTimer: NodeJS.Timeout | null;
  a2sPort: number | null;
  a2sIp: string | null;
  a2sBusy: boolean;
  a2sAt: number;
  a2sInfo: A2sInfo | null;
  a2sPlayers: A2sPlayer[] | null;
}

const STEAM_READY_FALLBACK_MS = 20_000;

interface RuntimeState {
  id: string;
  /** Game of the server (decides how lines are cleaned/analysed). */
  game: Game;
  status: ServerStatus;
  startedAt: number | null;
  logs: string[];
  partial: string;
  logStream: Readable | null;
  statsStream: Readable | null;
  /** Attached stdin of a Terraria/TShock container (console commands are written to it). */
  stdin: NodeJS.ReadWriteStream | null;
  docker: DockerSample | null;
  rcon: RconClient | null;
  rconFailedAt: number;
  players: Set<string>;
  /** UUIDs announced by "UUID of player X is …" lines, used when that player is then refused. */
  seenUuids: Map<string, string>;
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
  /** SteamCMD servers only. */
  steam: SteamRuntime | null;
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
      game: 'minecraft',
      status: 'stopped',
      startedAt: null,
      logs: [],
      partial: '',
      logStream: null,
      statsStream: null,
      stdin: null,
      docker: null,
      rcon: null,
      rconFailedAt: 0,
      players: new Set(),
      seenUuids: new Map(),
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
      steam: null,
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

/** True when the server's container output is a raw TTY stream (no docker frame headers). */
function ttyFor(server: ServerRow): boolean {
  if (isSteamType(server.type)) return !!steamDef(server)?.console.stdin;
  return server.type === 'BEDROCK' || !!terrariaVariant(server.type)?.tty;
}

function steamDef(server: ServerRow): GameDefinition | null {
  return getDefinition(server.steam?.gameId);
}

/** Games whose output redraws progress lines with a bare carriage return. */
function splitsCarriageReturns(game: Game): boolean {
  return game === 'terraria' || game === 'steam';
}

function cleanLine(game: Game, rawLine: string): string {
  if (game === 'steam') return cleanSteamLine(rawLine);
  // eslint-disable-next-line no-control-regex
  if (game !== 'terraria') return rawLine.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r$/, '');
  return cleanTerrariaLine(rawLine);
}

function pushLine(s: RuntimeState, rawLine: string): void {
  const line = cleanLine(s.game, rawLine);
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
  // Terraria and SteamCMD redraw progress lines with a bare carriage return.
  const data = s.partial + (splitsCarriageReturns(s.game) ? chunk.replace(/\r(?!\n)/g, '\n') : chunk);
  const lines = data.split('\n');
  s.partial = lines.pop() ?? '';
  for (const l of lines) pushLine(s, l);
}

const RE_DONE = /Done \([\d.,]+s\)!|Server started\.|\bServer started\b/;
const RE_JOIN = /: (\.?[A-Za-z0-9_]{1,16}) joined the game/;
const RE_LEFT = /: (\.?[A-Za-z0-9_]{1,16}) left the game/;
const RE_BEDROCK_JOIN = /Player connected: ([^,]+),/;
const RE_BEDROCK_LEFT = /Player disconnected: ([^,]+),/;

function analyzeTerrariaLine(s: RuntimeState, line: string): void {
  const e = parseTerrariaLine(line);
  if (!e) return;
  switch (e.kind) {
    case 'ready':
      if (s.status === 'starting' || s.status === 'installing') void setStatus(s.id, 'running');
      return;
    case 'version':
      s.version ??= e.version;
      return;
    case 'join':
      if (s.players.size < 1000) s.players.add(e.player);
      bus.emit('notify', s.id, 'player.join', { player: e.player });
      return;
    case 'leave':
      s.players.delete(e.player);
      bus.emit('notify', s.id, 'player.leave', { player: e.player });
      return;
  }
}

function clearReadyTimer(st: SteamRuntime | null): void {
  if (st?.readyTimer) clearTimeout(st.readyTimer);
  if (st) st.readyTimer = null;
}

/** Executor markers drive the status: installing -> starting (launch) -> running (ready regex / 20 s). */
function analyzeSteamLine(s: RuntimeState, line: string): void {
  const st = s.steam;
  if (!st) return;
  const e = parseSteamLine(line);
  if (e?.kind === 'phase') {
    st.phase = e.phase;
    st.progress = null;
    if ((INSTALL_PHASES as readonly string[]).includes(e.phase)) {
      clearReadyTimer(st);
      if (s.status === 'starting' || s.status === 'installing' || s.status === 'running') void setStatus(s.id, 'installing');
      return;
    }
    // phase=launch
    st.error = null;
    if (s.status === 'installing' || s.status === 'starting') void setStatus(s.id, 'starting');
    clearReadyTimer(st);
    if (!st.matchers.ready) {
      st.readyTimer = setTimeout(() => {
        st.readyTimer = null;
        if (s.status === 'starting') void setStatus(s.id, 'running');
      }, STEAM_READY_FALLBACK_MS);
      st.readyTimer.unref();
    }
    return;
  }
  if (e?.kind === 'progress') {
    st.progress = e.progress;
    return;
  }
  if (e?.kind === 'error') {
    st.error = e.message;
    return;
  }
  if (st.phase !== 'launch' && st.phase !== null) return;
  if ((s.status === 'starting' || s.status === 'installing') && st.matchers.ready?.test(line.slice(0, MAX_MATCH_LEN))) {
    clearReadyTimer(st);
    void setStatus(s.id, 'running');
  }
  const joined = matchPlayer(st.matchers.join, line);
  if (joined) {
    if (s.players.size < 1000) s.players.add(joined);
    bus.emit('notify', s.id, 'player.join', { player: joined });
    return;
  }
  const left = matchPlayer(st.matchers.leave, line);
  if (left) {
    s.players.delete(left);
    bus.emit('notify', s.id, 'player.leave', { player: left });
  }
}

function newSteamRuntime(server: ServerRow): SteamRuntime {
  const def = steamDef(server);
  let a2sPort: number | null = null;
  if (def?.query?.a2s) {
    try {
      const ports = resolvePorts(def, server.port, server.extra_ports ?? {});
      a2sPort = ports.find((p) => p.id === def.query?.a2s?.portId)?.containerPort ?? null;
    } catch {
      a2sPort = null;
    }
  }
  return {
    phase: null,
    progress: null,
    error: null,
    matchers: steamMatchers(def),
    readyTimer: null,
    a2sPort,
    a2sIp: null,
    a2sBusy: false,
    a2sAt: 0,
    a2sInfo: null,
    a2sPlayers: null,
  };
}

function analyzeLine(s: RuntimeState, line: string): void {
  if (s.game === 'terraria') return analyzeTerrariaLine(s, line);
  if (s.game === 'steam') return analyzeSteamLine(s, line);
  if (s.status === 'starting' && /^\[(init|mc-image-helper)\]/.test(line)) void setStatus(s.id, 'installing');
  if (s.status === 'installing' && /Starting minecraft server|Loading libraries|Starting net\.minecraft|Environment:/i.test(line))
    void setStatus(s.id, 'starting');
  if ((s.status === 'starting' || s.status === 'installing') && RE_DONE.test(line)) void setStatus(s.id, 'running');
  if (/Stopping (the )?server|Stopping server/i.test(line) && s.status === 'running') {
    // An in-game/console "stop": treat as an expected shutdown.
    s.expectedStop = true;
    void query('UPDATE servers SET stopped_by_user=true WHERE id=$1', [s.id]).catch(() => undefined);
    void setStatus(s.id, 'stopping');
  }
  if (!s.version) s.version = detectMcVersion(line);
  const u = parseUuidLine(line);
  if (u) {
    if (s.seenUuids.size >= 50) s.seenUuids.clear();
    s.seenUuids.set(u.name.toLowerCase(), u.uuid);
  }
  const rejected = parseRejectedJoin(line);
  if (rejected) {
    void recordAttempt(s.id, rejected.name, rejected.ip, s.seenUuids.get(rejected.name.toLowerCase()) ?? null).catch((err: unknown) =>
      log.warn({ err: errorMessage(err), serverId: s.id }, 'could not record a refused join'),
    );
    return;
  }
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
    const game = gameOf(server.type);
    const text = demuxBuffer(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)));
    return (splitsCarriageReturns(game) ? text.replace(/\r(?!\n)/g, '\n') : text)
      .split('\n')
      .map((l) => cleanLine(game, l))
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
  if (gameOf(server.type) === 'terraria' || gameOf(server.type) === 'steam') {
    await consoleWrite(server, s, cmd);
    pushLine(s, `> ${cmd}`);
    return '';
  }
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

// ---------------------------------------------------------------------------
// Console for Terraria / SteamCMD games (attached stdin, or tModLoader's `inject`)
// ---------------------------------------------------------------------------

/** Attach to the container's stdin and keep the stream for console commands. */
async function attachStdin(s: RuntimeState, containerId: string): Promise<NodeJS.ReadWriteStream> {
  s.stdin?.end();
  s.stdin = null;
  const stream = await docker()
    .getContainer(containerId)
    .attach({ stream: true, stdin: true, stdout: false, stderr: false, hijack: true });
  s.stdin = stream;
  const drop = () => {
    if (s.stdin === stream) s.stdin = null;
  };
  stream.on('error', drop);
  stream.on('end', drop);
  stream.on('close', drop);
  return stream;
}

/** How console lines reach a non-RCON server: attached stdin, `inject` (tModLoader) or not at all. */
function consoleKindOf(server: ServerRow): 'stdin' | 'inject' | null {
  if (isSteamType(server.type)) return steamDef(server)?.console.stdin ? 'stdin' : null;
  return terrariaVariant(server.type)?.console ?? null;
}

/**
 * Send one console line to a Terraria or SteamCMD server. Control characters are refused so a
 * command can never smuggle a second line (stdin) or confuse `inject`.
 */
async function consoleWrite(server: ServerRow, s: RuntimeState, cmd: string): Promise<void> {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(cmd)) throw badRequest('Commands must be a single line', 'invalid_command');
  const kind = consoleKindOf(server);
  if (!kind) throw badRequest('This game has no console input', 'console_unsupported');
  if (!server.container_id) throw conflict('Server is not running', 'not_running');
  try {
    if (kind === 'inject') {
      await execIn(server.container_id, ['inject', cmd]);
      return;
    }
    const stdin = s.stdin ?? (await attachStdin(s, server.container_id));
    await new Promise<void>((resolve, reject) => stdin.write(`${cmd}\n`, (err) => (err ? reject(err) : resolve())));
  } catch (err) {
    s.stdin = null;
    throw unavailable(`Console error: ${errorMessage(err)}`, 'console_error');
  }
}

/** Quietly send a console command to a running Terraria server; false on failure. */
async function quietTerrariaCommand(server: ServerRow, cmd: string): Promise<boolean> {
  const s = state(server.id);
  if (s.status !== 'running' || !server.container_id) return false;
  try {
    await consoleWrite(server, s, cmd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask a running server to flush its world to disk before files are copied (backups, clone).
 * Terraria: `save` on the console. Minecraft: nothing here (callers keep their RCON flow).
 * Returns true when a save was requested.
 */
export async function saveWorld(serverId: string, waitMs = 3000): Promise<boolean> {
  if (state(serverId).status !== 'running') return false;
  const server = await loadServer(serverId);
  const v = terrariaVariant(server.type);
  if (!v) return false;
  const ok = await quietTerrariaCommand(server, v.saveCommand);
  if (ok) {
    systemLog(serverId, '[servcrafty] saving the world');
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return ok;
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
  // SteamCMD games have no RCON and no generic broadcast command.
  if (gameOf(server.type) === 'steam') return null;
  // Terraria has no RCON: run the command on the console (used for `say` warnings).
  if (gameOf(server.type) === 'terraria') return (await quietTerrariaCommand(server, cmd)) ? '' : null;
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

function terrariaStats(server: ServerRow, s: RuntimeState): Stats {
  const running = s.status === 'running';
  const alive = ['running', 'starting', 'installing', 'stopping'].includes(s.status);
  const dockerFresh = alive && s.docker && Date.now() - s.docker.at < 10_000 ? s.docker : null;
  return {
    status: s.status,
    uptimeSec: alive && s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0,
    memory: { usedMb: dockerFresh?.memUsedMb ?? 0, limitMb: dockerFresh?.memLimitMb || server.memory_mb },
    cpuPercent: dockerFresh?.cpuPercent ?? 0,
    tps: null,
    mspt: { avg: null, p95: null },
    players: {
      online: running ? s.players.size : 0,
      max: server.terraria?.maxPlayers ?? 8,
      list: running ? [...s.players].map((name) => ({ name })) : [],
    },
    motd: server.terraria?.motd ?? null,
    version: s.version,
    packName: null,
    packVersion: null,
    source: 'docker',
    diskMb: s.diskMb,
    agent: null,
  };
}

const A2S_INTERVAL_MS = 5000;
const A2S_FRESH_MS = 20_000;

/** Refresh the A2S cache in the background (stats never wait on the network). */
function pollA2s(server: ServerRow, st: SteamRuntime): void {
  if (st.a2sBusy || st.a2sPort === null || !server.container_id) return;
  if (Date.now() - st.a2sAt < A2S_INTERVAL_MS) return;
  st.a2sBusy = true;
  const containerId = server.container_id;
  void (async () => {
    try {
      st.a2sIp ??= await containerIp(containerId);
      if (!st.a2sIp) return;
      const r = await queryA2s(st.a2sIp, st.a2sPort!, { timeoutMs: 1500 });
      if (r.info) {
        st.a2sInfo = r.info;
        st.a2sPlayers = r.players;
        st.a2sAt = Date.now();
      } else {
        // Keep the old sample until it goes stale; retry later (the IP may have changed).
        st.a2sIp = null;
        st.a2sAt = Date.now() - A2S_INTERVAL_MS / 2;
      }
    } catch {
      st.a2sIp = null;
    } finally {
      st.a2sBusy = false;
    }
  })();
}

/** Max players of a SteamCMD server when A2S does not tell: a `maxPlayers`-like variable. */
function steamMaxPlayersVar(server: ServerRow): number {
  for (const [k, v] of Object.entries(server.steam?.vars ?? {})) {
    if (/^max_?players$/i.test(k)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return Math.trunc(n);
    }
  }
  return 0;
}

function steamStats(server: ServerRow, s: RuntimeState): Stats {
  const st = s.steam ?? (s.steam = newSteamRuntime(server));
  const running = s.status === 'running';
  const alive = ['running', 'starting', 'installing', 'stopping'].includes(s.status);
  const dockerFresh = alive && s.docker && Date.now() - s.docker.at < 10_000 ? s.docker : null;
  if (running) pollA2s(server, st);
  const a2s = running && st.a2sInfo && Date.now() - st.a2sAt < A2S_FRESH_MS ? st.a2sInfo : null;
  let players: Stats['players'];
  if (a2s) {
    const names = (st.a2sPlayers ?? []).map((p) => p.name).filter(Boolean);
    players = { online: Math.max(0, a2s.players - a2s.bots), max: a2s.maxPlayers, list: names.map((name) => ({ name })) };
  } else {
    players = {
      online: running ? s.players.size : 0,
      max: steamMaxPlayersVar(server),
      list: running ? [...s.players].map((name) => ({ name })) : [],
    };
  }
  return {
    status: s.status,
    uptimeSec: alive && s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0,
    memory: { usedMb: dockerFresh?.memUsedMb ?? 0, limitMb: dockerFresh?.memLimitMb || server.memory_mb },
    cpuPercent: dockerFresh?.cpuPercent ?? 0,
    tps: null,
    mspt: { avg: null, p95: null },
    players,
    motd: a2s?.name ?? null,
    map: a2s?.map || null,
    version: a2s?.version ?? null,
    packName: null,
    packVersion: null,
    source: a2s ? 'a2s' : 'docker',
    diskMb: s.diskMb,
    install: s.status === 'installing' ? { phase: st.phase ?? 'install', progress: st.progress } : null,
    agent: null,
  };
}

export async function getStats(server: ServerRow): Promise<Stats> {
  const s = state(server.id);
  if (gameOf(server.type) === 'terraria') {
    await refreshDisk(server, s).catch(() => undefined);
    return terrariaStats(server, s);
  }
  if (gameOf(server.type) === 'steam') {
    await refreshDisk(server, s).catch(() => undefined);
    return steamStats(server, s);
  }
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

/**
 * The container totals the runtime already has from its docker stats stream (no extra docker call), or
 * null when there is no fresh sample. `cpuPercent` is relative to the server's CPU allotment, as in Stats.
 */
export function dockerSample(serverId: string): { memUsedMb: number; memLimitMb: number; cpuPercent: number; at: number } | null {
  const d = states.get(serverId)?.docker;
  return d && Date.now() - d.at < 10_000 ? { ...d } : null;
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
  s.stdin?.end();
  s.stdin = null;
  s.rcon?.close();
  s.rcon = null;
  s.docker = null;
  s.players.clear();
  s.seenUuids.clear();
  s.tps = null;
  s.mspt = { avg: null, p95: null };
  s.tickMode = null;
  clearReadyTimer(s.steam);
  s.steam = null;
}

export function start(serverId: string): Promise<void> {
  return withLock(serverId, async () => {
    let server = await loadServer(serverId);
    const s = state(serverId);
    if (['running', 'starting', 'installing'].includes(s.status)) throw conflict('Server is already running', 'already_running');
    // A game disabled with blockStart: no start of any kind (manual, restart, auto-start, crash restart, schedules).
    await assertServerCanStart(server);
    // A definition may have gained published ports since the server was created.
    if (isSteamType(server.type)) server = await ensureSteamPorts(server, { running: false, log: (l) => systemLog(serverId, l) });
    // Generated secrets a definition gained after the server was created are filled in (and stored) once.
    const sdef = isSteamType(server.type) && server.steam ? steamDef(server) : null;
    const filled = sdef && server.steam ? fillGeneratedVars(sdef, server.steam.vars ?? {}) : null;
    if (filled && server.steam) {
      server =
        (await queryOne<ServerRow>('UPDATE servers SET steam = $2 WHERE id = $1 RETURNING *', [
          serverId,
          JSON.stringify({ ...server.steam, vars: filled }),
        ])) ?? server;
      systemLog(serverId, '[servcrafty] generated values for new secret settings (see Settings)');
    }
    await fsp.mkdir(serverDir(serverId), { recursive: true });
    s.game = gameOf(server.type);
    s.expectedStop = false;
    s.logs = [];
    s.version = null;
    await query('UPDATE servers SET stopped_by_user=false WHERE id=$1', [serverId]);
    await setStatus(serverId, 'starting');
    try {
      // The previous container (if still alive) is force-removed when the new one is created. Its
      // `die` event (exit 137) must not be mistaken for a crash that triggers an auto-restart.
      if (server.container_id) retiredContainers.add(server.container_id);
      await prepareBluemap(server, (l) => systemLog(serverId, l));
      const container = await createServerContainer(server, await getCurseforgeKey(), (l) => systemLog(serverId, l));
      await query('UPDATE servers SET container_id = $2 WHERE id = $1', [serverId, container.id]);
      await container.start();
      s.startedAt = Date.now();
      resetRuntime(s);
      const steam = isSteamType(server.type);
      if (steam) {
        s.steam = newSteamRuntime(server);
        // One-shot flags are consumed by this start (the plan already carries them).
        await query(
          `UPDATE servers SET steam = steam || '{"validateNext": false, "workshopRefresh": false}'::jsonb WHERE id = $1 AND steam IS NOT NULL`,
          [serverId],
        );
      }
      // For SteamCMD the TTY follows the container just created (the definition may change later).
      const tty = steam ? !!(await container.inspect()).Config.Tty : ttyFor(server);
      await attachLogs(s, container.id, tty);
      attachStats(s, container.id, server.cpu);
      if (consoleKindOf(server) === 'stdin') {
        await attachStdin(s, container.id).catch((err: unknown) =>
          systemLog(serverId, `[servcrafty] could not attach to the console: ${errorMessage(err)}`),
        );
      }
      systemLog(serverId, `[servcrafty] container ${containerName(serverId)} started`);
      if (server.bluemap?.enabled) {
        watchBluemapMaps(server, { status: () => getStatus(serverId), command: (c) => sendCommand(serverId, c), log: (l) => systemLog(serverId, l) });
      }
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
  const tv = terrariaVariant(server.type);
  const sd = isSteamType(server.type) ? steamDef(server) : null;
  if (sd && !kill) await steamGracefulStop(server, s, c, sd);
  if (tv && !kill) {
    // Terraria: `exit` saves the world and quits; give it time before docker stop/kill.
    if (await sendStopCommand(server, s, tv.stopCommand)) {
      const stopped = await Promise.race([
        c.wait({ condition: 'not-running' }).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((r) => setTimeout(() => r(false), tv.stopTimeoutSec * 1000).unref()),
      ]);
      if (!stopped) systemLog(server.id, `[servcrafty] server did not exit within ${tv.stopTimeoutSec}s; stopping the container`);
    }
  }
  try {
    if (kill) await c.kill();
    else await c.stop({ t: tv || sd ? 15 : 90 }); // itzg forwards SIGTERM to a graceful "stop"
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 304) throw err; // 304 = already stopped
  }
  await c.wait({ condition: 'not-running' }).catch(() => undefined);
  resetRuntime(s);
  if (await setStatus(server.id, 'stopped')) bus.emit('notify', server.id, 'server.stopped', { reason: kill ? 'kill' : 'stop' });
}

/**
 * SteamCMD stop per the definition: a console command (stdin) or a signal (delivered to the executor,
 * which forwards it to the game), then wait up to `timeoutSec` before docker stop.
 */
async function steamGracefulStop(server: ServerRow, s: RuntimeState, c: ReturnType<ReturnType<typeof docker>['getContainer']>, def: GameDefinition): Promise<void> {
  let sent = false;
  if (def.stop.type === 'stdin' && def.stop.command) sent = await sendStopCommand(server, s, def.stop.command);
  else {
    try {
      await c.kill({ signal: def.stop.signal });
      systemLog(server.id, `[servcrafty] sent ${def.stop.signal}`);
      sent = true;
    } catch (err) {
      systemLog(server.id, `[servcrafty] could not send ${def.stop.signal}: ${errorMessage(err)}`);
    }
  }
  if (!sent) return;
  const stopped = await Promise.race([
    c.wait({ condition: 'not-running' }).then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), def.stop.timeoutSec * 1000).unref()),
  ]);
  if (!stopped) systemLog(server.id, `[servcrafty] server did not exit within ${def.stop.timeoutSec}s; stopping the container`);
}

async function sendStopCommand(server: ServerRow, s: RuntimeState, cmd: string): Promise<boolean> {
  try {
    await consoleWrite(server, s, cmd);
    pushLine(s, `> ${cmd}`);
    return true;
  } catch (err) {
    systemLog(server.id, `[servcrafty] could not send "${cmd}": ${errorMessage(err)}`);
    return false;
  }
}

/** `manual: false` is for stops the system makes (host shutdown, backups); those do not block auto-start. */
export function stop(serverId: string, kill = false, manual = true): Promise<void> {
  return withLock(serverId, async () => {
    const server = await loadServer(serverId);
    await query('UPDATE servers SET stopped_by_user=$2 WHERE id=$1', [serverId, manual]);
    await stopContainer(server, state(serverId), kill);
  });
}

export async function restart(serverId: string): Promise<void> {
  // Refuse before stopping: a blocked game must not be left stopped by a restart that cannot start it again.
  await assertServerCanStart(await loadServer(serverId));
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
  const steamErr = s.steam?.error ?? null;
  resetRuntime(s);
  if (steamErr && !expected) s.steam = { ...newSteamRuntime(server), error: steamErr };
  if (expected) {
    s.expectedStop = false;
    if (await setStatus(serverId, 'stopped')) bus.emit('notify', serverId, 'server.stopped', { exitCode });
    return;
  }
  const phase = s.status === 'installing' || s.status === 'starting' ? s.status : 'running';
  const steamError = s.steam?.error ?? null;
  if (steamError) systemLog(serverId, `[servcrafty] the game container reported: ${steamError}`);
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
    s.game = gameOf(server.type);
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
        await attachLogs(s, info.Id, isSteamType(server.type) ? !!info.Config.Tty : ttyFor(server), Math.floor(Date.now() / 1000));
        attachStats(s, info.Id, server.cpu);
        let steamStatus: ServerStatus | null = null;
        if (isSteamType(server.type)) {
          const st = (s.steam = newSteamRuntime(server));
          const r = replaySteamLog(s.logs, st.matchers);
          st.phase = r.phase;
          st.progress = r.progress;
          for (const p of r.players) s.players.add(p);
          if (r.phase && (INSTALL_PHASES as readonly string[]).includes(r.phase)) steamStatus = 'installing';
          else if (r.phase === 'launch') steamStatus = r.ready || !st.matchers.ready ? 'running' : 'starting';
        }
        if (gameOf(server.type) === 'terraria') {
          // Players online before the restart are unknown; rebuild them from the recent log.
          for (const line of s.logs) {
            const e = parseTerrariaLine(line);
            if (e?.kind === 'join') s.players.add(e.player);
            else if (e?.kind === 'leave') s.players.delete(e.player);
            else if (e?.kind === 'version') s.version ??= e.version;
          }
        }
        if (isSteamType(server.type) ? !!info.Config.OpenStdin : terrariaVariant(server.type)?.console === 'stdin') {
          await attachStdin(s, info.Id).catch((err: unknown) =>
            logger.warn({ err: errorMessage(err), serverId: server.id }, 'could not re-attach to the console'),
          );
        }
        // Assume running if it has been up for a while; log analysis will confirm otherwise.
        s.status = 'starting';
        await setStatus(server.id, steamStatus ?? (Date.now() - s.startedAt > 60_000 ? 'running' : 'starting'));
      } else if (server.status !== 'stopped' && server.status !== 'crashed') {
        await setStatus(server.id, 'stopped');
      }
    } catch {
      if (server.status !== 'stopped') await setStatus(server.id, 'stopped');
    }
  }
  if (dockerOk) void autoStartServers(logger);
  if (dockerOk) void watchDockerEvents();
  else setTimeout(() => void watchDockerEvents(), 10_000).unref();
}

/**
 * Stop every running game server cleanly (Minecraft saves via SIGTERM, Terraria via `exit`), in parallel.
 * Used when the whole container shuts down; a normal panel restart or self-update leaves servers running.
 */
export async function stopAllServers(): Promise<{ stopped: number; failed: number }> {
  const ids = [...states.entries()].filter(([, s]) => ['running', 'starting', 'installing'].includes(s.status)).map(([id]) => id);
  return systemStopServers(ids, '[servcrafty] host is shutting down: stopping the server');
}

/**
 * Gracefully stop the given servers in parallel as a SYSTEM stop (`manual: false`: not counted as a user
 * stop, so automatic start keeps working). Used by host shutdown and by disabling a game with blockStart.
 */
export async function systemStopServers(ids: readonly string[], message: string): Promise<{ stopped: number; failed: number }> {
  const results = await Promise.allSettled(
    ids.map((id) => {
      systemLog(id, message);
      return stop(id, false, false);
    }),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') log?.warn({ err: errorMessage(r.reason), serverId: ids[i] }, 'graceful stop failed');
  });
  return { stopped: results.filter((r) => r.status === 'fulfilled').length, failed: results.filter((r) => r.status === 'rejected').length };
}

/**
 * After the host came up: start servers that have "automatic start" on and were not stopped by a user.
 * Servers that survived a plain panel restart are already running and are skipped. One at a time, so a
 * host with several servers is not hit by every JVM starting at once.
 */
async function containerIsRunning(...refs: Array<string | null>): Promise<boolean> {
  for (const ref of refs) {
    if (!ref) continue;
    try {
      if ((await docker().getContainer(ref).inspect()).State.Running) return true;
    } catch {
      /* no such container */
    }
  }
  return false;
}

async function autoStartServers(logger: FastifyBaseLogger): Promise<void> {
  const due = await query<{ id: string; name: string; container_id: string | null }>(
    `SELECT id, name, container_id FROM servers WHERE auto_start AND NOT stopped_by_user ORDER BY created_at`,
  );
  for (const { id, name, container_id } of due) {
    if (isRunning(id)) continue;
    // A self-update restarts only the panel; the game containers keep running. Ask Docker directly, by the
    // stored id and by name, so a server that is already up is never started (and its container never replaced).
    if (await containerIsRunning(container_id, containerName(id))) {
      logger.info({ serverId: id }, `${name} is already running, not auto-starting`);
      continue;
    }
    try {
      systemLog(id, '[servcrafty] automatic start');
      await start(id);
      logger.info({ serverId: id }, `auto-started ${name}`);
    } catch (err) {
      logger.warn({ err: errorMessage(err), serverId: id }, 'automatic start failed');
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export async function shutdownRuntime(): Promise<void> {
  eventsStream?.destroy();
  if (ticker) clearInterval(ticker);
  for (const s of states.values()) {
    s.logStream?.destroy();
    s.statsStream?.destroy();
    s.stdin?.end();
    s.rcon?.close();
    clearReadyTimer(s.steam);
  }
}
