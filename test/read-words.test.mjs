// Names, stage words, examples, glossary, switches and who hears, on invented text.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Source } from '../src/read/source.mjs';
import { findName } from '../src/read/purpose.mjs';
import { codeBlocks, namesInCode, findExamples, exampleRank, TIER_FRONT, TIER_DOCS, TIER_NONE } from '../src/read/examples.mjs';
import { classifySite } from '../src/read/outcomes.mjs';
import { endSiteLabel } from '../src/read/words.mjs';
import { readHears } from '../src/read/hears.mjs';
import { findSwitches, switchNamesIn } from '../src/read/switches.mjs';
import { moduleComment, nameStages, stageSentence } from '../src/read/stagewords.mjs';
import { quoted } from '../src/read/util.mjs';
import { linkChains } from '../src/read/walk.mjs';

function tree(files) {
  const root = fs.mkdtempSync(path.join(process.env.FLDET_TEST_TMP ?? os.tmpdir(), 'fl-words-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

test('the title is the project name from its metadata or README heading, else its folder, never a label', () => {
  assert.equal(findName(new Source(tree({ 'package.json': '{"name": "@scope/ticketing"}' }))).name, 'ticketing');
  assert.equal(findName(new Source(tree({ 'pyproject.toml': '[project]\nname = "ticket-desk"\n', 'README.md': '# Ticket Desk\n\nWords.' }))).name, 'Ticket Desk');
  assert.equal(findName(new Source(tree({ 'pyproject.toml': '[project]\nname = "ticket-desk"\n', 'README.md': '# Something Else\n\nWords.' }))).name, 'ticket-desk');
  assert.equal(findName(new Source(tree({ 'backend/pyproject.toml': '[project]\nname = "deskapi"\n' }))).name, 'deskapi');
  const bare = findName(new Source(tree({ 'main.py': 'x = 1\n' })));
  assert.ok(bare.name === '' || bare.from.includes('folder'));
});

test('the names in README code examples rank what a project shows first, front door before docs', () => {
  const blocks = codeBlocks('# Quick start\n\n```js\nconst q = new Ledger("a");\nq.post("x", {});\n```\n\ntext\n\n```py\nsend_mail(1)\n```\n');
  assert.equal(blocks.length, 2);
  const n = namesInCode(blocks[0].code);
  assert.deepEqual(n.classes, ['Ledger']);
  assert.ok(n.calls.includes("post"));
  const root = tree({
    'README.md': '# Desk\n\nIntro words here for the reader.\n\n```js\nconst q = new Ledger("a");\nq.post("x");\nconst w = new Clerk("a", fn);\n```\n',
    'docs/guide.md': '# Guide\n\n```js\nq.freeze();\nsend_mail(1);\n```\n',
  });
  const ex = findExamples(new Source(root));
  assert.equal(exampleRank(ex, 'Ledger.post').tier, TIER_FRONT);
  assert.equal(exampleRank(ex, 'Clerk.constructor').tier, TIER_FRONT);
  assert.ok(exampleRank(ex, 'Ledger.post').at <= exampleRank(ex, 'Clerk.constructor').at, 'the example that comes first ranks first');
  assert.equal(exampleRank(ex, 'send_mail').tier, TIER_DOCS);
  assert.equal(exampleRank(ex, 'Other.post').tier, TIER_NONE, 'a method counts only when its class is shown too');
  assert.equal(exampleRank(ex, 'unshown').tier, TIER_NONE);
});

test('a negative number returned is not a success; a router status is the client\'s to hear', () => {
  assert.equal(classifySite({ kind: 'return', expr: '-1', cls: 'R:const:int', fnName: 'f' }).outcome, 'neutral');
  assert.equal(classifySite({ kind: 'return', expr: '0', cls: 'R:const:int', fnName: 'f' }).outcome, 'success');
  assert.equal(readHears({ says: 'heard by person', why: 'nothing catches it before module level: the traceback prints' }).value, 'log');
  assert.equal(readHears({ says: 'heard by person', why: 'caught at a.py:3 -> translate' }).value, 'caller');
  assert.equal(readHears({ says: 'heard by person', why: 'caught at a.py:3 -> print' }).value, 'person');
});

test('"Fails with *" names the real exception, or says it re-raises what it caught', () => {
  assert.equal(endSiteLabel({ cls: 'raise:*' }, { kind: 'raise', expr: 'ValueError("bad id")', why: '' }).t, 'Fails with ValueError');
  assert.match(endSiteLabel({ cls: 'raise:*' }, { kind: 'raise', expr: 'ValueError("bad id")', why: '' }).p, /bad id/);
  assert.equal(endSiteLabel({ cls: 'raise:*' }, { kind: 'raise', expr: '', why: '' }).t, 'Raises the error it caught');
  assert.equal(endSiteLabel({ cls: 'raise:*' }, { kind: 'raise', expr: 'err', why: '' }).t, 'Raises err');
  assert.equal(endSiteLabel({ cls: 'raise:KeyError' }, { kind: 'raise', expr: 'exc', why: '' }).t, 'Fails with KeyError');
});

test('a switch default must come from the same language and owner, and a test through ?. is a negation', () => {
  assert.deepEqual(switchNamesIn('!opts?.lazyConnect').map((x) => x.name), ['opts.lazyConnect']);
  const root = tree({
    'a.ts': 'export function f(opts) {\n  if (!opts?.lazyConnect) { run(); }\n  if (config.features.labels) { play(); }\n  if (opts.delay) { wait(); }\n}\nconst defaults = {\n  lazyConnect: false,\n};\nconst x = { delayInMs: y, span, onlyEmitError: true };\n',
    'b.js': 'const features = {\n  labels: true,\n};\n',
    'c.ts': 'export class Job {\n  delay: number = 0;\n}\n',
  });
  const mk = (id, path, line, test) => ({ id, kind: 'decision', title: test, detail: test, prov: { fn: `${path}::f`, line, rule: 'decision' }, refs: [] });
  const boxes = [mk('b1', 'a.ts', 2, '!opts?.lazyConnect'), mk('b2', 'a.ts', 3, 'config.features.labels'), mk('b3', 'a.ts', 4, 'opts.delay')];
  const W = { mappedIds: ['a.ts::f'], fns: new Map([['a.ts::f', { path: 'a.ts', boxes }]]), source: new Source(root), facts: null };
  const sw = findSwitches(W, new Map());
  const by = Object.fromEntries(sw.items.map((i) => [i.name, i]));
  assert.equal(by['opts.lazyConnect'].default?.literal, 'false');
  assert.equal(by['opts.lazyConnect'].uses[0].negated, true, 'a negation through ?. is seen');
  assert.equal(by['config.features.labels'].default, null, 'a value in another language is not this default');
  assert.equal(by['opts.delay'].default, null, 'a field of another owner is not this default');
});

test('an if/elif chain written as separate records is one chain: one arm taken kills the rest', () => {
  const chain = linkChains([
    { line: 10, kind: 'if', end: 30, then: [11, 12], else: [28, 29] },
    { line: 13, kind: 'elif', end: 30, then: [14, 15] },
    { line: 16, kind: 'elif', end: 30, then: [17, 18] },
  ]);
  assert.deepEqual(chain[0].else, [13, 30]);
  assert.deepEqual(chain[1].else, [16, 30]);
  assert.deepEqual(chain[2].else, [28, 29]);
});

test('a stage comment is the first sentence at the top of a file', () => {
  const root = tree({ 'm.py': '"""Keeps the queue of tickets. Second sentence."""\nimport x\n', 'n.ts': '/**\n * Sends the mail for a ticket.\n */\nexport function f() {}\n', 'o.ts': 'export const a = 1;\n' });
  const src = new Source(root);
  assert.equal(moduleComment(src, 'm.py'), 'Keeps the queue of tickets.');
  assert.equal(moduleComment(src, 'n.ts'), 'Sends the mail for a ticket.');
  assert.equal(moduleComment(src, 'o.ts'), '');
});

test('stage names are plain unique words: no bracket, slash or extension; a language only where two clash', () => {
  const fns = new Map(), of = new Map(), mappedIds = [];
  const add = (stage, file, n) => { for (let i = 0; i < n; i++) { const id = `${file}::f${i}`; fns.set(id, { path: file, qual: `f${i}` }); of.set(id, stage); mappedIds.push(id); } };
  add('d1', 'src/crates/anvil.ts', 3); add('d1', 'src/crates/chisel.ts', 1);
  add('d2', 'src/crates/mallet.ts', 3); add('d2', 'src/crates/vise.ts', 1);
  add('d3', 'src/gadgets/gizmo.py', 2); add('d4', 'src/gizmos/gizmo.ts', 2);
  const W = { mappedIds, fns, facts: null, source: { file: () => null, classLine: () => 0, docFor: () => '' } };
  const districts = { prefix: ['src'], order: ['d1', 'd2', 'd3', 'd4'], of, titles: new Map(['d1', 'd2', 'd3', 'd4'].map((d) => [d, `src/${d}`])) };
  const names = nameStages({ W, districts });
  const all = [...names.values()].map((v) => v.name);
  assert.equal(new Set(all).size, all.length, all.join(' | '));
  for (const n of all) assert.doesNotMatch(n, /[()\/\\]|\.[a-z]{1,4}$/, n);
  assert.deepEqual(all, ['Anvil', 'Mallet', 'Gizmo in Python', 'Gizmo in TypeScript']);
});

test('a licence line, {@link} or :class: markup is never a stage sentence', () => {
  assert.equal(stageSentence('Copyright (c) 2020 Some Person. All rights reserved.'), '');
  assert.equal(stageSentence('Licensed under the Example Public Licence, version 9.'), '');
  assert.equal(stageSentence('@internal Hands out the work.'), '');
  assert.equal(stageSentence('Hands each job to a {@link Runner} and waits.'), 'Hands each job to a Runner and waits.');
  assert.equal(stageSentence('Wraps :class:`Runner` so a job can be retried.'), 'Wraps Runner so a job can be retried.');
  assert.match(stageSentence('Hands each job to the runner that fits it.'), /^Hands each job/);
});

test('a cut quoted text ends with an ellipsis and no closing quote', () => {
  assert.equal(quoted('short', 30), '"short"');
  const cut = quoted('a message that is far too long to show whole in a box', 20);
  assert.match(cut, /^"[^"]+…$/);
  const end = endSiteLabel({ cls: 'Error' }, { kind: 'raise', expr: 'MadeUpError("a perfectly ordinary message")' });
  assert.match(end.p, /: "a perfectly ordinary message"\.$/);
});
