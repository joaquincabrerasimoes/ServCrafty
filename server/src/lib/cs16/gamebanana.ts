import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { USER_AGENT } from '../../config.js';
import { badRequest, notFound, upstream } from '../errors.js';
import { fetchJson, TtlCache } from '../http.js';

/**
 * The map catalogue of the Counter-Strike 1.6 tab: a small search API of the panel in front of GameBanana (Steam has no
 * Workshop for this game). The panel asks GameBanana's public API for the maps (game 4254, category "Maps"), trims the
 * answer to what the UI needs (name, thumbnail, author, counters, files) and, when asked, downloads a file from
 * GameBanana's own hosts. Nothing here takes a URL from the user: only numeric ids.
 */

const API = 'https://gamebanana.com/apiv11';
export const GAME_ID = 4254;
export const MAPS_CATEGORY = 5474;
/** Hosts a download may be served from (GameBanana redirects `/dl/<id>` to its file host). */
const DOWNLOAD_HOSTS = /^([a-z0-9-]+\.)*gamebanana\.com$/i;
const IMAGE_HOST = 'images.gamebanana.com';
export const MAX_DOWNLOAD_BYTES = 150 * 1024 ** 2;
export const PAGE_SIZE = 24;

export const SORTS = {
  popular: 'Generic_MostDownloaded',
  liked: 'Generic_MostLiked',
  viewed: 'Generic_MostViewed',
  newest: 'Generic_Newest',
  updated: 'Generic_LatestModified',
} as const;
export type CatalogSort = keyof typeof SORTS;

export interface CatalogMap {
  id: number;
  name: string;
  category: string | null;
  thumbnail: string | null;
  submitter: string | null;
  likes: number;
  views: number;
  addedAt: string | null;
  updatedAt: string | null;
  hasFiles: boolean;
  url: string;
}

export interface CatalogFile {
  id: number;
  name: string;
  size: number;
  md5: string | null;
  downloads: number;
  addedAt: string | null;
  /** GameBanana's own scan result is `clean`. */
  clean: boolean;
}

export interface CatalogMapDetail extends CatalogMap {
  description: string;
  downloads: number;
  screenshots: string[];
  files: CatalogFile[];
  version: string | null;
}

export interface CatalogPage {
  total: number;
  page: number;
  perPage: number;
  items: CatalogMap[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const iso = (v: unknown): string | null => (typeof v === 'number' && v > 0 ? new Date(v * 1000).toISOString() : null);

/** A thumbnail address: only https images of GameBanana's image host are passed on. */
export function imageUrl(base: unknown, file: unknown): string | null {
  const b = str(base);
  const f = str(file);
  if (!b || !f || /[/\\]/.test(f)) return null;
  try {
    const u = new URL(`${b.replace(/\/+$/, '')}/${f}`);
    return u.protocol === 'https:' && u.hostname === IMAGE_HOST ? u.toString() : null;
  } catch {
    return null;
  }
}

function previewImages(media: unknown): Json[] {
  const imgs = obj(media)._aImages;
  return Array.isArray(imgs) ? imgs.map(obj) : [];
}

const thumbOf = (img: Json | undefined): string | null => (img ? (imageUrl(img._sBaseUrl, img._sFile530) ?? imageUrl(img._sBaseUrl, img._sFile220) ?? imageUrl(img._sBaseUrl, img._sFile)) : null);

export function toCatalogMap(r: Json): CatalogMap {
  const id = num(r._idRow);
  const sub = obj(r._aSubCategory);
  const cat = obj(r._aCategory);
  return {
    id,
    name: str(r._sName) ?? `#${id}`,
    category: str(sub._sName) ?? str(cat._sName),
    thumbnail: thumbOf(previewImages(r._aPreviewMedia)[0]),
    submitter: str(obj(r._aSubmitter)._sName),
    likes: num(r._nLikeCount),
    views: num(r._nViewCount),
    addedAt: iso(r._tsDateAdded),
    updatedAt: iso(r._tsDateModified),
    hasFiles: r._bHasFiles === true,
    url: `https://gamebanana.com/mods/${id}`,
  };
}

/** GameBanana descriptions are HTML: keep the text only. */
export function plainText(html: unknown, max = 1500): string {
  const s = typeof html === 'string' ? html : '';
  return s
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, max);
}

export function toCatalogFile(f: Json): CatalogFile {
  return {
    id: num(f._idRow),
    name: str(f._sFile) ?? `file-${num(f._idRow)}`,
    size: num(f._nFilesize),
    md5: str(f._sMd5Checksum),
    downloads: num(f._nDownloadCount),
    addedAt: iso(f._tsDateAdded),
    clean: f._sAvResult === 'clean',
  };
}

export function toCatalogDetail(r: Json): CatalogMapDetail {
  const files = Array.isArray(r._aFiles) ? r._aFiles.map(obj).filter((f) => f._bIsArchived !== true).map(toCatalogFile) : [];
  return {
    ...toCatalogMap({ ...r, _bHasFiles: files.length > 0 }),
    description: plainText(r._sText),
    downloads: num(r._nDownloadCount),
    screenshots: previewImages(r._aPreviewMedia)
      .map((i) => imageUrl(i._sBaseUrl, i._sFile530) ?? imageUrl(i._sBaseUrl, i._sFile))
      .filter((u): u is string => !!u)
      .slice(0, 8),
    files,
    version: str(r._sVersion),
  };
}

// ---------------------------------------------------------------------------------------------
// Queries

export interface SearchOptions {
  q?: string;
  page?: number;
  sort?: CatalogSort;
  /** A subcategory id of "Maps" (Bomb/Defuse, Aim Training, ...). */
  category?: number;
}

export interface Category {
  id: number;
  name: string;
  count: number;
}

const cache = new TtlCache<unknown>(5 * 60_000);
const categoryCache = new TtlCache<Category[]>(12 * 3600_000);

export function searchUrl(o: SearchOptions): string {
  const page = Number.isInteger(o.page) && o.page! >= 1 && o.page! <= 1000 ? o.page! : 1;
  const sort = SORTS[o.sort ?? 'popular'];
  if (!sort) throw badRequest('Unknown sort', 'invalid_sort');
  const p = new URLSearchParams();
  p.set('_nPage', String(page));
  p.set('_nPerpage', String(PAGE_SIZE));
  p.set('_aFilters[Generic_Game]', String(GAME_ID));
  p.set('_aFilters[Generic_Category]', String(o.category ?? MAPS_CATEGORY));
  const q = (o.q ?? '').replace(/[\u0000-\u001f,]/g, ' ').trim().slice(0, 60);
  if (q) p.set('_aFilters[Generic_Name]', `contains,${q}`);
  p.set('_sSort', sort);
  return `${API}/Mod/Index?${p.toString()}`;
}

export async function searchMaps(o: SearchOptions): Promise<CatalogPage> {
  const url = searchUrl(o);
  const r = obj(await cache.get(url, () => fetchJson<unknown>(url)));
  if (typeof r._sErrorCode === 'string') throw upstream('GameBanana did not accept the search');
  const meta = obj(r._aMetadata);
  const records = Array.isArray(r._aRecords) ? r._aRecords.map(obj) : [];
  return {
    total: num(meta._nRecordCount),
    page: o.page && o.page >= 1 ? o.page : 1,
    perPage: PAGE_SIZE,
    items: records.map(toCatalogMap),
  };
}

export async function mapCategories(): Promise<Category[]> {
  return categoryCache.get('maps', async () => {
    const r = await fetchJson<unknown>(`${API}/Mod/Categories?_idCategoryRow=${MAPS_CATEGORY}&_sSort=a_to_z&_bShowEmpty=false`);
    return (Array.isArray(r) ? r.map(obj) : [])
      .map((c) => ({ id: num(c._idRow), name: str(c._sName) ?? '', count: num(c._nItemCount) }))
      .filter((c) => c.id > 0 && c.name)
      .sort((a, b) => b.count - a.count);
  });
}

const DETAIL_PROPS = '_sName,_aFiles,_aPreviewMedia,_nDownloadCount,_nViewCount,_nLikeCount,_sText,_aCategory,_aSuperCategory,_aGame,_aSubmitter,_tsDateAdded,_tsDateModified,_sVersion,_bIsPrivate,_bIsWithheld,_bIsTrashed';

export function assertGbId(id: unknown): number {
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 1e9) throw badRequest('Invalid map id', 'invalid_map_id');
  return id;
}

