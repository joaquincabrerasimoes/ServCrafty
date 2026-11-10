import { useMemo, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { serversApi } from '@/api';
import { ApiError } from '@/api/client';
import type { Server, TerrariaWorld } from '@/api/types';
import { useT } from '@/i18n';
import { formatBytes, formatRelative } from '@/lib/format';
import { qk } from '@/lib/queries';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, ErrorState, Loading, Meter, Section } from '@/components/ui';
import { WorldFilePicker } from '../create/TerrariaConfigStep';
import { validateWorldFiles } from '../create/terrariaForm';

export function useTerrariaWorlds(serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.serverSub(serverId, 'terraria-worlds'),
    queryFn: () => serversApi.terrariaWorlds(serverId),
    enabled,
  });
}

/** The API refuses to replace a world of the same name unless asked to. */
const isExistsError = (e: unknown) => e instanceof ApiError && e.code === 'world_exists';

/** Worlds on a Terraria server, and importing a .wld (plus .twld for tModLoader). */
export function TerrariaWorlds({ server, worlds }: { server: Server; worlds: UseQueryResult<TerrariaWorld[]> }) {
  const t = useT();
  const qc = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const fileError = useMemo(() => validateWorldFiles(files, server.type, t), [files, server.type, t]);
  const stopped = server.status === 'stopped' || server.status === 'crashed';
  const current = server.terraria?.worldFile;

  const upload = async (overwrite = false): Promise<void> => {
    setProgress(0);
    try {
      const r = await serversApi.uploadTerrariaWorld(server.id, files, overwrite, setProgress);
      setFiles([]);
      toast.success(t('tr.importedAs', { name: r?.worldName ?? files[0]?.name ?? '' }));
      void qc.invalidateQueries({ queryKey: qk.serverSub(server.id, 'terraria-worlds') });
      void qc.invalidateQueries({ queryKey: qk.server(server.id) });
    } catch (e) {
      if (!overwrite && isExistsError(e)) {
        setProgress(null);
        const ok = await confirm({ title: t('tr.overwriteTitle'), body: t('tr.overwriteBody'), danger: true, confirmLabel: t('tr.overwrite') });
        if (ok) await upload(true);
        return;
      }
      toast.error(e);
    } finally {
      setProgress(null);
    }
  };

  return (
    <Section title={t('tr.worlds')} description={t('tr.worldsBody')}>
      <div className="space-y-4">
        {worlds.isLoading ? (
          <Loading />
        ) : worlds.error ? (
          <ErrorState error={worlds.error} onRetry={() => void worlds.refetch()} />
        ) : !worlds.data?.length ? (
          <p className="text-sm text-muted">{t('tr.noWorlds')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {worlds.data.map((w) => (
              <li key={w.name} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-sm">{w.name}</span>
                  {current && (current === w.name || current.endsWith(`/${w.name}`)) && <Badge tone="accent">{t('tr.worldActive')}</Badge>}
                </span>
                <span className="text-xs text-muted">
                  {formatBytes(w.sizeBytes)} · {formatRelative(w.modifiedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-3 border-t border-line pt-4">
          <WorldFilePicker files={files} onChange={setFiles} type={server.type} error={fileError} disabled={progress !== null} />
          {!stopped && <p className="text-xs text-warn">{t('tr.importStopFirst')}</p>}
          {progress !== null && (
            <div className="space-y-1" aria-live="polite">
              <p className="text-sm">{t('tr.uploading', { pct: Math.round(progress * 100) })}</p>
              <Meter value={Math.round(progress * 100)} max={100} />
            </div>
          )}
          <Button
            onClick={() => void upload()}
            disabled={!files.length || !!fileError || !stopped}
            loading={progress !== null}
            icon={<Upload className="h-4 w-4" />}
          >
            {t('tr.importAction')}
          </Button>
        </div>
      </div>
    </Section>
  );
}
