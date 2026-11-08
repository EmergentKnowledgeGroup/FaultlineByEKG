// The reading lane of the file-boundary fix: nothing outside the mapped folder may be read through the README/docs/metadata readers,
// the source reader, or the commit pin, however a link or a pointer file is laid out. Fake canary text only.
import './lib/sandbox.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Source } from '../src/read/source.mjs';
import { findPurpose, findName } from '../src/read/purpose.mjs';
import { docSentences } from '../src/read/glossary.mjs';
import { findExamples } from '../src/read/examples.mjs';
import { gitHead } from '../src/extract/walk.mjs';
import { extract } from '../src/extract/index.mjs';

const CANARY = 'CANARYREADING';
const PROSE = `Outside canary prose says the ${CANARY} escrow account holds the merger funds for the hidden project today. A Queue is the ${CANARY} secret escrow account.`;
const ID40 = 'a'.repeat(40);
const ID64 = 'b'.repeat(64);
const mk = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `fl-bread-${name}-`));
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
// A link, or false when this machine cannot make one (the test then skips).
const link = (target, at, type) => { try { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, type); return true; } catch { return false; } };
const holds = (v) => JSON.stringify(v).includes(CANARY);

// outer/outside holds the text that must never be read; outer/repo is the mapped folder
function world(name) {
  const outer = mk(name);
  const outside = path.join(outer, 'outside');
  const root = path.join(outer, 'repo');
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  return { outer, outside, root };
}

test('a README, or package metadata, that is a link out of the folder gives no purpose and no name', (t) => {
  for (const [file, text] of [
    ['README.md', `# Outside Name\n\n${PROSE}\n`],
    ['package.json', JSON.stringify({ name: `${CANARY}-pkg`, description: `${CANARY} description of the outside package, long enough` })],
    ['pyproject.toml', `[project]\nname = "${CANARY}-py"\ndescription = "${CANARY} description of the outside project"\n`],
    ['Cargo.toml', `[package]\nname = "${CANARY}-rs"\ndescription = "${CANARY} description of the outside crate"\n`],
    ['setup.cfg', `[metadata]\nname = ${CANARY}-cfg\ndescription = ${CANARY} description of the outside project\n`],
  ]) {
    const w = world('meta');
    put(path.join(w.outside, file), text);
    if (!link(path.join(w.outside, file), path.join(w.root, file), 'file')) return t.skip('cannot make a symbolic link on this machine');
    const s = new Source(w.root);
    assert.equal(s.rootText(file), null, file);
    const p = findPurpose(s, null);
    assert.equal(p.text, null, file);
    assert.ok(!holds(p) && !holds(findName(s)), file);
  }
});

test('a README that is a link to a file inside the folder still reads', (t) => {
  const w = world('inreadme');
  put(path.join(w.root, 'docs', 'about.md'), `# Inner Name\n\nThe order desk takes a customer order and sends it on to the warehouse for packing.\n`);
  if (!link('docs/about.md', path.join(w.root, 'README.md'), 'file')) return t.skip('cannot make a symbolic link on this machine');
  const p = findPurpose(new Source(w.root), null);
  assert.match(p.text, /order desk/);
});

test('a metadata folder that is a link out of the project gives no name, however the link leads', (t) => {
  const w = world('pkgdir');
  put(path.join(w.outside, 'pkg', 'package.json'), JSON.stringify({ name: `${CANARY}-dirname` }));
  if (!link(path.join(w.outside, 'pkg'), path.join(w.root, 'pkg'), 'junction')) return t.skip('cannot make a link on this machine');
  const s = new Source(w.root);
  assert.equal(s.rootText('pkg/package.json'), null);
  assert.ok(!holds(findName(s)));
});

