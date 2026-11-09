import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth/plugin.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { intQuery, parse } from '../lib/validation.js';
import { audit } from '../services/audit.js';
import { updater } from '../services/updater.js';

/** Forced checks hit the GitHub API (60 req/h anonymous): at most 6 per 10 minutes per admin. */
const checkLimiter = new RateLimiter(6, 10 * 60_000);

/** Self-update endpoints (SPEC "Self-update feature (v0.2)"); admin only. */
export default async function updateRoutes(app: FastifyInstance): Promise<void> {
  const svc = updater();
  // Capture the running commit before an update can move HEAD.
  void svc.init().catch((err: unknown) => app.log.warn({ err }, 'updater init failed'));

  app.get('/admin/update', async (req) => {
    requireAdmin(req);
    return svc.payload();
  });

  app.post('/admin/update/check', async (req) => {
    const user = requireAdmin(req);
    checkLimiter.hit(user.id);
    const payload = await svc.payload({ force: true });
    await audit(req, 'update.check', 'system', null, {
      currentVersion: payload.currentVersion,
      latest: payload.latest?.version ?? null,
      updateAvailable: payload.updateAvailable,
      checkError: payload.checkError,
    });
    return payload;
  });

  app.post('/admin/update/apply', async (req, reply) => {
    requireAdmin(req);
    const body = parse(z.object({ version: z.string().trim().min(1).max(64).optional() }), req.body);
    const target = await svc.apply(body.version);
    const payload = await svc.payload();
    await audit(req, 'update.apply', 'system', null, {
      from: payload.currentVersion,
      to: target.version,
      tag: target.tag,
      commitSha: target.commitSha,
      verified: target.verified,
      runningServers: payload.runningServers,
    });
    return reply.code(202).send(payload);
  });

  app.post('/admin/update/rollback', async (req, reply) => {
    requireAdmin(req);
    const prev = await svc.rollback();
    const payload = await svc.payload();
    await audit(req, 'update.rollback', 'system', null, {
      from: payload.currentVersion,
      to: prev.version,
      commitSha: prev.sha,
    });
    return reply.code(202).send(payload);
  });

  app.get<{ Querystring: { offset?: string } }>('/admin/update/log', async (req) => {
    requireAdmin(req);
    return svc.readLog(intQuery(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER));
  });
}
