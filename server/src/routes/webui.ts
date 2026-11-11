import crypto from 'node:crypto';
import http from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import { requireUser } from '../auth/plugin.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import type { GameWebui } from '../lib/gameDefinition.js';
import { BLUEMAP_PORT, BLUEMAP_UI_ID, bluemapKind } from '../lib/bluemap.js';
import { isSteamType } from '../lib/games.js';
import { renderWebuiAuth, resolvePorts } from '../lib/steamPlan.js';
import {
  charsetOf,
  closeReason,
  CookieJar,
  filterResponseHeaders,
  forwardCloseCode,
  parseProtocols,
  responseCsp,
  rewriteBody,
  rewriteLocation,
  textKindOf,
  upstreamRequestHeaders,
  upstreamTarget,
  upstreamWsHeaders,
  wsOriginAllowed,
  WS_HIGH_WATER_BYTES,
  WS_IDLE_MS,
  WS_MAX_MESSAGE_BYTES,
  WS_MAX_PER_SERVER_USER,
  WS_PROTOCOL_KEY,
  type AbsoluteRewrite,
} from '../lib/webuiProxy.js';
import { hasAccess, loadServerFor } from '../services/access.js';
import { containerIp } from '../services/docker.js';
import { bus } from '../services/events.js';
import { getDefinition } from '../services/gameDefinitions.js';
import { blockedForRemote } from '../services/lanOnly.js';
import * as runtime from '../services/runtime.js';
import { getPublicUrl } from '../services/settings.js';
import type { ServerStatus } from '../services/types.js';
import { getUser } from '../services/users.js';

/**
 * Authenticated reverse proxy to a game's web UI (SPEC "Web UI proxy"), HTTP and (opt-in) WebSocket.
 *
 * Security model:
 * - It only ever connects to the declared port of the server's own container, by IP on the docker
 *   network; the client controls nothing but the path (no open relay / SSRF; dot segments refused).
 * - The proxied pages run with `Content-Security-Policy: sandbox` (opaque origin) so the game's
 *   scripts cannot use the viewer's panel session. Because a sandboxed frame does not send the
 *   panel cookie, the first (cookie-authenticated) request is redirected to a URL carrying a
 *   short-lived proxy token (`.../~t/<token>/...`) bound to the user, server and web UI; access is
 *   re-checked on every request and on every WebSocket upgrade (upgrades only on token URLs).
 * - Browser cookies/Authorization/Origin never reach the game; upstream cookies are kept in a
 *   per-token jar on the panel and never reach the browser.
 */

const UPSTREAM_TIMEOUT_MS = 30_000;
const WS_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const TOKEN_IDLE_MS = 2 * 60 * 60_000;
const TOKEN_MAX_MS = 12 * 60 * 60_000;
const TOKEN_SEGMENT = '~t';

interface ProxySession {
  userId: string;
  serverId: string;
  uiId: string;
  createdAt: number;
  lastUsed: number;
  jar: CookieJar;
}

const sessions = new Map<string, ProxySession>();

function sweep(now = Date.now()): void {
  for (const [t, s] of sessions) if (now - s.lastUsed > TOKEN_IDLE_MS || now - s.createdAt > TOKEN_MAX_MS) sessions.delete(t);
}

function newSession(userId: string, serverId: string, uiId: string): string {
  sweep();
  if (sessions.size > 5000) sessions.clear();
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  sessions.set(token, { userId, serverId, uiId, createdAt: now, lastUsed: now, jar: new CookieJar() });
  return token;
}

const basePath = (serverId: string, uiId: string) => `/api/servers/${serverId}/webui/${uiId}`;

type Params = { id: string; uiId: string; '*'?: string };

function unreachable(message = 'The web UI is not reachable: is the server running?'): AppError {
  return new AppError(502, 'webui_unreachable', message);
}

// ---------------------------------------------------------------------------------------------
// Dependencies (injectable so the proxy can be tested without a database or Docker)

export interface WebuiUpstream {
  host: string;
  port: number;
  basicAuth: { user: string; password: string } | null;
}

