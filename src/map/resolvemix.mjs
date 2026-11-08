// Merging a type checker's answers into the project's own call resolution, and the effects of a call keyed on the definition it landed on.
//
// The lexical resolver has already set op.to / op.how on every call op; here the checker (ty for Python, tsc for TypeScript) is asked what it thinks and
// the two are merged. The checker wins every disagreement (counted in P.rstat.conflict, the lexical targets kept in op.veto).
//
// Fields this leaves on a call op:
//   to    targets that get a road       may   those of them that are only possible (several targets, an override, an unconfirmed guess)
//   cand  candidates that get NO road   (a structural or anonymous receiver: a type literal is not a class hierarchy)
//   rs    project | ext | dynamic | silent | none      what the checker said about the callee
//   defs  [[module, qualified name]]    the definitions outside the project it landed on
//   eff   confirmed effects, and `maybe:<effect>` labels
import { cmpCp, tkey } from './canon.mjs';
import { findMethod, subclassesDefining } from './classes.mjs';

export const EXACT = ['exact', 'self', 'typed'];
const sorted = (xs) => [...xs].sort(cmpCp);
const uniqSorted = (xs) => sorted(new Set(xs));
const inter = (a, b) => [...a].some((x) => b.has(x));
const LOCKISH = /(lock|mutex|cond|sem|guard)[\p{L}\p{N}_]*$/iu;

/** Hand the Python checker's answers (tyres.resolvePython) to the project; null = no checker ran. */
export function setPythonAnswers(P, d) {
  P.pyAnswers = d ? d.answers : null;
  P.resolvers.py = d ? d.version : null;
  if (d && d.env) P.env.py = d.env;
}

/** Index the Python definitions by where their name token sits. A definition is found by line AND by the column of its name token: a parameter on a
 *  one-line `def f(ack):` is on the function's line but is not the function. */
export function indexDefs(P) {
  P.fnAt = new Map();
  const fns = [...P.fns].sort((a, b) => cmpCp(a[0], b[0]));
  for (const [fid, f] of fns) {
    if (f.path.endsWith('.py') && f.line !== undefined && f.line !== null && f.qual !== '<module>') P.fnAt.set(tkey(f.path, f.line, f.ncol ?? null), fid);
  }
  P.fnLine = new Map();                                  // by line only: for readers that carry a def statement, not a call answer
  for (const [k, v] of P.fnAt) {
    const [p, l] = k.split('\u0000');
    if (!P.fnLine.has(tkey(p, l))) P.fnLine.set(tkey(p, l), v);
  }
  P.clsAt = new Map();
  for (const [k, c] of [...P.classes].sort((a, b) => cmpCp(a[0], b[0]))) if (c.mod.endsWith('.py')) P.clsAt.set(tkey(c.mod, c.line, c.ncol ?? null), k);
}

export const bump = (P, k) => { P.rstat[k] = (P.rstat[k] || 0) + 1; };
export const lexSet = (o) => (EXACT.includes(o.how) ? new Set(o.to || []) : new Set());

function conflict(P, o, lang = '?') {
  bump(P, 'conflict');
  bump(P, 'conflict_' + lang);
  o.veto = sorted(lexSet(o));
  delete o.own;
}

/** -> [status, outside definitions]. status: project | ext | dynamic | silent | none (no checker for this language). */
export function resolverPass(P, fn, o, lang) {
  if (lang === 'py') return P.pyAnswers === null || P.pyAnswers === undefined ? ['none', []] : mergePy(P, fn, o);
  if (lang === 'ts') return !P.resolvers.ts ? ['none', []] : mergeTs(P, fn, o);
  return ['none', []];
}

