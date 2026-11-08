import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTy, qualAt, moduleOf, canon, uriOf, pathOf, collectSites, mirrorSources, resolvePython } from '../src/map/tyres.mjs';
import { tmpTree, fwd } from './lib/map-util.mjs';

const FAKE = fileURLToPath(new URL('./lib/map-fake-checker.mjs', import.meta.url));

test('uriOf and pathOf round-trip, and encode what a URI must encode', () => {
  const p = fwd(path.resolve(tmpTree({ 'a b/ü.py': '' }), 'a b/ü.py'));
  const u = uriOf(p);
  assert.match(u, /^file:\/\/\/.*a%20b\/%C3%BC\.py$/);
  assert.equal(pathOf(u).toLowerCase(), p.toLowerCase());
  assert.equal(pathOf('file:///c%3A/Users/x/f.py'), 'c:/Users/x/f.py');
});

test('qualAt reads the qualified name from indentation, not from a parser', () => {
  const root = tmpTree({
    'stub.pyi': ['class Path:', '    def replace(self, x): ...', '    async def aread(self): ...', 'def top(): ...', 'LIMIT: int = 3', 'def outer():', '\tdef inner(): ...'].join('\n'),
  });
  const f = root + '/stub.pyi';
  assert.deepEqual(qualAt(f, 2), ['Path.replace', 'def']);
  assert.deepEqual(qualAt(f, 3), ['Path.aread', 'def']);
  assert.deepEqual(qualAt(f, 1), ['Path', 'class']);
  assert.deepEqual(qualAt(f, 4), ['top', 'def']);
  assert.deepEqual(qualAt(f, 5), ['LIMIT', 'var']);
  assert.deepEqual(qualAt(f, 7), ['outer.<locals>.inner', 'def']);
  assert.deepEqual(qualAt(f, 99), ['?', '?']);
});

test('moduleOf names the module of a stub, an installed package and an interpreter source file', () => {
  assert.deepEqual(moduleOf('C:/x/vendored/typeshed/stdlib/os/path.pyi'), ['os.path', 'stub']);
  assert.deepEqual(moduleOf('/v/lib/site-packages/click/core.py'), ['click.core', 'pkg']);
  assert.deepEqual(moduleOf('/usr/lib/python3.12/json/__init__.py'), ['json', 'src']);
});

test('canon: project definitions by place, outside ones by module and name, stable order, noise dropped', () => {
  const root = tmpTree({ 'lib/vendored/typeshed/stdlib/os/__init__.pyi': 'def getcwd(): ...\n' });
  const mirror = '/work/mirror/sys';
  const locs = [
    ['file:///work/mirror/sys/app/main.py', 12, 4],
    ['file://' + (root.startsWith('/') ? '' : '/') + root + '/lib/vendored/typeshed/stdlib/os/__init__.pyi', 1, 4],
    ['file:///work/mirror/sys/app/main.py', 12, 4],
  ];
  assert.deepEqual(canon(locs, mirror), [{ k: 'ext', m: 'os', q: 'getcwd' }, { k: 'proj', p: 'app/main.py', l: 12, c: 4 }]);
  const noisy = [['file://' + (root.startsWith('/') ? '' : '/') + root + '/lib/vendored/typeshed/stdlib/os/__init__.pyi', 1, 4], ['file://' + (root.startsWith('/') ? '' : '/') + root + '/lib/vendored/typeshed/stdlib/os/__init__.pyi', 2, 0]];
  assert.deepEqual(canon(noisy, mirror).map((x) => x.q), ['getcwd'], 'an unnamed definition next to a named one of the same module is dropped');
});

test('collectSites lists the call and with sites of each file in order', () => {
  const doc = { files: [
    { path: 'b.py', fns: [{ nodes: [{ ops: [{ t: 'call', nl: 3, nc: 4 }, { t: 'with', nl: 1, nc: 9 }, { t: 'set' }] }] }] },
    { path: 'a.py', fns: [{ nodes: [{ ops: [{ t: 'call', nl: 2, nc: 0 }, { t: 'call', nl: 2, nc: 0 }] }] }] },
    { path: 'c.py', fns: [{ nodes: [{}] }] },
  ] };
  assert.deepEqual([...collectSites(doc)], [['a.py', [[2, 0]]], ['b.py', [[1, 9], [3, 4]]]]);
});

test('mirrorSources copies the files and hashes names plus content', () => {
  const root = tmpTree({ 'a.py': 'x = 1\n', 'd/b.py': 'y = 2\n' });
  const dest = tmpTree();
  const h1 = mirrorSources(root, ['a.py', 'd/b.py'], dest);
  assert.equal(fs.readFileSync(path.join(dest, 'd/b.py'), 'utf8'), 'y = 2\n');
  assert.equal(h1, mirrorSources(root, ['d/b.py', 'a.py'], dest));
  fs.writeFileSync(path.join(root, 'a.py'), 'x = 3\n');
  assert.notEqual(h1, mirrorSources(root, ['a.py', 'd/b.py'], dest));
});

test('asking until the answers stand still: late answers are waited for, answers that never settle are withheld', async () => {
  const mirror = tmpTree({ 'm.py': 'a()\nb()\nc()\n' });
  const sites = new Map([['m.py', [[1, 0], [2, 0], [3, 0]]]]);
  process.env.FAKE_LS_PLAN = JSON.stringify({ '1:0': 'late', '2:0': 'steady', '3:0': 'never' });
  const { raw, meta } = await runTy({ exe: process.execPath, args: [FAKE], mirror, sites, cache: mirror });
  const loc = (l) => ['file:///lib/typeshed/stdlib/os/__init__.pyi', l + 1, 4];
  assert.deepEqual(raw.get('m.py:1:0'), [loc(1)], 'empty on the first pass, a location once it is asked again');
  assert.deepEqual(raw.get('m.py:2:0'), [loc(1)]);
  assert.equal(raw.get('m.py:3:0'), null, 'an answer that changes every time is not an answer');
  assert.equal(meta.unstable, 1);
  assert.equal(meta.differed_between_passes, 2);
  assert.equal(meta.aborted, null);
});

test('a checker that is not installed gives no answers, and a relative work folder is refused', async () => {
  const root = tmpTree({ 'm.py': 'a()\n' });
  const nowhere = tmpTree();
  assert.equal(await resolvePython({ doc: { files: [] }, root, rels: [], work: nowhere, tools: nowhere }), null);
  await assert.rejects(resolvePython({ doc: { files: [] }, root, rels: [], work: 'relative/work', tools: nowhere }), /must be an absolute path/);
});
