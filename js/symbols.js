/* ============ symbols.js — compressed-air symbol library, stamps, pipe presets ============
 * Each symbol draws centered on (0,0) in a nominal box of `s` × `s` page units.
 * Strokes use currentColor so the markup color flows through; a translucent
 * white backing keeps glyphs readable over dense linework.
 */
'use strict';

const Symbols = (() => {

  const H = 1.6; // nominal stroke width inside a 24-unit box, scaled by s/24

  const back = (s, shape) => shape === 'none' ? '' :
    `<circle r="${(s * 0.62).toFixed(1)}" fill="#ffffff" fill-opacity="0.72" stroke="none"/>`;

  // helper: scaled stroke width
  const w = s => (H * s / 24).toFixed(2);

  const SYMBOLS = [
    {
      id: 'drop', name: 'Air Drop', short: 'DROP',
      draw: s => { const r = s * 0.42, k = w(s);
        return back(s) +
          `<circle r="${r}" fill="none" stroke="currentColor" stroke-width="${k}"/>` +
          `<path d="M0 ${-r * 1.35} V${r * 0.55} M${-r * 0.4} ${r * 0.05} L0 ${r * 0.55} L${r * 0.4} ${r * 0.05}" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linecap="round" stroke-linejoin="round"/>`; },
    },
    {
      id: 'ballvalve', name: 'Ball Valve', short: 'BV',
      draw: s => { const a = s * 0.42, b = s * 0.26, k = w(s);
        return back(s) +
          `<path d="M${-a} ${-b} L0 0 L${-a} ${b} Z M${a} ${-b} L0 0 L${a} ${b} Z" fill="currentColor" stroke="currentColor" stroke-width="${k}" stroke-linejoin="round"/>` +
          `<path d="M0 0 V${-s * 0.42} M${-s * 0.16} ${-s * 0.42} H${s * 0.16}" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linecap="round"/>`; },
    },
    {
      id: 'gatevalve', name: 'Shut-off Valve', short: 'SOV',
      draw: s => { const a = s * 0.42, b = s * 0.28, k = w(s);
        return back(s) +
          `<path d="M${-a} ${-b} L${a} ${b} M${-a} ${b} L${a} ${-b} M${-a} ${-b} V${b} M${a} ${-b} V${b}" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linecap="round" stroke-linejoin="round"/>`; },
    },
    {
      id: 'checkvalve', name: 'Check Valve', short: 'CV',
      draw: s => { const a = s * 0.4, b = s * 0.27, k = w(s);
        return back(s) +
          `<path d="M${-a} ${-b} L${-a} ${b} L${a * 0.7} 0 Z" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linejoin="round"/>` +
          `<path d="M${a * 0.7} ${-b} V${b}" stroke="currentColor" stroke-width="${w(s) * 1.4}" stroke-linecap="round"/>`; },
    },
    {
      id: 'regulator', name: 'Regulator', short: 'REG',
      draw: s => { const r = s * 0.4, k = w(s);
        return back(s) +
          `<circle r="${r}" fill="none" stroke="currentColor" stroke-width="${k}"/>` +
          `<path d="M${-r * 0.55} ${r * 0.35} L${r * 0.55} ${-r * 0.35} M${r * 0.55} ${-r * 0.35} l${-r * 0.34} 0 m${r * 0.34} 0 l0 ${r * 0.34}" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linecap="round"/>` +
          `<path d="M0 ${-r} V${-r * 1.45} M${-r * 0.45} ${-r * 1.45} h${r * 0.9}" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linecap="round"/>`; },
    },
    {
      id: 'filter', name: 'Filter', short: 'FLT',
      draw: s => { const a = s * 0.4, k = w(s);
        return back(s) +
          `<path d="M0 ${-a} L${a} 0 L0 ${a} L${-a} 0 Z" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linejoin="round"/>` +
          `<path d="M${-a * 0.55} 0 H${a * 0.55}" stroke="currentColor" stroke-width="${k}" stroke-dasharray="${s * 0.07} ${s * 0.06}"/>`; },
    },
    {
      id: 'lubricator', name: 'Lubricator', short: 'LUB',
      draw: s => { const a = s * 0.4, k = w(s);
        return back(s) +
          `<path d="M0 ${-a} L${a} 0 L0 ${a} L${-a} 0 Z" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linejoin="round"/>` +
          `<path d="M0 ${-a * 0.38} c ${a * 0.3} ${a * 0.42} ${a * 0.22} ${a * 0.62} 0 ${a * 0.62} c ${-a * 0.22} 0 ${-a * 0.3} ${-a * 0.2} 0 ${-a * 0.62} Z" fill="currentColor" stroke="none"/>`; },
    },
    {
      id: 'frl', name: 'FRL Set', short: 'FRL',
      draw: s => { const a = s * 0.3, k = w(s), g = s * 0.34;
        const dia = (cx) => `<path d="M${cx} ${-a} L${cx + a} 0 L${cx} ${a} L${cx - a} 0 Z" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linejoin="round"/>`;
        return `<rect x="${-s * 0.7}" y="${-s * 0.5}" width="${s * 1.4}" height="${s}" fill="#ffffff" fill-opacity="0.72" stroke="none"/>` +
          dia(-g) + dia(0) + dia(g) +
          `<path d="M${-s * 0.68} 0 H${-g - a} M${g + a} 0 H${s * 0.68}" stroke="currentColor" stroke-width="${k}"/>`; },
    },
    {
      id: 'drain', name: 'Auto Drain', short: 'AD',
      draw: s => { const a = s * 0.36, k = w(s);
        return back(s) +
          `<path d="M${-a} ${-a * 0.8} H${a} L0 ${a * 0.45} Z" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linejoin="round"/>` +
          `<path d="M0 ${a * 0.45} V${a * 1.1}" stroke="currentColor" stroke-width="${k}" stroke-linecap="round"/>` +
          `<circle cx="0" cy="${a * 1.45}" r="${s * 0.05}" fill="currentColor" stroke="none"/>`; },
    },
    {
      id: 'coupler', name: 'Quick Coupler', short: 'QC',
      draw: s => { const r = s * 0.3, k = w(s);
        return back(s) +
          `<path d="M${-r * 0.35} ${-r} A ${r} ${r} 0 0 0 ${-r * 0.35} ${r} M${r * 0.35} ${-r} A ${r} ${r} 0 0 1 ${r * 0.35} ${r}" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linecap="round"/>` +
          `<path d="M${-s * 0.62} 0 H${-r * 1.1} M${r * 1.1} 0 H${s * 0.62}" stroke="currentColor" stroke-width="${k}" stroke-linecap="round"/>`; },
    },
    {
      id: 'union', name: 'Union', short: 'UN',
      draw: s => { const k = w(s), h = s * 0.34;
        return back(s) +
          `<path d="M${-s * 0.14} ${-h} V${h} M${s * 0.14} ${-h} V${h}" stroke="currentColor" stroke-width="${k * 1.3}" stroke-linecap="round"/>` +
          `<path d="M${-s * 0.55} 0 H${-s * 0.14} M${s * 0.14} 0 H${s * 0.55}" stroke="currentColor" stroke-width="${k}"/>`; },
    },
    {
      id: 'gauge', name: 'Pressure Gauge', short: 'PG',
      draw: s => { const r = s * 0.34, k = w(s);
        return back(s) +
          `<circle cy="${-s * 0.12}" r="${r}" fill="none" stroke="currentColor" stroke-width="${k}"/>` +
          `<path d="M0 ${-s * 0.12} L${r * 0.55} ${-s * 0.12 - r * 0.55}" stroke="currentColor" stroke-width="${k}" stroke-linecap="round"/>` +
          `<path d="M0 ${-s * 0.12 + r} V${s * 0.5}" stroke="currentColor" stroke-width="${k}"/>`; },
    },
    {
      id: 'flowmeter', name: 'Flow Meter', short: 'FM',
      draw: s => { const r = s * 0.4, k = w(s);
        return back(s) +
          `<circle r="${r}" fill="none" stroke="currentColor" stroke-width="${k}"/>` +
          `<text y="${r * 0.32}" text-anchor="middle" font-family="Arial" font-weight="bold" font-size="${r * 0.9}" fill="currentColor" stroke="none">FM</text>`; },
    },
    {
      id: 'compressor', name: 'Compressor', short: 'COMP',
      draw: s => { const r = s * 0.44, k = w(s);
        return back(s) +
          `<circle r="${r}" fill="none" stroke="currentColor" stroke-width="${k}"/>` +
          `<text y="${r * 0.36}" text-anchor="middle" font-family="Arial" font-weight="bold" font-size="${r}" fill="currentColor" stroke="none">C</text>` +
          `<path d="M${-r * 0.85} ${r * 1.15} H${r * 0.85}" stroke="currentColor" stroke-width="${k}" stroke-linecap="round"/>`; },
    },
    {
      id: 'receiver', name: 'Receiver Tank', short: 'RCVR',
      draw: s => { const k = w(s), rw = s * 0.3, rh = s * 0.46;
        return back(s) +
          `<rect x="${-rw}" y="${-rh}" width="${rw * 2}" height="${rh * 2}" rx="${rw * 0.9}" fill="none" stroke="currentColor" stroke-width="${k}"/>` +
          `<path d="M${-rw * 0.55} ${rh * 1.25} H${rw * 0.55} M${-rw * 0.35} ${rh} V${rh * 1.25} M${rw * 0.35} ${rh} V${rh * 1.25}" stroke="currentColor" stroke-width="${k}"/>`; },
    },
    {
      id: 'dryer', name: 'Air Dryer', short: 'DRY',
      draw: s => { const a = s * 0.4, k = w(s);
        return back(s) +
          `<rect x="${-a}" y="${-a}" width="${a * 2}" height="${a * 2}" rx="${s * 0.05}" fill="none" stroke="currentColor" stroke-width="${k}"/>` +
          `<path d="M0 ${-a * 0.6} V${a * 0.6} M${-a * 0.52} ${-a * 0.3} L${a * 0.52} ${a * 0.3} M${-a * 0.52} ${a * 0.3} L${a * 0.52} ${-a * 0.3}" stroke="currentColor" stroke-width="${k}" stroke-linecap="round"/>`; },
    },
    {
      id: 'elbow', name: 'Elbow 90°', short: 'ELL',
      draw: s => { const a = s * 0.4, k = w(s) * 1.25;
        return back(s) +
          `<path d="M${-a} ${-a * 0.9} V0 A ${a * 0.9} ${a * 0.9} 0 0 0 ${a * 0.05} ${a * 0.9} H${a}" transform="rotate(-90)" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linecap="round"/>`; },
    },
    {
      id: 'tee', name: 'Tee', short: 'TEE',
      draw: s => { const a = s * 0.42, k = w(s) * 1.25;
        return back(s) +
          `<path d="M${-a} 0 H${a} M0 0 V${a}" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linecap="round"/>`; },
    },
    {
      id: 'reducer', name: 'Reducer', short: 'RED',
      draw: s => { const k = w(s), a = s * 0.4;
        return back(s) +
          `<path d="M${-a} ${-s * 0.3} L${a} ${-s * 0.12} V${s * 0.12} L${-a} ${s * 0.3} Z" fill="none" stroke="currentColor" stroke-width="${k}" stroke-linejoin="round"/>`; },
    },
  ];

  /** Text stamps (Bluebeam-style). Rendered by render.js as bordered text pills. */
  const STAMPS = [
    { id: 'st-asbuilt',  text: 'AS-BUILT',     color: '#e02020' },
    { id: 'st-installed',text: 'INSTALLED',    color: '#1d9e45' },
    { id: 'st-removed',  text: 'REMOVED',      color: '#e02020' },
    { id: 'st-relocated',text: 'RELOCATED',    color: '#e8820c' },
    { id: 'st-verify',   text: 'FIELD VERIFY', color: '#1f6fd0' },
  ];

  const byId = id => SYMBOLS.find(s => s.id === id) || null;
  const stampById = id => STAMPS.find(s => s.id === id) || null;

  /* ---- pipe presets ---- */
  const PIPE_SIZES = ['1/4"', '3/8"', '1/2"', '3/4"', '1"', '1-1/4"', '1-1/2"', '2"', '2-1/2"', '3"', '4"', '6"'];
  const PIPE_COLORS = {
    '1/4"': '#8d6e63', '3/8"': '#c2185b', '1/2"': '#e53935', '3/4"': '#f57c00',
    '1"': '#c9a212', '1-1/4"': '#43a047', '1-1/2"': '#00897b', '2"': '#1e88e5',
    '2-1/2"': '#5e35b1', '3"': '#d81b60', '4"': '#6d4c41', '6"': '#3949ab',
  };
  const MATERIALS = ['Aluminum', 'Copper L', 'Black Iron', 'Galvanized', 'Stainless', 'HDPE/Poly', 'Rubber Hose'];
  const SYSTEMS = ['Main Header', 'Branch', 'Drop', 'Condensate', 'Vacuum', 'Nitrogen'];

  /** Default palette for generic markups. */
  const COLORS = ['#e02020', '#e8820c', '#c9a212', '#1d9e45', '#00897b', '#1f6fd0', '#5e35b1', '#d81b60', '#111111', '#ffffff'];

  /** Count-group marker shapes. */
  const COUNT_SHAPES = ['circle', 'square', 'diamond', 'triangle', 'cross'];
  function countShapeSvg(shape, r, color, sw = 1.8) {
    const f = `fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="${sw}"`;
    switch (shape) {
      case 'square':   return `<rect x="${-r}" y="${-r}" width="${2 * r}" height="${2 * r}" ${f}/>`;
      case 'diamond':  return `<path d="M0 ${-r * 1.2} L${r * 1.2} 0 L0 ${r * 1.2} L${-r * 1.2} 0 Z" ${f}/>`;
      case 'triangle': return `<path d="M0 ${-r * 1.25} L${r * 1.2} ${r} L${-r * 1.2} ${r} Z" ${f}/>`;
      case 'cross':    return `<path d="M${-r} ${-r} L${r} ${r} M${-r} ${r} L${r} ${-r}" fill="none" stroke="${color}" stroke-width="${sw * 1.5}" stroke-linecap="round"/>`;
      case 'circle':
      default:         return `<circle r="${r}" ${f}/>`;
    }
  }

  return { SYMBOLS, STAMPS, byId, stampById, PIPE_SIZES, PIPE_COLORS, MATERIALS, SYSTEMS, COLORS, COUNT_SHAPES, countShapeSvg };
})();
