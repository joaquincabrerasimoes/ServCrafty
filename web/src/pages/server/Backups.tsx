import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Download, History, Plus, Trash2 } from 'lucide-react';
import { serversApi } from '@/api';
import type { Backup } from '@/api/types';
import { useT } from '@/i18n';
import { canManage } from '@/lib/access';
import { formatBytes, formatDate, formatRelative } from '@/lib/format';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, EmptyState, ErrorState, Field, IconButton, Loading, Modal } from '@/components/ui';
import { useServerCtx } from './ServerLayout';

export default function Backups() {
  const t = useT();
  const { server } = useServerCtx();
  const qc = useQueryClient();
  const key = ['servers', server.id, 'backups'];
  const q = useQuery({ queryKey: key, queryFn: () => serversApi.backups(server.id), refetchInterval: 15_000 });
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const manage = canManage(server.access);

  const create = async () => {
    setBusy(true);
    try {
      await serversApi.createBackup(server.id, note.trim() || undefined);
      toast.success(t('backups.started'));
      setOpen(false);
      setNote('');
      void qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (b: Backup) => {
    const ok = await confirm({ title: t('backups.restoreTitle'), body: t('backups.restoreBody', { date: formatDate(b.createdAt) }), danger: true, confirmLabel: t('backups.restore') });
    if (!ok) return;
    try {
      await serversApi.restoreBackup(server.id, b.id);
      toast.success(t('backups.restoring'));
    } catch (e) {
      toast.error(e);
    }
  };

  const remove = async (b: Backup) => {
    if (!(await confirm({ title: t('backups.deleteTitle'), body: formatDate(b.createdAt), danger: true, confirmLabel: t('common.delete') }))) return;
    try {
      await serversApi.deleteBackup(server.id, b.id);
      void qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(e);
    }
  };

  const total = q.data?.reduce((n, b) => n + (b.sizeBytes ?? 0), 0) ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{q.data ? t('backups.summary', { n: q.data.length, size: formatBytes(total) }) : ''}</p>
        <Button variant="primary" onClick={() => setOpen(true)} icon={<Plus className="h-4 w-4" />}>
          {t('backups.create')}
        </Button>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.length ? (
        <div className="panel">
          <EmptyState icon={<Archive className="h-10 w-10" />} title={t('backups.emptyTitle')} body={t('backups.emptyBody')} />
        </div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('backups.date')}</th>
                <th className="hidden sm:table-cell">{t('backups.kind')}</th>
                <th className="hidden md:table-cell">{t('backups.note')}</th>
                <th className="text-right">{t('backups.size')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...q.data]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((b) => (
                  <tr key={b.id}>
                    <td>
                      <div className="font-medium">{formatDate(b.createdAt)}</div>
                      <div className="text-xs text-muted">{formatRelative(b.createdAt)}</div>
                    </td>
                    <td className="hidden sm:table-cell">
                      <Badge tone={b.kind === 'scheduled' ? 'accent' : 'neutral'}>{t(`backups.kind.${b.kind}`)}</Badge>
                    </td>
                    <td className="hidden max-w-xs truncate text-muted md:table-cell">{b.note ?? ''}</td>
                    <td className="text-right tabular-nums">{formatBytes(b.sizeBytes)}</td>
                    <td>
                      <div className="flex justify-end">
                        <a href={serversApi.backupDownloadUrl(server.id, b.id)} className="inline-flex h-8 w-8 items-center justify-center rounded-block text-muted hover:bg-raised hover:text-ink" title={t('common.download')} aria-label={t('common.download')}>
                          <Download className="h-4 w-4" />
                        </a>
                        {manage && (
                          <>
                            <IconButton label={t('backups.restore')} onClick={() => void restore(b)}>
                              <History className="h-4 w-4" />
                            </IconButton>
                            <IconButton label={t('common.delete')} className="hover:text-danger" onClick={() => void remove(b)}>
                              <Trash2 className="h-4 w-4" />
                            </IconButton>
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
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('backups.create')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void create()}>
              {t('backups.create')}
            </Button>
          </>
        }
      >
        <Field label={t('backups.note')} hint={t('wizard.optional')}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
      </Modal>
    </div>
  );
}
