import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { parse } from '../lib/validation.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import * as l4d2 from '../services/l4d2.js';

type IdParams = { Params: { id: string } };
type PluginParams = { Params: { id: string; pluginId: string } };

const mapBody = z
  .object({
    map: z.string().max(64).optional(),
    campaign: z.string().max(120).optional(),
    mode: z.string().max(20).optional(),
    persist: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.map !== undefined || b.campaign !== undefined, 'map or campaign is required');
const difficultyBody = z.object({ difficulty: z.string().max(20), persist: z.boolean().optional() }).strict();
const kickBody = z.object({ userId: z.number().int(), reason: z.string().max(200).optional() }).strict();
const giveBody = z.object({ userId: z.number().int(), item: z.string().max(40) }).strict();
const teamBody = z.object({ count: z.number().int() }).strict();
const spawnBody = z.object({ kind: z.string(), count: z.number().int().optional() }).strict();
const botBody = z.object({ character: z.number().int() }).strict();
const pluginBody = z.object({ settings: z.record(z.string().max(64), z.union([z.number(), z.boolean()])).optional() }).strict();
const settingsBody = z.object({ settings: z.record(z.string().max(64), z.union([z.number(), z.boolean()])) }).strict();

/** Left 4 Dead 2 tabs: Maps (campaigns from the game files), Controls (console actions) and Plugins (store). */
export default async function l4d2Routes(app: FastifyInstance): Promise<void> {
  // ---- Maps ----
  app.get<IdParams>('/servers/:id/l4d2/maps', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    return l4d2.mapsOverview(server);
  });

  // ---- Controls (operator) ----
  app.get<IdParams>('/servers/:id/l4d2/controls', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    return l4d2.controlsOverview(server);
  });

  app.post<IdParams>('/servers/:id/l4d2/controls/map', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(mapBody, req.body);
    const r = await l4d2.changeMap(server, body);
    await audit(req, 'server.l4d2_map', 'server', server.id, { ...r, persist: !!body.persist });
    return { ok: true, ...r };
  });

  app.post<IdParams>('/servers/:id/l4d2/controls/difficulty', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(difficultyBody, req.body);
    const r = await l4d2.changeDifficulty(server, body.difficulty, body.persist);
    await audit(req, 'server.l4d2_difficulty', 'server', server.id, { ...r, persist: !!body.persist });
    return { ok: true, ...r };
  });

  app.post<IdParams>('/servers/:id/l4d2/controls/kick', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(kickBody, req.body);
    await l4d2.kickPlayer(server, body.userId, body.reason);
    await audit(req, 'server.l4d2_kick', 'server', server.id, { userId: body.userId });
    return { ok: true };
  });

  app.post<IdParams>('/servers/:id/l4d2/controls/give', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(giveBody, req.body);
    await l4d2.givePlayer(server, body.userId, body.item);
    await audit(req, 'server.l4d2_give', 'server', server.id, { userId: body.userId, item: body.item });
    return { ok: true };
  });

  app.post<IdParams>('/servers/:id/l4d2/controls/team', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(teamBody, req.body);
    const r = await l4d2.setTeamSize(server, body.count);
    await audit(req, 'server.l4d2_team_size', 'server', server.id, r);
    return { ok: true, ...r };
  });

  app.post<IdParams>('/servers/:id/l4d2/controls/bots', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(botBody, req.body);
    const r = await l4d2.addBot(server, body.character);
    await audit(req, 'server.l4d2_add_bot', 'server', server.id, { character: body.character, ...r });
    return { ok: true, ...r };
  });

  app.post<IdParams>('/servers/:id/l4d2/controls/spawn', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const body = parse(spawnBody, req.body);
    const r = await l4d2.spawnThreat(server, body.kind, body.count ?? 1);
    await audit(req, 'server.l4d2_spawn', 'server', server.id, r);
    return { ok: true, ...r };
  });

  // ---- Plugins (manager) ----
  app.get<IdParams>('/servers/:id/l4d2/plugins', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    return l4d2.pluginsOverview(server);
  });

  app.post<PluginParams>('/servers/:id/l4d2/plugins/:pluginId/install', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(pluginBody, req.body ?? {});
    const r = await l4d2.installPlugin(server, req.params.pluginId, body.settings);
    await audit(req, 'server.l4d2_plugin_install', 'server', server.id, { plugin: req.params.pluginId, installed: r.installed });
    return { ok: true, ...r };
  });

  app.delete<PluginParams>('/servers/:id/l4d2/plugins/:pluginId', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const r = await l4d2.uninstallPlugin(server, req.params.pluginId);
    await audit(req, 'server.l4d2_plugin_remove', 'server', server.id, { plugin: req.params.pluginId });
    return { ok: true, ...r };
  });

  app.put<PluginParams>('/servers/:id/l4d2/plugins/:pluginId/settings', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(settingsBody, req.body);
    const r = await l4d2.updatePluginSettings(server, req.params.pluginId, body.settings);
    await audit(req, 'server.l4d2_plugin_settings', 'server', server.id, { plugin: req.params.pluginId });
    return { ok: true, ...r };
  });
}
