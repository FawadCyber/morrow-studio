// Actions shared by every view: status changes with undo, compare tray, quick view, lightbox.
import { api, toast, esc, money, icon, openModal, closeModal, sourceLabel, store, $, plural, cap, SWATCH, confirmDialog , safeUrl } from './core.js';

const LABEL = { approved: 'Approved', rejected: 'Rejected', new: 'Moved back to New' };

// Change status for one or many jackets. `apply(ids, status)` updates the page straight away (optimistic);
// it's called again with the old statuses on undo or failure.
export async function changeStatus(ids, status, apply = () => {}) {
  ids = [].concat(ids).map(Number);
  if (!ids.length) return;
  apply(ids.map(id => ({ id, status })));
  try {
    const r = await api('/products/bulk', { method: 'POST', body: { ids, status } });
    window.dispatchEvent(new CustomEvent('lh:stats'));
    toast(`${LABEL[status]}${ids.length > 1 ? ' · ' + plural(ids.length, 'jacket') : ''}`, {
      action: 'Undo',
      onAction: async () => {
        apply(r.previous);
        try { await api('/products/bulk', { method: 'POST', body: { ids, restore: r.previous } }); window.dispatchEvent(new CustomEvent('lh:stats')); toast('Undone'); }
        catch (e) { toast(e.message, { kind: 'error' }); }
      }
    });
    return r.previous;
  } catch (e) {
    toast('Could not save: ' + e.message, { kind: 'error' });
    window.dispatchEvent(new CustomEvent('lh:refresh'));
  }
}

export async function deleteJackets(ids, after = () => {}) {
  ids = [].concat(ids).map(Number);
  const ok = await confirmDialog({
    title: `Delete ${plural(ids.length, 'jacket')}?`,
    body: 'They are removed with their photos and will not be hunted again. This cannot be undone.',
    confirm: 'Delete', danger: true
  });
  if (!ok) return false;
  try {
    await api('/products/bulk', { method: 'POST', body: { ids, action: 'delete' } });
    toast(`Deleted ${plural(ids.length, 'jacket')}`);
    window.dispatchEvent(new CustomEvent('lh:stats'));
    after();
    return true;
  } catch (e) { toast(e.message, { kind: 'error' }); return false; }
}