test('a docs folder, a file in it, or a folder in it that is a link gives no documentation text', (t) => {
  const w = world('docs');
  put(path.join(w.outside, 'notes', 'internal.md'), `${PROSE}\n`);
  put(path.join(w.outside, 'one.md'), `${PROSE}\n`);
  put(path.join(w.root, 'docs', 'real.md'), 'A Widget is the plain thing this project makes for the people who ask for it.\n');
  if (!link(path.join(w.outside, 'one.md'), path.join(w.root, 'docs', 'linked.md'), 'file')) return t.skip('cannot make a symbolic link on this machine');
  assert.ok(link(path.join(w.outside, 'notes'), path.join(w.root, 'docs', 'sub'), 'junction'));
  let s = new Source(w.root);
  assert.deepEqual(s.docFiles(300), ['docs/real.md']);
  assert.ok(!holds(docSentences(s)) && !holds(findExamples(s)));
  // the docs folder itself is the link
  const v = world('docs-top');
  put(path.join(v.outside, 'internal.md'), `${PROSE}\n`);
  assert.ok(link(path.join(v.outside), path.join(v.root, 'docs'), 'junction'));
  s = new Source(v.root);
  assert.deepEqual(s.docFiles(300), []);
  assert.ok(!holds(docSentences(s)));
});

test('a docs link that loops back to the folder is not walked either', (t) => {
  const w = world('loop');
  put(path.join(w.root, 'docs', 'real.md'), 'A Widget is the plain thing this project makes for the people who ask for it.\n');
  if (!link('..', path.join(w.root, 'docs', 'up'), 'junction')) return t.skip('cannot make a link on this machine');
  assert.deepEqual(new Source(w.root).docFiles(300), ['docs/real.md']);
});

test('the source reader refuses a link out, a path that climbs out, and a sibling folder that shares the root as a prefix', (t) => {
  const w = world('file');
  const sib = `${w.root}-x`;
  put(path.join(sib, 'secret.py'), `# ${CANARY}\nSECRET = 1\n`);
  put(path.join(w.outside, 'secret.py'), `# ${CANARY}\nSECRET = 1\n`);
  put(path.join(w.root, 'src', 'ok.py'), 'def ok():\n    return 1\n');
  if (!link(path.join(w.outside, 'secret.py'), path.join(w.root, 'src', 'leak.py'), 'file')) return t.skip('cannot make a symbolic link on this machine');
  link('ok.py', path.join(w.root, 'src', 'inner.py'), 'file');
  const s = new Source(w.root);
  assert.equal(s.file('src/leak.py'), null);
  assert.equal(s.file('../repo-x/secret.py'), null);
  assert.equal(s.file('../outside/secret.py'), null);
  assert.equal(s.file(path.join(w.outside, 'secret.py')), null);
  assert.equal(s.file('src\\..\\..\\outside\\secret.py'), null);
  assert.equal(s.has('src/leak.py'), false);
  assert.equal(s.line('src/leak.py', 1), '');
  assert.equal(s.slice('src/leak.py', 1, 2), '');
  assert.equal(s.statement('src/leak.py', 1), null);
  assert.match(s.file('src/ok.py').text, /def ok/);
  if (fs.lstatSync(path.join(w.root, 'src', 'inner.py')).isSymbolicLink()) assert.match(s.file('src/inner.py').text, /def ok/);   // a link that stays inside is honest
  assert.equal(s.file('src/missing.py'), null);
});

test('a folder with no links reads exactly as before', () => {
  const w = world('plain');
  put(path.join(w.root, 'README.md'), '# Plain Thing\n\nThe order desk takes a customer order and sends it on to the warehouse for packing.\n');
  put(path.join(w.root, 'package.json'), JSON.stringify({ name: 'plain-thing', description: 'the plain thing for tests' }));
  put(path.join(w.root, 'docs', 'b.md'), 'A Widget is the plain thing this project makes.\n');
  put(path.join(w.root, 'docs', 'a', 'c.txt'), 'A Gadget is the other plain thing this project makes.\n');
  put(path.join(w.root, 'docs', 'node_modules', 'skip.md'), 'skipped\n');
  put(path.join(w.root, 'src', 'm.py'), 'x = 1\r\ny = 2\r\n');
  const s = new Source(w.root);
  assert.deepEqual(s.docFiles(300), ['README.md', 'docs/a/c.txt', 'docs/b.md']);
  assert.match(findPurpose(s, null).text, /order desk/);
  assert.equal(findName(s).name, 'Plain Thing');
  assert.equal(s.line('src/m.py', 2), 'y = 2');
  assert.equal(s.slice('src/m.py', 1, 2), 'x = 1\ny = 2');
});

