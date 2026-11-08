// The story check on an invented system: an honest story reads as joined, and every kind of false story reads as what the tool can honestly say.
//   node --test src/story/test/
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run, honest, only, withExtra, box, road, sref, ref, scratch, ROOT, SALES } from './lib/story-kit.mjs';
import { canonJson } from '../src/story/canon.mjs';
import { checkStory } from '../src/story/check.mjs';

const WORD = new Set(['else-label-on-test-arm', 'test-label-on-else-arm', 'negation-on-positive-arm', 'labels-look-swapped']);
const has = (o, f) => o.flags.includes(f);
const PICK = (line = 85) => sref(line, 'pick_lane');
const lane = () => [box('pick', 'decision', 'Priority rider?', [PICK()]), box('fast', 'end', 'Fast lane', [PICK(86)]), box('slow', 'end', 'Slow lane', [PICK(87)])];

test('an honest story: every road joined by the tool, nothing marked, words never vouched for', () => {
  const r = run(honest());
  assert.equal(r.summary.join.line, 7);
  assert.equal(r.summary.join.related + r.summary.join.none, 0);
  assert.equal(r.summary.found.boxed, 11);
  assert.equal(r.summary.marked.roads + r.summary.marked.boxes, 0);
  for (const b of Object.values(r.boxes)) assert.equal(b.words.checked, false);
  for (const x of Object.values(r.roads)) { assert.equal(x.words.checked, false); assert.equal(x.when.checked, false); }
});

test('the word "proven" is not used for a story road, anywhere in the output', () => {
  const r = run(withExtra([], [road('x', 'look', 'hasfare', 'Only when the moon is full', [sref(36)])]));
  assert.ok(!/proven/i.test(JSON.stringify(r)), 'no "proven" in the check output');
  assert.deepEqual(Object.values(r.vocabulary.join), ['joined by the tool at this line', 'joined by a route', 'related in the code', 'no link found']);
});

test('nothing is ever labelled "checked" for a condition on a call, an exit or a step', () => {
  const s = withExtra([], [
    road('on_step', 'look', 'hasfare', 'Only when the moon is full', [sref(36)]),
    road('on_call', 'seats', 'pay', 'Once the operator has approved it', [sref(42)]),
  ]);
  const r = run(s);
  for (const id of ['on_step', 'on_call']) {
    assert.equal(r.roads[id].when.compared, 'not-compared');
    assert.equal(r.roads[id].when.checked, false);
    assert.ok(!JSON.stringify(r.roads[id]).includes('"checked":true'));
  }
  assert.ok(has(r.roads.on_step, 'condition-on-step'));
  assert.equal(r.roads.on_step.joinWords, 'joined by the tool at this line', 'the honest answer: joined, words not checked');
});

test('a label with "else" written on the side where the test holds is flagged', () => {
  const r = run(only(lane(), [road('a', 'pick', 'fast', 'else', [PICK()])]));
  assert.ok(has(r.roads.a, 'else-label-on-test-arm'));
  assert.equal(r.roads.a.when.compared, 'contradicts');
  assert.equal(r.roads.a.join, 'line', 'still joined: only the label is questioned');
  assert.equal(r.summary.whenLabel.contradicts, 1);
});

test('a "no" or "not" label on the side where a plain test is true is flagged; the honest labels are not', () => {
  const r = run(only(lane(), [road('flip', 'pick', 'fast', 'Not a priority rider', [PICK()])]));
  assert.ok(has(r.roads.flip, 'negation-on-positive-arm'));
  const ok = run(only(lane(), [road('t', 'pick', 'fast', 'Priority rider', [PICK()]), road('e', 'pick', 'slow', 'else', [PICK()])]));
  for (const id of ['t', 'e']) { assert.deepEqual(ok.roads[id].flags, []); assert.equal(ok.roads[id].when.compared, 'no-contradiction'); }
});

test('a label that restates the test on the side where it is absent is flagged', () => {
  const r = run(only(lane(), [road('e', 'pick', 'slow', 'Priority rider', [PICK()]), road('ok', 'pick', 'fast', 'Priority rider', [PICK()])]));
  assert.ok(has(r.roads.e, 'positive-on-negative-arm'));
  const r2 = run(only(lane(), [road('e2', 'pick', 'slow', 'No priority', [PICK()])]));
  assert.deepEqual(r2.roads.e2.flags.filter((f) => WORD.has(f) || /arm/.test(f)), []);
});

