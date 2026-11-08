// Truth tests: false statements the map must never make with no doubt. Each fixture is a small invented project whose behaviour is settled by the
// language rules (or by running it); the tests read the finished model and claim register of that fixture.
// The ones that need the Python checker, TypeScript or Lua skip themselves when this machine has none (see helpers.mjs).
import { needs as needsOf } from './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilities, build, boxesOf, roadsOf, claimsOf, handlerDisposition } from './lib/map-helpers.mjs';
import { buildClaims } from '../src/map/claims.mjs';
import { alwaysRaises } from '../src/map/heard3.mjs';
import { CASES, FIXTURES } from './lib/map-nasty-cases.mjs';

const cap = await capabilities();
const needs = (...what) => needsOf(cap, ...what);
const py = () => build('truth_py', { py: true });
const tsb = () => build('truth_ts', { ts: true });
const outside = () => build('truth_outside', { py: true, include: ['src/**'] });

/** Call, link and exception roads whose cited line cannot run after the road's start box (over every edge of the function). */
function startReachViolations(b) {
  const { P, M } = b.res;
  const bad = [];
  for (const [rid, r] of M.roads) {
    const pv = r.prov;
    if (!['call', 'link', 'exc-edge'].includes(pv.rule) || M.boxes.get(r.from).fn !== pv.fn) continue;
    const fid = pv.fn;
    let ls = new Set(pv.lines ?? (pv.line ? [pv.line] : []));
    if (pv.rule === 'exc-edge') ls = new Set([...(pv.witness ?? []).map((w) => w.line), ...(pv.untyped_call_lines ?? [])]);
    const succ = new Map();
    const link = (a, c) => { if (!succ.has(a)) succ.set(a, new Set()); succ.get(a).add(c); };
    for (const [a, c] of P.fns.get(fid).edges) link(a, c);
    for (const [a, rl] of M.red.get(fid).rland) for (const c of [...rl.caught, ...rl.finals]) link(a, c);
    const start = [...M.n2b(fid)].filter(([, bx]) => bx === r.from).map(([n]) => n);
    const seen = new Set(start);
    const q = [...start];
    while (q.length) for (const y of succ.get(q.pop()) ?? []) if (!seen.has(y)) { seen.add(y); q.push(y); }
    const tg = P.fns.get(fid).nodes.filter((nd) => (nd.ops ?? []).some((op) => ls.has(op.line)) || ls.has(nd.line)).map((nd) => nd.i);
    if (tg.length && !tg.some((i) => seen.has(i))) bad.push([rid, pv.anchor, [...ls]]);
  }
  return bad;
}

// ---- T1: a guard with one arm is a decision ----------------------------------------------------------------------------------
test('T1 a guard with one arm is a decision', needs('python'), async () => {
  const d = boxesOf(await py(), 'guard').filter((x) => x.kind === 'decision');
  assert.ok(d.length && d[0].prov.why === 'D');
});

// ---- T2a: a call above every box ------------------------------------------------------------------------------------------------
test('T2a a call above every box starts from a box of its own', needs('python'), async () => {
  const b = await py();
  const rs = roadsOf(b, 'starts_with_a_call', 'call').filter(([, , c]) => c.prov.fn.endsWith('::writer'));
  assert.ok(rs.length, 'the call to writer must have a road');
  const firstDecision = boxesOf(b, 'starts_with_a_call').find((x) => x.kind === 'decision');
  for (const [a, r] of rs) {
    assert.notEqual(r.prov.anchor, 'before');
    assert.ok(a.title.startsWith('begins'), a.title);
    assert.ok(a.prov.line < firstDecision.prov.line);
  }
});

test('T2a no call road cites a line its start box cannot reach', needs('python'), async () => {
  assert.deepEqual(startReachViolations(await py()).slice(0, 3), []);
});

