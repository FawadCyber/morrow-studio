// Jackets: filter chips, instant search, infinite scroll, bulk select, keyboard control, saved views.
import { api, esc, money, icon, toast, openModal, closeModal, sourceLabel, SOURCES, SWATCH, cap, plural, $, $$, debounce, isTouch, store } from './core.js';
import { changeStatus, deleteJackets, compare, quickView, renderTray } from './actions.js';
import { parseQuery, photoSearch } from './palette.js';
import { addToBoard } from './boards.js';
import { renderProduct } from './product.js';
import { canEdit } from './session.js';

const PAGE = 36;
const KEYS = ['status', 'q', 'source', 'gender', 'color', 'style', 'leather', 'topic', 'bestseller', 'today', 'min', 'max', 'sort', 'run', 'merge', 'open'];
const DEFAULTS = { status: 'new', sort: 'score' };
const cache = { key: null, items: [], page: 0, pages: 1, total: 0, facets: null, scroll: 0 };
let query = {}, selected = new Set(), focusIdx = -1, observer = null, fresh = 0, root = null;

export const jacketQuery = () => query;
export const queryString = q => new URLSearchParams(Object.entries({ ...q }).filter(([, v]) => v !== '' && v !== undefined && v !== null)).toString();
const keyOf = q => { const { open, ...rest } = q; return queryString(rest); }; // the open jacket (split view) doesn't change the list
const splitOn = () => { try { return JSON.parse(localStorage.getItem('lh-split') || '"0"') === '1'; } catch { return false; } };
const wide = () => window.innerWidth / (window.lhZoom || 1) >= 1380;

function readQuery(params) {
  const q = { ...DEFAULTS };
  for (const k of KEYS) if (params.get(k) !== null) q[k] = params.get(k);
  return q;
}
function go(patch) {
  const q = { ...query, ...patch };
  for (const k of Object.keys(q)) if (q[k] === '' || q[k] === undefined) delete q[k];
  location.hash = '#/jackets?' + new URLSearchParams(q).toString();
}

export function leaveJackets() { cache.scroll = scrollY; observer?.disconnect(); document.body.classList.remove('selecting'); }

export async function renderJackets(app, params) {
  const prevKey = keyOf(query);
  query = readQuery(params);
  const key = keyOf(query);
  if (root === app && $('#grid') && prevKey === key && cache.key === key) { paintSide(); return; }
  root = app;
  const reuse = cache.key === key && cache.items.length;
  if (!reuse) { selected.clear(); focusIdx = -1; fresh = 0; }
  app.innerHTML = shell();
  bindToolbar();
  paintSide();
  if (reuse) {
    paintFacets(); paintGrid(true);
    requestAnimationFrame(() => scrollTo(0, cache.scroll));
  } else {
    $('#grid').innerHTML = skeletons(12);
    await load(true);
  }
}

// split view: the open jacket beside the grid (wide screens, when switched on in Settings)
function paintSide() {
  const side = $('#side'), layout = $('#jkLayout');
  if (!side) return;
  const show = !!query.open && splitOn() && wide();
  layout.classList.toggle('split', show);
  if (!show) { side.innerHTML = ''; return; }
  $$('.card.open').forEach(c => c.classList.remove('open'));
  $(`.card[data-id="${CSS.escape(String(query.open))}"]`)?.classList.add('open');
  const base = { ...query }; delete base.open;
  renderProduct(side, query.open, new URLSearchParams(queryString(base)), {
    embedded: true,
    link: id => '#/jackets?' + queryString({ ...base, open: id }),
    close: '#/jackets?' + queryString(base)
  });
}
const productHref = id => splitOn() && wide() ? '#/jackets?' + queryString({ ...query, open: id }) : `#/product/${id}?${queryString((({ open, ...r }) => r)(query))}`;

