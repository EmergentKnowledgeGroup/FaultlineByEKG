// Waits, holds and failures, the parts that need no browser: waitsFor, what can hold up the main path, failures by who hears, the numbers (main path, stage roads, switches), part numbering,
// the silent-failure rule for refusals. (The page itself is checked in test/viewer.verify.mjs, section fails-and-holds.)
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { chartsFromModel, toAtlasData } from '../src/build/index.mjs';
import { countsOf } from '../src/build/counts.mjs';
import { breaksOf, partOrder } from '../src/build/atlasdata.mjs';
import { holdsOf } from '../src/build/holds.mjs';
import { silentBox } from '../src/model/heard.mjs';
import { waitsMap, waitIssues } from '../src/model/waits.mjs';
import { validateModel } from '../src/model/index.mjs';

// two stages; a main path with a wait, a gate and a loop on it (and one box passed twice); a wait for a person and a wait for a machine off the path
function system(extra = {}) {
  const b = (id, stage, kind, x = {}) => ({ id, stage, kind, title: id, plain: `${id} does its part.`, status: 'live', refs: [{ path: 'a.py', symbol: 'a.py::f', line: 1 }], ...x });
  const boxes = [
    b('s.start', 's1', 'step'), b('s.gate', 's1', 'gate'), b('s.lock', 's1', 'wait', { failure: 'The turn queues behind the lock.' }), b('s.work', 's1', 'step'), b('s.ask', 's1', 'wait'), b('s.menu', 's1', 'wait'),
    b('t.run', 's2', 'step'), b('t.again', 's2', 'decision'), b('t.ok', 's2', 'end', { outcome: 'success' }),
    b('t.bad', 's2', 'end', { outcome: 'failure' }), b('t.no', 's2', 'end', { outcome: 'refusal' }), b('t.no2', 's2', 'end', { outcome: 'refusal' }), b('t.err', 's2', 'step'), b('t.fail2', 's2', 'end', { outcome: 'failure' }),
  ];
  const r = (id, from, to, type = 'forward', when = 'ok') => ({ id, from, to, type, when });
  const routes = [r('r1', 's.start', 's.gate'), r('r2', 's.gate', 's.lock'), r('r3', 's.lock', 's.work'), r('r4', 's.work', 't.run'), r('r5', 't.run', 't.again'), r('r6', 't.again', 't.run', 'return', 'try again'), r('r7', 't.again', 't.ok', 'forward', 'done'),
    r('r8', 't.run', 't.bad', 'forward', 'throws'), r('r9', 't.run', 't.no', 'forward', 'refused'), r('r10', 's.work', 's.ask'), r('r11', 's.ask', 's.menu'), r('r12', 't.run', 't.no2', 'forward', 'also refused'), r('r13', 't.run', 't.err'), r('r14', 't.err', 't.fail2', 'forward', 'dies')];
  return { schema: 'faultline.model/1', system: { name: 'Toy' }, stages: [{ id: 's1', title: 'One', order: 1 }, { id: 's2', title: 'Two', order: 2 }], boxes, routes,
    loops: [{ id: 'l_try', title: 'Try again', boxes: ['t.run', 't.again'], limit: 'three tries' }, { id: 'l_none', title: 'Never stops', boxes: ['s.work', 's.ask'], limit: '' }],
    paths: [{ id: 'main', title: 'Main path', boxes: ['s.start', 's.gate', 's.lock', 's.work', 't.run', 't.again', 't.run', 't.ok'] }, { id: 'p2', title: 'A job is refused', boxes: ['s.work', 't.run', 't.no'] }],
    charts: [], terms: [], ledger: {}, modules: {}, ...extra };
}

test('silentBox: a refusal nobody hears is as bad as a failure; a logged refusal is not; a success or a neutral ending never is', () => {
  const nobody = { by: 'nobody' }, log = { by: 'log' };
  assert.equal(silentBox({ outcome: 'failure' }, nobody), true); assert.equal(silentBox({ outcome: 'refusal' }, nobody), true);
  assert.equal(silentBox({ outcome: 'failure' }, log), true); assert.equal(silentBox({ outcome: 'refusal' }, log), false);
  assert.equal(silentBox({ outcome: 'success' }, nobody), false); assert.equal(silentBox({ outcome: 'neutral' }, nobody), false);
  assert.equal(silentBox({}, nobody), true, 'a step with no outcome can fail quietly');
  assert.equal(silentBox({ outcome: 'failure' }, { by: 'caller' }), false);
  const m = system({ heardBy: { 't.bad': { by: 'log', how: 'a line' }, 't.no': { by: 'nobody', how: 'the click shows nothing' }, 't.no2': { by: 'log' }, 't.fail2': { by: 'caller' } } });
  const rows = breaksOf(m, []).filter((x) => x.state === 'silent').map((x) => x.boxes[0]).sort();
  assert.deepEqual(rows, ['t.bad', 't.no'], 'the logged refusal and the caller-told failure are not silent');
});

