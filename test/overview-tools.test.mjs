// Overview road cap, the clock ceiling in placeChart, status honesty, path along declared paths, impact on a big map, and the small warnings.
//   node --test test/overview-tools.test.mjs
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chartsFromModel, capOverviewRoads, toAtlasData } from '../src/build/index.mjs';
import { agentData } from '../src/agent/index.mjs';
import * as C from '../src/agent/commands.mjs';
import { pageInfo, pageInputs } from '../src/build/pipeline.mjs';
import { validateModel, loadModelReport } from '../src/model/index.mjs';
import { HEDGE } from '../src/model/text.mjs';
import { readProject } from '../src/build/project.mjs';
import { placeChart } from '../src/place/index.mjs';
import { loadEngine, hardOf } from '../src/place/engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOY = path.join(here, '..', 'examples', 'toy', '.faultline');
const tok = (s) => Math.ceil(s.length / 4);

// a system of `n` stages of 3 boxes each; stage i hands to every later stage (so n(n-1)/2 stage pairs), one main path through all of them
function wide(n) {
  const m = { schema: 'faultline.model/1', system: { name: 'Wide', summary: 'A wide system.' }, stages: [], boxes: [], routes: [], paths: [{ id: 'main', title: 'Main', boxes: [] }], loops: [], terms: [], ledger: {}, modules: {} };
  for (let s = 0; s < n; s++) {
    m.stages.push({ id: `s${s}`, title: `Stage ${s}`, order: s + 1 });
    for (let k = 0; k < 3; k++) { m.boxes.push({ id: `b${s}_${k}`, stage: `s${s}`, kind: 'step', status: 'live', title: `Box ${s}.${k}`, plain: 'x', refs: [{ path: 'a.py', symbol: 'a.py::f' }] }); }
    for (let k = 0; k < 2; k++) m.routes.push({ id: `in${s}_${k}`, from: `b${s}_${k}`, to: `b${s}_${k + 1}`, type: 'forward', when: k ? 'Then' : 'First' });
    m.paths[0].boxes.push(`b${s}_0`);
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let r = 0; r < 1 + ((i * 7 + j) % 4); r++) m.routes.push({ id: `x${i}_${j}_${r}`, from: `b${i}_2`, to: `b${j}_0`, type: 'forward', when: `Case ${r}` });
  return m;
}

test('overview: a wide system draws at most ceil(2.2 x boxes) roads, main path first, and says how many are not drawn', () => {
  const m = wide(12), ov = chartsFromModel(m)[0];
  assert.equal(ov.kind, 'overview');
  const cap = Math.ceil(2.2 * ov.boxes.length), pairs = 12 * 11 / 2;
  assert.equal(ov.routes.length, cap, 'draws exactly the cap when more pairs exist');
  assert.equal(ov.routes.length + ov.notDrawn.length, pairs, 'every pair is drawn or listed');
  for (let i = 0; i < 11; i++) assert.ok(ov.routes.some((r) => r.id === `o:s${i}>s${i + 1}`), `main path pair s${i}>s${i + 1} is drawn`);
  for (const b of ov.boxes) {
    const outs = [...ov.routes.filter((r) => r.from === b.id), ...ov.notDrawn.filter((r) => r.from === b.id)];
    if (outs.length) assert.ok(ov.routes.some((r) => r.from === b.id), `${b.id} keeps a road out`);
    const ins = [...ov.routes.filter((r) => r.to === b.id), ...ov.notDrawn.filter((r) => r.to === b.id)];
    if (ins.length) assert.ok(ov.routes.some((r) => r.to === b.id), `${b.id} keeps a road in`);
  }
  assert.ok(ov.routes.every((r) => /^o:[^>]+>[^>]+$/.test(r.id)), 'ids stay o:a>b');
  assert.ok(ov.notDrawn.every((r) => r.id && r.from && r.to && r.count >= 1 && typeof r.when === 'string'));
  assert.deepEqual(ov.notDrawn.map((r) => r.count), ov.notDrawn.map((r) => r.count).sort((a, b) => b - a), 'busiest not-drawn road first');
  assert.match(ov.summary, new RegExp(`Shows ${cap} of ${pairs} stage-to-stage roads`));
  assert.match(ov.summary, new RegExp(`${ov.notDrawn.length} not drawn here`));
  assert.deepEqual(chartsFromModel(m)[0].routes.map((r) => r.id), ov.routes.map((r) => r.id), 'deterministic');
  const d = toAtlasData(m, { charts: chartsFromModel(m) });
  assert.equal(d.charts.overview.notDrawn.length, ov.notDrawn.length, 'the page data carries chart.notDrawn');
  assert.equal(d.charts.whole.notDrawn, undefined);
});

