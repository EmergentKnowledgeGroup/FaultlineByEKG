// Where a RETURN hand-off lands (the box that calls into the returning flow, in two phases), and join writing the same files twice.
// Hand-built systems only: nothing here needs the toy or any real project.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { joinHandoffs, checkHandoffs, resolveHandoffs, g5After } from '../src/build/handoffs.mjs';
import { loadModelReport } from '../src/model/index.mjs';
import { buildGraph, sccs } from '../src/model/graph.mjs';

const fn = (p, name, line, end) => [`${p}::${name}`, { path: p, line, end, kind: 'function' }];
const ref = (p, name, line) => ({ path: p, symbol: `${p}::${name}`, line });
const box = (id, stage, kind, refs, extra = {}) => ({ id, stage, kind, status: 'live', title: id, plain: 'x', refs, ...(kind === 'end' ? { outcome: 'success' } : {}), ...extra });
const road = (id, from, to, when = 'then', type = 'forward') => ({ id, from, to, type, when });

// A caller function with four boxes down its length (a gate, two call sites, an aftermath), a callee with an entry and an ending, and a helper nobody calls.
function callWorld(extraBoxes = [], extraRoutes = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-ret-'));
  const facts = { root: dir, modules: [{ path: 'a.py', lines: 500 }, { path: 'b.py', lines: 100 }, { path: 'c.py', lines: 100 }],
    functions: Object.fromEntries([fn('a.py', 'caller', 1, 400), fn('b.py', 'callee', 1, 100), fn('c.py', 'other', 1, 90)]) };
  const model = { schema: 'faultline.model/1', stages: [{ id: 's1' }, { id: 's2' }], boxes: [
    box('f_gate', 's1', 'gate', [ref('a.py', 'caller', 10)]), box('f_call1', 's1', 'step', [ref('a.py', 'caller', 100)]),
    box('f_call2', 's1', 'step', [ref('a.py', 'caller', 200)]), box('f_after', 's1', 'step', [ref('a.py', 'caller', 300)]),
    box('g_entry', 's2', 'step', [ref('b.py', 'callee', 5)]), box('g_end', 's2', 'end', [ref('b.py', 'callee', 90)]), ...extraBoxes],
  routes: [road('r1', 'f_gate', 'f_call1'), road('r2', 'f_call1', 'f_call2'), road('r3', 'f_call2', 'f_after'), road('r4', 'g_entry', 'g_end'), ...extraRoutes] };
  return { dir, facts, model };
}
const hand = (dir, rows) => { fs.mkdirSync(path.join(dir, 'handoffs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'handoffs', 'a.json'), JSON.stringify(rows)); };
// the road that calls into the callee is a hand-off row too, and it is written AFTER the return: the return still has to see it
const callRow = (from = 'f_call1') => ({ from, toSymbol: 'b.py::callee', when: 'Call the callee', why: 'x' });
const back = (extra = {}) => ({ from: 'g_end', toSymbol: 'a.py::caller', type: 'return', when: 'Callee finished', why: 'x', ...extra });
const landed = (dir, model, facts) => { const r = joinHandoffs(dir, model, facts); return { r, routes: JSON.parse(fs.readFileSync(path.join(dir, 'model', '80-handoffs.json'), 'utf8')).routes }; };
const ret = (routes) => routes.filter((x) => x.type === 'return');

test('return landing: the box that calls into the returning flow, not the function\'s entry; roads landed later in the file are seen', () => {
  const { dir, facts, model } = callWorld();
  hand(dir, [back(), callRow()]);
  const { r, routes } = landed(dir, model, facts);
  assert.deepEqual(ret(routes).map((x) => `${x.from}>${x.to}`), ['g_end>f_call1'], 'f_call1 has the forward road into the callee; the old rule took f_gate, the first box of the function');
  const q = r.review.find((x) => x.reason === 'return-caller');
  assert.ok(q && q.how === 'caller' && q.hops === 2, 'the review file says how it landed: by the caller, 2 forward hops away');
  assert.deepEqual(r.returns, { total: 1, caller: 1, line: 0, nearestLine: 0, first: 0, tie: 0 });
  // no false loop: the cycle the return closes is call site -> callee -> back, and the gate in front of the call is not in it
  const g = buildGraph({ ...model, routes: [...model.routes, ...routes] });
  const cyc = sccs(g.boxes.map((b) => b.id), g.out).find((c) => c.includes('g_end'));
  assert.deepEqual([...cyc].sort(), ['f_call1', 'g_end', 'g_entry']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('return landing: a toLine on a cited line is the writer\'s own pointer; otherwise reachability decides and toLine only breaks ties', () => {
  const { dir, facts, model } = callWorld();
  const on = (extra) => { hand(dir, [back(extra), callRow()]); const { r, routes } = landed(dir, model, facts); return { how: r.review.find((x) => /^return-/.test(x.reason)), to: ret(routes).map((x) => x.to) }; };
  assert.deepEqual(on({ toLine: 100 }).to, ['f_call1']);
  const exact = on({ toLine: 200 });
  assert.deepEqual(exact.to, ['f_call2'], 'a box that cites exactly the line given wins');
  assert.equal(exact.how.reason, 'return-line'); assert.equal(exact.how.how, 'line');
  assert.deepEqual(on({ toLine: 130 }).to, ['f_call1'], 'no box cites line 130: the caller found by the roads, however far the line');
  assert.deepEqual(on({ to: 'f_after' }).to, ['f_after'], 'an explicit `to` wins over everything');
  hand(dir, [back({ to: 'f_after' }), callRow()]);
  assert.equal(joinHandoffs(dir, model, facts).review.filter((x) => /^return-/.test(x.reason)).length, 0, 'an explicit `to` is not second-guessed, so it is not in the review file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('return landing: two callers equally near are a tie (asked, first in model order); toLine separates them; no caller found is listed, never silent', () => {
  const twin = [box('f_call1b', 's1', 'step', [ref('a.py', 'caller', 105)])];
  const { dir, facts, model } = callWorld(twin, [road('r5', 'f_gate', 'f_call1b')]);
  hand(dir, [back(), callRow('f_call1'), callRow('f_call1b')]);
  let x = landed(dir, model, facts);
  assert.deepEqual(ret(x.routes).map((r) => r.to), ['f_call1']);
  assert.ok(x.r.review.some((q) => q.reason === 'return-tie'), 'a tie is a question');
  hand(dir, [back({ toLine: 106 }), callRow('f_call1'), callRow('f_call1b')]);
  x = landed(dir, model, facts);
  assert.deepEqual(ret(x.routes).map((r) => r.to), ['f_call1b'], 'the cited line nearest toLine breaks the tie');
  assert.ok(!x.r.review.some((q) => q.reason === 'return-tie'));
  // a function nobody leads to the flow from: nothing to follow
  const lone = [box('h1', 's1', 'step', [ref('c.py', 'other', 20)]), box('h2', 's1', 'step', [ref('c.py', 'other', 60)])];
  const w = callWorld(lone);
  hand(w.dir, [{ ...back(), toSymbol: 'c.py::other' }, { ...back({ toLine: 58 }), toSymbol: 'c.py::other', when: 'Second' }]);
  const y = landed(w.dir, w.model, w.facts);
  assert.deepEqual(y.r.review.map((q) => `${q.reason}:${y.routes.find((r) => r.from === 'g_end' && r.to === q.to) ? q.to : '?'}`), ['return-first:h1', 'return-nearest-line:h2']);
  assert.match(y.r.review[0].why, /caller could not be found/);
  const ho = checkHandoffs(w.dir, w.model, w.facts, 's2');
  assert.equal(ho.asks.length, 2, 'worklist asks the stage about both before join');
  assert.equal(ho.returns.first, 1); assert.equal(ho.returns.nearestLine, 1);
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(w.dir, { recursive: true, force: true });
});

test('return landing is deterministic and does not depend on the order rows are listed in', () => {
  const { dir, facts, model } = callWorld();
  const rows = [back(), callRow(), back({ toLine: 200, when: 'Again' })];
  const a = JSON.stringify(resolveHandoffs(rows.map((r) => ({ ...r, _file: 'a.json' })), model, facts));
  const b = JSON.stringify(resolveHandoffs(rows.slice().reverse().map((r) => ({ ...r, _file: 'a.json' })), model, facts));
  const lands = (s) => JSON.parse(s).results.map((x) => `${x.row.type || 'forward'}:${x.row.toLine ?? ''}>${x.to}`).sort();
  assert.deepEqual(lands(a), lands(b));
  assert.equal(a, JSON.stringify(resolveHandoffs(rows.map((r) => ({ ...r, _file: 'a.json' })), model, facts)));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------- join twice
test('join is idempotent: its own roads are not an input, so a second run writes the same bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-idem-'));
  const facts = { root: dir, modules: [{ path: 'a.py', lines: 100 }], functions: Object.fromEntries([fn('a.py', 'proc', 1, 90), fn('a.py', 'other', 91, 99)]) };
  const frag = { schema: 'faultline.model/1', stages: [{ id: 's1' }], boxes: [
    box('from1', 's1', 'step', [ref('a.py', 'other', 95)]), box('proc_x', 's1', 'step', [ref('a.py', 'proc', 15)]), box('proc_y', 's1', 'step', [ref('a.py', 'proc', 40)])], routes: [] };
  fs.mkdirSync(path.join(dir, 'model'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'model', '00-system.json'), JSON.stringify(frag));
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify(facts));
  // proc_y leads back to proc_x, so once that road is in the model proc_x "has a road in from inside the function" and the OLD rule moved to proc_y
  hand(dir, [{ from: 'proc_y', to: 'proc_x', when: 'Again', why: 'x' }, { from: 'from1', toSymbol: 'a.py::proc', when: 'Start the process', why: 'x' }, { from: 'proc_x', toSymbol: 'a.py::other', type: 'return', when: 'Done', why: 'x' }]);
  const files = ['model/80-handoffs.json', 'handoffs.review.json', 'handoffs.unresolved.json'], read = () => files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  joinHandoffs(dir, loadModelReport(dir).model, facts);
  const one = read();
  const to1 = JSON.parse(one[0]).routes.find((r) => r.from === 'from1').to;
  assert.equal(to1, 'proc_x');
  for (let i = 0; i < 3; i++) {
    const m = loadModelReport(dir).model;                                    // what the command does: the merged model now INCLUDES 80-handoffs.json
    assert.ok(m.routes.some((r) => r.id.startsWith('x_')), 'the second run really sees its own roads in the model');
    joinHandoffs(dir, m, facts);
    assert.deepEqual(read(), one, `run ${i + 2} wrote different bytes`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------- G5 before join
test('G5 before join: a box with one drawn exit gets a second from a hand-off, and a road with no condition would be refused after join', () => {
  const { dir, facts, model } = callWorld();
  const m = { ...model, routes: model.routes.map((r) => (r.id === 'r4' ? { ...r, when: '' } : r)).concat([road('r6', 'g_entry', 'g_entry_x', '')]) };
  m.boxes = [...m.boxes, box('g_entry_x', 's2', 'step', [ref('b.py', 'callee', 7)])];
  hand(dir, [{ from: 'g_entry', toSymbol: 'a.py::caller', toLine: 300, when: 'Back to the caller', why: 'x' }]);
  const ho = checkHandoffs(dir, m, facts, 's2');
  assert.equal(ho.g5.length, 1);
  assert.equal(ho.g5[0].box, 'g_entry'); assert.equal(ho.g5[0].exits, 3); assert.equal(ho.g5[0].adds, 1);
  assert.deepEqual(ho.g5[0].empties.map((e) => e.id).sort(), ['r4', 'r6'], 'the drawn roads with an empty when are named');
  const ok = { ...m, routes: m.routes.map((r) => ({ ...r, when: r.when || 'Otherwise' })) };
  assert.equal(checkHandoffs(dir, ok, facts, 's2').g5.length, 0, 'every exit has its condition: nothing to say');
  hand(dir, [{ from: 'g_entry', toSymbol: 'a.py::caller', toLine: 300, when: '', why: 'x' }]);
  assert.deepEqual(checkHandoffs(dir, ok, facts, 's2').g5[0].empties.map((e) => e.kind), ['hand-off'], 'the hand-off row itself has no condition');
  assert.equal(typeof g5After, 'function');
  fs.rmSync(dir, { recursive: true, force: true });
});
