import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { hashPassword, PASSWORD_MIN } from '../auth/passwords.js';
import { requireAdmin, requireUser } from '../auth/plugin.js';
import { deleteUserSessions } from '../auth/sessions.js';
import { badRequest, conflict } from '../lib/errors.js';
import { idParam, parse, quotaInt, quotaNum } from '../lib/validation.js';
import { audit } from '../services/audit.js';
import { toPublicUser, type UserRow } from '../services/types.js';
import { countAdmins, createUser, findUserByUsername, getUser, quotaUsage } from '../services/users.js';

const quotasSchema = z
  .object({ maxServers: quotaInt, maxRamMb: quotaInt, maxCpu: quotaNum, maxDiskMb: quotaInt })
  .partial();

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9_.-]+$/, 'only letters, digits, "_", "." and "-"');

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users', async (req) => {
    requireAdmin(req);
    const rows = await query<UserRow & { servers: number; ram: number; cpu: number; disk: number }>(
      `SELECT u.*, count(s.id)::int AS servers, coalesce(sum(s.memory_mb),0)::int AS ram,
              coalesce(sum(s.cpu),0)::float8 AS cpu, coalesce(sum(coalesce(s.disk_mb,0)),0)::int AS disk
       FROM users u LEFT JOIN servers s ON s.owner_id = u.id GROUP BY u.id ORDER BY u.created_at`,
    );
    return rows.map((r) => ({
      ...toPublicUser(r),
      usage: { servers: r.servers, ram_mb: r.ram, cpu: r.cpu, disk_mb: r.disk },
    }));
  });

  app.get<{ Querystring: { q?: string } }>('/users/lookup', async (req) => {
    requireUser(req);
    const q = (req.query.q ?? '').trim();
    if (q.length < 1) return [];
    return query<{ id: string; username: string }>(
      `SELECT id, username FROM users WHERE NOT disabled AND username ILIKE $1 ORDER BY username LIMIT 10`,
      [`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`],
    );
  });

  app.post('/users', async (req, reply) => {
    requireAdmin(req);
    const body = parse(
      z.object({
        username: usernameSchema,
        password: z.string().min(PASSWORD_MIN).max(1024),
        email: z.string().email().max(254).nullable().optional(),
        role: z.enum(['admin', 'user']).default('user'),
        locale: z.enum(['en', 'es']).optional(),
        quotas: quotasSchema.optional(),
      }),
      req.body,
    );
    const u = await createUser({
      username: body.username,
      password: body.password,
      email: body.email ?? null,
      role: body.role,
      locale: body.locale,
      quotas: body.quotas,
    });
    await audit(req, 'user.created', 'user', u.id, { username: u.username, role: u.role });
    reply.code(201);
    return toPublicUser(u);
  });

  app.patch('/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z
        .object({
          username: usernameSchema,
          email: z.string().email().max(254).nullable(),
          role: z.enum(['admin', 'user']),
          disabled: z.boolean(),
          quotas: quotasSchema,
          password: z.string().min(PASSWORD_MIN).max(1024),
          resetMfa: z.boolean(),
        })
        .partial(),
      req.body,
    );
    const u = await getUser(id);
    const demoting = (body.role === 'user' && u.role === 'admin') || (body.disabled === true && u.role === 'admin');
    if (demoting && (await countAdmins(u.id)) === 0) throw conflict('Cannot remove the last active administrator', 'last_admin');
    if (id === admin.id && body.disabled) throw badRequest('You cannot disable your own account', 'self_disable');
    if (body.username && body.username.toLowerCase() !== u.username.toLowerCase()) {
      if (await findUserByUsername(body.username)) throw conflict('Username already exists', 'username_taken');
    }
    const q = body.quotas ?? {};
    const pick = <T>(v: T | undefined, cur: T) => (v !== undefined ? v : cur);
    const updated = await queryOne<UserRow>(
      `UPDATE users SET username=$2, email=$3, role=$4, disabled=$5, max_servers=$6, max_ram_mb=$7, max_cpu=$8, max_disk_mb=$9
       WHERE id=$1 RETURNING *`,
      [
        id,
        body.username ?? u.username,
        pick(body.email, u.email),
        body.role ?? u.role,
        body.disabled ?? u.disabled,
        pick(q.maxServers, u.max_servers),
        pick(q.maxRamMb, u.max_ram_mb),
        pick(q.maxCpu, u.max_cpu),
        pick(q.maxDiskMb, u.max_disk_mb),
      ],
    );
    if (body.password) {
      await query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, await hashPassword(body.password)]);
    }
    if (body.resetMfa) {
      await query('UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = $1', [id]);
      await query('DELETE FROM passkeys WHERE user_id = $1', [id]);
    }
    if (body.password || body.disabled || body.resetMfa) {
      await deleteUserSessions(id, id === admin.id ? req.session?.id : undefined);
    }
    if (body.disabled) await query('DELETE FROM api_tokens WHERE user_id = $1', [id]);
    await audit(req, 'user.updated', 'user', id, {
      fields: Object.keys(body).filter((k) => k !== 'password'),
      passwordReset: !!body.password,
    });
    const final = body.resetMfa || body.password ? await getUser(id) : updated!;
    return { ...toPublicUser(final), usage: await quotaUsage(id) };
  });

  app.delete<{ Querystring: { transferTo?: string } }>('/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    if (id === admin.id) throw badRequest('You cannot delete your own account', 'self_delete');
    const u = await getUser(id);
    if (u.role === 'admin' && (await countAdmins(u.id)) === 0) throw conflict('Cannot delete the last administrator', 'last_admin');
    const owned = await queryOne<{ n: number }>('SELECT count(*)::int AS n FROM servers WHERE owner_id = $1', [id]);
    if ((owned?.n ?? 0) > 0) {
      const transferTo = req.query.transferTo;
      if (!transferTo) {
        throw conflict(`User owns ${owned!.n} server(s); delete them or pass ?transferTo=<userId>`, 'user_has_servers');
      }
      const target = await getUser(transferTo);
      await query('UPDATE servers SET owner_id = $2 WHERE owner_id = $1', [id, target.id]);
      await query('DELETE FROM server_shares WHERE user_id = $1 AND server_id IN (SELECT id FROM servers WHERE owner_id = $1)', [
        target.id,
      ]);
    }
    await query('DELETE FROM users WHERE id = $1', [id]);
    await audit(req, 'user.deleted', 'user', id, { username: u.username, transferTo: req.query.transferTo ?? null });
    return { ok: true };
  });
}
