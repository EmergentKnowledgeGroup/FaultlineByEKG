// The census reads an if / elif / else chain as one decision. Two branches written on one line once sent that read round in a circle without end.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCensus } from '../src/extract/census.mjs';

const fn = (branches) => ({ path: 'a.js', qual: 'f', line: 1, calls: [], callAt: [], raises: [], exits: [], emits: [], branches, loops: [], retryHints: [], excepts: [] });
const census = (branches) => buildCensus({ functions: { 'a.js::f': fn(branches) }, entries: [], enums: [], switches: [], classBases: {}, modules: [{ path: 'a.js', lang: 'js', imports: [] }] }, { depth: {} });

test('an elif written on the same line as the branch before it ends the chain instead of looping', () => {
  const same = { line: 3, kind: 'elif', test: 'b', et: 'elif', else: [3, 3], then: [3, 3], tt: 'other' };
  const head = { line: 3, kind: 'if', test: 'a', et: 'elif', else: [3, 3], then: [3, 3], tt: 'other' };
  const c = census([head, same]);
  assert.equal(c.branches.length, 2);
  assert.equal(c.branches.filter((b) => b.rule === 'chain-arm').length, 1, 'the second is an arm of the first');
});

test('a plain chain of three is still one decision with two arms', () => {
  const a = { line: 3, kind: 'if', test: 'x === 1', et: 'elif', else: [5, 8], then: [3, 4], tt: 'other' };
  const b = { line: 5, kind: 'elif', test: 'x === 2', et: 'elif', else: [7, 8], then: [5, 6], tt: 'other' };
  const d = { line: 7, kind: 'elif', test: 'x === 3', et: 'else', else: [8, 8], then: [7, 7], tt: 'other' };
  const c = census([a, b, d]);
  assert.equal(c.branches.filter((x) => x.rule === 'chain-arm').length, 2);
});