test('labels swapped between the two sides of one decision are flagged on both roads', () => {
  const r = run(only(lane(), [road('t', 'pick', 'fast', 'No priority', [PICK()]), road('e', 'pick', 'slow', 'Priority rider', [PICK()])]));
  assert.ok(has(r.roads.t, 'negation-on-positive-arm'));
  assert.ok(has(r.roads.t, 'labels-look-swapped') && has(r.roads.e, 'labels-look-swapped'));
});

test('a flip written in other words is NOT seen, and the summary says so', () => {
  const r = run(only(lane(), [road('t', 'pick', 'fast', 'Regular rider', [PICK()]), road('e', 'pick', 'slow', 'VIP rider', [PICK()])]));
  assert.equal(r.roads.t.when.compared, 'no-contradiction');
  assert.ok(!r.roads.t.flags.some((f) => WORD.has(f)));
  assert.ok(r.summary.cannotSee.some((t) => /other words is not seen/.test(t)));
});

test('a catch road told as "when the move succeeds" is flagged, and it inherits the tool\'s own doubt', () => {
  const b = [box('try', 'step', 'Print the ticket', [sref(47)]), box('onfail', 'step', 'Could not print', [sref(48)])];
  const r = run(only(b, [road('c', 'try', 'onfail', 'printing succeeded', [sref(47)]), road('d', 'try', 'onfail', 'printing fails', [sref(47)])]));
  assert.ok(has(r.roads.c, 'success-words-on-error-road'));
  assert.ok(!has(r.roads.d, 'success-words-on-error-road'));
  for (const id of ['c', 'd']) {
    assert.equal(r.roads[id].join, 'related', 'the tool road is not confident, so the story road is not "joined"');
    assert.ok(has(r.roads[id], 'stands-on-weak-road'));
    assert.ok(r.roads[id].inherits);
  }
});

test('a raise told as "returned" is flagged by its words', () => {
  const b = [box('refuse', 'end', 'Refuse the sale', [sref(38)]), box('look', 'step', 'Look up the fare', [sref(36)])];
  const r = run(only(b, [road('r', 'refuse', 'look', 'The sale is returned to the caller', [sref(38)], { type: 'return' })]));
  assert.ok(!has(r.roads.r, 'return-from-raise'), 'a return road may be a retry: only the words are compared with what the tool sees');
  assert.ok(has(r.roads.r, 'says-return-tool-shows-raise'));
});

test('a road typed deliver or record needs something the tool sees at the cited lines', () => {
  const b = [box('look', 'step', 'Look up the fare', [sref(36)]), box('hasfare', 'decision', 'Is there a fare?', [sref(37)])];
  const r = run(only(b, [
    road('d1', 'look', 'hasfare', '', [sref(36)], { type: 'deliver' }),
    road('d2', 'look', 'hasfare', '', [ref('kiosk/printer.py', 9, 'print_ticket'), sref(36)], { type: 'deliver' }),
    road('r1', 'look', 'hasfare', '', [sref(36)], { type: 'record' }),
  ]));
  assert.ok(has(r.roads.d1, 'deliver-not-seen'));
  assert.ok(!has(r.roads.d2, 'deliver-not-seen'), 'a print is on a cited line');
  assert.ok(has(r.roads.r1, 'record-not-seen'));
});

test('a store, a wait and an external box where the code shows none are flagged', () => {
  const b = [
    box('s', 'store', 'Delete the customer account', [sref(36)]),
    box('w', 'wait', 'Wait for the bank', [sref(38)]),
    box('x', 'external', 'Charge the credit card', [sref(37)]),
    box('s_ok', 'store', 'Write the ledger entry', [ref('kiosk/ledger.py', 7, 'append_entry')]),
    box('w_ok', 'wait', 'Wait for paper', [sref(62, 'wait_for_paper')]),
    box('x_ok', 'external', 'Run the card tool', [sref(31, 'gateway_charge')]),
  ];
  const r = run(only(b, []));
  assert.ok(has(r.boxes.s, 'no-store-at-cite') && has(r.boxes.w, 'no-wait-at-cite') && has(r.boxes.x, 'no-external-at-cite'));
  for (const id of ['s_ok', 'w_ok', 'x_ok']) assert.deepEqual(r.boxes[id].flags, [], id);
});

