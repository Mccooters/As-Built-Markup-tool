/* ============ export.js — vector-quality PDF export + sample drawing generator ============
 *
 * Export philosophy: the ORIGINAL pages pass through untouched (their vector
 * linework and text stay perfect), and the markups are drawn on top as native
 * PDF vector geometry — paths, circles and embedded-font text — so they are
 * exactly as crisp as the drawing at any zoom. Photos embed as images at their
 * stored resolution. Only symbol glyphs (SVG art) rasterize, and those become
 * tiny per-symbol stamps at very high scale rather than a page-wide layer.
 * Any markup the vector renderer cannot reproduce falls back to its own
 * high-res mini stamp, so nothing ever goes missing from an export.
 */
'use strict';

const Export = (() => {

  /* ================= canvas limits ================= */

  // iOS caps canvas area hard (silently blank above it)
  const IS_TOUCH_DEVICE = (navigator.maxTouchPoints || 0) > 1;
  const MAX_AREA = IS_TOUCH_DEVICE ? 14e6 : 60e6;
  const MAX_DIM = 8100;

  const layerScale = (w, h, target = 3) =>
    Math.max(1, Math.min(target, Math.sqrt(MAX_AREA / (w * h)), MAX_DIM / Math.max(w, h)));

  /* ================= entry point ================= */

  /**
   * opts: { dayMode, day, banner, fileSuffix } — defaults follow the live view,
   * so with Day Mode on the export shows earlier days grayed exactly like the
   * screen. The Daily Report dialog passes an explicit day + banner.
   */
  async function exportFlattenedPdf(opts) {
    const S = State.S;
    if (!S.pdf) { App.toast('Open a drawing first.', 'warn'); return; }
    const o = Object.assign({ dayMode: S.dayMode, day: S.workDay, banner: null, fileSuffix: ' (as-built)' }, opts || {});

    const progress = App.progress('Exporting as-built PDF…');
    try {
      let out = null;
      try {
        out = await PDFLib.PDFDocument.load(S.pdfBytes, { ignoreEncryption: true });
        if (out.getPageCount() !== S.pageCount) out = null;
      } catch (_) { out = null; }

      if (out) await overlayExport(out, progress, o);
      else await rasterExport(progress, o);
    } catch (err) {
      console.error(err);
      progress.close();
      App.toast('Export failed: ' + (err.message || err), 'err', 8000);
    }
  }

  /* ================= page frame: displayed coords ⇄ page coords ================= */

  /**
   * A frame maps DISPLAYED coordinates (what the app shows: origin top-left,
   * y-down, rotation applied — the space all markups live in) onto the page's
   * raw coordinate system, for any /Rotate value.
   */
  function makeFrame(page) {
    const box = page.getCropBox();
    const R = ((page.getRotation().angle % 360) + 360) % 360;
    const sideways = R === 90 || R === 270;
    const vpW = sideways ? box.height : box.width;
    const vpH = sideways ? box.width : box.height;
    const bx = box.x, by = box.y, bw = box.width, bh = box.height;

    // displayed → drawSvgPath space (origin at (bx, by+bh), y-down)
    const map = (x, y) => {
      switch (R) {
        case 90: return { x: y, y: bh - x };
        case 180: return { x: bw - x, y: bh - y };
        case 270: return { x: bw - y, y: x };
        default: return { x, y };
      }
    };
    // displayed → absolute page coords (y-up)
    const pagePt = (x, y) => {
      const p = map(x, y);
      return { x: bx + p.x, y: by + bh - p.y };
    };
    // screen-space angle (deg, y-down clockwise-positive) → PDF CCW degrees
    const angle = a => R - a;

    return { box, R, vpW, vpH, originX: bx, originY: by + bh, map, pagePt, angle };
  }

  /* ================= vector drawing helpers ================= */

  const rgbCache = {};
  function rgbOf(hex) {
    if (rgbCache[hex]) return rgbCache[hex];
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0xe02020;
    return (rgbCache[hex] = PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255));
  }
  const WHITE = () => PDFLib.rgb(1, 1, 1);

  /** Path d string from displayed points through the frame map. */
  function svgD(pts, close, f) {
    let d = '';
    for (let i = 0; i < pts.length; i++) {
      const q = f.map(pts[i].x, pts[i].y);
      d += (i ? 'L' : 'M') + q.x.toFixed(2) + ' ' + q.y.toFixed(2);
    }
    return close ? d + 'Z' : d;
  }

  function strokePath(page, f, d, color, width, o = {}) {
    page.drawSvgPath(d, {
      x: f.originX, y: f.originY,
      borderColor: color, borderWidth: width,
      borderLineCap: PDFLib.LineCapStyle.Round,
      borderOpacity: o.opacity != null ? o.opacity : 1,
      ...(o.dash ? { borderDashArray: o.dash } : {}),
    });
  }
  function fillPath(page, f, d, color, opacity) {
    page.drawSvgPath(d, { x: f.originX, y: f.originY, color, opacity: opacity != null ? opacity : 1 });
  }
  function circle(page, f, cx, cy, r, o = {}) {
    const c = f.pagePt(cx, cy);
    page.drawEllipse({
      x: c.x, y: c.y, xScale: r, yScale: r,
      ...(o.fill ? { color: o.fill, opacity: o.opacity != null ? o.opacity : 1 } : {}),
      ...(o.stroke ? { borderColor: o.stroke, borderWidth: o.width || 1, borderOpacity: o.opacity != null ? o.opacity : 1 } : {}),
    });
  }

  function dashOf(m, lw) {
    if (m.lineStyle === 'dash') return [lw * 3.2, lw * 2.2];
    if (m.lineStyle === 'dot') return [0.1, lw * 2.4];
    return null;
  }

  /* ---- text ---- */

  const encodable = new Map();
  const CHAR_FALLBACK = { '⚠': '!', '→': '>', '←': '<', '✕': 'x', '✛': '+' };
  function sanitize(str, font) {
    let out = '';
    for (const ch of String(str || '')) {
      let ok = encodable.get(ch);
      if (ok === undefined) {
        try { font.widthOfTextAtSize(ch, 10); ok = true; } catch (_) { ok = false; }
        encodable.set(ch, ok);
      }
      out += ok ? ch : (CHAR_FALLBACK[ch] || '?');
    }
    return out;
  }

  /**
   * Text at a displayed baseline point, with screen-space rotation and an
   * optional white halo pill (mirrors the SVG labels' paint-order halo).
   */
  function drawLabel(page, f, fonts, str, cx, cy, o = {}) {
    const font = o.bold ? fonts.bold : fonts.reg;
    str = sanitize(str, font);
    if (!str.trim()) return;
    const size = o.size || 12;
    const w = font.widthOfTextAtSize(str, size);
    const aDeg = f.angle(o.angleScreen || 0);
    const a = aDeg * Math.PI / 180;
    const dir = { x: Math.cos(a), y: Math.sin(a) };
    const up = { x: -Math.sin(a), y: Math.cos(a) };
    const c = f.pagePt(cx, cy);
    const half = o.anchor === 'start' ? 0 : w / 2;
    const bx = c.x - dir.x * half, by = c.y - dir.y * half;
    if (o.halo) {
      const pad = size * 0.22, drop = size * 0.3;
      page.drawRectangle({
        x: bx - dir.x * pad + up.x * -drop,
        y: by - dir.y * pad + up.y * -drop,
        width: w + pad * 2, height: size * 1.28,
        rotate: PDFLib.degrees(aDeg),
        color: WHITE(), opacity: o.haloOpacity != null ? o.haloOpacity : 0.8,
      });
    }
    page.drawText(str, {
      x: bx, y: by, size, font,
      color: rgbOf(o.color || '#111111'),
      rotate: PDFLib.degrees(aDeg),
      opacity: o.opacity != null ? o.opacity : 1,
    });
  }

  /** Wrapped multi-line block matching the SVG text builders. */
  function drawWrapped(page, f, fonts, m, color, opacity) {
    const fs = m.fontSize || 12, pad = fs * 0.35;
    const lines = Render.wrapText(m.text, m.w - pad * 2, fs);
    lines.forEach((ln, i) => {
      drawLabel(page, f, fonts, ln, m.x + pad, m.y + pad + fs * 0.85 + i * fs * 1.25,
        { size: fs, color, anchor: 'start', opacity });
    });
  }

  /* ---- cloud scallops as beziers (arc flags avoided entirely) ---- */

  function cloudD(pts, arcSize, closed, f) {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      area += (b.x - a.x) * (b.y + a.y);
    }
    const P = (closed && area < 0) ? [...pts].reverse() : pts;
    const n = P.length, segs = closed ? n : n - 1;
    const q0 = f.map(P[0].x, P[0].y);
    let d = `M${q0.x.toFixed(2)} ${q0.y.toFixed(2)}`;
    for (let i = 0; i < segs; i++) {
      const a = P[i], b = P[(i + 1) % n];
      const len = Geo.dist(a, b);
      if (len < 0.5) continue;
      const chunks = Math.max(1, Math.round(len / Math.max(4, arcSize)));
      const ux = (b.x - a.x) / chunks, uy = (b.y - a.y) / chunks;
      const chord = len / chunks, r = chord * 0.62;
      for (let c = 1; c <= chunks; c++) {
        const p1 = { x: a.x + ux * (c - 1), y: a.y + uy * (c - 1) };
        const p2 = { x: a.x + ux * c, y: a.y + uy * c };
        d += arcCubics(p1, p2, r, f);
      }
    }
    return d;
  }

  /** Circular arc p1→p2 (radius r, SVG sweep=1, largeArc=0) as cubic segments, mapped. */
  function arcCubics(p1, p2, r, f) {
    const dx = (p2.x - p1.x) / 2, dy = (p2.y - p1.y) / 2;
    const d2 = dx * dx + dy * dy;
    const k = Math.sqrt(Math.max(0, r * r / d2 - 1));
    // SVG center rule for fA=0, fS=1 → center = mid + k*(dy, -dx)
    const cx = p1.x + dx + k * dy, cy = p1.y + dy - k * dx;
    let a1 = Math.atan2(p1.y - cy, p1.x - cx);
    let a2 = Math.atan2(p2.y - cy, p2.x - cx);
    let delta = a2 - a1;
    while (delta <= 0) delta += 2 * Math.PI;      // sweep=1 → positive angle in y-down space
    const nSeg = Math.max(1, Math.ceil(delta / (Math.PI / 2)));
    const step = delta / nSeg;
    let d = '';
    for (let i = 0; i < nSeg; i++) {
      const t1 = a1 + i * step, t2 = t1 + step;
      const alpha = (4 / 3) * Math.tan(step / 4) * r;
      const s1 = { x: cx + r * Math.cos(t1), y: cy + r * Math.sin(t1) };
      const s2 = { x: cx + r * Math.cos(t2), y: cy + r * Math.sin(t2) };
      const c1 = { x: s1.x - alpha * Math.sin(t1), y: s1.y + alpha * Math.cos(t1) };
      const c2 = { x: s2.x + alpha * Math.sin(t2), y: s2.y - alpha * Math.cos(t2) };
      const m1 = f.map(c1.x, c1.y), m2 = f.map(c2.x, c2.y), m3 = f.map(s2.x, s2.y);
      d += `C${m1.x.toFixed(2)} ${m1.y.toFixed(2)} ${m2.x.toFixed(2)} ${m2.y.toFixed(2)} ${m3.x.toFixed(2)} ${m3.y.toFixed(2)}`;
    }
    return d;
  }

  const rectPts = m => [
    { x: m.x, y: m.y }, { x: m.x + m.w, y: m.y },
    { x: m.x + m.w, y: m.y + m.h }, { x: m.x, y: m.y + m.h },
  ];

  /** Rounded-rect path (displayed coords, mapped), corner radius r. */
  function roundedRectD(x, y, w, h, r, f) {
    r = Math.min(r, w / 2, h / 2);
    const K = 0.5523 * r;
    const P = (px, py) => { const q = f.map(px, py); return `${q.x.toFixed(2)} ${q.y.toFixed(2)}`; };
    return `M${P(x + r, y)}L${P(x + w - r, y)}C${P(x + w - r + K, y)} ${P(x + w, y + r - K)} ${P(x + w, y + r)}` +
      `L${P(x + w, y + h - r)}C${P(x + w, y + h - r + K)} ${P(x + w - r + K, y + h)} ${P(x + w - r, y + h)}` +
      `L${P(x + r, y + h)}C${P(x + r - K, y + h)} ${P(x, y + h - r + K)} ${P(x, y + h - r)}` +
      `L${P(x, y + r)}C${P(x, y + r - K)} ${P(x + r - K, y)} ${P(x + r, y)}Z`;
  }

  const rotPt = (p, c, deg) => {
    if (!deg) return p;
    const a = deg * Math.PI / 180, s = Math.sin(a), co = Math.cos(a);
    return { x: c.x + (p.x - c.x) * co - (p.y - c.y) * s, y: c.y + (p.x - c.x) * s + (p.y - c.y) * co };
  };

  /* ================= per-type vector renderers ================= */

  function drawVectorMarkup(page, f, fonts, m, mod) {
    const op = m.opacity != null ? m.opacity : 1;
    const col = rgbOf(m.color);
    const lw = m.lineWidth || 2;
    const gray = !!(mod && mod.gray);

    switch (m.type) {

      case 'fitting': {
        const fit = Symbols.fittingById(m.fitId);
        const code = fit ? fit.code : '?';
        const s = m.size || 15, fs = s * 0.56;
        const w = Math.max(s * 1.7, fonts.bold.widthOfTextAtSize(code, fs) + s * 0.7);
        const d = roundedRectD(m.x - w / 2, m.y - s / 2, w, s, s * 0.22, f);
        fillPath(page, f, d, WHITE(), 0.88 * op);
        strokePath(page, f, d, col, Math.max(1.2, s * 0.09), { opacity: op });
        drawLabel(page, f, fonts, code, m.x, m.y + fs * 0.36, { size: fs, bold: true, color: m.color, opacity: op });
        if (m.showLabel !== false && m.pipeSize) {
          drawLabel(page, f, fonts, m.pipeSize, m.x, m.y + s * 0.5 + s * 0.52,
            { size: s * 0.44, bold: true, color: m.color, halo: true, opacity: op });
        }
        return;
      }

      case 'pipe': {
        const w = State.pipeDisplayWidth(m);
        const d = svgD(m.pts, false, f);
        strokePath(page, f, d, WHITE(), w + Math.max(1.5, w * 0.7), { opacity: 0.65 * op });
        strokePath(page, f, d, col, w, { opacity: op, dash: dashOf(m, w) });
        for (const p of [m.pts[0], m.pts[m.pts.length - 1]]) {
          circle(page, f, p.x, p.y, Math.max(1.2, w * 0.75), { fill: col, opacity: op });
        }
        if (m.showLabel !== false) {
          const seg = Geo.longestSegment(m.pts);
          const len = Render.measureLabel(m);
          const str = len ? `${m.pipeSize} – ${len}` : (m.pipeSize || '');
          if (str) {
            const off = w / 2 + (m.fontSize || 12) * 0.62;
            drawLabel(page, f, fonts, str, seg.mid.x, seg.mid.y - off,
              { size: m.fontSize || 12, bold: true, color: m.color, angleScreen: seg.angle, halo: true, opacity: op });
          }
        }
        return;
      }

      case 'line':
        strokePath(page, f, svgD(m.pts, false, f), col, lw, { opacity: op, dash: dashOf(m, lw) });
        return;

      case 'arrow': {
        strokePath(page, f, svgD(m.pts, false, f), col, lw, { opacity: op, dash: dashOf(m, lw) });
        const head = Geo.arrowHead(m.pts[0], m.pts[1], Math.max(7, lw * 3.4));
        fillPath(page, f, svgD(head, true, f), col, op);
        return;
      }

      case 'polyline': {
        const d = m.cloudStyle ? cloudD(m.pts, m.arcSize || 14, m.closed, f) + (m.closed ? 'Z' : '')
          : svgD(m.pts, m.closed, f);
        if (m.closed && m.fill && m.fill !== 'none') fillPath(page, f, d, rgbOf(m.fill), (m.fillOpacity != null ? m.fillOpacity : 0.2) * op);
        strokePath(page, f, d, col, lw, { opacity: op, dash: dashOf(m, lw) });
        return;
      }

      case 'pen':
        strokePath(page, f, svgD(m.pts, false, f), col, lw, { opacity: op });
        return;

      case 'highlight':
        strokePath(page, f, svgD(m.pts, false, f), col, lw, { opacity: 0.45 * op });
        return;

      case 'rect': {
        const d = svgD(rectPts(m), true, f);
        if (m.fill && m.fill !== 'none') fillPath(page, f, d, rgbOf(m.fill), (m.fillOpacity != null ? m.fillOpacity : 0.2) * op);
        strokePath(page, f, d, col, lw, { opacity: op, dash: dashOf(m, lw) });
        return;
      }

      case 'ellipse': {
        const c = f.pagePt(m.x + m.w / 2, m.y + m.h / 2);
        const sideways = f.R === 90 || f.R === 270;
        const rx = Math.abs(m.w / 2), ry = Math.abs(m.h / 2);
        page.drawEllipse({
          x: c.x, y: c.y,
          xScale: sideways ? ry : rx, yScale: sideways ? rx : ry,
          ...(m.fill && m.fill !== 'none' ? { color: rgbOf(m.fill), opacity: (m.fillOpacity != null ? m.fillOpacity : 0.2) * op } : {}),
          borderColor: col, borderWidth: lw, borderOpacity: op,
          ...(dashOf(m, lw) ? { borderDashArray: dashOf(m, lw) } : {}),
        });
        return;
      }

      case 'cloud': {
        const d = cloudD(rectPts(m), m.arcSize || 14, true, f) + 'Z';
        if (m.fill && m.fill !== 'none') fillPath(page, f, d, rgbOf(m.fill), (m.fillOpacity != null ? m.fillOpacity : 0.2) * op);
        strokePath(page, f, d, col, lw, { opacity: op });
        return;
      }

      case 'marea': {
        const d = svgD(m.pts, true, f);
        const hasFill = m.fill && m.fill !== 'none';
        fillPath(page, f, d, hasFill ? rgbOf(m.fill) : col, (hasFill ? (m.fillOpacity != null ? m.fillOpacity : 0.2) : 0.13) * op);
        strokePath(page, f, d, col, lw, { opacity: op, dash: dashOf(m, lw) });
        if (m.showLabel !== false) {
          const c = Geo.centroid(m.pts);
          drawLabel(page, f, fonts, Render.measureLabel(m) || '! no scale', c.x, c.y,
            { size: m.fontSize || 12, bold: true, color: m.color, halo: true, opacity: op });
        }
        return;
      }

      case 'mlength': {
        const [a, b] = m.pts;
        strokePath(page, f, svgD(m.pts, false, f), col, lw, { opacity: op, dash: dashOf(m, lw) });
        const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
        const t = Math.max(5, lw * 2.5);
        for (const p of [a, b]) {
          const tick = [
            { x: p.x + t * Math.cos(ang), y: p.y + t * Math.sin(ang) },
            { x: p.x - t * Math.cos(ang), y: p.y - t * Math.sin(ang) },
          ];
          strokePath(page, f, svgD(tick, false, f), col, lw, { opacity: op });
        }
        if (m.showLabel !== false) {
          const seg = Geo.longestSegment(m.pts);
          drawLabel(page, f, fonts, Render.measureLabel(m) || '! no scale', seg.mid.x, seg.mid.y - (m.fontSize || 12) * 0.6,
            { size: m.fontSize || 12, bold: true, color: m.color, angleScreen: seg.angle, halo: true, opacity: op });
        }
        return;
      }

      case 'mpoly': {
        strokePath(page, f, svgD(m.pts, false, f), col, lw, { opacity: op, dash: dashOf(m, lw) });
        for (const p of m.pts) circle(page, f, p.x, p.y, Math.max(2, lw * 0.85), { fill: col, opacity: op });
        if (m.showLabel !== false) {
          const seg = Geo.longestSegment(m.pts);
          drawLabel(page, f, fonts, Render.measureLabel(m) || '! no scale', seg.mid.x, seg.mid.y - (m.fontSize || 12) * 0.6,
            { size: m.fontSize || 12, bold: true, color: m.color, angleScreen: seg.angle, halo: true, opacity: op });
        }
        return;
      }

      case 'text': {
        if (m.fill && m.fill !== 'none') {
          fillPath(page, f, svgD(rectPts(m), true, f), rgbOf(m.fill), (m.fillOpacity != null ? m.fillOpacity : 0.85) * op);
        }
        if (m.border) strokePath(page, f, svgD(rectPts(m), true, f), col, lw, { opacity: op });
        drawWrapped(page, f, fonts, m, m.color, op);
        return;
      }

      case 'callout': {
        const bx = m.anchor.x < m.x ? m.x : (m.anchor.x > m.x + m.w ? m.x + m.w : Math.max(m.x, Math.min(m.x + m.w, m.anchor.x)));
        const by = m.anchor.y < m.y ? m.y : (m.anchor.y > m.y + m.h ? m.y + m.h : m.y + m.h / 2);
        strokePath(page, f, svgD([{ x: bx, y: by }, m.anchor], false, f), col, lw, { opacity: op });
        fillPath(page, f, svgD(Geo.arrowHead({ x: bx, y: by }, m.anchor, Math.max(7, lw * 3.2)), true, f), col, op);
        const boxD = roundedRectD(m.x, m.y, m.w, m.h, 2, f);
        fillPath(page, f, boxD, WHITE(), 0.9 * op);
        strokePath(page, f, boxD, col, lw, { opacity: op });
        drawWrapped(page, f, fonts, m, gray ? m.color : '#111111', op);
        return;
      }

      case 'stamp': {
        const s = m.size || 20, fs = s * 0.55;
        const str = sanitize(m.text || '', fonts.bold);
        // letter-spacing approximation used on screen
        const tw = fonts.bold.widthOfTextAtSize(str, fs) + fs * 0.08 * Math.max(0, str.length - 1) + s * 0.9;
        const rot = m.rotation || 0;
        const c = { x: m.x, y: m.y };
        const corners = rectPts({ x: m.x - tw / 2, y: m.y - s / 2, w: tw, h: s }).map(p => rotPt(p, c, rot));
        const d = svgD(corners, true, f);
        fillPath(page, f, d, WHITE(), 0.82 * op);
        strokePath(page, f, d, col, Math.max(1.4, s * 0.09), { opacity: op });
        drawLabel(page, f, fonts, str, m.x, m.y + fs * 0.36, {
          size: fs, bold: true, color: m.color, angleScreen: rot, opacity: op,
        });
        return;
      }

      case 'penet': {
        const s = m.size || 16, r = s / 2;
        const k = Math.max(1.0, s * 0.08);
        circle(page, f, m.x, m.y, r * 1.05, { fill: WHITE(), opacity: 0.75 * op });
        circle(page, f, m.x, m.y, r, { stroke: col, width: k, opacity: op });
        const c7 = r * 0.7, c145 = r * 1.45;
        strokePath(page, f, svgD([{ x: m.x - c7, y: m.y - c7 }, { x: m.x + c7, y: m.y + c7 }], false, f), col, k, { opacity: op });
        strokePath(page, f, svgD([{ x: m.x + c7, y: m.y - c7 }, { x: m.x - c7, y: m.y + c7 }], false, f), col, k, { opacity: op });
        for (const [x1, y1, x2, y2] of [
          [m.x, m.y - c145, m.x, m.y - r], [m.x, m.y + r, m.x, m.y + c145],
          [m.x - c145, m.y, m.x - r, m.y], [m.x + r, m.y, m.x + c145, m.y],
        ]) {
          strokePath(page, f, svgD([{ x: x1, y: y1 }, { x: x2, y: y2 }], false, f), col, k, { opacity: op });
        }
        if (m.showLabel !== false) {
          const fs = Math.max(4.5, s * 0.4);
          drawLabel(page, f, fonts, `Ø${m.penSize || '?'}`, m.x, m.y + r * 1.5 + fs,
            { size: fs, bold: true, color: m.color, halo: true, opacity: op });
          const sub = `${m.penType || ''}${m.penFire ? ' · FIRE' : ''}`.trim();
          if (sub) {
            drawLabel(page, f, fonts, sub, m.x, m.y + r * 1.5 + fs * 2.15,
              { size: fs * 0.78, bold: !!m.penFire, color: m.penFire && !gray ? '#e02020' : m.color, halo: true, opacity: op });
          }
        }
        return;
      }

      case 'count': {
        const grp = State.countGroup(m.groupId);
        const color = rgbOf(gray ? m.color : (grp ? grp.color : m.color));
        const shape = grp ? grp.shape : 'circle';
        const r = m.size || 7;
        const pts = ({
          square: rectPts({ x: m.x - r, y: m.y - r, w: 2 * r, h: 2 * r }),
          diamond: [{ x: m.x, y: m.y - r * 1.2 }, { x: m.x + r * 1.2, y: m.y }, { x: m.x, y: m.y + r * 1.2 }, { x: m.x - r * 1.2, y: m.y }],
          triangle: [{ x: m.x, y: m.y - r * 1.25 }, { x: m.x + r * 1.2, y: m.y + r }, { x: m.x - r * 1.2, y: m.y + r }],
        })[shape];
        if (shape === 'cross') {
          strokePath(page, f, svgD([{ x: m.x - r, y: m.y - r }, { x: m.x + r, y: m.y + r }], false, f), color, 2.7, { opacity: op });
          strokePath(page, f, svgD([{ x: m.x - r, y: m.y + r }, { x: m.x + r, y: m.y - r }], false, f), color, 2.7, { opacity: op });
        } else if (pts) {
          const d = svgD(pts, true, f);
          fillPath(page, f, d, color, 0.25 * op);
          strokePath(page, f, d, color, 1.8, { opacity: op });
        } else {
          circle(page, f, m.x, m.y, r, { fill: color, opacity: 0.25 * op });
          circle(page, f, m.x, m.y, r, { stroke: color, width: 1.8, opacity: op });
        }
        return;
      }

      default:
        throw new Error('no vector renderer for ' + m.type);
    }
  }

  /* ================= photos & mini raster stamps ================= */

  async function drawPhoto(out, page, f, fonts, m) {
    const src = State.S.images[m.imgId];
    if (!src) throw new Error('missing image');
    const img = /^data:image\/png/.test(src) ? await out.embedPng(src) : await out.embedJpg(src);
    const anchor = f.pagePt(m.x, m.y + m.h);
    page.drawImage(img, {
      x: anchor.x, y: anchor.y, width: m.w, height: m.h,
      rotate: PDFLib.degrees(f.R),
      opacity: m.opacity != null ? m.opacity : 1,
    });
    const frameD = svgD(rectPts(m), true, f);
    strokePath(page, f, frameD, rgbOf(m.color), m.lineWidth || 2, {});
    if (m.caption) {
      const fs = m.fontSize || 11;
      const strip = { x: m.x, y: m.y + m.h - fs * 1.6, w: m.w, h: fs * 1.6 };
      fillPath(page, f, svgD(rectPts(strip), true, f), WHITE(), 0.85);
      drawLabel(page, f, fonts, m.caption, m.x + fs * 0.4, m.y + m.h - fs * 0.45,
        { size: fs, color: '#111111', anchor: 'start' });
    }
  }

  /** High-res raster stamp of a single markup (symbols, or any vector failure). */
  async function miniStamp(out, page, f, m, mod) {
    const b = Geo.markupBounds(m);
    if (b.w <= 0 || b.h <= 0) return;
    const s = Math.max(2, Math.min(10, 2400 / Math.max(b.w, b.h)));
    const pxW = Math.max(2, Math.round(b.w * s)), pxH = Math.max(2, Math.round(b.h * s));
    const svgStr = pageSvg([m], b, pxW, pxH, { gray: !!(mod && mod.gray) });
    const canvas = await svgToCanvas(svgStr, pxW, pxH);
    const png = await out.embedPng(canvas.toDataURL('image/png'));
    const anchor = f.pagePt(b.x, b.y + b.h);
    page.drawImage(png, {
      x: anchor.x, y: anchor.y, width: b.w, height: b.h,
      rotate: PDFLib.degrees(f.R),
    });
  }

  /* ================= export passes ================= */

  async function overlayExport(out, progress, o) {
    const S = State.S;
    const n = S.pageCount;
    const fonts = {
      reg: await out.embedFont(PDFLib.StandardFonts.Helvetica),
      bold: await out.embedFont(PDFLib.StandardFonts.HelveticaBold),
    };

    for (let p = 1; p <= n; p++) {
      const markups = State.pageMarkups(p);
      if (!markups.length && !o.banner) continue;
      progress.set(((p - 1) / n) * 100, `Marking up page ${p} of ${n}…`);

      const page = out.getPage(p - 1);
      const f = makeFrame(page);
      page.pushOperators(PDFLib.setLineJoin(PDFLib.LineJoinStyle.Round));

      for (const m of markups) {
        const st = State.dayStateOf(m, o.dayMode, o.day);
        if (st === 'hidden') continue;
        const gray = st === 'gray';
        const mm = gray ? { ...m, color: '#8c8c8c', opacity: (m.opacity != null ? m.opacity : 1) * 0.4 } : m;
        try {
          if (m.type === 'photo') await drawPhoto(out, page, f, fonts, mm);
          else if (m.type === 'symbol') await miniStamp(out, page, f, m, { gray });
          else drawVectorMarkup(page, f, fonts, mm, { gray });
        } catch (err) {
          // never lose a markup — fall back to a high-res raster of just this one
          console.warn('vector export fallback for', m.type, err);
          try { await miniStamp(out, page, f, m, { gray }); } catch (e2) { console.error('stamp failed', e2); }
        }
      }

      if (o.banner) {
        drawLabel(page, f, fonts, o.banner, 16, 26,
          { size: 15, bold: true, color: '#e02020', anchor: 'start', halo: true, haloOpacity: 0.92 });
      }
    }

    await finishExport(out, progress,
      o.banner ? 'Daily report PDF exported.' : 'As-built PDF exported — drawing and markups both at full vector quality.',
      o.fileSuffix);
  }

  /** Fallback: rasterize whole pages (only when the source PDF can't be reloaded). */
  async function rasterExport(progress, o) {
    const S = State.S;
    const out = await PDFLib.PDFDocument.create();
    const n = S.pageCount;
    o = o || {};

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

      const markups = State.pageMarkups(p)
        .filter(m => State.dayStateOf(m, o.dayMode, o.day) !== 'hidden');
      if (markups.length) {
        // gray and normal markups rasterize as separate layers so the day
        // treatment matches the vector path
        for (const gray of [true, false]) {
          const set = markups.filter(m => (State.dayStateOf(m, o.dayMode, o.day) === 'gray') === gray);
          if (!set.length) continue;
          const svgStr = pageSvg(set, { x: 0, y: 0, w: vp1.width, h: vp1.height }, canvas.width, canvas.height, { gray });
          const layer = await svgToCanvas(svgStr, canvas.width, canvas.height);
          ctx.drawImage(layer, 0, 0);
        }
      }

      const jpeg = await out.embedJpg(canvas.toDataURL('image/jpeg', 0.87));
      const outPage = out.addPage([vp1.width, vp1.height]);
      outPage.drawImage(jpeg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    }

    await finishExport(out, progress,
      'PDF exported (rasterized — the source PDF could not be reloaded for vector output).', o.fileSuffix);
  }

  async function finishExport(out, progress, message, suffix) {
    progress.set(97, 'Writing PDF…');
    const bytes = await out.save();
    const base = (State.S.fileName || 'drawing').replace(/\.pdf$/i, '');
    App.download(new Blob([bytes], { type: 'application/pdf' }), base + (suffix || ' (as-built)') + '.pdf');
    progress.close();
    App.toast(message, 'ok');
  }

  /** SVG of the given markups over the viewBox rect vb {x,y,w,h}. */
  function pageSvg(markups, vb, pxW, pxH, opts) {
    const holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const m of markups) holder.appendChild(Render.buildMarkupEl(m, opts));
    const inner = new XMLSerializer().serializeToString(holder)
      .replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" width="${pxW}" height="${pxH}">${inner}</svg>`;
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
    line(bx + bay, by, bx + bay, by + bay, 3.2);
    line(bx, by + bay, bx + bay, by + bay, 3.2);
    line(bx + 2 * bay, by, bx + 2 * bay, by + bay * 0.75, 3.2);
    line(bx + bay, by + bay * 0.75, bx + 2 * bay, by + bay * 0.75, 3.2);
    line(bx, by + bh - bay * 0.6, bx + bay * 1.5, by + bh - bay * 0.6, 3.2);
    line(bx + bay * 1.5, by + bh - bay * 0.6, bx + bay * 1.5, by + bh, 3.2);
    line(bx + bw - bay, by + bay, bx + bw, by + bay, 3.2);
    line(bx + bw - bay, by, bx + bw - bay, by + bay, 3.2);

    const door = (x, y, r, a0) => {
      page.drawLine({ start: { x, y: Y(y) }, end: { x: x + r * Math.cos(a0), y: Y(y) + r * Math.sin(a0) }, thickness: 1.2, color: dim });
    };
    door(bx + bay - 90, by + bay, 80, Math.PI / 2);
    door(bx + bay * 1.5, by + bh - bay * 0.6 + 90, 80, 0);

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
