import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, ChevronLeft, ChevronRight, ExternalLink, KeyRound, Link2, PackageSearch, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { ApiError, workshopApi } from '@/api';
import type { WorkshopItem, WorkshopRef } from '@/api/types';
import { useT } from '@/i18n';
import { useIsAdmin } from '@/stores/auth';
import { formatBytes, formatCompact, formatDate } from '@/lib/format';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, EmptyState, ErrorState, IconButton, Loading, Section, Spinner } from '@/components/ui';
import { Note } from '../create/TerrariaConfigStep';
import { useServerCtx } from './ServerLayout';

function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

const workshopUrl = (id: string) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`;

function Preview({ src, className }: { src?: string | null; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken)
    return (
      <div className={clsx('flex shrink-0 items-center justify-center bg-raised text-muted', className)}>
        <PackageSearch className="h-6 w-6" aria-hidden="true" />
      </div>
    );
  return <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" className={clsx('shrink-0 bg-raised object-cover', className)} onError={() => setBroken(true)} />;
}

function ItemMeta({ item }: { item: Partial<WorkshopItem> }) {
  const t = useT();
  const bits = [
    item.author ? t('catalog.by', { author: item.author }) : null,
    item.subscribers != null ? t('workshop.subscribers', { n: formatCompact(item.subscribers) }) : null,
    item.sizeBytes ? formatBytes(item.sizeBytes) : null,
    item.updatedAt ? t('workshop.updated', { date: formatDate(item.updatedAt) }) : null,
  ].filter(Boolean);
  if (!bits.length) return null;
  return <p className="text-xs text-muted">{bits.join(' · ')}</p>;
}

/** Shown when Workshop search needs the admin Steam Web API key. */
function KeyMissing() {
  const t = useT();
  const admin = useIsAdmin();
  return (
    <div className="flex gap-3 rounded-md border border-warn/40 bg-warn/5 p-4 text-sm">
      <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium">{t('workshop.keyMissingTitle')}</p>
        <p className="text-muted">{admin ? t('workshop.keyMissingAdmin') : t('workshop.keyMissingUser')}</p>
        {admin && (
          <Link to="/admin/settings" className="inline-block font-medium text-accent hover:underline">
            {t('workshop.keyMissingLink')}
          </Link>
        )}
      </div>
    </div>
  );
}

function SearchResults({
  gameId,
  installed,
  onAdd,
  adding,
}: {
  gameId: string;
  installed: Set<string>;
  onAdd: (item: WorkshopItem) => void;
  adding: string | null;
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(0);
  useEffect(() => setPage(1), [dq]);
  const query = useQuery({
    queryKey: ['workshop-search', gameId, dq, page],
    queryFn: ({ signal }) => workshopApi.search({ gameId, q: dq || undefined, page }, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: (n, e) => !(e instanceof ApiError && e.status === 400) && n < 2,
  });
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  useEffect(() => {
    if (items.length > pageSize) setPageSize(items.length);
  }, [items.length, pageSize]);
  const pages = pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const keyMissing = query.error instanceof ApiError && query.error.code === 'steam_key_missing';

  return (
    <div className="space-y-3">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        <input className="input pl-9" type="search" placeholder={t('workshop.searchPlaceholder')} aria-label={t('workshop.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        {query.isFetching && !query.isLoading && <Spinner className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2" />}
      </label>
      {query.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : keyMissing ? (
        <KeyMissing />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">{t('catalog.noResults')}</p>
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((it) => {
              const has = installed.has(it.id);
              return (
                <li key={it.id} className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line bg-surface">
                  <Preview src={it.previewUrl} className="aspect-video w-full" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
                    <a href={workshopUrl(it.id)} target="_blank" rel="noreferrer" className="line-clamp-2 font-medium hover:text-accent hover:underline">
                      {it.title || it.id}
                    </a>
                    <ItemMeta item={it} />
                    {it.summary && <p className="line-clamp-2 text-sm text-muted">{it.summary}</p>}
                    <div className="mt-auto flex items-center justify-between gap-2 pt-2">
                      <span className="font-mono text-xs text-muted">{it.id}</span>
                      {has ? (
                        <Badge tone="ok">
                          <Check className="h-3 w-3" aria-hidden="true" />
                          {t('workshop.installed')}
                        </Badge>
                      ) : (
                        <Button size="sm" variant="primary" loading={adding === it.id} disabled={!!adding} onClick={() => onAdd(it)} icon={<Plus className="h-4 w-4" />}>
                          {t('common.add')}
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <nav className="flex flex-wrap items-center justify-between gap-2" aria-label={t('workshop.paging')}>
            <span className="text-sm text-muted">{t('workshop.results', { total: formatCompact(total) })}</span>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={page <= 1 || query.isFetching} onClick={() => setPage((p) => p - 1)} icon={<ChevronLeft className="h-4 w-4 rtl:-scale-x-100" />}>
                {t('common.previous')}
              </Button>
              <span className="text-sm tabular-nums">{t('workshop.page', { page, pages })}</span>
              <Button size="sm" disabled={page >= pages || query.isFetching} onClick={() => setPage((p) => p + 1)}>
                {t('common.next')}
                <ChevronRight className="h-4 w-4 rtl:-scale-x-100" />
              </Button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}

/** Add by Workshop ID or URL: resolves the item first, shows it, then adds on confirmation. */
function AddById({ gameId, gameName, installed, onAdd, adding }: { gameId: string; gameName: string; installed: Set<string>; onAdd: (item: WorkshopItem) => Promise<boolean>; adding: string | null }) {
  const t = useT();
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<WorkshopItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (e: FormEvent) => {
    e.preventDefault();
    const v = raw.trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      setFound(await workshopApi.item(v, gameId || undefined));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? t('workshop.notFound') : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <form onSubmit={resolve} className="flex flex-col gap-2 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            className="input pl-9 font-mono"
            value={raw}
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            aria-label={t('workshop.addById')}
            aria-invalid={!!error}
            placeholder={t('workshop.addByIdPlaceholder')}
            onChange={(e) => {
              setRaw(e.target.value);
              setError(null);
            }}
          />
        </label>
        <Button type="submit" loading={busy} disabled={!raw.trim()} icon={<Search className="h-4 w-4" />}>
          {t('workshop.lookUp')}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {found && (
        <div className="flex flex-col gap-3 rounded-md border border-accent/40 bg-accent/5 p-3 sm:flex-row sm:items-center">
          <Preview src={found.previewUrl} className="aspect-video w-full rounded-block sm:h-16 sm:w-28" />
          <div className="min-w-0 flex-1">
            <a href={workshopUrl(found.id)} target="_blank" rel="noreferrer" className="font-medium hover:underline">
              {found.title || found.id}
            </a>
            <ItemMeta item={found} />
            <p className="font-mono text-xs text-muted">{found.id}</p>
            {found.matchesGame === false && <p className="mt-1 text-sm text-danger">{t('workshop.wrongGame', { game: gameName })}</p>}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setFound(null)}>
              {t('common.cancel')}
            </Button>
            {found.matchesGame === false ? null : installed.has(found.id) ? (
              <Badge tone="ok">{t('workshop.installed')}</Badge>
            ) : (
              <Button
                size="sm"
                variant="primary"
                loading={adding === found.id}
                disabled={!!adding}
                onClick={() =>
                  void onAdd(found).then((ok) => {
                    if (ok) {
                      setFound(null);
                      setRaw('');
                    }
                  })
                }
                icon={<Plus className="h-4 w-4" />}
              >
                {t('workshop.addConfirm')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function InstalledList({ serverId, items, running }: { serverId: string; items: WorkshopRef[]; running: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  // Previews and titles come from the keyless details endpoint (cached for an hour).
  const details = useQueries({
    queries: items.slice(0, 100).map((it) => ({
      queryKey: ['workshop-item', it.id],
      queryFn: () => workshopApi.item(it.id),
      staleTime: 60 * 60_000,
      retry: false,
    })),
  });

  const remove = async (it: WorkshopRef, title: string) => {
    const ok = await confirm({
      title: t('workshop.removeTitle', { name: title }),
      body: running ? t('workshop.nextStart') : undefined,
      danger: true,
      confirmLabel: t('common.remove'),
    });
    if (!ok) return;
    try {
      await workshopApi.remove(serverId, it.id);
      void qc.invalidateQueries({ queryKey: ['servers', serverId] });
      toast.success(running ? t('workshop.removedNextStart', { name: title }) : t('workshop.removed', { name: title }));
    } catch (e) {
      toast.error(e);
    }
  };

  if (!items.length) return <EmptyState icon={<PackageSearch className="h-10 w-10" />} title={t('workshop.emptyTitle')} body={t('workshop.emptyBody')} />;
  return (
    <ul className="divide-y divide-line">
      {items.map((it, i) => {
        const d = details[i]?.data;
        const title = d?.title || it.title || it.id;
        return (
          <li key={it.id} className="flex items-center gap-3 py-2.5">
            <Preview src={d?.previewUrl} className="h-12 w-12 rounded-block sm:h-12 sm:w-20" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{title}</div>
              <div className="font-mono text-xs text-muted">{it.id}</div>
            </div>
            <a
              href={workshopUrl(it.id)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-block text-muted hover:bg-raised hover:text-ink"
              aria-label={t('workshop.openOnSteam', { name: title })}
              title={t('workshop.openOnSteam', { name: title })}
            >
              <ExternalLink className="h-4 w-4" />
            </a>
            <IconButton label={t('workshop.removeTitle', { name: title })} className="h-10 w-10 shrink-0 hover:text-danger" onClick={() => void remove(it, title)}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}

export default function Workshop() {
  const t = useT();
  const qc = useQueryClient();
  const { server, def } = useServerCtx();
  const running = server.status !== 'stopped' && server.status !== 'crashed';
  const list = useQuery({ queryKey: ['servers', server.id, 'workshop'], queryFn: () => workshopApi.list(server.id) });
  const installed = new Set((list.data ?? []).map((i) => i.id));
  const [adding, setAdding] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const add = async (item: WorkshopItem) => {
    setAdding(item.id);
    try {
      await workshopApi.add(server.id, item.id);
      void qc.invalidateQueries({ queryKey: ['servers', server.id] });
      const name = item.title || item.id;
      toast.success(running ? t('workshop.addedNextStart', { name }) : t('workshop.added', { name }));
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'workshop_wrong_game') toast.error(t('workshop.wrongGame', { game: def?.name ?? '' }));
      else toast.error(e);
      return false;
    } finally {
      setAdding(null);
    }
  };

  const refresh = async () => {
    const ok = await confirm({ title: t('workshop.refreshTitle'), body: t('workshop.refreshBody'), confirmLabel: t('workshop.refresh') });
    if (!ok) return;
    setRefreshing(true);
    try {
      await workshopApi.refresh(server.id);
      toast.success(t('workshop.refreshDone'));
    } catch (e) {
      toast.error(e);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-4">
      {running && <Note>{t('workshop.nextStart')}</Note>}
      <Section
        title={t('workshop.installedTitle', { n: list.data?.length ?? 0 })}
        description={def?.workshop?.install === 'config-list' ? t('workshop.modeConfigList') : t('workshop.modeSteamcmd')}
        actions={
          list.data?.length ? (
            <Button size="sm" loading={refreshing} onClick={() => void refresh()} icon={<RefreshCw className="h-4 w-4" />}>
              {t('workshop.refresh')}
            </Button>
          ) : undefined
        }
      >
        {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : <InstalledList serverId={server.id} items={list.data ?? []} running={running} />}
      </Section>
      <Section title={t('workshop.addById')} description={t('workshop.addByIdBody')}>
        <AddById gameId={server.steam?.gameId ?? def?.id ?? ''} gameName={def?.name ?? ''} installed={installed} onAdd={add} adding={adding} />
      </Section>
      <Section title={t('workshop.search')} description={t('workshop.searchBody')}>
        <SearchResults gameId={server.steam?.gameId ?? def?.id ?? ''} installed={installed} onAdd={(it) => void add(it)} adding={adding} />
      </Section>
    </div>
  );
}
