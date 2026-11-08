// Tests for src/model: loadModel, validateModel (every gate, exact refusal text), analyze, propose, receipts.
// Small invented systems cover each rule on its own; examples/toy covers the whole thing end to end.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadModel, loadModelReport, mergeFragments, validateModel, analyze, groupFindings, propose, makeReceipts, writeReceipts,
  checkProject, ModelRefusal, hasBannedWord, plainWords,
} from '../src/model/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOY = path.resolve(here, '../examples/toy');
// the toy as the model tests describe it: no ledger fragment, no dismissed.json (the shipped toy has both, so 'check --finished' passes)
const BARE = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-toybare-'));
  fs.mkdirSync(path.join(d, 'model'));
  for (const n of fs.readdirSync(path.join(TOY, '.faultline/model'))) if (!/^90-/.test(n)) fs.copyFileSync(path.join(TOY, '.faultline/model', n), path.join(d, 'model', n));
  return d;
})();
const produced = [];                                                 // every sentence the tool wrote, swept for banned words at the end
const note = (...xs) => { for (const x of xs.flat()) if (typeof x === 'string') produced.push(x); };
const noteFindings = (fs_) => { for (const f of fs_) note(f.question, f.evidence); return fs_; };
const noteRes = (v) => { for (const r of [...v.refusals, ...v.gaps.items, ...v.warnings]) note(r.msg); return v; };
const REFUSE_SHAPE = /^REFUSE [A-Z]\d [^:]+: .+\. Fix: .+\.$/;

// ---- a small invented system -------------------------------------------------------------------------------------
const fn = (p, qual, line, end, extra = {}) => [`${p}::${qual}`, { path: p, qual, line, end, calls: [], branches: [], returns: [], raises: [], excepts: [], loops: [], retryHints: [], ...extra }];
function mkFacts(fns, mods = null, extra = {}) {
  const functions = Object.fromEntries(fns);
  const paths = [...new Set(Object.values(functions).map((f) => f.path))];
  return { schema: 'faultline.facts/1', root: '.', pin: { git: null, tree: 't' }, modules: (mods || paths).map((p) => ({ path: p, lang: 'py', lines: 200, imports: [] })), functions, entries: [], switches: [], enums: [], ...extra };
}
const ref = (p, qual, line) => ({ path: p, symbol: `${p}::${qual}`, line });
const mkBox = (id, over = {}) => ({ id, stage: 's1', kind: 'step', title: id, plain: `${id} does its thing`, status: 'live', refs: [ref('a.py', 'f', 5)], ...over });
const mkRoute = (id, from, to, when = 'If ok', over = {}) => ({ id, from, to, type: 'forward', when, why: '', refs: [], inferred: false, ...over });
const mkModel = (boxes, routes, extra = {}) => ({ schema: 'faultline.model/1', system: { name: 'mini' }, stages: [{ id: 's1', title: 'One', order: 1 }], boxes, routes, loops: [], paths: [], charts: [], terms: [], ledger: {}, modules: {}, ...extra });
const baseFacts = () => mkFacts([fn('a.py', 'f', 1, 40), fn('a.py', 'g', 41, 80), fn('b.py', 'h', 1, 30)]);
const codes = (v) => v.refusals.map((r) => r.code);
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `faultline-${name}-`));
const writeFrag = (dir, name, obj) => { fs.mkdirSync(path.join(dir, 'model'), { recursive: true }); fs.writeFileSync(path.join(dir, 'model', name), typeof obj === 'string' ? obj : JSON.stringify(obj)); };

// ---- loadModel ----------------------------------------------------------------------------------------------------
test('loadModel merges the toy fragments in filename order', () => {
  const m = loadModel(BARE);
  assert.equal(m.boxes.length, 35);
  assert.equal(m.routes.length, 47);
  assert.equal(m.stages.length, 5);
  assert.equal(m.system.name, 'Parcelworks');
  assert.deepEqual(m.fragments, ['00-system.json', '10-intake.json', '20-queue.json', '30-work.json', '40-trouble.json', '50-report.json', '96-heard.json']);
  assert.equal(m.boxes[0].id, 'web.submit');                         // 10-intake comes before 20-queue
  assert.equal(m.sources.boxes['work.lease_lost'], '30-work.json');
});

test('loadModel refuses a duplicate id and names both files', () => {
  const d = tmp('dup');
  writeFrag(d, '10-a.json', { schema: 'faultline.model/1', boxes: [mkBox('x.one'), mkBox('x.two')] });
  writeFrag(d, '20-b.json', { schema: 'faultline.model/1', boxes: [mkBox('x.one')], routes: [mkRoute('r1', 'x.one', 'x.two')] });
  assert.throws(() => loadModel(d), (e) => {
    assert.ok(e instanceof ModelRefusal);
    assert.equal(e.refusals[0].code, 'G4');
    assert.match(e.refusals[0].msg, REFUSE_SHAPE);
    assert.match(e.refusals[0].msg, /duplicate box id: "x\.one" is defined in 10-a\.json and again in 20-b\.json/);
    return true;
  });
  const rep = loadModelReport(d);                                    // the non-throwing form hands back the same records
  assert.equal(rep.refusals.length, 1);
  assert.equal(rep.model.boxes.length, 3);
});

test('loadModel refuses bad JSON, a wrong schema and an empty folder', () => {
  const d = tmp('bad');
  writeFrag(d, '10-a.json', '{ not json');
  writeFrag(d, '20-b.json', { schema: 'faultline.model/9', boxes: [] });
  const r = loadModelReport(d).refusals;
  assert.deepEqual(r.map((x) => x.code), ['F1', 'F1']);
  assert.match(r[0].msg, /fragment is not valid JSON: 10-a\.json/);
  assert.match(r[1].msg, /wrong schema: 20-b\.json says "faultline\.model\/9"/);
  const empty = tmp('empty');
  assert.match(loadModelReport(empty).refusals[0].msg, /no model fragments found/);
});

test('mergeFragments: ledger and module keys refuse unless identical; terms compare without case; empty never wipes', () => {
  const frag = (file, data) => ({ file, data: { schema: 'faultline.model/1', ...data } });
  const same = mergeFragments([frag('a', { ledger: { 'end:x:0': { box: 'b' } } }), frag('b', { ledger: { 'end:x:0': { box: 'b' } } })]);
  assert.equal(same.refusals.length, 0);
  const diff = mergeFragments([frag('a', { ledger: { 'end:x:0': { box: 'b' } } }), frag('b', { ledger: { 'end:x:0': { box: 'c' } } })]);
  assert.match(diff.refusals[0].msg, /duplicate ledger row id: "end:x:0"/);
  const terms = mergeFragments([frag('a', { terms: [{ term: 'Lease' }] }), frag('b', { terms: [{ term: 'lease' }] })]);
  assert.match(terms.refusals[0].msg, /duplicate term id: "lease"/);
  const sys = mergeFragments([frag('a', { system: { name: 'One', purpose: 'p' } }), frag('b', { system: { name: '', tagline: 't' } })]);
  assert.equal(sys.model.system.name, 'One');
  assert.equal(sys.model.system.tagline, 't');
  const over = mergeFragments([frag('a', { system: { name: 'One' } }), frag('b', { system: { name: 'Two' } })]);
  assert.equal(over.model.system.name, 'Two');
});

test('merging is order-stable: plain code-point order, 10 before 2', () => {
  const d = tmp('order');
  writeFrag(d, '2-late.json', { boxes: [mkBox('late')] });
  writeFrag(d, '10-early.json', { boxes: [mkBox('early')] });
  assert.deepEqual(loadModel(d).boxes.map((b) => b.id), ['early', 'late']);
});

// ---- hard gates: exact text ---------------------------------------------------------------------------------------
const hard = (model, facts = baseFacts(), census = null, opts = {}) => noteRes(validateModel(model, facts, census, opts));

test('a clean small model passes every always-hard gate', () => {
  const m = mkModel([mkBox('a'), mkBox('b')], [mkRoute('r1', 'a', 'b')]);
  const v = hard(m);
  assert.equal(v.ok, true);
  assert.deepEqual(v.refusals, []);
  assert.equal(v.gaps.state, 'draft');
});

test('G1 cited symbol missing: exact text, nearest hint, every offender kept', () => {
  const m = mkModel([mkBox('a', { refs: [ref('a.py', 'gg', 5)] }), mkBox('b', { refs: [ref('a.py', 'nope_at_all', 5)] })], [mkRoute('r1', 'a', 'b')]);
  const v = hard(m);
  const r = v.refusals.find((x) => x.code === 'G1');
  assert.equal(r.msg, 'REFUSE G1 cited symbol missing from facts: box a cites a.py::gg (and 1 more). Fix: use a symbol that facts.json lists (nearest: a.py::g), or drop the ref.');
  assert.deepEqual(r.offenders, ['a', 'b']);
  assert.equal(r.at, 'a');
});

test('G1 cited line outside the function, a path that disagrees with its symbol, and refs on routes and terms', () => {
  const m = mkModel([mkBox('a', { refs: [ref('a.py', 'f', 90)] }), mkBox('b', { refs: [{ path: 'b.py', symbol: 'a.py::f', line: 3 }] })],
    [mkRoute('r1', 'a', 'b', 'If ok', { refs: [ref('a.py', 'zzz', 3)] })], { terms: [{ term: 'T', meaning: 'm', refs: [ref('a.py', 'f', 999)] }] });
  const v = hard(m);
  const msgs = v.refusals.filter((r) => r.code === 'G1').map((r) => r.msg);
  assert.ok(msgs.some((s) => /cited line outside its function: box a cites a\.py::f at line 90, but that function spans 1-40/.test(s)));
  assert.ok(msgs.some((s) => /cited path does not match its symbol: box b cites path b\.py but a\.py::f lives in a\.py/.test(s)));
  assert.ok(msgs.some((s) => /cited symbol missing from facts: route r1 cites a\.py::zzz/.test(s)));
  const lineRefusal = v.refusals.find((r) => /cited line outside its function/.test(r.msg));
  assert.deepEqual(lineRefusal.offenders, ['a', 'T']);               // the term's ref is held to the same rule, named after the first offender
  assert.match(lineRefusal.msg, /\(and 1 more\)/);
  for (const s of msgs) assert.match(s, REFUSE_SHAPE);
});

