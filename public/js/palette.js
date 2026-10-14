// Command palette (Ctrl+K), plain-English search ("women's black suede biker under $250 best sellers") and photo search.
import { api, esc, icon, money, toast, openModal, closeModal, debounce, sourceLabel, setTheme, getTheme, $ } from './core.js';
import { has } from './session.js';

// ---------- plain-English search → filters (free, runs in the browser) ----------
const COLORS = { black: 'black', brown: 'brown', chocolate: 'brown', coffee: 'brown', tan: 'tan', camel: 'tan', cognac: 'cognac', whiskey: 'cognac', caramel: 'cognac', burgundy: 'burgundy', maroon: 'burgundy', oxblood: 'burgundy', wine: 'burgundy', red: 'red', white: 'white', cream: 'white', green: 'green', olive: 'green', blue: 'blue', navy: 'blue', grey: 'grey', gray: 'grey', beige: 'beige' };
const STYLES = { biker: 'biker', moto: 'biker', motorcycle: 'biker', bomber: 'bomber', flight: 'bomber', trucker: 'trucker', 'cafe racer': 'cafe racer', racer: 'cafe racer', aviator: 'aviator shearling', blazer: 'blazer style', puffer: 'puffer' };
const LEATHERS = { suede: 'Suede', shearling: 'Shearling', sheepskin: 'Shearling', lambskin: 'Lambskin', cowhide: 'Cowhide', goatskin: 'Goatskin', nappa: 'Nappa', faux: 'Faux', vegan: 'Faux' };
const SOURCES = { ebay: 'ebay', etsy: 'etsy', 'google shopping': 'google_shopping', google: 'google_shopping', website: 'website', websites: 'website' };
const SORTS = [[/\b(cheapest|lowest price|low to high)\b/, 'price_asc', 'Cheapest first'], [/\b(most expensive|high to low|priciest)\b/, 'price_desc', 'Most expensive first'], [/\b(newest|latest|most recent)\b/, 'newest', 'Newest first'],
  [/\b(most profitable|best profit|highest profit|profit)\b/, 'profit', 'Most profit first'], [/\b(my taste|best match|match)\b/, 'match', 'Best match to your taste'], [/\b(selling fast|fastest|hot|trending)\b/, 'velocity', 'Selling fastest']];
const STOP = new Set('show me find get all the a an with and in of for only jacket jackets leather coats coat please items products i want some that are is under over between to'.split(' '));

