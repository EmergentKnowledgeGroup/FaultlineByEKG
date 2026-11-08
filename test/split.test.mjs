// How a stage above 21 boxes is cut into chart parts (src/build/split.mjs) and how the parts are named (src/build/charts.mjs).
//   node --test test/split.test.mjs
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitStage, readingOrder, HUB_IN } from '../src/build/split.mjs';
import { chartsFromModel, readingOrder as readingOrderFromCharts } from '../src/build/charts.mjs';
import * as build from '../src/build/index.mjs';
import { makeModel } from '../src/place/synth.mjs';
import { rng } from '../src/place/rng.mjs';

const MAX = 21;
let RID = 0;
const box = (id, kind = 'step', file = 'a.py', extra = {}) => ({ id, kind, title: `T ${id}`, stage: 's', refs: [{ path: file }], ...extra });
const road = (from, to, type = 'forward') => ({ id: `r${++RID}`, from, to, type });
// a chain of n boxes named `${p}1..${p}n` (the last is an end), with optional extra roads
function chain(p, n, file = 'a.py') {
  const boxes = [], routes = [];
  for (let i = 1; i <= n; i++) boxes.push(box(`${p}${i}`, i === n ? 'end' : 'step', file));
  for (let i = 1; i < n; i++) routes.push(road(`${p}${i}`, `${p}${i + 1}`));
  return { boxes, routes };
}
const join = (...gs) => ({ boxes: gs.flatMap((g) => g.boxes), routes: gs.flatMap((g) => g.routes) });
const split = (g, main = [], max = MAX, opts) => splitStage(g.boxes, g.routes, main, max, opts);
const partOf = (parts) => new Map(parts.flatMap((p, i) => p.map((id) => [id, i])));
const cutCount = (parts, routes) => { const at = partOf(parts); return routes.filter((r) => at.get(r.from) !== at.get(r.to)).length; };
function assertPartition(g, parts, max = MAX) {
  const all = parts.flat();
  assert.equal(all.length, g.boxes.length, 'every box is in a part');
  assert.equal(new Set(all).size, all.length, 'no box is in two parts');
  for (const p of parts) { assert.ok(p.length >= 1 && p.length <= max, `part of ${p.length}`); }
  const order = new Map(g.boxes.map((b, i) => [b.id, i]));
  for (const p of parts) for (let i = 1; i < p.length; i++) assert.ok(order.get(p[i - 1]) < order.get(p[i]), 'model order inside a part');
}
// families (weakly connected pieces) of the boxes of one part, over the roads inside it
function familiesIn(part, routes) {
  const set = new Set(part), par = new Map(part.map((id) => [id, id])), f = (x) => { while (par.get(x) !== x) x = par.get(x); return x; };
  for (const r of routes) if (set.has(r.from) && set.has(r.to)) par.set(f(r.from), f(r.to));
  return new Set(part.map(f)).size;
}
// a seeded stage: several families, each a spine of steps and decisions with skips and returns; a decision fans out to end boxes of its own
function randomStage(seed, sizes) {
  const R = rng(seed), boxes = [], routes = [];
  sizes.forEach((n, f) => {
    const spine = [];
    for (let i = 0; i < n; i++) {
      const id = `f${f}.${i}`, last = spine[spine.length - 1];
      if (last && R() < 0.4) { boxes.push(box(id, 'end', `file${f}.py`)); routes.push(road(last, id)); continue; }
      boxes.push(box(id, R() < 0.3 ? 'decision' : 'step', `file${f}.py`));
      if (last) { routes.push(road(last, id)); if (spine.length > 3 && R() < 0.3) routes.push(road(id, spine[R.int(spine.length - 2)], 'return')); if (spine.length > 2 && R() < 0.25) routes.push(road(spine[spine.length - 2], id)); }
      spine.push(id);
    }
  });
  return { boxes, routes };
}

test('a stage at or under the cap stays one part in model order; an empty stage has none', () => {
  const g = chain('a', 21);
  assert.deepEqual(split(g), [g.boxes.map((b) => b.id)]);
  assert.deepEqual(splitStage([], [], [], MAX), []);
  const small = chain('a', 5);
  assert.deepEqual(split(small), [['a1', 'a2', 'a3', 'a4', 'a5']]);
});

