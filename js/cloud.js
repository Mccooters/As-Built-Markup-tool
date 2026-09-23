/* ============ cloud.js — team sign-in + shared cloud projects ============
 *
 * Phase 1 of multi-user AirMark. Talks to api/cloud.js: name + PIN sign-in,
 * a shared project list, and per-drawing sync — markup JSON and the PDF go
 * to cloud storage via short-lived signed URLs (bytes never pass through the
 * serverless function). The device stays offline-first: everything still
 * lands in IndexedDB exactly as before, and the cloud is a sync target that
 * catches up whenever there's signal. Opening a cloud project = download
 * into the device store, then the normal offline reopen path.
 */
'use strict';

const Cloud = (() => {

  const KEY = 'abmt:cloud';        // {token, name}
  const MAP_KEY = 'abmt:cloudmap'; // fingerprint → {id, version} known to this device
  const GONE_KEY = 'abmt:cloudgone'; // fingerprints deleted from the team cloud while this device held a copy
  const API = '/api/cloud';

  const st = {
    enabled: null,        // null = probing, false = not configured, true = live
    sp: false,            // SharePoint drawings register configured server-side?
    token: '', name: '',
    projects: [], listPhase: 'idle', error: '',
    listAt: 0,            // when the team list last loaded
    statusCol: null,      // server has the status column? false → statuses stay per device
    fileNameCol: null,    // …and the file_name column? false → a project's sheets aren't grouped for the team
    spFolderCol: null,    // …and sp_folder? false → a project's SharePoint folder link stays on the device that set it
    colError: '',         // Supabase's own words when a column is missing
    sync: { state: 'idle', at: 0, msg: '' }, // idle|saving|synced|offline|error|conflict
    conflictWith: null,   // registry row that beat us, while unresolved
  };
  let map = {};
  let gone = new Set();
  let chipEl = null;
  let debTimer = 0;
  let pushing = false, pendingPush = false;

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const loadJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
  const saveJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full */ } };
  const ageOf = iso => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const mins = Math.round((Date.now() - t) / 60000);
    return mins < 1 ? 'just now' : mins < 60 ? mins + ' min ago' : mins < 1440 ? Math.round(mins / 60) + ' h ago' : Math.round(mins / 1440) + ' d ago';
  };

  async function call(action, body, qs) {
    const headers = {};
    if (st.token) headers['X-AirMark-Auth'] = st.token;
    const url = API + '?action=' + action + (qs ? '&' + qs : '');
    let resp;
    try {
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      } else {
        resp = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      }
    } catch (e) { const err = new Error('No connection to the team cloud.'); err.offline = true; throw err; }
    let j;
    try { j = await resp.json(); } catch (e) { throw new Error('Unexpected cloud response (HTTP ' + resp.status + ').'); }
    if (j.badAuth) { signOut(true); throw new Error(j.statusmessage); }
    if (!j.ok) { const e = new Error(j.statusmessage || 'Cloud error'); e.notConfigured = j.notConfigured; throw e; }
    return j;
  }

  /* ---------------- sign in / out ---------------- */

  async function signIn(name, pin) {
    const r = await call('login', { name, pin });
    st.token = r.token; st.name = r.name;
    saveJson(KEY, { token: r.token, name: r.name });
    // markups made while signed in carry the crew name
    State.S.author = r.name;
    try { localStorage.setItem('abmt:author', r.name); } catch (e) { /* ignore */ }
    renderCard();
    refreshList();
    fetchTeamCfg();
    if (typeof Drawings !== 'undefined') Drawings.onCloudState();
    if (typeof Home !== 'undefined') Home.refresh();
    return r.name;
  }

  // Signed-in devices set up their AroFlo connection by themselves — the
  // proxy token and the team's sync scope come down with the session, so a
  // tech's fresh phone needs nothing typed.
  async function fetchTeamCfg() {
    if (!st.token || st.enabled !== true) return;
    try {
      const r = await call('teamcfg');
      if (typeof Aro !== 'undefined' && Aro.adoptTeamConfig) Aro.adoptTeamConfig(r);
    } catch (e) { /* best-effort — settings stay manual */ }
  }

  async function setTeamScope(cats) {
    const r = await call('teamscope', { cats: cats || [] });
    return r.cats;
  }

  function signOut(silent) {
    st.token = ''; st.name = ''; st.projects = [];
    saveJson(KEY, {});
    renderCard();
    chipSet('idle');
    if (typeof Drawings !== 'undefined') Drawings.onCloudState();
    if (typeof Home !== 'undefined') Home.refresh();
    if (!silent) App.toast('Signed out of the team cloud.', 'info');
  }

  /* ---------------- project list + open ---------------- */

  /** Reload the team list. `{recheck: true}` makes the server re-probe the optional columns now. Resolves true when the registry has every column. */
  async function refreshList(opts) {
    if (!st.token || st.enabled === false) return false;
    st.listPhase = 'loading'; st.error = '';
    renderCard();
    if (typeof Home !== 'undefined') Home.refresh();
    try {
      const r = await call('list', undefined, opts && opts.recheck ? 'recheck=1' : '');
      st.projects = r.projects || [];
      if (r.statusColumn === false || r.statusColumn === true) st.statusCol = r.statusColumn;
      if (r.fileNameColumn === false || r.fileNameColumn === true) st.fileNameCol = r.fileNameColumn;
      if (r.spFolderColumn === false || r.spFolderColumn === true) st.spFolderCol = r.spFolderColumn;
      st.colError = r.columnError || '';
      st.listAt = Date.now();
      st.listPhase = 'ready';
      adoptListStatus();
    } catch (e) {
      st.listPhase = 'ready';
      st.error = e.offline ? 'Offline — the team list needs signal. Projects already on this device still open below.' : e.message;
    }
    renderCard();
    if (typeof Home !== 'undefined') Home.refresh();
    return st.statusCol !== false && st.fileNameCol !== false && st.spFolderCol !== false;
  }

  // Home asks for a fresh list when it comes back into view — at most once a minute.
  function refreshListIfStale() {
    if (!st.token || st.enabled !== true || st.listPhase === 'loading') return;
    if (Date.now() - st.listAt > 60000) refreshList();
  }

  // The registry's status is the team's shared truth. When the list shows a
  // status for the OPEN drawing that differs from what this device last saw
  // in the registry, a teammate changed it — take it on. A change made here
  // and not yet pushed is left alone (the registry still matches the map).
  function adoptListStatus() {
    const fp = State.S.fingerprint;
    if (!fp || !State.S.pdf) return;
    const p = st.projects.find(x => x.fingerprint === fp);
    const known = map[fp];
    if (!p || !known || !p.status || p.status === known.status) return;
    known.status = p.status;
    saveJson(MAP_KEY, map);
    if (Project.status() !== p.status) Project.setStatus(p.status);
  }

  // Keep the in-memory team list current after a save or a status change,
  // so Home regroups without a round trip.
  function upsertRow(p) {
    if (!p || !p.id) return;
    const i = st.projects.findIndex(x => x.id === p.id);
    if (i >= 0) st.projects[i] = p; else st.projects.unshift(p);
    if (typeof Home !== 'undefined') Home.refresh();
  }

  // Delete a project for the whole team (registry row + files). The caller
  // clears the device copy; other devices learn on their next save.
  async function deleteProject(id) {
    const r = await call('delete', { id });
    st.projects = st.projects.filter(p => p.id !== id);
    for (const fp of Object.keys(map)) if (map[fp].id === id) delete map[fp];
    saveJson(MAP_KEY, map);
    if (typeof Home !== 'undefined') Home.refresh();
    return r;
  }

  // A project removed from this device: nothing here refers to it any more.
  function forget(fp) {
    if (!fp) return;
    delete map[fp]; saveJson(MAP_KEY, map);
    if (gone.delete(fp)) saveGone();
    if (State.S.fingerprint === fp) chipSet('idle');
  }

  // Move a team project between In progress / DLP / Completed from the list.
  async function setStatus(id, status) {
    const r = await call('setstatus', { id, status });
    const fp = r.project && r.project.fingerprint;
    if (fp && map[fp]) { map[fp].status = r.project.status; saveJson(MAP_KEY, map); }
    upsertRow(r.project);
    return r.project;
  }

  // Download a cloud project into the device store, then open it through the
  // normal offline path — after this, it reopens with no signal like any
  // local project.
  async function openCloud(id) {
    const note = App.toast('Loading from the team cloud…', 'info', 0);
    try {
      const r = await call('open', { id });
      const dResp = await fetch(r.dataUrl, { signal: AbortSignal.timeout(60000) });
      if (!dResp.ok) throw new Error('data download failed (HTTP ' + dResp.status + ')');
      const data = await dResp.json();
      const fp = r.project.fingerprint || data.fingerprint;
      if (!fp) throw new Error('project has no drawing fingerprint');
      // the registry's status wins over what the saved JSON carried — a list
      // change never re-uploads the drawing
      if (r.project.status && data && typeof data === 'object') {
        data.project = Object.assign({}, data.project || {}, { status: r.project.status });
      }
      const have = await Store.get(fp);
      if (!(have && have.pdf)) {
        if (!r.pdfUrl) throw new Error('the drawing PDF is not in the cloud yet — open it from its file once on the device that has it');
        const pResp = await fetch(r.pdfUrl, { signal: AbortSignal.timeout(300000) });
        if (!pResp.ok) throw new Error('PDF download failed (HTTP ' + pResp.status + ')');
        await Store.savePdf(fp, new Uint8Array(await pResp.arrayBuffer()));
      }
      await Store.saveProject(fp, r.project.name || data.fileName || 'Drawing', data);
      map[fp] = { id: r.project.id, version: r.project.version, status: r.project.status || 'active' };
      saveJson(MAP_KEY, map);
      st.conflictWith = null;
      await Project.openFromStore(fp);
      chipSet('synced');
    } catch (e) {
      App.toast('Couldn’t open from the cloud: ' + e.message, 'error', 9000);
    } finally {
      note.remove();
    }
  }

  /* ---------------- sync on autosave ---------------- */

  function schedulePush() {
    if (!st.token || !State.S.fingerprint || st.enabled === false) return;
    clearTimeout(debTimer);
    debTimer = setTimeout(() => push(), window.__cloudDebounce || 8000);
  }

  function conflictPrompt(project, superseded) {
    st.conflictWith = project || st.conflictWith;
    if (superseded !== undefined) st.superseded = !!superseded;
    const p = st.conflictWith;
    if (!p) return;
    if (st.superseded) {
      // someone imported a newer revision of this drawing: this copy is the old sheet
      App.toast(
        `${p.updatedBy || 'Someone'} moved this drawing onto a newer revision (${ageOf(p.updatedAt) || 'recently'}). Load it to keep working on the current sheet, or keep this copy as its own project.`,
        'warn', 0,
        [
          { label: 'Load newest revision', run: () => openCloud(p.id) },
          { label: 'Keep mine as its own project', run: () => { st.conflictWith = null; st.superseded = false; delete map[State.S.fingerprint]; saveJson(MAP_KEY, map); push({ force: true }); } },
        ]);
      return;
    }
    App.toast(
      `${p.updatedBy || 'Someone'} saved a newer version of this drawing (${ageOf(p.updatedAt) || 'recently'}). Loading theirs replaces what's on this screen.`,
      'warn', 0,
      [
        { label: 'Load newest', run: () => openCloud(p.id) },
        { label: 'Keep mine — overwrite', run: () => { st.conflictWith = null; push({ force: true }); } },
      ]);
  }

  // A new revision replaced the drawing: the project keeps its registry row,
  // and the next save tells the server which fingerprint it moved from.
  function rekey(oldFp, newFp) {
    if (!oldFp || !newFp || oldFp === newFp) return;
    const known = map[oldFp];
    if (known) {
      map[newFp] = { ...known, prevFp: known.prevFp || oldFp };
      delete map[oldFp];
      saveJson(MAP_KEY, map);
    }
    st.conflictWith = null; st.superseded = false;
    chipSet('idle');
    schedulePush();
  }

  // An earlier revision's PDF, from the team cloud into the device store.
  async function fetchRevision(fp) {
    const known = map[State.S.fingerprint];
    if (!st.token || !known) throw new Error('not signed in, or this drawing isn’t in the team cloud yet');
    const r = await call('revurl', { id: known.id, fp });
    const resp = await fetch(r.url, { signal: AbortSignal.timeout(300000) });
    if (!resp.ok) throw new Error('that revision hasn’t been uploaded from the device that has it (HTTP ' + resp.status + ')');
    const bytes = new Uint8Array(await resp.arrayBuffer());
    await Store.savePdf(fp, bytes);
    return bytes;
  }

  // The team deleted this drawing while the device still held it: it stays
  // here, device-only, until someone chooses to share it again.
  const saveGone = () => saveJson(GONE_KEY, [...gone]);
  function goneNow(fp) {
    gone.add(fp); saveGone();
    delete map[fp]; saveJson(MAP_KEY, map);
    st.projects = st.projects.filter(p => p.fingerprint !== fp);
    chipSet('gone');
    App.toast('This drawing was deleted from the team cloud by someone on the team. It stays on this device only.', 'warn', 0, [
      { label: 'Share it again', run: () => shareAgain(fp) },
      { label: 'OK', run: () => {} },
    ]);
    if (typeof Home !== 'undefined') Home.refresh();
  }
  function shareAgain(fp) {
    gone.delete(fp); saveGone();
    if (State.S.fingerprint === fp) push({ force: true });
  }

  // Everything a push sends is captured before the first await: another
  // drawing can open while the upload is in flight, and the old row must
  // never receive the new sheet's data.
  let inflight = Promise.resolve();
  function push(opts = {}) {
    const p = doPush(opts);
    inflight = p.catch(() => {});
    return p;
  }
  /** Wait for the push in flight (a revision import needs the map settled before it re-keys). */
  async function settle() {
    for (let i = 0; i < 5 && (pushing || pendingPush); i++) await inflight;
  }

  async function doPush(opts = {}) {
    if (!st.token || !State.S.pdf || !State.S.fingerprint || st.enabled === false) return;
    if (pushing) { pendingPush = true; return; }
    if (st.conflictWith && !opts.force) { chipSet('conflict'); return; }
    if (gone.has(State.S.fingerprint) && !opts.force) { chipSet('gone'); return; }
    pushing = true;
    chipSet('saving');
    try {
      const fp = State.S.fingerprint;
      const known = map[fp];
      const name = String((State.S.project && State.S.project.name) || State.S.jobRef || State.S.fileName || 'Drawing').trim().replace(/\.pdf$/i, '');
      const aroNo = String((State.S.aroSite && State.S.aroSite.project) || '');
      // status rides along only when this device changed it — a stale copy
      // must never undo a list change made elsewhere
      const status = Project.status();
      const sendStatus = !known || known.status !== status;
      // earlier revisions this device holds that the cloud hasn't been sent yet
      const sentRevs = (known && known.revs) || [];
      const revFps = (State.S.revisions || []).map(r => r.fp).filter(f => f && !sentRevs.includes(f));
      const fileName = String(State.S.fileName || '').slice(0, 200);
      const spFolder = Project.spFolder ? (Project.spFolder() || '') : '';   // the project's SharePoint folder, mirrored into the list
      const body = JSON.stringify(Project.serialize(false));
      const pdfBytes = State.S.pdfBytes;
      const prep = await call('prepare', {
        fingerprint: fp, name, aroNo, fileName, spFolder,
        version: known ? known.version : 0,
        force: !!opts.force,
        status: sendStatus ? status : undefined,
        id: known ? known.id : undefined,
        prevFingerprint: known && known.prevFp ? known.prevFp : undefined,
        revFingerprints: revFps.length ? revFps : undefined,
      });
      if (prep.gone) { goneNow(fp); return; }
      if (prep.conflict) { conflictPrompt(prep.project, !!prep.superseded); chipSet('conflict'); return; }

      let up = await fetch(prep.uploadData, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(120000) });
      if (!up.ok) throw new Error('markup upload failed (HTTP ' + up.status + ')');

      let pdfUploaded = false, pdfSize = 0;
      if (prep.needPdf && prep.uploadPdf && pdfBytes) {
        up = await fetch(prep.uploadPdf, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: pdfBytes, signal: AbortSignal.timeout(600000) });
        if (up.ok) { pdfUploaded = true; pdfSize = pdfBytes.length; }
      }

      const com = await call('commit', { id: prep.id, version: prep.nextVersion, name, aroNo, fileName, spFolder, pdfUploaded, pdfSize, pdfPath: prep.pdfPath || '', status: sendStatus ? status : undefined });
      if (com.conflict) { conflictPrompt(com.project, false); chipSet('conflict'); return; }
      map[fp] = { id: prep.id, version: prep.nextVersion, status: sendStatus ? status : known.status, revs: sentRevs.slice() };
      saveJson(MAP_KEY, map);
      st.conflictWith = null; st.superseded = false;
      chipSet('synced');
      if (com.project) upsertRow(com.project);
      // earlier revisions go up after the save (best-effort — a miss retries next save)
      for (const [rf, url] of Object.entries(prep.uploadRevs || {})) {
        try {
          const bytes = await Store.getPdf(rf);
          if (!bytes) continue;
          const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: bytes, signal: AbortSignal.timeout(600000) });
          if (r.ok || r.status === 409) { map[fp].revs.push(rf); saveJson(MAP_KEY, map); }
        } catch (e) { /* next save tries again */ }
      }
    } catch (e) {
      chipSet(e.offline || navigator.onLine === false ? 'offline' : 'error', e.message);
    } finally {
      pushing = false;
      if (pendingPush) { pendingPush = false; schedulePush(); }
    }
  }

  /* ---------------- UI: sign-in card + sync chip ---------------- */

  function renderCard() {
    const el = document.getElementById('cloudCard');
    if (!el) return;
    if (st.enabled !== true) { el.innerHTML = ''; return; }
    if (!st.token) {
      el.innerHTML = `
        <div class="cloud-card">
          <div class="recent-cap">Team cloud</div>
          <div class="cloud-row">
            <input type="text" id="cl-name" placeholder="Name" autocomplete="username" autocapitalize="words">
            <input type="password" id="cl-pin" placeholder="PIN" inputmode="numeric" autocomplete="current-password">
            <button class="mini-btn primary" id="cl-login">Sign in</button>
          </div>
          <div class="cloud-err" id="cl-err"></div>
        </div>`;
      const nameEl = el.querySelector('#cl-name'), pinEl = el.querySelector('#cl-pin');
      const go = async () => {
        const errEl = el.querySelector('#cl-err');
        errEl.textContent = 'Signing in…';
        try {
          const who = await signIn(nameEl.value, pinEl.value);
          App.toast('Signed in as ' + who + ' — markups are now made in your name.', 'good');
        } catch (e) { errEl.textContent = e.message; }
      };
      el.querySelector('#cl-login').addEventListener('click', go);
      pinEl.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      return;
    }
    // signed in: the team's projects are merged into Home's Projects card
    el.innerHTML = '';
  }

  const CHIP_TEXT = {
    saving: '☁ saving…',
    synced: '☁ synced',
    offline: '☁ offline — will sync',
    error: '☁ sync failed — tap',
    conflict: '☁ newer version exists — tap',
    gone: '☁ deleted from team — device only',
  };

  function chipSet(state, msg) {
    st.sync = { state, at: Date.now(), msg: msg || '' };
    if (!chipEl) return;
    if (state === 'idle' || !st.token || !State.S.pdf) { chipEl.hidden = true; return; }
    chipEl.hidden = false;
    chipEl.className = 'cloud-chip ' + state;
    chipEl.textContent = CHIP_TEXT[state] || state;
    if (state === 'synced') chipEl.title = 'Saved to the team cloud as ' + st.name + ' at ' + new Date().toLocaleTimeString();
    else chipEl.title = msg || '';
  }

  function chipTap() {
    const s = st.sync;
    if (s.state === 'conflict') { conflictPrompt(null); return; }
    if (s.state === 'gone') {
      App.toast('Deleted from the team cloud — this copy lives on this device only.', 'info', 0, [
        { label: 'Share it again', run: () => shareAgain(State.S.fingerprint) },
        { label: 'OK', run: () => {} },
      ]);
      return;
    }
    if (s.state === 'error') { App.toast('Cloud sync failed: ' + (s.msg || 'unknown error') + ' — retrying on the next change.', 'warn', 7000); push(); return; }
    if (s.state === 'offline') { App.toast('No signal — markups are safe on this device and sync when you’re back online.', 'info', 6000); push(); return; }
    if (s.state === 'synced') App.toast('This drawing is synced to the team cloud (as ' + st.name + ').', 'ok', 4000);
  }

  /* ---------------- boot ---------------- */

  async function init() {
    const saved = loadJson(KEY, {});
    st.token = saved.token || ''; st.name = saved.name || '';
    map = loadJson(MAP_KEY, {});
    gone = new Set(loadJson(GONE_KEY, []));

    chipEl = document.createElement('button');
    chipEl.id = 'cloudChip';
    chipEl.className = 'cloud-chip';
    chipEl.hidden = true;
    chipEl.addEventListener('click', chipTap);
    document.body.appendChild(chipEl);

    State.on('autosave', schedulePush);
    // a flushed autosave (the drawing is about to change) goes up now, not after the debounce
    State.on('flush', () => { clearTimeout(debTimer); push(); });
    State.on('doc', () => {
      st.conflictWith = null;
      chipSet('idle');
      // register a drawing the cloud hasn't seen; a project opened FROM the
      // cloud only pushes again when something actually changes — opening
      // must never bump the version or claim "updated by"
      if (State.S.fingerprint && !map[State.S.fingerprint]) schedulePush();
    });
    window.addEventListener('online', () => { if (st.sync.state === 'offline' || st.sync.state === 'error') push(); });

    try {
      const s = await call('status');
      st.enabled = !!s.enabled;
      st.sp = !!s.sp;
    } catch (e) {
      // can't reach the deployment (offline start) — leave the card out;
      // local recents still work and sync retries once online. A device
      // that has the register cached keeps showing it.
      st.enabled = st.token ? true : false;
      st.sp = !!(st.token && localStorage.getItem('abmt:spreg'));
    }
    renderCard();
    if (typeof Drawings !== 'undefined') Drawings.onCloudState();
    if (typeof Home !== 'undefined') Home.refresh();
    if (st.enabled === true && st.token) { refreshList(); fetchTeamCfg(); }
  }

  document.addEventListener('DOMContentLoaded', init);

  return { signIn, signOut, openCloud, push, settle, refreshList, refreshListIfStale, setStatus, rekey, fetchRevision, deleteProject, forget, setTeamScope, _state: st };
})();