test('overview: past the cap the strongest road in and out of a box beats a busier road elsewhere; below the cap nothing is dropped', () => {
  const boxes = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const road = (from, to, n) => ({ id: `o:${from}>${to}`, from, to, via: Array.from({ length: n }, (_, i) => `r${i}`) });
  const roads = [road('a', 'b', 1), road('b', 'c', 1), road('c', 'd', 1), road('a', 'c', 9), road('a', 'd', 8), road('b', 'd', 7), road('d', 'a', 2), road('c', 'a', 6), road('b', 'a', 5), road('d', 'b', 3)];
  const r = capOverviewRoads(boxes, roads, ['a', 'b', 'c', 'd'], 1.5);                 // cap 6
  assert.equal(r.cap, 6);
  assert.equal(r.drawn.length, 6);
  for (const id of ['o:a>b', 'o:b>c', 'o:c>d']) assert.ok(r.drawn.some((x) => x.id === id), id + ' is on the main path');
  assert.deepEqual(r.drawn.map((x) => x.id).sort(), ['o:a>b', 'o:a>c', 'o:a>d', 'o:b>c', 'o:b>d', 'o:c>d'], 'main path, then the strongest roads in and out by routes carried, cut at the cap');
  assert.ok(r.notDrawn.every((x) => ['o:c>a', 'o:b>a', 'o:d>b', 'o:d>a'].includes(x.id)));
  const wide6 = capOverviewRoads(boxes, roads, ['a', 'b', 'c', 'd'], 2.5);                    // cap 10: every road fits
  assert.equal(wide6.notDrawn.length, 0);
  const tight = capOverviewRoads(boxes, roads, ['a', 'b', 'c', 'd'], 2);                       // cap 8: the two strongest left over are d>b (3) and d>a (2)... after c>a, b>a
  assert.ok(tight.drawn.some((x) => x.id === 'o:d>b'), 'd keeps its strongest road out once the cap allows it');
  assert.equal(capOverviewRoads(boxes, roads.slice(0, 3), ['a', 'b', 'c', 'd']).notDrawn.length, 0);
  assert.equal(chartsFromModel(wide(3))[0].summary.includes('not drawn here'), false);
});

test('placeChart: every router pass checks the clock; a capped run returns its best so far and says so', async () => {
  const dir = path.join(TOY, 'model'), m = { stages: [], boxes: [], routes: [] };
  for (const f of fs.readdirSync(dir).sort()) { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); for (const k of Object.keys(m)) if (Array.isArray(j[k])) m[k].push(...j[k]); }
  const ids = new Set(m.boxes.filter((b) => b.stage === 's_intake').map((b) => b.id));
  const chart = { id: 's_intake', nodes: m.boxes.filter((b) => ids.has(b.id)), edges: m.routes.filter((r) => ids.has(r.from) && ids.has(r.to)) };
  const E = await loadEngine();
  const free = await placeChart(chart, { budgetMs: 3000 }), again = await placeChart(chart, { budgetMs: 3000 });
  assert.equal(free.__stats.capped, false);
  assert.deepEqual(JSON.parse(JSON.stringify(free)), JSON.parse(JSON.stringify(again)), 'not capped: same bytes');
  for (const capFactor of [0.0001, 0.06]) {
    const t = Date.now(), cfg = await placeChart(chart, { budgetMs: 3000, capFactor });
    assert.equal(cfg.__stats.capped, true, `capFactor ${capFactor}`);
    assert.ok(Date.now() - t < 2500, 'the ceiling stops the work early');
    const cells = cfg.map.flatMap((r) => r.trim().split(/\s+/)).filter((t2) => t2 !== '.');
    assert.deepEqual([...cells].sort(), [...chart.nodes.map((n) => n.id)].sort(), 'every box placed once');
    const geom = await E.gridLayout({ id: chart.id, nodes: chart.nodes, edges: chart.edges, text: {} }, cfg);
    assert.deepEqual(hardOf(E.metrics(geom)), {}, 'still a clean layout on this small chart');
  }
});

