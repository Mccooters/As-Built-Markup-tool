/* ============ units.js — drawing scales, distance parsing & formatting ============
 * Internal canonical length unit: FEET. Page geometry unit: PDF points (1/72 in).
 * A page scale is stored as { ftPerUnit } — real feet per page unit.
 */
'use strict';

const Units = (() => {

  const FT_PER_M = 3.280839895;

  /** Preset drawing scales — metric ratios first (the standard), imperial after. */
  const SCALE_PRESETS = [
    { id: 'metric-20',  label: '1:20',  ratio: 20 },
    { id: 'metric-25',  label: '1:25',  ratio: 25 },
    { id: 'metric-50',  label: '1:50',  ratio: 50 },
    { id: 'metric-100', label: '1:100', ratio: 100 },
    { id: 'metric-200', label: '1:200', ratio: 200 },
    { id: 'metric-250', label: '1:250', ratio: 250 },
    { id: 'metric-500', label: '1:500', ratio: 500 },
    { id: 'arch-1/16', label: '1/16" = 1\'-0"', ftPerIn: 16 },
    { id: 'arch-3/32', label: '3/32" = 1\'-0"', ftPerIn: 32 / 3 },
    { id: 'arch-1/8',  label: '1/8" = 1\'-0"',  ftPerIn: 8 },
    { id: 'arch-3/16', label: '3/16" = 1\'-0"', ftPerIn: 16 / 3 },
    { id: 'arch-1/4',  label: '1/4" = 1\'-0"',  ftPerIn: 4 },
    { id: 'arch-3/8',  label: '3/8" = 1\'-0"',  ftPerIn: 8 / 3 },
    { id: 'arch-1/2',  label: '1/2" = 1\'-0"',  ftPerIn: 2 },
    { id: 'arch-3/4',  label: '3/4" = 1\'-0"',  ftPerIn: 4 / 3 },
    { id: 'arch-1',    label: '1" = 1\'-0"',    ftPerIn: 1 },
    { id: 'eng-10',    label: '1" = 10\'',      ftPerIn: 10 },
    { id: 'eng-20',    label: '1" = 20\'',      ftPerIn: 20 },
    { id: 'eng-30',    label: '1" = 30\'',      ftPerIn: 30 },
    { id: 'eng-40',    label: '1" = 40\'',      ftPerIn: 40 },
    { id: 'eng-50',    label: '1" = 50\'',      ftPerIn: 50 },
  ];

  /** ftPerUnit for a preset (unit = PDF point = 1/72 inch). */
  function presetFtPerUnit(p) {
    if (p.ftPerIn != null) return p.ftPerIn / 72;
    // metric ratio: 1 paper unit = ratio real units → real inches per point = ratio/72
    return (p.ratio / 72) / 12; // inches → feet
  }

  /** Describe a ftPerUnit value as the nearest known preset label, else custom. */
  function describeScale(ftPerUnit) {
    for (const p of SCALE_PRESETS) {
      const v = presetFtPerUnit(p);
      if (Math.abs(v - ftPerUnit) / v < 0.005) return p.label;
    }
    // near-integer metric ratio (1 pt paper = ratio pt real; 864 pt per real ft)
    const ratio = ftPerUnit * 864;
    const r = Math.round(ratio);
    if (r >= 2 && Math.abs(ratio - r) / ratio < 0.01) return `1:${r}`;
    const ftPerIn = ftPerUnit * 72;
    if (ftPerIn >= 1) return `1" = ${trim(ftPerIn)}'`;
    return `${trim(1 / ftPerIn)}" = 1'-0"`;
  }

  const trim = n => {
    const r = Math.round(n * 100) / 100;
    return Number.isInteger(r) ? String(r) : String(r);
  };

  /**
   * Parse a user-typed real-world distance into feet.
   * Accepts: 12'6", 12' 6", 12'-6", 12.5', 12.5 ft, 150", 30in, 3.5m, 350cm, 4200mm, plain number.
   * Plain numbers are interpreted via `assumeUnit` ('ft' | 'm').
   */
  function parseDistance(str, assumeUnit = 'ft') {
    if (!str) return null;
    let s = String(str).trim().toLowerCase().replace(/,/g, '');
    if (!s) return null;

    // metric
    let m = s.match(/^([\d.]+)\s*(mm|cm|m|meters?|metres?)$/);
    if (m) {
      let v = parseFloat(m[1]);
      if (isNaN(v)) return null;
      if (m[2] === 'mm') v /= 1000;
      else if (m[2] === 'cm') v /= 100;
      return v * FT_PER_M;
    }
    // feet-inches:  12'6"  12' 6"  12'-6"  12ft 6in
    m = s.match(/^([\d.]+)\s*(?:'|ft|feet)\s*[- ]?\s*([\d.]+(?:\s*[\d]\/[\d])?)?\s*(?:"|in|inches)?$/);
    if (m && m[1] != null) {
      const ft = parseFloat(m[1]);
      let inch = 0;
      if (m[2] != null) {
        const frac = m[2].match(/^([\d.]+)\s+(\d)\/(\d+)$/); // 6 1/2
        inch = frac ? parseFloat(frac[1]) + Number(frac[2]) / Number(frac[3]) : parseFloat(m[2]);
      }
      if (isNaN(ft) || isNaN(inch)) return null;
      return ft + inch / 12;
    }
    // inches only:  30"  30in
    m = s.match(/^([\d.]+)\s*(?:"|in|inches)$/);
    if (m) {
      const v = parseFloat(m[1]);
      return isNaN(v) ? null : v / 12;
    }
    // plain number
    const v = parseFloat(s);
    if (isNaN(v)) return null;
    return assumeUnit === 'm' ? v * FT_PER_M : v;
  }

  /** Format a length in feet per display format: 'ftin' | 'ft' | 'm'. */
  function fmtLen(ft, format) {
    if (ft == null || isNaN(ft)) return '—';
    switch (format) {
      case 'm': {
        const v = ft / FT_PER_M;
        return `${v >= 100 ? v.toFixed(1) : v.toFixed(2)} m`;
      }
      case 'ft':
        return `${ft.toFixed(2)}'`;
      case 'ftin':
      default: {
        const sign = ft < 0 ? '-' : '';
        const abs = Math.abs(ft);
        let whole = Math.floor(abs);
        let inches = Math.round((abs - whole) * 12);
        if (inches === 12) { whole += 1; inches = 0; }
        return `${sign}${whole}'-${inches}"`;
      }
    }
  }

  /** Format an area in sq ft per display format. */
  function fmtArea(sqft, format) {
    if (sqft == null || isNaN(sqft)) return '—';
    if (format === 'm') {
      const v = sqft / (FT_PER_M * FT_PER_M);
      return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} m²`;
    }
    return `${sqft >= 100 ? Math.round(sqft).toLocaleString() : sqft.toFixed(1)} sq ft`;
  }

  /** Display label for a page-scale object — user-chosen label wins over the derived one. */
  const scaleLabel = sc => sc ? (sc.label || describeScale(sc.ftPerUnit)) : null;

  return { SCALE_PRESETS, presetFtPerUnit, describeScale, scaleLabel, parseDistance, fmtLen, fmtArea, FT_PER_M };
})();
