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
  const PANEL_KEY = 'abmt:drawpanel'; // drawings panel open? (desktop)
  const PFOLD_KEY = 'abmt:dpfold';    // drawings panel: section path → folded?
  const API = '/api/cloud';
  const STALE_MS = 30 * 60000;    // auto re-check the register after this

  const st = {
    reg: null, map: {}, fold: {},
    phase: 'idle', error: '', filter: '', busy: false,
    pfilter: '', pfold: {},       // drawings panel search + folds
  };
  let dlg = null; // { el, close } while the register dialog is open
  let panelOpen = false;
  let thumbs = {};      // fingerprint → small JPEG data URL (device store 'thumbs')
  let localIdx = {};    // fingerprint → device project row (markup counts, project name)
  let thumbQueue = [], thumbBusy = false;
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

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

  /** The sheet's bytes from SharePoint: the pre-authenticated link first, the deployment's proxy as fallback. */
  async function fetchSpBytes(f) {
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
    return { bytes, etag: r.etag || f.etag };
  }

  // A sheet opened from the register while a project is open joins that
  // project (same details, status and stock list) unless it has its own.
  function joinProject(snap) {
    if (snap && snap.project && !State.S.project) Project.adoptDetails(snap);
  }
  const afterOpen = () => { if (isPhone()) closePanel(); renderPanel(); };

  async function openDrawing(f) {
    if (st.busy) return;
    const m = st.map[f.id];
    const snap = State.S.pdf ? Project.detailsSnapshot() : null;

    // already on this device and unchanged on SharePoint → plain offline open
    if (m && m.etag === f.etag && m.fp) {
      const have = await Store.get(m.fp);
      if (have && have.pdf) {
        if (dlg) dlg.close();
        await Project.openFromStore(m.fp);
        joinProject(snap);
        afterOpen();
        return;
      }
      // pruned from the device store — fall through and download again
    }

    st.busy = true;
    renderCards();
    const label = f.name.replace(/\.pdf$/i, '');
    const note = App.toast('Downloading ' + label + ' from SharePoint…', 'info', 0);
    try {
      const { bytes, etag } = await fetchSpBytes(f);
      const prevFp = m && m.fp;
      if (dlg) dlg.close();
      // a revised sheet whose earlier revision carries work on this device:
      // offer to bring the markups across instead of starting a blank one
      const prevRec = prevFp ? await Store.record(prevFp) : null;
      const prevWork = !!(prevRec && prevRec.data && ((prevRec.data.markups || []).length || prevRec.data.project));
      const asRevision = prevWork ? await revisionPrompt(label, prevRec) : false;
      if (asRevision) {
        if (State.S.fingerprint !== prevFp) await Project.openFromStore(prevFp);
        await Project.importRevision(bytes, f.name);
      } else {
        await Viewer.openPdf(bytes, f.name);
        joinProject(snap);
      }
      st.map[f.id] = { etag, fp: State.S.fingerprint, name: f.name, when: Date.now() };
      saveJson(MAP_KEY, st.map);
      // a sheet with no markups yet never autosaves — store a project record
      // now so it reopens from the device instead of re-downloading
      if (!asRevision) Store.saveProject(State.S.fingerprint, f.name, Project.serialize(false));
      afterOpen();
      if (asRevision) {
        App.toast(label + ' — new revision from SharePoint, markups carried across. Compare overlays the previous sheet.', 'good', 7000);
      } else if (prevFp && prevFp !== State.S.fingerprint) {
        if (!prevWork) Store.deleteProject(prevFp);   // nothing was on the old sheet — no stale twin on Home
        App.toast(prevWork
          ? 'New revision from SharePoint opened on its own. The earlier revision and its markups stay in the project list.'
          : 'New revision from SharePoint — it replaces the earlier download.', 'good', 7000);
      } else {
        App.toast(label + ' is stored on this device — it now opens offline.', 'good', 5000);
      }
    } catch (e) {
      App.toast('Couldn’t load ' + label + ': ' + e.message, 'error', 9000);
    } finally {
      note.remove();
      st.busy = false;
      renderCards();
    }
  }

  /** Updated on SharePoint, and the sheet on this device carries work: import as a revision, or open on its own? */
  function revisionPrompt(label, rec) {
    return new Promise(resolve => {
      const n = (rec.data.markups || []).length;
      const pj = rec.data.project && rec.data.project.name ? ' for <b>' + esc(rec.data.project.name) + '</b>' : '';
      let settled = false;
      const pick = (close, v) => { if (settled) return; settled = true; close(); resolve(v); };
      App.modal(`
        <h3>Updated on SharePoint</h3>
        <p class="muted"><b>${esc(label)}</b> has a newer revision. The one on this device carries <b>${n} markup${n === 1 ? '' : 's'}</b>${pj}.</p>
        <div class="imp-opts">
          <button type="button" class="imp-opt" id="sp-rev"><b>Import as a new revision</b><span>Markups, details, zones and the stock link move onto the new sheet; the old one is kept for Compare.</span></button>
          <button type="button" class="imp-opt" id="sp-sep"><b>Open on its own</b><span>A separate, blank sheet — the earlier revision stays as it is.</span></button>
        </div>`, (box, close) => {
        box.querySelector('#sp-rev').onclick = () => pick(close, true);
        box.querySelector('#sp-sep').onclick = () => pick(close, false);
        document.getElementById('modalBackdrop').onclick = () => pick(close, false);
      });
    });
  }

  /** A revision imported by hand replaced the PDF: the register's link follows it. */
  function rekey(oldFp, newFp) {
    let changed = false;
    for (const k of Object.keys(st.map)) if (st.map[k].fp === oldFp) { st.map[k].fp = newFp; changed = true; }
    if (changed) saveJson(MAP_KEY, st.map);
  }

  /* ---------------- drawings panel: every sheet in the project, Procore-style ---------------- */

  /** "CLT-CA-2000 - LEVEL 00 COMPRESSED AIR OVERALL LAYOUT - Rev A.pdf" → { num, title, rev }. */
  function parseName(name) {
    let s = String(name || '').replace(/\.pdf$/i, '').trim();
    let rev = '';
    const m = /^(.*?)[\s\-–_]*\brev(?:ision)?\.?\s*([A-Z]{1,2}|\d{1,3}|[A-Z]\d|\d[A-Z])$/i.exec(s);
    if (m) { rev = m[2].toUpperCase(); s = m[1].trim(); }
    let num = '', title = s;
    const parts = s.split(/\s+[-–]\s+/);
    if (parts.length >= 2 && /\d/.test(parts[0]) && !/\s/.test(parts[0].trim()) && parts[0].trim().length <= 16) {
      num = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    }
    return { num, title, rev };
  }

  /* --- thumbnails: page 1 at ~160 px, kept in the device store --- */

  async function makeThumb(fp, doc) {
    if (!fp || thumbs[fp]) return;
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 160 / vp1.width });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(vp.width)); c.height = Math.max(1, Math.floor(vp.height));
    await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
    const url = c.toDataURL('image/jpeg', 0.72);
    thumbs[fp] = url;
    await Store.saveThumb(fp, url);
    const holder = document.querySelector(`#dpBody .dp-thumb[data-fp="${CSS.escape(fp)}"]`);
    if (holder) { holder.classList.remove('none'); holder.innerHTML = `<img src="${url}" alt="">`; }
  }

  // sheets on the device with no thumbnail yet: one at a time, from stored bytes
  function queueThumb(fp) {
    if (!fp || thumbs[fp] || thumbQueue.includes(fp)) return;
    thumbQueue.push(fp);
    pumpThumbs();
  }
  async function pumpThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    try {
      while (thumbQueue.length) {
        const fp = thumbQueue.shift();
        if (thumbs[fp]) continue;
        const bytes = await Store.getPdf(fp);
        if (!bytes) continue;
        let doc = null;
        try {
          doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes).slice() }).promise;
          await makeThumb(fp, doc);
        } catch (e) { /* no thumbnail for this one */ }
        if (doc) { try { doc.destroy(); } catch (e) { /* ignore */ } }
      }
    } finally { thumbBusy = false; }
  }

  async function refreshLocal() {
    const rows = await Store.list();
    localIdx = {};
    for (const r of rows) localIdx[r.fingerprint] = r;
    renderPanel();
  }

  /* --- download a sheet without opening it (section "download all") --- */

  async function downloadOnly(f, snap) {
    const { bytes, etag } = await fetchSpBytes(f);
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const fp = (doc.fingerprints && doc.fingerprints[0]) || doc.fingerprint || '';
    try { await makeThumb(fp, doc); } catch (e) { /* no thumbnail */ }
    try { doc.destroy(); } catch (e) { /* ignore */ }
    if (!fp) throw new Error('unreadable PDF');
    await Store.savePdf(fp, bytes);
    if (!(await Store.record(fp))) await Store.saveProject(fp, f.name, Project.blankData(f.name, fp, snap));
    st.map[f.id] = { etag, fp, name: f.name, when: Date.now() };
    saveJson(MAP_KEY, st.map);
  }

  async function downloadSection(path) {
    const sec = ((st.reg && st.reg.sections) || []).find(s => s.path === path);
    if (!sec || st.busy) return;
    const todo = sec.files.filter(f => fileState(f) === 'cloud');
    if (!todo.length) return;
    const snap = State.S.pdf ? Project.detailsSnapshot() : null;
    st.busy = true;
    renderPanel();
    const note = App.toast('Downloading ' + todo.length + ' drawing' + (todo.length === 1 ? '' : 's') + '…', 'info', 0);
    let done = 0, failed = 0;
    for (const f of todo) {
      note.firstChild.textContent = `Downloading ${done + failed + 1} of ${todo.length}: ${f.name.replace(/\.pdf$/i, '')}…`;
      try { await downloadOnly(f, snap); done++; } catch (e) { failed++; }
      renderPanel();
    }
    note.remove();
    st.busy = false;
    await refreshLocal();
    renderCards();
    App.toast(failed
      ? `${done} downloaded, ${failed} failed — Sync and try again.`
      : `${done} drawing${done === 1 ? '' : 's'} now on this device — they open offline.`, failed ? 'warn' : 'good', 6000);
  }

  /* --- the panel --- */

  const ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 18a4.5 4.5 0 0 0 .4-9 6 6 0 0 0-11.6 1.6A4 4 0 0 0 6.5 18z"/><path d="M12 10v6m0 0-2.5-2.5M12 16l2.5-2.5"/></svg>';
  const ICON_HAVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>';
  const ICON_UPD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/></svg>';

  function panelRowHtml(r) {
    // r: { key, name, fileName, fp, state: 'have'|'cloud'|'update', markups, isCur, id }
    const p = parseName(r.fileName || r.name);
    const thumb = r.fp && thumbs[r.fp];
    const stateTitle = r.state === 'have' ? 'On this device — opens offline' : r.state === 'update' ? 'Updated on SharePoint — tap to load the new revision' : 'Tap to download and open';
    return `<button type="button" class="dp-row sp-row${r.isCur ? ' cur' : ''}${r.state === 'update' ? ' upd' : ''}" data-key="${esc(r.key)}"${r.id ? ` data-id="${esc(r.id)}"` : ''} title="${esc(r.fileName || r.name)} — ${stateTitle}">
      <span class="dp-thumb${thumb ? '' : ' none'}" data-fp="${esc(r.fp || '')}">${thumb ? `<img src="${thumb}" alt="">` : (r.state === 'cloud' ? '☁' : '▦')}</span>
      <span class="dp-main">
        <span class="dp-num">${esc(p.num || p.title)}</span>
        ${p.num ? `<span class="dp-title">${esc(p.title)}</span>` : ''}
        <span class="dp-rev">${p.rev ? 'Revision ' + esc(p.rev) : ''}${r.state === 'update' ? (p.rev ? ' · ' : '') + '<b>updated on SharePoint</b>' : ''}</span>
      </span>
      <span class="dp-side">
        <span class="sp-state ${r.state}">${r.state === 'cloud' ? ICON_DL : r.state === 'update' ? ICON_UPD : ICON_HAVE}</span>
        ${r.markups ? `<span class="dp-marks" title="${r.markups} markup${r.markups === 1 ? '' : 's'} on this device">✎ ${r.markups}</span>` : ''}
      </span>
    </button>`;
  }

  function panelSectionHtml(sec, q) {
    const cur = State.S.fingerprint;
    const files = q ? sec.files.filter(f => (f.name + ' ' + sec.path).toLowerCase().includes(q)) : sec.files;
    if (!files.length) return '';
    const have = sec.files.filter(f => fileState(f) !== 'cloud').length;
    const missing = sec.files.length - have;
    const folded = q ? false : !!st.pfold[sec.path];
    const rows = files.map(f => {
      const m = st.map[f.id], fp = m && m.fp;
      const rec = fp && localIdx[fp];
      return panelRowHtml({ key: 'sp:' + f.id, id: f.id, name: f.name, fileName: f.name, fp, state: fileState(f), markups: rec ? rec.markups : 0, isCur: !!fp && fp === cur });
    }).join('');
    return `<div class="dp-sec${folded ? ' folded' : ''}" data-path="${esc(sec.path)}">
      <div class="dp-sechead">
        <button type="button" class="dp-secbtn" data-path="${esc(sec.path)}">
          <span class="dp-chev">${folded ? '▸' : '▾'}</span>
          <span class="dp-secmain"><span class="dp-secname">${esc(sec.path || (st.reg && st.reg.root) || 'Drawings')}</span>
          <span class="dp-secn">${have} of ${sec.files.length} drawing${sec.files.length === 1 ? '' : 's'} downloaded</span></span>
        </button>
        ${missing ? `<button type="button" class="dp-dlall" data-path="${esc(sec.path)}" title="Download all ${missing} to this device"${st.busy ? ' disabled' : ''}>${ICON_DL}</button>` : '<span class="dp-dlall done" title="All on this device">✓</span>'}
      </div>
      ${folded ? '' : rows}
    </div>`;
  }

  // drawings of the open project that aren't in the register: device + team cloud
  function projectRows() {
    if (typeof Home === 'undefined' || !Home.projectRows) return [];
    const spFps = new Set(Object.values(st.map).map(m => m.fp).filter(Boolean));
    const cur = State.S.fingerprint;
    const pname = ((State.S.project && State.S.project.name) || '').trim().toLowerCase();
    return Home.projectRows()
      .filter(r => !spFps.has(r.fp) && (r.fp === cur || (pname && (r.pname || '').trim().toLowerCase() === pname)))
      .map(r => ({ key: 'pj:' + r.fp, fp: r.fp, id: r.id, name: r.name, fileName: r.fileName, state: r.onDevice ? 'have' : 'cloud', markups: r.markups || 0, isCur: r.fp === cur }));
  }

  function renderPanel() {
    const body = document.getElementById('dpBody');
    if (!body || !panelOpen) return;
    const q = st.pfilter.trim().toLowerCase();
    let h = `<div class="dp-tools"><input type="search" id="dp-q" placeholder="Search drawings…" value="${esc(st.pfilter)}" autocomplete="off"></div>`;
    if (available()) {
      if (!signedIn()) {
        h += '<div class="dp-sync"><span class="muted">Sign in to the team cloud (Home) and the project’s SharePoint drawing register loads here.</span></div>';
      } else {
        const files = allFiles();
        const have = files.filter(f => fileState(f) !== 'cloud').length;
        h += `<div class="dp-sync"><div class="dp-syncmain"><b>${st.phase === 'loading' ? 'Checking SharePoint…' : 'Check for updates'}</b>
            <small class="muted">Updated ${esc(ageOf(st.reg && st.reg.when))}${files.length ? ` · ${have} of ${files.length} on device` : ''}</small></div>
          <button type="button" class="mini-btn primary" data-act="sync"${st.phase === 'loading' ? ' disabled' : ''}>Sync</button></div>`;
        if (st.error) h += `<div class="cloud-err">${esc(st.error)}</div>`;
        const secs = ((st.reg && st.reg.sections) || []).map(sec => panelSectionHtml(sec, q)).join('');
        h += secs || (st.reg ? `<div class="cloud-note">${q ? 'Nothing matches “' + esc(st.pfilter) + '”.' : 'No PDFs in the drawings folder yet.'}</div>` : '');
      }
    }
    const others = projectRows().filter(r => !q || (r.fileName + ' ' + r.name).toLowerCase().includes(q));
    if (others.length) {
      const label = (State.S.project && State.S.project.name) ? esc(State.S.project.name) : 'This project';
      h += `<div class="dp-sec"><div class="dp-sechead"><span class="dp-secbtn static"><span class="dp-chev"></span>
        <span class="dp-secmain"><span class="dp-secname">${label}</span><span class="dp-secn">${others.length} drawing${others.length === 1 ? '' : 's'} on this device / team cloud</span></span></span></div>
        ${others.map(panelRowHtml).join('')}</div>`;
    } else if (!available()) {
      h += '<div class="cloud-note">Sheets that share this project’s name (Open → Another drawing for this project) list here. A SharePoint drawing register adds the whole set — see the README.</div>';
    }
    body.innerHTML = h;

    const qEl = body.querySelector('#dp-q');
    qEl.addEventListener('input', () => { st.pfilter = qEl.value; const pos = qEl.selectionStart; renderPanel(); const n = body.querySelector('#dp-q'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } });
    const syncBtn = body.querySelector('[data-act="sync"]');
    if (syncBtn) syncBtn.addEventListener('click', () => { syncBtn.disabled = true; syncBtn.textContent = '…'; sync(); });
    body.querySelectorAll('.dp-secbtn[data-path]').forEach(b => b.addEventListener('click', () => {
      st.pfold[b.dataset.path] = !st.pfold[b.dataset.path];
      saveJson(PFOLD_KEY, st.pfold);
      renderPanel();
    }));
    body.querySelectorAll('.dp-dlall[data-path]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); downloadSection(b.dataset.path); }));
    body.querySelectorAll('.dp-row').forEach(b => b.addEventListener('click', () => {
      const key = b.dataset.key;
      if (key.startsWith('sp:')) {
        const f = allFiles().find(x => x.id === key.slice(3));
        if (f) openDrawing(f);
      } else {
        const fp = key.slice(3);
        if (State.S.fingerprint === fp) { if (isPhone()) closePanel(); return; }
        const r = projectRows().find(x => x.fp === fp);
        if (r) Home.openProject(r.fp, r.id);
        if (isPhone()) closePanel();
      }
    }));
    // thumbnails for sheets on the device that don't have one yet
    body.querySelectorAll('.dp-thumb.none[data-fp]').forEach(t => { if (t.dataset.fp && localIdx[t.dataset.fp]) queueThumb(t.dataset.fp); });
  }

  function openPanel() {
    const el = document.getElementById('drawPanel');
    if (!el) return;
    panelOpen = true;
    el.classList.remove('hidden');
    document.body.classList.add('draw-open');
    if (!isPhone()) saveJson(PANEL_KEY, true);
    renderPanel();
    refreshLocal();
    maybeAutoSync();
  }
  function closePanel() {
    const el = document.getElementById('drawPanel');
    panelOpen = false;
    if (el) el.classList.add('hidden');
    document.body.classList.remove('draw-open');
    if (!isPhone()) saveJson(PANEL_KEY, false);
  }
  const togglePanel = () => { if (panelOpen) closePanel(); else openPanel(); };

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
    renderPanel();
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
    st.pfold = loadJson(PFOLD_KEY, {});
    renderCards();
    // the drawings panel: reopens where it was left on a desktop / iPad
    const closeBtn = document.getElementById('dpClose');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);
    if (loadJson(PANEL_KEY, false) && !isPhone()) {
      const el = document.getElementById('drawPanel');
      if (el) { panelOpen = true; el.classList.remove('hidden'); document.body.classList.add('draw-open'); }
    }
    Store.allThumbs().then(t => { thumbs = t || {}; renderPanel(); });
    State.on('doc', () => {
      if (State.S.pdf && State.S.fingerprint) {
        // the sheet just opened gets its thumbnail from the document already in memory
        makeThumb(State.S.fingerprint, State.S.pdf).catch(() => {});
      }
      if (panelOpen) refreshLocal(); else renderPanel();
    });
    State.on('project', renderPanel);
    let t = 0;
    State.on('autosave', () => { if (!panelOpen) return; clearTimeout(t); t = setTimeout(refreshLocal, 600); });   // markup counts
  }

  document.addEventListener('DOMContentLoaded', init);

  return { onCloudState, sync, openDialog, openPanel, closePanel, togglePanel, rekey, parseName, downloadSection, _state: st };
})();
