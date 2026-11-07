import { useCallback } from 'react';
import { usePrefs } from '@/stores/prefs';
import type { Locale } from '@/api/types';
import { en } from './en';
import { es } from './es';

export type TKey = keyof typeof en;
export type TVars = Record<string, string | number>;
export type TFn = (key: TKey, vars?: TVars) => string;

const dicts: Record<Locale, Record<TKey, string>> = { en, es };

export function translate(locale: Locale, key: TKey, vars?: TVars): string {
  let s = dicts[locale]?.[key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Translate outside React (e.g. in toasts fired from callbacks). */
export const t: TFn = (key, vars) => translate(usePrefs.getState().locale, key, vars);

export function useT(): TFn {
  const locale = usePrefs((s) => s.locale);
  return useCallback((key: TKey, vars?: TVars) => translate(locale, key, vars), [locale]);
}

export const LOCALES: Array<{ id: Locale; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
];
