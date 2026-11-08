// Call roads and exception roads. Methods mixed into MapBuilder (mapbuild.mjs); every pass is a pure function of the graphs.
//
// The rule that governs everything here: a rule may hide a BOX, never a ROAD.
//   - A call site that sits inside any box, or on a folded run after one, gives that box a road to the callee: calls in `return`, in an `if` test,
//     in a loop header and in `finally` are not special.
//   - A callee with no box of its own does not exist for resolved calls: every function that takes part in one has a box (mapbuild.mjs), so each call has
//     its own road. Looking through a function with no box remains only for a function that could not be mapped, and says which functions it passed.
//   - Every resolved target of a call gets its road, the own method and each override alike. Never just the first.
//   - An exception that a call or a `raise` can send to a handler gets a road to that handler, tiered:
//     proven = a typed witness (a `raise T`, a resolved callee's escaping type, a known external raiser) that the handler catches;
//     may    = only an opaque call that could raise something, or an `except*` group handler (partial match by definition).
import { replaceable } from './lookup.mjs';
import { isStub } from './noreturn.mjs';
import { subclassesDefining } from './classes.mjs';
import { cmp, sorted, uniq } from './pyrt.mjs';
import { tkey } from './canon.mjs';

export const EXACT = new Set(['exact', 'self', 'typed']);
const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);

const byLineThenId = (a, b) => cmp([a.prov.line, a.id], [b.prov.line, b.id]);

