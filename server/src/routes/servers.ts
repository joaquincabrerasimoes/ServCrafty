import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { requireUser } from '../auth/plugin.js';
import * as cf from '../catalog/curseforge.js';
import * as mr from '../catalog/modrinth.js';
import { AppError, badRequest } from '../lib/errors.js';
import { copyDir } from '../lib/fsutil.js';
import { parseProperties, serializeProperties } from '../lib/properties.js';
import { intQuery, parse } from '../lib/validation.js';
import { loadServerFor, listServersFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import { serverDir } from '../services/docker.js';
import { exportServer, importArchive, importFieldsSchema, type ExportFormat } from '../services/modpack.js';
import { listKinds, playerAction, playerActions, readList, type ListKind, type PlayerAction } from '../services/players.js';
import * as runtime from '../services/runtime.js';
import { unregisterServer } from '../services/scheduler.js';
import {
  configOf,
  createServer,
  createServerSchema,
  deleteServer,
  updateServer,
  updateServerSchema,
  type CreateServerInput,
} from '../services/servers.js';
import { createTemplate } from '../services/templates.js';
import { toPublicServer, type ModpackRef } from '../services/types.js';
import { getUser } from '../services/users.js';

type IdParams = { Params: { id: string } };

/** Fill in slug / loader of a catalog modpack reference (best effort). */
async function enrichModpack(type: string, mp: ModpackRef | null | undefined): Promise<ModpackRef | null | undefined> {
  if (!mp || mp.source === 'file' || mp.projectId === undefined) return mp;
  const out: ModpackRef = { ...mp };
  try {
    if (type === 'CURSEFORGE' && mp.source === 'curseforge') {
      const mod = await cf.getMod(String(mp.projectId));
      out.slug ??= mod.slug;
      out.name ??= mod.name;
      if (mp.fileId && !out.loader) {
        const f = await cf.getFile(mod.id, String(mp.fileId));
        out.versionName ??= f.displayName;
        out.loader = f.gameVersions.map((g) => g.toLowerCase()).find((g) => ['forge', 'neoforge', 'fabric', 'quilt'].includes(g));
      }
    } else if (type === 'MODRINTH' && mp.source === 'modrinth') {
      const p = await mr.getProject(String(mp.projectId));
      out.slug ??= p.slug;
      out.name ??= p.name;
      const versionId = mp.versionId ?? (mp.fileId !== undefined ? String(mp.fileId) : undefined);
      if (versionId) {
        out.versionId = versionId;
        const v = await mr.getVersion(versionId);
        out.loader ??= v.loaders[0];
        out.versionName ??= v.version_number;
      }
    }
  } catch (err) {
    if (err instanceof AppError && err.code === 'curseforge_key_missing') throw err;
    // Upstream lookup failures should not block creation; itzg resolves the pack itself.
  }
  return out;
}

const RESTART_FIELDS = ['type', 'mcVersion', 'loaderVersion', 'modpack', 'javaArgs', 'memoryMb', 'cpu', 'port', 'env'] as const;

export default async function serverRoutes(app: FastifyInstance): Promise<void> {
  app.get('/servers', async (req) => {
    const user = requireUser(req);
    const rows = await listServersFor(user);
    return rows.map((r) => ({ ...toPublicServer(r.server, r.access, r.ownerName), status: runtime.getStatus(r.server.id) }));
  });

  app.post('/servers', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(createServerSchema, req.body) as CreateServerInput;
    body.modpack = await enrichModpack(body.type, body.modpack);
    const server = await createServer(user, body);
    await audit(req, 'server.created', 'server', server.id, { name: server.name, type: server.type, port: server.port });
    reply.code(201);
    const owner = await getUser(server.owner_id);
    return toPublicServer(server, server.owner_id === user.id ? 'owner' : 'admin', owner.username);
  });

  app.get<IdParams>('/servers/:id', async (req) => {
    const user = requireUser(req);
    const { server, access } = await loadServerFor(user, req.params.id, 'viewer');
    const owner = await getUser(server.owner_id).catch(() => null);
    return { ...toPublicServer(server, access, owner?.username ?? null), status: runtime.getStatus(server.id) };
  });

  app.patch<IdParams>('/servers/:id', async (req) => {
    const user = requireUser(req);
    const { server, access } = await loadServerFor(user, req.params.id, 'manager');
    const patch = parse(updateServerSchema, req.body);
    if (patch.modpack) patch.modpack = (await enrichModpack(patch.type ?? server.type, patch.modpack)) ?? null;
    const updated = await updateServer(user, server, patch);
    const restartRequired = runtime.isRunning(server.id) && RESTART_FIELDS.some((f) => patch[f] !== undefined);
    await audit(req, 'server.updated', 'server', server.id, {
      fields: Object.keys(patch),
      ...(patch.lanAnnounce !== undefined ? { lanAnnounce: patch.lanAnnounce } : {}),
    });
    const owner = await getUser(updated.owner_id).catch(() => null);
    return { ...toPublicServer(updated, access, owner?.username ?? null), status: runtime.getStatus(server.id), restartRequired };
  });

  app.delete<IdParams>('/servers/:id', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'full');
    await unregisterServer(server.id);
    await deleteServer(server);
    await audit(req, 'server.deleted', 'server', server.id, { name: server.name });
    return { ok: true };
  });

  app.post<IdParams>('/servers/:id/power', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const { action } = parse(z.object({ action: z.enum(['start', 'stop', 'restart', 'kill']) }), req.body);
    if (action === 'start' || action === 'restart') {
      // Start can take minutes (image pulls); run in background, report via status events.
      void runtime.power(server.id, action).catch((err: unknown) => req.log.warn({ err, serverId: server.id }, `${action} failed`));
      await new Promise((r) => setTimeout(r, 150));
    } else {
      await runtime.power(server.id, action);
    }
    await audit(req, `server.power.${action}`, 'server', server.id);
    return { ok: true, status: runtime.getStatus(server.id) };
  });

  app.post<IdParams>('/servers/:id/command', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const { command } = parse(z.object({ command: z.string().min(1).max(1000) }), req.body);
    const output = await runtime.sendCommand(server.id, command);
    await audit(req, 'server.command', 'server', server.id, { command });
    return { output };
  });

  app.get<IdParams & { Querystring: { tail?: string } }>('/servers/:id/logs', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    return { lines: await runtime.getLogs(server, intQuery(req.query.tail, 500, 1, 5000)) };
  });

  app.get<IdParams>('/servers/:id/stats', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    return runtime.getStats(server);
  });

  app.get<IdParams>('/servers/:id/players', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    const stats = await runtime.getStats(server);
    return { online: stats.players.online, max: stats.players.max, list: stats.players.list };
  });

  app.post<{ Params: { id: string; name: string; action: string } }>('/servers/:id/players/:name/:action', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'operator');
    const action = parse(z.enum(playerActions), req.params.action) as PlayerAction;
    const body = parse(z.object({ reason: z.string().max(200).optional() }).optional(), req.body ?? {});
    const result = await playerAction(server, action, req.params.name, body?.reason);
    await audit(req, `server.player.${action}`, 'server', server.id, { player: req.params.name });
    return result;
  });

  app.get<{ Params: { id: string; kind: string } }>('/servers/:id/lists/:kind', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    const kind = parse(z.enum(listKinds), req.params.kind) as ListKind;
    return readList(server, kind);
  });

  // ---- server.properties ----
  app.get<IdParams>('/servers/:id/properties', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'viewer');
    try {
      return parseProperties(await fsp.readFile(path.join(serverDir(server.id), 'server.properties'), 'utf8'));
    } catch {
      return {};
    }
  });

  app.put<IdParams>('/servers/:id/properties', async (req) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const raw = parse(z.record(z.union([z.string(), z.number(), z.boolean()])), req.body);
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!/^[A-Za-z0-9_.\-]+$/.test(k)) throw badRequest(`Invalid property name "${k}"`, 'invalid_property');
      values[k] = String(v);
    }
    const file = path.join(serverDir(server.id), 'server.properties');
    const prev = await fsp.readFile(file, 'utf8').catch(() => undefined);
    await fsp.mkdir(serverDir(server.id), { recursive: true });
    await fsp.writeFile(file, serializeProperties(values, prev));
    await audit(req, 'server.properties_updated', 'server', server.id, { keys: Object.keys(values).length });
    return { properties: values, restartRequired: runtime.isRunning(server.id) };
  });

  // ---- clone / template ----
  app.post<IdParams>('/servers/:id/clone', async (req, reply) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(64), copyFiles: z.boolean().default(true), port: z.number().int().optional() }),
      req.body,
    );
    if (body.copyFiles && runtime.getStatus(server.id) === 'running') {
      await runtime.tryRcon(server.id, 'save-all flush');
      await new Promise((r) => setTimeout(r, 1500));
    }
    const clone = await createServer(user, { ...configOf(server), name: body.name, port: body.port }, async (dir) => {
      if (body.copyFiles) {
        await copyDir(serverDir(server.id), dir);
        await fsp.rm(path.join(dir, 'logs'), { recursive: true, force: true });
        for (const lock of ['world/session.lock']) await fsp.rm(path.join(dir, lock), { force: true });
      }
    });
    await audit(req, 'server.cloned', 'server', clone.id, { from: server.id });
    reply.code(201);
    return toPublicServer(clone, clone.owner_id === user.id ? 'owner' : 'admin', user.username);
  });

  app.post<IdParams>('/servers/:id/template', async (req, reply) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(64),
        description: z.string().max(1000).nullable().optional(),
        shared: z.boolean().default(false),
        includeProperties: z.boolean().default(true),
      }),
      req.body,
    );
    const cfg: Record<string, unknown> = { ...configOf(server) };
    if (body.includeProperties) {
      try {
        const props = parseProperties(await fsp.readFile(path.join(serverDir(server.id), 'server.properties'), 'utf8'));
        for (const k of ['server-port', 'rcon.password', 'rcon.port', 'enable-rcon', 'level-seed', 'server-ip']) delete props[k];
        cfg.properties = props;
        // The saved properties already reflect the initial config (and any later edits); a
        // server.properties seeded from the template means it would never be applied anyway.
        if (Object.keys(props).length) delete cfg.minecraft;
      } catch {
        /* none */
      }
    }
    if (server.modpack?.localFile) delete (cfg.modpack as Record<string, unknown> | undefined)?.localFile;
    const t = await createTemplate(user, body.name, body.description ?? null, cfg, body.shared);
    await audit(req, 'template.created', 'template', t.id, { from: server.id });
    reply.code(201);
    return t;
  });

  // ---- export / import ----
  app.get<IdParams & { Querystring: { format?: string; includeWorld?: string } }>('/servers/:id/export', async (req, reply) => {
    const user = requireUser(req);
    const { server } = await loadServerFor(user, req.params.id, 'manager');
    const format = parse(z.enum(['curseforge', 'modrinth', 'serverpack']), req.query.format ?? 'serverpack') as ExportFormat;
    const stats = await runtime.getStats(server).catch(() => null);
    const out = await exportServer(server, format, {
      includeWorld: req.query.includeWorld === 'true' || req.query.includeWorld === '1',
      detectedVersion: stats?.version ?? null,
    });
    await audit(req, 'server.exported', 'server', server.id, { format });
    reply
      .header('Content-Type', format === 'modrinth' ? 'application/x-modrinth-modpack+zip' : 'application/zip')
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(out.filename)}"`);
    if (out.warnings.length) reply.header('X-ServCrafty-Warnings', encodeURIComponent(out.warnings.join(' | ')));
    return reply.send(out.stream);
  });

  app.post('/servers/import', async (req, reply) => {
    const user = requireUser(req);
    if (!req.isMultipart()) throw badRequest('Expected multipart/form-data', 'multipart_required');
    const tmpDir = config().tmpDir;
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `import-${crypto.randomBytes(8).toString('hex')}.zip`);
    const fields: Record<string, string> = {};
    let originalName: string | null = null;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (originalName) {
            part.file.resume();
            continue;
          }
          originalName = part.filename || 'import.zip';
          await pipeline(part.file, fs.createWriteStream(tmp));
          if (part.file.truncated) throw new AppError(413, 'file_too_large', 'Upload exceeds the size limit');
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
      if (!originalName) throw badRequest('No file uploaded', 'file_required');
      const f = parse(importFieldsSchema, fields);
      const { server, detected, warnings } = await importArchive(user, tmp, originalName, f);
      await audit(req, 'server.imported', 'server', server.id, { detected, file: originalName });
      reply.code(201);
      return { server: toPublicServer(server, server.owner_id === user.id ? 'owner' : 'admin', user.username), detected, warnings };
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
  });
}
