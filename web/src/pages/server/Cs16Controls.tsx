import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Ban, Bot, DoorOpen, Map as MapIcon, MessageSquare, RefreshCw, RotateCcw, Save, Swords, UserMinus, UserPlus } from 'lucide-react';
import { cs16Api, cs16Keys } from '@/api';
import type { Cs16BotDifficulty, Cs16Controls as Controls, Cs16MatchSetting, Cs16Player, Cs16QuotaMode, Cs16SettingValue } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { qk } from '@/lib/queries';
import { settle } from '@/lib/l4d2';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, EmptyState, ErrorState, Loading, Modal, Section, Toggle, WarnBanner } from '@/components/ui';
import { Note } from '../create/TerrariaConfigStep';
import { useServerCtx } from './ServerLayout';

type Act = (key: string, fn: () => Promise<unknown>, success: string, opts?: { persisted?: boolean }) => Promise<boolean>;
interface PartProps {
  serverId: string;
  data: Controls;
  enabled: boolean;
  act: Act;
  busy: string | null;
}

const BAN_MAX = 60 * 24 * 365;
const QUOTA_MAX = 32;
const QUOTA_MODES: Cs16QuotaMode[] = ['normal', 'fill', 'match'];
const DIFFICULTIES: Cs16BotDifficulty[] = ['easy', 'normal', 'hard', 'expert'];
const GROUPS: Array<Cs16MatchSetting['group']> = ['time', 'economy', 'rules'];

