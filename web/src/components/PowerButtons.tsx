import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Play, RotateCw, Skull, Square } from 'lucide-react';
import { serversApi } from '@/api';
import type { PowerAction, Server, ServerStatus } from '@/api/types';
import { useT } from '@/i18n';
import { toast } from '@/stores/toast';
import { Button } from './ui';
import { confirm } from './feedback';

export function PowerButtons({ server, status, compact }: { server: Server; status?: ServerStatus | null; compact?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<PowerAction | null>(null);
  const st = status ?? server.status;
  const running = st === 'running' || st === 'starting';
  const transitional = st === 'starting' || st === 'stopping' || st === 'installing';
  // An admin disabled this game and blocked starting it (409 game_disabled from the API).
  const blocked = server.gameBlocked === true;
  const blockedHint = blocked ? t('gameAccess.startBlocked') : undefined;

  const act = async (action: PowerAction) => {
    if (action === 'kill') {
      const ok = await confirm({ title: t('power.killTitle'), body: t('power.killBody'), danger: true, confirmLabel: t('power.kill') });
      if (!ok) return;
    }
    setBusy(action);
    try {
      await serversApi.power(server.id, action);
      toast.info(t(`power.sent.${action}`));
      void qc.invalidateQueries({ queryKey: ['servers'] });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const size = compact ? 'sm' : 'md';
  return (
    <div className="flex flex-wrap gap-2">
      {!running && st !== 'stopping' && (
        // A disabled button gets no pointer events, so the explanation lives on a wrapper.
        <span title={blockedHint} className="inline-flex">
          <Button
            size={size}
            variant="primary"
            loading={busy === 'start'}
            disabled={st === 'installing' || blocked}
            aria-label={blocked ? `${t('power.start')}: ${blockedHint}` : undefined}
            onClick={() => void act('start')}
            icon={<Play className="h-4 w-4" />}
          >
            {t('power.start')}
          </Button>
        </span>
      )}
      {(running || st === 'stopping') && (
        <>
          <span title={blockedHint} className="inline-flex">
            <Button
              size={size}
              loading={busy === 'restart'}
              disabled={transitional || blocked}
              aria-label={blocked ? `${t('power.restart')}: ${blockedHint}` : undefined}
              onClick={() => void act('restart')}
              icon={<RotateCw className="h-4 w-4" />}
            >
              {t('power.restart')}
            </Button>
          </span>
          <Button size={size} loading={busy === 'stop'} disabled={st === 'stopping'} onClick={() => void act('stop')} icon={<Square className="h-4 w-4" />}>
            {t('power.stop')}
          </Button>
        </>
      )}
      {st !== 'stopped' && (
        <Button size={size} variant="ghost" className="text-danger" loading={busy === 'kill'} onClick={() => void act('kill')} icon={<Skull className="h-4 w-4" />}>
          {compact ? null : t('power.kill')}
        </Button>
      )}
    </div>
  );
}
