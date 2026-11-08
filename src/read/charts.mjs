// Charts: one drawn chart per function worth a picture (its own boxes, a card for each function it calls, a stub for each folded exit, a marker for
// calls the tool could not follow). A chart that would hold more than LIMIT boxes is cut into parts. Every other function is read as a text outline.
// Ids are short and hash-free: f<n> for a function, c<n> for a chart, f<n>.<k> for a box.
import { clip, cmp, sortBy } from './util.mjs';
import { classifySite, refusalShaped, cleanExit } from './outcomes.mjs';
import { TITLE_MAX, endSiteLabel } from './words.mjs';
import { langOf } from './util.mjs';

export const HOT_BYTES = 8600000;   // the drawn charts may add about this many bytes to a page (measured: the page carries about 1.06 times the estimate); a page stays under 16 000 000 bytes, and the rest of it (the Reader, the viewer, the page's own data) is 1.6 to 6.2 MB on the two systems measured
export const LAYOUT_FACTOR = 2;      // what the placer's drawing adds to a chart's own data, as a multiple of it (measured: the page carries about twice the bytes of the chart data)
export const HOT_FLOOR = 2;       // a function needs at least this many boxes to be worth a chart
export const LIMIT = 21;          // boxes on one chart; above it the chart is cut into parts
export const MAX_CALLS = 9;       // one box shows at most this many callee cards; the rest become one "N more functions" box
export const CHART_TITLE_MAX = 70;

const ROAD_WORDS = { call: 'calls', link: 'requests' };

/** Words for a road, from what it connects. The tool's own label stays in `raw`. */
export function roadWords(r, from) {
  if (r.kind === 'call') return r.prov.tier === 'may' ? 'may call' : ROAD_WORDS.call;
  if (r.kind === 'link') return ROAD_WORDS.link;
  if (r.kind === 'exc') return 'if it fails';
  if (from.prov.rule === 'loop') return r.when === 'each item' ? 'each time round' : 'when done';
  if (from.kind === 'decision') return r.when === 'else' ? 'no' : 'yes';
  return 'then';
}

/** Folded arms that go round a loop again: they are not an exit, so no exit stub is drawn for them. */
export const LOOP_FOLDS = new Set(['loops-back', 'continues']);

/**
 * Title, outcome and sharing key for a folded exit (an arm the reduction folded into its decision). The title is read from the line of the
 * return or raise. Exits that return some value and read as a success share one stub titled "Returns a value", since they are not the same value;
 * every other exit is titled by what it returns or raises, so a refusal or a failure is never called "a value".
 */
export function stubWords(W, fe, path) {
  const cls = fe.class ?? '';
  const lang = langOf(path);
  const ex = W.source.exitExpr(path, fe.line);
  const expr = cleanExit(ex?.text ?? '', lang);
  const kind = cls.startsWith('raise') ? 'raise' : cls === 'X' ? 'exit' : 'return';
  const r = classifySite({ kind, expr, cls, fnName: '', lang });
  let title;
  if (kind === 'return' && cls === 'RV' && r.outcome === 'success') title = 'Returns a value';
  else if (ex) title = endSiteLabel({ cls }, { kind, expr, why: r.why }).t;
  else if (kind === 'raise') title = cls.split(':').pop() && cls.split(':').pop() !== '*' ? `Fails with ${cls.split(':').pop()}` : 'Raises an error';
  else if (kind === 'exit') title = 'Exits the program';
  else title = cls === 'R0' ? 'Returns nothing' : 'Returns a value';
  title = clip(title, TITLE_MAX);
  return { title, outcome: r.outcome, why: r.why, key: `${cls}|${fe.rt ?? ''}|${title}|${r.outcome}` };
}

function sizeOf(W, fid) {
  return W.fns.get(fid).boxes.length;
}

/**
 * @param {{W:object, names:object, words:Map, ends:Map, districts:{of:Map, order:string[]}, extraHot:Set<string>}} d
 */
