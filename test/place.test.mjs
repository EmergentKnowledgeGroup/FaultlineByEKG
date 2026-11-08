// Placer tests. Unit tests need no engine; the end-to-end ones route with the real engine (src/engine) and check the hard metrics are 0.
//   node --test test/place.test.mjs        (about 40 s; set FAULTLINE_BIG=1 for the 400+ box whole-system run, a few minutes)
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rng } from '../src/place/rng.mjs';
import { normalizeChart, analyze } from '../src/place/graph.mjs';
import { makeProxy } from '../src/place/proxy.mjs';
import { snakeStart, toMap } from '../src/place/construct.mjs';
import { arrangeBlocks, snakeShapes } from '../src/place/macro.mjs';
import { composeWhole, mirrorBand, stageTone, slotMap } from '../src/place/compose.mjs';
import { planStreets } from '../src/place/streets.mjs';
import { makeModel } from '../src/place/synth.mjs';
import { loadEngine, hardOf } from '../src/place/engine.mjs';
import { placeChart, placeWhole } from '../src/place/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const E = await loadEngine();
const toy = (() => {                                              // the toy system's hand-written model fragments, merged in filename order
  const dir = path.join(here, '..', 'examples', 'toy', '.faultline', 'model'), m = { stages: [], boxes: [], routes: [], paths: [] };
  for (const f of fs.readdirSync(dir).sort()) { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); for (const k of Object.keys(m)) if (Array.isArray(j[k])) m[k].push(...j[k]); if (j.system) m.system = j.system; }
  return m;
})();
const stageChart = (model, stage) => {
  const ids = new Set(model.boxes.filter(b => b.stage === stage).map(b => b.id));
  return { id: stage, nodes: model.boxes.filter(b => ids.has(b.id)), edges: model.routes.filter(r => ids.has(r.from) && ids.has(r.to)) };
};
const cellsOf = cfg => cfg.map.flatMap(r => r.trim().split(/\s+/)).filter(t => t !== '.');
const routeAndMeasure = async (graph, cfg) => { const geom = await E.gridLayout({ id: graph.id, nodes: graph.nodes, edges: graph.edges, text: {} }, cfg); return { geom, m: E.metrics(geom) }; };

