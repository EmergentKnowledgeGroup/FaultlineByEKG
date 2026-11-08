// Page data, the parts that need no browser: the data the guide pages read (src/build/atlasdata.mjs) and the sentence splitter the page shares with it.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chartsFromModel, toAtlasData } from '../src/build/index.mjs';
import { sentencesOf, sentenceClip, isJunkHandle, partOrder, breaksOf } from '../src/build/atlasdata.mjs';
import { makeModel } from '../src/place/synth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const model = (o) => { const m = makeModel(o); m.schema = 'faultline.model/1'; m.loops = m.loops || []; m.terms = []; m.ledger = {}; m.modules = {}; return m; };

const CASES = [
  ['The public call. Opens a span, copies metadata into opts.trace unless skipFlag is set, then tags it. Resolves with the Item.', ['The public call.', 'Opens a span, copies metadata into opts.trace unless skipFlag is set, then tags it.', 'Resolves with the Item.']],
  ['The worker loop checks every 0.25 s in the thread. It runs until stopped.', ['The worker loop checks every 0.25 s in the thread.', 'It runs until stopped.']],
  ['Use e.g. a shell script. See parcelworks/worker.py:32. Dr. Smith goes.', ['Use e.g. a shell script.', 'See parcelworks/worker.py:32.', 'Dr. Smith goes.']],
  ['Is it ready? Yes! Done... Then more.', ['Is it ready?', 'Yes!', 'Done...', 'Then more.']],
  ['No end mark here', ['No end mark here']],
  ['', []]
];
test('sentencesOf: a full stop ends a sentence only before a space and a capital; decimals, dotted names, file:line and abbreviations never split; nothing is dropped', () => {
  for (const [t, want] of CASES) assert.deepEqual(sentencesOf(t), want);
  for (const [t] of CASES) assert.equal(sentencesOf(t).join(' '), t.replace(/\s+/g, ' ').trim(), 'the pieces joined are the text');
});
test('sentenceClip: whole sentences up to the limit, else a word cut with an ellipsis; "0.25 s" is never read as "25 s"', () => {
  const t = 'The loop checks every 0.25 s while it runs. It finishes once someone stops the worker, or on Ctrl+C.';
  assert.equal(sentenceClip(t, 60), 'The loop checks every 0.25 s while it runs.');
  assert.ok(sentenceClip(t, 200).startsWith('The loop checks every 0.25 s'));
  assert.ok(sentenceClip('A single very long sentence without any stop that goes on and on and on', 30).endsWith('…'));
});
test('the page carries its own copy of the splitter: it gives the same answers as the build', () => {
  const src = fs.readFileSync(path.join(here, '..', 'viewer', 'viewer.js'), 'utf8');
  const a = src.indexOf('var ABBR_RX'), b = src.indexOf('var store = {');
  assert.ok(a > 0 && b > a, 'sentencesOf is in viewer.js');
  const page = new Function(src.slice(a, b) + '; return sentencesOf;')();
  for (const [t] of CASES) assert.deepEqual(page(t), sentencesOf(t), t);
});

test('isJunkHandle: literals are not names', () => {
  for (const h of ['1', '-1', '-1 -2 -3 -6 -9', 'true', 'false', 'undefined', 'null', 'OK', '0.5']) assert.equal(isJunkHandle(h), true, h);
  for (const h of ['claim', 'reclaim_expired', 'CUSTOMS_LIMIT_CENTS', 'Queue.claim', 'idof', 'main']) assert.equal(isJunkHandle(h), false, h);
});

test('partOrder: parts with one box or no road inside go last, and the parts are numbered in that order', () => {
  const mk = (id, n, r) => ({ id, kind: 'stage', stage: 's1', part: 0, parts: 4, boxes: Array.from({ length: n }, (_, i) => ({ id: id + i })), routes: Array.from({ length: r }, (_, i) => ({ id: id + 'r' + i })) });
  const cs = [mk('a', 1, 0), mk('b', 5, 4), mk('c', 3, 0), mk('d', 4, 3)], out = partOrder(cs);
  assert.deepEqual(out.charts.map((c) => c.id), ['b', 'd', 'a', 'c']);
  assert.equal(out.partNo.get('b'), 1); assert.equal(out.partNo.get('d'), 2); assert.equal(out.partNo.get('a'), 3); assert.equal(out.partNo.get('c'), 4);
});

