import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/plugin.js';
import { badRequest } from '../lib/errors.js';
import { assertTerraria } from '../lib/games.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import { importWorld, listWorlds, MAX_WORLD_UPLOAD_BYTES, type UploadPart } from '../services/terrariaWorlds.js';

type IdParams = { Params: { id: string } };

export default async function terrariaRoutes(app: FastifyInstance): Promise<void> {
  app.get<IdParams>('/servers/:id/terraria/worlds', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    return listWorlds(server);
  });

  app.post<IdParams & { Querystring: { overwrite?: string } }>('/servers/:id/terraria/world', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    assertTerraria(server, 'Terraria worlds');
    if (!req.isMultipart()) throw badRequest('Expected multipart/form-data', 'multipart_required');
    const overwrite = req.query.overwrite === '1' || req.query.overwrite === 'true';
    async function* files(): AsyncGenerator<UploadPart> {
      for await (const part of req.parts({ limits: { fileSize: MAX_WORLD_UPLOAD_BYTES, files: 2 } })) {
        if (part.type === 'file') yield { filename: part.filename, file: part.file };
      }
    }
    const r = await importWorld(server, files(), { overwrite });
    await audit(req, 'server.terraria_world_imported', 'server', server.id, { worldFile: r.worldFile, overwrite });
    return { worldName: r.worldName, worldFile: r.worldFile, terraria: r.server.terraria };
  });
}
