// Jacket page: gallery + lightbox, decision, profit, taste match, velocity, watch, duplicates,
// comments with @mentions, history, boards, tech pack, Shopify. Also renders inside the split view.
import { api, esc, money, icon, toast, sourceLabel, SWATCH, cap, when, ago, copyText, debounce, $, $$ , safeUrl } from './core.js';
import { changeStatus, deleteJackets, compare, lightbox } from './actions.js';
import { sparkline } from './charts.js';
import { invalidateJackets } from './jackets.js';
import { addToBoard } from './boards.js';
import { me, canEdit, has } from './session.js';

let current = null, qs = '', photo = 0, view = null;

// opts.embedded: shown beside the list; opts.link(id) builds links; opts.close is the close link
export async function renderProduct(root, id, params, opts = {}) {
  qs = params.toString();
  view = { root, opts };
  const link = opts.link || (pid => `#/product/${pid}${qs ? '?' + qs : ''}`);
  root.innerHTML = `<div class="detail skel-detail"><div class="skel-block tall"></div><div class="skel-block"></div></div>`;
  let p;
  try { p = await api('/products/' + id + (qs ? '?' + qs : '')); }
  catch (e) { root.innerHTML = `<div class="empty">${icon('alert', 36)}<h2>Jacket not found</h2><p>${esc(e.message)}</p><a class="btn ghost" href="#/jackets">Back to jackets</a></div>`; return; }
  current = p; photo = 0;
  const imgs = p.images.length ? p.images : [p.mainImage];
  const thumbs = p.thumbs?.length ? p.thumbs : imgs;
  const back = opts.close || '#/jackets' + (qs ? '?' + qs : '');
  const cheaper = [...p.similar, ...(p.dupesList || [])].filter(s => s.price !== null && p.price !== null && s.price < p.price);
  const kv = (k, v) => v ? `<div class="kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>` : '';
  const seller = [p.sellerFeedback ? `${p.sellerFeedback}% positive` : '', p.sellerFeedbackScore ? `${p.sellerFeedbackScore} feedback` : '', p.rating ? `${Number(p.rating).toFixed(1)} ★` : '', p.reviewCount ? `${p.reviewCount} reviews` : ''].filter(Boolean).join(' · ');
  const edit = canEdit();
  const pr = p.profit;
  const vel = p.velocity;

  root.innerHTML = `
  <nav class="crumbs" aria-label="Breadcrumb">
    <a href="${back}">${opts.embedded ? icon('x', 16) + ' Close' : icon('chevronL', 16) + ' Jackets'}</a>
    <span class="muted">${p.position ? `${p.position} of ${p.of}` : ''}</span>
    <span class="crumb-nav">
      ${opts.embedded ? `<a class="icon-btn" href="#/product/${p.id}${qs ? '?' + qs.replace(/(^|&)open=\d+/, '') : ''}" aria-label="Open full page" title="Open full page">${icon('external')}</a>` : ''}
      <a class="icon-btn ${p.prevId ? '' : 'disabled'}" ${p.prevId ? `href="${link(p.prevId)}"` : 'aria-disabled="true"'} aria-label="Previous jacket" title="Previous jacket ([)">${icon('chevronL')}</a>
      <a class="icon-btn ${p.nextId ? '' : 'disabled'}" ${p.nextId ? `href="${link(p.nextId)}"` : 'aria-disabled="true"'} aria-label="Next jacket" title="Next jacket (])">${icon('chevronR')}</a>
    </span>
  </nav>

  <section class="detail ${opts.embedded ? 'embedded' : ''}">
    <div class="gallery">
      <div class="g-thumbs" role="tablist" aria-label="Photos">${thumbs.map((u, i) => `<button role="tab" data-i="${i}" class="${i ? '' : 'on'}" aria-label="Photo ${i + 1}" aria-selected="${!i}"><img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}</div>
      <div class="g-stage">
        <button class="g-main" id="gMain" aria-label="Open photo full screen"><img id="gImg" src="${esc(imgs[0])}" alt="${esc(p.title)}" referrerpolicy="no-referrer"></button>
        ${imgs.length > 1 ? `<button class="g-nav prev" aria-label="Previous photo">${icon('chevronL', 24)}</button><button class="g-nav next" aria-label="Next photo">${icon('chevronR', 24)}</button>` : ''}
        <span class="g-count" id="gCount">1 / ${imgs.length}</span>
        <span class="g-zoom">${icon('zoom', 15)} Click to zoom</span>
      </div>
    </div>

    <aside class="buy">
      <div class="row-between"><span class="pill">${esc(sourceLabel(p))}${p.market ? ' · ' + esc(p.market) : ''}</span><span class="status-pill ${p.status}">${p.status === 'new' ? 'Awaiting review' : cap(p.status)}${p.decidedBy && p.status !== 'new' ? ' · ' + esc(p.decidedBy) : ''}</span></div>
      <h1 class="p-title">${esc(p.title)}</h1>
      <div class="p-price">${money(p.price, p.currency)} ${cheaper.length ? `<span class="hint-warn">${icon('alert', 14)} Seen cheaper elsewhere</span>` : ''}</div>
      <div class="chips">
        ${p.visionColor ? `<span class="chip"><i class="swatch" style="background:${SWATCH[p.visionColor] || '#888'}"></i>${esc(cap(p.visionColor))}</span>` : ''}
        ${p.visionStyle ? `<span class="chip">${esc(cap(p.visionStyle))}</span>` : ''}
        <span class="chip">${esc(p.leather)}</span><span class="chip">${esc(p.gender)}</span>
        ${p.trendTopic ? `<span class="chip">${icon('trend', 13)} ${esc(p.trendTopic)}</span>` : ''}
        ${p.match !== null && p.match !== undefined ? `<span class="chip gold" title="How close this is to jackets you approved">${icon('heart', 13)} ${p.match}% your taste</span>` : ''}
      </div>

      ${edit ? `<div class="decide">
        <button class="btn reject lg ${p.status === 'rejected' ? 'active' : ''}" data-s="rejected">${icon('x', 18)} Reject <kbd>R</kbd></button>
        <button class="btn approve lg ${p.status === 'approved' ? 'active' : ''}" data-s="approved">${icon('check', 18)} Approve <kbd>A</kbd></button>
      </div>
      ${p.status !== 'new' ? `<button class="link-btn center" data-s="new">Move back to New</button>` : ''}` : '<p class="hint">You can look and comment. Ask the owner for reviewer access to approve.</p>'}

      <div class="quick-actions">
        <a class="qa" href="${esc(safeUrl(p.link))}" target="_blank" rel="noopener noreferrer">${icon('external', 17)}<span>Open in store</span></a>
        ${edit ? `<button class="qa" id="toBoard">${icon('board', 17)}<span>Add to board</span></button>` : ''}
        ${edit ? `<button class="qa ${p.watching ? 'on' : ''}" id="watch" data-perm="jackets.edit" title="Get told when the price drops or it sells out">${icon('watch', 17)}<span>${p.watching ? 'Watching' : 'Watch price'}</span></button>` : ''}
        <details class="qa-more"><summary class="qa">${icon('more', 17)}<span>More</span></summary>
          <div class="qa-menu">
            <button data-compare="${p.id}" class="${compare.has(p.id) ? 'on' : ''}">${icon('compare', 16)} Compare with others</button>
            <a href="#/techpack/${p.id}">${icon('file', 16)} Tech pack for your maker (PDF)</a>
            <a href="/api/products/${p.id}/photos.zip" download data-perm="jackets.download">${icon('download', 16)} Download all photos</a>
            <button id="copyLink">${icon('copy', 16)} Copy store link</button>
            ${edit ? `<button id="toShopify" data-perm="shopify.push">${icon('store', 16)} <span>${p.shopify ? 'Open in Shopify' : 'Send to Shopify (draft)'}</span></button>` : ''}
          </div>
        </details>
      </div>

      ${pr ? `<div class="card-box profit-box">
        <div class="row-between"><h3>${icon('dollar', 16)} Your profit</h3><b class="big-profit ${pr.profit < 0 ? 'neg' : ''}">${money(pr.profit)}<small>${pr.margin}%</small></b></div>
        <div class="profit-line"><span>Sell at</span><b>${money(pr.sell)}</b></div>
        <div class="profit-line"><span>Making cost</span>${has('jackets.edit') ? `<span class="money-in sm"><b>$</b><input type="number" min="0" id="costIn" value="${pr.cost}" aria-label="Making cost for this jacket"></span>` : `<b>${money(pr.cost)}</b>`}</div>
        <p class="muted small">Fees, shipping and your default costs are in <a href="#/settings/profit">Settings → Profit</a>.</p></div>` : ''}

      <div class="card-box">
        <div class="row-between"><h3>Why it was picked</h3><span class="score-ring" style="--v:${Math.min(100, p.score)}"><b>${p.score}</b></span></div>
        <ul class="why">${p.scoreReasons.map(r => `<li>${icon('check', 14)}${esc(r)}</li>`).join('') || '<li class="muted">No signals recorded</li>'}</ul>
        ${vel ? `<p class="small">${icon('activity', 13)} ${vel.soldPerWeek !== null ? `<b>${vel.soldPerWeek}</b> sold / week` : ''}${vel.favoritesPerWeek !== null ? ` · <b>${vel.favoritesPerWeek}</b> new favourites / week` : ''} <span class="muted">since ${ago(vel.since)}</span></p>` : ''}
        ${p.watch ? `<p class="muted small">${icon('watch', 13)} Last price check ${ago(p.watch.lastAt)}${p.watch.available === false ? ' · <b class="danger-text">sold out</b>' : p.watch.available ? ' · in stock' : ''}${p.watch.error ? ' · ' + esc(p.watch.error) : ''}${p.watch.note ? '<br>' + esc(p.watch.note) : ''}</p>` : ''}
        ${p.visionChecked ? `<p class="muted small">${icon('eye', 13)} Jacket check: ${Math.round((p.visionConfidence || 0) * 100)}% sure it's a leather jacket${p.visionNote ? ' · ' + esc(p.visionNote) : ''}</p>` : '<p class="muted small">Jacket check pending…</p>'}
      </div>

      ${(p.priceHistory || []).length > 1 ? `<div class="card-box"><h3>Price history</h3>${sparkline(p.priceHistory)}<p class="muted small">${p.priceHistory.slice(-6).map(h => `${money(h.price, p.currency)} · ${when(h.at)}`).join('<br>')}</p></div>` : ''}

      <div class="card-box">
        <label class="note-label" for="note"><h3>${icon('note', 16)} Note</h3><span class="muted small" id="noteState"></span></label>
        <textarea id="note" rows="3" placeholder="Fit, quality, supplier ideas…" ${has('jackets.edit') ? '' : 'readonly'}>${esc(p.note || '')}</textarea>
      </div>
    </aside>
  </section>

  ${(p.alsoAt || []).length ? `<section class="block"><h2 class="block-title">${icon('store', 20)} Also sold at</h2><p class="hint">The same jacket was found here too. It is kept only once in your list.</p><ul class="also-at">${p.alsoAt.map(x => `<li><a href="${esc(safeUrl(x.link))}" target="_blank" rel="noopener">${esc(x.shop || x.source)} ${icon('external', 13)}</a><b>${x.price !== null && x.price !== undefined ? money(x.price, x.currency) : '—'}</b></li>`).join('')}</ul></section>` : ''}
  ${p.similar.length ? `<section class="block"><h2 class="block-title">Looks similar ${cheaper.length ? `<span class="hint-warn">${cheaper.length} cheaper</span>` : ''}</h2><div class="similar">${simCards(p, p.similar)}</div></section>` : ''}

  <section class="block two-col">
    <div class="card-box">
      <h2 class="block-title">${icon('message', 20)} Comments <small class="muted" id="cCount"></small></h2>
      <ul class="comments" id="comments" data-perm="comments.view"><li class="muted">Loading…</li></ul>
      <form class="comment-form" id="cf" data-perm="comments.write"><div class="mention-wrap"><textarea id="cText" rows="2" placeholder="Write a comment… use @name to notify someone"></textarea><ul class="mention-list" id="mList" hidden></ul></div><button class="btn gold sm">${icon('send', 14)} Post</button></form>
    </div>
    <div class="card-box">
      <h2 class="block-title">${icon('clock', 20)} History</h2>
      <ul class="activity" id="hist"><li class="muted">Loading…</li></ul>
    </div>
  </section>

  <section class="block two-col">
    <div class="card-box">
      <h2 class="block-title">Item details</h2>
      ${kv('Seller', [p.sellerName || p.sourceDomain, seller].filter(Boolean).join(' · '))}${kv('Condition', p.condition)}${kv('Brand', p.brand)}${kv('Material', p.material)}
      ${kv('Located in', p.location)}${kv('Shipping', p.shipping)}${kv('Returns', p.returns)}${kv('Buying options', (p.buyingOptions || []).join(' · ').replace(/_/g, ' '))}
      ${kv('Best seller', p.isBestseller ? 'Yes — in the store\'s best sellers' : '')}${kv('Listed', p.listedAt ? new Date(p.listedAt).toLocaleDateString() : '')}
      ${kv('Matched search', p.searchQuery)}${kv('Hunted', `${when(p.createdAt)} (${ago(p.createdAt)})`)}
      ${p.specifics.map(s => kv(s.name, s.value)).join('')}
    </div>
    <div class="card-box">
      <h2 class="block-title">Description</h2>
      ${p.conditionDescription ? `<p class="desc">${esc(p.conditionDescription)}</p>` : ''}
      <p class="desc">${esc(p.description || 'No description captured.')}</p>
      ${p.tags.length ? `<div class="chips">${p.tags.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      ${edit ? `<button class="link-btn danger-text" id="delete" data-perm="jackets.delete">${icon('trash', 15)} Delete this jacket</button>` : ''}
    </div>
  </section>`;

  bindGallery(imgs, p);
  root.querySelectorAll('[data-s]').forEach(b => b.onclick = () => decide(b.dataset.s));
  root.querySelector('[data-compare]').onclick = e => { compare.toggle(p.id); e.currentTarget.classList.toggle('on', compare.has(p.id)); };
  $('#copyLink').onclick = async () => toast(await copyText(p.link) ? 'Store link copied' : 'Could not copy');
  $('#toBoard')?.addEventListener('click', () => addToBoard([p.id]));
  $('#delete')?.addEventListener('click', () => deleteJackets([p.id], () => { invalidateJackets(); location.hash = p.nextId ? link(p.nextId) : back; }));
  $('#watch')?.addEventListener('click', async e => {
    const r = await api(`/products/${p.id}/watch`, { method: 'POST', body: { on: !p.watching, now: !p.watching } });
    p.watching = r.watching; e.currentTarget.classList.toggle('on', r.watching); e.currentTarget.querySelector('span').textContent = r.watching ? 'Watching' : 'Watch price';
    toast(r.watching ? 'Watching price and stock — you\'ll be told about drops and restocks' : 'Stopped watching');
  });
  $('#toShopify')?.addEventListener('click', async e => {
    if (p.shopify) { window.open(safeUrl(p.shopify.url), '_blank', 'noopener'); return; }
    const b = e.currentTarget; b.disabled = true; b.querySelector('span').textContent = 'Sending…';
    try { const r = await api(`/products/${p.id}/shopify`, { method: 'POST' }); p.shopify = r; b.querySelector('span').textContent = 'Open in Shopify'; toast('Added to Shopify as a draft', { action: 'Open', onAction: () => window.open(r.url, '_blank', 'noopener') }); }
    catch (er) { b.querySelector('span').textContent = 'Send to Shopify (draft)'; toast(er.message, { kind: 'error', timeout: 9000 }); }
    b.disabled = false;
  });
  const costIn = $('#costIn');
  costIn?.addEventListener('change', async () => {
    const r = await api(`/products/${p.id}/cost`, { method: 'POST', body: { cost: costIn.value } });
    const box = root.querySelector('.big-profit'); box.classList.toggle('neg', r.profit.profit < 0); box.innerHTML = `${money(r.profit.profit)}<small>${r.profit.margin}%</small>`;
    toast('Cost saved for this jacket');
  });
  const noteEl = $('#note'), state = $('#noteState');
  const saveNote = debounce(async () => {
    state.textContent = 'Saving…';
    try { await api(`/products/${p.id}/note`, { method: 'POST', body: { note: noteEl.value } }); state.textContent = 'Saved'; p.note = noteEl.value; }
    catch (e) { state.textContent = 'Not saved: ' + e.message; }
  }, 700);
  if (edit) noteEl.addEventListener('input', () => { state.textContent = 'Typing…'; saveNote(); });
  loadComments(p);
  loadHistory(p);
  if (!opts.embedded) scrollTo(0, 0); else root.scrollTop = 0;
}

