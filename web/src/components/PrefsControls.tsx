import clsx from 'clsx';
import { Monitor, Moon, Sun } from 'lucide-react';
import { accountApi } from '@/api';
import type { Locale, ThemePref } from '@/api/types';
import { usePrefs } from '@/stores/prefs';
import { useAuth } from '@/stores/auth';
import { LOCALES, useT } from '@/i18n';

function persist(body: { theme?: ThemePref; locale?: Locale }) {
  if (useAuth.getState().status === 'authenticated') void accountApi.update(body).catch(() => undefined);
}

export function ThemeSwitch({ className, iconsOnly }: { className?: string; iconsOnly?: boolean }) {
  const t = useT();
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const opts: Array<{ id: ThemePref; icon: typeof Sun; label: string }> = [
    { id: 'light', icon: Sun, label: t('prefs.light') },
    { id: 'dark', icon: Moon, label: t('prefs.dark') },
    { id: 'system', icon: Monitor, label: t('prefs.system') },
  ];
  return (
    <div role="radiogroup" aria-label={t('prefs.theme')} className={clsx('inline-flex rounded-block border border-line bg-surface p-0.5', className)}>
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={theme === o.id}
          title={o.label}
          onClick={() => {
            setTheme(o.id);
            persist({ theme: o.id });
          }}
          className={clsx(
            'inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[2px] px-2 text-xs',
            theme === o.id ? 'bg-raised text-ink' : 'text-muted hover:text-ink',
          )}
        >
          <o.icon className="h-3.5 w-3.5" />
          <span className={iconsOnly ? 'sr-only' : 'sr-only sm:not-sr-only'}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function LocaleSelect({ className }: { className?: string }) {
  const t = useT();
  const locale = usePrefs((s) => s.locale);
  const setLocale = usePrefs((s) => s.setLocale);
  return (
    <select
      aria-label={t('prefs.language')}
      className={clsx('input h-8 py-0 text-xs', className)}
      value={locale}
      onChange={(e) => {
        const l = e.target.value as Locale;
        setLocale(l);
        persist({ locale: l });
      }}
    >
      {LOCALES.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
