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
  /** May create and edit custom game definitions (admins always can). */
  canAuthorGames?: boolean;
  totpEnabled?: boolean;
  createdAt?: string;
  /** Game keys this user may create servers for (admin list/get). null = unrestricted (admins). */
  allowedGames?: string[] | null;
  /** /auth/me and login only: the game keys the signed-in user can create servers for right now. */
  creatableGames?: string[];
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
  'SPIGOT',
  'BUKKIT',
  'FABRIC',
  'QUILT',
  'FORGE',
  'NEOFORGE',
  'BEDROCK',
  'CURSEFORGE',
  'MODRINTH',
  'TERRARIA',
  'TSHOCK',
  'TMODLOADER',
  'STEAMCMD',
] as const;
export type ServerType = (typeof SERVER_TYPES)[number];

/** The game a server runs; `type` is the variant. Derived from `type` (see lib/games.ts). */
export type Game = 'minecraft' | 'terraria' | 'steam';

export const TERRARIA_LANGUAGES = ['en-US', 'de-DE', 'it-IT', 'fr-FR', 'es-ES', 'ru-RU', 'zh-Hans', 'pt-BR', 'pl-PL'] as const;
export type TerrariaLanguage = (typeof TERRARIA_LANGUAGES)[number];

/** Terraria configuration (servers.terraria). World creation values only matter until the world file exists. */
export interface TerrariaConfig {
  worldName: string;
  /** 1 small, 2 medium, 3 large. */
  size: 1 | 2 | 3;
  /** 0 normal, 1 expert, 2 master, 3 journey. */
  difficulty: 0 | 1 | 2 | 3;
  seed?: string;
  maxPlayers: number;
  password?: string;
  motd?: string;
  secure: boolean;
  language?: TerrariaLanguage;
  /** TMODLOADER only: numeric Steam Workshop ids. */
  workshopMods?: string[];
  /** Set by the world import route. */
  worldFile?: string;
}

export interface TerrariaWorld {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

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
  /** Always sent by the API; use `serverGame()` which falls back to the type. */
  game?: Game;
  type: ServerType;
  /** Minecraft version ("LATEST" for Terraria servers). */
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
  /** Null for Minecraft servers. */
  terraria?: TerrariaConfig | null;
  /** SteamCMD servers only (null for the other games). */
  steam?: ServerSteam | null;
  /** Host port of every published definition port except the main one (which is `port`). */
  extraPorts?: Record<string, number> | null;
  /** Steam servers: the definition's features and the web UI URLs this viewer may open (redirect into the proxy session). */
  steamGame?: ServerSteamGame | null;
  containerId?: string | null;
  status: ServerStatus;
  autoRestart?: boolean;
  /** Start when the host comes up, unless a user stopped it. */
  autoStart?: boolean;
  lanAnnounce?: boolean;
  createdAt?: string;
  access: Access;
  /** The game this server runs is disabled by an admin (no new servers). */
  gameDisabled?: boolean;
  /** The game is disabled with blockStart: the server cannot be started. */
  gameBlocked?: boolean;
  /** BlueMap web map (Java servers). `url` redirects into the proxy session. */
  bluemap?: { supported: boolean; enabled: boolean; url: string | null };
  /** Multiplayer-list icon of a Java server: file version for `?v=`, null = no icon. */
  icon?: number | null;
}

/** GET/PUT /servers/:id/bluemap. */
export interface BluemapStatus {
  supported: boolean;
  enabled: boolean;
  kind: 'plugin' | 'mod' | null;
  /** Map data stored in PostgreSQL (kept while BlueMap is disabled); null when none. */
  dataBytes: number | null;
  tables: number | null;
  /** Why enabling would fail: the database host is not reachable from game containers. */
  dbIssue: 'loopback' | 'invalid_database_url' | null;
  restartRequired: boolean;
  url: string | null;
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
  autoStart?: boolean;
  lanAnnounce?: boolean;
  minecraft?: MinecraftConfig;
  /** Terraria servers only. */
  terraria?: Partial<TerrariaConfig>;
  /** SteamCMD servers only (type STEAMCMD). */
  steam?: { gameId: string; vars: SteamVars; updateOnStart?: boolean };
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
  /** Game version (Minecraft version, or the Terraria log banner version). */
  version?: string | null;
  packName?: string | null;
  packVersion?: string | null;
  /** Current map (Steam A2S query). */
  map?: string | null;
  source: 'agent' | 'rcon' | 'docker' | 'a2s';
  diskMb?: number;
  /** SteamCMD servers while the executor installs or updates the game (null otherwise). */
  install?: InstallProgress | null;
}

