import type { ServerType } from '../lib/validation.js';

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
  mc_version: string;
  loader_version: string | null;
  modpack: ModpackRef | null;
  java_args: string | null;
  memory_mb: number;
  cpu: number;
  disk_mb: number | null;
  port: number;
  env: Record<string, string>;
  container_id: string | null;
  status: ServerStatus;
  auto_restart: boolean;
  rcon_password: string;
  created_at: Date;
}

export interface PublicServer {
  id: string;
  ownerId: string;
  ownerName: string | null;
  name: string;
  type: ServerType;
  mcVersion: string;
  loaderVersion: string | null;
  modpack: ModpackRef | null;
  javaArgs: string | null;
  memoryMb: number;
  cpu: number;
  diskMb: number | null;
  port: number;
  env: Record<string, string>;
  status: ServerStatus;
  autoRestart: boolean;
  createdAt: string;
  access: Access;
}

export function toPublicServer(s: ServerRow, access: Access, ownerName: string | null = null): PublicServer {
  return {
    id: s.id,
    ownerId: s.owner_id,
    ownerName,
    name: s.name,
    type: s.type,
    mcVersion: s.mc_version,
    loaderVersion: s.loader_version,
    modpack: s.modpack,
    javaArgs: s.java_args,
    memoryMb: s.memory_mb,
    cpu: s.cpu,
    diskMb: s.disk_mb,
    port: s.port,
    env: s.env ?? {},
    status: s.status,
    autoRestart: s.auto_restart,
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
  /** Minecraft version (never a mod or pack version). */
  version: string | null;
  /** Modpack name / version label, for modpack servers. */
  packName?: string | null;
  packVersion?: string | null;
  source: 'agent' | 'rcon' | 'docker';
  diskMb: number;
  agent?: null;
}

/** Which server types run Bukkit-style plugins vs. loader mods. */
export function contentDirFor(type: ServerType): 'plugins' | 'mods' | null {
  switch (type) {
    case 'PAPER':
    case 'PURPUR':
    case 'FOLIA':
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
