import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSystem } from '../src/read/index.mjs';
import { buildModel, loopsOfPart, boxConfidence, whyOf, PLAIN_MAX } from '../src/read/page/project.mjs';
import { packReading, viaText } from '../src/read/page/pack.mjs';
import { buildNav, buildBreaks, trimAtlas, SMALL_FUNCTION_BOXES } from '../src/read/page/inject.mjs';
import { makeShop } from './lib/read-helpers.mjs';

const shop = () => {
  const s = makeShop();
  const r = readSystem({ model: s.model, claims: s.claims, facts: s.facts, sourceRoot: s.root, name: 'shop' });
  return { s, ...r };
};

test('the model written for the page has one stage per stage, every drawn box and road, and no id twice', () => {
  const { s, reading, charts } = shop();
  const m = buildModel({ reading, charts, claims: s.claims, name: 'shop', tagline: 't', toolMap: { summary: 'x' } });
  assert.equal(m.flows.stages.length, reading.districts.list.length);
  const drawn = charts.charts.flatMap((c) => c.parts.flatMap((p) => p.boxes));
  assert.equal(m.flows.boxes.length, drawn.length);
  assert.equal(new Set(m.flows.boxes.map((b) => b.id)).size, drawn.length);
  assert.equal(new Set(m.flows.routes.map((r) => r.id)).size, m.flows.routes.length);
  assert.ok(m.flows.boxes.every((b) => b.plain.length <= PLAIN_MAX && b.title.length <= 40));
  assert.ok(m.flows.routes.every((r) => !/^may\b/.test(r.when)), 'a road label never opens with "may"');
  assert.ok(m.flows.charts.every((c) => c.boxes.length > 0));
  assert.equal(m.system.system.charts.stage, false);
});

test('a card for a function with a chart gets a road that opens it; an unproven road is inferred and not confident', () => {
  const { s, reading, charts } = shop();
  const m = buildModel({ reading, charts, claims: s.claims, name: 'shop', tagline: 't', toolMap: { summary: 'x' } });
  const opens = m.flows.routes.filter((r) => r.when === 'opens');
  const cards = charts.charts.flatMap((c) => c.parts.flatMap((p) => p.boxes)).filter((b) => b.shape === 'card' && b.target);
  assert.equal(opens.length, cards.length);
  const may = m.flows.routes.filter((r) => r.prov.tier === 'may');
  assert.ok(may.every((r) => r.inferred && m.notConfident.roads[r.id]));
});

test('loops: the loop box and the boxes of its body that lead back to it', () => {
  const part = {
    boxes: [{ id: 'a', shape: 'own', rule: 'loop', title: 'loop: x in xs' }, { id: 'b', shape: 'own', rule: 'step' }, { id: 'c', shape: 'own', rule: 'step' }, { id: 'd', shape: 'own', rule: 'step' }],
    roads: [{ from: 'a', to: 'b', when: 'each time round' }, { from: 'b', to: 'c', when: 'then' }, { from: 'c', to: 'a', when: 'then' }, { from: 'a', to: 'd', when: 'when done' }],
  };
  const L = loopsOfPart(part);
  assert.equal(L.length, 1);
  assert.deepEqual(L[0].members, ['a', 'b', 'c']);
});

test('confidence: only a not-confident claim about one box counts, with its reason', () => {
  const claims = [
    { subject: 'box.1', conf: 'not-confident', says: 'who hears', why: 'callers we cannot see decide it' },
    { subject: 'box.2', conf: 'confident', says: 'x', why: 'y' },
    { subject: 'a->b:else', conf: 'not-confident', says: 'z', why: 'w' },
    { subject: 'src/a.ts::f:12', conf: 'not-confident', says: 'z', why: 'w' },
  ];
  const c = boxConfidence(claims);
  assert.deepEqual([...c.keys()], ['box.1']);
  assert.match(c.get('box.1')[0], /who hears: callers we cannot see decide it/);
  assert.match(whyOf({ shape: 'card' }), /call into another function/);
});

