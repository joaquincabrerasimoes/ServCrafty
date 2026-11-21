import type {} from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authorizeKey } from '../lib/apiScopes.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { queryOne } from '../db/pool.js';
import { blockedForRemote } from '../services/lanOnly.js';
import type { UserRow } from '../services/types.js';
import { loadSession, loadUserByToken, SESSION_COOKIE, touchSession, type SessionRow, type TokenLimits } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Fully authenticated user (session with MFA passed, or API token). */
    user: UserRow | null;
    /** Current cookie session (may be MFA-pending). */
    session: SessionRow | null;
    /** User of an MFA-pending session. */
    pendingUser: UserRow | null;
    authVia: 'session' | 'token' | null;
    /** Permissions of the API key that authenticated this request (null for sessions). */
    apiKey: TokenLimits | null;
  }
}

/** Resolves the caller's identity on every request (no enforcement here). */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);
  app.decorateRequest('pendingUser', null);
  app.decorateRequest('authVia', null);
  app.decorateRequest('apiKey', null);

  app.addHook('onRequest', async (req) => {
    const authz = req.headers.authorization;
    if (authz && /^Bearer\s+/i.test(authz)) {
      const token = authz.replace(/^Bearer\s+/i, '').trim();
      const found = await loadUserByToken(token);
      // LAN-only accounts are ignored when the request comes from outside the LAN.
      if (found && !found.user.disabled && !(await blockedForRemote(req, found.user, 'token'))) {
        req.user = found.user;
        req.authVia = 'token';
        req.apiKey = found.key;
        await enforceKeyLimits(req, found.key);
      }
      return;
    }
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const loaded = await loadSession(unsigned.value);
    if (!loaded || loaded.user.disabled) return;
    if (await blockedForRemote(req, loaded.user, 'session')) return;
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

/** Server (and only that) a schedule or webhook belongs to, for keys limited to some servers. */
async function serverOfResource(pattern: string, params: Record<string, unknown>): Promise<string | null> {
  const id = typeof params.id === 'string' && /^[0-9a-f-]{36}$/i.test(params.id) ? params.id : null;
  if (!id) return null;
  if (pattern.startsWith('/schedules/')) return (await queryOne<{ server_id: string }>('SELECT server_id FROM schedules WHERE id = $1', [id]))?.server_id ?? null;
  if (pattern.startsWith('/webhooks/')) return (await queryOne<{ server_id: string | null }>('SELECT server_id FROM webhooks WHERE id = $1', [id]))?.server_id ?? null;
  return null;
}

/** API key permissions: every route a key calls must be allowed by its scopes and server list (lib/apiScopes.ts). */
async function enforceKeyLimits(req: FastifyRequest, key: TokenLimits): Promise<void> {
  const url = req.routeOptions?.url;
  if (!url) return; // unknown route: the 404 handler answers
  const pattern = url.startsWith('/api/') ? url.slice(4) : url;
  const params = (req.params ?? {}) as Record<string, unknown>;
  const resolved = key.serverIds && (pattern.startsWith('/schedules/') || pattern.startsWith('/webhooks/')) ? await serverOfResource(pattern, params) : null;
  const d = authorizeKey(key, req.method, pattern, params, resolved);
  if (!d.ok) throw new AppError(d.status, d.code, d.message, d.required ? { required: d.required } : undefined);
}
