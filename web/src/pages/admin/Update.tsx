import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  AlertTriangle,
  ArrowUpCircle,
  BadgeCheck,
  CheckCircle2,
  Circle,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Terminal,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { ApiError, healthApi, updateApi, type UpdateInfo, type UpdateState } from '@/api';
import { useT, type TKey } from '@/i18n';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, ErrorState, Loading, PageHeader, Section } from '@/components/ui';
import { Markdown, safeHref } from '@/components/Markdown';
import { LogView } from '@/components/LogView';
import type { LogLine } from '@/ws/live';
import { formatDate, formatRelative } from '@/lib/format';
import { fmtVersion, reloadToNewVersion, updateQk } from '@/lib/updates';

const POLL_MS = 2000;
const STEPS = ['verify', 'backup', 'checkout', 'install', 'build', 'restart', 'health'] as const;
const RELOAD_GUARD_KEY = 'servcrafty.update.reloadedFor';

const stepKey = (s: string): TKey | null => ((STEPS as readonly string[]).includes(s) || s === 'rollback' ? (`update.step.${s}` as TKey) : null);
const isTerminal = (s: UpdateState) => s === 'succeeded' || s === 'failed' || s === 'rolled_back';
const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 10) : '–');

function readGuard(): string | null {
  try {
    return sessionStorage.getItem(RELOAD_GUARD_KEY);
  } catch {
    return null;
  }
}
function writeGuard(v: string) {
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, v);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ live run tracking */

/**
 * Polls status + log every 2 s while an update/rollback runs. API failures are expected while
 * the panel restarts and only flip `apiDown`. Once the run ends and the panel reports a
 * different version than this page was loaded with (and /api/health agrees), the page reloads.
 */
function useUpdateRun() {
  const qc = useQueryClient();
  const [watching, setWatching] = useState(false);
  const [reloading, setReloading] = useState(false);
  const loadedVersion = useRef<string | null>(null);
  const sawRunning = useRef(false);
  const baselineStartedAt = useRef<string | null | undefined>(undefined);

  const q = useQuery({
    queryKey: updateQk.info,
    queryFn: ({ signal }) => updateApi.get(signal),
    refetchInterval: (query) => (watching || query.state.data?.status.state === 'running' ? POLL_MS : false),
    refetchIntervalInBackground: true,
    retry: watching ? false : undefined,
    refetchOnWindowFocus: false,
  });
  const info = q.data;
  const state = info?.status.state;
  const active = watching || state === 'running';
  const apiDown = active && !!q.error && (!(q.error instanceof ApiError) || q.error.status === 0 || q.error.status >= 500 || q.error.status === 404);

  if (info && loadedVersion.current === null) loadedVersion.current = info.currentVersion;

  // A run that was already in progress when the page opened is tracked too.
  useEffect(() => {
    if (state === 'running') {
      sawRunning.current = true;
      setWatching(true);
    }
  }, [state]);

  // Detect the end of the run.
  useEffect(() => {
    if (!watching || !info || !isTerminal(info.status.state)) return;
    const fresh = sawRunning.current || (baselineStartedAt.current !== undefined && info.status.startedAt !== baselineStartedAt.current);
    if (!fresh) return;
    const newVersion = info.currentVersion;
    if (loadedVersion.current && newVersion !== loadedVersion.current && readGuard() !== newVersion) {
      setReloading(true);
      return;
    }
    setWatching(false);
    sawRunning.current = false;
    baselineStartedAt.current = undefined;
    void qc.invalidateQueries({ queryKey: updateQk.health });
  }, [watching, info, qc]);

  // Wait until the new version reports healthy, then reload once.
  useEffect(() => {
    if (!reloading || !info) return;
    const target = info.currentVersion;
    let stop = false;
    const tick = async () => {
      try {
        const h = await healthApi.get();
        if (!stop && h.ok && h.version === target) {
          stop = true;
          writeGuard(target);
          await reloadToNewVersion();
        }
      } catch {
        /* not up yet */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [reloading, info]);

  const begin = useCallback(
    (payload: UpdateInfo | undefined) => {
      baselineStartedAt.current = q.data?.status.startedAt ?? null;
      sawRunning.current = payload?.status.state === 'running';
      if (payload) qc.setQueryData(updateQk.info, payload);
      setWatching(true);
    },
    [q.data, qc],
  );

  return { q, info, active, apiDown, reloading, begin };
}

/** Incrementally tails /admin/update/log while `active`; loads the existing tail once on mount. */
function useUpdateLog(active: boolean) {
  const [text, setText] = useState('');
  const offset = useRef(0);
  const busy = useRef(false);

  const fetchChunk = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const from = offset.current;
      const r = await updateApi.log(from);
      if (typeof r.offset !== 'number') return;
      if (r.offset < from) {
        // Log was truncated / replaced: start over.
        offset.current = 0;
        setText('');
        return;
      }
      offset.current = r.offset;
      if (r.text) setText((prev) => (from === 0 ? r.text : prev + r.text));
    } catch {
      /* API down during restart – try again next tick */
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void fetchChunk();
  }, [fetchChunk]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => void fetchChunk(), POLL_MS);
    return () => clearInterval(id);
  }, [active, fetchChunk]);

  /** New run: keep reading from the current end, but only show what comes next. */
  const startFresh = useCallback(() => setText(''), []);

  const lines = useMemo<LogLine[]>(
    () =>
      text
        .replace(/\n$/, '')
        .split('\n')
        .filter((l, i, a) => l !== '' || i < a.length - 1)
        .map((l, i) => ({ id: i, text: l, kind: /\b(error|failed|fatal)\b/i.test(l) ? 'error' : 'line' })),
    [text],
  );
  return { lines: text ? lines : [], startFresh };
}

