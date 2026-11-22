import { badRequest } from '../errors.js';
import { assertMap, assertUserId, cleanReason } from '../l4d2/control.js';

/**
 * Console commands for the Controls tab of a Counter-Strike 1.6 (GoldSrc) server. Everything that ends up in a
 * command line is validated here (a command is written to the game's stdin, where `;` starts a new command), so
 * callers can pass user input straight to these builders.
 *
 * The GoldSrc engine has no Source RCON on the game port, so command output only shows in the server log: the
 * panel reads it by sending a marker (`echo servcrafty-end`) after the command.
 */

export { assertMap, assertUserId, cleanReason };

/** Printed by `echo` after a command whose output the panel wants to read. */
export const END_MARKER = 'servcrafty-end';
export const END_COMMAND = `echo ${END_MARKER}`;
export const END_LINE = new RegExp(`^${END_MARKER}\\s*$`);

export const changeLevelCommand = (map: string): string => `changelevel ${assertMap(map)}`;

export function kickCommand(userId: number, reason?: string): string {
  const r = cleanReason(reason);
  return r ? `kick #${assertUserId(userId)} ${r}` : `kick #${assertUserId(userId)}`;
}

export const BAN_MINUTES_MAX = 60 * 24 * 365;

export function assertBanMinutes(n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > BAN_MINUTES_MAX) throw badRequest('The ban length must be a whole number of minutes (0 = permanent)', 'invalid_minutes');
  return n;
}

/** Ban a player by user id (`banid` keeps the SteamID, `writeid` saves it to banned.cfg). Returns both lines. */
export const banCommands = (userId: number, minutes: number): string[] => [`banid ${assertBanMinutes(minutes)} #${assertUserId(userId)} kick`, 'writeid'];

export const RESTARTS = ['round', 'game'] as const;
export type RestartKind = (typeof RESTARTS)[number];

export function restartCommand(kind: unknown): string {
  if (kind === 'round') return 'sv_restartround 1';
  if (kind === 'game') return 'sv_restart 1';
  throw badRequest('Unknown restart type', 'invalid_restart');
}

/** A chat line from the server (one line, no quotes or `;`). */
export function sayCommand(message: unknown): string {
  if (typeof message !== 'string') throw badRequest('Invalid message', 'invalid_message');
  const m = cleanReason(message);
  if (!m) throw badRequest('The message is empty', 'invalid_message');
  return `say ${m}`;
}

// ---------------------------------------------------------------------------------------------
// Bots

/** `stock` = the bots of the game itself (Zbot, `bot_*` commands); `yapb` = the YaPB plugin (`yb_*`). */
export type BotEngine = 'stock' | 'yapb';

export const BOT_TEAMS = ['any', 't', 'ct'] as const;
export type BotTeam = (typeof BOT_TEAMS)[number];
export const BOT_QUOTA_MAX = 32;
export const BOT_DIFFICULTIES = ['easy', 'normal', 'hard', 'expert'] as const;
export const BOT_QUOTA_MODES = ['normal', 'fill', 'match'] as const;

export type BotRequest =
  | { action: 'add'; team?: BotTeam }
  | { action: 'kick_all' }
  | { action: 'quota'; count: number }
  | { action: 'quota_mode'; mode: (typeof BOT_QUOTA_MODES)[number] }
  | { action: 'difficulty'; level: (typeof BOT_DIFFICULTIES)[number] }
  | { action: 'knives_only'; on: boolean };

