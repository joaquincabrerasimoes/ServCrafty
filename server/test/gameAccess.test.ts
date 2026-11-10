import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import archiver from 'archiver';
import { AppError } from '../src/lib/errors.js';
import {
  applyDisabledChange,
  assertStartAllowed,
  creatableGames,
  creationError,
  gameKeyLabel,
  normalizeDisabledGames,
  normalizeGameList,
  serversToStop,
  startBlocked,
  type DisabledGames,
} from '../src/lib/gameAccess.js';
import { gameKeyKind, serverGameKey, steamGameKey, steamIdOfKey } from '../src/lib/games.js';
import { parseDefinition } from '../src/lib/gameDefinition.js';
import {
  assertCanCreateServer,
  assertServerCanStart,
  existingGameKeys,
  getDisabledGames,
  publicUserWithGames,
  serverGameState,
  setGameAccessStoreForTest,
} from '../src/services/gameAccess.js';
import { registerDefinitionsForTest } from '../src/services/gameDefinitions.js';
import { importArchive } from '../src/services/modpack.js';
import { configOf, createServer } from '../src/services/servers.js';
import { instantiateTemplate, type TemplateRow } from '../src/services/templates.js';
import { toPublicServer, type ServerRow, type UserRow } from '../src/services/types.js';

const def = parseDefinition({
  schema: 1,
  id: 'access-game',
  name: 'Access Game',
  steam: { appId: 215360 },
  resources: { memoryMb: 1024, memoryMinMb: 512, cpu: 1 },
  ports: [{ id: 'game', label: 'Game', protocol: 'udp', containerPort: 7707 }],
  variables: [{ key: 'map', label: 'Map', type: 'string', default: 'KF-Farm' }],
  launch: { command: ['./ucc-bin', '{{map}}'] },
});
registerDefinitionsForTest([def], false);

const codeOf = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await fn();
  } catch (e) {
    return e instanceof AppError ? `${e.status} ${e.code}` : `other: ${(e as Error).message}`;
  }
  return undefined;
};

