import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeHtml,
  markerInputSchema,
  markerPatchSchemaFor,
  mergeMarkerSets,
  renderMapMarkers,
  renderMarker,
  restrictedFieldsUsed,
  setInputSchema,
  SET_PREFIX,
  splitMarker,
  type MarkerRow,
} from '../src/lib/bluemapMarkers.js';
import { renderEditorScript } from '../src/lib/bluemapEditor.js';

const poi = { type: 'poi', label: 'Home', position: { x: 10, y: 64, z: -5 } };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test('markers: every type validates and bad input is refused', () => {
  assert.ok(markerInputSchema.safeParse(poi).success);
  assert.ok(markerInputSchema.safeParse({ type: 'html', label: 'Town', text: 'Hi', color: '#ff0000', position: poi.position }).success);
  assert.ok(markerInputSchema.safeParse({ type: 'line', label: 'Road', points: [{ x: 0, y: 64, z: 0 }, { x: 5, y: 64, z: 9 }] }).success);
  assert.ok(markerInputSchema.safeParse({ type: 'shape', label: 'Plot', y: 70, points: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }] }).success);
  assert.ok(markerInputSchema.safeParse({ type: 'extrude', label: 'Tower', minY: 60, maxY: 90, points: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }] }).success);
  const bad = [
    { ...poi, label: '' },
    { ...poi, label: 'x'.repeat(81) },
    { ...poi, position: { x: Number.NaN, y: 0, z: 0 } },
    { ...poi, position: { x: 1e9, y: 0, z: 0 } },
    { ...poi, extra: 1 },
    { type: 'line', label: 'x', points: [{ x: 0, y: 0, z: 0 }] },
    { type: 'shape', label: 'x', y: 1, points: [{ x: 0, z: 0 }, { x: 1, z: 1 }] },
    { type: 'html', label: 'x', color: 'red', position: poi.position },
    { type: 'extrude', label: 'x', minY: 90, maxY: 60, points: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }] },
    { ...poi, minDistance: 50, maxDistance: 10 },
    { type: 'nope', label: 'x' },
  ];
  for (const b of bad) assert.equal(markerInputSchema.safeParse(b).success, false, JSON.stringify(b));
});

test('markers: free text is escaped, so an editor cannot script the map page', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const { label, data } = splitMarker({ type: 'poi', label: evil, detail: '<script>alert(1)</script>\nline 2', position: poi.position });
  const out = renderMarker({ type: 'poi', label, data }) as Json;
  assert.ok(!/<(img|script)/i.test(out.detail), out.detail);
  assert.match(out.detail, /&lt;script&gt;/);
  assert.match(out.detail, /<br>line 2/);
  const noDetail = renderMarker({ type: 'poi', label: '<b>x</b>', data: { position: poi.position } }) as Json;
  assert.equal(noDetail.detail, '<b>&lt;b&gt;x&lt;/b&gt;</b>');
  const html = renderMarker({ type: 'html', label: 'l', data: { position: poi.position, text: '<u>t</u>', color: '#00ff00' } }) as Json;
  assert.ok(!html.html.includes('<u>'));
  assert.match(html.html, /color:#00ff00/);
  assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
});

test('markers: rendered like the BlueMap web app reads them', () => {
  const shape = renderMarker({ type: 'shape', label: 'Plot', data: { y: 70, color: '#ff0000', fillOpacity: 0.5, points: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 8 }] } }) as Json;
  assert.equal(shape.type, 'shape');
  assert.equal(shape.shapeY, 70);
  assert.deepEqual(shape.fillColor, { r: 255, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(shape.lineColor, { r: 255, g: 0, b: 0, a: 1 });
  assert.equal(shape.position.y, 70);
  const ext = renderMarker({ type: 'extrude', label: 'T', data: { minY: 60, maxY: 90, points: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }] } }) as Json;
  assert.equal(ext.shapeMinY, 60);
  assert.equal(ext.shapeMaxY, 90);
  const line = renderMarker({ type: 'line', label: 'R', data: { points: [{ x: 0, y: 1, z: 0 }, { x: 2, y: 3, z: 4 }], lineWidth: 5 } }) as Json;
  assert.equal(line.lineWidth, 5);
  assert.deepEqual(line.position, { x: 1, y: 2, z: 2 });
});

test('markers: sets are keyed with our prefix and merged over what BlueMap serves', () => {
  const sets = [{ id: 's1', server_id: 'x', map_id: 'world', label: 'Base', toggleable: true, default_hidden: false, sorting: 0 }];
  const now = new Date();
  const rows: MarkerRow[] = [
    { id: 'm1', server_id: 'x', set_id: 's1', type: 'poi', label: 'Home', data: { position: poi.position }, created_by: 'user:1', created_at: now, updated_at: now },
    { id: 'm2', server_id: 'x', set_id: 'other', type: 'poi', label: 'Elsewhere', data: { position: poi.position }, created_by: 'user:1', created_at: now, updated_at: now },
  ];
  const ours = renderMapMarkers(sets, rows) as Record<string, Json>;
  assert.deepEqual(Object.keys(ours), [`${SET_PREFIX}s1`]);
  assert.deepEqual(Object.keys(ours[`${SET_PREFIX}s1`]!.markers), ['m1']);
  const merged = mergeMarkerSets({ theirs: { label: 'x' } }, ours);
  assert.deepEqual(Object.keys(merged).sort(), ['sc-s1', 'theirs']);
  for (const junk of [null, 'str', 5, [1, 2]]) assert.deepEqual(Object.keys(mergeMarkerSets(junk, ours)), ['sc-s1']);
});

