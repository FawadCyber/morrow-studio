// Leather Hunt dashboard server - zero dependencies (Node 18+).
// Serves the dashboard, stores hunted products in PostgreSQL (DATABASE_URL; data/db.json without it) and triggers the n8n hunt.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jacketVision = require('./vision');

const PORT = Number(process.env.PORT) || 4300;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Shared secret between n8n and the dashboard. No built-in default: without INGEST_KEY, hunt uploads are refused.
const INGEST_KEY = process.env.INGEST_KEY || '';
if (!INGEST_KEY) console.warn('WARNING: INGEST_KEY is not set - n8n cannot send jackets until you set it in .env.');
// Fetch a photo from a link a USER typed: public web addresses only (no localhost / private network / cloud metadata),
// redirects re-checked, 15 s timeout, 15 MB cap. Returns the image bytes.
const dnsP = require('dns').promises, net = require('net');
const privateIp = ip => {
  if (net.isIPv6(ip)) { const v = ip.toLowerCase(); if (v.startsWith('::ffff:')) return privateIp(v.slice(7)); return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80'); }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
};
async function fetchPublicImage(link) {
  let u = String(link || '').trim();
  for (let hop = 0; hop < 4; hop++) {
    let url; try { url = new URL(u); } catch { throw new Error('Not a valid link'); }
    if (!/^https?:$/.test(url.protocol)) throw new Error('Only http(s) photo links');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [{ address: host }] : await dnsP.lookup(host, { all: true });
    if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error('That address is not a public website');
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), url).href; continue; }
    if (!r.ok) throw new Error('The photo link answered ' + r.status);
    if (Number(r.headers.get('content-length') || 0) > 15e6) throw new Error('Photo is too large');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15e6) throw new Error('Photo is too large');
    return buf;
  }
  throw new Error('Too many redirects');
}

// constant-time key check (no timing leaks)
const keyOk = req => { if (!INGEST_KEY) return false; const a = Buffer.from(String(req.headers['x-ingestion-key'] || '')), b = Buffer.from(INGEST_KEY); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const DEFAULT_SETTINGS = {
  minPrice: 80,
  maxPrice: 600,
  websites: [],
  sources: ['ebay', 'etsy', 'websites'],
  markets: ['US', 'UK', 'CA'],
  keywords: [],
  allowFaux: false,
  maxPagesPerSite: 30,
  topN: 10,
  n8nWebhookUrl: process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/leather-hunt',
  dashboardUrlForN8n: process.env.DASHBOARD_URL_FOR_N8N || 'http://host.docker.internal:4300',
  visionAuto: true
};

// Settings as the browser sees them: secret keys never leave the server (only "is it set")
const publicSettings = () => {
  const { visionUrl, visionKey, serpApiKey, serperKey, telegramBotToken, telegramBotName, shopify, ...rest } = db.settings;
  return { ...rest, serperKeySet: !!serperKey, shopify: { domain: shopify?.domain || '', vendor: shopify?.vendor || '', tokenSet: !!shopify?.token } };
};
const F = {}; // feature modules (lib/*), filled in at start-up

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };

// Saves image files sent by n8n; returns { remoteUrl: '/media/<sha256>.<ext>' }
function storeImages(files) {
  const saved = {};
  for (const f of Array.isArray(files) ? files : []) {
    const type = String(f && f.content_type || '').toLowerCase().split(';')[0];
    const ext = IMAGE_EXT[type];
    if (!f || !f.url || !f.data || !ext) continue;
    const buf = Buffer.from(String(f.data), 'base64');
    if (buf.length < 1000 || buf.length > 15e6) continue;
    const name = crypto.createHash('sha256').update(String(f.url)).digest('hex') + ext;
    const target = path.join(MEDIA_DIR, name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, buf);
    saved[f.url] = '/media/' + name;
  }
  return saved;
}

