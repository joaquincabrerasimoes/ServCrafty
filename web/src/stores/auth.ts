import { create } from 'zustand';
import { ApiError, authApi, type MeResponse, type User } from '@/api';
import { usePrefs } from './prefs';

type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

interface AuthState {
  status: AuthStatus;
  user: User | null;
  mfa: MeResponse['mfa'] | null;
  refresh: () => Promise<void>;
  setUser: (u: User) => void;
  logout: () => Promise<void>;
  clear: () => void;
}

function adoptPrefs(u: User) {
  const p = usePrefs.getState();
  if (u.theme && u.theme !== p.theme) p.setTheme(u.theme);
  if (u.locale && u.locale !== p.locale) p.setLocale(u.locale);
}

export const useAuth = create<AuthState>((set) => ({
  status: 'loading',
  user: null,
  mfa: null,
  refresh: async () => {
    try {
      const me = await authApi.me();
      adoptPrefs(me.user);
      set({ status: 'authenticated', user: me.user, mfa: me.mfa });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        set({ status: 'anonymous', user: null, mfa: null });
      } else {
        // Backend unreachable: treat as signed-out so the login page can show the error.
        set({ status: 'anonymous', user: null, mfa: null });
      }
    }
  },
  setUser: (user) => {
    adoptPrefs(user);
    set({ status: 'authenticated', user });
  },
  logout: async () => {
    try {
      await authApi.logout();
    } finally {
      set({ status: 'anonymous', user: null, mfa: null });
    }
  },
  clear: () => set({ status: 'anonymous', user: null, mfa: null }),
}));

export const useIsAdmin = () => useAuth((s) => s.user?.role === 'admin');
