import { badRequest } from './errors.js';
import type { ServerType } from './validation.js';

/**
 * Single registry of the games/variants ServCrafty can run. Minecraft-vs-Terraria branching
 * should go through the helpers here so it lives in as few places as possible.
 *
 * The Minecraft container itself is still built by `services/docker.ts` (itzg images, Java tag
 * selection, RCON) exactly as before; its entries here only describe capabilities.
 */

export const games = ['minecraft', 'terraria', 'steam'] as const;
export type Game = (typeof games)[number];

export const TERRARIA_TYPES = ['TERRARIA', 'TSHOCK', 'TMODLOADER'] as const satisfies readonly ServerType[];
export type TerrariaType = (typeof TERRARIA_TYPES)[number];

/** The single type of the generic SteamCMD game family (the game itself comes from a game definition). */
export const STEAM_TYPE = 'STEAMCMD' as const satisfies ServerType;

/** The game a server type belongs to. The only source of truth for `servers.game`. */
export function gameOf(type: ServerType | string): Game {
  if (type === STEAM_TYPE) return 'steam';
  return (TERRARIA_TYPES as readonly string[]).includes(type) ? 'terraria' : 'minecraft';
}

export function isTerrariaType(type: ServerType | string): type is TerrariaType {
  return gameOf(type) === 'terraria';
}

export function isSteamType(type: ServerType | string): type is typeof STEAM_TYPE {
  return type === STEAM_TYPE;
}

/** Human name of a game, for error messages. */
export function gameLabel(game: Game): string {
  return game === 'terraria' ? 'Terraria' : game === 'steam' ? 'SteamCMD' : 'Minecraft';
}

/**
 * A "game key" identifies something a server can be created for (SPEC "v0.3.2"): `minecraft`,
 * `terraria`, or `steam:<definitionId>`. Used by per-user game access and by disabled games.
 */
export type GameKey = string;
export const MINECRAFT_KEY = 'minecraft';
export const TERRARIA_KEY = 'terraria';
export const STEAM_KEY_PREFIX = 'steam:';

/** Game key of a SteamCMD game definition. */
export function steamGameKey(definitionId: string): GameKey {
  return `${STEAM_KEY_PREFIX}${definitionId}`;
}

/** Kind of a game key, or null when it is malformed. */
export function gameKeyKind(key: string): Game | null {
  if (key === MINECRAFT_KEY) return 'minecraft';
  if (key === TERRARIA_KEY) return 'terraria';
  if (key.startsWith(STEAM_KEY_PREFIX) && /^[a-z0-9][a-z0-9-]{1,39}$/.test(key.slice(STEAM_KEY_PREFIX.length))) return 'steam';
  return null;
}

/** Definition id of a `steam:<id>` key (null for other keys). */
export function steamIdOfKey(key: string): string | null {
  return gameKeyKind(key) === 'steam' ? key.slice(STEAM_KEY_PREFIX.length) : null;
}

/** Game key of a server row (or of a creation input): STEAMCMD servers use `steam.gameId`. */
export function serverGameKey(server: { type: ServerType | string; steam?: { gameId?: unknown } | null }): GameKey {
  const game = gameOf(server.type);
  if (game !== 'steam') return game;
  const id = server.steam?.gameId;
  return steamGameKey(typeof id === 'string' ? id : '');
}

export interface GameCapabilities {
  /** Console commands go over RCON (Java) and RCON pollers (list, tick query) run. */
  hasRcon: boolean;
  /** Mods/plugins catalog (CurseForge/Modrinth/Hangar) and the Mods tab. */
  hasMods: boolean;
  /** server.properties editor. */
  hasProperties: boolean;
  /** Modpack export (CurseForge / Modrinth / server pack). */
  hasModpackExport: boolean;
  /** LAN discovery announcer. */
  hasLanAnnounce: boolean;
  /** Initial `minecraft` config object. */
  hasMinecraftConfig: boolean;
  /** `terraria` config object. */
  hasTerrariaConfig: boolean;
  /** Op/deop/whitelist player actions. */
  hasOpsWhitelist: boolean;
  /**
   * `steam` config object (game definition driven). Per-definition features (Workshop, web UIs,
   * stdin console, players) are reported by the definition (`hasWorkshop`, `hasWebui`, ...).
   */
  hasSteamConfig: boolean;
}

