// propose on a big map (call sites, holders, filters, islands first), analyze --stage / --all / --full and declared-never-produced seeing
// assignments, part names (W-part-name and `faultline parts`), impact on an ending, place progress and --prune. Hand-built systems and a copy of the toy.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { propose, pickHints, analyze, validateModel } from '../src/model/index.mjs';
import { partNameWarnings } from '../src/model/partnames.mjs';
import { chartsFromModel } from '../src/build/charts.mjs';
import { agentData } from '../src/agent/index.mjs';
import * as C from '../src/agent/commands.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), BIN = path.join(ROOT, 'bin', 'faultline.mjs'), TOY = path.join(ROOT, 'examples', 'toy', '.faultline');
const cli = (args, dir) => { const r = spawnSync(process.execPath, [BIN, ...args, '--project', dir], { encoding: 'utf8', timeout: 240000 }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const fnRec = (p, qual, line, end, extra = {}) => [`${p}::${qual}`, { path: p, qual, line, end, calls: [], unresolved: [], branches: [], returns: [], raises: [], excepts: [], loops: [], ...extra }];
const box = (id, stage, kind, p, qual, line, extra = {}) => ({ id, stage, kind, status: 'live', title: `Box ${id}`, plain: 'x', refs: [{ path: p, symbol: `${p}::${qual}`, line }], ...(kind === 'end' ? { outcome: 'failure' } : {}), ...extra });
const road = (id, from, to, when = 'then', type = 'forward') => ({ id, from, to, type, when });
const mk = (boxes, routes, extra = {}) => ({ schema: 'faultline.model/1', system: { name: 'T' }, stages: [{ id: 's1', title: 'One', order: 1 }, { id: 's2', title: 'Two', order: 2 }, { id: 's3', title: 'Three', order: 3 }], boxes, routes, paths: [], loops: [], terms: [], ledger: {}, modules: {}, ...extra });

// ---------------------------------------------------------------------------------------------------------------- propose
function callGraph() {
  const facts = { modules: [], entries: [], functions: Object.fromEntries([
    fnRec('a.py', 'run', 1, 60, { calls: ['b.py::helper', 'c.py::other'], callAt: [[0, 12], [1, 45]], branches: [{ line: 10, kind: 'if', test: 'ready' }, { line: 44, kind: 'if', test: 'wanted' }] }),
    fnRec('a.py', 'run2', 61, 120, { calls: ['b.py::helper'], callAt: [[0, 70]] }),
    fnRec('b.py', 'helper', 1, 20), fnRec('c.py', 'other', 1, 30), fnRec('d.py', 'lonely', 1, 10), fnRec('e.py', 'util', 1, 10, { calls: ['d.py::lonely'], callAt: [[0, 5]] })]) };
  const graph = { callEdges: [['a.py::run', 'b.py::helper'], ['a.py::run', 'c.py::other'], ['a.py::run2', 'b.py::helper'], ['e.py::util', 'd.py::lonely']], hubs: [], importEdges: [], clusters: [], depth: {} };
  // A and A2 cite run at lines 5 and 40: the call to helper at line 12 is A's, the call to other at line 45 is A2's
  const model = mk([box('A', 's1', 'step', 'a.py', 'run', 5), box('A2', 's1', 'step', 'a.py', 'run', 40), box('R', 's1', 'step', 'a.py', 'run2', 61),
    box('H', 's2', 'step', 'b.py', 'helper', 1), box('C', 's2', 'step', 'c.py', 'other', 1), box('D', 's3', 'step', 'd.py', 'lonely', 1)], [road('r1', 'A', 'A2'), road('r2', 'A2', 'R')]);
  return { facts, graph, model };
}
const unlimited = { maxRoutes: Infinity, perBox: Infinity };

test('propose: every hint carries its call site and the box that holds it; a call seen from a box that does not hold it is left out', () => {
  const { facts, graph, model } = callGraph();
  const p = propose(model, facts, graph, null, unlimited);
  assert.deepEqual(p.routes.map((r) => `${r.from}>${r.to}`), ['A>H', 'A2>C', 'R>H'], 'islands first; then the call-graph distance; then box order');
  const ah = p.routes[0];
  assert.equal(ah.site.at, 'a.py:12'); assert.equal(ah.site.lineKnown, true); assert.equal(ah.site.fn, 'run'); assert.equal(ah.holder.box, 'A');
  assert.equal(p.routes[1].site.at, 'a.py:45'); assert.equal(p.routes[1].holder.box, 'A2', 'line 45 is below the cited line 40');
  assert.deepEqual(ah.conditionHints.map((h) => h.text), ['ready', 'wanted'], 'the test above the call comes first');
  assert.deepEqual(p.routes[1].conditionHints[0].text, 'wanted', 'the nearest test above line 45');
  assert.ok(p.routes.every((r) => r.intoNoWayIn && r.crossStage));
  assert.ok(p.counts.sameCallElsewhere >= 1, 'A calling C at line 45 is the call A2 holds: not a second hint');
  const none = propose(model, { ...facts, functions: Object.fromEntries(Object.entries(facts.functions).map(([k, v]) => { const { callAt, ...rest } = v; return [k, rest]; })) }, graph, null, unlimited);
  assert.equal(none.routes[0].site.lineKnown, false, 'without recorded call lines the hint says so instead of inventing one');
});

test('propose --stage / --cross-stage / --into-islands / --limit / --offset', () => {
  const { facts, graph, model } = callGraph();
  const p = propose(model, facts, graph, null, unlimited), all = pickHints(p.routes, {});
  assert.deepEqual([all.total, all.matched, all.shown.length], [3, 3, 3]);
  assert.equal(pickHints(p.routes, { stage: 's3' }).matched, 0); assert.equal(pickHints(p.routes, { stage: 's2' }).matched, 3);
  assert.equal(pickHints(p.routes, { crossStage: true }).matched, 3); assert.equal(pickHints(p.routes, { intoIslands: true }).matched, 3);
  const page = pickHints(p.routes, { limit: 2 }), rest = pickHints(p.routes, { limit: 2, offset: 2 });
  assert.deepEqual([page.shown.length, page.matched, rest.shown.length], [2, 3, 1]);
  assert.equal(pickHints(p.routes, { limit: 0 }).shown.length, 3, 'limit 0 is all');
  // a box that already has a road in is not an island target
  const m2 = { ...model, routes: [...model.routes, road('r3', 'D', 'H')] };
  const q = pickHints(propose(m2, facts, graph, null, unlimited).routes, { intoIslands: true });
  assert.ok(q.shown.every((r) => r.to !== 'H') && q.matched === 1);
});

test('propose: a box nothing leads to and no box calls is listed with its direct callers, so nobody writes a call-graph script', () => {
  const { facts, graph, model } = callGraph();
  const p = propose(model, facts, graph, null, unlimited), d = p.noWayInNoHint.find((b) => b.box === 'D');
  assert.ok(d, 'D has no road in and no hint');
  assert.equal(d.callerCount, 1);
  assert.deepEqual({ fn: d.callers[0].fn, at: d.callers[0].at, boxes: d.callers[0].boxes }, { fn: 'e.py::util', at: 'e.py:5', boxes: [] }, 'the caller, the call line, and that no box cites it');
  assert.ok(p.counts.noWayIn >= 4 && p.counts.noWayInNoHint >= 1);
  assert.ok(!p.noWayInNoHint.some((b) => b.box === 'H'), 'H has hints');
});

test('propose on the command line: a count line, then the top N with the call site; flags are accepted', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-prop-')), '.faultline');
  fs.mkdirSync(path.join(dir, 'model'), { recursive: true });
  for (const f of ['facts.json', 'census.json', 'graph.json', 'config.json']) fs.copyFileSync(path.join(TOY, f), path.join(dir, f));
  for (const f of fs.readdirSync(path.join(TOY, 'model'))) fs.copyFileSync(path.join(TOY, 'model', f), path.join(dir, 'model', f));
  for (const args of [[], ['--limit', '2'], ['--cross-stage'], ['--into-islands', '--limit', '3'], ['--stage', 's_work', '--offset', '1']]) {
    const r = cli(['propose', ...args], dir);
    assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /^propose: \d+ route hints/); assert.match(r.out, /\nHINTS (none|\d+-\d+) of \d+/);
  }
  assert.equal(cli(['propose', '--limit', 'x'], dir).code, 2);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------- analyze
const sigs = (produced) => ({ schema: 'faultline.signals/1', pairs: [], fieldWrites: {}, sticky: [], lostWakeup: [], neverSent: [], emptyHandlers: [], swallowed: [], ...(produced ? { produced } : {}) });
function declared(returns = []) {
  const facts = { modules: [], entries: [], functions: Object.fromEntries([fnRec('a.py', 'f', 1, 9, { returns })]) };
  const model = mk([box('a', 's1', 'step', 'a.py', 'f', 1), box('beta', 's1', 'end', 'a.py', 'f', 5, { handle: 'beta_value' })], [road('r1', 'a', 'b0')].slice(0, 0));
  const census = { schema: 'faultline.census/1', outcomeTypes: [{ name: 'Kind', source: 'enum', path: 'a.py', line: 3, values: ['alpha_value', 'beta_value'] }], endings: [], branches: [], passes: [], switches: [], counts: {} };
  return { facts, model, census };
}
const dnp = (w, signals) => analyze(w.model, w.facts, w.census, null, { signals }).filter((f) => f.check === 'declared-never-produced');

test('declared-never-produced sees values produced by assignment, dict or return literal; where it cannot look, it says so', () => {
  const w = declared();
  const none = dnp(w, null);
  assert.equal(none.length, 1);
  assert.match(none[0].evidence, /Assignments and dict literals were not searched/, 'no signals.json: the candidate stays and says what was not searched');
  const searched = dnp(w, sigs({ other_value: { n: 1, at: ['x.py:1'] } }));
  assert.equal(searched.length, 1);
  assert.match(searched[0].evidence, /Return literals and the string values signals.json saw assigned, put in a dict or returned, were searched: none match/);
  assert.equal(dnp(w, sigs({ beta_value: { n: 2, at: ['x.py:9', 'x.py:20'] } })).length, 0, 'signals.json saw "beta_value" assigned somewhere: produced');
  assert.equal(dnp(declared([{ line: 6, expr: '{"status": "beta_value"}' }]), null).length, 0, 'a dict literal in a return');
  assert.equal(dnp(declared([{ line: 6, expr: 'Kind.BETA_VALUE' }]), null).length, 0, 'a member name in a return');
  assert.match(none[0].evidence.replace(/ (Assignments|Return literals).*(searched|not searched).*$/, ''), /^Kind declares "beta_value"/, 'the threshold is the same: it only sees more');
});

test('analyze --all lists a line per candidate, --full lists every field, --stage keeps one stage', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-an-')), '.faultline');
  fs.mkdirSync(path.join(dir, 'model'), { recursive: true });
  for (const f of ['facts.json', 'census.json', 'graph.json', 'config.json']) fs.copyFileSync(path.join(TOY, f), path.join(dir, f));
  for (const f of fs.readdirSync(path.join(TOY, 'model'))) fs.copyFileSync(path.join(TOY, 'model', f), path.join(dir, 'model', f));
  const all = cli(['analyze', '--all'], dir), full = cli(['analyze', '--all', '--full'], dir);
  assert.equal(all.code, 0, all.out + all.err);
  const keyLines = (s) => s.split('\n').filter((l) => /^  [a-z-]+:/.test(l));
  assert.ok(keyLines(all.out).length > 0, 'the toy has candidates');
  assert.equal(keyLines(all.out).length, keyLines(full.out).length, 'the same candidates');
  assert.ok(!/^    \? /m.test(all.out), 'one line each: no question lines');
  assert.ok(/^    \? /m.test(full.out), '--full keeps the question and the evidence');
  assert.ok(all.out.length < full.out.length);
  const stage = cli(['analyze', '--all', '--stage', 's_work'], dir);
  assert.equal(stage.code, 0, stage.out + stage.err); assert.match(stage.out, /^analyze --stage s_work: \d+ of \d+ listed/);
  assert.ok(keyLines(stage.out).length <= keyLines(all.out).length);
  assert.equal(cli(['analyze', '--stage', 's_nowhere'], dir).code, 2);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------- part names
// 30 boxes in a chain: one stage above 21 boxes is cut into two parts
function chain(names = {}, extra = {}) {
  const ids = Array.from({ length: 30 }, (_, i) => `b${String(i + 1).padStart(2, '0')}`);
  const boxes = ids.map((id) => box(id, 's1', 'step', 'a.py', `f${id}`, 1)), routes = ids.slice(1).map((id, i) => road(`r${i}`, ids[i], id));
  return mk(boxes, routes, { partNames: names, ...extra });
}

test('part names: the same name twice in a stage is flagged W-part-name, named for what is wrong; a name given to boxes in two parts; two names in one part; a stale key', () => {
  const same = chain({ b01: 'Same name', b30: 'Same name' });
  const charts = chartsFromModel(same).filter((c) => c.kind === 'stage');
  assert.ok(charts.length >= 2, 'a chain of 30 boxes is cut into parts');
  const last = charts[charts.length - 1];
  assert.equal(charts[0].name, 'Same name'); assert.equal(last.name, `Same name (${charts.length})`, 'the page numbers the second use of the name');
  assert.equal(last.nameDup, 'Same name'); assert.equal(charts[0].nameBox, 'b01'); assert.equal(last.nameBox, 'b30');
  let w = partNameWarnings(same, chartsFromModel(same));
  assert.equal(w.length, 1); assert.equal(w[0].code, 'W-part-name');
  assert.match(w[0].msg, new RegExp(`stage_s1_1 and stage_s1_${charts.length} of stage s1 are both named "Same name"`));
  assert.equal(w[0].at, last.entry, 'at is a box of the part, so check --stage sees it');
  // a name that follows boxes into two parts, winning in only one of them
  const spread = chain({ b01: 'A', b29: 'B', b30: 'A' });
  w = partNameWarnings(spread, chartsFromModel(spread));
  assert.ok(w.some((x) => /the name "A" is given to boxes in 2 parts/.test(x.msg)), w.map((x) => x.msg).join('|'));
  // one part, two names
  const two = chain({ b01: 'First', b02: 'Second' });
  w = partNameWarnings(two, chartsFromModel(two));
  assert.ok(w.some((x) => /named "First" by box b01 and also "Second" by box b02/.test(x.msg)));
  const stale = chain({ gone: 'Nothing' });
  assert.ok(partNameWarnings(stale, chartsFromModel(stale)).some((x) => /names box gone, which is not in the model/.test(x.msg)));
  assert.equal(partNameWarnings(chain({ b01: 'One', b30: 'Two' }), chartsFromModel(chain({ b01: 'One', b30: 'Two' }))).length, 0, 'distinct names: nothing to say');
  // the gate carries them as warnings, never refusals, and only when charts are passed
  const facts = { modules: [], entries: [], functions: {} };
  assert.ok(!validateModel(same, facts, null, {}).warnings.some((x) => x.code === 'W-part-name'));
  const v = validateModel(same, facts, null, { charts: chartsFromModel(same) });
  assert.ok(v.warnings.some((x) => x.code === 'W-part-name') && !v.refusals.some((x) => x.code === 'W-part-name'));
});

test('faultline parts: what each part holds (functions, first boxes), where its name came from, and the names that mislead', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-parts-')), '.faultline');
  fs.mkdirSync(path.join(dir, 'model'), { recursive: true });
  const m = chain({ b01: 'Same name', b30: 'Same name' });
  fs.writeFileSync(path.join(dir, 'model', '00-system.json'), JSON.stringify(m));
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify({ root: dir, modules: [{ path: 'a.py', lines: 10 }], functions: {}, entries: [] }));
  fs.writeFileSync(path.join(dir, 'census.json'), JSON.stringify({ schema: 'faultline.census/1', outcomeTypes: [], endings: [], branches: [], passes: [], switches: [], counts: {} }));
  const r = cli(['parts'], dir);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /stage_s1_1  "Same name"  \(\d+ boxes, \d+ routes\)/);
  assert.match(r.out, /name: given by box b01 \(the part's first box\)/);
  assert.match(r.out, /holds: fb\d\d 1, /);
  assert.match(r.out, /starts: b01 "Box b01" > b02/);
  assert.match(r.out, /! the name "Same name" is also another part's in this stage; this one shows as "Same name \(\d+\)"/);
  assert.match(r.out, /W-part-name 1:/);
  assert.equal(cli(['parts', '--stage', 's_none'], dir).code, 2);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------- impact on an ending
test('impact on an end box says who it hands back to and what that caller does next; an ending with no road out says it stops', () => {
  const m = mk([box('c', 's1', 'step', 'a.py', 'f', 1), box('g', 's2', 'step', 'a.py', 'g', 1), box('e', 's2', 'end', 'a.py', 'g', 9), box('n', 's1', 'step', 'a.py', 'f', 20), box('z', 's2', 'end', 'a.py', 'g', 30)],
    [road('r1', 'c', 'g', 'Call it'), road('r2', 'g', 'e', 'It failed'), road('r3', 'e', 'c', 'Back to the caller', 'return'), road('r4', 'c', 'n', 'It came back'), road('r5', 'g', 'z', 'It worked')]);
  const d = agentData(m, {}), out = C.impact(d, 'e');
  assert.match(out, /^IMPACT e/);
  assert.match(out, /HANDS BACK to c "Box c" \(1 return road\)/);
  assert.match(out, /THE CALLER THEN: c goes on to g \(Call it\), n \(It came back\)/);
  assert.match(C.impact(d, 'z'), /STOPS HERE: no road leaves this ending/);
  assert.ok(!/HANDS BACK|STOPS HERE/.test(C.impact(d, 'c')), 'only for an ending');
});

// ---------------------------------------------------------------------------------------------------------------- place: progress and stale layouts
test('place: a line per chart, and layouts of an earlier partition are listed as stale and removed only with --prune', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-place-')), '.faultline');
  fs.mkdirSync(path.join(dir, 'model'), { recursive: true });
  for (const f of ['facts.json', 'census.json', 'graph.json', 'config.json']) fs.copyFileSync(path.join(TOY, f), path.join(dir, f));
  for (const f of fs.readdirSync(path.join(TOY, 'model'))) fs.copyFileSync(path.join(TOY, 'model', f), path.join(dir, 'model', f));
  fs.mkdirSync(path.join(dir, 'layout'), { recursive: true });
  const old = ['stage_work_7.json', 'stage_work_7.geom.json', 'stage_elsewhere_3.json'].map((f) => path.join(dir, 'layout', f));
  for (const f of old) fs.writeFileSync(f, '{}');
  let r = cli(['place', '--stage', 's_work', '--budget', '2'], dir);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /\[1\/1\] stage_work: placing/);
  assert.match(r.out, /STALE: 1 layout file in .*layout\/ belong to no chart now \(an earlier partition\): stage_work_7\. faultline place --prune removes them/);
  assert.ok(old.every((f) => fs.existsSync(f)), 'nothing is deleted without the flag');
  r = cli(['place', '--stage', 's_work', '--budget', '2', '--prune'], dir);
  assert.match(r.out, /pruned 1 stale layout \(no chart has these names now\): stage_work_7/);
  assert.ok(!fs.existsSync(old[0]) && !fs.existsSync(old[1]), 'the layout and its geometry cache are gone');
  assert.ok(fs.existsSync(old[2]), 'another stage\'s stale file is not touched by --stage');
  r = cli(['place', '--budget', '2'], dir);
  assert.match(r.err, /placing \d+ charts: a line as each starts and ends/);
  assert.match(r.out, /STALE: 1 layout file.*stage_elsewhere_3/);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});
