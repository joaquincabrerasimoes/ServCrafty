import { z } from 'zod';

/**
 * Game definition (schema v1) for generic SteamCMD games (SPEC "SteamCMD games (v0.3.0)").
 *
 * A definition is pure metadata: the panel resolves it together with a server's config into a
 * plan (`lib/steamPlan.ts`) that the steamcmd image executes. Everything here is zod-strict
 * (unknown keys rejected) and additionally checked by `validateDefinition` for cross-field rules
 * (template references, port ids, safe relative paths, regexes...).
 *
 * This module has no runtime dependencies besides zod so it can be imported from a tsx script
 * (`scripts/validate-game.ts`).
 */

export const GAME_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const PORT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const VAR_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const UI_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Variable keys that would shadow built-in template namespaces. */
const RESERVED_VAR_KEYS = new Set(['ports', 'server', 'workshop']);

export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGHUP', 'SIGUSR1', 'SIGUSR2', 'SIGKILL'] as const;
export const ACCESS_LEVELS = ['viewer', 'operator', 'manager'] as const;

// Strings may not contain NUL; most single-line fields may not contain any control character.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const NUL_RE = /\u0000/;

const line = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !CONTROL_RE.test(s), 'must not contain control characters');
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !NUL_RE.test(s), 'must not contain NUL characters');

const portSchema = z
  .object({
    id: z.string().regex(PORT_ID_RE, 'port id must match ^[a-z][a-z0-9_-]{0,31}$'),
    label: line(60).pipe(z.string().min(1)),
    protocol: z.enum(['udp', 'tcp', 'both']),
    containerPort: z.number().int().min(1).max(65535),
    mirror: z.boolean().default(false),
    publish: z.boolean().default(true),
    main: z.boolean().optional(),
    /** Host port = host port of port `from` + `by` (e.g. a query port at game + 1). */
    offset: z
      .object({ from: z.string().min(1).max(32), by: z.number().int().min(1).max(100) })
      .strict()
      .optional(),
  })
  .strict();

const scalarValue = z.union([z.string().max(1000), z.number().finite(), z.boolean()]);

const variableSchema = z
  .object({
    key: z.string().regex(VAR_KEY_RE, 'variable key must match ^[A-Za-z][A-Za-z0-9_]{0,47}$'),
    label: line(80).pipe(z.string().min(1)),
    description: text(1000).optional(),
    type: z.enum(['string', 'number', 'boolean', 'select', 'password']),
    default: scalarValue.optional(),
    required: z.boolean().default(false),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    /** Number variables only: integers only. */
    integer: z.boolean().optional(),
    options: z
      .array(z.object({ value: line(200), label: line(80).pipe(z.string().min(1)) }).strict())
      .min(1)
      .max(200)
      .optional(),
    pattern: z.string().min(1).max(500).optional(),
    group: line(60).optional(),
    valueMap: z.record(z.string().max(200), line(1000)).optional(),
    /** string/password only: generate a random value server-side when the server is created with it empty. */
    generate: z
      .object({ length: z.number().int().min(8).max(64).default(20), charset: z.enum(['alnum', 'hex']).default('alnum') })
      .strict()
      .optional(),
  })
  .strict();

const varRef = z.string().min(1).max(48);
const commandElement = z.union([
  text(4000),
  z.object({ value: text(4000), if: varRef }).strict(),
  /** Composite argument: non-skipped parts joined by `separator` (e.g. Unreal "map?Game=x?Mutators=y"). */
  z
    .object({
      parts: z.array(z.union([text(4000), z.object({ value: text(4000), if: varRef.optional() }).strict()])).min(1).max(50),
      separator: text(20).default(''),
      if: varRef.optional(),
    })
    .strict(),
]);

const launchSchema = z
  .object({
    cwd: line(500).default(''),
    command: z.array(commandElement).min(1).max(200),
    env: z.record(z.string().regex(ENV_KEY_RE, 'invalid environment variable name'), text(4000)).default({}),
  })
  .strict();

