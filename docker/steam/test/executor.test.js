'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyFileOps } = require('../src/files');
const { makePaths, safeJoin } = require('../src/paths');
const { buildLaunch } = require('../src/launch');
const { syncWorkshop, loadManifest } = require('../src/workshop');
const { validatePlan } = require('../src/plan');

const MAIN = path.join(__dirname, '..', 'src', 'main.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'servcrafty-steam-'));
}
function plan(over = {}) {
  return validatePlan({
    schema: 1,
    serverName: 'srv',
    steam: { appId: 232130, branch: null, betaPassword: null, platform: 'linux', login: 'anonymous', validate: false, update: true },
    workshop: null,
    files: [],
    launch: { cwd: 'bin', argv: ['./run.sh', '-ServerPassword=SECRETVALUE'], env: { TOKEN: 'SECRETENV' } },
    stop: { type: 'signal', signal: 'SIGINT', command: '', timeoutSec: 5 },
    console: { stdin: false },
    ready: null,
    scripts: { postInstall: null, preStart: null },
    ...over,
  });
}

test('template files: always overwrites, missing only creates', () => {
  const dir = tmp();
  const ops = [{ type: 'template', path: 'cfg/a.cfg', when: 'always', content: 'v=1\n' }];
  assert.equal(applyFileOps(ops, dir)[0].action, 'created');
  assert.equal(fs.readFileSync(path.join(dir, 'cfg', 'a.cfg'), 'utf8'), 'v=1\n');
  ops[0].content = 'v=2\n';
  assert.equal(applyFileOps(ops, dir)[0].action, 'updated');
  ops[0].content = 'v=3\n';
  ops[0].when = 'missing';
  assert.equal(applyFileOps(ops, dir)[0].action, 'skipped');
  assert.equal(fs.readFileSync(path.join(dir, 'cfg', 'a.cfg'), 'utf8'), 'v=2\n');
});

