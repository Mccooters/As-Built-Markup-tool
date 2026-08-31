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
    shownOnce: false,
    expanded: null,       // itemid with the holder breakdown open
    take: { on: false, name: '', id: '', type: '', counts: {}, pushing: false },
    tm: { mode: 'task', job: '', tasks: [], taskid: '', materials: [], phase: 'idle', error: '', open: false,
          progress: '', pQuery: '', pMatches: [], pId: '', pName: '', pTasks: [], agg: [] },
  };
  let projCache = null; // AroFlo project list, fetched once per session
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
      if (st.hideZero && q <= 0) continue;
      out.push({ it, q });
    }
    return out;
  }

  /* ---------------- rendering ---------------- */

  /* ---------------- full-screen page ---------------- */

  const pageOpen = () => pageEl && !pageEl.classList.contains('hidden');

  function openPage() {
    if (!pageEl) return;
    pageEl.classList.remove('hidden');
    document.body.classList.remove('panel-open');
    const fresh = st.asAt && (Date.now() - Date.parse(st.asAt) < STALE_MS);
    render();
    if (st.phase !== 'loading' && !(st.phase === 'ready' && fresh)) refresh();
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
        <button class="mini-btn" id="aro-refresh" title="Re-load stock from AroFlo"${st.phase === 'loading' ? ' disabled' : ''}>⟳</button>
        <button class="mini-btn" id="aro-cfg" title="AroFlo connection settings">⚙</button>
      </div>`;
    if (st.take.on) {
      h += `
      <div class="aro-take-bar">
        <span class="aro-take-cap">Stocktake — <b>${esc(st.take.name)}</b></span>
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
        <button class="mini-btn" id="aro-take" title="Count this location and push corrected quantities to AroFlo">Stocktake</button>
      </div>`;
    }
    h += `<div class="aro-status" id="aro-status"></div></div>
      <div class="aro-list" id="aro-list"></div>`;
    mainEl.innerHTML = h;
    sideEl.innerHTML = `<div class="stock-card">${taskMaterialsHtml(true)}</div>`;

    const search = mainEl.querySelector('#aro-search');
    let deb = 0;
    search.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => { st.filter = search.value; renderList(); renderStatus(); }, 140);
    });
    mainEl.querySelector('#aro-refresh').addEventListener('click', refresh);
    mainEl.querySelector('#aro-cfg').addEventListener('click', settingsDialog);
    if (st.take.on) {
      mainEl.querySelector('#aro-take-review').addEventListener('click', reviewStocktake);
      mainEl.querySelector('#aro-take-cancel').addEventListener('click', () => {
        st.take = { on: false, name: '', id: '', type: '', counts: {}, pushing: false };
        render();
      });
    } else {
      mainEl.querySelector('#aro-holder').addEventListener('change', e => { st.holder = e.target.value; renderList(); renderStatus(); });
      mainEl.querySelector('#aro-zero').addEventListener('change', e => { st.hideZero = e.target.checked; renderList(); renderStatus(); });
      mainEl.querySelector('#aro-take').addEventListener('click', startStocktake);
    }
    wireTaskMaterials(sideEl);
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
      h += `<span class="muted">${filteredItems().length} of ${st.items.length} items · as at ${esc(age)}</span>`;
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
  }

  // Stocktake entry: every item (search-filtered), current qty at the holder,
  // and a count input. Blank input = line not counted, no change pushed.
  function renderTakeList(el) {
    const terms = st.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const items = st.items.filter(it =>
      !it.stub && (!terms.length || terms.every(t => (it.desc + ' ' + it.pn + ' ' + it.cat).toLowerCase().includes(t))));
    if (!items.length) { el.innerHTML = `<p class="prop-note">Nothing matches the search.</p>`; return; }
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
    el.querySelectorAll('.aro-count').forEach(inp => {
      inp.addEventListener('input', () => {
        st.take.counts[inp.dataset.id] = inp.value;
        renderStatus();
      });
    });
  }

  function aroLevelsHtml(it) {
    const levels = (it.levels || []).filter(l => l.to);
    if (!levels.length) return `<div class="aro-levels"><span class="muted">No stock locations recorded.</span></div>`;
    return `<div class="aro-levels">${levels.map((l, i) =>
      `<div class="aro-level"><span>${esc(l.to)} <span class="muted">(${esc(holderKind(l.type))})</span></span>
        <span class="aro-level-r"><b>${qty(l.qty)}</b>${l.id ? ` <button class="mini-btn aro-move" data-item="${esc(it.id)}" data-level="${i}" title="Move stock from ${esc(l.to)} to another holder">⇄</button>` : ''}</span>
      </div>`).join('')}
    </div>`;
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
          await postCall('adjuststock', { moves: [
            { itemid: it.id, toId: from.id, toType: from.type, delta: -qv },
            { itemid: it.id, toId: dest.id, toType: dest.type, delta: qv },
          ] });
          close();
          App.toast(`Moved ${qty(qv)} × ${it.desc} → ${dest.name}. Re-reading…`, 'good', 6000);
          await refresh();
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
    } else {
      if (tm.pMatches.length > 1) {
        h += `<div class="aro-bar"><select id="aro-tm-proj">${tm.pMatches.map(p =>
          `<option value="${esc(p.id)}"${p.id === tm.pId ? ' selected' : ''}>#${esc(p.number)} ${esc(p.name)}</option>`).join('')}</select></div>`;
      }
      if (tm.pId && tm.phase === 'ready') {
        h += `<p class="prop-note">#${esc((tm.pMatches.find(p => p.id === tm.pId) || {}).number || '')} ${esc(tm.pName)} — ${tm.pTasks.length} task${tm.pTasks.length === 1 ? '' : 's'} (${esc(tm.pTasks.map(t => '#' + t.job).join(', '))})</p>`;
        if (tm.agg.length) {
          h += `<table class="to-table"><tr><th>Item</th><th style="text-align:right" title="Total used across all the project's tasks">Used</th><th style="text-align:right" title="Currently on hand across all stock locations">On hand</th></tr>`;
          for (const a of tm.agg) {
            const oh = onHandOf(a.itemid);
            h += `<tr><td title="${esc(a.pn)}${a.perTask ? ' · ' + esc(a.perTask) : ''}">${esc(a.item)}</td>
              <td class="num">${qty(a.qty)}</td>
              <td class="num"${oh ? ` title="${esc(oh.tip)}"` : ''}>${oh ? qty(oh.total) : '<span class="muted" title="Not in the synced stock list — widen the sync scope to see on-hand">—</span>'}</td></tr>`;
          }
          h += `<tr class="total"><td>Lines</td><td class="num">${tm.agg.length}</td><td></td></tr></table>`;
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
      const rt = await call('projecttasks', { projectid: p.id });
      tm.pTasks = rt.tasks || [];
      if (!tm.pTasks.length) { tm.phase = 'ready'; tm.error = 'No tasks found on this project.'; render(); return; }
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
    const fresh = st.asAt && (Date.now() - Date.parse(st.asAt) < STALE_MS);
    if (!(st.phase === 'ready' && fresh)) refresh(); // an unconfigured proxy answers instantly with the setup panel
  }

  function init() {
    root = document.getElementById('tab-stock');
    pageEl = document.getElementById('stockPage');
    mainEl = document.getElementById('stockMain');
    sideEl = document.getElementById('stockSide');
    if (!root || !pageEl) return;
    loadCfg();
    if (loadCache()) st.phase = 'ready';
    render();
    const tabBtn = document.querySelector('#rightPanel .tab[data-tab="stock"]');
    if (tabBtn) tabBtn.addEventListener('click', onShow);
    document.getElementById('stockClose').addEventListener('click', closePage);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && pageOpen() && document.getElementById('modalRoot').classList.contains('hidden')) {
        e.stopPropagation();
        closePage();
      }
    }, true);
  }

  document.addEventListener('DOMContentLoaded', init);

  return { refresh, settingsDialog, call, openPage, closePage, _state: st };
})();