export function parseQuery(text) {
  let t = ' ' + String(text).toLowerCase().replace(/[’']s\b/g, 's').replace(/[^a-z0-9$.\- ]+/g, ' ') + ' ';
  const q = {}, chips = [];
  const take = re => { const m = t.match(re); if (m) t = t.replace(m[0], ' '); return m; };
  let m;
  if ((m = take(/\bbetween \$?(\d+) (?:and|to|-) ?\$?(\d+)\b/)) || (m = take(/\$(\d+) ?(?:-|to) ?\$?(\d+)\b/))) { q.min = m[1]; q.max = m[2]; chips.push(`$${m[1]}–$${m[2]}`); }
  if ((m = take(/\b(?:under|below|less than|max|up to|cheaper than|<) ?\$?(\d+)\b/))) { q.max = m[1]; chips.push(`Under $${m[1]}`); }
  if ((m = take(/\b(?:over|above|more than|min|at least|>) ?\$?(\d+)\b/))) { q.min = m[1]; chips.push(`Over $${m[1]}`); }
  if (take(/\b(womens|women|ladies|female|woman)\b/)) { q.gender = 'Women'; chips.push('Women'); }
  else if (take(/\b(mens|men|male|man)\b/)) { q.gender = 'Men'; chips.push('Men'); }
  if (take(/\bbest ?sellers?\b/)) { q.bestseller = '1'; chips.push('Best sellers'); }
  if (take(/\b(found today|today|new today)\b/)) { q.today = '1'; chips.push('Found today'); }
  if (take(/\bapproved\b/)) { q.status = 'approved'; chips.push('Approved'); }
  else if (take(/\brejected\b/)) { q.status = 'rejected'; chips.push('Rejected'); }
  else if (take(/\b(unreviewed|waiting|to review)\b/)) { q.status = 'new'; chips.push('Waiting for review'); }
  for (const [re, sort, label] of SORTS) if (take(re)) { q.sort = sort; chips.push(label); break; }
  const pick = (dict, key, fmt) => { const found = []; for (const k of Object.keys(dict).sort((a, b) => b.length - a.length)) if (take(new RegExp(`\\b${k}\\b`))) { if (!found.includes(dict[k])) found.push(dict[k]); } if (found.length) { q[key] = found.join(key === 'topic' ? '|' : ','); chips.push(...found.map(fmt)); } };
  pick(SOURCES, 'source', v => ({ ebay: 'eBay', etsy: 'Etsy', google_shopping: 'Google Shopping', website: 'Websites' }[v]));
  pick(LEATHERS, 'leather', v => v);
  pick(STYLES, 'style', v => v.replace(/\b\w/g, c => c.toUpperCase()));
  pick(COLORS, 'color', v => v[0].toUpperCase() + v.slice(1));
  const rest = t.split(/\s+/).filter(w => w && !STOP.has(w) && !/^\$?\d+$/.test(w));
  if (rest.length) { q.q = rest.join(' '); chips.push(`“${q.q}”`); }
  if (!q.status) q.status = 'all';
  return { query: q, chips, understood: chips.length > (q.q ? 1 : 0) };
}

// ---------- palette ----------
let items = [], sel = 0;
export function openPalette(prefill = '') {
  const m = openModal(`
    <div class="palette">
      <label class="pal-input">${icon('search', 19)}<input id="palQ" placeholder="Search jackets in plain English, or type a command…" autocomplete="off" value="${esc(prefill)}" autofocus><kbd>Esc</kbd></label>
      <div class="pal-list" id="palList" role="listbox"></div>
      <div class="pal-foot muted small"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span>Try: “black biker under 200 best sellers”</span></div>
    </div>`, { wide: true, label: 'Command palette' });
  m.classList.add('pal-modal');
  const input = m.querySelector('#palQ');
  const go = () => { const it = items[sel]; if (!it) return; closeModal(); it.run(); };
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); paint(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); paint(); e.preventDefault(); }
    if (e.key === 'Enter') { go(); e.preventDefault(); }
  });
  const jacketSearch = debounce(async text => {
    if (text.length < 2) return;
    try {
      const { items: found } = await api('/products?' + new URLSearchParams({ status: 'all', q: text, size: 6 }));
      if (input.value.trim() !== text) return;
      build(text, found);
    } catch {}
  }, 220);
  input.addEventListener('input', () => { build(input.value.trim(), []); jacketSearch(input.value.trim()); });
  m.querySelector('#palList').addEventListener('click', e => { const li = e.target.closest('[data-i]'); if (li) { sel = Number(li.dataset.i); go(); } });
  build(prefill, []);
  if (prefill) jacketSearch(prefill);
}

const COMMANDS = [
  ['Go to Overview', 'home', '#/'], ['Go to Jackets', 'grid', '#/jackets'], ['Start Review mode', 'cards', '#/review'], ['Go to Boards', 'board', '#/boards'],
  ['Go to Insights', 'chart', '#/insights'], ['Weekly report', 'file', '#/report'], ['Go to Hunts', 'radar', '#/hunts'], ['Health & status', 'activity', '#/health'], ['Settings', 'settings', '#/settings'],
  ...(has('hunts.run') ? [['Run hunt', 'radar', () => window.dispatchEvent(new CustomEvent('lh:hunt', { detail: 'normal' }))],
  ["Run today's trend hunt", 'trend', () => window.dispatchEvent(new CustomEvent('lh:hunt', { detail: 'trend' }))]] : []),
  ['Search by photo', 'camera', () => photoSearch()],
  ['New board', 'plus', () => { location.hash = '#/boards?new=1'; }],
  ['Approved jackets', 'check', '#/jackets?status=approved'], ['Most profitable jackets', 'dollar', '#/jackets?status=all&sort=profit'],
  ['Best match to my taste', 'heart', '#/jackets?status=new&sort=match'], ['Jackets with duplicates merged', 'merge', '#/jackets?status=all&merge=1'],
  ['Switch theme (light / dark / system)', 'moon', () => { const o = ['auto', 'light', 'dark']; const n = o[(o.indexOf(getTheme()) + 1) % 3]; setTheme(n); toast('Theme: ' + n); }],
  ['Keyboard shortcuts', 'keyboard', () => window.dispatchEvent(new CustomEvent('lh:keys'))]
];