function shell() {
  return `
  <header class="page-head">
    <div><p class="eyebrow">Morrow Studio</p><h1>Jackets <span class="count" id="total"></span></h1><p class="lead-line">Everything your hunts found. Tap ✓ to keep a jacket or ✕ to drop it.</p></div>
    <div class="head-actions">
      <button class="btn ghost" id="photoBtn" title="Find jackets that look like a photo">${icon('camera', 16)} Photo search</button>
      <div class="menu-wrap"><button class="btn ghost" id="viewsBtn" aria-haspopup="true" aria-expanded="false">${icon('bookmark', 16)} Saved filters</button><div class="menu" id="viewsMenu" hidden></div></div>
      <a class="btn gold" href="#/review">${icon('cards', 16)} Quick review</a>
    </div>
  </header>
  <div class="toolbar">
    <div class="segmented" role="tablist" aria-label="Status" id="statusTabs"></div>
    <label class="search">${icon('search', 17)}<input type="search" id="q" placeholder="Search, or type “black biker under 200 best sellers”…" value="${esc(query.q || '')}" aria-label="Search jackets" autocomplete="off"><kbd>/</kbd><span class="nl-hint" id="nlHint" hidden></span></label>
    <select id="sort" aria-label="Sort">
      <option value="score">Best first</option><option value="newest">Newest</option><option value="price_asc">Price: low → high</option>
      <option value="price_desc">Price: high → low</option><option value="profit">Most profit</option><option value="match">Most like my picks</option>
      <option value="velocity">Selling fastest</option><option value="images">Most photos</option><option value="topic">By trend topic</option>
    </select>
    <button class="btn ghost filters-toggle" id="filtersToggle" aria-expanded="false">${icon('filter', 16)} Filters <span class="badge-n" id="filterN" hidden></span></button>
  </div>
  <div class="filters" id="filters"></div>
  <div class="active-filters" id="activeFilters"></div>
  <button class="new-banner" id="newBanner" hidden></button>
  <div class="jk-layout" id="jkLayout">
    <div class="jk-main"><section class="grid" id="grid" aria-label="Jackets" aria-busy="true"></section>
    <div id="sentinel" class="sentinel"></div>
    <div id="endNote" class="end-note"></div></div>
    <aside class="jk-side" id="side" aria-label="Selected jacket"></aside>
  </div>
  <div class="bulkbar" id="bulkbar" hidden role="region" aria-label="Selected jackets"></div>`;
}

function bindToolbar() {
  const q = $('#q');
  const hint = $('#nlHint');
  const live = debounce(() => { const p = parseQuery(q.value); if (p.understood) return; go({ q: q.value.trim() }); }, 260);
  q.addEventListener('input', () => {
    const p = q.value.trim() ? parseQuery(q.value) : null;
    hint.hidden = !p?.understood;
    if (p?.understood) hint.innerHTML = `Enter → ${p.chips.map(c => `<b>${esc(c)}</b>`).join(' ')}`;
    live();
  });
  q.addEventListener('keydown', e => {
    if (e.key === 'Escape') { q.value = ''; q.blur(); hint.hidden = true; go({ q: '' }); }
    if (e.key === 'Enter') {
      const p = parseQuery(q.value);
      if (p.understood) { hint.hidden = true; location.hash = '#/jackets?' + queryString({ sort: query.sort, ...p.query }); }
      q.blur();
    }
  });
  $('#photoBtn').onclick = photoSearch;
  const sort = $('#sort'); sort.value = query.sort || 'score';
  sort.onchange = () => go({ sort: sort.value });
  const setFilters = open => { $('#filters').classList.toggle('open', open); $('#filtersToggle').setAttribute('aria-expanded', open); $('#filtersToggle').classList.toggle('on', open); };
  setFilters(store.get('filters-open', false));
  $('#filtersToggle').onclick = () => { const open = !$('#filters').classList.contains('open'); setFilters(open); store.set('filters-open', open); };
  $('#viewsBtn').onclick = openViews;
  $('#newBanner').onclick = () => { fresh = 0; cache.key = null; renderJackets(root, new URLSearchParams(queryString(query))); scrollTo({ top: 0, behavior: 'smooth' }); };
}

async function load(first) {
  if (!first && cache.page >= cache.pages) return;
  const page = first ? 1 : cache.page + 1;
  const qs = queryString({ ...query, page, size: PAGE });
  try {
    const [data, facets] = await Promise.all([api('/products?' + qs), first ? api('/facets?' + queryString(query)) : null]);
    if (first) { cache.items = []; cache.facets = facets; cache.key = keyOf(query); }
    cache.items.push(...data.items);
    cache.page = page; cache.pages = data.pages; cache.total = data.total;
    if (first) paintFacets();
    paintGrid(first, data.items);
  } catch (e) {
    if (first) $('#grid').innerHTML = `<div class="empty">${icon('alert', 34)}<h2>Couldn't load jackets</h2><p>${esc(e.message)}</p><button class="btn ghost" onclick="location.reload()">Try again</button></div>`;
  }
}

