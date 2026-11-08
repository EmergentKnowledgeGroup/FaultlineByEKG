// `faultline map`: one command from a folder of code to a page, with no agent. Every tree here is invented.
import { needs as needsOf } from './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chooseLanguages, refuseHandMade } from '../src/read/page/run.mjs';
import { callTable } from '../src/map/calltable.mjs';
import { finishedGates, TOOL_MAP_RETIRED } from '../src/model/finished.mjs';
import { readSystem } from '../src/read/index.mjs';
import { CallModel } from '../src/read/callsites.mjs';
import { buildWorld } from '../src/read/world.mjs';
import { Source } from '../src/read/source.mjs';
import { makeShop } from './lib/read-helpers.mjs';
import { capabilities, build, FIX } from './lib/map-helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'faultline.mjs');
const tree = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-tm-')).replace(/\\/g, '/');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
};
const cap = await capabilities();
const skipPy = !cap.python && 'no Python 3.10 or newer';
const needsChecker = needsOf(cap, 'python', 'checker').skip;
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('with no language named, the map reads exactly the files the scan counts as source: tests and fixtures are left out', async () => {
  const root = tree({
    'app/main.py': 'def run():\n    return 1\n', 'app/tests/test_main.py': 'def test_run():\n    assert True\n', 'app/fixtures/data.py': 'X = 1\n',
    'web/page.ts': 'export function show(): number { return 1; }\n', 'web/page.spec.ts': 'export const t = 1;\n',
  });
  const notes = [];
  const { config } = await chooseLanguages(root, {}, notes, {});
  assert.deepEqual(config.python?.include, ['app/main.py']);
  assert.deepEqual(config.typescript?.only, ['web/page.ts']);
  assert.equal(config.lua, undefined);
});

test('a folder with nothing to read is refused in words', async () => {
  const root = tree({ 'notes.txt': 'nothing here\n' });
  await assert.rejects(chooseLanguages(root, {}, [], {}), /nothing to read/);
});

test('a project folder that holds a map written by hand is not overwritten', () => {
  const dir = tree({ 'model/00-system.json': JSON.stringify({ system: { name: 'x' } }), 'model/10-flow.json': '{}' });
  assert.throws(() => refuseHandMade(dir), /written by hand/);
  const mine = tree({ 'model/00-system.json': JSON.stringify({ system: { toolMap: true } }), 'model/10-flows.json': '{}' });
  assert.doesNotThrow(() => refuseHandMade(mine));
  assert.doesNotThrow(() => refuseHandMade(tree({})));
});

test('the ledger gates B1, M1, E1, S1 and S2 are not applied to a tool map, and still are to a map written by hand', () => {
  const g = { boxes: [], routes: [], inX: () => [], outX: () => [] };
  const census = { endings: [{ id: 'e1', kind: 'outcome', value: 'ok', confidence: 'high', fn: 'a.py::f', line: 3 }], branches: [], passes: [{ id: 'p1' }] };
  const facts = { modules: [{ path: 'a.py' }] };
  const by = (system) => finishedGates({ system, boxes: [], routes: [], ledger: {}, modules: {} }, facts, census, g).map((r) => r.code);
  const hand = by({});
  for (const code of ['B1', 'M1', 'S2']) assert.ok(hand.includes(code), `${code} still fires on a map written by hand`);
  const tool = by({ toolMap: true });
  for (const code of TOOL_MAP_RETIRED) assert.ok(!tool.includes(code), `${code} is retired for a tool map`);
});

test('the reading uses the exact first and last line of a function from the code index before it guesses from the text', () => {
  const m = makeShop();
  const fid = [...new Set(m.model.boxes.map((b) => b.prov.fn))][0];
  const make = (spans) => {
    const W = buildWorld({ model: m.model, claims: m.claims, facts: null, spans, source: new Source(m.root) });
    return new CallModel(W, { label: (f) => f }).region(fid);
  };
  const guessed = make(null);
  const exact = make({ [fid]: { l: 2, e: 4 } });
  assert.deepEqual([exact.from, exact.to, exact.known], [2, 4, true]);
  assert.notDeepEqual([guessed.from, guessed.to], [2, 4]);
});

