import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, afterEach, before } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'servcrafty-test-'));
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.SECRET_KEY = 'x'.repeat(40);
process.env.DATA_DIR = dataDir;

const { installMod, listMods } = await import('../src/services/mods.js');
const cf = await import('../src/catalog/curseforge.js');
type ServerRow = import('../src/services/types.js').ServerRow;

const realFetch = globalThis.fetch;
const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

let requested: string[] = [];
type Handler = (url: URL) => Response | undefined;
let handlers: Handler[] = [];

before(() => {
  cf.keySource.get = async () => 'test-key';
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    requested.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`);
    for (const h of handlers) {
      const r = h(url);
      if (r) return r;
    }
    return new Response('not mocked', { status: 599 });
  }) as typeof fetch;
});
afterEach(() => {
  requested = [];
  handlers = [];
});
after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const server = (id: string, type: ServerRow['type'] = 'FABRIC') =>
  ({ id, type, mc_version: '1.21.1', modpack: null }) as unknown as ServerRow;
const bytes = (s: string) => Buffer.from(s);

function cfFile(
  id: number,
  modId: number,
  name: string,
  content: Buffer,
  deps: { modId: number; relationType: number }[],
  restricted = false,
) {
  return {
    id,
    modId,
    displayName: name,
    fileName: `${name}.jar`,
    releaseType: 1,
    fileDate: '2026-01-01T00:00:00Z',
    downloadCount: 1,
    downloadUrl: restricted ? null : `https://edge.forgecdn.test/${name}.jar`,
    fileLength: content.length,
    hashes: [{ value: sha1(content), algo: 1 }],
    gameVersions: ['1.21.1', 'Fabric'],
    dependencies: deps,
  };
}

const content: Record<string, Buffer> = { main: bytes('main-mod'), lib: bytes('lib-mod'), sub: bytes('sub-lib'), opt: bytes('optional') };

function mockCurseforge(files: Record<string, ReturnType<typeof cfFile>[]>) {
  handlers.push((url) => {
    if (url.host === 'api.curseforge.com') {
      const filesMatch = /^\/v1\/mods\/(\d+)\/files$/.exec(url.pathname);
      if (filesMatch) return json({ data: files[filesMatch[1]!] ?? [] });
      const modMatch = /^\/v1\/mods\/(\d+)$/.exec(url.pathname);
      if (modMatch) return json({ data: { id: Number(modMatch[1]), name: `Mod ${modMatch[1]}` } });
    }
    if (url.host === 'edge.forgecdn.test') {
      const body = content[url.pathname.slice(1).replace(/\.jar$/, '')];
      if (body) return new Response(body, { status: 200 });
    }
    return undefined;
  });
}

test('CurseForge install pulls in required dependencies (relationType 3), transitively, and skips the others', async () => {
  mockCurseforge({
    '100': [cfFile(1001, 100, 'main', content.main!, [{ modId: 200, relationType: 3 }, { modId: 300, relationType: 2 }, { modId: 400, relationType: 1 }])],
    '200': [cfFile(2001, 200, 'lib', content.lib!, [{ modId: 500, relationType: 3 }])],
    '500': [cfFile(5001, 500, 'sub', content.sub!, [])],
    '300': [cfFile(3001, 300, 'opt', content.opt!, [])],
  });
  const s = server('cf-deps');
  const r = await installMod(s, { source: 'curseforge', projectId: '100' });
  assert.deepEqual(r.installed.map((m) => m.file).sort(), ['lib.jar', 'main.jar', 'sub.jar']);
  assert.deepEqual(r.skipped, []);
  const { mods } = await listMods(s);
  assert.deepEqual(mods.map((m) => m.file), ['lib.jar', 'main.jar', 'sub.jar']);
  assert.ok(mods.every((m) => m.meta?.source === 'curseforge'));
  assert.ok(!requested.some((x) => x.includes('/v1/mods/300') || x.includes('/v1/mods/400')), 'optional/embedded deps must not be fetched');
  assert.equal(fs.readFileSync(path.join(dataDir, 'servers', 'cf-deps', 'mods', 'lib.jar'), 'utf8'), 'lib-mod');
});

test('CurseForge: an already installed dependency is not downloaded again', async () => {
  mockCurseforge({
    '100': [cfFile(1001, 100, 'main', content.main!, [{ modId: 200, relationType: 3 }])],
    '200': [cfFile(2001, 200, 'lib', content.lib!, [])],
  });
  const s = server('cf-installed');
  await installMod(s, { source: 'curseforge', projectId: '200' });
  requested = [];
  const r = await installMod(s, { source: 'curseforge', projectId: '100' });
  assert.deepEqual(r.installed.map((m) => m.file), ['main.jar']);
  assert.ok(!requested.some((x) => x.includes('edge.forgecdn.test/lib.jar')));
});

