import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, ArrowRight, Check, Rocket } from 'lucide-react';
import { catalogApi, serversApi } from '@/api';
import type { CatalogProject, CatalogVersion, CreateServerBody, ServerType } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { toast } from '@/stores/toast';
import { formatDate, formatMb } from '@/lib/format';
import { qk } from '@/lib/queries';
import { Button, ErrorState, Field, PageHeader, Spinner, Toggle } from '@/components/ui';
import { CatalogSearch, ProjectIcon } from '@/components/CatalogSearch';

const GROUPS: Array<{ id: string; types: ServerType[] }> = [
  { id: 'vanilla', types: ['VANILLA'] },
  { id: 'plugins', types: ['PAPER', 'PURPUR', 'FOLIA'] },
  { id: 'mods', types: ['FABRIC', 'QUILT', 'FORGE', 'NEOFORGE'] },
  { id: 'modpacks', types: ['MODRINTH', 'CURSEFORGE'] },
  { id: 'bedrock', types: ['BEDROCK'] },
];

const isModpack = (t: ServerType) => t === 'CURSEFORGE' || t === 'MODRINTH';
const hasLoader = (t: ServerType) => ['FABRIC', 'QUILT', 'FORGE', 'NEOFORGE'].includes(t);

const STEPS = ['wizard.stepType', 'wizard.stepVersion', 'wizard.stepResources', 'wizard.stepReview'] as const;

