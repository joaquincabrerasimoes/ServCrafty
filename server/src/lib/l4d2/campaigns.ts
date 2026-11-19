import fsp from 'node:fs/promises';
import path from 'node:path';
import { kvObject, kvString, parseKeyValues, type KvObject } from '../keyvalues.js';
import { openVpk, readVpkEntry, type Vpk } from '../vpk.js';

/**
 * Campaigns and maps of a Left 4 Dead 2 server, read from the game files: the official content in
 * `left4dead2/pak01_dir.vpk` and every addon (`left4dead2/addons/*.vpk`, Steam Workshop items are stored as
 * `<item id>.vpk`). A campaign comes from a mission file (`missions/*.txt`) and lists its chapters per game mode.
 */

export const GAME_MODES = ['coop', 'realism', 'versus', 'survival', 'scavenge'] as const;
export type GameMode = (typeof GAME_MODES)[number];

export interface Chapter {
  map: string;
  title: string;
}

export interface Campaign {
  /** `official:c8` or `mission:<mission name>`. */
  id: string;
  title: string;
  author: string | null;
  source: 'official' | 'addon';
  /** File name of the addon that adds it (null for official campaigns). */
  addon: string | null;
  /** Workshop item id when that addon is a Workshop item. */
  workshopId: string | null;
  modes: Partial<Record<GameMode, Chapter[]>>;
}

export interface AddonInfo {
  /** File name inside `left4dead2/addons`, e.g. `121086524.vpk`. */
  file: string;
  workshopId: string | null;
  title: string;
  author: string | null;
  sizeBytes: number;
  modifiedAt: string;
  /** Maps (`maps/<name>.bsp`) the addon contains. */
  maps: string[];
  /** Ids of the campaigns the addon adds. */
  campaigns: string[];
  /** campaign = adds a mission, map = only maps, content = skins, sounds, scripts, ... */
  kind: 'campaign' | 'map' | 'content';
  /** The file could not be read (damaged or not a VPK). */
  error: string | null;
}

export interface GameCatalog {
  campaigns: Campaign[];
  addons: AddonInfo[];
  /** Every map the server has, official ones first. */
  maps: { map: string; source: string | null }[];
  /** False when the official files are not installed yet (the server never started): the built-in list is used. */
  officialFromGame: boolean;
}

// ---------------------------------------------------------------------------------------------
// Official campaigns

export const OFFICIAL_TITLES: Record<number, string> = {
  1: 'Dead Center',
  2: 'Dark Carnival',
  3: 'Swamp Fever',
  4: 'Hard Rain',
  5: 'The Parish',
  6: 'The Passing',
  7: 'The Sacrifice',
  8: 'No Mercy',
  9: 'Crash Course',
  10: 'Death Toll',
  11: 'Dead Air',
  12: 'Blood Harvest',
  13: 'Cold Stream',
  14: 'The Last Stand',
};

/** Used until the official game files exist on disk. */
const OFFICIAL_FALLBACK: Record<number, string[]> = {
  1: ['c1m1_hotel', 'c1m2_streets', 'c1m3_mall', 'c1m4_atrium'],
  2: ['c2m1_highway', 'c2m2_fairgrounds', 'c2m3_coaster', 'c2m4_barns', 'c2m5_concert'],
  3: ['c3m1_plankcountry', 'c3m2_swamp', 'c3m3_shantytown', 'c3m4_plantation'],
  4: ['c4m1_milltown_a', 'c4m2_sugarmill_a', 'c4m3_sugarmill_b', 'c4m4_milltown_b', 'c4m5_milltown_escape'],
  5: ['c5m1_waterfront', 'c5m2_park', 'c5m3_cemetery', 'c5m4_quarter', 'c5m5_bridge'],
  6: ['c6m1_riverbank', 'c6m2_bedlam', 'c6m3_port'],
  7: ['c7m1_docks', 'c7m2_barge', 'c7m3_port'],
  8: ['c8m1_apartment', 'c8m2_subway', 'c8m3_sewers', 'c8m4_interior', 'c8m5_rooftop'],
  9: ['c9m1_alleys', 'c9m2_lots'],
  10: ['c10m1_caves', 'c10m2_drainage', 'c10m3_ranchhouse', 'c10m4_mainstreet', 'c10m5_houseboat'],
  11: ['c11m1_greenhouse', 'c11m2_offices', 'c11m3_garage', 'c11m4_terminal', 'c11m5_runway'],
  12: ['c12m1_hilltop', 'c12m2_traintunnel', 'c12m3_bridge', 'c12m4_barn', 'c12m5_cornfield'],
  13: ['c13m1_alpinecreek', 'c13m2_southpinestream', 'c13m3_memorialbridge', 'c13m4_cutthroatcreek'],
  14: ['c14m1_junkyard', 'c14m2_lighthouse'],
};

