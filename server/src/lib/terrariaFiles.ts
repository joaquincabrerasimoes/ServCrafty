import { badRequest } from './errors.js';
import { WORLD_FILE_RE } from './terrariaConfig.js';

/**
 * Terraria banlist.txt: the server appends `//<player name>` followed by the player's IP.
 * Lines without a preceding `//name` are bare IP (or name) entries.
 */
export interface BanEntry {
  name: string;
  ip?: string;
}

export function parseBanlist(text: string): BanEntry[] {
  const out: BanEntry[] = [];
  let pending: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('//')) {
      if (pending !== null) out.push({ name: pending });
      pending = line.slice(2).trim();
      continue;
    }
    if (pending !== null) {
      out.push({ name: pending || line, ip: line });
      pending = null;
    } else out.push({ name: line, ip: line });
  }
  if (pending !== null) out.push({ name: pending });
  return out;
}

/**
 * Remove every entry whose player name or IP equals `who` (case-insensitive for names).
 * Returns the new file text and how many entries were removed.
 */
export function removeFromBanlist(text: string, who: string): { text: string; removed: number } {
  const target = who.trim().toLowerCase();
  const lines = text.split(/\r?\n/);
  const keep: string[] = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith('//')) {
      const name = line.slice(2).trim().toLowerCase();
      const next = lines[i + 1]?.trim() ?? '';
      const hasIp = !!next && !next.startsWith('//');
      if (name === target || (hasIp && next.toLowerCase() === target)) {
        removed++;
        if (hasIp) i++;
        continue;
      }
      keep.push(lines[i]!);
      if (hasIp) {
        keep.push(lines[i + 1]!);
        i++;
      }
      continue;
    }
    if (line && line.toLowerCase() === target) {
      removed++;
      continue;
    }
    if (line) keep.push(lines[i]!);
  }
  return { text: keep.length ? `${keep.join('\n')}\n` : '', removed };
}

// eslint-disable-next-line no-control-regex
const NAME_BAD = /[\u0000-\u001f\u007f-\u009f"\\]/;

/** Terraria player names: 1-20 characters, no control characters, quotes or backslashes. */
export function validateTerrariaPlayerName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 20 || NAME_BAD.test(n) || /^[-+/]/.test(n)) throw badRequest('Invalid player name', 'invalid_player_name');
  return n;
}

/**
 * Sanitise an uploaded world file name to `<stem>.wld` / `<stem>.twld` with a safe stem
 * (letters, digits, "_" and "-"; other characters become "_"). Any directory part is dropped.
 */
export function sanitizeWorldUpload(filename: string): { stem: string; ext: 'wld' | 'twld' } {
  const base = (filename ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const m = /^(.*)\.(wld|twld)$/i.exec(base);
  if (!m) throw badRequest('Only .wld world files (and their .twld companion) can be imported', 'invalid_world_file');
  const stem = m[1]!
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/^-/, '_')
    .slice(0, 64);
  if (!WORLD_FILE_RE.test(`${stem}.wld`)) throw badRequest('Invalid world file name', 'invalid_world_file');
  return { stem, ext: m[2]!.toLowerCase() as 'wld' | 'twld' };
}