test('G1 with no facts at all says so; a path-only ref is checked against the module', () => {
  const m = mkModel([mkBox('a')], []);
  assert.match(validateModel(m, null, null).refusals[0].msg, /^REFUSE G1 no facts to check against: facts\.json is missing\. Fix: run faultline extract first\.$/);
  const ok = mkModel([mkBox('a', { refs: [{ path: 'a.py', line: 10 }] })], []);
  assert.equal(hard(ok).ok, true);
  const bad = mkModel([mkBox('a', { refs: [{ path: 'zz.py', line: 10 }] })], []);
  assert.match(hard(bad).refusals[0].msg, /cited path missing from facts: box a cites zz\.py/);
});

test('G2 box without refs', () => {
  const m = mkModel([mkBox('a'), mkBox('b', { refs: [] }), mkBox('c', { refs: undefined })], []);
  const r = hard(m).refusals.find((x) => x.code === 'G2');
  assert.equal(r.msg, 'REFUSE G2 box without refs: box b cites no code (and 1 more). Fix: add refs with at least one symbol from facts.json that shows the box is real.');
});

test('G3 dangling route, dangling stage, path member and ledger row', () => {
  const m = mkModel([mkBox('a'), mkBox('b', { stage: 'nowhere' })], [mkRoute('r1', 'a', 'ghost')], { paths: [{ id: 'main', boxes: ['a', 'zed'] }], ledger: { 'end:x:0': { box: 'phantom' } } });
  const msgs = hard(m).refusals.filter((r) => r.code === 'G3').map((r) => r.msg);
  assert.ok(msgs.includes('REFUSE G3 dangling route: route r1 has to "ghost", which is not a box. Fix: point the route at box ids that exist, or add the box.'));
  assert.ok(msgs.some((s) => /dangling stage: box b sits in stage "nowhere"/.test(s)));
  assert.ok(msgs.some((s) => /dangling path member: path main lists box "zed"/.test(s)));
  assert.ok(msgs.some((s) => /dangling ledger row: ledger row end:x:0 points at box "phantom"/.test(s)));
});

test('G4 duplicate id inside one model object', () => {
  const m = mkModel([mkBox('a'), mkBox('a')], [mkRoute('r1', 'a', 'a'), mkRoute('r1', 'a', 'a')]);
  const msgs = hard(m).refusals.filter((r) => r.code === 'G4').map((r) => r.msg);
  assert.equal(msgs[0], 'REFUSE G4 duplicate box id: "a" is used by two boxes. Fix: give every box its own id; ids are never reused for a different thing.');
  assert.match(msgs[1], /duplicate route id: "r1"/);
});

test('G5 empty when out of a box with 2+ exits only', () => {
  const m = mkModel([mkBox('a'), mkBox('b'), mkBox('c')], [mkRoute('r1', 'a', 'b', ''), mkRoute('r2', 'a', 'c', 'If late'), mkRoute('r3', 'b', 'c', '')]);
  const r = hard(m).refusals.filter((x) => x.code === 'G5');
  assert.equal(r.length, 1);
  assert.equal(r[0].msg, 'REFUSE G5 route with no condition out of a box with several exits: route r1 leaves a (2 exits) with an empty "when". Fix: write the condition that sends flow down this road, such as "Queue empty", or "Otherwise" for the catch-all.');
  assert.deepEqual(r[0].offenders, ['r1']);                          // r3 leaves a single-exit box: allowed
});

test('K1 kind, status, end outcome and route type', () => {
  const m = mkModel([mkBox('a', { kind: 'blob' }), mkBox('b', { status: undefined }), mkBox('c', { kind: 'end' }), mkBox('d', { kind: 'end', outcome: 'success' })], [mkRoute('r1', 'a', 'b', 'If ok', { type: 'sideways' })]);
  const msgs = hard(m).refusals.filter((x) => x.code === 'K1').map((x) => x.msg);
  assert.equal(msgs.length, 4);
  assert.match(msgs[0], /^REFUSE K1 box without a valid kind: box a has kind "blob"\. Fix: set kind to one of step, decision, wait, end, store, external, gate\.$/);
  assert.ok(msgs.some((s) => /box without a valid status: box b/.test(s)));
  assert.ok(msgs.some((s) => /end box without an outcome: box c/.test(s)));
  assert.ok(msgs.some((s) => /route without a valid type: route r1 has type "sideways"/.test(s)));
});

test('T1 limits: title 40, plain 260, when 28, and a description verb opening a when', () => {
  const m = mkModel([mkBox('a', { title: 'x'.repeat(41) }), mkBox('b', { title: 'y'.repeat(40), plain: 'z'.repeat(261) }), mkBox('c', { title: 'ok' })],
    [mkRoute('r1', 'a', 'b', 'w'.repeat(29)), mkRoute('r2', 'b', 'c', 'Checks the queue'), mkRoute('r3', 'a', 'c', 'Queue empty')]);
  const msgs = hard(m).refusals.filter((x) => x.code === 'T1').map((x) => x.msg);
  assert.ok(msgs.some((s) => /^REFUSE T1 title over the limit: box a title is 41 characters \(hard max 40\)\. Fix: cut words to 34 characters or fewer; put detail in plain\.$/.test(s)));
  assert.ok(msgs.some((s) => /plain text over the limit: box b plain is 261 characters \(max 260\)/.test(s)));
  assert.ok(msgs.some((s) => /route condition over the limit: route r1 when is 29 characters \(max 28\)/.test(s)));
  assert.ok(msgs.some((s) => /route condition reads as a description: route r2 when starts with "Checks"/.test(s)));
  assert.ok(!msgs.some((s) => /r3/.test(s)));
  const v = hard(mkModel([mkBox('a', { title: 'x'.repeat(36) })], []));       // 35..40 is a warning, not a refusal
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => w.code === 'W-title'));
});

test('L1 hard layout metrics, from metrics objects, geoms carrying metrics, or a metrics function', () => {
  const m = mkModel([mkBox('a')], []);
  const clean = { nodeOverlaps: 0, edgeThroughNode: 0, trackOverlaps: 0, labelOverlapsLabel: 0, labelOverlapsNode: 0, diagonalSegs: 0, shortArrowStubs: 0, labelMissing: 0 };
  assert.equal(hard(m, baseFacts(), null, { geoms: { overview: clean } }).ok, true);
  const v = hard(m, baseFacts(), null, { geoms: { overview: clean, s1: { metrics: { ...clean, edgeThroughNode: 2, labelMissing: 1 } } } });
  assert.equal(v.refusals[0].msg, 'REFUSE L1 layout has hard problems: chart s1 has edgeThroughNode=2, labelMissing=1. Fix: move or widen the cells in layout/<chart>.json (or re-run the placer) until every hard metric is 0.');
  const viaFn = hard(m, baseFacts(), null, { geoms: { whole: { nodes: [] } }, metrics: () => ({ ...clean, diagonalSegs: 3 }) });
  assert.match(viaFn.refusals[0].msg, /chart whole has diagonalSegs=3/);
  const unmeasured = hard(m, baseFacts(), null, { geoms: { whole: { nodes: [] } } });
  assert.equal(unmeasured.ok, true);
  assert.ok(unmeasured.warnings.some((w) => w.code === 'W-layout'));
});

// ---- finished-only gates: a refusal when finished, a printed gap in a draft ----------------------------------------
const census = (over = {}) => ({ schema: 'faultline.census/1', outcomeTypes: [], endings: [], branches: [], passes: [], switches: [], counts: {}, ...over });
const endRow = (n, value, conf = 'high', fnId = 'a.py::f', line = 10 + n) => ({ id: `end:${fnId}:${n}`, fn: fnId, line, kind: 'outcome', value, confidence: conf });
const brRow = (n, weight = 'decision') => ({ id: `branch:a.py::f:${n}`, fn: 'a.py::f', line: 10 + n, test: `x > ${n}`, weight });
const fin = (m, c, opts = {}, facts = mkFacts([fn('a.py', 'f', 1, 40)])) => noteRes(validateModel(m, facts, c, { finished: true, ...opts }));
const draft = (m, c, opts = {}, facts = mkFacts([fn('a.py', 'f', 1, 40)])) => noteRes(validateModel(m, facts, c, { finished: false, ...opts }));

