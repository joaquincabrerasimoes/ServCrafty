import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { adminApi } from '@/api';
import { useT } from '@/i18n';
import { formatDate } from '@/lib/format';
import { Button, ErrorState, Loading, PageHeader } from '@/components/ui';

const PAGE = 50;

export default function Audit() {
  const t = useT();
  const [offset, setOffset] = useState(0);
  const [user, setUser] = useState('');
  const [action, setAction] = useState('');
  const [filters, setFilters] = useState({ user: '', action: '' });

  useEffect(() => {
    const id = setTimeout(() => {
      setFilters({ user: user.trim(), action: action.trim() });
      setOffset(0);
    }, 300);
    return () => clearTimeout(id);
  }, [user, action]);

  const q = useQuery({
    queryKey: ['audit', offset, filters],
    queryFn: () => adminApi.audit({ limit: PAGE, offset, user: filters.user || undefined, action: filters.action || undefined }),
    placeholderData: keepPreviousData,
  });
  const items = q.data?.items ?? [];
  const hasMore = q.data?.total !== undefined ? offset + PAGE < q.data.total : items.length === PAGE;

  return (
    <>
      <PageHeader title={t('admin.auditTitle')} />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <input className="input sm:max-w-xs" placeholder={t('admin.filterUser')} value={user} onChange={(e) => setUser(e.target.value)} />
        <input className="input sm:max-w-xs" placeholder={t('admin.filterAction')} value={action} onChange={(e) => setAction(e.target.value)} />
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('admin.when')}</th>
                <th>{t('admin.who')}</th>
                <th>{t('admin.action')}</th>
                <th className="hidden md:table-cell">{t('admin.target')}</th>
                <th className="hidden lg:table-cell">IP</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap text-muted">{formatDate(e.createdAt)}</td>
                  <td>{e.username ?? e.userId ?? '–'}</td>
                  <td>
                    <span className="font-mono text-xs">{e.action}</span>
                    {e.meta && Object.keys(e.meta).length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-muted">{t('admin.details')}</summary>
                        <pre className="mt-1 max-w-md overflow-x-auto rounded-block bg-raised p-2 font-mono text-[11px]">{JSON.stringify(e.meta, null, 2)}</pre>
                      </details>
                    )}
                  </td>
                  <td className="hidden text-xs text-muted md:table-cell">
                    {e.targetType ? `${e.targetType}:` : ''}
                    <span className="font-mono">{e.targetId ?? ''}</span>
                  </td>
                  <td className="hidden font-mono text-xs text-muted lg:table-cell">{e.ip ?? ''}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-muted">
                    {t('admin.auditEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} icon={<ChevronLeft className="h-4 w-4" />}>
          {t('common.previous')}
        </Button>
        <Button size="sm" disabled={!hasMore} onClick={() => setOffset(offset + PAGE)}>
          {t('common.next')}
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </>
  );
}