export interface WebuiDeps {
  /** The fully authenticated user of a cookie/API-token request (throws 401). */
  currentUserId(req: FastifyRequest): string;
  /** Re-check `userId`'s access to the web UI (throws 403/404); `upstream()` throws 502 when it is down. */
  resolve(
    req: FastifyRequest,
    serverId: string,
    uiId: string,
    userId: string,
  ): Promise<{ ui: GameWebui; upstream: () => Promise<WebuiUpstream>; headHtml?: string }>;
  /** Origins of the panel itself (for the WebSocket Origin check). */
  panelOrigins(req: FastifyRequest): Promise<string[]>;
}

/** BlueMap's page as a web UI: viewers may open it; its scripts are the webapp's own (relative URLs), so no rewriting. */
const BLUEMAP_WEBUI: GameWebui = {
  id: BLUEMAP_UI_ID,
  label: 'Map',
  portId: 'bluemap',
  path: '/',
  auth: { type: 'none' },
  minAccess: 'viewer',
  rewrite: false,
  websocket: false,
};

/**
 * The proxied page runs in an opaque origin (CSP sandbox), where `localStorage` throws. Pages that
 * keep settings there get an in-memory stand-in so they do not crash.
 */
const STORAGE_SHIM =
  '<script>(function(){try{window.localStorage.getItem("x")}catch(e){var m={};var s={getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}};["localStorage","sessionStorage"].forEach(function(n){try{Object.defineProperty(window,n,{value:s,configurable:true})}catch(e2){}})}})();</script>';

function injectHead(html: string, snippet: string): string {
  const m = /<head[^>]*>/i.exec(html);
  return m ? `${html.slice(0, m.index + m[0].length)}${snippet}${html.slice(m.index + m[0].length)}` : snippet + html;
}

