// How a page looks, the parts that need no browser: what a handle tab says (shared start, shared handle, middle cut, unique), the tooltip, the road a label belongs to (labelAttach and
// the dot, the stem and the words hugging the road), and the overview's names that are no longer cut. (The page is checked in test/viewer.verify.mjs, section look.)
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { chipPlan, chipLayout, middleCut, renderSVG, labelAttach } from '../src/engine/render.mjs';
import { metrics } from '../src/engine/metrics.mjs';
import { HARD } from '../src/build/layout.mjs';
import { chartsFromModel } from '../src/build/index.mjs';

const node = (id, handle, extra = {}) => ({ id, title: id, kind: 'step', x: 0, y: 0, w: 190, h: 60, lines: [id], handle, ...extra });
const chart = (nodes, edges = []) => ({ width: 1200, height: 600, nodes: nodes.map((n, i) => ({ ...n, x: 40 + (i % 4) * 280, y: 40 + Math.floor(i / 4) * 160 })), edges, clusters: [] });

test('handle tabs: a handle that fits is shown whole, a long one is cut in the middle so its start and its end survive', () => {
  const g = chart([node('a', 'short'), node('b', 'removeStaleEntryKeyIfNeededOnFinish')]);
  const p = chipPlan(g);
  assert.equal(p.text.a, 'short');
  assert.ok(p.text.b.includes('···') && p.text.b.length <= 30, p.text.b);
  assert.ok(p.text.b.startsWith('removeStale') && p.text.b.endsWith('OnFinish'), p.text.b);                  // the start AND the end of the name
  assert.equal(middleCut('abcdefghij', 20, 5), 'abcdefghij');
  assert.ok(middleCut('abcdefghijklmnopqrstuvwxyz', 10, 4).endsWith('wxyz'));
});

test('handle tabs: a start shared by three tabs is left out of them and said once (plan.prefix); a verb is never stripped', () => {
  const g = chart([node('a', 'Parser.init'), node('b', 'Parser.cancel'), node('c', 'Parser.exitedWithTimeout'), node('d', 'Other.thing')]);
  const p = chipPlan(g);
  assert.equal(p.prefix, 'Parser.');
  assert.equal(p.text.a, 'init'); assert.equal(p.text.b, 'cancel'); assert.equal(p.text.c, 'exitedWithTimeout'); assert.equal(p.text.d, 'Other.thing');
  const v = chipPlan(chart([node('a', 'moveFirstToHold'), node('b', 'moveSecondFromListIfNeeded'), node('c', 'moveToHoldingList')]));
  assert.equal(v.prefix, '');                                                                                       // "move" is a verb, not a qualifier: it stays
});

