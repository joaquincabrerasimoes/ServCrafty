import { api } from './client';

/** Self-update contract (SPEC.md, "Self-update feature (v0.2)"). Admin only. */

export type InstallType = 'lxc' | 'docker' | 'source';
export type UpdateState = 'idle' | 'running' | 'succeeded' | 'failed' | 'rolled_back';

export interface UpdateRelease {
  version: string;
  tag: string;
  name: string;
  /** Markdown. Untrusted: render through the safe Markdown component only. */
  notes: string;
  url: string;
  publishedAt: string;
  commitSha: string;
  verified: boolean;
}

export interface UpdateStatus {
  state: UpdateState;
  step: string | null;
  fromVersion: string | null;
  targetVersion: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
}

export interface UpdateInfo {
  currentVersion: string;
  commit: string | null;
  installType: InstallType;
  canUpdate: boolean;
  cannotUpdateReason: string | null;
  checkedAt: string | null;
  checkError: string | null;
  updateAvailable: boolean;
  latest: UpdateRelease | null;
  dockerCommand: string | null;
  runningServers: number;
  status: UpdateStatus;
  rollbackAvailable: boolean;
  previousVersion: string | null;
}

export interface UpdateLogChunk {
  text: string;
  offset: number;
  state: UpdateState;
}

export interface ApplyUpdateBody {
  version?: string;
}

export interface HealthInfo {
  ok: boolean;
  db?: boolean;
  docker?: boolean;
  version?: string;
}

export const updateApi = {
  get: (signal?: AbortSignal) => api.get<UpdateInfo>('/admin/update', undefined, signal),
  check: () => api.post<UpdateInfo>('/admin/update/check'),
  apply: (body: ApplyUpdateBody = {}) => api.post<UpdateInfo>('/admin/update/apply', body),
  rollback: () => api.post<UpdateInfo>('/admin/update/rollback'),
  log: (offset: number, signal?: AbortSignal) => api.get<UpdateLogChunk>('/admin/update/log', { offset }, signal),
};

export const healthApi = {
  get: (signal?: AbortSignal) => api.get<HealthInfo>('/health', undefined, signal),
};
