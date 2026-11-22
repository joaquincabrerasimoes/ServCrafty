import fsp from 'node:fs/promises';
import path from 'node:path';
import { badRequest, conflict } from '../lib/errors.js';
import { assertSteam } from '../lib/games.js';
import type { GameDefinition } from '../lib/gameDefinition.js';
import { scanGame, firstMap, GAME_MODES, type GameCatalog, type GameMode } from '../lib/l4d2/campaigns.js';
import {
  assertDifficulty,
  assertMap,
  assertMode,
  changeLevelCommands,
  difficultyCommand,
  DIFFICULTIES,
  addBotCommand,
  spawnCommand,
  parseSpawn,
  SURVIVORS_MAX,
  SURVIVORS_MIN,
  survivorsCommand,
  CHARACTERS,
  CHEAT_REFUSED,
  giveCommand,
  parseAddBot,
  parseCheatsState,
  parseSurvivorList,
  ITEM_GROUPS,
  kickCommand,
  parseStatus,
  STATUS_END,
  type StatusInfo,
} from '../lib/l4d2/control.js';
import { PLUGIN_CATALOG, pluginById, sourcesFor, withDependencies, type PluginDef, type PluginPlatform } from '../lib/l4d2/pluginCatalog.js';
import { effectivePlatform } from '../lib/steamPlan.js';
import {
  installSource,
  loadState,
  normalizeSettings,
  removeFiles,
  saveState,
  settingCommands,
  writeSettings,
  type InstallDeps,
  defaultDeps,
  type SettingValues,
} from '../lib/l4d2/pluginInstall.js';
import { requireDefinition } from './gameDefinitions.js';
import { serverDir } from './docker.js';
import * as runtime from './runtime.js';
import { updateSteamConfig } from './servers.js';
import type { ServerRow } from './types.js';

/**
 * Left 4 Dead 2 integration (definitions with `profile: "l4d2"`): campaigns and maps read from the game
 * files, console controls, and the plugin store. Files live in `<server dir>/game/left4dead2`.
 */

export function l4d2Def(server: ServerRow): GameDefinition {
  assertSteam(server, 'This feature');
  const def = requireDefinition(server.steam!.gameId);
  if (def.profile !== 'l4d2') throw badRequest('This feature is only available for Left 4 Dead 2 servers', 'unsupported_game');
  return def;
}

const gameDir = (id: string) => path.join(serverDir(id), 'game');
const l4dRoot = (id: string) => path.join(gameDir(id), 'left4dead2');
const stateFile = (id: string) => path.join(serverDir(id), 'servcrafty-plugins.json');

const installed = (dir: string) => fsp.stat(dir).then((s) => s.isDirectory(), () => false);

// ---------------------------------------------------------------------------------------------
// Maps

export interface WorkshopAddon {
  id: string;
  title: string;
  /** The addon file exists in left4dead2/addons (it is installed at start). */
  installed: boolean;
}

export async function mapsOverview(server: ServerRow) {
  const def = l4d2Def(server);
  const catalog: GameCatalog = await scanGame(gameDir(server.id));
  const workshop: WorkshopAddon[] = (server.steam?.workshop ?? []).map((w) => ({
    id: w.id,
    title: w.title ?? w.id,
    installed: catalog.addons.some((a) => a.workshopId === w.id),
  }));
  let current: string | null = null;
  if (runtime.getStatus(server.id) === 'running') {
    try {
      current = (await runtime.getStats(server)).map ?? null;
    } catch {
      current = null;
    }
  }
  const vars = server.steam?.vars ?? {};
  const str = (k: string, d: string) => (typeof vars[k] === 'string' ? (vars[k] as string) : (def.variables.find((v) => v.key === k)?.default as string | undefined) ?? d);
  return {
    gameInstalled: await installed(l4dRoot(server.id)),
    ...catalog,
    workshop,
    modes: GAME_MODES,
    current: { map: current },
    start: { map: str('map', 'c2m1_highway'), gameMode: str('gameMode', 'coop'), difficulty: str('difficulty', 'Normal') },
  };
}

// ---------------------------------------------------------------------------------------------
// Controls

async function run(server: ServerRow, commands: string[]): Promise<void> {
  if (!runtime.isRunning(server.id)) throw conflict('The server is not running', 'not_running');
  for (const c of commands) await runtime.sendCommand(server.id, c);
}

