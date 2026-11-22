import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { assertSteam } from '../lib/games.js';
import type { GameDefinition } from '../lib/gameDefinition.js';
import {
  assertBotRequest,
  assertMap,
  assertMatchSettings,
  assertUserId,
  banCommands,
  botCommands,
  changeLevelCommand,
  END_COMMAND,
  END_LINE,
  kickCommand,
  MATCH_SETTINGS,
  parseStatus,
  readMatchSettings,
  restartCommand,
  sayCommand,
  settingCommands,
  type BotEngine,
  type MatchValues,
  type StatusInfo,
} from '../lib/cs16/control.js';
import * as gb from '../lib/cs16/gamebanana.js';
import { assertMapcycle, bspKind, formatMapcycle, parseMapcycle, planMapInstall, STOCK_MAPS, type BspKind } from '../lib/cs16/maps.js';
import { addMetamodLine, CS16_PLUGIN_CATALOG, METAMOD_PLUGINS_INI, pluginById, removeMetamodLine, sourcesFor, withDependencies, type Cs16PluginDef } from '../lib/cs16/pluginCatalog.js';
import { applyCvars, defaultDeps, installSource, loadState, removeFiles, saveState, type InstallDeps } from '../lib/l4d2/pluginInstall.js';
import { extractArchive } from '../lib/sevenZip.js';
import { requireDefinition } from './gameDefinitions.js';
import { serverDir } from './docker.js';
import * as runtime from './runtime.js';
import { updateSteamConfig } from './servers.js';
import type { ServerRow } from './types.js';

/**
 * Counter-Strike 1.6 integration (definitions with `profile: "cs16"`): installed maps and the rotation (`mapcycle.txt`),
 * a map catalogue backed by GameBanana, console controls and the plugin store. Files live in `<server dir>/game/cstrike`.
 */

export function cs16Def(server: ServerRow): GameDefinition {
  assertSteam(server, 'This feature');
  const def = requireDefinition(server.steam!.gameId);
  if (def.profile !== 'cs16') throw badRequest('This feature is only available for Counter-Strike 1.6 servers', 'unsupported_game');
  return def;
}

const csRoot = (id: string) => path.join(serverDir(id), 'game', 'cstrike');
const pluginStateFile = (id: string) => path.join(serverDir(id), 'servcrafty-plugins.json');
const mapsStateFile = (id: string) => path.join(serverDir(id), 'servcrafty-maps.json');

const isDir = (dir: string) => fsp.stat(dir).then((s) => s.isDirectory(), () => false);
const readText = (file: string) => fsp.readFile(file, 'utf8').catch(() => '');
const exists = (f: string) => fsp.lstat(f).then(() => true, () => false);

async function requireGameFiles(server: ServerRow): Promise<string> {
  const root = csRoot(server.id);
  if (!(await isDir(root))) throw conflict('The game files are not installed yet: start the server once and try again', 'game_not_installed');
  return root;
}

const busy = new Set<string>();

async function exclusive<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(serverId)) throw conflict('Another plugin or map operation is running for this server', 'plugin_busy');
  busy.add(serverId);
  try {
    return await fn();
  } finally {
    busy.delete(serverId);
  }
}

async function run(server: ServerRow, commands: string[]): Promise<void> {
  if (!runtime.isRunning(server.id)) throw conflict('The server is not running', 'not_running');
  for (const c of commands) await runtime.sendCommand(server.id, c);
}

// ---------------------------------------------------------------------------------------------
// Maps state (what was downloaded from GameBanana, so it can be shown and removed again)

export interface MapInstallRecord {
  gbId: number;
  name: string;
  fileId: number;
  fileName: string;
  thumbnail: string | null;
  /** Map names (`.bsp`) the package brought. */
  maps: string[];
  /** Files written, relative to `cstrike/`. */
  files: string[];
  installedAt: string;
}

interface MapsState {
  schema: 1;
  installs: Record<string, MapInstallRecord>;
}

async function loadMapsState(id: string): Promise<MapsState> {
  try {
    const j = JSON.parse(await fsp.readFile(mapsStateFile(id), 'utf8')) as MapsState;
    if (j && j.schema === 1 && j.installs && typeof j.installs === 'object') return j;
  } catch {
    /* none yet */
  }
  return { schema: 1, installs: {} };
}