function simCards(p, list) {
  return list.map(s => `
    <a class="sim ${p.price !== null && s.price !== null && s.price < p.price ? 'cheaper' : ''}" href="#/product/${s.id}">
      <img src="${esc(s.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <span class="sim-body"><b>${money(s.price, s.currency)}</b>${p.price !== null && s.price !== null && s.price !== p.price ? `<small class="${s.price < p.price ? 'up' : 'down'}">${s.price < p.price ? '−' : '+'}${money(Math.abs(p.price - s.price), p.currency)}</small>` : ''}
      <span class="muted small">${esc(s.sourceDomain || s.source)}${s.match ? ` · ${s.match}% match` : ''}</span><span class="sim-title">${esc(s.title)}</span></span>
    </a>`).join('');
}

function bindGallery(imgs, p) {
  const show = i => {
    photo = (i + imgs.length) % imgs.length;
    $('#gImg').src = imgs[photo];
    $('#gCount').textContent = `${photo + 1} / ${imgs.length}`;
    $$('.g-thumbs button').forEach(b => { const on = Number(b.dataset.i) === photo; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    $(`.g-thumbs button[data-i="${photo}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  $$('.g-thumbs button').forEach(b => b.onclick = () => show(Number(b.dataset.i)));
  $('.g-nav.prev')?.addEventListener('click', () => show(photo - 1));
  $('.g-nav.next')?.addEventListener('click', () => show(photo + 1));
  $('#gMain').onclick = () => lightbox(imgs, photo, p.title);
  let sx = null;
  $('#gMain').addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  $('#gMain').addEventListener('touchend', e => { if (sx === null) return; const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 45) { e.preventDefault(); show(photo + (dx < 0 ? 1 : -1)); } sx = null; });
}

// ---------- comments with @mention suggestions ----------
let people = null;
async function loadComments(p) {
  const list = $('#comments'); if (!list) return;
  const { comments } = await api(`/products/${p.id}/comments`).catch(() => ({ comments: [] }));
  $('#cCount').textContent = comments.length || '';
  const fmt = t => esc(t).replace(/@([a-z0-9._-]+)/gi, '<b class="mention">@$1</b>');
  list.innerHTML = comments.map(c => `<li><span class="avatar sm">${esc((c.by || '?')[0].toUpperCase())}</span><div><b>${esc(c.by)}</b> <small class="muted">${ago(c.at)}</small>${c.uid === me().id || me().role === 'owner' ? `<button class="link-btn sm" data-delc="${c.id}">Delete</button>` : ''}<p>${fmt(c.text)}</p></div></li>`).join('') || '<li class="muted">No comments yet.</li>';
  list.querySelectorAll('[data-delc]').forEach(b => b.onclick = async () => { await api(`/products/${p.id}/comments/${b.dataset.delc}`, { method: 'DELETE' }); loadComments(p); });
  const form = $('#cf'), ta = $('#cText'), ml = $('#mList');
  if (form._bound) return; form._bound = true;
  people ||= (await api('/users').catch(() => ({ mentions: [] }))).mentions || [];
  let opts = [], pick = 0;
  const hide = () => { ml.hidden = true; opts = []; };
  ta.addEventListener('input', () => {
    const m = ta.value.slice(0, ta.selectionStart).match(/@([a-z0-9._-]*)$/i);
    if (!m) return hide();
    opts = people.filter(u => u.username.startsWith(m[1].toLowerCase()) || u.name.toLowerCase().startsWith(m[1].toLowerCase())).slice(0, 6);
    pick = 0;
    ml.hidden = !opts.length;
    ml.innerHTML = opts.map((u, i) => `<li class="${i ? '' : 'on'}" data-u="${esc(u.username)}"><b>${esc(u.name)}</b> <small>@${esc(u.username)}</small></li>`).join('');
  });
  const insert = username => { const pos = ta.selectionStart; const before = ta.value.slice(0, pos).replace(/@([a-z0-9._-]*)$/i, '@' + username + ' '); ta.value = before + ta.value.slice(pos); ta.focus(); hide(); };
  ml.addEventListener('mousedown', e => { const li = e.target.closest('[data-u]'); if (li) { e.preventDefault(); insert(li.dataset.u); } });
  ta.addEventListener('keydown', e => {
    if (!ml.hidden && opts.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { pick = (pick + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length; ml.querySelectorAll('li').forEach((li, i) => li.classList.toggle('on', i === pick)); e.preventDefault(); }
      if (e.key === 'Enter' || e.key === 'Tab') { insert(opts[pick].username); e.preventDefault(); }
      if (e.key === 'Escape') hide();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  });
  form.onsubmit = async e => {
    e.preventDefault();
    if (!ta.value.trim()) return;
    try { await api(`/products/${p.id}/comments`, { method: 'POST', body: { text: ta.value } }); ta.value = ''; loadComments(p); loadHistory(p); }
    catch (er) { toast(er.message, { kind: 'error' }); }
  };
}
async function loadHistory(p) {
  const el = $('#hist'); if (!el) return;
  const { items } = await api('/activity?product=' + p.id).catch(() => ({ items: [] }));
  el.innerHTML = items.map(a => `<li><b>${esc(a.user)}</b> ${esc(a.action)}${a.action === 'commented' ? ': “' + esc(a.detail.slice(0, 60)) + '”' : ''}<small class="muted">${ago(a.at)}</small></li>`).join('') + `<li><b>Hunt</b> found it<small class="muted">${ago(p.createdAt)}</small></li>`;
}

async function decide(status) {
  const p = current;
  if (!p) return;
  invalidateJackets();
  const was = p.status;
  let first = true;
  await changeStatus([p.id], status, changes => {
    const c = changes.find(x => x.id === p.id);
    if (!c) return;
    p.status = c.status;
    if (first) { first = false; return; } // the first call is the change itself; later calls are "Undo"
    if (current && current.id === p.id && view && view.root.isConnected) renderProduct(view.root, p.id, new URLSearchParams(qs), view.opts);
  });
  const link = view.opts.link || (pid => `#/product/${pid}${qs ? '?' + qs : ''}`);
  if (was === 'new' && status !== 'new' && p.nextId) location.hash = link(p.nextId);
  else renderProduct(view.root, p.id, new URLSearchParams(qs), view.opts);
}

// live: someone else changed this jacket
export function productChanged(id) {
  if (!current || current.id !== id || !view || !view.root.isConnected) return;
  // don't throw away something you're typing (a comment or a note)
  const typing = document.activeElement && view.root.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName) && document.activeElement.value;
  if (typing) return;
  const y = scrollY;
  renderProduct(view.root, id, new URLSearchParams(qs), view.opts).then(() => scrollTo(0, y)).catch(() => {});
}
export const currentProductId = () => current?.id;

export function productKey(e) {
  if (!current) return false;
  const imgsLen = current.images.length || 1;
  const link = view.opts.link || (pid => `#/product/${pid}${qs ? '?' + qs : ''}`);
  const go = id => { if (id) location.hash = link(id); };
  const edit = canEdit();
  if (edit && e.key === 'a') { decide('approved'); return true; }
  if (edit && e.key === 'r') { decide('rejected'); return true; }
  if (edit && e.key === 'n') { decide('new'); return true; }
  if (e.key === ']' || e.key === 'j') { go(current.nextId); return true; }
  if (e.key === '[' || e.key === 'k') { go(current.prevId); return true; }
  if (e.key === 'ArrowRight' && imgsLen > 1) { $('.g-nav.next')?.click(); return true; }
  if (e.key === 'ArrowLeft' && imgsLen > 1) { $('.g-nav.prev')?.click(); return true; }
  if (e.key === 'f' || e.key === ' ') { $('#gMain')?.click(); return true; }
  if (e.key === 'o') { window.open(safeUrl(current.link), '_blank', 'noopener'); return true; }
  if (e.key === 'c') { $('[data-compare]')?.click(); return true; }
  if (edit && e.key === 'b') { addToBoard([current.id]); return true; }
  if (e.key === 'Escape') { location.hash = view.opts.close || '#/jackets' + (qs ? '?' + qs : ''); return true; }
  return false;
}
