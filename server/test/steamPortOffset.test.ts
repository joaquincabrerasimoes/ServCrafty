import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/lib/errors.js';
import { parseDefinition, validateDefinition } from '../src/lib/gameDefinition.js';
import { brokenPortGroups, portGroups, resolvePorts } from '../src/lib/steamPlan.js';
import { definitionSummary } from '../src/services/gameDefinitions.js';
import { chooseGroupPorts } from '../src/services/portAlloc.js';
import { repairSteamPorts } from '../src/services/steamPorts.js';

type Port = Record<string, unknown>;
const base = (ports: Port[]) => ({
  schema: 1,
  id: 'offset-game',
  name: 'Offset game',
  steam: { appId: 215360 },
  resources: { memoryMb: 1024, memoryMinMb: 512, cpu: 1 },
  ports,
  launch: { command: ['./ucc-bin', '-port={{ports.game}}', '-gs={{ports.gamespy}}'] },
});
const game = { id: 'game', label: 'Game', protocol: 'udp', containerPort: 7707, mirror: true, main: true };
const gamespy = { id: 'gamespy', label: 'GameSpy query', protocol: 'udp', containerPort: 7708, mirror: true, offset: { from: 'game', by: 1 } };
const web = { id: 'web', label: 'WebAdmin', protocol: 'tcp', containerPort: 8075 };

