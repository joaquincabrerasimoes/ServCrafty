import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { errorMessage } from '../lib/errors.js';
import { hasAccess, loadServerFor } from '../services/access.js';
import { audit } from '../services/audit.js';
import { bus } from '../services/events.js';
import * as runtime from '../services/runtime.js';
import { getPublicUrl } from '../services/settings.js';
import type { Access, ServerStatus, Stats } from '../services/types.js';

const clientMsg = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    serverId: z.string().uuid(),
    channels: z.array(z.enum(['logs', 'stats'])).default(['logs', 'stats']),
  }),
  z.object({ type: z.literal('unsubscribe'), serverId: z.string().uuid() }),
  z.object({ type: z.literal('command'), serverId: z.string().uuid(), command: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('ping') }),
]);

interface Sub {
  logs: boolean;
  stats: boolean;
  access: Access;
}

async function originAllowed(req: FastifyRequest): Promise<boolean> {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients
  try {
    const o = new URL(origin);
    if (o.host === req.headers.host) return true;
    return o.origin === new URL(await getPublicUrl()).origin;
  } catch {
    return false;
  }
}

export default async function wsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const user = req.user;
    void originAllowed(req).then((ok) => {
      if (!ok) {
        send({ type: 'error', message: 'Origin not allowed' });
        socket.close(1008, 'origin');
      }
    });
    if (!user) {
      send({ type: 'error', code: 'unauthorized', message: 'Authentication required' });
      socket.close(4401, 'unauthorized');
      return;
    }
    const subs = new Map<string, Sub>();

    const onLog = (serverId: string, line: string) => {
      if (subs.get(serverId)?.logs) send({ type: 'log', serverId, line });
    };
    const onStats = (serverId: string, stats: Stats) => {
      if (subs.get(serverId)?.stats) send({ type: 'stats', serverId, stats });
    };
    const onStatus = (serverId: string, status: ServerStatus) => {
      if (subs.has(serverId)) send({ type: 'status', serverId, status });
    };
    bus.on('log', onLog);
    bus.on('stats', onStats);
    bus.on('status', onStatus);

    const unsubscribe = (serverId: string) => {
      const s = subs.get(serverId);
      if (!s) return;
      if (s.stats) runtime.watch(serverId, -1);
      subs.delete(serverId);
    };

    const alive = { v: true };
    socket.on('pong', () => (alive.v = true));
    const hb = setInterval(() => {
      if (!alive.v) {
        socket.terminate();
        return;
      }
      alive.v = false;
      socket.ping();
    }, 30_000);

    socket.on('message', (raw) => {
      void (async () => {
        let msg: z.infer<typeof clientMsg>;
        try {
          const parsed = clientMsg.safeParse(JSON.parse(String(raw)));
          if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid message');
          msg = parsed.data;
        } catch (err) {
          send({ type: 'error', message: `Invalid message: ${errorMessage(err)}` });
          return;
        }
        try {
          switch (msg.type) {
            case 'ping':
              send({ type: 'pong' });
              return;
            case 'subscribe': {
              const { server, access } = await loadServerFor(user, msg.serverId, 'viewer');
              unsubscribe(server.id);
              const sub: Sub = { logs: msg.channels.includes('logs'), stats: msg.channels.includes('stats'), access };
              subs.set(server.id, sub);
              send({ type: 'status', serverId: server.id, status: runtime.getStatus(server.id) });
              if (sub.logs) {
                const backlog = runtime.backlog(server.id, 200);
                const lines = backlog.length ? backlog : await runtime.getLogs(server, 200);
                for (const line of lines) send({ type: 'log', serverId: server.id, line });
              }
              if (sub.stats) {
                runtime.watch(server.id, 1);
                send({ type: 'stats', serverId: server.id, stats: await runtime.getStats(server) });
              }
              return;
            }
            case 'unsubscribe':
              unsubscribe(msg.serverId);
              return;
            case 'command': {
              const { server, access } = await loadServerFor(user, msg.serverId, 'viewer');
              if (!hasAccess(access, 'operator')) {
                send({ type: 'error', serverId: server.id, message: 'Operator access required to send commands' });
                return;
              }
              const output = await runtime.sendCommand(server.id, msg.command);
              await audit(req, 'server.command', 'server', server.id, { command: msg.command, via: 'ws' });
              send({ type: 'command_result', serverId: server.id, command: msg.command, output });
              return;
            }
          }
        } catch (err) {
          send({ type: 'error', serverId: 'serverId' in msg ? msg.serverId : undefined, message: errorMessage(err) });
        }
      })();
    });

    socket.on('close', () => {
      clearInterval(hb);
      bus.off('log', onLog);
      bus.off('stats', onStats);
      bus.off('status', onStatus);
      for (const id of [...subs.keys()]) unsubscribe(id);
    });
  });
}
