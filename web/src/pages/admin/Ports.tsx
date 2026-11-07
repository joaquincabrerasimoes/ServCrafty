import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { adminApi } from '@/api';
import { useT } from '@/i18n';
import { ErrorState, Loading, PageHeader } from '@/components/ui';

export default function Ports() {
  const t = useT();
  const q = useQuery({ queryKey: ['admin-ports'], queryFn: adminApi.ports });
  const [onlyUsed, setOnlyUsed] = useState(false);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const ports = q.data ?? [];
  const used = ports.filter((p) => p.serverId).length;
  const shown = onlyUsed ? ports.filter((p) => p.serverId) : ports;

  return (
    <>
      <PageHeader
        title={t('admin.portsTitle')}
        subtitle={t('admin.portsSummary', { used, total: ports.length })}
        actions={
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={onlyUsed} onChange={(e) => setOnlyUsed(e.target.checked)} />
            {t('admin.onlyUsed')}
          </label>
        }
      />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
        {shown.map((p) => (
          <div key={p.port} className={clsx('rounded-block border px-3 py-2', p.serverId ? 'border-accent/40 bg-accent/5' : 'border-line bg-surface')}>
            <div className="font-mono text-sm font-medium">{p.port}</div>
            {p.serverId ? (
              <Link to={`/servers/${p.serverId}`} className="block truncate text-xs text-accent hover:underline">
                {p.serverName ?? p.serverId}
              </Link>
            ) : (
              <div className="text-xs text-muted">{t('admin.free')}</div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
