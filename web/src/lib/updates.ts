import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { healthApi, updateApi } from '@/api';
import { useIsAdmin } from '@/stores/auth';

export const updateQk = {
  info: ['admin-update'] as const,
  health: ['health'] as const,
};

/** How often the admin banner re-reads the (server-cached) update status. */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** "0.2.0" / "v0.2.0" -> "v0.2.0". */
export function fmtVersion(v: string | null | undefined): string {
  if (!v) return '–';
  return /^v/i.test(v) ? v : `v${v}`;
}

/** Update status for admins (null/disabled for everyone else). */
export function useUpdateInfo(opts: { refetchInterval?: number | false } = {}) {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: updateQk.info,
    queryFn: ({ signal }) => updateApi.get(signal),
    enabled: isAdmin,
    staleTime: 60_000,
    refetchInterval: opts.refetchInterval ?? UPDATE_CHECK_INTERVAL_MS,
    refetchOnWindowFocus: false,
  });
}

/** Version of the running panel, from /api/health (any user). */
export function useAppVersion(): string | null {
  const q = useQuery({
    queryKey: updateQk.health,
    queryFn: ({ signal }) => healthApi.get(signal),
    staleTime: 5 * 60_000,
    refetchInterval: UPDATE_CHECK_INTERVAL_MS,
    refetchOnWindowFocus: false,
  });
  return q.data?.version ?? null;
}

/* ------------------------------------------------------------ banner dismissal */

const DISMISS_KEY = 'servcrafty.update.dismissed';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/** Dismissal is remembered per version: a newer release shows the banner again. */
export function useBannerDismissal() {
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const dismiss = useCallback((version: string) => {
    try {
      localStorage.setItem(DISMISS_KEY, version);
    } catch {
      /* storage unavailable: dismiss for this session only */
    }
    setDismissed(version);
  }, []);
  return { dismissed, dismiss };
}

/** Reloads into the freshly installed version, nudging the service worker first. */
export async function reloadToNewVersion() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {
    /* no service worker (dev) or update failed: a plain reload still works */
  }
  window.location.reload();
}
