import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { badRequest } from '../errors.js';
import { downloadFile } from '../http.js';
import { USER_AGENT } from '../../config.js';
import { extractZip } from '../zip.js';
import type { PluginDef, PluginRule, PluginSource } from './pluginCatalog.js';

/** Download, unpack and place plugin files under `left4dead2/`, and keep the plugin settings in cfg files. */

export interface InstallDeps {
  /** Text of a small document (the "latest file name" pointer of AlliedModders). */
  fetchText(url: string): Promise<string>;
  download(url: string, dest: string): Promise<unknown>;
  unzip(file: string, dest: string): Promise<unknown>;
  untar(file: string, dest: string): Promise<unknown>;
}

export const defaultDeps: InstallDeps = {
  async fetchText(url) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw badRequest(`Could not reach ${new URL(url).host} (HTTP ${res.status})`, 'plugin_download_failed');
    return res.text();
  },
  download: (url, dest) => downloadFile(url, dest),
  unzip: (file, dest) => extractZip(file, dest),
  untar: (file, dest) =>
    tar.x({
      file,
      cwd: dest,
      // Regular files and directories only: no links or devices from an archive.
      filter: (_p, entry) => ('type' in entry ? entry.type === 'File' || entry.type === 'Directory' : true),
    }),
};

/** Where an archive entry goes (relative to `left4dead2/`), or null when no rule takes it. */
export function mapEntry(rules: PluginRule[], entry: string): string | null {
  const p = entry.replace(/\\/g, '/').replace(/^\/+/, '');
  for (const r of rules) {
    let from = r.from;
    let rest = p;
    if (from.startsWith('*/')) {
      const slash = p.indexOf('/');
      if (slash < 0) continue;
      rest = p.slice(slash + 1);
      from = from.slice(2);
    }
    if (from === '' || rest === from || (from.endsWith('/') && rest.startsWith(from))) {
      const tail = from === '' ? rest : rest.slice(from.length);
      if (r.to === '' || r.to.endsWith('/')) return tail ? r.to + tail : null;
      return r.to; // a single destination file
    }
  }
  return null;
}

async function* walk(dir: string, base = dir): AsyncGenerator<string> {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, base);
    else if (e.isFile()) yield path.relative(base, full).split(path.sep).join('/');
  }
}

const exists = (f: string) => fsp.lstat(f).then(() => true, () => false);

export interface Installed {
  /** Files written, relative to `left4dead2/`. */
  files: string[];
  /** Version taken from the downloaded file name (AlliedModders builds), else null. */
  version: string | null;
}

