import crypto from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import {
  mainPort,
  matchesPattern,
  TEMPLATE_RE,
  type GameDefinition,
  type GamePort,
  type GameVariable,
} from './gameDefinition.js';

/**
 * Per-server SteamCMD config (`servers.steam`) and the plan the panel hands to the steamcmd image
 * (`/servcrafty/plan.json`). Everything here is pure so it can be unit tested without Docker or a DB.
 */

export type SteamVarValue = string | number | boolean;

export interface SteamWorkshopItem {
  id: string;
  title?: string;
}

export interface SteamConfig {
  gameId: string;
  vars: Record<string, SteamVarValue>;
  workshop: SteamWorkshopItem[];
  /** Run SteamCMD `app_update` on every start (default true). */
  updateOnStart: boolean;
  /** Next start runs `app_update ... validate` (set by POST /servers/:id/steam/update; cleared after the start). */
  validateNext: boolean;
  /** Next start deletes the downloaded Workshop content first (POST /servers/:id/workshop/refresh). */
  workshopRefresh?: boolean;
}

export const WORKSHOP_ID_RE = /^[1-9][0-9]{0,19}$/;
export const MAX_WORKSHOP_ITEMS = 200;

export const workshopItemSchema = z
  .object({
    id: z.string().regex(WORKSHOP_ID_RE, 'invalid Workshop id'),
    title: z
      .string()
      .max(200)
      // eslint-disable-next-line no-control-regex
      .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
      .optional(),
  })
  .strict();

const varValueSchema = z.union([z.string().max(4000), z.number().finite(), z.boolean()]);

/** `steam` object accepted by POST /servers (and carried by clone/templates). */
export const steamInputSchema = z
  .object({
    gameId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'invalid game id'),
    vars: z.record(z.string().max(64), varValueSchema).default({}),
    updateOnStart: z.boolean().optional(),
    workshop: z.array(workshopItemSchema).max(MAX_WORKSHOP_ITEMS).optional(),
  })
  .strict();
export type SteamInput = z.input<typeof steamInputSchema>;

/** `steam` object accepted by PATCH /servers/:id (vars are merged; null removes a value = back to default). */
export const steamPatchSchema = z
  .object({
    gameId: z.string().max(64).optional(),
    vars: z.record(z.string().max(64), varValueSchema.nullable()).optional(),
    updateOnStart: z.boolean().optional(),
  })
  .strict();
export type SteamPatch = z.infer<typeof steamPatchSchema>;

export interface ConfigIssue {
  path: string;
  message: string;
}

export function invalidSteamConfig(details: ConfigIssue[]): AppError {
  const first = details[0];
  return new AppError(400, 'invalid_steam_config', first ? `${first.path}: ${first.message}` : 'Invalid SteamCMD configuration', details);
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Coerce + check one variable value. Returns the stored value, `undefined` (unset) or an error message. */
const CHARSETS = {
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  hex: '0123456789abcdef',
} as const;

/**
 * Random secret from crypto.randomBytes with an unbiased charset mapping (bytes at or above the
 * largest multiple of the charset size are rejected and redrawn).
 */
export function generateSecret(length: number, charset: keyof typeof CHARSETS = 'alnum'): string {
  const chars = CHARSETS[charset];
  const limit = 256 - (256 % chars.length);
  let out = '';
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b >= limit) continue;
      out += chars[b % chars.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Generate a value for a `generate` variable. */
export function generateVar(v: GameVariable): string {
  if (!v.generate) throw new AppError(400, 'not_generated', `"${v.key}" is not a generated variable`);
  return generateSecret(v.generate.length, v.generate.charset);
}

function checkVar(v: GameVariable, raw: SteamVarValue | undefined): { value?: SteamVarValue; error?: string } {
  if (raw === undefined || raw === '') {
    // A generated variable is filled in by the panel; emptiness never violates `required`.
    if (v.generate) return { value: '' };
    if (v.required && (raw === '' || v.default === undefined || v.default === '')) return { error: 'is required' };
    if (raw === '' && (v.type === 'string' || v.type === 'password')) return { value: '' };
    return v.default !== undefined ? { value: v.default } : v.type === 'boolean' ? { value: false } : {};
  }
  switch (v.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n)) return { error: 'must be a number' };
      if (v.integer && !Number.isInteger(n)) return { error: 'must be an integer' };
      if (v.min !== undefined && n < v.min) return { error: `must be at least ${v.min}` };
      if (v.max !== undefined && n > v.max) return { error: `must be at most ${v.max}` };
      return { value: n };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw };
      if (raw === 'true' || raw === 1 || raw === '1') return { value: true };
      if (raw === 'false' || raw === 0 || raw === '0') return { value: false };
      return { error: 'must be true or false' };
    }
    case 'select': {
      const s = String(raw);
      if (!v.options?.some((o) => o.value === s)) return { error: `must be one of: ${(v.options ?? []).map((o) => o.value).join(', ')}` };
      return { value: s };
    }
    case 'string':
    case 'password': {
      if (typeof raw === 'boolean') return { error: 'must be text' };
      const s = String(raw);
      // A line break could add lines to an ini/config file or a console command.
      if (CONTROL_RE.test(s)) return { error: 'must not contain line breaks or control characters' };
      if (s.length > 1000) return { error: 'must be at most 1000 characters' };
      if (v.min !== undefined && s.length < v.min) return { error: `must be at least ${v.min} characters` };
      if (v.max !== undefined && s.length > v.max) return { error: `must be at most ${v.max} characters` };
      if (v.pattern && !matchesPattern(v.pattern, s)) return { error: 'has an invalid format' };
      return { value: s };
    }
  }
}

