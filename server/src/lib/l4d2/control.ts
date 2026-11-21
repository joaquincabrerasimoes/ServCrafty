import { badRequest } from '../errors.js';
import { GAME_MODES, type GameMode } from './campaigns.js';

/**
 * Console commands for the Controls tab of a Left 4 Dead 2 server. Everything that ends up in a command
 * line is validated here (a command is written to the game's stdin, where `;` starts a new command), so
 * callers can pass user input straight to these builders.
 */

export const DIFFICULTIES = [
  { value: 'Easy', label: 'Easy' },
  { value: 'Normal', label: 'Normal' },
  { value: 'Hard', label: 'Advanced' },
  { value: 'Impossible', label: 'Expert' },
] as const;
export type Difficulty = (typeof DIFFICULTIES)[number]['value'];

const MAP_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function assertMap(map: unknown): string {
  if (typeof map !== 'string' || !MAP_RE.test(map)) throw badRequest('Invalid map name', 'invalid_map');
  return map;
}

export function assertMode(mode: unknown): GameMode {
  if (typeof mode !== 'string' || !(GAME_MODES as readonly string[]).includes(mode)) throw badRequest('Invalid game mode', 'invalid_mode');
  return mode as GameMode;
}

export function assertDifficulty(v: unknown): Difficulty {
  const d = DIFFICULTIES.find((x) => x.value === v);
  if (!d) throw badRequest('Invalid difficulty', 'invalid_difficulty');
  return d.value;
}

/** Commands that switch to `map`; `mode` is applied first (it takes effect on the new map). */
export function changeLevelCommands(map: string, mode?: GameMode): string[] {
  const out: string[] = [];
  if (mode) out.push(`mp_gamemode ${mode}`);
  out.push(`changelevel ${assertMap(map)}`);
  return out;
}

export const difficultyCommand = (d: Difficulty): string => `z_difficulty ${d}`;

export function assertUserId(id: unknown): number {
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 1_000_000) throw badRequest('Invalid player id', 'invalid_player');
  return id;
}

/** Free text for a kick reason: one line, no quotes or `;`. */
export function cleanReason(reason: unknown): string {
  if (reason === undefined || reason === null || reason === '') return '';
  if (typeof reason !== 'string') throw badRequest('Invalid reason', 'invalid_reason');
  // eslint-disable-next-line no-control-regex
  return reason.replace(/[\u0000-\u001f\u007f"';\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function kickCommand(userId: number, reason?: string): string {
  const r = cleanReason(reason);
  return r ? `kickid ${assertUserId(userId)} "${r}"` : `kickid ${assertUserId(userId)}`;
}

// ---------------------------------------------------------------------------------------------
// Items

export interface ItemGroup {
  id: string;
  label: string;
  items: { id: string; label: string }[];
}

const item = (id: string, label: string) => ({ id, label });

/** Names accepted by `CTerrorPlayer.GiveItem` (the same names as the `give` command, without `weapon_`). */
export const ITEM_GROUPS: ItemGroup[] = [
  {
    id: 'primary',
    label: 'Primary weapons',
    items: [
      item('smg', 'Uzi'),
      item('smg_silenced', 'Silenced SMG'),
      item('smg_mp5', 'MP5'),
      item('pumpshotgun', 'Pump shotgun'),
      item('shotgun_chrome', 'Chrome shotgun'),
      item('autoshotgun', 'Auto shotgun'),
      item('shotgun_spas', 'SPAS-12'),
      item('rifle', 'M16 rifle'),
      item('rifle_ak47', 'AK-47'),
      item('rifle_desert', 'Desert rifle'),
      item('rifle_sg552', 'SG 552'),
      item('hunting_rifle', 'Hunting rifle'),
      item('sniper_military', 'Military sniper'),
      item('sniper_awp', 'AWP'),
      item('sniper_scout', 'Scout'),
      item('grenade_launcher', 'Grenade launcher'),
      item('rifle_m60', 'M60'),
    ],
  },
  {
    id: 'secondary',
    label: 'Pistols and melee',
    items: [
      item('pistol', 'Pistol'),
      item('pistol_magnum', 'Magnum'),
      item('baseball_bat', 'Baseball bat'),
      item('cricket_bat', 'Cricket bat'),
      item('crowbar', 'Crowbar'),
      item('electric_guitar', 'Guitar'),
      item('fireaxe', 'Fire axe'),
      item('frying_pan', 'Frying pan'),
      item('golfclub', 'Golf club'),
      item('katana', 'Katana'),
      item('machete', 'Machete'),
      item('tonfa', 'Nightstick'),
      item('knife', 'Knife'),
      item('chainsaw', 'Chainsaw'),
    ],
  },
  {
    id: 'throwable',
    label: 'Throwables',
    items: [item('molotov', 'Molotov'), item('pipe_bomb', 'Pipe bomb'), item('vomitjar', 'Bile jar')],
  },
  {
    id: 'health',
    label: 'Health',
    items: [item('first_aid_kit', 'First aid kit'), item('defibrillator', 'Defibrillator'), item('pain_pills', 'Pain pills'), item('adrenaline', 'Adrenaline')],
  },
  {
    id: 'upgrade',
    label: 'Upgrades',
    items: [item('upgradepack_incendiary', 'Incendiary ammo'), item('upgradepack_explosive', 'Explosive ammo')],
  },
  {
    id: 'carry',
    label: 'Carried items',
    items: [item('gascan', 'Gas can'), item('propanetank', 'Propane tank'), item('oxygentank', 'Oxygen tank'), item('fireworkcrate', 'Fireworks'), item('cola_bottles', 'Cola bottles'), item('gnome', 'Gnome')],
  },
];

const ITEM_IDS = new Set(ITEM_GROUPS.flatMap((g) => g.items.map((i) => i.id)));

export function assertItem(id: unknown): string {
  if (typeof id !== 'string' || !ITEM_IDS.has(id)) throw badRequest('Unknown item', 'invalid_item');
  return id;
}

/** The eight survivors, with the game's own character ids (`m_survivorCharacter`). */
export const CHARACTERS = [
  { id: 0, name: 'Nick', game: 'l4d2' },
  { id: 1, name: 'Rochelle', game: 'l4d2' },
  { id: 2, name: 'Coach', game: 'l4d2' },
  { id: 3, name: 'Ellis', game: 'l4d2' },
  { id: 4, name: 'Bill', game: 'l4d1' },
  { id: 5, name: 'Zoey', game: 'l4d1' },
  { id: 6, name: 'Francis', game: 'l4d1' },
  { id: 7, name: 'Louis', game: 'l4d1' },
] as const;

/** Most survivors (people + bots) the bot spawner plugin lets a team have. */
export const SURVIVORS_MAX = 16;
export const SURVIVORS_MIN = 4;

export function assertSurvivors(n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < SURVIVORS_MIN || n > SURVIVORS_MAX) {
    throw badRequest(`The team size must be a whole number from ${SURVIVORS_MIN} to ${SURVIVORS_MAX}`, 'invalid_survivors');
  }
  return n;
}

/** Team size (survivors, people plus bots) through the Multiplayer plugin: it adds or removes survivor bots to match. */
export const survivorsCommand = (n: number): string => `sm_setmax ${assertSurvivors(n)}`;

export function assertCharacter(id: unknown): number {
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= CHARACTERS.length) {
    throw badRequest('Unknown survivor', 'invalid_character');
  }
  return id;
}

