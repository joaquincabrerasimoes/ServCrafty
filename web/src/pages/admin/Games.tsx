import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Ban, Copy, Download, Eye, FileUp, Gamepad2, Pencil, Pickaxe, Plus, Trash2, Trees, Upload } from 'lucide-react';
import { ApiError, adminApi, gamesApi } from '@/api';
import type { AdminGame, GameKind, GameSummary } from '@/api/types';
import { useT } from '@/i18n';
import { useIsAdmin } from '@/stores/auth';
import { gamesKey, publishedPorts, useGameDefs } from '@/lib/gameDefs';
import { adminGamesKey, defKey, useAdminGames } from '@/lib/gameKeys';
import { qk } from '@/lib/queries';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { GameIcon } from '@/components/GameBits';
import { Badge, Button, EmptyState, ErrorState, IconButton, Loading, Modal, PageHeader, Toggle } from '@/components/ui';
import { downloadJson, toJson } from './gameAuthoring';
import { DisableGameDialog } from './DisableGameDialog';

/** The definition without the list/DB metadata the API adds, as authors write it. */
export function stripMeta(def: Record<string, unknown>) {
  const out = { ...def };
  for (const k of ['builtin', 'hasWorkshop', 'hasWebui', 'ownerId', 'ownerName', 'createdAt', 'updatedAt']) delete out[k];
  return out;
}