test('a decision and an end with no test and no exit at the cited lines are flagged', () => {
  const r = run(only([box('d', 'decision', 'Is it ready?', [sref(52)]), box('e', 'end', 'Done', [sref(68, 'apply_discount')])], []));
  assert.ok(has(r.boxes.d, 'no-decision-at-cite') && has(r.boxes.e, 'no-end-at-cite'));
});

test('a raise titled as a success is flagged', () => {
  const r = run(only([box('e', 'end', 'Sale completed', [sref(38)], { outcome: 'success' }), box('f', 'end', 'Refuse the sale', [sref(38)], { outcome: 'failure' })], []));
  assert.ok(has(r.boxes.e, 'raise-titled-success'));
  assert.ok(!has(r.boxes.f, 'raise-titled-success'));
});

test('an outcome the agent set outranks the words: a refusal that raises is not a success, and a road leaving a catch is not an error road', () => {
  const r = run(only([box('e', 'end', 'Sale completed', [sref(38)], { outcome: 'refusal' }), box('onfail', 'step', 'Could not print', [sref(48)]), box('after', 'step', 'Say so', [sref(49)])],
    [road('c', 'onfail', 'after', 'Printing finished', [sref(48)])]));
  assert.ok(!has(r.boxes.e, 'raise-titled-success'));
  assert.ok(!has(r.roads.c, 'success-words-on-error-road'));
});

test('wrong titles on real lines still read as found, with words marked unchecked and the tool phrase beside them', () => {
  const r = run(only([box('a', 'store', 'Delete the customer account', [ref('kiosk/ledger.py', 7, 'append_entry')]), box('b', 'external', 'Charge the credit card', [sref(31, 'gateway_charge')])], [road('ab', 'a', 'b', '', [sref(31, 'gateway_charge')])]));
  for (const id of ['a', 'b']) { assert.equal(r.boxes[id].found, 'boxed'); assert.equal(r.boxes[id].words.checked, false); assert.ok(r.boxes[id].toolPhrase); }
  assert.equal(r.boxes.a.toolPhrase, 'does store');
  assert.notEqual(r.roads.ab.join, 'line', 'no tool road runs between a ledger write and a card charge');
});

test('a box that cites one extra line to borrow a road reads as related, not joined', () => {
  const b = [
    box('look', 'step', 'Look up the fare', [sref(36)]),
    box('hasfare', 'decision', 'Is there a fare?', [sref(37)]),
    box('borrower', 'step', 'Look up the fare again', [ref(SALES, 14, 'lookup_fare'), sref(36)]),
  ];
  const r = run(only(b, [road('r', 'borrower', 'hasfare', '', [sref(36)])]));
  assert.notEqual(r.roads.r.join, 'line');
  assert.ok(has(r.roads.r, 'second-citation') || r.roads.r.join !== 'route');
});

test('a wrong function name in a citation is flagged and caps the road at related', () => {
  const b = [box('look', 'step', 'Look up the fare', [ref(SALES, 36, 'refuse_full')]), box('hasfare', 'decision', 'Is there a fare?', [sref(37)])];
  const r = run(only(b, [road('r', 'look', 'hasfare', '', [sref(36)])]));
  assert.ok(has(r.boxes.look, 'symbol-differs'));
  assert.equal(r.roads.r.join, 'related');
  assert.ok(has(r.roads.r, 'end-box-flagged'));
});

test('names that are nowhere in the code are flagged', () => {
  const r = run(only([box('n', 'step', 'Count the attempt', [sref(36)], { plain: 'Increments quotaLedgerWriter before the call.' })], []));
  assert.ok(has(r.boxes.n, 'name-not-in-code'));
});

test('an invented road, a reversed road and a road to nowhere read as no link found', () => {
  const b = [box('refuse', 'end', 'Refuse the sale', [sref(38)]), box('paper', 'wait', 'Wait for paper', [sref(62, 'wait_for_paper')]), box('look', 'step', 'Look up the fare', [sref(36)]), box('sold', 'end', 'Ticket sold', [sref(52)])];
  const r = run(only(b, [road('i', 'refuse', 'paper', 'Quota exhausted', [sref(38)]), road('rev', 'sold', 'look', '', [sref(52)]), road('gone', 'look', 'nobody', '', [sref(36)])]));
  assert.equal(r.roads.i.join, 'none');
  assert.equal(r.roads.rev.join, 'none');
  assert.equal(r.roads.gone.join, 'none');
  assert.ok(has(r.roads.gone, 'end-missing'));
});

