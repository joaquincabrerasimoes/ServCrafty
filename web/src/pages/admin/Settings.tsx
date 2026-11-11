import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Save } from 'lucide-react';
import { adminApi } from '@/api';
import type { AdminSettings as Settings } from '@/api/types';
import { useT } from '@/i18n';
import { formatMb, formatNumber } from '@/lib/format';
import { toast } from '@/stores/toast';
import { Badge, Button, ErrorState, Field, Loading, PageHeader, Section } from '@/components/ui';

type LimitKey = 'maxServers' | 'maxRamMb' | 'maxCpu' | 'maxDiskMb';
const LIMIT_FIELDS: Array<{ key: LimitKey; label: 'quota.servers' | 'quota.ram' | 'quota.cpu' | 'quota.disk'; unit: string; step: number; min: number }> = [
  { key: 'maxServers', label: 'quota.servers', unit: '', step: 1, min: 1 },
  { key: 'maxRamMb', label: 'quota.ram', unit: 'MB', step: 256, min: 256 },
  { key: 'maxCpu', label: 'quota.cpu', unit: '', step: 0.5, min: 0.1 },
  { key: 'maxDiskMb', label: 'quota.disk', unit: 'MB', step: 1024, min: 1 },
];

const POOL_RE = /^\s*\d{1,5}(\s*-\s*\d{1,5})?(\s*,\s*\d{1,5}(\s*-\s*\d{1,5})?)*\s*$/;

