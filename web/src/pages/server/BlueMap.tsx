import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, DatabaseZap, Globe, MapPin, Map as MapIcon, RefreshCw, Trash2 } from 'lucide-react';
import { serversApi } from '@/api';
import type { BluemapMarker, BluemapPublicLink, BluemapStatus } from '@/api/types';
import { useT } from '@/i18n';
import { canManage, canOperate } from '@/lib/access';
import { formatBytes } from '@/lib/format';
import { qk } from '@/lib/queries';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, EmptyState, ErrorState, Field, Loading, Section } from '@/components/ui';
import { WebFrame } from '@/components/WebFrame';
import { useIsAdmin } from '@/stores/auth';
import { useServerCtx } from './ServerLayout';

/**
 * BlueMap (SPEC "BlueMap (v0.4.0)"): enable it for a Java server, then view the 3D map through the panel's
 * authenticated proxy. The rendered map lives in a PostgreSQL schema of its own for this server.
 */
export default function BlueMap() {
  const t = useT();
  const { server } = useServerCtx();
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const manage = canManage(server.access);
  const key = ['servers', server.id, 'bluemap'];
  const q = useQuery({ queryKey: key, queryFn: () => serversApi.bluemap(server.id), enabled: !!server.bluemap?.supported });
  const [accepted, setAccepted] = useState(false);
  const [restartNote, setRestartNote] = useState(false);
  const running = server.status === 'running';

  const refresh = (status?: BluemapStatus) => {
    if (status) qc.setQueryData(key, status);
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: qk.server(server.id) });
  };
  const toggle = useMutation({
    mutationFn: (body: { enabled: boolean; acceptDownload?: boolean; deleteData?: boolean }) => serversApi.setBluemap(server.id, body),
    onError: (err) => toast.error(err),
  });
  const reset = useMutation({ mutationFn: () => serversApi.resetBluemap(server.id), onError: (err) => toast.error(err) });

  if (!server.bluemap?.supported) {
    return <EmptyState icon={<MapIcon className="h-8 w-8" />} title={t('bluemap.notSupportedTitle')} body={t('bluemap.notSupportedBody')} />;
  }
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const st = q.data;

  if (!st.enabled) {
    if (!manage) return <EmptyState icon={<MapIcon className="h-8 w-8" />} title={t('bluemap.title')} body={t('bluemap.viewerOff')} />;
    const kind = t(st.kind === 'mod' ? 'bluemap.kind.mod' : 'bluemap.kind.plugin');
    return (
      <div className="max-w-3xl space-y-4">
        <Section title={t('bluemap.title')} description={t('bluemap.intro')}>
          <ul className="list-disc space-y-1 ps-5 text-sm text-muted">
            <li>{t('bluemap.point1', { kind })}</li>
            <li>{t('bluemap.point2')}</li>
            <li>{t('bluemap.point3')}</li>
          </ul>
          {st.dbIssue && (
            <div role="alert" className="mt-4 flex gap-3 rounded-md border border-warn/40 bg-warn/5 px-4 py-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
              <div>
                <p>{st.dbIssue === 'loopback' ? t('bluemap.dbLoopback') : t('bluemap.dbInvalid')}</p>
                {isAdmin && (
                  <Link to="/admin/settings" className="mt-1 inline-block text-accent underline">
                    {t('bluemap.dbSettings')}
                  </Link>
                )}
              </div>
            </div>
          )}
          {st.dataBytes !== null && <p className="mt-4 text-sm text-muted">{t('bluemap.data')}: {t('bluemap.dataValue', { size: formatBytes(st.dataBytes), tables: st.tables ?? 0 })}</p>}
          <label className="mt-4 flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            <span>{t('bluemap.eula')}</span>
          </label>
          <div className="mt-4 flex justify-end">
            <Button
              variant="primary"
              loading={toggle.isPending}
              disabled={!accepted || !!st.dbIssue}
              icon={<MapIcon className="h-4 w-4" />}
              onClick={() =>
                toggle.mutate(
                  { enabled: true, acceptDownload: true },
                  {
                    onSuccess: (s) => {
                      setRestartNote(running);
                      toast.success(running ? t('bluemap.enabledRestart') : t('bluemap.enabledStart'));
                      refresh(s);
                    },
                  },
                )
              }
            >
              {t('bluemap.enable')}
            </Button>
          </div>
        </Section>
      </div>
    );
  }

  const stopped = server.status === 'stopped' || server.status === 'crashed';
  const disable = async (deleteData: boolean) => {
    const ok = await confirm({
      title: t(deleteData ? 'bluemap.deleteTitle' : 'bluemap.disableTitle'),
      body: t(deleteData ? 'bluemap.deleteBody' : 'bluemap.disableBody'),
      confirmLabel: t(deleteData ? 'bluemap.deleteData' : 'bluemap.disable'),
      danger: deleteData,
    });
    if (!ok) return;
    toggle.mutate(
      { enabled: false, deleteData },
      {
        onSuccess: (s) => {
          setRestartNote(running);
          toast.success(t(deleteData ? 'bluemap.deleted' : 'bluemap.disabled'));
          refresh(s);
        },
      },
    );
  };
  const rerender = async () => {
    const ok = await confirm({ title: t('bluemap.resetTitle'), body: t('bluemap.resetBody'), confirmLabel: t('bluemap.reset'), danger: true });
    if (!ok) return;
    reset.mutate(undefined, {
      onSuccess: (s) => {
        toast.success(t('bluemap.resetDone'));
        refresh(s);
      },
    });
  };

  return (
    <div className="space-y-4">
      {restartNote && running && (
        <p role="status" className="rounded-md border border-line bg-raised px-4 py-2 text-sm">
          {t('bluemap.restartNeeded')}
        </p>
      )}
      <WebFrame
        src={st.url ?? `/api/servers/${encodeURIComponent(server.id)}/webui/bluemap/`}
        label={t('bluemap.title')}
        frameTitle={t('bluemap.frameTitle', { server: server.name })}
        running={running}
        retryMs={5000}
        notRunning={{ title: t('bluemap.notRunningTitle'), body: t('bluemap.notRunningBody') }}
        unreachable={{ title: t('bluemap.startingTitle'), body: t('bluemap.startingBody') }}
      />
      <MarkersList />
      {(server.access === 'owner' || server.access === 'admin') && <PublicLinks onChange={() => refresh()} />}
      {manage && (
        <Section title={t('bluemap.manage')}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm text-muted">
              <DatabaseZap className="h-4 w-4" aria-hidden="true" />
              {t('bluemap.data')}: {st.dataBytes === null || !st.tables ? t('bluemap.dataNone') : t('bluemap.dataValue', { size: formatBytes(st.dataBytes), tables: st.tables })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void rerender()} disabled={!stopped} loading={reset.isPending} title={stopped ? undefined : t('bluemap.stopFirst')} icon={<RefreshCw className="h-4 w-4" />}>
                {t('bluemap.reset')}
              </Button>
              <Button size="sm" onClick={() => void disable(false)} loading={toggle.isPending}>
                {t('bluemap.disable')}
              </Button>
              <Button size="sm" variant="danger" onClick={() => void disable(true)} disabled={!stopped} title={stopped ? undefined : t('bluemap.stopFirst')} icon={<Trash2 className="h-4 w-4" />}>
                {t('bluemap.deleteData')}
              </Button>
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}

const absolute = (url: string) => (url.startsWith('/') ? `${window.location.origin}${url}` : url);

/** Public links: anyone with a URL views the live map without signing in; a link may also be allowed to edit markers. */
function PublicLinks({ onChange }: { onChange: () => void }) {
  const t = useT();
  const { server } = useServerCtx();
  const qc = useQueryClient();
  const key = ['servers', server.id, 'bluemap', 'links'];
  const q = useQuery({ queryKey: key, queryFn: () => serversApi.bluemapLinks(server.id) });
  const [name, setName] = useState('');
  const [canEdit, setCanEdit] = useState(false);
  const done = () => {
    void qc.invalidateQueries({ queryKey: key });
    onChange();
  };
  const create = useMutation({
    mutationFn: () => serversApi.createBluemapLink(server.id, { name: name.trim(), canEdit }),
    onSuccess: () => {
      setName('');
      setCanEdit(false);
      done();
    },
    onError: (err) => toast.error(err),
  });
  const update = useMutation({
    mutationFn: (v: { id: string; body: { name?: string; canEdit?: boolean; regenerate?: boolean } }) => serversApi.updateBluemapLink(server.id, v.id, v.body),
    onSuccess: done,
    onError: (err) => toast.error(err),
  });
  const remove = useMutation({
    mutationFn: (id: string) => serversApi.deleteBluemapLink(server.id, id),
    onSuccess: done,
    onError: (err) => toast.error(err),
  });
  const copy = (l: BluemapPublicLink) => {
    if (!l.url) return;
    navigator.clipboard.writeText(absolute(l.url)).then(
      () => toast.success(t('bluemap.publicCopied')),
      () => toast.error(t('bluemap.publicCopyFailed')),
    );
  };
  const regenerate = async (l: BluemapPublicLink) => {
    const ok = await confirm({ title: t('bluemap.publicRegenTitle'), body: t('bluemap.publicRegenBody'), confirmLabel: t('bluemap.publicRegen'), danger: true });
    if (ok) update.mutate({ id: l.id, body: { regenerate: true } });
  };
  const del = async (l: BluemapPublicLink) => {
    const ok = await confirm({ title: t('bluemap.linkDeleteTitle', { name: l.name }), body: t('bluemap.linkDeleteBody'), confirmLabel: t('common.delete'), danger: true });
    if (ok) remove.mutate(l.id);
  };
  const links = q.data?.links ?? [];
  return (
    <Section title={t('bluemap.publicTitle')} description={t('bluemap.publicDescription')}>
      <div className="space-y-4">
        {links.length > 0 && (
          <ul className="space-y-3">
            {links.map((l) => (
              <li key={l.id} className="space-y-2 rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{l.name}</span>
                  <Badge tone={l.canEdit ? 'warn' : 'neutral'}>{t(l.canEdit ? 'bluemap.linkCanEdit' : 'bluemap.linkViewOnly')}</Badge>
                </div>
                {l.url && (
                  <div className="flex items-center gap-2">
                    <input readOnly className="input font-mono text-xs" value={absolute(l.url)} onFocus={(e) => e.currentTarget.select()} aria-label={l.name} />
                    <Button size="sm" onClick={() => copy(l)} icon={<Copy className="h-4 w-4" />}>
                      {t('common.copy')}
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => update.mutate({ id: l.id, body: { canEdit: !l.canEdit } })} loading={update.isPending}>
                    {t(l.canEdit ? 'bluemap.linkMakeViewOnly' : 'bluemap.linkAllowEdit')}
                  </Button>
                  <Button size="sm" onClick={() => void regenerate(l)} loading={update.isPending} icon={<RefreshCw className="h-4 w-4" />}>
                    {t('bluemap.publicRegen')}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void del(l)} loading={remove.isPending} icon={<Trash2 className="h-4 w-4" />}>
                    {t('common.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Field label={t('bluemap.linkName')}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t('bluemap.linkNamePlaceholder')} />
          </Field>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1" checked={canEdit} onChange={(e) => setCanEdit(e.target.checked)} />
            <span>{t('bluemap.linkEditOption')}</span>
          </label>
          <p className="flex items-start gap-2 text-sm text-muted">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {t(canEdit ? 'bluemap.publicWarningEdit' : 'bluemap.publicWarning')}
          </p>
          <Button type="submit" variant="primary" disabled={!name.trim()} loading={create.isPending} icon={<Globe className="h-4 w-4" />}>
            {t('bluemap.publicOn')}
          </Button>
        </form>
      </div>
    </Section>
  );
}

/** The markers of this server (added from the pin button on the map, or through the API); operators can delete them. */
function MarkersList() {
  const t = useT();
  const { server } = useServerCtx();
  const qc = useQueryClient();
  const operate = canOperate(server.access);
  const key = ['servers', server.id, 'bluemap', 'markers'];
  const q = useQuery({ queryKey: key, queryFn: () => serversApi.bluemapMarkers(server.id), refetchInterval: 20_000 });
  const sets = useQuery({ queryKey: [...key, 'sets'], queryFn: () => serversApi.bluemapMarkerSets(server.id) });
  const remove = useMutation({
    mutationFn: (id: string) => serversApi.deleteBluemapMarker(server.id, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (err) => toast.error(err),
  });
  const markers = q.data?.markers ?? [];
  const setName = (m: BluemapMarker) => sets.data?.sets.find((x) => x.id === m.setId);
  const who = (m: BluemapMarker) => (m.createdBy.startsWith('link:') ? t('bluemap.markerByLink') : t('bluemap.markerByUser'));
  const del = async (m: BluemapMarker) => {
    const ok = await confirm({ title: t('bluemap.markerDeleteTitle', { name: m.label }), body: t('bluemap.markerDeleteBody'), confirmLabel: t('common.delete'), danger: true });
    if (ok) remove.mutate(m.id);
  };
  return (
    <Section title={t('bluemap.markersTitle')} description={operate ? t('bluemap.markersHelp') : undefined}>
      {markers.length === 0 ? (
        <p className="text-sm text-muted">{t('bluemap.markersNone')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {markers.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-2">
              <MapPin className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.label}</p>
                <p className="truncate text-xs text-muted">
                  {[t(`bluemap.markerType.${m.type}`), setName(m) ? `${setName(m)!.label} (${setName(m)!.mapId})` : null, m.position ? `${Math.round(m.position.x)}, ${Math.round(m.position.y)}, ${Math.round(m.position.z)}` : null, who(m)]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              {operate && (
                <Button size="sm" variant="danger" onClick={() => void del(m)} loading={remove.isPending} aria-label={`${t('common.delete')}: ${m.label}`} icon={<Trash2 className="h-4 w-4" />} />
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