test('B1 census ending or decision branch unaccounted: refusal when finished, gap in a draft', () => {
  const m = mkModel([mkBox('a'), mkBox('done', { kind: 'end', outcome: 'success' })], [mkRoute('r1', 'a', 'done')], { ledger: { 'end:a.py::f:0': { box: 'done' } } });
  const c = census({ endings: [endRow(0, 'ok'), endRow(1, 'bad'), endRow(2, 'meh', 'low')], branches: [brRow(0), brRow(1, 'trivial')] });
  const v = fin(m, c);
  const b1 = v.refusals.find((r) => r.code === 'B1');
  assert.equal(b1.msg, 'REFUSE B1 census rows not accounted in the ledger (2 of 3): ending end:a.py::f:1 (value "bad", a.py:11) (and 1 more). Fix: give each census row a ledger entry: {"box":id}, {"route":id}, {"merged":boxId,"why":"..."} or {"excluded":"why"}; faultline propose lists a suggested box for each.');
  assert.deepEqual(b1.offenders, ['end:a.py::f:1', 'branch:a.py::f:0']);   // the low ending and the trivial branch are not required
  const d = draft(m, c);
  assert.equal(d.refusals.some((r) => r.code === 'B1'), false);
  const gap = d.gaps.items.find((g) => g.code === 'B1');
  assert.ok(gap.msg.startsWith('GAP B1 census rows not accounted in the ledger (2 of 3)'));
  assert.equal(d.gaps.state, 'draft');
  assert.deepEqual(d.gaps.notDrawn.endings, { count: 1, ids: ['end:a.py::f:1'] });
  assert.deepEqual(d.gaps.tally.endings, { total: 3, required: 2, accounted: 1 });
  m.ledger['end:a.py::f:1'] = { excluded: 'a helper, not an ending' };
  m.ledger['branch:a.py::f:0'] = { route: 'r1' };
  assert.equal(fin(m, c).refusals.some((r) => r.code === 'B1'), false);
});

test('B1 with no census at all cannot be finished, and is a gap in a draft', () => {
  const m = mkModel([mkBox('a')], []);
  assert.equal(fin(m, null).refusals.find((r) => r.code === 'B1').msg, 'REFUSE B1 no census to account against: census.json is missing. Fix: run faultline extract first, then give every census row a ledger entry.');
  assert.ok(draft(m, null).gaps.items.some((g) => g.code === 'B1'));
});

test('B2 more than 8 merges into one box need a why on every row', () => {
  const rows = Array.from({ length: 9 }, (_, i) => endRow(i, `v${i}`));
  const ledger = Object.fromEntries(rows.map((r) => [r.id, { merged: 'done' }]));
  const m = mkModel([mkBox('a'), mkBox('done', { kind: 'end', outcome: 'success' })], [mkRoute('r1', 'a', 'done')], { ledger });
  const v = fin(m, census({ endings: rows }));
  const b2 = v.refusals.find((r) => r.code === 'B2');
  assert.equal(b2.msg, 'REFUSE B2 merges above 8 per box need a why on every row: box done merges 9 census rows and row end:a.py::f:0 has no why (and 8 more). Fix: write a "why" on each merged row saying what it shares with the box, or split the box so one box does not hide a subsystem.');
  for (const id of Object.keys(ledger)) ledger[id] = { merged: 'done', why: 'same terminal write' };
  assert.equal(fin(m, census({ endings: rows })).refusals.some((r) => r.code === 'B2'), false);
  const eight = rows.slice(0, 8);
  const m8 = mkModel([mkBox('a'), mkBox('done', { kind: 'end', outcome: 'success' })], [mkRoute('r1', 'a', 'done')], { ledger: Object.fromEntries(eight.map((r) => [r.id, { merged: 'done' }])) });
  assert.equal(fin(m8, census({ endings: eight })).refusals.some((r) => r.code === 'B2'), false);   // 8 is allowed bare
});

test('B2 exclusions above 25% of a census kind', () => {
  const rows = [0, 1, 2, 3].map((i) => endRow(i, `v${i}`));
  const m = mkModel([mkBox('a'), mkBox('done', { kind: 'end', outcome: 'success' })], [mkRoute('r1', 'a', 'done')],
    { ledger: { [rows[0].id]: { box: 'done' }, [rows[1].id]: { box: 'done' }, [rows[2].id]: { excluded: 'not an ending' }, [rows[3].id]: { excluded: 'also not' } } });
  const b2 = fin(m, census({ endings: rows })).refusals.find((r) => r.code === 'B2');
  assert.equal(b2.msg, 'REFUSE B2 exclusions above 25% of a census kind: 2 of 4 endings (50%) are excluded. Fix: draw the endings instead of excluding them, or merge them into boxes with a why; exclusions are for rows that truly do not matter.');
  m.ledger[rows[3].id] = { box: 'done' };                             // one in four is exactly 25%: allowed
  assert.equal(fin(m, census({ endings: rows })).refusals.some((r) => r.code === 'B2'), false);
});

test('M1 module neither cited nor excluded', () => {
  const facts = mkFacts([fn('a.py', 'f', 1, 40), fn('b.py', 'h', 1, 30)], ['a.py', 'b.py', 'c.py']);
  const m = mkModel([mkBox('a')], []);
  const v = fin(m, census(), {}, facts);
  const m1 = v.refusals.find((r) => r.code === 'M1');
  assert.equal(m1.msg, 'REFUSE M1 module neither cited nor excluded: b.py is cited by no box (and 1 more). Fix: cite it from a box ref, or add modules["b.py"] = {"excluded":"why"}.');
  m.modules = { 'b.py': { excluded: 'generated stubs' }, 'c.py': { excluded: '' } };
  const v2 = fin(m, census(), {}, facts);
  assert.deepEqual(v2.refusals.find((r) => r.code === 'M1').offenders, ['c.py']);   // an empty reason is not a reason
  assert.equal(draft(m, census(), {}, facts).gaps.items.find((g) => g.code === 'M1').msg.startsWith('GAP M1'), true);
});

test('S1 a straight list while the census has 10+ decision branches', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `n${i}`);
  const boxes = ids.map((id, i) => mkBox(id, i === 9 ? { kind: 'end', outcome: 'success' } : {}));
  const routes = ids.slice(0, 9).map((id, i) => mkRoute(`r${i}`, id, ids[i + 1], i ? 'If ok' : 'If ok'));
  const c = census({ branches: Array.from({ length: 10 }, (_, i) => brRow(i)) });
  const s1 = fin(mkModel(boxes, routes), c).refusals.find((r) => r.code === 'S1');
  assert.equal(s1.msg, 'REFUSE S1 the map is a straight list: 8 of 10 boxes (80%) have exactly one road in and one out, while the census has 10 decision branches. Fix: draw the refusals, retries, holds and other branches the census lists: a real system has boxes with several exits.');
  const nine = census({ branches: Array.from({ length: 9 }, (_, i) => brRow(i)) });
  assert.equal(fin(mkModel(boxes, routes), nine).refusals.some((r) => r.code === 'S1'), false);   // 9 decisions: not enough to call it
  const fanned = mkModel(boxes, [...routes, mkRoute('x1', 'n1', 'n9', 'If late'), mkRoute('x2', 'n2', 'n9', 'If early'), mkRoute('x3', 'n3', 'n9', 'If odd'), mkRoute('x4', 'n4', 'n9', 'If even'), mkRoute('x5', 'n5', 'n9', 'If big')]);
  assert.equal(fin(fanned, c).refusals.some((r) => r.code === 'S1'), false);
  assert.ok(draft(mkModel(boxes, routes), c).gaps.items.some((g) => g.code === 'S1'));
});

test('S2 no return route though the census has loops or retries', () => {
  const m = mkModel([mkBox('a'), mkBox('b')], [mkRoute('r1', 'a', 'b')]);
  const c = census({ passes: [{ id: 'pass:a.py::f:0', fn: 'a.py::f', line: 20, kind: 'retry', bounded: true, members: [] }] });
  assert.equal(fin(m, c).refusals.find((r) => r.code === 'S2').msg, 'REFUSE S2 no return route drawn: the census lists 1 loops or retries and no route has type "return". Fix: draw the road back for each loop or retry as a return route, and list it under loops with its limit.');
  m.routes.push(mkRoute('r2', 'b', 'a', 'If again', { type: 'return' }));
  assert.equal(fin(m, c).refusals.some((r) => r.code === 'S2'), false);
});

test('E1 fewer end boxes than distinct non-low outcome values', () => {
  const m = mkModel([mkBox('a'), mkBox('done', { kind: 'end', outcome: 'success' })], [mkRoute('r1', 'a', 'done')]);
  const c = census({ endings: [endRow(0, 'ok'), endRow(1, 'bad'), endRow(2, 'bad'), endRow(3, 'meh', 'low'), { ...endRow(4, 'X'), kind: 'raise' }] });
  assert.equal(fin(m, c).refusals.find((r) => r.code === 'E1').msg, 'REFUSE E1 fewer end boxes than outcome values in the census: 1 end boxes for 2 distinct outcome values (ok, bad). Fix: draw an end box for each way the system can finish, or merge values into one end box with a ledger why.');
  m.boxes.push(mkBox('bad', { kind: 'end', outcome: 'failure' }));
  assert.equal(fin(m, c).refusals.some((r) => r.code === 'E1'), false);
});

test('A1 a finding must be kept as a suspect or dismissed with a why', () => {
  const m = mkModel([mkBox('a'), mkBox('b')], [mkRoute('r1', 'a', 'b')]);
  const findings = [{ key: 'pile-up:a', question: 'q one?' }, { key: 'pile-up:b', question: 'q two?' }, { key: 'pile-up:c', question: 'q three?' }];
  const dismissed = { 'pile-up:b': { why: 'a queue by design', by: 'agent', at: 't' }, 'pile-up:c': { why: '  ' } };
  const v = fin(m, census(), { findings, dismissed });
  const a1 = v.refusals.find((r) => r.code === 'A1');
  assert.equal(a1.msg, 'REFUSE A1 finding unresolved: pile-up:a: q one? (and 1 more). Fix: mark it a suspect or dismiss it with a why in dismissed.json: {"<key>":{"why":"...","by":"...","at":"..."}} or {"<key>":{"suspect":true,"why":"..."}}.');
  assert.deepEqual(a1.offenders, ['pile-up:a', 'pile-up:c']);
  dismissed['pile-up:a'] = { suspect: true, why: 'confirmed by a run' };
  dismissed['pile-up:c'] = { why: 'wrapper only' };
  assert.equal(fin(m, census(), { findings, dismissed }).refusals.some((r) => r.code === 'A1'), false);
  assert.ok(draft(m, census(), { findings, dismissed: {} }).gaps.items.some((g) => g.code === 'A1'));
});

