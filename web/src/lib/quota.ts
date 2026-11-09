import type { QuotaResponse } from '@/api/types';

/**
 * The limit that really applies to this user for one resource: their own quota and the share of the
 * host-wide cap that is still free (what they use now plus what nobody uses), whichever is lower.
 * null = nothing limits it, which is the only case shown as "infinite".
 */
export function effectiveMax(userMax: number | null | undefined, used: number, hostMax: number | null | undefined, hostUsed: number): number | null {
  const own = userMax == null ? null : Number(userMax);
  const cap = hostMax == null ? null : used + Math.max(0, Number(hostMax) - hostUsed);
  if (own === null) return cap;
  if (cap === null) return own;
  return Math.min(own, cap);
}

export interface QuotaRow {
  key: 'servers' | 'ram' | 'cpu' | 'disk';
  used: number;
  max: number | null;
  /** True when the host cap, not the user's own quota, is what limits it. */
  hostBound: boolean;
}

export function quotaRows(q: QuotaResponse): QuotaRow[] {
  const { limits: l, usage: u, host: h } = q;
  const pick = (key: QuotaRow['key'], userMax: number | null | undefined, used: number, hostMax: number | null | undefined, hostUsed: number): QuotaRow => {
    const max = effectiveMax(userMax, used, hostMax, hostUsed);
    return { key, used, max, hostBound: max !== null && (userMax == null || max < Number(userMax)) };
  };
  return [
    pick('servers', l.maxServers, u.servers, h?.limits.maxServers, h?.usage.servers ?? 0),
    pick('ram', l.maxRamMb, u.ram_mb, h?.limits.maxRamMb, h?.usage.ram_mb ?? 0),
    pick('cpu', l.maxCpu, u.cpu, h?.limits.maxCpu, h?.usage.cpu ?? 0),
    pick('disk', l.maxDiskMb, u.disk_mb, h?.limits.maxDiskMb, h?.usage.disk_mb ?? 0),
  ];
}
