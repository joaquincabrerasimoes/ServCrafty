import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutTemplate, Rocket, Trash2 } from 'lucide-react';
import { templatesApi } from '@/api';
import type { Template } from '@/api/types';
import { useT } from '@/i18n';
import { useAuth } from '@/stores/auth';
import { formatMb } from '@/lib/format';
import { qk } from '@/lib/queries';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, EmptyState, ErrorState, Field, IconButton, Loading, Modal, PageHeader } from '@/components/ui';

export default function Templates() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const q = useQuery({ queryKey: qk.templates, queryFn: templatesApi.list });
  const [using, setUsing] = useState<Template | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const instantiate = async () => {
    if (!using) return;
    setBusy(true);
    try {
      const s = await templatesApi.instantiate(using.id, { name: name.trim(), eula: true });
      await qc.invalidateQueries({ queryKey: qk.servers });
      toast.success(t('wizard.created', { name: name.trim() }));
      setUsing(null);
      if (s?.id) navigate(`/servers/${s.id}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tp: Template) => {
    if (!(await confirm({ title: t('templates.deleteTitle', { name: tp.name }), danger: true, confirmLabel: t('common.delete') }))) return;
    try {
      await templatesApi.remove(tp.id);
      void qc.invalidateQueries({ queryKey: qk.templates });
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      <PageHeader title={t('templates.title')} subtitle={t('templates.subtitle')} />
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.length ? (
        <div className="panel">
          <EmptyState icon={<LayoutTemplate className="h-10 w-10" />} title={t('templates.emptyTitle')} body={t('templates.emptyBody')} />
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {q.data.map((tp) => {
            const c = tp.config ?? {};
            const mine = tp.ownerId === user?.id || user?.role === 'admin';
            return (
              <article key={tp.id} className="panel flex flex-col p-4">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-lg font-semibold">{tp.name}</h2>
                  {tp.shared && <Badge tone="accent">{t('templates.shared')}</Badge>}
                </div>
                {tp.description && <p className="mt-1 text-sm text-muted">{tp.description}</p>}
                <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  {c.type && <dd>{t(`type.${c.type}`)} {c.mcVersion ?? ''}</dd>}
                  {c.memoryMb && <dd>{formatMb(Number(c.memoryMb))}</dd>}
                  {c.modpack?.name && <dd>{c.modpack.name}</dd>}
                </dl>
                <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      setName(tp.name);
                      setUsing(tp);
                    }}
                    icon={<Rocket className="h-4 w-4" />}
                  >
                    {t('templates.use')}
                  </Button>
                  {mine && (
                    <IconButton label={t('common.delete')} className="hover:text-danger" onClick={() => void remove(tp)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <Modal
        open={!!using}
        onClose={() => setUsing(null)}
        title={t('templates.useTitle', { name: using?.name ?? '' })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setUsing(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void instantiate()}>
              {t('wizard.create')}
            </Button>
          </>
        }
      >
        <Field label={t('server.name')} hint={t('templates.eulaNote')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}
