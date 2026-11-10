import { Copy } from 'lucide-react';
import type { GameSummary, Server } from '@/api/types';
import { useT } from '@/i18n';
import { toast } from '@/stores/toast';
import { copy, usePublicServersHost } from '@/components/CopyAddress';
import { protocolLabel, serverPorts } from '@/components/GameBits';
import { Badge, IconButton } from '@/components/ui';

/** Host ports of a SteamCMD server (main port first) with protocol and a copy button each. */
export function SteamPorts({ server, def }: { server: Server; def?: GameSummary }) {
  const t = useT();
  const configured = usePublicServersHost();
  const host = configured || location.hostname;
  const ports = serverPorts(server, def, t('steam.mainPort'));
  return (
    <ul className="divide-y divide-line">
      {ports.map((p) => {
        const addr = p.hostPort ? `${host}:${p.hostPort}` : null;
        return (
          <li key={p.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span className="truncate">{p.label}</span>
                {p.main && <Badge tone="accent">{t('steam.mainPort')}</Badge>}
                {p.protocol && <Badge>{protocolLabel(p.protocol)}</Badge>}
              </div>
              <div className="mt-0.5 font-mono text-xs text-muted">
                {addr ?? t('steam.portNotPublished')}
                {p.containerPort !== undefined && p.containerPort !== p.hostPort && (
                  <span className="ms-2 font-sans">{t('steam.containerPort', { port: p.containerPort })}</span>
                )}
              </div>
            </div>
            {addr && (
              <IconButton
                label={t('steam.copyPort', { name: p.label })}
                className="h-10 w-10 shrink-0"
                onClick={() => void copy(addr).then((ok) => ok && toast.info(t('common.copied')))}
              >
                <Copy className="h-4 w-4" />
              </IconButton>
            )}
          </li>
        );
      })}
    </ul>
  );
}
