import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { api } from '@/api/client';
import type { Server } from '@/api/types';
import { useT } from '@/i18n';
import { serverGame } from '@/lib/games';
import { useGameDefs } from '@/lib/gameDefs';
import { toast } from '@/stores/toast';
import { Button } from './ui';

export function usePublicConfig(): { publicServersHost: string; installType: 'lxc' | 'docker' } {
  const q = useQuery({
    queryKey: ['public-config'],
    queryFn: () => api.get<{ publicServersHost: string; installType?: 'lxc' | 'docker' }>('/public-config'),
    staleTime: 5 * 60_000,
  });
  return { publicServersHost: q.data?.publicServersHost ?? '', installType: q.data?.installType ?? 'docker' };
}

/** Host name players use from the internet (Admin > Settings); '' until it is configured. */
export function usePublicServersHost(): string {
  return usePublicConfig().publicServersHost;
}

export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure origins (plain http on the LAN).
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  }
}

/**
 * One button that opens a small menu: copy the server URL, the port, or URL:port, plus URL:port of
 * every extra port of a SteamCMD game (query, web admin, ...).
 */
export function CopyAddress({ server, compact }: { server: Server; compact?: boolean }) {
  const t = useT();
  const configured = usePublicServersHost();
  const extra = Object.entries(server.extraPorts ?? {});
  const defs = useGameDefs(serverGame(server) === 'steam' && extra.length > 0);
  const def = defs.data?.find((d) => d.id === server.steam?.gameId);
  const host = configured || location.hostname;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const items = [
    { key: 'url', label: t('copyAddr.url'), value: host },
    { key: 'port', label: t('copyAddr.port'), value: String(server.port) },
    { key: 'both', label: t('copyAddr.both'), value: `${host}:${server.port}` },
    ...extra.map(([id, port]) => ({
      key: `extra:${id}`,
      label: t('copyAddr.extra', { name: def?.ports?.find((p) => p.id === id)?.label || id }),
      value: `${host}:${port}`,
    })),
  ];

  return (
    <div ref={ref} className="relative">
      <Button size={compact ? 'sm' : 'md'} title={t('copyAddr.button')} aria-label={t('copyAddr.button')} onClick={() => setOpen((o) => !o)} icon={<Copy className="h-4 w-4" />}>
        {compact ? null : t('common.copy')}
      </Button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-1 shadow-lg">
          {items.map((i) => (
            <button
              key={i.key}
              className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-raised"
              onClick={() =>
                void copy(i.value).then((ok) => {
                  if (ok) toast.info(t('common.copied'));
                  setOpen(false);
                })
              }
            >
              <span className="min-w-0 truncate">{i.label}</span>
              <span className="max-w-[60%] truncate font-mono text-xs text-muted">{i.value}</span>
            </button>
          ))}
          {!configured && <p className="px-3 py-2 text-xs text-muted">{t('copyAddr.noHost')}</p>}
        </div>
      )}
    </div>
  );
}
