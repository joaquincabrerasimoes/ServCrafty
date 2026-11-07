import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { startRegistration } from '@simplewebauthn/browser';
import { Check, Copy, Fingerprint, KeyRound, Plus, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import { accountApi, type ApiToken, type TotpSetup } from '@/api';
import { useT } from '@/i18n';
import { useAuth } from '@/stores/auth';
import { formatDate, formatMb, formatNumber, formatRelative } from '@/lib/format';
import { qk } from '@/lib/queries';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, ErrorState, Field, IconButton, Loading, Meter, Modal, PageHeader, Section } from '@/components/ui';
import { LocaleSelect, ThemeSwitch } from '@/components/PrefsControls';

function Profile() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const refresh = useAuth((s) => s.refresh);
  const [email, setEmail] = useState(user?.email ?? '');
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await accountApi.update({ email: email.trim() || null });
      await refresh();
      toast.success(t('account.saved'));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t('account.profile')}>
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('login.username')}>
            <input className="input" value={user?.username ?? ''} disabled />
          </Field>
          <Field label={t('account.email')}>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <div>
            <span className="label">{t('prefs.theme')}</span>
            <ThemeSwitch className="w-full" />
          </div>
          <div>
            <span className="label">{t('prefs.language')}</span>
            <LocaleSelect className="h-10 text-sm" />
          </div>
        </div>
        <Button type="submit" variant="primary" loading={busy}>
          {t('common.saveChanges')}
        </Button>
      </form>
    </Section>
  );
}

function Password() {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = again.length > 0 && next !== again;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    try {
      await accountApi.changePassword(current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      toast.success(t('account.passwordChanged'));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t('account.password')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('account.currentPassword')}>
          <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('account.newPassword')} hint={t('account.passwordHint')}>
            <input className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
          </Field>
          <Field label={t('account.repeatPassword')} error={mismatch ? t('account.mismatch') : null}>
            <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
          </Field>
        </div>
        <Button type="submit" variant="primary" loading={busy} disabled={mismatch || next.length < 8}>
          {t('account.changePassword')}
        </Button>
      </form>
    </Section>
  );
}

