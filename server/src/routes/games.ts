import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { validateDefinition } from '../lib/gameDefinition.js';
import { steamGameKey } from '../lib/games.js';
import { forgetGameKey, getDisabledGames } from '../services/gameAccess.js';
import { parse } from '../lib/validation.js';
import { audit } from '../services/audit.js';
import {
  createCustomDefinition,
  definitionDetail,
  definitionSummary,
  deleteCustomDefinition,
  getEntryOr404,
  invalidDefinition,
  listEntries,
  requireAuthor,
  updateCustomDefinition,
} from '../services/gameDefinitions.js';

type IdParams = { Params: { id: string } };

/** Game definitions (SPEC "SteamCMD games"): listing for everyone, authoring for admins and granted users. */
export default async function gameRoutes(app: FastifyInstance): Promise<void> {
  app.get('/games', async (req) => {
    requireUser(req);
    const disabled = await getDisabledGames();
    return listEntries().map((e) => {
      const key = steamGameKey(e.definition.id);
      return { ...definitionSummary(e), key, disabled: !!disabled[key], blockStart: disabled[key]?.blockStart === true };
    });
  });

  app.get<IdParams>('/games/:id', async (req) => {
    const user = requireUser(req);
    requireAuthor(user);
    return definitionDetail(getEntryOr404(req.params.id));
  });

  app.post('/games/validate', async (req) => {
    const user = requireUser(req);
    requireAuthor(user);
    const { definition } = parse(z.object({ definition: z.unknown() }).strict(), req.body);
    const r = validateDefinition(definition);
    if (!r.ok) throw invalidDefinition(r.errors);
    return { ok: true };
  });

  app.post('/games', async (req, reply) => {
    const user = requireUser(req);
    const e = await createCustomDefinition(user, req.body);
    await audit(req, 'game.create', 'game', e.definition.id, { name: e.definition.name });
    reply.code(201);
    return definitionDetail(e);
  });

  app.put<IdParams>('/games/:id', async (req) => {
    const user = requireUser(req);
    const e = await updateCustomDefinition(user, req.params.id, req.body);
    await audit(req, 'game.update', 'game', e.definition.id, { name: e.definition.name });
    return definitionDetail(e);
  });

  app.delete<IdParams>('/games/:id', async (req) => {
    const user = requireUser(req);
    const e = await deleteCustomDefinition(user, req.params.id);
    // Grants and the disabled flag of a deleted definition are forgotten (a new definition may reuse the id).
    await forgetGameKey(steamGameKey(e.definition.id));
    await audit(req, 'game.delete', 'game', e.definition.id, { name: e.definition.name });
    return { ok: true };
  });
}
