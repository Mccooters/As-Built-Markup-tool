/* ============ export.js — flattened PDF export + sample drawing generator ============ */
'use strict';

const Export = (() => {

  /* ================= flattened PDF ================= */

  // Canvas limits: iOS caps canvas area hard (silently blank above it)
  const IS_TOUCH_DEVICE = (navigator.maxTouchPoints || 0) > 1;
  const MAX_AREA = IS_TOUCH_DEVICE ? 14e6 : 60e6;
  const MAX_DIM = 8100;

  const layerScale = (w, h, target = 3) =>
    Math.max(1, Math.min(target, Math.sqrt(MAX_AREA / (w * h)), MAX_DIM / Math.max(w, h)));

  /**
   * Export keeps the ORIGINAL pages untouched (vector linework stays razor
   * sharp) and stamps a transparent high-res raster of the markups over each
   * page. Falls back to full-page rasterization only when the source PDF
   * cannot be reloaded (e.g. encrypted).
   */
  async function exportFlattenedPdf() {
    const S = State.S;
    if (!S.pdf) { App.toast('Open a drawing first.', 'warn'); return; }

    const progress = App.progress('Exporting as-built PDF…');
    try {
      let out = null;
      try {
        out = await PDFLib.PDFDocument.load(S.pdfBytes, { ignoreEncryption: true });
        if (out.getPageCount() !== S.pageCount) out = null;
      } catch (_) { out = null; }

      if (out) await overlayExport(out, progress);
      else await rasterExport(progress);
    } catch (err) {
      console.error(err);
      progress.close();
      App.toast('Export failed: ' + (err.message || err), 'err', 8000);
    }
  }

  /** Anchor + rotation that make a full-page stamp match the DISPLAYED orientation. */
  function pageStampFrame(page) {
    const box = page.getCropBox();
    const R = ((page.getRotation().angle % 360) + 360) % 360;
    const sideways = R === 90 || R === 270;
    const vpW = sideways ? box.height : box.width;   // displayed size
    const vpH = sideways ? box.width : box.height;
    let x = box.x, y = box.y;
    if (R === 90) x = box.x + box.width;
    else if (R === 180) { x = box.x + box.width; y = box.y + box.height; }
    else if (R === 270) y = box.y + box.height;
    return { box, R, vpW, vpH, x, y };
  }

  async function overlayExport(out, progress) {
    const S = State.S;
    const n = S.pageCount;

    for (let p = 1; p <= n; p++) {
      const markups = State.pageMarkups(p);
      if (!markups.length) continue;
      progress.set(((p - 1) / n) * 100, `Marking up page ${p} of ${n}…`);

      const page = out.getPage(p - 1);
      const f = pageStampFrame(page);

      // photos embed natively at their stored resolution (upright pages)
      const nativePhotos = f.R === 0
        ? markups.filter(m => m.type === 'photo' && S.images[m.imgId])
        : [];
      for (const ph of nativePhotos) {
        const src = S.images[ph.imgId];
        const img = /^data:image\/png/.test(src) ? await out.embedPng(src) : await out.embedJpg(src);
        page.drawImage(img, {
          x: f.box.x + ph.x,
          y: f.box.y + f.box.height - ph.y - ph.h,
          width: ph.w, height: ph.h,
        });
      }

      // everything else → transparent high-res layer
      const s = layerScale(f.vpW, f.vpH);
      const pxW = Math.round(f.vpW * s), pxH = Math.round(f.vpH * s);
      const svgStr = pageSvg(markups, f.vpW, f.vpH, pxW, pxH, { noPhotoImage: f.R === 0 });
      const canvas = await svgToCanvas(svgStr, pxW, pxH);
      const png = await out.embedPng(canvas.toDataURL('image/png'));
      page.drawImage(png, {
        x: f.x, y: f.y, width: f.vpW, height: f.vpH,
        rotate: PDFLib.degrees(f.R),
      });
    }

    await finishExport(out, progress,
      'As-built PDF exported — original drawing untouched (full vector quality), markups stamped on top.');
  }

  /** Fallback: rasterize whole pages (only when the source PDF can't be reloaded). */
  async function rasterExport(progress) {
    const S = State.S;
    const out = await PDFLib.PDFDocument.create();
    const n = S.pageCount;

    for (let p = 1; p <= n; p++) {
      progress.set(((p - 1) / n) * 100, `Rendering page ${p} of ${n}…`);
      const page = await S.pdf.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = layerScale(vp1.width, vp1.height);
      const vp = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      const markups = State.pageMarkups(p);
      if (markups.length) {
        const svgStr = pageSvg(markups, vp1.width, vp1.height, canvas.width, canvas.height);
        const layer = await svgToCanvas(svgStr, canvas.width, canvas.height);
        ctx.drawImage(layer, 0, 0);
      }

      const jpeg = await out.embedJpg(canvas.toDataURL('image/jpeg', 0.87));
      const outPage = out.addPage([vp1.width, vp1.height]);
      outPage.drawImage(jpeg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    }

    await finishExport(out, progress,
      'PDF exported (rasterized — the source PDF could not be reloaded for vector output).');
  }

  async function finishExport(out, progress, message) {
    progress.set(97, 'Writing PDF…');
    const bytes = await out.save();
    const base = (State.S.fileName || 'drawing').replace(/\.pdf$/i, '');
    App.download(new Blob([bytes], { type: 'application/pdf' }), base + ' (as-built).pdf');
    progress.close();
    App.toast(message, 'ok');
  }

  function pageSvg(markups, pageW, pageH, pxW, pxH, opts) {
    const holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const m of markups) holder.appendChild(Render.buildMarkupEl(m, opts));
    const inner = new XMLSerializer().serializeToString(holder)
      .replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pageW} ${pageH}" width="${pxW}" height="${pxH}">${inner}</svg>`;
  }

  /** Rasterize an SVG string onto a fresh TRANSPARENT canvas. */
  function svgToCanvas(svgStr, w, h) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG rasterization failed')); };
      img.src = url;
    });
  }

  /* ================= sample plant floor plan ================= */

  async function generateSample() {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    // fixed metadata → byte-stable output → stable fingerprint → autosave restore works
    doc.setTitle('Sample Plant — Compressed Air Plan');
    doc.setProducer('AirMark sample generator');
    doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
    doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
    const W = 2592, H = 1728;                    // 36in × 24in ARCH D landscape
    const page = doc.addPage([W, H]);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    const ink = rgb(0.15, 0.17, 0.2);
    const dim = rgb(0.45, 0.48, 0.52);
    const faint = rgb(0.72, 0.75, 0.78);

    const Y = t => H - t;                        // think top-down
    const line = (x1, y1, x2, y2, th = 1.4, color = ink, dash) =>
      page.drawLine({ start: { x: x1, y: Y(y1) }, end: { x: x2, y: Y(y2) }, thickness: th, color, dashArray: dash });
    const rect = (x, y, w, h, th = 1.4, color = ink) =>
      page.drawRectangle({ x, y: Y(y + h), width: w, height: h, borderWidth: th, borderColor: color, color: undefined });
    const text = (s, x, y, size = 18, font = helv, color = ink) =>
      page.drawText(s, { x, y: Y(y), size, font, color });
    const ctext = (s, cx, y, size = 18, font = helv, color = ink) =>
      text(s, cx - font.widthOfTextAtSize(s, size) / 2, y, size, font, color);

    // ---- sheet border & title block ----
    rect(36, 36, W - 72, H - 72, 2.5);
    rect(W - 700, H - 210, 664, 174, 2);
    line(W - 700, H - 158, W - 36, H - 158, 1.2);
    line(W - 700, H - 110, W - 36, H - 110, 1.2);
    line(W - 380, H - 110, W - 380, H - 36, 1.2);
    text('ACME MANUFACTURING CO. — PLANT 2', W - 682, H - 178, 22, bold);
    text('COMPRESSED AIR PIPING PLAN', W - 682, H - 132, 20, bold);
    text('SCALE: 1/4" = 1\'-0"', W - 682, H - 84, 16);
    text('SHEET', W - 360, H - 84, 12, helv, dim);
    text('M-101', W - 360, H - 56, 26, bold);
    text('AS-BUILT REFERENCE — SAMPLE DRAWING', W - 682, H - 58, 12, helv, dim);

    // ---- column grid: A–F × 1–4, 25 ft bays at 1/4" scale (25 ft = 450 pt) ----
    const gx0 = 216, gy0 = 190, bay = 450, rows = 3, cols = 5;
    for (let c = 0; c <= cols; c++) {
      const x = gx0 + c * bay;
      line(x, gy0 - 60, x, gy0 + rows * bay + 60, 0.8, faint, [14, 10]);
      page.drawCircle({ x, y: Y(gy0 - 88), size: 26, borderWidth: 1.4, borderColor: dim });
      ctext(String.fromCharCode(65 + c), x, gy0 - 79, 22, bold, dim);
    }
    for (let r = 0; r <= rows; r++) {
      const y = gy0 + r * bay;
      line(gx0 - 60, y, gx0 + cols * bay + 60, y, 0.8, faint, [14, 10]);
      page.drawCircle({ x: gx0 - 88, y: Y(y), size: 26, borderWidth: 1.4, borderColor: dim });
      ctext(String(r + 1), gx0 - 88, y + 8, 22, bold, dim);
    }

    // ---- building outline (125 ft × 75 ft) ----
    const bx = gx0, by = gy0, bw = cols * bay, bh = rows * bay;
    rect(bx, by, bw, bh, 5);

    // ---- interior walls ----
    // compressor room top-left (25 × 25 ft)
    line(bx + bay, by, bx + bay, by + bay, 3.2);
    line(bx, by + bay, bx + bay, by + bay, 3.2);
    // maintenance next to it
    line(bx + 2 * bay, by, bx + 2 * bay, by + bay * 0.75, 3.2);
    line(bx + bay, by + bay * 0.75, bx + 2 * bay, by + bay * 0.75, 3.2);
    // office strip bottom-left
    line(bx, by + bh - bay * 0.6, bx + bay * 1.5, by + bh - bay * 0.6, 3.2);
    line(bx + bay * 1.5, by + bh - bay * 0.6, bx + bay * 1.5, by + bh, 3.2);
    // shipping right end
    line(bx + bw - bay, by + bay, bx + bw, by + bay, 3.2);
    line(bx + bw - bay, by, bx + bw - bay, by + bay, 3.2);

    // door openings (gaps drawn as white-ish over walls → draw swing arcs instead)
    const door = (x, y, r, a0) => {
      page.drawLine({ start: { x, y: Y(y) }, end: { x: x + r * Math.cos(a0), y: Y(y) + r * Math.sin(a0) }, thickness: 1.2, color: dim });
    };
    door(bx + bay - 90, by + bay, 80, Math.PI / 2);
    door(bx + bay * 1.5, by + bh - bay * 0.6 + 90, 80, 0);

    // room labels
    text('COMPRESSOR ROOM', bx + 40, by + 60, 22, bold);
    text('MAINTENANCE', bx + bay + 40, by + 60, 22, bold);
    text('PRODUCTION FLOOR', bx + bay + 60, by + bay + 480, 30, bold, dim);
    text('ASSEMBLY', bx + 3 * bay + 60, by + 340, 24, bold, dim);
    text('SHIPPING', bx + bw - bay + 60, by + 60, 22, bold);
    text('OFFICES', bx + 60, by + bh - bay * 0.6 + 70, 22, bold);

    // ---- equipment in compressor room ----
    rect(bx + 50, by + bay - 320, 200, 120, 2);
    text('AC-1 75HP', bx + 66, by + bay - 268, 15, bold);
    text('COMPRESSOR', bx + 66, by + bay - 246, 12);
    page.drawCircle({ x: bx + 340, y: Y(by + bay - 250), size: 62, borderWidth: 2, borderColor: ink });
    ctext('RCVR', bx + 340, by + bay - 256, 13, bold);
    ctext('400 GAL', bx + 340, by + bay - 238, 11);
    rect(bx + 60, by + bay - 160, 130, 90, 2);
    text('DRYER', bx + 76, by + bay - 116, 13, bold);

    // ---- machines on the floor ----
    const machine = (x, y, w, h, name) => {
      rect(x, y, w, h, 2);
      text(name, x + 14, y + h / 2 + 6, 14, bold);
    };
    machine(bx + bay + 120, by + bay + 120, 260, 150, 'CNC-101');
    machine(bx + bay + 120, by + bay + 420, 260, 150, 'CNC-102');
    machine(bx + bay + 120, by + bay + 720, 260, 150, 'CNC-103');
    machine(bx + 2 * bay + 240, by + bay + 180, 300, 170, 'PRESS-1');
    machine(bx + 2 * bay + 240, by + bay + 560, 300, 170, 'PRESS-2');
    machine(bx + 3 * bay + 200, by + bay + 200, 240, 140, 'LATHE-1');
    machine(bx + 3 * bay + 200, by + bay + 520, 240, 140, 'GRIND-1');
    machine(bx + 3 * bay + 200, by + bay + 820, 240, 140, 'WELD-1');
    machine(bx + 4 * bay + 140, by + bay + 300, 240, 140, 'TEST-1');
    machine(bx + 4 * bay + 140, by + bay + 660, 240, 140, 'PACK-1');
    machine(bx + bay + 620, by + 220, 220, 130, 'MILL-1');

    // workbench row along bottom
    for (let i = 0; i < 4; i++) {
      rect(bx + bay * 1.6 + i * 380, by + bh - 200, 280, 110, 1.6);
      text('BENCH-' + (i + 1), bx + bay * 1.6 + i * 380 + 20, by + bh - 140, 13);
    }

    // ---- north arrow ----
    const nx = 150, ny = 150;
    page.drawCircle({ x: nx, y: Y(ny), size: 55, borderWidth: 2, borderColor: ink });
    line(nx, ny + 40, nx, ny - 40, 2.4);
    line(nx, ny - 40, nx - 14, ny - 12, 2.4);
    line(nx, ny - 40, nx + 14, ny - 12, 2.4);
    ctext('N', nx, ny - 62, 24, bold);

    // dimension note
    text('125\'-0" × 75\'-0" CLEAR', bx + bw / 2 - 120, by + bh + 66, 16, helv, dim);

    return doc.save({ useObjectStreams: false });
  }

  async function openSample() {
    const bytes = await generateSample();
    await Viewer.openPdf(new Uint8Array(bytes), 'Sample Plant — Compressed Air Plan.pdf');
    // the sample is drawn at 1/4" = 1'-0" — pre-calibrate so measurements work immediately
    if (!State.S.markups.length && !State.S.defaultScale) {
      State.S.defaultScale = { ftPerUnit: 4 / 72 };
      State.clearHistory();
      State.emit('scale');
      App.toast('Sample loaded, scale pre-set to 1/4" = 1\'-0". Try the Pipe tool (P) — click along a route, double-click to finish.', 'ok', 9000);
    }
  }

  return { exportFlattenedPdf, generateSample, openSample };
})();
