import { useMemo, useRef, type KeyboardEvent } from 'react';

/** Lightweight code editor: textarea with a line-number gutter, tab indentation and Ctrl/Cmd+S. */
export function TextEditor({ value, onChange, onSave, readOnly }: { value: string; onChange: (v: string) => void; onSave?: () => void; readOnly?: boolean }) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split('\n').length, [value]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave?.();
      return;
    }
    if (e.key === 'Tab' && !readOnly) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: end } = el;
      const next = value.slice(0, s) + '  ' + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
    }
  };

  return (
    <div className="gui-well flex h-full min-h-0 overflow-hidden font-mono text-[13px] leading-[1.6]">
      <div ref={gutter} className="select-none overflow-hidden border-r border-white/10 px-2 py-2 text-right text-console-ink/35" aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        className="scrollbar-thin min-w-0 flex-1 resize-none whitespace-pre bg-transparent px-3 py-2 text-console-ink caret-[rgb(var(--accent))] focus:outline-none"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}
