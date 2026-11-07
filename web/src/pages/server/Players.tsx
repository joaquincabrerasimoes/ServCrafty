import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Ban, Crown, DoorOpen, ListPlus, UserMinus, UserPlus } from 'lucide-react';
import { serversApi } from '@/api';
import type { PlayerAction, PlayerList } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { canOperate } from '@/lib/access';
import { useStats } from '@/lib/useFallbacks';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Button, EmptyState, ErrorState, Loading, Section } from '@/components/ui';
import { useServerCtx } from './ServerLayout';

function usePlayerAction(serverId: string) {
  const t = useT();
  const qc = useQueryClient();
  return async (name: string, action: PlayerAction) => {
    if (action === 'ban' || action === 'kick') {
      const ok = await confirm({ title: t(`players.confirm.${action}` as TKey, { name }), danger: true, confirmLabel: t(`players.action.${action}` as TKey) });
      if (!ok) return;
    }
    try {
      await serversApi.playerAction(serverId, name, action);
      toast.success(t('players.done', { name }));
      void qc.invalidateQueries({ queryKey: ['servers', serverId, 'lists'] });
      void qc.invalidateQueries({ queryKey: ['servers', serverId, 'stats'] });
    } catch (e) {
      toast.error(e);
    }
  };
}

const LISTS: Array<{ id: PlayerList; remove: PlayerAction; add: PlayerAction }> = [
  { id: 'whitelist', remove: 'whitelist-remove', add: 'whitelist-add' },
  { id: 'ops', remove: 'deop', add: 'op' },
  { id: 'banned', remove: 'pardon', add: 'ban' },
];

function Lists({ serverId, op }: { serverId: string; op: boolean }) {
  const t = useT();
  const [list, setList] = useState<PlayerList>('whitelist');
  const [name, setName] = useState('');
  const act = usePlayerAction(serverId);
  const cfg = LISTS.find((l) => l.id === list)!;
  const q = useQuery({ queryKey: ['servers', serverId, 'lists', list], queryFn: () => serversApi.playerList(serverId, list) });

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await act(name.trim(), cfg.add);
    setName('');
  };

  return (
    <Section
      title={t('players.lists')}
      actions={
        <div className="inline-flex rounded-block border border-line p-0.5">
          {LISTS.map((l) => (
            <button
              key={l.id}
              onClick={() => setList(l.id)}
              className={clsx('h-7 rounded-[2px] px-2.5 text-xs', list === l.id ? 'bg-raised font-medium' : 'text-muted hover:text-ink')}
            >
              {t(`players.list.${l.id}` as TKey)}
            </button>
          ))}
        </div>
      }
    >
      {op && (
        <form onSubmit={add} className="mb-4 flex gap-2">
          <input className="input" placeholder={t('players.name')} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" icon={<ListPlus className="h-4 w-4" />}>
            {t('common.add')}
          </Button>
        </form>
      )}
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.length ? (
        <p className="py-6 text-center text-sm text-muted">{t('players.listEmpty')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {q.data.map((p) => (
            <li key={p.uuid ?? p.name} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="font-mono text-sm">{p.name}</div>
                {p.reason && <div className="truncate text-xs text-muted">{p.reason}</div>}
              </div>
              {op && (
                <Button size="sm" variant="ghost" onClick={() => void act(p.name, cfg.remove)} icon={<UserMinus className="h-4 w-4" />}>
                  {t(`players.action.${cfg.remove}` as TKey)}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export default function Players() {
  const t = useT();
  const { server, live } = useServerCtx();
  const stats = useStats(server.id, live);
  const op = canOperate(server.access);
  const act = usePlayerAction(server.id);
  const online = stats?.players?.list ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title={t('players.online', { n: stats?.players?.online ?? 0, max: stats?.players?.max ?? 0 })}>
        {online.length === 0 ? (
          <EmptyState title={t('overview.noPlayers')} body={server.status !== 'running' ? t('console.notRunning') : undefined} />
        ) : (
          <ul className="divide-y divide-line">
            {online.map((p) => (
              <li key={p.name} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-mono text-sm">{p.name}</span>
                {op && (
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" onClick={() => void act(p.name, 'op')} icon={<Crown className="h-4 w-4" />}>
                      {t('players.action.op')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void act(p.name, 'whitelist-add')} icon={<UserPlus className="h-4 w-4" />}>
                      {t('players.action.whitelist-add')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void act(p.name, 'kick')} icon={<DoorOpen className="h-4 w-4" />}>
                      {t('players.action.kick')}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-danger" onClick={() => void act(p.name, 'ban')} icon={<Ban className="h-4 w-4" />}>
                      {t('players.action.ban')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Lists serverId={server.id} op={op} />
    </div>
  );
}
