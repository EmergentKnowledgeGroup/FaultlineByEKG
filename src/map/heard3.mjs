// Who hears about an ending? Three values: heard | nobody | unknown. Decided from the code only, on the resolved graph.
//
//   heard    a path with every edge proven reaches something that tells someone: a person (print, an uncaught exception at module level, an alert),
//            the caller (a returned value or a raised exception that propagates to a resolved caller), an event (emit, store, record) or a log. `by`
//            says which.
//   nobody   every path the code has ends in silence and the graph is closed: a handler that swallows (no effect at all, no call we cannot classify),
//            reached by proven edges, with no open end anywhere on the way. A claim, so it needs the type checker.
//   unknown  the answer depends on something the reader could not see: a possible (not proven) call edge, a handler or an arm that makes a call
//            nothing is known about, callers that may exist, or no type checker for that language.
// `how` is a plain sentence with the evidence; `open` counts the open ends behind an `unknown`.
import { byFrom, nearest, armLabels } from './heard.mjs';
import { isPure } from './effects.mjs';
import { sorted } from './pyrt.mjs';
import { tkey } from './canon.mjs';

const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);
const qualOf = (fid) => fid.slice(fid.indexOf('::') + 2);
const TELLING = ['print', 'respond', 'emit', 'log', 'record'];
const MUTATORS = new Set(`append extend update add pop popitem remove clear insert setdefault discard sort reverse appendleft popleft put put_nowait set push
  splice unshift shift delete assign fill`.split(/\s+/));
const OBSERVABLE = new Set(['store', 'delete', 'emit', 'respond', 'print', 'log', 'record', 'exit', 'maybe']);

function cl(value, by, how, node, open = 0, extra = null) {
  return { value, by, how, node, open, ...(extra ?? {}) };
}

/** Every node control can run from `start` to the end of the function (normal edges only, the handlers' own bodies included). */
export function reachNodes(red, fn, start) {
  const seen = new Set([start.i]);
  const work = [start.i];
  while (work.length) for (const [j] of red.S(work.pop())) if (!seen.has(j)) { seen.add(j); work.push(j); }
  return [...seen].sort((a, b) => a - b).map((i) => fn.nodes[i]);
}

/** A project function that cannot return (every path raises, exits or calls one that does): calling it IS the raise site. */
export const alwaysRaises = (F, g) => F.P.never.has(g);

/** True when running the function does nothing anyone could observe: it calls only definitions known to be pure or project functions that are
 *  themselves silent, and writes only local variables (no attribute, no item: those are state another part of the program or a page can read).
 *  Cycles are taken as silent (nothing in the cycle breaks the rule). */
export function silentFn(F, fid, memo, stack = []) {
  if (memo.has(fid)) return memo.get(fid);
  if (stack.includes(fid)) return true;
  let ok = true;
  for (const nd of F.P.fns.get(fid).nodes) {
    if (!regionSilent(F, [nd], memo, [...stack, fid])) { ok = false; break; }
  }
  memo.set(fid, ok);
  return ok;
}

export function regionSilent(F, nodes, memo, stack = []) {
  for (const nd of nodes) {
    for (const o of nd.ops ?? []) {
      if (o.t === 'set' && o.tk !== 'name') return false;
      if (o.t === 'del' && ((o.tgt ?? '').includes('[') || (o.tgt ?? '').includes('.'))) return false; // `del shared[k]` / `del self.x` changes state another part of the program can read
      if (o.t === 'call' || o.t === 'with') {
        const eff = o.eff ?? [];
        if (eff.some((e) => OBSERVABLE.has(e.split(':')[0]) || e.startsWith('wait') || e.startsWith('ext'))) return false;
        if (o.to?.length) {
          if (o.to.some((g) => (o.may ?? []).includes(g) || !silentFn(F, g, memo, stack))) return false;
        } else if (o.rs === 'ext') {
          if (!o.defs?.length || !o.defs.every(([m, q]) => isPure(m, q))) return false;
          if (MUTATORS.has(lastDot(o.f ?? ''))) return false; // self.x.update(...) / a.b.append(...) is a write other code can read
        } else if (o.how === 'builtin') {
          if (!isPure('builtins', o.f)) return false;
        } else return false;
      } else if (o.t === 'yield' || o.t === 'await') return false;
    }
  }
  return true;
}

