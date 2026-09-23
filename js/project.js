/* ============ project.js — save/load .airmark projects, localStorage autosave ============ */
'use strict';

const Project = (() => {

  const EMBED_LIMIT = 50 * 1024 * 1024;   // embed the PDF in the project below this size
  let pendingData = null;                  // project data waiting for its PDF
  let quotaWarned = false;

  /* ---------- (de)serialization ---------- */

  function serialize(includePdf) {
    const S = State.S;
    // carry only images that a photo markup still references
    const usedImages = {};
    for (const m of S.markups) {
      if (m.type === 'photo' && m.imgId && S.images[m.imgId]) usedImages[m.imgId] = S.images[m.imgId];
    }
    const data = {
      app: 'AirMark', version: 1, savedAt: new Date().toISOString(),
      fileName: S.fileName, fingerprint: S.fingerprint,
      unitFormat: S.unitFormat, author: S.author, idCounter: S.idCounter,
      pageScales: S.pageScales, defaultScale: S.defaultScale,
      countGroups: S.countGroups, markups: S.markups,
      images: usedImages,
      defaults: S.defaults, activeCountGroup: S.activeCountGroup,
      exportPrefs: S.exportPrefs,
      workDay: S.workDay, dayMode: S.dayMode, jobRef: S.jobRef, activeFitting: S.activeFitting,
      aroSite: S.aroSite,
      project: S.project,
      revisions: S.revisions,
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
    S.images = Object.assign({}, S.images, data.images || {});
    S.pageScales = data.pageScales || {};
    S.defaultScale = data.defaultScale || null;
    S.activeCountGroup = data.activeCountGroup || (S.countGroups[0] && S.countGroups[0].id) || null;
    if (data.exportPrefs) S.exportPrefs = data.exportPrefs;
    if (data.jobRef != null) S.jobRef = data.jobRef;
    if (data.aroSite) S.aroSite = data.aroSite;
    S.project = data.project && typeof data.project === 'object' ? data.project : null;
    S.revisions = Array.isArray(data.revisions) ? data.revisions.filter(r => r && r.fp) : [];
    if (data.activeFitting) S.activeFitting = data.activeFitting;
    if (data.workDay) S.workDay = data.workDay;
    if (data.dayMode != null) S.dayMode = !!data.dayMode;
    // day migration: older markups get their day from their timestamp
    for (const m of S.markups) {
      if (!m.day) m.day = (m.date || '').slice(0, 10) || S.workDay;
    }
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
    State.emit('day'); State.emit('project');
    Render.drawPage();
  }

  /* ---------- project details: name, site, builder / client, contractor, on-site contact ---------- */

  const details = () => State.S.project || {};

  /** What the job is called everywhere — the project name if set, else the file name without .pdf. */
  const displayName = () => String(details().name || String(State.S.fileName || 'Drawing').replace(/\.pdf$/i, '')).trim() || 'Drawing';

  function setDetails(patch) {
    const cur = Object.assign({}, details());
    for (const k of Object.keys(patch || {})) {
      if (k === 'spFolder') {
        // the project's SharePoint drawings folder: {id, name, path} or nothing
        const f = patch[k];
        if (f && typeof f === 'object' && f.id) cur.spFolder = { id: String(f.id), name: String(f.name || ''), path: String(f.path || '') };
        else delete cur.spFolder;
      } else cur[k] = String(patch[k] == null ? '' : patch[k]).trim();
    }
    State.S.project = Object.values(cur).some(Boolean) ? cur : null;
    State.emit('project');
    State.touch();
  }

  /** The project's linked SharePoint drawings folder, if any. */
  const spFolder = () => { const f = details().spFolder; return f && typeof f === 'object' && f.id ? f : null; };

  /* ---------- status: In progress → DLP (defects liability period) → Completed / archived ---------- */

  const STATUSES = { active: 'In progress', dlp: 'DLP', done: 'Completed' };
  const normStatus = s => (Object.prototype.hasOwnProperty.call(STATUSES, String(s || '')) ? String(s) : 'active');
  const status = () => normStatus(details().status);
  const statusLabel = s => STATUSES[normStatus(s)];
  function setStatus(s) { setDetails({ status: normStatus(s) }); }

  /* ---------- revisions: an updated sheet replaces the PDF, the work stays ---------- */

  let revisionImport = false;   // while a new revision opens: apply the carried data, skip the "different PDF" warning

  /**
   * Replace the open drawing's PDF with a newer revision. Markups, details,
   * zones, stock link and status carry over; the sheet being replaced is kept
   * as Rev N (its PDF stays in the device store, and goes up to the team cloud
   * on the next save) so Compare can overlay it. The project now lives under
   * the new drawing's fingerprint: device record, autosave, view prefs and the
   * cloud registry row all move with it.
   */
  async function importRevision(bytes, fileName) {
    const S = State.S;
    if (!S.pdf) { await Viewer.openPdf(bytes, fileName); return; }
    // the current sheet's last change goes out first, so the cloud map is
    // settled (right version) before the project is re-keyed
    State.flushAutosave();
    if (typeof Cloud !== 'undefined' && Cloud.settle) await Cloud.settle();
    const oldFp = S.fingerprint;
    const old = {
      fp: oldFp, fileName: S.fileName, label: 'Rev ' + ((S.revisions || []).length + 1),
      when: new Date().toISOString(), pages: S.pageCount, w: S.pageW, h: S.pageH,
    };
    if (S.pdfBytes) await Store.savePdf(oldFp, S.pdfBytes);   // the sheet Compare will overlay
    const data = serialize(false);
    data.revisions = [...(S.revisions || []), old];
    let oldView = null;
    try { oldView = localStorage.getItem('abmt:view:' + oldFp); } catch (e) { /* ignore */ }
    pendingData = data;
    revisionImport = true;
    try {
      await Viewer.openPdf(bytes, fileName, {
        // re-key before 'doc' fires: the cloud push it schedules must already
        // know this is the same project under a new fingerprint
        beforeEmit: fp => {
          if (fp === oldFp) return;
          if (typeof Cloud !== 'undefined' && Cloud.rekey) Cloud.rekey(oldFp, fp);
          if (typeof Drawings !== 'undefined' && Drawings.rekey) Drawings.rekey(oldFp, fp);
        },
      });
    } finally { revisionImport = false; pendingData = null; }
    const newFp = S.fingerprint;
    if (newFp === oldFp) {
      S.revisions = (S.revisions || []).filter(r => r.fp !== oldFp);
      App.toast('That is the same PDF as the current revision — nothing changed.', 'info', 5000);
      return;
    }
    try {
      localStorage.removeItem('abmt:doc:' + oldFp);
      if (oldView) localStorage.setItem('abmt:view:' + newFp, oldView);
    } catch (e) { /* ignore */ }
    await Store.deleteProject(oldFp);
    autosave();
    State.emit('project');
    const n = S.markups.length;
    App.toast(`${old.label} kept — ${n} markup${n === 1 ? '' : 's'} carried onto ${String(fileName).replace(/\.pdf$/i, '')}. Compare overlays the old sheet.`, 'good', 7000);
    // a different sheet size: the markups were drawn in the old sheet's units
    const sx = old.w ? S.pageW / old.w : 1, sy = old.h ? S.pageH / old.h : 1;
    if (Math.abs(sx - 1) > 0.005 || Math.abs(sy - 1) > 0.005) {
      App.toast(`The new revision is a different sheet size (${Math.round(sx * 100)}% wide, ${Math.round(sy * 100)}% high). Scale the markups to match?`, 'warn', 0, [
        { label: 'Scale markups', run: () => scaleMarkups(sx, sy) },
        { label: 'Leave them', run: () => {} },
      ]);
    }
  }

  /** Stretch every markup (and the calibration) by sx / sy — for a revision printed at another sheet size. */
  function scaleMarkups(sx, sy) {
    const S = State.S;
    State.pushUndo();
    const sc = p => { p.x *= sx; p.y *= sy; };
    for (const m of S.markups) {
      if (Array.isArray(m.pts)) m.pts.forEach(sc);
      if (m.x != null) m.x *= sx;
      if (m.y != null) m.y *= sy;
      if (m.w != null) m.w *= sx;
      if (m.h != null) m.h *= sy;
      if (m.anchor) sc(m.anchor);
    }
    // the same real-world foot now spans f times as many page units
    const f = (sx + sy) / 2;
    if (S.defaultScale) S.defaultScale = { ftPerUnit: S.defaultScale.ftPerUnit / f };
    for (const k of Object.keys(S.pageScales)) S.pageScales[k] = { ftPerUnit: S.pageScales[k].ftPerUnit / f };
    State.emit('markups'); State.emit('scale');
    State.touch();
    App.toast('Markups scaled onto the new sheet.', 'ok', 3000);
  }

  function removeRevision(fp) {
    State.S.revisions = (State.S.revisions || []).filter(r => r.fp !== fp);
    State.emit('project');
    State.touch();
  }

  /* ---------- closing and removing ---------- */

  /** Close the open drawing: nothing stays on screen, Home takes over. */
  function closeDoc() {
    const S = State.S;
    if (!S.pdf) return;
    Viewer.closeDoc();
    State.resetDoc();
    S.pdf = null; S.pdfBytes = null; S.fileName = ''; S.fingerprint = ''; S.pageCount = 0; S.page = 1;
    S.pageW = 0; S.pageH = 0; S.jobRef = ''; S.exportPrefs = null;
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* file:// etc. */ }
    State.emit('doc');
    if (typeof Home !== 'undefined') Home.setMode('home');
  }

  /** Remove a project from this device: record, PDF, thumbnails, earlier revisions, autosave and view prefs. */
  async function removeFromDevice(fp) {
    if (!fp) return;
    const wasOpen = !!State.S.pdf && State.S.fingerprint === fp;
    const rec = await Store.record(fp);
    const revFps = new Set((rec && rec.data && Array.isArray(rec.data.revisions) ? rec.data.revisions : []).map(r => r && r.fp).filter(Boolean));
    if (wasOpen) {
      for (const r of State.S.revisions || []) if (r.fp) revFps.add(r.fp);
      // nothing pending is worth keeping, and no push must run for a project being removed
      State.discardAutosave();
      if (typeof Cloud !== 'undefined' && Cloud.forget) Cloud.forget(fp);
      closeDoc();
    }
    await Store.deleteProject(fp);
    await Store.deletePdf(fp);
    await Store.deleteThumb(fp);
    for (const rf of revFps) { await Store.deletePdf(rf); await Store.deleteThumb(rf); }
    try { localStorage.removeItem('abmt:doc:' + fp); localStorage.removeItem('abmt:view:' + fp); } catch (e) { /* ignore */ }
    if (typeof Cloud !== 'undefined' && Cloud.forget) Cloud.forget(fp);
    if (typeof Drawings !== 'undefined' && Drawings.forget) Drawings.forget(fp);
    if (typeof Home !== 'undefined') Home.refresh();
  }

  /** An empty project record for a sheet stored on the device before it is ever opened (drawings-panel downloads). */
  function blankData(fileName, fingerprint, snap) {
    const d = {
      app: 'AirMark', version: 1, savedAt: new Date().toISOString(),
      fileName, fingerprint, markups: [], countGroups: [], pageScales: {}, defaultScale: null,
      images: {}, idCounter: 1, revisions: [],
    };
    if (snap && snap.project) d.project = { ...snap.project };
    if (snap && snap.aroSite) d.aroSite = { ...snap.aroSite };
    if (snap && snap.jobRef) d.jobRef = snap.jobRef;
    return d;
  }

  /* ---------- another drawing for the same project: the details come along ---------- */

  const detailsSnapshot = () => ({
    project: State.S.project ? { ...State.S.project } : null,
    aroSite: State.S.aroSite ? { ...State.S.aroSite } : null,
    jobRef: State.S.jobRef || '',
  });

  function adoptDetails(snap) {
    if (!snap) return;
    const S = State.S;
    if (snap.project) S.project = { ...snap.project };
    if (snap.aroSite) S.aroSite = { ...snap.aroSite };
    if (snap.jobRef) S.jobRef = snap.jobRef;
    State.emit('project');
    State.touch();
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
    // stash the PDF on the device so a home-screen icon can reopen it offline
    if (S.fingerprint && S.pdfBytes) Store.savePdf(S.fingerprint, S.pdfBytes);
    if (pendingData) {
      const d = pendingData;
      pendingData = null;
      if (!revisionImport && d.fingerprint && d.fingerprint !== S.fingerprint) {
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
    // offline copy first — IndexedDB has its own (much larger) quota
    Store.saveProject(State.S.fingerprint, displayName(), serialize(false));
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

  /** Reopen a project from the on-device store (works offline). */
  async function openFromStore(fingerprint) {
    const rec = await Store.get(fingerprint);
    if (!rec || !rec.pdf) {
      App.toast('That project is no longer stored on this device — open its PDF or .airmark file.', 'warn', 7000);
      return false;
    }
    pendingData = rec.data; // onDocOpened applies it and skips the restore offer
    await Viewer.openPdf(new Uint8Array(rec.pdf), (rec.data && rec.data.fileName) || rec.name || 'drawing.pdf');
    App.toast(`“${rec.name}” reopened from this device.`, 'ok');
    return true;
  }

  function init() {
    State.on('autosave', autosave);
    State.on('doc', onDocOpened);
  }

  return {
    init, saveProject, openProjectFile, serialize, applyData, openFromStore, details, displayName, setDetails, spFolder,
    status, statusLabel, normStatus, setStatus,
    importRevision, scaleMarkups, removeRevision, detailsSnapshot, adoptDetails, blankData,
    closeDoc, removeFromDevice,
  };
})();
