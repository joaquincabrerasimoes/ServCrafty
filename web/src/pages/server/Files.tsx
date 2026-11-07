import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowLeft,
  ChevronRight,
  Download,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  Home,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import { serversApi } from '@/api';
import type { FileEntry } from '@/api/types';
import { useT } from '@/i18n';
import { formatBytes, formatRelative, joinPath, parentPath } from '@/lib/format';
import { toast } from '@/stores/toast';
import { confirm } from '@/components/feedback';
import { Button, EmptyState, ErrorState, IconButton, Loading, Modal, Field } from '@/components/ui';
import { TextEditor } from '@/components/TextEditor';
import { useServerCtx } from './ServerLayout';

const isDir = (e: FileEntry) => e.isDir === true || e.type === 'dir' || e.type === 'directory';
const TEXT_EXT = /\.(txt|log|json|json5|ya?ml|toml|properties|cfg|conf|ini|xml|md|sh|bat|js|mcmeta|mcfunction|snbt|csv|secret|env|lang)$/i;
const isText = (e: FileEntry) => !isDir(e) && (TEXT_EXT.test(e.name) || !/\.[a-z0-9]+$/i.test(e.name)) && (e.size ?? 0) < 4 * 1024 * 1024;

function Editor({ serverId, path, onClose }: { serverId: string; path: string; onClose: () => void }) {
  const t = useT();
  const q = useQuery({ queryKey: ['servers', serverId, 'file', path], queryFn: () => serversApi.fileContent(serverId, path), staleTime: 0, gcTime: 0 });
  const [value, setValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (q.data !== undefined && value === null) setValue(q.data);
  }, [q.data, value]);
  const dirty = value !== null && q.data !== undefined && value !== q.data;

  const save = async () => {
    if (value === null) return;
    setSaving(true);
    try {
      await serversApi.saveFile(serverId, path, value);
      q.refetch().then(() => setValue(value));
      toast.success(t('files.saved'));
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (dirty && !(await confirm({ title: t('files.discardTitle'), body: t('files.discardBody'), danger: true, confirmLabel: t('files.discard') }))) return;
    onClose();
  };

  return (
    <div className="flex h-[calc(100dvh-15rem)] min-h-[24rem] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => void close()} icon={<ArrowLeft className="h-4 w-4" />}>
          {t('common.back')}
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-sm">
          {path}
          {dirty && <span className="ml-2 text-warn">●</span>}
        </span>
        <span className="hidden text-xs text-muted sm:inline">Ctrl+S</span>
        <Button size="sm" variant="primary" disabled={!dirty} loading={saving} onClick={() => void save()} icon={<Save className="h-4 w-4" />}>
          {t('common.save')}
        </Button>
      </div>
      {q.isLoading || value === null ? (
        q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <Loading />
      ) : (
        <div className="min-h-0 flex-1">
          <TextEditor value={value} onChange={setValue} onSave={() => void save()} />
        </div>
      )}
    </div>
  );
}

type Prompt = { kind: 'mkdir' | 'newfile' } | { kind: 'rename'; entry: FileEntry } | null;

