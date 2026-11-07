import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RotateCcw, Save, Search } from 'lucide-react';
import { serversApi } from '@/api';
import { useT } from '@/i18n';
import { toast } from '@/stores/toast';
import { Button, ErrorState, Loading, Toggle } from '@/components/ui';
import { useServerCtx } from './ServerLayout';

const ENUMS: Record<string, string[]> = {
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
  'level-type': ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified', 'minecraft:single_biome_surface'],
};

export default function Properties() {
  const t = useT();
  const { server } = useServerCtx();
  const qc = useQueryClient();
  const key = ['servers', server.id, 'properties'];
  const q = useQuery({ queryKey: key, queryFn: () => serversApi.properties(server.id) });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [newKey, setNewKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (q.data) setDraft(Object.fromEntries(Object.entries(q.data).map(([k, v]) => [k, String(v ?? '')])));
  }, [q.data]);

  const dirtyKeys = useMemo(() => {
    const orig = q.data ?? {};
    const keys = new Set([...Object.keys(orig), ...Object.keys(draft)]);
    return [...keys].filter((k) => String(orig[k] ?? '') !== (draft[k] ?? ''));
  }, [q.data, draft]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  const f = filter.toLowerCase();
  const keys = Object.keys(draft)
    .filter((k) => !f || k.includes(f) || draft[k].toLowerCase().includes(f))
    .sort();

  const save = async () => {
    setSaving(true);
    try {
      await serversApi.saveProperties(server.id, draft);
      await qc.invalidateQueries({ queryKey: key });
      toast.success(server.status === 'running' ? t('properties.savedRestart') : t('properties.saved'));
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="sticky top-14 z-10 -mx-4 flex flex-wrap items-center gap-2 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur sm:mx-0 sm:rounded-md sm:border sm:px-3 lg:top-0">
        <label className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input className="input h-9 pl-9" placeholder={t('properties.search')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        {dirtyKeys.length > 0 && <span className="text-sm text-warn">{t('properties.unsaved', { n: dirtyKeys.length })}</span>}
        <Button size="sm" variant="ghost" disabled={!dirtyKeys.length} onClick={() => q.data && setDraft({ ...q.data })} icon={<RotateCcw className="h-4 w-4" />}>
          {t('common.reset')}
        </Button>
        <Button size="sm" variant="primary" disabled={!dirtyKeys.length} loading={saving} onClick={() => void save()} icon={<Save className="h-4 w-4" />}>
          {t('common.save')}
        </Button>
      </div>

      <div className="panel divide-y divide-line">
        {keys.map((k) => {
          const v = draft[k];
          const isBool = v === 'true' || v === 'false';
          const dirty = dirtyKeys.includes(k);
          return (
            <div key={k} className="grid items-center gap-1 px-4 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:gap-4">
              <label htmlFor={`p-${k}`} className="truncate font-mono text-[13px]">
                {dirty && <span className="mr-1.5 text-warn">●</span>}
                {k}
              </label>
              {isBool ? (
                <Toggle checked={v === 'true'} onChange={(b) => setDraft({ ...draft, [k]: String(b) })} />
              ) : ENUMS[k] ? (
                <select id={`p-${k}`} className="input h-9 py-0" value={v} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}>
                  {!ENUMS[k].includes(v) && <option value={v}>{v}</option>}
                  {ENUMS[k].map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input id={`p-${k}`} className="input h-9 font-mono text-[13px]" value={v} inputMode={/^\d+$/.test(v) ? 'numeric' : undefined} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
              )}
            </div>
          );
        })}
        {keys.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted">{t('properties.none')}</p>}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const k = newKey.trim();
          if (k && !(k in draft)) setDraft({ ...draft, [k]: '' });
          setNewKey('');
        }}
      >
        <input className="input max-w-xs font-mono" placeholder={t('properties.newKey')} value={newKey} onChange={(e) => setNewKey(e.target.value)} />
        <Button type="submit" icon={<Plus className="h-4 w-4" />}>
          {t('common.add')}
        </Button>
      </form>
    </div>
  );
}
