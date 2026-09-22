/* ============ markuplist.js — Bluebeam-style markups list + takeoff + CSV ============ */
'use strict';

const MarkupList = (() => {

  let sortKey = 'idx', sortDir = 1;
  let els = {};
  // 'type' = type groups with the area zones as sub-groups · 'zone' = zones on top · 'none' = flat
  let groupMode = (() => { try { return localStorage.getItem('abmt:listgroup') || 'type'; } catch (e) { return 'type'; } })();

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  /* ================= row model ================= */

  function rowData(m, idx) {
    const meas = Render.measureLabel(m);
    let label = '';
    if (m.type === 'fitting') {
      const ft = Symbols.fittingById(m.fitId);
      label = [ft ? ft.code : m.fitId, m.pipeSize, m.day].filter(Boolean).join(' · ');
    }
    else if (m.type === 'pipe') label = [m.pipeSize, m.material, m.system].filter(Boolean).join(' · ');
    else if (m.type === 'text' || m.type === 'callout') label = (m.text || '').replace(/\n/g, ' ');
    else if (m.type === 'count') { const g = State.countGroup(m.groupId); label = g ? g.name : ''; }
    else if (m.type === 'penet') label = [`Ø${m.penSize || '?'}`, m.penType, m.penFire ? 'FIRE-RATED' : ''].filter(Boolean).join(' · ');
    else if (m.type === 'photo') label = m.caption || '';
    if (m.comment) label = label ? `${label} — ${m.comment}` : m.comment;
    return {
      id: m.id, idx, page: m.page,
      subject: m.subject || m.type,
      label,
      measure: m.type === 'penet' ? `Ø${m.penSize || '?'}` : meas,
      measureVal: State.lengthFt(m) ?? State.areaFt(m) ?? -1,
      color: m.color,
      author: m.author || '',
      date: m.date || '',
      type: m.type,
      hidden: State.isHidden(m),
      cat: State.categoryOf(m),
      zone: State.zoneOf(m),
      lenFt: m.type === 'mlength' || m.type === 'mpoly' || m.type === 'pipe' ? State.lengthFt(m) : null,
      areaFt: m.type === 'marea' ? State.areaFt(m) : null,
    };
  }

  function visibleRows() {
    const search = els.search.value.trim().toLowerCase();
    const type = els.typeFilter.value;
    const pageOnly = els.pageOnly.checked;
    const rows = State.S.markups.map(rowData);
    let out = rows.filter(r => {
      if (type && r.type !== type) return false;
      if (pageOnly && r.page !== State.S.page) return false;
      if (search) {
        const hay = `${r.subject} ${r.label} ${r.measure} ${r.author}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
    out.sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === 'measure') { va = a.measureVal; vb = b.measureVal; }
      if (typeof va === 'string') { va = va.toLowerCase(); vb = String(vb).toLowerCase(); }
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
    });
    return out;
  }

  /* ================= grouping ================= */
  // Type groups (Measurements, Pipe runs, …) with the drawing's area zones as
  // sub-groups — or the zones on top. Every group collapses in the list and
  // hides on the sheet on its own; a hidden parent hides its children too.

  const zoneKey = z => 'zone:' + (z ? z.id : 'none');

  function byZone(rows, keyPrefix) {
    const buckets = new Map();
    for (const r of rows) {
      const k = zoneKey(r.zone);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    const out = [];
    for (const z of State.S.markups) {
      if (z.type !== 'zone' || !buckets.has(zoneKey(z))) continue;
      out.push({ key: keyPrefix + zoneKey(z), name: State.zoneName(z), rows: buckets.get(zoneKey(z)), children: [] });
    }
    if (buckets.has('zone:none')) out.push({ key: keyPrefix + 'zone:none', name: 'Not in a zone', rows: buckets.get('zone:none'), children: [] });
    return out;
  }

  function buildTree(rows) {
    if (groupMode === 'zone') return byZone(rows, '');
    const hasZones = State.S.markups.some(m => m.type === 'zone');
    const cats = new Map();
    for (const r of rows) { if (!cats.has(r.cat)) cats.set(r.cat, []); cats.get(r.cat).push(r); }
    const order = [...State.CATEGORY_ORDER, ...[...cats.keys()].filter(c => !State.CATEGORY_ORDER.includes(c))];
    const out = [];
    for (const c of order) {
      if (!cats.has(c)) continue;
      const g = { key: 'type:' + c, name: State.CATEGORY_NAME[c] || c, rows: cats.get(c), children: [] };
      if (hasZones && c !== 'zone') {
        const subs = byZone(g.rows, 'type:' + c + '|');
        // split only when something actually sits in a zone
        if (subs.some(s => !/zone:none$/.test(s.key))) { g.children = subs; g.rows = []; }
      }
      out.push(g);
    }
    return out;
  }

  const allRows = g => g.rows.concat(...g.children.map(allRows));

  function totals(rows) {
    let len = 0, lenKnown = false, area = 0, areaKnown = false;
    for (const r of rows) {
      if (r.lenFt != null) { len += r.lenFt; lenKnown = true; }
      if (r.areaFt != null) { area += r.areaFt; areaKnown = true; }
    }
    const fmt = State.S.unitFormat;
    return [lenKnown ? Units.fmtLen(len, fmt) : '', areaKnown ? Units.fmtArea(area, fmt) : ''].filter(Boolean).join(' · ');
  }

  const EYE_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.3A11 11 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1"/><path d="M6.6 6.7A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  function groupEl(g, level, parentHidden) {
    const own = State.groupHidden(g.key);
    const off = own || parentHidden;
    const collapsed = State.groupCollapsed(g.key);
    const rows = allRows(g);
    const tot = totals(rows);
    const tr = document.createElement('tr');
    tr.className = `grp lvl${level}${off ? ' hid' : ''}${collapsed ? ' closed' : ''}`;
    tr.dataset.key = g.key;
    tr.innerHTML = `<td colspan="9">
      <button type="button" class="grp-tog" title="${collapsed ? 'Expand' : 'Collapse'}" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'}</button>
      <button type="button" class="grp-eye" title="${own ? 'Show these on the drawing' : parentHidden ? 'Hidden with the whole group' : 'Hide these on the drawing'}" aria-pressed="${own}">${off ? EYE_OFF : EYE_ON}</button>
      <span class="grp-name">${esc(g.name)}</span><span class="grp-count">${rows.length}</span>${tot ? `<span class="grp-tot">${esc(tot)}</span>` : ''}</td>`;
    tr.querySelector('.grp-tog').addEventListener('click', e => { e.stopPropagation(); State.setGroupCollapsed(g.key, !collapsed); });
    tr.querySelector('.grp-eye').addEventListener('click', e => { e.stopPropagation(); State.setGroupHidden(g.key, !own); });
    tr.addEventListener('click', () => State.setGroupCollapsed(g.key, !collapsed));
    return { tr, off, collapsed };
  }

  function appendGroup(frag, g, level, parentHidden) {
    const { tr, off, collapsed } = groupEl(g, level, parentHidden);
    frag.appendChild(tr);
    if (collapsed) return;
    for (const c of g.children) appendGroup(frag, c, level + 1, off);
    for (const r of g.rows) frag.appendChild(rowEl(r, level + 1));
  }

  /* ================= rendering ================= */

  function rowEl(r, level) {
    const tr = document.createElement('tr');
    tr.dataset.id = r.id;
    tr.className = `row lvl${level}${r.hidden ? ' hid' : ''}${State.S.selection.has(r.id) ? ' sel' : ''}`;
    const d = r.date ? new Date(r.date) : null;
    const dateStr = d ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
    tr.innerHTML =
      `<td>${r.idx + 1}</td><td>${r.page}</td><td>${esc(r.subject)}</td>` +
      `<td title="${esc(r.label)}">${esc(r.label)}</td>` +
      `<td>${esc(r.measure)}</td>` +
      `<td><span class="color-chip" style="background:${r.color || '#888'}"></span></td>` +
      `<td>${esc(r.author)}</td><td>${dateStr}</td>` +
      `<td><button class="row-del" title="Delete this markup">✕</button></td>`;
    tr.addEventListener('click', e => {
      if (e.target.classList.contains('row-del')) { State.deleteMarkups([r.id]); return; }
      const m = State.getMarkup(r.id);
      if (!m) return;
      if (State.isHidden(m)) {
        Viewer.flashMarkup(m);
        App.toast('This markup is hidden on the drawing — tap the eye on its group to show it.', 'info', 3500);
        return;
      }
      State.select([r.id], e.shiftKey);
      Viewer.flashMarkup(m);
    });
    return tr;
  }

  function render() {
    const rows = visibleRows();
    const hiddenN = State.S.markups.reduce((a, m) => a + (State.isHidden(m) ? 1 : 0), 0);
    els.count.textContent = `(${State.S.markups.length}${hiddenN ? ' · ' + hiddenN + ' hidden' : ''})`;
    if (els.showAll) els.showAll.hidden = !State.anyGroupHidden();
    const frag = document.createDocumentFragment();
    if (groupMode === 'none') for (const r of rows) frag.appendChild(rowEl(r, 0));
    else for (const g of buildTree(rows)) appendGroup(frag, g, 0, false);
    els.rows.innerHTML = '';
    els.rows.appendChild(frag);
  }

  function refreshTypeFilter() {
    const types = [...new Set(State.S.markups.map(m => m.type))].sort();
    const cur = els.typeFilter.value;
    els.typeFilter.innerHTML = '<option value="">All types</option>' +
      types.map(t => `<option value="${t}"${t === cur ? ' selected' : ''}>${esc(Props.typeName(t))}</option>`).join('');
  }

  /* ================= takeoff computation ================= */

  const dayOf = m => m.day || (m.date || '').slice(0, 10);

  /** filter: null = everything; { day: 'YYYY-MM-DD' } = that work day only. */
  function computeTakeoff(filter) {
    const pipes = new Map();     // key size|material
    const symbols = new Map();
    const counts = new Map();
    const penetrations = new Map();  // key size|type|fire
    const fittings = new Map();      // key fitId|size
    const otherMeasures = [];
    let pipeTotalFt = 0, pipeTotalKnown = true, pipeRunCount = 0;

    const src = filter && filter.day
      ? State.S.markups.filter(m => dayOf(m) === filter.day)
      : State.S.markups;

    for (const m of src) {
      if (m.type === 'fitting') {
        const ft = Symbols.fittingById(m.fitId);
        const key = `${m.fitId}|${m.pipeSize || ''}`;
        const cur = fittings.get(key) || {
          fitId: m.fitId, code: ft ? ft.code : m.fitId, name: ft ? ft.name : 'Fitting',
          size: m.pipeSize || '', count: 0,
        };
        cur.count++;
        fittings.set(key, cur);
        continue;
      }
      if (m.type === 'pipe') {
        pipeRunCount++;
        const key = `${m.pipeSize}|${m.material || ''}`;
        const ft = State.lengthFt(m);
        const cur = pipes.get(key) || { size: m.pipeSize, material: m.material || '', color: m.color, count: 0, totalFt: 0, known: true };
        cur.count++;
        if (ft == null) cur.known = false;
        else cur.totalFt += ft;
        pipes.set(key, cur);
        if (ft == null) pipeTotalKnown = false;
        else pipeTotalFt += ft;
      } else if (m.type === 'symbol') {
        const sym = Symbols.byId(m.symbolId);
        const name = sym ? sym.name : m.symbolId;
        symbols.set(name, (symbols.get(name) || 0) + 1);
      } else if (m.type === 'stamp') {
        const name = `Stamp: ${m.text}`;
        symbols.set(name, (symbols.get(name) || 0) + 1);
      } else if (m.type === 'penet') {
        const key = `${m.penSize || '?'}|${m.penType || ''}|${m.penFire ? 1 : 0}`;
        const cur = penetrations.get(key) || { size: m.penSize || '?', type: m.penType || '', fire: !!m.penFire, count: 0 };
        cur.count++;
        penetrations.set(key, cur);
      } else if (m.type === 'count') {
        const g = State.countGroup(m.groupId);
        const key = g ? g.id : '?';
        const cur = counts.get(key) || { name: g ? g.name : 'Count', color: g ? g.color : '#888', count: 0 };
        cur.count++;
        counts.set(key, cur);
      } else if (m.type === 'mlength' || m.type === 'mpoly' || m.type === 'marea') {
        const v = Render.measureLabel(m);
        otherMeasures.push({ name: `${m.subject || m.type} (p${m.page})`, value: v || 'no scale' });
      }
    }

    const sizeOrder = new Map(Symbols.PIPE_SIZES.map((s, i) => [s, i]));
    return {
      pipes: [...pipes.values()]
        .map(p => ({ ...p, totalFt: p.known ? p.totalFt : null }))
        .sort((a, b) => (sizeOrder.get(a.size) ?? 99) - (sizeOrder.get(b.size) ?? 99) || a.material.localeCompare(b.material)),
      pipeTotalFt: pipeTotalKnown && pipeRunCount ? pipeTotalFt : (pipeRunCount ? null : 0),
      pipeRunCount,
      symbols: [...symbols.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
      counts: [...counts.values()],
      penetrations: [...penetrations.values()].sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }) || a.type.localeCompare(b.type)),
      fittings: [...fittings.values()].sort((a, b) =>
        a.name.localeCompare(b.name) || (sizeOrder.get(a.size) ?? 99) - (sizeOrder.get(b.size) ?? 99)),
      otherMeasures,
    };
  }

  /* ================= CSV export ================= */

  const csvCell = v => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  /** Stable row keys so export prefs can exclude individual schedule rows. */
  const rowKeys = {
    pipes: p => `${p.size}|${p.material}`,
    fittings: s => s.name,
    pressfit: f => `${f.fitId}|${f.size}`,
    penetrations: p => `${p.size}|${p.type}|${p.fire ? 1 : 0}`,
    counts: c => c.name,
  };

  /** AroFlo-friendly material code for a press fitting row, e.g. IMPRESS-E90-54MM. */
  const fittingCode = f => `IMPRESS-${f.code}-${String(f.size).replace(/[^0-9a-z.]/gi, '').toUpperCase() || 'NA'}`;

  /**
   * Export the schedule. `prefs` selects what goes in:
   *   { sections: {pipes, fittings, penetrations, counts, other, list},
   *     exclude: {pipes: [keys…], …}, note: '…' }
   * No prefs = everything (legacy behavior). Totals recompute over included rows.
   */
  function exportCsv(prefs) {
    const P = prefs || { sections: { pipes: 1, fittings: 1, pressfit: 1, penetrations: 1, counts: 1, other: 1, list: 1 }, exclude: {}, note: '' };
    const inc = sec => P.sections[sec] === undefined ? true : !!P.sections[sec];
    const excluded = sec => new Set((P.exclude && P.exclude[sec]) || []);
    const dayFilter = P.dayScope && P.dayScope.mode === 'day' ? { day: P.dayScope.day } : null;

    const fmt = State.S.unitFormat;
    const lines = [];
    lines.push(['AirMark markup export', Project.displayName(), State.S.fileName, new Date().toLocaleString()].map(csvCell).join(','));
    const pd = Project.details();
    const who = [pd.site && 'SITE: ' + pd.site, pd.client && 'CLIENT: ' + pd.client, pd.contractor && 'CONTRACTOR: ' + pd.contractor,
      (pd.contact || pd.phone) && 'CONTACT: ' + [pd.contact, pd.phone].filter(Boolean).join(' ')].filter(Boolean);
    if (who.length) lines.push(who.map(csvCell).join(','));
    if (State.S.jobRef) lines.push(csvCell('JOB/TASK: ' + State.S.jobRef));
    if (dayFilter) lines.push(csvCell('SCOPE: work day ' + dayFilter.day + ' only'));
    if (P.note && P.note.trim()) lines.push(csvCell('NOTE: ' + P.note.trim()));
    lines.push('');

    const to = computeTakeoff(dayFilter);

    if (inc('pipes')) {
      const ex = excluded('pipes');
      const rows = to.pipes.filter(p => !ex.has(rowKeys.pipes(p)));
      if (rows.length) {
        lines.push('PIPE TAKEOFF');
        lines.push(['Size', 'Material', 'Runs', `Total length (${fmt === 'm' ? 'm' : 'ft'})`, 'Total length (formatted)'].join(','));
        let totFt = 0, totKnown = true, totRuns = 0;
        for (const p of rows) {
          const raw = p.totalFt == null ? '' : (fmt === 'm' ? (p.totalFt / Units.FT_PER_M).toFixed(2) : p.totalFt.toFixed(2));
          lines.push([p.size, p.material, p.count, raw, p.totalFt == null ? 'not calibrated' : Units.fmtLen(p.totalFt, fmt)].map(csvCell).join(','));
          totRuns += p.count;
          if (p.totalFt == null) totKnown = false; else totFt += p.totalFt;
        }
        const raw = !totKnown ? '' : (fmt === 'm' ? (totFt / Units.FT_PER_M).toFixed(2) : totFt.toFixed(2));
        lines.push(['TOTAL', '', totRuns, raw, !totKnown ? '' : Units.fmtLen(totFt, fmt)].map(csvCell).join(','));
        lines.push('');
      }
    }

    if (inc('fittings')) {
      const ex = excluded('fittings');
      const rows = to.symbols.filter(s => !ex.has(rowKeys.fittings(s)));
      if (rows.length) {
        lines.push('FITTINGS & EQUIPMENT');
        lines.push('Item,Qty');
        for (const s of rows) lines.push([s.name, s.count].map(csvCell).join(','));
        lines.push('');
      }
    }

    if (inc('pressfit')) {
      const ex = excluded('pressfit');
      const rows = to.fittings.filter(f => !ex.has(rowKeys.pressfit(f)));
      if (rows.length) {
        lines.push('PRESS FITTINGS (IBEX IMPRESS)');
        lines.push('Code,Fitting,Size,Qty');
        for (const f of rows) lines.push([fittingCode(f), f.name, f.size, f.count].map(csvCell).join(','));
        lines.push(['TOTAL', '', '', rows.reduce((a, r) => a + r.count, 0)].join(','));
        lines.push('');
      }
    }

    if (inc('penetrations')) {
      const ex = excluded('penetrations');
      const rows = to.penetrations.filter(p => !ex.has(rowKeys.penetrations(p)));
      if (rows.length) {
        lines.push('PENETRATION SCHEDULE');
        lines.push('Core diameter,Through,Fire-rated,Qty');
        for (const p of rows) lines.push([`Ø${p.size}`, p.type, p.fire ? 'YES' : '', p.count].map(csvCell).join(','));
        lines.push(['TOTAL', '', '', rows.reduce((a, r) => a + r.count, 0)].join(','));
        lines.push('');
      }
    }

    if (inc('counts')) {
      const ex = excluded('counts');
      const rows = to.counts.filter(c => !ex.has(rowKeys.counts(c)));
      if (rows.length) {
        lines.push('COUNTS');
        lines.push('Group,Qty');
        for (const c of rows) lines.push([c.name, c.count].map(csvCell).join(','));
        lines.push('');
      }
    }

    if (inc('other') && to.otherMeasures.length) {
      lines.push('OTHER MEASUREMENTS');
      lines.push('Measurement,Value');
      for (const o of to.otherMeasures) lines.push([o.name, o.value].map(csvCell).join(','));
      lines.push('');
    }

    if (inc('list')) {
      lines.push(dayFilter ? `MARKUPS — ${dayFilter.day}` : 'ALL MARKUPS');
      lines.push(['#', 'Page', 'Type', 'Subject', 'Label/Comments', 'Measurement', 'Day', 'Color', 'Author', 'Date'].join(','));
      State.S.markups.forEach((m, i) => {
        if (dayFilter && dayOf(m) !== dayFilter.day) return;
        const r = rowData(m, i);
        lines.push([r.idx + 1, r.page, r.type, r.subject, r.label, r.measure, dayOf(m), r.color, r.author, r.date].map(csvCell).join(','));
      });
    }

    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    App.download(blob, (State.S.fileName || 'markups').replace(/\.pdf$/i, '') + ' - takeoff.csv');
    App.toast('Schedule exported.', 'ok');
  }

  /* ================= init ================= */

  function init() {
    els = {
      panel: document.getElementById('listPanel'),
      rows: document.getElementById('listRows'),
      count: document.getElementById('listCount'),
      search: document.getElementById('listSearch'),
      typeFilter: document.getElementById('listTypeFilter'),
      pageOnly: document.getElementById('listPageOnly'),
      toggle: document.getElementById('listToggle'),
      group: document.getElementById('listGroup'),
      showAll: document.getElementById('listShowAll'),
    };

    els.toggle.addEventListener('click', () => els.panel.classList.toggle('collapsed'));
    els.search.addEventListener('input', render);
    els.typeFilter.addEventListener('change', render);
    els.pageOnly.addEventListener('change', render);
    if (els.group) {
      els.group.value = groupMode;
      els.group.addEventListener('change', () => {
        groupMode = els.group.value;
        try { localStorage.setItem('abmt:listgroup', groupMode); } catch (e) { /* ignore */ }
        render();
      });
    }
    if (els.showAll) els.showAll.addEventListener('click', () => State.showAllGroups());

    document.querySelectorAll('#listTable th[data-k]').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.dataset.k;
        if (sortKey === k) sortDir *= -1;
        else { sortKey = k; sortDir = 1; }
        render();
      });
    });

    document.getElementById('btnDeleteSel').addEventListener('click', () =>
      State.deleteMarkups([...State.S.selection]));

    let t = null;
    const slow = () => { clearTimeout(t); t = setTimeout(() => { refreshTypeFilter(); render(); }, 120); };
    State.on('markups', slow);
    State.on('selection', slow);
    State.on('scale', slow);
    State.on('page', slow);
    State.on('doc', slow);
    State.on('countGroups', slow);
    State.on('view', render);   // collapse / hide toggles repaint at once

    render();
  }

  return { init, render, computeTakeoff, exportCsv, rowKeys, fittingCode, dayOf };
})();
