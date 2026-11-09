import { useState } from 'react';
import clsx from 'clsx';
import { Info } from 'lucide-react';
import { useT, type TKey } from '@/i18n';
import { buildCron, DEFAULT_BUILDER, describeCron, detectBuilder, weekdayShort, type BuilderState, type Freq } from '@/lib/cron';
import { usePrefs } from '@/stores/prefs';
import { Button, IconButton, Modal } from '@/components/ui';

const PRESETS: Array<{ cron: string; key: TKey }> = [
  { cron: '0 4 * * *', key: 'schedules.preset.daily4' },
  { cron: '0 */6 * * *', key: 'schedules.preset.every6h' },
  { cron: '0 * * * *', key: 'schedules.preset.hourly' },
  { cron: '0 5 * * 1', key: 'schedules.preset.weekly' },
];

const FREQS: Freq[] = ['minutes', 'hours', 'daily', 'weekly', 'monthly'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const EXAMPLES = ['*/15 * * * *', '0 4 * * *', '30 2 * * 1-5', '0 0 1 * *', '0 8,20 * * *', '0 */6 * * *', '0 12 * * 6,0'];

const pad = (n: number) => String(n).padStart(2, '0');
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? Math.trunc(v) : lo));

function NumberInput({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <input
      type="number"
      inputMode="numeric"
      className="input w-20"
      aria-label={label}
      min={min}
      max={max}
      value={value}
      onChange={(e) => e.target.value !== '' && onChange(clamp(Number(e.target.value), min, max))}
    />
  );
}

function Builder({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const t = useT();
  const locale = usePrefs((s) => s.locale);
  const detected = detectBuilder(value);
  const b: BuilderState = detected ?? DEFAULT_BUILDER;
  const set = (patch: Partial<BuilderState>) => onChange(buildCron({ ...b, ...patch }));
  const setTime = (v: string) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(v);
    if (m) set({ hour: clamp(Number(m[1]), 0, 23), minute: clamp(Number(m[2]), 0, 59) });
  };

  return (
    <div className="space-y-3 rounded-block border border-line p-3">
      <div className="label">{t('cron.builder.label')}</div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input w-auto"
          aria-label={t('cron.builder.label')}
          value={detected ? detected.freq : 'custom'}
          onChange={(e) => {
            const freq = e.target.value as Freq;
            // Starting values that make sense for the newly chosen kind.
            const every = freq === 'minutes' ? 15 : freq === 'hours' ? 6 : b.every;
            set({ freq, every });
          }}
        >
          {!detected && <option value="custom">{t('cron.freq.custom')}</option>}
          {FREQS.map((f) => (
            <option key={f} value={f}>
              {t(`cron.freq.${f}` as TKey)}
            </option>
          ))}
        </select>
        {detected && (detected.freq === 'minutes' || detected.freq === 'hours') && (
          <>
            <span className="text-sm text-muted">{t('cron.everyN')}</span>
            <NumberInput
              value={b.every}
              min={1}
              max={detected.freq === 'minutes' ? 59 : 23}
              onChange={(n) => set({ every: n })}
              label={t(detected.freq === 'minutes' ? 'cron.minutesUnit' : 'cron.hoursUnit')}
            />
            <span className="text-sm text-muted">{t(detected.freq === 'minutes' ? 'cron.minutesUnit' : 'cron.hoursUnit')}</span>
          </>
        )}
        {detected?.freq === 'hours' && (
          <>
            <span className="text-sm text-muted">{t('cron.atMinute')}</span>
            <NumberInput value={b.minute} min={0} max={59} onChange={(n) => set({ minute: n })} label={t('cron.atMinute')} />
          </>
        )}
        {detected && ['daily', 'weekly', 'monthly'].includes(detected.freq) && (
          <>
            <span className="text-sm text-muted">{t('cron.atTime')}</span>
            <input type="time" className="input w-auto font-mono" value={`${pad(b.hour)}:${pad(b.minute)}`} onChange={(e) => setTime(e.target.value)} />
          </>
        )}
      </div>
      {detected?.freq === 'weekly' && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm text-muted">{t('cron.onDays')}</span>
          {WEEK_ORDER.map((d) => {
            const on = b.days.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const days = on ? b.days.filter((x) => x !== d) : [...b.days, d];
                  if (days.length) set({ days });
                }}
                className={clsx('rounded-[2px] border px-2 py-1 text-xs', on ? 'border-accent bg-accent/15 text-ink' : 'border-line text-muted hover:border-accent')}
              >
                {weekdayShort(locale, d)}
              </button>
            );
          })}
        </div>
      )}
      {detected?.freq === 'monthly' && (
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">{t('cron.dayOfMonth')}</span>
            <NumberInput value={b.dayOfMonth} min={1} max={31} onChange={(n) => set({ dayOfMonth: n })} label={t('cron.dayOfMonth')} />
          </div>
          {b.dayOfMonth > 28 && <p className="hint mt-1">{t('cron.dayOfMonthHint')}</p>}
        </div>
      )}
    </div>
  );
}

