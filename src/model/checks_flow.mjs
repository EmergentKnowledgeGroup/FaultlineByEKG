// Flow-shape checks that need only boxes and routes: can-only-go-back, pile-up, hedged-route, no-way-out, no-way-in,
// unreached-from-start. Each returns raw finding drafts: {key, check, boxes, routes, question, evidence}.
// Settings are fixed here, not tuned per system.
import { buildGraph, isReturn, back, fwd, sccs } from './graph.mjs';
import { OUTSIDE_EVENT, HEDGE, CONDITION, len, clip, listMore, upFirst, stop } from './text.mjs';

export const SETTINGS = { pileUpIn: 4, pileUpOutMax: 1, weakMinIn: 3 };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const isOutside = (r) => OUTSIDE_EVENT.test(String(r.when ?? '')) || (!!r.inferred && OUTSIDE_EVENT.test(String(r.why ?? '')));
const quote = (s) => `"${String(s).trim()}"`;

// Undirected connected components of `ids` using routes that satisfy `ok` and have both ends inside `ids`.
export function components(ids, g, ok = () => true) {
  const left = new Set(ids), comps = [];
  const nb = (id) => [...g.out.get(id).filter((r) => ok(r) && ids.has(r.to)).map((r) => r.to), ...g.inn.get(id).filter((r) => ok(r) && ids.has(r.from)).map((r) => r.from)];
  for (const b of g.boxes) {
    if (!left.has(b.id)) continue;
    const comp = [], st = [b.id]; left.delete(b.id);
    while (st.length) { const u = st.pop(); comp.push(u); for (const v of nb(u)) if (left.has(v)) { left.delete(v); st.push(v); } }
    comp.sort((a, c) => g.order.get(a) - g.order.get(c));
    comps.push(comp);
  }
  return comps;
}

function regionFacts(g, comp) {
  const set = new Set(comp);
  const entering = g.routes.filter((r) => !set.has(r.from) && set.has(r.to));
  const internal = g.routes.filter((r) => set.has(r.from) && set.has(r.to));
  const leaving = g.routes.filter((r) => set.has(r.from) && !set.has(r.to));
  const heads = [...new Set(entering.map((r) => r.to))].sort((a, b) => g.order.get(a) - g.order.get(b));
  return { set, entering, internal, leaving, entry: heads[0] || comp[0] };
}
// a road told in boxes (the page turns a box id into its name); a route id means nothing to a reader
const when = (r) => (String(r.when ?? '').trim() ? `, when ${quote(r.when)}` : '');
const routeBit = (r) => `from ${r.from} to ${r.to}${when(r)}`;
const fromList = (rs, n) => listMore([...new Set(rs.map((r) => r.from))], n);

export function canOnlyGoBack(cx) {
  const { g, endIds } = cx, out = [];
  if (!endIds.length) return out;                                    // with no ending drawn there is nothing to be cut off from
  const toEnd = back(g, endIds);
  const trapped = new Set(g.boxes.filter((b) => !toEnd.has(b.id)).map((b) => b.id));
  const claimed = new Set();
  // Strong shape: boxes that reach no ending by any road, and loop among themselves.
  for (const comp of components(trapped, g)) {
    const rf = regionFacts(g, comp);
    const cyc = sccs(comp, new Map(comp.map((id) => [id, g.out.get(id).filter((r) => rf.set.has(r.to))]))).some((c) => c.length > 1 || g.out.get(c[0]).some((r) => r.to === c[0]));
    comp.forEach((id) => claimed.add(id));
    if (!cyc) continue;                                              // a lone way-nowhere is no-way-out's business
    const waits = rf.internal.filter((r) => g.byId.get(r.from) && isOutside(r) && !isReturn(r));
    const n = rf.entering.length, back_ = comp.length > 1 ? `the same ${comp.length} boxes` : 'itself';
    out.push({
      key: `can-only-go-back:${rf.entry}`, check: 'can-only-go-back', shape: 'closed',
      boxes: comp, routes: [...rf.entering, ...rf.internal].map((r) => r.id),
      question: `${plural(n, 'road', 'roads')} in, every road on leads back to ${back_}: what lets flow out of ${rf.entry} reach an ending?`,
      evidence: `${comp.length > 1 ? `${comp.length} boxes reach` : '1 box reaches'} no ending by any road. ${n ? `${upFirst(plural(n, 'road', 'roads'))} ${n === 1 ? 'comes' : 'come'} in, from ${fromList(rf.entering, 3)}.` : 'No road comes in.'} Inside, the roads run ${listMore(rf.internal.map(routeBit), 4, '; ')}.${waits.length ? ` The way on waits for an outside event (${quote(waits[0].when)}).` : ''}`,
    });
  }
  // Weaker shape: no ending without taking a return route, many roads in. One road in is an ordinary retry arm.
  const gN = buildGraph({ boxes: g.boxes, routes: g.routes }, (r) => !isReturn(r));
  const toEndN = back(gN, endIds);
  const R = new Set(g.boxes.filter((b) => b.kind !== 'end' && !toEndN.has(b.id) && !claimed.has(b.id)).map((b) => b.id));
  const asWeak = (comp, why) => {
    const rf = regionFacts(g, comp);
    if (rf.entering.length < SETTINGS.weakMinIn) return;
    const retTo = [...new Set(rf.leaving.filter(isReturn).map((r) => r.to))];
    const outside = rf.leaving.length > 0 && rf.leaving.every(isOutside) || (comp.length === 1 && g.outX(comp[0]).length > 0 && g.outX(comp[0]).every(isOutside));
    out.push({
      key: `can-only-go-back:${rf.entry}`, check: 'can-only-go-back', shape: why,
      boxes: comp, routes: [...rf.entering, ...rf.leaving].map((r) => r.id),
      question: `${plural(rf.entering.length, 'road', 'roads')} in, ${why === 'outside' ? 'every way on waits for an outside event' : 'every way on goes back upstream'}: what triggers the later request?`,
      evidence: `${upFirst(plural(rf.entering.length, 'road', 'roads'))} ${rf.entering.length === 1 ? 'comes' : 'come'} in, from ${fromList(rf.entering, 4)}. The ways on: ${rf.leaving.slice(0, 3).map(routeBit).join('; ') || 'none drawn'}.${retTo.length ? ` They go back upstream (to ${listMore(retTo, 3)}).` : ''}${outside ? ' Each reads as an outside event.' : ''}`,
    });
  };
  for (const comp of components(R, g, (r) => !isReturn(r))) asWeak(comp, 'back');
  // A box whose every exit waits on an outside event, with many roads in.
  for (const b of g.boxes) {
    if (b.kind === 'end' || R.has(b.id) || claimed.has(b.id)) continue;
    const ex = g.outX(b.id);
    if (ex.length && ex.every(isOutside)) asWeak([b.id], 'outside');
  }
  return out;
}