// ---------- filters ----------
const GROUPS = [
  ['source', 'Source', v => SOURCES[v] || v],
  ['gender', 'Gender', v => v],
  ['color', 'Colour', v => cap(v)],
  ['style', 'Style', v => cap(v)],
  ['leather', 'Leather', v => v],
  ['topic', 'Trend topic', v => v]
];
const SEP = k => k === 'topic' ? '|' : ',';
const listOf = k => (query[k] || '').split(SEP(k)).filter(Boolean);

function paintFacets() {
  const f = cache.facets || {};
  const counts = Object.fromEntries((f.status || []).map(s => [s.value, s.n]));
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  $('#statusTabs').innerHTML = [['new', 'New'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']].map(([k, label]) =>
    `<button role="tab" aria-selected="${query.status === k}" class="${query.status === k ? 'on' : ''}" data-status="${k}">${label}<small>${k === 'all' ? all : counts[k] || 0}</small></button>`).join('');
  $$('#statusTabs [data-status]').forEach(b => b.onclick = () => go({ status: b.dataset.status }));

  $('#filters').innerHTML = `${GROUPS.map(([k, label, fmt]) => {
    const opts = f[k] || [];
    if (!opts.length) return '';
    const on = listOf(k);
    return `<div class="fgroup"><span class="flabel">${label}</span><div class="fchips">${opts.map(o => `
      <button class="fchip ${on.includes(o.value) ? 'on' : ''}" data-k="${k}" data-v="${esc(o.value)}" aria-pressed="${on.includes(o.value)}">
        ${k === 'color' ? `<i class="swatch" style="background:${SWATCH[o.value] || '#888'}"></i>` : ''}${esc(fmt(o.value))}<small>${o.n}</small></button>`).join('')}</div></div>`;
  }).join('')}
    <div class="fgroup"><span class="flabel">Price</span><div class="price-range">
      <input type="number" id="pMin" min="0" placeholder="Min $" value="${esc(query.min || '')}" aria-label="Minimum price">
      <span>–</span><input type="number" id="pMax" min="0" placeholder="Max $" value="${esc(query.max || '')}" aria-label="Maximum price"></div></div>
    <div class="fgroup"><span class="flabel">Show only</span><div class="fchips">
      <button class="fchip ${query.bestseller === '1' ? 'on' : ''}" data-toggle="bestseller">${icon('star', 13)} Best sellers</button>
      <button class="fchip ${query.today === '1' ? 'on' : ''}" data-toggle="today">${icon('clock', 13)} Found today</button></div></div>`;
  $$('#filters [data-k]').forEach(b => b.onclick = () => {
    const k = b.dataset.k, v = b.dataset.v, cur = listOf(k);
    go({ [k]: (cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v]).join(SEP(k)) });
  });
  $$('#filters [data-toggle]').forEach(b => b.onclick = () => go({ [b.dataset.toggle]: query[b.dataset.toggle] === '1' ? '' : '1' }));
  const price = debounce(() => go({ min: $('#pMin').value, max: $('#pMax').value }), 500);
  $('#pMin').oninput = price; $('#pMax').oninput = price;

  // active filter summary
  const active = [];
  for (const [k, label, fmt] of GROUPS) for (const v of listOf(k)) active.push({ k, v, text: `${label}: ${fmt(v)}` });
  if (query.min || query.max) active.push({ k: 'price', text: `Price ${query.min ? '$' + query.min : '$0'}–${query.max ? '$' + query.max : 'any'}` });
  if (query.bestseller === '1') active.push({ k: 'bestseller', text: 'Best sellers' });
  if (query.today === '1') active.push({ k: 'today', text: 'Found today' });
  if (query.run) active.push({ k: 'run', text: 'From one hunt' });
  if (query.q) active.push({ k: 'q', text: `“${query.q}”` });
  $('#filterN').hidden = !active.length; $('#filterN').textContent = active.length;
  $('#activeFilters').innerHTML = active.length ? active.map((a, i) => `<button class="achip" data-i="${i}">${esc(a.text)} ${icon('x', 13)}</button>`).join('') + `<button class="link-btn" id="clearAll">Clear all</button>` : '';
  $$('#activeFilters [data-i]').forEach(b => b.onclick = () => {
    const a = active[Number(b.dataset.i)];
    if (a.k === 'price') go({ min: '', max: '' });
    else if (a.v) go({ [a.k]: listOf(a.k).filter(x => x !== a.v).join(SEP(a.k)) });
    else go({ [a.k]: '' });
  });
  $('#clearAll')?.addEventListener('click', () => { location.hash = '#/jackets?status=' + query.status; });
}

