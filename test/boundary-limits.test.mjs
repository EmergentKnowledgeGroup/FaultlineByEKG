// Two leftovers of the 0.1.1 boundary: a code folder that is only a guess is not read for a map someone else made, and a JSON file that does not parse is not quoted.
// Canary text is made up. Every run is a real command line in a folder of its own.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KIOSK, honest } from './lib/story-kit.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'faultline.mjs');
const CANARY = 'LIMCANARY_91d2_not_a_secret';
const sha = (x) => createHash('sha256').update(x).digest('hex');
let count = 0;

const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const fresh = (name) => { const d = path.join(os.tmpdir(), `fl-lim-${name}-${process.pid}-${count++}`).replace(/\\/g, '/'); fs.rmSync(d, { recursive: true, force: true }); return d; };
const run = (args, cwd) => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120000 }); return { ...r, all: `${r.stdout}\n${r.stderr}` }; };

// ---- 1. a guessed code folder ------------------------------------------------------------------------------------------------------------

const CALL = { type: 'declined', conf: 'not-confident', reason: 'effect-candidate', fn: 'x.py::run', path: '.env', line: 1, call: 'helper.save', effect: 'store', why: 'callee unknown' };

/** `guess/` is the folder the person stands in and holds a .env. `fmap/` is a map folder someone else made: its review index lists that .env (digest and all), and its story index is the kiosk's. */
function world() {
  const base = fresh('guess');
  const guess = `${base}/guess`;
  put(`${guess}/.env`, `TOKEN=${CANARY}\nsecond line\n`);
  const fmap = `${base}/fmap`;
  put(`${fmap}/model.json`, JSON.stringify({ schema: 'faultline.model/1', system: { name: 'toy' }, boxes: [], routes: [] }));
  put(`${fmap}/claims.json`, JSON.stringify([{ ...CALL, id: 'd:1' }]));
  put(`${fmap}/review-index.json`, JSON.stringify({ schema: 'fl.review-index/1', mods: ['.env'], fns: {}, classes: {}, source_digest: sha(`.env\0${sha(fs.readFileSync(`${guess}/.env`))}\n`) }));
  put(`${fmap}/story-index.json`, fs.readFileSync(`${KIOSK}/map/story-index.json`, 'utf8'));
  // a story that cites the .env, written by anyone
  const story = honest();
  story.boxes.push({ id: 'leak', stage: 'sell', kind: 'step', title: 'Reads a file', plain: 'Reads a file.', status: 'live', handle: '', refs: [{ path: '.env', symbol: '', line: 1 }] });
  put(`${base}/story.json`, JSON.stringify(story));
  return { base, guess, fmap, story: `${base}/story.json` };
}
const storyCheck = (w, more, cwd = w.guess) => run(['story', 'check', '--story', w.story, '--allow-stale', '--out', `${w.base}/check.json`, ...more], cwd);

test('no --source and the code folder only a guess: review and story check refuse a foreign map folder and a project not named .faultline, and quote nothing', () => {
  const w = world();
  // (a) --map names a folder that is not <project>/map
  const a = [run(['review', 'queue', '--map', w.fmap], w.guess), storyCheck(w, ['--map', w.fmap])];
  // (b) the project folder is not called .faultline and remembers no code folder: its map is inside it, the root is where the person stands
  for (const f of ['model.json', 'claims.json', 'review-index.json', 'story-index.json']) put(`${w.base}/proj/map/${f}`, fs.readFileSync(`${w.fmap}/${f}`, 'utf8'));
  const b = [run(['review', 'queue', '--project', `${w.base}/proj`], w.guess), storyCheck(w, ['--project', `${w.base}/proj`])];
  for (const r of [...a, ...b]) {
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /--source/, 'it asks for the code folder');
    assert.ok(!r.all.includes(CANARY), `no canary on screen: ${r.all}`);
  }
  assert.ok(!fs.existsSync(`${w.base}/check.json`), 'the story check wrote nothing');
  // the person naming the folder is the way through, as before
  const ok = run(['review', 'queue', '--map', w.fmap, '--source', w.guess], w.guess);
  assert.equal(ok.status, 0, ok.all);
});

