// Local def-use and whole-program questions that the code alone answers. Each row names the lines that prove it.
//
// Every row that says something is ABSENT (no way in, never read, swallowed, nothing can reach this handler) carries a `claim`:
//     {value: proven | unknown, open_ends: N, why: [...]}
// proven needs the language's type checker to have run and no open end (negclaims.mjs lists the open-end kinds). Without the checker the value is
// `unknown` and the first open end is `no-type-checker`.
import { PROVEN, UNKNOWN } from './negclaims.mjs';
import { regionSilent } from './heard3.mjs';
import { sorted, cmp } from './pyrt.mjs';
import { tkey } from './canon.mjs';

const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);
const SHOWN_EFFECTS = ['delete', 'store', 'emit', 'respond'];
const CLEARING = ['const:False', 'const:None', 'const:0'];
const VALUE_PREFIXES = ['name:', 'call:', 'expr', 'attr:'];

function claim(neg, fid, endsIn) {
  const on = neg.enabled(fid);
  const ends = [...endsIn];
  if (!on) ends.unshift(['no-type-checker', '']);
  return { value: on && !ends.length ? PROVEN : UNKNOWN, open_ends: ends.length, why: ends.slice(0, 5).map((e) => [...e]) };
}

/** fid -> true when running the function may run a call nothing is known about (an unresolved call, or an outside definition we have no row for),
 *  directly or through the project functions it calls. Computed once, cycle-safe. */
function opaqueReach(P, F) {
  const memo = new Map();
  const callees = new Map();
  for (const [fid, fn] of P.fns) {
    let direct = false;
    const cs = new Set();
    for (const nd of fn.nodes) {
      for (const o of nd.ops ?? []) {
        if (o.t === 'call' || o.t === 'yield') {
          if (F.isOpaque(o)) direct = true;
          for (const g of o.to ?? []) cs.add(g);
        }
      }
    }
    memo.set(fid, direct);
    callees.set(fid, cs);
  }
  const rev = new Map();
  for (const [f, cs] of callees) for (const g of cs) { if (!rev.has(g)) rev.set(g, []); rev.get(g).push(f); }
  const q = [...memo].filter(([, v]) => v).map(([f]) => f);
  while (q.length) {
    const g = q.shift();
    for (const f of rev.get(g) ?? []) if (!memo.get(f)) { memo.set(f, true); q.push(f); }
  }
  return memo;
}

