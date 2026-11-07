import fsp from 'node:fs/promises';
import path from 'node:path';
import * as cf from '../catalog/curseforge.js';
import * as mr from '../catalog/modrinth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { curseforgeFingerprint, hashFile, readJson, writeJsonAtomic } from '../lib/fsutil.js';
import { downloadFile } from '../lib/http.js';
import { assertFileName } from '../lib/safePath.js';
import { serverDir } from './docker.js';
import { contentDirFor, modrinthLoaderFor, type ServerRow } from './types.js';

export interface ModMeta {
  source: 'curseforge' | 'modrinth';
  projectId: string;
  versionId: string;
  name: string;
  versionNumber: string;
  installedAt: string;
}

export interface InstalledMod {
  file: string;
  enabled: boolean;
  size: number;
  modifiedAt: string;
  meta: ModMeta | null;
}

const META_FILE = '.servcrafty/mods.json';
type MetaMap = Record<string, ModMeta>;

function contentDir(server: ServerRow): { abs: string; kind: 'mods' | 'plugins' } {
  const kind = contentDirFor(server.type);
  if (!kind) throw badRequest('This server type does not support mods or plugins', 'mods_unsupported');
  return { abs: path.join(serverDir(server.id), kind), kind };
}

const metaPath = (server: ServerRow) => path.join(serverDir(server.id), META_FILE);
const readMeta = (server: ServerRow) => readJson<MetaMap>(metaPath(server), {});
const writeMeta = (server: ServerRow, m: MetaMap) => writeJsonAtomic(metaPath(server), m);

/** Loader + MC version used to filter compatible files. */
export function compatTarget(server: ServerRow, detectedVersion?: string | null): { loader: string | null; mcVersion: string | null } {
  const loader = modrinthLoaderFor(server.type) ?? server.modpack?.loader ?? null;
  const v = server.mc_version && server.mc_version !== 'LATEST' ? server.mc_version : (detectedVersion ?? null);
  return { loader, mcVersion: v };
}

export async function listMods(server: ServerRow): Promise<{ kind: 'mods' | 'plugins'; mods: InstalledMod[] }> {
  const { abs, kind } = contentDir(server);
  const meta = await readMeta(server);
  let names: string[] = [];
  try {
    names = await fsp.readdir(abs);
  } catch {
    /* none yet */
  }
  const mods: InstalledMod[] = [];
  for (const name of names) {
    if (!/\.jar(\.disabled)?$/i.test(name)) continue;
    const st = await fsp.stat(path.join(abs, name)).catch(() => null);
    if (!st?.isFile()) continue;
    const base = name.replace(/\.disabled$/i, '');
    mods.push({
      file: name,
      enabled: !name.endsWith('.disabled'),
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
      meta: meta[base] ?? null,
    });
  }
  mods.sort((a, b) => a.file.localeCompare(b.file));
  return { kind, mods };
}

interface ResolvedFile {
  source: 'curseforge' | 'modrinth';
  projectId: string;
  versionId: string;
  name: string;
  versionNumber: string;
  fileName: string;
  url: string;
  sha1?: string;
  dependencies: string[];
}

async function resolveModrinth(server: ServerRow, projectId: string, versionId?: string, detected?: string | null): Promise<ResolvedFile> {
  const { loader, mcVersion } = compatTarget(server, detected);
  let v: mr.MrVersion;
  if (versionId) v = await mr.getVersion(versionId);
  else {
    const loaders = loader ? [loader] : undefined;
    const versions = await mr.getVersions(projectId, mcVersion ?? undefined, loaders?.[0]);
    const pick = versions.find((x) => x.releaseType === 'release') ?? versions[0];
    if (!pick) throw notFound(`No compatible version found${mcVersion ? ` for ${mcVersion}` : ''}${loader ? `/${loader}` : ''}`, 'no_compatible_version');
    v = await mr.getVersion(pick.id);
  }
  const file = v.files.find((f) => f.primary) ?? v.files[0];
  if (!file) throw notFound('Version has no files', 'no_files');
  const project = await mr.getProject(v.project_id).catch(() => null);
  return {
    source: 'modrinth',
    projectId: v.project_id,
    versionId: v.id,
    name: project?.name ?? v.name,
    versionNumber: v.version_number,
    fileName: file.filename,
    url: file.url,
    sha1: file.hashes.sha1,
    dependencies: (v.dependencies ?? [])
      .filter((d) => d.dependency_type === 'required' && d.project_id)
      .map((d) => d.project_id as string),
  };
}

