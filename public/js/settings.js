// Settings (tabs): Hunting · Profit · Automation · Team · Integrations · Backups · Profile.
// Everything saves automatically. Also: login page, install app, sign out.
import { api, esc, icon, toast, getTheme, setTheme, debounce, confirmDialog, openModal, closeModal, when, ago, money, $, $$ } from './core.js';
import { me, setMe, has } from './session.js';

let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; document.body.classList.add('can-install'); });
export const canInstall = () => !!installPrompt;
export async function installApp() {
  if (!installPrompt) { toast('Use your browser menu → "Install app" / "Add to Home screen"'); return; }
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  if (outcome === 'accepted') { installPrompt = null; document.body.classList.remove('can-install'); toast('Morrow Studio installed'); }
}

const TABS = [['', 'Hunting', 'radar'], ['profit', 'Profit', 'dollar'], ['automation', 'Automation', 'clock'], ['team', 'Team', 'users'], ['integrations', 'Integrations', 'link'], ['backups', 'Backups', 'database'], ['profile', 'Profile', 'user']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function saver(state) {
  return debounce(async body => {
    state.className = 'save-state saving'; state.innerHTML = '<i class="spinner"></i> Saving…';
    try { const r = await api('/settings', { method: 'PUT', body }); state.className = 'save-state'; state.innerHTML = `${icon('check', 15)} All changes saved`; return r; }
    catch (e) { state.className = 'save-state error'; state.innerHTML = `${icon('alert', 15)} Not saved: ${esc(e.message)}`; }
  }, 600);
}

export async function renderSettings(app, tab = '') {
  app.innerHTML = '<div class="skel-block tall"></div>';
  let s;
  try { s = await api('/settings'); } catch (e) { app.innerHTML = `<div class="empty"><h2>${esc(e.message)}</h2></div>`; return; }
  const owner = has('settings.edit');
  const NEED = { '': 'settings.view', profit: 'settings.view', automation: 'settings.view', integrations: 'settings.view', team: 'team.view', backups: 'backups.manage', profile: '' };
  const visible = TABS.filter(([k]) => !NEED[k] || has(NEED[k]));
  if (!visible.some(([k]) => k === tab)) tab = visible[0][0];
  app.innerHTML = `
  <header class="page-head"><div><p class="eyebrow">Settings</p><h1>${esc(TABS.find(t => t[0] === tab)[1])}</h1></div><span class="save-state" id="saveState" aria-live="polite">${owner ? `${icon('check', 15)} All changes saved` : ''}</span></header>
  <nav class="tabs-line" aria-label="Settings">${visible.map(([k, l, ic]) => `<a href="#/settings${k ? '/' + k : ''}" class="${k === tab ? 'on' : ''}">${icon(ic, 15)} ${l}</a>`).join('')}</nav>
  <div id="pane"></div>`;
  const pane = $('#pane'), state = $('#saveState');
  const views = { '': hunting, profit, automation, team, integrations, backups, profile };
  await views[tab](pane, s, state, owner);
  if (!owner && ['', 'profit', 'automation', 'integrations'].includes(tab)) {
    pane.classList.add('read-only');
    pane.insertAdjacentHTML('afterbegin', '<p class="hint read-only-note">You can look at these settings. Ask the owner to change them.</p>');
    pane.querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = true; });
  }
}

