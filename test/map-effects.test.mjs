// What a call does is decided from the definition it lands on, not from its name: the name table only proposes.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCall } from '../src/map/common.mjs';
import { decide, adjust, boundaryOf, raisesOf, lexicalDefs, isPure, confirms } from '../src/map/effects.mjs';

const has = (set, ...xs) => xs.every((x) => set.has(x));

test('the name table proposes effects from the callee text', () => {
  assert.ok(has(classifyCall('os.replace'), 'store'));
  assert.ok(has(classifyCall('self.logger.warning'), 'log'));
  assert.ok(has(classifyCall('print'), 'print'));
  assert.ok(has(classifyCall('time.sleep'), 'wait:time'));
  assert.ok(has(classifyCall('asyncio.gather'), 'wait:machine'));
  assert.ok(has(classifyCall('sys.exit'), 'exit'));
  assert.ok(has(classifyCall('db.execute', 1, 'INSERT INTO t VALUES (1)'), 'store'));
  assert.ok(!classifyCall('db.execute', 1, 'SELECT 1').has('store'));
  assert.ok(has(classifyCall('open'), 'store?'));
});

test('a candidate becomes an effect only when the definition says so', () => {
  const [keep, maybe] = decide(new Set(['store']), [['os', 'replace']], 'ext', {}, null);
  assert.deepEqual([...keep], ['store']);
  assert.equal(maybe.size, 0);
  const [k2, m2] = decide(new Set(['store']), [['builtins', 'str.replace']], 'ext', {}, null);
  assert.equal(k2.size + m2.size, 0, 'str.replace is a pure value operation');
  const [k3, m3] = decide(new Set(['store']), [], 'silent', {}, null);
  assert.deepEqual([...m3], ['maybe:store']);
  assert.equal(k3.size, 0);
  const [k4] = decide(new Set(['store']), [['somewhere', 'thing']], 'project', {}, null);
  assert.equal(k4.size, 0, 'a project callee does what its own body does');
});

test('opening a file is a store only for a writing mode on a file definition', () => {
  assert.deepEqual([...decide(new Set(['store?']), [['builtins', 'open']], 'ext', { mode: 'w' }, null)[0]], ['store']);
  assert.equal(decide(new Set(['store?']), [['builtins', 'open']], 'ext', { mode: 'r' }, null)[0].size, 0);
  assert.deepEqual([...decide(new Set(['store?']), [], 'silent', { mode: 'a' }, null)[1]], ['maybe:store']);
});

test('json.dump is a store only for a name bound by `with open(..., "w")`', () => {
  const defs = [['json', 'dump']];
  assert.deepEqual([...decide(new Set(['store']), defs, 'ext', { cb: ['f'] }, new Map([['f', 'w']]))[0]], ['store']);
  assert.deepEqual([...decide(new Set(['store']), defs, 'ext', { cb: ['buf'] }, new Map([['f', 'w']]))[1]], ['maybe:store']);
});

test('print to a file and an unawaited awaitable are taken back', () => {
  const [k, m] = adjust(new Set(['print']), new Set(), { fl: 'handle' }, []);
  assert.deepEqual([[...k], [...m]], [[], ['maybe:print']]);
  const [k2, m2] = adjust(new Set(['wait:time']), new Set(), { aw: false }, [['asyncio', 'sleep']]);
  assert.deepEqual([[...k2], [...m2]], [[], ['maybe:wait:time']]);
  assert.deepEqual([...adjust(new Set(['wait:time']), new Set(), { aw: true }, [['asyncio', 'sleep']])[0]], ['wait:time']);
});

test('a call leaves the process when its definition says so, else it is only a maybe', () => {
  assert.deepEqual([...boundaryOf([['requests', 'get']], 'requests')[0]], ['network']);
  const [sure, maybe] = boundaryOf([], 'requests');
  assert.equal(sure.size, 0);
  assert.deepEqual([...maybe], ['network']);
  assert.equal(boundaryOf([['builtins', 'len']], 'requests')[1].size, 0);
});

test('documented raisers come from the definition', () => {
  assert.deepEqual(raisesOf({ defs: [['json', 'loads']] }), [['ValueError'], true]);
  assert.deepEqual(raisesOf({ defs: [['builtins', 'len']] }), [[], true]);
  assert.deepEqual(raisesOf({ defs: [['somewhere', 'x']] }), [[], false]);
});

test('imports alone prove a definition when no checker answered', () => {
  const imp = new Map([['os', ['mod', 'os']], ['replace', ['name', 'os', 'replace']]]);
  assert.deepEqual(lexicalDefs({ f: 'os.replace' }, imp, false, new Set(), new Set()), [['os', 'replace']]);
  assert.deepEqual(lexicalDefs({ f: 'replace' }, imp, false, new Set(), new Set()), [['os', 'replace']]);
  assert.deepEqual(lexicalDefs({ f: 'open' }, imp, true, new Set(), new Set()), [['builtins', 'open']]);
  assert.deepEqual(lexicalDefs({ f: 'os.replace' }, imp, false, new Set(), new Set(['os'])), [], 'a parameter named os is not the module');
  assert.deepEqual(lexicalDefs({ f: 'self.x.replace' }, imp, false, new Set(), new Set()), []);
  assert.ok(isPure('builtins', 'len') && confirms('store', 'shutil', 'move') && !confirms('store', 'builtins', 'str.replace'));
});
