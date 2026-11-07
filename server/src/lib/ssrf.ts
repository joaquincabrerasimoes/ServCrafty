import dns from 'node:dns/promises';
import net from 'node:net';
import { badRequest } from './errors.js';

/** Escape hatch for self-hosters who notify services on their LAN (e.g. a local Discord bridge). */
export const allowPrivateWebhooks = (): boolean => ['1', 'true'].includes(process.env.ALLOW_PRIVATE_WEBHOOKS ?? '');

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net6, prefix, 'ipv6');

export function isPrivateAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, '').split('%')[0]!;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) return blocked.check(mapped[1]!, 'ipv4');
  const v = net.isIP(a);
  if (v === 0) return true;
  return blocked.check(a, v === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Reject webhook targets that resolve to loopback, private, link-local or otherwise
 * non-public addresses (SSRF), unless ALLOW_PRIVATE_WEBHOOKS=1.
 */
export async function assertPublicUrl(raw: string): Promise<void> {
  if (allowPrivateWebhooks()) return;
  const u = new URL(raw);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const msg = 'Webhook URL points to a private, loopback or link-local address (set ALLOW_PRIVATE_WEBHOOKS=1 to allow)';
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw badRequest(msg, 'webhook_url_private');
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw badRequest(`Cannot resolve webhook host "${host}"`, 'webhook_url_unresolvable');
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) throw badRequest(msg, 'webhook_url_private');
}