// ---------- Hunting ----------
function hunting(pane, s, state, owner) {
  const chk = (name, value, label, list) => `<label class="check"><input type="checkbox" name="${name}" value="${value}" ${list.includes(value) ? 'checked' : ''} ${owner ? '' : 'disabled'}><span>${label}</span></label>`;
  const dis = owner ? '' : 'disabled';
  pane.innerHTML = `${owner ? '' : '<p class="hint">Only the owner can change hunt settings.</p>'}
  <form class="settings-grid" id="sf" autocomplete="off">
    <section class="card-box"><h2>Price range</h2>
      <div class="row2"><label class="field"><span>Minimum</span><input type="number" name="minPrice" min="0" value="${esc(s.minPrice)}" ${dis}></label>
      <label class="field"><span>Maximum</span><input type="number" name="maxPrice" min="0" value="${esc(s.maxPrice)}" ${dis}></label></div>
      <p class="hint">In each market's own currency. Etsy and Google Shopping use USD.</p></section>
    <section class="card-box"><h2>Each hunt</h2>
      <label class="field"><span>Jackets kept per hunt</span><input type="number" name="topN" min="1" max="100" value="${esc(s.topN || 10)}" ${dis}></label>
      <p class="hint">Only the best new jackets are kept, ranked on best-seller signals and how recently they were listed.</p></section>
    <section class="card-box"><h2>Sources & markets</h2>
      <div class="checks">${chk('sources', 'ebay', 'eBay', s.sources)}${chk('sources', 'etsy', 'Etsy', s.sources)}${chk('sources', 'websites', 'Websites', s.sources)}</div>
      <div class="checks">${chk('markets', 'US', 'United States', s.markets)}${chk('markets', 'UK', 'United Kingdom', s.markets)}${chk('markets', 'CA', 'Canada', s.markets)}</div>
      <label class="check"><input type="checkbox" name="allowFaux" ${s.allowFaux ? 'checked' : ''} ${dis}><span>Include faux / vegan leather</span></label></section>
    <section class="card-box"><h2>Search phrases</h2><textarea name="keywords" rows="4" placeholder="Leave empty for the built-in leather jacket set" ${dis}>${esc((s.keywords || []).join('\n'))}</textarea></section>
    <section class="card-box span2"><h2>Websites to hunt</h2>
      <textarea name="websites" rows="4" placeholder="https://brand-one.com" ${dis}>${esc((s.websites || []).join('\n'))}</textarea>
      <div class="row2"><p class="hint">One per line. Each site's best sellers and newest leather jackets are checked.</p>
      <label class="field"><span>Jacket pages to read per website</span><input type="number" name="maxPagesPerSite" min="20" max="300" value="${esc(s.maxPagesPerSite)}" ${dis}></label></div></section>
    <section class="card-box span2"><h2>Appearance & app</h2>
      <div class="segmented wide" role="radiogroup" aria-label="Theme">${[['auto', 'monitor', 'System'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']].map(([v, ic, l]) => `<button type="button" role="radio" aria-checked="${getTheme() === v}" class="${getTheme() === v ? 'on' : ''}" data-theme="${v}">${icon(ic, 15)} ${l}</button>`).join('')}</div>
      <div class="setting-row"><span><b>Install as an app</b><small>Opens full screen from your home screen or desktop</small></span><button type="button" class="btn ghost sm" id="installBtn">${icon('install', 15)} Install</button></div>
      <div class="setting-row"><span><b>Browser notifications</b><small>${'Notification' in window ? Notification.permission === 'granted' ? 'On' : Notification.permission === 'denied' ? 'Blocked in your browser settings' : 'Off' : 'Not supported here'}</small></span>${'Notification' in window && Notification.permission === 'default' ? `<button type="button" class="btn ghost sm" id="notifBtn">${icon('bell', 15)} Turn on</button>` : ''}</div>
      <div class="setting-row"><span><b>Open jackets beside the list</b><small>On wide screens, clicking a jacket opens it next to the grid</small></span><label class="switch"><input type="checkbox" id="splitPref" ${localStorage.getItem('lh-split') === '"1"' ? 'checked' : ''}><i></i></label></div>
      <div class="setting-row"><span><b>Keyboard shortcuts</b><small>Press ? anywhere · Ctrl+K for the command palette</small></span><button type="button" class="btn ghost sm" id="keysBtn">${icon('keyboard', 15)} Show</button></div>
    </section>
  </form>`;
  const form = $('#sf'), save = saver(state);
  const read = () => {
    const checked = n => $$(`[name=${n}]:checked`, form).map(c => c.value);
    return { minPrice: form.minPrice.value, maxPrice: form.maxPrice.value, topN: form.topN.value, websites: form.websites.value, keywords: form.keywords.value, maxPagesPerSite: form.maxPagesPerSite.value, allowFaux: form.allowFaux.checked, sources: checked('sources'), markets: checked('markets') };
  };
  if (owner) { form.addEventListener('input', () => save(read())); form.addEventListener('change', () => save(read())); }
  form.addEventListener('submit', e => e.preventDefault());
  $$('[data-theme]').forEach(b => b.onclick = () => { setTheme(b.dataset.theme); $$('[data-theme]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); }); });
  $('#notifBtn')?.addEventListener('click', async () => { const r = await Notification.requestPermission(); toast(r === 'granted' ? 'Notifications on' : 'Notifications not allowed'); });
  $('#installBtn').onclick = installApp;
  $('#keysBtn').onclick = () => window.dispatchEvent(new CustomEvent('lh:keys'));
  $('#splitPref').onchange = e => { try { localStorage.setItem('lh-split', JSON.stringify(e.target.checked ? '1' : '0')); } catch {} toast(e.target.checked ? 'Jackets will open beside the list on wide screens' : 'Jackets open on their own page'); };
}

// ---------- Profit ----------
function profit(pane, s, state) {
  const p = s.profit;
  const types = Object.keys(p.costs);
  pane.innerHTML = `<form class="settings-grid" id="pf">
    <section class="card-box span2"><h2>Your cost to make one jacket</h2><p class="hint">Used on every jacket to show the profit you'd make selling at the competitor's price. You can override it on any single jacket.</p>
      <div class="cost-grid">${types.map(t => `<label class="field"><span>${esc(t)}</span><span class="money-in"><b>$</b><input type="number" min="0" step="1" name="cost-${esc(t)}" value="${p.costs[t]}"></span></label>`).join('')}</div></section>
    <section class="card-box"><h2>Selling</h2>
      <label class="field"><span>Shipping per jacket ($)</span><input type="number" min="0" name="shipping" value="${p.shipping}"></label>
      <label class="field"><span>Fees (payments, marketplace) %</span><input type="number" min="0" max="80" name="feesPct" value="${p.feesPct}"></label>
      <label class="field"><span>Price above competitor %</span><input type="number" min="-50" max="200" name="markupPct" value="${p.markupPct}"></label>
      <p class="hint">0% = sell at the same price as the competitor.</p></section>
    <section class="card-box"><h2>Exchange rates to USD</h2>
      <div class="cost-grid">${Object.keys(p.fx).filter(k => k !== 'USD').map(k => `<label class="field"><span>1 ${k} =</span><span class="money-in"><b>$</b><input type="number" min="0" step="0.01" name="fx-${k}" value="${p.fx[k]}"></span></label>`).join('')}</div></section>
    <section class="card-box span2" id="example"></section>
  </form>`;
  const form = $('#pf'), save = saver(state);
  const read = () => ({ profit: {
    costs: Object.fromEntries(types.map(t => [t, Number(form['cost-' + t].value) || 0])),
    shipping: Number(form.shipping.value) || 0, feesPct: Number(form.feesPct.value) || 0, markupPct: Number(form.markupPct.value) || 0,
    fx: { USD: 1, ...Object.fromEntries(Object.keys(p.fx).filter(k => k !== 'USD').map(k => [k, Number(form['fx-' + k].value) || 0])) }
  } });
  const example = () => {
    const x = read().profit, price = 199, sell = price * (1 + x.markupPct / 100), net = sell * (1 - x.feesPct / 100) - x.costs.Lambskin - x.shipping;
    $('#example').innerHTML = `<h2>Example</h2><p>A lambskin jacket the competitor sells for <b>${money(price)}</b>: you sell at <b>${money(Math.round(sell))}</b> − fees ${x.feesPct}% − making ${money(x.costs.Lambskin)} − shipping ${money(x.shipping)} = <b class="${net < 0 ? 'danger-text' : 'ok-text'}">${money(Math.round(net))} profit (${Math.round(net / sell * 100)}%)</b></p>`;
  };
  example();
  form.addEventListener('input', () => { example(); save(read()); });
}

// ---------- Automation ----------
function automation(pane, s, state) {
  const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [s.timezone];
  let schedules = (s.schedules || []).map(x => ({ ...x }));
  pane.innerHTML = `<div class="settings-grid">
    <section class="card-box span2"><div class="row-between"><h2>Scheduled hunts</h2><button class="btn ghost sm" id="addSch">${icon('plus', 15)} Add schedule</button></div>
      <p class="hint">Hunts start by themselves at these times (${esc(s.timezone)}). You'll be told when they finish.</p>
      <div id="schList"></div></section>
    <section class="card-box"><h2>Daily summary</h2>
      <label class="check"><input type="checkbox" id="dsOn" ${s.dailySummary.on ? 'checked' : ''}><span>Send a morning summary (new jackets, top 5, rising searches)</span></label>
      <label class="field"><span>Time</span><input type="time" id="dsTime" value="${esc(s.dailySummary.time)}"></label>
      <button class="btn ghost sm" id="dsTest">${icon('send', 15)} Send me one now</button>
      <p class="hint">Shows up in the bell at the top right. A weekly report link comes every Monday.</p></section>
    <section class="card-box"><h2>Time zone</h2>
      <label class="field"><span>Your time zone</span><select id="tz">${zones.map(z => `<option ${z === s.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label></section>
  </div>`;
  const save = saver(state);
  const paintSch = () => {
    $('#schList').innerHTML = schedules.map((x, i) => `<div class="sched" data-i="${i}">
      <label class="switch" title="On / off"><input type="checkbox" data-f="on" ${x.on ? 'checked' : ''}><i></i></label>
      <select data-f="mode"><option value="normal" ${x.mode !== 'trend' ? 'selected' : ''}>Run hunt</option><option value="trend" ${x.mode === 'trend' ? 'selected' : ''}>Today's trend hunt</option></select>
      <input type="time" data-f="time" value="${esc(x.time)}">
      <span class="days">${DAYS.map((d, k) => `<button type="button" class="day ${(x.days || []).includes(k) ? 'on' : ''}" data-day="${k}" aria-pressed="${(x.days || []).includes(k)}">${d[0]}</button>`).join('')}</span>
      <button class="icon-btn sm" data-del aria-label="Delete schedule">${icon('trash', 15)}</button></div>`).join('') || '<p class="muted">No schedules yet.</p>';
    $$('#schList .sched').forEach(row => {
      const x = schedules[Number(row.dataset.i)];
      row.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => { x[inp.dataset.f] = inp.type === 'checkbox' ? inp.checked : inp.value; save({ schedules }); });
      row.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { const d = Number(b.dataset.day); x.days = (x.days || []).includes(d) ? x.days.filter(y => y !== d) : [...(x.days || []), d]; paintSch(); save({ schedules }); });
      row.querySelector('[data-del]').onclick = () => { schedules = schedules.filter(y => y !== x); paintSch(); save({ schedules }); };
    });
  };
  paintSch();
  $('#addSch').onclick = () => { schedules.push({ id: Math.random().toString(16).slice(2, 10), mode: 'normal', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6], on: true }); paintSch(); save({ schedules }); };
  $('#dsOn').onchange = $('#dsTime').onchange = () => save({ dailySummary: { on: $('#dsOn').checked, time: $('#dsTime').value } });
  $('#dsTest').onclick = async () => { await api('/summary/test', { method: 'POST' }); toast('Summary sent — check the bell'); };
  $('#tz').onchange = () => save({ timezone: $('#tz').value });
}

// ---------- Team ----------
// Each person gets their own set of permissions (a box per area and action), or a ready-made set.
let PERMS = null;
async function team(pane) {
  PERMS ||= await api('/perms');
  const [{ users }] = await Promise.all([api('/users')]);
  const total = PERMS.areas.reduce((n, a) => n + a.actions.length, 0);
  const manage = has('team.manage');
  const canTouch = u => manage && u.id !== me().id && (u.role !== 'owner' || me().role === 'owner');
  const access = u => u.role === 'owner' ? 'Everything' : `${u.perms.length} of ${total} permissions`;
  pane.innerHTML = `<section class="card-box">
    <div class="row-between"><h2>People</h2>${manage ? `<button class="btn gold sm" id="addUser">${icon('plus', 15)} Add person</button>` : ''}</div>
    <p class="hint">Give each person exactly the access they need. Changes apply straight away — their open window updates by itself.</p>
    <div class="people">${users.map(u => `<div class="person ${u.disabled ? 'off' : ''}">
      <span class="avatar">${esc((u.name || u.username)[0].toUpperCase())}</span>
      <span class="who"><b>${esc(u.name)}${u.id === me().id ? ' (you)' : ''}</b><small>@${esc(u.username)} · ${u.lastLoginAt ? 'last seen ' + ago(u.lastLoginAt) : 'never signed in'}${u.disabled ? ' · disabled' : ''}</small></span>
      <span class="access"><b class="role-tag ${u.role}">${esc(PERMS.roles[u.role] || u.role)}</b><small>${access(u)}</small></span>
      ${canTouch(u) ? `<span class="person-actions"><button class="btn sm" data-acc="${u.id}">${icon('shield', 14)} Edit access</button><button class="btn ghost sm" data-pw="${u.id}">Reset password</button><button class="btn ghost sm" data-dis="${u.id}">${u.disabled ? 'Enable' : 'Disable'}</button><button class="icon-btn sm" data-delu="${u.id}" aria-label="Remove ${esc(u.name)}">${icon('trash', 15)}</button></span>` : '<span></span>'}
    </div>`).join('')}</div></section>
    <section class="card-box block" data-perm="activity.view"><h2>Recent activity</h2><ul class="activity" id="act"><li class="muted">Loading…</li></ul></section>`;
  const reload = () => team(pane);
  const byId = id => users.find(x => x.id === Number(id));
  $$('[data-acc]').forEach(b => b.onclick = () => accessDialog(byId(b.dataset.acc), reload));
  $$('[data-dis]').forEach(b => b.onclick = async () => { const u = byId(b.dataset.dis); await api('/users/' + u.id, { method: 'PUT', body: { disabled: !u.disabled } }); reload(); });
  $$('[data-delu]').forEach(b => b.onclick = async () => { const u = byId(b.dataset.delu); if (await confirmDialog({ title: `Remove ${u.name}?`, body: 'They will be signed out and can no longer log in.', confirm: 'Remove', danger: true })) { await api('/users/' + u.id, { method: 'DELETE' }); reload(); } });
  $$('[data-pw]').forEach(b => b.onclick = () => passwordDialog(Number(b.dataset.pw)));
  $('#addUser')?.addEventListener('click', () => accessDialog(null, reload));
  if (has('activity.view')) {
    const { items } = await api('/activity');
    $('#act').innerHTML = items.slice(0, 40).map(a => `<li><b>${esc(a.user)}</b> ${esc(a.action)} ${a.target?.type === 'product' ? `<a href="#/product/${a.target.id}">${esc(a.detail)}</a>` : `<span class="muted">${esc(a.detail)}</span>`}<small class="muted">${ago(a.at)}</small></li>`).join('') || '<li class="muted">Nothing yet</li>';
  }
}

// Add a person or change someone's access: name/login on top, then a box per area with its actions.
function accessDialog(u, done) {
  const adding = !u;
  const mine = p => me().role === 'owner' || has(p);
  let role = u ? u.role : 'custom';
  let picked = new Set(u ? (u.role === 'owner' ? Object.values(PERMS.presets.owner) : u.perms) : PERMS.presets.reviewer.filter(mine));
  const roleBtns = Object.entries(PERMS.roles).filter(([k]) => k !== 'owner' || me().role === 'owner')
    .map(([k, l]) => `<button type="button" class="chip ${role === k ? 'on' : ''}" data-preset="${k}">${l}</button>`).join('');
  const m = openModal(`<div class="row-between"><h2 class="modal-title">${adding ? 'Add a person' : `Access for ${esc(u.name)}`}</h2><button class="icon-btn" data-c aria-label="Close">${icon('x')}</button></div>
    ${adding ? `<div class="row3">
      <label class="field"><span>Name</span><input id="nuName" placeholder="e.g. Ali" autofocus></label>
      <label class="field"><span>Username</span><input id="nuUser" placeholder="ali" autocapitalize="off"></label>
      <label class="field"><span>Password (8+ characters)</span><input id="nuPw" type="text" autocomplete="new-password"></label></div>` : ''}
    <div class="perm-top"><span class="muted small">Start from</span><div class="chips" id="presets">${roleBtns}</div><span class="grow"></span>
      <button type="button" class="link-btn" id="pAll">Select all</button><button type="button" class="link-btn" id="pNone">Clear</button></div>
    <p class="hint" id="pCount"></p>
    <div class="perm-grid" id="pGrid">${PERMS.areas.map(a => `<fieldset class="perm-box"><legend>${esc(a.label)}</legend>
      ${a.actions.map(([k, l]) => { const p = `${a.key}.${k}`; return `<label class="check ${mine(p) ? '' : 'locked'}"><input type="checkbox" data-p="${p}" data-area="${a.key}" data-act="${k}" ${mine(p) ? '' : 'disabled title="You can only give access you have yourself"'}><span>${esc(l)}</span></label>`; }).join('')}</fieldset>`).join('')}</div>
    <p class="login-error" id="nuErr" hidden></p>
    <div class="modal-actions"><button class="btn ghost" data-c>Cancel</button><button class="btn gold" data-ok>${adding ? 'Add person' : 'Save access'}</button></div>`, { label: adding ? 'Add a person' : 'Edit access', wide: true });

  const boxes = [...m.querySelectorAll('[data-p]')];
  const paint = () => {
    const owner = role === 'owner';
    boxes.forEach(b => { b.checked = owner || picked.has(b.dataset.p); b.disabled = owner || !mine(b.dataset.p); });
    m.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('on', b.dataset.preset === role));
    m.querySelector('#pCount').textContent = owner ? 'Owners can do everything, including managing people and backups.' : `${picked.size} of ${boxes.length} permissions selected.`;
  };
  const setRole = r => { role = r; if (r !== 'custom' && r !== 'owner') picked = new Set(PERMS.presets[r].filter(mine)); paint(); };
  m.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => setRole(b.dataset.preset));
  m.querySelector('#pAll').onclick = () => { role = 'custom'; picked = new Set(boxes.filter(b => mine(b.dataset.p)).map(b => b.dataset.p)); paint(); };
  m.querySelector('#pNone').onclick = () => { role = 'custom'; picked = new Set(); paint(); };
  boxes.forEach(b => b.onchange = () => {
    role = 'custom';
    const area = b.dataset.area, same = boxes.filter(x => x.dataset.area === area);
    if (b.checked) { picked.add(b.dataset.p); if (b.dataset.act !== 'view') { const v = same.find(x => x.dataset.act === 'view'); if (v && mine(v.dataset.p)) picked.add(v.dataset.p); } }
    else { picked.delete(b.dataset.p); if (b.dataset.act === 'view') same.forEach(x => picked.delete(x.dataset.p)); } // no doing without seeing
    paint();
  });
  if (adding) {
    m.querySelector('#nuName').oninput = e => { const x = m.querySelector('#nuUser'); if (!x.dataset.touched) x.value = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''); };
    m.querySelector('#nuUser').oninput = e => { e.target.dataset.touched = '1'; };
  }
  m.querySelectorAll('[data-c]').forEach(b => b.onclick = closeModal);
  m.querySelector('[data-ok]').onclick = async () => {
    const body = { role, perms: role === 'owner' ? undefined : [...picked] };
    try {
      if (adding) await api('/users', { method: 'POST', body: { ...body, name: m.querySelector('#nuName').value, username: m.querySelector('#nuUser').value, password: m.querySelector('#nuPw').value } });
      else await api('/users/' + u.id, { method: 'PUT', body });
      closeModal(); toast(adding ? 'Person added' : 'Access saved'); done();
    } catch (e) { const er = m.querySelector('#nuErr'); er.textContent = e.message; er.hidden = false; }
  };
  paint();
}
function passwordDialog(uid) {
  const m = openModal(`<h2 class="modal-title">Set a new password</h2><label class="field"><span>New password (8+ characters)</span><input id="np" type="text" autocomplete="new-password" autofocus></label>
    <p class="login-error" id="npErr" hidden></p><div class="modal-actions"><button class="btn ghost" data-c>Cancel</button><button class="btn gold" data-ok>Save</button></div>`, { label: 'New password' });
  m.querySelector('[data-c]').onclick = closeModal;
  m.querySelector('[data-ok]').onclick = async () => { try { await api('/users/' + uid, { method: 'PUT', body: { password: m.querySelector('#np').value } }); closeModal(); toast('Password changed — they need to sign in again'); } catch (e) { const er = m.querySelector('#npErr'); er.textContent = e.message; er.hidden = false; } };
}

// ---------- Integrations ----------
function integrations(pane, s, state) {
  pane.innerHTML = `<div class="settings-grid">
    <section class="card-box"><h2>Google Shopping (Serper)</h2>
      <label class="field"><span>Serper key</span><input type="password" id="serper" placeholder="${s.serperKeySet ? 'Saved — type a new key to change it' : 'Paste your Serper key'}" autocomplete="off"></label>
      <p class="hint">serper.dev gives 2,500 free searches at signup. One trend hunt uses about 5.</p></section>
    <section class="card-box"><h2>Shopify (send jackets as drafts)</h2>
      <label class="field"><span>Store address</span><input id="shDomain" placeholder="your-store.myshopify.com" value="${esc(s.shopify.domain)}"></label>
      <label class="field"><span>Admin API access token</span><input type="password" id="shToken" placeholder="${s.shopify.tokenSet ? 'Saved — paste a new one to change' : 'shpat_…'}" autocomplete="off"></label>
      <label class="field"><span>Vendor name on products</span><input id="shVendor" placeholder="Your brand" value="${esc(s.shopify.vendor)}"></label>
      <p class="hint">Free with your store: Shopify admin → Settings → Apps → Develop apps → Create app → give it <b>write_products</b> → install → copy the Admin API token. Jackets arrive as <b>drafts</b>, never live.</p></section>
    <section class="card-box span2"><h2>n8n connection</h2>
      <div class="row2"><label class="field"><span>n8n webhook URL</span><input type="url" id="n8nUrl" value="${esc(s.n8nWebhookUrl)}"></label>
      <label class="field"><span>Dashboard URL as n8n sees it</span><input type="url" id="dashUrl" value="${esc(s.dashboardUrlForN8n)}"></label></div></section>
  </div>`;
  const save = saver(state);
  $('#serper').onchange = e => { if (e.target.value.trim()) { save({ serperKey: e.target.value.trim() }); e.target.value = ''; e.target.placeholder = 'Saved — type a new key to change it'; toast('Serper key saved'); } };
  const shop = () => save({ shopify: { domain: $('#shDomain').value, vendor: $('#shVendor').value, token: $('#shToken').value.trim() } });
  $('#shDomain').onchange = $('#shVendor').onchange = shop;
  $('#shToken').onchange = e => { if (e.target.value.trim()) { shop(); e.target.value = ''; e.target.placeholder = 'Saved — paste a new one to change'; toast('Shopify token saved'); } };
  $('#n8nUrl').onchange = $('#dashUrl').onchange = () => save({ n8nWebhookUrl: $('#n8nUrl').value, dashboardUrlForN8n: $('#dashUrl').value });
}

// ---------- Backups ----------
async function backups(pane, s, state) {
  const { backups: list } = await api('/backups');
  pane.innerHTML = `<div class="settings-grid">
    <section class="card-box"><h2>Automatic backups</h2>
      <label class="check"><input type="checkbox" id="bOn" ${s.backup.on ? 'checked' : ''}><span>Back up every night</span></label>
      <div class="row2"><label class="field"><span>Time</span><input type="time" id="bTime" value="${esc(s.backup.time)}"></label>
      <label class="field"><span>Keep the last</span><input type="number" id="bKeep" min="2" max="30" value="${s.backup.keep}"></label></div>
      <p class="hint">Jackets, notes, boards, users and photos. Stored on your server; download a copy now and then to keep one off the server too.</p>
      <button class="btn gold" id="bNow">${icon('database', 15)} Back up now</button></section>
    <section class="card-box"><h2>Saved backups</h2><ul class="backups">${list.map(b => `<li><span><b>${esc(b.name.replace(/^backup-|\.tar\.gz$/g, ''))}</b><small class="muted">${when(b.at)} · ${(b.size / 1e6).toFixed(1)} MB</small></span>
      <a class="btn ghost sm" href="/api/backups/${encodeURIComponent(b.name)}" download>${icon('download', 14)}</a><button class="btn ghost sm" data-restore="${esc(b.name)}">Restore</button></li>`).join('') || '<li class="muted">None yet — the first one runs tonight, or press “Back up now”.</li>'}</ul></section>
  </div>`;
  const save = saver(state);
  $('#bOn').onchange = $('#bTime').onchange = $('#bKeep').onchange = () => save({ backup: { on: $('#bOn').checked, time: $('#bTime').value, keep: $('#bKeep').value } });
  $('#bNow').onclick = async e => { e.target.disabled = true; e.target.innerHTML = '<i class="spinner"></i> Backing up…'; try { await api('/backups', { method: 'POST' }); toast('Backup done'); } catch (er) { toast(er.message, { kind: 'error' }); } backups(pane, s, state); };
  $$('[data-restore]').forEach(b => b.onclick = async () => {
    if (!(await confirmDialog({ title: 'Restore this backup?', body: 'Everything goes back to how it was at that moment. A safety backup of right now is made first. The dashboard restarts (about 20 seconds).', confirm: 'Restore', danger: true }))) return;
    try { await api('/backups/' + encodeURIComponent(b.dataset.restore) + '/restore', { method: 'POST' }); toast('Restoring… the page reloads in a moment'); setTimeout(() => location.reload(), 15000); }
    catch (e) { toast(e.message, { kind: 'error' }); }
  });
}

// ---------- Profile ----------
async function profile(pane, s) {
  const u = await api('/me');
  const a = u.alerts || {};
  pane.innerHTML = `<div class="settings-grid">
    <section class="card-box span2"><h2>Screen size</h2>
      <p class="hint">How big everything looks on a laptop or desktop. Only changes this browser.</p>
      <div class="segmented" id="sizeSeg">${[['fit', 'Fit to screen (more space)'], ['medium', 'Medium'], ['actual', 'Actual size (bigger)']].map(([k, l]) => `<button type="button" data-size="${k}" class="${(localStorage.getItem('lh-size') || 'fit') === k ? 'on' : ''}">${l}</button>`).join('')}</div></section>
    <section class="card-box"><h2>You</h2>
      <label class="field"><span>Name</span><input id="myName" value="${esc(u.name)}"></label>
      <p class="hint">Signed in as <b>@${esc(u.username)}</b> · ${esc(u.role)}</p>
      <button class="btn ghost sm danger-text" id="signOut">${icon('logout', 15)} Sign out</button></section>
    <section class="card-box"><h2>Change password</h2>
      <label class="field"><span>Current password</span><input type="password" id="pw0" autocomplete="current-password"></label>
      <label class="field"><span>New password (8+ characters)</span><input type="password" id="pw1" autocomplete="new-password"></label>
      <button class="btn gold sm" id="pwSave">Change password</button></section>
    <section class="card-box span2"><h2>Alerts</h2>
      <p class="hint">Alerts show in the bell at the top right.</p>
      ${!('Notification' in window) ? '' : Notification.permission === 'granted' ? `<p>${icon('check', 15)} Pop-up alerts are on for this browser.</p>`
        : Notification.permission === 'denied' ? `<p class="hint">Pop-up alerts are blocked in this browser. Allow notifications for this site in your browser settings to turn them on.</p>`
        : `<button class="btn gold sm" id="popOn">${icon('bell', 15)} Turn on pop-up alerts</button>`}
      <h3>Tell me about</h3>
      <div class="checks">${[['hunts', 'Hunts finishing or failing'], ['prices', 'Price drops, sell-outs and restocks'], ['mentions', 'Someone @mentioning me'], ['daily', 'Daily summary and weekly report']].map(([k, l]) => `<label class="check"><input type="checkbox" data-alert="${k}" ${a[k] !== false ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      </section>
  </div>`;
  $('#myName').onchange = async e => { const r = await api('/me', { method: 'PUT', body: { name: e.target.value } }); setMe({ ...me(), ...r }); toast('Saved'); };
  $('#pwSave').onclick = async () => { try { await api('/me', { method: 'PUT', body: { password: $('#pw0').value, newPassword: $('#pw1').value } }); $('#pw0').value = $('#pw1').value = ''; toast('Password changed'); } catch (e) { toast(e.message, { kind: 'error' }); } };
  $$('[data-alert]').forEach(c => c.onchange = () => api('/me', { method: 'PUT', body: { alerts: { [c.dataset.alert]: c.checked } } }).then(() => toast('Saved')));
  $('#signOut').onclick = signOut;
  $$('[data-size]').forEach(b => b.onclick = () => { try { localStorage.setItem('lh-size', b.dataset.size); } catch {} window.lhFit?.(); $$('[data-size]').forEach(x => x.classList.toggle('on', x === b)); });
  $('#popOn')?.addEventListener('click', async () => { try { await Notification.requestPermission(); } catch {} profile(pane, s); });
}

export async function signOut() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  try { const keys = await caches.keys(); await Promise.all(keys.filter(k => k.includes('-api')).map(k => caches.delete(k))); } catch {}
  location.replace('/#/');
  location.reload();
}

// ---------- login ----------
export function renderLogin(root, onDone) {
  root.innerHTML = `
  <main class="login" id="main">
    <div class="login-art" aria-hidden="true"><img src="/icons/morrow.png" alt=""><p>MORROW <span>STUDIO</span></p></div>
    <form class="login-card" id="lf" novalidate>
      <img src="/icons/morrow.png" class="login-logo" alt="Morrow">
      <h1>Welcome back</h1>
      <p class="muted">Sign in to Morrow Studio</p>
      <label class="field"><span>Username</span><input name="user" autocomplete="username" required autocapitalize="off" placeholder="admin"></label>
      <label class="field"><span>Password</span><span class="pw"><input name="password" type="password" autocomplete="current-password" required><button type="button" class="icon-btn sm" id="pwShow" aria-label="Show password">${icon('eye', 16)}</button></span></label>
      <label class="check"><input type="checkbox" name="remember" checked><span>Keep me signed in for 30 days</span></label>
      <p class="login-error" id="lerr" role="alert" hidden></p>
      <button class="btn gold lg block" id="lbtn">Sign in</button>
    </form>
  </main>`;
  const f = $('#lf'), err = $('#lerr'), btn = $('#lbtn');
  try { f.user.value = localStorage.getItem('lh-last-user') || 'admin'; } catch { f.user.value = 'admin'; }
  $('#pwShow').onclick = () => { const p = f.password; p.type = p.type === 'password' ? 'text' : 'password'; $('#pwShow').setAttribute('aria-label', p.type === 'password' ? 'Show password' : 'Hide password'); p.focus(); };
  f.password.focus();
  f.onsubmit = async e => {
    e.preventDefault();
    err.hidden = true;
    if (!f.password.value) { err.textContent = 'Enter your password'; err.hidden = false; return; }
    btn.disabled = true; btn.innerHTML = '<i class="spinner"></i> Signing in…';
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: f.user.value.trim(), password: f.password.value, remember: f.remember.checked }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Sign in failed');
      try { localStorage.setItem('lh-last-user', f.user.value.trim()); } catch {}
      onDone();
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false;
      f.password.select();
      f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
    } finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  };
}
