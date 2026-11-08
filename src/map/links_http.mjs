// Link rule `http-route`: a client call with an exact path -> the server route that handles that exact path.
//
// Server side (Python; the facts come from routefacts.py, which reads the sources with `ast`). A route is one of:
//   table      a module- or class-level dict literal with at least three keys that are string literals starting with '/', whose values name service
//              methods. The values must be methods of ONE project class (at least TABLE_COVER of the named rows): that is the data check that the
//              table is a route table and which class serves it. The road ends at that method.
//   arm        `path == "/x"` or `path in ("/x", "/y")` inside a function, where `path` is a name assigned in that function from the request path
//              (`urlparse(...).path`, `self.path`, `request.path`, `.path_info`). The road ends at the box holding that comparison.
//   decorator  @x.route("/p") / @x.get("/p") / @x.post("/p") ... The road ends at the decorated function.
// Client side (JS/TS ops, Python ops): a call whose argument i is a string literal that is, after dropping any scheme://host, ?query and #fragment,
// a path that exactly equals a server route. The callee must be the global `fetch` (a module that declares no `fetch`), or a project function that
// hands one of its own parameters to a request function (a request wrapper).
// Refused, kept in the open ends with the reason: a path routed in more than one place (GET and POST, two arms) because the client's verb is not
// known; a path that is not an exact route; a computed path (template with ${}); a callee that is not a request wrapper.
import { mro, findMethod } from './classes.mjs';
import { tkey } from './canon.mjs';
import { cmp, sorted, PyFloat, pyRepr, pyRound2 } from './pyrt.mjs';

const EXACT = new Set(['exact', 'self', 'typed']);
const FETCH = new Set(['fetch', 'window.fetch', 'globalThis.fetch', 'self.fetch']);
const TABLE_COVER = 0.75; // a route table: at least three quarters of its named rows are methods of ONE class
const MIN_PATH = 5; // a path shorter than this ("/", "/a") is too common to mean one route
const MAX_ROUNDS = 4; // a wrapper of a wrapper of a wrapper: the fixpoint is cut after this many rounds
const PYHTTP = /(^|\.)(get|post|put|delete|patch|request|urlopen|Request)$/;
const PYHTTP_ROOT = /^(requests|httpx|urllib|session|client|http)/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i;
const pushTo = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);

/** A function is a request wrapper when its own BODY hands one of its own parameters to a request function (global fetch, requests / httpx / urllib,
 *  or a function already accepted as a wrapper), whatever its name and however many routes it happens to be called with. Fixpoint over calls. */
function wrapperSet(P, cands) {
  const ok = new Set();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let grew = false;
    for (const key of sorted(cands)) {
      if (ok.has(key)) continue;
      const fn = P.fns.get(key);
      if (!fn) continue;
      let params = (fn.params ?? []).map((p) => p[0].replace(/^\*+/, ''));
      if (params.length && ['self', 'cls', 'this'].includes(params[0])) params = params.slice(1);
      if (!params.length) continue;
      search: for (const nd of fn.nodes) {
        for (const o of nd.ops ?? []) {
          if (o.t !== 'call' || !(o.cb?.length || o.lits === undefined || o.lits === null)) continue;
          const f = o.f ?? '';
          const target = FETCH.has(f) || (fn.lang === 'py' && PYHTTP.test(f) && PYHTTP_ROOT.test(f)) || (o.to ?? []).some((g) => ok.has(g));
          if (target && params.some((p) => (o.cb ?? []).includes(p))) { ok.add(key); grew = true; break search; }
        }
      }
    }
    if (!grew) break;
  }
  return ok;
}

