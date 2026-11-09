import { api, asList } from './client';
import type { CatalogProject, CatalogSource, CatalogVersion, ServerType } from './types';

type Raw = Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
const strArr = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);

/** Normalise a project coming from either the CurseForge or Modrinth proxy. */
export function normalizeProject(r: Raw, source: CatalogSource): CatalogProject {
  const logo = r.logo as Raw | undefined;
  const authors = r.authors as Raw[] | undefined;
  return {
    id: str(r.id ?? r.projectId ?? r.project_id) ?? '',
    source: (r.source as CatalogSource) ?? source,
    slug: str(r.slug),
    name: str(r.name ?? r.title) ?? 'Untitled',
    summary: str(r.summary ?? r.description),
    author: str(r.author ?? authors?.[0]?.name),
    iconUrl: str(r.iconUrl ?? r.icon_url ?? r.icon ?? logo?.thumbnailUrl ?? logo?.url),
    downloads: Number(r.downloads ?? r.downloadCount ?? 0) || undefined,
    mcVersions: strArr(r.mcVersions ?? r.gameVersions ?? r.versions),
    loaders: strArr(r.loaders ?? r.categories),
  };
}

function normalizeVersion(r: Raw): CatalogVersion {
  return {
    id: str(r.id ?? r.fileId ?? r.versionId) ?? '',
    name: str(r.name ?? r.displayName ?? r.version_number ?? r.versionNumber ?? r.fileName) ?? '',
    mcVersions: strArr(r.mcVersions ?? r.gameVersions ?? r.game_versions),
    loaders: strArr(r.loaders),
    date: str(r.date ?? r.fileDate ?? r.date_published ?? r.datePublished),
  };
}

export interface CatalogSearch {
  source: CatalogSource;
  q: string;
  kind: 'modpack' | 'mod' | 'plugin';
  mcVersion?: string;
  loader?: string;
  offset?: number;
}

export const catalogApi = {
  search: async (p: CatalogSearch, signal?: AbortSignal) => {
    const r = await api.get<unknown>('/catalog/search', { ...p }, signal);
    const items = asList<Raw>(r, 'projects').map((x) => normalizeProject(x, p.source));
    const total = Number((r as Raw)?.total ?? (r as Raw)?.total_hits ?? items.length);
    return { items, total };
  },
  project: async (source: CatalogSource, id: string) =>
    normalizeProject(await api.get<Raw>(`/catalog/project/${source}/${encodeURIComponent(id)}`), source),
  versions: async (source: CatalogSource, id: string, mcVersion?: string, loader?: string) =>
    asList<Raw>(
      await api.get(`/catalog/project/${source}/${encodeURIComponent(id)}/versions`, { mcVersion, loader }),
      'versions',
      'files',
    ).map(normalizeVersion),
  minecraftVersions: async (type: ServerType) => {
    const r = await api.get<unknown>('/catalog/minecraft/versions', { type });
    return asList<unknown>(r, 'versions').map((v) =>
      typeof v === 'string' ? v : String((v as Raw).id ?? (v as Raw).version ?? (v as Raw).name),
    );
  },
  /** Loader builds (Fabric/Quilt/Forge/NeoForge) for one Minecraft version, newest first. */
  loaderVersions: async (type: ServerType, mcVersion: string) => {
    const r = await api.get<unknown>('/catalog/minecraft/loaders', { type, mcVersion });
    return asList<unknown>(r, 'versions').map((v) => (typeof v === 'string' ? v : String((v as Raw).version ?? (v as Raw).id)));
  },
};
