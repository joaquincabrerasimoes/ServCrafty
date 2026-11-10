/**
 * Process monitor helpers (SPEC "v0.3.2" 4): parsing of `docker top` / `ps` output, instantaneous CPU from
 * cumulative CPU time deltas, command redaction and the cached snapshot builder. Everything here is pure or
 * takes its dependencies as arguments, so it is testable without Docker.
 */

/** `ps` arguments passed to Docker top (it runs `ps` against the container's PIDs, no tools needed inside). */
export const PS_ARGS = '-eo pid,ppid,user,time,rss,stat,etime,args';

export const MAX_COMMAND_CHARS = 500;
export const MAX_SERVERS = 64;
export const CACHE_MS = 1500;

/** One parsed `ps` row. */
export interface PsRow {
  pid: number;
  ppid: number;
  user: string;
  /** Cumulative CPU time in seconds. */
  cpuTimeSec: number;
  /** Resident set size in KiB. */
  rssKb: number;
  state: string;
  elapsedSec: number;
  command: string;
}

/**
 * Seconds of a `ps` duration: `[[dd-]hh:]mm:ss` (etime, procps `time` is `[dd-]hh:mm:ss`; BusyBox prints
 * `mm:ss` with minutes > 59, possibly with a fraction). Returns null when unparseable.
 */
export function parseDuration(text: string): number | null {
  const t = text.trim();
  const m = /^(?:(\d+)-)?(\d+(?::\d+){0,2}(?:\.\d+)?)$/.exec(t);
  if (!m) {
    // BusyBox may print large times as e.g. "1d02" (days+hours) or "12h" – rare; treat as unknown.
    return null;
  }
  const days = m[1] ? Number(m[1]) : 0;
  const parts = m[2]!.split(':');
  if (days && parts.length < 2) return null;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + Number(p);
  // With three parts the first is hours: h*3600 + m*60 + s, which the loop already computes.
  const total = days * 86400 + secs;
  return Number.isFinite(total) ? total : null;
}

/** KiB of an RSS column: plain KiB (procps) or BusyBox's scaled `12m` / `1.5g` / `800k`. */
export function parseRssKb(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([kmgt])?$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { k: 1, m: 1024, g: 1024 ** 2, t: 1024 ** 3 }[(m[2] ?? 'k').toLowerCase() as 'k' | 'm' | 'g' | 't'];
  return Math.round(n * mult);
}

const COLUMN_ALIASES: Record<keyof PsRow, string[]> = {
  pid: ['PID'],
  ppid: ['PPID'],
  user: ['USER', 'UID', 'RUSER'],
  cpuTimeSec: ['TIME'],
  rssKb: ['RSS', 'RSZ'],
  state: ['STAT', 'S', 'STATE'],
  elapsedSec: ['ELAPSED', 'ETIME'],
  command: ['COMMAND', 'ARGS', 'CMD'],
};

/**
 * Parse a Docker top result (`{Titles, Processes}`). Docker splits the ps output on whitespace and keeps the
 * rest of the line in the last column; rows with extra cells (another splitter) are re-joined into it.
 * Rows without a numeric PID are skipped.
 */
export function parseTop(top: { Titles?: string[] | null; Processes?: string[][] | null }): PsRow[] {
  const titles = (top.Titles ?? []).map((t) => t.trim().toUpperCase());
  const idx = {} as Record<keyof PsRow, number>;
  for (const [k, names] of Object.entries(COLUMN_ALIASES) as [keyof PsRow, string[]][]) idx[k] = titles.findIndex((t) => names.includes(t));
  if (idx.pid < 0) return [];
  const last = titles.length - 1;
  const out: PsRow[] = [];
  for (const raw of top.Processes ?? []) {
    if (!Array.isArray(raw)) continue;
    const cells = raw.length > titles.length && last >= 0 ? [...raw.slice(0, last), raw.slice(last).join(' ')] : raw;
    const cell = (k: keyof PsRow) => (idx[k] >= 0 ? String(cells[idx[k]] ?? '').trim() : '');
    const pid = Number(cell('pid'));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const ppid = Number(cell('ppid'));
    out.push({
      pid,
      ppid: Number.isInteger(ppid) && ppid >= 0 ? ppid : 0,
      user: cell('user'),
      cpuTimeSec: parseDuration(cell('cpuTimeSec')) ?? 0,
      rssKb: parseRssKb(cell('rssKb')) ?? 0,
      state: cell('state'),
      elapsedSec: parseDuration(cell('elapsedSec')) ?? 0,
      command: cell('command'),
    });
  }
  return out;
}

/** Parse raw `ps` text (header line + rows) the way Docker does; used for tests and non-Docker sources. */
export function parsePsText(text: string): PsRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const titles = lines[0]!.trim().split(/\s+/);
  const rows = lines.slice(1).map((l) => {
    const f = l.trim().split(/\s+/);
    return [...f.slice(0, titles.length - 1), f.slice(titles.length - 1).join(' ')];
  });
  return parseTop({ Titles: titles, Processes: rows });
}

// ---------------------------------------------------------------------------------------------
// Redaction

