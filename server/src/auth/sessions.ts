import type {} from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import type { UserRow } from '../services/types.js';

export const SESSION_COOKIE = 'scf_sid';
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** A session that has not passed MFA expires quickly. */
export const PENDING_TTL_MS = 10 * 60_000;

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: Date;
  mfa_ok: boolean;
  user_agent: string | null;
  ip: string | null;
  webauthn_challenge: string | null;
  created_at: Date;
  last_seen_at: Date;
}

export async function createSession(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  mfaOk: boolean,
): Promise<SessionRow> {
  const id = randomToken(32);
  const ttl = mfaOk ? SESSION_TTL_MS : PENDING_TTL_MS;
  const row = await queryOne<SessionRow>(
    `INSERT INTO sessions (id, user_id, expires_at, mfa_ok, user_agent, ip)
     VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, $4, $5, $6) RETURNING *`,
    [id, userId, String(ttl), mfaOk, (req.headers['user-agent'] ?? '').slice(0, 300), req.ip],
  );
  setSessionCookie(reply, id, ttl);
  return row!;
}

export function setSessionCookie(reply: FastifyReply, id: string, ttlMs: number): void {
  reply.setCookie(SESSION_COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Secure only when this request really arrived over HTTPS (behind Cloudflare/a proxy this
    // comes from X-Forwarded-Proto when TRUST_PROXY=1). Marking it Secure on plain HTTP would
    // make browsers silently drop the cookie, e.g. when opening the app by LAN IP.
    secure: reply.request.protocol === 'https',
    signed: true,
    maxAge: Math.floor(ttlMs / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Mark a pending session as fully authenticated and extend it. */
export async function completeMfa(reply: FastifyReply, session: SessionRow): Promise<void> {
  await query(
    `UPDATE sessions SET mfa_ok = true, webauthn_challenge = NULL,
       expires_at = now() + ($2 || ' milliseconds')::interval WHERE id = $1`,
    [session.id, String(SESSION_TTL_MS)],
  );
  setSessionCookie(reply, session.id, SESSION_TTL_MS);
}

export async function loadSession(id: string): Promise<{ session: SessionRow; user: UserRow } | null> {
  const row = await queryOne<SessionRow & { u: UserRow }>(
    `SELECT s.*, to_jsonb(u) AS u FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [id],
  );
  if (!row) return null;
  const { u, ...session } = row;
  const user: UserRow = { ...u, created_at: new Date(u.created_at) };
  return { session, user };
}

/** Sliding expiration: refresh at most once per hour. */
export async function touchSession(s: SessionRow): Promise<void> {
  if (!s.mfa_ok) return;
  if (Date.now() - new Date(s.last_seen_at).getTime() < 3600_000) return;
  await query(
    `UPDATE sessions SET last_seen_at = now(), expires_at = now() + ($2 || ' milliseconds')::interval WHERE id = $1`,
    [s.id, String(SESSION_TTL_MS)],
  );
}

export async function deleteSession(id: string): Promise<void> {
  await query('DELETE FROM sessions WHERE id = $1', [id]);
}

export async function deleteUserSessions(userId: string, exceptId?: string): Promise<void> {
  await query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [userId, exceptId ?? '']);
}

export async function purgeExpiredSessions(): Promise<void> {
  await query('DELETE FROM sessions WHERE expires_at < now()');
}

// ---------- API tokens ----------

export const TOKEN_PREFIX = 'scf_';

export function generateApiToken(): { token: string; hash: string; prefix: string } {
  const token = TOKEN_PREFIX + randomToken(32);
  return { token, hash: sha256(token), prefix: token.slice(0, TOKEN_PREFIX.length + 6) };
}

export async function loadUserByToken(token: string): Promise<UserRow | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = await queryOne<{ token_id: string; last_used_at: Date | null; u: UserRow }>(
    `SELECT t.id AS token_id, t.last_used_at, to_jsonb(u) AS u FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND (t.expires_at IS NULL OR t.expires_at > now())`,
    [sha256(token)],
  );
  if (!row) return null;
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    await query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [row.token_id]).catch(() => undefined);
  }
  return { ...row.u, created_at: new Date(row.u.created_at) };
}
