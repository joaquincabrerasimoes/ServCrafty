import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { serversApi } from '@/api';
import type { Webhook } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, EmptyState, ErrorState, Field, IconButton, Loading, Modal, Toggle } from '@/components/ui';
import { useServerCtx } from './ServerLayout';

export const WEBHOOK_EVENTS = [
  'server.started',
  'server.stopped',
  'server.crashed',
  'player.joined',
  'player.left',
  'backup.completed',
  'backup.failed',
] as const;

type Draft = Omit<Webhook, 'id' | 'serverId'> & { id?: string };
const blank: Draft = { url: '', kind: 'discord', events: ['server.started', 'server.stopped', 'server.crashed'], enabled: true };

export default function Webhooks() {
  const t = useT();
  const { server } = useServerCtx();
  const qc = useQueryClient();
  const key = ['servers', server.id, 'webhooks'];
  const q = useQuery({ queryKey: key, queryFn: () => serversApi.webhooks(server.id) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const body = { url: draft.url.trim(), kind: draft.kind, events: draft.events, enabled: draft.enabled };
      if (draft.id) await serversApi.updateWebhook(draft.id, body);
      else await serversApi.createWebhook(server.id, body);
      setDraft(null);
      void refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const test = async (w: Webhook) => {
    try {
      await serversApi.testWebhook(w.id);
      toast.success(t('webhooks.testSent'));
    } catch (e) {
      toast.error(e);
    }
  };

  const remove = async (w: Webhook) => {
    if (!(await confirm({ title: t('webhooks.deleteTitle'), body: w.url, danger: true, confirmLabel: t('common.delete') }))) return;
    try {
      await serversApi.deleteWebhook(w.id);
      void refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">{t('webhooks.intro')}</p>
        <Button variant="primary" onClick={() => setDraft({ ...blank })} icon={<Plus className="h-4 w-4" />}>
          {t('webhooks.add')}
        </Button>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.length ? (
        <div className="panel">
          <EmptyState icon={<WebhookIcon className="h-10 w-10" />} title={t('webhooks.emptyTitle')} body={t('webhooks.emptyBody')} />
        </div>
      ) : (
        <div className="panel divide-y divide-line">
          {q.data.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge tone={w.kind === 'discord' ? 'accent' : 'neutral'}>{w.kind === 'discord' ? 'Discord' : t('webhooks.generic')}</Badge>
                  {!w.enabled && <Badge>{t('common.disabled')}</Badge>}
                </div>
                <div className="mt-1 truncate font-mono text-xs text-muted">{w.url}</div>
                <div className="mt-1 text-xs text-muted">{w.events.map((e) => t(`webhooks.event.${e}` as TKey)).join(', ')}</div>
              </div>
              <div className="flex">
                <IconButton label={t('webhooks.test')} onClick={() => void test(w)}>
                  <Send className="h-4 w-4" />
                </IconButton>
                <IconButton label={t('common.edit')} onClick={() => setDraft({ ...w })}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton label={t('common.delete')} className="hover:text-danger" onClick={() => void remove(w)}>
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
        title={draft?.id ? t('webhooks.edit') : t('webhooks.add')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} disabled={!/^https?:\/\//.test(draft?.url ?? '') || !draft?.events.length} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-4">
            <Field label={t('webhooks.kind')}>
              <select className="input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Webhook['kind'] })}>
                <option value="discord">Discord</option>
                <option value="generic">{t('webhooks.generic')}</option>
              </select>
            </Field>
            <Field label="URL" hint={draft.kind === 'discord' ? t('webhooks.discordHint') : t('webhooks.genericHint')}>
              <input className="input font-mono text-[13px]" type="url" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://" />
            </Field>
            <fieldset>
              <legend className="label">{t('webhooks.events')}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {WEBHOOK_EVENTS.map((ev) => (
                  <label key={ev} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[rgb(var(--accent))]"
                      checked={draft.events.includes(ev)}
                      onChange={(e) => setDraft({ ...draft, events: e.target.checked ? [...draft.events, ev] : draft.events.filter((x) => x !== ev) })}
                    />
                    {t(`webhooks.event.${ev}` as TKey)}
                  </label>
                ))}
              </div>
            </fieldset>
            <Toggle checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label={t('common.enabled')} />
          </div>
        )}
      </Modal>
    </div>
  );
}
