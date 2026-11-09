import assert from 'node:assert/strict';
import test from 'node:test';
import { minecraftConfigSchema, minecraftEnv, normalizeMinecraftConfig, type MinecraftConfig } from '../src/lib/minecraftConfig.js';

const parse = (v: unknown) => minecraftConfigSchema.parse(v);
const norm = (type: string, v: unknown) => normalizeMinecraftConfig(type, parse(v));

test('maps a full Java config to itzg/minecraft-server env vars', () => {
  const cfg = norm('VANILLA', {
    levelName: 'My World',
    gameMode: 'creative',
    forceGamemode: true,
    hardcore: false,
    difficulty: 'hard',
    motd: 'Hello \\n there',
    maxPlayers: 12,
    pvp: false,
    onlineMode: true,
    allowFlight: true,
    commandBlocks: true,
    allowNether: false,
    spawnAnimals: true,
    spawnMonsters: false,
    spawnNpcs: true,
    playerIdleTimeout: 15,
    seed: '-123456789',
    levelType: 'amplified',
    generateStructures: false,
    spawnProtection: 0,
    maxWorldSize: 5000,
    whitelist: { enabled: true, users: ['Notch', 'jeb_', 'Notch'] },
    ops: ['Notch'],
    viewDistance: 12,
    simulationDistance: 8,
    entityBroadcastRange: 80,
    networkCompressionThreshold: 512,
    resourcePack: { url: 'https://example.com/pack.zip', sha1: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', required: true },
    extra: { 'sync-chunk-writes': 'false' },
  });
  assert.deepEqual(minecraftEnv('VANILLA', cfg), {
    LEVEL: 'My World',
    MODE: 'creative',
    FORCE_GAMEMODE: 'true',
    HARDCORE: 'false',
    DIFFICULTY: 'hard',
    MOTD: 'Hello \\n there',
    MAX_PLAYERS: '12',
    PVP: 'false',
    ONLINE_MODE: 'true',
    ALLOW_FLIGHT: 'true',
    ENABLE_COMMAND_BLOCK: 'true',
    ALLOW_NETHER: 'false',
    SPAWN_ANIMALS: 'true',
    SPAWN_MONSTERS: 'false',
    SPAWN_NPCS: 'true',
    PLAYER_IDLE_TIMEOUT: '15',
    SEED: '-123456789',
    LEVEL_TYPE: 'amplified',
    GENERATE_STRUCTURES: 'false',
    SPAWN_PROTECTION: '0',
    MAX_WORLD_SIZE: '5000',
    VIEW_DISTANCE: '12',
    SIMULATION_DISTANCE: '8',
    ENTITY_BROADCAST_RANGE_PERCENTAGE: '80',
    NETWORK_COMPRESSION_THRESHOLD: '512',
    RESOURCE_PACK: 'https://example.com/pack.zip',
    RESOURCE_PACK_SHA1: 'abcdef0123456789abcdef0123456789abcdef01',
    RESOURCE_PACK_ENFORCE: 'true',
    WHITELIST: 'Notch,jeb_',
    ENABLE_WHITELIST: 'true',
    OPS: 'Notch',
    CUSTOM_SERVER_PROPERTIES: 'sync-chunk-writes=false',
  });
});

test('Java: unset options produce no env vars; empty config maps to nothing', () => {
  assert.deepEqual(minecraftEnv('PAPER', norm('PAPER', {})), {});
  assert.deepEqual(minecraftEnv('PAPER', null), {});
  assert.deepEqual(minecraftEnv('PAPER', norm('PAPER', { motd: '', seed: '' })), {});
});

test('Java: an explicit enforce=false survives itzg forcing ENFORCE_WHITELIST on', () => {
  const env = minecraftEnv('PAPER', norm('PAPER', { whitelist: { enabled: true, enforce: false, users: ['Steve'] }, extra: { 'pause-when-empty-seconds': '0' } }));
  assert.equal(env.ENFORCE_WHITELIST, 'false');
  assert.equal(env.CUSTOM_SERVER_PROPERTIES, 'pause-when-empty-seconds=0\nenforce-whitelist=false');
});

test('modpacks use the Java mapping', () => {
  const env = minecraftEnv('MODRINTH', norm('MODRINTH', { difficulty: 'peaceful', levelType: 'flat' }));
  assert.deepEqual(env, { DIFFICULTY: 'peaceful', LEVEL_TYPE: 'flat' });
});

test('maps a Bedrock config to itzg/minecraft-bedrock-server env vars', () => {
  const cfg = norm('BEDROCK', {
    levelName: 'Bedrock Land',
    gameMode: 'adventure',
    forceGamemode: true,
    difficulty: 'normal',
    motd: 'BDS',
    maxPlayers: 20,
    onlineMode: true,
    allowCheats: true,
    playerIdleTimeout: 30,
    seed: '42',
    levelType: 'flat',
    viewDistance: 16,
    tickDistance: 6,
    networkCompressionThreshold: 1,
    resourcePack: { required: true },
    whitelist: { enabled: true, users: ['Some Gamer', 'Other#1234'] },
    ops: ['2535400000000000'],
    extra: { 'content-log-level': 'info' },
  });
  assert.deepEqual(minecraftEnv('BEDROCK', cfg), {
    LEVEL_NAME: 'Bedrock Land',
    GAMEMODE: 'adventure',
    FORCE_GAMEMODE: 'true',
    DIFFICULTY: 'normal',
    SERVER_NAME: 'BDS',
    MAX_PLAYERS: '20',
    ONLINE_MODE: 'true',
    ALLOW_CHEATS: 'true',
    PLAYER_IDLE_TIMEOUT: '30',
    LEVEL_SEED: '42',
    LEVEL_TYPE: 'FLAT',
    VIEW_DISTANCE: '16',
    TICK_DISTANCE: '6',
    COMPRESSION_THRESHOLD: '1',
    TEXTUREPACK_REQUIRED: 'true',
    ALLOW_LIST_USERS: 'Some Gamer,Other#1234',
    ALLOW_LIST: 'true',
    OPS: '2535400000000000',
    CONTENT_LOG_LEVEL: 'info',
  });
  assert.deepEqual(minecraftEnv('BEDROCK', norm('BEDROCK', { whitelist: { enabled: false } })), { ALLOW_LIST: 'false' });
});

const rejects = (type: string, v: unknown, re: RegExp) => {
  assert.throws(() => norm(type, v), (e: Error) => {
    assert.match(e.message, re);
    return true;
  });
};

test('schema rejects unknown fields, bad enums, out-of-range numbers and unsafe strings', () => {
  rejects('VANILLA', { bogus: 1 }, /Unrecognized key/);
  rejects('VANILLA', { difficulty: 'insane' }, /Invalid enum/);
  rejects('VANILLA', { viewDistance: 64 }, /less than or equal to 32/);
  rejects('VANILLA', { maxPlayers: 1.5 }, /integer/);
  rejects('VANILLA', { levelName: '../evil' }, /letters, digits/);
  rejects('VANILLA', { motd: 'a\nb' }, /control characters/);
  rejects('VANILLA', { motd: 'leak %env:RCON_PASSWORD%' }, /placeholders/);
  rejects('VANILLA', { generatorSettings: 'not json' }, /JSON object/);
  rejects('VANILLA', { resourcePack: { url: 'ftp://x.y/z' } }, /http/);
  rejects('VANILLA', { resourcePack: { url: 'https://x.y/z', sha1: 'abc' } }, /SHA-1/);
  rejects('VANILLA', { whitelist: { users: ['bad name!'] } }, /valid player name/);
});

test('extras: protected or malformed keys, and duplicates of typed options, are rejected', () => {
  rejects('VANILLA', { extra: { 'server-port': '1' } }, /managed by ServCrafty/);
  rejects('VANILLA', { extra: { 'rcon.password': 'x' } }, /managed by ServCrafty/);
  rejects('VANILLA', { extra: { 'management-server-enabled': 'true' } }, /managed by ServCrafty/);
  rejects('VANILLA', { extra: { 'Bad Key': 'x' } }, /invalid server.properties key/);
  rejects('VANILLA', { extra: { a: 'x\ny' } }, /control characters/);
  rejects('VANILLA', { difficulty: 'hard', extra: { difficulty: 'easy' } }, /duplicates the "difficulty"/);
  rejects('BEDROCK', { extra: { 'spawn-animals': 'true' } }, /Bedrock image can set/);
});

test('type-specific options are rejected on the wrong edition', () => {
  rejects('BEDROCK', { hardcore: true }, /not supported on Bedrock/);
  rejects('BEDROCK', { gameMode: 'spectator' }, /spectator/);
  rejects('BEDROCK', { levelType: 'amplified' }, /default, flat, legacy/);
  rejects('BEDROCK', { resourcePack: { url: 'https://x.y/p.zip' } }, /only support "required"/);
  rejects('BEDROCK', { whitelist: { enforce: true } }, /not supported on Bedrock/);
  rejects('VANILLA', { allowCheats: true }, /not supported on Java/);
  rejects('VANILLA', { tickDistance: 4 }, /not supported on Java/);
  rejects('VANILLA', { levelType: 'legacy' }, /on Java servers/);
  rejects('VANILLA', { whitelist: { enabled: false, users: ['Steve'] } }, /require the whitelist to be enabled/);
  rejects('VANILLA', { whitelist: { users: ['Some Gamer'] } }, /not a valid Java username/);
});

test('normalization drops empty values and empty groups', () => {
  const c: MinecraftConfig = norm('VANILLA', { motd: '  ', whitelist: { users: [] }, resourcePack: {}, ops: [], extra: {} });
  assert.deepEqual(c, {});
});
