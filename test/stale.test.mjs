// `faultline status` says whether the code still matches the map: map/sources.json records what the readers took, and status compares it with the folder now.
// Every tree here is invented or copied from examples/toy, made in a folder of its own, and every run is a real command line.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capabilities } from './lib/map-helpers.mjs';
import { codeVsMap, codeCheck, SOURCES_SCHEMA } from '../src/map/stale.mjs';
import { codeLine } from '../src/agent/toolmap.mjs';
import { makeServer, TOOLS } from '../src/agent/mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'faultline.mjs');
const TOY = path.join(HERE, '..', 'examples', 'toy', 'parcelworks');       // nine small Python files that map to a real page
const cap = await capabilities();
const skipPy = !cap.python && 'no Python 3.10 or newer';
const sha = (x) => createHash('sha256').update(x).digest('hex');
let count = 0;

const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const fresh = (name) => path.join(os.tmpdir(), `fl-stale-${name}-${process.pid}-${count++}`).replace(/\\/g, '/');
const run = (args, cwd) => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 300000 }); return { ...r, all: `${r.stdout}\n${r.stderr}` }; };
const codeOf = (r) => (r.stdout.split('\n').find((l) => l.startsWith('code: ')) || '');

const CONFIG = 'parcelworks/config.py', REPORT = 'parcelworks/report.py', SCHEMA = 'parcelworks/schema.py';
const A = fs.readFileSync(path.join(TOY, 'config.py'), 'utf8');
const B = fs.readFileSync(path.join(TOY, 'report.py'), 'utf8');
const C = fs.readFileSync(path.join(TOY, 'schema.py'), 'utf8');

// One real map (page and all, as status needs) is made once; each test works on its own copy of the tree and its .faultline folder.
let mapped = null;
const mapOnce = () => {
  if (mapped) return mapped;
  const tree = fresh('base');
  fs.cpSync(TOY, `${tree}/parcelworks`, { recursive: true });
  const m = run(['map', '--source', tree, '--quiet'], tree);
  assert.equal(m.status, 0, m.all);
  return (mapped = tree);
};
const copyOfMapped = (name) => { const d = fresh(name); fs.cpSync(mapOnce(), d, { recursive: true }); return d; };

// ---- 1. the whole way: map, then change the code ---------------------------------------------------------------------------------------

test('status: matches; then one file edited, one added, one deleted, each named; the MCP tool says the same', { skip: skipPy }, async () => {
  const tree = copyOfMapped('tree');
  const rec = JSON.parse(fs.readFileSync(`${tree}/.faultline/map/sources.json`, 'utf8'));
  assert.equal(rec.schema, SOURCES_SCHEMA);
  assert.equal(Object.keys(rec.files).length, 9);
  assert.deepEqual(rec.files[CONFIG], { sha256: sha(A), size: Buffer.byteLength(A) });
  assert.equal(rec.walk.by, 'scan');

  const status = () => run(['status'], tree);
  let s = status();
  assert.equal(s.status, 0, s.all);
  assert.match(codeOf(s), /^code: matches the map \(9 files checked\)$/, s.all);
  assert.doesNotMatch(s.stdout, /code not checked/);

  put(`${tree}/${CONFIG}`, A + '# edited\n');                                              // 1 changed
  s = status();
  assert.match(codeOf(s), /^code: BEHIND the map: 1 changed \(parcelworks\/config\.py\)\. Run  faultline map --source \S+  to update\.$/, s.all);
  assert.match(s.stdout, /^next: update the map with the command above$/m, 'when the code is behind, the next step is the map again');
  assert.doesNotMatch(codeOf(s), /added|missing/);
  assert.ok(!s.stdout.includes('[cut'), 'status stays inside its token budget');

  put(`${tree}/${CONFIG}`, A);                                                             // back as it was: matches again
  assert.match(codeOf(status()), /^code: matches the map/);

  put(`${tree}/parcelworks/extra.py`, 'def four():\n    return 4\n');                      // 1 added
  s = status();
  assert.match(codeOf(s), /^code: BEHIND the map: 1 added \(parcelworks\/extra\.py\)\./, s.all);
  assert.doesNotMatch(codeOf(s), /changed|missing/);
  fs.rmSync(`${tree}/parcelworks/extra.py`);

  fs.rmSync(`${tree}/${SCHEMA}`);                                                          // 1 missing
  s = status();
  assert.match(codeOf(s), /^code: BEHIND the map: 1 missing \(parcelworks\/schema\.py\)\./, s.all);
  assert.doesNotMatch(codeOf(s), /changed|added/);
  put(`${tree}/${SCHEMA}`, C);

  // a folder skipped by default, and a file a map would not read, are not "added"
  put(`${tree}/node_modules/dep/x.py`, 'def x():\n    return 0\n'); put(`${tree}/notes.txt`, 'hello\n');
  assert.match(codeOf(status()), /^code: matches the map/);

  // the MCP tool gives the same line, made fresh on each call
  const srv = makeServer({ dir: `${tree}/.faultline` });
  const text = await srv.call('faultline_status');
  assert.match(text, /^code: matches the map \(9 files checked\)$/m, text);
  put(`${tree}/${REPORT}`, B + '# edited\n');
  const again = await srv.call('faultline_status');
  assert.match(again, /^code: BEHIND the map: 1 changed( \(parcelworks\/report\.py\))?\. Run  faultline map --source ".*" --project ".*\.faultline"  to update\.$/m, again);   // the name goes first when the budget is short (these paths are long)
  assert.ok(!again.includes('[cut'), again);
});

