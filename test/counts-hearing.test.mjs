// Counts and who hears, the parts that need no browser: the one table of counts, who hears about an ending, part notes, the overview's main path,
// the weighted route and the agent commands. (The page itself is checked in test/viewer.verify.mjs, section counts.)
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { chartsFromModel, capOverviewRoads, toAtlasData } from '../src/build/index.mjs';
import { countsOf, endingModes, workedOutLoops } from '../src/build/counts.mjs';
import { breaksOf } from '../src/build/atlasdata.mjs';
import { shapeKey } from '../src/build/layout.mjs';
import { weightedRoute, shortestRoute } from '../src/build/util.mjs';
import { heardMap, heardIssues, silentBox } from '../src/model/heard.mjs';
import { validateModel } from '../src/model/index.mjs';
import { agentData } from '../src/agent/index.mjs';
import * as C from '../src/agent/commands.mjs';

// a small system: two stages; a main path that comes back to a box (a call returns); endings that stop and one that hands back
function system() {
  const b = (id, stage, kind, extra = {}) => ({ id, stage, kind, title: id, plain: `${id} does its part.`, status: 'live', refs: [{ path: 'a.py', symbol: 'a.py::f', line: 1 }], ...extra });
  const boxes = [
    b('in.start', 's1', 'step'), b('in.check', 's1', 'decision'), b('in.work', 's1', 'step'), b('in.reject', 's1', 'end', { outcome: 'refusal' }),
    b('w.claim', 's2', 'step'), b('w.run', 's2', 'step'), b('w.fail', 's2', 'end', { outcome: 'failure' }), b('w.ok', 's2', 'end', { outcome: 'success' }), b('w.back', 's2', 'end', { outcome: 'neutral' }),
    b('w.log', 's2', 'step', { outcome: 'failure' }), b('x.side', 's1', 'step'),
  ];
  const r = (id, from, to, type = 'forward', when = 'ok') => ({ id, from, to, type, when });
  const routes = [r('r1', 'in.start', 'in.check'), r('r2', 'in.check', 'in.work', 'forward', 'valid'), r('r3', 'in.check', 'in.reject', 'forward', 'invalid'), r('r4', 'in.work', 'w.claim'),
    r('r5', 'w.claim', 'w.run'), r('r6', 'w.run', 'w.fail', 'forward', 'throws'), r('r7', 'w.run', 'w.back', 'forward', 'nested'), r('r8', 'w.back', 'w.run', 'return', 'caller continues'),
    r('r9', 'w.run', 'w.ok', 'forward', 'done'), r('r10', 'w.run', 'w.claim', 'return', 'retry'), r('r11', 'in.work', 'x.side', 'forward', 'also'), r('r12', 'x.side', 'w.claim', 'forward', 'then')];
  return { schema: 'faultline.model/1', system: { name: 'Toy' }, stages: [{ id: 's1', title: 'In', order: 1 }, { id: 's2', title: 'Work', order: 2 }], boxes, routes,
    loops: [{ id: 'l_retry', title: 'Retry', boxes: ['w.claim', 'w.run'], limit: '' }], paths: [{ id: 'main', title: 'Main path', boxes: ['in.start', 'in.check', 'in.work', 'w.claim', 'w.run', 'w.back', 'w.run', 'w.ok'] }, { id: 'slice', title: 'A slice', boxes: ['in.start', 'in.check', 'in.reject'] }],
    charts: [], terms: [], ledger: {}, modules: {} };
}

test('endingModes: an end box with a road out hands back to its caller, one with none stops here', () => {
  const m = system(), modes = endingModes(m);
  assert.equal(modes.get('in.reject'), 'stop'); assert.equal(modes.get('w.fail'), 'stop'); assert.equal(modes.get('w.ok'), 'stop');
  assert.equal(modes.get('w.back'), 'back-return');
  const c = countsOf(m);
  assert.equal(c.ends.boxes, 4); assert.equal(c.ends.stop, 3); assert.equal(c.ends.back, 1);
  assert.equal(c.ends.stop + c.ends.back, c.ends.boxes, 'stop here + hand back = every ending box');
  const d = toAtlasData(m, { charts: chartsFromModel(m) });
  assert.equal(d.charts.whole.nodes['w.back'].ending, 'back'); assert.equal(d.charts.whole.nodes['w.fail'].ending, 'stop');
  assert.equal(d.charts.whole.nodes['in.work'].ending, undefined, 'only an end box carries it');
});

