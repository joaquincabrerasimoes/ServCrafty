import { api, asList, normalizeUser } from './client';
import type { AdminGame, AdminSettings, AuditEntry, GameDisabledResult, GameKey, PortEntry, ProcessesResponse, Quotas, Role, SystemInfo, User, UserGamesResponse } from './types';

export interface CreateUserBody {
  username: string;
  password: string;
  email?: string;
  role: Role;
  quotas?: Quotas;
}

export interface UpdateUserBody {
  role?: Role;
  disabled?: boolean;
  quotas?: Quotas;
  password?: string;
  resetMfa?: boolean;
  /** Admin only: allow this user to create game definitions. */
  canAuthorGames?: boolean;
}

export const usersApi = {
  list: async () => asList<User>(await api.get('/users'), 'users').map(normalizeUser),
  create: async (body: CreateUserBody) => normalizeUser(await api.post<User>('/users', body)),
  update: async (id: string, body: UpdateUserBody) => normalizeUser(await api.patch<User>(`/users/${id}`, body)),
  remove: (id: string) => api.del<void>(`/users/${id}`),
  lookup: async (q: string) => asList<{ id: string; username: string }>(await api.get('/users/lookup', { q }), 'users'),
  /** Granted game keys; `games: null` + `unrestricted` for admins. */
  games: async (id: string): Promise<UserGamesResponse> => {
    const r = await api.get<UserGamesResponse>(`/users/${encodeURIComponent(id)}/games`);
    return { games: Array.isArray(r?.games) ? r.games : null, unrestricted: r?.unrestricted === true || !Array.isArray(r?.games) };
  },
  /** Replaces the whole set. */
  setGames: (id: string, games: GameKey[]) => api.put<UserGamesResponse>(`/users/${encodeURIComponent(id)}/games`, { games }),
};

export interface AuditQuery {
  limit?: number;
  offset?: number;
  user?: string;
  action?: string;
}

export const adminApi = {
  settings: () => api.get<AdminSettings>('/admin/settings'),
  saveSettings: (body: Partial<AdminSettings>) => api.put<AdminSettings>('/admin/settings', body),
  ports: async () => asList<PortEntry>(await api.get('/admin/ports'), 'ports'),
  audit: async (q: AuditQuery) => {
    const r = await api.get<unknown>('/admin/audit', { ...q });
    const items = asList<AuditEntry>(r, 'entries', 'audit');
    const total = (r as { total?: number })?.total;
    return { items, total: typeof total === 'number' ? total : undefined };
  },
  system: () => api.get<SystemInfo>('/admin/system'),
  /** Every game (Minecraft, Terraria, each definition) with its disabled state and server counts. */
  games: async () => asList<AdminGame>(await api.get('/admin/games'), 'games'),
  /** Enabling clears blockStart; `stopped` = servers stopped by this call. */
  setGameDisabled: (key: GameKey, body: { disabled: boolean; blockStart?: boolean }) =>
    api.put<GameDisabledResult>(`/admin/games/${encodeURIComponent(key)}/disabled`, body),
  processes: (signal?: AbortSignal) => api.get<ProcessesResponse>('/admin/processes', undefined, signal),
};
