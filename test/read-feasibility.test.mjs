// A journey is a run: every step must be able to follow the one before it. These tests build invented code (fixtures/read/desk), read it, and check each journey
// against the control-flow graph of the same code, which the reading rules never see.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSystem } from '../src/read/index.mjs';
import { deskModel, deskGraphs, impossibleSteps, fid } from './lib/read-mini.mjs';
import { endingVisit, finishOf } from '../src/read/journeys.mjs';
import { armEnd, caseRanges, deriveStructure } from '../src/read/structure.mjs';
import { Source } from '../src/read/source.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'read', 'desk');
const read = (opts) => {
  const m = deskModel(undefined, opts);
  return readSystem({ model: m.model, claims: m.claims, facts: m.facts, sourceRoot: ROOT, name: 'desk' });
};
const variants = [['with the scanner facts', { withFacts: true }], ['with no scanner facts at all', { withFacts: false }]];

for (const [label, opts] of variants) {
  test(`no step of any journey is impossible on the control-flow graph (${label})`, () => {
    const r = read(opts);
    const graphs = deskGraphs();
    assert.ok(r.reading.journeys.list.length >= 2, 'there are journeys to check');
    for (const j of r.reading.journeys.list) assert.deepEqual(impossibleSteps(j, graphs), [], `${j.name} follows the graph`);
  });

  test(`a check that raises is passed, one arm of an if/elif chain is taken, and a switch takes one case (${label})`, () => {
    const r = read(opts);
    const handle = r.reading.journeys.list.find((j) => j.trigger.fn === fid('handle'));
    assert.ok(handle, 'a journey from handle');
    const lines = handle.steps.filter((s) => s.line).map((s) => `${s.fid ?? ''}${s.line}`);
    assert.ok(!handle.steps.some((s) => s.kind === 'end' && s.title.startsWith('Fails with') && s.depth === 0), 'the check that raises is not taken');
    const refunded = handle.steps.some((s) => s.kind === 'end' && s.line === 7);
    const closed = handle.steps.some((s) => s.kind === 'end' && s.line === 10);
    assert.ok(refunded !== closed || (!refunded && !closed), 'at most one of the two arms ends the run');
    const calls = handle.steps.filter((s) => s.kind === 'enter' && s.depth === 1).map((s) => s.fn);
    assert.ok(!(calls.includes('refund') && calls.includes('close')), 'refund and close are not both run');
    void lines;
    const dispatch = r.reading.journeys.list.find((j) => j.trigger.fn === fid('dispatch'));
    if (dispatch) {
      const ran = dispatch.steps.filter((s) => s.kind === 'enter' && s.depth === 1).map((s) => s.fn);
      assert.ok(ran.filter((x) => ['openTicket', 'closeTicket', 'ignore'].includes(x)).length <= 1, 'one case of the switch runs');
      assert.ok(dispatch.steps.some((s) => s.kind === 'note' && /choice among 3 cases/.test(s.text)), 'the choice of case is said');
    }
  });

  test(`a request ends at the ending for its own route, not at a box shared by every route (${label})`, () => {
    const r = read(opts);
    const close = r.reading.journeys.list.find((j) => j.trigger.kind === 'route' && /close/.test(j.name));
    const refund = r.reading.journeys.list.find((j) => j.trigger.kind === 'route' && /refund/.test(j.name));
    assert.ok(close && refund, 'one journey per route');
    const endOf = (j) => j.steps.find((s) => s.final);
    assert.equal(endOf(close)?.line, 53);
    assert.equal(endOf(refund)?.line, 51);
    assert.notEqual(endOf(close).title, 'Ends 2 ways');
  });

  test(`a journey ends at a named ending or says plainly that it stopped, and has a short version (${label})`, () => {
    const r = read(opts);
    for (const j of r.reading.journeys.list) {
      const last = j.steps[j.steps.length - 1];
      assert.ok(last.final || last.kind === 'finish' || j.steps.some((s) => s.final), `${j.name} ends or says it stopped`);
      if (last.kind === 'finish') assert.ok(/Stopped here, no ending reached|^Returns to | finishes$/.test(last.title), 'the stop is said');
      assert.ok(j.steps.some((s) => s.hl), 'a short version exists');
      assert.ok(j.stats.headline <= 25, 'the short version is short');
      assert.ok(!j.steps.some((s) => s.kind === 'more'), 'no "more steps not shown" line');
      assert.equal(j.steps[0].kind, 'enter');
      assert.equal(j.steps[0].depth, 0);
    }
  });
}

