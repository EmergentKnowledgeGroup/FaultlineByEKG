import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { cmpCp, canonJson, tkey, untkey, sortedCp } from '../src/map/canon.mjs';

test('cmpCp orders by code point, not by UTF-16 unit', () => {
  const astral = '\u{1F600}', high = '\uFF21';          // U+1F600 is the pair D83D DE00; U+FF21 is one unit above D800
  assert.ok(cmpCp(high, astral) < 0, 'U+FF21 sorts before U+1F600');
  assert.ok(high > astral, 'the default JS comparison disagrees, which is why cmpCp exists');
  assert.deepEqual(sortedCp(['b', 'a', 'B', '_']), ['B', '_', 'a', 'b']);
  assert.ok(cmpCp('ab', 'abc') < 0 && cmpCp('abc', 'ab') > 0 && cmpCp('x', 'x') === 0);
});

test('canonJson sorts keys, puts one value per line, and keeps empty containers short', () => {
  assert.equal(canonJson({ b: [1, 2], a: {}, c: [], d: null, e: 'x"y' }), '{\n"a": {},\n"b": [\n1,\n2\n],\n"c": [],\n"d": null,\n"e": "x\\"y"\n}');
  assert.equal(canonJson({ 10: 1, 9: 2, a: 3 }), '{\n"10": 1,\n"9": 2,\n"a": 3\n}', 'numeric-looking keys are sorted as text');
  assert.equal(canonJson(new Map([['z', 1], ['y', new Set(['q', 'p'])]])), '{\n"y": [\n"p",\n"q"\n],\n"z": 1\n}');
});

test('canonJson refuses what other languages would write differently', () => {
  assert.throws(() => canonJson({ x: 1.5 }), /not a safe integer/);
  assert.throws(() => canonJson([2 ** 60]), /not a safe integer/);
});

test('tkey round-trips a tuple of strings', () => {
  assert.deepEqual(untkey(tkey('a/b.py', 'f.g')), ['a/b.py', 'f.g']);
  assert.notEqual(tkey('ab', 'c'), tkey('a', 'bc'));
});
