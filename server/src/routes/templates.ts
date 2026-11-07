import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { idParam, parse } from '../lib/validation.js';
import { audit } from '../services/audit.js';
import {
  createTemplate,
  deleteTemplate,
  getTemplateFor,
  instantiateSchema,
  instantiateTemplate,
  listTemplates,
  templateConfigSchema,
} from '../services/templates.js';
import { toPublicServer } from '../services/types.js';

export default async function templateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/templates', async (req) => listTemplates(requireUser(req)));

  /** Create a template from a raw config (extra; templates are usually saved from a server). */
  app.post('/templates', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(64),
        description: z.string().max(1000).nullable().optional(),
        shared: z.boolean().default(false),
        config: templateConfigSchema,
      }),
      req.body,
    );
    const t = await createTemplate(user, body.name, body.description ?? null, body.config, body.shared);
    await audit(req, 'template.created', 'template', t.id);
    reply.code(201);
    return t;
  });

  app.post('/templates/:id/instantiate', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const t = await getTemplateFor(user, id);
    const body = parse(instantiateSchema, req.body);
    const server = await instantiateTemplate(user, t, body);
    await audit(req, 'server.created', 'server', server.id, { fromTemplate: t.id, name: server.name });
    reply.code(201);
    return toPublicServer(server, server.owner_id === user.id ? 'owner' : 'admin', null);
  });

  app.delete('/templates/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    await deleteTemplate(user, id);
    await audit(req, 'template.deleted', 'template', id);
    return { ok: true };
  });
}
