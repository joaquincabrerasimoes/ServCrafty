import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import archiver from 'archiver';
import { z } from 'zod';
import * as cf from '../catalog/curseforge.js';
import * as mr from '../catalog/modrinth.js';
import { loaderVersions, minecraftVersions } from '../catalog/versions.js';
import { badRequest } from '../lib/errors.js';
import { curseforgeFingerprint, exists, hashFile } from '../lib/fsutil.js';
import { parseProperties } from '../lib/properties.js';
import { serverTypeSchema, type ServerType } from '../lib/validation.js';
import { extractZip, listZip, readZipTexts } from '../lib/zip.js';
import { serverDir } from './docker.js';
import { configOf, createServer, serverConfigSchema, type ServerConfig } from './servers.js';
import { getCurseforgeKey } from './settings.js';
import { contentDirFor, modrinthLoaderFor, type ServerRow, type UserRow } from './types.js';

export type ExportFormat = 'curseforge' | 'modrinth' | 'serverpack';

/** Client-relevant folders copied into modpack overrides. */
const OVERRIDE_DIRS = ['config', 'defaultconfigs', 'kubejs', 'scripts', 'global_packs', 'resourcepacks', 'shaderpacks'];
const SERVERPACK_EXCLUDE_TOP = new Set(['logs', 'crash-reports', '.cache', 'libraries', 'versions', '.fabric', 'cache', 'debug']);

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._ -]+/g, '_').trim() || 'server';
}

async function effectiveMcVersion(server: ServerRow, detected: string | null): Promise<string> {
  if (server.mc_version && server.mc_version !== 'LATEST') return server.mc_version;
  if (detected && /^\d/.test(detected)) return detected;
  const list = await minecraftVersions(server.type === 'BEDROCK' ? 'VANILLA' : server.type);
  if (!list[0]) throw badRequest('Cannot determine Minecraft version', 'unknown_version');
  return list[0];
}

async function effectiveLoader(server: ServerRow, mc: string): Promise<{ loader: string; version: string } | null> {
  const loader = modrinthLoaderFor(server.type) ?? server.modpack?.loader ?? null;
  if (!loader || !['fabric', 'quilt', 'forge', 'neoforge'].includes(loader)) return null;
  const version =
    server.loader_version ||
    (await loaderVersions(
      ({ fabric: 'FABRIC', quilt: 'QUILT', forge: 'FORGE', neoforge: 'NEOFORGE' } as Record<string, ServerType>)[loader]!,
      mc,
    ))[0];
  if (!version) throw badRequest(`Cannot determine ${loader} loader version; set it in server settings`, 'unknown_loader_version');
  return { loader, version };
}

