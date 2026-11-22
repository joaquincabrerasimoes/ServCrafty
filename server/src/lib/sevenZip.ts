import fsp from 'node:fs/promises';
import path from 'node:path';
import SevenZipImport, { type FileSystem, type SevenZipModuleFactory } from '7z-wasm';
import { badRequest } from './errors.js';

// The package is CommonJS: Node hands the factory over as the default import, TypeScript types it as `{ default }`.
const SevenZip = ((SevenZipImport as unknown as { default?: unknown }).default ?? SevenZipImport) as SevenZipModuleFactory;

/**
 * Extract zip, 7z, rar, tar, tar.gz and tar.xz archives with 7-Zip compiled to WebAssembly: no system binary needed
 * (GameBanana serves maps as .zip, .rar and .7z, and some bot packages come as .tar.xz). The archive is unpacked into
 * the module's in-memory file system, so a hostile archive cannot write outside it; only plain files are copied out,
 * under `dest`, after their paths are checked again.
 */

export interface ExtractLimits {
  /** Largest archive accepted (bytes). */
  maxArchiveBytes: number;
  /** Largest total of extracted files (bytes). */
  maxExtractedBytes: number;
  maxFiles: number;
}

export const DEFAULT_LIMITS: ExtractLimits = { maxArchiveBytes: 200 * 1024 ** 2, maxExtractedBytes: 600 * 1024 ** 2, maxFiles: 5000 };

type Entry = { rel: string; size: number };

function listFiles(fs: FileSystem, dir: string, base: string, out: Entry[]): void {
  for (const name of fs.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const full = `${dir}/${name}`;
    const st = fs.lstat(full);
    if (fs.isDir(st.mode)) listFiles(fs, full, base, out);
    else if (fs.isFile(st.mode)) out.push({ rel: full.slice(base.length + 1), size: st.size });
  }
}

/** A tar archive carries `ustar` at byte 257 (7-Zip names the layer inside an `.xz` without an extension). */
const isTar = (data: Uint8Array): boolean => data.length > 262 && Buffer.from(data.subarray(257, 262)).toString('latin1') === 'ustar';

/** Run `7z x` on one file inside a fresh in-memory file system and return the entries. */
async function unpackOnce(file: string, name: string): Promise<{ fs: FileSystem; files: Entry[] }> {
  const errors: string[] = [];
  // Emscripten's default `quit` sets `process.exitCode` to the exit status of 7-Zip (2 for a file that is not an archive),
  // which would make the whole panel exit with an error code later. Throw the status instead, and put the code back.
  const exitCode = process.exitCode;
  const sz = await SevenZip({
    print: () => undefined,
    printErr: (e) => errors.push(e),
    quit: (_code, status) => {
      throw status;
    },
  });
  const buf = await fsp.readFile(file);
  const input = `/in-${name}`;
  const handle = sz.FS.open(input, 'w+');
  sz.FS.write(handle, buf, 0, buf.length);
  sz.FS.close(handle);
  sz.FS.mkdir('/out');
  try {
    sz.callMain(['x', input, '-o/out', '-y', '-bd', '-bso0', '-bsp0']);
  } catch (err) {
    const status = (err as { status?: number }).status;
    // Emscripten reports a normal exit as an ExitStatus exception; 0 is success, 1 is "warning" (still extracted).
    if (status !== 0 && status !== 1) throw badRequest(`The archive could not be extracted${errors.length ? `: ${errors.slice(0, 2).join(' ')}` : ''}`, 'invalid_archive');
  } finally {
    process.exitCode = exitCode;
  }
  const files: Entry[] = [];
  listFiles(sz.FS, '/out', '/out', files);
  // 7-Zip prints an error and exits without a code for something that is not an archive: nothing was extracted.
  if (!files.length) throw badRequest(`The file is not a valid archive${errors.length ? `: ${errors.slice(0, 2).join(' ')}` : ''}`, 'invalid_archive');
  return { fs: sz.FS, files };
}

const NESTED_EXT = /\.(zip|rar|7z|tar|tgz|tar\.gz|tar\.xz|txz)$/i;
/** How many archives inside archives are opened (a rar of rars is common on GameBanana: one inner archive per map variant). */
const MAX_NESTING = 2;

/**
 * Extract `file` into the existing directory `dest`, and the archives found inside it (up to two levels deep) into a
 * folder next to each one, named after it. The inner archive files themselves are not kept. Returns the relative paths
 * written (forward slashes).
 */
export async function extractArchive(file: string, dest: string, limits: ExtractLimits = DEFAULT_LIMITS): Promise<string[]> {
  let all = await extractOnce(file, dest, limits);
  const notArchives = new Set<string>();
  for (let depth = 0; depth < MAX_NESTING; depth++) {
    const inner = all.filter((rel) => NESTED_EXT.test(rel) && !notArchives.has(rel));
    if (!inner.length) break;
    for (const rel of inner) {
      const archive = path.join(dest, ...rel.split('/'));
      const into = `${rel}.contents`;
      await fsp.mkdir(path.join(dest, ...into.split('/')), { recursive: true });
      // Remaining budget: what the outer archive already used counts against the limits.
      const used = all.length;
      const sub = await extractOnce(archive, path.join(dest, ...into.split('/')), { ...limits, maxFiles: Math.max(1, limits.maxFiles - used) }).catch((err: unknown) => {
        // An inner file that is not really an archive (a readme named .zip) is just a file.
        if ((err as { code?: string }).code === 'invalid_archive') return null;
        throw err;
      });
      if (!sub) {
        await fsp.rm(path.join(dest, ...into.split('/')), { recursive: true, force: true });
        notArchives.add(rel);
        continue;
      }
      await fsp.rm(archive, { force: true });
      all = all.filter((r) => r !== rel).concat(sub.map((r) => `${into}/${r}`));
      if (all.length > limits.maxFiles) throw badRequest('The archive has too many files', 'archive_too_large');
    }
  }
  return all;
}

async function extractOnce(file: string, dest: string, limits: ExtractLimits): Promise<string[]> {
  const stat = await fsp.stat(file);
  if (stat.size > limits.maxArchiveBytes) throw badRequest('The archive is too large', 'archive_too_large');
  let { fs, files } = await unpackOnce(file, 'a');
  // tar.xz / tar.gz: the first pass only yields the .tar
  if (files.length === 1 && isTar(fs.readFile(`/out/${files[0]!.rel}`))) {
    const tarPath = path.join(path.dirname(file), `${path.basename(file)}.inner.tar`);
    await fsp.writeFile(tarPath, fs.readFile(`/out/${files[0]!.rel}`));
    try {
      ({ fs, files } = await unpackOnce(tarPath, 'b'));
    } finally {
      await fsp.rm(tarPath, { force: true });
    }
  }
  if (files.length > limits.maxFiles) throw badRequest('The archive has too many files', 'archive_too_large');
  if (files.reduce((n, f) => n + f.size, 0) > limits.maxExtractedBytes) throw badRequest('The archive is too large once unpacked', 'archive_too_large');

  const base = path.resolve(dest);
  const written: string[] = [];
  for (const f of files) {
    const target = path.resolve(base, ...f.rel.split('/'));
    if (target !== base && !target.startsWith(base + path.sep)) throw badRequest(`Unsafe path in archive: ${f.rel}`, 'unsafe_archive');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, fs.readFile(`/out/${f.rel}`));
    written.push(f.rel);
  }
  return written;
}
