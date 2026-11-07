import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { badRequest } from './errors.js';

export interface ZipEntryInfo {
  name: string;
  isDirectory: boolean;
  uncompressedSize: number;
}

const MAX_ENTRIES = 200_000;
const MAX_TOTAL_BYTES = 50 * 1024 ** 3;

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, strictFileNames: false, validateEntrySizes: true }, (err, zf) =>
      err || !zf ? reject(badRequest(`Invalid zip archive: ${err?.message ?? 'unknown error'}`, 'invalid_archive')) : resolve(zf),
    );
  });
}

/**
 * Iterate zip entries sequentially. `onEntry` may call `open()` to stream the entry's
 * contents; if it does not, the entry is skipped.
 */
export async function walkZip(
  file: string,
  onEntry: (entry: ZipEntryInfo, open: () => Promise<Readable>) => Promise<void | 'stop'>,
): Promise<void> {
  const zf = await openZip(file);
  await new Promise<void>((resolve, reject) => {
    let count = 0;
    let total = 0;
    let done = false;
    const finish = (err?: unknown) => {
      if (done) return;
      done = true;
      zf.close();
      if (err) reject(err);
      else resolve();
    };
    zf.on('error', finish);
    zf.on('end', () => finish());
    zf.on('entry', (entry: yauzl.Entry) => {
      count++;
      total += entry.uncompressedSize;
      if (count > MAX_ENTRIES || total > MAX_TOTAL_BYTES) {
        finish(badRequest('Archive is too large', 'archive_too_large'));
        return;
      }
      const name = entry.fileName.replace(/\\/g, '/');
      const info: ZipEntryInfo = { name, isDirectory: name.endsWith('/'), uncompressedSize: entry.uncompressedSize };
      const open = () =>
        new Promise<Readable>((res, rej) => zf.openReadStream(entry, (err, rs) => (err || !rs ? rej(err) : res(rs))));
      onEntry(info, open)
        .then((r) => (r === 'stop' ? finish() : zf.readEntry()))
        .catch(finish);
    });
    zf.readEntry();
  });
}

async function streamToBuffer(rs: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of rs) {
    n += (c as Buffer).length;
    if (n > limit) throw badRequest('Archive entry is too large', 'archive_too_large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Read specific small text entries (by exact name) from a zip. */
export async function readZipTexts(file: string, names: string[], limit = 10 * 1024 * 1024): Promise<Map<string, string>> {
  const wanted = new Set(names);
  const out = new Map<string, string>();
  await walkZip(file, async (e, open) => {
    if (!wanted.has(e.name)) return;
    out.set(e.name, (await streamToBuffer(await open(), limit)).toString('utf8'));
    if (out.size === wanted.size) return 'stop';
  });
  return out;
}

export async function listZip(file: string): Promise<ZipEntryInfo[]> {
  const out: ZipEntryInfo[] = [];
  await walkZip(file, async (e) => {
    out.push(e);
  });
  return out;
}

/**
 * Extract (optionally a sub-tree of) a zip into `dest`, confined to `dest`.
 * `stripPrefix` removes a leading folder (e.g. "overrides/"); entries outside it are skipped.
 */
export async function extractZip(
  file: string,
  dest: string,
  opts: { stripPrefix?: string; skip?: (name: string) => boolean } = {},
): Promise<number> {
  const root = path.resolve(dest);
  let files = 0;
  await walkZip(file, async (e, open) => {
    let name = e.name;
    if (opts.stripPrefix) {
      if (!name.startsWith(opts.stripPrefix)) return;
      name = name.slice(opts.stripPrefix.length);
    }
    if (!name || opts.skip?.(name)) return;
    const target = path.resolve(root, name);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw badRequest(`Unsafe path in archive: ${e.name}`, 'unsafe_archive');
    if (e.isDirectory) {
      await fsp.mkdir(target, { recursive: true });
      return;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await pipeline(await open(), fs.createWriteStream(target));
    files++;
  });
  return files;
}
