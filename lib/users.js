// Users, roles, sessions, activity log and in-app notifications.
// Roles: owner (everything), reviewer (review, hunt, boards, notes), viewer (look + comment).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('./perms');

module.exports = function users(ctx) {
  const { send, readBody, str } = ctx;
  const db = () => ctx.db;
  db().users ||= [];
  db().activity ||= [];
  db().notifications ||= [];

  // ---------- passwords ----------
  const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') });
  const verify = (pw, u) => { const h = crypto.scryptSync(String(pw), u.salt, 64); const want = Buffer.from(u.hash, 'hex'); return h.length === want.length && crypto.timingSafeEqual(h, want); };

  // First start after this update: the existing admin login becomes the owner account
  if (!db().users.length && process.env.DASHBOARD_PASSWORD) {
    db().users.push({ id: 1, username: process.env.DASHBOARD_USER || 'admin', name: 'Owner', role: 'owner', ...hash(process.env.DASHBOARD_PASSWORD), sv: 1, createdAt: new Date().toISOString(), alerts: { hunts: true, prices: true, mentions: true, daily: true } });
    ctx.save();
  }
  const loginRequired = () => db().users.length > 0;

  // ---------- sessions (signed cookie) ----------
  const SECRET = (() => {
    const f = path.join(ctx.DATA_DIR, '.session-secret');
    try { return fs.readFileSync(f, 'utf8'); } catch { const s = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, s, { mode: 0o600 }); return s; }
  })();
  const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  function makeSession(u, remember) {
    const exp = Date.now() + (remember ? 30 : 1) * 864e5;
    const body = Buffer.from(JSON.stringify({ id: u.id, sv: u.sv, exp })).toString('base64url');
    return { token: body + '.' + sign(body), maxAge: remember ? 30 * 86400 : null };
  }
  function currentUser(req) {
    if (!loginRequired()) {
      const local = !req.headers['x-forwarded-for'] && /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '');
      return local ? { id: 0, username: 'local', name: 'You', role: 'owner' } : null;
    }
    const m = String(req.headers.cookie || '').match(/(?:^|;\s*)lh_session=([^;]+)/);
    if (!m) return null;
    const [body, mac] = m[1].split('.');
    if (!body || !mac || !same(mac, sign(body))) return null;
    try {
      const s = JSON.parse(Buffer.from(body, 'base64url').toString());
      const u = db().users.find(x => x.id === s.id);
      return u && s.exp > Date.now() && s.sv === u.sv && !u.disabled ? u : null;
    } catch { return null; }
  }
  const cookie = (req, res, value, maxAge) => {
    const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `lh_session=${value}; Path=/; HttpOnly; SameSite=Lax${secure}${maxAge === 0 ? '; Max-Age=0' : maxAge ? '; Max-Age=' + maxAge : ''}`);
  };
  const publicUser = u => u && ({ id: u.id, username: u.username, name: u.name, role: u.role, perms: P.effective(u), alerts: u.alerts || {}, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, disabled: !!u.disabled });

  // ---------- permissions ----------
  // can(u, 'jackets.review') checks one permission; can(u, 'owner') means the owner role.
  const can = (u, need) => !!u && (need === 'owner' ? u.role === 'owner' : P.has(u, need));
  const ROLE_KEYS = Object.keys(P.ROLES);
  // The perms a manager may hand out: the owner anything, others only what they have themselves
  const grantable = (me, list) => me.role === 'owner' ? P.clean(list) : P.clean(list).filter(p => P.has(me, p));
  const permsFor = (me, role, list) => role === 'owner' ? undefined : Array.isArray(list) ? grantable(me, list) : grantable(me, P.PRESETS[role] || P.PRESETS.viewer);

  // ---------- activity log ----------
  function log(u, action, detail = '', target = null) {
    db().activity.push({ at: new Date().toISOString(), user: u ? (u.name || u.username) : 'Hunt', uid: u?.id ?? null, action, detail: String(detail).slice(0, 300), target });
    db().activity = db().activity.slice(-3000);
    ctx.save();
  }

  // ---------- notifications (the bell in the app, plus browser pop-ups if turned on) ----------
  // to: 'all' | 'owners' | [userIds]; kind: hunts | prices | mentions | daily (users can switch each off)
  function notify(to, kind, text, link = '') {
    const list = db().users.filter(u => !u.disabled && (u.alerts?.[kind] ?? true) && (to === 'all' || (to === 'owners' ? u.role === 'owner' : [].concat(to).includes(u.id))));
    for (const u of list) {
      const n = { id: crypto.randomBytes(6).toString('hex'), uid: u.id, kind, text: String(text).slice(0, 500), link, at: new Date().toISOString(), read: false };
      db().notifications.push(n);
      ctx.broadcast('notification', { uid: u.id, n });
    }
    db().notifications = db().notifications.slice(-3000);
    ctx.save();
  }

  // Telegram was removed: clear anything left over from it
  if (db().settings.telegramBotToken !== undefined || db().users.some(u => 'telegramChatId' in u)) {
    delete db().settings.telegramBotToken; delete db().settings.telegramBotName;
    for (const u of db().users) delete u.telegramChatId;
    ctx.save();
  }

  // ---------- login routes (open) ----------
  const failures = new Map();
  const DUMMY = hash('not-a-real-password'); // so an unknown username takes as long as a wrong password
  setInterval(() => { const now = Date.now(); for (const [k, f] of failures) if (f.until < now && now - (f.at || 0) > 30 * 60000) failures.delete(k); }, 10 * 60000);
  async function auth(req, res, url) {
    // Traefik appends the real client address as the LAST entry; earlier entries can be faked by the client
    const ip = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean).pop() || req.socket.remoteAddress || '';
    if (url.pathname === '/api/session') { const u = currentUser(req); return send(res, 200, { required: loginRequired(), user: publicUser(u) }); }
    if (url.pathname === '/api/logout') { cookie(req, res, '', 0); return send(res, 200, { ok: true }); }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const b = await readBody(req);
    const userKey = 'u:' + str(b.user).toLowerCase();
    for (const k of [ip, userKey]) { const f = failures.get(k); if (f && f.until > Date.now()) return send(res, 429, { error: `Too many attempts - try again in ${Math.ceil((f.until - Date.now()) / 60000)} min` }); }
    const u = db().users.find(x => x.username.toLowerCase() === str(b.user).toLowerCase() && !x.disabled);
    const ok = u ? verify(String(b.password || ''), u) : (verify(String(b.password || ''), DUMMY), false);
    if (ok) {
      failures.delete(ip); failures.delete(userKey);
      u.lastLoginAt = new Date().toISOString();
      const s = makeSession(u, b.remember === true);
      cookie(req, res, s.token, s.maxAge);
      log(u, 'signed in');
      return send(res, 200, { ok: true, user: publicUser(u) });
    }
    for (const [k, limit] of [[ip, 8], [userKey, 10]]) {
      const f = failures.get(k), n = (f && f.until && f.until <= Date.now() ? 0 : f?.n || 0) + 1;
      failures.set(k, { n, at: Date.now(), until: n >= limit ? Date.now() + 15 * 60000 : 0 });
    }
    await new Promise(r => setTimeout(r, 600));
    return send(res, 401, { error: 'Wrong username or password' });
  }

  // ---------- routes (logged in) ----------
  async function handle(req, res, url, parts, me) {
    const method = req.method;
    if (parts[1] === 'me') {
      if (method === 'GET') return send(res, 200, publicUser(me)), true;
      if (method === 'PUT') {
        const b = await readBody(req);
        if (b.name !== undefined) me.name = str(b.name).slice(0, 40) || me.username;
        if (b.alerts && typeof b.alerts === 'object') me.alerts = { ...me.alerts, ...Object.fromEntries(Object.entries(b.alerts).map(([k, v]) => [k, v === true])) };
        if (b.newPassword) {
          if (!me.salt || !verify(String(b.password || ''), me)) return send(res, 400, { error: 'Current password is wrong' }), true;
          if (String(b.newPassword).length < 8) return send(res, 400, { error: 'Use at least 8 characters' }), true;
          Object.assign(me, hash(b.newPassword)); me.sv = (me.sv || 1) + 1;
          const s = makeSession(me, true); cookie(req, res, s.token, s.maxAge);
          log(me, 'changed their password');
        }
        ctx.save();
        return send(res, 200, publicUser(me)), true;
      }
    }

    if (parts[1] === 'perms' && method === 'GET') return send(res, 200, { areas: P.AREAS, presets: P.PRESETS, roles: P.ROLES }), true;

    if (parts[1] === 'users') {
      const mentions = db().users.filter(u => !u.disabled).map(u => ({ username: u.username, name: u.name }));
      if (method === 'GET') return send(res, 200, { users: can(me, 'team.view') ? db().users.map(publicUser) : [], mentions }), true;
      if (!can(me, 'team.manage')) return send(res, 403, { error: "You don't have permission to manage people" }), true;
      if (method === 'POST' && !parts[2]) {
        const b = await readBody(req);
        const username = str(b.username).toLowerCase().replace(/[^a-z0-9._-]/g, '');
        if (!username || db().users.some(u => u.username === username)) return send(res, 400, { error: 'Pick a unique username (letters, numbers, . _ -)' }), true;
        if (String(b.password || '').length < 8) return send(res, 400, { error: 'Password needs at least 8 characters' }), true;
        const role = ROLE_KEYS.includes(b.role) ? b.role : 'custom';
        if (role === 'owner' && me.role !== 'owner') return send(res, 403, { error: 'Only an owner can add another owner' }), true;
        const perms = permsFor(me, role, b.perms);
        const u = { id: Math.max(0, ...db().users.map(x => x.id)) + 1, username, name: str(b.name).slice(0, 40) || username, role, ...(perms ? { perms } : {}), ...hash(b.password), sv: 1, createdAt: new Date().toISOString(), alerts: { hunts: true, prices: true, mentions: true, daily: role !== 'viewer' } };
        db().users.push(u); ctx.save();
        log(me, 'added a user', `${u.name} (${P.ROLES[role]}${perms ? `, ${perms.length} permissions` : ''})`);
        return send(res, 200, publicUser(u)), true;
      }
      const u = db().users.find(x => x.id === Number(parts[2]));
      if (!u) return send(res, 404, { error: 'User not found' }), true;
      if (u.role === 'owner' && me.role !== 'owner') return send(res, 403, { error: 'Only an owner can change an owner' }), true;
      // a manager who isn't an owner can't reset the password of (or disable / delete) someone with more access than they have
      if (me.role !== 'owner' && P.effective(u).some(p => !P.has(me, p))) return send(res, 403, { error: 'This person has access you do not have. Ask an owner.' }), true;
      if (method === 'PUT') {
        const b = await readBody(req);
        const owners = db().users.filter(x => x.role === 'owner' && !x.disabled);
        if ((b.role || b.perms) && u.id === me.id) return send(res, 400, { error: "You can't change your own permissions" }), true;
        if (b.role && ROLE_KEYS.includes(b.role)) {
          if (u.role === 'owner' && b.role !== 'owner' && owners.length < 2) return send(res, 400, { error: 'Keep at least one owner' }), true;
          if (b.role === 'owner' && me.role !== 'owner') return send(res, 403, { error: 'Only an owner can make someone an owner' }), true;
          u.role = b.role;
        }
        if (b.role || Array.isArray(b.perms)) {
          const perms = permsFor(me, u.role, b.perms);
          if (perms) u.perms = perms; else delete u.perms;
          ctx.broadcast('access', { uid: u.id }); // their open windows update right away
        }
        if (b.disabled !== undefined) {
          if (u.id === me.id) return send(res, 400, { error: "You can't disable yourself" }), true;
          u.disabled = !!b.disabled; u.sv = (u.sv || 1) + 1;
        }
        if (b.password) { if (String(b.password).length < 8) return send(res, 400, { error: 'Password needs at least 8 characters' }), true; Object.assign(u, hash(b.password)); u.sv = (u.sv || 1) + 1; }
        if (b.name !== undefined) u.name = str(b.name).slice(0, 40) || u.username;
        ctx.save(); log(me, 'updated a user', `${u.name}: ${Object.keys(b).join(', ')}`);
        return send(res, 200, publicUser(u)), true;
      }
      if (method === 'DELETE') {
        if (u.id === me.id) return send(res, 400, { error: "You can't delete yourself" }), true;
        if (u.role === 'owner' && db().users.filter(x => x.role === 'owner' && !x.disabled && x.id !== u.id).length < 1) return send(res, 400, { error: 'Keep at least one active owner' }), true;
        db().users = db().users.filter(x => x.id !== u.id); ctx.save();
        log(me, 'removed a user', u.name);
        return send(res, 200, { ok: true }), true;
      }
    }

    if (parts[1] === 'activity' && method === 'GET') {
      const pid = url.searchParams.get('product');
      const items = db().activity.filter(a => !pid || (a.target && String(a.target.id) === pid)).slice(-200).reverse();
      return send(res, 200, { items }), true;
    }

    if (parts[1] === 'notifications') {
      if (method === 'GET') {
        const mine = db().notifications.filter(n => n.uid === me.id).slice(-60).reverse();
        return send(res, 200, { items: mine, unread: mine.filter(n => !n.read).length }), true;
      }
      if (method === 'POST' && parts[2] === 'read') {
        for (const n of db().notifications) if (n.uid === me.id) n.read = true;
        ctx.save();
        return send(res, 200, { ok: true }), true;
      }
    }
    return false;
  }

  return { auth, currentUser, loginRequired, can, log, notify, handle, publicUser };
};