const realDeps: WebuiDeps = {
  currentUserId: (req) => requireUser(req).id,
  async resolve(req, serverId, uiId, userId) {
    const user = await getUser(userId);
    if (user.disabled || (await blockedForRemote(req, user, 'session'))) throw forbidden();
    const { server, access } = await loadServerFor(user, serverId, 'viewer');
    if (uiId === BLUEMAP_UI_ID) {
      // The BlueMap web server inside a Java server's container (not part of any game definition).
      if (!bluemapKind(server.type) || !server.bluemap?.enabled) throw notFound('Web UI not found', 'webui_not_found');
      return {
        ui: BLUEMAP_WEBUI,
        headHtml: STORAGE_SHIM,
        upstream: async () => {
          const status = runtime.getStatus(server.id);
          if (!['running', 'starting'].includes(status) || !server.container_id) throw unreachable('The map is not reachable: is the server running?');
          const ip = await containerIp(server.container_id).catch(() => null);
          if (!ip) throw unreachable('The map is not reachable: is the server running?');
          return { host: ip, port: BLUEMAP_PORT, basicAuth: null };
        },
      };
    }
    if (!isSteamType(server.type) || !server.steam) throw notFound('Web UI not found', 'webui_not_found');
    const def = getDefinition(server.steam.gameId);
    const ui = def?.webui.find((w) => w.id === uiId);
    if (!def || !ui) throw notFound('Web UI not found', 'webui_not_found');
    if (!hasAccess(access, ui.minAccess)) throw forbidden(`This web UI requires ${ui.minAccess} access`, 'insufficient_access');
    return {
      ui,
      upstream: async () => {
        const status = runtime.getStatus(server.id);
        if (!['running', 'starting'].includes(status) || !server.container_id) throw unreachable();
        const ip = await containerIp(server.container_id).catch(() => null);
        if (!ip) throw unreachable();
        const port = resolvePorts(def, server.port, server.extra_ports ?? {}).find((p) => p.id === ui.portId)?.containerPort;
        if (!port) throw unreachable('The web UI port is not configured');
        const basicAuth = renderWebuiAuth(def, ui.id, {
          serverId: server.id,
          serverName: server.name,
          steam: server.steam!,
          mainHostPort: server.port,
          extraPorts: server.extra_ports ?? {},
        });
        return { host: ip, port, basicAuth };
      },
    };
  },
  async panelOrigins(req) {
    const host = req.headers.host ?? '';
    const out = host ? [`http://${host}`, `https://${host}`] : [];
    const pub = await getPublicUrl().catch(() => '');
    if (pub) out.push(pub);
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Token handling shared by HTTP and WebSocket

interface TokenContext {
  sess: ProxySession;
  prefix: string;
  target: string;
}

/** Validate a tokenized URL; null when the URL is not tokenized. Throws on expired/invalid tokens. */
function tokenContext(req: FastifyRequest<{ Params: Params }>): TokenContext | null | 'expired' {
  const { id, uiId } = req.params;
  const tokenPrefix = `${basePath(id, uiId)}/${TOKEN_SEGMENT}/`;
  const rawUrl = req.raw.url ?? '';
  if (!rawUrl.startsWith(tokenPrefix)) return null;
  const afterPrefix = rawUrl.slice(tokenPrefix.length);
  const slash = afterPrefix.search(/[/?]/);
  const token = slash >= 0 ? afterPrefix.slice(0, slash) : afterPrefix;
  const sess = sessions.get(token);
  const now = Date.now();
  if (!sess || sess.serverId !== id || sess.uiId !== uiId || now - sess.lastUsed > TOKEN_IDLE_MS || now - sess.createdAt > TOKEN_MAX_MS) {
    if (sess) sessions.delete(token);
    return 'expired';
  }
  sess.lastUsed = now;
  const prefix = `${tokenPrefix}${token}`;
  const target = upstreamTarget(rawUrl, prefix);
  if (!target) throw new AppError(400, 'bad_request', 'Invalid web UI path');
  return { sess, prefix, target };
}

function absoluteRewrite(req: FastifyRequest, upstreamHost: string): AbsoluteRewrite | undefined {
  const host = req.headers.host ?? '';
  if (!/^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host)) return undefined;
  const xfp = String(req.headers['x-forwarded-proto'] ?? '');
  const cfVisitor = String(req.headers['cf-visitor'] ?? '');
  const secure = req.protocol === 'https' || /^https/i.test(xfp) || /"scheme"\s*:\s*"https"/.test(cfVisitor);
  return { upstreamHost, panelHost: host, secure };
}

// ---------------------------------------------------------------------------------------------
// HTTP

function httpHandler(deps: WebuiDeps) {
  return async function proxy(req: FastifyRequest<{ Params: Params }>, reply: FastifyReply): Promise<unknown> {
    const { id, uiId } = req.params;
    const base = basePath(id, uiId);
    const rawUrl = req.raw.url ?? '';
    const ctx = tokenContext(req);

    // 1) Cookie-authenticated entry: mint a proxy token and redirect into the tokenized URL space.
    if (ctx === null) {
      const userId = deps.currentUserId(req);
      const { ui } = await deps.resolve(req, id, uiId, userId);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw forbidden('Open the web UI first', 'webui_session_required');
      const token = newSession(userId, id, uiId);
      let rest = rawUrl.startsWith(base) ? rawUrl.slice(base.length) : '';
      if (rest === '' || rest === '/' || rest.startsWith('?')) rest = `${ui.path}${rest.startsWith('?') ? rest : ''}`;
      if (!upstreamTarget(rest, '')) rest = ui.path;
      return reply.header('Cache-Control', 'no-store').redirect(`${base}/${TOKEN_SEGMENT}/${token}${rest}`, 302);
    }
    if (ctx === 'expired') {
      // Send GETs back through the cookie entry point (which re-authenticates).
      if (req.method === 'GET' || req.method === 'HEAD') return reply.header('Cache-Control', 'no-store').redirect(base, 302);
      throw forbidden('The web UI session expired; reload it', 'webui_session_expired');
    }

    // 2) Tokenized request.
    const { sess, prefix, target } = ctx;
    const { ui, upstream: getUpstream, headHtml } = await deps.resolve(req, id, uiId, sess.userId);
    const { host: ip, port, basicAuth } = await getUpstream();
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    const upstreamHost = `${ip}:${port}`;
    const headers = upstreamRequestHeaders(req.headers, {
      upstreamHost,
      cookie: sess.jar.header(),
      basicAuth,
      bodyLength: body ? body.length : req.method === 'GET' || req.method === 'HEAD' ? null : 0,
    });

    const upstream = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const r = http.request({ host: ip, port, method: req.method, path: target, headers, timeout: UPSTREAM_TIMEOUT_MS }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(new AppError(502, 'webui_too_large', 'The web UI response is too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', () => reject(unreachable()));
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', () => reject(unreachable()));
      // Overall deadline (a slow trickle would otherwise keep resetting the socket timeout).
      const deadline = setTimeout(() => r.destroy(new Error('timeout')), UPSTREAM_TIMEOUT_MS);
      deadline.unref();
      r.on('close', () => clearTimeout(deadline));
      if (body && body.length) r.end(body);
      else r.end();
    });

    sess.jar.setAll(upstream.headers['set-cookie']);
    const out = filterResponseHeaders(upstream.headers);
    if (typeof out.location === 'string') out.location = rewriteLocation(out.location, prefix, `http://${upstreamHost}`);
    out['content-security-policy'] = responseCsp(upstream.headers['content-security-policy']);
    // The sandboxed page has an opaque origin: its own module scripts and fetches need CORS to load. Safe: the
    // URL carries the secret proxy token and no cookies or credentials are involved.
    out['access-control-allow-origin'] = '*';
    out['referrer-policy'] = 'no-referrer';
    out['x-content-type-options'] = 'nosniff';
    if (!out['cache-control']) out['cache-control'] = 'private, no-cache';

    let payload = upstream.body;
    const kind = ui.rewrite ? textKindOf(upstream.headers['content-type']) : null;
    if (kind && payload.length) {
      const enc = charsetOf(upstream.headers['content-type']);
      payload = Buffer.from(rewriteBody(payload.toString(enc), kind, prefix, absoluteRewrite(req, upstreamHost)), enc);
    }
    if (headHtml && textKindOf(upstream.headers['content-type']) === 'html' && payload.length) {
      const enc = charsetOf(upstream.headers['content-type']);
      payload = Buffer.from(injectHead(payload.toString(enc), headHtml), enc);
    }
    reply.code(upstream.status);
    for (const [k, v] of Object.entries(out)) reply.header(k, v);
    return reply.send(req.method === 'HEAD' ? undefined : payload);
  };
}

// ---------------------------------------------------------------------------------------------
// WebSocket

interface WsBridge {
  serverId: string;
  userId: string;
  client: WebSocket | null;
  upstream: WebSocket;
}

/** Live bridges per server (closed when the server stops) and counts per server+user (limit). */
const bridges = new Map<string, Set<WsBridge>>();

function countFor(serverId: string, userId: string): number {
  let n = 0;
  for (const b of bridges.get(serverId) ?? []) if (b.userId === userId) n++;
  return n;
}

function track(b: WsBridge): void {
  let set = bridges.get(b.serverId);
  if (!set) bridges.set(b.serverId, (set = new Set()));
  set.add(b);
}

function untrack(b: WsBridge): void {
  const set = bridges.get(b.serverId);
  set?.delete(b);
  if (set && !set.size) bridges.delete(b.serverId);
}

/** Close every proxied WebSocket of a server (it stops/restarts/crashed). */
export function closeWebuiSockets(serverId: string, code = 1001, reason = 'server stopped'): number {
  const set = bridges.get(serverId);
  if (!set) return 0;
  let n = 0;
  for (const b of [...set]) {
    n++;
    if (b.client && b.client.readyState === WebSocket.OPEN) b.client.close(code, reason);
    else b.client?.terminate();
    if (b.upstream.readyState === WebSocket.OPEN) b.upstream.close(1001, 'proxy closing');
    else b.upstream.terminate();
    untrack(b);
  }
  return n;
}

let statusHooked = false;
function hookServerStatus(): void {
  if (statusHooked) return;
  statusHooked = true;
  bus.on('status', (serverId: string, status: ServerStatus) => {
    if (status !== 'running' && status !== 'starting') closeWebuiSockets(serverId);
  });
}

/** State parked on the raw request between the pre-upgrade hook and the WebSocket handler. */
interface PendingUpgrade {
  bridge: WsBridge;
  early: { data: RawData; isBinary: boolean }[];
  earlyBytes: number;
  upstreamClosed: { code: number; reason: Buffer } | null;
  onEarly: (data: RawData, isBinary: boolean) => void;
  onEarlyClose: (code: number, reason: Buffer) => void;
  expire: NodeJS.Timeout;
}
const PENDING = Symbol('servcrafty.webui.pending');
type RawWithPending = http.IncomingMessage & { [PENDING]?: PendingUpgrade; [WS_PROTOCOL_KEY]?: string };

function rawSize(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}

/**
 * Connect to the upstream WebSocket; resolves once open, rejects with 502 otherwise. `onEarly` is
 * attached before the handshake completes (a server may send right after accepting).
 */
function connectUpstream(
  url: string,
  protocols: string[],
  headers: Record<string, string>,
  onEarly: (data: RawData, isBinary: boolean) => void,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, {
      headers,
      maxPayload: WS_MAX_MESSAGE_BYTES,
      handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
      perMessageDeflate: false,
      followRedirects: false,
    });
    ws.on('message', onEarly);
    const fail = () => {
      ws.removeAllListeners('open');
      ws.terminate();
      reject(unreachable('The web UI WebSocket is not reachable'));
    };
    ws.once('open', () => {
      ws.removeListener('error', fail);
      ws.removeListener('unexpected-response', fail);
      ws.on('error', () => undefined);
      resolve(ws);
    });
    ws.once('error', fail);
    ws.once('unexpected-response', fail);
  });
}

