/**
 * Script injected into the proxied BlueMap page (SPEC "BlueMap markers").
 *
 * - Everyone: refreshes the markers every 15 s (BlueMap's own polling is paused while its live event stream is in use,
 *   and the panel never serves that stream) and tells the panel when Escape is pressed (so the panel's fullscreen view
 *   can close even when the keyboard focus is inside the map frame).
 * - Only when the viewer may edit markers: a pin button opens the marker editor. Landscape: a side panel. Portrait: a
 *   bottom sheet that leaves the map visible. Placing a point collapses it to a small bar with a crosshair in the
 *   middle of the screen: pan the map, then tap "Place here" (no precise tapping needed on a phone). Lines, areas and
 *   volumes are drawn the same way, one point at a time.
 *
 * It talks to the panel under the page's own token URL (`__servcrafty/markers`, see routes/webui.ts), uses only GET and
 * POST (no CORS preflight from the sandboxed page) and builds the interface with `textContent`, never `innerHTML` with
 * data. The source below must not contain backticks or `${` (it lives in a template literal) nor `</script`.
 */
const SOURCE = String.raw`
(function () {
  var CAN_EDIT = __CAN_EDIT__;
  var ES = /^es/i.test(navigator.language || '');
  function tr(en, es) { return ES ? es : en; }
  var T = {
    markers: tr('Markers', 'Marcadores'),
    add: tr('Add marker', 'Añadir marcador'),
    none: tr('No markers on this map yet.', 'Todavía no hay marcadores en este mapa.'),
    place: tr('Place here', 'Colocar aquí'),
    cancel: tr('Cancel', 'Cancelar'),
    panHint: tr('Move the map to the spot, then tap Place', 'Mueve el mapa hasta el lugar y pulsa Colocar'),
    ptHint: tr('Move the map, then add a point', 'Mueve el mapa y añade un punto'),
    points: tr('Points', 'Puntos'),
    addPoint: tr('Add point', 'Añadir punto'),
    undo: tr('Undo', 'Deshacer'),
    done: tr('Done', 'Listo'),
    name: tr('Name', 'Nombre'),
    note: tr('Note (shown when clicked)', 'Nota (se muestra al pulsar)'),
    kind: tr('Type', 'Tipo'),
    pin: tr('Pin', 'Pin'), text: tr('Text', 'Texto'), line: tr('Line', 'Línea'), area: tr('Area', 'Área'), volume: tr('Volume', 'Volumen'),
    set: tr('Group', 'Grupo'),
    pos: tr('Position (X, Y, Z)', 'Posición (X, Y, Z)'),
    center: tr('Use screen center', 'Usar el centro de la pantalla'),
    pick: tr('Pick on the map', 'Elegir en el mapa'),
    save: tr('Save', 'Guardar'),
    del: tr('Delete', 'Eliminar'),
    delAsk: tr('Tap again to delete', 'Pulsa otra vez para eliminar'),
    edit: tr('Edit', 'Editar'),
    go: tr('Go', 'Ir'),
    close: tr('Close', 'Cerrar'),
    back: tr('Back', 'Volver'),
    newMarker: tr('New marker', 'Nuevo marcador'),
    editMarker: tr('Edit marker', 'Editar marcador'),
    nameReq: tr('Enter a name.', 'Escribe un nombre.'),
    badPos: tr('The position is not valid.', 'La posición no es válida.'),
    badNum: tr('A number is not valid: ', 'Un número no es válido: '),
    needPts: tr('Not enough points: ', 'Faltan puntos: '),
    failed: tr('Request failed', 'No se pudo completar'),
    outline: tr('Outline', 'Contorno'),
    line_: tr('Line', 'Línea'),
    hole: tr('Hole', 'Hueco'),
    addHole: tr('Add a hole', 'Añadir un hueco'),
    remove: tr('Remove', 'Quitar'),
    style: tr('Style', 'Estilo'),
    lineColor: tr('Line color', 'Color de la línea'),
    lineOpacity: tr('Line opacity (0-1)', 'Opacidad de la línea (0-1)'),
    fillColor: tr('Fill color', 'Color del relleno'),
    fillOpacity: tr('Fill opacity (0-1)', 'Opacidad del relleno (0-1)'),
    lineWidth: tr('Line width', 'Grosor de la línea'),
    depthTest: tr('Hidden behind terrain', 'Oculto tras el terreno'),
    height: tr('Height (Y)', 'Altura (Y)'),
    minY: tr('Bottom (Y)', 'Base (Y)'),
    maxY: tr('Top (Y)', 'Techo (Y)'),
    textShown: tr('Text on the map (default: the name)', 'Texto en el mapa (por defecto: el nombre)'),
    textColor: tr('Text color', 'Color del texto'),
    advanced: tr('More options', 'Más opciones'),
    icon: tr('Icon address (http, or assets/...)', 'Dirección del icono (http, o assets/...)'),
    anchor: tr('Icon anchor X, Y (pixel on the icon placed at the spot)', 'Ancla del icono X, Y (píxel del icono que va en el punto)'),
    classes: tr('CSS classes (comma separated)', 'Clases CSS (separadas por comas)'),
    link: tr('Link opened on click (http)', 'Enlace al pulsar (http)'),
    newTab: tr('Open the link in a new tab', 'Abrir el enlace en otra pestaña'),
    minD: tr('Visible from distance', 'Visible desde la distancia'),
    maxD: tr('Visible up to distance', 'Visible hasta la distancia'),
    sorting: tr('Sort order', 'Orden'),
    listed: tr('Show in the markers list', 'Mostrar en la lista de marcadores'),
    html: tr('Raw HTML (replaces the text)', 'HTML (reemplaza el texto)'),
    detailHtml: tr('The note is HTML', 'La nota es HTML'),
    mine: tr('Only for panel users', 'Solo para usuarios del panel')
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
  var S = { open: false, view: 'list', placing: null, data: null, editing: null, draft: null, busy: false, error: '', confirmDel: false };

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
    '@media (orientation:portrait){.scx-panel{left:0;right:0;bottom:0;max-height:64vh;max-height:64dvh;border-radius:16px 16px 0 0;padding-bottom:env(safe-area-inset-bottom,0px)}}',
    '@media (orientation:landscape){.scx-panel{top:0;right:0;bottom:0;width:min(360px,46vw)}}',
    '.scx-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2a3140;flex:none}',
    '.scx-head h2{margin:0;padding:0;border:0;font-size:16px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
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
    'input[type=color].scx-in{padding:3px;min-width:56px}',
    'textarea.scx-in{min-height:76px;resize:vertical}',
    '.scx-row{display:flex;gap:8px}.scx-row>*{flex:1;min-width:0}',
    '.scx-chips{display:flex;gap:6px;flex-wrap:wrap}.scx-chips .scx-btn{flex:1;min-width:64px;padding:0 8px}.scx-chips .on{background:#2563eb;border-color:#2563eb;color:#fff}',
    '.scx-err{color:#ff9d9d;margin:0 0 10px}.scx-muted{color:#9aa6bd;margin:0}',
    '.scx-check{display:flex;align-items:center;gap:10px;margin:0 0 12px;min-height:32px}.scx-check input{width:20px;height:20px}',
    '.scx-sec{margin:16px 0 8px;font-weight:600;color:#cfd6e4}',
    '.scx-more{margin:4px 0 12px;border:1px solid #2a3140;border-radius:10px;padding:0 10px}.scx-more>summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:#cfd6e4;font-weight:500}',
    '.scx-more[open]>summary{margin-bottom:8px}',
    '.scx-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.scx-actions .scx-pri{flex:1}',
    '.scx-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:2147483001;display:flex;align-items:center;gap:8px;background:#161a22;color:#e8ecf3;font:14px/1.3 system-ui,sans-serif;padding:8px 10px;border-radius:16px;box-shadow:0 2px 14px rgba(0,0,0,.55);max-width:calc(100vw - 20px);flex-wrap:wrap;justify-content:center}',
    '.scx-bar .c{min-width:0;display:flex;flex-direction:column}.scx-bar .c small{color:#9aa6bd}.scx-bar .c b{font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.scx-cross{position:fixed;left:50%;top:50%;width:40px;height:40px;margin:-20px 0 0 -20px;z-index:2147483000;pointer-events:none}'
  ].join('\n') });

  var root = el('div', 'scx');
  var fab, panel, bar, cross, timer = null;

  var PIN = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10z"/><path d="M12 8v6M9 11h6"/></svg>';
  var CROSS = '<svg viewBox="0 0 40 40" width="40" height="40" fill="none"><g stroke="#000" stroke-width="4" stroke-linecap="round" opacity=".6"><path d="M20 4v10M20 26v10M4 20h10M26 20h10"/></g><g stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M20 4v10M20 26v10M4 20h10M26 20h10"/></g><circle cx="20" cy="20" r="2.5" fill="#fff" stroke="#000" stroke-width="1"/></svg>';

  var TYPES = [['poi', T.pin], ['html', T.text], ['line', T.line], ['shape', T.area], ['extrude', T.volume]];
  function typeName(t) { for (var i = 0; i < TYPES.length; i++) if (TYPES[i][0] === t) return TYPES[i][1]; return t; }
  function fmt(p) { return Math.round(p.x) + ', ' + Math.round(p.y) + ', ' + Math.round(p.z); }
  function r1(n) { return Math.round(n * 10) / 10; }
  function mine(m) { return !!S.data && (S.data.all || m.createdBy === S.data.actor); }
  function setName(id) { var s = ((S.data && S.data.sets) || []).filter(function (x) { return x.id === id; })[0]; return s ? s.label : ''; }
  function isPoint(t) { return t === 'poi' || t === 'html'; }
  function isArea(t) { return t === 'shape' || t === 'extrude'; }
  function trusted() { return !!(S.data && S.data.all); }
  function spot(m) {
    if (m.position) return m.position;
    var pts = m.points || [];
    if (!pts.length) return null;
    var sx = 0, sz = 0, sy = 0;
    pts.forEach(function (p) { sx += p.x; sz += p.z; sy += (p.y === undefined ? (m.y === undefined ? (m.minY || 64) : m.y) : p.y); });
    return { x: sx / pts.length, y: sy / pts.length, z: sz / pts.length };
  }

  function newDraft(type, c) {
    c = c || center() || { x: 0, y: 64, z: 0 };
    return {
      type: type || 'poi', label: '', detail: '', setId: '', x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z),
      rings: [[]], pts: [], yy: Math.round(c.y), minY: Math.round(c.y), maxY: Math.round(c.y) + 10,
      lineColor: '#ff5555', lineOpacity: '1', fillColor: '#ff5555', fillOpacity: '0.25', lineWidth: type === 'line' ? '3' : '2', depthTest: false,
      icon: '', ax: '', ay: '', classes: '', link: '', newTab: true, minD: '', maxD: '', sorting: '', listed: true,
      text: '', color: '#ffffff', html: '', detailHtml: false
    };
  }
  function draftOf(m) {
    var d = newDraft(m.type, spot(m));
    d.label = m.label; d.detail = m.detail || ''; d.setId = m.setId;
    if (m.position) { d.x = m.position.x; d.y = m.position.y; d.z = m.position.z; }
    if (m.type === 'line') d.pts = (m.points || []).map(function (p) { return { x: p.x, y: p.y, z: p.z }; });
    if (isArea(m.type)) d.rings = [(m.points || []).map(function (p) { return { x: p.x, z: p.z }; })].concat((m.holes || []).map(function (h) { return h.map(function (p) { return { x: p.x, z: p.z }; }); }));
    if (m.y !== undefined) d.yy = m.y;
    if (m.minY !== undefined) d.minY = m.minY;
    if (m.maxY !== undefined) d.maxY = m.maxY;
    d.lineColor = m.lineColor || m.color || d.lineColor; d.fillColor = m.fillColor || m.color || d.fillColor;
    if (m.lineOpacity !== undefined) d.lineOpacity = String(m.lineOpacity);
    if (m.fillOpacity !== undefined) d.fillOpacity = String(m.fillOpacity);
    if (m.lineWidth !== undefined) d.lineWidth = String(m.lineWidth);
    d.depthTest = !!m.depthTest;
    d.icon = m.icon || ''; d.ax = m.anchor ? m.anchor.x : ''; d.ay = m.anchor ? m.anchor.y : '';
    d.classes = (m.classes || []).join(', '); d.link = m.link || ''; d.newTab = m.newTab !== false;
    d.minD = m.minDistance === undefined ? '' : m.minDistance; d.maxD = m.maxDistance === undefined ? '' : m.maxDistance;
    d.sorting = m.sorting === undefined ? '' : m.sorting; d.listed = m.listed !== false;
    d.text = m.text || ''; d.color = m.color || '#ffffff'; d.html = m.html || ''; d.detailHtml = !!m.detailHtml;
    return d;
  }

  function close() { S.open = false; S.placing = null; S.view = 'list'; S.editing = null; S.error = ''; overlayOpen = false; stopTimer(); render(); }
  function startTimer() { stopTimer(); timer = setInterval(updateBar, 400); }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function updateBar() { var c = center(); var n = bar && bar.querySelector('b'); if (c && n) n.textContent = fmt(c); }
  function backToForm() { S.placing = null; S.view = 'form'; S.open = true; overlayOpen = true; stopTimer(); render(); }
  function openForm(marker, draft) {
    S.editing = marker || null; S.error = ''; S.confirmDel = false;
    S.draft = marker ? draftOf(marker) : draft;
    S.view = 'form'; S.open = true; S.placing = null; overlayOpen = true; stopTimer(); render();
  }

  // ---- build the request from the form
  function nn(v) { if (v === '' || v === null || v === undefined) return null; var n = parseFloat(v); return isFinite(n) ? n : NaN; }

  function buildBody() {
    var d = S.draft, ed = S.editing, create = !ed, t = ed ? ed.type : d.type;
    var b = {}, bad = null;
    var label = (d.label || '').trim();
    if (!label) return { error: T.nameReq };
    b.label = label;
    function opt(k, v) { if (v === '' || v === null || v === undefined) { if (!create) b[k] = null; } else b[k] = v; }
    function numOpt(k, v, name) { var n = nn(v); if (n !== null && isNaN(n)) { bad = bad || name; return; } opt(k, n); }
    b.detail = d.detail || '';
    if (trusted()) b.detailHtml = !!d.detailHtml;
    numOpt('minDistance', d.minD, T.minD); numOpt('maxDistance', d.maxD, T.maxD); numOpt('sorting', d.sorting, T.sorting);
    b.listed = !!d.listed;
    if (isPoint(t)) {
      var x = nn(d.x), y = nn(d.y), z = nn(d.z);
      if (x === null || y === null || z === null || isNaN(x) || isNaN(y) || isNaN(z)) return { error: T.badPos };
      b.position = { x: x, y: y, z: z };
      var ax = nn(d.ax), ay = nn(d.ay);
      if (ax === null && ay === null) { if (!create) b.anchor = null; }
      else if (ax === null || ay === null || isNaN(ax) || isNaN(ay)) bad = bad || T.anchor;
      else b.anchor = { x: Math.round(ax), y: Math.round(ay) };
      var cls = (d.classes || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (cls.length) b.classes = cls; else if (!create) b.classes = null;
      if (t === 'poi' && trusted()) opt('icon', (d.icon || '').trim());
      if (t === 'html') {
        opt('text', (d.text || '').trim()); b.color = d.color;
        if (trusted()) opt('html', d.html);
      }
    } else {
      if (t === 'line') {
        if (d.pts.length < 2) return { error: T.needPts + T.line_ + ' (2)' };
        b.points = d.pts.map(function (p) { return { x: p.x, y: p.y, z: p.z }; });
      } else {
        if (d.rings[0].length < 3) return { error: T.needPts + T.outline + ' (3)' };
        b.points = d.rings[0].map(function (p) { return { x: p.x, z: p.z }; });
        var holes = d.rings.slice(1).filter(function (r) { return r.length; });
        for (var i = 0; i < holes.length; i++) if (holes[i].length < 3) return { error: T.needPts + T.hole + ' ' + (i + 1) + ' (3)' };
        b.holes = holes.map(function (r) { return r.map(function (p) { return { x: p.x, z: p.z }; }); });
        if (t === 'shape') { var yy = nn(d.yy); if (yy === null || isNaN(yy)) bad = bad || T.height; else b.y = yy; }
        else {
          var lo = nn(d.minY), hi = nn(d.maxY);
          if (lo === null || hi === null || isNaN(lo) || isNaN(hi)) bad = bad || T.minY; else { b.minY = lo; b.maxY = hi; }
        }
        b.fillColor = d.fillColor; numOpt('fillOpacity', d.fillOpacity, T.fillOpacity);
      }
      b.lineColor = d.lineColor; numOpt('lineOpacity', d.lineOpacity, T.lineOpacity); numOpt('lineWidth', d.lineWidth, T.lineWidth);
      b.depthTest = !!d.depthTest;
      if (trusted()) { opt('link', (d.link || '').trim()); b.newTab = !!d.newTab; }
    }
    if (bad) return { error: T.badNum + bad };
    return { body: b, type: t };
  }

  function submit() {
    var r = buildBody();
    if (r.error) { S.error = r.error; return render(); }
    var d = S.draft, ed = S.editing, body = r.body, req;
    if (ed) {
      if (d.setId && d.setId !== ed.setId) body.setId = d.setId;
      req = api('/' + encodeURIComponent(ed.id), 'POST', body);
    } else {
      body.type = r.type; body.mapId = mapId();
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

  // ---- form widgets
  function field(label, input) { return el('label', 'scx-field', [el('span', null, null, { text: label }), input]); }
  function input(key, type, extra) {
    var a = { type: type || 'text', oninput: function (e) { S.draft[key] = e.target.value; } };
    if (extra) for (var k in extra) a[k] = extra[k];
    var n = el('input', 'scx-in', null, a);
    n.value = S.draft[key] === undefined || S.draft[key] === null ? '' : String(S.draft[key]);
    return n;
  }
  function colorIn(key) { var n = el('input', 'scx-in', null, { type: 'color', oninput: function (e) { S.draft[key] = e.target.value; } }); n.value = S.draft[key]; return n; }
  function check(key, label) {
    var n = el('input', null, null, { type: 'checkbox', onchange: function (e) { S.draft[key] = e.target.checked; } });
    n.checked = !!S.draft[key];
    return el('label', 'scx-check', [n, el('span', null, null, { text: label })]);
  }
  var NUM = { inputmode: 'decimal', step: 'any' };

  function ringRow(title, list, onAdd, onUndo, onRemove) {
    var acts = [btn(T.addPoint, 'scx-sm', onAdd), btn(T.undo, 'scx-sm', onUndo, list.length ? null : { disabled: 'disabled' })];
    if (onRemove) acts.push(btn(T.remove, 'scx-sm scx-dng', onRemove));
    return el('div', 'scx-item', [el('div', 't', [el('b', null, null, { text: title }), el('small', null, null, { text: T.points + ': ' + list.length })])].concat(acts));
  }
  function startRing(kind, index) {
    S.placing = { kind: kind, ring: index }; S.open = false; overlayOpen = true; startTimer(); render();
  }
  function addPointFromCenter() {
    var c = center(); if (!c) return;
    var p = S.placing, d = S.draft;
    if (p.kind === 'line') d.pts.push({ x: r1(c.x), y: r1(c.y), z: r1(c.z) });
    else d.rings[p.ring].push({ x: r1(c.x), z: r1(c.z) });
    render();
  }
  function undoPoint() {
    var p = S.placing, d = S.draft;
    if (p.kind === 'line') d.pts.pop(); else d.rings[p.ring].pop();
    render();
  }
  function placingCount() {
    var p = S.placing, d = S.draft;
    return p.kind === 'line' ? d.pts.length : (d.rings[p.ring] || []).length;
  }

  function formView() {
    var d = S.draft, ed = S.editing, t = ed ? ed.type : d.type, kids = [];
    if (S.error) kids.push(el('p', 'scx-err', null, { text: S.error, role: 'alert' }));
    if (!ed) {
      var chips = el('div', 'scx-chips');
      TYPES.forEach(function (k) { chips.appendChild(btn(k[1], d.type === k[0] ? 'on' : '', function () { d.type = k[0]; if (k[0] === 'line' && d.lineWidth === '2') d.lineWidth = '3'; render(); })); });
      kids.push(field(T.kind, chips));
    }
    kids.push(field(T.name, input('label', 'text', { maxlength: '80', autocomplete: 'off' })));
    var ta = el('textarea', 'scx-in', null, { maxlength: '2000', oninput: function (e) { d.detail = e.target.value; } });
    ta.value = d.detail || '';
    kids.push(field(T.note, ta));
    var sets = (S.data && S.data.sets) || [];
    if (sets.length > 1) {
      var sel = el('select', 'scx-in', sets.map(function (s) { return el('option', null, null, { value: s.id, text: s.label }); }), { onchange: function (e) { d.setId = e.target.value; } });
      sel.value = d.setId || sets[0].id;
      if (!d.setId) d.setId = sets[0].id;
      kids.push(field(T.set, sel));
    }
    if (isPoint(t)) {
      kids.push(field(T.pos, el('div', 'scx-row', [input('x', 'number', NUM), input('y', 'number', NUM), input('z', 'number', NUM)])));
      kids.push(el('div', 'scx-actions', [
        btn(T.pick, 'scx-sm', function () { S.placing = { kind: 'point' }; S.open = false; overlayOpen = true; startTimer(); render(); }),
        btn(T.center, 'scx-sm', function () { var c = center(); if (c) { d.x = Math.round(c.x); d.y = Math.round(c.y); d.z = Math.round(c.z); render(); } })
      ]));
      if (t === 'html') {
        kids.push(field(T.textShown, input('text', 'text', { maxlength: '120' })));
        kids.push(field(T.textColor, colorIn('color')));
      }
    } else {
      kids.push(el('div', 'scx-sec', null, { text: T.points }));
      var list = el('div', 'scx-list', null, { style: 'margin-top:0' });
      if (t === 'line') list.appendChild(ringRow(T.line_, d.pts, function () { startRing('line', 0); }, function () { d.pts.pop(); render(); }));
      else {
        list.appendChild(ringRow(T.outline, d.rings[0], function () { startRing('ring', 0); }, function () { d.rings[0].pop(); render(); }));
        d.rings.slice(1).forEach(function (r, i) {
          list.appendChild(ringRow(T.hole + ' ' + (i + 1), r, function () { startRing('ring', i + 1); }, function () { r.pop(); render(); }, function () { d.rings.splice(i + 1, 1); render(); }));
        });
        list.appendChild(btn(T.addHole, 'scx-sm', function () { d.rings.push([]); startRing('ring', d.rings.length - 1); }));
      }
      kids.push(list);
      if (t === 'shape') kids.push(field(T.height, input('yy', 'number', NUM)));
      if (t === 'extrude') kids.push(field(T.minY + ' / ' + T.maxY, el('div', 'scx-row', [input('minY', 'number', NUM), input('maxY', 'number', NUM)])));
      kids.push(el('div', 'scx-sec', null, { text: T.style }));
      kids.push(el('div', 'scx-row', [field(T.lineColor, colorIn('lineColor')), field(T.lineWidth, input('lineWidth', 'number', { min: '1', max: '30', step: '1', inputmode: 'numeric' }))]));
      kids.push(field(T.lineOpacity, input('lineOpacity', 'number', { min: '0', max: '1', step: '0.05', inputmode: 'decimal' })));
      if (t !== 'line') {
        kids.push(field(T.fillColor, colorIn('fillColor')));
        kids.push(field(T.fillOpacity, input('fillOpacity', 'number', { min: '0', max: '1', step: '0.05', inputmode: 'decimal' })));
      }
      kids.push(check('depthTest', T.depthTest));
    }
    // every other option BlueMap has
    var more = el('details', 'scx-more', [el('summary', null, null, { text: T.advanced })]);
    if (isPoint(t)) {
      if (t === 'poi' && trusted()) more.appendChild(field(T.icon, input('icon', 'text', { maxlength: '500', placeholder: 'assets/poi.svg' })));
      more.appendChild(field(T.anchor, el('div', 'scx-row', [input('ax', 'number', { inputmode: 'numeric', step: '1', placeholder: t === 'poi' ? '25' : '0' }), input('ay', 'number', { inputmode: 'numeric', step: '1', placeholder: t === 'poi' ? '45' : '0' })])));
      more.appendChild(field(T.classes, input('classes', 'text', { maxlength: '400' })));
      if (t === 'html' && trusted()) { var ht = el('textarea', 'scx-in', null, { maxlength: '4000', oninput: function (e) { d.html = e.target.value; } }); ht.value = d.html || ''; more.appendChild(field(T.html, ht)); }
    } else if (trusted()) {
      more.appendChild(field(T.link, input('link', 'text', { maxlength: '500', placeholder: 'https://' })));
      more.appendChild(check('newTab', T.newTab));
    }
    more.appendChild(el('div', 'scx-row', [field(T.minD, input('minD', 'number', NUM)), field(T.maxD, input('maxD', 'number', NUM))]));
    more.appendChild(field(T.sorting, input('sorting', 'number', { inputmode: 'numeric', step: '1' })));
    more.appendChild(check('listed', T.listed));
    if (trusted()) more.appendChild(check('detailHtml', T.detailHtml));
    kids.push(more);
    var acts = el('div', 'scx-actions', [
      btn(T.save, 'scx-pri', submit, S.busy ? { disabled: 'disabled' } : null),
      btn(T.cancel, '', function () { S.view = 'list'; S.editing = null; S.error = ''; render(); })
    ]);
    if (ed) acts.appendChild(btn(S.confirmDel ? T.delAsk : T.del, 'scx-dng', remove, S.busy ? { disabled: 'disabled' } : null));
    kids.push(acts);
    return kids;
  }

  function listView() {
    var markers = (S.data && S.data.markers) || [];
    var kids = [btn(T.add, 'scx-pri', function () { S.draft = newDraft('poi'); S.editing = null; S.placing = { kind: 'point', fresh: true }; S.open = false; overlayOpen = true; startTimer(); render(); }, { style: 'width:100%' })];
    if (!markers.length) kids.push(el('p', 'scx-muted', null, { text: T.none, style: 'margin-top:12px' }));
    var ul = el('ul', 'scx-list');
    markers.forEach(function (m) {
      var at = spot(m);
      var sub = [typeName(m.type), setName(m.setId), at ? fmt(at) : ''].filter(Boolean).join(' · ');
      var actions = [];
      if (at) actions.push(btn(T.go, 'scx-sm', function () { gotoPos(at); }));
      if (mine(m)) actions.push(btn(T.edit, 'scx-sm', function () { openForm(m); }));
      ul.appendChild(el('li', 'scx-item', [el('div', 't', [el('b', null, null, { text: m.label }), el('small', null, null, { text: sub })])].concat(actions)));
    });
    kids.push(ul);
    return kids;
  }

  function renderBar() {
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    var p = S.placing;
    if (!p) return;
    var c = el('div', 'c', [el('small', null, null, { text: p.kind === 'point' ? T.panHint : T.ptHint + ' (' + T.points + ': ' + placingCount() + ')' }), el('b', null, null, { text: '' })]);
    bar.appendChild(c);
    if (p.kind === 'point') {
      bar.appendChild(btn(T.cancel, 'scx-sm', function () { if (p.fresh) { S.placing = null; overlayOpen = false; stopTimer(); render(); } else backToForm(); }));
      bar.appendChild(btn(T.place, 'scx-pri scx-sm', function () {
        var ctr = center() || { x: 0, y: 64, z: 0 };
        if (p.fresh) { openForm(null, Object.assign(S.draft, { x: Math.round(ctr.x), y: Math.round(ctr.y), z: Math.round(ctr.z) })); }
        else { S.draft.x = Math.round(ctr.x); S.draft.y = Math.round(ctr.y); S.draft.z = Math.round(ctr.z); backToForm(); }
      }));
    } else {
      bar.appendChild(btn(T.undo, 'scx-sm', undoPoint));
      bar.appendChild(btn(T.addPoint, 'scx-pri scx-sm', addPointFromCenter));
      bar.appendChild(btn(T.done, 'scx-sm', backToForm));
    }
    updateBar();
  }

  function render() {
    if (!fab) return;
    fab.style.display = S.open || S.placing ? 'none' : 'flex';
    cross.style.display = S.placing ? 'block' : 'none';
    bar.style.display = S.placing ? 'flex' : 'none';
    panel.style.display = S.open ? 'flex' : 'none';
    if (S.placing) renderBar();
    if (!S.open) return;
    var keep = panel.querySelector('.scx-body'), top = keep ? keep.scrollTop : 0, wasOpen = !!panel.querySelector('details[open]');
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
    var det = body.querySelector('details'); if (det && wasOpen) det.open = true;
    body.scrollTop = top;
  }

  function build() {
    fab = btn('', 'scx-fab', function () { S.open = true; S.view = 'list'; S.error = ''; overlayOpen = true; render(); load(); }, { 'aria-label': T.markers, title: T.markers });
    fab.className = 'scx-fab';
    fab.innerHTML = PIN;
    panel = el('div', 'scx-panel', null, { role: 'dialog', 'aria-label': T.markers });
    cross = el('div', 'scx-cross'); cross.innerHTML = CROSS;
    bar = el('div', 'scx-bar');
    [css, fab, panel, cross, bar].forEach(function (n) { root.appendChild(n); });
    document.body.appendChild(root);
    render();
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (S.placing) { e.stopPropagation(); if (S.placing.kind === 'point' && S.placing.fresh) { S.placing = null; overlayOpen = false; stopTimer(); render(); } else backToForm(); return; }
      if (S.open) { e.stopPropagation(); if (S.view === 'form') { S.view = 'list'; S.editing = null; S.error = ''; render(); } else close(); }
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
