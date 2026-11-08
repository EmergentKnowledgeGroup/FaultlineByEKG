// Tests for the deterministic code reader: planted items in the toy system, resolution, robustness, determinism.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from '../src/extract/index.mjs';
import { tarjan, louvain } from '../src/extract/graph.mjs';
import { globToRe } from '../src/extract/walk.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const toyDir = path.join(here, '..', 'examples', 'toy');
let toy, tmp;
const w = (rel, text) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-test-'));
  toy = await extract(toyDir, { exclude: ['explorer_adapter.py'] });
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const fnOf = (res, suffix) => Object.entries(res.facts.functions).find(([k]) => k.endsWith(suffix));
const endingsOf = (res, fnSuffix) => res.census.endings.filter((e) => e.fn.endsWith(fnSuffix));

test('contract shape: schemas, ids, counts', () => {
  assert.equal(toy.facts.schema, 'faultline.facts/1');
  assert.equal(toy.census.schema, 'faultline.census/1');
  assert.equal(toy.graph.schema, 'faultline.graph/1');
  assert.deepEqual(Object.keys(toy.census.counts).slice(0, 5), ['endings', 'branches', 'passes', 'switches', 'rawReturnsAndRaises']);
  for (const id of Object.keys(toy.facts.functions)) assert.match(id, /^[^:]+::.+$/);
  for (const e of toy.census.endings) assert.match(e.id, /^end:.+::.+:\d+$/);
  for (const b of toy.census.branches) assert.match(b.id, /^branch:.+::.+:\d+$/);
  assert.ok(toy.facts.pin.tree.length === 64);
  assert.deepEqual(toy.facts.languages, { py: 9, ts: 2 });
});

test('toy item 1: the address hold and the release that never clears it', () => {
  const route = endingsOf(toy, 'handlers.py::route').map((e) => e.value);
  assert.deepEqual(route.sort(), ['address', 'customs']);
  const rel = toy.census.branches.find((b) => b.fn.endsWith('cli.py::cmd_release') && b.test.includes('customs_cleared'));
  assert.equal(rel.weight, 'decision');
  const edge = toy.graph.callEdges.find(([a, b]) => a.endsWith('cmd_release') && b.endsWith('Queue.release_hold'));
  assert.ok(edge, 'cmd_release -> Queue.release_hold resolved through the parameter name');
  const [, hold] = fnOf(toy, 'jobqueue.py::Queue.hold');
  assert.ok(hold.line > 0 && hold.end >= hold.line);
});

test('toy item 2: an enum member that nothing uses', () => {
  const outcome = toy.census.outcomeTypes.find((t) => t.name === 'Outcome');
  assert.equal(outcome.source, 'enum');
  assert.deepEqual(outcome.unused, ['returned_to_sender']);
  const status = toy.census.outcomeTypes.find((t) => t.name === 'JobStatus');
  assert.equal(status.unused, undefined);
  const en = toy.facts.enums.find((e) => e.name === 'Outcome');
  assert.equal(en.uses.RETURNED, 0);
  assert.ok(en.uses.DELIVERED > 0);
});

test('toy item 3: the lease_lost ending is a census row', () => {
  const row = toy.census.endings.find((e) => e.value === 'lease_lost');
  assert.equal(row.line, 32);
  assert.ok(row.fn.endsWith('worker.py::Worker.process_one'));
  assert.notEqual(row.confidence, 'low');
});

test('toy item 4: the report retry has no limit; the other retries have one', () => {
  const passes = (suffix) => toy.census.passes.filter((p) => p.fn.endsWith(suffix));
  const wr = passes('report.py::write_report');
  assert.equal(wr.length, 1);
  assert.equal(wr[0].kind, 'retry');
  assert.equal(wr[0].bounded, false);
  assert.equal(wr[0].line, 38);
  for (const s of ['web/client.ts::StatusClient.call', 'web/client.ts::StatusClient.waitForTerminal', 'worker.py::Worker.run']) {
    const p = passes(s);
    assert.ok(p.length >= 1 && p.every((x) => x.bounded), s);
  }
});

