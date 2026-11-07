import clsx from 'clsx';
import type { ServerStatus } from '@/api/types';
import { useT, type TKey } from '@/i18n';

const tone: Record<ServerStatus, string> = {
  running: 'bg-ok',
  starting: 'bg-warn animate-pulse',
  stopping: 'bg-warn animate-pulse',
  installing: 'bg-accent animate-pulse',
  crashed: 'bg-danger',
  stopped: 'bg-muted/60',
};

export function StatusDot({ status, className }: { status: ServerStatus | null | undefined; className?: string }) {
  return <span className={clsx('inline-block h-2.5 w-2.5 shrink-0 rounded-[1px]', tone[status ?? 'stopped'] ?? 'bg-muted', className)} />;
}

export function StatusBadge({ status }: { status: ServerStatus | null | undefined }) {
  const t = useT();
  const s = status ?? 'stopped';
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium">
      <StatusDot status={s} />
      <span className={clsx(s === 'crashed' && 'text-danger')}>{t(`status.${s}` as TKey)}</span>
    </span>
  );
}
