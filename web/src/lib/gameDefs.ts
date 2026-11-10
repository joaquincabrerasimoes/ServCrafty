import { useQuery } from '@tanstack/react-query';
import { gamesApi } from '@/api/games';
import type { Access, GameDefinition, GamePort, GameSummary, GameWebUi, Server, ShareLevel, User } from '@/api/types';
import type { TFn } from '@/i18n';
import { canManage, canOperate } from './access';
import { serverGame } from './games';

export const gamesKey = ['games'] as const;

/** Game definitions every user may see (GET /games), cached for a minute. */
export function useGameDefs(enabled = true) {
  return useQuery({ queryKey: gamesKey, queryFn: gamesApi.list, staleTime: 60_000, enabled });
}

type DefLike = Partial<Pick<GameDefinition, 'ports' | 'webui' | 'workshop' | 'console' | 'resources' | 'variables'>> & {
  hasWorkshop?: boolean;
  hasWebui?: boolean;
};

/** The definition a SteamCMD server runs (undefined for other games or while loading). */
export function useServerGameDef(server: Pick<Server, 'type' | 'game' | 'steam'> | undefined) {
  const steam = !!server && serverGame(server) === 'steam';
  const q = useGameDefs(steam);
  const def = steam ? q.data?.find((d) => d.id === server?.steam?.gameId) : undefined;
  return { def, isLoading: steam && q.isLoading, settled: !steam || !q.isLoading };
}

/** The port shown in the UI and stored in servers.port: `main: true`, else the first. */
export function mainPortOf(def: DefLike | undefined): GamePort | undefined {
  const ports = def?.ports ?? [];
  return ports.find((p) => p.main) ?? ports[0];
}

/** Ports opened on the host (`publish` defaults to true). */
export const publishedPorts = (def: DefLike | undefined): GamePort[] => (def?.ports ?? []).filter((p) => p.publish !== false);

export const hasWorkshop = (def: DefLike | undefined) => !!def && (!!def.workshop || def.hasWorkshop === true);

/** Console commands are written to stdin only when the definition allows it (unknown = allowed, the API decides). */
export const consoleAllowed = (def: DefLike | undefined) => def?.console?.stdin !== false;

function meets(access: Access | undefined, level: ShareLevel) {
  if (level === 'viewer') return !!access;
  if (level === 'operator') return canOperate(access);
  return canManage(access);
}

/** Web UI entries the user may open (minAccess defaults to manager). */
export function webuiFor(def: DefLike | undefined, access: Access | undefined): GameWebUi[] {
  return (def?.webui ?? []).filter((w) => w && typeof w.id === 'string' && meets(access, w.minAccess ?? 'manager'));
}

/** Display name of the game a server runs: the definition's name for SteamCMD games. */
export function gameName(server: Pick<Server, 'type' | 'game' | 'steam' | 'steamGame'>, defs: GameSummary[] | undefined, t: TFn): string {
  const g = serverGame(server);
  if (g !== 'steam') return t(`game.${g}`);
  const id = server.steam?.gameId;
  return defs?.find((d) => d.id === id)?.name ?? server.steamGame?.name ?? id ?? t('game.steam');
}

export const canAuthorGames = (u: User | null | undefined) => !!u && (u.role === 'admin' || u.canAuthorGames === true);

export const protocolLabel = (p: GamePort['protocol']) => (p === 'both' ? 'TCP + UDP' : p.toUpperCase());

/** Definition ids: ^[a-z0-9][a-z0-9-]{1,39}$ */
export const GAME_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