export type InstallPhase = 'install' | 'workshop' | 'configure' | 'launch';
export interface InstallProgress {
  phase: InstallPhase | string;
  /** 0-100; null or absent while unknown. */
  progress?: number | null;
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
  /** Steam Web API key (write-only; enables Workshop search). */
  steamApiKey?: string;
  steamKeySet?: boolean;
  defaultJavaArgs?: string;
  publicUrl?: string;
  /** Host name players use to reach game servers from outside. */
  publicServersHost?: string;
  /** `host[:port]` game containers use to reach PostgreSQL for BlueMap (empty = DATABASE_URL's host). */
  bluemapDbHost?: string;
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

/* ------------------------------------------------------------ SteamCMD games (v0.3.0) */

export type SteamVarValue = string | number | boolean;
export type SteamVars = Record<string, SteamVarValue>;

/** servers.steam */
export interface ServerSteam {
  gameId: string;
  vars: SteamVars;
  workshop?: WorkshopRef[];
  updateOnStart: boolean;
  validateNext?: boolean;
}

export interface WorkshopRef {
  id: string;
  title?: string | null;
}

export type PortProtocol = 'udp' | 'tcp' | 'both';
export type GameVarType = 'string' | 'number' | 'boolean' | 'select' | 'password';

export interface GameSteamSource {
  appId: number;
  branch?: string | null;
  betaPassword?: string | null;
  platform?: 'linux' | 'windows';
  login?: string;
}

export interface GameResources {
  memoryMb?: number;
  memoryMinMb?: number;
  cpu?: number;
  diskMb?: number | null;
}

export interface GamePort {
  id: string;
  label?: string;
  protocol: PortProtocol;
  containerPort: number;
  mirror?: boolean;
  publish?: boolean;
  main?: boolean;
}

export interface GameVarOption {
  value: string | number;
  label?: string;
}

export interface GameVariable {
  key: string;
  label?: string;
  description?: string;
  type: GameVarType;
  default?: SteamVarValue | null;
  required?: boolean;
  min?: number;
  max?: number;
  options?: GameVarOption[];
  pattern?: string;
  group?: string;
  valueMap?: Record<string, string>;
  /** string/password only: an empty value is filled with a random one by the panel. */
  generate?: { length?: number; charset?: 'alnum' | 'hex' } | null;
}

/** A piece of a composite argument: literal text or a conditional piece. */
export type LaunchPart = string | { value: string; if?: string };
/**
 * One argv element: a string, a conditional `{value, if}`, or a composite `{parts, separator?, if?}`
 * whose included parts are joined with `separator` (default "") into ONE argument
 * (Unreal-style `Map?Key=value?Other=...`).
 */
export type LaunchArg = string | { value: string; if: string } | { parts: LaunchPart[]; separator?: string; if?: string };

export interface GameLaunch {
  cwd?: string;
  command: LaunchArg[];
  env?: Record<string, string>;
}

export type FileWhen = 'always' | 'missing';
export type GameFile =
  | { type: 'template'; path: string; content: string; when?: FileWhen }
  | {
      type: 'ini';
      path: string;
      when?: FileWhen;
      set?: Array<{ section: string; key: string; value: string }>;
      list?: Array<{ section: string; key: string; valuesFrom: string }>;
    };

export interface GameStop {
  type: 'signal' | 'stdin';
  signal?: string;
  command?: string;
  timeoutSec?: number;
}

export interface GameWebUi {
  id: string;
  label: string;
  portId: string;
  path?: string;
  auth?: { type: 'basic'; user: string; password: string } | { type: 'none' };
  minAccess?: ShareLevel;
  rewrite?: boolean;
  /** Also proxy WebSocket upgrades (single-page admin UIs that talk over WebSockets). Default false. */
  websocket?: boolean;
}

export interface GameWorkshop {
  appId: number;
  install: 'steamcmd' | 'config-list';
  dir?: string;
}

/** Game definition v1 (SPEC.md "SteamCMD games"). */
export interface GameDefinition {
  schema: 1;
  id: string;
  name: string;
  description?: string;
  icon?: string | null;
  steam: GameSteamSource;
  resources?: GameResources;
  ports: GamePort[];
  variables?: GameVariable[];
  launch: GameLaunch;
  files?: GameFile[];
  stop?: GameStop;
  console?: { stdin: boolean };
  ready?: { logRegex: string } | null;
  players?: { joinRegex?: string; leaveRegex?: string } | null;
  query?: { a2s?: { portId: string } } | null;
  workshop?: GameWorkshop | null;
  webui?: GameWebUi[];
  scripts?: { postInstall?: string; preStart?: string };
}

/**
 * GET /games item: the definition without `scripts`, plus list metadata. Only the summary fields are
 * guaranteed by the contract; the rest is used when the API includes it.
 */
export type GameSummary = Partial<Omit<GameDefinition, 'scripts' | 'id' | 'name'>> & {
  id: string;
  name: string;
  builtin: boolean;
  hasWorkshop?: boolean;
  hasWebui?: boolean;
  ownerId?: string | null;
  ownerName?: string | null;
  updatedAt?: string;
  /** Game key, `steam:<id>`. */
  key?: string;
  disabled?: boolean;
  blockStart?: boolean;
};

/** One problem reported by POST /games/validate or invalid_steam_config. */
export interface ValidationIssue {
  path: string;
  message: string;
}

/** Server JSON `steamGame`. `webui` is already filtered by the viewer's access; `url` is the entry URL to open. */
export interface ServerSteamGame {
  id: string;
  name: string;
  icon?: string | null;
  builtin?: boolean;
  hasWorkshop?: boolean;
  hasWebui?: boolean;
  hasConsole?: boolean;
  hasPlayers?: boolean;
  ports?: Array<{ id: string; label?: string; protocol: PortProtocol; hostPort: number | null; main: boolean }>;
  webui?: Array<Partial<GameWebUi> & { id: string; label?: string; url?: string }>;
}

export interface WorkshopItem {
  id: string;
  /** Workshop app id of the item; `matchesGame` is set when `?gameId=` was passed. */
  appId?: number | null;
  matchesGame?: boolean;
  title: string;
  summary?: string | null;
  previewUrl?: string | null;
  author?: string | null;
  subscribers?: number | null;
  sizeBytes?: number | null;
  updatedAt?: string | null;
}

export interface WorkshopSearchResult {
  items: WorkshopItem[];
  total: number;
}

/* ------------------------------------------------------------ v0.3.2: game access, disabled games, processes */

/** "minecraft", "terraria" or "steam:<definitionId>". */
export type GameKey = string;
export type GameKind = 'minecraft' | 'terraria' | 'steam';

/** GET /users/:id/games */
export interface UserGamesResponse {
  /** null for admins (unrestricted). */
  games: GameKey[] | null;
  unrestricted?: boolean;
}

/** GET /admin/games item. */
export interface AdminGame {
  key: GameKey;
  name: string;
  builtin: boolean;
  kind: GameKind;
  disabled: boolean;
  blockStart: boolean;
  servers: number;
  running: number;
}

/** PUT /admin/games/:key/disabled response. */
export interface GameDisabledResult {
  key: GameKey;
  disabled: boolean;
  blockStart: boolean;
  /** Servers stopped by this call. */
  stopped: number;
}

/** One process inside a game container (GET /admin/processes). */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memMb: number;
  memPercent: number;
  state: string;
  elapsedSec: number;
  cpuTimeSec: number;
  command: string;
}

export interface ProcessServer {
  serverId: string;
  name: string;
  game: Game;
  gameKey: GameKey;
  status: ServerStatus;
  containerId: string | null;
  /** Container CPU as a percent of the server's own CPU allotment (like Stats.cpuPercent). */
  cpuPercent: number | null;
  /** The server's CPU allotment in cores. */
  cpuLimit?: number | null;
  memUsedMb: number | null;
  memLimitMb: number | null;
  processes: ProcessInfo[];
}

export interface ProcessesResponse {
  takenAt: string;
  intervalMs: number;
  host: { cpuCount: number; memTotalMb: number };
  servers: ProcessServer[];
  dockerAvailable: boolean;
}

/** GET /docs item. */
export interface DocInfo {
  id: string;
  title: string;
  filename: string;
  url: string;
  contentType: string;
}