/**
 * Validate variables against the definition and fill in defaults.
 * `lenient` drops unknown keys instead of rejecting them (stored configs after a definition change).
 */
export function normalizeSteamVars(
  def: Pick<GameDefinition, 'variables'>,
  input: Record<string, SteamVarValue | null | undefined>,
  opts: { lenient?: boolean; generate?: boolean } = {},
): Record<string, SteamVarValue> {
  const errors: ConfigIssue[] = [];
  const known = new Map(def.variables.map((v) => [v.key, v]));
  for (const k of Object.keys(input)) {
    if (!known.has(k) && !opts.lenient) errors.push({ path: `vars.${k}`, message: 'unknown variable' });
  }
  const out: Record<string, SteamVarValue> = {};
  for (const v of def.variables) {
    const raw = input[v.key];
    const r = checkVar(v, raw === null ? undefined : raw);
    if (r.error) errors.push({ path: `vars.${v.key}`, message: `${v.label} ${r.error}` });
    else if (v.generate && opts.generate && (r.value === undefined || r.value === '')) out[v.key] = generateVar(v);
    else if (r.value !== undefined) out[v.key] = r.value;
  }
  if (errors.length) throw invalidSteamConfig(errors);
  return out;
}

/** Validate a full `steam` object for a new server. */
export function normalizeSteamConfig(def: GameDefinition, input: SteamInput): SteamConfig {
  const parsed = steamInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidSteamConfig(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  const p = parsed.data;
  if (p.gameId !== def.id) throw invalidSteamConfig([{ path: 'gameId', message: 'does not match the definition' }]);
  const workshop = def.workshop ? dedupeWorkshop(p.workshop ?? []) : [];
  if (!def.workshop && p.workshop?.length) throw invalidSteamConfig([{ path: 'workshop', message: 'this game has no Workshop support' }]);
  return {
    gameId: def.id,
    vars: normalizeSteamVars(def, p.vars, { generate: true }),
    workshop,
    updateOnStart: p.updateOnStart ?? true,
    validateNext: false,
  };
}

/** PATCH: merge vars / updateOnStart over the current config and re-validate the whole object. */
export function mergeSteamConfig(def: GameDefinition, current: SteamConfig, patch: SteamPatch): SteamConfig {
  if (patch.gameId !== undefined && patch.gameId !== current.gameId) {
    throw new AppError(400, 'game_change_unsupported', 'A server cannot be switched to another game definition');
  }
  // Values of variables the definition no longer has are dropped silently; unknown keys in the patch are errors.
  const known = new Set(def.variables.map((v) => v.key));
  const base: Record<string, SteamVarValue | null> = {};
  for (const [k, v] of Object.entries(current.vars ?? {})) if (known.has(k)) base[k] = v;
  const merged: Record<string, SteamVarValue | null> = { ...base, ...(patch.vars ?? {}) };
  for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
  return {
    ...current,
    workshop: current.workshop ?? [],
    // An empty (or reset) generated variable gets a fresh value.
    vars: normalizeSteamVars(def, merged as Record<string, SteamVarValue>, { generate: true }),
    updateOnStart: patch.updateOnStart ?? current.updateOnStart ?? true,
    validateNext: current.validateNext ?? false,
  };
}

export function dedupeWorkshop(items: SteamWorkshopItem[]): SteamWorkshopItem[] {
  const seen = new Set<string>();
  const out: SteamWorkshopItem[] = [];
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it.title ? { id: it.id, title: it.title } : { id: it.id });
  }
  return out;
}