test('the packed reading is small, names every function once, and keeps each journey step in order', () => {
  const { reading, charts, words } = shop();
  const side = { notConfident: { boxes: {}, roads: {} }, pageOfRef: Object.fromEntries(Object.entries(words).filter(([, w]) => w.page).map(([k, w]) => [k, w.page])) };
  const rl = packReading({ reading, charts, side });
  assert.equal(rl.fns.length, charts.functions.length);
  assert.equal(rl.journeys.length, reading.journeys.list.length);
  for (const [i, j] of reading.journeys.list.entries()) assert.equal(rl.journeys[i].steps.length, j.steps.length);
  assert.ok(rl.journeys.every((j) => j.steps.every((st) => typeof st.k === 'string' && typeof st.d === 'number')));
  assert.equal(rl.failing.length, reading.endings.failing.length);
  assert.equal(viaText({ kind: 'trigger' }), '');
  assert.match(viaText({ kind: 'call', line: 7, evidence: 'scan' }), /call at line 7 \(found by the scanner/);
});

test('the chart list folds by stage, keeps parts of one function together, and puts small functions behind a count', () => {
  const { reading, charts } = shop();
  const atlas = { stages: reading.districts.list.map((d) => ({ id: d.id, title: d.title })), charts: Object.fromEntries(charts.charts.flatMap((c) => c.parts.map((p) => [p.id, {}]))) };
  const nav = buildNav(atlas, charts);
  assert.equal(nav[0].group, 'Start here');
  for (const g of nav.slice(1)) {
    assert.ok(g.fold);
    assert.ok(g.rows.every((r) => r.boxes > SMALL_FUNCTION_BOXES));
    assert.ok(g.small.every((r) => r.boxes <= SMALL_FUNCTION_BOXES));
    assert.deepEqual(g.items, g.rows.concat(g.small).flatMap((r) => r.parts));
  }
});

test('a question points at the chart of its function and says whether the tool is sure', () => {
  const { reading, charts } = shop();
  const entry = new Map(charts.functions.map((f) => [f.id, `${f.id}.0`]));
  const rows = buildBreaks({ triage: { questions: [{ id: 'q1', kind: 'wait-no-end', text: 't', because: 'b', confidence: 'confident', where: { path: charts.functions[0].path, fn: charts.functions[0].label, line: 1 } }] } }, charts.functions, entry);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].check, 'wait-no-wake');
  assert.deepEqual(rows[0].boxes, [`${charts.functions[0].id}.0`]);
  assert.match(rows[0].evidence, /^The tool is sure\./);
  assert.ok(!/prov(?:en|ed|es?)\b/i.test(rows[0].evidence), 'the page does not say proven');
  void reading;
});

test('trimming drops only what the page never reads', () => {
  const atlas = { charts: { c1: { kind: 'detail', nodes: { n1: { id: 'n1', plain: 'p', summary: 'p', inputs: [], outputs: [], failure: '', switch: '', outcome: '', handle: '', status: 'live', stage: 's', family: 's', why: '', refs: [{ path: 'a', line: 1 }] }, n2: { id: 'n2', plain: 'q', summary: 'other', outcome: 'failure' } }, edges: { e1: { id: 'e1', from: 'n1', to: 'n2', label: 'x', short: 'x', refs: [{ path: 'a', line: 1 }], inferred: false, why: 'A road the tool is sure of.' } } } } };
  trimAtlas(atlas);
  const n1 = atlas.charts.c1.nodes.n1;
  assert.deepEqual(Object.keys(n1).sort(), ['id', 'plain', 'refs', 'stage']);
  assert.equal(atlas.charts.c1.nodes.n2.summary, 'other');
  assert.equal(atlas.charts.c1.nodes.n2.outcome, 'failure');
  assert.deepEqual(Object.keys(atlas.charts.c1.edges.e1).sort(), ['from', 'id', 'label', 'to']);
});
