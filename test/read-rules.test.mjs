import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSystem } from '../src/read/index.mjs';
import { Source, maskCode } from '../src/read/source.mjs';
import { classifySite, httpStatusIn, summarizeExpr } from '../src/read/outcomes.mjs';
import { readmeProse, findPurpose } from '../src/read/purpose.mjs';
import { handlerWords, parseStepPhrase } from '../src/read/words.mjs';
import { switchNamesIn } from '../src/read/switches.mjs';
import { routeOfTest } from '../src/read/routes.mjs';
import { stableStringify } from '../src/read/util.mjs';
import { makeShop, SHOP_ROOT, FN } from './lib/read-helpers.mjs';

const run = (opts) => {
  const s = makeShop(opts);
  return readSystem({ model: s.model, claims: s.claims, facts: s.facts, sourceRoot: s.root, name: 'shop' });
};

test('mask hides strings, comments and regular expressions but keeps brackets', () => {
  const m = maskCode("const a = foo('x(', /['\"]\\)/); // end )\nbar();", 'ts');
  assert.equal(m.length, "const a = foo('x(', /['\"]\\)/); // end )\nbar();".length);
  assert.equal((m.match(/\(/g) ?? []).length, 2);
  assert.equal((m.match(/\)/g) ?? []).length, 2);
});

test('conditions, exits, calls and arguments are read from the source text', () => {
  const s = new Source(SHOP_ROOT);
  assert.deepEqual(s.condition('src/orders.ts', 6), { kind: 'if', text: '!id', endLine: 6 });
  assert.equal(s.exitExpr('src/orders.ts', 33).text, '{ ok: true }');
  const calls = s.calls('src/orders.ts', 11, 11);
  assert.deepEqual(calls.map((c) => c.full), ['this.withRetry', 'this.charge']);
  const args = s.args('src/orders.ts', calls[0].open);
  assert.equal(args.length, 1);
  assert.match(args[0].text, /^\(\) => this\.charge\(id\)$/);
  assert.equal(s.signature('src/orders.ts', 25).text, '  withRetry(fn: () => unknown)');
});

test('a 403 is a refusal, a 500 a failure, a raise a failure, an open end is not an ending', () => {
  assert.equal(classifySite({ kind: 'return', expr: 'self._json(HTTPStatus.FORBIDDEN, {})', cls: 'RB:call:_json' }).outcome, 'refusal');
  assert.equal(classifySite({ kind: 'return', expr: 'res.status(500).send("x")', cls: 'RB' }).outcome, 'failure');
  assert.equal(classifySite({ kind: 'return', expr: 'self._json(HTTPStatus.OK, data)', cls: 'RB' }).outcome, 'success');
  assert.equal(classifySite({ kind: 'raise', expr: 'RequestRefused("no")', cls: 'raise:RequestRefused' }).outcome, 'refusal');
  assert.equal(classifySite({ kind: 'raise', expr: 'ValueError("bad")', cls: 'raise:ValueError' }).outcome, 'failure');
  assert.equal(classifySite({ kind: 'return', expr: 'false', cls: 'R:const:False' }).outcome, 'neutral');
  assert.equal(httpStatusIn('send_error(404)').code, 404);
  const r = run();
  const handlerEnd = r.reading.endings.byOutcome;
  assert.ok(handlerEnd.failure >= 2);
  // the open-call marker is never counted as an ending
  const ch = r.charts.charts.flatMap((c) => c.parts.flatMap((p) => p.boxes));
  assert.ok(ch.filter((b) => b.shape === 'open').every((b) => b.ending === false && b.kind === 'open'));
  assert.equal(r.reading.numbers.endings.boxes, r.reading.numbers.endings.byOutcome.success + r.reading.numbers.endings.byOutcome.failure + (r.reading.numbers.endings.byOutcome.neutral ?? 0) + (r.reading.numbers.endings.byOutcome.refusal ?? 0) + (r.reading.numbers.endings.byOutcome.mixed ?? 0));
});

