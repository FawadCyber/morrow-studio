// PostgreSQL storage. The app keeps working on one in-memory object (fast, simple); this file loads it
// from Postgres at start-up and writes back only the rows that changed, in one transaction.
//
// Every list (jackets, hunts, users ...) is its own table: pk + position + the full record as JSONB,
// plus a few readable columns (title, status, price ...) so the data is easy to browse in pgAdmin.
// Single values (settings, trends, counters) live in the "kv" table.
//
// Run directly (`node lib/pgstore.js load`) it prints the whole database as JSON: server.js uses that
// to load synchronously at start-up. The same command imports data/db.json first when Postgres is
// still empty (first move from the file) or when a backup restore left a "restore-pending" marker.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// table name -> natural id field (null: rows get a stable generated key) and readable columns
const TABLES = {
  products: { id: 'id', cols: { title: 'title', status: 'status', source: 'source', site: 'sourceDomain', price: 'price', currency: 'currency', score: 'score', link: 'link', created_at: 'createdAt', decided_at: 'decidedAt' } },
  runs: { id: 'id', cols: { mode: 'mode', status: 'status', found: 'found', started_at: 'startedAt', finished_at: 'finishedAt' } },
  users: { id: 'id', cols: { username: 'username', name: 'name', role: 'role', created_at: 'createdAt' } },
  boards: { id: 'id', cols: { name: 'name', created_at: 'at' } },
  notifications: { id: 'id', cols: { uid: 'uid', kind: 'kind', text: 'text', at: 'at', read: 'read' } },
  activity: { id: null, cols: { at: 'at', user_name: 'user', action: 'action', detail: 'detail' } },
  rejected: { id: null, cols: { title: 'title', by_who: 'by', at: 'at' } },
  looks: { id: 'id', cols: { topic: 'topic', source: 'source', status: 'status' } },
  views: { id: 'id', cols: { name: 'name' } },
  trend_history: { id: 'day', key: 'trendHistory', cols: { day: 'day' } },
};
const KEY_OF = Object.fromEntries(Object.entries(TABLES).map(([t, c]) => [c.key || t, t])); // db key -> table

