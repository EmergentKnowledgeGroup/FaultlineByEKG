// Step -> box mapping and ordered replay. No file I/O here: pure functions over (model, facts).
import { makePathResolver, parseRef, normSlashes } from './util.mjs';

/** Index the model against the facts once; every later lookup is a Map hit. */
export function buildIndex(model, facts) {
  const boxes = new Map();
  const order = new Map();
  const warnings = [];
  const fnBoxes = new Map(); // fnId -> [{box, lines[]}]
  const fns = facts?.functions || {};
  (model?.boxes || []).forEach((b, i) => {
    boxes.set(b.id, b); order.set(b.id, i);
    const perFn = new Map();
    for (const r of b.refs || []) {
      const sym = r.symbol;
      if (!sym) continue;
      if (!fns[sym]) { warnings.push({ code: 'ref-symbol-missing', msg: `box ${b.id} cites ${sym}, which is not in facts`, at: b.id }); continue; }
      if (!perFn.has(sym)) perFn.set(sym, []);
      if (Number.isInteger(r.line)) perFn.get(sym).push(r.line);
    }
    for (const [sym, lines] of perFn) {
      if (!fnBoxes.has(sym)) fnBoxes.set(sym, []);
      fnBoxes.get(sym).push({ box: b.id, lines });
    }
  });
  const byPath = new Map();
  for (const [id, f] of Object.entries(fns)) {
    const p = normSlashes(f.path);
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push({ id, line: f.line, end: f.end ?? f.line });
  }
  for (const list of byPath.values()) list.sort((a, b) => (a.end - a.line) - (b.end - b.line) || a.line - b.line);
  const routes = model?.routes || [];
  const between = new Map();
  const succ = new Map();
  for (const r of routes) {
    const k = r.from + '\u0000' + r.to;
    if (!between.has(k)) between.set(k, []);
    between.get(k).push(r.id);
    if (!succ.has(r.from)) succ.set(r.from, new Set());
    succ.get(r.from).add(r.to);
  }
  const tags = new Map();
  const addTag = (t, id) => {
    if (!t) return;
    if (!tags.has(t)) tags.set(t, new Set());
    tags.get(t).add(id);
  };
  for (const b of boxes.values()) {
    addTag(b.id, b.id);
    for (const a of b.aliases || []) addTag(a, b.id);
    if (b.handle) addTag(b.handle, b.id);
  }
  const stages = new Map();
  for (const s of model?.stages || []) { stages.set(s.id, s.id); if (s.title) stages.set(s.title, s.id); }
  const callers = new Map();
  for (const [id, f] of Object.entries(fns)) for (const c of f.calls || []) {
    if (!callers.has(c)) callers.set(c, new Set());
    callers.get(c).add(id);
  }
  return { boxes, order, fnBoxes, byPath, routes, between, succ, tags, stages, warnings, facts, fns, callers,
    resolvePath: makePathResolver(facts), unique: uniqueNames(fns) };
}

/** bare name / qualname -> fnId, only when exactly one function carries it. */
function uniqueNames(fns) {
  const seen = new Map();
  const note = (k, id) => { if (!seen.has(k)) seen.set(k, new Set()); seen.get(k).add(id); };
  for (const [id, f] of Object.entries(fns)) {
    note(f.qual, id);
    note(String(f.qual).split('.').pop(), id);
  }
  const out = new Map();
  for (const [k, ids] of seen) out.set(k, ids.size === 1 ? [...ids][0] : null);
  return out;
}

/** Functions whose span holds the line, innermost first. */
export function fnChain(ix, file, line) {
  const list = ix.byPath.get(file);
  if (!list) return [];
  return list.filter((f) => line >= f.line && line <= f.end).map((f) => f.id);
}

/** Resolve a loose function name (logs, spans) to one fnId, or null when absent or ambiguous. */
export function fnByName(ix, name, file) {
  if (!name) return { id: null };
  if (ix.fns[name]) return { id: name };
  if (file) {
    const p = ix.resolvePath(file);
    const id = p && ix.fns[p + '::' + name] ? p + '::' + name : null;
    if (id) return { id };
  }
  if (ix.unique.has(name)) {
    const id = ix.unique.get(name);
    return id ? { id } : { id: null, ambiguous: true };
  }
  return { id: null };
}

/**
 * Map one step. First match wins: ref inside a cited function body, then sym, then tag.
 * Several boxes may cite one function: candidates come back ordered nearest cited line first, then model order.
 */
