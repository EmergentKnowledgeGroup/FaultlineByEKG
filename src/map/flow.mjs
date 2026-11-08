// Per-function flow charts, read off the emitted model.
//
// A flow chart is one function's own boxes and roads, one card per other function it calls, and a small exit stub for every folded arm. The stub is
// what makes a decision show both ways out: an arm that ends in something the reduction folded (`return`, `raise`, falling off the end, looping
// straight back) has no box to point at, so the chart points at a stub that says what that arm does. Nothing is invented: every stub comes from a
// `folded_exits` row the map already holds.
import { sorted, cpSlice, cpLen, pyRepr } from './pyrt.mjs';

const CARD_TITLE = 34; // characters of a callee's name shown on its card
const slug = (s) => s.replace(/[^A-Za-z0-9_.]/gu, '_');

export function stubTitle(fe) {
  const c = fe.class ?? '';
  const rt = fe.rt ?? null;
  if (c === 'R0') return 'returns nothing';
  if (c === 'RV') return 'returns a value';
  if (c === 'continues') return 'carries on (folded)';
  if (c === 'loops-back') return 'repeats (loop body folded)';
  if (c === 'X') return 'exits the process';
  if (c === 'raise:*') return rt === 'rethrow' ? 'rethrows the error' : 'raises (type not known)';
  if (c.startsWith('raise')) return 'raises ' + c.slice(c.indexOf(':') + 1);
  if (c.startsWith('R:')) return 'returns ' + c.slice(2).replaceAll('const:str:', '').replaceAll('const:', '');
  return 'ends (' + c + ')';
}

/** -> Map function id -> {boxes, routes} for every function that has boxes (or just `only`). */
export function charts(model, only = null) {
  const bs = new Map(model.boxes.map((b) => [b.id, b]));
  const byfn = new Map();
  const outs = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const b of model.boxes) push(byfn, b.prov.fn, b);
  for (const r of model.routes) push(outs, r.from, r);
  const res = new Map();
  for (const fid of only === null ? sorted(byfn.keys()) : [only]) {
    const own = sorted(byfn.get(fid), (b) => [b.prov.line, b.id]);
    const ids = new Set(own.map((b) => b.id));
    const boxes = own.map((b) => ({ id: b.id, role: 'own', kind: b.kind, title: b.title, rule: b.prov.rule, line: b.prov.line }));
    const routes = [];
    const cards = new Map();
    const stubs = new Map();
    let k = 0;
    for (const b of own) {
      for (const r of outs.get(b.id) ?? []) {
        if (ids.has(r.to)) routes.push({ id: `${fid}#r${k}`, from: b.id, to: r.to, type: r.type, when: r.when, rule: r.prov.rule, tier: r.prov.tier ?? null });
        else {
          const t = bs.get(r.to);
          const g = t.prov.fn;
          if (!cards.has(g)) {
            cards.set(g, `${fid}#card.${slug(g)}`);
            const q = g.slice(g.indexOf('::') + 2);
            boxes.push({ id: cards.get(g), role: 'card', kind: 'step', title: cpLen(q) > CARD_TITLE ? cpSlice(q, cpLen(q) - CARD_TITLE) : q, rule: 'card', line: t.prov.line });
          }
          routes.push({ id: `${fid}#r${k}`, from: b.id, to: cards.get(g), type: 'forward', when: r.when, rule: r.prov.rule, tier: r.prov.tier ?? null });
        }
        k++;
      }
      for (const fe of b.prov.folded_exits ?? []) {
        const key = JSON.stringify([fe.class, fe.rt ?? null]);
        if (!stubs.has(key)) {
          stubs.set(key, `${fid}#stub.${slug(fe.class)}.${fe.rt ?? ''}`);
          boxes.push({ id: stubs.get(key), role: 'stub', kind: 'end', title: stubTitle(fe), rule: 'exit-stub', line: fe.line });
        }
        routes.push({ id: `${fid}#r${k}`, from: b.id, to: stubs.get(key), type: 'forward', when: fe.when, rule: 'exit-stub', tier: null });
        k++;
      }
    }
    res.set(fid, { boxes, routes });
  }
  return res;
}

/** Decisions and bounded loops of a chart that show fewer than 2 ways out although the code has 2 or more arms. (A `while True` loop has one arm by
 *  construction: its way out is a break or a return inside the body.) */
export function oneExitDecisions(chart, modelBoxes) {
  const arms = new Map(modelBoxes.map((b) => [b.id, b.prov.arms ?? 2]));
  const bound = new Map(modelBoxes.map((b) => [b.id, b.prov.bound ?? null]));
  const ways = new Map();
  for (const r of chart.routes) {
    if (r.rule === 'cfg-edge' || r.rule === 'exit-stub') {
      if (!ways.has(r.from)) ways.set(r.from, new Set());
      ways.get(r.from).add(r.when);
    }
  }
  return chart.boxes.filter((b) => b.role === 'own' && (b.rule === 'decision' || b.rule === 'loop') && bound.get(b.id) !== 'none' && (arms.get(b.id) ?? 2) >= 2 && (ways.get(b.id)?.size ?? 0) < 2).map((b) => b.id);
}

/** Plain-text rendering of a chart, boxes in line order then roads, for reading in a terminal or a test. */
export function chartText(chart) {
  const t = new Map(chart.boxes.map((b) => [b.id, b]));
  const out = [];
  for (const b of chart.boxes) {
    out.push(`  [${b.role.padEnd(4)}] ${b.kind.padEnd(8)} L${String(b.line).padEnd(5)} ${b.title}`);
    for (const r of chart.routes) {
      if (r.from === b.id) out.push(`           --${pyRepr(cpSlice(r.when, 0, 30))} (${r.rule}${r.tier ? '/' + r.tier : ''})--> ${t.get(r.to).title}`);
    }
  }
  return out.join('\n');
}