const errorsOf = (ports: Port[]) => {
  const r = validateDefinition(base(ports));
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
};
const hasError = (errs: string[], re: RegExp) => assert.ok(errs.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errs)}`);
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : 'other';
  }
  return undefined;
};

test('offset: a valid definition (mirror allowed, protocol may differ)', () => {
  assert.deepEqual(errorsOf([game, gamespy, web]), []);
  assert.deepEqual(errorsOf([game, { ...gamespy, protocol: 'tcp', mirror: false }, web]), []);
});

test('offset: rejections', () => {
  hasError(errorsOf([game, { ...gamespy, offset: { from: 'nope', by: 1 } }]), /ports\.1\.offset\.from: unknown port "nope"/);
  hasError(
    errorsOf([game, gamespy, { ...web, id: 'third', offset: { from: 'gamespy', by: 2 } }]),
    /ports\.2\.offset\.from: port "gamespy" is itself an offset port/,
  );
  hasError(
    errorsOf([
      { ...game, main: true },
      { ...gamespy, id: 'a', offset: { from: 'b', by: 1 } },
      { ...gamespy, id: 'b', containerPort: 7709, offset: { from: 'a', by: 1 } },
    ]),
    /is itself an offset port/,
  );
  hasError(errorsOf([game, { ...gamespy, offset: { from: 'gamespy', by: 1 } }]), /cannot be an offset of itself/);
  hasError(errorsOf([game, { ...gamespy, mirror: false, publish: false }]), /ports\.1\.publish: an offset port must be published/);
  hasError(errorsOf([game, { ...web, publish: false }, { ...gamespy, offset: { from: 'web', by: 1 } }]), /port "web" is not published/);
  hasError(errorsOf([{ ...game, offset: { from: 'web', by: 1 } }, web]), /ports\.0\.offset: the main port cannot be an offset port/);
  // Without an explicit main, the first port is main.
  hasError(errorsOf([{ ...gamespy, main: undefined, offset: { from: 'web', by: 1 } }, web]), /main port cannot be an offset/);
  hasError(errorsOf([game, { ...gamespy, offset: { from: 'game', by: 0 } }]), /ports\.1\.offset\.by/);
  hasError(errorsOf([game, { ...gamespy, offset: { from: 'game', by: 101 } }]), /ports\.1\.offset\.by/);
  hasError(errorsOf([game, gamespy, { ...gamespy, id: 'dup', containerPort: 7710 }]), /another port already uses game \+ 1/);
});

const def = parseDefinition(base([game, gamespy, web]));

test('groups: offset ports follow their base, main group first', () => {
  assert.deepEqual(portGroups(def), [
    { id: 'game', offsets: [{ id: 'gamespy', by: 1 }] },
    { id: 'web', offsets: [] },
  ]);
});

test('allocator: the whole group fits', () => {
  const pool = [27000, 27001, 27002, 27003];
  assert.deepEqual(chooseGroupPorts(pool, new Set(), portGroups(def), 'no_free_ports'), { game: 27000, gamespy: 27001, web: 27002 });
});

test('allocator: skips a candidate whose offset is busy or outside the pool', () => {
  // 27001 is taken, so 27000 cannot host game+1; 27002/27003 fit.
  assert.deepEqual(chooseGroupPorts([27000, 27001, 27002, 27003, 27004], new Set([27001]), portGroups(def), 'no_free_ports'), {
    game: 27002,
    gamespy: 27003,
    web: 27000,
  });
  // 27000 + 1 is not in the pool (gap).
  assert.deepEqual(chooseGroupPorts([27000, 27005, 27006, 27010], new Set(), portGroups(def), 'no_free_ports'), {
    game: 27005,
    gamespy: 27006,
    web: 27000,
  });
});

test('allocator: no group fits -> 409 no_free_ports', () => {
  assert.equal(codeOf(() => chooseGroupPorts([27000, 27002, 27004], new Set(), portGroups(def), 'no_free_ports')), 'no_free_ports');
  assert.equal(codeOf(() => chooseGroupPorts([27000, 27001], new Set(), portGroups(def), 'no_free_ports')), 'no_free_ports');
});

test('templates render the container side (mirror offset port = its host port)', () => {
  const r = resolvePorts(def, 27002, { gamespy: 27003, web: 27000 });
  assert.equal(r.find((p) => p.id === 'gamespy')?.containerPort, 27003);
  assert.equal(r.find((p) => p.id === 'web')?.containerPort, 8075);
});

test('existing servers: ports that already satisfy the offsets are kept', () => {
  const pool = [27000, 27001, 27002, 27003, 27004];
  const cur = { game: 27002, gamespy: 27003, web: 27000 };
  assert.deepEqual(brokenPortGroups(def, cur), []);
  const r = repairSteamPorts(def, cur, pool, new Set(), true);
  assert.deepEqual(r, { ports: cur, moved: [], blocked: [] });
});

test('existing servers: a definition that gained an offset fixes only the offset port when base+by is free', () => {
  const pool = [27000, 27001, 27002, 27003, 27004];
  // Created before the offset existed: gamespy got an arbitrary port.
  const r = repairSteamPorts(def, { game: 27000, gamespy: 27004, web: 27002 }, pool, new Set(), true);
  assert.deepEqual(r, { ports: { game: 27000, gamespy: 27001, web: 27002 }, moved: [], blocked: [] });
});

test('existing servers: re-allocated only when stopped, otherwise reported as blocked', () => {
  const pool = [27000, 27001, 27002, 27003, 27004];
  const cur = { game: 27000, gamespy: 27004, web: 27002 };
  const busy = new Set([27001]); // game+1 belongs to another server
  const running = repairSteamPorts(def, cur, pool, busy, true);
  assert.deepEqual(running.blocked, ['game']);
  assert.equal(running.ports.game, 27000);
  const stopped = repairSteamPorts(def, cur, pool, busy, false);
  assert.deepEqual(stopped.moved, ['game']);
  assert.deepEqual(stopped.ports, { game: 27003, gamespy: 27004, web: 27002 });
});

test('GET /games ports carry offset', () => {
  const s = definitionSummary({ definition: def, builtin: false, ownerId: null, createdAt: null, updatedAt: null });
  assert.deepEqual(
    s.ports.map((p) => [p.id, p.offset ?? null, p.main]),
    [
      ['game', null, true],
      ['gamespy', { from: 'game', by: 1 }, false],
      ['web', null, false],
    ],
  );
});