/** Navigation state the editor accepts for a new definition (import / duplicate). */
export interface NewGameState {
  text: string;
}

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const go = (raw: string) => {
    try {
      JSON.parse(raw);
    } catch (e) {
      setError(t('games.importInvalid', { error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    onClose();
    setText('');
    navigate('/admin/games/new', { state: { text: raw } satisfies NewGameState });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={t('games.importTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!text.trim()} onClick={() => go(text)}>
            {t('games.importOpen')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">{t('games.importBody')}</p>
        <Button onClick={() => file.current?.click()} icon={<FileUp className="h-4 w-4" />}>
          {t('games.importFile')}
        </Button>
        <input
          ref={file}
          type="file"
          hidden
          accept=".json,application/json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void f.text().then(go);
          }}
        />
        <label className="block">
          <span className="label">{t('games.importPaste')}</span>
          <textarea
            className="input min-h-[12rem] font-mono text-[13px]"
            spellCheck={false}
            value={text}
            aria-invalid={!!error}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            placeholder='{ "schema": 1, "id": "...", ... }'
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** One row of the games table: a definition, or Minecraft/Terraria (admin listing only). */
interface Row {
  key: string;
  kind: GameKind;
  name: string;
  builtin: boolean;
  disabled: boolean;
  blockStart: boolean;
  def?: GameSummary;
  admin?: AdminGame;
}

const KIND_ORDER: Record<GameKind, number> = { minecraft: 0, terraria: 1, steam: 2 };

function RowIcon({ row }: { row: Row }) {
  if (row.kind === 'steam') return <GameIcon src={row.def?.icon} className="h-9 w-9" />;
  const Icon = row.kind === 'minecraft' ? Pickaxe : Trees;
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-block bg-raised text-muted">
      <Icon className="h-5 w-5" aria-hidden="true" />
    </span>
  );
}

function StateBadges({ row }: { row: Row }) {
  const t = useT();
  if (!row.disabled) return null;
  return (
    <>
      <Badge tone="warn">{t('games.badgeDisabled')}</Badge>
      {row.blockStart && <Badge tone="danger">{t('games.badgeBlocked')}</Badge>}
    </>
  );
}

export default function Games() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const q = useGameDefs();
  const adminQ = useAdminGames(isAdmin);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [disabling, setDisabling] = useState<AdminGame | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  const withFull = async (g: GameSummary, fn: (def: Record<string, unknown>) => void) => {
    setBusy(g.id);
    try {
      fn((await gamesApi.get(g.id)) as unknown as Record<string, unknown>);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const duplicate = (g: GameSummary) =>
    withFull(g, (def) => {
      const ids = new Set(q.data?.map((d) => d.id));
      let id = `${g.id}-copy`.slice(0, 40);
      for (let n = 2; ids.has(id); n++) id = `${g.id.slice(0, 34)}-copy${n}`;
      const rest = stripMeta(def);
      navigate('/admin/games/new', { state: { text: toJson({ ...rest, id, name: t('games.copyName', { name: g.name }) }) } satisfies NewGameState });
    });

  const exportDef = (g: GameSummary) =>
    withFull(g, (def) => {
      const rest = stripMeta(def);
      downloadJson(`${g.id}.json`, rest);
    });

  const remove = async (g: GameSummary) => {
    const ok = await confirm({ title: t('games.deleteTitle', { name: g.name }), body: t('games.deleteBody'), danger: true, typeToConfirm: g.id, confirmLabel: t('common.delete') });
    if (!ok) return;
    try {
      await gamesApi.remove(g.id);
      void qc.invalidateQueries({ queryKey: gamesKey });
      void qc.invalidateQueries({ queryKey: adminGamesKey });
      toast.success(t('games.deleted', { name: g.name }));
    } catch (e) {
      toast.error(e instanceof ApiError && e.code === 'game_in_use' ? t('games.inUse', { name: g.name }) : e);
    }
  };

  const afterSwitch = () => {
    void qc.invalidateQueries({ queryKey: adminGamesKey });
    void qc.invalidateQueries({ queryKey: gamesKey });
    void qc.invalidateQueries({ queryKey: qk.servers });
    void qc.invalidateQueries({ queryKey: qk.me });
  };

  const setDisabled = async (g: AdminGame, disabled: boolean, blockStart = false) => {
    setSwitching(g.key);
    try {
      const r = await adminApi.setGameDisabled(g.key, disabled ? { disabled: true, blockStart } : { disabled: false });
      setDisabling(null);
      afterSwitch();
      const stopped = typeof r?.stopped === 'number' ? r.stopped : 0;
      if (!disabled) toast.success(t('games.enabledDone', { name: g.name }));
      else if (stopped > 0) toast.success(t('games.disabledStopped', { name: g.name, n: stopped }));
      else toast.success(blockStart ? t('games.disabledBlocked', { name: g.name }) : t('games.disabledDone', { name: g.name }));
    } catch (e) {
      toast.error(e);
    } finally {
      setSwitching(null);
    }
  };

  const rows = useMemo<Row[]>(() => {
    const defs = q.data ?? [];
    const byKey = new Map(defs.map((d) => [defKey(d), d]));
    const list: Row[] =
      isAdmin && adminQ.data
        ? adminQ.data.map((a) => ({ key: a.key, kind: a.kind, name: a.name, builtin: a.builtin, disabled: a.disabled, blockStart: a.blockStart, def: byKey.get(a.key), admin: a }))
        : defs.map((d) => ({ key: defKey(d), kind: 'steam' as const, name: d.name, builtin: d.builtin, disabled: !!d.disabled, blockStart: !!d.blockStart, def: d }));
    return list.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  }, [q.data, adminQ.data, isAdmin]);

  const loading = q.isLoading || (isAdmin && adminQ.isLoading);

  return (
    <>
      <PageHeader
        title={t('games.title')}
        subtitle={isAdmin ? t('games.subtitleAdmin') : t('games.subtitle')}
        actions={
          <>
            <Button onClick={() => setImportOpen(true)} icon={<Upload className="h-4 w-4" />}>
              {t('games.import')}
            </Button>
            <Button variant="primary" onClick={() => navigate('/admin/games/new')} icon={<Plus className="h-4 w-4" />}>
              {t('games.new')}
            </Button>
          </>
        }
      />
      {isAdmin && adminQ.error && !loading && (
        <div className="mb-4">
          <ErrorState error={adminQ.error} onRetry={() => void adminQ.refetch()} />
        </div>
      )}
      {loading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !rows.length ? (
        <div className="panel">
          <EmptyState icon={<Gamepad2 className="h-10 w-10" />} title={t('games.emptyTitle')} body={t('games.emptyBody')} />
        </div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('games.colGame')}</th>
                <th className="hidden sm:table-cell">{t('games.colKind')}</th>
                <th className="hidden md:table-cell">{t('games.colPorts')}</th>
                <th className="hidden md:table-cell">{t('games.colVariables')}</th>
                {isAdmin && <th className="hidden lg:table-cell">{t('games.colServers')}</th>}
                {isAdmin && <th>{t('games.colEnabled')}</th>}
                <th>
                  <span className="sr-only">{t('games.colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const g = row.def;
                const steam = row.kind === 'steam';
                const kindBadge = row.builtin ? <Badge tone="accent">{t('games.builtin')}</Badge> : <Badge>{t('games.custom')}</Badge>;
                return (
                  <tr key={row.key} className={row.disabled ? 'bg-raised/40' : undefined}>
                    <td>
                      <div className={clsx('flex min-w-0 items-center gap-3', row.disabled && 'opacity-75')}>
                        <RowIcon row={row} />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{row.name}</div>
                          <div className="truncate font-mono text-xs text-muted">{steam ? g?.id ?? row.key.replace(/^steam:/, '') : row.key}</div>
                          <div className="mt-0.5 flex flex-wrap gap-1 sm:hidden">
                            {kindBadge}
                            <StateBadges row={row} />
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="hidden sm:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {kindBadge}
                        <StateBadges row={row} />
                      </div>
                      {g?.ownerName && <div className="mt-1 text-xs text-muted">{g.ownerName}</div>}
                    </td>
                    <td className="hidden tabular-nums md:table-cell">{g ? publishedPorts(g).length || g.ports?.length || 0 : <span className="text-muted">–</span>}</td>
                    <td className="hidden tabular-nums md:table-cell">{g ? g.variables?.length ?? 0 : <span className="text-muted">–</span>}</td>
                    {isAdmin && (
                      <td className="hidden whitespace-nowrap tabular-nums text-muted lg:table-cell">
                        {row.admin ? t('games.serverCounts', { n: row.admin.servers, running: row.admin.running }) : '–'}
                      </td>
                    )}
                    {isAdmin && (
                      <td>
                        {row.admin ? (
                          <Toggle
                            checked={!row.disabled}
                            disabled={switching === row.key}
                            ariaLabel={t('games.enabledLabel', { name: row.name })}
                            onChange={(on) => (on ? void setDisabled(row.admin!, false) : setDisabling(row.admin!))}
                          />
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                    )}
                    <td>
                      <div className="flex justify-end">
                        {isAdmin && row.admin && row.disabled && (
                          <IconButton label={t('games.disableChange')} className="h-10 w-10" disabled={switching === row.key} onClick={() => setDisabling(row.admin!)}>
                            <Ban className="h-4 w-4" />
                          </IconButton>
                        )}
                        {g && (
                          <>
                            <IconButton label={g.builtin ? t('games.view') : t('common.edit')} className="h-10 w-10" onClick={() => navigate(`/admin/games/${encodeURIComponent(g.id)}`)}>
                              {g.builtin ? <Eye className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                            </IconButton>
                            <IconButton label={t('games.duplicate')} className="h-10 w-10" disabled={busy === g.id} onClick={() => void duplicate(g)}>
                              <Copy className="h-4 w-4" />
                            </IconButton>
                            <IconButton label={t('games.export')} className="h-10 w-10" disabled={busy === g.id} onClick={() => void exportDef(g)}>
                              <Download className="h-4 w-4" />
                            </IconButton>
                            {!g.builtin && (
                              <IconButton label={t('common.delete')} className="h-10 w-10 hover:text-danger" onClick={() => void remove(g)}>
                                <Trash2 className="h-4 w-4" />
                              </IconButton>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <DisableGameDialog
        game={disabling}
        busy={!!disabling && switching === disabling.key}
        onClose={() => setDisabling(null)}
        onConfirm={(block) => {
          if (disabling) void setDisabled(disabling, true, block);
        }}
      />
    </>
  );
}
