// Boards (collections) with read-only share links, comments with @mentions, CSV / Google Sheets export,
// and "send to Shopify as a draft" (uses your own store's free Admin API).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function boards(ctx) {
  const { send, readBody, str, num } = ctx;
  const db = () => ctx.db;
  db().boards ||= [];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- CSV ----------
  const COLS = [['id', p => p.id], ['title', p => p.title], ['status', p => p.status], ['price', p => p.price], ['currency', p => p.currency], ['source', p => p.source === 'website' ? p.sourceDomain : p.source],
    ['colour', p => p.visionColor], ['style', p => p.visionStyle], ['leather', p => ctx.leatherType(p)], ['gender', p => p.gender], ['score', p => p.score],
    ['profit', p => ctx.intel.profitOf(p)?.profit], ['margin_%', p => ctx.intel.profitOf(p)?.margin], ['best_seller', p => p.isBestseller ? 'yes' : ''], ['trend_topic', p => p.trendTopic],
    ['note', p => p.note], ['link', p => p.link], ['photo', p => p.remoteImages[0] || ''], ['found', p => p.createdAt]];
  const cell = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = (list, cols = COLS) => '﻿' + [cols.map(c => c[0]).join(','), ...list.map(p => cols.map(c => cell(c[1](p))).join(','))].join('\n');
  // what someone you share a board with may see: no costs, profit, margin, score, status or private notes
  const SHARE_COLS = COLS.filter(c => ['title', 'price', 'currency', 'colour', 'style', 'leather', 'gender', 'link', 'photo'].includes(c[0]));

  // ---------- public share page (read only, no login) ----------
  function sharePage(b, items) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(b.name)} · Morrow Studio</title><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#f6f2ea;--s:#fffdf9;--l:#e4dccd;--t:#1d1915;--m:#7c7265;--g:#a9823a}