async function resolveCurseforge(server: ServerRow, projectId: string, fileId?: string, detected?: string | null): Promise<ResolvedFile> {
  const { loader, mcVersion } = compatTarget(server, detected);
  let f: cf.CfFile;
  if (fileId) f = await cf.getFile(projectId, fileId);
  else {
    const files = await cf.getFiles(projectId, mcVersion ?? undefined, contentDirFor(server.type) === 'plugins' ? undefined : (loader ?? undefined));
    const pick = files.find((x) => x.releaseType === 1) ?? files[0];
    if (!pick) throw notFound('No compatible file found', 'no_compatible_version');
    f = pick;
  }
  const mod = await cf.getMod(projectId).catch(() => null);
  return {
    source: 'curseforge',
    projectId: String(f.modId),
    versionId: String(f.id),
    name: mod?.name ?? f.displayName,
    versionNumber: f.displayName,
    fileName: f.fileName,
    url: cf.requireDownloadUrl(f),
    sha1: f.hashes.find((h) => h.algo === 1)?.value,
    dependencies: [],
  };
}

/**
 * Download a mod/plugin into the server's mods/plugins directory. Required Modrinth
 * dependencies are installed too (unless already present). `replace` removes an old
 * file after a successful install (used for updates).
 */
export async function installMod(
  server: ServerRow,
  input: { source: 'curseforge' | 'modrinth'; projectId: string; fileId?: string; replace?: string },
  detectedVersion?: string | null,
): Promise<{ installed: InstalledMod[] }> {
  const { abs } = contentDir(server);
  await fsp.mkdir(abs, { recursive: true });
  const meta = await readMeta(server);
  const installedProjects = new Set(Object.values(meta).map((m) => `${m.source}:${m.projectId}`));
  const results: InstalledMod[] = [];
  const queue: { projectId: string; fileId?: string; root: boolean }[] = [
    { projectId: input.projectId, fileId: input.fileId, root: true },
  ];
  const seen = new Set<string>();
  while (queue.length && seen.size < 25) {
    const item = queue.shift()!;
    if (seen.has(item.projectId)) continue;
    seen.add(item.projectId);
    if (!item.root && installedProjects.has(`${input.source}:${item.projectId}`)) continue;
    const r =
      input.source === 'modrinth'
        ? await resolveModrinth(server, item.projectId, item.fileId, detectedVersion)
        : await resolveCurseforge(server, item.projectId, item.fileId, detectedVersion);
    assertFileName(r.fileName);
    const dest = path.join(abs, r.fileName);
    await downloadFile(r.url, dest, r.sha1 ? { algo: 'sha1', hex: r.sha1 } : undefined);
    meta[r.fileName] = {
      source: r.source,
      projectId: r.projectId,
      versionId: r.versionId,
      name: r.name,
      versionNumber: r.versionNumber,
      installedAt: new Date().toISOString(),
    };
    const st = await fsp.stat(dest);
    results.push({ file: r.fileName, enabled: true, size: st.size, modifiedAt: st.mtime.toISOString(), meta: meta[r.fileName]! });
    if (item.root && input.replace && input.replace !== r.fileName) {
      assertFileName(input.replace);
      await fsp.rm(path.join(abs, input.replace), { force: true });
      delete meta[input.replace.replace(/\.disabled$/i, '')];
    }
    for (const dep of r.dependencies) queue.push({ projectId: dep, root: false });
  }
  await writeMeta(server, meta);
  return { installed: results };
}

export async function deleteMod(server: ServerRow, file: string): Promise<void> {
  assertFileName(file);
  if (!/\.jar(\.disabled)?$/i.test(file)) throw badRequest('Not a mod file', 'invalid_name');
  const { abs } = contentDir(server);
  const p = path.join(abs, file);
  try {
    await fsp.access(p);
  } catch {
    throw notFound('Mod not found', 'mod_not_found');
  }
  await fsp.rm(p, { force: true });
  const meta = await readMeta(server);
  delete meta[file.replace(/\.disabled$/i, '')];
  await writeMeta(server, meta);
}