export function assertBotRequest(input: unknown): BotRequest {
  if (!input || typeof input !== 'object') throw badRequest('Invalid bot request', 'invalid_bot');
  const r = input as Record<string, unknown>;
  switch (r.action) {
    case 'add': {
      const team = r.team === undefined ? 'any' : r.team;
      if (!(BOT_TEAMS as readonly unknown[]).includes(team)) throw badRequest('Unknown team', 'invalid_team');
      return { action: 'add', team: team as BotTeam };
    }
    case 'kick_all':
      return { action: 'kick_all' };
    case 'quota': {
      if (typeof r.count !== 'number' || !Number.isInteger(r.count) || r.count < 0 || r.count > BOT_QUOTA_MAX) throw badRequest(`The bot count must be a whole number from 0 to ${BOT_QUOTA_MAX}`, 'invalid_quota');
      return { action: 'quota', count: r.count };
    }
    case 'quota_mode':
      if (!(BOT_QUOTA_MODES as readonly unknown[]).includes(r.mode)) throw badRequest('Unknown quota mode', 'invalid_quota_mode');
      return { action: 'quota_mode', mode: r.mode as (typeof BOT_QUOTA_MODES)[number] };
    case 'difficulty':
      if (!(BOT_DIFFICULTIES as readonly unknown[]).includes(r.level)) throw badRequest('Unknown difficulty', 'invalid_difficulty');
      return { action: 'difficulty', level: r.level as (typeof BOT_DIFFICULTIES)[number] };
    case 'knives_only':
      if (typeof r.on !== 'boolean') throw badRequest('on must be true or false', 'invalid_bot');
      return { action: 'knives_only', on: r.on };
    default:
      throw badRequest('Unknown bot action', 'invalid_bot');
  }
}

/** Console lines for a bot request; null when the bot engine has no such command (difficulty and knives with YaPB). */
export function botCommands(engine: BotEngine, req: BotRequest): string[] | null {
  if (engine === 'yapb') {
    switch (req.action) {
      case 'add':
        return [req.team === 't' ? 'yb add -1 -1 1' : req.team === 'ct' ? 'yb add -1 -1 2' : 'yb add'];
      case 'kick_all':
        return ['yb kickall'];
      case 'quota':
        return [`yb_quota ${req.count}`];
      case 'quota_mode':
        return [`yb_quota_mode ${req.mode}`];
      default:
        return null;
    }
  }
  switch (req.action) {
    case 'add':
      return [req.team === 't' ? 'bot_add_t' : req.team === 'ct' ? 'bot_add_ct' : 'bot_add'];
    case 'kick_all':
      return ['bot_kick'];
    case 'quota':
      return [`bot_quota ${req.count}`];
    case 'quota_mode':
      return [`bot_quota_mode ${req.mode}`];
    case 'difficulty':
      return [`bot_difficulty ${BOT_DIFFICULTIES.indexOf(req.level)}`];
    case 'knives_only':
      return [`bot_knives_only ${req.on ? 1 : 0}`];
  }
}

// ---------------------------------------------------------------------------------------------
// Match settings (cvars)

export interface MatchSetting {
  key: string;
  type: 'number' | 'boolean';
  default: number | boolean;
  min?: number;
  max?: number;
  group: 'time' | 'economy' | 'rules';
}

/** The cvars the Controls tab can change; the same values are written to `server.cfg` so they survive a restart. */
export const MATCH_SETTINGS: MatchSetting[] = [
  { key: 'mp_timelimit', type: 'number', default: 20, min: 0, max: 600, group: 'time' },
  { key: 'mp_roundtime', type: 'number', default: 5, min: 1, max: 9, group: 'time' },
  { key: 'mp_freezetime', type: 'number', default: 6, min: 0, max: 60, group: 'time' },
  { key: 'mp_buytime', type: 'number', default: 1, min: 0, max: 60, group: 'time' },
  { key: 'mp_maxrounds', type: 'number', default: 0, min: 0, max: 100, group: 'time' },
  { key: 'mp_winlimit', type: 'number', default: 0, min: 0, max: 100, group: 'time' },
  { key: 'mp_startmoney', type: 'number', default: 800, min: 800, max: 16000, group: 'economy' },
  { key: 'mp_c4timer', type: 'number', default: 45, min: 10, max: 90, group: 'economy' },
  { key: 'mp_friendlyfire', type: 'boolean', default: false, group: 'rules' },
  { key: 'mp_autoteambalance', type: 'boolean', default: true, group: 'rules' },
  { key: 'mp_limitteams', type: 'number', default: 2, min: 0, max: 20, group: 'rules' },
  { key: 'sv_alltalk', type: 'boolean', default: false, group: 'rules' },
  { key: 'mp_forcecamera', type: 'number', default: 0, min: 0, max: 2, group: 'rules' },
];

