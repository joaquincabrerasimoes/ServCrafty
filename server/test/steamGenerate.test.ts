import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/lib/errors.js';
import { parseDefinition, validateDefinition } from '../src/lib/gameDefinition.js';
import {
  buildPlan,
  fillGeneratedVars,
  generateSecret,
  generateVar,
  mergeSteamConfig,
  normalizeSteamConfig,
  publicSteamConfig,
  renderArg,
} from '../src/lib/steamPlan.js';
import { definitionSummary, registerDefinitionsForTest } from '../src/services/gameDefinitions.js';
import { hasAccess } from '../src/services/access.js';
import { configOf } from '../src/services/servers.js';
import type { ServerRow } from '../src/services/types.js';

const raw = {
  schema: 1,
  id: 'gen-game',
  name: 'Gen game',
  steam: { appId: 215360 },
  resources: { memoryMb: 1024, memoryMinMb: 512, cpu: 1 },
  ports: [{ id: 'game', label: 'Game', protocol: 'udp', containerPort: 7707 }],
  variables: [
    { key: 'map', label: 'Map', type: 'string', default: 'KF-Farm' },
    { key: 'gameMode', label: 'Mode', type: 'string', default: 'KFmod.KFGameType' },
    { key: 'mutators', label: 'Mutators', type: 'string', default: '' },
    { key: 'extra', label: 'Extra', type: 'boolean', default: false },
    { key: 'adminPassword', label: 'Admin password', type: 'password', required: true, generate: { length: 24 } },
    { key: 'token', label: 'Token', type: 'string', generate: { length: 16, charset: 'hex' } },
  ],
  launch: {
    command: [
      './ucc-bin',
      { parts: ['{{map}}', 'Game={{gameMode}}', { value: 'Mutators={{mutators}}', if: 'mutators' }], separator: '?' },
      { parts: [{ value: 'a', if: 'mutators' }, { value: 'b', if: 'extra' }], separator: ',' },
      { parts: ['-x', '{{map}}'], if: 'extra' },
      { value: '-pw={{adminPassword}}', if: 'adminPassword' },
    ],
  },
};
const def = parseDefinition(raw);
registerDefinitionsForTest([def]);

