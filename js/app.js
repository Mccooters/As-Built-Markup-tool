/* ============ app.js — bootstrapping, toolbar, shortcuts, modals, toasts ============ */
'use strict';

const App = (() => {

  const $ = id => document.getElementById(id);

  /* ================= toasts ================= */

  function toast(msg, kind = 'info', ms = 4200, actions) {
    const root = $('toastRoot');
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    if (actions && actions.length) {
      const row = document.createElement('div');
      row.className = 'toast-actions';
      for (const a of actions) {
        const b = document.createElement('button');
        b.className = 'mini-btn' + (a === actions[0] ? ' primary' : '');
        b.textContent = a.label;
        b.addEventListener('click', () => { t.remove(); a.run(); });
        row.appendChild(b);
      }
      t.appendChild(row);
    }
    root.appendChild(t);
    if (ms > 0) setTimeout(() => t.remove(), ms);
    return t;
  }

  /* ================= modals ================= */

  function modal(html, onOpen) {
    const root = $('modalRoot'), box = $('modalBox');
    box.innerHTML = html;
    root.classList.remove('hidden');
    const close = () => { root.classList.add('hidden'); box.innerHTML = ''; };
    $('modalBackdrop').onclick = close;
    if (onOpen) onOpen(box, close);
    return close;
  }

  function progress(title) {
    const close = modal(`<h3>${title}</h3><p class="muted" id="prog-msg">Starting…</p>
      <div class="progress-bar"><div id="prog-fill"></div></div>`);
    return {
      set(pct, msg) {
        const f = $('prog-fill'), m = $('prog-msg');
        if (f) f.style.width = pct + '%';
        if (m && msg) m.textContent = msg;
      },
      close,
    };
  }

  function calibrateDialog(lenUnits) {
    modal(`
      <h3>Calibrate scale</h3>
      <p class="muted">You marked a line of <b>${lenUnits.toFixed(1)} pt</b> on the sheet. What is that distance in the real world?</p>
      <div class="form-row"><label>Real distance</label>
        <input type="text" id="cal-dist" placeholder="e.g. 25'  ·  12'6&quot;  ·  7.6m" autocomplete="off"></div>
      <div class="form-row"><label class="chk"><input type="checkbox" id="cal-all" checked> Apply to all pages</label></div>
      <p class="muted" id="cal-result"></p>
      <div class="modal-actions">
        <button class="mini-btn" id="cal-cancel">Cancel</button>
        <button class="mini-btn primary" id="cal-ok">Set scale</button>
      </div>`, (box, close) => {
      const input = $('cal-dist'), result = $('cal-result');
      const compute = () => {
        const ft = Units.parseDistance(input.value, State.S.unitFormat === 'm' ? 'm' : 'ft');
        if (ft && ft > 0) {
          const fpu = ft / lenUnits;
          result.innerHTML = `→ sheet scale ≈ <b>${Units.describeScale(fpu)}</b>`;
          return fpu;
        }
        result.textContent = '';
        return null;
      };
      input.addEventListener('input', compute);
      input.focus();
      const ok = () => {
        const fpu = compute();
        if (!fpu) { input.focus(); return; }
        State.setScale(State.S.page, fpu, $('cal-all').checked);
        close();
        State.setTool('select');
        toast(`Scale set: ${Units.describeScale(fpu)}${$('cal-all') ? '' : ''}`, 'ok');
      };
      $('cal-ok').onclick = ok;
      $('cal-cancel').onclick = close;
      input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    });
  }

  /**
   * Direct scale entry — for sheets with no reference dimension to click.
   * Three ways in: standard preset, ratio 1:n, or custom "paper = real".
   */
  function scaleDialog() {
    if (!State.S.pdf) { toast('Open a drawing first.', 'warn'); return; }
    const sc = State.scaleForPage(State.S.page);
    modal(`
      <h3>Set sheet scale</h3>
      <p class="muted">Type the drawing's stated scale — no reference dimension needed. Check the title block (e.g. <b>SCALE: 1/4" = 1'-0"</b> or <b>1:100</b>).${sc ? `<br>Current: <b>${Units.scaleLabel(sc)}</b>` : ''}</p>

      <div class="form-row" style="display:flex;align-items:center;gap:8px">
        <label class="chk" style="flex:0 0 110px"><input type="radio" name="sc-mode" value="preset" checked> Standard</label>
        <select id="sc-preset" style="flex:1">${Units.SCALE_PRESETS.map(p => `<option value="${p.id}">${p.label.replace(/"/g, '&quot;')}</option>`).join('')}</select>
      </div>

      <div class="form-row" style="display:flex;align-items:center;gap:8px">
        <label class="chk" style="flex:0 0 110px"><input type="radio" name="sc-mode" value="ratio"> Ratio</label>
        <span>1 :</span>
        <input type="text" id="sc-ratio" placeholder="e.g. 100" style="width:90px" inputmode="decimal">
        <span class="muted" style="font-size:12px;color:var(--txt-dim)">same units both sides</span>
      </div>

      <div class="form-row" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <label class="chk" style="flex:0 0 110px"><input type="radio" name="sc-mode" value="custom"> Custom</label>
        <input type="text" id="sc-paper" value="1" style="width:52px" inputmode="decimal">
        <select id="sc-punit" style="width:64px"><option value="in">in</option><option value="mm">mm</option></select>
        <span>=</span>
        <input type="text" id="sc-real" placeholder="10" style="width:64px" inputmode="decimal">
        <select id="sc-runit" style="width:64px"><option value="ft">ft</option><option value="in">in</option><option value="m">m</option><option value="mm">mm</option></select>
      </div>

      <div class="form-row"><label class="chk"><input type="checkbox" id="sc-all" checked> Apply to all pages</label></div>
      <p class="muted" id="sc-out" style="min-height:18px"></p>
      <p class="muted" style="font-size:11.5px">⚠ If the PDF was replotted at a different sheet size (half-size sets are common), the stated scale will be wrong — use <b>Measure two points</b> against a known dimension instead.</p>
      <div class="modal-actions">
        <button class="mini-btn" id="sc-measure" title="Click two points a known distance apart">Measure two points…</button>
        <div class="tb-flex"></div>
        <button class="mini-btn" id="sc-cancel">Cancel</button>
        <button class="mini-btn primary" id="sc-ok">Set scale</button>
      </div>`, (box, close) => {

      const mode = () => box.querySelector('input[name="sc-mode"]:checked').value;
      const pick = v => { box.querySelector(`input[name="sc-mode"][value="${v}"]`).checked = true; compute(); };
      // focusing an input selects its mode
      $('sc-preset').addEventListener('focus', () => pick('preset'));
      $('sc-ratio').addEventListener('focus', () => pick('ratio'));
      for (const id of ['sc-paper', 'sc-punit', 'sc-real', 'sc-runit']) $(id).addEventListener('focus', () => pick('custom'));

      const IN_PER = { in: 1, mm: 1 / 25.4, ft: 12, m: 1000 / 25.4 };
      /** → { fpu, label } or null */
      const compute = () => {
        let fpu = null, label = '';
        if (mode() === 'preset') {
          const p = Units.SCALE_PRESETS.find(x => x.id === $('sc-preset').value);
          if (p) { fpu = Units.presetFtPerUnit(p); label = p.label; }
        } else if (mode() === 'ratio') {
          const n = parseFloat($('sc-ratio').value);
          if (n > 0) { fpu = n / 864; label = `1 : ${n}`; }   // 1 pt paper = n pt real; 864 pt per real ft
        } else {
          const pv = parseFloat($('sc-paper').value), rv = parseFloat($('sc-real').value);
          const pu = $('sc-punit').value, ru = $('sc-runit').value;
          if (pv > 0 && rv > 0) {
            const paperPts = pv * IN_PER[pu] * 72;
            const realFt = rv * IN_PER[ru] / 12;
            fpu = realFt / paperPts;
            label = `${pv} ${pu} = ${rv} ${ru}`;
          }
        }
        const out = $('sc-out');
        if (out) out.innerHTML = fpu ? `→ <b>${Units.describeScale(fpu)}</b> &nbsp;(${(fpu * 72).toFixed(3)} ft per paper inch)` : '';
        return fpu ? { fpu, label } : null;
      };
      for (const el of box.querySelectorAll('input, select')) {
        el.addEventListener('input', compute);
        el.addEventListener('change', compute);
        // listeners live on the dialog's own inputs — #modalBox itself is reused across dialogs
        el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('sc-ok').click(); } });
      }
      compute();

      $('sc-ok').onclick = () => {
        const r = compute();
        if (!r) { toast('Enter a valid scale value first.', 'warn'); return; }
        const allPages = $('sc-all').checked;   // read before close() destroys the dialog
        State.setScale(State.S.page, r.fpu, allPages, r.label);
        close();
        toast(`Scale set: ${r.label}${allPages ? ' (all pages)' : ` (page ${State.S.page})`}`, 'ok');
      };
      $('sc-cancel').onclick = close;
      $('sc-measure').onclick = () => {
        close();
        State.setTool('calibrate');
        Props.showTab('props');
        toast('Click two points a known distance apart, then type the real distance.', 'info', 6000);
      };
    });
  }

  function photoLightbox(m) {
    const src = State.S.images[m.imgId];
    if (!src) { toast('This photo\'s image data is missing.', 'warn'); return; }
    modal(`
      <h3>${m.caption ? m.caption.replace(/</g, '&lt;') : 'Site photo'}</h3>
      <img src="${src}" style="max-width:100%;max-height:62vh;display:block;border-radius:6px;margin:0 auto">
      <div class="form-row" style="margin-top:10px"><label>Caption</label>
        <input type="text" id="ph-cap" value="${(m.caption || '').replace(/"/g, '&quot;')}" placeholder="e.g. Drop at CNC-102, installed 8/4"></div>
      <div class="modal-actions"><button class="mini-btn primary" id="ph-ok">Done</button></div>`,
      (box, close) => {
        const finish = () => {
          const cap = $('ph-cap').value.trim();
          if (cap !== (m.caption || '')) State.updateMarkups([m.id], { caption: cap });
          close();
        };
        $('ph-ok').onclick = finish;
        $('ph-cap').addEventListener('keydown', e => { if (e.key === 'Enter') finish(); });
      });
  }

  function countGroupDialog() {
    const used = State.S.countGroups.length;
    const color = Symbols.COLORS[used % (Symbols.COLORS.length - 1)];
    modal(`
      <h3>New count group</h3>
      <div class="form-row"><label>What are you counting?</label>
        <input type="text" id="cg-name" placeholder="e.g. Drops · Couplers · 90° Elbows" value=""></div>
      <div class="form-row"><label>Marker shape</label>
        <select id="cg-shape">${Symbols.COUNT_SHAPES.map(s => `<option>${s}</option>`).join('')}</select></div>
      <div class="form-row"><label>Color</label>
        <input type="color" id="cg-color" value="${color}" style="width:60px;height:30px;padding:2px"></div>
      <div class="modal-actions">
        <button class="mini-btn" id="cg-cancel">Cancel</button>
        <button class="mini-btn primary" id="cg-ok">Create</button>
      </div>`, (box, close) => {
      $('cg-name').focus();
      const ok = () => {
        const name = $('cg-name').value.trim() || ('Count ' + (used + 1));
        State.addCountGroup(name, $('cg-shape').value, $('cg-color').value);
        close();
        State.setTool('count');
        toast(`Counting “${name}” — click the drawing to place marks.`, 'ok');
      };
      $('cg-ok').onclick = ok;
      $('cg-cancel').onclick = close;
      $('cg-name').addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    });
  }

  function helpDialog() {
    modal(`
      <h3>AirMark — quick reference</h3>
      <p class="muted">A Bluebeam-style markup + measurement tool for compressed-air pipe work. Everything stays in your browser — drawings are never uploaded.</p>
      <p class="muted"><b>Field workflow:</b> ① Open the drawing → ② set the <b>scale</b> — click the Scale button and type the sheet's stated ratio (1:100, 1/4"=1'-0"…), or calibrate from two points of a known distance → ③ draw <b>Pipe runs</b>, color-coded and drawn at their true OD width → ④ drop <b>Symbols</b> (valves, drops, FRL…) and <b>Counts</b> → ⑤ check the <b>Takeoff</b> tab → ⑥ <b>Export PDF</b> or CSV.</p>
      <dl class="help-grid">
        <dt><kbd>V</kbd></dt><dd>Select</dd>
        <dt><kbd>H</kbd></dt><dd>Pan (or hold <kbd>Space</kbd>, or middle mouse)</dd>
        <dt><kbd>P</kbd></dt><dd>Pipe run</dd>
        <dt><kbd>L</kbd></dt><dd>Length measurement</dd>
        <dt><kbd>A</kbd></dt><dd>Area measurement</dd>
        <dt><kbd>C</kbd></dt><dd>Count</dd>
        <dt><kbd>T</kbd> / <kbd>Q</kbd></dt><dd>Text / Callout</dd>
        <dt><kbd>Enter</kbd> / dbl-click</dt><dd>Finish pipe / polyline</dd>
        <dt><kbd>Shift</kbd></dt><dd>Snap to 45° while drawing (relative to the previous pipe leg — off-axis runs still get square tees)</dd>
        <dt><kbd>Backspace</kbd></dt><dd>Remove last pipe point while drawing</dd>
        <dt><kbd>R</kbd></dt><dd>Rotate symbol (before or after placing)</dd>
        <dt><kbd>Esc</kbd></dt><dd>Cancel / clear selection</dd>
        <dt><kbd>Del</kbd></dt><dd>Delete selection</dd>
        <dt><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd></dt><dd>Undo / redo</dd>
        <dt><kbd>Ctrl+D</kbd></dt><dd>Duplicate selection</dd>
        <dt><kbd>Ctrl+S</kbd></dt><dd>Save project (.airmark)</dd>
        <dt>Arrows</dt><dd>Pan the view — works mid pipe run (<kbd>Shift</kbd> = faster) · nudges the selection when using Select</dd>
        <dt>Wheel</dt><dd>Zoom at cursor · <kbd>+</kbd>/<kbd>−</kbd>/<kbd>0</kbd> zoom &amp; fit</dd>
        <dt><kbd>PgUp</kbd>/<kbd>PgDn</kbd></dt><dd>Previous / next page</dd>
      </dl>
      <p class="muted">Markups autosave in this browser per-drawing and are offered back when you reopen the same PDF. Use <b>Save</b> for a portable .airmark file (embeds the PDF), and <b>Export PDF</b> for a flattened copy anyone can open.</p>
      <div class="modal-actions"><button class="mini-btn primary" id="help-ok">Got it</button></div>`,
      (box, close) => { $('help-ok').onclick = close; });
  }

  /* ================= misc ================= */

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  let savedTimer = null;
  function savedIndicator() {
    const el = $('statusSave');
    el.textContent = 'Autosaved ✓';
    el.classList.add('saved');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { el.textContent = ''; }, 2500);
  }

  function updateScaleStatus() {
    const btn = $('statusScale');
    const sc = State.scaleForPage(State.S.page);
    if (sc) {
      btn.textContent = 'Scale: ' + Units.scaleLabel(sc);
      btn.classList.remove('warn');
      btn.title = 'Page scale — click to change (type a ratio or measure two points)';
    } else {
      btn.textContent = State.S.pdf ? '⚠ Scale not set — click to set' : 'Scale: not set';
      btn.classList.add('warn');
      btn.title = "Measurements need a scale. Click to type the sheet's stated scale (1:100, 1/4\"=1'-0\"…) or measure two points.";
    }
  }

  function updateHint() {
    $('statusHint').textContent = Tools.TOOL_HINTS[State.S.tool] || '';
  }

  function updateZoomLabel() { $('zoomLabel').textContent = Math.round(State.S.zoom * 100) + '%'; }

  function updatePageUi() {
    $('pageInput').value = State.S.page;
    $('pageCount').textContent = State.S.pageCount;
    Viewer.syncThumbActive();
  }

  function updateHistoryUi() {
    $('btnUndo').disabled = !State.canUndo();
    $('btnRedo').disabled = !State.canRedo();
  }

  /* ================= file opening ================= */

  async function openPdfFile(file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await Viewer.openPdf(bytes, file.name);
    } catch (err) {
      console.error(err);
      toast('Could not open that PDF: ' + (err.message || err), 'err', 7000);
    }
  }

  function handleFiles(files) {
    for (const f of files) {
      if (/\.airmark$|\.json$/i.test(f.name)) { Project.openProjectFile(f); return; }
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') { openPdfFile(f); return; }
    }
    toast('Drop a PDF drawing or an .airmark project file.', 'warn');
  }

  /* ================= wiring ================= */

  function wireToolbar() {
    $('btnOpen').onclick = () => $('filePdf').click();
    $('filePdf').addEventListener('change', e => {
      if (e.target.files.length) handleFiles(e.target.files);
      e.target.value = '';
    });
    $('btnOpenProject').onclick = () => $('fileProject').click();
    $('fileProject').addEventListener('change', e => {
      if (e.target.files.length) Project.openProjectFile(e.target.files[0]);
      e.target.value = '';
    });
    $('btnSample').onclick = () => Export.openSample().catch(err => {
      console.error(err); toast('Sample failed: ' + err.message, 'err');
    });
    $('btnSaveProject').onclick = () => Project.saveProject();
    $('btnExportPdf').onclick = () => Export.exportFlattenedPdf();
    $('btnExportCsv').onclick = () => MarkupList.exportCsv();

    $('btnUndo').onclick = () => State.undo();
    $('btnRedo').onclick = () => State.redo();

    $('btnZoomIn').onclick = () => Viewer.zoomIn();
    $('btnZoomOut').onclick = () => Viewer.zoomOut();
    $('btnFitPage').onclick = () => Viewer.fitPage();
    $('btnFitWidth').onclick = () => Viewer.fitWidth();
    $('btnThumbs').onclick = () => $('thumbPanel').classList.toggle('hidden');

    $('btnPrevPage').onclick = () => Viewer.gotoPage(State.S.page - 1);
    $('btnNextPage').onclick = () => Viewer.gotoPage(State.S.page + 1);
    $('pageInput').addEventListener('change', e => {
      const n = parseInt(e.target.value, 10);
      if (!isNaN(n)) Viewer.gotoPage(n); else updatePageUi();
    });

    const unitSel = $('unitFormat');
    unitSel.value = State.S.unitFormat;
    unitSel.addEventListener('change', () => {
      State.S.unitFormat = unitSel.value;
      localStorage.setItem('abmt:units', unitSel.value);
      State.emit('scale');
      Render.drawPage();
      MarkupList.render();
    });

    $('btnHelp').onclick = helpDialog;
    $('btnAuthor').onclick = () => {
      modal(`<h3>Author name</h3>
        <p class="muted">Stamped on every markup you place (shows in the list and CSV).</p>
        <div class="form-row"><input type="text" id="author-name" value="${State.S.author.replace(/"/g, '&quot;')}"></div>
        <div class="modal-actions"><button class="mini-btn" id="au-cancel">Cancel</button>
        <button class="mini-btn primary" id="au-ok">Save</button></div>`, (box, close) => {
        $('author-name').focus();
        $('au-ok').onclick = () => {
          State.S.author = $('author-name').value.trim() || 'Field';
          localStorage.setItem('abmt:author', State.S.author);
          close();
        };
        $('au-cancel').onclick = close;
      });
    };

    $('statusScale').onclick = () => {
      if (!State.S.pdf) return;
      scaleDialog();
    };

    // tool rail
    document.querySelectorAll('#toolRail .tool-btn').forEach(btn => {
      btn.addEventListener('click', () => State.setTool(btn.dataset.tool));
    });
  }

  function wireDragDrop() {
    const wrap = $('viewportWrap');
    let depth = 0;
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => e.preventDefault());
    wrap.addEventListener('dragenter', e => { e.preventDefault(); depth++; wrap.classList.add('dragging'); });
    wrap.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; wrap.classList.remove('dragging'); } });
    wrap.addEventListener('drop', e => {
      e.preventDefault();
      depth = 0;
      wrap.classList.remove('dragging');
      if (!e.dataTransfer.files.length) return;
      // image dropped on an open drawing → pin it as a photo at the drop point
      const img = [...e.dataTransfer.files].find(f => /^image\//.test(f.type));
      if (img && State.S.pdf) {
        const p = Viewer.toPage(e);
        p.x = Math.max(0, Math.min(State.S.pageW, p.x));
        p.y = Math.max(0, Math.min(State.S.pageH, p.y));
        Tools.placeDroppedPhoto(img, p);
        return;
      }
      handleFiles(e.dataTransfer.files);
    });
  }

  function wireShortcuts() {
    window.addEventListener('keydown', e => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl) {
        const k = e.key.toLowerCase();
        if (k === 'z') { e.preventDefault(); e.shiftKey ? State.redo() : State.undo(); }
        else if (k === 'y') { e.preventDefault(); State.redo(); }
        else if (k === 's') { e.preventDefault(); Project.saveProject(); }
        else if (k === 'o') { e.preventDefault(); $('filePdf').click(); }
        else if (k === 'a') { e.preventDefault(); State.select(State.pageMarkups(State.S.page).map(m => m.id)); }
        return;
      }

      switch (e.key) {
        case 'v': case 'V': State.setTool('select'); break;
        case 'h': case 'H': State.setTool('pan'); break;
        case 'p': case 'P': State.setTool('pipe'); break;
        case 'l': case 'L': State.setTool(e.shiftKey ? 'mpoly' : 'mlength'); break;
        case 'a': case 'A': State.setTool('marea'); break;
        case 'c': case 'C': State.setTool('count'); break;
        case 't': case 'T': State.setTool('text'); break;
        case 'q': case 'Q': State.setTool('callout'); break;
        case '?': helpDialog(); break;
        case '+': case '=': Viewer.zoomIn(); break;
        case '-': case '_': Viewer.zoomOut(); break;
        case '0': Viewer.fitPage(); break;
        case 'PageUp': e.preventDefault(); Viewer.gotoPage(State.S.page - 1); break;
        case 'PageDown': e.preventDefault(); Viewer.gotoPage(State.S.page + 1); break;
      }
    });
  }

  /* ================= boot ================= */

  function init() {
    Viewer.init();
    Tools.init();
    Props.init();
    MarkupList.init();
    Project.init();

    wireToolbar();
    wireDragDrop();
    wireShortcuts();

    // render pipeline events
    State.on('markups', d => {
      if (d && d.changed) Render.refresh(d.changed);
      else Render.drawPage();
    });
    State.on('selection', () => Render.drawSelection());
    State.on('zoom', () => { Render.drawSelection(); updateZoomLabel(); });
    State.on('page', () => { Render.drawPage(); updatePageUi(); updateScaleStatus(); });
    State.on('scale', updateScaleStatus);
    State.on('history', updateHistoryUi);
    State.on('tool', () => {
      document.querySelectorAll('#toolRail .tool-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tool === State.S.tool));
      updateHint();
      Render.drawSelection();
    });
    State.on('doc', () => {
      $('docName').textContent = State.S.fileName;
      $('docName').title = State.S.fileName;
      Render.drawPage();
      updatePageUi(); updateScaleStatus(); updateZoomLabel(); updateHint();
    });

    updateScaleStatus(); updateHint(); updateHistoryUi();
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    toast, modal, progress, calibrateDialog, scaleDialog, countGroupDialog, helpDialog,
    photoLightbox, download, savedIndicator, showTab: (...a) => Props.showTab(...a),
  };
})();