// ---------- grid ----------
function skeletons(n) { return Array.from({ length: n }, () => `<div class="card skel"><div class="card-media"></div><div class="card-body"><i></i><i></i><i class="short"></i></div></div>`).join(''); }

function card(p, i) {
  const sel = selected.has(p.id);
  const hover = p.thumbs?.[1];
  return `
  <article class="card ${sel ? 'selected' : ''} status-${p.status}" data-id="${p.id}" data-i="${i}" tabindex="${i === focusIdx ? 0 : -1}" aria-label="${esc(p.title)}, ${esc(money(p.price, p.currency))}">
    <a class="card-media zoomable" href="${esc(productHref(p.id))}" tabindex="-1">
      <img src="${esc(p.thumb || p.mainImage)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${esc(p.mainImage)}">
      ${hover ? `<img class="hover-img" src="${esc(hover)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
      <span class="badge src">${esc(sourceLabel(p))}</span>
      ${p.isBestseller ? `<span class="badge best">${icon('star', 12)} Best seller</span>` : ''}
      ${p.status !== 'new' ? `<span class="ribbon ${p.status}">${p.status === 'approved' ? icon('check', 13) + ' Approved' : icon('x', 13) + ' Rejected'}</span>` : ''}
    </a>
    <label class="select-box" title="Select (X)"><input type="checkbox" ${sel ? 'checked' : ''} data-select="${p.id}" aria-label="Select ${esc(p.title)}"><span>${icon('check', 14)}</span></label>
    <div class="card-tools">
      <button class="tool" data-qv="${p.id}" aria-label="Quick view" title="Quick view (Space)">${icon('eye', 16)}</button>
      <button class="tool ${compare.has(p.id) ? 'on' : ''}" data-compare="${p.id}" aria-label="Add to compare" title="Compare (C)">${icon('compare', 16)}</button>
      ${canEdit() ? `<button class="tool" data-board="${p.id}" aria-label="Add to board" title="Add to board (B)">${icon('board', 16)}</button>` : ''}
    </div>
    <div class="card-body">
      <a class="card-title" href="${esc(productHref(p.id))}" tabindex="-1">${esc(p.title)}</a>
      <div class="card-meta">
        <span class="price">${money(p.price, p.currency)}</span>
        ${p.profit ? `<span class="card-profit ${p.profit.profit < 0 ? 'neg' : ''}" title="Your profit if you sell it at this price (${p.profit.margin}%)">${p.profit.profit < 0 ? '' : '+'}${money(p.profit.profit)} profit</span>` : ''}
      </div>
      <div class="card-line">
        ${p.visionColor ? `<i class="swatch" style="background:${SWATCH[p.visionColor] || '#888'}"></i>` : ''}<span>${esc([cap(p.visionColor), cap(p.visionStyle)].filter(Boolean).join(' · ') || p.leather)}</span>
        <span class="card-extra">
          ${p.match !== null && p.match !== undefined ? `<span title="How close this is to jackets you approved">${icon('heart', 12)}${p.match}%</span>` : ''}
          ${p.dupes ? `<span title="Same jacket in ${p.dupes} other shop(s)">${icon('merge', 12)}${p.dupes + 1} shops</span>` : ''}
          ${p.commentCount ? `<span title="Comments">${icon('message', 12)}${p.commentCount}</span>` : ''}
        </span>
      </div>
      <div class="card-actions" ${canEdit() ? '' : 'hidden'}>
        <button class="btn reject sm ${p.status === 'rejected' ? 'active' : ''}" data-s="rejected" aria-label="Reject">${icon('x', 15)}<span>Reject</span></button>
        <button class="btn approve sm ${p.status === 'approved' ? 'active' : ''}" data-s="approved" aria-label="Approve">${icon('check', 15)}<span>Approve</span></button>
      </div>
    </div>
  </article>`;
}

function paintGrid(first, added) {
  const grid = $('#grid');
  grid.setAttribute('aria-busy', 'false');
  $('#total').textContent = cache.total;
  const items = first ? cache.items : added;
  const offset = first ? 0 : cache.items.length - added.length;
  let html = '';
  let prevTopic = first ? null : cache.items[offset - 1]?.trendTopic ?? null;
  items.forEach((p, k) => {
    if (query.sort === 'topic' && (p.trendTopic || '') !== (prevTopic ?? '__')) {
      const n = cache.items.filter(x => (x.trendTopic || '') === (p.trendTopic || '')).length;
      html += `<h3 class="group-h">${p.trendTopic ? `${icon('trend', 16)} ${esc(p.trendTopic)}` : 'Other jackets'} <small>${n}</small></h3>`;
      prevTopic = p.trendTopic || '';
    }
    html += card(p, offset + k);
  });
  if (first) grid.innerHTML = html || emptyState(); else grid.insertAdjacentHTML('beforeend', html);
  bindCards(grid);
  $('#endNote').textContent = cache.items.length && cache.page >= cache.pages ? `That's all ${plural(cache.total, 'jacket')}` : '';
  observer?.disconnect();
  if (cache.page < cache.pages) {
    observer = new IntersectionObserver(es => { if (es[0].isIntersecting) { observer.disconnect(); load(false); } }, { rootMargin: '900px' });
    observer.observe($('#sentinel'));
  }
  paintBulk();
}

