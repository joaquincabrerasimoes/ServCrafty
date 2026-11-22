import { badRequest } from '../errors.js';
import { assertMap } from '../l4d2/control.js';

/** Maps of a plain Counter-Strike 1.6 install (the ones that ship in `cstrike/maps`). */
export const STOCK_MAPS: readonly string[] = [
  'as_oilrig', 'cs_747', 'cs_assault', 'cs_backalley', 'cs_estate', 'cs_havana', 'cs_italy', 'cs_militia', 'cs_office', 'cs_siege',
  'de_airstrip', 'de_aztec', 'de_cbble', 'de_chateau', 'de_dust', 'de_dust2', 'de_inferno', 'de_nuke', 'de_piranesi', 'de_prodigy',
  'de_storm', 'de_survivor', 'de_torn', 'de_train', 'de_vertigo',
];

export const MAPCYCLE_MAX = 200;

/** `mapcycle.txt`: one map per line; blank lines, `//` comments and a trailing `;` part are ignored. */
export function parseMapcycle(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim().split(/\s+/)[0] ?? '';
    if (/^[A-Za-z0-9_.-]{1,64}$/.test(line)) out.push(line);
  }
  return out;
}

export const formatMapcycle = (maps: string[]): string => maps.join('\n') + '\n';

/** Validate a list of map names for the rotation: whole list of valid names that are installed. */
export function assertMapcycle(input: unknown, installed: ReadonlySet<string>): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAPCYCLE_MAX) throw badRequest(`The rotation needs 1 to ${MAPCYCLE_MAX} maps`, 'invalid_mapcycle');
  const maps = input.map((m) => assertMap(m));
  const missing = maps.filter((m) => !installed.has(m));
  if (missing.length) throw badRequest(`Not installed: ${[...new Set(missing)].join(', ')}`, 'map_not_installed');
  return maps;
}

// ---------------------------------------------------------------------------------------------
// Installing a downloaded map archive

/** Folders of `cstrike/` a map package may bring files for. */
const ASSET_DIRS = ['maps', 'models', 'sound', 'sprites', 'gfx', 'overviews', 'media'] as const;
/** File types that are accepted at all: game content only, never code, scripts or configs. */
const ALLOWED_EXT = new Set(['bsp', 'res', 'txt', 'wad', 'mdl', 'spr', 'wav', 'mp3', 'tga', 'bmp', 'nav']);
/** Types accepted inside `maps/` only (`txt` is the map description). */
const MAX_DEPTH = 8;

export interface PlannedFile {
  /** Path inside the archive. */
  from: string;
  /** Destination, relative to `cstrike/`, lower case. */
  to: string;
}

export interface MapInstallPlan {
  files: PlannedFile[];
  /** Map names (`.bsp` files) the package brings. */
  maps: string[];
  /** Entries that were ignored (not game content). */
  skipped: string[];
}

const ext = (p: string) => (p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : '');

/**
 * Decide where each file of a map archive goes. Packages come in many layouts (`maps/x.bsp`, `cstrike/maps/x.bsp`,
 * `X/maps/x.bsp`, or just `x.bsp` and `x.wad` loose in the root), so the rule is: from the first folder named like a game
 * asset folder on, the path is kept; a loose `.bsp` goes to `maps/`, a loose `.wad` to the `cstrike/` root. Names are
 * lower-cased (the Linux server is case sensitive and clients ask for the lower-case names). Anything that is not game
 * content (`.dll`, `.so`, `.cfg`, `.amxx`, scripts, images, readmes) is skipped, and no path can leave `cstrike/`.
 */
export function planMapInstall(entries: string[]): MapInstallPlan {
  const files: PlannedFile[] = [];
  const maps: string[] = [];
  const skipped: string[] = [];
  const taken = new Set<string>();
  for (const entry of entries) {
    const parts = entry.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
    if (!parts.length || parts.some((s) => s === '..') || parts.length > MAX_DEPTH) {
      skipped.push(entry);
      continue;
    }
    const lower = parts.map((s) => s.toLowerCase());
    const file = lower[lower.length - 1]!;
    if (!ALLOWED_EXT.has(ext(file)) || !/^[a-z0-9_.+() -]{1,100}$/.test(file)) {
      skipped.push(entry);
      continue;
    }
    // A map file name is also the map name (`changelevel`, the rotation): it must be a plain one.
    if ((ext(file) === 'bsp' || ext(file) === 'res') && !/^[a-z0-9_.-]{1,64}$/.test(file.slice(0, file.lastIndexOf('.')))) {
      skipped.push(entry);
      continue;
    }
    // Keep the path from the first asset folder (`cstrike/maps/x.bsp` -> `maps/x.bsp`).
    const at = lower.findIndex((s, i) => i < lower.length - 1 && (ASSET_DIRS as readonly string[]).includes(s));
    let rel: string[];
    if (at >= 0) rel = lower.slice(at);
    else if (ext(file) === 'bsp' || ext(file) === 'res' || ext(file) === 'nav') rel = ['maps', file];
    else if (ext(file) === 'wad') rel = [file];
    else {
      skipped.push(entry);
      continue;
    }
    // Inside the asset folders only the folder names that are plain are kept.
    if (rel.slice(0, -1).some((s) => !/^[a-z0-9_.+-]{1,60}$/.test(s)) || rel.length < 2 && ext(file) !== 'wad') {
      skipped.push(entry);
      continue;
    }
    // `.txt` is only a map description inside maps/; elsewhere (readme.txt) it is not game content.
    if (ext(file) === 'txt' && rel[0] !== 'maps') {
      skipped.push(entry);
      continue;
    }
    const to = rel.join('/');
    if (taken.has(to)) {
      skipped.push(entry);
      continue;
    }
    taken.add(to);
    files.push({ from: entry, to });
    if (to.startsWith('maps/') && rel.length === 2 && ext(file) === 'bsp') maps.push(file.slice(0, -4));
  }
  return { files, maps, skipped };
}

/** Which engine a `.bsp` was compiled for, from its first bytes. */
export type BspKind = 'goldsrc' | 'source' | 'unknown';

/**
 * GoldSrc (Half-Life, Counter-Strike 1.6) maps start with the number 30; Source engine maps (Counter-Strike: Source,
 * CS:GO, Team Fortress 2...) start with the letters `VBSP`. Only the first kind can be played on a 1.6 server.
 */
export function bspKind(head: Uint8Array): BspKind {
  if (head.length < 4) return 'unknown';
  const tag = Buffer.from(head.subarray(0, 4)).toString('latin1');
  if (tag === 'VBSP' || tag === 'rBSP') return 'source';
  return Buffer.from(head.subarray(0, 4)).readInt32LE(0) === 30 ? 'goldsrc' : 'unknown';
}
