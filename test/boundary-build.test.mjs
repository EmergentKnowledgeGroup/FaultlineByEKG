// The build lane of the file-boundary fix: build --excerpts, the G1 gate, signals and the model fragments may not copy text from outside
// the folder they were pointed at, whatever a received project folder says. Fake canary text only.
import './lib/sandbox.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addExcerpts } from '../src/build/assemble.mjs';
import { resolveProject, mayQuoteCode, rootSetAsideNote } from '../src/build/project.mjs';
import { g1 } from '../src/model/hard.mjs';
import { indexFacts } from '../src/model/refs.mjs';
import { readFragments, loadModelReport } from '../src/model/load.mjs';
import { buildSignals } from '../src/extract/signals.mjs';
import { buildProject } from '../src/build/pipeline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..'), BIN = path.join(ROOT, 'bin', 'faultline.mjs'), TOY = path.join(ROOT, 'examples', 'toy');
const CANARY = 'CANARYBUILD';
const SECRET = Array.from({ length: 20 }, (_, i) => `${CANARY} secret line ${i + 1}`).join('\n') + '\n';
const mk = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `fl-bbuild-${name}-`));
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
// A link, or false when this machine cannot make one (the test then skips).
const link = (target, at, type) => { try { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, type); return true; } catch { return false; } };
const holds = (v) => (typeof v === 'string' ? v : JSON.stringify(v)).includes(CANARY);
const cli = (args, cwd) => { const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', timeout: 300000 }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const fwd = (p) => p.replace(/\\/g, '/');

// outer/outside holds the text that must never be read; outer/repo is the code folder
function world(name) {
  const outer = mk(name), outside = path.join(outer, 'outside'), repo = path.join(outer, 'repo');
  put(path.join(outside, 'secret.txt'), SECRET);
  fs.mkdirSync(repo, { recursive: true });
  return { outer, outside, repo, secret: path.join(outside, 'secret.txt') };
}
const atlas = (refs) => ({ charts: { c: { nodes: { n: { refs } } } } });
const excerpts = (d) => d.charts.c.nodes.n.refs.map((r) => r.excerpt);

// ---- build --excerpts: addExcerpts -----------------------------------------------------------------------------------------------------

test('addExcerpts: a ref path that is absolute, climbs out with .., uses a backslash .. or leads out through a link gets no excerpt; a plain one still does', (t) => {
  const w = world('excerpt');
  put(path.join(w.repo, 'src', 'a.py'), Array.from({ length: 30 }, (_, i) => `line ${i + 1} of a`).join('\n'));
  put(path.join(w.repo, 'src', 'crlf.py'), 'one\r\ntwo\r\nthree\r\n');
  const canLink = link(w.secret, path.join(w.repo, 'src', 'linked.txt'), 'file');
  const d = atlas([
    { path: 'src/a.py', line: 5 },                 // 0: honest
    { path: './src/a.py', line: 6 },               // 1: honest, written with a leading ./
    { path: 'src\\a.py', line: 7 },                // 2: honest, written with a backslash
    { path: '../outside/secret.txt', line: 1 },    // 3
    { path: 'src/../../outside/secret.txt', line: 1 },
    { path: '..\\outside\\secret.txt', line: 1 },
    { path: fwd(w.secret), line: 1 },              // 6: absolute
    { path: 'src/linked.txt', line: 1 },           // 7: a link out of the folder
    { path: 'src/crlf.py', line: 2 },
  ]);
  addExcerpts(d, w.repo);
  const ex = excerpts(d);
  assert.match(ex[0], /^line 5 of a\nline 6 of a/);
  assert.match(ex[1], /^line 6 of a/);
  assert.match(ex[2], /^line 7 of a/);
  for (const i of [3, 4, 5, 6]) assert.equal(ex[i], undefined, `ref ${i}`);
  if (canLink) assert.equal(ex[7], undefined, 'a link out of the folder');
  assert.equal(ex[8], 'two\nthree\n', 'CRLF reads as LF');
  assert.ok(!holds(d), 'no canary text anywhere in the data');
  if (!canLink) t.diagnostic('cannot make a symbolic link on this machine: the link case was not run');
});

test('addExcerpts: a link to a file inside the folder still reads', (t) => {
  const w = world('inlink');
  put(path.join(w.repo, 'real.py'), 'alpha\nbeta\ngamma\n');
  if (!link('real.py', path.join(w.repo, 'alias.py'), 'file')) return t.skip('cannot make a symbolic link on this machine');
  const d = atlas([{ path: 'alias.py', line: 2 }]);
  addExcerpts(d, w.repo);
  assert.match(excerpts(d)[0], /^beta\ngamma/);
});

// ---- G1 ---------------------------------------------------------------------------------------------------------------------------------

test('G1 refuses a cited path or module that is absolute or climbs out with .., even when facts.json lists it', () => {
  const facts = {
    modules: ['../outside/secret.txt', '/etc/hosts', 'C:/Users/x/secret.txt', 'src/a.py'].map((p) => ({ path: p, lines: 50, lang: 'py' })),
    functions: {
      '../outside/secret.txt::leak': { path: '../outside/secret.txt', line: 1, end: 12 },
      'src/a.py::ok': { path: 'src/a.py', line: 1, end: 12 },
      'src/a.py::fake': { path: '../outside/secret.txt', line: 1, end: 12 },
    },
  };
  const fx = indexFacts(facts);
  const bad = [
    { symbol: '../outside/secret.txt::leak', path: '../outside/secret.txt', line: 1 },
    { path: '../outside/secret.txt', line: 1 },
    { path: '..\\outside\\secret.txt', line: 1 },
    { path: '/etc/hosts', line: 1 },
    { path: 'C:/Users/x/secret.txt', line: 1 },
    { symbol: '../outside/secret.txt::leak' },
    { symbol: 'src/a.py::fake' },                        // the id looks fine; facts.json puts it outside
  ];
  for (const ref of bad) {
    const r = g1({ boxes: [{ id: 'b', refs: [ref] }] }, fx);
    assert.equal(r.length, 1, JSON.stringify(ref));
    assert.match(r[0].msg, /REFUSE G1 cited path is outside the code folder/, JSON.stringify(ref));
  }
  assert.deepEqual(g1({ boxes: [{ id: 'b', refs: [{ symbol: 'src/a.py::ok', path: './src/a.py', line: 3 }, { path: 'src/a.py', line: 3 }] }] }, fx), [], 'plain paths pass');
});

// ---- model fragments (OS-4) -------------------------------------------------------------------------------------------------------------

test('a model fragment that is not valid JSON is refused with a place, never with the start of the file', () => {
  const d = mk('frag');
  put(path.join(d, 'model', '10-a.json'), `${CANARY} hello world this is not json at all`);
  put(path.join(d, 'model', '20-b.json'), `{\n  "schema": "faultline.model/1",\n  ${CANARY} oops\n}\n`);
  put(path.join(d, 'model', '30-c.json'), `{"schema": "faultline.model/1", "boxes": [] ${CANARY}}`);
  const { refusals } = readFragments(d);
  assert.equal(refusals.length, 3);
  assert.ok(!holds(refusals), 'no canary text in any refusal');
  assert.match(refusals[0].msg, /fragment is not valid JSON: 10-a\.json\./);
  assert.match(refusals[1].msg, /20-b\.json at line 3, column 3/);
  assert.match(refusals[2].msg, /30-c\.json at line 1, column 45/);
});

test('a model fragment that is a link to a file outside the model folder is refused unread', (t) => {
  const w = world('fraglink');
  const d = path.join(w.repo, '.faultline');
  put(path.join(w.outside, 'notes.json'), JSON.stringify({ schema: `${CANARY}-schema`, secret: SECRET }));
  put(path.join(w.outside, 'plain.txt'), `${CANARY} plain words`);
  put(path.join(d, 'model', '00-system.json'), JSON.stringify({ schema: 'faultline.model/1', system: { name: 'Mini' } }));
  put(path.join(d, 'shared', 'real.json'), JSON.stringify({ schema: 'faultline.model/1', terms: [{ term: 'inside', def: 'a term kept in a sibling folder' }] }));
  const ok = [
    link(path.join(w.outside, 'notes.json'), path.join(d, 'model', '10-outside-json.json'), 'file'),
    link(path.join(w.outside, 'plain.txt'), path.join(d, 'model', '11-outside-text.json'), 'file'),
    link('../shared/real.json', path.join(d, 'model', '12-sibling-folder.json'), 'file'),
  ];
  if (ok.includes(false)) return t.skip('cannot make a symbolic link on this machine');
  const rep = loadModelReport(d);
  assert.deepEqual(rep.refusals.map((r) => /outside the model folder: (\S+?)\. Fix/.exec(r.msg)?.[1]), ['10-outside-json.json', '11-outside-text.json', '12-sibling-folder.json']);
  assert.ok(!holds(rep.refusals), 'no canary text in any refusal');
  assert.ok(!holds(rep.model) && !rep.model.terms.some((x) => x.term === 'inside'), 'none of them was read');
});

test('a model fragment that is a link to another file in the model folder still loads', (t) => {
  const d = mk('fraginside');
  put(path.join(d, 'model', '00-system.json'), JSON.stringify({ schema: 'faultline.model/1', system: { name: 'Mini' } }));
  put(path.join(d, 'model', 'real.json.txt'), JSON.stringify({ schema: 'faultline.model/1', terms: [{ term: 'kept', def: 'a term kept in a sibling file' }] }));
  if (!link('real.json.txt', path.join(d, 'model', '20-alias.json'), 'file')) return t.skip('cannot make a symbolic link on this machine');
  const rep = loadModelReport(d);
  assert.equal(rep.refusals.length, 0, rep.refusals.map((r) => r.msg).join('\n'));
  assert.ok(rep.model.terms.some((x) => x.term === 'kept'));
});

// ---- signals (MT-7) ---------------------------------------------------------------------------------------------------------------------

test('signals: a module path that is absolute, climbs out with .. or leads out through a link is not opened; it is listed as skipped without any file text', async (t) => {
  const w = world('signals');
  put(path.join(w.repo, 'ok.py'), 'import threading\n\ndef pause_worker():\n    pass\n\ndef resume_worker():\n    pass\n');
  put(path.join(w.outside, 'leak.py'), `SECRET = "${CANARY}"\ndef (broken ${CANARY}\n`);
  const canLink = link(path.join(w.outside, 'leak.py'), path.join(w.repo, 'linked.py'), 'file');
  const canDir = link(w.outside, path.join(w.repo, 'pkg', 'out'), 'junction');                // a folder link (a junction on Windows)
  const files = [
    { path: 'ok.py', lang: 'py' },
    { path: '../outside/leak.py', lang: 'py' },
    { path: fwd(path.join(w.outside, 'leak.py')), lang: 'py' },
    { path: 'gone.py', lang: 'py' },                                    // merely missing: the reader says so itself
    ...(canLink ? [{ path: 'linked.py', lang: 'py' }] : []),
    ...(canDir ? [{ path: 'pkg/out/leak.py', lang: 'py' }] : []),
  ];
  const sig = await buildSignals(w.repo, files);
  assert.ok(!holds(sig), 'no canary text in the signals');
  const refused = sig.skipped.filter((s) => /outside the source folder/.test(s.why)).map((s) => s.path).sort();
  assert.deepEqual(refused, ['../outside/leak.py', fwd(path.join(w.outside, 'leak.py')).slice(0, 120), ...(canLink ? ['linked.py'] : []), ...(canDir ? ['pkg/out/leak.py'] : [])].sort());
  assert.ok(sig.skipped.some((s) => s.path === 'gone.py' && !/outside/.test(s.why)), 'a missing file is skipped for its own reason');
  assert.ok(!sig.skipped.some((s) => /SyntaxError/.test(s.why)), 'nothing outside was parsed');
  assert.equal(sig.languages.py, 2, 'ok.py and gone.py went to the reader');
  if (!canLink || !canDir) t.diagnostic('cannot make a symbolic link on this machine: a link case was not run');
});

// ---- the commands -----------------------------------------------------------------------------------------------------------------------

// A hand-made project in outer/repo/.faultline: the toy's code and model, extracted.
function toyProject(name) {
  const w = world(name);
  const cp = (rel) => { fs.mkdirSync(path.dirname(path.join(w.repo, rel)), { recursive: true }); fs.copyFileSync(path.join(TOY, rel), path.join(w.repo, rel)); };
  for (const sub of ['parcelworks', 'web']) for (const f of fs.readdirSync(path.join(TOY, sub))) if (/\.(py|ts)$/.test(f)) cp(path.join(sub, f));
  cp('.faultline/config.json');
  for (const f of fs.readdirSync(path.join(TOY, '.faultline/model'))) if (!/^90-/.test(f)) cp(path.join('.faultline/model', f));
  const r = cli(['extract'], w.repo);
  assert.equal(r.code, 0, r.err + r.out);
  w.dir = path.join(w.repo, '.faultline');
  return w;
}
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJ = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
// the project remembers its code outside its own folder (a documented layout), and does not name a root in facts.json
function rememberOutside(w) {
  writeJ(path.join(w.dir, 'config.json'), { ...readJ(path.join(w.dir, 'config.json')), root: fwd(w.outside) });
  writeJ(path.join(w.dir, 'facts.json'), { ...readJ(path.join(w.dir, 'facts.json')), root: null });
}
const page = (w) => fs.readFileSync(path.join(w.dir, 'dist', 'atlas.html'), 'utf8');

test('build --excerpts on the folder that holds the project quotes the code; without --excerpts nothing is quoted', () => {
  const w = toyProject('honest');
  let r = cli(['build', '--draft', '--no-place'], w.repo);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(!page(w).includes('if not raw.get(key)'));
  r = cli(['build', '--draft', '--no-place', '--excerpts'], w.repo);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(page(w).includes('if not raw.get(key)'), 'the source lines are in the page');
  assert.ok(!/excerpts left out/.test(r.err));
});

test('build --excerpts with a remembered root outside the project folder: no excerpts, the reason, and --source works', () => {
  const w = toyProject('setaside');
  rememberOutside(w);
  // the model cites a file of the outside folder by a plain relative path that facts.json lists: the gates are satisfied, only the folder is wrong
  const facts = readJ(path.join(w.dir, 'facts.json'));
  facts.modules.push({ path: 'secret.txt', lang: 'py', lines: 20, sha256: '0'.repeat(64), imports: [], externalImports: [], doc: '' });
  writeJ(path.join(w.dir, 'facts.json'), facts);
  const frag = path.join(w.dir, 'model', '10-intake.json'), m = readJ(frag);
  m.boxes[0].refs = [...m.boxes[0].refs, { path: 'secret.txt', line: 1 }];
  writeJ(frag, m);

  let r = cli(['build', '--draft', '--no-place', '--excerpts'], w.repo);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(!holds(page(w)) && !holds(r.out + r.err), 'no canary text in the page or the output');
  assert.match(r.err, /build: source excerpts left out\. This project remembers its code at .*outside the folder that holds the project/);
  assert.match(r.err, /pass {2}--source /);
  assert.ok(!page(w).includes('if not raw.get(key)'), 'no excerpts at all');

  // the person names the folder: that is theirs to quote
  r = cli(['build', '--draft', '--no-place', '--excerpts', '--source', w.outside], w.repo);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(holds(page(w)), 'a folder named with --source is quoted');
});

test('buildProject with excerpts and no root does not fall back to the root facts.json remembers', async () => {
  const w = toyProject('factsroot');
  const facts = readJ(path.join(w.dir, 'facts.json'));
  facts.root = fwd(w.outside);                                           // an older facts.json may hold an absolute root
  facts.modules.push({ path: 'secret.txt', lang: 'py', lines: 20, sha256: '0'.repeat(64), imports: [], externalImports: [], doc: '' });
  writeJ(path.join(w.dir, 'facts.json'), facts);
  const frag = path.join(w.dir, 'model', '10-intake.json'), m = readJ(frag);
  m.boxes[0].refs = [...m.boxes[0].refs, { path: 'secret.txt', line: 1 }];
  writeJ(frag, m);
  const r = await buildProject(w.dir, { draft: true, place: false, excerpts: true });
  assert.ok(!holds(fs.readFileSync(r.html, 'utf8')), 'nothing quoted from the remembered folder');
  const named = await buildProject(w.dir, { draft: true, place: false, excerpts: true, root: w.outside });
  assert.ok(holds(fs.readFileSync(named.html, 'utf8')), 'a root the caller names is quoted');
});

test('build --excerpts with a model that cites ../ is refused by G1, before anything is built', () => {
  const w = toyProject('dotdot');
  const facts = readJ(path.join(w.dir, 'facts.json'));
  facts.modules.push({ path: '../outside/secret.txt', lang: 'py', lines: 20, sha256: '0'.repeat(64), imports: [], externalImports: [], doc: '' });
  writeJ(path.join(w.dir, 'facts.json'), facts);
  const frag = path.join(w.dir, 'model', '10-intake.json'), m = readJ(frag);
  m.boxes[0].refs = [...m.boxes[0].refs, { path: '../outside/secret.txt', line: 1 }];
  writeJ(frag, m);
  const r = cli(['build', '--draft', '--no-place', '--excerpts'], w.repo);
  assert.equal(r.code, 1, r.err + r.out);
  assert.match(r.out, /REFUSE G1 cited path is outside the code folder/);
  assert.ok(!holds(r.out + r.err));
  assert.ok(!fs.existsSync(path.join(w.dir, 'dist', 'atlas.html')));
});

test('extract and signals ask for --source instead of reading a root the project remembers outside its folder', () => {
  const w = toyProject('nosource');
  rememberOutside(w);
  put(path.join(w.outside, 'leak.py'), `"""${CANARY} docstring"""\ndef leak():\n    return "${CANARY}"\n`);
  const before = fs.readFileSync(path.join(w.dir, 'facts.json'), 'utf8');
  for (const cmd of ['extract', 'signals']) {
    const r = cli([cmd], w.repo);
    assert.equal(r.code, 2, `${cmd}: ${r.err}${r.out}`);
    assert.match(r.err, /remembers its code at .*outside the folder that holds the project, so Faultline did not read there/, cmd);
    assert.ok(!holds(r.out + r.err), cmd);
  }
  assert.equal(fs.readFileSync(path.join(w.dir, 'facts.json'), 'utf8'), before, 'facts.json untouched');
  // with the folder named, it reads that folder (and only that)
  const r = cli(['extract', '--source', w.outside], w.repo);
  assert.equal(r.code, 0, r.err + r.out);
});

test('signals: facts.json that lists a module outside the root is not read (no parse error from the outside file)', () => {
  const w = toyProject('sigfacts');
  put(path.join(w.outside, 'leak2.py'), `def (broken ${CANARY}\n`);
  const facts = readJ(path.join(w.dir, 'facts.json'));
  facts.modules.push({ path: '../outside/leak2.py', lang: 'py', lines: 2, sha256: '0'.repeat(64), imports: [], externalImports: [], doc: '' });
  writeJ(path.join(w.dir, 'facts.json'), facts);
  const r = cli(['signals'], w.repo);
  assert.equal(r.code, 0, r.err + r.out);
  const sig = readJ(path.join(w.dir, 'signals.json'));
  assert.ok(sig.skipped.some((s) => s.path === '../outside/leak2.py' && /outside the source folder/.test(s.why)));
  assert.ok(!JSON.stringify(sig).includes('SyntaxError') && !holds(sig));
});

test('check on a project whose fragment is a link to a file that is not JSON prints nothing from that file', (t) => {
  const w = toyProject('checklink');
  put(path.join(w.outside, 'ssh_config'), `Host ${CANARY}.example\n  User nobody\n`);
  if (!link(path.join(w.outside, 'ssh_config'), path.join(w.dir, 'model', '96-heard-extra.json'), 'file')) return t.skip('cannot make a symbolic link on this machine');
  const r = cli(['check'], w.repo);
  assert.equal(r.code, 2, r.err + r.out);                                    // the whole project folder is refused: it holds a link
  assert.match(r.err, /holds a link \(model\/96-heard-extra\.json\)/);
  assert.ok(!holds(r.out + r.err));
  if (fs.existsSync(path.join(w.dir, 'receipts.json'))) assert.ok(!holds(fs.readFileSync(path.join(w.dir, 'receipts.json'), 'utf8')), 'receipts.json holds none of it');
});

// ---- resolveProject / mayQuoteCode ------------------------------------------------------------------------------------------------------

test('mayQuoteCode: the folder holding the project, one inside it, or one the person named; not a set-aside root, not where the person stands', () => {
  const w = world('may');
  const dir = path.join(w.repo, '.faultline');
  put(path.join(dir, 'facts.json'), JSON.stringify({ root: '..', modules: [] }));
  put(path.join(dir, 'census.json'), '{}');
  put(path.join(w.repo, 'sub', 'x.py'), '');
  const at = (cwd, opt = {}) => resolveProject({ project: dir, cwd, ...opt });

  assert.equal(mayQuoteCode(at(w.repo)), true, 'facts say .. : the folder that holds the project');
  assert.equal(at(w.repo).rootFrom, 'facts');
  put(path.join(dir, 'facts.json'), JSON.stringify({ root: null, modules: [] }));
  assert.equal(at(w.repo).rootFrom, 'guess');
  assert.equal(mayQuoteCode(at(w.repo)), true, 'a project named .faultline: its parent is the code folder');
  writeJ(path.join(dir, 'config.json'), { root: '../sub' });
  assert.equal(at(w.outer).rootFrom, 'config');
  assert.equal(mayQuoteCode(at(w.outer)), true, 'a folder inside the one that holds the project');
  writeJ(path.join(dir, 'config.json'), { root: '../../outside' });
  const aside = at(w.outer);
  assert.equal(aside.rootSetAside && fwd(aside.rootSetAside), fwd(w.outside));
  assert.equal(mayQuoteCode(aside), false, 'set aside');
  assert.match(rootSetAsideNote(aside), /--source/);
  assert.equal(mayQuoteCode(at(w.outer, { root: w.outside })), true, 'named with a flag');
  // a project folder with another name: the folder the person stands in is only a guess
  const odd = path.join(w.repo, 'mapfolder');
  put(path.join(odd, 'facts.json'), JSON.stringify({ root: null, modules: [] }));
  put(path.join(odd, 'census.json'), '{}');
  const p = resolveProject({ project: odd, cwd: w.outer });
  assert.equal(p.rootFrom, 'guess');
  assert.equal(mayQuoteCode(p), false, 'cwd is outside the folder that holds the project');
  assert.equal(mayQuoteCode(resolveProject({ project: odd, cwd: odd })), true, 'standing in the project folder itself');
});
