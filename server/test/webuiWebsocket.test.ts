import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { AppError, forbidden, unauthorized } from '../src/lib/errors.js';
import { parseDefinition, type GameWebui } from '../src/lib/gameDefinition.js';
import {
  closeReason,
  forwardCloseCode,
  parseProtocols,
  rewriteBody,
  upstreamTarget,
  upstreamWsHeaders,
  wsOriginAllowed,
  WS_MAX_MESSAGE_BYTES,
} from '../src/lib/webuiProxy.js';
import { __mintWebuiSession, __webuiBridges, selectProtocol, webuiRoutesWith, type WebuiDeps } from '../src/routes/webui.js';
import { bus } from '../src/services/events.js';

// ---------------------------------------------------------------------------------------------
// Pure helpers

const B = '/api/servers/s/webui/eco/~t/TOK';

test('ws: root-absolute literals, location.host constructions and absolute upstream URLs are rewritten', () => {
  const js = [
    'new WebSocket("/ws/chat")',
    'new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/socket`)',
    'new WebSocket("ws://" + window.location.host + "/api/live")',
    'new WebSocket(proto + "//" + location.host + "/")',
    'var u = "ws://172.18.0.9:3001/ws"; var h = "http://172.18.0.9:3001/x";',
  ].join('\n');
  const out = rewriteBody(js, 'js', B, { upstreamHost: '172.18.0.9:3001', panelHost: 'panel.example', secure: true });
  assert.ok(out.includes(`new WebSocket("${B}/ws/chat")`));
  assert.ok(out.includes(`\${location.host}${B}/socket\``));
  assert.ok(out.includes(`window.location.host + "${B}/api/live"`));
  assert.ok(out.includes(`location.host + "${B}/"`));
  assert.ok(out.includes(`"wss://panel.example${B}/ws"`));
  assert.ok(out.includes(`"https://panel.example${B}/x"`));
  // Idempotent.
  assert.equal(rewriteBody(out, 'js', B, { upstreamHost: '172.18.0.9:3001', panelHost: 'panel.example', secure: true }), out);
  // Plain http panel -> ws://
  assert.ok(rewriteBody('"ws://10.0.0.2:80/a"', 'js', B, { upstreamHost: '10.0.0.2:80', panelHost: 'h', secure: false }).includes(`"ws://h${B}/a"`));
});

test('paths are normalised: dot segments (also encoded) are refused', () => {
  assert.equal(upstreamTarget(`${B}/a/../b`, B), null);
  assert.equal(upstreamTarget(`${B}/a/%2e%2e/b`, B), null);
  assert.equal(upstreamTarget(`${B}/./a`, B), null);
  assert.equal(upstreamTarget(`${B}/a/%5c`, B), null);
  assert.equal(upstreamTarget(`${B}/a/%zz`, B), null);
  assert.equal(upstreamTarget(`${B}/ws?x=..`, B), '/ws?x=..');
  assert.equal(upstreamTarget(`${B}/a..b/c`, B), '/a..b/c');
});

test('origin rules', () => {
  const panel = ['http://panel.example', 'https://panel.example'];
  assert.equal(wsOriginAllowed(undefined, panel), true);
  assert.equal(wsOriginAllowed('null', panel), true);
  assert.equal(wsOriginAllowed('https://panel.example', panel), true);
  assert.equal(wsOriginAllowed('https://evil.example', panel), false);
  assert.equal(wsOriginAllowed('https://panel.example.evil.example', panel), false);
  assert.equal(wsOriginAllowed('garbage', panel), false);
});

test('protocols, close codes, reasons, handshake headers', () => {
  assert.deepEqual(parseProtocols('chat.v1, chat.v2,bad proto,,x'), ['chat.v1', 'chat.v2', 'x']);
  assert.equal(forwardCloseCode(1000), 1000);
  assert.equal(forwardCloseCode(4001), 4001);
  assert.equal(forwardCloseCode(1005), 1000);
  assert.equal(forwardCloseCode(1006), 1011);
  assert.equal(forwardCloseCode(1015), 1000);
  assert.equal(forwardCloseCode(undefined, 1011), 1011);
  assert.equal(Buffer.byteLength(closeReason('é'.repeat(100))), 122);
  assert.deepEqual(upstreamWsHeaders({ upstreamHost: '1.2.3.4:80', cookie: null, basicAuth: { user: 'a', password: 'b' } }), {
    origin: 'http://1.2.3.4:80',
    authorization: `Basic ${Buffer.from('a:b').toString('base64')}`,
  });
  assert.equal(selectProtocol(new Set(['a', 'b']), {} as http.IncomingMessage), 'a');
  const raw = { [Symbol.for('servcrafty.webui.wsProtocol')]: 'b' } as unknown as http.IncomingMessage;
  assert.equal(selectProtocol(new Set(['a', 'b']), raw), 'b');
});

