// Compare 2-4 jackets side by side.
import { api, esc, money, icon, sourceLabel, SWATCH, cap, $ , safeUrl } from './core.js';
import { changeStatus, compare, lightbox } from './actions.js';

export async function renderCompare(app, params) {
  const ids = (params.get('ids') || '').split(',').map(Number).filter(Boolean).slice(0, 4);
  if (ids.length < 2) {
    app.innerHTML = `<div class="empty">${icon('compare', 38)}<h2>Pick 2 to 4 jackets</h2><p>Use the ${icon('compare', 14)} button on any jacket, or select several and press Compare.</p><a class="btn gold" href="#/jackets">Browse jackets</a></div>`;
    return;
  }
  app.innerHTML = `<div class="skel-block tall"></div>`;
  const ps = (await Promise.all(ids.map(id => api('/products/' + id).catch(() => null)))).filter(Boolean);
  const prices = ps.map(p => p.price).filter(v => v !== null);
  const low = Math.min(...prices), bestScore = Math.max(...ps.map(p => p.score));
  const row = (label, fn, cls = '') => `<tr class="${cls}"><th scope="row">${label}</th>${ps.map(p => `<td>${fn(p)}</td>`).join('')}</tr>`;
  app.innerHTML = `
  <header class="page-head"><div><p class="eyebrow">Compare</p><h1>${ps.length} jackets side by side</h1></div>
    <div class="head-actions"><button class="btn ghost" id="cmpClear">${icon('x', 16)} Clear compare</button></div></header>
  <div class="compare-wrap"><table class="compare">
    <thead><tr><th></th>${ps.map((p, i) => `<th scope="col"><button class="cmp-img" data-i="${i}" aria-label="Photos of ${esc(p.title)}"><img src="${esc(p.thumbs?.[0] || p.mainImage)}" alt="" referrerpolicy="no-referrer"></button><a class="cmp-title" href="#/product/${p.id}">${esc(p.title)}</a></th>`).join('')}</tr></thead>
    <tbody>
      ${row('Price', p => `<b class="${p.price === low ? 'best' : ''}">${money(p.price, p.currency)}</b>${p.price === low && prices.length > 1 ? ' <span class="tag-best">Lowest</span>' : ''}`)}
      ${row('Hunt score', p => `<b class="${p.score === bestScore ? 'best' : ''}">${p.score}</b>/100`)}
      ${row('Source', p => esc(sourceLabel(p)))}
      ${row('Leather', p => esc(p.leather))}
      ${row('Colour', p => p.visionColor ? `<i class="swatch" style="background:${SWATCH[p.visionColor] || '#888'}"></i> ${esc(cap(p.visionColor))}` : '—')}
      ${row('Style', p => esc(cap(p.visionStyle || '—')))}
      ${row('Gender', p => esc(p.gender))}
      ${row('Photos', p => p.images.length)}
      ${row('Best seller', p => p.isBestseller ? `${icon('star', 14)} Yes` : '—')}
      ${row('Rating', p => p.rating ? `${Number(p.rating).toFixed(1)} ★${p.reviewCount ? ` (${p.reviewCount})` : ''}` : '—')}
      ${row('Condition', p => esc(p.condition || '—'))}
      ${row('Trend topic', p => esc(p.trendTopic || '—'))}
      ${row('Why picked', p => `<ul class="why tight">${p.scoreReasons.slice(0, 4).map(r => `<li>${esc(r)}</li>`).join('')}</ul>`)}
      ${row('', p => `<div class="cmp-actions" data-perm="jackets.review"><button class="btn approve sm ${p.status === 'approved' ? 'active' : ''}" data-s="approved" data-id="${p.id}">${icon('check', 15)} Approve</button><button class="btn reject sm ${p.status === 'rejected' ? 'active' : ''}" data-s="rejected" data-id="${p.id}">${icon('x', 15)} Reject</button><a class="link-btn" href="${esc(safeUrl(p.link))}" target="_blank" rel="noopener noreferrer">Store ${icon('external', 13)}</a></div>`, 'actions-row')}
    </tbody></table></div>`;
  $('#cmpClear').onclick = () => { compare.clear(); location.hash = '#/jackets'; };
  app.querySelectorAll('.cmp-img').forEach(b => b.onclick = () => { const p = ps[Number(b.dataset.i)]; lightbox(p.images.length ? p.images : [p.mainImage], 0, p.title); });
  app.querySelectorAll('[data-s]').forEach(b => b.onclick = () => changeStatus([Number(b.dataset.id)], b.dataset.s, ch => ch.forEach(c => {
    app.querySelectorAll(`[data-id="${c.id}"]`).forEach(x => x.classList.toggle('active', x.dataset.s === c.status));
  })));
}
