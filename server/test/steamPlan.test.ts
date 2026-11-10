import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AppError } from '../src/lib/errors.js';
import { parseDefinition, type GameDefinition } from '../src/lib/gameDefinition.js';
import { capabilitiesOf, gameOf, steamImage } from '../src/lib/games.js';
import { steamContainerSpec } from '../src/lib/steamContainer.js';
import { cleanSteamLine, parseSteamLine, replaySteamLog, steamMatchers } from '../src/lib/steamLog.js';
import {
  buildPlan,
  isTruthy,
  mergeSteamConfig,
  normalizeSteamConfig,
  normalizeSteamVars,
  publicSteamConfig,
  publishedPorts,
  renderWebuiAuth,
  resolvePorts,
  type SteamConfig,
} from '../src/lib/steamPlan.js';
import { includeInBackup } from '../src/services/backups.js';
import { assertCanModify, canAuthorGames } from '../src/services/gameDefinitions.js';
import { choosePorts } from '../src/services/portAlloc.js';
import { assertGameFields } from '../src/services/servers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const def: GameDefinition = parseDefinition(JSON.parse(readFileSync(path.join(here, 'fixtures', 'games', 'test-game.json'), 'utf8')));

const errOf = (fn: () => unknown): AppError | null => {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  return null;
};

test('gameOf/capabilities for STEAMCMD', () => {
  assert.equal(gameOf('STEAMCMD'), 'steam');
  assert.equal(capabilitiesOf('STEAMCMD').hasSteamConfig, true);
  assert.equal(capabilitiesOf('STEAMCMD').hasRcon, false);
  assert.equal(capabilitiesOf('PAPER').hasSteamConfig, false);
});

test('steam image: owner from the update repo, version tag, overrides', () => {
  assert.equal(steamImage({ updateRepo: 'JoaquinX/ServCrafty', appVersion: '0.3.0' }), 'ghcr.io/joaquinx/servcrafty-steamcmd:0.3.0');
  assert.equal(steamImage({ updateRepo: 'a/b', appVersion: '0.3.0', forcedTag: 'latest' }), 'ghcr.io/a/servcrafty-steamcmd:latest');
  assert.equal(steamImage({ updateRepo: 'a/b', appVersion: '0.3.0', forcedTag: 'bad tag;x' }), 'ghcr.io/a/servcrafty-steamcmd:0.3.0');
  assert.equal(steamImage({ updateRepo: 'a/b', appVersion: '0.3.0', override: 'registry.local/steam:dev' }), 'registry.local/steam:dev');
  assert.equal(steamImage({ updateRepo: 'a/b', appVersion: '0.3.0', override: 'bad image;rm' }), 'ghcr.io/a/servcrafty-steamcmd:0.3.0');
});

test('vars: defaults filled, coercion, unknown keys rejected', () => {
  const v = normalizeSteamVars(def, { maxPlayers: '12', pvp: 'true' });
  assert.deepEqual(v, {
    serverName: 'My server',
    maxPlayers: 12,
    password: '',
    adminPassword: 'changeme',
    pvp: true,
    mode: 'coop',
    mapList: 'a,b',
  });
  const e = errOf(() => normalizeSteamVars(def, { nope: 1 }));
  assert.equal(e?.code, 'invalid_steam_config');
  assert.deepEqual((e?.details as { path: string }[]).map((d) => d.path), ['vars.nope']);
  // Lenient mode (stored config after a definition change) drops unknown keys.
  assert.equal(normalizeSteamVars(def, { nope: 1 }, { lenient: true }).nope, undefined);
});

test('vars: validation errors carry details for every bad field', () => {
  const e = errOf(() =>
    normalizeSteamVars(def, { maxPlayers: 0, serverName: '', mode: 'pvp', pvp: 'maybe', password: 'a\nb', mapList: 'x'.repeat(1001) }),
  );
  assert.equal(e?.status, 400);
  const paths = (e?.details as { path: string }[]).map((d) => d.path).sort();
  assert.deepEqual(paths, ['vars.mapList', 'vars.maxPlayers', 'vars.mode', 'vars.password', 'vars.pvp', 'vars.serverName']);
  assert.equal(errOf(() => normalizeSteamVars(def, { maxPlayers: 2.5 }))?.code, 'invalid_steam_config');
  assert.equal(errOf(() => normalizeSteamVars(def, { serverName: 'x'.repeat(65) }))?.code, 'invalid_steam_config');
});

