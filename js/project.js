/* ============ project.js — save/load .airmark projects, localStorage autosave ============ */
'use strict';

const Project = (() => {

  const EMBED_LIMIT = 50 * 1024 * 1024;   // embed the PDF in the project below this size
  let pendingData = null;                  // project data waiting for its PDF
  let quotaWarned = false;

  /* ---------- (de)serialization ---------- */

  function serialize(includePdf) {
    const S = State.S;
    const data = {
      app: 'AirMark', version: 1, savedAt: new Date().toISOString(),
      fileName: S.fileName, fingerprint: S.fingerprint,
      unitFormat: S.unitFormat, author: S.author, idCounter: S.idCounter,
      pageScales: S.pageScales, defaultScale: S.defaultScale,
      countGroups: S.countGroups, markups: S.markups,
      defaults: S.defaults, activeCountGroup: S.activeCountGroup,
    };
    if (includePdf && S.pdfBytes && S.pdfBytes.length < EMBED_LIMIT) {
      data.pdfBase64 = bytesToBase64(S.pdfBytes);
    }
    return data;
  }

  function applyData(data) {
    const S = State.S;
    S.markups = data.markups || [];
    S.countGroups = data.countGroups || [];
    S.pageScales = data.pageScales || {};
    S.defaultScale = data.defaultScale || null;
    S.activeCountGroup = data.activeCountGroup || (S.countGroups[0] && S.countGroups[0].id) || null;
    if (data.defaults) Object.assign(S.defaults, data.defaults);
    if (data.unitFormat) S.unitFormat = data.unitFormat;
    // id counter must clear every existing id
    let maxId = data.idCounter || 1;
    for (const m of S.markups) {
      const n = parseInt(String(m.id).replace(/\D/g, ''), 10);
      if (!isNaN(n) && n >= maxId) maxId = n + 1;
    }
    for (const g of S.countGroups) {
      const n = parseInt(String(g.id).replace(/\D/g, ''), 10);
      if (!isNaN(n) && n >= maxId) maxId = n + 1;
    }
    S.idCounter = maxId;
    State.clearHistory();
    S.selection.clear();
    State.emit('markups'); State.emit('scale'); State.emit('countGroups'); State.emit('selection');
    Render.drawPage();
  }

  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------- save / open ---------- */

  function saveProject() {
    const S = State.S;
    if (!S.pdf) { App.toast('Open a drawing first.', 'warn'); return; }
    const embed = S.pdfBytes && S.pdfBytes.length < EMBED_LIMIT;
    const data = serialize(embed);
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const base = (S.fileName || 'markups').replace(/\.pdf$/i, '');
    App.download(blob, base + '.airmark');
    S.dirty = false;
    App.toast(embed
      ? 'Project saved — drawing and markups in one .airmark file.'
      : 'Project saved (markups only — the PDF is over 50 MB, keep it alongside).', 'ok');
  }

  async function openProjectFile(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (_) {
      App.toast('That file is not a readable AirMark project.', 'err');
      return;
    }
    if (!data || data.app !== 'AirMark') {
      App.toast('That file is not an AirMark project.', 'err');
      return;
    }
    if (data.pdfBase64) {
      const bytes = base64ToBytes(data.pdfBase64);
      await Viewer.openPdf(bytes, data.fileName || 'drawing.pdf');
      applyData(data);
      App.toast(`Project loaded — ${data.markups.length} markups.`, 'ok');
      return;
    }
    // markups-only project
    const S = State.S;
    if (S.pdf && (!data.fingerprint || data.fingerprint === S.fingerprint)) {
      applyData(data);
      App.toast(`Markups loaded onto the open drawing (${data.markups.length}).`, 'ok');
    } else {
      pendingData = data;
      App.toast(`Project references "${data.fileName}". Open that PDF now and the markups will attach automatically.`, 'warn', 9000);
      document.getElementById('filePdf').click();
    }
  }

  /** Called after any PDF opens: attach pending project or offer autosave restore. */
  function onDocOpened() {
    const S = State.S;
    if (pendingData) {
      const d = pendingData;
      pendingData = null;
      if (d.fingerprint && d.fingerprint !== S.fingerprint) {
        App.toast('Heads up — this PDF differs from the one the project was made on. Markups loaded anyway; check alignment.', 'warn', 9000);
      }
      applyData(d);
      return;
    }
    // autosave restore
    const raw = key() && localStorage.getItem(key());
    if (!raw) return;
    try {
      const d = JSON.parse(raw);
      if (!d.markups || !d.markups.length) return;
      const when = d.savedAt ? new Date(d.savedAt).toLocaleString() : 'earlier';
      App.toast(
        `Found ${d.markups.length} autosaved markups for this drawing (${when}).`,
        'ok', 0,
        [
          { label: 'Restore', run: () => applyData(d) },
          { label: 'Discard', run: () => localStorage.removeItem(key()) },
        ]
      );
    } catch (_) { /* corrupted autosave — ignore */ }
  }

  /* ---------- autosave ---------- */

  const key = () => State.S.fingerprint ? 'abmt:doc:' + State.S.fingerprint : null;

  function autosave() {
    const k = key();
    if (!k) return;
    try {
      localStorage.setItem(k, JSON.stringify(serialize(false)));
      App.savedIndicator();
    } catch (err) {
      if (!quotaWarned) {
        quotaWarned = true;
        App.toast('Autosave is off — browser storage is full. Use Save to keep your work.', 'warn', 8000);
      }
    }
  }

  function init() {
    State.on('autosave', autosave);
    State.on('doc', onDocOpened);
  }

  return { init, saveProject, openProjectFile, serialize, applyData };
})();