function user(role: 'admin' | 'user', id = role === 'admin' ? '00000000-0000-4000-8000-00000000000a' : '00000000-0000-4000-8000-00000000000b'): UserRow {
  return {
    id,
    username: role,
    email: null,
    password_hash: 'x',
    role,
    locale: 'en',
    theme: 'system',
    disabled: false,
    max_servers: null,
    max_ram_mb: null,
    max_cpu: null,
    max_disk_mb: null,
    totp_secret_enc: null,
    totp_enabled: false,
    can_author_games: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
}

function useStore(allowed: Record<string, string[]>, disabled: DisabledGames = {}): void {
  setGameAccessStoreForTest({
    allowedFor: async (id) => allowed[id] ?? [],
    loadDisabled: async () => disabled,
  });
}

const row = (over: Partial<ServerRow> = {}): ServerRow => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  owner_id: user('user').id,
  name: 'srv',
  type: 'PAPER',
  game: 'minecraft',
  mc_version: 'LATEST',
  loader_version: null,
  modpack: null,
  java_args: null,
  memory_mb: 2048,
  cpu: 2,
  disk_mb: null,
  port: 25565,
  env: {},
  minecraft: null,
  terraria: null,
  steam: null,
  extra_ports: {},
  container_id: null,
  status: 'stopped',
  auto_restart: true,
  auto_start: false,
  stopped_by_user: false,
  lan_announce: false,
  rcon_password: 'x',
  created_at: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

test.after(() => setGameAccessStoreForTest(null));

// ---------------------------------------------------------------------------------------------
// Game keys

test('game keys: mapping of servers and keys', () => {
  assert.equal(serverGameKey({ type: 'PAPER' }), 'minecraft');
  assert.equal(serverGameKey({ type: 'BEDROCK' }), 'minecraft');
  assert.equal(serverGameKey({ type: 'CURSEFORGE' }), 'minecraft');
  assert.equal(serverGameKey({ type: 'TSHOCK' }), 'terraria');
  assert.equal(serverGameKey({ type: 'TMODLOADER' }), 'terraria');
  assert.equal(serverGameKey({ type: 'STEAMCMD', steam: { gameId: 'satisfactory' } }), 'steam:satisfactory');
  assert.equal(serverGameKey({ type: 'STEAMCMD', steam: null }), 'steam:');
  assert.equal(steamGameKey('kf'), 'steam:kf');
  assert.equal(gameKeyKind('minecraft'), 'minecraft');
  assert.equal(gameKeyKind('terraria'), 'terraria');
  assert.equal(gameKeyKind('steam:killing-floor'), 'steam');
  assert.equal(gameKeyKind('steam:'), null);
  assert.equal(gameKeyKind('steam:Bad_Id'), null);
  assert.equal(gameKeyKind('factorio'), null);
  assert.equal(steamIdOfKey('steam:kf2'), 'kf2');
  assert.equal(steamIdOfKey('minecraft'), null);
  assert.equal(gameKeyLabel('steam:kf2', (id) => (id === 'kf2' ? 'Killing Floor 2' : null)), 'Killing Floor 2');
  assert.equal(gameKeyLabel('steam:gone', () => null), 'gone');
  assert.equal(gameKeyLabel('terraria'), 'Terraria');
  assert.ok(existingGameKeys().includes('steam:access-game'));
  assert.deepEqual(existingGameKeys().slice(0, 2), ['minecraft', 'terraria']);
});

// ---------------------------------------------------------------------------------------------
// Pure decisions

test('creationError: allowlist for users, admins unrestricted, disabled refuses everyone', () => {
  const base = { allowed: ['minecraft'], disabled: {}, label: 'X' };
  assert.equal(creationError({ ...base, role: 'user', key: 'minecraft' }), null);
  assert.equal(creationError({ ...base, role: 'user', key: 'terraria' })?.code, 'game_not_allowed');
  assert.equal(creationError({ ...base, role: 'user', key: 'terraria' })?.status, 403);
  assert.equal(creationError({ ...base, role: 'user', allowed: [], key: 'minecraft' })?.code, 'game_not_allowed');
  assert.equal(creationError({ ...base, role: 'admin', allowed: [], key: 'terraria' }), null);
  const disabled = { minecraft: { blockStart: false, disabledAt: 'x', by: null } };
  assert.equal(creationError({ ...base, disabled, role: 'admin', key: 'minecraft' })?.code, 'game_disabled');
  assert.equal(creationError({ ...base, disabled, role: 'admin', key: 'minecraft' })?.status, 409);
  assert.equal(creationError({ ...base, disabled, role: 'user', key: 'minecraft' })?.code, 'game_disabled');
  // The message names the game.
  assert.match(creationError({ ...base, role: 'user', key: 'terraria', label: 'Terraria' })!.message, /Terraria/);
});

test('creatableGames: admins all non-disabled keys, users granted minus disabled and missing', () => {
  const existing = ['minecraft', 'terraria', 'steam:a', 'steam:b'];
  const disabled = { 'steam:a': { blockStart: false, disabledAt: 'x', by: null } };
  assert.deepEqual(creatableGames('admin', null, existing, disabled), ['minecraft', 'terraria', 'steam:b']);
  assert.deepEqual(creatableGames('user', ['steam:b', 'steam:a', 'steam:gone', 'minecraft'], existing, disabled), ['minecraft', 'steam:b']);
  assert.deepEqual(creatableGames('user', [], existing, {}), []);
});

test('normalizeGameList: unknown keys -> 400 unknown_game, dedupe and stable order', () => {
  const existing = ['minecraft', 'terraria', 'steam:a'];
  assert.deepEqual(normalizeGameList(['steam:a', 'minecraft', 'minecraft'], existing), ['minecraft', 'steam:a']);
  assert.deepEqual(normalizeGameList([], existing), []);
  assert.throws(
    () => normalizeGameList(['minecraft', 'steam:nope', 'factorio'], existing),
    (e: unknown) => e instanceof AppError && e.status === 400 && e.code === 'unknown_game' && /steam:nope/.test(e.message),
  );
});

test('normalizeDisabledGames drops malformed entries', () => {
  assert.deepEqual(normalizeDisabledGames(null), {});
  assert.deepEqual(normalizeDisabledGames([1]), {});
  const v = normalizeDisabledGames({ minecraft: { blockStart: true, disabledAt: 't', by: 'u' }, junk: { blockStart: true }, terraria: 5 });
  assert.deepEqual(v, { minecraft: { blockStart: true, disabledAt: 't', by: 'u' } });
  assert.equal(normalizeDisabledGames({ 'steam:x1': {} })['steam:x1']!.blockStart, false);
});

test('blockStart semantics: apply/clear, start checks, servers to stop', () => {
  const t0 = new Date('2026-11-01T00:00:00Z');
  const t1 = new Date('2026-11-02T00:00:00Z');
  let d = applyDisabledChange({}, 'terraria', { disabled: true }, 'admin1', t0);
  assert.deepEqual(d, { terraria: { blockStart: false, disabledAt: t0.toISOString(), by: 'admin1' } });
  assert.equal(startBlocked(d, 'terraria'), false);
  assert.doesNotThrow(() => assertStartAllowed(d, 'terraria', 'Terraria'));
  // Setting blockStart later on an already disabled game keeps the original disabledAt.
  d = applyDisabledChange(d, 'terraria', { disabled: true, blockStart: true }, 'admin2', t1);
  assert.deepEqual(d.terraria, { blockStart: true, disabledAt: t0.toISOString(), by: 'admin2' });
  assert.equal(startBlocked(d, 'terraria'), true);
  assert.equal(startBlocked(d, 'minecraft'), false);
  assert.throws(
    () => assertStartAllowed(d, 'terraria', 'Terraria'),
    (e: unknown) => e instanceof AppError && e.status === 409 && e.code === 'game_disabled',
  );
  // Enabling clears everything (blockStart included); other keys untouched; input not mutated.
  const other = applyDisabledChange(d, 'minecraft', { disabled: true }, 'a', t1);
  const enabled = applyDisabledChange(other, 'terraria', { disabled: false, blockStart: true }, 'a', t1);
  assert.deepEqual(Object.keys(enabled), ['minecraft']);
  assert.ok(other.terraria);
  // Only active servers of that game are stopped.
  const servers = [
    { id: '1', key: 'terraria', status: 'running' },
    { id: '2', key: 'terraria', status: 'stopped' },
    { id: '3', key: 'terraria', status: 'installing' },
    { id: '4', key: 'minecraft', status: 'running' },
    { id: '5', key: 'terraria', status: 'crashed' },
    { id: '6', key: 'terraria', status: 'starting' },
  ];
  assert.deepEqual(serversToStop(servers, 'terraria').map((s) => s.id), ['1', '3', '6']);
});

// ---------------------------------------------------------------------------------------------
// Service layer with an injected store (no database)

test('assertCanCreateServer / assertServerCanStart / server JSON flags', async () => {
  const u = user('user');
  useStore({ [u.id]: ['minecraft', 'steam:access-game'] }, { terraria: { blockStart: true, disabledAt: 't', by: null } });
  assert.equal(await codeOf(() => assertCanCreateServer(u, 'minecraft')), undefined);
  assert.equal(await codeOf(() => assertCanCreateServer(u, 'steam:access-game')), undefined);
  assert.equal(await codeOf(() => assertCanCreateServer(u, 'terraria')), '409 game_disabled');
  assert.equal(await codeOf(() => assertCanCreateServer(user('admin'), 'terraria')), '409 game_disabled');
  assert.equal(await codeOf(() => assertCanCreateServer(user('admin'), 'steam:access-game')), undefined);
  assert.equal(await codeOf(() => assertServerCanStart({ type: 'TSHOCK', steam: null })), '409 game_disabled');
  assert.equal(await codeOf(() => assertServerCanStart({ type: 'PAPER', steam: null })), undefined);

  await getDisabledGames();
  assert.deepEqual(serverGameState(row({ type: 'TERRARIA', game: 'terraria' })), { gameDisabled: true, gameBlocked: true });
  assert.deepEqual(serverGameState(row()), { gameDisabled: false, gameBlocked: false });
  const pub = toPublicServer(row({ type: 'TSHOCK', game: 'terraria' }), 'owner');
  assert.equal(pub.gameDisabled, true);
  assert.equal(pub.gameBlocked, true);

  useStore({}, { minecraft: { blockStart: false, disabledAt: 't', by: null } });
  await getDisabledGames();
  assert.deepEqual(serverGameState(row()), { gameDisabled: true, gameBlocked: false });
  // Disabled without blockStart: existing servers still start.
  assert.equal(await codeOf(() => assertServerCanStart(row())), undefined);
});

test('user JSON: allowedGames and creatableGames', async () => {
  const u = user('user');
  useStore({ [u.id]: ['terraria', 'steam:access-game'] }, { 'steam:access-game': { blockStart: false, disabledAt: 't', by: null } });
  const pu = await publicUserWithGames(u, { creatable: true });
  assert.deepEqual(pu.allowedGames, ['terraria', 'steam:access-game']);
  assert.deepEqual(pu.creatableGames, ['terraria']);
  const plain = await publicUserWithGames(u);
  assert.equal('creatableGames' in plain, false);
  const pa = await publicUserWithGames(user('admin'), { creatable: true });
  assert.equal(pa.allowedGames, null);
  assert.ok(pa.creatableGames!.includes('minecraft'));
  assert.ok(!pa.creatableGames!.includes('steam:access-game'));
});

// ---------------------------------------------------------------------------------------------
// Every creation path refuses before touching the database (createServer is the single choke point)

test('POST /servers path (createServer): refused game -> 403, disabled -> 409', async () => {
  const u = user('user');
  useStore({ [u.id]: ['minecraft'] });
  const steamInput = { name: 's', type: 'STEAMCMD' as const, mcVersion: 'LATEST', memoryMb: 1024, cpu: 1, steam: { gameId: 'access-game', vars: {} } };
  assert.equal(await codeOf(() => createServer(u, steamInput)), '403 game_not_allowed');
  assert.equal(await codeOf(() => createServer(u, { name: 't', type: 'TERRARIA', mcVersion: 'LATEST', memoryMb: 1024, cpu: 1 })), '403 game_not_allowed');
  useStore({ [u.id]: ['minecraft'] }, { minecraft: { blockStart: false, disabledAt: 't', by: null } });
  assert.equal(await codeOf(() => createServer(u, { name: 'm', type: 'PAPER', mcVersion: 'LATEST', memoryMb: 1024, cpu: 1 })), '409 game_disabled');
  assert.equal(await codeOf(() => createServer(user('admin'), { name: 'm', type: 'VANILLA', mcVersion: 'LATEST', memoryMb: 1024, cpu: 1 })), '409 game_disabled');
  // The access check names the definition.
  useStore({});
  try {
    await createServer(u, steamInput);
    assert.fail('expected an error');
  } catch (e) {
    assert.match((e as Error).message, /Access Game/);
  }
});

test('clone path: the clone of a server is checked against the game access', async () => {
  const u = user('user');
  useStore({ [u.id]: ['minecraft'] });
  const src = row({ type: 'TSHOCK', game: 'terraria', terraria: null });
  assert.equal(await codeOf(() => createServer(u, { ...configOf(src), name: 'clone' })), '403 game_not_allowed');
  const steamSrc = row({ type: 'STEAMCMD', game: 'steam', steam: { gameId: 'access-game', vars: {}, workshop: [], updateOnStart: true, validateNext: false } });
  assert.equal(await codeOf(() => createServer(u, { ...configOf(steamSrc), name: 'clone' })), '403 game_not_allowed');
});

test('template instantiate path', async () => {
  const u = user('user');
  useStore({ [u.id]: ['terraria'] });
  const t: TemplateRow = {
    id: 't1',
    owner_id: u.id,
    name: 'tpl',
    description: null,
    config: { type: 'PAPER', mcVersion: 'LATEST', memoryMb: 2048, cpu: 2 },
    shared: false,
    created_at: new Date(),
  };
  assert.equal(await codeOf(() => instantiateTemplate(u, t, { name: 'x', eula: true })), '403 game_not_allowed');
  useStore({ [u.id]: ['minecraft'] }, { minecraft: { blockStart: true, disabledAt: 't', by: null } });
  assert.equal(await codeOf(() => instantiateTemplate(u, t, { name: 'x', eula: true })), '409 game_disabled');
  const st: TemplateRow = { ...t, config: { type: 'STEAMCMD', mcVersion: 'LATEST', memoryMb: 1024, cpu: 1, steam: { gameId: 'access-game', vars: {} } } };
  assert.equal(await codeOf(() => instantiateTemplate(u, st, { name: 'x' })), '403 game_not_allowed');
});

async function zipWith(files: Record<string, string>): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scf-access-'));
  const file = path.join(dir, 'pack.zip');
  const a = archiver('zip');
  for (const [name, content] of Object.entries(files)) a.append(content, { name });
  void a.finalize();
  await pipeline(a, fs.createWriteStream(file));
  return file;
}

