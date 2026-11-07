import { useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { WifiOff } from 'lucide-react';
import type { Stats } from '@/api/types';
import { useT } from '@/i18n';
import { canOperate } from '@/lib/access';
import { formatNumber, formatUptime } from '@/lib/format';
import { sendCommand } from '@/lib/sendCommand';
import { useLogs, useStats } from '@/lib/useFallbacks';
import { MAX_SAMPLES, type Sample } from '@/ws/live';
import { CommandInput, LogView } from '@/components/LogView';
import { useServerCtx } from './ServerLayout';

/* The layout follows the vanilla dedicated-server window: Stats and Players on the left,
   "Log and chat" with a command field on the right. */

const SEGMENTS = 24;

function MemoryBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? used / limit : 0;
  const filled = Math.round(pct * SEGMENTS);
  const tone = pct > 0.9 ? 'bg-danger' : pct > 0.75 ? 'bg-warn' : 'bg-ok';
  return (
    <div className="gui-well flex gap-[2px] p-[3px]" role="meter" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span key={i} className={clsx('h-3.5 flex-1 rounded-[1px] transition-colors duration-500', i < filled ? tone : 'bg-white/[0.06]')} />
      ))}
    </div>
  );
}

function tickTone(ms: number) {
  if (ms >= 50) return 'rgb(var(--danger))';
  if (ms >= 30) return 'rgb(var(--warn))';
  return 'rgb(var(--ok))';
}

function TickGraph({ history, field }: { history: Sample[]; field: 'mspt' | 'cpu' }) {
  const values = history.map((s) => (field === 'mspt' ? s.mspt : s.cpu));
  const peak = Math.max(field === 'mspt' ? 60 : 100, ...values.map((v) => v ?? 0));
  const h = 60;
  const offset = MAX_SAMPLES - values.length;
  return (
    <div className="gui-well p-1">
      <svg viewBox={`0 0 ${MAX_SAMPLES} ${h}`} preserveAspectRatio="none" className="block h-24 w-full" shapeRendering="crispEdges" aria-hidden>
        {field === 'mspt' && (
          <line x1={0} x2={MAX_SAMPLES} y1={h - (50 / peak) * h} y2={h - (50 / peak) * h} stroke="rgb(var(--danger))" strokeOpacity={0.5} strokeDasharray="1 1" strokeWidth={0.4} vectorEffect="non-scaling-stroke" />
        )}
        {values.map((v, i) => {
          if (v === null || v === undefined) return null;
          const bh = Math.max(1, (v / peak) * h);
          return <rect key={history[i].t} x={offset + i + 0.1} y={h - bh} width={0.8} height={bh} fill={field === 'mspt' ? tickTone(v) : 'rgb(var(--accent))'} />;
        })}
      </svg>
    </div>
  );
}

function PlayerHead({ name }: { name: string }) {
  const [broken, setBroken] = useState(false);
  if (broken)
    return <span className="flex h-6 w-6 items-center justify-center rounded-[2px] bg-accent/20 font-mono text-[11px] font-bold text-accent">{name.slice(0, 1).toUpperCase()}</span>;
  return (
    <img
      src={`https://mc-heads.net/avatar/${encodeURIComponent(name)}/24`}
      alt=""
      width={24}
      height={24}
      loading="lazy"
      className="h-6 w-6 rounded-[2px] [image-rendering:pixelated]"
      onError={() => setBroken(true)}
    />
  );
}

