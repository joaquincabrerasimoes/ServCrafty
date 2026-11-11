import fsp from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { query, queryOne, tx } from '../db/pool.js';
import { randomPassword } from '../lib/crypto.js';
import { badRequest, errorMessage, notFound } from '../lib/errors.js';
import { dropBluemapData } from './bluemap.js';
import { mainPort, type GameDefinition } from '../lib/gameDefinition.js';
import { gameLabel, gameOf, GAMES, isSteamType, isTerrariaType, serverGameKey, type Game } from '../lib/games.js';
import { assertCanCreateServer } from './gameAccess.js';
import { minecraftConfigSchema, normalizeMinecraftConfig } from '../lib/minecraftConfig.js';
import {
  mergeSteamConfig,
  normalizeSteamConfig,
  portGroups,
  publishedPorts,
  steamInputSchema,
  steamPatchSchema,
  invalidSteamConfig,
  generatedVarKeys,
  type SteamConfig,
  type SteamInput,
} from '../lib/steamPlan.js';
import { mergeTerrariaConfig, normalizeTerrariaConfig, type TerrariaConfig } from '../lib/terrariaConfig.js';
import { serverTypeSchema, type ServerType } from '../lib/validation.js';
import { serverDir, steamPlanFile } from './docker.js';
import { getDefinition, requireDefinition } from './gameDefinitions.js';
import { refreshLanAnnouncer } from './lanAnnouncer.js';
import { allocatePortGroups, allocatePorts } from './portAlloc.js';
import { ensureSteamPorts } from './steamPorts.js';
import * as runtime from './runtime.js';
import type { ModpackRef, ServerRow, UserRow } from './types.js';
import { assertHostCap } from './globalLimits.js';
import { assertQuota, getUser } from './users.js';

export const modpackSchema = z
  .object({
    source: z.enum(['curseforge', 'modrinth', 'file']),
    projectId: z.union([z.string(), z.number()]).optional(),
    fileId: z.union([z.string(), z.number()]).optional(),
    versionId: z.string().optional(),
    slug: z.string().optional(),
    name: z.string().optional(),
    versionName: z.string().optional(),
    localFile: z.string().optional(),
    loader: z.string().optional(),
  })
  .strict();

const envSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid env name'), z.string().max(8192));

/** Reusable server configuration (templates, clone, import). */
export const serverConfigSchema = z.object({
  type: serverTypeSchema,
  mcVersion: z.string().min(1).max(64).default('LATEST'),
  loaderVersion: z.string().max(128).nullable().optional(),
  modpack: modpackSchema.nullable().optional(),
  javaArgs: z.string().max(4096).nullable().optional(),
  memoryMb: z.number().int().min(512).max(1_048_576),
  cpu: z.number().min(0.1).max(256),
  diskMb: z.number().int().min(256).nullable().optional(),
  env: envSchema.optional(),
  autoRestart: z.boolean().optional(),
  /** Announce on the LAN (Minecraft Java only). */
  lanAnnounce: z.boolean().optional(),
  /** Initial Minecraft configuration, applied on the server's first start. */
  minecraft: minecraftConfigSchema.nullable().optional(),
  /**
   * Terraria configuration (Terraria types only). Validated by lib/terrariaConfig.ts in the
   * service so errors carry the `invalid_terraria_config` code.
   */
  terraria: z.record(z.unknown()).nullable().optional(),
  /**
   * SteamCMD configuration `{gameId, vars, updateOnStart?, workshop?}` (type STEAMCMD only). Validated
   * against the game definition in the service so errors carry `invalid_steam_config`.
   */
  steam: z.record(z.unknown()).nullable().optional(),
});
export type ServerConfig = z.infer<typeof serverConfigSchema>;

export const createServerSchema = serverConfigSchema.extend({
  name: z.string().trim().min(1).max(64),
  port: z.number().int().min(1).max(65535).optional(),
  /** Required (true) for Minecraft and Terraria servers; SteamCMD servers do not need it. */
  eula: z.literal(true, { errorMap: () => ({ message: 'You must accept the Minecraft EULA' }) }).optional(),
  ownerId: z.string().uuid().optional(),
});
export type CreateServerInput = z.infer<typeof createServerSchema>;

