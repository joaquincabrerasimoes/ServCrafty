import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { AppError, badRequest, conflict, errorMessage, upstream } from '../lib/errors.js';
import {
  bluemapConfigDir,
  bluemapKind,
  ident,
  isBluemapJar,
  isManaged,
  jdbcUrl,
  CONTAINER_DATA,
  PG_DRIVER_FILE,
  PG_DRIVER_URL,
  renderCoreConf,
  renderSqlConf,
  renderWebserverConf,
  resolveDbTarget,
  rewriteMapStorage,
  schemaNameFor,
  type DbTarget,
} from '../lib/bluemap.js';
import { serverDir } from './docker.js';
import { getBluemapDbHost } from './settings.js';
import type { BluemapState, ServerRow } from './types.js';

/** Config directories BlueMap may use, whatever the loader (a clone/restore can come from another type). */
const CONFIG_DIRS = ['plugins/BlueMap', 'config/bluemap'];

// ---------------------------------------------------------------------------------------------
// Database target

export type DbIssue = 'loopback' | 'invalid_database_url';

/** The database as game containers must reach it, or why it cannot be reached. */
export async function dbTarget(): Promise<{ target: DbTarget } | { issue: DbIssue }> {
  const r = resolveDbTarget(config().databaseUrl, await getBluemapDbHost());
  return r.ok ? { target: r.target } : { issue: r.reason };
}

async function requireDbTarget(): Promise<DbTarget> {
  const r = await dbTarget();
  if ('target' in r) return r.target;
  if (r.issue === 'loopback') {
    throw badRequest(
      'The database host is localhost, which game containers cannot reach. Set "BlueMap database host" in Admin > Settings to an address they can use.',
      'bluemap_db_unreachable',
    );
  }
  throw badRequest('DATABASE_URL could not be read', 'bluemap_db_unreachable');
}

function privilegeError(err: unknown): AppError {
  const code = (err as { code?: string }).code;
  if (code === '42501') {
    return badRequest(
      'The ServCrafty database user cannot create roles and schemas. Grant it CREATEROLE and CREATE on the database (ALTER ROLE <user> CREATEROLE; GRANT CREATE ON DATABASE <db> TO <user>).',
      'bluemap_db_privileges',
    );
  }
  return upstream(`BlueMap database setup failed: ${errorMessage(err)}`, 'bluemap_db_error');
}

// ---------------------------------------------------------------------------------------------
// Role + schema

const newPassword = () => crypto.randomBytes(24).toString('hex');

