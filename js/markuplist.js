/* ============ markuplist.js — Bluebeam-style markups list + takeoff + CSV ============ */
'use strict';

const MarkupList = (() => {

  let sortKey = 'idx', sortDir = 1;
  let els = {};

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  /* ================= row model ================= */

  function rowData(m, idx) {
    const meas = Render.measureLabel(m);
    let label = '';
    if (m.type === 'pipe') label = [m.pipeSize, m.material, m.system].filter(Boolean).join(' · ');
    else if (m.type === 'text' || m.type === 'callout') label = (m.text || '').replace(/\n/g, ' ');
    else if (m.type === 'count') { const g = State.countGroup(m.groupId); label = g ? g.name : ''; }
    if (m.comment) label = label ? `${label} — ${m.comment}` : m.comment;
    return {
      id: m.id, idx, page: m.page,
      subject: m.subject || m.type,
      label,
      measure: meas,
      measureVal: State.lengthFt(m) ?? State.areaFt(m) ?? -1,
      color: m.color,
      author: m.author || '',
      date: m.date || '',
      type: m.type,
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

  /* ================= rendering ================= */

  function render() {
    const rows = visibleRows();
    els.count.textContent = `(${State.S.markups.length})`;
    const sel = State.S.selection;
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.dataset.id = r.id;
      if (sel.has(r.id)) tr.classList.add('sel');
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
        State.select([r.id], e.shiftKey);
        Viewer.flashMarkup(m);
      });
      frag.appendChild(tr);
    }
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

  function computeTakeoff() {
    const pipes = new Map();     // key size|material
    const symbols = new Map();
    const counts = new Map();
    const otherMeasures = [];
    let pipeTotalFt = 0, pipeTotalKnown = true, pipeRunCount = 0;

    for (const m of State.S.markups) {
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
      otherMeasures,
    };
  }

  /* ================= CSV export ================= */

  const csvCell = v => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  function exportCsv() {
    const fmt = State.S.unitFormat;
    const lines = [];
    lines.push(['AirMark markup export', State.S.fileName, new Date().toLocaleString()].map(csvCell).join(','));
    lines.push('');

    const to = computeTakeoff();
    lines.push('PIPE TAKEOFF');
    lines.push(['Size', 'Material', 'Runs', `Total length (${fmt === 'm' ? 'm' : 'ft'})`, 'Total length (formatted)'].join(','));
    for (const p of to.pipes) {
      const raw = p.totalFt == null ? '' : (fmt === 'm' ? (p.totalFt / Units.FT_PER_M).toFixed(2) : p.totalFt.toFixed(2));
      lines.push([p.size, p.material, p.count, raw, p.totalFt == null ? 'not calibrated' : Units.fmtLen(p.totalFt, fmt)].map(csvCell).join(','));
    }
    if (to.pipeRunCount) {
      const raw = to.pipeTotalFt == null ? '' : (fmt === 'm' ? (to.pipeTotalFt / Units.FT_PER_M).toFixed(2) : to.pipeTotalFt.toFixed(2));
      lines.push(['TOTAL', '', to.pipeRunCount, raw, to.pipeTotalFt == null ? '' : Units.fmtLen(to.pipeTotalFt, fmt)].map(csvCell).join(','));
    }
    lines.push('');

    if (to.symbols.length) {
      lines.push('FITTINGS & EQUIPMENT');
      lines.push('Item,Qty');
      for (const s of to.symbols) lines.push([s.name, s.count].map(csvCell).join(','));
      lines.push('');
    }
    if (to.counts.length) {
      lines.push('COUNTS');
      lines.push('Group,Qty');
      for (const c of to.counts) lines.push([c.name, c.count].map(csvCell).join(','));
      lines.push('');
    }

    lines.push('ALL MARKUPS');
    lines.push(['#', 'Page', 'Type', 'Subject', 'Label/Comments', 'Measurement', 'Color', 'Author', 'Date'].join(','));
    State.S.markups.forEach((m, i) => {
      const r = rowData(m, i);
      lines.push([r.idx + 1, r.page, r.type, r.subject, r.label, r.measure, r.color, r.author, r.date].map(csvCell).join(','));
    });

    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    App.download(blob, (State.S.fileName || 'markups').replace(/\.pdf$/i, '') + ' - takeoff.csv');
    App.toast('CSV exported — pipe takeoff, counts and full markup list.', 'ok');
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
    };

    els.toggle.addEventListener('click', () => els.panel.classList.toggle('collapsed'));
    els.search.addEventListener('input', render);
    els.typeFilter.addEventListener('change', render);
    els.pageOnly.addEventListener('change', render);

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

    render();
  }

  return { init, render, computeTakeoff, exportCsv };
})();
