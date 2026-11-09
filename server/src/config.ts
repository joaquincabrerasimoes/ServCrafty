import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Absolute path of the `server/` package directory (works from src/ and dist/). */
export const SERVER_ROOT = path.resolve(here, '..');

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SECRET_KEY: z.string().min(32, 'SECRET_KEY must be at least 32 characters'),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_EMAIL: z.string().optional(),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  DATA_DIR: z.string().default('/data'),
  HOST_DATA_DIR: z.string().optional(),
  DOCKER_HOST: z.string().default('unix:///var/run/docker.sock'),
  DOCKER_NETWORK: z.string().default('servcrafty'),
  CURSEFORGE_API_KEY: z.string().optional(),
  PORT_POOL_DEFAULT: z.string().default('25565-25600'),
  WEB_DIST: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  /**
   * Development aid: when "1", RCON is additionally published on 127.0.0.1:<random>
   * of the docker host and ServCrafty dials that instead of the container IP
   * (needed with Docker Desktop, where container IPs are not routable).
   */
  RCON_PUBLISH_LOCAL: z.string().optional(),
  /** GitHub `owner/name` the self-updater checks for releases. */
  UPDATE_REPO: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'UPDATE_REPO must look like owner/name')
    .default('joaquincabrerasimoes/ServCrafty'),
  /** "0" (or "false"/"off") disables the network update check. */
  UPDATE_CHECK: z.string().optional(),
  INSTALL_TYPE: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() || undefined : v),
    z.enum(['docker', 'lxc', 'source']).optional(),
  ),
  /** Optional token for GitHub API calls (raises the 60 req/h anonymous limit). */
  GITHUB_TOKEN: z.string().optional(),
});

export type AppConfig = {
  nodeEnv: string;
  isProd: boolean;
  port: number;
  host: string;
  databaseUrl: string;
  secretKey: string;
  adminUsername: string;
  adminPassword: string | undefined;
  adminEmail: string | undefined;
  publicUrl: string;
  dataDir: string;
  hostDataDir: string;
  serversDir: string;
  backupsDir: string;
  tmpDir: string;
  dockerHost: string;
  dockerNetwork: string;
  curseforgeApiKey: string | undefined;
  portPoolDefault: string;
  webDist: string;
  trustProxy: boolean;
  logLevel: string;
  rconPublishLocal: boolean;
  updateRepo: string;
  updateCheck: boolean;
  installType: 'docker' | 'lxc' | 'source' | undefined;
  githubToken: string | undefined;
};

function load(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const e = parsed.data;
  const dataDir = path.resolve(e.DATA_DIR);
  return {
    nodeEnv: e.NODE_ENV,
    isProd: e.NODE_ENV === 'production',
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    secretKey: e.SECRET_KEY,
    adminUsername: e.ADMIN_USERNAME,
    adminPassword: e.ADMIN_PASSWORD || undefined,
    adminEmail: e.ADMIN_EMAIL || undefined,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ''),
    dataDir,
    hostDataDir: e.HOST_DATA_DIR ? e.HOST_DATA_DIR.replace(/[\\/]+$/, '') : dataDir,
    serversDir: path.join(dataDir, 'servers'),
    backupsDir: path.join(dataDir, 'backups'),
    tmpDir: path.join(dataDir, 'tmp'),
    dockerHost: e.DOCKER_HOST,
    dockerNetwork: e.DOCKER_NETWORK,
    curseforgeApiKey: e.CURSEFORGE_API_KEY || undefined,
    portPoolDefault: e.PORT_POOL_DEFAULT,
    webDist: e.WEB_DIST ? path.resolve(e.WEB_DIST) : path.resolve(SERVER_ROOT, '../web/dist'),
    trustProxy: e.TRUST_PROXY === '1' || e.TRUST_PROXY === 'true',
    logLevel: e.LOG_LEVEL,
    rconPublishLocal: e.RCON_PUBLISH_LOCAL === '1' || e.RCON_PUBLISH_LOCAL === 'true',
    updateRepo: e.UPDATE_REPO,
    updateCheck: !['0', 'false', 'off', 'no'].includes((e.UPDATE_CHECK ?? '').trim().toLowerCase()),
    installType: e.INSTALL_TYPE,
    githubToken: e.GITHUB_TOKEN || undefined,
  };
}

let cached: AppConfig | undefined;

/** Lazily-loaded, validated configuration. Throws on invalid env. */
export function config(): AppConfig {
  if (!cached) cached = load();
  return cached;
}

/** Repository root (parent of `server/`). */
export const APP_ROOT = path.resolve(SERVER_ROOT, '..');

/**
 * Version of the running code, read once from `server/package.json` at startup.
 * Read once on purpose: during a self-update the file on disk changes before the
 * process is restarted, and /api/health must keep reporting the running version.
 */
function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = readPackageVersion();
export const USER_AGENT = `ServCrafty/${APP_VERSION} (self-hosted Minecraft panel)`;
