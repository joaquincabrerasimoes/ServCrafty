import type { MinecraftConfig } from '@/api/types';
import type { TFn, TKey } from '@/i18n';

/**
 * Wizard state for the "Minecraft config" step. Numbers are kept as strings so a field can be
 * empty or mid-edit; only values that differ from the edition's default are sent, so modpack
 * and image defaults are left alone unless the user changed something.
 */
export interface McForm {
  levelName: string;
  gameMode: NonNullable<MinecraftConfig['gameMode']>;
  forceGamemode: boolean;
  hardcore: boolean;
  difficulty: NonNullable<MinecraftConfig['difficulty']>;
  motd: string;
  maxPlayers: string;
  pvp: boolean;
  onlineMode: boolean;
  allowFlight: boolean;
  allowCheats: boolean;
  commandBlocks: boolean;
  allowNether: boolean;
  spawnAnimals: boolean;
  spawnMonsters: boolean;
  spawnNpcs: boolean;
  playerIdleTimeout: string;
  seed: string;
  levelType: NonNullable<MinecraftConfig['levelType']>;
  generateStructures: boolean;
  generatorSettings: string;
  spawnProtection: string;
  maxWorldSize: string;
  whitelistEnabled: boolean;
  whitelistEnforce: boolean;
  whitelistUsers: string[];
  ops: string[];
  viewDistance: string;
  simulationDistance: string;
  tickDistance: string;
  entityBroadcastRange: string;
  networkCompressionThreshold: string;
  resourcePackUrl: string;
  resourcePackSha1: string;
  resourcePackRequired: boolean;
  extra: Array<{ key: string; value: string }>;
}

export type Edition = 'java' | 'bedrock';

/** Vanilla defaults (the edition-specific numeric defaults are shown as placeholders). */
export function mcDefaults(): McForm {
  return {
    levelName: '',
    gameMode: 'survival',
    forceGamemode: false,
    hardcore: false,
    difficulty: 'easy',
    motd: '',
    maxPlayers: '',
    pvp: true,
    onlineMode: true,
    allowFlight: false,
    allowCheats: false,
    commandBlocks: false,
    allowNether: true,
    spawnAnimals: true,
    spawnMonsters: true,
    spawnNpcs: true,
    playerIdleTimeout: '',
    seed: '',
    levelType: 'default',
    generateStructures: true,
    generatorSettings: '',
    spawnProtection: '',
    maxWorldSize: '',
    whitelistEnabled: false,
    // itzg turns enforcement on whenever the whitelist is enabled.
    whitelistEnforce: true,
    whitelistUsers: [],
    ops: [],
    viewDistance: '',
    simulationDistance: '',
    tickDistance: '',
    entityBroadcastRange: '',
    networkCompressionThreshold: '',
    resourcePackUrl: '',
    resourcePackSha1: '',
    resourcePackRequired: false,
    extra: [],
  };
}

/** Placeholder shown in empty number/text fields (the edition's default). */
export const PLACEHOLDERS: Record<Edition, Partial<Record<keyof McForm, string>>> = {
  java: {
    levelName: 'world',
    maxPlayers: '20',
    playerIdleTimeout: '0',
    spawnProtection: '16',
    maxWorldSize: '29999984',
    viewDistance: '10',
    simulationDistance: '10',
    entityBroadcastRange: '100',
    networkCompressionThreshold: '256',
  },
  bedrock: {
    levelName: 'Bedrock level',
    motd: 'Dedicated Server',
    maxPlayers: '10',
    playerIdleTimeout: '30',
    viewDistance: '32',
    tickDistance: '4',
    networkCompressionThreshold: '1',
  },
};

export interface NumberRule {
  min: number;
  max: number;
}

/** Same limits as the backend schema (server/src/lib/minecraftConfig.ts). */
export const NUMBER_RULES: Partial<Record<keyof McForm, NumberRule>> = {
  maxPlayers: { min: 1, max: 1000 },
  playerIdleTimeout: { min: 0, max: 1440 },
  spawnProtection: { min: 0, max: 10_000 },
  maxWorldSize: { min: 1, max: 29_999_984 },
  viewDistance: { min: 3, max: 32 },
  simulationDistance: { min: 3, max: 32 },
  tickDistance: { min: 4, max: 12 },
  entityBroadcastRange: { min: 10, max: 1000 },
  networkCompressionThreshold: { min: -1, max: 65_535 },
};

