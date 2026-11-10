import fsp from 'node:fs/promises';
import path from 'node:path';
import { SERVER_ROOT } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { GAME_ID_RE, mainPort, validateDefinition, type DefinitionIssue, type GameDefinition } from '../lib/gameDefinition.js';
import type { UserRow } from './types.js';

/**
 * Registry of game definitions: built-ins (read-only JSON files in `server/games/`, loaded at boot)
 * plus custom ones (table `game_definitions`). Kept in memory so lookups are synchronous; every write
 * goes through this module and updates the cache.
 */

export interface DefinitionEntry {
  definition: GameDefinition;
  builtin: boolean;
  ownerId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Directory of the built-in definitions (overridable for tests/dev via GAMES_DIR). */
export function builtinGamesDir(): string {
  return process.env.GAMES_DIR ? path.resolve(process.env.GAMES_DIR) : path.join(SERVER_ROOT, 'games');
}

const builtins = new Map<string, DefinitionEntry>();
const customs = new Map<string, DefinitionEntry>();

type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/** Read + validate every `*.json` in `dir`. Invalid files are reported, never thrown. */
export async function readDefinitionDir(dir: string): Promise<{ ok: GameDefinition[]; failed: { file: string; errors: DefinitionIssue[] }[] }> {
  const ok: GameDefinition[] = [];
  const failed: { file: string; errors: DefinitionIssue[] }[] = [];
  let files: string[] = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  } catch {
    return { ok, failed };
  }
  const ids = new Set<string>();
  for (const file of files) {
    let json: unknown;
    try {
      json = JSON.parse(await fsp.readFile(path.join(dir, file), 'utf8'));
    } catch (err) {
      failed.push({ file, errors: [{ path: '', message: `invalid JSON: ${(err as Error).message}` }] });
      continue;
    }
    const r = validateDefinition(json);
    if (!r.ok) {
      failed.push({ file, errors: r.errors });
      continue;
    }
    if (ids.has(r.definition.id)) {
      failed.push({ file, errors: [{ path: 'id', message: `duplicate id "${r.definition.id}"` }] });
      continue;
    }
    ids.add(r.definition.id);
    ok.push(r.definition);
  }
  return { ok, failed };
}

