import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { ArrowDown, CornerDownLeft } from 'lucide-react';
import type { LogLine } from '@/ws/live';
import { useT } from '@/i18n';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]|§[0-9a-fk-or]/gi;
export const cleanLine = (s: string) => s.replace(ANSI, '');

function lineClass(l: LogLine) {
  if (l.kind === 'echo') return 'text-accent';
  if (l.kind === 'error') return 'text-danger';
  if (/\b(ERROR|SEVERE|FATAL)\b|Exception/.test(l.text)) return 'text-[#ff8a80]';
  if (/\bWARN(ING)?\b/.test(l.text)) return 'text-[#f2cc60]';
  if (/ joined the game| left the game/.test(l.text)) return 'text-[#9be3c0]';
  return '';
}

export function LogView({ lines, className, wrap = true, filter }: { lines: LogLine[]; className?: string; wrap?: boolean; filter?: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const f = filter?.trim().toLowerCase();
  const shown = f ? lines.filter((l) => l.text.toLowerCase().includes(f)) : lines;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [shown.length, stick]);

  return (
    <div className={clsx('gui-well relative', className)}>
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="scrollbar-thin h-full overflow-auto px-3 py-2 font-mono text-[12.5px] leading-[1.55]"
        role="log"
        aria-live="off"
      >
        {shown.length === 0 ? (
          <div className="py-6 text-center text-console-ink/50">{t('console.empty')}</div>
        ) : (
          shown.map((l) => (
            <div key={l.id} className={clsx(wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre', lineClass(l))}>
              {cleanLine(l.text)}
            </div>
          ))
        )}
      </div>
      {!stick && (
        <button
          className="absolute bottom-3 right-4 inline-flex items-center gap-1 rounded-[2px] bg-accent px-2 py-1 text-xs font-medium text-accent-ink shadow"
          onClick={() => setStick(true)}
        >
          <ArrowDown className="h-3 w-3" />
          {t('console.follow')}
        </button>
      )}
    </div>
  );
}

const HISTORY_KEY = 'servcrafty.cmdHistory';

export function CommandInput({ onSend, disabled, placeholder }: { onSend: (cmd: string) => Promise<void> | void; disabled?: boolean; placeholder?: string }) {
  const t = useT();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const history = useRef<string[]>([]);
  const idx = useRef(-1);

  useEffect(() => {
    try {
      history.current = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? '[]');
    } catch {
      history.current = [];
    }
  }, []);

  const submit = async () => {
    const cmd = value.trim().replace(/^\//, '');
    if (!cmd) return;
    setBusy(true);
    try {
      await onSend(cmd);
      history.current = [cmd, ...history.current.filter((h) => h !== cmd)].slice(0, 50);
      try {
        sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history.current));
      } catch {
        /* storage unavailable */
      }
      idx.current = -1;
      setValue('');
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'ArrowUp' && history.current.length) {
      e.preventDefault();
      idx.current = Math.min(idx.current + 1, history.current.length - 1);
      setValue(history.current[idx.current]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      idx.current = Math.max(idx.current - 1, -1);
      setValue(idx.current === -1 ? '' : history.current[idx.current]);
    }
  };

  return (
    <div className="gui-well flex items-center">
      <span className="pl-3 font-mono text-sm text-accent">/</span>
      <input
        className="min-w-0 flex-1 bg-transparent px-2 py-2.5 font-mono text-[13px] text-console-ink placeholder:text-console-ink/40 focus:outline-none"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        disabled={disabled || busy}
        placeholder={placeholder ?? t('console.placeholder')}
        aria-label={t('console.command')}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        className="mr-1 inline-flex h-8 items-center gap-1 rounded-[2px] px-2 text-xs text-console-ink/70 hover:bg-white/5 hover:text-console-ink disabled:opacity-40"
        onClick={() => void submit()}
        disabled={disabled || busy || !value.trim()}
      >
        <CornerDownLeft className="h-3.5 w-3.5" />
        {t('console.send')}
      </button>
    </div>
  );
}