async function modJars(server: ServerRow): Promise<string[]> {
  const kind = contentDirFor(server.type);
  if (kind !== 'mods') return [];
  const dir = path.join(serverDir(server.id), 'mods');
  try {
    return (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.jar'));
  } catch {
    return [];
  }
}

async function addOverrides(archive: archiver.Archiver, server: ServerRow, prefix: string): Promise<void> {
  const root = serverDir(server.id);
  for (const d of OVERRIDE_DIRS) {
    const p = path.join(root, d);
    if (await exists(p)) archive.directory(p, `${prefix}/${d}`);
  }
}

function newZip(): archiver.Archiver {
  const a = archiver('zip', { zlib: { level: 6 } });
  return a;
}

/** Build an export archive; the returned stream is ready to pipe to the client. */
export async function exportServer(
  server: ServerRow,
  format: ExportFormat,
  opts: { includeWorld?: boolean; detectedVersion?: string | null },
): Promise<{ stream: Readable; filename: string; warnings: string[] }> {
  const base = safeName(server.name);
  const warnings: string[] = [];
  if (format === 'serverpack') {
    const archive = newZip();
    const root = serverDir(server.id);
    let worlds = new Set<string>();
    if (!opts.includeWorld) {
      let level = 'world';
      try {
        level = parseProperties(await fsp.readFile(path.join(root, 'server.properties'), 'utf8'))['level-name'] || 'world';
      } catch {
        /* default */
      }
      worlds = new Set([level, `${level}_nether`, `${level}_the_end`, 'worlds']);
    }
    archive.append(
      JSON.stringify({ format: 'servcrafty-serverpack', formatVersion: 1, name: server.name, config: configOf(server) }, null, 2),
      { name: 'servcrafty.json' },
    );
    archive.directory(root, false, (entry) => {
      const rel = entry.name.replace(/\\/g, '/');
      const top = rel.split('/')[0] ?? '';
      if (SERVERPACK_EXCLUDE_TOP.has(top) || worlds.has(top)) return false;
      if (/\.(scf-tmp|upload-tmp)$|session\.lock$|\.part-[0-9a-f]+$/.test(rel)) return false;
      return entry;
    });
    void archive.finalize();
    return { stream: archive, filename: `${base}-serverpack.zip`, warnings };
  }

  if (server.type === 'BEDROCK') throw badRequest('Bedrock servers cannot be exported as modpacks', 'unsupported');
  const mc = await effectiveMcVersion(server, opts.detectedVersion ?? null);
  const loader = await effectiveLoader(server, mc);
  const jars = await modJars(server);
  const modsDir = path.join(serverDir(server.id), 'mods');

  if (format === 'modrinth') {
    const sha512 = new Map<string, string>();
    for (const j of jars) sha512.set(j, await hashFile(path.join(modsDir, j), 'sha512'));
    let known: Record<string, mr.MrVersion> = {};
    try {
      known = await mr.versionsByHashes([...sha512.values()], 'sha512');
    } catch (err) {
      warnings.push(`Modrinth lookup failed: ${(err as Error).message}`);
    }
    const files: unknown[] = [];
    const unmatched: string[] = [];
    for (const j of jars) {
      const h = sha512.get(j)!;
      const v = known[h];
      const f = v?.files.find((x) => x.hashes.sha512 === h);
      if (!v || !f) {
        unmatched.push(j);
        continue;
      }
      files.push({
        path: `mods/${f.filename}`,
        hashes: { sha1: f.hashes.sha1, sha512: f.hashes.sha512 },
        env: { client: 'required', server: 'required' },
        downloads: [f.url],
        fileSize: f.size,
      });
    }
    const deps: Record<string, string> = { minecraft: mc };
    if (loader) deps[loader.loader === 'fabric' ? 'fabric-loader' : loader.loader === 'quilt' ? 'quilt-loader' : loader.loader] = loader.version;
    const archive = newZip();
    archive.append(
      JSON.stringify(
        { formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: server.name, summary: `Exported from ServCrafty`, files, dependencies: deps },
        null,
        2,
      ),
      { name: 'modrinth.index.json' },
    );
    for (const j of unmatched) archive.file(path.join(modsDir, j), { name: `overrides/mods/${j}` });
    await addOverrides(archive, server, 'overrides');
    if (unmatched.length) warnings.push(`${unmatched.length} mod(s) not found on Modrinth were embedded in overrides/mods`);
    void archive.finalize();
    return { stream: archive, filename: `${base}.mrpack`, warnings };
  }

  // CurseForge manifest zip
  if (!loader) throw badRequest('CurseForge modpacks require a mod loader (Forge, NeoForge, Fabric or Quilt)', 'unsupported');
  const fps = new Map<number, string>();
  for (const j of jars) fps.set(curseforgeFingerprint(await fsp.readFile(path.join(modsDir, j))), j);
  const files: { projectID: number; fileID: number; required: boolean }[] = [];
  const matchedJars = new Set<string>();
  if (fps.size) {
    if (!(await getCurseforgeKey())) warnings.push('CurseForge API key not configured: all mods embedded in overrides');
    else {
      const matches = await cf.matchFingerprints([...fps.keys()]);
      for (const [fp, j] of fps) {
        const m = matches.get(fp);
        if (!m) continue;
        files.push({ projectID: m.modId, fileID: m.file.id, required: true });
        matchedJars.add(j);
      }
    }
  }
  const archive = newZip();
  archive.append(
    JSON.stringify(
      {
        minecraft: { version: mc, modLoaders: [{ id: `${loader.loader}-${loader.version}`, primary: true }] },
        manifestType: 'minecraftModpack',
        manifestVersion: 1,
        name: server.name,
        version: '1.0.0',
        author: 'ServCrafty',
        files,
        overrides: 'overrides',
      },
      null,
      2,
    ),
    { name: 'manifest.json' },
  );
  const unmatched = jars.filter((j) => !matchedJars.has(j));
  for (const j of unmatched) archive.file(path.join(modsDir, j), { name: `overrides/mods/${j}` });
  await addOverrides(archive, server, 'overrides');
  if (unmatched.length) warnings.push(`${unmatched.length} mod(s) not matched on CurseForge were embedded in overrides/mods`);
  void archive.finalize();
  return { stream: archive, filename: `${base}-curseforge.zip`, warnings };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export const importFieldsSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  memoryMb: z.coerce.number().int().min(512).max(1_048_576).optional(),
  cpu: z.coerce.number().min(0.1).max(256).optional(),
  diskMb: z.coerce.number().int().min(256).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  type: serverTypeSchema.optional(),
  mcVersion: z.string().max(64).optional(),
  eula: z.enum(['true', '1', 'on']).optional(),
});
export type ImportFields = z.infer<typeof importFieldsSchema>;

interface MrIndex {
  name?: string;
  dependencies?: Record<string, string>;
}
interface CfManifest {
  name?: string;
  manifestType?: string;
  minecraft?: { version?: string; modLoaders?: { id: string; primary?: boolean }[] };
}

