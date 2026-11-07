import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import * as cf from '../catalog/curseforge.js';
import * as hg from '../catalog/hangar.js';
import * as mr from '../catalog/modrinth.js';
import { loaderVersions, minecraftVersions } from '../catalog/versions.js';
import { intQuery, parse, serverTypeSchema } from '../lib/validation.js';

const sourceSchema = z.enum(['curseforge', 'modrinth', 'hangar']);

export default async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Record<string, string | undefined> }>('/catalog/search', async (req) => {
    requireUser(req);
    const q = req.query;
    const source = parse(sourceSchema, q.source ?? 'modrinth');
    const kind = parse(z.enum(['modpack', 'mod', 'plugin']), q.kind ?? 'mod');
    const opts = {
      q: (q.q ?? '').slice(0, 200),
      kind,
      mcVersion: q.mcVersion || undefined,
      loader: q.loader || undefined,
      offset: intQuery(q.offset, 0, 0, 9950),
      limit: intQuery(q.limit, 20, 1, 50),
    };
    return source === 'curseforge' ? cf.search(opts) : source === 'hangar' ? hg.search(opts) : mr.search(opts);
  });

  app.get<{ Params: { source: string; id: string } }>('/catalog/project/:source/:id', async (req) => {
    requireUser(req);
    const source = parse(sourceSchema, req.params.source);
    return source === 'curseforge'
      ? cf.getProject(req.params.id)
      : source === 'hangar'
        ? hg.getProject(req.params.id)
        : mr.getProject(req.params.id);
  });

  app.get<{ Params: { source: string; id: string }; Querystring: { mcVersion?: string; loader?: string } }>(
    '/catalog/project/:source/:id/versions',
    async (req) => {
      requireUser(req);
      const source = parse(sourceSchema, req.params.source);
      const { mcVersion, loader } = req.query;
      if (source === 'hangar') return hg.getVersions(req.params.id, mcVersion || undefined);
      return source === 'curseforge'
        ? cf.getVersions(req.params.id, mcVersion || undefined, loader || undefined)
        : mr.getVersions(req.params.id, mcVersion || undefined, loader || undefined);
    },
  );

  app.get<{ Querystring: { type?: string; snapshots?: string } }>('/catalog/minecraft/versions', async (req) => {
    requireUser(req);
    const type = parse(serverTypeSchema, (req.query.type ?? 'VANILLA').toUpperCase());
    const versions = await minecraftVersions(type, req.query.snapshots === 'true');
    return { type, versions, latest: versions[0] ?? null };
  });

  /** Loader/build versions for a type + MC version (extra; used by the create wizard). */
  app.get<{ Querystring: { type?: string; mcVersion?: string } }>('/catalog/minecraft/loaders', async (req) => {
    requireUser(req);
    const type = parse(serverTypeSchema, (req.query.type ?? '').toUpperCase());
    const mcVersion = parse(z.string().min(1).max(64), req.query.mcVersion);
    const versions = await loaderVersions(type, mcVersion);
    return { type, mcVersion, versions, latest: versions[0] ?? null };
  });
}
