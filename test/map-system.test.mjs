import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readSystem, loadState, checkFresh, StaleInput } from '../src/map/index.mjs';
import { tmpTree, python, hasPython, typescript, luaGrammar } from './lib/map-util.mjs';

const FILES = {
  'app/__init__.py': '',
  'app/main.py': 'from app.util import twice\n\ndef run(x):\n    return twice(x)\n',
  'app/util.py': 'def twice(x):\n    return x * 2\n',
  'web/a.ts': 'export function a(): number { return b(); }\nfunction b(): number { return 1; }\n',
  'web/s.lua': 'local function f()\n  return 1\nend\nreturn f()\n',
};

test('readSystem refuses a relative root, work folder or tool folder, with the reason', async () => {
  await assert.rejects(readSystem({ root: 'relative/root' }), /config\.root must be an absolute path/);
  await assert.rejects(readSystem({ root: tmpTree(), work: 'relative/work' }), /config\.work must be an absolute path/);
  await assert.rejects(readSystem({ root: tmpTree(), tools: 'relative/tools' }), /config\.tools must be an absolute path/);
});

test('readSystem reads every language it is given, says what did not run, and records what it read', { skip: !hasPython && 'no Python 3.10 or newer' }, async () => {
  const root = tmpTree(FILES);
  const empty = tmpTree();
  const config = { root, python: { include: ['app/**'] }, typescript: { prefix: 'web' }, lua: { prefix: 'web' }, interpreter: python.exe, work: empty, tools: empty };
  const sys = await readSystem(config);
  assert.deepEqual(sys.ir.py.files.map((f) => f.path), ['app/__init__.py', 'app/main.py', 'app/util.py']);
  assert.equal(sys.ty, null);
  assert.ok(sys.notes.some((n) => n.code === 'no-checker' && /no negative claims/.test(n.text)));
  const read = sys.ir.py.files.length + (sys.ir.ts ? sys.ir.ts.files.length : 0) + (sys.ir.lua ? sys.ir.lua.files.length : 0);
  assert.equal(sys.sourceFiles, read);
  assert.equal(sys.ir.ts === null, !typescript);
  assert.equal(sys.ir.lua === null, !luaGrammar);
  if (!typescript) assert.ok(sys.notes.some((n) => n.code === 'no-typescript'));
  assert.match(sys.sourceDigest, /^[0-9a-f]{64}$/);
  assert.equal((await readSystem(config)).sourceDigest, sys.sourceDigest, 'the same sources give the same digest');

  const P = loadState(sys);
  assert.equal(P.pyAnswers, null);
  assert.equal(P.resolvers.py, null);
  assert.ok(P.fns.has('app/main.py::run') && P.modname.get('app.util') === 'app/util.py');
  assert.doesNotThrow(() => checkFresh(P));
  fs.writeFileSync(path.join(root, 'app', 'util.py'), 'def twice(x):\n    return x * 3\n');
  assert.throws(() => checkFresh(P), /changed after this project was read/);
  assert.notEqual((await readSystem(config)).sourceDigest, sys.sourceDigest);
  if (sys.ir.ts) {
    fs.writeFileSync(path.join(root, 'web', 'a.ts'), 'export function a(): number { return 2; }\n');
    assert.throws(() => loadState(sys), StaleInput, 'a reader document made from other sources than the ones on disk is refused');
  }
});

test('a system with no languages configured reads nothing and still has a digest', async () => {
  const sys = await readSystem({ root: tmpTree(FILES) });
  assert.deepEqual([sys.ir.py, sys.ir.ts, sys.ir.lua, sys.ty], [null, null, null, null]);
  assert.equal(sys.sourceFiles, 0);
});
