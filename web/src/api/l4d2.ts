import { api } from './client';
import type { L4dControls, L4dDifficulty, L4dGameMode, L4dMapsOverview, L4dPluginsOverview, L4dSettingValue } from './types';

const l = (id: string) => `/servers/${encodeURIComponent(id)}/l4d2`;

/** Left 4 Dead 2 servers (game definitions with `profile: "l4d2"`). */
export const l4d2Api = {
  /** Campaigns, addons and maps read from the game files (viewer). */
  maps: (id: string) => api.get<L4dMapsOverview>(`${l(id)}/maps`),

  /** Runs the game's `status` command (it shows in the console): fetch on demand, never on a timer (operator). */
  controls: (id: string) => api.get<L4dControls>(`${l(id)}/controls`),
  /** One of `map` or `campaign` (a campaign id: its first chapter for `mode`). `persist` also makes it the start map/mode. */
  changeMap: (id: string, body: { map?: string; campaign?: string; mode?: L4dGameMode; persist?: boolean }) =>
    api.post<{ ok: boolean; map: string; mode: L4dGameMode | null }>(`${l(id)}/controls/map`, body),
  difficulty: (id: string, difficulty: L4dDifficulty, persist?: boolean) =>
    api.post<{ ok: boolean; difficulty: L4dDifficulty }>(`${l(id)}/controls/difficulty`, { difficulty, persist }),
  kick: (id: string, userId: number, reason?: string) =>
    api.post<{ ok: boolean }>(`${l(id)}/controls/kick`, reason ? { userId, reason } : { userId }),
  setTeamSize: (id: string, count: number) => api.post<{ ok: boolean; survivors: number }>(`${l(id)}/controls/team`, { count }),
  addBot: (id: string, character: number) => api.post<{ ok: boolean; userId: number; name: string }>(`${l(id)}/controls/bots`, { character }),
  give: (id: string, userId: number, item: string) => api.post<{ ok: boolean }>(`${l(id)}/controls/give`, { userId, item }),

  /** Plugin store (manager). */
  plugins: (id: string) => api.get<L4dPluginsOverview>(`${l(id)}/plugins`),
  /** Installs the plugin and what it needs (30-90 s for SourceMod); an installed plugin is updated. */
  installPlugin: (id: string, pluginId: string, settings?: Record<string, L4dSettingValue>) =>
    api.post<{ ok: boolean; installed: string[]; restartRequired: boolean }>(
      `${l(id)}/plugins/${encodeURIComponent(pluginId)}/install`,
      settings ? { settings } : {},
    ),
  /** 409 plugin_required while other installed plugins need it. */
  removePlugin: (id: string, pluginId: string) =>
    api.del<{ ok: boolean; restartRequired: boolean }>(`${l(id)}/plugins/${encodeURIComponent(pluginId)}`),
  pluginSettings: (id: string, pluginId: string, settings: Record<string, L4dSettingValue>) =>
    api.put<{ ok: boolean; settings: Record<string, L4dSettingValue>; appliedLive: boolean }>(
      `${l(id)}/plugins/${encodeURIComponent(pluginId)}/settings`,
      { settings },
    ),
};

export const l4d2Keys = {
  maps: (id: string) => ['servers', id, 'l4d2', 'maps'] as const,
  /** Outside ['servers', id] on purpose: invalidating the server must not re-run `status` in the console. */
  controls: (id: string) => ['l4d2-controls', id] as const,
  plugins: (id: string) => ['servers', id, 'l4d2', 'plugins'] as const,
};
