import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth/plugin.js';
import { parse } from '../lib/validation.js';
import { audit } from '../services/audit.js';
import { listAdminGames, setGameDisabled } from '../services/gameControl.js';
import { processSnapshot } from '../services/processMonitor.js';

/** Admin: disabling games and the process monitor (SPEC "v0.3.2" 3 and 4). */
export default async function adminGameRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/games', async (req) => {
    requireAdmin(req);
    return listAdminGames();
  });

  // `:key` is URL-encoded by clients (`steam%3Asatisfactory`); Fastify decodes path params.
  app.put<{ Params: { key: string } }>('/admin/games/:key/disabled', async (req) => {
    const admin = requireAdmin(req);
    const key = String(req.params.key ?? '').trim();
    const body = parse(z.object({ disabled: z.boolean(), blockStart: z.boolean().optional() }).strict(), req.body);
    const r = await setGameDisabled(key, body, admin.id);
    await audit(req, r.disabled ? 'game.disable' : 'game.enable', 'game', key, {
      blockStart: r.blockStart,
      servers: r.servers,
      stopped: r.stopped,
      ...(r.failed ? { failed: r.failed } : {}),
    });
    return { key: r.key, disabled: r.disabled, blockStart: r.blockStart, stopped: r.stopped };
  });

  // Read-only process list of the running game containers (no kill/signal endpoint by design).
  app.get('/admin/processes', async (req) => {
    requireAdmin(req);
    return processSnapshot();
  });
}
