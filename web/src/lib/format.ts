import { usePrefs } from '@/stores/prefs';

const loc = () => (usePrefs.getState().locale === 'es' ? 'es-ES' : 'en-US');

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(loc(), { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

export const formatMb = (mb: number | null | undefined) =>
  mb === null || mb === undefined ? '–' : mb >= 1024 ? `${(mb / 1024).toLocaleString(loc(), { maximumFractionDigits: 1 })} GB` : `${Math.round(mb)} MB`;

export function formatNumber(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return n.toLocaleString(loc(), { maximumFractionDigits: digits });
}

export function formatCompact(n: number | null | undefined): string {
  if (!n) return '0';
  return new Intl.NumberFormat(loc(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(loc(), { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return iso;
  const diff = (d - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(loc(), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return formatDate(iso);
}

export function formatUptime(sec: number | null | undefined): string {
  if (!sec || sec < 0) return '–';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(sec % 60)}s`;
}

export function joinPath(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, '');
  return `${base}/${name}`.replace(/^\/+/, '/');
}

export function parentPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}