test('status: a project that sits away from its code is "not checked" and says how to fix it; --source answers', { skip: skipPy }, () => {
  const tree = copyOfMapped('away');
  const copy = fresh('copy');                                                              // the project folder moved away from the code, under another name
  fs.cpSync(`${tree}/.faultline`, copy, { recursive: true });
  const elsewhere = fresh('cwd'); fs.mkdirSync(elsewhere, { recursive: true });
  const s = run(['status', '--project', copy], elsewhere);
  assert.equal(s.status, 0, s.all);
  assert.match(codeOf(s), /^code: not checked \(.*--source <the code folder>/, s.all);
  const ok = run(['status', '--project', copy, '--source', tree], elsewhere);
  assert.match(codeOf(ok), /^code: matches the map \(9 files checked\)$/, ok.all);
  put(`${tree}/${REPORT}`, B + '# edited\n');
  assert.match(codeOf(run(['status', '--project', copy, '--source', tree], elsewhere)), /^code: BEHIND the map: 1 changed \(parcelworks\/report\.py\)\./);
});

// ---- 2. a record that is old, wrong, or someone else's ------------------------------------------------------------------------------------

test('no map/sources.json (a map from an older version): "not checked", and nothing is guessed', () => {
  const proj = fresh('old'), root = fresh('oldroot');
  put(`${root}/a.py`, A);
  fs.mkdirSync(`${proj}/map`, { recursive: true });
  const r = codeVsMap(proj, root);
  assert.equal(r.state, 'unknown');
  assert.match(r.why, /sources\.json/);
  assert.match(r.why, /faultline map/);
  assert.match(codeLine(r), /^code: not checked \(this map has no map\/sources\.json/);
  put(`${proj}/map/sources.json`, '{ not json');
  assert.equal(codeVsMap(proj, root).state, 'unknown');
  put(`${proj}/map/sources.json`, JSON.stringify({ schema: 'faultline.sources/0', files: {} }));
  assert.equal(codeVsMap(proj, root).state, 'unknown');
  put(`${proj}/map/sources.json`, JSON.stringify({ schema: SOURCES_SCHEMA, files: { 'a.py': { size: 'big', sha256: 'x' } } }));
  assert.equal(codeVsMap(proj, root).state, 'unknown', 'an entry that is not { size, sha256 } is not read');
  assert.equal(codeCheck({ dir: proj, root, rootKnown: false, rootSetAside: null }).state, 'unknown');
  assert.match(codeCheck({ dir: proj, root, rootKnown: false, rootSetAside: '/somewhere/else' }).why, /outside the folder that holds it/);
});

test('a recorded path that climbs out of the code folder is never opened: it is counted as outside, and nothing crashes', () => {
  const base = fresh('climb'), root = `${base}/code`, proj = `${base}/proj`;
  const outside = 'OUTSIDE_FILE_CANARY\n';
  put(`${root}/a.py`, A);
  put(`${base}/outside.txt`, outside);                                                    // a file whose size and hash are exactly what the record says: opened, it would match
  const entry = (text) => ({ size: text.length, sha256: sha(text) });
  put(`${proj}/map/sources.json`, JSON.stringify({ schema: SOURCES_SCHEMA, walk: { by: 'scan', include: [], exclude: [], noDefaults: false, languages: ['py'] }, files: {
    'a.py': { size: Buffer.byteLength(A), sha256: sha(A) }, '../outside.txt': entry(outside), '/etc/passwd': entry('x'), 'C:/Windows/win.ini': entry('x'),
    'a.py/../../outside.txt': entry(outside), 'sub\\..\\..\\outside.txt': entry(outside) } }));
  const r = codeVsMap(proj, root);
  assert.equal(r.state, 'behind');
  assert.equal(r.refused, 5, 'all five paths are refused');
  assert.deepEqual([r.changed, r.missing, r.added], [[], [], []]);
  assert.equal(r.checked, 1, 'only a.py was opened');
  const line = codeLine(r, 'faultline map --source X');
  assert.match(line, /^code: BEHIND the map: 5 paths outside the code folder, not opened\./);
  assert.ok(!line.includes('outside.txt') && !line.includes('passwd'), 'the refused names are not printed');
});

test('a walk in the record that names a folder outside the code folder is not run; the files are still compared', () => {
  const base = fresh('walk'), root = `${base}/code`, proj = `${base}/proj`;
  put(`${root}/a.py`, A); put(`${base}/lua/x.lua`, 'return 1\n');
  put(`${proj}/map/sources.json`, JSON.stringify({ schema: SOURCES_SCHEMA, walk: { by: 'config', lua: { prefix: '../lua' } }, files: { 'a.py': { size: Buffer.byteLength(A), sha256: sha(A) } } }));
  const r = codeVsMap(proj, root);
  assert.deepEqual(r.added, [], 'x.lua beside the code folder is not looked for');
  assert.equal(r.state, 'matches');
  assert.match(r.why, /files added since the map were not looked for/);
  assert.match(codeLine(r), /^code: matches the map \(1 file checked; files added since the map were not looked for/);
});

// ---- 3. the line stays small --------------------------------------------------------------------------------------------------------------

test('the code line caps the names it lists and stays well inside the status budget; names from a map of someone else carry no control characters', () => {
  const many = (p, n) => Array.from({ length: n }, (_, i) => `${p}/very/long/folder/name/for/a/module_${i}.py`);
  const code = { state: 'behind', changed: many('c', 40), added: many('a', 12), missing: many('m', 7), refused: 0, checked: 100, why: '' };
  const line = codeLine(code, 'faultline map --source /code');
  assert.ok(line.length <= 260, `${line.length} characters: ${line}`);
  assert.match(line, /^code: BEHIND the map: 40 changed, 12 added, 7 missing\. Run  faultline map --source \/code  to update\.$/);
  const small = codeLine({ state: 'behind', changed: ['a.py', 'b.py', 'c.py', 'd.py', 'e.py', 'f.py', 'g.py'], added: ['n.py'], missing: [], refused: 0, checked: 9, why: '' }, 'faultline map --source /code');
  assert.equal(small, 'code: BEHIND the map: 7 changed (a.py, b.py, c.py, d.py, e.py, +2 more), 1 added (n.py). Run  faultline map --source /code  to update.');
  const odd = codeLine({ state: 'behind', changed: ['x\u001b[31m\nred.py'], added: [], missing: [], refused: 0, checked: 1, why: '' });
  assert.ok(!/[\u0000-\u001f\u007f]/.test(odd), JSON.stringify(odd));
});

test('the MCP status tool says the code is compared with the map, not that it is never looked at', () => {
  const t = TOOLS.find((x) => x.name === 'faultline_status');
  assert.match(t.description, /whether the page and the code still match the map/);
  assert.doesNotMatch(t.description, /not re-checked/);
});
