// Leather Hunt app shell: layout, router, live sync, notifications, command palette, shortcuts, pull-to-refresh, offline app.
import { api, icon, toast, openModal, closeModal, applyTheme, getTheme, setTheme, plural, reduceMotion, isTouch, esc, ago, $, $$, debounce } from './core.js';
import { renderHome } from './home.js';
import { renderJackets, leaveJackets, jacketsKey, jacketsArrived, invalidateJackets, renderTray, remoteStatus } from './jackets.js';
import { renderProduct, productKey, productChanged } from './product.js';
import { renderReview, reviewKey } from './review.js';
import { renderHunts, huntUpdate, startHunt, plainError } from './hunts.js';
import { renderCompare } from './compare.js';
import { renderSettings, renderLogin, installApp, signOut } from './settings.js';
import { renderBoards, renderBoard } from './boards.js';
import { renderInsights, renderReport, renderHealth, renderTechPack } from './insights.js';
import { openPalette, photoSearch } from './palette.js';
import { me, setMe, has } from './session.js';

applyTheme();
const app = () => $('#app');
let route = '', liveRun = null, events = null;

// ---------- layout ----------
const NAV = [
  ['', 'home', 'Overview', 'overview.view'], ['jackets', 'grid', 'Jackets', 'jackets.view'], ['review', 'cards', 'Review', 'jackets.review'], ['boards', 'board', 'Boards', 'boards.view'],
  ['insights', 'chart', 'Insights', 'insights.view'], ['hunts', 'radar', 'Hunts', 'hunts.view'], ['settings', 'settings', 'Settings', '']
];
// What each page needs to be opened
const PAGE_PERM = { '': 'overview.view', home: 'overview.view', jackets: 'jackets.view', product: 'jackets.view', compare: 'jackets.view', techpack: 'jackets.view', review: 'jackets.review', hunts: 'hunts.view', boards: 'boards.view', insights: 'insights.view', report: 'insights.view', health: 'health.view' };
const MOBILE = ['', 'jackets', 'review', 'hunts'];
const navLink = ([r, ic, label, perm], cls = '') => `<a href="#/${r}" data-nav="${r}" class="${cls}"${perm ? ` data-perm="${perm}"` : ''}>${icon(ic, 20)}<span>${label}</span>${r === 'review' ? '<em class="nav-badge" data-badge hidden></em>' : ''}${r === 'hunts' ? '<i class="live-dot" data-live hidden></i>' : ''}</a>`;

function shell() {
  const u = me();
  $('#root').innerHTML = `
  <a class="skip" href="#app" onclick="event.preventDefault();document.getElementById('app').focus()">Skip to content</a>
  <aside class="sidebar" aria-label="Main">
    <a class="brand ws" href="#/" aria-label="Morrow Studio home"><img src="/icons/morrow.png" alt="" width="42" height="42"><span><b>MORROW</b><small>STUDIO</small></span></a>
    <button class="side-search" id="palBtn" aria-label="Search and commands (Ctrl+K)">${icon('search', 18)}<span>Search</span><kbd>Ctrl K</kbd></button>
    <nav class="side-nav">${NAV.map(n => navLink(n)).join('')}</nav>
    <div class="side-sec" id="sideBoards" hidden></div>
    <div class="side-foot">
      <button class="side-btn" id="themeBtn" aria-label="Change theme">${icon('moon', 18)}<span>Theme</span></button>
      <button class="side-btn only-install" id="installSide">${icon('install', 18)}<span>Install app</span></button>
      <a class="side-btn" href="#/health" data-perm="health.view">${icon('activity', 18)}<span>Health</span></a>
      <button class="side-user" id="userBtn" data-auth><span class="avatar">${esc((u.name || u.username).split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())}</span><span><b>${esc(u.name)}</b><small>${esc(u.role === 'owner' ? 'Workspace owner' : u.role[0].toUpperCase() + u.role.slice(1))}</small></span>${icon('updown', 15)}</button>
    </div>
  </aside>
  <div class="main-col">
    <header class="topbar">
      <a class="brand mobile-only" href="#/"><img src="/icons/morrow.png" alt="" width="32" height="32"><b>MORROW</b></a>
      <a class="live-pill" id="livePill" href="#/hunts" hidden></a>
      <span class="grow"></span>
      <button class="icon-btn mobile-only" id="palBtn2" aria-label="Search">${icon('search')}</button>
      <div class="menu-wrap"><button class="icon-btn bell" id="bell" aria-label="Notifications" aria-haspopup="true">${icon('bell')}<em class="bell-n" id="bellN" hidden></em></button><div class="menu notif-menu" id="notifMenu" hidden></div></div>
      <button class="btn ghost desktop-only" data-hunt="trend" data-perm="hunts.run">${icon('trend', 16)} Today's trend hunt</button>
      <button class="btn gold" data-hunt="normal" data-perm="hunts.run">${icon('radar', 16)}<span class="desktop-only">Run hunt</span><span class="mobile-only">Hunt</span></button>
    </header>
    <div class="ptr" id="ptr" aria-hidden="true">${icon('refresh', 20)}</div>
    <main id="app" tabindex="-1"></main>
  </div>
  <nav class="bottomnav" aria-label="Main">${NAV.filter(n => MOBILE.includes(n[0])).map(n => navLink(n)).join('')}<button id="moreBtn" data-nav="more">${icon('more', 21)}<span>More</span></button></nav>
  <div class="tray" id="compareTray" hidden></div>`;

  $$('[data-hunt]').forEach(b => b.onclick = async () => {
    if (isTouch() && b.dataset.hunt === 'normal' && window.innerWidth < 760) return huntSheet();
    b.disabled = true; await startHunt(b.dataset.hunt); b.disabled = false;
  });
  $('#palBtn').onclick = () => openPalette();
  $('#palBtn2').onclick = () => openPalette();
  $('#themeBtn').onclick = cycleTheme;
  $('#installSide').onclick = installApp;
  $('#userBtn').onclick = userMenu;
  $('#moreBtn').onclick = moreSheet;
  $('#bell').onclick = toggleNotifs;
  paintThemeBtn();
  paintBoards();
}