test('waitsFor: a clean map, and W-waits for a box that is not there, one that is not a wait, an unknown "on"', () => {
  const m = system({ waitsFor: { 's.ask': { on: 'person', how: 'a click' }, 's.lock': { on: 'machine', how: 'a lock' }, 'nope': { on: 'person' }, 's.work': { on: 'person' }, 's.menu': { on: 'weather' } } });
  const w = waitsMap(m);
  assert.deepEqual(Object.keys(w).sort(), ['nope', 's.ask', 's.lock', 's.work'], 'an unknown "on" is dropped');
  const kinds = waitIssues(m).map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['bad-on', 'not-a-wait', 'unknown-box']);
  assert.deepEqual(waitIssues(system()), [], 'no waitsFor, no warning');
  assert.equal(validateModel(system({ waitsFor: { 's.ask': { on: 'person' } } })) != null, true);
});

test('a wait for a person has its own group, is not counted in the things to look at, and a wait with no entry is treated as before', () => {
  const none = system(), some = system({ waitsFor: { 's.ask': { on: 'person', how: 'owner clicks' }, 's.menu': { on: 'person' }, 's.lock': { on: 'machine', how: 'an RLock, no timeout' } } });
  const a = breaksOf(none, []), b = breaksOf(some, []);
  assert.equal(a.filter((x) => x.state === 'person').length, 0, 'absent data: never guessed from the words');
  assert.equal(b.filter((x) => x.state === 'person').length, 2);
  const ca = countsOf(none, { breaks: a }), cb = countsOf(some, { breaks: b });
  assert.equal(cb.breaks.person, 2);
  assert.equal(cb.breaks.look, cb.breaks.kept + cb.breaks.open + cb.breaks.waits + cb.breaks.loops + cb.breaks.silent, 'to look at = the parts, no person waits in it');
  assert.equal(ca.breaks.waits - cb.breaks.waits, 2, 'the two person waits left the waits-with-no-timeout section');
  assert.deepEqual(cb.waits, { boxes: 3, said: 3, notSaid: 0, person: 2, machine: 1, outside: 0, time: 0 });
  const lock = b.find((x) => x.boxes[0] === 's.lock');
  assert.equal(lock.on, 'machine'); assert.equal(lock.how, 'an RLock, no timeout');
  const d = toAtlasData(some, { charts: chartsFromModel(some) });
  assert.equal(d.charts.whole.nodes['s.ask'].waits.on, 'person'); assert.equal(d.charts.whole.nodes['s.work'].waits, undefined);
  assert.ok(d.meta.waitWords.person);
});

test('holdsOf: the main path\'s own waits, gates and loops, in path order, each with its state; a dismissed one stays', () => {
  const m = system({ waitsFor: { 's.lock': { on: 'machine', how: 'an RLock, no timeout' } } });
  const findings = [{ key: 'wait-no-wake:s.lock', check: 'wait-no-wake', boxes: ['s.lock'], routes: [], question: 'What ends this wait?', evidence: 'e', cluster: 's1', resolution: { state: 'dismissed', why: 'the holder is bounded by its deadlines' } },
    { key: 'no-limit-loop:l_none', check: 'no-limit-loop', boxes: ['s.work', 's.ask'], routes: [], question: 'What stops this loop?', evidence: 'e', cluster: 's1', resolution: { state: 'suspect', why: 'a person never answers' } }];
  const breaks = breaksOf(m, findings), h = holdsOf(m, breaks);
  assert.deepEqual(h.map((x) => [x.kind, x.id, x.step]), [['gate', 's.gate', 2], ['wait', 's.lock', 3], ['loop', 'l_none', 4], ['loop', 'l_try', 5]], 'path order; the wait that is not on the path (s.ask) is not here');
  const lock = h.find((x) => x.id === 's.lock');
  assert.equal(lock.state, 'dismissed'); assert.equal(lock.why, 'the holder is bounded by its deadlines'); assert.equal(lock.how, 'an RLock, no timeout'); assert.equal(lock.on, 'machine');
  assert.equal(h.find((x) => x.id === 'l_none').state, 'kept'); assert.equal(h.find((x) => x.id === 'l_none').limit, '');
  assert.equal(h.find((x) => x.id === 'l_try').state, 'none'); assert.equal(h.find((x) => x.id === 'l_try').limit, 'three tries');
  assert.equal(h.find((x) => x.id === 's.gate').state, 'none');
  const c = countsOf(m, { breaks });
  assert.deepEqual([c.holds.total, c.holds.wait, c.holds.gate, c.holds.loop, c.holds.dismissed, c.holds.kept, c.holds.none], [4, 1, 1, 2, 1, 1, 2]);
  assert.equal(h.length, toAtlasData(m, { charts: chartsFromModel(m), findings }).holds.length, 'the page gets the same rows');
  assert.deepEqual(holdsOf({ ...m, paths: [] }, []), [], 'no declared main path, nothing to read');
});

