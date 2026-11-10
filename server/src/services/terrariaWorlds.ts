import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { assertTerraria, terrariaVariant, type TerrariaVariant } from '../lib/games.js';
import { sanitizeWorldUpload } from '../lib/terrariaFiles.js';
import { serverDir } from './docker.js';
import * as runtime from './runtime.js';
import { setTerrariaFields } from './servers.js';
import type { ServerRow } from './types.js';

export const MAX_WORLD_UPLOAD_BYTES = 256 * 1024 * 1024;

export interface WorldInfo {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

function variantOf(server: ServerRow): TerrariaVariant {
  assertTerraria(server, 'Terraria worlds');
  return terrariaVariant(server.type)!;
}

export function worldsDir(server: ServerRow): string {
  return path.join(serverDir(server.id), variantOf(server).worldsRel);
}

/** `.wld` files in the server's Worlds directory (no symlinks, no sub directories). */
export async function listWorlds(server: ServerRow): Promise<WorldInfo[]> {
  const dir = worldsDir(server);
  const dirents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: WorldInfo[] = [];
  for (const d of dirents) {
    if (!d.isFile() || !/\.wld$/i.test(d.name)) continue;
    const st = await fsp.lstat(path.join(dir, d.name)).catch(() => null);
    if (!st?.isFile()) continue;
    out.push({ name: d.name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface UploadPart {
  filename: string;
  file: Readable & { truncated?: boolean };
}

async function exists(p: string): Promise<boolean> {
  return fsp.lstat(p).then(
    () => true,
    () => false,
  );
}

/**
 * Import a world: one `.wld` and optionally its `.twld` (tModLoader) companion. Files are
 * streamed to temporary names inside the Worlds dir, validated, then renamed into place, and
 * the server's `terraria.worldFile` is pointed at the imported world.
 */
export async function importWorld(
  server: ServerRow,
  parts: AsyncIterable<UploadPart>,
  opts: { overwrite: boolean },
): Promise<{ worldName: string; worldFile: string; server: ServerRow }> {
  variantOf(server);
  if (runtime.isRunning(server.id)) throw conflict('Stop the server before importing a world', 'server_running');
  const dir = worldsDir(server);
  await fsp.mkdir(dir, { recursive: true });
  const saved: { ext: 'wld' | 'twld'; stem: string; tmp: string }[] = [];
  try {
    for await (const part of parts) {
      const { stem, ext } = sanitizeWorldUpload(part.filename);
      if (saved.some((s) => s.ext === ext)) throw badRequest(`Only one .${ext} file can be imported at a time`, 'invalid_world_file');
      const tmp = path.join(dir, `.${crypto.randomBytes(6).toString('hex')}.upload-tmp`);
      saved.push({ ext, stem, tmp });
      await pipeline(part.file, fs.createWriteStream(tmp, { flags: 'wx' }));
      if (part.file.truncated) throw new AppError(413, 'file_too_large', 'World files are limited to 256 MB');
    }
    const wld = saved.find((s) => s.ext === 'wld');
    if (!wld) throw badRequest('No .wld world file uploaded', 'file_required');
    const twld = saved.find((s) => s.ext === 'twld');
    if (twld && twld.stem !== wld.stem) throw badRequest('The .twld file must have the same name as the .wld file', 'invalid_world_file');
    if ((await fsp.stat(wld.tmp)).size === 0) throw badRequest('The world file is empty', 'invalid_world_file');
    const worldFile = `${wld.stem}.wld`;
    const targets = saved.map((s) => ({ ...s, dest: path.join(dir, `${s.stem}.${s.ext}`) }));
    if (!opts.overwrite) {
      for (const t of targets) {
        if (await exists(t.dest)) throw conflict(`A world named "${path.basename(t.dest)}" already exists`, 'world_exists');
      }
    }
    for (const t of targets) {
      const st = await fsp.lstat(t.dest).catch(() => null);
      if (st && !st.isFile()) throw conflict(`"${path.basename(t.dest)}" exists and is not a file`, 'world_exists');
      await fsp.rename(t.tmp, t.dest);
    }
    saved.length = 0;
    const updated = await setTerrariaFields(server, { worldFile });
    runtime.systemLog(server.id, `[servcrafty] imported world ${worldFile}`);
    return { worldName: wld.stem, worldFile, server: updated };
  } finally {
    for (const s of saved) await fsp.rm(s.tmp, { force: true }).catch(() => undefined);
  }
}