test('handle tabs: one handle on three or more boxes and on 40% of the tabs is said once and drawn on none of them', () => {
  const g = chart([node('a', 'mainLoop'), node('b', 'mainLoop'), node('c', 'mainLoop'), node('d', 'other'), node('e', 'another')]);
  const p = chipPlan(g);
  assert.deepEqual(p.shared, { handle: 'mainLoop', count: 3 });
  assert.deepEqual(Object.keys(p.drop).sort(), ['a', 'b', 'c']);
  const pl = chipLayout(g), svg = renderSVG(g);
  assert.deepEqual(Object.keys(pl).sort(), ['d', 'e']);                                                           // no tab on the three
  assert.equal((svg.match(/class="chip /g) || []).length, 2);
  assert.ok(/data-node="a"[^>]*data-handle="mainLoop"/.test(svg));                                                   // the box still carries its handle (search, focus)
  assert.equal(chipPlan(chart([node('a', 'x'), node('b', 'x'), node('c', 'y'), node('d', 'z'), node('e', 'w'), node('f', 'v')])).shared, null);   // two of six: not most of the chart
});

test('handle tabs: no two tabs read the same when their full names differ, and the full name is a tooltip', () => {
  const a = 'recoverStaleEntryKeyForTheWorker', b = 'recoverStaleEntryKeyForTheTask', c = 'recoverStaleEntryKeyNow';
  const g = chart([node('a', a), node('b', b), node('c', c), node('d', 'x')]);
  const p = chipPlan(g), seen = new Map();
  for (const id of ['a', 'b', 'c']) { const t = p.text[id]; assert.ok(!seen.has(t), 'same reading: ' + t); seen.set(t, id); }
  const svg = renderSVG(g);
  assert.ok(svg.includes('<title>' + a + '</title>'));                                                              // the cut tab says its whole name
  assert.ok(!svg.includes('<title>x</title>'));                                                                     // a tab that shows it all needs no tooltip
});

test('handle tabs: a tab as wide as 30 characters is only for a box wide enough; a narrow box gets a shorter one', () => {
  const long = 'a_rather_long_official_handle_name_indeed';
  const p = chipPlan(chart([node('wide', long, { w: 230 }), node('narrow', long + '2', { w: 150 })]));
  assert.ok(p.text.wide.length > p.text.narrow.length, p.text.wide + ' / ' + p.text.narrow);
  assert.ok(p.text.wide.length <= 30);
});

// ---- the road a label belongs to ---------------------------------------------------------------------------------------------------------
test('labelAttach: finds the nearest point of the label\'s own road and which side the road lies on', () => {
  const vert = [[100, 0], [100, 200]];
  const right = labelAttach(vert, { x: 107, y: 80, w: 60, h: 30 });                    // the pill is right of a vertical road: the road is on its left
  assert.equal(right.side, 'l'); assert.equal(right.axis, 'x'); assert.equal(right.gap, 7); assert.deepEqual(right.q, [100, 95]);
  const left = labelAttach(vert, { x: 20, y: 80, w: 73, h: 30 });
  assert.equal(left.side, 'r'); assert.equal(left.gap, 7);
  const on = labelAttach(vert, { x: 70, y: 80, w: 60, h: 30 });                         // the road runs through the pill
  assert.equal(on.gap, 0);
  const horiz = labelAttach([[0, 100], [300, 100]], { x: 100, y: 105, w: 80, h: 20 });  // a pill under a horizontal road
  assert.equal(horiz.side, 't'); assert.equal(horiz.axis, 'y'); assert.equal(horiz.gap, 5);
  assert.equal(labelAttach([], { x: 0, y: 0, w: 1, h: 1 }), null);
});

test('a label beside its road is drawn with a dot on that road and its words against it; the geometry does not move', () => {
  const e = { id: 'e1', from: 'a', to: 'b', type: 'forward', pts: [[100, 40], [100, 300]], lines: ['Name is usable', 'again'], labelBox: { x: 107, y: 150, w: 90, h: 36 } };
  const g = { width: 400, height: 340, nodes: [node('a', ''), node('b', '')].map((n, i) => ({ ...n, x: 20, y: i ? 300 : -20 })), edges: [e], clusters: [] };
  const box0 = JSON.stringify(e.labelBox);
  const svg = renderSVG(g, { handles: false });
  assert.ok(svg.includes('class="elabel-dot"') && svg.includes('data-attached="1"'), 'a dot marks the road');
  assert.ok(/text-anchor="start"[^>]*class="elabel-text"/.test(svg), 'the road is on the left: the words start at it');
  assert.equal(JSON.stringify(e.labelBox), box0);                                                                    // labelBox is read, never written
  const x = +/<rect x="([\d.]+)"[^>]*class="elabel-bg"/.exec(svg)[1];
  assert.ok(x - 100 >= 1 && x - 100 <= 2, 'the pill\'s edge is 1.5 units from its road (it was 4): ' + (x - 100));
  assert.ok(!renderSVG(g, { handles: false, attach: false }).includes('elabel-dot'), 'attach: false draws the old pill');
  // a label ON its road gets no dot
  const on = { ...e, labelBox: { x: 55, y: 150, w: 90, h: 36 } };
  assert.ok(!renderSVG({ ...g, edges: [on] }, { handles: false }).includes('elabel-dot'));
});

test('the label metrics: hard counts stay what the engine measured (the pill is only drawn closer, never moved in the data)', () => {
  const e = { id: 'e1', from: 'a', to: 'b', type: 'forward', pts: [[100, 40], [100, 300]], lines: ['x'], labelBox: { x: 107, y: 150, w: 40, h: 20 } };
  const g = { width: 400, height: 340, nodes: [node('a', ''), node('b', '')].map((n, i) => ({ ...n, x: 20, y: i ? 300 : -20 })), edges: [e], clusters: [] };
  const before = JSON.stringify(g);
  renderSVG(g);
  assert.equal(JSON.stringify(g), before);
  const m = metrics(g); for (const k of HARD.filter(h => h !== 'shortArrowStubs' && h !== 'diagonalSegs' && h !== 'labelMissing')) assert.equal(m[k], 0, k);
});

// ---- the overview's names ----------------------------------------------------------------------------------------------------------------
test('the overview poster no longer cuts a stage name at 34 characters', () => {
  const long = 'Starting up and the settings gate, with its checks';
  const b = (id, stage, kind, x = {}) => ({ id, stage, kind, title: id, plain: `${id} does its part.`, status: 'live', refs: [{ path: 'a.py', symbol: 'a.py::f', line: 1 }], ...x });
  const model = { schema: 'faultline.model/1', system: { name: 'Toy' }, stages: [{ id: 's1', title: long, order: 1 }, { id: 's2', title: 'Two', order: 2 }],
    boxes: [b('x1', 's1', 'step'), b('x2', 's1', 'step'), b('y1', 's2', 'step'), b('y2', 's2', 'end', { outcome: 'success' })],
    routes: [{ id: 'r1', from: 'x1', to: 'x2', type: 'forward', when: 'ok' }, { id: 'r2', from: 'x2', to: 'y1', type: 'forward', when: 'ok' }, { id: 'r3', from: 'y1', to: 'y2', type: 'forward', when: 'ok' }], loops: [], paths: [] };
  const ov = chartsFromModel(model).find(c => c.kind === 'overview');
  const t = ov.boxes.find(x => x.id === 's1').title;
  assert.equal(t, long);                                                                                              // 53 characters: whole
  assert.ok(!t.includes('…'));
});