function build(text, found) {
  const t = text.toLowerCase();
  items = [];
  if (text) {
    const p = parseQuery(text);
    items.push({ group: 'Search', icon: 'search', label: p.understood ? 'Show jackets: ' + p.chips.join(' · ') : `Search jackets for “${text}”`, run: () => { location.hash = '#/jackets?' + new URLSearchParams(p.understood ? p.query : { status: 'all', q: text }); } });
  }
  for (const [label, ic, target] of COMMANDS) {
    if (t && !label.toLowerCase().includes(t) && !t.split(' ').every(w => label.toLowerCase().includes(w))) continue;
    items.push({ group: 'Go to / do', icon: ic, label, run: typeof target === 'function' ? target : () => { location.hash = target; } });
  }
  for (const p of found) items.push({ group: 'Jackets', thumb: p.thumb || p.mainImage, label: p.title, sub: `${money(p.price, p.currency)} · ${sourceLabel(p)} · ${p.status}`, run: () => { location.hash = '#/product/' + p.id; } });
  sel = 0;
  paint();
}
function paint() {
  const list = $('#palList');
  if (!list) return;
  let group = '';
  list.innerHTML = items.map((it, i) => {
    const head = it.group !== group ? `<div class="pal-group">${esc(group = it.group)}</div>` : '';
    return `${head}<div class="pal-item ${i === sel ? 'on' : ''}" data-i="${i}" role="option" aria-selected="${i === sel}">
      ${it.thumb ? `<img src="${esc(it.thumb)}" alt="" referrerpolicy="no-referrer">` : `<span class="pal-ic">${icon(it.icon, 17)}</span>`}
      <span class="pal-text"><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>${i === sel ? '<kbd>Enter</kbd>' : ''}</div>`;
  }).join('') || '<div class="pal-empty muted">Nothing matches</div>';
  list.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' });
}

// ---------- photo search ----------
export function photoSearch() {
  const m = openModal(`
    <div class="row-between"><h2 class="modal-title">Search by photo</h2><button class="icon-btn" data-x aria-label="Close">${icon('x')}</button></div>
    <p class="muted">Drop a photo (a celebrity look, a supplier sample, a screenshot) and see your most similar jackets.</p>
    <label class="drop" id="drop" tabindex="0">${icon('camera', 28)}<b>Drop, paste or choose a photo</b><small>JPG, PNG or WebP</small><input type="file" accept="image/*" id="pf" hidden></label>
    <div class="row2"><input id="purl" placeholder="…or paste a photo link (https://…)"><button class="btn gold" id="pgo">Search</button></div>
    <div id="pres" class="photo-results"></div>`, { wide: true, label: 'Search by photo' });
  m.querySelector('[data-x]').onclick = closeModal;
  const drop = m.querySelector('#drop'), file = m.querySelector('#pf'), res = m.querySelector('#pres');
  const run = async body => {
    res.innerHTML = '<p class="muted"><i class="spinner"></i> Comparing with your jackets…</p>';
    try {
      const r = await api('/search/photo', { method: 'POST', body });
      res.innerHTML = r.items.length ? `<p class="muted small">Compared with ${r.indexed} of ${r.total} jackets (the rest are still being indexed).</p><div class="pr-grid">${r.items.map(p => `
        <a href="#/product/${p.id}" class="pr-item" data-close><img src="${esc(p.thumb || p.mainImage)}" alt="" referrerpolicy="no-referrer"><span><b>${p.similarity}% similar</b><small>${esc(p.title)}</small><small>${money(p.price, p.currency)}</small></span></a>`).join('')}</div>` : '<p class="muted">No indexed jackets yet — they are indexed a few seconds after each hunt.</p>';
      res.querySelectorAll('[data-close]').forEach(a => a.addEventListener('click', () => closeModal()));
    } catch (e) { res.innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
  };
  const readFile = f => { if (!f || !/^image\//.test(f.type)) return toast('That is not an image'); if (f.size > 12e6) return toast('Photo is too large (max 12 MB)'); const r = new FileReader(); r.onload = () => run({ image: r.result }); r.readAsDataURL(f); };
  drop.onclick = () => file.click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') file.click(); };
  file.onchange = () => readFile(file.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); readFile(e.dataTransfer.files[0]); };
  m.addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])][0]; if (f) readFile(f); });
  m.querySelector('#pgo').onclick = () => { const u = m.querySelector('#purl').value.trim(); if (/^https?:\/\//.test(u)) run({ url: u }); else toast('Paste a link that starts with https://'); };
}