/** Enable/disable a mod by toggling the ".disabled" suffix. */
export async function toggleMod(server: ServerRow, file: string, enabled: boolean): Promise<string> {
  assertFileName(file);
  const { abs } = contentDir(server);
  const base = file.replace(/\.disabled$/i, '');
  const target = enabled ? base : `${base}.disabled`;
  if (target === file) return file;
  await fsp.rename(path.join(abs, file), path.join(abs, target)).catch(() => {
    throw notFound('Mod not found', 'mod_not_found');
  });
  return target;
}

export interface ModUpdate {
  file: string;
  source: 'curseforge' | 'modrinth';
  projectId: string;
  name: string;
  currentVersion: string | null;
  latest: { id: string; versionNumber: string; fileName: string };
}

/** Check installed jars for newer compatible versions (Modrinth by hash; CurseForge by tracked id/fingerprint). */
export async function checkUpdates(server: ServerRow, detectedVersion?: string | null): Promise<{ updates: ModUpdate[]; checked: number; errors: string[] }> {
  const { abs } = contentDir(server);
  const { mods } = await listMods(server);
  const { loader, mcVersion } = compatTarget(server, detectedVersion);
  const errors: string[] = [];
  const updates: ModUpdate[] = [];
  const handled = new Set<string>();

  // Modrinth: works for any jar Modrinth knows about.
  const sha1ByFile = new Map<string, string>();
  for (const m of mods) sha1ByFile.set(m.file, await hashFile(path.join(abs, m.file), 'sha1'));
  try {
    const hashes = [...sha1ByFile.values()];
    const [current, latest] = await Promise.all([
      mr.versionsByHashes(hashes, 'sha1'),
      mr.latestByHashes(hashes, 'sha1', loader ? [loader] : [], mcVersion ? [mcVersion] : []),
    ]);
    for (const [file, h] of sha1ByFile) {
      const cur = current[h];
      const lat = latest[h];
      if (!cur) continue;
      handled.add(file);
      if (lat && lat.id !== cur.id) {
        const lf = lat.files.find((f) => f.primary) ?? lat.files[0];
        updates.push({
          file,
          source: 'modrinth',
          projectId: cur.project_id,
          name: mods.find((m) => m.file === file)?.meta?.name ?? cur.name,
          currentVersion: cur.version_number,
          latest: { id: lat.id, versionNumber: lat.version_number, fileName: lf?.filename ?? '' },
        });
      }
    }
  } catch (err) {
    errors.push(`modrinth: ${(err as Error).message}`);
  }

  // CurseForge: tracked installs + fingerprint matches for the rest.
  const cfCandidates = mods.filter((m) => !handled.has(m.file));
  if (cfCandidates.length) {
    try {
      const fps = new Map<number, InstalledMod>();
      for (const m of cfCandidates) {
        if (m.meta?.source === 'curseforge') continue;
        fps.set(curseforgeFingerprint(await fsp.readFile(path.join(abs, m.file))), m);
      }
      const matches = await cf.matchFingerprints([...fps.keys()]);
      const tracked: { m: InstalledMod; projectId: string; fileId: string; currentName: string | null }[] = [];
      for (const m of cfCandidates) {
        if (m.meta?.source === 'curseforge') tracked.push({ m, projectId: m.meta.projectId, fileId: m.meta.versionId, currentName: m.meta.versionNumber });
      }
      for (const [fp, m] of fps) {
        const hit = matches.get(fp);
        if (hit) tracked.push({ m, projectId: String(hit.modId), fileId: String(hit.file.id), currentName: hit.file.displayName });
      }
      const loaderForCf = contentDirFor(server.type) === 'plugins' ? undefined : (loader ?? undefined);
      for (const t of tracked) {
        const files = await cf.getFiles(t.projectId, mcVersion ?? undefined, loaderForCf);
        const newest = files.find((f) => f.releaseType === 1) ?? files[0];
        if (newest && String(newest.id) !== t.fileId && Number(newest.id) > Number(t.fileId)) {
          updates.push({
            file: t.m.file,
            source: 'curseforge',
            projectId: t.projectId,
            name: t.m.meta?.name ?? newest.displayName,
            currentVersion: t.currentName,
            latest: { id: String(newest.id), versionNumber: newest.displayName, fileName: newest.fileName },
          });
        }
      }
    } catch (err) {
      errors.push(`curseforge: ${(err as Error).message}`);
    }
  }
  return { updates, checked: mods.length, errors };
}
