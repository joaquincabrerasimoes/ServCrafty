import { useQuery } from '@tanstack/react-query';
import { adminApi } from '@/api/admin';
import type { GameKey, GameKind, GameSummary, Server } from '@/api/types';
import type { TFn } from '@/i18n';
import { serverGame } from './games';
import { useGameDefs } from './gameDefs';

/** Game keys (SPEC "v0.3.2"): `minecraft`, `terraria` or `steam:<definitionId>`. */
export const steamKey = (definitionId: string): GameKey => `steam:${definitionId}`;

/** Key of a GET /games item (the API sends `key`; older APIs do not). */
export const defKey = (d: Pick<GameSummary, 'id' | 'key'>): GameKey => d.key ?? steamKey(d.id);

export const kindOfKey = (key: GameKey): GameKind => (key === 'minecraft' ? 'minecraft' : key === 'terraria' ? 'terraria' : 'steam');

/** Key of the game a server runs (mirrors serverGameKey() on the server). */
export function serverGameKey(s: Pick<Server, 'type' | 'game' | 'steam'>): GameKey {
  const g = serverGame(s);
  return g === 'steam' ? steamKey(s.steam?.gameId ?? '') : g;
}

export interface CatalogGame {
  key: GameKey;
  kind: GameKind;
  name: string;
  /** Definition (Steam games only). */
  def?: GameSummary;
}

/** Every game key that exists: Minecraft, Terraria, then each definition by name. */
export function catalogOf(defs: GameSummary[] | undefined, t: TFn): CatalogGame[] {
  const steam = [...(defs ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((d) => ({ key: defKey(d), kind: 'steam' as const, name: d.name, def: d }));
  return [{ key: 'minecraft', kind: 'minecraft', name: t('game.minecraft') }, { key: 'terraria', kind: 'terraria', name: t('game.terraria') }, ...steam];
}

/** Display name of a game key (falls back to the definition id for unknown keys). */
export function gameKeyName(key: GameKey, defs: GameSummary[] | undefined, t: TFn): string {
  if (key === 'minecraft' || key === 'terraria') return t(`game.${key}`);
  const id = key.startsWith('steam:') ? key.slice(6) : key;
  return defs?.find((d) => defKey(d) === key)?.name ?? id;
}

export const adminGamesKey = ['admin-games'] as const;

/** GET /admin/games (admins only). */
export function useAdminGames(enabled = true) {
  return useQuery({ queryKey: adminGamesKey, queryFn: adminApi.games, enabled, staleTime: 15_000 });
}

/** The catalog of all game keys, for pickers. */
export function useGameCatalog(t: TFn) {
  const defs = useGameDefs();
  return { ...defs, catalog: defs.data ? catalogOf(defs.data, t) : undefined };
}
