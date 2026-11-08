import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTypeScript } from '../src/map/tsir.mjs';
import { readLua } from '../src/map/luair.mjs';
import { tmpTree, typescript, luaGrammar } from './lib/map-util.mjs';

const TS = {
  'src/ledger.ts': [
    'import { fmt } from "./format";',
    'export class Ledger {',
    '  add(n: number): number { return fmt(n); }',
    '  total(): number { try { return this.add(1); } catch (e) { console.log(e); throw e; } finally { this.add(0); } }',
    '}',
    'export function open(): Ledger { return new Ledger(); }',
  ].join('\n'),
  'src/format.ts': 'export const fmt = (n: number): number => n * 2;\n',
  'src/format.test.ts': 'export const t = 1;\n',
  'src/types.d.ts': 'export type X = number;\n',
};

test('the TypeScript reader: graphs, classes, imports, the checker answer folded into the call', { skip: !typescript && 'typescript is not installed' }, async () => {
  const root = tmpTree(TS);
  const doc = await readTypeScript({ ts: typescript, root, prefix: 'src', exclude: [], check: 'auto' });
  assert.equal(doc.schema, 'fldet.ir/1');
  assert.deepEqual(doc.files.map((f) => f.path), ['src/format.ts', 'src/ledger.ts'], 'declaration and test files are left out');
  assert.match(doc.resolver, /^tsc \d+\.\d+\.\d+ \(zero-config\)$/);
  assert.deepEqual(Object.keys(doc.env).sort(), ['config', 'node_modules', 'tsc']);
  const ledger = doc.files.find((f) => f.path === 'src/ledger.ts');
  assert.deepEqual(ledger.imports.fmt, ['name', 'src.format', 'fmt']);
  assert.deepEqual(ledger.classes.map((c) => [c.name, Object.keys(c.methods)]), [['Ledger', ['add', 'total']]]);
  const total = ledger.fns.find((f) => f.qual === 'Ledger.total');
  assert.ok(total.nodes.some((n) => n.k === 'handler' && n.var === 'e' && n.uses === 1));
  const call = total.nodes.flatMap((n) => n.ops || []).find((o) => o.t === 'call' && o.f === 'self.add');
  assert.deepEqual(call.r.to, ['src/ledger.ts::Ledger.add'], 'the checker proves the target');
  const add = ledger.fns.find((f) => f.qual === 'Ledger.add');
  const fmtCall = add.nodes.flatMap((n) => n.ops || []).find((o) => o.f === 'fmt');
  assert.deepEqual(fmtCall.r.to, ['src/format.ts::fmt']);
  assert.equal(ledger.fns.find((f) => f.qual === 'open').exp, 1, 'an exported function is marked');
});

test('the TypeScript reader without a checker writes no resolver and no answers', { skip: !typescript && 'typescript is not installed' }, async () => {
  const root = tmpTree(TS);
  const doc = await readTypeScript({ ts: typescript, root, prefix: 'src', check: false });
  assert.equal(doc.resolver, undefined);
  const ops = doc.files.flatMap((f) => f.fns).flatMap((fn) => fn.nodes).flatMap((n) => n.ops || []).filter((o) => o.t === 'call');
  assert.ok(ops.length && ops.every((o) => o.r === undefined));
});

const LUA = {
  'scripts/main.lua': [
    '--- @include "util"',
    'local function guard(x)',
    '  if x == nil then',
    '    error("no value")',
    '  end',
    '  return x',
    'end',
    'redis.call("SET", KEYS[1], ARGV[1])',
    'return guard(helper(1))',
  ].join('\n'),
  'scripts/util.lua': 'local function helper(n)\n  return n\nend\n',
};

test('the Lua reader: functions, branches, calls, command effects, includes', { skip: !luaGrammar && 'web-tree-sitter or the Lua grammar is not installed' }, async () => {
  const root = tmpTree(LUA);
  const doc = await readLua({ grammar: luaGrammar, root, prefix: 'scripts' });
  assert.deepEqual(doc.files.map((f) => f.path), ['scripts/main.lua', 'scripts/util.lua']);
  const main = doc.files[0];
  assert.deepEqual(main.includes, ['scripts/util.lua']);
  assert.deepEqual(main.imports.helper, ['name', 'scripts.util', 'helper']);
  const guard = main.fns.find((f) => f.qual === 'guard');
  assert.ok(guard.nodes.some((n) => n.k === 'raise' && n.raised === 'error(...)'), 'error(...) ends the path');
  const top = main.fns.find((f) => f.qual === '<module>');
  const set = top.nodes.flatMap((n) => n.ops || []).find((o) => o.redis === 'SET');
  assert.deepEqual(set.eff, ['store']);
});
