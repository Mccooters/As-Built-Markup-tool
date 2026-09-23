/* ============ home.js — the home shell: sidebar + landing page ============
 *
 * AirMark opens on a simple Procore-style home: a dark sidebar (Home,
 * Current drawing, Drawings, Site stock, Deliveries; Settings, Help, Log out;
 * account chip) and a page of cards — the drawing you were on, the project
 * list (everything on this device and in the team cloud, grouped In progress
 * / DLP / Completed) and the SharePoint drawing register. The full editor
 * chrome (toolbar, tool rail, properties panel, markups list, status bar)
 * only appears once a drawing is actually open.
 *
 * The same sidebar is reachable at any time: in the editor the ≡ button
 * slides it in as a drawer over the drawing (body.menu-open), so nothing
 * needs to be duplicated in the toolbar. The logo jumps straight Home.
 *
 * The shell is a fixed overlay toggled by body.mode-home / body.mode-editor
 * rather than display:none on the editor: the viewer keeps its real size
 * underneath, so fit-to-page and pinch maths never meet a 0×0 viewport while
 * a drawing is loading.
 */
'use strict';

const Home = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let mode = 'home';

  /* ---------------- mode switch + drawer ---------------- */

  const menuOpen = () => document.body.classList.contains('menu-open');
  function openMenu() { document.body.classList.add('menu-open'); refresh(); }
  function closeMenu() { document.body.classList.remove('menu-open'); }
  function toggleMenu() { if (menuOpen()) closeMenu(); else openMenu(); }

  function setMode(m) {
    mode = m === 'editor' ? 'editor' : 'home';
    document.body.classList.toggle('mode-home', mode === 'home');
    document.body.classList.toggle('mode-editor', mode === 'editor');
    document.body.classList.remove('panel-open', 'menu-open');   // no drawer survives a switch
    refresh();
    // coming back to Home: pick up statuses / saves teammates made meanwhile
    if (mode === 'home' && typeof Cloud !== 'undefined' && Cloud.refreshListIfStale) Cloud.refreshListIfStale();
  }

  /* ---------------- who's using it ---------------- */

  const cloudState = () => (typeof Cloud !== 'undefined' ? Cloud._state : null);

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return parts.length ? parts.slice(0, 2).map(p => p[0].toUpperCase()).join('') : '?';
  }

  function whoAmI() {
    const cl = cloudState();
    if (cl && cl.token && cl.name) return { name: cl.name, sub: 'Team cloud', signed: true, known: true };
    const canSignIn = !!(cl && cl.enabled === true);
    const author = State.S.author && State.S.author !== 'Field' ? State.S.author : '';
    if (author) return { name: author, sub: canSignIn ? 'Tap to sign in' : 'Author name', signed: false, known: true };
    return { name: 'Not signed in', sub: canSignIn ? 'Tap to sign in' : 'Tap to set your name', signed: false, known: false };
  }

  /* ---------------- the project list ---------------- */
  // One list, grouped by status — In progress / DLP / Completed — merging
  // what's stored on this device with the team cloud's registry. A project
  // in both shows once. The registry's status is the team's shared truth;
  // the open drawing shows what's on screen.

  const STATUS_LABEL = { active: 'In progress', dlp: 'DLP — defects liability period', done: 'Completed / archived' };
  const STATUS_SHORT = { active: 'In progress', dlp: 'DLP', done: 'Completed' };
  let localRows = [], localSig = '', localSeq = 0;
  const secOpen = Object.assign({ active: true, dlp: true, done: false },
    (() => { try { return JSON.parse(localStorage.getItem('abmt:pjsec') || '{}'); } catch (e) { return {}; } })());

  const ageOf = t => {
    const ms = typeof t === 'number' ? t : Date.parse(t || '');
    if (!Number.isFinite(ms) || !ms) return '';
    const mins = Math.round((Date.now() - ms) / 60000);
    return mins < 1 ? 'just now' : mins < 60 ? mins + ' min ago' : mins < 1440 ? Math.round(mins / 60) + ' h ago' : Math.round(mins / 1440) + ' d ago';
  };

  function mergedProjects() {
    const cl = cloudState();
    const cloud = cl && cl.token ? cl.projects || [] : [];
    const byFp = new Map();
    for (const r of localRows) {
      byFp.set(r.fingerprint, { fp: r.fingerprint, name: r.name, pname: r.pname || '', fileName: r.fileName || '', status: r.status, site: r.site, client: r.client, aroNo: r.aroNo, savedAt: r.savedAt, markups: r.markups || 0, onDevice: true, spFolder: r.spFolder || null });
    }
    for (const p of cloud) {
      const fp = p.fingerprint || ('cloud:' + p.id);
      const row = byFp.get(fp) || { fp, onDevice: false };
      row.id = p.id; row.inCloud = true;
      if (!row.name) row.name = p.name;
      // the registry name is the project name unless it is just the file's
      const fromFile = p.fileName && p.name === String(p.fileName).replace(/\.pdf$/i, '');
      if (!row.pname && !fromFile) row.pname = p.name || '';
      if (!row.fileName) row.fileName = p.fileName || '';
      if (!row.aroNo) row.aroNo = p.aroNo;
      if (!row.spFolder && p.spFolder && p.spFolder.id) row.spFolder = p.spFolder;
      row.updatedBy = p.updatedBy; row.updatedAt = p.updatedAt;
      if (p.status) row.status = p.status;
      byFp.set(fp, row);
    }
    if (State.S.pdf && State.S.fingerprint) {
      const row = byFp.get(State.S.fingerprint) || { fp: State.S.fingerprint };
      const d = Project.details();
      row.open = true; row.onDevice = true;
      row.name = Project.displayName(); row.status = Project.status();
      row.pname = d.name || ''; row.fileName = State.S.fileName || '';
      row.markups = State.S.markups.length;
      row.site = d.site || ''; row.client = d.client || '';
      row.aroNo = (State.S.aroSite && State.S.aroSite.project) || row.aroNo || '';
      row.spFolder = Project.spFolder() || row.spFolder || null;
      byFp.set(State.S.fingerprint, row);
    }
    // projects set up on this device that have no drawing yet
    for (const s of stubs) byFp.set('stub:' + s.id, stubRow(s));
    const rows = [...byFp.values()];
    for (const r of rows) {
      r.status = Project.normStatus(r.status);
      r.when = Math.max(r.savedAt || 0, Date.parse(r.updatedAt || '') || 0);
    }
    rows.sort((a, b) => (b.open ? 1 : 0) - (a.open ? 1 : 0) || b.when - a.when);
    return rows;
  }

  // drawings that share a project name sit together under one heading — and
  // so does a project with a SharePoint drawings folder of its own, whose
  // heading carries the way into that folder's register
  const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const folderOf = grp => { for (const x of grp) if (x.spFolder && x.spFolder.id) return x.spFolder; return null; };
  function drawBtn(f, title) {
    const sum = typeof Drawings !== 'undefined' && Drawings.summary ? Drawings.summary(f.id) : null;
    const label = sum ? `${sum.total} site drawing${sum.total === 1 ? '' : 's'}${sum.have ? ` · ${sum.have} on device` : ''}` : 'Site drawings';
    return `<button type="button" class="pj-draw" data-key="${esc(f.id)}" data-title="${esc(title)}" title="${esc(f.path || f.name)} on SharePoint — the project’s drawing register">${ICON_FOLDER}<span>${label}</span></button>`;
  }

  // What makes two sheets the same project: a shared project name, a shared
  // SharePoint drawings folder, or a shared AroFlo project number — any one
  // of them. So a sheet opened for a job joins it even before anyone has
  // typed a project name, and naming one sheet later never splits the job.
  function projectGroups(rows) {
    const parent = rows.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    const seen = new Map();
    rows.forEach((r, i) => {
      const keys = [];
      const n = String(r.pname || '').trim().toLowerCase(); if (n) keys.push('n:' + n);
      if (r.spFolder && r.spFolder.id) keys.push('f:' + r.spFolder.id);
      const a = String(r.aroNo || '').trim().toLowerCase(); if (a) keys.push('a:' + a);
      for (const k of keys) { if (seen.has(k)) union(seen.get(k), i); else seen.set(k, i); }
    });
    const groups = new Map();
    rows.forEach((r, i) => { const root = find(i); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(r); });
    return [...groups.values()].map(g => {
      const folder = folderOf(g);
      const aroNo = String((g.find(x => x.aroNo) || {}).aroNo || '').trim();
      // the name: the one typed most often; else read off the folder's path; else the AroFlo number; else the sheet's own name
      const votes = new Map();
      for (const x of g) { const n = String(x.pname || '').trim(); if (n) votes.set(n, (votes.get(n) || 0) + 1); }
      let name = [...votes.entries()].sort((p, q) => q[1] - p[1])[0];
      name = name ? name[0] : '';
      const guessed = !name && folder && typeof Drawings !== 'undefined' && Drawings.guessName ? Drawings.guessName(folder) : '';
      if (!name) name = guessed || (aroNo ? 'AroFlo project #' + aroNo : '') || (g[0].name || '');
      return { rows: g, name, folder, aroNo, named: votes.size > 0, guessed: !votes.size && !!guessed };
    });
  }

  /** The project a sheet belongs to, across everything on this device and in the team cloud. */
  function projectOf(fp) {
    if (!fp) return null;
    return projectGroups(mergedProjects()).find(g => g.rows.some(r => r.fp === fp)) || null;
  }

  function rowsHtml(list) {
    const groups = projectGroups(list);
    const groupOf = new Map();
    for (const g of groups) for (const r of g.rows) groupOf.set(r.fp, g);
    const done = new Set();
    let h = '';
    for (const r of list) {
      const g = groupOf.get(r.fp);
      // a heading whenever there is a project to name: several sheets, a folder, or a project set up ahead of its drawings
      if (g.rows.length > 1 || g.folder || g.rows.some(x => x.stub)) {
        if (done.has(g)) continue;
        done.add(g);
        h += `<div class="pj-projhead"><span class="pj-projname${g.named ? '' : ' unnamed'}" title="${g.named ? '' : 'No project name yet — set one in Project details'}">${esc(g.name)}</span>${g.rows.length > 1 ? `<span class="pj-count">${g.rows.length} drawings</span>` : ''}
          <span class="pj-headacts">${g.folder ? drawBtn(g.folder, g.name) : ''}<button type="button" class="pj-add" data-fp="${esc(g.rows[0].fp)}" title="Add a drawing to ${esc(g.name)}" aria-label="Add a drawing to ${esc(g.name)}">＋</button></span></div>`;
        h += g.rows.map(x => rowHtml(x, true)).join('');
      } else h += rowHtml(r, false);
    }
    return h;
  }

  // a project set up ahead of its drawings: the row is the way to add the first one
  function stubRowHtml(r) {
    const meta = [];
    if (r.site) meta.push(esc(r.site)); else if (r.client) meta.push(esc(r.client));
    if (r.aroNo) meta.push('#' + esc(r.aroNo));
    meta.push('<span class="pj-where new" title="Set up on this device — nothing drawn yet">no drawings yet</span>');
    const opts = ['active', 'dlp', 'done'].map(s => `<option value="${s}"${r.status === s ? ' selected' : ''}>${STATUS_SHORT[s]}</option>`).join('');
    return `<div class="pj-row sub stub" data-fp="${esc(r.fp)}">
      <button type="button" class="pj-main pj-addfirst" data-fp="${esc(r.fp)}" title="Add the project’s first drawing — from its SharePoint register or a PDF on this device">
        <span class="pj-name">＋ Add the first drawing</span>
        <span class="pj-meta">${meta.join(' · ')}</span>
      </button>
      <select class="pj-sel ${r.status}" data-fp="${esc(r.fp)}" data-id="" title="Project status — In progress, DLP or Completed" aria-label="Status of ${esc(r.name)}">${opts}</select>
      <button type="button" class="pj-more" data-fp="${esc(r.fp)}" title="Add a drawing · remove this project" aria-label="More for ${esc(r.name)}">⋯</button>
    </div>`;
  }

  function rowHtml(r, inProject) {
    if (r.stub) return stubRowHtml(r);
    const shown = inProject ? (String(r.fileName || '').replace(/\.pdf$/i, '') || r.name) : r.name;
    const meta = [];
    if (r.site) meta.push(esc(r.site)); else if (r.client) meta.push(esc(r.client));
    if (r.aroNo) meta.push('#' + esc(r.aroNo));
    if (r.inCloud && r.updatedBy) meta.push(esc(r.updatedBy) + ' · ' + esc(ageOf(r.updatedAt)));
    else if (r.savedAt) meta.push(esc(ageOf(r.savedAt)));
    meta.push(r.onDevice
      ? '<span class="pj-where dev" title="Stored on this device — opens offline">on this device</span>'
      : '<span class="pj-where cloud" title="In the team cloud — tap to download it to this device">☁ team cloud</span>');
    const opts = ['active', 'dlp', 'done'].map(s => `<option value="${s}"${r.status === s ? ' selected' : ''}>${STATUS_SHORT[s]}</option>`).join('');
    return `<div class="pj-row${r.open ? ' open' : ''}${inProject ? ' sub' : ''}" data-fp="${esc(r.fp)}">
      <button type="button" class="pj-main${r.id ? ' cloud-proj' : ''}" data-fp="${esc(r.fp)}" data-id="${esc(r.id || '')}" title="${esc(r.name)}${r.fileName ? ' — ' + esc(r.fileName) : ''}">
        <span class="pj-name">${esc(shown || 'Drawing')}${r.open ? ' <span class="pj-openchip">open now</span>' : ''}</span>
        <span class="pj-meta">${meta.join(' · ')}</span>
      </button>
      <select class="pj-sel ${r.status}" data-fp="${esc(r.fp)}" data-id="${esc(r.id || '')}" title="Project status — In progress, DLP or Completed" aria-label="Status of ${esc(r.name)}">${opts}</select>
      <button type="button" class="pj-more" data-fp="${esc(r.fp)}" title="Open · remove from this device · delete from the team" aria-label="More for ${esc(r.name)}">⋯</button>
    </div>`;
  }

  /** Per-project actions: open, remove from this device, delete from the team cloud. */
  function projectMenu(fp) {
    const row = mergedProjects().find(r => r.fp === fp);
    if (!row) return;
    if (row.stub) {
      App.modal(`
        <h3>${esc(row.name)}</h3>
        <p class="muted">Set up on this device — no drawings yet.</p>
        <div class="imp-opts">
          <button type="button" class="imp-opt" id="pm-add"><b>Add a drawing</b><span>From its SharePoint register or a PDF on this device — it takes the project’s details, status and stock list.</span></button>
          <button type="button" class="imp-opt danger" id="pm-stubrm"><b>Remove this project</b><span>Nothing has been drawn yet — it just comes off the list.</span></button>
        </div>
        <div class="modal-actions"><button class="mini-btn" id="pm-cancel">Cancel</button></div>`, (box, close) => {
        box.querySelector('#pm-cancel').onclick = close;
        box.querySelector('#pm-add').onclick = () => { close(); addDrawingDialog(fp); };
        box.querySelector('#pm-stubrm').onclick = () => { close(); removeStub(row.stubId); App.toast(`${row.name} removed.`, 'ok', 3000); };
      });
      return;
    }
    const cl = cloudState();
    const signed = !!(cl && cl.token);
    const onDevice = !!row.onDevice;
    const inCloud = !!row.inCloud && !!row.id;
    const where = [
      onDevice ? (row.markups ? row.markups + ' markup' + (row.markups === 1 ? '' : 's') + ' on this device' : 'on this device') : 'not on this device',
      row.inCloud ? 'in the team cloud' + (row.updatedBy ? ' (' + esc(row.updatedBy) + ' · ' + esc(ageOf(row.updatedAt)) + ')' : '') : 'this device only',
    ].join(' · ');
    // destructive actions: the first tap arms the button, a second within 6 s does it
    const arm = (btn, run) => {
      const b = btn.querySelector('b'), orig = b.textContent;
      let armed = false, t = 0;
      btn.addEventListener('click', async () => {
        if (!armed) {
          armed = true; btn.classList.add('armed'); b.textContent = 'Tap again to confirm';
          t = setTimeout(() => { armed = false; btn.classList.remove('armed'); b.textContent = orig; }, 6000);
          return;
        }
        clearTimeout(t); btn.disabled = true; b.textContent = 'Working…';
        await run();
      });
    };
    App.modal(`
      <h3>${esc(row.name)}</h3>
      <p class="muted">${where}</p>
      <div class="imp-opts">
        <button type="button" class="imp-opt" id="pm-open"><b>${row.open ? 'Back to the drawing' : 'Open'}</b><span>${onDevice ? 'From this device — works offline.' : 'Downloads the drawing and markups from the team cloud.'}</span></button>
        <button type="button" class="imp-opt" id="pm-add"><b>Add a drawing to this project</b><span>From its SharePoint register or a PDF on this device — it takes the same details, status and stock list.</span></button>
        ${onDevice ? `<button type="button" class="imp-opt${row.inCloud ? '' : ' danger'}" id="pm-device"><b>Remove from this device</b><span>${row.inCloud
          ? 'Frees the space here. The team cloud copy stays and it can be opened again from this list.'
          : 'This is the only copy — the drawing and its markups are gone for good.'}</span></button>` : ''}
        ${inCloud && signed ? `<button type="button" class="imp-opt danger" id="pm-cloud"><b>Delete from the team cloud</b><span>Gone for everyone — drawing, markups and earlier revisions — and removed from this device. Another device that already downloaded it keeps that copy, as a device-only project.</span></button>` : ''}
      </div>
      <div class="modal-actions"><button class="mini-btn" id="pm-cancel">Cancel</button></div>`, (box, close) => {
      box.querySelector('#pm-cancel').onclick = close;
      box.querySelector('#pm-open').onclick = () => { close(); openProject(row.fp, row.id); };
      box.querySelector('#pm-add').onclick = () => { close(); addDrawingDialog(row.fp); };
      const dev = box.querySelector('#pm-device');
      if (dev) {
        const run = async () => {
          close();
          await Project.removeFromDevice(row.fp);
          App.toast(`${row.name} removed from this device${row.inCloud ? ' — still in the team cloud' : ''}.`, 'ok', 5000);
        };
        if (row.inCloud) dev.onclick = run; else arm(dev, run);
      }
      const cld = box.querySelector('#pm-cloud');
      if (cld) arm(cld, async () => {
        try {
          await Cloud.deleteProject(row.id);
          await Project.removeFromDevice(row.fp);
          close();
          App.toast(`${row.name} deleted from the team cloud and this device.`, 'ok', 6000);
        } catch (e) {
          close();
          App.toast('Couldn’t delete it from the team cloud: ' + e.message, 'error', 8000);
        }
      });
    });
  }

  /* ---------------- projects set up before their first drawing ---------------- */
  // Kept on this device until a sheet matches the project (it then carries
  // the details everywhere a sheet goes — autosave, .airmark, team cloud).

  const STUBS_KEY = 'abmt:projstubs';
  let stubs = (() => { try { return JSON.parse(localStorage.getItem(STUBS_KEY) || '[]') || []; } catch (e) { return []; } })();
  const saveStubs = () => { try { localStorage.setItem(STUBS_KEY, JSON.stringify(stubs)); } catch (e) { /* full */ } };
  const stubSnapshot = s => ({ project: Object.assign({}, s.project || {}), aroSite: s.aroSite ? Object.assign({}, s.aroSite) : null, jobRef: s.jobRef || '', stubId: s.id });

  const stubRow = s => {
    const p = s.project || {}, a = s.aroSite || {};
    return {
      fp: 'stub:' + s.id, stub: true, stubId: s.id, name: p.name || 'New project', pname: p.name || '', fileName: '',
      status: p.status || 'active', site: p.site || '', client: p.client || '', aroNo: a.project || '',
      savedAt: s.createdAt, markups: 0, onDevice: false, inCloud: false, spFolder: p.spFolder && p.spFolder.id ? p.spFolder : null,
    };
  };

  /**
   * New project (no drawing yet): its details wait on Home for the first
   * sheet. Returns { id } — or { existingFp, name } when a project with the
   * same name, folder or AroFlo number is already on the list: the "new"
   * project is that one, and the drawing should go to it.
   */
  function createProject(snap) {
    const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const stub = { id, createdAt: Date.now(), project: (snap && snap.project) || {}, aroSite: (snap && snap.aroSite) || null, jobRef: (snap && snap.jobRef) || '' };
    const g = projectGroups(mergedProjects().concat([stubRow(stub)])).find(x => x.rows.some(r => r.fp === 'stub:' + id));
    const existing = g && g.rows.find(r => !r.stub);
    if (existing) return { id: '', existingFp: existing.fp, name: g.name };
    stubs.push(stub);
    saveStubs();
    renderProjects();
    return { id, existingFp: '', name: stub.project.name || '' };
  }
  function removeStub(id) {
    const n = stubs.length;
    stubs = stubs.filter(s => s.id !== id);
    if (stubs.length !== n) { saveStubs(); renderProjects(); }
  }
  /** The set-up details for a project whose SharePoint folder is this one — a sheet opened from that register takes them. */
  function stubFor(folderId) {
    const s = stubs.find(x => x.project && x.project.spFolder && x.project.spFolder.id === folderId);
    return s ? stubSnapshot(s) : null;
  }

  /** What a sheet added to this project should take: the set-up details, the open drawing's, a stored sheet's, or what the list knows. */
  async function snapshotOf(g) {
    const stub = g.rows.find(r => r.stub);
    if (stub) { const s = stubs.find(x => x.id === stub.stubId); if (s) return stubSnapshot(s); }
    if (State.S.pdf && g.rows.some(r => r.fp === State.S.fingerprint)) return Project.detailsSnapshot();
    for (const r of g.rows) {
      if (!r.onDevice || typeof Store === 'undefined') continue;
      const rec = await Store.record(r.fp);
      const d = rec && rec.data;
      if (d && (d.project || d.aroSite || d.jobRef)) return { project: d.project ? Object.assign({}, d.project) : null, aroSite: d.aroSite ? Object.assign({}, d.aroSite) : null, jobRef: d.jobRef || '' };
    }
    const r0 = g.rows[0] || {};
    const project = { name: g.named ? g.name : '', status: r0.status || 'active' };
    if (g.folder) project.spFolder = g.folder;
    return { project, aroSite: g.aroNo ? { project: g.aroNo } : null, jobRef: '' };
  }

  /** ＋ on a project: the next drawing — from its SharePoint register or a PDF — joins it as it opens. */
  async function addDrawingDialog(fp) {
    const g = projectOf(fp);
    if (!g) return;
    const snap = await snapshotOf(g);
    const cl = cloudState();
    const spOn = !!(g.folder && typeof Drawings !== 'undefined' && Drawings.available && Drawings.available() && cl && cl.token);
    App.modal(`
      <h3>Add a drawing to ${esc(g.name)}</h3>
      <p class="muted">The sheet takes the project’s details, status and stock list${g.folder ? ' — and its folder' : ''} as it opens.</p>
      <div class="imp-opts">
        ${spOn ? `<button type="button" class="imp-opt" id="ad-sp"><b>Pick from the SharePoint register</b><span>${esc(g.folder.path || g.folder.name)}</span></button>` : ''}
        <button type="button" class="imp-opt" id="ad-pdf"><b>Open a PDF from this device</b><span>Files, Photos or another app — the drawing joins the project as it opens.</span></button>
      </div>
      <div class="modal-actions"><button class="mini-btn" id="ad-cancel">Cancel</button></div>`, (box, close) => {
      box.querySelector('#ad-cancel').onclick = close;
      const sp = box.querySelector('#ad-sp');
      if (sp) sp.onclick = () => { close(); Project.adoptOnNextOpen(snap); Drawings.openDialog({ key: g.folder.id, title: g.name }); renderProjects(); };
      box.querySelector('#ad-pdf').onclick = () => { close(); Project.adoptOnNextOpen(snap); renderProjects(); App.pickPdf(); };
    });
  }

  function sectionHtml(key, list) {
    const open = !!secOpen[key];
    return `<section class="pj-sec ${key}${open ? ' open' : ''}">
      <button type="button" class="pj-sechead" data-sec="${key}" aria-expanded="${open}">
        <span class="pj-dot ${key}"></span><span class="pj-sectitle">${STATUS_LABEL[key]}</span>
        <span class="pj-count">${list.length}</span><span class="pj-caret">${open ? '▾' : '▸'}</span>
      </button>
      ${open ? (list.length ? rowsHtml(list) : '<p class="pj-empty">Nothing in progress — open a drawing and it lands here.</p>') : ''}
    </section>`;
  }

  function paintProjects() {
    const el = $('hsProjList'), who = $('hsProjWho');
    if (!el) return;
    const cl = cloudState();
    const signed = !!(cl && cl.token);
    if (who) {
      who.innerHTML = signed
        ? `Signed in as <b>${esc(cl.name)}</b><button class="mini-btn" id="cl-refresh" title="Re-load the team list">⟳</button><button class="mini-btn" id="cl-out">Sign out</button>`
        : (cl && cl.enabled === true ? '<button type="button" class="pj-link" id="hsProjSignin">Sign in to see the team’s projects</button>' : '');
      const rf = who.querySelector('#cl-refresh'); if (rf) rf.addEventListener('click', () => Cloud.refreshList());
      const out = who.querySelector('#cl-out'); if (out) out.addEventListener('click', () => Cloud.signOut());
      const si = who.querySelector('#hsProjSignin'); if (si) si.addEventListener('click', goSignIn);
    }
    let rows = mergedProjects();
    // a project set up ahead of its drawings is done with once a sheet matches it (name, folder or AroFlo number)
    const drop = new Set();
    for (const g of projectGroups(rows)) if (g.rows.some(r => !r.stub)) for (const r of g.rows) if (r.stub) drop.add(r.stubId);
    if (drop.size) { stubs = stubs.filter(s => !drop.has(s.id)); saveStubs(); rows = rows.filter(r => !(r.stub && drop.has(r.stubId))); }
    const groups = { active: [], dlp: [], done: [] };
    for (const r of rows) groups[r.status].push(r);
    let h = '';
    // a drawing is on its way into a project (＋ on Home): say so until it opens or the user thinks again
    const pend = typeof Project !== 'undefined' && Project.pendingAdoption ? Project.pendingAdoption() : null;
    if (pend) {
      const pf = pend.project && pend.project.spFolder && pend.project.spFolder.id ? pend.project.spFolder : null;
      const pname = (pend.project && pend.project.name) || 'the project';
      h += `<div class="pj-note pj-pending"><b>Adding a drawing to ${esc(pname)}</b> — tap <b>Open PDF…</b> above${pf && signed ? ', or pick one from its SharePoint register' : ''}; it joins the project as it opens.
        <div class="pj-note-actions">${pf && signed ? `<button type="button" class="mini-btn primary" id="hsPendSp" data-key="${esc(pf.id)}" data-title="${esc(pname)}">Pick from SharePoint</button>` : ''}<button type="button" class="mini-btn" id="hsPendCancel">Cancel</button></div></div>`;
    }
    if (signed && cl.error) h += `<div class="cloud-err">${esc(cl.error)}</div>`;
    // the registry is missing an optional column: show the exact SQL, not a pointer to the source
    const missing = [], whys = [];
    if (signed && cl.statusCol === false) { missing.push("alter table am_projects add column if not exists status text not null default 'active';"); whys.push('project statuses stay on each device'); }
    if (signed && cl.fileNameCol === false) { missing.push("alter table am_projects add column if not exists file_name text not null default '';"); whys.push('a project’s sheets aren’t grouped for the team'); }
    if (signed && cl.spFolderCol === false) { missing.push("alter table am_projects add column if not exists sp_folder text not null default '';"); whys.push('a project’s SharePoint drawings folder isn’t shared with the team'); }
    if (missing.length) {
      const why = whys.length === 1 ? whys[0] : whys.slice(0, -1).join(', ') + ' and ' + whys[whys.length - 1];
      h += `<div class="pj-note"><b>The team registry is missing ${missing.length === 1 ? 'a column' : missing.length === 2 ? 'two columns' : 'three columns'}</b> — until ${missing.length === 1 ? 'it’s' : 'they’re'} added, ${why}. Run this in Supabase → SQL editor, just these lines:
        <pre class="pj-sql" id="hsSql">${esc(missing.join('\n'))}</pre>
        <div class="pj-note-actions"><button type="button" class="mini-btn" id="hsSqlCopy">Copy SQL</button><button type="button" class="mini-btn primary" id="hsSqlCheck">Check again</button></div>
        ${cl.colError ? `<div class="pj-note-why">Supabase said: ${esc(cl.colError)}</div>` : ''}</div>`;
    }
    if (!rows.length) {
      h += `<p class="pj-empty">${signed && cl.listPhase === 'loading' ? 'Loading the team list…' : 'No projects yet — tap New project, or open a drawing and it appears here.'}</p>`;
    } else {
      h += sectionHtml('active', groups.active);
      if (groups.dlp.length) h += sectionHtml('dlp', groups.dlp);
      if (groups.done.length) h += sectionHtml('done', groups.done);
    }
    el.innerHTML = h;
    const copyBtn = el.querySelector('#hsSqlCopy');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const pre = el.querySelector('#hsSql');
      try {
        await navigator.clipboard.writeText(pre.textContent);
        App.toast('SQL copied — paste it into Supabase → SQL editor and run it.', 'ok', 4000);
      } catch (e) {
        const r = document.createRange(); r.selectNodeContents(pre);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        App.toast('The SQL is selected — copy it.', 'info', 3000);
      }
    });
    const chk = el.querySelector('#hsSqlCheck');
    if (chk) chk.addEventListener('click', async () => {
      chk.disabled = true; chk.textContent = 'Checking…';
      const okAll = await Cloud.refreshList({ recheck: true });
      App.toast(okAll
        ? 'The registry has every column it needs ✔'
        : 'Still missing. Make sure the SQL ran without an error, in the Supabase project this deployment uses (Vercel → SUPABASE_URL).', okAll ? 'good' : 'warn', 8000);
    });
    el.querySelectorAll('.pj-sechead').forEach(b => b.addEventListener('click', () => {
      secOpen[b.dataset.sec] = !secOpen[b.dataset.sec];
      try { localStorage.setItem('abmt:pjsec', JSON.stringify(secOpen)); } catch (e) { /* ignore */ }
      paintProjects();
    }));
    el.querySelectorAll('.pj-draw').forEach(b => b.addEventListener('click', () => {
      if (typeof Drawings !== 'undefined') Drawings.openDialog({ key: b.dataset.key, title: b.dataset.title });
    }));
    el.querySelectorAll('.pj-add, .pj-addfirst').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); addDrawingDialog(b.dataset.fp); }));
    const pendSp = el.querySelector('#hsPendSp');
    if (pendSp) pendSp.addEventListener('click', () => Drawings.openDialog({ key: pendSp.dataset.key, title: pendSp.dataset.title }));
    const pendCancel = el.querySelector('#hsPendCancel');
    if (pendCancel) pendCancel.addEventListener('click', () => { Project.cancelPendingAdoption(); renderProjects(); });
    const nb = $('hsNewProj');
    if (nb) nb.onclick = () => App.newProjectDialog();
    // the Site drawings card's project picker follows the projects (a project set up with a folder is in it at once)
    if (typeof Drawings !== 'undefined' && Drawings.projectsChanged) Drawings.projectsChanged();
    el.querySelectorAll('.pj-main').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openProject(b.dataset.fp, b.dataset.id); }));
    el.querySelectorAll('.pj-more').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); projectMenu(b.dataset.fp); }));
    el.querySelectorAll('.pj-sel').forEach(s => {
      s.addEventListener('click', e => e.stopPropagation());
      s.addEventListener('change', e => { e.stopPropagation(); changeStatus(s.dataset.fp, s.dataset.id, s.value); });
    });
  }

  function openProject(fp, id) {
    closeMenu();
    if (State.S.pdf && State.S.fingerprint === fp) { setMode('editor'); return; }
    if (localRows.some(r => r.fingerprint === fp)) { Project.openFromStore(fp); return; }
    if (id && typeof Cloud !== 'undefined') { Cloud.openCloud(id); return; }
    App.toast('That project isn’t on this device — open its PDF or .airmark file.', 'warn', 6000);
  }

  // Status changes from the list: the open drawing changes in place (autosave
  // and cloud sync carry it); a stored drawing is patched in the device store;
  // a team project is updated in the registry without touching its drawing.
  async function changeStatus(fp, id, status) {
    status = Project.normStatus(status);
    if (String(fp).startsWith('stub:')) {
      const s = stubs.find(x => 'stub:' + x.id === fp);
      if (s) { s.project = Object.assign({}, s.project || {}, { status }); saveStubs(); App.toast(`${s.project.name || 'Project'} → ${STATUS_SHORT[status]}`, 'ok', 2500); renderProjects(); }
      return;
    }
    const row = mergedProjects().find(r => r.fp === fp) || {};
    const cl = cloudState();
    try {
      if (State.S.pdf && State.S.fingerprint === fp) {
        Project.setStatus(status);
      } else {
        const rec = typeof Store !== 'undefined' ? await Store.record(fp) : null;
        if (rec && rec.data) {
          rec.data.project = Object.assign({}, rec.data.project || {}, { status });
          await Store.saveProject(fp, rec.name, rec.data);
        }
        if (id && cl && cl.token) await Cloud.setStatus(id, status);
      }
      App.toast(`${row.name || 'Project'} → ${STATUS_SHORT[status]}`, 'ok', 2500);
    } catch (e) {
      App.toast('Couldn’t change the status: ' + e.message, 'error', 7000);
    }
    renderProjects();
  }

  // Store.list() is async — paint what we have now, repaint only if the
  // device store says something different
  function renderProjects() {
    paintProjects();
    if (typeof Store === 'undefined') return;
    const seq = ++localSeq;
    Store.list().then(rows => {
      if (seq !== localSeq) return;
      const sig = JSON.stringify(rows);
      if (sig === localSig) return;
      localSig = sig; localRows = rows;
      paintProjects();
    }).catch(() => {});
  }

  /* ---------------- version + update check ---------------- */

  const version = () => (typeof APP_VERSION !== 'undefined' ? APP_VERSION : '');
  let checkedAt = 0;

  /** Fetch the live version.js past the shell cache; offer a reload when it is newer. */
  async function checkForUpdate(force) {
    const btn = $('hsUpdate');
    if (!btn || !version()) return;
    if (!force && (navigator.onLine === false || Date.now() - checkedAt < 60000)) return;
    checkedAt = Date.now();
    try {
      const r = await fetch('js/version.js?live=1', { cache: 'no-store' });
      if (!r.ok) return;
      const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(await r.text());
      const live = m && m[1];
      const newer = !!(live && live !== version());
      btn.hidden = !newer;
      if (newer) btn.textContent = 'v' + live + ' is out — tap to update';
    } catch (e) { /* offline or blocked — nothing to say */ }
  }

  /** Reload with the shell cache emptied, so the new build arrives in one go. */
  async function applyUpdate() {
    const btn = $('hsUpdate');
    if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
    try {
      if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); }
    } catch (e) { /* the reload still fetches index.html network-first */ }
    location.reload();
  }

  /* ---------------- render ---------------- */

  function refresh() {
    if (!$('homeShell')) return;
    const cl = cloudState();
    const u = whoAmI();
    $('hsVer').textContent = version() ? 'v' + version() : '';
    if (mode === 'home') checkForUpdate();
    $('hsAvatar').textContent = u.known ? initials(u.name) : '?';
    $('hsUserName').textContent = u.name;
    $('hsUserSub').textContent = u.sub;
    $('hsSignout').hidden = !u.signed;
    // Drawings: the project's sheets — the SharePoint register on deployments
    // that have one, and the drawings panel whenever a sheet is open
    const spAvail = typeof Drawings !== 'undefined' && cl && cl.enabled === true && cl.sp;
    $('hsDrawingsNav').hidden = !(spAvail || State.S.pdf);
    try {
      $('hsDate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    } catch (e) { $('hsDate').textContent = ''; }

    const hasDoc = !!State.S.pdf;
    $('hsDrawing').hidden = !hasDoc;
    $('hsProjectNav').hidden = !hasDoc;
    $('hsContinue').hidden = !hasDoc;
    if (hasDoc) {
      const d = Project.details();
      $('hsContName').textContent = Project.displayName();
      $('hsContName').title = State.S.fileName || '';
      const bits = [];
      if (d.site) bits.push(d.site);
      if (d.client) bits.push(d.client);
      if (State.S.pageCount > 1) bits.push(State.S.pageCount + ' pages');
      const n = State.S.markups.length;
      bits.push(n ? n + ' markup' + (n === 1 ? '' : 's') : 'no markups yet');
      const proj = State.S.aroSite && State.S.aroSite.project;
      if (proj) bits.push('AroFlo project ' + proj);
      const holder = State.S.aroSite && State.S.aroSite.holder;
      if (holder) bits.push('Stock: ' + holder);
      const nrev = (State.S.revisions || []).length;
      if (nrev) bits.push(nrev + ' earlier revision' + (nrev === 1 ? '' : 's'));
      $('hsContSub').textContent = bits.join(' · ');
      const stNow = Project.status();
      $('hsContStatus').textContent = stNow === 'active' ? '' : ' · ' + STATUS_SHORT[stNow];
    }
    const active = mode === 'editor' ? 'drawing' : 'home';
    document.querySelectorAll('#homeSide .hs-item[data-nav]').forEach(b =>
      b.classList.toggle('active', b.dataset.nav === active));
    renderProjects();
  }

  /* ---------------- navigation ---------------- */

  function focusSignIn() {
    const el = $('cl-name');
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
    el.focus();
  }

  // the sign-in card lives on the Home page — get there first if needed
  function goSignIn() {
    if (mode !== 'home') setMode('home');
    setTimeout(focusSignIn, 60);
  }

  function openDrawings() {
    // with a sheet open, Drawings is the side panel beside it
    if (mode === 'editor' && State.S.pdf && typeof Drawings !== 'undefined' && Drawings.openPanel) { Drawings.openPanel(); return; }
    const cl = cloudState();
    const ready = typeof Drawings !== 'undefined' && cl && cl.enabled === true && cl.sp;
    if (ready && cl.token) { Drawings.openDialog(); return; }
    if (ready) {
      App.toast('Sign in to the team cloud first — the project’s SharePoint drawing register then loads by itself.', 'warn', 6000);
      goSignIn();
      return;
    }
    App.toast('The SharePoint drawing register isn’t set up on this deployment yet (see “Site drawings from SharePoint” in the README). PDFs on this device still open from Home.', 'warn', 8000);
  }

  function accountTap() {
    const u = whoAmI();
    if (u.signed) {
      App.modal(`<h3>Account</h3>
        <p class="muted">Signed in to the team cloud as <b>${esc(u.name)}</b>. Markups you place are stamped with this name, and the drawings you open sync to the team list.</p>
        <div class="modal-actions">
          <button class="mini-btn" id="hs-out">Sign out</button>
          <button class="mini-btn primary" id="hs-ok">Done</button>
        </div>`, (box, close) => {
        box.querySelector('#hs-ok').onclick = close;
        box.querySelector('#hs-out').onclick = () => { close(); Cloud.signOut(); refresh(); };
      });
      return;
    }
    const cl = cloudState();
    if (cl && cl.enabled === true) { goSignIn(); return; }   // team cloud available
    App.authorDialog();                                       // otherwise the plain author name
  }

  const NAV = {
    home: () => setMode('home'),
    drawing: () => { if (State.S.pdf) setMode('editor'); },
    project: () => App.projectDialog(),
    drawings: openDrawings,
    stock: () => Aro.openPage(),
    deliveries: () => Aro.deliveriesDialog(),
    settings: () => Aro.settingsDialog(),
    help: () => App.helpDialog(),
    signout: () => { Cloud.signOut(); refresh(); },
  };

  /* ---------------- drag & drop onto the home page ---------------- */

  function wireDrop() {
    const shell = $('homeShell');
    let depth = 0;
    shell.addEventListener('dragenter', e => { e.preventDefault(); depth++; shell.classList.add('dragging'); });
    shell.addEventListener('dragover', e => e.preventDefault());
    shell.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; shell.classList.remove('dragging'); } });
    shell.addEventListener('drop', e => {
      e.preventDefault();
      depth = 0;
      shell.classList.remove('dragging');
      if (e.dataTransfer && e.dataTransfer.files.length) App.handleFiles(e.dataTransfer.files);
    });
  }

  /* ---------------- boot ---------------- */

  function init() {
    const shell = $('homeShell');
    if (!shell) return;
    document.querySelectorAll('#homeSide .hs-item[data-nav]').forEach(b =>
      b.addEventListener('click', () => { closeMenu(); const fn = NAV[b.dataset.nav]; if (fn) fn(); }));
    $('hsUser').addEventListener('click', () => { closeMenu(); accountTap(); });
    $('hsContBtn').addEventListener('click', () => setMode('editor'));
    $('hsContDetails').addEventListener('click', () => App.projectDialog());
    $('hsUpdate').addEventListener('click', applyUpdate);
    window.addEventListener('online', () => { if (mode === 'home') checkForUpdate(true); });
    // editor: ≡ opens the sidebar as a drawer, the logo jumps straight Home
    const menuBtn = $('btnMenu');
    if (menuBtn) menuBtn.addEventListener('click', toggleMenu);
    const brand = document.querySelector('#toolbar .brand');
    if (brand) brand.addEventListener('click', () => setMode('home'));
    // tapping the dimmed drawing (the shell's own background) closes the drawer
    shell.addEventListener('click', e => { if (e.target === shell && menuOpen()) closeMenu(); });
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && menuOpen()) { e.preventDefault(); closeMenu(); } });
    wireDrop();

    // a drawing opening (file, sample, recents, team cloud, SharePoint,
    // ?proj= deep link) always lands in the editor
    State.on('doc', () => { if (State.S.pdf) setMode('editor'); else refresh(); });
    State.on('project', () => refresh());
    State.on('autosave', () => { if (mode === 'home' || menuOpen()) refresh(); });
    setMode(State.S.pdf ? 'editor' : 'home');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { setMode, refresh, renderProjects, projectRows: mergedProjects, projectGroups: () => projectGroups(mergedProjects()), projectOf, openProject, projectMenu,
    createProject, addDrawingDialog, removeStub, stubFor, openMenu, closeMenu, toggleMenu, checkForUpdate, mode: () => mode };
})();
