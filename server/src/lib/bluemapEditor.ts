/**
 * Script injected into the proxied BlueMap page (SPEC "BlueMap markers (v0.4.6)").
 *
 * - Everyone: refreshes the markers every 15 s (BlueMap stops polling when its live event stream connects, which
 *   never carries ServCrafty's markers) and tells the panel when Escape is pressed (so the panel's fullscreen view
 *   can close even when the keyboard focus is inside the map frame).
 * - Only when the viewer may edit markers: a pin button opens a marker editor. Landscape: a side panel. Portrait: a
 *   bottom sheet that leaves the map visible. "Add marker" collapses it to a small bar with a crosshair in the middle
 *   of the screen: pan the map, then tap "Place here" (no precise tapping needed on a phone).
 *
 * It talks to the panel under the page's own token URL (`__servcrafty/markers`, see routes/webui.ts), uses only GET and
 * POST (no CORS preflight from the sandboxed page) and builds the interface with `textContent`, never `innerHTML`.
 * The source below must not contain backticks or `${` (it lives in a template literal) nor `</script`.
 */
const SOURCE = String.raw`
(function () {
  var CAN_EDIT = __CAN_EDIT__;
  var ES = /^es/i.test(navigator.language || '');
  var T = {
    markers: ES ? 'Marcadores' : 'Markers',
    add: ES ? 'Añadir marcador aquí' : 'Add marker here',
    none: ES ? 'Todavía no hay marcadores en este mapa.' : 'No markers on this map yet.',
    place: ES ? 'Colocar aquí' : 'Place here',
    cancel: ES ? 'Cancelar' : 'Cancel',
    panHint: ES ? 'Mueve el mapa hasta el lugar y pulsa Colocar' : 'Move the map to the spot, then tap Place',
    name: ES ? 'Nombre' : 'Name',
    note: ES ? 'Nota (opcional)' : 'Note (optional)',
    kind: ES ? 'Tipo' : 'Type',
    pin: ES ? 'Pin' : 'Pin',
    text: ES ? 'Texto' : 'Text label',
    set: ES ? 'Grupo' : 'Group',
    pos: ES ? 'Posición' : 'Position',
    center: ES ? 'Usar el centro de la pantalla' : 'Use screen center',
    save: ES ? 'Guardar' : 'Save',
    del: ES ? 'Eliminar' : 'Delete',
    delAsk: ES ? 'Pulsa otra vez para eliminar' : 'Tap again to delete',
    edit: ES ? 'Editar' : 'Edit',
    go: ES ? 'Ir' : 'Go',
    close: ES ? 'Cerrar' : 'Close',
    back: ES ? 'Volver' : 'Back',
    newMarker: ES ? 'Nuevo marcador' : 'New marker',
    editMarker: ES ? 'Editar marcador' : 'Edit marker',
    nameReq: ES ? 'Escribe un nombre.' : 'Enter a name.',
    badPos: ES ? 'La posición no es válida.' : 'The position is not valid.',
    readOnly: ES ? 'Solo lectura' : 'Read only',
    failed: ES ? 'No se pudo completar' : 'Request failed'
  };

  var BASE = location.pathname.replace(/[^\/]*$/, '') + '__servcrafty/markers';

  function app() { return window.bluemap; }
  function mapId() {
    try { var id = app().mapViewer.map.data.id; if (id) return id; } catch (e) {}
    var h = (location.hash || '').slice(1).split(':')[0];
    return h || null;
  }
  function center() {
    try { var p = app().mapViewer.controlsManager.position; if (isFinite(p.x) && isFinite(p.z)) return { x: p.x, y: p.y, z: p.z }; } catch (e) {}
    var v = (location.hash || '').slice(1).split(':');
    if (v.length >= 4 && isFinite(+v[1]) && isFinite(+v[3])) return { x: +v[1], y: +v[2], z: +v[3] };
    return null;
  }
  function refreshMap() { try { var m = app().markerFileManager; if (m && m.update) m.update(); } catch (e) {} }
  function gotoPos(p) {
    try {
      var cm = app().mapViewer.controlsManager;
      cm.position.x = p.x; cm.position.z = p.z; if (isFinite(p.y)) cm.position.y = p.y;
      if (cm.distance > 120) cm.distance = 120;
    } catch (e) {}
  }

  setInterval(refreshMap, 15000);

  var overlayOpen = false; // an editor layer is open: Escape closes that first
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    if (overlayOpen) return; // handled by the editor (below)
    try { window.parent.postMessage({ servcrafty: 'escape' }, '*'); } catch (err) {}
  }, true);

  if (!CAN_EDIT) return;

  // ---- editor -------------------------------------------------------------------------------
  var S = { open: false, view: 'list', placing: false, data: null, editing: null, draft: null, busy: false, error: '', confirmDel: false };

  function api(path, method, body) {
    var opt = { method: method || 'GET', credentials: 'omit' };
    if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers = { 'Content-Type': 'text/plain' }; }
    return fetch(BASE + path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error((j && j.error && j.error.message) || (T.failed + ' (' + r.status + ')'));
        return j;
      });
    });
  }

  function load() {
    var id = mapId();
    if (!id) return Promise.resolve();
    return api('?mapId=' + encodeURIComponent(id)).then(function (d) { S.data = d; render(); }).catch(function (e) { S.error = e.message; render(); });
  }

  function el(tag, cls, kids, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (var k in attrs) { if (k === 'text') n.textContent = attrs[k]; else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]); else n.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function btn(label, cls, fn, extra) { var a = { text: label, type: 'button', onclick: fn }; if (extra) for (var k in extra) a[k] = extra[k]; return el('button', 'scx-btn ' + (cls || ''), null, a); }

  var css = el('style', null, null, { text: [
    '.scx *{box-sizing:border-box}',
    '.scx-fab{position:fixed;left:12px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:2147483000;width:52px;height:52px;border-radius:50%;border:0;background:#2563eb;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;cursor:pointer;touch-action:manipulation}',
    '.scx-fab:hover{background:#1d4ed8}',
    '.scx-panel{position:fixed;z-index:2147483001;background:#161a22;color:#e8ecf3;font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 0 24px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden}',
    '@media (orientation:portrait){.scx-panel{left:0;right:0;bottom:0;max-height:60vh;max-height:60dvh;border-radius:16px 16px 0 0;padding-bottom:env(safe-area-inset-bottom,0px)}}',
    '@media (orientation:landscape){.scx-panel{top:0;right:0;bottom:0;width:min(340px,44vw)}}',
    '.scx-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2a3140;flex:none}',
    '.scx-head h2{margin:0;font-size:16px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.scx-body{overflow:auto;padding:12px;flex:1;min-height:0;-webkit-overflow-scrolling:touch}',
    '.scx-btn{min-height:44px;padding:0 14px;border-radius:10px;border:1px solid #38425a;background:#232a38;color:#e8ecf3;font:inherit;font-weight:500;cursor:pointer;touch-action:manipulation}',
    '.scx-btn:hover{background:#2c3547}.scx-btn:disabled{opacity:.5}',
    '.scx-pri{background:#2563eb;border-color:#2563eb;color:#fff}.scx-pri:hover{background:#1d4ed8}',
    '.scx-dng{color:#ff8a8a;border-color:#6b2b2b}',
    '.scx-sm{min-height:38px;padding:0 10px}',
    '.scx-x{min-height:40px;min-width:40px;padding:0;font-size:20px;line-height:1}',
    '.scx-list{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}',
    '.scx-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #2a3140;border-radius:10px;background:#1b2130}',
    '.scx-item .t{flex:1;min-width:0}.scx-item .t b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.scx-item .t small{color:#9aa6bd}',
    '.scx-field{display:block;margin:0 0 12px}.scx-field>span{display:block;margin-bottom:4px;color:#9aa6bd;font-size:13px}',
    '.scx-in{width:100%;min-height:44px;padding:8px 10px;border-radius:10px;border:1px solid #38425a;background:#0f131a;color:#e8ecf3;font:inherit;font-size:16px}',
    'textarea.scx-in{min-height:76px;resize:vertical}',
    '.scx-row{display:flex;gap:8px}.scx-row>*{flex:1;min-width:0}',
    '.scx-chips{display:flex;gap:8px}.scx-chips .scx-btn{flex:1}.scx-chips .on{background:#2563eb;border-color:#2563eb;color:#fff}',
    '.scx-err{color:#ff9d9d;margin:0 0 10px}.scx-muted{color:#9aa6bd;margin:0}',
    '.scx-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}.scx-actions .scx-pri{flex:1}',
    '.scx-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:2147483001;display:flex;align-items:center;gap:8px;background:#161a22;color:#e8ecf3;font:14px/1.3 system-ui,sans-serif;padding:8px 10px;border-radius:16px;box-shadow:0 2px 14px rgba(0,0,0,.55);max-width:calc(100vw - 20px)}',
    '.scx-bar .c{min-width:0;display:flex;flex-direction:column}.scx-bar .c small{color:#9aa6bd}.scx-bar .c b{font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.scx-cross{position:fixed;left:50%;top:50%;width:40px;height:40px;margin:-20px 0 0 -20px;z-index:2147483000;pointer-events:none}'
  ].join('\n') });

  var root = el('div', 'scx');
  var fab, panel, bar, cross, timer = null;

  var PIN = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10z"/><path d="M12 8v6M9 11h6"/></svg>';
  var CROSS = '<svg viewBox="0 0 40 40" width="40" height="40" fill="none"><g stroke="#000" stroke-width="4" stroke-linecap="round" opacity=".6"><path d="M20 4v10M20 26v10M4 20h10M26 20h10"/></g><g stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M20 4v10M20 26v10M4 20h10M26 20h10"/></g><circle cx="20" cy="20" r="2.5" fill="#fff" stroke="#000" stroke-width="1"/></svg>';

  function fmt(p) { return Math.round(p.x) + ', ' + Math.round(p.y) + ', ' + Math.round(p.z); }
  function mine(m) { return !!S.data && (S.data.all || m.createdBy === S.data.actor); }
  function setName(id) { var s = ((S.data && S.data.sets) || []).filter(function (x) { return x.id === id; })[0]; return s ? s.label : ''; }
  function isPoint(m) { return m.type === 'poi' || m.type === 'html'; }

  function close() { S.open = false; S.placing = false; S.view = 'list'; S.editing = null; S.error = ''; overlayOpen = false; stopTimer(); render(); }
  function startTimer() { stopTimer(); timer = setInterval(updateBar, 400); }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function updateBar() { var c = center(); var n = bar && bar.querySelector('b'); if (c && n) n.textContent = fmt(c); }

  function openForm(marker, at) {
    var c = at || center() || { x: 0, y: 64, z: 0 };
    S.editing = marker || null;
    S.error = ''; S.confirmDel = false;
    S.draft = marker
      ? { type: marker.type, label: marker.label, detail: marker.detail || '', setId: marker.setId, x: marker.position ? marker.position.x : '', y: marker.position ? marker.position.y : '', z: marker.position ? marker.position.z : '' }
      : { type: 'poi', label: '', detail: '', setId: '', x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) };
    S.view = 'form'; S.open = true; S.placing = false; overlayOpen = true; stopTimer(); render();
  }

  function submit() {
    var d = S.draft, ed = S.editing;
    var label = (d.label || '').trim();
    if (!label) { S.error = T.nameReq; return render(); }
    var body = { label: label, detail: d.detail || '' };
    if (!ed || isPoint(ed)) {
      var x = parseFloat(d.x), y = parseFloat(d.y), z = parseFloat(d.z);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { S.error = T.badPos; return render(); }
      body.position = { x: x, y: y, z: z };
    }
    var req;
    if (ed) {
      if (d.setId && d.setId !== ed.setId) body.setId = d.setId;
      req = api('/' + encodeURIComponent(ed.id), 'POST', body);
    } else {
      body.type = d.type; body.mapId = mapId();
      if (d.setId) body.setId = d.setId;
      req = api('', 'POST', body);
    }
    S.busy = true; S.error = ''; render();
    req.then(function () { S.busy = false; S.view = 'list'; S.editing = null; refreshMap(); return load(); })
      .catch(function (e) { S.busy = false; S.error = e.message; render(); });
  }

  function remove() {
    var ed = S.editing; if (!ed) return;
    // The map frame is sandboxed (no modal dialogs): ask by tapping twice.
    if (!S.confirmDel) { S.confirmDel = true; render(); setTimeout(function () { if (S.confirmDel) { S.confirmDel = false; render(); } }, 4000); return; }
    S.confirmDel = false; S.busy = true; render();
    api('/' + encodeURIComponent(ed.id) + '/delete', 'POST', {})
      .then(function () { S.busy = false; S.view = 'list'; S.editing = null; refreshMap(); return load(); })
      .catch(function (e) { S.busy = false; S.error = e.message; render(); });
  }

  function field(label, input) { return el('label', 'scx-field', [el('span', null, null, { text: label }), input]); }
  function input(key, type, extra) {
    var a = { type: type || 'text', value: S.draft[key] === undefined ? '' : String(S.draft[key]), oninput: function (e) { S.draft[key] = e.target.value; } };
    if (extra) for (var k in extra) a[k] = extra[k];
    var n = el('input', 'scx-in', null, a);
    n.value = a.value;
    return n;
  }

  function listView() {
    var markers = (S.data && S.data.markers) || [];
    var kids = [btn(T.add, 'scx-pri', function () { S.placing = true; S.open = false; overlayOpen = true; startTimer(); render(); }, { style: 'width:100%' })];
    if (!markers.length) kids.push(el('p', 'scx-muted', null, { text: T.none, style: 'margin-top:12px' }));
    var ul = el('ul', 'scx-list');
    markers.forEach(function (m) {
      var where = m.position ? fmt(m.position) : '';
      var sub = [setName(m.setId), where].filter(Boolean).join(' · ');
      var actions = [];
      if (m.position) actions.push(btn(T.go, 'scx-sm', function () { gotoPos(m.position); }));
      if (mine(m)) actions.push(btn(T.edit, 'scx-sm', function () { openForm(m); }));
      ul.appendChild(el('li', 'scx-item', [el('div', 't', [el('b', null, null, { text: m.label }), el('small', null, null, { text: sub })])].concat(actions)));
    });
    kids.push(ul);
    return kids;
  }

  function formView() {
    var d = S.draft, ed = S.editing, kids = [];
    if (S.error) kids.push(el('p', 'scx-err', null, { text: S.error, role: 'alert' }));
    kids.push(field(T.name, input('label', 'text', { maxlength: '80', autocomplete: 'off' })));
    if (!ed) {
      var chips = el('div', 'scx-chips');
      [['poi', T.pin], ['html', T.text]].forEach(function (k) { chips.appendChild(btn(k[1], d.type === k[0] ? 'on' : '', function () { d.type = k[0]; render(); })); });
      kids.push(field(T.kind, chips));
    }
    var ta = el('textarea', 'scx-in', null, { maxlength: '500', oninput: function (e) { d.detail = e.target.value; } });
    ta.value = d.detail || '';
    kids.push(field(T.note, ta));
    var sets = (S.data && S.data.sets) || [];
    if (sets.length > 1) {
      var sel = el('select', 'scx-in', sets.map(function (s) { return el('option', null, null, { value: s.id, text: s.label }); }), { onchange: function (e) { d.setId = e.target.value; } });
      sel.value = d.setId || sets[0].id;
      if (!d.setId) d.setId = sets[0].id;
      kids.push(field(T.set, sel));
    }
    if (!ed || isPoint(ed)) {
      var nums = { inputmode: 'decimal', step: 'any' };
      kids.push(field(T.pos, el('div', 'scx-row', [input('x', 'number', nums), input('y', 'number', nums), input('z', 'number', nums)])));
      kids.push(btn(T.center, 'scx-sm', function () { var c = center(); if (c) { d.x = Math.round(c.x); d.y = Math.round(c.y); d.z = Math.round(c.z); render(); } }, { style: 'margin:-4px 0 12px' }));
    }
    var acts = el('div', 'scx-actions', [
      btn(T.save, 'scx-pri', submit, S.busy ? { disabled: 'disabled' } : null),
      btn(T.cancel, '', function () { S.view = 'list'; S.editing = null; S.error = ''; render(); })
    ]);
    if (ed) acts.appendChild(btn(S.confirmDel ? T.delAsk : T.del, 'scx-dng', remove, S.busy ? { disabled: 'disabled' } : null));
    kids.push(acts);
    return kids;
  }

  function render() {
    if (!fab) return;
    fab.style.display = S.open || S.placing ? 'none' : 'flex';
    cross.style.display = S.placing ? 'block' : 'none';
    bar.style.display = S.placing ? 'flex' : 'none';
    panel.style.display = S.open ? 'flex' : 'none';
    if (S.placing) updateBar();
    if (!S.open) return;
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    var title = S.view === 'form' ? (S.editing ? T.editMarker : T.newMarker) : T.markers;
    var head = el('div', 'scx-head');
    if (S.view === 'form') head.appendChild(btn('‹', 'scx-x', function () { S.view = 'list'; S.editing = null; S.error = ''; render(); }, { 'aria-label': T.back }));
    head.appendChild(el('h2', null, null, { text: title }));
    head.appendChild(btn('×', 'scx-x', close, { 'aria-label': T.close }));
    var body = el('div', 'scx-body');
    if (S.view === 'list' && S.error) body.appendChild(el('p', 'scx-err', null, { text: S.error }));
    (S.view === 'form' ? formView() : listView()).forEach(function (n) { body.appendChild(n); });
    panel.appendChild(head); panel.appendChild(body);
  }

  function build() {
    fab = btn('', 'scx-fab', function () { S.open = true; S.view = 'list'; S.error = ''; overlayOpen = true; render(); load(); }, { 'aria-label': T.markers, title: T.markers });
    fab.className = 'scx-fab';
    fab.innerHTML = PIN;
    panel = el('div', 'scx-panel', null, { role: 'dialog', 'aria-label': T.markers });
    cross = el('div', 'scx-cross'); cross.innerHTML = CROSS;
    bar = el('div', 'scx-bar', [
      el('div', 'c', [el('small', null, null, { text: T.panHint }), el('b', null, null, { text: '' })]),
      btn(T.cancel, 'scx-sm', function () { S.placing = false; overlayOpen = false; stopTimer(); render(); }),
      btn(T.place, 'scx-pri scx-sm', function () { var c = center(); openForm(null, c || undefined); })
    ]);
    [css, fab, panel, cross, bar].forEach(function (n) { root.appendChild(n); });
    document.body.appendChild(root);
    render();
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (S.open || S.placing) { e.stopPropagation(); if (S.view === 'form') { S.view = 'list'; S.editing = null; S.error = ''; render(); } else close(); }
    }, true);
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
`;

/** The `<script>` to put in the proxied BlueMap page's head. */
export function renderEditorScript(opts: { canEdit: boolean }): string {
  return `<script>${SOURCE.replace('__CAN_EDIT__', opts.canEdit ? 'true' : 'false')}</script>`;
}
