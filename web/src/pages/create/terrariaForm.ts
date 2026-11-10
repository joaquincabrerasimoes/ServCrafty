import { TERRARIA_LANGUAGES, type ServerType, type TerrariaConfig, type TerrariaLanguage } from '@/api/types';
import type { TFn } from '@/i18n';

/**
 * Form state for the Terraria config (wizard "World & game" step and the Settings tab). Limits
 * mirror SPEC.md (TerrariaConfig); the API validates again.
 */
export interface TrForm {
  worldName: string;
  size: TerrariaConfig['size'];
  difficulty: TerrariaConfig['difficulty'];
  seed: string;
  maxPlayers: string;
  password: string;
  motd: string;
  secure: boolean;
  language: TerrariaLanguage | '';
  /** Raw textarea text: ids one per line or comma separated. */
  workshopMods: string;
}

export type TrErrors = Partial<Record<keyof TrForm, string>>;

export const TR_SIZES = [1, 2, 3] as const;
export const TR_DIFFICULTIES = [0, 1, 2, 3] as const;
export const TR_LANGUAGE_NAMES: Record<TerrariaLanguage, string> = {
  'en-US': 'English',
  'de-DE': 'Deutsch',
  'it-IT': 'Italiano',
  'fr-FR': 'Français',
  'es-ES': 'Español',
  'ru-RU': 'Русский',
  'zh-Hans': '简体中文',
  'pt-BR': 'Português (Brasil)',
  'pl-PL': 'Polski',
};

