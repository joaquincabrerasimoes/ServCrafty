import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  Heart,
  ListRestart,
  Map as MapIcon,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Undo2,
  Users,
  X,
} from 'lucide-react';
import { cs16Api, cs16Keys } from '@/api';
import { CS16_CATALOG_SORTS, type Cs16CatalogMap, type Cs16CatalogSort, type Cs16Map, type Cs16MapsOverview } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { canManage, canOperate } from '@/lib/access';
import { formatBytes, formatCompact, formatDate } from '@/lib/format';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { errorMessage } from '@/api/client';
import { Badge, Button, EmptyState, ErrorState, IconButton, Loading, Modal, Section, Spinner, WarnBanner } from '@/components/ui';
import { Note } from '../create/TerrariaConfigStep';
import { useServerCtx } from './ServerLayout';

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function Thumb({ src, className }: { src: string | null | undefined; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken)
    return (
      <div className={clsx('flex shrink-0 items-center justify-center bg-raised text-muted', className)}>
        <MapIcon className="h-6 w-6" aria-hidden="true" />
      </div>
    );
  return <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" className={clsx('shrink-0 bg-raised object-cover', className)} onError={() => setBroken(true)} />;
}

function useRefreshMaps(serverId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: cs16Keys.maps(serverId) });
    void qc.invalidateQueries({ queryKey: cs16Keys.controls(serverId) });
  };
}

/* ---------------------------------------------------------------- Summary */

