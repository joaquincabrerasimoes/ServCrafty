import { useState } from 'react';
import { Download, Eraser, Search, WrapText } from 'lucide-react';
import { useT } from '@/i18n';
import { canOperate } from '@/lib/access';
import { serverCaps } from '@/lib/games';
import { consoleAllowed } from '@/lib/gameDefs';
import { sendCommand } from '@/lib/sendCommand';
import { useLogs } from '@/lib/useFallbacks';
import { clearLogs } from '@/ws/live';
import { CommandInput, LogView, cleanLine } from '@/components/LogView';
import { IconButton } from '@/components/ui';
import { useServerCtx } from './ServerLayout';

export default function Console() {
  const t = useT();
  const { server, live, def } = useServerCtx();
  const stdin = !serverCaps(server).hasSteamConfig || consoleAllowed(def);
  const logs = useLogs(server.id, live, 500);
  const [filter, setFilter] = useState('');
  const [wrap, setWrap] = useState(true);
  const op = canOperate(server.access);

  const download = () => {
    const blob = new Blob([logs.map((l) => cleanLine(l.text)).join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${server.name}-${new Date().toISOString().slice(0, 19)}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex h-[calc(100dvh-15rem)] min-h-[24rem] flex-col gap-2 lg:h-[calc(100dvh-16rem)]">
      <div className="flex items-center gap-2">
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input className="input h-9 pl-9" placeholder={t('console.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <IconButton label={t('console.wrap')} onClick={() => setWrap(!wrap)} className={wrap ? 'text-accent' : ''}>
          <WrapText className="h-4 w-4" />
        </IconButton>
        <IconButton label={t('console.download')} onClick={download}>
          <Download className="h-4 w-4" />
        </IconButton>
        <IconButton label={t('console.clear')} onClick={() => clearLogs(server.id)}>
          <Eraser className="h-4 w-4" />
        </IconButton>
      </div>
      <LogView lines={logs} filter={filter} wrap={wrap} className="min-h-0 flex-1" />
      {!stdin && <p className="text-xs text-muted">{t('steam.consoleNoStdinHint')}</p>}
      <CommandInput
        disabled={!op || !stdin || server.status !== 'running'}
        placeholder={!stdin ? t('steam.consoleNoStdin') : !op ? t('console.readOnly') : server.status !== 'running' ? t('console.notRunning') : undefined}
        onSend={(cmd) => sendCommand(server.id, cmd)}
      />
    </div>
  );
}
