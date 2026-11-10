import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { assertSteam } from '../lib/games.js';
import { dedupeWorkshop, generateVar, MAX_WORKSHOP_ITEMS, type SteamWorkshopItem } from '../lib/steamPlan.js';
import { getWorkshopItem, parseWorkshopRef, searchWorkshop, WORKSHOP_SORTS, type WorkshopSort } from '../lib/steamWorkshop.js';
import { intQuery, parse } from '../lib/validation.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import { requireDefinition } from '../services/gameDefinitions.js';
import * as runtime from '../services/runtime.js';
import { updateSteamConfig } from '../services/servers.js';
import { getSteamApiKey } from '../services/settings.js';
import type { ServerRow } from '../services/types.js';

type IdParams = { Params: { id: string } };

function workshopDefOf(server: ServerRow) {
  assertSteam(server, 'The Steam Workshop');
  const def = requireDefinition(server.steam!.gameId);
  if (!def.workshop) throw badRequest('This game has no Steam Workshop support', 'workshop_unsupported');
  return { def, workshop: def.workshop };
}

/** SteamCMD server actions and the Steam Workshop (SPEC "SteamCMD games"). */
export default async function steamRoutes(app: FastifyInstance): Promise<void> {
  // "Update/verify game files": validate on the next start, restarting now if the server runs.
  app.post<IdParams>('/servers/:id/steam/update', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    assertSteam(server, 'Game file updates');
    await updateSteamConfig(server.id, (cur) => ({ ...cur, validateNext: true }));
    const restarting = runtime.isRunning(server.id);
    if (restarting) {
      void runtime.restart(server.id).catch((err: unknown) => req.log.warn({ err, serverId: server.id }, 'steam update restart failed'));
      await new Promise((r) => setTimeout(r, 150));
    }
    await audit(req, 'server.steam_update', 'server', server.id, { restarting });
    return { ok: true, restarting, status: runtime.getStatus(server.id) };
  });

  // New value for a generated secret (applied on the next start). Returned once to the caller.
  app.post<IdParams>('/servers/:id/steam/regenerate', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    assertSteam(server, 'Generated settings');
    const { key } = parse(z.object({ key: z.string().min(1).max(64) }).strict(), req.body);
    const def = requireDefinition(server.steam!.gameId);
    const v = def.variables.find((x) => x.key === key);
    if (!v?.generate) throw badRequest(`"${key}" is not a generated setting`, 'not_generated');
    const value = generateVar(v);
    await updateSteamConfig(server.id, (cur) => ({ ...cur, vars: { ...cur.vars, [key]: value } }));
    await audit(req, 'server.steam_regenerate', 'server', server.id, { key });
    return { key, value, restartRequired: runtime.isRunning(server.id) };
  });

  // ---- Workshop catalogue ----
  app.get<{ Querystring: { gameId?: string; q?: string; page?: string; sort?: string } }>('/workshop/search', async (req) => {
    requireUser(req);
    const def = requireDefinition(String(req.query.gameId ?? ''));
    if (!def.workshop) throw badRequest('This game has no Steam Workshop support', 'workshop_unsupported');
    const key = await getSteamApiKey();
    if (!key) throw badRequest('Workshop search needs a Steam Web API key (Admin > Settings)', 'steam_key_missing');
    const sort = parse(z.enum(WORKSHOP_SORTS).default('relevance'), req.query.sort || undefined) as WorkshopSort;
    const q = String(req.query.q ?? '').slice(0, 200);
    return searchWorkshop(key, def.workshop.appId, q, intQuery(req.query.page, 1, 1, 500), sort);
  });

  app.get<{ Params: { id: string }; Querystring: { gameId?: string } }>('/workshop/items/:id', async (req) => {
    requireUser(req);
    const id = parseWorkshopRef(decodeURIComponent(req.params.id));
    if (!id) throw badRequest('Enter a Workshop item id or a steamcommunity.com Workshop URL', 'invalid_workshop_id');
    const item = await getWorkshopItem(id);
    const def = req.query.gameId ? requireDefinition(req.query.gameId) : null;
    return { ...item, matchesGame: def?.workshop ? item.appId === def.workshop.appId : null };
  });

  // ---- Per-server Workshop list ----
  app.get<IdParams>('/servers/:id/workshop', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    workshopDefOf(server);
    return server.steam?.workshop ?? [];
  });

  app.post<IdParams>('/servers/:id/workshop', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const { workshop } = workshopDefOf(server);
    const body = parse(
      z
        .object({ id: z.union([z.string().max(40), z.number().int().positive()]).optional(), url: z.string().max(2000).optional() })
        .strict()
        .refine((b) => b.id !== undefined || b.url !== undefined, 'id or url is required'),
      req.body,
    );
    const id = parseWorkshopRef(String(body.id ?? body.url));
    if (!id) throw badRequest('Enter a Workshop item id or a steamcommunity.com Workshop URL', 'invalid_workshop_id');
    const item = await getWorkshopItem(id);
    if (item.appId !== workshop.appId) {
      throw new AppError(400, 'workshop_wrong_game', `Workshop item ${id} belongs to another game (app ${item.appId ?? 'unknown'})`);
    }
    const row = await updateSteamConfig(server.id, (cur) => {
      const list = cur.workshop ?? [];
      if (list.some((w) => w.id === id)) return cur;
      if (list.length >= MAX_WORKSHOP_ITEMS) throw conflict(`At most ${MAX_WORKSHOP_ITEMS} Workshop items per server`, 'workshop_limit');
      const next: SteamWorkshopItem[] = dedupeWorkshop([...list, { id, title: item.title }]);
      return { ...cur, workshop: next };
    });
    await audit(req, 'server.workshop_add', 'server', server.id, { item: id });
    return { workshop: row.steam?.workshop ?? [], item, restartRequired: runtime.isRunning(server.id) };
  });

  app.delete<{ Params: { id: string; itemId: string } }>('/servers/:id/workshop/:itemId', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    workshopDefOf(server);
    const itemId = req.params.itemId;
    if (!(server.steam?.workshop ?? []).some((w) => w.id === itemId)) throw notFound('Workshop item not on this server', 'workshop_item_not_found');
    const row = await updateSteamConfig(server.id, (cur) => ({ ...cur, workshop: (cur.workshop ?? []).filter((w) => w.id !== itemId) }));
    await audit(req, 'server.workshop_remove', 'server', server.id, { item: itemId });
    return { workshop: row.steam?.workshop ?? [], restartRequired: runtime.isRunning(server.id) };
  });

  app.post<IdParams>('/servers/:id/workshop/refresh', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    workshopDefOf(server);
    await updateSteamConfig(server.id, (cur) => ({ ...cur, workshopRefresh: true }));
    await audit(req, 'server.workshop_refresh', 'server', server.id);
    return { ok: true, restartRequired: runtime.isRunning(server.id) };
  });
}