test('toy switches: off-by-default is inferred from the comparison', () => {
  const sw = Object.fromEntries(toy.census.switches.map((s) => [s.id, s]));
  assert.equal(sw['switch:FAST_LANE'].offByDefault, true);
  assert.equal(sw['switch:FAST_LANE'].default, '0');
  assert.equal(sw['switch:MAX_ATTEMPTS'].default, '4');
  assert.equal(sw['switch:MAX_ATTEMPTS'].offByDefault, false);
  assert.equal(sw['switch:POLL_LIMIT'].path, 'web/client.ts');
  assert.equal(sw['switch:POLL_LIMIT'].line, 6);
  assert.equal(sw['switch:PARCELWORKS_DB'].default, 'parcelworks.db');
});

test('toy entries and tests', () => {
  const kinds = (fn) => toy.facts.entries.filter((e) => e.fn.endsWith(fn)).map((e) => e.kind);
  assert.deepEqual(kinds('cli.py::main'), ['main']);
  assert.deepEqual(kinds('worker.py::Worker.run'), ['worker']);
  for (const c of ['cmd_submit', 'cmd_work', 'cmd_release', 'cmd_report']) assert.deepEqual(kinds('cli.py::' + c), ['cli']);
  assert.ok(kinds('web/client.ts::StatusClient.submit').includes('export'));
  const t = toy.facts.entries.find((e) => e.kind === 'test' && e.fn.endsWith('test_address_hold_stays_held'));
  assert.ok(t.calls.some((c) => c.endsWith('cmd_release')));
  assert.ok(t.calls.every((c) => toy.facts.functions[c]), 'test calls are limited to known source functions');
});

test('toy functions: python and typescript qualnames, hashes, lines', () => {
  assert.ok(fnOf(toy, 'jobqueue.py::Queue.claim'));
  assert.ok(fnOf(toy, 'web/client.ts::StatusClient.waitForTerminal'));
  assert.ok(fnOf(toy, 'web/client.ts::describe'));
  const [, claim] = fnOf(toy, 'jobqueue.py::Queue.claim');
  assert.match(claim.sha256, /^[0-9a-f]{16}$/);
  assert.ok(claim.excepts.some((x) => x.type === 'Exception' && x.swallows === false));
  const [, call] = fnOf(toy, 'web/client.ts::StatusClient.call');
  assert.equal(call.loops[0].bounded, true);
  assert.ok(call.retryHints.length >= 1);
  const [, desc] = fnOf(toy, 'web/client.ts::describe');
  assert.ok(desc.branches.some((b) => b.kind === 'match' && b.cases === 5));
  assert.ok(toy.facts.enums.find((e) => e.name === 'JobState' && e.form === 'enum'));
});

test('determinism: two runs give identical bytes', async () => {
  const again = await extract(toyDir, { exclude: ['explorer_adapter.py'] });
  assert.equal(JSON.stringify(again.facts), JSON.stringify(toy.facts));
  assert.equal(JSON.stringify(again.census), JSON.stringify(toy.census));
  assert.equal(JSON.stringify(again.graph), JSON.stringify(toy.graph));
});

test('a syntax error is recorded and skipped, the rest still reads', async () => {
  w('bad/ok.py', 'def fine():\n    return "ready"\n');
  w('bad/broken.py', 'def oops(:\n    pass\n');
  w('bad/deep.py', 'x = ' + Array.from({ length: 6000 }, (_, i) => String(i)).join(' + ') + '\n\ndef after():\n    return 1\n');
  const r = await extract(path.join(tmp, 'bad'));
  assert.ok(r.facts.skipped.some((s) => s.path === 'broken.py' && /SyntaxError/.test(s.why)));
  assert.ok(r.facts.functions['ok.py::fine']);
  assert.ok(!r.facts.modules.some((m) => m.path === 'broken.py'));
  assert.ok(r.facts.functions['deep.py::after'] || r.facts.skipped.some((s) => s.path === 'deep.py'), 'deep file either reads or is recorded');
});