test('vars: patterns match the whole value', () => {
  const d = parseDefinition({
    ...JSON.parse(JSON.stringify(def)),
    variables: [{ key: 'tag', label: 'Tag', type: 'string', pattern: '[a-z]+' }],
    launch: { command: ['./x'] },
    files: [],
    webui: [],
  });
  assert.equal(normalizeSteamVars(d, { tag: 'abc' }).tag, 'abc');
  assert.equal(errOf(() => normalizeSteamVars(d, { tag: 'abc1' }))?.code, 'invalid_steam_config');
  assert.equal(normalizeSteamVars(d, { tag: '' }).tag, ''); // optional + empty is allowed
});

test('config: create and PATCH merge', () => {
  const cfg = normalizeSteamConfig(def, { gameId: 'test-game', vars: { serverName: 'S' }, workshop: [{ id: '42' }, { id: '42' }] });
  assert.equal(cfg.updateOnStart, true);
  assert.equal(cfg.validateNext, false);
  assert.deepEqual(cfg.workshop, [{ id: '42' }]);
  assert.equal(errOf(() => normalizeSteamConfig(def, { gameId: 'other', vars: {} }))?.code, 'invalid_steam_config');
  assert.equal(errOf(() => normalizeSteamConfig(def, { gameId: 'test-game', vars: {}, extra: 1 } as never))?.code, 'invalid_steam_config');

  const merged = mergeSteamConfig(def, { ...cfg, vars: { ...cfg.vars, gone: 'x' } }, { vars: { maxPlayers: 20, serverName: null }, updateOnStart: false });
  assert.equal(merged.vars.maxPlayers, 20);
  assert.equal(merged.vars.serverName, 'My server'); // null = back to the default
  assert.equal(merged.vars.gone, undefined);
  assert.equal(merged.updateOnStart, false);
  assert.deepEqual(merged.workshop, [{ id: '42' }]);
  assert.equal(errOf(() => mergeSteamConfig(def, cfg, { gameId: 'other' }))?.code, 'game_change_unsupported');
  assert.equal(errOf(() => mergeSteamConfig(def, cfg, { vars: { unknown: 1 } }))?.code, 'invalid_steam_config');
});

test('secret vars are blanked below manager', () => {
  const cfg = normalizeSteamConfig(def, { gameId: 'test-game', vars: { password: 'hunter2', adminPassword: 'root' } });
  const low = publicSteamConfig({ ...cfg, workshopRefresh: true }, def, false)!;
  assert.equal(low.vars.password, '');
  assert.equal(low.vars.adminPassword, '');
  assert.equal(low.vars.serverName, 'My server');
  assert.equal('workshopRefresh' in low, false);
  assert.equal(publicSteamConfig(cfg, def, true)!.vars.adminPassword, 'root');
  // Unknown definition: every string is treated as secret.
  assert.equal(publicSteamConfig(cfg, null, false)!.vars.serverName, '');
  assert.equal(publicSteamConfig(cfg, null, false)!.vars.maxPlayers, 8);
});

test('ports: published list, resolution with mirror and unpublished ports', () => {
  assert.deepEqual(
    publishedPorts(def).map((p) => p.id),
    ['game', 'query'],
  );
  const r = resolvePorts(def, 25570, { query: 25571 });
  assert.deepEqual(
    r.map((p) => [p.id, p.containerPort, p.hostPort]),
    [
      ['game', 7777, 25570],
      ['query', 25571, 25571],
      ['web', 8080, null],
    ],
  );
  assert.equal(errOf(() => resolvePorts(def, 25570, {}))?.code, 'port_not_allocated');
  // A mirror port landing on another declared container port is refused.
  assert.equal(errOf(() => resolvePorts(def, 25570, { query: 7777 }))?.code, 'port_conflict');
});

test('port allocation from the pool', () => {
  const pool = [25565, 25566, 25567, 25568];
  assert.deepEqual(choosePorts(pool, new Set([25565]), 2, undefined, 'no_free_ports'), [25566, 25567]);
  assert.deepEqual(choosePorts(pool, new Set(), 2, 25567, 'no_free_ports'), [25567, 25565]);
  assert.equal(errOf(() => choosePorts(pool, new Set([25565, 25566, 25567]), 2, undefined, 'no_free_ports'))?.code, 'no_free_ports');
  assert.equal(errOf(() => choosePorts(pool, new Set([25566]), 1, 25566, 'x'))?.code, 'port_in_use');
  assert.equal(errOf(() => choosePorts(pool, new Set(), 1, 1, 'x'))?.code, 'port_not_in_pool');
  assert.equal(errOf(() => choosePorts(pool, new Set(pool), 1, undefined, 'port_pool_exhausted'))?.code, 'port_pool_exhausted');
});

