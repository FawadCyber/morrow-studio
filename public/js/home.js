// Overview: today's numbers, jackets found over time, what's coming up, the best jackets waiting, and a setup checklist.
import { api, esc, money, icon, ago, plural, cap, sourceLabel, store, $ , safeUrl } from './core.js';
import { lines } from './charts.js';
import { plainError, startHunt } from './hunts.js';
import { me, has } from './session.js';

// What still needs setting up, in plain words. Each step has one button.
async function setupSteps(s) {
  const [runs, users] = await Promise.all([api('/runs').catch(() => ({ runs: [] })), has('team.view') ? api('/users') : Promise.resolve({ users: [] })]);
  const reportsSteps = runs.runs.some(r => (r.steps || []).length > 1);
  const defaults = JSON.stringify({ Leather: 95, Lambskin: 120, Cowhide: 90, Goatskin: 100, Nappa: 130, Suede: 85, Shearling: 170, Faux: 35 });
  return [
    { done: reportsSteps, title: 'Update the n8n workflow', text: 'So hunts show live progress and finish properly.', how: 'In n8n: delete the old Leather Hunt workflow → import the new file → add eBay and Etsy logins → switch it on.', link: null },
    { done: s.serperKeySet, title: "Add your Serper key", text: "Needed for Today's trend hunt (Google Shopping). Free at serper.dev.", link: '#/settings/integrations', btn: 'Add key' },
    { done: JSON.stringify(s.profit?.costs) !== defaults, title: 'Enter your making costs', text: 'So every jacket shows your real profit.', link: '#/settings/profit', btn: 'Set costs' },
    { done: (s.schedules || []).some(x => x.on), title: 'Schedule a daily hunt', text: 'New jackets every morning without pressing anything.', link: '#/settings/automation', btn: 'Add schedule' },
    { done: 'Notification' in window && Notification.permission !== 'default', title: 'Turn on pop-up alerts', text: 'Get a pop-up when a hunt finishes or a price drops.', link: '#/settings/profile', btn: 'Turn on' },
    { done: users.users.length > 1, title: 'Invite your team (optional)', text: 'Give each person their own login.', link: '#/settings/team', btn: 'Add people' }
  ];
}

// Next times the scheduled hunts will run (today and tomorrow)
function upcoming(schedules = []) {
  const out = [], now = new Date();
  for (let add = 0; add < 2; add++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add);
    for (const x of schedules) {
      if (!x.on || !(x.days || []).includes(day.getDay())) continue;
      const [h, m] = String(x.time || '08:00').split(':').map(Number);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
      if (at > now) out.push({ at, mode: x.mode, add });
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 4);
}