export interface GameInfo {
  memoryMinMb: number;
  capabilities: GameCapabilities;
}

export const GAMES: Record<Game, GameInfo> = {
  minecraft: {
    memoryMinMb: 512,
    capabilities: {
      hasRcon: true,
      hasMods: true,
      hasProperties: true,
      hasModpackExport: true,
      hasLanAnnounce: true,
      hasMinecraftConfig: true,
      hasTerrariaConfig: false,
      hasOpsWhitelist: true,
      hasSteamConfig: false,
    },
  },
  terraria: {
    memoryMinMb: 512,
    capabilities: {
      hasRcon: false,
      hasMods: false,
      hasProperties: false,
      hasModpackExport: false,
      hasLanAnnounce: false,
      hasMinecraftConfig: false,
      hasTerrariaConfig: true,
      hasOpsWhitelist: false,
      hasSteamConfig: false,
    },
  },
  steam: {
    // The real minimum comes from the definition's `resources.memoryMinMb`.
    memoryMinMb: 256,
    capabilities: {
      hasRcon: false,
      hasMods: false,
      hasProperties: false,
      hasModpackExport: false,
      hasLanAnnounce: false,
      hasMinecraftConfig: false,
      hasTerrariaConfig: false,
      hasOpsWhitelist: false,
      hasSteamConfig: true,
    },
  },
};

export function capabilitiesOf(type: ServerType | string): GameCapabilities {
  return GAMES[gameOf(type)].capabilities;
}

/** Throw 400 `unsupported_game` unless the server runs Minecraft. */
export function assertMinecraft(server: { type: ServerType | string }, what = 'This feature'): void {
  if (gameOf(server.type) !== 'minecraft') throw badRequest(`${what} is only available for Minecraft servers`, 'unsupported_game');
}

/** Throw 400 `unsupported_game` unless the server runs Terraria. */
export function assertTerraria(server: { type: ServerType | string }, what = 'This feature'): void {
  if (gameOf(server.type) !== 'terraria') throw badRequest(`${what} is only available for Terraria servers`, 'unsupported_game');
}

/** Throw 400 `unsupported_game` unless the server runs a SteamCMD game. */
export function assertSteam(server: { type: ServerType | string }, what = 'This feature'): void {
  if (gameOf(server.type) !== 'steam') throw badRequest(`${what} is only available for SteamCMD servers`, 'unsupported_game');
}

/** Repository/tag of the generic SteamCMD executor image (SPEC "SteamCMD games"). */
export const STEAM_IMAGE_NAME = 'servcrafty-steamcmd';

/**
 * `image:tag` of the SteamCMD executor image. `override` is env `SERVCRAFTY_STEAM_IMAGE` (a full image
 * reference; used verbatim when well-formed); otherwise `ghcr.io/<owner>/servcrafty-steamcmd:<tag>` where
 * owner is the owner of the update repository (the same GitHub account publishes the panel image) and tag
 * is the server's SERVCRAFTY_IMAGE_TAG when set, else the panel version.
 */
export function steamImage(opts: { override?: string | null; updateRepo: string; appVersion: string; forcedTag?: string | null }): string {
  const ov = opts.override?.trim();
  if (ov && /^[a-z0-9][a-z0-9._/:@-]{0,254}$/i.test(ov) && !ov.includes('..')) return ov;
  const owner = (opts.updateRepo.split('/')[0] ?? 'servcrafty').toLowerCase();
  const tag = opts.forcedTag && TAG_RE.test(opts.forcedTag) ? opts.forcedTag : TAG_RE.test(opts.appVersion) ? opts.appVersion : 'latest';
  return `ghcr.io/${owner}/${STEAM_IMAGE_NAME}:${tag}`;
}

/** How console commands reach the game process. */
export type ConsoleKind = 'rcon' | 'bedrock-send-command' | 'stdin' | 'inject';

export interface ContainerMount {
  /** Path relative to the server data dir ('' = the dir itself). */
  hostRel: string;
  /** Absolute path inside the container. */
  container: string;
  /** Single-file bind mount (the host file is created empty before start if missing). */
  file?: boolean;
}

