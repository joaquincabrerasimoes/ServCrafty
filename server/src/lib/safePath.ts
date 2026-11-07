import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest, forbidden } from './errors.js';

/**
 * Normalize a client-supplied relative path ("/", "world/region", "\\x") to a clean
 * POSIX-style relative path without leading slash. Rejects NUL bytes.
 */
export function normalizeRel(rel: string | undefined | null): string {
  const raw = (rel ?? '').replace(/\\/g, '/');
  if (raw.includes('\0')) throw badRequest('Invalid path', 'invalid_path');
  const norm = path.posix.normalize('/' + raw);
  // posix.normalize of an absolute path can never climb above "/"
  return norm.replace(/^\/+/, '').replace(/\/+$/, '');
}

function isInside(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (t === r) return true;
  const rel = path.relative(r, t);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve `rel` inside `root`, guaranteeing (also across symlinks) that the result is
 * confined to `root`. The target itself need not exist; its closest existing ancestor
 * is realpath'd and checked.
 */
export async function resolveSafe(root: string, rel: string | undefined | null): Promise<{ abs: string; rel: string }> {
  const clean = normalizeRel(rel);
  const abs = path.resolve(root, clean);
  if (!isInside(root, abs)) throw forbidden('Path escapes server directory', 'path_traversal');

  const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
  // Find the deepest existing ancestor and make sure its real path is inside root.
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (!isInside(realRoot, real)) throw forbidden('Path escapes server directory', 'path_traversal');
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
        continue;
      }
      throw err;
    }
  }
  return { abs, rel: clean };
}

/** Validate a single file name (no separators, not "." or ".."). */
export function assertFileName(name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name) || name.length > 255) {
    throw badRequest('Invalid file name', 'invalid_name');
  }
  return name;
}
