import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { queryOne } from '../db/pool.js';
import { isRemoteRequest, parseNetworks, type Network } from '../lib/network.js';
import { audit } from './audit.js';
import { getSetting, SettingKeys } from './settings.js';
import type { UserRow } from './types.js';

/** The configured LAN ranges as typed by the admin ('' = not configured). */
export async function getLanNetworksSpec(): Promise<string> {
  return (await getSetting<string>(SettingKeys.lanNetworks)) ?? '';
}

let parsedFor = '';
let parsed: Network[] = [];
/** Parsed LAN ranges; empty means the LAN-only rule is not configured and is not enforced. */
export async function getLanNetworks(): Promise<Network[]> {
  const spec = await getSetting<string>(SettingKeys.lanNetworks);
  if (!spec) return [];
  if (spec !== parsedFor) {
    try {
      parsed = parseNetworks(spec);
    } catch {
      parsed = []; // a corrupt value must not lock everybody out
    }
    parsedFor = spec;
  }
  return parsed;
}

/**
 * Accounts that may only be used from the local network: the bootstrap admin (ADMIN_USERNAME), and every
 * other admin that has no second factor (TOTP or a passkey). Admins with 2FA may also come in remotely.
 */
export async function isLanOnly(user: Pick<UserRow, 'id' | 'role' | 'username'>): Promise<boolean> {
  if (user.role !== 'admin') return false;
  if (user.username.toLowerCase() === config().adminUsername.toLowerCase()) return true;
  const r = await queryOne<{ mfa: boolean }>(
    `SELECT (u.totp_enabled OR EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id)) AS mfa FROM users u WHERE u.id = $1`,
    [user.id],
  );
  return !r?.mfa;
}

const recentlyAudited = new Map<string, number>();
const AUDIT_EVERY_MS = 10 * 60_000;

/** True when this request must be refused because the account is LAN-only and the request is not. */
export async function blockedForRemote(req: FastifyRequest, user: UserRow, via: 'login' | 'session' | 'token'): Promise<boolean> {
  if (user.role !== 'admin') return false;
  const lan = await getLanNetworks();
  if (lan.length === 0 || !isRemoteRequest(req, lan)) return false;
  if (!(await isLanOnly(user))) return false;
  // Sessions and tokens are checked on every request; log once per user and address instead of every call.
  const key = `${user.id}|${req.ip}|${via}`;
  const now = Date.now();
  if (via === 'login' || now - (recentlyAudited.get(key) ?? 0) > AUDIT_EVERY_MS) {
    if (recentlyAudited.size > 500) recentlyAudited.clear();
    recentlyAudited.set(key, now);
    await audit(req, 'auth.blocked_remote', 'user', user.id, { via, username: user.username }, user.id);
  }
  return true;
}