test('every part is at most max, every box is in exactly one part, and the cut is deterministic', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const g = randomStage(seed, [30, 25, 14, 9, 3]);
    const a = split(g), b = split(g);
    assertPartition(g, a);
    assert.deepEqual(a, b, 'same input, same parts');
  }
  const m = makeModel({ stages: 3, perStage: 60, seed: 7 });
  for (const s of m.stages) {
    const boxes = m.boxes.filter((x) => x.stage === s.id), ids = new Set(boxes.map((x) => x.id));
    const routes = m.routes.filter((r) => ids.has(r.from) && ids.has(r.to));
    assertPartition({ boxes, routes }, splitStage(boxes, routes, [], MAX));
  }
  assertPartition(chain('a', 40), split(chain('a', 40), [], 6), 6);   // a small cap works too
});

test('families with no road between them are never one chart', () => {
  const g = join(chain('a', 14), chain('b', 15), chain('c', 6, 'c.py'));
  const parts = split(g);
  assertPartition(g, parts);
  for (const p of parts) assert.equal(familiesIn(p, g.routes), 1, 'one connected family per part');
  const at = partOf(parts);
  assert.equal(new Set(['a1', 'a14'].map((i) => at.get(i))).size, 1, 'a family that fits stays whole');
  assert.equal(new Set(['b1', 'b15'].map((i) => at.get(i))).size, 1);
  assert.notEqual(at.get('a1'), at.get('b1'));
  assert.notEqual(at.get('a1'), at.get('c1'));
});

test('tiny families (under 4 boxes) share a chart only when they cite the same first source file', () => {
  const g = join(chain('big', 20, 'big.py'), chain('p', 2, 'same.py'), chain('q', 3, 'same.py'), chain('r', 2, 'other.py'), chain('s', 3, 'mixed.py'));
  g.boxes.find((b) => b.id === 's2').refs = [{ path: 'elsewhere.py' }];
  const parts = split(g), at = partOf(parts);
  assertPartition(g, parts);
  assert.equal(at.get('p1'), at.get('q1'), 'two tiny families, one file: one chart');
  assert.notEqual(at.get('p1'), at.get('r1'));
  assert.notEqual(at.get('r1'), at.get('s1'));
  assert.notEqual(at.get('big1'), at.get('p1'));
  // and four-box families are not tiny: never joined, whatever the file
  const h = join(chain('big', 20, 'same.py'), chain('u', 4, 'same.py'), chain('v', 4, 'same.py'));
  const at2 = partOf(split(h));
  assert.notEqual(at2.get('u1'), at2.get('v1'));
  assert.notEqual(at2.get('u1'), at2.get('big1'));
});

test('boxes with no road in the stage go together in a final part, apart from the rest, and are chunked at the cap', () => {
  const lone = (n) => Array.from({ length: n }, (_, i) => box(`x${i + 1}`, 'step', i % 2 ? 'a.py' : 'b.py'));
  const g1 = join(chain('a', 15), chain('b', 10), { boxes: lone(3), routes: [] });
  const p1 = split(g1);
  assertPartition(g1, p1);
  assert.deepEqual([...p1[p1.length - 1]].sort(), ['x1', 'x2', 'x3'], 'the final part holds exactly the unconnected boxes');
  assert.equal(p1.length, 3);
  const g2 = join(chain('a', 25), { boxes: lone(30), routes: [] });
  const p2 = split(g2);
  assertPartition(g2, p2);
  const tail = p2.filter((p) => p.every((id) => id.startsWith('x')));
  assert.equal(tail.length, 2, '30 unconnected boxes need two parts');
  assert.ok(p2.slice(-2).every((p) => p.every((id) => id.startsWith('x'))), 'and they come last');
  assert.ok(p2.slice(0, -2).every((p) => p.every((id) => !id.startsWith('x'))), 'nothing unconnected rides with a family');
});