test('globs: include overrides defaults, exclude removes', async () => {
  w('g/src/a.py', 'def a():\n    return 1\n');
  w('g/tests/test_a.py', 'from src.a import a\n\ndef test_a():\n    a()\n');
  w('g/vendor/v.py', 'def v():\n    return 1\n');
  const def = await extract(path.join(tmp, 'g'));
  assert.deepEqual(Object.keys(def.facts.functions), ['src/a.py::a']);
  assert.deepEqual(def.facts.entries.map((e) => e.kind), ['test']);
  assert.deepEqual(def.facts.entries[0].calls, ['src/a.py::a']);
  const inc = await extract(path.join(tmp, 'g'), { include: ['vendor/**', 'src/**'] });
  assert.deepEqual(Object.keys(inc.facts.functions).sort(), ['src/a.py::a', 'vendor/v.py::v']);
  const exc = await extract(path.join(tmp, 'g'), { exclude: ['src/**'] });
  assert.deepEqual(Object.keys(exc.facts.functions), []);
  assert.ok(globToRe('**/*.py').test('a/b/c.py') && globToRe('src/*.py').test('src/x.py') && !globToRe('src/*.py').test('src/x/y.py'));
});

test('graph: Tarjan finds a cycle and Louvain is seeded', () => {
  const adj = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['a']], ['e', ['e']]]);
  const sccs = tarjan(['a', 'b', 'c', 'd', 'e'], adj);
  assert.equal(sccs.length, 1);
  assert.deepEqual(sccs[0].sort(), ['a', 'b', 'c']);
  const nodes = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'];
  const e = new Map([['a1\ta2', 3], ['a2\ta3', 3], ['a1\ta3', 3], ['b1\tb2', 3], ['b2\tb3', 3], ['b1\tb3', 3], ['a3\tb1', 0.2]]);
  const c1 = louvain(nodes, e, 7), c2 = louvain(nodes, e, 7);
  assert.deepEqual([...c1], [...c2]);
  assert.equal(c1.get('a1'), c1.get('a3'));
  assert.equal(c1.get('b1'), c1.get('b3'));
  assert.notEqual(c1.get('a1'), c1.get('b1'));
});

test('python resolution: imports, self, bases, annotated attributes, defaults, super', async () => {
  w('py/pkg/__init__.py', 'from .store import Store\n');
  w('py/pkg/store.py', 'class Base:\n    def ping(self):\n        return "pong"\n\nclass Store(Base):\n    def get(self, key):\n        return key\n\n    def put(self, key):\n        self.get(key)\n        return self.ping()\n');
  w('py/pkg/svc.py', [
    'import os',
    'from . import store as st',
    'from pkg import Store',
    'from .util import helper as h',
    '',
    'class Service:',
    '    def __init__(self, store: Store, cb=h):',
    '        self.store = store',
    '        self.cb = cb',
    '        self.other = st.Store()',
    '',
    '    def run(self, key):',
    '        self.store.put(key)',
    '        self.other.get(key)',
    '        self.cb(key)',
    '        helper_local = Store()',
    '        helper_local.put(key)',
    '        os.getcwd()',
    '        return self.finish()',
    '',
    '    def finish(self):',
    '        return "done"',
    '',
    'class Child(Service):',
    '    def run(self, key):',
    '        super().run(key)',
    '',
  ].join('\n'));
  w('py/pkg/util.py', 'def helper(x):\n    return x\n');
  const r = await extract(path.join(tmp, 'py'));
  const calls = (id) => r.facts.functions[id].calls;
  assert.ok(calls('pkg/svc.py::Service.run').includes('pkg/store.py::Store.put'), 'annotated constructor parameter');
  assert.ok(calls('pkg/svc.py::Service.run').includes('pkg/store.py::Store.get'), 'attribute built from a module alias');
  assert.ok(calls('pkg/svc.py::Service.run').includes('pkg/util.py::helper'), 'callback parameter default');
  assert.ok(calls('pkg/svc.py::Service.run').includes('pkg/svc.py::Service.finish'), 'self.method');
  assert.ok(calls('pkg/svc.py::Child.run').includes('pkg/svc.py::Service.run'), 'super().method');
  assert.ok(calls('pkg/store.py::Store.put').includes('pkg/store.py::Base.ping'), 'method from a base class');
  assert.ok(!calls('pkg/svc.py::Service.run').some((c) => c.includes('getcwd')), 'external calls are not edges');
  assert.deepEqual(r.facts.modules.find((m) => m.path === 'pkg/svc.py').externalImports, ['os']);
  assert.ok(r.facts.modules.find((m) => m.path === 'pkg/svc.py').imports.includes('pkg/util.py'));
});

