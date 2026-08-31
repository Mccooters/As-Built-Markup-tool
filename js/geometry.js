/* ============ geometry.js — math helpers (page-unit space) ============ */
'use strict';

const Geo = (() => {

  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

  /**
   * Constrain point p relative to origin o to the nearest `stepDeg` angle.
   * `baseDeg` rotates the snap grid — pass the previous segment's bearing to
   * snap relative to it (straight on / 45° / square off the run) instead of
   * to the sheet's horizontal.
   */
  function constrainAngle(o, p, stepDeg = 45, baseDeg = 0) {
    const dx = p.x - o.x, dy = p.y - o.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return { x: p.x, y: p.y };
    const step = stepDeg * Math.PI / 180;
    const base = baseDeg * Math.PI / 180;
    const ang = base + Math.round((Math.atan2(dy, dx) - base) / step) * step;
    return { x: o.x + len * Math.cos(ang), y: o.y + len * Math.sin(ang) };
  }

  /** Distance from point p to segment ab. */
  function pointSegDist(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const l2 = abx * abx + aby * aby;
    if (l2 < 1e-12) return dist(p, a);
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
  }

  const polylineLength = pts => {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
    return L;
  };

  /** Shoelace area (absolute). */
  function polygonArea(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  function centroid(pts) {
    let x = 0, y = 0;
    for (const p of pts) { x += p.x; y += p.y; }
    return { x: x / pts.length, y: y / pts.length };
  }

  function boundsOfPts(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  const inflate = (b, m) => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m });

  const rectsIntersect = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  const rectContains = (a, b) => /* a contains b */
    b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

  /** Longest segment of a polyline → its midpoint + angle (for label placement). */
  function longestSegment(pts) {
    if (pts.length < 2) {
      const p = pts[0] || { x: 0, y: 0 };
      return { mid: { x: p.x, y: p.y }, angle: 0, len: 0 };
    }
    let best = -1, bi = 1;
    for (let i = 1; i < pts.length; i++) {
      const d = dist(pts[i - 1], pts[i]);
      if (d > best) { best = d; bi = i; }
    }
    const a = pts[bi - 1], b = pts[bi];
    let ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, angle: ang, len: best };
  }

  /** SVG path for a polyline (optionally closed). */
  function polyPath(pts, closed) {
    if (!pts.length) return '';
    let d = `M${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
    for (let i = 1; i < pts.length; i++) d += `L${pts[i].x.toFixed(2)} ${pts[i].y.toFixed(2)}`;
    if (closed) d += 'Z';
    return d;
  }

  /**
   * Revision-cloud path along a polygon: each edge becomes a chain of outward
   * arcs (Bluebeam-style scallops). Points should be in clockwise order for
   * outward bulges (screen coords, y-down).
   */
  function cloudPath(pts, arcSize, closed = true) {
    if (pts.length < 2) return '';
    // Ensure clockwise winding so arcs bulge outward.
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      area += (b.x - a.x) * (b.y + a.y);
    }
    const P = (closed && area < 0) ? [...pts].reverse() : pts;
    const n = P.length;
    const segs = closed ? n : n - 1;
    let d = `M${P[0].x.toFixed(2)} ${P[0].y.toFixed(2)}`;
    for (let i = 0; i < segs; i++) {
      const a = P[i], b = P[(i + 1) % n];
      const len = dist(a, b);
      if (len < 0.5) continue;
      const chunks = Math.max(1, Math.round(len / Math.max(4, arcSize)));
      const ux = (b.x - a.x) / chunks, uy = (b.y - a.y) / chunks;
      const r = (len / chunks) * 0.62;
      for (let c = 1; c <= chunks; c++) {
        const px = a.x + ux * c, py = a.y + uy * c;
        d += `A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${px.toFixed(2)} ${py.toFixed(2)}`;
      }
    }
    return d;
  }

  /** Filled arrow-head polygon points for a line ending at `tip` coming from `from`. */
  function arrowHead(from, tip, size) {
    const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
    const a1 = ang + Math.PI - 0.46, a2 = ang + Math.PI + 0.46;
    return [
      tip,
      { x: tip.x + size * Math.cos(a1), y: tip.y + size * Math.sin(a1) },
      { x: tip.x + size * Math.cos(a2), y: tip.y + size * Math.sin(a2) },
    ];
  }

  /** Hit-test: distance from p to a markup's stroke geometry (rough, page units). */
  function markupBounds(m) {
    switch (m.type) {
      case 'pipe': {
        // true-scale pipes can be much wider than their nominal lineWidth
        const lw = (typeof State !== 'undefined' && State.pipeDisplayWidth)
          ? State.pipeDisplayWidth(m) : (m.lineWidth || 2);
        return inflate(boundsOfPts(m.pts), lw / 2 + 5);
      }
      case 'line': case 'arrow': case 'polyline': case 'pen': case 'highlight':
      case 'mlength': case 'mpoly': case 'marea':
        return inflate(boundsOfPts(m.pts), (m.lineWidth || 2) + 4);
      case 'rect': case 'ellipse': case 'cloud': case 'text': case 'photo': case 'zone':
        return inflate({ x: m.x, y: m.y, w: m.w, h: m.h }, (m.lineWidth || 2) + 4);
      case 'penet': {
        const r = (m.size || 22) / 2;
        // marker + the Ø-size / type labels below it
        return { x: m.x - r * 2.2, y: m.y - r * 1.6, w: r * 4.4, h: r * 4.4 };
      }
      case 'callout': {
        const b = boundsOfPts([
          { x: m.x, y: m.y }, { x: m.x + m.w, y: m.y + m.h }, m.anchor,
        ]);
        return inflate(b, 6);
      }
      case 'symbol': case 'stamp': {
        const s = (m.size || 24);
        const w = m.type === 'stamp' ? s * (m.aspect || 4) : s;
        return inflate({ x: m.x - w / 2, y: m.y - s / 2, w, h: s }, 6);
      }
      case 'count':
        return { x: m.x - 9, y: m.y - 9, w: 18, h: 18 };
      case 'fitting': {
        const s = m.size || 15;
        return { x: m.x - s * 1.4, y: m.y - s * 0.9, w: s * 2.8, h: s * 2.3 };
      }
      default:
        return { x: m.x || 0, y: m.y || 0, w: m.w || 1, h: m.h || 1 };
    }
  }

  const fmtNum = n => (Math.round(n * 100) / 100).toString();

  return {
    dist, constrainAngle, pointSegDist, polylineLength, polygonArea, centroid,
    boundsOfPts, inflate, rectsIntersect, rectContains, longestSegment,
    polyPath, cloudPath, arrowHead, markupBounds, fmtNum,
  };
})();
