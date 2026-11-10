import type { ServerType } from '../lib/validation.js';
import type { MinecraftConfig } from '../lib/minecraftConfig.js';
import { gameOf, type Game } from '../lib/games.js';
import type { TerrariaConfig } from '../lib/terrariaConfig.js';
import { publicSteamConfig, type SteamConfig } from '../lib/steamPlan.js';
import { mainPort } from '../lib/gameDefinition.js';
import { getDefinition, getEntry } from './gameDefinitions.js';

export type Role = 'admin' | 'user';
export type ShareLevel = 'viewer' | 'operator' | 'manager';
export type Access = 'owner' | 'admin' | ShareLevel;
export type ServerStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'crashed' | 'installing';

export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  password_hash: string;
  role: Role;
  locale: string;
  theme: string;
  disabled: boolean;
  max_servers: number | null;
  max_ram_mb: number | null;
  max_cpu: number | null;
  max_disk_mb: number | null;
  totp_secret_enc: string | null;
  totp_enabled: boolean;
  /** May create/edit game definitions (admins always can). */
  can_author_games: boolean;
  created_at: Date;
}

export interface Quotas {
  maxServers: number | null;
  maxRamMb: number | null;
  maxCpu: number | null;
  maxDiskMb: number | null;
}

export interface PublicUser {
  id: string;
  username: string;
  email: string | null;
  role: Role;
  locale: string;
  theme: string;
  disabled: boolean;
  quotas: Quotas;
  totpEnabled: boolean;
  canAuthorGames: boolean;
  createdAt: string;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    locale: u.locale,
    theme: u.theme,
    disabled: u.disabled,
    quotas: {
      maxServers: u.max_servers,
      maxRamMb: u.max_ram_mb,
      maxCpu: u.max_cpu,
      maxDiskMb: u.max_disk_mb,
    },
    totpEnabled: u.totp_enabled,
    canAuthorGames: u.can_author_games === true,
    createdAt: u.created_at.toISOString(),
  };
}

export interface ModpackRef {
  source: 'curseforge' | 'modrinth' | 'file';
  projectId?: string | number;
  fileId?: string | number;
  versionId?: string;
  slug?: string;
  name?: string;
  /** Human-readable pack version (e.g. "3.2.18"), when known. */
  versionName?: string;
  /** For imported packs stored inside the server dir (relative path). */
  localFile?: string;
  /** Mod loader of the pack, when known ("fabric", "forge", "neoforge", "quilt"). */
  loader?: string;
}

export interface ServerRow {
  id: string;
  owner_id: string;
  name: string;
  type: ServerType;
  /** Game the server runs; always derived from `type` (lib/games.ts `gameOf`). */
  game: Game;
  mc_version: string;
  loader_version: string | null;
  modpack: ModpackRef | null;
  java_args: string | null;
  memory_mb: number;
  cpu: number;
  disk_mb: number | null;
  port: number;
  env: Record<string, string>;
  /** Initial Minecraft configuration (see lib/minecraftConfig.ts); applied on first start. */
  minecraft: MinecraftConfig | null;
  /** Terraria configuration (see lib/terrariaConfig.ts); null for Minecraft servers. */
  terraria: TerrariaConfig | null;
  /** SteamCMD configuration (see lib/steamPlan.ts); null for other games. */
  steam: SteamConfig | null;
  /** Host ports of the published non-main definition ports, by port id (SteamCMD only; `{}` otherwise). */
  extra_ports: Record<string, number> | null;
  container_id: string | null;
  status: ServerStatus;
  auto_restart: boolean;
  auto_start: boolean;
  /** Set when a user stops the server; cleared when it starts. Host shutdowns do not set it. */
  stopped_by_user: boolean;
  /** Announce this (Java) server on the LAN while it runs. */
  lan_announce: boolean;
  rcon_password: string;
  created_at: Date;
}

export interface PublicServer {
  id: string;
  ownerId: string;
  ownerName: string | null;
  name: string;
  type: ServerType;
  game: Game;
  mcVersion: string;
  loaderVersion: string | null;
  modpack: ModpackRef | null;
  javaArgs: string | null;
  memoryMb: number;
  cpu: number;
  diskMb: number | null;
  port: number;
  env: Record<string, string>;
  minecraft: MinecraftConfig | null;
  terraria: TerrariaConfig | null;
  /** SteamCMD config; secret (password) variables are blanked below manager access. */
  steam: Omit<SteamConfig, 'workshopRefresh'> | null;
  extraPorts: Record<string, number>;
  /** What the server's game definition offers (SteamCMD only; null for other games or a missing definition). */
  steamGame: SteamGameInfo | null;
  status: ServerStatus;
  autoRestart: boolean;
  autoStart: boolean;
  lanAnnounce: boolean;
  createdAt: string;
  access: Access;
}