export const updateServerSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    mcVersion: z.string().min(1).max(64),
    loaderVersion: z.string().max(128).nullable(),
    modpack: modpackSchema.nullable(),
    javaArgs: z.string().max(4096).nullable(),
    memoryMb: z.number().int().min(512).max(1_048_576),
    cpu: z.number().min(0.1).max(256),
    diskMb: z.number().int().min(256).nullable(),
    port: z.number().int().min(1).max(65535),
    env: envSchema,
    autoRestart: z.boolean(),
    autoStart: z.boolean(),
    lanAnnounce: z.boolean(),
    type: serverTypeSchema,
    /** Merged over the current Terraria config (null fields are removed; null resets to defaults). */
    terraria: z.record(z.unknown()).nullable(),
    /** SteamCMD: `{vars?, updateOnStart?}` merged over the current config (a var set to null returns to its default). */
    steam: z.record(z.unknown()),
  })
  .partial();
export type UpdateServerInput = z.infer<typeof updateServerSchema>;

/** Fields of a server that only make sense for one game. */
interface GameFields {
  mcVersion?: string | null;
  loaderVersion?: string | null;
  modpack?: unknown;
  javaArgs?: string | null;
  lanAnnounce?: boolean | null;
  minecraft?: unknown;
  terraria?: unknown;
  steam?: unknown;
  memoryMb?: number;
}

/**
 * Reject fields that belong to another game (400 `unsupported_game`) and enforce the game's
 * memory minimum. Pure; exported for tests. `memoryMinMb` overrides the game default (SteamCMD
 * servers use their definition's minimum).
 */
export function assertGameFields(type: ServerType, f: GameFields, memoryMinMb?: number): void {
  const game = gameOf(type);
  const min = memoryMinMb ?? GAMES[game].memoryMinMb;
  if (f.memoryMb !== undefined && f.memoryMb < min) throw badRequest(`memoryMb must be at least ${min}`, 'validation_error');
  const reject = (field: string) => {
    throw badRequest(`"${field}" is not supported for ${gameLabel(game)} servers`, 'unsupported_game');
  };
  const present = (v: unknown) => v !== undefined && v !== null;
  if (game === 'minecraft') {
    if (present(f.terraria)) reject('terraria');
    if (present(f.steam)) reject('steam');
    return;
  }
  if (game === 'terraria' && present(f.steam)) reject('steam');
  if (game === 'steam' && present(f.terraria)) reject('terraria');
  if (present(f.minecraft)) reject('minecraft');
  if (present(f.modpack)) reject('modpack');
  if (f.lanAnnounce) reject('lanAnnounce');
  if (f.javaArgs !== undefined && f.javaArgs !== null && f.javaArgs !== '') reject('javaArgs');
  if (f.loaderVersion !== undefined && f.loaderVersion !== null && f.loaderVersion !== '') reject('loaderVersion');
  if (f.mcVersion !== undefined && f.mcVersion !== null && f.mcVersion.toUpperCase() !== 'LATEST') reject('mcVersion');
}

async function pickPort(client: pg.PoolClient, wanted: number | undefined, excludeServerId?: string): Promise<number> {
  const [p] = await allocatePorts(client, { count: 1, wanted, excludeServerId });
  return p!;
}

/** Resolve and validate the `steam` input of a new server against its definition. */
function steamForCreate(input: { steam?: Record<string, unknown> | null }): { def: GameDefinition; cfg: SteamConfig } {
  if (!input.steam) throw invalidSteamConfig([{ path: 'steam', message: 'is required for SteamCMD servers' }]);
  const shape = steamInputSchema.safeParse(input.steam);
  if (!shape.success) throw invalidSteamConfig(shape.error.issues.map((i) => ({ path: ['steam', ...i.path].join('.'), message: i.message })));
  const def = requireDefinition(shape.data.gameId);
  return { def, cfg: normalizeSteamConfig(def, input.steam as SteamInput) };
}

/**
 * Host ports for a SteamCMD server: main (wanted or first free) + one per other published port.
 * Returns the main port and `{portId: hostPort}` for the rest.
 */
async function allocateSteamPorts(client: pg.PoolClient, def: GameDefinition): Promise<{ port: number; extra: Record<string, number> }> {
  const main = mainPort(def);
  const got = await allocatePortGroups(client, { groups: portGroups(def), exhaustedCode: 'no_free_ports' });
  const extra: Record<string, number> = {};
  for (const p of publishedPorts(def)) if (p !== main) extra[p.id] = got[p.id]!;
  return { port: got[main.id]!, extra };
}

