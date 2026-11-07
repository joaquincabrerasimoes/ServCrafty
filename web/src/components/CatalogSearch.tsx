import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Download, PackageSearch, Search } from 'lucide-react';
import { catalogApi, type CatalogSearch as SearchParams } from '@/api/catalog';
import type { CatalogProject, CatalogSource } from '@/api/types';
import { useT } from '@/i18n';
import { formatCompact } from '@/lib/format';
import { Button, ErrorState, Spinner } from './ui';

function useDebounced<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

const SOURCE_LABELS: Record<CatalogSource, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge', hangar: 'Hangar' };

/** Hangar only hosts Paper plugins, so it is offered for plugin browsing only. */
export const sourcesFor = (kind: SearchParams['kind']): CatalogSource[] =>
  kind === 'plugin' ? ['hangar', 'modrinth', 'curseforge'] : ['modrinth', 'curseforge'];

export function SourceTabs({
  value,
  onChange,
  sources = ['modrinth', 'curseforge'],
}: {
  value: CatalogSource;
  onChange: (s: CatalogSource) => void;
  sources?: CatalogSource[];
}) {
  return (
    <div className="inline-flex rounded-block border border-line bg-surface p-0.5" role="tablist">
      {sources.map((s) => (
        <button
          key={s}
          role="tab"
          aria-selected={value === s}
          type="button"
          onClick={() => onChange(s)}
          className={clsx('h-8 rounded-[2px] px-3 text-sm', value === s ? 'bg-raised font-medium text-ink' : 'text-muted hover:text-ink')}
        >
          {SOURCE_LABELS[s]}
        </button>
      ))}
    </div>
  );
}

export function ProjectIcon({ project, size = 'md' }: { project: CatalogProject; size?: 'md' | 'lg' }) {
  const cls = size === 'lg' ? 'h-14 w-14' : 'h-11 w-11';
  return project.iconUrl ? (
    <img src={project.iconUrl} alt="" loading="lazy" className={clsx(cls, 'shrink-0 rounded-block bg-raised object-cover')} />
  ) : (
    <div className={clsx(cls, 'flex shrink-0 items-center justify-center rounded-block bg-raised text-muted')}>
      <PackageSearch className="h-5 w-5" />
    </div>
  );
}

interface Props {
  kind: SearchParams['kind'];
  mcVersion?: string;
  loader?: string;
  selectedId?: string;
  onSelect: (p: CatalogProject) => void;
  /** Rendered on the right of each result (e.g. an Install button). */
  renderAction?: (p: CatalogProject) => React.ReactNode;
  initialSource?: CatalogSource;
}

export function CatalogSearch({ kind, mcVersion, loader, selectedId, onSelect, renderAction, initialSource }: Props) {
  const t = useT();
  const sources = sourcesFor(kind);
  const [source, setSource] = useState<CatalogSource>(initialSource && sources.includes(initialSource) ? initialSource : sources[0]!);
  const [q, setQ] = useState('');
  const dq = useDebounced(q);

  const query = useInfiniteQuery({
    queryKey: ['catalog', source, kind, dq, mcVersion ?? '', loader ?? ''],
    queryFn: ({ pageParam, signal }) => catalogApi.search({ source, kind, q: dq, mcVersion, loader, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? loaded : undefined;
    },
    staleTime: 60_000,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <SourceTabs value={source} onChange={setSource} sources={sources} />
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input className="input pl-9" placeholder={t('catalog.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>

      {query.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">{t('catalog.noResults')}</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface">
          {items.map((p) => (
            <li key={`${p.source}:${p.id}`}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelect(p)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(p))}
                className={clsx(
                  'flex cursor-pointer items-start gap-3 px-3 py-3 hover:bg-raised/60',
                  selectedId === p.id && 'bg-accent/10 shadow-[inset_3px_0_0_rgb(var(--accent))]',
                )}
              >
                <ProjectIcon project={p} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{p.name}</span>
                    {p.author && <span className="text-xs text-muted">{t('catalog.by', { author: p.author })}</span>}
                  </div>
                  {p.summary && <p className="line-clamp-2 text-sm text-muted">{p.summary}</p>}
                  {p.downloads ? (
                    <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted">
                      <Download className="h-3 w-3" />
                      {formatCompact(p.downloads)}
                    </span>
                  ) : null}
                </div>
                {renderAction && <div onClick={(e) => e.stopPropagation()}>{renderAction(p)}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {query.hasNextPage && (
        <div className="flex justify-center">
          <Button size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {t('catalog.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