test('a leaf stays with its source: an end fed by one box, and a box with one road in and none out', () => {
  for (const seed of [11, 12, 13, 14]) {
    const g = randomStage(seed, [40, 35]);
    const parts = split(g), at = partOf(parts);
    const ins = new Map(g.boxes.map((b) => [b.id, new Set()])), outs = new Map(g.boxes.map((b) => [b.id, 0])), cntIn = new Map(g.boxes.map((b) => [b.id, 0]));
    for (const r of g.routes) { ins.get(r.to).add(r.from); outs.set(r.from, outs.get(r.from) + 1); cntIn.set(r.to, cntIn.get(r.to) + 1); }
    const fan = new Map(); for (const b of g.boxes) if (ins.get(b.id).size === 1) { const s = [...ins.get(b.id)][0]; fan.set(s, (fan.get(s) || 0) + 1); }
    let checked = 0;
    for (const b of g.boxes) {
      const leaf = b.kind === 'end' ? ins.get(b.id).size === 1 : cntIn.get(b.id) === 1 && outs.get(b.id) === 0;
      if (!leaf || ins.get(b.id).size !== 1) continue;
      const src = [...ins.get(b.id)][0];
      if (fan.get(src) > MAX - 2 || ins.get(src).size === 1 && outs.get(src) === 1) continue;   // a source with a huge fan-out may overflow; a leaf's leaf is glued only one step
      assert.equal(at.get(b.id), at.get(src), `${b.id} follows ${src}`); checked++;
    }
    assert.ok(checked > 5, 'the generator makes leaves: ' + checked);
  }
  // an end box that is also reached by a second box is not glued to either
  const g = join(chain('a', 12), chain('b', 12), { boxes: [box('e', 'end')], routes: [road('a5', 'e'), road('b5', 'e')] });
  assertPartition(g, split(g));
});

test('a hub (more than 8 roads in) does not glue families: it joins the family that sends it the most', () => {
  assert.equal(HUB_IN, 8);
  const A = chain('a', 12), B = chain('b', 12), hub = box('h', 'step', 'h.py');
  const routes = [...A.routes, ...B.routes];
  for (let i = 1; i <= 6; i++) routes.push(road(`a${i}`, 'h'));
  for (let i = 1; i <= 4; i++) routes.push(road(`b${i}`, 'h'));
  routes.push(road('h', 'a12'));
  const g = { boxes: [...A.boxes, ...B.boxes, hub], routes };
  const parts = split(g), at = partOf(parts);
  assertPartition(g, parts);
  assert.equal(at.get('h'), at.get('a1'), 'with the family that sends it six roads, not four');
  assert.notEqual(at.get('a1'), at.get('b1'), 'the two families are not glued into one chart through the hub');
  // 8 roads in is not a hub: the same shape is one connected family of 25 and is cut by clustering instead
  const r2 = [...A.routes, ...B.routes]; for (let i = 1; i <= 4; i++) { r2.push(road(`a${i}`, 'h')); r2.push(road(`b${i}`, 'h')); }
  const g2 = { boxes: g.boxes, routes: r2 };
  assertPartition(g2, split(g2));
});

test('a part under 5 boxes that has a road to another part joins the part it talks to most, unless the cap forbids', () => {
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
    const g = randomStage(seed, [45, 38, 22]), parts = split(g), at = partOf(parts);
    for (const [i, p] of parts.entries()) {
      if (p.length >= 5) continue;
      const talks = new Set();
      for (const r of g.routes) { const a = at.get(r.from), b = at.get(r.to); if (a !== b && (a === i || b === i)) talks.add(a === i ? b : a); }
      for (const j of talks) assert.ok(parts[j].length + p.length > MAX, `part of ${p.length} could have joined a part of ${parts[j].length}`);
    }
  }
  // a concrete case: a chain of 24 whose tail would be a stub of 3 if cut at the cap
  const g = chain('a', 24), parts = split(g);
  assertPartition(g, parts);
  assert.ok(parts.every((p) => p.length >= 5), 'no stub: ' + parts.map((p) => p.length));
});

test('clustering cuts between dense groups, not through them', () => {
  const dense = (p, n) => {
    const boxes = Array.from({ length: n }, (_, i) => box(`${p}${i}`, 'step', `${p}.py`)), routes = [];
    for (let i = 0; i < n; i++) for (const k of [1, 2, 3]) if (i + k < n) routes.push(road(`${p}${i}`, `${p}${i + k}`));
    return { boxes, routes };
  };
  const A = dense('a', 10), B = dense('b', 10), C = dense('c', 10);
  const g = { boxes: [...C.boxes, ...A.boxes, ...B.boxes], routes: [...A.routes, ...B.routes, ...C.routes, road('a9', 'b0'), road('b9', 'c0')] };
  const parts = split(g), at = partOf(parts);
  assertPartition(g, parts);
  for (const G of [A, B, C]) assert.equal(new Set(G.boxes.map((b) => at.get(b.id))).size, 1, 'a dense group is never cut');
  assert.ok(cutCount(parts, g.routes) <= 2, 'only the two seams are cut: ' + cutCount(parts, g.routes));   // groups joined by one road each stay separate charts
});

