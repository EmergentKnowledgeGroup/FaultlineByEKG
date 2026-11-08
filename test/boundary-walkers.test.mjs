import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { listDir, findFiles, fileDigest, StaleInput } from '../src/map/files.mjs';
import { mirrorSources } from '../src/map/tyres.mjs';
import { outsideMentions } from '../src/map/lookup.mjs';
import { readTypeScript } from '../src/map/tsir.mjs';
import { readLua } from '../src/map/luair.mjs';
import { tmpTree, typescript, luaGrammar } from './lib/map-util.mjs';

// Walkers and readers must not follow a link out of the source folder. The canary below stands for a file outside it.
const CANARY = 'CANARY_WALKERS_0001';
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** A link at `at` to `target`; false when this machine does not allow links (the test then skips). */
function link(target, at, kind) {
  try { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, kind); return true; } catch { return false; }
}
/** A source folder with honest files, an outside folder with the canary, and links from the first to the second. -> null when links cannot be made. */
function scene() {
  const root = tmpTree({ 'real.py': 'def real(): pass\n', 'real.ini': 'SL_NAME = 1\n', 'web/ok.ts': 'export const ok = 1;\n', 'lua/ok.lua': 'local function ok() end\n' });
  const out = tmpTree({ 'secret.py': `${CANARY} = 1\n`, 'secret.ini': `SL_NAME = ${CANARY}\n`, 'secret.ts': `export const ${CANARY} = 1;\n`, 'secret.lua': `local function ${CANARY}() end\n`,
    'dir/inner.py': `${CANARY} = 2\n`, 'dir/inner.ts': `export const ${CANARY}_dir = 1;\n`, 'dir/inner.lua': `local function ${CANARY}_dir() end\n`, 'dir/inner.ini': `SL_NAME = ${CANARY}\n` });
  const ok = [
    link(path.join(out, 'secret.py'), path.join(root, 'helpers.py'), 'file'),
    link(path.join(out, 'secret.ini'), path.join(root, 'settings.ini'), 'file'),
    link(path.join(out, 'secret.ts'), path.join(root, 'web/leak.ts'), 'file'),
    link(path.join(out, 'secret.lua'), path.join(root, 'lua/leak.lua'), 'file'),
    link(path.join(out, 'dir'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'),
    link(path.join(out, 'dir'), path.join(root, 'weblink'), process.platform === 'win32' ? 'junction' : 'dir'),
  ];
  return ok.every(Boolean) ? { root, out } : null;
}
const NO_LINKS = 'this machine does not allow links';

test('listDir leaves out every link, to a file and to a folder', (t) => {
  const s = scene();
  if (!s) return t.skip(NO_LINKS);
  const names = listDir(s.root).map((e) => e.name);
  assert.deepEqual(names, ['lua', 'real.ini', 'real.py', 'web'], 'only the real entries are listed');
  assert.deepEqual(listDir(path.join(s.root, 'web')).map((e) => e.name), ['ok.ts'], 'a link to a file inside a folder is left out too');
});

test('findFiles never returns a link, even when a pattern (a wildcard in a name) would match its name', (t) => {
  const s = scene();
  if (!s) return t.skip(NO_LINKS);
  assert.deepEqual(findFiles(s.root, [], [], ['.py']), ['real.py']);
  assert.deepEqual(findFiles(s.root, ['**/*.py'], [], ['.py']), ['real.py']);
  assert.deepEqual(findFiles(s.root, ['linked/*.py'], [], ['.py']), [], 'a linked folder is not walked');
  // a discovered file named with a '?' or '*' becomes a pattern that also fits the link next to it; the link must still not come back
  assert.deepEqual(findFiles(s.root, ['?elpers.py', '*.py', '**.py', 'real.py'], [], ['.py']), ['real.py']);
});

test('an honest folder with no links is listed exactly as before', () => {
  const root = tmpTree({ 'b.py': '', 'a.py': '', 'd/c.py': '', 'd/e.txt': '' });
  assert.deepEqual(listDir(root).map((e) => [e.name, e.isDir, e.isFile]), [['a.py', false, true], ['b.py', false, true], ['d', true, false]]);
  assert.deepEqual(findFiles(root, [], [], ['.py']), ['a.py', 'b.py', 'd/c.py']);
});

test('fileDigest: a path that is not clean or leads outside the root counts as changed and is never read', (t) => {
  const s = scene();
  if (!s) return t.skip(NO_LINKS);
  const sneaky = ['helpers.py', 'linked/inner.py', '../' + path.basename(s.out) + '/secret.py', path.join(s.out, 'secret.py').replace(/\\/g, '/'), '..\\x', 'a\u0000b', '', 'real.py/../../x', 'C:/x.py'];
  for (const rel of sneaky) {
    let err = null;
    try { fileDigest(s.root, ['real.py', rel]); } catch (e) { err = e; }
    assert.ok(err instanceof StaleInput, `${JSON.stringify(rel)} must be refused`);
    assert.ok(!err.message.includes(CANARY), 'the refused file\'s text is not in the message');
  }
  assert.throws(() => fileDigest(s.root, [null]), StaleInput);
  assert.throws(() => fileDigest(s.root, [{}]), StaleInput);
  assert.throws(() => fileDigest(s.root, ['missing.py']), (e) => e instanceof StaleInput && /cannot be read/.test(e.message), 'a file that is gone says so, as before');
});

test('fileDigest: honest files give the same digest as before the gate', () => {
  const root = tmpTree({ 'a.txt': 'one', 'd/b.txt': 'two', 'e.txt': '' });
  const want = createHash('sha256');
  for (const [rel, body] of [['a.txt', 'one'], ['d/b.txt', 'two'], ['e.txt', '']]) want.update(rel + '\0' + sha(body) + '\n');
  assert.equal(fileDigest(root, ['e.txt', 'a.txt', 'd/b.txt']), want.digest('hex'));
  assert.equal(fileDigest(root, []), sha(''), 'an empty list is the digest of nothing, as before');
});

test('mirrorSources copies only what the gate allows: a link to an outside file is not copied or hashed', (t) => {
  const s = scene();
  if (!s) return t.skip(NO_LINKS);
  const dest = tmpTree();
  const took = new Set();
  const h = mirrorSources(s.root, ['real.py', 'helpers.py', 'linked/inner.py', '../x.py'], dest, took);
  assert.deepEqual([...took], ['real.py']);
  assert.deepEqual(fs.readdirSync(dest), ['real.py'], 'nothing else was written');
  assert.equal(h, mirrorSources(s.root, ['real.py'], tmpTree()), 'the hash covers the copied file only');
  for (const f of fs.readdirSync(dest)) assert.ok(!fs.readFileSync(path.join(dest, f), 'utf8').includes(CANARY));
});

test('outsideMentions never opens a link: a name in an outside file is not found through one', (t) => {
  const s = scene();
  if (!s) return t.skip(NO_LINKS);
  const P = { root: s.root, mods: new Map() };
  const found = outsideMentions(P, ['SL_NAME']);
  assert.deepEqual([...found], [['SL_NAME', ['real.ini', 1]]], 'only the real file is searched; the linked settings.ini and linked/ folder are not');
  fs.rmSync(path.join(s.root, 'real.ini'));
  assert.deepEqual([...outsideMentions(P, ['SL_NAME'])], [], 'with the real file gone nothing names it: the links lead nowhere we look');
});

test('TypeScript reader: files that are links are not read', { skip: !typescript && 'typescript is not installed' }, async (t) => {
  const s = scene();
  if (!s) return t.skip(NO_LINKS);
  const doc = await readTypeScript({ ts: typescript, root: s.root, prefix: '', exclude: [], check: null });
  assert.deepEqual(doc.files.map((f) => f.path), ['web/ok.ts']);
  assert.ok(!JSON.stringify(doc).includes(CANARY));
  const viaLink = await readTypeScript({ ts: typescript, root: s.root, prefix: 'weblink', exclude: [], check: null });
  assert.deepEqual(viaLink.files, [], 'a prefix that names a linked folder finds nothing in it');
});

test('Lua reader: links are not read, and a start folder that leads outside the root is refused', { skip: !luaGrammar && 'the Lua grammar is not installed' }, async (t) => {
  const s = scene();
  if (!s) return t.skip(NO_LINKS);
  const doc = await readLua({ grammar: luaGrammar, root: s.root, prefix: 'lua' });
  assert.deepEqual(doc.files.map((f) => f.path), ['lua/ok.lua']);
  assert.ok(!JSON.stringify(doc).includes(CANARY));
  for (const prefix of ['linked', 'weblink', '../' + path.basename(s.out), '..']) {
    let err = null;
    try { await readLua({ grammar: luaGrammar, root: s.root, prefix }); } catch (e) { err = e; }
    assert.ok(err && /leads outside/.test(err.message), `${prefix} must be refused`);
    assert.ok(!err.message.includes(CANARY));
  }
  const whole = await readLua({ grammar: luaGrammar, root: s.root, prefix: '' });
  assert.deepEqual(whole.files.map((f) => f.path), ['lua/ok.lua'], 'the whole root: the linked folder and file are skipped');
});
