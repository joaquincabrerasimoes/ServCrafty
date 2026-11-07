import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Download, LayoutTemplate, Upload } from 'lucide-react';
import { serversApi, type ExportFormat } from '@/api';
import { useT, type TKey } from '@/i18n';
import { toast } from '@/stores/toast';
import { Button, Field, Section, Toggle, buttonClass } from '@/components/ui';
import { ImportDialog } from '@/components/ImportDialog';
import { useServerCtx } from './ServerLayout';

const FORMATS: ExportFormat[] = ['curseforge', 'modrinth', 'serverpack'];

export default function Transfer() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { server } = useServerCtx();
  const [cloneName, setCloneName] = useState(`${server.name} copy`);
  const [cloning, setCloning] = useState(false);
  const [tpl, setTpl] = useState({ name: server.name, description: '', shared: false });
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const clone = async () => {
    setCloning(true);
    try {
      const s = await serversApi.clone(server.id, cloneName.trim());
      await qc.invalidateQueries({ queryKey: ['servers'] });
      toast.success(t('transfer.cloned'));
      if (s?.id) navigate(`/servers/${s.id}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setCloning(false);
    }
  };

  const saveTemplate = async () => {
    setSaving(true);
    try {
      await serversApi.saveTemplate(server.id, { ...tpl, name: tpl.name.trim() });
      void qc.invalidateQueries({ queryKey: ['templates'] });
      toast.success(t('transfer.templateSaved'));
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title={t('transfer.export')} description={t('transfer.exportBody')}>
        <ul className="space-y-2">
          {FORMATS.map((f) => (
            <li key={f} className="flex items-center justify-between gap-3 rounded-block border border-line px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t(`transfer.format.${f}` as TKey)}</div>
                <div className="text-xs text-muted">{t(`transfer.formatHint.${f}` as TKey)}</div>
              </div>
              <a href={serversApi.exportUrl(server.id, f)} className={buttonClass('secondary', 'sm')} download>
                <Download className="h-4 w-4" />
                {t('common.download')}
              </a>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t('import.title')} description={t('import.body')}>
        <Button onClick={() => setImportOpen(true)} icon={<Upload className="h-4 w-4" />}>
          {t('import.title')}
        </Button>
      </Section>

      <Section title={t('transfer.clone')} description={t('transfer.cloneBody')}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className="input" value={cloneName} onChange={(e) => setCloneName(e.target.value)} aria-label={t('server.name')} />
          <Button variant="primary" disabled={!cloneName.trim()} loading={cloning} onClick={() => void clone()} icon={<Copy className="h-4 w-4" />}>
            {t('transfer.cloneAction')}
          </Button>
        </div>
      </Section>

      <Section title={t('transfer.template')} description={t('transfer.templateBody')}>
        <div className="space-y-3">
          <Field label={t('server.name')}>
            <input className="input" value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} />
          </Field>
          <Field label={t('templates.description')}>
            <textarea className="input min-h-[4rem]" value={tpl.description} onChange={(e) => setTpl({ ...tpl, description: e.target.value })} />
          </Field>
          <Toggle checked={tpl.shared} onChange={(v) => setTpl({ ...tpl, shared: v })} label={t('templates.shareWithAll')} />
          <div>
            <Button variant="primary" disabled={!tpl.name.trim()} loading={saving} onClick={() => void saveTemplate()} icon={<LayoutTemplate className="h-4 w-4" />}>
              {t('transfer.templateAction')}
            </Button>
          </div>
        </div>
      </Section>
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
