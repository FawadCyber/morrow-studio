// Small SVG charts that follow the theme (colours come from CSS variables).
// Every bar / point / slice / row shows a tooltip on hover, focus or tap (data-tip), and can link to the jackets behind it (href).
import { esc } from './core.js';

// ---------- one shared tooltip for every chart ----------
let tipEl = null, tipFor = null;
function tip() {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'ctip'; tipEl.setAttribute('role', 'tooltip'); tipEl.hidden = true; document.body.appendChild(tipEl); }
  return tipEl;
}
function showTip(el, x, y) {
  const t = tip(), text = el.getAttribute('data-tip');
  if (!text) return;
  if (tipFor !== el) { const [head, ...rest] = text.split('\n'); t.innerHTML = `<b>${esc(head)}</b>${rest.map(r => `<span>${esc(r)}</span>`).join('')}${el.closest('a[href]') || el.dataset.href ? '<small>Click to see these jackets</small>' : ''}`; tipFor = el; }
  t.hidden = false;
  const z = window.lhZoom || 1, w = t.offsetWidth, h = t.offsetHeight;
  const vw = innerWidth / z, vh = innerHeight / z;
  let left = x / z + 14, top = y / z - h - 12;
  if (left + w > vw - 8) left = x / z - w - 14;
  if (top < 8) top = y / z + 18;
  t.style.left = Math.max(8, Math.min(left, vw - w - 8)) + 'px';
  t.style.top = Math.max(8, Math.min(top, vh - h - 8)) + 'px';
}
function hideTip() { if (tipEl) tipEl.hidden = true; tipFor = null; }
const tipTarget = e => e.target.closest?.('[data-tip]');
document.addEventListener('pointerover', e => { if (e.pointerType === 'touch') return; const el = tipTarget(e); if (el) { el.classList.add('hot'); showTip(el, e.clientX, e.clientY); } });
document.addEventListener('pointermove', e => { if (e.pointerType === 'touch') return; const el = tipTarget(e); if (el) showTip(el, e.clientX, e.clientY); else if (tipFor) { tipFor.classList.remove('hot'); hideTip(); } });
document.addEventListener('pointerout', e => { if (e.pointerType === 'touch') return; const el = tipTarget(e); if (el && !el.contains(e.relatedTarget)) { el.classList.remove('hot'); hideTip(); } });
document.addEventListener('focusin', e => { const el = tipTarget(e); if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.top); } });
document.addEventListener('focusout', hideTip);
document.addEventListener('scroll', hideTip, true);
window.addEventListener('hashchange', hideTip);
// tapping a chart part on a phone: first tap shows the numbers, second tap opens the jackets
document.addEventListener('click', e => {
  const el = tipTarget(e);
  if (!el || e.pointerType === 'mouse') return;
  if (matchMedia('(hover: none)').matches && tipFor !== el) { e.preventDefault(); showTip(el, e.clientX, e.clientY); return; }
  if (el.dataset.href) location.hash = el.dataset.href;
});
document.addEventListener('click', e => { const el = tipTarget(e); if (el?.dataset.href && e.pointerType === 'mouse') location.hash = el.dataset.href; });

const link = (href, inner) => href ? `<a href="${esc(href)}">${inner}</a>` : inner;