export function mergePy(P, fn, o) {
  const a = o.nl !== undefined ? P.pyAnswers[`${fn.path}:${o.nl}:${o.nc}`] ?? null : null;
  const lex = lexSet(o);
  if (a === null) {
    if (lex.size) { o.may = sorted(lex); bump(P, 'lexical_unconfirmed'); }   // the checker could not be asked / said nothing: the lexical road is unconfirmed
    return ['silent', []];
  }
  const proj = [], ext = [];
  let dyn = false;
  for (const x of a) {
    if (x.k === 'ext') { ext.push([x.m, x.q]); continue; }
    const fid = P.fnAt.get(tkey(x.p, x.l, x.c ?? null));
    if (fid) { proj.push(fid); continue; }
    const ck = P.clsAt.get(tkey(x.p, x.l, x.c ?? null));
    if (ck) {
      const m = findMethod(P, ck, '__init__');
      if (m) proj.push(m);
      else { o.cls = ck; proj.push(null); }                  // a project class with no __init__ of its own: nothing to draw a road to
      continue;
    }
    dyn = true;
  }
  if (proj.length) {
    let tyTo = uniqSorted(proj.filter((p) => p));
    if (!tyTo.length) return ['project', []];
    if (lex.size && !inter(lex, new Set(tyTo))) conflict(P, o, 'py');
    else if (lex.size) bump(P, 'agree');
    else bump(P, 'found_by_checker');
    let may = tyTo.length > 1 ? [...tyTo] : [];
    if (tyTo.length === 1 && o.own === tyTo[0]) {
      const ov = (o.to || []).filter((g) => g !== o.own);       // subclass overrides: possible targets, not proven ones
      tyTo = tyTo.concat(ov);
      may = ov;
    } else if (tyTo.length === 1 && (o.own === undefined || o.own === null)) {
      const g0 = P.fns.get(tyTo[0]);
      const subs = g0.cls && P.classes.has(g0.cls) ? subclassesDefining(P, g0.cls, g0.qual.split('.').pop()) : [];
      if (subs.length) {                                         // a typed receiver: the declared method may be overridden, so any of them may run
        tyTo = uniqSorted(tyTo.concat(subs.slice(0, 4)));
        may = [...tyTo];
      }
    }
    o.to = uniqSorted(tyTo);
    o.may = uniqSorted(may);
    if (!inter(lex, new Set(tyTo))) o.how = 'typed';
    return ['project', []];
  }
  if (ext.length) {
    if (lex.size) { conflict(P, o, 'py'); delete o.to; o.how = 'ext'; }
    else if (o.how === 'by-name') { delete o.cand; o.how = 'ext'; }     // a guess the checker contradicts
    return ['ext', [...new Map(ext.map((e) => [JSON.stringify(e), e])).values()].sort((x, y) => cmpCp(x[0], y[0]) || cmpCp(x[1], y[1]))];
  }
  if (dyn) {
    if (lex.size) { conflict(P, o, 'py'); delete o.to; }
    o.how = 'dynamic';
    return ['dynamic', []];
  }
  if (lex.size) { o.may = sorted(lex); bump(P, 'lexical_unconfirmed'); }
  return ['silent', []];
}

/** tsc's answer travels inside the reader's document (op.r = {k, to, may, cand, x}). Same merge as for Python. */
export function mergeTs(P, fn, o) {
  const r = o.r ?? null;
  const lex = lexSet(o);
  if (r === null) {
    if (lex.size) o.may = sorted(lex);
    return ['silent', []];
  }
  const cand = uniqSorted((r.cand || []).filter((g) => P.fns.has(g)));
  if (cand.length) o.cand = cand;
  if (r.k === 'project') {
    let to = uniqSorted((r.to || []).filter((g) => P.fns.has(g)));
    let may = uniqSorted((r.may || []).filter((g) => P.fns.has(g) && !to.includes(g)));
    if (!to.length && !may.length) return ['silent', []];
    if (lex.size && !inter(lex, new Set(to.concat(may)))) conflict(P, o, 'ts');
    else if (lex.size) bump(P, 'agree');
    else bump(P, 'found_by_checker');
    if (to.length > 1) { may = uniqSorted([...may, ...to]); to = []; }
    o.to = uniqSorted([...to, ...may]);
    o.may = may;
    if (!inter(lex, new Set(o.to))) o.how = 'typed';
    return ['project', []];
  }
  if (r.k === 'ext') {
    if (lex.size) { conflict(P, o, 'ts'); delete o.to; o.how = 'ext'; }
    else if (o.how === 'by-name') { delete o.cand; o.how = 'ext'; }
    return ['ext', (r.x || []).map((x) => [...x])];
  }
  if (r.k === 'dynamic') {
    if (lex.size) { conflict(P, o, 'ts'); delete o.to; }
    o.how = 'dynamic';
    return ['dynamic', []];
  }
  if (lex.size) o.may = sorted(lex);
  return ['silent', []];
}