test('ini ops: missing file is created, existing CRLF file is edited in place', () => {
  const dir = tmp();
  const op = { type: 'ini', path: 'Conf/x.ini', when: 'always', set: [{ section: 'A', key: 'k', value: 'v' }], list: [{ section: 'A', key: 'L', values: ['1', '2'] }] };
  applyFileOps([op], dir);
  assert.equal(fs.readFileSync(path.join(dir, 'Conf', 'x.ini'), 'utf8'), '[A]\nk=v\nL=1\nL=2\n');
  fs.writeFileSync(path.join(dir, 'Conf', 'x.ini'), '[A]\r\nk=old\r\nL=9\r\n');
  applyFileOps([op], dir);
  assert.equal(fs.readFileSync(path.join(dir, 'Conf', 'x.ini'), 'utf8'), '[A]\r\nk=v\r\nL=1\r\nL=2\r\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'Conf')), ['x.ini']);
});

test('safeJoin refuses escapes', () => {
  assert.throws(() => safeJoin('/base', '../x'));
  assert.throws(() => safeJoin('/base', 'a/../../x'));
  assert.throws(() => safeJoin('/base', '/etc'));
});

test('buildLaunch: linux runs the argv directly, windows goes through xvfb-run + wine', () => {
  const paths = makePaths(tmp());
  const l = buildLaunch(plan(), paths, { PATH: '/bin' });
  assert.equal(l.cmd, './run.sh');
  assert.equal(l.cwd, path.join(paths.game, 'bin'));
  assert.equal(l.env.TOKEN, 'SECRETENV');
  const p = plan();
  p.steam.platform = 'windows';
  const w = buildLaunch(p, paths, { PATH: '/bin', DISPLAY: ':9' });
  assert.equal(w.cmd, 'xvfb-run');
  assert.deepEqual(w.args.slice(0, 2), ['-a', '-s']);
  assert.deepEqual(w.args.slice(-2), ['./run.sh', '-ServerPassword=SECRETVALUE']);
  assert.ok(w.args.includes('wine'));
  assert.equal(w.env.WINEPREFIX, paths.wineprefix);
  assert.equal(w.env.WINEDEBUG, '-all');
  assert.equal(w.env.DISPLAY, undefined);
});

test('workshop sync copies, tracks in the manifest and only removes tracked files', () => {
  const root = tmp();
  const paths = makePaths(root);
  const item = path.join(paths.workshop, 'steamapps', 'workshop', 'content', '232090', '111');
  fs.mkdirSync(path.join(item, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(item, 'a.u'), 'A');
  fs.writeFileSync(path.join(item, 'sub', 'b.u'), 'B');
  fs.mkdirSync(path.join(paths.game, 'Mods'), { recursive: true });
  fs.writeFileSync(path.join(paths.game, 'Mods', 'user.txt'), 'mine');

  const ws = { appId: 232090, ids: ['111'], install: 'steamcmd', dir: 'Mods' };
  assert.deepEqual(syncWorkshop({ paths, workshop: ws }), { missing: [] });
  assert.equal(fs.readFileSync(path.join(paths.game, 'Mods', 'sub', 'b.u'), 'utf8'), 'B');
  assert.deepEqual(loadManifest(paths.manifest).items['111'].files.sort(), ['a.u', 'sub/b.u']);

  syncWorkshop({ paths, workshop: { ...ws, ids: [] } });
  assert.ok(!fs.existsSync(path.join(paths.game, 'Mods', 'a.u')));
  assert.ok(!fs.existsSync(path.join(paths.game, 'Mods', 'sub')));
  assert.equal(fs.readFileSync(path.join(paths.game, 'Mods', 'user.txt'), 'utf8'), 'mine');
  assert.deepEqual(loadManifest(paths.manifest).items, {});
});

test('workshop sync: config-list never copies; missing items are reported', () => {
  const paths = makePaths(tmp());
  fs.mkdirSync(paths.game, { recursive: true });
  const r = syncWorkshop({ paths, workshop: { appId: 1, ids: ['5'], install: 'config-list', dir: '' } });
  assert.deepEqual(r, { missing: [] });
  const r2 = syncWorkshop({ paths, workshop: { appId: 1, ids: ['5'], install: 'steamcmd', dir: 'M' } });
  assert.deepEqual(r2, { missing: ['5'] });
});

function runDry(root, p) {
  fs.mkdirSync(path.join(root, 'servcrafty'), { recursive: true });
  fs.writeFileSync(path.join(root, 'servcrafty', 'plan.json'), JSON.stringify(p));
  return spawnSync(process.execPath, [MAIN, '--dry-run'], { env: { ...process.env, SERVCRAFTY_ROOT: root }, encoding: 'utf8' });
}

test('--dry-run prints markers and commands, writes files under SERVCRAFTY_ROOT, never prints secrets', () => {
  const root = tmp();
  const raw = {
    schema: 1,
    serverName: 'srv',
    steam: { appId: 232130, branch: 'beta1', betaPassword: 'SECRETBETA', platform: 'windows', login: 'anonymous', validate: true, update: true },
    workshop: { appId: 232090, ids: ['42'], install: 'config-list', dir: '' },
    files: [{ type: 'template', path: 'x/y.cfg', when: 'always', content: 'pw=SECRETFILE\n' }],
    launch: { cwd: 'bin', argv: ['./srv.exe', '-pw=SECRETVALUE'], env: { TOKEN: 'SECRETENV' } },
    stop: { type: 'stdin', signal: 'SIGINT', command: 'quit', timeoutSec: 10 },
    console: { stdin: true },
    ready: null,
    scripts: { postInstall: 'echo SECRETSCRIPT', preStart: null },
  };
  const r = runDry(root, raw);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = r.stdout;
  const markers = out.split('\n').filter((l) => l.startsWith('[servcrafty-steam] '));
  assert.deepEqual(markers, ['[servcrafty-steam] phase=install', '[servcrafty-steam] phase=workshop', '[servcrafty-steam] phase=configure', '[servcrafty-steam] phase=launch']);
  assert.match(out, /\+@sSteamCmdForcePlatformType windows/);
  assert.match(out, /\+app_update 232130 -beta beta1 -betapassword \*\*\* validate/);
  assert.match(out, /\+workshop_download_item 232090 42/);
  assert.match(out, /xvfb-run/);
  assert.equal(fs.readFileSync(path.join(root, 'data', 'game', 'x', 'y.cfg'), 'utf8'), 'pw=SECRETFILE\n');
  for (const s of ['SECRETBETA', 'SECRETVALUE', 'SECRETENV', 'SECRETSCRIPT']) assert.ok(!out.includes(s), `leaked ${s}`);
});

test('invalid plan: error marker on stdout and non-zero exit', () => {
  const root = tmp();
  const r = runDry(root, { schema: 7 });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /^\[servcrafty-steam\] error=invalid plan: schema/m);
});