test('rng: same seed same stream, forks differ, shuffle is a permutation', () => {
  const a = rng(7), b = rng(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.notEqual(rng(7).fork(1)(), rng(7).fork(2)());
  assert.deepEqual(rng(3).shuffle([1, 2, 3, 4, 5]).sort(), [1, 2, 3, 4, 5]);
});

test('graph: back edges, spine, roles; accepts engine and model shapes', () => {
  const chart = { id: 'c', nodes: ['a', 'b', 'c', 'd', 'e', 'x'].map(id => ({ id, title: id })), edges: [
    ['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['b', 'x'], ['d', 'b'], ['e', 'a']].map(([from, to], i) => ({ id: 'c:e' + i, from, to, type: 'forward', label: '' })) };
  chart.edges[6].type = 'return';
  const g = normalizeChart(chart), A = analyze(g);
  assert.deepEqual(A.spine, ['a', 'b', 'c', 'd', 'e']);
  assert.ok(A.back.has(6) && A.back.has(5), 'the typed return and the cycle-closing edge are back edges');
  assert.ok(A.roles.x.sink && A.roles.e.sink && A.roles.b.decision && A.roles.a.source);
  assert.deepEqual(analyze(g, { spine: ['b', 'c', 'zzz'] }).spine, ['b', 'c'], 'a given spine wins; unknown ids are dropped');
  const m = normalizeChart({ id: 'm', boxes: [{ id: 'p', kind: 'end', title: 'P' }, { id: 'q', kind: 'step', title: 'Q' }], routes: [{ id: 'r', from: 'q', to: 'p', type: 'forward', when: 'ok' }] });
  assert.equal(m.nodes[0].category, 'end'); assert.equal(m.edges[0].label, 'ok');
  assert.ok(analyze(m).roles.p.end);
});

test('construct: the happy path becomes a snake; map compaction drops empty rows and columns', () => {
  const ids = 'abcdefgh'.split(''), g = normalizeChart({ id: 's', nodes: ids.map(id => ({ id })), edges: ids.slice(1).map((to, i) => ({ id: 'e' + i, from: ids[i], to, label: '' })) });
  const A = analyze(g), pos = snakeStart(A, g, { W: 4, H: 4, rowStep: 2, rand: rng(1) });
  const cr = id => [pos[A.idx.get(id)] % 4, (pos[A.idx.get(id)] / 4) | 0];
  assert.deepEqual(['a', 'b', 'c', 'd'].map(cr), [[0, 0], [1, 0], [2, 0], [3, 0]], 'row 0 runs left to right');
  assert.deepEqual(['e', 'f', 'g', 'h'].map(cr), [[3, 2], [2, 2], [1, 2], [0, 2]], 'row 1 wraps and runs right to left');
  const { map, cols, rows } = toMap(A, pos, 4, 4);
  assert.equal(rows, 2, 'the empty row between the two path rows is compacted away'); assert.equal(cols, 4); assert.equal(map.length, 2);
  assert.equal(snakeStart(A, g, { W: 2, H: 2, rowStep: 2, rand: rng(1) }), null, 'too small a grid returns null');
});

test('proxy: annealing lowers the cost and is deterministic', () => {
  const m = makeModel({ stages: 1, perStage: 14, seed: 4 }), g = normalizeChart({ id: 'p', nodes: m.boxes, edges: m.routes }), A = analyze(g);
  const W = 4, H = 6, p0 = snakeStart(A, g, { W, H, rowStep: 1, rand: rng(2) }), px = makeProxy(A, g, { W, H });
  const a = px.anneal(p0, rng(5), 6000), b = px.anneal(p0, rng(5), 6000);
  assert.ok(a.cost <= px.cost(p0) + 1e-9);
  assert.deepEqual([...a.pos], [...b.pos]);
  assert.equal(new Set(a.pos).size, A.n, 'no two boxes share a cell');
});

test('placeChart: small graph, every box once, hard metrics 0, deterministic per seed', async () => {
  const chart = { id: 'diamond', nodes: ['in', 'check', 'fast', 'slow', 'join', 'out', 'retry'].map(id => ({ id, title: id.toUpperCase() + ' step', kind: id === 'out' ? 'end' : id === 'check' ? 'decision' : 'step' })),
    edges: [['in', 'check', ''], ['check', 'fast', 'small'], ['check', 'slow', 'large'], ['fast', 'join', ''], ['slow', 'join', ''], ['join', 'out', 'done'], ['slow', 'retry', 'failed'], ['retry', 'check', 'again']].map(([from, to, when], i) => ({ id: 'e' + i, from, to, type: to === 'check' && from === 'retry' ? 'return' : 'forward', when })) };
  const c1 = await placeChart(chart, { seed: 3, budgetMs: 2500, evals: 60 }), c2 = await placeChart(chart, { seed: 3, budgetMs: 2500, evals: 60 });
  assert.equal(JSON.stringify(c1), JSON.stringify(c2), 'same seed, same config');
  assert.deepEqual(cellsOf(c1).sort(), chart.nodes.map(n => n.id).sort());
  assert.deepEqual(c1.spine[0], 'in');
  const { m } = await routeAndMeasure(normalizeChart(chart), c1);
  assert.deepEqual(hardOf(m), {}, 'all eight hard metrics are 0');
  assert.ok(m.aspect >= 1.3 && m.aspect <= 2.2, 'aspect ' + m.aspect);
  assert.equal(m.crossings, 0);
});

test('placeChart: a toy stage lands inside the aspect bar with hard metrics 0', async () => {
  const chart = stageChart(toy, 's_intake'), cfg = await placeChart(chart, { seed: 1, budgetMs: 4000, evals: 100, spine: toy.paths[0].boxes });
  const { m } = await routeAndMeasure(normalizeChart(chart), cfg);
  assert.equal(cellsOf(cfg).length, chart.nodes.length);
  assert.deepEqual(hardOf(m), {});
  assert.ok(m.aspect >= 1.3 && m.aspect <= 2.2, 'aspect ' + m.aspect);
  assert.ok(m.fitScale >= 0.7, 'fit ' + m.fitScale);
});

test('placeChart: trivial inputs and bad tokens', async () => {
  assert.deepEqual((await placeChart({ id: 'e', nodes: [], edges: [] })).map, []);
  assert.deepEqual((await placeChart({ id: 'o', nodes: [{ id: 'solo', title: 'Solo' }], edges: [] })).map, ['solo']);
  await assert.rejects(() => placeChart({ id: 'b', nodes: [{ id: 'a b', title: 'x' }, { id: 'c', title: 'y' }], edges: [] }), /grid token/);
});

test('arrangeBlocks: strongly linked stages sit together, any number of stages', () => {
  for (const S of [1, 2, 7, 13]) {
    const blocks = Array.from({ length: S }, (_, i) => ({ id: 'k' + i, w: 3, h: 3, order: i, nodes: [{ id: 'n' + i + 'a', c: 0, r: 0 }, { id: 'n' + i + 'b', c: 2, r: 2 }] }));
    const links = []; for (let i = 0; i + 1 < S; i++) links.push({ a: 'n' + i + 'b', b: 'n' + (i + 1) + 'a', w: 3 });
    const arr = arrangeBlocks(blocks, links, { seed: 2, iters: 12000 });
    assert.equal(Object.keys(arr.cell).length, S);
    assert.equal(new Set(Object.values(arr.cell).map(c => c.join(','))).size, S, 'distinct cells');
    if (S >= 7) { const d = (i, j) => Math.abs(arr.cell['k' + i][0] - arr.cell['k' + j][0]) + Math.abs(arr.cell['k' + i][1] - arr.cell['k' + j][1]); let near = 0; for (let i = 0; i + 1 < S; i++) if (d(i, i + 1) <= 2) near++; assert.ok(near >= S - 3, `chain neighbours stay close (${near}/${S - 1})`); }
  }
});

test('arrangeBlocks: stages follow a clean snake (left to right, wrap, right to left); every shape starts top-left', () => {
  for (const sh of snakeShapes(11)) {
    assert.equal(sh.cells.length, 11); assert.deepEqual(sh.cells[0], [0, 0], 'the story starts top-left');
    for (let k = 0; k + 1 < sh.cells.length; k++) { const [a, b] = [sh.cells[k], sh.cells[k + 1]]; assert.equal(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]), 1, 'consecutive stages touch: ' + sh.lens); }
  }
  const S = 9, blocks = Array.from({ length: S }, (_, i) => ({ id: 'k' + i, w: 4, h: 3, order: i, nodes: [{ id: 'n' + i + 'a', c: 0, r: 0 }, { id: 'n' + i + 'b', c: 3, r: 2 }] }));
  const links = []; for (let i = 0; i + 1 < S; i++) links.push({ a: 'n' + i + 'b', b: 'n' + (i + 1) + 'a', w: 1 });
  const arr = arrangeBlocks(blocks, links, { seed: 1 });
  assert.equal(arr.snake.displaced, 0, 'no stage leaves its snake position when the links agree with the order');
  const rowOf = i => arr.cell['k' + i][1], colOf = i => arr.cell['k' + i][0];
  for (let i = 0; i + 1 < S; i++) assert.ok(rowOf(i + 1) >= rowOf(i) && Math.abs(colOf(i + 1) - colOf(i)) + Math.abs(rowOf(i + 1) - rowOf(i)) === 1, 'stage ' + (i + 1) + ' follows stage ' + i + ' by one step');
  assert.ok(arr.asp >= 1.3 && arr.asp <= 2.2, 'aspect ' + arr.asp);
  // a block narrower than its slot is spread over it, in order, and never past the cap
  assert.deepEqual(slotMap(3, 3), [0, 1, 2]); const m = slotMap(3, 8, 1.7); assert.ok(m.every((v, i) => i === 0 || v > m[i - 1]) && m[2] - m[0] <= 4);
});

test('compose: bands land at block offsets, groups and generated tones per stage', () => {
  const stages = Array.from({ length: 20 }, (_, i) => ({ id: 's' + i, title: 'Stage ' + i })), bands = {};
  stages.forEach((s, i) => { bands[s.id] = { map: [`${s.id}a ${s.id}b`, `. ${s.id}c`], ports: { ['e' + i]: { from: 'E', to: 'N' } }, colGap: { 0: 10 } }; });
  const cell = {}, fh = {}, fv = {}; stages.forEach((s, i) => { cell[s.id] = [i % 5, (i / 5) | 0]; fh[s.id] = i % 2 === 1; fv[s.id] = false; });
  const { cfg, extents } = composeWhole({ stages, bands, arrangement: { cell, fh, fv, GC: 5, GR: 4 } });
  const tokens = cfg.map.flatMap(r => r.split(' ')).filter(t => t !== '.');
  assert.equal(tokens.length, 60); assert.equal(new Set(tokens).size, 60);
  assert.equal(cfg.groups.length, 20); assert.equal(new Set(cfg.groups.map(g => g.tone)).size, 20, 'generated tones are distinct');
  assert.match(cfg.groups[0].title, /^1 · STAGE 0$/);
  assert.equal(extents.s3.col0, 6);
  assert.deepEqual(mirrorBand({ map: ['a b', '. c'], ports: { e: { from: 'E', to: 'N' } } }, true, true).map, ['c .', 'b a']);
  assert.deepEqual(mirrorBand({ map: ['a b'], ports: { e: { from: 'E', to: 'N' } } }, true, false).ports.e, { from: 'W', to: 'N' });
  assert.match(stageTone(3, 9), /^#[0-9a-f]{6}$/);
});

test('streets: long cross-block edges get checkpoints and ports, and runs sharing a street get different lanes', () => {
  const macro = { GC: 3, GR: 2, colOff: [0, 2, 4], colW: [2, 2, 2], rowOff: [0, 2], rowH: [2, 2], gridCols: 6, gridRows: 4 };
  const pos = { a: [0, 0], b: [5, 0], c: [0, 1], d: [5, 1] }, stageOf = { a: 'x', c: 'x', b: 'z', d: 'z' };
  const blockOf = { x: { gc: 0, gr: 0 }, z: { gc: 2, gr: 0 } }, extents = { x: { col0: 0, row0: 0, w: 2, h: 2 }, z: { col0: 4, row0: 0, w: 2, h: 2 } };
  const edges = [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'c', to: 'd' }];
  const r = planStreets({ pos, stageOf, blockOf, extents, macro, edges, opts: { seed: 1, saIters: 800 } });
  assert.equal(Object.keys(r.via).length, 2); assert.ok(r.ports.e1.from && r.ports.e1.to);
  assert.ok(r.via.e1.every(p => p.length === 4));
  const street = id => r.via[id].filter(p => Math.abs(p[1] - 1.5) < 0.01).map(p => p[3]);
  assert.ok(street('e1').length && street('e2').length, 'both ride the street under the block row');
  assert.ok(new Set([...street('e1'), ...street('e2')]).size >= 2, 'different lanes: ' + street('e1') + ' / ' + street('e2'));
  // outer margins are for the very longest routes only
  const plain = planStreets({ pos, stageOf, blockOf, extents, macro, edges, opts: { seed: 1, saIters: 0, margins: () => false } });
  assert.ok(Object.values(plain.via).flat().every(p => p[0] > -0.5 && p[0] < 5.5 && p[1] > -0.5 && p[1] < 3.5), 'no margin checkpoints without the outer-route flag');
});

test('placeWhole: the toy system, every box once, one group per stage, hard metrics 0, deterministic', async () => {
  const a = await placeWhole(toy, null, { seed: 1, budgetMs: 8000 }), b = await placeWhole(toy, null, { seed: 1, budgetMs: 8000 });
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same seed, same config');
  assert.deepEqual(cellsOf(a).sort(), toy.boxes.map(x => x.id).sort());
  assert.deepEqual(a.groups.map(g => g.id).sort(), toy.stages.map(s => s.id).sort());
  const g = { id: 'whole', nodes: toy.boxes, edges: toy.routes.map(r => ({ ...r, label: r.when })), text: {} };
  const { m } = await routeAndMeasure(g, a);
  assert.deepEqual(hardOf(m), {});
  assert.ok(a.__stats.totalMs > 0 && a.__stats.boxes === 35);
  const pos = {}; a.map.forEach((row, r) => row.trim().split(/\s+/).forEach((t, c) => { pos[t] = [c, r]; }));
  const mid = g => { const p = g.nodes.map(n => pos[n]); return [p.reduce((x, q) => x + q[0], 0) / p.length, p.reduce((x, q) => x + q[1], 0) / p.length]; };
  const ms = a.groups.map(mid);
  for (let k = 0; k + 1 < ms.length; k++) assert.ok(ms[k + 1][1] >= ms[k][1] - 1, 'stage ' + (k + 2) + ' is not above stage ' + (k + 1) + ' (snake rows go down)');
});

test('placeWhole: 120 boxes in 8 stages routes clean (the 400+ run is FAULTLINE_BIG=1)', async () => {
  const big = process.env.FAULTLINE_BIG === '1', model = big ? makeModel({ stages: 18, perStage: 24, seed: 2 }) : makeModel({ stages: 8, perStage: 15, seed: 5 });
  const t0 = performance.now(), cfg = await placeWhole(model, null, { seed: 1, budgetMs: big ? 120000 : 15000 }), ms = performance.now() - t0;
  assert.equal(cellsOf(cfg).length, model.boxes.length);
  const g = { id: 'whole', nodes: model.boxes, edges: model.routes.map(r => ({ ...r, label: r.when })), text: {} };
  const { m } = await routeAndMeasure(g, cfg);
  assert.deepEqual(hardOf(m), {});
  console.log(`# placeWhole ${model.boxes.length} boxes ${model.routes.length} routes ${model.stages.length} stages: ${Math.round(ms / 1000)} s, crossings ${m.crossings}, aspect ${m.aspect}`);
  if (big) assert.ok(model.boxes.length >= 400);
});
