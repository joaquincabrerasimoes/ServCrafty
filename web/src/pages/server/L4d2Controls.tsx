import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bot, DoorOpen, Gift, Map as MapIcon, Play, RefreshCw } from 'lucide-react';
import { l4d2Api, l4d2Keys } from '@/api';
import type { L4dCharacter, L4dControls, L4dDifficulty, L4dGameMode, L4dPlayer } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { qk } from '@/lib/queries';
import { chaptersOf, difficultyLabel, modeLabel, modesOf, settle, useL4dMaps } from '@/lib/l4d2';
import { toast } from '@/stores/toast';
import { L4d2MapPicker } from '@/components/L4d2MapPicker';
import { Badge, Button, EmptyState, ErrorState, Loading, Modal, Section, WarnBanner } from '@/components/ui';
import { Note } from '../create/TerrariaConfigStep';
import { useServerCtx } from './ServerLayout';

/** Item groups with a translated name (others show the API label). */
const ITEM_GROUPS = ['primary', 'secondary', 'throwable', 'health', 'upgrade', 'carry'];

type Act =(key: string, fn: () => Promise<unknown>, success: string, opts?: { persisted?: boolean }) => Promise<boolean>;

function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={clsx('flex min-h-10 items-center gap-3 text-sm', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function ModeSelect({ value, onChange, modes, disabled }: { value: L4dGameMode; onChange: (m: L4dGameMode) => void; modes: L4dGameMode[]; disabled?: boolean }) {
  const t = useT();
  return (
    <label className="block">
      <span className="label">{t('l4d2.gameMode')}</span>
      <select className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as L4dGameMode)}>
        {modes.map((m) => (
          <option key={m} value={m}>
            {modeLabel(m, t)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** (A) any map / (B) a campaign from its first chapter. */
function ChangeMap({ serverId, data, enabled, act, busy }: { serverId: string; data: L4dControls; enabled: boolean; act: Act; busy: string | null }) {
  const t = useT();
  const maps = useL4dMaps(serverId);
  const modes = data.modes;
  const startMode = (modes as string[]).includes(data.start.gameMode) ? (data.start.gameMode as L4dGameMode) : (modes[0] ?? 'coop');
  const [tab, setTab] = useState<'map' | 'campaign'>('map');
  const [map, setMap] = useState(data.map ?? '');
  const [mode, setMode] = useState<L4dGameMode>(startMode);
  const [persist, setPersist] = useState(false);
  const [campaignId, setCampaignId] = useState('');
  const campaigns = maps.data?.campaigns ?? [];
  const campaign = campaigns.find((c) => c.id === campaignId);
  const campaignModes = campaign ? modesOf(campaign) : modes;
  const campaignMode = campaignModes.includes(mode) ? mode : (campaignModes[0] ?? mode);
  const validMap = /^[A-Za-z0-9_.-]{1,64}$/.test(map);

  const tabs: Array<{ id: 'map' | 'campaign'; key: TKey }> = [
    { id: 'map', key: 'l4d2.changeMapTab' },
    { id: 'campaign', key: 'l4d2.changeCampaignTab' },
  ];

  return (
    <Section
      title={t('l4d2.changeMap')}
      actions={
        <div className="inline-flex rounded-block border border-line p-0.5" role="tablist">
          {tabs.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={tab === x.id}
              onClick={() => setTab(x.id)}
              className={clsx('h-9 rounded-[2px] px-3 text-sm', tab === x.id ? 'bg-raised font-medium' : 'text-muted hover:text-ink')}
            >
              {t(x.key)}
            </button>
          ))}
        </div>
      }
    >
      {tab === 'map' ? (
        <div className="space-y-4">
          <L4d2MapPicker serverId={serverId} value={map} onChange={setMap} mode={mode} disabled={!enabled} />
          <div className="grid gap-4 sm:grid-cols-2">
            <ModeSelect value={mode} onChange={setMode} modes={modes} disabled={!enabled} />
          </div>
          <Check checked={persist} onChange={setPersist} label={t('l4d2.persistMap')} disabled={!enabled} />
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!enabled || !validMap || (!!busy && busy !== 'map')}
              loading={busy === 'map'}
              icon={<MapIcon className="h-4 w-4" />}
              onClick={() => void act('map', () => l4d2Api.changeMap(serverId, { map, mode, persist }), t('l4d2.mapChanged', { map }), { persisted: persist })}
            >
              {t('l4d2.changeMapAction')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block min-w-0">
              <span className="label">{t('l4d2.picker.campaign')}</span>
              <select className="input" value={campaignId} disabled={!enabled || !campaigns.length} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">{maps.isLoading ? t('common.loading') : t('l4d2.chooseCampaign')}</option>
                {(['official', 'addon'] as const).map((src) => {
                  const list = campaigns.filter((c) => (src === 'official' ? c.source === 'official' : c.source !== 'official'));
                  if (!list.length) return null;
                  return (
                    <optgroup key={src} label={src === 'official' ? t('l4d2.picker.official') : t('l4d2.picker.addons')}>
                      {list.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </label>
            <ModeSelect value={campaignMode} onChange={setMode} modes={campaignModes} disabled={!enabled || !campaign} />
          </div>
          {campaign && (
            <p className="text-xs text-muted">
              {t('l4d2.campaignStartsAt', { map: chaptersOf(campaign, campaignMode)[0]?.map ?? '–', n: chaptersOf(campaign, campaignMode).length })}
            </p>
          )}
          {maps.error ? <ErrorState error={maps.error} onRetry={() => void maps.refetch()} /> : null}
          <Check checked={persist} onChange={setPersist} label={t('l4d2.persistCampaign')} disabled={!enabled} />
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!enabled || !campaign || (!!busy && busy !== 'campaign')}
              loading={busy === 'campaign'}
              icon={<Play className="h-4 w-4" />}
              onClick={() =>
                campaign &&
                void act(
                  'campaign',
                  () => l4d2Api.changeMap(serverId, { campaign: campaign.id, mode: campaignMode, persist }),
                  t('l4d2.campaignStarted', { name: campaign.title }),
                  { persisted: persist },
                )
              }
            >
              {t('l4d2.startCampaign')}
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function Difficulty({ serverId, data, enabled, act, busy }: { serverId: string; data: L4dControls; enabled: boolean; act: Act; busy: string | null }) {
  const t = useT();
  const [persist, setPersist] = useState(false);
  const [last, setLast] = useState<L4dDifficulty | null>(null);
  return (
    <Section title={t('l4d2.difficultyTitle')} description={t('l4d2.difficultyBody', { start: difficultyLabel(data.start.difficulty, t) })}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label={t('l4d2.difficultyTitle')}>
          {data.difficulties.map((d) => (
            <Button
              key={d.value}
              className={clsx('h-11', last === d.value && 'border-accent text-accent')}
              aria-pressed={last === d.value}
              disabled={!enabled || (!!busy && busy !== `diff:${d.value}`)}
              loading={busy === `diff:${d.value}`}
              onClick={() =>
                void act(`diff:${d.value}`, () => l4d2Api.difficulty(serverId, d.value, persist), t('l4d2.difficultySet', { name: difficultyLabel(d.value, t, d.label) }), {
                  persisted: persist,
                }).then((ok) => ok && setLast(d.value))
              }
            >
              {difficultyLabel(d.value, t, d.label)}
            </Button>
          ))}
        </div>
        <Check checked={persist} onChange={setPersist} label={t('l4d2.persistDifficulty')} disabled={!enabled} />
      </div>
    </Section>
  );
}

function KickDialog({ player, onClose, onKick, busy }: { player: L4dPlayer; onClose: () => void; onKick: (reason: string) => void; busy: boolean }) {
  const t = useT();
  const [reason, setReason] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title={t('l4d2.kickTitle', { name: player.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => onKick(reason.trim())} icon={<DoorOpen className="h-4 w-4" />}>
            {t('players.action.kick')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onKick(reason.trim());
        }}
      >
        <label className="block">
          <span className="label">{t('l4d2.kickReason')}</span>
          <input className="input" value={reason} maxLength={80} placeholder={t('l4d2.kickReasonPlaceholder')} onChange={(e) => setReason(e.target.value)} />
        </label>
      </form>
    </Modal>
  );
}

function GiveDialog({ player, groups, onClose, onGive, busy }: { player: L4dPlayer; groups: L4dControls['items']; onClose: () => void; onGive: (item: string, label: string) => void; busy: boolean }) {
  const t = useT();
  const [item, setItem] = useState<{ id: string; label: string } | null>(null);
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={t('l4d2.giveTitle', { name: player.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!item} onClick={() => item && onGive(item.id, item.label)} icon={<Gift className="h-4 w-4" />} data-autofocus>
            {item ? t('l4d2.giveItem', { item: item.label }) : t('l4d2.give')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-muted">{t('l4d2.giveHint')}</p>
        {groups.map((g) => (
          <fieldset key={g.id}>
            <legend className="mb-1.5 text-sm font-medium">{ITEM_GROUPS.includes(g.id) ? t(`l4d2.itemGroup.${g.id}` as TKey) : g.label}</legend>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {g.items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  aria-pressed={item?.id === it.id}
                  onClick={() => setItem(it)}
                  className={clsx(
                    'min-h-10 rounded-block border px-2.5 py-1.5 text-start text-sm transition-colors',
                    item?.id === it.id ? 'border-accent bg-accent/10 font-medium text-accent' : 'border-line hover:bg-raised',
                  )}
                >
                  {it.label}
                </button>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </Modal>
  );
}

function TeamSize({ serverId, data, enabled, act, busy }: { serverId: string; data: L4dControls; enabled: boolean; act: Act; busy: string | null }) {
  const t = useT();
  const { size, min, max, available } = data.team;
  const [value, setValue] = useState<number>(Math.min(max, Math.max(min, size ?? 8)));
  const ready = enabled && available;
  return (
    <Section title={t('l4d2.teamTitle')}>
      <p className="mb-3 text-sm text-muted">{available ? t('l4d2.teamHint', { n: size ?? 0 }) : t('l4d2.teamNeedPlugin')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="label">{t('l4d2.teamLabel', { min, max })}</span>
          <input className="input w-28" type="number" min={min} max={max} step={1} value={value} disabled={!ready} onChange={(e) => setValue(Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min))))} />
        </label>
        <Button variant="primary" disabled={!ready} loading={busy === 'team'} onClick={() => void act('team', () => l4d2Api.setTeamSize(serverId, value), t('l4d2.teamSet', { n: value }))}>
          {t('l4d2.teamApply')}
        </Button>
      </div>
    </Section>
  );
}

function BotSpawner({ serverId, data, enabled, act, busy }: { serverId: string; data: L4dControls; enabled: boolean; act: Act; busy: string | null }) {
  const t = useT();
  const chars = data.bots.characters;
  // Characters nobody plays yet come first (and the first of them is the default); the Left 4 Dead 1 ones are marked.
  const sorted = [...chars].sort((a, b) => Number(a.inUse) - Number(b.inUse) || a.id - b.id);
  const free = sorted.find((c) => !c.inUse) ?? sorted[0];
  const [pick, setPick] = useState<number | null>(null);
  const choice = chars.find((c) => c.id === pick) ?? free;
  const ready = enabled && data.bots.available;
  const add = (c: L4dCharacter | undefined) => {
    if (!c) return;
    void act(`bot:${c.id}`, () => l4d2Api.addBot(serverId, c.id), t('l4d2.botAdded', { name: c.name })).then((ok) => ok && setPick(null));
  };
  return (
    <Section title={t('l4d2.botsTitle')}>
      {!data.bots.available && enabled && <p className="mb-3 text-sm text-muted">{t('l4d2.botsNeedPlugin')}</p>}
      <p className="mb-3 text-sm text-muted">{t('l4d2.botsHint')}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {sorted.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={!ready}
            aria-pressed={choice?.id === c.id}
            onClick={() => setPick(c.id)}
            className={clsx(
              'min-h-10 rounded-block border px-2.5 py-1.5 text-start text-sm transition-colors disabled:opacity-50',
              choice?.id === c.id ? 'border-accent bg-accent/10 font-medium text-accent' : 'border-line hover:bg-raised',
            )}
          >
            <span className="block">{c.name}</span>
            <span className="block text-xs text-muted">
              {c.game === 'l4d1' ? t('l4d2.botFromL4d1') : t('l4d2.botFromL4d2')}
              {c.inUse ? ` · ${t('l4d2.botInUse')}` : ` · ${t('l4d2.botFree')}`}
            </span>
          </button>
        ))}
      </div>
      <div className="mt-3">
        <Button variant="primary" disabled={!ready || !choice} loading={busy === `bot:${choice?.id}`} onClick={() => add(choice)} icon={<Bot className="h-4 w-4" />}>
          {choice ? t('l4d2.botAdd', { name: choice.name }) : t('l4d2.botAddGeneric')}
        </Button>
      </div>
    </Section>
  );
}

function Players({ serverId, data, enabled, act, busy, onRefresh, refreshing }: { serverId: string; data: L4dControls; enabled: boolean; act: Act; busy: string | null; onRefresh: () => void; refreshing: boolean }) {
  const t = useT();
  const [kick, setKick] = useState<L4dPlayer | null>(null);
  const [give, setGive] = useState<L4dPlayer | null>(null);
  const humans = data.players.filter((p) => !p.bot).length;
  return (
    <Section
      title={t('l4d2.playersTitle', { n: humans, bots: data.players.length - humans })}
      actions={
        <Button size="sm" loading={refreshing} onClick={onRefresh} icon={<RefreshCw className="h-4 w-4" />}>
          {t('common.refresh')}
        </Button>
      }
    >
      {data.players.length === 0 ? (
        <EmptyState title={t('overview.noPlayers')} body={!enabled ? t('l4d2.mustBeRunning') : undefined} />
      ) : (
        <ul className="divide-y divide-line">
          {data.players.map((p) => (
            <li key={p.userId} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="break-all font-medium">{p.name}</span>
                  {p.bot && (
                    <Badge>
                      <Bot className="h-3 w-3" aria-hidden="true" />
                      {t('l4d2.bot')}
                    </Badge>
                  )}
                </div>
                <div className="break-all text-xs text-muted">
                  {[
                    `#${p.userId}`,
                    p.steamId,
                    p.state,
                    p.ping != null ? t('l4d2.ping', { n: p.ping }) : null,
                    p.connected ? t('l4d2.connectedFor', { time: p.connected }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="h-10" disabled={!enabled || !!busy} onClick={() => setGive(p)} icon={<Gift className="h-4 w-4" />}>
                  {t('l4d2.give')}
                </Button>
                <Button size="sm" variant="ghost" className="h-10 text-danger" disabled={!enabled || p.bot || !!busy} onClick={() => setKick(p)} icon={<DoorOpen className="h-4 w-4" />}>
                  {t('players.action.kick')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">{t('l4d2.giveHint')}</p>
      {kick && (
        <KickDialog
          player={kick}
          busy={busy === `kick:${kick.userId}`}
          onClose={() => setKick(null)}
          onKick={(reason) =>
            void act(`kick:${kick.userId}`, () => l4d2Api.kick(serverId, kick.userId, reason || undefined), t('l4d2.kicked', { name: kick.name })).then((ok) => ok && setKick(null))
          }
        />
      )}
      {give && (
        <GiveDialog
          player={give}
          groups={data.items}
          busy={busy === `give:${give.userId}`}
          onClose={() => setGive(null)}
          onGive={(item, label) =>
            void act(`give:${give.userId}`, () => l4d2Api.give(serverId, give.userId, item), t('l4d2.given', { item: label, name: give.name })).then((ok) => ok && setGive(null))
          }
        />
      )}
    </Section>
  );
}

export default function L4d2Controls() {
  const t = useT();
  const qc = useQueryClient();
  const { server } = useServerCtx();
  // `status` is printed in the game console: read on open, on Refresh and after actions only (never on a timer).
  const q = useQuery({
    queryKey: l4d2Keys.controls(server.id),
    queryFn: () => l4d2Api.controls(server.id),
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const data = q.data;
  const enabled = server.status === 'running' && !!data?.running;

  // Read once more when the server finishes starting while this tab is open.
  const prevStatus = useRef(server.status);
  useEffect(() => {
    if (prevStatus.current !== 'running' && server.status === 'running') void q.refetch();
    prevStatus.current = server.status;
  }, [server.status, q]);

  const act: Act = async (key, fn, success, opts) => {
    setBusy(key);
    try {
      await fn();
      toast.success(success);
      if (opts?.persisted) void qc.invalidateQueries({ queryKey: qk.server(server.id) });
      await settle();
      void q.refetch();
      void qc.invalidateQueries({ queryKey: l4d2Keys.maps(server.id) });
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (q.isLoading) return <Loading />;
  if (q.error || !data) return <ErrorState error={q.error ?? new Error(t('l4d2.loadFailed'))} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-4">
      {!enabled && <WarnBanner title={t('l4d2.mustBeRunning')}>{t('l4d2.mustBeRunningBody')}</WarnBanner>}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          [t('l4d2.currentMap'), enabled ? (data.map ?? '–') : '–'],
          [t('l4d2.startMode'), modeLabel(data.start.gameMode, t)],
          [t('l4d2.startDifficulty'), difficultyLabel(data.start.difficulty, t)],
        ].map(([k, v]) => (
          <div key={k} className="panel min-w-0 px-3 py-2">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="truncate font-mono text-sm" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <Note>{t('l4d2.controlsNote')}</Note>
      <ChangeMap serverId={server.id} data={data} enabled={enabled} act={act} busy={busy} />
      <Difficulty serverId={server.id} data={data} enabled={enabled} act={act} busy={busy} />
      <TeamSize serverId={server.id} data={data} enabled={enabled} act={act} busy={busy} />
      <BotSpawner serverId={server.id} data={data} enabled={enabled} act={act} busy={busy} />
      <Players serverId={server.id} data={data} enabled={enabled} act={act} busy={busy} onRefresh={() => void q.refetch()} refreshing={q.isFetching} />
    </div>
  );
}