/* ------------------------------------------------------------------ pieces */

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function VerifiedBadge({ verified }: { verified: boolean }) {
  const t = useT();
  return verified ? (
    <span title={t('update.verifiedHint')}>
      <Badge tone="ok">
        <BadgeCheck className="h-3 w-3" />
        {t('update.verified')}
      </Badge>
    </span>
  ) : (
    <span title={t('update.unverifiedHint')}>
      <Badge tone="warn">
        <ShieldAlert className="h-3 w-3" />
        {t('update.unverified')}
      </Badge>
    </span>
  );
}

function Callout({ tone, icon, title, children }: { tone: 'ok' | 'warn' | 'danger' | 'neutral'; icon: ReactNode; title: ReactNode; children?: ReactNode }) {
  const tones = {
    ok: 'border-ok/35 bg-ok/5 [&>div>svg]:text-ok',
    warn: 'border-warn/35 bg-warn/5 [&>div>svg]:text-warn',
    danger: 'border-danger/35 bg-danger/5 [&>div>svg]:text-danger',
    neutral: 'border-line bg-raised/50 [&>div>svg]:text-muted',
  };
  return (
    <div className={clsx('rounded-md border p-4 text-sm', tones[tone])}>
      <div className="flex items-start gap-2.5">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="font-medium">{title}</div>
          {children && <div className="mt-1 text-muted">{children}</div>}
        </div>
      </div>
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const t = useT();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success(t('common.copied'));
    } catch {
      toast.error(t('update.copyFailed'));
    }
  };
  return (
    <div className="flex items-stretch overflow-hidden rounded-block border border-line">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-words bg-raised px-3 py-2.5 font-mono text-[13px]">{command}</code>
      <button
        type="button"
        onClick={() => void copy()}
        className="flex shrink-0 items-center gap-1.5 border-l border-line bg-surface px-3 text-sm text-muted hover:bg-raised hover:text-ink"
        aria-label={t('update.copyCommand')}
        title={t('update.copyCommand')}
      >
        <Copy className="h-4 w-4" />
        <span className="hidden sm:inline">{t('common.copy')}</span>
      </button>
    </div>
  );
}

