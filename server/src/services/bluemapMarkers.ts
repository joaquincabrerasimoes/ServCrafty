import { query, queryOne } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import {
  DEFAULT_SET_LABEL,
  MAX_MARKERS_PER_SERVER,
  MAX_SETS_PER_SERVER,
  markerInputSchema,
  markerPatchSchemaFor,
  mergeMarkerSets,
  publicMarker,
  publicSet,
  renderMapMarkers,
  restrictedFieldsUsed,
  setInputSchema,
  setPatchSchema,
  splitMarker,
  type MarkerInput,
  type MarkerRow,
  type MarkerSetRow,
  type SetInput,
} from '../lib/bluemapMarkers.js';
import { parse } from '../lib/validation.js';

/**
 * Who is changing markers. Panel users with operator access (or more) may change any marker; a public link
 * that may edit only changes the markers that same link created (so a leaked link cannot wipe the rest).
 */
export interface MarkerActor {
  /** `user:<id>` or `link:<id>`, stored as `created_by`. */
  id: string;
  /** May touch markers other actors created. */
  all: boolean;
}

export const userActor = (userId: string): MarkerActor => ({ id: `user:${userId}`, all: true });
export const linkActor = (linkId: string): MarkerActor => ({ id: `link:${linkId}`, all: false });

const UUID = /^[0-9a-f-]{36}$/i;

// ---------------------------------------------------------------------------------------------
// Sets

export async function listSets(serverId: string, mapId?: string): Promise<MarkerSetRow[]> {
  return query<MarkerSetRow>(
    `SELECT * FROM bluemap_marker_sets WHERE server_id = $1 AND ($2::text IS NULL OR map_id = $2) ORDER BY map_id, sorting, created_at`,
    [serverId, mapId ?? null],
  );
}

async function getSet(serverId: string, id: string): Promise<MarkerSetRow> {
  const row = UUID.test(id) ? await queryOne<MarkerSetRow>('SELECT * FROM bluemap_marker_sets WHERE id = $1 AND server_id = $2', [id, serverId]) : null;
  if (!row) throw notFound('Marker set not found', 'marker_set_not_found');
  return row;
}

export async function createSet(serverId: string, body: unknown): Promise<MarkerSetRow> {
  const input: SetInput = parse(setInputSchema, body);
  const n = await queryOne<{ n: number }>('SELECT count(*)::int AS n FROM bluemap_marker_sets WHERE server_id = $1', [serverId]);
  if ((n?.n ?? 0) >= MAX_SETS_PER_SERVER) throw conflict(`At most ${MAX_SETS_PER_SERVER} marker sets per server`, 'too_many_marker_sets');
  const row = await queryOne<MarkerSetRow>(
    'INSERT INTO bluemap_marker_sets (server_id, map_id, label, toggleable, default_hidden, sorting) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [serverId, input.mapId, input.label, input.toggleable ?? true, input.defaultHidden ?? false, input.sorting ?? 0],
  );
  return row!;
}

export async function updateSet(serverId: string, id: string, body: unknown): Promise<MarkerSetRow> {
  await getSet(serverId, id);
  const p = parse(setPatchSchema, body);
  const row = await queryOne<MarkerSetRow>(
    `UPDATE bluemap_marker_sets
        SET label = coalesce($3, label), toggleable = coalesce($4, toggleable),
            default_hidden = coalesce($5, default_hidden), sorting = coalesce($6, sorting)
      WHERE id = $1 AND server_id = $2 RETURNING *`,
    [id, serverId, p.label ?? null, p.toggleable ?? null, p.defaultHidden ?? null, p.sorting ?? null],
  );
  return row!;
}

/** Deleting a set deletes its markers. */
export async function deleteSet(serverId: string, id: string): Promise<void> {
  await getSet(serverId, id);
  await query('DELETE FROM bluemap_marker_sets WHERE id = $1 AND server_id = $2', [id, serverId]);
}

/** The set a map's new markers go to when the caller names none: created on first use. */
export async function defaultSet(serverId: string, mapId: string): Promise<MarkerSetRow> {
  const existing = await queryOne<MarkerSetRow>('SELECT * FROM bluemap_marker_sets WHERE server_id = $1 AND map_id = $2 ORDER BY sorting, created_at LIMIT 1', [
    serverId,
    mapId,
  ]);
  return existing ?? createSet(serverId, { mapId, label: DEFAULT_SET_LABEL });
}

// ---------------------------------------------------------------------------------------------
// Markers

export async function listMarkers(serverId: string, mapId?: string): Promise<MarkerRow[]> {
  return query<MarkerRow>(
    `SELECT m.* FROM bluemap_markers m JOIN bluemap_marker_sets s ON s.id = m.set_id
      WHERE m.server_id = $1 AND ($2::text IS NULL OR s.map_id = $2) ORDER BY m.created_at`,
    [serverId, mapId ?? null],
  );
}

async function getMarker(serverId: string, id: string): Promise<MarkerRow> {
  const row = UUID.test(id) ? await queryOne<MarkerRow>('SELECT * FROM bluemap_markers WHERE id = $1 AND server_id = $2', [id, serverId]) : null;
  if (!row) throw notFound('Marker not found', 'marker_not_found');
  return row;
}