function steamCfg(vars: SteamConfig['vars'], extra: Partial<SteamConfig> = {}): SteamConfig {
  return { gameId: 'test-game', vars, workshop: [{ id: '111' }, { id: '222', title: 'Map' }], updateOnStart: true, validateNext: false, ...extra };
}

test('plan: argv conditionals, templates, valueMap, files, workshop', () => {
  const { plan, ports } = buildPlan(def, {
    serverId: 'srv-1',
    serverName: 'Alpha',
    steam: steamCfg({ serverName: 'Hello "World"', maxPlayers: 16, password: '', pvp: true, mapList: 'x, y,,z' }),
    mainHostPort: 25570,
    extraPorts: { query: 25571 },
  });
  assert.equal(ports.length, 3);
  assert.deepEqual(plan.launch.argv, ['./server.sh', '-Port=7777', '-QueryPort=25571', '-Name=Hello "World"', '-PvP=True']);
  assert.deepEqual(plan.launch.env, { SERVER_ID: 'srv-1' });
  assert.equal(plan.launch.cwd, 'bin');
  assert.deepEqual(plan.files[0], { type: 'template', path: 'Config/server.cfg', when: 'always', content: 'name=Hello "World"\nmax=16\nmode=coop\n' });
  assert.deepEqual(plan.files[1], {
    type: 'ini',
    path: 'Config/Engine.ini',
    when: 'always',
    set: [{ section: 'Engine.GameInfo', key: 'MaxPlayers', value: '16' }],
    list: [
      { section: 'OnlineSubsystemSteamworks.KFWorkshopSteamworks', key: 'ServerSubscribedWorkshopItems', values: ['111', '222'] },
      { section: 'Maps', key: 'Map', values: ['x', 'y', 'z'] },
    ],
  });
  assert.deepEqual(plan.workshop, { appId: 232090, ids: ['111', '222'], install: 'config-list', dir: null });
  assert.deepEqual(plan.steam, {
    appId: 123456,
    branch: null,
    betaPassword: null,
    platform: 'linux',
    login: 'anonymous',
    validate: false,
    update: true,
  });
  assert.deepEqual(plan.stop, { type: 'stdin', signal: 'SIGINT', command: 'quit', timeoutSec: 30 });
  assert.deepEqual(plan.console, { stdin: true });
  assert.deepEqual(plan.ready, { logRegex: 'Server is ready' });
  assert.deepEqual(plan.scripts, { postInstall: 'echo installed', preStart: 'echo starting' });
  assert.equal(plan.serverName, 'Alpha');
  assert.equal(plan.schema, 1);
});

test('plan: password included when set; validate implies update; updateOnStart false', () => {
  const a = buildPlan(def, {
    serverId: 's',
    serverName: 'n',
    steam: steamCfg({ password: 'p@ss word' }, { validateNext: true, updateOnStart: false }),
    mainHostPort: 1,
    extraPorts: { query: 2 },
  }).plan;
  assert.ok(a.launch.argv.includes('-Password=p@ss word'));
  assert.equal(a.steam.validate, true);
  assert.equal(a.steam.update, true);
  const b = buildPlan(def, { serverId: 's', serverName: 'n', steam: steamCfg({}, { updateOnStart: false }), mainHostPort: 1, extraPorts: { query: 2 } }).plan;
  assert.equal(b.steam.update, false);
  assert.ok(!b.launch.argv.some((x) => x.startsWith('-Password')));
});

test('plan: stored values are re-validated before reaching the container', () => {
  assert.equal(
    errOf(() =>
      buildPlan(def, { serverId: 's', serverName: 'n', steam: steamCfg({ serverName: 'a\nb' }), mainHostPort: 1, extraPorts: { query: 2 } }),
    )?.code,
    'invalid_steam_config',
  );
});

test('truthiness of "if"', () => {
  for (const v of [undefined, '', false, 0, '0', 'false', 'FALSE']) assert.equal(isTruthy(v), false, String(v));
  for (const v of ['x', true, 1, 'no']) assert.equal(isTruthy(v), true, String(v));
});