/**
 * Runs before the upgrade is accepted: token, access, `websocket` flag, Origin, limits, then the
 * upstream handshake (so the client gets the upstream's subprotocol, or an HTTP 502 when it is down).
 */
function wsPrepare(deps: WebuiDeps) {
  return async function prepare(req: FastifyRequest<{ Params: Params }>): Promise<void> {
    if (!req.ws) return;
    const { id, uiId } = req.params;
    const ctx = tokenContext(req);
    if (ctx === null) throw new AppError(400, 'webui_session_required', 'WebSocket connections need the web UI session URL');
    if (ctx === 'expired') throw forbidden('The web UI session expired; reload it', 'webui_session_expired');
    const { ui, upstream: getUpstream } = await deps.resolve(req, id, uiId, ctx.sess.userId);
    if (!ui.websocket) throw new AppError(400, 'webui_websocket_disabled', 'This web UI does not allow WebSocket connections');
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!wsOriginAllowed(origin, await deps.panelOrigins(req))) throw forbidden('Origin not allowed', 'origin_not_allowed');
    if (countFor(id, ctx.sess.userId) >= WS_MAX_PER_SERVER_USER) {
      throw new AppError(429, 'too_many_websockets', `At most ${WS_MAX_PER_SERVER_USER} web UI connections per server`);
    }
    const up = await getUpstream();
    const early: PendingUpgrade['early'] = [];
    let earlyBytes = 0;
    let upstreamRef: WebSocket | null = null;
    const onEarly = (data: RawData, isBinary: boolean) => {
      earlyBytes += rawSize(data);
      if (earlyBytes > WS_HIGH_WATER_BYTES) upstreamRef?.terminate();
      else early.push({ data, isBinary });
    };
    const upstream = await connectUpstream(
      `ws://${up.host}:${up.port}${ctx.target}`,
      parseProtocols(req.headers['sec-websocket-protocol']),
      upstreamWsHeaders({ upstreamHost: `${up.host}:${up.port}`, cookie: ctx.sess.jar.header(), basicAuth: up.basicAuth }),
      onEarly,
    );
    upstreamRef = upstream;
    const bridge: WsBridge = { serverId: id, userId: ctx.sess.userId, client: null, upstream };
    track(bridge);
    const pending: PendingUpgrade = {
      bridge,
      early,
      earlyBytes,
      upstreamClosed: null,
      onEarly,
      onEarlyClose: (code, reason) => (pending.upstreamClosed = { code, reason }),
      // The client handshake normally follows immediately; never leave an orphan upstream behind.
      expire: setTimeout(() => {
        if (!bridge.client) {
          upstream.terminate();
          untrack(bridge);
        }
      }, WS_HANDSHAKE_TIMEOUT_MS),
    };
    pending.expire.unref();
    upstream.once('close', pending.onEarlyClose);
    const raw = req.raw as RawWithPending;
    raw[PENDING] = pending;
    raw[WS_PROTOCOL_KEY] = upstream.protocol || '';
  };
}