// Boards listed in the sidebar like collections
async function paintBoards() {
  const box = $('#sideBoards');
  if (!box) return;
  try {
    const { boards } = await api('/boards');
    box.hidden = false;
    box.innerHTML = `<p class="side-label"><span>Boards</span><em>${String(boards.length).padStart(2, '0')}</em></p>
      ${boards.slice(0, 5).map(b => `<a class="side-board" href="#/boards/${encodeURIComponent(b.id)}"><span style="color:${esc(b.color || '#888')}">${icon('folder', 17)}</span><span>${esc(b.name)}</span>${icon('chevronR', 15)}</a>`).join('')}
      <a class="side-board add" href="#/boards?new=1" data-perm="boards.edit">${icon('plus', 16)}<span>Create board</span></a>`;
  } catch { box.hidden = true; }
}

function huntSheet() {
  const m = openModal(`<h2 class="modal-title">Start a hunt</h2>
    <div class="sheet-list">
      <button class="hunt-card" data-m="normal"><span class="hc-icon">${icon('radar', 24)}</span><span><b>Run hunt</b><small>eBay, Etsy and your websites</small></span></button>
      <button class="hunt-card trend" data-m="trend"><span class="hc-icon">${icon('trend', 24)}</span><span><b>Today's trend hunt</b><small>Google Trends → Google Shopping</small></span></button>
    </div>`, { label: 'Start a hunt' });
  m.classList.add('sheet');
  m.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { closeModal(); startHunt(b.dataset.m); });
}
function moreSheet() {
  const u = me();
  const m = openModal(`<div class="row-between"><h2 class="modal-title">More</h2><button class="icon-btn" data-x aria-label="Close">${icon('x')}</button></div>
    <div class="more-grid">
      ${[['#/boards', 'board', 'Boards', 'boards.view'], ['#/insights', 'chart', 'Insights', 'insights.view'], ['#/report', 'file', 'Weekly report', 'insights.view'], ['#/health', 'activity', 'Health', 'health.view'], ['#/settings', 'settings', 'Settings', ''], ['#/settings/profile', 'user', 'Profile', '']]
        .map(([h, ic, l, p]) => `<a href="${h}" class="more-item" data-close${p ? ` data-perm="${p}"` : ''}>${icon(ic, 22)}<span>${l}</span></a>`).join('')}
      <button class="more-item" id="mPhoto">${icon('camera', 22)}<span>Photo search</span></button>
      <button class="more-item" id="mTheme">${icon('moon', 22)}<span>Theme</span></button>
      <button class="more-item" id="mOut" data-auth>${icon('logout', 22)}<span>Sign out</span></button>
    </div><p class="muted small center">Signed in as ${esc(u.name)} · ${esc(u.role)}</p>`, { label: 'More' });
  m.classList.add('sheet');
  m.querySelector('[data-x]').onclick = closeModal;
  m.querySelectorAll('[data-close]').forEach(a => a.addEventListener('click', () => closeModal()));
  m.querySelector('#mPhoto').onclick = () => { closeModal(); photoSearch(); };
  m.querySelector('#mTheme').onclick = () => { closeModal(); cycleTheme(); };
  m.querySelector('#mOut').onclick = signOut;
}
function userMenu() {
  const u = me();
  const m = openModal(`<div class="user-card"><span class="avatar lg">${esc((u.name || u.username)[0].toUpperCase())}</span><div><b>${esc(u.name)}</b><small class="muted">@${esc(u.username)} · ${esc(u.role)}</small></div></div>
    <div class="menu-list">
      <a href="#/settings/profile" data-close>${icon('user', 17)} Profile & alerts</a>
      ${has('team.view') ? `<a href="#/settings/team" data-close>${icon('users', 17)} Team</a>` : ''}
      <button id="keysItem">${icon('keyboard', 17)} Keyboard shortcuts</button>
      <button id="outItem" class="danger-text">${icon('logout', 17)} Sign out</button>
    </div>`, { label: 'Account' });
  m.querySelectorAll('[data-close]').forEach(a => a.addEventListener('click', () => closeModal()));
  m.querySelector('#keysItem').onclick = () => { closeModal(); showKeys(); };
  m.querySelector('#outItem').onclick = signOut;
}

