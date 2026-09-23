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

  const REG_KEY = 'abmt:spreg';   // the drawings root's register {when, root, sections}
  const REGS_KEY = 'abmt:spregs'; // project folders' registers: folder id → {when, root, path, folder, sections}
  const SEL_KEY = 'abmt:spsel';   // which register Home's card shows: {key, title}
  const MAP_KEY = 'abmt:spmap';   // itemId → {etag, fp, name, when} downloaded on this device
  const FOLD_KEY = 'abmt:spfold'; // section path → folded?
  const PANEL_KEY = 'abmt:drawpanel'; // drawings panel open? (desktop)
  const PFOLD_KEY = 'abmt:dpfold';    // drawings panel: section path → folded?
  const API = '/api/cloud';
  const STALE_MS = 30 * 60000;    // auto re-check the register after this
  const KEEP_REGS = 12;           // project registers kept on the device

  // One register per folder: 'root' is the whole drawings root
  // (SP_DRAWINGS_URL); a project's key is its linked folder's item id.
  const st = {
    regs: {},                     // key → { when, root, path, folder, sections }
    status: {},                   // key → { phase, error, errorKind }
    key: 'root', keyTitle: '',    // the register Home's card shows, and its project's name
    chosen: false,                // …picked by hand (else the card follows the open project)
    map: {}, fold: {}, filter: '', busy: false,
    pfilter: '', pfold: {},       // drawings panel search + folds
    // Home's card register in the older single-register shape (Home and the tests read these)
    get reg() { return st.regs[st.key] || null; },
    get phase() { return (st.status[st.key] || {}).phase || 'idle'; },
    get error() { return (st.status[st.key] || {}).error || ''; },
    get errorKind() { return (st.status[st.key] || {}).errorKind || ''; },
  };
  let dlg = null; // { el, close, key, title } while the register dialog is open
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

  async function call(action, body, qs) {
    const headers = { 'X-AirMark-Auth': cloudSt().token || '' };
    const url = API + '?action=' + action + (qs ? '&' + qs : '');
    let resp;
    try {
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
      } else {
        resp = await fetch(url, { headers, signal: AbortSignal.timeout(45000) });
      }
    } catch (e) { const err = new Error('No connection.'); err.offline = true; throw err; }
    let j;
    try { j = await resp.json(); } catch (e) { throw new Error('Unexpected reply (HTTP ' + resp.status + ').'); }
    if (j.badAuth) { Cloud.signOut(true); throw new Error(j.statusmessage); }
    if (!j.ok) throw new Error(j.statusmessage || 'SharePoint error');
    return j;
  }

  /* ---------------- register data ---------------- */

  const regOf = key => st.regs[key || 'root'] || null;
  const statusOf = key => st.status[key || 'root'] || {};
  const allFiles = key => ((regOf(key) || {}).sections || []).flatMap(s => s.files);

  function fileState(f) {
    const m = st.map[f.id];
    if (!m) return 'cloud';
    return m.etag === f.etag ? 'have' : 'update';
  }

  /** How much of a register is on this device — null until it has been fetched once. */
  function summary(key) {
    if (!regOf(key)) return null;
    const files = allFiles(key);
    return { total: files.length, have: files.filter(f => fileState(f) !== 'cloud').length };
  }

  /* ---------------- which folder is whose ---------------- */

  // Folder names that say what a folder holds, not which job it is for
  const GENERIC_FOLDER = /^(\d+[\s_.-]*)?(drawings?|dwgs?|engineering|eng|layouts?|designs?|plans?|pdfs?|as[\s_-]?builts?|markups?|current|latest|issued|superseded|for[\s_-]?construction|ifc|documents?|docs?|files?|sheets?|revisions?|revs?|[A-Z&]{1,4})$/i;
  const STATUS_FOLDER = /^(in[\s_-]?progress|dlp|archived?|submitted|draft|rejected|templates?|completed?|done|tenders?|projects?|jobs?|sites?)$/i;
  /** A project name read off a linked folder's path — the deepest folder that is named for the job, not for what it holds. */
  function guessName(folder) {
    const segs = String((folder && folder.path) || '').split('/').map(s => s.trim()).filter(Boolean);
    for (let i = segs.length - 1; i >= 0; i--) if (!GENERIC_FOLDER.test(segs[i]) && !STATUS_FOLDER.test(segs[i])) return segs[i];
    return '';
  }

  /** Every project with a linked SharePoint folder, as Home groups them (by name, folder or AroFlo number). */
  function linkedProjects() {
    const out = new Map();
    if (typeof Home !== 'undefined' && Home.projectGroups) {
      for (const g of Home.projectGroups()) if (g.folder && g.folder.id && !out.has(g.folder.id)) out.set(g.folder.id, { key: g.folder.id, title: g.name || g.folder.name, folder: g.folder });
    }
    if (State.S.pdf && typeof Project !== 'undefined') {
      const f = Project.spFolder();
      if (f && f.id && !out.has(f.id)) out.set(f.id, { key: f.id, title: String(Project.details().name || '').trim() || guessName(f) || f.name, folder: f });
    }
    return [...out.values()];
  }

  /** The open drawing's project folder: its own link, or the link on another sheet of the same project. */
  function panelFolder() {
    if (!State.S.pdf) return null;
    const own = Project.spFolder();
    if (own) return own;
    const g = typeof Home !== 'undefined' && Home.projectOf ? Home.projectOf(State.S.fingerprint) : null;
    return (g && g.folder) || null;
  }
  const panelKey = () => { const f = panelFolder(); return f ? f.id : 'root'; };

  /** What a register is called — the project's name, else the folder's, else the root's. */
  function regTitle(key) {
    if (!key || key === 'root') return (regOf('root') || {}).root || '';
    const lp = linkedProjects().find(p => p.key === key);
    if (lp) return lp.title;
    const reg = regOf(key);
    return (reg && reg.folder && reg.folder.name) || (reg && reg.root) || (key === st.key ? st.keyTitle : '') || '';
  }

  function saveRegs() {
    if (st.regs.root) saveJson(REG_KEY, st.regs.root);
    const keys = Object.keys(st.regs).filter(k => k !== 'root').sort((a, b) => st.regs[b].when - st.regs[a].when);
    for (const k of keys.slice(KEEP_REGS)) delete st.regs[k];
    const others = {};
    for (const k of keys.slice(0, KEEP_REGS)) others[k] = st.regs[k];
    saveJson(REGS_KEY, others);
  }

  async function sync(key) {
    key = key || st.key || 'root';
    if (!available() || !signedIn() || statusOf(key).phase === 'loading') return;
    st.status[key] = { phase: 'loading', error: '', errorKind: '' };
    renderCards();
    try {
      const r = await call('drawings', undefined, key === 'root' ? '' : 'folder=' + encodeURIComponent(key));
      st.regs[key] = { when: Date.now(), root: r.root || '', path: (r.folder && r.folder.path) || '', folder: r.folder || null, sections: r.sections || [] };
      saveRegs();
      st.status[key] = { phase: 'idle', error: '', errorKind: '' };
      // the folder was moved or renamed on SharePoint (a job going from In-Progress
      // to DLP, say): the link is by SharePoint's id, so it still works — the open
      // drawing's copy of the name and path just catches up
      if (key !== 'root' && r.folder && State.S.pdf) {
        const own = Project.spFolder();
        if (own && own.id === key && (own.path !== (r.folder.path || '') || own.name !== (r.folder.name || ''))) {
          Project.setDetails({ spFolder: { id: key, name: r.folder.name || '', path: r.folder.path || '' } });
        }
      }
    } catch (e) {
      st.status[key] = {
        phase: 'idle',
        error: e.offline
          ? (regOf(key) ? 'Offline — showing the last saved register.' : 'Offline — the register loads when there’s signal.')
          : e.message,
        errorKind: e.offline ? 'offline' : 'setup',
      };
    }
    renderCards();
    if (typeof Home !== 'undefined' && Home.renderProjects) Home.renderProjects();   // the projects' drawing counts
  }

  /** A register's error, with a Check setup button when it is the deployment rather than the signal. */
  const errHtml = key => { const s = statusOf(key); return !s.error ? '' :
    `<div class="cloud-err">${esc(s.error)}</div>${s.errorKind === 'setup'
      ? '<div class="sp-fix"><button type="button" class="mini-btn" data-act="check" title="Test each step of the SharePoint setup and say which one needs fixing">Check setup</button></div>' : ''}`; };

  /** Step-by-step test of the SharePoint setup (server-side, from a fresh Microsoft sign-in). */
  async function checkSetup() {
    let body = null;
    const close = App.modal(`<h3>SharePoint setup check</h3>
      <div id="spChk" class="spchk"><div class="cloud-note">Checking the deployment settings, the Microsoft sign-in, the drawings folder and its PDFs…</div></div>
      <div class="modal-actions"><button type="button" class="mini-btn" id="spChkClose">Close</button><button type="button" class="mini-btn primary" id="spChkSync">Sync</button></div>`,
      (box, cl) => {
        body = box.querySelector('#spChk');
        box.querySelector('#spChkClose').addEventListener('click', cl);
        box.querySelector('#spChkSync').addEventListener('click', () => { cl(); sync(st.key); });
      });
    let r;
    try { r = await call('spcheck'); }
    catch (e) {
      if (body && body.isConnected) body.innerHTML = `<div class="cloud-err">${esc(e.offline ? 'No connection — the check needs signal.' : e.message)}</div>`;
      return;
    }
    if (!body || !body.isConnected) return;
    const steps = Array.isArray(r.steps) ? r.steps : [];
    body.innerHTML = steps.map(s => `<div class="spchk-row ${s.ok ? 'ok' : 'bad'}"><span class="spchk-mark">${s.ok ? '✓' : '✗'}</span>
      <span class="spchk-main"><b>${esc(s.name)}</b><span class="spchk-detail">${esc(s.detail)}</span></span></div>`).join('')
      + (r.passed
        ? '<div class="cloud-note">Everything checks out — tap Sync to load the register.</div>'
        : '<div class="cloud-note">Fix the first ✗ step, then run the check again — it signs in afresh each time, so a permission granted a moment ago counts straight away.</div>');
    void close;
  }

  function maybeAutoSync(key) {
    key = key || st.key || 'root';
    if (!available() || !signedIn()) return;
    const reg = regOf(key);
    if (reg && Date.now() - reg.when < STALE_MS) return;
    if (navigator.onLine === false) return;
    sync(key);
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

  // A sheet opened from a register joins the project it was opened for
  // (same details, status, stock list and folder) unless it has its own:
  // the open project's details while a sheet is open, else the project the
  // register belongs to — its details from a sheet already on this device,
  // or at least its name and folder so it lands under the project on Home.
  async function joinProject(snap, ctx) {
    if (State.S.project) return;
    if (snap && (snap.project || snap.aroSite || snap.jobRef)) { Project.adoptDetails(snap); return; }
    if (!ctx || !ctx.key || ctx.key === 'root') return;
    const reg = regOf(ctx.key);
    const folder = (reg && reg.folder) || null;
    // a project set up on Home ahead of its drawings: this sheet is its first
    const stub = typeof Home !== 'undefined' && Home.stubFor ? Home.stubFor(ctx.key) : null;
    if (stub) { Project.adoptDetails(stub); Home.removeStub(stub.stubId); return; }
    let fromRow = null;
    if (typeof Home !== 'undefined' && Home.projectRows) {
      fromRow = Home.projectRows().find(r => r.onDevice && r.spFolder && r.spFolder.id === ctx.key && r.fp !== State.S.fingerprint) || null;
    }
    const rec = fromRow ? await Store.record(fromRow.fp) : null;
    if (rec && rec.data && rec.data.project) {
      Project.adoptDetails({ project: rec.data.project, aroSite: rec.data.aroSite || null, jobRef: rec.data.jobRef || '' });
    } else if (ctx.title || folder) {
      Project.setDetails({ name: ctx.title || '', spFolder: folder ? { id: ctx.key, name: folder.name, path: folder.path } : null });
    }
  }
  const afterOpen = () => { if (isPhone()) closePanel(); renderPanel(); };

  async function openDrawing(f, ctx) {
    if (st.busy) return;
    const m = st.map[f.id];
    const snap = State.S.pdf ? Project.detailsSnapshot() : null;

    // already on this device and unchanged on SharePoint → plain offline open
    if (m && m.etag === f.etag && m.fp) {
      const have = await Store.get(m.fp);
      if (have && have.pdf) {
        if (dlg) dlg.close();
        await Project.openFromStore(m.fp);
        await joinProject(snap, ctx);
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
        await joinProject(snap, ctx);
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

  /** A sheet removed from the device: the register shows it as not downloaded again. */
  function forget(fp) {
    let changed = false;
    for (const k of Object.keys(st.map)) if (st.map[k].fp === fp) { delete st.map[k]; changed = true; }
    if (changed) { saveJson(MAP_KEY, st.map); renderCards(); }
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

  async function downloadSection(path, key) {
    const sec = allSections(key || panelKey()).find(s => s.path === path);
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

  const allSections = key => ((regOf(key) || {}).sections || []);

  function panelSectionHtml(sec, q, key) {
    const cur = State.S.fingerprint;
    const files = q ? sec.files.filter(f => (f.name + ' ' + sec.path).toLowerCase().includes(q)) : sec.files;
    if (!files.length) return '';
    const have = sec.files.filter(f => fileState(f) !== 'cloud').length;
    const missing = sec.files.length - have;
    const folded = q ? false : !!st.pfold[foldKey(key, sec.path)];
    const reg = regOf(key);
    const rows = files.map(f => {
      const m = st.map[f.id], fp = m && m.fp;
      const rec = fp && localIdx[fp];
      return panelRowHtml({ key: 'sp:' + f.id, id: f.id, name: f.name, fileName: f.name, fp, state: fileState(f), markups: rec ? rec.markups : 0, isCur: !!fp && fp === cur });
    }).join('');
    return `<div class="dp-sec${folded ? ' folded' : ''}" data-path="${esc(sec.path)}">
      <div class="dp-sechead">
        <button type="button" class="dp-secbtn" data-path="${esc(sec.path)}">
          <span class="dp-chev">${folded ? '▸' : '▾'}</span>
          <span class="dp-secmain"><span class="dp-secname">${esc(sec.path || (reg && reg.root) || 'Drawings')}</span>
          <span class="dp-secn">${have} of ${sec.files.length} drawing${sec.files.length === 1 ? '' : 's'} downloaded</span></span>
        </button>
        ${missing ? `<button type="button" class="dp-dlall" data-path="${esc(sec.path)}" title="Download all ${missing} to this device"${st.busy ? ' disabled' : ''}>${ICON_DL}</button>` : '<span class="dp-dlall done" title="All on this device">✓</span>'}
      </div>
      ${folded ? '' : rows}
    </div>`;
  }

  // drawings of the open project that aren't in the register: device + team cloud
  function projectRows() {
    if (typeof Home === 'undefined' || !Home.projectOf) return [];
    const spFps = new Set(Object.values(st.map).map(m => m.fp).filter(Boolean));
    const cur = State.S.fingerprint;
    const g = Home.projectOf(cur);
    const rows = g ? g.rows : Home.projectRows().filter(r => r.fp === cur);
    return rows
      .filter(r => !spFps.has(r.fp) && !r.stub)
      .map(r => ({ key: 'pj:' + r.fp, fp: r.fp, id: r.id, name: r.name, fileName: r.fileName, state: r.onDevice ? 'have' : 'cloud', markups: r.markups || 0, isCur: r.fp === cur }));
  }

  function renderPanel() {
    const body = document.getElementById('dpBody');
    if (!body || !panelOpen) return;
    const q = st.pfilter.trim().toLowerCase();
    const key = panelKey();
    let h = `<div class="dp-tools"><input type="search" id="dp-q" placeholder="Search drawings…" value="${esc(st.pfilter)}" autocomplete="off"></div>`;
    if (available()) {
      if (!signedIn()) {
        h += '<div class="dp-sync"><span class="muted">Sign in to the team cloud (Home) and the project’s SharePoint drawing register loads here.</span></div>';
      } else {
        const reg = regOf(key), s = statusOf(key);
        const files = allFiles(key);
        const have = files.filter(f => fileState(f) !== 'cloud').length;
        const folder = panelFolder();
        const where = folder ? esc(folder.path || folder.name) : (reg && reg.root ? esc(reg.root) + ' (the whole drawings root)' : '');
        h += `<div class="dp-sync"><div class="dp-syncmain"><b>${s.phase === 'loading' ? 'Checking SharePoint…' : 'Check for updates'}</b>
            <small class="muted">${where ? where + ' · ' : ''}Updated ${esc(ageOf(reg && reg.when))}${files.length ? ` · ${have} of ${files.length} on device` : ''}</small></div>
          <button type="button" class="mini-btn primary" data-act="sync"${s.phase === 'loading' ? ' disabled' : ''}>Sync</button></div>`;
        // an open project with no folder of its own: offer the link right here
        if (!folder && State.S.project && State.S.project.name) {
          h += '<div class="dp-linkhint">Showing the whole drawings root. <button type="button" class="pj-link" data-act="link">Link this project’s folder…</button></div>';
        }
        h += errHtml(key);
        const secs = allSections(key).map(sec => panelSectionHtml(sec, q, key)).join('');
        h += secs || (reg ? `<div class="cloud-note">${q ? 'Nothing matches “' + esc(st.pfilter) + '”.' : 'No PDFs in this folder yet.'}</div>` : '');
      }
    }
    const others = projectRows().filter(r => !q || (r.fileName + ' ' + r.name).toLowerCase().includes(q));
    if (others.length) {
      const g = typeof Home !== 'undefined' && Home.projectOf ? Home.projectOf(State.S.fingerprint) : null;
      const label = esc((g && g.name) || (State.S.project && State.S.project.name) || 'This project');
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
    if (syncBtn) syncBtn.addEventListener('click', () => { syncBtn.disabled = true; syncBtn.textContent = '…'; sync(key); });
    const chkBtn = body.querySelector('[data-act="check"]');
    if (chkBtn) chkBtn.addEventListener('click', checkSetup);
    const linkBtn = body.querySelector('[data-act="link"]');
    if (linkBtn) linkBtn.addEventListener('click', () => pickFolder({ hints: projectHints() }, f => { Project.setDetails({ spFolder: f }); maybeAutoSync(f.id); }));
    body.querySelectorAll('.dp-secbtn[data-path]').forEach(b => b.addEventListener('click', () => {
      const fk = foldKey(key, b.dataset.path);
      st.pfold[fk] = !st.pfold[fk];
      saveJson(PFOLD_KEY, st.pfold);
      renderPanel();
    }));
    body.querySelectorAll('.dp-dlall[data-path]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); downloadSection(b.dataset.path, key); }));
    body.querySelectorAll('.dp-row').forEach(b => b.addEventListener('click', () => {
      const rk = b.dataset.key;
      if (rk.startsWith('sp:')) {
        const f = allFiles(key).find(x => x.id === rk.slice(3));
        if (f) openDrawing(f, { key, title: regTitle(key) });
      } else {
        const fp = rk.slice(3);
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
    maybeAutoSync(panelKey());
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

  // fold state is per register: the root's keys are bare paths (as stored before projects had folders)
  const foldKey = (key, path) => (!key || key === 'root') ? path : key + '|' + path;

  function sectionsHtml(key) {
    const reg = regOf(key), s = statusOf(key);
    if (!reg || !reg.sections.length) {
      if (s.phase === 'loading') return '<div class="cloud-note">Checking SharePoint…</div>';
      if (!reg && s.error) return '';   // the error says what happened; "no PDFs" would be a second, wrong story
      return '<div class="cloud-note">No PDFs found in the drawings folder yet.</div>';
    }
    const q = st.filter.trim().toLowerCase();
    const total = allFiles(key).length;
    const defFold = total > 12;
    let h = '';
    for (const sec of reg.sections) {
      const files = q ? sec.files.filter(f => f.name.toLowerCase().includes(q) || sec.path.toLowerCase().includes(q)) : sec.files;
      if (!files.length) continue;
      const have = sec.files.filter(f => fileState(f) !== 'cloud').length;
      const fk = foldKey(key, sec.path);
      const folded = q ? false : (st.fold[fk] !== undefined ? st.fold[fk] : defFold);
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

  // Home's card follows the register the user picked (a project, or the
  // whole root); when a project's link is gone, it falls back to the root
  function cardKey() {
    if (st.key !== 'root' && !linkedProjects().some(p => p.key === st.key) && !regOf(st.key)) st.key = 'root';
    // nothing picked yet: the open drawing's project, if it has a folder
    if (!st.chosen) { const f = panelFolder(); if (f && f.id) return f.id; }
    return st.key;
  }
  function selectKey(key, title) {
    st.key = key || 'root'; st.keyTitle = title || ''; st.chosen = true;
    saveJson(SEL_KEY, { key: st.key, title: st.keyTitle });
    renderCards();
    maybeAutoSync(st.key);
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
    const key = opts.key || cardKey();
    const reg = regOf(key), s = statusOf(key);
    const files = allFiles(key);
    const have = files.filter(f => fileState(f) !== 'cloud').length;
    const title = opts.title || regTitle(key);
    // the projects with folders of their own, as a picker on Home's card
    const linked = opts.dialog ? [] : linkedProjects();
    const rootName = (regOf('root') || {}).root || 'the whole drawings root';
    const picker = linked.length ? `<select class="sp-projsel" data-act="proj" title="Which project’s drawings to show">
        ${linked.map(p => `<option value="${esc(p.key)}"${p.key === key ? ' selected' : ''}>${esc(p.title)}</option>`).join('')}
        <option value="root"${key === 'root' ? ' selected' : ''}>All site drawings — ${esc(rootName)}</option></select>` : '';
    el.innerHTML = `
      <div class="cloud-card sp-card">
        ${opts.dialog ? '' : `<div class="recent-cap">Site drawings${picker ? '' : (title ? ' — ' + esc(title) : '')}${picker}</div>`}
        <div class="cloud-who">
          <span>SharePoint${reg && reg.path ? ' · ' + esc(reg.path) : ''} · checked ${esc(ageOf(reg && reg.when))}${files.length ? ` · <b>${have} of ${files.length}</b> on device` : ''}</span>
          <button class="mini-btn" data-act="sync" title="Check SharePoint for new and updated drawings"${s.phase === 'loading' ? ' disabled' : ''}>${s.phase === 'loading' ? '…' : '⟳ Sync'}</button>
        </div>
        ${errHtml(key)}
        ${files.length > 6 ? `<div class="sp-search"><input type="search" data-act="filter" placeholder="Search drawings…" value="${esc(st.filter)}"></div>` : ''}
        <div class="sp-list">${sectionsHtml(key)}</div>
      </div>`;

    el.querySelector('[data-act="sync"]').addEventListener('click', e => { e.stopPropagation(); sync(key); });
    const chk = el.querySelector('[data-act="check"]');
    if (chk) chk.addEventListener('click', e => { e.stopPropagation(); checkSetup(); });
    const sel = el.querySelector('[data-act="proj"]');
    if (sel) {
      sel.addEventListener('click', e => e.stopPropagation());
      sel.addEventListener('change', () => { const p = linked.find(x => x.key === sel.value); selectKey(sel.value, p ? p.title : ''); });
    }
    const search = el.querySelector('[data-act="filter"]');
    if (search) {
      search.addEventListener('input', () => {
        st.filter = search.value;
        const list = el.querySelector('.sp-list');
        if (list) list.innerHTML = sectionsHtml(key);
        wireList(el, key, title);
      });
      search.addEventListener('click', e => e.stopPropagation());
    }
    wireList(el, key, title);
  }

  function wireList(el, key, title) {
    el.querySelectorAll('.sp-sechead').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const sec = b.closest('.sp-sec');
      const fk = foldKey(key, sec.dataset.path);
      const total = allFiles(key).length;
      const cur = st.fold[fk] !== undefined ? st.fold[fk] : total > 12;
      st.fold[fk] = !cur;
      saveJson(FOLD_KEY, st.fold);
      renderCards();
    }));
    el.querySelectorAll('.sp-row').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const f = allFiles(key).find(x => x.id === b.dataset.id);
      if (f) openDrawing(f, { key, title });
    }));
  }

  function renderCards() {
    renderInto(document.getElementById('spCard'));
    if (dlg && dlg.el && dlg.el.isConnected) renderInto(dlg.el, { dialog: true, key: dlg.key, title: dlg.title });
    else dlg = null;
    renderPanel();
  }

  /** The register in a dialog — Home's Drawings item, or one project's folder from its Home heading. */
  function openDialog(opts = {}) {
    const key = opts.key || cardKey();
    const title = opts.title || regTitle(key);
    App.modal(`<h3>Site drawings${title ? ' — ' + esc(title) : ''}</h3><div id="spDlgBody"></div>`, (box, close) => {
      dlg = { el: box.querySelector('#spDlgBody'), key, title, close: () => { dlg = null; close(); } };
      renderInto(dlg.el, { dialog: true, key, title });
    });
    maybeAutoSync(key);
  }

  /* ---------------- choosing a project's folder ---------------- */

  const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

  /** Words that mark the open project's folder: its AroFlo number, name and site. */
  function projectHints() {
    const d = State.S.pdf ? Project.details() : {};
    return [State.S.aroSite && State.S.aroSite.project, d.name, d.site];
  }

  /**
   * Browse the drawings root one level at a time and pick the project's
   * folder (or paste its address). Its own overlay, so the dialog it was
   * opened from stays as typed underneath. cb({id, name, path}) on a pick.
   */
  function pickFolder(opts, cb) {
    const hints = ((opts && opts.hints) || []).map(s => String(s || '').trim().toLowerCase()).filter(h => h.length >= 2);
    const suggested = name => { const n = String(name).toLowerCase(); return hints.some(h => n.includes(h) || (h.length >= 4 && h.includes(n))); };
    const old = document.getElementById('spPick');
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'spPick'; ov.className = 'sp-pick';
    ov.innerHTML = `<div class="sp-pick-back"></div><div class="sp-pick-box" role="dialog">
      <h3>Choose the project’s drawings folder</h3>
      <div class="spb-crumbs" id="spb-crumbs"></div>
      <div class="spb-list" id="spb-list"><div class="cloud-note">Loading…</div></div>
      <div class="spb-paste"><input type="url" id="spb-url" placeholder="…or paste the folder’s address (Copy link on SharePoint)" autocomplete="off"><button type="button" class="mini-btn" id="spb-find">Find</button></div>
      <div class="cloud-err" id="spb-err"></div>
      <div class="modal-actions"><button type="button" class="mini-btn" id="spb-cancel">Cancel</button><button type="button" class="mini-btn primary" id="spb-use" disabled>Use this folder</button></div>
    </div>`;
    document.body.appendChild(ov);
    const q = sel => ov.querySelector(sel);
    const done = f => { ov.remove(); if (f) cb(f); };
    q('.sp-pick-back').onclick = () => done();
    q('#spb-cancel').onclick = () => done();
    let trail = [];   // [{id, name}] root … the folder shown ('' is the root)
    let cur = null;   // the folder shown: {id, name, path, isRoot}
    async function show(id) {
      q('#spb-list').innerHTML = '<div class="cloud-note">Loading…</div>';
      q('#spb-err').textContent = '';
      q('#spb-use').disabled = true;
      let r;
      try { r = await call('spbrowse', undefined, id ? 'folder=' + encodeURIComponent(id) : ''); }
      catch (e) { q('#spb-list').innerHTML = `<div class="cloud-err">${esc(e.offline ? 'No connection — choosing a folder needs signal.' : e.message)}</div>`; return; }
      if (!ov.isConnected) return;
      cur = r.folder;
      if (cur.isRoot) trail = [{ id: '', name: r.rootName || cur.name }];
      else {
        const i = trail.findIndex(t => t.id === cur.id);
        if (i >= 0) trail = trail.slice(0, i + 1);
        else { if (!trail.length) trail = [{ id: '', name: r.rootName || 'Drawings' }]; trail.push({ id: cur.id, name: cur.name }); }
      }
      q('#spb-crumbs').innerHTML = trail.map((t, i) => `<button type="button" class="spb-crumb${i === trail.length - 1 ? ' cur' : ''}" data-id="${esc(t.id)}">${esc(t.name)}</button>`).join('<span class="spb-sep">›</span>');
      q('#spb-crumbs').querySelectorAll('.spb-crumb').forEach(b => { b.onclick = () => show(b.dataset.id); });
      const folders = (r.folders || []).map(f => ({ ...f, sug: suggested(f.name) })).sort((a, b) => (b.sug ? 1 : 0) - (a.sug ? 1 : 0));
      q('#spb-list').innerHTML = (folders.length
        ? folders.map(f => `<button type="button" class="spb-row${f.sug ? ' sug' : ''}" data-id="${esc(f.id)}">${ICON_FOLDER}<span class="spb-name">${esc(f.name)}</span>${f.sug ? '<span class="spb-tag">suggested</span>' : ''}<span class="spb-n">${f.items} item${f.items === 1 ? '' : 's'}</span></button>`).join('')
        : '<div class="cloud-note">No sub-folders here.</div>')
        + `<div class="cloud-note">${r.pdfs ? `${r.pdfs} PDF${r.pdfs === 1 ? '' : 's'} directly in this folder` : 'No PDFs directly in this folder'}${cur.isRoot ? ' — this is the drawings root; pick the project’s own folder inside it' : ''}.</div>`;
      q('#spb-list').querySelectorAll('.spb-row').forEach(b => { b.onclick = () => show(b.dataset.id); });
      q('#spb-use').disabled = !!cur.isRoot;
      q('#spb-use').textContent = cur.isRoot ? 'Use this folder' : 'Use “' + cur.name + '”';
    }
    q('#spb-use').onclick = () => { if (cur && !cur.isRoot) done({ id: cur.id, name: cur.name, path: cur.path }); };
    q('#spb-find').onclick = async () => {
      const url = q('#spb-url').value.trim();
      if (!url) return;
      q('#spb-err').textContent = '';
      q('#spb-find').disabled = true;
      try {
        const r = await call('spresolve', { url });
        if (r.folder.isRoot) q('#spb-err').textContent = 'That is the drawings root itself — paste the address of the project’s own folder inside it.';
        else done({ id: r.folder.id, name: r.folder.name, path: r.folder.path });
      } catch (e) { q('#spb-err').textContent = e.offline ? 'No connection.' : e.message; }
      if (ov.isConnected) q('#spb-find').disabled = false;
    };
    q('#spb-url').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); q('#spb-find').click(); } });
    show(opts && opts.current && opts.current.id ? opts.current.id : '');
  }

  /** Called by Cloud whenever sign-in state or the deployment probe changes
   *  (Home refreshes its Drawings menu item from the same hook). */
  function onCloudState() {
    renderCards();
    maybeAutoSync(cardKey());
  }

  // Home repaints its project list often; the card only needs redrawing when
  // the set of projects with folders (its picker) actually changed
  let linkedSig = '';
  function projectsChanged() {
    const sig = linkedProjects().map(p => p.key + '|' + p.title).join(',');
    if (sig === linkedSig) return;
    linkedSig = sig;
    renderCards();
  }

  function init() {
    st.regs = loadJson(REGS_KEY, {});
    const root = loadJson(REG_KEY, null);
    if (root) st.regs.root = root;
    const sel = loadJson(SEL_KEY, null);
    if (sel && sel.key) { st.key = sel.key; st.keyTitle = sel.title || ''; st.chosen = true; }
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
    // the project's folder may have changed: the panel follows it, Home's card picker too
    State.on('project', () => { renderCards(); if (panelOpen) maybeAutoSync(panelKey()); });
    let t = 0;
    State.on('autosave', () => { if (!panelOpen) return; clearTimeout(t); t = setTimeout(refreshLocal, 600); });   // markup counts
  }

  document.addEventListener('DOMContentLoaded', init);

  return { onCloudState, sync, checkSetup, openDialog, openPanel, closePanel, togglePanel, rekey, forget, parseName, downloadSection,
    available, summary, linkedProjects, guessName, pickFolder, selectKey, projectsChanged, _state: st };
})();