test('schema: websocket defaults to false', () => {
  const d = parseDefinition({
    schema: 1,
    id: 'eco-like',
    name: 'Eco-like',
    steam: { appId: 739590 },
    resources: { memoryMb: 1024, memoryMinMb: 512, cpu: 1 },
    ports: [
      { id: 'game', label: 'Game', protocol: 'udp', containerPort: 3000 },
      { id: 'web', label: 'Web', protocol: 'tcp', containerPort: 3001 },
    ],
    launch: { command: ['./x'] },
    webui: [
      { id: 'a', label: 'A', portId: 'web' },
      { id: 'b', label: 'B', portId: 'web', websocket: true },
    ],
  });
  assert.equal(d.webui[0]!.websocket, false);
  assert.equal(d.webui[1]!.websocket, true);
});

// ---------------------------------------------------------------------------------------------
// Integration: browser client -> panel proxy -> fake upstream (no Docker, no DB)

let upstream: { server: http.Server; wss: WebSocketServer; port: number; seen: http.IncomingHttpHeaders[]; sockets: WebSocket[] };
let panel: FastifyInstance;
let panelPort = 0;
const SERVER_ID = 'srv-ws-test';
const ui = (over: Partial<GameWebui> = {}): GameWebui => ({
  id: 'eco',
  label: 'Eco',
  portId: 'web',
  path: '/',
  auth: { type: 'basic', user: 'admin', password: 'secret' },
  minAccess: 'manager',
  rewrite: true,
  websocket: true,
  ...over,
});
let upstreamUp = true;

const deps: WebuiDeps = {
  currentUserId: (req) => {
    const u = req.headers['x-test-user'];
    if (typeof u !== 'string') throw unauthorized();
    return u;
  },
  async resolve(_req, _serverId, uiId, userId) {
    if (userId === 'no-access') throw forbidden('This web UI requires manager access', 'insufficient_access');
    return {
      ui: ui(uiId === 'nows' ? { id: 'nows', websocket: false } : {}),
      upstream: async () => {
        if (!upstreamUp) throw new AppError(502, 'webui_unreachable', 'down');
        return { host: '127.0.0.1', port: upstream.port, basicAuth: { user: 'admin', password: 'secret' } };
      },
    };
  },
  panelOrigins: async () => ['http://panel.test'],
};

before(async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const wss = new WebSocketServer({ server, handleProtocols: (p) => (p.has('chat.v2') ? 'chat.v2' : false) });
  const seen: http.IncomingHttpHeaders[] = [];
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws, req) => {
    seen.push(req.headers);
    sockets.push(ws);
    ws.send('hello'); // sent immediately: must survive the bridge set-up
    ws.on('message', (data, isBinary) => {
      const text = isBinary ? null : data.toString();
      if (text === 'close-me') ws.close(4001, 'bye');
      else if (text === 'big') ws.send(Buffer.alloc(WS_MAX_MESSAGE_BYTES + 1), { binary: true });
      else ws.send(data, { binary: isBinary });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  upstream = { server, wss, port: (server.address() as AddressInfo).port, seen, sockets };

  panel = Fastify();
  await panel.register(websocket, { options: { maxPayload: WS_MAX_MESSAGE_BYTES, handleProtocols: selectProtocol } });
  panel.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    return reply.code(500).send({ error: { code: 'internal_error', message: String(err) } });
  });
  await panel.register(webuiRoutesWith(deps), { prefix: '/api' });
  await panel.listen({ port: 0, host: '127.0.0.1' });
  panelPort = (panel.server.address() as AddressInfo).port;
});

after(async () => {
  await panel.close();
  upstream.wss.close();
  await new Promise<void>((r) => upstream.server.close(() => r()));
});

const wsUrl = (token: string, path = '/ws', uiId = 'eco') => `ws://127.0.0.1:${panelPort}/api/servers/${SERVER_ID}/webui/${uiId}/~t/${token}${path}`;

function open(url: string, opts: { protocols?: string[]; origin?: string; headers?: Record<string, string> } = {}) {
  const ws = new WebSocket(url, opts.protocols ?? [], { origin: opts.origin, headers: opts.headers });
  const messages: { data: Buffer; binary: boolean }[] = [];
  ws.on('message', (data: Buffer, binary) => messages.push({ data, binary }));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.once('close', (code, reason) => r({ code, reason: reason.toString() })));
  const next = async (n: number) => {
    for (let i = 0; i < 200 && messages.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    return messages[n - 1];
  };
  return { ws, opened, closed, messages, next };
}

