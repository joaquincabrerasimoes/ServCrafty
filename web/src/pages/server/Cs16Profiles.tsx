import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileCode2, FileUp, Pencil, Play, Plus, Save, Star, StarOff, Trash2 } from 'lucide-react';
import { cs16Api, cs16Keys } from '@/api';
import { errorMessage } from '@/api/client';
import type { Cs16ProfileSummary, Cs16ProfilesOverview } from '@/api/types';
import { useT } from '@/i18n';
import { canManage } from '@/lib/access';
import { formatDate } from '@/lib/format';
import { isCs16 } from '@/lib/gameDefs';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, EmptyState, ErrorState, IconButton, Loading, Modal, Section } from '@/components/ui';
import { Note } from '../create/TerrariaConfigStep';
import { useServerCtx } from './ServerLayout';

const NAME_MAX = 60;
const CONTENT_MAX = 64 * 1024;

/** Lines the server sends to the console: not blank and not a `//` comment. */
const countCommands = (content: string) =>
  content.split(/\r?\n/).filter((l) => {
    const s = l.trim();
    return s !== '' && !s.startsWith('//');
  }).length;

const byteLength = (s: string) => new TextEncoder().encode(s).length;

function useRefreshProfiles(serverId: string) {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: cs16Keys.profiles(serverId) });
}

/* ---------------------------------------------------------------- Editor */

