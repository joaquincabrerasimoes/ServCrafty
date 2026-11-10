import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, ArrowRight, Check, Download, Gamepad2, Pickaxe, RefreshCw, Rocket, Trees } from 'lucide-react';
import { accountApi, catalogApi, serversApi } from '@/api';
import type { CatalogProject, CatalogVersion, CreateServerBody, Game, GameSummary, ServerType } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { quotaRows } from '@/lib/quota';
import { toast } from '@/stores/toast';
import { formatDate, formatMb } from '@/lib/format';
import { qk } from '@/lib/queries';
import { GAMES, TERRARIA_TYPES, capsOf } from '@/lib/games';
import { protocolLabel, publishedPorts, useGameDefs } from '@/lib/gameDefs';
import { GameIcon } from '@/components/GameBits';
import { Badge, Button, ErrorState, Field, Meter, PageHeader, Spinner, Toggle } from '@/components/ui';
import { errorMessage } from '@/api/client';
import { CatalogSearch, ProjectIcon } from '@/components/CatalogSearch';
import { Combobox, type ComboOption } from '@/components/Combobox';
import { MEMORY_API_MAX_MB, MemoryField } from './create/MemoryField';
import { MinecraftConfigStep } from './create/MinecraftConfigStep';
import { mcDefaults, summarizeMc, toMinecraftConfig, validateMc, type Edition, type McForm } from './create/minecraftForm';
import { TerrariaConfigFields, WorldFilePicker } from './create/TerrariaConfigStep';
import { summarizeTr, toTerrariaConfig, trDefaults, validateTr, validateWorldFiles, type TrForm } from './create/terrariaForm';
import { cleanVariables, steamDefaults, summarizeSteam, toSteamVars, validateSteam, type SteamForm } from './create/steamForm';
import { SteamVariablesForm } from './create/SteamVariablesForm';
import { Note } from './create/TerrariaConfigStep';

const GROUPS: Array<{ id: string; types: ServerType[] }> = [
  { id: 'vanilla', types: ['VANILLA'] },
  { id: 'plugins', types: ['PAPER', 'PURPUR', 'FOLIA', 'SPIGOT', 'BUKKIT'] },
  { id: 'mods', types: ['FABRIC', 'QUILT', 'FORGE', 'NEOFORGE'] },
  { id: 'modpacks', types: ['MODRINTH', 'CURSEFORGE'] },
  { id: 'bedrock', types: ['BEDROCK'] },
];

const isModpack = (t: ServerType) => t === 'CURSEFORGE' || t === 'MODRINTH';
const hasLoader = (t: ServerType) => ['FABRIC', 'QUILT', 'FORGE', 'NEOFORGE'].includes(t);

type StepId = 'game' | 'type' | 'version' | 'resources' | 'minecraft' | 'terraria' | 'steam' | 'review';
const STEPS_BY_GAME: Record<Game, StepId[]> = {
  minecraft: ['game', 'type', 'version', 'resources', 'minecraft', 'review'],
  terraria: ['game', 'type', 'resources', 'terraria', 'review'],
  steam: ['game', 'resources', 'steam', 'review'],
};
const STEP_LABEL: Record<StepId, TKey> = {
  game: 'wizard.stepGame',
  type: 'wizard.stepType',
  version: 'wizard.stepVersion',
  resources: 'wizard.stepResources',
  minecraft: 'wizard.stepMinecraft',
  terraria: 'wizard.stepWorld',
  steam: 'wizard.stepSettings',
  review: 'wizard.stepReview',
};
const GAME_ICON: Record<Game, typeof Pickaxe> = { minecraft: Pickaxe, terraria: Trees, steam: Gamepad2 };
const DEFAULT_TYPE: Record<Game, ServerType> = { minecraft: 'PAPER', terraria: 'TERRARIA', steam: 'STEAMCMD' };

/** One card of the Game step. */
function GameCard({ on, onClick, icon, title, body, extra }: { on: boolean; onClick: () => void; icon: React.ReactNode; title: string; body?: string; extra?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={clsx(
        'relative flex min-w-0 flex-col items-start gap-3 rounded-md border p-5 text-left',
        on ? 'border-accent bg-accent/10' : 'border-line bg-surface hover:border-muted',
      )}
    >
      {icon}
      <span className="pe-6 text-lg font-semibold">{title}</span>
      {body && <span className="line-clamp-3 text-sm text-muted">{body}</span>}
      {extra && <span className="text-xs text-muted">{extra}</span>}
      {on && <Check className="absolute right-3 top-3 h-5 w-5 text-accent" aria-hidden="true" />}
    </button>
  );
}