test('countsOf: loops declared + worked out add up; the worked-out one is found from a return road no loop holds', () => {
  const m = system(), c = countsOf(m), w = workedOutLoops(m);
  // return roads: w.back -> w.run (not inside the declared loop: w.back is not in it) and w.run -> w.claim (inside it)
  assert.equal(w.length, 1); assert.equal(w[0].derived, true); assert.ok(w[0].boxes.includes('w.back') && w[0].boxes.includes('w.run'));
  assert.equal(c.loops.declared, 1); assert.equal(c.loops.workedOut, 1); assert.equal(c.loops.total, 2);
  assert.equal(c.loops.noLimit, c.loops.noLimitDeclared + c.loops.noLimitWorkedOut);
  const d = toAtlasData(m, { charts: chartsFromModel(m) });
  assert.equal(d.loops.length, c.loops.total, 'the page lists exactly the loops it counts');
  assert.equal(d.loops.filter((l) => l.derived).length, c.loops.workedOut);
  assert.equal(d.meta.counts.loops.total, c.loops.total);
});

test('countsOf: what separates the loops with no limit from the questions raised is computed, never guessed', () => {
  const m = system();
  const breaks = [{ key: 'no-limit-loop:l_retry', check: 'no-limit-loop', state: 'suspect' }, { key: 'no-limit-loop:w.claim', check: 'no-limit-loop', state: 'dismissed' }];
  const c = countsOf(m, { breaks });
  assert.equal(c.loops.noLimit, 2); assert.equal(c.loops.raised, 2);
  assert.equal(c.loops.raisedNoLimit, 1, 'the declared loop with no limit'); assert.equal(c.loops.raisedCycle, 1, 'a cycle no loop lists');
  assert.equal(c.loops.raisedNoLimit + c.loops.raisedDisputed + c.loops.raisedCycle, c.loops.raised);
});

test('countsOf: the break totals add up (look = kept + open + waits + loops + silent) and set aside = leads + dismissed', () => {
  const rows = ['suspect', 'suspect', 'open', 'wait', 'silent', 'lead', 'dismissed', 'dismissed'].map((state, i) => ({ key: 'k' + i, check: 'x', state }));
  const c = countsOf(system(), { breaks: rows });
  assert.equal(c.breaks.look, 5); assert.equal(c.breaks.kept + c.breaks.open + c.breaks.waits + c.breaks.loops + c.breaks.silent, c.breaks.look);
  assert.equal(c.breaks.setAside, 3);
});

test('countsOf: endings in the code against ending boxes, from the census and the ledger', () => {
  const m = system(); m.ledger = { 'e1': { box: 'w.fail' }, 'e2': { merged: 'w.fail', why: 'same' }, 'e3': { box: 'in.work' }, 'e4': { route: 'r9' } };
  const census = { endings: ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => ({ id })), counts: { rawReturnsAndRaises: 40, droppedLowEndings: 2 } };
  const c = countsOf(m, { census, facts: { functions: { 'a.py::f': { returns: [{ line: 1 }], raises: [], excepts: [] } } } });
  assert.equal(c.ends.census, 5);
  assert.equal(c.ends.censusOnEnds, 3, 'e1 and e2 land on an end box, e4 on a road into one; e3 is a step; e5 has no entry');
  assert.equal(c.ends.censusOnEnds + c.ends.censusElsewhere, c.ends.census);
  assert.equal(c.ends.boxesWithRow, 2); assert.equal(c.ends.boxesWithRow + c.ends.boxesWithoutRow, c.ends.boxes);
  assert.equal(c.ends.returnOrRaise + c.ends.other, c.ends.boxesWithoutRow, 'every ending box with no row is one or the other');
  assert.equal(c.ends.statements, 40);
});

test('heardBy: any box may carry it; W-heard only for an unknown by, a box that does not exist, and a failure or refusal END box with no entry', () => {
  const m = system();
  m.heardBy = { 'w.fail': { by: 'caller', how: 'rethrown' }, 'w.log': { by: 'log', how: 'console.error' }, 'ghost': { by: 'nobody' }, 'in.work': { by: 'pigeon' } };
  const ids = heardIssues(m).map((i) => `${i.kind}:${i.at}`).sort();
  assert.deepEqual(ids, ['bad-by:in.work', 'missing:in.reject', 'unknown-box:ghost']);
  assert.ok(!heardIssues(m).some((i) => i.at === 'w.log'), 'a step that is not an end box may carry an entry');
  assert.deepEqual(Object.keys(heardMap(m)).sort(), ['ghost', 'w.fail', 'w.log'], 'an unknown by is dropped from the map');
  const v = validateModel(m, { modules: [], functions: {} }, null, {});
  assert.ok(v.warnings.some((w) => w.code === 'W-heard'), 'the check warns');
  assert.ok(!v.refusals.some((r) => /heard/i.test(r.msg)), 'and never refuses');
});