/** The straight-line run that leads into node n (the same walk as armLabels), n itself first. */
function armNodes(red, fn, n) {
  const out = [n];
  let cur = n.i;
  let steps = 0;
  while (steps < 6) {
    if (fn.nodes[cur].k === 'handler') break;
    const ps = red.Pr(cur).map(([p]) => p);
    if (ps.length !== 1 || !['block', 'branch'].includes(fn.nodes[ps[0]].k) || fn.nodes[ps[0]].k === 'branch') break;
    cur = ps[0];
    out.push(fn.nodes[cur]);
    steps++;
  }
  return out;
}

export function handlerTail(M, fid, h) {
  const fn = M.P.fns.get(fid);
  const t = new Map();
  for (const x of [...fn.nodes.filter((x) => (x.h ?? null) === h), ...reachNodes(M.red.get(fid), fn, fn.nodes[h])]) t.set(x.i, x);
  return [...t.keys()].sort((a, b) => a - b).map((i) => t.get(i));
}

/** by_from knows effects; a handler that translates, re-raises or returns hands the news to its caller. */
const hearer = (by, disposition) => (by === 'nobody' && disposition !== 'swallow' ? 'caller' : by);

const isVoid = (fn) => fn.nodes.filter((x) => x.k === 'return').every((x) => x.sig === 'ret:none') && !fn.nodes.some((x) => (x.ops ?? []).some((o) => o.t === 'yield'));