const clampInt = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={clsx('flex min-h-10 items-center gap-3 text-sm', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/* ---------------------------------------------------------------- Players */

function KickDialog({ player, onClose, onKick, busy }: { player: Cs16Player; onClose: () => void; onKick: (reason: string) => void; busy: boolean }) {
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

function BanDialog({ player, onClose, onBan, busy }: { player: Cs16Player; onClose: () => void; onBan: (minutes: number) => void; busy: boolean }) {
  const t = useT();
  const [raw, setRaw] = useState('60');
  const n = Number(raw);
  const valid = raw.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= BAN_MAX;
  const submit = () => valid && onBan(n);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('cs16.banTitle', { name: player.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} disabled={!valid} onClick={submit} icon={<Ban className="h-4 w-4" />}>
            {valid && n === 0 ? t('cs16.banForever') : t('cs16.ban')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="block">
          <span className="label">{t('cs16.banMinutes')}</span>
          <input
            className="input w-40"
            type="number"
            inputMode="numeric"
            min={0}
            max={BAN_MAX}
            step={1}
            value={raw}
            aria-invalid={!valid}
            onChange={(e) => setRaw(e.target.value)}
          />
          {valid ? <span className="hint block">{t('cs16.banMinutesHint')}</span> : <span className="mt-1 block text-xs text-danger">{t('mc.rangeHint', { min: 0, max: BAN_MAX })}</span>}
        </label>
        <p className="text-sm text-muted">{t('cs16.banBody', { steamId: player.steamId ?? '–' })}</p>
      </form>
    </Modal>
  );
}

function Players({ serverId, data, enabled, act, busy, onRefresh, refreshing }: PartProps & { onRefresh: () => void; refreshing: boolean }) {
  const t = useT();
  const [kick, setKick] = useState<Cs16Player | null>(null);
  const [ban, setBan] = useState<Cs16Player | null>(null);
  const humans = data.players.filter((p) => !p.bot).length;
  const dash = (v: number | string | null) => (v == null ? '–' : String(v));
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
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="w-full min-w-0 text-sm">
            <thead>
              <tr className="border-b border-line text-start text-xs text-muted">
                <th scope="col" className="px-4 py-2 text-start font-medium sm:ps-0">
                  {t('cs16.colName')}
                </th>
                <th scope="col" className="px-2 py-2 text-end font-medium">
                  {t('cs16.colFrags')}
                </th>
                <th scope="col" className="hidden px-2 py-2 text-end font-medium sm:table-cell">
                  {t('cs16.colTime')}
                </th>
                <th scope="col" className="hidden px-2 py-2 text-end font-medium sm:table-cell">
                  {t('cs16.colPing')}
                </th>
                <th scope="col" className="hidden px-2 py-2 text-end font-medium md:table-cell">
                  {t('cs16.colLoss')}
                </th>
                <th scope="col" className="px-4 py-2 sm:pe-0">
                  <span className="sr-only">{t('cs16.colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.players.map((p) => (
                <tr key={p.userId} className="align-middle">
                  <td className="max-w-0 px-4 py-2 sm:ps-0">
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
                      {[`#${p.userId}`, !p.bot ? p.steamId : null, p.ping != null ? t('l4d2.ping', { n: p.ping }) : null].filter(Boolean).join(' · ')}
                      <span className="sm:hidden">{p.connected ? ` · ${p.connected}` : ''}</span>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-end tabular-nums">{dash(p.frags)}</td>
                  <td className="hidden px-2 py-2 text-end font-mono text-xs sm:table-cell">{dash(p.connected)}</td>
                  <td className="hidden px-2 py-2 text-end tabular-nums sm:table-cell">{dash(p.ping)}</td>
                  <td className="hidden px-2 py-2 text-end tabular-nums md:table-cell">{dash(p.loss)}</td>
                  <td className="px-4 py-2 sm:pe-0">
                    <div className="flex justify-end gap-1">
                      {p.bot ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-10 text-danger"
                          disabled={!enabled || (!!busy && busy !== `kick:${p.userId}`)}
                          loading={busy === `kick:${p.userId}`}
                          onClick={() => void act(`kick:${p.userId}`, () => cs16Api.kick(serverId, p.userId), t('l4d2.kicked', { name: p.name }))}
                          icon={<DoorOpen className="h-4 w-4" />}
                        >
                          {t('l4d2.kickBot')}
                        </Button>
                      ) : (
                        <>
                          <Button size="sm" variant="ghost" className="h-10 text-danger" disabled={!enabled || !!busy} onClick={() => setKick(p)} icon={<DoorOpen className="h-4 w-4" />}>
                            {t('players.action.kick')}
                          </Button>
                          <Button size="sm" variant="ghost" className="h-10 text-danger" disabled={!enabled || !!busy} onClick={() => setBan(p)} icon={<Ban className="h-4 w-4" />}>
                            {t('cs16.ban')}
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {kick && (
        <KickDialog
          player={kick}
          busy={busy === `kick:${kick.userId}`}
          onClose={() => setKick(null)}
          onKick={(reason) =>
            void act(`kick:${kick.userId}`, () => cs16Api.kick(serverId, kick.userId, reason || undefined), t('l4d2.kicked', { name: kick.name })).then((ok) => ok && setKick(null))
          }
        />
      )}
      {ban && (
        <BanDialog
          player={ban}
          busy={busy === `ban:${ban.userId}`}
          onClose={() => setBan(null)}
          onBan={(minutes) =>
            void act(
              `ban:${ban.userId}`,
              () => cs16Api.ban(serverId, ban.userId, minutes),
              minutes === 0 ? t('cs16.bannedForever', { name: ban.name }) : t('cs16.banned', { name: ban.name, n: minutes }),
            ).then((ok) => ok && setBan(null))
          }
        />
      )}
    </Section>
  );
}

/* ---------------------------------------------------------------- Map and round */

function ChangeMap({ serverId, data, enabled, act, busy }: PartProps) {
  const t = useT();
  const [map, setMap] = useState(() => (data.map && data.maps.includes(data.map) ? data.map : (data.maps[0] ?? '')));
  const [persist, setPersist] = useState(false);
  return (
    <Section title={t('l4d2.changeMap')}>
      <div className="space-y-4">
        <label className="block max-w-md">
          <span className="label">{t('cs16.mapLabel')}</span>
          <select className="input" value={map} disabled={!enabled || !data.maps.length} onChange={(e) => setMap(e.target.value)}>
            {data.maps.length === 0 && <option value="">{t('cs16.noMaps')}</option>}
            {data.maps.map((m) => (
              <option key={m} value={m}>
                {m}
                {m === data.map ? ` (${t('cs16.current')})` : ''}
              </option>
            ))}
          </select>
        </label>
        <Check checked={persist} onChange={setPersist} label={t('cs16.persistMap')} disabled={!enabled} />
        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={!enabled || !map || (!!busy && busy !== 'map')}
            loading={busy === 'map'}
            icon={<MapIcon className="h-4 w-4" />}
            onClick={() => void act('map', () => cs16Api.changeMap(serverId, map, persist), t('l4d2.mapChanged', { map }), { persisted: persist })}
          >
            {t('cs16.changeMapNow')}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function Round({ serverId, enabled, act, busy }: PartProps) {
  const t = useT();
  const [message, setMessage] = useState('');
  const restartGame = async () => {
    const ok = await confirm({ title: t('cs16.restartGameTitle'), body: t('cs16.restartGameBody'), confirmLabel: t('cs16.restartGame'), danger: true });
    if (ok) void act('restart:game', () => cs16Api.restart(serverId, 'game'), t('cs16.gameRestarted'));
  };
  const send = () => {
    const m = message.trim();
    if (!m) return;
    void act('say', () => cs16Api.say(serverId, m), t('cs16.said')).then((ok) => ok && setMessage(''));
  };
  return (
    <Section title={t('cs16.roundTitle')}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button
            className="h-11"
            disabled={!enabled || (!!busy && busy !== 'restart:round')}
            loading={busy === 'restart:round'}
            icon={<RotateCcw className="h-4 w-4" />}
            onClick={() => void act('restart:round', () => cs16Api.restart(serverId, 'round'), t('cs16.roundRestarted'))}
          >
            {t('cs16.restartRound')}
          </Button>
          <Button
            className="h-11"
            disabled={!enabled || (!!busy && busy !== 'restart:game')}
            loading={busy === 'restart:game'}
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={() => void restartGame()}
          >
            {t('cs16.restartGame')}
          </Button>
        </div>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <label className="block min-w-0 flex-1">
            <span className="label">{t('cs16.sayLabel')}</span>
            <input className="input" value={message} maxLength={190} disabled={!enabled} placeholder={t('cs16.sayPlaceholder')} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <Button type="submit" variant="primary" disabled={!enabled || !message.trim() || (!!busy && busy !== 'say')} loading={busy === 'say'} icon={<MessageSquare className="h-4 w-4" />}>
            {t('cs16.say')}
          </Button>
        </form>
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- Bots */

function Bots({ serverId, data, enabled, act, busy }: PartProps) {
  const t = useT();
  const yapb = data.bots.engine === 'yapb';
  const [quota, setQuota] = useState(0);
  const [mode, setMode] = useState<Cs16QuotaMode>('normal');
  const [level, setLevel] = useState<Cs16BotDifficulty>('normal');
  const [knives, setKnives] = useState(false);
  const off = (key: string) => !enabled || (!!busy && busy !== key);
  return (
    <Section title={t('cs16.botsTitle')} description={yapb ? t('cs16.botsYapb') : t('cs16.botsStock')}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={yapb ? 'accent' : 'neutral'}>
            <Bot className="h-3 w-3" aria-hidden="true" />
            {yapb ? t('cs16.engineYapb') : t('cs16.engineStock')}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['any', 'cs16.addBot'],
              ['t', 'cs16.addBotT'],
              ['ct', 'cs16.addBotCt'],
            ] as const
          ).map(([team, key]) => (
            <Button
              key={team}
              className="h-11"
              disabled={off(`add:${team}`)}
              loading={busy === `add:${team}`}
              icon={<UserPlus className="h-4 w-4" />}
              onClick={() => void act(`add:${team}`, () => cs16Api.bots(serverId, { action: 'add', team }), t('cs16.botAdded'))}
            >
              {t(key)}
            </Button>
          ))}
          <Button
            className="h-11 text-danger"
            disabled={off('kick_all')}
            loading={busy === 'kick_all'}
            icon={<UserMinus className="h-4 w-4" />}
            onClick={() => void act('kick_all', () => cs16Api.bots(serverId, { action: 'kick_all' }), t('cs16.botsKicked'))}
          >
            {t('cs16.kickAllBots')}
          </Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex items-end gap-2">
            <label className="block">
              <span className="label">{t('cs16.botQuota', { max: QUOTA_MAX })}</span>
              <input className="input w-28" type="number" inputMode="numeric" min={0} max={QUOTA_MAX} step={1} value={quota} disabled={!enabled} onChange={(e) => setQuota(clampInt(e.target.value, 0, QUOTA_MAX))} />
            </label>
            <Button disabled={off('quota')} loading={busy === 'quota'} onClick={() => void act('quota', () => cs16Api.bots(serverId, { action: 'quota', count: quota }), t('cs16.quotaSet', { n: quota }))}>
              {t('cs16.apply')}
            </Button>
          </div>
          <div className="flex items-end gap-2">
            <label className="block min-w-0 flex-1">
              <span className="label">{t('cs16.quotaMode')}</span>
              <select className="input" value={mode} disabled={!enabled} onChange={(e) => setMode(e.target.value as Cs16QuotaMode)}>
                {QUOTA_MODES.map((m) => (
                  <option key={m} value={m}>
                    {t(`cs16.quotaMode.${m}` as TKey)}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={off('quota_mode')}
              loading={busy === 'quota_mode'}
              onClick={() => void act('quota_mode', () => cs16Api.bots(serverId, { action: 'quota_mode', mode }), t('cs16.quotaModeSet', { mode: t(`cs16.quotaMode.${mode}` as TKey) }))}
            >
              {t('cs16.apply')}
            </Button>
          </div>
          {!yapb && (
            <>
              <div className="flex items-end gap-2">
                <label className="block min-w-0 flex-1">
                  <span className="label">{t('cs16.botDifficulty')}</span>
                  <select className="input" value={level} disabled={!enabled} onChange={(e) => setLevel(e.target.value as Cs16BotDifficulty)}>
                    {DIFFICULTIES.map((d) => (
                      <option key={d} value={d}>
                        {t(`cs16.difficulty.${d}` as TKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  disabled={off('difficulty')}
                  loading={busy === 'difficulty'}
                  onClick={() =>
                    void act('difficulty', () => cs16Api.bots(serverId, { action: 'difficulty', level }), t('cs16.difficultySet', { level: t(`cs16.difficulty.${level}` as TKey) }))
                  }
                >
                  {t('cs16.apply')}
                </Button>
              </div>
              <div className="flex min-h-10 items-end">
                <Toggle
                  checked={knives}
                  disabled={off('knives')}
                  label={t('cs16.knivesOnly')}
                  onChange={(on) =>
                    void act('knives', () => cs16Api.bots(serverId, { action: 'knives_only', on }), on ? t('cs16.knivesOn') : t('cs16.knivesOff')).then((ok) => ok && setKnives(on))
                  }
                />
              </div>
            </>
          )}
        </div>
        <p className="text-xs text-muted">{t('cs16.botsQuotaHint')}</p>
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- Match settings */

function MatchSettings({ serverId, settings, running, onSaved }: { serverId: string; settings: Cs16MatchSetting[]; running: boolean; onSaved: () => void }) {
  const t = useT();
  const initial = useMemo(() => Object.fromEntries(settings.map((s) => [s.key, s.type === 'boolean' ? s.value === true : String(s.value)])), [settings]);
  const [vals, setVals] = useState<Record<string, string | boolean>>(initial);
  const [saving, setSaving] = useState(false);
  const errors: Record<string, string> = {};
  for (const s of settings) {
    if (s.type !== 'number') continue;
    const raw = String(vals[s.key] ?? '');
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isInteger(n)) errors[s.key] = t('cs16.wholeNumber');
    else if ((s.min !== undefined && n < s.min) || (s.max !== undefined && n > s.max)) errors[s.key] = t('mc.rangeHint', { min: s.min ?? '–', max: s.max ?? '–' });
  }
  const changed = settings.filter((s) => String(vals[s.key]) !== String(initial[s.key]));
  const invalid = Object.keys(errors).length > 0;

  const save = async () => {
    const out: Record<string, Cs16SettingValue> = {};
    for (const s of changed) out[s.key] = s.type === 'boolean' ? vals[s.key] === true : Number(vals[s.key]);
    setSaving(true);
    try {
      const r = await cs16Api.settings(serverId, out);
      toast.success(r?.appliedLive ? t('cs16.settingsLive') : t('cs16.settingsSaved'));
      onSaved();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={t('cs16.settingsTitle')} description={running ? t('cs16.settingsBodyRunning') : t('cs16.settingsBodyStopped')}>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid && changed.length) void save();
        }}
      >
        {GROUPS.map((g) => {
          const list = settings.filter((s) => s.group === g);
          if (!list.length) return null;
          return (
            <fieldset key={g} className="space-y-3">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t(`cs16.settingsGroup.${g}` as TKey)}</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {list.map((s) =>
                  s.type === 'boolean' ? (
                    <div key={s.key} className="min-w-0">
                      <Toggle checked={vals[s.key] === true} onChange={(v) => setVals((f) => ({ ...f, [s.key]: v }))} label={t(`cs16.setting.${s.key}` as TKey)} disabled={saving} />
                      <p className="hint">
                        {t(`cs16.settingHint.${s.key}` as TKey)} <span className="font-mono">{s.key}</span>
                      </p>
                    </div>
                  ) : (
                    <label key={s.key} className="block min-w-0">
                      <span className="label">{t(`cs16.setting.${s.key}` as TKey)}</span>
                      <input
                        className="input"
                        type="number"
                        inputMode="numeric"
                        step={1}
                        min={s.min}
                        max={s.max}
                        value={String(vals[s.key] ?? '')}
                        disabled={saving}
                        aria-invalid={!!errors[s.key]}
                        onChange={(e) => setVals((f) => ({ ...f, [s.key]: e.target.value }))}
                      />
                      {errors[s.key] ? (
                        <span className="mt-1 block text-xs text-danger">{errors[s.key]}</span>
                      ) : (
                        <span className="hint block">
                          {t(`cs16.settingHint.${s.key}` as TKey)} <span className="font-mono">{s.key}</span>
                        </span>
                      )}
                    </label>
                  ),
                )}
              </div>
            </fieldset>
          );
        })}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {changed.length > 0 && <span className="text-xs text-muted">{t('cs16.settingsChanged', { n: changed.length })}</span>}
          <Button type="submit" variant="primary" loading={saving} disabled={invalid || !changed.length} icon={<Save className="h-4 w-4" />}>
            {t('cs16.apply')}
          </Button>
        </div>
      </form>
    </Section>
  );
}

/* ---------------------------------------------------------------- Page */

export default function Cs16Controls() {
  const t = useT();
  const qc = useQueryClient();
  const { server } = useServerCtx();
  // `status` is printed in the game console: read on open, on Refresh and after actions only (never on a timer).
  const q = useQuery({
    queryKey: cs16Keys.controls(server.id),
    queryFn: () => cs16Api.controls(server.id),
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const data = q.data;
  const enabled = server.status === 'running' && !!data?.running;

  // Read once more when the server finishes starting (or stops) while this tab is open.
  const prevStatus = useRef(server.status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = server.status;
    if ((was !== 'running' && server.status === 'running') || (was === 'running' && server.status !== 'running')) void q.refetch();
  }, [server.status, q]);

  const act: Act = async (key, fn, success, opts) => {
    setBusy(key);
    try {
      await fn();
      toast.success(success);
      if (opts?.persisted) void qc.invalidateQueries({ queryKey: qk.server(server.id) });
      await settle();
      void q.refetch();
      void qc.invalidateQueries({ queryKey: cs16Keys.maps(server.id) });
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
  const parts: PartProps = { serverId: server.id, data, enabled, act, busy };
  // Rebuild the settings form when the saved values change (after Apply or a refresh).
  const settingsKey = data.settings.map((s) => `${s.key}=${String(s.value)}`).join('&');

  return (
    <div className="space-y-4">
      {!enabled && <WarnBanner title={t('l4d2.mustBeRunning')}>{t('cs16.mustBeRunningBody')}</WarnBanner>}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          [t('l4d2.currentMap'), enabled ? (data.map ?? '–') : '–'],
          [t('cs16.engine'), data.bots.engine === 'yapb' ? t('cs16.engineYapb') : t('cs16.engineStock')],
        ].map(([k, v]) => (
          <div key={k} className="panel min-w-0 px-3 py-2">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="truncate font-mono text-sm" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <Note>{t('cs16.controlsNote')}</Note>
      <Players {...parts} onRefresh={() => void q.refetch()} refreshing={q.isFetching} />
      <ChangeMap key={data.maps.join(',')} {...parts} />
      <Round {...parts} />
      <Bots {...parts} />
      <MatchSettings
        key={settingsKey}
        serverId={server.id}
        settings={data.settings}
        running={enabled}
        onSaved={() => void q.refetch()}
      />
      <p className="flex items-center gap-2 text-xs text-muted">
        <Swords className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t('cs16.adminsHint')}
      </p>
    </div>
  );
}