/** -> Map of finding kind -> rows. */
export function runFindings(P, F) {
  const out = new Map();
  const add = (kind, row) => { if (!out.has(kind)) out.set(kind, []); out.get(kind).push(row); };
  const N = F.neg;
  // 1. functions that delete / write and that nothing names (dead, or called by something the reader cannot see)
  const names = new Set(P.names);
  for (const fn of P.fns.values()) {
    for (const r of fn.rd) names.add(lastDot(r));
    for (const n of fn.nodes) for (const o of n.ops ?? []) {
      if (o.f) names.add(lastDot(o.f));
      for (const c of o.cb ?? []) names.add(lastDot(c));
    }
  }
  for (const fid of P.fids) {
    const fn = P.fns.get(fid);
    const short = lastDot(fn.qual);
    for (const kind of ['delete', 'store']) {
      if (F.own.get(fid)?.has(kind) && !names.has(short) && fn.qual !== '<module>' && !fn.qual.includes('<anon')) {
        add('unreferenced_' + kind, { fn: fid, line: fn.line, resolved_callers: (F.callers.get(fid) ?? []).length, effects: sorted([...F.own.get(fid)].filter((e) => SHOWN_EFFECTS.includes(e))), claim: claim(N, fid, N.openEnds(fid)) });
      }
    }
  }
  // 2. a lock held across a sleep / wait / external call
  for (const b of [...F.blocking.values()].sort((a, c) => cmp([a.fid, a.ctx], [c.fid, c.ctx]))) {
    add('lock_held_across_blocking', { fn: b.fid, lock: b.ctx, blocks_on: b.what, line: b.line, call: b.f });
  }
  // 3. flags: attribute set to a boolean constant, never set to the opposite anywhere, per class
  const sets = new Map();
  const reads = new Set();
  for (const fn of P.fns.values()) {
    for (const r of fn.rd) reads.add(lastDot(r));
    for (const n of fn.nodes) {
      for (const o of n.ops ?? []) {
        if (o.t === 'set' && o.tk === 'attr' && (o.tgt.startsWith('self.') || o.tgt.startsWith('this.')) && o.tgt.split('.').length === 2) {
          const key = fn.cls || fn.selfcls || fn.path;
          if (!sets.has(key)) sets.set(key, new Map());
          const m = sets.get(key);
          const attr = o.tgt.split('.')[1];
          if (!m.has(attr)) m.set(attr, []);
          m.get(attr).push([o.v, o.line, fn.id]);
        }
      }
    }
  }
  for (const cls of sorted(sets.keys())) {
    const ck = P.classes.has(cls) ? cls : null;
    for (const attr of sorted(sets.get(cls).keys())) {
      const vs = sets.get(cls).get(attr);
      const vals = new Set(vs.map((x) => x[0]));
      const tr = vs.filter((x) => x[0] === 'const:True');
      const fa = vs.filter((x) => CLEARING.includes(x[0]));
      const fid0 = vs[0][2];
      const ends = [];
      if (ck) {
        if (N.extBase(ck)) ends.push(['framework-base', N.extBase(ck).slice(0, 40)]);
        const lg = P.mods.get(P.classes.get(ck).mod).lang;
        const dyn = N.subclassDyn(ck) + (N.dynObj.get(lg) ?? 0) + (N.dynGlobal.get(lg) ?? 0);
        if (dyn) ends.push(['dynamic-attribute-access', dyn]);
      }
      if (N.litnames.has(attr)) ends.push(['named-in-string', attr]);
      if (tr.length && !fa.length && ![...vals].some((v) => VALUE_PREFIXES.some((p) => v.startsWith(p)))) {
        add('flag_never_cleared', { class: cls, attr, set_true: tr.map(([, l, f]) => [f, l]).slice(0, 3), claim: claim(N, fid0, ends) });
      }
      if (!reads.has(attr)) add('written_never_read', { class: cls, attr, at: vs.map(([, l, f]) => [f, l]).slice(0, 2), claim: claim(N, fid0, ends) });
    }
  }
  // 4. handlers that swallow a failure a resolved callee or an explicit raise can really produce
  for (const { fid, h, srcs } of [...F.hsrc.values()].sort((a, b) => cmp([a.fid, a.h], [b.fid, b.h]))) {
    const fn = P.fns.get(fid);
    const nd = fn.nodes[h];
    const d = F.disposition(F.regionEffects(fid, h));
    if (d === 'swallow' && srcs.length) {
      // "swallows it" is a claim that nothing observable happens afterwards: no state written (an attribute, an item), no call that may tell
      // someone, in the handler or anywhere control goes next (regionSilent). Otherwise the failure is recorded.
      const tail = new Map(fn.nodes.filter((x) => (x.h ?? null) === h).map((x) => [x.i, x]));
      for (const x of F.reachFrom(fid, h)) tail.set(x.i, x);
      const from = new Map(srcs.map(([t, o]) => [JSON.stringify([t, o.via || o.call || o.fn, o.at]), [t, o.via || o.call || o.fn, o.at]]));
      const row = { fn: fid, handler_line: nd.line, types: nd.types ?? null, from: sorted(from.values()).slice(0, 3) };
      const givesValue = fn.nodes.some((x) => x.k === 'return' && x.sig !== 'ret:none') || fn.nodes.some((x) => (x.ops ?? []).some((o) => o.t === 'yield'));
      if (givesValue) {
        // a function that returns a value somewhere lets its caller tell the failure apart by what it gets back: not silence
        add('swallowed_known_failure_unknown', { ...row, claim: claim(N, fid, [['caller-can-test-the-return-value', '']]) });
      } else if (regionSilent(F, [...tail.keys()].sort((a, b) => a - b).map((i) => tail.get(i)), N._silent)) {
        add('swallowed_known_failure', { ...row, claim: claim(N, fid, []) });
      } else {
        add('swallowed_known_failure_unknown', { ...row, claim: claim(N, fid, [['handler-writes-state-or-calls-something-unclassified', '']]) });
      }
    } else if (d === 'unknown' && srcs.length) {
      add('swallowed_known_failure_unknown', { fn: fid, handler_line: nd.line, types: nd.types ?? null, claim: claim(N, fid, [['maybe-effect-in-handler', '']]) });
    }
  }
  // 5. handlers that can never fire. The try body may also call a project function that itself makes an opaque call, and implicit exceptions
  // (subscript, attribute, arithmetic, conversion) are not modelled at all. So this is never `proven`: the value is unknown and the open ends say
  // what we could not see. A handler with an unresolved call in its body is not listed as "unreachable" at all.
  const reach = opaqueReach(P, F);
  for (const fid of P.fids) {
    for (const n of P.fns.get(fid).nodes) {
      if (n.k === 'handler' && !F.hsrc.get(tkey(fid, n.i)) && !n.synth) {
        const ends = [];
        const op = F.opaque.get(tkey(fid, n.i));
        if (op) ends.push(['opaque-call-in-try-body', op]);
        const deep = F.tryBodyCallees(fid, n.i).filter((g) => reach.get(g)).length;
        if (deep) ends.push(['callee-makes-opaque-call', deep]);
        ends.push(['implicit-exceptions-not-modelled', '']);
        add(ends.length === 1 ? 'handler_nothing_can_reach' : 'handler_maybe_reachable', { fn: fid, line: n.line, types: n.types ?? null, claim: claim(N, fid, ends) });
      }
    }
  }
  return out;
}