export type MatchValues = Record<string, number | boolean>;

/** Validate a partial settings object (unknown keys are refused). */
export function assertMatchSettings(input: unknown): MatchValues {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('settings must be an object', 'invalid_settings');
  const out: MatchValues = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const s = MATCH_SETTINGS.find((x) => x.key === k);
    if (!s) throw badRequest(`Unknown setting "${k}"`, 'invalid_settings');
    if (s.type === 'boolean') {
      if (typeof v !== 'boolean') throw badRequest(`${k} must be true or false`, 'invalid_settings');
    } else if (typeof v !== 'number' || !Number.isInteger(v) || v < (s.min ?? 0) || v > (s.max ?? 1_000_000)) {
      throw badRequest(`${k} must be a whole number from ${s.min} to ${s.max}`, 'invalid_settings');
    }
    out[k] = v as number | boolean;
  }
  return out;
}

const cvarValue = (v: number | boolean) => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v));

export const settingCommands = (values: MatchValues): string[] => Object.entries(values).map(([k, v]) => `${k} ${cvarValue(v)}`);

/** Read the settings from the text of `server.cfg` (lines `key value` or `key "value"`); missing keys use their default. */
export function readMatchSettings(cfg: string): MatchValues {
  const out: MatchValues = {};
  for (const s of MATCH_SETTINGS) {
    out[s.key] = s.default;
    const m = new RegExp(`^\\s*${s.key}\\s+"?([^"\\s/]+)"?`, 'im').exec(cfg);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    out[s.key] = s.type === 'boolean' ? n !== 0 : n;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// `status`

export interface StatusPlayer {
  userId: number;
  name: string;
  /** `STEAM_0:1:123`, `BOT`, `HLTV`, ... as printed by the game. */
  steamId: string | null;
  bot: boolean;
  frags: number | null;
  /** Connected time, `mm:ss` or `hh:mm:ss`. */
  connected: string | null;
  ping: number | null;
  loss: number | null;
}

export interface StatusInfo {
  map: string | null;
  players: StatusPlayer[];
}

/**
 * Parse the output of `status`, e.g.
 *   map     :  de_dust2 at: 0 x, 0 y, 0 z
 *   #      name userid uniqueid frag time ping loss adr
 *   # 1 "Stervil98" 2 STEAM_0:1:91473723   0 00:12   40    0 1.2.3.4:27005
 *   # 2 "Pedro" 3 BOT   0 00:12    0    0
 */
export function parseStatus(lines: string[]): StatusInfo {
  let map: string | null = null;
  const players: StatusPlayer[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const m = /^map\s*:\s*(\S+)/.exec(line);
    if (m) {
      map = m[1]!;
      continue;
    }
    const p = /^#\s*\d+\s+"(.*)"\s+(\d+)\s+(\S+)(?:\s+(-?\d+))?(?:\s+([\d:]+))?(?:\s+(\d+))?(?:\s+(\d+))?/.exec(line);
    if (!p) continue;
    const id = p[3]!;
    const bot = id === 'BOT';
    players.push({
      userId: Number(p[2]),
      name: p[1]!,
      steamId: id,
      bot,
      frags: p[4] === undefined ? null : Number(p[4]),
      connected: p[5] ?? null,
      ping: p[6] === undefined ? null : Number(p[6]),
      loss: p[7] === undefined ? null : Number(p[7]),
    });
  }
  return { map, players };
}
