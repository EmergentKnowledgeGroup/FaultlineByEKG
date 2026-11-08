// The whole-program passes of Flow (excflow.mjs): the caller index, what each function lets escape, and the walk up the call graph to see who hears a raise.
// These are mixed into Flow; they read the type relations and landing rules defined there.
import { raisesOf } from './effects.mjs';
import { cmp, sorted, PYWS, PYW } from './pyrt.mjs';
import { Neg } from './negclaims.mjs';
import { tkey } from './canon.mjs';
import { isGen } from './lookup.mjs';

const ITERATION_SIGNALS = new Set(['StopIteration', 'StopAsyncIteration']); // raised by next() at the end of an iterator: whether it is at the end depends on the data
const LOCKISH = new RegExp(`(^|[.${PYWS}])_?[${PYW}]*(lock|mutex|cond|condition|sem|semaphore|guard)[${PYW}]*$`, 'iu');
const EXACT = new Set(['exact', 'self', 'typed']);
const WAITISH = (e) => e.startsWith('wait') || e.startsWith('ext');
const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);

export const PassMethods = {
  // ---- the whole-program pass ----------------------------------------------------------------------------------------------
  run() {
    const P = this.P;
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    for (const fid of P.fids) {
      for (const n of P.fns.get(fid).nodes) {
        for (const o of n.ops ?? []) {
          const may = o.may ?? [];
          for (const g of o.to ?? []) push(this.callers, g, [fid, n.i, o.line, o.how ?? null, may.includes(g) ? 'may' : 'proven']);
          for (const g of o.cand ?? []) push(this.candCallers, g, [fid, n.i, o.line, o.how ?? null]);
        }
      }
    }
    const own = new Map();
    for (const fid of P.fids) {
      this.esc.set(fid, new Map());
      const s = new Set();
      for (const n of P.fns.get(fid).nodes) for (const o of n.ops ?? []) for (const e of o.eff ?? []) if (e !== 'lockwith') s.add(e);
      own.set(fid, s);
    }
    this.own = own;
    this.blocking = new Map(); // (fid, ctx text) -> {fid, ctx, what, line, f}: a lock held across a wait / external call
    this.fx2 = new Map();
    for (const fid of P.fids) {
      const s = new Set(own.get(fid));
      for (const n of P.fns.get(fid).nodes) for (const o of n.ops ?? []) for (const g of o.to ?? []) for (const e of own.get(g) ?? []) s.add(e);
      this.fx2.set(fid, s);
    }
    for (const fid of P.fids) {
      for (const n of P.fns.get(fid).nodes) {
        for (const o of n.ops ?? []) {
          if (!o.held?.length) continue;
          const kinds = new Set((o.eff ?? []).filter(WAITISH));
          for (const g of o.to ?? []) for (const e of this.fx2.get(g) ?? []) if (WAITISH(e)) kinds.add(e);
          if (!kinds.size) continue;
          for (const ctx of o.held) {
            if (!LOCKISH.test(ctx)) continue;
            const k = tkey(fid, ctx);
            if (!this.blocking.has(k)) this.blocking.set(k, { fid, ctx, what: sorted(kinds)[0], line: o.line, f: o.f ?? null });
          }
        }
      }
    }
    for (let i = 0; i < 12; i++) {
      let changed = false;
      for (const fid of P.fids) changed = this.localPass(fid, false) || changed;
      if (!changed) break;
    }
    for (const fid of P.fids) this.localPass(fid, true);
    this.neg = new Neg(P, this); // needs the finished caller index
  },

  /** [node, type, origin] for every raise and every call that can raise, in node order. A generator body that lets StopIteration out raises RuntimeError. */
  *sources(fid) {
    const pyGen = this.P.fns.get(fid).lang === 'py' && isGen(this.P, fid);
    for (const [n, t, org] of this._sources(fid)) yield [n, pyGen && ITERATION_SIGNALS.has(t) ? 'RuntimeError' : t, org];
  },

  *_sources(fid) {
    const P = this.P;
    const fn = P.fns.get(fid);
    for (const n of fn.nodes) {
      if (n.k === 'raise' && n.exc) yield [n.i, lastDot(n.exc), { at: `${fn.path}:${n.line}`, fn: fid, kind: 'raise' }];
      for (const o of n.ops ?? []) {
        if (o.t !== 'call') continue;
        if (o.to?.length && EXACT.has(o.how)) {
          for (const g of o.to) {
            if (fn.lang !== 'lua' && P.fns.get(g).async && !o.aw) {
              this.floating.add(tkey(fid, n.i, g)); // a coroutine / promise is created here, not run: nothing is raised at this call
              continue;
            }
            // a generator call runs none of the callee's body, and a generator expression runs when it is consumed: what they raise is only possible here
            const weak = (o.may ?? []).includes(g) || o.lazy || isGen(P, g);
            const esc = this.esc.get(g);
            for (const t of esc ? [...esc.keys()].sort(cmp) : []) {
              const w = esc.get(t);
              yield [n.i, t, { at: `${fn.path}:${o.line}`, fn: fid, kind: weak ? 'call?' : 'call', via: g, orig: w.orig ?? w }];
            }
          }
        } else if (o.f) {
          for (const t of raisesOf(o)[0]) { // from the resolved definition, never from the last word of the name
            yield [n.i, t, { at: `${fn.path}:${o.line}`, fn: fid, kind: o.lazy || ITERATION_SIGNALS.has(t) ? 'call?' : 'ext', call: o.f }];
          }
        }
      }
    }
  },

  localPass(fid, final) {
    let changed = false;
    const cur = this.esc.get(fid);
    for (const [n, t, org] of this.sources(fid)) {
      const r = this.landFull(fid, n, t); // not land(): a call outside every try has no exception edge and must still escape
      if (final) {
        for (const h of r.caught) {
          const k = tkey(fid, h);
          if (!this.hsrc.has(k)) this.hsrc.set(k, { fid, h, srcs: [] });
          this.hsrc.get(k).srcs.push([t, org]);
        }
      }
      if (r.escapes && !cur.has(t)) {
        cur.set(t, { orig: org.orig ?? org, line: org.at });
        changed = true;
      }
    }
    if (final) {
      const fn = this.P.fns.get(fid);
      const ad = this.adj(fid);
      for (const [a, b, l] of fn.edges) {
        if (l === 'exc' && fn.nodes[b].k === 'disp') {
          for (const o of fn.nodes[a].ops ?? []) {
            if (o.t === 'call' && !o.to?.length && o.how !== 'builtin' && !raisesOf(o)[1]) {
              for (const [h, hl] of ad.get(b) ?? []) if (hl === 'exc') this.opaque.set(tkey(fid, h), (this.opaque.get(tkey(fid, h)) ?? 0) + 1);
            }
          }
        }
      }
    }
    return changed;
  },

  // ---- who hears a raise, up the call graph -------------------------------------------------------------------------------
  /** Fates of exception type t raised at (fid, node): [{by: 'handler' | 'uncaught' | 'deep', fn, line, depth}] */
  hear(fid, node, t, maxdepth = 6, cap = 14) {
    const fates = [];
    const seen = new Set();
    const q = [[fid, node, 0, []]];
    while (q.length && fates.length < cap) {
      const [f, n, d, chain] = q.shift();
      let esc = false;
      for (const r of this.land(f, n, t)) {
        if (r[0] === 'caught') fates.push({ by: 'handler', fn: f, h: r[1], line: this.P.fns.get(f).nodes[r[1]].line, depth: d, chain, may: r[2] });
        else esc = true;
      }
      if (!esc) continue;
      const cs = sorted(this.callers.get(f) ?? []);
      if (!cs.length) fates.push({ by: 'uncaught', fn: f, line: this.P.fns.get(f).line, depth: d, chain });
      else if (d >= maxdepth) fates.push({ by: 'deep', fn: f, line: this.P.fns.get(f).line, depth: d, chain });
      else {
        for (const [cf, cn, ln] of cs) {
          const k = tkey(cf, cn);
          if (!seen.has(k)) { seen.add(k); q.push([cf, cn, d + 1, [...chain, `${cf}:${ln}`]]); }
        }
      }
    }
    return fates;
  },
};