test('validateModel is deterministic and refuses the same way twice', () => {
  const m = mkModel([mkBox('a', { refs: [ref('a.py', 'gg', 5)] })], [mkRoute('r1', 'a', 'z')]);
  const one = JSON.stringify(validateModel(m, baseFacts(), null, { finished: true }));
  const two = JSON.stringify(validateModel(m, baseFacts(), null, { finished: true }));
  assert.equal(one, two);
});

// ---- analyze: one check at a time on small invented systems ---------------------------------------------------------
const an = (m, c = null, ov = null, facts = baseFacts(), opts = {}) => noteFindings(analyze(m, facts, c, ov, opts));
const of = (fs_, check) => fs_.filter((f) => f.check === check);
const keys = (fs_) => fs_.map((f) => f.key);
const END = { kind: 'end', outcome: 'success' };

test('pile-up: 4 roads in and at most 1 out; ends and drained stores are left alone', () => {
  const src = ['s1', 's2', 's3', 's4'].map((id) => mkBox(id));
  const m = mkModel([...src, mkBox('p'), mkBox('q', { kind: 'store' }), mkBox('z', END), mkBox('w', { kind: 'store' }), mkBox('back')],
    [...src.map((b, i) => mkRoute(`a${i}`, b.id, 'p')), mkRoute('o1', 'p', 'z', 'If done'),
      ...src.map((b, i) => mkRoute(`b${i}`, b.id, 'q')), mkRoute('o2', 'q', 'z', 'If drained'),
      ...src.map((b, i) => mkRoute(`c${i}`, b.id, 'w')), mkRoute('o3', 'w', 'back', 'If again', { type: 'return' })]);
  const f = of(an(m), 'pile-up');
  assert.deepEqual(keys(f), ['pile-up:p', 'pile-up:w']);             // q is a queue by design; z is an end
  assert.equal(f[0].question, '4 roads in, one road out: can that one exit take everything that arrives?');
  assert.equal(f[0].level, 'suspected');
  assert.deepEqual(f[0].boxes, ['p']);
  assert.equal(of(an(mkModel([...src, mkBox('p'), mkBox('z', END)], [...src.slice(0, 3).map((b, i) => mkRoute(`a${i}`, b.id, 'p')), mkRoute('o', 'p', 'z', 'If done')])), 'pile-up').length, 0);   // 3 in is not enough
});

test('hedged-route: a hedge word with no condition; a condition word saves it; empty is left to G5', () => {
  const m = mkModel([mkBox('a'), mkBox('b'), mkBox('c'), mkBox('d')], [
    mkRoute('r1', 'a', 'b', 'Might retry sometimes'), mkRoute('r2', 'a', 'c', 'Can run if idle'), mkRoute('r3', 'b', 'c', 'Possibly'),
    mkRoute('r4', 'c', 'd', ''), mkRoute('r5', 'd', 'a', 'Queue empty')]);
  const f = of(an(m), 'hedged-route');
  assert.deepEqual(keys(f), ['hedged-route:r1', 'hedged-route:r3']);
  assert.equal(f[0].question, 'The label "Might retry sometimes" hedges: what exact condition sends flow from a to b?');
});

test('no-way-out: a non-end box with nothing leaving; ends and external boundaries are fine', () => {
  const m = mkModel([mkBox('a'), mkBox('sink'), mkBox('z', END), mkBox('ext', { kind: 'external' })], [mkRoute('r1', 'a', 'sink', 'If bad'), mkRoute('r2', 'a', 'z', 'Otherwise'), mkRoute('r3', 'a', 'ext', 'If hand-off', { type: 'deliver' })]);
  const f = of(an(m), 'no-way-out');
  assert.deepEqual(keys(f), ['no-way-out:sink']);
  assert.equal(f[0].question, 'No road leaves sink and it is not marked as an ending: where does flow go next, or should it be an end box?');
});

test('no-way-in and unreached-from-start work against declared entries only', () => {
  const m = mkModel([mkBox('start'), mkBox('mid'), mkBox('z', END), mkBox('orphan'), mkBox('i1'), mkBox('i2'), mkBox('cli', { refs: [ref('a.py', 'g', 45)] })],
    [mkRoute('r1', 'start', 'mid', 'If ok'), mkRoute('r2', 'mid', 'z', 'Done'), mkRoute('r3', 'orphan', 'z', 'Done'), mkRoute('r4', 'i1', 'i2', 'If x'), mkRoute('r5', 'i2', 'i1', 'If y'), mkRoute('r6', 'cli', 'z', 'Done')],
    { paths: [{ id: 'main', boxes: ['start', 'mid', 'z'] }] });
  const facts = baseFacts(); facts.entries = [{ fn: 'a.py::g', kind: 'cli', why: 'command' }];
  const f = an(m, null, null, facts);
  assert.deepEqual(keys(of(f, 'no-way-in')).sort(), ['no-way-in:orphan']);       // cli has no road in but cites an entry; start opens a path
  assert.deepEqual(keys(of(f, 'unreached-from-start')), ['unreached-from-start:i1']);
  const none = analyze(mkModel([mkBox('a'), mkBox('b')], [mkRoute('r', 'a', 'b')]), baseFacts(), null);
  assert.equal(of(none, 'no-way-in').length, 0);
  assert.ok(none.notes.some((n) => /no declared entry/.test(n)));
});

test('no-limit-loop: empty limit, a limit the code contradicts, and a cycle no loop talks about', () => {
  const facts = mkFacts([fn('a.py', 'f', 1, 40, { loops: [{ line: 10, kind: 'while', bounded: false, why: 'while True with no break-by-count' }] }), fn('a.py', 'g', 41, 80), fn('b.py', 'h', 1, 30)]);
  const c = census({ passes: [{ id: 'pass:a.py::f:0', fn: 'a.py::f', line: 10, kind: 'loop', bounded: false, members: [] }, { id: 'pass:b.py::h:0', fn: 'b.py::h', line: 5, kind: 'loop', bounded: false, members: [] }] });
  const m = mkModel([mkBox('x'), mkBox('y'), mkBox('p', { refs: [ref('b.py', 'h', 5)] }), mkBox('q', { refs: [ref('b.py', 'h', 6)] }), mkBox('u', { refs: [ref('a.py', 'g', 45)] }), mkBox('v', { refs: [ref('a.py', 'g', 46)] }), mkBox('z', END)],
    [mkRoute('r1', 'x', 'y', 'If more'), mkRoute('r2', 'y', 'x', 'Next lap', { type: 'return' }), mkRoute('r3', 'p', 'q', 'If more'), mkRoute('r4', 'q', 'p', 'Next lap', { type: 'return' }),
      mkRoute('r5', 'u', 'v', 'If more'), mkRoute('r6', 'v', 'u', 'Next lap', { type: 'return' }), mkRoute('r7', 'u', 'z', 'If done')],
    { loops: [{ id: 'l_x', title: 'Bug retry', boxes: ['x', 'y'], limit: 'none' }, { id: 'l_p', title: 'Poll', boxes: ['p', 'q'], limit: 'whenever it likes' }, { id: 'l_u', title: 'Steps', boxes: ['u', 'v'], limit: 'MAX_STEPS per job' }] });
  const f = of(an(m, c, null, facts), 'no-limit-loop');
  assert.deepEqual(keys(f).sort(), ['no-limit-loop:l_p', 'no-limit-loop:l_x']);
  const lx = f.find((x) => x.key === 'no-limit-loop:l_x'), lp = f.find((x) => x.key === 'no-limit-loop:l_p');
  assert.equal(lx.question, 'Loop "problem retry" shows no limit: what stops it?');           // the banned word never reaches a reader
  assert.match(lx.evidence, /^No limit is shown on the loop\./);
  assert.match(lp.question, /names a limit but the code shows a loop with no count/);
  assert.match(lp.evidence, /Code shows a loop at b\.py:5/);
  // a stated limit stands when the code agrees, and a drawn cycle with no loop entry is flagged
  const m2 = mkModel([mkBox('x'), mkBox('y'), mkBox('z', END)], [mkRoute('r1', 'x', 'y', 'If more'), mkRoute('r2', 'y', 'x', 'Next lap', { type: 'return' }), mkRoute('r3', 'x', 'z', 'If done')]);
  const g = of(an(m2), 'no-limit-loop');
  assert.deepEqual(keys(g), ['no-limit-loop:x']);
  assert.match(g[0].question, /A cycle runs through x, y with no loop entry and no limit shown: what stops it\?/);
  m2.boxes[1].plain = 'Retries up to 3 times';
  assert.equal(of(an(m2), 'no-limit-loop').length, 0);
});

