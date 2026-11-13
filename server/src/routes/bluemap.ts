import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { BLUEMAP_UI_ID } from '../lib/bluemap.js';
import { parse } from '../lib/validation.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import {
  bluemapStatus,
  createPublicLink,
  deletePublicLink,
  disableBluemap,
  enableBluemap,
  listPublicLinks,
  resetBluemapData,
  updatePublicLink,
  type PublicLink,
} from '../services/bluemap.js';
import {
  createMarker,
  createSet,
  deleteMarker,
  deleteSet,
  listMarkers,
  listSets,
  publicMarker,
  publicSet,
  updateMarker,
  updateSet,
  userActor,
} from '../services/bluemapMarkers.js';
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

const linkCreateSchema = z.object({ name: z.string().trim().min(1).max(60), canEdit: z.boolean().optional() }).strict();
const linkPatchSchema = z
  .object({ name: z.string().trim().min(1).max(60).optional(), canEdit: z.boolean().optional(), regenerate: z.boolean().optional() })
  .strict();
const mapQuery = z.object({ mapId: z.string().max(100).optional(), setId: z.string().max(40).optional() });

async function payload(server: ServerRow, _access: Access, restartRequired = false) {
  const status = await bluemapStatus(server, restartRequired);
  return { ...status, url: status.enabled ? `/api/servers/${server.id}/webui/${BLUEMAP_UI_ID}/` : null };
}

/** A link as the owner sees it: the URL is absolute when the administrator set the panel's public URL. */
async function linkPayload(l: PublicLink) {
  const base = await getPublicUrl().catch(() => '');
  const { path, ...rest } = l;
  return { ...rest, url: path ? `${base}${path}` : null };
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

  // ---- Public links (owner/admin): anyone with a link views the live map without signing in ----

  app.get<IdParams>('/servers/:id/bluemap/links', async (req) => {
    const { server } = await loadServerFor(requireUser(req), req.params.id, 'full');
    return { links: await Promise.all((await listPublicLinks(server.id)).map(linkPayload)) };
  });

  app.post<IdParams>('/servers/:id/bluemap/links', async (req, reply) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'full');
    const body = parse(linkCreateSchema, req.body);
    const link = await createPublicLink(server, { name: body.name, canEdit: body.canEdit === true }, user.id);
    await audit(req, 'server.bluemap_link_create', 'server', server.id, { link: link.id, name: link.name, canEdit: link.canEdit });
    return reply.code(201).send(await linkPayload(link));
  });

  app.patch<{ Params: { id: string; linkId: string } }>('/servers/:id/bluemap/links/:linkId', async (req) => {
    const { server } = await loadServerFor(requireUser(req), req.params.id, 'full');
    const body = parse(linkPatchSchema, req.body);
    const link = await updatePublicLink(server, req.params.linkId, body);
    await audit(req, 'server.bluemap_link_update', 'server', server.id, { link: link.id, ...body });
    return linkPayload(link);
  });

  app.delete<{ Params: { id: string; linkId: string } }>('/servers/:id/bluemap/links/:linkId', async (req, reply) => {
    const { server } = await loadServerFor(requireUser(req), req.params.id, 'full');
    await deletePublicLink(server, req.params.linkId);
    await audit(req, 'server.bluemap_link_delete', 'server', server.id, { link: req.params.linkId });
    return reply.code(204).send();
  });

  // ---- Markers (kept in the panel database, served to the web map; see lib/bluemapMarkers.ts) ----

  app.get<IdParams>('/servers/:id/bluemap/marker-sets', async (req) => {
    const { server } = await loadServerFor(requireUser(req), req.params.id, 'viewer');
    const q = parse(mapQuery, req.query);
    return { sets: (await listSets(server.id, q.mapId)).map(publicSet) };
  });

  app.post<IdParams>('/servers/:id/bluemap/marker-sets', async (req, reply) => {
    const { server } = await loadServerFor(requireUser(req), req.params.id, 'operator');
    const set = await createSet(server.id, req.body);
    await audit(req, 'server.bluemap_set_create', 'server', server.id, { set: set.id, label: set.label });
    return reply.code(201).send(publicSet(set));
  });

  app.patch<{ Params: { id: string; setId: string } }>('/servers/:id/bluemap/marker-sets/:setId', async (req) => {
    const { server } = await loadServerFor(requireUser(req), req.params.id, 'manager');
    const set = await updateSet(server.id, req.params.setId, req.body);
    await audit(req, 'server.bluemap_set_update', 'server', server.id, { set: set.id });
    return publicSet(set);
  });

  app.delete<{ Params: { id: string; setId: string } }>('/servers/:id/bluemap/marker-sets/:setId', async (req, reply) => {
    const { server } = await loadServerFor(requireUser(req), req.params.id, 'manager');
    await deleteSet(server.id, req.params.setId);
    await audit(req, 'server.bluemap_set_delete', 'server', server.id, { set: req.params.setId });
    return reply.code(204).send();
  });

  app.get<IdParams>('/servers/:id/bluemap/markers', async (req) => {
    const { server } = await loadServerFor(requireUser(req), req.params.id, 'viewer');
    const q = parse(mapQuery, req.query);
    const markers = (await listMarkers(server.id, q.mapId)).filter((m) => !q.setId || m.set_id === q.setId);
    return { markers: markers.map(publicMarker) };
  });

  app.post<IdParams>('/servers/:id/bluemap/markers', async (req, reply) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const marker = await createMarker(server.id, userActor(user.id), req.body);
    await audit(req, 'server.bluemap_marker_create', 'server', server.id, { marker: marker.id, type: marker.type, label: marker.label });
    return reply.code(201).send(publicMarker(marker));
  });

  app.patch<{ Params: { id: string; markerId: string } }>('/servers/:id/bluemap/markers/:markerId', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const marker = await updateMarker(server.id, userActor(user.id), req.params.markerId, req.body);
    await audit(req, 'server.bluemap_marker_update', 'server', server.id, { marker: marker.id });
    return publicMarker(marker);
  });

  app.delete<{ Params: { id: string; markerId: string } }>('/servers/:id/bluemap/markers/:markerId', async (req, reply) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    await deleteMarker(server.id, userActor(user.id), req.params.markerId);
    await audit(req, 'server.bluemap_marker_delete', 'server', server.id, { marker: req.params.markerId });
    return reply.code(204).send();
  });
}
