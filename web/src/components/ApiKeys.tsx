import { useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Copy, KeyRound, Pencil, ShieldAlert, Trash2 } from 'lucide-react';
import { accountApi, type ApiScopeCatalog, type ApiScopeDef, type ApiToken, type Server } from '@/api';
import { useT } from '@/i18n';
import type { TKey } from '@/i18n';
import { formatDate, formatRelative } from '@/lib/format';
import { useServers } from '@/lib/queries';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Badge, Button, ErrorState, Field, IconButton, Loading, Modal, Section } from '@/components/ui';
import { DocsMenu } from '@/components/DocsMenu';

const riskTone = { low: 'neutral', medium: 'accent', high: 'warn', critical: 'danger' } as const;

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Preset a list of scopes corresponds to, or `custom`. */
function presetOf(scopes: string[], catalog: ApiScopeCatalog | undefined): string {
  if (scopes.includes('*')) return 'full';
  return catalog?.presets.find((p) => p.id !== 'full' && sameSet(p.scopes, scopes))?.id ?? 'custom';
}

/** Is a scope granted by the selection? (`X:write` grants `X:read`.) */
const granted = (sel: Set<string>, id: string) => {
  if (sel.has('*') || sel.has(id)) return true;
  const [res, action] = id.split(':');
  return action === 'read' && sel.has(`${res}:write`);
};