async function saveMapsState(id: string, state: MapsState): Promise<void> {
  const file = mapsStateFile(id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
  await fsp.rename(tmp, file);
}

// ---------------------------------------------------------------------------------------------
// Maps

async function installedMaps(id: string): Promise<{ name: string; size: number }[]> {
  const dir = path.join(csRoot(id), 'maps');
  const out: { name: string; size: number }[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.bsp')) continue;
    const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
    out.push({ name: e.name.slice(0, -4), size: st?.size ?? 0 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const STOCK = new Set(STOCK_MAPS);

async function currentMap(server: ServerRow): Promise<string | null> {
  if (runtime.getStatus(server.id) !== 'running') return null;
  try {
    return (await runtime.getStats(server)).map ?? null;
  } catch {
    return null;
  }
}

export async function mapsOverview(server: ServerRow) {
  const def = cs16Def(server);
  const root = csRoot(server.id);
  const [maps, state, cycleText, current] = await Promise.all([installedMaps(server.id), loadMapsState(server.id), readText(path.join(root, 'mapcycle.txt')), currentMap(server)]);
  const rotation = parseMapcycle(cycleText);
  const inRotation = new Set(rotation);
  const owner = new Map<string, MapInstallRecord>();
  for (const rec of Object.values(state.installs)) for (const m of rec.maps) owner.set(m, rec);
  const startVar = server.steam?.vars?.map;
  const fallback = def.variables.find((v) => v.key === 'map')?.default;
  return {
    gameInstalled: await isDir(root),
    maps: maps.map((m) => {
      const rec = owner.get(m.name);
      return {
        name: m.name,
        size: m.size,
        source: STOCK.has(m.name) ? ('stock' as const) : rec ? ('gamebanana' as const) : ('other' as const),
        inRotation: inRotation.has(m.name),
        gamebanana: rec ? { id: rec.gbId, name: rec.name, thumbnail: rec.thumbnail, installedAt: rec.installedAt } : null,
      };
    }),
    rotation,
    /** Entries of the rotation file whose map is not installed (the game would skip or fail on them). */
    missing: rotation.filter((m) => !maps.some((x) => x.name === m)),
    current,
    start: { map: typeof startVar === 'string' ? startVar : typeof fallback === 'string' ? fallback : 'de_dust2' },
  };
}

/**
 * Save the rotation. The game only re-reads the file when the `mapcyclefile` cvar changes, so on a running server the
 * list is also written to a new file name and the cvar is pointed at it (older copies are removed).
 */
export async function setRotation(server: ServerRow, input: unknown) {
  cs16Def(server);
  const root = await requireGameFiles(server);
  const installed = new Set((await installedMaps(server.id)).map((m) => m.name));
  const maps = assertMapcycle(input, installed);
  const text = formatMapcycle(maps);
  await fsp.writeFile(path.join(root, 'mapcycle.txt'), text);
  let appliedLive = false;
  if (runtime.isRunning(server.id)) {
    const live = `mc_${Date.now().toString(36)}.txt`;
    await fsp.writeFile(path.join(root, live), text);
    await runtime.sendCommand(server.id, `mapcyclefile ${live}`);
    for (const f of await fsp.readdir(root).catch(() => [] as string[])) if (/^mc_[a-z0-9]+\.txt$/.test(f) && f !== live) await fsp.rm(path.join(root, f), { force: true });
    appliedLive = true;
  }
  return { maps, appliedLive };
}

/** Remove a map that was not part of the game: its `.bsp` and the description/resource files that go with it. */
export async function removeMap(server: ServerRow, nameInput: unknown) {
  cs16Def(server);
  const name = assertMap(nameInput);
  if (STOCK.has(name)) throw conflict('Maps that come with the game cannot be removed', 'map_stock');
  const root = await requireGameFiles(server);
  return exclusive(server.id, async () => {
    if (!(await exists(path.join(root, 'maps', `${name}.bsp`)))) throw notFound('That map is not installed');
    if ((await currentMap(server)) === name) throw conflict('The server is playing this map right now: change the map first', 'map_in_use');
    const state = await loadMapsState(server.id);
    const rec = Object.values(state.installs).find((r) => r.maps.includes(name));
    const own = new Set(['bsp', 'res', 'txt', 'nav'].map((e) => `maps/${name}.${e}`));
    // The map itself always; its description and resource files when the package put them there (or nobody tracked it).
    await removeFiles(root, [...own].filter((f) => f.endsWith('.bsp') || !rec || rec.files.includes(f)));
    if (rec) {
      rec.maps = rec.maps.filter((m) => m !== name);
      rec.files = rec.files.filter((f) => !own.has(f));
      // The last map of a package is gone: its models, sounds and textures go with it.
      if (!rec.maps.length) {
        await removeFiles(root, rec.files);
        delete state.installs[String(rec.gbId)];
      }
      await saveMapsState(server.id, state);
    }
    // Take it out of the rotation as well.
    const cycle = parseMapcycle(await readText(path.join(root, 'mapcycle.txt')));
    const rest = cycle.filter((m) => m !== name);
    if (rest.length !== cycle.length && rest.length) await fsp.writeFile(path.join(root, 'mapcycle.txt'), formatMapcycle(rest));
    return { removed: name };
  });
}

// ---------------------------------------------------------------------------------------------
// Catalogue (GameBanana)

export interface MapInstallDeps {
  download(fileId: number, dest: string, md5: string | null): Promise<unknown>;
  extract(file: string, dest: string): Promise<string[]>;
}

const defaultMapDeps: MapInstallDeps = { download: (fileId, dest, md5) => gb.downloadFileTo(fileId, dest, md5), extract: (f, d) => extractArchive(f, d) };

const ARCHIVE_EXT = /\.(zip|rar|7z|tar\.gz|tgz|tar\.xz|txz|tar)$/i;

/** Download a map from GameBanana and put its files into `cstrike/`. */
export async function installCatalogMap(server: ServerRow, gbId: number, fileId?: number, deps: MapInstallDeps = defaultMapDeps) {
  cs16Def(server);
  gb.assertGbId(gbId);
  const root = await requireGameFiles(server);
  const detail = await gb.getMap(gbId);
  const file = fileId === undefined ? (detail.files.find((f) => ARCHIVE_EXT.test(f.name) || /\.bsp$/i.test(f.name)) ?? detail.files[0]) : detail.files.find((f) => f.id === fileId);
  if (!file) throw badRequest(fileId === undefined ? 'That map has no downloadable file' : 'That file does not belong to the map', 'invalid_file');
  if (!ARCHIVE_EXT.test(file.name) && !/\.bsp$/i.test(file.name)) throw badRequest(`Unsupported file type: ${file.name}`, 'unsupported_archive');

  return exclusive(server.id, async () => {
    const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'servcrafty-map-'));
    try {
      const archive = path.join(stage, `download${path.extname(file.name) || '.bin'}`);
      await deps.download(file.id, archive, file.md5);
      const content = path.join(stage, 'content');
      await fsp.mkdir(content);
      let entries: string[];
      if (/\.bsp$/i.test(file.name)) {
        await fsp.copyFile(archive, path.join(content, file.name));
        entries = [file.name];
      } else entries = await deps.extract(archive, content);
      const found = planMapInstall(entries);
      if (!found.maps.length) throw badRequest('The download does not contain a map (.bsp file)', 'no_map_in_archive');
      // Only GoldSrc maps run on this game: a Source engine map (Counter-Strike: Source...) is left out.
      const rejected: { map: string; kind: BspKind }[] = [];
      for (const name of found.maps) {
        const planned = found.files.find((f) => f.to === `maps/${name}.bsp`)!;
        const handle = await fsp.open(path.join(content, ...planned.from.split('/')), 'r');
        try {
          const head = Buffer.alloc(4);
          await handle.read(head, 0, 4, 0);
          const kind = bspKind(head);
          if (kind !== 'goldsrc') rejected.push({ map: name, kind });
        } finally {
          await handle.close();
        }
      }
      const rejectedNames = new Set(rejected.map((r) => r.map));
      const plan = {
        ...found,
        maps: found.maps.filter((m) => !rejectedNames.has(m)),
        files: found.files.filter((f) => !/^maps\/[^/]+\.(bsp|res|txt|nav)$/.test(f.to) || !rejectedNames.has(f.to.slice(5, f.to.lastIndexOf('.')))),
      };
      if (!plan.maps.length) {
        throw rejected.every((r) => r.kind === 'source')
          ? badRequest('This map was made for a Source engine game (Counter-Strike: Source, CS:GO...) and cannot run on Counter-Strike 1.6', 'wrong_engine')
          : badRequest('The map file is not a valid Counter-Strike 1.6 (GoldSrc) map', 'invalid_bsp');
      }

      const state = await loadMapsState(server.id);
      const previous = state.installs[String(gbId)];
      const own = new Set(previous?.files ?? []);
      const base = path.resolve(root);
      // A map that already exists and is not from this package (a stock map, or one added by hand) is never replaced.
      for (const f of plan.files) {
        if (!f.to.endsWith('.bsp')) continue;
        if (STOCK.has(f.to.slice(5, -4)) || ((await exists(path.join(root, ...f.to.split('/')))) && !own.has(f.to))) {
          throw conflict(`A map named ${f.to.slice(5, -4)} is already installed`, 'map_exists');
        }
      }
      const written: string[] = [];
      const kept: string[] = [];
      for (const f of plan.files) {
        const target = path.resolve(base, ...f.to.split('/'));
        if (!target.startsWith(base + path.sep)) throw badRequest(`Unsafe path in archive: ${f.from}`, 'unsafe_archive');
        // Support files (textures, sounds) that already exist are shared with other maps: keep them.
        if ((await exists(target)) && !own.has(f.to)) {
          kept.push(f.to);
          continue;
        }
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(path.join(content, ...f.from.split('/')), target);
        written.push(f.to);
      }
      state.installs[String(gbId)] = {
        gbId,
        name: detail.name,
        fileId: file.id,
        fileName: file.name,
        thumbnail: detail.thumbnail,
        maps: plan.maps,
        files: [...new Set([...written, ...(previous?.files.filter((f) => !written.includes(f) && own.has(f)) ?? [])])],
        installedAt: new Date().toISOString(),
      };
      await saveMapsState(server.id, state);
      return { maps: plan.maps, files: written.length, kept: kept.length, skipped: plan.skipped.length, rejected: rejected.map((r) => r.map) };
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Controls

async function botEngineOf(server: ServerRow): Promise<BotEngine> {
  const state = await loadState(pluginStateFile(server.id));
  return state.plugins.yapb && state.plugins.metamod ? 'yapb' : 'stock';
}

export async function controlsOverview(server: ServerRow) {
  cs16Def(server);
  const running = runtime.getStatus(server.id) === 'running';
  let status: StatusInfo = { map: null, players: [] };
  if (running) {
    const lines = await runtime.captureCommand(server.id, 'status', { until: END_LINE, then: [END_COMMAND], timeoutMs: 4000 });
    status = parseStatus(lines);
  }
  const values = readMatchSettings(await readText(path.join(csRoot(server.id), 'server.cfg')));
  const [maps, engine] = await Promise.all([installedMaps(server.id), botEngineOf(server)]);
  return {
    running,
    map: status.map,
    players: status.players,
    maps: maps.map((m) => m.name),
    bots: { engine },
    settings: MATCH_SETTINGS.map((s) => ({ ...s, value: values[s.key] ?? s.default })),
  };
}

export async function changeMap(server: ServerRow, input: { map?: unknown; persist?: boolean }) {
  cs16Def(server);
  const map = assertMap(input.map);
  if (!(await installedMaps(server.id)).some((m) => m.name === map)) throw badRequest('That map is not installed', 'map_not_installed');
  await run(server, [changeLevelCommand(map)]);
  if (input.persist) await updateSteamConfig(server.id, (cur) => ({ ...cur, vars: { ...cur.vars, map } }));
  return { map };
}

export async function restartMatch(server: ServerRow, kind: unknown) {
  cs16Def(server);
  await run(server, [restartCommand(kind)]);
}

export async function say(server: ServerRow, message: unknown) {
  cs16Def(server);
  await run(server, [sayCommand(message)]);
}

export async function kickPlayer(server: ServerRow, userId: number, reason?: string) {
  cs16Def(server);
  await run(server, [kickCommand(userId, reason)]);
}

export async function banPlayer(server: ServerRow, userId: unknown, minutes: unknown) {
  cs16Def(server);
  const id = assertUserId(userId);
  await run(server, banCommands(id, minutes as number));
}

export async function botAction(server: ServerRow, input: unknown) {
  cs16Def(server);
  const req = assertBotRequest(input);
  const engine = await botEngineOf(server);
  const commands = botCommands(engine, req);
  if (!commands) throw conflict('The YaPB bots do not have that option: it is set in addons/yapb/conf/yapb.cfg', 'bot_unsupported');
  await run(server, commands);
  return { engine };
}

/** Apply match settings: running servers get them now, and they are written to `server.cfg` for the next start. */
export async function applySettings(server: ServerRow, input: unknown) {
  cs16Def(server);
  const values: MatchValues = assertMatchSettings(input);
  if (!Object.keys(values).length) throw badRequest('No settings given', 'invalid_settings');
  const root = await requireGameFiles(server);
  const file = path.join(root, 'server.cfg');
  await fsp.writeFile(file, applyCvars(await readText(file), values));
  let appliedLive = false;
  if (runtime.isRunning(server.id)) {
    for (const c of settingCommands(values)) await runtime.sendCommand(server.id, c).catch(() => undefined);
    appliedLive = true;
  }
  return { settings: values, appliedLive };
}

// ---------------------------------------------------------------------------------------------
// Plugins

type PluginState = Awaited<ReturnType<typeof loadState>>;

const publicPlugin = (p: Cs16PluginDef, rec: PluginState['plugins'][string] | undefined, state: PluginState) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  homepage: p.homepage,
  category: p.category,
  requires: p.requires,
  missingRequires: p.requires.filter((r) => !state.plugins[r]),
  requiredBy: CS16_PLUGIN_CATALOG.filter((o) => o.requires.includes(p.id) && state.plugins[o.id]).map((o) => o.id),
  settings: [] as never[],
  installed: rec ? { version: rec.version, installedAt: rec.installedAt, files: rec.files.length, platform: 'linux' as const } : null,
  platformMismatch: false,
});

export async function pluginsOverview(server: ServerRow) {
  cs16Def(server);
  const state = await loadState(pluginStateFile(server.id));
  return {
    gameInstalled: await isDir(csRoot(server.id)),
    platform: 'linux' as const,
    plugins: CS16_PLUGIN_CATALOG.map((p) => publicPlugin(p, state.plugins[p.id], state)),
  };
}

/** Make Metamod's `plugins.ini` list exactly the installed plugins that need a line. */
async function syncMetamod(root: string, def: Cs16PluginDef, install: boolean): Promise<void> {
  const file = path.join(root, ...METAMOD_PLUGINS_INI.split('/'));
  if (def.id === 'metamod') {
    // An empty file keeps Metamod from complaining on its first start.
    if (install && !(await exists(file))) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, '; Metamod plugins: managed by ServCrafty for the plugins installed from the Plugins tab\n');
    }
    return;
  }
  if (!def.metamodLine) return;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const text = await readText(file);
  await fsp.writeFile(file, install ? addMetamodLine(text, def.metamodLine) : removeMetamodLine(text, def.metamodLine));
}

export async function installPlugin(server: ServerRow, id: string, deps: InstallDeps = defaultDeps) {
  cs16Def(server);
  const target = pluginById(id);
  if (!target) throw badRequest('Unknown plugin', 'unknown_plugin');
  const root = await requireGameFiles(server);
  return exclusive(server.id, async () => {
    const state = await loadState(pluginStateFile(server.id));
    const done: string[] = [];
    for (const p of withDependencies(id)) {
      const isTarget = p.id === id;
      if (state.plugins[p.id] && !isTarget) continue;
      const files: string[] = [];
      let version: string | null = null;
      for (const source of sourcesFor(p, 'linux')) {
        const r = await installSource(root, source, deps);
        files.push(...r.files, ...r.kept);
        version ??= r.version;
      }
      const prev = state.plugins[p.id];
      if (prev) await removeFiles(root, prev.files.filter((f) => !files.includes(f)));
      await syncMetamod(root, p, true);
      state.plugins[p.id] = { platform: 'linux', version, installedAt: new Date().toISOString(), files: [...new Set(files)], settings: {} };
      await saveState(pluginStateFile(server.id), state);
      done.push(p.id);
    }
    return { installed: done, restartRequired: runtime.isRunning(server.id) };
  });
}

export async function uninstallPlugin(server: ServerRow, id: string) {
  cs16Def(server);
  const p = pluginById(id);
  if (!p) throw badRequest('Unknown plugin', 'unknown_plugin');
  const root = await requireGameFiles(server);
  return exclusive(server.id, async () => {
    const state = await loadState(pluginStateFile(server.id));
    const rec = state.plugins[id];
    if (!rec) throw conflict('This plugin is not installed', 'plugin_not_installed');
    const users = CS16_PLUGIN_CATALOG.filter((o) => o.requires.includes(id) && state.plugins[o.id]).map((o) => o.name);
    if (users.length) throw conflict(`Needed by: ${users.join(', ')}. Remove those first`, 'plugin_required');
    await removeFiles(root, rec.files);
    await syncMetamod(root, p, false);
    delete state.plugins[id];
    await saveState(pluginStateFile(server.id), state);
    return { restartRequired: runtime.isRunning(server.id) };
  });
}
