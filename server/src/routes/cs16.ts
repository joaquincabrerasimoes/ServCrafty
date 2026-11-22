import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import * as gb from '../lib/cs16/gamebanana.js';
import { parse } from '../lib/validation.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import * as cs16 from '../services/cs16.js';

type IdParams = { Params: { id: string } };
type PluginParams = { Params: { id: string; pluginId: string } };
type MapParams = { Params: { id: string; name: string } };
type CatalogParams = { Params: { id: string; mapId: string } };

const mapBody = z.object({ map: z.string().max(64), persist: z.boolean().optional() }).strict();
const kickBody = z.object({ userId: z.number().int(), reason: z.string().max(200).optional() }).strict();
const banBody = z.object({ userId: z.number().int(), minutes: z.number().int() }).strict();
const restartBody = z.object({ kind: z.string().max(10) }).strict();
const sayBody = z.object({ message: z.string().max(200) }).strict();
const settingsBody = z.object({ settings: z.record(z.string().max(64), z.union([z.number(), z.boolean()])) }).strict();
const rotationBody = z.object({ maps: z.array(z.string().max(64)).max(500) }).strict();
const botBody = z.object({ action: z.string().max(20), team: z.string().max(4).optional(), count: z.number().int().optional(), mode: z.string().max(10).optional(), level: z.string().max(10).optional(), on: z.boolean().optional() }).strict();
const searchQuery = z
  .object({
    q: z.string().max(80).optional(),
    page: z.coerce.number().int().min(1).max(1000).optional(),
    sort: z.enum(['popular', 'liked', 'viewed', 'newest', 'updated']).optional(),
    category: z.coerce.number().int().min(1).max(1e9).optional(),
  })
  .strict();
const installBody = z.object({ fileId: z.number().int().optional() }).strict();

/** Counter-Strike 1.6 tabs: Maps (installed maps, rotation, GameBanana catalogue), Controls (console actions) and Plugins (store). */
export default async function cs16Routes(app: FastifyInstance): Promise<void> {
  // ---- Maps ----
  app.get<IdParams>('/servers/:id/cs16/maps', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    return cs16.mapsOverview(server);
  });

  app.put<IdParams>('/servers/:id/cs16/mapcycle', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(rotationBody, req.body);
    const r = await cs16.setRotation(server, body.maps);
    await audit(req, 'server.cs16_rotation', 'server', server.id, { maps: r.maps.length });
    return { ok: true, ...r };
  });

  app.delete<MapParams>('/servers/:id/cs16/maps/:name', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const r = await cs16.removeMap(server, req.params.name);
    await audit(req, 'server.cs16_map_remove', 'server', server.id, r);
    return { ok: true, ...r };
  });

  // ---- Map catalogue (GameBanana) ----
  app.get<IdParams>('/servers/:id/cs16/catalog/maps', async (req) => {
    const user = requireUser(req);
    await loadServerFor(user, req.params.id, 'operator');
    const q = parse(searchQuery, req.query ?? {});
    const [page, categories] = await Promise.all([gb.searchMaps(q), gb.mapCategories().catch(() => [])]);
    return { ...page, categories };
  });

  app.get<CatalogParams>('/servers/:id/cs16/catalog/maps/:mapId', async (req) => {
    const user = requireUser(req);
    await loadServerFor(user, req.params.id, 'operator');
    return gb.getMap(gb.assertGbId(Number(req.params.mapId)));
  });

  app.post<CatalogParams>('/servers/:id/cs16/catalog/maps/:mapId/install', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(installBody, req.body ?? {});
    const gbId = gb.assertGbId(Number(req.params.mapId));
    const r = await cs16.installCatalogMap(server, gbId, body.fileId);
    await audit(req, 'server.cs16_map_install', 'server', server.id, { gamebanana: gbId, maps: r.maps });
    return { ok: true, ...r };
  });

  // ---- Controls (operator) ----
  app.get<IdParams>('/servers/:id/cs16/controls', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    return cs16.controlsOverview(server);
  });

  app.post<IdParams>('/servers/:id/cs16/controls/map', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(mapBody, req.body);
    const r = await cs16.changeMap(server, body);
    await audit(req, 'server.cs16_change_map', 'server', server.id, { map: r.map, persist: !!body.persist });
    return { ok: true, ...r };
  });

  app.post<IdParams>('/servers/:id/cs16/controls/restart', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(restartBody, req.body);
    await cs16.restartMatch(server, body.kind);
    await audit(req, 'server.cs16_restart', 'server', server.id, { kind: body.kind });
    return { ok: true };
  });

  app.post<IdParams>('/servers/:id/cs16/controls/say', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(sayBody, req.body);
    await cs16.say(server, body.message);
    await audit(req, 'server.cs16_say', 'server', server.id, {});
    return { ok: true };
  });

  app.post<IdParams>('/servers/:id/cs16/controls/kick', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(kickBody, req.body);
    await cs16.kickPlayer(server, body.userId, body.reason);
    await audit(req, 'server.cs16_kick', 'server', server.id, { userId: body.userId });
    return { ok: true };
  });

  app.post<IdParams>('/servers/:id/cs16/controls/ban', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(banBody, req.body);
    await cs16.banPlayer(server, body.userId, body.minutes);
    await audit(req, 'server.cs16_ban', 'server', server.id, { userId: body.userId, minutes: body.minutes });
    return { ok: true };
  });

  app.post<IdParams>('/servers/:id/cs16/controls/bots', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(botBody, req.body);
    const r = await cs16.botAction(server, body);
    await audit(req, 'server.cs16_bots', 'server', server.id, { action: body.action });
    return { ok: true, ...r };
  });

  app.put<IdParams>('/servers/:id/cs16/controls/settings', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(settingsBody, req.body);
    const r = await cs16.applySettings(server, body.settings);
    await audit(req, 'server.cs16_settings', 'server', server.id, { keys: Object.keys(r.settings) });
    return { ok: true, ...r };
  });

  // ---- Plugins (manager) ----
  app.get<IdParams>('/servers/:id/cs16/plugins', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    return cs16.pluginsOverview(server);
  });

  app.post<PluginParams>('/servers/:id/cs16/plugins/:pluginId/install', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const r = await cs16.installPlugin(server, req.params.pluginId);
    await audit(req, 'server.cs16_plugin_install', 'server', server.id, { plugin: req.params.pluginId, installed: r.installed });
    return { ok: true, ...r };
  });

  app.delete<PluginParams>('/servers/:id/cs16/plugins/:pluginId', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const r = await cs16.uninstallPlugin(server, req.params.pluginId);
    await audit(req, 'server.cs16_plugin_remove', 'server', server.id, { plugin: req.params.pluginId });
    return { ok: true, ...r };
  });
}
