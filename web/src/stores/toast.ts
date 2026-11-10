import { create } from 'zustand';
import { ApiError, errorMessage } from '@/api/client';
import { t } from '@/i18n';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: Toast['kind'], message: string) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message) => {
    const id = ++seq;
    set({ toasts: [...get().toasts.slice(-3), { id, kind, message }] });
    setTimeout(() => get().dismiss(id), kind === 'error' ? 7000 : 3500);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/**
 * Errors the UI words itself (the API message is English only): game access and disabled games
 * can come from any path that creates or starts a server (wizard, clone, templates, import, power).
 */
export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'game_not_allowed') return t('gameAccess.errNotAllowed');
    if (e.code === 'game_disabled') return t('gameAccess.errDisabled');
  }
  return errorMessage(e);
}

export const toast = {
  success: (m: string) => useToasts.getState().push('success', m),
  info: (m: string) => useToasts.getState().push('info', m),
  error: (e: unknown) => useToasts.getState().push('error', friendlyError(e)),
};
