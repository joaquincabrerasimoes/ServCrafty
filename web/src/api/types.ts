// Types mirroring SPEC.md. Where the spec leaves a response shape open, fields are optional.

export type Role = 'admin' | 'user';
export type ThemePref = 'light' | 'dark' | 'system';
export type Locale = 'en' | 'es';

export interface User {
  id: string;
  username: string;
  email?: string | null;
  role: Role;
  locale?: Locale | null;
  theme?: ThemePref | null;
  disabled?: boolean;
  maxServers?: number | null;
  maxRamMb?: number | null;
  maxCpu?: number | null;
  maxDiskMb?: number | null;
  usage?: { servers: number; ram_mb: number; cpu: number; disk_mb: number };
  totpEnabled?: boolean;
  createdAt?: string;
}

export type LoginResponse =
  | { status: 'ok'; user: User }
  | { status: 'mfa_required'; methods: Array<'totp' | 'passkey'> };

export interface MeResponse {
  user: User;
  mfa: { totp: boolean; passkeys: number };
}

export interface Quotas {
  maxServers?: number | null;
  maxRamMb?: number | null;
  maxCpu?: number | null;
  maxDiskMb?: number | null;
}

export interface HostLimits {
  maxServers: number | null;
  maxRamMb: number | null;
  maxCpu: number | null;
  maxDiskMb: number | null;
}

export interface UsageTotals {
  servers: number;
  ram_mb: number;
  cpu: number;
  disk_mb: number;
}

export interface QuotaResponse {
  limits: Quotas;
  usage: UsageTotals;
  /** Host-wide caps and the combined use of every user's servers. */
  host?: { limits: HostLimits; usage: UsageTotals };
}

export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export interface Passkey {
  id: string;
  name?: string | null;
  transports?: string[];
  createdAt?: string;
  lastUsedAt?: string | null;
}

export interface ApiToken {
  id: string;
  name: string;
  prefix?: string;
  createdAt?: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  token?: string; // only on creation
}

export const SERVER_TYPES = [
  'VANILLA',
  'PAPER',
  'PURPUR',
  'FOLIA',
  'FABRIC',
  'QUILT',
  'FORGE',
  'NEOFORGE',
  'BEDROCK',
  'CURSEFORGE',
  'MODRINTH',
] as const;
export type ServerType = (typeof SERVER_TYPES)[number];

export type ServerStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'crashed' | 'installing';
export type Access = 'owner' | 'admin' | 'viewer' | 'operator' | 'manager';
export type ShareLevel = 'viewer' | 'operator' | 'manager';
export type CatalogSource = 'curseforge' | 'modrinth' | 'hangar';

export interface ModpackRef {
  source: CatalogSource;
  projectId: string;
  fileId?: string;
  versionId?: string;
  name?: string;
  versionName?: string;
}

export interface Server {
  id: string;
  ownerId?: string;
  ownerName?: string;
  name: string;
  type: ServerType;
  mcVersion: string;
  loaderVersion?: string | null;
  modpack?: ModpackRef | null;
  javaArgs?: string | null;
  memoryMb: number;
  cpu: number;
  diskMb?: number | null;
  port: number;
  env?: Record<string, string>;
  minecraft?: MinecraftConfig | null;
  containerId?: string | null;
  status: ServerStatus;
  autoRestart?: boolean;
  lanAnnounce?: boolean;
  createdAt?: string;
  access: Access;
}

export interface CreateServerBody {
  name: string;
  type: ServerType;
  mcVersion: string;
  loaderVersion?: string;
  modpack?: ModpackRef;
  memoryMb: number;
  cpu: number;
  diskMb?: number;
  port?: number;
  env?: Record<string, string>;
  autoRestart?: boolean;
  lanAnnounce?: boolean;
  minecraft?: MinecraftConfig;
  eula: true;
}

/** Initial Minecraft configuration (POST /servers `minecraft`), applied on the first start. */
export interface MinecraftConfig {
  levelName?: string;
  gameMode?: 'survival' | 'creative' | 'adventure' | 'spectator';
  forceGamemode?: boolean;
  hardcore?: boolean;
  difficulty?: 'peaceful' | 'easy' | 'normal' | 'hard';
  motd?: string;
  maxPlayers?: number;
  pvp?: boolean;
  onlineMode?: boolean;
  allowFlight?: boolean;
  allowCheats?: boolean;
  commandBlocks?: boolean;
  allowNether?: boolean;
  spawnAnimals?: boolean;
  spawnMonsters?: boolean;
  spawnNpcs?: boolean;
  playerIdleTimeout?: number;
  seed?: string;
  levelType?: 'default' | 'flat' | 'largebiomes' | 'amplified' | 'single_biome_surface' | 'legacy';
  generateStructures?: boolean;
  generatorSettings?: string;
  spawnProtection?: number;
  maxWorldSize?: number;
  whitelist?: { enabled?: boolean; enforce?: boolean; users?: string[] };
  ops?: string[];
  viewDistance?: number;
  simulationDistance?: number;
  tickDistance?: number;
  entityBroadcastRange?: number;
  networkCompressionThreshold?: number;
  resourcePack?: { url?: string; sha1?: string; required?: boolean };
  extra?: Record<string, string>;
}

