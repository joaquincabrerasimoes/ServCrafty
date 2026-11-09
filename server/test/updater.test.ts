import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CHECK_TTL_MS,
  compareSemver,
  evaluateCapabilities,
  detectInstallType,
  GitHubClient,
  isEligibleRelease,
  isNewerVersion,
  isStableVersion,
  normalizeGithubRemote,
  originMatchesRepo,
  parsePrevious,
  parseSemver,
  parseStatus,
  pickLatestRelease,
  resolveTagCommit,
  shasMatch,
  UpdateService,
  utf8SafeLength,
  type CapabilityProbe,
  type ExecFn,
  type UpdateDeps,
} from '../src/services/updater.js';

const REPO = 'joaquincabrerasimoes/ServCrafty';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TAG_OBJ = 'c'.repeat(40);

// ---------------------------------------------------------------- semver

test('semver: ordering of core versions and prereleases', () => {
  assert.ok(compareSemver('1.0.0', '0.9.9') > 0);
  assert.ok(compareSemver('0.10.0', '0.9.0') > 0, 'numeric, not lexicographic');
  assert.ok(compareSemver('v1.2.3', '1.2.3') === 0, 'leading v ignored');
  assert.ok(compareSemver('1.0.0+build.5', '1.0.0') === 0, 'build metadata ignored');
  // semver.org §11 example chain
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < chain.length; i++) assert.ok(compareSemver(chain[i]!, chain[i - 1]!) > 0, `${chain[i]} > ${chain[i - 1]}`);
  assert.ok(compareSemver('garbage', '0.0.1') < 0, 'invalid sorts below valid');
});

test('semver: parsing, stability and newer-than', () => {
  assert.deepEqual(parseSemver('v1.2.3-rc.1'), { major: 1, minor: 2, patch: 3, prerelease: ['rc', 1] });
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('01.2.3'), null, 'leading zeros are invalid');
  assert.ok(isStableVersion('v0.2.0'));
  assert.ok(!isStableVersion('v0.2.0-rc.1'));
  assert.ok(isNewerVersion('0.2.0', '0.1.0'));
  assert.ok(!isNewerVersion('0.1.0', '0.1.0'));
  assert.ok(!isNewerVersion('0.1.0', '0.2.0'));
  assert.ok(!isNewerVersion('nope', '0.1.0'));
});

// ---------------------------------------------------------------- releases

const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `Release ${tag}`,
  body: `notes for ${tag}`,
  html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
  published_at: '2026-11-01T00:00:00Z',
  draft: false,
  prerelease: false,
  ...extra,
});

test('releases: drafts, prereleases and non-semver tags are ignored; highest wins', () => {
  const list = [
    rel('v0.3.0', { draft: true }),
    rel('v0.4.0-rc.1', { prerelease: true }),
    rel('v0.5.0-beta.1'), // suffix but not flagged prerelease -> still ignored
    rel('v0.2.1'),
    rel('nightly'),
    rel('0.9.0'), // no leading v
    rel('v0.10.0'),
    rel('v0.9.0'),
    { bogus: true },
    null,
  ];
  assert.equal(pickLatestRelease(list)?.tag_name, 'v0.10.0');
  assert.equal(pickLatestRelease([rel('v1.0.0', { prerelease: true })]), null);
  assert.equal(pickLatestRelease([]), null);
  assert.equal(pickLatestRelease(null), null);
  assert.equal(pickLatestRelease(rel('v1.0.0'))?.tag_name, 'v1.0.0', 'single object (releases/latest) is accepted');
  assert.ok(!isEligibleRelease({ ...rel('v1.0.0'), draft: true }));
});

// ---------------------------------------------------------------- origin / sha

