import fsp from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { query, queryOne, tx } from '../db/pool.js';
import { randomPassword } from '../lib/crypto.js';
import { badRequest, conflict } from '../lib/errors.js';
import { minecraftConfigSchema, normalizeMinecraftConfig } from '../lib/minecraftConfig.js';
import { parsePortPool } from '../lib/ports.js';
import { serverTypeSchema } from '../lib/validation.js';
import { serverDir } from './docker.js';
import * as runtime from './runtime.js';
import { getPortPoolSpec } from './settings.js';
import type { ModpackRef, ServerRow, UserRow } from './types.js';
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
  /** Initial Minecraft configuration, applied on the server's first start. */
  minecraft: minecraftConfigSchema.nullable().optional(),
});
export type ServerConfig = z.infer<typeof serverConfigSchema>;

export const createServerSchema = serverConfigSchema.extend({
  name: z.string().trim().min(1).max(64),
  port: z.number().int().min(1).max(65535).optional(),
  eula: z.literal(true, { errorMap: () => ({ message: 'You must accept the Minecraft EULA' }) }),
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
    type: serverTypeSchema,
  })
  .partial();
export type UpdateServerInput = z.infer<typeof updateServerSchema>;

const PORT_LOCK = 727_002;

async function pickPort(client: pg.PoolClient, wanted: number | undefined, excludeServerId?: string): Promise<number> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [PORT_LOCK]);
  const pool = parsePortPool(await getPortPoolSpec());
  const used = new Set(
    (
      await client.query<{ port: number }>('SELECT port FROM servers WHERE id::text <> $1', [excludeServerId ?? ''])
    ).rows.map((r) => r.port),
  );
  if (wanted !== undefined) {
    if (!pool.includes(wanted)) throw badRequest(`Port ${wanted} is not in the port pool`, 'port_not_in_pool');
    if (used.has(wanted)) throw conflict(`Port ${wanted} is already in use`, 'port_in_use');
    return wanted;
  }
  const free = pool.find((p) => !used.has(p));
  if (free === undefined) throw conflict('No free ports left in the pool', 'port_pool_exhausted');
  return free;
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
  if ((input.type === 'CURSEFORGE' || input.type === 'MODRINTH') && !input.modpack) {
    throw badRequest('A modpack is required for this server type', 'modpack_required');
  }
  const minecraft = input.minecraft ? normalizeMinecraftConfig(input.type, input.minecraft) : null;
  const server = await tx(async (client) => {
    await assertQuota(owner, { memoryMb: input.memoryMb, cpu: input.cpu, diskMb: input.diskMb ?? null }, undefined, client);
    const port = await pickPort(client, input.port);
    const r = await client.query<ServerRow>(
      `INSERT INTO servers (owner_id, name, type, mc_version, loader_version, modpack, java_args, memory_mb, cpu,
                            disk_mb, port, env, auto_restart, rcon_password, minecraft)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        owner.id,
        input.name,
        input.type,
        input.mcVersion || 'LATEST',
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
      ],
    );
    return r.rows[0]!;
  });
  const dir = serverDir(server.id);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
    if (seed) await seed(dir, server);
  } catch (err) {
    await query('DELETE FROM servers WHERE id = $1', [server.id]);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return server;
}

export async function updateServer(actor: UserRow, server: ServerRow, patch: UpdateServerInput): Promise<ServerRow> {
  return tx(async (client) => {
    const owner = await getUser(server.owner_id);
    const memoryMb = patch.memoryMb ?? server.memory_mb;
    const cpu = patch.cpu ?? server.cpu;
    const diskMb = patch.diskMb !== undefined ? patch.diskMb : server.disk_mb;
    if (patch.memoryMb !== undefined || patch.cpu !== undefined || patch.diskMb !== undefined) {
      // Admins may exceed a user's quota when editing on their behalf.
      if (actor.role !== 'admin') await assertQuota(owner, { memoryMb, cpu, diskMb }, server.id, client);
    }
    const port = patch.port !== undefined && patch.port !== server.port ? await pickPort(client, patch.port, server.id) : server.port;
    const type = patch.type ?? server.type;
    const modpack: ModpackRef | null = patch.modpack !== undefined ? patch.modpack : server.modpack;
    if ((type === 'CURSEFORGE' || type === 'MODRINTH') && !modpack) {
      throw badRequest('A modpack is required for this server type', 'modpack_required');
    }
    const r = await client.query<ServerRow>(
      `UPDATE servers SET name=$2, type=$3, mc_version=$4, loader_version=$5, modpack=$6, java_args=$7, memory_mb=$8,
         cpu=$9, disk_mb=$10, port=$11, env=$12, auto_restart=$13 WHERE id=$1 RETURNING *`,
      [
        server.id,
        patch.name ?? server.name,
        type,
        patch.mcVersion ?? server.mc_version,
        patch.loaderVersion !== undefined ? patch.loaderVersion : server.loader_version,
        modpack ? JSON.stringify(modpack) : null,
        patch.javaArgs !== undefined ? patch.javaArgs : server.java_args,
        memoryMb,
        cpu,
        diskMb,
        port,
        JSON.stringify(patch.env ?? server.env ?? {}),
        patch.autoRestart ?? server.auto_restart,
      ],
    );
    return r.rows[0]!;
  });
}

export async function deleteServer(server: ServerRow): Promise<void> {
  await runtime.destroy(server);
  await query('DELETE FROM servers WHERE id = $1', [server.id]);
  await fsp.rm(serverDir(server.id), { recursive: true, force: true }).catch(() => undefined);
  await fsp.rm(path.join(config().backupsDir, server.id), { recursive: true, force: true }).catch(() => undefined);
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
    minecraft: server.minecraft ?? null,
  };
}

export async function getServerRow(id: string): Promise<ServerRow | null> {
  return queryOne<ServerRow>('SELECT * FROM servers WHERE id = $1', [id]);
}