/** 'http://127.0.0.1:8765/api/x?y=1#z' -> '/api/x'; anything that is not an absolute path -> null */
export function normPath(v) {
  if (typeof v !== 'string') return null;
  const m = SCHEME.exec(v);
  let p = m ? m[1] || '/' : v;
  p = p.split(/[?#]/)[0];
  return p.startsWith('/') && p.length >= MIN_PATH && !p.includes(' ') && !p.includes('${') ? p : null;
}

function serverRoutes(L) {
  const P = L.P;
  const facts = new Map((L.routeFacts?.files ?? []).map((f) => [f.path, f]));
  const fnLine = new Map(); // (path, line of the def) -> the first function that starts there
  for (const fid of P.fids) {
    const f = P.fns.get(fid);
    if (f.path.endsWith('.py') && f.line != null && f.qual !== '<module>' && !fnLine.has(tkey(f.path, f.line))) fnLine.set(tkey(f.path, f.line), fid);
  }
  const routes = new Map();
  const tables = []; // [path, names, file, line, verb]
  for (const rel of sorted(P.mods.keys())) {
    if (P.mods.get(rel).lang !== 'py') continue;
    const ff = facts.get(rel);
    if (!ff) continue;
    for (const [k, ns, line, tv] of ff.tables) tables.push([k, ns, rel, line, tv]);
    for (const fnf of ff.fns) {
      const fid = fnLine.get(tkey(rel, fnf.line));
      if (!fid) continue;
      for (const dec of fnf.deco) pushTo(routes, dec.path, { kind: 'decorator', method: dec.verb, fid, line: fnf.line, file: rel });
      for (const arm of fnf.arms) pushTo(routes, arm.v, { kind: 'arm', method: fnf.dverb, fid, line: arm.line, file: rel });
    }
  }
  // tables: which class serves them
  const named = tables.filter((t) => t[1].length);
  let best = null;
  let cover = 0;
  if (named.length) {
    for (const ck of sorted(P.classes.keys())) {
      if (!P.classes.get(ck).mod.endsWith('.py')) continue;
      const ms = new Set();
      for (const k of mro(P, ck)) for (const m of Object.keys(P.classes.get(k).methods)) ms.add(m);
      const hit = named.filter((t) => t[1].some((n) => ms.has(n))).length;
      if (hit / named.length > cover) { best = ck; cover = hit / named.length; }
    }
  }
  L.httpStats = { table_rows: tables.length, table_class: best ? P.classes.get(best).name : null, table_class_coverage: new PyFloat(pyRound2(cover)) };
  if (best && cover >= TABLE_COVER) {
    for (const [p, ns, f, ln, tv] of tables) {
      const m = ns.map((n) => findMethod(P, best, n)).filter((x) => x);
      if (new Set(m).size === 1) pushTo(routes, p, { kind: 'table', method: tv, fid: m[0], line: P.fns.get(m[0]).line, file: P.fns.get(m[0]).path, table: `${f}:${ln}` });
      else L.refuse('http-route', 'table row names no single method of the serving class', `${f}:${ln}`, p);
    }
  } else {
    for (const [p, , f, ln] of tables) L.refuse('http-route', 'route table rows are not mostly methods of one class', `${f}:${ln}`, p);
  }
  return routes;
}

/** the verb a wrapper's NAME implies (post / postJson / postItem -> POST, get / getJson -> GET), else null. A name, so only used to REFUSE a link. */
function clientVerb(key, langPy = false, f = null) {
  if (langPy && f) return { get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', patch: 'PATCH' }[lastDot(f).toLowerCase()] ?? null;
  const nm = key.includes('::') ? lastDot(key.split('::').pop()) : key;
  if (/^post/i.test(nm)) return 'POST';
  if (/^(get|getJson)$/i.test(nm)) return 'GET';
  return null;
}

export function ruleHttpRoutes(L) {
  const P = L.P;
  const routes = serverRoutes(L);
  if (!routes.size) return;
  const unique = new Map();
  for (const p of sorted(routes.keys())) {
    const rs = routes.get(p);
    if (new Set(rs.map((r) => tkey(r.fid, r.line))).size === 1) unique.set(p, rs[0]);
    else {
      L.refuse('http-route', 'the path is routed in more than one place; the client verb is not known', p,
        rs.slice(0, 4).map((r) => `${r.table || `${r.file}:${r.line}`} ${r.kind} ${r.method || ''}`).join('; '));
    }
  }
  const kinds = new Map();
  for (const rs of routes.values()) for (const r of rs) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
  Object.assign(L.httpStats, { server_paths: routes.size, server_paths_routed_once: unique.size, server_routes_by_kind: Object.fromEntries(kinds) });
  // client sites
  const by = new Map(); // (callee key, arg index) -> {key, i, rows: [[fid, nd, op, literal, path]]}
  const nonlit = new Map();
  for (const fid of P.fids) {
    const fn = P.fns.get(fid);
    const lang = fn.lang;
    if (lang !== 'ts' && lang !== 'py') continue;
    const decls = P.mods.get(fn.path).decls ?? [];
    const declared = (n) => (decls instanceof Set ? decls.has(n) : decls.includes(n));
    for (const nd of fn.nodes) {
      for (const o of nd.ops ?? []) {
        if (o.t !== 'call' || !o.f) continue;
        const f = o.f;
        let key;
        if (FETCH.has(f) && !declared('fetch') && lang === 'ts') key = 'fetch';
        else if (EXACT.has(o.how) && o.to?.length === 1 && !o.may?.length) key = o.to[0];
        else if (lang === 'py' && PYHTTP.test(f) && PYHTTP_ROOT.test(f)) key = 'pyhttp';
        else continue;
        const lits = o.lits && Object.keys(o.lits).length ? o.lits : o.a0 !== undefined && o.a0 !== null ? { 0: o.a0 } : {};
        let got = false;
        for (let i = 0; i < 4; i++) {
          const v = Object.hasOwn(lits, String(i)) ? lits[String(i)] : null;
          if (v === null) continue;
          const p = normPath(v);
          if (p !== null) {
            const k = tkey(key, i);
            if (!by.has(k)) by.set(k, { key, i, rows: [] });
            by.get(k).rows.push([fid, nd, o, v, p]);
            got = true;
          }
        }
        if (!got && key !== 'fetch' && key !== 'pyhttp' && (o.n ?? 0) >= 1) nonlit.set(key, (nonlit.get(key) ?? 0) + 1);
      }
    }
  }
  const stat = { client_wrappers: [] };
  const wrappers = wrapperSet(P, new Set([...by.values()].map((g) => g.key).filter((k) => k !== 'fetch' && k !== 'pyhttp')));
  for (const g of [...by.values()].sort((a, b) => cmp([a.key, a.i], [b.key, b.i]))) {
    const { key, i, rows } = g;
    const hit = rows.filter((r) => routes.has(r[4]));
    const names = new Set(hit.map((r) => r[4]));
    const ratio = hit.length / rows.length;
    const direct = key === 'fetch' || key === 'pyhttp';
    const ok = direct || wrappers.has(key);
    if (!direct || hit.length) {
      stat.client_wrappers.push({ callee: direct ? key : key.includes('::') ? key.split('::')[1] : key, arg: i, literal_paths: rows.length, exact_routes: hit.length, distinct_routes: names.size, ratio: new PyFloat(pyRound2(ratio)), accepted: ok });
    }
    for (const [fid, nd, o, v, p] of rows) {
      if (!ok) {
        if (routes.has(p)) L.refuse('http-route', 'callee is not a request wrapper (its literal paths are not mostly routes)', `${fid}:${o.line}`, pyRepr(v));
        continue;
      }
      if (!routes.has(p)) { L.refuse('http-route', 'literal path is not a route of the server', `${fid}:${o.line}`, pyRepr(v)); continue; }
      if (!unique.has(p)) continue; // already listed once, under the path
      const r = unique.get(p);
      const cv = clientVerb(key, key === 'pyhttp', o.f);
      if (cv && r.method && cv !== r.method) {
        L.refuse('http-route', 'verb mismatch: the client wrapper implies ' + cv + ' and the server route is ' + r.method, `${fid}:${o.line}`, `${pyRepr(v)} -> ${r.file}:${r.line}`);
        continue;
      }
      const to = { path: r.file, line: r.line, kind: r.kind, method: r.method, fn: r.fid };
      if (r.table) to.table = r.table;
      L.add('http-route', fid, nd, o, r.fid, 'linked',
        `exact path ${pyRepr(p)}: client ${direct ? 'fetch' : key.split('::')[1]} argument ${i} == server ${r.kind} at ${r.table || `${r.file}:${r.line}`}`,
        { from: { path: P.fns.get(fid).path, line: o.line, literal: v, callee: key }, to }, `requests ${p}`, p, r.kind === 'arm' ? r.line : null);
    }
  }
  // the eight callees with the most calls that carry no literal path (ties keep the order they were first seen)
  stat.computed_path_calls_to_wrappers = Object.fromEntries([...nonlit].sort((a, b) => b[1] - a[1]).slice(0, 8));
  Object.assign(L.httpStats, stat);
}