function Stepper({ steps, step }: { steps: StepId[]; step: number }) {
  const t = useT();
  return (
    <nav aria-label={t('wizard.progress')} className="mb-8">
      <ol className="grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((k, i) => (
          <li key={k} className="min-w-0" aria-current={i === step ? 'step' : undefined}>
            <div className={clsx('h-1.5 rounded-[1px]', i <= step ? 'bg-accent' : 'bg-line')} />
            <div className={clsx('mt-2 flex items-center gap-1.5 text-xs sm:text-sm', i === step ? 'font-medium text-ink' : 'text-muted')}>
              <span className="tabular-nums">{i + 1}.</span>
              {/* Narrow screens: only the numbers, plus the current step's name below. */}
              <span className="hidden truncate sm:inline">{t(STEP_LABEL[k])}</span>
              <span className="sr-only sm:hidden">{t(STEP_LABEL[k])}</span>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-sm font-medium sm:hidden" aria-hidden="true">
        {t('wizard.stepOf', { n: step + 1, total: steps.length })} · {t(STEP_LABEL[steps[step]!])}
      </p>
    </nav>
  );
}

function VersionPicker({ type, value, onChange }: { type: ServerType; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['mc-versions', type],
    queryFn: () => catalogApi.minecraftVersions(type),
    staleTime: 10 * 60_000,
  });
  // A version kept from another server type may not exist for this one; the <select> would show
  // "Latest" while the old version is still what gets sent, so fall back to Latest for real.
  useEffect(() => {
    if (data && value !== 'LATEST' && !data.includes(value)) onChange('LATEST');
  }, [data, value, onChange]);
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

