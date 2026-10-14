// Insights: trend timeline, competitor tracker, price bands, weekly report, health panel, tech pack.
import { api, esc, icon, money, cap, plural, ago, when, SWATCH, SOURCES, sourceLabel, $ } from './core.js';
import { bars, hbars, donut } from './charts.js';
import { kpi } from './home.js';

const TABS = [['', 'Trends'], ['breakdown', 'Breakdown'], ['competitors', 'Competitors'], ['prices', 'Price bands']];
const tabs = cur => `<nav class="tabs-line" aria-label="Insights">${TABS.map(([k, l]) => `<a href="#/insights${k ? '/' + k : ''}" class="${cur === k ? 'on' : ''}">${l}</a>`).join('')}<a href="#/report">Weekly report</a></nav>`;

// tiny inline trend line for 12 weekly values
function spark(values, w = 120, h = 30) {
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1) * (w - 4) + 2).toFixed(1)},${(h - 3 - v / max * (h - 6)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="spark" aria-hidden="true"><polyline points="${pts}" class="spark-line" fill="none"/></svg>`;
}
const J = (key, v) => `#/jackets?status=all&${key}=${encodeURIComponent(v)}`;
const change = c => `<span class="chg ${c > 0 ? 'up' : c < 0 ? 'down' : ''}">${c > 0 ? '▲' : c < 0 ? '▼' : '•'} ${Math.abs(c)}%</span>`;

export async function renderInsights(app, sub) {
  app.innerHTML = '<div class="skel-block tall"></div>';
  if (sub === 'competitors') return competitors(app);
  if (sub === 'prices') return prices(app);
  if (sub === 'breakdown') return breakdown(app);
  const d = await api('/insights/timeline');
  const block = (title, list, swatch, key) => `<div class="panel"><div class="panel-head"><h2>${title}</h2><span class="muted small">last 4 weeks vs 4 before</span></div>
    <ul class="trend-rows">${list.map(s => `<li><a class="tr-link" href="${J(key, s.value)}" data-tip="${esc(`${cap(s.value)}
${s.recent} found in the last 4 weeks
${s.change > 0 ? 'Up ' : s.change < 0 ? 'Down ' : 'No change '}${s.change ? Math.abs(s.change) + '% ' : ''}vs the 4 weeks before
Weekly: ${s.weeks.join(' · ')}`)}"><span class="tr-name">${swatch ? `<i class="swatch" style="background:${SWATCH[s.value] || '#888'}"></i>` : ''}${esc(cap(s.value))}</span>${spark(s.weeks)}<b>${s.recent}</b>${change(s.change)}</a></li>`).join('') || '<li class="muted">Not enough data yet</li>'}</ul></div>`;
  const rate = (title, list, key) => `<div class="panel"><div class="panel-head"><h2>${title}</h2><span class="muted small">share you approve</span></div>
    <ul class="trend-rows">${list.slice(0, 8).map(s => `<li><a class="tr-link" href="${J(key, s.value)}" data-tip="${esc(`${cap(s.value)}
${s.rate}% approved
out of ${s.n} you reviewed`)}"><span class="tr-name">${esc(cap(s.value))}</span><span class="hb-track"><i style="width:${s.rate}%"></i></span><b>${s.rate}%</b><small class="muted">${s.n}</small></a></li>`).join('') || '<li class="muted">Approve or reject a few jackets first</li>'}</ul></div>`;
  app.innerHTML = `
  <header class="page-head"><div><p class="eyebrow">Insights</p><h1>What's rising</h1><p class="lead-line">Which styles and colours your hunts are finding more of lately — and which ones you like.</p></div></header>
  ${tabs('')}
  <section class="panels two">
    ${block('Styles', d.styles, false, 'style')}${block('Colours', d.colors, true, 'color')}${block('Leather types', d.leathers, false, 'leather')}
    ${rate('Styles you approve', d.approvedStyles, 'style')}${rate('Colours you approve', d.approvedColors, 'color')}
    <div class="panel"><div class="panel-head"><h2>Google Trends history</h2><span class="muted small">rising “leather jacket” searches</span></div>
      <ul class="topic-days">${d.topics.slice().reverse().slice(0, 10).map(t => `<li><span class="muted small">${esc(t.day)}</span><span>${(t.rising.length ? t.rising : t.top).slice(0, 5).map(x => `<a class="chip sm" href="#/jackets?status=all&q=${encodeURIComponent(x)}">${esc(x)}</a>`).join('') || '<span class="muted">—</span>'}</span></li>`).join('') || '<li class="muted">Builds up day by day as hunts run</li>'}</ul></div>
  </section>`;
}

// Breakdown: where jackets come from, prices, styles, colours (moved here from the Overview)
async function breakdown(app) {
  const d = await api('/insights');
  const approvalRate = x => x.approved + x.rejected ? Math.round(x.approved / (x.approved + x.rejected) * 100) + '% approved' : 'not reviewed yet';
  const reviewed = d.sources.some(x => x.approved + x.rejected);
  const short = l => l.replace(/–\d+$/, '+').replace(/\+\+$/, '+');
  app.innerHTML = `
  <header class="page-head"><div><p class="eyebrow">Insights</p><h1>Breakdown</h1><p class="lead-line">All ${plural(d.total, 'jacket')} split by source, price, style and colour.</p></div></header>
  ${tabs('breakdown')}
  <section class="panels two">
    <div class="panel"><div class="panel-head"><h2>Where they come from</h2></div>${donut(d.sources.map(x => ({ label: SOURCES[x.source] || x.source, value: x.total, href: J('source', x.source) })))}</div>
    <div class="panel"><div class="panel-head"><h2>Price ranges</h2><span class="muted small">starting price of each band</span></div>${bars(d.priceBuckets.map(b => { const [, lo, hi] = b.label.match(/(\d+)(?:–(\d+))?/) || []; return { label: short(b.label), title: b.label, value: b.n, href: `#/jackets?status=all&min=${lo || ''}${hi ? '&max=' + (hi - 0.01) : ''}` }; }), { height: 170 })}</div>
    <div class="panel"><div class="panel-head"><h2>Top styles</h2></div>${hbars(d.styles.map(x => ({ label: cap(x.value), value: x.n, href: J('style', x.value) })))}</div>
    <div class="panel"><div class="panel-head"><h2>Top colours</h2></div>${hbars(d.colors.map(x => ({ label: cap(x.value), value: x.n, swatch: SWATCH[x.value] || '#888', href: J('color', x.value) })))}</div>
    ${reviewed ? `<div class="panel"><div class="panel-head"><h2>Best sources</h2><span class="muted small">jackets you approved</span></div>${hbars(d.sources.map(x => ({ label: SOURCES[x.source] || x.source, value: x.approved, extra: approvalRate(x), href: `#/jackets?status=approved&source=${encodeURIComponent(x.source)}` })), { fmt: v => v + ' ✓', unit: 'approved' })}</div>` : ''}
    ${d.topics.length ? `<div class="panel"><div class="panel-head"><h2>Trend topics</h2></div><ul class="topics">${d.topics.map(t => `<li><a href="#/jackets?status=all&topic=${encodeURIComponent(t.topic)}">${icon('trend', 14)} ${esc(t.topic)}</a><span class="muted">${plural(t.total, 'jacket')}</span><b>${t.approved} ✓</b></li>`).join('')}</ul></div>` : ''}
  </section>`;
}

async function competitors(app) {
  const { items } = await api('/insights/competitors');
  app.innerHTML = `
  <header class="page-head"><div><p class="eyebrow">Insights</p><h1>Competitor tracker</h1><p class="lead-line">The shops your jackets come from: how many they sell, their prices, and what's new.</p></div></header>
  ${tabs('competitors')}
  <section class="comp-grid">${items.map(c => `
    <article class="comp">
      <div class="row-between"><b class="comp-name">${esc(c.name)}</b><span class="pill">${esc(SOURCES[c.kind] || c.kind)}</span></div>
      <div class="comp-stats">
        <span><b>${c.total}</b><small>jackets</small></span><span><b>${c.newWeek}</b><small>new this week</small></span>
        <span><b>${c.avgPrice ? money(c.avgPrice, c.currency) : '—'}</b><small>avg price</small></span><span><b>${c.approved}</b><small>you approved</small></span>
      </div>
      <p class="muted small">${[c.bestSellers ? `${c.bestSellers} best sellers` : '', c.priceChanges ? `${c.priceChanges} price changes (${c.drops} drops)` : '', c.soldOut ? `${c.soldOut} sold out` : ''].filter(Boolean).join(' · ') || 'No price changes seen yet'}</p>
      <div class="comp-latest">${c.latest.map(p => `<a href="#/product/${p.id}" title="${esc(p.title)}"><img src="${esc(p.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"><small>${money(p.price, p.currency)}</small></a>`).join('')}</div>
      <a class="link-btn" href="#/jackets?status=all&q=${encodeURIComponent(c.name.replace(/ \((eBay|Etsy)\)$/, ''))}">See all ${icon('chevronR', 14)}</a>
    </article>`).join('') || `<div class="empty">${icon('store', 34)}<h2>No competitors yet</h2><p>Run a hunt first.</p></div>`}</section>`;
}

async function prices(app) {
  const d = await api('/insights/prices');
  const table = (title, rows, key) => {
    const max = Math.max(1, ...rows.map(r => r.max));
    return `<div class="panel span2"><div class="panel-head"><h2>${title}</h2><span class="muted small">USD · lowest · typical range · highest</span></div>
    <ul class="bands">${rows.map(r => `<li ${key ? `class="band-link" data-href="${J(key, r.value)}"` : ''} tabindex="0" data-tip="${esc(`${cap(r.value)} · ${r.n} jackets
Lowest ${money(r.min)} · highest ${money(r.max)}
Typical ${money(r.p25)}–${money(r.p75)}
Middle price ${money(r.median)}`)}"><span class="tr-name">${esc(cap(r.value))} <small class="muted">${r.n}</small></span>
      <span class="band"><i class="whisker" style="left:${r.min / max * 100}%;width:${(r.max - r.min) / max * 100}%"></i><i class="box" style="left:${r.p25 / max * 100}%;width:${Math.max(1, (r.p75 - r.p25) / max * 100)}%"></i><i class="med" style="left:${r.median / max * 100}%"></i></span>
      <span class="band-nums">${money(r.min)} · <b>${money(r.p25)}–${money(r.p75)}</b> · ${money(r.max)}</span></li>`).join('') || '<li class="muted">Not enough priced jackets yet</li>'}</ul></div>`;
  };
  app.innerHTML = `<header class="page-head"><div><p class="eyebrow">Insights</p><h1>Market price bands</h1><p class="muted">Price your jackets inside the typical range (the dark box) to be competitive. Hover a row for the exact prices; click to see those jackets.</p></div></header>
  ${tabs('prices')}<section class="panels">${table('By style', d.styles, 'style')}${table('By leather', d.leathers, 'leather')}${table('By market', d.markets)}${table('By gender', d.genders, 'gender')}</section>`;
}

// ---------- weekly report (printable) ----------
export async function renderReport(app, params) {
  app.innerHTML = '<div class="skel-block tall"></div>';
  const week = params.get('week') || '';
  const d = await api('/insights/weekly' + (week ? '?week=' + week : ''));
  const shift = days => { const t = new Date(d.from + 'T12:00'); t.setDate(t.getDate() + days); return t.toISOString().slice(0, 10); };
  const mini = list => list.map(p => `<a class="rep-item" href="#/product/${p.id}"><img src="${esc(p.thumb || p.mainImage)}" alt="" referrerpolicy="no-referrer"><span><b>${esc(p.title)}</b><small>${money(p.price, p.currency)}${p.profit ? ` · ${money(p.profit.profit)} profit` : ''} · ${esc(sourceLabel(p))}</small></span></a>`).join('') || '<p class="muted">None</p>';
  app.innerHTML = `
  <header class="page-head"><div><p class="eyebrow">Weekly report</p><h1>${new Date(d.from + 'T12:00').toLocaleDateString([], { day: 'numeric', month: 'long' })} – ${new Date(d.to + 'T12:00').toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}</h1></div>
    <div class="head-actions no-print"><a class="btn ghost" href="#/report?week=${shift(-7)}">${icon('chevronL', 15)} Previous week</a><a class="btn ghost" href="#/report?week=${shift(7)}">Next week ${icon('chevronR', 15)}</a><button class="btn gold" onclick="print()">${icon('printer', 15)} Save as PDF</button></div></header>
  <section class="kpis">
    ${kpi({ label: 'Jackets found', value: d.found, sub: `${plural(d.hunts, 'hunt')}${d.failedHunts ? ` · ${d.failedHunts} failed` : ''}`, ic: 'radar', href: '#/hunts' })}
    ${kpi({ label: 'Approved', value: d.approved, sub: d.approvalRate === null ? 'nothing reviewed yet' : d.approvalRate + '% of reviewed', ic: 'check', href: '#/jackets?status=approved' })}
    ${kpi({ label: 'Rejected', value: d.rejected, sub: 'jackets you dropped', ic: 'x', href: '#/jackets?status=rejected' })}
    ${kpi({ label: 'Price drops seen', value: d.priceDrops, sub: 'on watched jackets', ic: 'trend' })}
  </section>
  ${!d.found && !d.approved && !d.rejected && !d.hunts ? `<section class="panel"><div class="empty small">${icon('file', 32)}<h2>Nothing happened this week yet</h2><p>Run a hunt and review some jackets. This report fills in by itself.</p><a class="btn gold no-print" href="#/hunts">Go to Hunts</a></div></section>` : `
  <section class="panels two">
    <div class="panel"><div class="panel-head"><h2>Top approved (by profit)</h2></div><div class="rep-list">${mini(d.topApproved)}</div></div>
    <div class="panel"><div class="panel-head"><h2>Best new finds</h2></div><div class="rep-list">${mini(d.topFound)}</div></div>
    <div class="panel"><div class="panel-head"><h2>Who reviewed</h2></div><ul class="trend-rows">${d.reviewers.map(r => `<li><span class="tr-name">${icon('user', 14)} ${esc(r.name)}</span><b>${r.n}</b></li>`).join('') || '<li class="muted">Nobody yet</li>'}</ul></div>
    <div class="panel"><div class="panel-head"><h2>Where from · styles · colours</h2></div>
      <ul class="trend-rows">${[...d.sources.map(s => ({ ...s, value: SOURCES[s.value] || s.value })), ...d.styles, ...d.colors].slice(0, 12).map(s => `<li><span class="tr-name">${esc(cap(s.value))}</span><b>${s.n}</b></li>`).join('') || '<li class="muted">—</li>'}</ul></div>
  </section>`}`;
}

// ---------- health ----------
export async function renderHealth(app) {
  app.innerHTML = '<div class="skel-block tall"></div>';
  const d = await api('/health');
  const areas = [...new Set(d.checks.map(c => c.area))];
  const bad = d.checks.filter(c => c.ok === false).length;
  app.innerHTML = `
  <header class="page-head"><div><p class="eyebrow">Health</p><h1>${bad ? `${plural(bad, 'thing')} need${bad === 1 ? 's' : ''} attention` : 'Everything is running'}</h1><p class="muted">Server time ${esc(d.time.date)} ${esc(d.time.time)} (${esc(d.timezone)})</p></div>
    <div class="head-actions"><button class="btn ghost" onclick="location.reload()">${icon('refresh', 15)} Check again</button></div></header>
  ${areas.map(a => `<section class="block"><h2 class="block-title">${esc(a)}</h2><div class="health">${d.checks.filter(c => c.area === a).map(c => `
    <div class="hc ${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'off'}"><span class="hc-dot">${c.ok === true ? icon('check', 14) : c.ok === false ? icon('alert', 14) : '–'}</span><span><b>${esc(c.name)}</b><small>${esc(c.detail)}</small></span></div>`).join('')}</div></section>`).join('')}`;
}

// ---------- tech pack (print → PDF) ----------
export async function renderTechPack(app, id) {
  app.innerHTML = '<div class="skel-block tall"></div>';
  const p = await api('/products/' + id);
  const imgs = p.images.slice(0, 6);
  const row = (k, v) => v ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : '';
  app.innerHTML = `
  <div class="no-print row-between tp-bar"><a class="link-btn" href="#/product/${p.id}">${icon('chevronL', 15)} Back to jacket</a><button class="btn gold" onclick="print()">${icon('printer', 15)} Save as PDF / Print</button></div>
  <article class="techpack">
    <header class="tp-head"><img src="/icons/morrow.png" alt="Morrow" width="44"><div><small>Tech pack · ${new Date().toLocaleDateString()}</small><h1>${esc(p.title)}</h1></div></header>
    <section class="tp-photos">${imgs.map(u => `<img src="${esc(u)}" alt="" referrerpolicy="no-referrer">`).join('')}</section>
    <section class="tp-cols">
      <table class="tp-table">
        ${row('Style', cap(p.visionStyle))}${row('Colour', cap(p.visionColor))}${row('Leather', p.leather)}${row('Gender', p.gender)}${row('Brand / shop', p.brand || p.sourceDomain || sourceLabel(p))}
        ${row('Reference price', money(p.price, p.currency))}${p.profit ? row('Target cost', money(p.profit.cost)) + row('Target sell price', money(p.profit.sell)) + row('Expected margin', p.profit.margin + '%') : ''}
        ${row('Trend topic', p.trendTopic)}${row('Source link', p.link)}
        ${(p.specifics || []).slice(0, 12).map(s => row(s.name, s.value)).join('')}
      </table>
      <div class="tp-notes"><h3>Notes for the maker</h3><p>${esc(p.note || '—')}</p>
        <h3>Why we picked it</h3><ul>${(p.scoreReasons || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
        ${p.description ? `<h3>Reference description</h3><p class="tp-desc">${esc(p.description.slice(0, 1200))}</p>` : ''}
        <h3>Measurements (fill in)</h3><table class="tp-measure"><tr><th>Size</th><th>Chest</th><th>Length</th><th>Sleeve</th><th>Shoulder</th></tr>${['S', 'M', 'L', 'XL'].map(s => `<tr><td>${s}</td><td></td><td></td><td></td><td></td></tr>`).join('')}</table>
      </div>
    </section>
  </article>`;
}
