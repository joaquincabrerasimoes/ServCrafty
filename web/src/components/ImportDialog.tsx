import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { serversApi } from '@/api';
import { useT } from '@/i18n';
import { toast } from '@/stores/toast';
import { Button, Field, Modal } from './ui';

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [memoryMb, setMemoryMb] = useState(4096);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fields: Record<string, string> = { memoryMb: String(memoryMb), eula: 'true' };
      if (name.trim()) fields.name = name.trim();
      const server = await serversApi.import(file, fields);
      await qc.invalidateQueries({ queryKey: ['servers'] });
      toast.success(t('import.done'));
      onClose();
      if (server?.id) navigate(`/servers/${server.id}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('import.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!file} loading={busy} onClick={() => void submit()} icon={<Upload className="h-4 w-4" />}>
            {t('import.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">{t('import.body')}</p>
        <Field label={t('import.file')} hint=".zip, .mrpack">
          <input type="file" accept=".zip,.mrpack" className="input file:mr-3 file:rounded-[2px] file:border-0 file:bg-raised file:px-2 file:py-1 file:text-ink" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label={t('server.name')} hint={t('import.nameHint')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('server.memory')}>
          <input className="input" type="number" min={512} step={256} value={memoryMb} onChange={(e) => setMemoryMb(Number(e.target.value))} />
        </Field>
      </div>
    </Modal>
  );
}