function removeUnusedMedia(products) {
  const used = new Set(db.products.flatMap(p => p.images.filter(u => u.startsWith('/media/'))));
  for (const p of products) for (const u of p.images) {
    if (!u.startsWith('/media/') || used.has(u)) continue;
    const name = path.basename(u);
    try { fs.unlinkSync(path.join(MEDIA_DIR, name)); } catch {}
    try { fs.unlinkSync(path.join(DATA_DIR, 'thumbs', name.replace(/\.[a-z0-9]+$/i, '') + '.webp')); } catch {} // its grid thumbnail too
  }
}
let db = { settings: { ...DEFAULT_SETTINGS }, products: [], runs: [], rejected: [], trends: null, looks: [], views: [], nextId: 1 };
// Load the database. Only "file doesn't exist yet" means start empty. Anything else (locked, half-written,
// corrupt) must NOT start an empty db, or the first save would overwrite the real data.
function decidedDates(d) { for (const p of d.products || []) if (p.status !== 'new' && !p.decidedAt) p.decidedAt = p.updatedAt || p.createdAt; return d; }
function loadDb() {
  let text;
  for (let attempt = 1; ; attempt++) {
    try { text = fs.readFileSync(DB_FILE, 'utf8'); break; }
    catch (e) {
      if (e.code === 'ENOENT') return null;
      if (attempt >= 5) throw new Error(`Cannot read ${DB_FILE} (${e.code}). Refusing to start so your data is not overwritten.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); // locked (e.g. backup running): wait 1s and retry
    }
  }
  try { return JSON.parse(text.replace(/^﻿/, '')); }
  catch (e) {
    const aside = `${DB_FILE}.corrupt-${Date.now()}`;
    fs.copyFileSync(DB_FILE, aside);
    // fall back to the last good copy written by flush()
    try { const prev = JSON.parse(fs.readFileSync(DB_FILE + '.prev', 'utf8')); console.error(`db.json was corrupt (kept as ${aside}); loaded the previous good copy`); return prev; }
    catch { throw new Error(`db.json is corrupt (kept as ${aside}) and there is no good previous copy. Restore a backup. Refusing to start.`); }
  }
}
// PostgreSQL when DATABASE_URL is set. Loaded once at start-up (a short helper process, so start-up stays simple);
// if Postgres can't be reached the dashboard refuses to start instead of starting empty.
const USE_PG = !!process.env.DATABASE_URL;
let pg = null, pgLoaded = null;
if (USE_PG) {
  const { makeStore } = require('./lib/pgstore');
  const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'lib', 'pgstore.js'), 'load'], { env: { ...process.env, DATA_DIR }, maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  pgLoaded = JSON.parse(out);
  pg = makeStore(process.env.DATABASE_URL);
  pg.adopt(pgLoaded.db, pgLoaded.pks);
  pg.primeFrom(pgLoaded.db); // what Postgres holds now: the first save only writes real changes
}
const saved = decidedDates(USE_PG ? (pgLoaded.db.nextId || pgLoaded.db.products.length || pgLoaded.db.users.length ? pgLoaded.db : null) : loadDb());
if (saved) db = { ...db, ...saved, settings: { ...DEFAULT_SETTINGS, ...saved.settings } };
// 5 pages per website meant at most 5 jackets per hunt: read at least 20 (60 by default)
if (!(db.settings.maxPagesPerSite >= 20)) db.settings.maxPagesPerSite = 30;
delete db.settings.visionUrl; // the old VPS vision service is gone
delete db.settings.visionKey;

let saveTimer = null, frozen = false, lastPrevCopy = 0;
// Atomic write (tmp + rename). Never throws: a failed write (disk full, file locked) is logged and retried,
// instead of crashing the server and losing everything in memory.
let pgBusy = null, pgAgain = false;
function flushPg() {
  if (pgBusy) { pgAgain = true; return pgBusy; } // one write at a time; changes made meanwhile go in the next one
  pgBusy = pg.write(db)
    .catch(e => { console.error('Saving to Postgres failed, retrying in 5s:', e.message); clearTimeout(saveTimer); saveTimer = setTimeout(flush, 5000); })
    .finally(() => { pgBusy = null; if (pgAgain && !frozen) { pgAgain = false; flush(); } });
  return pgBusy;
}
function flush() {
  if (frozen) return;
  clearTimeout(saveTimer);
  if (USE_PG) return flushPg();
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    // keep a last-known-good copy (at most every 10 min) to recover from a corrupt db.json
    if (Date.now() - lastPrevCopy > 600000 && fs.existsSync(DB_FILE)) { try { fs.copyFileSync(DB_FILE, DB_FILE + '.prev'); lastPrevCopy = Date.now(); } catch {} }
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('Saving the database failed, retrying in 5s:', e.code || e.message);
    saveTimer = setTimeout(flush, 5000);
  }
}
function save() {
  if (frozen) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 150);
}
// restore in progress: stop writing so the restored copy isn't overwritten; unfreeze if the restore fails
const freezeHooks = [];
const freeze = () => { frozen = true; clearTimeout(saveTimer); for (const f of freezeHooks) try { f(); } catch {} };
const unfreeze = () => { frozen = false; save(); };
// a plain copy of everything for backups (old and new backups restore the same way)
function exportJson() {
  if (!USE_PG) return flush();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
// Docker stop / restart: write the last changes before exiting
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
  if (stopping) return; stopping = true;
  try { if (!frozen) { clearTimeout(saveTimer); if (USE_PG) { if (pgBusy) await pgBusy; await pg.write(db); } else flush(); } } catch (e) { console.error('Last save failed:', e.message); }
  process.exit(0);
});
// Last line of defence: a bug in a background job must not take the whole server down
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e && e.stack || e));
process.on('uncaughtException', e => console.error('Uncaught exception:', e && e.stack || e));

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.webp': 'image/webp' };

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const BIG_BODY = ['/api/ingest', '/api/trends/ingest', '/api/watch/report'];
function readBody(req) {
  const max = BIG_BODY.includes((req.url || '').split('?')[0]) ? 120e6 : 2e6;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > max) { chunks.length = 0; return reject(new Error('Body too large')); } // the rest is read and thrown away, so a clear answer can still be sent
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const str = v => (v === null || v === undefined ? '' : String(v)).trim();
const num = v => { if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const list = v => (Array.isArray(v) ? v : str(v).split(/[\n,]/)).map(s => str(s)).filter(Boolean);

function normalizeProduct(p) {
  const raw = p.raw_details || p.rawDetails || {};
  const remoteImages = [...new Set(list(p.image_urls || p.images).filter(u => /^https:\/\//i.test(u)))];
  const local = p.__keepFiles ? storeImages(p.image_files) : {};
  // Local copies first (always load); fall back to the store's link for any image n8n couldn't download
  const images = remoteImages.map(u => local[u] || u);
  const loc = raw.itemLocation || {};
  const ship = (raw.shippingOptions || [])[0] || {};
  const returns = raw.returnTerms || {};

  const specifics = [];
  for (const a of raw.localizedAspects || []) if (a && a.name) specifics.push({ name: str(a.name), value: str(a.value) });
  if (!specifics.length) {
    if (raw.materials?.length) specifics.push({ name: 'Materials', value: raw.materials.join(', ') });
    if (raw.material) specifics.push({ name: 'Material', value: str(raw.material) });
    if (raw.color) specifics.push({ name: 'Color', value: str(raw.color) });
    if (raw.sku) specifics.push({ name: 'SKU', value: str(raw.sku) });
    if (raw.availability) specifics.push({ name: 'Availability', value: str(raw.availability) });
    if (raw.when_made) specifics.push({ name: 'Made', value: str(raw.when_made).replace(/_/g, ' ') });
    if (raw.shop?.shopName) specifics.push({ name: 'Shop', value: raw.shop.shopName });
    if (raw.shop?.transactionSoldCount) specifics.push({ name: 'Shop sales', value: String(raw.shop.transactionSoldCount) });
    if (raw.num_favorers) specifics.push({ name: 'Favourites', value: String(raw.num_favorers) });
  }

  return {
    source: str(p.source).toLowerCase() || 'website',
    sourceId: str(p.product_id || p.sourceId || p.product_link),
    marketplace: str(p.marketplace) || 'Website',
    sourceDomain: str(p.source_domain),
    title: str(p.product_name || p.title),
    link: /^https?:\/\//i.test(str(p.product_link || p.link)) ? str(p.product_link || p.link) : '', // only real web links
    price: num(p.source_price ?? p.price),
    currency: str(p.source_currency || p.currency) || 'USD',
    images,
    remoteImages,
    localImageCount: Object.keys(local).length,
    mainImage: images[0] || str(p.primary_image_url),
    description: str(p.description).slice(0, 8000),
    brand: str(p.brand),
    condition: str(p.condition),
    gender: str(p.gender) || 'Unisex',
    material: str(p.material) || 'Leather',
    sellerName: str(p.seller_name),
    sellerFeedback: num(p.seller_feedback),
    sellerFeedbackScore: num(p.seller_feedback_score),
    rating: num(p.rating),
    reviewCount: num(p.review_count),
    score: num(p.trend_score) ?? 0,
    scoreReasons: list(p.score_reasons),
    market: str(p.market),
    searchQuery: str(p.search_query),
    location: [loc.city, loc.stateOrProvince, loc.country].filter(Boolean).join(', '),
    shipping: ship.shippingCost ? (Number(ship.shippingCost.value) === 0 ? 'Free shipping' : `${ship.shippingCost.currency || ''} ${ship.shippingCost.value}`.trim()) : '',
    returns: returns.returnsAccepted === true ? `Accepted${returns.returnPeriod ? ` · ${returns.returnPeriod.value} ${String(returns.returnPeriod.unit || '').toLowerCase()}` : ''}` : returns.returnsAccepted === false ? 'Not accepted' : '',
    buyingOptions: list(raw.buyingOptions),
    conditionDescription: str(raw.conditionDescription),
    tags: list(raw.tags),
    specifics,
    runId: str(p.run_id),
    trendTopic: str(p.trend_topic),
    soldCount: num(raw.estimatedSoldQuantity ?? raw.sold_count),
    favorites: num(raw.num_favorers),
    isBestseller: p.is_bestseller === true,
    listedAt: str(p.listed_at && (typeof p.listed_at === 'number' ? new Date(p.listed_at < 1e12 ? p.listed_at * 1000 : p.listed_at).toISOString() : p.listed_at)),
    huntedAt: str(p.hunted_at) || new Date().toISOString()
  };
}

const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');

// Two SHA-256 fingerprints per product: the listing itself, and its content (title + main image file)
// Photo identity: Google's picture id, eBay's picture id, or shop host + file name. Never a bare file name.
function imageId(u) {
  const raw = String(u || '');
  let url; try { url = new URL(raw); } catch { return raw.split('?')[0].split('/').pop(); }
  const tbn = url.search.match(/tbn:([\w-]{12,})/); if (tbn) return 'tbn:' + tbn[1];
  const ebay = url.pathname.match(/\/images\/g\/([^/]{6,})\//); if (ebay) return 'ebay:' + ebay[1];
  return url.host.replace(/^www\./, '') + '/' + url.pathname.split('/').pop().replace(/_\d+x\d*|_(?:large|grande|master)/gi, '');
}
const titleKey = p => p.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function hashes(p) {
  const first = (p.remoteImages && p.remoteImages[0]) || p.mainImage;
  return {
    key: sha256(p.source + ':' + p.sourceId),
    contentHash: sha256('v2|' + titleKey(p) + '|' + imageId(first)),
    // the old formula, only to recognise jackets rejected before the fix
    legacyHash: sha256(titleKey(p) + '|' + String(first).split('?')[0].split('/').pop().replace(/_\d+x\d*|_(?:large|grande|master)/gi, ''))
  };
}

// Rejected / deleted / duplicate list: capped, and looked up through an index instead of scanning it for every jacket
const REJECTED_MAX = 8000;
let rejIdx = null, rejLen = -1;
function trimRejected() { if (db.rejected.length > REJECTED_MAX) { db.rejected = db.rejected.slice(-REJECTED_MAX); rejLen = -1; } }
function isRejected(...ids) {
  if (rejLen !== db.rejected.length) { rejIdx = new Set(); for (const r of db.rejected) { rejIdx.add(r.key); rejIdx.add(r.contentHash); } rejLen = db.rejected.length; }
  return ids.some(x => x && rejIdx.has(x));
}

function upsert(input) {
  let p = normalizeProduct(input); // first without writing photos: most incoming jackets are skipped
  if (!p.title || !p.link || !p.sourceId) return null;
  if (p.runId && db.runs.find(r => r.id === p.runId)?.status === 'stopped') return null; // that hunt was stopped
  const { key, contentHash, legacyHash } = hashes(p);
  // Already rejected, deleted or removed as a duplicate: never add it back
  if (isRejected(key, contentHash, legacyHash)) return null;
  // the same listing is matched by its own id; the content hash only for listings of the same source
  const existing = db.products.find(x => x.key === key) || db.products.find(x => x.source === p.source && x.contentHash === contentHash);
  const now = new Date().toISOString();
  // The same jacket from another shop / listing / source: never add a second copy, just remember where else it was seen
  const twin = !existing && F.intel?.findDuplicate({ ...p, key });
  if (twin) {
    F.intel.noteElsewhere(twin, p);
    db.rejected.push({ key, contentHash, title: p.title, at: now, by: 'duplicate' });
    trimRejected();
    const run = db.runs.find(r => r.id === p.runId);
    if (run) run.duplicates = (run.duplicates || 0) + 1;
    return null;
  }
  // kept: now write its photos
  if (Array.isArray(input.image_files) && input.image_files.length) p = normalizeProduct({ ...input, __keepFiles: true });
  if (existing) {
    const prevPrice = existing.price;
    const before = { images: existing.images.slice() };
    const sameListing = existing.key === key;
    // re-found: refresh the facts, keep your decision, notes and when it was found; only re-check photos if they changed
    const photosChanged = existing.remoteImages.join('|') !== p.remoteImages.join('|');
    Object.assign(existing, p, { key: existing.key, contentHash: existing.contentHash, id: existing.id, status: existing.status, note: existing.note, createdAt: existing.createdAt, decidedAt: existing.decidedAt, updatedAt: now, seenAt: now, visionChecked: photosChanged ? false : existing.visionChecked });
    if (!sameListing) existing.link = existing.link || p.link;
    removeUnusedMedia([before]);
    // Price history: one entry per change
    if (p.price !== null && prevPrice !== p.price) {
      const hist = existing.priceHistory || (prevPrice !== null ? [{ at: existing.createdAt, price: prevPrice }] : []);
      existing.priceHistory = [...hist, { at: now, price: p.price }].slice(-30);
    }
    F.intel?.recordMetrics(existing, { sold: p.soldCount, favorites: p.favorites, reviews: p.reviewCount });
    return existing;
  }
  const created = { id: db.nextId++, key, contentHash, ...p, status: 'new', note: '', priceHistory: p.price !== null ? [{ at: now, price: p.price }] : [], createdAt: now, updatedAt: now };
  F.intel?.recordMetrics(created, { sold: p.soldCount, favorites: p.favorites, reviews: p.reviewCount });
  db.products.push(created);
  const run = db.runs.find(r => r.id === p.runId);
  if (run) run.found = (run.found || 0) + 1;
  return created;
}

// ---------- jacket check worker ----------
// Every product's photos go through CLIP (built into the dashboard, see vision.js).
// Leather jacket photos stay, the rest are removed. A product with no leather jacket photo is deleted.
const vision = { busy: false, checked: 0, imagesRemoved: 0, productsDeleted: 0, lastError: '', lastRunAt: null };

// Local copy first (always readable), else the store's link
const photoSource = (p, i) => {
  const img = p.images[i] || '';
  return img.startsWith('/media/') ? path.join(MEDIA_DIR, path.basename(img)) : p.remoteImages[i];
};

async function visionCheck(p) {
  const n = Math.min(p.remoteImages.length, 30);
  if (!n) { p.visionChecked = true; p.visionVersion = jacketVision.VERSION; return; }
  const snapshot = p.remoteImages.slice(0, n).join('\n');
  const verdicts = [];
  for (let i = 0; i < n; i++) {
    try { verdicts.push(await jacketVision.check(photoSource(p, i))); }
    catch (e) { verdicts.push({ error: e.message }); }
  }
  // Deleted or re-hunted while we were checking: leave it for the next round
  if (!db.products.includes(p) || p.remoteImages.slice(0, n).join('\n') !== snapshot) return;
  const judged = verdicts.filter(v => !v.error);
  if (!judged.length) {
    // No photo could be read (site blocks this PC): give up after 3 tries and keep the product as is
    p.visionTries = (p.visionTries || 0) + 1;
    if (p.visionTries >= 3) { p.visionChecked = true; p.visionVersion = jacketVision.VERSION; p.visionNote = 'Photos could not be read'; }
    return;
  }
  const yes = judged.filter(v => v.is_leather_jacket);

  if (!yes.length) {
    db.products.splice(db.products.indexOf(p), 1);
    db.rejected.push({ key: p.key, contentHash: p.contentHash, title: p.title, at: new Date().toISOString() });
    trimRejected();
    removeUnusedMedia([p]);
    vision.productsDeleted++;
    return;
  }

  // Keep photos judged leather jacket, plus any that failed to load (not judged), and photos past the first 30
  const before = { ...p, images: [...p.images] };
  const idx = p.remoteImages.map((u, i) => i >= n || verdicts[i].error || verdicts[i].is_leather_jacket ? i : -1).filter(i => i !== -1);
  vision.imagesRemoved += p.remoteImages.length - idx.length;
  p.images = idx.map(i => p.images[i]).filter(Boolean);
  p.remoteImages = idx.map(i => p.remoteImages[i]);
  p.mainImage = p.images[0] || p.mainImage;
  // fingerprint of the main photo (first leather jacket photo) for taste, photo search and duplicates
  const mainVerdict = verdicts.find(v => !v.error && v.is_leather_jacket);
  if (mainVerdict?.embedding) F.intel?.storeEmbedding(p.id, mainVerdict.embedding);
  const best = yes.sort((a, b) => b.confidence - a.confidence)[0];
  p.visionStyle = best.style;
  p.visionColor = best.color;
  p.visionConfidence = best.confidence;
  p.visionChecked = true;
  p.visionVersion = jacketVision.VERSION;
  removeUnusedMedia([before]);
}

// ---------- Google Trends: celebrity looks ----------
// News photos of today's trending topics are checked with CLIP; the ones showing a
// leather jacket become "celebrity looks", and their topic is hunted on the next run.
const LOOK_MIN = 0.85; // stricter than products: news photos are noisy
const LOOK_MAYBE = 0.7;
const LOOK_DAYS = 7;

function ingestTrends(t) {
  const markets = t && typeof t.markets === 'object' ? t.markets : {};
  db.trends = { fetchedAt: str(t.fetched_at) || new Date().toISOString(), notes: list(t.notes), markets: {} };
  const known = new Set(db.looks.map(l => l.picture));
  let added = 0;
  for (const [geo, m] of Object.entries(markets)) {
    const trending = (Array.isArray(m.trending) ? m.trending : []).slice(0, 25);
    db.trends.markets[geo] = {
      trending: trending.map(x => ({ topic: str(x.topic), traffic: str(x.traffic), started: str(x.started), news: (x.news || []).slice(0, 3).map(n => ({ title: str(n.title), url: str(n.url), source: str(n.source) })) })),
      rising: (m.rising || []).slice(0, 15).map(r => ({ query: str(r.query), value: str(r.value) })),
      top: (m.top || []).slice(0, 15).map(r => ({ query: str(r.query), value: str(r.value) }))
    };
    for (const x of trending) {
      const pics = [{ picture: x.picture }, ...(x.news || [])].filter(n => /^https:\/\//i.test(str(n.picture))).slice(0, 4);
      for (const n of pics) {
        if (known.has(n.picture)) continue;
        known.add(n.picture);
        db.looks.push({ id: sha256(n.picture).slice(0, 16), topic: str(x.topic), geo, traffic: str(x.traffic), picture: str(n.picture),
          newsTitle: str(n.title), newsUrl: str(n.url), source: str(n.source), at: new Date().toISOString(), status: 'pending', tries: 0 });
        added++;
      }
    }
  }
  const cutoff = Date.now() - LOOK_DAYS * 864e5;
  db.looks = db.looks.filter(l => Date.parse(l.at) > cutoff).slice(-3000);
  save();
  F.insights?.recordTrends(t);
  return added;
}

async function checkLooks() {
  for (const l of db.looks.filter(x => x.status === 'pending').slice(0, 12)) {
    try {
      const v = await jacketVision.check(l.picture, { news: true });
      // 85%+ = confident look; 70-85% = possible look (CLIP alone can't tell these apart reliably, you judge)
      const status = v.confidence >= LOOK_MIN ? 'jacket' : v.confidence >= LOOK_MAYBE ? 'maybe' : 'no';
      Object.assign(l, { status, color: v.color, style: v.style, confidence: v.confidence });
    } catch (e) {
      if (++l.tries >= 3) l.status = 'unreadable';
    }
  }
}

// Phrases for the next hunt: looks you chose with "Hunt this look" (kept for 24 hours after choosing)
function trendKeywords() {
  const since = Date.now() - 864e5;
  return [...new Set(db.looks.filter(l => l.huntAt && Date.parse(l.huntAt) > since)
    .map(l => `${l.topic} leather jacket`.toLowerCase()))].slice(0, 5);
}

async function visionWorker() {
  if (vision.busy || db.settings.visionAuto === false) return;
  vision.busy = true;
  try {
    if (db.looks.some(l => l.status === 'pending')) { await checkLooks(); save(); }
    for (const p of db.products.filter(x => !x.visionChecked || (x.visionVersion || 1) !== jacketVision.VERSION).slice(0, 5)) {
      await visionCheck(p);
      vision.checked++;
      save();
    }
    vision.lastError = '';
  } catch (e) {
    vision.lastError = e.message;
  } finally {
    vision.busy = false;
    vision.lastRunAt = new Date().toISOString();
  }
}
setInterval(visionWorker, 15000);

// Leather type from the title / material
function leatherType(p) {
  const t = (p.title + ' ' + p.material).toLowerCase();
  for (const [k, re] of [['Suede', /suede/], ['Shearling', /shearling|sheepskin|sherpa/], ['Lambskin', /lambskin|lamb leather/], ['Cowhide', /cowhide|cow leather|buffalo/], ['Goatskin', /goatskin|goat leather/], ['Nappa', /nappa/], ['Faux', /faux|vegan|pu leather/]]) if (re.test(t)) return k;
  return 'Leather';
}
const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Everything except the facet named `skip`, so each chip group shows counts for the other filters
function filterProducts(q, skip = '') {
  let items = db.products;
  const is = (k, v) => q[k] && q[k] !== 'all' && skip !== k ? v : null;
  if (is('status', 1)) items = items.filter(p => p.status === q.status);
  if (is('source', 1)) items = items.filter(p => q.source.split(',').includes(p.source));
  if (is('gender', 1)) items = items.filter(p => q.gender.split(',').includes(p.gender));
  if (is('color', 1)) items = items.filter(p => q.color.split(',').includes(p.visionColor));
  if (is('style', 1)) items = items.filter(p => q.style.split(',').includes(p.visionStyle));
  if (is('leather', 1)) items = items.filter(p => q.leather.split(',').includes(leatherType(p)));
  if (is('topic', 1)) items = items.filter(p => q.topic.split('|').includes(p.trendTopic));
  if (q.bestseller === '1') items = items.filter(p => p.isBestseller);
  if (q.today === '1') items = items.filter(p => Date.parse(p.createdAt) >= dayStart());
  if (q.run) items = items.filter(p => p.runId === q.run);
  const min = num(q.min), max = num(q.max);
  if (min !== null && q.min !== '') items = items.filter(p => p.price !== null && p.price >= min);
  if (max !== null && q.max !== '') items = items.filter(p => p.price !== null && p.price <= max);
  if (q.q) {
    const words = q.q.toLowerCase().split(/\s+/).filter(Boolean);
    items = items.filter(p => {
      const hay = [p.title, p.brand, p.sellerName, p.sourceDomain, p.visionColor, p.visionStyle, p.trendTopic, p.note, leatherType(p)].join(' ').toLowerCase();
      return words.every(w => hay.includes(w));
    });
  }
  const sorters = {
    score: (a, b) => b.score - a.score,
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    price_asc: (a, b) => (a.price ?? 1e12) - (b.price ?? 1e12),
    price_desc: (a, b) => (b.price ?? -1) - (a.price ?? -1),
    images: (a, b) => b.images.length - a.images.length,
    ...(F.intel?.sorters || {}),
    // trend topic groups, Google Shopping order inside each
    topic: (a, b) => (a.trendTopic || '~').localeCompare(b.trendTopic || '~') || (a.score - b.score) * -1
  };
  const sorted = [...items].sort(sorters[q.sort] || sorters.score);
  return q.merge === '1' && F.intel ? F.intel.merge(sorted) : sorted;
}

function facets(q) {
  const count = (key, fn) => {
    const out = {};
    for (const p of filterProducts(q, key)) { const v = fn(p); if (v) out[v] = (out[v] || 0) + 1; }
    return Object.entries(out).sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }));
  };
  return {
    status: count('status', p => p.status),
    source: count('source', p => p.source),
    gender: count('gender', p => p.gender),
    color: count('color', p => p.visionColor),
    style: count('style', p => p.visionStyle),
    leather: count('leather', p => leatherType(p)),
    topic: count('topic', p => p.trendTopic)
  };
}

// Small grid thumbnail for a local photo (made on first request, then cached)
const thumbOf = u => u && u.startsWith('/media/') ? '/thumbs/' + path.basename(u) : u;

function summary(p) {
  const { description, specifics, tags, scoreReasons, conditionDescription, comments, metrics, priceHistory, ...rest } = p;
  const out = { ...rest, images: p.images.slice(0, 6), thumbs: p.images.slice(0, 6).map(thumbOf), thumb: thumbOf(p.mainImage), imageCount: p.images.length, leather: leatherType(p), commentCount: (comments || []).length };
  return F.intel ? F.intel.enrich(out, p) : out;
}

// Same jacket seen elsewhere: shared title words or the same photo
const STOP = new Set('the a an and with for of in mens men womens women leather jacket jackets genuine real size new'.split(' '));
const words = p => new Set(p.title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
function similarTo(p) {
  const mine = words(p);
  const photo = String(p.remoteImages[0] || '').split('?')[0].split('/').pop();
  return db.products.filter(x => x.id !== p.id).map(x => {
    const theirs = words(x);
    const shared = [...mine].filter(w => theirs.has(w)).length;
    const jac = shared / (new Set([...mine, ...theirs]).size || 1);
    const samePhoto = photo && String(x.remoteImages[0] || '').split('?')[0].split('/').pop() === photo;
    return { x, s: samePhoto ? 1 : jac };
  }).filter(r => r.s >= 0.5).sort((a, b) => b.s - a.s).slice(0, 6)
    .map(({ x, s }) => ({ id: x.id, title: x.title, price: x.price, currency: x.currency, source: x.source, sourceDomain: x.sourceDomain, thumb: thumbOf(x.mainImage), match: Math.round(s * 100), status: x.status }));
}

function insights() {
  const now = Date.now(), DAY = 864e5, today = dayStart();
  const ps = db.products;
  const perDay = [];
  for (let i = 29; i >= 0; i--) {
    const from = today - i * DAY, to = from + DAY;
    const that = ps.filter(p => { const t = Date.parse(p.createdAt); return t >= from && t < to; });
    perDay.push({ day: new Date(from).toISOString().slice(0, 10), found: that.length, approved: that.filter(p => p.status === 'approved').length });
  }
  const tally = fn => { const o = {}; for (const p of ps) { const v = fn(p); if (v) o[v] = (o[v] || 0) + 1; } return Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, n]) => ({ value, n })); };
  const priced = ps.filter(p => p.price !== null);
  const buckets = [[0, 100], [100, 150], [150, 200], [200, 300], [300, 450], [450, 1e9]].map(([a, b]) => ({ label: b > 1e8 ? `$${a}+` : `$${a}–${b}`, n: priced.filter(p => p.price >= a && p.price < b).length }));
  const bySource = {};
  for (const p of ps) { const s = (bySource[p.source] ||= { source: p.source, total: 0, approved: 0, rejected: 0 }); s.total++; if (p.status === 'approved') s.approved++; if (p.status === 'rejected') s.rejected++; }
  const topics = {};
  for (const p of ps.filter(x => x.trendTopic)) { const t = (topics[p.trendTopic] ||= { topic: p.trendTopic, total: 0, approved: 0 }); t.total++; if (p.status === 'approved') t.approved++; }
  return {
    newToday: ps.filter(p => Date.parse(p.createdAt) >= today).length,
    waiting: ps.filter(p => p.status === 'new').length,
    approvedWeek: ps.filter(p => p.status === 'approved' && Date.parse(p.updatedAt) >= now - 7 * DAY).length,
    approvedTotal: ps.filter(p => p.status === 'approved').length,
    total: ps.length,
    avgPrice: priced.length ? priced.reduce((s, p) => s + p.price, 0) / priced.length : null,
    perDay, priceBuckets: buckets,
    styles: tally(p => p.visionStyle), colors: tally(p => p.visionColor), leathers: tally(leatherType),
    sources: Object.values(bySource).sort((a, b) => b.total - a.total),
    topics: Object.values(topics).sort((a, b) => b.approved - a.approved || b.total - a.total).slice(0, 10),
    lastRun: db.runs.length ? runView(db.runs[db.runs.length - 1]) : null
  };
}

function stats() {
  const count = s => db.products.filter(p => p.status === s).length;
  const bySource = {};
  for (const p of db.products) bySource[p.source] = (bySource[p.source] || 0) + 1;
  const priced = db.products.filter(p => p.price !== null);
  return {
    total: db.products.length,
    new: count('new'),
    approved: count('approved'),
    rejected: count('rejected'),
    bySource,
    avgPrice: priced.length ? priced.reduce((s, p) => s + p.price, 0) / priced.length : null,
    lastRun: db.runs.length ? runView(db.runs[db.runs.length - 1]) : null,
    vision: { ...vision, waiting: db.products.filter(p => !p.visionChecked || (p.visionVersion || 1) !== jacketVision.VERSION).length, rejectedTotal: db.rejected.length, on: db.settings.visionAuto !== false }
  };
}

// ---------- live updates (server-sent events) ----------
const clients = new Set();
function broadcast(type, data = {}) {
  // personal notifications only go to that person's open windows
  if (type === 'notification' || type === 'access') {
    const msg = `event: ${type}\ndata: ${JSON.stringify(type === 'notification' ? data.n : {})}\n\n`;
    for (const res of clients) if (res._uid === data.uid) { try { res.write(msg); } catch { clients.delete(res); } }
    return;
  }
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch { clients.delete(res); } }
}
setInterval(() => broadcast('ping'), 25000);

// ---------- hunt runs ----------
const STALL_MS = 6 * 60 * 1000; // the workflow reports at least every ~1 minute while it works
setInterval(() => {
  for (const r of db.runs) {
    if (r.status !== 'started' || Date.now() - Date.parse(r.updatedAt || r.startedAt) <= STALL_MS) continue;
    r.status = 'stalled'; r.finishedAt = new Date().toISOString();
    r.error = r.error || 'n8n stopped reporting for 6 minutes. The workflow probably failed - open the execution in n8n to see why.';
    save(); broadcast('run', runView(r)); F.ops?.onRunEnd(r);
  }
}, 30000);
function runView(r) {
  const stalled = r.status === 'started' && Date.now() - Date.parse(r.updatedAt || r.startedAt) > STALL_MS;
  return { ...r, status: stalled ? 'stalled' : r.status };
}
function progress(b) {
  const run = db.runs.find(r => r.id === str(b.runId));
  if (!run) return null;
  if (run.status !== 'started') return run; // stopped / timed out: ignore what it still reports (the answer tells n8n to stop)
  run.steps ||= [];
  const name = str(b.step) || 'Hunt';
  const step = run.steps.find(s => s.name === name) || (run.steps.push({ name, startedAt: new Date().toISOString() }), run.steps[run.steps.length - 1]);
  Object.assign(step, { status: ['running', 'done', 'error', 'skipped'].includes(b.status) ? b.status : 'running', detail: str(b.detail).slice(0, 400), at: new Date().toISOString() });
  if (num(b.count) !== null) step.count = num(b.count);
  run.updatedAt = new Date().toISOString();
  if (b.finished) { run.status = 'finished'; run.finishedAt = run.updatedAt; }
  if (b.failed) { run.status = 'failed'; run.error = str(b.error || b.detail).slice(0, 600); run.finishedAt = run.updatedAt; }
  if (b.finished || b.failed) F.ops?.onRunEnd(run);
  save();
  broadcast('run', runView(run));
  return run;
}

// ---------- zip (store only, no compression: photos are already compressed) ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), crc = crc32(f.data), size = f.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, f.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + size;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
async function photosZip(p) {
  const files = [];
  const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'jacket';
  for (const [i, img] of p.images.slice(0, 30).entries()) {
    try {
      let data;
      if (img.startsWith('/media/')) data = fs.readFileSync(path.join(MEDIA_DIR, path.basename(img)));
      else data = await fetchPublicImage(img);
      const ext = (img.match(/\.(jpe?g|png|webp|gif|avif)(\?|$)/i) || [, 'jpg'])[1];
      files.push({ name: `${slug}-${String(i + 1).padStart(2, '0')}.${ext}`, data });
    } catch {}
  }
  return { slug, buffer: files.length ? zip(files) : null };
}

// Which permission a request needs (null = anyone signed in). Bulk status/delete is checked inside its handler.
function permFor(method, parts, url) {
  const [, a, b, c] = parts, get = method === 'GET';
  if (['me', 'notifications', 'events', 'session', 'logout', 'login', 'perms', 'stats', 'users'].includes(a)) return null; // users: checked in lib/users.js
  if (a === 'settings') return get ? null : 'settings.edit'; // everyone reads the safe settings; the page itself needs settings.view
  if (a === 'summary') return 'settings.edit';
  if (a === 'insights') return b ? 'insights.view' : 'overview.view';
  if (a === 'runs') return 'hunts.view';
  if (a === 'hunt') return 'hunts.run';
  if (a === 'trends') return get ? 'insights.view' : 'hunts.run';
  if (a === 'health') return 'health.view';
  if (a === 'backups') return 'backups.manage';
  if (a === 'activity') return url.searchParams.get('product') ? 'jackets.view' : 'activity.view';
  if (a === 'export.csv') return 'jackets.download';
  if (a === 'boards') return get ? 'boards.view' : c === 'share' ? 'boards.share' : 'boards.edit';
  if (a === 'views') return get ? 'jackets.view' : 'jackets.edit';
  if (['facets', 'taste', 'search', 'vision'].includes(a)) return 'jackets.view';
  if (a === 'products') {
    if (!b) return get ? 'jackets.view' : 'jackets.delete';
    if (b === 'bulk') return null;
    if (c === 'comments') return get ? 'comments.view' : 'comments.write';
    if (c === 'shopify') return 'shopify.push';
    if (c === 'photos.zip') return 'jackets.download';
    if (c === 'status') return 'jackets.review';
    if (['note', 'cost', 'watch'].includes(c)) return get ? 'jackets.view' : 'jackets.edit';
    if (!c) return get ? 'jackets.view' : method === 'DELETE' ? 'jackets.delete' : 'jackets.edit';
    return get ? 'jackets.view' : 'jackets.edit';
  }
  return get ? null : 'settings.edit';
}

// ---------- routes ----------
async function api(req, res, url, me) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  const keyed = KEY_ROUTES.includes(url.pathname);

  // Permissions: every route needs the box that covers it (see lib/perms.js). The owner has every box.
  if (!keyed) {
    const p = permFor(method, parts, url);
    if (p && !F.users.can(me, p)) return send(res, 403, { error: `You don't have permission for this (${p.replace('.', ': ')}). Ask the owner.` });
  }
  for (const f of [F.users, F.intel, F.watch, F.boards, F.ops, F.insights]) if (await f.handle(req, res, url, parts, me)) return;

  if (parts[1] === 'ingest' && method === 'POST') {
    if (!keyOk(req)) return send(res, 401, { error: 'Invalid ingestion key' });
    const body = await readBody(req);
    const items = Array.isArray(body) ? body : Array.isArray(body.products) ? body.products : [body];
    let saved = items.map(upsert).filter(Boolean);
    // Same picture as a jacket already in the list (any seller, any name)? Fingerprint the photos now and drop the copy
    if (saved.length && F.intel) { try { await F.intel.checkNew(saved); } catch (e) { console.error('photo check', e.message); } saved = saved.filter(p => db.products.includes(p)); }
    save();
    if (saved.length) {
      const run = db.runs.find(r => r.id === saved[0].runId);
      if (run) { run.updatedAt = new Date().toISOString(); broadcast('run', runView(run)); }
      broadcast('products', { ids: saved.map(p => p.id), runId: saved[0].runId });
    }
    return send(res, 200, { ok: true, saved: saved.length, ids: saved.map(p => p.id) });
  }

  // n8n reports each hunt step (key protected)
  if (parts[1] === 'hunt' && parts[2] === 'progress' && method === 'POST') {
    if (!keyOk(req)) return send(res, 401, { error: 'Invalid ingestion key' });
    const run = progress(await readBody(req));
    // the workflow stops itself when it is told the hunt is no longer running (stopped / failed / timed out)
    return send(res, run ? 200 : 404, run ? { ok: true, stop: run.status !== 'started', status: run.status } : { error: 'Unknown run', stop: true });
  }

  if (parts[1] === 'events' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 4000\n\n');
    res._uid = me?.id ?? null;
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (parts[1] === 'runs' && method === 'GET') return send(res, 200, { runs: db.runs.slice().reverse().map(runView) });
  if (parts[1] === 'insights' && method === 'GET') return send(res, 200, insights());
  if (parts[1] === 'facets' && method === 'GET') return send(res, 200, facets(Object.fromEntries(url.searchParams)));

  // Saved filter views
  if (parts[1] === 'views') {
    if (method === 'GET') return send(res, 200, { views: db.views });
    if (method === 'POST') {
      const b = await readBody(req);
      const view = { id: crypto.randomBytes(6).toString('hex'), name: str(b.name).slice(0, 60) || 'My view', query: typeof b.query === 'object' && b.query ? b.query : {}, at: new Date().toISOString() };
      db.views.push(view);
      db.views = db.views.slice(-30);
      save();
      return send(res, 200, view);
    }
    if (method === 'DELETE' && parts[2]) {
      db.views = db.views.filter(v => v.id !== parts[2]);
      save();
      return send(res, 200, { ok: true });
    }
  }

  if (parts[1] === 'known' && method === 'GET') {
    if (!keyOk(req)) return send(res, 401, { error: 'Invalid ingestion key' });
    const all = [...db.products, ...db.rejected]; // rejected ones are skipped by the hunt too
    return send(res, 200, { keys: all.map(p => p.key), contentHashes: all.map(p => p.contentHash).filter(Boolean) });
  }

  if (parts[1] === 'settings') {
    if (method === 'GET') return send(res, 200, publicSettings());
    if (method === 'PUT') {
      const b = await readBody(req);
      let minPrice = Math.max(0, num(b.minPrice) ?? db.settings.minPrice);
      let maxPrice = Math.max(0, num(b.maxPrice) ?? db.settings.maxPrice);
      if (minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];
      db.settings = {
        ...db.settings,
        minPrice, maxPrice,
        websites: b.websites !== undefined ? list(b.websites) : db.settings.websites,
        sources: b.sources !== undefined ? list(b.sources).filter(s => ['ebay', 'etsy', 'websites'].includes(s)) : db.settings.sources,
        markets: b.markets !== undefined ? list(b.markets).filter(m => ['US', 'UK', 'CA'].includes(m)) : db.settings.markets,
        keywords: b.keywords !== undefined ? list(b.keywords) : db.settings.keywords,
        allowFaux: b.allowFaux !== undefined ? b.allowFaux === true : db.settings.allowFaux,
        maxPagesPerSite: Math.min(300, Math.max(20, num(b.maxPagesPerSite) ?? db.settings.maxPagesPerSite)),
        topN: Math.min(100, Math.max(1, Math.round(num(b.topN) ?? db.settings.topN ?? 10))),
        n8nWebhookUrl: b.n8nWebhookUrl !== undefined ? str(b.n8nWebhookUrl) : db.settings.n8nWebhookUrl,
        dashboardUrlForN8n: b.dashboardUrlForN8n !== undefined ? str(b.dashboardUrlForN8n).replace(/\/+$/, '') : db.settings.dashboardUrlForN8n,
        visionAuto: b.visionAuto !== undefined ? b.visionAuto === true : db.settings.visionAuto,
        serperKey: b.serperKey === null ? '' : str(b.serperKey) ? str(b.serperKey) : db.settings.serperKey || '',
        shopify: b.shopify ? (() => {
          const old = db.settings.shopify || {}, domain = str(b.shopify.domain) || old.domain || '';
          const keepToken = domain.toLowerCase() === String(old.domain || '').toLowerCase(); // a new shop address needs its own token
          return { domain, vendor: str(b.shopify.vendor) || old.vendor || '', token: str(b.shopify.token) || (keepToken ? old.token || '' : '') };
        })() : db.settings.shopify,
        profit: b.profit ? { ...db.settings.profit, ...b.profit, costs: { ...db.settings.profit?.costs, ...(b.profit.costs || {}) }, fx: { ...db.settings.profit?.fx, ...(b.profit.fx || {}) } } : db.settings.profit,
        schedules: Array.isArray(b.schedules) ? b.schedules.slice(0, 12).map(x => ({ id: str(x.id) || crypto.randomBytes(4).toString('hex'), mode: x.mode === 'trend' ? 'trend' : 'normal', time: /^([01]\d|2[0-3]):[0-5]\d$/.test(x.time) ? x.time : '08:00', days: Array.isArray(x.days) ? x.days.map(Number).filter(d => d >= 0 && d <= 6) : [0, 1, 2, 3, 4, 5, 6], on: x.on !== false })) : db.settings.schedules,
        dailySummary: b.dailySummary ? { on: b.dailySummary.on !== false, time: /^([01]\d|2[0-3]):[0-5]\d$/.test(b.dailySummary.time) ? b.dailySummary.time : '09:00' } : db.settings.dailySummary,
        backup: b.backup ? { on: b.backup.on !== false, time: /^([01]\d|2[0-3]):[0-5]\d$/.test(b.backup.time) ? b.backup.time : '03:00', keep: Math.min(30, Math.max(2, num(b.backup.keep) || 7)) } : db.settings.backup,
        timezone: b.timezone && (() => { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); return true; } catch { return false; } })() ? b.timezone : db.settings.timezone
      };
      F.users.log(me, 'changed settings', Object.keys(b).filter(k => !/key|token/i.test(k)).join(', '));
      delete db.settings.visionUrl;
      delete db.settings.visionKey;
      if (b.shopify && b.shopify.token === null) db.settings.shopify = { ...db.settings.shopify, token: '' };
      save();
      return send(res, 200, publicSettings());
    }
  }

  if (parts[1] === 'trends' && parts[2] === 'ingest' && method === 'POST') {
    if (!keyOk(req)) return send(res, 401, { error: 'Invalid ingestion key' });
    return send(res, 200, { ok: true, newPhotos: ingestTrends(await readBody(req)) });
  }

  // "Hunt this look" on / off
  if (parts[1] === 'trends' && parts[2] === 'looks' && parts[4] === 'hunt' && method === 'POST') {
    const l = db.looks.find(x => x.id === parts[3]);
    if (!l) return send(res, 404, { error: 'Look not found' });
    l.huntAt = l.huntAt ? null : new Date().toISOString();
    save();
    return send(res, 200, { ok: true, hunting: !!l.huntAt, nextHunt: trendKeywords() });
  }

  if (parts[1] === 'trends' && method === 'GET' && !parts[2]) {
    const sort = (a, b) => b.at.localeCompare(a.at) || b.confidence - a.confidence;
    const looks = db.looks.filter(l => l.status === 'jacket').sort(sort);
    const maybe = db.looks.filter(l => l.status === 'maybe').sort(sort);
    return send(res, 200, { trends: db.trends, looks, maybe, pending: db.looks.filter(l => l.status === 'pending').length, nextHunt: trendKeywords() });
  }

  // Jacket check page: CLIP runs right here in the dashboard
  if (parts[1] === 'vision' && parts[2] === 'check' && method === 'POST') {
    const b = await readBody(req);
    const urls = (Array.isArray(b.urls) ? b.urls : list(b.urls)).map(String).filter(u => /^https?:\/\//i.test(u)).slice(0, 50);
    if (!urls.length) return send(res, 400, { error: 'Add at least one photo link (http/https)' });
    const results = [];
    for (const url of urls) {
      // A saved product photo is read from its local copy when there is one
      const owner = db.products.find(p => p.remoteImages.includes(url));
      const local = owner && owner.images[owner.remoteImages.indexOf(url)];
      let tmp = null;
      try {
        let source = local && local.startsWith('/media/') ? path.join(MEDIA_DIR, path.basename(local)) : null;
        if (!source) { tmp = path.join(DATA_DIR, `check-${crypto.randomBytes(6).toString('hex')}.img`); fs.writeFileSync(tmp, await fetchPublicImage(url)); source = tmp; }
        const { embedding, ...verdict } = await jacketVision.check(source); results.push({ url, ...verdict });
      } catch (e) { results.push({ url, error: 'Could not read this photo: ' + String(e.message).slice(0, 80) }); }
      finally { if (tmp) fs.rm(tmp, () => {}); }
    }
    return send(res, 200, { results });
  }

  if (parts[1] === 'hunt' && parts[2] === 'state' && method === 'GET') {
    if (!keyOk(req)) return send(res, 401, { error: 'Invalid ingestion key' });
    const run = db.runs.find(r => r.id === url.searchParams.get('runId'));
    return send(res, 200, { status: run ? run.status : 'unknown', stop: !run || run.status !== 'started' });
  }

  // Stop a hunt from the dashboard: it is marked stopped and anything it still sends is ignored
  if (parts[1] === 'hunt' && parts[3] === 'stop' && method === 'POST') {
    const run = db.runs.find(r => r.id === parts[2]);
    if (!run) return send(res, 404, { error: 'Hunt not found' });
    if (run.status !== 'started') return send(res, 200, runView(run));
    const now = new Date().toISOString();
    run.status = 'stopped'; run.finishedAt = now; run.updatedAt = now;
    run.steps = [...(run.steps || []), { name: 'Stopped', status: 'skipped', detail: `Stopped by ${me?.name || me?.username || 'you'}. Anything this hunt still sends is ignored.`, at: now }];
    save();
    F.users.log(me, 'stopped a hunt', run.id);
    broadcast('run', runView(run));
    return send(res, 200, runView(run));
  }

  if (parts[1] === 'hunt' && parts[2] === 'run' && method === 'POST') {
    const mode = (await readBody(req)).mode === 'trend' ? 'trend' : 'normal';
    const run = await startRun(mode, me);
    return send(res, run.status === 'failed' ? (run.code || 502) : 200, run);
  }

  if (parts[1] === 'stats' && method === 'GET') return send(res, 200, stats());
  return apiRest(req, res, url, me, parts, method);
}

// Start a hunt (button, schedule or re-run). Returns the run; status 'failed' with an error if it couldn't start.
let starting = false;
async function startRun(mode, me, reason = '') {
    const s = db.settings;
    const fail = (error, code = 400) => ({ status: 'failed', error, code });
    if (!s.n8nWebhookUrl) return fail('Set the n8n webhook URL in Hunt settings first');
    // mode "trend" = today's trend hunt: Google Trends top 5 topics -> Google Shopping, 10 jackets each
    if (mode === 'trend' && !s.serperKey) return fail("Today's trend hunt needs a Serper key - add it in Hunt settings");
    if (mode !== 'trend' && s.sources.includes('websites') && !s.websites.length && s.sources.length === 1) return fail('Add at least one website in Hunt settings (or switch on eBay / Etsy)');
    if (starting || db.runs.some(r => r.status === 'started')) return fail('A hunt is already running - wait for it to finish or stop it', 409);
    starting = true;
    const nowIso = new Date().toISOString();
    const run = { id: 'run_' + Date.now().toString(36), mode, startedAt: nowIso, updatedAt: nowIso, found: 0, status: 'started', steps: [{ name: 'Starting', status: 'done', detail: 'Sent to n8n', at: nowIso }],
      by: me ? (me.name || me.username) : reason || 'Schedule',
      settings: { minPrice: s.minPrice, maxPrice: s.maxPrice, sources: mode === 'trend' ? ['google_shopping'] : s.sources, websites: s.websites.length, markets: s.markets } };
    // registered first, so progress reports and jackets that arrive while we wait for n8n's answer are counted
    db.runs.push(run);
    db.runs = db.runs.slice(-50);
    save();
    broadcast('run', runView(run));
    try {
      const r = await fetch(s.n8nWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingestion-Key': INGEST_KEY },
        body: JSON.stringify({ ...publicSettings(), mode, serperKey: mode === 'trend' ? s.serperKey || '' : '', runId: run.id, dashboardUrl: s.dashboardUrlForN8n, trendKeywords: trendKeywords() }),
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) throw new Error(`n8n answered ${r.status}`);
    } catch (e) {
      // a timeout only means n8n is slow to answer; the hunt may well be running and will report in
      if (e.name === 'TimeoutError') run.steps.push({ name: 'Starting', status: 'done', detail: 'n8n is slow to answer; waiting for its first report', at: new Date().toISOString() });
      else {
        run.status = 'failed'; run.finishedAt = new Date().toISOString();
        run.error = /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(e.message) ? 'Could not reach n8n - check that n8n is running and the workflow is active' : /404/.test(e.message) ? 'n8n has no active Leather Hunt workflow - import it and switch it on' : e.message;
      }
    } finally { starting = false; }
    if (mode === 'trend' && run.status !== 'failed') db.settings.serperSearches = (num(db.settings.serperSearches) || 0) + 5;
    save();
    F.users.log(me, mode === 'trend' ? "started today's trend hunt" : 'started a hunt', reason);
    broadcast('run', runView(run));
    if (run.status === 'failed') F.ops.onRunEnd(run);
    return run;
}

async function apiRest(req, res, url, me, parts, method) {

  if (parts[1] === 'products') {
    if (!parts[2] && method === 'DELETE') {
      const source = url.searchParams.get('source');
      if (!source) return send(res, 400, { error: 'Pass ?source=ebay|etsy|website|all' });
      const removed = source === 'all' ? db.products : db.products.filter(p => p.source === source);
      db.products = source === 'all' ? [] : db.products.filter(p => p.source !== source);
      removeUnusedMedia(removed);
      save();
      return send(res, 200, { ok: true, removed: removed.length });
    }
    if (!parts[2] && method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      const all = filterProducts(q);
      const page = Math.max(1, num(q.page) || 1), size = Math.min(120, num(q.size) || 48);
      return send(res, 200, { total: all.length, page, pages: Math.max(1, Math.ceil(all.length / size)), items: all.slice((page - 1) * size, page * size).map(summary) });
    }
    // Bulk: { ids, status } or { ids, action: 'delete' }. Returns the previous statuses so the page can undo.
    if (parts[2] === 'bulk' && method === 'POST') {
      const b = await readBody(req);
      const need = b.action === 'delete' ? 'jackets.delete' : 'jackets.review';
      if (!F.users.can(me, need)) return send(res, 403, { error: `You don't have permission for this (${need.replace('.', ': ')}). Ask the owner.` });
      const ids = new Set((Array.isArray(b.ids) ? b.ids : []).map(Number));
      const chosen = db.products.filter(p => ids.has(p.id));
      const previous = chosen.map(p => ({ id: p.id, status: p.status }));
      if (b.action === 'delete') {
        db.products = db.products.filter(p => !ids.has(p.id));
        for (const p of chosen) db.rejected.push({ key: p.key, contentHash: p.contentHash, title: p.title, at: new Date().toISOString(), by: 'deleted' });
        trimRejected();
        removeUnusedMedia(chosen);
      } else if (Array.isArray(b.restore)) {
        for (const r of b.restore) { const p = db.products.find(x => x.id === Number(r.id)); if (p && ['new', 'approved', 'rejected'].includes(r.status)) { p.status = r.status; p.updatedAt = new Date().toISOString(); p.decidedAt = r.status === 'new' ? null : (r.decidedAt || p.updatedAt); } }
      } else {
        if (!['new', 'approved', 'rejected'].includes(b.status)) return send(res, 400, { error: 'Invalid status' });
        for (const p of chosen) { p.status = b.status; p.updatedAt = new Date().toISOString(); p.decidedAt = b.status === 'new' ? null : p.updatedAt; p.decidedBy = me?.name || me?.username; }
      }
      save();
      const verb = b.action === 'delete' ? 'deleted' : Array.isArray(b.restore) ? 'undid' : b.status === 'new' ? 'moved to New' : b.status;
      for (const p of chosen.slice(0, 50)) F.users.log(me, verb, p.title, { type: 'product', id: p.id });
      broadcast('status', { changes: b.action === 'delete' ? chosen.map(p => ({ id: p.id, deleted: true })) : chosen.map(p => ({ id: p.id, status: p.status })), by: me?.id });
      broadcast('stats');
      return send(res, 200, { ok: true, changed: chosen.length, previous });
    }
    const product = db.products.find(p => p.id === Number(parts[2]));
    if (!product) return send(res, 404, { error: 'Product not found' });
    if (!parts[3] && method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      const ordered = filterProducts(Object.keys(q).length ? q : { status: product.status, sort: 'score' });
      const i = ordered.findIndex(p => p.id === product.id);
      const intelOut = F.intel.enrich({}, product);
      const dupes = F.intel.dupesOf(product).map(x => ({ id: x.id, title: x.title, price: x.price, currency: x.currency, source: x.source, sourceDomain: x.sourceDomain, thumb: thumbOf(x.mainImage), status: x.status }));
      return send(res, 200, { ...product, ...intelOut, dupesList: dupes, watching: F.watch.watched(product), leather: leatherType(product), thumbs: product.images.map(thumbOf), similar: similarTo(product),
        prevId: i > 0 ? ordered[i - 1].id : null, nextId: i >= 0 && i < ordered.length - 1 ? ordered[i + 1].id : null, position: i + 1, of: ordered.length });
    }
    if (parts[3] === 'status' && method === 'POST') {
      const { status } = await readBody(req);
      if (!['new', 'approved', 'rejected'].includes(status)) return send(res, 400, { error: 'Invalid status' });
      const previous = product.status;
      product.status = status;
      product.updatedAt = new Date().toISOString();
      product.decidedAt = status === 'new' ? null : product.updatedAt;
      product.decidedBy = me?.name || me?.username;
      save();
      F.users.log(me, status === 'new' ? 'moved to New' : status, product.title, { type: 'product', id: product.id });
      broadcast('status', { changes: [{ id: product.id, status }], by: me?.id });
      broadcast('stats');
      return send(res, 200, { ...product, previous });
    }
    if (parts[3] === 'note' && method === 'POST') {
      product.note = str((await readBody(req)).note).slice(0, 2000);
      product.updatedAt = new Date().toISOString();
      save();
      F.users.log(me, 'edited the note', product.title, { type: 'product', id: product.id });
      broadcast('product', { id: product.id, note: product.note, by: me?.id });
      return send(res, 200, { ok: true, note: product.note });
    }
    if (parts[3] === 'photos.zip' && method === 'GET') {
      const { slug, buffer } = await photosZip(product);
      if (!buffer) return send(res, 404, { error: 'No photos could be read for this jacket' });
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${slug}-photos.zip"`, 'Content-Length': buffer.length });
      return res.end(buffer);
    }
    if (!parts[3] && method === 'DELETE') {
      db.products = db.products.filter(p => p.id !== product.id);
      db.rejected.push({ key: product.key, contentHash: product.contentHash, title: product.title, at: new Date().toISOString(), by: 'deleted' });
      trimRejected();
      F.users.log(me, 'deleted', product.title);
      broadcast('status', { changes: [{ id: product.id, deleted: true }], by: me?.id });
      removeUnusedMedia([product]);
      save();
      broadcast('stats');
      return send(res, 200, { ok: true });
    }
  }

  send(res, 404, { error: 'Not found' });
}

function serveMedia(res, pathname) {
  const target = path.join(MEDIA_DIR, path.basename(pathname));
  fs.readFile(target, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    const type = Object.entries(IMAGE_EXT).find(([, e]) => target.endsWith(e));
    res.writeHead(200, { 'Content-Type': type ? type[0] : 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.end(data);
  });
}

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        res.writeHead(e2 ? 404 : 200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(html || 'Not found');
      });
    }
    // The page shell and service worker always revalidate so updates show up straight away
    const fresh = /\.(html|webmanifest|js|css)$/.test(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': fresh ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  });
}

// Bring products saved before hash dedupe onto SHA-256 keys, merging any duplicates found
{
  const merged = [];
  let changed = false;
  for (const p of db.products) {
    // hashes v2 (photo identity, see imageId); only the listing's own key may merge two records
    if (!p.contentHash || !p.hashV2) { const h = hashes(p); p.key ||= h.key; p.contentHash = h.contentHash; p.hashV2 = true; changed = true; }
    const dup = merged.find(x => x.key === p.key);
    if (dup) { if (dup.status === 'new' && p.status !== 'new') dup.status = p.status; changed = true; continue; }
    merged.push(p);
  }
  if (changed) {
    console.log(`Hash migration: ${db.products.length} -> ${merged.length} products`);
    db.products = merged;
    save();
  }
}

// ---------- routes that use a key or no login ----------
// The page shell and board share links are public; data (/api, /media, /thumbs) needs a login.
// n8n's endpoints use the ingestion key instead.
const KEY_ROUTES = ['/api/ingest', '/api/known', '/api/trends/ingest', '/api/hunt/progress', '/api/hunt/state', '/api/watch/due', '/api/watch/report'];
const OPEN_ROUTES = ['/api/session', '/api/login', '/api/logout'];
const needsLogin = p => (p.startsWith('/api/') && !KEY_ROUTES.includes(p) && !OPEN_ROUTES.includes(p)) || p.startsWith('/media/') || p.startsWith('/thumbs/');

// Grid thumbnails: 480px wide WebP, made once with sharp (comes with the CLIP package)
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
fs.mkdirSync(THUMB_DIR, { recursive: true });
const thumbsMaking = new Map();
function makeThumb(src, out) {
  if (!thumbsMaking.has(out)) {
    const tmp = out + '.' + process.pid + '.tmp';
    thumbsMaking.set(out, require('sharp')(src).rotate().resize({ width: 480, withoutEnlargement: true }).webp({ quality: 78 }).toFile(tmp)
      .then(() => fs.renameSync(tmp, out))
      .catch(e => { try { fs.unlinkSync(tmp); } catch {} throw e; })
      .finally(() => thumbsMaking.delete(out)));
  }
  return thumbsMaking.get(out);
}
async function serveThumbFile(res, name) {
  const src = path.join(MEDIA_DIR, name), out = path.join(THUMB_DIR, name.replace(/\.[a-z0-9]+$/i, '') + '.webp');
  try {
    if (!fs.existsSync(out)) await makeThumb(src, out);
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000, immutable' });
    fs.createReadStream(out).pipe(res);
  } catch { serveMedia(res, '/media/' + name); } // fall back to the full photo
}
const serveThumb = (res, pathname) => serveThumbFile(res, path.basename(pathname));

// ---------- feature modules (lib/*) share one context ----------
const ctx = {
  get db() { return db; }, save, flush, exportJson, USE_PG, freeze, unfreeze, onFreeze: f => freezeHooks.push(f), broadcast, send, readBody, str, num, list, sha256,
  DATA_DIR, MEDIA_DIR, INGEST_KEY, keyOk, PUBLIC_URL, jacketVision, vision,
  leatherType, thumbOf, summary: p => summary(p), filterProducts: q => filterProducts(q), serveThumbFile,
  startRun: (...a) => startRun(...a),
  can: (...a) => F.users.can(...a), log: (...a) => F.users.log(...a), notify: (...a) => F.users.notify(...a), removeUnusedMedia, trimRejected, sharp: (...a) => require('sharp')(...a), fetchPublicImage,
  get intel() { return F.intel; }, get watch() { return F.watch; }
};
F.users = require('./lib/users')(ctx);
F.intel = require('./lib/intel')(ctx);
F.watch = require('./lib/watch')(ctx);
F.boards = require('./lib/boards')(ctx);
F.ops = require('./lib/ops')(ctx);
F.insights = require('./lib/insights')(ctx);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (OPEN_ROUTES.includes(url.pathname)) return await F.users.auth(req, res, url);
    if (url.pathname.startsWith('/s/')) return F.boards.serveShare(req, res, url);
    const me = F.users.currentUser(req);
    if (needsLogin(url.pathname) && !me) return send(res, 401, { error: 'login' });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url, me);
    if (url.pathname.startsWith('/media/')) return serveMedia(res, url.pathname);
    if (url.pathname.startsWith('/thumbs/')) return await serveThumb(res, url.pathname);
    serveStatic(res, url.pathname);
  } catch (e) {
    const expected = /^(Body too large|Invalid JSON)$/.test(e && e.message);
    if (!expected) console.error('Request failed', req.method, url.pathname, e && e.stack || e);
    if (!res.headersSent) send(res, expected ? 400 : 500, { error: expected ? e.message : 'Something went wrong on the server. Please try again.' });
    else try { res.destroy(); } catch {}
  }
}).listen(PORT, () => console.log(`Morrow Studio dashboard on http://localhost:${PORT}`));