export const WORLD_NAME = /^[A-Za-z0-9 _-]{1,32}$/;
export const TR_SEED = /^[A-Za-z0-9 _-]{0,40}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const PASSWORD_BAD = /["'\\]/;
export const MAX_WORKSHOP_MODS = 200;
/** Total upload limit of POST /servers/:id/terraria/world. */
export const WORLD_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;

export function trDefaults(): TrForm {
  return {
    worldName: 'ServCrafty',
    size: 2,
    difficulty: 0,
    seed: '',
    maxPlayers: '8',
    password: '',
    motd: '',
    secure: true,
    language: '',
    workshopMods: '',
  };
}

export function trFromConfig(c: TerrariaConfig | null | undefined): TrForm {
  const d = trDefaults();
  if (!c) return d;
  return {
    worldName: c.worldName ?? d.worldName,
    size: c.size ?? d.size,
    difficulty: c.difficulty ?? d.difficulty,
    seed: c.seed ?? '',
    maxPlayers: c.maxPlayers != null ? String(c.maxPlayers) : d.maxPlayers,
    password: c.password ?? '',
    motd: c.motd ?? '',
    secure: c.secure ?? true,
    language: c.language && (TERRARIA_LANGUAGES as readonly string[]).includes(c.language) ? c.language : '',
    workshopMods: (c.workshopMods ?? []).join('\n'),
  };
}

/** Splits the Workshop textarea into ids (duplicates removed, order kept). */
export function parseWorkshopIds(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const id = part.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function validateTr(f: TrForm, type: ServerType, t: TFn): TrErrors {
  const e: TrErrors = {};
  if (!WORLD_NAME.test(f.worldName.trim())) e.worldName = t('tr.err.worldName');
  if (f.seed.trim() && !TR_SEED.test(f.seed.trim())) e.seed = t('tr.err.seed');
  const mp = f.maxPlayers.trim();
  if (!/^\d+$/.test(mp) || Number(mp) < 1 || Number(mp) > 255) e.maxPlayers = t('mc.err.range', { min: 1, max: 255 });
  if (f.password.length > 64) e.password = t('mc.err.tooLong', { max: 64 });
  else if (PASSWORD_BAD.test(f.password) || CONTROL.test(f.password)) e.password = t('tr.err.password');
  if (f.motd.length > 100) e.motd = t('mc.err.tooLong', { max: 100 });
  else if (CONTROL.test(f.motd)) e.motd = t('tr.err.control');
  if (type === 'TMODLOADER') {
    const ids = parseWorkshopIds(f.workshopMods);
    const bad = ids.find((id) => !/^\d{1,20}$/.test(id));
    if (bad) e.workshopMods = t('tr.err.workshopId', { id: bad });
    else if (ids.length > MAX_WORKSHOP_MODS) e.workshopMods = t('tr.err.workshopMany', { max: MAX_WORKSHOP_MODS });
  }
  return e;
}

/** Full config for POST /servers (only fields that have a value). */
export function toTerrariaConfig(f: TrForm, type: ServerType): Partial<TerrariaConfig> {
  const c: Partial<TerrariaConfig> = {
    worldName: f.worldName.trim(),
    size: f.size,
    difficulty: f.difficulty,
    maxPlayers: Number(f.maxPlayers.trim()),
    secure: f.secure,
  };
  if (f.seed.trim()) c.seed = f.seed.trim();
  if (f.password) c.password = f.password;
  if (f.motd.trim()) c.motd = f.motd.trim();
  if (f.language) c.language = f.language;
  if (type === 'TMODLOADER') c.workshopMods = parseWorkshopIds(f.workshopMods);
  return c;
}

/**
 * PATCH body for the Settings tab. The API merges it into the stored config, so an optional value
 * the user emptied is sent as null to clear it. World creation fields are left out when locked.
 */
export function toTerrariaPatch(f: TrForm, type: ServerType, worldLocked: boolean): Record<string, unknown> {
  const p: Record<string, unknown> = {
    maxPlayers: Number(f.maxPlayers.trim()),
    secure: f.secure,
    password: f.password ? f.password : null,
    motd: f.motd.trim() ? f.motd.trim() : null,
    language: f.language || null,
  };
  if (!worldLocked) {
    p.worldName = f.worldName.trim();
    p.size = f.size;
    p.difficulty = f.difficulty;
    p.seed = f.seed.trim() ? f.seed.trim() : null;
  }
  if (type === 'TMODLOADER') p.workshopMods = parseWorkshopIds(f.workshopMods);
  return p;
}

export function summarizeTr(c: Partial<TerrariaConfig>, t: TFn, importedWorld: string | null): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (importedWorld) rows.push([t('tr.importWorld'), importedWorld]);
  else {
    rows.push([t('tr.worldName'), c.worldName ?? '']);
    rows.push([t('tr.size'), t(`tr.size.${c.size ?? 2}`)]);
    rows.push([t('tr.difficulty'), t(`tr.difficulty.${c.difficulty ?? 0}`)]);
    rows.push([t('tr.seed'), c.seed || t('tr.seedRandom')]);
  }
  rows.push([t('tr.maxPlayers'), String(c.maxPlayers ?? 8)]);
  rows.push([t('tr.password'), c.password ? '••••••' : t('tr.passwordNone')]);
  if (c.motd) rows.push([t('tr.motd'), c.motd]);
  rows.push([t('tr.secure'), c.secure === false ? t('common.no') : t('common.yes')]);
  rows.push([t('tr.language'), c.language ? TR_LANGUAGE_NAMES[c.language] : t('tr.languageDefault')]);
  if (c.workshopMods) rows.push([t('tr.workshopMods'), c.workshopMods.length ? c.workshopMods.join(', ') : t('tr.workshopNone')]);
  return rows;
}

/** Checks the files picked for a world import; returns an error message or null. */
export function validateWorldFiles(files: File[], type: ServerType, t: TFn): string | null {
  if (!files.length) return null;
  const wld = files.filter((f) => /\.wld$/i.test(f.name));
  const twld = files.filter((f) => /\.twld$/i.test(f.name));
  const other = files.filter((f) => !/\.t?wld$/i.test(f.name));
  if (other.length) return t('tr.err.worldType', { name: other[0]!.name });
  if (twld.length && type !== 'TMODLOADER') return t('tr.err.twldOnlyTml');
  if (wld.length !== 1) return t('tr.err.worldOne');
  if (twld.length > 1) return t('tr.err.worldOne');
  if (twld.length === 1) {
    const base = (n: string) => n.replace(/\.t?wld$/i, '');
    if (base(twld[0]!.name) !== base(wld[0]!.name)) return t('tr.err.twldName');
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > WORLD_UPLOAD_MAX_BYTES) return t('tr.err.worldTooBig', { max: '256 MB' });
  return null;
}
