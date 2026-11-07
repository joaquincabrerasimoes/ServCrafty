import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { startAuthentication } from '@simplewebauthn/browser';
import { Fingerprint, KeyRound, ShieldCheck } from 'lucide-react';
import { authApi, errorMessage } from '@/api';
import { useAuth } from '@/stores/auth';
import { useT } from '@/i18n';
import { Button, Field } from '@/components/ui';
import { LocaleSelect, ThemeSwitch } from '@/components/PrefsControls';

type Step = { kind: 'password' } | { kind: 'mfa'; methods: Array<'totp' | 'passkey'> };

export default function LoginPage() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const status = useAuth((s) => s.status);
  const setUser = useAuth((s) => s.setUser);
  const refresh = useAuth((s) => s.refresh);

  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? '/';

  useEffect(() => setError(null), [step.kind]);

  if (status === 'authenticated') return <Navigate to={from} replace />;

  const finish = async (user?: Parameters<typeof setUser>[0]) => {
    if (user) setUser(user);
    await refresh();
    navigate(from, { replace: true });
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onPassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await authApi.login(username.trim(), password);
      if (r.status === 'ok') await finish(r.user);
      else setStep({ kind: 'mfa', methods: r.methods?.length ? r.methods : ['totp'] });
    });
  };

  const onTotp = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await authApi.totp(code.replace(/\s/g, ''));
      await finish(r.user);
    });
  };

  const onPasskey = () =>
    run(async () => {
      const options = await authApi.passkeyOptions();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await startAuthentication({ optionsJSON: options as any });
      const r = await authApi.passkeyVerify(response);
      await finish(r.user);
    });

  return (
    <div className="flex min-h-full flex-col bg-bg">
      <div className="flex justify-end gap-2 p-4">
        <ThemeSwitch />
        <LocaleSelect className="w-auto" />
      </div>
      <div className="flex flex-1 items-start justify-center px-4 pb-16 pt-6 sm:items-center sm:pt-0">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3">
            <img src="/favicon.svg" alt="" className="h-12 w-12" />
            <div>
              <div className="font-display text-3xl font-bold leading-none tracking-tight">ServCrafty</div>
              <div className="mt-1 text-sm text-muted">{t('login.tagline')}</div>
            </div>
          </div>

          <div className="gui-frame !p-6">
            {step.kind === 'password' ? (
              <form onSubmit={onPassword} className="space-y-4">
                <h1 className="text-xl font-semibold">{t('login.title')}</h1>
                <Field label={t('login.username')}>
                  <input className="input" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />
                </Field>
                <Field label={t('login.password')}>
                  <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </Field>
                {error && <p className="text-sm text-danger">{error}</p>}
                <Button type="submit" variant="primary" className="w-full" loading={busy} icon={<KeyRound className="h-4 w-4" />}>
                  {t('login.submit')}
                </Button>
              </form>
            ) : (
              <div className="space-y-5">
                <div>
                  <h1 className="flex items-center gap-2 text-xl font-semibold">
                    <ShieldCheck className="h-5 w-5 text-accent" />
                    {t('login.mfaTitle')}
                  </h1>
                  <p className="mt-1 text-sm text-muted">{t('login.mfaBody')}</p>
                </div>
                {step.methods.includes('passkey') && (
                  <Button variant={step.methods.includes('totp') ? 'secondary' : 'primary'} className="w-full" onClick={() => void onPasskey()} loading={busy} icon={<Fingerprint className="h-4 w-4" />}>
                    {t('login.usePasskey')}
                  </Button>
                )}
                {step.methods.includes('passkey') && step.methods.includes('totp') && (
                  <div className="flex items-center gap-3 text-xs text-muted">
                    <span className="h-px flex-1 bg-line" />
                    {t('login.or')}
                    <span className="h-px flex-1 bg-line" />
                  </div>
                )}
                {step.methods.includes('totp') && (
                  <form onSubmit={onTotp} className="space-y-4">
                    <Field label={t('login.totpCode')}>
                      <input
                        className="input text-center font-mono text-lg tracking-[0.4em]"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        autoFocus
                        maxLength={7}
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
                        required
                      />
                    </Field>
                    <Button type="submit" variant="primary" className="w-full" loading={busy}>
                      {t('login.verify')}
                    </Button>
                  </form>
                )}
                {error && <p className="text-sm text-danger">{error}</p>}
                <button className="text-sm text-muted underline-offset-2 hover:underline" onClick={() => setStep({ kind: 'password' })}>
                  {t('login.back')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