test('the chart budget is in bytes: a smaller budget draws fewer charts, the same budget the same ones', () => {
  const m = makeShop();
  const read = (chartBytes) => readSystem({ model: m.model, claims: m.claims, facts: m.facts, sourceRoot: m.root, name: 'shop', chartBytes });
  const all = read(undefined), none = read(1), again = read(undefined);
  assert.ok(all.charts.stats.chartedFunctions >= 1);
  assert.equal(none.charts.stats.chartedFunctions, 0, 'a budget too small for any chart draws none');
  assert.equal(JSON.stringify(all.charts), JSON.stringify(again.charts));
});

test('the call table has a row for every call the rules looked at, in function order, and the same text twice', { skip: !cap.python && !cap.typescript && 'nothing to read here' }, async () => {
  const b = await build('truth_py', { py: true });
  const rows = callTable(b.res.P);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.length, 4);
    assert.ok(['call', 'with', 'link'].includes(r[3].t));
  }
  const ids = rows.map((r) => r[0]);
  assert.deepEqual(ids, [...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
  assert.equal(JSON.stringify(callTable(b.res.P)), JSON.stringify(rows));
});

test('faultline map --no-page writes the map, the reading and the page project, and says what could not be read', { skip: skipPy }, () => {
  const proj = path.join(os.tmpdir(), 'fl-tm-proj-' + process.pid).replace(/\\/g, '/');
  fs.rmSync(proj, { recursive: true, force: true });
  const run = () => spawnSync(process.execPath, [CLI, 'map', '--source', `${FIX}/truth_py`, '--project', proj, '--no-page'], { encoding: 'utf8' });
  const a = run();
  assert.equal(a.status, 0, a.stderr);
  for (const f of ['map/model.json', 'map/claims.json', 'map/calls.json', 'map/review-index.json', 'map/story-index.json', 'read/reading.json', 'read/charts.json', 'read/words.json', 'model/00-system.json', 'model/10-flows.json']) {
    assert.ok(fs.existsSync(path.join(proj, f)), `${f} was written`);
  }
  assert.match(a.stdout, /stopped before the page/);
  assert.ok(!fs.existsSync(path.join(proj, 'dist')), 'no page without a page');
  const first = ['map/model.json', 'map/claims.json', 'map/calls.json', 'read/reading.json', 'read/charts.json'].map((f) => hash(path.join(proj, f)));
  const b = run();                                                  // warm: the checker's answers are kept
  assert.equal(b.status, 0, b.stderr);
  const second = ['map/model.json', 'map/claims.json', 'map/calls.json', 'read/reading.json', 'read/charts.json'].map((f) => hash(path.join(proj, f)));
  assert.deepEqual(second, first, 'the same code gives the same bytes, cold or warm');
  const sys = JSON.parse(fs.readFileSync(path.join(proj, 'model/00-system.json'), 'utf8')).system;
  assert.equal(sys.toolMap, true);
  assert.equal(sys.charts.stage, false);
});

test('faultline map with no Python on the machine says so and maps the rest', { skip: skipPy }, () => {
  const root = tree({ 'app/main.py': 'def run():\n    return 1\n', 'web/page.ts': 'export function show(): number { return 1; }\nexport function hide(): number { return show(); }\n' });
  const proj = path.join(os.tmpdir(), 'fl-tm-nopy-' + process.pid).replace(/\\/g, '/');
  fs.rmSync(proj, { recursive: true, force: true });
  const r = spawnSync(process.execPath, [CLI, 'map', '--source', root, '--project', proj, '--no-page', '--interpreter', path.join(os.tmpdir(), 'no-such-python')], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'a named interpreter that does not run is an error, not a guess');
  assert.match(r.stderr, /did not run/);
});

