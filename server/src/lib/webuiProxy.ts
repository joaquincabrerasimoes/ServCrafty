/**
 * Pure helpers of the game web UI reverse proxy (`routes/webui.ts`): URL rewriting of text bodies,
 * header filtering/rewriting and the per-session upstream cookie jar.
 */

export type TextKind = 'html' | 'css' | 'js';

/** Which bodies get root-absolute URLs rewritten. */
export function textKindOf(contentType: string | undefined): TextKind | null {
  const ct = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html';
  if (ct === 'text/css') return 'css';
  if (ct === 'text/javascript' || ct === 'application/javascript' || ct === 'application/x-javascript' || ct === 'application/ecmascript') {
    return 'js';
  }
  return null;
}

/** Node Buffer encoding for a content type's charset (bytes outside these round-trip via latin1). */
export function charsetOf(contentType: string | undefined): 'utf8' | 'latin1' {
  const m = /charset\s*=\s*"?([A-Za-z0-9_-]+)/i.exec(contentType ?? '');
  const cs = (m?.[1] ?? 'utf-8').toLowerCase();
  return cs === 'utf-8' || cs === 'utf8' ? 'utf8' : cs === 'iso-8859-1' || cs === 'latin1' || cs === 'windows-1252' || cs === 'us-ascii' ? 'latin1' : 'utf8';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Prefix root-absolute URLs with `base` (e.g. `/api/servers/<id>/webui/<ui>/~t/<token>`):
 * `href="/..."`, `src="/..."`, `action="/..."` (and similar attributes, quoted or not),
 * `url(/...)`, meta refresh `url=/...`, and string literals starting with `/<path char>`.
 * Protocol-relative `//host` URLs and already prefixed URLs are left alone.
 */
export interface AbsoluteRewrite {
  /** `ip:port` of the upstream as the game sees itself (the Host header the panel sends). */
  upstreamHost: string;
  /** Host the browser uses for the panel (request Host header). */
  panelHost: string;
  /** The browser reached the panel over TLS (https/wss). */
  secure: boolean;
}

export function rewriteBody(text: string, kind: TextKind, base: string, abs?: AbsoluteRewrite): string {
  const b = base.replace(/\/+$/, '');
  const already = escapeRe(b.slice(1)); // base without its leading slash
  const notPrefixed = `(?!\\/)(?!${already}(?:[/"'?#)\\s]|$))`;
  let out = text;
  if (abs) {
    // Absolute URLs naming the upstream itself (http:// and ws://, e.g. built from the Host header).
    const host = escapeRe(abs.upstreamHost);
    out = out.replace(new RegExp(`\\b(https?|wss?):\\/\\/${host}(?=[/"'?#\\s\`]|$)`, 'gi'), (_m, scheme: string) => {
      const ws = scheme.toLowerCase().startsWith('ws');
      const proto = ws ? (abs.secure ? 'wss' : 'ws') : abs.secure ? 'https' : 'http';
      return `${proto}://${abs.panelHost}${b}`;
    });
  }
  if (kind === 'html' || kind === 'js') {
    // `${location.host}/ws` (template literals) and location.host + "/" (concatenation): the path after
    // the panel host must go through the proxy too (the usual `new WebSocket(...)` construction).
    out = out.replace(
      new RegExp(`(\\$\\{\\s*(?:window\\.|document\\.|self\\.)?location\\.(?:host|origin)\\s*\\})\\/${notPrefixed}`, 'g'),
      `$1${b}/`,
    );
    out = out.replace(
      new RegExp(`((?:window\\.|document\\.|self\\.)?location\\.(?:host|origin)\\s*\\+\\s*)(["'\`])\\/${notPrefixed}`, 'g'),
      `$1$2${b}/`,
    );
  }
  if (kind === 'html') {
    const attrs = 'href|src|action|formaction|poster|background|data|longdesc|cite|manifest|icon';
    // Quoted attribute values, including a bare "/".
    out = out.replace(new RegExp(`(\\b(?:${attrs})\\s*=\\s*)(["'])\\/${notPrefixed}`, 'gi'), `$1$2${b}/`);
    // Unquoted attribute values.
    out = out.replace(new RegExp(`(\\b(?:${attrs})\\s*=\\s*)\\/${notPrefixed}`, 'gi'), `$1${b}/`);
    // <meta http-equiv="refresh" content="0; url=/x">
    out = out.replace(new RegExp(`(\\bcontent\\s*=\\s*["'][^"'>]*?\\burl\\s*=\\s*)\\/${notPrefixed}`, 'gi'), `$1${b}/`);
  }
  if (kind === 'html' || kind === 'css') {
    out = out.replace(new RegExp(`(\\burl\\(\\s*)(["']?)\\/${notPrefixed}`, 'gi'), `$1$2${b}/`);
  }
  // String literals that start with "/<path char>" (inline scripts, JS, CSS @import). A bare "/" is
  // not touched: in scripts it is far more often a separator (split("/")) than a URL.
  out = out.replace(new RegExp(`(["'\`])\\/(?=[A-Za-z0-9_~.%-])${notPrefixed}`, 'g'), `$1${b}/`);
  return out;
}

/**
 * Rewrite a `Location` header: same-upstream absolute URLs and root-absolute paths go through the
 * proxy; other absolute URLs are left as they are; relative ones resolve under the proxy already.
 */
export function rewriteLocation(loc: string, base: string, upstreamOrigin: string): string {
  const b = base.replace(/\/+$/, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(loc)) {
    try {
      const u = new URL(loc);
      if (u.origin === upstreamOrigin) return `${b}${u.pathname}${u.search}${u.hash}`;
    } catch {
      /* not a URL */
    }
    return loc;
  }
  if (loc.startsWith('//')) return loc;
  if (loc.startsWith('/')) return loc.startsWith(`${b}/`) || loc === b ? loc : `${b}${loc}`;
  return loc;
}

/** Remove `frame-ancestors` and `sandbox` from an upstream CSP; ours are appended by the caller. */
export function stripFrameDirectives(csp: string): string {
  return csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !/^(frame-ancestors|sandbox|report-uri|report-to)\b/i.test(d))
    .join('; ');
}