test('T2a a road on a stand-in box is never confident', needs('python'), async () => {
  const b = await py();
  const { M } = b.res;
  const [rid, road] = [...M.roads].find(([, r]) => r.prov.rule === 'call' && r.prov.tier === 'proven');
  const old = road.prov.anchor;
  road.prov.anchor = 'before';
  try {
    const c = buildClaims(M, null).filter((x) => x.id === 'r:' + rid);
    assert.ok(c.length && c[0].conf !== 'confident' && c[0].reason === 'road-starts-on-a-stand-in-box', JSON.stringify(c));
  } finally {
    road.prov.anchor = old;
  }
});

// ---- T2b: roads past a call that cannot return ----------------------------------------------------------------------------------------
test('T2b no road leaves an arm that ends in a call that never returns', needs('python'), async () => {
  const b = await py();
  for (const fn of ['arm_then_die', 'arm_then_exit']) {
    for (const [a, , c] of roadsOf(b, fn, 'call')) if (c.prov.fn.endsWith('::second_sink')) assert.equal(a.kind, 'decision', `${fn}: a road to second_sink leaves ${a.kind} ${a.title}`);
  }
});

test('T2b a never-typed call ends the arm in TypeScript', needs('typescript'), async () => {
  const b = await tsb();
  for (const [a, , c] of roadsOf(b, 'armThenFail', 'call')) if (c.prov.fn.endsWith('::nextOne')) assert.equal(a.kind, 'decision');
});

test('T2b never-returns is decided by whether the exit can be reached', needs('python'), async () => {
  const ids = new Set([...(await py()).res.P.never].map((f) => f.split('::')[1]));
  assert.ok(ids.has('die') && !ids.has('writer') && !ids.has('starts_with_a_call'), [...ids].join(','));
});

test('T2b a return out of nested finally blocks is not flagged as always raising', needs('python'), async () => {
  const { P, F } = (await py()).res;
  const fid = P.fids.find((f) => f.endsWith('::nested_finally'));
  assert.ok(!alwaysRaises(F, fid), 'it returns writer(path)');
  const fn = P.fns.get(fid);
  assert.ok(fn.edges.some((e) => e[1] === fn.exit), 'a return that leaves two finally blocks reaches the exit');
});

// ---- T2c: heard by the caller ---------------------------------------------------------------------------------------------------------
test('T2c a handler that returns a default or retries tells the caller nothing', needs('python'), async () => {
  const b = await py();
  assert.notEqual(handlerDisposition(b, 'returns_default'), 'return');
  assert.notEqual(handlerDisposition(b, 'retries'), 'return');
  assert.equal(handlerDisposition(b, 'returns_the_error'), 'return');
});

test('T2c "heard by caller" is confident only when the returned value carries the error', needs('python'), async () => {
  const b = await py();
  const h = Object.fromEntries(['raise_for_default', 'raise_for_error', 'raise_then_redo'].map((fn) => [fn, claimsOf(b, fn, 'hears')]));
  assert.ok(h.raise_for_default.length && h.raise_for_default.every((c) => c.conf !== 'confident'));
  assert.ok(h.raise_then_redo.length && h.raise_then_redo.every((c) => c.conf !== 'confident'));
  assert.ok(h.raise_for_error.length && h.raise_for_error.some((c) => c.conf === 'confident'));
});

// ---- T2d: waits that do not wait ----------------------------------------------------------------------------------------------------
test('T2d an unawaited coroutine waits for nothing (Python)', needs('python', 'checker'), async () => {
  const b = await py();
  assert.ok(claimsOf(b, 'awaited', 'wait').some((c) => c.conf === 'confident'), 'the awaited sleep is a wait');
  assert.ok(!claimsOf(b, 'not_awaited', 'wait').some((c) => c.conf === 'confident'));
});

test('T2d Promise.all without await waits for nothing', needs('typescript'), async () => {
  const b = await tsb();
  assert.ok(claimsOf(b, 'awaited', 'wait').some((c) => c.conf === 'confident'), 'the awaited Promise.all is a wait');
  assert.ok(!claimsOf(b, 'notAwaited', 'wait').some((c) => c.conf === 'confident'));
});

