import { useEffect, useId, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { useT } from '@/i18n';

export interface ComboOption {
  value: string;
  /** Shown instead of `value` when set. */
  label?: string;
  /** Small tag shown at the end of the row, e.g. "recommended". */
  badge?: string;
}

interface Props {
  options: ComboOption[];
  /** Selected value; '' means the automatic choice described by `emptyLabel`. */
  value: string;
  onChange: (value: string) => void;
  /** Label of the automatic choice, which has the value ''. */
  emptyLabel: string;
  placeholder?: string;
  loading?: boolean;
  /** Offer a 'Use "typed text"' row for values that are not in the list. */
  allowCustom?: boolean;
  disabled?: boolean;
  className?: string;
  /**
   * Accessible name. Set it when the combobox sits in a wrapping <label> (Field): the name computed
   * from that label would also take in the open list and the hint text.
   */
  ariaLabel?: string;
}

interface Row {
  value: string;
  label: string;
  badge?: string;
  custom?: boolean;
}

/**
 * Searchable single-select (ARIA 1.2 combobox with a listbox popup).
 * Typing filters; ArrowUp/Down move, Enter selects, Escape closes.
 */
export function Combobox({ options, value, onChange, emptyLabel, placeholder, loading, allowCustom, disabled, className, ariaLabel }: Props) {
  const t = useT();
  const id = useId();
  const listId = `${id}-list`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const selected = options.find((o) => o.value === value);
  const display = value === '' ? emptyLabel : (selected?.label ?? selected?.value ?? value);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const list: Row[] = [];
    if (!q || emptyLabel.toLowerCase().includes(q)) list.push({ value: '', label: emptyLabel });
    // A typed-in value that is not listed still gets its own (checked) row so the user sees what is chosen.
    if (value && !options.some((o) => o.value === value) && (!q || value.toLowerCase().includes(q))) list.push({ value, label: value });
    for (const o of options) {
      const label = o.label ?? o.value;
      if (!q || label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) list.push({ value: o.value, label, badge: o.badge });
    }
    const typed = query.trim();
    if (allowCustom && typed && !list.some((r) => r.value.toLowerCase() === typed.toLowerCase())) {
      list.push({ value: typed, label: t('combo.useCustom', { value: typed }), custom: true });
    }
    return list;
  }, [options, value, query, emptyLabel, allowCustom, t]);

  // Keep the highlighted row valid and visible.
  useEffect(() => {
    if (active >= rows.length) setActive(Math.max(0, rows.length - 1));
  }, [rows.length, active]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, id]);

  // Close when clicking outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      // A click on the field's own <label> refocuses the input; closing here would just reopen the list.
      if (Array.from(inputRef.current?.labels ?? []).some((l) => l.contains(target))) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function openList() {
    if (disabled) return;
    setQuery('');
    // Start on the currently selected row so the list opens where the user is.
    // Rows with an empty query: [automatic, (unlisted current value), ...options].
    const listed = options.findIndex((o) => o.value === value);
    const idx = value === '' ? 0 : listed < 0 ? 1 : listed + 1;
    setActive(idx);
    setOpen(true);
  }
  function close() {
    setOpen(false);
    setQuery('');
  }
  function choose(row: Row | undefined) {
    if (!row) return;
    onChange(row.value);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openList();
      else setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openList();
      else setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Home' && open) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && open) {
      e.preventDefault();
      setActive(Math.max(0, rows.length - 1));
    } else if (e.key === 'Enter') {
      if (open) {
        e.preventDefault();
        choose(rows[active]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    } else if (e.key === 'Tab') {
      if (open) close();
    }
  }

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && rows.length ? `${id}-opt-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="input pr-9"
        value={open ? query : display}
        placeholder={open ? t('combo.search') : placeholder}
        onChange={(e) => {
          if (!open) setOpen(true);
          setQuery(e.target.value);
          setActive(0);
        }}
        onFocus={(e) => {
          if (!open) {
            openList();
            e.currentTarget.select();
          }
        }}
        onClick={() => {
          if (!open) openList();
        }}
        onKeyDown={onKeyDown}
      />
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted">
        {loading ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <ChevronDown size={16} aria-hidden />}
      </span>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          // Keep focus in the input while the pointer is used on the list.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-block border border-line bg-surface py-1 text-sm shadow-lg"
        >
          {rows.length === 0 && <li className="px-3 py-2 text-muted">{loading ? t('common.loading') : t('combo.noResults')}</li>}
          {rows.map((row, i) => {
            const isSelected = row.value === value && !row.custom;
            return (
              <li
                key={`${row.custom ? 'custom:' : ''}${row.value}`}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActive(i)}
                onClick={(e) => {
                  // The combobox usually sits inside a <label>; stop it re-focusing the input.
                  e.preventDefault();
                  e.stopPropagation();
                  choose(row);
                }}
                className={clsx(
                  'flex cursor-pointer items-center gap-2 px-3 py-1.5',
                  i === active ? 'bg-accent/15 text-ink' : 'text-ink',
                  row.custom && 'italic',
                )}
              >
                <span className="w-4 shrink-0 text-accent">{isSelected && <Check size={14} aria-hidden />}</span>
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {row.badge && (
                  <span className="shrink-0 rounded-sm bg-raised px-1.5 py-0.5 text-xs text-muted">
                    <span className="sr-only">, </span>
                    {row.badge}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