const SENSITIVE_NAME = /(pass(word|wd)?|secret|token|api[_-]?key|auth[_-]?key|rcon_password)/i;
/** A flag whose VALUE is the next argument: `--password x`, `-password x`, `+password x`, `+rcon_password x`, `-ServerPassword x`. */
const SENSITIVE_FLAG = /^([-+]{1,2})?[A-Za-z0-9_.-]*(pass(word|wd)?|secret|token|api[_-]?key|rcon_password)[A-Za-z0-9_.-]*$/i;
const REDACTED = '***';

/**
 * Remove secrets from a command line: `scf_` API tokens anywhere, `name=value` / `name:value` pairs whose
 * name looks sensitive (also inside `?a=b?c=d` URL-style game options), and the argument following a
 * sensitive flag. The result is truncated to MAX_COMMAND_CHARS.
 */
export function redactCommand(cmd: string, maxChars = MAX_COMMAND_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const tokens = cmd.replace(/[\x00-\x1f\x7f]/g, ' ').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let redactNext = false;
  for (const tok of tokens) {
    if (redactNext) {
      out.push(REDACTED);
      redactNext = false;
      continue;
    }
    let t = tok.replace(/scf_[A-Za-z0-9_-]+/g, `scf_${REDACTED}`);
    // name=value pairs (several per token for `Map?Password=x?AdminPassword=y`, `a=1&token=2`).
    t = t.replace(/([A-Za-z0-9_.-]+)([=:])([^?&;,\s]*)/g, (whole, name: string, sep: string, value: string) =>
      SENSITIVE_NAME.test(name) && value ? `${name}${sep}${REDACTED}` : whole,
    );
    if (SENSITIVE_FLAG.test(tok)) redactNext = true;
    out.push(t);
  }
  const joined = out.join(' ');
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}

// ---------------------------------------------------------------------------------------------
// CPU from cumulative CPU time deltas

interface PidSample {
  cpuTimeSec: number;
  elapsedSec: number;
  at: number;
}

/** Only samples this recent are used as the baseline; older ones are dropped. */
const BASELINE_MAX_AGE_MS = 10_000;
/** Samples kept per pid (ps times have a 1 s resolution: a baseline a few seconds old smooths that). */
const SAMPLES_PER_PID = 6;
/** Containers not sampled for this long are forgotten. */
const CONTAINER_TTL_MS = 60_000;
/** Hard cap of pids tracked over all containers. */
export const MAX_TRACKED_PIDS = 20_000;

/**
 * Per container and pid history of cumulative CPU time, bounded: pids that disappeared and containers not
 * sampled for a minute are dropped, and the total is capped.
 */
export class CpuTracker {
  private readonly containers = new Map<string, { at: number; pids: Map<number, PidSample[]> }>();

  /**
   * Instantaneous CPU% (100 = one core, like htop) of each row: delta of cumulative CPU time over the wall
   * time since the oldest recent sample of the same pid; the first sample (or a reused pid) falls back to
   * the lifetime average `cpuTime / elapsed`. Records the rows as the new samples.
   */
  sample(containerId: string, rows: readonly PsRow[], now: number): Map<number, number> {
    this.expire(now);
    const prev = this.containers.get(containerId)?.pids ?? new Map<number, PidSample[]>();
    const next = new Map<number, PidSample[]>();
    const out = new Map<number, number>();
    for (const r of rows) {
      let hist = (prev.get(r.pid) ?? []).filter((h) => now - h.at <= BASELINE_MAX_AGE_MS && h.at < now);
      const newest = hist[hist.length - 1];
      // pid reuse (a new process with the same pid) or a counter going backwards: start over.
      if (newest && (r.cpuTimeSec < newest.cpuTimeSec || r.elapsedSec + 2 < newest.elapsedSec)) hist = [];
      const base = hist[0];
      let pct: number;
      if (base) {
        const wall = (now - base.at) / 1000;
        pct = wall > 0 ? ((r.cpuTimeSec - base.cpuTimeSec) / wall) * 100 : 0;
      } else {
        pct = r.elapsedSec > 0 ? (r.cpuTimeSec / r.elapsedSec) * 100 : 0;
      }
      out.set(r.pid, Math.max(0, Math.round(pct * 10) / 10));
      hist.push({ cpuTimeSec: r.cpuTimeSec, elapsedSec: r.elapsedSec, at: now });
      next.set(r.pid, hist.slice(-SAMPLES_PER_PID));
    }
    // Pids not in this sample are gone (dead); only the current ones are kept.
    this.containers.set(containerId, { at: now, pids: next });
    this.enforceCap();
    return out;
  }

  /** Forget containers that are no longer sampled (stopped/vanished). */
  retain(containerIds: Iterable<string>): void {
    const keep = new Set(containerIds);
    for (const id of [...this.containers.keys()]) if (!keep.has(id)) this.containers.delete(id);
  }

  /** Number of pids tracked (tests). */
  size(): number {
    let n = 0;
    for (const c of this.containers.values()) n += c.pids.size;
    return n;
  }

  containerCount(): number {
    return this.containers.size;
  }