function Summary({ data, running }: { data: Cs16MapsOverview; running: boolean }) {
  const t = useT();
  const rows: Array<[string, string]> = [];
  if (running) rows.push([t('l4d2.currentMap'), data.current ?? '–']);
  rows.push([t('l4d2.startMap'), data.start.map]);
  rows.push([t('cs16.installedCount'), String(data.maps.length)]);
  rows.push([t('cs16.rotationCount'), String(data.rotation.length)]);
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {rows.map(([k, v]) => (
        <div key={k} className="min-w-0 rounded-block border border-line bg-raised/50 px-3 py-2">
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="truncate font-mono text-sm" title={v}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------------------------------------------------------------- Rotation */

function Rotation({
  serverId,
  data,
  pending,
  setPending,
  canEdit,
  running,
}: {
  serverId: string;
  data: Cs16MapsOverview;
  pending: string[];
  setPending: Dispatch<SetStateAction<string[]>>;
  canEdit: boolean;
  running: boolean;
}) {
  const t = useT();
  const refresh = useRefreshMaps(serverId);
  const [adding, setAdding] = useState('');
  const [saving, setSaving] = useState(false);
  const installed = useMemo(() => new Set(data.maps.map((m) => m.name)), [data.maps]);
  const notInRotation = data.maps.filter((m) => !pending.includes(m.name)).map((m) => m.name);
  const missing = pending.filter((m) => !installed.has(m));
  const dirty = !sameList(pending, data.rotation);
  const allInstalled = data.maps.map((m) => m.name);

  const move = (i: number, d: -1 | 1) =>
    setPending((cur) => {
      const j = i + d;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      const r = await cs16Api.setRotation(serverId, pending);
      toast.success(r?.appliedLive ? t('cs16.rotationLive') : t('cs16.rotationSaved'));
      refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title={t('cs16.rotationTitle')}
      description={canEdit ? (running ? t('cs16.rotationBodyRunning') : t('cs16.rotationBody')) : t('cs16.rotationBodyView')}
      actions={
        canEdit && allInstalled.length > 0 ? (
          <Button size="sm" disabled={saving || sameList(pending, allInstalled)} onClick={() => setPending(() => allInstalled)} icon={<ListRestart className="h-4 w-4" />}>
            {t('cs16.rotationAll')}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {missing.length > 0 && (
          <WarnBanner title={t('cs16.rotationMissingTitle', { n: missing.length })}>
            <p>{t('cs16.rotationMissingBody', { list: missing.join(', ') })}</p>
            {canEdit && (
              <Button size="sm" className="mt-2" onClick={() => setPending((cur) => cur.filter((m) => installed.has(m)))} icon={<X className="h-4 w-4" />}>
                {t('cs16.rotationRemoveMissing')}
              </Button>
            )}
          </WarnBanner>
        )}
        {pending.length === 0 ? (
          <EmptyState icon={<MapIcon className="h-10 w-10" />} title={t('cs16.rotationEmpty')} body={canEdit ? t('cs16.rotationEmptyBody') : undefined} />
        ) : (
          <ol className="divide-y divide-line/60 rounded-block border border-line">
            {pending.map((m, i) => {
              const isMissing = !installed.has(m);
              return (
                <li key={`${m}-${i}`} className="flex items-center gap-2 px-3 py-1">
                  <span className="w-6 shrink-0 text-end text-xs tabular-nums text-muted">{i + 1}</span>
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-1.5">
                    <span className={clsx('break-all font-mono text-sm', isMissing && 'text-warn')}>{m}</span>
                    {m === data.current && <Badge tone="accent">{t('cs16.current')}</Badge>}
                    {isMissing && <Badge tone="warn">{t('cs16.notInstalled')}</Badge>}
                  </span>
                  {canEdit && (
                    <span className="flex shrink-0 items-center">
                      <IconButton label={t('cs16.moveUp', { map: m })} className="h-10 w-10" disabled={i === 0 || saving} onClick={() => move(i, -1)}>
                        <ArrowUp className="h-4 w-4" />
                      </IconButton>
                      <IconButton label={t('cs16.moveDown', { map: m })} className="h-10 w-10" disabled={i === pending.length - 1 || saving} onClick={() => move(i, 1)}>
                        <ArrowDown className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        label={t('cs16.removeFromRotation', { map: m })}
                        className="h-10 w-10 hover:text-danger"
                        disabled={saving}
                        onClick={() => setPending((cur) => cur.filter((_, k) => k !== i))}
                      >
                        <X className="h-4 w-4" />
                      </IconButton>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {canEdit && (
          <>
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                if (!adding) return;
                setPending((cur) => (cur.includes(adding) ? cur : [...cur, adding]));
                setAdding('');
              }}
            >
              <label className="block min-w-0 flex-1">
                <span className="label">{t('cs16.rotationAdd')}</span>
                <select className="input" value={adding} disabled={!notInRotation.length || saving} onChange={(e) => setAdding(e.target.value)}>
                  <option value="">{notInRotation.length ? t('cs16.chooseMap') : t('cs16.allInRotation')}</option>
                  {notInRotation.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" disabled={!adding || saving} icon={<Plus className="h-4 w-4" />}>
                {t('common.add')}
              </Button>
            </form>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {dirty && <span className="me-auto text-xs text-muted">{t('cs16.rotationUnsaved')}</span>}
              <Button variant="ghost" disabled={!dirty || saving} onClick={() => setPending(() => data.rotation)} icon={<Undo2 className="h-4 w-4" />}>
                {t('cs16.discard')}
              </Button>
              <Button
                variant="primary"
                loading={saving}
                disabled={!dirty || pending.length === 0 || missing.length > 0 || !data.gameInstalled}
                onClick={() => void save()}
                icon={<Save className="h-4 w-4" />}
              >
                {t('cs16.rotationSave')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- Installed maps */

function sourceBadge(m: Cs16Map, t: ReturnType<typeof useT>) {
  if (m.source === 'stock') return <Badge>{t('cs16.source.stock')}</Badge>;
  if (m.source === 'gamebanana') return <Badge tone="accent">{t('cs16.source.gamebanana')}</Badge>;
  return <Badge tone="warn">{t('cs16.source.other')}</Badge>;
}

function InstalledMaps({
  serverId,
  data,
  pending,
  setPending,
  canEdit,
  manage,
}: {
  serverId: string;
  data: Cs16MapsOverview;
  pending: string[];
  setPending: Dispatch<SetStateAction<string[]>>;
  canEdit: boolean;
  manage: boolean;
}) {
  const t = useT();
  const refresh = useRefreshMaps(serverId);
  const [filter, setFilter] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const f = filter.trim().toLowerCase();
  const list = data.maps.filter((m) => !f || m.name.toLowerCase().includes(f) || (m.gamebanana?.name.toLowerCase().includes(f) ?? false));

  const remove = async (m: Cs16Map) => {
    const ok = await confirm({ title: t('cs16.removeMapTitle', { map: m.name }), body: t('cs16.removeMapBody'), danger: true, confirmLabel: t('common.remove') });
    if (!ok) return;
    setRemoving(m.name);
    try {
      await cs16Api.removeMap(serverId, m.name);
      toast.success(t('cs16.mapRemoved', { map: m.name }));
      setPending((cur) => cur.filter((x) => x !== m.name));
      refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Section title={t('cs16.installedTitle', { n: data.maps.length })} description={canEdit ? t('cs16.installedBody') : undefined}>
      <div className="space-y-4">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input className="input pl-9" type="search" value={filter} aria-label={t('cs16.filterMaps')} placeholder={t('cs16.filterMaps')} onChange={(e) => setFilter(e.target.value)} />
        </label>
        {data.maps.length === 0 ? (
          <EmptyState icon={<MapIcon className="h-10 w-10" />} title={t('cs16.noMaps')} />
        ) : list.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{t('catalog.noResults')}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((m) => {
              const inRot = pending.includes(m.name);
              const isCurrent = m.name === data.current;
              const isStart = m.name === data.start.map;
              return (
                <li key={m.name} className={clsx('flex min-w-0 gap-3 rounded-md border bg-surface p-2', isCurrent ? 'border-accent/60 bg-accent/5' : 'border-line')}>
                  <Thumb src={m.gamebanana?.thumbnail} className="aspect-video w-24 self-start rounded-block" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="break-all font-mono text-sm font-medium">{m.name}</span>
                    {m.gamebanana && m.gamebanana.name !== m.name && <span className="truncate text-xs text-muted" title={m.gamebanana.name}>{m.gamebanana.name}</span>}
                    <span className="flex flex-wrap gap-1">
                      {sourceBadge(m, t)}
                      {isCurrent && <Badge tone="ok">{t('cs16.current')}</Badge>}
                      {isStart && <Badge tone="accent">{t('cs16.startMapBadge')}</Badge>}
                    </span>
                    <span className="text-xs text-muted">{formatBytes(m.size)}</span>
                    {(canEdit || (manage && m.source !== 'stock')) && (
                      <span className="mt-auto flex flex-wrap justify-end gap-1 pt-1">
                        {canEdit && (
                          <Button
                            size="sm"
                            variant={inRot ? 'secondary' : 'ghost'}
                            className={clsx('h-10', inRot && 'border-accent text-accent')}
                            aria-pressed={inRot}
                            onClick={() => setPending((cur) => (inRot ? cur.filter((x) => x !== m.name) : [...cur, m.name]))}
                            icon={inRot ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                          >
                            {t('cs16.inRotation')}
                          </Button>
                        )}
                        {manage && m.source !== 'stock' && (
                          <IconButton
                            label={t('cs16.removeMapTitle', { map: m.name })}
                            className="h-10 w-10 hover:text-danger"
                            disabled={!!removing}
                            onClick={() => void remove(m)}
                          >
                            {removing === m.name ? <Spinner className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                          </IconButton>
                        )}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- Catalogue (GameBanana) */

function MapDetail({
  serverId,
  item,
  installedNames,
  canInstall,
  gameInstalled,
  onClose,
}: {
  serverId: string;
  item: Cs16CatalogMap;
  /** Installed maps that came from this GameBanana entry. */
  installedNames: string[];
  canInstall: boolean;
  gameInstalled: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const refresh = useRefreshMaps(serverId);
  const q = useQuery({
    queryKey: cs16Keys.catalogMap(serverId, item.id),
    queryFn: ({ signal }) => cs16Api.catalogMap(serverId, item.id, signal),
    staleTime: 5 * 60_000,
  });
  const d = q.data;
  const [shot, setShot] = useState(0);
  const [fileId, setFileId] = useState<number | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const files = d?.files ?? [];
  // Same default as the API: the first archive or .bsp file.
  const defaultFile = files.find((f) => /\.(zip|rar|7z|tar\.gz|tgz|tar\.xz|txz|tar|bsp)$/i.test(f.name)) ?? files[0];
  const chosen = files.find((f) => f.id === fileId) ?? defaultFile;
  const shots = d?.screenshots.length ? d.screenshots : item.thumbnail ? [item.thumbnail] : [];

  const install = async () => {
    if (!chosen) return;
    setInstalling(true);
    setError(null);
    try {
      const r = await cs16Api.installCatalogMap(serverId, item.id, files.length > 1 ? chosen.id : undefined);
      toast.success(t('cs16.mapsInstalled', { list: r?.maps?.join(', ') || item.name }));
      refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={installing ? () => undefined : onClose}
      title={item.name}
      footer={
        <>
          {!canInstall && <span className="me-auto self-center text-xs text-muted">{t('cs16.installNeedsManager')}</span>}
          {canInstall && !gameInstalled && <span className="me-auto self-center text-xs text-muted">{t('cs16.installNeedsGame')}</span>}
          <Button variant="ghost" onClick={onClose} disabled={installing}>
            {t('common.close')}
          </Button>
          <Button
            variant="primary"
            data-autofocus
            loading={installing}
            disabled={!canInstall || !gameInstalled || !chosen || !q.data}
            onClick={() => void install()}
            icon={<Download className="h-4 w-4" />}
          >
            {installedNames.length ? t('cs16.reinstall') : t('l4d2.plugins.install')}
          </Button>
        </>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error || !d ? (
        <ErrorState error={q.error ?? new Error(t('l4d2.loadFailed'))} onRetry={() => void q.refetch()} />
      ) : (
        <div className="space-y-4">
          {shots.length > 0 && (
            <div className="space-y-2">
              <div className="aspect-video w-full overflow-hidden rounded-block bg-raised">
                <Thumb src={shots[Math.min(shot, shots.length - 1)]} className="h-full w-full" />
              </div>
              {shots.length > 1 && (
                <div className="scrollbar-thin flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t('cs16.screenshots')}>
                  {shots.map((s, i) => (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={i === shot}
                      aria-label={t('cs16.screenshotN', { n: i + 1 })}
                      onClick={() => setShot(i)}
                      className={clsx('shrink-0 overflow-hidden rounded-block border-2', i === shot ? 'border-accent' : 'border-transparent opacity-75 hover:opacity-100')}
                    >
                      <Thumb src={s} className="aspect-video w-24" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            {d.category && <Badge>{d.category}</Badge>}
            {d.submitter && <span>{t('catalog.by', { author: d.submitter })}</span>}
            <span className="inline-flex items-center gap-1">
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {t('cs16.downloads', { n: formatCompact(d.downloads) })}
            </span>
            <span className="inline-flex items-center gap-1">
              <Heart className="h-3.5 w-3.5" aria-hidden="true" />
              {t('cs16.likes', { n: formatCompact(d.likes) })}
            </span>
            <span className="inline-flex items-center gap-1">
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              {t('cs16.views', { n: formatCompact(d.views) })}
            </span>
            {d.version && <span>{t('cs16.version', { v: d.version })}</span>}
            {d.updatedAt && <span>{t('workshop.updated', { date: formatDate(d.updatedAt) })}</span>}
          </div>
          <a href={d.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
            {t('cs16.openOnGameBanana')}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
          {installedNames.length > 0 && (
            <p className="flex items-center gap-2 text-sm text-ok">
              <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t('cs16.alreadyInstalled', { list: installedNames.join(', ') })}
            </p>
          )}
          {d.description && <p className="whitespace-pre-line break-words text-sm">{d.description}</p>}
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">{t('cs16.files')}</legend>
            {files.length === 0 ? (
              <p className="text-sm text-muted">{t('cs16.noFiles')}</p>
            ) : (
              <ul className="divide-y divide-line/60 rounded-block border border-line">
                {files.map((f) => {
                  const body = (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block break-all text-sm">{f.name}</span>
                        <span className="block text-xs text-muted">
                          {[formatBytes(f.size), t('cs16.downloads', { n: formatCompact(f.downloads) }), f.addedAt ? formatDate(f.addedAt) : null].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      {f.clean && (
                        <Badge tone="ok">
                          <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                          {t('cs16.scannedClean')}
                        </Badge>
                      )}
                    </>
                  );
                  return (
                    <li key={f.id}>
                      {files.length > 1 ? (
                        <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2">
                          <input
                            type="radio"
                            name={`gb-file-${item.id}`}
                            className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]"
                            checked={chosen?.id === f.id}
                            disabled={installing}
                            onChange={() => setFileId(f.id)}
                          />
                          {body}
                        </label>
                      ) : (
                        <div className="flex items-center gap-3 px-3 py-2">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
          <p className="flex gap-2 rounded-block border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-muted">
            <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
            <span>{t('cs16.clientsDownload')}</span>
          </p>
          {installing && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted">
              <Spinner className="h-4 w-4" />
              {t('cs16.installing')}
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-block border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function SkeletonGrid() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="overflow-hidden rounded-md border border-line bg-surface">
          <div className="aspect-[530/298] w-full animate-pulse bg-raised" />
          <div className="space-y-2 p-3">
            <div className="h-4 w-3/4 animate-pulse rounded-block bg-raised" />
            <div className="h-3 w-1/2 animate-pulse rounded-block bg-raised" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Catalog({ serverId, data, canInstall }: { serverId: string; data: Cs16MapsOverview; canInstall: boolean }) {
  const t = useT();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 400);
  const [sort, setSort] = useState<Cs16CatalogSort>('popular');
  const [category, setCategory] = useState<number | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Cs16CatalogMap | null>(null);
  useEffect(() => setPage(1), [dq, sort, category]);
  const search = { q: dq || undefined, page, sort, category };
  const query = useQuery({
    queryKey: cs16Keys.catalog(serverId, search),
    queryFn: ({ signal }) => cs16Api.catalog(serverId, search, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const res = query.data;
  const items = res?.items ?? [];
  const pages = res && res.perPage > 0 ? Math.max(1, Math.ceil(res.total / res.perPage)) : 1;
  // Categories only come with a response: keep the last list so the select does not empty while loading.
  const [categories, setCategories] = useState<Array<{ id: number; name: string; count: number }>>([]);
  useEffect(() => {
    if (res?.categories?.length) setCategories(res.categories);
  }, [res?.categories]);
  const installedBy = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const x of data.maps) if (x.gamebanana) m.set(x.gamebanana.id, [...(m.get(x.gamebanana.id) ?? []), x.name]);
    return m;
  }, [data.maps]);

  return (
    <Section title={t('cs16.catalogTitle')} description={t('cs16.catalogBody')}>
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <label className="relative block min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input className="input pl-9" type="search" placeholder={t('cs16.catalogSearch')} aria-label={t('cs16.catalogSearch')} value={q} onChange={(e) => setQ(e.target.value)} />
            {query.isFetching && !query.isLoading && <Spinner className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2" />}
          </label>
          <label className="block min-w-0">
            <span className="sr-only">{t('cs16.sortLabel')}</span>
            <select className="input" value={sort} aria-label={t('cs16.sortLabel')} onChange={(e) => setSort(e.target.value as Cs16CatalogSort)}>
              {CS16_CATALOG_SORTS.map((s) => (
                <option key={s} value={s}>
                  {t(`cs16.sort.${s}` as TKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className="sr-only">{t('cs16.categoryLabel')}</span>
            <select
              className="input"
              value={category ?? ''}
              aria-label={t('cs16.categoryLabel')}
              onChange={(e) => setCategory(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">{t('cs16.allCategories')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({formatCompact(c.count)})
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="flex gap-2 rounded-block border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-muted">
          <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
          <span>{t('cs16.clientsDownload')}</span>
        </p>
        {query.isLoading ? (
          <SkeletonGrid />
        ) : query.error && !res ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">{t('catalog.noResults')}</p>
        ) : (
          <>
            {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
            <ul className={clsx('grid gap-3 sm:grid-cols-2 xl:grid-cols-3', query.isPlaceholderData && 'opacity-60')}>
              {items.map((it) => {
                const has = installedBy.has(it.id);
                return (
                  <li key={it.id} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => setOpen(it)}
                      className="flex h-full w-full min-w-0 flex-col overflow-hidden rounded-md border border-line bg-surface text-start transition-colors hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <Thumb src={it.thumbnail} className="aspect-[530/298] w-full" />
                      <span className="flex min-w-0 flex-1 flex-col gap-1 p-3">
                        <span className="line-clamp-2 font-medium">{it.name}</span>
                        <span className="flex flex-wrap items-center gap-1">
                          {it.category && <Badge>{it.category}</Badge>}
                          {has && (
                            <Badge tone="ok">
                              <Check className="h-3 w-3" aria-hidden="true" />
                              {t('workshop.installed')}
                            </Badge>
                          )}
                          {!it.hasFiles && <Badge tone="warn">{t('cs16.noFiles')}</Badge>}
                        </span>
                        <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted">
                          {it.submitter && <span className="min-w-0 truncate">{t('catalog.by', { author: it.submitter })}</span>}
                          <span className="inline-flex items-center gap-1">
                            <Heart className="h-3 w-3" aria-hidden="true" />
                            <span className="sr-only">{t('cs16.likes', { n: it.likes })}</span>
                            <span aria-hidden="true">{formatCompact(it.likes)}</span>
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Eye className="h-3 w-3" aria-hidden="true" />
                            <span className="sr-only">{t('cs16.views', { n: it.views })}</span>
                            <span aria-hidden="true">{formatCompact(it.views)}</span>
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <nav className="flex flex-wrap items-center justify-between gap-2" aria-label={t('workshop.paging')}>
              <span className="text-sm text-muted">{t('workshop.results', { total: formatCompact(res?.total ?? 0) })}</span>
              <div className="flex items-center gap-2">
                <Button size="sm" className="h-10" disabled={page <= 1 || query.isFetching} onClick={() => setPage((p) => p - 1)} icon={<ChevronLeft className="h-4 w-4 rtl:-scale-x-100" />}>
                  {t('common.previous')}
                </Button>
                <span className="text-sm tabular-nums">{t('workshop.page', { page, pages })}</span>
                <Button size="sm" className="h-10" disabled={page >= pages || query.isFetching} onClick={() => setPage((p) => p + 1)}>
                  {t('common.next')}
                  <ChevronRight className="h-4 w-4 rtl:-scale-x-100" />
                </Button>
              </div>
            </nav>
          </>
        )}
      </div>
      {open && (
        <MapDetail
          serverId={serverId}
          item={open}
          installedNames={installedBy.get(open.id) ?? []}
          canInstall={canInstall}
          gameInstalled={data.gameInstalled}
          onClose={() => setOpen(null)}
        />
      )}
    </Section>
  );
}

/* ---------------------------------------------------------------- Page */

export default function Cs16Maps() {
  const t = useT();
  const { server } = useServerCtx();
  const q = useQuery({ queryKey: cs16Keys.maps(server.id), queryFn: () => cs16Api.maps(server.id), staleTime: 30_000 });
  const notStopped = server.status !== 'stopped' && server.status !== 'crashed';
  const operate = canOperate(server.access);
  const manage = canManage(server.access);
  // The rotation being edited; it follows the saved one whenever that changes (after a save, a removal, a refetch).
  const [pending, setPending] = useState<string[]>([]);
  const savedKey = q.data?.rotation.join('\n');
  const [baseKey, setBaseKey] = useState<string | undefined>(undefined);
  if (savedKey !== baseKey) {
    setBaseKey(savedKey);
    setPending(q.data?.rotation ?? []);
  }

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error ?? new Error(t('l4d2.loadFailed'))} onRetry={() => void q.refetch()} />;
  const data = q.data;

  return (
    <div className="space-y-4">
      {!data.gameInstalled && <WarnBanner title={t('l4d2.notInstalledTitle')}>{t('cs16.notInstalledMaps')}</WarnBanner>}
      <Section title={t('l4d2.mapsStatus')}>
        <Summary data={data} running={notStopped} />
      </Section>
      <Rotation serverId={server.id} data={data} pending={pending} setPending={setPending} canEdit={operate} running={server.status === 'running'} />
      <InstalledMaps serverId={server.id} data={data} pending={pending} setPending={setPending} canEdit={operate} manage={manage} />
      {operate ? (
        <Catalog serverId={server.id} data={data} canInstall={manage} />
      ) : (
        <Note>{t('cs16.catalogNeedsOperator')}</Note>
      )}
    </div>
  );
}