/**
 * Responses run sandboxed (opaque origin): upstream scripts cannot read the panel's cookies or call
 * the panel API as the viewer. Only the panel may frame them.
 */
export const PROXY_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors 'self'";

export function responseCsp(upstream: string | string[] | undefined): string {
  const list = Array.isArray(upstream) ? upstream : upstream ? [upstream] : [];
  const kept = list.map(stripFrameDirectives).filter(Boolean);
  return [...kept, PROXY_CSP].join('; ');
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

/** Request headers forwarded upstream (everything else, notably Cookie and Authorization, is dropped). */
const FORWARD_REQUEST = new Set([
  'accept',
  'accept-language',
  'content-type',
  'if-none-match',
  'if-modified-since',
  'cache-control',
  'pragma',
  'user-agent',
  'x-requested-with',
]);

export function upstreamRequestHeaders(
  incoming: Record<string, string | string[] | undefined>,
  opts: { upstreamHost: string; cookie: string | null; basicAuth: { user: string; password: string } | null; bodyLength: number | null },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (!FORWARD_REQUEST.has(key) || v === undefined) continue;
    out[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  out.host = opts.upstreamHost;
  // Plain bodies so text can be rewritten.
  out['accept-encoding'] = 'identity';
  // Same-origin as far as the game's web server can tell (forms from the sandboxed frame send "Origin: null").
  if (incoming.origin !== undefined) out.origin = `http://${opts.upstreamHost}`;
  if (opts.cookie) out.cookie = opts.cookie;
  if (opts.basicAuth) {
    out.authorization = `Basic ${Buffer.from(`${opts.basicAuth.user}:${opts.basicAuth.password}`, 'utf8').toString('base64')}`;
  }
  if (opts.bodyLength !== null) out['content-length'] = String(opts.bodyLength);
  return out;
}

/** Response headers dropped (hop-by-hop, framing/CSP handled separately, cookies kept server-side). */
const DROP_RESPONSE = new Set([
  ...HOP_BY_HOP,
  'content-length',
  'content-encoding',
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'set-cookie',
  'strict-transport-security',
  'alt-svc',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-expose-headers',
  'clear-site-data',
  'www-authenticate',
]);

export function filterResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || DROP_RESPONSE.has(k.toLowerCase())) continue;
    out[k.toLowerCase()] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Cookie jar (upstream cookies never reach the browser; the panel replays them upstream)

const MAX_COOKIES = 50;
const MAX_COOKIE_LEN = 4096;

export class CookieJar {
  private readonly jar = new Map<string, string>();

  /** Apply one `Set-Cookie` header value. */
  set(header: string, now = Date.now()): void {
    if (header.length > MAX_COOKIE_LEN) return;
    const [pair, ...attrs] = header.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (!pair || eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f;]/.test(value)) return;
    let expired = false;
    for (const a of attrs) {
      const [k, ...rest] = a.split('=');
      const key = (k ?? '').trim().toLowerCase();
      const v = rest.join('=').trim();
      if (key === 'max-age' && Number(v) <= 0) expired = true;
      if (key === 'expires') {
        const t = Date.parse(v);
        if (Number.isFinite(t) && t <= now) expired = true;
      }
    }
    if (expired) {
      this.jar.delete(name);
      return;
    }
    if (!this.jar.has(name) && this.jar.size >= MAX_COOKIES) return;
    this.jar.set(name, value);
  }

  setAll(headers: string | string[] | undefined): void {
    for (const h of Array.isArray(headers) ? headers : headers ? [headers] : []) this.set(h);
  }

  header(): string | null {
    if (!this.jar.size) return null;
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/**
 * The upstream request target from the raw request URL: everything after the proxy prefix
 * (`/api/servers/<id>/webui/<ui>/~t/<token>`). Returns null for anything that is not a plain
 * origin-form path (the host is never taken from the client).
 */
export function upstreamTarget(rawUrl: string, prefix: string): string | null {
  if (!rawUrl.startsWith(prefix)) return null;
  let rest = rawUrl.slice(prefix.length);
  if (rest === '' || rest.startsWith('?')) rest = `/${rest}`;
  if (!rest.startsWith('/')) return null;
  // Origin-form only: printable ASCII, no backslashes (some servers treat them as separators).
  if (!/^\/[\x21-\x7e]*$/.test(rest) || rest.includes('\\')) return null;
  // No dot segments (also percent-encoded): the path stays below the web UI's root.
  const pathPart = rest.split(/[?#]/)[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  if (decoded.split('/').some((seg) => seg === '..' || seg === '.') || decoded.includes('\\')) return null;
  return rest;
}

// ---------------------------------------------------------------------------------------------
// WebSocket bridge helpers

/** Largest single WebSocket message relayed in either direction. */
export const WS_MAX_MESSAGE_BYTES = 1024 * 1024;
/** Pause the sending side while the receiving side has this much queued. */
export const WS_HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const WS_MAX_PER_SERVER_USER = 20;
export const WS_IDLE_MS = 10 * 60_000;
/** Raw-request key carrying the subprotocol the upstream chose (read by the ws server's handleProtocols). */
export const WS_PROTOCOL_KEY = Symbol.for('servcrafty.webui.wsProtocol');

/**
 * Browser Origin of a proxied WebSocket: none (non-browser), `null` (the sandboxed proxied page) or
 * the panel's own origin are accepted; anything else is cross-site.
 */
export function wsOriginAllowed(origin: string | undefined, panelOrigins: string[]): boolean {
  if (origin === undefined || origin === '') return true;
  if (origin === 'null') return true;
  try {
    const o = new URL(origin).origin;
    return panelOrigins.some((p) => {
      try {
        return new URL(p).origin === o;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Subprotocols offered by the client (`Sec-WebSocket-Protocol`), validated as tokens. */
export function parseProtocols(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(p))
    .slice(0, 16);
}

/** A close code that may be sent on the wire (1005/1006/1015 are reserved for local use). */
export function forwardCloseCode(code: number | undefined, fallback = 1000): number {
  if (code === undefined) return fallback;
  if (code === 1000 || code === 1001 || code === 1002 || code === 1003) return code;
  if (code >= 1007 && code <= 1014) return code;
  if (code >= 3000 && code <= 4999) return code;
  return code === 1006 ? 1011 : fallback;
}

/** Close reasons are limited to 123 bytes on the wire. */
export function closeReason(reason: Buffer | string | undefined): string {
  const s = Buffer.isBuffer(reason) ? reason.toString('utf8') : (reason ?? '');
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch) > 123) break;
    out += ch;
  }
  return out;
}

/** Headers of the upstream WebSocket handshake (the browser's Cookie/Authorization/Origin are never used). */
export function upstreamWsHeaders(opts: {
  upstreamHost: string;
  cookie: string | null;
  basicAuth: { user: string; password: string } | null;
}): Record<string, string> {
  const h: Record<string, string> = { origin: `http://${opts.upstreamHost}` };
  if (opts.cookie) h.cookie = opts.cookie;
  if (opts.basicAuth) {
    h.authorization = `Basic ${Buffer.from(`${opts.basicAuth.user}:${opts.basicAuth.password}`, 'utf8').toString('base64')}`;
  }
  return h;
}
