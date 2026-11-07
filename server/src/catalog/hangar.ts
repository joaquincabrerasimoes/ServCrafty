import { AppError } from '../lib/errors.js';
import { fetchJson, TtlCache } from '../lib/http.js';
import type { CatalogHit, CatalogKind, CatalogProject, CatalogSearchResult, CatalogVersion } from './types.js';

export const API = 'https://hangar.papermc.io/api/v1';
const cache = new TtlCache<unknown>(5 * 60_000);

/** Hangar hosts plugins only; every Bukkit-family server (Paper, Purpur, Folia) uses its PAPER platform. */
export const HANGAR_PLATFORM = 'PAPER';

interface HgProject {
  id: number;
  name: string;
  namespace: { owner: string; slug: string };
  stats: { views: number; downloads: number; stars: number; watchers: number };
  category: string;
  description: string;
  lastUpdated: string;
  avatarUrl?: string | null;
  settings?: {
    tags?: string[];
    links?: { links?: { name: string; url: string }[] }[];
  };
  supportedPlatforms?: Record<string, string[]>;
  mainPageContent?: string;
}

interface HgPlatformDownload {
  fileInfo?: { name: string; sizeBytes: number; sha256Hash: string } | null;
  externalUrl?: string | null;
  downloadUrl?: string | null;
}

export interface HgVersion {
  name: string;
  createdAt: string;
  projectId?: number;
  stats?: { totalDownloads?: number };
  channel?: { name?: string };
  downloads?: Record<string, HgPlatformDownload | undefined>;
  pluginDependencies?: Record<string, { name: string; projectId?: number | null; required: boolean; externalUrl?: string | null }[] | undefined>;
  platformDependencies?: Record<string, string[] | undefined>;
}

interface HgList<T> {
  pagination: { count: number; limit: number; offset: number };
  result: T[];
}

const enc = encodeURIComponent;
const getJson = <T>(url: string): Promise<T> => cache.get(url, () => fetchJson<T>(url)) as Promise<T>;

function hit(p: HgProject): CatalogHit {
  const platforms = p.supportedPlatforms ?? {};
  return {
    source: 'hangar',
    id: p.namespace.slug,
    slug: p.namespace.slug,
    name: p.name,
    summary: p.description,
    author: p.namespace.owner,
    iconUrl: p.avatarUrl || null,
    downloads: p.stats.downloads,
    categories: [p.category, ...(p.settings?.tags ?? [])].filter(Boolean).map((c) => c.toLowerCase().replace(/_/g, ' ')),
    gameVersions: [...(platforms[HANGAR_PLATFORM] ?? [])].reverse().slice(0, 10),
    loaders: Object.keys(platforms).map((k) => k.toLowerCase()),
    updatedAt: p.lastUpdated,
    url: `https://hangar.papermc.io/${enc(p.namespace.owner)}/${enc(p.namespace.slug)}`,
  };
}

export async function search(opts: {
  q: string;
  kind: CatalogKind;
  mcVersion?: string;
  offset: number;
  limit: number;
}): Promise<CatalogSearchResult> {
  // Hangar only has plugins.
  if (opts.kind !== 'plugin') return { hits: [], total: 0, offset: opts.offset, limit: opts.limit };
  const p = new URLSearchParams({
    platform: HANGAR_PLATFORM,
    limit: String(Math.min(opts.limit, 25)),
    offset: String(opts.offset),
    sort: opts.q ? '-stars' : '-downloads',
  });
  if (opts.q) p.set('q', opts.q);
  if (opts.mcVersion) p.set('version', opts.mcVersion);
  const r = await getJson<HgList<HgProject>>(`${API}/projects?${p.toString()}`);
  return { hits: r.result.map(hit), total: r.pagination.count, offset: opts.offset, limit: opts.limit };
}

export async function getHgProject(idOrSlug: string): Promise<HgProject> {
  return getJson<HgProject>(`${API}/projects/${enc(idOrSlug)}`);
}

export async function getProject(id: string): Promise<CatalogProject> {
  const p = await getHgProject(id);
  const links: Record<string, string> = {};
  for (const group of p.settings?.links ?? [])
    for (const l of group.links ?? []) if (l.name && l.url) links[l.name.toLowerCase()] = l.url;
  return { ...hit(p), description: p.mainPageContent ?? p.description, kind: 'plugin', links };
}

function releaseTypeOf(channel: string | undefined): CatalogVersion['releaseType'] {
  const c = (channel ?? '').toLowerCase();
  if (c === 'release' || c === 'stable') return 'release';
  if (c === 'alpha' || c === 'dev' || c === 'snapshot') return 'alpha';
  return 'beta';
}

export function toCatalogVersion(v: HgVersion, projectId: string): CatalogVersion {
  const d = v.downloads?.[HANGAR_PLATFORM];
  return {
    source: 'hangar',
    id: v.name,
    projectId,
    name: v.name,
    versionNumber: v.name,
    gameVersions: [...(v.platformDependencies?.[HANGAR_PLATFORM] ?? [])].reverse(),
    loaders: ['paper'],
    releaseType: releaseTypeOf(v.channel?.name),
    datePublished: v.createdAt,
    downloads: v.stats?.totalDownloads ?? 0,
    files: d?.fileInfo
      ? [{ fileName: d.fileInfo.name, url: d.downloadUrl ?? null, size: d.fileInfo.sizeBytes, hashes: { sha256: d.fileInfo.sha256Hash }, primary: true }]
      : [],
  };
}

export async function getHgVersions(id: string, mcVersion?: string): Promise<HgVersion[]> {
  const p = new URLSearchParams({ platform: HANGAR_PLATFORM, limit: '25', offset: '0' });
  if (mcVersion) p.set('platformVersion', mcVersion);
  return (await getJson<HgList<HgVersion>>(`${API}/projects/${enc(id)}/versions?${p.toString()}`)).result;
}

export async function getVersions(id: string, mcVersion?: string): Promise<CatalogVersion[]> {
  return (await getHgVersions(id, mcVersion)).map((v) => toCatalogVersion(v, id));
}

export async function getHgVersion(id: string, version: string): Promise<HgVersion> {
  return getJson<HgVersion>(`${API}/projects/${enc(id)}/versions/${enc(version)}`);
}

/** Direct download URL and metadata for the PAPER file of a version. */
export function requireDownload(v: HgVersion, projectName: string): { url: string; fileName: string; sha256?: string } {
  const d = v.downloads?.[HANGAR_PLATFORM];
  if (!d?.fileInfo && !d?.externalUrl) throw new AppError(404, 'no_files', `${projectName} ${v.name} has no Paper download`);
  if (!d.downloadUrl || !d.fileInfo) {
    throw new AppError(
      409,
      'hangar_external_download',
      `${projectName} ${v.name} is hosted outside Hangar${d.externalUrl ? ` (${d.externalUrl})` : ''}; download it manually and upload the file`,
    );
  }
  return { url: d.downloadUrl, fileName: d.fileInfo.name, sha256: d.fileInfo.sha256Hash };
}