/** Relay `from` -> `to` with backpressure: pause `from` while `to` has too much queued. */
function relay(from: WebSocket, to: WebSocket, touch: () => void): void {
  let drain: NodeJS.Timeout | null = null;
  from.on('message', (data: RawData, isBinary: boolean) => {
    touch();
    if (to.readyState !== WebSocket.OPEN) return;
    to.send(data, { binary: isBinary });
    if (to.bufferedAmount > WS_HIGH_WATER_BYTES && !drain) {
      from.pause();
      drain = setInterval(() => {
        if (to.readyState !== WebSocket.OPEN || to.bufferedAmount <= WS_HIGH_WATER_BYTES / 4) {
          clearInterval(drain!);
          drain = null;
          if (from.readyState === WebSocket.OPEN) from.resume();
        }
      }, 50);
      drain.unref();
    }
  });
  from.on('ping', (data: Buffer) => {
    touch();
    if (to.readyState === WebSocket.OPEN) to.ping(data);
  });
  from.on('close', () => {
    if (drain) clearInterval(drain);
  });
}

function wsHandler(socket: WebSocket, req: FastifyRequest): void {
  const raw = req.raw as RawWithPending;
  const pending = raw[PENDING];
  delete raw[PENDING];
  if (!pending) {
    socket.close(1011, 'not prepared');
    return;
  }
  clearTimeout(pending.expire);
  const { bridge } = pending;
  const upstream = bridge.upstream;
  bridge.client = socket;
  upstream.removeListener('message', pending.onEarly);
  upstream.removeListener('close', pending.onEarlyClose);

  let idle: NodeJS.Timeout | null = null;
  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      socket.close(1001, 'idle timeout');
      upstream.close(1001, 'idle timeout');
    }, WS_IDLE_MS);
    idle.unref();
  };
  touch();

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    if (idle) clearTimeout(idle);
    untrack(bridge);
  };
  socket.on('error', () => undefined);
  upstream.on('error', () => {
    if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'upstream error');
  });
  socket.on('close', (code: number, reason: Buffer) => {
    finish();
    if (upstream.readyState === WebSocket.OPEN) upstream.close(forwardCloseCode(code), closeReason(reason));
    else upstream.terminate();
  });
  upstream.on('close', (code: number, reason: Buffer) => {
    finish();
    if (socket.readyState === WebSocket.OPEN) socket.close(forwardCloseCode(code, 1011), closeReason(reason));
  });

  relay(socket, upstream, touch);
  relay(upstream, socket, touch);
  for (const m of pending.early) socket.send(m.data, { binary: m.isBinary });
  if (pending.upstreamClosed) {
    finish();
    socket.close(forwardCloseCode(pending.upstreamClosed.code, 1011), closeReason(pending.upstreamClosed.reason));
  }
}