// ---------- compare tray (up to 4) ----------
export const compare = {
  ids() { return store.get('compare', []); },
  has(id) { return this.ids().includes(Number(id)); },
  toggle(id) {
    id = Number(id);
    let ids = this.ids();
    if (ids.includes(id)) ids = ids.filter(x => x !== id);
    else if (ids.length >= 4) { toast('Compare holds 4 jackets - remove one first'); return false; }
    else ids = [...ids, id];
    store.set('compare', ids);
    renderTray();
    return true;
  },
  clear() { store.set('compare', []); renderTray(); }
};
export async function renderTray() {
  const tray = $('#compareTray');
  const ids = compare.ids();
  document.querySelectorAll('[data-compare]').forEach(b => b.classList.toggle('on', ids.includes(Number(b.dataset.compare))));
  if (!ids.length || !/^#\/(jackets|product)/.test(location.hash) || /[?&]open=/.test(location.hash)) { tray.hidden = true; return; }
  tray.hidden = false;
  tray.innerHTML = `<span class="tray-label">${icon('compare')} Compare</span>
    <div class="tray-items">${ids.map(id => `<span class="tray-slot" data-id="${id}"></span>`).join('')}<small class="muted">${ids.length}/4</small></div>
    <a class="btn gold sm" href="#/compare?ids=${ids.join(',')}" ${ids.length < 2 ? 'aria-disabled="true" tabindex="-1"' : ''}>Compare ${ids.length}</a>
    <button class="icon-btn" id="trayClear" aria-label="Clear compare">${icon('x')}</button>`;
  $('#trayClear').onclick = () => compare.clear();
  for (const id of ids) {
    try {
      const p = await api('/products/' + id);
      const slot = tray.querySelector(`.tray-slot[data-id="${id}"]`);
      if (slot) slot.innerHTML = `<img src="${esc(p.thumbs?.[0] || p.mainImage)}" alt="${esc(p.title)}" referrerpolicy="no-referrer"><button aria-label="Remove ${esc(p.title)}" data-rm="${id}">${icon('x', 12)}</button>`;
      slot?.querySelector('[data-rm]')?.addEventListener('click', () => compare.toggle(id));
    } catch { compare.toggle(id); }
  }
}

// ---------- lightbox: fullscreen photos with zoom + swipe ----------
export function lightbox(images, first = 0, title = '') {
  let i = first, scale = 1, tx = 0, ty = 0;
  const m = openModal(`
    <div class="lightbox">
      <div class="lb-top"><span class="lb-count"></span><span class="lb-title">${esc(title)}</span>
        <button class="icon-btn" data-z="1" aria-label="Zoom">${icon('zoom')}</button>
        <button class="icon-btn" data-close aria-label="Close" autofocus>${icon('x')}</button></div>
      <div class="lb-stage"><img alt="${esc(title)}" referrerpolicy="no-referrer" draggable="false"></div>
      ${images.length > 1 ? `<button class="lb-nav prev" aria-label="Previous photo">${icon('chevronL', 28)}</button><button class="lb-nav next" aria-label="Next photo">${icon('chevronR', 28)}</button>` : ''}
      <div class="lb-strip">${images.map((u, k) => `<button data-k="${k}" aria-label="Photo ${k + 1}"><img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}</div>
    </div>`, { wide: true, label: 'Photos' });
  m.classList.add('lb-modal');
  const img = m.querySelector('.lb-stage img');
  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; img.style.cursor = scale > 1 ? 'grab' : 'zoom-in'; };
  const show = k => {
    i = (k + images.length) % images.length; scale = 1; tx = ty = 0; apply();
    img.src = images[i];
    m.querySelector('.lb-count').textContent = `${i + 1} / ${images.length}`;
    m.querySelectorAll('[data-k]').forEach(b => b.classList.toggle('on', Number(b.dataset.k) === i));
    m.querySelector(`[data-k="${i}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  };
  const zoom = (to, cx, cy) => {
    const r = img.getBoundingClientRect();
    const nx = cx ?? r.left + r.width / 2, ny = cy ?? r.top + r.height / 2;
    const prev = scale; scale = Math.min(5, Math.max(1, to));
    const Z = window.lhZoom || 1; // screen pixels -> page pixels when the page is auto-fitted
    if (scale === 1) { tx = ty = 0; } else { tx -= (nx - (r.left + r.width / 2)) / Z * (scale / prev - 1); ty -= (ny - (r.top + r.height / 2)) / Z * (scale / prev - 1); }
    apply();
  };
  m.querySelector('[data-close]').onclick = closeModal;
  m.querySelector('[data-z]').onclick = () => zoom(scale > 1 ? 1 : 2.5);
  m.querySelector('.prev')?.addEventListener('click', () => show(i - 1));
  m.querySelector('.next')?.addEventListener('click', () => show(i + 1));
  m.querySelectorAll('[data-k]').forEach(b => b.onclick = () => show(Number(b.dataset.k)));
  img.addEventListener('dblclick', e => zoom(scale > 1 ? 1 : 2.5, e.clientX, e.clientY));
  m.querySelector('.lb-stage').addEventListener('wheel', e => { e.preventDefault(); zoom(scale * (e.deltaY < 0 ? 1.15 : 0.87), e.clientX, e.clientY); }, { passive: false });
  // drag to pan when zoomed, swipe to change photo when not; pinch to zoom
  const pts = new Map(); let start = null, pinch = null;
  const stage = m.querySelector('.lb-stage');
  stage.addEventListener('pointerdown', e => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, e); start = { x: e.clientX, y: e.clientY, tx, ty }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), s: scale }; } });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, e);
    if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()]; scale = Math.min(5, Math.max(1, pinch.s * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d)); apply(); return; }
    if (scale > 1 && start) { const Z = window.lhZoom || 1; tx = start.tx + (e.clientX - start.x) / Z; ty = start.ty + (e.clientY - start.y) / Z; apply(); }
  });
  const end = e => {
    if (pts.size === 1 && start && scale === 1) { const dx = e.clientX - start.x; if (Math.abs(dx) > 50) show(i + (dx < 0 ? 1 : -1)); }
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) start = null;
  };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
  m.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') show(i - 1); if (e.key === 'ArrowRight') show(i + 1); if (e.key === '+') zoom(scale * 1.3); if (e.key === '-') zoom(scale / 1.3); });
  show(first);
}

