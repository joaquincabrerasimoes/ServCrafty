import type { Locale } from '@/api/types';
import type { TFn } from '@/i18n';

/** Parsing, building and plain-language description of 5-field cron expressions (minute hour day month weekday). */

export type FieldInfo =
  | { kind: 'any' }
  | { kind: 'step'; n: number; values: number[] }
  | { kind: 'values'; values: number[] };

export interface ParsedCron {
  minute: FieldInfo;
  hour: FieldInfo;
  dom: FieldInfo;
  month: FieldInfo;
  dow: FieldInfo;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function num(s: string, names?: string[], nameBase = 0): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  const i = names?.indexOf(s.toLowerCase().slice(0, 3)) ?? -1;
  return names && s.length >= 3 && i >= 0 ? i + nameBase : null;
}

function parseField(raw: string, min: number, max: number, names?: string[], nameBase = 0): FieldInfo | null {
  if (raw === '*') return { kind: 'any' };
  const set = new Set<number>();
  const parts = raw.split(',');
  let step: number | null = null;
  for (const part of parts) {
    const m = /^(\*|[^/]+?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const [, range, stepRaw] = m;
    const n = stepRaw === undefined ? 1 : Number(stepRaw);
    if (n < 1) return null;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
      if (parts.length === 1 && stepRaw !== undefined) step = n;
    } else if (range!.includes('-')) {
      const [a, b, ...rest] = range!.split('-');
      const x = num(a!, names, nameBase);
      const y = num(b ?? '', names, nameBase);
      if (rest.length || x === null || y === null || x > y) return null;
      lo = x;
      hi = y;
    } else {
      const x = num(range!, names, nameBase);
      if (x === null) return null;
      lo = x;
      hi = stepRaw === undefined ? x : max;
    }
    if (lo < min || hi > max) return null;
    for (let v = lo; v <= hi; v += n) set.add(v);
  }
  const values = [...set].sort((a, b) => a - b);
  if (step === 1) return { kind: 'any' };
  return step ? { kind: 'step', n: step, values } : { kind: 'values', values };
}

export function parseCron(expr: string): ParsedCron | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = parseField(f[0]!, 0, 59);
  const hour = parseField(f[1]!, 0, 23);
  const dom = parseField(f[2]!, 1, 31);
  const month = parseField(f[3]!, 1, 12, MONTHS, 1);
  let dow = parseField(f[4]!, 0, 7, DAYS, 0);
  if (!minute || !hour || !dom || !month || !dow) return null;
  // 7 is another spelling of Sunday.
  if (dow.kind !== 'any') {
    const values = [...new Set(dow.values.map((v) => v % 7))].sort((a, b) => a - b);
    dow = { kind: 'values', values };
  }
  return { minute, hour, dom, month, dow };
}

// ---------------------------------------------------------------- Builder

export type Freq = 'minutes' | 'hours' | 'daily' | 'weekly' | 'monthly';

export interface BuilderState {
  freq: Freq;
  /** every N minutes / every N hours */
  every: number;
  minute: number;
  hour: number;
  /** 0 = Sunday */
  days: number[];
  dayOfMonth: number;
}

export const DEFAULT_BUILDER: BuilderState = { freq: 'daily', every: 6, minute: 0, hour: 4, days: [1], dayOfMonth: 1 };

export function buildCron(b: BuilderState): string {
  switch (b.freq) {
    case 'minutes':
      return b.every <= 1 ? '* * * * *' : `*/${b.every} * * * *`;
    case 'hours':
      return `${b.minute} ${b.every <= 1 ? '*' : `*/${b.every}`} * * *`;
    case 'daily':
      return `${b.minute} ${b.hour} * * *`;
    case 'weekly':
      return `${b.minute} ${b.hour} * * ${[...b.days].sort((a, c) => a - c).join(',') || '1'}`;
    case 'monthly':
      return `${b.minute} ${b.hour} ${b.dayOfMonth} * *`;
  }
}

/** Reads an expression back into builder fields, or null when the builder cannot express it. */
export function detectBuilder(expr: string): BuilderState | null {
  const p = parseCron(expr);
  if (!p) return null;
  const base = DEFAULT_BUILDER;
  const single = (f: FieldInfo) => (f.kind === 'values' && f.values.length === 1 ? f.values[0]! : null);
  const { minute, hour, dom, month, dow } = p;
  if (month.kind !== 'any') return null;
  const allDays = dom.kind === 'any' && dow.kind === 'any';
  if (minute.kind === 'any' && hour.kind === 'any' && allDays) return { ...base, freq: 'minutes', every: 1 };
  if (minute.kind === 'step' && hour.kind === 'any' && allDays && minute.values[0] === 0) return { ...base, freq: 'minutes', every: minute.n };
  const m = single(minute);
  if (m === null) return null;
  if (hour.kind === 'any' && allDays) return { ...base, freq: 'hours', every: 1, minute: m };
  if (hour.kind === 'step' && allDays && hour.values[0] === 0) return { ...base, freq: 'hours', every: hour.n, minute: m };
  const h = single(hour);
  if (h === null) return null;
  if (allDays) return { ...base, freq: 'daily', minute: m, hour: h };
  if (dom.kind === 'any' && dow.kind === 'values') return { ...base, freq: 'weekly', minute: m, hour: h, days: dow.values };
  const d = single(dom);
  if (d !== null && dow.kind === 'any') return { ...base, freq: 'monthly', minute: m, hour: h, dayOfMonth: d };
  return null;
}

