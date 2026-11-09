import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { query, queryOne } from '../db/pool.js';
import { hashPassword, PASSWORD_MIN, verifyPassword } from '../auth/passwords.js';
import { requireUser } from '../auth/plugin.js';
import { deleteUserSessions, generateApiToken } from '../auth/sessions.js';
import { newTotpSecret, consumeTotp } from '../auth/totp.js';
import { listPasskeys, registrationOptions, toPublicPasskey, verifyRegistration } from '../auth/webauthn.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { parse } from '../lib/validation.js';
import { audit } from '../services/audit.js';
import { toPublicUser, type UserRow } from '../services/types.js';
import { getGlobalLimits, hostUsage } from '../services/globalLimits.js';
import { quotaUsage } from '../services/users.js';

function requireSessionAuth(req: Parameters<typeof requireUser>[0]) {
  const user = requireUser(req);
  if (req.authVia !== 'session' || !req.session) throw forbidden('This action requires an interactive session', 'session_required');
  return { user, session: req.session };
}

export default async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.post('/account/password', async (req) => {
    const { user, session } = requireSessionAuth(req);
    const body = parse(z.object({ current: z.string().min(1), new: z.string().min(PASSWORD_MIN).max(1024) }), req.body);
    if (!(await verifyPassword(user.password_hash, body.current))) throw unauthorized('Current password is incorrect', 'invalid_password');
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(body.new)]);
    await deleteUserSessions(user.id, session.id);
    await audit(req, 'account.password_changed', 'user', user.id);
    return { ok: true };
  });

  app.patch('/account', async (req) => {
    const user = requireUser(req);
    const body = parse(
      z
        .object({
          email: z.string().email().max(254).nullable(),
          locale: z.enum(['en', 'es']),
          theme: z.enum(['light', 'dark', 'system']),
        })
        .partial(),
      req.body,
    );
    const u = await queryOne<UserRow>(
      `UPDATE users SET email = $2, locale = $3, theme = $4 WHERE id = $1 RETURNING *`,
      [user.id, body.email !== undefined ? body.email : user.email, body.locale ?? user.locale, body.theme ?? user.theme],
    );
    return { user: toPublicUser(u!) };
  });

  app.get('/account/quota', async (req) => {
    const user = requireUser(req);
    return {
      limits: { maxServers: user.max_servers, maxRamMb: user.max_ram_mb, maxCpu: user.max_cpu, maxDiskMb: user.max_disk_mb },
      usage: await quotaUsage(user.id),
      // Host-wide caps and what every user's servers use together, so the UI can show what is really left.
      host: { limits: await getGlobalLimits(), usage: await hostUsage() },
    };
  });

  // ---- TOTP ----
  app.post('/account/totp/setup', async (req) => {
    const { user } = requireSessionAuth(req);
    if (user.totp_enabled) throw conflict('TOTP is already enabled; disable it first', 'totp_enabled');
    const s = await newTotpSecret(user.username);
    await query('UPDATE users SET totp_secret_enc = $2, totp_last_step = NULL WHERE id = $1', [user.id, s.enc]);
    return { secret: s.secret, otpauthUrl: s.otpauthUrl, qrDataUrl: s.qrDataUrl };
  });

  app.post('/account/totp/enable', async (req) => {
    const { user } = requireSessionAuth(req);
    const body = parse(z.object({ code: z.string().min(6).max(10) }), req.body);
    if (user.totp_enabled) throw conflict('TOTP is already enabled', 'totp_enabled');
    if (!user.totp_secret_enc) throw badRequest('Run TOTP setup first', 'totp_not_setup');
    if (!(await consumeTotp(user.id, user.totp_secret_enc, body.code))) throw badRequest('Invalid code', 'invalid_code');
    await query('UPDATE users SET totp_enabled = true WHERE id = $1', [user.id]);
    await audit(req, 'account.totp_enabled', 'user', user.id);
    return { ok: true };
  });

  app.post('/account/totp/disable', async (req) => {
    const { user } = requireSessionAuth(req);
    const body = parse(z.object({ password: z.string().min(1) }), req.body);
    if (!(await verifyPassword(user.password_hash, body.password))) throw unauthorized('Password is incorrect', 'invalid_password');
    await query('UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = $1', [user.id]);
    await audit(req, 'account.totp_disabled', 'user', user.id);
    return { ok: true };
  });

  // ---- Passkeys ----
  app.post('/account/passkeys/options', async (req) => {
    const { user, session } = requireSessionAuth(req);
    return registrationOptions(user, session);
  });

  app.post('/account/passkeys/verify', async (req) => {
    const { user, session } = requireSessionAuth(req);
    const body = parse(z.object({ response: z.record(z.unknown()), name: z.string().trim().max(64).optional() }), req.body);
    const pk = await verifyRegistration(user, session, body.response as unknown as RegistrationResponseJSON, body.name ?? 'Passkey');
    await audit(req, 'account.passkey_added', 'passkey', pk.id, { name: pk.name });
    return { passkey: toPublicPasskey(pk) };
  });

  app.get('/account/passkeys', async (req) => {
    const user = requireUser(req);
    return (await listPasskeys(user.id)).map(toPublicPasskey);
  });

  app.delete<{ Params: { id: string } }>('/account/passkeys/:id', async (req) => {
    const { user } = requireSessionAuth(req);
    const r = await query('DELETE FROM passkeys WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, user.id]);
    if (!r.length) throw notFound('Passkey not found', 'passkey_not_found');
    await audit(req, 'account.passkey_removed', 'passkey', req.params.id);
    return { ok: true };
  });

  // ---- API tokens ----
  app.get('/account/tokens', async (req) => {
    const user = requireUser(req);
    const rows = await query<{
      id: string;
      name: string;
      prefix: string;
      created_at: Date;
      last_used_at: Date | null;
      expires_at: Date | null;
    }>('SELECT id, name, prefix, created_at, last_used_at, expires_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC', [
      user.id,
    ]);
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      createdAt: t.created_at.toISOString(),
      lastUsedAt: t.last_used_at?.toISOString() ?? null,
      expiresAt: t.expires_at?.toISOString() ?? null,
    }));
  });

  app.post('/account/tokens', async (req, reply) => {
    const { user } = requireSessionAuth(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(64),
        expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
        expiresAt: z.string().datetime().nullable().optional(),
      }),
      req.body,
    );
    const count = await queryOne<{ n: number }>('SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1', [user.id]);
    if ((count?.n ?? 0) >= 50) throw conflict('Token limit reached (50)', 'token_limit');
    const expires = body.expiresAt
      ? new Date(body.expiresAt)
      : body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 86_400_000)
        : null;
    const t = generateApiToken();
    const row = await queryOne<{ id: string; created_at: Date }>(
      `INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [user.id, body.name, t.hash, t.prefix, expires],
    );
    await audit(req, 'account.token_created', 'api_token', row!.id, { name: body.name });
    reply.code(201);
    return {
      id: row!.id,
      name: body.name,
      prefix: t.prefix,
      token: t.token,
      createdAt: row!.created_at.toISOString(),
      expiresAt: expires?.toISOString() ?? null,
      lastUsedAt: null,
    };
  });

  app.delete<{ Params: { id: string } }>('/account/tokens/:id', async (req) => {
    const user = requireUser(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound('Token not found');
    const r = await query('DELETE FROM api_tokens WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, user.id]);
    if (!r.length) throw notFound('Token not found', 'token_not_found');
    await audit(req, 'account.token_revoked', 'api_token', req.params.id);
    return { ok: true };
  });
}
