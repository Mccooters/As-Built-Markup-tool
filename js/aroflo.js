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
  const STALE_MS = 60 * 60 * 1000;   // snapshot older than this gets a "⟳ for live figures" hint
  const MAX_PAGES = 40;              // safety cap: 40 × 500 = 20,000 items
  const MAX_ROWS = 400;              // rendered rows cap (search narrows the rest)

  let root = null;                    // right-panel tab (compact summary)
  let pageEl = null, mainEl = null, sideEl = null; // full-screen stock manager
  let cfg = { url: '/api/aroflo', token: '', cats: [] }; // cats: [] = sync everything
  const st = {
    phase: 'idle',        // idle | loading | ready | error | unconfigured
    items: [],
    allHolders: [],       // every active holder/BU from AroFlo, stocked or not
    asAt: null,           // ISO string of last successful refresh
    error: '',
    progress: '',
    filter: '',
    holder: '',           // '' = all locations
    hideZero: true,
    lowOnly: false,       // only rows below their minimum at the holder
    shownOnce: false,
    refOpen: false,       // Impress reference card expanded
    pickOpen: false,      // pick-list card expanded
    pickDay: false,       // pick list scoped to the active work day
    expanded: null,       // itemid with the holder breakdown open
    take: { on: false, name: '', id: '', type: '', counts: {}, pushing: false },
    catView: false,       // stocktake laid out like the press-fitting catalogue
    tm: { mode: 'task', job: '', tasks: [], taskid: '', materials: [], phase: 'idle', error: '', open: false,
          progress: '', pQuery: '', pMatches: [], pId: '', pName: '', pTasks: [], agg: [],
          pView: 'item', aggOpen: '' },
  };
  let projCache = null; // AroFlo project list, fetched once per session
  let codeMap = {};     // learned barcode/QR → itemid links     (abmt:barcodes)
  let pars = {};        // per-holder minimum levels {holder:{itemid:min}} (abmt:pars)
  let itemMap = {};     // takeoff line → itemid links           (abmt:itemmap)
  let sysPresets = [];  // material-system presets [{id,name,cats}] (abmt:syspresets)
  let jobSys = {};      // job → preset id                        (abmt:jobsys)
  let usedDrafts = {};  // job → {counts:{itemid:qty}, sys, at} — unsent tallies (abmt:used)
  let catParent = {};   // category leaf name → parent name       (abmt:cattree)
  const loadJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
  const saveJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full */ } };
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
      if (c && typeof c === 'object') cfg = { url: c.url || '/api/aroflo', token: c.token || '', cats: Array.isArray(c.cats) ? c.cats : [] };
    } catch (e) { /* defaults */ }
  }
  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }
  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (c && Array.isArray(c.items)) {
        st.items = c.items; st.asAt = c.asAt || null;
        st.allHolders = Array.isArray(c.allHolders) ? c.allHolders : [];
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }
  function saveCache() {
    try {
      let s = JSON.stringify({ items: st.items, asAt: st.asAt, allHolders: st.allHolders });
      if (s.length >= 2_500_000) {
        // big catalog: persist just the items that hold stock somewhere, so
        // the offline snapshot still answers "what's on site"
        const stocked = st.items.filter(it => (it.levels || []).some(l => l.qty !== 0));
        s = JSON.stringify({ items: stocked, asAt: st.asAt, allHolders: st.allHolders, partial: true });
      }
      if (s.length < 2_500_000) localStorage.setItem(CACHE_KEY, s);
    } catch (e) { /* storage full — snapshot just won't persist */ }
  }

  /* ---------------- proxy calls ---------------- */

  // AroFlo allows 3 requests per second — space every proxied call out so a
  // burst (multi-category refresh, stock sweep, project aggregation) never
  // trips the limit and kills the crawl halfway.
  let nextSlot = 0;
  async function pace() {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + 380;
    if (wait) await new Promise(r => setTimeout(r, wait));
  }

  async function call(action, params = {}, opts = {}) {
    await pace();
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

  // Write path: JSON POST to the proxy (used by stocktake pushes & transfers).
  async function postCall(action, payload) {
    await pace();
    const u = new URL(cfg.url, location.href);
    u.searchParams.set('action', action);
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.token) headers['X-Proxy-Token'] = cfg.token;
    let resp;
    try {
      resp = await fetch(u, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
    } catch (e) { throw new Error('Could not reach the AroFlo proxy.'); }
    if (resp.status === 401) throw new Error('Proxy token rejected — check the token in Settings.');
    let body;
    try { body = await resp.json(); } catch (e) { throw new Error('Unexpected proxy response (HTTP ' + resp.status + ').'); }
    if (!body.ok) throw new Error(body.statusmessage || ('AroFlo error (HTTP ' + (body.httpStatus || resp.status) + ')'));
    return body;
  }

  // Resolve a holder name to its AroFlo id/type — from the holders list the
  // proxy supplies, else from any stock row that names it.
  function resolveHolder(name) {
    const h = st.allHolders.find(x => x.name === name && x.id);
    if (h) return { id: h.id, type: h.type };
    for (const it of st.items) for (const l of it.levels || []) {
      if (l.to === name && l.id) return { id: l.id, type: l.type };
    }
    return null;
  }

  const qtyAt = (it, name) => (it.levels || []).reduce((a, l) => a + (l.to === name ? l.qty : 0), 0);

  // Mirror a set of adjuststock moves onto the local snapshot, so writes
  // update the list instantly instead of forcing a full re-crawl — the next
  // manual ⟳ re-reads the true figures from AroFlo.
  function applyLocalMoves(moves) {
    for (const mv of moves) {
      const it = st.items.find(x => x.id === mv.itemid);
      if (!it) continue;
      const h = st.allHolders.find(x => x.id === mv.toId);
      let row = (it.levels || []).find(l => l.id === mv.toId || (h && l.to === h.name));
      if (!row) {
        row = { to: h ? h.name : mv.toId, id: mv.toId, type: mv.toType, qty: 0, updated: '' };
        (it.levels = it.levels || []).push(row);
      }
      row.qty = Math.round((row.qty + mv.delta) * 10000) / 10000;
    }
    saveCache();
  }

  async function refresh() {
    if (inflight) return;
    inflight = true;
    st.phase = 'loading'; st.error = ''; st.progress = 'Contacting AroFlo…';
    render();
    try {
      const items = [];
      st.capped = false;
      st.outside = 0;
      const crawl = async (params) => {
        for (let page = 1; page <= MAX_PAGES; page++) {
          st.progress = 'Loading ' + (params.cat ? '“' + params.cat + '”' : 'inventory') + ' — page ' + page + '… (' + items.length + ' items)';
          renderStatus();
          let r;
          try {
            r = await call('inventory', { ...params, page });
          } catch (e) {
            // keep what we have rather than losing the whole crawl
            if (!items.length) throw e;
            st.error = 'Stopped early at ' + items.length + ' items: ' + e.message;
            return;
          }
          items.push(...(r.items || []));
          if (r.last || !(r.items || []).length) return;
          if (page === MAX_PAGES) st.capped = true;
        }
      };
      if (cfg.cats.length) {
        // scoped sync: one small crawl per chosen category…
        for (const cat of cfg.cats) await crawl({ cat });
        // …then a sweep of ALL stock rows, so stock held on items outside the
        // scope is never invisible. Skipped when the crawl itself failed —
        // classifying items as "outside scope" needs a complete crawl.
        try {
          if (st.error) throw new Error('crawl incomplete');
          const known = new Set(items.map(i => i.id));
          const orphan = new Map();
          for (let page = 1; page <= 8; page++) {
            const r = await call('stockrows', { page });
            for (const row of r.rows || []) {
              if (row.qty !== 0 && row.itemid && !known.has(row.itemid)) {
                if (!orphan.has(row.itemid)) orphan.set(row.itemid, []);
                orphan.get(row.itemid).push({ to: row.to, id: row.id, type: row.type, qty: row.qty, updated: '' });
              }
            }
            if (r.last) break;
          }
          st.outside = orphan.size;
          // name the biggest holdings first; the rest collapse into one
          // summary line in the list rather than a wall of nameless rows
          const ranked = [...orphan.entries()]
            .sort((a, b) => b[1].reduce((s, l) => s + l.qty, 0) - a[1].reduce((s, l) => s + l.qty, 0));
          let resolved = 0;
          for (const [itemid, levels] of ranked) {
            if (resolved < 10) {
              st.progress = 'Naming stocked items outside the synced categories… (' + (resolved + 1) + ')';
              renderStatus();
              try {
                const r = await call('inventory', { itemid });
                if ((r.items || []).length) { items.push(r.items[0]); resolved++; continue; }
              } catch (e) { /* fall through to stub */ }
            }
            items.push({ id: itemid, desc: '(item outside synced categories)', pn: '', cat: '', levels, stub: true });
          }
        } catch (e) { /* sweep is best-effort */ }
        items.sort((a, b) => a.desc.localeCompare(b.desc));
      } else {
        await crawl({});
      }
      st.items = items;
      // Also pull the full holder list, so a new site holder shows in the
      // location filter before any stock has been assigned to it.
      try {
        const h = await call('holders');
        st.allHolders = Array.isArray(h.locations) && h.locations.length
          ? h.locations
          : [
            ...(h.holders || []).map(name => ({ name, type: 'cholder' })),
            ...(h.businessUnits || []).map(name => ({ name, type: 'org' })),
          ];
      } catch (e) { /* non-fatal — fall back to holders seen on stock rows */ }
      // Category tree (leaf → parent name) for catalogue section headers.
      try {
        const rc = await call('categories');
        catParent = {};
        for (const c of rc.categories || []) if (c.parent) catParent[c.name] = c.parent;
        saveJson('abmt:cattree', catParent);
      } catch (e) { /* headers just show leaf names */ }
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
    for (const h of st.allHolders) if (h.name && !seen.has(h.name)) seen.set(h.name, h.type);
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
      const min = st.holder ? parOf(st.holder, it.id) : null;
      if (st.lowOnly && st.holder) {
        if (min == null || q >= min) continue;
      } else if (st.hideZero && q <= 0) continue;
      out.push({ it, q, min });
    }
    return out;
  }

  /* ---------------- rendering ---------------- */

  /* ---------------- full-screen page ---------------- */

  const pageOpen = () => pageEl && !pageEl.classList.contains('hidden');

  // Stock context remembered per drawing project: the holder you filter to
  // and the AroFlo project you load travel with the .airmark / autosave.
  function rememberSite(patch) {
    if (!State.S.pdf) return;
    State.S.aroSite = Object.assign({}, State.S.aroSite || {}, patch);
    State.emit('autosave');
  }

  function openPage() {
    if (!pageEl) return;
    pageEl.classList.remove('hidden');
    document.body.classList.remove('panel-open');
    const site = State.S.aroSite;
    if (site) {
      if (site.holder && !st.holder) st.holder = site.holder;
      if (site.project && !st.tm.pQuery) { st.tm.pQuery = site.project; st.tm.mode = 'project'; }
    }
    render();
    // open instantly from the local snapshot — a crawl only runs when there
    // is nothing cached yet; ⟳ is the deliberate way to pull live figures
    if (!st.items.length && st.phase !== 'loading') refresh();
  }

  function closePage() {
    if (!pageEl) return;
    pageEl.classList.add('hidden');
    renderTab();
  }

  function render() {
    renderTab();
    if (pageOpen()) renderPage();
  }

  // Compact summary in the right-panel tab — the real UI lives on the page.
  function renderTab() {
    if (!root) return;
    let status;
    if (st.phase === 'loading') status = esc(st.progress || 'Loading…');
    else if (st.items.length) {
      const mins = st.asAt ? Math.round((Date.now() - Date.parse(st.asAt)) / 60000) : null;
      status = `<b>${st.items.length}</b> items` + (mins != null ? ` · as at ${mins < 1 ? 'just now' : mins + ' min ago'}` : '');
    } else if (st.phase === 'unconfigured' || st.phase === 'idle') status = 'Not connected yet.';
    else status = 'No inventory loaded yet.';
    root.innerHTML = `
      <div class="prop-cap">Site stock — AroFlo</div>
      <p class="prop-note">${status}</p>
      ${st.error ? `<div class="aro-error">${esc(st.error)}</div>` : ''}
      <button class="mini-btn primary" id="aro-open">Open stock manager</button>
      <p class="prop-note" style="margin-top:8px">Live inventory by location, stocktakes, transfers and per-task / per-project materials — full screen.</p>`;
    root.querySelector('#aro-open').addEventListener('click', openPage);
  }

  function renderPage() {
    if (st.phase === 'idle' || st.phase === 'unconfigured') {
      renderIntro(mainEl);
      sideEl.innerHTML = '';
      return;
    }
    let h = `<div class="stock-controls"><div class="aro-bar">
        <input type="text" id="aro-search" placeholder="Search stock… (e.g. impress 54)" value="${esc(st.filter)}" autocomplete="off">
        <button class="mini-btn" id="aro-scan" title="Scan a barcode or QR label">📷</button>
        <button class="mini-btn" id="aro-refresh" title="Re-load stock from AroFlo"${st.phase === 'loading' ? ' disabled' : ''}>⟳</button>
        <button class="mini-btn" id="aro-cfg" title="AroFlo connection settings">⚙</button>
      </div>`;
    if (st.take.on) {
      h += `
      <div class="aro-take-bar">
        <span class="aro-take-cap">Stocktake — <b>${esc(st.take.name)}</b></span>
        <button class="mini-btn${st.catView ? ' primary' : ''}" id="aro-take-cat" title="Lay the count out like the press-fitting catalogue — families down, sizes across">Catalogue</button>
        <button class="mini-btn primary" id="aro-take-review">Review &amp; push…</button>
        <button class="mini-btn" id="aro-take-cancel">Cancel</button>
      </div>
      <p class="prop-note">Type what you actually counted into each line — leave a line blank to skip it. Nothing is sent to AroFlo until you review and confirm.</p>`;
    } else {
      h += `
      <div class="aro-bar">
        <select id="aro-holder" title="Show stock held by">
          <option value="">All locations</option>
          ${holders().map(([to, type]) => `<option value="${esc(to)}"${st.holder === to ? ' selected' : ''}>${esc(to)} — ${esc(holderKind(type))}</option>`).join('')}
        </select>
        <label class="chk" title="Hide items with no stock at the selected location"><input type="checkbox" id="aro-zero"${st.hideZero ? ' checked' : ''}> In stock</label>
        ${st.holder ? `<label class="chk" title="Only items below their minimum at this holder"><input type="checkbox" id="aro-low"${st.lowOnly ? ' checked' : ''}> Low</label>` : ''}
        <button class="mini-btn" id="aro-take" title="Count this location and push corrected quantities to AroFlo">Stocktake</button>
        ${st.holder ? `<button class="mini-btn" id="aro-reorder" title="Everything below its minimum at this holder, as a reorder list">Reorder</button>` : ''}
        <button class="mini-btn" id="aro-labels" title="Print QR labels for the items in the current view">Labels</button>
      </div>`;
    }
    h += `<div class="aro-status" id="aro-status"></div></div>
      <div class="aro-list" id="aro-list"></div>`;
    mainEl.innerHTML = h;
    sideEl.innerHTML = `<div class="stock-card">${pickCardHtml()}</div><div class="stock-card">${taskMaterialsHtml(true)}</div><div class="stock-card">${refCardHtml()}</div>`;

    const search = mainEl.querySelector('#aro-search');
    let deb = 0;
    search.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => { st.filter = search.value; renderList(); renderStatus(); }, 140);
    });
    mainEl.querySelector('#aro-refresh').addEventListener('click', refresh);
    mainEl.querySelector('#aro-cfg').addEventListener('click', settingsDialog);
    mainEl.querySelector('#aro-scan').addEventListener('click', openScanner);
    const lowChk = mainEl.querySelector('#aro-low');
    if (lowChk) lowChk.addEventListener('change', e => { st.lowOnly = e.target.checked; renderList(); renderStatus(); });
    const reorderBtn = mainEl.querySelector('#aro-reorder');
    if (reorderBtn) reorderBtn.addEventListener('click', reorderDialog);
    const labelsBtn = mainEl.querySelector('#aro-labels');
    if (labelsBtn) labelsBtn.addEventListener('click', printLabels);
    if (st.take.on) {
      mainEl.querySelector('#aro-take-cat').addEventListener('click', () => {
        st.catView = !st.catView;
        saveJson('abmt:catview', st.catView);
        render();
      });
      mainEl.querySelector('#aro-take-review').addEventListener('click', reviewStocktake);
      mainEl.querySelector('#aro-take-cancel').addEventListener('click', () => {
        st.take = { on: false, name: '', id: '', type: '', counts: {}, pushing: false };
        render();
      });
    } else {
      mainEl.querySelector('#aro-holder').addEventListener('change', e => {
        st.holder = e.target.value;
        rememberSite({ holder: st.holder });
        renderList(); renderStatus();
      });
      mainEl.querySelector('#aro-zero').addEventListener('change', e => { st.hideZero = e.target.checked; renderList(); renderStatus(); });
      mainEl.querySelector('#aro-take').addEventListener('click', startStocktake);
    }
    wireTaskMaterials(sideEl);
    wireRefCard();
    wirePickCard();
    renderList();
    renderStatus();
  }

  async function startStocktake() {
    if (!st.holder) { App.toast('Pick a location first — a stocktake counts one holder at a time.', 'warn'); return; }
    const holderName = st.holder;
    // Always count against fresh figures — deltas computed from a stale
    // snapshot would push wrong adjustments.
    await refresh();
    const res = resolveHolder(holderName);
    if (!res) { App.toast('AroFlo did not give an id for this holder — check it exists and try again.', 'error'); return; }
    st.take = { on: true, name: holderName, id: res.id, type: res.type, counts: {}, pushing: false };
    st.expanded = null;
    render();
  }

  function renderStatus() {
    const el = document.getElementById('aro-status');
    if (!el) return;
    if (st.phase === 'loading') { el.innerHTML = `<span class="aro-busy">${esc(st.progress)}</span>`; return; }
    let h = '';
    if (st.error) h += `<div class="aro-error">${esc(st.error)}</div>`;
    if (st.take.on) {
      const counted = Object.values(st.take.counts).filter(v => String(v).trim() !== '').length;
      let age = '';
      if (st.asAt) {
        const mins = Math.round((Date.now() - Date.parse(st.asAt)) / 60000);
        age = ' · figures ' + (mins < 1 ? 'fresh' : mins + ' min old — cancel and restart if AroFlo changed');
      }
      el.innerHTML = h + `<span class="muted"><b>${counted}</b> line${counted === 1 ? '' : 's'} counted${esc(age)}</span>`;
      return;
    }
    if (st.asAt) {
      const mins = Math.round((Date.now() - Date.parse(st.asAt)) / 60000);
      const age = mins < 1 ? 'just now' : mins < 60 ? mins + ' min ago' : new Date(st.asAt).toLocaleString();
      const staleHint = Date.now() - Date.parse(st.asAt) > STALE_MS ? ' — <b>⟳ for live figures</b>' : '';
      h += `<span class="muted">${filteredItems().length} of ${st.items.length} items · as at ${esc(age)}${staleHint}</span>`;
      if (cfg.cats.length) {
        const scope = cfg.cats.length > 3 ? cfg.cats.slice(0, 3).join(', ') + ' +' + (cfg.cats.length - 3) + ' more' : cfg.cats.join(', ');
        h += `<div class="muted" style="margin-top:2px">Scope: ${esc(scope)}${st.outside ? ` · <b>${st.outside}</b> stocked item${st.outside === 1 ? '' : 's'} outside scope (shown anyway)` : ''}</div>`;
      }
      if (st.capped) h += `<div class="aro-error">Catalogue is larger than ${st.items.length} items — the rest (late alphabet) is not loaded, so searches may miss items. Scope the sync to your install categories in ⚙.</div>`;
    }
    el.innerHTML = h;
  }

  function renderList() {
    const el = document.getElementById('aro-list');
    if (!el) return;
    if (st.take.on) { renderTakeList(el); return; }
    const all = filteredItems();
    const rows = all.filter(r => !r.it.stub);
    const stubCount = all.length - rows.length;
    if (!all.length) {
      let msg;
      if (!st.items.length) msg = 'No inventory loaded yet — hit ⟳ to pull it from AroFlo.';
      else if (st.holder && !st.items.some(it => (it.levels || []).some(l => l.to === st.holder))) {
        msg = `No stock has been assigned to “${esc(st.holder)}” yet. Transfer or adjust stock onto it in AroFlo (Inventory → item → Stock Levels), then hit ⟳.`;
      } else msg = 'Nothing matches — clear the search or show out-of-stock items.';
      el.innerHTML = `<p class="prop-note">${msg}</p>`;
      return;
    }
    let h = '';
    for (const { it, q, min } of rows.slice(0, MAX_ROWS)) {
      const open = st.expanded === it.id;
      const low = min != null && q < min;
      h += `<div class="aro-item${open ? ' open' : ''}" data-id="${esc(it.id)}">
        <div class="aro-row">
          <div class="aro-main">
            <div class="aro-desc">${esc(it.desc)}${low ? ' <span class="low-badge" title="Below the minimum of ' + qty(min) + ' set for ' + esc(st.holder) + '">LOW</span>' : ''}</div>
            <div class="aro-sub">${esc(it.pn)}${it.cat ? ' · ' + esc(it.cat) : ''}${min != null ? ' · min ' + qty(min) : ''}</div>
          </div>
          <div class="aro-qty${q <= 0 ? ' zero' : ''}">${qty(q)}</div>
        </div>
        ${open ? aroLevelsHtml(it) : ''}
      </div>`;
    }
    if (rows.length > MAX_ROWS) h += `<p class="prop-note">…and ${rows.length - MAX_ROWS} more — refine the search.</p>`;
    if (stubCount) h += `<p class="prop-note">…plus <b>${stubCount}</b> stocked item${stubCount === 1 ? '' : 's'} outside the synced categories (quantities counted above) — open ⚙ and widen the scope to see them by name.</p>`;
    el.innerHTML = h;
    el.querySelectorAll('.aro-item').forEach(div =>
      div.addEventListener('click', () => {
        const id = div.dataset.id;
        st.expanded = st.expanded === id ? null : id;
        renderList();
      }));
    el.querySelectorAll('.aro-move').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        transferDialog(btn.dataset.item, parseInt(btn.dataset.level, 10));
      }));
    el.querySelectorAll('.aro-min').forEach(inp => {
      inp.addEventListener('click', e => e.stopPropagation());
      inp.addEventListener('change', e => {
        e.stopPropagation();
        const v = parseFloat(String(inp.value).replace(',', '.'));
        setPar(st.holder, inp.dataset.id, Number.isFinite(v) ? v : null);
        renderList(); renderStatus();
      });
    });
  }

  // Stocktake entry: every item (search-filtered), current qty at the holder,
  // and a count input. Blank input = line not counted, no change pushed.
  function renderTakeList(el) {
    const terms = st.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const items = st.items.filter(it =>
      !it.stub && (!terms.length || terms.every(t => (it.desc + ' ' + it.pn + ' ' + it.cat).toLowerCase().includes(t))));
    if (!items.length) { el.innerHTML = `<p class="prop-note">Nothing matches the search.</p>`; return; }
    if (st.catView) { renderTakeCatalogue(el, items); return; }
    let h = '';
    for (const it of items.slice(0, MAX_ROWS)) {
      const have = qtyAt(it, st.take.name);
      const val = st.take.counts[it.id] != null ? st.take.counts[it.id] : '';
      h += `<div class="aro-item aro-take-item">
        <div class="aro-row">
          <div class="aro-main">
            <div class="aro-desc">${esc(it.desc)}</div>
            <div class="aro-sub">${esc(it.pn)}${it.cat ? ' · ' + esc(it.cat) : ''} · AroFlo has <b>${qty(have)}</b></div>
          </div>
          <input class="aro-count" data-id="${esc(it.id)}" type="text" inputmode="decimal" placeholder="${qty(have)}" value="${esc(val)}" autocomplete="off">
        </div>
      </div>`;
    }
    if (items.length > MAX_ROWS) h += `<p class="prop-note">…and ${items.length - MAX_ROWS} more — refine the search.</p>`;
    el.innerHTML = h;
    wireCountInputs(el);
  }

  function wireCountInputs(el) {
    el.querySelectorAll('.aro-count').forEach(inp => {
      inp.addEventListener('input', () => {
        st.take.counts[inp.dataset.id] = inp.value;
        renderStatus();
      });
    });
  }

  // Catalogue layout for stocktakes: the shelf order of a press-fitting
  // catalogue — one group per fitting family, one cell per size, with
  // AroFlo's figure above the count box. Families are parsed from the item
  // descriptions, most-specific first; anything unrecognised lands in Other.
  const CAT_FAMILIES = [
    { name: 'Coupling', all: ['coupling'], not: ['slip', 'reducing', 'repair'] },
    { name: 'Slip / Repair Coupling', all: ['coupling'], any: ['slip', 'repair'] },
    { name: 'Reducing Coupling', all: ['reducing', 'coupling'] },
    { name: 'Elbow 90°', all: ['elbow', '90'] },
    { name: 'Elbow 45°', all: ['elbow', '45'] },
    { name: 'Bend', all: ['bend'] },
    { name: 'Equal Tee', all: ['tee'], not: ['reducing'] },
    { name: 'Reducing Tee', all: ['reducing', 'tee'] },
    { name: 'Reducer', all: ['reducer'] },
    { name: 'Union', all: ['union'] },
    { name: 'Male Adaptor', all: ['male'] },
    { name: 'Female Adaptor', all: ['female'] },
    { name: 'End Cap', all: ['cap'] },
    { name: 'Ball Valve', all: ['ball', 'valve'] },
    { name: 'Flange', all: ['flange'] },
    { name: 'Wall Plate', all: ['wall', 'plate'] },
    { name: 'Tube', all: ['tube'] },
    { name: 'Bracket / Clamp', any: ['bracket', 'clamp', 'clip'] },
  ];

  function catFamilyOf(it) {
    // whole-word matching — 'tee' must not match inside 'steel'; numeric
    // terms match by prefix so '90' finds '90deg'
    const words = (it.desc + ' ' + it.pn).toLowerCase().split(/[^a-z0-9.]+/);
    const has = w => (/^\d/.test(w) ? words.some(x => x.startsWith(w)) : words.includes(w));
    for (let i = 0; i < CAT_FAMILIES.length; i++) {
      const f = CAT_FAMILIES[i];
      if (f.all && !f.all.every(has)) continue;
      if (f.any && !f.any.some(has)) continue;
      if (f.not && f.not.some(has)) continue;
      return i;
    }
    return -1;
  }

  function catSizesOf(it) {
    const out = [];
    const re = /(\d+(?:\.\d+)?)\s*mm/gi;
    let m;
    while ((m = re.exec(it.desc)) && out.length < 3) out.push(parseFloat(m[1]));
    return out;
  }

  // Thread/inch fragment — what separates a 15mm × ½" adaptor from the ¾"
  // one. Handles 1/2", 3/4", 1", 1 1/2" and unicode fractions.
  function catInchOf(it) {
    const d = it.desc.replace(/½/g, '1/2').replace(/¾/g, '3/4').replace(/¼/g, '1/4');
    const m = d.match(/(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:\.\d+)?)\s*(?:"|”|''|inch\b|in\b)/i);
    return m ? m[1].replace(/\s*\/\s*/, '/').replace(/\s+/g, ' ').trim() + '"' : '';
  }

  function inchValue(label) {
    const m = label.match(/^(?:(\d+)\s+)?(\d+)(?:\/(\d+))?/);
    if (!m) return 0;
    return (parseFloat(m[1]) || 0) + (m[3] ? parseFloat(m[2]) / parseFloat(m[3]) : parseFloat(m[2]) || 0);
  }

  function catLabelOf(it) {
    const sizes = catSizesOf(it);
    const inch = catInchOf(it);
    let label = sizes.map(s => qty(s)).join('×');
    if (inch) label = label ? label + '×' + inch : inch;
    return label || it.pn || '—';
  }

  function catCmp(a, b) {
    const sa = catSizesOf(a), sb = catSizesOf(b);
    return (sa[0] || 9999) - (sb[0] || 9999) || (sa[1] || 0) - (sb[1] || 0)
      || inchValue(catInchOf(a)) - inchValue(catInchOf(b)) || a.desc.localeCompare(b.desc);
  }

  // Group + order items the way the printed catalogue does — family rows,
  // sizes ascending within each row. Shared by the stocktake layout and the
  // used-parts logger.
  function catGroups(items) {
    const groups = new Map(); // familyIndex -> items
    for (const it of items) {
      const fi = catFamilyOf(it);
      if (!groups.has(fi)) groups.set(fi, []);
      groups.get(fi).push(it);
    }
    const order = [...groups.keys()].sort((a, b) => (a === -1 ? 999 : a) - (b === -1 ? 999 : b));
    return order.map(fi => ({
      name: fi === -1 ? 'Other' : CAT_FAMILIES[fi].name,
      list: groups.get(fi).sort(catCmp),
    }));
  }

  // Primary grouping = the item's AroFlo category (the org's own taxonomy,
  // shown with its parent category), with the family/size rows nested inside
  // each section — press fittings still read like the printed catalogue,
  // while brackets and accessories sit in their own sections instead of
  // polluting the fitting rows.
  function catSections(items) {
    const byCat = new Map();
    for (const it of items) {
      const c = it.cat || 'Uncategorised';
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(it);
    }
    const names = [...byCat.keys()].sort((a, b) =>
      (a === 'Uncategorised') - (b === 'Uncategorised') || a.localeCompare(b));
    return names.map(cat => ({ cat, groups: catGroups(byCat.get(cat)) }));
  }

  function catSectionsHtml(items, cellFn) {
    let h = '';
    for (const s of catSections(items)) {
      const parent = catParent[s.cat];
      h += `<div class="cat-cat">${parent ? `<span class="cat-parent">${esc(parent)} · </span>` : ''}${esc(s.cat)}</div>`;
      for (const g of s.groups) {
        // a section whose only group is unparsed items needs no family row
        const showHead = !(s.groups.length === 1 && g.name === 'Other');
        h += `<div class="cat-group">${showHead ? `<div class="cat-head">${esc(g.name)}</div>` : ''}<div class="cat-cells">`;
        for (const it of g.list) h += cellFn(it);
        h += `</div></div>`;
      }
    }
    return h;
  }

  function renderTakeCatalogue(el, items) {
    el.innerHTML = catSectionsHtml(items, it => {
      const have = qtyAt(it, st.take.name);
      const val = st.take.counts[it.id] != null ? st.take.counts[it.id] : '';
      const label = catLabelOf(it);
      return `<label class="cat-cell" title="${esc(it.desc)} — ${esc(it.pn)}">
        <span class="cat-size">${esc(label)}</span>
        ${it.pn && it.pn !== label ? `<span class="cat-pn">${esc(it.pn)}</span>` : ''}
        <span class="cat-have">has ${qty(have)}</span>
        <input class="aro-count" data-id="${esc(it.id)}" type="text" inputmode="decimal" placeholder="${qty(have)}" value="${esc(val)}" autocomplete="off">
      </label>`;
    });
    wireCountInputs(el);
  }

  function aroLevelsHtml(it) {
    const levels = (it.levels || []).filter(l => l.to);
    // per-holder minimum editor, when a holder is filtered
    const minRow = st.holder
      ? `<div class="aro-level"><span class="muted">Minimum at ${esc(st.holder)}</span>
          <input class="aro-min" data-id="${esc(it.id)}" type="text" inputmode="decimal" placeholder="—" value="${parOf(st.holder, it.id) != null ? qty(parOf(st.holder, it.id)) : ''}"></div>`
      : '';
    if (!levels.length) return `<div class="aro-levels"><span class="muted">No stock locations recorded.</span>${minRow}</div>`;
    return `<div class="aro-levels">${minRow}${levels.map((l, i) =>
      `<div class="aro-level"><span>${esc(l.to)} <span class="muted">(${esc(holderKind(l.type))})</span></span>
        <span class="aro-level-r"><b>${qty(l.qty)}</b>${l.id ? ` <button class="mini-btn aro-move" data-item="${esc(it.id)}" data-level="${i}" title="Move stock from ${esc(l.to)} to another holder">⇄</button>` : ''}</span>
      </div>`).join('')}
    </div>`;
  }

  /* ---------------- task-linked area zones ---------------- */

  const jobCache = {}; // job -> { task, materials, at }

  async function jobMaterials(job) {
    const c = jobCache[job];
    if (c && Date.now() - c.at < 10 * 60 * 1000) return c;
    const rt = await call('task', { jobnumber: job });
    const task = (rt.tasks || [])[0] || null;
    let materials = [];
    if (task) {
      const rm = await call('taskmaterials', { taskid: task.taskid });
      materials = rm.materials || [];
    }
    const out = { task, materials, at: Date.now() };
    jobCache[job] = out;
    return out;
  }

  // Every task of the drawing's AroFlo project, for the zone link picker.
  async function getProjectTasks() {
    if (st.tm.pTasks.length) return st.tm.pTasks;
    const projNo = String((State.S.aroSite && State.S.aroSite.project) || '').replace(/\D+/g, '');
    if (!projNo) return [];
    if (!projCache) {
      const all = [];
      for (let page = 1; page <= 4; page++) {
        const r = await call('projects', { page });
        all.push(...(r.projects || []));
        if (r.last) break;
      }
      projCache = all;
    }
    const p = projCache.find(x => x.number === projNo);
    if (!p) return [];
    const rt = await call('projecttasks', { projectid: p.id, clientid: p.clientId || '', name: p.name });
    st.tm.pTasks = rt.tasks || [];
    st.tm.pId = p.id; st.tm.pName = p.name;
    return st.tm.pTasks;
  }

  // Name a zone and tick the AroFlo tasks that live inside it.
  function zoneLinkDialog(m) {
    App.modal(`
      <h3>Area zone</h3>
      <div class="form-row"><label>Area name</label>
        <input type="text" id="zn-label" value="${esc(m.label || '')}" placeholder="e.g. Compressor room" autocomplete="off"></div>
      <div class="form-row"><label>Linked AroFlo tasks</label>
        <div id="zn-tasks" class="aro-cats-list" style="display:block"><span class="muted">Loading the project's tasks…</span></div></div>
      <div class="form-row"><label>Other job numbers (comma separated)</label>
        <input type="text" id="zn-extra" placeholder="e.g. 11301, 11305" autocomplete="off"></div>
      <div class="modal-actions">
        <button class="mini-btn" id="zn-cancel">Cancel</button>
        <button class="mini-btn primary" id="zn-save">Save</button>
      </div>`, (box, close) => {
      const listEl = box.querySelector('#zn-tasks');
      const current = new Set((m.jobs || []).map(String));
      getProjectTasks().then(tasks => {
        if (!tasks.length) {
          listEl.innerHTML = `<span class="muted">No project loaded — load the AroFlo project in the stock manager once (or set the job ref), or just type job numbers below.</span>`;
          box.querySelector('#zn-extra').value = [...current].join(', ');
          return;
        }
        listEl.innerHTML = tasks.map(t =>
          `<label class="chk"><input type="checkbox" value="${esc(t.job)}"${current.has(String(t.job)) ? ' checked' : ''}> #${esc(t.job)} ${esc(t.name)} <span class="muted">(${esc(t.status)})</span></label>`).join('');
        const known = new Set(tasks.map(t => String(t.job)));
        box.querySelector('#zn-extra').value = [...current].filter(j => !known.has(j)).join(', ');
      }).catch(() => {
        listEl.innerHTML = `<span class="muted">Couldn't reach AroFlo — type job numbers below instead.</span>`;
        box.querySelector('#zn-extra').value = [...current].join(', ');
      });
      box.querySelector('#zn-cancel').addEventListener('click', close);
      box.querySelector('#zn-save').addEventListener('click', () => {
        const ticked = [...listEl.querySelectorAll('input:checked')].map(i => i.value);
        const extra = box.querySelector('#zn-extra').value.split(/[,\s]+/).map(s => s.replace(/\D+/g, '')).filter(Boolean);
        m.jobs = [...new Set([...ticked, ...extra])];
        m.label = box.querySelector('#zn-label').value.trim();
        if (m.label) m.subject = m.label;
        State.touch();
        State.emit('markups', { changed: [m.id] });
        close();
      });
    });
  }

  // Tap popover: the zone's jobs, their status and the materials used so far.
  let popEl = null;

  function closeZonePopover() {
    if (popEl) { popEl.remove(); popEl = null; }
  }

  function zonePopover(m) {
    closeZonePopover();
    popEl = document.createElement('div');
    popEl.id = 'zonePop';
    const jobs = (m.jobs || []);
    popEl.innerHTML = `
      <div class="zp-head"><b>${esc(m.label || m.subject || 'Area zone')}</b>
        <span style="flex:1"></span>
        <button class="mini-btn" id="zp-edit" title="Change the linked tasks">Links</button>
        <button class="mini-btn" id="zp-close">✕</button></div>
      <div class="zp-body">${jobs.length
        ? jobs.map(j => {
          const d = draftLines(String(j));
          return `<div class="zp-job" data-job="${esc(j)}">
            <div class="zp-jobhead"><span class="zp-jobname">#${esc(j)}</span>
              <button class="mini-btn zp-log${d ? ' primary' : ''}" data-job="${esc(j)}" title="Tap-count the parts used in this area and book them to the task">${d ? 'Draft · ' + d + ' — save…' : '+ Log parts'}</button></div>
            <div class="zp-mats muted">Loading…</div></div>`;
        }).join('')
        : '<p class="prop-note">No tasks linked yet — hit Links to pick them.</p>'}</div>`;
    document.body.appendChild(popEl);

    // sit beside the zone, clamped to the window
    const ov = document.getElementById('overlay');
    const or = ov ? ov.getBoundingClientRect() : { left: 60, top: 60 };
    const z = State.S.zoom || 1;
    let px = or.left + (m.x + m.w) * z + 10;
    let py = or.top + m.y * z;
    const W = 340, H = Math.min(430, window.innerHeight - 40);
    if (px + W > window.innerWidth - 8) px = Math.max(8, or.left + m.x * z - W - 10);
    py = Math.min(Math.max(8, py), window.innerHeight - H - 8);
    popEl.style.left = px + 'px';
    popEl.style.top = py + 'px';

    popEl.querySelector('#zp-close').addEventListener('click', closeZonePopover);
    popEl.querySelector('#zp-edit').addEventListener('click', () => { closeZonePopover(); zoneLinkDialog(m); });
    popEl.querySelectorAll('.zp-log').forEach(b =>
      b.addEventListener('click', () => usedDialog(b.dataset.job, { zone: m })));

    for (const j of jobs) {
      const cell = popEl.querySelector(`.zp-job[data-job="${CSS.escape(String(j))}"] .zp-mats`);
      jobMaterials(String(j)).then(({ task, materials }) => {
        if (!popEl || !cell) return;
        const nameEl = popEl.querySelector(`.zp-job[data-job="${CSS.escape(String(j))}"] .zp-jobname`);
        if (nameEl && task) nameEl.innerHTML = `#${esc(task.job)} ${esc(task.name)} <span class="muted">(${esc(task.status)})</span>`;
        if (!task) { cell.textContent = 'No AroFlo task found for this job number.'; return; }
        if (!materials.length) { cell.innerHTML = '<span class="muted">No materials recorded yet.</span>'; return; }
        cell.classList.remove('muted');
        cell.innerHTML = `<table class="to-table">${materials.map(x =>
          `<tr><td title="${esc(x.pn)} · ${esc(x.date)}">${esc(x.item)}</td><td class="num">${qty(x.qty)}</td></tr>`).join('')}
          <tr class="total"><td>Lines</td><td class="num">${materials.length}</td></tr></table>`;
      }).catch(e => { if (cell) cell.textContent = 'Couldn’t load: ' + e.message; });
    }
  }

  /* ---------------- log used parts to a task ---------------- */

  const saveDrafts = () => saveJson('abmt:used', usedDrafts);
  const draftLines = job =>
    Object.values((usedDrafts[job] || {}).counts || {}).filter(q => q > 0).length;

  function categoriesInStock() {
    const seen = new Set();
    for (const it of st.items) if (!it.stub && it.cat) seen.add(it.cat);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }

  // Tap-to-count logger: catalogue-layout tiles filtered by the job's
  // material-system preset (e.g. “Stainless Impress” = the Impress
  // categories). The tally persists per job until it's saved, so a dropped
  // signal or a closed tab never loses the count.
  async function usedDialog(job, opts = {}) {
    job = String(job);
    closeZonePopover();
    if (!st.items.length) { App.toast('Load the stock list first — open the stock manager and hit ⟳.', 'warn'); return; }
    let task = opts.task || null;
    if (!task) {
      try { task = (await jobMaterials(job)).task; }
      catch (e) { App.toast('Couldn’t look up job ' + job + ': ' + e.message, 'error'); return; }
    }
    if (!task) { App.toast('No AroFlo task found for job ' + job + '.', 'error'); return; }
    if (!usedDrafts[job]) usedDrafts[job] = { counts: {}, sys: jobSys[job] || '' };
    const draft = usedDrafts[job];
    if (jobSys[job] && !draft.sys) draft.sys = jobSys[job];

    App.modal(`
      <h3>Log parts used — #${esc(task.job)} ${esc(task.name)}</h3>
      <div class="aro-bar">
        <select id="us-sys" title="Material system — narrows the tiles to that system's categories">
          <option value="">All synced items</option>
          ${sysPresets.map(p => `<option value="${esc(p.id)}"${draft.sys === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <button class="mini-btn" id="us-newsys" title="Create a material-system preset (e.g. Stainless Impress)">New…</button>
      </div>
      <div class="aro-bar"><input type="text" id="us-q" placeholder="Search… (e.g. elbow 54)" autocomplete="off"></div>
      <p class="muted">Tap a tile once per part used — the − corner takes one back. Quantities can still be edited at the review step.</p>
      <div id="us-grid" class="used-grid"></div>
      <div class="used-bar">
        <span class="muted" id="us-tot"></span>
        <span style="flex:1"></span>
        <button class="mini-btn" id="us-clear" title="Wipe this job's unsent tally">Clear</button>
        <button class="mini-btn" id="us-close">Close</button>
        <button class="mini-btn primary" id="us-review">Review &amp; save…</button>
      </div>`, (box, close) => {
      const grid = box.querySelector('#us-grid');
      const qEl = box.querySelector('#us-q');
      const totEl = box.querySelector('#us-tot');

      const pool = () => {
        const p = sysPresets.find(x => x.id === draft.sys);
        const cats = p ? new Set(p.cats) : null;
        const terms = qEl.value.toLowerCase().split(/\s+/).filter(Boolean);
        return st.items.filter(it => !it.stub
          && (!cats || cats.has(it.cat))
          && (!terms.length || terms.every(t => (it.desc + ' ' + it.pn + ' ' + it.cat).toLowerCase().includes(t))));
      };
      const tally = () => {
        const lines = Object.values(draft.counts).filter(q => q > 0);
        const parts = lines.reduce((a, q) => a + q, 0);
        totEl.textContent = lines.length
          ? qty(parts) + ' part' + (parts === 1 ? '' : 's') + ' · ' + lines.length + ' line' + (lines.length === 1 ? '' : 's')
          : 'Nothing tallied yet';
        box.querySelector('#us-review').disabled = !lines.length;
      };
      const draw = () => {
        const items = pool();
        const sc = grid.scrollTop;
        if (!items.length) {
          grid.innerHTML = '<p class="prop-note">Nothing matches — clear the search or widen the system preset.</p>';
          tally();
          return;
        }
        let h = catSectionsHtml(items.slice(0, 600), it => {
          const n = draft.counts[it.id] || 0;
          const label = catLabelOf(it);
          return `<button type="button" class="cat-cell used-cell${n ? ' sel' : ''}" data-id="${esc(it.id)}" title="${esc(it.desc)} — ${esc(it.pn)}">
            <span class="cat-size">${esc(label)}</span>
            ${it.pn && it.pn !== label ? `<span class="cat-pn">${esc(it.pn)}</span>` : ''}
            ${n ? `<span class="used-n">${qty(n)}</span><span class="used-minus" data-id="${esc(it.id)}">−</span>` : ''}
          </button>`;
        });
        if (items.length > 600) h += `<p class="prop-note">…and ${items.length - 600} more — search, or pick a system preset.</p>`;
        grid.innerHTML = h;
        grid.scrollTop = sc;
        grid.querySelectorAll('.used-cell').forEach(cell => cell.addEventListener('click', e => {
          const id = cell.dataset.id;
          const minus = e.target.classList && e.target.classList.contains('used-minus');
          const cur = draft.counts[id] || 0;
          if (minus) { if (cur <= 1) delete draft.counts[id]; else draft.counts[id] = cur - 1; }
          else draft.counts[id] = cur + 1;
          draft.at = Date.now();
          saveDrafts();
          draw();
        }));
        tally();
      };
      let deb = 0;
      qEl.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(draw, 120); });
      box.querySelector('#us-sys').addEventListener('change', e => {
        draft.sys = e.target.value;
        jobSys[job] = draft.sys;
        saveJson('abmt:jobsys', jobSys);
        saveDrafts();
        draw();
      });
      box.querySelector('#us-newsys').addEventListener('click', () => { close(); newSystemDialog(job, opts); });
      box.querySelector('#us-clear').addEventListener('click', () => { draft.counts = {}; saveDrafts(); draw(); });
      box.querySelector('#us-close').addEventListener('click', () => {
        close();
        if (opts.zone) zonePopover(opts.zone);
      });
      box.querySelector('#us-review').addEventListener('click', () => { close(); usedReview(job, task, opts); });
      draw();
    });
  }

  function newSystemDialog(job, opts) {
    const cats = categoriesInStock();
    App.modal(`
      <h3>New material system</h3>
      <p class="muted">Name the system and tick the AroFlo categories it draws from — e.g. “Stainless Impress” with the Impress categories ticked. Each job remembers the system you pick for it.</p>
      <div class="form-row"><label>Name</label>
        <input type="text" id="ns-name" placeholder="e.g. Stainless Impress" autocomplete="off"></div>
      <div class="form-row"><label>Categories</label>
        <div class="aro-cats-list" style="display:block">${cats.length
          ? cats.map(c => `<label class="chk"><input type="checkbox" value="${esc(c)}"> ${esc(c)}</label>`).join('')
          : '<span class="muted">No categories in the synced stock list yet — hit ⟳ first.</span>'}</div></div>
      <div class="modal-actions">
        <button class="mini-btn" id="ns-cancel">Cancel</button>
        <button class="mini-btn primary" id="ns-save">Save</button>
      </div>`, (box, close) => {
      box.querySelector('#ns-cancel').addEventListener('click', () => { close(); usedDialog(job, opts); });
      box.querySelector('#ns-save').addEventListener('click', () => {
        const name = box.querySelector('#ns-name').value.trim();
        const ticked = [...box.querySelectorAll('.aro-cats-list input:checked')].map(i => i.value);
        if (!name) { App.toast('Give the system a name.', 'warn'); return; }
        if (!ticked.length) { App.toast('Tick at least one category.', 'warn'); return; }
        const p = { id: 'sys' + Date.now().toString(36), name, cats: ticked };
        sysPresets.push(p);
        saveJson('abmt:syspresets', sysPresets);
        jobSys[job] = p.id;
        saveJson('abmt:jobsys', jobSys);
        if (usedDrafts[job]) { usedDrafts[job].sys = p.id; saveDrafts(); }
        close();
        usedDialog(job, opts);
      });
    });
  }

  function usedReview(job, task, opts) {
    const draft = usedDrafts[job] || { counts: {} };
    const lines = Object.entries(draft.counts)
      .map(([id, q]) => ({ it: st.items.find(i => i.id === id), q }))
      .filter(l => l.it && l.q > 0)
      .sort((a, b) => {
        const fa = catFamilyOf(a.it), fb = catFamilyOf(b.it);
        return (fa === -1 ? 999 : fa) - (fb === -1 ? 999 : fb) || catCmp(a.it, b.it);
      });
    if (!lines.length) { usedDialog(job, opts); return; }
    const holdersW = st.allHolders.filter(h => h.id);
    const defFrom = (State.S.aroSite && State.S.aroSite.holder) || st.holder || (holdersW[0] || {}).name || '';
    const deductDef = loadJson('abmt:useddeduct', true);
    const rows = lines.map(l => `<tr>
      <td>${esc(l.it.desc)}<div class="aro-sub">${esc(l.it.pn)}</div></td>
      <td class="num"><input class="aro-count ur-qty" data-id="${esc(l.it.id)}" type="text" inputmode="decimal" value="${qty(l.q)}" autocomplete="off"></td>
      <td><button class="mini-btn ur-x" data-id="${esc(l.it.id)}" title="Remove this line">✕</button></td>
    </tr>`).join('');
    App.modal(`
      <h3>Save to AroFlo — #${esc(task.job)} ${esc(task.name)}</h3>
      <div style="max-height:38vh;overflow:auto"><table class="to-table">
        <tr><th>Part</th><th style="text-align:right">Qty</th><th></th></tr>${rows}
      </table></div>
      <div class="form-row" style="margin-top:10px"><label>Taken from (stock holder)</label>
        <select id="ur-from">${holdersW.map(h => `<option value="${esc(h.name)}"${h.name === defFrom ? ' selected' : ''}>${esc(h.name)} — ${esc(holderKind(h.type))}</option>`).join('')}</select></div>
      <label class="chk"><input type="checkbox" id="ur-deduct"${deductDef ? ' checked' : ''}> Also deduct these quantities from the holder's site stock</label>
      <p class="muted">The lines land in the task's <b>Used Items</b> in AroFlo, dated today. AroFlo doesn't move inventory for API-booked lines by itself, so leave the deduction on to keep the site holder's counts true — if your AroFlo shows a double deduction after the first save, untick it from then on.</p>
      <div class="aro-error" id="ur-err" hidden></div>
      <div class="modal-actions">
        <button class="mini-btn" id="ur-back">Back</button>
        <button class="mini-btn primary" id="ur-save">Save ${lines.length} line${lines.length === 1 ? '' : 's'} to task</button>
      </div>`, (box, close) => {
      box.querySelectorAll('.ur-qty').forEach(inp => inp.addEventListener('change', () => {
        const v = parseFloat(String(inp.value).replace(',', '.'));
        if (Number.isFinite(v) && v > 0) draft.counts[inp.dataset.id] = v;
        else delete draft.counts[inp.dataset.id];
        saveDrafts();
        close(); usedReview(job, task, opts);
      }));
      box.querySelectorAll('.ur-x').forEach(b => b.addEventListener('click', () => {
        delete draft.counts[b.dataset.id];
        saveDrafts();
        close(); usedReview(job, task, opts);
      }));
      box.querySelector('#ur-back').addEventListener('click', () => { close(); usedDialog(job, opts); });
      box.querySelector('#ur-save').addEventListener('click', async () => {
        const from = holdersW.find(h => h.name === box.querySelector('#ur-from').value) || null;
        const deduct = box.querySelector('#ur-deduct').checked;
        saveJson('abmt:useddeduct', deduct);
        const btn = box.querySelector('#ur-save');
        const errBox = box.querySelector('#ur-err');
        errBox.hidden = true;
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
          // AroFlo refuses lines without a cost — items synced before
          // pricing was carried get their figures pulled here, so a stale
          // cache never blocks a save (worst case a line books at $0,
          // editable in AroFlo afterwards)
          for (const l of lines) {
            // 0 counts as unknown too — a cached zero (pre-flexcost syncs)
            // must not stop the real figure being pulled
            if (l.it.cost) continue;
            btn.textContent = 'Fetching prices…';
            try {
              const r = await call('inventory', { itemid: l.it.id });
              const fresh = (r.items || [])[0];
              if (fresh) { l.it.cost = fresh.cost; l.it.sell = fresh.sell; }
            } catch (e2) { /* still saves — at zero cost */ }
          }
          saveCache();
          btn.textContent = 'Saving…';
          const payload = { taskid: task.taskid, lines: lines.map(l => ({ pn: l.it.pn, desc: l.it.desc, qty: l.q, cost: l.it.cost, sell: l.it.sell })) };
          if (from && (from.type === 'user' || from.type === 'cholder')) payload.takenfrom = { id: from.id, type: from.type };
          const beforeN = jobCache[job] ? jobCache[job].materials.length : null;

          // AroFlo can answer "Login OK" yet insert nothing — the proxy
          // counts the real inserts (trying AroFlo's own recorded payload
          // shape as a fallback) and hands back the line errors.
          let inserted = 0, usedFallback = false, postDebug = '';
          const postErrs = new Set();
          for (let i = 0; i < payload.lines.length; i += 50) {
            const r = await postCall('usedmaterials', { ...payload, lines: payload.lines.slice(i, i + 50) });
            if (Array.isArray(r.postErrors)) for (const e of r.postErrors) postErrs.add(e);
            if (r.takenfromDropped) usedFallback = true;
            if (r.postDebug) postDebug = r.postDebug;
            inserted += r.inserted || 0;
          }
          if (inserted < payload.lines.length) {
            const detail = postErrs.size
              ? ' AroFlo said: ' + [...postErrs].join(' · ')
              : ' AroFlo reported no line errors — check the task isn’t completed/locked in AroFlo.';
            const err = new Error('AroFlo inserted ' + inserted + ' of ' + payload.lines.length + ' line' + (payload.lines.length === 1 ? '' : 's') + '.' + detail);
            err.debug = postDebug;
            throw err;
          }

          // read the task back — an insert AroFlo accepted but stored badly
          // (e.g. an unparsed date) would not show on the task's list
          let verified = true;
          try {
            delete jobCache[job];
            const after = await jobMaterials(job);
            if (beforeN != null && after.materials.length < beforeN + payload.lines.length) verified = false;
          } catch (e2) { /* re-read is best-effort — the insert itself was confirmed */ }

          if (deduct && from) {
            const moves = lines.map(l => ({ itemid: l.it.id, toId: from.id, toType: from.type, delta: -l.q }));
            for (let i = 0; i < moves.length; i += 50) await postCall('adjuststock', { moves: moves.slice(i, i + 50) });
            applyLocalMoves(moves);
          }
          delete usedDrafts[job];
          saveDrafts();
          close();
          let note = `Booked ${lines.length} line${lines.length === 1 ? '' : 's'} to #${task.job}${deduct && from ? ' and deducted from ' + from.name : ''}. ✔`;
          if (usedFallback) note += ' AroFlo rejected the taken-from holder, so the lines were booked without it.';
          if (!verified) note += ' AroFlo confirmed the insert but the task list doesn’t show the new lines yet — open the task worksheet in AroFlo to check before re-sending, so nothing doubles up.';
          App.toast(note, verified ? 'good' : 'warn', verified ? 6000 : 12000);
          if (st.tm.taskid === task.taskid) loadMaterialsFor(task.taskid);
          else render();
          if (opts.zone) zonePopover(opts.zone);
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Save to task';
          errBox.textContent = e.message + ' Nothing was deducted from stock and the tally is kept.';
          if (e.debug) {
            const pre = document.createElement('pre');
            pre.className = 'ur-debug';
            pre.textContent = 'AroFlo’s full reply (for support): ' + e.debug;
            errBox.appendChild(pre);
          }
          errBox.hidden = false;
          App.toast('Save failed — details in the review sheet. The tally is kept.', 'error', 7000);
        }
      });
    });
  }

  /* ---------------- barcode / QR scanning ---------------- */

  let scanReader = null;

  function stopScan() {
    try { if (scanReader) scanReader.reset(); } catch (e) { /* ignore */ }
    scanReader = null;
  }

  function openScanner() {
    if (typeof ZXing === 'undefined') { App.toast('Scanner library not loaded.', 'err'); return; }
    App.modal(`
      <h3>Scan a label</h3>
      <div class="scan-wrap"><video id="scan-video" playsinline muted autoplay></video></div>
      <p class="muted" id="scan-msg">Point the camera at a barcode or QR label.</p>
      <div class="modal-actions"><button class="mini-btn" id="scan-cancel">Cancel</button></div>`,
      async (box, close) => {
        box.querySelector('#scan-cancel').addEventListener('click', () => { stopScan(); close(); });
        try {
          scanReader = new ZXing.BrowserMultiFormatReader();
          await scanReader.decodeFromVideoDevice(undefined, box.querySelector('#scan-video'), result => {
            if (!result) return;
            const text = result.getText();
            stopScan(); close();
            if (navigator.vibrate) navigator.vibrate(80);
            onScan(text);
          });
        } catch (e) {
          const msg = box.querySelector('#scan-msg');
          if (msg) msg.textContent = 'Camera unavailable (' + (e.message || e.name) + ') — scanning needs HTTPS and camera permission.';
        }
      });
  }

  // A scanned code resolves via the learned link table first, then by exact
  // part number, then by a code that contains a part number (supplier labels
  // often wrap the part number in a longer string).
  function resolveScan(code) {
    const c = String(code || '').trim();
    if (!c) return null;
    const linked = codeMap[c] && st.items.find(i => i.id === codeMap[c]);
    if (linked) return linked;
    const lower = c.toLowerCase();
    return st.items.find(i => i.pn && i.pn.toLowerCase() === lower)
      || st.items.find(i => i.pn && i.pn.length >= 4 && lower.includes(i.pn.toLowerCase()))
      || null;
  }

  function onScan(code) {
    const it = resolveScan(code);
    if (it) { focusItem(it); return; }
    itemPickerDialog(
      'Link this label',
      `“${esc(String(code).slice(0, 60))}” isn't linked to an item yet — pick the item it belongs to. The link is remembered on this device.`,
      it2 => {
        codeMap[String(code).trim()] = it2.id;
        saveJson('abmt:barcodes', codeMap);
        focusItem(it2);
      });
  }

  function focusItem(it) {
    st.filter = it.pn || it.desc;
    const inp = mainEl && mainEl.querySelector('#aro-search');
    if (inp) inp.value = st.filter;
    if (!st.take.on) st.expanded = it.id;
    renderList(); renderStatus();
    if (st.take.on) {
      const cnt = mainEl && mainEl.querySelector(`.aro-count[data-id="${CSS.escape(it.id)}"]`);
      if (cnt) { cnt.focus(); cnt.select(); }
    }
    App.toast('Scanned: ' + it.desc, 'ok', 2500);
  }

  // Printable QR label sheet for the current filter/holder view.
  function printLabels() {
    if (typeof ZXing === 'undefined') { App.toast('Scanner library not loaded.', 'err'); return; }
    const rows = (st.take.on ? st.items.filter(i => !i.stub) : filteredItems().map(r => r.it)).slice(0, 120);
    if (!rows.length) { App.toast('Nothing in the list to label.', 'warn'); return; }
    const writer = new ZXing.BrowserQRCodeSvgWriter();
    const cells = rows.map(it => {
      const el = writer.write(it.pn || it.id, 110, 110);
      const svg = new XMLSerializer().serializeToString(el);
      return `<div class="lbl"><div class="lbl-qr">${svg}</div><div class="lbl-txt"><b>${esc(it.pn)}</b><br>${esc(it.desc)}</div></div>`;
    }).join('');
    const w = window.open('', '_blank');
    if (!w) { App.toast('Pop-up blocked — allow pop-ups to print labels.', 'warn'); return; }
    w.document.write(`<!doctype html><title>AirMark labels</title><style>
      body{font-family:system-ui,sans-serif;margin:8mm}
      .sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}
      .lbl{display:flex;gap:3mm;align-items:center;border:1px dashed #bbb;padding:3mm;break-inside:avoid}
      .lbl-qr svg{width:22mm;height:22mm}
      .lbl-txt{font-size:9pt;line-height:1.25}
      @media print{.lbl{border-color:#eee}}
    </style><div class="sheet">${cells}</div><script>setTimeout(()=>print(),300)</${'script'}>`);
    w.document.close();
  }

  /* ---------------- generic item picker ---------------- */

  function itemPickerDialog(title, note, onPick) {
    App.modal(`
      <h3>${esc(title)}</h3>
      <p class="muted">${note}</p>
      <div class="form-row"><input type="text" id="pick-q" placeholder="Search items…" autocomplete="off"></div>
      <div id="pick-list" style="max-height:44vh;overflow:auto"></div>
      <div class="modal-actions"><button class="mini-btn" id="pick-cancel">Cancel</button></div>`,
      (box, close) => {
        const listEl = box.querySelector('#pick-list');
        const qEl = box.querySelector('#pick-q');
        const draw = () => {
          const terms = qEl.value.toLowerCase().split(/\s+/).filter(Boolean);
          const hits = st.items.filter(i => !i.stub &&
            (!terms.length || terms.every(t => (i.desc + ' ' + i.pn + ' ' + i.cat).toLowerCase().includes(t)))).slice(0, 30);
          listEl.innerHTML = hits.map(i =>
            `<div class="aro-item" data-id="${esc(i.id)}"><div class="aro-row"><div class="aro-main">
              <div class="aro-desc">${esc(i.desc)}</div><div class="aro-sub">${esc(i.pn)}</div>
            </div></div></div>`).join('') || '<p class="prop-note">No matches.</p>';
          listEl.querySelectorAll('.aro-item').forEach(div =>
            div.addEventListener('click', () => {
              const it = st.items.find(x => x.id === div.dataset.id);
              close();
              if (it) onPick(it);
            }));
        };
        qEl.addEventListener('input', draw);
        qEl.focus();
        draw();
        box.querySelector('#pick-cancel').addEventListener('click', close);
      });
  }

  /* ---------------- minimum levels + reorder list ---------------- */

  const parOf = (holder, id) => {
    const v = pars[holder] && pars[holder][id];
    return Number.isFinite(v) ? v : null;
  };

  function setPar(holder, id, min) {
    if (!pars[holder]) pars[holder] = {};
    if (min == null || !Number.isFinite(min) || min <= 0) delete pars[holder][id];
    else pars[holder][id] = min;
    saveJson('abmt:pars', pars);
  }

  function lowRows() {
    if (!st.holder) return [];
    const out = [];
    for (const it of st.items) {
      if (it.stub) continue;
      const min = parOf(st.holder, it.id);
      if (min == null) continue;
      const have = qtyAt(it, st.holder);
      if (have < min) out.push({ it, have, min, order: Math.round((min - have) * 100) / 100 });
    }
    return out.sort((a, b) => a.it.desc.localeCompare(b.it.desc));
  }

  function reorderDialog() {
    if (!st.holder) { App.toast('Pick a location first — minimums are per holder.', 'warn'); return; }
    const rows = lowRows();
    const holder = st.holder;
    if (!rows.length) {
      App.toast('Nothing below its minimum at ' + holder + '. Set minimums in an item’s expanded row.', 'info', 6000);
      return;
    }
    const body = rows.map(r => `<tr><td>${esc(r.it.desc)}<div class="aro-sub">${esc(r.it.pn)}</div></td>
      <td class="num">${qty(r.have)}</td><td class="num">${qty(r.min)}</td>
      <td class="num" style="font-weight:700">${qty(r.order)}</td></tr>`).join('');
    App.modal(`
      <h3>Reorder list — ${esc(holder)}</h3>
      <div style="max-height:50vh;overflow:auto"><table class="to-table">
        <tr><th>Item</th><th style="text-align:right">Have</th><th style="text-align:right">Min</th><th style="text-align:right">Order</th></tr>${body}
      </table></div>
      <div class="modal-actions">
        <button class="mini-btn" id="ro-copy">Copy</button>
        <button class="mini-btn" id="ro-csv">Download CSV</button>
        <span style="flex:1"></span>
        <button class="mini-btn primary" id="ro-close">Done</button>
      </div>`, (box, close) => {
      const text = rows.map(r => `${r.order} x ${r.it.pn || r.it.desc} (have ${qty(r.have)}, min ${qty(r.min)})`).join('\n');
      box.querySelector('#ro-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(`Reorder — ${holder}\n` + text); App.toast('Copied.', 'ok'); } catch (e) { App.toast('Copy blocked by the browser.', 'warn'); }
      });
      box.querySelector('#ro-csv').addEventListener('click', () => {
        const csv = 'Item,Part number,Have,Min,Order\n' + rows.map(r =>
          `"${r.it.desc.replace(/"/g, '""')}","${r.it.pn}",${r.have},${r.min},${r.order}`).join('\n');
        App.download(new Blob([csv], { type: 'text/csv' }), 'reorder-' + holder.replace(/\W+/g, '-') + '.csv');
      });
      box.querySelector('#ro-close').addEventListener('click', close);
    });
  }

  /* ---------------- pick list from the drawing takeoff ---------------- */

  let pick = null; // active pick-list session {lines, source, dest, dayOnly}

  function fitTerms(f) {
    const stop = { equal: 1, 'm/f': 1, press: 1, '(press)': 1 };
    const words = f.name.toLowerCase().replace(/[°()]/g, ' ').split(/\s+/).filter(w => w && !stop[w]);
    return [...words, String(parseFloat(f.size) || f.size).replace('mm', '')];
  }

  function takeoffLines(dayOnly) {
    const to = MarkupList.computeTakeoff(dayOnly ? { day: State.S.workDay } : null);
    const lines = [];
    for (const f of to.fittings) {
      lines.push({ kind: 'fit', key: f.code + '|' + f.size, label: `${f.code} ${f.name} ${f.size}`, qty: f.count, terms: fitTerms(f) });
    }
    for (const p of to.pipes) {
      if (p.totalFt == null) continue;
      const m = p.totalFt * 0.3048;
      lines.push({
        kind: 'pipe', key: p.size + '|' + p.material,
        label: `${p.size} ${p.material} tube — ${m.toFixed(1)} m`,
        qty: Math.max(1, Math.ceil(m / 6)), qtyNote: '6 m lengths',
        terms: ['tube', String(parseFloat(p.size) || p.size).replace('mm', '')],
      });
    }
    return lines;
  }

  function matchItem(line) {
    const rememberedId = itemMap[line.kind + '|' + line.key];
    if (rememberedId) {
      const it = st.items.find(i => i.id === rememberedId);
      if (it) return { it, how: 'linked' };
    }
    const hits = st.items.filter(i => !i.stub &&
      line.terms.every(t => (i.desc + ' ' + i.pn).toLowerCase().includes(t)));
    if (hits.length === 1) return { it: hits[0], how: 'auto' };
    return { it: null, how: hits.length ? hits.length + ' matches' : 'no match' };
  }

  function pickCardHtml() {
    if (!State.S.pdf) return '';
    let h = `<div class="prop-cap aro-tm-cap" id="aro-pick-toggle">${st.pickOpen ? '▾' : '▸'} Pick list from takeoff</div>`;
    if (!st.pickOpen) return h;
    const all = takeoffLines(false), day = takeoffLines(true);
    if (!all.length) return h + `<p class="prop-note">Draw pipe runs and fittings on the sheet and they show up here as a pick list.</p>`;
    h += `<p class="prop-note">Turn the drawing's takeoff into a warehouse pick list, then push the picked stock onto the site holder in one move.</p>
      <div class="aro-bar"><label class="chk"><input type="checkbox" id="aro-pick-day"${st.pickDay ? ' checked' : ''}> Active day only (${esc(State.S.workDay)}, ${day.length} line${day.length === 1 ? '' : 's'})</label></div>
      <div class="aro-bar"><button class="mini-btn primary" id="aro-pick-build">Build pick list — ${(st.pickDay ? day : all).length} lines…</button></div>`;
    return h;
  }

  function wirePickCard() {
    const t = sideEl.querySelector('#aro-pick-toggle');
    if (t) t.addEventListener('click', () => { st.pickOpen = !st.pickOpen; render(); });
    const d = sideEl.querySelector('#aro-pick-day');
    if (d) d.addEventListener('change', e => { st.pickDay = e.target.checked; render(); });
    const b = sideEl.querySelector('#aro-pick-build');
    if (b) b.addEventListener('click', () => {
      const lines = takeoffLines(st.pickDay);
      if (!lines.length) { App.toast('Nothing in the takeoff for that scope.', 'warn'); return; }
      const withIds = st.allHolders.filter(h => h.id);
      pick = {
        lines: lines.map(l => ({ ...l, checked: true })),
        source: (pick && pick.source) || loadJson('abmt:picksource', null) || (withIds.find(h => h.type === 'org') || withIds[0] || {}).name || '',
        dest: (pick && pick.dest) || (State.S.aroSite && State.S.aroSite.holder) || st.holder || '',
      };
      pickListDialog();
    });
  }

  function pickListDialog() {
    if (!pick) return;
    const withIds = st.allHolders.filter(h => h.id);
    const holderOpts = sel => withIds.map(h => `<option value="${esc(h.name)}"${h.name === sel ? ' selected' : ''}>${esc(h.name)} — ${esc(holderKind(h.type))}</option>`).join('');
    const rows = pick.lines.map((l, i) => {
      const m = matchItem(l);
      l.item = m.it;
      const src = m.it && pick.source ? qty(qtyAt(m.it, pick.source)) : '—';
      return `<tr>
        <td><input type="checkbox" class="pk-chk" data-i="${i}"${l.checked ? ' checked' : ''}></td>
        <td>${esc(l.label)}${l.qtyNote ? `<div class="aro-sub">${esc(l.qtyNote)}</div>` : ''}</td>
        <td class="num">${qty(l.qty)}</td>
        <td>${m.it
          ? `${esc(m.it.desc)}<div class="aro-sub">${esc(m.it.pn)}${m.how === 'auto' ? ' · matched' : ''}</div>`
          : `<button class="mini-btn pk-link" data-i="${i}">Link… <span class="muted">(${esc(m.how)})</span></button>`}</td>
        <td class="num">${src}</td>
      </tr>`;
    }).join('');
    const ready = pick.lines.filter(l => l.checked && l.item).length;
    App.modal(`
      <h3>Pick list — ${pick.lines.length} lines</h3>
      <div class="aro-bar"><label style="flex:0 0 auto" class="muted">From</label><select id="pk-src">${holderOpts(pick.source)}</select>
        <label style="flex:0 0 auto" class="muted">to</label><select id="pk-dst">${holderOpts(pick.dest)}</select></div>
      <div style="max-height:46vh;overflow:auto"><table class="to-table">
        <tr><th></th><th>Needed</th><th style="text-align:right">Qty</th><th>AroFlo item</th><th style="text-align:right">At source</th></tr>${rows}
      </table></div>
      <p class="muted">Ticked lines with a linked item are moved. Links are remembered for next time.</p>
      <div class="modal-actions">
        <button class="mini-btn" id="pk-copy">Copy list</button>
        <span style="flex:1"></span>
        <button class="mini-btn" id="pk-cancel">Close</button>
        <button class="mini-btn primary" id="pk-move"${ready ? '' : ' disabled'}>Move ${ready} line${ready === 1 ? '' : 's'} to site</button>
      </div>`, (box, close) => {
      box.querySelector('#pk-src').addEventListener('change', e => { pick.source = e.target.value; saveJson('abmt:picksource', pick.source); pickListDialog(); });
      box.querySelector('#pk-dst').addEventListener('change', e => { pick.dest = e.target.value; pickListDialog(); });
      box.querySelectorAll('.pk-chk').forEach(c => c.addEventListener('change', () => { pick.lines[+c.dataset.i].checked = c.checked; pickListDialog(); }));
      box.querySelectorAll('.pk-link').forEach(b => b.addEventListener('click', () => {
        const line = pick.lines[+b.dataset.i];
        itemPickerDialog('Link takeoff line', `Pick the AroFlo item for <b>${esc(line.label)}</b>.`, it => {
          itemMap[line.kind + '|' + line.key] = it.id;
          saveJson('abmt:itemmap', itemMap);
          pickListDialog();
        });
      }));
      box.querySelector('#pk-copy').addEventListener('click', async () => {
        const text = 'Pick list — ' + (State.S.jobRef || State.S.fileName) + '\n' +
          pick.lines.filter(l => l.checked).map(l => `${qty(l.qty)} x ${l.item ? (l.item.pn || l.item.desc) : l.label}${l.qtyNote ? ' (' + l.qtyNote + ')' : ''}`).join('\n');
        try { await navigator.clipboard.writeText(text); App.toast('Copied.', 'ok'); } catch (e) { App.toast('Copy blocked by the browser.', 'warn'); }
      });
      box.querySelector('#pk-cancel').addEventListener('click', close);
      box.querySelector('#pk-move').addEventListener('click', async () => {
        const srcH = withIds.find(h => h.name === pick.source);
        const dstH = withIds.find(h => h.name === pick.dest);
        if (!srcH || !dstH) { App.toast('Pick source and destination holders.', 'warn'); return; }
        if (srcH.name === dstH.name) { App.toast('Source and destination are the same holder.', 'warn'); return; }
        const moves = [];
        for (const l of pick.lines) {
          if (!l.checked || !l.item) continue;
          moves.push({ itemid: l.item.id, toId: srcH.id, toType: srcH.type, delta: -l.qty });
          moves.push({ itemid: l.item.id, toId: dstH.id, toType: dstH.type, delta: l.qty });
        }
        if (!moves.length) return;
        const btn = box.querySelector('#pk-move');
        btn.disabled = true; btn.textContent = 'Moving…';
        try {
          for (let i = 0; i < moves.length; i += 50) await postCall('adjuststock', { moves: moves.slice(i, i + 50) });
          applyLocalMoves(moves);
          close();
          App.toast(`Pick list moved — ${moves.length / 2} line${moves.length === 2 ? '' : 's'} → ${dstH.name}. ✔`, 'good', 5000);
          render();
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Move to site';
          App.toast('Move failed: ' + e.message, 'error', 9000);
        }
      });
    });
  }

  /* ---------------- Impress reference ---------------- */

  // The IBEX Impress 316L press range — every fitting family × tube size.
  // A tap searches the live stock for that family/size, so counting a shelf
  // means: find it here, tap, see the AroFlo figure, type the real count.
  const IMPRESS_SIZES = ['15', '22', '28', '35', '42', '54', '76.1', '88.9', '108', '139.7', '168.3'];

  function refCardHtml() {
    let h = `<div class="prop-cap aro-tm-cap" id="aro-ref-toggle">${st.refOpen ? '▾' : '▸'} Impress range reference</div>`;
    if (!st.refOpen) return h;
    h += `<p class="prop-note">Tap a size to search the stock list for that fitting. Sizes are tube OD (mm).</p>`;
    for (const f of Symbols.FITTINGS) {
      const term = f.name.toLowerCase().replace(/[°()]/g, ' ').replace(/\s+/g, ' ').trim();
      h += `<div class="ref-row"><div class="ref-name"><b>${esc(f.code)}</b> ${esc(f.name)}</div><div>` +
        IMPRESS_SIZES.map(s => `<button class="ref-chip" data-q="${esc(term + ' ' + s)}">${esc(s)}</button>`).join('') +
        `</div></div>`;
    }
    return h;
  }

  function wireRefCard() {
    const toggle = sideEl.querySelector('#aro-ref-toggle');
    if (toggle) toggle.addEventListener('click', () => { st.refOpen = !st.refOpen; render(); });
    sideEl.querySelectorAll('.ref-chip').forEach(b =>
      b.addEventListener('click', () => {
        st.filter = b.dataset.q;
        const inp = mainEl.querySelector('#aro-search');
        if (inp) inp.value = st.filter;
        renderList(); renderStatus();
        mainEl.scrollTo({ top: 0, behavior: 'smooth' });
      }));
  }

  /* ---------------- stocktake push + transfers ---------------- */

  function takeDeltas() {
    const out = [];
    for (const it of st.items) {
      const raw = st.take.counts[it.id];
      if (raw == null || String(raw).trim() === '') continue;
      const counted = parseFloat(String(raw).replace(',', '.'));
      if (!Number.isFinite(counted) || counted < 0) continue;
      const have = qtyAt(it, st.take.name);
      const delta = Math.round((counted - have) * 10000) / 10000;
      if (delta !== 0) out.push({ it, have, counted, delta });
    }
    return out;
  }

  function reviewStocktake() {
    const deltas = takeDeltas();
    const counted = Object.values(st.take.counts).filter(v => String(v).trim() !== '').length;
    if (!counted) { App.toast('Nothing counted yet — type quantities into the lines first.', 'warn'); return; }
    if (!deltas.length) { App.toast('All counted lines already match AroFlo — nothing to push. ✔', 'info'); return; }
    const rows = deltas.map(d => `
      <tr><td>${esc(d.it.desc)}<div class="aro-sub">${esc(d.it.pn)}</div></td>
      <td class="num">${qty(d.have)}</td><td class="num">${qty(d.counted)}</td>
      <td class="num" style="color:${d.delta > 0 ? '#39b54a' : '#e05555'};font-weight:700">${d.delta > 0 ? '+' : ''}${qty(d.delta)}</td></tr>`).join('');
    App.modal(`
      <h3>Push stocktake — ${esc(st.take.name)}</h3>
      <p class="muted">${deltas.length} line${deltas.length === 1 ? '' : 's'} differ from AroFlo (${counted} counted). Confirming posts these adjustments to your live AroFlo inventory.</p>
      <div style="max-height:45vh;overflow:auto"><table class="to-table">
        <tr><th>Item</th><th style="text-align:right">AroFlo</th><th style="text-align:right">Counted</th><th style="text-align:right">Adjust</th></tr>${rows}
      </table></div>
      <div class="modal-actions">
        <button class="mini-btn" id="take-cancel">Back</button>
        <button class="mini-btn primary" id="take-push">Push ${deltas.length} adjustment${deltas.length === 1 ? '' : 's'} to AroFlo</button>
      </div>`, (box, close) => {
      box.querySelector('#take-cancel').addEventListener('click', close);
      box.querySelector('#take-push').addEventListener('click', async () => {
        const btn = box.querySelector('#take-push');
        btn.disabled = true; btn.textContent = 'Pushing…';
        try {
          const moves = deltas.map(d => ({ itemid: d.it.id, toId: st.take.id, toType: st.take.type, delta: d.delta }));
          for (let i = 0; i < moves.length; i += 50) await postCall('adjuststock', { moves: moves.slice(i, i + 50) });
          close();
          st.take = { on: false, name: '', id: '', type: '', counts: {}, pushing: false };
          App.toast(`Stocktake pushed — ${moves.length} adjustment${moves.length === 1 ? '' : 's'} sent to AroFlo. Re-reading…`, 'good', 6000);
          await refresh();
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Push to AroFlo';
          App.toast('Push failed: ' + e.message, 'error', 9000);
        }
      });
    });
  }

  function transferDialog(itemId, levelIndex) {
    const it = st.items.find(x => x.id === itemId);
    const from = it && (it.levels || [])[levelIndex];
    if (!it || !from || !from.id) return;
    const dests = [];
    const seen = new Set([from.to]);
    for (const h of st.allHolders) if (h.id && !seen.has(h.name)) { seen.add(h.name); dests.push(h); }
    for (const item of st.items) for (const l of item.levels || []) {
      if (l.id && l.to && !seen.has(l.to)) { seen.add(l.to); dests.push({ name: l.to, id: l.id, type: l.type }); }
    }
    dests.sort((a, b) => a.name.localeCompare(b.name));
    if (!dests.length) { App.toast('No other holders to move to — hit ⟳ first.', 'warn'); return; }
    App.modal(`
      <h3>Move stock</h3>
      <p class="muted">${esc(it.desc)}<br>From <b>${esc(from.to)}</b> — ${qty(from.qty)} on hand.</p>
      <div class="form-row"><label>Quantity</label>
        <input type="text" id="mv-qty" inputmode="decimal" placeholder="e.g. 10" autocomplete="off"></div>
      <div class="form-row"><label>To</label>
        <select id="mv-dest">${dests.map(d => `<option value="${esc(d.name)}">${esc(d.name)} — ${esc(holderKind(d.type))}</option>`).join('')}</select></div>
      <p class="muted" id="mv-note"></p>
      <div class="modal-actions">
        <button class="mini-btn" id="mv-cancel">Cancel</button>
        <button class="mini-btn primary" id="mv-ok">Move</button>
      </div>`, (box, close) => {
      box.querySelector('#mv-cancel').addEventListener('click', close);
      box.querySelector('#mv-qty').focus();
      box.querySelector('#mv-ok').addEventListener('click', async () => {
        const qv = parseFloat(String(box.querySelector('#mv-qty').value).replace(',', '.'));
        const note = box.querySelector('#mv-note');
        if (!Number.isFinite(qv) || qv <= 0) { note.textContent = 'Enter a quantity greater than zero.'; return; }
        const dest = dests.find(d => d.name === box.querySelector('#mv-dest').value);
        if (!dest) return;
        if (qv > from.qty && !note.dataset.warned) {
          note.dataset.warned = '1';
          note.textContent = `That's more than the ${qty(from.qty)} recorded at ${from.to} — tap Move again if the count there is just out of date.`;
          return;
        }
        const btn = box.querySelector('#mv-ok');
        btn.disabled = true; btn.textContent = 'Moving…';
        try {
          const moves = [
            { itemid: it.id, toId: from.id, toType: from.type, delta: -qv },
            { itemid: it.id, toId: dest.id, toType: dest.type, delta: qv },
          ];
          await postCall('adjuststock', { moves });
          applyLocalMoves(moves);
          close();
          App.toast(`Moved ${qty(qv)} × ${it.desc} → ${dest.name}. ✔`, 'good', 5000);
          render();
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Move';
          note.textContent = 'Move failed: ' + e.message;
        }
      });
    });
  }

  /* ---------------- intro / setup ---------------- */

  function renderIntro(container) {
    container.innerHTML = `
      <div class="prop-cap">Site stock — AroFlo</div>
      <p class="prop-note">Show a live inventory list straight from AroFlo — what's held at each store, van or site holder — plus the materials already recorded against the job's task.</p>
      ${st.error ? `<div class="aro-error">${esc(st.error)}</div>` : ''}
      <p class="prop-note">The app talks to a small read-only proxy (<code>api/aroflo.js</code>) that holds your AroFlo API keys server-side — keys are never in the browser. Deploy this repo to Vercel and add the <code>AROFLO_*</code> environment variables (see the README), then connect.</p>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="mini-btn primary" id="aro-connect">Connect…</button>
        <button class="mini-btn" id="aro-try">Try /api/aroflo</button>
      </div>`;
    container.querySelector('#aro-connect').addEventListener('click', settingsDialog);
    container.querySelector('#aro-try').addEventListener('click', refresh);
  }

  function diagHtml(d) {
    const rows = Object.entries(d.vars || {}).map(([name, v]) => {
      const short = name.replace('AROFLO_', '');
      if (!v.set) return `<div class="aro-diag-row bad">⚠ ${esc(short)}: <b>not set</b></div>`;
      const flags = [];
      if (v.innerWhitespace) flags.push('contains a line break or space — re-paste it');
      if (v.badChars && v.badChars.length) flags.push('contains ' + v.badChars.join(' ') + (v.badAt ? ' at position ' + v.badAt + ' of ' + v.len : '') + ' — re-paste this value');
      const note = v.invisibles ? ` (${v.invisibles} hidden character${v.invisibles > 1 ? 's' : ''} removed automatically)` : '';
      return `<div class="aro-diag-row${flags.length ? ' bad' : ''}">${flags.length ? '⚠' : '·'} ${esc(short)}: ${v.len} chars, “${esc(v.ends)}”${esc(note)}${flags.length ? ' — ' + esc(flags.join('; ')) : ''}</div>`;
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
      <div class="form-row"><label>Sync scope</label>
        <div style="flex:1;min-width:0">
          <div class="muted" id="aro-cats-cur">${cfg.cats.length ? esc(cfg.cats.join(', ')) : 'All items (whole catalogue)'}</div>
          <button class="mini-btn" id="aro-cats-edit" style="margin-top:4px">Choose categories…</button>
          <div id="aro-cats-list" class="aro-cats-list" hidden></div>
        </div></div>
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
        const list = box.querySelector('#aro-cats-list');
        if (list && !list.hidden) {
          cfg.cats = [...list.querySelectorAll('input:checked')].map(i => i.value);
        }
      };
      box.querySelector('#aro-cats-edit').addEventListener('click', async () => {
        read(); saveCfg();
        const list = box.querySelector('#aro-cats-list');
        if (!list.hidden) { list.hidden = true; return; }
        list.hidden = false;
        list.innerHTML = '<span class="muted">Loading categories…</span>';
        try {
          const r = await call('categories');
          const cats = r.categories || [];
          // Categories are a tree — render it indented, parents first, so
          // "Flange" under "Impress" reads as what it is.
          const byId = new Map(cats.map(c => [c.id, c]));
          const kids = new Map();
          const roots = [];
          for (const c of cats) {
            if (c.parentId && byId.has(c.parentId)) {
              if (!kids.has(c.parentId)) kids.set(c.parentId, []);
              kids.get(c.parentId).push(c);
            } else roots.push(c);
          }
          const byName = (a, b) => a.name.localeCompare(b.name);
          const row = (c, depth) => {
            const children = (kids.get(c.id) || []).sort(byName);
            return `<label class="chk aro-cat${children.length ? ' aro-cat-parent' : ''}" style="padding-left:${depth * 18}px">
              <input type="checkbox" value="${esc(c.name)}" data-id="${esc(c.id)}"${cfg.cats.includes(c.name) ? ' checked' : ''}> ${esc(c.name)}</label>`
              + children.map(k => row(k, depth + 1)).join('');
          };
          const known = new Set(cats.map(c => c.name));
          const stale = cfg.cats.filter(n => !known.has(n));
          list.innerHTML = `<label class="chk"><input type="checkbox" id="aro-cats-none"${cfg.cats.length ? '' : ' checked'}> <b>All items</b> (no scope)</label>`
            + roots.sort(byName).map(c => row(c, 0)).join('')
            + stale.map(n => `<label class="chk aro-cat"><input type="checkbox" value="${esc(n)}" checked> ${esc(n)} <span class="muted">(no longer in AroFlo)</span></label>`).join('');

          const none = list.querySelector('#aro-cats-none');
          const boxes = [...list.querySelectorAll('input[value]')];
          const descendants = id => {
            const out = [];
            for (const k of kids.get(id) || []) { out.push(k.id); out.push(...descendants(k.id)); }
            return out;
          };
          none.addEventListener('change', () => {
            if (none.checked) boxes.forEach(i => { i.checked = false; });
          });
          boxes.forEach(i => i.addEventListener('change', () => {
            // ticking a parent takes its whole branch along — AroFlo's filter
            // only matches an item's own category, so children must be
            // queried individually
            const id = i.dataset.id;
            if (id) for (const d of descendants(id)) {
              const box = list.querySelector(`input[data-id="${CSS.escape(d)}"]`);
              if (box) box.checked = i.checked;
            }
            if (boxes.some(x => x.checked)) none.checked = false;
            else none.checked = true;
          }));
        } catch (e) {
          list.innerHTML = `<span class="aro-error">${esc(e.message)}</span>`;
        }
      });
      box.querySelector('#aro-test').addEventListener('click', async () => {
        read(); saveCfg();
        const out = box.querySelector('#aro-test-out');
        out.textContent = 'Testing…';
        try {
          const r = await call('ping');
          out.textContent = '✓ Connected — ' + ((r.businessUnits || []).join(', ') || 'AroFlo replied OK')
            + (r.build ? ' · build ' + r.build : '');
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

  function onHandOf(itemid) {
    const it = st.items.find(x => x.id === itemid);
    if (!it) return null;
    let total = 0;
    const parts = [];
    for (const l of it.levels || []) if (l.to) { total += l.qty; if (l.qty) parts.push(l.to + ': ' + qty(l.qty)); }
    return { total, tip: parts.join(' · ') || 'no stock recorded' };
  }

  function taskMaterialsHtml(forceOpen) {
    const tm = st.tm;
    const open = forceOpen || tm.open;
    let h = forceOpen
      ? `<div class="prop-cap">Job materials used (AroFlo)</div>`
      : `<div class="prop-cap aro-tm-cap" id="aro-tm-toggle">${open ? '▾' : '▸'} Job materials used (AroFlo)</div>`;
    if (!open) return h;
    h += `<div class="aro-bar">
      <button class="mini-btn${tm.mode === 'task' ? ' primary' : ''}" id="aro-tm-mtask">Task</button>
      <button class="mini-btn${tm.mode === 'project' ? ' primary' : ''}" id="aro-tm-mproj">Project</button>
    </div>`;
    if (tm.mode === 'task') {
      h += `<div class="aro-bar">
        <input type="text" id="aro-job" placeholder="Job number" value="${esc(tm.job)}" autocomplete="off" style="max-width:110px">
        <button class="mini-btn" id="aro-tm-load"${tm.phase === 'loading' ? ' disabled' : ''}>Load</button>
      </div>`;
    } else {
      h += `<div class="aro-bar">
        <input type="text" id="aro-proj" placeholder="Project number or name" value="${esc(tm.pQuery)}" autocomplete="off">
        <button class="mini-btn" id="aro-tm-pload"${tm.phase === 'loading' ? ' disabled' : ''}>Load</button>
      </div>`;
    }
    if (tm.phase === 'loading') h += `<div class="aro-status"><span class="aro-busy">${esc(tm.progress || 'Loading…')}</span></div>`;
    if (tm.error) h += `<div class="aro-error">${esc(tm.error)}</div>`;

    if (tm.mode === 'task') {
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
      if (tm.taskid && tm.phase === 'ready') {
        h += `<div class="aro-bar" style="margin-top:6px"><button class="mini-btn" id="aro-tm-log" title="Tap-count parts and book them to this task's Used Items">+ Log parts used…</button></div>`;
      }
    } else {
      if (tm.pMatches.length > 1) {
        h += `<div class="aro-bar"><select id="aro-tm-proj">${tm.pMatches.map(p =>
          `<option value="${esc(p.id)}"${p.id === tm.pId ? ' selected' : ''}>#${esc(p.number)} ${esc(p.name)}</option>`).join('')}</select></div>`;
      }
      if (tm.pId && tm.phase === 'ready') {
        h += `<p class="prop-note">#${esc((tm.pMatches.find(p => p.id === tm.pId) || {}).number || '')} ${esc(tm.pName)} — ${tm.pTasks.length} task${tm.pTasks.length === 1 ? '' : 's'} (${esc(tm.pTasks.map(t => '#' + t.job).join(', '))})</p>`;
        if (tm.agg.length) {
          h += `<div class="aro-bar">
            <button class="mini-btn${tm.pView !== 'job' ? ' primary' : ''}" id="aro-tm-vitem">By item</button>
            <button class="mini-btn${tm.pView === 'job' ? ' primary' : ''}" id="aro-tm-vjob">By job</button>
          </div>`;
          if (tm.pView === 'job') {
            // one section per task, in job order — each job's own materials
            for (const t of tm.pTasks) {
              const lines = tm.agg
                .map(a => ({ a, q: a.byTask.get(t.job) || 0 }))
                .filter(x => x.q > 0);
              h += `<div class="tm-jobhead">#${esc(t.job)} ${esc(t.name)} <span class="muted">(${esc(t.status)})</span></div>`;
              if (!lines.length) { h += `<p class="prop-note">No materials recorded.</p>`; continue; }
              h += `<table class="to-table"><tr><th>Item</th><th style="text-align:right">Qty</th></tr>`;
              for (const { a, q } of lines) h += `<tr><td title="${esc(a.pn)}">${esc(a.item)}</td><td class="num">${qty(q)}</td></tr>`;
              h += `<tr class="total"><td>Lines</td><td class="num">${lines.length}</td></tr></table>`;
            }
          } else {
            h += `<p class="prop-note">Tap a line to split it per job.</p>
              <table class="to-table"><tr><th>Item</th><th style="text-align:right" title="Total used across all the project's tasks">Used</th><th style="text-align:right" title="Currently on hand across all stock locations">On hand</th></tr>`;
            for (const a of tm.agg) {
              const oh = onHandOf(a.itemid);
              const key = a.itemid || a.pn + '|' + a.item;
              h += `<tr class="tm-item" data-k="${esc(key)}"><td title="${esc(a.pn)}">${esc(a.item)}</td>
                <td class="num">${qty(a.qty)}</td>
                <td class="num"${oh ? ` title="${esc(oh.tip)}"` : ''}>${oh ? qty(oh.total) : '<span class="muted" title="Not in the synced stock list — widen the sync scope to see on-hand">—</span>'}</td></tr>`;
              if (tm.aggOpen === key) {
                for (const [job, q] of [...a.byTask.entries()].sort((x, y) => String(y[0]).localeCompare(String(x[0])))) {
                  const t = tm.pTasks.find(x => x.job === job);
                  h += `<tr class="tm-sub"><td>#${esc(job)}${t ? ' · ' + esc(t.name) : ''}</td><td class="num">${qty(q)}</td><td></td></tr>`;
                }
              }
            }
            h += `<tr class="total"><td>Lines</td><td class="num">${tm.agg.length}</td><td></td></tr></table>`;
          }
        } else {
          h += `<p class="prop-note">No materials recorded on this project's tasks yet.</p>`;
        }
      }
    }
    return h;
  }

  function wireTaskMaterials(container) {
    const root = container; // all lookups below are scoped to the side column
    const toggle = root.querySelector('#aro-tm-toggle');
    if (toggle) toggle.addEventListener('click', () => {
      st.tm.open = !st.tm.open;
      render();
    });
    if (!st.tm.job) {
      const digits = String(State.S.jobRef || '').replace(/\D+/g, '');
      if (digits) st.tm.job = digits;
    }
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
    const logBtn = root.querySelector('#aro-tm-log');
    if (logBtn) logBtn.addEventListener('click', () => {
      const t = st.tm.tasks.find(x => x.taskid === st.tm.taskid);
      if (t) usedDialog(t.job, { task: t });
    });
    const mt = root.querySelector('#aro-tm-mtask'), mp = root.querySelector('#aro-tm-mproj');
    if (mt) mt.addEventListener('click', () => { st.tm.mode = 'task'; render(); });
    if (mp) mp.addEventListener('click', () => { st.tm.mode = 'project'; render(); });
    const pload = root.querySelector('#aro-tm-pload');
    if (pload) pload.addEventListener('click', loadProjectMaterials);
    const projIn = root.querySelector('#aro-proj');
    if (projIn) {
      projIn.addEventListener('input', () => { st.tm.pQuery = projIn.value; });
      projIn.addEventListener('keydown', e => { if (e.key === 'Enter') loadProjectMaterials(); });
    }
    const psel = root.querySelector('#aro-tm-proj');
    if (psel) psel.addEventListener('change', () => {
      const p = st.tm.pMatches.find(x => x.id === psel.value);
      if (p) loadProjectFrom(p);
    });
    const vi = root.querySelector('#aro-tm-vitem'), vj = root.querySelector('#aro-tm-vjob');
    if (vi) vi.addEventListener('click', () => { st.tm.pView = 'item'; render(); });
    if (vj) vj.addEventListener('click', () => { st.tm.pView = 'job'; render(); });
    root.querySelectorAll('.tm-item').forEach(tr =>
      tr.addEventListener('click', () => {
        st.tm.aggOpen = st.tm.aggOpen === tr.dataset.k ? '' : tr.dataset.k;
        render();
      }));
  }

  async function loadProjectMaterials() {
    const tm = st.tm;
    const query = String(tm.pQuery || '').trim();
    if (!query) { tm.error = 'Type the AroFlo project number or part of its name.'; render(); return; }
    tm.phase = 'loading'; tm.error = ''; tm.progress = 'Finding the project…';
    tm.pMatches = []; tm.pId = ''; tm.pName = ''; tm.pTasks = []; tm.agg = [];
    render();
    try {
      if (!projCache) {
        const all = [];
        for (let page = 1; page <= 4; page++) {
          const r = await call('projects', { page });
          all.push(...(r.projects || []));
          if (r.last) break;
        }
        projCache = all;
      }
      const digits = query.replace(/\D+/g, '');
      const matches = digits && digits === query.replace(/\s+/g, '')
        ? projCache.filter(p => p.number === digits)
        : projCache.filter(p => p.name.toLowerCase().includes(query.toLowerCase()));
      if (!matches.length) { tm.phase = 'ready'; tm.error = 'No AroFlo project matches “' + query + '”.'; render(); return; }
      tm.pMatches = matches;
      await loadProjectFrom(matches[0]);
    } catch (e) { tm.phase = 'ready'; tm.error = e.message; render(); }
  }

  async function loadProjectFrom(p) {
    const tm = st.tm;
    tm.phase = 'loading'; tm.error = ''; tm.pId = p.id; tm.pName = p.name; tm.pTasks = []; tm.agg = [];
    tm.progress = 'Finding “' + p.name + '” tasks…';
    render();
    try {
      const rt = await call('projecttasks', { projectid: p.id, clientid: p.clientId || '', name: p.name });
      tm.pTasks = rt.tasks || [];
      rememberSite({ project: p.number || tm.pQuery });
      if (!tm.pTasks.length) {
        const s = rt.scan || {};
        tm.phase = 'ready';
        tm.error = 'No tasks found on this project. Scanned ' + (s.scanned || 0) + ' task' + (s.scanned === 1 ? '' : 's')
          + (s.narrowed ? ' for this client' : '') + '; ' + (s.withProject || 0) + ' had project links'
          + (s.samples && s.samples.length ? ' (e.g. ' + s.samples.slice(0, 3).join(', ') + ')' : '') + '.';
        render(); return;
      }
      // aggregate materials across every task of the project
      const agg = new Map();
      for (let i = 0; i < tm.pTasks.length; i++) {
        const t = tm.pTasks[i];
        tm.progress = 'Materials — task ' + (i + 1) + ' of ' + tm.pTasks.length + ' (#' + t.job + ')…';
        render();
        const rm = await call('taskmaterials', { taskid: t.taskid });
        for (const m of rm.materials || []) {
          const key = m.itemid || (m.pn + '|' + m.item);
          if (!agg.has(key)) agg.set(key, { itemid: m.itemid, item: m.item, pn: m.pn, qty: 0, byTask: new Map() });
          const a = agg.get(key);
          a.qty += m.qty;
          a.byTask.set(t.job, (a.byTask.get(t.job) || 0) + m.qty);
        }
      }
      tm.agg = [...agg.values()]
        .map(a => ({ ...a, perTask: [...a.byTask.entries()].map(([job, q]) => '#' + job + ': ' + qty(q)).join(' · ') }))
        .sort((x, y) => x.item.localeCompare(y.item));
      tm.phase = 'ready';
    } catch (e) { tm.phase = 'ready'; tm.error = e.message; }
    render();
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
    if (!st.items.length) refresh(); // an unconfigured proxy answers instantly with the setup panel
  }

  function init() {
    root = document.getElementById('tab-stock');
    pageEl = document.getElementById('stockPage');
    mainEl = document.getElementById('stockMain');
    sideEl = document.getElementById('stockSide');
    if (!root || !pageEl) return;
    loadCfg();
    codeMap = loadJson('abmt:barcodes', {});
    pars = loadJson('abmt:pars', {});
    itemMap = loadJson('abmt:itemmap', {});
    sysPresets = loadJson('abmt:syspresets', []);
    jobSys = loadJson('abmt:jobsys', {});
    usedDrafts = loadJson('abmt:used', {});
    catParent = loadJson('abmt:cattree', {});
    st.catView = !!loadJson('abmt:catview', false);
    if (loadCache()) st.phase = 'ready';
    render();
    const tabBtn = document.querySelector('#rightPanel .tab[data-tab="stock"]');
    if (tabBtn) tabBtn.addEventListener('click', onShow);
    // the zone popover is anchored to screen coordinates — drop it whenever
    // the view moves under it
    State.on('zoom', closeZonePopover);
    State.on('page', closeZonePopover);
    State.on('tool', closeZonePopover);
    State.on('doc', closeZonePopover);
    document.getElementById('stockClose').addEventListener('click', closePage);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && pageOpen() && document.getElementById('modalRoot').classList.contains('hidden')) {
        e.stopPropagation();
        closePage();
      }
    }, true);
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    refresh, settingsDialog, call, openPage, closePage,
    zonePopover, zoneLinkDialog, closeZonePopover, usedDialog,
    _state: st, _onScan: onScan, _resolveScan: resolveScan,
  };
})();