// ---------------------------------------------------------------- Description

const pad = (n: number) => String(n).padStart(2, '0');

function names(locale: Locale, kind: 'weekday' | 'month', n: number): string {
  const date = kind === 'weekday' ? new Date(Date.UTC(2023, 0, 1 + n)) : new Date(Date.UTC(2023, n - 1, 1));
  return new Intl.DateTimeFormat(locale, { [kind]: 'long', timeZone: 'UTC' }).format(date);
}

export function weekdayShort(locale: Locale, d: number): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + d)));
}

/** "Monday, Wednesday and Friday"; a run of 3+ consecutive values becomes "Monday to Friday". */
function listOf(values: number[], fmt: (n: number) => string, locale: Locale, t: TFn): string {
  const consecutive = values.length >= 3 && values.every((v, i) => i === 0 || v === values[i - 1]! + 1);
  if (consecutive) return t('cron.d.range', { a: fmt(values[0]!), b: fmt(values[values.length - 1]!) });
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(values.map(fmt));
}

function timePart(p: ParsedCron, locale: Locale, t: TFn): string {
  const { minute, hour } = p;
  const plain = (n: number) => String(n);
  if (minute.kind === 'any' && hour.kind === 'any') return t('cron.d.everyMinute');
  if (minute.kind === 'step' && hour.kind === 'any') return t('cron.d.everyNMinutes', { n: minute.n });
  if (hour.kind === 'any' && minute.kind === 'values') return t('cron.d.minuteOfEveryHour', { m: listOf(minute.values, plain, locale, t) });
  if (minute.kind === 'values' && hour.kind === 'step') {
    return t('cron.d.minuteEveryNHours', { m: listOf(minute.values, plain, locale, t), n: hour.n });
  }
  if (minute.kind === 'values' && hour.kind === 'values' && minute.values.length * hour.values.length <= 6) {
    const times = hour.values.flatMap((h) => minute.values.map((m) => `${pad(h)}:${pad(m)}`));
    return t('cron.d.atTimes', { times: new Intl.ListFormat(locale, { type: 'conjunction' }).format(times) });
  }
  const hours = hour.kind === 'any' ? '' : listOf((hour as { values: number[] }).values, plain, locale, t);
  if (minute.kind === 'any') return t('cron.d.everyMinuteDuring', { h: hours });
  const mins = listOf((minute as { values: number[] }).values, plain, locale, t);
  return hour.kind === 'any' ? t('cron.d.minuteOfEveryHour', { m: mins }) : t('cron.d.atMinutesHours', { m: mins, h: hours });
}

function dayPart(p: ParsedCron, locale: Locale, t: TFn): string {
  const { dom, dow } = p;
  const dowText = dow.kind === 'any' ? '' : listOf(dow.values, (d) => names(locale, 'weekday', d), locale, t);
  if (dom.kind === 'any' && dow.kind === 'any') return '';
  if (dom.kind === 'any') return t('cron.d.onWeekdays', { days: dowText });
  const domText = dom.kind === 'step' ? t('cron.d.everyNDays', { n: dom.n }) : t('cron.d.onDom', { d: listOf(dom.values, String, locale, t) });
  return dow.kind === 'any' ? domText : t('cron.d.domOrDow', { dom: domText, days: dowText });
}

/** One sentence such as "At 04:00, on Monday to Friday"; null when the expression is not a valid 5-field pattern. */
export function describeCron(expr: string, locale: Locale, t: TFn): string | null {
  const p = parseCron(expr);
  if (!p) return null;
  const parts = [timePart(p, locale, t)];
  const day = dayPart(p, locale, t);
  if (day) parts.push(day);
  else if (p.minute.kind === 'values' && p.hour.kind === 'values') parts.push(t('cron.d.everyDay'));
  if (p.month.kind !== 'any') parts.push(t('cron.d.inMonths', { months: listOf(p.month.values, (m) => names(locale, 'month', m), locale, t) }));
  return parts.join(', ');
}
