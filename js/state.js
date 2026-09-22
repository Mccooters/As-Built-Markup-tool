/* ============ state.js — central app state, events, undo/redo ============ */
'use strict';

const State = (() => {

  const listeners = {};
  const on = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
  const emit = (ev, data) => { (listeners[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(`listener for "${ev}"`, e); } }); };

  const S = {
    // document
    pdf: null,               // PDFDocumentProxy
    pdfBytes: null,          // Uint8Array (kept for export/save)
    fileName: '',
    fingerprint: '',
    pageCount: 0,
    page: 1,
    zoom: 1,
    pageW: 0, pageH: 0,      // current page size in page units (PDF points)

    // data
    markups: [],
    countGroups: [],         // {id, name, shape, color}
    pageScales: {},          // pageNum -> { ftPerUnit }
    defaultScale: null,      // { ftPerUnit } applied when page has none
    images: {},              // imgId -> data URL (downscaled site photos)

    // ui
    tool: 'select',
    selection: new Set(),    // markup ids
    unlockedZones: new Set(),// zones temporarily allowed to move/resize (never saved)
    activeSymbol: null,      // symbol id or stamp id (prefixed st-)
    symbolRotation: 0,
    activeCountGroup: null,  // group id
    unitFormat: localStorage.getItem('abmt:units') || 'm',
    author: localStorage.getItem('abmt:author') || 'Field',
    exportPrefs: null,       // schedule-export selections + note (persisted with the project)

    // work-day tracking (daily reports)
    workDay: new Date().toISOString().slice(0, 10),   // active day, YYYY-MM-DD
    dayMode: false,          // true = gray out earlier days, hide future days
    jobRef: '',              // AroFlo task / job reference for reports
    aroSite: null,           // remembered stock context {holder, project} for this drawing
    project: null,           // project details {name, site, client, contractor, contact, phone} — saved with the drawing
    activeFitting: 'e90',    // armed press-fitting id

    idCounter: 1,
    dirty: false,
  };

  /* ---- defaults for new markups (editable from the properties panel) ---- */
  S.defaults = {
    color: '#e02020',
    lineWidth: 2.5,
    opacity: 1,
    fill: 'none',
    fillOpacity: 0.2,
    fontSize: 12,
    lineStyle: 'solid',       // solid | dash | dot
    arcSize: 14,              // cloud scallop size
    symbolSize: 26,
    symbolLabel: true,
    pipeSize: '25mm',
    material: 'Press Stainless',
    system: 'Main Header',
    pipeWidthMode: 'scale',   // 'scale' = line width is the true OD at sheet scale
    pipeWidthScale: 1,        // visibility multiplier on the true-scale width (proportions kept)
    orthoPipe: false,         // false = route at any angle; Shift snaps to 45°. true inverts.
    colorBySize: true,
    penSize: '50mm',          // penetration core/hole diameter
    penType: 'Wall',          // Wall | Floor | Roof | Ceiling
    penFire: false,           // fire-rated assembly → firestop required
    photoWidth: 220,          // default placed photo width, page units
    showLabel: true,
    highlightColor: '#ffe419',
    highlightWidth: 14,
  };

  /* ================= undo / redo ================= */
  const undoStack = [], redoStack = [];
  const MAX_UNDO = 100;

  const snapshot = () => JSON.stringify({
    markups: S.markups, countGroups: S.countGroups,
    pageScales: S.pageScales, defaultScale: S.defaultScale, idCounter: S.idCounter,
  });

  function restore(json) {
    const d = JSON.parse(json);
    S.markups = d.markups; S.countGroups = d.countGroups;
    S.pageScales = d.pageScales; S.defaultScale = d.defaultScale; S.idCounter = d.idCounter;
    // prune selection of vanished markups
    const ids = new Set(S.markups.map(m => m.id));
    for (const id of [...S.selection]) if (!ids.has(id)) S.selection.delete(id);
    emit('markups'); emit('selection'); emit('scale'); emit('history');
    touch();
  }

  /** Record state before a mutation. Call once per user-level action. */
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    emit('history');
  }

  const canUndo = () => undoStack.length > 0;
  const canRedo = () => redoStack.length > 0;

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
  }

  function clearHistory() { undoStack.length = 0; redoStack.length = 0; emit('history'); }

  /* ================= mutations ================= */

  let saveTimer = null;
  function touch() {
    S.dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => emit('autosave'), 800);
  }

  const newId = () => 'm' + (S.idCounter++);

  function addMarkup(m, opts = {}) {
    if (!opts.noUndo) pushUndo();
    m.id = m.id || newId();
    m.author = m.author || S.author;
    m.date = m.date || new Date().toISOString();
    m.day = m.day || S.workDay;
    S.markups.push(m);
    emit('markups', { changed: [m.id] });
    touch();
    return m;
  }

  function updateMarkups(ids, patch, opts = {}) {
    if (!opts.noUndo) pushUndo();
    const set = new Set(ids);
    for (const m of S.markups) {
      if (set.has(m.id)) Object.assign(m, typeof patch === 'function' ? patch(m) : patch);
    }
    emit('markups', { changed: [...set] });
    touch();
  }

  function deleteMarkups(ids) {
    if (!ids.length) return;
    pushUndo();
    const set = new Set(ids);
    S.markups = S.markups.filter(m => !set.has(m.id));
    for (const id of set) S.selection.delete(id);
    emit('markups'); emit('selection');
    touch();
  }

  const getMarkup = id => S.markups.find(m => m.id === id) || null;
  const pageMarkups = page => S.markups.filter(m => m.page === page);

  /* ---- selection ---- */
  function select(ids, additive = false) {
    if (!additive) S.selection.clear();
    for (const id of ids) {
      if (additive && S.selection.has(id)) S.selection.delete(id);
      else S.selection.add(id);
    }
    // an unlocked zone locks itself again the moment it leaves the selection
    for (const id of [...S.unlockedZones]) if (!S.selection.has(id)) S.unlockedZones.delete(id);
    emit('selection');
  }
  const clearSelection = () => {
    if (S.selection.size || S.unlockedZones.size) {
      S.selection.clear();
      S.unlockedZones.clear();
      emit('selection');
    }
  };

  /** Zones are position-locked by default — a stray drag must never move one. */
  const zoneLocked = m => !!(m && m.type === 'zone' && !S.unlockedZones.has(m.id));
  const selectedMarkups = () => S.markups.filter(m => S.selection.has(m.id));

  /* ---- work day ---- */
  function setWorkDay(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return;
    S.workDay = day;
    emit('day');
    touch();
  }
  function setDayMode(on) {
    S.dayMode = !!on;
    emit('day');
    touch();
  }
  /** How a markup renders relative to the active day: 'normal' | 'gray' | 'hidden'. */
  function dayStateOf(m, dayMode, day) {
    // area zones are structural, not a day's work — never gray or hide them
    if (m && m.type === 'zone') return 'normal';
    return dayStateOfInner(m, dayMode, day);
  }

  function dayStateOfInner(m, dayMode, day) {
    const mode = dayMode != null ? dayMode : S.dayMode;
    if (!mode) return 'normal';
    const d = m.day || (m.date || '').slice(0, 10);
    const ref = day || S.workDay;
    if (!d || d === ref) return 'normal';
    return d < ref ? 'gray' : 'hidden';
  }

  /* ---- groups: what the markups list groups by, and what is hidden on the sheet ----
   * Type groups (Measurements, Pipe runs, …) with the drawing's area zones as
   * sub-groups. Hidden / collapsed groups are a view aid kept per device and
   * per drawing (localStorage) — never in the project data, so hiding one
   * section's measurements on an iPad neither blanks them for the rest of the
   * crew nor drops them from exports. */

  const CATEGORY = {
    mlength: 'measure', mpoly: 'measure', marea: 'measure', pipe: 'pipe', fitting: 'fitting',
    symbol: 'equip', stamp: 'equip', count: 'count', penet: 'penet', text: 'note', callout: 'note',
    photo: 'photo', zone: 'zone',
  };
  const CATEGORY_ORDER = ['measure', 'pipe', 'fitting', 'equip', 'count', 'penet', 'note', 'markup', 'photo', 'zone'];
  const CATEGORY_NAME = {
    measure: 'Measurements', pipe: 'Pipe runs', fitting: 'Press fittings', equip: 'Symbols & equipment',
    count: 'Counts', penet: 'Penetrations', note: 'Text & callouts', markup: 'Markups', photo: 'Photos', zone: 'Area zones',
  };
  const categoryOf = m => CATEGORY[m.type] || 'markup';

  /** The area zone a markup sits in: the smallest zone on its page whose box
   *  holds the markup's centre. A zone counts as sitting in itself, so hiding
   *  or grouping "everything in the Compressor room" takes the box along. */
  function zoneOf(m) {
    if (!m) return null;
    if (m.type === 'zone') return m;
    const b = Geo.markupBounds(m);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let best = null, bestA = Infinity;
    for (const z of S.markups) {
      if (z.type !== 'zone' || z.page !== m.page) continue;
      if (cx < z.x || cy < z.y || cx > z.x + z.w || cy > z.y + z.h) continue;
      const a = z.w * z.h;
      if (a < bestA) { best = z; bestA = a; }
    }
    return best;
  }
  const zoneName = z => (z.label || z.subject || 'Area zone') + ((z.jobs || []).length ? ' · #' + z.jobs.join(' #') : '');

  /** Every group key a markup belongs to: its type group, its zone, and the type-within-zone. */
  function groupKeysOf(m) {
    const c = categoryOf(m), z = zoneOf(m);
    const zk = 'zone:' + (z ? z.id : 'none');
    return ['type:' + c, zk, 'type:' + c + '|' + zk];
  }

  let viewFp = null;
  const view = { hidden: new Set(), collapsed: new Set() };
  function ensureView() {
    if (viewFp === S.fingerprint) return view;
    viewFp = S.fingerprint;
    view.hidden = new Set(); view.collapsed = new Set();
    try {
      const v = JSON.parse(localStorage.getItem('abmt:view:' + S.fingerprint) || 'null');
      if (v) { for (const k of v.hidden || []) view.hidden.add(k); for (const k of v.collapsed || []) view.collapsed.add(k); }
    } catch (e) { /* fresh view */ }
    return view;
  }
  function saveView() {
    if (!S.fingerprint) return;
    try { localStorage.setItem('abmt:view:' + S.fingerprint, JSON.stringify({ hidden: [...view.hidden], collapsed: [...view.collapsed] })); } catch (e) { /* ignore */ }
  }
  const groupHidden = key => ensureView().hidden.has(key);
  const groupCollapsed = key => ensureView().collapsed.has(key);
  const anyGroupHidden = () => ensureView().hidden.size > 0;

  /** Off the sheet: a future work day, or one of its groups switched off in the list. */
  function isHidden(m) {
    if (!m) return false;
    if (dayStateOf(m) === 'hidden') return true;
    const v = ensureView();
    if (!v.hidden.size) return false;
    return groupKeysOf(m).some(k => v.hidden.has(k));
  }

  function afterViewChange() {
    // nothing hidden stays selected — its handles would float over an empty spot
    let pruned = false;
    for (const id of [...S.selection]) {
      const m = getMarkup(id);
      if (m && isHidden(m)) { S.selection.delete(id); pruned = true; }
    }
    emit('markups');            // redraw the sheet — no data change, so no autosave
    if (pruned) emit('selection');
    emit('view');
  }
  function setGroupHidden(key, hidden) {
    ensureView();
    if (hidden) view.hidden.add(key); else view.hidden.delete(key);
    saveView();
    afterViewChange();
  }
  function showAllGroups() {
    ensureView();
    if (!view.hidden.size) return;
    view.hidden.clear();
    saveView();
    afterViewChange();
  }
  function setGroupCollapsed(key, collapsed) {
    ensureView();
    if (collapsed) view.collapsed.add(key); else view.collapsed.delete(key);
    saveView();
    emit('view');
  }

  /* ---- tool ---- */
  function setTool(tool) {
    if (S.tool === tool) return;
    S.tool = tool;
    S.unlockedZones.clear();
    emit('tool');
  }

  /* ---- scale ---- */
  function scaleForPage(page) {
    return S.pageScales[page] || S.defaultScale || null;
  }
  function setScale(page, ftPerUnit, allPages, label) {
    pushUndo();
    const sc = label ? { ftPerUnit, label } : { ftPerUnit };
    if (allPages) {
      S.defaultScale = sc;
      S.pageScales = {};
    } else {
      S.pageScales[page] = sc;
    }
    emit('scale');
    emit('markups'); // labels change
    touch();
  }

  /**
   * Stroke width (page units) a pipe run renders at. In 'scale' mode (default)
   * this is the pipe's true outside diameter mapped through the sheet scale, so
   * a 2" header draws twice as wide as a 1" branch — accurate on screen and in
   * exports. Falls back to the fixed lineWidth when the page isn't calibrated
   * or the markup opts out with widthMode: 'fixed'.
   */
  function pipeDisplayWidth(m) {
    if (m.type !== 'pipe') return m.lineWidth || 2;
    const sc = scaleForPage(m.page);
    if (!sc || m.widthMode === 'fixed') return m.lineWidth || 3;
    const odIn = Symbols.pipeOdInches(m.pipeSize, m.material);
    // widthScale boosts visibility on small-scale sheets while keeping all
    // pipe sizes proportional to each other
    return Math.max((odIn / 12) / sc.ftPerUnit * (m.widthScale || 1), 0.35);
  }

  /** Length of a markup in feet (null if page not calibrated or not a length markup). */
  function lengthFt(m) {
    const sc = scaleForPage(m.page);
    if (!sc) return null;
    if (m.type === 'pipe' || m.type === 'mpoly' || m.type === 'mlength' ||
        m.type === 'polyline' || m.type === 'line' || m.type === 'arrow') {
      return Geo.polylineLength(m.pts) * sc.ftPerUnit;
    }
    return null;
  }
  /** Area of a markup in sq ft. */
  function areaFt(m) {
    const sc = scaleForPage(m.page);
    if (!sc || m.type !== 'marea') return null;
    return Geo.polygonArea(m.pts) * sc.ftPerUnit * sc.ftPerUnit;
  }

  /* ---- count groups ---- */
  function addCountGroup(name, shape, color) {
    pushUndo();
    const g = { id: 'g' + (S.idCounter++), name, shape, color };
    S.countGroups.push(g);
    S.activeCountGroup = g.id;
    emit('countGroups');
    touch();
    return g;
  }
  const countGroup = id => S.countGroups.find(g => g.id === id) || null;
  function countOfGroup(id) { return S.markups.filter(m => m.type === 'count' && m.groupId === id).length; }

  /* ---- document lifecycle ---- */
  function resetDoc() {
    S.markups = []; S.countGroups = []; S.pageScales = {}; S.defaultScale = null;
    S.images = {};
    S.aroSite = null;
    S.project = null;
    S.selection.clear(); S.unlockedZones.clear(); S.idCounter = 1; S.dirty = false;
    clearHistory();
  }

  function addImage(dataUrl) {
    const id = 'img' + (S.idCounter++);
    S.images[id] = dataUrl;
    return id;
  }

  return {
    S, on, emit,
    pushUndo, undo, redo, canUndo, canRedo, clearHistory,
    addMarkup, updateMarkups, deleteMarkups, getMarkup, pageMarkups,
    select, clearSelection, selectedMarkups, setTool, zoneLocked,
    setWorkDay, setDayMode, dayStateOf,
    categoryOf, zoneOf, zoneName, groupKeysOf, isHidden, groupHidden, groupCollapsed, anyGroupHidden,
    setGroupHidden, setGroupCollapsed, showAllGroups, CATEGORY_ORDER, CATEGORY_NAME,
    scaleForPage, setScale, lengthFt, areaFt, pipeDisplayWidth,
    addCountGroup, countGroup, countOfGroup,
    resetDoc, newId, touch, addImage,
  };
})();
