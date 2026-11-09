import { z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Initial Minecraft world/server configuration chosen in the create-server wizard.
 *
 * It is stored on the server row (`servers.minecraft`) and translated into itzg image env
 * vars by {@link minecraftEnv} for the *first* start only (while the server has no
 * server.properties yet), so the generated world is already right and later edits made in
 * the Properties tab are never overwritten.
 *
 * Env names verified against:
 *  - itzg/docker-minecraft-server `files/property-definitions.json` + `scripts/start-setupServerProperties`
 *  - itzg/docker-minecraft-bedrock-server `property-definitions.json` + `bedrock-entry.sh`
 */

/** mc-image-helper / set-property expand `%VAR%`, `%env:VAR%`, `%date:..%` placeholders in values. */
const PLACEHOLDER = /%[^%\s]+%/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const safeText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !CONTROL.test(s), 'must not contain control characters or line breaks')
    .refine((s) => !PLACEHOLDER.test(s), 'must not contain %placeholders%');

const levelName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, 'may only contain letters, digits, spaces, "_" and "-" (and must start with a letter or digit)');

/** Java usernames (3-16 word chars; allow 1-2 for legacy accounts) or UUIDs; Bedrock gamertags/XUIDs. */
const playerName = z
  .string()
  .trim()
  .min(1)
  .max(36)
  .regex(/^(?:[A-Za-z0-9_]{1,16}|[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}|[A-Za-z0-9][A-Za-z0-9 _#]{0,19}|\d{15,20})$/, 'is not a valid player name');

const playerList = z
  .array(playerName)
  .max(500)
  .transform((l) => [...new Set(l.filter(Boolean))]);

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const JAVA_LEVEL_TYPES = ['default', 'flat', 'largebiomes', 'amplified', 'single_biome_surface'] as const;
export const BEDROCK_LEVEL_TYPES = ['default', 'flat', 'legacy'] as const;

/** server.properties keys ServCrafty manages (ports, RCON, networking) - never user-settable. */
const PROTECTED_KEYS = new Set([
  'server-port',
  'server-portv6',
  'server-ip',
  'server-udp-ports',
  'enable-rcon',
  'rcon.port',
  'rcon.password',
  'query.port',
  'enable-query',
  'white-list',
  'allow-list',
]);
const PROTECTED_PREFIXES = ['management-server-', 'rcon.'];

const extraKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'invalid server.properties key (lowercase letters, digits, ".", "_", "-")')
  .refine((k) => !PROTECTED_KEYS.has(k) && !PROTECTED_PREFIXES.some((p) => k.startsWith(p)), {
    message: 'this key is managed by ServCrafty and cannot be set',
  });

export const minecraftConfigSchema = z
  .object({
    // General
    levelName: levelName.optional(),
    gameMode: z.enum(['survival', 'creative', 'adventure', 'spectator']).optional(),
    forceGamemode: z.boolean().optional(),
    hardcore: z.boolean().optional(),
    difficulty: z.enum(['peaceful', 'easy', 'normal', 'hard']).optional(),
    motd: safeText(256).optional(),
    maxPlayers: int(1, 1000).optional(),
    pvp: z.boolean().optional(),
    onlineMode: z.boolean().optional(),
    allowFlight: z.boolean().optional(),
    allowCheats: z.boolean().optional(),
    commandBlocks: z.boolean().optional(),
    allowNether: z.boolean().optional(),
    spawnAnimals: z.boolean().optional(),
    spawnMonsters: z.boolean().optional(),
    spawnNpcs: z.boolean().optional(),
    /** Minutes; 0 = never kick. */
    playerIdleTimeout: int(0, 1440).optional(),
    // World generation
    seed: safeText(64).optional(),
    levelType: z.enum([...JAVA_LEVEL_TYPES, 'legacy']).optional(),
    generateStructures: z.boolean().optional(),
    generatorSettings: z
      .string()
      .trim()
      .max(8192)
      .refine((s) => {
        try {
          const v: unknown = JSON.parse(s);
          return typeof v === 'object' && v !== null && !Array.isArray(v);
        } catch {
          return false;
        }
      }, 'must be a JSON object')
      .refine((s) => !PLACEHOLDER.test(s), 'must not contain %placeholders%')
      .optional(),
    spawnProtection: int(0, 10_000).optional(),
    maxWorldSize: int(1, 29_999_984).optional(),
    // Whitelist / ops
    whitelist: z
      .object({
        enabled: z.boolean().optional(),
        enforce: z.boolean().optional(),
        users: playerList.optional(),
      })
      .strict()
      .optional(),
    ops: playerList.optional(),
    // Performance
    viewDistance: int(3, 32).optional(),
    simulationDistance: int(3, 32).optional(),
    tickDistance: int(4, 12).optional(),
    entityBroadcastRange: int(10, 1000).optional(),
    networkCompressionThreshold: int(-1, 65_535).optional(),
    // Resource pack
    resourcePack: z
      .object({
        url: z
          .string()
          .trim()
          .max(2048)
          .url()
          .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL')
          .refine((s) => !PLACEHOLDER.test(s) && !CONTROL.test(s), 'invalid characters')
          .optional(),
        sha1: z
          .string()
          .trim()
          .regex(/^[0-9a-fA-F]{40}$/, 'must be a 40-character hex SHA-1')
          .optional(),
        required: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // Advanced: any other server.properties key
    extra: z.record(extraKey, safeText(1024)).optional(),
  })
  .strict();

export type MinecraftConfig = z.infer<typeof minecraftConfigSchema>;

/** Fields that only exist on Java Edition. */
const JAVA_ONLY: Array<keyof MinecraftConfig> = [
  'hardcore',
  'pvp',
  'allowFlight',
  'commandBlocks',
  'allowNether',
  'spawnAnimals',
  'spawnMonsters',
  'spawnNpcs',
  'generateStructures',
  'generatorSettings',
  'spawnProtection',
  'maxWorldSize',
  'simulationDistance',
  'entityBroadcastRange',
];
/** Fields that only exist on Bedrock Edition. */
const BEDROCK_ONLY: Array<keyof MinecraftConfig> = ['allowCheats', 'tickDistance'];

/** Bedrock server.properties keys the itzg bedrock image can set (key -> env), minus protected ones. */
export const BEDROCK_PROPERTY_ENV: Record<string, string> = {
  'server-name': 'SERVER_NAME',
  gamemode: 'GAMEMODE',
  'force-gamemode': 'FORCE_GAMEMODE',
  difficulty: 'DIFFICULTY',
  'allow-cheats': 'ALLOW_CHEATS',
  'max-players': 'MAX_PLAYERS',
  'online-mode': 'ONLINE_MODE',
  transport: 'TRANSPORT',
  'enable-lan-visibility': 'ENABLE_LAN_VISIBILITY',
  'view-distance': 'VIEW_DISTANCE',
  'tick-distance': 'TICK_DISTANCE',
  'player-idle-timeout': 'PLAYER_IDLE_TIMEOUT',
  'max-threads': 'MAX_THREADS',
  'level-name': 'LEVEL_NAME',
  'level-seed': 'LEVEL_SEED',
  'level-type': 'LEVEL_TYPE',
  'default-player-permission-level': 'DEFAULT_PLAYER_PERMISSION_LEVEL',
  'texturepack-required': 'TEXTUREPACK_REQUIRED',
  'content-log-file-enabled': 'CONTENT_LOG_FILE_ENABLED',
  'content-log-level': 'CONTENT_LOG_LEVEL',
  'content-log-console-output-enabled': 'CONTENT_LOG_CONSOLE_OUTPUT_ENABLED',
  'compression-threshold': 'COMPRESSION_THRESHOLD',
  'compression-algorithm': 'COMPRESSION_ALGORITHM',
  'server-authoritative-movement': 'SERVER_AUTHORITATIVE_MOVEMENT',
  'player-position-acceptance-threshold': 'PLAYER_POSITION_ACCEPTANCE_THRESHOLD',
  'player-movement-score-threshold': 'PLAYER_MOVEMENT_SCORE_THRESHOLD',
  'player-movement-action-direction-threshold': 'PLAYER_MOVEMENT_ACTION_DIRECTION_THRESHOLD',
  'player-movement-distance-threshold': 'PLAYER_MOVEMENT_DISTANCE_THRESHOLD',
  'player-movement-duration-threshold-in-ms': 'PLAYER_MOVEMENT_DURATION_THRESHOLD_IN_MS',
  'correct-player-movement': 'CORRECT_PLAYER_MOVEMENT',
  'server-authoritative-block-breaking': 'SERVER_AUTHORITATIVE_BLOCK_BREAKING',
  'server-authoritative-block-breaking-pick-range-scalar': 'SERVER_AUTHORITATIVE_BLOCK_BREAKING_PICK_RANGE_SCALAR',
  'chat-restriction': 'CHAT_RESTRICTION',
  'disable-player-interaction': 'DISABLE_PLAYER_INTERACTION',
  'client-side-chunk-generation-enabled': 'CLIENT_SIDE_CHUNK_GENERATION_ENABLED',
  'block-network-ids-are-hashes': 'BLOCK_NETWORK_IDS_ARE_HASHES',
  'disable-persona': 'DISABLE_PERSONA',
  'disable-custom-skins': 'DISABLE_CUSTOM_SKINS',
  'server-build-radius-ratio': 'SERVER_BUILD_RADIUS_RATIO',
  'op-permission-level': 'OP_PERMISSION_LEVEL',
  'emit-server-telemetry': 'EMIT_SERVER_TELEMETRY',
  'msa-gamertags-only': 'MSA_GAMERTAGS_ONLY',
  'item-transaction-logging-enabled': 'ITEM_TRANSACTION_LOGGING_ENABLED',
};

/** server.properties keys produced by the typed Java fields (extras may not duplicate them). */
const JAVA_TYPED_KEYS: Partial<Record<keyof MinecraftConfig, string>> = {
  levelName: 'level-name',
  gameMode: 'gamemode',
  forceGamemode: 'force-gamemode',
  hardcore: 'hardcore',
  difficulty: 'difficulty',
  motd: 'motd',
  maxPlayers: 'max-players',
  pvp: 'pvp',
  onlineMode: 'online-mode',
  allowFlight: 'allow-flight',
  commandBlocks: 'enable-command-block',
  allowNether: 'allow-nether',
  spawnAnimals: 'spawn-animals',
  spawnMonsters: 'spawn-monsters',
  spawnNpcs: 'spawn-npcs',
  playerIdleTimeout: 'player-idle-timeout',
  seed: 'level-seed',
  levelType: 'level-type',
  generateStructures: 'generate-structures',
  generatorSettings: 'generator-settings',
  spawnProtection: 'spawn-protection',
  maxWorldSize: 'max-world-size',
  viewDistance: 'view-distance',
  simulationDistance: 'simulation-distance',
  entityBroadcastRange: 'entity-broadcast-range-percentage',
  networkCompressionThreshold: 'network-compression-threshold',
};

const BEDROCK_TYPED_KEYS: Partial<Record<keyof MinecraftConfig, string>> = {
  levelName: 'level-name',
  gameMode: 'gamemode',
  forceGamemode: 'force-gamemode',
  difficulty: 'difficulty',
  motd: 'server-name',
  maxPlayers: 'max-players',
  onlineMode: 'online-mode',
  allowCheats: 'allow-cheats',
  playerIdleTimeout: 'player-idle-timeout',
  seed: 'level-seed',
  levelType: 'level-type',
  viewDistance: 'view-distance',
  tickDistance: 'tick-distance',
  networkCompressionThreshold: 'compression-threshold',
};

const isSet = (v: unknown) => v !== undefined && v !== null && v !== '';

/**
 * Validate a parsed config against the server type. Throws a 400 for options that do not exist
 * on that edition (instead of silently ignoring them). Returns a copy with empty values dropped.
 */
export function normalizeMinecraftConfig(type: string, input: MinecraftConfig): MinecraftConfig {
  const bedrock = type === 'BEDROCK';
  const cfg: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (isSet(v)) cfg[k] = v;
  const c = cfg as MinecraftConfig;
  const fail = (field: string, msg: string): never => {
    throw badRequest(`minecraft.${field}: ${msg}`, 'invalid_minecraft_config');
  };
  for (const f of bedrock ? JAVA_ONLY : BEDROCK_ONLY) {
    if (isSet(c[f])) fail(f, `is not supported on ${bedrock ? 'Bedrock' : 'Java'} servers`);
  }
  if (bedrock) {
    if (c.gameMode === 'spectator') fail('gameMode', 'spectator is not available on Bedrock servers');
    if (c.levelType && !(BEDROCK_LEVEL_TYPES as readonly string[]).includes(c.levelType))
      fail('levelType', `must be one of ${BEDROCK_LEVEL_TYPES.join(', ')} on Bedrock servers`);
    if (c.whitelist?.enforce !== undefined) fail('whitelist.enforce', 'is not supported on Bedrock servers');
    if (c.resourcePack?.url || c.resourcePack?.sha1) fail('resourcePack', 'Bedrock servers only support "required" (packs live in the world folder)');
    if (c.networkCompressionThreshold !== undefined && c.networkCompressionThreshold < 0)
      fail('networkCompressionThreshold', 'must be between 0 and 65535 on Bedrock servers');
    for (const name of [...(c.whitelist?.users ?? []), ...(c.ops ?? [])]) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name)) fail('whitelist.users', `"${name}" looks like a Java UUID; use Xbox gamertags or XUIDs`);
    }
  } else {
    if (c.levelType === 'legacy') fail('levelType', `must be one of ${JAVA_LEVEL_TYPES.join(', ')} on Java servers`);
    for (const name of [...(c.whitelist?.users ?? []), ...(c.ops ?? [])]) {
      if (!/^[A-Za-z0-9_]{1,16}$/.test(name) && !/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(name))
        fail('whitelist.users', `"${name}" is not a valid Java username or UUID`);
    }
    if (c.resourcePack?.sha1 && !c.resourcePack.url) fail('resourcePack.sha1', 'requires resourcePack.url');
  }
  if (c.whitelist?.users?.length && c.whitelist.enabled === false)
    fail('whitelist.users', 'pre-added players require the whitelist to be enabled');
  if (c.extra) {
    const typed = bedrock ? BEDROCK_TYPED_KEYS : JAVA_TYPED_KEYS;
    for (const key of Object.keys(c.extra)) {
      const field = (Object.keys(typed) as Array<keyof MinecraftConfig>).find((f) => typed[f] === key);
      if (field && isSet(c[field])) fail(`extra.${key}`, `duplicates the "${field}" option`);
      if (bedrock && !BEDROCK_PROPERTY_ENV[key]) fail(`extra.${key}`, 'is not a server.properties key the Bedrock image can set');
    }
    if (!Object.keys(c.extra).length) delete c.extra;
  }
  if (c.whitelist && !Object.values(c.whitelist).some((v) => (Array.isArray(v) ? v.length : v !== undefined))) delete c.whitelist;
  if (c.resourcePack && !Object.values(c.resourcePack).some(isSet)) delete c.resourcePack;
  if (c.ops && !c.ops.length) delete c.ops;
  return c;
}

const bool = (b: boolean) => (b ? 'true' : 'false');

/**
 * Map the config to itzg env vars. Pure; `type` is the ServCrafty server type.
 * Only set options produce env vars (an unset itzg var leaves the property at its default).
 */
export function minecraftEnv(type: string, cfg: MinecraftConfig | null | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (!cfg) return env;
  const put = (k: string, v: string | number | boolean | undefined) => {
    if (v === undefined || v === '') return;
    env[k] = typeof v === 'boolean' ? bool(v) : String(v);
  };

  if (type === 'BEDROCK') {
    put('LEVEL_NAME', cfg.levelName);
    put('GAMEMODE', cfg.gameMode);
    put('FORCE_GAMEMODE', cfg.forceGamemode);
    put('DIFFICULTY', cfg.difficulty);
    put('SERVER_NAME', cfg.motd);
    put('MAX_PLAYERS', cfg.maxPlayers);
    put('ONLINE_MODE', cfg.onlineMode);
    put('ALLOW_CHEATS', cfg.allowCheats);
    put('PLAYER_IDLE_TIMEOUT', cfg.playerIdleTimeout);
    put('LEVEL_SEED', cfg.seed);
    put('LEVEL_TYPE', cfg.levelType?.toUpperCase());
    put('VIEW_DISTANCE', cfg.viewDistance);
    put('TICK_DISTANCE', cfg.tickDistance);
    put('COMPRESSION_THRESHOLD', cfg.networkCompressionThreshold);
    put('TEXTUREPACK_REQUIRED', cfg.resourcePack?.required);
    const wl = cfg.whitelist;
    if (wl?.users?.length) {
      // bedrock-entry.sh writes allowlist.json from ALLOW_LIST_USERS (names only, no ":" => no XUIDs)
      // and turns allow-list on.
      env.ALLOW_LIST_USERS = wl.users.join(',');
      env.ALLOW_LIST = 'true';
    } else if (wl?.enabled !== undefined) {
      env.ALLOW_LIST = bool(wl.enabled);
    }
    if (cfg.ops?.length) env.OPS = cfg.ops.join(',');
    for (const [k, v] of Object.entries(cfg.extra ?? {})) {
      const name = BEDROCK_PROPERTY_ENV[k];
      if (name) env[name] = v;
    }
    return env;
  }

  // Java (all itzg/minecraft-server types, including modpacks)
  put('LEVEL', cfg.levelName);
  put('MODE', cfg.gameMode);
  put('FORCE_GAMEMODE', cfg.forceGamemode);
  put('HARDCORE', cfg.hardcore);
  put('DIFFICULTY', cfg.difficulty);
  put('MOTD', cfg.motd);
  put('MAX_PLAYERS', cfg.maxPlayers);
  put('PVP', cfg.pvp);
  put('ONLINE_MODE', cfg.onlineMode);
  put('ALLOW_FLIGHT', cfg.allowFlight);
  put('ENABLE_COMMAND_BLOCK', cfg.commandBlocks);
  put('ALLOW_NETHER', cfg.allowNether);
  put('SPAWN_ANIMALS', cfg.spawnAnimals);
  put('SPAWN_MONSTERS', cfg.spawnMonsters);
  put('SPAWN_NPCS', cfg.spawnNpcs);
  put('PLAYER_IDLE_TIMEOUT', cfg.playerIdleTimeout);
  put('SEED', cfg.seed);
  put('LEVEL_TYPE', cfg.levelType);
  put('GENERATE_STRUCTURES', cfg.generateStructures);
  put('GENERATOR_SETTINGS', cfg.generatorSettings);
  put('SPAWN_PROTECTION', cfg.spawnProtection);
  put('MAX_WORLD_SIZE', cfg.maxWorldSize);
  put('VIEW_DISTANCE', cfg.viewDistance);
  put('SIMULATION_DISTANCE', cfg.simulationDistance);
  put('ENTITY_BROADCAST_RANGE_PERCENTAGE', cfg.entityBroadcastRange);
  put('NETWORK_COMPRESSION_THRESHOLD', cfg.networkCompressionThreshold);
  put('RESOURCE_PACK', cfg.resourcePack?.url);
  put('RESOURCE_PACK_SHA1', cfg.resourcePack?.sha1?.toLowerCase());
  put('RESOURCE_PACK_ENFORCE', cfg.resourcePack?.required);

  const custom: Record<string, string> = { ...(cfg.extra ?? {}) };
  const wl = cfg.whitelist;
  if (wl?.users?.length) env.WHITELIST = wl.users.join(',');
  if (wl?.enabled !== undefined) env.ENABLE_WHITELIST = bool(wl.enabled);
  if (wl?.enforce !== undefined) {
    env.ENFORCE_WHITELIST = bool(wl.enforce);
    // start-setupServerProperties forces ENFORCE_WHITELIST=true whenever the whitelist is on;
    // custom properties are applied after the definitions, so this keeps an explicit "false".
    if (!wl.enforce) custom['enforce-whitelist'] = 'false';
  }
  if (cfg.ops?.length) env.OPS = cfg.ops.join(',');
  const lines = Object.entries(custom).map(([k, v]) => `${k}=${v}`);
  if (lines.length) env.CUSTOM_SERVER_PROPERTIES = lines.join('\n');
  return env;
}
