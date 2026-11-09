import { Fragment, useMemo, type ReactNode } from 'react';

/**
 * Minimal, safe Markdown renderer for untrusted text (e.g. GitHub release notes).
 *
 * It builds React elements directly – nothing is ever injected as HTML, so raw HTML in the
 * source shows up as literal text. Supported: ATX headings, paragraphs, (nested) bullet and
 * numbered lists, task-list boxes, fenced and indented code, blockquotes, horizontal rules,
 * and inline code, bold, italic, strikethrough, links and bare URLs. Links are restricted to
 * http(s) and mailto and always open in a new tab without a referrer.
 */

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'hr' }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] };

interface ListItem {
  text: string;
  checked: boolean | null;
  children: Block[];
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

const indentOf = (line: string) => (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '    ').length;

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      blocks.push({ kind: 'quote', children: parseBlocks(body) });
      continue;
    }

    if (LIST_RE.test(line)) {
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }

    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (indentOf(lines[i]) >= 4 || !lines[i].trim())) body.push(lines[i++].replace(/^( {4}|\t)/, ''));
      blocks.push({ kind: 'code', text: body.join('\n').replace(/\n+$/, '') });
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !/^\s{0,3}>/.test(lines[i]) &&
      !LIST_RE.test(lines[i])
    ) {
      para.push(lines[i++].trim());
    }
    blocks.push({ kind: 'para', text: para.join('\n') });
  }
  return blocks;
}

function parseList(lines: string[], start: number): [Block, number] {
  const first = lines[start].match(LIST_RE)!;
  const baseIndent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const list: Block & { kind: 'list' } = { kind: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST_RE);
    if (!m || indentOf(m[1]) !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    let text = m[3];
    let checked: boolean | null = null;
    const task = text.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      checked = task[1] !== ' ';
      text = task[2];
    }
    i++;
    // Continuation lines and nested content: anything indented deeper than the marker.
    const nested: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        // A blank line ends the item unless more indented content follows.
        if (i + 1 < lines.length && lines[i + 1].trim() && indentOf(lines[i + 1]) > baseIndent) {
          nested.push('');
          i++;
          continue;
        }
        break;
      }
      if (indentOf(l) <= baseIndent) break;
      nested.push(l);
      i++;
    }
    // Lazy continuation text directly under the item joins its first paragraph.
    let k = 0;
    while (k < nested.length && nested[k].trim() && !LIST_RE.test(nested[k]) && !FENCE_RE.test(nested[k])) {
      text += '\n' + nested[k].trim();
      k++;
    }
    const rest = nested.slice(k);
    const minIndent = rest.filter((l) => l.trim()).reduce((min, l) => Math.min(min, indentOf(l)), Infinity);
    const dedented = Number.isFinite(minIndent) ? rest.map((l) => l.replace(/\t/g, '    ').slice(minIndent)) : [];
    list.items.push({ text, checked, children: parseBlocks(dedented) });
    // Skip blank lines between items of the same list.
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    const nm = j < lines.length ? lines[j].match(LIST_RE) : null;
    if (nm && indentOf(nm[1]) === baseIndent && /\d/.test(nm[2]) === ordered) i = j;
    else break;
  }
  return [list, i];
}

/* ------------------------------------------------------------------ inline */