/** Keys of the secret (`password`) variables of a definition. */
export function secretVarKeys(def: Pick<GameDefinition, 'variables'> | null): Set<string> {
  return new Set((def?.variables ?? []).filter((v) => v.type === 'password' || !!v.generate).map((v) => v.key));
}

/** Keys of the variables the panel generates. */
export function generatedVarKeys(def: Pick<GameDefinition, 'variables'> | null): Set<string> {
  return new Set((def?.variables ?? []).filter((v) => !!v.generate).map((v) => v.key));
}

/**
 * Generated variables that are empty in a stored config (e.g. the definition gained `generate` later)
 * get a value; returns null when nothing changed.
 */
export function fillGeneratedVars(
  def: Pick<GameDefinition, 'variables'>,
  vars: Record<string, SteamVarValue>,
): Record<string, SteamVarValue> | null {
  let changed = false;
  const out = { ...vars };
  for (const v of def.variables) {
    if (!v.generate) continue;
    const cur = out[v.key];
    if (cur === undefined || cur === '') {
      out[v.key] = generateVar(v);
      changed = true;
    }
  }
  return changed ? out : null;
}

/** Render a launch argument; null = omitted (its `if`, or every part, was skipped). */
export function renderArg(
  el: GameDefinition['launch']['command'][number],
  vars: Record<string, SteamVarValue>,
  r: (s: string) => string,
): string | null {
  if (typeof el === 'string') return r(el);
  if (el.if !== undefined && !isTruthy(vars[el.if])) return null;
  if (!('parts' in el)) return r(el.value);
  const kept: string[] = [];
  for (const part of el.parts) {
    if (typeof part === 'string') kept.push(r(part));
    else if (part.if === undefined || isTruthy(vars[part.if])) kept.push(r(part.value));
  }
  return kept.length ? kept.join(r(el.separator)) : null;
}

/**
 * The steam config as shown to a user: secret values blanked ("") below manager access. Without a
 * definition every string value is treated as potentially secret.
 */
export function publicSteamConfig(
  cfg: SteamConfig | null,
  def: Pick<GameDefinition, 'variables'> | null,
  canSeeSecrets: boolean,
): Omit<SteamConfig, 'workshopRefresh'> | null {
  if (!cfg) return null;
  const { workshopRefresh: _r, ...rest } = cfg;
  void _r;
  if (canSeeSecrets) return { ...rest, vars: { ...cfg.vars } };
  const secret = secretVarKeys(def);
  const vars: Record<string, SteamVarValue> = {};
  for (const [k, v] of Object.entries(cfg.vars ?? {})) {
    vars[k] = (def ? secret.has(k) : typeof v === 'string') ? '' : v;
  }
  return { ...rest, vars };
}

// ---------------------------------------------------------------------------------------------
// Ports

export interface ResolvedPort {
  id: string;
  label: string;
  protocol: GamePort['protocol'];
  /** Port inside the container (the host port for mirror ports). This is what `{{ports.<id>}}` renders. */
  containerPort: number;
  /** Host port, or null when the port is not published. */
  hostPort: number | null;
  main: boolean;
  mirror: boolean;
}

/** Definition ports that need a host port, main first. */
export function publishedPorts(def: Pick<GameDefinition, 'ports'>): GamePort[] {
  const main = mainPort(def);
  return [main, ...def.ports.filter((p) => p !== main && p.publish)];
}

/** Published ports grouped by base port (offset ports follow their base), main group first. */
export function portGroups(def: Pick<GameDefinition, 'ports'>): { id: string; offsets: { id: string; by: number }[] }[] {
  return publishedPorts(def)
    .filter((p) => !p.offset)
    .map((b) => ({
      id: b.id,
      offsets: def.ports.filter((p) => p.publish && p.offset?.from === b.id).map((p) => ({ id: p.id, by: p.offset!.by })),
    }));
}