/** `c1m2_streets` -> `Streets`; `c4m2_sugarmill_a` -> `Sugarmill A`. */
export function chapterTitle(map: string): string {
  const rest = map.replace(/^c\d+m\d+_/i, '').replace(/[_-]+/g, ' ').trim();
  if (!rest) return map;
  return rest.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const officialNumber = (maps: string[]): number | null => {
  const nums = new Set(maps.map((m) => /^c(\d+)m\d+_/i.exec(m)?.[1]));
  if (nums.size !== 1) return null;
  const n = Number([...nums][0]);
  return OFFICIAL_TITLES[n] ? n : null;
};

function fallbackOfficial(): Campaign[] {
  return Object.entries(OFFICIAL_FALLBACK).map(([n, maps]) => {
    const chapters = maps.map((map) => ({ map, title: chapterTitle(map) }));
    return {
      id: `official:c${n}`,
      title: OFFICIAL_TITLES[Number(n)]!,
      author: 'Valve',
      source: 'official' as const,
      addon: null,
      workshopId: null,
      modes: { coop: chapters, realism: chapters, versus: chapters },
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Mission files

const isMode = (m: string): m is GameMode => (GAME_MODES as readonly string[]).includes(m);

export interface Mission {
  name: string;
  title: string;
  author: string | null;
  builtin: boolean;
  modes: Partial<Record<GameMode, Chapter[]>>;
}

const MAP_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Parse `missions/*.txt`. Returns null when the file defines no playable chapters. */
export function parseMission(text: string): Mission | null {
  const root = kvObject(parseKeyValues(text), 'mission');
  if (!root) return null;
  const modesObj = kvObject(root, 'modes');
  if (!modesObj) return null;
  const modes: Partial<Record<GameMode, Chapter[]>> = {};
  for (const [mode, v] of Object.entries(modesObj)) {
    if (!isMode(mode) || typeof v !== 'object') continue;
    const chapters = Object.entries(v as KvObject)
      .filter(([k, c]) => /^\d+$/.test(k) && typeof c === 'object')
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, c]) => c as KvObject)
      .map((c) => ({ map: kvString(c, 'map') ?? '', name: kvString(c, 'displayname') }))
      .filter((c) => MAP_RE.test(c.map))
      .map((c) => ({ map: c.map, title: c.name && !c.name.startsWith('#') ? c.name.slice(0, 80) : chapterTitle(c.map) }));
    if (chapters.length) modes[mode] = chapters;
  }
  if (!Object.keys(modes).length) return null;
  const name = (kvString(root, 'name') ?? '').slice(0, 80);
  const display = kvString(root, 'displaytitle') ?? '';
  const title = (display && !display.startsWith('#') ? display : name).slice(0, 80);
  const first = Object.values(modes)[0]![0]!.map;
  return {
    name: name || first,
    title: title || chapterTitle(first),
    author: kvString(root, 'author')?.slice(0, 80) ?? null,
    builtin: kvString(root, 'builtin') === '1',
    modes,
  };
}

// ---------------------------------------------------------------------------------------------
// Scanning

interface Parsed {
  maps: string[];
  missions: Mission[];
  title: string | null;
  author: string | null;
  hasContent: boolean;
}

const cache = new Map<string, Parsed>();
const CACHE_MAX = 400;

async function parseVpk(file: string, st: { size: number; mtimeMs: number }): Promise<Parsed> {
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const vpk: Vpk = await openVpk(file);
  const maps: string[] = [];
  const missions: Mission[] = [];
  let title: string | null = null;
  let author: string | null = null;
  let hasContent = false;
  for (const e of vpk.entries) {
    if (e.path.startsWith('maps/') && e.path.endsWith('.bsp') && !e.path.slice(5).includes('/')) maps.push(e.path.slice(5, -4));
    else if (e.path.startsWith('missions/') && e.path.endsWith('.txt') && !e.path.slice(9).includes('/')) {
      try {
        const m = parseMission((await readVpkEntry(vpk, e)).toString('utf8'));
        if (m) missions.push(m);
      } catch {
        /* unreadable mission file: ignore it */
      }
    } else if (e.path === 'addoninfo.txt') {
      try {
        const info = parseKeyValues((await readVpkEntry(vpk, e)).toString('utf8'));
        const root = kvObject(info, 'addoninfo') ?? info;
        title = kvString(root, 'addontitle')?.slice(0, 120) ?? null;
        author = kvString(root, 'addonauthor')?.slice(0, 80) ?? null;
      } catch {
        /* no usable addoninfo */
      }
    } else if (/^(models|materials|sound|scripts|particles|resource)\//.test(e.path)) hasContent = true;
  }
  const out: Parsed = { maps, missions, title, author, hasContent };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}

const exists = (f: string) => fsp.stat(f).then((s) => s, () => null);

export async function scanOfficial(gameDir: string): Promise<{ campaigns: Campaign[]; maps: string[]; fromGame: boolean }> {
  const file = path.join(gameDir, 'left4dead2', 'pak01_dir.vpk');
  const st = await exists(file);
  if (st) {
    try {
      const p = await parseVpk(file, st);
      const campaigns: Campaign[] = [];
      for (const m of p.missions) {
        const all = Object.values(m.modes).flat().map((c) => c!.map);
        const n = officialNumber(all);
        if (n === null) continue; // only the numbered campaigns (tutorial, credits, ... are not selectable)
        const id = `official:c${n}`;
        const existing = campaigns.find((c) => c.id === id);
        if (existing) {
          for (const [mode, ch] of Object.entries(m.modes)) existing.modes[mode as GameMode] ??= ch;
        } else {
          campaigns.push({ id, title: OFFICIAL_TITLES[n]!, author: 'Valve', source: 'official', addon: null, workshopId: null, modes: { ...m.modes } });
        }
      }
      campaigns.sort((a, b) => Number(a.id.slice(10)) - Number(b.id.slice(10)));
      const maps = p.maps.filter((x) => /^c\d+m\d+_/.test(x));
      if (campaigns.length) return { campaigns, maps, fromGame: true };
    } catch {
      /* fall through to the built-in list */
    }
  }
  return { campaigns: fallbackOfficial(), maps: [], fromGame: false };
}

/** Read the catalog of a server's game directory (`<data>/game`). Never throws for damaged addons. */
export async function scanGame(gameDir: string): Promise<GameCatalog> {
  const official = await scanOfficial(gameDir);
  const addonsDir = path.join(gameDir, 'left4dead2', 'addons');
  const files = (await fsp.readdir(addonsDir).catch(() => [] as string[])).filter((f) => /\.vpk$/i.test(f)).sort();
  const addons: AddonInfo[] = [];
  const campaigns: Campaign[] = [...official.campaigns];
  const maps: { map: string; source: string | null }[] = official.maps.map((m) => ({ map: m, source: null }));
  const seenCampaign = new Set(campaigns.map((c) => c.id));
  for (const f of files) {
    const abs = path.join(addonsDir, f);
    const st = await exists(abs);
    if (!st?.isFile()) continue;
    const workshopId = /^(\d{1,20})\.vpk$/i.exec(f)?.[1] ?? null;
    const base: AddonInfo = {
      file: f,
      workshopId,
      title: f.replace(/\.vpk$/i, ''),
      author: null,
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
      maps: [],
      campaigns: [],
      kind: 'content',
      error: null,
    };
    try {
      const p = await parseVpk(abs, st);
      base.title = p.title ?? p.missions[0]?.title ?? base.title;
      base.author = p.author ?? p.missions[0]?.author ?? null;
      base.maps = p.maps;
      for (const m of p.missions) {
        const id = `mission:${m.name.toLowerCase()}`;
        base.campaigns.push(id);
        if (!seenCampaign.has(id)) {
          seenCampaign.add(id);
          campaigns.push({ id, title: m.title, author: m.author, source: 'addon', addon: f, workshopId, modes: m.modes });
        }
      }
      base.kind = p.missions.length ? 'campaign' : p.maps.length ? 'map' : 'content';
      for (const m of p.maps) maps.push({ map: m, source: f });
    } catch (err) {
      base.error = err instanceof Error ? err.message.slice(0, 200) : 'unreadable';
    }
    addons.push(base);
  }
  return { campaigns, addons, maps, officialFromGame: official.fromGame };
}

/** The first map of a campaign in a mode, or null when the campaign has no chapters for that mode. */
export function firstMap(c: Campaign, mode: GameMode): string | null {
  return c.modes[mode]?.[0]?.map ?? null;
}
