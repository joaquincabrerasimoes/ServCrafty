import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'servcrafty-bluemap-'));
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.SECRET_KEY = 'x'.repeat(40);
process.env.DATA_DIR = dataDir;

const lib = await import('../src/lib/bluemap.js');
const svc = await import('../src/services/bluemap.js');
const { toPublicServer } = await import('../src/services/types.js');
type ServerRow = import('../src/services/types.js').ServerRow;

const ID = '0b6f6c1e-4a2f-4e0a-9d52-6f7a1c0f9a11';

test('only plain Java servers with a plugin or mod loader support BlueMap', () => {
  for (const t of ['PAPER', 'PURPUR', 'FOLIA', 'SPIGOT']) assert.equal(lib.bluemapKind(t), 'plugin', t);
  for (const t of ['FABRIC', 'QUILT', 'FORGE', 'NEOFORGE']) assert.equal(lib.bluemapKind(t), 'mod', t);
  for (const t of ['VANILLA', 'BUKKIT', 'CURSEFORGE', 'MODRINTH', 'BEDROCK', 'TERRARIA', 'STEAMCMD']) assert.equal(lib.bluemapKind(t), null, t);
  assert.equal(lib.bluemapConfigDir('PAPER'), 'plugins/BlueMap');
  assert.equal(lib.bluemapConfigDir('FABRIC'), 'config/bluemap');
  assert.equal(lib.bluemapConfigDir('VANILLA'), null);
});

test('schema and role names are derived from the server id and strictly validated', () => {
  const name = lib.schemaNameFor(ID);
  assert.equal(name, 'bluemap_0b6f6c1e4a2f4e0a9d526f7a1c0f9a11');
  assert.ok(name.length <= 63);
  assert.equal(lib.ident(name), `"${name}"`);
  assert.throws(() => lib.schemaNameFor('x; DROP SCHEMA public'), /invalid/);
  assert.throws(() => lib.ident('public'), /invalid/);
  assert.throws(() => lib.ident('bluemap_x"; DROP TABLE users; --'), /invalid/);
});

test('database target: DATABASE_URL host, admin override, loopback refused', () => {
  const ok = lib.resolveDbTarget('postgres://u:p%40ss@db.lan:5433/servcrafty?sslmode=require', undefined);
  assert.deepEqual(ok, { ok: true, target: { host: 'db.lan', port: 5433, database: 'servcrafty', sslmode: 'require' } });

  const local = lib.resolveDbTarget('postgres://u:p@localhost/servcrafty', undefined);
  assert.deepEqual(local, { ok: false, reason: 'loopback' });
  assert.deepEqual(lib.resolveDbTarget('postgres://u:p@127.0.0.1:5432/x', undefined), { ok: false, reason: 'loopback' });
  assert.deepEqual(lib.resolveDbTarget('postgres://u:p@[::1]:5432/x', undefined), { ok: false, reason: 'loopback' });

  const over = lib.resolveDbTarget('postgres://u:p@localhost:5432/servcrafty', '192.168.69.10');
  assert.deepEqual(over, { ok: true, target: { host: '192.168.69.10', port: 5432, database: 'servcrafty' } });
  const overPort = lib.resolveDbTarget('postgres://u:p@localhost:5432/servcrafty', 'db.lan:6543');
  assert.deepEqual(overPort, { ok: true, target: { host: 'db.lan', port: 6543, database: 'servcrafty' } });
  // An override that is itself loopback does not help.
  assert.deepEqual(lib.resolveDbTarget('postgres://u:p@db.lan/x', 'localhost'), { ok: false, reason: 'loopback' });
  assert.deepEqual(lib.resolveDbTarget('not a url', undefined), { ok: false, reason: 'invalid_database_url' });
  assert.deepEqual(lib.resolveDbTarget('postgres://u:p@db.lan', undefined), { ok: false, reason: 'invalid_database_url' });
});

test('parseHostPort accepts hosts, ports and IPv6 and rejects junk', () => {
  assert.deepEqual(lib.parseHostPort('db.lan'), { host: 'db.lan', port: null });
  assert.deepEqual(lib.parseHostPort(' db.lan:5432 '), { host: 'db.lan', port: 5432 });
  assert.deepEqual(lib.parseHostPort('10.0.0.5'), { host: '10.0.0.5', port: null });
  assert.deepEqual(lib.parseHostPort('[fd00::5]:5432'), { host: 'fd00::5', port: 5432 });
  for (const bad of ['', 'a b', 'db.lan:99999', 'db.lan:0', 'jdbc:postgresql://x', 'db/lan', '-x']) assert.equal(lib.parseHostPort(bad), null, bad);
});

