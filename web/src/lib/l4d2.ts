import { useQuery } from '@tanstack/react-query';
import { l4d2Api, l4d2Keys } from '@/api/l4d2';
import { L4D_MODES, type L4dCampaign, type L4dChapter, type L4dGameMode } from '@/api/types';
import type { TFn, TKey } from '@/i18n';

/** Left 4 Dead 2 helpers shared by the Maps, Controls and Plugins tabs and the map picker. */

export const isMode = (m: unknown): m is L4dGameMode => typeof m === 'string' && (L4D_MODES as readonly string[]).includes(m);

export const modeLabel = (m: string, t: TFn) => (isMode(m) ? t(`l4d2.mode.${m}` as TKey) : m);

export const difficultyLabel = (d: string, t: TFn, fallback?: string) =>
  ['Easy', 'Normal', 'Hard', 'Impossible'].includes(d) ? t(`l4d2.difficulty.${d}` as TKey) : (fallback ?? d);

export const chaptersOf = (c: L4dCampaign | undefined, mode: L4dGameMode): L4dChapter[] => c?.modes[mode] ?? [];

/** Modes a campaign has chapters for, in the canonical order. */
export const modesOf = (c: L4dCampaign): L4dGameMode[] => L4D_MODES.filter((m) => (c.modes[m]?.length ?? 0) > 0);

/** The campaign (and chapter) a map belongs to: the given mode first, then any mode. */
export function findMap(campaigns: L4dCampaign[], map: string, mode?: L4dGameMode): { campaign: L4dCampaign; chapter: L4dChapter } | null {
  if (!map) return null;
  const lower = map.toLowerCase();
  const order = mode ? [mode, ...L4D_MODES.filter((m) => m !== mode)] : [...L4D_MODES];
  for (const m of order) {
    for (const c of campaigns) {
      const ch = c.modes[m]?.find((x) => x.map.toLowerCase() === lower);
      if (ch) return { campaign: c, chapter: ch };
    }
  }
  return null;
}

export const workshopUrl = (id: string) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`;

/** GET /servers/:id/l4d2/maps (disabled without a server id). */
export function useL4dMaps(serverId: string | undefined) {
  return useQuery({
    queryKey: l4d2Keys.maps(serverId ?? ''),
    queryFn: () => l4d2Api.maps(serverId!),
    enabled: !!serverId,
    staleTime: 30_000,
  });
}

/** Wait a moment so the game has applied a console command before reading its state again. */
export const settle = (ms = 1000) => new Promise((r) => setTimeout(r, ms));
