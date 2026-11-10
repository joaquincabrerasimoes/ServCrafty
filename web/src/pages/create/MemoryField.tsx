import { useId, useState } from 'react';
import clsx from 'clsx';
import { useT } from '@/i18n';
import { formatMb } from '@/lib/format';

export const MEMORY_SLIDER_MIN_MB = 1024;
export const MEMORY_SLIDER_MAX_MB = 32768;
export const MEMORY_STEP_MB = 512;
/** Backend limit (servers.memoryMb max). */
export const MEMORY_API_MAX_MB = 1_048_576;

const toGb = (mb: number) => String(Math.round((mb / 1024) * 100) / 100);

/**
 * Memory slider + GB number input, kept in sync both ways. The slider covers the common range;
 * larger values can be typed (up to `maxMb`, the remaining RAM quota or the API limit). On blur
 * the typed value is clamped and rounded to 0.5 GB.
 */
export function MemoryField({
  valueMb,
  onChange,
  maxMb,
  quotaError,
  minMb = MEMORY_SLIDER_MIN_MB,
  hint,
}: {
  valueMb: number;
  onChange: (mb: number) => void;
  /** Highest value that may be typed. */
  maxMb: number;
  quotaError?: string | null;
  /** Lowest value (slider start and typed minimum). */
  minMb?: number;
  /** Replaces the default (Minecraft) sizing hint. */
  hint?: string;
}) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const sliderMax = Math.max(minMb, Math.min(MEMORY_SLIDER_MAX_MB, maxMb));
  const typedMaxGb = maxMb / 1024;
  const minGb = minMb / 1024;

  const parsed = draft === null ? null : Number(draft.replace(',', '.'));
  const draftError =
    draft === null
      ? null
      : draft.trim() === '' || !Number.isFinite(parsed)
        ? t('wizard.memoryInvalid')
        : parsed! < minGb
          ? t('wizard.memoryMin', { min: minGb })
          : parsed! > typedMaxGb
            ? t('wizard.memoryMax', { max: formatMb(maxMb) })
            : null;
  const error = draftError ?? quotaError ?? null;

  const commit = () => {
    if (draft === null) return;
    const gb = Number(draft.replace(',', '.'));
    if (Number.isFinite(gb) && draft.trim() !== '') {
      const mb = Math.round((gb * 1024) / MEMORY_STEP_MB) * MEMORY_STEP_MB;
      onChange(Math.min(Math.max(mb, minMb), Math.max(minMb, Math.floor(maxMb / MEMORY_STEP_MB) * MEMORY_STEP_MB)));
    }
    setDraft(null);
  };

  return (
    <div>
      <label htmlFor={`${id}-gb`} className="label">
        {t('server.memory')}
      </label>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={minMb}
          max={sliderMax}
          step={MEMORY_STEP_MB}
          value={Math.min(valueMb, sliderMax)}
          aria-label={t('server.memory')}
          aria-valuetext={formatMb(valueMb)}
          onChange={(e) => {
            setDraft(null);
            onChange(Number(e.target.value));
          }}
          className="min-w-0 flex-1 accent-[rgb(var(--accent))]"
        />
        <div className="flex shrink-0 items-center gap-2">
          <input
            id={`${id}-gb`}
            className={clsx('input w-24 text-end tabular-nums', error && 'border-danger focus:border-danger focus:ring-danger/25')}
            type="number"
            inputMode="decimal"
            min={minGb}
            max={typedMaxGb}
            step={0.5}
            value={draft ?? toGb(valueMb)}
            aria-invalid={!!error}
            aria-describedby={`${id}-msg`}
            onChange={(e) => {
              const raw = e.target.value;
              setDraft(raw);
              const gb = Number(raw.replace(',', '.'));
              // Live-sync the slider while typing valid values; clamp/round happens on blur.
              if (raw.trim() !== '' && Number.isFinite(gb) && gb >= minGb && gb <= typedMaxGb) onChange(Math.round(gb * 1024));
            }}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
          <span className="text-sm text-muted" aria-hidden="true">
            GB
          </span>
        </div>
      </div>
      <span id={`${id}-msg`} className={clsx('mt-1 block text-xs', error ? 'text-danger' : 'text-muted')} role={error ? 'alert' : undefined}>
        {error ?? `${hint ?? t('wizard.memoryHint')} ${maxMb > MEMORY_SLIDER_MAX_MB ? t('wizard.memoryTypeMore', { max: formatMb(maxMb) }) : ''}`}
      </span>
    </div>
  );
}
