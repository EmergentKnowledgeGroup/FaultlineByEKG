// Tab marks and the poster, the parts that need no browser: the mark of a cut tab (it must never read as a name), and the poster / whole map facts the page relies on.
// (The page is checked in test/viewer.verify.mjs, section laptop.)
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { chipPlan, chipLayout, middleCut, renderSVG, CUT } from '../src/engine/render.mjs';

const node = (id, handle, extra = {}) => ({ id, title: id, kind: 'step', x: 0, y: 0, w: 190, h: 60, lines: [id], handle, ...extra });
const chart = (nodes, edges = []) => ({ width: 1200, height: 600, nodes: nodes.map((n, i) => ({ ...n, x: 40 + (i % 4) * 280, y: 40 + Math.floor(i / 4) * 160 })), edges, clusters: [] });

test('the mark of a cut tab is three middle dots: not an ellipsis (its low dots read as an underscore in the code font), not a character a name can hold', () => {
  assert.equal(CUT, '···');
  const cut = middleCut('ignoreFailureOfTheParentKeyOnRemoval', 20, 8);
  assert.ok(cut.includes(CUT) && !cut.includes('…') && cut.length <= 20, cut);
  assert.ok(cut.startsWith('ignore') && cut.endsWith('Removal'.slice(-6)), cut);                       // the start and the end of the name both show
  for (const h of ['removeParentKeyFromTheWaitingChildrenSet', 'updateDelayedJobScoreAndPriority', 'saveGalleryAndFinishTheStudioCompanion']) {
    const t = middleCut(h, 24, 10);
    assert.ok(t.length <= 24 && t.includes(CUT), t);
    assert.ok(!/[_…]/.test(t.replace(CUT, '')) || /[_]/.test(h), t);                              // nothing in the mark can be taken for an underscore of the name
  }
});

test('a cut tab is drawn with its mark set apart (class chip-cut) and its full name is the tooltip; a whole tab has no mark', () => {
  const g = chart([node('a', 'short'), node('b', 'removeStaleEntryKeyIfNeededOnFinish')]);
  const svg = renderSVG(g);
  assert.ok(/<tspan class="chip-cut">···<\/tspan>/.test(svg), 'the mark is its own element');
  assert.equal((svg.match(/class="chip-cut"/g) || []).length, 1);                                      // only the cut tab has one
  assert.ok(/<title>removeStaleEntryKeyIfNeededOnFinish<\/title>/.test(svg));
  const pl = chipPlan(g);
  assert.equal(pl.text.a, 'short');
  assert.ok(pl.text.b.length <= 32 && pl.text.b.includes(CUT), pl.text.b);
});

test('a cut tab is as wide as its text, so its box does not overflow (the mark counts as three characters)', () => {
  const g = chart([node('b', 'removeStaleEntryKeyIfNeededOnFinishAndSomeMoreWordsAfterIt')]);
  const pl = chipLayout(g), p = pl.b, plan = chipPlan(g);
  assert.ok(p, 'the tab is placed');
  assert.ok(p.w >= plan.text.b.length * 7 && p.w <= plan.text.b.length * 7.2 + 14, p.w + ' for ' + plan.text.b.length + ' characters');
});

test('a cut tab keeps whole words: both ends of the cut land on a word or path boundary when one is within reach', () => {
  const boundary = (s, i) => i > 0 && i < s.length && (/[._\/:\-\s]/.test(s[i - 1]) || (/[a-z0-9]/.test(s[i - 1]) && /[A-Z]/.test(s[i])));
  for (const [s, cap, tail] of [['GET /orders/restartAllCouriers', 22, 9], ['ShelfListenerRegistry.addListener', 22, 9], ['continueOrderOnMissSetting', 20, 8], ['activateChoiceOfTheCurrentPanel', 22, 9]]) {
    const t = middleCut(s, cap, tail), [a, b] = t.split(CUT);
    assert.ok(t.length <= cap && t.includes(CUT), t);
    assert.ok(boundary(s, a.length), `the start of "${t}" ends mid-word`);
    assert.ok(boundary(s, s.length - b.length), `the end of "${t}" starts mid-word`);
  }
});