export async function controlsOverview(server: ServerRow) {
  l4d2Def(server);
  const running = runtime.getStatus(server.id) === 'running';
  let status: StatusInfo = { map: null, players: [] };
  if (running) {
    const lines = await runtime.captureCommand(server.id, 'status', { until: STATUS_END, timeoutMs: 4000 });
    status = parseStatus(lines);
  }
  const vars = server.steam?.vars ?? {};
  // The bundled plugin lists the survivors with their character; without it the choice of character is not available.
  let survivors: ReturnType<typeof parseSurvivorList> = null;
  if (running) survivors = parseSurvivorList(await runtime.sendCommand(server.id, 'sc_survivors').catch(() => ''));
  const used = new Set((survivors ?? []).map((x) => x.character));
  return {
    running,
    team: { size: survivors?.length ?? null, min: SURVIVORS_MIN, max: SURVIVORS_MAX, available: survivors !== null },
    bots: { available: survivors !== null, characters: CHARACTERS.map((c) => ({ ...c, inUse: used.has(c.id) })) },
    map: status.map,
    players: status.players,
    difficulties: DIFFICULTIES,
    modes: GAME_MODES,
    items: ITEM_GROUPS,
    start: { gameMode: typeof vars.gameMode === 'string' ? vars.gameMode : 'coop', difficulty: typeof vars.difficulty === 'string' ? vars.difficulty : 'Normal' },
  };
}

/** Change the map (and game mode); with `persist` it also becomes the map and mode the server starts with. */
export async function changeMap(server: ServerRow, input: { map?: unknown; campaign?: unknown; mode?: unknown; persist?: boolean }) {
  l4d2Def(server);
  const mode: GameMode | undefined = input.mode === undefined ? undefined : assertMode(input.mode);
  let map: string;
  if (typeof input.campaign === 'string') {
    const catalog = await scanGame(gameDir(server.id));
    const c = catalog.campaigns.find((x) => x.id === input.campaign);
    if (!c) throw badRequest('Unknown campaign', 'unknown_campaign');
    const first = firstMap(c, mode ?? 'coop');
    if (!first) throw badRequest('This campaign has no chapters for that game mode', 'campaign_mode_unsupported');
    map = first;
  } else map = assertMap(input.map);
  await run(server, changeLevelCommands(map, mode));
  if (input.persist) {
    await updateSteamConfig(server.id, (cur) => ({ ...cur, vars: { ...cur.vars, map, ...(mode ? { gameMode: mode } : {}) } }));
  }
  return { map, mode: mode ?? null };
}

export async function changeDifficulty(server: ServerRow, difficulty: unknown, persist = false) {
  l4d2Def(server);
  const d = assertDifficulty(difficulty);
  await run(server, [difficultyCommand(d)]);
  if (persist) await updateSteamConfig(server.id, (cur) => ({ ...cur, vars: { ...cur.vars, difficulty: d } }));
  return { difficulty: d };
}

export async function kickPlayer(server: ServerRow, userId: number, reason?: string) {
  l4d2Def(server);
  await run(server, [kickCommand(userId, reason)]);
}

/**
 * Run `fn` with cheats on and put them back afterwards. `script` (the way items are given) is a cheat command: with
 * `sv_cheats 0` the game refuses it and prints "Can't use cheat command", which the panel used to ignore, so giving
 * an item silently did nothing. Cheats stay on for the moment of the command only, and are restored even when it fails.
 */
async function withCheats<T>(server: ServerRow, fn: () => Promise<T>): Promise<T> {
  const was = parseCheatsState(await runtime.sendCommand(server.id, 'sv_cheats'));
  if (was === true) return fn();
  await runtime.sendCommand(server.id, 'sv_cheats 1');
  try {
    return await fn();
  } finally {
    await runtime.sendCommand(server.id, 'sv_cheats 0').catch(() => undefined);
  }
}

export async function givePlayer(server: ServerRow, userId: number, item: string) {
  l4d2Def(server);
  const command = giveCommand(userId, item);
  if (!runtime.isRunning(server.id)) throw conflict('The server is not running', 'not_running');
  const out = await withCheats(server, () => runtime.sendCommand(server.id, command));
  if (CHEAT_REFUSED.test(out)) throw conflict('The game refused the command', 'give_refused');
}

