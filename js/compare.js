/* ============ compare.js — overlay an earlier revision on the current sheet ============
 *
 * Bluebeam-style overlay. The current sheet is tinted blue and the earlier
 * revision red, and the two are multiplied together: linework on both goes
 * near-black, anything only on the new sheet stays blue, anything only on
 * the old one stays red — so what changed jumps out. Both tints are plain
 * canvas compositing ('lighten' with a colour turns black-on-white line art
 * into colour-on-white in one pass), so it behaves the same on iPad Safari
 * and desktop. Opacity and a nudge keep it readable when the two sheets
 * don't sit perfectly on top of each other.
 */
'use strict';

const Compare = (() => {
  const TINT_NEW = '#2f6fe4';   // the current sheet
  const TINT_OLD = '#e02020';   // the earlier revision
  const st = { on: false, fp: '', label: '', doc: null, opacity: 0.85, dx: 0, dy: 0, busy: false };
  let cv = null, bar = null, task = null, seq = 0;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  const revisions = () => State.S.revisions || [];
  const revOf = fp => revisions().find(r => r.fp === fp) || null;
  const revName = r => r.label + ' · ' + String(r.fileName || '').replace(/\.pdf$/i, '');

  /** 'lighten' with a colour: white stays white, black becomes the colour — line art tinted in one pass. */
  function tint(canvas, color) {
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'lighten';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  async function bytesFor(fp) {
    let bytes = await Store.getPdf(fp);
    if (!bytes && typeof Cloud !== 'undefined' && Cloud.fetchRevision) {
      const note = App.toast('Fetching that revision from the team cloud…', 'info', 0);
      try { bytes = await Cloud.fetchRevision(fp); }
      finally { note.remove(); }
    }
    return bytes;
  }

  async function start(fp) {
    if (!State.S.pdf) return;
    const rev = revOf(fp) || revisions()[revisions().length - 1];
    if (!rev) { App.toast('No earlier revision to compare with — import the updated sheet first (Compare → Import new revision).', 'warn', 6000); return; }
    if (st.busy) return;
    st.busy = true;
    try {
      const bytes = await bytesFor(rev.fp);
      if (!bytes) throw new Error('that revision isn’t stored on this device and isn’t in the team cloud');
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes).slice() }).promise;
      if (st.doc) { try { st.doc.destroy(); } catch (e) { /* ignore */ } }
      st.doc = doc; st.fp = rev.fp; st.label = revName(rev); st.on = true; st.dx = 0; st.dy = 0;
      document.body.classList.add('comparing');
      renderBar();
      await Viewer.renderPage();   // re-render the current page: it gets tinted, then the overlay draws
    } catch (e) {
      App.toast('Couldn’t start the comparison: ' + e.message, 'error', 8000);
      stop(true);
    } finally { st.busy = false; }
  }

  function stop(quiet) {
    const was = st.on;
    st.on = false; st.fp = ''; st.label = '';
    if (st.doc) { try { st.doc.destroy(); } catch (e) { /* ignore */ } st.doc = null; }
    if (task) { try { task.cancel(); } catch (e) { /* ignore */ } task = null; }
    document.body.classList.remove('comparing');
    if (cv) cv.hidden = true;
    if (bar) bar.hidden = true;
    if (was && State.S.pdf) Viewer.renderPage();   // back to the untinted sheet
    if (was && !quiet) App.toast('Comparison closed.', 'info', 2000);
  }

  function toggle() {
    if (st.on) { stop(); return; }
    if (!State.S.pdf) { App.toast('Open a drawing first.', 'warn'); return; }
    if (!revisions().length) { App.revisionsDialog(); return; }
    start(revisions()[revisions().length - 1].fp);
  }

  /** After every page render: tint the current sheet, then draw the old one over it. */
  async function onPageRendered() {
    if (!st.on || !st.doc) return;
    tint(Viewer.el.canvas, TINT_NEW);
    const my = ++seq;
    const S = State.S, base = Viewer.el.canvas;
    if (!base.width) return;
    try {
      const page = await st.doc.getPage(Math.min(S.page, st.doc.numPages));
      const vp1 = page.getViewport({ scale: 1 });
      const pxPerUnit = base.width / S.pageW;   // the current render's pixels per page unit
      const fit = S.pageW / vp1.width;           // old sheet scaled so the widths match
      const vp = page.getViewport({ scale: pxPerUnit * fit });
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.floor(vp.width)); off.height = Math.max(1, Math.floor(vp.height));
      if (task) { try { task.cancel(); } catch (e) { /* ignore */ } }
      task = page.render({ canvasContext: off.getContext('2d', { alpha: false }), viewport: vp });
      await task.promise;
      if (my !== seq || !st.on) return;
      tint(off, TINT_OLD);
      cv.width = base.width; cv.height = base.height;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(off, 0, 0);
      layout();
      cv.hidden = false;
    } catch (e) {
      if (!(e && e.name === 'RenderingCancelledException')) console.error(e);
    }
  }

  function layout() {
    if (!cv) return;
    const S = State.S;
    cv.style.width = (S.pageW * S.zoom) + 'px';
    cv.style.height = (S.pageH * S.zoom) + 'px';
    cv.style.opacity = st.opacity;
    cv.style.transform = `translate(${(st.dx * S.zoom).toFixed(2)}px, ${(st.dy * S.zoom).toFixed(2)}px)`;
  }

  // one tap = one screen pixel at the current zoom (in page units), so a nudge
  // is always visible — Shift makes it ten
  function nudge(dx, dy) {
    const unit = 1 / (State.S.zoom || 1);
    st.dx += dx * unit; st.dy += dy * unit;
    layout(); renderBar();
  }

  function renderBar() {
    if (!bar) return;
    if (!st.on) { bar.hidden = true; return; }
    const revs = revisions();
    bar.hidden = false;
    bar.innerHTML = `
      <span class="cb-legend"><i style="background:${TINT_NEW}"></i>current <i style="background:${TINT_OLD}"></i>${esc(st.label)} <i style="background:#1a1a1a"></i>unchanged</span>
      ${revs.length > 1 ? `<select id="cb-rev" title="Which revision to overlay">${revs.map(r => `<option value="${esc(r.fp)}"${r.fp === st.fp ? ' selected' : ''}>${esc(revName(r))}</option>`).join('')}</select>` : ''}
      <label class="cb-op">Opacity <input type="range" id="cb-op" min="10" max="100" value="${Math.round(st.opacity * 100)}"></label>
      <span class="cb-nudge" title="Nudge the old sheet if it doesn’t sit exactly on the new one (Shift = 10×)">
        <button type="button" data-n="-1,0" title="Left">◀</button><button type="button" data-n="1,0" title="Right">▶</button><button type="button" data-n="0,-1" title="Up">▲</button><button type="button" data-n="0,1" title="Down">▼</button>
        ${st.dx || st.dy ? `<button type="button" id="cb-reset" title="Back to no offset">${st.dx.toFixed(1)}, ${st.dy.toFixed(1)} ✕</button>` : ''}
      </span>
      <button type="button" class="mini-btn primary" id="cb-done">Done</button>`;
    const sel = bar.querySelector('#cb-rev');
    if (sel) sel.addEventListener('change', () => start(sel.value));
    bar.querySelector('#cb-op').addEventListener('input', e => { st.opacity = Number(e.target.value) / 100; layout(); });
    bar.querySelectorAll('[data-n]').forEach(b => b.addEventListener('click', e => {
      const [x, y] = b.dataset.n.split(',').map(Number);
      const k = e.shiftKey ? 10 : 1;
      nudge(x * k, y * k);
    }));
    const reset = bar.querySelector('#cb-reset');
    if (reset) reset.addEventListener('click', () => { st.dx = 0; st.dy = 0; layout(); renderBar(); });
    bar.querySelector('#cb-done').addEventListener('click', () => stop());
  }

  function init() {
    cv = $('revCanvas'); bar = $('compareBar');
    if (!cv || !bar) return;
    State.on('pagerender', onPageRendered);
    State.on('zoom', layout);
    State.on('doc', () => { if (st.on) stop(true); });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { start, stop, toggle, _state: st };
})();
