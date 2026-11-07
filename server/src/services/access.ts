import { query, queryOne } from '../db/pool.js';
import { forbidden, notFound } from '../lib/errors.js';
import type { Access, ServerRow, ShareLevel, UserRow } from './types.js';

/** Capability level required for an action. "full" = owner/admin only. */
export type Need = 'viewer' | 'operator' | 'manager' | 'full';

const RANK: Record<Access, number> = { viewer: 1, operator: 2, manager: 3, owner: 4, admin: 4 };
const NEED_RANK: Record<Need, number> = { viewer: 1, operator: 2, manager: 3, full: 4 };

export function hasAccess(access: Access | null, need: Need): boolean {
  return !!access && RANK[access] >= NEED_RANK[need];
}

export async function accessFor(user: UserRow, server: ServerRow): Promise<Access | null> {
  if (user.role === 'admin') return server.owner_id === user.id ? 'owner' : 'admin';
  if (server.owner_id === user.id) return 'owner';
  const share = await queryOne<{ level: ShareLevel }>(
    'SELECT level FROM server_shares WHERE server_id = $1 AND user_id = $2',
    [server.id, user.id],
  );
  return share?.level ?? null;
}

/**
 * Load a server and check the caller's access level. Users without any access get 404
 * (to avoid leaking existence); users with insufficient access get 403.
 */
export async function loadServerFor(
  user: UserRow,
  serverId: string,
  need: Need,
): Promise<{ server: ServerRow; access: Access }> {
  const server = /^[0-9a-f-]{36}$/i.test(serverId)
    ? await queryOne<ServerRow>('SELECT * FROM servers WHERE id = $1', [serverId])
    : null;
  if (!server) throw notFound('Server not found', 'server_not_found');
  const access = await accessFor(user, server);
  if (!access) throw notFound('Server not found', 'server_not_found');
  if (!hasAccess(access, need)) throw forbidden(`This action requires ${need} access`, 'insufficient_access');
  return { server, access };
}

/** All servers visible to the user, with access level and owner name. */
export async function listServersFor(
  user: UserRow,
): Promise<{ server: ServerRow; access: Access; ownerName: string | null }[]> {
  if (user.role === 'admin') {
    const rows = await query<ServerRow & { owner_name: string | null }>(
      `SELECT s.*, u.username AS owner_name FROM servers s LEFT JOIN users u ON u.id = s.owner_id ORDER BY s.created_at`,
    );
    return rows.map(({ owner_name, ...s }) => ({
      server: s,
      access: s.owner_id === user.id ? 'owner' : 'admin',
      ownerName: owner_name,
    }));
  }
  const rows = await query<ServerRow & { owner_name: string | null; share_level: ShareLevel | null }>(
    `SELECT s.*, u.username AS owner_name, sh.level AS share_level
     FROM servers s
     LEFT JOIN users u ON u.id = s.owner_id
     LEFT JOIN server_shares sh ON sh.server_id = s.id AND sh.user_id = $1
     WHERE s.owner_id = $1 OR sh.user_id IS NOT NULL
     ORDER BY s.created_at`,
    [user.id],
  );
  return rows.map(({ owner_name, share_level, ...s }) => ({
    server: s,
    access: s.owner_id === user.id ? 'owner' : (share_level as ShareLevel),
    ownerName: owner_name,
  }));
}