/** Pure: do the allocated host ports satisfy every offset (`port = base + by`)? Lists the broken base ids. */
export function brokenPortGroups(def: Pick<GameDefinition, 'ports'>, hostPorts: Record<string, number | undefined>): string[] {
  return portGroups(def)
    .filter((g) => {
      const base = hostPorts[g.id];
      if (!Number.isInteger(base)) return true;
      return g.offsets.some((o) => hostPorts[o.id] !== base! + o.by);
    })
    .map((g) => g.id);
}

/**
 * Resolve every definition port against the server's host ports (`servers.port` for the main one,
 * `servers.extra_ports` for the others). Throws when a published port has no allocation.
 */
export function resolvePorts(def: Pick<GameDefinition, 'ports'>, mainHostPort: number, extraPorts: Record<string, number>): ResolvedPort[] {
  const main = mainPort(def);
  const out = def.ports.map((p): ResolvedPort => {
    const hostPort = p === main ? mainHostPort : p.publish ? (extraPorts[p.id] ?? null) : null;
    if (p.publish && (hostPort === null || !Number.isInteger(hostPort))) {
      throw new AppError(409, 'port_not_allocated', `Port "${p.id}" has no host port allocated; edit the server to allocate one`);
    }
    return {
      id: p.id,
      label: p.label,
      protocol: p.protocol,
      containerPort: p.mirror ? hostPort! : p.containerPort,
      hostPort,
      main: p === main,
      mirror: p.mirror,
    };
  });
  // A mirror port takes the host port number inside the container; it must not land on another declared port.
  const seen = new Map<string, string>();
  for (const r of out) {
    for (const proto of r.protocol === 'both' ? ['tcp', 'udp'] : [r.protocol]) {
      const k = `${r.containerPort}/${proto}`;
      const other = seen.get(k);
      if (other) throw new AppError(409, 'port_conflict', `Ports "${other}" and "${r.id}" both use ${k} inside the container`);
      seen.set(k, r.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Templates

export interface RenderContext {
  serverId: string;
  serverName: string;
  ports: ResolvedPort[];
  workshopIds: string[];
}

/** The rendered string value of a variable (after `valueMap`). */
export function renderVar(v: GameVariable | undefined, value: SteamVarValue | undefined): string {
  if (value === undefined) return '';
  const s = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  const mapped = v?.valueMap?.[s];
  return mapped ?? s;
}

/** `if` semantics: non-empty and not false/0. */
export function isTruthy(value: SteamVarValue | undefined): boolean {
  if (value === undefined || value === false || value === 0) return false;
  if (typeof value === 'string') return value !== '' && value !== '0' && value.toLowerCase() !== 'false';
  return true;
}

/** Names -> rendered values for template substitution. */
export function templateValues(def: GameDefinition, vars: Record<string, SteamVarValue>, ctx: RenderContext): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of def.variables) m.set(v.key, renderVar(v, vars[v.key]));
  for (const p of ctx.ports) m.set(`ports.${p.id}`, String(p.containerPort));
  m.set('server.name', ctx.serverName);
  m.set('server.id', ctx.serverId);
  m.set('workshop.ids', ctx.workshopIds.join(','));
  return m;
}

/** Substitute `{{name}}` occurrences. Unknown names throw (definitions are validated beforehand). */
export function renderTemplate(s: string, values: Map<string, string>): string {
  return s.replace(TEMPLATE_RE, (_m, name: string) => {
    const v = values.get(name);
    if (v === undefined) throw new AppError(500, 'template_error', `Unknown template name "${name}"`);
    return v;
  });
}

// ---------------------------------------------------------------------------------------------
// Plan

export type PlanFile =
  | { type: 'template'; path: string; when: 'always' | 'missing'; content: string }
  | {
      type: 'ini';
      path: string;
      when: 'always' | 'missing';
      set: { section: string; key: string; value: string }[];
      list: { section: string; key: string; values: string[] }[];
    };

export interface SteamPlan {
  schema: 1;
  serverName: string;
  steam: {
    appId: number;
    branch: string | null;
    betaPassword: string | null;
    platform: 'linux' | 'windows';
    login: 'anonymous';
    validate: boolean;
    update: boolean;
  };
  workshop: { appId: number; ids: string[]; install: 'steamcmd' | 'config-list'; dir: string | null } | null;
  files: PlanFile[];
  launch: { cwd: string; argv: string[]; env: Record<string, string> };
  stop: { type: 'signal' | 'stdin'; signal: string; command: string | null; timeoutSec: number };
  console: { stdin: boolean };
  ready: { logRegex: string } | null;
  scripts: { postInstall: string | null; preStart: string | null };
}

export interface PlanInput {
  serverId: string;
  serverName: string;
  steam: SteamConfig;
  mainHostPort: number;
  extraPorts: Record<string, number>;
}

/** Split a list variable ("a, b,c") into values. */
function splitList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Resolve definition + server config into the plan. Stored vars are re-validated (leniently: values
 * of variables the definition no longer has are ignored) so nothing unchecked reaches the container.
 */
export function buildPlan(def: GameDefinition, input: PlanInput): { plan: SteamPlan; ports: ResolvedPort[] } {
  const vars = normalizeSteamVars(def, input.steam.vars ?? {}, { lenient: true });
  const ports = resolvePorts(def, input.mainHostPort, input.extraPorts);
  const workshopIds = def.workshop ? dedupeWorkshop(input.steam.workshop ?? []).map((w) => w.id) : [];
  const values = templateValues(def, vars, { serverId: input.serverId, serverName: input.serverName, ports, workshopIds });
  const r = (s: string) => renderTemplate(s, values);
  const known = new Map(def.variables.map((v) => [v.key, v]));

  const argv: string[] = [];
  for (const el of def.launch.command) {
    const arg = renderArg(el, vars, r);
    if (arg !== null) argv.push(arg);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(def.launch.env)) env[k] = r(v);

  const files: PlanFile[] = def.files.map((f): PlanFile => {
    if (f.type === 'template') return { type: 'template', path: f.path, when: f.when, content: r(f.content) };
    return {
      type: 'ini',
      path: f.path,
      when: f.when,
      set: f.set.map((s) => ({ section: s.section, key: s.key, value: r(s.value) })),
      list: f.list.map((l) => {
        let values: string[];
        if (l.valuesFrom === 'workshop') values = workshopIds;
        else {
          const key = l.valuesFrom.slice(4);
          values = splitList(renderVar(known.get(key), vars[key]));
        }
        return { section: l.section, key: l.key, values: [...values] };
      }),
    };
  });

  const validate = !!input.steam.validateNext;
  const plan: SteamPlan = {
    schema: 1,
    serverName: input.serverName,
    steam: {
      appId: def.steam.appId,
      branch: def.steam.branch,
      betaPassword: def.steam.betaPassword,
      platform: def.steam.platform,
      login: def.steam.login,
      validate,
      // "validate" implies an update run; otherwise follow the server's setting.
      update: validate || input.steam.updateOnStart !== false,
    },
    workshop: def.workshop
      ? { appId: def.workshop.appId, ids: workshopIds, install: def.workshop.install, dir: def.workshop.dir ?? null }
      : null,
    files,
    launch: { cwd: def.launch.cwd, argv, env },
    stop: {
      type: def.stop.type,
      signal: def.stop.signal,
      command: def.stop.command ?? null,
      timeoutSec: def.stop.timeoutSec,
    },
    console: { stdin: def.console.stdin },
    ready: def.ready ? { logRegex: def.ready.logRegex } : null,
    scripts: { postInstall: def.scripts.postInstall ?? null, preStart: def.scripts.preStart ?? null },
  };
  return { plan, ports };
}

/** Render a web UI basic-auth credential pair for a server. */
export function renderWebuiAuth(
  def: GameDefinition,
  uiId: string,
  input: Pick<PlanInput, 'serverId' | 'serverName' | 'steam' | 'mainHostPort' | 'extraPorts'>,
): { user: string; password: string } | null {
  const ui = def.webui.find((w) => w.id === uiId);
  if (!ui || ui.auth.type !== 'basic') return null;
  const vars = normalizeSteamVars(def, input.steam.vars ?? {}, { lenient: true });
  const ports = resolvePorts(def, input.mainHostPort, input.extraPorts);
  const workshopIds = def.workshop ? (input.steam.workshop ?? []).map((w) => w.id) : [];
  const values = templateValues(def, vars, { serverId: input.serverId, serverName: input.serverName, ports, workshopIds });
  return { user: renderTemplate(ui.auth.user, values), password: renderTemplate(ui.auth.password, values) };
}