test('bridge: text, binary, subprotocol, early message, upstream headers', async () => {
  const token = __mintWebuiSession('u1', SERVER_ID, 'eco');
  const c = open(wsUrl(token, '/ws?room=1'), { protocols: ['chat.v1', 'chat.v2'], origin: 'null', headers: { cookie: 'scf_sid=SECRET', authorization: 'Bearer scf_x' } });
  await c.opened;
  assert.equal(c.ws.protocol, 'chat.v2');
  assert.equal((await c.next(1))?.data.toString(), 'hello');
  c.ws.send('ping-text');
  assert.equal((await c.next(2))?.data.toString(), 'ping-text');
  c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
  const bin = await c.next(3);
  assert.equal(bin?.binary, true);
  assert.deepEqual([...bin!.data], [1, 2, 3]);
  const h = upstream.seen.at(-1)!;
  assert.equal(h.origin, `http://127.0.0.1:${upstream.port}`);
  assert.equal(h.authorization, `Basic ${Buffer.from('admin:secret').toString('base64')}`);
  assert.equal(h.cookie, undefined);
  assert.equal(h['sec-websocket-protocol'], 'chat.v1,chat.v2');
  c.ws.close(4002, 'client done');
  await c.closed;
});

test('close codes propagate both ways', async () => {
  const token = __mintWebuiSession('u1', SERVER_ID, 'eco');
  const a = open(wsUrl(token));
  await a.opened;
  a.ws.send('close-me');
  assert.deepEqual(await a.closed, { code: 4001, reason: 'bye' });

  const b = open(wsUrl(token));
  await b.opened;
  const up = upstream.sockets.at(-1)!;
  const upClosed = new Promise<number>((r) => up.once('close', (code) => r(code)));
  b.ws.close(4002, 'done');
  assert.equal(await upClosed, 4002);
});

test('per-message size cap in both directions', async () => {
  const token = __mintWebuiSession('u1', SERVER_ID, 'eco');
  const a = open(wsUrl(token));
  await a.opened;
  const echoedBefore = upstream.sockets.length;
  a.ws.send(Buffer.alloc(WS_MAX_MESSAGE_BYTES + 1));
  // The panel drops the connection (1009 when the close frame makes it, 1006 when it does not).
  assert.ok([1006, 1009].includes((await a.closed).code));
  assert.equal(a.messages.length, 1); // only the upstream's greeting, never an echo of the oversized frame
  assert.equal(upstream.sockets.length, echoedBefore);
  const b = open(wsUrl(token));
  await b.opened;
  b.ws.send('big'); // the upstream answers with an oversized frame: the panel refuses it
  assert.ok([1006, 1009, 1011].includes((await b.closed).code));
  assert.ok(b.messages.every((m) => m.data.length <= WS_MAX_MESSAGE_BYTES));
});

test('upgrade refusals: no token, websocket disabled, bad origin, expired token, no access, upstream down', async () => {
  const token = __mintWebuiSession('u1', SERVER_ID, 'eco');
  await assert.rejects(open(`ws://127.0.0.1:${panelPort}/api/servers/${SERVER_ID}/webui/eco/ws`, { headers: { 'x-test-user': 'u1' } }).opened, /HTTP 400/);
  const nows = __mintWebuiSession('u1', SERVER_ID, 'nows');
  await assert.rejects(open(wsUrl(nows, '/ws', 'nows')).opened, /HTTP 400/);
  await assert.rejects(open(wsUrl(token), { origin: 'https://evil.example' }).opened, /HTTP 403/);
  await open(wsUrl(token), { origin: 'http://panel.test' }).opened.then(() => undefined);
  await assert.rejects(open(wsUrl('not-a-token')).opened, /HTTP 403/);
  const noAccess = __mintWebuiSession('no-access', SERVER_ID, 'eco');
  await assert.rejects(open(wsUrl(noAccess)).opened, /HTTP 403/);
  upstreamUp = false;
  try {
    await assert.rejects(open(wsUrl(token)).opened, /HTTP 502/);
  } finally {
    upstreamUp = true;
  }
});

test('all sockets of a server close when it stops; per server+user limit', async () => {
  const token = __mintWebuiSession('u2', SERVER_ID, 'eco');
  const conns = [];
  for (let i = 0; i < 20; i++) {
    const c = open(wsUrl(token));
    await c.opened;
    conns.push(c);
  }
  await assert.rejects(open(wsUrl(token)).opened, /HTTP 429/);
  bus.emit('status', SERVER_ID, 'stopping');
  for (const c of conns) assert.equal((await c.closed).code, 1001);
  assert.equal(__webuiBridges.has(SERVER_ID), false);
});
