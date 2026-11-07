import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Recursively sum file sizes under `dir` (bytes). Missing dir = 0. Symlinks are not followed. */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += (await fsp.stat(p)).size;
        } catch {
          /* file vanished */
        }
      }
    }
  }
  return total;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export function hashFile(file: string, algo: 'sha1' | 'sha512' | 'sha256'): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * CurseForge fingerprint: MurmurHash2 (seed 1) over the file bytes with whitespace
 * bytes (9, 10, 13, 32) removed.
 */
export function curseforgeFingerprint(data: Buffer): number {
  const filtered = Buffer.allocUnsafe(data.length);
  let len = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    if (b !== 9 && b !== 10 && b !== 13 && b !== 32) filtered[len++] = b;
  }
  const m = 0x5bd1e995;
  let h = (1 ^ len) >>> 0;
  let i = 0;
  while (len - i >= 4) {
    let k = filtered[i]! | (filtered[i + 1]! << 8) | (filtered[i + 2]! << 16) | (filtered[i + 3]! << 24);
    k = Math.imul(k, m);
    k ^= k >>> 24;
    k = Math.imul(k, m);
    h = Math.imul(h, m) ^ k;
    i += 4;
  }
  const rem = len - i;
  if (rem >= 3) h ^= filtered[i + 2]! << 16;
  if (rem >= 2) h ^= filtered[i + 1]! << 8;
  if (rem >= 1) {
    h ^= filtered[i]!;
    h = Math.imul(h, m);
  }
  h ^= h >>> 13;
  h = Math.imul(h, m);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Copy a directory tree (used by clone). */
export async function copyDir(src: string, dest: string): Promise<void> {
  await fsp.cp(src, dest, { recursive: true, force: true, errorOnExist: false, verbatimSymlinks: true });
}

/** Read a JSON file, returning `fallback` if missing or invalid. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}
