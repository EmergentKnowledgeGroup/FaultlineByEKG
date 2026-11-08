// A road condition wraps in even lines: a number stays with its comparison word and its unit, and a last line is not one lone word when a split inside the same widest line avoids it.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, wrapLabel, balanceLines } from '../src/engine/layout.mjs';

test('balanceLines: a number is not cut from its unit or its comparison word', () => {
  assert.deepEqual(wrapLabel('Door opened within 2 s', 20), ['Door opened', 'within 2 s']);
  assert.deepEqual(wrapLabel('Rate limit ttl above 0', 20), ['Rate limit', 'ttl above 0']);
  assert.deepEqual(wrapLabel('Code below 0, or not 1', 20), ['Code below 0,', 'or not 1']);
  assert.deepEqual(wrapLabel('Jitter outside 0 to 1', 20), ['Jitter', 'outside 0 to 1']);
});

test('balanceLines: no lone last word when the same widest line allows a better split', () => {
  assert.deepEqual(wrapLabel('Pause and cap looked up', 20), ['Pause and', 'cap looked up']);
  assert.deepEqual(wrapLabel('Parent gone or moved on', 20), ['Parent gone', 'or moved on']);
  assert.deepEqual(wrapLabel('Over 32 items or closed', 20), ['Over 32 items', 'or closed']);
});

test('balanceLines: same number of lines, never wider than the greedy wrap, same words in the same order', () => {
  const texts = ['Door opened within 2 s', 'Van loaded, 4 s passed', 'Parked or 60 s reached', 'Next stop, 1 s timeout', 'Not finite, or below 1', 'Carrier: managed courier', 'Any refusal: exit 1',
    'Queue is empty or the owner closed the window early', 'one two three four five six seven eight nine ten'];
  for (const t of texts) {
    const g = wrapText(t, 20), b = balanceLines(g);
    assert.equal(b.length, g.length, t);
    assert.ok(Math.max(...b.map((l) => l.length)) <= Math.max(...g.map((l) => l.length)), t);
    assert.equal(b.join(' '), g.join(' '), t);
  }
});

test('balanceLines: one line, one word per line and a word wider than the limit are left alone', () => {
  assert.deepEqual(balanceLines(['short']), ['short']);
  assert.deepEqual(balanceLines([]), []);
  assert.deepEqual(wrapLabel('failParentOnFailure set', 20), ['failParentOnFailure', 'set']);
  assert.deepEqual(balanceLines(undefined), undefined);
});

// ---- box names follow the same rule as road labels ------------------------------------------------------------------------------------
import { gridLayout } from '../src/engine/gridlayout.mjs';
import { nodeSize } from '../src/engine/layout.mjs';

const NAMES = ['Holds and expired items', 'Courier: carrying parcels', 'Archive: kept records', 'Order in the held list', 'Turned away with a code', 'Next request in the queue', 'Ask a carrier how it is',
  'Wait up to 30 s for the reply', 'Resend within 2 s of the miss', 'Door opened within 2 s', 'Short name'];

test('box names: no lone last word when a split inside the same widest line avoids it', () => {
  assert.deepEqual(wrapLabel('Holds and expired items', 17), ['Holds and', 'expired items']);
  assert.deepEqual(wrapLabel('Courier: carrying parcels', 17), ['Courier:', 'carrying parcels']);
  assert.deepEqual(wrapLabel('Order in the held list', 17), ['Order in the', 'held list']);
  assert.deepEqual(wrapLabel('Ask a carrier how it is', 17), ['Ask a carrier', 'how it is']);
  assert.deepEqual(wrapLabel('Resend within 2 s of the miss', 17), ['Resend within 2 s', 'of the miss']);       // a number stays with its comparison word and its unit
});

test('box names: a drawn box carries even lines, and its size is the one the greedy wrap gave it', async () => {
  const nodes = NAMES.map((title, i) => ({ id: 'n' + i, title, kind: 'step' }));
  const edges = nodes.slice(1).map((n, i) => ({ id: 'r' + i, from: 'n' + i, to: n.id, type: 'forward', label: '' }));
  const map = [nodes.slice(0, 4).map((n) => n.id).join(' '), nodes.slice(4, 8).map((n) => n.id).join(' '), nodes.slice(8).map((n) => n.id).join(' ')];
  const cfg = { map, gapX: 150, gapY: 90, nodeMaxChars: 17 };
  const g = await gridLayout({ id: 't', title: 't', nodes, edges }, cfg);
  const full = { minNodeW: 150, lineH: 19 };
  for (const n of g.nodes) {
    const greedy = wrapText(n.title, 17), want = nodeSize(greedy, full);
    assert.deepEqual(n.lines, wrapLabel(n.title, 17), n.title);
    assert.equal(n.lines.join(' '), greedy.join(' '), 'same words in the same order');
    assert.equal(n.lines.length, greedy.length, 'same number of lines');
    assert.equal(n.w, want.w, n.title + ' keeps its width');
    assert.equal(n.h, want.h, n.title + ' keeps its height');
    const last = n.lines[n.lines.length - 1];
    if (n.lines.length > 1 && !/\s/.test(last)) {                  // a lone last word is left only when no split inside the widest line avoids it
      const prev = n.lines[n.lines.length - 2].split(' '), max = Math.max(...n.lines.map((l) => l.length));
      assert.ok(prev.length < 2 || prev[prev.length - 1].length + 1 + last.length > max, n.title + ' could have split evenly');
    }
  }
});

test('box names: the count line of an ending pill stays on its own line; any other name is evened', async () => {
  const { nameLines } = await import('../src/engine/layout.mjs');
  assert.deepEqual(nameLines(['Success endings', '(12)'], 'end'), ['Success endings', '(12)']);
  assert.deepEqual(nameLines(['Holds and expired', 'items'], 'step'), ['Holds and', 'expired items']);
  assert.deepEqual(nameLines(['Closed with an', 'error'], 'end'), ['Closed with', 'an error']);
});

test('box names: a number can stay with the unit word after it when that is the only way to avoid a lone last word', () => {
  assert.deepEqual(wrapLabel('Keep up to 40 characters', 14), ['Keep up to', '40 characters']);
  assert.deepEqual(wrapLabel('Hold the last 20 notes', 16), ['Hold the', 'last 20 notes']);
  assert.deepEqual(wrapLabel('Door opened within 2 s', 20), ['Door opened', 'within 2 s'], 'the strict rule still wins when it can avoid a lone last word');
});
