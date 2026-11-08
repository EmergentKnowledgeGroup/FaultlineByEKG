// The review and story commands against a map folder someone else made: no file outside the source folder is read, and none of its text reaches an output.
// Canary text is made up. A folder holds the code (`code/`), a file beside it (`outside.txt`) and the map files (`map/`) the commands are pointed at.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Src } from '../src/map/review.mjs';
import { checkAnswer } from '../src/map/review_check.mjs';
import { sourceDigest } from '../src/story/layer1.mjs';
import { checkStory } from '../src/story/check.mjs';
import { jsonWhere } from '../src/story/canon.mjs';
import { honest, MAP as KIOSK_MAP, ROOT as KIOSK_ROOT } from './lib/story-kit.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'faultline.mjs');
const CANARY = 'BOUNDARY_CANARY_5c1e_not_a_secret';
const sha = (x) => createHash('sha256').update(x).digest('hex');
let count = 0;

const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
/** The sum `map` records: sorted paths, each with the hash of its bytes. Read raw, the way an author of a hostile map folder would compute it. */
const digest = (root, rels) => sha([...rels].sort().map((r) => `${r}\0${sha(fs.readFileSync(path.join(root, r)))}\n`).join(''));
const link = (target, file) => { try { fs.symlinkSync(target, file, 'file'); return true; } catch { return false; } };

const CALL = { type: 'declined', conf: 'not-confident', reason: 'effect-candidate', fn: 'a.py::run', path: 'a.py', line: 3, call: 'helper.save', effect: 'store', why: 'callee unknown' };
const forged = (i, p) => ({ ...CALL, id: `d:forged${i}`, path: p, line: 1, call: 'CANARY.get' });

/** A code folder with one mapped file, a canary file outside it, an unmapped canary file inside it, and a map folder with a review index that may be altered. */
function world({ mods = ['a.py'], claims = [], digestOf = null, index = {} } = {}) {
  const base = path.join(os.tmpdir(), `fl-bnd-review-${process.pid}-${count++}`).replace(/\\/g, '/');
  fs.rmSync(base, { recursive: true, force: true });
  const root = `${base}/code`;
  put(`${root}/a.py`, 'import helper\ndef run(x):\n    helper.save(x)\n');
  put(`${root}/secrets.env`, `TOKEN=${CANARY}\n`);
  put(`${base}/outside.txt`, `${CANARY} outside\nsecond outside line\n`);
  const map = `${base}/map`;
  put(`${map}/model.json`, JSON.stringify({ schema: 'faultline.model/1', system: { name: 'toy' }, boxes: [], routes: [] }));
  put(`${map}/claims.json`, JSON.stringify([{ ...CALL, id: 'd:1' }, ...claims]));
  const sum = digestOf ?? (() => { try { return digest(root, mods); } catch { return sha(''); } })();
  put(`${map}/review-index.json`, JSON.stringify({ schema: 'fl.review-index/1', source_digest: sum, mods, fns: { 'a.py::run': { line: 2, end: 3, qual: 'run', cls: null, calls: [] } }, classes: {}, ...index }));
  const run = (args, cwd = base) => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' }); return { ...r, all: `${r.stdout}\n${r.stderr}` }; };
  return { base, root, map, run, review: (cmd, more = []) => run(['review', cmd, '--map', map, '--source', root, ...more]) };
}

test('a claim that names a file the map does not list gets no question, is counted, and its file is never read', () => {
  const w = world({ claims: [forged(1, '../outside.txt'), forged(2, 'secrets.env'), forged(3, '/etc/hosts')] });
  const r = w.review('queue', ['--limit', '50', '--out', `${w.base}/q.json`]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 claims named a file the map does not list/);
  assert.match(r.stdout, /q:d:1/, 'the claim about a listed file is still a question');
  assert.ok(!r.all.includes(CANARY), 'no canary on screen');
  assert.ok(!fs.readFileSync(`${w.base}/q.json`, 'utf8').includes(CANARY), 'no canary in the queue file');
});

test('a map with only honest claims prints no line about skipped ones', () => {
  const w = world();
  const r = w.review('queue');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/does not list/.test(r.stdout));
  assert.match(r.stdout, /helper\.save\(x\)/, 'the lines of a listed file are shown as before');
});

test('review refuses an index that lists a path leading outside the source folder, before it hashes anything', () => {
  for (const bad of ['../outside.txt', '..\\outside.txt', 'sub/../../outside.txt', '/etc/hosts', 'C:/Windows/win.ini', './a.py']) {
    const w = world({ mods: [bad], digestOf: 'f'.repeat(64), claims: [forged(1, bad)] });
    const r = w.review('queue');
    assert.equal(r.status, 1, `${bad}: ${r.all}`);
    assert.match(r.stderr, /not plain paths inside/, bad);
    assert.ok(!r.all.includes(CANARY), bad);
  }
});

test('review refuses an index that lists nothing, though the digest of nothing matches', () => {
  const w = world({ mods: [], claims: [forged(1, '../outside.txt')] });
  for (const cmd of ['queue', 'check', 'view']) {
    const r = w.review(cmd, cmd === 'check' ? ['--answers', `${w.base}/none.json`] : []);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /lists no source files/);
    assert.ok(!r.all.includes(CANARY));
  }
});

