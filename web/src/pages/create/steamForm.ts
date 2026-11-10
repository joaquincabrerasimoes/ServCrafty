import type { GameVariable, SteamVarValue, SteamVars } from '@/api/types';
import type { TFn } from '@/i18n';

/**
 * Form state for a game definition's variables (wizard Settings step, server Settings tab and the
 * admin form preview). Text-like fields keep their raw string, booleans a boolean. The API
 * validates again (400 invalid_steam_config).
 */
export type SteamForm = Record<string, string | boolean>;

/** string/password variables the panel fills with a random value when left empty. */
export const isGenerated = (v: GameVariable) => (v.type === 'string' || v.type === 'password') && !!v.generate;
export type SteamErrors = Record<string, string>;

const VAR_TYPES = ['string', 'number', 'boolean', 'select', 'password'];

/**
 * The usable variables of a definition. Drops malformed entries so the form can also render a
 * definition that is still being written in the admin editor.
 */
export function cleanVariables(vars: unknown): GameVariable[] {
  if (!Array.isArray(vars)) return [];
  const seen = new Set<string>();
  const out: GameVariable[] = [];
  for (const v of vars) {
    if (!v || typeof v !== 'object') continue;
    const o = v as GameVariable;
    if (typeof o.key !== 'string' || !o.key || seen.has(o.key) || !VAR_TYPES.includes(o.type)) continue;
    seen.add(o.key);
    out.push({ ...o, options: Array.isArray(o.options) ? o.options.filter((x) => x && (typeof x.value === 'string' || typeof x.value === 'number')) : undefined });
  }
  return out;
}

function toField(v: GameVariable, value: SteamVarValue | null | undefined): string | boolean {
  if (v.type === 'boolean') return value === true || value === 'true' || value === 1 || value === '1';
  if (value === null || value === undefined) return '';
  return String(value);
}

export function steamDefaults(vars: GameVariable[]): SteamForm {
  const f: SteamForm = {};
  for (const v of vars) {
    let d = v.default;
    if ((d === undefined || d === null) && v.type === 'select' && v.required && v.options?.length) d = v.options[0]!.value;
    f[v.key] = toField(v, d);
  }
  return f;
}

/** Form state from a server's stored values (missing keys take the default). */
export function steamFromVars(vars: GameVariable[], stored: SteamVars | null | undefined): SteamForm {
  const f = steamDefaults(vars);
  for (const v of vars) if (stored && v.key in stored) f[v.key] = toField(v, stored[v.key]);
  return f;
}

function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function validateSteam(vars: GameVariable[], f: SteamForm, t: TFn, skip?: Set<string>): SteamErrors {
  const e: SteamErrors = {};
  for (const v of vars) {
    if (v.type === 'boolean' || skip?.has(v.key)) continue;
    const raw = String(f[v.key] ?? '');
    const value = v.type === 'password' ? raw : raw.trim();
    if (!value) {
      if (v.required && !isGenerated(v)) e[v.key] = t('steam.err.required');
      continue;
    }
    if (v.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) e[v.key] = t('steam.err.number');
      else if (v.min !== undefined && v.max !== undefined && (n < v.min || n > v.max)) e[v.key] = t('mc.err.range', { min: v.min, max: v.max });
      else if (v.min !== undefined && n < v.min) e[v.key] = t('steam.err.min', { min: v.min });
      else if (v.max !== undefined && n > v.max) e[v.key] = t('steam.err.max', { max: v.max });
      continue;
    }
    if (v.type === 'select') {
      if (v.options?.length && !v.options.some((o) => String(o.value) === value)) e[v.key] = t('steam.err.option');
      continue;
    }
    // string / password: min/max are length limits.
    if (v.min !== undefined && value.length < v.min) e[v.key] = t('steam.err.minLength', { min: v.min });
    else if (v.max !== undefined && value.length > v.max) e[v.key] = t('mc.err.tooLong', { max: v.max });
    else if (v.pattern) {
      const re = compile(v.pattern);
      if (re && !re.test(value)) e[v.key] = t('steam.err.pattern');
    }
  }
  return e;
}

function toValue(v: GameVariable, raw: string | boolean): SteamVarValue | undefined {
  if (v.type === 'boolean') return raw === true;
  const s = v.type === 'password' ? String(raw) : String(raw).trim();
  if (s === '' && isGenerated(v)) return undefined; // the panel generates it
  if (v.type === 'number') return s === '' ? undefined : Number(s);
  if (v.type === 'select') {
    const opt = v.options?.find((o) => String(o.value) === s);
    return opt ? opt.value : s === '' ? undefined : s;
  }
  return s;
}

/** Values for POST /servers `steam.vars` (empty numbers/selects are left out so the API fills the default). */
export function toSteamVars(vars: GameVariable[], f: SteamForm): SteamVars {
  const out: SteamVars = {};
  for (const v of vars) {
    const val = toValue(v, f[v.key] ?? '');
    if (val !== undefined) out[v.key] = val;
  }
  return out;
}

/**
 * Only the values that differ from what the server has stored (PATCH merges `steam.vars`).
 * Keys in `skip` (secrets the API blanked for this user) are never sent unless typed into.
 */
export function diffSteamVars(vars: GameVariable[], f: SteamForm, initial: SteamForm, skip?: Set<string>): SteamVars {
  const out: SteamVars = {};
  for (const v of vars) {
    if (f[v.key] === initial[v.key]) continue;
    if (skip?.has(v.key) && f[v.key] === '') continue;
    // An emptied generated variable is sent as '' so the panel generates a new value.
    const val = toValue(v, f[v.key] ?? '');
    out[v.key] = val === undefined ? '' : val;
  }
  return out;
}

export function displayValue(v: GameVariable, raw: string | boolean | undefined, t: TFn): string {
  if (v.type === 'boolean') return raw === true ? t('common.yes') : t('common.no');
  const s = String(raw ?? '');
  if (!s && isGenerated(v)) return t('steam.generatedReview');
  if (v.type === 'password') return s ? '••••••' : t('steam.notSet');
  if (!s) return t('steam.notSet');
  if (v.type === 'select') {
    const opt = v.options?.find((o) => String(o.value) === s);
    return opt?.label ?? s;
  }
  return s;
}

export function summarizeSteam(vars: GameVariable[], f: SteamForm, t: TFn): Array<[string, string]> {
  return vars.map((v) => [v.label || v.key, displayValue(v, f[v.key], t)]);
}

/** Variables grouped by `group`, groups in order of first appearance; ungrouped ones come first. */
export function groupVariables(vars: GameVariable[]): Array<{ group: string | null; vars: GameVariable[] }> {
  const groups: Array<{ group: string | null; vars: GameVariable[] }> = [];
  for (const v of vars) {
    const name = v.group?.trim() || null;
    let g = groups.find((x) => x.group === name);
    if (!g) {
      g = { group: name, vars: [] };
      if (name === null) groups.unshift(g);
      else groups.push(g);
    }
    g.vars.push(v);
  }
  return groups;
}
