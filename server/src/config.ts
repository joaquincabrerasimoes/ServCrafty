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
  };
}

let cached: AppConfig | undefined;

/** Lazily-loaded, validated configuration. Throws on invalid env. */
export function config(): AppConfig {
  if (!cached) cached = load();
  return cached;
}

export const APP_VERSION = '0.1.0';
export const USER_AGENT = `ServCrafty/${APP_VERSION} (self-hosted Minecraft panel)`;
