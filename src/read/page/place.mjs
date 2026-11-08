// node place.mjs <project dir> [--fast-max N] [--anneal-budget S] [--only id,id] [--shard i/n] [--force]
// Places the charts of a reading-layer project.
//   overview            the stage poster: Faultline's own placer, a few seconds
//   charts <= N boxes   a layered map (columns by depth, rows by the order of the parents), no search; then Faultline's router and metrics
//   charts > N boxes    Faultline's placer (annealing) with a small time budget
//   any layered chart that leaves a hard defect, or has more than --cross-max crossings, is handed to the placer
// Output: layout/<id>.json (+ .geom.json cache) in the project, and a summary line per run.
import { loadModelReport } from '../../model/index.mjs';
import { chartsFromModel } from '../../build/charts.mjs';
import * as LY from '../../build/layout.mjs';
import { writeJson, readJson } from '../../build/project.mjs';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const dir = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
if (!dir) { console.error('usage: place.mjs <project dir> [options]'); process.exit(2); }
const FAST_MAX = +opt('--fast-max', 21), CROSS_MAX = +opt('--cross-max', 3), BUDGET = +opt('--anneal-budget', 4), FORCE = args.includes('--force');
const ONLY = opt('--only', '') ? opt('--only', '').split(',') : null;
const t00 = Date.now();
const { model, refusals } = loadModelReport(dir);
if (refusals.length) { console.error('model refused', refusals.slice(0, 3)); process.exit(2); }
const charts = chartsFromModel(model);
const flows = charts.filter((c) => c.kind === 'detail');
const ov = charts.find((c) => c.kind === 'overview');
const log = (m) => console.log(m);

// ---- the fast layered map ---------------------------------------------------------------------------------------------
function layerMap(chart) {
  const ids = chart.boxes.map((b) => b.id), at = new Map(ids.map((id, i) => [id, i]));
  const out = new Map(ids.map((id) => [id, []])), inn = new Map(ids.map((id) => [id, []]));
  for (const r of chart.routes) {
    if (r.type === 'return' || !at.has(r.from) || !at.has(r.to) || r.from === r.to) continue;
    out.get(r.from).push(r.to); inn.get(r.to).push(r.from);
  }
  // depth by longest path, ignoring back roads: a DFS marks the back edges, then relax in topological order
  const color = new Map(), back = new Set();
  const first = chart.boxes.find((b) => b.handle) ; const roots = [first && first.id, ...ids.filter((id) => !inn.get(id).length)].filter(Boolean);
  const dfs = (v) => { color.set(v, 1); for (const w of out.get(v)) { if (color.get(w) === 1) back.add(v + '>' + w); else if (!color.get(w)) dfs(w); } color.set(v, 2); };
  for (const r of roots) if (!color.get(r)) dfs(r);
  for (const id of ids) if (!color.get(id)) dfs(id);
  const succ = (v) => out.get(v).filter((w) => !back.has(v + '>' + w));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const v of ids) for (const w of succ(v)) indeg.set(w, indeg.get(w) + 1);
  const depth = new Map(ids.map((id) => [id, 0])), q = ids.filter((id) => !indeg.get(id)), topo = [];
  while (q.length) { const v = q.shift(); topo.push(v); for (const w of succ(v)) { depth.set(w, Math.max(depth.get(w), depth.get(v) + 1)); indeg.set(w, indeg.get(w) - 1); if (!indeg.get(w)) q.push(w); } }
  // cards, stubs and open boxes (no road in from inside, or leaves of a decision) sit one column after their parent: already so by depth
  const cols = new Map();
  for (const id of ids) { const d = depth.get(id); if (!cols.has(d)) cols.set(d, []); cols.get(d).push(id); }
  const nCol = Math.max(...cols.keys()) + 1;
  // rows: order each column by the mean row of its parents (two sweeps), first sweep seeded by reading order
  const row = new Map();
  const order = (d, key) => cols.get(d).sort((a, b) => key(a) - key(b) || at.get(a) - at.get(b));
  cols.get(0) && order(0, (id) => at.get(id));
  for (const d of [...cols.keys()].sort((a, b) => a - b)) { cols.get(d).forEach((id, i) => row.set(id, i)); }
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const d of [...cols.keys()].sort((a, b) => a - b)) {
      if (!d) continue;
      const key = (id) => { const ps = inn.get(id).filter((p) => depth.get(p) < d && !back.has(p + '>' + id)); return ps.length ? ps.reduce((s, p) => s + row.get(p), 0) / ps.length : row.get(id); };
      order(d, key).forEach((id, i) => row.set(id, i));
    }
  }
  const nRow = Math.max(...[...cols.values()].map((c) => c.length));
  // orientation: columns left to right, or the same map turned (rows top to bottom), whichever is nearer a 1.6 : 1 picture (a column is about 270 px wide, a row about 125 px high)
  const wide = nCol * 270, high = nRow * 125, turned = nRow * 270 * 1.0, turnedH = nCol * 125;
  const score = (w, h) => Math.abs(Math.log(w / h) - Math.log(1.6));
  const useTurn = score(turned, turnedH) < score(wide, high);
  const grid = [];
  if (!useTurn) { for (let r = 0; r < nRow; r++) { grid.push([...Array(nCol)].map((_, c) => (cols.get(c) && cols.get(c)[r]) || '.')); } }
  else { for (let c = 0; c < nCol; c++) { grid.push([...Array(nRow)].map((_, r) => (cols.get(c) && cols.get(c)[r]) || '.')); } }
  return { map: grid.map((g) => g.join(' ')), turned: useTurn, cols: nCol, rows: nRow };
}