test('markers: patches only accept fields of the marker type', () => {
  assert.ok(markerPatchSchemaFor('poi').safeParse({ label: 'New', position: { x: 1, y: 2, z: 3 } }).success);
  assert.equal(markerPatchSchemaFor('poi').safeParse({ points: [] }).success, false);
  assert.equal(markerPatchSchemaFor('poi').safeParse({ type: 'line' }).success, false);
  assert.ok(markerPatchSchemaFor('shape').safeParse({ y: 5 }).success);
});

test('marker sets: input is validated', () => {
  assert.ok(setInputSchema.safeParse({ mapId: 'world_nether', label: 'Bases' }).success);
  assert.equal(setInputSchema.safeParse({ mapId: '../x', label: 'Bases' }).success, false);
  assert.equal(setInputSchema.safeParse({ mapId: 'w', label: '' }).success, false);
});

test('editor script: valid JavaScript, flag substituted, safe inside a script tag', () => {
  for (const canEdit of [true, false]) {
    const html = renderEditorScript({ canEdit });
    assert.ok(html.startsWith('<script>') && html.endsWith('</script>'));
    const body = html.slice('<script>'.length, -'</script>'.length);
    assert.ok(!/<\/script/i.test(body), 'must not close the script early');
    assert.ok(!body.includes('__CAN_EDIT__'));
    assert.match(body, new RegExp(`var CAN_EDIT = ${canEdit};`));
    assert.doesNotThrow(() => new Function(body));
    if (canEdit) assert.match(body, /\['keydown', 'keyup', 'keypress'\]\.forEach\(function \(type\) \{ root\.addEventListener\(type, function \(e\) \{ e\.stopPropagation/, 'keys typed in the editor must not reach BlueMap');
  }
});

test('markers: the web app needs classes and anchor on pins and labels (without them it drops the marker)', () => {
  const pin = renderMarker({ type: 'poi', label: 'P', data: { position: poi.position } }) as Json;
  assert.deepEqual(pin.classes, []);
  assert.deepEqual(pin.anchor, { x: 25, y: 45 });
  assert.equal(pin.icon, 'assets/poi.svg');
  const label = renderMarker({ type: 'html', label: 'L', data: { position: poi.position } }) as Json;
  assert.deepEqual(label.classes, []);
  assert.deepEqual(label.anchor, { x: 0, y: 0 });
});

test('markers: every BlueMap option is accepted and rendered', () => {
  const pin = markerInputSchema.parse({ type: 'poi', label: 'P', position: poi.position, icon: 'https://x.test/i.png', anchor: { x: 8, y: 8 }, classes: ['a', 'b-c'], detail: '<b>x</b>', detailHtml: true, minDistance: 1, maxDistance: 900, sorting: 3, listed: false });
  const r = renderMarker(splitMarkerInput(pin)) as Json;
  assert.equal(r.icon, 'https://x.test/i.png');
  assert.deepEqual(r.anchor, { x: 8, y: 8 });
  assert.deepEqual(r.classes, ['a', 'b-c']);
  assert.equal(r.detail, '<b>x</b>', 'trusted HTML detail is kept');
  assert.equal(r.minDistance, 1);
  assert.equal(r.maxDistance, 900);
  assert.equal(r.listed, false);
  const area = markerInputSchema.parse({
    type: 'extrude', label: 'A', minY: 10, maxY: 50, lineColor: '#112233', lineOpacity: 0.5, fillColor: '#445566', fillOpacity: 0.7, lineWidth: 4, depthTest: true,
    link: 'https://example.com', newTab: false, detail: 'd',
    points: [{ x: 0, z: 0 }, { x: 9, z: 0 }, { x: 9, z: 9 }], holes: [[{ x: 1, z: 1 }, { x: 2, z: 1 }, { x: 2, z: 2 }]],
  });
  const a = renderMarker(splitMarkerInput(area)) as Json;
  assert.deepEqual(a.lineColor, { r: 17, g: 34, b: 51, a: 0.5 });
  assert.deepEqual(a.fillColor, { r: 68, g: 85, b: 102, a: 0.7 });
  assert.equal(a.holes.length, 1);
  assert.equal(a.link, 'https://example.com');
  assert.equal(a.newTab, false);
  assert.equal(a.depthTest, true);
  assert.equal(a.shapeMinY, 10);
  assert.equal(a.shapeMaxY, 50);
  assert.equal(markerInputSchema.safeParse({ ...area, link: 'javascript:alert(1)' }).success, false);
  assert.equal(markerInputSchema.safeParse({ ...pin, icon: 'javascript:alert(1)' }).success, false);
  assert.equal(markerInputSchema.safeParse({ ...pin, classes: ['bad class'] }).success, false);
  assert.equal(markerInputSchema.safeParse({ ...area, holes: [[{ x: 1, z: 1 }]] }).success, false);
});

test('markers: options that load or run something are restricted to trusted callers', () => {
  assert.deepEqual(restrictedFieldsUsed({ label: 'x', detail: 'plain', icon: 'assets/poi.svg' }), []);
  assert.deepEqual(restrictedFieldsUsed({ icon: 'https://x.test/a.png', link: 'https://a.b', html: '<b>', detailHtml: true }).sort(), ['detailHtml', 'html', 'icon', 'link']);
  assert.deepEqual(restrictedFieldsUsed({ link: null, detailHtml: false }), []);
});

function splitMarkerInput(v: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { label, data } = splitMarker(v);
  return { type: v.type, label, data };
}
