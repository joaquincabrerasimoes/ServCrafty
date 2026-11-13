import { z } from 'zod';

/**
 * BlueMap markers kept by ServCrafty (SPEC "BlueMap markers (v0.4.6)"). The shapes follow the BlueMap API
 * (`MarkerSet`, `POIMarker`, `HtmlMarker`, `LineMarker`, `ShapeMarker`, `ExtrudeMarker`). BlueMap itself does not
 * persist API markers, so they live in the panel database and are served to the web map as `live/markers.json`.
 * Free text is never passed as HTML: it is escaped here, so a public editor cannot script the map page.
 */

export const MARKER_TYPES = ['poi', 'html', 'line', 'shape', 'extrude'] as const;
export type MarkerType = (typeof MARKER_TYPES)[number];

export const MAX_MARKERS_PER_SERVER = 2000;
export const MAX_SETS_PER_SERVER = 50;
export const MAX_POINTS = 200;
/** Id prefix of our sets in `markers.json`, so they can never collide with the ones BlueMap/other addons define. */
export const SET_PREFIX = 'sc-';
export const DEFAULT_SET_LABEL = 'ServCrafty';

const coord = z.number().finite().min(-30_000_000).max(30_000_000);
const height = z.number().finite().min(-4096).max(4096);
const point3 = z.object({ x: coord, y: height, z: coord }).strict();
const point2 = z.object({ x: coord, z: coord }).strict();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a color like #ff5555');
const distance = z.number().finite().min(0).max(1_000_000);

const common = {
  label: z.string().trim().min(1).max(80),
  /** Plain text (shown when the marker is clicked). */
  detail: z.string().max(500).optional(),
  listed: z.boolean().optional(),
  sorting: z.number().int().min(-1000).max(1000).optional(),
  minDistance: distance.optional(),
  maxDistance: distance.optional(),
};

const poi = z.object({ type: z.literal('poi'), ...common, position: point3 }).strict();
const htmlMarker = z
  .object({
    type: z.literal('html'),
    ...common,
    position: point3,
    /** The text shown on the map (escaped, not HTML). Defaults to the label. */
    text: z.string().trim().min(1).max(120).optional(),
    color: color.optional(),
  })
  .strict();
const line = z
  .object({
    type: z.literal('line'),
    ...common,
    points: z.array(point3).min(2).max(MAX_POINTS),
    lineWidth: z.number().int().min(1).max(30).optional(),
    color: color.optional(),
    depthTest: z.boolean().optional(),
  })
  .strict();
const shape = z
  .object({
    type: z.literal('shape'),
    ...common,
    points: z.array(point2).min(3).max(MAX_POINTS),
    y: height,
    lineWidth: z.number().int().min(1).max(30).optional(),
    color: color.optional(),
    fillOpacity: z.number().min(0).max(1).optional(),
    depthTest: z.boolean().optional(),
  })
  .strict();
const extrude = z
  .object({
    type: z.literal('extrude'),
    ...common,
    points: z.array(point2).min(3).max(MAX_POINTS),
    minY: height,
    maxY: height,
    lineWidth: z.number().int().min(1).max(30).optional(),
    color: color.optional(),
    fillOpacity: z.number().min(0).max(1).optional(),
    depthTest: z.boolean().optional(),
  })
  .strict();

export const markerInputSchema = z.discriminatedUnion('type', [poi, htmlMarker, line, shape, extrude]).superRefine((m, ctx) => {
  if (m.type === 'extrude' && m.maxY < m.minY) ctx.addIssue({ code: 'custom', message: 'maxY must be at least minY', path: ['maxY'] });
  if (m.minDistance !== undefined && m.maxDistance !== undefined && m.maxDistance < m.minDistance) {
    ctx.addIssue({ code: 'custom', message: 'maxDistance must be at least minDistance', path: ['maxDistance'] });
  }
});
export type MarkerInput = z.infer<typeof markerInputSchema>;

/** Update: any subset of the fields of the marker's own type (the type itself cannot change). */
export function markerPatchSchemaFor(type: MarkerType) {
  const full = { poi, html: htmlMarker, line, shape, extrude }[type] as unknown as z.ZodObject<z.ZodRawShape>;
  return full.omit({ type: true }).partial().strict();
}

export const setInputSchema = z
  .object({
    mapId: z.string().trim().min(1).max(100).regex(/^[\w.\- ]+$/, 'Invalid map id'),
    label: z.string().trim().min(1).max(80),
    toggleable: z.boolean().optional(),
    defaultHidden: z.boolean().optional(),
    sorting: z.number().int().min(-1000).max(1000).optional(),
  })
  .strict();
export type SetInput = z.infer<typeof setInputSchema>;
export const setPatchSchema = setInputSchema.omit({ mapId: true }).partial().strict();

// ---------------------------------------------------------------------------------------------
// Storage shape and rendering

export interface MarkerSetRow {
  id: string;
  server_id: string;
  map_id: string;
  label: string;
  toggleable: boolean;
  default_hidden: boolean;
  sorting: number;
}

