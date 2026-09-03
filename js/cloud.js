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
  const API = '/api/cloud';

  const st = {
    enabled: null,        // null = probing, false = not configured, true = live
    token: '', name: '',
    projects: [], listPhase: 'idle', error: '',
    sync: { state: 'idle', at: 0, msg: '' }, // idle|saving|synced|offline|error|conflict
    conflictWith: null,   // registry row that beat us, while unresolved
  };
  let map = {};
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

  async function call(action, body) {
    const headers = {};
    if (st.token) headers['X-AirMark-Auth'] = st.token;
    let resp;
    try {
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        resp = await fetch(API + '?action=' + action, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      } else {
        resp = await fetch(API + '?action=' + action, { headers, signal: AbortSignal.timeout(30000) });
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
    return r.name;
  }

  function signOut(silent) {
    st.token = ''; st.name = ''; st.projects = [];
    saveJson(KEY, {});
    renderCard();
    chipSet('idle');
    if (!silent) App.toast('Signed out of the team cloud.', 'info');
  }

  /* ---------------- project list + open ---------------- */

  async function refreshList() {
    if (!st.token || st.enabled === false) return;
    st.listPhase = 'loading'; st.error = '';
    renderCard();
    try {
      const r = await call('list');
      st.projects = r.projects || [];
      st.listPhase = 'ready';
    } catch (e) {
      st.listPhase = 'ready';
      st.error = e.offline ? 'Offline — the team list needs signal. Projects already on this device still open below.' : e.message;
    }
    renderCard();
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
      const have = await Store.get(fp);
      if (!(have && have.pdf)) {
        if (!r.pdfUrl) throw new Error('the drawing PDF is not in the cloud yet — open it from its file once on the device that has it');
        const pResp = await fetch(r.pdfUrl, { signal: AbortSignal.timeout(300000) });
        if (!pResp.ok) throw new Error('PDF download failed (HTTP ' + pResp.status + ')');
        await Store.savePdf(fp, new Uint8Array(await pResp.arrayBuffer()));
      }
      await Store.saveProject(fp, r.project.name || data.fileName || 'Drawing', data);
      map[fp] = { id: r.project.id, version: r.project.version };
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

  function conflictPrompt(project) {
    st.conflictWith = project || st.conflictWith;
    const p = st.conflictWith;
    if (!p) return;
    App.toast(
      `${p.updatedBy || 'Someone'} saved a newer version of this drawing (${ageOf(p.updatedAt) || 'recently'}). Loading theirs replaces what's on this screen.`,
      'warn', 0,
      [
        { label: 'Load newest', run: () => openCloud(p.id) },
        { label: 'Keep mine — overwrite', run: () => { st.conflictWith = null; push({ force: true }); } },
      ]);
  }

  async function push(opts = {}) {
    if (!st.token || !State.S.pdf || !State.S.fingerprint || st.enabled === false) return;
    if (pushing) { pendingPush = true; return; }
    if (st.conflictWith && !opts.force) { chipSet('conflict'); return; }
    pushing = true;
    chipSet('saving');
    try {
      const fp = State.S.fingerprint;
      const known = map[fp];
      const name = String(State.S.jobRef || State.S.fileName || 'Drawing').trim().replace(/\.pdf$/i, '');
      const aroNo = String((State.S.aroSite && State.S.aroSite.project) || '');
      const prep = await call('prepare', {
        fingerprint: fp, name, aroNo,
        version: known ? known.version : 0,
        force: !!opts.force,
      });
      if (prep.conflict) { conflictPrompt(prep.project); chipSet('conflict'); return; }

      const body = JSON.stringify(Project.serialize(false));
      let up = await fetch(prep.uploadData, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(120000) });
      if (!up.ok) throw new Error('markup upload failed (HTTP ' + up.status + ')');

      let pdfUploaded = false, pdfSize = 0;
      if (prep.needPdf && prep.uploadPdf && State.S.pdfBytes) {
        up = await fetch(prep.uploadPdf, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: State.S.pdfBytes, signal: AbortSignal.timeout(600000) });
        if (up.ok) { pdfUploaded = true; pdfSize = State.S.pdfBytes.length; }
      }

      const com = await call('commit', { id: prep.id, version: prep.nextVersion, name, aroNo, pdfUploaded, pdfSize });
      if (com.conflict) { conflictPrompt(com.project); chipSet('conflict'); return; }
      map[fp] = { id: prep.id, version: prep.nextVersion };
      saveJson(MAP_KEY, map);
      st.conflictWith = null;
      chipSet('synced');
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
    let list;
    if (st.listPhase === 'loading' && !st.projects.length) list = '<div class="cloud-note">Loading the team list…</div>';
    else if (!st.projects.length) list = '<div class="cloud-note">No team projects yet — open a drawing and it syncs up automatically.</div>';
    else {
      list = st.projects.map(p => `
        <button class="recent-chip cloud-proj" data-id="${esc(p.id)}" title="${esc(p.name)}${p.hasPdf ? '' : ' (PDF not uploaded yet)'}">
          ${esc(p.name)}<span>${p.aroNo ? '#' + esc(p.aroNo) + ' · ' : ''}${esc(p.updatedBy)} · ${esc(ageOf(p.updatedAt))}</span>
        </button>`).join('');
    }
    el.innerHTML = `
      <div class="cloud-card">
        <div class="recent-cap">Team projects</div>
        <div class="cloud-who"><span>Signed in as <b>${esc(st.name)}</b></span>
          <button class="mini-btn" id="cl-refresh" title="Re-load the team list">⟳</button>
          <button class="mini-btn" id="cl-out">Sign out</button>
        </div>
        ${st.error ? `<div class="cloud-err">${esc(st.error)}</div>` : ''}
        <div class="cloud-list">${list}</div>
      </div>`;
    el.querySelector('#cl-refresh').addEventListener('click', refreshList);
    el.querySelector('#cl-out').addEventListener('click', () => signOut());
    el.querySelectorAll('.cloud-proj').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); openCloud(b.dataset.id); }));
  }

  const CHIP_TEXT = {
    saving: '☁ saving…',
    synced: '☁ synced',
    offline: '☁ offline — will sync',
    error: '☁ sync failed — tap',
    conflict: '☁ newer version exists — tap',
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
    if (s.state === 'error') { App.toast('Cloud sync failed: ' + (s.msg || 'unknown error') + ' — retrying on the next change.', 'warn', 7000); push(); return; }
    if (s.state === 'offline') { App.toast('No signal — markups are safe on this device and sync when you’re back online.', 'info', 6000); push(); return; }
    if (s.state === 'synced') App.toast('This drawing is synced to the team cloud (as ' + st.name + ').', 'ok', 4000);
  }

  /* ---------------- boot ---------------- */

  async function init() {
    const saved = loadJson(KEY, {});
    st.token = saved.token || ''; st.name = saved.name || '';
    map = loadJson(MAP_KEY, {});

    chipEl = document.createElement('button');
    chipEl.id = 'cloudChip';
    chipEl.className = 'cloud-chip';
    chipEl.hidden = true;
    chipEl.addEventListener('click', chipTap);
    document.body.appendChild(chipEl);

    State.on('autosave', schedulePush);
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
    } catch (e) {
      // can't reach the deployment (offline start) — leave the card out;
      // local recents still work and sync retries once online
      st.enabled = st.token ? true : false;
    }
    renderCard();
    if (st.enabled === true && st.token) refreshList();
  }

  document.addEventListener('DOMContentLoaded', init);

  return { signIn, signOut, openCloud, push, refreshList, _state: st };
})();
