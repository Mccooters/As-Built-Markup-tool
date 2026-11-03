/* ============ tools.js — pointer state machine for drawing, selecting, editing ============ */
'use strict';

const Tools = (() => {

  const SNAP_TYPES = ['pipe', 'mpoly', 'mlength', 'line', 'polyline', 'arrow'];
  const POLY_TOOLS = { pipe: 1, polyline: 1, polygon: 1, mpoly: 1, marea: 1 };
  const DRAG_TOOLS = { line: 1, arrow: 1, mlength: 1, rect: 1, ellipse: 1, cloud: 1, pen: 1, highlight: 1, callout: 1, zone: 1 };

  const TOOL_HINTS = {
    select: 'Click to select · drag to move · Shift-click adds · drag empty space for marquee · double-click text to edit · Del deletes',
    pan: 'Drag to pan. Mouse wheel zooms.',
    pipe: 'Click points along the route — any angle · Shift snaps 45°/90° off the previous leg · arrow keys pan the view mid-run (Shift = faster) · double-click or Enter finishes · Backspace removes last point · Esc cancels',
    calibrate: 'Click two points a known distance apart — or click the Scale button in the status bar to type the sheet\'s stated ratio directly (1:100, 1/4" = 1\'-0"…).',
    mlength: 'Drag from one point to another to measure.',
    zone: 'Drag a box over an area, then link it to the AroFlo tasks for that area. Tap a zone with Select to see its jobs and materials.',
    mpoly: 'Click points along the route · double-click or Enter finishes.',
    marea: 'Click corners of the area · double-click or Enter closes the shape.',
    count: 'Click to place a count mark. Pick the count group in the panel on the right.',
    line: 'Drag to draw a line. Shift constrains to 45°.',
    arrow: 'Drag to draw — the arrow head lands where you release. Shift constrains to 45°.',
    polyline: 'Click points · double-click or Enter finishes · Esc cancels. Arrowheads and a cloud outline are in the panel on the right.',
    polygon: 'Click corners · double-click or Enter closes the shape. Fill, hatch-style cloud outline and perimeter label are in the panel on the right.',
    sequence: 'Click to drop the next numbered label (D-01, D-02…). Prefix and next number are in the panel on the right.',
    chest: 'Click to place the saved tool from your Tool Chest — pick a different one in the Symbols tab.',
    rect: 'Drag a rectangle.',
    ellipse: 'Drag an ellipse.',
    cloud: 'Drag a revision cloud.',
    pen: 'Draw freehand.',
    highlight: 'Drag to highlight.',
    text: 'Click (or drag a box) then type. Click outside or Ctrl+Enter to commit.',
    callout: 'Press at the point you want the arrow, drag to where the note box goes, release, then type.',
    symbol: 'Click to place the selected symbol · R rotates · pick a different one in the Symbols tab.',
    penet: 'Click where the pipe passes through — marks the core/sleeve with its required hole size. Set Ø size, wall/floor and fire rating in the panel; the Takeoff tab totals them into a core-drill schedule.',
    fitting: 'Tap to drop the armed press fitting at the pipe size shown in the Fittings tab — stays armed for rapid entry. Totals build the fittings schedule for the day.',
    photo: 'Pick an image, then click the drawing to pin it (drag-dropping an image file works too). Drag corners to resize · double-click to view full size.',
  };

  let creating = null;     // multi-click creation in progress
  let dragging = false;    // any active drag (suppress selection redraw churn)
  let hoverPt = null;      // last pointer position in page units
  let lastClient = null;   // last pointer position in client px (survives view pans)
  let editingTextarea = null;

  /* touch state: one finger works the tools, two fingers are a view gesture.
     pointerId → last-seen time; some engines (WebKit) occasionally drop a
     pointerup, so ghosts are pruned by staleness and cleared by native
     touchend ground truth — a leaked id would otherwise make every later
     touch look like a two-finger gesture and kill the tools. */
  const activeTouches = new Map();
  const TOUCH_STALE_MS = 3500;
  function touchCount() {
    const now = performance.now();
    for (const [id, t] of activeTouches) if (now - t > TOUCH_STALE_MS) activeTouches.delete(id);
    return activeTouches.size;
  }
  let activeDragAbort = null;  // cancels the in-flight drag without committing
  let activeDragFinish = null; // settles the in-flight drag with its last position (lost pointerup)
  let pendingTap = null;       // touch tap-in-progress for click-style tools
  let lastTap = null;          // for double-tap detection on the select tool
  let lastDownType = 'mouse';  // pointerType of the most recent pointerdown anywhere
  let tapConsumedAt = 0;       // when the pointerup path last ran a tap action
  let gestureAt = 0;           // when a second finger last landed
  let panConvertedAt = 0;      // when a touch turned into a one-finger pan
  const TAP_SLOP = 22;         // px of finger roll still counted as a tap
  const CLICK_TOOLS = { calibrate: 1, symbol: 1, count: 1, text: 1, penet: 1, photo: 1, fitting: 1, sequence: 1, chest: 1 };

  const S = () => State.S;
  const D = () => State.S.defaults;

  /* ================= helpers ================= */

  function toolCursor() {
    const o = Viewer.el.overlay;
    o.classList.remove('cur-cross', 'cur-pan', 'cur-text', 'cur-default');
    const t = S().tool;
    if (t === 'select') o.classList.add('cur-default');
    else if (t === 'pan') o.classList.add('cur-pan');
    else if (t === 'text') o.classList.add('cur-text');
    else o.classList.add('cur-cross');
  }

  /** Nearest run endpoint within 9 screen px. `skip` is a point object that must
   *  never be a snap target — the vertex being dragged, or a slow drag would
   *  keep snapping it back onto its own last position. */
  function snapPoint(p, skip) {
    const thr = 9 / S().zoom;
    let best = null, bd = thr;
    for (const m of State.pageMarkups(S().page)) {
      if (!m.pts || !SNAP_TYPES.includes(m.type) || State.isHidden(m)) continue;
      for (const q of [m.pts[0], m.pts[m.pts.length - 1]]) {
        if (q === skip) continue;
        const d = Geo.dist(p, q);
        if (d < bd) { bd = d; best = q; }
      }
    }
    return best ? { x: best.x, y: best.y, snapped: true } : { x: p.x, y: p.y, snapped: false };
  }

  /** Bearing (deg) of the in-progress polyline's last committed segment, 0 if none. */
  function segBase() {
    if (!creating || creating.pts.length < 2) return 0;
    const n = creating.pts.length;
    const a = creating.pts[n - 2], b = creating.pts[n - 1];
    return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  }

  /**
   * 45° constraint for the active tool given the previous point.
   * Free-angle is the default everywhere; Shift snaps to 45°. If the pipe
   * tool's "snap to 45°" option is on, Shift frees the angle instead.
   * After the first leg the snap grid is RELATIVE to the previous segment,
   * so an off-axis run still gets square tees and true 45s off itself.
   */
  function constrain(prev, p, shift) {
    const t = S().tool;
    const ortho = (t === 'pipe' && D().orthoPipe) ? !shift : shift;
    return ortho ? Geo.constrainAngle(prev, p, 45, segBase()) : p;
  }

  const clearPreview = () => { Viewer.el.preview.innerHTML = ''; };

  function preview(markup, extras) {
    const layer = Viewer.el.preview;
    layer.innerHTML = '';
    if (markup) {
      const g = Render.buildMarkupEl(markup);
      g.setAttribute('opacity', 0.85);
      layer.appendChild(g);
    }
    if (extras) layer.insertAdjacentHTML('beforeend', extras);
  }

  function snapIndicator(p) {
    const z = S().zoom;
    return `<circle cx="${p.x}" cy="${p.y}" r="${7 / z}" fill="none" stroke="#00c853" stroke-width="${2 / z}"/>`;
  }

  /** Live length readout next to the cursor while drawing pipes/measurements. */
  function lenReadout(pts, p) {
    const sc = State.scaleForPage(S().page);
    if (!sc) return '';
    const L = (Geo.polylineLength(pts) + (pts.length ? Geo.dist(pts[pts.length - 1], p) : 0)) * sc.ftPerUnit;
    const z = S().zoom, fs = 12 / z;
    const txt = Units.fmtLen(L, S().unitFormat);
    // under a finger the loupe carries the readout — a sheet copy would only sit
    // under the fingertip and clip at the loupe's edge
    if (Loupe.active()) { Loupe.setLabel(txt); return ''; }
    return `<text class="len-readout" x="${p.x + 14 / z}" y="${p.y - 10 / z}" font-family="Arial" font-size="${fs}" font-weight="bold" fill="#1f6fd0" stroke="#fff" stroke-width="${fs * 0.28}" paint-order="stroke">${txt}</text>`;
  }

  function moveBy(m, dx, dy) {
    if (m.pts) for (const p of m.pts) { p.x += dx; p.y += dy; }
    if (m.x != null) { m.x += dx; m.y += dy; }
    if (m.anchor) { m.anchor.x += dx; m.anchor.y += dy; }
  }

  /**
   * A drag that lives until its pointer lifts. downEvent is the pointer event
   * that started it: the pointer is captured on the overlay — a stable element
   * that already has touch-action:none — because the element under the finger
   * (a selection handle, the markup being moved) is re-rendered mid-drag, and
   * WebKit then delivers the rest of the touch, release included, to the
   * detached node; the drag's listeners never see the lift and it leaks into
   * every later touch. (Capturing on the scrollable viewport instead makes
   * engines read the moving touch as a scroll and pointercancel it.) Only that
   * pointer feeds the drag — a pencil hovering nearby doesn't. withLoupe: a
   * touch gets the magnifier.
   */
  function windowDrag(onMove, onUp, onAbort, downEvent, withLoupe) {
    dragging = true;
    const pid = downEvent && downEvent.pointerId != null ? downEvent.pointerId : null;
    const vp = Viewer.el.overlay;
    if (pid != null) { try { vp.setPointerCapture(pid); } catch (e) { /* not capturable — window listeners still cover it */ } }
    if (withLoupe && downEvent) Loupe.begin(downEvent);
    let lastEv = downEvent || null;
    const mine = e => pid == null || e.pointerId === pid;
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (pid != null) { try { if (vp.hasPointerCapture(pid)) vp.releasePointerCapture(pid); } catch (e) { /* already released */ } }
      dragging = false;
      activeDragAbort = null;
      activeDragFinish = null;
      Loupe.end();
    };
    const move = e => { if (!mine(e)) return; lastEv = e; onMove(e); Loupe.track(e); };
    const up = e => { if (!mine(e)) return; cleanup(); if (onUp) onUp(e); };
    const cancel = e => { if (!mine(e)) return; cleanup(); if (onAbort) onAbort(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    activeDragAbort = () => { cleanup(); if (onAbort) onAbort(); };
    // leak breaker: every finger is up but no pointerup reached us — settle where it was
    activeDragFinish = () => { cleanup(); if (onUp) onUp(lastEv); };
  }

  /** One-finger pan of the scrollable view (touch fallback in tap-style tools / empty sheet). */
  function beginTouchPan(e) {
    const vp = Viewer.el.viewport;
    const pid = e.pointerId;
    let last = { x: e.clientX, y: e.clientY };
    windowDrag(ev => {
      if (ev.pointerId !== pid) return;
      vp.scrollLeft -= ev.clientX - last.x;
      vp.scrollTop -= ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
    }, null, null, e, false);
  }

  /* ================= creation: drag tools ================= */

  function beginDragCreate(e, p0) {
    const tool = S().tool;
    const d = D();
    let moved = false;
    const base = {
      page: S().page, color: d.color, lineWidth: d.lineWidth, opacity: d.opacity,
      lineStyle: d.lineStyle, fontSize: d.fontSize,
    };
    if (d.layer) base.layer = d.layer;
    let m = null;

    const start = snapPoint(p0);

    const onMove = ev => {
      let p = Viewer.toPage(ev);
      moved = moved || Geo.dist(p0, p) > 3 / S().zoom;
      if (!moved) return;

      switch (tool) {
        case 'line': case 'arrow': case 'mlength': {
          p = ev.shiftKey ? Geo.constrainAngle(start, p, 45) : snapPoint(p);
          m = { ...base, type: tool, pts: [{ x: start.x, y: start.y }, { x: p.x, y: p.y }] };
          if (tool === 'mlength') m.subject = 'Length';
          if (tool === 'line' && d.ends && d.ends !== 'none') m.ends = d.ends;
          let extras = p.snapped ? snapIndicator(p) : '';
          if (tool === 'mlength') extras += lenReadout([m.pts[0]], p);
          preview(m, extras);
          break;
        }
        case 'rect': case 'ellipse': case 'cloud': case 'zone': {
          const x = Math.min(p0.x, p.x), y = Math.min(p0.y, p.y);
          m = { ...base, type: tool, x, y, w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y), fill: d.fill, fillOpacity: d.fillOpacity, arcSize: d.arcSize };
          if (tool === 'zone') { m.fill = m.color; m.fillOpacity = 0.14; m.label = ''; m.jobs = []; }
          preview(m);
          break;
        }
        case 'pen': case 'highlight': {
          if (!m) {
            m = { ...base, type: tool, pts: [{ x: p0.x, y: p0.y }] };
            if (tool === 'highlight') { m.color = d.highlightColor; m.lineWidth = d.highlightWidth; }
          }
          const last = m.pts[m.pts.length - 1];
          if (Geo.dist(last, p) > 1.2 / S().zoom) m.pts.push({ x: p.x, y: p.y });
          preview(m);
          break;
        }
        case 'callout': {
          m = { ...base, type: 'callout', anchor: { x: p0.x, y: p0.y }, x: p.x, y: p.y - 14, w: 130, h: 34, text: '' };
          preview(m);
          break;
        }
      }
    };

    windowDrag(onMove, () => {
      clearPreview();
      if (!m || !moved) {
        if (tool === 'callout') { /* need a drag */ }
        return;
      }
      if ((tool === 'rect' || tool === 'ellipse' || tool === 'cloud' || tool === 'zone') && (m.w < 3 || m.h < 3)) return;
      if ((tool === 'line' || tool === 'arrow' || tool === 'mlength') && Geo.polylineLength(m.pts) < 2) return;
      m.subject = m.subject || ({
        line: 'Line', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Ellipse', cloud: 'Revision Cloud',
        pen: 'Pen', highlight: 'Highlight', mlength: 'Length', callout: 'Callout', zone: 'Area zone',
      })[tool] || tool;
      const created = State.addMarkup(m);
      if (tool === 'callout') { State.select([created.id]); editText(created, true); }
      else State.select([created.id]);
      if (tool === 'zone' && typeof Aro !== 'undefined') Aro.zoneLinkDialog(created); // name it + link its jobs straight away
    }, clearPreview /* abort: second finger arrived — discard, nothing committed */, e, true);
  }

  /* ================= creation: multi-click poly tools ================= */

  function polyClick(e, p) {
    const tool = S().tool;
    const d = D();
    let sp = snapPoint(p);
    if (creating) {
      const prev = creating.pts[creating.pts.length - 1];
      // connecting to an existing endpoint beats angle snapping
      const c = sp.snapped ? sp : constrain(prev, p, e.shiftKey);
      creating.pts.push({ x: c.x, y: c.y });
    } else {
      const base = {
        page: S().page, color: d.color, lineWidth: d.lineWidth, opacity: d.opacity, lineStyle: d.lineStyle,
        fontSize: d.fontSize, pts: [{ x: sp.x, y: sp.y }],
      };
      if (d.layer) base.layer = d.layer;
      if (tool === 'pipe') {
        Object.assign(base, {
          type: 'pipe',
          color: d.colorBySize ? (Symbols.PIPE_COLORS[d.pipeSize] || d.color) : d.color,
          lineWidth: Math.max(d.lineWidth, 3),          // fallback when uncalibrated / fixed mode
          widthMode: d.pipeWidthMode || 'scale',        // 'scale' = draw at true OD width
          widthScale: d.pipeWidthScale || 1,            // visibility multiplier on that width
          pipeSize: d.pipeSize, material: d.material, system: d.system,
          showLabel: d.showLabel, subject: `Pipe ${d.pipeSize}`,
        });
      } else if (tool === 'mpoly') {
        Object.assign(base, { type: 'mpoly', subject: 'Polylength', showLabel: true });
      } else if (tool === 'marea') {
        Object.assign(base, { type: 'marea', subject: 'Area', showLabel: true, fill: d.fill, fillOpacity: d.fillOpacity, showPerim: !!d.showPerim });
      } else if (tool === 'polygon') {
        Object.assign(base, { type: 'polyline', closed: true, subject: 'Polygon', fill: d.fill, fillOpacity: d.fillOpacity, cloudStyle: !!d.cloudStyle, arcSize: d.arcSize });
      } else {
        Object.assign(base, { type: 'polyline', subject: 'Polyline', cloudStyle: !!d.cloudStyle, arcSize: d.arcSize });
        if (d.ends && d.ends !== 'none') base.ends = d.ends;
      }
      creating = base;
    }
    updatePolyPreview(p, e.shiftKey);
  }

  function updatePolyPreview(p, shift) {
    if (!creating) return;
    const prev = creating.pts[creating.pts.length - 1];
    let sp = snapPoint(p);
    const c = sp.snapped ? sp : constrain(prev, p, shift);
    const temp = { ...creating, pts: [...creating.pts, { x: c.x, y: c.y }] };
    if (creating.type === 'marea') temp.closed = true;
    let extras = sp.snapped ? snapIndicator(sp) : '';
    if (creating.type === 'pipe' || creating.type === 'mpoly') extras += lenReadout(creating.pts, c);
    preview(temp, extras);
  }

  function finishPoly() {
    if (!creating) return;
    const m = creating;
    creating = null;
    clearPreview();
    // drop trailing duplicate points (double-click adds one on its second press)
    while (m.pts.length > 1 && Geo.dist(m.pts[m.pts.length - 1], m.pts[m.pts.length - 2]) < 2.5 / S().zoom) {
      m.pts.pop();
    }
    const minPts = (m.type === 'marea' || m.closed) ? 3 : 2;
    if (m.pts.length < minPts) return;
    if (m.type === 'marea') m.closed = true;
    const created = State.addMarkup(m);
    State.select([created.id]);
  }

  function cancelCreation() {
    creating = null;
    clearPreview();
  }

  /* ================= calibrate ================= */

  let calPts = [];
  function calibrateClick(p) {
    calPts.push(p);
    if (calPts.length === 2) {
      const len = Geo.dist(calPts[0], calPts[1]);
      const pts = calPts.slice();
      calPts = [];
      clearPreview();
      if (len < 2) return;
      App.calibrateDialog(len);
      void pts;
    }
  }
  function calibratePreview(p) {
    if (!calPts.length) return;
    const z = S().zoom;
    const a = calPts[0];
    preview(null,
      `<path d="M${a.x} ${a.y}L${p.x} ${p.y}" stroke="#1f6fd0" stroke-width="${2 / z}" stroke-dasharray="${6 / z} ${4 / z}" fill="none"/>` +
      `<circle cx="${a.x}" cy="${a.y}" r="${4 / z}" fill="#1f6fd0"/>` +
      `<circle cx="${p.x}" cy="${p.y}" r="${4 / z}" fill="#1f6fd0"/>`);
  }

  /* ================= symbol / stamp / count / text ================= */

  function placeSymbol(p) {
    const d = D();
    const id = S().activeSymbol;
    if (!id) { App.toast('Pick a symbol or stamp in the Symbols tab first.', 'warn'); App.showTab('symbols'); return; }
    let m;
    if (id.startsWith('st-')) {
      const st = Symbols.stampById(id);
      m = {
        type: 'stamp', page: S().page, x: p.x, y: p.y, size: d.symbolSize * 1.4,
        color: st.color, text: st.text, rotation: S().symbolRotation,
        subject: `Stamp: ${st.text}`, lineWidth: 2,
      };
    } else {
      const sym = Symbols.byId(id);
      if (!sym) return;
      m = {
        type: 'symbol', page: S().page, x: p.x, y: p.y, size: d.symbolSize,
        color: d.color, symbolId: id, rotation: S().symbolRotation,
        showLabel: d.symbolLabel, subject: sym.name, lineWidth: 2,
      };
    }
    const created = State.addMarkup(m);
    State.select([created.id]);
  }

  function symbolGhost(p) {
    const id = S().activeSymbol;
    if (!id) { clearPreview(); return; }
    const d = D();
    let m;
    if (id.startsWith('st-')) {
      const st = Symbols.stampById(id);
      m = { type: 'stamp', page: S().page, x: p.x, y: p.y, size: d.symbolSize * 1.4, color: st.color, text: st.text, rotation: S().symbolRotation, lineWidth: 2 };
    } else {
      m = { type: 'symbol', page: S().page, x: p.x, y: p.y, size: d.symbolSize, color: d.color, symbolId: id, rotation: S().symbolRotation, showLabel: false, lineWidth: 2 };
    }
    const g = Render.buildMarkupEl(m);
    g.setAttribute('opacity', 0.55);
    const layer = Viewer.el.preview;
    layer.innerHTML = '';
    layer.appendChild(g);
  }

  function placeCount(p) {
    let gid = S().activeCountGroup;
    if (!gid) {
      const g = State.addCountGroup('Count 1', 'circle', '#e02020');
      gid = g.id;
      State.emit('countGroups');
    }
    const grp = State.countGroup(gid);
    State.addMarkup({
      type: 'count', page: S().page, x: p.x, y: p.y, groupId: gid,
      color: grp.color, size: 7, subject: grp.name,
    });
  }

  /* ================= penetrations ================= */

  function placePenetration(p) {
    const d = D();
    const created = State.addMarkup({
      type: 'penet', page: S().page, x: p.x, y: p.y,
      size: Math.max(8, Math.round(d.symbolSize * 0.6)),
      color: d.color, lineWidth: 2, fontSize: d.fontSize,
      penSize: d.penSize, penType: d.penType, penFire: d.penFire,
      showLabel: true,
      subject: `Penetration Ø${d.penSize}`,
    });
    State.select([created.id]);
  }

  /* ================= press fittings ================= */

  function placeFitting(p) {
    const d = D();
    const fit = Symbols.fittingById(S().activeFitting);
    if (!fit) { App.toast('Pick a fitting in the Fittings tab first.', 'warn'); App.showTab('fittings'); return; }
    State.addMarkup({
      type: 'fitting', page: S().page, x: p.x, y: p.y,
      fitId: fit.id, pipeSize: d.pipeSize,
      color: d.colorBySize ? (Symbols.PIPE_COLORS[d.pipeSize] || d.color) : d.color,
      size: 15, fontSize: d.fontSize, showLabel: true,
      subject: `${fit.name} ${d.pipeSize}`,
    });
    // stays armed — tap tap tap for rapid entry; the palette badge updates live
  }

  /* ================= photos ================= */

  let armedPhoto = null;   // { imgId, aspect } waiting for a placement click

  function importPhotoFile(file, cb) {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 1600;                       // keep autosave/projects sane
      const sc = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * sc));
      c.height = Math.max(1, Math.round(img.naturalHeight * sc));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      cb(c.toDataURL('image/jpeg', 0.82), c.width / c.height);
    };
    img.onerror = () => { URL.revokeObjectURL(url); App.toast('Could not read that image file.', 'err'); };
    img.src = url;
  }

  function armPhoto(file) {
    importPhotoFile(file, (dataUrl, aspect) => {
      armedPhoto = { imgId: State.addImage(dataUrl), aspect };
      State.setTool('photo');
      App.toast('Click the drawing to place the photo.', 'ok', 3500);
      if (hoverPt) photoGhost(hoverPt);
    });
  }

  function photoMarkupAt(p, ghost) {
    const d = D();
    const w = d.photoWidth || 220;
    const h = w / (armedPhoto ? armedPhoto.aspect : 4 / 3);
    return {
      type: 'photo', page: S().page,
      x: p.x - w / 2, y: p.y - h / 2, w, h,
      imgId: armedPhoto ? armedPhoto.imgId : null,
      color: d.color, lineWidth: 2, fontSize: 11,
      caption: '', subject: 'Photo',
      opacity: ghost ? 0.6 : 1,
    };
  }

  function photoGhost(p) {
    if (!armedPhoto) { clearPreview(); return; }
    const layer = Viewer.el.preview;
    layer.innerHTML = '';
    layer.appendChild(Render.buildMarkupEl(photoMarkupAt(p, true)));
  }

  function placePhoto(p) {
    if (!armedPhoto) {
      document.getElementById('filePhoto').click();
      return;
    }
    const m = photoMarkupAt(p, false);
    delete m.opacity;
    armedPhoto = null;
    clearPreview();
    const created = State.addMarkup(m);
    State.setTool('select');
    State.select([created.id]);
  }

  /** Drag-dropped image file → import and place centered on the drop point. */
  function placeDroppedPhoto(file, p) {
    importPhotoFile(file, (dataUrl, aspect) => {
      armedPhoto = { imgId: State.addImage(dataUrl), aspect };
      const m = photoMarkupAt(p, false);
      delete m.opacity;
      armedPhoto = null;
      const created = State.addMarkup(m);
      State.setTool('select');
      State.select([created.id]);
    });
  }

  function placeText(p) {
    const d = D();
    const m = State.addMarkup({
      type: 'text', page: S().page, x: p.x, y: p.y, w: 150, h: d.fontSize * 2,
      color: d.color, fontSize: d.fontSize, text: '', fill: d.textBg === 'white' ? '#ffffff' : 'none', fillOpacity: 0.85,
      border: !!d.textBorder, bold: !!d.textBold, lineWidth: 1.5, subject: 'Text', ...(d.layer ? { layer: d.layer } : {}),
    });
    State.select([m.id]);
    editText(m, true);
  }

  /* ================= sequence: auto-numbered labels (D-01, D-02…) ================= */

  const seqLabel = (d, n) => `${d.seqPrefix || ''}${String(n).padStart(Math.max(0, d.seqPad || 0), '0')}`;

  function placeSequence(p) {
    const d = D();
    const n = Math.max(1, parseInt(d.seqNext, 10) || 1);
    const text = seqLabel(d, n);
    const fs = d.fontSize || 12;
    const w = Render.textWidth(text, fs, true) + fs * 0.9, h = fs * 1.7;
    const m = State.addMarkup({
      type: 'text', page: S().page, x: p.x - w / 2, y: p.y - h / 2, w, h,
      color: d.color, fontSize: fs, text, fill: '#ffffff', fillOpacity: 0.9, border: true, bold: true,
      lineWidth: Math.max(1, d.lineWidth || 1.5), subject: 'Sequence', seq: n, ...(d.layer ? { layer: d.layer } : {}),
    });
    d.seqNext = n + 1;
    try { localStorage.setItem('abmt:seq', JSON.stringify({ prefix: d.seqPrefix, next: d.seqNext, pad: d.seqPad })); } catch (e) { /* ignore */ }
    Props.renderProps();   // the next number shows in the panel
    return m;
  }

  function sequenceGhost(p) {
    const d = D();
    const text = seqLabel(d, Math.max(1, parseInt(d.seqNext, 10) || 1));
    const fs = d.fontSize || 12;
    const w = Render.textWidth(text, fs, true) + fs * 0.9, h = fs * 1.7;
    const g = Render.buildMarkupEl({ type: 'text', page: S().page, x: p.x - w / 2, y: p.y - h / 2, w, h, color: d.color, fontSize: fs, text, fill: '#ffffff', fillOpacity: 0.9, border: true, bold: true, lineWidth: 1.5 });
    g.setAttribute('opacity', 0.55);
    const layer = Viewer.el.preview;
    layer.innerHTML = '';
    layer.appendChild(g);
  }

  /* ================= tool chest: saved groups of markups, placed as one ================= */

  const CHEST_KEY = 'abmt:toolchest';
  let chest = (() => { try { return JSON.parse(localStorage.getItem(CHEST_KEY) || '[]') || []; } catch (e) { return []; } })();
  let activeChest = null;   // id of the armed chest tool

  const saveChest = () => { try { localStorage.setItem(CHEST_KEY, JSON.stringify(chest)); } catch (e) { /* ignore */ } };
  const chestList = () => chest.slice();
  const chestById = id => chest.find(t => t.id === id) || null;

  /** Save the selected markups as a reusable tool: geometry relative to their common bounds. */
  function saveToChest(name) {
    const sel = State.selectedMarkups().filter(m => m.type !== 'zone' && m.type !== 'photo');
    if (!sel.length) return null;
    const b = unionBounds(sel);
    const items = sel.map(m => {
      const c = JSON.parse(JSON.stringify(m));
      delete c.id; delete c.author; delete c.date; delete c.day; delete c.grp; delete c.locked; delete c.status;
      moveBy(c, -b.x, -b.y);
      return c;
    });
    const t = { id: 'ct' + Date.now().toString(36), name: name || (sel.length === 1 ? (sel[0].subject || sel[0].type) : `${sel.length} markups`), w: b.w, h: b.h, items };
    chest.push(t);
    saveChest();
    if (typeof Props !== 'undefined') Props.renderSymbols();
    return t;
  }
  function removeChestTool(id) {
    chest = chest.filter(t => t.id !== id);
    if (activeChest === id) activeChest = null;
    saveChest();
    if (typeof Props !== 'undefined') Props.renderSymbols();
  }
  function armChest(id) {
    activeChest = id;
    State.setTool('chest');
    if (hoverPt) chestGhost(hoverPt);
  }

  function chestMarkupsAt(t, p) {
    const d = D();
    const gid = t.items.length > 1 ? 'grp' + (State.S.idCounter++) : null;
    return t.items.map(it => {
      const c = JSON.parse(JSON.stringify(it));
      moveBy(c, p.x - t.w / 2, p.y - t.h / 2);
      c.page = S().page;
      if (gid) c.grp = gid;
      if (d.layer) c.layer = d.layer;
      return c;
    });
  }
  function chestGhost(p) {
    const t = chestById(activeChest);
    if (!t) { clearPreview(); return; }
    const layer = Viewer.el.preview;
    layer.innerHTML = '';
    for (const m of chestMarkupsAt(t, p)) { const g = Render.buildMarkupEl(m); g.setAttribute('opacity', 0.55); layer.appendChild(g); }
  }
  function placeChest(p) {
    const t = chestById(activeChest);
    if (!t) { App.toast('Pick a tool in the Tool Chest (Symbols tab) first.', 'warn'); App.showTab('symbols'); return; }
    State.pushUndo();
    const ids = [];
    for (const m of chestMarkupsAt(t, p)) ids.push(State.addMarkup(m, { noUndo: true }).id);
    State.select(ids);
  }

  /* ================= edit operations: clipboard, order, groups, align, lock ================= */

  let clipboard = [];   // deep copies of markups, ids stripped

  const unionBounds = ms => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const m of ms) {
      const b = Geo.markupBounds(m);
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  const cloneOf = m => { const c = JSON.parse(JSON.stringify(m)); delete c.id; return c; };

  function copySelection() {
    const sel = State.selectedMarkups();
    if (!sel.length) return 0;
    clipboard = sel.map(cloneOf);
    return sel.length;
  }
  function cutSelection() {
    const n = copySelection();
    if (n) State.deleteMarkups([...S().selection]);
    return n;
  }
  /** Paste onto the current page: nudged when it lands on the page it came from, in place on any other page. */
  function paste() {
    if (!clipboard.length) return 0;
    State.pushUndo();
    const samePage = clipboard.every(m => m.page === S().page);
    const grpMap = {};
    const ids = [];
    for (const src of clipboard) {
      const c = JSON.parse(JSON.stringify(src));
      c.page = S().page;
      c.date = new Date().toISOString(); c.day = S().workDay; c.author = S().author;
      if (c.grp) c.grp = grpMap[c.grp] || (grpMap[c.grp] = 'grp' + (State.S.idCounter++));
      if (samePage) moveBy(c, 14, 14);
      ids.push(State.addMarkup(c, { noUndo: true }).id);
    }
    // the next paste of the same thing lands a step further along
    if (samePage) for (const m of clipboard) moveBy(m, 14, 14);
    State.select(ids);
    return ids.length;
  }

  function duplicateSelection() {
    const sel = [...S().selection];
    if (!sel.length) return;
    State.pushUndo();
    const clones = [];
    const grpMap = {};
    for (const id of sel) {
      const m = State.getMarkup(id);
      if (!m) continue;
      const c = JSON.parse(JSON.stringify(m));
      c.id = State.newId();
      c.date = new Date().toISOString();
      delete c.locked;
      if (c.grp) c.grp = grpMap[c.grp] || (grpMap[c.grp] = 'grp' + (State.S.idCounter++));
      moveBy(c, 14, 14);
      State.S.markups.push(c);
      clones.push(c.id);
    }
    State.emit('markups'); State.touch();
    State.select(clones);
  }

  /** Clone the selection onto every other page (title-block stamps, legends, north arrows…). */
  function copyToAllPages() {
    const sel = State.selectedMarkups();
    if (!sel.length || S().pageCount < 2) return 0;
    State.pushUndo();
    let n = 0;
    for (let p = 1; p <= S().pageCount; p++) {
      if (p === S().page) continue;
      const grpMap = {};
      for (const m of sel) {
        const c = cloneOf(m);
        c.page = p;
        if (c.grp) c.grp = grpMap[c.grp] || (grpMap[c.grp] = 'grp' + (State.S.idCounter++));
        State.addMarkup(c, { noUndo: true });
        n++;
      }
    }
    return n;
  }

  const ALIGN_OPS = ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'];
  function alignSelection(op) {
    const sel = State.selectedMarkups().filter(m => !State.isLocked(m));
    if (sel.length < 2) return;
    const U = unionBounds(sel);
    State.pushUndo();
    for (const m of sel) {
      const b = Geo.markupBounds(m);
      let dx = 0, dy = 0;
      if (op === 'left') dx = U.x - b.x;
      else if (op === 'right') dx = U.x + U.w - (b.x + b.w);
      else if (op === 'hcenter') dx = U.x + U.w / 2 - (b.x + b.w / 2);
      else if (op === 'top') dy = U.y - b.y;
      else if (op === 'bottom') dy = U.y + U.h - (b.y + b.h);
      else if (op === 'vcenter') dy = U.y + U.h / 2 - (b.y + b.h / 2);
      moveBy(m, dx, dy);
    }
    const ids = sel.map(m => m.id);
    State.emit('markups', { changed: ids }); State.touch();
  }

  function setLocked(locked) {
    const sel = [...S().selection];
    if (!sel.length) return;
    State.updateMarkups(sel, m => (m.type === 'zone' ? {} : { locked: !!locked }));
    for (const m of State.S.markups) if (m.locked === false) delete m.locked;
    State.emit('selection');
  }
  const selectionLocked = () => { const sel = State.selectedMarkups(); return sel.length > 0 && sel.every(m => m.locked); };

  function setStatus(status) {
    const sel = [...S().selection];
    if (!sel.length) return;
    State.updateMarkups(sel, { status: status || '' });
    for (const m of State.S.markups) if (m.status === '') delete m.status;
  }

  function groupSelection() {
    const ids = [...S().selection];
    if (ids.length < 2) { App.toast('Select two or more markups to group them.', 'info'); return; }
    State.groupMarkups(ids);
    App.toast(`Grouped ${ids.length} markups — they select and move as one.`, 'ok', 3000);
  }
  function ungroupSelection() {
    const ids = [...S().selection].filter(id => { const m = State.getMarkup(id); return m && m.grp; });
    if (!ids.length) return;
    State.ungroupMarkups(ids);
    App.toast('Ungrouped.', 'ok', 2000);
  }

  /** A markup's look becomes the tool defaults (Bluebeam's "Set as Default"). */
  function setAsDefaults() {
    const m = State.selectedMarkups()[0];
    if (!m) return;
    const d = D();
    for (const k of ['color', 'lineWidth', 'opacity', 'lineStyle', 'fontSize', 'fill', 'fillOpacity', 'arcSize']) if (m[k] != null) d[k] = m[k];
    if (m.ends) d.ends = m.ends;
    if (m.type === 'text') { d.textBold = !!m.bold; d.textBorder = !!m.border; d.textBg = m.fill && m.fill !== 'none' ? 'white' : 'none'; }
    if (m.type === 'pipe') { d.pipeSize = m.pipeSize; d.material = m.material; d.system = m.system; }
    if (m.layer != null) d.layer = m.layer;
    App.toast('These properties are now the defaults for new markups.', 'ok', 3000);
  }

  /* ================= inline text editing ================= */

  function editText(m, isNew) {
    closeTextEditor(true);
    const z = S().zoom;
    const layer = Viewer.el.edit;
    const ta = document.createElement('textarea');
    ta.value = m.text || '';
    ta.style.left = m.x * z + 'px';
    ta.style.top = m.y * z + 'px';
    ta.style.width = Math.max(60, m.w * z) + 'px';
    ta.style.height = Math.max(26, m.h * z) + 'px';
    ta.style.fontSize = (m.fontSize || 12) * z + 'px';
    layer.appendChild(ta);
    ta.focus();
    if (!isNew) ta.select();

    const commit = () => {
      const text = ta.value.replace(/\s+$/, '');
      ta.remove();
      editingTextarea = null;
      if (!text && isNew) { State.deleteMarkups([m.id]); return; }
      const fs = m.fontSize || 12;
      const lines = Render.wrapText(text, m.w - fs * 0.7, fs);
      const h = Math.max(fs * 1.7, fs * 0.7 + lines.length * fs * 1.25);
      State.updateMarkups([m.id], { text, h }, { noUndo: isNew });
    };
    const cancel = () => {
      ta.remove();
      editingTextarea = null;
      if (isNew) State.deleteMarkups([m.id]);
    };
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { ta.removeEventListener('blur', commit); cancel(); }
      if (e.key === 'Enter' && e.ctrlKey) ta.blur();
    });
    editingTextarea = ta;
  }

  function closeTextEditor(commit) {
    if (editingTextarea) {
      if (commit) editingTextarea.blur();
      else editingTextarea.remove();
      editingTextarea = null;
    }
  }

  /* ================= select tool ================= */

  function selectDown(e, p) {
    const g = e.target.closest && e.target.closest('g[data-id]');
    if (g) {
      const id = g.dataset.id;
      const additive = e.shiftKey;
      // a grouped markup brings its whole group along
      const ids = State.groupOf(id);
      if (additive) { State.select(ids, true); return; }
      if (!S().selection.has(id)) State.select(ids);
      beginMoveDrag(e, p);
      return;
    }
    // empty space → marquee
    beginMarquee(e, p);
  }

  function beginMoveDrag(e, p0) {
    const ids = [...S().selection];
    if (!ids.length) return;
    // zones are position-locked unless explicitly unlocked — a stray drag
    // across a big zone box must never haul the zone along; locked markups likewise
    const movable = ids.filter(id => !State.isLocked(State.getMarkup(id)));
    let started = false;
    let moved = false;
    let last = p0;
    // touch: a finger held still on the selection opens the markup menu (no right button on a tablet)
    let holdTimer = null;
    if (e.pointerType === 'touch') {
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (moved || started) return;
        if (activeDragAbort) activeDragAbort();
        Loupe.end();
        App.markupMenu(e.clientX, e.clientY);
      }, 550);
    }
    windowDrag(ev => {
      const p = Viewer.toPage(ev);
      moved = moved || Geo.dist(p0, p) * S().zoom >= 3;
      if (moved && holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (!movable.length) return;
      if (!started) {
        if (!moved) return;
        State.pushUndo();
        started = true;
      }
      const dx = p.x - last.x, dy = p.y - last.y;
      last = p;
      for (const id of movable) {
        const m = State.getMarkup(id);
        if (m) moveBy(m, dx, dy);
      }
      Render.refresh(movable);
    }, () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (started) { State.touch(); State.emit('markups', { changed: movable }); }
      else if (!moved && ids.length === 1) {
        // a plain tap on a zone opens its task/materials popover
        const m = State.getMarkup(ids[0]);
        if (m && m.type === 'zone' && typeof Aro !== 'undefined') Aro.zonePopover(m);
      }
    }, () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (started) State.undo();   // gesture abort: put the markups back
    }, e, false);
  }

  function beginMarquee(e, p0) {
    const additive = e.shiftKey;
    let moved = false;
    windowDrag(ev => {
      const p = Viewer.toPage(ev);
      moved = moved || Geo.dist(p0, p) * S().zoom > 4;
      if (!moved) return;
      const z = S().zoom;
      const x = Math.min(p0.x, p.x), y = Math.min(p0.y, p.y);
      const w = Math.abs(p.x - p0.x), h = Math.abs(p.y - p0.y);
      preview(null, `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#4da3ff" fill-opacity="0.12" stroke="#4da3ff" stroke-width="${1.2 / z}" stroke-dasharray="${5 / z} ${4 / z}"/>`);
    }, ev => {
      clearPreview();
      const p = Viewer.toPage(ev);
      if (!moved) { if (!additive) State.clearSelection(); return; }
      const box = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
      const hits = State.pageMarkups(S().page)
        .filter(m => !State.isHidden(m) && Geo.rectsIntersect(box, Geo.markupBounds(m)))
        .map(m => m.id);
      // touching any member of a group takes the whole group
      const all = new Set();
      for (const id of hits) for (const g of State.groupOf(id)) all.add(g);
      State.select([...all], additive);
    }, clearPreview, e, false);
  }

  /* ---- handle drags (vertex move / resize / callout anchor) ---- */

  function handleDown(e) {
    const h = e.target;
    const id = h.dataset.hid, kind = h.dataset.kind;
    const m = State.getMarkup(id);
    if (!m) return;
    if (State.isLocked(m)) return; // locked zones / markups don't resize either
    e.stopPropagation();
    let started = false;
    windowDrag(ev => {
      let p = Viewer.toPage(ev);
      if (!started) { State.pushUndo(); started = true; }
      if (kind === 'pt') {
        const idx = Number(h.dataset.idx);
        const sp = snapPoint(p, m.pts[idx]);
        const ref = m.pts[idx > 0 ? idx - 1 : (m.pts.length > 1 ? 1 : 0)];
        let c = sp.snapped ? sp : (ev.shiftKey && ref ? Geo.constrainAngle(ref, p, 45) : p);
        m.pts[idx].x = c.x; m.pts[idx].y = c.y;
        // a snap onto another run's endpoint is shown as it happens (the loupe carries it too)
        preview(null, sp.snapped ? snapIndicator(sp) : '');
        if (Loupe.active() && (m.type === 'mlength' || m.type === 'mpoly' || m.type === 'pipe')) {
          const sc = State.scaleForPage(m.page);
          if (sc) Loupe.setLabel(Units.fmtLen(Geo.polylineLength(m.pts) * sc.ftPerUnit, S().unitFormat));
        }
      } else if (kind === 'anchor') {
        m.anchor.x = p.x; m.anchor.y = p.y;
      } else {
        resizeRect(m, kind, p, ev.shiftKey);
      }
      Render.refresh([id]);
    }, () => {
      clearPreview();
      if (started) { State.touch(); State.emit('markups', { changed: [id] }); }
    }, () => {
      clearPreview();
      if (started) State.undo();
    }, e, true);
  }

  function resizeRect(m, kind, p, uniform) {
    let x0 = m.x, y0 = m.y, x1 = m.x + m.w, y1 = m.y + m.h;
    if (kind.includes('w')) x0 = p.x;
    if (kind.includes('e')) x1 = p.x;
    if (kind.includes('n')) y0 = p.y;
    if (kind.includes('s')) y1 = p.y;
    if (uniform && m.w > 0 && m.h > 0) {
      const ar = m.w / m.h;
      const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
      if (w / ar > h) { const nh = w / ar; if (kind.includes('n')) y0 = y1 - nh; else y1 = y0 + nh; }
      else { const nw = h * ar; if (kind.includes('w')) x0 = x1 - nw; else x1 = x0 + nw; }
    }
    m.x = Math.min(x0, x1); m.y = Math.min(y0, y1);
    m.w = Math.max(3, Math.abs(x1 - x0)); m.h = Math.max(3, Math.abs(y1 - y0));
  }

  /* ================= main event wiring ================= */

  function onOverlayDown(e) {
    if (e.button !== 0) return;                 // middle/right handled elsewhere
    if (S().tool === 'pan' || Viewer.isSpacePan()) return; // viewer pans
    if (!S().pdf) return;
    closeTextEditor(true);
    const p = Viewer.toPage(e);
    const tool = S().tool;

    if (e.pointerType === 'touch') {
      if (touchCount() >= 2) return;            // second finger of a gesture
      // tap-style tools act on pointerUP so a two-finger gesture never marks the sheet;
      // a moved finger converts into a one-finger pan (see onOverlayMove)
      if (POLY_TOOLS[tool] || CLICK_TOOLS[tool]) {
        pendingTap = { clientX: e.clientX, clientY: e.clientY, lastX: e.clientX, lastY: e.clientY, pointerId: e.pointerId, moved: false };
        tapConsumedAt = 0;   // new gesture — lets the click fallback fire if pointerup dies
        // rubber band straight onto the finger (touch has no hover), then the
        // loupe — the point lands where the finger lifts, so show what it's over
        if (creating) updatePolyPreview(p, false);
        else if (tool === 'calibrate' && calPts.length) calibratePreview(p);
        Loupe.begin(e);
        return;
      }
      if (tool === 'select') {
        const g = e.target.closest && e.target.closest('g[data-id]');
        if (!g) { beginTouchPan(e); return; }   // one finger on empty sheet pans
        // finger on a markup: select + drag it (falls through)
      }
    }

    if (tool === 'select') { selectDown(e, p); return; }
    if (POLY_TOOLS[tool]) { polyClick(e, p); return; }
    if (DRAG_TOOLS[tool]) { beginDragCreate(e, p); return; }
    if (tool === 'calibrate') { calibrateClick(p); return; }
    if (tool === 'symbol') { placeSymbol(p); return; }
    if (tool === 'count') { placeCount(p); return; }
    if (tool === 'text') { placeText(p); return; }
    if (tool === 'penet') { placePenetration(p); return; }
    if (tool === 'photo') { placePhoto(p); return; }
    if (tool === 'fitting') { placeFitting(p); return; }
    if (tool === 'sequence') { placeSequence(p); return; }
    if (tool === 'chest') { placeChest(p); return; }
  }

  /** Right-click (or a held finger) on the sheet: the markup menu for what's under it. */
  function onContextMenu(e) {
    if (!S().pdf) return;
    e.preventDefault();
    if (creating) return;
    const g = e.target.closest && e.target.closest('g[data-id]');
    if (g) {
      if (S().tool !== 'select') State.setTool('select');
      if (!S().selection.has(g.dataset.id)) State.select(State.groupOf(g.dataset.id));
    } else if (S().tool !== 'select') return;
    App.markupMenu(e.clientX, e.clientY, Viewer.toPage(e));
  }

  /** The tap action itself — shared by the pointerup path and the click fallback. */
  function runTapAction(tool, p, target) {
    tapConsumedAt = performance.now();
    if (POLY_TOOLS[tool]) {
      // tapping the last vertex again finishes the run (no double-click on touch)
      if (creating && creating.pts.length >= ((creating.type === 'marea' || creating.closed) ? 3 : 2)) {
        const lastPt = creating.pts[creating.pts.length - 1];
        if (Geo.dist(p, lastPt) < 16 / S().zoom) { finishPoly(); return; }
      }
      polyClick({ shiftKey: false, target }, p);
      return;
    }
    if (tool === 'calibrate') { calibrateClick(p); return; }
    if (tool === 'symbol') { placeSymbol(p); return; }
    if (tool === 'count') { placeCount(p); return; }
    if (tool === 'text') { placeText(p); return; }
    if (tool === 'penet') { placePenetration(p); return; }
    if (tool === 'photo') { placePhoto(p); return; }
    if (tool === 'fitting') { placeFitting(p); return; }
    if (tool === 'sequence') { placeSequence(p); return; }
    if (tool === 'chest') { placeChest(p); return; }
  }

  /**
   * Touch tap released → run the deferred tool action. Registered on window so
   * implicit touch pointer-capture can never hide the pointerup from us.
   * Also handles double-tap on the Select tool.
   */
  function onGlobalPointerUp(e) {
    if (e.pointerType !== 'touch') return;
    if (S().tool === 'select') {
      const g = e.target.closest && e.target.closest('g[data-id]');
      const now = performance.now();
      if (g && lastTap && lastTap.id === g.dataset.id && now - lastTap.t < 380 &&
          Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap = null;
        const m = State.getMarkup(g.dataset.id);
        if (m && (m.type === 'text' || m.type === 'callout')) { State.select([m.id]); editText(m, false); }
        else if (m && m.type === 'photo') { State.select([m.id]); App.photoLightbox(m); }
        return;
      }
      lastTap = g ? { t: now, x: e.clientX, y: e.clientY, id: g.dataset.id } : null;
      return;
    }
    if (!pendingTap || pendingTap.pointerId !== e.pointerId) return;
    const tap = pendingTap;
    pendingTap = null;
    Loupe.end();
    if (tap.moved) return;   // it became a pan, not a tap (gestures null pendingTap directly)
    // the point is the last position the finger was SEEN at (what the loupe showed),
    // not where the engine reports the lift — a finger rolls as it leaves the glass
    runTapAction(S().tool, Viewer.toPage({ clientX: tap.lastX, clientY: tap.lastY }), e.target);
  }

  /**
   * Safety net for engines that swallow the touch pointerup (seen on WebKit):
   * a tap always produces a click — run the action from it if nothing else did.
   */
  function onOverlayClick(e) {
    if (lastDownType !== 'touch') return;       // mouse flow acts on pointerdown
    if (!S().pdf) return;
    const now = performance.now();
    if (now - tapConsumedAt < 600) return;      // pointerup path already handled it
    if (now - gestureAt < 600) return;          // was a two-finger gesture
    if (now - panConvertedAt < 600) return;     // was a one-finger pan
    pendingTap = null;
    const tool = S().tool;
    if (!(POLY_TOOLS[tool] || CLICK_TOOLS[tool])) return;
    runTapAction(tool, Viewer.toPage(e), e.target);
  }

  function onOverlayMove(e) {
    if (!S().pdf) return;
    if (e.pointerType === 'touch' && touchCount() >= 2) return;  // view gesture
    // a touch that moves past the tap slop becomes a one-finger pan
    if (pendingTap && e.pointerId === pendingTap.pointerId && !pendingTap.moved &&
        Math.hypot(e.clientX - pendingTap.clientX, e.clientY - pendingTap.clientY) > TAP_SLOP) {
      pendingTap.moved = true;
      panConvertedAt = performance.now();
      Loupe.end();
      beginTouchPan(e);
      return;
    }
    lastClient = { clientX: e.clientX, clientY: e.clientY };
    hoverPt = Viewer.toPage(e);
    if (pendingTap && e.pointerId === pendingTap.pointerId) {
      pendingTap.lastX = e.clientX; pendingTap.lastY = e.clientY;
      Loupe.track(e);
    }
    hoverPreview(hoverPt, e.shiftKey);
  }

  function hoverPreview(pt, shift) {
    if (creating) updatePolyPreview(pt, shift);
    else if (S().tool === 'calibrate') calibratePreview(pt);
    else if (dragging) return;
    else if (S().tool === 'symbol') symbolGhost(pt);
    else if (S().tool === 'photo') photoGhost(pt);
    else if (S().tool === 'sequence') sequenceGhost(pt);
    else if (S().tool === 'chest') chestGhost(pt);
  }

  /** After the view pans under a stationary cursor, re-derive the hover point and previews. */
  function refreshHover(shift) {
    if (!lastClient) return;
    hoverPt = Viewer.toPage(lastClient);
    hoverPreview(hoverPt, shift);
  }

  function onOverlayDblClick(e) {
    if (S().tool === 'select') {
      const g = e.target.closest && e.target.closest('g[data-id]');
      if (g) {
        const m = State.getMarkup(g.dataset.id);
        if (m && (m.type === 'text' || m.type === 'callout')) { State.select([m.id]); editText(m, false); }
        else if (m && m.type === 'photo') { State.select([m.id]); App.photoLightbox(m); }
        else if (m) Props.focusSubject();
      }
      return;
    }
    if (creating) finishPoly();
  }

  function onKeyDown(e) {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    const sel = [...S().selection];

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'c' && sel.length) { e.preventDefault(); const n = copySelection(); App.toast(`Copied ${n} markup${n === 1 ? '' : 's'} — Ctrl+V pastes, on any page.`, 'ok', 2500); return; }
      if (k === 'x' && sel.length) { e.preventDefault(); cutSelection(); return; }
      if (k === 'v' && S().pdf) { e.preventDefault(); if (!paste()) App.toast('Nothing copied yet.', 'info', 2000); return; }
      if (k === 'g') { e.preventDefault(); if (e.shiftKey) ungroupSelection(); else groupSelection(); return; }
      if (k === 'l' && sel.length) { e.preventDefault(); setLocked(!selectionLocked()); return; }
      if (k === ']' && sel.length) { e.preventDefault(); State.reorder(sel, true); return; }
      if (k === '[' && sel.length) { e.preventDefault(); State.reorder(sel, false); return; }
      if (k === 'f') { e.preventDefault(); App.findDialog(); return; }
    }

    switch (e.key) {
      case 'Escape':
        if (creating) { cancelCreation(); return; }
        if (calPts.length) { calPts = []; clearPreview(); return; }
        if (S().selection.size) { State.clearSelection(); return; }
        State.setTool('select');
        return;
      case 'Enter':
        if (creating) { finishPoly(); e.preventDefault(); }
        return;
      case 'Backspace':
        if (creating) {
          creating.pts.pop();
          if (!creating.pts.length) cancelCreation();
          else if (hoverPt) updatePolyPreview(hoverPt, e.shiftKey);
          e.preventDefault();
          return;
        }
        // fallthrough to delete
      case 'Delete':
        if (sel.length) { State.deleteMarkups(sel); e.preventDefault(); }
        return;
      case 'r': case 'R': {
        if (S().tool === 'symbol') {
          S().symbolRotation = (S().symbolRotation + 90) % 360;
          if (hoverPt) symbolGhost(hoverPt);
          e.preventDefault();
          return;
        }
        const syms = sel.map(State.getMarkup).filter(m => m && (m.type === 'symbol' || m.type === 'stamp'));
        if (syms.length) {
          State.updateMarkups(sel, m => (m.type === 'symbol' || m.type === 'stamp') ? { rotation: ((m.rotation || 0) + 90) % 360 } : {});
          e.preventDefault();
        }
        return;
      }
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': {
        if (!S().pdf) return;
        // Select tool with a selection → nudge the markups (original behavior)
        if (sel.length && S().tool === 'select') {
          const targets = sel.filter(id => !State.isLocked(State.getMarkup(id)));
          if (!targets.length) { e.preventDefault(); return; } // locked zones don't nudge
          const step = (e.shiftKey ? 10 : 1);
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          State.pushUndo();
          for (const id of targets) { const m = State.getMarkup(id); if (m) moveBy(m, dx, dy); }
          Render.refresh(targets);
          State.emit('markups', { changed: targets });
          State.touch();
          e.preventDefault();
          return;
        }
        // otherwise pan the view — handy for navigating mid pipe run on big sheets
        const vp = Viewer.el.viewport;
        const step = e.shiftKey ? 320 : 90;
        if (e.key === 'ArrowLeft') vp.scrollLeft -= step;
        if (e.key === 'ArrowRight') vp.scrollLeft += step;
        if (e.key === 'ArrowUp') vp.scrollTop -= step;
        if (e.key === 'ArrowDown') vp.scrollTop += step;
        refreshHover(e.shiftKey);
        e.preventDefault();
        return;
      }
      case 'd': case 'D': {
        if ((e.ctrlKey || e.metaKey) && sel.length) {
          e.preventDefault();
          duplicateSelection();
        }
        return;
      }
    }
  }

  function init() {
    const o = Viewer.el.overlay;
    o.addEventListener('pointerdown', onOverlayDown);
    o.addEventListener('pointermove', onOverlayMove);
    o.addEventListener('click', onOverlayClick);
    o.addEventListener('dblclick', onOverlayDblClick);
    o.addEventListener('contextmenu', onContextMenu);
    Viewer.el.sel.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('pointerup', onGlobalPointerUp);
    // the Sequence tool remembers its prefix and counter across drawings
    try {
      const sq = JSON.parse(localStorage.getItem('abmt:seq') || 'null');
      if (sq) { if (sq.prefix != null) D().seqPrefix = sq.prefix; if (sq.next) D().seqNext = sq.next; if (sq.pad != null) D().seqPad = sq.pad; }
    } catch (e) { /* defaults */ }

    // touch bookkeeping: a second finger anywhere = view gesture → abort tool work
    const touchDown = e => {
      lastDownType = e.pointerType || 'mouse';
      if (e.pointerType !== 'touch') return;
      activeTouches.set(e.pointerId, performance.now());
      if (touchCount() === 2) {
        gestureAt = performance.now();
        pendingTap = null;
        Loupe.end();
        if (activeDragAbort) activeDragAbort();
        if (!creating) clearPreview();   // keep an in-progress run's rubber band
      }
    };
    const touchMove = e => {
      if (e.pointerType === 'touch' && activeTouches.has(e.pointerId)) {
        activeTouches.set(e.pointerId, performance.now());
      }
    };
    const touchEnd = e => { if (e.pointerType === 'touch') activeTouches.delete(e.pointerId); };
    window.addEventListener('pointerdown', touchDown, true);
    window.addEventListener('pointermove', touchMove, true);
    window.addEventListener('pointerup', touchEnd, true);
    window.addEventListener('pointercancel', touchEnd, true);
    // ground truth from native touch events (always delivered): no fingers = no gesture
    const touchSync = e => {
      if (e.touches && e.touches.length === 0) {
        activeTouches.clear();
        Loupe.end();
        if (activeDragFinish) activeDragFinish();   // every finger is up: a drag still "running" lost its pointerup
      }
    };
    window.addEventListener('touchend', touchSync, true);
    window.addEventListener('touchcancel', touchSync, true);
    // an engine-initiated cancel ends the tap without running it
    o.addEventListener('pointercancel', e => {
      if (pendingTap && pendingTap.pointerId === e.pointerId) pendingTap = null;
      Loupe.end();
    });
    Viewer.el.sel.addEventListener('pointerdown', e => {
      if (e.target.classList && e.target.classList.contains('handle')) handleDown(e);
    });
    window.addEventListener('keydown', onKeyDown);

    // photo tool: activating it with nothing armed opens the picker
    const photoInput = document.getElementById('filePhoto');
    photoInput.addEventListener('change', e => {
      if (e.target.files.length) armPhoto(e.target.files[0]);
      e.target.value = '';
    });

    State.on('tool', () => {
      cancelCreation();
      calPts = [];
      closeTextEditor(true);
      clearPreview();
      Loupe.end();
      toolCursor();
      if (S().tool !== 'select') State.clearSelection();
      if (S().tool === 'photo' && !armedPhoto && S().pdf) photoInput.click();
      if (S().tool !== 'photo') armedPhoto = null;
      if (S().tool !== 'chest') activeChest = null;
    });
    toolCursor();
  }

  return {
    init, TOOL_HINTS, cancelCreation, editText, closeTextEditor, isDragging: () => dragging, placeDroppedPhoto,
    copySelection, cutSelection, paste, hasClipboard: () => clipboard.length > 0, duplicateSelection, copyToAllPages,
    alignSelection, ALIGN_OPS, setLocked, selectionLocked, setStatus, groupSelection, ungroupSelection, setAsDefaults,
    chestList, chestById, saveToChest, removeChestTool, armChest, activeChest: () => activeChest, seqLabel,
  };
})();