// ---------- quick view ----------
export async function quickView(id, { onStatus, query } = {}) {
  let p;
  try { p = await api('/products/' + id + (query ? '?' + query : '')); } catch (e) { toast(e.message, { kind: 'error' }); return; }
  const imgs = p.images.length ? p.images : [p.mainImage];
  let i = 0;
  const m = openModal(`
    <div class="qv">
      <div class="qv-gallery">
        <button class="qv-main" aria-label="Open photos full screen"><img src="${esc(imgs[0])}" alt="${esc(p.title)}" referrerpolicy="no-referrer"></button>
        ${imgs.length > 1 ? `<div class="qv-thumbs">${(p.thumbs || imgs).slice(0, 10).map((u, k) => `<button data-k="${k}" class="${k ? '' : 'on'}" aria-label="Photo ${k + 1}"><img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}</div>` : ''}
      </div>
      <div class="qv-info">
        <div class="row-between"><span class="pill">${esc(sourceLabel(p))}</span><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
        <h2 class="qv-title">${esc(p.title)}</h2>
        <div class="qv-price">${money(p.price, p.currency)}</div>
        <div class="chips">${p.visionColor ? `<span class="chip"><i class="swatch" style="background:${SWATCH[p.visionColor] || '#888'}"></i>${esc(cap(p.visionColor))}</span>` : ''}${p.visionStyle ? `<span class="chip">${esc(cap(p.visionStyle))}</span>` : ''}<span class="chip">${esc(p.leather)}</span>${p.isBestseller ? `<span class="chip gold">${icon('star', 13)} Best seller</span>` : ''}${p.trendTopic ? `<span class="chip">${icon('trend', 13)} ${esc(p.trendTopic)}</span>` : ''}</div>
        <ul class="why">${(p.scoreReasons || []).slice(0, 5).map(r => `<li>${icon('check', 14)}${esc(r)}</li>`).join('')}</ul>
        <div class="qv-actions">
          <button class="btn reject ${p.status === 'rejected' ? 'active' : ''}" data-s="rejected" data-perm="jackets.review">${icon('x', 16)} Reject <kbd>R</kbd></button>
          <button class="btn approve ${p.status === 'approved' ? 'active' : ''}" data-s="approved" data-perm="jackets.review">${icon('check', 16)} Approve <kbd>A</kbd></button>
        </div>
        <div class="qv-links"><a href="#/product/${p.id}" data-close>Full details ${icon('chevronR', 14)}</a><a href="${esc(safeUrl(p.link))}" target="_blank" rel="noopener noreferrer">Open in store ${icon('external', 14)}</a></div>
      </div>
    </div>`, { wide: true, label: p.title });
  const main = m.querySelector('.qv-main img');
  const show = k => { i = k; main.src = imgs[k]; m.querySelectorAll('[data-k]').forEach(b => b.classList.toggle('on', Number(b.dataset.k) === k)); };
  m.querySelectorAll('[data-k]').forEach(b => b.onclick = () => show(Number(b.dataset.k)));
  m.querySelector('.qv-main').onclick = () => { closeModal(); lightbox(imgs, i, p.title); };
  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal()));
  const decide = s => { closeModal(); onStatus ? onStatus(p.id, s) : changeStatus(p.id, s); };
  m.querySelectorAll('[data-s]').forEach(b => b.onclick = () => decide(b.dataset.s));
  m.addEventListener('keydown', e => {
    if (e.target.closest('input,textarea')) return;
    if (e.key === 'a') decide('approved');
    if (e.key === 'r') decide('rejected');
    if (e.key === 'ArrowRight' && imgs.length > 1) show((i + 1) % imgs.length);
    if (e.key === 'ArrowLeft' && imgs.length > 1) show((i - 1 + imgs.length) % imgs.length);
  });
}
