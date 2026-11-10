import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { forbidden } from '../lib/errors.js';
import { hasCloudflareHeaders } from '../lib/network.js';
import { stopAllServers } from '../services/runtime.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function sameSecret(given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(config().secretKey).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Endpoints for the machine the panel runs on (systemd hooks). Never reachable through the tunnel or the LAN. */
export default async function internalRoutes(app: FastifyInstance): Promise<void> {
  // Called by servcrafty-graceful.service when the container shuts down or reboots: save and stop every game server.
  app.post('/internal/stop-all', async (req) => {
    const fromLocalhost = LOOPBACK.has(req.raw.socket.remoteAddress ?? '') && !hasCloudflareHeaders(req.headers);
    if (!fromLocalhost || !sameSecret(req.headers['x-servcrafty-key'])) throw forbidden('Not allowed', 'forbidden');
    req.log.info('graceful shutdown requested: stopping all game servers');
    return stopAllServers();
  });
}
