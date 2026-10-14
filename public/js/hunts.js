// Hunts: start a hunt, watch it live step by step, and see every past hunt with plain-word errors.
import { api, esc, icon, toast, when, ago, duration, plural, confirmDialog, $, $$ } from './core.js';

let timer = null, runs = [];

const MODE = { trend: "Today's trend hunt", normal: 'Hunt' };
const STATUS = { started: 'Running', finished: 'Finished', failed: 'Failed', stalled: 'No answer', stopped: 'Stopped' };

// Turn raw errors from n8n / sites into sentences
export function plainError(text = '') {
  const t = String(text);
  const site = (t.match(/https?:\/\/(?:www\.)?([^/\s:]+)/) || [])[1] || 'The site';
  const rules = [
    [/captcha|sgcaptcha/i, `${site} showed a bot check (CAPTCHA). Ask the site owner to allow your server's IP.`],
    [/403|forbidden|firewall/i, `${site} blocked the server (403). Ask the site owner to allow your server's IP.`],
    [/No products, product feed or sitemap found/i, `No products were found on ${site} - the shop layout may not be supported yet.`],
    [/serper.*(unauthor|invalid)|unauthorized\./i, 'Your Serper key was refused - check it in Settings.'],
    [/needs a Serper key/i, "Add your Serper key in Settings to use Today's trend hunt."],
    [/429|rate limit/i, 'Google is rate limiting right now - the hunt carries on without that part. Try again later.'],
    [/timeout|timed out/i, `${site} took too long to answer.`],
    [/eBay OAuth token missing|ebay.*credential/i, 'eBay login failed - check the eBay credential in n8n.'],
    [/Could not reach n8n|ECONNREFUSED|fetch failed/i, 'The dashboard could not reach n8n - check n8n is running.'],
    [/no active Leather Hunt workflow|404/i, 'n8n has no active Leather Hunt workflow - import it and switch it on.'],
    [/No products to save/i, 'The hunt finished but found no new jackets that pass the filters.']
  ];
  for (const [re, msg] of rules) if (re.test(t)) return msg;
  return t.length > 220 ? t.slice(0, 220) + '…' : t;
}

export async function startHunt(mode = 'normal') {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  try {
    const run = await api('/hunt/run', { method: 'POST', body: { mode } });
    toast(mode === 'trend' ? "Today's trend hunt started" : 'Hunt started', { action: 'Watch live', onAction: () => { location.hash = '#/hunts'; } });
    window.dispatchEvent(new CustomEvent('lh:run', { detail: run }));
    return run;
  } catch (e) {
    toast(plainError(e.message), { kind: 'error', timeout: 8000 });
  }
}

// Stop a running hunt: the dashboard marks it stopped and ignores anything it still sends
export async function stopHunt(id) {
  if (!(await confirmDialog({ title: 'Stop this hunt?', body: 'The dashboard stops tracking it and ignores any jackets it still sends. To stop the work in n8n as well, stop the execution there.', confirm: 'Stop hunt', danger: true }))) return;
  try { const run = await api('/hunt/' + encodeURIComponent(id) + '/stop', { method: 'POST' }); huntUpdate(run); window.dispatchEvent(new CustomEvent('lh:run', { detail: run })); toast('Hunt stopped'); }
  catch (e) { toast(e.message, { kind: 'error' }); }
}

