import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { APP_VERSION, config } from './config.js';
import { queryOne } from './db/pool.js';
import { registerAuth } from './auth/plugin.js';
import { AppError } from './lib/errors.js';
import accountRoutes from './routes/account.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import backupRoutes from './routes/backups.js';
import catalogRoutes from './routes/catalog.js';
import fileRoutes from './routes/files.js';
import modRoutes from './routes/mods.js';
import scheduleRoutes from './routes/schedules.js';
import serverRoutes from './routes/servers.js';
import shareRoutes from './routes/shares.js';
import templateRoutes from './routes/templates.js';
import updateRoutes from './routes/update.js';
import userRoutes from './routes/users.js';
import webhookRoutes from './routes/webhooks.js';
import wsRoutes from './routes/ws.js';
import { dockerAvailable } from './services/docker.js';

const MAX_UPLOAD_BYTES = 8 * 1024 ** 3;

export async function buildApp(): Promise<FastifyInstance> {
  const c = config();
  const app = Fastify({
    logger: {
      level: c.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    trustProxy: c.trustProxy,
    bodyLimit: 12 * 1024 * 1024,
  });

  // Tolerate empty JSON bodies (e.g. POST /auth/logout with a JSON content type).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (!text.trim()) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError(400, 'invalid_json', 'Request body is not valid JSON'), undefined);
    }
  });

  const cookieSecret = crypto.createHash('sha256').update(`servcrafty:cookie:${c.secretKey}`).digest('hex');
  await app.register(cookie, { secret: cookieSecret });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 50, fields: 50, fieldSize: 64 * 1024 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  registerAuth(app);

  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.warn({ err }, err.message);
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    const fe = err as FastifyError;
    if (fe.validation) {
      return reply.code(400).send({ error: { code: 'validation_error', message: fe.message } });
    }
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send({ error: { code: (fe.code ?? 'bad_request').toLowerCase(), message: fe.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  // ---- API ----
  await app.register(
    async (api) => {
      api.get('/health', async () => {
        let dbOk = false;
        try {
          dbOk = !!(await queryOne('SELECT 1 AS ok'));
        } catch {
          dbOk = false;
        }
        return { ok: dbOk, db: dbOk, docker: await dockerAvailable(), version: APP_VERSION };
      });
      await api.register(authRoutes);
      await api.register(accountRoutes);
      await api.register(userRoutes);
      await api.register(adminRoutes);
      await api.register(updateRoutes);
      await api.register(serverRoutes);
      await api.register(fileRoutes);
      await api.register(backupRoutes);
      await api.register(scheduleRoutes);
      await api.register(webhookRoutes);
      await api.register(shareRoutes);
      await api.register(modRoutes);
      await api.register(templateRoutes);
      await api.register(catalogRoutes);
    },
    { prefix: '/api' },
  );
  await app.register(wsRoutes);

  // ---- Web UI (SPA) ----
  const dist = c.webDist;
  const indexHtml = path.join(dist, 'index.html');
  const hasWeb = fs.existsSync(indexHtml);
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: dist,
      wildcard: false,
      index: false,
      setHeaders: (res, filePath) => {
        if (/[\\/]assets[\\/]/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    });
    app.log.info(`serving web UI from ${dist}`);
  } else {
    app.log.warn(`web UI not found at ${dist}; only the API is served`);
  }

  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0] ?? '';
    if (url.startsWith('/api') || url.startsWith('/ws') || !hasWeb || (req.method !== 'GET' && req.method !== 'HEAD')) {
      return reply.code(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${url} not found` } });
    }
    return reply.header('Cache-Control', 'no-cache').type('text/html').sendFile('index.html');
  });

  return app;
}