test('breaksOf: every finding with its state, plus the waits and loops the map shows without a limit; no duplicates of what a finding already lists', () => {
  const m = {
    stages: [{ id: 's1', title: 'One', order: 1 }, { id: 's2', title: 'Two', order: 2 }],
    boxes: [{ id: 'a', title: 'A', stage: 's1', kind: 'step' }, { id: 'w', title: 'W', stage: 's1', kind: 'wait', plain: 'It sits here.' }, { id: 'w2', title: 'W2', stage: 's2', kind: 'wait', plain: 'It sits here.' }, { id: 'w3', title: 'W3', stage: 's2', kind: 'wait', plain: 'Polls every 5 s.' }, { id: 'b', title: 'B', stage: 's2', kind: 'step' }],
    routes: [{ id: 'r1', from: 'a', to: 'w', when: 'Always' }, { id: 'r2', from: 'a', to: 'w2', when: 'Always' }, { id: 'r3', from: 'a', to: 'w3', when: 'Always' }],
    loops: [{ id: 'l1', title: 'Loop one', boxes: ['a', 'b'], limit: '' }, { id: 'l2', title: 'Loop two', boxes: ['a', 'b'], limit: 'three tries' }, { id: 'l3', title: 'Loop three', boxes: ['a', 'b'], limit: '' }]
  };
  const findings = [
    { key: 'sticky-flag:x', check: 'sticky-flag', boxes: ['a'], routes: [], question: 'q1', evidence: 'e1', cluster: 's1', agree: 2, resolution: { state: 'suspect', why: 'kept' }, shown: true },
    { key: 'swallowed-error:y', check: 'swallowed-error', boxes: [], routes: [], question: 'q2', evidence: 'e2', cluster: 's2', lead: true },
    { key: 'pile-up:z', check: 'pile-up', boxes: ['b'], routes: [], question: 'q3', evidence: 'e3', cluster: 's2', resolution: { state: 'dismissed', why: 'on purpose' } },
    { key: 'hedged-route:o', check: 'hedged-route', boxes: ['a'], routes: [], question: 'q4', evidence: 'e4', cluster: 's1' },
    { key: 'wait-no-wake:w', check: 'wait-no-wake', boxes: ['w'], routes: [], question: 'q5', evidence: 'e5', cluster: 's1', resolution: { state: 'suspect', why: '' } },
    { key: 'no-limit-loop:l3', check: 'no-limit-loop', boxes: ['a', 'b'], routes: [], question: 'q6', evidence: 'e6', cluster: 's1' }
  ];
  const rows = breaksOf(m, findings), by = (s) => rows.filter((r) => r.state === s).map((r) => r.key);
  assert.deepEqual(by('suspect'), ['sticky-flag:x', 'wait-no-wake:w']);
  assert.deepEqual(by('lead'), ['swallowed-error:y']);
  assert.deepEqual(by('dismissed'), ['pile-up:z']);
  assert.deepEqual(by('open'), ['hedged-route:o', 'no-limit-loop:l3']);
  assert.deepEqual(by('wait'), ['wait:w2'], 'a wait with no time-based exit that no finding lists; a polling wait and a listed one are not repeated');
  assert.deepEqual(by('loop'), ['loop:l1'], 'a loop with no limit that no finding lists; a loop with a limit and a listed one are not repeated');
  assert.equal(rows.find((r) => r.key === 'pile-up:z').why, 'on purpose');
  assert.equal(rows.find((r) => r.key === 'sticky-flag:x').agree, 2);
});

test('toAtlasData: breaks, the main path on hand-offs, no link from the overview counted as a road, parts renumbered, no literal as a handle', () => {
  const m = model({ stages: 3, perStage: 30, seed: 5 });
  m.boxes[0].handle = '-1 -2'; m.boxes[1].handle = 'real.name';
  m.paths = [{ id: 'main', title: 'Main path', boxes: m.boxes.slice(0, 40).map((b) => b.id) }];
  const charts = chartsFromModel(m), d = toAtlasData(m, { charts, findings: [{ key: 'k1', check: 'pile-up', boxes: [m.boxes[2].id], routes: [], question: 'Q', evidence: 'E', cluster: m.boxes[2].stage, level: 'suspected' }] });
  assert.ok(Array.isArray(d.breaks) && d.breaks.some((r) => r.key === 'k1' && r.state === 'open'));
  const whole = d.charts.whole;
  assert.equal(whole.nodes[m.boxes[0].id].handle, '', 'a literal is dropped');
  assert.equal(whole.nodes[m.boxes[1].id].handle, 'real.name');
  const ports = Object.values(d.charts).flatMap((c) => c.portals);
  assert.ok(ports.some((p) => p.main), 'a hand-off that is a consecutive pair of the main path says so');
  assert.ok(ports.filter((p) => p.syn).every((p) => p.kind === 'detail' || p.label.startsWith('Part of')), 'the overview links carry syn');
  for (const sid of m.stages.map((s) => s.id)) {
    const parts = Object.values(d.charts).filter((c) => c.kind === 'stage' && c.stage === sid);
    if (parts.length < 2) continue;
    assert.deepEqual(parts.map((c) => c.part).sort((a, b) => a - b), parts.map((_, i) => i + 1), 'parts are numbered 1..n');
  }
  assert.ok(Object.values(d.charts).filter((c) => c.spine).every((c) => c.spine.length >= 1));
  assert.ok(!/…\s*Shows/.test(d.charts.overview.summary), 'the overview summary is never cut mid-sentence before its note');
});