export interface Stats {
  status: ServerStatus;
  uptimeSec: number;
  memory: { usedMb: number; limitMb: number };
  cpuPercent: number;
  tps: number | null;
  mspt: { avg: number | null; p95: number | null };
  players: { online: number; max: number; list: Array<{ name: string }> };
  motd?: string;
  /** Minecraft version. */
  version?: string | null;
  packName?: string | null;
  packVersion?: string | null;
  source: 'agent' | 'rcon' | 'docker';
  diskMb?: number;
}

export type PowerAction = 'start' | 'stop' | 'restart' | 'kill';
export type PlayerAction = 'op' | 'deop' | 'kick' | 'ban' | 'pardon' | 'whitelist-add' | 'whitelist-remove';
export type PlayerList = 'whitelist' | 'ops' | 'banned';

export interface ListedPlayer {
  name: string;
  uuid?: string;
  level?: number;
  reason?: string;
  created?: string;
  source?: string;
  expires?: string;
}

/** A player the whitelist turned away, seen in the server log. */
export interface JoinAttempt {
  name: string;
  uuid: string | null;
  ip: string | null;
  attempts: number;
  firstSeen: string;
  lastSeen: string;
}

export interface FileEntry {
  name: string;
  path?: string;
  type?: 'file' | 'dir' | 'directory';
  isDir?: boolean;
  size?: number;
  mtime?: string;
  modifiedAt?: string;
}

export interface Backup {
  id: string;
  serverId?: string;
  file?: string;
  sizeBytes?: number;
  kind: 'manual' | 'scheduled';
  createdBy?: string | null;
  createdAt: string;
  note?: string | null;
}

export type ScheduleAction = 'restart' | 'command' | 'backup' | 'start' | 'stop';
export interface Schedule {
  id: string;
  serverId?: string;
  cron: string;
  action: ScheduleAction;
  payload?: string | null;
  enabled: boolean;
  lastRunAt?: string | null;
}

export interface Webhook {
  id: string;
  serverId?: string | null;
  url: string;
  kind: 'discord' | 'generic';
  events: string[];
  enabled: boolean;
}

export interface Share {
  userId: string;
  username?: string;
  level: ShareLevel;
}

export interface InstalledMod {
  file: string;
  name?: string;
  size?: number;
  enabled?: boolean;
  source?: CatalogSource | string;
  projectId?: string;
  version?: string;
}

export interface ModUpdate {
  file: string;
  name?: string;
  currentVersion?: string;
  latestVersion?: string;
  source?: CatalogSource;
  projectId?: string;
  fileId?: string;
}

export interface Template {
  id: string;
  ownerId?: string;
  name: string;
  description?: string | null;
  config?: Partial<CreateServerBody> & Record<string, unknown>;
  shared?: boolean;
  createdAt?: string;
}

export interface CatalogProject {
  id: string;
  source: CatalogSource;
  slug?: string;
  name: string;
  summary?: string;
  author?: string;
  iconUrl?: string;
  downloads?: number;
  mcVersions?: string[];
  loaders?: string[];
}

export interface CatalogVersion {
  id: string;
  name: string;
  mcVersions?: string[];
  loaders?: string[];
  date?: string;
}

export interface AdminSettings {
  lanNetworks?: string;
  globalLimits?: HostLimits;
  hostUsage?: UsageTotals;
  portPool: string;
  curseforgeKeySet: boolean;
  curseforgeKey?: string;
  defaultJavaArgs?: string;
  publicUrl?: string;
}

export interface PortEntry {
  port: number;
  serverId: string | null;
  serverName: string | null;
}

export interface AuditEntry {
  id: string | number;
  userId?: string | null;
  username?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  meta?: Record<string, unknown> | null;
  ip?: string | null;
  createdAt: string;
}

export type SystemInfo = Record<string, unknown>;

// WebSocket protocol
export type WsClientMessage =
  | { type: 'subscribe'; serverId: string; channels: Array<'logs' | 'stats'> }
  | { type: 'unsubscribe'; serverId: string }
  | { type: 'command'; serverId: string; command: string };

export type WsServerMessage =
  | { type: 'log'; serverId: string; line: string }
  | { type: 'stats'; serverId: string; stats: Stats }
  | { type: 'status'; serverId: string; status: ServerStatus }
  | { type: 'error'; message: string; serverId?: string };