// ---------------------------------------------------------------------------------------------------------------- small truths
test('warnings: an end box with a forward road out, a decision with fewer than two exits; prefixed switch names do not warn', () => {
  const rep = loadModelReport(TOY), P = readProject(TOY), model = rep.model;
  const base = validateModel(model, P.facts, P.census, {}).warnings.map((w) => w.code);
  assert.ok(!base.includes('W-end-exit') && !base.includes('W-decision-one-exit'), 'the toy is clean of both');
  const end = model.boxes.find((b) => b.kind === 'end'), other = model.boxes.find((b) => b.kind === 'step');
  const m2 = { ...model, boxes: [...model.boxes, { id: 'zz.decide', stage: other.stage, kind: 'decision', title: 'Decide', plain: 'x', status: 'live', refs: other.refs, switch: 'env:SOME_FLAG' },
    { id: 'zz.bare', stage: other.stage, kind: 'step', title: 'Bare', plain: 'x', status: 'live', refs: other.refs, switch: 'nonsense_name' }],
  routes: [...model.routes, { id: 'zz.out', from: end.id, to: other.id, type: 'forward', when: 'Never' }, { id: 'zz.one', from: 'zz.decide', to: other.id, type: 'forward', when: 'Always' }] };
  const w = validateModel(m2, P.facts, P.census, {}).warnings;
  assert.ok(w.some((x) => x.code === 'W-end-exit' && x.at === end.id), 'end box with a forward road out');
  assert.ok(w.some((x) => x.code === 'W-decision-one-exit' && x.at === 'zz.decide'), 'decision with one exit');
  assert.ok(!w.some((x) => x.code === 'W-switch' && x.at === 'zz.decide'), 'env: names are not in the census by design');
  if ((P.census.switches || []).length) assert.ok(w.some((x) => x.code === 'W-switch' && x.at === 'zz.bare'), 'a bare unknown name still warns');
  for (const pre of ['option:x', 'env:X', 'flag:--x', 'setting:x', 'owner:ops team']) {
    const m3 = { ...m2, boxes: m2.boxes.map((b) => (b.id === 'zz.bare' ? { ...b, switch: pre } : b)) };
    assert.ok(!validateModel(m3, P.facts, P.census, {}).warnings.some((x) => x.code === 'W-switch' && x.at === 'zz.bare'), pre);
  }
  const refused = validateModel(m2, P.facts, P.census, {}).refusals.map((r) => r.code);
  assert.ok(!refused.includes('W-end-exit'), 'warnings, never refusals');
});

test('hedged-route: help and support are nouns, not hedges; real hedges still count', () => {
  assert.equal(HEDGE.test('Shows help text'), false);
  assert.equal(HEDGE.test('Opens a support ticket'), false);
  assert.equal(HEDGE.test('Can retry'), true);
  assert.equal(HEDGE.test('Possibly later'), true);
});

