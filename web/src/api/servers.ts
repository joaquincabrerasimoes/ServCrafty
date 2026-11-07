import { api, asList, downloadUrl } from './client';
import type {
  Backup,
  CatalogSource,
  CreateServerBody,
  FileEntry,
  InstalledMod,
  ListedPlayer,
  ModUpdate,
  PlayerAction,
  PlayerList,
  PowerAction,
  Schedule,
  Server,
  Share,
  ShareLevel,
  Stats,
  Template,
  Webhook,
} from './types';

/** The API keeps the schedule payload as an object ({command, keep, ...}); the UI edits just the command text. */
type RawSchedule = Omit<Schedule, 'payload'> & { payload?: { command?: string } | null };
const fromRawSchedule = (r: RawSchedule): Schedule => ({ ...r, payload: r.payload?.command ?? null });
function toRawSchedule<T extends Partial<Schedule>>(b: T) {
  const { payload, ...rest } = b;
  const out: Record<string, unknown> = { ...rest };
  if (payload !== undefined) out.payload = payload ? { command: payload } : {};
  return out;
}

type RawMod = {
  file: string;
  enabled?: boolean;
  size?: number;
  meta?: { name?: string; source?: CatalogSource; projectId?: string; versionNumber?: string } | null;
};
type RawUpdate = Omit<ModUpdate, 'latestVersion' | 'fileId' | 'currentVersion'> & {
  currentVersion?: string | null;
  latest?: { id: string; versionNumber: string };
};

const s = (id: string) => `/servers/${encodeURIComponent(id)}`;

export type ExportFormat = 'curseforge' | 'modrinth' | 'serverpack';

