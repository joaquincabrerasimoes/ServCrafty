/**
 * The Left 4 Dead 2 plugin store: a fixed, curated list. Every download comes from a pinned host over
 * HTTPS (AlliedModders, GitHub); nothing here is user supplied. Paths are relative to `left4dead2/`.
 */

export interface PluginSetting {
  /** The console variable (cvar) this setting writes. */
  key: string;
  label: string;
  description: string;
  type: 'number' | 'boolean';
  default: number | boolean;
  min?: number;
  max?: number;
}

export interface PluginRule {
  /** Archive path prefix to take (`*` as first segment matches any top folder); '' = everything. */
  from: string;
  /** Destination prefix under `left4dead2/` (for a single `file` source: the destination file). */
  to: string;
}

export type PluginPlatform = 'linux' | 'windows';

export interface PluginSource {
  /** Only installed on this platform of the server (Linux native or Windows under Wine); absent = both. */
  platform?: PluginPlatform;
  /** Fixed download address, or `latest`: `index` returns the current file name, found under `base`. */
  url?: string;
  /** File shipped with the panel (under `server/plugins/`) instead of downloaded. */
  bundled?: string;
  latest?: { index: string; base: string };
  format: 'zip' | 'tar.gz' | 'tar.xz' | 'file';
  rules: PluginRule[];
  /** Existing files under these prefixes (relative to `left4dead2/`) are never overwritten (admin lists, configs). */
  preserve?: string[];
}

export interface PluginDef {
  id: string;
  name: string;
  description: string;
  homepage: string;
  category: 'base' | 'slots' | 'library' | 'bots';
  /** Plugin ids that must be installed first (installed together with this one). */
  requires: string[];
  /** One or more downloads; every one is installed. */
  sources: PluginSource[];
  settings: PluginSetting[];
  /** Config file (relative to `left4dead2/cfg/`) that holds the settings. */
  configFile: string;
}

const SM_BASE = 'https://sm.alliedmods.net/smdrop/1.12/';
const MM_BASE = 'https://mms.alliedmods.net/mmsdrop/1.12/';
const RMC = 'https://raw.githubusercontent.com/lakwsh/l4d2_rmc/main/';
export const SHARED_CONFIG = 'servcrafty_plugins.cfg';

