import { api } from './client';
import type {
  Cs16BotAction,
  Cs16BotEngine,
  Cs16CatalogMapDetail,
  Cs16CatalogPage,
  Cs16CatalogSort,
  Cs16Controls,
  Cs16MapInstallResult,
  Cs16MapsOverview,
  Cs16PluginsOverview,
  Cs16SettingValue,
} from './types';

const c = (id: string) => `/servers/${encodeURIComponent(id)}/cs16`;

export interface Cs16CatalogSearch {
  q?: string;
  page?: number;
  sort?: Cs16CatalogSort;
  /** GameBanana category id; undefined = all. */
  category?: number;
}

/** Counter-Strike 1.6 servers (game definitions with `profile: "cs16"`). */
export const cs16Api = {
  /** Installed maps and the rotation (viewer). */
  maps: (id: string) => api.get<Cs16MapsOverview>(`${c(id)}/maps`),
  /** Rewrites mapcycle.txt; applied live on a running server (operator). 400 map_not_installed / invalid_mapcycle. */
  setRotation: (id: string, maps: string[]) => api.put<{ ok: boolean; maps: string[]; appliedLive: boolean }>(`${c(id)}/mapcycle`, { maps }),
  /** 409 map_stock / map_in_use (manager). */
  removeMap: (id: string, name: string) => api.del<{ ok: boolean; removed: string }>(`${c(id)}/maps/${encodeURIComponent(name)}`),

  /** GameBanana catalogue (operator). */
  catalog: (id: string, s: Cs16CatalogSearch, signal?: AbortSignal) =>
    api.get<Cs16CatalogPage>(`${c(id)}/catalog/maps`, { q: s.q, page: s.page, sort: s.sort, category: s.category }, signal),
  catalogMap: (id: string, mapId: number, signal?: AbortSignal) => api.get<Cs16CatalogMapDetail>(`${c(id)}/catalog/maps/${mapId}`, undefined, signal),
  /** Downloads and installs the map (10-60 s, manager). 409 map_exists, 400 no_map_in_archive, 502 upstream errors. */
  installCatalogMap: (id: string, mapId: number, fileId?: number) =>
    api.post<Cs16MapInstallResult>(`${c(id)}/catalog/maps/${mapId}/install`, fileId !== undefined ? { fileId } : {}),

  /** Runs `status` in the game console while running: fetch on demand, never on a timer (operator). */
  controls: (id: string) => api.get<Cs16Controls>(`${c(id)}/controls`),
  changeMap: (id: string, map: string, persist?: boolean) => api.post<{ ok: boolean; map: string }>(`${c(id)}/controls/map`, { map, persist }),
  restart: (id: string, kind: 'round' | 'game') => api.post<{ ok: boolean }>(`${c(id)}/controls/restart`, { kind }),
  say: (id: string, message: string) => api.post<{ ok: boolean }>(`${c(id)}/controls/say`, { message }),
  kick: (id: string, userId: number, reason?: string) => api.post<{ ok: boolean }>(`${c(id)}/controls/kick`, reason ? { userId, reason } : { userId }),
  /** 0 minutes = permanent. */
  ban: (id: string, userId: number, minutes: number) => api.post<{ ok: boolean }>(`${c(id)}/controls/ban`, { userId, minutes }),
  /** 409 bot_unsupported for options the YaPB engine does not have. */
  bots: (id: string, body: Cs16BotAction) => api.post<{ ok: boolean; engine: Cs16BotEngine }>(`${c(id)}/controls/bots`, body),
  /** Writes server.cfg; also applied live on a running server. */
  settings: (id: string, settings: Record<string, Cs16SettingValue>) =>
    api.put<{ ok: boolean; settings: Record<string, Cs16SettingValue>; appliedLive: boolean }>(`${c(id)}/controls/settings`, { settings }),

  /** Plugin store (manager). */
  plugins: (id: string) => api.get<Cs16PluginsOverview>(`${c(id)}/plugins`),
  installPlugin: (id: string, pluginId: string) =>
    api.post<{ ok: boolean; installed: string[]; restartRequired: boolean }>(`${c(id)}/plugins/${encodeURIComponent(pluginId)}/install`, {}),
  /** 409 plugin_required while other installed plugins need it. */
  removePlugin: (id: string, pluginId: string) => api.del<{ ok: boolean; restartRequired: boolean }>(`${c(id)}/plugins/${encodeURIComponent(pluginId)}`),
};

export const cs16Keys = {
  maps: (id: string) => ['servers', id, 'cs16', 'maps'] as const,
  /** Outside ['servers', id] on purpose: invalidating the server must not re-run `status` in the console. */
  controls: (id: string) => ['cs16-controls', id] as const,
  plugins: (id: string) => ['servers', id, 'cs16', 'plugins'] as const,
  /** Outside ['servers', id]: invalidating the server must not refetch GameBanana. */
  catalog: (id: string, s: Cs16CatalogSearch) => ['cs16-catalog', id, s.q ?? '', s.page ?? 1, s.sort ?? 'popular', s.category ?? 0] as const,
  catalogMap: (id: string, mapId: number) => ['cs16-catalog-map', id, mapId] as const,
};