/** One map of the catalogue. 404 when it does not exist, 400 when it is not a Counter-Strike 1.6 map. */
export async function getMap(id: number): Promise<CatalogMapDetail> {
  assertGbId(id);
  const url = `${API}/Mod/${id}?_csvProperties=${DETAIL_PROPS}`;
  const r = obj(await cache.get(url, () => fetchJson<unknown>(url)));
  if (typeof r._sErrorCode === 'string' || r._bIsPrivate === true || r._bIsWithheld === true || r._bIsTrashed === true) throw notFound('That map does not exist');
  if (num(obj(r._aGame)._idRow) !== GAME_ID || num(obj(r._aSuperCategory)._idRow) !== MAPS_CATEGORY) throw badRequest('That is not a Counter-Strike 1.6 map', 'not_a_map');
  const d = toCatalogDetail(r);
  return { ...d, id };
}

// ---------------------------------------------------------------------------------------------
// Download

export const downloadUrl = (fileId: number): string => `https://gamebanana.com/dl/${assertGbId(fileId)}`;

/** Download a GameBanana file, following redirects only inside gamebanana.com, and verify its MD5 when known. */
export async function downloadFileTo(fileId: number, dest: string, md5: string | null, fetchFn: typeof fetch = fetch): Promise<number> {
  let url = downloadUrl(fileId);
  let res: Response | null = null;
  for (let hop = 0; hop < 5; hop++) {
    const r = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual', signal: AbortSignal.timeout(5 * 60_000) }).catch((err: unknown) => {
      throw upstream(`Download failed: ${(err as Error).message}`);
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      await r.body?.cancel().catch(() => undefined);
      if (!loc) throw upstream('Download failed: bad redirect');
      const next = new URL(loc, url);
      if (next.protocol !== 'https:' || !DOWNLOAD_HOSTS.test(next.hostname)) throw upstream('Download failed: unexpected download host');
      url = next.toString();
      continue;
    }
    res = r;
    break;
  }
  if (!res) throw upstream('Download failed: too many redirects');
  if (!res.ok || !res.body) throw upstream(`Download failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw badRequest('The file is too large', 'archive_too_large');
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const hash = crypto.createHash('md5');
  let bytes = 0;
  const src = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  src.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    hash.update(chunk);
    if (bytes > MAX_DOWNLOAD_BYTES) src.destroy(badRequest('The file is too large', 'archive_too_large'));
  });
  await pipeline(src, fs.createWriteStream(dest));
  if (md5 && hash.digest('hex').toLowerCase() !== md5.toLowerCase()) {
    await fsp.rm(dest, { force: true });
    throw upstream('The downloaded file does not match its checksum');
  }
  return bytes;
}