test('can-only-go-back: a closed pair is the strong shape; one road in to a retry arm is not flagged', () => {
  const m = mkModel([mkBox('g'), mkBox('t1', { kind: 'wait' }), mkBox('t2'), mkBox('c1', { kind: 'wait' }), mkBox('c2'), mkBox('z', END)], [
    mkRoute('r1', 'g', 't1', 'Postcode odd'), mkRoute('r2', 'g', 'c1', 'Value high'), mkRoute('r3', 'g', 'z', 'Otherwise'),
    mkRoute('r4', 't1', 't2', 'Operator sends release', { inferred: true }), mkRoute('r5', 't2', 't1', '', { type: 'return' }),
    mkRoute('r6', 'c1', 'c2', 'Operator sends release', { inferred: true }), mkRoute('r7', 'c2', 'g', 'Papers given', { type: 'return' })]);
  const f = of(an(m), 'can-only-go-back');
  assert.deepEqual(keys(f), ['can-only-go-back:t1']);                // c1/c2 return to the start: a real way on, so not the same shape
  assert.deepEqual(f[0].boxes, ['t1', 't2']);
  assert.equal(f[0].question, '1 road in, every road on leads back to the same 2 boxes: what lets flow out of t1 reach an ending?');
  assert.match(f[0].evidence, /^2 boxes reach no ending by any road\. 1 road comes in, from g\./);
  assert.match(f[0].evidence, /waits for an outside event \("Operator sends release"\)/);
});

test('can-only-go-back weak shape needs 3+ roads in; pile-up in the same region folds into it', () => {
  const srcs = ['s1', 's2', 's3'].map((id) => mkBox(id));
  const m = mkModel([mkBox('start'), ...srcs, mkBox('w', { kind: 'wait' }), mkBox('o', { kind: 'wait' }), mkBox('z', END)], [
    mkRoute('a0', 'start', 's1', 'If a'), mkRoute('a1', 'start', 's2', 'If b'), mkRoute('a2', 'start', 's3', 'If c'), mkRoute('a3', 'start', 'z', 'Otherwise'),
    ...srcs.map((b, i) => mkRoute(`w${i}`, b.id, 'w', 'If hold')), ...srcs.map((b, i) => mkRoute(`e${i}`, b.id, 'z', 'Otherwise')), mkRoute('wr', 'w', 'start', 'Later request', { type: 'return' }),
    ...srcs.slice(0, 2).map((b, i) => mkRoute(`o${i}`, b.id, 'o', 'If park')), mkRoute('or', 'o', 'start', 'Later request', { type: 'return' })],
    { loops: [{ id: 'l_all', title: 'Requests', boxes: ['start', 's1', 's2', 's3', 's4', 'w', 'o'], limit: 'one pass per request' }] });
  const f = of(an(m), 'can-only-go-back');
  assert.deepEqual(keys(f), ['can-only-go-back:w']);                 // o has 2 roads in: an ordinary arm
  assert.equal(f[0].question, '3 roads in, every way on goes back upstream: what triggers the later request?');
  // with a fourth road in, pile-up would also fire on w: it folds into the one finding and raises agreement
  m.boxes.push(mkBox('s4')); m.routes.push(mkRoute('a4', 'start', 's4', 'If d'), mkRoute('w3', 's4', 'w', 'If hold'), mkRoute('e3', 's4', 'z', 'Otherwise'));
  const all = an(m);
  assert.equal(of(all, 'pile-up').length, 0);
  const w = all.find((x) => x.key === 'can-only-go-back:w');
  assert.deepEqual(w.also, ['pile-up']);
  assert.equal(w.agree, 2);
  assert.match(w.evidence, /Another check finds the same boxes \(pile up\): /);
  assert.equal(all[0].key, 'can-only-go-back:w');                    // agreement ranks it first
});

test('can-only-go-back stays quiet when no end box is drawn, and says so', () => {
  const f = analyze(mkModel([mkBox('a'), mkBox('b')], [mkRoute('r1', 'a', 'b', 'If x'), mkRoute('r2', 'b', 'a', 'If y', { type: 'return' })]), baseFacts(), null);
  assert.equal(of(f, 'can-only-go-back').length, 0);
  assert.ok(f.notes.some((n) => /no end boxes drawn/.test(n)));
});

test('ending-no-test needs test evidence, names the end box, and ignores lines it cannot place', () => {
  const m = mkModel([mkBox('a'), mkBox('lost', { ...END, outcome: 'neutral', handle: 'lease_lost', refs: [ref('a.py', 'f', 33)] }), mkBox('fine', { ...END, refs: [ref('a.py', 'f', 20)] })], [mkRoute('r1', 'a', 'lost', 'If stale'), mkRoute('r2', 'a', 'fine', 'Otherwise')]);
  const c = census({ endings: [{ id: 'end:a.py::f:0', fn: 'a.py::f', line: 33, kind: 'outcome', value: 'lease_lost', confidence: 'high' }, { id: 'end:a.py::f:1', fn: 'a.py::f', line: 20, kind: 'outcome', value: 'ok', confidence: 'high' }, { id: 'end:a.py::f:2', fn: 'a.py::f', line: 36, kind: 'outcome', value: 'stale', confidence: 'high' }] });
  const none = analyze(m, baseFacts(), c, null);
  assert.equal(of(none, 'ending-no-test').length, 0);
  assert.ok(none.notes.some((n) => /ending-no-test was skipped/.test(n)));
  const ov = { lines: { 'a.py': { executed: [20], missing: [33, 36] } } };
  const f = of(an(m, c, ov), 'ending-no-test');
  assert.deepEqual(keys(f), ['ending-no-test:lost']);                // line 36 maps to no end box; line 20 ran
  assert.equal(f[0].question, 'No test or run reached the outcome "lease_lost" at a.py:33: what would make it happen, and is it worth a test?');
  const byRow = of(an(m, c, { endings: { 'end:a.py::f:0': { count: 0 }, 'end:a.py::f:1': { count: 4 } } }), 'ending-no-test');
  assert.deepEqual(keys(byRow), ['ending-no-test:lost']);
});

test('declared-never-produced: a declared value no ending produces, on an end box or a box nothing leads to', () => {
  const m = mkModel([mkBox('a'), mkBox('alpha', { ...END, handle: 'alpha' }), mkBox('beta', { ...END, handle: 'beta_value' }), mkBox('gamma', { kind: 'store', handle: 'gamma' }), mkBox('delta', { ...END, handle: 'delta' })],
    [mkRoute('r1', 'a', 'alpha', 'If a'), mkRoute('r2', 'a', 'gamma', 'If g'), mkRoute('r3', 'a', 'delta', 'If d')]);
  const c = census({ outcomeTypes: [{ name: 'Kind', source: 'enum', path: 'a.py', line: 3, values: ['alpha', 'beta_value', 'gamma', 'delta'] }], endings: [{ id: 'end:x:0', fn: 'a.py::f', line: 9, kind: 'outcome', value: 'Kind.ALPHA', confidence: 'medium' }, { id: 'end:x:1', fn: 'a.py::f', line: 9, kind: 'outcome', value: 'delta', confidence: 'low' }] });
  const f = of(an(m, c), 'declared-never-produced');
  assert.deepEqual(keys(f), ['declared-never-produced:beta']);       // alpha is produced; delta is produced at low confidence; gamma is a state with roads in
  assert.equal(f[0].question, 'Kind lists "beta_value" but no ending in the code sets it: is it kept for later, or left over?');
  assert.match(f[0].evidence, /The box has no road in\.$/);
  assert.equal(f[0].agree, 1);
  assert.equal(of(an(m, c, { boxes: { beta: { level: 'seen', count: 2 } } }), 'declared-never-produced').length, 0);   // a run saw it
});

test('declared-never-produced uses the reader\'s per-member counts when facts carry them', () => {
  const m = mkModel([mkBox('a'), mkBox('beta', { ...END, handle: 'beta_value' }), mkBox('gamma', { ...END, handle: 'gamma_value' })], [mkRoute('r1', 'a', 'beta', 'If b')]);
  const c = census({ outcomeTypes: [{ name: 'Kind', source: 'enum', path: 'a.py', line: 3, values: ['beta_value', 'gamma_value'] }] });
  const facts = baseFacts();
  facts.enums = [{ name: 'Kind', path: 'a.py', line: 3, values: ['beta_value', 'gamma_value'], members: ['BETA', 'GAMMA'], uses: { BETA: 0, GAMMA: 2 } }];
  const f = of(an(m, c, null, facts), 'declared-never-produced');
  assert.deepEqual(keys(f), ['declared-never-produced:beta']);       // GAMMA is mentioned in code, so it is not called never produced
  assert.match(f[0].evidence, /No code refers to Kind\.BETA/);
});

// ---- analyze: ranking, the cap, grouping, dismissals, determinism ---------------------------------------------------
test('ranking is by agreement, the cap is 10, groups follow stage order, dismissed findings step aside', () => {
  const boxes = [mkBox('s0', { stage: 's2' })], routes = [];
  for (let i = 0; i < 12; i++) { boxes.push(mkBox(`b${i}`, { stage: i % 2 ? 's2' : 's1' })); routes.push(mkRoute(`h${i}`, i ? `b${i - 1}` : 's0', `b${i}`, `Might fire ${'abcdefghijkl'[i]}`)); }
  const m = mkModel(boxes, routes, { stages: [{ id: 's1', title: 'First', order: 1 }, { id: 's2', title: 'Second', order: 2 }] });
  const f = an(m);
  assert.equal(of(f, 'hedged-route').length, 12);
  assert.equal(f.length, 13);                                         // plus the last box, which nothing leaves
  assert.equal(f.filter((x) => x.shown).length, 10);
  assert.ok(f.every((x) => x.agree === 1 && x.level === 'suspected'));
  const g = groupFindings(f, m);
  assert.deepEqual(g.groups.map((x) => x.cluster), ['s1', 's2']);
  assert.equal(g.hidden, 3);
  const gone = analyze(m, baseFacts(), null, null, { dismissed: { [f[0].key]: { why: 'a label only', by: 'agent', at: 'now' }, [f[1].key]: { suspect: true, why: 'confirmed' } } });
  assert.equal(gone.find((x) => x.key === f[0].key).shown, false);
  assert.equal(gone.find((x) => x.key === f[0].key).resolution.state, 'dismissed');
  assert.equal(gone.find((x) => x.key === f[1].key).resolution.state, 'suspect');
  assert.equal(gone.filter((x) => x.shown).length, 10);              // a dismissed one frees its slot
  assert.equal(groupFindings(gone, m).dismissed, 1);
});

