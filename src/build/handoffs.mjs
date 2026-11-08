// Hand-offs between stages: handoffs/*.json rows, the landing rule that turns "this function" into a box, join, and the
// write-nothing check a stage agent runs on its own rows.
//   landingFor(index, symbol, line)       which box a hand-off to a function lands on, and whether that deserves a second look
//   returnLanding(index, reachOf, ...)    which box a RETURN hand-off lands on: the one that calls into the returning flow
//   resolveHandoffs(rows, model, facts)   pure, two phases: {routes, unresolved, review, results}
//   joinHandoffs(dir, model, facts)       writes model/80-handoffs.json, handoffs.unresolved.json, handoffs.review.json
//   checkHandoffs(dir, model, facts, stage)   the same resolution for ONE stage's own rows, writing nothing
//
// Landing rule for forward, deliver and record roads, in order:
//   1. a box that is ABOUT the function: its `handle` is that symbol, or its FIRST ref is that symbol. A handle that is only the symbol's short or
//      qualified name (a generic word like "run") counts only when that box's first ref is in the same file as the symbol;
//   2. among those, the function's ENTRY: a box with no road in from another box that also cites the function (nothing inside the function leads to it);
//   3. then boxes that are not endings before endings;
//   4. then the lowest cited line (or, when the writer gave a toLine, the cited line nearest to it).
// Two things come before those: a box about the function citing it on exactly the writer's toLine (the writer pointed at it), and a function is never
// entered at one of its endings when any other box cites it.
// A box that cites the function only as a later ref wins only when no box is about it. Those landings, ties, and any road from one
// stage onto an ending of another (when the row named the function, not a box) go to handoffs.review.json with the reason. An explicit `to` always wins
// and is never second-guessed.
//
// A RETURN (type "return") hands flow back to whoever called, so "the function's entry" is the wrong answer: it lands on the box that CALLS INTO the
// returning box's flow. Landing happens in two phases, because that needs every forward road in place: first every other row lands (forward and deliver
// roads of the model plus the ones just landed are the forward roads), then each return does, in this order:
//   explicit `to`                          always wins
//   1. a box citing the function on exactly the writer's toLine (a box the writer pointed at), then
//   2. a box with a forward road into the returning box or into a box the returning box is reachable from; the fewest forward hops to the returning box,
//      then the cited line nearest toLine, then model order;
//   3. else, with a toLine, the cited line nearest to it (reason return-nearest-line); else the first box as the rule above has it (reason return-first).
// Every return landed by inference gets a row in handoffs.review.json saying how (`how`); the last two and ties are the ones to look at.
// join never reads its own output: the routes in model/80-handoffs.json are left out of the inputs, so running it twice writes the same files.
import path from 'node:path';
import fs from 'node:fs';
import { readJson, writeJson } from './project.mjs';
import { buildGraph } from '../model/graph.mjs';
import { citeIndex, indexFacts, normPath, refSymbol, symbolPath } from '../model/refs.mjs';
import { slug } from '../model/text.mjs';

export const JOIN_FILE = '80-handoffs.json';
const qualOf = (sym) => (sym.includes('::') ? sym.split('::').slice(1).join('::') : sym);
const NO_LINE = 1e6 - 1;
const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
const FORWARD = new Set(['forward', 'deliver']);

export function landingIndex(model) {
  const g = buildGraph(model), cites = citeIndex(model), first = new Map(), handle = new Map();
  for (const b of g.boxes) {
    const refs = Array.isArray(b.refs) ? b.refs : [];
    if (refs.length) { const s = refSymbol(refs[0]); if (s) push(first, s, b.id); }
    const h = normPath(b.handle || ''); if (h) push(handle, h, b.id);
  }
  return { g, cites, first, handle };
}