const errorsOf = (mutate: (d: any) => void) => {
  const d = JSON.parse(JSON.stringify(raw));
  mutate(d);
  const r = validateDefinition(d);
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
};
const hasError = (errs: string[], re: RegExp) => assert.ok(errs.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errs)}`);

const argvOf = (vars: Record<string, string | number | boolean>) =>
  buildPlan(def, {
    serverId: 's',
    serverName: 'n',
    steam: { gameId: 'gen-game', vars: { adminPassword: 'pw', ...vars }, workshop: [], updateOnStart: true, validateNext: false },
    mainHostPort: 27000,
    extraPorts: {},
  }).plan.launch.argv;

test('composite args: all parts, skipped parts, all skipped, element if', () => {
  assert.deepEqual(argvOf({ mutators: 'M1,M2', extra: true }), [
    './ucc-bin',
    'KF-Farm?Game=KFmod.KFGameType?Mutators=M1,M2',
    'a,b',
    '-xKF-Farm',
    '-pw=pw',
  ]);
  // Skipped part; one-of-two parts; element-level if false.
  assert.deepEqual(argvOf({ extra: false }), ['./ucc-bin', 'KF-Farm?Game=KFmod.KFGameType', '-pw=pw']);
  assert.deepEqual(argvOf({ mutators: 'x' }), ['./ucc-bin', 'KF-Farm?Game=KFmod.KFGameType?Mutators=x', 'a', '-pw=pw']);
  // All parts skipped -> omitted.
  assert.equal(renderArg({ parts: [{ value: 'a', if: 'mutators' }], separator: '' }, {}, (s) => s), null);
});

test('composite args: validator', () => {
  hasError(errorsOf((d) => d.launch.command.push({ parts: [] })), /launch\.command\.5/);
  hasError(errorsOf((d) => d.launch.command.push({ parts: ['{{nope}}'] })), /launch\.command\.5\.parts\.0: unknown template/);
  hasError(errorsOf((d) => d.launch.command.push({ parts: [{ value: 'x', if: 'nope' }] })), /launch\.command\.5\.parts\.0\.if: "if" must reference/);
  hasError(errorsOf((d) => d.launch.command.push({ parts: ['x'], if: 'nope' })), /launch\.command\.5\.if/);
  hasError(errorsOf((d) => d.launch.command.push({ parts: ['x'], extra: 1 })), /launch\.command\.5/);
  hasError(errorsOf((d) => (d.launch.command[0] = { parts: ['./x'] })), /must be unconditional/);
});

test('generate: validator rules', () => {
  hasError(errorsOf((d) => (d.variables[3].generate = {})), /variables\.3\.generate: applies to string\/password/);
  hasError(errorsOf((d) => (d.variables[0].generate = {})), /cannot be combined with a default/);
  hasError(errorsOf((d) => Object.assign(d.variables[5], { pattern: '[a-f0-9]+' })), /cannot be combined with a pattern/);
  hasError(errorsOf((d) => (d.variables[5].generate.length = 7)), /variables\.5\.generate\.length/);
  hasError(errorsOf((d) => (d.variables[5].generate.length = 65)), /variables\.5\.generate\.length/);
  hasError(errorsOf((d) => Object.assign(d.variables[5], { max: 10 })), /is above max/);
  hasError(errorsOf((d) => (d.variables[5].generate.charset = 'emoji')), /variables\.5\.generate\.charset/);
});

test('generateSecret: lengths and charsets', () => {
  for (const n of [8, 20, 64]) assert.equal(generateSecret(n).length, n);
  assert.match(generateSecret(64, 'alnum'), /^[A-Za-z0-9]{64}$/);
  assert.match(generateSecret(64, 'hex'), /^[0-9a-f]{64}$/);
  assert.notEqual(generateSecret(20), generateSecret(20));
  // Rough uniformity: every alnum character shows up in a large sample.
  assert.equal(new Set(generateSecret(5000)).size, 62);
  assert.throws(() => generateVar(def.variables[0]!), (e: unknown) => e instanceof AppError && e.code === 'not_generated');
});

test('creation generates empty/absent values, keeps client values; required is not violated by emptiness', () => {
  const a = normalizeSteamConfig(def, { gameId: 'gen-game', vars: {} });
  assert.match(String(a.vars.adminPassword), /^[A-Za-z0-9]{24}$/);
  assert.match(String(a.vars.token), /^[0-9a-f]{16}$/);
  const b = normalizeSteamConfig(def, { gameId: 'gen-game', vars: { adminPassword: '', token: 'mine' } });
  assert.equal(String(b.vars.adminPassword).length, 24);
  assert.equal(b.vars.token, 'mine');
});

test('PATCH: an empty or reset generated value is regenerated, other values kept', () => {
  const cur = normalizeSteamConfig(def, { gameId: 'gen-game', vars: { adminPassword: 'keepme', token: 'tok' } });
  const kept = mergeSteamConfig(def, cur, { vars: { map: 'KF-X' } });
  assert.equal(kept.vars.adminPassword, 'keepme');
  const regen = mergeSteamConfig(def, cur, { vars: { adminPassword: '', token: null } });
  assert.notEqual(regen.vars.adminPassword, 'keepme');
  assert.equal(String(regen.vars.adminPassword).length, 24);
  assert.match(String(regen.vars.token), /^[0-9a-f]{16}$/);
});

test('stored configs missing a generated value get one at start; full configs are left alone', () => {
  const filled = fillGeneratedVars(def, { map: 'x' });
  assert.equal(String(filled?.adminPassword).length, 24);
  assert.equal(fillGeneratedVars(def, { adminPassword: 'a', token: 'b' }), null);
});

test('generated values never leak below manager (string type included)', () => {
  const cfg = normalizeSteamConfig(def, { gameId: 'gen-game', vars: {} });
  const low = publicSteamConfig(cfg, def, false)!;
  assert.equal(low.vars.adminPassword, '');
  assert.equal(low.vars.token, '');
  assert.equal(low.vars.map, 'KF-Farm');
  assert.equal(publicSteamConfig(cfg, def, true)!.vars.token, cfg.vars.token);
});

test('clone/template config drops generated values so creation generates fresh ones', () => {
  const cfg = normalizeSteamConfig(def, { gameId: 'gen-game', vars: { map: 'KF-Y' } });
  const row = {
    id: 'x', type: 'STEAMCMD', mc_version: 'LATEST', loader_version: null, modpack: null, java_args: null, memory_mb: 1024, cpu: 1,
    disk_mb: null, env: {}, auto_restart: true, lan_announce: false, minecraft: null, terraria: null, steam: cfg,
  } as unknown as ServerRow;
  const out = configOf(row).steam as { vars: Record<string, unknown> };
  assert.equal(out.vars.map, 'KF-Y');
  assert.equal('adminPassword' in out.vars, false);
  assert.equal('token' in out.vars, false);
  const clone = normalizeSteamConfig(def, out as never);
  assert.notEqual(clone.vars.adminPassword, cfg.vars.adminPassword);
  assert.equal(String(clone.vars.adminPassword).length, 24);
});

test('regenerate needs manager access (operator/viewer refused)', () => {
  // The route loads the server with need "manager" (routes/steam.ts); this is that check.
  assert.equal(hasAccess('viewer', 'manager'), false);
  assert.equal(hasAccess('operator', 'manager'), false);
  assert.equal(hasAccess('manager', 'manager'), true);
  assert.equal(hasAccess('owner', 'manager'), true);
});

test('GET /games exposes generate on variables', () => {
  const s = definitionSummary({ definition: def, builtin: false, ownerId: null, createdAt: null, updatedAt: null });
  assert.deepEqual(s.variables.find((v) => v.key === 'token')?.generate, { length: 16, charset: 'hex' });
  assert.deepEqual(s.variables.find((v) => v.key === 'adminPassword')?.generate, { length: 24, charset: 'alnum' });
});
