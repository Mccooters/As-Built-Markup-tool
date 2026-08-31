/* ============ render.js — SVG rendering of markups + selection handles ============ */
'use strict';

const Render = (() => {

  const NS = 'http://www.w3.org/2000/svg';
  const elMap = new Map();   // markup id -> <g>
  let measureCtx = null;

  const svg = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  function dashArray(m, lw) {
    lw = lw || m.lineWidth || 2;
    if (m.lineStyle === 'dash') return `${lw * 3.2} ${lw * 2.2}`;
    if (m.lineStyle === 'dot') return `0.1 ${lw * 2.4}`;
    return null;
  }

  function textWidth(str, fontSize, bold) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = `${bold ? 'bold ' : ''}${fontSize}px Arial, Helvetica, sans-serif`;
    return measureCtx.measureText(str).width;
  }

  /** Wrap text to a pixel width; respects explicit newlines. */
  function wrapText(text, width, fontSize) {
    const out = [];
    for (const para of String(text || '').split('\n')) {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(''); continue; }
      let line = '';
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (line && textWidth(test, fontSize) > width) { out.push(line); line = word; }
        else line = test;
      }
      out.push(line);
    }
    return out;
  }

  /** Measurement / label string for a markup (empty when nothing to show). */
  function measureLabel(m) {
    const fmt = State.S.unitFormat;
    if (m.type === 'pipe' || m.type === 'mlength' || m.type === 'mpoly') {
      const ft = State.lengthFt(m);
      return ft == null ? '' : Units.fmtLen(ft, fmt);
    }
    if (m.type === 'marea') {
      const a = State.areaFt(m);
      return a == null ? '' : Units.fmtArea(a, fmt);
    }
    return '';
  }

  function labelEl(x, y, str, m, opts = {}) {
    const fs = opts.fontSize || m.fontSize || 12;
    const t = svg('text', {
      x: x.toFixed(2), y: y.toFixed(2),
      'font-family': 'Arial, Helvetica, sans-serif',
      'font-size': fs,
      'font-weight': opts.bold ? 'bold' : 'normal',
      fill: opts.color || m.color,
      stroke: '#ffffff', 'stroke-width': fs * 0.28, 'paint-order': 'stroke',
      'text-anchor': opts.anchor || 'middle',
      'stroke-linejoin': 'round',
    });
    if (opts.rotate) t.setAttribute('transform', `rotate(${opts.rotate.toFixed(1)} ${x.toFixed(2)} ${y.toFixed(2)})`);
    t.textContent = str;
    return t;
  }

  /* ================= per-type builders ================= */

  function buildStrokePath(m, d, closed) {
    const p = svg('path', {
      d,
      fill: closed && m.fill && m.fill !== 'none' ? m.fill : 'none',
      'fill-opacity': m.fillOpacity != null ? m.fillOpacity : 0.2,
      stroke: m.color,
      'stroke-width': m.lineWidth,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    });
    const da = dashArray(m);
    if (da) p.setAttribute('stroke-dasharray', da);
    return p;
  }

  const builders = {

    line(g, m) {
      g.appendChild(buildStrokePath(m, Geo.polyPath(m.pts)));
    },

    arrow(g, m) {
      const [a, b] = m.pts;
      g.appendChild(buildStrokePath(m, Geo.polyPath(m.pts)));
      const head = Geo.arrowHead(a, b, Math.max(7, m.lineWidth * 3.4));
      g.appendChild(svg('path', { d: Geo.polyPath(head, true), fill: m.color, stroke: 'none' }));
    },

    polyline(g, m) {
      const d = m.cloudStyle
        ? Geo.cloudPath(m.pts, m.arcSize || 14, m.closed)
        : Geo.polyPath(m.pts, m.closed);
      g.appendChild(buildStrokePath(m, d, m.closed));
    },

    pen(g, m) {
      g.appendChild(buildStrokePath(m, Geo.polyPath(m.pts)));
    },

    highlight(g, m) {
      g.style.mixBlendMode = 'multiply';
      const p = buildStrokePath(m, Geo.polyPath(m.pts));
      p.setAttribute('stroke-opacity', 0.45);
      g.appendChild(p);
    },

    zone(g, m) {
      // task-linked area: tinted box + name tag; tap for tasks & materials
      g.appendChild(svg('rect', {
        x: m.x, y: m.y, width: m.w, height: m.h,
        fill: m.color, 'fill-opacity': m.fillOpacity != null ? m.fillOpacity : 0.14,
        stroke: m.color, 'stroke-width': m.lineWidth || 2,
        'stroke-dasharray': '7 4', rx: 3,
      }));
      const fs = Math.max(9, m.fontSize || 12);
      const label = (m.label || m.subject || 'Zone') + (m.jobs && m.jobs.length ? '  ·  ' + m.jobs.map(j => '#' + j).join(' ') : '');
      const t = svg('text', {
        x: m.x + 6, y: m.y + fs + 4, 'font-size': fs, 'font-weight': 700,
        fill: m.color, stroke: '#ffffff', 'stroke-width': fs / 4, 'paint-order': 'stroke',
        'stroke-linejoin': 'round', 'font-family': 'system-ui, sans-serif',
      });
      t.textContent = label;
      g.appendChild(t);
    },

    rect(g, m) {
      const r = svg('rect', {
        x: m.x, y: m.y, width: m.w, height: m.h,
        fill: m.fill && m.fill !== 'none' ? m.fill : 'none',
        'fill-opacity': m.fillOpacity != null ? m.fillOpacity : 0.2,
        stroke: m.color, 'stroke-width': m.lineWidth,
      });
      const da = dashArray(m);
      if (da) r.setAttribute('stroke-dasharray', da);
      g.appendChild(r);
    },

    ellipse(g, m) {
      const e = svg('ellipse', {
        cx: m.x + m.w / 2, cy: m.y + m.h / 2, rx: Math.abs(m.w / 2), ry: Math.abs(m.h / 2),
        fill: m.fill && m.fill !== 'none' ? m.fill : 'none',
        'fill-opacity': m.fillOpacity != null ? m.fillOpacity : 0.2,
        stroke: m.color, 'stroke-width': m.lineWidth,
      });
      const da = dashArray(m);
      if (da) e.setAttribute('stroke-dasharray', da);
      g.appendChild(e);
    },

    cloud(g, m) {
      const pts = [
        { x: m.x, y: m.y }, { x: m.x + m.w, y: m.y },
        { x: m.x + m.w, y: m.y + m.h }, { x: m.x, y: m.y + m.h },
      ];
      g.appendChild(buildStrokePath(m, Geo.cloudPath(pts, m.arcSize || 14, true), true));
    },

    pipe(g, m) {
      // stroke width = true pipe OD at the sheet scale (see State.pipeDisplayWidth)
      const w = State.pipeDisplayWidth(m);
      const d = Geo.polyPath(m.pts);
      // white casing under the colored line = classic pipe look, reads over dense linework
      g.appendChild(svg('path', {
        d, fill: 'none', stroke: '#ffffff',
        'stroke-width': w + Math.max(1.5, w * 0.7), 'stroke-opacity': 0.65,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }));
      const stroke = svg('path', {
        d, fill: 'none', stroke: m.color, 'stroke-width': w,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      });
      const da = dashArray(m, w);
      if (da) stroke.setAttribute('stroke-dasharray', da);
      g.appendChild(stroke);
      // end markers
      for (const p of [m.pts[0], m.pts[m.pts.length - 1]]) {
        g.appendChild(svg('circle', { cx: p.x, cy: p.y, r: Math.max(1.2, w * 0.75), fill: m.color, stroke: 'none' }));
      }
      if (m.showLabel !== false) {
        const seg = Geo.longestSegment(m.pts);
        const len = measureLabel(m);
        const str = len ? `${m.pipeSize} – ${len}` : (m.pipeSize || '');
        if (str) {
          const off = w / 2 + (m.fontSize || 12) * 0.62;
          g.appendChild(labelEl(seg.mid.x, seg.mid.y - off, str, m, { rotate: seg.angle, bold: true }));
        }
      }
    },

    mlength(g, m) {
      const [a, b] = m.pts;
      g.appendChild(buildStrokePath(m, Geo.polyPath(m.pts)));
      // end ticks perpendicular to line
      const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
      const t = Math.max(5, m.lineWidth * 2.5);
      for (const p of [a, b]) {
        g.appendChild(svg('path', {
          d: `M${p.x + t * Math.cos(ang)} ${p.y + t * Math.sin(ang)}L${p.x - t * Math.cos(ang)} ${p.y - t * Math.sin(ang)}`,
          stroke: m.color, 'stroke-width': m.lineWidth, 'stroke-linecap': 'round',
        }));
      }
      if (m.showLabel !== false) {
        const seg = Geo.longestSegment(m.pts);
        const str = measureLabel(m) || '⚠ no scale';
        g.appendChild(labelEl(seg.mid.x, seg.mid.y - (m.fontSize || 12) * 0.6, str, m, { rotate: seg.angle, bold: true }));
      }
    },

    mpoly(g, m) {
      g.appendChild(buildStrokePath(m, Geo.polyPath(m.pts)));
      for (const p of m.pts) g.appendChild(svg('circle', { cx: p.x, cy: p.y, r: Math.max(2, m.lineWidth * 0.85), fill: m.color, stroke: 'none' }));
      if (m.showLabel !== false) {
        const seg = Geo.longestSegment(m.pts);
        const str = measureLabel(m) || '⚠ no scale';
        g.appendChild(labelEl(seg.mid.x, seg.mid.y - (m.fontSize || 12) * 0.6, str, m, { rotate: seg.angle, bold: true }));
      }
    },

    marea(g, m) {
      const p = buildStrokePath(m, Geo.polyPath(m.pts, true), true);
      if (!m.fill || m.fill === 'none') { p.setAttribute('fill', m.color); p.setAttribute('fill-opacity', 0.13); }
      g.appendChild(p);
      if (m.showLabel !== false) {
        const c = Geo.centroid(m.pts);
        const str = measureLabel(m) || '⚠ no scale';
        g.appendChild(labelEl(c.x, c.y, str, m, { bold: true }));
      }
    },

    text(g, m) {
      const fs = m.fontSize || 12;
      const pad = fs * 0.35;
      if (m.fill && m.fill !== 'none') {
        g.appendChild(svg('rect', { x: m.x, y: m.y, width: m.w, height: m.h, fill: m.fill, 'fill-opacity': m.fillOpacity != null ? m.fillOpacity : 0.85 }));
      }
      if (m.border) {
        g.appendChild(svg('rect', { x: m.x, y: m.y, width: m.w, height: m.h, fill: 'none', stroke: m.color, 'stroke-width': m.lineWidth }));
      }
      const lines = wrapText(m.text, m.w - pad * 2, fs);
      const t = svg('text', {
        x: m.x + pad, y: m.y + pad + fs * 0.85,
        'font-family': 'Arial, Helvetica, sans-serif', 'font-size': fs, fill: m.color,
      });
      lines.forEach((ln, i) => {
        const ts = svg('tspan', { x: m.x + pad, dy: i === 0 ? 0 : fs * 1.25 });
        ts.textContent = ln || ' ';
        t.appendChild(ts);
      });
      g.appendChild(t);
    },

    callout(g, m) {
      const fs = m.fontSize || 12;
      const pad = fs * 0.35;
      // leader from box edge nearest the anchor
      const bx = m.anchor.x < m.x ? m.x : (m.anchor.x > m.x + m.w ? m.x + m.w : Math.max(m.x, Math.min(m.x + m.w, m.anchor.x)));
      const by = m.anchor.y < m.y ? m.y : (m.anchor.y > m.y + m.h ? m.y + m.h : m.y + m.h / 2);
      g.appendChild(svg('path', {
        d: `M${bx} ${by}L${m.anchor.x} ${m.anchor.y}`,
        stroke: m.color, 'stroke-width': m.lineWidth, fill: 'none', 'stroke-linecap': 'round',
      }));
      const head = Geo.arrowHead({ x: bx, y: by }, m.anchor, Math.max(7, m.lineWidth * 3.2));
      g.appendChild(svg('path', { d: Geo.polyPath(head, true), fill: m.color, stroke: 'none' }));
      g.appendChild(svg('rect', {
        x: m.x, y: m.y, width: m.w, height: m.h, rx: 2,
        fill: '#ffffff', 'fill-opacity': 0.9, stroke: m.color, 'stroke-width': m.lineWidth,
      }));
      const lines = wrapText(m.text, m.w - pad * 2, fs);
      const t = svg('text', {
        x: m.x + pad, y: m.y + pad + fs * 0.85,
        'font-family': 'Arial, Helvetica, sans-serif', 'font-size': fs, fill: '#111111',
      });
      lines.forEach((ln, i) => {
        const ts = svg('tspan', { x: m.x + pad, dy: i === 0 ? 0 : fs * 1.25 });
        ts.textContent = ln || ' ';
        t.appendChild(ts);
      });
      g.appendChild(t);
    },

    symbol(g, m) {
      const sym = Symbols.byId(m.symbolId);
      if (!sym) return;
      const inner = svg('g');
      inner.setAttribute('transform', `translate(${m.x} ${m.y}) rotate(${m.rotation || 0})`);
      inner.setAttribute('color', m.color);
      inner.innerHTML = sym.draw(m.size || 26);
      g.appendChild(inner);
      if (m.showLabel !== false) {
        const s = m.size || 26;
        g.appendChild(labelEl(m.x, m.y + s * 0.85, sym.short, m, { fontSize: Math.max(7, s * 0.34), bold: true }));
      }
    },

    stamp(g, m) {
      const s = m.size || 20;                       // pill height
      const fs = s * 0.55;
      const tw = textWidth(m.text || '', fs, true) + s * 0.9;
      m.aspect = tw / s;                            // cached for bounds
      const x = m.x - tw / 2, y = m.y - s / 2;
      g.setAttribute('transform', m.rotation ? `rotate(${m.rotation} ${m.x} ${m.y})` : '');
      g.appendChild(svg('rect', {
        x, y, width: tw, height: s, rx: s * 0.12,
        fill: '#ffffff', 'fill-opacity': 0.82, stroke: m.color, 'stroke-width': Math.max(1.4, s * 0.09),
      }));
      const t = svg('text', {
        x: m.x, y: m.y + fs * 0.36, 'text-anchor': 'middle',
        'font-family': 'Arial, Helvetica, sans-serif', 'font-size': fs, 'font-weight': 'bold',
        fill: m.color, 'letter-spacing': fs * 0.08,
      });
      t.textContent = m.text || '';
      g.appendChild(t);
    },

    photo(g, m, opts = {}) {
      const src = State.S.images[m.imgId];
      if (!src) {
        g.appendChild(svg('rect', { x: m.x, y: m.y, width: m.w, height: m.h, fill: '#eeeeee', stroke: m.color, 'stroke-width': 1.5 }));
        g.appendChild(labelEl(m.x + m.w / 2, m.y + m.h / 2, 'missing photo', m, { fontSize: 11 }));
        return;
      }
      if (!opts.noPhotoImage) {   // export embeds photos natively and skips the SVG copy
        const img = svg('image', {
          x: m.x, y: m.y, width: m.w, height: m.h,
          preserveAspectRatio: 'xMidYMid slice',
        });
        img.setAttribute('href', src);
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', src); // rasterizer compatibility
        g.appendChild(img);
      }
      g.appendChild(svg('rect', {
        x: m.x, y: m.y, width: m.w, height: m.h,
        fill: 'none', stroke: m.color, 'stroke-width': m.lineWidth || 2,
      }));
      if (m.caption) {
        const fs = m.fontSize || 11;
        g.appendChild(svg('rect', {
          x: m.x, y: m.y + m.h - fs * 1.6, width: m.w, height: fs * 1.6,
          fill: '#ffffff', 'fill-opacity': 0.85, stroke: 'none',
        }));
        const t = svg('text', {
          x: m.x + fs * 0.4, y: m.y + m.h - fs * 0.45,
          'font-family': 'Arial, Helvetica, sans-serif', 'font-size': fs, fill: '#111111',
        });
        t.textContent = m.caption;
        g.appendChild(t);
      }
    },

    penet(g, m) {
      const s = m.size || 16;
      const r = s / 2;
      const k = Math.max(1.0, s * 0.08);
      const inner = svg('g');
      inner.setAttribute('transform', `translate(${m.x} ${m.y})`);
      // white backing + circle + X + quadrant ticks = core-drill mark
      inner.innerHTML =
        `<circle r="${r * 1.05}" fill="#ffffff" fill-opacity="0.75" stroke="none"/>` +
        `<circle r="${r}" fill="none" stroke="${m.color}" stroke-width="${k}"/>` +
        `<path d="M${-r * 0.7} ${-r * 0.7}L${r * 0.7} ${r * 0.7}M${r * 0.7} ${-r * 0.7}L${-r * 0.7} ${r * 0.7}" stroke="${m.color}" stroke-width="${k}" stroke-linecap="round"/>` +
        `<path d="M0 ${-r * 1.45}V${-r}M0 ${r}V${r * 1.45}M${-r * 1.45} 0H${-r}M${r} 0H${r * 1.45}" stroke="${m.color}" stroke-width="${k}" stroke-linecap="round"/>`;
      g.appendChild(inner);
      if (m.showLabel !== false) {
        const fs = Math.max(4.5, s * 0.4);
        g.appendChild(labelEl(m.x, m.y + r * 1.5 + fs, `Ø${m.penSize || '?'}`, m, { fontSize: fs, bold: true }));
        const sub = `${m.penType || ''}${m.penFire ? ' · FIRE' : ''}`.trim();
        if (sub) {
          g.appendChild(labelEl(m.x, m.y + r * 1.5 + fs * 2.15, sub, m,
            { fontSize: fs * 0.78, bold: !!m.penFire, color: m.penFire ? '#e02020' : m.color }));
        }
      }
    },

    count(g, m) {
      const grp = State.countGroup(m.groupId);
      const color = grp ? grp.color : m.color;
      const shape = grp ? grp.shape : 'circle';
      const inner = svg('g');
      inner.setAttribute('transform', `translate(${m.x} ${m.y})`);
      inner.innerHTML = Symbols.countShapeSvg(shape, m.size || 7, color);
      g.appendChild(inner);
    },

    fitting(g, m) {
      const fit = Symbols.fittingById(m.fitId);
      const code = fit ? fit.code : '?';
      const s = m.size || 15;                 // badge height
      const fs = s * 0.56;
      const w = Math.max(s * 1.7, textWidth(code, fs, true) + s * 0.7);
      g.appendChild(svg('rect', {
        x: m.x - w / 2, y: m.y - s / 2, width: w, height: s, rx: s * 0.22,
        fill: '#ffffff', 'fill-opacity': 0.88,
        stroke: m.color, 'stroke-width': Math.max(1.2, s * 0.09),
      }));
      const t = svg('text', {
        x: m.x, y: m.y + fs * 0.36, 'text-anchor': 'middle',
        'font-family': 'Arial, Helvetica, sans-serif', 'font-size': fs, 'font-weight': 'bold',
        fill: m.color,
      });
      t.textContent = code;
      g.appendChild(t);
      if (m.showLabel !== false && m.pipeSize) {
        g.appendChild(labelEl(m.x, m.y + s * 0.5 + s * 0.52, m.pipeSize, m, { fontSize: s * 0.44, bold: true }));
      }
    },
  };

  /* ================= public API ================= */

  function buildMarkupEl(m, opts) {
    const g = svg('g');
    g.dataset.id = m.id;
    if (m.opacity != null && m.opacity < 1) g.setAttribute('opacity', m.opacity);
    const b = builders[m.type];
    if (b) b(g, m, opts || {});
    // earlier work days render grayed (forced by export, or live from day mode)
    const gray = opts && opts.gray != null ? opts.gray : State.dayStateOf(m) === 'gray';
    if (gray) {
      g.style.filter = 'grayscale(100%)';
      g.setAttribute('opacity', (m.opacity != null ? m.opacity : 1) * 0.4);
    }
    return g;
  }

  /** Full redraw of the current page's markups. */
  function drawPage() {
    const overlay = Viewer.el.overlay;
    overlay.innerHTML = '';
    elMap.clear();
    for (const m of State.pageMarkups(State.S.page)) {
      if (State.dayStateOf(m) === 'hidden') continue;   // future work days
      const g = buildMarkupEl(m);
      overlay.appendChild(g);
      elMap.set(m.id, g);
    }
    drawSelection();
  }

  /** Re-render specific markups in place (add if new, drop if gone). */
  function refresh(ids) {
    const overlay = Viewer.el.overlay;
    for (const id of ids) {
      const m = State.getMarkup(id);
      const old = elMap.get(id);
      if (!m || m.page !== State.S.page || State.dayStateOf(m) === 'hidden') {
        if (old) { old.remove(); elMap.delete(id); }
        continue;
      }
      const g = buildMarkupEl(m);
      if (old) { overlay.replaceChild(g, old); }
      else overlay.appendChild(g);
      elMap.set(id, g);
    }
    drawSelection();
  }

  /* ================= selection layer ================= */

  /** Visible handle + an invisible, finger-sized hit circle on top (touch-friendly). */
  function appendHandle(layer, x, y, kind, id, idx) {
    const z = State.S.zoom;
    const mk = (r, attrs) => {
      const c = svg('circle', { cx: x, cy: y, r, ...attrs });
      c.classList.add('handle');
      c.dataset.kind = kind; c.dataset.hid = id;
      if (idx != null) c.dataset.idx = idx;
      return c;
    };
    layer.appendChild(mk(4.6 / z, { fill: '#ffffff', stroke: '#1f6fd0', 'stroke-width': 1.6 / z }));
    layer.appendChild(mk(14 / z, { fill: '#000000', 'fill-opacity': 0, stroke: 'none', 'pointer-events': 'all' }));
  }

  function drawSelection() {
    const layer = Viewer.el.sel;
    layer.innerHTML = '';
    const z = State.S.zoom;
    // handles are only interactive with the Select tool — while a drawing tool is
    // active they'd sit over snap points and swallow clicks
    const withHandles = State.S.tool === 'select';
    for (const m of State.selectedMarkups()) {
      if (m.page !== State.S.page) continue;
      const b = Geo.markupBounds(m);
      layer.appendChild(svg('rect', {
        x: b.x, y: b.y, width: b.w, height: b.h,
        fill: 'none', stroke: '#1f6fd0', 'stroke-width': 1.2 / z,
        'stroke-dasharray': `${5 / z} ${4 / z}`,
      }));
      if (!withHandles) continue;
      // vertex handles
      if (m.pts) {
        m.pts.forEach((p, i) => appendHandle(layer, p.x, p.y, 'pt', m.id, i));
      } else if (m.type === 'callout') {
        appendHandle(layer, m.anchor.x, m.anchor.y, 'anchor', m.id);
        for (const [kind, hx, hy] of rectHandles(m)) appendHandle(layer, hx, hy, kind, m.id);
      } else if (m.w != null) {
        for (const [kind, hx, hy] of rectHandles(m)) appendHandle(layer, hx, hy, kind, m.id);
      }
    }
  }

  function rectHandles(m) {
    return [
      ['nw', m.x, m.y], ['ne', m.x + m.w, m.y],
      ['se', m.x + m.w, m.y + m.h], ['sw', m.x, m.y + m.h],
    ];
  }

  return { buildMarkupEl, drawPage, refresh, drawSelection, measureLabel, wrapText, textWidth };
})();