test('plain words, full expressions, no tool residue, titles fit', () => {
  const hw = handlerWords({ title: 'on *: print~', detail: 'on *: print~' });
  assert.equal(hw.title, 'On any error: probably print it');
  assert.equal(hw.raw, 'on *: print~');
  assert.deepEqual(parseStepPhrase('runs A.b ; does store ; calls X, Y...'), { runs: 'A.b', does: ['store'], calls: ['X', 'Y'], other: [] });
  assert.equal(summarizeExpr('this.trace<void | Job<A, B>>(SpanKind.CONSUMER, "process", this.name, async span => {})', 31), 'this.trace(…)');
  const r = run();
  const w = Object.values(r.words);
  assert.ok(w.every((x) => x.title.length <= 40), 'every title fits a box');
  const text = JSON.stringify(r.words) + JSON.stringify(r.charts);
  assert.ok(!/does store|on \*:|Tool rule|anon@\d+/.test(w.map((x) => `${x.title} ${x.plain}`).join('\n')), 'no tool residue in what a reader sees');
  assert.ok(!/\b[0-9a-f]{6,}\b/.test(w.map((x) => `${x.title} ${x.plain}`).join('\n')), 'no hashes in sentences');
  const store = r.words['ch.st2'];
  assert.equal(store.title, 'Writes to db (save)');
  assert.equal(r.words['po.h4'].title, 'On any error: print it');
  assert.ok(text.length > 100);
});

test('a journey crosses calls, follows a passed function, avoids the error arm, and rejects one-function runs', () => {
  const r = run({ only: [FN.place, FN.validate, FN.retry, FN.charge, FN.notify, FN.lonely] });
  const js = r.reading.journeys.list;
  const j = js.find((x) => x.trigger.fn === FN.place);
  assert.ok(j, 'a journey from the exported method');
  const fns = new Set(j.steps.filter((s) => s.kind === 'enter').map((s) => s.fid));
  assert.ok(fns.has(FN.validate) && fns.has(FN.retry) && fns.has(FN.charge), 'crosses into the callees');
  assert.ok(j.steps.some((s) => s.kind === 'enter' && s.via.kind === 'function value'), 'follows the function passed to withRetry');
  assert.ok(!fns.has(FN.notify), 'never takes the handler arm');
  assert.ok(!j.steps.some((s) => /On any error|Fails with/.test(s.title ?? '')), 'no error arm in the run');
  const w = j.steps.find((s) => s.kind === 'work');
  assert.ok(w && /Writes to/.test(w.title), 'the run reaches the write');
  assert.ok(!js.some((x) => x.trigger.fn === FN.lonely), 'a one-function run is not a journey');
  assert.ok(r.reading.journeys.rejected.oneFunction >= 1);
  // the call the map did not draw is reported with its line
  assert.ok(r.reading.journeys.engineGaps.some((g) => g.line === 11 || g.line === 14 || g.line === 9 || g.line > 0));
});

test('a route arm starts a journey at the arm and takes the arm', () => {
  const r = run();
  const j = r.reading.journeys.list.find((x) => x.trigger.kind === 'route');
  assert.ok(j);
  assert.equal(j.trigger.label, '/api/orders');
  assert.equal(j.steps.find((s) => s.kind === 'decision').took, 'yes');
  assert.ok(j.steps.some((s) => s.kind === 'enter' && s.fid === FN.place));
});

test('when nothing qualifies the reading says "no main path found"', () => {
  const r = run({ only: [FN.lonely] });
  assert.equal(r.reading.journeys.none, true);
  assert.equal(r.reading.journeys.noneNote, 'no main path found');
  assert.match(r.text, /no main path found/);
});