// a tiny system for the agent commands: a -> b -> c -> d on the declared path "main", a shortcut a -> d, a funnel for impact
function agentModel() {
  const box = (id, stage = 's1', kind = 'step') => ({ id, stage, kind, status: 'live', title: `Title ${id}`, plain: '', refs: [{ path: 'a.py', symbol: 'a.py::f', line: 1 }] });
  const m = { schema: 'faultline.model/1', system: { name: 'T' }, stages: [{ id: 's1', title: 'One', order: 1 }, { id: 's2', title: 'Two', order: 2 }],
    boxes: ['a', 'b', 'c', 'd', 'e'].map((id) => box(id)), routes: [], paths: [{ id: 'main', title: 'Main path', boxes: ['a', 'b', 'c', 'd'] }, { id: 'other', title: 'Other', boxes: ['e', 'd'] }], loops: [], terms: [], ledger: {}, modules: {} };
  const r = (id, from, to, type = 'forward') => m.routes.push({ id, from, to, type, when: 'When ' + id });
  r('ab', 'a', 'b'); r('bc', 'b', 'c'); r('cd', 'c', 'd'); r('ad', 'a', 'd'); r('ed', 'e', 'd');
  return m;
}
test('path: both ends on a declared path answer along it (first listed wins); --shortest and off-path ends use the shortest road', () => {
  const d = agentData(agentModel(), {});
  let out = C.path(d, 'a', 'd');
  assert.match(out, /3 hop\(s\)  \(along the declared path main "Main path"\)/);
  assert.match(out, /shorter road of 1 hop/);
  assert.match(C.path(d, 'a', 'd', { shortest: true }), /1 hop\(s\)  \(shortest/);
  assert.match(C.path(d, 'e', 'd'), /along the declared path other/, 'the second path answers when the first does not hold both ends');
  assert.match(C.path(d, 'b', 'a'), /NO ROUTE DRAWN|return/, 'going backwards is not answered along a path');
  assert.match(C.path(d, 'a', 'c'), /2 hop\(s\)  \(along the declared path main/);
});

test('impact: forward roads only, counts by hop, boxes within 2 hops by name, endings within 4, and it says where it stopped at a shared funnel', () => {
  const m = agentModel(), box = (id, kind = 'step', stage = 's1') => ({ ...m.boxes[0], id, kind, stage, title: 'Box ' + id });
  m.boxes = [box('a'), box('hub')]; m.routes = []; m.paths = [{ id: 'main', boxes: ['a'] }];
  const road = (id, from, to, type = 'forward') => m.routes.push({ id, from, to, type, when: 'when ' + id });
  for (let i = 0; i < 13; i++) { m.boxes.push(box('f' + i)); road('rf' + i, i ? 'f' + (i - 1) : 'a', 'f' + i); road('rh' + i, 'f' + i, 'hub'); }
  road('rah', 'a', 'hub');
  for (let i = 0; i < 30; i++) { m.boxes.push(box('t' + i, i % 10 === 9 ? 'end' : 'step', i % 2 ? 's2' : 's1')); road('rt' + i, i ? 't' + (i - 1) : 'hub', 't' + i); }
  m.boxes.push(box('rec')); road('rrec', 'a', 'rec', 'record');
  const d = agentData(m, {}), out = C.impact(d, 'a');
  assert.ok(tok(out) <= 500, `${tok(out)} tokens`);
  assert.match(out, /DOWNSTREAM \d+ box\(es\) by forward roads/);
  assert.match(out, /CUT: the walk stops at 1 shared funnel/);
  assert.match(out, /hub \(\d+ in\)/);
  assert.match(out, /1 HOP \(\d+\)/);
  assert.match(out, /ENDINGS within 4 hops/);
  assert.ok(!/\brec\b/.test(out.split('\n').filter((l) => /^(1|2) HOP/.test(l)).join('\n')), 'record roads are left out of the walk');
  const small = C.impact(agentData(agentModel(), {}), 'a');
  assert.ok(!/CUT:/.test(small) && /1 HOP/.test(small));
});

test('status: FINISHED only when the gates pass and the page is built, current and every chart is placed', () => {
  const gaps = { state: 'finished', items: [], tally: {}, notDrawn: {} };
  const mk = (layout) => agentData(agentModel(), { gaps, layout });
  const page = (o) => ({ built: true, current: true, builtAt: '2026-11-06T10:00:00.000Z', changed: '', recorded: true, ...o });
  const head = (s) => s.split('\n')[0];
  assert.match(head(C.status(mk({ charts: 4, placed: 4, stale: [], hard: 0, page: page() }))), /^STATUS FINISHED/);
  const none = C.status(mk({ charts: 4, placed: 4, stale: [], hard: 0, page: { built: false, current: false } }));
  assert.match(head(none), /GATES PASS, NOT FINISHED/); assert.match(none, /page: NOT BUILT/);
  const old = C.status(mk({ charts: 4, placed: 4, stale: [], hard: 0, page: page({ current: false, changed: 'model/10-x.json changed' }) }));
  assert.match(head(old), /NOT FINISHED/); assert.match(old, /OUT OF DATE \(model\/10-x\.json changed\)/);
  const older = C.status(mk({ charts: 4, placed: 4, stale: [], hard: 0, page: page({ current: false, recorded: false }) }));
  assert.match(head(older), /NOT FINISHED/); assert.match(older, /page: built by an older version, cannot tell if current/); assert.doesNotMatch(older, /OUT OF DATE/);
  const unplaced = C.status(mk({ charts: 4, placed: 2, stale: ['stage_x', 'stage_y'], hard: 0, page: page() }));
  assert.match(head(unplaced), /NOT FINISHED/); assert.match(unplaced, /charts placed: 2\/4, not placed: stage_x,stage_y/);
  for (const s of [none, old, older, unplaced]) assert.ok(tok(s) <= 200, `${tok(s)} tokens`);
  assert.match(head(C.status(agentData(agentModel(), { gaps: { ...gaps, state: 'draft' }, layout: { charts: 4, placed: 4, stale: [], hard: 0, page: page() } }))), /^STATUS DRAFT/);
});

test('pageInfo: judged by content, not by file time: a touched file is current, a changed, added or removed one is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-page-'));
  fs.mkdirSync(path.join(dir, 'dist')); fs.mkdirSync(path.join(dir, 'model')); fs.mkdirSync(path.join(dir, 'layout'));
  assert.equal(pageInfo(dir).built, false);
  const w = (f, text) => fs.writeFileSync(path.join(dir, f), text);
  const record = () => w('dist/atlas.agent.json', JSON.stringify({ layout: { page: { inputs: pageInputs(dir) } } }));
  w('model/00-system.json', '{"a":1}\n'); w('layout/overview.json', '{"x":1}\n'); w('dist/atlas.html', '<html></html>');
  assert.deepEqual([pageInfo(dir).built, pageInfo(dir).current, pageInfo(dir).recorded], [true, false, false], 'a page with no record of its inputs cannot be called current');
  record();
  assert.deepEqual([pageInfo(dir).built, pageInfo(dir).current, pageInfo(dir).recorded], [true, true, true]);
  const later = new Date(Date.now() + 3600 * 1000);                            // a fresh checkout or a copy changes every file time: nothing changed
  for (const f of ['model/00-system.json', 'layout/overview.json']) fs.utimesSync(path.join(dir, f), later, later);
  assert.equal(pageInfo(dir).current, true, 'a newer file time alone is not a change');
  w('model/00-system.json', '{"a":1}\r\n');
  assert.equal(pageInfo(dir).current, true, 'line endings are not content');
  w('model/00-system.json', '{"a":2}\n');
  assert.equal(pageInfo(dir).current, false); assert.equal(pageInfo(dir).changed, 'model/00-system.json changed');
  record(); assert.equal(pageInfo(dir).current, true);
  w('layout/stage_a.json', '{}\n');
  assert.equal(pageInfo(dir).changed, 'layout/stage_a.json was added');
  record(); fs.unlinkSync(path.join(dir, 'layout', 'stage_a.json'));
  assert.equal(pageInfo(dir).changed, 'layout/stage_a.json was removed');
  w('layout/stage_a.geom.json', '{}\n'); record(); w('layout/stage_a.geom.json', '{"cache":2}\n');
  assert.equal(pageInfo(dir).current, true, 'a geometry cache is not an input');
  fs.rmSync(dir, { recursive: true, force: true });
});
