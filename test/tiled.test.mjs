// Tiled whole-map tests: node --test test/tiled.test.mjs   (the toy system's stage charts are placed once, split small so there are many parts)
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chartsFromModel } from '../src/build/charts.mjs';
import { placeChart, composeTiled, useTiled, TILED_ABOVE } from '../src/place/index.mjs';
import { snakeRows, planBlock, loadTiles } from '../src/place/tiles.mjs';
import { buildFrame } from '../src/place/frame.mjs';
import { makeCorridors, makeNet } from '../src/place/corridors.mjs';
import { gridLayout, metrics } from '../src/engine/index.mjs';
import { renderSVG } from '../src/engine/render.mjs';
import { HARD } from '../src/build/layout.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const model = (() => {
  const dir = path.join(here, '..', 'examples', 'toy', '.faultline', 'model'), m = { stages: [], boxes: [], routes: [], paths: [] };
  for (const f of fs.readdirSync(dir).sort()) { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); for (const k of Object.keys(m)) if (Array.isArray(j[k])) m[k].push(...j[k]); if (j.system) m.system = j.system; }
  return m;
})();
const charts = chartsFromModel(model, { maxBoxes: 4 });
const geoms = {};
for (const c of charts.filter(c => c.kind === 'stage')) {
  const cfg = await placeChart({ id: c.id, title: c.title, nodes: c.boxes, edges: c.routes }, { seed: 1, budgetMs: 1200 });
  geoms[c.id] = await gridLayout({ id: c.id, title: c.title, nodes: c.boxes.map(b => ({ id: b.id, title: b.title, kind: b.kind || 'step', family: b.stage || '' })), edges: c.routes.map(r => ({ id: r.id, from: r.from, to: r.to, type: r.type || 'forward', label: r.when || '' })) }, cfg);
}
const run = () => composeTiled(model, charts, geoms, {});
const first = run();
const whole = charts.find(c => c.kind === 'whole');
const stageCharts = charts.filter(c => c.kind === 'stage');

test('tiled: hard metrics 0, aspect in the bar, no clock or random in the output', () => {
  const m = metrics(first.geom);
  for (const k of HARD) assert.equal(m[k], 0, `${k} = ${m[k]}: ${m.issues.slice(0, 4).join('; ')}`);
  assert.ok(m.aspect >= 1.3 && m.aspect <= 2.2, `aspect ${m.aspect}`);
});

test('tiled: the same inputs give the same bytes', () => {
  assert.equal(JSON.stringify(run().geom), JSON.stringify(first.geom));
});

test('tiled: every route of the chart appears exactly once; internal points are the tile\'s own, translated', () => {
  const ids = first.geom.edges.map(e => e.id).sort(), want = whole.routes.map(r => r.id).sort();
  assert.deepEqual(ids, want);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(first.geom.nodes.length, whole.boxes.length);
  const byId = new Map(first.geom.edges.map(e => [e.id, e])), nodeById = new Map(first.geom.nodes.map(n => [n.id, n]));
  let internal = 0, cross = 0;
  for (const c of stageCharts) {
    const g = geoms[c.id], n0 = g.nodes[0], dx = nodeById.get(n0.id).x - n0.x, dy = nodeById.get(n0.id).y - n0.y;
    for (const n of g.nodes) { const o = nodeById.get(n.id); assert.equal(o.x - n.x, dx); assert.equal(o.y - n.y, dy); assert.equal(o.w, n.w); }
    for (const e of g.edges) {
      const o = byId.get(e.id); internal++;
      assert.ok(!o.cross, 'internal route marked cross');
      assert.deepEqual(o.pts, e.pts.map(p => [p[0] + dx, p[1] + dy]));
      if (e.labelBox) assert.deepEqual(o.labelBox, { ...e.labelBox, x: e.labelBox.x + dx, y: e.labelBox.y + dy });
    }
  }
  for (const e of first.geom.edges) if (e.cross) {
    cross++;
    assert.ok(e.pts.length >= 2 && !e.labelBox, 'a cross route keeps its condition as focusLabel, not labelBox');
    if (e.label) assert.ok(e.focusLabel && e.focusLabel.w > 0);
  }
  assert.equal(internal + cross, want.length);
  assert.ok(cross > 0 && internal > 0);
});

test('tiled: story order is a snake, stage 1 top-left, halos tile the canvas width, nothing displaced', () => {
  const cl = first.geom.clusters, order = model.stages.map(s => s.id);
  assert.deepEqual(cl.map(c => c.id), order);
  const rows = [];
  for (const c of cl) { let r = rows.find(r => Math.abs(r.y - c.y) < 1); if (!r) rows.push(r = { y: c.y, cs: [] }); r.cs.push(c); }
  rows.sort((a, b) => a.y - b.y);
  assert.equal(rows[0].cs.length > 0 && cl[0].y, rows[0].y, 'stage 1 is in the top row');
  rows.forEach((r, i) => { r.cs.sort((a, b) => a.x - b.x); if (i % 2) r.cs.reverse(); });
  assert.deepEqual(rows.flatMap(r => r.cs).map(c => c.id), order, 'reading the rows as a snake gives the story order');
  assert.equal(Math.min(...rows[0].cs.map(c => c.x)) < first.geom.width / 4, true);
  for (const r of rows) { const xs = r.cs.map(c => c.x + c.w); assert.ok(Math.max(...xs) <= first.geom.width); }
  for (const c of cl) assert.ok(c.title && c.titleBand > 0);
});