export const JAVA_PLAYER = /^(?:[A-Za-z0-9_]{1,16}|[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})$/;
export const BEDROCK_PLAYER = /^(?:[A-Za-z0-9][A-Za-z0-9 _#]{0,19}|\d{15,20})$/;
const LEVEL_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;
const EXTRA_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROTECTED_KEYS = new Set([
  'server-port',
  'server-portv6',
  'server-ip',
  'server-udp-ports',
  'enable-rcon',
  'query.port',
  'enable-query',
  'white-list',
  'allow-list',
]);
const PLACEHOLDER = /%[^%\s]+%/;

export type McErrors = Partial<Record<keyof McForm | `extra.${number}`, string>>;

/** Which fields exist for an edition. */
export function fieldsFor(edition: Edition) {
  const java = edition === 'java';
  return {
    hardcore: java,
    pvp: java,
    allowFlight: java,
    allowCheats: !java,
    commandBlocks: java,
    allowNether: java,
    spawnMobs: java,
    generateStructures: java,
    generatorSettings: java,
    spawnProtection: java,
    maxWorldSize: java,
    whitelistEnforce: java,
    simulationDistance: java,
    tickDistance: !java,
    entityBroadcastRange: java,
    resourcePackUrl: java,
  };
}

export function validateMc(f: McForm, edition: Edition, t: TFn): McErrors {
  const e: McErrors = {};
  const has = fieldsFor(edition);
  for (const [k, rule] of Object.entries(NUMBER_RULES) as Array<[keyof McForm, NumberRule]>) {
    const raw = String(f[k] ?? '').trim();
    if (!raw) continue;
    if (edition === 'bedrock' && k === 'networkCompressionThreshold' && raw === '-1') {
      e[k] = t('mc.err.range', { min: 0, max: rule.max });
      continue;
    }
    const n = Number(raw);
    if (!/^-?\d+$/.test(raw) || !Number.isInteger(n)) e[k] = t('mc.err.integer');
    else if (n < rule.min || n > rule.max) e[k] = t('mc.err.range', { min: rule.min, max: rule.max });
  }
  if (f.levelName.trim() && (!LEVEL_NAME.test(f.levelName.trim()) || f.levelName.trim().length > 64)) e.levelName = t('mc.err.levelName');
  for (const k of ['motd', 'seed'] as const) {
    if (PLACEHOLDER.test(f[k])) e[k] = t('mc.err.placeholder');
  }
  if (f.motd.length > 256) e.motd = t('mc.err.tooLong', { max: 256 });
  if (f.seed.length > 64) e.seed = t('mc.err.tooLong', { max: 64 });
  if (has.generatorSettings && f.generatorSettings.trim()) {
    try {
      const v: unknown = JSON.parse(f.generatorSettings);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) e.generatorSettings = t('mc.err.json');
    } catch {
      e.generatorSettings = t('mc.err.json');
    }
  }
  if (has.resourcePackUrl) {
    const url = f.resourcePackUrl.trim();
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) e.resourcePackUrl = t('mc.err.url');
    if (f.resourcePackSha1.trim() && !/^[0-9a-fA-F]{40}$/.test(f.resourcePackSha1.trim())) e.resourcePackSha1 = t('mc.err.sha1');
    if (f.resourcePackSha1.trim() && !url) e.resourcePackSha1 = t('mc.err.sha1NeedsUrl');
  }
  const seen = new Set<string>();
  f.extra.forEach((row, i) => {
    const key = row.key.trim();
    if (!key && !row.value.trim()) return;
    if (!EXTRA_KEY.test(key)) e[`extra.${i}`] = t('mc.err.extraKey');
    else if (PROTECTED_KEYS.has(key) || key.startsWith('rcon.') || key.startsWith('management-server-')) e[`extra.${i}`] = t('mc.err.extraProtected');
    else if (seen.has(key)) e[`extra.${i}`] = t('mc.err.extraDuplicate');
    else if (/[\u0000-\u001f]/.test(row.value) || PLACEHOLDER.test(row.value) || row.value.length > 1024) e[`extra.${i}`] = t('mc.err.extraValue');
    seen.add(key);
  });
  return e;
}

