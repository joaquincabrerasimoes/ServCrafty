import { AppError } from '../lib/errors.js';
import { fetchJson, TtlCache } from '../lib/http.js';
import { getCurseforgeKey } from '../services/settings.js';
import type { CatalogHit, CatalogKind, CatalogProject, CatalogSearchResult, CatalogVersion } from './types.js';

const API = 'https://api.curseforge.com/v1';
export const MINECRAFT_GAME_ID = 432;
const CLASS_IDS: Record<CatalogKind, number> = { modpack: 4471, mod: 6, plugin: 5 };
const LOADER_IDS: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const LOADER_NAMES: Record<number, string> = { 1: 'forge', 4: 'fabric', 5: 'quilt', 6: 'neoforge' };
const cache = new TtlCache<unknown>(5 * 60_000);

export interface CfFile {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  releaseType: 1 | 2 | 3;
  fileDate: string;
  downloadCount: number;
  downloadUrl: string | null;
  fileLength: number;
  hashes: { value: string; algo: 1 | 2 }[];
  gameVersions: string[];
  serverPackFileId?: number | null;
  fileFingerprint?: number;
}

export interface CfMod {
  id: number;
  slug: string;
  name: string;
  summary: string;
  downloadCount: number;
  logo?: { thumbnailUrl?: string; url?: string } | null;
  authors: { name: string }[];
  categories: { name: string }[];
  latestFilesIndexes: { gameVersion: string; fileId: number; modLoader?: number | null; releaseType: number }[];
  latestFiles?: CfFile[];
  dateModified: string;
  links?: { websiteUrl?: string; sourceUrl?: string | null; issuesUrl?: string | null; wikiUrl?: string | null };
  classId?: number;
}

async function headers(): Promise<Record<string, string>> {
  const key = await getCurseforgeKey();
  if (!key) throw new AppError(503, 'curseforge_key_missing', 'CurseForge API key is not configured (Admin > Settings)');
  return { 'x-api-key': key };
}

export async function cfGet<T>(pathAndQuery: string, useCache = true): Promise<T> {
  const h = await headers();
  const url = `${API}${pathAndQuery}`;
  const load = () => fetchJson<T>(url, { headers: h });
  return useCache ? ((await cache.get(url, load)) as T) : load();
}

export async function cfPost<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(`${API}${path}`, { headers: await headers(), body });
}

