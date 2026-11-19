import fsp from 'node:fs/promises';

/**
 * Reader for Valve VPK archives (versions 1 and 2): lists the files of an addon and reads small ones.
 * Only the directory tree is parsed up front. Used for Left 4 Dead 2 addons to find their maps and
 * campaign (mission) files. Input files are untrusted (Workshop downloads), so every size is bounded and
 * a damaged archive raises `VpkError` instead of reading out of range.
 */
export class VpkError extends Error {}

const SIGNATURE = 0x55aa1234;
const EMBEDDED = 0x7fff;
const MAX_TREE = 256 * 1024 * 1024;
const MAX_ENTRIES = 1_000_000;
/** Largest file `readVpkEntry` returns (mission files and addoninfo.txt are a few KB). */
export const MAX_ENTRY_READ = 2 * 1024 * 1024;

export interface VpkEntry {
  /** Lower-case path inside the archive with `/` separators, e.g. `maps/c1m1_hotel.bsp`. */
  path: string;
  crc: number;
  archiveIndex: number;
  offset: number;
  length: number;
  preloadStart: number;
  preloadLength: number;
}

export interface Vpk {
  file: string;
  version: 1 | 2;
  headerSize: number;
  treeSize: number;
  tree: Buffer;
  entries: VpkEntry[];
}

function cstring(buf: Buffer, at: { i: number }): string {
  const start = at.i;
  while (at.i < buf.length && buf[at.i] !== 0) at.i++;
  if (at.i >= buf.length) throw new VpkError('damaged directory tree');
  const s = buf.toString('utf8', start, at.i);
  at.i++;
  return s;
}

/** Parse the directory of a VPK file (`*_dir.vpk` or a single-file addon). */
export async function openVpk(file: string): Promise<Vpk> {
  const fh = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(28);
    const { bytesRead } = await fh.read(head, 0, 28, 0);
    if (bytesRead < 12 || head.readUInt32LE(0) !== SIGNATURE) throw new VpkError('not a VPK file');
    const version = head.readUInt32LE(4);
    if (version !== 1 && version !== 2) throw new VpkError(`unsupported VPK version ${version}`);
    const headerSize = version === 1 ? 12 : 28;
    const treeSize = head.readUInt32LE(8);
    if (treeSize > MAX_TREE) throw new VpkError('directory tree too large');
    const tree = Buffer.alloc(treeSize);
    const got = (await fh.read(tree, 0, treeSize, headerSize)).bytesRead;
    if (got < treeSize) throw new VpkError('truncated directory tree');

    const entries: VpkEntry[] = [];
    const at = { i: 0 };
    for (;;) {
      const ext = cstring(tree, at);
      if (ext === '') break;
      for (;;) {
        const dir = cstring(tree, at);
        if (dir === '') break;
        for (;;) {
          const name = cstring(tree, at);
          if (name === '') break;
          if (at.i + 18 > tree.length) throw new VpkError('damaged directory tree');
          const crc = tree.readUInt32LE(at.i);
          const preloadLength = tree.readUInt16LE(at.i + 4);
          const archiveIndex = tree.readUInt16LE(at.i + 6);
          const offset = tree.readUInt32LE(at.i + 8);
          const length = tree.readUInt32LE(at.i + 12);
          at.i += 18; // + the 0xFFFF terminator
          const preloadStart = at.i;
          at.i += preloadLength;
          if (at.i > tree.length) throw new VpkError('damaged directory tree');
          const base = ext === ' ' ? name : `${name === ' ' ? '' : name}.${ext}`;
          const full = dir === ' ' ? base : `${dir}/${base}`;
          entries.push({ path: full.replace(/\\/g, '/').toLowerCase(), crc, archiveIndex, offset, length, preloadStart, preloadLength });
          if (entries.length > MAX_ENTRIES) throw new VpkError('too many files');
        }
      }
    }
    return { file, version, headerSize, treeSize, tree, entries };
  } finally {
    await fh.close();
  }
}

/** Contents of a (small) file of the archive: preload bytes followed by the data stored in an archive file. */
export async function readVpkEntry(vpk: Vpk, e: VpkEntry): Promise<Buffer> {
  if (e.preloadLength + e.length > MAX_ENTRY_READ) throw new VpkError(`${e.path} is too large to read`);
  const preload = vpk.tree.subarray(e.preloadStart, e.preloadStart + e.preloadLength);
  if (e.length === 0) return Buffer.from(preload);
  let file = vpk.file;
  let start = e.offset;
  if (e.archiveIndex === EMBEDDED) start += vpk.headerSize + vpk.treeSize;
  else {
    if (!/_dir\.vpk$/i.test(vpk.file)) throw new VpkError('data is stored in another archive file');
    file = vpk.file.replace(/_dir\.vpk$/i, `_${String(e.archiveIndex).padStart(3, '0')}.vpk`);
  }
  const fh = await fsp.open(file, 'r');
  try {
    const data = Buffer.alloc(e.length);
    const { bytesRead } = await fh.read(data, 0, e.length, start);
    if (bytesRead < e.length) throw new VpkError(`${e.path} is truncated`);
    return Buffer.concat([preload, data]);
  } finally {
    await fh.close();
  }
}