@media (prefers-color-scheme:dark){:root{--bg:#0f0e0c;--s:#181614;--l:#2c2823;--t:#efe9df;--m:#948a7d;--g:#d9b874}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:15px/1.5 Inter,system-ui,sans-serif}
header{padding:32px 20px 8px;max-width:1200px;margin:auto}h1{font:700 40px 'Cormorant Garamond',serif;margin:0}
.sub{color:var(--m)}main{max-width:1200px;margin:auto;padding:16px 20px 60px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
.c{background:var(--s);border:1px solid var(--l);border-radius:16px;overflow:hidden;display:flex;flex-direction:column}
.c img{width:100%;aspect-ratio:4/5;object-fit:cover;background:#ddd}.b{padding:12px 14px;display:grid;gap:6px}
.p{font:700 22px 'Cormorant Garamond',serif}.m{color:var(--m);font-size:13px}a{color:var(--g)}
footer{text-align:center;color:var(--m);font-size:13px;padding:0 0 40px}
</style></head><body>
<header><div class="sub">Shared board</div><h1>${esc(b.name)}</h1><div class="sub">${items.length} jackets${b.note ? ' · ' + esc(b.note) : ''}</div></header>
<main>${items.map(p => `<article class="c"><img src="/s/${b.shareToken}/img/${p.id}" alt="" loading="lazy">
<div class="b"><div>${esc(p.title)}</div><div class="p">${p.price === null ? '—' : esc(p.price + ' ' + p.currency)}</div>
<div class="m">${esc([p.visionColor, p.visionStyle, ctx.leatherType(p)].filter(Boolean).join(' · '))}</div></div></article>`).join('')}</main>
<footer>Made with Morrow Studio · <a href="/s/${b.shareToken}.csv">Download CSV</a></footer></body></html>`;
  }

  // GET /s/<token> (page), /s/<token>.csv (CSV, works with Google Sheets =IMPORTDATA), /s/<token>/img/<productId>
  function serveShare(req, res, url) {
    const m = url.pathname.match(/^\/s\/([a-f0-9]{24})(\.csv)?(?:\/img\/(\d+))?$/);
    const b = m && db().boards.find(x => x.shareToken === m[1]);
    if (!b) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('This share link is off or does not exist.'); }
    const items = b.productIds.map(id => db().products.find(p => p.id === id)).filter(Boolean);
    if (m[3]) {
      const p = items.find(x => x.id === Number(m[3]));
      const img = p?.images[0];
      if (!img) { res.writeHead(404); return res.end(); }
      if (!img.startsWith('/media/')) { res.writeHead(302, { Location: img }); return res.end(); }
      return ctx.serveThumbFile(res, path.basename(img));
    }
    if (m[2]) { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(csv(items, SHARE_COLS)); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    return res.end(sharePage(b, items));
  }

  const boardView = b => ({ ...b, count: b.productIds.length, covers: b.productIds.slice(0, 4).map(id => db().products.find(p => p.id === id)).filter(Boolean).map(p => ctx.thumbOf(p.mainImage)), shareUrl: b.shareToken ? `${ctx.PUBLIC_URL || ''}/s/${b.shareToken}` : null });

  // ---------- Shopify draft ----------
  async function toShopify(p, me) {
    const s = db().settings.shopify || {};
    if (!s.domain || !s.token) throw new Error('Add your Shopify store and Admin API token in Settings first');
    const images = [];
    for (const img of p.images.slice(0, 10)) {
      if (img.startsWith('/media/')) {
        try {
          const file = path.join(ctx.MEDIA_DIR, path.basename(img));
          let buf;
          try { buf = await ctx.sharp(file).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer(); }
          catch { buf = fs.readFileSync(file); }
          images.push({ attachment: buf.toString('base64') });
        } catch {}
      }
      else images.push({ src: img });
    }
    const pr = ctx.intel.profitOf(p);
    const body = { product: {
      title: p.title, status: 'draft', product_type: 'Leather Jacket', vendor: s.vendor || 'Morrow',
      tags: ['morrow-studio', p.visionColor, p.visionStyle, ctx.leatherType(p), p.gender, p.trendTopic].filter(Boolean).join(', '),
      body_html: `<p>${esc(p.description || '').slice(0, 4000).replace(/\n/g, '<br>')}</p>`,
      variants: [{ price: String(pr?.sell ?? p.price ?? 0), inventory_management: null }],
      images
    } };
    const domain = s.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const r = await fetch(`https://${domain}/admin/api/2025-01/products.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': s.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Shopify said ${r.status}: ${JSON.stringify(d.errors || d).slice(0, 200)}`);
    p.shopify = { id: d.product.id, at: new Date().toISOString(), url: `https://${domain}/admin/products/${d.product.id}` };
    ctx.save();
    ctx.log(me, 'sent to Shopify', p.title, { type: 'product', id: p.id });
    return p.shopify;
  }

  async function handle(req, res, url, parts, me) {
    const method = req.method;
    const write = () => ctx.can(me, 'boards.edit') || (send(res, 403, { error: "You don't have permission to change boards" }), false);

    if (parts[1] === 'export.csv' && method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      const list = q.board ? (db().boards.find(b => b.id === q.board)?.productIds || []).map(id => db().products.find(p => p.id === id)).filter(Boolean) : ctx.filterProducts(q);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="morrow-studio-${new Date().toISOString().slice(0, 10)}.csv"` });
      res.end(csv(list));
      return true;
    }

    if (parts[1] === 'boards') {
      const view = b => { const v = boardView(b); if (!ctx.can(me, 'boards.share')) { delete v.shareToken; delete v.shareUrl; v.shared = !!b.shareToken; } return v; };
      if (method === 'GET' && !parts[2]) return send(res, 200, { boards: db().boards.map(view) }), true;
      if (method === 'GET' && parts[2]) {
        const b = db().boards.find(x => x.id === parts[2]);
        if (!b) return send(res, 404, { error: 'Board not found' }), true;
        return send(res, 200, { ...view(b), items: b.productIds.map(id => db().products.find(p => p.id === id)).filter(Boolean).map(ctx.summary) }), true;
      }
      if (!write()) return true;
      if (method === 'POST' && !parts[2]) {
        const b0 = await readBody(req);
        const b = { id: crypto.randomBytes(5).toString('hex'), name: str(b0.name).slice(0, 60) || 'New board', note: str(b0.note).slice(0, 200), color: str(b0.color) || '#c9a45c', productIds: [], shareToken: null, by: me.name || me.username, at: new Date().toISOString() };
        db().boards.push(b); ctx.save(); ctx.log(me, 'created a board', b.name);
        return send(res, 200, boardView(b)), true;
      }
      const b = db().boards.find(x => x.id === parts[2]);
      if (!b) return send(res, 404, { error: 'Board not found' }), true;
      if (method === 'PUT') {
        const x = await readBody(req);
        if (x.share !== undefined && !ctx.can(me, 'boards.share')) return send(res, 403, { error: "You don't have permission to share boards" }), true;
        if (x.name !== undefined) b.name = str(x.name).slice(0, 60) || b.name;
        if (x.note !== undefined) b.note = str(x.note).slice(0, 200);
        if (Array.isArray(x.add)) { for (const id of x.add.map(Number)) if (!b.productIds.includes(id) && db().products.some(p => p.id === id)) b.productIds.push(id); ctx.log(me, 'added to board', `${x.add.length} → ${b.name}`); }
        if (Array.isArray(x.remove)) b.productIds = b.productIds.filter(id => !x.remove.map(Number).includes(id));
        if (x.share === true && !b.shareToken) b.shareToken = crypto.randomBytes(12).toString('hex');
        if (x.share === false) b.shareToken = null;
        ctx.save();
        ctx.broadcast('boards', {});
        return send(res, 200, boardView(b)), true;
      }
      if (method === 'DELETE') { db().boards = db().boards.filter(x => x.id !== b.id); ctx.save(); ctx.log(me, 'deleted a board', b.name); return send(res, 200, { ok: true }), true; }
    }

    // comments + @mentions
    if (parts[1] === 'products' && parts[3] === 'comments') {
      const p = db().products.find(x => x.id === Number(parts[2]));
      if (!p) return send(res, 404, { error: 'Product not found' }), true;
      if (method === 'GET') return send(res, 200, { comments: p.comments || [] }), true;
      if (method === 'POST') {
        const text = str((await readBody(req)).text).slice(0, 1500);
        if (!text) return send(res, 400, { error: 'Write something first' }), true;
        const c = { id: crypto.randomBytes(5).toString('hex'), uid: me.id, by: me.name || me.username, text, at: new Date().toISOString() };
        p.comments = [...(p.comments || []), c];
        ctx.save();
        const mentioned = [...new Set([...text.matchAll(/@([a-z0-9._-]+)/gi)].map(m => m[1].toLowerCase()))];
        const ids = db().users.filter(u => mentioned.includes(u.username) && u.id !== me.id).map(u => u.id);
        if (ids.length) ctx.notify(ids, 'mentions', `💬 ${c.by} mentioned you on “${p.title}”: ${text.slice(0, 160)}`, `#/product/${p.id}`);
        ctx.log(me, 'commented', text.slice(0, 120), { type: 'product', id: p.id });
        ctx.broadcast('product', { id: p.id, comments: p.comments.length });
        return send(res, 200, c), true;
      }
      if (method === 'DELETE' && parts[4]) {
        const c = (p.comments || []).find(x => x.id === parts[4]);
        if (!c) return send(res, 404, { error: 'Comment not found' }), true;
        if (c.uid !== me.id && !ctx.can(me, 'owner')) return send(res, 403, { error: 'You can only delete your own comments' }), true;
        p.comments = p.comments.filter(x => x.id !== c.id); ctx.save();
        return send(res, 200, { ok: true }), true;
      }
    }

    if (parts[1] === 'products' && parts[3] === 'shopify' && method === 'POST') {
      if (!ctx.can(me, 'shopify.push')) return send(res, 403, { error: "You don't have permission to send to Shopify" }), true;
      const p = db().products.find(x => x.id === Number(parts[2]));
      if (!p) return send(res, 404, { error: 'Product not found' }), true;
      try { return send(res, 200, await toShopify(p, me)), true; }
      catch (e) { return send(res, 400, { error: e.message }), true; }
    }
    return false;
  }

  return { handle, serveShare };
};