export default function Files() {
  const t = useT();
  const { server } = useServerCtx();
  const qc = useQueryClient();
  const [dir, setDir] = useState('/');
  const [editing, setEditing] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [promptValue, setPromptValue] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const key = ['servers', server.id, 'files', dir];
  const q = useQuery({ queryKey: key, queryFn: () => serversApi.files(server.id, dir) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['servers', server.id, 'files'] });

  const entries = [...(q.data ?? [])].sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name));
  const crumbs = dir.split('/').filter(Boolean);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      await serversApi.upload(server.id, dir, files);
      toast.success(t('files.uploaded', { n: files.length }));
      void refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setUploading(false);
    }
  };

  const remove = async (e: FileEntry) => {
    const ok = await confirm({ title: t('files.deleteTitle', { name: e.name }), body: isDir(e) ? t('files.deleteDirBody') : undefined, danger: true, confirmLabel: t('common.delete') });
    if (!ok) return;
    try {
      await serversApi.deleteFile(server.id, joinPath(dir, e.name));
      void refresh();
    } catch (err) {
      toast.error(err);
    }
  };

  const submitPrompt = async () => {
    const name = promptValue.trim();
    if (!name || !prompt) return;
    try {
      if (prompt.kind === 'mkdir') await serversApi.mkdir(server.id, joinPath(dir, name));
      else if (prompt.kind === 'newfile') {
        await serversApi.saveFile(server.id, joinPath(dir, name), '');
        setEditing(joinPath(dir, name));
      } else if (prompt.kind === 'rename') await serversApi.rename(server.id, joinPath(dir, prompt.entry.name), joinPath(dir, name));
      setPrompt(null);
      void refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void upload(Array.from(e.dataTransfer.files));
  };

  if (editing) return <Editor serverId={server.id} path={editing} onClose={() => setEditing(null)} />;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={clsx('panel overflow-hidden', dragOver && 'ring-2 ring-accent')}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm" aria-label={t('files.path')}>
          <button className="rounded-[2px] p-1 text-muted hover:text-ink" onClick={() => setDir('/')} aria-label={t('files.root')}>
            <Home className="h-4 w-4" />
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 text-muted" />
              <button className="whitespace-nowrap rounded-[2px] px-1 hover:text-accent" onClick={() => setDir('/' + crumbs.slice(0, i + 1).join('/'))}>
                {c}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          <IconButton label={t('common.refresh')} onClick={() => void refresh()}>
            <RefreshCw className="h-4 w-4" />
          </IconButton>
          <IconButton label={t('files.newFolder')} onClick={() => (setPromptValue(''), setPrompt({ kind: 'mkdir' }))}>
            <FolderPlus className="h-4 w-4" />
          </IconButton>
          <IconButton label={t('files.newFile')} onClick={() => (setPromptValue(''), setPrompt({ kind: 'newfile' }))}>
            <FilePlus className="h-4 w-4" />
          </IconButton>
          <Button size="sm" loading={uploading} onClick={() => fileInput.current?.click()} icon={<Upload className="h-4 w-4" />}>
            {t('files.upload')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void upload(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <div className="p-4">
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : (
        <ul className="divide-y divide-line/70">
          {dir !== '/' && (
            <li>
              <button className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-muted hover:bg-raised/60" onClick={() => setDir(parentPath(dir))}>
                <Folder className="h-4 w-4" />
                ..
              </button>
            </li>
          )}
          {entries.length === 0 && <EmptyState title={t('files.empty')} body={t('files.dropHint')} />}
          {entries.map((e) => {
            const d = isDir(e);
            const path = joinPath(dir, e.name);
            return (
              <li key={e.name} className="group flex items-center gap-2 px-4 py-1.5 hover:bg-raised/60">
                <button
                  className="flex min-w-0 flex-1 items-center gap-3 py-0.5 text-left text-sm"
                  onClick={() => (d ? setDir(path) : isText(e) ? setEditing(path) : window.open(serversApi.downloadUrl(server.id, path), '_blank'))}
                >
                  {d ? <Folder className="h-4 w-4 shrink-0 text-accent" /> : <FileIcon className="h-4 w-4 shrink-0 text-muted" />}
                  <span className="truncate">{e.name}</span>
                </button>
                <span className="hidden w-20 text-right text-xs tabular-nums text-muted sm:block">{d ? '' : formatBytes(e.size)}</span>
                <span className="hidden w-32 text-right text-xs text-muted md:block">{formatRelative(e.mtime ?? e.modifiedAt)}</span>
                <div className="flex items-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  {!d && (
                    <a href={serversApi.downloadUrl(server.id, path)} className="inline-flex h-8 w-8 items-center justify-center rounded-block text-muted hover:bg-raised hover:text-ink" title={t('common.download')} aria-label={t('common.download')}>
                      <Download className="h-4 w-4" />
                    </a>
                  )}
                  <IconButton label={t('files.rename')} onClick={() => (setPromptValue(e.name), setPrompt({ kind: 'rename', entry: e }))}>
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                  <IconButton label={t('common.delete')} onClick={() => void remove(e)} className="hover:text-danger">
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={!!prompt}
        onClose={() => setPrompt(null)}
        title={prompt?.kind === 'mkdir' ? t('files.newFolder') : prompt?.kind === 'newfile' ? t('files.newFile') : t('files.rename')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPrompt(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void submitPrompt()} disabled={!promptValue.trim()}>
              {prompt?.kind === 'rename' ? t('files.rename') : t('common.create')}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitPrompt();
          }}
        >
          <Field label={t('files.name')}>
            <input className="input font-mono" value={promptValue} onChange={(e) => setPromptValue(e.target.value)} />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
