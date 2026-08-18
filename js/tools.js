/* ============ tools.js — pointer state machine for drawing, selecting, editing ============ */
'use strict';

const Tools = (() => {

  const SNAP_TYPES = ['pipe', 'mpoly', 'mlength', 'line', 'polyline', 'arrow'];
  const POLY_TOOLS = { pipe: 1, polyline: 1, mpoly: 1, marea: 1 };
  const DRAG_TOOLS = { line: 1, arrow: 1, mlength: 1, rect: 1, ellipse: 1, cloud: 1, pen: 1, highlight: 1, callout: 1 };

  const TOOL_HINTS = {
    select: 'Click to select · drag to move · Shift-click adds · drag empty space for marquee · double-click text to edit · Del deletes',
    pan: 'Drag to pan. Mouse wheel zooms.',
    pipe: 'Click points along the route — any angle · Shift snaps 45°/90° off the previous leg · arrow keys pan the view mid-run (Shift = faster) · double-click or Enter finishes · Backspace removes last point · Esc cancels',
    calibrate: 'Click two points a known distance apart — or click the Scale button in the status bar to type the sheet\'s stated ratio directly (1:100, 1/4" = 1\'-0"…).',
    mlength: 'Drag from one point to another to measure.',
    mpoly: 'Click points along the route · double-click or Enter finishes.',
    marea: 'Click corners of the area · double-click or Enter closes the shape.',
    count: 'Click to place a count mark. Pick the count group in the panel on the right.',
    line: 'Drag to draw a line. Shift constrains to 45°.',
    arrow: 'Drag to draw — the arrow head lands where you release. Shift constrains to 45°.',
    polyline: 'Click points · double-click or Enter finishes · Esc cancels.',
    rect: 'Drag a rectangle.',
    ellipse: 'Drag an ellipse.',
    cloud: 'Drag a revision cloud.',
    pen: 'Draw freehand.',
    highlight: 'Drag to highlight.',
    text: 'Click (or drag a box) then type. Click outside or Ctrl+Enter to commit.',
    callout: 'Press at the point you want the arrow, drag to where the note box goes, release, then type.',
    symbol: 'Click to place the selected symbol · R rotates · pick a different one in the Symbols tab.',
    penet: 'Click where the pipe passes through — marks the core/sleeve with its required hole size. Set Ø size, wall/floor and fire rating in the panel; the Takeoff tab totals them into a core-drill schedule.',
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
  let pendingTap = null;       // touch tap-in-progress for click-style tools
  let lastTap = null;          // for double-tap detection on the select tool
  let lastDownType = 'mouse';  // pointerType of the most recent pointerdown anywhere
  let tapConsumedAt = 0;       // when the pointerup path last ran a tap action
  let gestureAt = 0;           // when a second finger last landed
  let panConvertedAt = 0;      // when a touch turned into a one-finger pan
  const TAP_SLOP = 22;         // px of finger roll still counted as a tap
  const CLICK_TOOLS = { calibrate: 1, symbol: 1, count: 1, text: 1, penet: 1, photo: 1 };

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

  function snapPoint(p) {
    const thr = 9 / S().zoom;
    let best = null, bd = thr;
    for (const m of State.pageMarkups(S().page)) {
      if (!m.pts || !SNAP_TYPES.includes(m.type)) continue;
      for (const q of [m.pts[0], m.pts[m.pts.length - 1]]) {
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
    return `<text x="${p.x + 14 / z}" y="${p.y - 10 / z}" font-family="Arial" font-size="${fs}" font-weight="bold" fill="#1f6fd0" stroke="#fff" stroke-width="${fs * 0.28}" paint-order="stroke">${txt}</text>`;
  }

  function moveBy(m, dx, dy) {
    if (m.pts) for (const p of m.pts) { p.x += dx; p.y += dy; }
    if (m.x != null) { m.x += dx; m.y += dy; }
    if (m.anchor) { m.anchor.x += dx; m.anchor.y += dy; }
  }

  function windowDrag(onMove, onUp, onAbort) {
    dragging = true;
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      dragging = false;
      activeDragAbort = null;
    };
    const move = e => onMove(e);
    const up = e => { cleanup(); if (onUp) onUp(e); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    activeDragAbort = () => { cleanup(); if (onAbort) onAbort(); };
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
    }, null, null);
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
          let extras = p.snapped ? snapIndicator(p) : '';
          if (tool === 'mlength') extras += lenReadout([m.pts[0]], p);
          preview(m, extras);
          break;
        }
        case 'rect': case 'ellipse': case 'cloud': {
          const x = Math.min(p0.x, p.x), y = Math.min(p0.y, p.y);
          m = { ...base, type: tool, x, y, w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y), fill: d.fill, fillOpacity: d.fillOpacity, arcSize: d.arcSize };
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
      if ((tool === 'rect' || tool === 'ellipse' || tool === 'cloud') && (m.w < 3 || m.h < 3)) return;
      if ((tool === 'line' || tool === 'arrow' || tool === 'mlength') && Geo.polylineLength(m.pts) < 2) return;
      m.subject = m.subject || ({
        line: 'Line', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Ellipse', cloud: 'Revision Cloud',
        pen: 'Pen', highlight: 'Highlight', mlength: 'Length', callout: 'Callout',
      })[tool] || tool;
      const created = State.addMarkup(m);
      if (tool === 'callout') { State.select([created.id]); editText(created, true); }
      else State.select([created.id]);
    }, clearPreview /* abort: second finger arrived — discard, nothing committed */);
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
        Object.assign(base, { type: 'marea', subject: 'Area', showLabel: true, fill: d.fill, fillOpacity: d.fillOpacity });
      } else {
        Object.assign(base, { type: 'polyline', subject: 'Polyline' });
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
    const minPts = m.type === 'marea' ? 3 : 2;
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
      color: d.color, fontSize: d.fontSize, text: '', fill: 'none', border: false,
      lineWidth: 1.5, subject: 'Text',
    });
    State.select([m.id]);
    editText(m, true);
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
      if (additive) { State.select([id], true); return; }
      if (!S().selection.has(id)) State.select([id]);
      beginMoveDrag(p);
      return;
    }
    // empty space → marquee
    beginMarquee(e, p);
  }

  function beginMoveDrag(p0) {
    const ids = [...S().selection];
    if (!ids.length) return;
    let started = false;
    let last = p0;
    windowDrag(ev => {
      const p = Viewer.toPage(ev);
      if (!started) {
        if (Geo.dist(p0, p) * S().zoom < 3) return;
        State.pushUndo();
        started = true;
      }
      const dx = p.x - last.x, dy = p.y - last.y;
      last = p;
      for (const id of ids) {
        const m = State.getMarkup(id);
        if (m) moveBy(m, dx, dy);
      }
      Render.refresh(ids);
    }, () => {
      if (started) { State.touch(); State.emit('markups', { changed: ids }); }
    }, () => {
      if (started) State.undo();   // gesture abort: put the markups back
    });
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
        .filter(m => Geo.rectsIntersect(box, Geo.markupBounds(m)))
        .map(m => m.id);
      State.select(hits, additive);
    }, clearPreview);
  }

  /* ---- handle drags (vertex move / resize / callout anchor) ---- */

  function handleDown(e) {
    const h = e.target;
    const id = h.dataset.hid, kind = h.dataset.kind;
    const m = State.getMarkup(id);
    if (!m) return;
    e.stopPropagation();
    let started = false;
    windowDrag(ev => {
      let p = Viewer.toPage(ev);
      if (!started) { State.pushUndo(); started = true; }
      if (kind === 'pt') {
        const idx = Number(h.dataset.idx);
        const sp = snapPoint(p);
        const ref = m.pts[idx > 0 ? idx - 1 : (m.pts.length > 1 ? 1 : 0)];
        let c = sp.snapped ? sp : (ev.shiftKey && ref ? Geo.constrainAngle(ref, p, 45) : p);
        m.pts[idx].x = c.x; m.pts[idx].y = c.y;
      } else if (kind === 'anchor') {
        m.anchor.x = p.x; m.anchor.y = p.y;
      } else {
        resizeRect(m, kind, p, ev.shiftKey);
      }
      Render.refresh([id]);
    }, () => {
      if (started) { State.touch(); State.emit('markups', { changed: [id] }); }
    }, () => {
      if (started) State.undo();
    });
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
        pendingTap = { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId, moved: false };
        tapConsumedAt = 0;   // new gesture — lets the click fallback fire if pointerup dies
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
  }

  /** The tap action itself — shared by the pointerup path and the click fallback. */
  function runTapAction(tool, p, target) {
    tapConsumedAt = performance.now();
    if (POLY_TOOLS[tool]) {
      // tapping the last vertex again finishes the run (no double-click on touch)
      if (creating && creating.pts.length >= (creating.type === 'marea' ? 3 : 2)) {
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
    if (tap.moved) return;   // it became a pan, not a tap (gestures null pendingTap directly)
    runTapAction(S().tool, Viewer.toPage(e), e.target);
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
      beginTouchPan(e);
      return;
    }
    lastClient = { clientX: e.clientX, clientY: e.clientY };
    hoverPt = Viewer.toPage(e);
    if (creating) updatePolyPreview(hoverPt, e.shiftKey);
    else if (S().tool === 'calibrate') calibratePreview(hoverPt);
    else if (S().tool === 'symbol' && !dragging) symbolGhost(hoverPt);
    else if (S().tool === 'photo' && !dragging) photoGhost(hoverPt);
  }

  /** After the view pans under a stationary cursor, re-derive the hover point and previews. */
  function refreshHover(shift) {
    if (!lastClient) return;
    hoverPt = Viewer.toPage(lastClient);
    if (creating) updatePolyPreview(hoverPt, shift);
    else if (S().tool === 'calibrate') calibratePreview(hoverPt);
    else if (S().tool === 'symbol' && !dragging) symbolGhost(hoverPt);
    else if (S().tool === 'photo' && !dragging) photoGhost(hoverPt);
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
          const step = (e.shiftKey ? 10 : 1);
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          State.pushUndo();
          for (const id of sel) { const m = State.getMarkup(id); if (m) moveBy(m, dx, dy); }
          Render.refresh(sel);
          State.emit('markups', { changed: sel });
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
          State.pushUndo();
          const clones = [];
          for (const id of sel) {
            const m = State.getMarkup(id);
            if (!m) continue;
            const c = JSON.parse(JSON.stringify(m));
            c.id = State.newId();
            c.date = new Date().toISOString();
            moveBy(c, 14, 14);
            State.S.markups.push(c);
            clones.push(c.id);
          }
          State.emit('markups'); State.touch();
          State.select(clones);
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
    window.addEventListener('pointerup', onGlobalPointerUp);

    // touch bookkeeping: a second finger anywhere = view gesture → abort tool work
    const touchDown = e => {
      lastDownType = e.pointerType || 'mouse';
      if (e.pointerType !== 'touch') return;
      activeTouches.set(e.pointerId, performance.now());
      if (touchCount() === 2) {
        gestureAt = performance.now();
        pendingTap = null;
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
    const touchSync = e => { if (e.touches && e.touches.length === 0) activeTouches.clear(); };
    window.addEventListener('touchend', touchSync, true);
    window.addEventListener('touchcancel', touchSync, true);
    // an engine-initiated cancel ends the tap without running it
    o.addEventListener('pointercancel', e => {
      if (pendingTap && pendingTap.pointerId === e.pointerId) pendingTap = null;
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
      toolCursor();
      if (S().tool !== 'select') State.clearSelection();
      if (S().tool === 'photo' && !armedPhoto && S().pdf) photoInput.click();
      if (S().tool !== 'photo') armedPhoto = null;
    });
    toolCursor();
  }

  return { init, TOOL_HINTS, cancelCreation, editText, closeTextEditor, isDragging: () => dragging, placeDroppedPhoto };
})();