export interface TerrariaVariant {
  type: TerrariaType;
  /** Image repository without tag. */
  image: string;
  defaultTag: string;
  platform: 'linux/amd64';
  /** Game port inside the container (the host port comes from the port pool). */
  containerPort: number;
  protocol: 'tcp';
  /** Allocate a TTY (and keep stdin open) - required by images driven through `docker attach`. */
  tty: boolean;
  console: Extract<ConsoleKind, 'stdin' | 'inject'>;
  mounts: ContainerMount[];
  /** Worlds directory relative to the server data dir. */
  worldsRel: string;
  /** Worlds directory inside the container. */
  containerWorldsDir: string;
  /** Extra directories (relative to the server dir) to create before the first start. */
  dirs: string[];
  /** banlist.txt relative to the server dir, or null when bans are not file based (TShock: SQLite). */
  banlistRel: string | null;
  /** Console command that saves the world and exits. */
  stopCommand: string;
  /** Console command that saves the world. */
  saveCommand: string;
  /** How long to wait for the stop command before docker stop/kill. */
  stopTimeoutSec: number;
}

const TERRARIA_HOME = '/root/.local/share/Terraria';

/** Image/tag table for the Terraria variants (SPEC "Other games: Terraria"). */
export const TERRARIA_VARIANTS: Record<TerrariaType, TerrariaVariant> = {
  TERRARIA: {
    type: 'TERRARIA',
    image: 'hexlo/terraria-server-docker',
    defaultTag: 'latest',
    platform: 'linux/amd64',
    containerPort: 7777,
    protocol: 'tcp',
    tty: true,
    console: 'stdin',
    // The whole Terraria home is the server dir: Worlds/ plus banlist.txt (env `banlist`).
    mounts: [{ hostRel: '', container: TERRARIA_HOME }],
    worldsRel: 'Worlds',
    containerWorldsDir: `${TERRARIA_HOME}/Worlds`,
    dirs: ['Worlds'],
    banlistRel: 'banlist.txt',
    stopCommand: 'exit',
    saveCommand: 'save',
    stopTimeoutSec: 60,
  },
  TSHOCK: {
    type: 'TSHOCK',
    image: 'ghcr.io/pryaxis/tshock',
    defaultTag: 'latest',
    platform: 'linux/amd64',
    containerPort: 7777,
    protocol: 'tcp',
    tty: true,
    console: 'stdin',
    mounts: [
      { hostRel: 'tshock', container: '/tshock' },
      { hostRel: 'Worlds', container: '/worlds' },
      { hostRel: 'plugins', container: '/plugins' },
    ],
    worldsRel: 'Worlds',
    containerWorldsDir: '/worlds',
    dirs: ['tshock', 'tshock/logs', 'Worlds', 'plugins'],
    banlistRel: null,
    stopCommand: 'exit',
    saveCommand: 'save',
    stopTimeoutSec: 60,
  },
  TMODLOADER: {
    type: 'TMODLOADER',
    image: 'jacobsmile/tmodloader1.4',
    defaultTag: 'latest',
    platform: 'linux/amd64',
    containerPort: 7777,
    protocol: 'tcp',
    tty: false,
    console: 'inject',
    mounts: [
      { hostRel: '', container: '/data' },
      // The image has no banlist setting; the server keeps banlist.txt in its working dir.
      { hostRel: 'banlist.txt', container: '/terraria-server/banlist.txt', file: true },
    ],
    worldsRel: 'tModLoader/Worlds',
    containerWorldsDir: '/data/tModLoader/Worlds',
    dirs: ['tModLoader', 'tModLoader/Worlds', 'tModLoader/Mods', 'steamMods'],
    banlistRel: 'banlist.txt',
    stopCommand: 'exit',
    saveCommand: 'save',
    stopTimeoutSec: 60,
  },
};

export function terrariaVariant(type: ServerType | string): TerrariaVariant | null {
  return isTerrariaType(type) ? TERRARIA_VARIANTS[type] : null;
}

/** Image tags we accept from the per-server SERVCRAFTY_IMAGE_TAG override. */
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** `image:tag` for a Terraria variant; `forcedTag` is the server's SERVCRAFTY_IMAGE_TAG, if any. */
export function terrariaImage(type: TerrariaType, forcedTag?: string | null): string {
  const v = TERRARIA_VARIANTS[type];
  const tag = forcedTag && TAG_RE.test(forcedTag) ? forcedTag : v.defaultTag;
  return `${v.image}:${tag}`;
}
