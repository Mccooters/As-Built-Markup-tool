/* ============ tools.js — pointer state machine for drawing, selecting, editing ============ */
'use strict';

const Tools = (() => {

  const SNAP_TYPES = ['pipe', 'mpoly', 'mlength', 'line', 'polyline', 'arrow'];
  const POLY_TOOLS = { pipe: 1, polyline: 1, mpoly: 1, marea: 1 };
  const DRAG_TOOLS = { line: 1, arrow: 1, mlength: 1, rect: 1, ellipse: 1, cloud: 1, pen: 1, highlight: 1, callout: 1 };

  const TOOL_HINTS = {
    select: 'Click to select · drag to move · Shift-click adds · drag empty space for marquee · double-click text to edit · Del deletes',
    pan: 'Drag to pan. Mouse wheel zooms.',
    pipe: 'Click points along the pipe route · double-click or Enter finishes · Shift = free angle · Backspace removes last point · Esc cancels',
    calibrate: 'Click two points a known distance apart (a door, grid line, or dimension string works well).',
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
  };

  let creating = null;     // multi-click creation in progress
  let dragging = false;    // any active drag (suppress selection redraw churn)
  let hoverPt = null;      // last pointer position in page units
  let editingTextarea = null;

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

  /** Ortho/45° constraint for the active tool given the previous point. */
  function constrain(prev, p, shift) {
    const t = S().tool;
    let ortho = false;
    if (t === 'pipe') ortho = D().orthoPipe !== false ? !shift : shift;
    else ortho = shift;
    return ortho ? Geo.constrainAngle(prev, p, 45) : p;
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

  function windowDrag(onMove, onUp) {
    dragging = true;
    const move = e => onMove(e);
    const up = e => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      dragging = false;
      if (onUp) onUp(e);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
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
    });
  }

  /* ================= creation: multi-click poly tools ================= */

  function polyClick(e, p) {
    const tool = S().tool;
    const d = D();
    let sp = snapPoint(p);
    if (creating) {
      const prev = creating.pts[creating.pts.length - 1];
      const c = constrain(prev, sp.snapped ? sp : p, e.shiftKey);
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
          lineWidth: Math.max(d.lineWidth, 3),
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
    const c = constrain(prev, sp.snapped ? sp : p, shift);
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
    });
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

    if (tool === 'select') { selectDown(e, p); return; }
    if (POLY_TOOLS[tool]) { polyClick(e, p); return; }
    if (DRAG_TOOLS[tool]) { beginDragCreate(e, p); return; }
    if (tool === 'calibrate') { calibrateClick(p); return; }
    if (tool === 'symbol') { placeSymbol(p); return; }
    if (tool === 'count') { placeCount(p); return; }
    if (tool === 'text') { placeText(p); return; }
  }

  function onOverlayMove(e) {
    if (!S().pdf) return;
    hoverPt = Viewer.toPage(e);
    if (creating) updatePolyPreview(hoverPt, e.shiftKey);
    else if (S().tool === 'calibrate') calibratePreview(hoverPt);
    else if (S().tool === 'symbol' && !dragging) symbolGhost(hoverPt);
  }

  function onOverlayDblClick(e) {
    if (S().tool === 'select') {
      const g = e.target.closest && e.target.closest('g[data-id]');
      if (g) {
        const m = State.getMarkup(g.dataset.id);
        if (m && (m.type === 'text' || m.type === 'callout')) { State.select([m.id]); editText(m, false); }
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
        if (!sel.length || S().tool !== 'select') return;
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
    o.addEventListener('dblclick', onOverlayDblClick);
    Viewer.el.sel.addEventListener('pointerdown', e => {
      if (e.target.classList && e.target.classList.contains('handle')) handleDown(e);
    });
    window.addEventListener('keydown', onKeyDown);

    State.on('tool', () => {
      cancelCreation();
      calPts = [];
      closeTextEditor(true);
      clearPreview();
      toolCursor();
      if (S().tool !== 'select') State.clearSelection();
    });
    toolCursor();
  }

  return { init, TOOL_HINTS, cancelCreation, editText, closeTextEditor, isDragging: () => dragging };
})();