const whenSchema = z.enum(['always', 'missing']).default('always');

const iniSetSchema = z
  .object({ section: line(200).pipe(z.string().min(1)), key: line(200).pipe(z.string().min(1)), value: line(4000) })
  .strict();
const iniListSchema = z
  .object({
    section: line(200).pipe(z.string().min(1)),
    key: line(200).pipe(z.string().min(1)),
    valuesFrom: z.string().regex(/^(workshop|var:[A-Za-z][A-Za-z0-9_]{0,47})$/, 'valuesFrom must be "workshop" or "var:<key>"'),
  })
  .strict();

const fileSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('template'),
      path: line(500),
      content: text(256 * 1024),
      when: whenSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('ini'),
      path: line(500),
      when: whenSchema,
      set: z.array(iniSetSchema).max(500).default([]),
      list: z.array(iniListSchema).max(50).default([]),
    })
    .strict(),
]);

const stopSchema = z
  .object({
    type: z.enum(['signal', 'stdin']),
    signal: z.enum(STOP_SIGNALS).default('SIGINT'),
    command: line(200).optional(),
    timeoutSec: z.number().int().min(1).max(600).default(60),
  })
  .strict();

const webuiSchema = z
  .object({
    id: z.string().regex(UI_ID_RE, 'web UI id must match ^[a-z][a-z0-9-]{0,31}$'),
    label: line(60).pipe(z.string().min(1)),
    portId: z.string().min(1).max(32),
    path: line(500).default('/'),
    auth: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('none') }).strict(),
        z.object({ type: z.literal('basic'), user: line(500), password: line(500) }).strict(),
      ])
      .default({ type: 'none' }),
    minAccess: z.enum(ACCESS_LEVELS).default('manager'),
    rewrite: z.boolean().default(true),
    /** Accept WebSocket upgrades through the proxy (single-page web UIs). */
    websocket: z.boolean().default(false),
  })
  .strict();

export const gameDefinitionSchema = z
  .object({
    schema: z.literal(1),
    id: z.string().regex(GAME_ID_RE, 'id must match ^[a-z0-9][a-z0-9-]{1,39}$'),
    name: line(80).pipe(z.string().min(1)),
    description: text(4000).default(''),
    icon: z
      .string()
      .max(2000)
      .regex(/^https:\/\/[^\s"'<>]+$/, 'icon must be an https URL')
      .nullable()
      .default(null),
    steam: z
      .object({
        appId: z.number().int().positive().max(2 ** 32 - 1),
        branch: z
          .string()
          .regex(/^[A-Za-z0-9_.-]{1,64}$/, 'invalid branch name')
          .nullable()
          .default(null),
        betaPassword: z
          .string()
          .regex(/^[\x21-\x7e]{1,128}$/, 'invalid beta password')
          .nullable()
          .default(null),
        platform: z.enum(['linux', 'windows']).default('linux'),
        login: z.literal('anonymous').default('anonymous'),
      })
      .strict(),
    resources: z
      .object({
        memoryMb: z.number().int().min(256).max(1024 * 1024),
        memoryMinMb: z.number().int().min(256).max(1024 * 1024),
        cpu: z.number().positive().max(256),
        diskMb: z.number().int().min(0).nullable().default(null),
      })
      .strict(),
    ports: z.array(portSchema).min(1).max(16),
    variables: z.array(variableSchema).max(100).default([]),
    launch: launchSchema,
    files: z.array(fileSchema).max(50).default([]),
    stop: stopSchema.default({ type: 'signal', signal: 'SIGINT', timeoutSec: 60 }),
    console: z.object({ stdin: z.boolean() }).strict().default({ stdin: false }),
    ready: z.object({ logRegex: z.string().min(1).max(500) }).strict().nullable().default(null),
    players: z
      .object({ joinRegex: z.string().min(1).max(500), leaveRegex: z.string().min(1).max(500) })
      .strict()
      .nullable()
      .default(null),
    query: z
      .object({ a2s: z.object({ portId: z.string().min(1).max(32) }).strict().optional() })
      .strict()
      .nullable()
      .default(null),
    workshop: z
      .object({
        appId: z.number().int().positive().max(2 ** 32 - 1),
        install: z.enum(['steamcmd', 'config-list']),
        dir: line(500).optional(),
      })
      .strict()
      .nullable()
      .default(null),
    webui: z.array(webuiSchema).max(8).default([]),
    scripts: z
      .object({ postInstall: text(64 * 1024).optional(), preStart: text(64 * 1024).optional() })
      .strict()
      .default({}),
  })
  .strict();

/** A definition after parsing (defaults filled). */
export type GameDefinition = z.output<typeof gameDefinitionSchema>;
export type GameDefinitionInput = z.input<typeof gameDefinitionSchema>;
export type GamePort = GameDefinition['ports'][number];
export type GameVariable = GameDefinition['variables'][number];
export type GameFile = GameDefinition['files'][number];
export type GameWebui = GameDefinition['webui'][number];

export interface DefinitionIssue {
  path: string;
  message: string;
}

export type DefinitionValidation =
  | { ok: true; definition: GameDefinition; errors: [] }
  | { ok: false; errors: DefinitionIssue[] };

// ---------------------------------------------------------------------------------------------
// Templates

/** `{{ name }}` occurrences. Names are validated separately so malformed ones are reported. */
export const TEMPLATE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const TEMPLATE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)?$/;

/** The template names referenced by `s` (in order, possibly repeated). */
export function templateRefs(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(TEMPLATE_RE)) out.push(m[1] ?? '');
  return out;
}

