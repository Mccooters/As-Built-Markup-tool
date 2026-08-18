/* ============ viewer.js — PDF.js viewing: pages, zoom, pan, thumbnails ============ */
'use strict';

const Viewer = (() => {

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const MAX_CANVAS_DIM = 8192;

  const el = {};
  let renderTask = null;
  let renderTimer = null;
  let spaceDown = false;
  const pageDims = {};   // pageNum -> {w, h} at scale 1 (PDF points)

  function init() {
    el.viewport = document.getElementById('viewport');
    el.wrap = document.getElementById('pageWrap');
    el.canvas = document.getElementById('pdfCanvas');
    el.overlay = document.getElementById('overlay');
    el.preview = document.getElementById('previewLayer');
    el.sel = document.getElementById('selLayer');
    el.edit = document.getElementById('editLayer');
    el.thumbPanel = document.getElementById('thumbPanel');
    el.thumbList = document.getElementById('thumbList');
    el.dropHint = document.getElementById('dropHint');

    // wheel zoom (Bluebeam-style: wheel zooms at cursor)
    el.viewport.addEventListener('wheel', e => {
      if (!State.S.pdf) return;
      e.preventDefault();
      const factor = Math.pow(1.0018, -e.deltaY);
      zoomAt(State.S.zoom * factor, e.clientX, e.clientY);
    }, { passive: false });

    // pan: middle button always; left button when pan tool or space held
    el.viewport.addEventListener('pointerdown', e => {
      const panBtn = e.button === 1 || (e.button === 0 && (State.S.tool === 'pan' || spaceDown));
      if (!panBtn || !State.S.pdf) return;
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      const sl = el.viewport.scrollLeft, st = el.viewport.scrollTop;
      const pid = e.pointerId;
      el.viewport.setPointerCapture(pid);
      const move = ev => {
        if (ev.pointerId !== pid) return;
        el.viewport.scrollLeft = sl - (ev.clientX - startX);
        el.viewport.scrollTop = st - (ev.clientY - startY);
      };
      const up = ev => {
        if (ev.pointerId !== pid) return;
        el.viewport.removeEventListener('pointermove', move);
        el.viewport.removeEventListener('pointerup', up);
        el.viewport.removeEventListener('pointercancel', up);
      };
      el.viewport.addEventListener('pointermove', move);
      el.viewport.addEventListener('pointerup', up);
      el.viewport.addEventListener('pointercancel', up);
    }, true);

    // native drag of selected label text / canvas would swallow pointer events mid-tool
    el.viewport.addEventListener('dragstart', e => e.preventDefault());

    // pinch zoom (two pointers)
    initPinch();

    window.addEventListener('keydown', e => { if (e.code === 'Space' && !isTyping(e)) { spaceDown = true; el.overlay.classList.add('cur-pan'); } });
    window.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; el.overlay.classList.remove('cur-pan'); } });
  }

  const isTyping = e => /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);

  /** Two-finger gesture: pinch zoom + pan together (one finger is left to the tools). */
  function initPinch() {
    const pts = new Map();   // pointerId -> {x, y, t}; ghost-proofed like tools.js
    const STALE = 3500;
    let startDist = 0, startZoom = 1, prevCenter = null;
    const prune = () => {
      const now = performance.now();
      for (const [id, p] of pts) if (now - p.t > STALE) pts.delete(id);
    };
    el.viewport.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      prune();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        startDist = Math.hypot(b.x - a.x, b.y - a.y);
        startZoom = State.S.zoom;
        prevCenter = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
    }, true);
    el.viewport.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
      if (pts.size === 2 && startDist > 0) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        if (prevCenter) {
          el.viewport.scrollLeft -= cx - prevCenter.x;
          el.viewport.scrollTop -= cy - prevCenter.y;
        }
        prevCenter = { x: cx, y: cy };
        zoomAt(startZoom * d / startDist, cx, cy);
      }
    }, true);
    const drop = e => {
      pts.delete(e.pointerId);
      if (pts.size < 2) { startDist = 0; prevCenter = null; }
    };
    el.viewport.addEventListener('pointerup', drop, true);
    el.viewport.addEventListener('pointercancel', drop, true);
    const allUp = e => {
      if (e.touches && e.touches.length === 0) { pts.clear(); startDist = 0; prevCenter = null; }
    };
    window.addEventListener('touchend', allUp, true);
    window.addEventListener('touchcancel', allUp, true);
  }

  /* ================= document ================= */

  async function openPdf(bytes, name) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // keep an untransferred copy — pdf.js may transfer the buffer to the worker
    const keep = data.slice();
    const doc = await pdfjsLib.getDocument({ data }).promise;

    State.resetDoc();
    const S = State.S;
    S.pdf = doc;
    S.pdfBytes = keep;
    S.fileName = name || 'drawing.pdf';
    S.pageCount = doc.numPages;
    S.page = 1;
    S.zoom = 1;
    S.fingerprint = (doc.fingerprints && doc.fingerprints[0]) || doc.fingerprint || '';
    Object.keys(pageDims).forEach(k => delete pageDims[k]);

    el.dropHint.classList.add('hidden');
    el.wrap.classList.remove('hidden');

    State.emit('doc');
    await renderPage();
    fitPage();
    buildThumbs();
  }

  async function getPageDims(n) {
    if (pageDims[n]) return pageDims[n];
    const page = await State.S.pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    pageDims[n] = { w: vp.width, h: vp.height };
    return pageDims[n];
  }

  /* ================= rendering ================= */

  async function renderPage() {
    const S = State.S;
    if (!S.pdf) return;
    const pageNum = S.page;
    const page = await S.pdf.getPage(pageNum);
    const vp1 = page.getViewport({ scale: 1 });
    S.pageW = vp1.width; S.pageH = vp1.height;
    pageDims[pageNum] = { w: vp1.width, h: vp1.height };

    layout();               // size wrap/canvas CSS + svg layers immediately

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let renderScale = S.zoom * dpr;
    const maxDim = Math.max(vp1.width, vp1.height);
    if (maxDim * renderScale > MAX_CANVAS_DIM) renderScale = MAX_CANVAS_DIM / maxDim;

    const vp = page.getViewport({ scale: renderScale });
    if (renderTask) { try { renderTask.cancel(); } catch (_) {} }
    const canvas = el.canvas;
    // render offscreen then blit, so cancelled renders don't blank the view
    const off = document.createElement('canvas');
    off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
    const task = page.render({ canvasContext: off.getContext('2d', { alpha: false }), viewport: vp });
    renderTask = task;
    try {
      await task.promise;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      throw err;
    }
    if (task !== renderTask || State.S.page !== pageNum) return;
    canvas.width = off.width; canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
    layout();
  }

  /** Apply current zoom to wrap / canvas CSS / svg layers. */
  function layout() {
    const S = State.S;
    const w = S.pageW * S.zoom, h = S.pageH * S.zoom;
    el.wrap.style.width = w + 'px';
    el.wrap.style.height = h + 'px';
    el.canvas.style.width = w + 'px';
    el.canvas.style.height = h + 'px';
    for (const svg of [el.overlay, el.preview, el.sel]) {
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      svg.setAttribute('viewBox', `0 0 ${S.pageW} ${S.pageH}`);
    }
  }

  const scheduleRender = () => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => renderPage(), 130);
  };

  /* ================= zoom / navigation ================= */

  function setZoom(z, anchor) {
    const S = State.S;
    z = Math.max(0.08, Math.min(12, z));
    if (Math.abs(z - S.zoom) < 1e-4) return;

    const vp = el.viewport;
    const rect = vp.getBoundingClientRect();
    const ax = anchor ? anchor.x - rect.left : rect.width / 2;
    const ay = anchor ? anchor.y - rect.top : rect.height / 2;
    // content coords under anchor before zoom
    const wrapRect = el.wrap.getBoundingClientRect();
    const cx = (anchor ? anchor.x - wrapRect.left : vp.scrollLeft + ax - el.wrap.offsetLeft) / S.zoom;
    const cy = (anchor ? anchor.y - wrapRect.top : vp.scrollTop + ay - el.wrap.offsetTop) / S.zoom;

    S.zoom = z;
    layout();
    // put the same content point back under the anchor
    vp.scrollLeft = el.wrap.offsetLeft + cx * z - ax;
    vp.scrollTop = el.wrap.offsetTop + cy * z - ay;

    State.emit('zoom');
    scheduleRender();
  }

  const zoomAt = (z, clientX, clientY) => setZoom(z, { x: clientX, y: clientY });
  const zoomIn = () => setZoom(State.S.zoom * 1.25);
  const zoomOut = () => setZoom(State.S.zoom / 1.25);

  function fitPage() {
    const S = State.S;
    if (!S.pageW) return;
    const vp = el.viewport.getBoundingClientRect();
    const z = Math.min((vp.width - 60) / S.pageW, (vp.height - 60) / S.pageH);
    setZoom(z);
    el.viewport.scrollLeft = 0; el.viewport.scrollTop = 0;
  }
  function fitWidth() {
    const S = State.S;
    if (!S.pageW) return;
    setZoom((el.viewport.getBoundingClientRect().width - 60) / S.pageW);
    el.viewport.scrollLeft = 0;
  }

  async function gotoPage(n, opts = {}) {
    const S = State.S;
    n = Math.max(1, Math.min(S.pageCount, n));
    if (n === S.page && !opts.force) return;
    S.page = n;
    State.emit('page');
    await renderPage();
    if (!opts.keepScroll) { el.viewport.scrollTop = 0; }
  }

  /* ================= thumbnails ================= */

  async function buildThumbs() {
    const S = State.S;
    el.thumbList.innerHTML = '';
    const n = Math.min(S.pageCount, 100);
    const cells = [];
    for (let i = 1; i <= n; i++) {
      const div = document.createElement('div');
      div.className = 'thumb' + (i === S.page ? ' active' : '');
      div.dataset.page = i;
      div.innerHTML = `<span class="thumb-num">${i}</span>`;
      div.addEventListener('click', () => gotoPage(Number(div.dataset.page)));
      el.thumbList.appendChild(div);
      cells.push(div);
    }
    const doc = S.pdf;
    for (const div of cells) {
      if (State.S.pdf !== doc) return; // doc changed mid-build
      const i = Number(div.dataset.page);
      try {
        const page = await doc.getPage(i);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = 116 / vp1.width;
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
        div.prepend(c);
      } catch (_) { /* thumbnail failures are non-fatal */ }
    }
  }

  function syncThumbActive() {
    for (const t of el.thumbList.children) {
      t.classList.toggle('active', Number(t.dataset.page) === State.S.page);
    }
  }

  /* ================= coordinate mapping ================= */

  /** Client (mouse) coords → page units. */
  function toPage(e) {
    const r = el.overlay.getBoundingClientRect();
    return { x: (e.clientX - r.left) / State.S.zoom, y: (e.clientY - r.top) / State.S.zoom };
  }

  /* ================= flash / jump-to markup ================= */

  async function flashMarkup(m) {
    if (m.page !== State.S.page) await gotoPage(m.page);
    const b = Geo.inflate(Geo.markupBounds(m), 10);
    const S = State.S;
    // ensure visible: center bounds in viewport
    const vp = el.viewport.getBoundingClientRect();
    el.viewport.scrollLeft = el.wrap.offsetLeft + (b.x + b.w / 2) * S.zoom - vp.width / 2;
    el.viewport.scrollTop = el.wrap.offsetTop + (b.y + b.h / 2) * S.zoom - vp.height / 2;
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', b.x); r.setAttribute('y', b.y);
    r.setAttribute('width', b.w); r.setAttribute('height', b.h);
    r.setAttribute('fill', 'none'); r.setAttribute('stroke', '#ffb300');
    r.setAttribute('stroke-width', 3 / S.zoom); r.setAttribute('rx', 4);
    r.classList.add('flash-rect');
    el.sel.appendChild(r);
    setTimeout(() => r.remove(), 1600);
  }

  const isSpacePan = () => spaceDown;

  return {
    init, openPdf, renderPage, layout, scheduleRender,
    setZoom, zoomAt, zoomIn, zoomOut, fitPage, fitWidth,
    gotoPage, buildThumbs, syncThumbActive, toPage, flashMarkup, getPageDims, isSpacePan,
    el,
  };
})();