function fastCfg(chart) {
  const { map } = layerMap(chart);
  const spine = chart.spine && chart.spine.length ? chart.spine : [];
  return { gapX: 150, gapY: 84, nodeMaxChars: 22, edgeMaxChars: 20, ...(spine.length > 1 ? { spine } : {}), route: { crossingPenalty: 200 }, map, colGap: {}, rowGap: {} };
}

const results = [];
const SHARD = opt('--shard', ''), [shI, shN] = SHARD ? SHARD.split('/').map(Number) : [0, 1];
const want = flows.filter((c) => !ONLY || ONLY.includes(c.id)).filter((c, k) => k % shN === shI);   // --shard i/n: this process places every n-th chart (the charts are independent)
// 1. fast layouts for small flows
let t0 = Date.now(), nFast = 0;
for (const c of want) {
  if (c.boxes.length > FAST_MAX) continue;
  const file = LY.layoutPath(dir, c.id), cur = readJson(file), key = LY.shapeKey(c, model);
  if (cur && cur._faultline && cur._faultline.key === key && !FORCE) continue;
  writeJson(file, { _faultline: { tool: 'place2-fast', key, seed: 0, boxes: c.boxes.length }, ...fastCfg(c) });
  nFast++;
}
const tWrite = Date.now() - t0;
log(`fast maps written: ${nFast} (${tWrite} ms)`);
// 2. geometry for them (router + metrics) -- loadLayouts builds and caches it
t0 = Date.now();
const small = want.filter((c) => c.boxes.length <= FAST_MAX);
const per = [];
let L = { geoms: {}, metrics: {}, stale: [], missing: [] };
for (const c of small) {
  const t1 = Date.now();
  const r = await LY.loadLayouts(dir, model, [c]);
  per.push([c.id, c.boxes.length, Date.now() - t1]);
  Object.assign(L.geoms, r.geoms); Object.assign(L.metrics, r.metrics); L.stale.push(...r.stale); L.missing.push(...r.missing);
}
const tGeom = Date.now() - t0;
const hardIds = small.filter((c) => L.metrics[c.id] && LY.HARD.some((k) => L.metrics[c.id][k] > 0)).map((c) => c.id);
const tangled = small.filter((c) => L.metrics[c.id] && !hardIds.includes(c.id) && L.metrics[c.id].crossings > CROSS_MAX).map((c) => c.id);   // a fast layout with more than CROSS_MAX crossings is handed to the placer too
const unrouted = small.filter((c) => !L.geoms[c.id]).map((c) => c.id);
log(`fast geometry: ${small.length} charts in ${tGeom} ms (mean ${(tGeom / Math.max(1, small.length)).toFixed(0)} ms); hard defects on ${hardIds.length}; more than ${CROSS_MAX} crossings on ${tangled.length}; not routed ${unrouted.length}`);
// 3. the placer (annealing) for the big ones and for fast layouts that left a defect
const rest = want.filter((c) => c.boxes.length > FAST_MAX).map((c) => c.id).concat(hardIds, tangled, unrouted);
const placed = [];
t0 = Date.now();
for (const id of rest) {
  const c = charts.find((x) => x.id === id), t1 = Date.now();
  const rec = await LY.placeProject(dir, model, charts, { only: [id], force: true, budgetSeconds: BUDGET, log: () => {} });
  placed.push({ id, boxes: c.boxes.length, ms: Date.now() - t1, hard: rec[0] && rec[0].hard, action: rec[0] && rec[0].action, capped: rec[0] && rec[0].capped });
}
const tAnneal = Date.now() - t0;
log(`annealed: ${placed.length} charts in ${tAnneal} ms; hard defects left on ${placed.filter((p) => p.hard && p.hard.length).length}`);
// 4. the overview poster
let ovRec = null;
if (ov && (!ONLY || ONLY.includes(ov.id)) && !SHARD) {
  t0 = Date.now();
  const rec = await LY.placeProject(dir, model, charts, { only: [ov.id], force: FORCE, budgetSeconds: +opt('--ov-budget', 2), log });
  ovRec = { id: ov.id, boxes: ov.boxes.length, routes: ov.routes.length, ms: Date.now() - t0, hard: rec[0] && rec[0].hard, action: rec[0] && rec[0].action, summary: rec[0] && rec[0].summary };
  log(`overview: ${ov.boxes.length} boxes, ${ov.routes.length} roads placed in ${ovRec.ms} ms: ${ovRec.summary}`);
}
const finalL = await LY.loadLayouts(dir, model, charts.filter((c) => c.kind !== 'whole' && c.kind !== 'stage'));
const hardFinal = Object.entries(finalL.metrics).filter(([, m]) => LY.HARD.some((k) => m[k] > 0)).map(([id]) => id);
const summary = { flows: flows.length, fast: small.length, fast_ms: tGeom, fast_hard: hardIds.length, fast_tangled: tangled.length, annealed: placed.length, anneal_ms: tAnneal, overview: ovRec, hard_final: hardFinal.length, missing_final: finalL.missing.length, stale_final: finalL.stale.length, total_ms: Date.now() - t00 };
log(JSON.stringify(summary));
fs.writeFileSync(path.join(dir, SHARD ? `place2.shard${shI}.log.json` : 'place2.log.json'), JSON.stringify({ summary, per, placed, hardIds, hardFinal }, null, 1));
