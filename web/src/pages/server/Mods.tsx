import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, Download, Package, RefreshCw, Trash2 } from 'lucide-react';
import { serversApi } from '@/api';
import type { CatalogProject, ServerType } from '@/api/types';
import { useT } from '@/i18n';
import { formatBytes } from '@/lib/format';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Button, EmptyState, ErrorState, IconButton, Loading, Section } from '@/components/ui';
import { CatalogSearch } from '@/components/CatalogSearch';
import { useServerCtx } from './ServerLayout';

const PLUGIN_TYPES: ServerType[] = ['PAPER', 'PURPUR', 'FOLIA'];
const MOD_TYPES: ServerType[] = ['FABRIC', 'QUILT', 'FORGE', 'NEOFORGE', 'CURSEFORGE', 'MODRINTH'];

export default function Mods() {
  const t = useT();
  const { server } = useServerCtx();
  const qc = useQueryClient();
  const [installing, setInstalling] = useState<string | null>(null);
  const [checkUpdates, setCheckUpdates] = useState(false);

  const isPlugin = PLUGIN_TYPES.includes(server.type);
  const supported = isPlugin || MOD_TYPES.includes(server.type);
  const loader = isPlugin ? server.type.toLowerCase() : ['FABRIC', 'QUILT', 'FORGE', 'NEOFORGE'].includes(server.type) ? server.type.toLowerCase() : undefined;
  const mcVersion = /^\d/.test(server.mcVersion) ? server.mcVersion : undefined;

  const mods = useQuery({ queryKey: ['servers', server.id, 'mods'], queryFn: () => serversApi.mods(server.id), enabled: supported });
  const updates = useQuery({ queryKey: ['servers', server.id, 'mod-updates'], queryFn: () => serversApi.modUpdates(server.id), enabled: supported && checkUpdates });

  if (!supported) return <div className="panel"><EmptyState icon={<Package className="h-10 w-10" />} title={t('mods.unsupported')} body={t('mods.unsupportedBody')} /></div>;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['servers', server.id, 'mods'] });
    void qc.invalidateQueries({ queryKey: ['servers', server.id, 'mod-updates'] });
  };

  const install = async (p: { source: CatalogProject['source']; id: string; name?: string }, fileId?: string, replace?: string) => {
    setInstalling(p.id + (fileId ?? ''));
    try {
      const r = await serversApi.installMod(server.id, p.source, p.id, fileId, replace);
      const extra = Math.max(0, (r?.installed?.length ?? 1) - 1);
      toast.success(t('mods.installed', { name: p.name ?? p.id }) + (extra ? ' ' + t('mods.withDeps', { n: extra }) : ''));
      if (r?.skipped?.length) toast.info(t('mods.skippedDeps', { list: r.skipped.map((x) => x.reason).join('; ') }));
      refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setInstalling(null);
    }
  };

  const remove = async (file: string) => {
    if (!(await confirm({ title: t('mods.removeTitle', { name: file }), danger: true, confirmLabel: t('common.delete') }))) return;
    try {
      await serversApi.deleteMod(server.id, file);
      refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <div className="space-y-4">
        <Section
          title={isPlugin ? t('mods.installedPlugins') : t('mods.installedMods')}
          actions={
            <>
              <Button size="sm" onClick={() => (checkUpdates ? void updates.refetch() : setCheckUpdates(true))} loading={updates.isFetching} icon={<RefreshCw className="h-4 w-4" />}>
                {t('mods.checkUpdates')}
              </Button>
            </>
          }
        >
          {updates.data && updates.data.length > 0 && (
            <div className="mb-4 rounded-md border border-accent/30 bg-accent/5 p-3">
              <h3 className="mb-2 text-sm font-semibold">{t('mods.updatesAvailable', { n: updates.data.length })}</h3>
              <ul className="space-y-1.5">
                {updates.data.map((u) => (
                  <li key={u.file} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">
                      {u.name ?? u.file}{' '}
                      <span className="text-muted">
                        {u.currentVersion} → {u.latestVersion}
                      </span>
                    </span>
                    {u.source && u.projectId && (
                      <Button size="sm" variant="primary" loading={installing === u.projectId + (u.fileId ?? '')} onClick={() => void install({ source: u.source!, id: u.projectId!, name: u.name }, u.fileId, u.file)} icon={<ArrowUpCircle className="h-4 w-4" />}>
                        {t('mods.update')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {updates.data && updates.data.length === 0 && <p className="mb-3 text-sm text-ok">{t('mods.upToDate')}</p>}
          {updates.error && <ErrorState error={updates.error} />}
          {mods.isLoading ? (
            <Loading />
          ) : mods.error ? (
            <ErrorState error={mods.error} onRetry={() => void mods.refetch()} />
          ) : !mods.data?.length ? (
            <p className="py-6 text-center text-sm text-muted">{t('mods.none')}</p>
          ) : (
            <ul className="-my-2 divide-y divide-line">
              {mods.data.map((m) => (
                <li key={m.file} className="flex items-center gap-3 py-2">
                  <Package className="h-4 w-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{m.name ?? m.file}</div>
                    <div className="truncate font-mono text-xs text-muted">
                      {m.name ? m.file : ''} {m.size ? formatBytes(m.size) : ''}
                    </div>
                  </div>
                  <IconButton label={t('common.delete')} className="hover:text-danger" onClick={() => void remove(m.file)}>
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      <Section title={isPlugin ? t('mods.browsePlugins') : t('mods.browseMods')} description={mcVersion ? t('mods.filtered', { version: mcVersion, loader: loader ?? '' }) : undefined}>
        <CatalogSearch
          kind={isPlugin ? 'plugin' : 'mod'}
          mcVersion={mcVersion}
          loader={loader}
          onSelect={() => undefined}
          renderAction={(p) => (
            <Button size="sm" loading={installing === p.id} onClick={() => void install(p)} icon={<Download className="h-4 w-4" />}>
              {t('mods.install')}
            </Button>
          )}
        />
      </Section>
    </div>
  );
}
