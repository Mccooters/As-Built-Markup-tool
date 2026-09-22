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
      byFp.set(r.fingerprint, { fp: r.fingerprint, name: r.name, pname: r.pname || '', fileName: r.fileName || '', status: r.status, site: r.site, client: r.client, aroNo: r.aroNo, savedAt: r.savedAt, onDevice: true });
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
      row.site = d.site || ''; row.client = d.client || '';
      row.aroNo = (State.S.aroSite && State.S.aroSite.project) || row.aroNo || '';
      byFp.set(State.S.fingerprint, row);
    }
    const rows = [...byFp.values()];
    for (const r of rows) {
      r.status = Project.normStatus(r.status);
      r.when = Math.max(r.savedAt || 0, Date.parse(r.updatedAt || '') || 0);
    }
    rows.sort((a, b) => (b.open ? 1 : 0) - (a.open ? 1 : 0) || b.when - a.when);
    return rows;
  }

  // drawings that share a project name sit together under one heading
  function rowsHtml(list) {
    const key = r => (r.pname || '').trim().toLowerCase();
    const byP = new Map();
    for (const r of list) { const k = key(r); if (!byP.has(k)) byP.set(k, []); byP.get(k).push(r); }
    const done = new Set();
    let h = '';
    for (const r of list) {
      const k = key(r);
      const grp = byP.get(k);
      if (k && grp.length > 1) {
        if (done.has(k)) continue;
        done.add(k);
        h += `<div class="pj-projhead"><span class="pj-projname">${esc(r.pname)}</span><span class="pj-count">${grp.length} drawings</span></div>`;
        h += grp.map(x => rowHtml(x, true)).join('');
      } else h += rowHtml(r, false);
    }
    return h;
  }

  function rowHtml(r, inProject) {
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
    </div>`;
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
    const rows = mergedProjects();
    const groups = { active: [], dlp: [], done: [] };
    for (const r of rows) groups[r.status].push(r);
    let h = '';
    if (signed && cl.error) h += `<div class="cloud-err">${esc(cl.error)}</div>`;
    // the registry is missing an optional column: show the exact SQL, not a pointer to the source
    const missing = [];
    if (signed && cl.statusCol === false) missing.push("alter table am_projects add column if not exists status text not null default 'active';");
    if (signed && cl.fileNameCol === false) missing.push("alter table am_projects add column if not exists file_name text not null default '';");
    if (missing.length) {
      const why = cl.statusCol === false && cl.fileNameCol === false ? 'project statuses stay on each device and a project’s sheets aren’t grouped for the team'
        : cl.statusCol === false ? 'project statuses stay on each device' : 'a project’s sheets aren’t grouped for the team';
      h += `<div class="pj-note"><b>The team registry is missing ${missing.length === 1 ? 'a column' : 'two columns'}</b> — until it’s added, ${why}. Run this in Supabase → SQL editor, just these lines:
        <pre class="pj-sql" id="hsSql">${esc(missing.join('\n'))}</pre>
        <div class="pj-note-actions"><button type="button" class="mini-btn" id="hsSqlCopy">Copy SQL</button><button type="button" class="mini-btn primary" id="hsSqlCheck">Check again</button></div>
        ${cl.colError ? `<div class="pj-note-why">Supabase said: ${esc(cl.colError)}</div>` : ''}</div>`;
    }
    if (!rows.length) {
      h += `<p class="pj-empty">${signed && cl.listPhase === 'loading' ? 'Loading the team list…' : 'No projects yet — open a drawing and it appears here.'}</p>`;
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
    el.querySelectorAll('.pj-main').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openProject(b.dataset.fp, b.dataset.id); }));
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
    // the Drawings item only exists on deployments with a SharePoint register
    $('hsDrawingsNav').hidden = !(typeof Drawings !== 'undefined' && cl && cl.enabled === true && cl.sp);
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

  return { setMode, refresh, renderProjects, openMenu, closeMenu, toggleMenu, checkForUpdate, mode: () => mode };
})();