test('JDBC url selects the server schema and carries sslmode', () => {
  assert.equal(
    lib.jdbcUrl({ host: 'db.lan', port: 5432, database: 'servcrafty' }, 'bluemap_abc'),
    'jdbc:postgresql://db.lan:5432/servcrafty?currentSchema=bluemap_abc',
  );
  assert.equal(
    lib.jdbcUrl({ host: 'fd00::5', port: 5433, database: 'a b', sslmode: 'require' }, 'bluemap_abc'),
    'jdbc:postgresql://[fd00::5]:5433/a%20b?currentSchema=bluemap_abc&sslmode=require',
  );
});

test('config files: marker first, credentials quoted, SSE off', () => {
  const sql = lib.renderSqlConf({ url: 'jdbc:postgresql://db/x?currentSchema=s', user: 'u"ser', password: 'pa"ss\\w' });
  assert.ok(sql.startsWith(lib.BLUEMAP_MARKER));
  assert.match(sql, /storage-type: sql/);
  assert.ok(!/driver-jar/.test(sql));
  const withDriver = lib.renderSqlConf({ url: 'jdbc:postgresql://db/x', user: 'u', password: 'p', driverJar: '/data/config/bluemap/postgresql-42.7.4.jar' });
  assert.match(withDriver, /driver-jar: "\/data\/config\/bluemap\/postgresql-42\.7\.4\.jar"/);
  assert.match(withDriver, /driver-class: "org\.postgresql\.Driver"/);
  assert.match(sql, /password: "pa\\"ss\\\\w"/);
  assert.match(sql, /user: "u\\"ser"/);
  assert.match(lib.renderCoreConf(), /accept-download: true/);
  assert.ok(lib.renderCoreConf().startsWith(lib.BLUEMAP_MARKER));
  const ws = lib.renderWebserverConf();
  assert.match(ws, /port: 8100/);
  assert.match(ws, /sse-enabled: false/);
  assert.ok(lib.isManaged(ws));
  assert.ok(!lib.isManaged('port: 8100'));
});

test('map configs switch from the file storage to sql, and only that', () => {
  const generated = 'world: "world"\ndimension: "minecraft:overworld"\nname: "Overworld"\n\n# comment\nstorage: "file"\nsorting: 0\n';
  const r = lib.rewriteMapStorage(generated);
  assert.equal(r.changed, true);
  assert.match(r.text, /^storage: "sql"$/m);
  assert.match(r.text, /name: "Overworld"/);
  assert.equal(lib.rewriteMapStorage(r.text).changed, false);
  assert.equal(lib.rewriteMapStorage('storage: "mine"\n').changed, false);
  assert.equal(lib.rewriteMapStorage('storage:"file" # keep\n').text, 'storage:"sql" # keep\n');
  assert.equal(lib.rewriteMapStorage('#storage: "file"\n').changed, false);
});

test('MODRINTH_PROJECTS gets BlueMap once, keeping the admin\'s own entries', () => {
  assert.equal(lib.addBluemapProject(undefined), 'bluemap');
  assert.equal(lib.addBluemapProject(''), 'bluemap');
  assert.equal(lib.addBluemapProject('luckperms'), 'luckperms,bluemap');
  assert.equal(lib.addBluemapProject('luckperms, bluemap'), 'luckperms,bluemap');
  assert.equal(lib.addBluemapProject('fabric-api:beta modrinth:bluemap:Xyz'), 'fabric-api:beta,modrinth:bluemap:Xyz');
  assert.equal(lib.addBluemapProject('bluemap-extras'), 'bluemap-extras,bluemap');
});

test('BlueMap jars are recognised by name', () => {
  for (const n of ['BlueMap-5.4-paper.jar', 'bluemap-5.4-fabric.jar', 'BlueMap.jar']) assert.ok(lib.isBluemapJar(n), n);
  for (const n of ['LuckPerms.jar', 'bluemap-extras.jar', 'bluemap-5.4.jar.bak', 'MyBlueMap.jar']) assert.ok(!lib.isBluemapJar(n), n);
});

function row(over: Partial<ServerRow>): ServerRow {
  return { id: ID, type: 'PAPER', bluemap: null, created_at: new Date(0), ...over } as ServerRow;
}

test('public server JSON reports support, state and the proxy url', () => {
  const pub = (r: ServerRow) => toPublicServer(r, 'owner').bluemap;
  assert.deepEqual(pub(row({})), { supported: true, enabled: false, url: null });
  assert.deepEqual(pub(row({ type: 'VANILLA' })), { supported: false, enabled: false, url: null });
  const state = { enabled: true, schema: lib.schemaNameFor(ID), role: lib.schemaNameFor(ID), passwordEnc: 'x', enabledAt: '' };
  assert.deepEqual(pub(row({ bluemap: state })), { supported: true, enabled: true, url: `/api/servers/${ID}/webui/bluemap/` });
  assert.equal(pub(row({ bluemap: { ...state, enabled: false } })).enabled, false);
  // A stale flag on a type that cannot run BlueMap anymore is not reported as enabled.
  assert.equal(pub(row({ type: 'VANILLA', bluemap: state })).enabled, false);
});

const serverFiles = () => path.join(dataDir, 'servers', ID);
const write = (rel: string, text: string) => {
  const f = path.join(serverFiles(), rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const read = (rel: string) => fs.readFileSync(path.join(serverFiles(), rel), 'utf8');

test('patchMapStorage rewrites BlueMap\'s generated map configs in place', async () => {
  write('plugins/BlueMap/maps/overworld.conf', 'world: "world"\nstorage: "file"\n');
  write('plugins/BlueMap/maps/nether.conf', 'world: "world_nether"\nstorage: "sql"\n');
  assert.equal(await svc.patchMapStorage({ id: ID, type: 'PAPER' }), 1);
  assert.match(read('plugins/BlueMap/maps/overworld.conf'), /storage: "sql"/);
  assert.equal(await svc.patchMapStorage({ id: ID, type: 'PAPER' }), 0);
  assert.equal(await svc.patchMapStorage({ id: ID, type: 'VANILLA' }), 0);
});

test('a server without BlueMap loses the managed files and jar (clone/restore never keeps the original\'s credentials)', async () => {
  write('plugins/BlueMap/storages/sql.conf', `${lib.BLUEMAP_MARKER}\nstorage-type: sql\npassword: "secret"\n`);
  write('plugins/BlueMap/storages/file.conf', `${lib.BLUEMAP_MARKER}\nstorage-type: sql\n`);
  write('plugins/BlueMap/core.conf', lib.renderCoreConf());
  write('plugins/BlueMap/webserver.conf', 'enabled: true\n'); // the user's own file, no marker
  write('plugins/BlueMap-5.4-paper.jar', 'jar');
  write('plugins/LuckPerms.jar', 'jar');
  const logs: string[] = [];
  await svc.prepareBluemap(row({ bluemap: null }), (l) => logs.push(l));
  assert.ok(!fs.existsSync(path.join(serverFiles(), 'plugins/BlueMap/storages/sql.conf')));
  assert.ok(!fs.existsSync(path.join(serverFiles(), 'plugins/BlueMap/storages/file.conf')));
  assert.ok(!fs.existsSync(path.join(serverFiles(), 'plugins/BlueMap/core.conf')));
  assert.ok(!fs.existsSync(path.join(serverFiles(), 'plugins/BlueMap-5.4-paper.jar')));
  assert.ok(fs.existsSync(path.join(serverFiles(), 'plugins/BlueMap/webserver.conf')), 'user files stay');
  assert.ok(fs.existsSync(path.join(serverFiles(), 'plugins/LuckPerms.jar')), 'other plugins stay');
  assert.deepEqual(logs, []);
});

test('a server nobody configured BlueMap for is left alone', async () => {
  write('plugins/BlueMap-5.4-paper.jar', 'jar');
  write('plugins/BlueMap/core.conf', 'accept-download: false\n');
  await svc.prepareBluemap(row({ bluemap: null }), () => undefined);
  assert.ok(fs.existsSync(path.join(serverFiles(), 'plugins/BlueMap-5.4-paper.jar')), 'a hand-installed BlueMap is not removed');
});

test('watchBluemapMaps patches maps generated after the first boot, then reloads once the server runs', async () => {
  fs.rmSync(serverFiles(), { recursive: true, force: true });
  let status = 'starting';
  const commands: string[] = [];
  const logs: string[] = [];
  svc.watchBluemapMaps(
    { id: ID, type: 'PAPER' },
    { status: () => status, command: async (c) => void commands.push(c), log: (l) => logs.push(l) },
    { intervalMs: 20, maxMs: 5000 },
  );
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(commands, [], 'nothing generated yet');
  write('plugins/BlueMap/maps/overworld.conf', 'storage: "file"\n');
  await new Promise((r) => setTimeout(r, 120));
  assert.match(read('plugins/BlueMap/maps/overworld.conf'), /storage: "sql"/);
  assert.deepEqual(commands, [], 'no reload while the server is still starting');
  status = 'running';
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(commands, ['bluemap reload']);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(commands, ['bluemap reload'], 'reloads once');
});

test('watchBluemapMaps stops when the server stops', async () => {
  fs.rmSync(serverFiles(), { recursive: true, force: true });
  let calls = 0;
  svc.watchBluemapMaps(
    { id: ID, type: 'PAPER' },
    {
      status: () => {
        calls++;
        return 'stopped';
      },
      command: async () => undefined,
      log: () => undefined,
    },
    { intervalMs: 10, maxMs: 5000 },
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls, 1);
});