function KeyDialog({ existing, catalog, servers, onClose, onCreated }: { existing: ApiToken | null; catalog: ApiScopeCatalog; servers: Server[]; onClose: () => void; onCreated: (k: ApiToken) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(existing?.name ?? '');
  const [expires, setExpires] = useState('');
  const [scopes, setScopes] = useState<Set<string>>(new Set(existing?.scopes ?? catalog.presets.find((p) => p.id === 'read-only')?.scopes ?? []));
  const [limit, setLimit] = useState(!!existing?.serverIds);
  const [serverIds, setServerIds] = useState<Set<string>>(new Set(existing?.serverIds ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const full = scopes.has('*');
  const preset = presetOf([...scopes], catalog);
  const groups = useMemo(() => {
    const out: Array<{ group: string; items: ApiScopeDef[] }> = [];
    for (const s of catalog.scopes) {
      let g = out.find((x) => x.group === s.group);
      if (!g) out.push((g = { group: s.group, items: [] }));
      g.items.push(s);
    }
    return out;
  }, [catalog]);

  const toggleScope = (id: string) =>
    setScopes((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleServer = (id: string) =>
    setServerIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!scopes.size) {
      setError(t('apikey.pickOne'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), scopes: [...scopes], serverIds: limit ? [...serverIds] : null };
      if (existing) {
        await accountApi.updateToken(existing.id, body);
        toast.success(t('apikey.saved'));
        onClose();
      } else {
        const created = await accountApi.createToken({ ...body, ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}) });
        onCreated(created);
      }
      void qc.invalidateQueries({ queryKey: ['tokens'] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={existing ? t('apikey.editTitle', { name: existing.name }) : t('apikey.create')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={(e) => void submit(e as unknown as FormEvent)} icon={<KeyRound className="h-4 w-4" />}>
            {existing ? t('common.saveChanges') : t('account.createToken')}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('account.tokenName')} hint={t('apikey.nameHint')}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} autoFocus />
          </Field>
          {!existing && (
            <Field label={t('account.expires')}>
              <input className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </Field>
          )}
        </div>

        <div>
          <span className="label">{t('apikey.preset')}</span>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('apikey.preset')}>
            {[...catalog.presets.map((p) => p.id), 'custom'].map((id) => (
              <Button
                key={id}
                size="sm"
                variant={preset === id ? 'primary' : 'secondary'}
                aria-pressed={preset === id}
                onClick={() => {
                  if (id === 'custom') {
                    if (full) setScopes(new Set());
                    return;
                  }
                  setScopes(new Set(catalog.presets.find((p) => p.id === id)?.scopes ?? []));
                }}
              >
                {t(`apikey.preset.${id}` as TKey)}
              </Button>
            ))}
          </div>
          <p className="hint mt-1">{t(`apikey.presetHint.${preset}` as TKey)}</p>
        </div>

        {full ? (
          <div role="status" className="flex gap-3 rounded-md border border-warn/40 bg-warn/5 p-3 text-sm">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
            <span>{t('apikey.fullWarn')}</span>
          </div>
        ) : (
          <div>
            <span className="label">{t('apikey.permissions')}</span>
            <div className="max-h-72 space-y-3 overflow-y-auto rounded-block border border-line p-3">
              {groups.map((g) => (
                <fieldset key={g.group}>
                  <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{t(`scope.group.${g.group}` as TKey)}</legend>
                  <div className="space-y-1">
                    {g.items.map((s) => {
                      const implied = !scopes.has(s.id) && granted(scopes, s.id);
                      return (
                        <label key={s.id} className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
                            checked={granted(scopes, s.id)}
                            disabled={implied}
                            onChange={() => toggleScope(s.id)}
                          />
                          <span className="min-w-0">
                            <span className="font-mono text-xs">{s.id}</span>{' '}
                            {s.risk !== 'low' && <Badge tone={riskTone[s.risk]}>{t(`apikey.risk.${s.risk}` as TKey)}</Badge>}
                            <span className="block text-xs text-muted">{t(`scope.${s.id}` as TKey)}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={limit} onChange={(e) => setLimit(e.target.checked)} />
            {t('apikey.limitServers')}
          </label>
          <p className="hint">{t('apikey.limitServersHint')}</p>
          {limit && (
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-block border border-line p-3">
              {servers.length ? (
                servers.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={serverIds.has(s.id)} onChange={() => toggleServer(s.id)} />
                    <span className="truncate">{s.name}</span>
                    <span className="font-mono text-xs text-muted">{s.type}</span>
                  </label>
                ))
              ) : (
                <p className="text-sm text-muted">{t('apikey.noServers')}</p>
              )}
            </div>
          )}
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        {/* Enter submits from the name field. */}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

function CopyBox({ label, value }: { label: string; value: string }) {
  const t = useT();
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex gap-2">
        <code className="min-w-0 flex-1 break-all rounded-block bg-raised px-3 py-2 font-mono text-xs">{value}</code>
        <IconButton
          label={t('common.copy')}
          className="h-10 w-10 shrink-0"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            toast.info(t('common.copied'));
          }}
        >
          <Copy className="h-4 w-4" />
        </IconButton>
      </div>
    </div>
  );
}

/** Shown once, right after a key is created: the secret and how to plug it into an AI agent. */
function CreatedDialog({ created, onClose }: { created: ApiToken; onClose: () => void }) {
  const t = useT();
  const mcpUrl = `${window.location.origin}/mcp`;
  const key = created.token ?? '';
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={t('account.tokenCreated')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('common.done')}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">{t('account.tokenOnce')}</p>
        <CopyBox label={t('apikey.theKey')} value={key} />
        <div className="rounded-block border border-line p-3">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Bot className="h-4 w-4" aria-hidden="true" />
            {t('apikey.connect')}
          </h3>
          <p className="mb-3 text-sm text-muted">{t('apikey.connectBody')}</p>
          <div className="space-y-3">
            <CopyBox label={t('apikey.mcpUrl')} value={mcpUrl} />
            <CopyBox label="Claude Code" value={`claude mcp add --transport http servcrafty ${mcpUrl} --header "Authorization: Bearer ${key}"`} />
          </div>
          <p className="hint mt-2">{t('apikey.connectDocs')}</p>
        </div>
      </div>
    </Modal>
  );
}

export function ApiKeys() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tokens'], queryFn: accountApi.tokens });
  const cat = useQuery({ queryKey: ['token-scopes'], queryFn: accountApi.tokenScopes, staleTime: 5 * 60_000 });
  const servers = useServers();
  const [editing, setEditing] = useState<ApiToken | 'new' | null>(null);
  const [created, setCreated] = useState<ApiToken | null>(null);

  const revoke = async (tok: ApiToken) => {
    if (!(await confirm({ title: t('account.revokeTitle', { name: tok.name }), danger: true, confirmLabel: t('account.revoke') }))) return;
    try {
      await accountApi.deleteToken(tok.id);
      void qc.invalidateQueries({ queryKey: ['tokens'] });
    } catch (e) {
      toast.error(e);
    }
  };

  const summary = (tok: ApiToken) => {
    const p = presetOf(tok.scopes, cat.data);
    if (p === 'full') return <Badge tone="danger">{t('apikey.fullAccess')}</Badge>;
    if (p !== 'custom') return <Badge tone="accent">{t(`apikey.preset.${p}` as TKey)}</Badge>;
    return (
      <Badge tone="neutral" className="cursor-help">
        <span title={tok.scopes.join(', ')}>{t('apikey.nScopes', { n: tok.scopes.length })}</span>
      </Badge>
    );
  };

  return (
    <Section
      title={t('account.tokens')}
      description={t('account.tokensBody')}
      actions={
        <div className="flex gap-2">
          <DocsMenu />
          <Button size="sm" variant="primary" disabled={!cat.data} icon={<KeyRound className="h-4 w-4" />} onClick={() => setEditing('new')}>
            {t('apikey.create')}
          </Button>
        </div>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data?.length ? (
        <div className="overflow-x-auto rounded-block border border-line">
          <table className="table">
            <thead>
              <tr>
                <th>{t('account.tokenName')}</th>
                <th>{t('apikey.permissions')}</th>
                <th className="hidden sm:table-cell">{t('apikey.servers')}</th>
                <th className="hidden md:table-cell">{t('account.lastUsedCol')}</th>
                <th className="hidden md:table-cell">{t('account.expires')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((tok) => (
                <tr key={tok.id}>
                  <td>
                    <div className="font-medium">{tok.name}</div>
                    <div className="font-mono text-xs text-muted">{tok.prefix ? `${tok.prefix}…` : ''}</div>
                  </td>
                  <td>{summary(tok)}</td>
                  <td className="hidden text-muted sm:table-cell">{tok.serverIds ? (tok.serverIds.length === 1 ? t('apikey.oneServer') : t('apikey.nServers', { n: tok.serverIds.length })) : t('apikey.allServers')}</td>
                  <td className="hidden text-muted md:table-cell">{tok.lastUsedAt ? formatRelative(tok.lastUsedAt) : t('account.never')}</td>
                  <td className="hidden text-muted md:table-cell">{tok.expiresAt ? formatDate(tok.expiresAt) : t('account.never')}</td>
                  <td className="whitespace-nowrap text-right">
                    <IconButton label={t('common.edit')} disabled={!cat.data} onClick={() => setEditing(tok)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
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
        <p className="text-sm text-muted">{t('account.noTokens')}</p>
      )}
      {editing && cat.data && (
        <KeyDialog
          existing={editing === 'new' ? null : editing}
          catalog={cat.data}
          servers={servers.data ?? []}
          onClose={() => setEditing(null)}
          onCreated={(k) => {
            setEditing(null);
            setCreated(k);
          }}
        />
      )}
      {created && <CreatedDialog created={created} onClose={() => setCreated(null)} />}
    </Section>
  );
}