test('sha verification helpers', () => {
  assert.ok(shasMatch(SHA_A, SHA_A.toUpperCase()));
  assert.ok(!shasMatch(SHA_A, SHA_B));
  assert.ok(!shasMatch('abc123', 'abc123'), 'short SHAs are never accepted');
  assert.ok(!shasMatch('', ''));
  assert.equal(normalizeGithubRemote('https://x-token:abc@github.com/Owner/Repo.git/'), 'https://github.com/owner/repo');
  assert.equal(normalizeGithubRemote('git@github.com:owner/repo.git'), null);
  assert.equal(normalizeGithubRemote('https://evil.example/github.com/owner/repo.git'), null);
  assert.ok(originMatchesRepo(`https://github.com/${REPO}.git`, REPO));
  assert.ok(originMatchesRepo(`https://ghp_x@github.com/${REPO}`, REPO));
  assert.ok(!originMatchesRepo('https://github.com/someone-else/ServCrafty.git', REPO));
  assert.ok(!originMatchesRepo('http://github.com/joaquincabrerasimoes/ServCrafty.git', REPO), 'https only');
});

type Route = { status: number; body?: unknown; headers?: Record<string, string> };

function mockFetch(routes: Record<string, Route | ((init: RequestInit | undefined) => Route)>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = url.replace(`https://api.github.com/repos/${REPO}`, '');
    const r = routes[key];
    if (!r) return new Response('{"message":"Not Found"}', { status: 404 });
    const route = typeof r === 'function' ? r(init) : r;
    return new Response(route.status === 304 ? null : JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: route.headers,
    });
  }) as typeof fetch;
  return { fn, calls };
}

test('resolveTagCommit follows annotated tags and reports verification', async () => {
  const { fn } = mockFetch({
    '/git/ref/tags/v0.2.0': { status: 200, body: { object: { type: 'tag', sha: TAG_OBJ } } },
    [`/git/tags/${TAG_OBJ}`]: { status: 200, body: { object: { type: 'commit', sha: SHA_A }, verification: { verified: true } } },
    [`/commits/${SHA_A}`]: { status: 200, body: { sha: SHA_A, commit: { verification: { verified: false } } } },
    '/git/ref/tags/v0.1.0': { status: 200, body: { object: { type: 'commit', sha: SHA_B } } },
    [`/commits/${SHA_B}`]: { status: 200, body: { sha: SHA_B, commit: { verification: { verified: false } } } },
    '/git/ref/tags/v0.0.9': { status: 200, body: { object: { type: 'commit', sha: SHA_B } } },
  });
  const gh = new GitHubClient({ repo: REPO, fetch: fn, now: () => 0 });
  assert.deepEqual(await resolveTagCommit(gh, 'v0.2.0'), { sha: SHA_A, verified: true });
  assert.deepEqual(await resolveTagCommit(gh, 'v0.1.0'), { sha: SHA_B, verified: false });
  await assert.rejects(resolveTagCommit(gh, 'v9.9.9'), /not found/);
});

test('resolveTagCommit rejects a commit lookup that disagrees with the tag', async () => {
  const { fn } = mockFetch({
    '/git/ref/tags/v0.2.0': { status: 200, body: { object: { type: 'commit', sha: SHA_A } } },
    [`/commits/${SHA_A}`]: { status: 200, body: { sha: SHA_B, commit: {} } },
  });
  const gh = new GitHubClient({ repo: REPO, fetch: fn, now: () => 0 });
  await assert.rejects(resolveTagCommit(gh, 'v0.2.0'), /different SHA/);
});

test('GitHubClient revalidates with ETag and honours the rate limit', async () => {
  let n = 0;
  let now = 1_000_000;
  const { fn, calls } = mockFetch({
    '/releases?per_page=30': (init) => {
      n++;
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (h['If-None-Match'] === '"e1"') {
        return { status: 304, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 60_000) / 1000) } };
      }
      return { status: 200, body: [rel('v1.0.0')], headers: { etag: '"e1"', 'x-ratelimit-remaining': '59' } };
    },
  });
  const gh = new GitHubClient({ repo: REPO, fetch: fn, now: () => now });
  const first = await gh.get('/releases?per_page=30');
  const second = await gh.get('/releases?per_page=30');
  assert.deepEqual(second, first, '304 returns the cached body');
  assert.equal(calls[1]?.headers['If-None-Match'], '"e1"');
  await assert.rejects(gh.get('/releases?per_page=30'), /rate limit/);
  assert.equal(n, 2, 'no request is sent while rate limited');
  now += 61_000;
  await gh.get('/releases?per_page=30');
  assert.equal(n, 3);
});

