import { z } from 'zod';
import { badRequest } from './errors.js';
import { TERRARIA_VARIANTS, type TerrariaType } from './games.js';

/**
 * Terraria server configuration (`servers.terraria`), shared by the three variants.
 *
 * World creation values (worldName/size/difficulty/seed) only matter while the world file does
 * not exist (autocreate); password/maxPlayers/motd/secure/language/mods apply on every start.
 *
 * Every value ends up either in a container env var or in one element of the container command
 * (never a shell string). The images then write some values into a `key=value` config file, and
 * Terraria parses its command line as `-key value` pairs, so values are restricted to never
 * contain line breaks/control characters, quotes, backslashes, `$`/backticks, and never start
 * with `-`/`+` (which Terraria would read as another switch).
 */

export const TERRARIA_LANGUAGES = ['en-US', 'de-DE', 'it-IT', 'fr-FR', 'es-ES', 'ru-RU', 'zh-Hans', 'pt-BR', 'pl-PL'] as const;
export type TerrariaLanguage = (typeof TERRARIA_LANGUAGES)[number];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SHELLISH = /["\\`$]/;
const NO_SWITCH = (s: string) => !/^[-+]/.test(s);

const WORLD_TEXT = /^[A-Za-z0-9 _-]*$/;
/** World file names produced by ServCrafty (generated or sanitised uploads). */
export const WORLD_FILE_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}\.wld$/;

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const terrariaConfigSchema = z
  .object({
    worldName: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(WORLD_TEXT, 'may only contain letters, digits, spaces, "_" and "-"')
      .refine(NO_SWITCH, 'must not start with "-" or "+"')
      .default('ServCrafty'),
    size: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
    /** 0 normal, 1 expert, 2 master, 3 journey. */
    difficulty: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).default(0),
    seed: z
      .string()
      .trim()
      .max(40)
      .regex(WORLD_TEXT, 'may only contain letters, digits, spaces, "_" and "-"')
      .refine(NO_SWITCH, 'must not start with "-" or "+"')
      .optional(),
    maxPlayers: int(1, 255).default(8),
    password: z
      .string()
      .max(64)
      .refine((s) => !CONTROL.test(s), 'must not contain control characters or line breaks')
      .refine((s) => !SHELLISH.test(s) && !s.includes("'"), 'must not contain quotes, backslashes, "$" or backticks')
      .refine((s) => s === s.trim(), 'must not start or end with spaces')
      .refine(NO_SWITCH, 'must not start with "-" or "+"')
      .optional(),
    motd: z
      .string()
      .trim()
      .max(100)
      .refine((s) => !CONTROL.test(s), 'must not contain control characters or line breaks')
      .refine((s) => !SHELLISH.test(s), 'must not contain double quotes, backslashes, "$" or backticks')
      .refine(NO_SWITCH, 'must not start with "-" or "+"')
      .optional(),
    secure: z.boolean().default(true),
    language: z.enum(TERRARIA_LANGUAGES).optional(),
    /** tModLoader only: Steam Workshop ids, downloaded and enabled on start. */
    workshopMods: z
      .array(z.string().trim().regex(/^\d{1,20}$/, 'must be a numeric Steam Workshop id'))
      .max(200)
      .optional(),
    /** World file (in the server's Worlds dir) to load; set by the world import. Default: derived from worldName. */
    worldFile: z.string().regex(WORLD_FILE_RE, 'must be a file name like "My_World.wld"').optional(),
  })
  .strict();

export type TerrariaConfig = z.output<typeof terrariaConfigSchema>;
export type TerrariaConfigInput = z.input<typeof terrariaConfigSchema>;

function fail(issue: { path: (string | number)[]; message: string } | undefined): never {
  const where = issue?.path.length ? `terraria.${issue.path.join('.')}: ` : 'terraria: ';
  throw badRequest(`${where}${issue?.message ?? 'invalid configuration'}`, 'invalid_terraria_config');
}

/**
 * Validate a client-supplied config for a Terraria server type and fill in the defaults.
 * Empty optional strings are dropped. Throws 400 `invalid_terraria_config`.
 */
export function normalizeTerrariaConfig(type: TerrariaType, input: unknown): TerrariaConfig {
  const raw: Record<string, unknown> = {};
  if (input !== undefined && input !== null) {
    if (typeof input !== 'object' || Array.isArray(input)) fail({ path: [], message: 'must be an object' });
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' && v.trim() === '' && k !== 'worldName') continue;
      raw[k] = v;
    }
  }
  const r = terrariaConfigSchema.safeParse(raw);
  if (!r.success) fail(r.error.issues[0]);
  const cfg = r.data;
  if (cfg.workshopMods !== undefined) {
    if (type !== 'TMODLOADER') fail({ path: ['workshopMods'], message: 'Workshop mods are only supported on tModLoader servers' });
    cfg.workshopMods = [...new Set(cfg.workshopMods)];
    if (!cfg.workshopMods.length) delete cfg.workshopMods;
  }
  return cfg;
}

/**
 * PATCH semantics: merge `patch` over `current` (a `null` value removes an optional field, a
 * `null` patch resets to the defaults) and validate the whole result.
 */