export const RoadMethods = {
  setupPasses() {
    const P = this.P;
    this.G = new Map(); // fid -> sorted resolved callees (all targets)
    this.Gt = new Map(); // (caller, callee) -> proven | may | linked
    for (const fid of P.fids) {
      const s = new Set();
      for (const nd of P.fns.get(fid).nodes) {
        for (const o of nd.ops ?? []) {
          if (((o.t === 'call' || o.t === 'with') && o.to?.length && EXACT.has(o.how)) || (o.t === 'link' && o.to?.length)) {
            for (const g of o.to) {
              if (g !== fid && P.fns.has(g)) {
                s.add(g);
                const t = o.t === 'link' ? o.tier : (o.may ?? []).includes(g) ? 'may' : 'proven';
                if (this.Gt.get(tkey(fid, g)) !== 'proven') this.Gt.set(tkey(fid, g), t);
              }
            }
          }
        }
      }
      this.G.set(fid, sorted(s));
    }
    this.liftCache = new Map();
    this.ownCache = new Map(); // fid -> Map
    this.apredCache = new Map();
    this.finbCache = new Map();
    this.first = new Map();
    for (const b of [...this.boxes.values()].sort(byLineThenId)) if (!this.first.has(b.fn)) this.first.set(b.fn, b.id);
  },

  /** Did a type checker run for the language of function `fid`? (without one, nominal rules are only `may`) */
  resolversOf(fid) {
    return !!this.P.resolvers[this.P.mods.get(this.P.fns.get(fid).path).lang];
  },

  /** The mapped functions a call to g lands in: [[target, [dropped functions passed]]]. g itself when it has boxes. */
  lift(g, caller) {
    if (this.mapped.has(g)) return g !== caller ? [[g, []]] : [];
    if (!this.liftCache.has(g)) {
      const seen = new Map([[g, []]]);
      const out = [];
      const q = [g];
      while (q.length) {
        const x = q.shift();
        for (const y of this.G.get(x) ?? []) {
          if (seen.has(y)) continue;
          seen.set(y, [...seen.get(x), x]);
          if (this.mapped.has(y)) out.push([y, seen.get(y)]);
          else q.push(y);
        }
      }
      this.liftCache.set(g, out);
    }
    return this.liftCache.get(g).filter(([t]) => t !== caller);
  },

  /** Is function g an abstract method or one that only raises NotImplementedError, with at least one override in the project? */
  stubWithOverrides(g) {
    if (!this.stubCache) this.stubCache = new Map();
    if (!this.stubCache.has(g)) {
      const fn = this.P.fns.get(g);
      const name = fn.qual.slice(fn.qual.lastIndexOf('.') + 1).replace(/~\d+$/, '');
      this.stubCache.set(g, !!fn.cls && isStub(fn) && subclassesDefining(this.P, fn.cls, name).length > 0);
    }
    return this.stubCache.get(g);
  },

  /** node -> sorted [predecessor, edge label] over EVERY edge (normal, exception, finally, catch). */
  apred(fid) {
    if (!this.apredCache.has(fid)) {
      const d = new Map();
      const add = (b, a, l) => {
        if (!d.has(b)) d.set(b, new Map());
        d.get(b).set(`${a}\u0000${l}`, [a, l]);
      };
      for (const [a, b, l] of this.P.fns.get(fid).edges) add(b, a, l);
      for (const [a, rl] of this.red.get(fid).rland) { // a raise reaches its handlers and the finally blocks it passes
        for (const b of rl.caught) add(b, a, 'catch');
        for (const b of rl.finals) add(b, a, 'exc');
      }
      this.apredCache.set(fid, new Map([...d].map(([k, v]) => [k, sorted(v.values())])));
    }
    return this.apredCache.get(fid);
  },

  /** node -> the finally nodes whose finally BLOCK contains it (a node's `syn` starts with its finally's). */
  finbodies(fid) {
    if (!this.finbCache.has(fid)) {
      const nodes = this.P.fns.get(fid).nodes;
      const fes = nodes.filter((n) => n.k === 'final');
      const m = new Map();
      if (fes.length) for (const n of nodes) m.set(n.i, fes.filter((f) => f.i !== n.i && n.syn.startsWith(f.syn)).map((f) => f.i));
      this.finbCache.set(fid, m);
    }
    return this.finbCache.get(fid);
  },

  /** The boxes inside finally blocks that a return or an escaping raise at node x runs on its way out of the function, and the lines of those finally
   *  blocks: { hit: [box ids], lines }. Only nodes of finally blocks are walked: control that leaves a finally by its normal door is not this exit. */
  finWalk(fid, x) {
    const nodes = this.P.fns.get(fid).nodes;
    const r = this.red.get(fid);
    const fb = this.finbodies(fid);
    const n2b = this.n2b(fid);
    const inFin = (i) => nodes[i].k === 'final' || (fb.get(i) ?? []).length > 0;
    const hit = [];
    const lines = [];
    const seen = new Set([x]);
    const q = [x];
    while (q.length) {
      const y = q.shift();
      for (const [j] of r.S(y)) {
        if (seen.has(j) || !inFin(j)) continue;
        seen.add(j);
        if (nodes[j].k === 'final' && !lines.includes(nodes[j].line)) lines.push(nodes[j].line);
        if (n2b.has(j)) {
          if (!hit.includes(n2b.get(j))) hit.push(n2b.get(j));
          continue;
        }
        q.push(j);
      }
    }
    return { hit, lines };
  },

  /** The boxes a node belongs to: its own box, else the nearest boxes upstream across folded nodes. -> [box ids, anchor] with anchor in
   *  in | after | before (no box upstream, reached from the entry) | unplaced. With no box upstream the function's first box stands in, unless
   *  fallback is off. */
  owners(fid, n, fallback = true) {
    let cache = this.ownCache.get(fid);
    if (!cache) this.ownCache.set(fid, (cache = new Map()));
    const key = `${n}\u0000${fallback}`;
    if (cache.has(key)) return cache.get(key);
    const n2b = this.n2b(fid);
    const fn = this.P.fns.get(fid);
    let res;
    if (n2b.has(n)) res = [[n2b.get(n)], 'in'];
    else {
      const pr = this.apred(fid);
      const fb = this.finbodies(fid);
      const nodes = fn.nodes;
      // Walking back through a finally must leave it by the door it was entered by: control that leaves a finally normally came in normally, not by a
      // return or an exception (which leave by the return / exception door). `modes` remembers, per finally, which door the walk came out of.
      const enc = (modes) => JSON.stringify(modes);
      const seen = new Set([`${n}|${enc([])}`]);
      const q = [[n, []]];
      const hit = [];
      const seenNodes = new Set([n]);
      while (q.length) {
        const [x, modes] = q.shift();
        for (const [p, l] of pr.get(x) ?? []) {
          const m2 = new Map(modes);
          if (fb.size) {
            const fbx = fb.get(x) ?? [];
            for (const fe of fb.get(p) ?? []) {
              if (!fbx.includes(fe)) m2.set(fe, l === 'fin-ret' ? 'ret' : l === 'fin-exc' ? 'exc' : l === 'brk' || l === 'cont' ? 'jmp' : 'normal'); // p is inside the finally block, x is outside: the edge p -> x is how it was left
            }
            if (nodes[x].k === 'final') {
              const md = m2.has(x) ? m2.get(x) : 'any';
              m2.delete(x);
              if (md === 'normal' && ['ret', 'fin-ret', 'exc', 'unmatched', 'fin-exc', 'jmp'].includes(l)) continue;
              if (md === 'ret' && l !== 'ret' && l !== 'fin-ret') continue;
              if (md === 'exc' && !['exc', 'unmatched', 'fin-exc'].includes(l)) continue;
              if (md === 'jmp' && l !== 'jmp') continue;
            }
          }
          const items = sorted(m2.entries());
          const sk = `${p}|${enc(items)}`;
          if (seen.has(sk)) continue;
          seen.add(sk);
          seenNodes.add(p);
          if (n2b.has(p)) {
            if (!hit.includes(n2b.get(p))) hit.push(n2b.get(p));
          } else q.push([p, items]);
        }
      }
      res = hit.length ? [hit, 'after'] : [fallback && this.first.has(fid) ? [this.first.get(fid)] : [], seenNodes.has(fn.entry) ? 'before' : 'unplaced'];
    }
    cache.set(key, res);
    return res;
  },

  qual(fid) {
    return fid.slice(fid.indexOf('::') + 2);
  },

  /** The box that holds the node starting on `line` of function fid (the node itself, else the nearest one before it), or null. */
  boxAt(fid, line) {
    const nodes = this.P.fns.get(fid).nodes.filter((n) => !['entry', 'exit', 'xexit'].includes(n.k) && n.line <= line);
    if (!nodes.length) return null;
    const best = Math.max(...nodes.map((n) => n.line));
    for (const n of nodes.filter((x) => x.line === best).sort((a, b) => a.i - b.i)) {
      const [owners] = this.owners(fid, n.i);
      if (owners.length) return owners[0];
    }
    return null;
  },

  // ---- call roads ----------------------------------------------------------------------------------------------------------
  makeCallRoads(fid) {
    const fn = this.P.fns.get(fid);
    const r = this.red.get(fid);
    const grp = new Map(); // (owner box, target function, is link) -> merged evidence
    for (const nd of fn.nodes) {
      if (!r.reach.has(nd.i)) continue;
      for (const o of nd.ops ?? []) {
        const lk = o.t === 'link' && !!o.to?.length; // a link op: both ends anchored, tier `linked`
        for (const c of o.cbr ?? []) this.collectCallback(fid, nd, o, c, grp);
        if (!lk && (!(o.t === 'call' || o.t === 'with') || !o.to?.length || !EXACT.has(o.how))) continue;
        const own = o.own ?? null;
        for (const g of o.to) {
          const role = lk ? 'link' : g === own ? 'own' : own ? 'override' : 'target';
          let tier = lk ? o.tier : (o.may ?? []).includes(g) ? 'may' : 'proven';
          if (tier === 'proven' && !this.resolversOf(fid) && o.how !== 'exact') tier = 'may'; // no type checker for this language: a class-hierarchy rule is only nominal
          for (const [tf, via] of this.lift(g, fid)) {
            const [owners, anchor] = this.owners(fid, nd.i);
            let t2 = tier;
            const repl = lk ? null : [...via, tf].map((c) => replaceable(this.P, c)).find((x) => x) ?? null;
            const chain = [g, ...via];
            const next = [...via, tf];
            for (let z = 0; z < chain.length; z++) { // a hop through a dropped function is as strong as its weakest edge
              const a = chain[z];
              const b = next[z];
              const gt = this.Gt.get(tkey(a, b));
              if (a !== b && gt === 'may') t2 = 'may';
              else if (a !== b && gt === 'linked' && t2 === 'proven') t2 = 'linked';
            }
            if (repl && (t2 === 'proven' || t2 === 'linked')) t2 = 'may'; // what runs at run time may not be the body the resolver named
            const stub = !lk && this.stubWithOverrides(tf); // the body named only says a subclass supplies it; one of the overrides runs
            if (stub && (t2 === 'proven' || t2 === 'linked')) t2 = 'may';
            for (const ob of owners) {
              const k = tkey(ob, tf, lk ? 1 : 0);
              if (!grp.has(k)) grp.set(k, { ob, tf, lk, lines: [], how: o.how, role, anchor, via, direct: g, kind: nd.k, tier: t2, rs: o.rs ?? null, repl, stub });
              const e = grp.get(k);
              if (lk) (e.links ??= []).push(Object.fromEntries(['lid', 'kind', 'basis', 'when', 'lit', 'to_line'].filter((x) => Object.hasOwn(o, x)).map((x) => [x, o[x]])));
              if (t2 === 'proven' && e.role !== 'link') e.tier = 'proven';
              if (!e.lines.includes(o.line)) e.lines.push(o.line);
              if (role === 'own' || (role === 'target' && e.role === 'override')) e.role = role;
            }
          }
        }
      }
    }
    for (const e of [...grp.values()].sort((a, b) => cmp([a.ob, a.tf, a.lk ? 1 : 0], [b.ob, b.tf, b.lk ? 1 : 0]))) {
      const { ob, tf } = e;
      if (e.cb) {
        const tbc = this.entry.get(tf);
        if (!tbc) continue;
        const lnc = sorted(e.lines);
        const prov = { src: 'det', rule: 'call', fn: fid, line: lnc[0], lines: lnc, how: 'callback', role: e.role, anchor: e.anchor, tier: e.tier, basis: 'callback', callback: { kind: e.cb.kind, passed_to: e.cb.passedTo, arg: e.cb.arg, run: e.cb.run } };
        if (e.tier === 'may') prov.draw = 'thin';
        this.road(ob, tbc, 'forward', 'runs ' + this.qual(tf), `${fid}:${lnc[0]} hands ${tf} to ${e.cb.passedTo}${e.cb.run ? ', which calls it' : ''}`, prov);
        continue;
      }
      let tb = this.entry.get(tf);
      const tl = (e.links ?? []).map((x) => x.to_line).filter((x) => x);
      if (tl.length && tf === e.direct) tb = this.boxAt(tf, Math.min(...tl)) || tb; // a link that lands on one comparison inside a big function (an `if path == "/x"` arm)
      if (!tb) continue;
      const ln = sorted(e.lines);
      let why = `${fid}:${ln[0]} calls ${e.direct}` + (e.via.length ? ` which reaches ${tf} through ${e.via.slice(0, 3).map((v) => this.qual(v)).join(', ')}` : '');
      const prov = { src: 'det', rule: 'call', fn: fid, line: ln[0], lines: ln, how: e.how, role: e.role, anchor: e.anchor, tier: e.tier, basis: e.rs === 'project' ? 'resolver' : 'lexical' };
      if (e.links) { // tier `linked`: not a call; the anchors travel with the road
        const lkr = sorted(e.links, (x) => x.lid);
        Object.assign(prov, { rule: 'link', basis: lkr[0].basis, link_kind: lkr[0].kind, link_ids: lkr.map((x) => x.lid) });
        if (lkr[0].lit) prov.lit = lkr[0].lit;
        why = `${fid}:${ln[0]} ${lkr[0].when} -> ${tf}: ${lkr[0].basis}`;
        this.road(ob, tb, 'forward', lkr[0].when, why, prov);
        continue;
      }
      if (e.tier === 'may') prov.draw = 'thin';
      if (e.repl) prov.replaceable = e.repl;
      if (e.stub) prov.stub_with_overrides = true;
      if (e.via.length) prov.via = e.via.slice(0, 4);
      this.road(ob, tb, 'forward', 'calls ' + this.qual(tf), why, prov);
    }
  },

  /** A function value handed to a call gets a road from the box holding the call to the box of that function: the callee runs it. It is `proven`
   *  when the callee is a project function that calls that parameter and the name leaves no other body that could run; `may` for anything weaker. */
  collectCallback(fid, nd, o, c, grp) {
    for (const g of c.to) {
      if (g === fid || !this.P.fns.has(g)) continue;
      const [owners, anchor] = this.owners(fid, nd.i);
      let tier = c.run && c.to.length === 1 ? 'proven' : 'may';
      if (tier === 'proven' && c.kind === 'named' && c.how !== 'exact' && !this.resolversOf(fid)) tier = 'may'; // no type checker for this language: a class-hierarchy rule is only nominal
      const role = g === c.own ? 'callback' : 'callback-override';
      for (const ob of owners) {
        const k = tkey(ob, g, 2);
        if (!grp.has(k)) grp.set(k, { ob, tf: g, lk: false, cb: { kind: c.kind, passedTo: o.f ?? '?', arg: c.arg, run: c.run }, lines: [], role, anchor, tier, via: [], direct: g });
        const e = grp.get(k);
        if (tier === 'proven') e.tier = 'proven';
        if (!e.lines.includes(o.line)) e.lines.push(o.line);
      }
    }
  },

  // ---- exception roads -----------------------------------------------------------------------------------------------------
  /** The boxes a handler stands for: its own box, else the first boxes inside its body (bodies with no box: []). */
  handlerTargets(fid, h) {
    const n2b = this.n2b(fid);
    if (n2b.has(h)) return [n2b.get(h)];
    const nodes = this.P.fns.get(fid).nodes;
    const r = this.red.get(fid);
    const inside = (i) => {
      let x = nodes[i].h ?? null;
      while (x !== null) {
        if (x === h) return true;
        x = nodes[x].h ?? null;
      }
      return false;
    };
    const seen = new Set([h]);
    const q = [h];
    const hit = [];
    while (q.length) {
      const x = q.shift();
      for (const [y] of r.S(x)) {
        if (seen.has(y) || !inside(y)) continue;
        seen.add(y);
        if (n2b.has(y)) {
          if (!hit.includes(n2b.get(y))) hit.push(n2b.get(y));
        } else q.push(y);
      }
    }
    return hit;
  },

  makesRoad(o) {
    return ((o.t === 'call' || o.t === 'with') && o.to?.length && EXACT.has(o.how)) || (o.t === 'link' && o.to?.length) || !!o.cbr?.length;
  },

  /** The functions a resolved call, link or `with` op goes to (not the function values it hands over). */
  callEnds(o) {
    return ((o.t === 'call' || o.t === 'with') && o.to?.length && EXACT.has(o.how)) || (o.t === 'link' && o.to?.length) ? o.to : [];
  },

  /** Every function an op draws a road to: the targets of the call, and the function values it hands over. */
  endsOf(o) {
    return [...this.callEnds(o), ...(o.cbr ?? []).flatMap((c) => c.to)];
  },

  /** A call that sits above every box of its function (no box between the function's start and the call) would otherwise hang its road from the
   *  function's first box, which may run after the call, or instead of it. The straight run that holds such a call gets a small box of its own, so
   *  the road starts where the call is. Runs are taken in order, and a later run that now has this box upstream hangs from it. */
  makeStartBoxes(fid) {
    const nodes = this.P.fns.get(fid).nodes;
    const n2b = this.n2b(fid);
    let made = false;
    for (const [c] of this.steps.get(fid)) {
      if (c.some((i) => n2b.has(i))) continue;
      const hot = c.filter((i) => (nodes[i].ops ?? []).some((o) => this.makesRoad(o)));
      if (!hot.length) continue;
      const [ow, an] = this.owners(fid, hot[0], false);
      if (ow.length || an !== 'before') continue;
      const ns = c.map((i) => nodes[i]);
      const roadOps = ns.flatMap((nd) => (nd.ops ?? []).filter((o) => this.makesRoad(o)));
      const calls = uniq(roadOps.flatMap((o) => this.endsOf(o).map((g) => g.split('::')[1])));
      const line = roadOps[0].line;
      const last = ns[ns.length - 1];
      const b = this.mk(fid, 's', ns[0], 'step', 'begins ; calls ' + calls.slice(0, 3).join(', '), 'step',
        { effects: [], nodes: ns.map((n) => n.i).slice(0, 40), folded_lines: [ns[0].line, last.eline ?? last.line] }, line);
      for (const i of c) n2b.set(i, b);
      this.ownCache.delete(fid);
      made = true;
    }
    if (made) this.first.set(fid, this.firstBoxOf(fid));
  },

  firstBoxOf(fid) {
    return [...this.boxes.values()].filter((x) => x.fn === fid).sort(byLineThenId)[0].id;
  },

  /** A handler needs something to come from. When the code that can send it an exception is all folded and nothing visible precedes it (a try at
   *  the top of a function, around calls the reduction found no work in), give that code one small box, `tries <calls>`, so the road `on <Type>`
   *  has a start. */
  makeTryBoxes(fid) {
    const nodes = this.P.fns.get(fid).nodes;
    const tab = this.F.excTable(fid);
    const byH = new Map();
    for (const { n, h } of tab.values()) {
      if (!byH.has(h)) byH.set(h, new Set());
      byH.get(h).add(n);
    }
    const n2b = this.n2b(fid);
    for (const h of [...byH.keys()].sort((a, b) => a - b)) {
      const tgt = this.handlerTargets(fid, h);
      if (!tgt.length) continue;
      let lonely = [...byH.get(h)].sort((a, b) => a - b).filter((n) => !this.owners(fid, n, false)[0].some((o) => !tgt.includes(o)));
      lonely = lonely.filter((n) => !n2b.has(n));
      if (!lonely.length) continue;
      const calls = uniq(lonely.flatMap((n) => (nodes[n].ops ?? []).filter((o) => o.t === 'call' && o.f).map((o) => o.f)));
      const nd = nodes[lonely[0]];
      const ln = [nd.line, Math.max(...lonely.map((n) => nodes[n].eline ?? nodes[n].line))];
      const b = this.mk(fid, 't', nd, 'step', 'tries ' + calls.slice(0, 3).join(', '), 'try', { nodes: lonely.slice(0, 40), folded_lines: ln, handler_line: nodes[h].line });
      for (const n of lonely) n2b.set(n, b);
      this.ownCache.delete(fid);
      this.first.set(fid, this.firstBoxOf(fid));
    }
  },

  makeExcRoads(fid) {
    const fn = this.P.fns.get(fid);
    const r = this.red.get(fid);
    const hs = fn.nodes.filter((n) => n.k === 'handler' && r.reach.has(n.i)).map((n) => n.i);
    if (!hs.length) return;
    const tgt = new Map(hs.map((h) => [h, this.handlerTargets(fid, h)]));
    const tab = this.F.excTable(fid);
    const grp = new Map();
    const folded = new Map();
    for (const e of [...tab.values()].sort((a, b) => cmp([a.n, a.h], [b.n, b.h]))) {
      const { n, h } = e;
      const hn = fn.nodes[h];
      const tier = e.sure && !hn.star ? 'proven' : 'may';
      const [owners, anchor] = this.owners(fid, n);
      if (!tgt.get(h).length) {
        for (const ob of owners) if (!folded.has(tkey(ob, h))) folded.set(tkey(ob, h), { ob, h, tier });
        continue;
      }
      for (const ob of owners) {
        for (const tb of tgt.get(h)) {
          if (ob === tb) continue;
          const k = tkey(ob, tb);
          if (!grp.has(k)) grp.set(k, { ob, tb, typed: [], untyped: [], anchor, h, tier: 'may' });
          const g = grp.get(k);
          g.typed.push(...e.typed);
          g.untyped.push(...e.untyped);
          if (tier === 'proven') g.tier = 'proven';
        }
      }
    }
    for (const g of [...grp.values()].sort((a, b) => cmp([a.ob, a.tb], [b.ob, b.tb]))) {
      const ty = uniq(g.typed.map((x) => x[0]));
      const uniqTyped = new Map(g.typed.map((x) => [JSON.stringify(x), x]));
      const wit = sorted(uniqTyped.values(), (x) => [x[2], x[0], x[1], x[3]]).slice(0, 3).map(([t, k, ln, via]) => ({ type: t, kind: k, line: ln, ...(via ? { via } : {}) }));
      const line = wit.length ? wit[0].line : sorted(g.untyped)[0];
      const hl = fn.nodes[g.h].line;
      const shown = ty.map((t) => (t === '*' ? 'any error' : t));
      const when = g.tier === 'proven' ? 'on ' + shown.slice(0, 2).join('/') + (shown.length > 2 ? '+' : '') : 'if it fails';
      const why = `${fid}:${line} ` + (ty.length ? `can raise ${ty.slice(0, 3).join(', ')}` : 'calls something that may raise') + `; the handler at line ${hl} takes it`;
      const prov = { src: 'det', rule: 'exc-edge', fn: fid, line, tier: g.tier, anchor: g.anchor, handler_line: hl };
      if (wit.length) prov.witness = wit;
      if (g.untyped.length) prov.untyped_call_lines = sorted(new Set(g.untyped)).slice(0, 4);
      const dup = this.cfgpairs.get(tkey(g.ob, g.tb));
      if (dup) { // an arm already leads there (a raise statement on that arm): say so on it
        const pv = this.roads.get(dup[0]).prov;
        if (!Object.hasOwn(pv, 'exc')) pv.exc = { tier: g.tier, witness: wit };
        continue;
      }
      this.road(g.ob, g.tb, 'forward', when, why, prov);
    }
    for (const { ob, h, tier } of [...folded.values()].sort((a, b) => cmp([a.ob, a.h], [b.ob, b.h]))) { // a handler with no box of its own: the owner records the failure path
      const pv = this.boxes.get(ob).prov;
      (pv.folded_handlers ??= []).push({ line: fn.nodes[h].line, types: fn.nodes[h].types ?? null, tier });
    }
  },
};