test('analyze is deterministic and keys survive a re-run with the boxes in another order', () => {
  const m = mkModel([mkBox('a'), mkBox('b'), mkBox('c')], [mkRoute('r1', 'a', 'b', 'Might retry'), mkRoute('r2', 'b', 'c', 'Possibly')]);
  const one = JSON.stringify(analyze(m, baseFacts(), null, null)), two = JSON.stringify(analyze(m, baseFacts(), null, null));
  assert.equal(one, two);
  const k1 = keys(analyze(m, baseFacts(), null, null)).sort();
  const flipped = mkModel([...m.boxes].reverse(), [...m.routes].reverse());
  assert.deepEqual(keys(analyze(flipped, baseFacts(), null, null)).sort(), k1);
});

// ---- propose ------------------------------------------------------------------------------------------------------
function proposeWorld(over = {}) {
  const facts = mkFacts([
    fn('a.py', 'run', 1, 20, { branches: [{ line: 5, kind: 'if', test: 'queue is empty' }, { line: 9, kind: 'if', test: 'attempts >= LIMIT' }] }), fn('a.py', 'helper', 21, 40),
    fn('b.py', 'step', 1, 20), fn('b.py', 'deep', 21, 40), fn('c.py', 'loopback', 1, 10), fn('h.py', 'hub', 1, 5), fn('d.py', 'far', 1, 5), fn('z.py', 'orphan', 1, 30, { branches: Array.from({ length: 4 }, (_, i) => ({ line: i + 2, kind: 'if', test: `t${i}` })), loops: [{ line: 7, kind: 'while', bounded: false, why: 'no count' }] })],
    ['a.py', 'b.py', 'c.py', 'd.py', 'h.py', 'z.py', 'x.py']);
  const graph = {
    callEdges: [['a.py::run', 'a.py::helper'], ['a.py::run', 'b.py::step'], ['b.py::step', 'b.py::deep'], ['c.py::loopback', 'a.py::run'], ['a.py::run', 'h.py::hub'], ['h.py::hub', 'd.py::far']],
    importEdges: [['z.py', 'a.py']], hubs: [{ fn: 'h.py::hub', in: 20, out: 3 }], depth: { 'a.py::run': 0, 'b.py::step': 1, 'b.py::deep': 2, 'z.py::orphan': 4 },
    clusters: [{ id: 'c1', modules: ['b.py'], fns: ['b.py::step', 'b.py::deep'], cohesion: 0.8, label: 'queue_core' }, { id: 'c0', modules: ['a.py'], fns: ['a.py::run', 'a.py::helper'], cohesion: 0.7, label: 'intake' }, { id: 'c2', modules: ['z.py'], fns: ['z.py::orphan'], cohesion: 0.5, label: 'report' }],
  };
  const bx = (id, p, q, line, extra = {}) => mkBox(id, { refs: [ref(p, q, line)], ...extra });
  const model = mkModel([bx('A', 'a.py', 'run', 5), bx('B', 'b.py', 'step', 3), bx('C', 'b.py', 'deep', 25), bx('D', 'd.py', 'far', 2), bx('L', 'c.py', 'loopback', 4)],
    [mkRoute('r_ac', 'A', 'C'), mkRoute('r_al', 'A', 'L'), mkRoute('r_ad', 'A', 'D', 'If far')], { modules: { 'x.py': { excluded: 'unused' } }, ...over });
  return { facts, graph, model };
}

test('propose: routes come from the call graph with the chain as evidence; the agent names the condition', () => {
  const { facts, graph, model } = proposeWorld();
  const p = propose(model, facts, graph);
  const pairs = p.routes.map((r) => `${r.from}>${r.to}`);
  assert.deepEqual(pairs, ['A>B', 'L>A', 'B>C']);                    // A>C exists; A>D would need the hub; none is invented. Hints into a box nothing leads to (B, A) come before B>C
  const ab = p.routes[0];
  assert.deepEqual(ab.evidence, { chain: ['a.py::run', 'b.py::step'], hops: 1 });
  assert.equal(ab.when, '');
  assert.deepEqual(ab.conditionHints.map((h) => h.text), ['queue is empty', 'attempts >= LIMIT']);
  assert.equal(ab.type, 'forward');
  assert.equal(p.routes[1].type, 'return');                          // the model already runs A to L, so L back to A returns
  const none = propose(mkModel(model.boxes, model.routes.filter((r) => r.id !== 'r_ac'), {}), facts, graph);
  assert.ok(!none.routes.some((r) => r.from === 'A' && r.to === 'C'));  // the chain passes through B's function, so B>C is the road
});

test('propose: a walk through a hub does not make a route', () => {
  const { facts, graph, model } = proposeWorld();
  assert.ok(!propose(model, facts, graph).routes.some((r) => r.to === 'D'));
  const noHub = propose(model, facts, { ...graph, hubs: [] }, null);
  assert.ok(noHub.routes.some((r) => r.from === 'A' && r.to === 'D') === false);   // A>D already exists in the model either way
  const m2 = mkModel(model.boxes, model.routes.filter((r) => r.id !== 'r_ad'));
  assert.ok(propose(m2, facts, { ...graph, hubs: [] }).routes.some((r) => r.from === 'A' && r.to === 'D' && r.evidence.hops === 2));
});

test('propose: unmapped modules with a suggested stage, hotspots and drawn routes with no call path behind them', () => {
  const { facts, graph, model } = proposeWorld();
  const p = propose(model, facts, graph);
  assert.deepEqual(p.unmappedModules.map((m) => m.path), ['h.py', 'z.py']);   // x.py is excluded with a reason; the rest are cited
  const z = p.unmappedModules.find((m) => m.path === 'z.py');
  assert.equal(z.suggestedStage, 's1');                               // it imports a.py, which a box in s1 cites
  assert.equal(z.cluster, 'c2');
  assert.equal(p.unmappedModules.find((m) => m.path === 'h.py').suggestedStage, null);
  assert.deepEqual(p.hotspots.map((h) => h.fn), ['z.py::orphan']);
  assert.match(p.hotspots[0].why, /a loop with no count, 4 branches/);
  assert.deepEqual(p.unsupportedRoutes.map((u) => u.route), ['r_ad']);   // far is only reachable through the hub
  assert.ok(p.whereToLook.length > 0 && p.whereToLook.length <= 14);
  for (const w of p.whereToLook) { assert.ok(w.kind && w.at && w.ask); note(w.ask); }
  assert.equal(p.counts.unmappedModules, 2);
});

test('propose: stages from clusters only while the model has none, ordered by depth from the entries', () => {
  const { facts, graph } = proposeWorld();
  const empty = mkModel([], [], { stages: [] });
  const p = propose(empty, facts, graph);
  assert.deepEqual(p.stages.map((s) => s.id), ['s_intake', 's_queue_core', 's_report']);
  assert.deepEqual(p.stages.map((s) => s.title), ['Intake', 'Queue Core', 'Report']);
  assert.deepEqual(p.stages.map((s) => s.order), [1, 2, 3]);
  assert.equal(propose(proposeWorld().model, facts, graph).stages.length, 0);
  const many = { ...graph, clusters: Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, modules: [], fns: [`a.py::f${i}`], label: `part ${i}` })) };
  const capped = propose(empty, facts, many);
  assert.equal(capped.stages.length, 14);
  assert.equal(capped.stages[13].id, 's_other');
});

test('propose: unaccounted census rows come with the nearest box and a ready-to-merge ledger draft', () => {
  const { facts, graph, model } = proposeWorld();
  model.boxes[0].refs.push(ref('a.py', 'run', 15));
  const c = census({ endings: [{ id: 'end:a.py::run:0', fn: 'a.py::run', line: 14, kind: 'outcome', value: 'done', confidence: 'high' }, { id: 'end:a.py::run:1', fn: 'a.py::run', line: 18, kind: 'outcome', value: 'gone', confidence: 'high' }, { id: 'end:z.py::orphan:0', fn: 'z.py::orphan', line: 9, kind: 'raise', value: 'Boom', confidence: 'medium' }],
    branches: [{ id: 'branch:b.py::step:0', fn: 'b.py::step', line: 4, test: 'x', weight: 'decision' }] });
  model.ledger['end:a.py::run:1'] = { excluded: 'a helper return' };
  const p = propose(model, facts, graph, c);
  assert.deepEqual(p.unaccounted.map((u) => u.id), ['end:a.py::run:0', 'end:z.py::orphan:0', 'branch:b.py::step:0']);
  assert.deepEqual(p.ledgerDraft, { 'end:a.py::run:0': { box: 'A' }, 'branch:b.py::step:0': { box: 'B' } });   // nothing cites orphan, so no guess
  assert.equal(p.unaccounted[1].suggestedBox, null);
  assert.ok(p.whereToLook.some((w) => w.kind === 'ending' && /no box cites its function/.test(w.ask)));
});

test('propose is deterministic', () => {
  const { facts, graph, model } = proposeWorld();
  assert.equal(JSON.stringify(propose(model, facts, graph)), JSON.stringify(propose(model, facts, graph)));
});