// Vertical bars: [{ label, value, title?, href? }]
export function bars(data, { height = 150, labelEvery = 1, fmt = v => v, unit = 'jackets' } = {}) {
  const max = Math.max(1, ...data.map(d => d.value));
  const w = 100 / data.length;
  const gap = Math.min(1.2, w * 0.25);
  return `<div class="chart" role="img" aria-label="${esc(data.map(d => `${d.label}: ${fmt(d.value)}`).join(', '))}">
    <svg viewBox="0 0 100 ${height}" preserveAspectRatio="none" class="chart-svg" style="height:${height}px">
      ${[0.25, 0.5, 0.75, 1].map(f => `<line x1="0" x2="100" y1="${height - f * (height - 4)}" y2="${height - f * (height - 4)}" class="grid-line" vector-effect="non-scaling-stroke"/>`).join('')}
      ${data.map((d, i) => {
        const h = d.value ? Math.max(2, d.value / max * (height - 4)) : 0;
        // the hit area is the whole column so thin / empty bars are easy to hover
        return link(d.href, `<g class="bar-col" data-tip="${esc(`${d.title || d.label}\n${fmt(d.value)} ${unit}`)}" tabindex="0"><rect x="${i * w}" y="0" width="${w}" height="${height}" class="bar-hit"/><rect x="${i * w + gap / 2}" y="${height - h}" width="${w - gap}" height="${h}" rx="0.6" class="bar"/></g>`);
      }).join('')}
    </svg>
    <div class="chart-x">${data.map((d, i) => `<span style="width:${w}%">${i % labelEvery === 0 ? esc(d.label) : ''}</span>`).join('')}</div>
  </div>`;
}

// Smooth line with a shaded area, plus an optional dashed second line: labels[], main[], second[]
export function lines(labels, main, second = null, { height = 220, labelEvery = 5, names = ['', ''] } = {}) {
  const W = 1000, H = height, all = main.concat(second || []);
  const top = Math.max(4, Math.ceil(Math.max(...all, 1) / 4) * 4);
  const yOf = v => H - 6 - v / top * (H - 12);
  const pts = arr => arr.map((v, i) => [i / Math.max(1, arr.length - 1) * W, yOf(v)]);
  const smooth = p => p.map(([x, y], i) => {
    if (!i) return `M${x},${y}`;
    const [px, py] = p[i - 1], mx = (px + x) / 2;
    return `C${mx},${py} ${mx},${y} ${x},${y}`;
  }).join(' ');
  const m = pts(main), path = smooth(m);
  const ticks = [0, .25, .5, .75, 1].map(f => Math.round(top * f));
  const step = W / Math.max(1, main.length - 1);
  return `<div class="lchart" role="img" aria-label="${esc(labels.map((l, i) => `${l}: ${main[i]}${second ? ' / ' + second[i] : ''}`).join(', '))}">
    <div class="lc-y">${ticks.slice().reverse().map(t => `<span>${t}</span>`).join('')}</div>
    <div class="lc-plot">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">
        <defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" class="lc-hatch"/></pattern></defs>
        ${ticks.map(t => `<line x1="0" x2="${W}" y1="${yOf(t)}" y2="${yOf(t)}" class="grid-line" vector-effect="non-scaling-stroke"/>`).join('')}
        <path d="${path} L${W},${H} L0,${H} Z" fill="url(#hatch)" class="lc-area"/>
        ${second ? `<path d="${smooth(pts(second))}" class="lc-line2" vector-effect="non-scaling-stroke"/>` : ''}
        <path d="${path}" class="lc-line" vector-effect="non-scaling-stroke"/>
        ${m.map(([x, y], i) => `<g class="lc-hit" data-tip="${esc(`${labels[i]}\n${main[i]} ${names[0]}${second ? `\n${second[i]} ${names[1]}` : ''}`)}" tabindex="0">
          <rect x="${Math.max(0, x - step / 2)}" y="0" width="${step}" height="${H}" class="lc-zone"/>
          <line x1="${x}" x2="${x}" y1="0" y2="${H}" class="lc-guide" vector-effect="non-scaling-stroke"/>
          <line x1="${x}" x2="${x}" y1="${y}" y2="${y + 0.01}" class="lc-dot" vector-effect="non-scaling-stroke"/></g>`).join('')}
      </svg>
      <div class="lc-x">${labels.map((l, i) => i % labelEvery === 0 || i === labels.length - 1 ? `<span style="left:${i / Math.max(1, labels.length - 1) * 100}%">${esc(l)}</span>` : '').join('')}</div>
    </div>
  </div>`;
}