export function buildCharts({ W, CM, names, words, ends, districts, extraHot, budget = HOT_BYTES }) {
  const mapped = W.mappedIds;
  const callees = new Map();
  for (const fid of mapped) callees.set(fid, new Set((W.calleesOf.get(fid) ?? []).map((r) => W.fnOf(r.to)).filter((g) => g && g !== fid && W.fns.get(g)?.mapped)));
  const fnIndex = new Map(mapped.map((f, i) => [f, i + 1]));
  const dIndex = new Map(districts.order.map((d, i) => [d, i]));

  // which functions get a chart: those the shown journeys pass through, then the biggest, until the byte budget is spent (chosen below, once a chart can be built)
  const charted = mapped.filter((f) => sizeOf(W, f) >= HOT_FLOOR);
  const hot = new Set();
  let order;
  let chartId;   // the chart of a function is named by the function's number, so a chart keeps its id when other functions gain or lose a chart

  const pageBoxId = (fid, b) => `f${fnIndex.get(fid)}.${W.fns.get(fid).boxes.indexOf(b)}`;
  const charts = [];
  const pageBoxOf = new Map(); // model box id -> {chart, id}

  const buildOne = (fid) => {
    const f = W.fns.get(fid);
    const fi = fnIndex.get(fid);
    const district = districts.of.get(fid);
    const boxes = [];
    const roads = [];
    const idOf = new Map();
    for (const b of f.boxes) {
      const w = words.get(b.id) ?? { title: b.title, plain: '', raw: b.title };
      const e = ends.get(b.id);
      const pb = {
        id: pageBoxId(fid, b), ref: b.id, shape: 'own', kind: b.kind, rule: b.prov.rule, title: w.title, plain: w.plain, raw: w.raw, line: b.prov.line, path: f.path, district,
      };
      if (e) pb.outcome = e.outcome;
      if (b.prov.effects?.length) pb.effects = b.prov.effects;
      if (W.entryBox(fid) === b.id) pb.entry = true;
      idOf.set(b.id, pb.id);
      boxes.push(pb);
    }
    const cards = new Map();
    const stubs = new Map();
    let nCard = 0;
    let nStub = 0;
    for (const b of f.boxes) {
      for (const r of W.out.get(b.id)) {
        if (idOf.has(r.to)) {
          roads.push({ from: idOf.get(r.from), to: idOf.get(r.to), type: r.type, when: roadWords(r, b), raw: r.when, tier: r.prov.tier ?? 'proven', via: r.prov.rule });
          continue;
        }
        const g = W.fnOf(r.to);
        if (!g || g === fid) continue;
        if (!cards.has(g)) {
          const gf = W.fns.get(g);
          const n = gf.boxes.length;
          const state = hot.has(g) ? `Has its own chart (${n} boxes).` : n >= 2 ? `Text outline only, no drawn chart (${n} boxes).` : n === 1 ? 'One box, no chart.' : 'No boxes of its own.';
          cards.set(g, { id: `f${fi}.c${++nCard}`, fn: g, shape: 'card', kind: 'step', title: clip(`→ ${names.label(g)}`, TITLE_MAX), plain: `${gf.path}:${gf.line}. ${state}`, raw: g, line: gf.line, path: gf.path, district, target: hot.has(g) ? g : null, sure: false });
        }
        const card = cards.get(g);
        if (r.prov.tier === 'proven' || r.prov.tier === 'linked') card.sure = true;
        roads.push({ from: idOf.get(r.from), to: card.id, type: 'forward', when: roadWords(r, b), raw: r.when, tier: r.prov.tier ?? 'proven', via: r.prov.rule });
      }
      for (const fe of b.prov.folded_exits ?? []) {
        if (LOOP_FOLDS.has(fe.class)) continue;
        const sw = stubWords(W, fe, f.path);
        const key = sw.key;
        if (!stubs.has(key)) {
          stubs.set(key, { id: `f${fi}.s${++nStub}`, fn: fid, shape: 'stub', kind: 'end', title: sw.title, plain: `An exit folded into the decision above: ${sw.title.toLowerCase()} (first seen at ${f.path}:${fe.line}).`, raw: `${fe.class}`, line: fe.line, path: f.path, outcome: sw.outcome, district });
        }
        roads.push({ from: idOf.get(b.id), to: stubs.get(key).id, type: 'forward', when: fe.when === 'else' ? 'no' : 'yes', raw: fe.when, tier: 'proven', via: 'folded-exit' });
      }
    }
    for (const c of cards.values()) {
      if (!c.sure) c.title = clip(`→? ${c.title.slice(2)}`, TITLE_MAX);
      boxes.push(c);
    }
    for (const s of stubs.values()) boxes.push(s);
    // calls the scanner saw but nobody resolved: the function continues there, nothing is drawn past them
    const open = CM.openCalls(fid);
    if (open.length) {
      const nm = [...new Set(open.map((x) => x.name))].slice(0, 8);
      const ob = { id: `f${fi}.o`, fn: fid, shape: 'open', kind: 'open', title: clip(`continues: ${open.length} call${open.length === 1 ? '' : 's'} not followed`, TITLE_MAX), plain: `Calls the tool could not resolve to project code: ${nm.join(', ')}${open.length > nm.length ? ` and ${open.length - nm.length} more` : ''}. This is not an ending: the function carries on there and nothing is drawn past those calls.`, raw: `${open.length} unresolved`, line: Math.min(...open.map((x) => x.line || f.line)), path: f.path, district, ending: false };
      boxes.push(ob);
      const entry = boxes.find((x) => x.entry) ?? boxes[0];
      if (entry) roads.push({ from: entry.id, to: ob.id, type: 'forward', when: 'and', raw: '', tier: 'open', via: 'open-end' });
    }
    return { boxes: capHubs(fi, boxes, roads), roads };
  };

  // The budget is in bytes of page: what a function's chart would carry (its boxes, cards, exits, roads and their words, as the page data holds them), times
  // LAYOUT_FACTOR for the drawing the placer adds. Boxes were a poor measure: a function whose boxes call many others costs several times what a quiet one of the
  // same size does. The estimate reads only the map, so the same map always draws the same charts.
  const costs = new Map();
  const costOf = (fid) => {
    if (!costs.has(fid)) {
      const c = buildOne(fid);
      costs.set(fid, Math.round(JSON.stringify([c.boxes, c.roads]).length * LAYOUT_FACTOR));
    }
    return costs.get(fid);
  };
  let spent = 0;
  for (const f of extraHot) {          // in the order the journeys met them: the most important journey first
    if (W.fns.get(f)?.mapped && sizeOf(W, f) >= HOT_FLOOR && !hot.has(f)) {
      if (spent + costOf(f) > budget) continue;
      hot.add(f);
      spent += costOf(f);
    }
  }
  for (const f of sortBy(charted, (x) => -sizeOf(W, x), (x) => ((W.callersOf.get(x) ?? []).length ? 1 : 0), (x) => W.fns.get(x).qual, (x) => x)) {
    if (hot.has(f)) continue;
    if (spent + costOf(f) > budget) break;
    hot.add(f);
    spent += costOf(f);
  }
  order = sortBy(charted.filter((f) => hot.has(f)), (f) => dIndex.get(districts.of.get(f)) ?? 99, (f) => ((W.callersOf.get(f) ?? []).length ? 1 : 0), (f) => (W.fns.get(f).anon ? 1 : 0), (f) => -callees.get(f).size, (f) => names.label(f), (f) => f);
  chartId = new Map(order.map((f) => [f, `c${fnIndex.get(f)}`]));

  function capHubs(fi, boxes, roads) {
    const byId = new Map(boxes.map((b) => [b.id, b]));
    const outs = new Map();
    for (const r of roads) {
      const t = byId.get(r.to);
      if (t?.shape === 'card' && byId.has(r.from)) {
        if (!outs.has(r.from)) outs.set(r.from, []);
        outs.get(r.from).push(r);
      }
    }
    const drop = new Set();
    const add = [];
    let k = 0;
    for (const [from, rs] of outs) {
      if (rs.length <= MAX_CALLS + 1) continue;
      const rest = rs.slice(MAX_CALLS);
      const nm = rest.map((r) => byId.get(r.to).title.replace(/^→\??\s*/, ''));
      const mid = `f${fi}.m${++k}`;
      add.push({ id: mid, shape: 'more', kind: 'step', title: clip(`→ ${rest.length} more functions`, TITLE_MAX), plain: `${rest.length} more functions are called from this box: ${nm.slice(0, 14).join(', ')}${nm.length > 14 ? ` and ${nm.length - 14} more` : ''}.`, raw: '', line: byId.get(from).line, path: byId.get(from).path, district: byId.get(from).district, names: nm });
      roads.push({ from, to: mid, type: 'forward', when: `${rest.length} more calls`, raw: '', tier: 'proven', via: 'hub-cap' });
      for (const r of rest) drop.add(r.to);
    }
    if (!drop.size) return boxes;
    for (let i = roads.length - 1; i >= 0; i--) if (drop.has(roads[i].to)) roads.splice(i, 1);
    return [...boxes.filter((b) => !drop.has(b.id)), ...add];
  }

  function split(fid, chartKey, boxes, roads) {
    if (boxes.length <= LIMIT) return [{ id: chartKey, boxes, roads, n: 1 }];
    const own = boxes.filter((b) => b.shape === 'own').sort((a, b) => a.line - b.line || cmp(a.id, b.id));
    const pos = new Map(own.map((b, i) => [b.id, i]));
    const anchor = new Map();
    for (const r of roads) if (pos.has(r.from) && !pos.has(r.to) && !anchor.has(r.to)) anchor.set(r.to, r.from);
    for (const r of roads) if (anchor.has(r.from) && !pos.has(r.to) && !anchor.has(r.to)) anchor.set(r.to, anchor.get(r.from));
    const weight = own.map(() => 1);
    for (const a of anchor.values()) weight[pos.get(a)]++;
    const cross = new Array(own.length + 1).fill(0);
    for (const r of roads) {
      if (pos.has(r.from) && pos.has(r.to)) {
        const [a, b] = [pos.get(r.from), pos.get(r.to)].sort((x, y) => x - y);
        for (let i = a + 1; i <= b; i++) cross[i]++;
      }
    }
    const target = LIMIT - 7;
    const cuts = [];
    let start = 0;
    let acc = 0;
    let i = 0;
    while (i < own.length) {
      if (acc + weight[i] > target && i > start) {
        let best = i;
        for (let c = Math.max(start + 1, i - 6); c <= i; c++) if (cross[c] < cross[best] || (cross[c] === cross[best] && c > best)) best = c;
        cuts.push(best);
        start = best;
        acc = 0;
        i = best;
        continue;
      }
      acc += weight[i];
      i++;
    }
    const bounds = [0, ...cuts, own.length];
    const partOf = new Map();
    for (let n = 0; n < bounds.length - 1; n++) for (let j = bounds[n]; j < bounds[n + 1]; j++) partOf.set(own[j].id, n);
    for (const [x, a] of anchor) partOf.set(x, partOf.get(a));
    const k = bounds.length - 1;
    const pid = (n) => (n === 0 ? chartKey : `${chartKey}p${n + 1}`);
    const outB = Array.from({ length: k }, () => []);
    const outR = Array.from({ length: k }, () => []);
    const byId = new Map(boxes.map((b) => [b.id, b]));
    for (const b of boxes) outB[partOf.get(b.id) ?? 0].push(b);
    const firstOwn = new Map();
    for (const b of own) if (!firstOwn.has(partOf.get(b.id))) firstOwn.set(partOf.get(b.id), b.id);
    const crossTargets = new Map();
    for (const r of roads) {
      const pa = partOf.get(r.from) ?? 0;
      const pb = partOf.get(r.to) ?? 0;
      if (pa !== pb) {
        if (!crossTargets.has(pa)) crossTargets.set(pa, new Set());
        crossTargets.get(pa).add(r.to);
      }
    }
    const links = new Map();
    for (const r of roads) {
      const pa = partOf.get(r.from) ?? 0;
      const pb = partOf.get(r.to) ?? 0;
      if (pa === pb) {
        outR[pa].push(r);
        continue;
      }
      const many = crossTargets.get(pa).size > 8;
      const tgt = many ? byId.get(firstOwn.get(pb)) : byId.get(r.to);
      const lk = `${pa}|${tgt.id}`;
      if (!links.has(lk)) {
        const lid = `${tgt.id.split('.')[0]}.k${links.size + 1}`;
        links.set(lk, lid);
        outB[pa].push({ id: lid, fn: fid, shape: 'link', kind: 'step', title: clip(`→ part ${pb + 1}: ${tgt.title.replace(/^→\??\s*/, '')}`, TITLE_MAX), plain: `The function continues in part ${pb + 1} of its chart, at: ${tgt.title} (line ${tgt.line}).`, raw: '', line: tgt.line, path: tgt.path, district: tgt.district, part: pb + 1 });
        outR[pa].push({ from: lid, to: tgt.id, type: 'forward', when: 'continues', raw: '', tier: 'proven', via: 'part-link' });
      }
      outR[pa].push({ ...r, to: links.get(lk) });
    }
    return outB.map((bx, n) => ({ id: pid(n), boxes: bx, roads: outR[n], n: n + 1 }));
  }

  for (const fid of order) {
    const f = W.fns.get(fid);
    const built = buildOne(fid);
    const parts = split(fid, chartId.get(fid), built.boxes, built.roads);
    const nCallers = (W.callersOf.get(fid) ?? []).length;
    const who = nCallers ? `Called from ${nCallers} place${nCallers === 1 ? '' : 's'}` : 'No known caller';
    const title = clip(names.label(fid), CHART_TITLE_MAX);
    charts.push({
      id: chartId.get(fid), fid, fn: `f${fnIndex.get(fid)}`, title, district: districts.of.get(fid),
      summary: `${f.path}:${f.line}. ${who}. ${f.boxes.length} ${f.boxes.length === 1 ? 'box' : 'boxes'} of its own (the chart also draws the functions it calls as cards).`,
      parts: parts.map((p) => ({ id: p.id, title: parts.length > 1 ? clip(`${names.label(fid)} (part ${p.n} of ${parts.length})`, CHART_TITLE_MAX) : title, boxes: p.boxes, roads: p.roads })),
    });
    for (const p of parts) for (const b of p.boxes) if (b.ref) pageBoxOf.set(b.ref, { chart: chartId.get(fid), part: p.id, id: b.id });
  }

  // outlines: every function with two or more boxes that has no chart is read as text
  const outlines = [];
  for (const fid of mapped) {
    if (hot.has(fid) || sizeOf(W, fid) < 1) continue;
    const f = W.fns.get(fid);
    const built = sizeOf(W, fid) >= HOT_FLOOR ? buildOne(fid) : null;
    const own = f.boxes.map((b) => {
      const w = words.get(b.id) ?? { title: b.title, plain: '' };
      return { id: pageBoxId(fid, b), kind: b.kind, title: w.title, plain: w.plain, line: b.prov.line };
    });
    outlines.push({ fn: `f${fnIndex.get(fid)}`, fid, boxes: built ? built.boxes.filter((b) => b.shape !== 'own').map((b) => ({ id: b.id, kind: b.kind, shape: b.shape, title: b.title, plain: b.plain, line: b.line })).concat(own) : own, roads: built ? built.roads : [] });
  }

  const rows = mapped.map((fid) => {
    const f = W.fns.get(fid);
    return {
      id: `f${fnIndex.get(fid)}`, fid, label: names.label(fid), long: names.long(fid), path: f.path, line: f.line, district: districts.of.get(fid), boxes: f.boxes.length,
      callers: (W.callersOf.get(fid) ?? []).length, callees: [...callees.get(fid)].map((g) => `f${fnIndex.get(g)}`).sort(cmp), chart: chartId.get(fid) ?? null, anonymous: f.anon || undefined,
    };
  });
  return { charts, outlines, functions: rows, hot: [...hot], pageBoxOf, fnIndex, stats: { chartedFunctions: order.length, chartParts: charts.reduce((n, c) => n + c.parts.length, 0), boxesDrawn: spent, outlines: outlines.length } };
}
