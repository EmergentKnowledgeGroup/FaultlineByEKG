// The scale commands: stage plan, worklist, hand-offs joined into routes. Runs on a copy of the toy model.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProject } from '../src/build/project.mjs';
import { loadModelReport } from '../src/model/index.mjs';
import { stageTable, stageWork, joinHandoffs, checkHandoffs } from '../src/build/worklist.mjs';
import { landingFor, landingIndex } from '../src/build/handoffs.mjs';

const TOY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'toy', '.faultline');

function copy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-work-'));
  for (const f of ['facts.json', 'census.json', 'graph.json']) fs.copyFileSync(path.join(TOY, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'model'));
  for (const f of fs.readdirSync(path.join(TOY, 'model'))) if (!f.startsWith('90-')) fs.copyFileSync(path.join(TOY, 'model', f), path.join(dir, 'model', f));
  return dir;
}
const load = (dir) => ({ ...readProject(dir), model: loadModelReport(dir).model });

test('plan: every row lands with its stage, modules nobody owns are listed, split moves functions', () => {
  const dir = copy(), c = load(dir);
  const mods = c.facts.modules.map((m) => m.path), worker = mods.find((m) => m.endsWith('worker.py'));
  const free = mods.find((m) => !c.model.modules?.[m]?.excluded);
  const plan = { modules: Object.fromEntries(mods.filter((m) => m !== free).map((m) => [m, 's_work'])) };
  const t = stageTable(c.model, c.facts, c.census, plan);
  assert.equal(t.total, c.census.endings.filter((e) => e.confidence !== 'low').length + c.census.branches.filter((b) => b.weight === 'decision').length);
  assert.ok(t.unowned.some((m) => m.path === free));
  plan.split = { [worker]: [{ match: '^Worker\.run$', stage: 's_queue' }] };
  const w = stageWork(c.model, c.facts, c.census, plan, 's_queue');
  assert.ok(w.modules.some((m) => m.path === worker));
  assert.ok(w.left.every((r) => r.fn === `${worker}::Worker.run`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('worklist: a ledger line takes a row off the list', () => {
  const dir = copy(), c = load(dir);
  const plan = { modules: Object.fromEntries(c.facts.modules.map((m) => [m.path, 's_work'])) };
  const before = stageWork(c.model, c.facts, c.census, plan, 's_work');
  assert.ok(before.left.length > 0);
  const row = before.left[0];
  c.model.ledger = { [row.id]: { excluded: 'test' } };
  const after = stageWork(c.model, c.facts, c.census, plan, 's_work');
  assert.equal(after.left.length, before.left.length - 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('join: a function name finds its box, the nearest cited line wins, unknown names are listed and never guessed', () => {
  const dir = copy(), c = load(dir);
  fs.mkdirSync(path.join(dir, 'handoffs'));
  const cited = c.model.boxes.find((b) => b.refs?.[0]?.symbol && b.id !== 'intake.submit');
  const from = c.model.boxes.find((b) => b.id !== cited.id).id;
  const rows = [
    { from, toSymbol: cited.refs[0].symbol, toLine: cited.refs[0].line, when: 'Test road', why: 'test', refs: cited.refs },
    { from, toSymbol: 'nowhere.py::missing', when: 'Bad', why: 'test' },
    { from: 'no.such.box', to: cited.id, when: 'Bad', why: 'test' },
  ];
  fs.writeFileSync(path.join(dir, 'handoffs', 'a.json'), JSON.stringify(rows));
  const r = joinHandoffs(dir, { ...c.model, routes: c.model.routes.filter((x) => !(x.from === from && x.to === cited.id)) }, c.facts);
  assert.equal(r.read, 3);
  assert.equal(r.unresolved.length, 2);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'model', '80-handoffs.json'), 'utf8')).routes;
  assert.equal(written.length, 1);
  assert.equal(written[0].from, from);
  assert.ok(c.model.boxes.find((b) => b.id === written[0].to).refs.some((x) => x.symbol === cited.refs[0].symbol));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------- the landing rule
// A hand-built system: functions in a.py, boxes that cite them in different ways. Nothing here needs the toy.
function landingProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-land-'));
  const fn = (name, line, end) => [`a.py::${name}`, { path: 'a.py', line, end, kind: 'function' }];
  const facts = { root: dir, functions: Object.fromEntries([fn('start', 10, 40), fn('stop', 50, 80), fn('call', 90, 120), fn('helper', 130, 150), fn('shared', 160, 190), fn('fin', 200, 230), fn('named', 240, 260)]), modules: [{ path: 'a.py', lines: 300 }] };
  const ref = (name, line) => ({ path: 'a.py', symbol: `a.py::${name}`, line });
  const box = (id, stage, kind, refs, extra = {}) => ({ id, stage, kind, status: 'live', title: id, plain: 'x', refs, ...extra });
  const model = { stages: [{ id: 's1' }, { id: 's2' }], routes: [], boxes: [
    box('from1', 's1', 'step', [ref('call', 91)]),
    box('begin_valve', 's1', 'gate', [ref('start', 12), ref('stop', 55)]),                 // cites stop only as a later ref, and nearest to the line asked for
    box('stop_step', 's2', 'step', [ref('stop', 60)]),                                      // about stop
    box('call_end', 's2', 'end', [ref('call', 100)]),                                       // an ending about call, nearer to the line asked for
    box('call_step', 's2', 'step', [ref('call', 95)]),
    box('only_later', 's2', 'step', [ref('start', 20), ref('helper', 135)]),                // the only box that cites helper, and not first
    box('twin_a', 's2', 'step', [ref('shared', 0)]), box('twin_b', 's2', 'step', [ref('shared', 0)]),
    box('fin_end', 's2', 'end', [ref('fin', 205)]),
    box('by_handle', 's2', 'step', [ref('start', 30)], { handle: 'named' }),
    box('named_other', 's2', 'step', [ref('start', 31), ref('named', 250)]),
  ] };
  return { dir, facts, model };
}
const hand = (dir, rows) => { fs.mkdirSync(path.join(dir, 'handoffs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'handoffs', 'a.json'), JSON.stringify(rows)); };
const row = (toSymbol, extra = {}) => ({ from: 'from1', toSymbol: `a.py::${toSymbol}`, when: 'When ' + toSymbol, why: 'x', ...extra });

test('join landing: a box about the function beats a box that merely cites it nearer; non-end before end; nothing guessed', () => {
  const { dir, facts, model } = landingProject();
  hand(dir, [row('stop', { toLine: 55 }), row('call', { toLine: 101 })]);
  const r = joinHandoffs(dir, model, facts);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'model', '80-handoffs.json'), 'utf8')).routes;
  assert.deepEqual(written.map((x) => x.to), ['stop_step', 'call_step'], 'stop lands on the box about stop, call on its non-ending box');
  assert.equal(r.review.length, 0, 'primary landings need no review');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'handoffs.review.json'), 'utf8')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('join landing: a later-ref box wins only when no box is about the function, and that is written for review', () => {
  const { dir, facts, model } = landingProject();
  hand(dir, [row('helper')]);
  const r = joinHandoffs(dir, model, facts);
  assert.equal(r.routes, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'model', '80-handoffs.json'), 'utf8')).routes[0].to, 'only_later');
  assert.equal(r.review.length, 1);
  assert.equal(r.review[0].reason, 'later-ref'); assert.equal(r.review[0].from, 'from1'); assert.equal(r.review[0].toSymbol, 'a.py::helper');
  assert.deepEqual(r.counts, { laterRef: 1, ties: 0, onEnding: 0, lineOutside: 0 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'handoffs.review.json'), 'utf8'))[0].candidates[0].box, 'only_later');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('join landing: ties and cross-stage roads onto an ending are written for review; an explicit `to` always wins; a handle counts as being about the function', () => {
  const { dir, facts, model } = landingProject();
  hand(dir, [row('shared'), row('fin'), row('named'), row('stop', { to: 'call_end' }), { from: 'from1', to: 'twin_a', when: 'W', why: 'x' }]);
  const r = joinHandoffs(dir, model, facts);
  const to = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(dir, 'model', '80-handoffs.json'), 'utf8')).routes.map((x) => [x.when, x.to]));
  assert.equal(to['When shared'], 'twin_a', 'a tie takes the first box in model order');
  assert.equal(to['When fin'], 'fin_end');
  assert.equal(to['When named'], 'by_handle', 'the handle names the function; the box that only cites it later does not win');
  assert.equal(to['When stop'], 'call_end', 'explicit to wins over toSymbol');
  const reasons = r.review.map((x) => `${x.toSymbol || x.to}:${x.reason}`).sort();
  assert.deepEqual(reasons, ['a.py::fin:ends-elsewhere', 'a.py::shared:tie'], 'the row with an explicit `to` onto another stage\'s ending is not asked about: someone already decided');
  assert.deepEqual(r.counts, { laterRef: 0, ties: 1, onEnding: 1, lineOutside: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkHandoffs: one stage, its own rows are checked, and nothing is written', () => {
  const { dir, facts, model } = landingProject();
  hand(dir, [row('stop', { toLine: 55 }), row('helper'), row('missing'), row('stop', { toLine: 999 }), { from: 'no.such', toSymbol: 'a.py::stop', when: 'W', why: 'x' }, { from: 'begin_valve', toSymbol: 'a.py::call', when: 'W2', why: 'x' }]);
  const before = fs.readdirSync(dir).sort();
  const r = checkHandoffs(dir, model, facts, 's1');
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'no file appears: no model/80-handoffs.json, no unresolved or review file');
  assert.equal(r.rows, 5, 'rows from boxes of s1; the row from an unknown box is not attributable (the file a.json is not named for the stage)');
  assert.equal(r.bad.length, 2, 'a function that is not in the facts, and a line outside the function');
  assert.ok(r.bad.some((b) => /not a function in the facts/.test(b.why)));
  assert.ok(r.bad.some((b) => /outside a\.py::stop/.test(b.why)));
  assert.equal(r.ok, 3);
  assert.equal(r.asks.length, 1); assert.match(r.asks[0].reasons[0], /later reference/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------- entry box, generic handles
// a.py::proc has three boxes: an inner step that cites an early line, the entry that cites a later one, and an ending; the word "run" is the handle of
// two boxes (one in the function's file, one not); the explicit-`to` rule is checked on roads that land on another stage's ending.
function entryProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-entry-'));
  const fn = (id, p, line, end) => [id, { path: p, line, end, kind: 'function' }];
  const facts = { root: dir, functions: Object.fromEntries([fn('a.py::proc', 'a.py', 10, 60), fn('a.py::run', 'a.py', 100, 120), fn('c.py::other', 'c.py', 5, 20), fn('a.py::sibling', 'a.py', 200, 220), fn('a.py::Q.run', 'a.py', 300, 320)]), modules: [{ path: 'a.py', lines: 400 }, { path: 'c.py', lines: 30 }] };
  const ref = (p, name, line) => ({ path: p, symbol: `${p}::${name}`, line });
  const box = (id, stage, kind, refs, extra = {}) => ({ id, stage, kind, status: 'live', title: id, plain: 'x', refs, ...extra });
  const model = { stages: [{ id: 's1' }, { id: 's2' }], routes: [{ id: 'in1', from: 'proc_entry', to: 'proc_inner', type: 'forward', when: 'then' }, { id: 'in2', from: 'proc_inner', to: 'proc_end', type: 'forward', when: 'done' }], boxes: [
    box('from1', 's1', 'step', [ref('c.py', 'other', 6)]),
    box('proc_inner', 's2', 'step', [ref('a.py', 'proc', 15)]),                            // first in model order, nearest the function's first line, but something inside the function leads to it
    box('proc_entry', 's2', 'step', [ref('a.py', 'proc', 40)]),                            // nothing that cites proc leads here
    box('proc_end', 's2', 'end', [ref('a.py', 'proc', 55)]),
    box('generic', 's2', 'step', [ref('c.py', 'other', 7)], { handle: 'run' }),             // a generic word, and its first ref is a different function in a different file
    box('run_box', 's2', 'step', [ref('a.py', 'run', 101)]),
    box('sib_h', 's2', 'step', [ref('a.py', 'sibling', 201)], { handle: 'run' }),           // same file as a.py::run: a handle that names it counts
    box('q_run', 's1', 'step', [ref('a.py', 'Q.run', 301)]),
    box('q_end', 's2', 'end', [ref('a.py', 'Q.run', 310)]),
  ] };
  return { dir, facts, model };
}

test('join landing: the function\'s ENTRY box wins over an inner step with an earlier cited line; non-end and lowest line break what is left', () => {
  const { dir, facts, model } = entryProject();
  hand(dir, [{ from: 'from1', toSymbol: 'a.py::proc', when: 'W1', why: 'x' }]);
  const r = joinHandoffs(dir, model, facts);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'model', '80-handoffs.json'), 'utf8')).routes[0].to, 'proc_entry', 'no road in from another box that cites proc');
  assert.equal(r.review.length, 0);
  const idx = landingIndex(model);
  assert.equal(landingFor(idx, 'a.py::proc', 10).box, 'proc_entry');
  assert.equal(landingFor(idx, 'a.py::proc', 16, true).box, 'proc_entry', 'a toLine near a box only refines among equals; the entry rule comes first');
  assert.equal(landingFor(idx, 'a.py::proc', 15, true).box, 'proc_inner', 'exactly on a box about the function: the writer pointed at it');
  assert.equal(landingFor(idx, 'a.py::proc', 55, true).box, 'proc_entry', 'not even an exact line enters a function at one of its endings');
  assert.equal(landingFor(landingIndex({ ...model, routes: [] }), 'a.py::proc', 10).box, 'proc_inner', 'with no road inside the function, non-end and then the lowest cited line decide');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('join landing: a handle that is a generic word names the function only when the box\'s first ref is in the same file', () => {
  const { dir, model } = entryProject();
  const idx = landingIndex(model), run = landingFor(idx, 'a.py::run', 100);
  assert.equal(run.box, 'run_box', 'the box with handle "run" whose first ref is a different function in another file is not about a.py::run');
  assert.ok(!run.candidates.some((c) => c.box === 'generic'));
  assert.ok(run.candidates.some((c) => c.box === 'sib_h' && c.primary), 'same file: the handle counts');
  assert.equal(landingFor(landingIndex({ ...model, boxes: model.boxes.filter((b) => b.id !== 'run_box' && b.id !== 'sib_h') }), 'a.py::run', 100), null, 'the other-file handle alone never lands it');
  assert.equal(landingFor(idx, 'a.py::Q.run', 300).box, 'q_run', 'a method\'s short name "run" is no match for the handle of a box in another file, and the ending goes last');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('join review: ends-elsewhere is asked when the row names a function, never when the row names a box with `to`', () => {
  const { dir, facts, model } = entryProject();
  hand(dir, [{ from: 'q_run', toSymbol: 'a.py::proc', when: 'W1', why: 'x', to: 'proc_end' }, { from: 'q_run', to: 'q_end', when: 'W2', why: 'x' }, { from: 'q_run', toSymbol: 'a.py::Q.run', toLine: 311, when: 'W3', why: 'x' }]);
  const r = joinHandoffs(dir, model, facts);
  assert.deepEqual(r.review.map((x) => `${x.to}:${x.reason}`), [], 'two explicit `to` rows onto another stage\'s ending, and a toSymbol that lands on a non-ending: no question');
  assert.equal(r.routes, 2, 'the third row lands on the box it leaves from, so no road is drawn');
  const bare = { ...model, boxes: model.boxes.filter((b) => !['proc_entry', 'proc_inner'].includes(b.id)) };
  hand(dir, [{ from: 'q_run', toSymbol: 'a.py::proc', toLine: 55, when: 'W4', why: 'x' }]);
  const r2 = joinHandoffs(dir, bare, facts);
  assert.deepEqual(r2.review.map((x) => x.reason), ['ends-elsewhere'], 'a function named by code that lands on another stage\'s ending is still asked about');
  fs.rmSync(dir, { recursive: true, force: true });
});
