'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePlan, PlanError } = require('../src/plan');

function base() {
  return {
    schema: 1,
    serverName: 'srv',
    steam: { appId: 1, branch: null, betaPassword: null, platform: 'linux', login: 'anonymous', validate: false, update: true },
    workshop: null,
    files: [],
    launch: { cwd: '', argv: ['./run.sh', '-pw=SECRETVALUE'], env: { A: 'b' } },
    stop: { type: 'signal', signal: 'SIGINT', command: '', timeoutSec: 30 },
    console: { stdin: false },
    ready: null,
    scripts: { postInstall: null, preStart: null },
  };
}

test('accepts a valid plan and fills defaults', () => {
  const p = validatePlan(base());
  assert.equal(p.steam.appId, 1);
  assert.equal(p.launch.cwd, '');
  assert.deepEqual(p.workshop, null);
});

test('rejects wrong schema, with no values in the message', () => {
  const b = base();
  b.schema = 2;
  assert.throws(() => validatePlan(b), PlanError);
  assert.throws(() => validatePlan(null), /plan/);
});

const bad = [
  ['steam.appId', (b) => (b.steam.appId = 'x')],
  ['steam.platform', (b) => (b.steam.platform = 'mac')],
  ['steam.update', (b) => delete b.steam.update],
  ['launch.argv', (b) => (b.launch.argv = [])],
  ['launch.argv', (b) => (b.launch.argv = [1])],
  ['launch.env', (b) => (b.launch.env = { A: 1 })],
  ['files[0].path', (b) => (b.files = [{ type: 'template', path: '../etc/passwd', content: '' }])],
  ['files[0].path', (b) => (b.files = [{ type: 'template', path: '/etc/passwd', content: '' }])],
  ['files[0].type', (b) => (b.files = [{ type: 'script', path: 'a' }])],
  ['files[0].when', (b) => (b.files = [{ type: 'template', path: 'a', content: '', when: 'never' }])],
  ['workshop.ids[0]', (b) => (b.workshop = { appId: 2, ids: ['abc'], install: 'steamcmd', dir: 'Mods' })],
  ['workshop.install', (b) => (b.workshop = { appId: 2, ids: [], install: 'x', dir: 'Mods' })],
  ['stop.type', (b) => (b.stop.type = 'kill')],
  ['stop.command', (b) => (b.stop = { type: 'stdin', timeoutSec: 5 })],
  ['launch.cwd', (b) => (b.launch.cwd = '../x')],
];
for (const [name, mutate] of bad) {
  test(`rejects bad ${name}`, () => {
    const b = base();
    mutate(b);
    assert.throws(() => validatePlan(b), (e) => e instanceof PlanError && e.message.includes(name) && !e.message.includes('SECRETVALUE'));
  });
}

test('normalises ini ops and workshop ids', () => {
  const b = base();
  b.workshop = { appId: 2, ids: [5, '6', '5'], install: 'config-list', dir: '' };
  b.files = [{ type: 'ini', path: 'a.ini', set: [{ section: 'S', key: 'k', value: 4 }], list: [{ section: 'S', key: 'L', values: [1, 2] }] }];
  const p = validatePlan(b);
  assert.deepEqual(p.workshop.ids, ['5', '6']);
  assert.equal(p.files[0].when, 'always');
  assert.equal(p.files[0].set[0].value, '4');
  assert.deepEqual(p.files[0].list[0].values, ['1', '2']);
});
