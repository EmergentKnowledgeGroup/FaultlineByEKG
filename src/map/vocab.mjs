// Project-wide tables the reduction reads: the class of an ending, which returned constants recur, which functions nothing names (entries), which
// exception names the project defines.
import { BUILTIN_EXCEPTIONS, BUILTIN_NAMES } from './pybuiltins.mjs';

const LABEL = /^[a-z][a-z0-9_.:-]{2,39}\n?$/; // a machine-style status word: pending, lease_lost, not-found
const SKIP_RAISE = new Set(['AssertionError', 'NotImplementedError', 'StopIteration', 'StopAsyncIteration']);
const DOMAIN_SUFFIX = ['Error', 'Exception', 'Exit', 'Failure', 'Refused'];
const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);

export function tclass(nd) {
  if (nd.k === 'raise') return 'raise:' + lastDot(nd.exc || '*');
  if (nd.k === 'return') {
    const s = nd.sig;
    if (s === 'ret:none') return 'R0';
    if (s.startsWith('ret:const:') || (s.startsWith('ret:tuple:') && s.includes('const:'))) return 'R:' + s.slice(4);
    return 'RV';
  }
  return null;
}

/** The ending class of a value an entry function returns: one class per reply shape, so `return {"ok": 1}` and `return {"error": e}` are two endings,
 *  and so are `return jsonify(...)` and `return make_error(...)`. A bare variable or expression stays the plain class 'RB'. */
export function rbClass(sig) {
  const v = sig.slice(4);
  if (v.startsWith('new:dict{')) return 'RB:' + v.slice(4);
  if (v === 'new:list' || v === 'new:set' || v === 'fstr') return 'RB:' + v.slice(v.lastIndexOf(':') + 1);
  if (v.startsWith('call:')) return 'RB:call:' + lastDot(v.slice(5));
  if (v.startsWith('tuple:')) return 'RB:tuple';
  return 'RB';
}

/** Project-wide tables: which returned constants recur, which functions nothing names (entries), which exception names the project defines. */
export class Vocab {
  constructor(P) {
    this.val = new Map();
    for (const fn of P.fns.values()) {
      const seen = new Set();
      for (const n of fn.nodes) {
        const c = n.k === 'return' ? tclass(n) : null;
        if (c && c.startsWith('R:const:str:') && !seen.has(c) && LABEL.test(c.slice(12))) {
          seen.add(c);
          this.val.set(c, (this.val.get(c) ?? 0) + 1);
        }
      }
    }
    const names = new Set(P.names); // every identifier read anywhere, lambdas, defaults, decorators and class bodies included
    for (const fn of P.fns.values()) {
      for (const r of fn.rd) names.add(lastDot(r));
      for (const n of fn.nodes) for (const o of n.ops ?? []) {
        if (o.f) names.add(lastDot(o.f));
        for (const c of o.cb ?? []) names.add(lastDot(c));
      }
    }
    // a function nobody names anywhere is an entry (the framework or a person calls it) or dead code
    this.entries = new Set();
    for (const [fid, fn] of P.fns) {
      const short = lastDot(fn.qual);
      if (fn.qual !== '<module>' && !names.has(short) && !short.startsWith('_') && !fn.qual.includes('<anon')) this.entries.add(fid);
    }
    this.domain = new Set();
    for (const c of P.classes.values()) {
      const anc = [c.name, ...c.bases.map(lastDot)];
      if (anc.some((a) => DOMAIN_SUFFIX.some((s) => a.endsWith(s)) || BUILTIN_EXCEPTIONS.has(a))) this.domain.add(c.name);
    }
  }

  major(lab) {
    if (lab === 'X') return true;
    if (lab.startsWith('raise:')) {
      const t = lab.slice(6);
      if (SKIP_RAISE.has(t) || t === '*') return false;
      return this.domain.has(t) || t === 'SystemExit' || !BUILTIN_NAMES.has(t);
    }
    if (lab.startsWith('R:')) {
      if (lab.startsWith('R:const:str:')) return LABEL.test(lab.slice(12)) && (this.val.get(lab) ?? 0) >= 2;
      return lab.includes('const:str:') && lab.split(',').some((p) => p.includes('const:str:') && (this.val.get('R:const:str:' + p.split('const:str:')[1].replace(/\)+$/, '')) ?? 0) >= 2);
    }
    return false;
  }
}

