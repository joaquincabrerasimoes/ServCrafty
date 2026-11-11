import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { BLUEMAP_UI_ID } from '../lib/bluemap.js';
import { parse } from '../lib/validation.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import { bluemapStatus, disableBluemap, enableBluemap, resetBluemapData } from '../services/bluemap.js';
import * as runtime from '../services/runtime.js';
import type { ServerRow } from '../services/types.js';

type IdParams = { Params: { id: string } };

const bodySchema = z
  .object({
    enabled: z.boolean(),
    /** Required when enabling: BlueMap downloads the Minecraft client from Mojang (Mojang EULA). */
    acceptDownload: z.boolean().optional(),
    /** When disabling: also delete the stored map data (the server must be stopped). */
    deleteData: z.boolean().optional(),
  })
  .strict();

async function payload(server: ServerRow, restartRequired = false) {
  const status = await bluemapStatus(server, restartRequired);
  return { ...status, url: status.enabled ? `/api/servers/${server.id}/webui/${BLUEMAP_UI_ID}/` : null };
}

/** BlueMap web map for Java servers (SPEC "BlueMap (v0.4.0)"). */
export default async function bluemapRoutes(app: FastifyInstance): Promise<void> {
  app.get<IdParams>('/servers/:id/bluemap', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    return payload(server);
  });

  app.put<IdParams>('/servers/:id/bluemap', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(bodySchema, req.body);
    const running = runtime.isRunning(server.id);
    if (body.enabled) {
      const updated = await enableBluemap(server, body.acceptDownload === true);
      await audit(req, 'server.bluemap_enable', 'server', server.id, { schema: updated.bluemap?.schema });
      return payload(updated, running);
    }
    const updated = await disableBluemap(server, body.deleteData === true, running);
    await audit(req, 'server.bluemap_disable', 'server', server.id, { deleteData: body.deleteData === true });
    return payload(updated, running && !!server.bluemap?.enabled);
  });

  app.post<IdParams>('/servers/:id/bluemap/reset', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    await resetBluemapData(server, runtime.isRunning(server.id));
    await audit(req, 'server.bluemap_reset', 'server', server.id, {});
    return payload(server);
  });
}