const q = s => '"' + s.replace(/"/g, '""') + '"';
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value jsonb, updated_at timestamptz NOT NULL DEFAULT now())`,
  ...Object.entries(TABLES).map(([t, c]) => `CREATE TABLE IF NOT EXISTS ${q(t)} (pk text PRIMARY KEY, pos integer NOT NULL, ${
    Object.entries(c.cols).map(([col, f]) => `${q(col)} text GENERATED ALWAYS AS (data->>'${f}') STORED, `).join('')
  }data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`),
  ...Object.keys(TABLES).map(t => `CREATE INDEX IF NOT EXISTS ${q(t + '_pos')} ON ${q(t)} (pos)`),
];

// JSON text Postgres accepts (\u0000 is not allowed in jsonb)
const json = v => JSON.stringify(v === undefined ? null : v).replace(/\\u0000/g, '');
const hash = s => crypto.createHash('sha1').update(s).digest('base64');

function makeStore(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
  pool.on('error', e => console.error('Postgres connection problem:', e.message));

  const keys = new WeakMap();   // rows without a natural id keep the key they were given
  let written = null;           // what Postgres holds now: table -> Map(pk -> {pos, h}), kv -> Map(key -> h)

  const pkOf = (table, row, seen) => {
    const f = TABLES[table].id;
    let pk = f && row && row[f] !== undefined && row[f] !== null ? String(row[f]) : keys.get(row);
    if (!pk || seen.has(pk)) { // no id yet, or two rows with the same id: give this one its own key
      pk = (f ? 'dup-' : '') + crypto.randomUUID();
      if (row && typeof row === 'object') keys.set(row, pk);
    }
    seen.add(pk);
    return pk;
  };

  // what the in-memory db looks like as rows
  function snapshot(db) {
    const tables = {}, kv = new Map();
    for (const [k, v] of Object.entries(db)) {
      const t = KEY_OF[k];
      if (t && Array.isArray(v)) {
        const seen = new Set(), rows = new Map();
        v.forEach((row, pos) => { const pk = pkOf(t, row, seen); const s = json(row); rows.set(pk, { pos, s, h: hash(s) }); });
        tables[t] = rows;
      } else { const s = json(v); kv.set(k, { s, h: hash(s) }); }
    }
    for (const t of Object.keys(TABLES)) tables[t] ||= new Map();
    return { tables, kv };
  }

  // write the differences since the last successful write, all in one transaction
  const nothing = () => ({ tables: Object.fromEntries(Object.keys(TABLES).map(t => [t, new Map()])), kv: new Map() });
  const remember = now => ({ tables: Object.fromEntries(Object.entries(now.tables).map(([t, m]) => [t, new Map([...m].map(([pk, r]) => [pk, { pos: r.pos, h: r.h }]))])), kv: new Map([...now.kv].map(([k, r]) => [k, { h: r.h }])) });
  async function write(db, { wipe = false } = {}) {
    const now = snapshot(db);
    const before = wipe || !written ? nothing() : written;
    const c = await pool.connect();
    let changed = 0;
    try {
      await c.query('BEGIN');
      if (wipe) { for (const t of Object.keys(TABLES)) await c.query(`DELETE FROM ${q(t)}`); await c.query('DELETE FROM kv'); }
      for (const t of Object.keys(TABLES)) {
        const was = before.tables[t], is = now.tables[t];
        const gone = [...was.keys()].filter(pk => !is.has(pk));
        if (gone.length) { await c.query(`DELETE FROM ${q(t)} WHERE pk = ANY($1::text[])`, [gone]); changed += gone.length; }
        const up = [...is].filter(([pk, r]) => { const w = was.get(pk); return !w || w.h !== r.h; });
        for (let i = 0; i < up.length; i += 500) {
          const part = up.slice(i, i + 500);
          await c.query(`INSERT INTO ${q(t)} (pk, pos, data) SELECT * FROM unnest($1::text[], $2::int[], $3::jsonb[])
            ON CONFLICT (pk) DO UPDATE SET pos = excluded.pos, data = excluded.data, updated_at = now()`,
          [part.map(x => x[0]), part.map(x => x[1].pos), part.map(x => x[1].s)]);
        }
        const moved = [...is].filter(([pk, r]) => { const w = was.get(pk); return w && w.h === r.h && w.pos !== r.pos; });
        for (let i = 0; i < moved.length; i += 1000) {
          const part = moved.slice(i, i + 1000);
          await c.query(`UPDATE ${q(t)} x SET pos = u.pos FROM unnest($1::text[], $2::int[]) AS u(pk, pos) WHERE x.pk = u.pk`, [part.map(x => x[0]), part.map(x => x[1].pos)]);
        }
        changed += up.length + moved.length;
      }
      const goneKv = [...before.kv.keys()].filter(k => !now.kv.has(k));
      if (goneKv.length) await c.query('DELETE FROM kv WHERE key = ANY($1::text[])', [goneKv]);
      for (const [k, r] of now.kv) {
        const w = before.kv.get(k);
        if (w && w.h === r.h) continue;
        await c.query('INSERT INTO kv (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()', [k, r.s]);
        changed++;
      }
      await c.query('COMMIT');
      written = remember(now);
      return changed;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }

  async function ensureSchema() { for (const s of SCHEMA) await pool.query(s); }

  async function read() {
    const db = {};
    const pks = {};
    for (const { key, value } of (await pool.query('SELECT key, value FROM kv')).rows) db[key] = value;
    for (const [t, c] of Object.entries(TABLES)) {
      const { rows } = await pool.query(`SELECT pk, data FROM ${q(t)} ORDER BY pos, pk`);
      db[c.key || t] = rows.map(r => r.data);
      pks[t] = rows.map(r => r.pk);
    }
    return { db, pks, empty: !db.nextId && !db.products.length && !db.users.length };
  }

  // the rows server.js loaded are what Postgres holds: remember them so the first save writes nothing new
  function adopt(db, pks) {
    for (const [t, c] of Object.entries(TABLES)) {
      const list = db[c.key || t];
      if (Array.isArray(list) && pks[t]) list.forEach((row, i) => { if (row && typeof row === 'object' && pks[t][i] && !(c.id && row[c.id] !== undefined && row[c.id] !== null)) keys.set(row, pks[t][i]); });
    }
  }
  // after adopt(): what is in Postgres now = the loaded db
  function primeFrom(db) { written = remember(snapshot(db)); }

  // replace everything in Postgres with this db (first move from the file, or a restored backup), in one transaction
  const replaceAll = db => write(db, { wipe: true });

  return { write, read, ensureSchema, adopt, primeFrom, replaceAll, end: () => pool.end() };
}

module.exports = { makeStore, TABLES };

// ---------- `node lib/pgstore.js load`: print the database (importing db.json first when needed) ----------
if (require.main === module && process.argv[2] === 'load') {
  (async () => {
    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    const file = path.join(DATA_DIR, 'db.json'), marker = path.join(DATA_DIR, 'restore-pending');
    const store = makeStore(process.env.DATABASE_URL);
    await store.ensureSchema();
    let { db, pks, empty } = await store.read();
    const restoring = fs.existsSync(marker);
    if ((empty || restoring) && fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      await store.replaceAll(data);
      fs.renameSync(file, `${file}.imported-${Date.now()}`); // kept, never read again automatically
      fs.rmSync(marker, { force: true });
      process.stderr.write(restoring ? 'Restored backup loaded into Postgres\n' : `Moved db.json into Postgres (${(data.products || []).length} jackets)\n`);
      ({ db, pks } = await store.read());
    } else if (restoring) fs.rmSync(marker, { force: true });
    await store.end();
    process.stdout.write(JSON.stringify({ db, pks }));
  })().catch(e => { process.stderr.write('Postgres load failed: ' + e.message + '\n'); process.exit(1); });
}