// ---- examples/toy, end to end -------------------------------------------------------------------------------------
// Facts, census and graph come from the real extractor when src/extract/index.mjs exists and runs. Until then a small
// regex reader stands in (function spans, string-literal returns, enum values, loops), and the test says which it used.
function shimToy(root) {
  const functions = {}, modules = [], endings = [], branches = [], passes = [], outcomeTypes = [];
  const blank = (p, qual, line) => ({ path: p, qual, line, end: line, sha256: '', doc: '', async: false, decorators: [], calls: [], unresolved: [], branches: [], returns: [], raises: [], excepts: [], loops: [], retryHints: [] });
  for (const f of fs.readdirSync(path.join(root, 'parcelworks')).filter((n) => n.endsWith('.py')).sort()) {
    const rel = `parcelworks/${f}`, lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n');
    modules.push({ path: rel, lang: 'py', lines: lines.length, imports: [] });
    const stack = [], fns = []; let last = 0, enumCls = null;
    const close = (indent, upto) => { while (stack.length && stack[stack.length - 1].indent >= indent) { const s = stack.pop(); if (s.id) { functions[s.id].end = upto; fns.splice(fns.lastIndexOf(s.id), 1); } } };
    lines.forEach((raw, i) => {
      const n = i + 1, t = raw.trim(); if (!t || t.startsWith('#')) return;
      const indent = raw.length - raw.trimStart().length; close(indent, last); last = n; let m;
      if ((m = t.match(/^class\s+(\w+)\s*(?:\(([^)]*)\))?:/))) { stack.push({ indent, name: m[1] }); enumCls = /Enum/.test(m[2] || '') ? { name: m[1], line: n, values: [] } : null; if (enumCls) outcomeTypes.push({ name: m[1], source: 'enum', path: rel, line: n, values: enumCls.values }); return; }
      if ((m = t.match(/^(?:async\s+)?def\s+(\w+)/))) { const qual = [...stack.map((s) => s.name), m[1]].join('.'), id = `${rel}::${qual}`; functions[id] = blank(rel, qual, n); stack.push({ indent, name: m[1], id }); fns.push(id); return; }
      if (enumCls && (m = t.match(/^[A-Z_]+\s*=\s*"([^"]+)"/))) enumCls.values.push(m[1]);
      const cur = fns[fns.length - 1]; if (!cur) return;
      if ((m = t.match(/^(if|elif)\s+(.*):\s*$/))) { functions[cur].branches.push({ line: n, kind: m[1], test: m[2].slice(0, 80) }); branches.push({ id: `branch:${cur}:${branches.filter((b) => b.fn === cur).length}`, fn: cur, line: n, test: m[2].slice(0, 80), weight: 'decision' }); }
      if ((m = t.match(/^return\s+"([a-z_]+)"/))) endings.push({ id: `end:${cur}:${endings.filter((e) => e.fn === cur).length}`, fn: cur, line: n, kind: 'outcome', value: m[1], confidence: 'high' });
      if ((m = t.match(/^(while|for)\s+(.*):\s*$/))) { const bounded = m[2] !== 'True'; functions[cur].loops.push({ line: n, kind: m[1], bounded, why: bounded ? '' : 'while True with no break-by-count' }); passes.push({ id: `pass:${cur}:${passes.filter((p) => p.fn === cur).length}`, fn: cur, line: n, kind: 'loop', bounded, members: [] }); }
    });
    close(0, last);
  }
  {                                                                    // the TypeScript file: class methods and one function, spans by closing brace
    const rel = 'web/client.ts', lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n'); let cls = null;
    modules.push({ path: rel, lang: 'ts', lines: lines.length, imports: [] });
    lines.forEach((raw, i) => {
      const c = raw.match(/^export class (\w+)/); if (c) cls = c[1];
      const mm = raw.match(/^(  )?(?:export )?(?:private )?(?:async )?(?:function )?(\w+)\(.*\{$/);
      if (!mm || /^(for|if|switch|while)$/.test(mm[2]) || (mm[1] && !cls)) return;
      const close = mm[1] ? '  }' : '}'; let end = i + 1; while (end < lines.length && lines[end].replace(/\s+$/, '') !== close) end++;
      const qual = mm[1] ? `${cls}.${mm[2]}` : mm[2]; functions[`${rel}::${qual}`] = { ...blank(rel, qual, i + 1), end: end + 1 };
    });
  }
  const used = new Set();
  for (const f of fs.readdirSync(path.join(root, 'parcelworks')).filter((n) => n.endsWith('.py'))) {
    const src = fs.readFileSync(path.join(root, 'parcelworks', f), 'utf8');
    for (const m of src.matchAll(/Outcome\.([A-Z_]+)\.value/g)) used.add(m[1].toLowerCase());
    for (const m of src.matchAll(/JobStatus\.([A-Z_]+)/g)) used.add(m[1] === 'HOLD' ? 'hold' : m[1].toLowerCase());
  }
  for (const v of used) endings.push({ id: `end:shim:${v}`, fn: 'parcelworks/report.py::summarize', line: 14, kind: 'outcome', value: v, confidence: 'medium' });
  const entries = ['cli.py::main', 'cli.py::cmd_submit', 'cli.py::cmd_release', 'cli.py::cmd_report', 'worker.py::Worker.run'].map((e) => ({ fn: `parcelworks/${e}`, kind: 'cli', why: '' }));
  return {
    facts: { schema: 'faultline.facts/1', root, pin: { git: null, tree: 'shim' }, modules, functions, entries, switches: [], enums: outcomeTypes.map((o) => ({ name: o.name, path: o.path, line: o.line, values: o.values })) },
    census: { schema: 'faultline.census/1', outcomeTypes, endings, branches, passes, switches: [], counts: {} },
    graph: { callEdges: [], importEdges: [], scc: [], clusters: [], depth: {}, hubs: [] },
  };
}
async function toyInputs() {
  try {
    const mod = await import(pathToFileURL(path.resolve(here, '../src/extract/index.mjs')).href);
    const r = await mod.extract(TOY, { exclude: ['explorer_adapter.py'] });
    if (r?.facts?.functions && r?.census && r?.graph) return { ...r, via: 'real extractor' };
  } catch { /* not there yet, or it could not run: fall through */ }
  return { ...shimToy(TOY), via: 'stand-in reader' };
}
function coverageOverlay() {                                         // coverage.py JSON to the line lists analyze reads
  const d = JSON.parse(fs.readFileSync(path.join(TOY, 'fixtures/coverage.json'), 'utf8')), lines = {};
  for (const [k, v] of Object.entries(d.files)) lines[k.replace(/\\/g, '/')] = { executed: v.executed_lines, missing: v.missing_lines };
  return { lines, boxes: {}, routes: {} };
}
const toy = await toyInputs();
console.log(`# toy inputs: ${toy.via}`);

test('toy: the hand-written model passes every always-hard gate against the extracted facts', () => {
  const model = loadModel(BARE);
  const v = noteRes(validateModel(model, toy.facts, toy.census, { finished: false }));
  assert.deepEqual(v.refusals.map((r) => r.msg), []);
  assert.equal(v.gaps.state, 'draft');
});

test('toy: planted items are flagged on the right boxes, with at most 3 false suspects', () => {
  const model = loadModel(BARE);
  const f = noteFindings(analyze(model, toy.facts, toy.census, coverageOverlay()));
  const has = (k) => f.some((x) => x.key === k);
  assert.ok(has('can-only-go-back:trouble.hold_address'), 'item 1 missing');
  assert.deepEqual(f.find((x) => x.key === 'can-only-go-back:trouble.hold_address').boxes.sort(), ['trouble.hold_address', 'trouble.release_refused']);
  assert.ok(has('declared-never-produced:report.returned'), 'item 2 missing');
  assert.ok(has('ending-no-test:work.lease_lost'), 'item 3 missing');
  assert.ok(has('no-limit-loop:l_report_write'), 'item 4 missing');
  assert.match(f.find((x) => x.key === 'no-limit-loop:l_report_write').question, /shows no limit/);
  // negative controls
  assert.ok(!f.some((x) => x.key.includes('trouble.hold_customs') || x.key.includes('trouble.release:')), 'the customs hold must not be called a candidate');
  assert.ok(!has('no-limit-loop:l_retry') && !has('no-limit-loop:l_worker'), 'bounded and service loops must not be flagged');
  assert.ok(!f.some((x) => x.check === 'declared-never-produced' && x.boxes[0] !== 'report.returned'), 'produced values must not be flagged');
  const planted = new Set(['trouble.hold_address', 'trouble.release_refused', 'report.returned', 'work.lease_lost', 'report.write', 'report.busy']);
  const stray = f.filter((x) => !x.boxes.some((id) => planted.has(id)));
  assert.ok(stray.length <= 3, `false suspects: ${stray.map((x) => x.key).join(', ')}`);
  console.log(`# toy findings: ${f.length}, false suspects: ${stray.length}${stray.length ? ` (${stray.map((x) => x.key).join(', ')})` : ''}`);
  assert.ok(f.every((x) => x.shown) || f.length > 10);
});

test('toy: the box-level overlay an importer writes (a run looked, the cited line never ran) names the same ending', () => {
  const model = loadModel(BARE);
  const overlay = { boxes: { 'work.lease_lost': { level: 'drawn', count: 0, untested: true, reasons: ['coverage.py@7: cited line 32 never ran'] }, 'report.saved': { level: 'seen', count: 1 } }, routes: {} };
  const f = noteFindings(analyze(model, toy.facts, toy.census, overlay));
  const e = f.filter((x) => x.check === 'ending-no-test');
  assert.deepEqual(e.map((x) => x.key), ['ending-no-test:work.lease_lost']);
  assert.match(e[0].evidence, /cited line 32 never ran/);
  assert.match(e[0].question, /lease_lost/);                          // the census row supplies the value and the line
});

test('toy: without test evidence no ending is called untested', () => {
  const model = loadModel(BARE);
  const f = analyze(model, toy.facts, toy.census, null);
  assert.equal(f.some((x) => x.check === 'ending-no-test'), false);
  assert.ok(f.notes.some((n) => /ending-no-test was skipped/.test(n)));
});

test('toy: a deliberately straight list is refused by S1', () => {
  const model = loadModel(BARE);
  const main = model.paths[0].boxes, set = new Set(main);
  const straight = { ...model, boxes: model.boxes.filter((b) => set.has(b.id)), routes: model.routes.filter((r) => { const i = main.indexOf(r.from); return i >= 0 && main[i + 1] === r.to; }), loops: [], paths: [model.paths[0]], ledger: {}, modules: model.modules };
  const decisions = toy.census.branches.filter((b) => b.weight === 'decision').length;
  assert.ok(decisions >= 10, 'the toy has 10+ decision branches');
  const v = noteRes(validateModel(straight, toy.facts, toy.census, { finished: true }));
  const s1 = v.refusals.find((r) => r.code === 'S1');
  assert.ok(s1, 'S1 expected');
  assert.match(s1.msg, /^REFUSE S1 the map is a straight list: \d+ of \d+ boxes \(\d+%\) have exactly one road in and one out, while the census has \d+ decision branches\. Fix: /);
  const full = noteRes(validateModel(loadModel(BARE), toy.facts, toy.census, { finished: true }));
  assert.equal(full.refusals.some((r) => r.code === 'S1'), false, 'the real toy model is not a straight list');
});

test('toy: unaccounted endings are refused by B1 when finished and printed as a gap in a draft', () => {
  const model = loadModel(BARE);                 // the hand-written model has no ledger
  const fin_ = noteRes(validateModel(model, toy.facts, toy.census, { finished: true }));
  const b1 = fin_.refusals.find((r) => r.code === 'B1');
  assert.ok(b1, 'B1 expected when finished');
  assert.match(b1.msg, /^REFUSE B1 census rows not accounted in the ledger \(\d+ of \d+\): (ending|decision branch) /);
  assert.ok(b1.offenders.some((id) => id.startsWith('end:')), 'unaccounted endings are named');
  const dr = noteRes(validateModel(model, toy.facts, toy.census, { finished: false }));
  assert.equal(dr.refusals.some((r) => r.code === 'B1'), false);
  const gap = dr.gaps.items.find((g) => g.code === 'B1');
  assert.ok(gap && gap.msg.startsWith('GAP B1 census rows not accounted in the ledger'));
  assert.ok(dr.gaps.notDrawn.endings.count > 0);
  // accounting for every required row clears it
  const ledger = {};
  for (const e of toy.census.endings.filter((x) => x.confidence !== 'low')) ledger[e.id] = { excluded: 'covered by the toy test' };
  for (const b of toy.census.branches.filter((x) => x.weight === 'decision')) ledger[b.id] = { excluded: 'covered by the toy test' };
  assert.equal(validateModel({ ...model, ledger }, toy.facts, toy.census, { finished: true }).refusals.some((r) => r.code === 'B1'), false);
});

test('toy: propose lists the unaccounted endings with the nearest box, from the model alone', () => {
  const model = loadModel(BARE);
  const p = propose(model, toy.facts, toy.graph, toy.census);
  assert.ok(p.unaccounted.length > 0);
  assert.ok(p.unaccounted.some((u) => u.id.startsWith('end:') && u.suggestedBox));
  assert.deepEqual(p.unmappedModules, []);                           // every module is cited or excluded
});

// ---- receipts and the check command --------------------------------------------------------------------------------
function toyProject(extra = {}) {
  const dir = tmp('proj');
  fs.mkdirSync(path.join(dir, 'model'), { recursive: true });
  for (const f of fs.readdirSync(path.join(BARE, 'model'))) fs.copyFileSync(path.join(BARE, 'model', f), path.join(dir, 'model', f));
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify(toy.facts));
  fs.writeFileSync(path.join(dir, 'census.json'), JSON.stringify(toy.census));
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(toy.graph));
  for (const [name, obj] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
  return dir;
}
const bytes = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

test('checkProject writes model.merged.json, proposals.json and receipts.json, the same bytes every run', () => {
  const dir = toyProject();
  const r1 = checkProject(dir, { overlay: coverageOverlay() });
  for (const name of ['model.merged.json', 'proposals.json', 'receipts.json']) assert.ok(fs.existsSync(path.join(dir, name)), name);
  const first = ['model.merged.json', 'proposals.json', 'receipts.json'].map((n) => bytes(dir, n));
  checkProject(dir, { overlay: coverageOverlay() });
  assert.deepEqual(['model.merged.json', 'proposals.json', 'receipts.json'].map((n) => bytes(dir, n)), first);
  const rec = JSON.parse(bytes(dir, 'receipts.json'));
  assert.equal(rec.schema, 'faultline.receipts/1');
  assert.equal(rec.state, 'draft');
  assert.equal(rec.result, 'gaps');
  assert.equal(rec.at, undefined);                                   // no clock: same input, same bytes
  assert.deepEqual(rec.gates.map((g) => g.code), ['G1', 'G2', 'G3', 'G4', 'G5', 'K1', 'L1', 'T1', 'B1', 'B2', 'M1', 'S1', 'S2', 'E1', 'A1']);
  assert.equal(rec.gates.find((g) => g.code === 'G1').status, 'pass');
  assert.equal(rec.gates.find((g) => g.code === 'B1').status, 'gap');
  assert.equal(rec.findings.length, r1.findings.length);
  assert.match(rec.pin.model, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(bytes(dir, 'model.merged.json')).boxes.length, 35);
});

test('checkProject --finished refuses the unledgered toy; dismissed.json clears findings and survives a re-run', () => {
  const dir = toyProject();
  const f = checkProject(dir, { finished: true, write: false, overlay: coverageOverlay() });
  assert.equal(f.receipts.result, 'refused');
  assert.equal(f.receipts.state, 'refused');
  assert.ok(f.receipts.refusals.some((r) => r.code === 'B1'));
  assert.ok(f.receipts.refusals.some((r) => r.code === 'A1'), 'four open findings');
  const dismissed = {};
  for (const x of f.findings) dismissed[x.key] = x.check === 'can-only-go-back' ? { suspect: true, why: 'the release command never moves an address hold', by: 'test', at: 'now' } : { why: 'reviewed in the test', by: 'test', at: 'now' };
  const dir2 = toyProject({ 'dismissed.json': dismissed });
  const g = checkProject(dir2, { finished: true, write: false, overlay: coverageOverlay() });
  assert.equal(g.receipts.refusals.some((r) => r.code === 'A1'), false);
  assert.equal(g.findings.find((x) => x.key === 'can-only-go-back:trouble.hold_address').resolution.state, 'suspect');
  assert.equal(g.findings.filter((x) => x.shown).length, 1);          // the three dismissed ones step aside; the suspect stays shown
  const again = checkProject(dir2, { finished: true, write: false, overlay: coverageOverlay() });
  assert.deepEqual(again.findings.map((x) => x.key), g.findings.map((x) => x.key));
});

test('checkProject on a model that does not load writes receipts only', () => {
  const dir = toyProject();
  const dup = JSON.parse(bytes(dir, 'model/30-work.json'));
  fs.writeFileSync(path.join(dir, 'model/35-dup.json'), JSON.stringify({ schema: 'faultline.model/1', boxes: [dup.boxes[0]] }));
  const r = checkProject(dir, {});
  assert.equal(r.receipts.result, 'refused');
  assert.equal(r.receipts.refusals[0].code, 'G4');
  assert.match(r.receipts.refusals[0].msg, new RegExp(`${dup.boxes[0].id.replace(/\./g, '\\.')}" is defined in 30-work\\.json and again in 35-dup\\.json`));
  assert.ok(fs.existsSync(path.join(dir, 'receipts.json')));
  assert.equal(fs.existsSync(path.join(dir, 'model.merged.json')), false);
});

test('makeReceipts takes an optional stamp and writeReceipts puts it in the project dir', () => {
  const m = mkModel([mkBox('a')], []), facts = mkFacts([fn('a.py', 'f', 1, 40)]);
  const v = validateModel(m, facts, census(), {});
  const r = makeReceipts(m, facts, census(), v, [], { at: '2026-01-01T00:00:00Z' });
  assert.equal(r.at, '2026-01-01T00:00:00Z');
  const dir = tmp('rec');
  const file = writeReceipts(dir, r);
  assert.equal(path.basename(file), 'receipts.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).result, 'clean');
});

// ---- words: nothing the tool writes may use the banned wording -------------------------------------------------------
test('wording: plainWords rewrites banned words, and nothing the tests produced uses them', () => {
  assert.equal(plainWords('A bug here, a dead end there, unbounded, and it does not exist'), 'A problem here, a no way on there, no limit shown, and it is not drawn');
  assert.equal(hasBannedWord('debugging is fine'), false);          // only the whole word counts
  assert.equal(hasBannedWord('a Bug'), true);
  assert.ok(produced.length > 40, `only ${produced.length} sentences were collected`);
  const bad = produced.filter(hasBannedWord);
  assert.deepEqual(bad, []);
  for (const s of produced.filter((x) => /^(REFUSE|GAP) /.test(x))) assert.match(s, /^(REFUSE|GAP) [A-Z]\d? ?[A-Za-z0-9-]* .+/);
});

test('wording: the source of src/model never uses the banned words either', () => {
  const dir = path.resolve(here, '../src/model');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (f === 'refusal.mjs') continue;                              // this file holds the list of banned words
    assert.equal(/\bbugs?\b|\bdead[- ]ends?\b|\bunbounded\b/i.test(src), false, `${f} uses a banned word`);
  }
});

