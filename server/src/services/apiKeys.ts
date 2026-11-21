import type { FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';

/** Keeps only the servers an API key limited to some servers may see (no-op for sessions and unrestricted keys). */
export function limitToKey<T extends { server: { id: string } }>(req: FastifyRequest, rows: T[]): T[] {
  const ids = req.apiKey?.serverIds;
  return ids ? rows.filter((r) => ids.includes(r.server.id)) : rows;
}

/** A key limited to some servers manages what it creates: the new server joins its list. */
export async function grantCreated(req: FastifyRequest, serverId: string): Promise<void> {
  const key = req.apiKey;
  if (!key?.serverIds) return;
  await query('UPDATE api_tokens SET server_ids = array_append(server_ids, $2::uuid) WHERE id = $1 AND NOT ($2::uuid = ANY(server_ids))', [key.id, serverId]);
  key.serverIds = [...key.serverIds, serverId];
}