test('python facts: loops, excepts, raises, enums, switches, entries, retry hints', async () => {
  w('py2/app.py', [
    'import os, time, enum, sys',
    'from typing import Literal',
    '',
    'class Phase(enum.Enum):',
    '    A = "alpha"',
    '    B = "beta"',
    '',
    'Mode = Literal["fast", "slow"]',
    'LIMIT_RETRIES = 3',
    '',
    'def work(x):',
    '    tries = 0',
    '    while True:',
    '        try:',
    '            return x()',
    '        except OSError:',
    '            tries += 1',
    '            time.sleep(2 ** tries)',
    '',
    'def bounded(x):',
    '    n = 0',
    '    while True:',
    '        n += 1',
    '        if n > 5:',
    '            break',
    '',
    'def fan(rows):',
    '    for r in rows:',
    '        if r:',
    '            return "found"',
    '    raise KeyError("none")',
    '',
    'def gate():',
    '    if os.environ.get("USE_THING") == "1":',
    '        return Phase.A',
    '    return Phase.B',
    '',
    'def swallow():',
    '    try:',
    '        gate()',
    '    except Exception:',
    '        pass',
    '',
    'if __name__ == "__main__":',
    '    sys.exit(work(gate))',
    '',
  ].join('\n'));
  const r = await extract(path.join(tmp, 'py2'));
  const f = r.facts.functions;
  assert.equal(f['app.py::work'].loops[0].bounded, false);
  assert.ok(f['app.py::work'].retryHints.length >= 2);
  assert.equal(f['app.py::bounded'].loops[0].bounded, true);
  assert.deepEqual(f['app.py::fan'].raises.map((x) => x.type), ['KeyError']);
  assert.equal(f['app.py::swallow'].excepts[0].swallows, true);
  assert.equal(f['app.py::swallow'].excepts[0].silent, true);
  assert.deepEqual(r.facts.enums.map((e) => [e.name, e.form]).sort(), [['Mode', 'literal'], ['Phase', 'enum']]);
  assert.ok(r.facts.entries.some((e) => e.fn === 'app.py::work' && e.kind === 'main'));
  const sw = r.census.switches.find((s) => s.id === 'switch:USE_THING');
  assert.equal(sw.offByDefault, true);
  assert.ok(r.census.switches.some((s) => s.id === 'switch:LIMIT_RETRIES'));
  const gate = r.census.branches.find((b) => b.fn.endsWith('::gate'));
  assert.equal(gate.weight, 'decision');
  assert.equal(r.census.passes.find((p) => p.fn.endsWith('::work')).kind, 'retry');
});