// ---------------------------------------------------------------- capabilities

const okProbe: CapabilityProbe = {
  installType: 'lxc',
  isGitRepo: true,
  hasGit: true,
  hasSystemdRun: true,
  hasSystemctl: true,
  isRoot: true,
  appRootWritable: true,
  appRoot: '/opt/servcrafty',
};

test('capability detection', () => {
  assert.deepEqual(evaluateCapabilities(okProbe), { canUpdate: true, reason: null });
  assert.ok(evaluateCapabilities({ ...okProbe, installType: 'source' }).canUpdate);
  const cases: Array<[Partial<CapabilityProbe>, RegExp]> = [
    [{ installType: 'docker' }, /docker compose pull/],
    [{ isGitRepo: false }, /not a git checkout/],
    [{ hasGit: false }, /git is not installed/],
    [{ hasSystemdRun: false }, /systemd-run/],
    [{ hasSystemctl: false }, /systemctl/],
    [{ isRoot: false }, /root/],
    [{ appRootWritable: false }, /not writable/],
  ];
  for (const [patch, re] of cases) {
    const r = evaluateCapabilities({ ...okProbe, ...patch });
    assert.equal(r.canUpdate, false, JSON.stringify(patch));
    assert.match(r.reason ?? '', re);
  }
  assert.equal(detectInstallType('docker', true), 'docker');
  assert.equal(detectInstallType(undefined, true), 'lxc');
  assert.equal(detectInstallType(undefined, false), 'source');
});

// ---------------------------------------------------------------- files

test('status / previous parsing and utf-8 safe log cuts', () => {
  assert.equal(parseStatus(null).state, 'idle');
  assert.equal(parseStatus('{oops').state, 'idle');
  assert.equal(parseStatus('{"state":"weird"}').state, 'idle');
  const st = parseStatus('{"state":"rolled_back","step":"health","message":"x","fromVersion":"0.1.0"}');
  assert.equal(st.state, 'rolled_back');
  assert.equal(st.targetVersion, null);
  assert.equal(parsePrevious(`{"sha":"${SHA_A}","version":"0.1.0"}`)?.version, '0.1.0');
  assert.equal(parsePrevious('{"sha":"short"}'), null);
  const euro = Buffer.from('ab€', 'utf8'); // € is 3 bytes
  assert.equal(utf8SafeLength(euro), 5);
  assert.equal(utf8SafeLength(euro.subarray(0, 4)), 2);
  assert.equal(utf8SafeLength(euro.subarray(0, 3)), 2);
});

// ---------------------------------------------------------------- service

