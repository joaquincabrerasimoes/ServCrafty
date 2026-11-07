import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { parse } from '../lib/validation.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import * as mods from '../services/mods.js';
import * as runtime from '../services/runtime.js';
import type { ServerRow } from '../services/types.js';

async function detected(server: ServerRow): Promise<string | null> {
  const s = await runtime.getStats(server).catch(() => null);
  return s?.version && s.version !== 'LATEST' ? s.version : null;
}

export default async function modRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/servers/:id/mods', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    return mods.listMods(server);
  });

  app.post<{ Params: { id: string } }>('/servers/:id/mods/install', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(
      z.object({
        source: z.enum(['curseforge', 'modrinth']),
        projectId: z.union([z.string().min(1), z.number()]).transform(String),
        fileId: z.union([z.string().min(1), z.number()]).transform(String).optional(),
        replace: z.string().max(255).optional(),
      }),
      req.body,
    );
    const r = await mods.installMod(server, body, await detected(server));
    await audit(req, 'server.mod_installed', 'server', server.id, {
      source: body.source,
      projectId: body.projectId,
      files: r.installed.map((m) => m.file),
    });
    return { ...r, restartRequired: runtime.isRunning(server.id) };
  });

  app.patch<{ Params: { id: string; file: string } }>('/servers/:id/mods/:file', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(z.object({ enabled: z.boolean() }), req.body);
    const file = await mods.toggleMod(server, req.params.file, body.enabled);
    await audit(req, 'server.mod_toggled', 'server', server.id, { file, enabled: body.enabled });
    return { file, enabled: body.enabled };
  });

  app.delete<{ Params: { id: string; file: string } }>('/servers/:id/mods/:file', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    await mods.deleteMod(server, req.params.file);
    await audit(req, 'server.mod_removed', 'server', server.id, { file: req.params.file });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/servers/:id/mods/updates', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    return mods.checkUpdates(server, await detected(server));
  });
}
