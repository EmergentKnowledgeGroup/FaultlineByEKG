// Links that are not calls. Pure functions of the IR and the resolved calls; every link carries both anchors.
//
// A link is drawn only when BOTH ends are anchored in code and the match is an exact literal that is not shared by unrelated code:
//   script-by-name  a TS call site whose callee the checker proved is a project function D, and whose literal argument i is the base name of exactly
//                   one Lua script (name-N.lua, a file no other Lua file includes). (D, i) counts as a script dispatcher only when it is shown by the
//                   data: at least MIN_NAMES distinct script names at that argument and at least MIN_RATIO of its literal arguments are script names.
//                   So `trace('settleOrder')` or an error mapper never links; only the function that dispatches by name does.
//   emit-on         `X.emit('E')` and `Y.on|once|addListener('E', <inline function>)` where the checker gives both receivers as the SAME project class
//                   (or the listener's class inherits the emitter's class) and E is the same literal. The road ends at the handler function. A shared
//                   string on different classes is never a link. Interface-typed receivers are not linked (which implementer?), they are open ends.
//   redis-key       Lua only: the same key expression written in one function and read in another.
//   http-route      links_http.mjs.
// Everything that was looked at and refused is kept in `open` with its reason. A link op is `{t: 'link', to: [fid], how: 'link', tier, ...}`;
// roadpass draws it as a road of tier `linked` (the checker is not involved, so there is no `proven` here).
import { mro } from './classes.mjs';
import { cmp, sorted, PyFloat, pyRepr, pyRound2, PYWS } from './pyrt.mjs';
import { tkey } from './canon.mjs';
import { ruleHttpRoutes } from './links_http.mjs';

const EXACT = new Set(['exact', 'self', 'typed']);
const LISTEN = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);
const MIN_NAMES = 3; // a dispatcher reaches at least this many different scripts
const MIN_RATIO = 0.9; // and at least this share of its literal arguments are script names
const MIN_COVER = 0.25; // and reaches at least this share of all the scripts there are
const MAX_LISTENERS = 8; // an event with more listeners than this is a hub, not a link
const MAX_REDIS_FUNCTIONS = 4; // a key written in one function and read in at most this many functions
const MIN_KEY_SUFFIX = 4; // a key suffix shorter than this (with its colon) is too common to mean one key
const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);

/** the string-literal argument i of a call op, or undefined */
export function lit(o, i) {
  const d = o.lits;
  return d && Object.hasOwn(d, String(i)) ? d[String(i)] : undefined;
}

/** every call op, in a fixed order: [fid, node, op index, op] */
export function* sites(P, langs = null) {
  for (const fid of P.fids) {
    const fn = P.fns.get(fid);
    if (langs && !langs.includes(fn.lang)) continue;
    for (const nd of fn.nodes) {
      const ops = nd.ops ?? [];
      for (let oi = 0; oi < ops.length; oi++) if (ops[oi].t === 'call') yield [fid, nd, oi, ops[oi]];
    }
  }
}

/** the one target the checker (or the lexical rule) is sure of, else null */
export function provenCallee(o) {
  if (!EXACT.has(o.how) || !o.to?.length) return null;
  const t = o.to.filter((g) => !(o.may ?? []).includes(g));
  return t.length === 1 ? t[0] : null;
}

const count = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const pushTo = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };

export class Links {
  constructor(P, root = null) {
    this.P = P;
    this.root = root;
    this.rows = [];
    this.open = [];
    this.looked = new Map();
    this.dispatch = [];
    this.pending = [];
    this.seenOpen = new Set();
    this.httpStats = null;
    this.byFn = null;
  }

  add(kind, fid, nd, o, dst, tier, basis, anchors, when, litv = null, toLine = null) {
    this.pending.push([fid, nd.i, o.line, kind, dst, tier, basis, anchors, when, litv, toLine]);
  }

  refuse(kind, why, where, detail = '') {
    const k = tkey(kind, why, where);
    if (!this.seenOpen.has(k)) { // one entry per site, however many partners it was tried against
      this.seenOpen.add(k);
      this.open.push({ kind, why, at: where, detail });
    }
  }

