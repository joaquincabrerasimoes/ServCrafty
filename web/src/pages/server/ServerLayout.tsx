import { NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { Copy } from 'lucide-react';
import type { Server } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { useServer } from '@/lib/queries';
import { canManage, canOperate, isFull } from '@/lib/access';
import { useLiveServer, type LiveServer } from '@/ws/live';
import { Badge, ErrorState, Loading } from '@/components/ui';
import { StatusBadge } from '@/components/StatusBadge';
import { PowerButtons } from '@/components/PowerButtons';
import { toast } from '@/stores/toast';

export interface ServerCtx {
  server: Server;
  live: LiveServer & { conn: string };
}
export const useServerCtx = () => useOutletContext<ServerCtx>();

const TABS: Array<{ path: string; key: TKey; need: (a: Server['access']) => boolean }> = [
  { path: '', key: 'tab.overview', need: () => true },
  { path: 'console', key: 'tab.console', need: () => true },
  { path: 'players', key: 'tab.players', need: () => true },
  { path: 'files', key: 'tab.files', need: canManage },
  { path: 'properties', key: 'tab.properties', need: canManage },
  { path: 'mods', key: 'tab.mods', need: canManage },
  { path: 'backups', key: 'tab.backups', need: canOperate },
  { path: 'schedules', key: 'tab.schedules', need: canManage },
  { path: 'webhooks', key: 'tab.webhooks', need: canManage },
  { path: 'sharing', key: 'tab.sharing', need: canManage },
  { path: 'transfer', key: 'tab.transfer', need: canManage },
  { path: 'settings', key: 'tab.settings', need: canManage },
];

export default function ServerLayout() {
  const t = useT();
  const { id = '' } = useParams();
  const { data: server, isLoading, error, refetch } = useServer(id);
  const live = useLiveServer(server ? id : undefined);

  if (isLoading) return <Loading />;
  if (error || !server) return <ErrorState error={error ?? new Error(t('server.notFound'))} onRetry={() => void refetch()} />;

  const status = live.status ?? server.status;
  const address = `${location.hostname}:${server.port}`;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-bold sm:text-[1.75rem]">{server.name}</h1>
            <StatusBadge status={status} />
            {!isFull(server.access) && <Badge>{t(`access.${server.access}`)}</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span>
              {t(`type.${server.type}`)} {server.mcVersion}
              {server.loaderVersion ? ` · ${server.loaderVersion}` : ''}
            </span>
            {server.modpack?.name && <span>{server.modpack.name}</span>}
            <button
              className="inline-flex items-center gap-1.5 font-mono text-xs hover:text-ink"
              title={t('common.copy')}
              onClick={() => {
                void navigator.clipboard?.writeText(address);
                toast.info(t('common.copied'));
              }}
            >
              {address}
              <Copy className="h-3 w-3" />
            </button>
          </div>
        </div>
        {canOperate(server.access) && <PowerButtons server={server} status={status} />}
      </div>

      <nav className="scrollbar-thin -mx-4 mb-6 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
        <div className="flex min-w-max gap-1">
          {TABS.filter((tab) => tab.need(server.access)).map((tab) => (
            <NavLink
              key={tab.path}
              to={tab.path}
              end={tab.path === ''}
              className={({ isActive }) =>
                clsx(
                  '-mb-px border-b-2 px-3 py-2.5 text-sm',
                  isActive ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink',
                )
              }
            >
              {t(tab.key)}
            </NavLink>
          ))}
        </div>
      </nav>

      <Outlet context={{ server: { ...server, status }, live } satisfies ServerCtx} />
    </div>
  );
}
