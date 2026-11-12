import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError } from '../src/lib/errors.js';
import type { GameWebui } from '../src/lib/gameDefinition.js';
import { __mintWebuiSession, webuiRoutesWith, type WebuiDeps } from '../src/routes/webui.js';

/** BlueMap through the web UI proxy: page served untouched except for the storage stand-in, CORS for the sandbox. */

const SERVER_ID = 'srv-map-test';
const MAP_UI: GameWebui = { id: 'bluemap', label: 'Map', portId: 'bluemap', path: '/', auth: { type: 'none' }, minAccess: 'viewer', rewrite: false, websocket: false };
const SHIM = '<script>/*shim*/</script>';

const PUBLIC_TOKEN = 'public-link-token-0123456789abcdef';

let upstream: http.Server;
let panel: FastifyInstance;
let panelPort = 0;
let upstreamPort = 0;
const requests: { url: string; headers: http.IncomingHttpHeaders }[] = [];

const deps: WebuiDeps = {
  currentUserId: () => 'u1',
  async resolve() {
    return {
      ui: MAP_UI,
      headHtml: SHIM,
      upstream: async () => {
        if (!upstreamPort) throw new AppError(502, 'webui_unreachable', 'down');
        return { host: '127.0.0.1', port: upstreamPort, basicAuth: null };
      },
    };
  },
  panelOrigins: async () => [],
  publicAccess: async (_serverId, uiId, token) => uiId === 'bluemap' && token === PUBLIC_TOKEN,
};

before(async () => {
  upstream = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    if (req.url === '/' || req.url === '/index.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><head><title>BlueMap</title></head><body><script type="module" src="./assets/app.js"></script></body></html>');
    } else if (req.url === '/assets/app.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end('const u = "/maps/world/tiles/0/x0/z0.json"; fetch(u);');
    } else if (req.url === '/maps/world/tiles/0/x0/z0.json') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'public, max-age=60');
      res.end('{"ok":true}');
    } else {
      res.statusCode = 404;
      res.end('nope');
    }
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as AddressInfo).port;
  panel = Fastify();
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
  await new Promise<void>((r) => upstream.close(() => r()));
});

const get = (token: string, p: string) => fetch(`http://127.0.0.1:${panelPort}/api/servers/${SERVER_ID}/webui/bluemap/~t/${token}${p}`);

test('entry redirects into a token session at the map root', async () => {
  const res = await fetch(`http://127.0.0.1:${panelPort}/api/servers/${SERVER_ID}/webui/bluemap/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', new RegExp(`^/api/servers/${SERVER_ID}/webui/bluemap/~t/[\\w-]+/$`));
});

test('the page gets the storage stand-in right after <head>, nothing else changes', async () => {
  const token = __mintWebuiSession('u1', SERVER_ID, 'bluemap');
  const res = await get(token, '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(`<head>${SHIM}<title>BlueMap</title>`), html);
  assert.ok(html.includes('src="./assets/app.js"'), 'relative URLs are untouched');
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*', 'sandboxed module scripts and fetches need CORS');
});

test('scripts and tiles pass through verbatim (no rewriting for BlueMap)', async () => {
  const token = __mintWebuiSession('u1', SERVER_ID, 'bluemap');
  const js = await (await get(token, '/assets/app.js')).text();
  assert.equal(js, 'const u = "/maps/world/tiles/0/x0/z0.json"; fetch(u);');
  const tile = await get(token, '/maps/world/tiles/0/x0/z0.json');
  assert.equal(tile.status, 200);
  assert.equal(await tile.text(), '{"ok":true}');
  assert.equal(tile.headers.get('access-control-allow-origin'), '*');
  assert.equal(tile.headers.get('cache-control'), 'public, max-age=60');
});

test('browser cookies and tokens never reach BlueMap', async () => {
  requests.length = 0;
  const token = __mintWebuiSession('u1', SERVER_ID, 'bluemap');
  await fetch(`http://127.0.0.1:${panelPort}/api/servers/${SERVER_ID}/webui/bluemap/~t/${token}/`, {
    headers: { cookie: 'servcrafty_session=SECRET', authorization: 'Bearer scf_SECRET' },
  });
  const h = requests[0]!.headers;
  assert.equal(h.cookie, undefined);
  assert.equal(h.authorization, undefined);
});

test('a public link token opens the map with no session, read-only', async () => {
  const page = await get(PUBLIC_TOKEN, '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /BlueMap/);
  const tile = await get(PUBLIC_TOKEN, '/maps/world/tiles/0/x0/z0.json');
  assert.equal(tile.status, 200);
  const post = await fetch(`http://127.0.0.1:${panelPort}/api/servers/${SERVER_ID}/webui/bluemap/~t/${PUBLIC_TOKEN}/`, { method: 'POST', body: 'x' });
  assert.equal(post.status, 405);
});

test('a wrong or revoked token is not a public link', async () => {
  const res = await fetch(`http://127.0.0.1:${panelPort}/api/servers/${SERVER_ID}/webui/bluemap/~t/not-the-token-0123456789abcdef/`, { redirect: 'manual' });
  assert.equal(res.status, 302, 'sent back to the sign-in entry, never served');
  assert.equal(res.headers.get('location'), `/api/servers/${SERVER_ID}/webui/bluemap`);
});