  /** add the link ops to the call-site nodes, in a fixed order; number the rows */
  commit() {
    const P = this.P;
    const keyed = this.pending.map((r) => [[r[0], r[1], r[2], r[3], r[4], r[9] === null ? 'None' : String(r[9]), r[10] || 0], r]);
    keyed.sort((a, b) => cmp(a[0], b[0]));
    keyed.forEach(([, r], idx) => {
      const [fid, ni, line, kind, dst, tier, basis, anchors, when, litv, toLine] = r;
      const lid = `lk${idx + 1}`;
      const nd = P.fns.get(fid).nodes[ni];
      const op = { t: 'link', line, to: [dst], how: 'link', tier, basis, kind, lid, when };
      if (litv) op.lit = litv;
      if (toLine) op.to_line = toLine;
      (nd.ops ??= []).push(op);
      this.rows.push({ id: lid, kind, tier, from: fid, from_line: line, to: dst, to_line: toLine, lit: litv, basis, anchors, when });
    });
  }

  summary() {
    const by = new Map();
    for (const r of this.rows) count(by, `${r.kind}/${r.tier}`);
    const open = new Map();
    for (const r of this.open) count(open, `${r.kind}: ${r.why}`);
    const out = { links: this.rows.length, by_kind_tier: Object.fromEntries(by) };
    if (this.httpStats) out.http = this.httpStats;
    return { ...out, open_ends: Object.fromEntries(open), dispatchers: this.dispatch, looked_at: Object.fromEntries(this.looked) };
  }

  // ---- script-by-name ------------------------------------------------------------------------------------------------
  scriptIndex() {
    const P = this.P;
    const included = new Set();
    for (const m of P.mods.values()) if (m.lang === 'lua') for (const x of m.includes ?? []) included.add(x);
    const scripts = new Map();
    for (const fid of P.fids) {
      const fn = P.fns.get(fid);
      if (fn.lang !== 'lua' || fn.qual !== '<module>' || included.has(fn.path)) continue;
      const m = /^(?:.*\/)?([A-Za-z0-9_]+?)(?:-(\d+))?\.lua$/.exec(fn.path);
      if (m) pushTo(scripts, m[1], fid);
    }
    return scripts;
  }

  ruleScriptByName() {
    const P = this.P;
    const scripts = this.scriptIndex();
    const uniq = new Map();
    for (const [n, v] of scripts) {
      if (v.length === 1) uniq.set(n, v[0]);
      else this.refuse('script-by-name', 'two scripts share the name', n, v.join(', '));
    }
    if (!uniq.size) return;
    const by = new Map(); // (callee, arg index) -> [[fid, node, op, literal]]
    for (const [fid, nd, , o] of sites(P, ['ts'])) {
      const d = provenCallee(o);
      if (!d) continue;
      for (let i = 0; i < 4; i++) {
        const v = lit(o, i);
        if (v !== undefined && v !== null) pushTo(by, tkey(d, i), { d, i, row: [fid, nd, o, v] });
      }
    }
    for (const g of [...by.values()].sort((a, b) => cmp([a[0].d, a[0].i], [b[0].d, b[0].i]))) {
      const { d, i } = g[0];
      const rows = g.map((x) => x.row);
      const hit = rows.filter((r) => uniq.has(r[3]));
      if (!hit.length) continue;
      const names = new Set(hit.map((r) => r[3]));
      const ratio = hit.length / rows.length;
      const cover = names.size / uniq.size;
      const ok = names.size >= MIN_NAMES && ratio >= MIN_RATIO && cover >= MIN_COVER;
      this.dispatch.push({ callee: d, arg: i, literal_sites: rows.length, script_name_sites: hit.length, distinct_scripts: names.size, ratio: new PyFloat(pyRound2(ratio)), covers_scripts: new PyFloat(pyRound2(cover)), accepted: ok });
      if (!ok) {
        for (const [fid, , o, v] of hit) this.refuse('script-by-name', 'callee is not a script dispatcher (its literals are not mostly script names, or it reaches few scripts)', `${fid}:${o.line}`, `${d} arg ${i} = ${pyRepr(v)}`);
        continue;
      }
      for (const [fid, nd, o, v] of rows) {
        if (!uniq.has(v)) {
          this.refuse('script-by-name', 'literal at a dispatcher is not a script name', `${fid}:${o.line}`, `${d} arg ${i} = ${pyRepr(v)}`);
          continue;
        }
        const dst = uniq.get(v);
        this.add('script-by-name', fid, nd, o, dst, 'linked', `literal argument ${i} of ${d.split('::')[1]} (callee proven by the checker) is the base name of script ${P.fns.get(dst).path}`,
          { from: { path: P.fns.get(fid).path, line: o.line, callee: d, arg: i, literal: v }, to: { path: P.fns.get(dst).path, fn: dst } }, `runs script ${v}`, v);
      }
    }
  }

