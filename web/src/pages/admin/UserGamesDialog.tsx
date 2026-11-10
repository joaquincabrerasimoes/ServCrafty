import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usersApi } from '@/api';
import type { GameKey, User } from '@/api/types';
import { useT } from '@/i18n';
import { toast } from '@/stores/toast';
import { useGameCatalog, type CatalogGame } from '@/lib/gameKeys';
import { Badge, Button, ErrorState, Loading, Modal } from '@/components/ui';

function GameCheck({ game, checked, onChange }: { game: CatalogGame; checked: boolean; onChange: (v: boolean) => void }) {
  const t = useT();
  return (
    <label className="flex min-h-[2.75rem] cursor-pointer items-center gap-3 rounded-block border border-line px-3 py-2 text-sm hover:bg-raised has-[:checked]:border-accent/50">
      <input type="checkbox" className="h-4 w-4 shrink-0 accent-[rgb(var(--accent))]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{game.name}</span>
        {game.kind === 'steam' && <span className="block truncate font-mono text-xs text-muted">{game.key}</span>}
      </span>
      {game.def?.disabled && <Badge tone="warn">{t('gameAccess.disabledBadge')}</Badge>}
    </label>
  );
}

/** Admin > Users > Games: which games a user may create servers for (allowlist, default none). */
export function UserGamesDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const open = !!user;
  const { catalog, isLoading: defsLoading, error: defsError, refetch: refetchDefs } = useGameCatalog(t);
  const granted = useQuery({ queryKey: ['user-games', user?.id], queryFn: () => usersApi.games(user!.id), enabled: open && user?.role !== 'admin', staleTime: 0 });
  const [sel, setSel] = useState<Set<GameKey>>(new Set());
  const [busy, setBusy] = useState(false);

  // Reset to the saved set whenever the dialog opens (a cancelled edit must not leak into the next one).
  useEffect(() => {
    setSel(new Set(open ? granted.data?.games ?? [] : []));
  }, [granted.data, open, user?.id]);

  const groups = useMemo(() => {
    const all = catalog ?? [];
    return [
      { id: 'builtin', label: t('gameAccess.groupBuiltin'), items: all.filter((g) => g.kind !== 'steam') },
      { id: 'steam', label: t('gameAccess.groupSteam'), items: all.filter((g) => g.kind === 'steam') },
    ].filter((g) => g.items.length);
  }, [catalog, t]);

  const known = useMemo(() => new Set((catalog ?? []).map((g) => g.key)), [catalog]);
  // Keys still granted but whose definition no longer exists are dropped on save (the API would refuse them).
  const count = [...sel].filter((k) => known.has(k)).length;

  const toggle = (key: GameKey, on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  const save = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await usersApi.setGames(
        user.id,
        [...sel].filter((k) => known.has(k)),
      );
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['user-games', user.id] });
      toast.success(t('gameAccess.saved', { name: user.username }));
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const admin = user?.role === 'admin';
  const loading = defsLoading || (!admin && granted.isLoading);
  const error = defsError ?? (!admin ? granted.error : null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('gameAccess.title', { name: user?.username ?? '' })}
      footer={
        admin ? (
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} disabled={loading || !!error} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </>
        )
      }
    >
      {admin ? (
        <div className="space-y-2 text-sm">
          <Badge tone="accent">{t('gameAccess.unrestricted')}</Badge>
          <p className="text-muted">{t('gameAccess.adminBody')}</p>
        </div>
      ) : loading ? (
        <Loading />
      ) : error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void refetchDefs();
            void granted.refetch();
          }}
        />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('gameAccess.body')}</p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium" aria-live="polite">
              {t('gameAccess.count', { n: count, total: known.size })}
            </span>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setSel(new Set(known))}>
                {t('gameAccess.selectAll')}
              </Button>
              <Button size="sm" onClick={() => setSel(new Set())}>
                {t('gameAccess.selectNone')}
              </Button>
            </div>
          </div>
          {groups.map((g) => (
            <fieldset key={g.id}>
              <legend className="label">{g.label}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {g.items.map((game) => (
                  <GameCheck key={game.key} game={game} checked={sel.has(game.key)} onChange={(v) => toggle(game.key, v)} />
                ))}
              </div>
            </fieldset>
          ))}
          {count === 0 && <p className="rounded-block border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-warn">{t('gameAccess.noneWarning')}</p>}
        </div>
      )}
    </Modal>
  );
}
