/* ============ store.js — offline project store (IndexedDB) ============
 *
 * Keeps the last few projects — markups AND the PDF itself — on the device,
 * so a home-screen icon can reopen a job with no internet. PDFs are written
 * once per drawing (they never change for a given fingerprint); the project
 * data rides along with every autosave.
 */
'use strict';

const Store = (() => {
  const DB = 'abmt';
  const KEEP = 24; // most-recent projects retained — room for a whole site drawing register
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'fingerprint' });
        if (!db.objectStoreNames.contains('pdfs')) db.createObjectStore('pdfs', { keyPath: 'fingerprint' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  const reqP = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function savePdf(fingerprint, bytes) {
    try {
      const db = await open();
      const have = await reqP(db.transaction('pdfs').objectStore('pdfs').count(fingerprint));
      if (have) return;
      const copy = bytes instanceof Uint8Array ? bytes.slice(0) : new Uint8Array(bytes).slice(0);
      await reqP(db.transaction('pdfs', 'readwrite').objectStore('pdfs').put({ fingerprint, bytes: copy.buffer }));
    } catch (e) { /* storage full or blocked — offline reopen just won't work */ }
  }

  async function saveProject(fingerprint, name, data) {
    try {
      const db = await open();
      await reqP(db.transaction('projects', 'readwrite').objectStore('projects')
        .put({ fingerprint, name, savedAt: Date.now(), data }));
      prune().catch(() => {});
    } catch (e) { /* ignore */ }
  }

  async function get(fingerprint) {
    try {
      const db = await open();
      const rec = await reqP(db.transaction('projects').objectStore('projects').get(fingerprint));
      if (!rec) return null;
      const pdf = await reqP(db.transaction('pdfs').objectStore('pdfs').get(fingerprint));
      return { ...rec, pdf: pdf ? pdf.bytes : null };
    } catch (e) { return null; }
  }

  /** Every project on the device, newest first, with what the list shows about it. */
  async function list() {
    try {
      const db = await open();
      const all = await reqP(db.transaction('projects').objectStore('projects').getAll());
      return all
        .map(r => {
          const d = r.data || {}, pj = d.project || {}, aro = d.aroSite || {};
          return {
            fingerprint: r.fingerprint, name: r.name, savedAt: r.savedAt,
            status: pj.status || 'active', site: pj.site || '', client: pj.client || '',
            aroNo: aro.project || '', jobRef: d.jobRef || '',
            markups: Array.isArray(d.markups) ? d.markups.length : 0,
          };
        })
        .sort((a, b) => b.savedAt - a.savedAt);
    } catch (e) { return []; }
  }

  /** The stored project record alone (no PDF bytes) — for list-side edits such as a status change. */
  async function record(fingerprint) {
    try {
      const db = await open();
      return (await reqP(db.transaction('projects').objectStore('projects').get(fingerprint))) || null;
    } catch (e) { return null; }
  }

  async function prune() {
    const db = await open();
    const all = await reqP(db.transaction('projects').objectStore('projects').getAll());
    const stale = all.sort((a, b) => b.savedAt - a.savedAt).slice(KEEP);
    for (const r of stale) {
      await reqP(db.transaction('projects', 'readwrite').objectStore('projects').delete(r.fingerprint));
      await reqP(db.transaction('pdfs', 'readwrite').objectStore('pdfs').delete(r.fingerprint));
    }
  }

  return { savePdf, saveProject, get, record, list };
})();