test('parts are ordered by the earliest reading position of any box; the main path starts part 1', () => {
  const g = join(chain('b', 15), chain('a', 15));   // b first in model order, a on the main path
  const parts = split(g, ['a1', 'a2', 'a3']);
  assert.ok(parts[0].includes('a1'), 'the part that holds the start of the main path is first');
  const parts2 = split(g, []);
  assert.ok(parts2[0].includes('b1'), 'without a main path, model order decides');
  // one big family: the part with the entry box is first, and later parts come in reading order
  const h = chain('c', 40), ps = split(h), ro = readingOrder(h.boxes, h.routes, []), at = new Map(ro.map((id, i) => [id, i]));
  assert.ok(ps[0].includes('c1'));
  const first = ps.map((p) => Math.min(...p.map((id) => at.get(id))));
  assert.deepEqual(first, first.slice().sort((x, y) => x - y));
});

test('chartsFromModel: parts are named for the part\'s entry box or the box field partName; ids, part and parts keep their shape', () => {
  const g = join(chain('a', 14), chain('b', 14));
  g.boxes.find((b) => b.id === 'b6').partName = 'Second half named by hand';
  const model = { system: { name: 'Sys' }, stages: [{ id: 's', title: 'Stage S', blurb: 'About it.' }], boxes: g.boxes, routes: g.routes, paths: [{ id: 'main', boxes: ['a1', 'a2'] }] };
  const charts = chartsFromModel(model), parts = charts.filter((c) => c.kind === 'stage');
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((c) => c.id), ['stage_s_1', 'stage_s_2']);
  assert.deepEqual(parts.map((c) => [c.part, c.parts, c.stage]), [[1, 2, 's'], [2, 2, 's']]);
  assert.equal(parts[0].title, 'Stage S: T a1', 'no partName: the entry box title');
  assert.equal(parts[0].name, 'T a1');
  assert.equal(parts[1].title, 'Stage S: Second half named by hand', 'a partName on any box wins');
  assert.match(parts[0].summary, /14 boxes, 13 roads\.$/);
  assert.ok(!/part \d of \d/.test(parts[0].title), 'the old "(part 1 of 2)" is gone');
  assert.equal(new Set(charts.map((c) => c.id)).size, charts.length);
  const owner = new Map(parts.flatMap((c) => c.boxes.map((b) => [b.id, c.id])));
  assert.equal(owner.size, g.boxes.length, 'each box lives in exactly one part');
  assert.equal(build.homeChart(charts, 'b6'), 'stage_s_2');
  assert.deepEqual(chartsFromModel(model).map((c) => c.id + c.title), charts.map((c) => c.id + c.title), 'deterministic');
});

test('chartsFromModel: a stage at or under max is one chart with the old id and title; a long name is cut; duplicate names stay distinct', () => {
  const small = { system: {}, stages: [{ id: 'st_Fetch it', title: 'Fetch' }], boxes: chain('a', 10).boxes.map((b) => ({ ...b, stage: 'st_Fetch it' })), routes: chain('a', 10).routes, paths: [] };
  const c = chartsFromModel(small).find((x) => x.kind === 'stage');
  assert.equal(c.id, 'stage_fetch_it');
  assert.equal(c.title, 'Fetch');
  assert.equal(c.parts, 1);
  assert.equal(c.name, undefined);
  const g = join(chain('a', 14), chain('b', 14));
  for (const b of g.boxes) b.title = 'Same title for every box that is also much longer than any chart name should ever be';
  const m = { system: {}, stages: [{ id: 's', title: 'S' }], boxes: g.boxes, routes: g.routes, paths: [] };
  const names = chartsFromModel(m).filter((x) => x.kind === 'stage').map((x) => x.name);
  assert.ok(names.every((n) => n.length <= 54), names.join('|'));
  assert.equal(new Set(names).size, names.length, 'two parts never share a name');
});

test('readingOrder is still exported from charts.mjs and the build index', () => {
  assert.equal(readingOrderFromCharts, readingOrder);
  assert.equal(build.readingOrder, readingOrder);
  const g = chain('a', 5);
  assert.deepEqual(readingOrder(g.boxes, g.routes, []), ['a1', 'a2', 'a3', 'a4', 'a5']);
});