test('review refuses a listed file that is a link to a file outside the source folder, even when the digest was made from its bytes', (t) => {
  const w = world();
  if (!link(`${w.base}/outside.txt`, `${w.root}/b.py`)) { t.skip('cannot make a symbolic link on this machine'); return; }
  const mods = ['a.py', 'b.py'];
  const idx = JSON.parse(fs.readFileSync(`${w.map}/review-index.json`, 'utf8'));
  fs.writeFileSync(`${w.map}/review-index.json`, JSON.stringify({ ...idx, mods, source_digest: digest(w.root, mods) }));
  fs.writeFileSync(`${w.map}/claims.json`, JSON.stringify([{ ...CALL, id: 'd:1' }, forged(1, 'b.py')]));
  const r = w.review('queue');
  assert.equal(r.status, 1, r.all);
  assert.match(r.stderr, /not plain paths inside/);
  assert.ok(!r.all.includes(CANARY));
});

test('review check: a cite the text test refuses is never opened, whatever the separator', () => {
  const asked = [];
  const src = { lines: (p) => { asked.push(p); return null; } };
  const item = { item: 'q:x', template: 'hears', claims: ['c1'], answers: ['tells-someone-at-cited-line', 'tells-no-one', 'cannot-tell'], path: 'a.py', line: 9, subject: [] };
  const by = new Map([['c1', { conf: 'not-confident', pinned: false }]]);
  for (const cite of ['x\\..\\..\\outside.txt:1', '..\\outside.txt:1', 'a/..\\..\\outside.txt:1', 'C:/outside.txt:1', '/outside.txt:1', '../outside.txt:1', 'a\\b.py:1']) {
    const r = checkAnswer(item, { item: 'q:x', choice: 'tells-someone-at-cited-line', cite, quote: 'nothing like it' }, src, by);
    assert.equal(r.status, 'refused', cite);
    assert.equal(r.rule, 'cite', cite);
    assert.ok(!('line_text' in r), cite);
  }
  assert.deepEqual(asked, [], 'the reader was never asked for any of them');
});

test('review check: a refused answer stores nothing of the cited line, and only a listed file can be cited', () => {
  const w = world({ claims: [forged(1, '../outside.txt')] });
  const answers = [
    { item: 'q:d:1', choice: 'yes', cite: 'a.py:3', quote: 'no such words here' },            // a listed file, the quote is wrong
    { item: 'q:d:1', choice: 'yes', cite: 'secrets.env:1', quote: 'TOKEN=' },                  // inside the folder, not listed by the map
    { item: 'q:d:1', choice: 'yes', cite: 'x\\..\\outside.txt:1', quote: 'zzz-wrong' },         // backslashes out of the folder
    { item: 'q:d:1', choice: 'yes', cite: 'a.py:2', quote: 'def run(x):' },                     // an honest answer
  ];
  put(`${w.base}/answers.json`, JSON.stringify({ answers }));
  const r = w.review('check', ['--answers', `${w.base}/answers.json`, '--store', `${w.base}/store.json`]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /1 claim named a file the map does not list/);
  const store = fs.readFileSync(`${w.base}/store.json`, 'utf8');
  const res = JSON.parse(store).results;
  assert.deepEqual(res.map((x) => x.rule).slice(0, 3), ['quote', 'line-exists', 'cite']);
  assert.ok(res.slice(0, 3).every((x) => x.status === 'refused' && !('line_text' in x)));
  assert.ok(!store.includes(CANARY) && !store.includes('helper.save(x)'), 'no text of the lines asked about');
  assert.equal(res[3].status, 'cited-only');
  assert.equal(res[3].line_text, 'def run(x):', 'an answer that holds up still shows its line, as before');
});

test('Src opens only listed files, never one that leaves the folder through a link, and reads a file the way it always did', (t) => {
  const w = world();
  put(`${w.root}/bom.py`, '\ufeffx = 1\r\ny = 2\r\n');
  assert.deepEqual(new Src(w.root, ['bom.py']).lines('bom.py'), ['x = 1', 'y = 2', ''], 'byte order mark dropped, line endings read as newlines');
  assert.equal(new Src(w.root, ['a.py']).lines('secrets.env'), null, 'in the folder but not listed');
  assert.equal(new Src(w.root).lines('../outside.txt'), null);
  assert.equal(new Src(w.root).lines('..\\outside.txt'), null);
  if (link(`${w.base}/outside.txt`, `${w.root}/l.txt`)) assert.equal(new Src(w.root).lines('l.txt'), null, 'a link to a file outside');
  else t.diagnostic('no symbolic link on this machine: the link case was not run');
});

test('a map file that is not JSON is refused without quoting the start of it', () => {
  const w = world();
  put(`${w.map}/claims.json`, `${CANARY} and more words after it\n`);
  const r = w.review('queue');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read the claims/);
  assert.match(r.stderr, /not valid JSON/);
  assert.ok(!r.all.includes('BOUNDARY'), 'not even the first characters');
  assert.equal(jsonWhere(new SyntaxError('Unexpected token \'H\', "Host githu"... is not valid JSON')), 'not valid JSON');
  assert.equal(jsonWhere(new SyntaxError("Expected ',' or '}' after property value in JSON at position 8 (line 1 column 9)")), 'not valid JSON (line 1, column 9)');
});