test('purpose comes from the README prose, then package metadata, and says so when absent', () => {
  const s = new Source(SHOP_ROOT);
  const p = findPurpose(s, null);
  assert.match(p.text, /order desk/);
  assert.match(p.source, /README/);
  assert.equal(readmeProse('# T\n\n[![b](x)](y)\n\nShort.\n\nA real paragraph that says what this system does for its people today.'), 'A real paragraph that says what this system does for its people today.');
  const none = findPurpose(new Source(null), null);
  assert.equal(none.text, null);
  assert.match(none.note, /No purpose statement/);
});

test('who hears carries confidence and never invents "nobody"', () => {
  const r = run();
  const f = r.reading.endings.failing;
  const a = f.find((x) => x.box === 'po.e0');
  const b = f.find((x) => x.box === 'va.e0');
  assert.equal(a.whoHears.value, 'caller');
  assert.equal(a.whoHears.confidence, 'confident');
  assert.equal(b.whoHears.value, 'unknown');
  assert.match(b.whoHears.detail, /not known from the code/);
  assert.equal(r.reading.whoHears.counts.nobody, 0);
  assert.ok(!/none reach/i.test(r.reading.whoHears.sentence));
});

test('switches list the options tested, with the literal default or "default not read"', () => {
  assert.deepEqual(switchNamesIn('!this.opts.skipLockRenewal && process.env.MODE === "x"').map((x) => x.name).sort(), ['MODE', 'opts.skipLockRenewal']);
  const r = run();
  const sw = r.reading.switches.items.find((x) => x.name === 'opts.autoCharge');
  assert.ok(sw);
  assert.equal(sw.uses[0].line, 30);
  assert.equal(sw.default.literal, 'false');
  assert.ok(r.reading.switches.cannotSee.length >= 2);
});

test('questions and gaps are kept apart; terms are not defined by a first box; statements quote the numbers', () => {
  const r = run();
  assert.ok(Array.isArray(r.reading.triage.questions));
  assert.equal(typeof r.reading.triage.gaps.total, 'number');
  for (const t of r.reading.glossary.terms) assert.ok(t.meaning === null || t.meaning.length >= 20);
  const n = r.reading.numbers;
  assert.ok(r.reading.statements.read[0].includes(`${n.read.functions} function`));
  assert.ok(r.reading.statements.read[0].includes(`${n.read.boxes} box`));
  assert.ok(!JSON.stringify(r.reading).includes('accounted for'));
});

test('routes are found from path tests', () => {
  assert.equal(routeOfTest('path == "/api/orders"', 'Handler.do_POST').label, 'POST /api/orders');
  assert.equal(routeOfTest("req.url === '/a/b'", 'handler').label, '/a/b');
  assert.equal(routeOfTest('x > 3', 'f'), null);
});

test('same input, same bytes', () => {
  const a = run();
  const b = run();
  assert.equal(stableStringify(a.reading), stableStringify(b.reading));
  assert.equal(stableStringify(a.charts), stableStringify(b.charts));
  assert.equal(stableStringify(a.words), stableStringify(b.words));
  assert.equal(a.text, b.text);
});

test('an anonymous function is named by the whole name of the function it is passed to', async () => {
  const { describeAnon } = await import('../src/read/names.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pth = await import('node:path');
  const dir = fs.mkdtempSync(pth.join(os.tmpdir(), 'anon-'));
  fs.mkdirSync(pth.join(dir, 'src'));
  fs.writeFileSync(pth.join(dir, 'src', 'a.ts'), [
    'class A {',
    '  run() {',
    '    return this.trace<void>(',
    "      'run',",
    '      async span => {',
    '        span.end();',
    '      },',
    '    );',
    '  }',
    '  start() {',
    '    const onDone = () => {',
    '      this.x = 1;',
    '    };',
    "    emitter.on('ready', () => { this.y = 2; });",
    '  }',
    '}',
    '',
  ].join('\n'));
  const s = new Source(dir);
  assert.equal(describeAnon(s, 'src/a.ts', 5).text, 'callback passed to trace');
  assert.equal(describeAnon(s, 'src/a.ts', 14).text, 'callback passed to on');
});