function emptyState() {
  const filtered = Object.keys(query).some(k => !['status', 'sort'].includes(k));
  return `<div class="empty">${icon(filtered ? 'filter' : 'sparkle', 38)}
    <h2>${filtered ? 'No jackets match these filters' : query.status === 'new' ? 'All caught up' : 'Nothing here yet'}</h2>
    <p>${filtered ? 'Try removing a filter or two.' : query.status === 'new' ? 'Every jacket has been reviewed. Run a hunt to find fresh ones.' : 'Jackets you mark will show up here.'}</p>
    ${filtered ? `<a class="btn ghost" href="#/jackets?status=${esc(encodeURIComponent(query.status || 'new'))}">Clear filters</a>` : `<a class="btn gold" href="#/hunts">${icon('radar', 16)} Go to hunts</a>`}</div>`;
}

function bindCards(scope) {
  $$('.card[data-id]', scope).forEach(el => {
    if (el._bound) return; el._bound = true;
    const id = Number(el.dataset.id);
    el.querySelectorAll('[data-s]').forEach(b => b.onclick = e => { e.preventDefault(); setStatus([id], b.dataset.s); });
    el.querySelector('[data-qv]').onclick = () => quickView(id, { onStatus: (pid, s) => setStatus([pid], s) });
    el.querySelector('[data-compare]').onclick = () => compare.toggle(id);
    el.querySelector('[data-board]')?.addEventListener('click', () => addToBoard([id]));
    // hover zoom: the photo follows the mouse
    const media = el.querySelector('.zoomable'), img = media.querySelector('img');
    if (!isTouch()) {
      media.addEventListener('mousemove', e => { const r = media.getBoundingClientRect(); img.style.transformOrigin = `${(e.clientX - r.left) / r.width * 100}% ${(e.clientY - r.top) / r.height * 100}%`; });
      media.addEventListener('mouseleave', () => { img.style.transformOrigin = ''; });
    }
    el.querySelector('[data-select]').onchange = e => toggleSelect(id, e.target.checked);
    el.addEventListener('focus', () => { focusIdx = Number(el.dataset.i); });
    // long-press selects on touch screens
    let t; el.addEventListener('touchstart', () => { t = setTimeout(() => { toggleSelect(id); navigator.vibrate?.(15); }, 480); }, { passive: true });
    el.addEventListener('touchend', () => clearTimeout(t)); el.addEventListener('touchmove', () => clearTimeout(t), { passive: true });
  });
}

// optimistic status: update cache + cards now, server via changeStatus (with undo)
function apply(changes) {
  for (const { id, status } of changes) {
    const p = cache.items.find(x => x.id === id);
    if (!p) continue;
    const was = p.status;
    p.status = status;
    const el = $(`.card[data-id="${id}"]`);
    if (query.status !== 'all') {
      if (was === query.status && status !== query.status) cache.total--;
      if (was !== query.status && status === query.status) cache.total++;
    }
    if (!el) continue;
    if (query.status !== 'all' && status !== query.status) {
      el.classList.add('leaving');
      setTimeout(() => { if (p.status !== query.status) el.classList.add('gone'); }, 240);
    } else {
      el.outerHTML = card(p, Number(el.dataset.i));
      bindCards($('#grid'));
    }
  }
  $('#total') && ($('#total').textContent = Math.max(0, cache.total));
}
function setStatus(ids, status) { ids.forEach(id => selected.delete(id)); paintBulk(); return changeStatus(ids, status, apply); }

