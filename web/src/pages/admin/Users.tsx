import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gamepad2, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { usersApi, type UpdateUserBody } from '@/api';
import type { Quotas, Role, User } from '@/api/types';
import { useT } from '@/i18n';
import { useAuth } from '@/stores/auth';
import { formatMb, formatNumber, formatDate } from '@/lib/format';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, ErrorState, Field, IconButton, Loading, Modal, PageHeader, Toggle } from '@/components/ui';
import { UserGamesDialog } from './UserGamesDialog';

type Draft = {
  id?: string;
  username: string;
  password: string;
  email: string;
  role: Role;
  disabled: boolean;
  resetMfa: boolean;
  canAuthorGames: boolean;
  quotas: Record<keyof Quotas, string>;
};

const q2s = (v: number | null | undefined) => (v == null ? '' : String(v));
const s2q = (v: string) => (v.trim() === '' ? null : Number(v));

function toDraft(u?: User): Draft {
  return {
    id: u?.id,
    username: u?.username ?? '',
    password: '',
    email: u?.email ?? '',
    role: u?.role ?? 'user',
    disabled: u?.disabled ?? false,
    resetMfa: false,
    canAuthorGames: u?.canAuthorGames ?? false,
    quotas: { maxServers: q2s(u?.maxServers), maxRamMb: q2s(u?.maxRamMb), maxCpu: q2s(u?.maxCpu), maxDiskMb: q2s(u?.maxDiskMb) },
  };
}