/** Install one download of a plugin into `root` (the `left4dead2` directory). */
export async function installSource(root: string, source: PluginSource, deps: InstallDeps = defaultDeps): Promise<Installed> {
  let url = source.url;
  let version: string | null = null;
  if (source.latest) {
    const name = (await deps.fetchText(source.latest.index)).trim();
    if (!/^[\w.+-]{3,120}$/.test(name)) throw badRequest('Unexpected answer from the download server', 'plugin_download_failed');
    url = source.latest.base + name;
    version = name.replace(/-linux\.tar\.gz$|\.tar\.gz$|\.zip$/i, '');
  }
  if (!url?.startsWith('https://')) throw badRequest('Plugin download must use https', 'plugin_download_failed');

  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'servcrafty-plugin-'));
  try {
    const archive = path.join(stage, source.format === 'file' ? 'download.bin' : `download.${source.format === 'zip' ? 'zip' : 'tgz'}`);
    await deps.download(url, archive);
    const content = path.join(stage, 'content');
    await fsp.mkdir(content);
    if (source.format === 'zip') await deps.unzip(archive, content);
    else if (source.format === 'tar.gz') await deps.untar(archive, content);
    else await fsp.copyFile(archive, path.join(content, 'file'));

    const base = path.resolve(root);
    const written: string[] = [];
    for await (const entry of walk(content)) {
      const dest = mapEntry(source.rules, source.format === 'file' ? 'file' : entry);
      if (!dest) continue;
      const target = path.resolve(base, dest);
      if (target !== base && !target.startsWith(base + path.sep)) throw badRequest(`Unsafe path in archive: ${entry}`, 'unsafe_archive');
      const rel = path.relative(base, target).split(path.sep).join('/');
      if (source.preserve?.some((pre) => rel.startsWith(pre)) && (await exists(target))) continue;
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(path.join(content, ...entry.split('/')), target);
      written.push(rel);
    }
    if (!written.length) throw badRequest('The download did not contain the expected files', 'plugin_download_failed');
    return { files: written, version };
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Remove files written by a plugin and the folders that become empty (never `root` itself or the top folders). */
export async function removeFiles(root: string, files: string[]): Promise<void> {
  const base = path.resolve(root);
  const dirs = new Set<string>();
  for (const f of files) {
    const target = path.resolve(base, f);
    if (!target.startsWith(base + path.sep)) continue;
    await fsp.rm(target, { force: true }).catch(() => undefined);
    dirs.add(path.dirname(target));
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    let dir = d;
    // Prune up to `addons/<x>`, but never the top folders (`addons`, `cfg`) themselves.
    while (path.relative(base, dir).split(path.sep).length > 1) {
      try {
        await fsp.rmdir(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Settings (cvars in a cfg file)

export type SettingValues = Record<string, number | boolean>;

/** Validate a settings object against the plugin's definition; unknown keys are refused. Missing keys use `current`/defaults. */
export function normalizeSettings(def: PluginDef, input: unknown, current: SettingValues = {}): SettingValues {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw badRequest('settings must be an object', 'invalid_settings');
  const given = input as Record<string, unknown>;
  const out: SettingValues = {};
  for (const k of Object.keys(given)) if (!def.settings.some((s) => s.key === k)) throw badRequest(`Unknown setting "${k}"`, 'invalid_settings');
  for (const s of def.settings) {
    const v = s.key in given ? given[s.key] : (current[s.key] ?? s.default);
    if (s.type === 'boolean') {
      if (typeof v !== 'boolean') throw badRequest(`${s.key} must be true or false`, 'invalid_settings');
      out[s.key] = v;
    } else {
      if (typeof v !== 'number' || !Number.isInteger(v) || (s.min !== undefined && v < s.min) || (s.max !== undefined && v > s.max)) {
        throw badRequest(`${s.key} must be a whole number between ${s.min} and ${s.max}`, 'invalid_settings');
      }
      out[s.key] = v;
    }
  }
  return out;
}

const cvarText = (v: number | boolean) => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v));

/** Set `key "value"` lines in a cfg text: an existing line of the key is replaced, a new one is appended. */
export function applyCvars(text: string, values: SettingValues): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [key, v] of Object.entries(values)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key)) continue;
    const line = `${key} "${cvarText(v)}"`;
    const re = new RegExp(`^\\s*${key}(\\s|$)`, 'i');
    const at = lines.findIndex((l) => re.test(l));
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  return lines.join(nl) + nl;
}

/** Write a plugin's settings into its cfg file below `left4dead2/cfg`. */
export async function writeSettings(root: string, def: PluginDef, values: SettingValues): Promise<string | null> {
  if (!def.settings.length) return null;
  const rel = `cfg/${def.configFile}`;
  const file = path.join(root, ...rel.split('/'));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  await fsp.writeFile(file, applyCvars(text, values));
  return rel;
}

/** Console lines that apply the settings to a running server. */
export const settingCommands = (values: SettingValues): string[] => Object.entries(values).map(([k, v]) => `${k} ${cvarText(v)}`);

// ---------------------------------------------------------------------------------------------
// State

export interface PluginRecord {
  version: string | null;
  installedAt: string;
  files: string[];
  settings: SettingValues;
}

export interface PluginState {
  schema: 1;
  plugins: Record<string, PluginRecord>;
}

export async function loadState(file: string): Promise<PluginState> {
  try {
    const j = JSON.parse(await fsp.readFile(file, 'utf8')) as PluginState;
    if (j && j.schema === 1 && j.plugins && typeof j.plugins === 'object') return j;
  } catch {
    /* none yet */
  }
  return { schema: 1, plugins: {} };
}

export async function saveState(file: string, state: PluginState): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
  await fsp.rename(tmp, file);
}
