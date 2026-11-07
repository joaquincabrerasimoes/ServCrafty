import { api, asList, normalizeUser } from './client';
import type { AdminSettings, AuditEntry, PortEntry, Quotas, Role, SystemInfo, User } from './types';

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
}

export const usersApi = {
  list: async () => asList<User>(await api.get('/users'), 'users').map(normalizeUser),
  create: async (body: CreateUserBody) => normalizeUser(await api.post<User>('/users', body)),
  update: async (id: string, body: UpdateUserBody) => normalizeUser(await api.patch<User>(`/users/${id}`, body)),
  remove: (id: string) => api.del<void>(`/users/${id}`),
  lookup: async (q: string) => asList<{ id: string; username: string }>(await api.get('/users/lookup', { q }), 'users'),
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
};
