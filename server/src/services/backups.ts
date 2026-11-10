import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { conflict, errorMessage, notFound } from '../lib/errors.js';
import { gameOf } from '../lib/games.js';
import { serverDir } from './docker.js';
import { bus } from './events.js';
import * as runtime from './runtime.js';
import type { ServerRow } from './types.js';

export interface BackupRow {
  id: string;
  server_id: string;
  file: string;
  size_bytes: number;
  kind: 'manual' | 'scheduled';
  created_by: string | null;
  created_at: Date;
  note: string | null;
}

export function toPublicBackup(b: BackupRow & { created_by_name?: string | null }) {
  return {
    id: b.id,
    serverId: b.server_id,
    file: b.file,
    sizeBytes: b.size_bytes,
    kind: b.kind,
    createdBy: b.created_by,
    createdByName: b.created_by_name ?? null,
    createdAt: b.created_at.toISOString(),
    note: b.note,
  };
}

const busy = new Set<string>();
const EXCLUDE_TOP = new Set(['logs', 'crash-reports', '.cache']);
/**
 * SteamCMD servers: the game install, Workshop downloads and the SteamCMD home are re-downloadable
 * (often many GB) and left out unless asked for; restores keep the current copies of these dirs.
 */
export const STEAM_REDOWNLOADABLE = ['game', 'workshop', 'steam'] as const;

/** Pure: should `rel` (path relative to the server dir) go into the archive? */
export function includeInBackup(rel: string, opts: { steam: boolean; includeGame: boolean }): boolean {
  const clean = rel.replace(/^\.\//, '');
  const top = clean.split('/')[0] ?? '';
  if (EXCLUDE_TOP.has(top)) return false;
  if (opts.steam && !opts.includeGame && (STEAM_REDOWNLOADABLE as readonly string[]).includes(top)) return false;
  return !/(\.scf-tmp|\.upload-tmp|\.part-[0-9a-f]+)$/.test(clean) && !clean.endsWith('session.lock');
}

export const backupDir = (serverId: string) => path.join(config().backupsDir, serverId);

export async function listBackups(serverId: string) {
  const rows = await query<BackupRow & { created_by_name: string | null }>(
    `SELECT b.*, u.username AS created_by_name FROM backups b LEFT JOIN users u ON u.id = b.created_by
     WHERE b.server_id = $1 ORDER BY b.created_at DESC`,
    [serverId],
  );
  return rows.map(toPublicBackup);
}

export async function getBackup(serverId: string, backupId: string): Promise<BackupRow> {
  const b = /^[0-9a-f-]{36}$/i.test(backupId)
    ? await queryOne<BackupRow>('SELECT * FROM backups WHERE id = $1 AND server_id = $2', [backupId, serverId])
    : null;
  if (!b) throw notFound('Backup not found', 'backup_not_found');
  return b;
}

export function backupPath(b: BackupRow): string {
  return path.join(backupDir(b.server_id), path.basename(b.file));
}

/** Create a tar.gz of the server directory. World saving is paused via RCON while archiving. */
export async function createBackup(
  server: ServerRow,
  kind: 'manual' | 'scheduled',
  userId: string | null,
  note?: string | null,
  opts: { includeGame?: boolean } = {},
): Promise<BackupRow> {
  if (busy.has(server.id)) throw conflict('A backup or restore is already in progress', 'backup_in_progress');
  busy.add(server.id);
  const dir = backupDir(server.id);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${stamp}-${kind}.tar.gz`;
  const file = path.join(dir, fileName);
  let paused = false;
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.mkdir(serverDir(server.id), { recursive: true });
    if (gameOf(server.type) === 'terraria') {
      // No RCON save-off/on: ask Terraria to write the world (`save`) before archiving.
      await runtime.saveWorld(server.id);
    } else if (runtime.getStatus(server.id) === 'running') {
      paused = (await runtime.tryRcon(server.id, 'save-off')) !== null;
      if (paused) {
        await runtime.tryRcon(server.id, 'save-all flush');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    runtime.systemLog(server.id, `[servcrafty] creating ${kind} backup ${fileName}`);
    await tar.c(
      {
        gzip: true,
        file,
        cwd: serverDir(server.id),
        portable: true,
        filter: (p: string) => includeInBackup(p, { steam: gameOf(server.type) === 'steam', includeGame: !!opts.includeGame }),
      },
      ['.'],
    );
    const size = (await fsp.stat(file)).size;
    const row = await queryOne<BackupRow>(
      `INSERT INTO backups (server_id, file, size_bytes, kind, created_by, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [server.id, fileName, size, kind, userId, note ?? null],
    );
    runtime.systemLog(server.id, `[servcrafty] backup complete (${(size / 1048576).toFixed(1)} MB)`);
    bus.emit('notify', server.id, 'backup.created', { file: fileName, sizeBytes: size, kind });
    return row!;
  } catch (err) {
    await fsp.rm(file, { force: true }).catch(() => undefined);
    runtime.systemLog(server.id, `[servcrafty] backup failed: ${errorMessage(err)}`);
    bus.emit('notify', server.id, 'backup.failed', { error: errorMessage(err), kind });
    throw err;
  } finally {
    if (paused) await runtime.tryRcon(server.id, 'save-on');
    busy.delete(server.id);
  }
}