export interface SteamGameInfo {
  id: string;
  name: string;
  icon: string | null;
  builtin: boolean;
  hasWorkshop: boolean;
  hasWebui: boolean;
  hasConsole: boolean;
  hasPlayers: boolean;
  /** Ports with their host port (null = not published, only reachable by the panel). */
  ports: { id: string; label: string; protocol: 'udp' | 'tcp' | 'both'; hostPort: number | null; main: boolean; offset: { from: string; by: number } | null }[];
  /** Web UIs the viewer may open; `url` is the iframe/open-in-new-tab URL (it redirects into the proxy session). */
  webui: { id: string; label: string; minAccess: ShareLevel; url: string }[];
}

const ACCESS_RANK: Record<Access, number> = { viewer: 1, operator: 2, manager: 3, owner: 4, admin: 4 };

function steamGameInfo(s: ServerRow, access: Access): SteamGameInfo | null {
  if (!s.steam) return null;
  const entry = getEntry(s.steam.gameId);
  if (!entry) return null;
  const d = entry.definition;
  const main = mainPort(d);
  return {
    id: d.id,
    name: d.name,
    icon: d.icon,
    builtin: entry.builtin,
    hasWorkshop: !!d.workshop,
    hasWebui: d.webui.length > 0,
    hasConsole: d.console.stdin,
    hasPlayers: !!(d.players || d.query?.a2s),
    ports: d.ports.map((p) => ({
      id: p.id,
      label: p.label,
      protocol: p.protocol,
      hostPort: p === main ? s.port : p.publish ? (s.extra_ports?.[p.id] ?? null) : null,
      main: p === main,
      offset: p.offset ?? null,
    })),
    webui: d.webui
      .filter((w) => ACCESS_RANK[access] >= ACCESS_RANK[w.minAccess])
      .map((w) => ({ id: w.id, label: w.label, minAccess: w.minAccess, url: `/api/servers/${s.id}/webui/${w.id}${w.path}` })),
  };
}

/** Manager, owner and admin see secret values (passwords) of a server's config. */
export function canSeeSecrets(access: Access): boolean {
  return access === 'manager' || access === 'owner' || access === 'admin';
}

export function toPublicServer(s: ServerRow, access: Access, ownerName: string | null = null): PublicServer {
  return {
    id: s.id,
    ownerId: s.owner_id,
    ownerName,
    name: s.name,
    type: s.type,
    game: gameOf(s.type),
    mcVersion: s.mc_version,
    loaderVersion: s.loader_version,
    modpack: s.modpack,
    javaArgs: s.java_args,
    memoryMb: s.memory_mb,
    cpu: s.cpu,
    diskMb: s.disk_mb,
    port: s.port,
    env: s.env ?? {},
    minecraft: s.minecraft ?? null,
    terraria: s.terraria ?? null,
    steam: s.steam ? publicSteamConfig(s.steam, getDefinition(s.steam.gameId), canSeeSecrets(access)) : null,
    extraPorts: { ...(s.extra_ports ?? {}) },
    steamGame: steamGameInfo(s, access),
    status: s.status,
    autoRestart: s.auto_restart,
    autoStart: s.auto_start,
    lanAnnounce: s.lan_announce,
    createdAt: s.created_at.toISOString(),
    access,
  };
}

export interface Stats {
  status: ServerStatus;
  uptimeSec: number;
  memory: { usedMb: number; limitMb: number };
  cpuPercent: number;
  tps: number | null;
  mspt: { avg: number | null; p95: number | null };
  players: { online: number; max: number; list: { name: string }[] };
  motd: string | null;
  /** Current map (SteamCMD games queried over A2S). */
  map?: string | null;
  /** SteamCMD install/update progress while `status === 'installing'`. */
  install?: { phase: string; progress: number | null } | null;
  /** Minecraft version (never a mod or pack version). */
  version: string | null;
  /** Modpack name / version label, for modpack servers. */
  packName?: string | null;
  packVersion?: string | null;
  source: 'agent' | 'rcon' | 'docker' | 'a2s';
  diskMb: number;
  agent?: null;
}

/** Which server types run Bukkit-style plugins vs. loader mods. */
export function contentDirFor(type: ServerType): 'plugins' | 'mods' | null {
  switch (type) {
    case 'PAPER':
    case 'PURPUR':
    case 'FOLIA':
    case 'SPIGOT':
    case 'BUKKIT':
      return 'plugins';
    case 'FABRIC':
    case 'QUILT':
    case 'FORGE':
    case 'NEOFORGE':
    case 'CURSEFORGE':
    case 'MODRINTH':
      return 'mods';
    default:
      return null;
  }
}

/** Loader name as used by Modrinth for a server type (null = vanilla/bedrock). */
export function modrinthLoaderFor(type: ServerType): string | null {
  switch (type) {
    case 'PAPER':
      return 'paper';
    case 'PURPUR':
      return 'purpur';
    case 'FOLIA':
      return 'folia';
    case 'SPIGOT':
      return 'spigot';
    case 'BUKKIT':
      return 'bukkit';
    case 'FABRIC':
      return 'fabric';
    case 'QUILT':
      return 'quilt';
    case 'FORGE':
      return 'forge';
    case 'NEOFORGE':
      return 'neoforge';
    default:
      return null;
  }
}
