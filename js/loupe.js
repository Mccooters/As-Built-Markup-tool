/* ============ loupe.js — touch magnifier for precise pointing ============
 *
 * A finger hides the exact spot it points at. While a finger is down with a
 * measuring / drawing tool, held on a tap-style tool, or dragging a vertex or
 * resize handle, an offset circle above the fingertip shows the drawing under
 * it at 2.5×: the PDF raster plus live <use> instances of the markup and
 * rubber-band layers (so the run being drawn and its length readout appear
 * too), with a reticle on the exact point. It appears after a short hold or
 * the first movement — rapid taps never see it — and goes when the finger
 * lifts, a second finger lands (view gesture) or the pointer is cancelled.
 * Mouse and pencil pointers never get one.
 */
'use strict';

const Loupe = (() => {
  const D = 150;            // diameter, CSS px
  const R = D / 2;
  const K = 2.5;            // magnification over the current screen zoom
  const GAP = 34;           // clearance between the fingertip and the loupe's edge
  const HOLD_MS = 180;      // a still finger waits this long before the loupe shows
  const MOVE_PX = 4;        // …or it shows as soon as the finger moves this far

  let root = null, cv = null, ctx = null, g = null, label = null;
  let pid = null;           // pointerId being followed
  let timer = 0;
  let start = null, last = null;
  let shown = false;

  function build() {
    root = document.createElement('div');
    root.id = 'loupe';
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML =
      '<canvas></canvas>' +
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g>' +
        '<use href="#overlay" xlink:href="#overlay"/>' +
        '<use href="#previewLayer" xlink:href="#previewLayer"/>' +
      '</g></svg>' +
      '<div class="loupe-cross"></div><div class="loupe-ring"></div><div class="loupe-label" hidden></div>';
    document.body.appendChild(root);
    cv = root.querySelector('canvas');
    ctx = cv.getContext('2d');
    g = root.querySelector('g');
    label = root.querySelector('.loupe-label');
  }

  /** Live readout (running length) shown as a pill inside the loupe. */
  function setLabel(text) {
    if (!label) return;
    label.textContent = text || '';
    label.hidden = !text;
  }

  /** Start following a touch pointer (no-op for mouse / pen). */
  function begin(e) {
    if (!e || e.pointerType !== 'touch') return;
    if (!root) build();
    end();
    setLabel('');
    pid = e.pointerId;
    start = { x: e.clientX, y: e.clientY };
    last = start;
    timer = setTimeout(() => { if (pid !== null && !shown) show(); }, HOLD_MS);
  }

  /** Pointer moved — show on the first real movement, then keep the loupe on the finger. */
  function track(e) {
    if (pid === null || e.pointerId !== pid) return;
    last = { x: e.clientX, y: e.clientY };
    if (!shown) {
      if (Math.hypot(last.x - start.x, last.y - start.y) >= MOVE_PX) show();
      return;
    }
    draw();
  }

  function show() {
    clearTimeout(timer); timer = 0;
    shown = true;
    root.hidden = false;
    draw();
  }

  /** Finger lifted / cancelled / joined by a second finger / tool changed. */
  function end() {
    clearTimeout(timer); timer = 0;
    pid = null;
    shown = false;
    if (root) root.hidden = true;
    setLabel('');
  }

  function draw() {
    if (!shown || !last || !State.S.pdf) return;
    const S = State.S;
    if (!S.pageW || !S.pageH || !S.zoom) return;
    // ONE mapping: the page point under the finger, computed exactly as the
    // tools compute the point they place. Both layers below are centred on it
    // in page units, so whatever an engine reports for on-screen boxes, what
    // the loupe shows under the reticle is what lands on the sheet.
    const P = Viewer.toPage({ clientX: last.x, clientY: last.y });

    // PDF raster: the page canvas always holds the whole page, so page pt →
    // canvas px is simply its pixel size over the page size, per axis. Sample a
    // (D/K)/zoom-pt window around P (clipped by hand — partial source rects are
    // not handled the same way in every engine).
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const W = Math.round(D * dpr);
    if (cv.width !== W) { cv.width = W; cv.height = W; }
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, W);
    const src = Viewer.el.canvas;
    if (src.width && src.height) {
      const kx = src.width / S.pageW, ky = src.height / S.pageH;   // canvas px per page pt
      const halfPt = (R / K) / S.zoom;                             // half the window, in page pt
      const sw = 2 * halfPt * kx, sh = 2 * halfPt * ky;
      const sx0 = (P.x - halfPt) * kx, sy0 = (P.y - halfPt) * ky;
      const scaleX = W / sw, scaleY = W / sh;                      // canvas px → loupe device px
      const cx0 = Math.max(0, sx0), cy0 = Math.max(0, sy0);
      const cx1 = Math.min(src.width, sx0 + sw), cy1 = Math.min(src.height, sy0 + sh);
      if (cx1 > cx0 && cy1 > cy0) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, cx0, cy0, cx1 - cx0, cy1 - cy0,
          (cx0 - sx0) * scaleX, (cy0 - sy0) * scaleY, (cx1 - cx0) * scaleX, (cy1 - cy0) * scaleY);
      }
    }

    // markup + rubber-band layers: the <use> instances follow the originals live;
    // their user unit is the overlay's CSS px (page pt × zoom), so only the
    // transform moves — page point P lands on the loupe's centre, magnified K×
    const px = P.x * S.zoom, py = P.y * S.zoom;
    g.setAttribute('transform', `translate(${R - px * K} ${R - py * K}) scale(${K})`);

    // centred above the fingertip; flips below it near the top of the view
    const vp = Viewer.el.viewport.getBoundingClientRect();
    let left = last.x - R, top = last.y - GAP - D;
    if (top < vp.top + 2) top = last.y + GAP + 14;
    left = Math.max(vp.left + 2, Math.min(vp.right - D - 2, left));
    root.style.left = left + 'px';
    root.style.top = top + 'px';
  }

  return { begin, track, end, setLabel, active: () => shown };
})();