const BOT_ERRORS: Record<string, string> = {
  team_full: 'The team is full (16 survivors)',
  no_bot: 'The game did not create the bot',
  unknown_character: 'Unknown survivor',
  usage: 'Unknown survivor',
};

/** Set the team size (survivors, people plus bots): the Multiplayer plugin adds or removes bots to match. */
export async function setTeamSize(server: ServerRow, count: number) {
  l4d2Def(server);
  const command = survivorsCommand(count);
  if (!runtime.isRunning(server.id)) throw conflict('The server is not running', 'not_running');
  const out = await runtime.sendCommand(server.id, command);
  if (/Unknown command/i.test(out)) throw conflict('Install the "Multiplayer (more than 4 survivors)" plugin from the Plugins tab to change the team size', 'plugin_required');
  return { survivors: count };
}

/** Add one survivor bot of the chosen character (0-7). Needs the bundled "Bot spawner" plugin (which needs Multiplayer). */
export async function addBot(server: ServerRow, character: number) {
  l4d2Def(server);
  const command = addBotCommand(character);
  if (!runtime.isRunning(server.id)) throw conflict('The server is not running', 'not_running');
  const r = parseAddBot(await runtime.sendCommand(server.id, command));
  if (!r) throw conflict('Install the "Bot spawner" plugin from the Plugins tab to add bots of a chosen character', 'plugin_required');
  if (!r.ok) throw conflict(BOT_ERRORS[r.error] ?? 'The bot could not be added', `bot_${r.error}`);
  return { userId: r.userId, name: r.name };
}

const SPAWN_ERRORS: Record<string, string> = {
  no_survivor: 'There is no living survivor to spawn the infected near',
  no_spawn: 'The game found no place to spawn it right now, try again in a moment',
  unknown_kind: 'Unknown infected',
  bad_count: 'The amount must be from 1 to 10',
  usage: 'Unknown infected',
};

/** Send a horde or special infected at the survivors (the bundled "Bot spawner" plugin runs the cheat command). */
export async function spawnThreat(server: ServerRow, kind: string, count: number) {
  l4d2Def(server);
  const command = spawnCommand(kind, count);
  if (!runtime.isRunning(server.id)) throw conflict('The server is not running', 'not_running');
  const r = parseSpawn(await runtime.sendCommand(server.id, command));
  if (!r) throw conflict('Install the "Bot spawner" plugin from the Plugins tab to spawn hordes and special infected', 'plugin_required');
  if (!r.ok) throw conflict(SPAWN_ERRORS[r.error] ?? 'The infected could not be spawned', `spawn_${r.error}`);
  return { kind: r.kind, count: r.count };
}

// ---------------------------------------------------------------------------------------------
// Plugins

const busy = new Set<string>();

async function exclusive<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(serverId)) throw conflict('Another plugin operation is running for this server', 'plugin_busy');
  busy.add(serverId);
  try {
    return await fn();
  } finally {
    busy.delete(serverId);
  }
}

async function requireGameFiles(server: ServerRow): Promise<string> {
  const root = l4dRoot(server.id);
  if (!(await installed(root))) throw conflict('The game files are not installed yet: start the server once and try again', 'game_not_installed');
  return root;
}

type PluginState = Awaited<ReturnType<typeof loadState>>;

/** Platform the server runs on (Linux native or the Windows build under Wine). */
const platformOf = (server: ServerRow, def: GameDefinition): PluginPlatform => effectivePlatform(def, server.steam ?? {});
const recordPlatform = (rec: PluginState['plugins'][string]): PluginPlatform => rec.platform ?? 'linux';

const publicPlugin = (p: PluginDef, rec: PluginState['plugins'][string] | undefined, state: PluginState, platform: PluginPlatform) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  homepage: p.homepage,
  category: p.category,
  requires: p.requires,
  missingRequires: p.requires.filter((r) => !state.plugins[r]),
  requiredBy: PLUGIN_CATALOG.filter((o) => o.requires.includes(p.id) && state.plugins[o.id]).map((o) => o.id),
  settings: p.settings.map((s) => ({ ...s, value: rec?.settings[s.key] ?? s.default })),
  installed: rec ? { version: rec.version, installedAt: rec.installedAt, files: rec.files.length, platform: recordPlatform(rec) } : null,
  /** Installed for the other platform: install it again to get the files for the current one. */
  platformMismatch: !!rec && recordPlatform(rec) !== platform,
});