test('silent failures: a box heard by nobody or only a log, unless its outcome is success, refusal or neutral; they join the total and carry no gate', () => {
  const m = system();
  m.heardBy = { 'w.fail': { by: 'nobody', how: 'no trace' }, 'w.log': { by: 'log', how: 'console.error' }, 'in.reject': { by: 'log' }, 'w.ok': { by: 'nobody' }, 'x.side': { by: 'nobody' }, 'in.work': { by: 'person' } };
  const rows = breaksOf(m, []).filter((r) => r.state === 'silent');
  assert.deepEqual(rows.map((r) => r.boxes[0]).sort(), ['w.fail', 'w.log', 'x.side'], 'refusal and success endings are left out; a step with no outcome counts');
  assert.ok(rows.every((r) => r.check === 'silent-failure' && /who should know/.test(r.question)));
  assert.equal(silentBox({ outcome: 'neutral' }, { by: 'nobody' }), false);
  const d = toAtlasData(m, { charts: chartsFromModel(m) });
  const B = d.meta.counts.breaks;
  assert.equal(B.silent, 3); assert.equal(B.look, B.kept + B.open + B.waits + B.loops + B.silent, 'its count joins the total'); assert.ok(B.look >= 3);
  assert.equal(d.charts.whole.nodes['w.fail'].heard.by, 'nobody');
  assert.equal(d.charts.whole.nodes['in.work'].heard.by, 'person', 'on any box');
});

test('a model with no heardBy, no partNotes and no breaks still builds the page data', () => {
  const m = system(); m.loops = []; m.routes = m.routes.filter((r) => r.type !== 'return');
  const d = toAtlasData(m, { charts: chartsFromModel(m) });
  assert.ok(d.meta.counts && d.meta.counts.heard.said === 0 && d.meta.counts.breaks.look === 0);
  assert.ok(!('breaks' in d) || d.breaks.length === 0);
  assert.ok(Object.values(d.charts).every((c) => !c.note));
});

test('partNotes: one line for a part of a stage, read like partNames; it never changes a chart geometry key', () => {
  const m = system(), ids = m.boxes.filter((b) => b.stage === 's1').map((b) => b.id);
  const big = { ...m, stages: [...m.stages] };
  const plain = chartsFromModel(big, { maxBoxes: 3 }), parts = plain.filter((c) => c.kind === 'stage' && c.stage === 's1');
  assert.ok(parts.length >= 2, 'the stage is split into parts');
  const withNote = { ...big, partNotes: { [parts[0].boxes[0].id]: 'The first checks, in one line.' } };
  const noted = chartsFromModel(withNote, { maxBoxes: 3 }), p0 = noted.find((c) => c.id === parts[0].id);
  assert.equal(p0.note, 'The first checks, in one line.');
  assert.ok(p0.summary.startsWith('The first checks, in one line.'), 'the note replaces the stage blurb');
  assert.equal(noted.find((c) => c.id === parts[1].id).note, undefined);
  for (const c of plain) assert.equal(shapeKey(noted.find((x) => x.id === c.id), withNote), shapeKey(c, big), 'no re-place for ' + c.id);
  assert.ok(ids.length > 0);
  const d = toAtlasData(withNote, { charts: noted });
  assert.equal(d.charts[p0.id].note, 'The first checks, in one line.');
});

test('the overview main path: consecutive distinct stages, repeats kept; a mid-path ending that hands back is its stage, the last box is the ending; every road of it is kept past the cap', () => {
  const m = system(), cs = chartsFromModel(m), ov = cs.find((c) => c.kind === 'overview');
  assert.deepEqual(ov.mainRun, ['s1', 's2', 'end_success'].slice(0, 2).concat(['end_success']), 'in.* then w.* then the success ending');
  const d = toAtlasData(m, { charts: cs });
  assert.deepEqual(d.charts[ov.id].spine, ov.mainRun);
  const have = new Set(ov.routes.map((r) => r.from + '>' + r.to));
  for (let i = 0; i + 1 < ov.mainRun.length; i++) assert.ok(have.has(ov.mainRun[i] + '>' + ov.mainRun[i + 1]), 'road ' + ov.mainRun[i] + ' to ' + ov.mainRun[i + 1] + ' is drawn');
  const boxes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }], roads = [['a', 'b'], ['b', 'c'], ['a', 'c'], ['c', 'a'], ['b', 'a']].map(([from, to], i) => ({ id: 'o' + i, from, to }));
  const r = capOverviewRoads(boxes, roads, ['a', 'b', 'c', 'b', 'a'], 0.5);          // the cap is 2; the path needs 4 roads
  for (const [x, y] of [['a', 'b'], ['b', 'c'], ['c', 'b'], ['b', 'a']]) if (roads.some((q) => q.from === x && q.to === y)) assert.ok(r.drawn.some((q) => q.from === x && q.to === y), `${x}>${y} kept`);
});

