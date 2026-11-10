import type { GameDefinition } from './gameDefinition.js';

/**
 * Pure helpers to read the output of the steamcmd executor image: its machine-readable markers
 * (`[servcrafty-steam] phase=install|workshop|configure|launch`, `progress=<0-100>`, `error=<text>`),
 * SteamCMD's own progress lines, and the definition's ready/join/leave regexes.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Only this much of a line is matched against definition regexes (bounds regex cost). */
export const MAX_MATCH_LEN = 2000;

export const STEAM_PHASES = ['install', 'workshop', 'configure', 'launch'] as const;
export type SteamPhase = (typeof STEAM_PHASES)[number];
export const INSTALL_PHASES: readonly SteamPhase[] = ['install', 'workshop', 'configure'];

export function cleanSteamLine(raw: string): string {
  return raw.replace(ANSI, '').replace(CONTROL, '').trimEnd();
}

export type SteamLogEvent =
  | { kind: 'phase'; phase: SteamPhase }
  | { kind: 'progress'; progress: number }
  | { kind: 'error'; message: string };

const MARKER = /^\[servcrafty-steam\] (phase|progress|error)=(.*)$/;
// SteamCMD: " Update state (0x61) downloading, progress: 45.23 (123456 / 789012)"
const STEAMCMD_PROGRESS = /Update state \(0x[0-9a-f]+\) [a-z ,]*?progress: (\d{1,3}(?:\.\d+)?)/i;

/** Executor marker or SteamCMD progress line -> event. */
export function parseSteamLine(line: string): SteamLogEvent | null {
  const m = MARKER.exec(line);
  if (m) {
    const value = (m[2] ?? '').trim();
    if (m[1] === 'phase') return (STEAM_PHASES as readonly string[]).includes(value) ? { kind: 'phase', phase: value as SteamPhase } : null;
    if (m[1] === 'progress') {
      const n = Number(value);
      return Number.isFinite(n) ? { kind: 'progress', progress: clampPct(n) } : null;
    }
    return { kind: 'error', message: value.slice(0, 500) };
  }
  const p = STEAMCMD_PROGRESS.exec(line);
  if (p?.[1]) return { kind: 'progress', progress: clampPct(Number(p[1])) };
  return null;
}

function clampPct(n: number): number {
  return Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;
}

export interface SteamMatchers {
  ready: RegExp | null;
  join: RegExp | null;
  leave: RegExp | null;
}

function compile(src: string | undefined): RegExp | null {
  if (!src) return null;
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

export function steamMatchers(def: Pick<GameDefinition, 'ready' | 'players'> | null): SteamMatchers {
  return {
    ready: compile(def?.ready?.logRegex),
    join: compile(def?.players?.joinRegex),
    leave: compile(def?.players?.leaveRegex),
  };
}

/** Player name from a join/leave regex match (named group `name`), cleaned. */
export function matchPlayer(re: RegExp | null, line: string): string | null {
  if (!re) return null;
  const m = re.exec(line.slice(0, MAX_MATCH_LEN));
  const name = m?.groups?.name?.trim();
  return name ? name.slice(0, 64) : null;
}

export interface SteamReplay {
  phase: SteamPhase | null;
  progress: number | null;
  ready: boolean;
  players: Set<string>;
}

/** Rebuild the state of a running server from its recent log (panel restart). */
export function replaySteamLog(lines: string[], m: SteamMatchers): SteamReplay {
  const r: SteamReplay = { phase: null, progress: null, ready: false, players: new Set() };
  for (const line of lines) {
    const e = parseSteamLine(line);
    if (e?.kind === 'phase') {
      r.phase = e.phase;
      r.progress = null;
      if (e.phase !== 'launch') {
        r.ready = false;
        r.players.clear();
      }
      continue;
    }
    if (e?.kind === 'progress') {
      r.progress = e.progress;
      continue;
    }
    if (r.phase === 'launch' || r.phase === null) {
      if (m.ready?.test(line.slice(0, MAX_MATCH_LEN))) r.ready = true;
      const j = matchPlayer(m.join, line);
      if (j) r.players.add(j);
      const l = matchPlayer(m.leave, line);
      if (l) r.players.delete(l);
    }
  }
  return r;
}