  private expire(now: number): void {
    for (const [id, c] of this.containers) if (now - c.at > CONTAINER_TTL_MS) this.containers.delete(id);
  }

  private enforceCap(): void {
    if (this.size() <= MAX_TRACKED_PIDS) return;
    // Drop the least recently sampled containers first.
    const byAge = [...this.containers.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [id] of byAge) {
      if (this.size() <= MAX_TRACKED_PIDS) break;
      this.containers.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Snapshot

export interface ProcessInfo {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memMb: number;
  memPercent: number;
  state: string;
  elapsedSec: number;
  cpuTimeSec: number;
  command: string;
}

export interface ServerProcesses {
  serverId: string;
  name: string;
  game: string;
  gameKey: string;
  status: string;
  containerId: string | null;
  /** Container CPU from the runtime's docker stats: percent of the server's CPU allotment (as in Stats). */
  cpuPercent: number;
  /** The server's CPU allotment in cores (to convert `cpuPercent` to host cores). */
  cpuLimit: number;
  memUsedMb: number;
  memLimitMb: number;
  processes: ProcessInfo[];
}

export interface ProcessSnapshot {
  takenAt: string;
  intervalMs: number;
  host: { cpuCount: number; memTotalMb: number };
  servers: ServerProcesses[];
  dockerAvailable: boolean;
}

/** A running game server as the monitor sees it. */
export interface MonitoredServer {
  serverId: string;
  name: string;
  game: string;
  gameKey: string;
  status: string;
  containerId: string | null;
  cpuLimit: number;
  /** Runtime's last docker stats sample, or null. */
  stats: { cpuPercent: number; memUsedMb: number; memLimitMb: number } | null;
}

export interface MonitorDeps {
  /** Running game servers (at most MAX_SERVERS are used). */
  listServers(): Promise<MonitoredServer[]>;
  /** Docker top of a container; throws when it vanished or Docker is down. */
  top(containerId: string, psArgs: string): Promise<{ Titles?: string[] | null; Processes?: string[][] | null }>;
  dockerAvailable(): Promise<boolean>;
  host(): { cpuCount: number; memTotalMb: number };
  now(): number;
}

/** Build one snapshot (no caching). */
export async function buildSnapshot(deps: MonitorDeps, tracker: CpuTracker): Promise<ProcessSnapshot> {
  const host = deps.host();
  const all = (await deps.listServers()).slice(0, MAX_SERVERS);
  const dockerUp = await deps.dockerAvailable().catch(() => false);
  const now = deps.now();
  const servers = await Promise.all(
    all.map(async (s): Promise<ServerProcesses> => {
      let processes: ProcessInfo[] = [];
      if (dockerUp && s.containerId) {
        try {
          const rows = parseTop(await deps.top(s.containerId, PS_ARGS));
          const cpu = tracker.sample(s.containerId, rows, now);
          const limitMb = s.stats?.memLimitMb && s.stats.memLimitMb > 0 ? s.stats.memLimitMb : host.memTotalMb;
          processes = rows.map((r) => {
            const memMb = Math.round((r.rssKb / 1024) * 10) / 10;
            return {
              pid: r.pid,
              ppid: r.ppid,
              user: r.user,
              cpuPercent: cpu.get(r.pid) ?? 0,
              memMb,
              memPercent: limitMb > 0 ? Math.round((memMb / limitMb) * 1000) / 10 : 0,
              state: r.state,
              elapsedSec: r.elapsedSec,
              cpuTimeSec: r.cpuTimeSec,
              command: redactCommand(r.command),
            };
          });
        } catch {
          // The container vanished mid-request (or Docker hiccuped): report it without processes.
          processes = [];
        }
      }
      return {
        serverId: s.serverId,
        name: s.name,
        game: s.game,
        gameKey: s.gameKey,
        status: s.status,
        containerId: s.containerId,
        cpuPercent: s.stats?.cpuPercent ?? 0,
        cpuLimit: s.cpuLimit,
        memUsedMb: s.stats?.memUsedMb ?? 0,
        memLimitMb: s.stats?.memLimitMb ?? 0,
        processes,
      };
    }),
  );
  tracker.retain(all.map((s) => s.containerId).filter((x): x is string => !!x));
  return { takenAt: new Date(now).toISOString(), intervalMs: CACHE_MS, host, servers, dockerAvailable: dockerUp };
}

/**
 * Snapshot provider with a ~1.5 s cache: concurrent and closely spaced callers share one set of docker
 * calls (an in-flight build is shared too).
 */
export function createProcessMonitor(deps: MonitorDeps, cacheMs = CACHE_MS): { snapshot(): Promise<ProcessSnapshot>; tracker: CpuTracker } {
  const tracker = new CpuTracker();
  let cached: { at: number; value: ProcessSnapshot } | null = null;
  let inflight: Promise<ProcessSnapshot> | null = null;
  return {
    tracker,
    snapshot() {
      if (cached && deps.now() - cached.at < cacheMs) return Promise.resolve(cached.value);
      if (inflight) return inflight;
      inflight = buildSnapshot(deps, tracker)
        .then((value) => {
          cached = { at: deps.now(), value };
          return value;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}