/** True when `s` has a `{{` that is not part of a well-formed `{{name}}`. */
function hasStrayOpen(s: string): boolean {
  return s.replace(TEMPLATE_RE, '').includes('{{');
}

/** Names a template may reference in a definition. */
export function templateScope(def: Pick<GameDefinition, 'variables' | 'ports'>): Set<string> {
  const names = new Set<string>(['server.name', 'server.id', 'workshop.ids']);
  for (const v of def.variables) names.add(v.key);
  for (const p of def.ports) names.add(`ports.${p.id}`);
  return names;
}

/** The index of the main port: the one with `main: true`, else the first. */
export function mainPortIndex(def: Pick<GameDefinition, 'ports'>): number {
  const i = def.ports.findIndex((p) => p.main === true);
  return i >= 0 ? i : 0;
}

export function mainPort(def: Pick<GameDefinition, 'ports'>): GamePort {
  return def.ports[mainPortIndex(def)]!;
}

/** A path relative to the game install dir: no `..`, not absolute, forward slashes only. */
export function unsafeRelPathReason(p: string, allowEmpty = false): string | null {
  if (p === '') return allowEmpty ? null : 'path must not be empty';
  if (p.includes('\\')) return 'path must use forward slashes';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'path must be relative';
  if (p.includes('{{')) return 'path must not contain templates';
  const segs = p.split('/');
  if (segs.some((s) => s === '..')) return "path must not contain '..'";
  if (segs.some((s, i) => s === '' && i !== segs.length - 1)) return 'path must not contain empty segments';
  return null;
}

/** A variable `pattern` must match the WHOLE value (it is implicitly anchored). */
export function matchesPattern(pattern: string, value: string): boolean {
  return new RegExp(`^(?:${pattern})$`, 'u').test(value);
}

