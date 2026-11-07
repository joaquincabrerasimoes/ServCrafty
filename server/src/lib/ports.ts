import { badRequest } from './errors.js';

export const MAX_POOL_SIZE = 10_000;

/** Parse a pool spec like "25565-25600,25700" into a sorted unique port list. */
export function parsePortPool(spec: string): number[] {
  const out = new Set<number>();
  for (const partRaw of spec.split(/[,\s]+/)) {
    const part = partRaw.trim();
    if (!part) continue;
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if (!m) throw badRequest(`Invalid port pool entry "${part}"`, 'invalid_port_pool');
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || a > b) throw badRequest(`Invalid port range "${part}"`, 'invalid_port_pool');
    for (let p = a; p <= b; p++) {
      out.add(p);
      if (out.size > MAX_POOL_SIZE) throw badRequest('Port pool too large', 'invalid_port_pool');
    }
  }
  return [...out].sort((x, y) => x - y);
}

/** Inverse of parsePortPool: compress a port list into a canonical spec string. */
export function formatPortPool(ports: number[]): string {
  const sorted = [...new Set(ports)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!;
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) end = sorted[++i]!;
    parts.push(start === end ? String(start) : `${start}-${end}`);
    i++;
  }
  return parts.join(',');
}
