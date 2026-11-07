import type {} from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { UserRow } from '../services/types.js';
import { loadSession, loadUserByToken, SESSION_COOKIE, touchSession, type SessionRow } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Fully authenticated user (session with MFA passed, or API token). */
    user: UserRow | null;
    /** Current cookie session (may be MFA-pending). */
    session: SessionRow | null;
    /** User of an MFA-pending session. */
    pendingUser: UserRow | null;
    authVia: 'session' | 'token' | null;
  }
}

/** Resolves the caller's identity on every request (no enforcement here). */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);
  app.decorateRequest('pendingUser', null);
  app.decorateRequest('authVia', null);

  app.addHook('onRequest', async (req) => {
    const authz = req.headers.authorization;
    if (authz && /^Bearer\s+/i.test(authz)) {
      const token = authz.replace(/^Bearer\s+/i, '').trim();
      const user = await loadUserByToken(token);
      if (user && !user.disabled) {
        req.user = user;
        req.authVia = 'token';
      }
      return;
    }
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const loaded = await loadSession(unsigned.value);
    if (!loaded || loaded.user.disabled) return;
    req.session = loaded.session;
    if (loaded.session.mfa_ok) {
      req.user = loaded.user;
      req.authVia = 'session';
      void touchSession(loaded.session).catch(() => undefined);
    } else {
      req.pendingUser = loaded.user;
    }
  });
}

/** Ensure the request is fully authenticated and return the user. */
export function requireUser(req: FastifyRequest): UserRow {
  if (req.user) return req.user;
  if (req.pendingUser) throw unauthorized('Second factor required', 'mfa_required');
  throw unauthorized();
}

export function requireAdmin(req: FastifyRequest): UserRow {
  const u = requireUser(req);
  if (u.role !== 'admin') throw forbidden('Administrator role required', 'admin_required');
  return u;
}