test('a decision whose test holds a Python lambda is still a decision of its function: the arm not taken is not walked', { skip: needsChecker }, () => {
  const root = tree({
    'src/boiler.py': [
      'import threading', '', '', 'class Boiler:', '    def __init__(self):', '        self._halt = threading.Event()', '        self._kettle = None', '',
      '    def _whistle(self, why):', '        print(why)', '', '    def _tend(self):', '        while not self._halt.wait(2.0):', '            kettle = self._kettle',
      '            if kettle is None or getattr(kettle, "state", lambda: 1)() is not None:', '                self._whistle("gone")', '                return',
      '            if self._halt.is_set():', '                self._whistle("halted")', '                return', '', '    def start(self):', '        threading.Thread(target=self._tend).start()', '', '',
      'def main():', '    Boiler().start()', '', '', 'if __name__ == "__main__":', '    main()', '',
    ].join('\n'),
  });
  const proj = path.join(os.tmpdir(), 'fl-tm-lam-' + process.pid).replace(/\\/g, '/');
  fs.rmSync(proj, { recursive: true, force: true });
  const r = spawnSync(process.execPath, [CLI, 'map', '--source', root, '--project', proj, '--no-page', '--quiet'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = fs.readFileSync(path.join(proj, 'read/journeys.txt'), 'utf8').split('\n');
  const at = lines.findIndex((l) => /\[no\]\s+\(line 15\)/.test(l));
  assert.ok(at >= 0, 'the decision with the lambda is walked');
  assert.ok(!/Boiler\._whistle/.test(lines[at + 1]), 'the call in the arm that was not taken is not walked right after it: ' + lines[at + 1]);
});

test('review and story say when the folder the map was made from is not where they look, instead of failing on a file', { skip: skipPy }, () => {
  const proj = path.join(os.tmpdir(), 'fl-tm-root-' + process.pid).replace(/\\/g, '/');
  fs.rmSync(proj, { recursive: true, force: true });
  const m = spawnSync(process.execPath, [CLI, 'map', '--source', `${FIX}/truth_py`, '--project', proj, '--no-page', '--quiet'], { encoding: 'utf8' });
  assert.equal(m.status, 0, m.stderr);
  const elsewhere = tree({ 'other.txt': 'not the code\n' });
  const r = spawnSync(process.execPath, [CLI, 'review', 'queue', '--project', proj, '--source', elsewhere], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Pass --source/);
  const ok = spawnSync(process.execPath, [CLI, 'review', 'queue', '--project', proj, '--source', `${FIX}/truth_py`, '--limit', '1'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});

test('agent links open a chart the page has: the overview, or the chart holding the box, when the map draws no whole-system chart', async () => {
  const { makeCtx } = await import('../src/agent/view.mjs');
  const tool = makeCtx({ charts: [{ id: 'c1', kind: 'detail' }, { id: 'c2', kind: 'detail' }], boxes: { 'f1.0': { chart: 'c2' } } }, { linkBase: 'page.html' });
  assert.equal(tool.link(tool.wholeId, null), 'page.html#chart=overview');
  assert.equal(tool.linkBox('f1.0'), 'page.html#chart=c2&node=f1.0');
  assert.equal(tool.link(tool.wholeId, 'f1.0'), 'page.html#chart=c2&node=f1.0');
  const hand = makeCtx({ charts: [{ id: 'whole', kind: 'whole' }, { id: 'c1', kind: 'detail' }], boxes: { 'a.b': { chart: 'c1' } } }, { linkBase: 'page.html' });
  assert.equal(hand.link(hand.wholeId, 'a.b'), 'page.html#chart=whole&node=a.b', 'a map with a whole chart is unchanged');
});

test('the brief of a tool map speaks of no ledger and claims no order of running', { skip: skipPy }, () => {
  const proj = path.join(os.tmpdir(), 'fl-tm-brief-' + process.pid);
  fs.rmSync(proj, { recursive: true, force: true });
  const m = spawnSync(process.execPath, [CLI, 'map', '--source', `${FIX}/truth_py`, '--project', proj, '--no-page', '--quiet'], { encoding: 'utf8' });
  assert.equal(m.status, 0, m.stderr);
  const b = spawnSync(process.execPath, [CLI, 'brief', '--project', proj], { encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr);
  assert.ok(!/Accounted:/.test(b.stdout), 'no ledger tally');
  assert.match(b.stdout, /STAGES largest first/);
  assert.ok(b.stdout.length / 4 <= 1200, 'within the brief cap');
});

test('a scope folder given with a trailing slash is the same folder: no path gets a double slash', async () => {
  const root = tree({ 'lib/a.ts': 'export function a(): number { return 1; }\n' });
  const { config } = await chooseLanguages(root, { typescript: 'lib/', lua: './lib//' }, [], {});
  assert.equal(config.typescript.prefix, 'lib');
  assert.equal(config.lua.prefix, 'lib');
});
