// The review gate (questions for an agent, re-checked answers), the overlay, the flow charts, and that mapping twice gives the same bytes.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capabilities, build, FIX, WORK } from './lib/map-helpers.mjs';
import { mapSystem, modelText, claimsText } from '../src/map/mapsystem.mjs';
import { buildItems, order, reviewIndex, reviewView, templateOf, CANT } from '../src/map/review.mjs';
import { checkAnswer, view } from '../src/map/review_check.mjs';
import { applyOverlay } from '../src/map/overlay.mjs';
import { charts, stubTitle, chartText } from '../src/map/flow.mjs';
import { dumps } from '../src/map/pyrt.mjs';

const cap = await capabilities();
const skipPy = cap.python ? {} : { skip: 'needs python' };
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'faultline.mjs');

const fake = (lines) => ({ lines: (p) => (p === 'a.py' ? lines : null) });
const nc = { c1: { conf: 'not-confident', pinned: false } };
const item = (extra = {}) => ({ item: 'q:x', template: 'hears', claims: ['c1'], answers: ['tells-someone-at-cited-line', 'tells-no-one', CANT], path: 'a.py', line: 9, subject: [], ...extra });

test('an answer is refused unless it is exactly {item, choice, cite, quote} about a not-confident claim', () => {
  const src = fake(['x = 1', '    log.warning("boom")']);
  const ok = { item: 'q:x', choice: 'tells-someone-at-cited-line', cite: 'a.py:2', quote: 'log.warning("boom")' };
  assert.equal(checkAnswer(item(), { ...ok, extra: 1 }, src, new Map(Object.entries(nc))).rule, 'schema');
  assert.equal(checkAnswer(null, ok, src, new Map(Object.entries(nc))).rule, 'no-such-item');
  assert.equal(checkAnswer(item(), ok, src, new Map([['c1', { conf: 'confident', pinned: true }]])).rule, 'pinned');
  assert.equal(checkAnswer(item(), { ...ok, choice: 'maybe' }, src, new Map(Object.entries(nc))).rule, 'choice');
  assert.equal(checkAnswer(item(), { ...ok, choice: CANT }, src, new Map(Object.entries(nc))).status, 'no-answer');
});

test('the cited line must exist, stay inside the project and hold the quote', () => {
  const src = fake(['x = 1', '    log.warning("boom")']);
  const by = new Map(Object.entries(nc));
  const base = { item: 'q:x', choice: 'tells-someone-at-cited-line', cite: 'a.py:2', quote: 'log.warning("boom")' };
  for (const cite of ['../a.py:2', '/a.py:2', 'a.py:0', 'a.py', 'a:b.py:2']) assert.equal(checkAnswer(item(), { ...base, cite }, src, by).rule, 'cite', cite);
  assert.equal(checkAnswer(item(), { ...base, cite: 'b.py:1' }, src, by).rule, 'line-exists');
  assert.equal(checkAnswer(item(), { ...base, cite: 'a.py:9' }, src, by).rule, 'line-exists');
  assert.equal(checkAnswer(item(), { ...base, quote: 'print(' }, src, by).rule, 'quote');
  const r = checkAnswer(item(), base, src, by);
  assert.equal(r.status, 'checked');
  assert.equal(r.rule, 'line-tells-someone');
  assert.match(r.line_sha, /^[0-9a-f]{16}$/);
});

test('a negative answer is an opinion and a positive one the line cannot back is cited-only', () => {
  const src = fake(['x = 1', 'y = 2']);
  const by = new Map(Object.entries(nc));
  assert.equal(checkAnswer(item(), { item: 'q:x', choice: 'tells-no-one', cite: 'a.py:1', quote: 'x = 1' }, src, by).status, 'opinion');
  assert.equal(checkAnswer(item(), { item: 'q:x', choice: 'tells-someone-at-cited-line', cite: 'a.py:1', quote: 'x = 1' }, src, by).status, 'cited-only');
});

test('the claim list is returned byte for byte without the agent, and only touched claims gain `agent`', () => {
  const claims = [{ id: 'c1', conf: 'not-confident', reason: 'r' }, { id: 'c2', conf: 'confident', reason: 'r' }];
  assert.equal(view(claims, [], false), claims);
  const out = view(claims, [{ status: 'opinion', claims: ['c1'], choice: 'tells-no-one', rule: 'negative-answer' }, { status: 'refused', claims: ['c2'] }]);
  assert.equal(out[0].agent.length, 1);
  assert.equal(out[0].conf, 'not-confident');
  assert.equal(out[1], claims[1]);
});

test('only not-confident, unpinned claims become questions', () => {
  assert.equal(templateOf({ type: 'declined', conf: 'not-confident', reason: 'effect-candidate', id: 'd:x' }), 'effect');
  assert.equal(templateOf({ type: 'declined', conf: 'confident', reason: 'effect-candidate', id: 'd:x' }), null);
  assert.equal(templateOf({ type: 'call-road', conf: 'not-confident', pinned: true, reason: 'x', id: 'r:x' }), null);
  assert.equal(templateOf({ type: 'entry', conf: 'not-confident', reason: 'a-caller-is-on-the-map', id: 'y:x' }), null);
});

