import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { BookOpen, ChevronDown, FileCode2, FileText } from 'lucide-react';
import { docsApi, type DocKind } from '@/api';
import { useT } from '@/i18n';
import { toast } from '@/stores/toast';
import { errorMessage } from '@/api/client';
import { Button } from './ui';

/** "Download documentation" button with a menu: the API tokens guide (Markdown) or the OpenAPI spec (JSON). */
export function DocsMenu() {
  const t = useT();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<DocKind | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const download = async (kind: DocKind) => {
    close();
    setBusy(kind);
    try {
      await docsApi.download(kind);
    } catch (e) {
      toast.error(t('docs.downloadFailed', { error: errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items.current.filter((x): x is HTMLButtonElement => !!x);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  const entries: Array<{ kind: DocKind; label: string; hint: string; Icon: typeof FileText }> = [
    { kind: 'guide', label: t('docs.guide'), hint: t('docs.guideHint'), Icon: FileText },
    { kind: 'openapi', label: t('docs.openapi'), hint: t('docs.openapiHint'), Icon: FileCode2 },
  ];

  return (
    <div ref={wrap} className="relative inline-block">
      <Button
        ref={button}
        size="sm"
        loading={busy !== null}
        icon={<BookOpen className="h-4 w-4" />}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {t('docs.download')}
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t('docs.download')}
          onKeyDown={onMenuKey}
          className="absolute end-0 z-30 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-md border border-line bg-surface p-1 shadow-lg"
        >
          {entries.map(({ kind, label, hint, Icon }, i) => (
            <button
              key={kind}
              ref={(el) => {
                items.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => void download(kind)}
              className="flex w-full items-start gap-2.5 rounded-block px-3 py-2 text-left text-sm hover:bg-raised focus:bg-raised focus:outline-none"
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              <span>
                <span className="block font-medium">{label}</span>
                <span className="block text-xs text-muted">{hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