function Steps({ step }: { step: string | null }) {
  const t = useT();
  const current = step ? STEPS.indexOf(step as (typeof STEPS)[number]) : -1;
  const label = step ? stepKey(step) : null;
  if (step && current < 0) {
    // Unknown step (e.g. rollback): just name it.
    return (
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-accent" />
        {label ? t(label) : step}
      </div>
    );
  }
  return (
    <ol className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
      {STEPS.map((s, i) => {
        const done = current > i;
        const now = current === i;
        return (
          <li key={s} className={clsx('flex items-center gap-2 text-sm', done ? 'text-ink' : now ? 'font-medium text-ink' : 'text-muted')}>
            {done ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" />
            ) : now ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
            ) : (
              <Circle className="h-4 w-4 shrink-0" />
            )}
            {t(`update.step.${s}`)}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ page */

export default function Update() {
  const t = useT();
  const qc = useQueryClient();
  const { q, info, active, apiDown, reloading, begin } = useUpdateRun();
  const log = useUpdateLog(active);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);

  const checkNow = async () => {
    setChecking(true);
    try {
      const r = await updateApi.check();
      qc.setQueryData(updateQk.info, r);
      if (r.checkError) toast.error(t('update.checkError', { error: r.checkError }));
      else toast.success(r.updateAvailable && r.latest ? t('update.available', { version: fmtVersion(r.latest.version) }) : t('update.upToDate'));
    } catch (e) {
      toast.error(e);
    } finally {
      setChecking(false);
    }
  };

  const handleStartError = async (e: unknown) => {
    if (e instanceof ApiError && e.code === 'update_in_progress') {
      toast.info(t('update.inProgress'));
      begin(undefined);
      return;
    }
    toast.error(e);
    await q.refetch();
  };

  const apply = async () => {
    if (!info?.latest) return;
    const version = fmtVersion(info.latest.version);
    const n = info.runningServers;
    const ok = await confirm({
      title: t('update.confirmTitle', { version }),
      body: (
        <div className="space-y-3">
          <p>{t('update.confirmBody', { version })}</p>
          {n > 0 && (
            <p className="flex items-start gap-2 rounded-block border border-warn/35 bg-warn/5 p-3 text-ink">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              <span>{n === 1 ? t('update.confirmServersOne') : t('update.confirmServersMany', { count: n })}</span>
            </p>
          )}
          <p>{t('update.confirmBackup')}</p>
          {!info.latest.verified && <p className="text-warn">{t('update.unverifiedHint')}</p>}
        </div>
      ),
      confirmLabel: t('update.confirmAction'),
    });
    if (!ok) return;
    setStarting(true);
    try {
      const r = await updateApi.apply({ version: info.latest.version });
      log.startFresh();
      begin(r);
      toast.info(t('update.started'));
    } catch (e) {
      await handleStartError(e);
    } finally {
      setStarting(false);
    }
  };

  const rollback = async () => {
    if (!info) return;
    const version = fmtVersion(info.previousVersion);
    const ok = await confirm({
      title: t('update.rollbackConfirmTitle', { version }),
      body: (
        <div className="space-y-3">
          <p>{t('update.rollbackConfirmBody')}</p>
          {info.runningServers > 0 && (
            <p>{info.runningServers === 1 ? t('update.confirmServersOne') : t('update.confirmServersMany', { count: info.runningServers })}</p>
          )}
          <p className="text-warn">{t('update.migrationsNote')}</p>
        </div>
      ),
      confirmLabel: t('update.rollbackButton', { version }),
      danger: true,
    });
    if (!ok) return;
    setStarting(true);
    try {
      const r = await updateApi.rollback();
      log.startFresh();
      begin(r);
      toast.info(t('update.rollbackStarted'));
    } catch (e) {
      await handleStartError(e);
    } finally {
      setStarting(false);
    }
  };

  if (q.isLoading) return <Loading />;
  if (!info) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  const { status, latest } = info;
  const isDocker = info.installType === 'docker';
  const lastRun = !active && status.state !== 'idle' ? status : null;

  return (
    <>
      <PageHeader
        title={t('update.title')}
        subtitle={t('update.subtitle')}
        actions={
          <Button icon={<RefreshCw className="h-4 w-4" />} loading={checking} disabled={active} onClick={() => void checkNow()}>
            {t('update.checkNow')}
          </Button>
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <div className="space-y-4">
          <Section title={t('update.versions')}>
            <div className="mb-4 grid grid-cols-2 gap-3">
              <div className="rounded-block border border-line bg-raised/50 p-3">
                <div className="text-xs text-muted">{t('update.current')}</div>
                <div className="mt-0.5 font-mono text-xl font-semibold">{fmtVersion(info.currentVersion)}</div>
              </div>
              <div className={clsx('rounded-block border p-3', info.updateAvailable ? 'border-accent/40 bg-accent/5' : 'border-line bg-raised/50')}>
                <div className="text-xs text-muted">{t('update.latest')}</div>
                <div className={clsx('mt-0.5 font-mono text-xl font-semibold', info.updateAvailable && 'text-accent')}>{latest ? fmtVersion(latest.version) : '–'}</div>
              </div>
            </div>
            <dl className="divide-y divide-line/60">
              <Row label={t('update.installType')}>{t(`update.installType.${info.installType}`)}</Row>
              <Row label={t('update.commit')}>
                <span className="font-mono text-[13px]" title={info.commit ?? undefined}>
                  {shortSha(info.commit)}
                </span>
              </Row>
              {latest && (
                <Row label={t('update.signature')}>
                  <span className="flex flex-wrap items-center gap-2">
                    <VerifiedBadge verified={latest.verified} />
                    <span className="font-mono text-[13px] text-muted" title={latest.commitSha}>
                      {shortSha(latest.commitSha)}
                    </span>
                  </span>
                </Row>
              )}
              <Row label={t('update.lastCheckedLabel')}>
                {info.checkedAt ? <span title={formatDate(info.checkedAt)}>{formatRelative(info.checkedAt)}</span> : <span className="text-muted">{t('update.neverChecked')}</span>}
              </Row>
            </dl>
            {info.checkError && (
              <div className="mt-3">
                <Callout tone="warn" icon={<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />} title={t('update.checkFailed')}>
                  <span className="break-words">{info.checkError}</span>
                </Callout>
              </div>
            )}
          </Section>

          {info.rollbackAvailable && !active && (
            <Section title={t('update.rollbackTitle')} description={t('update.rollbackBody', { version: fmtVersion(info.previousVersion) })}>
              <p className="mb-3 text-sm text-muted">{t('update.migrationsNote')}</p>
              <Button variant="danger" icon={<RotateCcw className="h-4 w-4" />} disabled={!info.canUpdate || starting} onClick={() => void rollback()}>
                {t('update.rollbackButton', { version: fmtVersion(info.previousVersion) })}
              </Button>
            </Section>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          {active ? (
            <Section
              title={t('update.progressTitle')}
              description={status.fromVersion || status.targetVersion ? t('update.fromTo', { from: fmtVersion(status.fromVersion), to: fmtVersion(status.targetVersion) }) : undefined}
            >
              <div className="space-y-4">
                {reloading ? (
                  <Callout tone="ok" icon={<Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />} title={t('update.reloading')} />
                ) : apiDown ? (
                  <Callout tone="neutral" icon={<WifiOff className="mt-0.5 h-4 w-4 shrink-0" />} title={t('update.reconnecting')}>
                    {t('update.reconnectingBody')}
                  </Callout>
                ) : null}
                <Steps step={status.state === 'running' ? status.step : null} />
                {status.startedAt && <p className="text-xs text-muted">{t('update.startedAt', { when: formatDate(status.startedAt) })}</p>}
                <div>
                  <div className="mb-2 text-sm font-medium">{t('update.log')}</div>
                  <LogView lines={log.lines} className="h-72" />
                </div>
              </div>
            </Section>
          ) : (
            <>
              {lastRun && (
                <Callout
                  tone={lastRun.state === 'succeeded' ? 'ok' : lastRun.state === 'rolled_back' ? 'warn' : 'danger'}
                  icon={
                    lastRun.state === 'succeeded' ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    ) : lastRun.state === 'rolled_back' ? (
                      <RotateCcw className="mt-0.5 h-4 w-4 shrink-0" />
                    ) : (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    )
                  }
                  title={
                    <>
                      {t(`update.result.${lastRun.state as 'succeeded' | 'failed' | 'rolled_back'}`)}
                      {(lastRun.fromVersion || lastRun.targetVersion) && (
                        <span className="ml-2 font-mono text-[13px] font-normal text-muted">
                          {t('update.fromTo', { from: fmtVersion(lastRun.fromVersion), to: fmtVersion(lastRun.targetVersion) })}
                        </span>
                      )}
                    </>
                  }
                >
                  {lastRun.message && <p className="whitespace-pre-wrap break-words text-ink">{lastRun.message}</p>}
                  {lastRun.finishedAt && <p className="mt-1 text-xs">{t('update.finished', { when: formatDate(lastRun.finishedAt) })}</p>}
                  {lastRun.state === 'rolled_back' && <p className="mt-1 text-xs">{t('update.migrationsNote')}</p>}
                </Callout>
              )}

              {info.updateAvailable && latest ? (
                <Section
                  title={t('update.available', { version: fmtVersion(latest.version) })}
                  description={latest.publishedAt ? t('update.published', { when: formatDate(latest.publishedAt) }) : undefined}
                  actions={<VerifiedBadge verified={latest.verified} />}
                >
                  {isDocker ? (
                    <div className="space-y-3">
                      <p className="text-sm text-muted">{t('update.dockerBody')}</p>
                      {info.dockerCommand && <CopyCommand command={info.dockerCommand} />}
                    </div>
                  ) : info.canUpdate ? (
                    <div className="space-y-3">
                      <p className="text-sm text-muted">{t('update.applyBody')}</p>
                      {info.runningServers > 0 && (
                        <p className="flex items-start gap-2 text-sm">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                          {info.runningServers === 1 ? t('update.confirmServersOne') : t('update.confirmServersMany', { count: info.runningServers })}
                        </p>
                      )}
                      <Button variant="primary" icon={<ArrowUpCircle className="h-4 w-4" />} loading={starting} onClick={() => void apply()}>
                        {t('update.updateTo', { version: fmtVersion(latest.version) })}
                      </Button>
                    </div>
                  ) : null}
                  {!info.canUpdate && !isDocker && (
                    <Callout tone="warn" icon={<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />} title={t('update.cannotUpdate')}>
                      {info.cannotUpdateReason ?? t('update.cannotUpdateUnknown')}
                    </Callout>
                  )}
                </Section>
              ) : !latest && info.checkError ? null : (
                <Callout
                  tone={latest ? 'ok' : 'neutral'}
                  icon={latest ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0" />}
                  title={latest ? t('update.upToDate') : t('update.noRelease')}
                >
                  {t('update.upToDateBody', { version: fmtVersion(info.currentVersion) })}
                </Callout>
              )}

              {isDocker && !info.updateAvailable && info.dockerCommand && (
                <Section title={t('update.dockerTitle')} description={t('update.dockerIdleBody')}>
                  <CopyCommand command={info.dockerCommand} />
                </Section>
              )}

              {!info.canUpdate && (isDocker || !info.updateAvailable) && info.cannotUpdateReason && (
                <Callout tone="neutral" icon={<Terminal className="mt-0.5 h-4 w-4 shrink-0" />} title={t('update.cannotUpdate')}>
                  {info.cannotUpdateReason}
                </Callout>
              )}
            </>
          )}

          {latest && (
            <Section
              title={t('update.releaseNotes')}
              description={latest.name && latest.name !== latest.tag ? latest.name : fmtVersion(latest.version)}
              actions={
                latest.url && safeHref(latest.url) ? (
                  <a href={safeHref(latest.url)!} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
                    {t('update.viewOnGithub')}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : undefined
              }
            >
              {latest.notes?.trim() ? <Markdown source={latest.notes} /> : <p className="text-sm text-muted">{t('update.noNotes')}</p>}
            </Section>
          )}

          {!active && log.lines.length > 0 && (
            <details className="panel group">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium sm:px-5">{t('update.lastLog')}</summary>
              <div className="border-t border-line p-4 sm:p-5">
                <LogView lines={log.lines} className="h-64" />
              </div>
            </details>
          )}
        </div>
      </div>
    </>
  );
}