test('the main path is the first journey, ranked by what the README shows, and says so', () => {
  const r = read({ withFacts: true });
  const J = r.reading.journeys;
  assert.equal(J.ranking.by, 'examples');
  assert.match(J.ranking.rule, /README or quick-start examples/);
  assert.equal(J.main, 'j1');
  assert.equal(J.list[0].trigger.fn, fid('route'), 'the function the README calls comes first');
  assert.ok(J.list.findIndex((j) => j.trigger.fn === fid('handle')) > 0, 'a function no example shows comes after');
});

test('block structure is read from source: arms, handlers, cases, and how an arm ends', () => {
  const src = new Source(ROOT);
  const py = deriveStructure(src, 'desk.py', 1, 12, 'py');
  const first = py.branches.find((b) => b.line === 3);
  assert.deepEqual(first.then, [4, 4]);
  assert.equal(first.tt, 'raise');
  const chain = py.branches.find((b) => b.line === 5);
  assert.equal(chain.et, 'elif');
  assert.equal(armEnd(src, 'desk.py', chain.then), 'return');
  const ts = deriveStructure(src, 'ticket.ts', 1, 16, 'ts');
  const sw = ts.branches.find((b) => b.kind === 'match');
  assert.equal(caseRanges(src, 'ticket.ts', sw.then).length, 3);
  assert.equal(armEnd(src, 'ticket.ts', [3, 3]), 'return');
  assert.equal(armEnd(src, 'ticket.ts', [7, 8]), 'break');
});

test('a chain of last calls only counts when it reaches an ending', () => {
  const root = { items: [{ t: 'visit', visit: { items: [], ended: null } }], ended: null };
  assert.equal(endingVisit(root), root);
  const leaf = { items: [], ended: { box: 'b' } };
  const root2 = { items: [{ t: 'visit', visit: { items: [{ t: 'visit', visit: leaf }], ended: null } }], ended: null };
  assert.equal(endingVisit(root2), leaf);
});

test('a function that reaches its last line has an ending named plainly; "stopped here" is kept for a real break and gives its reason', () => {
  const run = (extra = {}) => ({ fid: 'a.ts::top', label: 'top', ended: null, raises: false, stuck: '', items: [], ...extra });
  const fin = (root, caller) => finishOf(root, [], caller);
  const noCaller = fin(run());
  assert.equal(noCaller.state, 'returned');
  assert.equal(noCaller.title, 'top finishes');
  assert.match(noCaller.plain, /last line/);
  const called = fin(run(), 'main');
  assert.equal(called.state, 'returned');
  assert.equal(called.title, 'Returns to main');
  assert.ok(!/Stopped here/.test(noCaller.title + noCaller.plain + called.title + called.plain));
  const stuck = fin(run({ stuck: 'it waits on a queue nobody feeds' }));
  assert.equal(stuck.state, 'stopped');
  assert.equal(stuck.title, 'Stopped here, no ending reached');
  assert.match(stuck.plain, /waits on a queue/);
  const broke = fin(run({ items: [{ t: 'break', reason: 'the map has no road here', line: 7 }] }));
  assert.equal(broke.state, 'stopped');
  assert.match(broke.plain, /no road here/);
  assert.equal(finishOf(run(), [{ final: true }]), null, 'a run that reached an ending box needs no finish');
});
