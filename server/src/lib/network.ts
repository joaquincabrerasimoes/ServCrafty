import net from 'node:net';
import type { FastifyRequest } from 'fastify';
import { badRequest } from './errors.js';

/** An address range: the network address and how many leading bits are fixed. */
export interface Network {
  family: 4 | 6;
  /** Network address as an integer (host bits cleared). */
  base: bigint;
  prefix: number;
}

/** Strip an IPv4-mapped IPv6 prefix ("::ffff:192.168.1.5" -> "192.168.1.5"). */
function normalize(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip.trim());
  return (m?.[1] ?? ip.trim()).toLowerCase();
}

function v4ToInt(ip: string): bigint {
  return ip.split('.').reduce((acc, o) => (acc << 8n) | BigInt(o), 0n);
}

function v6ToInt(ip: string): bigint {
  // Expand "::" and an embedded IPv4 tail, then read eight 16-bit groups.
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)?.[1];
  if (tail) {
    const n = v4ToInt(tail);
    s = s.slice(0, -tail.length) + ((n >> 16n) & 0xffffn).toString(16) + ':' + (n & 0xffffn).toString(16);
  }
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const r = rest === undefined ? [] : rest ? rest.split(':') : [];
  const groups = rest === undefined ? h : [...h, ...Array<string>(8 - h.length - r.length).fill('0'), ...r];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
}

function toInt(ip: string): { family: 4 | 6; value: bigint } | null {
  const a = normalize(ip);
  if (net.isIPv4(a)) return { family: 4, value: v4ToInt(a) };
  if (net.isIPv6(a)) return { family: 6, value: v6ToInt(a) };
  return null;
}

function maskToPrefix(mask: string): number | null {
  if (!net.isIPv4(mask)) return null;
  const bits = v4ToInt(mask).toString(2).padStart(32, '0');
  // A valid subnet mask is a run of ones followed by zeros.
  if (!/^1*0*$/.test(bits)) return null;
  const zero = bits.indexOf('0');
  return zero === -1 ? 32 : zero;
}

function makeNetwork(addr: string, prefix: number): Network | null {
  const a = toInt(addr);
  if (!a) return null;
  const width = a.family === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return null;
  const hostBits = BigInt(width - prefix);
  return { family: a.family, base: (a.value >> hostBits) << hostBits, prefix };
}

/**
 * Parse a list of ranges separated by commas or new lines. Each entry is "192.168.69.0/24" (CIDR) or
 * "192.168.69.0 255.255.255.0" (address and subnet mask); IPv6 uses CIDR only. Throws a 400 on bad input.
 */
export function parseNetworks(spec: string): Network[] {
  const out: Network[] = [];
  for (const raw of spec.split(/[,\n;]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    let n: Network | null = null;
    const cidr = /^([^\s/]+)\/(\d{1,3})$/.exec(entry);
    const masked = /^(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})$/.exec(entry);
    if (cidr) n = makeNetwork(cidr[1]!, Number(cidr[2]));
    else if (masked) {
      const p = maskToPrefix(masked[2]!);
      n = p === null ? null : makeNetwork(masked[1]!, p);
    }
    if (!n) throw badRequest(`Not a valid network: "${entry}". Use 192.168.69.0/24 or "192.168.69.0 255.255.255.0".`, 'invalid_lan_networks');
    out.push(n);
  }
  return out;
}

export function ipInNetworks(ip: string | undefined | null, nets: Network[]): boolean {
  if (!ip) return false;
  const a = toInt(ip);
  if (!a) return false;
  return nets.some((n) => {
    if (n.family !== a.family) return false;
    const hostBits = BigInt((n.family === 4 ? 32 : 128) - n.prefix);
    return (a.value >> hostBits) << hostBits === n.base;
  });
}

/** Headers that Cloudflare (and cloudflared) always add to proxied traffic. */
const CLOUDFLARE_HEADERS = ['cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cf-connecting-ipv6'];

export function hasCloudflareHeaders(headers: Record<string, string | string[] | undefined>): boolean {
  if (CLOUDFLARE_HEADERS.some((h) => headers[h] !== undefined)) return true;
  const loop = headers['cdn-loop'];
  return /cloudflare/i.test(Array.isArray(loop) ? loop.join(',') : (loop ?? ''));
}

/**
 * Did this request arrive from outside the configured LAN? Remote = it carries Cloudflare headers (it came
 * through the tunnel, even though cloudflared itself connects from a LAN address) OR the connecting socket is
 * outside every range. The socket address is used, not X-Forwarded-For, which a client can forge.
 */
export function isRemoteRequest(req: Pick<FastifyRequest, 'headers' | 'raw'>, lan: Network[]): boolean {
  if (hasCloudflareHeaders(req.headers)) return true;
  return !ipInNetworks(req.raw.socket?.remoteAddress, lan);
}