test('tiled: a row is justified to the canvas width', () => {
  const blocks = loadTiles(model, charts, geoms).stages.map(s => planBlock(s)), sn = snakeRows(blocks, []);
  const f = buildFrame({ blocks, rows: sn.rows }, {}), g = buildFrame({ blocks, rows: sn.rows }, {}, f.W);
  for (const row of g.vs) assert.ok(Math.abs(row[row.length - 1].x1 - f.W) < 1e-6);
  assert.equal(g.W, f.W);
});

test('tiled: corridors meet only where each covers the other\'s band', () => {
  const L = loadTiles(model, charts, geoms), blocks = L.stages.map(s => planBlock(s)), sn = snakeRows(blocks, []), plan = { blocks, rows: sn.rows };
  const fr = buildFrame(plan, {}, buildFrame(plan, {}).W), list = makeCorridors(fr, plan, L.tiles), net = makeNet(list);
  assert.ok(net.verts.length > 0);
  for (const t of net.verts) { const v = list[t.v], h = list[t.h]; assert.equal(v.axis, 'v'); assert.equal(h.axis, 'h'); assert.ok(v.e0 <= h.b0 + 1e-6 && v.e1 >= h.b1 - 1e-6 && h.e0 <= v.b0 + 1e-6 && h.e1 >= v.b1 - 1e-6); }
});

test('tiled: tiles never overlap and no route runs along another (the engine metrics, run on the composition)', () => {
  const m = metrics(first.geom);
  assert.equal(m.nodeOverlaps, 0); assert.equal(m.trackOverlaps, 0); assert.equal(m.edgeThroughNode, 0);
});

test('metrics: the grid-accelerated pair search gives the numbers of the plain O(E^2) loops', () => {
  const g = first.geom, m = metrics(g);
  const segsOf = pts => { const s = []; for (let i = 0; i < pts.length - 1; i++) s.push([pts[i], pts[i + 1]]); return s; };
  const isH = ([a, b]) => Math.abs(a[1] - b[1]) < 0.5, isV = ([a, b]) => Math.abs(a[0] - b[0]) < 0.5;
  const S = g.edges.map(e => segsOf(e.pts));
  let cr = 0, tr = 0;
  for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) for (const a of S[i]) for (const b of S[j]) {
    if (isH(a) && isV(b) || isV(a) && isH(b)) {
      const h = isH(a) ? a : b, v = isH(a) ? b : a, hx0 = Math.min(h[0][0], h[1][0]), hx1 = Math.max(h[0][0], h[1][0]), vy0 = Math.min(v[0][1], v[1][1]), vy1 = Math.max(v[0][1], v[1][1]);
      if (v[0][0] > hx0 + 0.5 && v[0][0] < hx1 - 0.5 && h[0][1] > vy0 + 0.5 && h[0][1] < vy1 - 0.5) cr++;
    } else if (isH(a) && isH(b) && Math.abs(a[0][1] - b[0][1]) < 3) { if (Math.min(Math.max(a[0][0], a[1][0]), Math.max(b[0][0], b[1][0])) - Math.max(Math.min(a[0][0], a[1][0]), Math.min(b[0][0], b[1][0])) > 6) tr++; }
    else if (isV(a) && isV(b) && Math.abs(a[0][0] - b[0][0]) < 3) { if (Math.min(Math.max(a[0][1], a[1][1]), Math.max(b[0][1], b[1][1])) - Math.max(Math.min(a[0][1], a[1][1]), Math.min(b[0][1], b[1][1])) > 6) tr++; }
  }
  assert.equal(m.crossings, cr); assert.equal(m.trackOverlaps, tr);
});

test('render: data-cross on cross routes, hops:false draws no hop arcs', () => {
  const svg = renderSVG(first.geom, { hops: false, handles: false });
  assert.ok(/data-cross="1"/.test(svg));
  assert.ok(!/ A5 5 /.test(svg));
  const nCross = first.geom.edges.filter(e => e.cross).length;
  assert.equal((svg.match(/data-cross="1"/g) || []).length, nCross);
});

test('tiled: the classic placeWhole stays for charts at or under TILED_ABOVE', () => {
  assert.equal(useTiled({ boxes: new Array(TILED_ABOVE.boxes), routes: [] }), false);
  assert.equal(useTiled({ boxes: new Array(10), routes: new Array(TILED_ABOVE.routes) }), false);
  assert.equal(useTiled({ boxes: new Array(TILED_ABOVE.boxes + 1), routes: [] }), true);
  assert.equal(useTiled({ boxes: [], routes: new Array(TILED_ABOVE.routes + 1) }), true);
});
