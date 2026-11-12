import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/plugin.js';
import { badRequest, notFound } from '../lib/errors.js';
import { iconProblem, SERVER_ICON_MAX_BYTES } from '../lib/serverIcon.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import * as runtime from '../services/runtime.js';
import { deleteIcon, iconVersion, readIcon, supportsIcon, writeIcon } from '../services/serverIcon.js';

type IdParams = { Params: { id: string } };

/** Multiplayer-list icon of Java servers (SPEC "Server icon (v0.5.0)"). */
export default async function iconRoutes(app: FastifyInstance): Promise<void> {
  app.get<IdParams>('/servers/:id/icon', async (req, reply) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    if (!supportsIcon(server.type)) throw notFound('This server type has no icon');
    const png = await readIcon(server.id);
    if (!png) throw notFound('This server has no icon');
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'private, max-age=300').send(png);
  });

  app.put<IdParams>('/servers/:id/icon', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    if (!supportsIcon(server.type)) throw badRequest('Only Minecraft Java servers have an icon', 'icon_unsupported');
    if (!req.isMultipart()) throw badRequest('Expected multipart/form-data', 'multipart_required');
    let png: Buffer | null = null;
    for await (const part of req.parts({ limits: { fileSize: SERVER_ICON_MAX_BYTES + 1, files: 1 } })) {
      if (part.type === 'file' && !png) png = await part.toBuffer();
    }
    if (!png) throw badRequest('No image uploaded', 'file_required');
    const problem = iconProblem(png);
    if (problem) throw badRequest(problem, 'invalid_icon');
    await writeIcon(server.id, png);
    await audit(req, 'server.icon_set', 'server', server.id, { bytes: png.length });
    return { icon: iconVersion(server.id, server.type), restartRequired: runtime.isRunning(server.id) };
  });

  app.delete<IdParams>('/servers/:id/icon', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    if (!supportsIcon(server.type)) throw badRequest('Only Minecraft Java servers have an icon', 'icon_unsupported');
    await deleteIcon(server.id);
    await audit(req, 'server.icon_removed', 'server', server.id, {});
    return { icon: null, restartRequired: runtime.isRunning(server.id) };
  });
}
