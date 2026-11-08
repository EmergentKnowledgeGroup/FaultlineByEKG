// The Python-shaped helpers the rules rely on: order, length and slicing by code point, truthiness, white space, and the JSON text Python writes.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { cmp, cmpStr, sorted, cpLen, cpSlice, T, short, squash, pyStrip, dumps, PyFloat, pyRepr, pyRound2, replace1, startsUpper, isUpperStr } from '../src/map/pyrt.mjs';

test('strings order by code point, not by UTF-16 unit', () => {
  const astral = '\u{1F600}';
  const high = '～'; // U+FF5E sorts below U+1F600 by code point, above it by UTF-16 unit
  assert.equal(astral < high, true, 'the native comparison is the wrong one here');
  assert.equal(cmpStr(astral, high), 1);
  assert.deepEqual(sorted([astral, high, 'a']), ['a', high, astral]);
});

test('length and slicing count code points', () => {
  assert.equal(cpLen('a\u{1F600}b'), 3);
  assert.equal(cpSlice('a\u{1F600}bc', 1, 3), '\u{1F600}b');
  assert.equal(cpSlice('abcdef', 2), 'cdef');
});

test('arrays compare element by element and a shorter prefix comes first', () => {
  assert.ok(cmp([1, 'b'], [1, 'c']) < 0);
  assert.ok(cmp([1], [1, 0]) < 0);
  assert.ok(cmp(['x', 2], ['x', 2]) === 0);
  assert.deepEqual(sorted([[2, 'a'], [1, 'z'], [1, 'a']]), [[1, 'a'], [1, 'z'], [2, 'a']]);
});

test('sorted calls the key once per item, in list order, before comparing', () => {
  const order = [];
  sorted(['c', 'a', 'b'], (x) => { order.push(x); return x; });
  assert.deepEqual(order, ['c', 'a', 'b']);
});

test('empty containers are false, as in Python', () => {
  for (const v of [[], {}, new Set(), new Map(), '', 0, null, undefined, false]) assert.equal(T(v), false);
  for (const v of [[0], { a: 1 }, new Set([1]), 'x', 1, true]) assert.equal(T(v), true);
});

test('titles are shortened by code point and white space is squashed the Python way', () => {
  assert.equal(squash('  a \t\n b c  '), 'a b c');
  assert.equal(pyStrip('\u001c x  '), 'x');
  assert.equal(short('x'.repeat(100), 10), 'xxxxxxx...');
  assert.equal(short('  short   one '), 'short one');
});

test('JSON is written with sorted keys, no escaping of non-ASCII, and the indent Python uses', () => {
  const v = { b: [1, 2, { z: null, a: 'é\n"' }], a: [], c: {}, d: true };
  assert.equal(dumps(v, 1), '{\n "a": [],\n "b": [\n  1,\n  2,\n  {\n   "a": "é\\n\\"",\n   "z": null\n  }\n ],\n "c": {},\n "d": true\n}');
  assert.equal(dumps([1, { a: 2 }], 0), '[\n1,\n{\n"a": 2\n}\n]');
  assert.equal(dumps({ b: 1, a: [1, 2] }), '{"a": [1, 2], "b": 1}');
  assert.equal(dumps('\u0001'), '"\\u0001"');
  assert.equal(dumps(new PyFloat(1)), '1.0');
  assert.equal(dumps(new PyFloat(0.25)), '0.25');
});

test('a missing value is an error, never a silently dropped key', () => {
  assert.throws(() => dumps({ a: undefined }), /undefined/);
});

test('repr and round follow Python', () => {
  assert.equal(pyRepr("it's"), '"it\'s"');
  assert.equal(pyRepr('a\nb'), "'a\\nb'");
  assert.equal(pyRepr(['a', null, 3]), "['a', None, 3]");
  assert.equal(pyRound2(0.125), 0.12);
  assert.equal(pyRound2(0.375), 0.38);
  assert.equal(pyRound2(0.285), 0.28);
});

test('replace1 uses the new text as it is', () => {
  assert.equal(replace1('a: b: c', ': ', '$&'), 'a$&b: c');
  assert.equal(replace1('abc', 'x', 'y'), 'abc');
});

test('upper-case tests follow str.isupper', () => {
  assert.ok(startsUpper('Foo') && !startsUpper('foo') && !startsUpper('_Foo') && !startsUpper(''));
  assert.ok(isUpperStr('ABC_1') && !isUpperStr('AbC') && !isUpperStr('123'));
});
