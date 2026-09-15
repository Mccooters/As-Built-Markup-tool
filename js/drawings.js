/* ============ drawings.js — SharePoint site-drawings register ============
 *
 * A Bluebeam-style drawings register that mirrors the project's SharePoint
 * drawings folder: sections are the sub-folders, each row is a PDF with its
 * download state. The listing comes through api/cloud.js (the Microsoft
 * credential lives only in server env vars); the PDF bytes come straight
 * from SharePoint via a short-lived pre-authenticated URL. Downloads land
 * in the same on-device store as every other drawing, so a downloaded sheet
 * opens instantly and works with no signal — the register is just the way
 * site copies get onto the device and stay current.
 */
'use strict';

const Drawings = (() => {

  const REG_KEY = 'abmt:spreg';   // last fetched register {when, root, sections}
  const MAP_KEY = 'abmt:spmap';   // itemId → {etag, fp, name, when} downloaded on this device
  const FOLD_KEY = 'abmt:spfold'; // section path → folded?
  const API = '/api/cloud';
  const STALE_MS = 30 * 60000;    // auto re-check the register after this

  const st = {
    reg: null, map: {}, fold: {},
    phase: 'idle', error: '', filter: '', busy: false,
  };
  let dlg = null; // { el, close } while the register dialog is open

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const loadJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
  const saveJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full */ } };
  const cloudSt = () => (typeof Cloud !== 'undefined' && Cloud._state) || {};
  const available = () => { const c = cloudSt(); return c.enabled === true && c.sp === true; };
  const signedIn = () => !!cloudSt().token;

  const fmtSize = b => !b ? '' : b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  const fmtDate = iso => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const old = Date.now() - t > 330 * 86400000;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + (old ? ' ' + d.getFullYear() : '');
  };
  const ageOf = when => {
    if (!when) return 'never';
    const mins = Math.round((Date.now() - when) / 60000);
    return mins < 1 ? 'just now' : mins < 60 ? mins + ' min ago' : mins < 1440 ? Math.round(mins / 60) + ' h ago' : Math.round(mins / 1440) + ' d ago';
  };

  async function call(action, body) {
    const headers = { 'X-AirMark-Auth': cloudSt().token || '' };
    let resp;
    try {
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        resp = await fetch(API + '?action=' + action, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
      } else {
        resp = await fetch(API + '?action=' + action, { headers, signal: AbortSignal.timeout(45000) });
      }
    } catch (e) { const err = new Error('No connection.'); err.offline = true; throw err; }
    let j;
    try { j = await resp.json(); } catch (e) { throw new Error('Unexpected reply (HTTP ' + resp.status + ').'); }
    if (j.badAuth) { Cloud.signOut(true); throw new Error(j.statusmessage); }
    if (!j.ok) throw new Error(j.statusmessage || 'SharePoint error');
    return j;
  }

  /* ---------------- register data ---------------- */

  const allFiles = () => (st.reg && st.reg.sections || []).flatMap(s => s.files);

  function fileState(f) {
    const m = st.map[f.id];
    if (!m) return 'cloud';
    return m.etag === f.etag ? 'have' : 'update';
  }

  async function sync() {
    if (!available() || !signedIn() || st.phase === 'loading') return;
    st.phase = 'loading'; st.error = '';
    renderCards();
    try {
      const r = await call('drawings');
      st.reg = { when: Date.now(), root: r.root || '', sections: r.sections || [] };
      saveJson(REG_KEY, st.reg);
    } catch (e) {
      st.error = e.offline
        ? (st.reg ? 'Offline — showing the last saved register.' : 'Offline — the register loads when there’s signal.')
        : e.message;
    }
    st.phase = 'idle';
    renderCards();
  }

  function maybeAutoSync() {
    if (!available() || !signedIn()) return;
    if (st.reg && Date.now() - st.reg.when < STALE_MS) return;
    if (navigator.onLine === false) return;
    sync();
  }

  /* ---------------- download / open ---------------- */

  async function openDrawing(f) {
    if (st.busy) return;
    const m = st.map[f.id];

    // already on this device and unchanged on SharePoint → plain offline open
    if (m && m.etag === f.etag && m.fp) {
      const have = await Store.get(m.fp);
      if (have && have.pdf) {
        if (dlg) dlg.close();
        await Project.openFromStore(m.fp);
        return;
      }
      // pruned from the device store — fall through and download again
    }

    st.busy = true;
    renderCards();
    const label = f.name.replace(/\.pdf$/i, '');
    const note = App.toast('Downloading ' + label + ' from SharePoint…', 'info', 0);
    try {
      const r = await call('spfile', { id: f.id });
      let bytes = null;
      try {
        const direct = await fetch(r.url, { signal: AbortSignal.timeout(300000) });
        if (!direct.ok) throw new Error('HTTP ' + direct.status);
        bytes = new Uint8Array(await direct.arrayBuffer());
      } catch (e) {
        // some setups won't hand the browser the pre-authenticated URL —
        // pull the bytes through the deployment instead
        const prox = await fetch(API + '?action=spproxy&id=' + encodeURIComponent(f.id),
          { headers: { 'X-AirMark-Auth': cloudSt().token || '' }, signal: AbortSignal.timeout(300000) });
        if (!prox.ok) {
          let msg = 'HTTP ' + prox.status;
          try { const pj = await prox.json(); if (pj && pj.statusmessage) msg = pj.statusmessage; } catch (e2) { /* binary */ }
          throw new Error(msg);
        }
        bytes = new Uint8Array(await prox.arrayBuffer());
      }
      if (bytes.length < 5 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) !== '%PDF-')
        throw new Error('that download wasn’t a PDF — check the file on SharePoint');

      const prevFp = m && m.fp;
      if (dlg) dlg.close();
      await Viewer.openPdf(bytes, f.name);
      st.map[f.id] = { etag: r.etag || f.etag, fp: State.S.fingerprint, name: f.name, when: Date.now() };
      saveJson(MAP_KEY, st.map);
      // a sheet with no markups yet never autosaves — store a project record
      // now so it reopens from the device instead of re-downloading
      Store.saveProject(State.S.fingerprint, f.name, Project.serialize(false));
      if (prevFp && prevFp !== State.S.fingerprint)
        App.toast('New revision from SharePoint. Markups made on the earlier revision stay with it — reopen it from the team list or recents.', 'warn', 9000);
      else
        App.toast(label + ' is stored on this device — it now opens offline.', 'good', 5000);
    } catch (e) {
      App.toast('Couldn’t load ' + label + ': ' + e.message, 'error', 9000);
    } finally {
      note.remove();
      st.busy = false;
      renderCards();
    }
  }

  /* ---------------- UI ---------------- */

  function sectionsHtml() {
    const reg = st.reg;
    if (!reg || !reg.sections.length) {
      if (st.phase === 'loading') return '<div class="cloud-note">Checking SharePoint…</div>';
      return '<div class="cloud-note">No PDFs found in the drawings folder yet.</div>';
    }
    const q = st.filter.trim().toLowerCase();
    const total = allFiles().length;
    const defFold = total > 12;
    let h = '';
    for (const sec of reg.sections) {
      const files = q ? sec.files.filter(f => f.name.toLowerCase().includes(q) || sec.path.toLowerCase().includes(q)) : sec.files;
      if (!files.length) continue;
      const have = sec.files.filter(f => fileState(f) !== 'cloud').length;
      const folded = q ? false : (st.fold[sec.path] !== undefined ? st.fold[sec.path] : defFold);
      h += `<div class="sp-sec${folded ? ' folded' : ''}" data-path="${esc(sec.path)}">
        <button class="sp-sechead" type="button">
          <span class="sp-chev">${folded ? '▸' : '▾'}</span>
          <span class="sp-secname">${esc(sec.path || (reg.root || 'Drawings'))}</span>
          <span class="sp-secn">${have} of ${sec.files.length} on device</span>
        </button>
        <div class="sp-files"${folded ? ' hidden' : ''}>` +
        files.map(f => {
          const state = fileState(f);
          const icon = state === 'have' ? '✓' : state === 'update' ? '↻' : '⬇';
          const stTitle = state === 'have' ? 'On this device — opens offline'
            : state === 'update' ? 'Updated on SharePoint — tap to load the new revision'
            : 'Tap to download and open';
          return `<button class="sp-row${state === 'update' ? ' upd' : ''}" type="button" data-id="${esc(f.id)}" title="${esc(f.name)} — ${stTitle}">
            <span class="sp-rowmain">
              <span class="sp-name">${esc(f.name.replace(/\.pdf$/i, ''))}</span>
              <span class="sp-meta">${esc([fmtSize(f.size), fmtDate(f.modified)].filter(Boolean).join(' · '))}${state === 'update' ? ' · <b>updated</b>' : ''}</span>
            </span>
            <span class="sp-state ${state}">${icon}</span>
          </button>`;
        }).join('') +
        '</div></div>';
    }
    return h || '<div class="cloud-note">Nothing matches “' + esc(st.filter) + '”.</div>';
  }

  function renderInto(el, opts = {}) {
    if (!el) return;
    if (!available()) { el.innerHTML = ''; return; }
    if (!signedIn()) {
      el.innerHTML = `
        <div class="cloud-card sp-card">
          <div class="recent-cap">Site drawings</div>
          <div class="cloud-note">Sign in to the team cloud above and the project’s SharePoint drawing register loads by itself.</div>
        </div>`;
      return;
    }
    const files = allFiles();
    const have = files.filter(f => fileState(f) !== 'cloud').length;
    el.innerHTML = `
      <div class="cloud-card sp-card">
        ${opts.dialog ? '' : `<div class="recent-cap">Site drawings${st.reg && st.reg.root ? ' — ' + esc(st.reg.root) : ''}</div>`}
        <div class="cloud-who">
          <span>SharePoint · checked ${esc(ageOf(st.reg && st.reg.when))}${files.length ? ` · <b>${have} of ${files.length}</b> on device` : ''}</span>
          <button class="mini-btn" data-act="sync" title="Check SharePoint for new and updated drawings"${st.phase === 'loading' ? ' disabled' : ''}>${st.phase === 'loading' ? '…' : '⟳ Sync'}</button>
        </div>
        ${st.error ? `<div class="cloud-err">${esc(st.error)}</div>` : ''}
        ${files.length > 6 ? `<div class="sp-search"><input type="search" data-act="filter" placeholder="Search drawings…" value="${esc(st.filter)}"></div>` : ''}
        <div class="sp-list">${sectionsHtml()}</div>
      </div>`;

    el.querySelector('[data-act="sync"]').addEventListener('click', e => { e.stopPropagation(); sync(); });
    const search = el.querySelector('[data-act="filter"]');
    if (search) {
      search.addEventListener('input', () => {
        st.filter = search.value;
        const list = el.querySelector('.sp-list');
        if (list) list.innerHTML = sectionsHtml();
        wireList(el);
      });
      search.addEventListener('click', e => e.stopPropagation());
    }
    wireList(el);
  }

  function wireList(el) {
    el.querySelectorAll('.sp-sechead').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const sec = b.closest('.sp-sec');
      const path = sec.dataset.path;
      const total = allFiles().length;
      const cur = st.fold[path] !== undefined ? st.fold[path] : total > 12;
      st.fold[path] = !cur;
      saveJson(FOLD_KEY, st.fold);
      renderCards();
    }));
    el.querySelectorAll('.sp-row').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const f = allFiles().find(x => x.id === b.dataset.id);
      if (f) openDrawing(f);
    }));
  }

  function renderCards() {
    renderInto(document.getElementById('spCard'));
    if (dlg && dlg.el && dlg.el.isConnected) renderInto(dlg.el, { dialog: true });
    else dlg = null;
  }

  function openDialog() {
    App.modal('<h3>Site drawings</h3><div id="spDlgBody"></div>', (box, close) => {
      dlg = { el: box.querySelector('#spDlgBody'), close: () => { dlg = null; close(); } };
      renderInto(dlg.el, { dialog: true });
    });
    maybeAutoSync();
  }

  /** Called by Cloud whenever sign-in state or the deployment probe changes
   *  (Home refreshes its Drawings menu item from the same hook). */
  function onCloudState() {
    renderCards();
    maybeAutoSync();
  }

  function init() {
    st.reg = loadJson(REG_KEY, null);
    st.map = loadJson(MAP_KEY, {});
    st.fold = loadJson(FOLD_KEY, {});
    renderCards();
  }

  document.addEventListener('DOMContentLoaded', init);

  return { onCloudState, sync, openDialog, _state: st };
})();