function loaderFromMr(deps: Record<string, string>): { type: ServerType; loader: string | null; version: string | null } {
  if (deps['neoforge']) return { type: 'NEOFORGE', loader: 'neoforge', version: deps['neoforge'] };
  if (deps['forge']) return { type: 'FORGE', loader: 'forge', version: deps['forge'] };
  if (deps['quilt-loader']) return { type: 'QUILT', loader: 'quilt', version: deps['quilt-loader'] };
  if (deps['fabric-loader']) return { type: 'FABRIC', loader: 'fabric', version: deps['fabric-loader'] };
  return { type: 'VANILLA', loader: null, version: null };
}

/**
 * Create a server from an uploaded archive: Modrinth .mrpack, CurseForge modpack zip,
 * or a server pack (ServCrafty export, or any zip with server files plus `type`).
 */
export async function importArchive(
  actor: UserRow,
  file: string,
  originalName: string,
  fields: ImportFields,
): Promise<{ server: ServerRow; detected: string; warnings: string[] }> {
  if (!fields.eula) throw badRequest('You must accept the Minecraft EULA (eula=true)', 'eula_required');
  const texts = await readZipTexts(file, ['modrinth.index.json', 'manifest.json', 'servcrafty.json']);
  const warnings: string[] = [];
  const resources = { memoryMb: fields.memoryMb ?? 4096, cpu: fields.cpu ?? 2, diskMb: fields.diskMb ?? null };

  const mrIndex = texts.get('modrinth.index.json');
  if (mrIndex) {
    const idx = JSON.parse(mrIndex) as MrIndex;
    const deps = idx.dependencies ?? {};
    const l = loaderFromMr(deps);
    const server = await createServer(
      actor,
      {
        name: fields.name ?? idx.name ?? path.parse(originalName).name,
        type: 'MODRINTH',
        mcVersion: deps.minecraft ?? 'LATEST',
        loaderVersion: l.version,
        modpack: { source: 'file', name: idx.name, localFile: 'modpack.mrpack', loader: l.loader ?? undefined },
        port: fields.port,
        ...resources,
      },
      async (dir) => {
        await fsp.copyFile(file, path.join(dir, 'modpack.mrpack'));
      },
    );
    return { server, detected: 'modrinth', warnings };
  }

  const manifestText = texts.get('manifest.json');
  if (manifestText) {
    const man = JSON.parse(manifestText) as CfManifest;
    if (man.manifestType === 'minecraftModpack') {
      const primary = man.minecraft?.modLoaders?.find((m) => m.primary) ?? man.minecraft?.modLoaders?.[0];
      const [loaderName, ...rest] = (primary?.id ?? '').split('-');
      if (!(await getCurseforgeKey())) warnings.push('CurseForge API key is not configured; the pack cannot download its mods until it is set');
      const server = await createServer(
        actor,
        {
          name: fields.name ?? man.name ?? path.parse(originalName).name,
          type: 'CURSEFORGE',
          mcVersion: man.minecraft?.version ?? 'LATEST',
          loaderVersion: rest.join('-') || null,
          modpack: { source: 'file', name: man.name, localFile: 'modpack.zip', loader: loaderName || undefined },
          port: fields.port,
          ...resources,
        },
        async (dir) => {
          await fsp.copyFile(file, path.join(dir, 'modpack.zip'));
        },
      );
      return { server, detected: 'curseforge', warnings };
    }
  }

  const scf = texts.get('servcrafty.json');
  let cfg: ServerConfig | null = null;
  if (scf) {
    const parsed = serverConfigSchema.safeParse((JSON.parse(scf) as { config?: unknown }).config);
    if (parsed.success) cfg = parsed.data;
    else warnings.push('servcrafty.json config was invalid and has been ignored');
  }
  if (!cfg) {
    const entries = await listZip(file);
    const looksLikeServer = entries.some((e) => /^(server\.properties|mods\/|plugins\/|config\/)/.test(e.name));
    if (!looksLikeServer) throw badRequest('Unrecognized archive: expected .mrpack, CurseForge zip or server pack', 'unrecognized_archive');
    if (!fields.type) throw badRequest('This server pack has no servcrafty.json; specify "type" (and "mcVersion")', 'type_required');
    cfg = { type: fields.type, mcVersion: fields.mcVersion ?? 'LATEST', ...resources };
  }
  const modpack = cfg.modpack ?? null;
  const server = await createServer(
    actor,
    {
      ...cfg,
      modpack,
      name: fields.name ?? (scf ? (JSON.parse(scf) as { name?: string }).name : undefined) ?? path.parse(originalName).name,
      memoryMb: fields.memoryMb ?? cfg.memoryMb,
      cpu: fields.cpu ?? cfg.cpu,
      diskMb: fields.diskMb ?? cfg.diskMb ?? null,
      port: fields.port,
    },
    async (dir) => {
      await extractZip(file, dir, { skip: (n) => n === 'servcrafty.json' });
    },
  );
  return { server, detected: 'serverpack', warnings };
}
