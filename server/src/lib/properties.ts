/**
 * Minimal Java .properties parser/serializer for server.properties. Supports
 * comments (#, !), `=`/`:` separators, line continuations and unicode escapes.
 */
export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rawLines = text.split(/\r?\n/);
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i]!;
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < rawLines.length) {
      line = line.slice(0, -1) + rawLines[++i]!.replace(/^\s+/, '');
    }
    lines.push(line);
  }
  for (const l of lines) {
    const line = l.replace(/^\s+/, '');
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    let keyEnd = 0;
    let escaped = false;
    for (; keyEnd < line.length; keyEnd++) {
      const c = line[keyEnd]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '=' || c === ':' || c === ' ' || c === '\t') break;
    }
    const key = unescape(line.slice(0, keyEnd));
    let rest = line.slice(keyEnd).replace(/^[ \t]*/, '');
    if (rest.startsWith('=') || rest.startsWith(':')) rest = rest.slice(1).replace(/^[ \t]*/, '');
    out[key] = unescape(rest);
  }
  return out;
}

function unescape(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, g: string) => {
    if (g.startsWith('u') && g.length === 5) return String.fromCharCode(Number.parseInt(g.slice(1), 16));
    switch (g) {
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 'f':
        return '\f';
      default:
        return g;
    }
  });
}

function escapeValue(s: string, isKey: boolean): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const code = c.charCodeAt(0);
    if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (isKey && (c === '=' || c === ':' || c === ' ')) out += '\\' + c;
    else if (!isKey && i === 0 && c === ' ') out += '\\ ';
    else if (c === '#' || c === '!') out += i === 0 && isKey ? '\\' + c : c;
    else if (code > 0x7e || code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += c;
  }
  return out;
}

/**
 * Serialize properties, preserving the key order and comments of `previous` text
 * when supplied. Keys absent from `values` are removed; new keys are appended.
 */
export function serializeProperties(values: Record<string, string>, previous?: string): string {
  const lines: string[] = [];
  const written = new Set<string>();
  if (previous) {
    for (const raw of previous.split(/\r?\n/)) {
      const t = raw.trim();
      if (!t || t.startsWith('#') || t.startsWith('!')) {
        lines.push(raw);
        continue;
      }
      const parsed = parseProperties(raw);
      const key = Object.keys(parsed)[0];
      if (key === undefined) continue;
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        lines.push(`${escapeValue(key, true)}=${escapeValue(values[key]!, false)}`);
        written.add(key);
      }
    }
  } else {
    lines.push('#Minecraft server properties', `#Edited by ServCrafty ${new Date().toISOString()}`);
  }
  for (const [k, v] of Object.entries(values)) {
    if (written.has(k)) continue;
    lines.push(`${escapeValue(k, true)}=${escapeValue(v, false)}`);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}
