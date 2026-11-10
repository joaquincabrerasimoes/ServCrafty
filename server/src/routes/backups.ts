import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { notFound } from '../lib/errors.js';
import { parse } from '../lib/validation.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import * as backups from '../services/backups.js';

type P = { Params: { id: string; bid: string } };

export default async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/servers/:id/backups', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    return backups.listBackups(server.id);
  });

  app.post<{ Params: { id: string }; Querystring: { includeGame?: string } }>('/servers/:id/backups', async (req, reply) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(z.object({ note: z.string().max(200).nullable().optional() }), req.body ?? {});
    // SteamCMD: the game install / Workshop / SteamCMD dirs are only archived with ?includeGame=1.
    const includeGame = req.query.includeGame === '1' || req.query.includeGame === 'true';
    const b = await backups.createBackup(server, 'manual', user.id, body.note ?? null, { includeGame });
    await audit(req, 'backup.created', 'backup', b.id, { serverId: server.id });
    reply.code(201);
    return backups.toPublicBackup({ ...b, created_by_name: user.username });
  });

  app.post<P>('/servers/:id/backups/:bid/restore', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const b = await backups.getBackup(server.id, req.params.bid);
    await backups.restoreBackup(server, b);
    await audit(req, 'backup.restored', 'backup', b.id, { serverId: server.id });
    return { ok: true };
  });

  app.get<P>('/servers/:id/backups/:bid/download', async (req, reply) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const b = await backups.getBackup(server.id, req.params.bid);
    const file = backups.backupPath(b);
    const st = await fs.promises.stat(file).catch(() => null);
    if (!st) throw notFound('Backup archive is missing on disk', 'backup_file_missing');
    reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Length', String(st.size))
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(`${server.name}-${b.file}`)}"`);
    return reply.send(fs.createReadStream(file));
  });

  app.delete<P>('/servers/:id/backups/:bid', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const b = await backups.getBackup(server.id, req.params.bid);
    await backups.deleteBackup(b);
    await audit(req, 'backup.deleted', 'backup', b.id, { serverId: server.id });
    return { ok: true };
  });
}
