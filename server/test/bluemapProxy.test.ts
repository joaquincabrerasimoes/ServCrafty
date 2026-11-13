import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError } from '../src/lib/errors.js';
import type { GameWebui } from '../src/lib/gameDefinition.js';
import { __mintWebuiSession, webuiRoutesWith, type WebuiDeps, type WebuiMarkers } from '../src/routes/webui.js';

/** BlueMap through the web UI proxy: page served untouched except for the storage stand-in, CORS for the sandbox. */

const SERVER_ID = 'srv-map-test';
const MAP_UI: GameWebui = { id: 'bluemap', label: 'Map', portId: 'bluemap', path: '/', auth: { type: 'none' }, minAccess: 'viewer', rewrite: false, websocket: false };
const SHIM = '<script>/*shim*/</script>';

const PUBLIC_TOKEN = 'public-link-token-0123456789abcdef';
const EDIT_TOKEN = 'edit-link-token-0123456789abcdefgh';

/** Fake marker storage: records what the proxy asks of it. */
const markerCalls: { op: string; actor?: string; all?: boolean; arg?: unknown }[] = [];
const markers: WebuiMarkers = {
  mapJson: async (_s, mapId, theirs) => ({ ...(theirs as object), 'sc-set': { label: `ours-${mapId}`, markers: {} } }),
  overview: async (_s, mapId) => {
    markerCalls.push({ op: 'overview', arg: mapId });
    return { sets: [], markers: [] };
  },
  create: async (_s, actor, body) => {
    markerCalls.push({ op: 'create', actor: actor.id, all: actor.all, arg: body });
    return { id: 'm1' };
  },
  update: async (_s, actor, id, body) => {
    markerCalls.push({ op: 'update', actor: actor.id, arg: { id, body } });
    return { id };
  },
  remove: async (_s, actor, id) => {
    if (id === 'forbidden') throw new AppError(403, 'marker_not_yours', 'not yours');
    markerCalls.push({ op: 'remove', actor: actor.id, arg: id });
  },
};

let upstream: http.Server;
let panel: FastifyInstance;
let panelPort = 0;
let upstreamPort = 0;
const requests: { url: string; headers: http.IncomingHttpHeaders }[] = [];

const deps: WebuiDeps = {
  currentUserId: () => 'u1',
  async resolve(_req, _serverId, _uiId, userId, link) {
    return {
      ui: MAP_UI,
      headHtml: SHIM,
      canEditMarkers: userId === 'editor' || !!link?.canEdit,
      upstream: async () => {
        if (!upstreamPort) throw new AppError(502, 'webui_unreachable', 'down');
        return { host: '127.0.0.1', port: upstreamPort, basicAuth: null };
      },
    };
  },
  panelOrigins: async () => [],
  publicAccess: async (_serverId, uiId, token) => {
    if (uiId !== 'bluemap') return null;
    if (token === PUBLIC_TOKEN) return { linkId: 'link-view', canEdit: false };
    if (token === EDIT_TOKEN) return { linkId: 'link-edit', canEdit: true };
    return null;
  },
  markers,
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
    } else if (req.url === '/maps/world/live/markers.json') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('etag', '"abc"');
      res.end('{"theirs":{"label":"BlueMap own","markers":{}}}');
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

test('live markers: ours are merged into the ones BlueMap serves (and work when BlueMap has none)', async () => {
  const r = await get(PUBLIC_TOKEN, '/maps/world/live/markers.json');
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, { label: string }>;
  assert.equal(j.theirs?.label, 'BlueMap own');
  assert.equal(j['sc-set']?.label, 'ours-world');
  assert.equal(r.headers.get('etag'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const none = await get(PUBLIC_TOKEN, '/maps/nether/live/markers.json'); // upstream 404
  assert.equal(none.status, 200);
  assert.deepEqual(Object.keys((await none.json()) as object), ['sc-set']);
});

const post = (token: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${panelPort}/api/servers/${SERVER_ID}/webui/bluemap/~t/${token}/__servcrafty/markers${path}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('an edit link creates markers through the panel, nothing is forwarded to BlueMap', async () => {
  requests.length = 0;
  const res = await post(EDIT_TOKEN, '', { type: 'poi', label: 'Base', mapId: 'world', position: { x: 1, y: 2, z: 3 } });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(markerCalls.at(-1), { op: 'create', actor: 'link:link-edit', all: false, arg: { type: 'poi', label: 'Base', mapId: 'world', position: { x: 1, y: 2, z: 3 } } });
  assert.equal(requests.length, 0, 'answered by the panel, nothing forwarded');
});

test('a public link without the edit right can read markers but not change them', async () => {
  const read = await fetch(`http://127.0.0.1:${panelPort}/api/servers/${SERVER_ID}/webui/bluemap/~t/${PUBLIC_TOKEN}/__servcrafty/markers?mapId=world`);
  assert.equal(read.status, 200);
  const body = (await read.json()) as { canEdit: boolean };
  assert.equal(body.canEdit, false);
  const res = await post(PUBLIC_TOKEN, '', { type: 'poi', label: 'x', mapId: 'world', position: { x: 0, y: 0, z: 0 } });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'markers_read_only');
});

test('editor API: update, delete (POST only), errors come back as JSON with CORS', async () => {
  let res = await post(EDIT_TOKEN, '/abc', { label: 'New' });
  assert.equal(res.status, 200);
  assert.deepEqual(markerCalls.at(-1), { op: 'update', actor: 'link:link-edit', arg: { id: 'abc', body: { label: 'New' } } });
  res = await post(EDIT_TOKEN, '/abc/delete');
  assert.equal(res.status, 200);
  assert.equal(markerCalls.at(-1)?.op, 'remove');
  res = await post(EDIT_TOKEN, '/forbidden/delete');
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'marker_not_yours');
  res = await post(EDIT_TOKEN, '', undefined);
  assert.notEqual(res.status, 500);
  const del = await fetch(`http://127.0.0.1:${panelPort}/api/servers/${SERVER_ID}/webui/bluemap/~t/${EDIT_TOKEN}/__servcrafty/markers/abc`, { method: 'DELETE' });
  assert.equal(del.status, 405);
});
