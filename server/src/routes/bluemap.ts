import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { BLUEMAP_UI_ID } from '../lib/bluemap.js';
import { parse } from '../lib/validation.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import { bluemapStatus, disableBluemap, enableBluemap, publicPathFor, publicTokenOf, resetBluemapData, setPublicLink } from '../services/bluemap.js';
import * as runtime from '../services/runtime.js';
import { getPublicUrl } from '../services/settings.js';
import type { Access, ServerRow } from '../services/types.js';

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

const publicBodySchema = z.object({ enabled: z.boolean(), regenerate: z.boolean().optional() }).strict();

async function payload(server: ServerRow, access: Access, restartRequired = false) {
  const status = await bluemapStatus(server, restartRequired);
  // The public URL is a secret: only the owner (and admins) get it.
  const token = status.publicEnabled && (access === 'owner' || access === 'admin') ? publicTokenOf(server) : null;
  return {
    ...status,
    url: status.enabled ? `/api/servers/${server.id}/webui/${BLUEMAP_UI_ID}/` : null,
    // Absolute when the administrator set the panel's public URL, otherwise a path for the browser to resolve.
    publicUrl: token ? `${await getPublicUrl().catch(() => '')}${publicPathFor(server.id, token)}` : null,
  };
}

/** BlueMap web map for Java servers (SPEC "BlueMap (v0.4.0)"). */
export default async function bluemapRoutes(app: FastifyInstance): Promise<void> {
  app.get<IdParams>('/servers/:id/bluemap', async (req) => {
    const user = requireUser(req);
    const { server, access } = await loadServerFor(user, req.params.id, 'viewer');
    return payload(server, access);
  });

  app.put<IdParams>('/servers/:id/bluemap', async (req) => {
    const user = requireUser(req);
    const { server, access } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(bodySchema, req.body);
    const running = runtime.isRunning(server.id);
    if (body.enabled) {
      const updated = await enableBluemap(server, body.acceptDownload === true);
      await audit(req, 'server.bluemap_enable', 'server', server.id, { schema: updated.bluemap?.schema });
      return payload(updated, access, running);
    }
    const updated = await disableBluemap(server, body.deleteData === true, running);
    await audit(req, 'server.bluemap_disable', 'server', server.id, { deleteData: body.deleteData === true });
    return payload(updated, access, running && !!server.bluemap?.enabled);
  });

  app.post<IdParams>('/servers/:id/bluemap/reset', async (req) => {
    const user = requireUser(req);
    const { server, access } = await loadServerFor(user, req.params.id, 'manager');
    await resetBluemapData(server, runtime.isRunning(server.id));
    await audit(req, 'server.bluemap_reset', 'server', server.id, {});
    return payload(server, access);
  });

  /** Public link: anyone with the URL views the live map without signing in. Owner (or admin) only. */
  app.put<IdParams>('/servers/:id/bluemap/public', async (req) => {
    const user = requireUser(req);
    const { server, access } = await loadServerFor(user, req.params.id, 'full');
    const body = parse(publicBodySchema, req.body);
    const mode = !body.enabled ? 'disable' : body.regenerate ? 'regenerate' : 'enable';
    const updated = await setPublicLink(server, mode);
    await audit(req, `server.bluemap_public_${mode}`, 'server', server.id, {});
    return payload(updated, access);
  });
}