function ProfileEditor({ serverId, profileId, onClose }: { serverId: string; /** null = new profile */ profileId: string | null; onClose: () => void }) {
  const t = useT();
  const refresh = useRefreshProfiles(serverId);
  const detail = useQuery({
    queryKey: cs16Keys.profile(serverId, profileId ?? ''),
    queryFn: () => cs16Api.profile(serverId, profileId!),
    enabled: !!profileId,
    staleTime: 0,
    gcTime: 0,
  });
  const [name, setName] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Until the user types, show what the server has (or empty for a new profile).
  const nameVal = name ?? detail.data?.name ?? '';
  const contentVal = content ?? detail.data?.content ?? '';
  const commands = countCommands(contentVal);
  const tooBig = byteLength(contentVal) > CONTENT_MAX;
  const nameOk = nameVal.trim().length > 0 && nameVal.trim().length <= NAME_MAX;
  const loading = !!profileId && detail.isLoading;

  const importFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      setContent(text);
      if (!nameVal.trim()) setName(file.name.replace(/\.(cfg|txt)$/i, '').slice(0, NAME_MAX));
      setError(null);
    };
    reader.onerror = () => setError(t('cs16.profiles.importFailed'));
    reader.readAsText(file);
  };

  const save = async () => {
    if (!nameOk || tooBig) return;
    setSaving(true);
    setError(null);
    try {
      const body = { name: nameVal.trim(), content: contentVal };
      const r = profileId ? await cs16Api.updateProfile(serverId, profileId, body) : await cs16Api.createProfile(serverId, body);
      toast.success(t('cs16.profiles.saved', { name: r?.profile?.name ?? body.name }));
      refresh();
      onClose();
    } catch (e) {
      // 400 invalid_content / too_many_commands / line_too_long and 409 profile_name_taken carry a message.
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={saving ? () => undefined : onClose}
      title={profileId ? t('cs16.profiles.editTitle', { name: detail.data?.name ?? '' }) : t('cs16.profiles.newTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={saving} disabled={loading || !nameOk || tooBig || !!detail.error} onClick={() => void save()} icon={<Save className="h-4 w-4" />}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {loading ? (
        <Loading />
      ) : detail.error ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="block">
            <span className="label">{t('cs16.profiles.name')}</span>
            <input
              className="input"
              value={nameVal}
              maxLength={NAME_MAX}
              placeholder={t('cs16.profiles.namePlaceholder')}
              aria-invalid={!nameOk && name !== null}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div>
            <div className="mb-1.5 flex flex-wrap items-end justify-between gap-2">
              <label htmlFor="cs16-profile-content" className="label mb-0">
                {t('cs16.profiles.commands')}
              </label>
              <Button size="sm" className="h-10" onClick={() => fileRef.current?.click()} icon={<FileUp className="h-4 w-4" />}>
                {t('cs16.profiles.import')}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".cfg,.txt,text/plain"
                className="hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importFile(f);
                  e.target.value = '';
                }}
              />
            </div>
            <textarea
              id="cs16-profile-content"
              className="input min-h-[16rem] resize-y py-2 font-mono text-sm leading-relaxed"
              rows={14}
              value={contentVal}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              wrap="off"
              placeholder={'hostname "My server"\nmp_freezetime 15\n// comment\nsay "Config loaded"'}
              aria-invalid={tooBig}
              aria-describedby="cs16-profile-count"
              onChange={(e) => setContent(e.target.value)}
            />
            <p id="cs16-profile-count" className="mt-1 flex flex-wrap justify-between gap-2 text-xs" aria-live="polite">
              <span className="text-muted">{t('cs16.profiles.syntaxHint')}</span>
              <span className={tooBig ? 'font-medium text-danger' : 'text-muted'}>
                {tooBig ? t('cs16.profiles.tooBig') : t('cs16.profiles.commandCount', { n: commands })}
              </span>
            </p>
          </div>
          {error && (
            <p role="alert" className="rounded-block border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------------- Default profile */

function DefaultProfile({ serverId, data, manage }: { serverId: string; data: Cs16ProfilesOverview; manage: boolean }) {
  const t = useT();
  const refresh = useRefreshProfiles(serverId);
  const [id, setId] = useState<string>(data.defaultId ?? '');
  const [onMap, setOnMap] = useState(data.applyOnMapChange);
  const [saving, setSaving] = useState(false);
  const dirty = id !== (data.defaultId ?? '') || onMap !== data.applyOnMapChange;

  const save = async () => {
    setSaving(true);
    try {
      await cs16Api.setDefaultProfile(serverId, id || null, onMap);
      toast.success(t('cs16.profiles.defaultSaved'));
      refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={t('cs16.profiles.defaultTitle')} description={t('cs16.profiles.defaultBody')}>
      <div className="space-y-3">
        <label className="block max-w-md">
          <span className="label">{t('cs16.profiles.defaultLabel')}</span>
          <select className="input" value={id} disabled={!manage || saving} onChange={(e) => setId(e.target.value)}>
            <option value="">{t('cs16.profiles.none')}</option>
            {data.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div>
          <label className={manage ? 'flex min-h-10 cursor-pointer items-center gap-3 text-sm' : 'flex min-h-10 items-center gap-3 text-sm opacity-60'}>
            <input
              type="checkbox"
              className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]"
              checked={onMap}
              disabled={!manage || saving || !id}
              onChange={(e) => setOnMap(e.target.checked)}
            />
            {t('cs16.profiles.onMapChange')}
          </label>
          <p className="hint ps-8">{t('cs16.profiles.onMapChangeHint')}</p>
        </div>
        {manage ? (
          <div className="flex justify-end">
            <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()} icon={<Save className="h-4 w-4" />}>
              {t('common.save')}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted">{t('cs16.profiles.managersOnly')}</p>
        )}
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- List */

function ProfileRow({
  p,
  data,
  serverId,
  running,
  manage,
  onEdit,
}: {
  p: Cs16ProfileSummary;
  data: Cs16ProfilesOverview;
  serverId: string;
  running: boolean;
  manage: boolean;
  onEdit: () => void;
}) {
  const t = useT();
  const refresh = useRefreshProfiles(serverId);
  const [busy, setBusy] = useState<'run' | 'default' | 'delete' | null>(null);

  const run = async () => {
    setBusy('run');
    try {
      const r = await cs16Api.runProfile(serverId, p.id);
      toast.success(t('cs16.profiles.sent', { n: r?.sent ?? p.commands }));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const toggleDefault = async () => {
    setBusy('default');
    try {
      await cs16Api.setDefaultProfile(serverId, p.isDefault ? null : p.id, data.applyOnMapChange);
      toast.success(p.isDefault ? t('cs16.profiles.defaultCleared') : t('cs16.profiles.defaultSet', { name: p.name }));
      refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: t('cs16.profiles.deleteTitle', { name: p.name }),
      body: p.isDefault ? t('cs16.profiles.deleteDefaultBody') : t('cs16.profiles.deleteBody'),
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await cs16Api.deleteProfile(serverId, p.id);
      toast.success(t('cs16.profiles.deleted', { name: p.name }));
      refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="break-words font-medium">{p.name}</span>
          {p.isDefault && (
            <Badge tone="accent">
              <Star className="h-3 w-3" aria-hidden="true" />
              {t('cs16.profiles.defaultBadge')}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted">
          {t('cs16.profiles.commandCount', { n: p.commands })} · {t('workshop.updated', { date: formatDate(p.updatedAt) })}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button
          size="sm"
          variant="primary"
          className="h-10"
          loading={busy === 'run'}
          disabled={!running || (!!busy && busy !== 'run')}
          title={running ? undefined : t('cs16.profiles.runNeedsRunning')}
          onClick={() => void run()}
          icon={<Play className="h-4 w-4" />}
        >
          {t('cs16.profiles.run')}
        </Button>
        {manage && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-10"
              loading={busy === 'default'}
              disabled={!!busy && busy !== 'default'}
              onClick={() => void toggleDefault()}
              icon={p.isDefault ? <StarOff className="h-4 w-4" /> : <Star className="h-4 w-4" />}
            >
              {p.isDefault ? t('cs16.profiles.removeDefault') : t('cs16.profiles.setDefault')}
            </Button>
            <IconButton label={t('cs16.profiles.editTitle', { name: p.name })} className="h-10 w-10" disabled={!!busy} onClick={onEdit}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton label={t('cs16.profiles.deleteTitle', { name: p.name })} className="h-10 w-10 hover:text-danger" disabled={!!busy} onClick={() => void remove()}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </>
        )}
      </div>
    </li>
  );
}

/* ---------------------------------------------------------------- Page */

export default function Cs16Profiles() {
  const t = useT();
  const { server, def } = useServerCtx();
  const cs = isCs16(def);
  const q = useQuery({ queryKey: cs16Keys.profiles(server.id), queryFn: () => cs16Api.profiles(server.id), enabled: cs });
  const manage = canManage(server.access);
  const running = server.status === 'running';
  // undefined = closed, null = new profile, string = edit that profile.
  const [editing, setEditing] = useState<string | null | undefined>(undefined);

  if (!cs || q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error ?? new Error(t('l4d2.loadFailed'))} onRetry={() => void q.refetch()} />;
  const data = q.data;
  const newButton = manage ? (
    <Button variant="primary" onClick={() => setEditing(null)} icon={<Plus className="h-4 w-4" />}>
      {t('cs16.profiles.new')}
    </Button>
  ) : undefined;
  // Rebuild the default form when the saved values change.
  const defaultKey = `${data.defaultId ?? ''}|${data.applyOnMapChange}|${data.profiles.map((p) => p.id).join(',')}`;

  return (
    <div className="space-y-4">
      <Note>{t('cs16.profiles.intro')}</Note>
      {data.profiles.length > 0 && <DefaultProfile key={defaultKey} serverId={server.id} data={data} manage={manage} />}
      <Section title={t('cs16.profiles.listTitle', { n: data.profiles.length })} actions={data.profiles.length > 0 ? newButton : undefined}>
        {data.profiles.length === 0 ? (
          <EmptyState icon={<FileCode2 className="h-10 w-10" />} title={t('cs16.profiles.empty')} body={t('cs16.profiles.emptyBody')} action={newButton} />
        ) : (
          <>
            {!running && <p className="mb-2 text-sm text-muted">{t('cs16.profiles.runNeedsRunning')}</p>}
            <ul className="divide-y divide-line">
              {data.profiles.map((p) => (
                <ProfileRow key={p.id} p={p} data={data} serverId={server.id} running={running} manage={manage} onEdit={() => setEditing(p.id)} />
              ))}
            </ul>
          </>
        )}
      </Section>
      <p className="text-xs text-muted">{t('cs16.profiles.securityNote')}</p>
      {editing !== undefined && <ProfileEditor key={editing ?? 'new'} serverId={server.id} profileId={editing} onClose={() => setEditing(undefined)} />}
    </div>
  );
}
