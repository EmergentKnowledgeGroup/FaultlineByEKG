// State store for the explorer: SQLite through node:sqlite when this Node has it, else an append-only journal file.
// Both answer the same small interface, so a run can be resumed with either (a run folder uses one kind for its life).
import fs from 'node:fs';
import path from 'node:path';

/** row: {id,hash,ident:Buffer,state:string(JSON),parent,action,depth,cls,reason,at,init,x} */
async function loadSqlite() {
  const orig = process.emitWarning;
  process.emitWarning = (w, ...rest) => { if (/SQLite/i.test(String(w?.message ?? w))) return; return orig.call(process, w, ...rest); };
  try { return (await import('node:sqlite')).DatabaseSync; } catch { return null; } finally { process.emitWarning = orig; }
}

export async function openStore(dir, kind = 'auto') {
  fs.mkdirSync(dir, { recursive: true });
  const sqlitePath = path.join(dir, 'explorer.sqlite');
  const journalPath = path.join(dir, 'journal.jsonl');
  let want = kind;
  if (want === 'auto') want = fs.existsSync(journalPath) ? 'journal' : fs.existsSync(sqlitePath) ? 'sqlite' : 'sqlite';
  if (want === 'sqlite') {
    const DB = await loadSqlite();
    if (DB) return new SqliteStore(DB, sqlitePath);
    if (kind === 'sqlite') throw new Error('node:sqlite is not available in this Node; use --store journal');
  }
  return new JournalStore(journalPath);
}

export const existingStore = (dir) => fs.existsSync(path.join(dir, 'explorer.sqlite')) || fs.existsSync(path.join(dir, 'journal.jsonl'));