test('import paths (mrpack, CurseForge zip, server pack)', async () => {
  const u = user('user');
  useStore({ [u.id]: ['terraria'] });
  const mr = await zipWith({ 'modrinth.index.json': JSON.stringify({ name: 'Pack', dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.0' } }) });
  const cf = await zipWith({ 'manifest.json': JSON.stringify({ manifestType: 'minecraftModpack', name: 'CF', minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] } }) });
  const sp = await zipWith({ 'server.properties': 'motd=x\n' });
  // A server pack whose servcrafty.json claims another game is checked against that game.
  const spSteam = await zipWith({
    'servcrafty.json': JSON.stringify({ name: 'S', config: { type: 'STEAMCMD', memoryMb: 1024, cpu: 1, steam: { gameId: 'access-game', vars: {} } } }),
    'server.properties': '',
  });
  try {
    assert.equal(await codeOf(() => importArchive(u, mr, 'p.mrpack', { eula: 'true' })), '403 game_not_allowed');
    assert.equal(await codeOf(() => importArchive(u, cf, 'p.zip', { eula: 'true' })), '403 game_not_allowed');
    assert.equal(await codeOf(() => importArchive(u, sp, 'p.zip', { eula: 'true', type: 'PAPER' })), '403 game_not_allowed');
    useStore({ [u.id]: ['minecraft'] });
    assert.equal(await codeOf(() => importArchive(u, spSteam, 'p.zip', { eula: 'true' })), '403 game_not_allowed');
    useStore({ [u.id]: ['minecraft'] }, { minecraft: { blockStart: false, disabledAt: 't', by: null } });
    assert.equal(await codeOf(() => importArchive(user('admin'), mr, 'p.mrpack', { eula: 'true' })), '409 game_disabled');
  } finally {
    for (const f of [mr, cf, sp, spSteam]) await fsp.rm(path.dirname(f), { recursive: true, force: true });
  }
});