/** Load built-ins from disk and custom definitions from the database. Called at boot. */
export async function loadGameDefinitions(log: Logger): Promise<void> {
  const dir = builtinGamesDir();
  const { ok, failed } = await readDefinitionDir(dir);
  builtins.clear();
  for (const def of ok) builtins.set(def.id, { definition: def, builtin: true, ownerId: null, createdAt: null, updatedAt: null });
  for (const f of failed) log.error({ file: f.file, errors: f.errors }, 'invalid built-in game definition skipped');
  log.info({ dir, count: builtins.size }, 'built-in game definitions loaded');

  customs.clear();
  const rows = await query<{ id: string; definition: unknown; owner_id: string | null; created_at: Date; updated_at: Date }>(
    'SELECT id, definition, owner_id, created_at, updated_at FROM game_definitions ORDER BY id',
  );
  for (const row of rows) {
    const r = validateDefinition(row.definition);
    if (!r.ok) {
      log.warn({ id: row.id, errors: r.errors }, 'stored custom game definition is invalid and was skipped');
      continue;
    }
    if (builtins.has(row.id)) {
      log.warn({ id: row.id }, 'custom game definition shadows a built-in and was skipped');
      continue;
    }
    customs.set(row.id, {
      definition: r.definition,
      builtin: false,
      ownerId: row.owner_id,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  }
}

/** Test/boot helper: register definitions directly (no DB). */
export function registerDefinitionsForTest(defs: GameDefinition[], builtin = true): void {
  for (const d of defs) (builtin ? builtins : customs).set(d.id, { definition: d, builtin, ownerId: null, createdAt: null, updatedAt: null });
}

export function getEntry(id: string): DefinitionEntry | null {
  return builtins.get(id) ?? customs.get(id) ?? null;
}

export function getDefinition(id: string | null | undefined): GameDefinition | null {
  if (!id) return null;
  return getEntry(id)?.definition ?? null;
}

/** The definition a server/request refers to, or 400 `unknown_game`. */
export function requireDefinition(id: string): GameDefinition {
  const d = getDefinition(id);
  if (!d) throw badRequest(`Unknown game "${id}"`, 'unknown_game');
  return d;
}

export function listEntries(): DefinitionEntry[] {
  return [...builtins.values(), ...customs.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name));
}

/**
 * GET /games item (any user): the full definition minus `scripts`, web UI auth reduced to its type,
 * plus registry/feature flags.
 */
export function definitionSummary(e: DefinitionEntry) {
  const { scripts: _scripts, ...d } = e.definition;
  void _scripts;
  const main = mainPort(e.definition);
  return {
    ...d,
    ports: d.ports.map((p) => ({ ...p, main: p === main })),
    webui: d.webui.map((w) => ({ ...w, auth: { type: w.auth.type } })),
    builtin: e.builtin,
    hasWorkshop: !!d.workshop,
    hasWebui: d.webui.length > 0,
    hasConsole: d.console.stdin,
    hasPlayers: !!(d.players || d.query?.a2s),
  };
}

/** GET /games/:id (authors): the full definition plus registry metadata. */
export function definitionDetail(e: DefinitionEntry) {
  return { ...e.definition, builtin: e.builtin, ownerId: e.ownerId, createdAt: e.createdAt, updatedAt: e.updatedAt };
}

// ---------------------------------------------------------------------------------------------
// Authoring

export function canAuthorGames(user: Pick<UserRow, 'role' | 'can_author_games'>): boolean {
  return user.role === 'admin' || user.can_author_games === true;
}

export function requireAuthor(user: Pick<UserRow, 'role' | 'can_author_games'>): void {
  if (!canAuthorGames(user)) throw forbidden('Creating game definitions requires the "author games" permission', 'forbidden');
}

/** Non-admin authors may only change their own custom definitions (they run in other users' servers too). */
export function assertCanModify(user: Pick<UserRow, 'id' | 'role' | 'can_author_games'>, e: DefinitionEntry): void {
  requireAuthor(user);
  if (e.builtin) throw conflict('Built-in game definitions are read-only; duplicate it instead', 'builtin_readonly');
  if (user.role !== 'admin' && e.ownerId !== user.id) throw forbidden('Only the author or an admin can change this definition', 'forbidden');
}

export function invalidDefinition(errors: DefinitionIssue[]): AppError {
  const first = errors[0];
  return new AppError(
    400,
    'invalid_game_definition',
    first ? `${first.path || '(root)'}: ${first.message}` : 'Invalid game definition',
    errors,
  );
}

/** Validate a body as a definition, or throw 400 `invalid_game_definition` with details. */
export function parseDefinitionBody(body: unknown): GameDefinition {
  const r = validateDefinition(body);
  if (!r.ok) throw invalidDefinition(r.errors);
  return r.definition;
}

export async function createCustomDefinition(user: UserRow, body: unknown): Promise<DefinitionEntry> {
  requireAuthor(user);
  const def = parseDefinitionBody(body);
  if (builtins.has(def.id)) throw conflict(`"${def.id}" is a built-in game id; choose another id`, 'builtin_readonly');
  if (customs.has(def.id)) throw conflict(`A game definition "${def.id}" already exists`, 'game_exists');
  const row = await queryOne<{ created_at: Date; updated_at: Date }>(
    `INSERT INTO game_definitions (id, definition, owner_id) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING RETURNING created_at, updated_at`,
    [def.id, JSON.stringify(body), user.id],
  );
  if (!row) throw conflict(`A game definition "${def.id}" already exists`, 'game_exists');
  const e: DefinitionEntry = {
    definition: def,
    builtin: false,
    ownerId: user.id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  customs.set(def.id, e);
  return e;
}

export async function updateCustomDefinition(user: UserRow, id: string, body: unknown): Promise<DefinitionEntry> {
  const e = getEntryOr404(id);
  assertCanModify(user, e);
  const def = parseDefinitionBody(body);
  if (def.id !== id) throw badRequest('The definition id cannot be changed; create a new definition instead', 'game_id_mismatch');
  const row = await queryOne<{ updated_at: Date }>(
    'UPDATE game_definitions SET definition = $2, updated_at = now() WHERE id = $1 RETURNING updated_at',
    [id, JSON.stringify(body)],
  );
  if (!row) throw notFound('Game definition not found', 'game_not_found');
  const next: DefinitionEntry = { ...e, definition: def, updatedAt: row.updated_at.toISOString() };
  customs.set(id, next);
  return next;
}

export async function deleteCustomDefinition(user: UserRow, id: string): Promise<DefinitionEntry> {
  const e = getEntryOr404(id);
  assertCanModify(user, e);
  const used = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM servers WHERE steam->>'gameId' = $1`, [id]);
  if ((used?.n ?? 0) > 0) throw conflict(`${used!.n} server(s) use this game; delete them first`, 'game_in_use');
  await query('DELETE FROM game_definitions WHERE id = $1', [id]);
  customs.delete(id);
  return e;
}

export function getEntryOr404(id: string): DefinitionEntry {
  const e = GAME_ID_RE.test(id) ? getEntry(id) : null;
  if (!e) throw notFound('Game definition not found', 'game_not_found');
  return e;
}