test('no --source in a repo whose .faultline/map is its own: review queue and story check work as before', () => {
  const base = fresh('repo');
  const repo = `${base}/repo`;
  const code = 'import helper\ndef run(x):\n    helper.save(x)\n';
  put(`${repo}/a.py`, code);
  put(`${repo}/.faultline/map/model.json`, JSON.stringify({ schema: 'faultline.model/1', system: { name: 'toy' }, boxes: [], routes: [] }));
  put(`${repo}/.faultline/map/claims.json`, JSON.stringify([{ ...CALL, id: 'd:1', fn: 'a.py::run', path: 'a.py', line: 3 }]));
  put(`${repo}/.faultline/map/review-index.json`, JSON.stringify({ schema: 'fl.review-index/1', mods: ['a.py'], fns: { 'a.py::run': { line: 2, end: 3, qual: 'run', cls: null, calls: [] } }, classes: {}, source_digest: sha(`a.py\0${sha(code)}\n`) }));
  const q = run(['review', 'queue'], repo);
  assert.equal(q.status, 0, q.all);
  assert.match(q.stdout, /helper\.save\(x\)/, 'the lines of the mapped file are shown');
  const kiosk = `${base}/kiosk`;
  fs.cpSync(`${KIOSK}/src`, kiosk, { recursive: true });
  fs.cpSync(`${KIOSK}/map`, `${kiosk}/.faultline/map`, { recursive: true });
  put(`${base}/story.json`, JSON.stringify(honest()));
  const s = run(['story', 'check', '--story', `${base}/story.json`, '--out', `${base}/check.json`, '--allow-stale'], kiosk); // the fixture's digest is of LF files; a CRLF checkout differs
  assert.equal(s.status, 0, s.all);
  assert.match(s.stdout, /^Story against the tool map/);
});

// ---- 2. a file that is not JSON -----------------------------------------------------------------------------------------------------------

test('a project file that is not JSON is named and never quoted, by the commands that read it and by the catch-all', () => {
  const base = fresh('json');
  const junk = (file) => put(file, `${CANARY} and more words after it\n`);
  put(`${base}/code/a.py`, 'def run():\n    return 1\n');
  const cases = [];
  // map: <project>/config.json
  junk(`${base}/p1/config.json`);
  cases.push(['map config.json', run(['map', '--source', `${base}/code`, '--project', `${base}/p1`, '--no-page', '--quiet'], base), /config\.json/]);
  // build on a tool map: read/reading.json, when the page has no ask.json yet
  put(`${base}/p2/model/00-system.json`, JSON.stringify({ system: { toolMap: true } }));
  put(`${base}/p2/page/side.json`, '{}');
  put(`${base}/p2/read/charts.json`, '{}');
  put(`${base}/p2/read/words.json`, '{}');
  junk(`${base}/p2/read/reading.json`);
  cases.push(['build reading.json', run(['build', '--project', `${base}/p2`], base), /reading\.json/]);
  // evidence: facts.json, and a model.merged.json beside a good facts.json
  junk(`${base}/p3/facts.json`);
  cases.push(['evidence facts.json', run(['evidence', 'walks', '--project', `${base}/p3`], base), /facts\.json/]);
  put(`${base}/p4/facts.json`, '{}');
  junk(`${base}/p4/model.merged.json`);
  cases.push(['evidence model.merged.json', run(['evidence', 'walks', '--project', `${base}/p4`], base), /model\.merged\.json/]);
  // story page: the check file
  junk(`${base}/check.json`);
  put(`${base}/atlas.html`, '<html><body></body></html>');
  cases.push(['story page check file', run(['story', 'page', '--check', `${base}/check.json`, '--page', `${base}/atlas.html`, '--out', `${base}/out.html`], base), /check\.json/]);
  for (const [name, r, file] of cases) {
    assert.notEqual(r.status, 0, `${name}: ${r.all}`);
    assert.match(r.stderr, file, `${name}: it names the file`);
    assert.match(r.stderr, /not valid JSON/, name);
    assert.ok(!r.all.includes('LIMCANARY'), `${name}: nothing of the file, not even its first characters: ${r.all}`);
  }
  // anything else that parses JSON and lets the error through: the catch-all says only that, and where when V8 gives a place
  junk(`${base}/cfg.json`);
  const c = run(['map', '--source', `${base}/code`, '--project', `${base}/p5`, '--config', `${base}/cfg.json`, '--no-page', '--quiet'], base);
  assert.equal(c.status, 1, c.all);
  assert.match(c.stderr, /^faultline: a file is not valid JSON/);
  assert.ok(!c.all.includes('LIMCANARY'), c.all);
  put(`${base}/cfg.json`, '{"a": 1 "b": 2}\n');
  const d = run(['map', '--source', `${base}/code`, '--project', `${base}/p6`, '--config', `${base}/cfg.json`, '--no-page', '--quiet'], base);
  assert.match(d.stderr, /^faultline: a file is not valid JSON \(line 1, column \d+\)/, d.all);
});