// ---------- selection + bulk bar ----------
function toggleSelect(id, on = !selected.has(id)) {
  on ? selected.add(id) : selected.delete(id);
  const el = $(`.card[data-id="${id}"]`);
  el?.classList.toggle('selected', on);
  const cb = el?.querySelector('[data-select]'); if (cb) cb.checked = on;
  paintBulk();
}
function paintBulk() {
  const bar = $('#bulkbar');
  if (!bar) return;
  document.body.classList.toggle('selecting', selected.size > 0);
  if (!selected.size) { bar.hidden = true; return; }
  bar.hidden = false;
  const ids = [...selected];
  bar.innerHTML = `<b>${selected.size} selected</b>
    <button class="btn approve sm" data-b="approved">${icon('check', 15)} Approve</button>
    <button class="btn reject sm" data-b="rejected">${icon('x', 15)} Reject</button>
    <button class="btn ghost sm" data-b="new">Move to New</button>
    <button class="btn ghost sm" data-b="board">${icon('board', 15)} Add to board</button>
    <button class="btn ghost sm" data-b="compare" ${ids.length < 2 || ids.length > 4 ? 'disabled' : ''}>${icon('compare', 15)} Compare</button>
    <button class="btn ghost sm danger-text" data-b="delete" data-perm="jackets.delete">${icon('trash', 15)} Delete</button>
    <button class="link-btn" data-b="all">Select all ${cache.items.length}</button>
    <button class="icon-btn" data-b="clear" aria-label="Clear selection">${icon('x')}</button>`;
  bar.querySelectorAll('[data-b]').forEach(b => b.onclick = async () => {
    const a = b.dataset.b;
    if (['approved', 'rejected', 'new'].includes(a)) setStatus(ids, a);
    if (a === 'compare') location.hash = '#/compare?ids=' + ids.join(',');
    if (a === 'board') addToBoard(ids);
    if (a === 'delete') await deleteJackets(ids, () => { selected.clear(); cache.key = null; renderJackets(root, new URLSearchParams(queryString(query))); });
    if (a === 'all') { cache.items.forEach(p => selected.add(p.id)); $$('.card[data-id]').forEach(el => { el.classList.add('selected'); el.querySelector('[data-select]').checked = true; }); paintBulk(); }
    if (a === 'clear') { selected.clear(); $$('.card.selected').forEach(el => { el.classList.remove('selected'); el.querySelector('[data-select]').checked = false; }); paintBulk(); }
  });
}

// ---------- saved views ----------
async function openViews() {
  const menu = $('#viewsMenu'), btn = $('#viewsBtn');
  if (!menu.hidden) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
  menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
  menu.innerHTML = '<div class="menu-item muted">Loading…</div>';
  const close = e => { if (!menu.contains(e.target) && e.target !== btn) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', close); } };
  document.addEventListener('mousedown', close);
  const { views } = await api('/views').catch(() => ({ views: [] }));
  menu.innerHTML = `${views.length ? views.map(v => `<div class="menu-item"><a href="#/jackets?${esc(queryString(v.query))}">${icon('bookmark', 15)} ${esc(v.name)}</a><button class="icon-btn sm" data-del="${v.id}" aria-label="Delete view ${esc(v.name)}">${icon('x', 14)}</button></div>`).join('') : '<div class="menu-item muted">Nothing saved yet</div>'}
    <div class="menu-sep"></div><button class="menu-item" id="saveView">${icon('plus', 15)} Save these filters…</button>`;
  menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => { menu.hidden = true; }));
  menu.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('/views/' + b.dataset.del, { method: 'DELETE' }); menu.hidden = true; openViews(); });
  $('#saveView').onclick = () => {
    menu.hidden = true;
    const m = openModal(`<h2 class="modal-title">Save these filters</h2><p class="muted">Saves the current status, search, filters and sort.</p>
      <label class="field"><span>Name</span><input id="viewName" maxlength="60" placeholder="e.g. Women's biker under $200" autofocus></label>
      <div class="modal-actions"><button class="btn ghost" data-c>Cancel</button><button class="btn gold" data-ok>Save</button></div>`, { label: 'Save view' });
    const save = async () => {
      const name = m.querySelector('#viewName').value.trim();
      if (!name) return m.querySelector('#viewName').focus();
      const { page, size, ...q } = query;
      await api('/views', { method: 'POST', body: { name, query: q } });
      closeModal(); toast(`Saved view “${name}”`);
    };
    m.querySelector('[data-ok]').onclick = save;
    m.querySelector('#viewName').onkeydown = e => { if (e.key === 'Enter') save(); };
    m.querySelector('[data-c]').onclick = closeModal;
  };
}

