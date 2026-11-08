// Lua -> the function-graph document (same shape as the other readers'). Real parser: tree-sitter (web-tree-sitter wasm + the Lua grammar's wasm).
// Pure syntax plus two literal tables (the Redis commands a script can call, by what they do to the world; and a project-wide alias check for the call
// function). `local f = function` and `f = function` are functions, repeat/until, numeric and generic for, goto-continue, nested names `outer.inner`,
// `<anon@LINE>`, string literals of every argument, the Redis command of redis.call / redis.pcall (a local alias is accepted only when EVERY binding of that
// name in the project is redis.call), the event name of an XADD, and parse-error counts.
// A line comment `--- @include "path"` names a script that is textually inlined: a file sees every top-level function of its includes, transitively.
//   readLua({ grammar, root, prefix, only }) -> document      (only: a list of paths; just those of the files under prefix are read)
import fs from 'node:fs';
import path from 'node:path';
import { fileDigest, listDir } from './files.mjs';
import { cpLen, cpSlice } from './pyrt.mjs';

export async function readLua({ grammar, root, prefix = '', only = null }) {
const { Parser, Language } = grammar;
await Parser.init();
const lang = await Language.load(fs.readFileSync(grammar.wasm));
const parser = new Parser();
parser.setLanguage(lang);
// ---- Redis commands by what they do to the world (Redis command reference; a literal table, not a guess) ----------------------------------
const w = (s) => new Set(s.split(' '));
const DELETE = w('DEL UNLINK HDEL SREM ZREM LREM ZREMRANGEBYSCORE ZREMRANGEBYRANK ZREMRANGEBYLEX XDEL FLUSHDB FLUSHALL LTRIM');
const WRITE = w('SET SETEX PSETEX SETNX GETSET GETDEL APPEND INCR INCRBY DECR DECRBY INCRBYFLOAT HSET HMSET HSETNX HINCRBY HINCRBYFLOAT LPUSH RPUSH LPUSHX RPUSHX LSET LINSERT LPOP RPOP LMOVE RPOPLPUSH BLMOVE BRPOPLPUSH SADD SPOP SMOVE ZADD ZINCRBY ZPOPMIN ZPOPMAX ZMPOP LMPOP XADD XTRIM XGROUP XACK XCLAIM XAUTOCLAIM EXPIRE PEXPIRE EXPIREAT PEXPIREAT PERSIST RENAME RENAMENX COPY MOVE SETBIT PFADD GEOADD');
const EMIT = w('PUBLISH');
const READ = w('GET MGET HGET HGETALL HMGET HEXISTS HLEN HKEYS HVALS HSTRLEN HSCAN LRANGE LLEN LINDEX ZRANGE ZRANGEBYSCORE ZREVRANGE ZREVRANGEBYSCORE ZRANGEBYLEX ZSCORE ZCARD ZCOUNT ZRANK ZREVRANK ZSCAN ZMSCORE SMEMBERS SISMEMBER SCARD SSCAN SRANDMEMBER EXISTS TTL PTTL TYPE KEYS SCAN XLEN XRANGE XREVRANGE XREAD XINFO XPENDING STRLEN INFO TIME DBSIZE LPOS SINTER SUNION SDIFF ZUNION ZINTER ZDIFF');
const redisEff = (cmd, ev) => {
  const c = cmd.toUpperCase();
  if (DELETE.has(c)) return ['delete', 'store'];
  if (EMIT.has(c)) return ['emit'];
  if (WRITE.has(c)) return c === 'XADD' && ev ? ['emit', 'store'] : ['store'];
  return READ.has(c) ? [] : ['maybe:call'];            // a command in no table: unknown effect
};

function walk(d, rel = '') {
  const res = [];
  for (const e of listDir(d)) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDir) { if (e.name !== 'node_modules' && e.name !== '.git') res.push(...walk(path.join(d, e.name), r)); } else if (e.name.endsWith('.lua')) res.push(r);
  }
  return res;
}
const wanted = only ? new Set(only) : null;
const rels = walk(path.join(root, prefix), prefix).filter((r) => !wanted || wanted.has(r));
const short = (s, n = 90) => { s = (s || '').replace(/\s+/g, ' ').trim(); return cpLen(s) > n ? cpSlice(s, 0, n - 3) + '...' : s; };
const strVal = (n) => {
  if (!n || n.type !== 'string') return null;
  const t = n.text;
  if (/^\[=*\[/.test(t)) return t.replace(/^\[=*\[\n?/, '').replace(/\]=*\]$/, '');
  return t.slice(1, -1).replace(/\\(["'\\])/g, '$1');
};
const named = (n) => { const r = []; if (n) for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c.type !== 'comment') r.push(c); } return r; };
const trees = new Map(), srcOf = new Map();
let parseErrors = 0, errNodes = 0;
for (const rel of rels) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  const tree = parser.parse(src);
  if (tree.rootNode.hasError) { parseErrors++; (function f(n) { if (n.isError || n.isMissing) errNodes++; for (let i = 0; i < n.childCount; i++) f(n.child(i)); })(tree.rootNode); }
  trees.set(rel, tree); srcOf.set(rel, src);
}

// ---- project-wide alias check: a name counts as `redis.call` only if every binding of it in the project is redis.call / redis.pcall -------
const bindings = new Map();                       // name -> [rhs text or null]
function scanBind(n) {
  if (n.type === 'assignment_statement') {
    const vl = n.namedChildren.find((c) => c.type === 'variable_list'), el = n.namedChildren.find((c) => c.type === 'expression_list');
    const names = vl ? named(vl) : [], vals = el ? named(el) : (n.childForFieldName('value') ? [n.childForFieldName('value')] : []);
    names.forEach((nm, i) => { if (nm.type === 'identifier') { const a = bindings.get(nm.text) || []; a.push(vals[i] && vals[i].type === 'dot_index_expression' ? vals[i].text : null); bindings.set(nm.text, a); } });
  } else if (n.type === 'function_declaration') {
    const nm = n.childForFieldName('name');
    if (nm && nm.type === 'identifier') { const a = bindings.get(nm.text) || []; a.push(null); bindings.set(nm.text, a); }
  } else if (n.type === 'parameters') {
    for (const c of named(n)) { const a = bindings.get(c.text) || []; a.push(null); bindings.set(c.text, a); }
  } else if (n.type === 'for_numeric_clause' || n.type === 'for_generic_clause') {
    for (const c of n.namedChildren) if (c.type === 'identifier') { const a = bindings.get(c.text) || []; a.push(null); bindings.set(c.text, a); }
    const vl = n.namedChildren.find((c) => c.type === 'variable_list');
    if (vl) for (const c of named(vl)) { const a = bindings.get(c.text) || []; a.push(null); bindings.set(c.text, a); }
  }
  for (let i = 0; i < n.namedChildCount; i++) scanBind(n.namedChild(i));
}
for (const t of trees.values()) scanBind(t.rootNode);
const ALIAS = new Map();                          // alias name -> 'redis.call' | 'redis.pcall'
for (const [k, v] of [...bindings.entries()].sort()) if (v.length && v.every((x) => x === 'redis.call') ) ALIAS.set(k, 'redis.call'); else if (v.length && v.every((x) => x === 'redis.pcall')) ALIAS.set(k, 'redis.pcall');

// ---- function graph ---------------------------------------------------------------------------------------------------------------------
class FB {
  constructor(node, rel, qual, endNode) {
    Object.assign(this, { rel, qual, nodes: [], edges: [], loops: [], rd: new Set(), nested: [], labels: new Map(), gotos: [] });
    const ln = node.startPosition.row + 1;
    this.entry = this.nw('entry', ln, ''); this.exit = this.nw('exit', (endNode || node).endPosition.row + 1, ''); this.xexit = this.nw('xexit', ln, '');
  }
  nw(k, line, syn, extra = {}) { const i = this.nodes.length; this.nodes.push({ i, k, line, syn, ...extra }); return i; }
  edge(a, b, l) { this.edges.push([a, b, l]); }
  conn(t, n) { for (const [a, l] of t) this.edge(a, n, l); }
  // calls inside an expression, in evaluation order; function bodies are separate functions
  ops(n) {
    const o = [];
    const visit = (x) => {
      if (x.type === 'function_definition') { this.nested.push([x, null]); return; }
      if (x.type === 'function_declaration') return;
      for (let c = 0; c < x.namedChildCount; c++) visit(x.namedChild(c));
      if (x.type !== 'function_call') return;
      const nm = x.childForFieldName('name'); if (!nm) return;
      const f = nm.type === 'method_index_expression' ? nm.text.replace(':', '.') : nm.text;
      this.rd.add(f);
      const args = x.childForFieldName('arguments');
      const as = args ? named(args) : [];
      const op = { t: 'call', line: x.startPosition.row + 1, f, n: as.length, aw: false, held: [], col: x.startPosition.column + 1 };
      const lits = {};
      as.slice(0, 8).forEach((a, i) => { const v = strVal(a); if (v !== null) lits[i] = cpSlice(v, 0, 80); });
      if (lits[0] !== undefined) op.a0 = lits[0];
      if (Object.keys(lits).length) op.lits = lits;
      const al = ALIAS.get(f);
      if (f === 'redis.call' || f === 'redis.pcall' || al) {
        op.rdc = al || f;                                       // this is a Redis command call
        const cmd = lits[0];
        op.redis = cmd ? cmd.toUpperCase() : '?';
        const ei = as.findIndex((a, i) => i >= 1 && strVal(a) === 'event');
        const ev = ei > 0 && as[ei + 1] ? strVal(as[ei + 1]) : null;
        if (ev && op.redis === 'XADD') op.ev = cpSlice(ev, 0, 60);
        op.eff = cmd ? redisEff(cmd, op.ev) : ['maybe:call'];
        if (!op.eff.length) delete op.eff;
        if (as[1]) { op.kx = short(as[1].text, 70); const kl = []; (function g(z) { if (z.type === 'string') kl.push(strVal(z)); else for (let i = 0; i < z.namedChildCount; i++) g(z.namedChild(i)); })(as[1]); if (kl.length) op.kl = kl.map((s) => cpSlice(s, 0, 40)); }
      } else if (/^(redis\.log|print)$/.test(f)) op.eff = ['log'];
      o.push(op);
    };
    visit(n);
    return o;
  }
  seq(stmts, tails, syn) {
    let t = tails, k = 0;
    for (const s of stmts) { t = this.stmt(s, t, (syn ? syn + '/' : '') + k); k++; if (!t.length && s.type !== 'label_statement') break; }
    return t;
  }
  valSig(e) {
    if (!e) return 'ret:none';
    const t = e.text;
    if (e.type === 'nil') return 'ret:none';
    if (['number', 'string', 'true', 'false', 'table_constructor', 'unary_expression'].includes(e.type) && /^[{\d"'\[]|^-\s*\d|^(true|false)$/.test(t)) return 'ret:const:str:' + ('r' + t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')).slice(0, 38);
    return 'ret:expr';
  }
  // a statement that binds names to values: functions on the right become functions of their own, named by the left
  bind(s, names, vals, ops) {
    names.forEach((nm, i) => {
      const v = vals[i];
      if (v && v.type === 'function_definition' && (nm.type === 'identifier' || nm.type === 'dot_index_expression')) this.nested.push([v, nm.text.replace(/[:]/g, '.')]);
      else if (v) ops.push(...this.ops(v));
    });
    for (let i = names.length; i < vals.length; i++) ops.push(...this.ops(vals[i]));
    for (const nm of names) if (nm.type !== 'identifier') ops.push(...this.ops(nm));
  }
  stmt(s, tails, syn) {
    const line = s.startPosition.row + 1;
    switch (s.type) {
      case 'function_declaration': this.nested.push([s, s.childForFieldName('name').text.replace(/[:]/g, '.')]); return tails;
      case 'comment': case 'empty_statement': return tails;
      case 'label_statement': {
        const b = this.nw('block', line, syn, { ops: [], eline: line }); this.conn(tails, b); this.labels.set(s.namedChild(0).text, b); return [[b, 'seq']];
      }
      case 'goto_statement': {
        const j = this.nw('jump', line, syn, { jt: 'goto', to: s.namedChild(0).text }); this.conn(tails, j); this.gotos.push(j);
        return [];
      }
      case 'if_statement': {
        const cond = s.childForFieldName('condition');
        const b = this.nw('branch', line, syn, { tk: 'if', test: short(cond.text, 80) }); this.conn(tails, b);
        this.addOps(b, this.ops(cond));
        const ct = cond.type === 'false' || cond.type === 'nil' ? false : cond.type === 'true' ? true : null;     // `if false then`: the arm that cannot run gets no edge
        const cons = ct === false ? [] : this.seq(named(s.childForFieldName('consequence')), [[b, 'T']], syn + '/b');
        let curFalse = ct === true ? [] : [[b, 'F']], outT = [...cons], ai = 0;
        for (const a of s.childrenForFieldName('alternative').filter(Boolean)) {
          if (a.type === 'elseif_statement') {
            const c2 = a.childForFieldName('condition');
            const e = this.nw('branch', a.startPosition.row + 1, syn + '/e' + ai, { tk: 'elif', test: short(c2.text, 80) });
            this.conn(curFalse, e); this.addOps(e, this.ops(c2));
            outT = outT.concat(this.seq(named(a.childForFieldName('consequence')), [[e, 'T']], syn + '/e' + ai + '/b'));
            curFalse = [[e, 'F']];
          } else {
            outT = outT.concat(this.seq(named(a.childForFieldName('body')), curFalse, syn + '/e' + ai));
            curFalse = [];
          }
          ai++;
        }
        return outT.concat(curFalse);
      }
      case 'while_statement': case 'for_statement': case 'repeat_statement': {
        let test, hdr = [], inf = false, tk = s.type.split('_')[0];
        if (s.type === 'for_statement') {
          const cl = s.childForFieldName('clause');
          test = short(cl.text, 80); hdr = this.ops(cl);
        } else {
          const cond = s.childForFieldName('condition');
          test = (s.type === 'repeat_statement' ? 'until ' : '') + short(cond.text, 70); hdr = this.ops(cond);
          inf = s.type === 'while_statement' && cond.type === 'true';
        }
        const L = this.nw('loop', line, syn, { tk, test }); this.conn(tails, L);
        if (inf) this.nodes[L].inf = 1;
        this.addOps(L, hdr);
        this.loops.push({ head: L, breaks: [] });
        const body = this.seq(named(s.childForFieldName('body')), [[L, 'T']], syn + '/b');
        const me = this.loops.pop();
        for (const [a, l] of body) this.edge(a, L, l !== 'seq' ? l : 'loop');
        return (inf ? [] : [[L, 'done']]).concat(me.breaks);
      }
      case 'do_statement': return this.seq(named(s.childForFieldName('body')), tails, syn + '/b');
      case 'break_statement': {
        const j = this.nw('jump', line, syn, { jt: 'break' }); this.conn(tails, j);
        if (this.loops.length) this.loops[this.loops.length - 1].breaks.push([j, 'brk']);
        return [];
      }
      case 'return_statement': {
        const el = s.namedChildren.find((c) => c.type === 'expression_list');
        const vals = el ? named(el) : [];
        const r = this.nw('return', line, syn, { sig: vals.length === 1 || !vals.length ? this.valSig(vals[0]) : 'ret:expr', eline: s.endPosition.row + 1, rtext: vals.length ? cpSlice(vals.map((v) => v.text).join(', ').replace(/\s+/g, ' '), 0, 40) : '' });
        this.conn(tails, r); this.addOps(r, vals.flatMap((v) => this.ops(v))); this.edge(r, this.exit, 'ret');
        return [];
      }
      case 'variable_declaration': case 'assignment_statement': {
        const as = s.type === 'variable_declaration' ? s.namedChildren.find((c) => c.type === 'assignment_statement') : s;
        const ops = [];
        if (as) {
          const vl = as.namedChildren.find((c) => c.type === 'variable_list'), el = as.namedChildren.find((c) => c.type === 'expression_list');
          const names = vl ? named(vl) : [], vals = el ? named(el) : [];
          this.bind(s, names, vals, ops);
          if (names.length && !vals.length) return tails;
          if (!ops.length && vals.every((v) => v.type === 'function_definition')) return tails;
        } else return tails;                               // `local x`
        const n = this.nw('block', line, syn, { ops: [], eline: s.endPosition.row + 1 }); this.conn(tails, n); this.addOps(n, ops);
        return [[n, 'seq']];
      }
      default: {
        const callee = s.type === 'function_call' ? s.childForFieldName('name') : null;
        if (callee && callee.text === 'error') {         // error(...) ends the script (or the pcall around it): nothing after it on this path runs
          const r = this.nw('raise', line, syn, { exc: '*', rt: 'unknown', norm: 1, raised: 'error(...)', sig: 'raise:*', eline: s.endPosition.row + 1 });
          this.conn(tails, r); this.addOps(r, this.ops(s)); this.edge(r, this.xexit, 'exc');
          return [];
        }
        const n = this.nw('block', line, syn, { ops: [], eline: s.endPosition.row + 1 });
        this.conn(tails, n); this.addOps(n, this.ops(s));
        return [[n, 'seq']];
      }
    }
  }
  addOps(n, ops) { if (ops.length) (this.nodes[n].ops ||= []).push(...ops); }
  finish() {
    for (const j of this.gotos) {                 // goto: a label at the end of the enclosing loop body is `continue`; anything else is not modelled
      const lab = this.labels.get(this.nodes[j].to);
      if (lab !== undefined) this.edge(j, lab, 'goto'); else this.nodes[j].unmodelled = 1;
    }
  }
}
const stmtsOf = (n) => (n ? named(n) : []);
function buildFn(node, rel, qual, stmts, params) {
  const b = new FB(node, rel, qual);
  const t = b.seq(stmts, [[b.entry, 'seq']], '');
  b.conn(t, b.exit); b.finish();
  const rec = { id: `${rel}::${qual}`, path: rel, qual, cls: null, lang: 'lua', line: node.startPosition.row + 1, end: node.endPosition.row + 1, async: false, params: params.map((p) => [p, null]), decos: [], nodes: b.nodes, edges: b.edges, rd: [...b.rd].sort(), entry: b.entry, exit: b.exit, xexit: b.xexit };
  return { rec, nested: b.nested };
}

const files = [], incOf = {}, fnsOf = {};
let nGoto = 0;
for (const rel of rels) {
  const src = srcOf.get(rel), tree = trees.get(rel);
  incOf[rel] = [...src.matchAll(/---\s*@include\s+"([^"]+)"/g)].map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1] + '.lua')));
  const fns = [], seenQ = new Map();
  const uniq = (q) => { const n = (seenQ.get(q) || 0) + 1; seenQ.set(q, n); return n > 1 ? `${q}~${n}` : q; };
  const queue = [[tree.rootNode, '<module>', stmtsOf(tree.rootNode), []]];
  while (queue.length) {
    const [node, qual, st, params] = queue.shift();
    const { rec, nested } = buildFn(node, rel, qual === '<module>' ? qual : uniq(qual), st, params);
    fns.push(rec);
    nGoto += rec.nodes.filter((x) => x.unmodelled).length;
    for (const [nf, nm] of nested) {
      const body = nf.childForFieldName('body'), pn = nf.childForFieldName('parameters');
      const q = (qual === '<module>' ? '' : qual + '.') + (nm || `<anon@${nf.startPosition.row + 1}>`);
      queue.push([nf, q, stmtsOf(body), pn ? named(pn).map((p) => p.text) : []]);
    }
  }
  fnsOf[rel] = fns;
  files.push({ path: rel, module: rel.replace(/\.lua$/, '').replace(/\//g, '.'), lang: 'lua', lines: src.split('\n').length, imports: {}, classes: [], fns, decls: [] });
}
// @include is textual inlining: a file sees every top-level function of its includes, transitively
const closure = (r, seen = new Set()) => { for (const i of incOf[r] || []) if (!seen.has(i)) { seen.add(i); closure(i, seen); } return seen; };
for (const f of files) {
  f.includes = [...closure(f.path)].sort();
  for (const inc of f.includes) for (const fn of fnsOf[inc] || []) if (fn.qual !== '<module>' && !fn.qual.includes('.') && !fn.qual.includes('<')) f.imports[fn.qual] = ['name', inc.replace(/\.lua$/, '').replace(/\//g, '.'), fn.qual];
}
return { schema: 'fldet.ir/1', source_digest: fileDigest(root, files.map((f) => f.path)), files };
}