async function roleExists(role: string): Promise<boolean> {
  return !!(await queryOne('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]));
}

/** Panel-side connection settings with the role's own credentials (proves it can log in). */
async function verifyLogin(role: string, password: string, schema: string): Promise<void> {
  const u = new URL(config().databaseUrl);
  const sslmode = u.searchParams.get('sslmode');
  const client = new pg.Client({
    host: decodeURIComponent(u.hostname.replace(/^\[|\]$/g, '')),
    port: u.port ? Number(u.port) : 5432,
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: role,
    password,
    connectionTimeoutMillis: 8000,
    ...(sslmode && sslmode !== 'disable' && sslmode !== 'prefer' && sslmode !== 'allow' ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  try {
    await client.connect();
    const r = await client.query<{ s: string }>('SELECT current_schema() AS s');
    if (r.rows[0]?.s !== schema) throw new Error(`the role's search_path points at "${r.rows[0]?.s}"`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Create (or reuse) the server's role and schema. Returns the state to store. */
async function provision(server: ServerRow): Promise<BluemapState> {
  const schema = schemaNameFor(server.id);
  const role = schema;
  const existing = server.bluemap;
  let password = existing?.passwordEnc ? safeDecrypt(existing.passwordEnc) : null;
  let passwordEnc = existing?.passwordEnc ?? '';
  const created: { role: boolean; schema: boolean } = { role: false, schema: false };
  try {
    const hadRole = await roleExists(role);
    if (!hadRole || !password) {
      password = newPassword();
      passwordEnc = encrypt(password);
      // DDL cannot take bind parameters: the identifier is validated and the password is hex.
      if (hadRole) {
        // Only the password: a non-superuser may not even restate NOSUPERUSER on an existing role.
        await query(`ALTER ROLE ${ident(role)} PASSWORD '${password}'`);
      } else {
        await query(`CREATE ROLE ${ident(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 20`);
        created.role = true;
      }
    }
    const hadSchema = !!(await queryOne('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]));
    if (!hadSchema) {
      await query(`CREATE SCHEMA ${ident(schema)}`);
      created.schema = true;
    }
    await query(`GRANT USAGE, CREATE ON SCHEMA ${ident(schema)} TO ${ident(role)}`);
    await query(`ALTER ROLE ${ident(role)} SET search_path = ${ident(schema)}`);
    await verifyLogin(role, password, schema).catch((err: unknown) => {
      throw upstream(
        `The new database role could not log in (${errorMessage(err)}). Check that pg_hba.conf allows password logins from the panel and the game containers.`,
        'bluemap_db_login_failed',
      );
    });
  } catch (err) {
    // Undo only what this call created: an existing map's data is never dropped by a failed enable.
    if (created.schema) await query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`).catch(() => undefined);
    if (created.role) await query(`DROP ROLE IF EXISTS ${ident(role)}`).catch(() => undefined);
    throw err instanceof AppError ? err : privilegeError(err);
  }
  return { enabled: true, schema, role, passwordEnc, enabledAt: new Date().toISOString() };
}

function safeDecrypt(enc: string): string | null {
  try {
    return decrypt(enc);
  } catch {
    return null; // SECRET_KEY changed: the role gets a new password
  }
}

/** Drop a server's schema (all map data) and role. Idempotent; connections of the role are closed first. */
export async function dropBluemapData(state: Pick<BluemapState, 'schema' | 'role'> | null | undefined, serverId: string): Promise<void> {
  const schema = state?.schema ?? schemaNameFor(serverId);
  const role = state?.role ?? schema;
  await query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [role]).catch(() => undefined);
  await query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
  await query(`DROP ROLE IF EXISTS ${ident(role)}`);
}

// ---------------------------------------------------------------------------------------------
// Public operations

export interface BluemapStatus {
  supported: boolean;
  enabled: boolean;
  /** `plugin` or `mod`: what gets installed. */
  kind: 'plugin' | 'mod' | null;
  /** Map data stored for this server (kept while BlueMap is disabled). */
  dataBytes: number | null;
  tables: number | null;
  /** Why enabling would fail right now (database host unreachable from containers). */
  dbIssue: DbIssue | null;
  /** The running server must restart for the last change to apply. */
  restartRequired: boolean;
  /** The public (no sign-in) map link is on. The URL itself is only given to the owner. */
  publicEnabled: boolean;
}

export async function schemaUsage(schema: string): Promise<{ bytes: number; tables: number } | null> {
  const exists = await queryOne('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
  if (!exists) return null;
  const r = await queryOne<{ bytes: string; tables: number }>(
    `SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0)::text AS bytes, count(*)::int AS tables
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'`,
    [schema],
  );
  return { bytes: Number(r?.bytes ?? 0), tables: r?.tables ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Public link (anyone with the URL can view the live map, no sign-in)

/** The secret path token of the public map link, or null when the link is off (or cannot be decrypted). */
export function publicTokenOf(server: Pick<ServerRow, 'bluemap'>): string | null {
  const enc = server.bluemap?.publicTokenEnc;
  return enc ? safeDecrypt(enc) : null;
}

export const publicPathFor = (serverId: string, token: string) => `/api/servers/${serverId}/webui/bluemap/~t/${token}/`;

/** Turn the public link on (new token if there is none), regenerate it (the old URL stops working) or turn it off. */
export async function setPublicLink(server: ServerRow, mode: 'enable' | 'regenerate' | 'disable'): Promise<ServerRow> {
  assertSupported(server);
  if (!server.bluemap) throw badRequest('BlueMap is not enabled for this server', 'bluemap_not_enabled');
  let publicTokenEnc: string | null = null;
  if (mode !== 'disable') {
    if (!server.bluemap.enabled) throw badRequest('BlueMap is not enabled for this server', 'bluemap_not_enabled');
    const keep = mode === 'enable' && publicTokenOf(server) ? (server.bluemap.publicTokenEnc ?? null) : null;
    publicTokenEnc = keep ?? encrypt(crypto.randomBytes(24).toString('base64url'));
  }
  const row = await queryOne<ServerRow>('UPDATE servers SET bluemap = $2 WHERE id = $1 RETURNING *', [
    server.id,
    JSON.stringify({ ...server.bluemap, publicTokenEnc }),
  ]);
  publicCache.clear();
  return row ?? server;
}

const publicCache = new Map<string, { ok: boolean; at: number }>();
const sha = (s: string) => crypto.createHash('sha256').update(s).digest();

/** Is `token` the current public-link token of this server's map? Cached for a few seconds (a map page is many requests). */
export async function verifyPublicToken(serverId: string, token: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(serverId) || !/^[\w-]{16,128}$/.test(token)) return false;
  const key = `${serverId}:${token}`;
  const hit = publicCache.get(key);
  if (hit && Date.now() - hit.at < 5_000) return hit.ok;
  const row = await queryOne<ServerRow>('SELECT * FROM servers WHERE id = $1', [serverId]);
  const current = row && bluemapKind(row.type) && row.bluemap?.enabled ? publicTokenOf(row) : null;
  const ok = !!current && crypto.timingSafeEqual(sha(current), sha(token));
  if (publicCache.size > 2000) publicCache.clear();
  publicCache.set(key, { ok, at: Date.now() });
  return ok;
}

export async function bluemapStatus(server: ServerRow, restartRequired = false): Promise<BluemapStatus> {
  const kind = bluemapKind(server.type);
  const usage = server.bluemap ? await schemaUsage(server.bluemap.schema).catch(() => null) : null;
  const db = kind ? await dbTarget().catch(() => ({ issue: 'invalid_database_url' as DbIssue })) : null;
  return {
    supported: kind !== null,
    enabled: !!server.bluemap?.enabled && kind !== null,
    kind,
    dataBytes: usage?.bytes ?? null,
    tables: usage?.tables ?? null,
    dbIssue: db && 'issue' in db ? db.issue : null,
    restartRequired,
    publicEnabled: !!publicTokenOf(server) && !!server.bluemap?.enabled,
  };
}

function assertSupported(server: ServerRow): void {
  if (!bluemapKind(server.type)) {
    throw badRequest('BlueMap needs a Java server with a plugin or mod loader (Paper, Purpur, Folia, Spigot, Fabric, Quilt, Forge, NeoForge)', 'bluemap_unsupported');
  }
}

export async function enableBluemap(server: ServerRow, acceptDownload: boolean): Promise<ServerRow> {
  assertSupported(server);
  if (!acceptDownload) {
    throw badRequest("BlueMap downloads the Minecraft client from Mojang: accept Mojang's EULA to continue", 'bluemap_eula_required');
  }
  await requireDbTarget();
  const state = await provision(server);
  const row = await queryOne<ServerRow>('UPDATE servers SET bluemap = $2 WHERE id = $1 RETURNING *', [server.id, JSON.stringify(state)]);
  return row ?? server;
}

export async function disableBluemap(server: ServerRow, deleteData: boolean, running: boolean): Promise<ServerRow> {
  assertSupported(server);
  if (!server.bluemap) return server;
  if (deleteData) {
    if (running) throw conflict('Stop the server before deleting its map data', 'server_running');
    await dropBluemapData(server.bluemap, server.id).catch((err: unknown) => {
      throw privilegeError(err);
    });
    const row = await queryOne<ServerRow>('UPDATE servers SET bluemap = NULL WHERE id = $1 RETURNING *', [server.id]);
    return row ?? server;
  }
  const row = await queryOne<ServerRow>('UPDATE servers SET bluemap = $2 WHERE id = $1 RETURNING *', [
    server.id,
    JSON.stringify({ ...server.bluemap, enabled: false, publicTokenEnc: null }),
  ]);
  return row ?? server;
}

/** Throw away all rendered tiles (the map renders again from the world). The server must be stopped. */
export async function resetBluemapData(server: ServerRow, running: boolean): Promise<void> {
  assertSupported(server);
  if (!server.bluemap?.enabled) throw badRequest('BlueMap is not enabled for this server', 'bluemap_not_enabled');
  if (running) throw conflict('Stop the server before resetting its map data', 'server_running');
  const { schema, role } = server.bluemap;
  try {
    await query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [role]).catch(() => undefined);
    await query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
    await query(`CREATE SCHEMA ${ident(schema)}`);
    await query(`GRANT USAGE, CREATE ON SCHEMA ${ident(schema)} TO ${ident(role)}`);
  } catch (err) {
    throw privilegeError(err);
  }
}

// ---------------------------------------------------------------------------------------------
// Files on disk

async function readText(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, text: string | Buffer, mode: number): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, text, { mode });
  await fsp.chmod(tmp, mode).catch(() => undefined);
  await fsp.rename(tmp, file);
}

/** Write a file unless the user took it over (it exists without our marker). */
async function writeManaged(file: string, text: string): Promise<void> {
  const cur = await readText(file);
  if (cur !== null && !isManaged(cur)) return;
  await writeAtomic(file, text, 0o644);
}

async function listConf(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir)).filter((n) => n.endsWith('.conf')).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * Switch BlueMap's generated map configs to the SQL storage. BlueMap writes them itself on its first
 * run (with `storage: "file"`), so this is applied before every start and again after the first boot.
 * Returns how many files changed.
 */
export async function patchMapStorage(server: Pick<ServerRow, 'id' | 'type'>): Promise<number> {
  const dir = bluemapConfigDir(server.type);
  if (!dir) return 0;
  let changed = 0;
  for (const file of await listConf(path.join(serverDir(server.id), dir, 'maps'))) {
    const cur = await readText(file);
    if (cur === null) continue;
    const r = rewriteMapStorage(cur);
    if (r.changed) {
      await writeAtomic(file, r.text, 0o644);
      changed++;
    }
  }
  return changed;
}

/** Downloads the PostgreSQL JDBC driver once (checked against Maven's SHA-1) and keeps a copy in the data dir. */
async function cachedDriver(log: (line: string) => void): Promise<string> {
  const cache = path.join(config().dataDir, 'cache', 'bluemap', PG_DRIVER_FILE);
  if (await fsp.stat(cache).then((s) => s.size > 0, () => false)) return cache;
  log('[servcrafty] BlueMap: downloading the PostgreSQL JDBC driver');
  const get = async (url: string) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res;
  };
  const jar = Buffer.from(await (await get(PG_DRIVER_URL)).arrayBuffer());
  const expected = (await (await get(`${PG_DRIVER_URL}.sha1`)).text()).trim().split(/\s+/)[0]?.toLowerCase();
  const actual = crypto.createHash('sha1').update(jar).digest('hex');
  if (!expected || expected !== actual) throw new Error('the downloaded PostgreSQL driver does not match its checksum');
  await fsp.mkdir(path.dirname(cache), { recursive: true });
  await writeAtomic(cache, jar, 0o644);
  return cache;
}

async function installDriver(dest: string, log: (line: string) => void): Promise<void> {
  if (await fsp.stat(dest).then((s) => s.size > 0, () => false)) return;
  let src: string;
  try {
    src = await cachedDriver(log);
  } catch (err) {
    throw upstream(`BlueMap needs the PostgreSQL JDBC driver and it could not be downloaded: ${errorMessage(err)}`, 'bluemap_driver_download');
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
  await fsp.chmod(dest, 0o644).catch(() => undefined);
}

/** Remove the files ServCrafty wrote (and BlueMap's jar) from a server that does not use BlueMap. */
async function cleanupManaged(server: ServerRow): Promise<void> {
  const root = serverDir(server.id);
  let removed = 0;
  for (const rel of CONFIG_DIRS) {
    const dir = path.join(root, rel);
    for (const file of [path.join(dir, 'core.conf'), path.join(dir, 'webserver.conf'), path.join(dir, 'storages', 'sql.conf'), path.join(dir, 'storages', 'file.conf')]) {
      const cur = await readText(file);
      if (cur !== null && isManaged(cur)) {
        await fsp.rm(file, { force: true });
        removed++;
      }
    }
  }
  if (!removed) return;
  for (const rel of CONFIG_DIRS) await fsp.rm(path.join(root, rel, PG_DRIVER_FILE), { force: true });
  // The managed config is gone, so the jar would only run BlueMap with defaults: remove it with the config.
  for (const sub of ['plugins', 'mods']) {
    const dir = path.join(root, sub);
    for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
      if (isBluemapJar(name)) await fsp.rm(path.join(dir, name), { force: true });
    }
  }
}

/**
 * Called before the container is created. Enabled: write core/webserver/storage config (and switch
 * existing map configs to SQL). Otherwise remove what we wrote, so a clone or a restored backup of a
 * BlueMap server can never keep writing into the original's schema.
 */
export async function prepareBluemap(server: ServerRow, log: (line: string) => void): Promise<void> {
  const rel = bluemapConfigDir(server.type);
  if (!rel) return;
  if (!server.bluemap?.enabled) {
    await cleanupManaged(server).catch((err: unknown) => log(`[servcrafty] BlueMap cleanup failed: ${errorMessage(err)}`));
    return;
  }
  const target = await requireDbTarget();
  const password = safeDecrypt(server.bluemap.passwordEnc);
  if (!password) throw badRequest('The BlueMap database password cannot be decrypted (SECRET_KEY changed). Disable and enable BlueMap again.', 'bluemap_secret_lost');
  const dir = path.join(serverDir(server.id), rel);
  await writeManaged(path.join(dir, 'core.conf'), renderCoreConf());
  // A core.conf BlueMap generated itself still has accept-download off: the user accepted when enabling.
  const core = await readText(path.join(dir, 'core.conf'));
  if (core !== null && !isManaged(core) && /^\s*accept-download\s*:\s*false\b/m.test(core)) {
    await writeAtomic(path.join(dir, 'core.conf'), core.replace(/^(\s*accept-download\s*:\s*)false\b/m, '$1true'), 0o644);
  }
  await writeManaged(path.join(dir, 'webserver.conf'), renderWebserverConf());
  // Always rewritten: it carries the credentials. World-readable on purpose: the game process may run as
  // another user than the panel, and the role can only reach this server's own schema.
  await installDriver(path.join(dir, PG_DRIVER_FILE), log);
  const sql = renderSqlConf({
    url: jdbcUrl(target, server.bluemap.schema),
    user: server.bluemap.role,
    password,
    driverJar: `${CONTAINER_DATA}/${rel}/${PG_DRIVER_FILE}`,
  });
  await writeAtomic(path.join(dir, 'storages', 'sql.conf'), sql, 0o644);
  // BlueMap generates its default maps with `storage: "file"` and refuses to load when no storage of that
  // name exists. Defining "file" as the same PostgreSQL storage makes those maps use the database from the
  // very first load (the map-config patch below then only normalises the name).
  await writeAtomic(path.join(dir, 'storages', 'file.conf'), sql, 0o644);
  const patched = await patchMapStorage(server);
  if (patched) log(`[servcrafty] BlueMap: ${patched} map config(s) switched to the PostgreSQL storage`);
}

// ---------------------------------------------------------------------------------------------
// After the first boot

const watching = new Set<string>();

/**
 * BlueMap generates its default map configs on its first run, after the container is up. Poll for
 * them, switch them to SQL, and ask BlueMap to reload once the server accepts commands.
 */
export function watchBluemapMaps(
  server: Pick<ServerRow, 'id' | 'type'>,
  deps: { status: () => string; command: (cmd: string) => Promise<unknown>; log: (line: string) => void },
  opts: { intervalMs?: number; maxMs?: number } = {},
): void {
  if (watching.has(server.id)) return;
  watching.add(server.id);
  const interval = opts.intervalMs ?? 10_000;
  const deadline = Date.now() + (opts.maxMs ?? 15 * 60_000);
  let pendingReload = false;
  const tick = async (): Promise<void> => {
    try {
      const st = deps.status();
      if (st !== 'starting' && st !== 'running') return void watching.delete(server.id);
      const n = await patchMapStorage(server);
      if (n) {
        pendingReload = true;
        deps.log(`[servcrafty] BlueMap: ${n} generated map config(s) switched to the PostgreSQL storage`);
      }
      if (pendingReload && st === 'running') {
        await deps.command('bluemap reload');
        deps.log('[servcrafty] BlueMap: reloaded with the PostgreSQL storage');
        pendingReload = false;
        return void watching.delete(server.id);
      }
      if (Date.now() > deadline) return void watching.delete(server.id);
    } catch (err) {
      deps.log(`[servcrafty] BlueMap: ${errorMessage(err)}`);
      if (Date.now() > deadline) return void watching.delete(server.id);
    }
    setTimeout(() => void tick(), interval).unref();
  };
  setTimeout(() => void tick(), Math.min(interval, 5_000)).unref();
}
