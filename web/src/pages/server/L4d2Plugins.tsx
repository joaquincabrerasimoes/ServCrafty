import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, ExternalLink, Puzzle, RefreshCw, Save, Trash2, Users } from 'lucide-react';
import { l4d2Api, l4d2Keys } from '@/api';
import type { L4dPlugin, L4dPluginCategory, L4dSettingValue } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { formatDate } from '@/lib/format';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, EmptyState, ErrorState, Loading, Section, Toggle, WarnBanner } from '@/components/ui';
import { Note } from '../create/TerrariaConfigStep';
import { useServerCtx } from './ServerLayout';

const CATEGORIES: L4dPluginCategory[] = ['base', 'slots', 'library'];

function PluginSettingsForm({ serverId, plugin, disabled }: { serverId: string; plugin: L4dPlugin; disabled: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const initial = useMemo(() => Object.fromEntries(plugin.settings.map((s) => [s.key, s.type === 'boolean' ? s.value === true : String(s.value)])), [plugin.settings]);
  const [vals, setVals] = useState<Record<string, string | boolean>>(initial);
  const [saving, setSaving] = useState(false);
  const errors: Record<string, string> = {};
  for (const s of plugin.settings) {
    if (s.type !== 'number') continue;
    const raw = String(vals[s.key] ?? '');
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) errors[s.key] = t('l4d2.plugins.numberInvalid');
    else if ((s.min !== undefined && n < s.min) || (s.max !== undefined && n > s.max))
      errors[s.key] = t('mc.rangeHint', { min: s.min ?? '–', max: s.max ?? '–' });
  }
  const dirty = plugin.settings.some((s) => String(vals[s.key]) !== String(initial[s.key]));
  const invalid = Object.keys(errors).length > 0;

  const save = async () => {
    const settings: Record<string, L4dSettingValue> = {};
    for (const s of plugin.settings) settings[s.key] = s.type === 'boolean' ? vals[s.key] === true : Number(vals[s.key]);
    setSaving(true);
    try {
      const r = await l4d2Api.pluginSettings(serverId, plugin.id, settings);
      toast.success(r?.appliedLive ? t('l4d2.plugins.settingsLive', { name: plugin.name }) : t('l4d2.plugins.settingsSaved', { name: plugin.name }));
      void qc.invalidateQueries({ queryKey: l4d2Keys.plugins(serverId) });
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-3 border-t border-line pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid && dirty) void save();
      }}
    >
      <h4 className="text-sm font-semibold">{t('l4d2.plugins.settings')}</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        {plugin.settings.map((s) =>
          s.type === 'boolean' ? (
            <div key={s.key} className="sm:col-span-2">
              <Toggle checked={vals[s.key] === true} onChange={(v) => setVals((f) => ({ ...f, [s.key]: v }))} label={s.label} disabled={disabled || saving} />
              {s.description && <p className="hint">{s.description}</p>}
            </div>
          ) : (
            <label key={s.key} className="block min-w-0">
              <span className="label">{s.label}</span>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={s.min}
                max={s.max}
                value={String(vals[s.key] ?? '')}
                disabled={disabled || saving}
                aria-invalid={!!errors[s.key]}
                onChange={(e) => setVals((f) => ({ ...f, [s.key]: e.target.value }))}
              />
              {errors[s.key] ? <span className="mt-1 block text-xs text-danger">{errors[s.key]}</span> : s.description ? <span className="hint block">{s.description}</span> : null}
            </label>
          ),
        )}
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="primary" loading={saving} disabled={disabled || invalid || !dirty} icon={<Save className="h-4 w-4" />}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

