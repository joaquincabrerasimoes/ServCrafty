'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../src/steamcmd');
const { redactSteamArgs, redactEnv, describeCommand, REDACTED } = require('../src/redact');

const linux = { appId: 1690800, branch: null, betaPassword: null, platform: 'linux', login: 'anonymous', validate: false, update: true };

test('linux install args', () => {
  const a = sc.buildInstallArgs(linux, '/data/game').join(' ');
  assert.equal(a, '+@ShutdownOnFailedCommand 1 +@NoPromptForPassword 1 +force_install_dir /data/game +login anonymous +app_update 1690800 +quit');
});

test('windows install forces the platform before login', () => {
  const a = sc.buildInstallArgs({ ...linux, appId: 232130, platform: 'windows' }, '/data/game');
  const s = a.join(' ');
  assert.ok(s.includes('+@sSteamCmdForcePlatformType windows +force_install_dir /data/game +login anonymous +app_update 232130'));
  assert.ok(a.indexOf('+@sSteamCmdForcePlatformType') < a.indexOf('+login'));
});

test('beta branch, password and validate', () => {
  const a = sc.buildInstallArgs({ ...linux, branch: 'experimental', betaPassword: 'pw', validate: true }, '/data/game');
  assert.deepEqual(a.slice(-6), ['-beta', 'experimental', '-betapassword', 'pw', 'validate', '+quit']);
  const pub = sc.buildInstallArgs({ ...linux, branch: 'public' }, '/data/game');
  assert.ok(!pub.includes('-beta'));
});

test('workshop args', () => {
  const a = sc.buildWorkshopArgs(linux, { appId: 232090, ids: ['11', '22'], install: 'steamcmd', dir: 'Mods' }, '/data/workshop');
  assert.equal(a.join(' '), '+@ShutdownOnFailedCommand 1 +@NoPromptForPassword 1 +force_install_dir /data/workshop +login anonymous +workshop_download_item 232090 11 +workshop_download_item 232090 22 +quit');
});

test('progress parsing', () => {
  assert.equal(sc.parseProgress(' Update state (0x61) downloading, progress: 12.34 (123 / 1000)'), 12);
  assert.equal(sc.parseProgress('Update state (0x5) verifying install, progress: 99.99 (1 / 2)'), 99);
  assert.equal(sc.parseProgress('Update state (0x81) verifying update, progress: 100.00 (1 / 1)'), 100);
  assert.equal(sc.parseProgress('Success! App fully installed.'), null);
});

test('classification', () => {
  assert.equal(sc.classifyResult(0, 'Success! App "1" fully installed.').kind, 'ok');
  assert.equal(sc.classifyResult(8, '').kind, 'retry');
  assert.equal(sc.classifyResult(10, '').kind, 'retry');
  assert.equal(sc.classifyResult(1, 'ERROR! Timeout downloading').kind, 'retry');
  assert.equal(sc.classifyResult(1, 'Missing configuration').kind, 'retry');
  assert.equal(sc.classifyResult(1, "Error! App '1' state is 0x202 after update job.").kind, 'fatal');
  assert.equal(sc.classifyResult(0, "Error! App '1' state is 0x602 after update job.").kind, 'fatal');
  assert.equal(sc.classifyResult(0, "Error! App '1' state is 0x6 after update job.").kind, 'retry');
  assert.equal(sc.classifyResult(0, 'ERROR! Download item 123 failed (Failure).').kind, 'retry');
  assert.equal(sc.classifyResult(5, 'something odd').kind, 'fatal');
});

test('retries transient failures up to 3 times then succeeds', async () => {
  const results = [{ code: 8, output: '' }, { code: 10, output: '' }, { code: 0, output: 'ok' }];
  let calls = 0;
  await sc.runWithRetry(['x'], 't', { run: async () => results[calls++], sleep: async () => {} });
  assert.equal(calls, 3);
});

test('gives up after 3 transient failures', async () => {
  let calls = 0;
  await assert.rejects(
    sc.runWithRetry(['x'], 't', { run: async () => (calls++, { code: 8, output: '' }), sleep: async () => {} }),
    /after 3 attempts/,
  );
  assert.equal(calls, 3);
});

test('no-space is not retried', async () => {
  let calls = 0;
  await assert.rejects(
    sc.runWithRetry(['x'], 't', { run: async () => (calls++, { code: 1, output: "Error! App '1' state is 0x202 after update job." }), sleep: async () => {} }),
    /disk space/,
  );
  assert.equal(calls, 1);
});

test('redaction', () => {
  const args = ['+app_update', '1', '-beta', 'b', '-betapassword', 'SECRET', '+quit'];
  assert.ok(!redactSteamArgs(args).join(' ').includes('SECRET'));
  assert.ok(!sc.describeArgs(args).includes('SECRET'));
  assert.deepEqual(redactEnv({ A: 'secret' }), { A: REDACTED });
  const d = describeCommand(['./run.sh', '-ServerPassword=hunter2', '-Port=1']);
  assert.ok(!d.includes('hunter2'));
  assert.ok(d.startsWith('./run.sh'));
  assert.ok(d.includes('+2 args'));
});
