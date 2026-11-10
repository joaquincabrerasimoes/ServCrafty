import { USER_AGENT } from '../config.js';
import { AppError, badRequest, upstream } from './errors.js';
import { WORKSHOP_ID_RE } from './steamPlan.js';

/**
 * Steam Workshop lookups. Search (`IPublishedFileService/QueryFiles`) needs the admin's Steam Web
 * API key; item details (`ISteamRemoteStorage/GetPublishedFileDetails`) are keyless.
 * The key travels only as a query parameter to api.steampowered.com and is never logged or echoed.
 */

const API = 'https://api.steampowered.com';
const WORKSHOP_HOSTS = new Set(['steamcommunity.com', 'www.steamcommunity.com']);

/**
 * Accept a bare Workshop id or a steamcommunity.com Workshop/filedetails URL; returns the id or null.
 */
export function parseWorkshopRef(input: string): string | null {
  const s = input.trim();
  if (WORKSHOP_ID_RE.test(s)) return s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!WORKSHOP_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (!/^\/(sharedfiles|workshop)\/filedetails\/?$/i.test(url.pathname)) return null;
  const id = url.searchParams.get('id');
  return id && WORKSHOP_ID_RE.test(id) ? id : null;
}

export interface WorkshopItem {
  id: string;
  title: string;
  summary: string;
  previewUrl: string | null;
  author: string | null;
  subscribers: number;
  sizeBytes: number;
  updatedAt: string | null;
  /** App the item belongs to (`consumer_app_id`). */
  appId: number | null;
}

interface RawDetails {
  publishedfileid?: string;
  result?: number;
  title?: string;
  description?: string;
  short_description?: string;
  file_description?: string;
  preview_url?: string;
  creator?: string;
  subscriptions?: number | string;
  lifetime_subscriptions?: number | string;
  file_size?: number | string;
  time_updated?: number;
  consumer_app_id?: number;
  consumer_appid?: number;
  banned?: boolean | number;
}

function cut(s: unknown, n: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, n) : '';
}

function safeUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Normalize one raw details object (QueryFiles or GetPublishedFileDetails). */
export function toWorkshopItem(d: RawDetails): WorkshopItem | null {
  const id = String(d.publishedfileid ?? '');
  if (!WORKSHOP_ID_RE.test(id)) return null;
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const appId = d.consumer_app_id ?? d.consumer_appid;
  return {
    id,
    title: cut(d.title, 200) || id,
    summary: cut(d.short_description ?? d.file_description ?? d.description, 500),
    previewUrl: safeUrl(d.preview_url),
    author: typeof d.creator === 'string' && /^\d{1,20}$/.test(d.creator) ? d.creator : null,
    subscribers: num(d.subscriptions ?? d.lifetime_subscriptions),
    sizeBytes: num(d.file_size),
    updatedAt: typeof d.time_updated === 'number' && d.time_updated > 0 ? new Date(d.time_updated * 1000).toISOString() : null,
    appId: typeof appId === 'number' ? appId : null,
  };
}

async function steamFetch(url: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw upstream(`Steam API request failed: ${(err as Error).name === 'TimeoutError' ? 'timeout' : 'network error'}`, 'steam_api_error');
  }
  if (res.status === 401 || res.status === 403) throw new AppError(400, 'steam_key_invalid', 'The Steam Web API key was rejected');
  if (!res.ok) throw upstream(`Steam API responded ${res.status}`, 'steam_api_error');
  try {
    return await res.json();
  } catch {
    throw upstream('Steam API returned invalid JSON', 'steam_api_error');
  }
}

/** Keyless details of one Workshop item; 404 `workshop_item_not_found` when it does not exist / is hidden. */
export async function getWorkshopItem(id: string): Promise<WorkshopItem> {
  if (!WORKSHOP_ID_RE.test(id)) throw badRequest('Invalid Workshop id', 'invalid_workshop_id');
  const body = new URLSearchParams({ itemcount: '1', 'publishedfileids[0]': id });
  const j = (await steamFetch(`${API}/ISteamRemoteStorage/GetPublishedFileDetails/v1/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })) as { response?: { publishedfiledetails?: RawDetails[] } };
  const d = j.response?.publishedfiledetails?.[0];
  const item = d && d.result === 1 ? toWorkshopItem(d) : null;
  if (!item) throw new AppError(404, 'workshop_item_not_found', `Workshop item ${id} was not found (or is private)`);
  return item;
}

export const WORKSHOP_SORTS = ['relevance', 'popular', 'trend', 'recent', 'updated'] as const;
export type WorkshopSort = (typeof WORKSHOP_SORTS)[number];

/** EPublishedFileQueryType for a sort (text relevance only makes sense with a query). */
export function queryTypeFor(sort: WorkshopSort, hasText: boolean): number {
  switch (sort) {
    case 'relevance':
      return hasText ? 12 : 3; // RankedByTextSearch / RankedByTrend
    case 'popular':
      return 9; // RankedByTotalUniqueSubscriptions
    case 'trend':
      return 3; // RankedByTrend
    case 'recent':
      return 1; // RankedByPublicationDate
    case 'updated':
      return 19; // RankedByLastUpdatedDate
  }
}

export const WORKSHOP_PAGE_SIZE = 24;

/** Build the QueryFiles URL (exported for tests; contains the key, never log it). */
export function queryFilesUrl(key: string, appId: number, q: string, page: number, sort: WorkshopSort): string {
  const p = new URLSearchParams({
    key,
    appid: String(appId),
    query_type: String(queryTypeFor(sort, q.trim().length > 0)),
    page: String(Math.max(1, page)),
    numperpage: String(WORKSHOP_PAGE_SIZE),
    return_short_description: 'true',
    return_previews: 'false',
    return_metadata: 'false',
    filetype: '0',
  });
  if (q.trim()) p.set('search_text', q.trim().slice(0, 200));
  return `${API}/IPublishedFileService/QueryFiles/v1/?${p.toString()}`;
}

export async function searchWorkshop(
  key: string,
  appId: number,
  q: string,
  page: number,
  sort: WorkshopSort,
): Promise<{ items: WorkshopItem[]; total: number }> {
  const j = (await steamFetch(queryFilesUrl(key, appId, q, page, sort))) as {
    response?: { total?: number; publishedfiledetails?: RawDetails[] };
  };
  const items = (j.response?.publishedfiledetails ?? [])
    .filter((d) => d.result === undefined || d.result === 1)
    .map(toWorkshopItem)
    .filter((x): x is WorkshopItem => !!x);
  return { items, total: Number(j.response?.total) || 0 };
}