export function mapStep(ix, step) {
  let why = 'step has no ref, sym or tag';
  const ref = typeof step.ref === 'string' ? parseRef(step.ref) : null;
  if (ref) {
    const file = ix.resolvePath(ref.file);
    if (!file) why = `ref ${step.ref}: file is not in the facts`;
    else {
      const chain = fnChain(ix, file, ref.line);
      if (!chain.length) why = `ref ${step.ref}: no function holds that line`;
      for (const fn of chain) {
        const cites = ix.fnBoxes.get(fn);
        if (cites?.length) return { status: 'mapped', via: 'ref', fn, cands: rank(ix, cites, ref.line, fn, 'ref') };
      }
      if (chain.length) why = `ref ${step.ref}: ${chain[0]} is cited by no box`;
    }
  }
  if (step.sym) {
    const cites = ix.fnBoxes.get(step.sym);
    if (cites?.length) return { status: 'mapped', via: 'sym', fn: step.sym, cands: rank(ix, cites, null, step.sym, 'sym') };
    if (!ref) why = ix.fns[step.sym] ? `sym ${step.sym} is cited by no box` : `sym ${step.sym} is not in the facts`;
  }
  if (step.tag) {
    const hit = ix.tags.get(step.tag);
    if (hit?.size) {
      const ids = [...hit].sort((a, b) => ix.order.get(a) - ix.order.get(b));
      return { status: 'mapped', via: 'tag', fn: null, cands: ids.map((box, i) => ({ box, rank: i, dist: 0, via: 'tag' })) };
    }
    if (ix.stages.has(step.tag)) return { status: 'stage', via: 'tag', stage: ix.stages.get(step.tag), cands: [] };
    if (!ref && !step.sym) why = `tag ${step.tag} is no box id, alias or stage`;
  }
  return { status: 'unmapped', why, cands: [] };
}

function rank(ix, cites, line, fn, via) {
  const rows = cites.map((c) => {
    let dist = 0;
    if (line != null && c.lines.length) dist = Math.min(...c.lines.map((l) => Math.abs(l - line)));
    return { box: c.box, dist, via, fn };
  });
  rows.sort((a, b) => a.dist - b.dist || ix.order.get(a.box) - ix.order.get(b.box));
  rows.forEach((r, i) => { r.rank = i; });
  return rows;
}

const hasRoute = (ix, a, b) => ix.between.has(a + '\u0000' + b);

/** Boxes a step really points at: the nearest cited line (ties kept). A far box never lights just because a route fits. */
export function lights(m) {
  if (m.status !== 'mapped' || !m.cands.length) return [];
  const best = m.cands[0].dist;
  return m.cands.filter((c) => c.dist === best).map((c) => c.box);
}

/** Boxes of one called function the system can pass through after entering it: routes among the boxes it cites. */
function closure(ix, entries, within) {
  const seen = new Set(entries);
  const queue = [...entries];
  while (queue.length) {
    const a = queue.pop();
    for (const b of ix.succ.get(a) || []) if (within.has(b) && !seen.has(b)) { seen.add(b); queue.push(b); }
  }
  return seen;
}

/** Boxes that cite a function, or one of its callers up to two levels: the untraced glue that runs between two calls. */
function glueBoxes(ix, fnA, fnB) {
  const key = fnA + '\u0000' + fnB;
  if (ix._glue?.has(key)) return ix._glue.get(key);
  const fns = new Set([fnA, fnB].filter(Boolean));
  let frontier = [...fns];
  for (let d = 0; d < 2; d++) {
    const next = [];
    for (const f of frontier) for (const c of ix.callers.get(f) || []) if (!fns.has(c)) { fns.add(c); next.push(c); }
    frontier = next;
  }
  const out = new Set();
  for (const f of fns) for (const c of ix.fnBoxes.get(f) || []) out.add(c.box);
  (ix._glue ||= new Map()).set(key, out);
  return out;
}

/** Entries reachable from the live boxes in one route, or through glue boxes (at most 4 routes). */
function reach(ix, live, targets, glue) {
  const hit = new Set();
  for (const t of targets) {
    if (live.has(t)) { hit.add(t); continue; }
    for (const l of live) if (hasRoute(ix, l, t)) { hit.add(t); break; }
  }
  if (hit.size === targets.size) return hit;
  let frontier = [...live];
  const seen = new Set(frontier);
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next = [];
    for (const a of frontier) for (const b of ix.succ.get(a) || []) {
      if (targets.has(b)) hit.add(b);
      if (glue.has(b) && !seen.has(b)) { seen.add(b); next.push(b); }
    }
    frontier = next;
  }
  return hit;
}