class SqliteStore {
  constructor(DB, file) {
    this.kind = 'sqlite';
    this.file = file;
    this.db = new DB(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS states (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, ident BLOB NOT NULL, state TEXT NOT NULL,
        parent INTEGER, action TEXT, depth INTEGER NOT NULL, cls TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL, init INTEGER NOT NULL, x INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS states_hash ON states(hash);
      CREATE INDEX IF NOT EXISTS states_open ON states(x, id);`);
    this.q = {
      getMeta: this.db.prepare('SELECT v FROM meta WHERE k=?'),
      setMeta: this.db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
      byHash: this.db.prepare('SELECT id, ident FROM states WHERE hash=?'),
      ins: this.db.prepare('INSERT INTO states(hash,ident,state,parent,action,depth,cls,reason,at,init,x) VALUES(?,?,?,?,?,?,?,?,?,?,?)'),
      next: this.db.prepare('SELECT * FROM states WHERE x=0 ORDER BY id LIMIT 1'),
      done: this.db.prepare('UPDATE states SET x=1 WHERE id=?'),
      get: this.db.prepare('SELECT * FROM states WHERE id=?'),
      count: this.db.prepare('SELECT cls, x, COUNT(*) n FROM states GROUP BY cls, x'),
      byCls: this.db.prepare('SELECT * FROM states WHERE cls=? ORDER BY id'),
    };
  }
  meta(k) { const r = this.q.getMeta.get(k); return r ? JSON.parse(r.v) : null; }
  setMeta(k, v) { this.q.setMeta.run(k, JSON.stringify(v)); }
  lookup(hash) { return this.q.byHash.all(hash).map((r) => ({ id: r.id, ident: Buffer.from(r.ident) })); }
  insert(r) {
    const res = this.q.ins.run(r.hash, r.ident, r.state, r.parent ?? null, r.action ?? null, r.depth, r.cls, r.reason, r.at, r.init, r.x ? 1 : 0);
    return Number(res.lastInsertRowid);
  }
  nextOpen() { const r = this.q.next.get(); return r ? this.#row(r) : null; }
  markExpanded(id) { this.q.done.run(id); }
  get(id) { const r = this.q.get.get(id); return r ? this.#row(r) : null; }
  byClass(cls) { return this.q.byCls.all(cls).map((r) => this.#row(r)); }
  counts() {
    const out = { states: 0, open: 0, byClass: {} };
    for (const r of this.q.count.all()) { out.states += r.n; out.byClass[r.cls] = (out.byClass[r.cls] || 0) + r.n; if (!r.x) out.open += r.n; }
    return out;
  }
  openAts() { return this.db.prepare('SELECT at, COUNT(*) n FROM states WHERE x=0 GROUP BY at ORDER BY at').all().map((r) => ({ at: r.at, n: r.n })); }
  allAts() { return this.db.prepare('SELECT DISTINCT at FROM states ORDER BY at').all().map((r) => r.at); }
  begin() { if (!this.tx) { this.db.exec('BEGIN'); this.tx = true; } }
  commit() { if (this.tx) { this.db.exec('COMMIT'); this.tx = false; } }
  close() { try { this.commit(); this.db.close(); } catch { /* */ } }
  #row(r) { return { ...r, ident: Buffer.from(r.ident) }; }
}

class JournalStore {
  constructor(file) {
    this.kind = 'journal';
    this.file = file;
    this.metaMap = new Map();
    this.rows = [null]; // ids start at 1
    this.byHashMap = new Map();
    this.buf = [];
    if (fs.existsSync(file)) this.#replay(fs.readFileSync(file, 'utf8'));
  }
  #replay(text) {
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; } // a torn last line from a killed run is dropped
      if (o.t === 'm') this.metaMap.set(o.k, o.v);
      else if (o.t === 's') this.#add({ ...o.r, ident: Buffer.from(o.r.ident, 'base64') }, o.r.id);
      else if (o.t === 'x' && this.rows[o.id]) this.rows[o.id].x = 1;
    }
  }
  #add(r, id) {
    const row = { ...r, id: id ?? this.rows.length };
    this.rows[row.id] = row;
    if (!this.byHashMap.has(row.hash)) this.byHashMap.set(row.hash, []);
    this.byHashMap.get(row.hash).push(row.id);
    return row.id;
  }
  meta(k) { return this.metaMap.has(k) ? this.metaMap.get(k) : null; }
  setMeta(k, v) { this.metaMap.set(k, v); this.buf.push(JSON.stringify({ t: 'm', k, v })); }
  lookup(hash) { return (this.byHashMap.get(hash) || []).map((id) => ({ id, ident: this.rows[id].ident })); }
  insert(r) {
    const row = { hash: r.hash, ident: r.ident, state: r.state, parent: r.parent ?? null, action: r.action ?? null, depth: r.depth, cls: r.cls,
      reason: r.reason, at: r.at, init: r.init, x: r.x ? 1 : 0 };
    const id = this.#add(row);
    this.buf.push(JSON.stringify({ t: 's', r: { ...row, id, ident: row.ident.toString('base64') } }));
    return id;
  }
  nextOpen() {
    for (let i = this.cursor || 1; i < this.rows.length; i++) if (this.rows[i] && !this.rows[i].x) { this.cursor = i; return { ...this.rows[i] }; }
    return null;
  }
  markExpanded(id) { this.rows[id].x = 1; this.buf.push(JSON.stringify({ t: 'x', id })); }
  get(id) { return this.rows[id] ? { ...this.rows[id] } : null; }
  byClass(cls) { return this.rows.filter((r) => r && r.cls === cls).map((r) => ({ ...r })); }
  counts() {
    const out = { states: 0, open: 0, byClass: {} };
    for (const r of this.rows) if (r) { out.states++; out.byClass[r.cls] = (out.byClass[r.cls] || 0) + 1; if (!r.x) out.open++; }
    return out;
  }
  openAts() { const m = new Map(); for (const r of this.rows) if (r && !r.x) m.set(r.at, (m.get(r.at) || 0) + 1); return [...m].sort().map(([at, n]) => ({ at, n })); }
  allAts() { return [...new Set(this.rows.filter(Boolean).map((r) => r.at))].sort(); }
  begin() {}
  commit() { if (this.buf.length) { fs.appendFileSync(this.file, this.buf.join('\n') + '\n'); this.buf = []; } }
  close() { this.commit(); }
}