function LoaderPicker({ type, mcVersion, value, onChange }: { type: ServerType; mcVersion: string; value: string; onChange: (v: string) => void }) {
  const t = useT();
  // "Latest" Minecraft means the newest entry of the same cached list the version picker shows.
  const mcList = useQuery({ queryKey: ['mc-versions', type], queryFn: () => catalogApi.minecraftVersions(type), staleTime: 10 * 60_000 });
  const resolvedMc = mcVersion === 'LATEST' ? mcList.data?.[0] : mcVersion;
  const { data, isFetching, error } = useQuery({
    queryKey: ['loader-versions', type, resolvedMc],
    queryFn: () => catalogApi.loaderVersions(type, resolvedMc as string),
    enabled: !!resolvedMc,
    staleTime: 10 * 60_000,
  });
  const options = useMemo<ComboOption[]>(() => {
    const list = data ?? [];
    return list.map((v, i) => ({
      value: v,
      // Forge lists [recommended, latest] (one entry when there is no recommended build or both are the same);
      // every other loader is newest-first.
      badge:
        type === 'FORGE' && list.length === 2
          ? i === 0
            ? t('wizard.badgeRecommended')
            : t('wizard.badgeNewest')
          : i === 0
            ? t('wizard.badgeNewest')
            : undefined,
    }));
  }, [data, type, t]);
  return (
    <Field label={t('server.loaderVersion')} hint={!error && data && !data.length && !isFetching ? t('wizard.loaderNone') : t('wizard.loaderHint')}>
      <Combobox options={options} value={value} onChange={onChange} emptyLabel={t('wizard.latest')} ariaLabel={t('server.loaderVersion')} loading={isFetching || mcList.isFetching} allowCustom />
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
  const [game, setGame] = useState<Game>('minecraft');
  const [type, setType] = useState<ServerType>('PAPER');
  const [mcVersion, setMcVersion] = useState('LATEST');
  const [loaderVersion, setLoaderVersion] = useState('');
  // A loader build only fits one Minecraft version of one loader: forget it when either changes.
  useEffect(() => setLoaderVersion(''), [type, mcVersion]);
  const [pack, setPack] = useState<CatalogProject | null>(null);
  const [packVersion, setPackVersion] = useState<CatalogVersion | null>(null);
  const [name, setName] = useState('');
  const [memoryMb, setMemoryMb] = useState(4096);
  const [cpu, setCpu] = useState(2);
  const [diskMb, setDiskMb] = useState<number | ''>('');
  const [port, setPort] = useState<number | ''>('');
  const [autoRestart, setAutoRestart] = useState(true);
  const [lanAnnounce, setLanAnnounce] = useState(false);
  const [eula, setEula] = useState(false);
  const [busy, setBusy] = useState(false);
  const edition: Edition = type === 'BEDROCK' ? 'bedrock' : 'java';
  const [mc, setMc] = useState<McForm>(mcDefaults);
  const setMcField = <K extends keyof McForm>(k: K, v: McForm[K]) => setMc((f) => ({ ...f, [k]: v }));
  // Terraria
  const [tr, setTr] = useState<TrForm>(trDefaults);
  const setTrField = <K extends keyof TrForm>(k: K, v: TrForm[K]) => setTr((f) => ({ ...f, [k]: v }));
  const [worldFiles, setWorldFiles] = useState<File[]>([]);
  // Once the server exists a failed world upload is retried against it instead of creating another one.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<unknown>(null);
  // SteamCMD games (one card per game definition)
  const defs = useGameDefs();
  const [steamDef, setSteamDef] = useState<GameSummary | null>(null);
  const steamVars = useMemo(() => cleanVariables(steamDef?.variables), [steamDef]);
  const [steamVals, setSteamVals] = useState<SteamForm>({});
  const [updateOnStart, setUpdateOnStart] = useState(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const steps = STEPS_BY_GAME[game];
  const current = steps[step] ?? 'game';
  const caps = capsOf(type, game);
  const terraria = game === 'terraria';
  const steam = game === 'steam';
  const minMemoryMb = steam ? Math.max(512, steamDef?.resources?.memoryMinMb ?? 512) : caps.minMemoryMb;
  const steamErrors = useMemo(() => (steam ? validateSteam(steamVars, steamVals, t) : {}), [steam, steamVars, steamVals, t]);

  const quota = useQuery({ queryKey: qk.quota, queryFn: accountApi.quota, staleTime: 30_000 });
  // Each row already folds in the host-wide cap, so "free" is what this user can really still take.
  const rows = quota.data ? quotaRows(quota.data) : null;
  const ramRow = rows?.find((r) => r.key === 'ram');
  const cpuRow = rows?.find((r) => r.key === 'cpu');
  const serversRow = rows?.find((r) => r.key === 'servers');
  const freeOf = (r?: { max: number | null; used: number }) => (r && r.max !== null ? Math.max(0, r.max - r.used) : null);
  const freeRamMb = freeOf(ramRow);
  const freeCpu = freeOf(cpuRow);
  const ramQuotaError =
    freeRamMb !== null && memoryMb > freeRamMb ? t(ramRow?.hostBound ? 'wizard.hostRam' : 'wizard.quotaRam', { free: formatMb(freeRamMb) }) : null;
  const cpuQuotaError =
    freeCpu !== null && cpu > freeCpu ? t(cpuRow?.hostBound ? 'wizard.hostCpu' : 'wizard.quotaCpu', { free: Math.round(freeCpu * 10) / 10 }) : null;
  const serversQuotaFull = !!serversRow && serversRow.max !== null && serversRow.used >= serversRow.max;

  const modpack = isModpack(type);
  const packMc = packVersion?.mcVersions?.find((v) => /^\d/.test(v));
  const mcErrors = useMemo(() => validateMc(mc, edition, t), [mc, edition, t]);
  const mcConfig = useMemo(() => toMinecraftConfig(mc, edition), [mc, edition]);
  const cpuValid = Number.isFinite(cpu) && cpu >= 0.1 && cpu <= 256;
  const importing = terraria && worldFiles.length > 0;
  const trErrors = useMemo(() => {
    const e = validateTr(tr, type, t);
    // An imported world brings its own name, size, difficulty and seed.
    if (worldFiles.length) {
      delete e.worldName;
      delete e.seed;
    }
    return e;
  }, [tr, type, t, worldFiles.length]);
  const worldFileError = useMemo(() => validateWorldFiles(worldFiles, type, t), [worldFiles, type, t]);
  const trConfig = useMemo(() => toTerrariaConfig(tr, type), [tr, type]);

  const canNext = useMemo(() => {
    if (current === 'version') return modpack ? !!pack && !!packVersion : !!mcVersion;
    if (current === 'resources')
      return name.trim().length > 0 && memoryMb >= minMemoryMb && memoryMb <= MEMORY_API_MAX_MB && cpuValid && !ramQuotaError && !cpuQuotaError;
    if (current === 'minecraft') return Object.keys(mcErrors).length === 0;
    if (current === 'steam') return Object.keys(steamErrors).length === 0;
    if (current === 'terraria') return Object.keys(trErrors).length === 0 && !worldFileError;
    if (current === 'review') return caps.needsEula ? eula : !worldFileError;
    return true;
  }, [current, modpack, pack, packVersion, mcVersion, name, memoryMb, minMemoryMb, caps, cpuValid, ramQuotaError, cpuQuotaError, mcErrors, steamErrors, trErrors, worldFileError, eula]);

  // Move focus to the step heading so keyboard and screen reader users land on the new step.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
    document.querySelector('main')?.scrollTo?.({ top: 0 });
  }, [step]);

  const pickSteamGame = (d: GameSummary) => {
    if (steam && steamDef?.id === d.id) return;
    setGame('steam');
    setType('STEAMCMD');
    setSteamDef(d);
    setSteamVals(steamDefaults(cleanVariables(d.variables)));
    setUpdateOnStart(true);
    setPack(null);
    setPackVersion(null);
    setWorldFiles([]);
    const min = Math.max(512, d.resources?.memoryMinMb ?? 512);
    setMemoryMb(Math.max(min, d.resources?.memoryMb ?? capsOf('STEAMCMD', 'steam').defaultMemoryMb));
    setCpu(d.resources?.cpu ?? 2);
    setDiskMb(d.resources?.diskMb ? d.resources.diskMb : '');
    setPort('');
  };

  const pickGame = (g: Game) => {
    if (g === game) return;
    setSteamDef(null);
    setGame(g);
    setType(DEFAULT_TYPE[g]);
    setPack(null);
    setPackVersion(null);
    setWorldFiles([]);
    setMemoryMb(capsOf(DEFAULT_TYPE[g], g).defaultMemoryMb);
  };

  const pickType = (tp: ServerType) => {
    if ((tp === 'BEDROCK') !== (type === 'BEDROCK')) setMc(mcDefaults()); // option sets differ per edition
    if (tp === 'BEDROCK') setLanAnnounce(false);
    setType(tp);
    setPack(null);
    setPackVersion(null);
    if (isModpack(tp) && memoryMb < 6144) setMemoryMb(6144);
    // Only tModLoader worlds come with a .twld companion.
    if (tp !== 'TMODLOADER') setWorldFiles((fs) => fs.filter((f) => !/\.twld$/i.test(f.name)));
  };

  const finish = (id: string | null) => navigate(id ? `/servers/${id}` : '/');

  const uploadWorld = async (id: string) => {
    setUploadError(null);
    setUploadProgress(0);
    try {
      await serversApi.uploadTerrariaWorld(id, worldFiles, false, setUploadProgress);
      void qc.invalidateQueries({ queryKey: qk.server(id) });
      toast.success(t('tr.importDone'));
      return true;
    } catch (e) {
      setUploadError(e);
      toast.error(e);
      return false;
    } finally {
      setUploadProgress(null);
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      let id = createdId;
      if (!id) {
        const body: CreateServerBody = {
          name: name.trim(),
          type,
          mcVersion: terraria || steam ? 'LATEST' : modpack ? packMc ?? 'LATEST' : mcVersion,
          memoryMb,
          cpu,
          autoRestart,
          eula: true,
        };
        if (steam && steamDef) {
          body.steam = { gameId: steamDef.id, vars: toSteamVars(steamVars, steamVals), updateOnStart };
        } else if (terraria) {
          body.terraria = trConfig;
        } else {
          if (mcConfig) body.minecraft = mcConfig;
          if (lanAnnounce && edition === 'java') body.lanAnnounce = true;
          if (hasLoader(type) && loaderVersion.trim()) body.loaderVersion = loaderVersion.trim();
          if (modpack && pack && packVersion) {
            const source = type === 'CURSEFORGE' ? 'curseforge' : 'modrinth';
            body.modpack =
              source === 'curseforge'
                ? { source, projectId: pack.id, fileId: packVersion.id, name: pack.name }
                : { source, projectId: pack.id, versionId: packVersion.id, name: pack.name };
          }
        }
        if (diskMb) body.diskMb = diskMb;
        if (port && !steam) body.port = port;
        const server = await serversApi.create(body);
        id = server?.id ?? null;
        await qc.invalidateQueries({ queryKey: qk.servers });
        void qc.invalidateQueries({ queryKey: qk.quota });
        toast.success(t('wizard.created', { name: body.name }));
        if (importing && id) setCreatedId(id);
      }
      if (importing && id && !(await uploadWorld(id))) return;
      finish(id);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const reviewRows: string[][] = [
    [t('wizard.stepGame'), steam ? steamDef?.name ?? '' : t(`game.${game}`)],
    [t('server.name'), name],
    ...(steam ? [] : [[t('server.type'), t(`type.${type}`)]]),
    ...(caps.hasMcVersion
      ? [[t('server.mcVersion'), modpack ? packMc ?? t('wizard.latest') : mcVersion === 'LATEST' ? t('wizard.latest') : mcVersion]]
      : []),
    ...(modpack && pack ? [[t('wizard.modpack'), `${pack.name} · ${packVersion?.name ?? ''}`]] : []),
    ...(hasLoader(type) ? [[t('server.loaderVersion'), loaderVersion || t('wizard.latest')]] : []),
    [t('server.memory'), formatMb(memoryMb)],
    [t('server.cpu'), String(cpu)],
    [t('server.disk'), diskMb ? formatMb(diskMb) : t('wizard.unlimited')],
    ...(steam ? [] : [[t('server.port'), port ? String(port) : t('wizard.auto')]]),
    [t('server.autoRestart'), autoRestart ? t('common.yes') : t('common.no')],
    ...(steam ? [[t('steam.updateOnStart'), updateOnStart ? t('common.yes') : t('common.no')]] : []),
    ...(caps.hasLan ? [[t('lan.label'), lanAnnounce ? t('common.yes') : t('common.no')]] : []),
  ];
  const configStep: StepId = steam ? 'steam' : terraria ? 'terraria' : 'minecraft';
  const configRows = steam
    ? steamVars.length
      ? summarizeSteam(steamVars, steamVals, t)
      : null
    : terraria
      ? summarizeTr(trConfig, t, importing ? worldFiles.map((f) => f.name).join(', ') : null)
      : mcConfig
        ? summarizeMc(mcConfig, edition, t)
        : null;
  const steamPorts = steam ? publishedPorts(steamDef ?? undefined) : [];
  const locked = createdId !== null; // the server exists; only the world upload is left

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t('wizard.title')} subtitle={t('wizard.subtitle')} />
      <Stepper steps={steps} step={step} />
      <h2 ref={headingRef} tabIndex={-1} className="sr-only">
        {t(STEP_LABEL[current])}
      </h2>
      {serversQuotaFull && !locked && (
        <p role="alert" className="mb-5 rounded-md border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {t(serversRow?.hostBound ? 'wizard.hostServers' : 'wizard.quotaServers')}
        </p>
      )}

      {current === 'game' && (
        <div className="space-y-4">
          <div role="group" aria-label={t('wizard.stepGame')} className="grid gap-3 sm:grid-cols-2">
            {GAMES.map((g) => {
              const Icon = GAME_ICON[g];
              const on = game === g;
              return (
                <GameCard
                  key={g}
                  on={on}
                  onClick={() => pickGame(g)}
                  icon={
                    <span className={clsx('flex h-11 w-11 items-center justify-center rounded-block', on ? 'bg-accent text-accent-ink' : 'bg-raised text-muted')}>
                      <Icon className="h-6 w-6" aria-hidden="true" />
                    </span>
                  }
                  title={t(`game.${g}`)}
                  body={t(`wizard.gameHint.${g as 'minecraft' | 'terraria'}`)}
                />
              );
            })}
            {defs.data?.map((d) => {
              const on = steam && steamDef?.id === d.id;
              const r = d.resources;
              return (
                <GameCard
                  key={d.id}
                  on={on}
                  onClick={() => pickSteamGame(d)}
                  icon={<GameIcon src={d.icon} active={on} />}
                  title={d.name}
                  body={d.description}
                  extra={r?.memoryMb || r?.memoryMinMb ? t('wizard.steamResources', { ram: formatMb(r.memoryMb ?? r.memoryMinMb), cpu: r.cpu ?? 2 }) : undefined}
                />
              );
            })}
          </div>
          {defs.isLoading && (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Spinner className="h-4 w-4" />
              {t('wizard.loadingGames')}
            </p>
          )}
          {defs.error && <ErrorState error={defs.error} onRetry={() => void defs.refetch()} />}
          {!defs.isLoading && !defs.error && !defs.data?.length && <p className="text-sm text-muted">{t('wizard.moreGames')}</p>}
        </div>
      )}

      {current === 'type' && !terraria && (
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

      {current === 'type' && terraria && (
        <div role="group" aria-label={t('wizard.stepType')} className="grid gap-2 sm:grid-cols-3">
          {TERRARIA_TYPES.map((tp) => (
            <button
              key={tp}
              type="button"
              onClick={() => pickType(tp)}
              aria-pressed={type === tp}
              className={clsx(
                'relative flex flex-col gap-1 rounded-block border px-3 py-3 text-left text-sm',
                type === tp ? 'border-accent bg-accent/10' : 'border-line bg-surface hover:border-muted',
              )}
            >
              <span className="pe-5 font-medium">{t(`type.${tp}`)}</span>
              <span className="text-muted">{t(`wizard.trType.${tp}`)}</span>
              {type === tp && <Check className="absolute right-2 top-2 h-4 w-4 text-accent" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}

      {current === 'version' && (
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
                <LoaderPicker type={type} mcVersion={mcVersion} value={loaderVersion} onChange={setLoaderVersion} />
              )}
            </>
          )}
        </div>
      )}

      {current === 'resources' && (
        <div className="space-y-5">
          <Field label={t('server.name')}>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              autoFocus
              placeholder={steam ? steamDef?.name : t(terraria ? 'wizard.namePlaceholderTr' : 'wizard.namePlaceholder')}
            />
          </Field>
          <MemoryField
            valueMb={memoryMb}
            onChange={setMemoryMb}
            minMb={minMemoryMb}
            hint={
              steam
                ? t('wizard.memoryHintSteam', { min: formatMb(minMemoryMb), rec: formatMb(steamDef?.resources?.memoryMb ?? minMemoryMb) })
                : terraria
                  ? t('wizard.memoryHintTr')
                  : undefined
            }
            maxMb={Math.max(minMemoryMb, Math.min(MEMORY_API_MAX_MB, freeRamMb ?? MEMORY_API_MAX_MB))}
            quotaError={ramQuotaError}
          />
          <div className={clsx('grid gap-4', steam ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}>
            <Field label={t('server.cpu')} error={cpuQuotaError ?? (cpuValid ? null : t('wizard.cpuInvalid'))}>
              <input
                className="input"
                type="number"
                min={0.5}
                max={256}
                step={0.5}
                value={Number.isNaN(cpu) ? '' : cpu}
                aria-invalid={!cpuValid || !!cpuQuotaError}
                onChange={(e) => setCpu(e.target.value === '' ? Number.NaN : Number(e.target.value))}
              />
            </Field>
            <Field label={t('server.disk')} hint={t('wizard.optional')}>
              <input className="input" type="number" min={1024} step={1024} value={diskMb} onChange={(e) => setDiskMb(e.target.value ? Number(e.target.value) : '')} placeholder="MB" />
            </Field>
            {!steam && (
              <Field label={t('server.port')} hint={t('wizard.portHint')}>
                <input className="input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value ? Number(e.target.value) : '')} placeholder={t('wizard.auto')} />
              </Field>
            )}
          </div>
          {steam && <Note>{t('wizard.steamPortsAuto', { n: steamPorts.length })}</Note>}
          <Toggle checked={autoRestart} onChange={setAutoRestart} label={t('server.autoRestart')} />
        </div>
      )}

      {current === 'minecraft' && <MinecraftConfigStep form={mc} set={setMcField} errors={mcErrors} edition={edition} modpack={modpack} lanAnnounce={lanAnnounce} onLanAnnounce={setLanAnnounce} />}

      {current === 'steam' && (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('steam.intro')}</p>
          <SteamVariablesForm
            variables={steamVars}
            values={steamVals}
            onChange={(k, v) => setSteamVals((f) => ({ ...f, [k]: v }))}
            errors={steamErrors}
            footer={
              <div>
                <Toggle checked={updateOnStart} onChange={setUpdateOnStart} label={t('steam.updateOnStart')} />
                <p className="hint">{t('steam.updateOnStartHint')}</p>
              </div>
            }
          />
        </div>
      )}

      {current === 'terraria' && (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('tr.intro')}</p>
          <TerrariaConfigFields
            form={tr}
            set={setTrField}
            errors={trErrors}
            type={type}
            worldLocked={importing}
            worldLockedHint={t('tr.importLocksWorld')}
            worldSlot={<WorldFilePicker files={worldFiles} onChange={setWorldFiles} type={type} error={worldFileError} />}
          />
        </div>
      )}

      {current === 'review' && (
        <div className="space-y-5">
          <dl className="panel divide-y divide-line text-sm">
            {reviewRows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
                <dt className="text-muted">{k}</dt>
                <dd className="min-w-0 break-words text-end font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          <section aria-labelledby="review-config" className="panel text-sm">
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
              <h3 id="review-config" className="text-base font-semibold">
                {t(STEP_LABEL[configStep])}
              </h3>
              {!locked && (
                <Button size="sm" variant="ghost" onClick={() => setStep(steps.indexOf(configStep))}>
                  {t('common.edit')}
                </Button>
              )}
            </div>
            {configRows ? (
              <dl className="divide-y divide-line">
                {configRows.map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
                    <dt className="shrink-0 text-muted">{k}</dt>
                    <dd className="min-w-0 break-words text-end font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="px-4 py-3 text-muted">{t('mc.allDefaults')}</p>
            )}
          </section>
          {steam && (
            <section aria-labelledby="review-ports" className="panel text-sm">
              <h3 id="review-ports" className="border-b border-line px-4 py-2 text-base font-semibold">
                {t('steam.portsTitle')}
              </h3>
              {steamPorts.length ? (
                <ul className="divide-y divide-line">
                  {steamPorts.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                      <span className="min-w-0">
                        <span className="font-medium">{p.label || p.id}</span>
                        {p.main && <Badge tone="accent" className="ms-2">{t('steam.mainPort')}</Badge>}
                      </span>
                      <span className="text-muted">
                        {protocolLabel(p.protocol)} · {t('steam.hostPortAuto')}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-3 text-muted">{t('steam.noPorts')}</p>
              )}
              <p className="border-t border-line px-4 py-2.5 text-xs text-muted">{t('steam.portsReviewHint')}</p>
            </section>
          )}
          {steam && (
            <p className="flex gap-2 rounded-md border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
              <Download className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
              <span>{t('steam.firstStartNote')}</span>
            </p>
          )}
          {caps.needsEula && (
            <label className="flex items-start gap-3 rounded-md border border-line bg-surface p-4 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]" checked={eula} onChange={(e) => setEula(e.target.checked)} />
              <span>
                {t('wizard.eula')}{' '}
                <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer" className="text-accent underline">
                  aka.ms/MinecraftEULA
                </a>
              </span>
            </label>
          )}
          {uploadProgress !== null && (
            <div className="panel space-y-2 p-4 text-sm" aria-live="polite">
              <p>{t('tr.uploading', { pct: Math.round(uploadProgress * 100) })}</p>
              <Meter value={Math.round(uploadProgress * 100)} max={100} />
            </div>
          )}
          {locked && uploadProgress === null && !!uploadError && (
            <div role="alert" className="space-y-3 rounded-md border border-danger/30 bg-danger/5 p-4 text-sm">
              <p className="font-medium text-danger">{t('tr.uploadFailed', { error: errorMessage(uploadError) })}</p>
              <p className="text-muted">{t('tr.uploadFailedBody')}</p>
              <WorldFilePicker files={worldFiles} onChange={setWorldFiles} type={type} error={worldFileError} disabled={busy} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => finish(createdId)}>
                  {t('tr.openWithoutWorld')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-8 flex justify-between gap-2 border-t border-line pt-5">
        <Button
          variant="ghost"
          disabled={locked}
          onClick={() => (step === 0 ? navigate(-1) : setStep(step - 1))}
          icon={<ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />}
        >
          {step === 0 ? t('common.cancel') : t('common.back')}
        </Button>
        {current !== 'review' ? (
          <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            {t('common.next')}
            <ArrowRight className="h-4 w-4 rtl:-scale-x-100" />
          </Button>
        ) : locked ? (
          <Button
            variant="primary"
            disabled={!worldFiles.length || !!worldFileError}
            loading={busy}
            onClick={() => void submit()}
            icon={<RefreshCw className="h-4 w-4" />}
          >
            {t('tr.retryUpload')}
          </Button>
        ) : (
          <Button variant="primary" disabled={!canNext || serversQuotaFull} loading={busy} onClick={() => void submit()} icon={<Rocket className="h-4 w-4" />}>
            {t('wizard.create')}
          </Button>
        )}
      </div>
    </div>
  );
}
