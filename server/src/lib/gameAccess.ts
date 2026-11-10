import { AppError, badRequest, conflict, forbidden } from './errors.js';
import { gameKeyKind, MINECRAFT_KEY, steamIdOfKey, TERRARIA_KEY, type GameKey } from './games.js';

/**
 * Pure decisions for per-user game access and disabled games (SPEC "v0.3.2"). The services layer
 * (services/gameAccess.ts) loads the data and calls these; keeping them pure makes them testable.
 */

/** One entry of the `disabled_games` setting. */
export interface DisabledGame {
  /** Existing servers of the game may not start (and running ones were stopped when it was set). */
  blockStart: boolean;
  disabledAt: string;
  /** Admin who disabled it. */
  by: string | null;
}

/** Value of the `disabled_games` setting: game key -> entry (absent = enabled). */
export type DisabledGames = Record<GameKey, DisabledGame>;

/** Human name of a game key for messages; `definitionName` resolves `steam:<id>` keys. */
export function gameKeyLabel(key: GameKey, definitionName?: (id: string) => string | null | undefined): string {
  if (key === MINECRAFT_KEY) return 'Minecraft';
  if (key === TERRARIA_KEY) return 'Terraria';
  const id = steamIdOfKey(key);
  if (id) return definitionName?.(id) || id;
  return key;
}

/** Normalise a stored/received `disabled_games` value (drops malformed entries). */
export function normalizeDisabledGames(raw: unknown): DisabledGames {
  const out: DisabledGames = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!gameKeyKind(k) || !v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    out[k] = {
      blockStart: e.blockStart === true,
      disabledAt: typeof e.disabledAt === 'string' ? e.disabledAt : new Date(0).toISOString(),
      by: typeof e.by === 'string' ? e.by : null,
    };
  }
  return out;
}

export interface CreateCheck {
  /** Role of the user creating the server (admins are never restricted by the allowlist). */
  role: 'admin' | 'user';
  /** Keys granted to that user (ignored for admins). */
  allowed: readonly GameKey[];
  disabled: DisabledGames;
  key: GameKey;
  label: string;
}

/**
 * Whether a server of `key` may be created: disabled games refuse everyone (409 `game_disabled`),
 * non-admins need the key in their allowlist (403 `game_not_allowed`). Returns the error or null.
 */
export function creationError(c: CreateCheck): AppError | null {
  if (c.disabled[c.key]) return conflict(`${c.label} has been disabled by an administrator; new servers cannot be created for it`, 'game_disabled');
  if (c.role !== 'admin' && !c.allowed.includes(c.key)) {
    return forbidden(`You are not allowed to create ${c.label} servers; ask an administrator to enable this game for you`, 'game_not_allowed');
  }
  return null;
}

export function assertCanCreate(c: CreateCheck): void {
  const err = creationError(c);
  if (err) throw err;
}

/** True when existing servers of `key` may not start. */
export function startBlocked(disabled: DisabledGames, key: GameKey): boolean {
  return disabled[key]?.blockStart === true;
}

/** 409 `game_disabled` when servers of `key` may not start. */
export function assertStartAllowed(disabled: DisabledGames, key: GameKey, label: string): void {
  if (startBlocked(disabled, key)) {
    throw conflict(`${label} has been disabled by an administrator; its servers cannot be started`, 'game_disabled');
  }
}

/**
 * Game keys a user can create servers for: admins every existing key, others their granted keys that
 * still exist; disabled keys are removed for everyone. Order follows `existing`.
 */
export function creatableGames(role: 'admin' | 'user', allowed: readonly GameKey[] | null, existing: readonly GameKey[], disabled: DisabledGames): GameKey[] {
  const grant = role === 'admin' || allowed === null ? null : new Set(allowed);
  return existing.filter((k) => !disabled[k] && (grant === null || grant.has(k)));
}

/**
 * Validate a requested allowlist: de-duplicated, every key must exist (`minecraft`, `terraria` or an
 * existing definition) -> 400 `unknown_game` naming the unknown keys.
 */
export function normalizeGameList(games: readonly string[], existing: readonly GameKey[]): GameKey[] {
  const known = new Set(existing);
  const unknown = games.filter((g) => !known.has(g));
  if (unknown.length) throw badRequest(`Unknown game(s): ${[...new Set(unknown)].join(', ')}`, 'unknown_game', { unknown: [...new Set(unknown)] });
  // Stable order: the order of `existing`.
  const want = new Set(games);
  return existing.filter((k) => want.has(k));
}

/**
 * Next `disabled_games` value after `PUT /admin/games/:key/disabled`. Enabling removes the entry (clears
 * blockStart too); disabling keeps the original `disabledAt` when the game was already disabled (e.g. only
 * `blockStart` changes); `by` is the admin of the latest change. Returns a new object.
 */
export function applyDisabledChange(
  current: DisabledGames,
  key: GameKey,
  change: { disabled: boolean; blockStart?: boolean },
  by: string | null,
  now: Date = new Date(),
): DisabledGames {
  const next: DisabledGames = { ...current };
  if (!change.disabled) {
    delete next[key];
    return next;
  }
  const prev = current[key];
  next[key] = { blockStart: change.blockStart === true, disabledAt: prev?.disabledAt ?? now.toISOString(), by };
  return next;
}

/** Statuses during which a server counts as running for "stop the running servers" and counts. */
export const ACTIVE_STATUSES = ['running', 'starting', 'installing'] as const;

/**
 * Servers that blocking a game must stop: those of `key` whose status is active. Pure; the caller passes
 * every server with its key and current runtime status.
 */
export function serversToStop<T extends { key: GameKey; status: string }>(servers: readonly T[], key: GameKey): T[] {
  return servers.filter((s) => s.key === key && (ACTIVE_STATUSES as readonly string[]).includes(s.status));
}