export async function deleteBackup(b: BackupRow): Promise<void> {
  await fsp.rm(backupPath(b), { force: true });
  await query('DELETE FROM backups WHERE id = $1', [b.id]);
}

/** Keep only the newest `keep` backups of the given kind. */
export async function pruneBackups(serverId: string, keep: number, kind: 'scheduled' | 'manual' = 'scheduled'): Promise<number> {
  const old = await query<BackupRow>(
    `SELECT * FROM backups WHERE server_id = $1 AND kind = $2 ORDER BY created_at DESC OFFSET $3`,
    [serverId, kind, Math.max(0, keep)],
  );
  for (const b of old) await deleteBackup(b);
  return old.length;
}

/**
 * Restore a backup: the server is stopped, its directory swapped for the archive
 * contents (the previous contents are kept until extraction succeeds), and restarted
 * if it was running.
 */
export async function restoreBackup(server: ServerRow, b: BackupRow): Promise<void> {
  if (busy.has(server.id)) throw conflict('A backup or restore is already in progress', 'backup_in_progress');
  const archive = backupPath(b);
  try {
    await fsp.access(archive, fs.constants.R_OK);
  } catch {
    throw notFound('Backup archive is missing on disk', 'backup_file_missing');
  }
  busy.add(server.id);
  const wasRunning = runtime.isRunning(server.id);
  try {
    if (wasRunning) await runtime.stop(server.id, false, false);
    const dir = serverDir(server.id);
    const aside = `${dir}.pre-restore-${Date.now()}`;
    await fsp.rename(dir, aside).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    try {
      await fsp.mkdir(dir, { recursive: true });
      await tar.x({ file: archive, cwd: dir, strict: true });
      if (gameOf(server.type) === 'steam') {
        // Backups usually leave the game install out: keep the current one instead of forcing a re-download.
        for (const d of STEAM_REDOWNLOADABLE) {
          const inArchive = await fsp.stat(path.join(dir, d)).then(() => true, () => false);
          if (inArchive) continue;
          await fsp.rename(path.join(aside, d), path.join(dir, d)).catch(() => undefined);
        }
      }
      await fsp.rm(aside, { recursive: true, force: true });
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await fsp.rename(aside, dir).catch(() => undefined);
      throw err;
    }
    runtime.systemLog(server.id, `[servcrafty] restored backup ${b.file}`);
  } finally {
    busy.delete(server.id);
  }
  if (wasRunning) await runtime.start(server.id);
}