async function makeService(opts: {
  routes: Parameters<typeof mockFetch>[0];
  probe?: Partial<CapabilityProbe>;
  exec?: ExecFn;
  currentVersion?: string;
  checkEnabled?: boolean;
}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scf-upd-'));
  const appRoot = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(path.join(appRoot, 'lxc'), { recursive: true });
  await fsp.writeFile(path.join(appRoot, 'lxc', 'apply-update.sh'), '#!/bin/bash\n');
  const { fn, calls } = mockFetch(opts.routes);
  const execCalls: Array<{ file: string; args: string[] }> = [];
  let now = Date.parse('2026-11-09T12:00:00Z');
  const deps: UpdateDeps = {
    repo: REPO,
    checkEnabled: opts.checkEnabled ?? true,
    appRoot,
    dataDir,
    currentVersion: opts.currentVersion ?? '0.1.0',
    port: 8080,
    fetch: fn,
    exec: async (file, args, o) => {
      execCalls.push({ file, args });
      return opts.exec ? opts.exec(file, args, o) : { code: 0, stdout: '', stderr: '' };
    },
    now: () => now,
    countRunningServers: async () => 2,
    probe: { ...okProbe, appRoot, ...opts.probe },
  };
  return {
    svc: new UpdateService(deps),
    calls,
    execCalls,
    dataDir,
    appRoot,
    advance: (ms: number) => {
      now += ms;
    },
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

const releaseRoutes = {
  '/releases?per_page=30': { status: 200, body: [rel('v0.2.0'), rel('v0.3.0-rc.1', { prerelease: true })], headers: { etag: '"r1"' } },
  '/git/ref/tags/v0.2.0': { status: 200, body: { object: { type: 'commit', sha: SHA_A } } },
  [`/commits/${SHA_A}`]: { status: 200, body: { sha: SHA_A, commit: { verification: { verified: true } } } },
};

test('service: no releases -> latest null, no error, cached for 6 h', async () => {
  const t = await makeService({ routes: { '/releases?per_page=30': { status: 200, body: [] } } });
  try {
    const p = await t.svc.payload();
    assert.equal(p.latest, null);
    assert.equal(p.updateAvailable, false);
    assert.equal(p.checkError, null);
    assert.ok(p.checkedAt);
    assert.equal(p.installType, 'lxc');
    assert.equal(p.dockerCommand, null);
    assert.equal(p.runningServers, 2);
    assert.equal(p.status.state, 'idle');
    await t.svc.payload();
    assert.equal(t.calls.length, 1, 'second call served from cache');
    t.advance(CHECK_TTL_MS + 1);
    await t.svc.payload();
    assert.equal(t.calls.length, 2, 'refreshed after the TTL');
    await t.svc.payload({ force: true });
    assert.equal(t.calls.length, 3, 'forced check');
  } finally {
    await t.cleanup();
  }
});

test('service: network failure surfaces as checkError, never throws', async () => {
  const t = await makeService({ routes: {} });
  const failing = (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  }) as typeof fetch;
  // swap the fetch of the internal client
  (t.svc as unknown as { gh: { opts: { fetch: typeof fetch } } }).gh.opts.fetch = failing;
  try {
    const p = await t.svc.payload();
    assert.match(p.checkError ?? '', /ENOTFOUND/);
    assert.equal(p.latest, null);
  } finally {
    await t.cleanup();
  }
});

test('service: UPDATE_CHECK=0 makes no network calls', async () => {
  const t = await makeService({ routes: releaseRoutes, checkEnabled: false });
  try {
    const p = await t.svc.payload({ force: true });
    assert.equal(t.calls.length, 0);
    assert.match(p.checkError ?? '', /disabled/);
  } finally {
    await t.cleanup();
  }
});

test('service: update available, apply spawns systemd-run with the verified SHA', async () => {
  const t = await makeService({ routes: releaseRoutes });
  try {
    const p = await t.svc.payload();
    assert.equal(p.updateAvailable, true);
    assert.deepEqual(
      { v: p.latest?.version, tag: p.latest?.tag, sha: p.latest?.commitSha, verified: p.latest?.verified },
      { v: '0.2.0', tag: 'v0.2.0', sha: SHA_A, verified: true },
    );
    const target = await t.svc.apply();
    assert.equal(target.version, '0.2.0');
    const run = t.execCalls.find((c) => c.file === 'systemd-run');
    assert.ok(run, 'systemd-run was called');
    const script = path.join(t.dataDir, 'update', 'apply-update.sh');
    assert.ok(fs.existsSync(script), 'script copied out of the repo');
    assert.ok(run.args.includes('--unit=servcrafty-updater') && run.args.includes('--collect') && run.args.includes('--no-block'));
    const tail = run.args.slice(run.args.indexOf('bash'));
    assert.deepEqual(tail, ['bash', script, 'v0.2.0', SHA_A, t.appRoot, t.dataDir]);
    const after = await t.svc.payload();
    assert.equal(after.status.state, 'running');
    assert.equal(after.status.targetVersion, '0.2.0');
    await assert.rejects(t.svc.apply(), (e: { code?: string }) => e.code === 'update_in_progress');
  } finally {
    await t.cleanup();
  }
});

test('service: apply refuses when it cannot update, or when nothing is newer', async () => {
  const docker = await makeService({ routes: releaseRoutes, probe: { installType: 'docker' } });
  try {
    const p = await docker.svc.payload();
    assert.equal(p.canUpdate, false);
    assert.equal(p.dockerCommand, 'docker compose pull && docker compose up -d');
    await assert.rejects(docker.svc.apply(), (e: { code?: string; status?: number }) => e.code === 'cannot_update' && e.status === 400);
  } finally {
    await docker.cleanup();
  }
  const current = await makeService({ routes: releaseRoutes, currentVersion: '0.2.0' });
  try {
    await assert.rejects(current.svc.apply(), (e: { code?: string }) => e.code === 'no_update');
    await assert.rejects(current.svc.apply('0.1.5'), (e: { code?: string }) => e.code === 'no_update');
    await assert.rejects(current.svc.apply('0.3.0-rc.1'), (e: { code?: string }) => e.code === 'no_update');
    await assert.rejects(current.svc.rollback(), (e: { code?: string }) => e.code === 'no_rollback');
  } finally {
    await current.cleanup();
  }
});

test('service: a failing systemd-run marks the status failed', async () => {
  const t = await makeService({
    routes: releaseRoutes,
    exec: async (file) => (file === 'systemd-run' ? { code: 1, stdout: '', stderr: 'Failed to connect to bus' } : { code: 0, stdout: '', stderr: '' }),
  });
  try {
    await assert.rejects(t.svc.apply(), (e: { code?: string }) => e.code === 'updater_start_failed');
    const p = await t.svc.payload();
    assert.equal(p.status.state, 'failed');
    assert.match(p.status.message ?? '', /Failed to connect to bus/);
  } finally {
    await t.cleanup();
  }
});

test('service: rollback availability and log reading by offset', async () => {
  const t = await makeService({ routes: { '/releases?per_page=30': { status: 200, body: [] } } });
  try {
    const dir = path.join(t.dataDir, 'update');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'previous.json'), JSON.stringify({ sha: SHA_B, version: '0.0.9' }));
    await fsp.writeFile(path.join(dir, 'status.json'), JSON.stringify({ state: 'succeeded', step: 'done', targetVersion: '0.1.0' }));
    await fsp.writeFile(path.join(dir, 'update.log'), 'line 1\nline 2\n');
    const p = await t.svc.payload();
    assert.equal(p.rollbackAvailable, true);
    assert.equal(p.previousVersion, '0.0.9');
    const a = await t.svc.readLog(0);
    assert.deepEqual(a, { text: 'line 1\nline 2\n', offset: 14, state: 'succeeded' });
    await fsp.appendFile(path.join(dir, 'update.log'), 'line 3\n');
    assert.equal((await t.svc.readLog(a.offset)).text, 'line 3\n');
    assert.equal((await t.svc.readLog(9999)).offset, 21, 'offset beyond the end restarts at 0');
    await t.svc.rollback();
    const run = t.execCalls.find((c) => c.file === 'systemd-run');
    assert.deepEqual(run?.args.slice(-3), ['--rollback', t.appRoot, t.dataDir]);
  } finally {
    await t.cleanup();
  }
});

