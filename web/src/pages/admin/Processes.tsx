import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Cpu, RefreshCw, ServerOff } from 'lucide-react';
import { adminApi } from '@/api';
import { errorMessage } from '@/api/client';
import type { ProcessInfo, ProcessServer, ProcessesResponse } from '@/api/types';
import { useT, type TFn, type TKey } from '@/i18n';
import { formatMb, formatNumber } from '@/lib/format';
import { gameKeyName } from '@/lib/gameKeys';
import { useGameDefs } from '@/lib/gameDefs';
import { StatusDot } from '@/components/StatusBadge';
import { EmptyState, ErrorState, IconButton, Spinner, Toggle } from '@/components/ui';

/* ------------------------------------------------------------------ polling */

const INTERVALS = [1000, 2000, 5000, 0] as const; // 0 = paused
type IntervalMs = (typeof INTERVALS)[number];

/**
 * Polls GET /admin/processes every `interval` ms (0 = paused). The next request is scheduled only once
 * the previous one has finished, so requests never overlap; polling stops while the tab is hidden.
 * On an error the previous data is kept and `error` is set.
 */
function useProcessPoll(interval: IntervalMs) {
  const [data, setData] = useState<ProcessesResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [fetching, setFetching] = useState(false);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  const [manual, setManual] = useState(0);
  const hasData = useRef(false);
  const lastManual = useRef(0);

  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  useEffect(() => {
    const live = interval > 0 && !hidden;
    const forced = manual !== lastManual.current;
    lastManual.current = manual;
    // Paused (or hidden): only the first load and an explicit refresh fetch.
    if (!live && hasData.current && !forced) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const run = async () => {
      setFetching(true);
      try {
        const r = await adminApi.processes(ctrl.signal);
        if (stopped) return;
        hasData.current = true;
        setData(r);
        setError(null);
        setLastOk(Date.now());
      } catch (e) {
        if (stopped || ctrl.signal.aborted) return;
        setError(e);
      } finally {
        if (!stopped) {
          setFetching(false);
          if (live) timer = setTimeout(() => void run(), interval);
        }
      }
    };
    void run();
    return () => {
      stopped = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
      setFetching(false);
    };
  }, [interval, hidden, manual]);

  const refresh = useCallback(() => setManual((n) => n + 1), []);
  return { data, error, fetching, lastOk, hidden, refresh };
}

/* ------------------------------------------------------------------ formatting */