/** Options that load or run something chosen by the editor are for panel users only (see lib/bluemapMarkers.ts). */
function assertAllowedOptions(actor: MarkerActor, body: Record<string, unknown>): void {
  if (actor.all) return;
  const bad = restrictedFieldsUsed(body);
  if (bad.length) throw forbidden(`Public edit links cannot set: ${bad.join(', ')}`, 'marker_option_restricted');
}

function assertMayChange(actor: MarkerActor, m: MarkerRow): void {
  if (!actor.all && m.created_by !== actor.id) throw forbidden('This link can only change the markers it created', 'marker_not_yours');
}

/** `body` is a marker as the API shows it (`type`, `label`, ...) plus `setId` (or `mapId` for the map's default set). */
export async function createMarker(serverId: string, actor: MarkerActor, body: unknown): Promise<MarkerRow> {
  const raw = (body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const setId = typeof raw.setId === 'string' ? raw.setId : null;
  const mapId = typeof raw.mapId === 'string' ? raw.mapId : null;
  delete raw.setId;
  delete raw.mapId;
  assertAllowedOptions(actor, raw);
  const input: MarkerInput = parse(markerInputSchema, raw);
  let set: MarkerSetRow;
  if (setId) set = await getSet(serverId, setId);
  else if (mapId) {
    if (!/^[\w.\- ]{1,100}$/.test(mapId)) throw badRequest('Invalid map id', 'invalid_map');
    set = await defaultSet(serverId, mapId);
  } else throw badRequest('Give setId (or mapId for the default set of a map)', 'marker_set_required');
  const n = await queryOne<{ n: number }>('SELECT count(*)::int AS n FROM bluemap_markers WHERE server_id = $1', [serverId]);
  if ((n?.n ?? 0) >= MAX_MARKERS_PER_SERVER) throw conflict(`At most ${MAX_MARKERS_PER_SERVER} markers per server`, 'too_many_markers');
  const { label, data } = splitMarker(input);
  const row = await queryOne<MarkerRow>(
    'INSERT INTO bluemap_markers (server_id, set_id, type, label, data, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [serverId, set.id, input.type, label, JSON.stringify(data), actor.id],
  );
  return row!;
}

/** Change fields of a marker (its type cannot change); `setId` moves it to another set of the same map. */
export async function updateMarker(serverId: string, actor: MarkerActor, id: string, body: unknown): Promise<MarkerRow> {
  const current = await getMarker(serverId, id);
  assertMayChange(actor, current);
  const raw = (body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const setId = typeof raw.setId === 'string' ? raw.setId : null;
  delete raw.setId;
  delete raw.type;
  // `null` clears an optional field (back to its default).
  const clear = Object.keys(raw).filter((k) => raw[k] === null && k !== 'label');
  for (const k of clear) delete raw[k];
  assertAllowedOptions(actor, raw);
  const patch = parse(markerPatchSchemaFor(current.type), raw) as Record<string, unknown>;
  let nextSet = current.set_id;
  if (setId && setId !== current.set_id) {
    const [from, to] = await Promise.all([getSet(serverId, current.set_id), getSet(serverId, setId)]);
    if (from.map_id !== to.map_id) throw badRequest('A marker cannot move to a set of another map', 'marker_set_map_mismatch');
    nextSet = to.id;
  }
  const { label, ...rest } = patch;
  // Re-validate the merged result so a partial update can never leave a marker the web map cannot draw.
  const nextData: Record<string, unknown> = { ...current.data, ...rest };
  for (const k of clear) delete nextData[k];
  const merged = { type: current.type, label: (label as string | undefined) ?? current.label, ...nextData };
  parse(markerInputSchema, merged);
  const row = await queryOne<MarkerRow>(
    'UPDATE bluemap_markers SET set_id = $3, label = $4, data = $5, updated_at = now() WHERE id = $1 AND server_id = $2 RETURNING *',
    [id, serverId, nextSet, merged.label, JSON.stringify(nextData)],
  );
  return row!;
}

export async function deleteMarker(serverId: string, actor: MarkerActor, id: string): Promise<void> {
  const current = await getMarker(serverId, id);
  assertMayChange(actor, current);
  await query('DELETE FROM bluemap_markers WHERE id = $1 AND server_id = $2', [id, serverId]);
}

// ---------------------------------------------------------------------------------------------
// Serving

/** Our sets of a map merged into the markers BlueMap itself serves (`upstream`, parsed JSON or anything). */
export async function mapMarkersJson(serverId: string, mapId: string, upstream: unknown): Promise<Record<string, unknown>> {
  const [sets, markers] = await Promise.all([listSets(serverId, mapId), listMarkers(serverId, mapId)]);
  return mergeMarkerSets(upstream, renderMapMarkers(sets, markers));
}

/** Everything the editor needs for one map: the sets and the markers (API representation). */
export async function mapOverview(serverId: string, mapId: string) {
  const [sets, markers] = await Promise.all([listSets(serverId, mapId), listMarkers(serverId, mapId)]);
  return { sets: sets.map(publicSet), markers: markers.map(publicMarker) };
}

export { publicMarker, publicSet };
