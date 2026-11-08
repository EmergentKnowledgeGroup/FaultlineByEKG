// Tests for the rules that were wrong about code that is easy to write: same-stem files, labelled jumps, a call that never returns, a condition that does work,
// a stub with overrides, a finally that an ending leaves through, a context manager that swallows, callbacks, default exports, files that only start or build
// the project, long and non-ASCII text. Every name here is invented; every case says what the map may not claim and what it must show instead.
import { needs as needsOf } from './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilities, build, buildFiles, boxesOf, roadsOf, claimsOf, callsWithoutRoad } from './lib/map-helpers.mjs';
import { dumps } from '../src/map/pyrt.mjs';

const cap = await capabilities();
const needs = (...what) => needsOf(cap, ...what);
const idsOf = (b) => b.res.model.boxes.map((x) => x.id);
const FN = `export function run(x: number): void { fs.writeFileSync('o.txt', String(x)); if (x) { throw new Error('bad'); } }\n`;
const TS_HEAD = `import * as fs from 'fs';\n`;
const PY_FN = `def run(x):\n    open("o.txt", "w").write(str(x))\n    if x:\n        raise ValueError("bad")\n`;

// ---- boxes need ids that are unique and do not depend on the order files were found in -------------------------------------------
async function collide(files, opts) {
  const a = await buildFiles(files, opts);
  const ids = idsOf(a);
  assert.equal(new Set(ids).size, ids.length, 'every box id is unique');
  assert.ok(a.res.model.boxes.some((x) => x.prov.fn.endsWith('::run') && x.kind === 'store'), 'the work of run() is on the map');
  const fns = new Set(a.res.model.boxes.map((x) => x.prov.fn));
  assert.ok(fns.size >= 2, `both files are mapped: ${[...fns]}`);
  const again = await buildFiles(files, opts);
  assert.equal(dumps(idsOf(again), 0), dumps(ids, 0), 'the same files give the same ids');
  return a;
}

test('ids: a-b.ts and a_b.ts with one function name do not stop the map', needs('typescript'), async () => {
  await collide({ 'a-b.ts': TS_HEAD + FN, 'a_b.ts': TS_HEAD + FN }, { ts: true });
});

test('ids: x.ts and x.js with one function name do not stop the map', needs('typescript'), async () => {
  await collide({ 'x.ts': TS_HEAD + FN, 'x.js': TS_HEAD + FN }, { ts: true });
});

test('ids: a.b.ts and a/b.ts with one function name do not stop the map', needs('typescript'), async () => {
  await collide({ 'a.b.ts': TS_HEAD + FN, 'a/b.ts': TS_HEAD + FN }, { ts: true });
});

test('ids: x.py and x.ts with one function name do not stop the map', needs('python', 'typescript'), async () => {
  await collide({ 'x.py': PY_FN, 'x.ts': TS_HEAD + FN }, { py: true, ts: true });
});

test('ids: two files whose names differ only in letters outside ASCII do not stop the map', needs('typescript'), async () => {
  await collide({ 'caf\u00e9.ts': TS_HEAD + FN, 'caf\u00e8.ts': TS_HEAD + FN }, { ts: true });
});

test('ids: a function that shares a stem with another gets a hash of its own full id; one that does not keeps the plain id and does not change when a clash is added', needs('typescript'), async () => {
  const lone = { 'solo.ts': TS_HEAD + FN };
  const alone = await buildFiles(lone, { ts: true });
  const withClash = await buildFiles({ ...lone, 'a-b.ts': TS_HEAD + FN, 'a_b.ts': TS_HEAD + FN }, { ts: true });
  const soloIds = (b) => b.res.model.boxes.filter((x) => x.prov.fn.startsWith('solo.ts::')).map((x) => x.id);
  assert.equal(dumps(soloIds(withClash), 0), dumps(soloIds(alone), 0), 'a file nobody clashes with keeps its ids');
  const clash = withClash.res.model.boxes.filter((x) => /^a[-_]b\.ts::/.test(x.prov.fn)).map((x) => x.id);
  assert.ok(clash.length >= 2 && clash.every((id) => /-[0-9a-f]{8}\./.test(id)), `the clashing ids carry the hash: ${clash.slice(0, 3)}`);
});

