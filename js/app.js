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
      <p class="muted"><b>Field workflow:</b> ① Open the drawing → ② <b>Calibrate</b> the sheet (or pick a preset scale) → ③ draw <b>Pipe runs</b> sized &amp; color-coded → ④ drop <b>Symbols</b> (valves, drops, FRL…) and <b>Counts</b> → ⑤ check the <b>Takeoff</b> tab → ⑥ <b>Export PDF</b> or CSV.</p>
      <dl class="help-grid">
        <dt><kbd>V</kbd></dt><dd>Select</dd>
        <dt><kbd>H</kbd></dt><dd>Pan (or hold <kbd>Space</kbd>, or middle mouse)</dd>
        <dt><kbd>P</kbd></dt><dd>Pipe run</dd>
        <dt><kbd>L</kbd></dt><dd>Length measurement</dd>
        <dt><kbd>A</kbd></dt><dd>Area measurement</dd>
        <dt><kbd>C</kbd></dt><dd>Count</dd>
        <dt><kbd>T</kbd> / <kbd>Q</kbd></dt><dd>Text / Callout</dd>
        <dt><kbd>Enter</kbd> / dbl-click</dt><dd>Finish pipe / polyline</dd>
        <dt><kbd>Shift</kbd></dt><dd>Free angle while drawing pipes (ortho is default) · constrain 45° on lines</dd>
        <dt><kbd>Backspace</kbd></dt><dd>Remove last pipe point while drawing</dd>
        <dt><kbd>R</kbd></dt><dd>Rotate symbol (before or after placing)</dd>
        <dt><kbd>Esc</kbd></dt><dd>Cancel / clear selection</dd>
        <dt><kbd>Del</kbd></dt><dd>Delete selection</dd>
        <dt><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd></dt><dd>Undo / redo</dd>
        <dt><kbd>Ctrl+D</kbd></dt><dd>Duplicate selection</dd>
        <dt><kbd>Ctrl+S</kbd></dt><dd>Save project (.airmark)</dd>
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
      btn.textContent = 'Scale: ' + Units.describeScale(sc.ftPerUnit);
      btn.classList.remove('warn');
      btn.title = 'Page scale — click to recalibrate';
    } else {
      btn.textContent = State.S.pdf ? '⚠ Scale not set — click to calibrate' : 'Scale: not set';
      btn.classList.add('warn');
      btn.title = 'Measurements need a scale. Click, then mark a known distance.';
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
      State.setTool('calibrate');
      Props.showTab('props');
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
      if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
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
    toast, modal, progress, calibrateDialog, countGroupDialog, helpDialog,
    download, savedIndicator, showTab: (...a) => Props.showTab(...a),
  };
})();