export const PLUGIN_CATALOG: PluginDef[] = [
  {
    id: 'metamod',
    name: 'Metamod:Source',
    description: 'The plugin loader SourceMod runs on. Install it first (it is installed automatically with SourceMod).',
    homepage: 'https://www.sourcemm.net/',
    category: 'base',
    requires: [],
    sources: [
      { platform: 'linux', latest: { index: `${MM_BASE}mmsource-latest-linux`, base: MM_BASE }, format: 'tar.gz', rules: [{ from: '', to: '' }] },
      { platform: 'windows', latest: { index: `${MM_BASE}mmsource-latest-windows`, base: MM_BASE }, format: 'zip', rules: [{ from: '', to: '' }] },
    ],
    settings: [],
    configFile: SHARED_CONFIG,
  },
  {
    id: 'sourcemod',
    name: 'SourceMod',
    description: 'Scripting and admin framework most plugins need: admin menu, votes, map and player commands. Add yourself to addons/sourcemod/configs/admins_simple.ini with the Files tab to use admin commands.',
    homepage: 'https://www.sourcemod.net/',
    category: 'base',
    requires: ['metamod'],
    sources: [
      {
        platform: 'linux',
        latest: { index: `${SM_BASE}sourcemod-latest-linux`, base: SM_BASE },
        format: 'tar.gz',
        rules: [{ from: '', to: '' }],
        preserve: ['addons/sourcemod/configs/', 'cfg/sourcemod/'],
      },
      {
        platform: 'windows',
        latest: { index: `${SM_BASE}sourcemod-latest-windows`, base: SM_BASE },
        format: 'zip',
        rules: [{ from: '', to: '' }],
        preserve: ['addons/sourcemod/configs/', 'cfg/sourcemod/'],
      },
    ],
    settings: [],
    configFile: SHARED_CONFIG,
  },
  {
    id: 'l4dtoolz',
    name: 'L4DToolZ (extra slots)',
    description: 'Lifts the player limit: up to 31 players and a configurable number of slots (Valve caps the game at 4 players in campaign and 8 in versus). Needed by the plugins below.',
    homepage: 'https://github.com/lakwsh/l4dtoolz',
    category: 'slots',
    requires: [],
    sources: [
      {
        platform: 'linux',
        url: 'https://github.com/lakwsh/l4dtoolz/releases/download/2.5.1/l4dtoolz-2.5.1-main.zip',
        format: 'zip',
        rules: [
          { from: 'l4dtoolz.so', to: 'addons/l4dtoolz.so' },
          { from: 'l4dtoolz.vdf', to: 'addons/l4dtoolz.vdf' },
        ],
      },
      {
        platform: 'windows',
        url: 'https://github.com/lakwsh/l4dtoolz/releases/download/2.5.1/l4dtoolz-2.5.1-main.zip',
        format: 'zip',
        rules: [
          { from: 'l4dtoolz.dll', to: 'addons/l4dtoolz.dll' },
          { from: 'l4dtoolz.vdf', to: 'addons/l4dtoolz.vdf' },
        ],
      },
    ],
    settings: [
      { key: 'sv_setmax', label: 'Client slots (MaxClients)', description: 'Total slots of the server, 18 to 31 (values above 31 can crash the game).', type: 'number', default: 31, min: 18, max: 31 },
      { key: 'sv_maxplayers', label: 'Player limit', description: 'How many players may join; -1 leaves the game default (4 in campaign, 8 in versus).', type: 'number', default: -1, min: -1, max: 31 },
      { key: 'sv_force_unreserved', label: 'Disable lobby matchmaking', description: 'Needed above 4 players: the server stops reserving itself for a lobby.', type: 'boolean', default: true },
    ],
    configFile: SHARED_CONFIG,
  },
  {
    id: 'l4d2_rmc',
    name: 'Multiplayer (more than 4 survivors)',
    description: 'Lets extra players play as survivors in campaign: bots are created for the extra slots, medkits and Tank health scale with the player count, and players vote !setmax to change the slot count (1-16).',
    homepage: 'https://github.com/lakwsh/l4d2_rmc',
    category: 'slots',
    requires: ['sourcemod', 'l4dtoolz'],
    sources: [
      {
        format: 'file',
        url: `${RMC}l4d2_rmc.smx`,
        rules: [{ from: '', to: 'addons/sourcemod/plugins/l4d2_rmc.smx' }],
      },
      {
        format: 'file',
        url: `${RMC}l4d2_rmc.txt`,
        rules: [{ from: '', to: 'addons/sourcemod/gamedata/l4d2_rmc.txt' }],
      },
    ],
    settings: [
      { key: 'rmc_defaultslots', label: 'Default slots', description: 'Player slots at the start of each session (1-16).', type: 'number', default: 8, min: 1, max: 16 },
      { key: 'rmc_multmed', label: 'Scale medkits', description: 'More medical supplies with more players.', type: 'boolean', default: true },
      { key: 'rmc_multhp', label: 'Scale Tank health', description: 'More Tank health with more players.', type: 'boolean', default: true },
      { key: 'rmc_away', label: 'Allow !away', description: 'Non-admins may move themselves to spectators.', type: 'boolean', default: true },
      { key: 'rmc_fh', label: 'Allow !fh for everyone', description: 'Non-admins may respawn.', type: 'boolean', default: false },
      { key: 'rmc_tp', label: 'Allow !tp for everyone', description: 'Non-admins may teleport bots.', type: 'boolean', default: false },
      { key: 'rmc_recovery', label: 'Restore health on rejoin', description: 'Players who rejoin get their previous health back.', type: 'boolean', default: true },
      { key: 'rmc_updatemax', label: 'Update client slots automatically', description: 'Adjusts MaxClients to the chosen slot count.', type: 'boolean', default: true },
    ],
    configFile: 'sourcemod/l4d2_rmc.cfg',
  },
  {
    id: 'l4d2_unreservelobby',
    name: 'Automatic lobby removal',
    description: 'Removes the lobby reservation when the server is full and restores it when a slot opens, so the server stays joinable by direct connection.',
    homepage: 'https://github.com/lakwsh/l4d2_rmc',
    category: 'slots',
    requires: ['sourcemod', 'l4dtoolz'],
    sources: [{ format: 'file', url: `${RMC}l4d2_unreservelobby.smx`, rules: [{ from: '', to: 'addons/sourcemod/plugins/l4d2_unreservelobby.smx' }] }],
    settings: [],
    configFile: SHARED_CONFIG,
  },
  {
    id: 'servcrafty_bots',
    name: 'Bot spawner (choose the character)',
    description: 'Adds survivor bots of the character you pick, including the Left 4 Dead 1 survivors (Bill, Zoey, Francis, Louis). Used by the Controls tab; needs the Multiplayer plugin (installed with it).',
    homepage: 'https://github.com/joaquincabrerasimoes/ServCrafty',
    category: 'slots',
    requires: ['sourcemod', 'l4dtoolz', 'l4d2_rmc'],
    sources: [{ format: 'file', bundled: 'servcrafty_bots.smx', rules: [{ from: '', to: 'addons/sourcemod/plugins/servcrafty_bots.smx' }] }],
    settings: [],
    configFile: SHARED_CONFIG,
  },
  {
    id: 'left4dhooks',
    name: 'Left4DHooks',
    description: 'Library many plugins depend on (natives and forwards for Left 4 Dead). Install it when a plugin asks for left4dhooks.',
    homepage: 'https://github.com/SilvDev/Left4DHooks',
    category: 'library',
    requires: ['sourcemod'],
    sources: [
      {
        url: 'https://github.com/SilvDev/Left4DHooks/archive/refs/heads/main.zip',
        format: 'zip',
        rules: [
          { from: '*/sourcemod/plugins/', to: 'addons/sourcemod/plugins/' },
          { from: '*/sourcemod/gamedata/', to: 'addons/sourcemod/gamedata/' },
          { from: '*/sourcemod/data/', to: 'addons/sourcemod/data/' },
        ],
      },
    ],
    settings: [],
    configFile: SHARED_CONFIG,
  },
];

/** The downloads of a plugin for a platform. */
export const sourcesFor = (p: PluginDef, platform: PluginPlatform): PluginSource[] => p.sources.filter((s) => !s.platform || s.platform === platform);

export const pluginById = (id: string): PluginDef | undefined => PLUGIN_CATALOG.find((p) => p.id === id);

/** `ids` plus everything they need, dependencies first, without duplicates. */
export function withDependencies(id: string): PluginDef[] {
  const out: PluginDef[] = [];
  const seen = new Set<string>();
  const visit = (pid: string) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    const p = pluginById(pid);
    if (!p) return;
    p.requires.forEach(visit);
    out.push(p);
  };
  visit(id);
  return out;
}
