import type { FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';

export interface AuditEntry {
  id: number;
  userId: string | null;
  username: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  meta: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

/** Record an audit event. Never throws (audit failure must not break the request). */
export async function audit(
  req: FastifyRequest | null,
  action: string,
  targetType: string | null = null,
  targetId: string | null = null,
  meta: Record<string, unknown> = {},
  userIdOverride?: string | null,
): Promise<void> {
  const userId = userIdOverride !== undefined ? userIdOverride : (req?.user?.id ?? null);
  try {
    await query(
      'INSERT INTO audit_log (user_id, action, target_type, target_id, meta, ip) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, action, targetType, targetId, JSON.stringify(meta), req?.ip ?? null],
    );
  } catch (err) {
    req?.log.error({ err }, 'audit write failed');
  }
}

export async function listAudit(opts: {
  limit: number;
  offset: number;
  user?: string;
  action?: string;
}): Promise<{ items: AuditEntry[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.user) {
    params.push(opts.user);
    where.push(`(a.user_id::text = $${params.length} OR lower(u.username) = lower($${params.length}))`);
  }
  if (opts.action) {
    params.push(`${opts.action}%`);
    where.push(`a.action LIKE $${params.length}`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${w}`,
    params,
  );
  params.push(opts.limit, opts.offset);
  const rows = await query<{
    id: number;
    user_id: string | null;
    username: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    meta: Record<string, unknown>;
    ip: string | null;
    created_at: Date;
  }>(
    `SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${w}
     ORDER BY a.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    total: totalRow[0]?.n ?? 0,
    items: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      meta: r.meta,
      ip: r.ip,
      createdAt: r.created_at.toISOString(),
    })),
  };
}