export async function renderHunts(app) {
  app.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">Hunts</p><h1>Find new jackets</h1><p class="lead-line">Pick a hunt. You can watch each step here while it works (about 5–15 minutes).</p></div></header>
    <section class="hunt-start">
      <button class="hunt-card" data-mode="normal">
        <span class="hc-icon">${icon('radar', 26)}</span>
        <span><b>Run hunt</b><small>eBay, Etsy and your websites · best new jackets</small></span>${icon('play', 18, 'hc-go')}
      </button>
      <button class="hunt-card trend" data-mode="trend">
        <span class="hc-icon">${icon('trend', 26)}</span>
        <span><b>Today's trend hunt</b><small>Top 5 Google Trends topics → Google Shopping · 10 jackets each</small></span>${icon('play', 18, 'hc-go')}
      </button>
    </section>
    <section id="live"></section>
    <section class="block"><h2 class="block-title">History</h2><div id="history" class="runs"><div class="skel-block"></div></div></section>`;
  api('/settings').then(s => { const el = $('.hunt-card[data-mode="normal"] small'); if (el && s.topN) el.textContent = `eBay, Etsy and your websites · best ${s.topN} new jackets`; }).catch(() => {});
  $$('.hunt-card').forEach(b => b.onclick = async () => { b.disabled = true; await startHunt(b.dataset.mode); b.disabled = false; load(); });
  await load();
}

async function load() {
  try { runs = (await api('/runs')).runs; } catch (e) { $('#history') && ($('#history').innerHTML = `<p class="muted">${esc(e.message)}</p>`); return; }
  paint();
}

function stepIcon(s) {
  if (s.status === 'done') return `<span class="st done">${icon('check', 14)}</span>`;
  if (s.status === 'error') return `<span class="st error">${icon('x', 14)}</span>`;
  if (s.status === 'skipped') return `<span class="st skipped">–</span>`;
  return '<span class="st running"><i class="spinner"></i></span>';
}
const steps = r => `<ol class="steps">${(r.steps || []).map(s => `<li class="${esc(s.status)}">${stepIcon(s)}<span><b>${esc(s.name)}</b>${s.detail ? `<small>${esc(s.status === 'error' ? plainError(s.detail) : s.detail)}</small>` : ''}</span>${s.count !== undefined ? `<em>${s.count}</em>` : ''}</li>`).join('')}</ol>`;

function runCard(r, open = false) {
  return `<article class="run ${r.status}" data-run="${esc(r.id)}">
    <div class="run-head">
      <span class="run-mode ${r.mode === 'trend' ? 'trend' : ''}">${icon(r.mode === 'trend' ? 'trend' : 'radar', 15)} ${MODE[r.mode] || 'Hunt'}</span>
      <span class="status-pill ${esc(r.status)}">${esc(STATUS[r.status] || r.status)}</span>
      <span class="muted small" title="${esc(when(r.startedAt))}">${ago(r.startedAt)}${r.finishedAt ? ' · took ' + duration(r.startedAt, r.finishedAt) : ''}</span>
      <span class="run-found"><b>${r.found || 0}</b> new</span>
    </div>
    ${r.error ? `<p class="run-error">${icon('alert', 15)} ${esc(plainError(r.error))}</p>` : ''}
    ${r.status === 'stalled' ? `<p class="run-error soft">${icon('clock', 15)} n8n stopped reporting. The workflow may have failed - open the execution in n8n to see why.</p>` : ''}
    <details ${open ? 'open' : ''}><summary>Steps (${(r.steps || []).length})</summary>${steps(r)}</details>
    <div class="run-actions">
      ${r.found ? `<a class="btn ghost sm" href="#/jackets?status=all&run=${encodeURIComponent(r.id)}">${icon('grid', 15)} View ${plural(r.found, 'jacket')}</a>` : ''}
      <button class="btn ghost sm" data-rerun="${r.mode || 'normal'}">${icon('refresh', 15)} Run again</button>
    </div>
  </article>`;
}

function liveCard(r) {
  return `<div class="live-card" data-live="${r.id}">
    <div class="live-head"><span class="pulse"></span><b>${MODE[r.mode] || 'Hunt'} running</b><span class="muted" id="elapsed">${duration(r.startedAt)}</span>
      <span class="live-found"><b>${r.found || 0}</b> new jackets so far</span>
      <button class="btn sm danger-text" data-stop="${esc(r.id)}" data-perm="hunts.run">${icon('x', 15)} Stop hunt</button></div>
    ${steps(r)}
    ${r.found ? `<a class="btn gold sm" href="#/jackets?status=new&run=${encodeURIComponent(r.id)}">See them now</a>` : ''}
  </div>`;
}

function paint() {
  const live = runs.find(r => r.status === 'started');
  const liveBox = $('#live'), hist = $('#history');
  if (!hist) return;
  liveBox.innerHTML = live ? liveCard(live) : '';
  clearInterval(timer);
  if (live) timer = setInterval(() => { const el = $('#elapsed'); if (el) el.textContent = duration(live.startedAt); else clearInterval(timer); }, 1000);
  const past = runs.filter(r => r !== live);
  hist.innerHTML = past.length ? past.map((r, i) => runCard(r, i === 0 && r.status === 'failed')).join('') : `<div class="empty small">${icon('radar', 30)}<p>No hunts yet - start one above.</p></div>`;
  $$('[data-rerun]').forEach(b => b.onclick = async () => { b.disabled = true; await startHunt(b.dataset.rerun); load(); });
  $$('[data-stop]').forEach(b => b.onclick = () => stopHunt(b.dataset.stop));
  $$('.hunt-card').forEach(b => { b.disabled = !!live; b.title = live ? 'A hunt is already running' : ''; });
}

// live update from the server
export function huntUpdate(run) {
  const i = runs.findIndex(r => r.id === run.id);
  if (i >= 0) runs[i] = run; else runs.unshift(run);
  if ($('#history')) paint();
}