export interface MarkerRow {
  id: string;
  server_id: string;
  set_id: string;
  type: MarkerType;
  label: string;
  /** Everything except `type` and `label`. */
  data: Record<string, unknown>;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const textToHtml = (s: string) => escapeHtml(s).replace(/\r?\n/g, '<br>');

function rgba(hex: string | undefined, alpha: number, fallback = '#ff5555') {
  const h = (hex && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : fallback).slice(1);
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: alpha };
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

/** One marker in the JSON the BlueMap web app reads (`MarkerSet.updateMarkerFromData`). */
export function renderMarker(m: Pick<MarkerRow, 'type' | 'label' | 'data'>): Record<string, unknown> {
  const d = m.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const base: Record<string, unknown> = { type: m.type, label: m.label, listed: d.listed ?? true, sorting: d.sorting ?? 0 };
  if (d.minDistance !== undefined) base.minDistance = d.minDistance;
  if (d.maxDistance !== undefined) base.maxDistance = d.maxDistance;
  const detail = typeof d.detail === 'string' && d.detail.trim() ? textToHtml(d.detail) : undefined;
  switch (m.type) {
    case 'poi':
      return { ...base, position: d.position, detail: detail ?? `<b>${escapeHtml(m.label)}</b>` };
    case 'html': {
      const text = escapeHtml(d.text ?? m.label);
      const style = `color:${d.color ?? '#ffffff'};font-weight:600;white-space:nowrap;text-shadow:0 0 3px #000,0 0 3px #000;transform:translate(-50%,-50%);pointer-events:none`;
      return { ...base, position: d.position, html: `<div style="${style}">${text}</div>`, anchor: { x: 0, y: 0 } };
    }
    case 'line': {
      const pts = d.points as { x: number; y: number; z: number }[];
      return {
        ...base,
        position: { x: avg(pts.map((p) => p.x)), y: avg(pts.map((p) => p.y)), z: avg(pts.map((p) => p.z)) },
        line: pts,
        lineWidth: d.lineWidth ?? 3,
        lineColor: rgba(d.color, 1),
        depthTest: d.depthTest ?? false,
        ...(detail ? { detail } : {}),
      };
    }
    case 'shape': {
      const pts = d.points as { x: number; z: number }[];
      return {
        ...base,
        position: { x: avg(pts.map((p) => p.x)), y: d.y, z: avg(pts.map((p) => p.z)) },
        shape: pts,
        shapeY: d.y,
        lineWidth: d.lineWidth ?? 2,
        lineColor: rgba(d.color, 1),
        fillColor: rgba(d.color, d.fillOpacity ?? 0.25),
        depthTest: d.depthTest ?? false,
        ...(detail ? { detail } : {}),
      };
    }
    case 'extrude': {
      const pts = d.points as { x: number; z: number }[];
      return {
        ...base,
        position: { x: avg(pts.map((p) => p.x)), y: (d.minY + d.maxY) / 2, z: avg(pts.map((p) => p.z)) },
        shape: pts,
        shapeMinY: d.minY,
        shapeMaxY: d.maxY,
        lineWidth: d.lineWidth ?? 2,
        lineColor: rgba(d.color, 1),
        fillColor: rgba(d.color, d.fillOpacity ?? 0.25),
        depthTest: d.depthTest ?? false,
        ...(detail ? { detail } : {}),
      };
    }
  }
}

/** The `live/markers.json` of one map: our sets (ids prefixed) with their markers. */
export function renderMapMarkers(sets: MarkerSetRow[], markers: MarkerRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sets) {
    const items: Record<string, unknown> = {};
    for (const m of markers) if (m.set_id === s.id) items[m.id] = renderMarker(m);
    out[`${SET_PREFIX}${s.id}`] = { label: s.label, toggleable: s.toggleable, defaultHidden: s.default_hidden, sorting: s.sorting, markers: items };
  }
  return out;
}

/**
 * Our sets merged into whatever BlueMap itself serves for the map (its own config markers, other addons).
 * Anything that is not a plain object of sets is ignored; our ids win on a (practically impossible) clash.
 */
export function mergeMarkerSets(upstream: unknown, ours: Record<string, unknown>): Record<string, unknown> {
  const base = upstream && typeof upstream === 'object' && !Array.isArray(upstream) ? (upstream as Record<string, unknown>) : {};
  return { ...base, ...ours };
}

/** The API representation of a stored marker. */
export function publicMarker(m: MarkerRow) {
  return {
    id: m.id,
    setId: m.set_id,
    type: m.type,
    label: m.label,
    ...m.data,
    createdBy: m.created_by,
    createdAt: new Date(m.created_at).toISOString(),
    updatedAt: new Date(m.updated_at).toISOString(),
  };
}

export function publicSet(s: MarkerSetRow) {
  return { id: s.id, mapId: s.map_id, label: s.label, toggleable: s.toggleable, defaultHidden: s.default_hidden, sorting: s.sorting };
}

/** Split a validated marker into the stored `label` and `data`. */
export function splitMarker(input: { type: MarkerType; label: string } & Record<string, unknown>): { label: string; data: Record<string, unknown> } {
  const { type: _type, label, ...data } = input;
  void _type;
  return { label, data };
}
