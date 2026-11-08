// Evidence tests: walks, mapping, coverage, logs, statechart export, explorer runner. All against the toy system.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  importWalks, parseWalk, validateWalk, formatWalk, honestSays, coverageToWalk, importCoverageFile, neverRan, logsToWalk, spansToWalk,
  statechartToWalk, exportStatechart, parseReport, parseChart, buildIndex, mapStep, runExplorer, replayWitnessFile, parseCoverage,
} from '../src/evidence/index.mjs';
import { writeWalkFile, readWalkFile } from '../src/evidence/walk.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOY = path.resolve(HERE, '../examples/toy');
const ADAPTER = path.join(TOY, 'explorer_adapter.py');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
let TMP;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-evidence-')); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
const fresh = (name) => { const d = path.join(TMP, name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };

// ---- toy facts and model, built here so these tests do not depend on the extract code ------------------------------
function toyFacts() {
  const functions = {}, modules = [];
  const dir = path.join(TOY, 'parcelworks');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.py')).sort()) {
    const rel = 'parcelworks/' + f;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const lines = text.split(/\r?\n/);
    modules.push({ path: rel, lang: 'py', lines: lines.length, sha256: sha(text), imports: [], externalImports: [] });
    const stack = [];
    lines.forEach((ln, i) => {
      const m = /^(\s*)(async\s+)?def\s+(\w+)/.exec(ln) || /^(\s*)()class\s+(\w+)/.exec(ln);
      if (!m) return;
      const indent = m[1].length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const isClass = /^\s*class\b/.test(ln);
      const qual = [...stack.map((s) => s.name), m[3]].join('.');
      let end = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (/^(\s*)/.exec(lines[j])[1].length <= indent) break;
        end = j + 1;
      }
      stack.push({ indent, name: m[3] });
      if (!isClass) functions[`${rel}::${qual}`] = { path: rel, qual, line: i + 1, end, sha256: sha(lines.slice(i, end).join('\n')), calls: [] };
    });
  }
  const bare = new Map();
  for (const [id, f] of Object.entries(functions)) { const t = f.qual.split('.').pop(); bare.set(t, bare.has(t) ? null : id); }
  for (const [id, f] of Object.entries(functions)) {
    const body = fs.readFileSync(path.join(TOY, f.path), 'utf8').split(/\r?\n/).slice(f.line, f.end).join('\n');
    const calls = new Set();
    for (const m of body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) { const t = bare.get(m[1]); if (t && t !== id) calls.add(t); }
    f.calls = [...calls].sort();
  }
  return { schema: 'faultline.facts/1', root: TOY.replace(/\\/g, '/'), pin: { git: null, tree: sha(modules.map((m) => m.sha256).join('')) }, modules, functions };
}
function toyModel() {
  const d = path.join(TOY, '.faultline', 'model');
  const m = { boxes: [], routes: [], stages: [] };
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json')).sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
    for (const k of Object.keys(m)) if (j[k]) m[k].push(...j[k]);
  }
  return m;
}
const FACTS = toyFacts();
const MODEL = toyModel();
const project = (name, walks = {}) => {
  const dir = fresh(name);
  fs.mkdirSync(path.join(dir, 'walks'), { recursive: true });
  for (const [f, text] of Object.entries(walks)) fs.writeFileSync(path.join(dir, 'walks', f), text);
  return dir;
};
const FIXTURE_WALK = fs.readFileSync(path.join(TOY, 'fixtures/address-hold.walk.jsonl'), 'utf8');
const walkText = (header, label, outcomes) => formatWalk({ header: { tool: 'test@1', kind: 'run', pin: null, ...header }, label: { label: 'SAMPLED', controls_passed: false, explored: [], unexplored: [], ...label }, outcomes });
const outcome = (o) => ({ outcome: 'unknown', strength: 'observed', reason: '', witness: null, count: 1, steps: [], ...o });

