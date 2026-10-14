// Intelligence, all free and on the server:
//  - profit per jacket (your cost model)        - taste match (learns from approve / reject)
//  - photo search (CLIP fingerprints)           - duplicate merging (same jacket, different shops)
//  - sales velocity (sold / favourites over time)
const fs = require('fs');
const path = require('path');

const DEFAULT_PROFIT = {
  costs: { Leather: 95, Lambskin: 120, Cowhide: 90, Goatskin: 100, Nappa: 130, Suede: 85, Shearling: 170, Faux: 35 },
  shipping: 14, feesPct: 12, markupPct: 0,
  fx: { USD: 1, GBP: 1.27, CAD: 0.73, EUR: 1.08, AUD: 0.66 }
};

module.exports = function intel(ctx) {
  const { send, readBody, num, str } = ctx;
  const db = () => ctx.db;
  db().settings.profit = { ...DEFAULT_PROFIT, ...(db().settings.profit || {}), costs: { ...DEFAULT_PROFIT.costs, ...(db().settings.profit?.costs || {}) }, fx: { ...DEFAULT_PROFIT.fx, ...(db().settings.profit?.fx || {}) } };

  // ---------- embeddings store (separate file: big) ----------
  const EMB_FILE = path.join(ctx.DATA_DIR, 'embeddings.json');
  let emb = {};
  try { emb = JSON.parse(fs.readFileSync(EMB_FILE, 'utf8')); } catch {}
  // Side files are written atomically, never throw (disk full / locked file is logged), and stop during a restore.
  let frozen = false;
  const writeJson = (file, data) => {
    if (frozen) return;
    try { fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); }
    catch (e) { console.error(`Saving ${path.basename(file)} failed:`, e.code || e.message); }
  };
  let embTimer = null;
  const saveEmb = () => { clearTimeout(embTimer); embTimer = setTimeout(() => writeJson(EMB_FILE, emb), 2000); };
  ctx.onFreeze?.(() => { frozen = true; clearTimeout(embTimer); clearTimeout(phTimer); });
  const round = v => v.map(x => Math.round(x * 1e4) / 1e4);
  function storeEmbedding(id, v) { if (v && v.length) { emb[id] = round(v); saveEmb(); dupCache = null; } }
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const unit = v => { const n = Math.hypot(...v) || 1; return v.map(x => x / n); };

  // backfill: fingerprint jackets checked before this feature existed (one at a time, in the background)
  let backfilling = false;
  setInterval(async () => {
    if (backfilling) return;
    const p = db().products.find(x => !emb[x.id] && x.images.length);
    if (!p) return;
    backfilling = true;
    try {
      const img = p.images[0];
      const src = img.startsWith('/media/') ? path.join(ctx.MEDIA_DIR, path.basename(img)) : img;
      storeEmbedding(p.id, await ctx.jacketVision.embed(src));
    } catch { emb[p.id] = []; saveEmb(); } // unreadable photo: remembered (also after a restart) so it isn't retried forever
    finally { backfilling = false; }
  }, 3000);
  // Forget fingerprints of jackets that no longer exist (deleted, removed as duplicate, wiped)
  setInterval(() => {
    const ids = new Set(db().products.map(p => String(p.id)));
    let changedE = false, changedP = false;
    for (const k of Object.keys(emb)) if (!ids.has(k)) { delete emb[k]; changedE = true; }
    for (const k of Object.keys(ph)) if (!ids.has(k)) { delete ph[k]; changedP = true; }
    if (changedE) saveEmb();
    if (changedP) savePh();
  }, 10 * 60 * 1000);

  // ---------- profit ----------
  function profitOf(p) {
    const s = db().settings.profit;
    if (p.price === null || p.price === undefined) return null;
    const rate = s.fx[p.currency] ?? 1;
    const sell = p.price * rate * (1 + (s.markupPct || 0) / 100);
    const cost = num(p.costOverride) ?? s.costs[ctx.leatherType(p)] ?? s.costs.Leather;
    const net = sell * (1 - (s.feesPct || 0) / 100) - cost - (s.shipping || 0);
    return { sell: Math.round(sell), cost, profit: Math.round(net), margin: sell ? Math.round(net / sell * 100) : 0 };
  }

  // ---------- taste (Rocchio: closer to what you approved, further from what you rejected) ----------
  let taste = null, tasteKey = '';
  function tasteModel() {
    const ps = db().products;
    const key = ps.filter(p => p.status !== 'new').map(p => p.id + p.status[0]).join(',') + Object.keys(emb).length;
    if (key === tasteKey) return taste;
    tasteKey = key;
    const mean = list => { const vs = list.map(p => emb[p.id]).filter(v => v && v.length); if (vs.length < 3) return null; const m = new Array(vs[0].length).fill(0); for (const v of vs) for (let i = 0; i < v.length; i++) m[i] += v[i]; return unit(m); };
    const a = mean(ps.filter(p => p.status === 'approved')), r = mean(ps.filter(p => p.status === 'rejected'));
    taste = a && r ? { a, r, approved: ps.filter(p => p.status === 'approved').length, rejected: ps.filter(p => p.status === 'rejected').length } : null;
    return taste;
  }
  function matchOf(p) {
    const t = tasteModel(), v = emb[p.id];
    if (!t || !v || !v.length) return null;
    const s = dot(v, t.a) - dot(v, t.r); // roughly -0.15 .. 0.15
    return Math.max(1, Math.min(99, Math.round(50 + s * 350)));
  }

  // ---------- duplicates: the same jacket must never be in the list twice ----------
  // Proof needed, strongest first: the same picture (pixel fingerprint), the same photo file at the same shop / CDN id,
  // or the same name (at least 4 meaningful words). Look-alike AI scores are NOT used: black jackets all look alike to it.
  // Safety: only unreviewed ("new") jackets are ever removed automatically; a jacket you approved or rejected is never deleted.
  let dupCache = null, dupKey = '';
  const STOP = new Set('the a an and with for of in on by from leather jacket jackets genuine real size sizes new style sale buy shop women men mens womens'.split(' '));
  const GENDER = { men: 'm', mens: 'm', man: 'm', male: 'm', boys: 'k', boy: 'k', kids: 'k', kid: 'k', youth: 'k', girls: 'k', womens: 'f', women: 'f', woman: 'f', ladies: 'f', female: 'f' };
  const norm = t => String(t || '').toLowerCase().replace(/[’']s\b/g, 's').replace(/[^a-z0-9 ]+/g, ' ');
  const GENERIC = /^(s-l\d+|images?|image|photo|picture|default|main|large|medium|small|original|thumb|thumbnail|master|\d+)$/;
  // A key for each photo file: the CDN's own picture id when there is one, otherwise shop host + file name
  // (never a bare file name: two shops can both upload "img_1234.jpg").
  function photoKey(u) {
    let url; try { url = new URL(String(u || '')); } catch { return ''; }
    const tbn = url.search.match(/tbn:([\w-]{12,})/);
    if (tbn) return 'tbn:' + tbn[1];
    const ebay = url.pathname.match(/\/images\/g\/([^/]{6,})\//);
    if (ebay) return 'ebay:' + ebay[1];
    let name = url.pathname.split('/').pop().toLowerCase().replace(/\.(jpe?g|png|webp|gif|avif)$/, '');
    name = name.replace(/(_|-)(\d+x\d*|x\d+|zoom|large|grande|medium|small|thumb|thumbnail|master|compact|original)$/g, '');
    const host = url.host.replace(/^www\./, '');
    if (name.length < 8 || GENERIC.test(name)) return host + url.pathname.toLowerCase();
    return host + '/' + name;
  }
  // Per-product features, worked out once (not once per pair)
  const featCache = new Map();
  function feat(p) {
    const sig = p.title + '|' + (p.remoteImages || []).slice(0, 8).join(',');
    const hit = featCache.get(p.id);
    if (hit && hit.sig === sig) return hit;
    const t = norm(p.title);
    const g = new Set(t.split(/\s+/).map(w => GENDER[w]).filter(Boolean));
    const f = {
      sig,
      words: new Set(t.split(/\s+/).filter(w => w.length > 2 && !STOP.has(w) && !GENDER[w])),
      gender: g.size === 1 ? [...g][0] : null,
      photos: new Set((p.remoteImages || []).slice(0, 8).map(photoKey).filter(Boolean)),
      first: photoKey(p.remoteImages?.[0]),
      shop: p.source + ':' + (p.sourceDomain || '')
    };
    featCache.set(p.id, f);
    return f;
  }

  // ---------- photo fingerprints (pixels, not names): the same picture from any seller matches ----------
  // 256-bit difference hash of the first 3 photos, on a trimmed grey copy so size and white borders don't matter.
  // Tested on real jackets: the same photo from two sellers differs by 4 bits, different jackets by 58+.
  const PH_FILE = path.join(ctx.DATA_DIR, 'photohash.json');
  const SAME_PHOTO = 24;
  let ph = {};
  try { ph = JSON.parse(fs.readFileSync(PH_FILE, 'utf8')); } catch {}
  let phTimer = null;
  const savePh = () => { clearTimeout(phTimer); phTimer = setTimeout(() => writeJson(PH_FILE, ph), 1000); };
  async function hashImage(src) {
    let input = src;
    if (/^https?:\/\//i.test(src)) {
      const r = await fetch(src, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('photo ' + r.status);
      input = Buffer.from(await r.arrayBuffer());
    } else input = fs.readFileSync(src);
    // "no image" placeholders (eBay sends the same 1.3 KB picture for every missing photo) must never be fingerprinted
    if (input.length < 2000) throw new Error('too small to be a real photo');
    let img = ctx.sharp(input).flatten({ background: '#ffffff' });
    try { img = ctx.sharp(await img.trim({ threshold: 12 }).png().toBuffer()); } catch { img = ctx.sharp(input).flatten({ background: '#ffffff' }); }
    const data = await img.greyscale().resize(17, 16, { fit: 'fill' }).raw().toBuffer();
    const mean = data.reduce((s, v) => s + v, 0) / data.length;
    const sd = Math.sqrt(data.reduce((s, v) => s + (v - mean) ** 2, 0) / data.length);
    if (sd < 10) throw new Error('almost one flat colour (placeholder)');
    let hex = '';
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x += 4) {
      let n = 0;
      for (let k = 0; k < 4; k++) n = (n << 1) | (data[y * 17 + x + k] > data[y * 17 + x + k + 1] ? 1 : 0);
      hex += n.toString(16);
    }
    return hex;
  }
  const BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
  const ham = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) n += BITS[parseInt(a[i], 16) ^ parseInt(b[i], 16)]; return n; };
  let hashFailures = 0;
  async function hashProduct(p) {
    const out = [];
    for (let i = 0; i < Math.min(3, p.images.length); i++) {
      const img = p.images[i];
      const src = img.startsWith('/media/') ? path.join(ctx.MEDIA_DIR, path.basename(img)) : img;
      try { out.push(await hashImage(src)); } catch (e) { if (++hashFailures <= 3) console.error('Photo fingerprint failed:', e.message); }
    }
    ph[p.id] = out;
    savePh();
    dupCache = null;
    return out;
  }
  // Photos must be both fingerprinted; also guard against stale fingerprints for a reused id
  // A fingerprint that turns up on 3+ different jackets is a placeholder / shop logo, not a jacket photo: ignore it
  let commonKey = '', common = new Set();
  function commonHashes() {
    const key = Object.keys(ph).length + ':' + Object.values(ph).reduce((s, l) => s + l.length, 0);
    if (key === commonKey) return common;
    commonKey = key;
    const seen = new Map();
    for (const [id, list] of Object.entries(ph)) for (const h of new Set(list)) { const ids = seen.get(h) || seen.set(h, new Set()).get(h); ids.add(id); }
    common = new Set([...seen].filter(([, ids]) => ids.size >= 3).map(([h]) => h));
    return common;
  }
  const photoTwin = (a, b) => {
    const c = commonHashes();
    const ha = (ph[a.id] || []).filter(h => !c.has(h)), hb = (ph[b.id] || []).filter(h => !c.has(h));
    return ha.length > 0 && hb.length > 0 && ha.some(x => hb.some(y => ham(x, y) <= SAME_PHOTO));
  };

  function sameJacket(a, b) {
    if (a === b || a.id === b.id) return false;
    const fa = feat(a), fb = feat(b);
    if (fa.gender && fb.gender && fa.gender !== fb.gender) return false; // men's / women's / kids' versions are different jackets
    if (photoTwin(a, b)) return true;                                     // the same picture, whoever sells it and whatever they call it
    if (fa.first && fa.first === fb.first) return true;                   // the same photo file (same shop / same CDN picture)
    let sharedPhotos = 0; for (const k of fa.photos) if (fb.photos.has(k) && ++sharedPhotos >= 2) return true;
    // names: only long enough names count ("black biker" alone proves nothing)
    if (fa.words.size < 4 || fb.words.size < 4) return false;
    let shared = 0; for (const w of fa.words) if (fb.words.has(w)) shared++;
    const jac = shared / (fa.words.size + fb.words.size - shared);
    const sameShop = fa.shop === fb.shop;
    const samePrice = a.price !== null && a.price !== undefined && a.price === b.price;
    if (sameShop) return jac >= 0.8 && samePrice;                         // one shop: nearly the same name AND the same price
    return jac >= 0.8;                                                    // another shop: nearly the same name
  }
  // Is this incoming jacket already in the list?
  const findDuplicate = p => db().products.find(x => x.key !== p.key && sameJacket(p, x)) || null;

  // Groups are only used to SHOW "same jacket elsewhere"; nothing is deleted from a group.
  function groups() {
    const ps = db().products;
    const key = ps.length + ':' + ps.reduce((s, p) => s + p.id, 0) + ':' + Object.keys(ph).length;
    if (dupCache && key === dupKey) return dupCache;
    dupKey = key;
    dupCache = new Map();
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) if (sameJacket(ps[i], ps[j])) {
      (dupCache.get(ps[i].id) || dupCache.set(ps[i].id, [ps[i]]).get(ps[i].id)).push(ps[j]);
      (dupCache.get(ps[j].id) || dupCache.set(ps[j].id, [ps[j]]).get(ps[j].id)).push(ps[i]);
    }
    return dupCache;
  }
  const dupesOf = p => (groups().get(p.id) || []).filter(x => x.id !== p.id);

  // Remove copies. Pairs are compared directly (no chains), and only an unreviewed jacket is removed:
  //  - new vs reviewed (approved/rejected) -> the new copy goes, your decision stays
  //  - new vs new -> the more expensive goes (the cheaper offer is kept), equal price -> the newer goes
  //  - reviewed vs reviewed -> both stay (you decided on both)
  // Removed copies are remembered so hunts never bring them back; their shop + price is kept on the jacket that stays.
  function removeCopies(candidates) {
    const ps = db().products, gone = new Set(), removed = [];
    const better = (a, b) => (a.price ?? 1e9) - (b.price ?? 1e9) || a.id - b.id; // <0: a is kept
    for (const a of candidates) {
      if (gone.has(a.id)) continue;
      for (const b of ps) {
        if (b === a || gone.has(b.id) || gone.has(a.id) || !sameJacket(a, b)) continue;
        let drop;
        if (a.status === 'new' && b.status !== 'new') drop = a;
        else if (b.status === 'new' && a.status !== 'new') drop = b;
        else if (a.status === 'new' && b.status === 'new') drop = better(a, b) < 0 ? b : a;
        else continue;
        const keep = drop === a ? b : a;
        noteElsewhere(keep, drop);
        gone.add(drop.id); removed.push(drop);
      }
    }
    if (!removed.length) return 0;
    db().products = ps.filter(p => !gone.has(p.id));
    const now = new Date().toISOString();
    for (const p of removed) {
      db().rejected.push({ key: p.key, contentHash: p.contentHash, title: p.title, at: now, by: 'duplicate' });
      const run = db().runs.find(r => r.id === p.runId);
      if (run) { run.found = Math.max(0, (run.found || 0) - 1); run.duplicates = (run.duplicates || 0) + 1; }
      delete ph[p.id]; delete emb[p.id]; featCache.delete(p.id);
      console.log(`Duplicate removed: #${p.id} "${p.title}"`);
    }
    ctx.trimRejected?.();
    ctx.removeUnusedMedia?.(removed);
    savePh();
    dupCache = null;
    ctx.save();
    ctx.broadcast('stats', {});
    return removed.length;
  }
  const sweepDuplicates = () => removeCopies(db().products.slice());
  // New jackets from a hunt: fingerprint them now, then compare only them against the list (fast)
  async function checkNew(list) {
    for (const p of list) if (!ph[p.id]) await hashProduct(p);
    return removeCopies(list.filter(p => db().products.includes(p)));
  }
  // Older jackets without a fingerprint get one in the background; each is checked right after
  let hashing = false;
  setInterval(async () => {
    if (hashing || frozen) return;
    const p = db().products.find(x => !ph[x.id] && x.images.length);
    if (!p) return;
    hashing = true;
    try { await hashProduct(p); if (db().products.includes(p)) removeCopies([p]); } catch (e) { console.error('Photo check failed:', e.message); }
    finally { hashing = false; }
  }, 1500);
  // Remember where else the same jacket was seen (shop, link, price)
  function noteElsewhere(keep, other) {
    const list = (keep.alsoAt || []).filter(x => x.link !== other.link);
    list.push({ source: other.source, shop: other.sourceDomain || other.marketplace || other.source, link: other.link, price: other.price, currency: other.currency, at: new Date().toISOString() });
    keep.alsoAt = list.slice(-10);
  }
  setTimeout(() => { try { const n = sweepDuplicates(); if (n) console.log(`Removed ${n} duplicate jackets`); } catch (e) { console.error('duplicate sweep', e.message); } }, 4000);
  setInterval(() => { if (!frozen) try { sweepDuplicates(); } catch (e) { console.error('duplicate sweep', e.message); } }, 10 * 60 * 1000);
  // merged view (kept for old links): one per group
  function merge(items) {
    const g = groups(), seen = new Set(), out = [];
    for (const p of items) {
      const members = g.get(p.id);
      if (!members) { out.push(p); continue; }
      const gid = Math.min(...members.map(m => m.id));
      if (seen.has(gid)) continue;
      seen.add(gid);
      out.push(members.filter(m => items.includes(m)).sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9))[0]);
    }
    return out;
  }

  // ---------- sales velocity ----------
  function recordMetrics(p, m) {
    const row = { at: new Date().toISOString(), sold: num(m.sold), favorites: num(m.favorites), reviews: num(m.reviews) };
    if (row.sold === null && row.favorites === null && row.reviews === null) return;
    const last = (p.metrics || []).at(-1);
    if (last && last.sold === row.sold && last.favorites === row.favorites && last.reviews === row.reviews) return;
    p.metrics = [...(p.metrics || []), row].slice(-60);
  }
  function velocityOf(p) {
    const m = (p.metrics || []).filter(x => x.sold !== null || x.favorites !== null);
    if (m.length < 2) return null;
    const first = m.find(x => Date.parse(x.at) >= Date.parse(m.at(-1).at) - 14 * 864e5) || m[0], last = m.at(-1);
    const days = Math.max(1, (Date.parse(last.at) - Date.parse(first.at)) / 864e5);
    const sold = last.sold !== null && first.sold !== null ? (last.sold - first.sold) / days * 7 : null;
    const fav = last.favorites !== null && first.favorites !== null ? (last.favorites - first.favorites) / days * 7 : null;
    return { soldPerWeek: sold === null ? null : Math.round(sold * 10) / 10, favoritesPerWeek: fav === null ? null : Math.round(fav * 10) / 10, since: first.at };
  }

  // extra fields on every jacket the page sees
  function enrich(out, p) {
    out.profit = profitOf(p);
    out.match = matchOf(p);
    out.dupes = dupesOf(p).length;
    out.velocity = velocityOf(p);
    return out;
  }
  const sorters = {
    profit: (a, b) => (profitOf(b)?.profit ?? -1e9) - (profitOf(a)?.profit ?? -1e9),
    match: (a, b) => (matchOf(b) ?? -1) - (matchOf(a) ?? -1),
    velocity: (a, b) => (velocityOf(b)?.soldPerWeek ?? velocityOf(b)?.favoritesPerWeek ?? -1) - (velocityOf(a)?.soldPerWeek ?? velocityOf(a)?.favoritesPerWeek ?? -1)
  };

  // ---------- routes ----------
  async function handle(req, res, url, parts, me) {
    // photo search: { image: dataURL } or { url }
    if (parts[1] === 'search' && parts[2] === 'photo' && req.method === 'POST') {
      const b = await readBody(req);
      let src = str(b.url), tmp = null;
      const m = String(b.image || '').match(/^data:image\/(png|jpe?g|webp|gif|avif);base64,(.+)$/);
      if (m) { tmp = path.join(ctx.DATA_DIR, `search-${Date.now()}.${m[1].replace('jpeg', 'jpg')}`); fs.writeFileSync(tmp, Buffer.from(m[2], 'base64')); src = tmp; }
      if (!src) return send(res, 400, { error: 'Add a photo or a photo link' }), true;
      try {
        // a typed link: download it safely first (public sites only, timeout) instead of letting the AI open any address or file
        if (!tmp) { tmp = path.join(ctx.DATA_DIR, `search-${Date.now()}.img`); fs.writeFileSync(tmp, await ctx.fetchPublicImage(src)); src = tmp; }
        const v = await ctx.jacketVision.embed(src);
        const hits = db().products.filter(p => emb[p.id]?.length).map(p => ({ p, s: dot(v, emb[p.id]) })).sort((a, b) => b.s - a.s).slice(0, 36);
        return send(res, 200, { items: hits.map(h => ({ ...ctx.summary(h.p), similarity: Math.round(Math.max(0, (h.s - 0.5) / 0.5) * 100) })), indexed: Object.values(emb).filter(x => x.length).length, total: db().products.length }), true;
      } catch (e) {
        return send(res, 400, { error: 'Could not read that photo: ' + String(e.message).slice(0, 80) }), true;
      } finally { if (tmp) fs.rm(tmp, () => {}); }
    }
    if (parts[1] === 'taste' && req.method === 'GET') {
      const t = tasteModel();
      return send(res, 200, { ready: !!t, approved: t?.approved ?? db().products.filter(p => p.status === 'approved').length, rejected: t?.rejected ?? db().products.filter(p => p.status === 'rejected').length, indexed: Object.values(emb).filter(x => x.length).length }), true;
    }
    // per-jacket cost override (profit calculator)
    if (parts[1] === 'products' && parts[3] === 'cost' && req.method === 'POST') {
      if (!ctx.can(me, 'jackets.edit')) return send(res, 403, { error: "You don't have permission to edit jackets" }), true;
      const p = db().products.find(x => x.id === Number(parts[2]));
      if (!p) return send(res, 404, { error: 'Product not found' }), true;
      const v = num((await readBody(req)).cost);
      p.costOverride = v !== null && v >= 0 ? v : null;
      ctx.save();
      return send(res, 200, { profit: profitOf(p) }), true;
    }
    return false;
  }

  return { enrich, merge, sorters, profitOf, matchOf, dupesOf, findDuplicate, sweepDuplicates, noteElsewhere, checkNew, velocityOf, recordMetrics, storeEmbedding, handle, DEFAULT_PROFIT };
};
