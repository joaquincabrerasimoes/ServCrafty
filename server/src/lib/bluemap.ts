/**
 * BlueMap integration (SPEC "BlueMap (v0.4.0)"): pure helpers. The mod/plugin runs inside the Java
 * server's container and stores its map tiles in PostgreSQL, in a schema (and role) of its own per
 * server; the panel reaches its built-in web server through the authenticated web UI proxy.
 */
import type { ServerType } from './validation.js';

export const BLUEMAP_PORT = 8100;
/** Modrinth project slug (itzg `MODRINTH_PROJECTS` installs the build for the server's loader). */
export const BLUEMAP_PROJECT = 'bluemap';
/** Id of the built-in web UI in `/servers/:id/webui/:uiId`. */
export const BLUEMAP_UI_ID = 'bluemap';
/** First line of every file ServCrafty writes, so it never overwrites or removes a user's own file. */
export const BLUEMAP_MARKER = '# servcrafty-managed: BlueMap (this file is rewritten on every start; delete this line to take it over)';

export type BluemapKind = 'plugin' | 'mod';

/** Servers that can run BlueMap: plain Java servers with a plugin or mod loader (no modpacks, no vanilla). */
export function bluemapKind(type: ServerType | string): BluemapKind | null {
  switch (type) {
    case 'PAPER':
    case 'PURPUR':
    case 'FOLIA':
    case 'SPIGOT':
      return 'plugin';
    case 'FABRIC':
    case 'QUILT':
    case 'FORGE':
    case 'NEOFORGE':
      return 'mod';
    default:
      return null;
  }
}

/** Where the loader keeps BlueMap's config, relative to the server directory. */
export function bluemapConfigDir(type: ServerType | string): string | null {
  const k = bluemapKind(type);
  return k === 'plugin' ? 'plugins/BlueMap' : k === 'mod' ? 'config/bluemap' : null;
}

/** `BlueMap.jar` or `bluemap-<version>-<loader>.jar` (Modrinth's file names); not other plugins that start with the same word. */
export const isBluemapJar = (name: string) => /^bluemap(-\d[-_.0-9a-z]*)?\.jar$/i.test(name);

// ---------------------------------------------------------------------------------------------
// Database identifiers

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SCHEMA_RE = /^bluemap_[0-9a-f]{32}$/;

/** Schema and role name of a server: `bluemap_<uuid without dashes>` (40 characters, safe to quote). */
export function schemaNameFor(serverId: string): string {
  if (!UUID_RE.test(serverId)) throw new Error('invalid server id');
  return `bluemap_${serverId.replace(/-/g, '').toLowerCase()}`;
}

export const isSchemaName = (s: string) => SCHEMA_RE.test(s);

/** A quoted identifier that has been checked against the strict pattern (never user input). */
export function ident(name: string): string {
  if (!SCHEMA_RE.test(name)) throw new Error('invalid identifier');
  return `"${name}"`;
}

// ---------------------------------------------------------------------------------------------
// Database target the game container connects to

export interface DbTarget {
  host: string;
  port: number;
  database: string;
  /** `sslmode` of DATABASE_URL, handed to the JDBC driver. */
  sslmode?: string;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '' || h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::' || /^127\./.test(h) || h.endsWith('.localhost');
}