// the commit pin
const git = (root) => path.join(root, '.git');

test('the commit pin reads a plain .git folder: a loose ref, a packed ref, a detached head, a 64 digit id', () => {
  const w = world('git');
  put(path.join(git(w.root), 'HEAD'), 'ref: refs/heads/main\n');
  put(path.join(git(w.root), 'refs', 'heads', 'main'), `${ID40}\n`);
  assert.equal(gitHead(w.root), ID40);
  const p = world('git-packed');
  put(path.join(git(p.root), 'HEAD'), 'ref: refs/heads/feature/x\n');
  put(path.join(git(p.root), 'packed-refs'), `# pack-refs\n${ID64} refs/heads/feature/x\n${ID40} refs/heads/other\n`);
  assert.equal(gitHead(p.root), ID64);
  const d = world('git-detached');
  put(path.join(git(d.root), 'HEAD'), `${ID40}\n`);
  assert.equal(gitHead(d.root), ID40);
  assert.equal(gitHead(world('git-none').root), null);
});

test('the commit pin takes nothing that is not a commit id', () => {
  const w = world('git-junk');
  put(path.join(git(w.root), 'HEAD'), `${CANARY} not a commit id\n`);
  assert.equal(gitHead(w.root), null);
  put(path.join(git(w.root), 'HEAD'), 'ref: refs/heads/main\n');
  put(path.join(git(w.root), 'refs', 'heads', 'main'), `${CANARY}\nsecond line\n`);
  assert.equal(gitHead(w.root), null);
  put(path.join(git(w.root), 'refs', 'heads', 'main'), `${'A'.repeat(40)}\n`);
  assert.equal(gitHead(w.root), null, 'upper case is not how git writes an id');
  put(path.join(git(w.root), 'refs', 'heads', 'main'), `${'a'.repeat(41)}\n`);
  assert.equal(gitHead(w.root), null);
});

test('a ref that climbs out of the git folder reads nothing, even when the file it names holds an id', () => {
  const w = world('git-climb');
  put(path.join(w.outside, 'secret.txt'), `${ID40}\n${CANARY}\n`);
  put(path.join(w.outside, 'bare.txt'), `${ID40}\n`);
  for (const ref of ['../../outside/secret.txt', 'refs/../../../outside/bare.txt', '/etc/passwd', 'refs/heads/../../../../outside/bare.txt', 'refs\\..\\..\\..\\outside\\bare.txt', 'C:/Windows/win.ini', 'refs//heads/x']) {
    put(path.join(git(w.root), 'HEAD'), `ref: ${ref}\n`);
    assert.equal(gitHead(w.root), null, ref);
  }
});

test('the commit pin follows no link: .git, HEAD, a ref file, a folder on the ref path, or packed-refs', (t) => {
  const idFile = (dir, name = 'x') => { put(path.join(dir, name), `${ID40}\n`); return path.join(dir, name); };
  // .git itself
  let w = world('git-l1');
  put(path.join(w.outside, 'real', 'HEAD'), `${ID40}\n`);
  if (!link(path.join(w.outside, 'real'), git(w.root), 'junction')) return t.skip('cannot make a link on this machine');
  assert.equal(gitHead(w.root), null, '.git is a link');
  // HEAD
  w = world('git-l2');
  link(idFile(w.outside), path.join(git(w.root), 'HEAD'), 'file');
  assert.equal(gitHead(w.root), null, 'HEAD is a link');
  // a loose ref
  w = world('git-l3');
  put(path.join(git(w.root), 'HEAD'), 'ref: refs/heads/main\n');
  link(idFile(w.outside), path.join(git(w.root), 'refs', 'heads', 'main'), 'file');
  put(path.join(git(w.root), 'packed-refs'), `${ID64} refs/heads/main\n`);
  assert.equal(gitHead(w.root), null, 'the ref file is a link');
  // a folder on the ref path
  w = world('git-l4');
  put(path.join(git(w.root), 'HEAD'), 'ref: refs/heads/main\n');
  idFile(path.join(w.outside, 'heads'), 'main');
  link(w.outside, path.join(git(w.root), 'refs'), 'junction');
  assert.equal(gitHead(w.root), null, 'refs is a link');
  // packed-refs
  w = world('git-l5');
  put(path.join(git(w.root), 'HEAD'), 'ref: refs/heads/main\n');
  put(path.join(w.outside, 'packed'), `${ID64} refs/heads/main\n`);
  link(path.join(w.outside, 'packed'), path.join(git(w.root), 'packed-refs'), 'file');
  assert.equal(gitHead(w.root), null, 'packed-refs is a link');
});

