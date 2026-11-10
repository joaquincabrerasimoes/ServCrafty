import { Navigate, NavLink, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { Copy } from 'lucide-react';
import type { GameSummary, Server } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { useServer } from '@/lib/queries';
import { canManage, canOperate, isFull } from '@/lib/access';
import { serverCaps, variantLabel, type GameCaps } from '@/lib/games';
import { hasWorkshop, useServerGameDef, webuiFor } from '@/lib/gameDefs';
import { GameBadge } from '@/components/GameBits';
import { useLiveServer, type LiveServer } from '@/ws/live';
import { Badge, ErrorState, Loading } from '@/components/ui';
import { StatusBadge } from '@/components/StatusBadge';
import { PowerButtons } from '@/components/PowerButtons';
import { CopyAddress, usePublicServersHost } from '@/components/CopyAddress';
import { toast } from '@/stores/toast';

export interface ServerCtx {
  server: Server;
  live: LiveServer & { conn: string };
  /** SteamCMD servers: the game definition (from GET /games); undefined otherwise or while loading. */
  def?: GameSummary;
}
export const useServerCtx = () => useOutletContext<ServerCtx>();

type TabCaps = GameCaps & { workshop: boolean };
const TABS: Array<{ path: string; key: TKey; need: (a: Server['access']) => boolean; show?: (c: TabCaps) => boolean }> = [
  { path: '', key: 'tab.overview', need: () => true },
  { path: 'console', key: 'tab.console', need: () => true },
  { path: 'players', key: 'tab.players', need: () => true },
  { path: 'files', key: 'tab.files', need: canManage },
  { path: 'properties', key: 'tab.properties', need: canManage, show: (c) => c.hasProperties },
  { path: 'mods', key: 'tab.mods', need: canManage, show: (c) => c.hasMods },
  { path: 'workshop', key: 'tab.workshop', need: canManage, show: (c) => c.workshop },
  { path: 'backups', key: 'tab.backups', need: canOperate },
  { path: 'schedules', key: 'tab.schedules', need: canManage },
  { path: 'webhooks', key: 'tab.webhooks', need: canManage },
  { path: 'sharing', key: 'tab.sharing', need: canManage },
  { path: 'transfer', key: 'tab.transfer', need: canManage, show: (c) => c.hasTransfer },
  { path: 'settings', key: 'tab.settings', need: canManage },
];

export default function ServerLayout() {
  const t = useT();
  const { id = '' } = useParams();
  const { data: server, isLoading, error, refetch } = useServer(id);
  const live = useLiveServer(server ? id : undefined);
  const { pathname } = useLocation();
  const publicHost = usePublicServersHost();
  const { def, settled } = useServerGameDef(server);

  if (isLoading) return <Loading />;
  if (error || !server) return <ErrorState error={error ?? new Error(t('server.notFound'))} onRetry={() => void refetch()} />;

  const status = live.status ?? server.status;
  const address = `${publicHost || location.hostname}:${server.port}`;
  const caps: TabCaps = { ...serverCaps(server), workshop: hasWorkshop(def) };
  const hidden = TABS.filter((tab) => tab.show && !tab.show(caps)).map((tab) => tab.path);
  const webuis = webuiFor(def, server.access);
  // A tab this game does not have (old link, bookmark): go to the overview instead. Tabs that depend
  // on the game definition are only judged once it has loaded.
  const parts = pathname.split('/').filter(Boolean);
  const sub = parts[2];
  const unknownWebui = sub === 'webui' && settled && !webuis.some((w) => w.id === decodeURIComponent(parts[3] ?? ''));
  if (sub && settled && (hidden.includes(sub) || unknownWebui)) return <Navigate to={`/servers/${encodeURIComponent(id)}`} replace />;
  const tabs = TABS.filter((tab) => tab.need(server.access) && !hidden.includes(tab.path)).map((tab) => ({ path: tab.path, label: t(tab.key) }));
  // One tab per web UI of the game, after Files.
  const at = tabs.findIndex((tab) => tab.path === 'files');
  tabs.splice(at >= 0 ? at + 1 : tabs.length, 0, ...webuis.map((w) => ({ path: `webui/${encodeURIComponent(w.id)}`, label: w.label || w.id })));

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
            <GameBadge server={server} />
            <span>{variantLabel(server, t)}</span>
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
        <div className="flex flex-wrap items-start gap-2">
          {canOperate(server.access) && <PowerButtons server={server} status={status} />}
          <CopyAddress server={server} />
        </div>
      </div>

      <nav className="scrollbar-thin -mx-4 mb-6 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
        <div className="flex min-w-max gap-1">
          {tabs.map((tab) => (
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
              {tab.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <Outlet context={{ server: { ...server, status }, live, def } satisfies ServerCtx} />
    </div>
  );
}