// ---- TypeScript: labelled jumps, callbacks, default export -------------------------------------------------------------------
const tsb = () => build('fixes_ts', { ts: true });
const loopBoxes = (b, fn) => boxesOf(b, fn, { rule: 'loop' });

test('labelled jumps: break outer leaves both loops, so the work after them is on the map', needs('typescript'), async () => {
  const b = await tsb();
  assert.ok(boxesOf(b, 'leaveBoth').some((x) => x.kind === 'store' && x.prov.line === 14), 'the store after both loops is a box');
  const [outer, inner] = loopBoxes(b, 'leaveBoth').sort((x, y) => x.prov.line - y.prov.line);
  const roads = roadsOf(b, 'leaveBoth', 'cfg-edge').map(([a, r, t]) => [a.id, t.id, t.kind]);
  assert.ok(roads.some(([a, t, k]) => a === inner.id && k === 'store'), 'the inner loop leads straight to the store after the outer loop');
  assert.ok(!roads.some(([a, t]) => a === inner.id && t === outer.id), 'and does not lead back to the outer loop');
});

test('labelled jumps: continue outer goes to the outer loop, break outer to the code after it', needs('typescript'), async () => {
  const b = await tsb();
  const [outer, inner] = loopBoxes(b, 'sieve').sort((x, y) => x.prov.line - y.prov.line);
  const dec = boxesOf(b, 'sieve', { rule: 'decision' }).find((x) => x.title === 'c === 0');
  assert.ok(dec, 'the test c === 0 is a decision');
  const calls = roadsOf(b, 'sieve', 'call').filter(([a, r]) => a.id === dec.id).map(([, , t]) => t.prov.fn.split('::')[1]);
  assert.ok(calls.includes('saveC'), 'break outer on the c === 0 arm reaches saveC, which follows the outer loop');
  const back = roadsOf(b, 'sieve', 'cfg-edge').filter(([a, r, t]) => a.id === dec.id && t.id === outer.id);
  assert.equal(back.length, 0, 'the c === 0 arm does not go back to the outer loop');
  const fromInner = roadsOf(b, 'sieve', 'cfg-edge').filter(([a, r, t]) => a.id === inner.id && t.id === outer.id);
  assert.ok(fromInner.length >= 1, 'continue outer (the c < 0 arm, folded) leaves the inner loop for the outer one');
});

test('labelled jumps: break out of a labelled block lands after the block', needs('typescript'), async () => {
  const b = await tsb();
  const dec = boxesOf(b, 'blockLeave', { rule: 'decision' })[0];
  const calls = roadsOf(b, 'blockLeave', 'call').filter(([a]) => a.id === dec.id).map(([, , t]) => t.prov.fn.split('::')[1]).sort();
  assert.deepEqual(calls, ['saveA', 'saveB'], 'the test x reaches saveA (no break) and saveB (break or not)');
});

test('callbacks: a function written in the argument list gets a road from the call that hands it over', needs('typescript'), async () => {
  const b = await tsb();
  const run = roadsOf(b, 'runTwice', 'call').filter(([, r]) => r.prov.how === 'callback');
  assert.equal(run.length, 1);
  assert.equal(run[0][1].prov.tier, 'proven', 'again() calls its parameter twice, so it runs the callback');
  assert.equal(run[0][1].prov.callback.run, true);
  const each = roadsOf(b, 'eachOne', 'call').filter(([, r]) => r.prov.how === 'callback');
  assert.equal(each.length, 1);
  assert.equal(each[0][1].prov.tier, 'may', 'a callback handed to code outside the project is only a possible run');
  const claim = claimsOf(b, 'eachOne', 'call-road').find((c) => /anon/.test(c.says));
  assert.equal(claim?.conf, 'not-confident');
  assert.equal(claim?.reason, 'callback-handed-over');
});

test('callbacks: a closure that does nothing the map shows gets no box of its own', needs('typescript'), async () => {
  const b = await build('fixes_ts', { ts: true });
  assert.equal(boxesOf(b, 'eachOne.<anon@47>').length, 1, 'this one calls a project function, so it has its box');
  const { P } = b.res;
  assert.ok(P.fids.some((f) => f.endsWith('::again')));
});