/** CPU time like htop: M:SS.cc below an hour, H:MM:SS above. */
function fmtCpuTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function fmtElapsed(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(sec % 60)}s`;
}

const pct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '–' : n.toFixed(1));

/** htop-like colours: idle muted, low green, high gold, saturated red. */
function cpuTone(p: number) {
  if (p >= 90) return 'text-danger font-semibold';
  if (p >= 50) return 'text-warn';
  if (p >= 1) return 'text-ok';
  return 'text-muted';
}
function memTone(p: number) {
  if (p >= 50) return 'text-danger font-semibold';
  if (p >= 20) return 'text-warn';
  if (p >= 1) return 'text-ok';
  return 'text-muted';
}
function stateTone(state: string) {
  const c = state.charAt(0);
  if (c === 'R') return 'text-ok';
  if (c === 'D' || c === 'Z') return 'text-danger';
  if (c === 'T' || c === 't') return 'text-warn';
  return 'text-muted';
}

/* ------------------------------------------------------------------ sorting */

type SortKey = 'pid' | 'user' | 'cpu' | 'mem' | 'memPct' | 'state' | 'time' | 'command' | 'server';
type Dir = 'asc' | 'desc';

interface Row extends ProcessInfo {
  serverId: string;
  serverName: string;
}

const NUMERIC: Record<SortKey, boolean> = { pid: true, user: false, cpu: true, mem: true, memPct: true, state: false, time: true, command: false, server: false };

function sortValue(r: Row, k: SortKey): number | string {
  switch (k) {
    case 'pid':
      return r.pid;
    case 'user':
      return r.user;
    case 'cpu':
      return r.cpuPercent;
    case 'mem':
      return r.memMb;
    case 'memPct':
      return r.memPercent;
    case 'state':
      return r.state;
    case 'time':
      return r.cpuTimeSec;
    case 'command':
      return r.command;
    case 'server':
      return r.serverName;
  }
}

/** Sorts a copy; ties always fall back to the pid so rows do not jump between polls. */
function sortRows(rows: Row[], key: SortKey, dir: Dir): Row[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    let c = typeof va === 'number' && typeof vb === 'number' ? (Number.isFinite(va) ? va : -1) - (Number.isFinite(vb) ? vb : -1) : String(va).localeCompare(String(vb));
    c *= sign;
    return c || a.pid - b.pid || a.serverId.localeCompare(b.serverId);
  });
}

/* ------------------------------------------------------------------ pieces */

function Bar({ value, max, label, detail, tone }: { value: number; max: number; label: string; detail: string; tone: string }) {
  const w = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
      <span className="w-8 shrink-0 text-muted">{label}</span>
      <span className="relative h-3 min-w-[4rem] flex-1 overflow-hidden rounded-[1px] bg-raised" role="meter" aria-label={label} aria-valuenow={Math.round(value * 100) / 100} aria-valuemin={0} aria-valuemax={Math.round(max * 100) / 100}>
        <span className={clsx('absolute inset-y-0 start-0 transition-[width] duration-300', tone)} style={{ width: `${w}%` }} />
      </span>
      <span className="w-[9.5rem] shrink-0 truncate text-end tabular-nums" title={detail}>
        {detail}
      </span>
    </div>
  );
}

const barTone = (ratio: number) => (ratio >= 0.9 ? 'bg-danger' : ratio >= 0.6 ? 'bg-warn' : 'bg-ok');

function ServerBars({ s, cores, hostMemMb, t }: { s: ProcessServer; cores: number; hostMemMb: number; t: TFn }) {
  // Container CPU is a percent of the server's allotment; per-process values are per core (100 = one core).
  const limit = s.cpuLimit && s.cpuLimit > 0 ? s.cpuLimit : null;
  const procCores = s.processes.reduce((n, p) => n + (p.cpuPercent || 0), 0) / 100;
  const usedCores = s.cpuPercent != null && limit ? (s.cpuPercent / 100) * limit : s.cpuPercent != null ? s.cpuPercent / 100 : procCores;
  const maxCores = limit ?? Math.max(1, cores);
  const mem = s.memUsedMb ?? s.processes.reduce((n, p) => n + (p.memMb || 0), 0);
  const memMax = s.memLimitMb && s.memLimitMb > 0 ? s.memLimitMb : hostMemMb;
  return (
    <div className="min-w-0 space-y-1 rounded-block border border-line px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <StatusDot status={s.status} />
        <span className="truncate font-medium">{s.name}</span>
      </div>
      <Bar
        label="CPU"
        value={usedCores}
        max={maxCores}
        tone={barTone(usedCores / maxCores)}
        detail={t('proc.cpuDetail', { used: formatNumber(usedCores, 2), max: formatNumber(maxCores, 1) })}
      />
      <Bar label="MEM" value={mem} max={memMax} tone={barTone(memMax ? mem / memMax : 0)} detail={`${formatMb(mem)} / ${formatMb(memMax)}`} />
    </div>
  );
}

function SortHeader({ k, label, sort, onSort, align = 'start', className }: { k: SortKey; label: string; sort: { key: SortKey; dir: Dir }; onSort: (k: SortKey) => void; align?: 'start' | 'end'; className?: string }) {
  const active = sort.key === k;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={clsx('!px-0 !py-0', className)}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={clsx(
          'flex w-full items-center gap-1 px-2 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
          align === 'end' ? 'justify-end' : 'justify-start',
          active ? 'text-ink' : 'text-muted',
        )}
      >
        {label}
        {active ? sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden="true" /> : <ArrowDown className="h-3 w-3" aria-hidden="true" /> : <span className="w-3" aria-hidden="true" />}
      </button>
    </th>
  );
}

const sameProc = (a: Row, b: Row) =>
  a.pid === b.pid &&
  a.serverId === b.serverId &&
  a.cpuPercent === b.cpuPercent &&
  a.memMb === b.memMb &&
  a.memPercent === b.memPercent &&
  a.state === b.state &&
  a.cpuTimeSec === b.cpuTimeSec &&
  a.elapsedSec === b.elapsedSec &&
  a.user === b.user &&
  a.command === b.command &&
  a.serverName === b.serverName;

/** One process line; skips re-rendering when nothing it shows has changed. */
const ProcRow = memo(
  function ProcRow({ r, flat, runningFor }: { r: Row; flat: boolean; runningFor: string }) {
    return (
      <tr className="hover:bg-raised/60">
        <td className="px-2 py-0.5 text-end tabular-nums text-muted">{r.pid}</td>
        {flat && <td className="max-w-[10rem] truncate px-2 py-0.5" title={r.serverName}>{r.serverName}</td>}
        <td className="max-w-[7rem] truncate px-2 py-0.5" title={r.user}>
          {r.user}
        </td>
        <td className={clsx('px-2 py-0.5 text-end tabular-nums', cpuTone(r.cpuPercent))}>{pct(r.cpuPercent)}</td>
        <td className={clsx('px-2 py-0.5 text-end tabular-nums', memTone(r.memPercent))}>{formatMb(r.memMb)}</td>
        <td className={clsx('px-2 py-0.5 text-end tabular-nums', memTone(r.memPercent))}>{pct(r.memPercent)}</td>
        <td className={clsx('px-2 py-0.5 text-center', stateTone(r.state))}>{r.state}</td>
        <td className="px-2 py-0.5 text-end tabular-nums" title={runningFor}>
          {fmtCpuTime(r.cpuTimeSec)}
        </td>
        <td className="max-w-[48rem] truncate px-2 py-0.5" title={r.command}>
          {r.command}
        </td>
      </tr>
    );
  },
  (a, b) => a.flat === b.flat && a.runningFor === b.runningFor && sameProc(a.r, b.r),
);

/* ------------------------------------------------------------------ section */

export function ProcessesSection() {
  const t = useT();
  const defs = useGameDefs();
  const [interval, setIntervalMs] = useState<IntervalMs>(2000);
  const { data, error, fetching, lastOk, hidden, refresh } = useProcessPoll(interval);
  const [sort, setSort] = useState<{ key: SortKey; dir: Dir }>({ key: 'cpu', dir: 'desc' });
  const [filter, setFilter] = useState('');
  const [serverFilter, setServerFilter] = useState('');
  const [flat, setFlat] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const onSort = useCallback(
    (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: NUMERIC[k] ? 'desc' : 'asc' })),
    [],
  );

  const servers = useMemo(() => [...(data?.servers ?? [])].sort((a, b) => a.name.localeCompare(b.name) || a.serverId.localeCompare(b.serverId)), [data]);

  // A server that stopped disappears from the payload; drop a filter that points at it.
  useEffect(() => {
    if (serverFilter && data && !data.servers.some((s) => s.serverId === serverFilter)) setServerFilter('');
  }, [data, serverFilter]);

  const needle = filter.trim().toLowerCase();
  const matches = useCallback(
    (p: ProcessInfo) => !needle || p.command.toLowerCase().includes(needle) || p.user.toLowerCase().includes(needle) || String(p.pid).includes(needle),
    [needle],
  );

  const groups = useMemo(
    () =>
      servers
        .filter((s) => !serverFilter || s.serverId === serverFilter)
        .map((s) => {
          const rows: Row[] = s.processes.filter(matches).map((p) => ({ ...p, serverId: s.serverId, serverName: s.name }));
          return {
            server: s,
            rows: sortRows(rows, sort.key === 'server' ? 'cpu' : sort.key, sort.key === 'server' ? 'desc' : sort.dir),
            cpu: s.processes.reduce((n, p) => n + (p.cpuPercent || 0), 0),
            mem: s.processes.reduce((n, p) => n + (p.memMb || 0), 0),
          };
        }),
    [servers, serverFilter, matches, sort],
  );
  const flatRows = useMemo(() => (flat ? sortRows(groups.flatMap((g) => g.rows), sort.key, sort.dir) : []), [flat, groups, sort]);
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  const total = servers.reduce((n, s) => n + s.processes.length, 0);

  const toggleGroup = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const cores = data?.host.cpuCount ?? 0;
  const hostMem = data?.host.memTotalMb ?? 0;
  const cols = flat ? 9 : 8;
  const runningFor = (r: Row) => t('proc.runningFor', { time: fmtElapsed(r.elapsedSec) });
  const stale = !!error && !!data;
  const paused = interval === 0 || hidden;
  const updated = lastOk ? new Date(lastOk).toLocaleTimeString() : null;

  let content: ReactNode;
  if (!data && error) {
    content = <ErrorState error={error} onRetry={refresh} />;
  } else if (!data) {
    content = (
      <div className="flex items-center gap-2 py-8 text-sm text-muted">
        <Spinner className="h-4 w-4" />
        {t('common.loading')}
      </div>
    );
  } else if (!data.dockerAvailable) {
    content = <EmptyState icon={<AlertTriangle className="h-9 w-9" />} title={t('proc.dockerTitle')} body={t('proc.dockerBody')} />;
  } else if (!servers.length) {
    content = <EmptyState icon={<ServerOff className="h-9 w-9" />} title={t('proc.noneTitle')} body={t('proc.noneBody')} />;
  } else {
    content = (
      <div className="space-y-3">
        <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
          {servers.map((s) => (
            <ServerBars key={s.serverId} s={s} cores={cores} hostMemMb={hostMem} t={t} />
          ))}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
          <label className="block sm:w-64">
            <span className="label">{t('proc.filter')}</span>
            <input className="input" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('proc.filterPlaceholder')} />
          </label>
          <label className="block sm:w-56">
            <span className="label">{t('proc.server')}</span>
            <select className="input" value={serverFilter} onChange={(e) => setServerFilter(e.target.value)}>
              <option value="">{t('proc.allServers')}</option>
              {servers.map((s) => (
                <option key={s.serverId} value={s.serverId}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="pb-2 sm:ms-auto">
            <Toggle checked={flat} onChange={setFlat} label={t('proc.flat')} />
          </div>
        </div>

        <p className="text-xs text-muted" aria-live="polite">
          {t('proc.count', { shown, total })}
        </p>

        <div className="scrollbar-thin max-h-[70vh] overflow-auto rounded-block border border-line bg-surface">
          <table className="w-full min-w-[46rem] border-collapse font-mono text-xs leading-5">
            <thead className="sticky top-0 z-10 bg-raised shadow-[inset_0_-1px_0_rgb(var(--line))]">
              <tr>
                <SortHeader k="pid" label="PID" sort={sort} onSort={onSort} align="end" className="w-[4.5rem]" />
                {flat && <SortHeader k="server" label={t('proc.colServer')} sort={sort} onSort={onSort} />}
                <SortHeader k="user" label="USER" sort={sort} onSort={onSort} />
                <SortHeader k="cpu" label="CPU%" sort={sort} onSort={onSort} align="end" />
                <SortHeader k="mem" label="MEM" sort={sort} onSort={onSort} align="end" />
                <SortHeader k="memPct" label="MEM%" sort={sort} onSort={onSort} align="end" />
                <SortHeader k="state" label="S" sort={sort} onSort={onSort} />
                <SortHeader k="time" label="TIME+" sort={sort} onSort={onSort} align="end" />
                <SortHeader k="command" label={t('proc.colCommand')} sort={sort} onSort={onSort} className="w-full" />
              </tr>
            </thead>
            <tbody>
              {flat
                ? flatRows.map((r) => <ProcRow key={`${r.serverId}:${r.pid}`} r={r} flat runningFor={runningFor(r)} />)
                : groups.map((g) => {
                    const open = !collapsed.has(g.server.serverId);
                    return (
                      <Fragment key={g.server.serverId}>
                        <tr className="border-y border-line bg-raised/60">
                          <td colSpan={cols} className="p-0">
                            <button
                              type="button"
                              aria-expanded={open}
                              onClick={() => toggleGroup(g.server.serverId)}
                              className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-1 text-start font-sans text-[13px] hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                            >
                              {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 rtl:-scale-x-100" aria-hidden="true" />}
                              <StatusDot status={g.server.status} />
                              <span className="font-semibold">{g.server.name}</span>
                              <span className="text-muted">{gameKeyName(g.server.gameKey, defs.data, t)}</span>
                              <span className="text-muted">{t(`status.${g.server.status}` as TKey)}</span>
                              <span className="ms-auto font-mono text-xs tabular-nums text-muted">
                                {t('proc.groupTotals', { n: g.server.processes.length, cpu: pct(g.cpu), mem: formatMb(g.mem) })}
                              </span>
                            </button>
                          </td>
                        </tr>
                        {open && g.rows.map((r) => <ProcRow key={`${r.serverId}:${r.pid}`} r={r} flat={false} runningFor={runningFor(r)} />)}
                        {open && !g.rows.length && (
                          <tr>
                            <td colSpan={cols} className="px-2 py-1.5 font-sans text-muted">
                              {needle ? t('proc.noMatch') : t('proc.noProcesses')}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
              {flat && !flatRows.length && (
                <tr>
                  <td colSpan={cols} className="px-2 py-3 font-sans text-muted">
                    {t('proc.noMatch')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <section className="panel mb-4" aria-labelledby="proc-title">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 id="proc-title" className="flex items-center gap-2 text-base font-semibold">
            <Cpu className="h-4 w-4 text-muted" aria-hidden="true" />
            {t('proc.title')}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {data ? t('proc.host', { cores: data.host.cpuCount, mem: formatMb(data.host.memTotalMb) }) : t('proc.subtitle')}
            {updated && <> · {t('proc.updated', { time: updated })}</>}
            {hidden && interval > 0 && <> · {t('proc.hiddenPaused')}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {stale && (
            <span className="inline-flex items-center gap-1 text-xs text-warn" title={errorMessage(error)} role="status">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              {t('proc.stale')}
            </span>
          )}
          {fetching && !paused && <Spinner className="h-3.5 w-3.5" />}
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">{t('proc.interval')}</span>
            <select className="input !w-auto !py-1" value={interval} onChange={(e) => setIntervalMs(Number(e.target.value) as IntervalMs)}>
              {INTERVALS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms === 0 ? t('proc.paused') : t('proc.seconds', { n: formatNumber(ms / 1000) })}
                </option>
              ))}
            </select>
          </label>
          <IconButton label={t('common.refresh')} onClick={refresh} disabled={fetching} className="h-9 w-9">
            <RefreshCw className={clsx('h-4 w-4', fetching && 'animate-spin')} />
          </IconButton>
        </div>
      </header>
      <div className="p-3 sm:p-4">{content}</div>
    </section>
  );
}
