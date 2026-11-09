import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { useT } from '@/i18n';
import { errorMessage } from '@/api/client';

/* ---------------------------------------------------------------- Button */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 active:brightness-95 shadow-[inset_0_-2px_0_rgb(0_0_0/0.18)]',
  secondary: 'bg-surface text-ink border border-line hover:bg-raised',
  ghost: 'text-ink hover:bg-raised',
  danger: 'bg-danger text-white hover:brightness-110 shadow-[inset_0_-2px_0_rgb(0_0_0/0.2)]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-block font-medium transition-[filter,background-color] disabled:cursor-not-allowed disabled:opacity-55',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-10 px-4 text-sm',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex h-8 w-8 items-center justify-center rounded-block text-muted hover:bg-raised hover:text-ink disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- Form */

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : hint ? <span className="hint block">{hint}</span> : null}
    </label>
  );
}

/**
 * Accessible on/off switch. The track is 44x24 (border-box, 1px border => 42x22 inside); the
 * 18px knob is pinned to the inline start with an explicit offset (an absolutely positioned
 * child without one inherits the button's centred static position and slides out of the
 * track) and travels 20px, mirrored in RTL.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  /** Accessible name when there is no visible label. */
  ariaLabel?: string;
}) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label ? undefined : ariaLabel}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative inline-block h-6 w-11 shrink-0 overflow-hidden rounded-block border p-0 align-middle transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'border-accent bg-accent' : 'border-line bg-raised',
        )}
      >
        <span
          aria-hidden="true"
          className={clsx(
            'pointer-events-none absolute start-[2px] top-[2px] block h-[18px] w-[18px] rounded-[2px] shadow-sm transition-transform duration-150',
            checked ? 'translate-x-5 bg-accent-ink rtl:-translate-x-5' : 'translate-x-0 bg-muted',
          )}
        />
      </button>
      {label && (
        <label htmlFor={id} className="cursor-pointer text-sm">
          {label}
        </label>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- Display */

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'; className?: string }) {
  const tones = {
    neutral: 'bg-raised text-muted border-line',
    accent: 'bg-accent/10 text-accent border-accent/30',
    ok: 'bg-ok/10 text-ok border-ok/30',
    warn: 'bg-warn/10 text-warn border-warn/30',
    danger: 'bg-danger/10 text-danger border-danger/30',
  };
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 text-xs font-medium', tones[tone], className)}>
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('h-5 w-5 animate-spin text-muted', className)} />;
}

export function Loading({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm text-muted">
      <Spinner />
      {label ?? t('common.loading')}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-col items-start gap-3 rounded-md border border-danger/30 bg-danger/5 p-4 text-sm">
      <div className="flex items-center gap-2 font-medium text-danger">
        <AlertTriangle className="h-4 w-4" />
        {errorMessage(error)}
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-muted">{icon}</div>}
      <h3 className="text-lg font-semibold">{title}</h3>
      {body && <p className="mt-1 max-w-md text-sm text-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold sm:text-[1.75rem]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, description, children, actions, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={clsx('panel', className)}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

/* ---------------------------------------------------------------- Modal */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  // Parents usually pass a fresh onClose every render. Keep it in a ref so the effect below (which moves
  // focus into the dialog) runs only when the dialog opens, not on every keystroke in a form field.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    document.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button[data-autofocus]');
    (first ?? ref.current)?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={clsx(
          'relative flex max-h-[92vh] w-full flex-col rounded-t-lg border border-line bg-surface shadow-2xl outline-none sm:rounded-lg',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <IconButton label={t('common.close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------- Misc */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-[2px] border border-line bg-raised px-1 font-mono text-[11px] text-muted">{children}</kbd>;
}

export function Meter({ value, max, tone = 'accent', className }: { value: number; max: number; tone?: 'accent' | 'ok' | 'warn' | 'danger'; className?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const tones = { accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger' };
  return (
    <div className={clsx('h-2 w-full overflow-hidden rounded-[2px] bg-raised', className)} role="meter" aria-valuenow={value} aria-valuemax={max}>
      <div className={clsx('h-full transition-[width] duration-500', tones[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ---------------------------------------------------------------- Link styled as a button */

export function buttonClass(variant: Variant = 'secondary', size: 'sm' | 'md' = 'md', className?: string) {
  return clsx(
    'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-block font-medium transition-[filter,background-color]',
    size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-10 px-4 text-sm',
    variants[variant],
    className,
  );
}

export function LinkButton({ to, variant, size, icon, children, className }: { to: string; variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={buttonClass(variant, size, className)}>
      {icon}
      {children}
    </Link>
  );
}