test('every call a resolver pinned to a project function has its road (TypeScript)', needs('typescript'), async () => {
  assert.deepEqual(callsWithoutRoad(await tsb()), []);
});

test('default export: a function nobody names is an entry only when it is not the default export of its module', needs('typescript'), async () => {
  const b = await tsb();
  const panel = claimsOf(b, 'renderPanel', 'entry')[0];
  assert.notEqual(panel.conf, 'confident', 'importers give a default export a name of their own');
  assert.equal(panel.reason, 'entry-with-open-ends');
  assert.equal(claimsOf(b, 'renderSide', 'entry')[0].conf, 'confident', 'the same function without the default export is still an entry');
});

test('text: titles are cut on code points, so a long emoji string never leaves half a character', needs('typescript'), async () => {
  const smile = String.fromCodePoint(0x1f600);
  const long = smile.repeat(120);
  const files = { 'emo.ts': `import * as fs from 'fs';\nexport function say(x: string): void {\n  if (x === "a${long}") { fs.writeFileSync('o.txt', "${long}"); }\n}\n` };
  const b = await buildFiles(files, { ts: true });
  const broken = [];
  (function walk(v, at) {
    if (typeof v === 'string') { if (!v.isWellFormed() || v.includes('\ufffd')) broken.push(at); } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, at + '.' + k);
  })({ model: b.res.model, claims: b.res.claims, ir: b.sys.ir.ts }, '');
  assert.deepEqual(broken.slice(0, 3), [], 'no string holds half of a surrogate pair or a replacement character');
  const dec = b.res.model.boxes.find((x) => x.kind === 'decision');
  assert.ok(dec && [...dec.title].length <= 90 && dec.title.endsWith('...'), `the title is cut at ${[...dec.title].length} code points`);
});

test('text: a call chain deeper than the stack is left out and the header says so, instead of stopping the run', needs('typescript'), async () => {
  const chain = 'x' + '.m()'.repeat(6000);
  const files = { 'deep.ts': `declare const x: any;
export function deep(): void {
  ${chain};
}
`, 'ok.ts': TS_HEAD + FN };
  const b = await buildFiles(files, { ts: true });
  const unread = JSON.stringify(b.res.model.system.unread);
  assert.ok(/stack/.test(unread), `the header names what was not read: ${unread}`);
  assert.ok(b.res.model.boxes.some((x) => x.prov.fn.startsWith('ok.ts::')), 'the other file is still mapped');
});

// ---- Python ---------------------------------------------------------------------------------------------------------------------------
const py = () => build('fixes_py', { py: true });
const toFns = (rows) => rows.map(([, , t]) => t.prov.fn.split('::')[1]);

test('swallowing manager: the work after a with whose __exit__ returns True is on the map; after one that does not, it is not', needs('python', 'checker'), async () => {
  const b = await py();
  assert.ok(toFns(roadsOf(b, 'hushed', 'call')).includes('stamp'), 'the manager swallows the error, so the stamp after it runs');
  assert.ok(!toFns(roadsOf(b, 'plain', 'call')).includes('stamp'), 'a manager that lets the error through leaves the stamp unreachable');
});

test('a call that never returns: the arm that ends in it raises, it does not carry on', needs('python', 'checker'), async () => {
  const b = await py();
  const dec = boxesOf(b, 'pick', { rule: 'decision' })[0];
  const arm = dec.prov.folded_exits.find((e) => e.when === 'flag');
  assert.equal(arm.class, 'raise:*');
  assert.equal(arm.rt, 'unknown');
  assert.ok(!dec.prov.folded_exits.some((e) => e.class === 'continues'));
});

test('work after a call that never returns in the same block has no road', needs('python', 'checker'), async () => {
  const b = await py();
  const fns = toFns(roadsOf(b, 'after_stop', 'call'));
  assert.deepEqual(fns, ['always_fails']);
});