/** {value, by, how, node, open} for the ending nearest to (fid, line), or null when no node is near. */
export function classify3(M, fid, line) {
  const { P, F } = M;
  const N = F.neg;
  const fn = P.fns.get(fid);
  const red = M.red.get(fid);
  const n = nearest(fn, line, ['return', 'raise', 'handler'], 1) ?? nearest(fn, line, ['block', 'jump', 'return', 'raise', 'handler'], 2);
  if (n === null) return null;
  const k = n.k;
  const on = N.enabled(fid);
  const lab = armLabels(red, fn, n);
  const maybeArm = [...lab].some((e) => e.startsWith('maybe')) || (n.ops ?? []).some((o) => o.t === 'call' && (o.rs === 'silent' || o.rs === 'dynamic') && !o.to?.length);
  let types = [];
  if (k === 'raise') {
    const h = n.h ?? null;
    let t;
    if (n.exc && n.exc !== '*') t = lastDot(n.exc);
    else t = h !== null ? lastDot((fn.nodes[h].types?.length ? fn.nodes[h].types : ['*'])[0]) : '*';
    types = [t];
  } else if (k === 'block' && (n.ops ?? []).some((o) => o.t === 'call' && o.to?.length && o.to.every((g) => alwaysRaises(F, g)))) {
    types = sorted(new Set([...F.sources(fid)].filter(([i]) => i === n.i).map(([, t]) => t))); // `raiseError(...)`: a helper that never returns is a throw
  }
  const memo = N._silent;
  if (types.length) {
    const fates = [];
    for (const t of types.slice(0, 4)) fates.push(...N.hear3(fid, n.i, t));
    if (['print', 'log'].some((x) => lab.has(x))) return cl('heard', byFrom(lab, 'raise'), 'logs or prints before it raises', k); // the arm tells someone before it raises
    const hand = sorted(fates.filter((x) => x.by === 'handler'), (x) => x.depth);
    const opens = fates.filter((x) => x.by === 'open' || x.by === 'deep');
    const apis = fates.filter((x) => x.by === 'api' && !x.may);
    const tops = fates.filter((x) => x.by === 'top');
    const silentOk = [];
    let unk = 0;
    for (const f of hand) {
      const hl = F.regionEffects(f.fn, f.h);
      if (hl.has('reraise') && !TELLING.some((x) => hl.has(x))) continue; // passes it on; the next fate decides
      const d = F.disposition(hl);
      const where = `${qualOf(f.fn)}:${f.line}`;
      if (d === 'unknown') { unk++; continue; }
      if (d === 'reraise-sometimes') { unk++; continue; } // one way through the handler passes it on and another does not: the next fate decides only the first
      if (d === 'swallow') { silentOk.push(f); continue; }
      if (!f.may) return cl('heard', hearer(byFrom(new Set([...hl, ...lab]), 'raise'), d), `caught at ${where} -> ${d}`, k, 0, { via: [f.fn, f.h] });
      unk++; // only a possible call edge leads to this hearer
    }
    if (apis.length && !tops.length) return cl('heard', 'caller', 'it leaves an exported function: the caller outside the project receives it (' + qualOf(apis[0].fn) + ')', k);
    if (tops.length && on && !tops.some((x) => x.may)) return cl('heard', 'person', 'nothing catches it before module level: the traceback prints', k);
    const nopen = new Set(opens.map((x) => tkey(x.fn, JSON.stringify(x.why ?? [])))).size + unk + (on ? 0 : 1);
    if (silentOk.length && on && !opens.length && !unk && !tops.length && !silentOk.some((x) => x.may) && silentOk.every((f) => regionSilent(F, handlerTail(M, f.fn, f.h), memo))) {
      return cl('nobody', 'nobody', `every path ends in a handler that swallows it (first at ${qualOf(silentOk[0].fn)}:${silentOk[0].line})`, k);
    }
    return cl('unknown', null, 'callers or handlers we cannot see decide it' + (on ? '' : ' (no type checker)'), k, Math.max(1, nopen));
  }
  if (k === 'handler') {
    const hl = F.regionEffects(fid, n.i);
    const d = F.disposition(hl);
    if (d === 'unknown') return cl('unknown', null, 'the handler makes a call nothing is known about', k, 1);
    if (d === 'swallow') {
      if (on && isVoid(fn) && regionSilent(F, handlerTail(M, fid, n.i), memo)) return cl('nobody', 'nobody', 'handler -> swallow: nothing in it is observable', k);
      return cl('unknown', null, 'the handler writes state or calls something that may tell someone' + (on ? '' : ' (no type checker)'), k, 1);
    }
    return cl('heard', hearer(byFrom(hl, 'handler'), d), `handler -> ${d}`, k);
  }
  const term = k === 'return' && n.sig !== 'ret:none' ? 'return' : 'none';
  const effLab = sorted([...lab].filter((e) => ['print', 'respond', 'emit', 'log', 'store', 'record'].includes(e)));
  if (effLab.length || term === 'return') return cl('heard', byFrom(lab, term), effLab.length ? 'path effects ' + effLab.join(',') : 'returns a value to its caller', k);
  // no effect and no value. If the function never returns a value anywhere, a caller has nothing to test: the arm is silent. If some other path
  // returns one, a caller may be telling this path apart by it: not something the graph shows, so not a claim.
  if (k === 'branch') return cl('unknown', null, 'the reference is a test; which way out it means is not something a node can say', k, 1);
  if (isVoid(fn) && on && !maybeArm && regionSilent(F, [...armNodes(red, fn, n), ...reachNodes(red, fn, n).slice(1)], memo)) {
    return cl('nobody', 'nobody', 'the arm has no effect, and the function never returns a value for a caller to test', k);
  }
  return cl('unknown', null, 'the arm tells nobody itself; a caller may still test what it returns' + (on ? '' : ' (no type checker)'), k, 1);
}