test('web UI basic auth is rendered from variables', () => {
  const a = renderWebuiAuth(def, 'webadmin', {
    serverId: 's',
    serverName: 'n',
    steam: steamCfg({ adminPassword: 's3cret' }),
    mainHostPort: 1,
    extraPorts: { query: 2 },
  });
  assert.deepEqual(a, { user: 'admin', password: 's3cret' });
  assert.equal(renderWebuiAuth(def, 'nope', { serverId: 's', serverName: 'n', steam: steamCfg({}), mainHostPort: 1, extraPorts: { query: 2 } }), null);
});

test('container spec: ports per protocol, binds, labels, tty, limits', () => {
  const ports = resolvePorts(def, 25570, { query: 25571 });
  const o = steamContainerSpec(
    { memoryMb: 4096, cpu: 2, image: 'img:1', ports, stdin: true },
    {
      name: 'servcrafty-x',
      hostDir: '/data/servers/x',
      hostPlanFile: '/data/steam-plans/x.json',
      network: 'servcrafty',
      labels: { 'servcrafty.server': 'x', 'servcrafty.managed': 'true' },
    },
  );
  assert.equal(o.Image, 'img:1');
  assert.equal(o.Tty, true);
  assert.equal(o.OpenStdin, true);
  assert.equal(o.Labels?.['servcrafty.game'], 'steam');
  assert.equal(o.Labels?.['servcrafty.server'], 'x');
  assert.deepEqual(o.ExposedPorts, { '7777/tcp': {}, '7777/udp': {}, '25571/udp': {}, '8080/tcp': {} });
  assert.deepEqual(o.HostConfig?.PortBindings, {
    '7777/tcp': [{ HostPort: '25570' }],
    '7777/udp': [{ HostPort: '25570' }],
    '25571/udp': [{ HostPort: '25571' }],
  });
  assert.deepEqual(o.HostConfig?.Binds, ['/data/servers/x:/data', '/data/steam-plans/x.json:/servcrafty/plan.json:ro']);
  assert.deepEqual(o.HostConfig?.RestartPolicy, { Name: 'no' });
  assert.equal(o.HostConfig?.NetworkMode, 'servcrafty');
  assert.equal(o.HostConfig?.Memory, 4096 * 1024 * 1024);
  assert.equal(o.HostConfig?.NanoCpus, 2e9);
  assert.equal(o.Cmd, undefined);
  assert.deepEqual(o.Env, ['SERVCRAFTY_PLAN=/servcrafty/plan.json']);
  const noStdin = steamContainerSpec({ memoryMb: 1024, cpu: 1, image: 'i', ports, stdin: false }, {
    name: 'n',
    hostDir: 'h',
    hostPlanFile: 'p',
    network: 'n',
    labels: {},
  });
  assert.equal(noStdin.Tty, false);
  assert.equal(noStdin.OpenStdin, false);
});

test('executor markers and SteamCMD progress', () => {
  assert.deepEqual(parseSteamLine('[servcrafty-steam] phase=install'), { kind: 'phase', phase: 'install' });
  assert.deepEqual(parseSteamLine('[servcrafty-steam] phase=bogus'), null);
  assert.deepEqual(parseSteamLine('[servcrafty-steam] progress=42.5'), { kind: 'progress', progress: 42.5 });
  assert.deepEqual(parseSteamLine('[servcrafty-steam] progress=140'), { kind: 'progress', progress: 100 });
  assert.deepEqual(parseSteamLine('[servcrafty-steam] error=app_update failed'), { kind: 'error', message: 'app_update failed' });
  assert.deepEqual(parseSteamLine(' Update state (0x61) downloading, progress: 12.34 (1 / 2)'), { kind: 'progress', progress: 12.3 });
  assert.equal(parseSteamLine('Player x joined'), null);
  assert.equal(cleanSteamLine('\x1b[32mhello\x1b[0m\x07 '), 'hello');
});

test('log replay rebuilds phase, readiness and players', () => {
  const m = steamMatchers(def);
  const r = replaySteamLog(
    [
      '[servcrafty-steam] phase=install',
      'Player early joined', // ignored: not launched yet
      '[servcrafty-steam] phase=launch',
      'Server is ready',
      'Player alice joined',
      'Player bob joined',
      'Player alice left',
    ],
    m,
  );
  assert.equal(r.phase, 'launch');
  assert.equal(r.ready, true);
  assert.deepEqual([...r.players], ['bob']);
  const inst = replaySteamLog(['[servcrafty-steam] phase=launch', '[servcrafty-steam] phase=install', '[servcrafty-steam] progress=10'], m);
  assert.equal(inst.phase, 'install');
  assert.equal(inst.progress, 10);
  assert.equal(inst.ready, false);
});

