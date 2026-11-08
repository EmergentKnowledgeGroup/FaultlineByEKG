// Where the reading meets the rule engine's newer output: roads that hand a function over, and functions whose only box is a place to land.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roadKind } from '../src/read/world.mjs';
import { Source } from '../src/read/source.mjs';
import { functionExtent, deriveStructure } from '../src/read/structure.mjs';

test('a road that hands a function over is its own kind, so the owner is not taken for its caller', () => {
  assert.equal(roadKind({ prov: { rule: 'call', how: 'callback', tier: 'may' } }), 'callback');
  assert.equal(roadKind({ prov: { rule: 'call', tier: 'proven' } }), 'call');
  assert.equal(roadKind({ prov: { rule: 'link' } }), 'link');
  assert.equal(roadKind({ prov: { rule: 'exc-edge' } }), 'exc');
  assert.equal(roadKind({ prov: { rule: 'cfg-edge' } }), 'cfg');
});

test('the extent of a function assigned inside an if block starts at its own head, not at the if', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMP || os.tmpdir(), 'ext-'));
  const lines = [
    'export function outer(flag: boolean) {',
    '  let stop: () => void = () => {};',
    '  if (flag) {',
    '    stop = () => {',
    '      try {',
    '        run();',
    '      } catch {',
    '        // ignore',
    '      }',
    '    };',
    '  }',
    '}',
    '',
  ];
  fs.writeFileSync(path.join(dir, 'a.ts'), lines.join('\n'));
  try {
    const ex = functionExtent(new Source(dir), 'a.ts', 6, 6, 'ts');
    assert.deepEqual(ex, { from: 4, to: 10 });
  } finally {
    fs.unlinkSync(path.join(dir, 'a.ts'));
    fs.rmdirSync(dir);
  }
});

test('the then-arm of an if followed by `} else if (...) {` ends before that line, so the next head is not inside the dead arm', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMP || os.tmpdir(), 'chain-'));
  const lines = [
    'export function pick(a: any) {',
    '  if (a.one) {',
    '    return first(a);',
    '  } else if (a.two) {',
    '    return second(a);',
    '  } else {',
    '    return third(a);',
    '  }',
    '}',
    '',
  ];
  fs.writeFileSync(path.join(dir, 'b.ts'), lines.join('\n'));
  try {
    const { branches } = deriveStructure(new Source(dir), 'b.ts', 1, 9, 'ts');
    assert.deepEqual(branches.map((b) => [b.line, b.kind, b.then]), [[2, 'if', [3, 3]], [4, 'elif', [5, 5]]]);
  } finally {
    fs.unlinkSync(path.join(dir, 'b.ts'));
    fs.rmdirSync(dir);
  }
});