const num = (s: string) => (s.trim() === '' ? undefined : Number(s.trim()));

/** Build the API payload: only values that differ from the edition defaults. */
export function toMinecraftConfig(f: McForm, edition: Edition): MinecraftConfig | undefined {
  const d = mcDefaults();
  const has = fieldsFor(edition);
  const c: MinecraftConfig = {};
  const bool = <K extends keyof McForm & keyof MinecraftConfig>(k: K, show = true) => {
    if (show && f[k] !== d[k]) (c as Record<string, unknown>)[k] = f[k];
  };
  if (f.levelName.trim()) c.levelName = f.levelName.trim();
  if (f.gameMode !== d.gameMode) c.gameMode = f.gameMode;
  bool('forceGamemode');
  bool('hardcore', has.hardcore);
  if (f.difficulty !== d.difficulty) c.difficulty = f.difficulty;
  if (f.motd.trim()) c.motd = f.motd.trim();
  bool('pvp', has.pvp);
  bool('onlineMode');
  bool('allowFlight', has.allowFlight);
  bool('allowCheats', has.allowCheats);
  bool('commandBlocks', has.commandBlocks);
  bool('allowNether', has.allowNether);
  bool('spawnAnimals', has.spawnMobs);
  bool('spawnMonsters', has.spawnMobs);
  bool('spawnNpcs', has.spawnMobs);
  if (f.seed.trim()) c.seed = f.seed.trim();
  if (f.levelType !== d.levelType) c.levelType = f.levelType;
  bool('generateStructures', has.generateStructures);
  if (has.generatorSettings && f.generatorSettings.trim() && (f.levelType === 'flat' || f.levelType === 'single_biome_surface'))
    c.generatorSettings = f.generatorSettings.trim();
  for (const k of ['maxPlayers', 'playerIdleTimeout', 'viewDistance', 'networkCompressionThreshold'] as const) {
    const v = num(f[k]);
    if (v !== undefined) c[k] = v;
  }
  const javaNums = ['spawnProtection', 'maxWorldSize', 'simulationDistance', 'entityBroadcastRange'] as const;
  if (edition === 'java') {
    for (const k of javaNums) {
      const v = num(f[k]);
      if (v !== undefined) c[k] = v;
    }
  } else {
    const v = num(f.tickDistance);
    if (v !== undefined) c.tickDistance = v;
  }
  // Bedrock: recent BDS builds default allow-list to on, so always state it explicitly.
  if (f.whitelistEnabled || edition === 'bedrock') {
    c.whitelist = { enabled: f.whitelistEnabled };
    if (f.whitelistEnabled && f.whitelistUsers.length) c.whitelist.users = f.whitelistUsers;
    if (f.whitelistEnabled && has.whitelistEnforce && !f.whitelistEnforce) c.whitelist.enforce = false;
  }
  if (f.ops.length) c.ops = f.ops;
  const rp: NonNullable<MinecraftConfig['resourcePack']> = {};
  if (has.resourcePackUrl && f.resourcePackUrl.trim()) rp.url = f.resourcePackUrl.trim();
  if (has.resourcePackUrl && rp.url && f.resourcePackSha1.trim()) rp.sha1 = f.resourcePackSha1.trim();
  if (f.resourcePackRequired) rp.required = true;
  if (Object.keys(rp).length) c.resourcePack = rp;
  const extra: Record<string, string> = {};
  for (const r of f.extra) if (r.key.trim()) extra[r.key.trim()] = r.value.trim();
  if (Object.keys(extra).length) c.extra = extra;
  return Object.keys(c).length ? c : undefined;
}

