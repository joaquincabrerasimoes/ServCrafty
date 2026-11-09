import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pencil, Plus, Trash2 } from 'lucide-react';
import { serversApi } from '@/api';
import type { Schedule, ScheduleAction } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { formatRelative } from '@/lib/format';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Button, EmptyState, ErrorState, Field, IconButton, Loading, Modal, Toggle } from '@/components/ui';
import { useServerCtx } from './ServerLayout';

const ACTIONS: ScheduleAction[] = ['restart', 'backup', 'command', 'start', 'stop'];
const PRESETS: Array<{ cron: string; key: TKey }> = [
  { cron: '0 4 * * *', key: 'schedules.preset.daily4' },
  { cron: '0 */6 * * *', key: 'schedules.preset.every6h' },
  { cron: '0 * * * *', key: 'schedules.preset.hourly' },
  { cron: '0 5 * * 1', key: 'schedules.preset.weekly' },
];

type Draft = Omit<Schedule, 'id' | 'lastRunAt' | 'serverId'> & { id?: string };
const blank: Draft = { cron: '0 4 * * *', action: 'restart', payload: '', enabled: true };

export default function Schedules() {
  const t = useT();
  const { server } = useServerCtx();
  const qc = useQueryClient();
  const key = ['servers', server.id, 'schedules'];
  const q = useQuery({ queryKey: key, queryFn: () => serversApi.schedules(server.id) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const body = { cron: draft.cron.trim(), action: draft.action, payload: draft.action === 'command' ? draft.payload : null, enabled: draft.enabled };
      if (draft.id) await serversApi.updateSchedule(draft.id, body);
      else await serversApi.createSchedule(server.id, body);
      setDraft(null);
      void refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: Schedule, enabled: boolean) => {
    try {
      await serversApi.updateSchedule(s.id, { enabled });
      void refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  const remove = async (s: Schedule) => {
    if (!(await confirm({ title: t('schedules.deleteTitle'), danger: true, confirmLabel: t('common.delete') }))) return;
    try {
      await serversApi.deleteSchedule(s.id);
      void refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">{t('schedules.intro')}</p>
        <Button variant="primary" onClick={() => setDraft({ ...blank })} icon={<Plus className="h-4 w-4" />}>
          {t('schedules.add')}
        </Button>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.length ? (
        <div className="panel">
          <EmptyState icon={<CalendarClock className="h-10 w-10" />} title={t('schedules.emptyTitle')} body={t('schedules.emptyBody')} />
        </div>
      ) : (
        <div className="panel divide-y divide-line">
          {q.data.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <Toggle checked={s.enabled} onChange={(v) => void toggle(s, v)} ariaLabel={t('common.enabled')} />
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {t(`schedules.action.${s.action}` as TKey)}
                  {s.action === 'command' && s.payload && <span className="ml-2 font-mono text-sm text-muted">/{s.payload}</span>}
                </div>
                <div className="text-xs text-muted">
                  <span className="font-mono">{s.cron}</span>
                  {s.lastRunAt && <span className="ml-3">{t('schedules.lastRun', { when: formatRelative(s.lastRunAt) })}</span>}
                </div>
              </div>
              <div className="flex">
                <IconButton label={t('common.edit')} onClick={() => setDraft({ ...s, payload: s.payload ?? '' })}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton label={t('common.delete')} className="hover:text-danger" onClick={() => void remove(s)}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.id ? t('schedules.edit') : t('schedules.add')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} disabled={!draft?.cron.trim() || (draft.action === 'command' && !draft.payload?.trim())} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-4">
            <Field label={t('schedules.actionLabel')}>
              <select className="input" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value as ScheduleAction })}>
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {t(`schedules.action.${a}` as TKey)}
                  </option>
                ))}
              </select>
            </Field>
            {draft.action === 'command' && (
              <Field label={t('console.command')}>
                <input className="input font-mono" value={draft.payload ?? ''} onChange={(e) => setDraft({ ...draft, payload: e.target.value })} placeholder="say Restarting soon" />
              </Field>
            )}
            <Field label={t('schedules.cron')} hint={t('schedules.cronHint')}>
              <input className="input font-mono" value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} />
            </Field>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button key={p.cron} type="button" className="rounded-[2px] border border-line px-2 py-1 text-xs hover:border-accent" onClick={() => setDraft({ ...draft, cron: p.cron })}>
                  {t(p.key)}
                </button>
              ))}
            </div>
            <Toggle checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label={t('common.enabled')} />
          </div>
        )}
      </Modal>
    </div>
  );
}