test('countsOf: the main path says steps and different boxes; failures by who hears; stage roads and switches are defined once', () => {
  const m = system({ heardBy: { 't.bad': { by: 'caller' }, 't.no': { by: 'nobody' }, 't.fail2': { by: 'event' }, 't.err': { by: 'event' } } });
  m.boxes.find((x) => x.id === 's.lock').switch = 'lock.enabled'; m.boxes.find((x) => x.id === 's.ask').status = 'off'; m.boxes.find((x) => x.id === 's.ask').switch = 'ask.on'; m.boxes.find((x) => x.id === 's.menu').status = 'default-on'; m.boxes.find((x) => x.id === 't.err').status = 'test-only';
  const c = countsOf(m);
  assert.deepEqual(c.mainPath, { steps: 8, boxes: 7, stages: 2 }, 't.run is passed twice: 8 steps, 7 different boxes');
  assert.equal(c.fails.failure, 2); assert.equal(c.fails.refusal, 2); assert.equal(c.fails.steps, 1, 'a step the model says reports a failure and carries on');
  assert.equal(c.fails.total, 5); assert.equal(c.fails.by.caller, 1); assert.equal(c.fails.by.nobody, 1); assert.equal(c.fails.by.event, 2); assert.equal(c.fails.by.unsaid, 1, 't.no2 has no entry: not said yet, never guessed');
  assert.equal(Object.values(c.fails.by).reduce((a, x) => a + x, 0), c.fails.total, 'the counts by value add up to the total');
  assert.equal(c.fails.reachPerson, 0);
  const sr = c.stageRoads;
  assert.equal(sr.s1.boxes + sr.s2.boxes, c.boxes);
  assert.equal(sr.s1.inside + sr.s2.inside + sr.s1.leave + sr.s2.leave, c.roads, 'every road is inside a stage or leaves one');
  assert.equal(sr.s1.leave, sr.s2.enter); assert.equal(sr.s2.leave, sr.s1.enter);
  assert.equal(c.switches.boxes, c.switches.off + c.switches.testOnly + c.switches.defaultOn + c.switches.liveNamed, 'switches = off + test only + on by default + live ones that name a switch');
  assert.equal(c.switches.liveNamed, 1); assert.equal(c.switches.off, 1);
});

test('overview: "N stages; the main path runs through K of them", and a loop knows its boxes in all', () => {
  const m = system(), d = toAtlasData(m, { charts: chartsFromModel(m) });
  const ov = Object.values(d.charts).find((c) => c.kind === 'overview');
  assert.match(ov.navSub, /^2 stages; the main path runs through 2 of them$/);
  assert.doesNotMatch(JSON.stringify(ov.navSub), /from start to end/);
});

test('partOrder: part 1 is the part the stage opens on (where the main path enters, else the biggest real one); weak parts last; ids never change', () => {
  const mk = (id, n, r, ids) => ({ id, kind: 'stage', stage: 's1', part: 0, parts: 4, boxes: (ids || Array.from({ length: n }, (_, i) => id + i)).map((x) => ({ id: x })), routes: Array.from({ length: r }, (_, i) => ({ id: id + 'r' + i })) });
  const cs = [mk('a', 1, 0), mk('b', 3, 2), mk('c', 9, 8), mk('d', 4, 3), mk('e', 12, 0)];
  const none = partOrder(cs);
  assert.deepEqual(none.charts.map((c) => c.id), ['c', 'd', 'b', 'a', 'e'], 'no main path: biggest real part first, then the others biggest first, the weak ones last (in their order)');
  assert.equal(none.partNo.get('c'), 1);
  const withMain = partOrder(cs, ['d0', 'c0']);
  assert.equal(withMain.partNo.get('d'), 1, 'the part where the main path enters is part 1');
  assert.deepEqual(withMain.charts.map((c) => c.id), ['d', 'b', 'c', 'a', 'e'], 'the real parts keep their reading order after it');
  assert.deepEqual(new Set(withMain.charts.map((c) => c.id)), new Set(cs.map((c) => c.id)), 'no chart id changes');
});
