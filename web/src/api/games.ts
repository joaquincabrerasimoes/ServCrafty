import { ApiError, api, asList, request } from './client';
import type { GameDefinition, GameSummary, ValidationIssue, WorkshopItem, WorkshopRef, WorkshopSearchResult } from './types';

const g = (id: string) => `/games/${encodeURIComponent(id)}`;
const s = (id: string) => `/servers/${encodeURIComponent(id)}`;

/** Turns the API's `details` (array of {path, message}, path as string or array) into issues. */
export function toIssues(details: unknown): ValidationIssue[] {
  const list = Array.isArray(details) ? details : details && typeof details === 'object' ? asList<unknown>(details, 'issues', 'errors') : [];
  return list.map((d) => {
    if (typeof d === 'string') return { path: '', message: d };
    const o = (d ?? {}) as { path?: unknown; message?: unknown };
    const path = Array.isArray(o.path) ? o.path.join('.') : o.path == null ? '' : String(o.path);
    return { path, message: String(o.message ?? '') };
  });
}

export type ValidateResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

export const gamesApi = {
  list: async () => asList<GameSummary>(await api.get('/games'), 'games'),
  /** Full definition (authors only), including scripts. */
  get: (id: string) => api.get<GameDefinition>(g(id)),
  create: (definition: unknown) => api.post<GameDefinition>('/games', definition),
  update: (id: string, definition: unknown) => api.put<GameDefinition>(g(id), definition),
  remove: (id: string) => api.del<void>(g(id)),
  validate: async (definition: unknown, signal?: AbortSignal): Promise<ValidateResult> => {
    try {
      await request<unknown>('POST', '/games/validate', { body: { definition }, signal });
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && e.code === 'invalid_game_definition') {
        const issues = toIssues(e.details);
        return { ok: false, issues: issues.length ? issues : [{ path: '', message: e.message }] };
      }
      throw e;
    }
  },
};

export const workshopApi = {
  /** Needs the admin Steam API key (400 steam_key_missing otherwise). `page` is 1-based. */
  search: (params: { gameId: string; q?: string; page?: number; sort?: string }, signal?: AbortSignal) =>
    api.get<WorkshopSearchResult>('/workshop/search', params, signal).then((r) => ({
      items: asList<WorkshopItem>(r, 'items'),
      total: typeof r?.total === 'number' ? r.total : 0,
    })),
  /** Resolves a Workshop id or a Workshop URL. */
  item: (idOrUrl: string, gameId?: string) => api.get<WorkshopItem>(`/workshop/items/${encodeURIComponent(idOrUrl)}`, { gameId }),
  list: async (serverId: string) => asList<WorkshopRef>(await api.get(`${s(serverId)}/workshop`), 'workshop', 'items'),
  add: (serverId: string, idOrUrl: string) =>
    api.post<unknown>(`${s(serverId)}/workshop`, /^\d+$/.test(idOrUrl.trim()) ? { id: idOrUrl.trim() } : { url: idOrUrl.trim() }),
  remove: (serverId: string, itemId: string) => api.del<void>(`${s(serverId)}/workshop/${encodeURIComponent(itemId)}`),
  /** Forces a re-download of the Workshop items on the next start. */
  refresh: (serverId: string) => api.post<void>(`${s(serverId)}/workshop/refresh`),
};