test('weightedRoute: a stage change costs more than a road, a main-path road costs far less, the same map gives the same answer; --shortest stays the plain one', () => {
  const m = system(), rt = m.routes;
  // in.work -> w.claim directly crosses stages once; the other way round also crosses once: both end in s2
  const p = weightedRoute(m.boxes, rt, 'in.start', 'w.ok', { main: m.paths[0].boxes });
  assert.ok(p && p[0].from === 'in.start' && p[p.length - 1].to === 'w.ok');
  assert.ok(p.every((r) => r.type !== 'return'), 'forward roads only');
  assert.deepEqual(weightedRoute(m.boxes, rt, 'in.start', 'w.ok', { main: m.paths[0].boxes }).map((r) => r.id), p.map((r) => r.id), 'deterministic');
  // two routes of equal hops: one stays in the stage, the other leaves and comes back; the weighted search stays
  const b = (id, stage) => ({ id, stage }), boxes = [b('a', 's1'), b('x', 's1'), b('y', 's2'), b('z', 's1'), b('t', 's1')];
  const rs = [{ id: '1', from: 'a', to: 'x' }, { id: '2', from: 'x', to: 't' }, { id: '3', from: 'a', to: 'y' }, { id: '4', from: 'y', to: 'z' }, { id: '5', from: 'z', to: 't' }];
  assert.deepEqual(weightedRoute(boxes, rs, 'a', 't').map((r) => r.id), ['1', '2']);
  const short = shortestRoute(boxes, rs, 'a', 't'); assert.equal(short.length, 2);
  // a long way inside one stage beats one that crosses stages twice
  const boxes2 = [b('a', 's1'), b('m1', 's1'), b('m2', 's1'), b('m3', 's1'), b('y', 's2'), b('t', 's1')];
  const rs2 = [{ id: 'a1', from: 'a', to: 'm1' }, { id: 'a2', from: 'm1', to: 'm2' }, { id: 'a3', from: 'm2', to: 'm3' }, { id: 'a4', from: 'm3', to: 't' }, { id: 'b1', from: 'a', to: 'y' }, { id: 'b2', from: 'y', to: 't' }];
  assert.deepEqual(weightedRoute(boxes2, rs2, 'a', 't').map((r) => r.id), ['a1', 'a2', 'a3', 'a4'], 'four roads in one stage cost 4; two roads across stages cost 14');
  assert.deepEqual(shortestRoute(boxes2, rs2, 'a', 't').map((r) => r.id), ['b1', 'b2'], 'the plain search takes the short cut');
  assert.deepEqual(weightedRoute(boxes2, rs2, 'a', 't', { main: ['a', 'y', 't'] }).map((r) => r.id), ['b1', 'b2'], 'a main-path road costs far less');
});

test('agent: where says stops here / hands back and who hears; breaks lists silent failures; path along a path that repeats a box', () => {
  const m = system();
  m.heardBy = { 'w.log': { by: 'log', how: 'console.error' }, 'w.fail': { by: 'caller', how: 'rethrown' } };
  const data = agentData(m, {});
  const w = C.where(data, 'w.back'), f = C.where(data, 'w.fail'), l = C.where(data, 'w.log');
  assert.match(w, /HANDS BACK to its caller/); assert.match(f, /STOPS HERE/); assert.match(f, /who hears: thrown or returned to the code that called \(rethrown\)/);
  assert.match(l, /who hears: only written to a log/, 'any box');
  assert.match(C.where(data, 'in.reject'), /who hears: not said yet/, 'a refusal end with no entry says so');
  const br = C.breaks(data, {});
  assert.match(br, /failure ending\(s\) nobody is told about/); assert.match(br, /silent w\.log/);
  assert.match(C.breaks(data, { silent: true }), /BREAKS --silent 1 failure ending/);
  // both boxes on one declared path that repeats w.run: B is looked for AFTER A
  const p = C.path(data, 'w.run', 'w.ok');
  assert.match(p, /along the declared path main/); assert.match(p, /w\.run .*-> w\.ok|w\.run .* -> w\.back/);
  const q = C.path(data, 'in.start', 'w.ok');
  assert.match(q, /along the declared path main/);
  const o = C.path(data, 'in.reject', 'w.fail');              // on no common path: a route the roads allow, said so
  assert.match(o, /a route the roads allow|NO ROUTE/);
});