  // ---- emit -> on ----------------------------------------------------------------------------------------------------
  /** 'path::Name' -> project class key, or null (interfaces, outside types) */
  classOf(key) {
    if (!key || !key.includes('::')) return null;
    const i = key.indexOf('::');
    const path = key.slice(0, i);
    for (const ck of this.P.clsByName.get(key.slice(i + 2)) ?? []) if (this.P.classes.get(ck).mod === path) return ck;
    return null;
  }

  handlerOf(fid, o, argi = 1) {
    const ln = o.fa ? o.fa[String(argi)] : undefined;
    if (ln === undefined || ln === null) return [null, 'handler is not an inline function'];
    const fn = this.P.fns.get(fid);
    if (!this.byFn) {
      this.byFn = new Map();
      for (const g of this.P.fids) pushTo(this.byFn, tkey(this.P.fns.get(g).path, this.P.fns.get(g).line), g);
    }
    const c = (this.byFn.get(tkey(fn.path, ln)) ?? []).filter((g) => this.P.fns.get(g).qual.startsWith(fn.qual + '.') && this.P.fns.get(g).qual !== fn.qual);
    if (c.length !== 1) return [null, `${c.length} functions start at the handler line`];
    return [c[0], ''];
  }

  ruleEmitOn(cap = MAX_LISTENERS) {
    const P = this.P;
    const emits = [];
    const listens = [];
    for (const [fid, nd, , o] of sites(P, ['ts'])) {
      const f = o.f ?? '';
      const last = lastDot(f);
      if (last === 'emit') {
        const v = lit(o, 0);
        if (v === undefined || v === null) { count(this.looked, 'emit with a computed event name'); continue; }
        emits.push([fid, nd, o, v]);
      } else if (LISTEN.has(last)) {
        const v = lit(o, 0);
        if (v === undefined || v === null) { count(this.looked, 'listener with a computed event name'); continue; }
        listens.push([fid, nd, o, v]);
      }
    }
    this.looked.set('emit sites with a literal', emits.length);
    this.looked.set('listener sites with a literal', listens.length);
    const lisBy = new Map();
    for (const l of listens) pushTo(lisBy, l[3], l);
    for (const [fid, nd, o, v] of emits) {
      const rc = o.rc ?? [];
      const ce = rc.length === 1 ? this.classOf(rc[0]) : null;
      if (ce === null) { this.refuse('emit-on', 'emitter receiver is not exactly one project class', `${fid}:${o.line}`, `${pyRepr(v)} on ${pyRepr(rc)}`); continue; }
      const matches = [];
      for (const [lfid, , lo] of lisBy.get(v) ?? []) {
        const lrc = lo.rc ?? [];
        const cl = lrc.length === 1 ? this.classOf(lrc[0]) : null;
        if (cl === null) { this.refuse('emit-on', 'listener receiver is an interface, a union or an outside type', `${lfid}:${lo.line}`, `${pyRepr(v)} on ${pyRepr(lrc)}`); continue; }
        if (cl !== ce && !mro(P, cl).includes(ce)) continue; // a different class: the same string, not the same event
        const [h, why] = this.handlerOf(lfid, lo);
        if (!h) { this.refuse('emit-on', why, `${lfid}:${lo.line}`, `${pyRepr(v)} on ${pyRepr(lrc)}`); continue; }
        if (h === fid) continue;
        matches.push([lfid, lo, h, cl === ce ? 'same class' : 'listener class inherits the emitter class']);
      }
      if (matches.length > cap) { this.refuse('emit-on', `more than ${cap} listeners: a hub, not a link`, `${fid}:${o.line}`, pyRepr(v)); continue; }
      for (const [lfid, lo, h, how] of matches) {
        this.add('emit-on', fid, nd, o, h, 'linked', `exact event name ${pyRepr(v)}; both receivers are the project class ${rc[0].split('::')[1]} (${how})`,
          { from: { path: P.fns.get(fid).path, line: o.line, receiver: rc[0], literal: v }, to: { path: P.fns.get(lfid).path, line: lo.line, receiver: (lo.rc?.length ? lo.rc : [null])[0], handler: h } }, `emits ${pyRepr(v)}`, v);
      }
    }
  }