function Stepper({ step }: { step: number }) {
  const t = useT();
  return (
    <ol className="mb-8 grid grid-cols-4 gap-2">
      {STEPS.map((k, i) => (
        <li key={k} className="min-w-0">
          <div className={clsx('h-1.5 rounded-[1px]', i <= step ? 'bg-accent' : 'bg-line')} />
          <div className={clsx('mt-2 flex items-center gap-1.5 text-xs sm:text-sm', i === step ? 'font-medium text-ink' : 'text-muted')}>
            <span className="tabular-nums">{i + 1}.</span>
            <span className="truncate">{t(k)}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function VersionPicker({ type, value, onChange }: { type: ServerType; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['mc-versions', type],
    queryFn: () => catalogApi.minecraftVersions(type),
    staleTime: 10 * 60_000,
  });
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  return (
    <Field label={t('server.mcVersion')}>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="LATEST">{t('wizard.latest')}</option>
        {data?.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ModpackVersions({ project, value, onChange }: { project: CatalogProject; value: CatalogVersion | null; onChange: (v: CatalogVersion) => void }) {
  const t = useT();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['catalog-versions', project.source, project.id],
    queryFn: () => catalogApi.versions(project.source, project.id),
    staleTime: 5 * 60_000,
  });
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data?.length) return <p className="text-sm text-muted">{t('wizard.noVersions')}</p>;
  return (
    <Field label={t('wizard.packVersion')}>
      <select
        className="input"
        value={value?.id ?? ''}
        onChange={(e) => {
          const v = data.find((x) => x.id === e.target.value);
          if (v) onChange(v);
        }}
      >
        <option value="" disabled>
          {t('wizard.chooseVersion')}
        </option>
        {data.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
            {v.mcVersions?.length ? ` · MC ${v.mcVersions.filter((x) => /^\d/.test(x)).slice(0, 2).join(', ')}` : ''}
            {v.date ? ` · ${formatDate(v.date)}` : ''}
          </option>
        ))}
      </select>
    </Field>
  );
}

export default function CreateServer() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [type, setType] = useState<ServerType>('PAPER');
  const [mcVersion, setMcVersion] = useState('LATEST');
  const [loaderVersion, setLoaderVersion] = useState('');
  const [pack, setPack] = useState<CatalogProject | null>(null);
  const [packVersion, setPackVersion] = useState<CatalogVersion | null>(null);
  const [name, setName] = useState('');
  const [memoryMb, setMemoryMb] = useState(4096);
  const [cpu, setCpu] = useState(2);
  const [diskMb, setDiskMb] = useState<number | ''>('');
  const [port, setPort] = useState<number | ''>('');
  const [autoRestart, setAutoRestart] = useState(true);
  const [eula, setEula] = useState(false);
  const [busy, setBusy] = useState(false);

  const modpack = isModpack(type);
  const packMc = packVersion?.mcVersions?.find((v) => /^\d/.test(v));

  const canNext = useMemo(() => {
    if (step === 1) return modpack ? !!pack && !!packVersion : !!mcVersion;
    if (step === 2) return name.trim().length > 0 && memoryMb >= 512 && cpu > 0;
    if (step === 3) return eula;
    return true;
  }, [step, modpack, pack, packVersion, mcVersion, name, memoryMb, cpu, eula]);

  const pickType = (tp: ServerType) => {
    setType(tp);
    setPack(null);
    setPackVersion(null);
    if (isModpack(tp) && memoryMb < 6144) setMemoryMb(6144);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const body: CreateServerBody = {
        name: name.trim(),
        type,
        mcVersion: modpack ? packMc ?? 'LATEST' : mcVersion,
        memoryMb,
        cpu,
        autoRestart,
        eula: true,
      };
      if (hasLoader(type) && loaderVersion.trim()) body.loaderVersion = loaderVersion.trim();
      if (diskMb) body.diskMb = diskMb;
      if (port) body.port = port;
      if (modpack && pack && packVersion) {
        const source = type === 'CURSEFORGE' ? 'curseforge' : 'modrinth';
        body.modpack =
          source === 'curseforge'
            ? { source, projectId: pack.id, fileId: packVersion.id, name: pack.name }
            : { source, projectId: pack.id, versionId: packVersion.id, name: pack.name };
      }
      const server = await serversApi.create(body);
      await qc.invalidateQueries({ queryKey: qk.servers });
      void qc.invalidateQueries({ queryKey: qk.quota });
      toast.success(t('wizard.created', { name: body.name }));
      navigate(server?.id ? `/servers/${server.id}` : '/');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t('wizard.title')} subtitle={t('wizard.subtitle')} />
      <Stepper step={step} />

      {step === 0 && (
        <div className="space-y-6">
          {GROUPS.map((g) => (
            <div key={g.id}>
              <h2 className="mb-1 text-base font-semibold">{t(`wizard.group.${g.id}` as TKey)}</h2>
              <p className="mb-3 text-sm text-muted">{t(`wizard.groupHint.${g.id}` as TKey)}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {g.types.map((tp) => (
                  <button
                    key={tp}
                    type="button"
                    onClick={() => pickType(tp)}
                    aria-pressed={type === tp}
                    className={clsx(
                      'relative rounded-block border px-3 py-3 text-left text-sm',
                      type === tp ? 'border-accent bg-accent/10 font-medium' : 'border-line bg-surface hover:border-muted',
                    )}
                  >
                    {t(`type.${tp}`)}
                    {type === tp && <Check className="absolute right-2 top-2 h-4 w-4 text-accent" />}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {step === 1 && (
        <div className="space-y-5">
          {modpack ? (
            <>
              {pack && (
                <div className="flex items-center gap-3 rounded-md border border-accent/40 bg-accent/5 p-3">
                  <ProjectIcon project={pack} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{pack.name}</div>
                    {pack.summary && <p className="line-clamp-2 text-sm text-muted">{pack.summary}</p>}
                  </div>
                </div>
              )}
              {pack && <ModpackVersions project={pack} value={packVersion} onChange={setPackVersion} />}
              <CatalogSearch
                key={type}
                kind="modpack"
                initialSource={type === 'CURSEFORGE' ? 'curseforge' : 'modrinth'}
                selectedId={pack?.id}
                onSelect={(p) => {
                  setPack(p);
                  setPackVersion(null);
                  if (p.source !== (type === 'CURSEFORGE' ? 'curseforge' : 'modrinth')) setType(p.source === 'curseforge' ? 'CURSEFORGE' : 'MODRINTH');
                  if (!name) setName(p.name);
                }}
              />
            </>
          ) : (
            <>
              <VersionPicker type={type} value={mcVersion} onChange={setMcVersion} />
              {hasLoader(type) && (
                <Field label={t('server.loaderVersion')} hint={t('wizard.loaderHint')}>
                  <input className="input" value={loaderVersion} onChange={(e) => setLoaderVersion(e.target.value)} placeholder={t('wizard.latest')} />
                </Field>
              )}
            </>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-5">
          <Field label={t('server.name')}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus placeholder={t('wizard.namePlaceholder')} />
          </Field>
          <Field label={`${t('server.memory')}: ${formatMb(memoryMb)}`} hint={t('wizard.memoryHint')}>
            <input type="range" min={1024} max={32768} step={512} value={memoryMb} onChange={(e) => setMemoryMb(Number(e.target.value))} className="w-full accent-[rgb(var(--accent))]" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('server.cpu')}>
              <input className="input" type="number" min={0.5} step={0.5} value={cpu} onChange={(e) => setCpu(Number(e.target.value))} />
            </Field>
            <Field label={t('server.disk')} hint={t('wizard.optional')}>
              <input className="input" type="number" min={1024} step={1024} value={diskMb} onChange={(e) => setDiskMb(e.target.value ? Number(e.target.value) : '')} placeholder="MB" />
            </Field>
            <Field label={t('server.port')} hint={t('wizard.portHint')}>
              <input className="input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value ? Number(e.target.value) : '')} placeholder={t('wizard.auto')} />
            </Field>
          </div>
          <Toggle checked={autoRestart} onChange={setAutoRestart} label={t('server.autoRestart')} />
        </div>
      )}

      {step === 3 && (
        <div className="space-y-5">
          <dl className="panel divide-y divide-line text-sm">
            {[
              [t('server.name'), name],
              [t('server.type'), t(`type.${type}`)],
              [t('server.mcVersion'), modpack ? packMc ?? t('wizard.latest') : mcVersion === 'LATEST' ? t('wizard.latest') : mcVersion],
              ...(modpack && pack ? [[t('wizard.modpack'), `${pack.name} · ${packVersion?.name ?? ''}`]] : []),
              ...(hasLoader(type) ? [[t('server.loaderVersion'), loaderVersion || t('wizard.latest')]] : []),
              [t('server.memory'), formatMb(memoryMb)],
              [t('server.cpu'), String(cpu)],
              [t('server.disk'), diskMb ? formatMb(diskMb) : t('wizard.unlimited')],
              [t('server.port'), port ? String(port) : t('wizard.auto')],
              [t('server.autoRestart'), autoRestart ? t('common.yes') : t('common.no')],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
                <dt className="text-muted">{k}</dt>
                <dd className="text-right font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          <label className="flex items-start gap-3 rounded-md border border-line bg-surface p-4 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]" checked={eula} onChange={(e) => setEula(e.target.checked)} />
            <span>
              {t('wizard.eula')}{' '}
              <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer" className="text-accent underline">
                aka.ms/MinecraftEULA
              </a>
            </span>
          </label>
        </div>
      )}

      <div className="mt-8 flex justify-between gap-2 border-t border-line pt-5">
        <Button variant="ghost" onClick={() => (step === 0 ? navigate(-1) : setStep(step - 1))} icon={<ArrowLeft className="h-4 w-4" />}>
          {step === 0 ? t('common.cancel') : t('common.back')}
        </Button>
        {step < 3 ? (
          <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            {t('common.next')}
            <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button variant="primary" disabled={!canNext} loading={busy} onClick={() => void submit()} icon={<Rocket className="h-4 w-4" />}>
            {t('wizard.create')}
          </Button>
        )}
      </div>
    </div>
  );
}