/** Command of the bundled `servcrafty_bots` plugin: add one survivor bot of that character. */
export const addBotCommand = (character: number): string => `sc_addbot ${assertCharacter(character)}`;

export interface SurvivorEntry {
  userId: number;
  /** 0-7, or -1 when the game reports none. */
  character: number;
  bot: boolean;
  name: string;
}

/** Output of `sc_survivors` (`SCSURV <userid> <character> <bot> <name>` lines, then `SCEND n`). null = the plugin is not loaded. */
export function parseSurvivorList(output: string): SurvivorEntry[] | null {
  if (!/^SCEND \d+/m.test(output)) return null;
  const list: SurvivorEntry[] = [];
  for (const line of output.split('\n')) {
    const m = /^SCSURV (\d+) (-?\d+) ([01]) (.*)$/.exec(line.trim());
    if (m) list.push({ userId: Number(m[1]), character: Number(m[2]), bot: m[3] === '1', name: m[4]! });
  }
  return list;
}

/** Output of `sc_addbot`: the new bot, or the plugin's error code. null = no answer (plugin missing). */
export function parseAddBot(output: string): { ok: true; userId: number; name: string } | { ok: false; error: string } | null {
  const ok = /^SCOK (\d+) (.+)$/m.exec(output);
  if (ok) return { ok: true, userId: Number(ok[1]), name: ok[2]!.trim() };
  const err = /^SCERR (\w+)/m.exec(output);
  return err ? { ok: false, error: err[1]! } : null;
}

/** `"sv_cheats" = "0" ...` -> true when cheats are on; null when the answer is not recognised (no console output). */
export function parseCheatsState(output: string): boolean | null {
  const m = /"sv_cheats"\s*=\s*"(\d+)"/.exec(output);
  return m ? m[1] !== '0' : null;
}

/** The game refuses cheat commands from the console unless `sv_cheats` is on. */
export const CHEAT_REFUSED = /Can't use cheat command/i;

/** VScript line that gives a survivor an item (the `script` console command runs it on the server). */
export function giveCommand(userId: number, itemId: string): string {
  return `script GetPlayerFromUserID(${assertUserId(userId)}).GiveItem("${assertItem(itemId)}")`;
}

// ---------------------------------------------------------------------------------------------
// `status`

export interface StatusPlayer {
  userId: number;
  name: string;
  /** `STEAM_1:0:123`, `BOT` or null. */
  steamId: string | null;
  bot: boolean;
  /** `active`, `spawning`, ... as printed by the game; null for bots. */
  state: string | null;
  ping: number | null;
  connected: string | null;
}

export interface StatusInfo {
  map: string | null;
  players: StatusPlayer[];
}

/** Last line of the output of `status`. */
export const STATUS_END = /^#end\b/;

/**
 * Parse the output of the `status` command, e.g.
 *   map     : c2m1_highway
 *   # userid name                uniqueid            connected ping loss state   rate adr
 *   #  2 1 "Nick"                STEAM_1:0:1234       03:18   40    0 active 30000 1.2.3.4:27005
 *   #  3 "Coach"                 BOT                                    active
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
    const p = /^#\s*(\d+)\s+(?:\d+\s+)?"(.*)"\s+(\S+)(.*)$/.exec(line);
    if (!p) continue;
    const bot = p[3] === 'BOT';
    const rest = p[4]!.trim().split(/\s+/).filter(Boolean);
    // After the id: connected, ping, loss, state, ...
    const connected = !bot && /^[\d:]+$/.test(rest[0] ?? '') ? rest[0]! : null;
    const ping = !bot && /^\d+$/.test(rest[1] ?? '') ? Number(rest[1]) : null;
    const state = bot ? (rest[rest.length - 1] ?? null) : (rest[3] ?? null);
    players.push({ userId: Number(p[1]), name: p[2]!, steamId: bot ? 'BOT' : /^STEAM_|^\[U:/.test(p[3]!) ? p[3]! : null, bot, state, ping, connected });
  }
  return { map, players };
}