// ---------- keyboard ----------
function columns() { const g = $('#grid'); return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 1; }
function focusCard(i) {
  const cards = $$('#grid .card[data-id]:not(.gone)');
  if (!cards.length) return;
  i = Math.max(0, Math.min(cards.length - 1, i));
  cards.forEach(c => c.tabIndex = -1);
  const el = cards[i]; el.tabIndex = 0; el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  focusIdx = i;
}
export function jacketsKey(e) {
  const cards = $$('#grid .card[data-id]:not(.gone)');
  const cur = cards.indexOf(document.activeElement?.closest?.('.card'));
  const id = cur >= 0 ? Number(cards[cur].dataset.id) : null;
  const k = e.key;
  if (k === 'ArrowRight' || k === 'j') { focusCard(cur + 1); return true; }
  if (k === 'ArrowLeft' || k === 'k') { focusCard(cur - 1); return true; }
  if (k === 'ArrowDown') { focusCard(cur < 0 ? 0 : cur + columns()); return true; }
  if (k === 'ArrowUp') { focusCard(cur - columns()); return true; }
  if (e.shiftKey && (k === 'A' || k === 'R') && selected.size) { setStatus([...selected], k === 'A' ? 'approved' : 'rejected'); return true; }
  if (id === null) { if (['a', 'r', 'n', 'x', ' ', 'Enter', 'c', 'b'].includes(k)) { focusCard(0); return true; } return false; }
  if (!canEdit() && ['a', 'r', 'n', 'A', 'R'].includes(k)) return false;
  const next = () => setTimeout(() => focusCard(query.status === 'all' ? cur + 1 : cur), 260);
  if (k === 'a') { setStatus([id], 'approved'); next(); return true; }
  if (k === 'r') { setStatus([id], 'rejected'); next(); return true; }
  if (k === 'n') { setStatus([id], 'new'); next(); return true; }
  if (k === 'x') { toggleSelect(id); return true; }
  if (k === 'c') { compare.toggle(id); return true; }
  if (k === 'b' && canEdit()) { addToBoard([id]); return true; }
  if (k === ' ') { quickView(id, { onStatus: (pid, s) => { setStatus([pid], s); next(); } }); return true; }
  if (k === 'Enter') { location.hash = productHref(id); return true; }
  if (k === 'Escape' && selected.size) { selected.clear(); $$('.card.selected').forEach(el => { el.classList.remove('selected'); el.querySelector('[data-select]').checked = false; }); paintBulk(); return true; }
  return false;
}

// live: new jackets arrived during a hunt
export function jacketsArrived(n) {
  if (!$('#newBanner')) { cache.key = null; return; }
  fresh += n;
  const b = $('#newBanner');
  b.hidden = false;
  b.innerHTML = `${icon('sparkle', 16)} ${plural(fresh, 'new jacket')} found — show them`;
}
export const invalidateJackets = () => { cache.key = null; };
// someone else approved / rejected / deleted: update the grid in place
export function remoteStatus(changes) {
  const live = changes.filter(c => cache.items.some(p => p.id === c.id));
  if (!live.length) return;
  const gone = live.filter(c => c.deleted);
  for (const c of gone) { cache.items = cache.items.filter(p => p.id !== c.id); $(`.card[data-id="${c.id}"]`)?.classList.add('leaving', 'gone'); cache.total--; }
  const moved = live.filter(c => !c.deleted);
  if (moved.length && $('#grid')) apply(moved);
  else if (moved.length) for (const c of moved) { const p = cache.items.find(x => x.id === c.id); if (p) p.status = c.status; }
  $('#total') && ($('#total').textContent = Math.max(0, cache.total));
}
export const productLinkQuery = () => queryString(query);
export { renderTray };
