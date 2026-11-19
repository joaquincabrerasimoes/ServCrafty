import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, ExternalLink, Link2, Map as MapIcon, Play, Plus, Search, Trash2, Users } from 'lucide-react';
import { ApiError, l4d2Api, l4d2Keys, workshopApi } from '@/api';
import type { L4dAddon, L4dCampaign, L4dGameMode, L4dMapsOverview } from '@/api/types';
import { L4D_MODES } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { canManage, canOperate } from '@/lib/access';
import { formatBytes } from '@/lib/format';
import { qk } from '@/lib/queries';
import { chaptersOf, difficultyLabel, modeLabel, modesOf, settle, useL4dMaps, workshopUrl } from '@/lib/l4d2';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, EmptyState, ErrorState, IconButton, Loading, Modal, Section, WarnBanner, buttonClass } from '@/components/ui';
import { Note } from '../create/TerrariaConfigStep';
import { useServerCtx } from './ServerLayout';

function StartSummary({ data, running }: { data: L4dMapsOverview; running: boolean }) {
  const t = useT();
  const rows: Array<[string, string]> = [];
  if (running) rows.push([t('l4d2.currentMap'), data.current.map ?? '–']);
  rows.push([t('l4d2.startMap'), data.start.map]);
  rows.push([t('l4d2.startMode'), modeLabel(data.start.gameMode, t)]);
  rows.push([t('l4d2.startDifficulty'), difficultyLabel(data.start.difficulty, t)]);
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

/** "Play now": pick the game mode (and optionally keep it as the start map), then change to the first chapter. */
function PlayDialog({ campaign, serverId, onClose }: { campaign: L4dCampaign; serverId: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const modes = modesOf(campaign);
  const [mode, setMode] = useState<L4dGameMode>(modes[0] ?? 'coop');
  const [persist, setPersist] = useState(false);
  const [busy, setBusy] = useState(false);
  const play = async () => {
    setBusy(true);
    try {
      const r = await l4d2Api.changeMap(serverId, { campaign: campaign.id, mode, persist });
      toast.success(t('l4d2.mapChanged', { map: r?.map ?? campaign.title }));
      onClose();
      if (persist) void qc.invalidateQueries({ queryKey: qk.server(serverId) });
      await settle();
      void qc.invalidateQueries({ queryKey: l4d2Keys.maps(serverId) });
      void qc.invalidateQueries({ queryKey: l4d2Keys.controls(serverId) });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('l4d2.playTitle', { name: campaign.title })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!modes.length} onClick={() => void play()} icon={<Play className="h-4 w-4" />}>
            {t('l4d2.playNow')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">{t('l4d2.playBody')}</p>
        <label className="block">
          <span className="label">{t('l4d2.gameMode')}</span>
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as L4dGameMode)}>
            {modes.map((m) => (
              <option key={m} value={m}>
                {modeLabel(m, t)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm">
          <input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
          {t('l4d2.persistCampaign')}
        </label>
      </div>
    </Modal>
  );
}

function CampaignRow({
  campaign,
  mode,
  canPlay,
  onPlay,
  onChapter,
  busyMap,
}: {
  campaign: L4dCampaign;
  mode: L4dGameMode;
  canPlay: boolean;
  onPlay: () => void;
  onChapter: (map: string) => void;
  busyMap: string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const modes = modesOf(campaign);
  const chapters = chaptersOf(campaign, mode);
  const panelId = `camp-${campaign.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-start gap-2 sm:flex-nowrap">
        <button
          type="button"
          className="flex min-h-10 min-w-0 flex-1 items-start gap-2 rounded-block text-start hover:text-accent"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDown className={clsx('mt-1 h-4 w-4 shrink-0 text-muted transition-transform', !open && '-rotate-90 rtl:rotate-90')} aria-hidden="true" />
          <span className="min-w-0">
            <span className="block font-medium">{campaign.title}</span>
            <span className="block text-xs text-muted">
              {[campaign.author ? t('catalog.by', { author: campaign.author }) : null, campaign.addon].filter(Boolean).join(' · ')}
            </span>
            <span className="mt-1 flex flex-wrap gap-1">
              {modes.map((m) => (
                <Badge key={m} tone={m === mode ? 'accent' : 'neutral'}>
                  {modeLabel(m, t)} · {campaign.modes[m]?.length ?? 0}
                </Badge>
              ))}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {campaign.workshopId && (
            <a
              href={workshopUrl(campaign.workshopId)}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-10 w-10 items-center justify-center rounded-block text-muted hover:bg-raised hover:text-ink"
              aria-label={t('workshop.openOnSteam', { name: campaign.title })}
              title={t('workshop.openOnSteam', { name: campaign.title })}
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
          {canPlay && (
            <Button size="sm" className="h-10" onClick={onPlay} disabled={!modes.length} icon={<Play className="h-4 w-4" />}>
              {t('l4d2.playNow')}
            </Button>
          )}
        </div>
      </div>
      {open && (
        <div id={panelId} className="mt-2 ps-6">
          {chapters.length === 0 ? (
            <p className="text-sm text-muted">{t('l4d2.noChaptersMode', { mode: modeLabel(mode, t) })}</p>
          ) : (
            <ol className="divide-y divide-line/60 rounded-block border border-line">
              {chapters.map((ch, i) => (
                <li key={ch.map} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="w-5 shrink-0 text-end text-xs tabular-nums text-muted">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{ch.title || ch.map}</span>
                    <span className="block truncate font-mono text-xs text-muted">{ch.map}</span>
                  </span>
                  {canPlay && (
                    <Button size="sm" variant="ghost" className="h-10 shrink-0" loading={busyMap === ch.map} disabled={!!busyMap} onClick={() => onChapter(ch.map)}>
                      {t('l4d2.goToChapter')}
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}

function Campaigns({ data, serverId, canPlay }: { data: L4dMapsOverview; serverId: string; canPlay: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const modes = data.modes?.length ? data.modes : [...L4D_MODES];
  const [mode, setMode] = useState<L4dGameMode>(() => (modes.includes(data.start.gameMode as L4dGameMode) ? (data.start.gameMode as L4dGameMode) : 'coop'));
  const [playing, setPlaying] = useState<L4dCampaign | null>(null);
  const [busyMap, setBusyMap] = useState<string | null>(null);
  const official = data.campaigns.filter((c) => c.source === 'official');
  const added = data.campaigns.filter((c) => c.source !== 'official');

  const goChapter = async (map: string) => {
    const ok = await confirm({ title: t('l4d2.goToChapterTitle', { map }), body: t('l4d2.goToChapterBody', { mode: modeLabel(mode, t) }), confirmLabel: t('l4d2.goToChapter') });
    if (!ok) return;
    setBusyMap(map);
    try {
      await l4d2Api.changeMap(serverId, { map, mode });
      toast.success(t('l4d2.mapChanged', { map }));
      await settle();
      void qc.invalidateQueries({ queryKey: l4d2Keys.maps(serverId) });
      void qc.invalidateQueries({ queryKey: l4d2Keys.controls(serverId) });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusyMap(null);
    }
  };

  const group = (title: string, list: L4dCampaign[]) =>
    list.length > 0 && (
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
          {title} ({list.length})
        </h3>
        <ul className="divide-y divide-line">
          {list.map((c) => (
            <CampaignRow key={c.id} campaign={c} mode={mode} canPlay={canPlay} onPlay={() => setPlaying(c)} onChapter={(m) => void goChapter(m)} busyMap={busyMap} />
          ))}
        </ul>
      </div>
    );

  return (
    <Section
      title={t('l4d2.campaigns')}
      description={data.officialFromGame ? t('l4d2.campaignsBody') : t('l4d2.campaignsBuiltin')}
      actions={
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">{t('l4d2.gameMode')}</span>
          <select className="input h-9 w-auto py-1" value={mode} onChange={(e) => setMode(e.target.value as L4dGameMode)}>
            {modes.map((m) => (
              <option key={m} value={m}>
                {modeLabel(m, t)}
              </option>
            ))}
          </select>
        </label>
      }
    >
      {data.campaigns.length === 0 ? (
        <EmptyState icon={<MapIcon className="h-10 w-10" />} title={t('l4d2.noCampaigns')} />
      ) : (
        <div className="space-y-5">
          {group(t('l4d2.official'), official)}
          {group(t('l4d2.fromAddons'), added)}
        </div>
      )}
      {playing && <PlayDialog campaign={playing} serverId={serverId} onClose={() => setPlaying(null)} />}
    </Section>
  );
}

interface AddonRow {
  key: string;
  workshopId: string | null;
  title: string;
  addon: L4dAddon | null;
  /** On the server's Workshop list (can be removed here). */
  listed: boolean;
  installed: boolean;
}

function addonRows(data: L4dMapsOverview): AddonRow[] {
  const rows: AddonRow[] = data.workshop.map((w) => {
    const addon = data.addons.find((a) => a.workshopId === w.id) ?? null;
    return { key: `w:${w.id}`, workshopId: w.id, title: addon?.title && addon.title !== addon.file.replace(/\.vpk$/i, '') ? addon.title : w.title || w.id, addon, listed: true, installed: w.installed };
  });
  for (const a of data.addons) {
    if (a.workshopId && data.workshop.some((w) => w.id === a.workshopId)) continue;
    rows.push({ key: `f:${a.file}`, workshopId: a.workshopId, title: a.title || a.file, addon: a, listed: false, installed: true });
  }
  return rows;
}

function AddWorkshop({ serverId, gameName, onAdded }: { serverId: string; gameName: string; onAdded: (restartRequired: boolean) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = raw.trim();
    if (!v) return;
    setBusy(true);
    try {
      const r = await workshopApi.add(serverId, v);
      const n = typeof r?.added === 'number' ? r.added : 1;
      if (n > 0) toast.success(t('l4d2.workshopAdded', { n }));
      else toast.info(t('l4d2.workshopAlready'));
      setRaw('');
      onAdded(!!r?.restartRequired);
      void qc.invalidateQueries({ queryKey: ['servers', serverId] });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'workshop_wrong_game') toast.error(t('workshop.wrongGame', { game: gameName }));
      else if (err instanceof ApiError && err.status === 404) toast.error(t('workshop.notFound'));
      else toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
      <label className="relative min-w-0 flex-1">
        <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        <input
          className="input pl-9 font-mono"
          value={raw}
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          aria-label={t('l4d2.addWorkshop')}
          placeholder={t('l4d2.addWorkshopPlaceholder')}
          onChange={(e) => setRaw(e.target.value)}
        />
      </label>
      <Button type="submit" variant="primary" loading={busy} disabled={!raw.trim()} icon={<Plus className="h-4 w-4" />}>
        {t('common.add')}
      </Button>
    </form>
  );
}

function WorkshopAddons({ data, serverId, manage, running, gameName }: { data: L4dMapsOverview; serverId: string; manage: boolean; running: boolean; gameName: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [changed, setChanged] = useState(false);
  const rows = addonRows(data);

  const remove = async (row: AddonRow) => {
    if (!row.workshopId) return;
    const ok = await confirm({ title: t('workshop.removeTitle', { name: row.title }), body: running ? t('workshop.nextStart') : undefined, danger: true, confirmLabel: t('common.remove') });
    if (!ok) return;
    try {
      const r = await workshopApi.remove(serverId, row.workshopId);
      toast.success(running ? t('workshop.removedNextStart', { name: row.title }) : t('workshop.removed', { name: row.title }));
      if (r?.restartRequired || running) setChanged(true);
      void qc.invalidateQueries({ queryKey: ['servers', serverId] });
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Section
      title={t('l4d2.addonsTitle', { n: rows.length })}
      description={t('l4d2.addonsBody')}
      actions={
        manage ? (
          <Link to="../workshop" className={buttonClass('primary', 'sm')}>
            <Search className="h-4 w-4" />
            {t('l4d2.findCampaigns')}
          </Link>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {(running || changed) && <Note>{t('workshop.nextStart')}</Note>}
        <p className="flex gap-2 rounded-block border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-muted">
          <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
          <span>{t('l4d2.playersNeedAddons')}</span>
        </p>
        {manage && <AddWorkshop serverId={serverId} gameName={gameName} onAdded={(r) => r && setChanged(true)} />}
        {rows.length === 0 ? (
          <EmptyState title={t('l4d2.noAddons')} body={t('l4d2.noAddonsBody')} />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((row) => {
              const a = row.addon;
              const status = a?.error ? 'damaged' : row.installed ? 'installed' : 'pending';
              return (
                <li key={row.key} className="flex items-start gap-3 py-2.5">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="min-w-0 break-words font-medium">{row.title}</span>
                      {a && <Badge tone={a.kind === 'campaign' ? 'accent' : 'neutral'}>{t(`l4d2.kind.${a.kind}` as TKey)}</Badge>}
                      {status === 'installed' ? (
                        <Badge tone="ok">{t('l4d2.addonInstalled')}</Badge>
                      ) : status === 'pending' ? (
                        <Badge tone="warn">{t('l4d2.addonPending')}</Badge>
                      ) : (
                        <Badge tone="danger">{t('l4d2.addonDamaged')}</Badge>
                      )}
                      {!row.listed && <Badge>{t('l4d2.addonManual')}</Badge>}
                    </div>
                    <p className="text-xs text-muted">
                      {[
                        row.workshopId,
                        a?.author ? t('catalog.by', { author: a.author }) : null,
                        a ? t('l4d2.mapsCount', { n: a.maps.length }) : null,
                        a ? formatBytes(a.sizeBytes) : null,
                        status === 'pending' ? t('l4d2.addonPendingHint') : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {a?.error && <p className="text-xs text-danger">{a.error}</p>}
                  </div>
                  {row.workshopId && (
                    <a
                      href={workshopUrl(row.workshopId)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-block text-muted hover:bg-raised hover:text-ink"
                      aria-label={t('workshop.openOnSteam', { name: row.title })}
                      title={t('workshop.openOnSteam', { name: row.title })}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                  {manage && row.listed && (
                    <IconButton label={t('workshop.removeTitle', { name: row.title })} className="h-10 w-10 shrink-0 hover:text-danger" onClick={() => void remove(row)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );
}

export default function L4d2Maps() {
  const t = useT();
  const { server, def } = useServerCtx();
  const q = useL4dMaps(server.id);
  const running = server.status === 'running';
  const notStopped = server.status !== 'stopped' && server.status !== 'crashed';

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error ?? new Error(t('l4d2.loadFailed'))} onRetry={() => void q.refetch()} />;
  const data = q.data;

  return (
    <div className="space-y-4">
      {!data.gameInstalled && <WarnBanner title={t('l4d2.notInstalledTitle')}>{t('l4d2.notInstalledMaps')}</WarnBanner>}
      <Section title={t('l4d2.mapsStatus')}>
        <StartSummary data={data} running={notStopped} />
      </Section>
      <Campaigns data={data} serverId={server.id} canPlay={canOperate(server.access) && running} />
      <WorkshopAddons data={data} serverId={server.id} manage={canManage(server.access)} running={notStopped} gameName={def?.name ?? ''} />
    </div>
  );
}