// -> {box, secondary, tie, candidates:[{box, kind, primary, lineGap?}]} or null when no box cites the symbol
export function landingFor(idx, sym, line, explicit = false) {
  const { g, cites, first, handle } = idx, seen = new Map();
  const note = (id, d, primary) => {
    const e = seen.get(id) || { box: id, d: Infinity, primary: false };
    e.d = Math.min(e.d, d); e.primary = e.primary || primary; seen.set(id, e);
  };
  // a cited line: how far from the writer's toLine when there is one, else simply how early in the file
  for (const c of cites.get(sym) || []) note(c.box, c.line ? (explicit ? Math.abs(c.line - line) : c.line) : NO_LINE, false);
  const mod = symbolPath(sym), qual = qualOf(sym), short = qual.split('.').pop();
  const sameFile = (id) => { const r = (g.byId.get(id).refs || [])[0]; return !!r && symbolPath(refSymbol(r)) === mod; };
  for (const id of [...(first.get(sym) || []), ...(handle.get(sym) || [])]) note(id, NO_LINE, true);
  for (const id of [...(handle.get(qual) || []), ...(handle.get(short) || [])]) if (sameFile(id)) note(id, NO_LINE, true);
  if (!seen.size) return null;
  // the function's entry: no road in from another box that also cites the function
  const about = new Set(seen.keys());
  const innerIn = (id) => g.inX(id).some((r) => r.type !== 'record' && r.from !== id && about.has(r.from));
  // the writer's exact line on a box about the function is the writer pointing at that box. A road into a function is not entered at one of its endings
  // while any other box cites it: that box decides between them, or calls it
  const isEnd = (e) => g.byId.get(e.box).kind === 'end', rows = [...seen.values()];
  const skipEnds = rows.some((e) => e.primary && isEnd(e)) && rows.some((e) => !isEnd(e));
  const rank = (e) => [explicit && e.d === 0 && e.primary && !isEnd(e) ? 0 : 1, skipEnds && isEnd(e) ? 1 : 0, e.primary ? 0 : 1, innerIn(e.box) ? 1 : 0, isEnd(e) ? 1 : 0, e.d, g.order.get(e.box)];
  const all = rows.sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
  const best = all[0], runner = all[1];
  const tie = !!runner && rank(runner).slice(0, -1).join() === rank(best).slice(0, -1).join();
  return { box: best.box, secondary: !best.primary, tie, candidates: all.slice(0, 6).map((e) => ({ box: e.box, kind: g.byId.get(e.box).kind, primary: e.primary, ...(e.d < NO_LINE ? { lineGap: e.d } : {}) })) };
}

// Every box that cites the function (or is named by it), with all the lines it cites: Map box -> {box, lines, primary}. The same set landingFor ranks.
function citers(idx, sym) {
  const { g, cites, first, handle } = idx, m = new Map();
  const at = (id) => { if (!m.has(id)) m.set(id, { box: id, lines: [], primary: false }); return m.get(id); };
  for (const c of cites.get(sym) || []) { const e = at(c.box); if (c.line) e.lines.push(c.line); }
  const mod = symbolPath(sym), qual = qualOf(sym), short = qual.split('.').pop();
  const sameFile = (id) => { const r = (g.byId.get(id).refs || [])[0]; return !!r && symbolPath(refSymbol(r)) === mod; };
  for (const id of [...(first.get(sym) || []), ...(handle.get(sym) || [])]) at(id).primary = true;
  for (const id of [...(handle.get(qual) || []), ...(handle.get(short) || [])]) if (sameFile(id)) at(id).primary = true;
  return m;
}

// Where a return lands. `reachOf(box)` -> Map box -> forward hops to `box` (the boxes that can reach it by forward roads, itself at 0).
// -> {box, how: 'caller'|'line'|'nearest-line'|'first', tie, hops?, candidates} or null when no box cites the function.
export function returnLanding(idx, reachOf, sym, line, from) {
  const { g } = idx, set = citers(idx, sym);
  set.delete(from);
  if (!set.size) { const l = landingFor(idx, sym, 0, false); return l ? { box: l.box, how: 'first', tie: false, candidates: l.candidates } : null; }
  const dist = reachOf(from), hasLine = line != null && Number.isFinite(line);
  const rows = [...set.values()].map((e) => ({
    ...e, hops: dist.has(e.box) ? dist.get(e.box) : null,
    exact: hasLine && e.lines.includes(line),
    gap: hasLine ? (e.lines.length ? Math.min(...e.lines.map((l) => Math.abs(l - line))) : NO_LINE) : 0,
  }));
  const rank = (e) => [e.exact ? 0 : 1, e.exact && e.primary ? 0 : 1, e.hops != null ? 0 : 1, e.hops ?? 0, e.gap, e.primary ? 0 : 1, g.order.get(e.box)];
  const cmp = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  const all = rows.sort(cmp), best = all[0], runner = all[1];
  const cands = all.slice(0, 6).map((e) => ({ box: e.box, kind: g.byId.get(e.box).kind, primary: e.primary, ...(e.hops != null ? { hops: e.hops } : {}), ...(e.gap < NO_LINE && hasLine ? { lineGap: e.gap } : {}) }));
  if (best.hops != null || best.exact) {
    const same = !!runner && runner.hops != null && best.hops != null && runner.hops === best.hops && runner.gap === best.gap && runner.exact === best.exact;
    return { box: best.box, how: best.hops != null ? 'caller' : 'line', tie: same, hops: best.hops ?? undefined, candidates: cands };
  }
  if (hasLine) return { box: best.box, how: 'nearest-line', tie: false, candidates: cands };
  const l = landingFor(idx, sym, 0, false);
  return { box: l.box, how: 'first', tie: false, candidates: l.candidates };
}