test('a .git pointer file leads only to a linked worktree or a submodule folder', () => {
  // an honest worktree: the main repository sits beside the checkout
  const w = world('git-wt');
  const wt = path.join(w.outer, 'main', '.git', 'worktrees', 'repo');
  put(path.join(wt, 'HEAD'), `${ID40}\n`);
  put(path.join(w.root, '.git'), `gitdir: ${wt.replace(/\\/g, '/')}\n`);
  assert.equal(gitHead(w.root), ID40);
  // a submodule: a relative pointer
  const s = world('git-sub');
  put(path.join(s.outer, '.git', 'modules', 'repo', 'HEAD'), `${ID64}\n`);
  put(path.join(s.root, '.git'), 'gitdir: ../.git/modules/repo\n');
  assert.equal(gitHead(s.root), ID64);
  // anywhere else: nothing, whatever the folder holds
  for (const pointer of ['../outside', 'x', path.join(w.outside).replace(/\\/g, '/'), '../outside/.git/other']) {
    const v = world('git-ptr');
    put(path.join(v.outside, 'HEAD'), `${ID40}\n`);
    put(path.join(v.outside, '.git', 'other', 'HEAD'), `${ID40}\n`);
    put(path.join(v.root, 'x', 'HEAD'), `${ID40}\n`);
    put(path.join(v.root, '.git'), `gitdir: ${pointer}\n`);
    assert.equal(gitHead(v.root), null, pointer);
  }
  // a pointer file that is no pointer, and a hostile one that also climbs with its ref
  const n = world('git-nop');
  put(path.join(n.root, '.git'), `${CANARY}\n`);
  assert.equal(gitHead(n.root), null);
  const h = world('git-hostile');
  put(path.join(h.outside, 'secret.txt'), `${ID40}\n${CANARY}\n`);
  put(path.join(h.root, 'x', 'HEAD'), 'ref: ../../outside/secret.txt\n');
  put(path.join(h.root, '.git'), 'gitdir: x\n');
  assert.equal(gitHead(h.root), null);
});

test('a pointer that passes through a link to somewhere else is not followed', (t) => {
  const w = world('git-ptrlink');
  put(path.join(w.outside, 'HEAD'), `${ID40}\n`);
  // looks like a submodule folder from the outside, but .git/modules is a link to the outside folder
  fs.mkdirSync(path.join(w.outer, '.git'), { recursive: true });
  if (!link(w.outside, path.join(w.outer, '.git', 'modules'), 'junction')) return t.skip('cannot make a link on this machine');
  put(path.join(w.root, '.git'), 'gitdir: ../.git/modules\n');
  assert.equal(gitHead(w.root), null);
});

test('extract records no commit, and nothing of an outside file, when the .git folder is hostile', async () => {
  const w = world('git-extract');
  put(path.join(w.outside, 'secret.txt'), `${CANARY} one\n${CANARY} two\n`);
  put(path.join(w.root, 'a.py'), 'def a():\n    return 1\n');
  put(path.join(git(w.root), 'HEAD'), 'ref: ../../outside/secret.txt\n');
  const res = await extract(w.root, { noPython: true });
  assert.equal(res.facts.pin.git, null);
  assert.ok(!holds(res.facts));
});