const dayLabel = (d, add) => `${add ? 'Tomorrow' : 'Today'}, ${d.toLocaleDateString([], { month: 'long', day: 'numeric' })}`;
const clock = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function kpi({ href, label, value, sub, ic, up }) {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="kpi"${href ? ` href="${href}"` : ''}>
    <span class="kpi-main"><span class="kpi-label">${label}</span><b>${value}</b><small>${up ? `${icon('arrowUR', 13)} <em>${up}</em> ` : ''}${sub}</small></span>
    <span class="kpi-art"><i class="kpi-tile">${icon(ic, 22)}</i></span></${tag}>`;
}

function jacketCard(p) {
  const margin = p.profit?.margin;
  return `<article class="pcard">
    <a class="pcard-img" href="#/product/${p.id}"><img src="${esc(p.thumb || p.mainImage)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>
    <div class="pcard-top"><span class="pill">${esc(sourceLabel(p))}</span>${p.isBestseller ? '<span class="pill">Best seller</span>' : ''}</div>
    <a class="pcard-title" href="#/product/${p.id}">${esc(p.title)}</a>
    <p class="pcard-sub">${esc([cap(p.visionColor), cap(p.visionStyle)].filter(Boolean).join(' · ') || 'Leather jacket')}</p>
    <div class="pcard-meta"><span>• ${p.profit ? `+${money(p.profit.profit)} profit · ${margin}%` : 'Waiting for review'}</span><b>${money(p.price, p.currency)}</b></div>
    <span class="pcard-bar"><i style="width:${Math.max(4, Math.min(100, margin ?? p.score ?? 0))}%"></i></span>
    <div class="pcard-actions"><a class="btn block" href="#/product/${p.id}">Open jacket ${icon('arrowUR', 15)}</a>
      <a class="icon-btn" href="${esc(safeUrl(p.link))}" target="_blank" rel="noopener" aria-label="Open on the shop's site">${icon('external', 17)}</a></div>
  </article>`;
}

export async function renderHome(app) {
  app.innerHTML = `<div class="kpis">${'<div class="kpi skel"></div>'.repeat(4)}</div><div class="skel-block tall"></div>`;
  let d, s, best;
  try { [d, s, best] = await Promise.all([api('/insights'), api('/settings'), api('/products?status=new&sort=score&size=3').catch(() => ({ items: [], total: 0 }))]); }
  catch (e) { app.innerHTML = `<div class="empty">${icon('alert', 34)}<h2>Couldn't load the overview</h2><p>${esc(e.message)}</p></div>`; return; }
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const r = d.lastRun;
  const labels = d.perDay.map(x => new Date(x.day + 'T12:00').toLocaleDateString([], { day: 'numeric', month: 'short' }));
  const found30 = d.perDay.reduce((a, x) => a + x.found, 0), approved30 = d.perDay.reduce((a, x) => a + (x.approved || 0), 0);
  const runText = r ? r.status === 'started' ? 'Running now…' : r.status === 'failed' ? plainError(r.error) : r.status === 'stalled' ? 'No answer from n8n — open Hunts to see why' : `Found ${plural(r.found || 0, 'new jacket')}` : '';
  const next = upcoming(s.schedules);
  const healthy = !r || r.status === 'finished' || r.status === 'started';
  const from = new Date(Date.now() - 29 * 864e5), to = new Date();
  const range = `${from.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${to.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;

  app.innerHTML = `
  <header class="page-head home-head">
    <div><h1>${hello}, ${esc((me().name || '').split(' ')[0] || 'there')}.</h1>
      <p class="lead-line">${d.waiting ? `${plural(d.waiting, 'jacket')} waiting for a yes or no. Here's your studio at a glance.` : "Everything is reviewed. Here's your studio at a glance."}</p></div>
    <div class="head-actions">
      <span class="btn ghost static">${icon('calendar', 16)} ${range}</span>
      <button class="btn ghost" data-hunt="trend" data-perm="hunts.run">${icon('trend', 16)} Trend hunt</button>
      <button class="btn gold" data-hunt="normal" data-perm="hunts.run">${icon('plus', 16)} Run hunt</button>
    </div>
  </header>

  <section class="kpis">
    ${kpi({ href: '#/review', label: 'Waiting for review', value: String(d.waiting).padStart(2, '0'), sub: d.waiting ? 'Tap to start reviewing' : 'All caught up', ic: 'cards' })}
    ${kpi({ href: '#/jackets?status=all&today=1', label: 'Found today', value: String(d.newToday).padStart(2, '0'), sub: `${plural(found30, 'jacket')} in 30 days`, ic: 'radar' })}
    ${kpi({ href: '#/jackets?status=approved', label: 'Approved this week', value: String(d.approvedWeek).padStart(2, '0'), sub: `${d.approvedTotal} approved in total`, ic: 'check' })}
    ${kpi({ label: 'Average price', value: d.avgPrice ? money(d.avgPrice) : '—', sub: `across ${plural(d.total, 'jacket')}`, ic: 'dollar' })}
  </section>

  <section class="home-row">
    <div class="panel">
      <div class="panel-head"><div><h2>Jackets found</h2><p class="muted small">What your hunts brought in, day by day.</p></div>
        <div class="lc-legend"><span><i class="lg-solid"></i>Found</span><span><i class="lg-dash"></i>Approved</span><span class="chip sm">Last 30 days</span></div></div>
      <p class="big-line"><b>${found30}</b> jackets found ${approved30 ? `<span class="up">${icon('arrowUR', 13)} ${approved30} approved</span>` : ''}</p>
      ${lines(labels, d.perDay.map(x => x.found), d.perDay.map(x => x.approved || 0), { labelEvery: 6, names: ['found', 'approved'] })}
    </div>
    <div class="panel coming">
      <div class="panel-head"><h2>Coming up</h2><a class="link-btn" href="#/settings/automation" data-perm="settings.view">Schedules ${icon('arrowUR', 13)}</a></div>
      ${r ? `<p class="cu-day">Latest</p>
      <a class="cu-item" href="#/hunts" data-perm="hunts.view"><span class="cu-ic">${icon(r.mode === 'trend' ? 'trend' : 'radar', 17)}</span><span><b>${r.mode === 'trend' ? "Today's trend hunt" : 'Hunt'}</b><small>${esc(runText)}</small></span><em>${ago(r.startedAt)}</em></a>` : ''}
      ${d.waiting ? `<a class="cu-item" href="#/review" data-perm="jackets.review"><span class="cu-ic">${icon('cards', 17)}</span><span><b>Quick review</b><small>${plural(d.waiting, 'jacket')} waiting</small></span><em>Now</em></a>` : ''}
      ${next.length ? next.map((n, i) => `${i === 0 || next[i - 1].add !== n.add ? `<p class="cu-day">${dayLabel(n.at, n.add)}</p>` : ''}
        <div class="cu-item"><span class="cu-ic">${icon(n.mode === 'trend' ? 'trend' : 'clock', 17)}</span><span><b>${n.mode === 'trend' ? "Today's trend hunt" : 'Scheduled hunt'}</b><small>Starts by itself</small></span><em>${clock(n.at)}</em></div>`).join('')
        : `<p class="cu-day">Next</p><a class="cu-item" href="#/settings/automation" data-perm="settings.edit"><span class="cu-ic">${icon('clock', 17)}</span><span><b>No hunts scheduled</b><small>Add a daily hunt so jackets come in every morning</small></span><em>${icon('plus', 15)}</em></a>`}
      <div class="cu-foot"><span><i class="dot ${healthy ? 'ok' : 'bad'}"></i>${healthy ? 'Hunts are working' : 'Last hunt had a problem'}</span><a class="chip sm" href="#/health" data-perm="health.view">${healthy ? 'On track' : 'Check'}</a></div>
    </div>
  </section>

  <section class="panel block-panel" data-perm="jackets.view">
    <div class="panel-head"><div class="row-title"><h2>Best jackets waiting</h2><span class="chip sm">${best.total}</span></div><a class="link-btn" href="#/jackets">View all jackets ${icon('arrowUR', 13)}</a></div>
    ${best.items.length ? `<div class="pcards">${best.items.map(jacketCard).join('')}</div>` : `<div class="empty small">${icon('radar', 30)}<p>No jackets waiting. Run a hunt to find more.</p></div>`}
  </section>

  <section id="setup"></section>

  <a class="more-link" href="#/insights/breakdown" data-perm="insights.view">See all numbers — sources, prices, styles, colours ${icon('arrowUR', 14)}</a>`;
  app.querySelectorAll('[data-hunt]').forEach(b => b.onclick = async () => { b.disabled = true; await startHunt(b.dataset.hunt); b.disabled = false; });

  // setup checklist (owner only, hidden once done or dismissed)
  if (!has('settings.edit') || store.get('setup-hidden', false)) return;
  try {
    const steps = await setupSteps(s);
    const left = steps.filter(x => !x.done);
    if (!left.length) return;
    const box = $('#setup');
    if (!box) return;
    const doneN = steps.length - left.length;
    const open = store.get('setup-open', false);
    box.innerHTML = `<div class="setup">
      <div class="setup-head"><div><h2>Finish setting up</h2><p class="muted">${doneN} of ${steps.length} done · next: ${esc(left[0].title)}</p></div>
        <span class="setup-bar"><i style="width:${doneN / steps.length * 100}%"></i></span>
        <button class="btn sm" id="toggleSetup">${open ? 'Close' : 'Show steps'}</button><button class="link-btn" id="hideSetup">Hide</button></div>
      <ol class="setup-list" ${open ? '' : 'hidden'}>${steps.map((x, i) => `<li class="${x.done ? 'done' : ''}">
        <span class="setup-n">${x.done ? icon('check', 15) : i + 1}</span>
        <span class="setup-text"><b>${esc(x.title)}</b><small>${esc(x.done ? 'Done' : x.text)}</small>${!x.done && x.how ? `<small class="how">${esc(x.how)}</small>` : ''}</span>
        ${!x.done && x.link ? `<a class="btn sm" href="${x.link}">${esc(x.btn)}</a>` : ''}</li>`).join('')}</ol></div>`;
    $('#hideSetup').onclick = () => { store.set('setup-hidden', true); box.innerHTML = ''; };
    $('#toggleSetup').onclick = e => { const list = box.querySelector('.setup-list'); list.hidden = !list.hidden; store.set('setup-open', !list.hidden); e.target.textContent = list.hidden ? 'Show steps' : 'Close'; };
  } catch {}
}
