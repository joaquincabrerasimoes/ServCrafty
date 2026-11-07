import { useRegisterSW } from 'virtual:pwa-register/react';
import { useT } from '@/i18n';
import { Button } from './ui';

/** Shows a small banner when the app has been cached for offline use or an update is ready. */
export function PwaPrompt() {
  const t = useT();
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (reg) setInterval(() => void reg.update(), 60 * 60 * 1000);
    },
  });
  if (!offlineReady && !needRefresh) return null;
  return (
    <div className="fixed bottom-20 left-4 z-[55] max-w-xs rounded-md border border-line bg-surface p-4 text-sm shadow-lg lg:bottom-6">
      <p>{needRefresh ? t('pwa.update') : t('pwa.ready')}</p>
      <div className="mt-3 flex gap-2">
        {needRefresh && (
          <Button size="sm" variant="primary" onClick={() => void updateServiceWorker(true)}>
            {t('pwa.reload')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOfflineReady(false);
            setNeedRefresh(false);
          }}
        >
          {t('common.close')}
        </Button>
      </div>
    </div>
  );
}