/** The effects of a call op: the name table proposes, the resolved definition decides. `efx` is the effects table the rule engine owns:
 *  { classifyCall(f, n, a0, kw), lexicalDefs(o, imp, isBuiltin, decls, shadow), decide(cands, defs, status, o, fileish) -> [keep, maybe] (Sets),
 *    adjust(keep, maybe, o, defs) -> [keep, maybe], boundaryOf(defs, root) -> [sure, may] (Sets), isPure(module, qualifiedName), SQL_WRITE (a regular expression anchored at the start) } */
export function effectsOf(P, o, imp, status, defs, decls, shadow, fileish, efx) {
  const cands = efx.classifyCall(o.f, o.n || 0, o.a0 ?? null, o.kw || []);
  let keep = new Set(), maybe = new Set();
  if (status === 'none' || status === 'silent') {            // no checker, or it said nothing: what the imports alone prove still counts
    const ld = efx.lexicalDefs(o, imp, o.how === 'builtin', decls, shadow);
    if (ld && ld.length) { defs = ld; status = 'ext'; o.defs = ld.map((d) => [...d]); }
  }
  if (cands && (cands.size ?? cands.length)) {
    [keep, maybe] = efx.decide(cands, defs, status, o, fileish);
    [keep, maybe] = efx.adjust(keep, maybe, o, defs);
    if (status === 'project' && (cands.has ? cands.has('store') : cands.includes('store')) && typeof o.a0 === 'string' && efx.SQL_WRITE.test(o.a0)) maybe.add('maybe:store');   // a SQL write handed to a project wrapper: the wrapper's body decides, this is only a lead
  }
  const eff = new Set(keep);
  if (status !== 'project' && (o.x || (defs && defs.length))) {   // does it go out of the process? from the definition, never from the package it was imported from
    const root = o.x || (defs && defs.length ? defs[0][0].split('.')[0] : '');
    const [sure, may] = efx.boundaryOf(defs.map((d) => [...d]), root);
    for (const k of sure) eff.add('ext:' + k);
    for (const k of may) maybe.add('maybe:ext:' + k);
  }
  if (o.t === 'with' && LOCKISH.test(o.f || '') && !(o.to && o.to.length)) eff.add('lockwith');
  for (const m of maybe) eff.add(m);
  if (!keep.size && !eff.has('lockwith') && ![...eff].some((e) => e.startsWith('ext:'))) {
    // the call's effect on the world is unknown: unresolved, or defined somewhere that is neither a known effect nor known pure.
    // A handler that makes such a call cannot be called a swallow.
    if (status === 'silent' || status === 'dynamic' || (status === 'ext' && defs && defs.length && !defs.every(([m, q]) => efx.isPure(m, q)) && !maybe.size)) eff.add('maybe:call');
  }
  if (eff.size) o.eff = sorted(eff);
}

/** [proven targets, possible targets] of a call op: the targets that get a road, split by tier. By-name guesses are not here: they live in op.cand and never get a road. */
export function roadTargets(o) {
  if (!EXACT.includes(o.how) || !(o.to && o.to.length)) return [[], []];
  const may = new Set(o.may || []);
  return [o.to.filter((g) => !may.has(g)), o.to.filter((g) => may.has(g))];
}
