// Operations: scheduled hunts, daily + weekly summaries, automatic backups (with restore), health panel, hunt alerts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

module.exports = function ops(ctx) {
  const { send, readBody, str, num } = ctx;
  const db = () => ctx.db;
  const s = () => db().settings;
  s().timezone ||= 'Asia/Karachi';
  const useZone = () => { try { new Intl.DateTimeFormat('en', { timeZone: s().timezone }); if (process.env.TZ !== s().timezone) process.env.TZ = s().timezone; } catch {} };
  useZone();
  setInterval(useZone, 60e3).unref();
  s().schedules ||= [];
  s().dailySummary ||= { on: true, time: '09:00' };
  s().backup ||= { on: true, time: '03:00', keep: 7 };
  db().opsState ||= {};
  const BACKUP_DIR = path.join(ctx.DATA_DIR, 'backups');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // ---------- local clock in your time zone ----------
  function now() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: s().timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false })
      .formatToParts(new Date()).map(p => [p.type, p.value]));
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`, dow };
  }
  const doneToday = (key, t) => db().opsState[key] === t.date;
  const markDone = (key, t) => { db().opsState[key] = t.date; ctx.save(); };
  // "is it time?": from the set time until 10 minutes later, so a busy minute or a restart doesn't skip the day
  const due = (hhmm, t) => { const m = x => { const [h, mi] = String(x || '').split(':').map(Number); return h * 60 + mi; }; const d = m(t.time) - m(hhmm); return d >= 0 && d < 10; };

  // ---------- backups ----------
  function listBackups() {
    return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.tar.gz')).sort().reverse()
      .map(f => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: st.size, at: st.mtime.toISOString() }; });
  }
  // Everything that belongs together goes in one archive: the db and its sidecar files (fingerprints) must match.
  const BACKUP_FILES = ['db.json', 'embeddings.json', 'photohash.json', 'media'];
  function makeBackup(label = 'auto') {
    return new Promise((resolve, reject) => {
      const name = `backup-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}-${label}.tar.gz`;
      ctx.exportJson();
      const files = BACKUP_FILES.filter(f => fs.existsSync(path.join(ctx.DATA_DIR, f))); // db.json in the archive = a full copy of the database
      execFile('tar', ['czf', path.join(BACKUP_DIR, name), '-C', ctx.DATA_DIR, ...files], { timeout: 10 * 60000 }, err => {
        if (err) { fs.rmSync(path.join(BACKUP_DIR, name), { force: true }); return reject(err); }
        const keep = Math.max(2, num(s().backup.keep) || 7);
        // prune each kind separately so manual / before-restore backups don't pile up forever either
        for (const kind of ['-auto', '-manual', '-before-restore']) listBackups().filter(b => b.name.includes(kind)).slice(kind === '-auto' ? keep : 5).forEach(b => fs.rmSync(path.join(BACKUP_DIR, b.name), { force: true }));
        db().opsState.lastBackup = { name, at: new Date().toISOString() };
        ctx.save();
        resolve(name);
      });
    });
  }
  const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 10 * 60000, maxBuffer: 64e6 }, (err, out) => err ? reject(err) : resolve(out)));
  async function restore(name) {
    const file = path.join(BACKUP_DIR, path.basename(name));
    if (!fs.existsSync(file)) throw new Error('Backup not found');
    // check the archive is readable before touching anything
    const inside = new Set(String(await run('tar', ['tzf', file])).split('\n').map(l => l.replace(/^\.\//, '').split('/')[0]).filter(Boolean));
    if (!inside.has('db.json')) throw new Error('This backup has no db.json');
    ctx.freeze(); // stop all writes (db + fingerprint files), the extracted copy wins
    try {
      await run('tar', ['xzf', file, '-C', ctx.DATA_DIR]);
      // sidecar files the backup didn't have belong to the newer data: remove them so they get rebuilt for the restored jackets
      for (const side of ['embeddings.json', 'photohash.json']) if (!inside.has(side)) fs.rmSync(path.join(ctx.DATA_DIR, side), { force: true });
      if (ctx.USE_PG) fs.writeFileSync(path.join(ctx.DATA_DIR, 'restore-pending'), new Date().toISOString()); // on restart the restored db.json replaces what is in Postgres
    } catch (e) { ctx.unfreeze(); throw e; } // keep saving if the restore failed
  }

  // ---------- summaries ----------
  function topNew(n = 5) {
    const since = Date.now() - 36 * 3600 * 1000;
    return db().products.filter(p => p.status === 'new' && Date.parse(p.createdAt) >= since).sort((a, b) => b.score - a.score).slice(0, n);
  }
  function dailyText() {
    const ps = db().products, waiting = ps.filter(p => p.status === 'new').length;
    const top = topNew();
    const yesterday = Date.now() - 864e5;
    const approved = ps.filter(p => p.status === 'approved' && Date.parse(p.decidedAt || p.updatedAt) >= yesterday).length;
    const topics = Object.values(db().trends?.markets || {}).flatMap(m => (m?.rising || []).map(r => r.query)).slice(0, 5);
    const r = db().runs.at(-1);
    return [`☀️ Morrow Studio — good morning`,
      `${waiting} jackets waiting for review · ${approved} approved in the last 24h`,
      top.length ? `\nTop new jackets:\n${top.map((p, i) => `${i + 1}. ${p.title.slice(0, 60)} — ${p.price ?? '?'} ${p.currency} (score ${p.score})`).join('\n')}` : '',
      topics.length ? `\nRising searches: ${topics.join(', ')}` : '',
      r ? `\nLast hunt: ${r.status}${r.found ? ` · ${r.found} new` : ''}` : ''
    ].filter(Boolean).join('\n');
  }

  // ---------- the clock: runs every 30s ----------
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    // each job is guarded on its own: one failing job never stops the others, and nothing here can crash the server
    const job = async (name, fn) => { try { await fn(); } catch (e) { console.error(`Scheduler job "${name}" failed:`, e && e.message || e); } };
    try {
      let t;
      try { t = now(); } catch { s().timezone = 'Asia/Karachi'; t = now(); } // an invalid saved time zone falls back instead of breaking every tick
      for (const sc of s().schedules) {
        const key = 'schedule-' + sc.id;
        if (!sc.on || !due(sc.time, t) || doneToday(key, t) || !(sc.days || [0, 1, 2, 3, 4, 5, 6]).includes(t.dow)) continue;
        await job('schedule ' + sc.time, async () => {
          const r = await ctx.startRun(sc.mode === 'trend' ? 'trend' : 'normal', null, `Scheduled (${sc.time})`);
          if (r.status === 'failed' && r.code === 409) return; // another hunt is still running: try again next tick (within the 10 min window)
          markDone(key, t);
          if (r.status === 'failed') ctx.notify('owners', 'hunts', `⏰ Scheduled hunt could not start: ${r.error}`, '#/hunts');
        });
      }
      if (s().dailySummary.on && due(s().dailySummary.time, t) && !doneToday('daily', t)) await job('daily summary', () => { ctx.notify('all', 'daily', dailyText(), '#/'); markDone('daily', t); });
      if (t.dow === 1 && due(s().dailySummary.time || '09:00', t) && !doneToday('weekly', t)) await job('weekly report', () => { ctx.notify('all', 'daily', '📊 Your weekly Morrow Studio report is ready', '#/report'); markDone('weekly', t); });
      if (s().backup.on && due(s().backup.time, t) && !doneToday('backup', t)) {
        markDone('backup', t); // backups can take minutes: mark first and run in the background so the clock keeps ticking
        makeBackup('auto').catch(e => ctx.notify('owners', 'hunts', `⚠️ Nightly backup failed: ${e.message}`, '#/settings'));
      }
    } catch (e) { console.error('Scheduler tick failed:', e && e.message || e); }
    finally { ticking = false; }
  }
  setInterval(tick, 30000);

  // ---------- hunt alerts ----------
  function onRunEnd(run) {
    if (run.alerted) return;
    run.alerted = true;
    if (run.status === 'finished') ctx.notify('all', 'hunts', `✅ ${run.mode === 'trend' ? "Trend hunt" : 'Hunt'} finished — ${run.found || 0} new jackets`, '#/jackets?status=new');
    if (run.status === 'failed') ctx.notify('owners', 'hunts', `❌ Hunt failed — ${String(run.error || '').slice(0, 200)}`, '#/hunts');
  }

  // ---------- health ----------
  async function health() {
    const out = [];
    const add = (name, ok, detail, area = 'Services') => out.push({ name, ok, detail, area });
    // n8n
    try {
      const origin = new URL(s().n8nWebhookUrl).origin;
      const r = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(5000) });
      add('n8n', r.ok, r.ok ? 'Running' : `Answered ${r.status}`);
    } catch (e) { add('n8n', false, 'Not reachable - is n8n running?'); }
    // last results per source from the most recent finished hunts
    const recent = db().runs.slice(-6).reverse();
    const lastStep = re => { for (const r of recent) { const st = (r.steps || []).find(x => re.test(x.name)); if (st) return { ...st, when: r.startedAt }; } return null; };
    for (const [name, re, need] of [['eBay', /^eBay$/, 'ebay'], ['Etsy', /^Etsy$/, 'etsy'], ['Google Trends', /^Google Trends$/], ['Google Shopping (Serper)', /^Google Shopping$/]]) {
      if (need && !s().sources.includes(need)) { add(name, null, 'Turned off in Settings', 'Sources'); continue; }
      const st = lastStep(re);
      add(name, st ? st.status !== 'error' : null, st ? `${st.status === 'error' ? 'Problem' : 'OK'} · ${st.detail || ''}`.slice(0, 160) : 'No report yet (re-import the workflow to get reports)', 'Sources');
    }
    for (const site of s().websites) {
      const host = site.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const st = lastStep(new RegExp('Website · (www\\.)?' + host.replace(/^www\./, '').replace(/\./g, '\\.')));
      add(host, st ? st.status !== 'error' : null, st ? (st.detail || st.status).slice(0, 160) : 'No report yet', 'Websites');
    }
    // Serper credits (free 2,500 at signup; about 5 per trend hunt)
    const used = num(s().serperSearches) || 0;
    add('Serper searches', s().serperKey ? 2500 - used > 100 : null, s().serperKey ? `≈ ${Math.max(0, 2500 - used)} of 2,500 free searches left (estimate)` : 'No key yet - add it for Today\'s trend hunt', 'Services');
    // jacket check / CLIP
    add('Jacket check (CLIP)', !ctx.vision.lastError, ctx.vision.lastError ? ctx.vision.lastError : `${ctx.vision.checked} checks since start · ${ctx.vision.productsDeleted} removed`, 'Server');
    // backups
    const b = listBackups()[0];
    add('Backups', b ? Date.now() - Date.parse(b.at) < 2 * 864e5 : false, b ? `Last ${new Date(b.at).toLocaleString('en-GB', { timeZone: s().timezone })} · ${(b.size / 1e6).toFixed(1)} MB · ${listBackups().length} kept` : 'No backup yet', 'Server');
    // disk + memory
    try { const st = fs.statfsSync(ctx.DATA_DIR); const free = st.bavail * st.bsize / 1e9; add('Disk space', free > 3, `${free.toFixed(1)} GB free`, 'Server'); } catch {}
    const rss = process.memoryUsage().rss / 1e6;
    add('Memory', rss < 1200, `${rss.toFixed(0)} MB used of 1,500 MB`, 'Server');
    add('Watcher', !ctx.watch.status.errors || ctx.watch.status.checked > ctx.watch.status.errors, ctx.watch.status.lastRunAt ? `Last check ${new Date(ctx.watch.status.lastRunAt).toLocaleString('en-GB', { timeZone: s().timezone })} · ${ctx.watch.status.checked} checked` : 'Starts within 10 minutes of a restart', 'Server');
    add('HTTPS', String(ctx.PUBLIC_URL).startsWith('https'), ctx.PUBLIC_URL || 'No public address set', 'Server');
    return out;
  }

  async function handle(req, res, url, parts, me) {
    const method = req.method;
    if (parts[1] === 'health' && method === 'GET') return send(res, 200, { checks: await health(), time: now(), timezone: s().timezone }), true;
    if (parts[1] === 'summary' && parts[2] === 'test' && method === 'POST') {
      ctx.notify([me.id], 'daily', dailyText(), '#/');
      return send(res, 200, { ok: true, text: dailyText() }), true;
    }
    if (parts[1] === 'backups') {
      if (!ctx.can(me, 'backups.manage')) return send(res, 403, { error: "You don't have permission to manage backups" }), true;
      if (method === 'GET' && !parts[2]) return send(res, 200, { backups: listBackups() }), true;
      if (method === 'POST' && !parts[2]) {
        try { const name = await makeBackup('manual'); ctx.log(me, 'made a backup', name); return send(res, 200, { name, backups: listBackups() }), true; }
        catch (e) { return send(res, 500, { error: 'Backup failed: ' + e.message }), true; }
      }
      const name = path.basename(parts[2] || '');
      if (method === 'GET' && name) {
        const f = path.join(BACKUP_DIR, name);
        if (!fs.existsSync(f)) return send(res, 404, { error: 'Not found' }), true;
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': fs.statSync(f).size });
        fs.createReadStream(f).pipe(res);
        return true;
      }
      if (method === 'POST' && parts[3] === 'restore') {
        if (db().runs.some(r => r.status === 'started')) return send(res, 409, { error: 'A hunt is running. Stop it or wait until it finishes, then restore.' }), true;
        try {
          await makeBackup('before-restore');
          await restore(name);
          ctx.log(me, 'restored a backup', name);
          send(res, 200, { ok: true, restarting: true });
          setTimeout(() => process.exit(0), 500); // Docker restarts the dashboard with the restored data
        } catch (e) { send(res, 500, { error: 'Restore failed (nothing was changed): ' + e.message }); }
        return true;
      }
      if (method === 'DELETE' && name) { fs.rmSync(path.join(BACKUP_DIR, name), { force: true }); return send(res, 200, { backups: listBackups() }), true; }
    }
    return false;
  }

  return { handle, onRunEnd, health, makeBackup, dailyText, now };
};
