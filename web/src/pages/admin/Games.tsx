import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Download, Eye, FileUp, Gamepad2, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { ApiError, gamesApi } from '@/api';
import type { GameSummary } from '@/api/types';
import { useT } from '@/i18n';
import { gamesKey, publishedPorts, useGameDefs } from '@/lib/gameDefs';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { GameIcon } from '@/components/GameBits';
import { Badge, Button, EmptyState, ErrorState, IconButton, Loading, Modal, PageHeader } from '@/components/ui';
import { downloadJson, toJson } from './gameAuthoring';

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

export default function Games() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useGameDefs();
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

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
      toast.success(t('games.deleted', { name: g.name }));
    } catch (e) {
      toast.error(e instanceof ApiError && e.code === 'game_in_use' ? t('games.inUse', { name: g.name }) : e);
    }
  };

  const sorted = [...(q.data ?? [])].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader
        title={t('games.title')}
        subtitle={t('games.subtitle')}
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
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !sorted.length ? (
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
                <th>
                  <span className="sr-only">{t('games.colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((g) => (
                <tr key={g.id}>
                  <td>
                    <div className="flex min-w-0 items-center gap-3">
                      <GameIcon src={g.icon} className="h-9 w-9" />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{g.name}</div>
                        <div className="truncate font-mono text-xs text-muted">{g.id}</div>
                        <div className="mt-0.5 sm:hidden">{g.builtin ? <Badge tone="accent">{t('games.builtin')}</Badge> : <Badge>{t('games.custom')}</Badge>}</div>
                      </div>
                    </div>
                  </td>
                  <td className="hidden sm:table-cell">
                    {g.builtin ? <Badge tone="accent">{t('games.builtin')}</Badge> : <Badge>{t('games.custom')}</Badge>}
                    {g.ownerName && <div className="mt-1 text-xs text-muted">{g.ownerName}</div>}
                  </td>
                  <td className="hidden tabular-nums md:table-cell">{publishedPorts(g).length || g.ports?.length || 0}</td>
                  <td className="hidden tabular-nums md:table-cell">{g.variables?.length ?? 0}</td>
                  <td>
                    <div className="flex justify-end">
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
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
