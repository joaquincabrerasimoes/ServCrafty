import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validation.js';
import { loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import * as files from '../services/files.js';

type Q = { Params: { id: string }; Querystring: { path?: string } };

export default async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.get<Q>('/servers/:id/files', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    return files.listDir(server, req.query.path ?? '');
  });

  app.get<Q>('/servers/:id/files/content', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    if (!req.query.path) throw badRequest('path is required');
    return files.readText(server, req.query.path);
  });

  app.put<Q>('/servers/:id/files/content', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(z.object({ path: z.string().min(1).max(4096), content: z.string() }), req.body);
    await files.writeText(server, body.path, body.content);
    await audit(req, 'server.file_written', 'server', server.id, { path: body.path });
    return { ok: true };
  });

  app.post<Q>('/servers/:id/files/upload', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    if (!req.isMultipart()) throw badRequest('Expected multipart/form-data', 'multipart_required');
    const dir = req.query.path ?? '';
    const saved: string[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      saved.push(await files.saveUpload(server, dir, part.filename, part.file));
    }
    if (!saved.length) throw badRequest('No file uploaded', 'file_required');
    await audit(req, 'server.file_uploaded', 'server', server.id, { files: saved });
    return { files: saved };
  });

  app.get<Q>('/servers/:id/files/download', async (req, reply) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    if (!req.query.path) throw badRequest('path is required');
    const f = await files.openDownload(server, req.query.path);
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(f.size))
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(f.stream);
  });

  app.post<Q>('/servers/:id/files/mkdir', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(z.object({ path: z.string().min(1).max(4096) }), req.body);
    await files.makeDir(server, body.path);
    await audit(req, 'server.file_mkdir', 'server', server.id, { path: body.path });
    return { ok: true };
  });

  app.post<Q>('/servers/:id/files/rename', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(z.object({ from: z.string().min(1).max(4096), to: z.string().min(1).max(4096) }), req.body);
    await files.rename(server, body.from, body.to);
    await audit(req, 'server.file_renamed', 'server', server.id, body);
    return { ok: true };
  });

  app.delete<Q>('/servers/:id/files', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    if (!req.query.path) throw badRequest('path is required');
    await files.remove(server, req.query.path);
    await audit(req, 'server.file_deleted', 'server', server.id, { path: req.query.path });
    return { ok: true };
  });
}