export function mergeTerrariaConfig(type: TerrariaType, current: TerrariaConfig | null, patch: unknown): TerrariaConfig {
  if (patch === null) return normalizeTerrariaConfig(type, {});
  if (typeof patch !== 'object' || Array.isArray(patch)) fail({ path: [], message: 'must be an object' });
  const merged: Record<string, unknown> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  return normalizeTerrariaConfig(type, merged);
}

/** World file name for a config: the imported file, else derived from the world name. */
export function worldFileFor(cfg: TerrariaConfig): string {
  return cfg.worldFile ?? `${cfg.worldName.replace(/ /g, '_')}.wld`;
}

/** hexlo/terraria-server-docker expects languages as "en/US". */
function hexloLanguage(lang: TerrariaLanguage): string {
  return lang.replace('-', '/');
}

const bit = (b: boolean) => (b ? '1' : '0');

/** Env for `hexlo/terraria-server-docker` (lower-case vars written into its server config file). */
export function vanillaEnv(cfg: TerrariaConfig): Record<string, string> {
  const v = TERRARIA_VARIANTS.TERRARIA;
  const env: Record<string, string> = {
    world: worldFileFor(cfg),
    worldpath: v.containerWorldsDir,
    worldname: cfg.worldName,
    autocreate: String(cfg.size),
    difficulty: String(cfg.difficulty),
    maxplayers: String(cfg.maxPlayers),
    port: String(v.containerPort),
    secure: bit(cfg.secure),
    upnp: '0',
    banlist: `${v.mounts[0]!.container}/${v.banlistRel}`,
    // Always set so the image defaults ("Welcome!", a stale password) never apply.
    password: cfg.password ?? '',
    motd: cfg.motd ?? '',
  };
  if (cfg.seed) env.seed = cfg.seed;
  if (cfg.language) env.language = hexloLanguage(cfg.language);
  return env;
}

/** Env for `jacobsmile/tmodloader1.4` (TMOD_* vars). */
export function tmodloaderEnv(cfg: TerrariaConfig): Record<string, string> {
  const env: Record<string, string> = {
    TMOD_WORLDNAME: worldFileFor(cfg).replace(/\.wld$/, ''),
    TMOD_WORLDSIZE: String(cfg.size),
    // The image default seed is "Docker"; an empty value lets Terraria pick a random one.
    TMOD_WORLDSEED: cfg.seed ?? '',
    TMOD_DIFFICULTY: String(cfg.difficulty),
    TMOD_MAXPLAYERS: String(cfg.maxPlayers),
    // The image default password is "docker"; "N/A" is its value for "no password".
    TMOD_PASS: cfg.password ?? 'N/A',
    TMOD_MOTD: cfg.motd ?? '',
    TMOD_SECURE: bit(cfg.secure),
    TMOD_LANGUAGE: cfg.language ?? 'en-US',
    TMOD_UPNP: '0',
    TMOD_PORT: String(TERRARIA_VARIANTS.TMODLOADER.containerPort),
  };
  if (cfg.workshopMods?.length) {
    env.TMOD_AUTODOWNLOAD = cfg.workshopMods.join(',');
    env.TMOD_ENABLEDMODS = cfg.workshopMods.join(',');
  }
  return env;
}

/** Command-line arguments appended to the TShock image entrypoint (one array element per token). */
export function tshockArgs(cfg: TerrariaConfig): string[] {
  const v = TERRARIA_VARIANTS.TSHOCK;
  const args = [
    '-port',
    String(v.containerPort),
    '-world',
    `${v.containerWorldsDir}/${worldFileFor(cfg)}`,
    '-autocreate',
    String(cfg.size),
    '-worldname',
    cfg.worldName,
    '-difficulty',
    String(cfg.difficulty),
    '-maxplayers',
    String(cfg.maxPlayers),
  ];
  if (cfg.seed) args.push('-seed', cfg.seed);
  if (cfg.password) args.push('-password', cfg.password);
  if (cfg.motd) args.push('-motd', cfg.motd);
  if (cfg.secure) args.push('-secure');
  if (cfg.language) args.push('-lang', cfg.language);
  return args;
}

/** Env keys generated by ServCrafty for a variant; user `env` may not override them. */
export function protectedTerrariaEnv(type: TerrariaType): Set<string> {
  const sample = normalizeTerrariaConfig(type, { seed: 'x', language: 'en-US', password: 'x', motd: 'x' });
  if (type === 'TERRARIA') return new Set(Object.keys(vanillaEnv(sample)).concat(['seed', 'language']));
  if (type === 'TMODLOADER')
    return new Set(Object.keys(tmodloaderEnv({ ...sample, workshopMods: ['1'] })).concat(['TMOD_USECONFIGFILE']));
  return new Set();
}

/** Container env + cmd for a Terraria variant. */
export function terrariaLaunch(type: TerrariaType, cfg: TerrariaConfig): { env: Record<string, string>; cmd: string[] | undefined } {
  switch (type) {
    case 'TERRARIA':
      return { env: vanillaEnv(cfg), cmd: undefined };
    case 'TMODLOADER':
      return { env: tmodloaderEnv(cfg), cmd: undefined };
    case 'TSHOCK':
      return { env: {}, cmd: tshockArgs(cfg) };
  }
}
