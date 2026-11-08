// Exception flow across calls: where each raise lands, who calls whom, and what each handler does with the news (handlers.mjs).
// Every claim carries the raise site, the call chain and the handler line that prove it.
import { BUILTIN_EXCEPTIONS } from './pybuiltins.mjs';
import { raisesOf } from './effects.mjs';
import { cmp, sorted } from './pyrt.mjs';
import { tkey } from './canon.mjs';
import { HandlerMethods } from './handlers.mjs';
import { PassMethods } from './excpass.mjs';

const BASE_ONLY = new Set(['KeyboardInterrupt', 'SystemExit', 'GeneratorExit', 'CancelledError']);
const EXC_EDGE = new Set(['exc', 'unmatched', 'fin-exc']);
const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);

export class Flow {
  constructor(P) {
    this.P = P;
    this.out = new Map(); // fid -> node -> [[dst, label]]
    this.callers = new Map(); // fid -> [[caller fid, node i, line, how, tier]]
    this.candCallers = new Map(); // same, but only CANDIDATE call sites (by-name, structural): possible callers, no road
    this.clsBases = new Map();
    this.amb = new Set(); // class names that two project classes share: the name alone does not say which one is meant
    this.clsAll = new Map();
    this._chain = new Map();
    this.floating = new Set(); // (caller fid, node, callee fid) of a call of an async function that is not awaited: it raises nothing at the call
    this._anc = new Map();
    this.esc = new Map(); // fid -> Map type -> witness
    this.hsrc = new Map(); // (fid, handler i) -> {fid, h, srcs: [[type, origin]]}
    this.opaque = new Map(); // (fid, handler i) -> unresolved calls in its try body
    for (const k of [...P.classes.keys()].sort(cmp)) {
      const c = P.classes.get(k);
      const b = c.bases.map(lastDot);
      if (this.clsBases.has(c.name) && !sameList(this.clsBases.get(c.name), b)) this.amb.add(c.name);
      if (!this.clsBases.has(c.name)) this.clsBases.set(c.name, b);
    }
    for (const k of [...P.classes.keys()].sort(cmp)) {
      const c = P.classes.get(k);
      if (this.amb.has(c.name)) {
        if (!this.clsAll.has(c.name)) this.clsAll.set(c.name, []);
        this.clsAll.get(c.name).push(c.bases.map(lastDot));
      }
    }
  }

  // ---- type relations -------------------------------------------------------------------------------------------------
  ancestors(t0) {
    const t = lastDot(t0 || '');
    if (this._anc.has(t)) return this._anc.get(t);
    const seen = [];
    const q = [t];
    while (q.length) {
      const x = q.shift();
      if (seen.includes(x)) continue;
      seen.push(x);
      if (this.amb.has(x)) for (const bl of this.clsAll.get(x)) q.push(...bl); // two classes of this name: every base of either may apply
      else if (this.clsBases.has(x)) q.push(...this.clsBases.get(x));
      else if (BUILTIN_EXCEPTIONS.has(x)) q.push(...BUILTIN_EXCEPTIONS.get(x));
    }
    if (!this.knownChain(t)) for (const x of ['Exception', 'BaseException']) if (!seen.includes(x)) seen.push(x); // a base the project cannot see: assumed a library error
    this._anc.set(t, seen);
    return seen;
  }

  /** Is `name` a class the project defines or the language ships as an exception? */
  knownClass(name) {
    const n = lastDot(name || '');
    return this.clsBases.has(n) || BASE_ONLY.has(n) || BUILTIN_EXCEPTIONS.has(n);
  }

  /** Is every class in the ancestry of `t` one the project defines or the language ships? False for a library class or a project class with a library base. */
  knownChain(t0) {
    const t = lastDot(t0 || '');
    if (this._chain.has(t)) return this._chain.get(t);
    const seen = new Set();
    const q = [t];
    let ok = true;
    while (q.length) {
      const x = q.shift();
      if (seen.has(x)) continue;
      seen.add(x);
      if (this.amb.has(x)) for (const bl of this.clsAll.get(x)) q.push(...bl);
      else if (this.clsBases.has(x)) q.push(...this.clsBases.get(x));
      else if (!this.knownClass(x)) ok = false;
    }
    this._chain.set(t, ok);
    return ok;
  }

  /** Can the text of an `except` type be read as one class? A bare builtin exception or project class name; a dotted name only when its last part is a
   *  project class. A variable, a call, a library class (it may be an alias of a builtin), a class attribute and a name bound inside the function are not. */
  knownHandlerType(u, locs) {
    if (u === '*') return true;
    if (!u.includes('.') && locs.has(u)) return false;
    if (u.includes('.')) return this.clsBases.has(lastDot(u)) || u.startsWith('builtins.');
    return this.knownClass(lastDot(u));
  }