  // ---- Redis key patterns --------------------------------------------------------------------------------------------
  /** Lua only: `rcall("SET", <prefix> .. ":lock")` in one function and `rcall("GET", <prefix> .. ":lock")` in another, with the SAME prefix expression
   *  text, one writer function and 1 to maxFns readers. A suffix on different prefixes is a shared string, not a key: refused. Everything else about
   *  a key (KEYS[n], a variable) carries no literal and is never linked. */
  ruleRedisKeys(maxFns = MAX_REDIS_FUNCTIONS) {
    const P = this.P;
    const by = new Map(); // suffix literal -> [{fid, nd, o, prefix, write}]
    const total = new Map();
    for (const fid of P.fids) {
      const fn = P.fns.get(fid);
      if (fn.lang !== 'lua') continue;
      for (const nd of fn.nodes) {
        for (const o of nd.ops ?? []) {
          if (o.t !== 'call' || !o.rdc) continue;
          count(total, 'redis calls');
          const kx = o.kx ?? '';
          const kl = o.kl ?? [];
          if (kx.startsWith('KEYS[')) count(total, 'key is KEYS[n]');
          else if (kl.length && kx.includes('..')) {
            count(total, 'key built with a literal');
            const suf = kl[kl.length - 1];
            const prefix = kx.slice(0, kx.lastIndexOf('..')).replace(new RegExp(`^[${PYWS}]+|[${PYWS}]+$`, 'g'), '');
            if (suf.startsWith(':') && suf.length >= MIN_KEY_SUFFIX) pushTo(by, suf, { fid, nd, o, prefix, write: (o.eff ?? []).includes('store') });
          } else if (/^[\p{L}\p{N}]+$/u.test(kx.replaceAll('_', ''))) count(total, 'key is a variable');
        }
      }
    }
    for (const [k, v] of total) count(this.looked, 'lua ' + k, v);
    for (const suf of sorted(by.keys())) {
      const rows = by.get(suf);
      const prefixes = new Set(rows.map((r) => r.prefix));
      const fns = new Set(rows.map((r) => r.fid));
      const ws = rows.filter((r) => r.write);
      const rs = rows.filter((r) => !r.write);
      if (prefixes.size > 1) this.refuse('redis-key', `suffix ${pyRepr(suf)} is used with ${prefixes.size} different key prefixes`, suf, sorted(prefixes).join(', '));
      else if (new Set(ws.map((r) => r.fid)).size !== 1 || !rs.length || fns.size > maxFns) {
        this.refuse('redis-key', `suffix ${pyRepr(suf)}: need exactly one writer function and a reader, in at most ${maxFns} functions`, suf, `${ws.length} writes, ${rs.length} reads, ${fns.size} functions`);
      } else {
        const w = ws[0];
        for (const r of rs) {
          if (r.fid !== w.fid) {
            this.add('redis-key', w.fid, w.nd, w.o, r.fid, 'linked', `same key expression ${w.prefix} .. ${pyRepr(suf)} written in one function and read in another`,
              { from: { path: P.fns.get(w.fid).path, line: w.o.line, key: w.prefix + ' .. ' + suf }, to: { path: P.fns.get(r.fid).path, line: r.o.line, key: r.prefix + ' .. ' + suf } }, `writes ${suf}`, suf);
          }
        }
      }
    }
  }
}

export const RULES = [(L) => L.ruleScriptByName(), (L) => L.ruleEmitOn(), (L) => L.ruleRedisKeys(), ruleHttpRoutes];

/** Run the link rules on a resolved project; adds link ops; returns the Links object (rows, open ends, summary). */
export function applyLinks(P, root = null, routeFacts = null, rules = RULES) {
  const L = new Links(P, root);
  L.routeFacts = routeFacts;
  for (const r of rules) r(L);
  L.commit();
  return L;
}