test('a condition that does work is a decision, and says what it does', needs('python', 'checker'), async () => {
  const b = await py();
  const dec = boxesOf(b, 'purge', { rule: 'decision' });
  assert.equal(dec.length, 1, 'one decision, not a step with a single road');
  assert.ok(dec[0].prov.test_effects.includes('delete'), 'the condition deletes');
  const eff = claimsOf(b, 'purge', 'effect').find((c) => c.says === 'does delete');
  assert.equal(eff?.conf, 'confident');
  assert.equal(eff?.line, 62, 'the claim cites the line of the call');
});

test('a road to a stub that has overrides is only possible', needs('python', 'checker'), async () => {
  const b = await py();
  const rows = roadsOf(b, 'Worker.go', 'call');
  const stub = rows.find(([, , t]) => t.prov.fn.endsWith('::Worker.step'));
  const over = rows.find(([, , t]) => t.prov.fn.endsWith('::Impl.step'));
  assert.equal(stub[1].prov.tier, 'may');
  assert.equal(stub[1].prov.stub_with_overrides, true);
  assert.equal(over[1].prov.tier, 'may');
  const claim = claimsOf(b, 'Worker.go', 'call-road').find((c) => c.says.endsWith('Worker.step') || /Worker\.step/.test(c.says));
  assert.equal(claim.conf, 'not-confident');
  assert.equal(claim.reason, 'stub-with-overrides');
});

test('an ending that leaves through a finally has a road to it', needs('python', 'checker'), async () => {
  const b = await py();
  const fin = boxesOf(b, 'must_clean').find((x) => x.kind === 'store');
  const end = boxesOf(b, 'must_clean', { kind: 'end' })[0];
  const dec = boxesOf(b, 'must_clean', { rule: 'decision' })[0];
  const to = (from) => roadsOf(b, 'must_clean', 'cfg-edge').filter(([a, r, t]) => a.id === from.id && t.id === fin.id);
  assert.equal(to(end).length, 1, 'the raise reaches the finally');
  assert.equal(to(end)[0][1].prov.via_finally, 84);
  assert.deepEqual(end.prov.runs_finally, [87]);
  assert.equal(to(dec).length, 1, 'and so does the return on the other arm');
  assert.ok(to(dec)[0][1].when.endsWith('then the finally block'));
});

test('callbacks: a function name handed to a project function that calls its parameter is a proven road; one handed to a thread is possible', needs('python', 'checker'), async () => {
  const b = await py();
  const drive = roadsOf(b, 'drive', 'call').find(([, r, t]) => r.prov.how === 'callback' && t.prov.fn.endsWith('::helper'));
  assert.equal(drive[1].prov.tier, 'proven');
  assert.equal(drive[1].prov.callback.kind, 'named');
  const start = roadsOf(b, 'Poller.start', 'call').find(([, r, t]) => r.prov.how === 'callback' && t.prov.fn.endsWith('::Poller.work'));
  assert.equal(start[1].prov.tier, 'may');
  assert.equal(start[1].prov.draw, 'thin');
});

test('every call a resolver pinned to a project function has its road (Python)', needs('python', 'checker'), async () => {
  assert.deepEqual(callsWithoutRoad(await py()), []);
});

// ---- Lua -----------------------------------------------------------------------------------------------------------------------------
test('a Lua condition that deletes is a decision that says so', needs('lua'), async () => {
  const b = await build('fixes_lua', { lua: true });
  const dec = boxesOf(b, '<module>', { rule: 'decision' });
  assert.equal(dec.length, 1);
  assert.ok(dec[0].prov.test_effects.includes('delete'));
});

// ---- files that only start or build the project ---------------------------------------------------------------------------------------
test('a function named only by a Makefile, a Procfile, a Dockerfile or a CI file is not "nothing calls it"', needs('python', 'checker'), async () => {
  const b = await build('fixes_outside', { py: true, include: ['src/**'] });
  for (const name of ['entry_make', 'entry_proc', 'entry_dock', 'entry_ci']) {
    const c = claimsOf(b, name, 'entry')[0];
    assert.equal(c.conf, 'not-confident', name);
    assert.equal(c.reason, 'named-outside-the-mapped-folder', name);
  }
  const none = claimsOf(b, 'entry_nowhere', 'entry')[0];
  assert.equal(none.conf, 'confident', 'a function that nothing names is still said to have no caller');
});
