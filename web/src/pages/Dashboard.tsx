import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Cpu, MemoryStick, Plus, Server as ServerIcon, Upload, Users } from 'lucide-react';
import { accountApi } from '@/api';
import type { Server, ServerStatus } from '@/api/types';
import { useT } from '@/i18n';
import { useServers, qk } from '@/lib/queries';
import { canOperate } from '@/lib/access';
import { variantLabel } from '@/lib/games';
import { GameBadge } from '@/components/GameBits';
import { formatMb, formatNumber } from '@/lib/format';
import { quotaRows } from '@/lib/quota';
import { Badge, Button, EmptyState, ErrorState, LinkButton, Loading, Meter, PageHeader } from '@/components/ui';
import { StatusBadge } from '@/components/StatusBadge';
import { PowerButtons } from '@/components/PowerButtons';
import { CopyAddress } from '@/components/CopyAddress';
import { ImportDialog } from '@/components/ImportDialog';

const stripe: Record<ServerStatus, string> = {
  running: 'bg-ok',
  starting: 'bg-warn',
  stopping: 'bg-warn',
  installing: 'bg-accent',
  crashed: 'bg-danger',
  stopped: 'bg-line',
};

function QuotaStrip() {
  const t = useT();
  const { data } = useQuery({ queryKey: qk.quota, queryFn: accountApi.quota });
  if (!data) return null;
  const fmts = { servers: (n: number) => formatNumber(n), ram: formatMb, cpu: (n: number) => formatNumber(n, 1), disk: formatMb };
  const items = quotaRows(data).map((r) => ({ label: t(`quota.${r.key}`), used: r.used, max: r.max, fmt: fmts[r.key], hostBound: r.hostBound }));
  return (
    <div className="mb-6 grid grid-cols-2 gap-x-6 gap-y-3 border-y border-line py-3 sm:grid-cols-4">
      {items.map((i) => (
        <div key={i.label}>
          <div className="flex justify-between text-xs text-muted">
            <span>{i.label}</span>
            <span className="tabular-nums" title={i.hostBound ? t('quota.hostBound') : undefined}>
              {i.fmt(i.used)} / {i.max === null || i.max === undefined ? '∞' : i.fmt(i.max)}
            </span>
          </div>
          {i.max ? <Meter className="mt-1.5 h-1.5" value={i.used} max={i.max} tone={i.used / i.max > 0.9 ? 'warn' : 'accent'} /> : <div className="mt-1.5 h-1.5 rounded-[2px] bg-raised" />}
        </div>
      ))}
    </div>
  );
}

function ServerRow({ server }: { server: Server }) {
  const t = useT();
  return (
    <div className="group relative flex flex-col gap-3 overflow-hidden rounded-md border border-line bg-surface p-4 pl-5 sm:flex-row sm:items-center sm:gap-6">
      <span className={clsx('absolute inset-y-0 left-0 w-1.5', stripe[server.status] ?? 'bg-line')} />
      <Link to={`/servers/${server.id}`} className="min-w-0 flex-1 after:absolute after:inset-0 after:content-['']">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="truncate text-lg font-semibold group-hover:text-accent">{server.name}</h2>
          {server.access !== 'owner' && server.access !== 'admin' && <Badge>{t(`access.${server.access}`)}</Badge>}
          {server.gameBlocked ? (
            <Badge tone="danger">{t('gameAccess.badgeBlocked')}</Badge>
          ) : server.gameDisabled ? (
            <Badge tone="warn">{t('gameAccess.disabledBadge')}</Badge>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <GameBadge server={server} />
          <span>{variantLabel(server, t, false)}</span>
          {server.modpack?.name && <span className="truncate">{server.modpack.name}</span>}
          <span className="font-mono text-xs">:{server.port}</span>
        </div>
      </Link>
      <div className="flex items-center gap-5 text-sm text-muted">
        <span className="inline-flex items-center gap-1.5" title={t('server.memory')}>
          <MemoryStick className="h-4 w-4" />
          {formatMb(server.memoryMb)}
        </span>
        <span className="inline-flex items-center gap-1.5" title={t('server.cpu')}>
          <Cpu className="h-4 w-4" />
          {formatNumber(server.cpu, 1)}
        </span>
        {server.ownerName && (
          <span className="hidden items-center gap-1.5 xl:inline-flex" title={t('server.owner')}>
            <Users className="h-4 w-4" />
            {server.ownerName}
          </span>
        )}
      </div>
      <div className="w-28 shrink-0">
        <StatusBadge status={server.status} />
      </div>
      <div className="relative z-10 flex items-start gap-2">
        <CopyAddress server={server} compact />
        {canOperate(server.access) && <PowerButtons server={server} compact />}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const t = useT();
  const { data, isLoading, error, refetch } = useServers();
  const [importOpen, setImportOpen] = useState(false);
  const running = data?.filter((s) => s.status === 'running').length ?? 0;

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        subtitle={data ? t('dashboard.summary', { total: data.length, running }) : undefined}
        actions={
          <>
            <Button onClick={() => setImportOpen(true)} icon={<Upload className="h-4 w-4" />}>
              {t('import.title')}
            </Button>
            <LinkButton to="/servers/new" variant="primary" icon={<Plus className="h-4 w-4" />}>
                {t('dashboard.create')}
              </LinkButton>
          </>
        }
      />
      <QuotaStrip />
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !data?.length ? (
        <div className="panel">
          <EmptyState
            icon={<ServerIcon className="h-10 w-10" />}
            title={t('dashboard.emptyTitle')}
            body={t('dashboard.emptyBody')}
            action={
              <LinkButton to="/servers/new" variant="primary" icon={<Plus className="h-4 w-4" />}>
                {t('dashboard.create')}
              </LinkButton>
            }
          />
        </div>
      ) : (
        <div className="space-y-2.5">
          {data.map((s) => (
            <ServerRow key={s.id} server={s} />
          ))}
        </div>
      )}
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
