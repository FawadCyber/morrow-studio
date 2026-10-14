// Review mode: one jacket at a time. Swipe right = approve, left = reject (phone), or A / R / S keys.
import { api, esc, money, icon, toast, sourceLabel, SWATCH, cap, plural, reduceMotion, $ } from './core.js';
import { invalidateJackets } from './jackets.js';

let queue = [], idx = 0, photo = 0, history = [], busy = false, total = 0, done = 0;

export async function renderReview(app) {
  app.innerHTML = `
    <header class="page-head compact">
      <div><p class="eyebrow">Quick review</p><h1>Keep or drop?</h1><p class="lead-line">One jacket at a time. ✓ keeps it, ✕ drops it — or swipe right / left on your phone.</p></div>
      <div class="review-progress"><span id="rvCount"></span><span class="bar"><i id="rvBar"></i></span></div>
    </header>
    <div class="review" id="review"><div class="rv-card skel"></div></div>
    <div class="rv-controls" id="rvControls">
      <button class="rv-btn undo" id="rvUndo" aria-label="Undo (U)" title="Undo (U)">${icon('undo', 22)}</button>
      <button class="rv-btn reject" data-d="rejected" aria-label="Reject (R)" title="Reject (R)">${icon('x', 30)}</button>
      <button class="rv-btn skip" data-d="skip" aria-label="Skip (S)" title="Skip (S)">${icon('chevronR', 24)}</button>
      <button class="rv-btn approve" data-d="approved" aria-label="Approve (A)" title="Approve (A)">${icon('check', 30)}</button>
      <a class="rv-btn info" id="rvInfo" aria-label="Full details (Enter)" title="Full details (Enter)">${icon('eye', 22)}</a>
    </div>
    <p class="rv-hint muted small">${matchMedia('(hover: none)').matches ? 'Swipe right to approve, left to reject · tap the photo sides to flip photos' : 'A approve · R reject · S skip · U undo · ← → photos · Enter details'}</p>`;
  $('#rvUndo').onclick = undo;
  app.querySelectorAll('[data-d]').forEach(b => b.onclick = () => decide(b.dataset.d));
  history = []; idx = 0; done = 0;
  try {
    const data = await api('/products?status=new&sort=score&size=120');
    queue = data.items; total = data.total;
  } catch (e) { $('#review').innerHTML = `<div class="empty">${icon('alert', 34)}<h2>Couldn't load</h2><p>${esc(e.message)}</p></div>`; return; }
  paint();
}

function paint() {
  const box = $('#review');
  if (!box) return;
  $('#rvCount').textContent = queue.length ? `${Math.min(idx + 1, queue.length)} of ${total}` : '';
  $('#rvBar').style.width = total ? `${(done / total) * 100}%` : '0';
  $('#rvUndo').disabled = !history.length;
  if (idx >= queue.length) {
    box.innerHTML = `<div class="empty rv-done">${icon('sparkle', 40)}<h2>${done ? `Nice — ${plural(done, 'jacket')} reviewed` : 'Nothing to review'}</h2>
      <p>${queue.length ? 'That was the last one waiting.' : 'Every jacket has been reviewed. Run a hunt to find fresh ones.'}</p>
      <div class="row-center"><a class="btn ghost" href="#/jackets?status=approved">See approved</a><a class="btn gold" href="#/hunts">${icon('radar', 16)} Go to hunts</a></div></div>`;
    $('#rvControls').classList.add('dim');
    return;
  }
  $('#rvControls').classList.remove('dim');
  const p = queue[idx], next = queue[idx + 1];
  photo = 0;
  $('#rvInfo').href = `#/product/${p.id}?status=new&sort=score`;
  box.innerHTML = `${next ? `<div class="rv-card behind"><img src="${esc(next.thumb || next.mainImage)}" alt="" referrerpolicy="no-referrer"></div>` : ''}
    <article class="rv-card" id="rvCard" aria-label="${esc(p.title)}">
      <div class="rv-photo"><img id="rvImg" src="${esc(p.images[0] || p.mainImage)}" alt="${esc(p.title)}" referrerpolicy="no-referrer" draggable="false">
        <div class="rv-dots">${(p.images.length > 1 ? p.images : []).map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>
        <span class="stamp approve">Approve</span><span class="stamp reject">Reject</span>
        <button class="rv-zone left" aria-label="Previous photo"></button><button class="rv-zone right" aria-label="Next photo"></button>
      </div>
      <div class="rv-info">
        <div class="row-between"><span class="pill">${esc(sourceLabel(p))}</span>${p.isBestseller ? `<span class="pill gold">${icon('star', 12)} Best seller</span>` : ''}</div>
        <h2>${esc(p.title)}</h2>
        <div class="row-between"><span class="rv-price">${money(p.price, p.currency)}</span><span class="score">${p.score}<small>/100</small></span></div>
        <div class="card-chips">${p.visionColor ? `<span class="mini"><i class="swatch" style="background:${SWATCH[p.visionColor] || '#888'}"></i>${esc(cap(p.visionColor))}</span>` : ''}${p.visionStyle ? `<span class="mini">${esc(cap(p.visionStyle))}</span>` : ''}<span class="mini">${esc(p.leather)}</span>${p.trendTopic ? `<span class="mini topic">${icon('trend', 12)}${esc(p.trendTopic)}</span>` : ''}</div>
      </div>
    </article>`;
  const card = $('#rvCard');
  card.querySelector('.rv-zone.left').onclick = e => { e.stopPropagation(); flip(-1); };
  card.querySelector('.rv-zone.right').onclick = e => { e.stopPropagation(); flip(1); };
  drag(card);
}