/** Returns a normalized URL if it is http(s)/mailto, else null. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.href : null;
  } catch {
    return null;
  }
}

function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="break-words text-accent underline-offset-2 hover:underline">
      {children}
    </a>
  );
}

// Order matters: code first so its content is never formatted.
const INLINE_RE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(\s*<?((?:[^()\s<>]|\([^()\s<>]*\))+)>?(?:\s+"[^"]*")?\s*\)|<((?:https?:\/\/|mailto:)[^>\s]+)>|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=\S)([^*]*?\S)\*|(?<![\w/])_(?=\S)([^_]*?\S)_(?!\w)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"\]])/g;

function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const push = (s: string) => {
    // Hard line breaks inside a paragraph become <br>.
    s.split('\n').forEach((part, idx) => {
      if (idx > 0) out.push(<br key={`${keyPrefix}-br${n++}`} />);
      if (part) out.push(part);
    });
  };
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) push(text.slice(last, idx));
    const key = `${keyPrefix}-${n++}`;
    if (m[1]) {
      out.push(
        <code key={key} className="rounded-[2px] bg-raised px-1 py-px font-mono text-[0.85em]">
          {m[2].replace(/^ (.*) $/, '$1')}
        </code>,
      );
    } else if (m[3] !== undefined) {
      const href = safeHref(m[4]);
      const label = renderInline(m[3], key);
      out.push(href ? <A key={key} href={href}>{label}</A> : <Fragment key={key}>{label}</Fragment>);
    } else if (m[5]) {
      const href = safeHref(m[5]);
      out.push(href ? <A key={key} href={href}>{m[5]}</A> : m[5]);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      out.push(<strong key={key} className="font-semibold">{renderInline(m[6] ?? m[7], key)}</strong>);
    } else if (m[8] !== undefined) {
      out.push(<del key={key}>{renderInline(m[8], key)}</del>);
    } else if (m[9] !== undefined || m[10] !== undefined) {
      out.push(<em key={key}>{renderInline(m[9] ?? m[10], key)}</em>);
    } else if (m[11]) {
      const href = safeHref(m[11]);
      out.push(href ? <A key={key} href={href}>{m[11]}</A> : m[11]);
    }
    last = idx + m[0].length;
  }
  if (last < text.length) push(text.slice(last));
  return out;
}

/* ------------------------------------------------------------------ render */

const headingClass: Record<number, string> = {
  1: 'text-xl font-bold',
  2: 'text-lg font-semibold',
  3: 'text-base font-semibold',
  4: 'text-sm font-semibold',
  5: 'text-sm font-semibold text-muted',
  6: 'text-xs font-semibold uppercase tracking-wide text-muted',
};

function renderBlocks(blocks: Block[], prefix: string): ReactNode[] {
  return blocks.map((b, idx) => {
    const key = `${prefix}${idx}`;
    switch (b.kind) {
      case 'heading': {
        const Tag = `h${Math.min(6, b.level + 1)}` as 'h2'; // h1 in notes would compete with the page title
        return (
          <Tag key={key} className={`${headingClass[b.level]} mt-5 first:mt-0`}>
            {renderInline(b.text, key)}
          </Tag>
        );
      }
      case 'para':
        return (
          <p key={key} className="mt-3 first:mt-0">
            {renderInline(b.text, key)}
          </p>
        );
      case 'code':
        return (
          <pre key={key} className="scrollbar-thin mt-3 overflow-x-auto rounded-block bg-raised p-3 font-mono text-[13px] leading-relaxed first:mt-0">
            <code>{b.text}</code>
          </pre>
        );
      case 'quote':
        return (
          <blockquote key={key} className="mt-3 border-l-2 border-line pl-3 text-muted first:mt-0">
            {renderBlocks(b.children, `${key}-`)}
          </blockquote>
        );
      case 'hr':
        return <hr key={key} className="my-4 border-line" />;
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={`${key}-${j}`} className={it.checked !== null ? 'list-none' : undefined}>
            {it.checked !== null && (
              <input type="checkbox" checked={it.checked} readOnly disabled className="mr-2 h-3.5 w-3.5 translate-y-0.5 accent-[rgb(var(--accent))]" />
            )}
            {renderInline(it.text, `${key}-${j}`)}
            {it.children.length > 0 && <div className="mt-1">{renderBlocks(it.children, `${key}-${j}-`)}</div>}
          </li>
        ));
        return b.ordered ? (
          <ol key={key} start={b.start} className="mt-3 list-decimal space-y-1 pl-6 first:mt-0">
            {items}
          </ol>
        ) : (
          <ul key={key} className="mt-3 list-disc space-y-1 pl-6 first:mt-0">
            {items}
          </ul>
        );
      }
    }
  });
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const nodes = useMemo(() => renderBlocks(parseBlocks(source.replace(/\r\n?/g, '\n').split('\n')), 'b'), [source]);
  return <div className={`min-w-0 break-words text-sm leading-relaxed ${className ?? ''}`}>{nodes}</div>;
}