/** Rows for the Review step. */
export function summarizeMc(c: MinecraftConfig | undefined, edition: Edition, t: TFn): Array<[string, string]> {
  if (!c) return [];
  const yes = (b: boolean | undefined) => (b ? t('common.yes') : t('common.no'));
  const rows: Array<[string, string]> = [];
  const add = (k: TKey, v: string | undefined) => v !== undefined && v !== '' && rows.push([t(k), v]);
  add('mc.levelName', c.levelName);
  add('mc.gameMode', c.gameMode && t(`mc.gameMode.${c.gameMode}` as TKey));
  add('mc.forceGamemode', c.forceGamemode !== undefined ? yes(c.forceGamemode) : undefined);
  add('mc.hardcore', c.hardcore !== undefined ? yes(c.hardcore) : undefined);
  add('mc.difficulty', c.difficulty && t(`mc.difficulty.${c.difficulty}` as TKey));
  add(edition === 'bedrock' ? 'mc.serverName' : 'mc.motd', c.motd);
  add('mc.maxPlayers', c.maxPlayers?.toString());
  for (const k of ['pvp', 'onlineMode', 'allowFlight', 'allowCheats', 'commandBlocks', 'allowNether', 'spawnAnimals', 'spawnMonsters', 'spawnNpcs'] as const) {
    add(`mc.${k}` as TKey, c[k] !== undefined ? yes(c[k]) : undefined);
  }
  add('mc.playerIdleTimeout', c.playerIdleTimeout !== undefined ? t('mc.minutes', { n: c.playerIdleTimeout }) : undefined);
  add('mc.seed', c.seed);
  add('mc.levelType', c.levelType && t(`mc.levelType.${c.levelType}` as TKey));
  add('mc.generateStructures', c.generateStructures !== undefined ? yes(c.generateStructures) : undefined);
  add('mc.generatorSettings', c.generatorSettings && (c.generatorSettings.length > 60 ? `${c.generatorSettings.slice(0, 57)}…` : c.generatorSettings));
  add('mc.spawnProtection', c.spawnProtection?.toString());
  add('mc.maxWorldSize', c.maxWorldSize?.toString());
  if (c.whitelist) {
    add('mc.whitelist', yes(c.whitelist.enabled));
    if (c.whitelist.enforce === false) add('mc.whitelistEnforce', yes(false));
    if (c.whitelist.users?.length) add('mc.whitelistUsers', c.whitelist.users.join(', '));
  }
  if (c.ops?.length) add('mc.ops', c.ops.join(', '));
  add('mc.viewDistance', c.viewDistance?.toString());
  add('mc.simulationDistance', c.simulationDistance?.toString());
  add('mc.tickDistance', c.tickDistance?.toString());
  add('mc.entityBroadcastRange', c.entityBroadcastRange !== undefined ? `${c.entityBroadcastRange} %` : undefined);
  add('mc.networkCompressionThreshold', c.networkCompressionThreshold?.toString());
  add('mc.resourcePackUrl', c.resourcePack?.url);
  add('mc.resourcePackSha1', c.resourcePack?.sha1);
  add('mc.resourcePackRequired', c.resourcePack?.required !== undefined ? yes(c.resourcePack.required) : undefined);
  for (const [k, v] of Object.entries(c.extra ?? {})) rows.push([k, v || '""']);
  return rows;
}

/** Ready-made flat world layers (1.18+ generator-settings JSON). */
export const FLAT_PRESETS: Array<{ id: string; json: string }> = [
  {
    id: 'classic',
    json: '{"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains"}',
  },
  {
    id: 'redstone',
    json: '{"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3},{"block":"minecraft:sandstone","height":52}],"biome":"minecraft:desert"}',
  },
  {
    id: 'void',
    json: '{"layers":[{"block":"minecraft:air","height":1}],"biome":"minecraft:the_void"}',
  },
];

export const SINGLE_BIOMES = ['plains', 'desert', 'forest', 'taiga', 'snowy_plains', 'jungle', 'savanna', 'badlands', 'mushroom_fields', 'cherry_grove', 'ocean'];