// ---- T2e: the mapped folder ----------------------------------------------------------------------------------------------------------------
test('T2e a name used only outside the mapped folder is not called unnamed', needs('python', 'checker'), async () => {
  const b = await outside();
  const entries = new Map(b.res.claims.filter((c) => c.type === 'entry').map((c) => [c.fn.split('::')[1], c]));
  const only = entries.get('only_tests_call_this');
  assert.ok(only.conf !== 'confident' && only.reason === 'named-outside-the-mapped-folder', JSON.stringify(only));
  assert.ok(only.why.includes('tests/test_mod.py'), only.why);
  assert.equal(entries.get('nobody_names_this').conf, 'confident', 'a name nobody uses anywhere is still a confident absence');
  const neg = b.res.claims.filter((c) => c.type === 'negative' && c.says.includes('names this function')).find((c) => c.fn.endsWith('::only_tests_call_this'));
  assert.notEqual(neg.conf, 'confident');
});

test('T2e the words say mapped folder, not project', needs('python'), async () => {
  const all = [...(await outside()).res.claims, ...(await py()).res.claims];
  for (const c of all) assert.ok(!c.says.includes('in the project') && !c.why.includes('in the project'), c.says);
  assert.ok(all.some((c) => c.says.includes('mapped folder')));
});

test('T2e a flag never cleared names a file and a line', needs('python'), async () => {
  const f = (await outside()).res.claims.filter((c) => c.finding === 'flag_never_cleared');
  assert.ok(f.length, 'the flag set to true and never cleared must be listed');
  assert.ok(f[0].path === 'src/mod.py' && f[0].line === 3 && f[0].says.includes('src/mod.py:3'), JSON.stringify(f[0]));
});

// ---- T3: handler vocabulary ----------------------------------------------------------------------------------------------------------------
test('T3 reading the error is not recording it', needs('python'), async () => {
  const b = await py();
  assert.notEqual(handlerDisposition(b, 'reads_only'), 'record');
  assert.equal(handlerDisposition(b, 'Holder.keeps_it'), 'record');
});

test('T3 handing the error to a function that never returns is not a label', needs('python'), async () => {
  assert.equal(handlerDisposition(await py(), 'hands_to_a_thrower'), 'unknown');
});

test('T3 only a plain class name is a handler type the tool can reason about', needs('python'), async () => {
  const { F } = (await build('nasty_py_b', { py: true })).res;
  for (const u of ['ERRS', 'handled_types()', 'socket.error', 'os.error', 'Errs.Bad', 'ValueErrorAlias', 'json.JSONDecodeError']) assert.ok(!F.knownHandlerType(u, new Set()), u);
  for (const u of ['ValueError', 'OSError', 'ProjectBase', 'KeyError']) assert.ok(F.knownHandlerType(u, new Set()), u);
  assert.equal(F.catchKind(['ERRS'], 'ValueError', new Set()), 'maybe');
  assert.equal(F.catchKind(['KeyError'], 'ValueError', new Set()), 'no');
  assert.equal(F.catchKind(['Exception'], 'ValueError', new Set()), 'yes');
});

// ---- T4: statements that are untrue in the language or when run: each is flagged or not made --------------------------------------------------------------------
CASES.forEach(([fx, fn, type, rx, what, line], i) => {
  const { dir, langs } = FIXTURES[fx];
  const need = Object.keys(langs).map((l) => ({ py: 'python', ts: 'typescript', lua: 'lua' })[l]);
  test(`T4 ${String(i).padStart(2, '0')} ${fx} ${fn.split('::').pop()} ${type}`, needs(...need, ...(langs.py ? ['checker'] : [])), async () => {
    const b = await build(dir, langs);
    const bad = b.res.claims.filter((c) => c.fn.endsWith(fn) && c.type === type && new RegExp(rx).test(c.says) && (line === undefined || c.line === line) && c.conf === 'confident');
    assert.deepEqual(bad.map((c) => [c.says, c.reason]).slice(0, 2), [], `still said with no doubt: ${what}`);
  });
});