// ---------- notifications (bell) ----------
let unread = 0;
async function loadNotifs() {
  try { const d = await api('/notifications'); unread = d.unread; paintBell(); return d.items; } catch { return []; }
}
function paintBell() { const n = $('#bellN'); if (n) { n.hidden = !unread; n.textContent = unread > 9 ? '9+' : unread; } }
async function toggleNotifs() {
  const menu = $('#notifMenu');
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.hidden = false;
  menu.innerHTML = '<div class="menu-item muted">Loading…</div>';
  const items = await loadNotifs();
  menu.innerHTML = `<div class="row-between notif-head"><b>Notifications</b>${unread ? '<button class="link-btn" id="readAll">Mark all read</button>' : ''}</div>
    ${items.map(n => `<a class="notif ${n.read ? '' : 'unread'}" href="${n.link ? esc(n.link) : '#/'}"><span>${esc(n.text.split('\n')[0])}</span><small class="muted">${ago(n.at)}</small></a>`).join('') || '<div class="menu-item muted">Nothing yet</div>'}`;
  menu.querySelectorAll('a.notif').forEach(a => a.addEventListener('click', () => { menu.hidden = true; }));
  const readAll = async () => { await api('/notifications/read', { method: 'POST' }); unread = 0; paintBell(); menu.querySelectorAll('.unread').forEach(x => x.classList.remove('unread')); $('#readAll')?.remove(); };
  $('#readAll')?.addEventListener('click', readAll);
  clearTimeout(notifTimer);
  if (unread) notifTimer = setTimeout(() => { if (!menu.hidden) readAll(); }, 2500); // opened (and still open) = seen
}
let notifTimer = null;
// one listener for the whole app: a click outside the menu closes it
document.addEventListener('mousedown', e => {
  const menu = $('#notifMenu');
  if (menu && !menu.hidden && !menu.contains(e.target) && !e.target.closest('#bell')) { menu.hidden = true; clearTimeout(notifTimer); }
});
// last safety net: any action that fails without its own error message now shows one (instead of silently doing nothing)
window.addEventListener('unhandledrejection', e => {
  const err = e.reason;
  if (!err || err.name === 'LoginRequired' || err.name === 'AbortError') return;
  toast(err.message || 'Something did not work - please try again', { kind: 'error', timeout: 7000 });
});

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(getTheme()) + 1) % 3];
  setTheme(next); paintThemeBtn();
  toast(`Theme: ${next === 'auto' ? 'follow system' : next}`);
}
function paintThemeBtn() {
  const t = getTheme(), b = $('#themeBtn');
  if (b) b.innerHTML = `${icon(t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'monitor', 18)}<span>${t === 'auto' ? 'System theme' : t === 'dark' ? 'Dark' : 'Light'}</span>`;
}
function focusSearch() {
  if (!route.startsWith('jackets')) { location.hash = '#/jackets?status=all'; setTimeout(() => $('#q')?.focus(), 350); }
  else $('#q')?.focus();
}