test('toy facts and model line up (the rest of this file relies on it)', () => {
  assert.ok(Object.keys(FACTS.functions).length >= 35);
  assert.equal(MODEL.boxes.length, 35);
  const ix = buildIndex(MODEL, FACTS);
  const missing = ix.warnings.filter((w) => !/web\//.test(w.msg));
  assert.deepEqual(missing, [], 'every Python symbol a box cites exists in the facts');
});

// ---- walk format ---------------------------------------------------------------------------------------------------
test('walk: the checked-in toy trace parses and validates', () => {
  const w = parseWalk(FIXTURE_WALK);
  const v = validateWalk(w);
  assert.ok(v.ok, v.errors.join('; '));
  assert.equal(w.outcomes.length, 2);
  assert.equal(v.effectiveLabel, 'SAMPLED');
});

test('walk: bad shapes are rejected with a reason', () => {
  const bad = (text) => validateWalk(parseWalk(text));
  assert.ok(bad('{"label":"SAMPLED"}').errors.some((e) => /no header/.test(e)));
  assert.ok(bad('{"walk":1,"tool":"x","kind":"nope"}\n{"label":"SAMPLED"}').errors.some((e) => /kind/.test(e)));
  assert.ok(bad('{"walk":1,"tool":"x","kind":"run"}\n{"label":"MOSTLY"}').errors.some((e) => /label/.test(e)));
  assert.ok(bad('{"walk":1,"tool":"x","kind":"run"}\n{"label":"NONE"}\n{"outcome":"dead","strength":"observed","steps":[]}').errors.some((e) => /outcome/.test(e)));
  assert.ok(bad('{"walk":1,"tool":"x","kind":"run"}\n{"label":"NONE"}\n{"outcome":"unknown","strength":"sure","steps":[]}').errors.some((e) => /strength/.test(e)));
  assert.ok(bad('{"walk":1,"tool":"x","kind":"run"}\nnot json').errors.some((e) => /not JSON/.test(e)));
});

test('walk: only an exhaustive search with passed controls may say "no violation found"', () => {
  for (const l of ['NONE', 'SAMPLED', 'BOUNDED_INCOMPLETE']) for (const c of [true, false]) assert.doesNotMatch(honestSays(l, c), /no violation found/);
  assert.doesNotMatch(honestSays('EXHAUSTIVE_WITHIN_MODEL', false), /no violation found/);
  assert.match(honestSays('EXHAUSTIVE_WITHIN_MODEL', true), /^no violation found/);
  // an exhaustive claim that lists unexplored items is not exhaustive
  const w = parseWalk(walkText({}, { label: 'EXHAUSTIVE_WITHIN_MODEL', controls_passed: true, unexplored: [{ at: 'queue.claim', why: 'budget cut' }] }, []));
  const v = validateWalk(w);
  assert.equal(v.effectiveLabel, 'BOUNDED_INCOMPLETE');
  assert.doesNotMatch(v.says, /no violation found/);
});

test('walk: formatWalk is byte-stable and round-trips', () => {
  const text = walkText({ pin: 'abc' }, { explored: ['queue.claim'] }, [outcome({ outcome: 'end:report.saved', steps: [{ tag: 'queue.claim' }] })]);
  assert.equal(formatWalk({ header: parseWalk(text).header, label: parseWalk(text).label, outcomes: parseWalk(text).outcomes }), text);
});

// ---- step to box ---------------------------------------------------------------------------------------------------
test('mapping: ref inside a cited body, then sym, then tag; nothing is guessed', () => {
  const ix = buildIndex(MODEL, FACTS);
  const accept = mapStep(ix, { ref: 'parcelworks/intake.py:35', sym: 'parcelworks/intake.py::accept' });
  assert.equal(accept.status, 'mapped');
  assert.equal(accept.via, 'ref');
  assert.equal(accept.cands[0].box, 'intake.dedupe', 'four boxes cite accept: the nearest cited line wins');
  assert.ok(accept.cands.length >= 4);
  assert.equal(mapStep(ix, { sym: 'parcelworks/worker.py::Worker.process_one' }).via, 'sym');
  assert.deepEqual(mapStep(ix, { tag: 'queue.claim' }).cands.map((c) => c.box), ['queue.claim']);
  assert.equal(mapStep(ix, { tag: 'queue' }).status, 'unmapped');
  // a stage name is a stage, not a box
  const stage = mapStep(ix, { tag: MODEL.stages[0].id });
  assert.equal(stage.status, 'stage');
  // cited by no box: NOT MAPPED
  const get = mapStep(ix, { ref: 'parcelworks/jobqueue.py:62', sym: 'parcelworks/jobqueue.py::Queue.get' });
  assert.equal(get.status, 'unmapped');
  assert.match(get.why, /cited by no box/);
  assert.equal(mapStep(ix, { ref: 'elsewhere/nope.py:3' }).status, 'unmapped');
  assert.equal(mapStep(ix, {}).status, 'unmapped');
  // absolute and backslash paths resolve to the repo-relative file
  assert.equal(mapStep(ix, { ref: `${TOY}/parcelworks/intake.py:35`.replace(/\//g, '\\') }).status, 'mapped');
});

test('importWalks: the toy trace lights what it reached, not what it did not', () => {
  const dir = project('p-trace', { 'trace.walk.jsonl': FIXTURE_WALK });
  const ov = importWalks(dir, MODEL, FACTS);
  assert.equal(ov.rejected.length, 0);
  assert.equal(ov.walks[0].pin, 'match');
  const b = ov.boxes;
  assert.equal(b['trouble.hold_address'].level, 'seen', 'observed, not replayable: seen, never proved');
  assert.deepEqual(b['trouble.hold_address'].outcomes, ['stuck']);
  assert.equal(b['report.saved'].level, 'seen');
  assert.deepEqual(b['report.saved'].outcomes, ['end']);
  for (const id of ['work.lease_lost', 'trouble.hold_customs', 'intake.fast_done', 'trouble.failed']) assert.ok(!b[id] || b[id].level === 'drawn', `${id} must not light`);
  assert.ok(ov.boxes['work.lease_lost'].untested, 'the walk itself says the lease never expired');
  // two traced functions that no box cites come back NOT MAPPED, grouped
  const keys = ov.notMapped.map((n) => n.key);
  assert.ok(keys.includes('parcelworks/jobqueue.py::Queue.get') && keys.includes('parcelworks/jobqueue.py::Queue.all_jobs'));
  assert.equal(ov.notMapped.find((n) => n.key.endsWith('Queue.get')).count, 4);
  assert.match(ov.labels[0].says, /more may exist/);
  assert.doesNotMatch(ov.labels[0].says, /no violation found/);
  assert.equal(ov.labels[0].effective, 'SAMPLED');
});

test('importWalks: replay reports where a trace stops fitting, and the longest explained prefix', () => {
  const steps = (...tags) => tags.map((tag) => ({ tag }));
  const ok = outcome({ outcome: 'end:report.saved', steps: steps('intake.submit', 'intake.required', 'intake.weight', 'intake.format', 'intake.dedupe', 'intake.lane', 'intake.enqueue') });
  const broken = outcome({ outcome: 'unknown', steps: steps('intake.submit', 'intake.required', 'report.saved', 'queue.claim') });
  const dir = project('p-gap', { 'ok.walk.jsonl': walkText({}, {}, [ok]), 'broken.walk.jsonl': walkText({ tool: 'test@2' }, {}, [broken]) });
  const ov = importWalks(dir, MODEL, FACTS);
  const good = ov.walks.find((w) => w.walk === 'ok.walk.jsonl');
  const bad = ov.walks.find((w) => w.walk === 'broken.walk.jsonl');
  assert.equal(good.gaps, 0, 'a chain of drawn routes is fully explained');
  assert.equal(good.explainedPrefix, 7);
  assert.equal(bad.gaps, 2);
  assert.equal(bad.explainedPrefix, 2, 'two steps fit, the third does not');
  const first = ov.missingRoutes.find((m) => m.first);
  assert.deepEqual(first.from, ['intake.required']);
  assert.deepEqual(first.to, ['report.saved']);
  assert.equal(first.explainedPrefix, 2);
  // route counts: only routes that exist and were walked thicken
  assert.equal(ov.routes.r_required_ok.count, 1);
  assert.equal(ov.routes.r_submit_required.count, 2);
  assert.equal(ov.routes.r_weight_ok.count, 1);
});

test('importWalks: stale is per box, from function hashes, and stale evidence does not lift a level', () => {
  const claim = 'parcelworks/jobqueue.py::Queue.claim';
  const hashes = { [claim]: FACTS.functions[claim].sha256, 'parcelworks/handlers.py::route': FACTS.functions['parcelworks/handlers.py::route'].sha256 };
  const w = walkText({ hashes, pin: 'old-pin' }, {}, [outcome({ steps: [{ tag: 'queue.claim' }, { sym: 'parcelworks/handlers.py::route', ref: 'parcelworks/handlers.py:26' }] })]);
  const dir = project('p-stale', { 'a.walk.jsonl': w });
  const same = importWalks(dir, MODEL, FACTS);
  assert.equal(same.stale.length, 0);
  assert.equal(same.boxes['queue.claim'].level, 'seen');
  // change one function body
  const facts2 = JSON.parse(JSON.stringify(FACTS));
  facts2.functions[claim].sha256 = 'f'.repeat(64);
  const ov = importWalks(dir, MODEL, facts2);
  assert.deepEqual(ov.stale.map((s) => s.fn), [claim]);
  assert.ok(ov.stale[0].boxes.includes('queue.claim'));
  assert.equal(ov.boxes['queue.claim'].level, 'drawn', 'stale evidence does not count');
  assert.equal(ov.boxes['queue.claim'].stale, true);
  assert.equal(ov.boxes['queue.claim'].staleLevel, 'seen');
  assert.equal(ov.boxes['work.route'].level, 'seen', 'the rest of the map is untouched');
  assert.equal(ov.boxes['work.route'].stale, false);
});

test('importWalks: a replayable or proved claim without a witness on disk counts only as claimed', () => {
  const o = outcome({ outcome: 'stuck:trouble.hold_address', strength: 'replayable', witness: 'nowhere.json', steps: [{ tag: 'trouble.hold_address' }] });
  const dir = project('p-nowit', { 'a.walk.jsonl': walkText({}, {}, [o]) });
  const ov = importWalks(dir, MODEL, FACTS);
  assert.ok(ov.warnings.some((x) => x.code === 'witness-missing'));
  assert.notEqual(ov.boxes['trouble.hold_address']?.level, 'proved');
  assert.notEqual(ov.boxes['trouble.hold_address']?.level, 'seen');
  assert.ok(ov.boxes['trouble.hold_address'].claimed >= 1);
});

// ---- coverage ------------------------------------------------------------------------------------------------------
const COVERAGE_JSON = fs.readFileSync(path.join(TOY, 'fixtures/coverage.json'), 'utf8');
const litBoxes = (ov) => Object.entries(ov.boxes).filter(([, b]) => b.level === 'seen' || b.level === 'proved').map(([id]) => id).sort();

test('coverage.py: a box lights only if a cited body line ran; the planted untested ending shows', () => {
  const dir = project('p-cov');
  const r = importCoverageFile(path.join(TOY, 'fixtures/coverage.json'), FACTS, { projectDir: dir, model: MODEL });
  assert.equal(r.format, 'coverage-py');
  assert.equal(r.unmatchedFiles.length, 0);
  assert.equal(r.ran + r.notRun, r.functionsSeen);
  const ov = importWalks(dir, MODEL, FACTS);
  assert.equal(ov.boxes['queue.claim'].level, 'seen');
  assert.equal(ov.boxes['work.lease_lost'].level, 'drawn', 'Worker.process_one ran, but the lease_lost line did not');
  assert.equal(ov.boxes['work.lease_lost'].untested, true);
  assert.match(ov.boxes['work.lease_lost'].reasons[0], /cited line 32 never ran/);
  assert.equal(ov.boxes['report.busy'].untested, true, 'the OSError retry branch is never reached');
  assert.deepEqual(neverRan(ov, MODEL).map((x) => x.box), ['work.lease_lost', 'report.busy']);
  assert.equal(ov.boxes['web.submit'], undefined, 'a file coverage never mentioned gets no claim either way');
  assert.equal(ov.boxes['report.returned'].anchorOnly, true, 'an end with no road in is lit by its anchor line only: the line ran, nobody arrived');
  assert.equal(ov.boxes['report.saved'].anchorOnly, undefined);
  // no order in coverage: nothing to replay
  assert.equal(ov.walks[0].gaps, 0);
  assert.equal(ov.missingRoutes.length, 0);
  assert.equal(ov.labels[0].effective, 'SAMPLED');
  assert.doesNotMatch(ov.labels[0].says, /no violation found/);
});

test('coverage: the def line runs at import, so a function whose only executed line is its def did not run', () => {
  const claim = FACTS.functions['parcelworks/jobqueue.py::Queue.claim'];
  const mod = 'parcelworks/jobqueue.py';
  const inMod = Object.values(FACTS.functions).filter((x) => x.path === mod);
  const defs = inMod.map((x) => x.line);
  const body = inMod.filter((x) => x.qual !== 'Queue.claim').flatMap((x) => Array.from({ length: x.end - x.line }, (_, i) => x.line + 1 + i));
  const f = { [mod]: { executed_lines: [...defs, ...body], missing_lines: Array.from({ length: claim.end - claim.line }, (_, i) => claim.line + 1 + i) } };
  const { walk, stats } = coverageToWalk(JSON.stringify({ meta: { version: '7', format: 3 }, files: f }), FACTS, { model: MODEL });
  assert.ok(walk.label.unexplored.some((u) => u.at === 'parcelworks/jobqueue.py::Queue.claim'));
  assert.ok(!walk.label.explored.includes('parcelworks/jobqueue.py::Queue.claim'));
  assert.ok(walk.label.explored.includes('parcelworks/jobqueue.py::Queue.enqueue'));
  assert.ok(stats.notRun >= 1);
  const dir = project('p-cov-def');
  writeWalkFile(path.join(dir, 'walks', 'c.walk.jsonl'), walk);
  const ov = importWalks(dir, MODEL, FACTS);
  assert.equal(ov.boxes['queue.claim'].untested, true);
});

function toLcov(json) {
  const out = [];
  for (const [file, f] of Object.entries(JSON.parse(json).files)) {
    out.push('TN:', `SF:${TOY}/${file}`);
    for (const n of f.executed_lines) out.push(`DA:${n},1`);
    for (const n of f.missing_lines) out.push(`DA:${n},0`);
    out.push('end_of_record');
  }
  return out.join('\n') + '\n';
}
function toIstanbul(json) {
  const out = {};
  for (const [file, f] of Object.entries(JSON.parse(json).files)) {
    const lines = [...f.executed_lines.map((n) => [n, 1]), ...f.missing_lines.map((n) => [n, 0])];
    const abs = `${TOY}/${file}`.replace(/\//g, '\\');
    out[abs] = { path: abs, statementMap: Object.fromEntries(lines.map(([n], i) => [String(i), { start: { line: n, column: 0 }, end: { line: n, column: 9 } }])),
      s: Object.fromEntries(lines.map(([, c], i) => [String(i), c])), fnMap: {}, f: {}, branchMap: {}, b: {} };
  }
  return JSON.stringify(out);
}

test('coverage: lcov and istanbul give the same lit boxes as coverage.py', () => {
  const via = (name, text) => {
    const { walk } = coverageToWalk(text, FACTS, { model: MODEL });
    const dir = project(name);
    writeWalkFile(path.join(dir, 'walks', 'c.walk.jsonl'), walk);
    return importWalks(dir, MODEL, FACTS);
  };
  const py = via('p-cov-py', COVERAGE_JSON);
  const lcov = via('p-cov-lcov', toLcov(COVERAGE_JSON));
  const ist = via('p-cov-ist', toIstanbul(COVERAGE_JSON));
  assert.deepEqual(litBoxes(lcov), litBoxes(py));
  assert.deepEqual(litBoxes(ist), litBoxes(py));
  assert.deepEqual(lcov.untested, py.untested);
  assert.deepEqual(ist.untested, py.untested);
  assert.equal(parseCoverage(toLcov(COVERAGE_JSON)).fmt, 'lcov');
  assert.equal(parseCoverage(toIstanbul(COVERAGE_JSON)).fmt, 'istanbul');
  assert.throws(() => parseCoverage('hello'), /cannot tell the coverage format/);
});

test('coverage: function counters decide one-line functions, and unknown files are reported, not guessed', () => {
  const facts = { root: '/r', pin: { git: null, tree: 't' }, modules: [{ path: 'a.js' }],
    functions: { 'a.js::tiny': { path: 'a.js', qual: 'tiny', line: 3, end: 3, sha256: 'h1' }, 'a.js::big': { path: 'a.js', qual: 'big', line: 5, end: 9, sha256: 'h2' } } };
  const lcov = 'SF:/somewhere/else/a.js\nFN:3,tiny\nFNDA:4,tiny\nFN:5,big\nFNDA:0,big\nDA:3,4\nDA:5,1\nDA:6,0\nDA:7,0\nend_of_record\nSF:/x/unknown.js\nDA:1,1\nend_of_record\n';
  const { walk, stats } = coverageToWalk(lcov, facts, {});
  assert.deepEqual(walk.label.explored, ['a.js::tiny']);
  assert.deepEqual(walk.label.unexplored.map((u) => u.at), ['a.js::big']);
  assert.equal(walk.outcomes[0].steps[0].hits, 4);
  assert.deepEqual(stats.unmatchedFiles, ['/x/unknown.js']);
  assert.deepEqual(walk.header.hashes, { 'a.js::tiny': 'h1', 'a.js::big': 'h2' });
});

// ---- logs and spans ------------------------------------------------------------------------------------------------
test('logs: JSON lines through a field map, matched by function name or tag, never guessed', () => {
  const rec = (run, ts, o) => JSON.stringify({ req: run, t: ts, m: o.m || '', ctx: { fn: o.fn }, box: o.box, lvl: o.lvl || 'info', event: o.event });
  const lines = [
    rec('r1', 1, { fn: 'cmd_submit', m: 'submit' }), rec('r1', 2, { fn: 'claim' }), rec('r1', 3, { fn: 'route' }), rec('r1', 4, { box: 'trouble.hold_address', event: 'held' }),
    rec('r2', 1, { fn: 'cmd_submit' }), rec('r2', 2, { fn: 'claim' }), rec('r2', 3, { fn: 'route' }), rec('r2', 4, { box: 'trouble.hold_address', event: 'held' }),
    rec('r3', 1, { fn: '__init__', m: 'ambiguous name' }), rec('r3', 2, { fn: 'no_such_function', lvl: 'error', m: 'it blew up' }),
    'this line is not json',
  ].join('\n');
  const cfg = { fields: { fn: 'ctx.fn', tag: 'box', run: 'req', time: 't', level: 'lvl', msg: 'm' }, outcomes: [{ field: 'event', equals: 'held', outcome: 'stuck:trouble.hold_address' }] };
  const { walk, stats } = logsToWalk(lines, MODEL, FACTS, cfg);
  assert.equal(stats.badLines, 1);
  assert.equal(stats.runs, 3);
  const held = walk.outcomes.find((o) => o.outcome === 'stuck:trouble.hold_address');
  assert.equal(held.count, 2, 'two runs with the same steps and ending are one outcome with a count');
  assert.deepEqual(held.steps.map((s) => s.sym || s.tag), ['parcelworks/cli.py::cmd_submit', 'parcelworks/jobqueue.py::Queue.claim', 'parcelworks/handlers.py::route', 'trouble.hold_address']);
  const err = walk.outcomes.find((o) => o.outcome === 'error');
  assert.match(err.reason, /it blew up/);
  assert.ok(err.steps.every((s) => !s.sym), 'an ambiguous name and an unknown name stay unresolved');
  assert.equal(stats.ambiguousNames, 1);
  const dir = project('p-logs');
  writeWalkFile(path.join(dir, 'walks', 'l.walk.jsonl'), walk);
  const ov = importWalks(dir, MODEL, FACTS);
  assert.equal(ov.boxes['trouble.hold_address'].level, 'seen', 'a log is an observation, not a replay');
  assert.equal(ov.boxes['queue.claim'].level, 'seen');
  assert.ok(ov.notMapped.some((n) => n.key === 'no_such_function' || n.key === '__init__'));
  assert.equal(walk.label.label, 'SAMPLED');
});

test('spans: OTLP json and flat span lists, ordered by start time, errors become error outcomes', () => {
  const attr = (k, v) => ({ key: k, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } });
  const span = (id, parent, start, name, attrs, code = 0, msg = '') => ({ traceId: 'T1', spanId: id, parentSpanId: parent, name, startTimeUnixNano: String(start), attributes: attrs, status: { code, message: msg } });
  const otlp = { resourceSpans: [{ scopeSpans: [{ spans: [
    span('c', 'b', 3_000_000_000, 'ignored', [attr('code.namespace', 'parcelworks.handlers'), attr('code.function', 'route')], 2, 'carrier unreachable'),
    span('a', '', 1_000_000_000, 'cmd_submit', []),
    span('b', 'a', 2_000_000_000, 'work', [attr('code.namespace', 'parcelworks.jobqueue.Queue'), attr('code.function', 'claim'), attr('code.filepath', 'parcelworks/jobqueue.py'), attr('code.lineno', 77)]),
  ] }] }] };
  const { walk, stats } = spansToWalk(JSON.stringify(otlp), MODEL, FACTS, {});
  assert.equal(stats.runs, 1);
  const o = walk.outcomes[0];
  assert.equal(o.outcome, 'error');
  assert.match(o.reason, /carrier unreachable/);
  assert.deepEqual(o.steps.map((s) => s.sym), ['parcelworks/cli.py::cmd_submit', 'parcelworks/jobqueue.py::Queue.claim', 'parcelworks/handlers.py::route']);
  assert.equal(o.steps[1].ref, 'parcelworks/jobqueue.py:77');
  const flat = [{ name: 'tick', context: { trace_id: 'x', span_id: '1' }, parent_id: null, start_time: '2026-01-01T00:00:00Z', attributes: { 'faultline.tag': 'work.tick' }, status: { status_code: 'OK' } }];
  const f = spansToWalk(JSON.stringify(flat), MODEL, FACTS, {});
  assert.equal(f.walk.outcomes[0].outcome, 'unknown');
  assert.equal(f.walk.outcomes[0].steps[0].tag, 'work.tick');
});

// ---- statechart export ---------------------------------------------------------------------------------------------
const SC_DEADLOCK = {
  report: `# CounterDeadlock

TLC reached 4 states and 3 steps. The chart draws 4 states and 4 arrows.

## NotThree breaks
The shortest path has 1 step:
0. 0
1. Jump: 3

## NoDeadlock breaks
The shortest path has 3 steps:
0. 0
1. Inc: 1
2. Inc: 2
3. Inc: 3
`,
  chart: 'stateDiagram-v2\n  s0: 0\n  s1: 1\n  s2: 3\n  s3: 2\n  [*] --> s0\n  s0 --> s1: Inc\n  s0 --> s2: Jump\n  s1 --> s3: Inc\n  s3 --> s2: Inc\n',
};
const SC_NOT_CHECKED = [
  '# CounterGuard', '',
  'TLC reached 2 states and 1 steps. The chart draws 2 states and 1 arrows.',
  'TLC stopped the drawing run with exit 75, so the chart draws only the states that it reached before it stopped.', '',
  '## TypeOK breaks', 'TLC found a counterexample. It is in tlc-TypeOK.out.', '',
  '## Rules not checked', 'Lookup, NoDeadlock', 'TLC stopped with exit 75 before it checked these rules:',
  '```', 'Error: Evaluating invariant Lookup failed.', 'State 1: <Initial predicate>', 'x = 0', '```', '',
].join('\n');
const SC_HOLD = [
  '# ParcelHold', '',
  'TLC reached 4 states and 5 steps. The chart draws 4 states and 5 arrows.', '',
  '## EventuallyReleased breaks',
  "TLC's counterexample is in tlc-EventuallyReleased.out. It has 4 steps:",
  '0. Nothing submitted', '1. YouSubmitAZZParcel: Waiting in line', '2. TheWorkerHoldsIt: On hold (address)',
  '3. YouAskForARelease: Release refused', '4. YouAskAgain: On hold (address)',
  'The run loops through "On hold (address)" and "Release refused" forever.', '',
  '## Rules that hold', 'TypeOK, NoDeadlock', '',
].join('\n');
const SC_HOLD_CHART = 'stateDiagram-v2\n  s0: Nothing submitted\n  s1: Waiting in line\n  s2: On hold (address)\n  s3: Release refused\n  [*] --> s0\n';
const scDir = (name, files) => { const d = fresh(name); for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t); return d; };

test('statechart: report.md and chart.mmd parse the way the skill writes them', () => {
  const chart = parseChart(SC_DEADLOCK.chart);
  assert.deepEqual([...chart.entries()], [['s0', '0'], ['s1', '1'], ['s2', '3'], ['s3', '2']]);
  const rep = parseReport(SC_DEADLOCK.report, [...chart.values()]);
  assert.equal(rep.name, 'CounterDeadlock');
  assert.deepEqual(rep.sections.map((s) => [s.rule, s.steps.length]), [['NotThree', 2], ['NoDeadlock', 4]]);
  assert.deepEqual(rep.sections[1].steps.map((s) => [s.action, s.state]), [['', '0'], ['Inc', '1'], ['Inc', '2'], ['Inc', '3']]);
  // a state label with a colon is split by the chart's known labels, not at the first colon
  const colon = parseReport('# X\n\n## R breaks\nThe shortest path has 1 step:\n0. Mode: slow\n1. you speed up: Mode: fast\n', ['Mode: slow', 'Mode: fast']);
  assert.deepEqual(colon.sections[0].steps.map((s) => [s.action, s.state]), [['', 'Mode: slow'], ['you speed up', 'Mode: fast']]);
  const nc = parseReport(SC_NOT_CHECKED, []);
  assert.deepEqual(nc.notChecked, ['Lookup', 'NoDeadlock']);
  assert.equal(nc.stopped, true);
});

test('statechart: a stuck path in the model becomes a proved-in-model walk and a proved box', () => {
  const dir = scDir('sc-hold', { 'report.md': SC_HOLD, 'chart.mmd': SC_HOLD_CHART });
  const map = { states: { 'Waiting in line': 'queue.pending', s2: 'trouble.hold_address', 'Release refused': 'trouble.release_refused' } };
  const proj = project('p-sc');
  const out = path.join(proj, 'walks', 'hold.walk.jsonl');
  const r = exportStatechart(dir, map, out);
  assert.equal(r.rulesBroken, 1);
  assert.deepEqual(r.unmappedChartStates, ['Nothing submitted']);
  const w = readWalkFile(out);
  assert.equal(w.outcomes[0].outcome, 'stuck:trouble.hold_address');
  assert.equal(w.outcomes[0].strength, 'proved-in-model');
  assert.ok(fs.existsSync(path.join(path.dirname(out), w.outcomes[0].witness)));
  assert.equal(w.header.kind, 'modelcheck');
  assert.equal(w.label.label, 'EXHAUSTIVE_WITHIN_MODEL');
  assert.equal(w.label.controls_passed, false, 'the exporter never vouches for the checker');
  const ov = importWalks(proj, MODEL, FACTS);
  assert.equal(ov.boxes['trouble.hold_address'].level, 'proved');
  assert.equal(ov.boxes['queue.pending'], undefined, 'a path in a model does not make code "seen"');
  assert.ok(ov.notMapped.some((n) => n.key === 'state:Nothing submitted'), 'an unmapped chart state is NOT MAPPED');
  assert.equal(ov.missingRoutes.length, 0, 'a model step may cross several boxes: only an unreachable pair is a gap');
  assert.doesNotMatch(ov.labels[0].says, /no violation found/);
  // the author can vouch for the controls, and the label then says so
  const out2 = path.join(proj, 'walks', 'hold2.walk.jsonl');
  exportStatechart(dir, { ...map, controlsPassed: true }, out2);
  assert.equal(readWalkFile(out2).label.controls_passed, true);
});

test('statechart: deadlock and invariant rules, and rules TLC did not check', () => {
  const d1 = scDir('sc-dead', { 'report.md': SC_DEADLOCK.report, 'chart.mmd': SC_DEADLOCK.chart });
  const { walk } = statechartToWalk(d1, { states: { 0: 'queue.pending', 1: 'queue.claim', 2: 'work.route', 3: 'queue.done' } });
  assert.deepEqual(walk.outcomes.map((o) => o.outcome), ['error', 'stuck:queue.done']);
  assert.match(walk.outcomes[0].reason, /NotThree breaks at "3"/);
  const d2 = scDir('sc-nc', { 'report.md': SC_NOT_CHECKED });
  const nc = statechartToWalk(d2, { states: {} });
  assert.equal(nc.walk.label.label, 'BOUNDED_INCOMPLETE');
  assert.deepEqual(nc.walk.label.unexplored.map((u) => u.at), ['Lookup', 'NoDeadlock']);
  assert.throws(() => statechartToWalk(fresh('sc-empty'), {}), /no report.md/);
});

// ---- explorer runner -----------------------------------------------------------------------------------------------
function findPython() {
  const tries = [process.env.FAULTLINE_PYTHON, 'python', 'python3', 'py'].filter(Boolean);
  for (const c of tries) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info >= (3, 9))'], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0 && /True/.test(r.stdout)) return c;
  }
  return null;
}
const PY = findPython();
const toyAdapter = (...extra) => ({ cmd: PY, args: ['-I', '-B', ADAPTER, ...extra] });
const run = (name, adapter, o = {}) => {
  const dir = fresh(name);
  return runExplorer({ adapter, runDir: path.join(dir, 'run'), out: path.join(dir, 'proj', 'walks', 'explorer.walk.jsonl'), model: MODEL, facts: FACTS, ...o });
};
const importOf = (r) => importWalks(path.dirname(path.dirname(r.walkPath)), MODEL, FACTS);

const MOCK = `
const fs = require('fs'), path = require('path'), readline = require('readline');
const spec = JSON.parse(process.argv[2] || '{}');
const N = spec.N ?? 6, target = spec.target ?? 4;
const runDir = process.env.FAULTLINE_RUN_DIR || process.cwd();
let second = false;
if (spec.flaky) { const m = path.join(runDir, 'marker'); second = fs.existsSync(m); if (!second) fs.writeFileSync(m, '1'); }
const ops = {
  manifest: () => ({ protocol: 'faultline.explorer/1', adapter: 'mock', version: '1', code: spec.code || 'c1', input: spec.input || 'i1', guard: spec.noGuard ? {} : { selftest: true } }),
  selftest: () => ({ network: true, subprocess: true, writes: !spec.leakyWrites }),
  initial: () => ({ states: [0] }),
  actions: (r) => ({ actions: [...(r.state < N ? ['inc'] : []), ...(r.state + 2 <= N ? ['jump'] : [])].map((id) => ({ id })) }),
  apply: (r) => ({ state: r.state + (r.action === 'jump' ? 2 : 1) + (second ? 1 : 0) }),
  classify: (r) => {
    const n = r.state;
    if (spec.allStuck) return { class: 'stuck', reason: 'bad' };
    if (spec.noneStuck) return { class: 'ok', reason: '' };
    if (n === target) return { class: 'stuck', reason: 'dead' };
    if (n === N) return { class: 'end', reason: 'done' };
    return { class: 'ok', reason: '' };
  },
  identity: (r) => ({ bytes: 'n=' + r.state }),
  where: (r) => (spec.sameWhere ? 'x' : 'box-' + r.state),
  controls: () => ({ controls: [{ name: 'dead', state: target, expect: 'stuck' }, { name: 'fine', state: 0, expect: 'ok' }, { name: 'done', state: N, expect: 'end' }] }),
};
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const r = JSON.parse(l);
  let out;
  try { out = { id: r.id, ok: true, result: ops[r.op](r) }; } catch (e) { out = { id: r.id, ok: false, error: String(e) }; }
  process.stdout.write(JSON.stringify(out) + '\\n');
});`;
const mock = (spec = {}) => {
  const f = path.join(TMP, 'mock-adapter.cjs');
  if (!fs.existsSync(f)) fs.writeFileSync(f, MOCK);
  return { cmd: process.execPath, args: [f, JSON.stringify(spec)] };
};

test('explorer: a checker that calls everything stuck, or nothing stuck, is refused by its controls', { skip: !PY && 'no python 3.9+' }, async () => {
  for (const broken of ['all-stuck', 'none-stuck']) {
    const r = await run(`ex-broken-${broken}`, toyAdapter('--broken', broken));
    assert.equal(r.ok, false);
    assert.equal(r.refused.code, 'controls_failed');
    assert.match(r.refused.msg, broken === 'all-stuck' ? /calls everything stuck/ : /calls nothing stuck/);
    assert.match(r.refused.msg, /^REFUSE controls_failed/);
    assert.equal(r.walkPath, null);
    assert.ok(fs.existsSync(path.join(TMP, `ex-broken-${broken}`, 'run', 'refusal.json')), 'the refusal is recorded in the run folder');
    assert.ok(!fs.existsSync(path.join(TMP, `ex-broken-${broken}`, 'proj')), 'nothing is written as evidence');
  }
  const mockAll = await run('ex-mock-all', mock({ allStuck: true }));
  assert.equal(mockAll.refused.code, 'controls_failed');
  const mockNone = await run('ex-mock-none', mock({ noneStuck: true }));
  assert.equal(mockNone.refused.code, 'controls_failed');
});

test('explorer: no guard, or a guard that is open, is refused; unguarded runs are capped', async () => {
  const noGuard = await run('ex-noguard', mock({ noGuard: true }));
  assert.equal(noGuard.refused.code, 'guard_missing');
  const leaky = await run('ex-leaky', mock({ leakyWrites: true }));
  assert.equal(leaky.refused.code, 'guard_open');
  const capped = await run('ex-capped', mock({ noGuard: true }), { allowUnguarded: true });
  assert.equal(capped.ok, true);
  assert.equal(capped.label, 'BOUNDED_INCOMPLETE', 'an unverified guard can never reach EXHAUSTIVE');
  assert.equal(capped.controls_passed, false);
});

test('explorer: the toy adapter blocks network, children and outside writes for real', { skip: !PY && 'no python 3.9+' }, async () => {
  const { AdapterClient } = await import('../src/evidence/explorer/adapter.mjs');
  const dir = fresh('ex-guard');
  const c = new AdapterClient({ ...toyAdapter(), runDir: dir }).start();
  try {
    assert.deepEqual(await c.call('selftest'), { network: true, subprocess: true, writes: true });
  } finally { await c.close(); }
  assert.ok(!fs.existsSync(path.join(TOY, '_faultline_probe.txt')));
});

test('explorer: the planted address hold is reached, replayed in a fresh process, and marks the box proved', { skip: !PY && 'no python 3.9+' }, async () => {
  const r = await run('ex-zz', toyAdapter('--parcels', 'zz'));
  assert.equal(r.ok, true, r.refused?.msg);
  assert.equal(r.label, 'EXHAUSTIVE_WITHIN_MODEL');
  assert.equal(r.controls_passed, true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].at, 'trouble.hold_address');
  assert.deepEqual(r.findings[0].actions, ['submit:zz', 'tick']);
  assert.equal(r.findings[0].replayed, true);
  const w = readWalkFile(r.walkPath);
  assert.equal(w.outcomes[0].outcome, 'stuck:trouble.hold_address');
  assert.equal(w.outcomes[0].strength, 'replayable');
  assert.ok(fs.existsSync(path.join(path.dirname(r.walkPath), w.outcomes[0].witness)));
  assert.equal(w.header.pin, FACTS.pin.tree, 'the explorer pins the same code hash the facts do');
  const ov = importOf(r);
  assert.equal(ov.boxes['trouble.hold_address'].level, 'proved');
  assert.equal(ov.missingRoutes.length, 0);
  assert.equal(ov.walks[0].pin, 'match');
  assert.match(ov.labels[0].says, /^1 stuck or failing ending\(s\) found; every state of the model was searched/);
  // the witness replays again on its own, and a doctored witness does not
  const wfile = path.join(path.dirname(r.walkPath), w.outcomes[0].witness);
  const again = await replayWitnessFile(wfile, toyAdapter('--parcels', 'zz'), path.join(TMP, 'ex-zz', 'replay'));
  assert.equal(again.ok, true);
  const doctored = JSON.parse(fs.readFileSync(wfile, 'utf8'));
  doctored.actions = ['submit:zz'];
  fs.writeFileSync(path.join(TMP, 'doctored.json'), JSON.stringify(doctored));
  const bad = await replayWitnessFile(path.join(TMP, 'doctored.json'), toyAdapter('--parcels', 'zz'), path.join(TMP, 'ex-zz', 'replay2'));
  assert.equal(bad.ok, false);
  assert.match(bad.why, /replay ends ok, expected stuck|different state/);
});

test('explorer: exhaustive with passed controls and nothing found is the only run that says "no violation found"', { skip: !PY && 'no python 3.9+' }, async () => {
  const r = await run('ex-clean', toyAdapter('--parcels', 'ok,customs'));
  assert.equal(r.label, 'EXHAUSTIVE_WITHIN_MODEL');
  assert.equal(r.controls_passed, true);
  assert.equal(r.findings.filter((f) => f.kind === 'stuck').length, 0);
  assert.ok(r.findings.some((f) => f.kind === 'end'), 'delivered parcels are ends');
  const ov = importOf(r);
  assert.match(ov.labels[0].says, /^no violation found/);
  assert.equal(ov.boxes['queue.done'].level, 'proved', 'a replayed end is proof the ending can happen');
  assert.ok(r.notReached.includes('trouble.hold_address'), 'boxes this model never reached are listed, not hidden');
});

test('explorer: budgets stop the search honestly and leave the label bounded', { skip: !PY && 'no python 3.9+' }, async () => {
  const r = await run('ex-budget', toyAdapter(), { budgets: { states: 40 } });
  assert.equal(r.ok, true);
  assert.equal(r.stats.stopped, 'states');
  assert.equal(r.label, 'BOUNDED_INCOMPLETE');
  assert.ok(r.stats.open > 0);
  const w = readWalkFile(r.walkPath);
  assert.ok(w.label.unexplored.length > 0 && /budget cut: states/.test(w.label.unexplored[0].why));
  const ov = importOf(r);
  assert.doesNotMatch(ov.labels[0].says, /no violation found/);
  const e = await run('ex-evals', toyAdapter(), { budgets: { evals: 30 } });
  assert.equal(e.stats.stopped, 'evals');
  assert.ok(e.stats.evals <= 30);
  const none = await run('ex-zero', toyAdapter(), { budgets: { evals: 0 } });
  assert.equal(none.label, 'SAMPLED', 'only the start state was looked at');
});

test('explorer: resume continues a run, refuses a changed manifest, and refuses to overwrite a run', { skip: !PY && 'no python 3.9+' }, async () => {
  const dir = fresh('ex-resume');
  const base = { runDir: path.join(dir, 'run'), out: path.join(dir, 'proj', 'walks', 'explorer.walk.jsonl'), model: MODEL, facts: FACTS };
  const adapter = toyAdapter('--parcels', 'zz,customs');
  const part = await runExplorer({ ...base, adapter, budgets: { states: 10 } });
  assert.equal(part.label, 'BOUNDED_INCOMPLETE');
  assert.equal((await runExplorer({ ...base, adapter })).refused.code, 'run_exists');
  const changed = await runExplorer({ ...base, adapter: toyAdapter('--parcels', 'zz'), resume: true });
  assert.equal(changed.refused.code, 'manifest_changed');
  const done = await runExplorer({ ...base, adapter, resume: true });
  assert.equal(done.label, 'EXHAUSTIVE_WITHIN_MODEL');
  const whole = await run('ex-resume-whole', adapter);
  assert.equal(done.stats.states, whole.stats.states, 'resuming reaches exactly the states a single run does');
  assert.deepEqual(done.findings.map((f) => [f.kind, f.at, f.actions]), whole.findings.map((f) => [f.kind, f.at, f.actions]));
  assert.equal((await runExplorer({ ...base, adapter, fresh: true })).stats.states, whole.stats.states);
});

test('explorer: the journal store gives the same answer as sqlite, and resumes', { skip: !PY && 'no python 3.9+' }, async () => {
  const adapter = toyAdapter('--parcels', 'zz,customs');
  const a = await run('ex-sqlite', adapter, { store: 'sqlite' });
  const dir = fresh('ex-journal');
  const base = { runDir: path.join(dir, 'run'), out: path.join(dir, 'proj', 'walks', 'e.walk.jsonl'), adapter, store: 'journal' };
  const half = await runExplorer({ ...base, budgets: { states: 12 } });
  assert.equal(half.store, 'journal');
  const j = await runExplorer({ ...base, resume: true });
  assert.equal(j.stats.states, a.stats.states);
  assert.equal(j.label, a.label);
  assert.deepEqual(j.findings.map((f) => f.actions), a.findings.map((f) => f.actions));
});

test('explorer: a bound set by the adapter makes cut states, and cut states keep the label bounded', { skip: !PY && 'no python 3.9+' }, async () => {
  const r = await run('ex-cut', toyAdapter('--parcels', 'outage', '--horizon', '3'));
  assert.ok(r.stats.byClass.cut > 0);
  assert.equal(r.label, 'BOUNDED_INCOMPLETE');
  assert.ok(readWalkFile(r.walkPath).label.unexplored.some((u) => /adapter's own bound/.test(u.why)));
});

test('explorer: identity is exact; same place or same hash never merges two states', async () => {
  const same = await run('ex-sameplace', mock({ sameWhere: true, target: 99 }));
  assert.equal(same.stats.states, 7, 'seven states with one place name are still seven states');
  const collide = await run('ex-collide', mock({ target: 99 }), { hashFn: () => 'one-hash-for-everything' });
  assert.equal(collide.stats.states, 7);
  assert.ok(collide.stats.collisions >= 6, 'same hash, different bytes: counted and kept apart');
  const plain = await run('ex-plain', mock({ target: 99 }));
  assert.equal(plain.stats.collisions, 0);
  assert.equal(plain.label, 'EXHAUSTIVE_WITHIN_MODEL');
  assert.equal(plain.findings.filter((f) => f.kind === 'stuck').length, 0);
});

test('explorer: a finding counts only when its action list replays', async () => {
  const r = await run('ex-flaky', mock({ flaky: true }));
  assert.equal(r.ok, true);
  assert.ok(r.unreplayed.length >= 1, 'the search found something its replay could not repeat');
  assert.ok(r.unreplayed.every((u) => u.replayed === false && u.why));
  const w = readWalkFile(r.walkPath);
  assert.equal(w.outcomes.filter((o) => /^stuck:/.test(o.outcome)).length, 0, 'an unreplayed finding is not written as a finding');
  assert.equal(r.label, 'BOUNDED_INCOMPLETE');
  assert.equal(r.controls_passed, false);
});

// ---- edges ---------------------------------------------------------------------------------------------------------
test('importWalks: missing pieces do not crash; no walks is an empty overlay', () => {
  const none = importWalks(path.join(TMP, 'does-not-exist'), MODEL, FACTS);
  assert.deepEqual(none.boxes, {});
  assert.equal(none.summary.walksRead, 0);
  const noFacts = importWalks(project('p-nofacts', { 'a.walk.jsonl': walkText({}, {}, [outcome({ outcome: 'end:report.saved', steps: [{ tag: 'queue.claim' }] })]) }), MODEL, undefined);
  assert.equal(noFacts.boxes['queue.claim'].level, 'seen', 'tags need no facts');
  const noModel = importWalks(project('p-nomodel', { 'a.walk.jsonl': FIXTURE_WALK }), undefined, FACTS);
  assert.equal(noModel.summary.boxes, 0);
  assert.ok(noModel.notMapped.length > 0);
  const garbage = importWalks(project('p-garbage', { 'a.walk.jsonl': 'nope\n{"walk":1}\n', 'b.walk.jsonl': '' }), MODEL, FACTS);
  assert.equal(garbage.rejected.length, 2);
  assert.equal(garbage.summary.walksRead, 0);
});

test('importWalks: a long trace imports quickly and a gap does not hide the rest', () => {
  const tags = ['intake.submit', 'intake.required', 'intake.weight', 'intake.format', 'intake.dedupe', 'intake.lane', 'intake.enqueue'];
  const steps = [];
  for (let i = 0; i < 6000; i++) for (const t of tags) steps.push({ tag: t });
  steps.splice(100, 0, { tag: 'report.saved' });
  const dir = project('p-long', { 'a.walk.jsonl': walkText({}, {}, [outcome({ steps })]) });
  const t0 = Date.now();
  const ov = importWalks(dir, MODEL, FACTS);
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  assert.equal(ov.walks[0].steps, 42001);
  assert.ok(ov.missingRoutes.length >= 1 && ov.missingRoutes.some((m) => m.first));
  assert.ok(ov.walks[0].explainedPrefix < 100);
  assert.equal(ov.boxes['intake.enqueue'].level, 'seen');
});

test('importWalks: output is deterministic', () => {
  const dir = project('p-det', { 'trace.walk.jsonl': FIXTURE_WALK });
  fs.writeFileSync(path.join(dir, 'walks', 'cov.walk.jsonl'), formatWalk(coverageToWalk(COVERAGE_JSON, FACTS, { model: MODEL }).walk));
  const a = JSON.stringify(importWalks(dir, MODEL, FACTS));
  const b = JSON.stringify(importWalks(dir, MODEL, FACTS));
  assert.equal(a, b);
});

test('explorer: the walk records function hashes, so a changed function makes only its boxes stale', { skip: !PY && 'no python 3.9+' }, async () => {
  const r = await run('ex-stale', toyAdapter('--parcels', 'zz'));
  const w = readWalkFile(r.walkPath);
  const route = 'parcelworks/handlers.py::route';
  assert.equal(w.header.hashes[route], FACTS.functions[route].sha256);
  const facts2 = JSON.parse(JSON.stringify(FACTS));
  facts2.functions[route].sha256 = '0'.repeat(64);
  const ov = importWalks(path.dirname(path.dirname(r.walkPath)), MODEL, facts2);
  assert.equal(ov.boxes['trouble.hold_address'].level, 'drawn');
  assert.equal(ov.boxes['trouble.hold_address'].stale, true);
  assert.equal(ov.boxes['trouble.hold_address'].staleLevel, 'proved');
  assert.equal(ov.boxes['queue.pending'].level, 'seen', 'queue.pending cites other functions: untouched');
  assert.ok(ov.stale.some((s) => s.fn === route && s.boxes.includes('work.route')));
});
