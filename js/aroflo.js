/* AirMark — live AroFlo site stock (right-panel “Stock” tab).
 *
 * Talks to the read-only serverless proxy in api/aroflo.js (the AroFlo HMAC
 * secret lives server-side only). Pulls the inventory list with stock levels
 * joined, caches it locally so the tab still shows the last snapshot offline,
 * and offers search / per-holder filtering plus a task-materials lookup by
 * AroFlo job number.
 */
const Aro = (() => {
  'use strict';

  const CFG_KEY = 'abmt:aroflo';
  const CACHE_KEY = 'abmt:aroflo:cache';
  const STALE_MS = 15 * 60 * 1000;   // auto-refresh when shown and older than this
  const MAX_PAGES = 12;              // safety cap: 12 × 250 = 3000 items
  const MAX_ROWS = 400;              // rendered rows cap (search narrows the rest)

  let root = null;
  let cfg = { url: '/api/aroflo', token: '' };
  const st = {
    phase: 'idle',        // idle | loading | ready | error | unconfigured
    items: [],
    asAt: null,           // ISO string of last successful refresh
    error: '',
    progress: '',
    filter: '',
    holder: '',           // '' = all locations
    hideZero: true,
    shownOnce: false,
    expanded: null,       // itemid with the holder breakdown open
    tm: { job: '', tasks: [], taskid: '', materials: [], phase: 'idle', error: '', open: false },
  };
  let inflight = false;

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const qty = n => {
    const v = Math.round((Number(n) || 0) * 100) / 100;
    return String(v % 1 === 0 ? v.toFixed(0) : v);
  };
  const holderKind = t => (t === 'org' ? 'business unit' : t === 'user' ? 'user / van' : t === 'cholder' ? 'holder' : t);

  /* ---------------- config + cache ---------------- */

  function loadCfg() {
    try {
      const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      if (c && typeof c === 'object') cfg = { url: c.url || '/api/aroflo', token: c.token || '' };
    } catch (e) { /* defaults */ }
  }
  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }
  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (c && Array.isArray(c.items)) { st.items = c.items; st.asAt = c.asAt || null; return true; }
    } catch (e) { /* ignore */ }
    return false;
  }
  function saveCache() {
    try {
      const s = JSON.stringify({ items: st.items, asAt: st.asAt });
      if (s.length < 2_500_000) localStorage.setItem(CACHE_KEY, s);
    } catch (e) { /* storage full — snapshot just won't persist */ }
  }

  /* ---------------- proxy calls ---------------- */

  async function call(action, params = {}, opts = {}) {
    const u = new URL(cfg.url, location.href);
    u.searchParams.set('action', action);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
    const headers = {};
    if (cfg.token) headers['X-Proxy-Token'] = cfg.token;
    let resp;
    try {
      resp = await fetch(u, { headers, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new Error(u.origin === location.origin
        ? 'Could not reach the AroFlo proxy (/api/aroflo). It runs when the app is deployed on Vercel — see Settings for details.'
        : 'Could not reach the AroFlo proxy at ' + u.origin + '.');
    }
    if (resp.status === 401) throw new Error('Proxy token rejected — check the token in Settings.');
    let body;
    try { body = await resp.json(); } catch (e) {
      throw new Error(u.origin === location.origin
        ? 'No AroFlo proxy at /api/aroflo on this host. Deploy the app to Vercel (or point Settings at a deployed proxy URL).'
        : 'The proxy returned an unexpected response (HTTP ' + resp.status + ').');
    }
    if (body.notConfigured) { const err = new Error(body.statusmessage); err.notConfigured = true; throw err; }
    if (opts.raw) return body;
    if (!body.ok) throw new Error(body.statusmessage || ('AroFlo error (HTTP ' + (body.httpStatus || resp.status) + ')'));
    return body;
  }

  async function refresh() {
    if (inflight) return;
    inflight = true;
    st.phase = 'loading'; st.error = ''; st.progress = 'Contacting AroFlo…';
    render();
    try {
      const items = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        st.progress = 'Loading inventory — page ' + page + '… (' + items.length + ' items)';
        renderStatus();
        const r = await call('inventory', { page });
        items.push(...(r.items || []));
        if (r.last || !(r.items || []).length) break;
      }
      st.items = items;
      st.asAt = new Date().toISOString();
      st.phase = 'ready';
      saveCache();
    } catch (e) {
      if (e.notConfigured) { st.phase = 'unconfigured'; st.error = e.message; }
      else if (st.items.length || st.asAt) { st.phase = 'ready'; st.error = e.message; }
      else { st.phase = 'unconfigured'; st.error = e.message; } // first run: show the setup panel with the reason
    }
    inflight = false;
    render();
  }

  /* ---------------- derived data ---------------- */

  function holders() {
    const seen = new Map();
    for (const it of st.items) for (const l of it.levels || []) {
      if (l.to && !seen.has(l.to)) seen.set(l.to, l.type);
    }
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  function itemQty(it) {
    let q = 0;
    for (const l of it.levels || []) if (!st.holder || l.to === st.holder) q += l.qty;
    return q;
  }

  function filteredItems() {
    const terms = st.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const it of st.items) {
      if (terms.length) {
        const hay = (it.desc + ' ' + it.pn + ' ' + it.cat).toLowerCase();
        if (!terms.every(t => hay.includes(t))) continue;
      }
      if (st.holder && !(it.levels || []).some(l => l.to === st.holder)) continue;
      const q = itemQty(it);
      if (st.hideZero && q <= 0) continue;
      out.push({ it, q });
    }
    return out;
  }

  /* ---------------- rendering ---------------- */

  function render() {
    if (!root) return;
    if (st.phase === 'idle' || st.phase === 'unconfigured') { renderIntro(); return; }
    let h = `
      <div class="aro-bar">
        <input type="text" id="aro-search" placeholder="Search stock… (e.g. impress 54)" value="${esc(st.filter)}" autocomplete="off">
        <button class="mini-btn" id="aro-refresh" title="Re-load stock from AroFlo"${st.phase === 'loading' ? ' disabled' : ''}>⟳</button>
        <button class="mini-btn" id="aro-cfg" title="AroFlo connection settings">⚙</button>
      </div>
      <div class="aro-bar">
        <select id="aro-holder" title="Show stock held by">
          <option value="">All locations</option>
          ${holders().map(([to, type]) => `<option value="${esc(to)}"${st.holder === to ? ' selected' : ''}>${esc(to)} — ${esc(holderKind(type))}</option>`).join('')}
        </select>
        <label class="chk" title="Hide items with no stock at the selected location"><input type="checkbox" id="aro-zero"${st.hideZero ? ' checked' : ''}> In stock</label>
      </div>
      <div class="aro-status" id="aro-status"></div>
      <div class="aro-list" id="aro-list"></div>`;
    h += taskMaterialsHtml();
    root.innerHTML = h;

    const search = root.querySelector('#aro-search');
    let deb = 0;
    search.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => { st.filter = search.value; renderList(); renderStatus(); }, 140);
    });
    root.querySelector('#aro-refresh').addEventListener('click', refresh);
    root.querySelector('#aro-cfg').addEventListener('click', settingsDialog);
    root.querySelector('#aro-holder').addEventListener('change', e => { st.holder = e.target.value; renderList(); renderStatus(); });
    root.querySelector('#aro-zero').addEventListener('change', e => { st.hideZero = e.target.checked; renderList(); renderStatus(); });
    wireTaskMaterials();
    renderList();
    renderStatus();
  }

  function renderStatus() {
    const el = root && root.querySelector('#aro-status');
    if (!el) return;
    if (st.phase === 'loading') { el.innerHTML = `<span class="aro-busy">${esc(st.progress)}</span>`; return; }
    let h = '';
    if (st.error) h += `<div class="aro-error">${esc(st.error)}</div>`;
    if (st.asAt) {
      const mins = Math.round((Date.now() - Date.parse(st.asAt)) / 60000);
      const age = mins < 1 ? 'just now' : mins < 60 ? mins + ' min ago' : new Date(st.asAt).toLocaleString();
      h += `<span class="muted">${filteredItems().length} of ${st.items.length} items · as at ${esc(age)}</span>`;
    }
    el.innerHTML = h;
  }

  function renderList() {
    const el = root && root.querySelector('#aro-list');
    if (!el) return;
    const rows = filteredItems();
    if (!rows.length) {
      el.innerHTML = `<p class="prop-note">${st.items.length ? 'Nothing matches — clear the search or show out-of-stock items.' : 'No inventory loaded yet — hit ⟳ to pull it from AroFlo.'}</p>`;
      return;
    }
    let h = '';
    for (const { it, q } of rows.slice(0, MAX_ROWS)) {
      const open = st.expanded === it.id;
      h += `<div class="aro-item${open ? ' open' : ''}" data-id="${esc(it.id)}">
        <div class="aro-row">
          <div class="aro-main">
            <div class="aro-desc">${esc(it.desc)}</div>
            <div class="aro-sub">${esc(it.pn)}${it.cat ? ' · ' + esc(it.cat) : ''}</div>
          </div>
          <div class="aro-qty${q <= 0 ? ' zero' : ''}">${qty(q)}</div>
        </div>
        ${open ? aroLevelsHtml(it) : ''}
      </div>`;
    }
    if (rows.length > MAX_ROWS) h += `<p class="prop-note">…and ${rows.length - MAX_ROWS} more — refine the search.</p>`;
    el.innerHTML = h;
    el.querySelectorAll('.aro-item').forEach(div =>
      div.addEventListener('click', () => {
        const id = div.dataset.id;
        st.expanded = st.expanded === id ? null : id;
        renderList();
      }));
  }

  function aroLevelsHtml(it) {
    const levels = (it.levels || []).filter(l => l.to);
    if (!levels.length) return `<div class="aro-levels"><span class="muted">No stock locations recorded.</span></div>`;
    return `<div class="aro-levels">${levels.map(l =>
      `<div class="aro-level"><span>${esc(l.to)} <span class="muted">(${esc(holderKind(l.type))})</span></span><b>${qty(l.qty)}</b></div>`).join('')}
    </div>`;
  }

  /* ---------------- intro / setup ---------------- */

  function renderIntro() {
    root.innerHTML = `
      <div class="prop-cap">Site stock — AroFlo</div>
      <p class="prop-note">Show a live inventory list straight from AroFlo — what's held at each store, van or site holder — plus the materials already recorded against the job's task.</p>
      ${st.error ? `<div class="aro-error">${esc(st.error)}</div>` : ''}
      <p class="prop-note">The app talks to a small read-only proxy (<code>api/aroflo.js</code>) that holds your AroFlo API keys server-side — keys are never in the browser. Deploy this repo to Vercel and add the <code>AROFLO_*</code> environment variables (see the README), then connect.</p>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="mini-btn primary" id="aro-connect">Connect…</button>
        <button class="mini-btn" id="aro-try">Try /api/aroflo</button>
      </div>`;
    root.querySelector('#aro-connect').addEventListener('click', settingsDialog);
    root.querySelector('#aro-try').addEventListener('click', refresh);
  }

  function diagHtml(d) {
    const rows = Object.entries(d.vars || {}).map(([name, v]) => {
      const short = name.replace('AROFLO_', '');
      if (!v.set) return `<div class="aro-diag-row bad">⚠ ${esc(short)}: <b>not set</b></div>`;
      const flags = [];
      if (v.innerWhitespace) flags.push('contains a line break or space — re-paste it');
      if (!v.base64ish) flags.push('unexpected characters — check what was pasted');
      return `<div class="aro-diag-row${flags.length ? ' bad' : ''}">${flags.length ? '⚠' : '·'} ${esc(short)}: ${v.len} chars, “${esc(v.ends)}”${flags.length ? ' — ' + esc(flags.join('; ')) : ''}</div>`;
    }).join('');
    return `<div class="aro-diag"><div class="aro-diag-cap">What the server has stored (lengths only — never the keys):</div>${rows}
      ${d.hostIpConfigured ? '<div class="aro-diag-row">· AROFLO_HOST_IP is set — remove it unless your AroFlo setup uses a fixed Host IP.</div>' : ''}
      <div class="aro-diag-cap">Compare each length and the first/last letters against the AroFlo API page. If they all match, the usual cause is the AroFlo side: open Site Admin → AroFlo API, make sure <b>Save API Settings</b> was clicked, and that no key was re-generated after you copied it (re-copy the current values if unsure).</div></div>`;
  }

  function settingsDialog() {
    App.modal(`
      <h3>AroFlo connection</h3>
      <p class="muted">The proxy URL is <code>/api/aroflo</code> when the app itself is deployed on Vercel with the AroFlo keys set. You can also point at a proxy deployed elsewhere.</p>
      <div class="form-row"><label>Proxy URL</label>
        <input type="text" id="aro-url" value="${esc(cfg.url)}" placeholder="/api/aroflo" autocomplete="off"></div>
      <div class="form-row"><label>Proxy token</label>
        <input type="password" id="aro-token" value="${esc(cfg.token)}" placeholder="only if AROFLO_PROXY_TOKEN is set" autocomplete="off"></div>
      <p class="muted" id="aro-test-out"></p>
      <div class="modal-actions">
        <button class="mini-btn" id="aro-test">Test connection</button>
        <span style="flex:1"></span>
        <button class="mini-btn" id="aro-cancel">Cancel</button>
        <button class="mini-btn primary" id="aro-save">Save</button>
      </div>`, (box, close) => {
      const read = () => {
        cfg.url = box.querySelector('#aro-url').value.trim() || '/api/aroflo';
        cfg.token = box.querySelector('#aro-token').value.trim();
      };
      box.querySelector('#aro-test').addEventListener('click', async () => {
        read(); saveCfg();
        const out = box.querySelector('#aro-test-out');
        out.textContent = 'Testing…';
        try {
          const r = await call('ping');
          out.textContent = '✓ Connected — ' + ((r.businessUnits || []).join(', ') || 'AroFlo replied OK');
        } catch (e) {
          out.textContent = '✕ ' + e.message;
          // AroFlo rejected the signed request (not a reach/token problem):
          // pull the server-side credential fingerprints to spot a paste error.
          if (!e.notConfigured && !/proxy|reach/i.test(e.message)) {
            try {
              const d = await call('diag', {}, { raw: true });
              if (d && d.vars) out.innerHTML = '✕ ' + esc(e.message) + diagHtml(d);
            } catch (e2) { /* diag unavailable — leave the plain error */ }
          }
        }
      });
      box.querySelector('#aro-cancel').addEventListener('click', close);
      box.querySelector('#aro-save').addEventListener('click', () => {
        read(); saveCfg(); close();
        refresh();
      });
    });
  }

  /* ---------------- task materials ---------------- */

  function taskMaterialsHtml() {
    const tm = st.tm;
    let h = `<div class="prop-cap aro-tm-cap" id="aro-tm-toggle">${tm.open ? '▾' : '▸'} Job materials used (AroFlo task)</div>`;
    if (!tm.open) return h;
    h += `<div class="aro-bar">
      <input type="text" id="aro-job" placeholder="Job number" value="${esc(tm.job)}" autocomplete="off" style="max-width:110px">
      <button class="mini-btn" id="aro-tm-load"${tm.phase === 'loading' ? ' disabled' : ''}>Load</button>
    </div>`;
    if (tm.phase === 'loading') h += `<div class="aro-status"><span class="aro-busy">Loading…</span></div>`;
    if (tm.error) h += `<div class="aro-error">${esc(tm.error)}</div>`;
    if (tm.tasks.length > 1) {
      h += `<div class="aro-bar"><select id="aro-tm-task">${tm.tasks.map(t =>
        `<option value="${esc(t.taskid)}"${t.taskid === tm.taskid ? ' selected' : ''}>#${esc(t.job)} ${esc(t.name)} (${esc(t.status)})</option>`).join('')}</select></div>`;
    } else if (tm.tasks.length === 1) {
      const t = tm.tasks[0];
      h += `<p class="prop-note">#${esc(t.job)} ${esc(t.name)}${t.client ? ' — ' + esc(t.client) : ''} (${esc(t.status)})</p>`;
    }
    if (tm.materials.length) {
      h += `<table class="to-table"><tr><th>Item</th><th style="text-align:right">Qty</th></tr>`;
      for (const m of tm.materials) {
        h += `<tr><td title="${esc(m.pn)} · ${esc(m.date)}">${esc(m.item)}</td><td class="num">${qty(m.qty)}</td></tr>`;
      }
      h += `<tr class="total"><td>Lines</td><td class="num">${tm.materials.length}</td></tr></table>`;
    } else if (tm.taskid && tm.phase === 'ready') {
      h += `<p class="prop-note">No materials recorded on this task yet.</p>`;
    }
    return h;
  }

  function wireTaskMaterials() {
    const toggle = root.querySelector('#aro-tm-toggle');
    if (toggle) toggle.addEventListener('click', () => {
      st.tm.open = !st.tm.open;
      if (st.tm.open && !st.tm.job) {
        const digits = String(State.S.jobRef || '').replace(/\D+/g, '');
        if (digits) st.tm.job = digits;
      }
      render();
    });
    const load = root.querySelector('#aro-tm-load');
    if (load) load.addEventListener('click', loadTaskMaterials);
    const jobIn = root.querySelector('#aro-job');
    if (jobIn) {
      jobIn.addEventListener('input', () => { st.tm.job = jobIn.value; });
      jobIn.addEventListener('keydown', e => { if (e.key === 'Enter') loadTaskMaterials(); });
    }
    const sel = root.querySelector('#aro-tm-task');
    if (sel) sel.addEventListener('change', async () => {
      st.tm.taskid = sel.value;
      await loadMaterialsFor(st.tm.taskid);
    });
  }

  async function loadTaskMaterials() {
    const tm = st.tm;
    const job = String(tm.job || '').replace(/\D+/g, '');
    if (!job) { tm.error = 'Type the AroFlo job number.'; render(); return; }
    tm.phase = 'loading'; tm.error = ''; tm.tasks = []; tm.materials = []; tm.taskid = '';
    render();
    try {
      const r = await call('task', { jobnumber: job });
      tm.tasks = r.tasks || [];
      if (!tm.tasks.length) { tm.phase = 'ready'; tm.error = 'No AroFlo task found for job ' + job + '.'; render(); return; }
      tm.taskid = tm.tasks[0].taskid;
      await loadMaterialsFor(tm.taskid);
    } catch (e) {
      tm.phase = 'ready'; tm.error = e.message; render();
    }
  }

  async function loadMaterialsFor(taskid) {
    const tm = st.tm;
    tm.phase = 'loading'; tm.error = ''; tm.materials = [];
    render();
    try {
      const r = await call('taskmaterials', { taskid });
      tm.materials = r.materials || [];
      tm.phase = 'ready';
    } catch (e) { tm.phase = 'ready'; tm.error = e.message; }
    render();
  }

  /* ---------------- boot ---------------- */

  function onShow() {
    if (st.shownOnce) return;
    st.shownOnce = true;
    const fresh = st.asAt && (Date.now() - Date.parse(st.asAt) < STALE_MS);
    if (!(st.phase === 'ready' && fresh)) refresh(); // an unconfigured proxy answers instantly with the setup panel
  }

  function init() {
    root = document.getElementById('tab-stock');
    if (!root) return;
    loadCfg();
    if (loadCache()) st.phase = 'ready';
    render();
    const tabBtn = document.querySelector('#rightPanel .tab[data-tab="stock"]');
    if (tabBtn) tabBtn.addEventListener('click', onShow);
  }

  document.addEventListener('DOMContentLoaded', init);

  return { refresh, settingsDialog, call, _state: st };
})();