  /** Does a handler of `types` take an exception of class `t`? 'yes' | 'maybe' | 'no'. 'maybe' when the handler names something that is not plainly a
   *  class (so it could be any class), or the raised class has a base the project cannot see and the handler names a class that base may be. */
  catchKind(types, t, locs) {
    if (types.includes('*')) return 'yes';
    const anc = this.ancestors(t);
    let unknown = false;
    for (const u of types) {
      const last = lastDot(u);
      if (!u.includes('.') && locs.has(u)) { unknown = true; continue; }
      if (anc.includes(last) || ((last === 'IOError' || last === 'EnvironmentError') && anc.includes('OSError'))) return 'yes';
      if (!this.knownHandlerType(u, locs)) unknown = true;
    }
    return unknown || !this.knownChain(t) ? 'maybe' : 'no';
  }

  /** Does a handler of `types` catch type `t` whichever class of that name is meant? (an ambiguous name: only when every one of them says so) */
  sureCatches(types, t) {
    if (types.includes('*')) return true;
    const tl = lastDot(t);
    if (!this.amb.has(tl)) return this.catches(types, t);
    for (const bl of this.clsAll.get(tl)) {
      const seen = [];
      const q = [tl, ...bl];
      while (q.length) {
        const x = q.shift();
        if (seen.includes(x)) continue;
        seen.push(x);
        if (this.clsBases.has(x) && !this.amb.has(x)) q.push(...this.clsBases.get(x));
        else if (BUILTIN_EXCEPTIONS.has(x)) q.push(...BUILTIN_EXCEPTIONS.get(x));
      }
      if (!types.some((u) => seen.includes(lastDot(u)))) return false;
    }
    return true;
  }

  catches(types, t) {
    if (types.includes('*')) return true;
    const anc = this.ancestors(t);
    for (const u0 of types) {
      const u = lastDot(u0);
      if (anc.includes(u)) return true;
      if ((u === 'IOError' || u === 'EnvironmentError') && anc.includes('OSError')) return true;
    }
    return false;
  }

  // ---- graph helpers -------------------------------------------------------------------------------------------------
  adj(fid) {
    let d = this.out.get(fid);
    if (!d) {
      d = new Map();
      for (const [a, b, l] of this.P.fns.get(fid).edges) {
        if (!d.has(a)) d.set(a, []);
        d.get(a).push([b, l]);
      }
      this.out.set(fid, d);
    }
    return d;
  }

  /** Where exception type t, arising at node n, ends up: [['caught', handler node, only_maybe]] and ['escapes'] when it can leave the function.
   *  An empty list means a `finally` that returns swallows it: it neither reaches a handler nor leaves. */
  land(fid, n, t) {
    const r = this.landFull(fid, n, t);
    const res = r.caught.map((h) => ['caught', h, r.maybe.includes(h)]);
    if (r.escapes) res.push(['escapes']);
    return res;
  }

  /** Where an exception of type t raised at node n goes inside this function: {caught: [handler nodes], maybe, finals: [finally nodes it passes
   *  through], escapes}. A raise that is caught here and nowhere escapes is a jump to the handler, not an ending of the function; one that a
   *  `finally: return` swallows has caught == [] and escapes == false. anyt means the type is unknown: every handler on the way may catch it, and
   *  only a catch-all stops it. */
  landFull(fid, n, t, anyt = false) {
    const fn = this.P.fns.get(fid);
    const nodes = fn.nodes;
    const ad = this.adj(fid);
    const adOf = (x) => ad.get(x) ?? [];
    const caught = [];
    let maybe = [];
    const finals = [];
    const work = [n];
    const done = new Set();
    const locs = new Set([...(fn.locs ?? []), ...(fn.lcls ?? [])]);
    let esc = !adOf(n).some(([, l]) => l === 'exc'); // a node with no exception edge at all sits outside every try: whatever it raises leaves the function
    const follow = (dst) => {
      if (done.has(dst)) return;
      done.add(dst);
      const k = nodes[dst].k;
      if (k === 'xexit') esc = true;
      else if (k === 'disp') {
        const hs = adOf(dst).filter(([, hl]) => hl === 'exc').map(([h]) => [h, nodes[h]]);
        let hit = [];
        let stop = false;
        if (anyt) {
          hit = hs.map(([h]) => h);
          stop = hs.some(([, nd]) => (nd.types ?? ['*']).includes('*') || (nd.types ?? []).includes('BaseException'));
        } else {
          for (const [h, nd] of hs) {
            const k2 = this.catchKind(nd.types ?? ['*'], t, locs);
            if (k2 === 'no') continue;
            hit.push(h);
            if (k2 === 'maybe') {
              if (!maybe.includes(h)) maybe.push(h);
            } else { stop = true; break; }
          }
        }
        for (const h of hit) {
          if (!caught.includes(h)) caught.push(h);
          this.rethrow(fid, h, work);
        }
        if (!stop) for (const [d2, l2] of adOf(dst)) if (l2 === 'unmatched') follow(d2);
      } else if (k === 'final') {
        if (!finals.includes(dst)) finals.push(dst);
        const pre = nodes[dst].syn;
        for (const [a, b, l] of fn.edges) if (l === 'fin-exc' && nodes[a].syn.startsWith(pre)) follow(b);
      } else work.push(dst);
    };
    const seen = new Set();
    while (work.length) {
      const x = work.shift();
      if (seen.has(x)) continue;
      seen.add(x);
      for (const [dst, l] of adOf(x)) if (EXC_EDGE.has(l)) follow(dst);
    }
    maybe = maybe.filter((h) => caught.includes(h));
    return { caught, maybe, finals, escapes: esc };
  }