/**
 * Create a server row (quota + port allocation in a single transaction) and its data
 * directory. `seed` may populate the directory before the server is first started.
 */
export async function createServer(
  actor: UserRow,
  input: Omit<CreateServerInput, 'eula'> & { eula?: boolean },
  seed?: (dir: string, server: ServerRow) => Promise<void>,
): Promise<ServerRow> {
  let owner = actor;
  if (input.ownerId && input.ownerId !== actor.id) {
    if (actor.role !== 'admin') throw badRequest('Only admins can create servers for other users', 'forbidden_owner');
    owner = await getUser(input.ownerId);
  }
  const game: Game = gameOf(input.type);
  // Game access (allowlist of the creating user) and disabled games, before anything else is validated.
  // Every creation path (POST /servers, clone, template instantiate, imports) goes through here.
  const gameId = (input.steam as { gameId?: unknown } | null | undefined)?.gameId;
  if (game !== 'steam' || (typeof gameId === 'string' && gameId)) {
    await assertCanCreateServer(actor, serverGameKey({ type: input.type, steam: game === 'steam' ? { gameId } : null }));
  }
  // (An absent steam.gameId is rejected by steamForCreate as invalid_steam_config.)
  const steam = game === 'steam' ? steamForCreate(input) : null;
  if (steam && input.port !== undefined) {
    throw badRequest('SteamCMD servers get their ports from the pool; "port" cannot be chosen', 'port_not_supported');
  }
  assertGameFields(input.type, input, steam?.def.resources.memoryMinMb);
  const terraria: TerrariaConfig | null = isTerrariaType(input.type) ? normalizeTerrariaConfig(input.type, input.terraria ?? {}) : null;
  if ((input.type === 'CURSEFORGE' || input.type === 'MODRINTH') && !input.modpack) {
    throw badRequest('A modpack is required for this server type', 'modpack_required');
  }
  const lanAnnounce = input.lanAnnounce ?? false;
  if (lanAnnounce && input.type === 'BEDROCK') {
    throw badRequest('LAN discovery is only available for Minecraft Java servers', 'lan_announce_unsupported');
  }
  const minecraft = input.minecraft ? normalizeMinecraftConfig(input.type, input.minecraft) : null;
  const server = await tx(async (client) => {
    await assertQuota(owner, { memoryMb: input.memoryMb, cpu: input.cpu, diskMb: input.diskMb ?? null }, undefined, client);
    await assertHostCap({ memoryMb: input.memoryMb, cpu: input.cpu, diskMb: input.diskMb ?? null }, { client });
    let port: number;
    let extraPorts: Record<string, number> = {};
    if (steam) ({ port, extra: extraPorts } = await allocateSteamPorts(client, steam.def));
    else port = await pickPort(client, input.port);
    const r = await client.query<ServerRow>(
      `INSERT INTO servers (owner_id, name, type, mc_version, loader_version, modpack, java_args, memory_mb, cpu,
                            disk_mb, port, env, auto_restart, rcon_password, minecraft, lan_announce, game, terraria,
                            steam, extra_ports)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [
        owner.id,
        input.name,
        input.type,
        game === 'steam' ? 'LATEST' : input.mcVersion || 'LATEST',
        input.loaderVersion ?? null,
        input.modpack ? JSON.stringify(input.modpack) : null,
        input.javaArgs ?? null,
        input.memoryMb,
        input.cpu,
        input.diskMb ?? null,
        port,
        JSON.stringify(input.env ?? {}),
        input.autoRestart ?? true,
        randomPassword(),
        minecraft && Object.keys(minecraft).length ? JSON.stringify(minecraft) : null,
        game === 'minecraft' ? lanAnnounce : false,
        game,
        terraria ? JSON.stringify(terraria) : null,
        steam ? JSON.stringify(steam.cfg) : null,
        JSON.stringify(extraPorts),
      ],
    );
    return r.rows[0]!;
  });
  const dir = serverDir(server.id);
  try {
    await fsp.mkdir(dir, { recursive: true });
    if (game === 'minecraft') await fsp.writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
    if (seed) await seed(dir, server);
  } catch (err) {
    await query('DELETE FROM servers WHERE id = $1', [server.id]);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  refreshLanAnnouncer();
  return server;
}

export async function updateServer(actor: UserRow, server: ServerRow, patch: UpdateServerInput): Promise<ServerRow> {
  const nextType = patch.type ?? server.type;
  const game = gameOf(server.type);
  if (gameOf(nextType) !== game) throw badRequest('A server cannot be switched to another game', 'game_change_unsupported');
  let steam: SteamConfig | null = null;
  let steamDef: GameDefinition | null = null;
  if (game === 'steam') {
    if (!server.steam) throw badRequest('This server has no SteamCMD configuration', 'invalid_steam_config');
    steamDef = requireDefinition(server.steam.gameId);
    if (patch.steam !== undefined) {
      const sp = steamPatchSchema.safeParse(patch.steam);
      if (!sp.success) throw invalidSteamConfig(sp.error.issues.map((i) => ({ path: ['steam', ...i.path].join('.'), message: i.message })));
      steam = mergeSteamConfig(steamDef, server.steam, sp.data);
    } else steam = server.steam;
  }
  assertGameFields(nextType, { ...patch, steam: game === 'steam' ? undefined : patch.steam }, steamDef?.resources.memoryMinMb);
  if (game === 'steam' && patch.port !== undefined && patch.port !== server.port) {
    throw badRequest('SteamCMD servers get their ports from the pool; "port" cannot be changed', 'port_not_supported');
  }
  let terraria: TerrariaConfig | null = null;
  if (isTerrariaType(nextType)) {
    terraria =
      patch.terraria !== undefined
        ? mergeTerrariaConfig(nextType, server.terraria, patch.terraria)
        : normalizeTerrariaConfig(nextType, server.terraria ?? {});
  }
  const updated = await tx(async (client) => {
    const owner = await getUser(server.owner_id);
    const memoryMb = patch.memoryMb ?? server.memory_mb;
    const cpu = patch.cpu ?? server.cpu;
    const diskMb = patch.diskMb !== undefined ? patch.diskMb : server.disk_mb;
    if (patch.memoryMb !== undefined || patch.cpu !== undefined || patch.diskMb !== undefined) {
      // Admins may exceed a user's quota when editing on their behalf.
      if (actor.role !== 'admin') await assertQuota(owner, { memoryMb, cpu, diskMb }, server.id, client);
      // The host's own capacity binds everyone, admins included.
      await assertHostCap(
        { memoryMb, cpu, diskMb },
        { client, excludeServerId: server.id, current: { memoryMb: server.memory_mb, cpu: server.cpu, diskMb: server.disk_mb } },
      );
    }
    let port = server.port;
    if (patch.port !== undefined && patch.port !== server.port) {
      // A SteamCMD server's own extra ports stay reserved for it.
      const [p] = await allocatePorts(client, {
        count: 1,
        wanted: patch.port,
        excludeServerId: server.id,
        reserved: Object.values(server.extra_ports ?? {}),
      });
      port = p!;
    }
    const type = patch.type ?? server.type;
    const modpack: ModpackRef | null = patch.modpack !== undefined ? patch.modpack : server.modpack;
    if ((type === 'CURSEFORGE' || type === 'MODRINTH') && !modpack) {
      throw badRequest('A modpack is required for this server type', 'modpack_required');
    }
    if (patch.lanAnnounce && type === 'BEDROCK') {
      throw badRequest('LAN discovery is only available for Minecraft Java servers', 'lan_announce_unsupported');
    }
    const lanAnnounce = type === 'BEDROCK' ? false : (patch.lanAnnounce ?? server.lan_announce);
    if (patch.autoStart !== undefined) await client.query('UPDATE servers SET auto_start=$2 WHERE id=$1', [server.id, patch.autoStart]);
    const r = await client.query<ServerRow>(
      `UPDATE servers SET name=$2, type=$3, mc_version=$4, loader_version=$5, modpack=$6, java_args=$7, memory_mb=$8,
         cpu=$9, disk_mb=$10, port=$11, env=$12, auto_restart=$13, lan_announce=$14, game=$15, terraria=$16, steam=$17
       WHERE id=$1 RETURNING *`,
      [
        server.id,
        patch.name ?? server.name,
        type,
        game === 'steam' ? 'LATEST' : (patch.mcVersion ?? server.mc_version),
        patch.loaderVersion !== undefined ? patch.loaderVersion : server.loader_version,
        modpack ? JSON.stringify(modpack) : null,
        patch.javaArgs !== undefined ? patch.javaArgs : server.java_args,
        memoryMb,
        cpu,
        diskMb,
        port,
        JSON.stringify(patch.env ?? server.env ?? {}),
        patch.autoRestart ?? server.auto_restart,
        game === 'minecraft' ? lanAnnounce : false,
        game,
        terraria ? JSON.stringify(terraria) : null,
        steam ? JSON.stringify(steam) : null,
      ],
    );
    return r.rows[0]!;
  });
  refreshLanAnnouncer();
  return game === 'steam' ? ensureSteamPorts(updated, { running: runtime.isRunning(updated.id) }) : updated;
}

/**
 * Atomically change a SteamCMD server's config (Workshop list, validateNext...). `fn` receives the
 * current config and returns the new one; runs under a row lock.
 */
export async function updateSteamConfig(serverId: string, fn: (cur: SteamConfig) => SteamConfig): Promise<ServerRow> {
  return tx(async (client) => {
    const cur = await client.query<ServerRow>('SELECT * FROM servers WHERE id = $1 FOR UPDATE', [serverId]);
    const row = cur.rows[0];
    if (!row) throw notFound('Server not found', 'server_not_found');
    if (!isSteamType(row.type) || !row.steam) throw badRequest('Not a SteamCMD server', 'unsupported_game');
    const next = fn({ ...row.steam, workshop: row.steam.workshop ?? [] });
    const r = await client.query<ServerRow>('UPDATE servers SET steam = $2 WHERE id = $1 RETURNING *', [serverId, JSON.stringify(next)]);
    return r.rows[0]!;
  });
}

export async function deleteServer(server: ServerRow): Promise<void> {
  await runtime.destroy(server);
  // BlueMap: the server's schema and role go with it, freeing the space in the shared database.
  // Best effort: a server must stay deletable even if the drop fails (the schema is then named in the log).
  if (server.bluemap) {
    await dropBluemapData(server.bluemap, server.id).catch((err: unknown) =>
      console.error(`[servcrafty] could not drop BlueMap schema ${server.bluemap?.schema} of deleted server ${server.id}: ${errorMessage(err)}`),
    );
  }
  await query('DELETE FROM servers WHERE id = $1', [server.id]);
  await fsp.rm(serverDir(server.id), { recursive: true, force: true }).catch(() => undefined);
  await fsp.rm(path.join(config().backupsDir, server.id), { recursive: true, force: true }).catch(() => undefined);
  await fsp.rm(steamPlanFile(server.id), { force: true }).catch(() => undefined);
  refreshLanAnnouncer();
}

function withoutKeys<T>(o: Record<string, T>, keys: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !keys.has(k)));
}

export function configOf(server: ServerRow): ServerConfig {
  return {
    type: server.type,
    mcVersion: server.mc_version,
    loaderVersion: server.loader_version,
    modpack: server.modpack,
    javaArgs: server.java_args,
    memoryMb: server.memory_mb,
    cpu: server.cpu,
    diskMb: server.disk_mb,
    env: server.env ?? {},
    autoRestart: server.auto_restart,
    lanAnnounce: server.lan_announce,
    minecraft: server.minecraft ?? null,
    ...(server.terraria ? { terraria: { ...server.terraria } } : {}),
    ...(server.steam
      ? {
          steam: {
            gameId: server.steam.gameId,
            // Generated secrets are never copied: a clone or template instantiation generates fresh ones.
            vars: withoutKeys(server.steam.vars, generatedVarKeys(getDefinition(server.steam.gameId))),
            updateOnStart: server.steam.updateOnStart,
            workshop: (server.steam.workshop ?? []).map((w) => ({ ...w })),
          },
        }
      : {}),
  };
}

/** Set fields of the Terraria config directly (world import); validated like a PATCH. */
export async function setTerrariaFields(server: ServerRow, fields: Partial<TerrariaConfig>): Promise<ServerRow> {
  if (!isTerrariaType(server.type)) throw badRequest('Not a Terraria server', 'unsupported_game');
  const cfg = mergeTerrariaConfig(server.type, server.terraria, fields);
  const row = await queryOne<ServerRow>('UPDATE servers SET terraria = $2 WHERE id = $1 RETURNING *', [server.id, JSON.stringify(cfg)]);
  if (!row) throw badRequest('Server not found', 'server_not_found');
  return row;
}

export async function getServerRow(id: string): Promise<ServerRow | null> {
  return queryOne<ServerRow>('SELECT * FROM servers WHERE id = $1', [id]);
}
