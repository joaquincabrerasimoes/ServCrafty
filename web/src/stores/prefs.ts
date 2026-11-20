import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Locale, ThemePref } from '@/api/types';

interface PrefsState {
  theme: ThemePref;
  locale: Locale;
  /** Show the timestamp (docker format) in front of every console line. */
  logTimestamps: boolean;
  setTheme: (t: ThemePref) => void;
  setLocale: (l: Locale) => void;
  setLogTimestamps: (v: boolean) => void;
}

const detectLocale = (): Locale => (navigator.language?.toLowerCase().startsWith('es') ? 'es' : 'en');

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      theme: 'system',
      locale: detectLocale(),
      logTimestamps: false,
      setTheme: (theme) => set({ theme }),
      setLocale: (locale) => set({ locale }),
      setLogTimestamps: (logTimestamps) => set({ logTimestamps }),
    }),
    { name: 'servcrafty.prefs', partialize: (s) => ({ theme: s.theme, locale: s.locale, logTimestamps: s.logTimestamps }) },
  ),
);

const media = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme: ThemePref) {
  const dark = theme === 'dark' || (theme === 'system' && media.matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1a1e21' : '#e9ece8');
}

/** Keeps <html class="dark"> and <html lang> in sync with preferences and the OS. */
export function installPrefsEffects() {
  applyTheme(usePrefs.getState().theme);
  document.documentElement.lang = usePrefs.getState().locale;
  usePrefs.subscribe((s) => {
    applyTheme(s.theme);
    document.documentElement.lang = s.locale;
  });
  media.addEventListener('change', () => applyTheme(usePrefs.getState().theme));
}
