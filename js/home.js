/* ============ home.js — the home shell: sidebar + landing page ============
 *
 * AirMark opens on a simple Procore-style home: a dark sidebar (Home,
 * Drawings, Site stock, Deliveries, Settings, account) and a page of cards —
 * the drawing you were on, recent projects on this device, the team cloud
 * list and the SharePoint drawing register. The full editor chrome (two
 * toolbar rows, tool rail, properties panel, markups list, status bar) only
 * appears once a drawing is actually open; the Home button / logo in the
 * editor brings the shell back without closing the drawing.
 *
 * The shell is a fixed overlay toggled by body.mode-home / body.mode-editor
 * rather than display:none on the editor: the viewer keeps its real size
 * underneath, so fit-to-page and pinch maths never meet a 0×0 viewport while
 * a drawing is loading.
 */
'use strict';

const Home = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let mode = 'home';

  /* ---------------- mode switch ---------------- */

  function setMode(m) {
    mode = m === 'editor' ? 'editor' : 'home';
    document.body.classList.toggle('mode-home', mode === 'home');
    document.body.classList.toggle('mode-editor', mode === 'editor');
    document.body.classList.remove('panel-open');     // phone drawer never survives a switch
    if (mode === 'home') refresh();
  }

  /* ---------------- who's using it ---------------- */

  const cloudState = () => (typeof Cloud !== 'undefined' ? Cloud._state : null);

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return parts.length ? parts.slice(0, 2).map(p => p[0].toUpperCase()).join('') : '?';
  }

  function whoAmI() {
    const cl = cloudState();
    if (cl && cl.token && cl.name) return { name: cl.name, sub: 'Team cloud', signed: true, known: true };
    const canSignIn = !!(cl && cl.enabled === true);
    const author = State.S.author && State.S.author !== 'Field' ? State.S.author : '';
    if (author) return { name: author, sub: canSignIn ? 'Tap to sign in' : 'Author name', signed: false, known: true };
    return { name: 'Not signed in', sub: canSignIn ? 'Tap to sign in' : 'Tap to set your name', signed: false, known: false };
  }

  /* ---------------- render ---------------- */

  function refresh() {
    if (!$('homeShell')) return;
    const u = whoAmI();
    $('hsAvatar').textContent = u.known ? initials(u.name) : '?';
    $('hsUserName').textContent = u.name;
    $('hsUserSub').textContent = u.sub;
    $('hsSignout').hidden = !u.signed;
    try {
      $('hsDate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    } catch (e) { $('hsDate').textContent = ''; }

    const hasDoc = !!State.S.pdf;
    $('hsDrawing').hidden = !hasDoc;
    $('hsContinue').hidden = !hasDoc;
    if (hasDoc) {
      $('hsContName').textContent = State.S.fileName || 'Drawing';
      const bits = [];
      if (State.S.pageCount > 1) bits.push(State.S.pageCount + ' pages');
      const n = State.S.markups.length;
      bits.push(n ? n + ' markup' + (n === 1 ? '' : 's') : 'no markups yet');
      const proj = State.S.aroSite && State.S.aroSite.project;
      if (proj) bits.push('AroFlo project ' + proj);
      $('hsContSub').textContent = bits.join(' · ');
    }
  }

  /* ---------------- navigation ---------------- */

  function focusSignIn() {
    const el = $('cl-name');
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
    el.focus();
    return true;
  }

  function openDrawings() {
    const cl = cloudState();
    const ready = typeof Drawings !== 'undefined' && cl && cl.enabled === true && cl.sp;
    if (ready && cl.token) { Drawings.openDialog(); return; }
    if (ready) {
      App.toast('Sign in to the team cloud first — the project’s SharePoint drawing register then loads by itself.', 'warn', 6000);
      focusSignIn();
      return;
    }
    App.toast('The SharePoint drawing register isn’t set up on this deployment yet (see “Site drawings from SharePoint” in the README). PDFs on this device still open from Home.', 'warn', 8000);
  }

  function accountTap() {
    const u = whoAmI();
    if (u.signed) {
      App.modal(`<h3>Account</h3>
        <p class="muted">Signed in to the team cloud as <b>${esc(u.name)}</b>. Markups you place are stamped with this name, and the drawings you open sync to the team list.</p>
        <div class="modal-actions">
          <button class="mini-btn" id="hs-out">Sign out</button>
          <button class="mini-btn primary" id="hs-ok">Done</button>
        </div>`, (box, close) => {
        box.querySelector('#hs-ok').onclick = close;
        box.querySelector('#hs-out').onclick = () => { close(); Cloud.signOut(); refresh(); };
      });
      return;
    }
    if (focusSignIn()) return;          // team cloud available — the sign-in card is on this page
    const btn = $('btnAuthor');         // otherwise the plain author-name dialog
    if (btn) btn.click();
  }

  const NAV = {
    home: () => setMode('home'),
    drawing: () => { if (State.S.pdf) setMode('editor'); },
    drawings: openDrawings,
    stock: () => Aro.openPage(),
    deliveries: () => Aro.deliveriesDialog(),
    settings: () => Aro.settingsDialog(),
    help: () => App.helpDialog(),
    signout: () => { Cloud.signOut(); refresh(); },
  };

  /* ---------------- drag & drop onto the home page ---------------- */

  function wireDrop() {
    const shell = $('homeShell');
    let depth = 0;
    shell.addEventListener('dragenter', e => { e.preventDefault(); depth++; shell.classList.add('dragging'); });
    shell.addEventListener('dragover', e => e.preventDefault());
    shell.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; shell.classList.remove('dragging'); } });
    shell.addEventListener('drop', e => {
      e.preventDefault();
      depth = 0;
      shell.classList.remove('dragging');
      if (e.dataTransfer && e.dataTransfer.files.length) App.handleFiles(e.dataTransfer.files);
    });
  }

  /* ---------------- boot ---------------- */

  function init() {
    if (!$('homeShell')) return;
    document.querySelectorAll('#homeSide .hs-item[data-nav]').forEach(b =>
      b.addEventListener('click', () => { const fn = NAV[b.dataset.nav]; if (fn) fn(); }));
    $('hsUser').addEventListener('click', accountTap);
    $('hsContBtn').addEventListener('click', () => setMode('editor'));
    // the home buttons reuse the toolbar wiring (file pickers, sample loader)
    $('homeOpen').addEventListener('click', () => $('btnOpen').click());
    $('homeLoad').addEventListener('click', () => $('btnOpenProject').click());
    $('homeSample').addEventListener('click', () => $('btnSample').click());
    // editor → home: the Home button and the logo
    const homeBtn = $('btnHome');
    if (homeBtn) homeBtn.addEventListener('click', () => setMode('home'));
    const brand = document.querySelector('#toolbar .brand');
    if (brand) brand.addEventListener('click', () => setMode('home'));
    wireDrop();

    // a drawing opening (file, sample, recents, team cloud, SharePoint,
    // ?proj= deep link) always lands in the editor
    State.on('doc', () => { if (State.S.pdf) setMode('editor'); else refresh(); });
    State.on('autosave', () => { if (mode === 'home') refresh(); });
    setMode(State.S.pdf ? 'editor' : 'home');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { setMode, refresh, mode: () => mode };
})();