function StatLine({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm" title={title}>
      <span className="text-muted">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function StatsPanel({ stats, history }: { stats: Stats | null; history: Sample[] }) {
  const t = useT();
  const used = stats?.memory?.usedMb ?? 0;
  const limit = stats?.memory?.limitMb ?? 0;
  const pct = limit ? Math.round((used / limit) * 100) : 0;
  const hasTick = history.some((s) => s.mspt !== null) || stats?.mspt?.avg != null;
  return (
    <section className="gui-frame space-y-4">
      <h2 className="gui-legend">{t('overview.stats')}</h2>
      <div>
        <p className="mb-1.5 text-sm">
          {t('overview.memoryUse', { used: formatNumber(used), pct, limit: formatNumber(limit) })}
        </p>
        <MemoryBar used={used} limit={limit} />
      </div>
      <div>
        <p className="mb-1.5 text-sm">
          {hasTick
            ? t('overview.avgTick', { ms: formatNumber(stats?.mspt?.avg, 1) })
            : t('overview.cpuGraph', { pct: formatNumber(stats?.cpuPercent, 0) })}
        </p>
        <TickGraph history={history} field={hasTick ? 'mspt' : 'cpu'} />
        {!hasTick && <p className="hint">{t('overview.noTick')}</p>}
      </div>
      <div className="space-y-1 border-t border-line pt-3">
        <StatLine label="TPS" value={stats?.tps != null ? formatNumber(stats.tps, 1) : '–'} />
        <StatLine label={t('overview.p95')} value={stats?.mspt?.p95 != null ? `${formatNumber(stats.mspt.p95, 1)} ms` : '–'} />
        <StatLine label="CPU" value={stats ? `${formatNumber(stats.cpuPercent, 0)}%` : '–'} />
        <StatLine label={t('overview.uptime')} value={formatUptime(stats?.uptimeSec)} />
        {stats?.diskMb != null && <StatLine label={t('overview.disk')} value={`${formatNumber(stats.diskMb)} MB`} />}
        {stats?.version && <StatLine label={t('overview.version')} value={stats.version} />}
        {stats?.packVersion && (
          <StatLine label={t('overview.packVersion')} value={stats.packName ? `${stats.packName} ${stats.packVersion}` : stats.packVersion} />
        )}
        <StatLine label={t('overview.source')} value={stats?.source ?? '–'} title={t('overview.sourceHint')} />
      </div>
    </section>
  );
}

function PlayersPanel({ stats }: { stats: Stats | null }) {
  const t = useT();
  const list = stats?.players?.list ?? [];
  return (
    <section className="gui-frame flex min-h-0 flex-col">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="gui-legend !mb-0">{t('overview.players')}</h2>
        <span className="text-sm tabular-nums text-muted">
          {stats?.players ? `${stats.players.online} / ${stats.players.max}` : '–'}
        </span>
      </div>
      <div className="gui-well scrollbar-thin max-h-72 min-h-[7rem] flex-1 overflow-y-auto p-1.5">
        {list.length === 0 ? (
          <p className="px-2 py-4 text-center text-sm text-console-ink/50">{t('overview.noPlayers')}</p>
        ) : (
          <ul>
            {list.map((p) => (
              <li key={p.name} className="flex items-center gap-2.5 rounded-[2px] px-2 py-1 font-mono text-[13px] hover:bg-white/5">
                <PlayerHead name={p.name} />
                {p.name}
              </li>
            ))}
          </ul>
        )}
      </div>
      {list.length > 0 && (
        <Link to="players" className="mt-2 text-xs text-accent hover:underline">
          {t('overview.managePlayers')}
        </Link>
      )}
    </section>
  );
}

export default function Overview() {
  const t = useT();
  const { server, live } = useServerCtx();
  const stats = useStats(server.id, live);
  const logs = useLogs(server.id, live);
  const op = canOperate(server.access);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(17rem,22rem)_1fr]">
      <div className="flex flex-col gap-4">
        <StatsPanel stats={stats} history={live.history} />
        <PlayersPanel stats={stats} />
      </div>
      <section className="gui-frame flex min-w-0 flex-col lg:max-h-[calc(100dvh-13rem)]">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="gui-legend !mb-0">{t('overview.log')}</h2>
          {live.conn !== 'open' && (
            <span className="inline-flex items-center gap-1.5 text-xs text-warn">
              <WifiOff className="h-3.5 w-3.5" />
              {live.conn === 'connecting' ? t('console.connecting') : t('console.offline')}
            </span>
          )}
        </div>
        <LogView lines={logs} className="h-[22rem] sm:h-[28rem] lg:h-auto lg:min-h-[24rem] lg:flex-1" />
        <div className="mt-2">
          <CommandInput
            disabled={!op || server.status !== 'running'}
            placeholder={!op ? t('console.readOnly') : server.status !== 'running' ? t('console.notRunning') : undefined}
            onSend={(cmd) => sendCommand(server.id, cmd)}
          />
        </div>
      </section>
    </div>
  );
}
