// Function values handed to a call: which project function each one is, and whether the callee is seen to run it.
//
// A callback is not a call, so the call rules never see it: `retry(() => load(id))` has no edge from the caller to the arrow function, and the
// calls inside the arrow function look as if nothing runs them. This pass finds the function values that are handed over and puts the result on the
// call op as `cbr`: [{ to, arg, kind, how, run, own }].
//   kind  inline (a function written in the argument list, found by its start line) | named (a name in scope that is a project function)
//   run   the callee is a project function that calls that very parameter somewhere in its body. Nothing weaker counts: a callee outside the
//         project, or one that only passes the parameter on or stores it, leaves `run` false and the road drawn from it is `may`.
//   how   inline | exact (a name in scope) | self (a method of the own class, with its overrides in `to`)
//   own   the function the name itself lands on; the rest of `to` are overrides of the named method (the receiver's class may run another body than the one named)
import { EXACT } from './roadpass.mjs';

const SELF_NAMES = new Set(['self', 'cls', 'this']);

/** The project function written inline at `line` inside `fn`, or null when none or several start there (two arrows on one line cannot be told apart). */
function inlineAt(P, byStart, fn, line) {
  const c = (byStart.get(`${fn.path}\u0000${line}`) ?? []).filter((g) => P.fns.get(g).qual.startsWith(fn.qual + '.'));
  return c.length === 1 ? c[0] : null;
}

/** The parameter of `callee` that argument `arg` of call `o` lands in: its name, or null when it cannot be told (a keyword the callee does not have). */
function paramFor(callee, o, arg) {
  const ps = (callee.params ?? []).map((p) => p[0]);
  if (String(arg).startsWith('kw:')) return ps.includes(arg.slice(3)) ? arg.slice(3) : null;
  // a method called through its receiver, or a constructor, has the receiver as its first parameter in Python
  const bound = ps.length && SELF_NAMES.has(ps[0]) && (o.f?.includes('.') || callee.qual.endsWith('__init__'));
  return ps[Number(arg) + (bound ? 1 : 0)] ?? null;
}

/** Does `callee` call its parameter `name` somewhere (a call op whose callee text is exactly that name)? */
function callsParam(callee, name) {
  return callee.nodes.some((n) => (n.ops ?? []).some((o) => o.t === 'call' && o.f === name));
}

/** Fills `op.cbr` on every call op that hands a function value to a callee. `resolveRef(fn, name, ctx)` -> [to, own] resolves a name as the call rules would. */
export function findCallbacks(P, ctxs, resolveRef) {
  const byStart = new Map();
  for (const g of P.fids) {
    const f = P.fns.get(g);
    const k = `${f.path}\u0000${f.line}`;
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k).push(g);
  }
  for (const fid of P.fids) {
    const fn = P.fns.get(fid);
    const ctx = ctxs.get(fid);
    for (const nd of fn.nodes) {
      for (const o of nd.ops ?? []) {
        if (o.t !== 'call' || (!o.fa && !o.ai)) continue;
        const found = [];
        for (const [arg, line] of Object.entries(o.fa ?? {})) {
          const g = inlineAt(P, byStart, fn, line);
          if (g) found.push({ to: [g], arg, kind: 'inline', own: g, how: 'inline' });
        }
        for (const [arg, name] of Object.entries(o.ai ?? {})) {
          const [to, own, how] = resolveRef(fn, name, ctx);
          if (to.length) found.push({ to, arg, kind: 'named', own, how });
        }
        if (!found.length) continue;
        const callees = EXACT.has(o.how) && !(o.may ?? []).length ? (o.to ?? []).filter((g) => P.fns.has(g)) : [];
        o.cbr = found.map((c) => {
          const ps = callees.map((g) => paramFor(P.fns.get(g), o, c.arg));
          const run = callees.length > 0 && ps.every((p, i) => p !== null && callsParam(P.fns.get(callees[i]), p));
          return { to: c.to, arg: c.arg, kind: c.kind, how: c.how, run, own: c.own };
        });
      }
    }
  }
}