test('CurseForge: a dependency with restricted downloads is reported, not fatal; a restricted root still fails', async () => {
  mockCurseforge({
    '610': [cfFile(6101, 610, 'main', content.main!, [{ modId: 620, relationType: 3 }])],
    '620': [cfFile(6201, 620, 'lib', content.lib!, [], true)],
  });
  const r = await installMod(server('cf-restricted'), { source: 'curseforge', projectId: '610' });
  assert.deepEqual(r.installed.map((m) => m.file), ['main.jar']);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0]!.projectId, '620');
  assert.match(r.skipped[0]!.reason, /disabled third-party downloads/);

  await assert.rejects(installMod(server('cf-restricted-root'), { source: 'curseforge', projectId: '620' }), /disabled third-party downloads/);
});

test('CurseForge: dependency cycles terminate', async () => {
  mockCurseforge({
    '710': [cfFile(7101, 710, 'main', content.main!, [{ modId: 720, relationType: 3 }])],
    '720': [cfFile(7201, 720, 'lib', content.lib!, [{ modId: 710, relationType: 3 }])],
  });
  const r = await installMod(server('cf-cycle'), { source: 'curseforge', projectId: '710' });
  assert.deepEqual(r.installed.map((m) => m.file).sort(), ['lib.jar', 'main.jar']);
});

test('requiredDependencies keeps only relationType 3 and dedupes', () => {
  assert.deepEqual(
    cf.requiredDependencies({
      dependencies: [
        { modId: 1, relationType: 3 },
        { modId: 1, relationType: 3 },
        { modId: 2, relationType: 2 },
        { modId: 3, relationType: 5 },
      ],
    }),
    ['1'],
  );
  assert.deepEqual(cf.requiredDependencies({}), []);
});

const hgProject = (id: number, name: string) => ({
  id,
  name,
  namespace: { owner: 'o', slug: name },
  stats: {},
  category: 'misc',
  description: '',
  lastUpdated: '',
});

test('Hangar install picks the release channel, verifies sha256 and installs required Hangar dependencies', async () => {
  const main = bytes('hangar-main');
  const dep = bytes('hangar-dep');
  const dl = (name: string, b: Buffer) => ({
    PAPER: { fileInfo: { name, sizeBytes: b.length, sha256Hash: sha256(b) }, externalUrl: null, downloadUrl: `https://hangarcdn.test/${name}` },
  });
  const ver = (name: string, channel: string, b: Buffer, deps: unknown[] = []) => ({
    name,
    createdAt: '2026-01-01T00:00:00Z',
    channel: { name: channel },
    downloads: dl(`${name}.jar`, b),
    pluginDependencies: { PAPER: deps },
    platformDependencies: { PAPER: ['1.21.4'] },
  });
  handlers.push((url) => {
    if (url.host === 'hangar.papermc.io') {
      if (url.pathname === '/api/v1/projects/Main' || url.pathname === '/api/v1/projects/1') return json(hgProject(1, 'Main'));
      if (url.pathname === '/api/v1/projects/Dep' || url.pathname === '/api/v1/projects/2') return json(hgProject(2, 'Dep'));
      if (url.pathname === '/api/v1/projects/Main/versions')
        return json({
          pagination: {},
          result: [
            ver('2.0.0-SNAPSHOT', 'Snapshot', bytes('nope')),
            ver('1.9.0', 'Release', main, [
              { name: 'Dep', projectId: 2, required: true, externalUrl: null },
              { name: 'Soft', projectId: 3, required: false, externalUrl: null },
              { name: 'External', projectId: null, required: true, externalUrl: 'https://example.com' },
            ]),
          ],
        });
      if (url.pathname === '/api/v1/projects/Dep/versions') return json({ pagination: {}, result: [ver('0.5', 'Release', dep)] });
    }
    if (url.host === 'hangarcdn.test') {
      if (url.pathname === '/1.9.0.jar') return new Response(main);
      if (url.pathname === '/0.5.jar') return new Response(dep);
    }
    return undefined;
  });
  const s = server('hangar-1', 'PAPER');
  const r = await installMod(s, { source: 'hangar', projectId: 'Main' });
  assert.deepEqual(r.installed.map((m) => m.file).sort(), ['0.5.jar', '1.9.0.jar']);
  const { kind, mods } = await listMods(s);
  assert.equal(kind, 'plugins');
  assert.deepEqual(mods.map((m) => [m.meta?.source, m.meta?.projectId]).sort(), [['hangar', 'Dep'], ['hangar', 'Main']]);
});

test('Hangar install rejects a download whose sha256 does not match', async () => {
  handlers.push((url) => {
    if (url.pathname === '/api/v1/projects/Bad') return json(hgProject(9, 'Bad'));
    if (url.pathname === '/api/v1/projects/Bad/versions/1.0')
      return json({
        name: '1.0',
        createdAt: '2026-01-01T00:00:00Z',
        channel: { name: 'Release' },
        downloads: {
          PAPER: { fileInfo: { name: 'Bad-1.0.jar', sizeBytes: 3, sha256Hash: '0'.repeat(64) }, downloadUrl: 'https://hangarcdn.test/Bad-1.0.jar' },
        },
      });
    if (url.host === 'hangarcdn.test') return new Response('abc');
    return undefined;
  });
  const s = server('hangar-bad', 'PAPER');
  await assert.rejects(installMod(s, { source: 'hangar', projectId: 'Bad', fileId: '1.0' }), /hash mismatch/);
  assert.equal((await listMods(s)).mods.length, 0);
});
