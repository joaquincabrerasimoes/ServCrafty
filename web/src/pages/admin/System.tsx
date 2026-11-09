import { useQuery } from '@tanstack/react-query';
import { adminApi } from '@/api';
import { useT } from '@/i18n';
import { Badge, ErrorState, LinkButton, Loading, PageHeader, Section } from '@/components/ui';
import { fmtVersion, useAppVersion, useUpdateInfo } from '@/lib/updates';

/** Panel version + update status (the rest of the page is the open-ended /admin/system payload). */
function PanelVersion() {
  const t = useT();
  const health = useAppVersion();
  const { data } = useUpdateInfo();
  const version = data?.currentVersion ?? health;
  return (
    <Section
      title="ServCrafty"
      className="mb-4"
      actions={
        <LinkButton to="/admin/update" size="sm">
          {t('update.manage')}
        </LinkButton>
      }
    >
      <dl className="divide-y divide-line/60">
        <div className="grid gap-1 py-1.5 sm:grid-cols-[12rem_1fr] sm:gap-4">
          <dt className="text-sm text-muted">{t('update.current')}</dt>
          <dd className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-[13px]">{fmtVersion(version)}</span>
            {data?.updateAvailable && data.latest && <Badge tone="accent">{t('update.available', { version: fmtVersion(data.latest.version) })}</Badge>}
          </dd>
        </div>
        {data && (
          <>
            <div className="grid gap-1 py-1.5 sm:grid-cols-[12rem_1fr] sm:gap-4">
              <dt className="text-sm text-muted">{t('update.installType')}</dt>
              <dd className="text-sm">{t(`update.installType.${data.installType}`)}</dd>
            </div>
            <div className="grid gap-1 py-1.5 sm:grid-cols-[12rem_1fr] sm:gap-4">
              <dt className="text-sm text-muted">{t('update.commit')}</dt>
              <dd className="break-all font-mono text-[13px]">{data.commit ?? '–'}</dd>
            </div>
          </>
        )}
      </dl>
    </Section>
  );
}

/** Renders the open-ended /admin/system payload as nested definition lists. */
function Value({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="text-muted">–</span>;
  if (typeof v === 'boolean') return <span>{v ? '✓' : '✗'}</span>;
  if (typeof v !== 'object') return <span className="break-all font-mono text-[13px]">{String(v)}</span>;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== 'object')) return <span className="break-all font-mono text-[13px]">{v.join(', ')}</span>;
    return (
      <div className="space-y-2">
        {v.map((x, i) => (
          <div key={i} className="rounded-block border border-line p-2">
            <Value v={x} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <dl className="divide-y divide-line/60">
      {Object.entries(v as Record<string, unknown>).map(([k, x]) => (
        <div key={k} className="grid gap-1 py-1.5 sm:grid-cols-[12rem_1fr] sm:gap-4">
          <dt className="text-sm text-muted">{k}</dt>
          <dd className="min-w-0 text-sm">
            <Value v={x} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function System() {
  const t = useT();
  const q = useQuery({ queryKey: ['admin-system'], queryFn: adminApi.system, refetchInterval: 30_000 });
  return (
    <>
      <PageHeader title={t('admin.systemTitle')} />
      <PanelVersion />
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {Object.entries(q.data ?? {}).map(([section, value]) => (
            <Section key={section} title={section}>
              <Value v={value} />
            </Section>
          ))}
        </div>
      )}
    </>
  );
}