export function pileUp(cx) {
  const out = [];
  for (const b of cx.g.boxes) {
    if (b.kind === 'end') continue;
    const ins = cx.g.inX(b.id), ex = cx.g.outX(b.id);
    if (ins.length < SETTINGS.pileUpIn || ex.length > SETTINGS.pileUpOutMax) continue;
    // A store that many roads fill and one forward road drains is how a queue is meant to look.
    if (b.kind === 'store' && ex.length === 1 && !isReturn(ex[0]) && !isOutside(ex[0])) continue;
    out.push({
      key: `pile-up:${b.id}`, check: 'pile-up', boxes: [b.id], routes: [...ins, ...ex].map((r) => r.id),
      question: `${ins.length} roads in, ${ex.length ? 'one road out' : 'no road out'}: can that ${ex.length ? 'one exit' : 'box'} take everything that arrives?`,
      evidence: `${upFirst(plural(ins.length, 'road', 'roads'))} ${ins.length === 1 ? 'comes' : 'come'} in, from ${fromList(ins, 5)}. ${ex.length ? `The one road out goes to ${ex[0].to}${when(ex[0])} (nothing else leaves).` : 'Nothing is drawn leaving.'}`,
    });
  }
  return out;
}

export function hedgedRoute(cx) {
  const out = [];
  for (const r of cx.g.routes) {
    const w = String(r.when ?? '').trim();
    if (!w || !HEDGE.test(w)) continue;
    if (CONDITION.test(w.replace(new RegExp(HEDGE.source, 'gi'), ' '))) continue;
    out.push({
      key: `hedged-route:${r.id}`, check: 'hedged-route', boxes: [r.from, r.to], routes: [r.id],
      question: `The label ${quote(w)} hedges: what exact condition sends flow from ${r.from} to ${r.to}?`,
      evidence: `The road from ${r.from} to ${r.to} says ${quote(w)}, a hedge word with no condition.${len(r.why) ? ` Its stated reason: ${stop(clip(r.why, 80))}` : ''}`,
    });
  }
  return out;
}

export function noWayOut(cx) {
  const out = [];
  for (const b of cx.g.boxes) {
    if (b.kind === 'end' || b.kind === 'external') continue;
    if (cx.g.outX(b.id).length) continue;
    const ins = cx.g.inX(b.id);
    out.push({
      key: `no-way-out:${b.id}`, check: 'no-way-out', boxes: [b.id], routes: ins.map((r) => r.id),
      question: `No road leaves ${b.id} and it is not marked as an ending: where does flow go next, or should it be an end box?`,
      evidence: `${upFirst(plural(ins.length, 'road', 'roads'))} ${ins.length === 1 ? 'comes' : 'come'} in and none is drawn out. The box's kind is ${b.kind}.`,
    });
  }
  return out;
}

export function noWayIn(cx) {
  const out = [];
  if (!cx.entries.size) return out;                                  // no declared entry: cannot say what counts as unreached
  for (const b of cx.g.boxes) {
    if (cx.entries.has(b.id) || cx.g.inX(b.id).length) continue;
    out.push({
      key: `no-way-in:${b.id}`, check: 'no-way-in', boxes: [b.id], routes: cx.g.outX(b.id).map((r) => r.id),
      question: `No road reaches ${b.id} and it is not a declared entry: what sends flow here?`,
      evidence: `No road comes in; ${plural(cx.g.outX(b.id).length, 'road', 'roads')} ${cx.g.outX(b.id).length === 1 ? 'goes' : 'go'} out. The box's kind is ${b.kind}.`,
    });
  }
  return out;
}

export function unreachedFromStart(cx) {
  const out = [];
  if (!cx.entries.size) return out;
  const seen = fwd(cx.g, cx.entries);
  const lost = new Set(cx.g.boxes.filter((b) => !seen.has(b.id) && cx.g.inX(b.id).length > 0).map((b) => b.id));
  for (const comp of components(lost, cx.g)) {
    out.push({
      key: `unreached-from-start:${comp[0]}`, check: 'unreached-from-start', boxes: comp, routes: [],
      question: `${comp.length === 1 ? `${comp[0]} has` : `${comp.length} boxes starting at ${comp[0]} have`} roads in but no road from any declared entry: what starts ${comp.length === 1 ? 'it' : 'them'}?`,
      evidence: `No path leads here from the declared entries (${listMore([...cx.entries], 3)}).`,
    });
  }
  return out;
}