  /** landFull for a raise statement. A bare `raise` (or `raise err` of the handler's own variable) re-throws what its handler caught, so it
   *  travels as the handler's declared types; an unknown type `*` is caught only by catch-alls. */
  raiseLanding(fid, nd) {
    if (nd.sw) return { caught: [], maybe: [], finals: [], escapes: false }; // raised inside a `with` whose manager swallows it
    const t = nd.exc;
    if (t) return this.landFull(fid, nd.i, lastDot(t));
    const h = nd.h ?? null;
    const ts = h !== null ? this.P.fns.get(fid).nodes[h].types ?? ['*'] : ['*'];
    if (ts.includes('*')) return this.landFull(fid, nd.i, '*', true);
    const out = { caught: [], maybe: [], finals: [], escapes: false };
    for (const u of ts) {
      const r = this.landFull(fid, nd.i, lastDot(u));
      for (const k of ['caught', 'maybe', 'finals']) for (const x of r[k]) if (!out[k].includes(x)) out[k].push(x);
      out.escapes = out.escapes || r.escapes;
    }
    return out;
  }

  /** A call that could raise anything and about which nothing is known, or a yield (the caller of a generator can throw into it). */
  isOpaque(o) {
    return (o.t === 'call' || o.t === 'yield') && !o.to?.length && o.how !== 'builtin' && !raisesOf(o)[1];
  }

  /** For one function: Map of (node, handler node) -> {typed: [[type, kind, line, via]], untyped: [line], sure}.
   *  typed = a raise statement, a resolved callee's escaping type, or a known external raiser lands in that handler.
   *  untyped = an opaque call sits in the try body: it may raise something this handler may catch. */
  excTable(fid) {
    const fn = this.P.fns.get(fid);
    const tab = new Map();
    const entry = (n, h) => {
      const k = tkey(n, h);
      if (!tab.has(k)) tab.set(k, { n, h, typed: [], untyped: [], sure: false });
      return tab.get(k);
    };
    for (const [n, t, org] of this.sources(fid)) {
      const lf = this.landFull(fid, n, t);
      for (const h of lf.caught) {
        const e = entry(n, h);
        let kind = org.kind;
        if (this.amb.has(lastDot(t)) && !this.sureCatches(fn.nodes[h].types ?? ['*'], t)) kind = kind === 'raise' ? 'raise?' : 'call?'; // two classes share the name and only some are caught here
        if (kind !== 'call?' && kind !== 'raise?' && !lf.maybe.includes(h)) e.sure = true; // a witness this handler surely takes
        e.typed.push([t, kind, Number(org.at.slice(org.at.lastIndexOf(':') + 1)), org.via || org.call || '']);
      }
    }
    const hasExc = new Set(fn.edges.filter((e) => e[2] === 'exc').map((e) => e[0]));
    for (const nd of fn.nodes) {
      if (!hasExc.has(nd.i)) continue;
      const ops = (nd.ops ?? []).filter((o) => this.isOpaque(o));
      if (!ops.length) continue;
      for (const h of this.landFull(fid, nd.i, '*', true).caught) entry(nd.i, h).untyped.push(...ops.map((o) => o.line));
    }
    return tab;
  }

  /** Nodes control can run to from handler node h (normal edges), to the end of the function. */
  reachFrom(fid, h) {
    const fn = this.P.fns.get(fid);
    const succ = new Map();
    for (const [a, b, l] of fn.edges) {
      if (EXC_EDGE.has(l)) continue;
      if (!succ.has(a)) succ.set(a, []);
      succ.get(a).push(b);
    }
    const seen = new Set([h]);
    const work = [h];
    while (work.length) for (const y of succ.get(work.pop()) ?? []) if (!seen.has(y)) { seen.add(y); work.push(y); }
    return [...seen].sort((a, b) => a - b).map((i) => fn.nodes[i]);
  }

  /** Project functions called from the try body that handler node h guards. */
  tryBodyCallees(fid, h) {
    const fn = this.P.fns.get(fid);
    const ad = this.adj(fid);
    const out = new Set();
    for (const [a, b, l] of fn.edges) {
      if (l === 'exc' && fn.nodes[b].k === 'disp' && (ad.get(b) ?? []).some(([hh, hl]) => hl === 'exc' && hh === h)) {
        for (const o of fn.nodes[a].ops ?? []) if (o.t === 'call') for (const g of o.to ?? []) out.add(g);
      }
    }
    return sorted(out);
  }

  rethrow(fid, h, work) {
    const nodes = this.P.fns.get(fid).nodes;
    const v = nodes[h].var ?? null;
    for (const nd of nodes) if (nd.k === 'raise' && (nd.h ?? null) === h && ((nd.exc ?? null) === null || nd.exc === v)) work.push(nd.i);
  }

}

Object.assign(Flow.prototype, HandlerMethods, PassMethods);

function sameList(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
