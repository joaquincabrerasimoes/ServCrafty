import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { requireUser } from '../auth/plugin.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validation.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import { getUser } from '../services/users.js';

export default async function shareRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/servers/:id/shares', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const rows = await query<{ user_id: string; username: string; level: string; created_at: Date }>(
      `SELECT sh.user_id, u.username, sh.level, sh.created_at FROM server_shares sh JOIN users u ON u.id = sh.user_id
       WHERE sh.server_id = $1 ORDER BY u.username`,
      [server.id],
    );
    return rows.map((r) => ({ userId: r.user_id, username: r.username, level: r.level, createdAt: r.created_at.toISOString() }));
  });

  app.post<{ Params: { id: string } }>('/servers/:id/shares', async (req) => {
    const user = requireUser(req);
    const { server, access } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(z.object({ userId: z.string().uuid(), level: z.enum(['viewer', 'operator', 'manager']) }), req.body);
    if (body.userId === server.owner_id) throw badRequest('The owner already has full access', 'share_owner');
    // Managers may share, but only owners/admins can grant "manager".
    if (access === 'manager' && body.level === 'manager') {
      throw badRequest('Only the owner or an admin can grant manager access', 'share_level_forbidden');
    }
    const target = await getUser(body.userId);
    if (target.disabled) throw badRequest('User is disabled', 'user_disabled');
    await query(
      `INSERT INTO server_shares (server_id, user_id, level) VALUES ($1,$2,$3)
       ON CONFLICT (server_id, user_id) DO UPDATE SET level = EXCLUDED.level`,
      [server.id, target.id, body.level],
    );
    await audit(req, 'server.shared', 'server', server.id, { userId: target.id, level: body.level });
    return { userId: target.id, username: target.username, level: body.level };
  });

  app.delete<{ Params: { id: string; userId: string } }>('/servers/:id/shares/:userId', async (req) => {
    const user = requireUser(req);
    // Users may always remove their own share ("leave"); otherwise manager access is required.
    const self = req.params.userId === user.id;
    const { server, access } = await loadServerFor(user, req.params.id, self ? 'viewer' : 'manager');
    if (!self && access === 'manager') {
      const existing = await queryOne<{ level: string }>('SELECT level FROM server_shares WHERE server_id=$1 AND user_id=$2', [
        server.id,
        req.params.userId,
      ]);
      if (existing?.level === 'manager') throw badRequest('Only the owner or an admin can remove a manager', 'share_level_forbidden');
    }
    const r = await query('DELETE FROM server_shares WHERE server_id = $1 AND user_id = $2 RETURNING user_id', [
      server.id,
      req.params.userId,
    ]);
    if (!r.length) throw notFound('Share not found', 'share_not_found');
    await audit(req, 'server.unshared', 'server', server.id, { userId: req.params.userId });
    return { ok: true };
  });
}
