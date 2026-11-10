import type { Game, Server, ServerType } from '@/api/types';
import type { TFn } from '@/i18n';

/** Variants per game, in the order the wizard shows them. */
export const TERRARIA_TYPES = ['TERRARIA', 'TSHOCK', 'TMODLOADER'] as const satisfies readonly ServerType[];

/** Games with their own fixed UI; SteamCMD games come from game definitions (GET /games). */
export const GAMES: Game[] = ['minecraft', 'terraria'];

export function gameOf(type: ServerType | string | undefined | null): Game {
  if (type === 'STEAMCMD') return 'steam';
  return (TERRARIA_TYPES as readonly string[]).includes(type ?? '') ? 'terraria' : 'minecraft';
}

/** The game of a server; the API always sends `game`, the type is the fallback. */
export function serverGame(s: Pick<Server, 'type'> & { game?: Game }): Game {
  return s.game ?? gameOf(s.type);
}

export interface GameCaps {
  /** server.properties editor tab. */
  hasProperties: boolean;
  /** Mods & plugins catalog tab. */
  hasMods: boolean;
  /** Export & import (modpack export, clone, templates) tab. */
  hasTransfer: boolean;
  /** Initial Minecraft config (wizard step, review). */
  hasMinecraftConfig: boolean;
  /** LAN announce toggle. */
  hasLan: boolean;
  /** Java arguments, Minecraft version and loader version fields. */
  hasJava: boolean;
  /** A Minecraft version is chosen and shown. */
  hasMcVersion: boolean;
  /** TPS / tick time graphs. */
  hasTickStats: boolean;
  /** Operators, whitelist and whitelist join requests. */
  hasOpsWhitelist: boolean;
  /** Minecraft avatars for player names. */
  hasPlayerHeads: boolean;
  /** The Minecraft EULA must be accepted. */
  needsEula: boolean;
  /** Terraria config form and world import. */
  hasTerrariaConfig: boolean;
  /** tModLoader Workshop mod ids. */
  hasWorkshopMods: boolean;
  /** Generic SteamCMD game: variables form, ports list, game-file updates. */
  hasSteamConfig: boolean;
  /** Kick / ban and the ban list on the Players tab. */
  hasPlayerModeration: boolean;
  /** Lowest memory the API accepts. */
  minMemoryMb: number;
  defaultMemoryMb: number;
}

export function capsOf(type: ServerType, game: Game = gameOf(type)): GameCaps {
  const mc = game === 'minecraft';
  const steam = game === 'steam';
  return {
    hasProperties: mc,
    hasMods: mc,
    hasTransfer: mc,
    hasMinecraftConfig: mc,
    hasLan: mc && type !== 'BEDROCK',
    hasJava: mc,
    hasMcVersion: mc,
    hasTickStats: mc,
    hasOpsWhitelist: mc,
    hasPlayerHeads: mc,
    needsEula: mc,
    hasTerrariaConfig: game === 'terraria',
    hasWorkshopMods: type === 'TMODLOADER',
    hasSteamConfig: steam,
    hasPlayerModeration: !steam,
    // SteamCMD games: the definition's resources override these (see lib/gameDefs.ts).
    minMemoryMb: mc ? 1024 : 512,
    defaultMemoryMb: mc ? 4096 : steam ? 4096 : 2048,
  };
}

export const serverCaps = (s: Pick<Server, 'type'> & { game?: Game }) => capsOf(s.type, serverGame(s));

/**
 * One-line variant label: "Paper 1.21.1 · 0.16.5" for Minecraft, "TShock" for Terraria
 * (no Minecraft version for games that have none).
 */
export function variantLabel(
  s: Pick<Server, 'type' | 'mcVersion' | 'loaderVersion'> & { game?: Game },
  t: TFn,
  withLoader = true,
): string {
  const label = t(`type.${s.type}`);
  if (!serverCaps(s).hasMcVersion) return label;
  return `${label} ${s.mcVersion}${withLoader && s.loaderVersion ? ` · ${s.loaderVersion}` : ''}`;
}
