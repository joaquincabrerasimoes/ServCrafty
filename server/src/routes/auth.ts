import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { queryOne } from '../db/pool.js';
import { dummyHash, verifyPassword } from '../auth/passwords.js';
import { requireUser } from '../auth/plugin.js';
import { clearSessionCookie, completeMfa, createSession, deleteSession, type SessionRow } from '../auth/sessions.js';
import { verifyTotp } from '../auth/totp.js';
import { authenticationOptions, verifyAuthentication } from '../auth/webauthn.js';
import { unauthorized } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { parse } from '../lib/validation.js';
import { audit } from '../services/audit.js';
import { toPublicUser, type UserRow } from '../services/types.js';
import { findUserByUsername } from '../services/users.js';

const loginLimiter = new RateLimiter(10, 5 * 60_000);
const mfaLimiter = new RateLimiter(10, 5 * 60_000);

export async function mfaInfo(userId: string): Promise<{ totp: boolean; passkeys: number }> {
  const r = await queryOne<{ totp: boolean; passkeys: number }>(
    `SELECT u.totp_enabled AS totp, (SELECT count(*)::int FROM passkeys p WHERE p.user_id = u.id) AS passkeys
     FROM users u WHERE u.id = $1`,
    [userId],
  );
  return { totp: r?.totp ?? false, passkeys: r?.passkeys ?? 0 };
}

function requirePending(req: FastifyRequest): { user: UserRow; session: SessionRow } {
  if (req.pendingUser && req.session && !req.session.mfa_ok) return { user: req.pendingUser, session: req.session };
  throw unauthorized('No pending login; sign in with your password first', 'no_pending_login');
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req, reply) => {
    const body = parse(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(1024) }), req.body);
    const key = `${req.ip}:${body.username.toLowerCase()}`;
    loginLimiter.hit(key);
    const user = await findUserByUsername(body.username);
    const ok = user ? await verifyPassword(user.password_hash, body.password) : (await verifyPassword(await dummyHash(), body.password), false);
    if (!user || !ok || user.disabled) {
      await audit(req, 'auth.login_failed', 'user', user?.id ?? null, { username: body.username }, user?.id ?? null);
      throw unauthorized('Invalid username or password', 'invalid_credentials');
    }
    loginLimiter.reset(key);
    if (req.session) await deleteSession(req.session.id);
    const mfa = await mfaInfo(user.id);
    const methods = [...(mfa.totp ? ['totp'] : []), ...(mfa.passkeys > 0 ? ['passkey'] : [])];
    if (methods.length) {
      await createSession(req, reply, user.id, false);
      return { status: 'mfa_required', methods };
    }
    await createSession(req, reply, user.id, true);
    await audit(req, 'auth.login', 'user', user.id, {}, user.id);
    return { status: 'ok', user: toPublicUser(user) };
  });

  app.post('/auth/mfa/totp', async (req, reply) => {
    const { user, session } = requirePending(req);
    mfaLimiter.hit(session.id);
    const body = parse(z.object({ code: z.string().min(6).max(10) }), req.body);
    if (!user.totp_enabled || !verifyTotp(user.totp_secret_enc, body.code)) {
      await audit(req, 'auth.mfa_failed', 'user', user.id, { method: 'totp' }, user.id);
      throw unauthorized('Invalid code', 'invalid_code');
    }
    await completeMfa(reply, session);
    await audit(req, 'auth.login', 'user', user.id, { mfa: 'totp' }, user.id);
    return { status: 'ok', user: toPublicUser(user) };
  });

  app.post('/auth/mfa/passkey/options', async (req) => {
    const { user, session } = requirePending(req);
    return authenticationOptions(user, session);
  });

  app.post('/auth/mfa/passkey/verify', async (req, reply) => {
    const { user, session } = requirePending(req);
    mfaLimiter.hit(session.id);
    const body = parse(z.object({ response: z.record(z.unknown()) }), req.body);
    try {
      await verifyAuthentication(user, session, body.response as unknown as AuthenticationResponseJSON);
    } catch (err) {
      await audit(req, 'auth.mfa_failed', 'user', user.id, { method: 'passkey' }, user.id);
      throw err;
    }
    await completeMfa(reply, session);
    await audit(req, 'auth.login', 'user', user.id, { mfa: 'passkey' }, user.id);
    return { status: 'ok', user: toPublicUser(user) };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.session) await deleteSession(req.session.id);
    clearSessionCookie(reply);
    if (req.user) await audit(req, 'auth.logout', 'user', req.user.id);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const user = requireUser(req);
    return { user: toPublicUser(user), mfa: await mfaInfo(user.id), authVia: req.authVia };
  });
}