// ---------- router ----------
async function render() {
  const hash = location.hash.slice(2) || '';
  const [path, qs = ''] = hash.split('?');
  const params = new URLSearchParams(qs);
  const [section, id] = path.split('/');
  if (route === 'jackets' && section !== 'jackets') leaveJackets();
  const sameJackets = route === 'jackets' && section === 'jackets';
  route = section || '';
  const navKey = { product: 'jackets', compare: 'jackets', techpack: 'jackets', report: 'insights', health: '' }[section] ?? route;
  $$('[data-nav]').forEach(a => { const on = a.dataset.nav === navKey; a.classList.toggle('on', on); on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  if (document.body.dataset.route === 'boards' || route === 'boards') paintBoards();
  document.body.dataset.route = route || 'home';
  $('#notifMenu') && ($('#notifMenu').hidden = true);
  // Every page draws into its own container. If you move on before a slow page has loaded,
  // that page finishes into a container that is no longer on screen instead of covering the new page.
  // The jackets list keeps its container when only the filters change.
  if (!app()) return; // signed out / still starting: nothing to draw into yet
  let view = app().firstElementChild;
  if (!sameJackets || !view || !view.classList.contains('view')) {
    view = document.createElement('div');
    view.className = 'view';
    app().replaceChildren(view);
  }
  const draw = async () => {
    const need = PAGE_PERM[section || ''];
    if (need && !has(need)) {
      if (!section) { const first = NAV.find(n => n[3] && has(n[3])); if (first && first[0]) { location.replace('#/' + first[0]); return; } return void (location.hash = '#/settings/profile'); }
      view.innerHTML = `<div class="empty">${icon('shield', 34)}<h2>No access</h2><p>You don't have permission to open this page. Ask the owner if you need it.</p><a class="btn" href="#/">Go back</a></div>`; return;
    }
    switch (section) {
      case 'jackets': return renderJackets(view, params);
      case 'product': return renderProduct(view, id, params);
      case 'review': return renderReview(view);
      case 'hunts': return renderHunts(view);
      case 'compare': return renderCompare(view, params);
      case 'settings': return renderSettings(view, id || '');
      case 'boards': return id ? renderBoard(view, id) : renderBoards(view, params);
      case 'insights': return renderInsights(view, id || '');
      case 'report': return renderReport(view, params);
      case 'health': return renderHealth(view);
      case 'techpack': return renderTechPack(view, id);
      default: if (section && section !== 'home') history.replaceState(null, '', '#/'); return renderHome(view);
    }
  };
  const titles = { jackets: 'Jackets', product: 'Jacket', review: 'Review', hunts: 'Hunts', compare: 'Compare', settings: 'Settings', boards: 'Boards', insights: 'Insights', report: 'Weekly report', health: 'Health', techpack: 'Tech pack' };
  document.title = `${titles[section] ? titles[section] + ' · ' : ''}Morrow Studio`;
  try { await draw(); }
  catch (e) {
    // shown only if this page is still the one on screen
    if (e.name !== 'LoginRequired' && view.isConnected) view.innerHTML = `<div class="empty">${icon('alert', 34)}<h2>${e.offline ? "You're offline" : 'Something went wrong'}</h2><p>${esc(e.message)}</p><button class="btn ghost" data-reload>Try again</button></div>`;
    view.querySelector('[data-reload]')?.addEventListener('click', () => render());
  }
  renderTray();
}

// ---------- keyboard ----------
let gPending = false;
function onKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!closeModal()) openPalette(); return; }
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (e.key === 'Escape' && $('.modal-back')) { closeModal(); return; }
  if (typing || (e.ctrlKey && e.key !== 'z') || (e.metaKey && e.key !== 'z') || e.altKey) return;
  if ($('.modal-back')) return;
  if (gPending) {
    gPending = false;
    const to = { h: '', o: '', j: 'jackets', r: 'review', b: 'boards', i: 'insights', u: 'hunts', s: 'settings' }[e.key];
    if (to !== undefined) { location.hash = '#/' + to; e.preventDefault(); }
    return;
  }
  if (e.key === '?') { showKeys(); e.preventDefault(); return; }
  if (e.key === '/') { focusSearch(); e.preventDefault(); return; }
  if (e.key === 'g') { gPending = true; setTimeout(() => { gPending = false; }, 900); return; }
  const inSplit = route === 'jackets' && document.activeElement?.closest?.('#side');
  const handled = route === 'jackets' ? (inSplit ? productKey(e) : jacketsKey(e)) : route === 'product' ? productKey(e) : route === 'review' ? reviewKey(e) : false;
  if (handled) e.preventDefault();
}
function showKeys() {
  const k = (keys, what) => `<tr><td>${keys.split(' ').map(x => `<kbd>${x}</kbd>`).join(' ')}</td><td>${what}</td></tr>`;
  const m = openModal(`<div class="row-between"><h2 class="modal-title">Keyboard shortcuts</h2><button class="icon-btn" data-x aria-label="Close">${icon('x')}</button></div>
    <div class="keys">
      <table><caption>Everywhere</caption>${k('Ctrl K', 'Search & commands')}${k('/', 'Search jackets')}${k('?', 'This help')}${k('g h', 'Overview')}${k('g j', 'Jackets')}${k('g r', 'Review')}${k('g b', 'Boards')}${k('g i', 'Insights')}${k('g u', 'Hunts')}${k('g s', 'Settings')}${k('Esc', 'Close / back')}</table>
      <table><caption>Jackets grid</caption>${k('← → ↑ ↓', 'Move between jackets')}${k('A', 'Approve')}${k('R', 'Reject')}${k('N', 'Move to New')}${k('Space', 'Quick view')}${k('Enter', 'Open jacket')}${k('X', 'Select')}${k('C', 'Add to compare')}${k('B', 'Add to board')}${k('Shift A', 'Approve selected')}${k('Shift R', 'Reject selected')}</table>
      <table><caption>Jacket page</caption>${k('A R N', 'Approve / reject / new')}${k('[ ]', 'Previous / next jacket')}${k('← →', 'Previous / next photo')}${k('F', 'Full-screen photos')}${k('O', 'Open in store')}${k('B', 'Add to board')}</table>
      <table><caption>Review mode</caption>${k('A', 'Approve')}${k('R', 'Reject')}${k('S', 'Skip')}${k('U', 'Undo')}${k('← →', 'Photos')}</table>
    </div>`, { wide: true, label: 'Keyboard shortcuts' });
  m.querySelector('[data-x]').onclick = closeModal;
}

