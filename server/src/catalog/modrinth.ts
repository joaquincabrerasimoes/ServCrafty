import { fetchJson, TtlCache } from '../lib/http.js';
import type { CatalogHit, CatalogKind, CatalogProject, CatalogSearchResult, CatalogVersion } from './types.js';

const API = 'https://api.modrinth.com/v2';
const cache = new TtlCache<unknown>(5 * 60_000);

interface MrSearchHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  icon_url: string | null;
  downloads: number;
  categories: string[];
  versions: string[];
  date_modified: string;
  project_type: string;
}

interface MrProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  icon_url: string | null;
  downloads: number;
  categories: string[];
  loaders: string[];
  game_versions: string[];
  updated: string;
  project_type: string;
  source_url?: string | null;
  issues_url?: string | null;
  wiki_url?: string | null;
  discord_url?: string | null;
  team: string;
}

export interface MrVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  version_type: 'release' | 'beta' | 'alpha';
  date_published: string;
  downloads: number;
  files: { url: string; filename: string; primary: boolean; size: number; hashes: { sha1: string; sha512: string } }[];
  dependencies?: { project_id: string | null; version_id: string | null; dependency_type: string }[];
}

const PLUGIN_LOADERS = ['paper', 'purpur', 'folia', 'spigot', 'bukkit'];

function kindOf(t: string, loaders: string[] = []): CatalogKind | null {
  if (t === 'modpack') return 'modpack';
  if (t === 'plugin') return 'plugin';
  if (t === 'mod') return loaders.length && loaders.every((l) => PLUGIN_LOADERS.includes(l)) ? 'plugin' : 'mod';
  return null;
}

export async function search(opts: {
  q: string;
  kind: CatalogKind;
  mcVersion?: string;
  loader?: string;
  offset: number;
  limit: number;
}): Promise<CatalogSearchResult> {
  // Modrinth indexes most plugins with project_type "mod"; plugins are told apart by loader category.
  const facets: string[][] =
    opts.kind === 'plugin' ? [['project_type:plugin', 'project_type:mod']] : [[`project_type:${opts.kind}`]];
  if (opts.kind === 'plugin' && !opts.loader) facets.push(PLUGIN_LOADERS.map((l) => `categories:${l}`));
  if (opts.mcVersion) facets.push([`versions:${opts.mcVersion}`]);
  if (opts.loader) facets.push([`categories:${opts.loader.toLowerCase()}`]);
  if (opts.kind !== 'modpack') facets.push(['server_side:required', 'server_side:optional']);
  const url = `${API}/search?query=${encodeURIComponent(opts.q)}&facets=${encodeURIComponent(JSON.stringify(facets))}&offset=${opts.offset}&limit=${opts.limit}&index=${opts.q ? 'relevance' : 'downloads'}`;
  const r = (await cache.get(url, () => fetchJson(url))) as { hits: MrSearchHit[]; total_hits: number };
  return {
    hits: r.hits.map(
      (h): CatalogHit => ({
        source: 'modrinth',
        id: h.project_id,
        slug: h.slug,
        name: h.title,
        summary: h.description,
        author: h.author,
        iconUrl: h.icon_url || null,
        downloads: h.downloads,
        categories: h.categories,
        gameVersions: h.versions.slice(-10).reverse(),
        loaders: h.categories.filter((c) =>
          ['fabric', 'forge', 'neoforge', 'quilt', 'paper', 'purpur', 'folia', 'spigot', 'bukkit'].includes(c),
        ),
        updatedAt: h.date_modified,
        url: `https://modrinth.com/${h.project_type}/${h.slug}`,
      }),
    ),
    total: r.total_hits,
    offset: opts.offset,
    limit: opts.limit,
  };
}

export async function getProject(id: string): Promise<CatalogProject> {
  const url = `${API}/project/${encodeURIComponent(id)}`;
  const p = (await cache.get(url, () => fetchJson(url))) as MrProject;
  const links: Record<string, string> = {};
  if (p.source_url) links.source = p.source_url;
  if (p.issues_url) links.issues = p.issues_url;
  if (p.wiki_url) links.wiki = p.wiki_url;
  if (p.discord_url) links.discord = p.discord_url;
  return {
    source: 'modrinth',
    id: p.id,
    slug: p.slug,
    name: p.title,
    summary: p.description,
    description: p.body,
    author: null,
    iconUrl: p.icon_url || null,
    downloads: p.downloads,
    categories: p.categories,
    gameVersions: [...p.game_versions].reverse(),
    loaders: p.loaders,
    updatedAt: p.updated,
    url: `https://modrinth.com/${p.project_type}/${p.slug}`,
    kind: kindOf(p.project_type, p.loaders),
    links,
  };
}

export function toCatalogVersion(v: MrVersion): CatalogVersion {
  return {
    source: 'modrinth',
    id: v.id,
    projectId: v.project_id,
    name: v.name,
    versionNumber: v.version_number,
    gameVersions: v.game_versions,
    loaders: v.loaders,
    releaseType: v.version_type,
    datePublished: v.date_published,
    downloads: v.downloads,
    files: v.files.map((f) => ({
      fileName: f.filename,
      url: f.url,
      size: f.size,
      hashes: { sha1: f.hashes.sha1, sha512: f.hashes.sha512 },
      primary: f.primary,
    })),
  };
}

export async function getVersions(id: string, mcVersion?: string, loader?: string): Promise<CatalogVersion[]> {
  const params = new URLSearchParams();
  if (mcVersion) params.set('game_versions', JSON.stringify([mcVersion]));
  if (loader) params.set('loaders', JSON.stringify([loader.toLowerCase()]));
  const url = `${API}/project/${encodeURIComponent(id)}/version?${params.toString()}`;
  const vs = (await cache.get(url, () => fetchJson(url))) as MrVersion[];
  return vs.map(toCatalogVersion);
}

export async function getVersion(versionId: string): Promise<MrVersion> {
  return fetchJson<MrVersion>(`${API}/version/${encodeURIComponent(versionId)}`);
}

/** Map of hash -> version for files known to Modrinth. */
export async function versionsByHashes(hashes: string[], algorithm: 'sha1' | 'sha512'): Promise<Record<string, MrVersion>> {
  if (!hashes.length) return {};
  return fetchJson<Record<string, MrVersion>>(`${API}/version_files`, { body: { hashes, algorithm } });
}

/** Latest compatible version for each hash (Modrinth update check). */
export async function latestByHashes(
  hashes: string[],
  algorithm: 'sha1' | 'sha512',
  loaders: string[],
  gameVersions: string[],
): Promise<Record<string, MrVersion>> {
  if (!hashes.length) return {};
  return fetchJson<Record<string, MrVersion>>(`${API}/version_files/update`, {
    body: { hashes, algorithm, loaders, game_versions: gameVersions },
  });
}
