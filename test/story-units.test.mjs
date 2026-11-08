// The small parts: the rooted source reader, the word tools, the story index, the loader.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RootedSource, MAX_SOURCE_BYTES } from '../src/story/source.mjs';
import { nameTokens, words, isElseLabel, hasNegation, testPolarity, readsAsGood, readsAsBad } from '../src/story/words.mjs';
import { storyIndex } from '../src/story/export.mjs';
import { loadStory, mergeStory } from '../src/story/load.mjs';
import { canonJson, cmp, clip, plain } from '../src/story/canon.mjs';
import { continues, opensBlock } from '../src/story/ref.mjs';
import { isRaise } from '../src/story/seen.mjs';
import { scratch, ROOT } from './lib/story-kit.mjs';

test('source: only plain relative paths inside the root pass the text test', () => {
  const s = new RootedSource(ROOT);
  for (const ok of ['kiosk/sales.py', './kiosk/sales.py', 'kiosk/../kiosk/sales.py']) assert.equal(s.ref(ok).ok, true, ok);
  for (const bad of ['', '../x', '/etc/passwd', 'C:/x', 'c:\\x', 'kiosk\\sales.py', '../../kiosk/sales.py', 'a\u0000b', '.', 'kiosk/', 'x'.repeat(2000)]) assert.equal(s.ref(bad).ok, false, JSON.stringify(bad).slice(0, 30));
  assert.equal(s.lines('../x'), null);
  assert.ok(s.lines('kiosk/sales.py').length > 50);
  assert.equal(s.line('kiosk/sales.py', 0), null);
  assert.equal(s.line('kiosk/sales.py', 99999), null);
});

test('source: CRLF and CR read as LF, and a file over the size limit is not read', () => {
  const dir = scratch('source');
  fs.writeFileSync(`${dir}/crlf.txt`, 'a\r\nb\rc\n');
  fs.writeFileSync(`${dir}/big.txt`, Buffer.alloc(MAX_SOURCE_BYTES + 1, 97));
  const s = new RootedSource(dir);
  assert.deepEqual(s.lines('crlf.txt'), ['a', 'b', 'c', '']);
  assert.equal(s.lines('big.txt'), null);
  assert.equal(s.whyNot('nothing.txt'), 'missing');
  assert.equal(s.whyNot('../nothing.txt'), 'outside');
});

test('words: names that look like code, shared words, closed lists', () => {
  const n = nameTokens('Calls `lookupFare` and fare_table, then Ledger.append; ignores JSON and util.py');
  assert.ok([...n.keys()].includes('lookupFare') && [...n.keys()].includes('fare_table') && [...n.keys()].includes('Ledger.append'));
  assert.ok(![...n.keys()].includes('JSON') && ![...n.keys()].includes('util.py'));
  assert.ok(words('The seat count').has('seat') && !words('The seat count').has('the'));
  for (const e of ['else', 'Otherwise', 'if not', ' Else. ']) assert.equal(isElseLabel(e), true, e);
  for (const e of ['else if the card is blank', 'priority', '']) assert.equal(isElseLabel(e), false, e);
  assert.equal(hasNegation('No priority'), true);
  assert.equal(hasNegation("isn't ready"), true);
  assert.equal(hasNegation('Priority rider'), false);
  assert.equal(readsAsGood('printing succeeded') && !readsAsBad('printing succeeded'), true);
  assert.equal(readsAsBad('printing fails'), true);
});

test('words: which tests say "present" and which "absent"; anything else is left alone', () => {
  const t = [['request.priority', 'pos'], ['!ready', 'neg'], ['not paid', 'neg'], ['x is None', 'neg'], ['x == null', 'neg'], ['x !== undefined', 'pos'], ['x > 0', 'pos'], ['x is not None', 'pos'],
    ['a && b', null], ['x < 3', null], ['fn(a, b)', null], ['x == y', null]];
  for (const [test_, want] of t) assert.equal(testPolarity(test_), want, test_);
});

test('canon: keys sorted by code point, one trailing newline, clip and plain are safe', () => {
  assert.equal(canonJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}\n');
  assert.ok(cmp('a', 'b') < 0 && cmp('b', 'a') > 0 && cmp('a', 'a') === 0);
  assert.ok(cmp('\ud83d\ude00', '\uffee') > 0, 'above U+FFFF sorts after U+FFEE');
  assert.equal(clip('abcdef', 4), 'abc\u2026');
  assert.equal(Array.from(clip('\ud83d\ude00'.repeat(5), 3)).length, 3);
  assert.equal(plain('a\u0000b\n\tc  d', 50), 'a b c d');
});