function Totp() {
  const t = useT();
  const mfa = useAuth((s) => s.mfa);
  const refresh = useAuth((s) => s.refresh);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      setSetup(await accountApi.totpSetup());
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await accountApi.totpEnable(code.replace(/\s/g, ''));
      setSetup(null);
      setCode('');
      await refresh();
      toast.success(t('account.totpEnabled'));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      await accountApi.totpDisable(password);
      setDisableOpen(false);
      setPassword('');
      await refresh();
      toast.success(t('account.totpDisabled'));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={t('account.totp')}
      description={t('account.totpBody')}
      actions={mfa?.totp ? <Badge tone="ok"><Check className="h-3 w-3" />{t('common.enabled')}</Badge> : <Badge>{t('common.disabled')}</Badge>}
    >
      {mfa?.totp ? (
        <Button onClick={() => setDisableOpen(true)} icon={<ShieldOff className="h-4 w-4" />}>
          {t('account.totpDisable')}
        </Button>
      ) : setup ? (
        <form onSubmit={enable} className="flex flex-col gap-5 sm:flex-row">
          <img src={setup.qrDataUrl} alt={t('account.qrAlt')} className="h-44 w-44 shrink-0 rounded-block border border-line bg-white p-2" />
          <div className="min-w-0 flex-1 space-y-3">
            <p className="text-sm text-muted">{t('account.totpScan')}</p>
            <code className="block break-all rounded-block bg-raised px-2 py-1.5 font-mono text-xs">{setup.secret}</code>
            <Field label={t('login.totpCode')}>
              <input className="input max-w-[12rem] font-mono tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" loading={busy}>
                {t('account.totpConfirm')}
              </Button>
              <Button variant="ghost" onClick={() => setSetup(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <Button variant="primary" loading={busy} onClick={() => void start()} icon={<ShieldCheck className="h-4 w-4" />}>
          {t('account.totpSetup')}
        </Button>
      )}
      <Modal
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        title={t('account.totpDisable')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDisableOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" loading={busy} disabled={!password} onClick={() => void disable()}>
              {t('account.totpDisable')}
            </Button>
          </>
        }
      >
        <Field label={t('account.currentPassword')}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </Modal>
    </Section>
  );
}

function Passkeys() {
  const t = useT();
  const qc = useQueryClient();
  const refresh = useAuth((s) => s.refresh);
  const q = useQuery({ queryKey: ['passkeys'], queryFn: accountApi.passkeys });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== 'undefined' && !!window.PublicKeyCredential;

  const add = async () => {
    setBusy(true);
    try {
      const options = await accountApi.passkeyOptions();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await startRegistration({ optionsJSON: options as any });
      await accountApi.passkeyVerify(response, name.trim() || t('account.passkeyDefaultName'));
      setName('');
      void qc.invalidateQueries({ queryKey: ['passkeys'] });
      void refresh();
      toast.success(t('account.passkeyAdded'));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, label: string) => {
    if (!(await confirm({ title: t('account.passkeyDeleteTitle', { name: label }), danger: true, confirmLabel: t('common.delete') }))) return;
    try {
      await accountApi.deletePasskey(id);
      void qc.invalidateQueries({ queryKey: ['passkeys'] });
      void refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Section title={t('account.passkeys')} description={t('account.passkeysBody')}>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data?.length ? (
        <ul className="mb-4 divide-y divide-line rounded-block border border-line">
          {q.data.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2">
              <Fingerprint className="h-4 w-4 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.name || t('account.passkeyDefaultName')}</div>
                <div className="text-xs text-muted">
                  {t('account.added', { when: formatDate(p.createdAt) })}
                  {p.lastUsedAt ? ` · ${t('account.lastUsed', { when: formatRelative(p.lastUsedAt) })}` : ''}
                </div>
              </div>
              <IconButton label={t('common.delete')} className="hover:text-danger" onClick={() => void remove(p.id, p.name ?? '')}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-sm text-muted">{t('account.noPasskeys')}</p>
      )}
      {supported ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className="input sm:max-w-xs" placeholder={t('account.passkeyName')} value={name} onChange={(e) => setName(e.target.value)} />
          <Button variant="primary" loading={busy} onClick={() => void add()} icon={<Plus className="h-4 w-4" />}>
            {t('account.addPasskey')}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-warn">{t('account.passkeyUnsupported')}</p>
      )}
    </Section>
  );
}

function Tokens() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tokens'], queryFn: accountApi.tokens });
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('');
  const [created, setCreated] = useState<ApiToken | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const tok = await accountApi.createToken(name.trim(), expires ? new Date(expires).toISOString() : undefined);
      setCreated(tok);
      setName('');
      setExpires('');
      void qc.invalidateQueries({ queryKey: ['tokens'] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (tok: ApiToken) => {
    if (!(await confirm({ title: t('account.revokeTitle', { name: tok.name }), danger: true, confirmLabel: t('account.revoke') }))) return;
    try {
      await accountApi.deleteToken(tok.id);
      void qc.invalidateQueries({ queryKey: ['tokens'] });
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Section title={t('account.tokens')} description={t('account.tokensBody')}>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data?.length ? (
        <div className="mb-4 overflow-x-auto rounded-block border border-line">
          <table className="table">
            <thead>
              <tr>
                <th>{t('account.tokenName')}</th>
                <th className="hidden sm:table-cell">{t('account.prefix')}</th>
                <th className="hidden md:table-cell">{t('account.lastUsedCol')}</th>
                <th className="hidden md:table-cell">{t('account.expires')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((tok) => (
                <tr key={tok.id}>
                  <td className="font-medium">{tok.name}</td>
                  <td className="hidden font-mono text-xs sm:table-cell">{tok.prefix ? `${tok.prefix}…` : ''}</td>
                  <td className="hidden text-muted md:table-cell">{tok.lastUsedAt ? formatRelative(tok.lastUsedAt) : t('account.never')}</td>
                  <td className="hidden text-muted md:table-cell">{tok.expiresAt ? formatDate(tok.expiresAt) : t('account.never')}</td>
                  <td className="text-right">
                    <IconButton label={t('account.revoke')} className="hover:text-danger" onClick={() => void revoke(tok)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mb-4 text-sm text-muted">{t('account.noTokens')}</p>
      )}
      <form onSubmit={create} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label={t('account.tokenName')} className="flex-1">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} />
        </Field>
        <Field label={t('account.expires')} className="sm:w-48">
          <input className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" loading={busy} icon={<KeyRound className="h-4 w-4" />}>
          {t('account.createToken')}
        </Button>
      </form>
      <Modal
        open={!!created}
        onClose={() => setCreated(null)}
        title={t('account.tokenCreated')}
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            {t('common.done')}
          </Button>
        }
      >
        <p className="mb-3 text-sm text-muted">{t('account.tokenOnce')}</p>
        <div className="flex gap-2">
          <code className="min-w-0 flex-1 break-all rounded-block bg-raised px-3 py-2 font-mono text-sm">{created?.token}</code>
          <IconButton
            label={t('common.copy')}
            className="h-10 w-10"
            onClick={() => {
              void navigator.clipboard?.writeText(created?.token ?? '');
              toast.info(t('common.copied'));
            }}
          >
            <Copy className="h-4 w-4" />
          </IconButton>
        </div>
      </Modal>
    </Section>
  );
}

function Quota() {
  const t = useT();
  const q = useQuery({ queryKey: qk.quota, queryFn: accountApi.quota });
  if (!q.data) return null;
  const { limits, usage } = q.data;
  const rows = [
    { label: t('quota.servers'), used: usage.servers, max: limits.maxServers, fmt: (n: number) => formatNumber(n) },
    { label: t('quota.ram'), used: usage.ram_mb, max: limits.maxRamMb, fmt: formatMb },
    { label: t('quota.cpu'), used: usage.cpu, max: limits.maxCpu, fmt: (n: number) => formatNumber(n, 1) },
    { label: t('quota.disk'), used: usage.disk_mb, max: limits.maxDiskMb, fmt: formatMb },
  ];
  return (
    <Section title={t('account.quota')}>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="mb-1 flex justify-between text-sm">
              <span>{r.label}</span>
              <span className="tabular-nums text-muted">
                {r.fmt(r.used)} / {r.max == null ? t('wizard.unlimited') : r.fmt(r.max)}
              </span>
            </div>
            {r.max ? <Meter value={r.used} max={r.max} tone={r.used / r.max > 0.9 ? 'warn' : 'accent'} /> : null}
          </div>
        ))}
      </div>
    </Section>
  );
}

export default function Account() {
  const t = useT();
  const refresh = useAuth((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <>
      <PageHeader title={t('account.title')} />
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <Profile />
          <Password />
          <Quota />
        </div>
        <div className="space-y-4">
          <Totp />
          <Passkeys />
          <Tokens />
        </div>
      </div>
    </>
  );
}