export default function Users() {
  const t = useT();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const q = useQuery({ queryKey: ['users'], queryFn: usersApi.list });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [gamesFor, setGamesFor] = useState<User | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    const quotas: Quotas = {
      maxServers: s2q(draft.quotas.maxServers),
      maxRamMb: s2q(draft.quotas.maxRamMb),
      maxCpu: s2q(draft.quotas.maxCpu),
      maxDiskMb: s2q(draft.quotas.maxDiskMb),
    };
    try {
      if (draft.id) {
        const body: UpdateUserBody = { role: draft.role, disabled: draft.disabled, quotas };
        if (draft.password) body.password = draft.password;
        if (draft.resetMfa) body.resetMfa = true;
        if (draft.role === 'user') body.canAuthorGames = draft.canAuthorGames;
        await usersApi.update(draft.id, body);
      } else {
        await usersApi.create({ username: draft.username.trim(), password: draft.password, email: draft.email.trim() || undefined, role: draft.role, quotas });
      }
      setDraft(null);
      void refresh();
      toast.success(t('users.saved'));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (u: User) => {
    const ok = await confirm({ title: t('users.deleteTitle', { name: u.username }), body: t('users.deleteBody'), danger: true, typeToConfirm: u.username, confirmLabel: t('common.delete') });
    if (!ok) return;
    try {
      await usersApi.remove(u.id);
      void refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  const quota = (v: number | null | undefined, fmt: (n: number) => string) => (v == null ? '∞' : fmt(v));

  return (
    <>
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        actions={
          <Button variant="primary" onClick={() => setDraft(toDraft())} icon={<Plus className="h-4 w-4" />}>
            {t('users.create')}
          </Button>
        }
      />
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('login.username')}</th>
                <th>{t('users.role')}</th>
                <th>{t('gameAccess.col')}</th>
                <th className="hidden md:table-cell">{t('users.quotas')}</th>
                <th className="hidden lg:table-cell">{t('users.created')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data?.map((u) => (
                <tr key={u.id} className={u.disabled ? 'opacity-60' : ''}>
                  <td>
                    <div className="flex items-center gap-2 font-medium">
                      {u.username}
                      {u.totpEnabled && <ShieldCheck className="h-3.5 w-3.5 text-ok" aria-label="2FA" />}
                      {u.disabled && <Badge tone="danger">{t('common.disabled')}</Badge>}
                      {u.role !== 'admin' && u.canAuthorGames && <Badge>{t('users.gameAuthor')}</Badge>}
                    </div>
                    {u.email && <div className="text-xs text-muted">{u.email}</div>}
                  </td>
                  <td>
                    <Badge tone={u.role === 'admin' ? 'accent' : 'neutral'}>{t(`role.${u.role}`)}</Badge>
                  </td>
                  <td className="whitespace-nowrap text-xs">
                    {u.role === 'admin' || u.allowedGames === null ? (
                      <span className="text-muted">{t('gameAccess.unrestricted')}</span>
                    ) : u.allowedGames === undefined ? (
                      <span className="text-muted">–</span>
                    ) : u.allowedGames.length ? (
                      <span title={u.allowedGames.join(', ')}>{u.allowedGames.length === 1 ? t('gameAccess.summaryOne') : t('gameAccess.summary', { n: u.allowedGames.length })}</span>
                    ) : (
                      <span className="text-warn">{t('gameAccess.summaryNone')}</span>
                    )}
                  </td>
                  <td className="hidden text-xs text-muted md:table-cell">
                    {quota(u.maxServers, (n) => formatNumber(n))} {t('quota.serversShort')} · {quota(u.maxRamMb, formatMb)} · {quota(u.maxCpu, (n) => formatNumber(n, 1))} CPU ·{' '}
                    {quota(u.maxDiskMb, formatMb)}
                  </td>
                  <td className="hidden text-muted lg:table-cell">{formatDate(u.createdAt)}</td>
                  <td>
                    <div className="flex justify-end">
                      <IconButton label={t('gameAccess.action', { name: u.username })} onClick={() => setGamesFor(u)}>
                        <Gamepad2 className="h-4 w-4" />
                      </IconButton>
                      <IconButton label={t('common.edit')} onClick={() => setDraft(toDraft(u))}>
                        <Pencil className="h-4 w-4" />
                      </IconButton>
                      {u.id !== me?.id && (
                        <IconButton label={t('common.delete')} className="hover:text-danger" onClick={() => void remove(u)}>
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.id ? t('users.edit', { name: draft.username }) : t('users.create')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} disabled={!draft || (!draft.id && (!draft.username.trim() || draft.password.length < 8))} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-4">
            {!draft.id && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('login.username')}>
                  <input className="input" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} autoComplete="off" />
                </Field>
                <Field label={t('account.email')}>
                  <input className="input" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
                </Field>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={draft.id ? t('users.resetPassword') : t('login.password')} hint={draft.id ? t('users.resetPasswordHint') : t('account.passwordHint')}>
                <input className="input" type="password" autoComplete="new-password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
              </Field>
              <Field label={t('users.role')}>
                <select className="input" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })} disabled={draft.id === me?.id}>
                  <option value="user">{t('role.user')}</option>
                  <option value="admin">{t('role.admin')}</option>
                </select>
              </Field>
            </div>
            <fieldset>
              <legend className="label">{t('users.quotas')}</legend>
              <p className="hint -mt-1 mb-2">{t('users.quotasHint')}</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(
                  [
                    ['maxServers', t('quota.servers')],
                    ['maxRamMb', t('quota.ram') + ' (MB)'],
                    ['maxCpu', t('quota.cpu')],
                    ['maxDiskMb', t('quota.disk') + ' (MB)'],
                  ] as Array<[keyof Quotas, string]>
                ).map(([k, label]) => (
                  <Field key={k} label={<span className="text-xs">{label}</span>}>
                    <input className="input" type="number" min={0} step={k === 'maxCpu' ? 0.5 : 1} placeholder="∞" value={draft.quotas[k]} onChange={(e) => setDraft({ ...draft, quotas: { ...draft.quotas, [k]: e.target.value } })} />
                  </Field>
                ))}
              </div>
            </fieldset>
            {draft.id && (
              <div>
                <Toggle
                  checked={draft.role === 'admin' || draft.canAuthorGames}
                  disabled={draft.role === 'admin'}
                  onChange={(v) => setDraft({ ...draft, canAuthorGames: v })}
                  label={t('users.canAuthorGames')}
                />
                <p className="hint">{draft.role === 'admin' ? t('users.canAuthorGamesAdmin') : t('users.canAuthorGamesHint')}</p>
              </div>
            )}
            {draft.id && draft.id !== me?.id && <Toggle checked={draft.disabled} onChange={(v) => setDraft({ ...draft, disabled: v })} label={t('users.disabled')} />}
            {draft.id && (
              <div>
                <Toggle checked={draft.resetMfa} onChange={(v) => setDraft({ ...draft, resetMfa: v })} label={t('users.resetMfa')} />
              </div>
            )}
          </div>
        )}
      </Modal>
      <UserGamesDialog user={gamesFor} onClose={() => setGamesFor(null)} />
    </>
  );
}