test('the work-list: every question has an answer set, a rank, and main-path failures come first', skipPy, async () => {
  const b = await build('truth_py', { py: true });
  const { model, claims, P } = b.res;
  const index = JSON.parse(dumps(reviewIndex(P, claims), 0));
  const items = order(buildItems(reviewView(JSON.parse(dumps(model, 1)), index), claims, b.sys.root));
  assert.ok(items.length > 0);
  const rank = { 'main-failure': 0, main: 1, failure: 2, rest: 3 };
  items.forEach((it, i) => {
    assert.equal(it.rank, i + 1);
    assert.equal(it.answers[it.answers.length - 1], CANT);
    assert.ok(it.claims.length && it.question && it.lines.length <= 16);
    if (i) assert.ok(rank[items[i - 1].tier] <= rank[it.tier]);
  });
  const byId = new Map(claims.map((c) => [c.id, c]));
  for (const it of items) for (const cid of it.claims) assert.equal(byId.get(cid).conf, 'not-confident');
});

test('mapping the same read system twice gives the same bytes', skipPy, async () => {
  const { sys } = await build('truth_py', { py: true });
  const a = mapSystem(sys, { name: 'truth_py' });
  const b = mapSystem(sys, { name: 'truth_py' });
  assert.equal(modelText(a.model), modelText(b.model));
  assert.equal(claimsText(a.claims), claimsText(b.claims));
});

test('the overlay accepts words, refuses an unwitnessed road and anything that would change a proven field', skipPy, async () => {
  const b = await build('truth_py', { py: true });
  const { model } = b.res;
  const box = model.boxes[0];
  const [m, log] = applyOverlay(model, { boxes: { [box.id]: { plain: 'in words', kind: 'x' }, nope: { title: 't' } }, roads: [{ from: box.id, to: model.boxes[1].id, witness: { path: 'tr_roads.py', line: 1, kind: 'call' } }], delete: ['b1'] }, b.sys.root);
  assert.equal(m.boxes[0].plain, 'in words');
  assert.equal(m.boxes[0].kind, box.kind);
  assert.equal(log.words_accepted, 1);
  assert.equal(log.words_refused, 2);
  assert.equal(log.roads_accepted + log.roads_refused, 1);
  assert.ok(log.refusals.some((x) => x.includes('cannot be deleted')));
  assert.equal(model.boxes[0].plain, '', 'the model passed in is not changed');
});

test('a flow chart holds a function\'s boxes, a card per callee and a stub per folded exit', skipPy, async () => {
  const { model } = (await build('truth_py', { py: true })).res;
  const cs = charts(model);
  assert.ok(cs.size > 0);
  for (const [fid, c] of cs) {
    const ids = new Set(c.boxes.map((x) => x.id));
    assert.equal(ids.size, c.boxes.length, fid);
    for (const r of c.routes) assert.ok(ids.has(r.from) && ids.has(r.to), r.id);
  }
  assert.ok(chartText([...cs.values()][0]).length > 0);
  assert.equal(stubTitle({ class: 'R0' }), 'returns nothing');
  assert.equal(stubTitle({ class: 'raise:*', rt: 'rethrow' }), 'rethrows the error');
});

test('a map whose sources changed since it was written is refused by the review', skipPy, () => {
  const src = path.join(WORK, 'stale_src');
  const proj = path.join(WORK, 'stale_proj');
  const out = path.join(proj, 'map');
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
  fs.cpSync(`${FIX}/truth_py`, src, { recursive: true });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const m = run('map', '--source', src, '--project', proj, '--no-page', '--quiet'); // no language named: every language found is mapped
  assert.equal(m.status, 0, m.stderr);
  assert.equal(run('review', 'queue', '--map', out, '--source', src, '--limit', '1').status, 0);
  fs.appendFileSync(path.join(src, 'tr_roads.py'), '\n# edited after the map was written\n');
  const q = run('review', 'queue', '--map', out, '--source', src);
  assert.equal(q.status, 1);
  assert.match(q.stderr, /changed after this map was built/);
});

test('faultline map and faultline review work on a folder of Python files', skipPy, () => {
  const proj = path.join(WORK, 'cli_proj');
  const out = path.join(proj, 'map');
  fs.rmSync(proj, { recursive: true, force: true });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const m = run('map', '--source', `${FIX}/truth_py`, '--project', proj, '--no-page', '--python', '**', '--name', 'truth_py', '--quiet');
  assert.equal(m.status, 0, m.stderr);
  assert.match(m.stdout, /truth_py: \d+ boxes, \d+ roads, \d+ claims/);
  const a = JSON.parse(fs.readFileSync(path.join(out, 'claims.json'), 'utf8'));
  const q = run('review', 'queue', '--map', out, '--source', `${FIX}/truth_py`, '--limit', '2');
  assert.equal(q.status, 0, q.stderr);
  assert.match(q.stdout, /truth_py: \d+ claims, \d+ not confident, \d+ questions/);
  const v = run('review', 'view', '--map', out, '--source', `${FIX}/truth_py`, '--without-agent');
  assert.deepEqual(JSON.parse(v.stdout), a);
  const answers = path.join(out, 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ schema: 'faultline.review-answers/1', answers: [{ item: 'q:nothing', choice: 'x', cite: 'a:1', quote: 'y' }] }));
  const c = run('review', 'check', '--map', out, '--source', `${FIX}/truth_py`, '--answers', answers);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /"refused":1/);
});
