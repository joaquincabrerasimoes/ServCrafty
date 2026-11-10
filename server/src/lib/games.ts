import { badRequest } from './errors.js';
import type { ServerType } from './validation.js';

/**
 * Single registry of the games/variants ServCrafty can run. Minecraft-vs-Terraria branching
 * should go through the helpers here so it lives in as few places as possible.
 *
 * The Minecraft container itself is still built by `services/docker.ts` (itzg images, Java tag
 * selection, RCON) exactly as before; its entries here only describe capabilities.
 */

export const games = ['minecraft', 'terraria'] as const;
export type Game = (typeof games)[number];

export const TERRARIA_TYPES = ['TERRARIA', 'TSHOCK', 'TMODLOADER'] as const satisfies readonly ServerType[];
export type TerrariaType = (typeof TERRARIA_TYPES)[number];

/** The game a server type belongs to. The only source of truth for `servers.game`. */
export function gameOf(type: ServerType | string): Game {
  return (TERRARIA_TYPES as readonly string[]).includes(type) ? 'terraria' : 'minecraft';
}

export function isTerrariaType(type: ServerType | string): type is TerrariaType {
  return gameOf(type) === 'terraria';
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