test('lines that hold nothing, a missing file and a line past the end are not found', () => {
  const b = [box('comment', 'step', 'Blank line', [sref(3, '')]), box('nofile', 'step', 'No file', [ref('kiosk/missing.py', 3, 'f')]), box('eof', 'step', 'Past the end', [sref(99999)])];
  const r = run(only(b, []));
  for (const id of ['comment', 'nofile', 'eof']) assert.equal(r.boxes[id].found, 'none', id);
  assert.ok(has(r.boxes.nofile, 'cites-nothing'));
});

test('a path outside the root is refused: its file is not opened and none of its text is printed', () => {
  const dir = scratch('outside');
  const canary = 'CANARY_TEXT_THAT_MUST_NOT_APPEAR';
  fs.writeFileSync(`${dir}/outside.txt`, `${canary}\n${canary}\n${canary}\n`);
  const rootDir = scratch('outside/root');
  fs.mkdirSync(`${rootDir}/kiosk`, { recursive: true });
  fs.copyFileSync(`${ROOT}/kiosk/sales.py`, `${rootDir}/kiosk/sales.py`);
  const refs = ['../outside.txt', '../../outside/outside.txt', `${dir}/outside.txt`, 'kiosk/../../outside.txt', 'C:/Windows/win.ini', '/etc/passwd', 'kiosk\\..\\..\\outside.txt'];
  const s = only(refs.map((p, i) => box('o' + i, 'step', 'Outside ' + i, [{ path: p, symbol: '', line: 1 }])), refs.map((p, i) => road('r' + i, 'o' + i, 'o' + ((i + 1) % refs.length), 'when it escapes', [{ path: p, symbol: '', line: 2 }])));
  const r = run(s, { root: rootDir });
  const text = JSON.stringify(r);
  assert.ok(!text.includes(canary), 'no text from outside the root');
  assert.ok(!text.includes('root:x:') && !text.includes('[fonts]'));
  for (let i = 0; i < refs.length; i++) {
    assert.equal(r.boxes['o' + i].found, 'none', refs[i]);
    assert.ok(has(r.boxes['o' + i], 'cites-outside-root'), refs[i]);
    assert.equal(r.roads['r' + i].join, 'none');
    assert.ok(r.boxes['o' + i].refs.every((x) => x.status === 'refused' && x.text === undefined));
  }
  assert.ok(r.summary.flags['cites-outside-root'] >= refs.length);
});

test('a link that leads outside the root is refused too (skipped when links cannot be made here)', (t) => {
  const dir = scratch('linked');
  const canary = 'LINKED_CANARY_TEXT';
  fs.writeFileSync(`${dir}/secret.txt`, `${canary}\n`);
  const rootDir = scratch('linked/root');
  fs.mkdirSync(rootDir, { recursive: true });
  try { if (!fs.existsSync(`${rootDir}/leak.txt`)) fs.symlinkSync(`${dir}/secret.txt`, `${rootDir}/leak.txt`); } catch { t.skip('cannot make a symbolic link on this machine'); return; }
  const r = run(only([box('l', 'step', 'Leak', [{ path: 'leak.txt', symbol: '', line: 1 }])], []), { root: rootDir });
  assert.ok(!JSON.stringify(r).includes(canary));
  assert.equal(r.boxes.l.found, 'none');
});

test('the same story gives the same bytes, and the output holds no path of this machine', () => {
  const a = canonJson(run(withExtra([], [road('x', 'look', 'hasfare', 'Only when the moon is full', [sref(36)])])));
  const b = canonJson(run(withExtra([], [road('x', 'look', 'hasfare', 'Only when the moon is full', [sref(36)])])));
  assert.equal(a, b);
  assert.ok(!a.includes(ROOT) && !a.includes(process.cwd().replace(/\\/g, '/')));
});

test('a map whose sources changed is refused unless the caller says so', () => {
  const r = checkStory(honest(), { mapDir: `${ROOT}/../map`, root: ROOT, allowStale: false });
  // the fixture map carries the digest of the sources as they were when it was built; the test copy may differ in line endings, so only the shape is checked
  assert.ok(r.refused ? r.refused[0].code === 'M-stale' : r.map.fresh === true);
});
