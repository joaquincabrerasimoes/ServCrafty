import { query, tx } from '../db/pool.js';
import {
  assertCanCreate,
  assertStartAllowed,
  creatableGames,
  gameKeyLabel,
  normalizeDisabledGames,
  startBlocked,
  type DisabledGames,
} from '../lib/gameAccess.js';
import { MINECRAFT_KEY, serverGameKey, steamGameKey, TERRARIA_KEY, type GameKey } from '../lib/games.js';
import { getDefinition, listEntries } from './gameDefinitions.js';
import { getSetting, setSetting, SettingKeys } from './settings.js';
import { toPublicUser, type PublicUser, type ServerRow, type UserRow } from './types.js';

/**
 * Per-user game access (table `user_game_access`) and disabled games (setting `disabled_games`),
 * SPEC "v0.3.2". Pure decisions live in lib/gameAccess.ts.
 */

/** Data access, replaceable in tests (no database needed). */
export interface GameAccessStore {
  allowedFor(userId: string): Promise<GameKey[]>;
  loadDisabled(): Promise<DisabledGames>;
}

const dbStore: GameAccessStore = {
  async allowedFor(userId) {
    const rows = await query<{ game_key: string }>('SELECT game_key FROM user_game_access WHERE user_id = $1 ORDER BY game_key', [userId]);
    return rows.map((r) => r.game_key);
  },
  async loadDisabled() {
    return normalizeDisabledGames(await getSetting<unknown>(SettingKeys.disabledGames));
  },
};

let store: GameAccessStore = dbStore;
/** Synchronous copy of the `disabled_games` setting (server JSON is built synchronously). */
let disabledSnapshot: DisabledGames = {};

/** Test helper: replace the store (pass null to restore the database store). */
export function setGameAccessStoreForTest(s: GameAccessStore | null): void {
  store = s ?? dbStore;
  disabledSnapshot = {};
}

/** Every game key that exists: minecraft, terraria and one per game definition. */
export function existingGameKeys(): GameKey[] {
  return [MINECRAFT_KEY, TERRARIA_KEY, ...listEntries().map((e) => steamGameKey(e.definition.id))];
}

/** Human name of a game key (definition name for Steam games). */
export function labelOfKey(key: GameKey): string {
  return gameKeyLabel(key, (id) => getDefinition(id)?.name);
}

/** Current `disabled_games` (refreshes the synchronous snapshot). */
export async function getDisabledGames(): Promise<DisabledGames> {
  disabledSnapshot = await store.loadDisabled();
  return disabledSnapshot;
}

/** Load the snapshot at boot. */
export async function loadDisabledGames(): Promise<void> {
  await getDisabledGames();
}

export function disabledGamesSnapshot(): DisabledGames {
  return disabledSnapshot;
}

export async function saveDisabledGames(next: DisabledGames): Promise<void> {
  await setSetting(SettingKeys.disabledGames, next);
  disabledSnapshot = next;
}

/** `gameDisabled` / `gameBlocked` of a server, for its JSON. */
export function serverGameState(server: Pick<ServerRow, 'type' | 'steam'>): { gameDisabled: boolean; gameBlocked: boolean } {
  const key = serverGameKey(server);
  return { gameDisabled: !!disabledSnapshot[key], gameBlocked: startBlocked(disabledSnapshot, key) };
}

// ---------------------------------------------------------------------------------------------
// Enforcement

/**
 * Throw unless `actor` may create a server of `key`: 409 `game_disabled` (everyone, admins included)
 * or 403 `game_not_allowed` (non-admins without the grant). Called by services/servers.ts `createServer`,
 * the single path every creation (POST /servers, clone, template instantiate, imports) goes through.
 */
export async function assertCanCreateServer(actor: Pick<UserRow, 'id' | 'role'>, key: GameKey): Promise<void> {
  const disabled = await getDisabledGames();
  const allowed = actor.role === 'admin' ? [] : await store.allowedFor(actor.id);
  assertCanCreate({ role: actor.role, allowed, disabled, key, label: labelOfKey(key) });
}

/** 409 `game_disabled` when the server's game has `blockStart` (start, restart, auto-start, schedules, Steam update). */
export async function assertServerCanStart(server: Pick<ServerRow, 'type' | 'steam'>): Promise<void> {
  const key = serverGameKey(server);
  assertStartAllowed(await getDisabledGames(), key, labelOfKey(key));
}

// ---------------------------------------------------------------------------------------------
// Allowlist

export async function getAllowedGames(userId: string): Promise<GameKey[]> {
  return store.allowedFor(userId);
}

/** Granted keys of every user (for the users list). */
export async function allowedGamesByUser(): Promise<Map<string, GameKey[]>> {
  const rows = await query<{ user_id: string; game_key: string }>('SELECT user_id, game_key FROM user_game_access ORDER BY game_key');
  const out = new Map<string, GameKey[]>();
  for (const r of rows) {
    const list = out.get(r.user_id) ?? [];
    list.push(r.game_key);
    out.set(r.user_id, list);
  }
  return out;
}

/** Replace a user's allowlist (keys already validated). */
export async function setAllowedGames(userId: string, games: readonly GameKey[]): Promise<void> {
  await tx(async (client) => {
    await client.query('DELETE FROM user_game_access WHERE user_id = $1', [userId]);
    if (games.length) {
      await client.query('INSERT INTO user_game_access (user_id, game_key) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [userId, games]);
    }
  });
}

/** Forget a game key everywhere (its custom definition was deleted). */
export async function forgetGameKey(key: GameKey): Promise<void> {
  await query('DELETE FROM user_game_access WHERE game_key = $1', [key]);
  const disabled = await getDisabledGames();
  if (disabled[key]) {
    const next = { ...disabled };
    delete next[key];
    await saveDisabledGames(next);
  }
}

// ---------------------------------------------------------------------------------------------
// User JSON

export type PublicUserWithGames = PublicUser & { allowedGames: GameKey[] | null; creatableGames?: GameKey[] };

/** `allowedGames` of a user JSON: null = unrestricted (admin). */
export function allowedGamesField(u: Pick<UserRow, 'role'>, granted: GameKey[] | undefined): GameKey[] | null {
  return u.role === 'admin' ? null : (granted ?? []);
}

/**
 * User JSON with `allowedGames`; with `creatable` also `creatableGames` (GET /auth/me and the login
 * response): for admins every non-disabled key, for others the granted keys minus disabled ones.
 */
export async function publicUserWithGames(u: UserRow, opts: { creatable?: boolean } = {}): Promise<PublicUserWithGames> {
  const allowed = allowedGamesField(u, u.role === 'admin' ? undefined : await store.allowedFor(u.id));
  const out: PublicUserWithGames = { ...toPublicUser(u), allowedGames: allowed };
  if (opts.creatable) out.creatableGames = creatableGames(u.role, allowed, existingGameKeys(), await getDisabledGames());
  return out;
}