function flip(d) {
  const p = queue[idx];
  if (!p || p.images.length < 2) return;
  photo = (photo + d + p.images.length) % p.images.length;
  $('#rvImg').src = p.images[photo];
  document.querySelectorAll('.rv-dots i').forEach((x, i) => x.classList.toggle('on', i === photo));
}

function drag(card) {
  let sx = 0, sy = 0, dx = 0, active = false;
  card.addEventListener('pointerdown', e => { if (e.button !== 0 || e.target.closest('button')) return; active = true; sx = e.clientX; sy = e.clientY; dx = 0; card.setPointerCapture(e.pointerId); card.classList.add('dragging'); });
  card.addEventListener('pointermove', e => {
    if (!active) return;
    const Z = window.lhZoom || 1; // the card follows the finger exactly, also when the page is auto-fitted
    dx = (e.clientX - sx) / Z; const dy = (e.clientY - sy) / Z;
    card.style.transform = `translate(${dx}px, ${dy * 0.25}px) rotate(${dx / 18}deg)`;
    card.classList.toggle('to-approve', dx > 60); card.classList.toggle('to-reject', dx < -60);
  });
  const end = () => {
    if (!active) return;
    active = false; card.classList.remove('dragging');
    if (dx > 110) decide('approved');
    else if (dx < -110) decide('rejected');
    else { card.style.transform = ''; card.classList.remove('to-approve', 'to-reject'); }
  };
  card.addEventListener('pointerup', end); card.addEventListener('pointercancel', end);
}

async function decide(d) {
  if (busy || idx >= queue.length) return;
  const p = queue[idx], card = $('#rvCard');
  busy = true;
  if (card && !reduceMotion()) {
    const x = d === 'approved' ? 1 : d === 'rejected' ? -1 : 0;
    card.style.transition = 'transform .28s ease, opacity .28s ease';
    card.style.transform = x ? `translate(${x * 120}%, 0) rotate(${x * 18}deg)` : 'translateY(-40px) scale(.96)';
    card.style.opacity = '0';
    await new Promise(r => setTimeout(r, 230));
  }
  history.push({ p, d, idx });
  idx++;
  if (d !== 'skip') done++;
  busy = false;
  paint();
  if (d === 'skip') return;
  invalidateJackets();
  try { await api(`/products/${p.id}/status`, { method: 'POST', body: { status: d } }); window.dispatchEvent(new CustomEvent('lh:stats')); }
  catch (e) { toast('Not saved: ' + e.message, { kind: 'error' }); }
}

async function undo() {
  const last = history.pop();
  if (!last) return;
  idx = last.idx;
  if (last.d !== 'skip') {
    done--;
    try { await api(`/products/${last.p.id}/status`, { method: 'POST', body: { status: 'new' } }); window.dispatchEvent(new CustomEvent('lh:stats')); }
    catch (e) { toast(e.message, { kind: 'error' }); }
  }
  paint();
  toast('Undone');
}

export function reviewKey(e) {
  if (e.key === 'a' || e.key === 'ArrowUp') { decide('approved'); return true; }
  if (e.key === 'r' || e.key === 'ArrowDown') { decide('rejected'); return true; }
  if (e.key === 's') { decide('skip'); return true; }
  if (e.key === 'u' || ((e.ctrlKey || e.metaKey) && e.key === 'z')) { undo(); return true; }
  if (e.key === 'ArrowRight' || e.key === ' ') { flip(1); return true; }
  if (e.key === 'ArrowLeft') { flip(-1); return true; }
  if (e.key === 'Enter' && queue[idx]) { location.hash = $('#rvInfo').getAttribute('href').slice(0); return true; }
  return false;
}