test('typescript and lua: classes, imports, enums, env defaults, throws, script links', async () => {
  w('ts/src/types.ts', 'export enum Level { Low = "low", High = "high" }\nexport type Verdict = "accepted" | "refused" | "deferred";\nexport const States = { Open: "open", Shut: "shut", Held: "held" } as const;\n');
  w('ts/src/queue.ts', [
    "import { Level } from './types';",
    "import * as util from './util.js';",
    "const RETRY_LIMIT = Number(process.env.RETRY_LIMIT ?? '5');",
    "export class Store {",
    "  private rows: string[] = [];",
    "  add(x: string): void { this.rows.push(x); }",
    "  size(): number { return this.rows.length; }",
    "}",
    "export class Queue {",
    "  constructor(private store: Store) {}",
    "  async push(x: string): Promise<Level> {",
    "    if (!x) throw new RangeError('empty');",
    "    this.store.add(x);",
    "    util.log(x);",
    "    await this.script('moveThing', [x]);",
    "    return Level.High;",
    "  }",
    "  async safe(x: string) { try { await this.push(x); } catch (e) { return null; } }",
    "  script(name: string, args: string[]) { return args.length; }",
    "  spin() { while (true) { if (this.store.size() > 3) break; } }",
    "}",
    "",
  ].join('\n'));
  w('ts/src/util.ts', 'export function log(x: string) { return x; }\n');
  w('ts/src/index.ts', "export * from './queue';\nexport { Level } from './types';\n");
  w('ts/src/commands/moveThing-3.lua', [
    '--- @include "includes/addIt"',
    'local a = KEYS[1]',
    'if redis.call("EXISTS", a) == 1 then',
    '  addIt(a)',
    '  return 0',
    'end',
    'return -1',
    '',
  ].join('\n'));
  w('ts/src/commands/includes/addIt.lua', 'local function addIt(k)\n  redis.call("SADD", k, "1")\nend\n');
  const r = await extract(path.join(tmp, 'ts'));
  const f = r.facts.functions;
  assert.ok(f['src/queue.ts::Queue.push'].calls.includes('src/queue.ts::Store.add'), 'constructor parameter property type');
  assert.ok(f['src/queue.ts::Queue.push'].calls.includes('src/util.ts::log'), 'namespace import with a .js specifier');
  assert.ok(f['src/queue.ts::Queue.push'].calls.includes('src/commands/moveThing-3.lua::<script>'), 'script name string links to the Lua file');
  assert.ok(f['src/commands/moveThing-3.lua::<script>'].calls.includes('src/commands/includes/addIt.lua::addIt'), 'lua include');
  assert.deepEqual(f['src/commands/moveThing-3.lua::<script>'].returns.map((x) => x.expr), ['0', '-1']);
  assert.ok(f['src/commands/includes/addIt.lua::addIt'].redisOps.includes('SADD'));
  assert.equal(f['src/queue.ts::Queue.push'].raises[0].type, 'RangeError');
  assert.equal(f['src/queue.ts::Queue.push'].raises[0].caught, false);
  assert.equal(f['src/queue.ts::Queue.safe'].excepts[0].swallows, true);
  assert.equal(f['src/queue.ts::Queue.spin'].loops[0].bounded, true);
  assert.deepEqual(r.facts.enums.map((e) => `${e.name}:${e.form}`).sort(), ['Level:enum', 'States:const-object', 'Verdict:literal']);
  const sw = r.census.switches.find((s) => s.id === 'switch:RETRY_LIMIT');
  assert.equal(sw.default, '5');
  assert.ok(r.facts.entries.some((e) => e.fn === 'src/queue.ts::Queue.push' && e.kind === 'export'), 'public method reached through export *');
  assert.ok(r.graph.callEdges.some(([x, y]) => x.endsWith('Queue.push') && y.endsWith('moveThing-3.lua::<script>')));
  assert.ok(r.graph.depth['src/commands/includes/addIt.lua::addIt'] >= 2, 'depth runs from the exported method through the script to its include');
});

test('stable row ids and function hashes survive reformatting', async () => {
  const body = 'def f(x):\n    if x:\n        return "ok"\n    return "no"\n';
  w('fmt1/m.py', body);
  w('fmt2/m.py', '# header comment\n\n\ndef f(x):\n\n    # note\n    if x:\n\n        return "ok"\n    return "no"   \n');
  const a = await extract(path.join(tmp, 'fmt1')), b = await extract(path.join(tmp, 'fmt2'));
  assert.equal(a.facts.functions['m.py::f'].sha256, b.facts.functions['m.py::f'].sha256);
  assert.deepEqual(a.census.endings.map((e) => [e.id, e.value]), b.census.endings.map((e) => [e.id, e.value]));
  assert.deepEqual(a.census.branches.map((x) => x.id), b.census.branches.map((x) => x.id));
});