/**
 * `handleProtocols` for the panel's WebSocket server: proxied upgrades answer with the subprotocol
 * the upstream chose; every other route keeps the `ws` default (the first offered protocol).
 */
export function selectProtocol(protocols: Set<string>, request: http.IncomingMessage): string | false {
  const chosen = (request as RawWithPending)[WS_PROTOCOL_KEY];
  if (chosen !== undefined) return chosen && protocols.has(chosen) ? chosen : false;
  const first = protocols.values().next();
  return first.done ? false : first.value;
}

// ---------------------------------------------------------------------------------------------
// Routes

export function webuiRoutesWith(deps: WebuiDeps) {
  return async function webuiRoutes(app: FastifyInstance): Promise<void> {
    hookServerStatus();
    // Raw bodies of any type are passed through (forms, JSON, uploads) up to the request cap.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_REQUEST_BYTES }, (_req, body, done) => done(null, body));
    const handler = httpHandler(deps);
    const prepare = wsPrepare(deps);
    for (const url of ['/servers/:id/webui/:uiId', '/servers/:id/webui/:uiId/*']) {
      // Request URLs carry proxy tokens: keep them out of the info-level request log.
      app.route<{ Params: Params }>({ method: 'GET', url, logLevel: 'warn', preValidation: prepare, handler, wsHandler });
      app.route<{ Params: Params }>({ method: ['DELETE', 'PATCH', 'POST', 'PUT', 'OPTIONS'], url, logLevel: 'warn', handler });
    }
  };
}

export default webuiRoutesWith(realDeps);

/** Test hooks. */
export const __webuiSessions = sessions;
export function __mintWebuiSession(userId: string, serverId: string, uiId: string): string {
  return newSession(userId, serverId, uiId);
}
export const __webuiBridges = bridges;