test('service: stale "running" status without an updater unit is reported as failed', async () => {
  const t = await makeService({
    routes: { '/releases?per_page=30': { status: 200, body: [] } },
    exec: async (file) => (file === 'systemctl' ? { code: 3, stdout: 'inactive', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
  });
  try {
    const dir = path.join(t.dataDir, 'update');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'status.json'), JSON.stringify({ state: 'running', step: 'build', startedAt: '2026-11-09T11:00:00Z' }));
    const p = await t.svc.payload();
    assert.equal(p.status.state, 'failed');
    assert.equal(p.status.step, 'build');
  } finally {
    await t.cleanup();
  }
});

test('service: unchanged release list (304) reuses the resolved commit', async () => {
  const routes = {
    ...releaseRoutes,
    '/releases?per_page=30': (init: RequestInit | undefined) =>
      ((init?.headers ?? {}) as Record<string, string>)['If-None-Match'] === '"r1"'
        ? { status: 304 }
        : { status: 200, body: [rel('v0.2.0')], headers: { etag: '"r1"' } },
  };
  const t = await makeService({ routes });
  try {
    await t.svc.payload();
    assert.equal(t.calls.length, 3, 'releases + ref + commit');
    const p = await t.svc.payload({ force: true });
    assert.equal(t.calls.length, 4, 'only the releases list is revalidated');
    assert.equal(p.latest?.commitSha, SHA_A);
    assert.equal(p.latest?.verified, true);
  } finally {
    await t.cleanup();
  }
});