// Horizontal bars with labels: [{ label, value, swatch?, extra?, href? }]
export function hbars(data, { fmt = v => v, unit = 'jackets' } = {}) {
  if (!data.length) return '<p class="muted small">Nothing yet.</p>';
  const max = Math.max(1, ...data.map(d => d.value));
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return `<ul class="hbars">${data.map(d => `
    <li>${link(d.href, `<span class="hb-row" data-tip="${esc(`${d.label}\n${fmt(d.value)} ${unit} · ${Math.round(d.value / total * 100)}%${d.extra ? '\n' + d.extra : ''}`)}" tabindex="0">
      <span class="hb-label">${d.swatch ? `<i class="swatch" style="background:${d.swatch}"></i>` : ''}${esc(d.label)}</span>
      <span class="hb-track"><i style="width:${(d.value / max * 100).toFixed(1)}%"></i></span>
      <b>${esc(fmt(d.value))}</b>${d.extra ? `<small class="muted">${esc(d.extra)}</small>` : ''}</span>`)}
    </li>`).join('')}</ul>`;
}

// Donut: [{ label, value, href? }]
export function donut(data, { size = 132, unit = 'jackets' } = {}) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const r = 15.9155, c = 2 * Math.PI * r;
  let offset = 0;
  const segs = data.map((d, i) => {
    const len = d.value / total * c;
    const tipText = `${d.label}\n${d.value} ${unit} · ${Math.round(d.value / total * 100)}%`;
    const s = `<circle r="${r}" cx="21" cy="21" fill="none" class="seg seg-${i % 6}" stroke-width="5.5" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" data-tip="${esc(tipText)}" ${d.href ? `data-href="${esc(d.href)}"` : ''} tabindex="0"/>`;
    offset += len;
    return s;
  }).join('');
  return `<div class="donut-wrap">
    <svg viewBox="0 0 42 42" width="${size}" height="${size}" class="donut" role="img" aria-label="${esc(data.map(d => `${d.label} ${d.value}`).join(', '))}">
      <circle r="${r}" cx="21" cy="21" fill="none" class="seg-bg" stroke-width="5.5"/>
      <g transform="rotate(-90 21 21)">${segs}</g>
      <text x="21" y="22.5" text-anchor="middle" class="donut-total">${data.reduce((s, d) => s + d.value, 0)}</text>
    </svg>
    <ul class="legend">${data.map((d, i) => `<li>${link(d.href, `<span class="lg-row" data-tip="${esc(`${d.label}\n${d.value} ${unit} · ${Math.round(d.value / total * 100)}%`)}" tabindex="0"><i class="seg-dot seg-${i % 6}"></i>${esc(d.label)} <b>${d.value}</b></span>`)}</li>`).join('')}</ul>
  </div>`;
}

// Tiny price line: [{ at, price }]
export function sparkline(points, { width = 220, height = 46 } = {}) {
  if (!points || points.length < 2) return '';
  const ys = points.map(p => p.price), min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
  const xy = points.map((p, i) => [i / (points.length - 1) * (width - 6) + 3, height - 5 - (p.price - min) / span * (height - 10)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy[xy.length - 1];
  const day = at => new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" class="spark" role="img" aria-label="Price history">
    <path d="${d}" class="spark-line" vector-effect="non-scaling-stroke"/><circle cx="${lx}" cy="${ly}" r="3" class="spark-dot"/>
    ${xy.map(([x], i) => `<rect x="${i ? (xy[i - 1][0] + x) / 2 : 0}" y="0" width="${(i < xy.length - 1 ? (xy[i + 1][0] + x) / 2 : width) - (i ? (xy[i - 1][0] + x) / 2 : 0)}" height="${height}" class="spark-hit" data-tip="${esc(`${day(points[i].at)}\n$${points[i].price}`)}"/>`).join('')}</svg>`;
}
