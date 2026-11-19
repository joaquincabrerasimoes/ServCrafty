/**
 * Parser for Valve KeyValues text files (mission files, addoninfo.txt, ...).
 *
 *   "mission" { "Name" "Dead Center" "modes" { "coop" { "1" { "Map" "c1m1_hotel" } } } }
 *
 * Keys are compared case-insensitively (stored lower-case). A repeated key keeps the last value. Comments
 * (`// ...`) are skipped. Input is untrusted (addon files), so the nesting depth and size are bounded and
 * malformed text yields what was read so far instead of throwing.
 */
export interface KvObject {
  [key: string]: string | KvObject;
}

const MAX_DEPTH = 16;
const MAX_CHARS = 512 * 1024;

type Token = { t: 'str'; v: string } | { t: 'open' } | { t: 'close' };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const n = Math.min(src.length, MAX_CHARS);
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '{') {
      out.push({ t: 'open' });
      i++;
    } else if (c === '}') {
      out.push({ t: 'close' });
      i++;
    } else if (c === '"') {
      let v = '';
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          const e = src[i + 1]!;
          v += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else v += src[i++];
      }
      i++; // closing quote
      out.push({ t: 'str', v });
    } else if (c <= ' ') {
      i++;
    } else {
      // Unquoted token (rare in mission files).
      let v = '';
      while (i < n && src[i]! > ' ' && src[i] !== '{' && src[i] !== '}' && src[i] !== '"') v += src[i++];
      out.push({ t: 'str', v });
    }
  }
  return out;
}

/** Parse a KeyValues document; the top-level keys become the keys of the result. */
export function parseKeyValues(src: string): KvObject {
  const tokens = tokenize(src.replace(/^﻿/, ''));
  let pos = 0;

  function block(depth: number): KvObject {
    const obj: KvObject = {};
    while (pos < tokens.length) {
      const tk = tokens[pos]!;
      if (tk.t === 'close') {
        pos++;
        return obj;
      }
      if (tk.t === 'open') {
        pos++; // stray brace
        continue;
      }
      const key = tk.v.toLowerCase();
      pos++;
      const next = tokens[pos];
      if (!next) break;
      if (next.t === 'open') {
        pos++;
        if (depth >= MAX_DEPTH) {
          // Too deep: skip the block.
          let level = 1;
          while (pos < tokens.length && level > 0) {
            const x = tokens[pos++]!;
            if (x.t === 'open') level++;
            else if (x.t === 'close') level--;
          }
        } else obj[key] = block(depth + 1);
      } else if (next.t === 'str') {
        obj[key] = next.v;
        pos++;
      }
    }
    return obj;
  }

  return block(0);
}

/** `obj[key]` when it is a string. */
export const kvString = (o: KvObject | undefined, key: string): string | undefined => {
  const v = o?.[key.toLowerCase()];
  return typeof v === 'string' ? v : undefined;
};

/** `obj[key]` when it is a nested object. */
export const kvObject = (o: KvObject | undefined, key: string): KvObject | undefined => {
  const v = o?.[key.toLowerCase()];
  return v && typeof v === 'object' ? v : undefined;
};