export const serversApi = {
  list: async () => asList<Server>(await api.get('/servers'), 'servers'),
  get: (id: string) => api.get<Server>(s(id)),
  create: (body: CreateServerBody) => api.post<Server>('/servers', body),
  update: (id: string, body: Partial<Server> & Record<string, unknown>) => api.patch<Server>(s(id), body),
  remove: (id: string) => api.del<void>(s(id)),

  power: (id: string, action: PowerAction) => api.post<void>(`${s(id)}/power`, { action }),
  command: (id: string, command: string) => api.post<{ output?: string } | void>(`${s(id)}/command`, { command }),
  logs: async (id: string, tail = 500) => {
    const r = await api.get<unknown>(`${s(id)}/logs`, { tail });
    if (typeof r === 'string') return r.split(/\r?\n/);
    return asList<string>(r, 'lines', 'logs');
  },
  stats: (id: string) => api.get<Stats>(`${s(id)}/stats`),

  // Players
  players: async (id: string) => {
    const r = await api.get<unknown>(`${s(id)}/players`);
    if (r && typeof r === 'object' && !Array.isArray(r) && 'list' in r) return r as Stats['players'];
    const list = asList<{ name: string } | string>(r, 'players').map((p) => (typeof p === 'string' ? { name: p } : p));
    return { online: list.length, max: 0, list };
  },
  playerAction: (id: string, name: string, action: PlayerAction, reason?: string) =>
    api.post<void>(`${s(id)}/players/${encodeURIComponent(name)}/${action}`, reason ? { reason } : {}),
  playerList: async (id: string, list: PlayerList) =>
    asList<ListedPlayer | string>(await api.get(`${s(id)}/lists/${list}`), list).map((p) =>
      typeof p === 'string' ? { name: p } : p,
    ),

  // Properties
  properties: (id: string) => api.get<Record<string, string>>(`${s(id)}/properties`),
  saveProperties: (id: string, props: Record<string, string>) => api.put<void>(`${s(id)}/properties`, props),

  // Files
  files: async (id: string, path: string) => asList<FileEntry>(await api.get(`${s(id)}/files`, { path }), 'entries', 'files'),
  fileContent: async (id: string, path: string) => {
    const r = await api.get<unknown>(`${s(id)}/files/content`, { path });
    if (typeof r === 'string') return r;
    return String((r as { content?: string })?.content ?? '');
  },
  saveFile: (id: string, path: string, content: string) => api.put<void>(`${s(id)}/files/content`, { path, content }),
  upload: (id: string, path: string, files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    return api.upload<void>(`${s(id)}/files/upload`, fd, { path });
  },
  downloadUrl: (id: string, path: string) => downloadUrl(`${s(id)}/files/download`, { path }),
  mkdir: (id: string, path: string) => api.post<void>(`${s(id)}/files/mkdir`, { path }),
  rename: (id: string, from: string, to: string) => api.post<void>(`${s(id)}/files/rename`, { from, to }),
  deleteFile: (id: string, path: string) => api.del<void>(`${s(id)}/files`, { path }),

  // Backups
  backups: async (id: string) => asList<Backup>(await api.get(`${s(id)}/backups`), 'backups'),
  createBackup: (id: string, note?: string) => api.post<Backup>(`${s(id)}/backups`, { note }),
  restoreBackup: (id: string, bid: string) => api.post<void>(`${s(id)}/backups/${bid}/restore`),
  backupDownloadUrl: (id: string, bid: string) => downloadUrl(`${s(id)}/backups/${bid}/download`),
  deleteBackup: (id: string, bid: string) => api.del<void>(`${s(id)}/backups/${bid}`),

  // Schedules
  schedules: async (id: string) => asList<RawSchedule>(await api.get(`${s(id)}/schedules`), 'schedules').map(fromRawSchedule),
  createSchedule: async (id: string, body: Omit<Schedule, 'id' | 'lastRunAt' | 'serverId'>) =>
    fromRawSchedule(await api.post<RawSchedule>(`${s(id)}/schedules`, toRawSchedule(body))),
  updateSchedule: async (sid: string, body: Partial<Schedule>) =>
    fromRawSchedule(await api.patch<RawSchedule>(`/schedules/${sid}`, toRawSchedule(body))),
  deleteSchedule: (sid: string) => api.del<void>(`/schedules/${sid}`),

  // Webhooks
  webhooks: async (id: string) => asList<Webhook>(await api.get(`${s(id)}/webhooks`), 'webhooks'),
  createWebhook: (id: string, body: Omit<Webhook, 'id' | 'serverId'>) => api.post<Webhook>(`${s(id)}/webhooks`, body),
  updateWebhook: (wid: string, body: Partial<Webhook>) => api.patch<Webhook>(`/webhooks/${wid}`, body),
  deleteWebhook: (wid: string) => api.del<void>(`/webhooks/${wid}`),
  testWebhook: (wid: string) => api.post<void>(`/webhooks/${wid}/test`),

  // Shares
  shares: async (id: string) => asList<Share>(await api.get(`${s(id)}/shares`), 'shares'),
  share: (id: string, userId: string, level: ShareLevel) => api.post<void>(`${s(id)}/shares`, { userId, level }),
  unshare: (id: string, userId: string) => api.del<void>(`${s(id)}/shares/${userId}`),

  // Mods
  mods: async (id: string) =>
    asList<RawMod | string>(await api.get(`${s(id)}/mods`), 'mods').map(
      (m): InstalledMod =>
        typeof m === 'string'
          ? { file: m }
          : {
              file: m.file,
              enabled: m.enabled,
              size: m.size,
              name: m.meta?.name,
              source: m.meta?.source,
              projectId: m.meta?.projectId,
              version: m.meta?.versionNumber,
            },
    ),
  installMod: (id: string, source: CatalogSource, projectId: string, fileId?: string, replace?: string) =>
    api.post<{ installed?: { file: string }[]; skipped?: { projectId: string; reason: string }[] } | void>(`${s(id)}/mods/install`, {
      source,
      projectId,
      fileId,
      replace,
    }),
  deleteMod: (id: string, file: string) => api.del<void>(`${s(id)}/mods/${encodeURIComponent(file)}`),
  modUpdates: async (id: string) =>
    asList<RawUpdate>(await api.get(`${s(id)}/mods/updates`), 'updates').map(
      (u): ModUpdate => ({
        file: u.file,
        name: u.name,
        source: u.source,
        projectId: u.projectId,
        currentVersion: u.currentVersion ?? undefined,
        latestVersion: u.latest?.versionNumber,
        fileId: u.latest?.id,
      }),
    ),

  // Clone / templates / export / import
  clone: (id: string, name: string) => api.post<Server>(`${s(id)}/clone`, { name }),
  saveTemplate: (id: string, body: { name: string; description?: string; shared?: boolean }) =>
    api.post<Template>(`${s(id)}/template`, body),
  exportUrl: (id: string, format: ExportFormat) => downloadUrl(`${s(id)}/export`, { format }),
  import: (file: File, fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('file', file, file.name);
    return api.upload<{ server: Server }>('/servers/import', fd).then((r) => r.server);
  },
};

export const templatesApi = {
  list: async () => asList<Template>(await api.get('/templates'), 'templates'),
  instantiate: (id: string, body: { name: string } & Record<string, unknown>) =>
    api.post<Server>(`/templates/${id}/instantiate`, body),
  remove: (id: string) => api.del<void>(`/templates/${id}`),
};