// ---------- live updates ----------
async function refreshCounts() {
  try {
    const s = await api('/stats');
    $$('[data-badge]').forEach(b => { b.hidden = !s.new; b.textContent = s.new > 99 ? '99+' : s.new; });
    if ('setAppBadge' in navigator) (s.new ? navigator.setAppBadge(s.new) : navigator.clearAppBadge()).catch(() => {});
    const r = s.lastRun;
    setLive(r && r.status === 'started' && Date.now() - Date.parse(r.updatedAt || r.startedAt) < 30 * 60000 ? r : null);
  } catch {}
}
const refreshCountsSoon = debounce(refreshCounts, 400);
function setLive(run) {
  liveRun = run;
  const pill = $('#livePill');
  $$('[data-live]').forEach(d => { d.hidden = !run; });
  if (!pill) return;
  pill.hidden = !run;
  if (run) pill.innerHTML = `<span class="pulse"></span><span class="lp-word">${run.mode === 'trend' ? 'Trend hunt' : 'Hunting'}…</span> <b>${run.found || 0}</b> new`;
}
async function systemNotify(title, body, url = '/#/jackets?status=new') {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  try { const reg = await navigator.serviceWorker?.getRegistration(); reg ? reg.showNotification(title, { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: 'lh', data: { url } }) : new Notification(title, { body, icon: '/icons/icon-192.png' }); } catch {}
}
function connect() {
  events?.close();
  events = new EventSource('/api/events');
  events.addEventListener('run', e => {
    const run = JSON.parse(e.data);
    const wasLive = liveRun && liveRun.id === run.id;
    huntUpdate(run);
    if (run.status === 'started') setLive(run);
    else if (wasLive) { setLive(null); refreshCountsSoon(); }
  });
  events.addEventListener('access', async () => {
    try { setMe(await api('/me')); shell(); route = ''; await render(); refreshCountsSoon(); toast('Your access was updated by the owner'); } catch {}
  });
  events.addEventListener('notification', e => {
    const n = JSON.parse(e.data);
    unread++; paintBell();
    const [title, ...rest] = n.text.split('\n');
    toast(title, n.link ? { timeout: 8000, action: 'View', onAction: () => { location.hash = n.link.replace(/^#?/, '#'); } } : { timeout: 8000 });
    systemNotify('Morrow Studio', [title, ...rest].join('\n').slice(0, 200), '/' + (n.link || ''));
  });
  events.addEventListener('products', e => {
    const d = JSON.parse(e.data);
    if (route === 'jackets') jacketsArrived(d.ids.length); else invalidateJackets();
    refreshCountsSoon();
  });
  events.addEventListener('status', e => {
    const d = JSON.parse(e.data);
    if (d.by === me().id) return; // our own change is already on screen
    remoteStatus(d.changes);
    for (const c of d.changes) productChanged(c.id);
    refreshCountsSoon();
  });
  events.addEventListener('product', e => { const d = JSON.parse(e.data); if (d.by !== me().id) productChanged(d.id); });
  events.addEventListener('stats', refreshCountsSoon);
}
window.addEventListener('lh:run', e => setLive(e.detail.status === 'started' ? e.detail : null));
window.addEventListener('lh:stats', refreshCountsSoon);
window.addEventListener('lh:refresh', () => { invalidateJackets(); render(); });
window.addEventListener('lh:keys', showKeys);
window.addEventListener('lh:hunt', e => startHunt(e.detail));
window.addEventListener('lh:login', () => { events?.close(); boot(); });

// ---------- pull to refresh (touch) ----------
function pullToRefresh() {
  let start = null, dist = 0;
  const ptr = () => $('#ptr');
  addEventListener('touchstart', e => { start = scrollY <= 0 && !$('.modal-back') && !e.target.closest('.rv-card, .lb-stage, .g-main') ? e.touches[0].clientY : null; dist = 0; }, { passive: true });
  addEventListener('touchmove', e => {
    if (start === null) return;
    dist = Math.max(0, e.touches[0].clientY - start);
    if (dist > 4 && ptr()) { ptr().style.transform = `translate(-50%, ${Math.min(dist, 110) - 50}px) rotate(${dist * 3}deg)`; ptr().classList.toggle('ready', dist > 80); }
  }, { passive: true });
  addEventListener('touchend', async () => {
    if (start === null) return;
    const go = dist > 80; start = null;
    const el = ptr(); if (!el) return;
    if (go) { el.classList.add('spin'); invalidateJackets(); await Promise.all([render(), refreshCounts()]); }
    el.classList.remove('spin', 'ready'); el.style.transform = '';
  });
}

// ---------- start ----------
async function boot() {
  let session;
  try { const r = await fetch('/api/session', { cache: 'no-store' }); if (!r.ok) throw new Error(String(r.status)); session = await r.json(); }
  catch {
    // can't reach the server: never guess who you are (that used to show the owner's screens)
    $('#root').innerHTML = `<div class="boot"><img src="/icons/morrow.png" alt="" width="64" height="64"><h2>Can't reach Morrow Studio</h2><p class="muted">Check your internet connection.</p><button class="btn gold" id="retryBoot">Try again</button></div>`;
    $('#retryBoot').onclick = () => location.reload();
    window.addEventListener('online', () => location.reload(), { once: true });
    return;
  }
  if (session.required && !session.user) {
    document.body.classList.add('logged-out');
    renderLogin($('#root'), () => { document.body.classList.remove('logged-out'); boot(); });
    return;
  }
  setMe(session.user);
  document.body.classList.toggle('no-auth', !session.required);
  shell();
  await render();
  refreshCounts();
  loadNotifs();
  connect();
}

addEventListener('hashchange', render);
addEventListener('keydown', onKey);
addEventListener('resize', debounce(() => { if (route === 'jackets') render(); }, 400));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshCounts(); loadNotifs(); } });
if (isTouch()) pullToRefresh();
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.url) location.hash = e.data.url.split('#')[1] || '/'; });
boot();
