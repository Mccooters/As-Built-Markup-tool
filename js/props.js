/* ============ props.js — right panel: properties, symbol palette, takeoff ============ */
'use strict';

const Props = (() => {

  const q = sel => document.querySelector(sel);
  let propsRoot, symbolsRoot, takeoffRoot;

  const S = () => State.S;
  const D = () => State.S.defaults;

  /* ================= tab switching ================= */

  function showTab(name) {
    document.querySelectorAll('#rightPanel .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('#rightPanel .tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  }

  /* ================= helpers ================= */

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  function swatchesHtml(current) {
    return `<div class="swatches">` +
      Symbols.COLORS.map(c =>
        `<div class="swatch${c.toLowerCase() === (current || '').toLowerCase() ? ' active' : ''}" data-color="${c}" style="background:${c}" title="${c}"></div>`
      ).join('') +
      `<div class="swatch custom" title="Custom color…">✛<input type="color" value="${/^#[0-9a-f]{6}$/i.test(current || '') ? current : '#e02020'}"></div>` +
      `</div>`;
  }

  /** Apply a patch to selection (undoable) or to defaults when nothing is selected. */
  function apply(patch, alsoDefaults) {
    const sel = [...S().selection];
    if (sel.length) {
      State.updateMarkups(sel, patch);
      if (alsoDefaults) Object.assign(D(), patch);
    } else {
      Object.assign(D(), typeof patch === 'function' ? {} : patch);
    }
  }

  /** Live slider: one undo snapshot per drag interaction. */
  function bindLive(input, valEl, fn) {
    let pushed = false;
    input.addEventListener('input', () => {
      const sel = [...S().selection];
      if (sel.length && !pushed) { State.pushUndo(); pushed = true; }
      fn(parseFloat(input.value), true);
      if (valEl) valEl.textContent = input.value;
    });
    input.addEventListener('change', () => { pushed = false; fn(parseFloat(input.value), false); });
  }

  /* ================= PROPERTIES TAB ================= */

  function renderProps() {
    const sel = State.selectedMarkups();
    propsRoot.innerHTML = sel.length ? propsForSelection(sel) : propsForTool();
    wireProps(sel);
  }

  function commonRows(o, opts = {}) {
    let h = '';
    if (!opts.noColor) {
      h += `<div class="prop-section"><div class="prop-cap">Color</div>${swatchesHtml(o.color)}</div>`;
    }
    if (!opts.noStroke) {
      if (!opts.noWidth) h += `<div class="prop-row"><label>Line width</label><input type="range" id="p-lw" min="0.5" max="10" step="0.5" value="${o.lineWidth ?? 2.5}"><span class="val" id="p-lw-v">${o.lineWidth ?? 2.5}</span></div>`;
      h += `<div class="prop-row"><label>Opacity</label><input type="range" id="p-op" min="0.15" max="1" step="0.05" value="${o.opacity ?? 1}"><span class="val" id="p-op-v">${o.opacity ?? 1}</span></div>`;
      h += `<div class="prop-row"><label>Line style</label><select id="p-ls">
        <option value="solid"${o.lineStyle === 'dash' || o.lineStyle === 'dot' ? '' : ' selected'}>Solid</option>
        <option value="dash"${o.lineStyle === 'dash' ? ' selected' : ''}>Dashed</option>
        <option value="dot"${o.lineStyle === 'dot' ? ' selected' : ''}>Dotted</option></select></div>`;
    }
    return h;
  }

  /** True-scale width state for a markup-or-defaults object ('scale' unless explicitly fixed). */
  const pipeScaleMode = o => (o.widthMode || D().pipeWidthMode || 'scale') !== 'fixed';

  function pipeWidthInfo(o) {
    const size = o.pipeSize || D().pipeSize, mat = o.material || D().material;
    const odIn = Symbols.pipeOdInches(size, mat);
    const odStr = Symbols.pipeOdLabel(size, mat);
    const sc = State.scaleForPage(S().page);
    if (!pipeScaleMode(o)) return `Fixed width — un-tick to draw at the true ${odStr} OD.`;
    if (!sc) return `⚠ OD ${odStr} — set the sheet scale and this pipe will draw at its true width (fixed width until then).`;
    const units = (odIn / 12) / sc.ftPerUnit;
    return `OD ${odStr} → ${units.toFixed(1)} pt line at ${Units.scaleLabel(sc)}.`;
  }

  function pipeSizeOptions(current) {
    const opts = arr => arr.map(s => `<option${s === current ? ' selected' : ''}>${esc(s)}</option>`).join('');
    return `<optgroup label="Imperial (NPS)">${opts(Symbols.PIPE_SIZES_IN)}</optgroup>` +
      `<optgroup label="Metric tube (OD mm)">${opts(Symbols.PIPE_SIZES_MM)}</optgroup>` +
      `<optgroup label="Metric steel (DN)">${opts(Symbols.PIPE_SIZES_DN)}</optgroup>`;
  }

  function pipeRows(o) {
    return `<div class="prop-section"><div class="prop-cap">Pipe</div>
      <div class="prop-row"><label>Size</label><select id="p-psize">${pipeSizeOptions(o.pipeSize)}</select></div>
      <div class="prop-row"><label>Material</label><select id="p-pmat">${Symbols.MATERIALS.map(s => `<option${s === o.material ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
      <div class="prop-row"><label>System</label><select id="p-psys">${Symbols.SYSTEMS.map(s => `<option${s === o.system ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
      <div class="prop-row"><label></label><label class="chk"><input type="checkbox" id="p-pscalew"${pipeScaleMode(o) ? ' checked' : ''}> True-scale line width (actual OD)</label></div>
      <p class="prop-note" id="p-podinfo">${esc(pipeWidthInfo(o))}</p>
      <div class="prop-row"><label></label><label class="chk"><input type="checkbox" id="p-pcolor"${D().colorBySize ? ' checked' : ''}> Color by pipe size</label></div>
      <div class="prop-row"><label></label><label class="chk"><input type="checkbox" id="p-portho"${D().orthoPipe ? ' checked' : ''}> Snap to 45° angles (Shift inverts)</label></div>
      <div class="prop-row"><label></label><label class="chk"><input type="checkbox" id="p-plabel"${o.showLabel !== false ? ' checked' : ''}> Show size &amp; length label</label></div>
    </div>`;
  }

  function propsForTool() {
    const t = S().tool;
    const d = D();
    let h = `<div class="prop-cap">Tool defaults — ${esc(toolName(t))}</div>`;

    if (t === 'pipe') {
      h += pipeRows(d) + commonRows(d, { noColor: d.colorBySize, noWidth: pipeScaleMode(d) });
      if (d.colorBySize) h += `<p class="prop-note">Color follows pipe size (see legend in Takeoff tab). Un-tick “Color by pipe size” to pick your own.</p>`;
    } else if (t === 'count') {
      h += countGroupsHtml();
    } else if (t === 'calibrate') {
      h += `<p class="prop-note">Click two points a known distance apart, then type the real distance (e.g. <b>25'</b> or <b>7.6m</b>).<br><br>No reference dimension on the sheet? Type the drawing's stated scale instead:</p>
        <div style="margin:6px 0 10px"><button class="mini-btn primary" id="p-scaledlg">Enter scale ratio…</button></div>
        <div class="prop-row"><label>Preset</label><select id="p-preset"><option value="">choose…</option>${Units.SCALE_PRESETS.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select></div>
        <div class="prop-row"><label></label><label class="chk"><input type="checkbox" id="p-preset-all" checked> Apply to all pages</label></div>`;
    } else if (t === 'text' || t === 'callout') {
      h += commonRows(d, { noStroke: true });
      h += `<div class="prop-row"><label>Font size</label><input type="number" id="p-fs" min="6" max="72" value="${d.fontSize}"></div>`;
      h += `<div class="prop-row"><label>Line width</label><input type="range" id="p-lw" min="0.5" max="10" step="0.5" value="${d.lineWidth}"><span class="val" id="p-lw-v">${d.lineWidth}</span></div>`;
    } else if (t === 'symbol') {
      h += `<p class="prop-note">Pick a symbol or stamp in the <b>Symbols</b> tab, then click the drawing to place it. Press <kbd>R</kbd> to rotate.</p>` + commonRows(d, { noStroke: true });
    } else if (t === 'highlight') {
      h += `<div class="prop-section"><div class="prop-cap">Color</div>${swatchesHtml(d.highlightColor)}</div>
        <div class="prop-row"><label>Width</label><input type="range" id="p-hlw" min="6" max="40" step="1" value="${d.highlightWidth}"><span class="val" id="p-hlw-v">${d.highlightWidth}</span></div>`;
    } else if (t === 'select' || t === 'pan') {
      h = `<div class="prop-cap">Properties</div><p class="prop-note">Nothing selected.<br><br>Select markups to edit their color, size, pipe data or notes here. Defaults for each drawing tool appear when that tool is active.</p>`;
    } else {
      h += commonRows(d);
      if (t === 'rect' || t === 'ellipse' || t === 'cloud' || t === 'marea') h += fillRows(d);
      if (t === 'cloud') h += `<div class="prop-row"><label>Scallop size</label><input type="range" id="p-arc" min="6" max="40" step="1" value="${d.arcSize}"><span class="val" id="p-arc-v">${d.arcSize}</span></div>`;
    }
    return h;
  }

  function fillRows(o) {
    const isNone = !o.fill || o.fill === 'none';
    return `<div class="prop-section"><div class="prop-cap">Fill</div>
      <div class="prop-row"><label>Fill</label><select id="p-fill">
        <option value="none"${isNone ? ' selected' : ''}>None</option>
        <option value="color"${isNone ? '' : ' selected'}>Color</option></select></div>
      ${isNone ? '' : `<div class="prop-row"><label>Fill opacity</label><input type="range" id="p-fop" min="0.05" max="1" step="0.05" value="${o.fillOpacity ?? 0.2}"><span class="val" id="p-fop-v">${o.fillOpacity ?? 0.2}</span></div>`}
    </div>`;
  }

  function propsForSelection(sel) {
    const first = sel[0];
    const types = new Set(sel.map(m => m.type));
    let h = `<div class="prop-cap">${sel.length === 1 ? esc(typeName(first.type)) : sel.length + ' markups selected'}</div>`;

    if (sel.length === 1) {
      const meas = Render.measureLabel(first);
      if (meas) h += `<p class="prop-note" style="font-size:13px"><b>${esc(meas)}</b>${first.type === 'pipe' ? ' of ' + esc(first.pipeSize) + ' ' + esc(first.material || '') : ''}</p>`;
      h += `<div class="prop-row"><label>Subject</label><input type="text" id="p-subject" value="${esc(first.subject)}"></div>`;
      h += `<div class="prop-row"><label>Comment</label><textarea id="p-comment" rows="2">${esc(first.comment)}</textarea></div>`;
    }

    const hasPipe = types.has('pipe');
    if (hasPipe) h += pipeRows(first);

    const textish = types.has('text') || types.has('callout');
    if (textish) h += `<div class="prop-row"><label>Font size</label><input type="number" id="p-fs" min="6" max="72" value="${first.fontSize || 12}"></div>`;

    const symbolish = types.has('symbol') || types.has('stamp');
    if (symbolish) {
      h += `<div class="prop-row"><label>Size</label><input type="range" id="p-ssize" min="10" max="90" step="1" value="${first.size || 26}"><span class="val" id="p-ssize-v">${first.size || 26}</span></div>`;
      h += `<div class="prop-row"><label>Rotation</label><input type="number" id="p-rot" min="0" max="359" step="15" value="${first.rotation || 0}"> <span class="val">deg</span></div>`;
      if (types.has('symbol')) h += `<div class="prop-row"><label></label><label class="chk"><input type="checkbox" id="p-slabel"${first.showLabel !== false ? ' checked' : ''}> Show label</label></div>`;
    }

    h += commonRows(first, { noColor: hasPipe && D().colorBySize, noWidth: hasPipe && pipeScaleMode(first) });

    const closed = ['rect', 'ellipse', 'cloud', 'marea'].some(t => types.has(t));
    if (closed) h += fillRows(first);
    if (types.has('cloud')) h += `<div class="prop-row"><label>Scallop size</label><input type="range" id="p-arc" min="6" max="40" step="1" value="${first.arcSize || 14}"><span class="val" id="p-arc-v">${first.arcSize || 14}</span></div>`;
    if (['pipe', 'mlength', 'mpoly', 'marea'].some(t => types.has(t)) && !hasPipe) {
      h += `<div class="prop-row"><label></label><label class="chk"><input type="checkbox" id="p-plabel"${first.showLabel !== false ? ' checked' : ''}> Show measurement label</label></div>`;
    }

    h += `<div class="prop-row" style="margin-top:14px"><button class="mini-btn danger" id="p-delete">Delete (${sel.length})</button>
          <button class="mini-btn" id="p-dup" title="Duplicate (Ctrl+D)">Duplicate</button></div>`;
    return h;
  }

  function wireProps(sel) {
    const root = propsRoot;
    const has = id => root.querySelector(id);

    // color swatches
    root.querySelectorAll('.swatch[data-color]').forEach(sw => {
      sw.addEventListener('click', () => {
        const c = sw.dataset.color;
        if (S().tool === 'highlight' && !sel.length) { D().highlightColor = c; renderProps(); return; }
        apply({ color: c });
        renderProps();
      });
    });
    const custom = root.querySelector('.swatch.custom input');
    if (custom) custom.addEventListener('input', () => {
      if (S().tool === 'highlight' && !sel.length) { D().highlightColor = custom.value; return; }
      apply({ color: custom.value });
    });

    if (has('#p-lw')) bindLive(has('#p-lw'), has('#p-lw-v'), v => apply({ lineWidth: v }));
    if (has('#p-op')) bindLive(has('#p-op'), has('#p-op-v'), v => apply({ opacity: v }));
    if (has('#p-hlw')) bindLive(has('#p-hlw'), has('#p-hlw-v'), v => { D().highlightWidth = v; });
    if (has('#p-arc')) bindLive(has('#p-arc'), has('#p-arc-v'), v => apply({ arcSize: v }));
    if (has('#p-ssize')) bindLive(has('#p-ssize'), has('#p-ssize-v'), v => apply({ size: v }));
    if (has('#p-ls')) has('#p-ls').addEventListener('change', e => apply({ lineStyle: e.target.value }));
    if (has('#p-fs')) has('#p-fs').addEventListener('change', e => apply({ fontSize: Math.max(6, parseFloat(e.target.value) || 12) }));
    if (has('#p-rot')) has('#p-rot').addEventListener('change', e => apply({ rotation: (parseFloat(e.target.value) || 0) % 360 }));
    if (has('#p-slabel')) has('#p-slabel').addEventListener('change', e => { apply({ showLabel: e.target.checked }); D().symbolLabel = e.target.checked; });
    if (has('#p-plabel')) has('#p-plabel').addEventListener('change', e => apply({ showLabel: e.target.checked }));

    if (has('#p-subject')) has('#p-subject').addEventListener('change', e => apply({ subject: e.target.value }));
    if (has('#p-comment')) has('#p-comment').addEventListener('change', e => apply({ comment: e.target.value }));

    // pipe fields — sticky: also update tool defaults
    const pipePatch = patch => {
      const p = { ...patch };
      if (D().colorBySize && p.pipeSize) p.color = Symbols.PIPE_COLORS[p.pipeSize] || D().color;
      if (p.pipeSize) p.subject = `Pipe ${p.pipeSize}`;
      const sels = [...S().selection];
      if (sels.length) {
        State.updateMarkups(sels, m => m.type === 'pipe' ? p : {});
      }
      Object.assign(D(), patch);
      renderProps();
    };
    if (has('#p-psize')) has('#p-psize').addEventListener('change', e => pipePatch({ pipeSize: e.target.value }));
    if (has('#p-pmat')) has('#p-pmat').addEventListener('change', e => pipePatch({ material: e.target.value }));
    if (has('#p-psys')) has('#p-psys').addEventListener('change', e => pipePatch({ system: e.target.value }));
    if (has('#p-pscalew')) has('#p-pscalew').addEventListener('change', e => {
      const wm = e.target.checked ? 'scale' : 'fixed';
      D().pipeWidthMode = wm;
      const sels = [...S().selection];
      if (sels.length) State.updateMarkups(sels, m => m.type === 'pipe' ? { widthMode: wm } : {});
      renderProps();
    });
    if (has('#p-pcolor')) has('#p-pcolor').addEventListener('change', e => {
      D().colorBySize = e.target.checked;
      if (e.target.checked) pipePatch({ pipeSize: has('#p-psize') ? has('#p-psize').value : D().pipeSize });
      else renderProps();
    });
    if (has('#p-portho')) has('#p-portho').addEventListener('change', e => { D().orthoPipe = e.target.checked; });

    if (has('#p-fill')) has('#p-fill').addEventListener('change', e => {
      const v = e.target.value === 'none' ? 'none' : (sel[0] ? sel[0].color : D().color);
      apply(m => ({ fill: v === 'none' ? 'none' : m.color }));
      if (!sel.length) D().fill = v;
      renderProps();
    });
    if (has('#p-fop')) bindLive(has('#p-fop'), has('#p-fop-v'), v => apply({ fillOpacity: v }));

    if (has('#p-scaledlg')) has('#p-scaledlg').addEventListener('click', () => App.scaleDialog());
    if (has('#p-preset')) has('#p-preset').addEventListener('change', e => {
      const p = Units.SCALE_PRESETS.find(x => x.id === e.target.value);
      if (!p) return;
      const all = has('#p-preset-all') ? has('#p-preset-all').checked : true;
      State.setScale(S().page, Units.presetFtPerUnit(p), all, p.label);
      App.toast(`Scale set to ${p.label}${all ? ' (all pages)' : ''}`, 'ok');
      State.setTool('select');
    });

    if (has('#p-delete')) has('#p-delete').addEventListener('click', () => State.deleteMarkups([...S().selection]));
    if (has('#p-dup')) has('#p-dup').addEventListener('click', () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true }));
    });

    // count groups
    root.querySelectorAll('.count-group-row[data-gid]').forEach(row => {
      row.addEventListener('click', () => { S().activeCountGroup = row.dataset.gid; renderProps(); });
    });
    if (has('#p-newgroup')) has('#p-newgroup').addEventListener('click', () => App.countGroupDialog());
  }

  function countGroupsHtml() {
    const groups = S().countGroups;
    let h = `<div class="prop-cap">Count groups</div>`;
    if (!groups.length) h += `<p class="prop-note">No count groups yet. Create one for each thing you're counting (drops, couplers, elbows…).</p>`;
    for (const g of groups) {
      h += `<div class="count-group-row${g.id === S().activeCountGroup ? ' active' : ''}" data-gid="${g.id}">
        <span class="count-dot" style="background:${g.color}"></span>
        <span>${esc(g.name)}</span><span class="cnt">${State.countOfGroup(g.id)}</span></div>`;
    }
    h += `<div style="margin-top:10px"><button class="mini-btn primary" id="p-newgroup">+ New count group</button></div>`;
    return h;
  }

  /* ================= SYMBOLS TAB ================= */

  function renderSymbols() {
    const d = D();
    let h = `<div class="prop-cap">Compressed air symbols</div>
      <div class="prop-row"><label>Size</label><input type="range" id="sym-size" min="12" max="80" step="1" value="${d.symbolSize}"><span class="val" id="sym-size-v">${d.symbolSize}</span></div>
      <div class="prop-row"><label></label><label class="chk"><input type="checkbox" id="sym-label"${d.symbolLabel ? ' checked' : ''}> Show name label</label></div>
      <div class="sym-grid">`;
    for (const sym of Symbols.SYMBOLS) {
      h += `<div class="sym-cell${S().activeSymbol === sym.id ? ' active' : ''}" data-sym="${sym.id}" title="${esc(sym.name)}">
        <svg viewBox="-16 -16 32 32" color="${S().activeSymbol === sym.id ? '#fff' : '#d7dbe2'}">${sym.draw(24)}</svg>
        <span class="sym-name">${esc(sym.name)}</span></div>`;
    }
    h += `</div><div class="prop-cap" style="margin-top:14px">Stamps</div><div class="sym-grid">`;
    for (const st of Symbols.STAMPS) {
      h += `<div class="sym-cell stamp-cell${S().activeSymbol === st.id ? ' active' : ''}" data-sym="${st.id}">
        <span class="stamp-pill" style="color:${st.color};border-color:${st.color}">${esc(st.text)}</span></div>`;
    }
    h += `</div><p class="prop-note" style="margin-top:10px">Click a symbol, then click the drawing to place it. <kbd>R</kbd> rotates before placing.</p>`;
    symbolsRoot.innerHTML = h;

    symbolsRoot.querySelectorAll('.sym-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        S().activeSymbol = cell.dataset.sym;
        S().symbolRotation = 0;
        State.setTool('symbol');
        renderSymbols();
      });
    });
    const size = symbolsRoot.querySelector('#sym-size');
    bindLive(size, symbolsRoot.querySelector('#sym-size-v'), v => {
      D().symbolSize = v;
      const sels = [...S().selection];
      if (sels.length) State.updateMarkups(sels, m => (m.type === 'symbol' || m.type === 'stamp') ? { size: v } : {});
    });
    symbolsRoot.querySelector('#sym-label').addEventListener('change', e => { D().symbolLabel = e.target.checked; });
  }

  /* ================= TAKEOFF TAB ================= */

  function renderTakeoff() {
    const to = MarkupList.computeTakeoff();
    const fmt = S().unitFormat;
    let h = `<div class="prop-cap">Pipe takeoff</div>`;
    if (!to.pipes.length) {
      h += `<p class="prop-note">No pipe runs yet. Draw them with the <b>Pipe run</b> tool (P).</p>`;
    } else {
      h += `<table class="to-table"><tr><th>Size / material</th><th style="text-align:right">Runs</th><th style="text-align:right">Length</th></tr>`;
      for (const r of to.pipes) {
        h += `<tr><td><span class="to-chip" style="background:${r.color}"></span>${esc(r.size)} ${esc(r.material)}</td>
          <td class="num">${r.count}</td>
          <td class="num">${r.totalFt != null ? Units.fmtLen(r.totalFt, fmt) : '<span title="Calibrate the sheet to get lengths">—</span>'}</td></tr>`;
      }
      h += `<tr class="total"><td>Total pipe</td><td class="num">${to.pipeRunCount}</td><td class="num">${to.pipeTotalFt != null ? Units.fmtLen(to.pipeTotalFt, fmt) : '—'}</td></tr></table>`;
    }

    if (to.symbols.length) {
      h += `<div class="prop-cap">Fittings &amp; equipment</div><table class="to-table"><tr><th>Item</th><th style="text-align:right">Qty</th></tr>`;
      for (const r of to.symbols) h += `<tr><td>${esc(r.name)}</td><td class="num">${r.count}</td></tr>`;
      h += `</table>`;
    }
    if (to.counts.length) {
      h += `<div class="prop-cap">Counts</div><table class="to-table"><tr><th>Group</th><th style="text-align:right">Qty</th></tr>`;
      for (const r of to.counts) h += `<tr><td><span class="to-chip" style="background:${r.color};border-radius:50%"></span>${esc(r.name)}</td><td class="num">${r.count}</td></tr>`;
      h += `</table>`;
    }
    if (to.otherMeasures.length) {
      h += `<div class="prop-cap">Other measurements</div><table class="to-table"><tr><th>Measurement</th><th style="text-align:right">Value</th></tr>`;
      for (const r of to.otherMeasures) h += `<tr><td>${esc(r.name)}</td><td class="num">${esc(r.value)}</td></tr>`;
      h += `</table>`;
    }

    const sc = State.scaleForPage(S().page);
    h += `<p class="prop-note" style="margin-top:8px">${sc
      ? `Sheet scale: <b>${esc(Units.scaleLabel(sc))}</b>`
      : `⚠ Sheet scale not set — lengths unavailable. Click the scale button in the status bar to type a ratio, or use the <b>Calibrate</b> tool.`}</p>`;
    h += `<div style="margin-top:8px"><button class="mini-btn" id="to-csv">Export takeoff CSV</button></div>`;

    takeoffRoot.innerHTML = h;
    const csv = takeoffRoot.querySelector('#to-csv');
    if (csv) csv.addEventListener('click', () => MarkupList.exportCsv());
  }

  /* ================= names ================= */

  function toolName(t) {
    return ({
      select: 'Select', pan: 'Pan', pipe: 'Pipe run', calibrate: 'Calibrate', mlength: 'Length',
      mpoly: 'Polylength', marea: 'Area', count: 'Count', line: 'Line', arrow: 'Arrow',
      polyline: 'Polyline', rect: 'Rectangle', ellipse: 'Ellipse', cloud: 'Revision cloud',
      pen: 'Pen', highlight: 'Highlighter', text: 'Text', callout: 'Callout', symbol: 'Symbol',
    })[t] || t;
  }
  function typeName(t) {
    return ({
      pipe: 'Pipe run', mlength: 'Length measurement', mpoly: 'Polylength', marea: 'Area',
      cloud: 'Revision cloud', highlight: 'Highlight', symbol: 'Symbol', stamp: 'Stamp',
      count: 'Count mark', callout: 'Callout', text: 'Text',
    })[t] || (t[0].toUpperCase() + t.slice(1));
  }

  function focusSubject() {
    showTab('props');
    const el = propsRoot.querySelector('#p-subject');
    if (el) { el.focus(); el.select(); }
  }

  /* ================= init ================= */

  function init() {
    propsRoot = q('#tab-props');
    symbolsRoot = q('#tab-symbols');
    takeoffRoot = q('#tab-takeoff');

    document.querySelectorAll('#rightPanel .tab').forEach(t =>
      t.addEventListener('click', () => showTab(t.dataset.tab)));

    let queued = false;
    const refresh = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        renderProps(); renderTakeoff();
      });
    };
    State.on('selection', refresh);
    State.on('tool', () => { renderProps(); if (S().tool === 'symbol') showTab('symbols'); else showTab('props'); });
    State.on('history', refresh);
    State.on('countGroups', refresh);
    State.on('scale', refresh);
    State.on('markups', () => { renderTakeoffThrottled(); });
    State.on('doc', refresh);

    let toTimer = null;
    const renderTakeoffThrottled = () => { clearTimeout(toTimer); toTimer = setTimeout(renderTakeoff, 250); };

    renderProps(); renderSymbols(); renderTakeoff();
  }

  return { init, showTab, renderSymbols, renderProps, renderTakeoff, focusSubject, typeName };
})();