test('a code folder the project remembers outside its own folder is named in the error, unless --source was given', () => {
  const w = world();
  const proj = `${w.base}/proj/.faultline`;
  put(`${proj}/config.json`, JSON.stringify({ root: '../../code' }));            // outside the folder holding .faultline
  for (const f of ['model.json', 'claims.json', 'review-index.json']) put(`${proj}/map/${f}`, fs.readFileSync(`${w.map}/${f}`, 'utf8'));
  const r = w.run(['review', 'queue', '--project', proj]);
  assert.equal(r.status, 2, r.all);
  assert.match(r.stderr, /is not under/);
  assert.match(r.stderr, /This project remembers its code at .*\/code, outside the folder that holds the project/);
  const ok = w.run(['review', 'queue', '--project', proj, '--source', w.root]);
  assert.equal(ok.status, 0, ok.all);
  const wrong = w.run(['review', 'queue', '--project', proj, '--source', `${w.base}/proj`]);
  assert.equal(wrong.status, 2);
  assert.ok(!/remembers its code/.test(wrong.stderr), 'a folder given with --source needs no such note');
});

// ---- story ------------------------------------------------------------------------------------------------------------------------

const kioskMap = (edit) => {
  const dir = path.join(os.tmpdir(), `fl-bnd-story-${process.pid}-${count++}`).replace(/\\/g, '/');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of ['model.json', 'claims.json', 'story-index.json']) put(`${dir}/${f}`, fs.readFileSync(`${KIOSK_MAP}/${f}`, 'utf8'));
  const idx = JSON.parse(fs.readFileSync(`${dir}/story-index.json`, 'utf8'));
  edit(idx);
  put(`${dir}/story-index.json`, JSON.stringify(idx));
  return dir;
};
const strict = (mapDir, root = KIOSK_ROOT) => checkStory(honest(), { mapDir, root, allowStale: false });

test('the freshness digest opens only plain paths inside the root, and a source file is hashed as it always was', () => {
  const w = world();
  const rels = ['kiosk/__init__.py', 'kiosk/ledger.py', 'kiosk/printer.py', 'kiosk/sales.py'];
  assert.equal(sourceDigest(KIOSK_ROOT, rels), digest(KIOSK_ROOT, rels));
  for (const bad of ['../outside.txt', '..\\outside.txt', '/etc/hosts', 'C:/Windows/win.ini', 'a.py/../a.py']) assert.equal(sourceDigest(w.root, [bad]), null, bad);
  assert.equal(sourceDigest(w.root, ['a.py', 'nothere.py']), null, 'a missing file is not a digest');
  if (link(`${w.base}/outside.txt`, `${w.root}/l.txt`)) assert.equal(sourceDigest(w.root, ['l.txt']), null, 'a link to a file outside');
});

test('story check: a map that cannot be compared with the code is refused as stale, unless --allow-stale', () => {
  const w = world();
  const cases = {
    'no digest': (i) => { delete i.source_digest; },
    'lists no file': (i) => { i.files = {}; i.source_digest = sha(''); },
    'lists a path outside the root, digest made from its bytes': (i) => { i.files = { '../outside.txt': { lines: 1, lang: 'py' } }; i.source_digest = sha(`../outside.txt\0${sha(fs.readFileSync(`${w.base}/outside.txt`))}\n`); },
    'lists a file that is not there': (i) => { i.files = { ...i.files, 'kiosk/gone.py': { lines: 1, lang: 'py' } }; },
  };
  for (const [name, edit] of Object.entries(cases)) {
    const dir = kioskMap(edit);
    const r = strict(dir, name.includes('outside') ? w.root : KIOSK_ROOT);
    assert.equal(r.refused?.[0]?.code, 'M-stale', name);
    const allowed = checkStory(honest(), { mapDir: dir, root: name.includes('outside') ? w.root : KIOSK_ROOT, allowStale: true });
    assert.ok(!allowed.refused, name);
    assert.equal(allowed.map.fresh, null, name);
    assert.ok(!JSON.stringify(allowed).includes(CANARY), name);
  }
});

test('story apply: a model.json that is not a tool model is refused whole, and nothing of it is written', () => {
  const w = world();
  put(`${w.map}/model.json`, JSON.stringify({ boxes: [{ id: 'x', note: CANARY }] }));
  put(`${w.base}/words.json`, JSON.stringify({ words: {} }));
  const r = w.run(['story', 'apply', '--words', `${w.base}/words.json`, '--map', w.map, '--project', `${w.base}/proj`, '--out', `${w.base}/applied.json`]);
  assert.equal(r.status, 4, r.all);
  assert.match(r.stderr, /not a tool model/);
  assert.ok(!r.all.includes(CANARY));
  assert.ok(!fs.existsSync(`${w.base}/applied.json`));
});
