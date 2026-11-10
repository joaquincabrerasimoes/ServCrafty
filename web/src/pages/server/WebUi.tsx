import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ExternalLink, MonitorOff, RotateCw } from 'lucide-react';
import { useT } from '@/i18n';
import { webuiFor } from '@/lib/gameDefs';
import { Button, Loading, Spinner, buttonClass } from '@/components/ui';
import { useServerCtx } from './ServerLayout';

type Check = 'checking' | 'ok' | 'unreachable' | 'error';

/**
 * A game's own web admin, served by the panel's authenticated reverse proxy
 * (`/api/servers/:id/webui/:uiId/`) inside an iframe. The proxy answers 502 webui_unreachable
 * while the game is not running; an iframe cannot report HTTP status, so the page is probed first.
 */
export default function WebUi() {
  const t = useT();
  const { uiId = '' } = useParams();
  const { server, def } = useServerCtx();
  const entry = webuiFor(def, server.access).find((w) => w.id === uiId);
  // The server JSON carries the ready-made URL (it redirects into a token-scoped proxy session);
  // otherwise the entry URL is the proxy base plus the entry's path. Never build tokenized URLs here.
  const path = entry?.path ? (entry.path.startsWith('/') ? entry.path : `/${entry.path}`) : '/';
  const src = server.steamGame?.webui?.find((w) => w.id === uiId)?.url || `/api/servers/${encodeURIComponent(server.id)}/webui/${encodeURIComponent(uiId)}${path}`;
  const running = server.status === 'running';
  const [check, setCheck] = useState<Check>('checking');
  const [message, setMessage] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);

  const probe = useCallback(
    async (signal?: AbortSignal) => {
      setCheck('checking');
      setLoaded(false);
      try {
        const res = await fetch(src, { credentials: 'same-origin', headers: { Accept: 'text/html,*/*' }, signal });
        void res.body?.cancel().catch(() => undefined);
        if (res.ok || (res.status >= 300 && res.status < 500 && res.status !== 403 && res.status !== 404)) setCheck('ok');
        else if (res.status === 502 || res.status === 504) setCheck('unreachable');
        else {
          setMessage(`HTTP ${res.status}`);
          setCheck('error');
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setMessage(t('webui.networkError'));
        setCheck('error');
      }
    },
    [src, t],
  );

  useEffect(() => {
    if (!running) return;
    const ctl = new AbortController();
    void probe(ctl.signal);
    return () => ctl.abort();
  }, [running, probe, nonce]);

  if (!def) return <Loading />;
  const label = entry?.label || uiId;
  const reload = () => setNonce((n) => n + 1);

  return (
    <div className="flex h-[calc(100dvh-16rem)] min-h-[26rem] flex-col gap-2 lg:h-[calc(100dvh-17rem)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-base font-semibold">{label}</h2>
        <div className="flex gap-2">
          <Button size="sm" onClick={reload} disabled={!running} icon={<RotateCw className="h-4 w-4" />}>
            {t('webui.reload')}
          </Button>
          <a href={src} target="_blank" rel="noopener" className={buttonClass('secondary', 'sm', !running ? 'pointer-events-none opacity-55' : undefined)} aria-disabled={!running}>
            <ExternalLink className="h-4 w-4" />
            {t('webui.newTab')}
          </a>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-line bg-surface">
        {!running || check === 'unreachable' || check === 'error' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <MonitorOff className="h-10 w-10 text-muted" aria-hidden="true" />
            <h3 className="text-lg font-semibold">{!running ? t('webui.notRunningTitle') : t('webui.unreachableTitle')}</h3>
            <p className="max-w-md text-sm text-muted">
              {!running ? t('webui.notRunningBody') : check === 'unreachable' ? t('webui.unreachableBody') : t('webui.errorBody', { error: message })}
            </p>
            {running && (
              <Button size="sm" onClick={reload} icon={<RotateCw className="h-4 w-4" />}>
                {t('common.retry')}
              </Button>
            )}
          </div>
        ) : (
          <>
            {check === 'ok' && (
              <iframe
                key={nonce}
                src={src}
                title={t('webui.frameTitle', { name: label, server: server.name })}
                className="h-full w-full border-0 bg-white"
                sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-downloads"
                referrerPolicy="same-origin"
                onLoad={() => setLoaded(true)}
              />
            )}
            {(check === 'checking' || !loaded) && (
              <div className="absolute inset-0 flex items-center justify-center gap-3 bg-surface/80 text-sm text-muted" aria-live="polite">
                <Spinner />
                {t('webui.loading')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