/** Parse an admin-entered `host`, `host:port` or `[v6]:port`. Null when it is not one. */
export function parseHostPort(input: string): { host: string; port: number | null } | null {
  const s = input.trim();
  if (!s) return null;
  const v6 = /^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/i.exec(s);
  const named = v6 ? null : /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(s);
  const m = v6 ?? named;
  if (!m) return null;
  const host = m[1]!;
  const port = m[2] ? Number(m[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  return { host, port };
}

/**
 * The database as the GAME CONTAINERS must reach it: the host (and optionally port) override from
 * Admin > Settings, else the host of DATABASE_URL. Throws a message string when the result cannot
 * work from inside a container (loopback host).
 */
export function resolveDbTarget(databaseUrl: string, override: string | undefined): { ok: true; target: DbTarget } | { ok: false; reason: 'invalid_database_url' | 'loopback' } {
  let u: URL;
  try {
    u = new URL(databaseUrl);
  } catch {
    return { ok: false, reason: 'invalid_database_url' };
  }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) return { ok: false, reason: 'invalid_database_url' };
  let host = u.hostname.replace(/^\[|\]$/g, '');
  let port = u.port ? Number(u.port) : 5432;
  const ov = override ? parseHostPort(override) : null;
  if (ov) {
    host = ov.host;
    if (ov.port) port = ov.port;
  }
  if (isLoopbackHost(host)) return { ok: false, reason: 'loopback' };
  const sslmode = u.searchParams.get('sslmode') ?? undefined;
  return { ok: true, target: { host, port, database, ...(sslmode ? { sslmode } : {}) } };
}

export function jdbcUrl(t: DbTarget, schema: string): string {
  const host = t.host.includes(':') ? `[${t.host}]` : t.host;
  const params = [`currentSchema=${encodeURIComponent(schema)}`];
  if (t.sslmode) params.push(`sslmode=${encodeURIComponent(t.sslmode)}`);
  return `jdbc:postgresql://${host}:${t.port}/${encodeURIComponent(t.database)}?${params.join('&')}`;
}

// ---------------------------------------------------------------------------------------------
// Config files (HOCON)

/** A HOCON quoted string (JSON string syntax is valid HOCON). */
const q = (s: string) => JSON.stringify(s);

export function renderCoreConf(): string {
  return `${BLUEMAP_MARKER}
# By accepting you confirm Mojang's EULA (https://account.mojang.com/documents/minecraft_eula), that you own
# Minecraft: Java Edition, and that BlueMap may download the Minecraft client file it needs from Mojang.
accept-download: true
data: "bluemap"
render-thread-count: 1
metrics: false
`;
}

export function renderWebserverConf(): string {
  return `${BLUEMAP_MARKER}
enabled: true
webroot: "bluemap/web"
port: ${BLUEMAP_PORT}
# The panel's proxy answers one request at a time per connection: live pushes use polling instead.
sse-enabled: false
additional-headers: {
  "Cache-Control": "public, max-age=60"
}
`;
}

/** BlueMap does not ship a PostgreSQL driver: the panel downloads this one (Maven Central) for it. */
export const PG_DRIVER_VERSION = '42.7.4';
export const PG_DRIVER_FILE = `postgresql-${PG_DRIVER_VERSION}.jar`;
export const PG_DRIVER_URL = `https://repo1.maven.org/maven2/org/postgresql/postgresql/${PG_DRIVER_VERSION}/${PG_DRIVER_FILE}`;
export const PG_DRIVER_CLASS = 'org.postgresql.Driver';
/** Where the server's data directory is mounted inside the game container (itzg). */
export const CONTAINER_DATA = '/data';

export interface SqlConf {
  url: string;
  user: string;
  password: string;
  /** Path of the JDBC driver jar as the game container sees it. */
  driverJar?: string;
}

export function renderSqlConf(c: SqlConf): string {
  return `${BLUEMAP_MARKER}
storage-type: sql
${c.driverJar ? `driver-jar: ${q(c.driverJar)}\ndriver-class: ${q(PG_DRIVER_CLASS)}\n` : ''}connection-url: ${q(c.url)}
connection-properties: {
  user: ${q(c.user)}
  password: ${q(c.password)}
}
max-connections: 8
compression: gzip
`;
}

/** What `rewriteMapStorage` does to a map config: BlueMap's generated maps use the "file" storage. */
export function rewriteMapStorage(conf: string): { text: string; changed: boolean } {
  const re = /^(\s*storage\s*:\s*)(["']?)file\2(\s*(?:#.*)?)$/m;
  if (!re.test(conf)) return { text: conf, changed: false };
  return { text: conf.replace(re, '$1"sql"$3'), changed: true };
}

export const isManaged = (text: string) => text.includes('# servcrafty-managed: BlueMap');

// ---------------------------------------------------------------------------------------------
// Container environment

/** `MODRINTH_PROJECTS` with BlueMap added once (itzg accepts comma or whitespace separated slugs). */
export function addBluemapProject(existing: string | undefined): string {
  const items = (existing ?? '').split(/[\s,]+/).filter(Boolean);
  if (!items.some((i) => i.toLowerCase().replace(/^[a-z]+:/, '').split(':')[0] === BLUEMAP_PROJECT)) items.push(BLUEMAP_PROJECT);
  return items.join(',');
}

// ---------------------------------------------------------------------------------------------
// Public server JSON

export interface BluemapPublic {
  /** The server type can run BlueMap. */
  supported: boolean;
  enabled: boolean;
  /** URL of the proxied map (redirects into a token-scoped proxy session); null when not enabled. */
  url: string | null;
}
