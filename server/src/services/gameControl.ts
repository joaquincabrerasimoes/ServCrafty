import { query } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { applyDisabledChange, ACTIVE_STATUSES, serversToStop } from '../lib/gameAccess.js';
import { gameKeyKind, MINECRAFT_KEY, serverGameKey, steamGameKey, TERRARIA_KEY, type Game, type GameKey } from '../lib/games.js';
import { existingGameKeys, getDisabledGames, labelOfKey, saveDisabledGames } from './gameAccess.js';
import { listEntries } from './gameDefinitions.js';
import * as runtime from './runtime.js';
import type { ServerRow } from './types.js';

/** `GET /admin/games` item (SPEC "v0.3.2" 3). */
export interface AdminGameItem {
  key: GameKey;
  name: string;
  builtin: boolean;
  kind: Game;
  disabled: boolean;
  blockStart: boolean;
  servers: number;
  running: number;
}

type KeyedServer = { id: string; name: string; key: GameKey; status: string };

async function keyedServers(): Promise<KeyedServer[]> {
  const rows = await query<Pick<ServerRow, 'id' | 'name' | 'type' | 'steam'>>('SELECT id, name, type, steam FROM servers');
  return rows.map((r) => ({ id: r.id, name: r.name, key: serverGameKey(r), status: runtime.getStatus(r.id) }));
}

/** Every game (Minecraft, Terraria, each definition) with its disabled state and server counts. */
export async function listAdminGames(): Promise<AdminGameItem[]> {
  const disabled = await getDisabledGames();
  const servers = await keyedServers();
  const count = (key: GameKey) => servers.filter((s) => s.key === key).length;
  const running = (key: GameKey) => servers.filter((s) => s.key === key && (ACTIVE_STATUSES as readonly string[]).includes(s.status)).length;
  const item = (key: GameKey, name: string, builtin: boolean, kind: Game): AdminGameItem => ({
    key,
    name,
    builtin,
    kind,
    disabled: !!disabled[key],
    blockStart: disabled[key]?.blockStart === true,
    servers: count(key),
    running: running(key),
  });
  return [
    item(MINECRAFT_KEY, 'Minecraft', true, 'minecraft'),
    item(TERRARIA_KEY, 'Terraria', true, 'terraria'),
    ...listEntries().map((e) => item(steamGameKey(e.definition.id), e.definition.name, e.builtin, 'steam')),
  ];
}

export interface DisableResult {
  key: GameKey;
  disabled: boolean;
  blockStart: boolean;
  /** Servers stopped by this call (blockStart). */
  stopped: number;
  /** Servers that could not be stopped. */
  failed: number;
  /** Servers of the game (any status). */
  servers: number;
}

/**
 * Enable/disable a game. Disabling with `blockStart` stops every running server of the game gracefully as a
 * SYSTEM stop (not a user stop), so automatic start behaves as before once the game is enabled again.
 * Enabling clears blockStart too. A key that is neither an existing game nor currently disabled -> 404.
 */
export async function setGameDisabled(
  key: GameKey,
  change: { disabled: boolean; blockStart?: boolean },
  by: string,
): Promise<DisableResult> {
  const current = await getDisabledGames();
  if (!gameKeyKind(key) || (!existingGameKeys().includes(key) && !current[key])) throw notFound(`Unknown game "${key}"`, 'unknown_game');
  const next = applyDisabledChange(current, key, change, by);
  await saveDisabledGames(next);
  const entry = next[key];
  const servers = await keyedServers();
  let stopped = 0;
  let failed = 0;
  if (entry?.blockStart) {
    const ids = serversToStop(servers, key).map((s) => s.id);
    if (ids.length) {
      ({ stopped, failed } = await runtime.systemStopServers(
        ids,
        `[servcrafty] ${labelOfKey(key)} has been disabled by an administrator: stopping the server`,
      ));
    }
  }
  return {
    key,
    disabled: !!entry,
    blockStart: entry?.blockStart === true,
    stopped,
    failed,
    servers: servers.filter((s) => s.key === key).length,
  };
}