export const REVIEW_WORDS = {
  'later-ref': 'the box cites this function only as a later reference; no box is about it',
  tie: 'two or more boxes are equally good landings',
  'ends-elsewhere': 'a road from one stage lands on an ending of another stage',
  'line-outside': 'toLine is not inside the function',
  'return-caller': 'a return landed on the box that calls into the returning flow: a forward road leads from it, directly or through other boxes, to the returning box',
  'return-line': 'a return landed on the box that cites exactly the toLine the writer gave; no forward road from it into the returning flow is drawn',
  'return-nearest-line': 'a return whose caller could not be found by the roads (no box citing the function leads into the returning flow): landed on the cited line nearest toLine',
  'return-first': 'a return whose caller could not be found, with no toLine to go on: landed on the first box that cites the function',
  'return-tie': 'a return with two or more callers equally near the returning flow and the same distance from toLine: the first in model order was taken',
};
// the reasons that are questions for a person; the other return rows only say how the road landed
export const ASKS = new Set(['later-ref', 'tie', 'ends-elsewhere', 'line-outside', 'return-nearest-line', 'return-first', 'return-tie']);

// handoffs/*.json: [{from, to | toSymbol, toLine?, type, when, why, refs, inferred}]. `from` must be a box the writer owns;
// the far side is named by code, because the writer may not know the other stage's box ids yet.
export function readHandoffRows(dir) {
  const folder = path.join(dir, 'handoffs'), rows = [];
  if (fs.existsSync(folder)) for (const f of fs.readdirSync(folder).sort()) {
    if (!f.endsWith('.json')) continue;
    const j = readJson(path.join(folder, f), []);
    for (const r of Array.isArray(j) ? j : j.handoffs || []) rows.push({ ...r, _file: f });
  }
  return rows;
}

// The ids of the routes join itself wrote (model/80-handoffs.json), so they can be left out of what landing reads.
export function joinedIds(dir, model) {
  const ids = new Set(), file = readJson(path.join(dir, 'model', JOIN_FILE), null);
  for (const r of (file && file.routes) || []) if (r && r.id) ids.add(r.id);
  const src = (model && model.sources && model.sources.routes) || {};
  for (const [id, f] of Object.entries(src)) if (f === JOIN_FILE) ids.add(id);
  return ids;
}

