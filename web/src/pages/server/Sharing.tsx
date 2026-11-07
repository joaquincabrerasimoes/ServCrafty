import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, Users, X } from 'lucide-react';
import { serversApi, usersApi } from '@/api';
import type { ShareLevel } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { toast } from '@/stores/toast';
import { Button, EmptyState, ErrorState, IconButton, Loading, Section } from '@/components/ui';
import { useServerCtx } from './ServerLayout';

const LEVELS: ShareLevel[] = ['viewer', 'operator', 'manager'];

export default function Sharing() {
  const t = useT();
  const { server } = useServerCtx();
  const qc = useQueryClient();
  const key = ['servers', server.id, 'shares'];
  const q = useQuery({ queryKey: key, queryFn: () => serversApi.shares(server.id) });
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<{ id: string; username: string } | null>(null);
  const [level, setLevel] = useState<ShareLevel>('viewer');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);
  const lookup = useQuery({ queryKey: ['user-lookup', debounced], queryFn: () => usersApi.lookup(debounced), enabled: debounced.length >= 2 && !picked });

  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const add = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      await serversApi.share(server.id, picked.id, level);
      setPicked(null);
      setQuery('');
      void refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const change = async (userId: string, l: ShareLevel) => {
    try {
      await serversApi.share(server.id, userId, l);
      void refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  const remove = async (userId: string) => {
    try {
      await serversApi.unshare(server.id, userId);
      void refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Section title={t('sharing.people')}>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data?.length ? (
          <EmptyState icon={<Users className="h-10 w-10" />} title={t('sharing.emptyTitle')} body={t('sharing.emptyBody')} />
        ) : (
          <ul className="-my-2 divide-y divide-line">
            {q.data.map((s) => (
              <li key={s.userId} className="flex items-center gap-3 py-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-block bg-raised font-display text-sm font-bold">{(s.username ?? '?').slice(0, 1).toUpperCase()}</div>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.username ?? s.userId}</span>
                <select className="input h-8 w-auto py-0 text-sm" value={s.level} onChange={(e) => void change(s.userId, e.target.value as ShareLevel)}>
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {t(`access.${l}`)}
                    </option>
                  ))}
                </select>
                <IconButton label={t('common.remove')} className="hover:text-danger" onClick={() => void remove(s.userId)}>
                  <X className="h-4 w-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="space-y-4">
        <Section title={t('sharing.add')}>
          <div className="space-y-3">
            {picked ? (
              <div className="flex items-center justify-between rounded-block border border-accent/40 bg-accent/5 px-3 py-2 text-sm">
                <span className="font-medium">{picked.username}</span>
                <IconButton label={t('common.remove')} onClick={() => setPicked(null)}>
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
            ) : (
              <div className="relative">
                <input className="input" placeholder={t('sharing.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
                {lookup.data && lookup.data.length > 0 && (
                  <ul className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-block border border-line bg-surface shadow-lg">
                    {lookup.data.map((u) => (
                      <li key={u.id}>
                        <button className="w-full px-3 py-2 text-left text-sm hover:bg-raised" onClick={() => setPicked(u)}>
                          {u.username}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <select className="input" value={level} onChange={(e) => setLevel(e.target.value as ShareLevel)}>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {t(`access.${l}`)}
                </option>
              ))}
            </select>
            <Button variant="primary" className="w-full" disabled={!picked} loading={busy} onClick={() => void add()} icon={<UserPlus className="h-4 w-4" />}>
              {t('sharing.share')}
            </Button>
          </div>
        </Section>
        <div className="space-y-2 px-1 text-sm text-muted">
          {LEVELS.map((l) => (
            <p key={l}>
              <span className="font-medium text-ink">{t(`access.${l}`)}:</span> {t(`sharing.levelHint.${l}` as TKey)}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
