import { useState, type ReactNode } from 'react';
import { create } from 'zustand';
import clsx from 'clsx';
import { CheckCircle2, Info, XCircle, X } from 'lucide-react';
import { useToasts } from '@/stores/toast';
import { useT } from '@/i18n';
import { Button, Modal } from './ui';

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:pr-6" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md border bg-surface px-4 py-3 text-sm shadow-lg',
            t.kind === 'error' ? 'border-danger/40' : t.kind === 'success' ? 'border-ok/40' : 'border-line',
          )}
        >
          {t.kind === 'error' ? (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          ) : t.kind === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          )}
          <span className="flex-1 break-words">{t.message}</span>
          <button className="text-muted hover:text-ink" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Confirm */

interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** When set, the user must type this text to enable the confirm button. */
  typeToConfirm?: string;
  resolve: (ok: boolean) => void;
}

const useConfirmStore = create<{ req: ConfirmRequest | null }>(() => ({ req: null }));

export function confirm(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useConfirmStore.setState({ req: { ...opts, resolve } }));
}

export function ConfirmHost() {
  const t = useT();
  const req = useConfirmStore((s) => s.req);
  const [typed, setTyped] = useState('');
  const close = (ok: boolean) => {
    req?.resolve(ok);
    setTyped('');
    useConfirmStore.setState({ req: null });
  };
  if (!req) return null;
  const blocked = !!req.typeToConfirm && typed !== req.typeToConfirm;
  return (
    <Modal
      open
      onClose={() => close(false)}
      title={req.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant={req.danger ? 'danger' : 'primary'} disabled={blocked} onClick={() => close(true)} data-autofocus>
            {req.confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      {req.body && <div className="text-sm text-muted">{req.body}</div>}
      {req.typeToConfirm && (
        <label className="mt-4 block">
          <span className="label">{t('common.typeToConfirm', { text: req.typeToConfirm })}</span>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
      )}
    </Modal>
  );
}