/**
 * Replay an ordered walk over the routes and find where it stops fitting.
 * A step is a function call, so it may pass through every box that function cites (closure over routes among them).
 * A step fits when one of its boxes is live, is one route from a live box, is reached through boxes of the calling
 * code that run between two calls, or its function is joined to the previous step's function by a direct call edge
 * (a call trace is not a flow chart: the call explains it). Steps with no box are skipped.
 * When nothing fits the map is missing that route: record it, re-anchor, keep going.
 * Deliberately generous: a gap is only claimed when no box of the called function fits.
 */
export function replayOrdered(ix, mapped, opts = {}) {
  if (opts.rests) return replayRests(ix, mapped);
  const seq = [];
  mapped.forEach((m, i) => { if (m.status === 'mapped') seq.push({ i, m }); });
  const gaps = [];
  let live = null, prevFn = null, prefixDone = false, explained = 0, viaCall = 0, viaGlue = 0;
  seq.forEach(({ i, m }, k) => {
    const all = m.cands.map((c) => c.box);
    const within = new Set(all);
    if (live == null) { live = closure(ix, all, within); explained = 1; prevFn = m.fn; return; }
    const joined = prevFn && m.fn && (ix.fns[prevFn]?.calls?.includes(m.fn) || ix.fns[m.fn]?.calls?.includes(prevFn));
    if (joined) {
      viaCall++;
      live = closure(ix, all, within);
      if (!prefixDone) explained++;
      prevFn = m.fn;
      return;
    }
    const direct = reach(ix, live, within, new Set());
    const entries = direct.size ? direct : reach(ix, live, within, glueBoxes(ix, prevFn, m.fn));
    if (entries.size) {
      if (!direct.size) viaGlue++;
      live = closure(ix, [...entries], within);
      if (!prefixDone) explained++;
      prevFn = m.fn;
      return;
    }
    prefixDone = true;
    gaps.push({ index: i, prevIndex: seq[k - 1].i, from: [...live].sort(), to: all.slice().sort(), prevFn, fn: m.fn,
      evidence: 'seen in the trace only', explainedPrefix: explained, first: gaps.length === 0 });
    live = closure(ix, all, within);
    prevFn = m.fn;
  });
  return { seq, gaps, viaCall, viaGlue, explainedPrefix: seq.length ? Math.min(explained, seq.length) : 0, mappedSteps: seq.length, totalSteps: mapped.length };
}

/** Every box reachable from one box by following routes (the box itself included). Memoized on the index. */
function reachFrom(ix, a) {
  const memo = (ix._reach ||= new Map());
  if (memo.has(a)) return memo.get(a);
  const seen = new Set([a]);
  const stack = [a];
  while (stack.length) for (const b of ix.succ.get(stack.pop()) || []) if (!seen.has(b)) { seen.add(b); stack.push(b); }
  memo.set(a, seen);
  return seen;
}

/**
 * Walks whose steps are places the system rests at (an explorer's states), not calls: one action may cross several boxes.
 * A step fits when its box is reachable from the previous one along any chain of routes. A gap is then a strong claim:
 * no chain of drawn routes leads there at all.
 */
function replayRests(ix, mapped) {
  const seq = [];
  mapped.forEach((m, i) => { if (m.status === 'mapped') seq.push({ i, m }); });
  const gaps = [];
  let live = null, explained = 0, prefixDone = false;
  for (let k = 0; k < seq.length; k++) {
    const { i, m } = seq[k];
    const all = m.cands.map((c) => c.box);
    if (live == null) { live = new Set(all); explained = 1; continue; }
    const next = new Set();
    for (const c of all) for (const l of live) if (reachFrom(ix, l).has(c)) { next.add(c); break; }
    if (next.size) { live = next; if (!prefixDone) explained++; continue; }
    prefixDone = true;
    gaps.push({ index: i, prevIndex: seq[k - 1].i, from: [...live].sort(), to: all.slice().sort(), prevFn: null, fn: null,
      evidence: 'no chain of drawn routes joins the two', explainedPrefix: explained, first: gaps.length === 0 });
    live = new Set(all);
  }
  return { seq, gaps, viaCall: 0, viaGlue: 0, explainedPrefix: seq.length ? Math.min(explained, seq.length) : 0, mappedSteps: seq.length, totalSteps: mapped.length };
}