function regexError(src: string, flags = ''): string | null {
  try {
    new RegExp(src, flags);
    return null;
  } catch (e) {
    return `invalid regular expression: ${(e as Error).message}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Validation

/**
 * Validate a definition: zod-strict shape first, then the cross-field rules. Returns every
 * problem found (shape errors stop the semantic pass since the object is not usable yet).
 */
export function validateDefinition(input: unknown): DefinitionValidation {
  const r = gameDefinitionSchema.safeParse(input);
  if (!r.success) {
    return {
      ok: false,
      errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const def = r.data;
  const errors = semanticErrors(def);
  if (errors.length) return { ok: false, errors };
  return { ok: true, definition: def, errors: [] };
}

function semanticErrors(def: GameDefinition): DefinitionIssue[] {
  const errors: DefinitionIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });

  // --- resources
  if (def.resources.memoryMinMb > def.resources.memoryMb) err('resources.memoryMinMb', 'must be <= resources.memoryMb');

  // --- ports
  const portIds = new Map<string, GamePort>();
  const mains = def.ports.filter((p) => p.main === true).length;
  if (mains > 1) err('ports', 'exactly one port may have "main": true');
  const bound = new Set<string>();
  def.ports.forEach((p, i) => {
    if (portIds.has(p.id)) err(`ports.${i}.id`, `duplicate port id "${p.id}"`);
    portIds.set(p.id, p);
    if (p.mirror && !p.publish) err(`ports.${i}.mirror`, 'a mirror port must be published');
    if (!p.mirror) {
      for (const proto of p.protocol === 'both' ? ['tcp', 'udp'] : [p.protocol]) {
        const k = `${p.containerPort}/${proto}`;
        if (bound.has(k)) err(`ports.${i}.containerPort`, `container port ${k} is declared twice`);
        bound.add(k);
      }
    }
  });
  const main = def.ports[mainPortIndex(def)];
  if (main && !main.publish) err(`ports.${mainPortIndex(def)}.publish`, 'the main port must be published');
  def.ports.forEach((p, i) => {
    if (!p.offset) return;
    const at = `ports.${i}.offset`;
    if (p === main) err(at, 'the main port cannot be an offset port');
    if (!p.publish) err(`ports.${i}.publish`, 'an offset port must be published');
    const base = portIds.get(p.offset.from);
    if (!base) err(`${at}.from`, `unknown port "${p.offset.from}"`);
    else if (base === p) err(`${at}.from`, 'a port cannot be an offset of itself');
    else if (base.offset) err(`${at}.from`, `port "${base.id}" is itself an offset port (no chains)`);
    else if (!base.publish) err(`${at}.from`, `port "${base.id}" is not published`);
  });
  // Two offset ports of the same base with the same distance would get the same host port.
  const offsetKeys = new Set<string>();
  def.ports.forEach((p, i) => {
    if (!p.offset) return;
    const k = `${p.offset.from}+${p.offset.by}`;
    if (offsetKeys.has(k)) err(`ports.${i}.offset`, `another port already uses ${p.offset.from} + ${p.offset.by}`);
    offsetKeys.add(k);
  });

  // --- variables
  const varKeys = new Map<string, GameVariable>();
  def.variables.forEach((v, i) => {
    const at = `variables.${i}`;
    if (varKeys.has(v.key)) err(`${at}.key`, `duplicate variable key "${v.key}"`);
    if (RESERVED_VAR_KEYS.has(v.key)) err(`${at}.key`, `"${v.key}" is reserved`);
    varKeys.set(v.key, v);
    if (v.min !== undefined && v.max !== undefined && v.min > v.max) err(`${at}.min`, 'must be <= max');
    if ((v.min !== undefined || v.max !== undefined) && v.type !== 'number' && v.type !== 'string' && v.type !== 'password') {
      err(`${at}.min`, 'min/max apply to number (value) and string/password (length) variables only');
    }
    if (v.integer !== undefined && v.type !== 'number') err(`${at}.integer`, 'applies to number variables only');
    if (v.pattern !== undefined) {
      if (v.type !== 'string' && v.type !== 'password') err(`${at}.pattern`, 'applies to string/password variables only');
      const re = regexError(v.pattern, 'u');
      if (re) err(`${at}.pattern`, re);
    }
    if (v.generate) {
      if (v.type !== 'string' && v.type !== 'password') err(`${at}.generate`, 'applies to string/password variables only');
      if (v.default !== undefined) err(`${at}.generate`, 'cannot be combined with a default');
      if (v.pattern !== undefined) err(`${at}.generate`, 'cannot be combined with a pattern');
      if (v.min !== undefined && v.generate.length < v.min) err(`${at}.generate.length`, 'is below min');
      if (v.max !== undefined && v.generate.length > v.max) err(`${at}.generate.length`, 'is above max');
    }
    if (v.type === 'select' && !v.options?.length) err(`${at}.options`, 'select variables need options');
    if (v.type !== 'select' && v.options) err(`${at}.options`, 'options apply to select variables only');
    if (v.options) {
      const seen = new Set<string>();
      v.options.forEach((o, j) => {
        if (seen.has(o.value)) err(`${at}.options.${j}.value`, `duplicate option "${o.value}"`);
        seen.add(o.value);
      });
    }
    if (v.default !== undefined) {
      const d = v.default;
      const bad = (m: string) => err(`${at}.default`, m);
      switch (v.type) {
        case 'number':
          if (typeof d !== 'number') bad('must be a number');
          else {
            if (v.min !== undefined && d < v.min) bad('is below min');
            if (v.max !== undefined && d > v.max) bad('is above max');
            if (v.integer && !Number.isInteger(d)) bad('must be an integer');
          }
          break;
        case 'boolean':
          if (typeof d !== 'boolean') bad('must be a boolean');
          break;
        case 'select':
          if (typeof d !== 'string' || !v.options?.some((o) => o.value === d)) bad('must be one of the options');
          break;
        case 'string':
        case 'password':
          if (typeof d !== 'string') bad('must be a string');
          else if (CONTROL_RE.test(d)) bad('must not contain control characters');
          else if (v.pattern && d !== '' && !regexError(v.pattern, 'u') && !matchesPattern(v.pattern, d)) {
            bad('does not match pattern');
          }
          break;
      }
    }
  });

  // --- templates
  const scope = templateScope(def);
  const checkTemplates = (s: string, path: string) => {
    if (hasStrayOpen(s)) err(path, 'malformed template: "{{" without a matching "}}" or with an invalid name');
    for (const name of templateRefs(s)) {
      if (!TEMPLATE_NAME_RE.test(name)) err(path, `malformed template name "{{${name}}}"`);
      else if (!scope.has(name)) {
        if (name.startsWith('ports.')) err(path, `unknown port "${name.slice(6)}" in "{{${name}}}"`);
        else err(path, `unknown template name "{{${name}}}"`);
      }
    }
  };

  // launch
  const cwdBad = unsafeRelPathReason(def.launch.cwd, true);
  if (cwdBad) err('launch.cwd', cwdBad);
  const checkIf = (key: string | undefined, path: string) => {
    if (key !== undefined && !varKeys.has(key)) err(path, `"if" must reference a variable; "${key}" is not defined`);
  };
  def.launch.command.forEach((el, i) => {
    const at = `launch.command.${i}`;
    if (typeof el === 'string') checkTemplates(el, at);
    else if ('parts' in el) {
      checkIf(el.if, `${at}.if`);
      checkTemplates(el.separator, `${at}.separator`);
      el.parts.forEach((part, j) => {
        if (typeof part === 'string') checkTemplates(part, `${at}.parts.${j}`);
        else {
          checkTemplates(part.value, `${at}.parts.${j}.value`);
          checkIf(part.if, `${at}.parts.${j}.if`);
        }
      });
    } else {
      checkTemplates(el.value, `${at}.value`);
      checkIf(el.if, `${at}.if`);
    }
  });
  if (typeof def.launch.command[0] !== 'string') err('launch.command.0', 'the program (first element) must be unconditional');
  for (const [k, v] of Object.entries(def.launch.env)) checkTemplates(v, `launch.env.${k}`);

  // files
  const filePaths = new Set<string>();
  def.files.forEach((f, i) => {
    const at = `files.${i}`;
    const pBad = unsafeRelPathReason(f.path);
    if (pBad) err(`${at}.path`, pBad);
    if (filePaths.has(f.path)) err(`${at}.path`, `file "${f.path}" is declared twice`);
    filePaths.add(f.path);
    if (f.type === 'template') checkTemplates(f.content, `${at}.content`);
    else {
      if (!f.set.length && !f.list.length) err(at, 'an ini file needs at least one "set" or "list" entry');
      f.set.forEach((s, j) => {
        checkTemplates(s.value, `${at}.set.${j}.value`);
        if (s.section.includes(']')) err(`${at}.set.${j}.section`, 'must not contain "]"');
        if (s.key.includes('=')) err(`${at}.set.${j}.key`, 'must not contain "="');
      });
      f.list.forEach((l, j) => {
        if (l.section.includes(']')) err(`${at}.list.${j}.section`, 'must not contain "]"');
        if (l.key.includes('=')) err(`${at}.list.${j}.key`, 'must not contain "="');
        if (l.valuesFrom === 'workshop') {
          if (!def.workshop) err(`${at}.list.${j}.valuesFrom`, '"workshop" requires a "workshop" section');
        } else {
          const key = l.valuesFrom.slice(4);
          if (!varKeys.has(key)) err(`${at}.list.${j}.valuesFrom`, `variable "${key}" is not defined`);
        }
      });
    }
  });

  // stop / console
  if (def.stop.type === 'stdin') {
    if (!def.stop.command) err('stop.command', 'a stdin stop needs a command');
    if (!def.console.stdin) err('stop.type', 'a stdin stop requires "console": {"stdin": true}');
  }

  // regexes
  if (def.ready) {
    const re = regexError(def.ready.logRegex);
    if (re) err('ready.logRegex', re);
  }
  if (def.players) {
    for (const k of ['joinRegex', 'leaveRegex'] as const) {
      const src = def.players[k];
      const re = regexError(src);
      if (re) err(`players.${k}`, re);
      else if (!/\(\?<name>/.test(src)) err(`players.${k}`, 'must contain a named group (?<name>...)');
    }
  }

  // query
  if (def.query?.a2s) {
    const p = portIds.get(def.query.a2s.portId);
    if (!p) err('query.a2s.portId', `unknown port "${def.query.a2s.portId}"`);
    else if (p.protocol === 'tcp') err('query.a2s.portId', 'the A2S query port must be udp');
  }

  // workshop
  if (def.workshop) {
    if (def.workshop.install === 'steamcmd' && !def.workshop.dir) err('workshop.dir', 'required when install is "steamcmd"');
    if (def.workshop.dir !== undefined) {
      const dBad = unsafeRelPathReason(def.workshop.dir);
      if (dBad) err('workshop.dir', dBad);
    }
  }

  // web UIs
  const uiIds = new Set<string>();
  def.webui.forEach((w, i) => {
    const at = `webui.${i}`;
    if (uiIds.has(w.id)) err(`${at}.id`, `duplicate web UI id "${w.id}"`);
    uiIds.add(w.id);
    const p = portIds.get(w.portId);
    if (!p) err(`${at}.portId`, `unknown port "${w.portId}"`);
    else if (p.protocol === 'udp') err(`${at}.portId`, 'a web UI port must be tcp');
    if (!w.path.startsWith('/')) err(`${at}.path`, 'must start with "/"');
    if (/[\s?#]/.test(w.path) || w.path.includes('..') || w.path.startsWith('//')) {
      err(`${at}.path`, 'must be a plain absolute path (no "..", "//", query or fragment)');
    }
    checkTemplates(w.path, `${at}.path`);
    if (w.auth.type === 'basic') {
      checkTemplates(w.auth.user, `${at}.auth.user`);
      checkTemplates(w.auth.password, `${at}.auth.password`);
      if (w.auth.user.includes(':')) err(`${at}.auth.user`, 'must not contain ":"');
    }
  });

  return errors;
}

/** Parse a definition or throw an Error listing the problems (for trusted callers/tests). */
export function parseDefinition(input: unknown): GameDefinition {
  const r = validateDefinition(input);
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; '));
  return r.definition;
}