test('backups leave the game install, Workshop and SteamCMD home out by default', () => {
  const steam = { steam: true, includeGame: false };
  assert.equal(includeInBackup('./game/FactoryGame/Binaries/x', steam), false);
  assert.equal(includeInBackup('workshop/content/1', steam), false);
  assert.equal(includeInBackup('steam/config.vdf', steam), false);
  assert.equal(includeInBackup('saves/world.sav', steam), true);
  assert.equal(includeInBackup('./game/x', { steam: true, includeGame: true }), true);
  // Minecraft / Terraria behaviour is unchanged.
  assert.equal(includeInBackup('game/x', { steam: false, includeGame: false }), true);
  assert.equal(includeInBackup('logs/latest.log', { steam: false, includeGame: false }), false);
  assert.equal(includeInBackup('world/session.lock', { steam: false, includeGame: false }), false);
});

test('game-specific fields: steam servers reject other games\' fields and vice versa', () => {
  const code = (fn: () => void) => errOf(fn)?.code;
  assert.equal(code(() => assertGameFields('STEAMCMD', { minecraft: {} })), 'unsupported_game');
  assert.equal(code(() => assertGameFields('STEAMCMD', { terraria: {} })), 'unsupported_game');
  assert.equal(code(() => assertGameFields('STEAMCMD', { modpack: { source: 'file' } })), 'unsupported_game');
  assert.equal(code(() => assertGameFields('STEAMCMD', { lanAnnounce: true })), 'unsupported_game');
  assert.equal(code(() => assertGameFields('STEAMCMD', { javaArgs: '-Xmx1G' })), 'unsupported_game');
  assert.equal(code(() => assertGameFields('STEAMCMD', { mcVersion: '1.20.1' })), 'unsupported_game');
  assert.equal(code(() => assertGameFields('STEAMCMD', { memoryMb: 1024 }, 4096)), 'validation_error');
  assert.equal(code(() => assertGameFields('STEAMCMD', { memoryMb: 4096, mcVersion: 'LATEST' }, 4096)), undefined);
  assert.equal(code(() => assertGameFields('PAPER', { steam: { gameId: 'x' } })), 'unsupported_game');
  assert.equal(code(() => assertGameFields('TERRARIA', { steam: { gameId: 'x' } })), 'unsupported_game');
});

test('authoring permission: admins or granted users; non-admins only their own definitions; built-ins read-only', () => {
  assert.equal(canAuthorGames({ role: 'admin', can_author_games: false }), true);
  assert.equal(canAuthorGames({ role: 'user', can_author_games: true }), true);
  assert.equal(canAuthorGames({ role: 'user', can_author_games: false }), false);
  const custom = { definition: def, builtin: false, ownerId: 'u1', createdAt: null, updatedAt: null };
  const builtin = { ...custom, builtin: true, ownerId: null };
  const code = (fn: () => void) => errOf(fn)?.code;
  assert.equal(code(() => assertCanModify({ id: 'u2', role: 'user', can_author_games: false }, custom)), 'forbidden');
  assert.equal(code(() => assertCanModify({ id: 'u2', role: 'user', can_author_games: true }, custom)), 'forbidden');
  assert.equal(code(() => assertCanModify({ id: 'u1', role: 'user', can_author_games: true }, custom)), undefined);
  assert.equal(code(() => assertCanModify({ id: 'a', role: 'admin', can_author_games: false }, custom)), undefined);
  assert.equal(code(() => assertCanModify({ id: 'a', role: 'admin', can_author_games: false }, builtin)), 'builtin_readonly');
});

test('GET /games item: full definition without scripts or web UI credentials', async () => {
  const { definitionSummary } = await import('../src/services/gameDefinitions.js');
  const s = definitionSummary({ definition: def, builtin: true, ownerId: null, createdAt: null, updatedAt: null }) as Record<string, unknown>;
  assert.equal('scripts' in s, false);
  assert.deepEqual((s.webui as { auth: unknown; portId: string }[])[0]!.auth, { type: 'basic' });
  assert.equal((s.webui as { portId: string }[])[0]!.portId, 'web');
  assert.deepEqual(s.console, { stdin: true });
  assert.deepEqual(s.workshop, { appId: 232090, install: 'config-list' });
  assert.ok(s.query && s.players && s.variables && s.resources && s.launch);
  assert.equal(s.builtin, true);
  assert.equal(s.hasWorkshop, true);
  assert.equal(s.hasWebui, true);
});
