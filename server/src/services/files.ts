import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { assertFileName, resolveSafe } from '../lib/safePath.js';
import { serverDir } from './docker.js';
import { diskUsageMb } from './runtime.js';
import type { ServerRow } from './types.js';

export const MAX_EDIT_BYTES = 5 * 1024 * 1024;

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
}

function root(server: ServerRow): string {
  return serverDir(server.id);
}

async function statOr404(abs: string): Promise<fs.Stats> {
  try {
    return await fsp.lstat(abs);
  } catch {
    throw notFound('File not found', 'file_not_found');
  }
}

export async function listDir(server: ServerRow, rel: string): Promise<{ path: string; entries: FileEntry[] }> {
  await fsp.mkdir(root(server), { recursive: true });
  const { abs, rel: clean } = await resolveSafe(root(server), rel);
  const st = await statOr404(abs);
  if (!st.isDirectory()) throw badRequest('Not a directory', 'not_a_directory');
  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const entries: FileEntry[] = [];
  for (const d of dirents) {
    const p = path.join(abs, d.name);
    let s: fs.Stats;
    try {
      s = await fsp.lstat(p);
    } catch {
      continue;
    }
    entries.push({
      name: d.name,
      path: clean ? `${clean}/${d.name}` : d.name,
      type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : s.isSymbolicLink() ? 'symlink' : 'other',
      size: s.isFile() ? s.size : 0,
      modifiedAt: s.mtime.toISOString(),
    });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  return { path: clean, entries };
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function readText(server: ServerRow, rel: string): Promise<{ path: string; content: string; size: number }> {
  const { abs, rel: clean } = await resolveSafe(root(server), rel);
  const st = await statOr404(abs);
  if (!st.isFile()) throw badRequest('Not a regular file', 'not_a_file');
  if (st.size > MAX_EDIT_BYTES) throw new AppError(413, 'file_too_large', 'File is too large to edit; download it instead');
  const buf = await fsp.readFile(abs);
  if (looksBinary(buf)) throw new AppError(415, 'binary_file', 'Binary files cannot be edited');
  return { path: clean, content: buf.toString('utf8'), size: st.size };
}

async function assertDiskRoom(server: ServerRow, incomingBytes: number): Promise<void> {
  if (server.disk_mb == null) return;
  const used = await diskUsageMb(server, true);
  if (used + incomingBytes / 1048576 > server.disk_mb) {
    throw new AppError(507, 'disk_quota_exceeded', `Disk limit of ${server.disk_mb} MB would be exceeded`);
  }
}

export async function writeText(server: ServerRow, rel: string, content: string): Promise<void> {
  const { abs, rel: clean } = await resolveSafe(root(server), rel);
  if (!clean) throw badRequest('Invalid path', 'invalid_path');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_EDIT_BYTES) throw new AppError(413, 'file_too_large', 'Content too large');
  await assertDiskRoom(server, bytes);
  try {
    const st = await fsp.lstat(abs);
    if (!st.isFile()) throw badRequest('Not a regular file', 'not_a_file');
  } catch (err) {
    if (err instanceof AppError) throw err;
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.scf-tmp`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, abs);
}

/** Stream an uploaded file into `dirRel/filename`. */
export async function saveUpload(server: ServerRow, dirRel: string, filename: string, stream: Readable): Promise<string> {
  assertFileName(filename);
  await assertDiskRoom(server, 0);
  const { abs: dirAbs, rel: cleanDir } = await resolveSafe(root(server), dirRel);
  await fsp.mkdir(dirAbs, { recursive: true });
  const { abs } = await resolveSafe(root(server), cleanDir ? `${cleanDir}/${filename}` : filename);
  const tmp = `${abs}.upload-tmp`;
  try {
    await pipeline(stream, fs.createWriteStream(tmp));
    if ((stream as Readable & { truncated?: boolean }).truncated) {
      throw new AppError(413, 'file_too_large', 'Upload exceeds the size limit');
    }
    await fsp.rename(tmp, abs);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return cleanDir ? `${cleanDir}/${filename}` : filename;
}

export async function openDownload(server: ServerRow, rel: string): Promise<{ stream: fs.ReadStream; name: string; size: number }> {
  const { abs } = await resolveSafe(root(server), rel);
  const st = await statOr404(abs);
  if (!st.isFile()) throw badRequest('Only files can be downloaded', 'not_a_file');
  return { stream: fs.createReadStream(abs), name: path.basename(abs), size: st.size };
}

export async function makeDir(server: ServerRow, rel: string): Promise<void> {
  const { abs, rel: clean } = await resolveSafe(root(server), rel);
  if (!clean) throw badRequest('Invalid path', 'invalid_path');
  await fsp.mkdir(abs, { recursive: true });
}

export async function rename(server: ServerRow, fromRel: string, toRel: string): Promise<void> {
  const from = await resolveSafe(root(server), fromRel);
  const to = await resolveSafe(root(server), toRel);
  if (!from.rel || !to.rel) throw badRequest('Cannot rename the root directory', 'invalid_path');
  await statOr404(from.abs);
  try {
    await fsp.lstat(to.abs);
    throw conflict('Destination already exists', 'already_exists');
  } catch (err) {
    if (err instanceof AppError) throw err;
  }
  await fsp.mkdir(path.dirname(to.abs), { recursive: true });
  await fsp.rename(from.abs, to.abs);
}

export async function remove(server: ServerRow, rel: string): Promise<void> {
  const { abs, rel: clean } = await resolveSafe(root(server), rel);
  if (!clean) throw badRequest('Cannot delete the root directory', 'invalid_path');
  await statOr404(abs);
  await fsp.rm(abs, { recursive: true, force: true });
}