export default function AdminSettings() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: adminApi.settings });
  const [form, setForm] = useState<Partial<Settings>>({});
  const [cfKey, setCfKey] = useState('');
  const [steamKey, setSteamKey] = useState('');
  const [limits, setLimits] = useState<Record<LimitKey, string>>({ maxServers: '', maxRamMb: '', maxCpu: '', maxDiskMb: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    setForm({ portPool: q.data.portPool, defaultJavaArgs: q.data.defaultJavaArgs ?? '', publicUrl: q.data.publicUrl ?? '', publicServersHost: q.data.publicServersHost ?? '', bluemapDbHost: q.data.bluemapDbHost ?? '', lanNetworks: q.data.lanNetworks ?? '' });
    const g = q.data.globalLimits;
    const s = (v: number | null | undefined) => (v == null ? '' : String(v));
    setLimits({ maxServers: s(g?.maxServers), maxRamMb: s(g?.maxRamMb), maxCpu: s(g?.maxCpu), maxDiskMb: s(g?.maxDiskMb) });
  }, [q.data]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  const poolOk = POOL_RE.test(form.portPool ?? '');
  const limitValue = (k: LimitKey) => (limits[k].trim() === '' ? null : Number(limits[k]));
  const limitOk = (f: (typeof LIMIT_FIELDS)[number]) => {
    const v = limitValue(f.key);
    return v === null || (Number.isFinite(v) && v >= f.min && (f.key === 'maxCpu' || Number.isInteger(v)));
  };
  const limitsOk = LIMIT_FIELDS.every(limitOk);
  const usage = q.data?.hostUsage;
  const usageOf = (k: LimitKey) => (!usage ? null : k === 'maxServers' ? usage.servers : k === 'maxRamMb' ? usage.ram_mb : k === 'maxCpu' ? usage.cpu : usage.disk_mb);
  const fmtOf = (k: LimitKey) => (k === 'maxServers' ? formatNumber : k === 'maxCpu' ? (n: number) => formatNumber(n, 1) : formatMb);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Partial<Settings> = {
        ...form,
        globalLimits: { maxServers: limitValue('maxServers'), maxRamMb: limitValue('maxRamMb'), maxCpu: limitValue('maxCpu'), maxDiskMb: limitValue('maxDiskMb') },
      };
      if (cfKey.trim()) body.curseforgeKey = cfKey.trim();
      if (steamKey.trim()) body.steamApiKey = steamKey.trim();
      await adminApi.saveSettings(body);
      setCfKey('');
      setSteamKey('');
      await qc.invalidateQueries({ queryKey: ['admin-settings'] });
      toast.success(t('admin.settingsSaved'));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('admin.settingsTitle')} />
      <form onSubmit={save} className="max-w-3xl space-y-4">
        <Section title={t('admin.network')}>
          <div className="space-y-4">
            <Field label={t('admin.portPool')} hint={t('admin.portPoolHint')} error={!poolOk ? t('admin.portPoolInvalid') : null}>
              <input className="input font-mono" value={form.portPool ?? ''} onChange={(e) => setForm({ ...form, portPool: e.target.value })} placeholder="25565-25600,25700" />
            </Field>
            <Field label={t('admin.publicUrl')} hint={t('admin.publicUrlHint')}>
              <input className="input font-mono" value={form.publicUrl ?? ''} onChange={(e) => setForm({ ...form, publicUrl: e.target.value })} placeholder="https://craft.example.com" />
            </Field>
            <Field label={t('admin.publicServersHost')} hint={t('admin.publicServersHostHint')}>
              <input className="input font-mono" value={form.publicServersHost ?? ''} onChange={(e) => setForm({ ...form, publicServersHost: e.target.value })} placeholder="play.example.com" autoCapitalize="none" spellCheck={false} />
            </Field>
          </div>
        </Section>
        <Section title="BlueMap" description={t('admin.bluemapBody')}>
          <Field label={t('admin.bluemapDbHost')} hint={t('admin.bluemapDbHostHint')}>
            <input className="input font-mono" value={form.bluemapDbHost ?? ''} onChange={(e) => setForm({ ...form, bluemapDbHost: e.target.value })} placeholder="192.168.69.10:5432" autoCapitalize="none" spellCheck={false} />
          </Field>
        </Section>
        <Section title={t('admin.lanOnly')} description={t('admin.lanOnlyBody')} actions={form.lanNetworks?.trim() ? <Badge tone="ok"><Check className="h-3 w-3" />{t('admin.lanOnlyOn')}</Badge> : <Badge tone="warn">{t('admin.lanOnlyOff')}</Badge>}>
          <Field label={t('admin.lanNetworks')} hint={t('admin.lanNetworksHint')}>
            <textarea className="input min-h-[4.5rem] font-mono" spellCheck={false} value={form.lanNetworks ?? ''} onChange={(e) => setForm({ ...form, lanNetworks: e.target.value })} placeholder={'192.168.69.0/24\n192.168.69.0 255.255.255.0'} />
          </Field>
        </Section>
        <Section title={t('admin.hostLimits')} description={t('admin.hostLimitsHint')}>
          <div className="grid gap-4 sm:grid-cols-2">
            {LIMIT_FIELDS.map((f) => {
              const used = usageOf(f.key);
              const cap = limitValue(f.key);
              return (
                <Field
                  key={f.key}
                  label={f.unit ? `${t(f.label)} (${f.unit})` : t(f.label)}
                  error={!limitOk(f) ? (f.key === 'maxRamMb' ? t('admin.hostMinRam') : `≥ ${f.min}`) : null}
                  hint={
                    used === null
                      ? undefined
                      : `${t('admin.hostUsed', { used: fmtOf(f.key)(used) })}${cap !== null && used > cap ? ` · ${t('admin.hostOver')}` : ''}`
                  }
                >
                  <input
                    className="input"
                    type="number"
                    min={f.min}
                    step={f.step}
                    placeholder="∞"
                    value={limits[f.key]}
                    onChange={(e) => setLimits({ ...limits, [f.key]: e.target.value })}
                  />
                </Field>
              );
            })}
          </div>
        </Section>
        <Section title="CurseForge" description={t('admin.cfBody')} actions={q.data?.curseforgeKeySet ? <Badge tone="ok"><Check className="h-3 w-3" />{t('admin.cfSet')}</Badge> : <Badge tone="warn">{t('admin.cfMissing')}</Badge>}>
          <Field label={t('admin.cfKey')} hint={t('admin.cfKeyHint')}>
            <input className="input font-mono" type="password" autoComplete="off" value={cfKey} onChange={(e) => setCfKey(e.target.value)} placeholder={q.data?.curseforgeKeySet ? '••••••••' : ''} />
          </Field>
        </Section>
        <Section
          title="Steam"
          description={t('admin.steamBody')}
          actions={q.data?.steamKeySet ? <Badge tone="ok"><Check className="h-3 w-3" />{t('admin.cfSet')}</Badge> : <Badge tone="warn">{t('admin.cfMissing')}</Badge>}
        >
          <Field
            label={t('admin.steamKey')}
            hint={
              <>
                {t('admin.steamKeyHint')}{' '}
                <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer" className="text-accent underline">
                  steamcommunity.com/dev/apikey
                </a>
              </>
            }
          >
            <input className="input font-mono" type="password" autoComplete="off" value={steamKey} onChange={(e) => setSteamKey(e.target.value)} placeholder={q.data?.steamKeySet ? '••••••••' : ''} />
          </Field>
        </Section>
        <Section title={t('admin.defaults')}>
          <Field label={t('admin.defaultJavaArgs')}>
            <input className="input font-mono text-[13px]" value={form.defaultJavaArgs ?? ''} onChange={(e) => setForm({ ...form, defaultJavaArgs: e.target.value })} />
          </Field>
        </Section>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={busy} disabled={!poolOk || !limitsOk} icon={<Save className="h-4 w-4" />}>
            {t('common.saveChanges')}
          </Button>
        </div>
      </form>
    </>
  );
}