function PluginCard({
  plugin,
  names,
  serverId,
  busy,
  canInstall,
  onInstall,
  onRemove,
}: {
  plugin: L4dPlugin;
  names: (ids: string[]) => string;
  serverId: string;
  /** The plugin operation running right now (one at a time per server). */
  busy: { id: string; kind: 'install' | 'remove' } | null;
  canInstall: boolean;
  onInstall: (p: L4dPlugin) => void;
  onRemove: (p: L4dPlugin) => void;
}) {
  const t = useT();
  const inst = plugin.installed;
  const mine = busy?.id === plugin.id;
  return (
    <li className="panel flex min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">{plugin.name}</h3>
          {plugin.homepage && (
            <a href={plugin.homepage} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
              {t('l4d2.plugins.homepage')}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          )}
        </div>
        {inst && (
          <Badge tone="ok">
            <Check className="h-3 w-3" aria-hidden="true" />
            {inst.version ? t('l4d2.plugins.installedVersion', { version: inst.version }) : t('workshop.installed')}
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted">{plugin.description}</p>
      <div className="space-y-1 text-xs text-muted">
        {inst && <p>{t('l4d2.plugins.installedAt', { date: formatDate(inst.installedAt), n: inst.files })}</p>}
        {plugin.requires.length > 0 && (
          <p>
            {t('l4d2.plugins.requires')}{' '}
            {plugin.requires.map((r, i) => {
              const missing = plugin.missingRequires.includes(r);
              return (
                <span key={r}>
                  {i > 0 && ', '}
                  <span className={missing ? 'font-medium text-warn' : undefined}>
                    {names([r])}
                    {missing && ` (${t('l4d2.plugins.missing')})`}
                  </span>
                </span>
              );
            })}
          </p>
        )}
        {plugin.requiredBy.length > 0 && <p>{t('l4d2.plugins.requiredBy', { list: names(plugin.requiredBy) })}</p>}
      </div>
      {mine && busy.kind === 'install' && <p className="text-xs text-muted">{t('l4d2.plugins.installing')}</p>}
      <div className="mt-auto flex flex-wrap justify-end gap-2">
        {inst && (
          <Button size="sm" variant="ghost" className="h-10 text-danger" loading={mine && busy.kind === 'remove'} disabled={!!busy || !canInstall} onClick={() => onRemove(plugin)} icon={<Trash2 className="h-4 w-4" />}>
            {t('common.remove')}
          </Button>
        )}
        <Button
          size="sm"
          variant={inst ? 'secondary' : 'primary'}
          className="h-10"
          loading={mine && busy.kind === 'install'}
          disabled={!!busy || !canInstall}
          onClick={() => onInstall(plugin)}
          icon={inst ? <RefreshCw className="h-4 w-4" /> : <Download className="h-4 w-4" />}
        >
          {inst ? t('l4d2.plugins.update') : t('l4d2.plugins.install')}
        </Button>
      </div>
      {inst && plugin.settings.length > 0 && <PluginSettingsForm key={inst.installedAt} serverId={serverId} plugin={plugin} disabled={!!busy} />}
    </li>
  );
}

export default function L4d2Plugins() {
  const t = useT();
  const qc = useQueryClient();
  const { server } = useServerCtx();
  const q = useQuery({ queryKey: l4d2Keys.plugins(server.id), queryFn: () => l4d2Api.plugins(server.id) });
  const [busy, setBusy] = useState<{ id: string; kind: 'install' | 'remove' } | null>(null);
  const [restart, setRestart] = useState(false);
  const plugins = q.data?.plugins ?? [];
  const names = (ids: string[]) => ids.map((id) => plugins.find((p) => p.id === id)?.name ?? id).join(', ');

  const install = async (p: L4dPlugin) => {
    if (p.missingRequires.length) {
      const ok = await confirm({
        title: t('l4d2.plugins.installTitle', { name: p.name }),
        body: t('l4d2.plugins.willAlsoInstall', { list: names(p.missingRequires) }),
        confirmLabel: t('l4d2.plugins.install'),
      });
      if (!ok) return;
    }
    setBusy({ id: p.id, kind: 'install' });
    try {
      const r = await l4d2Api.installPlugin(server.id, p.id);
      const done = r?.installed?.length ? r.installed : [p.id];
      toast.success(p.installed ? t('l4d2.plugins.updated', { name: p.name }) : t('l4d2.plugins.installedToast', { list: names(done) }));
      if (r?.restartRequired) setRestart(true);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: l4d2Keys.plugins(server.id) });
    }
  };

  const remove = async (p: L4dPlugin) => {
    const ok = await confirm({ title: t('l4d2.plugins.removeTitle', { name: p.name }), body: t('l4d2.plugins.removeBody'), danger: true, confirmLabel: t('common.remove') });
    if (!ok) return;
    setBusy({ id: p.id, kind: 'remove' });
    try {
      const r = await l4d2Api.removePlugin(server.id, p.id);
      toast.success(t('l4d2.plugins.removed', { name: p.name }));
      if (r?.restartRequired) setRestart(true);
    } catch (e) {
      // 409 plugin_required: the API message names the plugins that need it.
      toast.error(e);
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: l4d2Keys.plugins(server.id) });
    }
  };

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error ?? new Error(t('l4d2.loadFailed'))} onRetry={() => void q.refetch()} />;
  const gameInstalled = q.data.gameInstalled;

  return (
    <div className="space-y-4">
      <Note>{t('l4d2.plugins.intro')}</Note>
      {!gameInstalled && <WarnBanner title={t('l4d2.notInstalledTitle')}>{t('l4d2.plugins.notInstalled')}</WarnBanner>}
      {restart && <WarnBanner title={t('l4d2.plugins.restartTitle')}>{t('l4d2.plugins.restartBody')}</WarnBanner>}
      {plugins.length === 0 ? (
        <EmptyState icon={<Puzzle className="h-10 w-10" />} title={t('l4d2.plugins.empty')} />
      ) : (
        CATEGORIES.map((cat) => {
          const list = plugins.filter((p) => p.category === cat);
          if (!list.length) return null;
          return (
            <Section key={cat} title={t(`l4d2.plugins.cat.${cat}` as TKey)} description={t(`l4d2.plugins.catBody.${cat}` as TKey)}>
              {cat === 'slots' && (
                <p className="mb-4 flex gap-2 rounded-block border border-accent/30 bg-accent/5 px-3 py-2 text-sm">
                  <Users className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                  <span>{t('l4d2.plugins.slotsHelp')}</span>
                </p>
              )}
              <ul className="grid gap-3 lg:grid-cols-2">
                {list.map((p) => (
                  <PluginCard key={p.id} plugin={p} names={names} serverId={server.id} busy={busy} canInstall={gameInstalled} onInstall={(x) => void install(x)} onRemove={(x) => void remove(x)} />
                ))}
              </ul>
            </Section>
          );
        })
      )}
    </div>
  );
}
