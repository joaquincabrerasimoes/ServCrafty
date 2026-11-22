import type { PluginDef, PluginPlatform, PluginSource } from '../l4d2/pluginCatalog.js';

/**
 * The Counter-Strike 1.6 plugin store: a fixed, curated list. Every download comes from a pinned host over HTTPS
 * (GitHub, amxmodx.org); nothing here is user supplied. Paths are relative to `cstrike/`. The game server is Linux.
 */

export interface Cs16PluginDef extends PluginDef {
  /** Line added to Metamod's `plugins.ini` while the plugin is installed (`linux <path>`). */
  metamodLine?: string;
}

const AMXX_BASE = 'https://www.amxmodx.org/amxxdrop/1.10/';
const METAMOD_URL = 'https://github.com/rehlds/Metamod-R/releases/download/1.3.0.149/metamod-bin-1.3.0.149.zip';
const YAPB_URL = 'https://github.com/yapb/yapb/releases/download/4.4.957/yapb-4.4.957-linux.tar.xz';
export const METAMOD_PLUGINS_INI = 'addons/metamod/plugins.ini';

export const CS16_PLUGIN_CATALOG: Cs16PluginDef[] = [
  {
    id: 'metamod',
    name: 'Metamod-R',
    description: 'The plugin loader AMX Mod X and the bots run on (the ReHLDS project\'s Metamod). The panel points the game at it when the server starts. Installed automatically with the plugins that need it.',
    homepage: 'https://github.com/rehlds/Metamod-R',
    category: 'base',
    requires: [],
    sources: [
      {
        platform: 'linux',
        url: METAMOD_URL,
        format: 'zip',
        rules: [
          { from: 'addons/metamod/metamod_i386.so', to: 'addons/metamod/metamod_i386.so' },
          { from: 'addons/metamod/config.ini', to: 'addons/metamod/config.ini' },
        ],
        preserve: ['addons/metamod/config.ini'],
      },
    ],
    settings: [],
    configFile: '',
  },
  {
    id: 'amxmodx',
    name: 'AMX Mod X',
    description:
      'Scripting and admin framework for Counter-Strike: admin menu (amxmodmenu), map votes and chooser, kick/ban/slap commands, stats. Add yourself to addons/amxmodx/configs/users.ini with the Files tab to use the admin commands.',
    homepage: 'https://www.amxmodx.org/',
    category: 'base',
    requires: ['metamod'],
    sources: [
      {
        platform: 'linux',
        latest: { index: `${AMXX_BASE}amxmodx-latest-base-linux`, base: AMXX_BASE },
        format: 'tar.gz',
        rules: [{ from: 'addons/', to: 'addons/' }],
        preserve: ['addons/amxmodx/configs/'],
      },
      {
        platform: 'linux',
        latest: { index: `${AMXX_BASE}amxmodx-latest-cstrike-linux`, base: AMXX_BASE },
        format: 'tar.gz',
        rules: [{ from: 'addons/', to: 'addons/' }],
        preserve: ['addons/amxmodx/configs/'],
      },
    ],
    settings: [],
    configFile: '',
    metamodLine: 'linux addons/amxmodx/dlls/amxmodx_mm_i386.so',
  },
  {
    id: 'yapb',
    name: 'YaPB (smarter bots)',
    description:
      'Bots that play the objectives (plant and defuse, rescue hostages, buy weapons, use grenades, talk on the radio) instead of the game\'s own basic bots. When installed, the Controls tab drives these bots. Navigation data is included for the stock maps and learned on custom maps.',
    homepage: 'https://github.com/yapb/yapb',
    category: 'bots',
    requires: ['metamod'],
    sources: [{ platform: 'linux', url: YAPB_URL, format: 'tar.xz', rules: [{ from: 'addons/yapb/', to: 'addons/yapb/' }], preserve: ['addons/yapb/conf/', 'addons/yapb/data/'] }],
    settings: [],
    configFile: '',
    metamodLine: 'linux addons/yapb/bin/yapb.so',
  },
];

export const pluginById = (id: string): Cs16PluginDef | undefined => CS16_PLUGIN_CATALOG.find((p) => p.id === id);

export const sourcesFor = (p: PluginDef, platform: PluginPlatform): PluginSource[] => p.sources.filter((s) => !s.platform || s.platform === platform);

/** `id` plus everything it needs, dependencies first, without duplicates. */
export function withDependencies(id: string): Cs16PluginDef[] {
  const out: Cs16PluginDef[] = [];
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

/** Add `lines` to a Metamod `plugins.ini` text (no duplicates), keeping everything else. */
export function addMetamodLine(text: string, line: string): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.replace(/\r\n/g, '\n').split('\n') : [];
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.some((l) => l.trim() === line)) lines.push(line);
  return lines.join(nl) + nl;
}

/** Remove a line from a Metamod `plugins.ini` text. */
export function removeMetamodLine(text: string, line: string): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== line);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? lines.join(nl) + nl : '';
}