function Help({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const locale = usePrefs((s) => s.locale);
  const fields = ['minute', 'hour', 'dom', 'month', 'dow'] as const;
  const symbols = [
    ['*', 'cron.help.star'],
    [',', 'cron.help.comma'],
    ['-', 'cron.help.dash'],
    ['/', 'cron.help.slash'],
  ] as const;
  const tips = ['tz', 'or', 'step', 'star', 'restart', 'short'] as const;
  const h = 'mb-2 mt-5 text-sm font-semibold';
  return (
    <Modal open={open} onClose={onClose} wide title={t('cron.help.title')} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <div className="text-sm leading-relaxed">
        <p>{t('cron.help.intro')}</p>

        <h3 className={h}>{t('cron.help.layout')}</h3>
        <pre className="overflow-x-auto rounded-block bg-raised p-3 font-mono text-xs leading-5" aria-hidden>
          {`┌──────── ${t('cron.help.f.minute')} (0-59)
│ ┌────── ${t('cron.help.f.hour')} (0-23)
│ │ ┌──── ${t('cron.help.f.dom')} (1-31)
│ │ │ ┌── ${t('cron.help.f.month')} (1-12)
│ │ │ │ ┌ ${t('cron.help.f.dow')} (0-6)
* * * * *`}
        </pre>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {fields.map((f, i) => (
            <div key={f} className="contents">
              <dt className="font-medium">
                {i + 1}. {t(`cron.help.f.${f}` as TKey)}
              </dt>
              <dd className="text-muted">{t(`cron.help.r.${f}` as TKey)}</dd>
            </div>
          ))}
        </dl>

        <h3 className={h}>{t('cron.help.symbols')}</h3>
        <dl className="space-y-1.5">
          {symbols.map(([sym, key]) => (
            <div key={sym} className="flex gap-3">
              <dt className="w-6 shrink-0 text-center font-mono text-base font-semibold text-accent">{sym}</dt>
              <dd className="text-muted">{t(key)}</dd>
            </div>
          ))}
        </dl>

        <h3 className={h}>{t('cron.help.readTitle')}</h3>
        <p className="text-muted">{t('cron.help.readBody')}</p>

        <h3 className={h}>{t('cron.help.examples')}</h3>
        <ul className="divide-y divide-line rounded-block border border-line">
          {EXAMPLES.map((ex) => (
            <li key={ex} className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-3 py-2">
              <code className="w-36 shrink-0 font-mono">{ex}</code>
              <span className="text-muted">{describeCron(ex, locale, t)}</span>
            </li>
          ))}
        </ul>

        <h3 className={h}>{t('cron.help.tips')}</h3>
        <ul className="list-disc space-y-1.5 pl-5 text-muted">
          {tips.map((k) => (
            <li key={k}>{t(`cron.help.tip.${k}` as TKey)}</li>
          ))}
        </ul>
        <p className="mt-4 text-muted">{t('cron.help.builderHint')}</p>
      </div>
    </Modal>
  );
}

export function CronPicker({ value, onChange, onHelpToggle }: { value: string; onChange: (cron: string) => void; onHelpToggle?: (open: boolean) => void }) {
  const t = useT();
  const locale = usePrefs((s) => s.locale);
  const [help, setHelpState] = useState(false);
  const setHelp = (open: boolean) => {
    onHelpToggle?.(open);
    setHelpState(open);
  };
  const text = value.trim() ? describeCron(value, locale, t) : null;

  return (
    <div className="space-y-3">
      <Builder value={value} onChange={onChange} />
      <div>
        <div className="flex items-center gap-1">
          <label htmlFor="cron-expression" className="label !mb-0">
            {t('schedules.cron')}
          </label>
          <IconButton label={t('cron.help.open')} onClick={() => setHelp(true)} className="!h-6 !w-6">
            <Info className="h-4 w-4" />
          </IconButton>
        </div>
        <input id="cron-expression" className="input font-mono" spellCheck={false} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
        <span className="hint block">{t('schedules.cronHint')}</span>
        {value.trim() &&
          (text ? (
            <p className="mt-1 text-sm text-accent" aria-live="polite">
              {t('cron.runs', { text })}
            </p>
          ) : (
            <p className="mt-1 text-xs text-danger" aria-live="polite">
              {t('cron.invalid')}
            </p>
          ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button key={p.cron} type="button" className="rounded-[2px] border border-line px-2 py-1 text-xs hover:border-accent" onClick={() => onChange(p.cron)}>
            {t(p.key)}
          </button>
        ))}
      </div>
      <Help open={help} onClose={() => setHelp(false)} />
    </div>
  );
}