// Resolve rows to boxes. Nothing is written. -> {routes, unresolved, review, results:[{row, status:'ok'|'bad', to?, why?, near?, reasons:[], how?}]}
// opts.joined: route ids to leave out of the model first (join's own output). Rows land in two phases (see the top), output stays in row order.
export function resolveHandoffs(rows, model0, facts, opts = {}) {
  const skip = opts.joined, model = skip && skip.size ? { ...model0, routes: (model0.routes || []).filter((r) => !skip.has(r.id)) } : model0;
  const idx = landingIndex(model), g = idx.g, fx = indexFacts(facts);
  const own = new Set((model.routes || []).map((r) => `${r.from}>${r.to}`));
  const items = rows.map((r) => ({ r, res: { row: r, status: 'ok', reasons: [] }, rev: [], bad: null }));
  let reachOf = () => new Map();
  const isRet = (r) => r.type === 'return' && !(r.to && g.byId.has(r.to));
  const land1 = (it) => {
    const { r, res } = it;
    const miss = (why, near = []) => { res.status = 'bad'; res.why = why; res.near = near; it.bad = { file: r._file, from: r.from, toSymbol: r.toSymbol, to: r.to, when: r.when, why, near }; };
    const ask = (reason, cands = [], extra = {}) => {
      if (ASKS.has(reason)) res.reasons.push(reason);
      it.rev.push({ file: r._file, from: r.from, to: res.to, toSymbol: r.toSymbol, toLine: r.toLine ?? null, reason, why: REVIEW_WORDS[reason], ...extra, candidates: cands });
    };
    if (!g.byId.has(r.from)) { miss('from is not a box'); return; }
    let to = r.to && g.byId.has(r.to) ? r.to : null, land = null;
    if (!to && r.to) { miss('to is not a box'); return; }
    if (!to) {
      const sym = normPath(r.toSymbol || ''), f = fx.functions[sym], hasLine = r.toLine != null && Number.isFinite(+r.toLine);
      if (!f) { miss('toSymbol is not a function in the facts'); return; }
      const none = () => miss('no box cites this function', g.boxes.filter((b) => (b.refs || []).some((x) => symbolPath(refSymbol(x)) === symbolPath(sym))).slice(0, 5).map((b) => b.id));
      if (r.type === 'return') {
        land = returnLanding(idx, reachOf, sym, hasLine ? +r.toLine : null, r.from);
        if (!land) { none(); return; }
      } else {
        land = landingFor(idx, sym, r.toLine ?? f.line, hasLine);
        if (!land) { none(); return; }
      }
      to = land.box; res.to = to;
      if (hasLine && f.line != null && (+r.toLine < f.line || +r.toLine > (f.end ?? f.line))) {
        res.lineOutside = `toLine ${r.toLine} is outside ${sym} (lines ${f.line}-${f.end ?? f.line})`; ask('line-outside', land.candidates);
      }
      if (r.type === 'return') {
        res.how = land.how;
        if (to !== r.from) ask(land.tie ? 'return-tie' : `return-${land.how}`, land.candidates, { how: land.how, ...(land.hops != null ? { hops: land.hops } : {}) });
      } else {
        if (land.secondary) ask('later-ref', land.candidates);
        if (land.tie) ask('tie', land.candidates);
      }
    }
    res.to = to;
    if (to === r.from) { miss('lands on the box it leaves from, so no road is drawn', land ? land.candidates.map((c) => c.box).filter((b) => b !== to) : []); return; }
    const dest = g.byId.get(to);
    if (land && dest.kind === 'end' && (g.byId.get(r.from).stage || '') !== (dest.stage || '')) ask('ends-elsewhere', land.candidates);       // an explicit `to` was decided by someone already
  };
  // phase 1: everything that is not a return by inference. Its landings are the forward roads a return reads.
  for (const it of items) if (!isRet(it.r)) land1(it);
  const into = new Map();
  const edge = (a, b, type) => { if (a !== b && FORWARD.has(type || 'forward')) push(into, b, a); };
  for (const r of model.routes || []) edge(r.from, r.to, r.type);
  for (const it of items) if (!isRet(it.r) && it.res.status === 'ok' && it.res.to) edge(it.r.from, it.res.to, it.r.type);
  const cache = new Map();
  reachOf = (x) => {
    if (cache.has(x)) return cache.get(x);
    const d = new Map([[x, 0]]), q = [x];
    for (let h = 0; h < q.length; h++) for (const p of into.get(q[h]) || []) if (!d.has(p)) { d.set(p, d.get(q[h]) + 1); q.push(p); }
    cache.set(x, d); return d;
  };
  // phase 2: returns
  for (const it of items) if (isRet(it.r)) land1(it);
  // assemble in row order, so the files read the same whatever the phases did
  const routes = [], unresolved = [], review = [], results = [], seen = new Map();
  for (const it of items) {
    const { r, res } = it;
    results.push(res);
    review.push(...it.rev);
    if (it.bad) { unresolved.push(it.bad); continue; }
    const to = res.to, key = `${r.from}>${to}`;
    if (own.has(key)) { res.dup = 'already drawn'; continue; }
    if (seen.has(key)) {
      const was = seen.get(key);
      if (r.when && was.when !== r.when && (was.why || '').length < 400) was.why = `${was.why} Also: ${r.when}: ${r.why || ''}`.trim();
      res.dup = 'same road as an earlier row'; continue;
    }
    const route = { id: `x_${slug(r.from)}__${slug(to)}`, from: r.from, to, type: r.type || 'forward', when: r.when || '', why: r.why || '', refs: r.refs || [], inferred: !!r.inferred };
    seen.set(key, route); routes.push(route);
  }
  return { routes, unresolved, review, results };
}

export const countReasons = (review) => ({
  laterRef: review.filter((x) => x.reason === 'later-ref').length, ties: review.filter((x) => x.reason === 'tie').length,
  onEnding: review.filter((x) => x.reason === 'ends-elsewhere').length, lineOutside: review.filter((x) => x.reason === 'line-outside').length,
});

// how the returns that were not given a `to` landed: {total, caller, line, nearestLine, first, tie}
export const countReturns = (review) => {
  const by = (k) => review.filter((x) => x.reason === k).length, c = by('return-caller'), l = by('return-line'), n = by('return-nearest-line'), f = by('return-first'), t = by('return-tie');
  return { total: c + l + n + f + t, caller: c, line: l, nearestLine: n, first: f, tie: t };
};

