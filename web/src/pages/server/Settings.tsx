import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Save, Trash2, X } from 'lucide-react';
import { serversApi } from '@/api';
import { useT } from '@/i18n';
import { isFull } from '@/lib/access';
import { serverCaps } from '@/lib/games';
import { qk } from '@/lib/queries';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Button, Field, IconButton, Section, Toggle } from '@/components/ui';
import { LanAnnounceField } from '../create/LanAnnounceField';
import { TerrariaConfigFields } from '../create/TerrariaConfigStep';
import { toTerrariaPatch, trFromConfig, validateTr, type TrForm } from '../create/terrariaForm';
import { TerrariaWorlds, useTerrariaWorlds } from './TerrariaWorlds';
import { useServerCtx } from './ServerLayout';

export default function ServerSettings() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { server } = useServerCtx();
  const [form, setForm] = useState({
    name: server.name,
    mcVersion: server.mcVersion,
    loaderVersion: server.loaderVersion ?? '',
    memoryMb: server.memoryMb,
    cpu: server.cpu,
    diskMb: server.diskMb ?? '',
    port: server.port,
    javaArgs: server.javaArgs ?? '',
    autoRestart: server.autoRestart ?? false,
    lanAnnounce: server.lanAnnounce ?? false,
  });
  const [env, setEnv] = useState<Array<[string, string]>>(Object.entries(server.env ?? {}));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm({ ...form, [k]: v });
  const caps = serverCaps(server);
  const [tr, setTr] = useState<TrForm>(() => trFromConfig(server.terraria));
  const setTrField = <K extends keyof TrForm>(k: K, v: TrForm[K]) => setTr((f) => ({ ...f, [k]: v }));
  const worlds = useTerrariaWorlds(server.id, caps.hasTerrariaConfig);
  // World creation values only matter until the world file exists.
  const worldLocked = !!worlds.data?.length || !!server.terraria?.worldFile;
  const trErrors = useMemo(() => {
    if (!caps.hasTerrariaConfig) return {};
    const e = validateTr(tr, server.type, t);
    if (worldLocked) {
      delete e.worldName;
      delete e.seed;
    }
    return e;
  }, [caps.hasTerrariaConfig, tr, server.type, t, worldLocked]);
  const memoryInvalid = !Number.isFinite(form.memoryMb) || form.memoryMb < caps.minMemoryMb;
  const invalid = Object.keys(trErrors).length > 0 || (caps.hasTerrariaConfig && memoryInvalid);

  const save = async () => {
    if (invalid) return;
    setSaving(true);
    try {
      await serversApi.update(server.id, {
        name: form.name.trim(),
        ...(caps.hasJava
          ? {
              mcVersion: form.mcVersion.trim(),
              loaderVersion: form.loaderVersion.trim() || null,
            }
          : {}),
        memoryMb: Number(form.memoryMb),
        cpu: Number(form.cpu),
        diskMb: form.diskMb === '' ? null : Number(form.diskMb),
        port: Number(form.port),
        ...(caps.hasJava ? { javaArgs: form.javaArgs.trim() || null } : {}),
        autoRestart: form.autoRestart,
        ...(caps.hasJava && server.type !== 'BEDROCK' ? { lanAnnounce: form.lanAnnounce } : {}),
        ...(caps.hasTerrariaConfig ? { terraria: toTerrariaPatch(tr, server.type, worldLocked) } : {}),
        env: Object.fromEntries(env.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])),
      });
      await qc.invalidateQueries({ queryKey: qk.server(server.id) });
      void qc.invalidateQueries({ queryKey: qk.servers });
      toast.success(server.status === 'running' ? t('settings.savedRestart') : t('settings.saved'));
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: t('settings.deleteTitle'),
      body: t('settings.deleteBody'),
      danger: true,
      typeToConfirm: server.name,
      confirmLabel: t('settings.deleteAction'),
    });
    if (!ok) return;
    try {
      await serversApi.remove(server.id);
      await qc.invalidateQueries({ queryKey: qk.servers });
      toast.success(t('settings.deleted'));
      navigate('/');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="max-w-3xl space-y-4">
      <Section title={t('settings.general')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('server.name')} className="sm:col-span-2">
            <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          {caps.hasJava && (
            <>
              <Field label={t('server.mcVersion')} hint={t('settings.versionHint')}>
                <input className="input font-mono" value={form.mcVersion} onChange={(e) => set('mcVersion', e.target.value)} />
              </Field>
              <Field label={t('server.loaderVersion')}>
                <input className="input font-mono" value={form.loaderVersion} onChange={(e) => set('loaderVersion', e.target.value)} />
              </Field>
            </>
          )}
          <Field
            label={t('server.memory') + ' (MB)'}
            error={caps.hasTerrariaConfig && memoryInvalid ? t('settings.memoryMin', { min: caps.minMemoryMb }) : null}
          >
            <input
              className="input"
              type="number"
              min={512}
              step={256}
              value={form.memoryMb}
              aria-invalid={caps.hasTerrariaConfig && memoryInvalid}
              onChange={(e) => set('memoryMb', Number(e.target.value))}
            />
          </Field>
          <Field label={t('server.cpu')}>
            <input className="input" type="number" min={0.5} step={0.5} value={form.cpu} onChange={(e) => set('cpu', Number(e.target.value))} />
          </Field>
          <Field label={t('server.disk') + ' (MB)'} hint={t('wizard.optional')}>
            <input className="input" type="number" min={0} step={1024} value={form.diskMb} onChange={(e) => set('diskMb', e.target.value === '' ? '' : Number(e.target.value))} />
          </Field>
          <Field label={t('server.port')}>
            <input className="input" type="number" min={1} max={65535} value={form.port} onChange={(e) => set('port', Number(e.target.value))} />
          </Field>
          {caps.hasJava && (
            <Field label={t('server.javaArgs')} className="sm:col-span-2" hint={t('settings.javaArgsHint')}>
              <input className="input font-mono text-[13px]" value={form.javaArgs} onChange={(e) => set('javaArgs', e.target.value)} placeholder="-XX:+UseG1GC" />
            </Field>
          )}
          <div className="sm:col-span-2">
            <Toggle checked={form.autoRestart} onChange={(v) => set('autoRestart', v)} label={t('server.autoRestart')} />
          </div>
          {caps.hasJava && (
            <div className="sm:col-span-2">
              <LanAnnounceField checked={form.lanAnnounce} onChange={(v) => set('lanAnnounce', v)} bedrock={server.type === 'BEDROCK'} />
            </div>
          )}
        </div>
      </Section>

      {caps.hasTerrariaConfig && (
        <section aria-labelledby="tr-settings" className="space-y-3">
          <div>
            <h2 id="tr-settings" className="text-base font-semibold">
              {t('tr.settingsTitle')}
            </h2>
            <p className="mt-0.5 text-sm text-muted">{t('tr.settingsBody')}</p>
          </div>
          <TerrariaConfigFields
            form={tr}
            set={setTrField}
            errors={trErrors}
            type={server.type}
            worldLocked={worldLocked}
            worldLockedHint={t('tr.worldExists')}
          />
          <TerrariaWorlds server={server} worlds={worlds} />
        </section>
      )}

      <Section title={t('settings.env')} description={caps.hasTerrariaConfig ? t('settings.envBodyTr') : t('settings.envBody')}>
        <div className="space-y-2">
          {env.map(([k, v], i) => (
            <div key={i} className="flex gap-2">
              <input className="input w-2/5 font-mono text-[13px]" placeholder="KEY" value={k} onChange={(e) => setEnv(env.map((row, j) => (j === i ? [e.target.value.toUpperCase(), row[1]] : row)))} />
              <input className="input flex-1 font-mono text-[13px]" placeholder="value" value={v} onChange={(e) => setEnv(env.map((row, j) => (j === i ? [row[0], e.target.value] : row)))} />
              <IconButton label={t('common.remove')} className="h-10 w-10" onClick={() => setEnv(env.filter((_, j) => j !== i))}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setEnv([...env, ['', '']])} icon={<Plus className="h-4 w-4" />}>
            {t('settings.addVar')}
          </Button>
        </div>
      </Section>

      <div className="flex justify-end">
        <Button variant="primary" loading={saving} disabled={invalid} onClick={() => void save()} icon={<Save className="h-4 w-4" />}>
          {t('common.saveChanges')}
        </Button>
      </div>

      {isFull(server.access) && (
        <section className="rounded-md border border-danger/40 p-4 sm:p-5">
          <h2 className="text-base font-semibold text-danger">{t('settings.danger')}</h2>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-lg text-sm text-muted">{t('settings.deleteBody')}</p>
            <Button variant="danger" onClick={() => void remove()} icon={<Trash2 className="h-4 w-4" />}>
              {t('settings.deleteAction')}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
