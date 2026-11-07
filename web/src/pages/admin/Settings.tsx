import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Save } from 'lucide-react';
import { adminApi } from '@/api';
import type { AdminSettings as Settings } from '@/api/types';
import { useT } from '@/i18n';
import { toast } from '@/stores/toast';
import { Badge, Button, ErrorState, Field, Loading, PageHeader, Section } from '@/components/ui';

const POOL_RE = /^\s*\d{1,5}(\s*-\s*\d{1,5})?(\s*,\s*\d{1,5}(\s*-\s*\d{1,5})?)*\s*$/;

export default function AdminSettings() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: adminApi.settings });
  const [form, setForm] = useState<Partial<Settings>>({});
  const [cfKey, setCfKey] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.data) setForm({ portPool: q.data.portPool, defaultJavaArgs: q.data.defaultJavaArgs ?? '', publicUrl: q.data.publicUrl ?? '' });
  }, [q.data]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  const poolOk = POOL_RE.test(form.portPool ?? '');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Partial<Settings> = { ...form };
      if (cfKey.trim()) body.curseforgeKey = cfKey.trim();
      await adminApi.saveSettings(body);
      setCfKey('');
      await qc.invalidateQueries({ queryKey: ['admin-settings'] });
      toast.success(t('admin.settingsSaved'));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('admin.settingsTitle')} />
      <form onSubmit={save} className="max-w-3xl space-y-4">
        <Section title={t('admin.network')}>
          <div className="space-y-4">
            <Field label={t('admin.portPool')} hint={t('admin.portPoolHint')} error={!poolOk ? t('admin.portPoolInvalid') : null}>
              <input className="input font-mono" value={form.portPool ?? ''} onChange={(e) => setForm({ ...form, portPool: e.target.value })} placeholder="25565-25600,25700" />
            </Field>
            <Field label={t('admin.publicUrl')} hint={t('admin.publicUrlHint')}>
              <input className="input font-mono" value={form.publicUrl ?? ''} onChange={(e) => setForm({ ...form, publicUrl: e.target.value })} placeholder="https://craft.example.com" />
            </Field>
          </div>
        </Section>
        <Section title="CurseForge" description={t('admin.cfBody')} actions={q.data?.curseforgeKeySet ? <Badge tone="ok"><Check className="h-3 w-3" />{t('admin.cfSet')}</Badge> : <Badge tone="warn">{t('admin.cfMissing')}</Badge>}>
          <Field label={t('admin.cfKey')} hint={t('admin.cfKeyHint')}>
            <input className="input font-mono" type="password" autoComplete="off" value={cfKey} onChange={(e) => setCfKey(e.target.value)} placeholder={q.data?.curseforgeKeySet ? '••••••••' : ''} />
          </Field>
        </Section>
        <Section title={t('admin.defaults')}>
          <Field label={t('admin.defaultJavaArgs')}>
            <input className="input font-mono text-[13px]" value={form.defaultJavaArgs ?? ''} onChange={(e) => setForm({ ...form, defaultJavaArgs: e.target.value })} />
          </Field>
        </Section>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={busy} disabled={!poolOk} icon={<Save className="h-4 w-4" />}>
            {t('common.saveChanges')}
          </Button>
        </div>
      </form>
    </>
  );
}
