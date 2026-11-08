import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { globRe, findFiles, fileDigest, requireAbsolute, StaleInput } from '../src/map/files.mjs';
import { tmpTree } from './lib/map-util.mjs';

test('globRe: * stays in a folder, ** crosses folders, ? is one character', () => {
  assert.ok(globRe('src/*.py').test('src/a.py') && !globRe('src/*.py').test('src/x/a.py'));
  assert.ok(globRe('src/**').test('src/x/y/a.py') && globRe('**/a.py').test('a.py') && globRe('**/a.py').test('x/y/a.py'));
  assert.ok(globRe('a?.py').test('ab.py') && !globRe('a?.py').test('a/.py'));
  assert.ok(globRe('a.b+c').test('a.b+c') && !globRe('a.b+c').test('aXb+c'), 'regular expression characters are literal');
});

test('findFiles: extensions, include, exclude (glob and folder), skipped folders, order', () => {
  const root = tmpTree({
    'pkg/b.py': '', 'pkg/a.py': '', 'pkg/sub/c.py': '', 'pkg/vendor/d.py': '', 'pkg/node_modules/e.py': '', 'pkg/gen/f.py': '', 'pkg/readme.md': '', 'other/g.py': '',
  });
  assert.deepEqual(findFiles(root, ['pkg/**'], ['pkg/gen'], ['.py']), ['pkg/a.py', 'pkg/b.py', 'pkg/sub/c.py']);
  assert.deepEqual(findFiles(root, [], ['**/sub/**', 'other'], ['.py']), ['pkg/a.py', 'pkg/b.py', 'pkg/gen/f.py']);
  assert.deepEqual(findFiles(root, [], [], ['.md']), ['pkg/readme.md']);
});

test('fileDigest depends on names and bytes, and refuses a file that is gone', () => {
  const root = tmpTree({ 'a.txt': 'one', 'b.txt': 'two' });
  const d = fileDigest(root, ['a.txt', 'b.txt']);
  assert.equal(d, fileDigest(root, ['b.txt', 'a.txt']), 'the order given does not matter');
  assert.notEqual(d, fileDigest(root, ['a.txt']));
  assert.throws(() => fileDigest(root, ['a.txt', 'missing.txt']), StaleInput);
});

test('requireAbsolute refuses a relative folder with the reason', () => {
  assert.throws(() => requireAbsolute('the work folder', 'relative/dir'), /must be an absolute path/);
  assert.equal(requireAbsolute('x', undefined), undefined);
  assert.doesNotThrow(() => requireAbsolute('x', process.platform === 'win32' ? 'C:/tmp' : '/tmp'));
});
