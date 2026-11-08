// One meaning and one source for every number, and words that cannot be confused: these tests scan text for disagreement with the reading's record.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSystem } from '../src/read/index.mjs';
import { scanPageText, BANNED } from '../src/read/page/textscan.mjs';
import { journeyChartOrder, switchLine } from '../src/read/page/inject.mjs';
import { makeShop } from './lib/read-helpers.mjs';

const run = () => {
  const s = makeShop();
  return readSystem({ model: s.model, claims: s.claims, facts: s.facts, sourceRoot: s.root, name: 'shop' });
};

test('the sentences the page quotes agree with the reading, and the scan catches a number that does not', () => {
  const { reading } = run();
  const n = reading.numbers;
  const text = [
    ...reading.statements.read, ...reading.statements.notRead, ...reading.statements.open, reading.whoHears.sentence,
    `Journeys (${n.journeys.kept})`, `${n.switches.found} switches found`, `${n.endings.total} endings in the code`, `${n.read.boxes} boxes in the map`,
    `of ${reading.whoHears.counts.total} failing endings`,
  ].join('\n');
  assert.deepEqual(scanPageText(text, reading), []);
  const bad = scanPageText(`${n.read.boxes + 5} boxes in the map. ${n.endings.total + 1} endings in the code. the main path runs through 0 of them`, reading);
  assert.equal(bad.filter((x) => x.what === 'boxes in the map' || x.what === 'endings in the code').length, 2);
  assert.ok(bad.length >= 2);
});

test('the words the page must not use are not in anything the reading wrote', () => {
  const { reading, words, charts } = run();
  const all = JSON.stringify([reading.statements, reading.glossary, reading.whoHears, reading.endings, reading.switches.cannotSee, words, charts.stats]);
  for (const [re, what] of BANNED) assert.ok(!re.test(all), `the reading ${what}`);
});

test('one ending is one place where a function returns or raises, and a failing one has one row per place', () => {
  const { reading } = run();
  const n = reading.numbers;
  assert.equal(n.endings.total, Object.values(n.endings.byOutcome).reduce((a, b) => a + b, 0));
  assert.equal(reading.endings.failing.length, reading.whoHears.counts.total);
  assert.equal(n.endings.failing, reading.whoHears.counts.total);
  for (const r of reading.endings.failing) assert.ok(r.outcome === 'failure' || r.outcome === 'refusal');
});

test('the off-by-default line keeps "default false" apart from "off"', () => {
  const line = switchLine({ found: 33, offByDefault: 4, defaultFalsy: 6, defaultOn: 3, defaultNotRead: 20 });
  assert.equal(line, '33 switches found: 4 off by default, 6 default to false or none without the name saying that means off, 3 default to on, 20 have no default the tool could read.');
});

test('the order of "Next chart" follows the journeys, the main path first, then the rest', () => {
  const atlas = {
    charts: { overview: {}, a: {}, b: {}, c: {}, d: {} },
    nav: [{ group: 'Start here', items: ['overview'] }, { group: 'S', stage: 's', fold: true, rows: [{ id: 'a', parts: ['a'] }, { id: 'b', parts: ['b'] }], small: [{ id: 'c', parts: ['c'] }, { id: 'd', parts: ['d'] }], items: ['a', 'b', 'c', 'd'] }],
  };
  const rl = { rank: { main: { id: 'j2' } }, journeys: [{ id: 'j1', steps: [{ c: 'a' }] }, { id: 'j2', steps: [{ c: 'd' }, { c: 'c' }] }] };
  assert.deepEqual(journeyChartOrder(atlas, rl), ['overview', 'd', 'c', 'a', 'b']);
});