export async function pluginsOverview(server: ServerRow) {
  const def = l4d2Def(server);
  const platform = platformOf(server, def);
  const state = await loadState(stateFile(server.id));
  return {
    gameInstalled: await installed(l4dRoot(server.id)),
    platform,
    plugins: PLUGIN_CATALOG.map((p) => publicPlugin(p, state.plugins[p.id], state, platform)),
  };
}

/** Apply settings to a running server (they are also in the cfg file for the next start). */
async function applyLive(server: ServerRow, values: SettingValues): Promise<void> {
  if (!runtime.isRunning(server.id)) return;
  for (const c of settingCommands(values)) await runtime.sendCommand(server.id, c).catch(() => undefined);
}

/** Install a plugin together with everything it needs; installing an installed plugin updates it. */
export async function installPlugin(server: ServerRow, id: string, settingsInput?: unknown, deps: InstallDeps = defaultDeps) {
  const platform = platformOf(server, l4d2Def(server));
  const target = pluginById(id);
  if (!target) throw badRequest('Unknown plugin', 'unknown_plugin');
  const root = await requireGameFiles(server);
  return exclusive(server.id, async () => {
    const state = await loadState(stateFile(server.id));
    const done: string[] = [];
    for (const p of withDependencies(id)) {
      const isTarget = p.id === id;
      const have = state.plugins[p.id];
      if (have && !isTarget && recordPlatform(have) === platform) continue;
      // `files` = everything the plugin owns now: written by this install plus the user-edited files it kept.
      // (Kept files must stay listed: otherwise the cleanup below would delete them as "no longer shipped".)
      const files: string[] = [];
      let version: string | null = null;
      for (const source of sourcesFor(p, platform)) {
        const r = await installSource(root, source, deps);
        files.push(...r.files, ...r.kept);
        version ??= r.version;
      }
      const prev = state.plugins[p.id];
      const settings = normalizeSettings(p, isTarget && settingsInput ? settingsInput : {}, prev?.settings);
      await writeSettings(root, p, settings);
      // Files of an older install that the new version no longer ships.
      if (prev) await removeFiles(root, prev.files.filter((f) => !files.includes(f)));
      state.plugins[p.id] = { platform, version, installedAt: new Date().toISOString(), files: [...new Set(files)], settings };
      await saveState(stateFile(server.id), state);
      done.push(p.id);
    }
    return { installed: done, restartRequired: runtime.isRunning(server.id) };
  });
}

export async function uninstallPlugin(server: ServerRow, id: string) {
  l4d2Def(server);
  if (!pluginById(id)) throw badRequest('Unknown plugin', 'unknown_plugin');
  const root = await requireGameFiles(server);
  return exclusive(server.id, async () => {
    const state = await loadState(stateFile(server.id));
    const rec = state.plugins[id];
    if (!rec) throw conflict('This plugin is not installed', 'plugin_not_installed');
    const users = PLUGIN_CATALOG.filter((o) => o.requires.includes(id) && state.plugins[o.id]).map((o) => o.name);
    if (users.length) throw conflict(`Needed by: ${users.join(', ')}. Remove those first`, 'plugin_required');
    await removeFiles(root, rec.files);
    delete state.plugins[id];
    await saveState(stateFile(server.id), state);
    return { restartRequired: runtime.isRunning(server.id) };
  });
}

export async function updatePluginSettings(server: ServerRow, id: string, input: unknown) {
  l4d2Def(server);
  const p = pluginById(id);
  if (!p) throw badRequest('Unknown plugin', 'unknown_plugin');
  const root = await requireGameFiles(server);
  return exclusive(server.id, async () => {
    const state = await loadState(stateFile(server.id));
    const rec = state.plugins[id];
    if (!rec) throw conflict('Install the plugin first', 'plugin_not_installed');
    const settings = normalizeSettings(p, input, rec.settings);
    await writeSettings(root, p, settings);
    rec.settings = settings;
    await saveState(stateFile(server.id), state);
    await applyLive(server, settings);
    return { settings, appliedLive: runtime.isRunning(server.id) };
  });
}