test('ref: where a statement goes on, and the line that opens a block', () => {
  const ls = ['x = call(a,', '         b,', '         c)', 'y = 1', 'z = a +', '    b', 'if ok:', '    go()'];
  assert.equal(continues(ls, 1, 2), true);
  assert.equal(continues(ls, 1, 3), true);
  assert.equal(continues(ls, 1, 4), false);
  assert.equal(continues(ls, 5, 6), true);
  assert.equal(opensBlock(ls, 7), true);
  assert.equal(opensBlock(ls, 4), false);
});

test('index: spans and the lines of tests, calls and exits, from reader documents alone', () => {
  const ir = { ts: { files: [{ path: 'a.ts', lang: 'ts', lines: 9, fns: [{ id: 'a.ts::f', path: 'a.ts', qual: 'f', lang: 'ts', line: 1, end: 9, nodes: [
    { k: 'branch', line: 2, tk: 'if', test: 'x > 1', ops: [] }, { k: 'return', line: 3, ops: [{ t: 'call', line: 3, f: 'g' }] }, { k: 'raise', line: 5, ops: [] }, { k: 'block', line: 6, ops: [{ t: 'tern', line: 6 }, { t: 'link', line: 7 }] }] }] }] } };
  const x = storyIndex(ir, 'abc');
  assert.equal(x.source_digest, 'abc');
  assert.deepEqual(x.files['a.ts'], { lines: 9, lang: 'ts' });
  assert.deepEqual(x.fns['a.ts::f'].br, [[2, 'if', 'x > 1'], [6, 'tern', '']]);
  assert.deepEqual(x.fns['a.ts::f'].rt, [[3, 'return'], [5, 'raise']]);
  assert.deepEqual(x.fns['a.ts::f'].ca, [[3, 'g'], [7, 'link']]);
});

test('load: fragments merge in file-name order; a duplicate id, bad JSON and a wrong schema are refused', () => {
  const dir = scratch('frag/model');
  fs.rmSync(`${dir}/20-c.json`, { force: true });           // a file this test wrote on an earlier run
  const w = (n, o) => fs.writeFileSync(`${dir}/${n}`, typeof o === 'string' ? o : JSON.stringify(o));
  w('00-a.json', { schema: 'faultline.model/1', boxes: [{ id: 'b1' }], routes: [] });
  w('10-b.json', { boxes: [{ id: 'b2' }], routes: [{ id: 'r1', from: 'b1', to: 'b2' }] });
  let r = loadStory(dir);
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.story.boxes.map((b) => b.id), ['b1', 'b2']);
  assert.equal(loadStory(scratch('frag')).story.boxes.length, 2, 'a folder with a model/ subfolder');
  w('20-c.json', { boxes: [{ id: 'b1' }] });
  r = loadStory(dir);
  assert.ok(r.refusals.some((x) => x.code === 'S-dup' && /box id "b1"/.test(x.msg)));
  w('20-c.json', '{ not json');
  assert.ok(loadStory(dir).refusals.some((x) => x.code === 'S-json'));
  w('20-c.json', { schema: 'other/1', boxes: [] });
  assert.ok(loadStory(dir).refusals.some((x) => x.code === 'S-shape'));
  assert.ok(loadStory(scratch('frag/none')).refusals.some((x) => x.code === 'S-read'));
  assert.ok(mergeStory([{ file: 'x.json', data: { routes: [{ id: 'r' }, { id: 'r' }] } }]).refusals.some((x) => /defined twice/.test(x.msg)));
  assert.ok(mergeStory([{ file: 'x.json', data: { boxes: [{ title: 'no id' }] } }]).refusals.some((x) => x.code === 'S-id'));
});

test('seen: a raise of an exit exception is an ordinary ending, not a failure', () => {
  for (const [cls, want] of [['raise:Error', true], ['raise-open:Error', true], ['raise-caught:ValueError', true], ['raise:SystemExit', false], ['raise-open:StopIteration', false], ['RB', false], ['', false]]) assert.equal(isRaise(cls), want, cls);
});
