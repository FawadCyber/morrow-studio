// Insight: trend timeline (what's rising), competitor tracker, market price bands, weekly report.
module.exports = function insights(ctx) {
  const { send } = ctx;
  const db = () => ctx.db;
  db().trendHistory ||= [];
  const DAY = 864e5;
  const monday = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  // local calendar date (not UTC) so weeks start on your Monday
  const ymd = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const pct = (a, b) => b ? Math.round((a - b) / b * 100) : a ? 100 : 0;
  const quant = (arr, q) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const i = (s.length - 1) * q; const lo = Math.floor(i); return Math.round(s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo)); };

  function timeline() {
    const ps = db().products, thisWeek = monday(Date.now());
    const weeks = Array.from({ length: 12 }, (_, i) => thisWeek - (11 - i) * 7 * DAY);
    const series = key => {
      const values = [...new Set(ps.map(key).filter(Boolean))];
      return values.map(v => ({ value: v, weeks: weeks.map(w => ps.filter(p => key(p) === v && Date.parse(p.createdAt) >= w && Date.parse(p.createdAt) < w + 7 * DAY).length) }))
        .map(s => ({ ...s, total: s.weeks.reduce((a, b) => a + b, 0), recent: s.weeks.slice(-4).reduce((a, b) => a + b, 0), before: s.weeks.slice(-8, -4).reduce((a, b) => a + b, 0) }))
        .map(s => ({ ...s, change: pct(s.recent, s.before) }))
        .sort((a, b) => b.recent - a.recent).slice(0, 8);
    };
    const approvedShare = key => {
      const out = {};
      for (const p of ps.filter(x => x.status !== 'new')) { const k = key(p); if (!k) continue; out[k] ||= { a: 0, n: 0 }; out[k].n++; if (p.status === 'approved') out[k].a++; }
      return Object.entries(out).map(([value, x]) => ({ value, rate: Math.round(x.a / x.n * 100), n: x.n })).sort((a, b) => b.rate - a.rate);
    };
    return {
      weeks: weeks.map(w => ymd(w)),
      styles: series(p => p.visionStyle), colors: series(p => p.visionColor), leathers: series(p => ctx.leatherType(p)),
      approvedStyles: approvedShare(p => p.visionStyle), approvedColors: approvedShare(p => p.visionColor),
      topics: db().trendHistory.slice(-30)
    };
  }

  function competitors() {
    const by = {};
    for (const p of db().products) {
      const name = p.source === 'website' ? p.sourceDomain : p.source === 'google_shopping' ? (p.sourceDomain || 'Google Shopping') : p.sellerName ? `${p.sellerName} (${p.source === 'ebay' ? 'eBay' : 'Etsy'})` : null;
      if (!name) continue;
      (by[name] ||= []).push(p);
    }
    const week = Date.now() - 7 * DAY;
    return Object.entries(by).map(([name, ps]) => {
      const priced = ps.filter(p => p.price !== null).map(p => p.price);
      const changes = ps.filter(p => (p.priceHistory || []).length > 1);
      return {
        name, kind: ps[0].source, total: ps.length,
        newWeek: ps.filter(p => Date.parse(p.createdAt) >= week).length,
        approved: ps.filter(p => p.status === 'approved').length,
        bestSellers: ps.filter(p => p.isBestseller).length,
        avgPrice: priced.length ? Math.round(priced.reduce((a, b) => a + b, 0) / priced.length) : null,
        currency: ps[0].currency,
        priceChanges: changes.length,
        drops: changes.filter(p => p.priceHistory.at(-1).price < p.priceHistory[0].price).length,
        soldOut: ps.filter(p => p.watch?.available === false).length,
        latest: ps.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4).map(p => ({ id: p.id, title: p.title, price: p.price, currency: p.currency, thumb: ctx.thumbOf(p.mainImage) }))
      };
    }).sort((a, b) => b.total - a.total).slice(0, 40);
  }

  function priceBands() {
    const group = (key) => {
      const out = {};
      for (const p of db().products.filter(x => x.price !== null)) {
        const k = key(p); if (!k) continue;
        const usd = p.price * (db().settings.profit?.fx?.[p.currency] ?? 1);
        (out[k] ||= []).push(usd);
      }
      return Object.entries(out).filter(([, v]) => v.length >= 2).map(([value, v]) => ({ value, n: v.length, min: Math.round(Math.min(...v)), p25: quant(v, 0.25), median: quant(v, 0.5), p75: quant(v, 0.75), max: Math.round(Math.max(...v)) })).sort((a, b) => b.n - a.n);
    };
    return { currency: 'USD', styles: group(p => p.visionStyle), leathers: group(p => ctx.leatherType(p)), markets: group(p => p.market || (p.source === 'etsy' || p.source === 'google_shopping' ? 'US' : '')), genders: group(p => p.gender) };
  }

  function weekly(start) {
    const from = start ? monday(Date.parse(start)) : monday(Date.now()), to = from + 7 * DAY;
    const inWeek = t => { const x = Date.parse(t); return x >= from && x < to; };
    const ps = db().products;
    const found = ps.filter(p => inWeek(p.createdAt));
    const decided = ps.filter(p => p.status !== 'new' && inWeek(p.decidedAt || p.updatedAt));
    const approved = decided.filter(p => p.status === 'approved');
    const runs = db().runs.filter(r => inWeek(r.startedAt));
    const acts = db().activity.filter(a => inWeek(a.at));
    const tally = (list, key) => { const o = {}; for (const p of list) { const k = key(p); if (k) o[k] = (o[k] || 0) + 1; } return Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([value, n]) => ({ value, n })); };
    const people = {};
    for (const a of acts.filter(a => ['approved', 'rejected', 'status'].some(k => a.action.includes(k)))) people[a.user] = (people[a.user] || 0) + 1;
    return {
      from: ymd(from), to: ymd(to - DAY),
      found: found.length, approved: approved.length, rejected: decided.length - approved.length,
      approvalRate: decided.length ? Math.round(approved.length / decided.length * 100) : null,
      hunts: runs.length, failedHunts: runs.filter(r => r.status === 'failed').length,
      priceDrops: acts.filter(a => a.action === 'price drop').length,
      topApproved: approved.sort((a, b) => (ctx.intel.profitOf(b)?.profit ?? 0) - (ctx.intel.profitOf(a)?.profit ?? 0)).slice(0, 6).map(ctx.summary),
      topFound: found.sort((a, b) => b.score - a.score).slice(0, 6).map(ctx.summary),
      sources: tally(found, p => p.source), styles: tally(found, p => p.visionStyle), colors: tally(found, p => p.visionColor),
      reviewers: Object.entries(people).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n)
    };
  }

  // keep one snapshot of Google Trends topics per day (called when the hunt sends trends)
  function recordTrends(t) {
    const day = ymd(Date.now());
    const rising = Object.values(t.markets || {}).flatMap(m => (m.rising || []).map(r => r.query)).slice(0, 15);
    const top = Object.values(t.markets || {}).flatMap(m => (m.top || []).map(r => r.query)).slice(0, 15);
    const h = db().trendHistory.filter(x => x.day !== day);
    h.push({ day, rising: [...new Set(rising)], top: [...new Set(top)] });
    db().trendHistory = h.slice(-120);
  }

  async function handle(req, res, url, parts) {
    if (req.method !== 'GET' || parts[1] !== 'insights' || !parts[2]) return false;
    if (parts[2] === 'timeline') return send(res, 200, timeline()), true;
    if (parts[2] === 'competitors') return send(res, 200, { items: competitors() }), true;
    if (parts[2] === 'prices') return send(res, 200, priceBands()), true;
    if (parts[2] === 'weekly') return send(res, 200, weekly(url.searchParams.get('week'))), true;
    return false;
  }
  return { handle, recordTrends };
};