function hit(m: CfMod): CatalogHit {
  const versions = [...new Set(m.latestFilesIndexes.map((i) => i.gameVersion))];
  const loaders = [
    ...new Set(m.latestFilesIndexes.map((i) => (i.modLoader ? LOADER_NAMES[i.modLoader] : undefined)).filter((x): x is string => !!x)),
  ];
  return {
    source: 'curseforge',
    id: String(m.id),
    slug: m.slug,
    name: m.name,
    summary: m.summary,
    author: m.authors[0]?.name ?? null,
    iconUrl: m.logo?.thumbnailUrl || m.logo?.url || null,
    downloads: m.downloadCount,
    categories: m.categories.map((c) => c.name),
    gameVersions: versions,
    loaders,
    updatedAt: m.dateModified,
    url: m.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/${m.slug}`,
  };
}

export async function search(opts: {
  q: string;
  kind: CatalogKind;
  mcVersion?: string;
  loader?: string;
  offset: number;
  limit: number;
}): Promise<CatalogSearchResult> {
  const p = new URLSearchParams({
    gameId: String(MINECRAFT_GAME_ID),
    classId: String(CLASS_IDS[opts.kind]),
    index: String(Math.min(opts.offset, 9950)),
    pageSize: String(Math.min(opts.limit, 50)),
    sortField: opts.q ? '1' : '2', // 1 = featured/relevance, 2 = popularity
    sortOrder: 'desc',
  });
  if (opts.q) p.set('searchFilter', opts.q);
  if (opts.mcVersion) p.set('gameVersion', opts.mcVersion);
  const loaderId = opts.loader ? LOADER_IDS[opts.loader.toLowerCase()] : undefined;
  if (loaderId && opts.kind !== 'plugin') p.set('modLoaderType', String(loaderId));
  const r = await cfGet<{ data: CfMod[]; pagination: { totalCount: number } }>(`/mods/search?${p.toString()}`);
  return { hits: r.data.map(hit), total: r.pagination.totalCount, offset: opts.offset, limit: opts.limit };
}

export async function getMod(id: string | number): Promise<CfMod> {
  return (await cfGet<{ data: CfMod }>(`/mods/${encodeURIComponent(String(id))}`)).data;
}

export async function getProject(id: string): Promise<CatalogProject> {
  const m = await getMod(id);
  const desc = await cfGet<{ data: string }>(`/mods/${m.id}/description`).catch(() => ({ data: '' }));
  const kind = (Object.entries(CLASS_IDS).find(([, v]) => v === m.classId)?.[0] ?? null) as CatalogKind | null;
  const links: Record<string, string> = {};
  if (m.links?.websiteUrl) links.website = m.links.websiteUrl;
  if (m.links?.sourceUrl) links.source = m.links.sourceUrl;
  if (m.links?.issuesUrl) links.issues = m.links.issuesUrl;
  if (m.links?.wikiUrl) links.wiki = m.links.wikiUrl;
  return { ...hit(m), description: desc.data, kind, links };
}

const MC_VERSION_RE = /^\d+\.\d+(\.\d+)?$/;

export function toCatalogVersion(f: CfFile): CatalogVersion {
  const loaders = f.gameVersions.map((g) => g.toLowerCase()).filter((g) => ['forge', 'fabric', 'quilt', 'neoforge'].includes(g));
  return {
    source: 'curseforge',
    id: String(f.id),
    projectId: String(f.modId),
    name: f.displayName,
    versionNumber: f.displayName,
    gameVersions: f.gameVersions.filter((g) => MC_VERSION_RE.test(g)),
    loaders,
    releaseType: f.releaseType === 1 ? 'release' : f.releaseType === 2 ? 'beta' : 'alpha',
    datePublished: f.fileDate,
    downloads: f.downloadCount,
    files: [
      {
        fileName: f.fileName,
        url: f.downloadUrl,
        size: f.fileLength,
        hashes: { sha1: f.hashes.find((h) => h.algo === 1)?.value },
        primary: true,
      },
    ],
    serverPackFileId: f.serverPackFileId ? String(f.serverPackFileId) : null,
  };
}

export async function getFiles(id: string, mcVersion?: string, loader?: string): Promise<CfFile[]> {
  const p = new URLSearchParams({ pageSize: '50' });
  if (mcVersion) p.set('gameVersion', mcVersion);
  const lid = loader ? LOADER_IDS[loader.toLowerCase()] : undefined;
  if (lid) p.set('modLoaderType', String(lid));
  return (await cfGet<{ data: CfFile[] }>(`/mods/${encodeURIComponent(id)}/files?${p.toString()}`)).data;
}

export async function getVersions(id: string, mcVersion?: string, loader?: string): Promise<CatalogVersion[]> {
  return (await getFiles(id, mcVersion, loader)).map(toCatalogVersion);
}

export async function getFile(modId: string | number, fileId: string | number): Promise<CfFile> {
  return (await cfGet<{ data: CfFile }>(`/mods/${modId}/files/${fileId}`)).data;
}

export async function getModsBulk(ids: number[]): Promise<CfMod[]> {
  if (!ids.length) return [];
  return (await cfPost<{ data: CfMod[] }>('/mods', { modIds: ids })).data;
}

/** Exact fingerprint matches: fingerprint -> { modId, file }. */
export async function matchFingerprints(fps: number[]): Promise<Map<number, { modId: number; file: CfFile; latestFiles: CfFile[] }>> {
  const out = new Map<number, { modId: number; file: CfFile; latestFiles: CfFile[] }>();
  if (!fps.length) return out;
  const r = await cfPost<{ data: { exactMatches: { id: number; file: CfFile; latestFiles: CfFile[] }[] } }>(
    `/fingerprints/${MINECRAFT_GAME_ID}`,
    { fingerprints: fps },
  );
  for (const m of r.data.exactMatches) {
    const fp = m.file.fileFingerprint;
    if (fp !== undefined) out.set(fp, { modId: m.id, file: m.file, latestFiles: m.latestFiles });
  }
  return out;
}

export function loaderIdFor(loader: string | null | undefined): number | undefined {
  return loader ? LOADER_IDS[loader.toLowerCase()] : undefined;
}

export function requireDownloadUrl(f: CfFile): string {
  if (!f.downloadUrl) {
    throw new AppError(
      409,
      'curseforge_download_restricted',
      `The author of "${f.displayName}" disabled third-party downloads; download it manually and upload the file`,
    );
  }
  return f.downloadUrl;
}
