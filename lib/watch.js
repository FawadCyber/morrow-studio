// Price-drop and restock watcher for approved (or "watched") jackets.
//  - shop websites: checked here, straight from the product page (JSON-LD / Shopify .js)
//  - eBay + Etsy: the free "Leather Hunt Watch" n8n workflow asks /api/watch/due and reports to /api/watch/report
const EVERY_MS = 6 * 3600 * 1000;

module.exports = function watch(ctx) {
  const { send, readBody, num, str } = ctx;
  const db = () => ctx.db;
  const status = { busy: false, lastRunAt: null, checked: 0, errors: 0 };

  const watched = p => p.watchOn === true || (p.watchOn !== false && p.status === 'approved');
  const due = p => watched(p) && Date.now() - Date.parse(p.watch?.lastAt || 0) > EVERY_MS;

  // apply a fresh reading; alerts for price drops, sell-outs and restocks
  function apply(p, r) {
    const before = { price: p.price, available: p.watch?.available };
    p.watch = { ...(p.watch || {}), lastAt: new Date().toISOString(), error: r.error || '' };
    if (r.error) { ctx.save(); return; }
    if (r.available !== undefined && r.available !== null) p.watch.available = !!r.available;
    let price = num(r.price);
    p.watch.note = '';
    if (price !== null && r.currency && p.currency && r.currency !== String(p.currency).toUpperCase()) {
      p.watch.note = `The shop now shows ${r.currency} instead of ${p.currency}, so the price was not compared`;
      price = null;
    } else if (price !== null && p.price && (price < p.price * 0.35 || price > p.price * 3)) {
      p.watch.note = `The shop shows ${price} (was ${p.price}). That's a very big change - probably a different size, set or currency - so it was not counted. Check the page by hand.`;
      price = null;
    }
    if (price !== null && price > 0 && price !== p.price) {
      p.priceHistory = [...(p.priceHistory || (p.price !== null ? [{ at: p.createdAt, price: p.price }] : [])), { at: p.watch.lastAt, price }].slice(-30);
      p.price = price;
      if (before.price && price < before.price * 0.97) {
        const pct = Math.round((1 - price / before.price) * 100);
        ctx.notify('all', 'prices', `💸 Price drop −${pct}%: ${p.title} — ${before.price} → ${price} ${p.currency}`, `#/product/${p.id}`);
        ctx.log(null, 'price drop', `${p.title}: ${before.price} → ${price}`, { type: 'product', id: p.id });
      }
    }
    if (before.available === true && p.watch.available === false) ctx.notify('all', 'prices', `⚠️ Sold out: ${p.title}`, `#/product/${p.id}`);
    if (before.available === false && p.watch.available === true) ctx.notify('all', 'prices', `✅ Back in stock: ${p.title}`, `#/product/${p.id}`);
    ctx.intel.recordMetrics(p, r);
    ctx.save();
    ctx.broadcast('product', { id: p.id, price: p.price, watch: p.watch });
  }

  // read price + stock from a shop's product page
  async function readWebsite(p) {
    const link = p.link.split('?')[0];
    if (/\/products\/[^/]+$/.test(link)) { // Shopify: <product>.js
      const r = await fetch(link + '.js', { signal: AbortSignal.timeout(15000) });
      if (r.ok && /json/.test(r.headers.get('content-type') || '')) {
        const d = await r.json();
        return { price: d.price ? d.price / 100 : null, available: d.available, currency: r.headers.get('x-shop-currency') || null };
      }
    }
    const r = await fetch(p.link, { signal: AbortSignal.timeout(15000) });
    if (r.status === 404 || r.status === 410) return { available: false };
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const html = await r.text();
    if (/sgcaptcha|cf-chl|captcha/i.test(html) && html.length < 20000) return { error: 'Blocked by a bot check' };
    let price = null, available = null, reviews = null, currency = null;
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const walk = o => {
          if (!o || typeof o !== 'object') return;
          if (Array.isArray(o)) return o.forEach(walk);
          if (/Product/i.test(String(o['@type']))) {
            const offers = [].concat(o.offers || []).flatMap(x => x.offers ? [].concat(x.offers) : [x]);
            const prices = offers.map(x => num(x.price ?? x.lowPrice)).filter(x => x !== null);
            if (prices.length) price = Math.min(...prices);
            const cur = offers.map(x => x.priceCurrency).find(Boolean);
            if (cur) currency = String(cur).toUpperCase();
            const av = offers.map(x => String(x.availability || '')).filter(Boolean);
            if (av.length) available = av.some(a => /InStock|PreOrder|LimitedAvailability/i.test(a));
            if (o.aggregateRating?.reviewCount) reviews = num(o.aggregateRating.reviewCount);
          }
          Object.values(o).forEach(walk);
        };
        walk(JSON.parse(m[1].trim()));
      } catch {}
    }
    if (price === null) price = num((html.match(/property=["'](?:product:price:amount|og:price:amount)["'][^>]*content=["']([\d.]+)/i) || [])[1]);
    if (available === null) { const a = (html.match(/property=["']product:availability["'][^>]*content=["']([^"']+)/i) || [])[1]; if (a) available = /in ?stock/i.test(a); }
    if (!currency) currency = ((html.match(/property=["'](?:product:price:currency|og:price:currency)["'][^>]*content=["']([A-Z]{3})/i) || [])[1] || '').toUpperCase() || null;
    return { price, available, reviews, currency };
  }

  async function runWebsites() {
    if (status.busy) return;
    status.busy = true;
    try {
      for (const p of db().products.filter(x => x.source === 'website' && due(x)).slice(0, 25)) {
        try { apply(p, await readWebsite(p)); status.checked++; } catch (e) { apply(p, { error: e.message.slice(0, 120) }); status.errors++; }
        await new Promise(r => setTimeout(r, 3000)); // polite gap
      }
    } finally { status.busy = false; status.lastRunAt = new Date().toISOString(); }
  }
  setInterval(runWebsites, 10 * 60 * 1000);
  setTimeout(runWebsites, 60 * 1000);

  async function handle(req, res, url, parts, me) {
    // n8n (key): which eBay / Etsy jackets need a fresh look
    if (parts[1] === 'watch' && parts[2] === 'due' && req.method === 'GET') {
      if (!ctx.keyOk(req)) return send(res, 401, { error: 'Invalid ingestion key' }), true;
      const items = db().products.filter(p => ['ebay', 'etsy'].includes(p.source) && due(p)).slice(0, 100)
        .map(p => ({ id: p.id, source: p.source, sourceId: p.sourceId, market: p.market }));
      return send(res, 200, { ebay: items.filter(i => i.source === 'ebay'), etsy: items.filter(i => i.source === 'etsy') }), true;
    }
    if (parts[1] === 'watch' && parts[2] === 'report' && req.method === 'POST') {
      if (!ctx.keyOk(req)) return send(res, 401, { error: 'Invalid ingestion key' }), true;
      const b = await readBody(req);
      let n = 0;
      for (const r of [].concat(b.items || b)) { const p = db().products.find(x => x.id === Number(r.id)); if (p) { apply(p, r); n++; } }
      return send(res, 200, { ok: true, updated: n }), true;
    }
    if (parts[1] === 'products' && parts[3] === 'watch' && req.method === 'POST') {
      if (!ctx.can(me, 'jackets.edit')) return send(res, 403, { error: "You don't have permission to edit jackets" }), true;
      const p = db().products.find(x => x.id === Number(parts[2]));
      if (!p) return send(res, 404, { error: 'Product not found' }), true;
      const b = await readBody(req);
      if (b.on !== undefined) p.watchOn = !!b.on;
      if (b.now && p.source === 'website') { try { apply(p, await readWebsite(p)); } catch (e) { apply(p, { error: e.message }); } }
      ctx.save();
      return send(res, 200, { watching: watched(p), watch: p.watch || null, price: p.price, priceHistory: p.priceHistory }), true;
    }
    return false;
  }

  return { handle, status, watched };
};
