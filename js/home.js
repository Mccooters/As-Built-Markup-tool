/* ============ home.js — the home shell: sidebar + landing page ============
 *
 * AirMark opens on a simple Procore-style home: a dark sidebar (Home,
 * Current drawing, Drawings, Site stock, Deliveries; Settings, Help, Log out;
 * account chip) and a page of cards — the drawing you were on, recent
 * projects on this device, the team cloud list and the SharePoint drawing
 * register. The full editor chrome (toolbar, tool rail, properties panel,
 * markups list, status bar) only appears once a drawing is actually open.
 *
 * The same sidebar is reachable at any time: in the editor the ≡ button
 * slides it in as a drawer over the drawing (body.menu-open), so nothing
 * needs to be duplicated in the toolbar. The logo jumps straight Home.
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

  /* ---------------- mode switch + drawer ---------------- */

  const menuOpen = () => document.body.classList.contains('menu-open');
  function openMenu() { document.body.classList.add('menu-open'); refresh(); }
  function closeMenu() { document.body.classList.remove('menu-open'); }
  function toggleMenu() { if (menuOpen()) closeMenu(); else openMenu(); }

  function setMode(m) {
    mode = m === 'editor' ? 'editor' : 'home';
    document.body.classList.toggle('mode-home', mode === 'home');
    document.body.classList.toggle('mode-editor', mode === 'editor');
    document.body.classList.remove('panel-open', 'menu-open');   // no drawer survives a switch
    refresh();
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
    const cl = cloudState();
    const u = whoAmI();
    $('hsAvatar').textContent = u.known ? initials(u.name) : '?';
    $('hsUserName').textContent = u.name;
    $('hsUserSub').textContent = u.sub;
    $('hsSignout').hidden = !u.signed;
    // the Drawings item only exists on deployments with a SharePoint register
    $('hsDrawingsNav').hidden = !(typeof Drawings !== 'undefined' && cl && cl.enabled === true && cl.sp);
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
    const active = mode === 'editor' ? 'drawing' : 'home';
    document.querySelectorAll('#homeSide .hs-item[data-nav]').forEach(b =>
      b.classList.toggle('active', b.dataset.nav === active));
  }

  /* ---------------- navigation ---------------- */

  function focusSignIn() {
    const el = $('cl-name');
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
    el.focus();
  }

  // the sign-in card lives on the Home page — get there first if needed
  function goSignIn() {
    if (mode !== 'home') setMode('home');
    setTimeout(focusSignIn, 60);
  }

  function openDrawings() {
    const cl = cloudState();
    const ready = typeof Drawings !== 'undefined' && cl && cl.enabled === true && cl.sp;
    if (ready && cl.token) { Drawings.openDialog(); return; }
    if (ready) {
      App.toast('Sign in to the team cloud first — the project’s SharePoint drawing register then loads by itself.', 'warn', 6000);
      goSignIn();
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
    const cl = cloudState();
    if (cl && cl.enabled === true) { goSignIn(); return; }   // team cloud available
    App.authorDialog();                                       // otherwise the plain author name
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
    const shell = $('homeShell');
    if (!shell) return;
    document.querySelectorAll('#homeSide .hs-item[data-nav]').forEach(b =>
      b.addEventListener('click', () => { closeMenu(); const fn = NAV[b.dataset.nav]; if (fn) fn(); }));
    $('hsUser').addEventListener('click', () => { closeMenu(); accountTap(); });
    $('hsContBtn').addEventListener('click', () => setMode('editor'));
    // editor: ≡ opens the sidebar as a drawer, the logo jumps straight Home
    const menuBtn = $('btnMenu');
    if (menuBtn) menuBtn.addEventListener('click', toggleMenu);
    const brand = document.querySelector('#toolbar .brand');
    if (brand) brand.addEventListener('click', () => setMode('home'));
    // tapping the dimmed drawing (the shell's own background) closes the drawer
    shell.addEventListener('click', e => { if (e.target === shell && menuOpen()) closeMenu(); });
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && menuOpen()) { e.preventDefault(); closeMenu(); } });
    wireDrop();

    // a drawing opening (file, sample, recents, team cloud, SharePoint,
    // ?proj= deep link) always lands in the editor
    State.on('doc', () => { if (State.S.pdf) setMode('editor'); else refresh(); });
    State.on('autosave', () => { if (mode === 'home' || menuOpen()) refresh(); });
    setMode(State.S.pdf ? 'editor' : 'home');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { setMode, refresh, openMenu, closeMenu, toggleMenu, mode: () => mode };
})();