// join: handoffs/*.json become model/80-handoffs.json; what cannot resolve is listed (handoffs.unresolved.json), what resolved with a question
// is listed (handoffs.review.json, with how each return landed). The routes already in 80-handoffs.json are not an input, so running join twice
// writes the same files. Re-pointing a road can still change route ids: never re-join a map whose routes are already audited without diffing.
export function joinHandoffs(dir, model, facts) {
  const rows = readHandoffRows(dir), { routes, unresolved, review } = resolveHandoffs(rows, model, facts, { joined: joinedIds(dir, model) });
  writeJson(path.join(dir, 'model', JOIN_FILE), { schema: 'faultline.model/1', routes });
  writeJson(path.join(dir, 'handoffs.unresolved.json'), unresolved);
  writeJson(path.join(dir, 'handoffs.review.json'), review);
  return { read: rows.length, routes: routes.length, unresolved, review, counts: countReasons(review), returns: countReturns(review) };
}

// What `join` would do with ONE stage's own rows, writing nothing. A stage agent runs this (through worklist) instead of join.
// A row is the stage's own when its `from` box is in the stage, or its file is named for the stage.
export function checkHandoffs(dir, model, facts, stage) {
  const rows = readHandoffRows(dir), g = buildGraph(model);
  const names = new Set([stage, slug(stage), String(stage).replace(/^(st|s)_/, '')]);
  const mine = rows.filter((r) => (g.byId.get(r.from) || {}).stage === stage || names.has(String(r._file).replace(/\.json$/, '')));
  const joined = joinedIds(dir, model), { results, review } = resolveHandoffs(mine, model, facts, { joined });
  const bad = [], asks = [];
  for (const x of results) {
    const r = x.row, target = r.to || r.toSymbol || '', fromStage = (g.byId.get(r.from) || {}).stage;
    const why = x.status === 'bad' ? x.why : x.lineOutside || (fromStage && fromStage !== stage ? `from ${r.from} is in stage ${fromStage}, not ${stage}` : '');
    if (why) bad.push({ file: r._file, from: r.from, to: target, why, near: x.near || [] });
    else if (x.reasons.length) asks.push({ file: r._file, from: r.from, to: target, lands: x.to, reasons: x.reasons.map((k) => REVIEW_WORDS[k]) });
  }
  return { rows: mine.length, ok: mine.length - bad.length, bad, asks, review, returns: countReturns(review), g5: g5After(model, joined, results, stage) };
}

// G5 fires on a road with an empty `when` out of a box with two or more exits, and a hand-off adds an exit: a box that has one exit in its own stage file
// (so no check there sees a problem) has two after join. This counts the exits a box has now plus the roads this stage's own hand-offs would add, and names the
// ones with no condition. -> [{box, exits, existing, adds, empties:[{kind:'route'|'hand-off', id|file, to}]}]
export function g5After(model, joined, results, stage) {
  const g = buildGraph({ ...model, routes: (model.routes || []).filter((r) => !joined.has(r.id)) }), byBox = new Map();
  const at = (id) => { if (!byBox.has(id)) byBox.set(id, { box: id, tos: new Map(), empties: [] }); return byBox.get(id); };
  for (const x of results) {
    const r = x.row;
    if (x.status !== 'ok' || x.dup === 'already drawn' || !x.to || (g.byId.get(r.from) || {}).stage !== stage) continue;
    const e = at(r.from);
    if (e.tos.has(x.to)) continue;
    e.tos.set(x.to, 'hand-off');
    if (!String(r.when ?? '').trim()) e.empties.push({ kind: 'hand-off', file: r._file, to: x.to });
  }
  const out = [];
  for (const [id, e] of byBox) {
    const ex = g.outX(id);
    for (const r of ex) if (!e.tos.has(r.to)) e.tos.set(r.to, 'route');
    const total = new Set([...ex.map((r) => r.to), ...e.tos.keys()]).size;
    if (total < 2) continue;
    for (const r of ex) if (!String(r.when ?? '').trim()) e.empties.push({ kind: 'route', id: r.id, to: r.to });
    if (e.empties.length) out.push({ box: id, exits: total, existing: ex.length, adds: [...e.tos.values()].filter((v) => v === 'hand-off').length, empties: e.empties });
  }
  return out.sort((a, b) => (g.order.get(a.box) ?? 0) - (g.order.get(b.box) ?? 0));
}
