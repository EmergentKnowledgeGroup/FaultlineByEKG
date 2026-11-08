// The file boundary: text from a file outside the source folder must reach no output, whatever leads to it.
// One test per route (a link in the code, a map or project folder somebody else made, an agent's answers, an opt-in flag). Each plants a fake canary
// file outside a temporary source folder, runs the real command line, and looks for the canary in what the commands printed and in every file they
// wrote under the project, map and page folders. The honest tests run the same commands on plain files inside the folder and expect the text to come through.
import { needs } from './lib/sandbox.mjs';                    // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capabilities } from './lib/map-helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'faultline.mjs'), TOY = path.join(here, '..', 'examples', 'toy', 'parcelworks'), KIOSK = path.join(here, 'fixtures', 'story', 'kiosk');
const NEEDS_MAP = needs(await capabilities(), 'python', 'checker');
const NO_LINK = 'this machine will not make a symbolic link here (no permission)';
const TOKEN = 'CANARY-FLB';                                    // every line of every planted file carries it

// ---- what is planted ------------------------------------------------------------------------------------------------------------------
const SMALL = {                                                // five files; lonely_token has no caller, and the test that names it is not mapped by a top-level glob
  'app.py': 'import json\nfrom store import save, load\n\n\ndef main():\n    data = load("data.json")\n    data["n"] = data.get("n", 0) + 1\n    save("data.json", data)\n    print("ok")\n\n\nif __name__ == "__main__":\n    main()\n',
  'store.py': 'import json\n\n\ndef load(path):\n    try:\n        with open(path) as f:\n            return json.load(f)\n    except Exception:\n        return {}\n\n\ndef save(path, data):\n    try:\n        with open(path, "w") as f:\n            json.dump(data, f)\n    except OSError:\n        pass\n',
  'tokens.py': 'def lonely_token(x):\n    return x * 3\n\n\ndef helper(x):\n    return x * 2\n',
  'worker.py': 'import queue\nimport threading\n\njobs = queue.Queue()\n\n\ndef run(handler):\n    while True:\n        item = jobs.get()\n        try:\n            handler(item)\n        except Exception:\n            pass\n        finally:\n            jobs.task_done()\n\n\ndef start(handler):\n    t = threading.Thread(target=run, args=(handler,), daemon=True)\n    t.start()\n    return t\n',
  'tests/test_tokens.py': 'from tokens import lonely_token\n\n\ndef test_token():\n    assert lonely_token(1) == 3\n',
};
const SECRET = [                                               // valid Python, so a mapper that follows a link to it reads it as code; the name on line 2 is the one SMALL leaves without a caller
  '# CANARY-FLB-1 this file lives outside the source folder', 'lonely_token = "CANARY-FLB-OUTSIDE"', 'def lonely_token(): pass  # CANARY-FLB-3',
  ...[4, 5, 6, 7, 8, 9, 10].map((n) => `SECRET_LINE_${n} = "CANARY-FLB-${n}"`), '# CANARY-FLB-11', '# CANARY-FLB-12', 'def outside_sink():  # CANARY-FLB-13', '    print("CANARY-FLB-IN-A-FUNCTION-BODY")', '',
].join('\n');
const README = '# CANARY-FLB Hidden Notes\n\nCANARY-FLB-PURPOSE this system hands parcels to carriers and keeps a ledger of every parcel it has ever seen for its owners.\n';
const DOC_QUEUE = '# Queue\n\nA Queue is a CANARY-FLB-DOC-QUEUE line of jobs that wait there until a worker is free to take the next one.\n';
const DOC_WORKER = '# Worker\n\nA Worker is a CANARY-FLB-DOC-WORKER process that takes one job at a time from the queue and does it.\n';
const PKG = '{"name":"CANARY-FLB-pkg","description":"CANARY-FLB-PKG-DESC a ledger that keeps track of every parcel for the people who send them"}\n';
const PYPROJECT = '[project]\nname = "CANARY-FLB-pyname"\ndescription = "CANARY-FLB-PY-DESC a ledger that keeps track of every parcel for the people who send them"\n';
const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');   // the digest of a map that lists no files

// ---- small tools ----------------------------------------------------------------------------------------------------------------------
const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const putAll = (dir, files) => { for (const [rel, text] of Object.entries(files)) put(path.join(dir, rel), text); };
const getJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const putJson = (file, obj) => put(file, JSON.stringify(obj, null, 1) + '\n');
const cli = (args, cwd) => { const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 }); return { args: args.join(' '), code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
/** A link at `at` to `target`; false when this machine will not make one. */
function link(target, at, kind = 'file') {
  try { fs.symlinkSync(target, at, kind); return true; } catch (e) {
    if (kind === 'dir') { try { fs.symlinkSync(target, at, 'junction'); return true; } catch { /* the same refusal */ } }
    if (/^(EPERM|EACCES|ENOSYS|UNKNOWN)$/.test(e.code)) return false;
    throw e;
  }
}

/** box/repo holds src/ (the source folder) and .faultline/ (the project); box/outside holds what must never be read; box/in holds what the test hands over. */
function newBox() {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-bnd-'));
  const b = { box, repo: mk(box, 'repo'), src: mk(box, 'repo', 'src'), outside: mk(box, 'outside'), inp: mk(box, 'in') };
  b.project = path.join(b.repo, '.faultline');
  b.secret = path.join(b.outside, 'secret.txt');
  return b;
}
const plant = (b) => put(b.secret, SECRET);

/** Where the canary shows up: the lines the commands printed and every real file under `dirs` (links are not followed). [] when nowhere. */
function leaks(runs, dirs) {
  const hits = [];
  for (const r of [].concat(runs)) {
    if (r.out.includes(TOKEN)) hits.push(`what  faultline ${r.args}  printed`);
    if (r.err.includes(TOKEN)) hits.push(`what  faultline ${r.args}  printed as an error`);
  }
  const walk = (d, root) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, root);
      else if (e.isFile() && fs.readFileSync(p).includes(TOKEN)) hits.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  };
  for (const d of dirs) walk(d, d);
  return hits;
}
const noLeak = (runs, dirs) => assert.deepEqual(leaks(runs, dirs), [], 'text of a file outside the source folder reached these outputs');

// An honest map is made once per kind and copied for each test that crafts something from it.
const made = {};
const smallRepo = (b) => putAll(b.src, SMALL);
const toyRepo = (b) => fs.cpSync(TOY, path.join(b.src, 'parcelworks'), { recursive: true });
function clone(kind) {
  if (!made[kind]) {
    const t = newBox();
    (kind === 'toy' ? toyRepo : smallRepo)(t);
    const r = cli(['map', '--source', 'src'], t.repo);
    if (!fs.existsSync(path.join(t.project, 'map', 'model.json'))) throw new Error(`the ${kind} map the tests start from was not made: ${(r.out + r.err).slice(-400)}`);
    made[kind] = t;
  }
  const b = newBox();
  fs.cpSync(made[kind].repo, b.repo, { recursive: true });
  return b;
}
/** The review queue of a made map, as the real command gives it (the items of --out). */
function queue(b, extra = []) {
  const r = cli(['review', 'queue', '--source', 'src', '--out', 'q.json', ...extra], b.repo);
  return { r, items: fs.existsSync(path.join(b.repo, 'q.json')) ? getJson(path.join(b.repo, 'q.json')).items : [] };
}
/** The map's own files, to be changed by the test: claims.json (a list), review-index.json. */
const mapFile = (b, name) => path.join(b.project, 'map', name);
const notConfident = (claims) => claims.filter((c) => c.conf === 'not-confident');
/** Point the first box that cites code at `refPath`, and list that file in facts.json (so the gate that checks a cited file is a mapped one is satisfied). */
function aimRef(b, refPath) {
  const dir = path.join(b.project, 'model');
  let done = false;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    if (done) break;
    const m = getJson(path.join(dir, f));
    for (const bx of m.boxes ?? []) if (!done && Array.isArray(bx.refs) && bx.refs.length) { bx.refs[0] = { ...bx.refs[0], path: refPath, line: 1 }; done = true; }
    if (done) putJson(path.join(dir, f), m);
  }
  assert.ok(done, 'a box with a ref was found in the project model');
  const facts = getJson(path.join(b.project, 'facts.json'));
  facts.modules.push({ path: refPath, lang: 'py', lines: 14, sha256: '0'.repeat(64), imports: [], externalImports: [], doc: '' });
  putJson(path.join(b.project, 'facts.json'), facts);
}

// ==== the detector and the honest runs ===================================================================================================
test('the scan sees the canary in printed lines and in written files, and does not follow links', (t) => {
  const b = newBox();
  assert.deepEqual(leaks({ args: 'x', out: 'a', err: 'b' }, [b.repo]), []);
  assert.equal(leaks({ args: 'x', out: `a ${TOKEN}`, err: '' }, []).length, 1);
  assert.equal(leaks({ args: 'x', out: '', err: `${TOKEN}` }, []).length, 1);
  put(path.join(b.project, 'map', 'q.json'), `{"text":"${TOKEN}-1"}`);
  assert.deepEqual(leaks([], [b.repo]), ['.faultline/map/q.json']);
  const fresh = newBox();
  plant(fresh);
  if (!link(fresh.secret, path.join(fresh.repo, 'seen.txt'))) return t.skip(NO_LINK);
  assert.deepEqual(leaks([], [fresh.repo]), [], 'a link in a scanned folder is not read through');
});

test('honest folder: a plain file inside the source folder is mapped, quoted in the review queue, mirrored, and a good answer on it is accepted', NEEDS_MAP, () => {
  const b = newBox();
  smallRepo(b);
  plant(b);
  fs.copyFileSync(b.secret, path.join(b.src, 'helpers_link.py'));          // the same text the link tests lead to, here an ordinary file in the folder
  const sha = 'a'.repeat(40);
  put(path.join(b.src, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  put(path.join(b.src, '.git', 'refs', 'heads', 'main'), sha + '\n');
  const m = cli(['map', '--source', 'src', '--python', '*.py'], b.repo);
  const { r: q, items } = queue(b);
  assert.ok(fs.existsSync(path.join(b.project, 'map', 'model.json')), `the map was made: ${m.out}${m.err}`);
  assert.match(q.out, /helpers_link\.py:2 \| lonely_token = "CANARY-FLB-OUTSIDE"/, 'a line of a file in the folder is quoted as before');
  assert.equal(q.code, 0);
  assert.equal(getJson(path.join(b.project, 'facts.json')).pin.git, sha, 'the commit is read from a plain .git folder');
  const it = items.find((i) => i.path === 'tokens.py');
  assert.ok(it, 'the question about the uncalled function is in --out');
  const answers = put(path.join(b.inp, 'answers.json'), JSON.stringify({ answers: [{ item: it.item, choice: it.answers.find((a) => /^(not|none|no)/.test(a)) ?? it.answers[1], cite: 'app.py:6', quote: 'load("data.json")' }] }));
  const c = cli(['review', 'check', '--source', 'src', '--answers', answers, '--store', 'checked.json'], b.repo);
  const got = getJson(path.join(b.repo, 'checked.json')).results[0];
  assert.notEqual(got.status, 'refused', `a cite of a file in the folder with a quote it holds is not refused: ${JSON.stringify(got)} ${c.err}`);
  assert.match(String(got.line_text), /load\("data\.json"\)/);
});

test('honest folder: a plain README, docs page and mapped file inside the source folder reach the brief, the glossary and where, as before', NEEDS_MAP, () => {
  const b = newBox();
  toyRepo(b);
  put(path.join(b.src, 'README.md'), README);
  put(path.join(b.src, 'docs', 'queue.md'), DOC_QUEUE);
  put(path.join(b.src, 'parcelworks', 'helpers_link.py'), SECRET);
  const m = cli(['map', '--source', 'src', '--python', 'parcelworks/*.py'], b.repo);
  const w = cli(['where', 'outside_sink'], b.repo);
  assert.equal(m.code, 0, m.out + m.err);
  assert.match(fs.readFileSync(path.join(b.project, 'dist', 'BRIEF.md'), 'utf8'), /CANARY-FLB-PURPOSE/, 'the README paragraph is the purpose');
  assert.match(fs.readFileSync(path.join(b.project, 'read', 'reading.json'), 'utf8'), /CANARY-FLB-DOC-QUEUE/, 'a docs sentence defines the term');
  assert.match(w.out, /CANARY-FLB-IN-A-FUNCTION-BODY/, 'where reads the function of the mapped file');
  assert.equal(cli(['where', 'Queue.claim'], b.repo).code, 0);
});

// ==== route 1: a file link in the code, and a language flag that lets the mapper walk to it =============================================
test('route 1: a file link in the source and --python "*.py": the file it leads to is not mapped, quoted in the review queue, or copied into the map', NEEDS_MAP, (t) => {
  const b = newBox();
  smallRepo(b);
  plant(b);
  if (!link(b.secret, path.join(b.src, 'helpers_link.py'))) return t.skip(NO_LINK);
  const m = cli(['map', '--source', 'src', '--python', '*.py'], b.repo);
  const { r: q } = queue(b);
  assert.ok(fs.existsSync(path.join(b.project, 'map', 'model.json')), `the map is still made: ${m.out}${m.err}`);
  assert.match(q.out, /lonely_token/, 'the question about the uncalled function is still asked');
  noLeak([m, q], [b.repo]);
});

test('route 1: a file link in the source and a --python glob on a map that builds a page: the page, the reading and where do not carry the file it leads to', NEEDS_MAP, (t) => {
  const b = newBox();
  toyRepo(b);
  plant(b);
  if (!link(b.secret, path.join(b.src, 'parcelworks', 'helpers_link.py'))) return t.skip(NO_LINK);
  const m = cli(['map', '--source', 'src', '--python', 'parcelworks/*.py'], b.repo);
  const w = cli(['where', 'outside_sink'], b.repo);
  const ok = cli(['where', 'Queue.claim'], b.repo);
  assert.ok(fs.existsSync(path.join(b.project, 'dist', 'atlas.html')), `the page is still built: ${m.out}${m.err}`);
  assert.equal(ok.code, 0, 'an honest name is still answered');
  noLeak([m, w, ok], [b.repo]);
});

// ==== route 2 and 3: a map folder somebody else made =====================================================================================
test('route 2: a claim whose path climbs out of the source folder: the review queue does not quote the file', NEEDS_MAP, () => {
  const b = clone('small');
  plant(b);
  const ctl = queue(b);
  assert.ok(ctl.items.length > 0, 'the untouched map gives questions');
  const claims = getJson(mapFile(b, 'claims.json'));
  const out = '../../outside/secret.txt';                       // from src/
  const base = claims.find((c) => c.template === 'absence' && c.conf === 'not-confident');
  assert.ok(base, 'the map has a swallowed-handler claim to forge from');
  for (const c of notConfident(claims)) c.path = out;
  for (const ln of [2, 11]) claims.push({ ...base, id: `f:swallowed_known_failure_unknown:forged:${ln}:0`, path: out, line: ln, fn: 'nope::nope', subject: `nope:${ln}` });   // more claims read more of the file
  putJson(mapFile(b, 'claims.json'), claims);
  const q = queue(b);
  noLeak([q.r], [b.repo]);
});

test('route 3: a forged index that lists no files and carries the digest of "no files": the review queue does not quote the file a claim names', NEEDS_MAP, () => {
  const b = clone('small');
  plant(b);
  const claims = getJson(mapFile(b, 'claims.json'));
  for (const c of notConfident(claims)) c.path = '../../outside/secret.txt';
  putJson(mapFile(b, 'claims.json'), claims);
  const index = getJson(mapFile(b, 'review-index.json'));
  index.mods = [];
  index.source_digest = EMPTY_DIGEST;                           // the check compares the folder with this very file, and an empty list of files always matches
  putJson(mapFile(b, 'review-index.json'), index);
  const q = queue(b);
  noLeak([q.r], [b.repo]);
});

// ==== route 4: an agent's answers ========================================================================================================
test('route 4: review check cites with a Windows "..", and a planted link: the answers store and review view hold none of the line', NEEDS_MAP, (t) => {
  const b = clone('small');
  plant(b);
  if (!link(b.secret, path.join(b.src, 'helpers_link.py'))) return t.skip(NO_LINK);
  const { r: q, items } = queue(b);
  const it = items.find((i) => i.answers.length >= 2);
  assert.ok(it, `the queue has a question to answer: ${q.out}${q.err}`);
  const cites = ['x\\..\\..\\..\\outside\\secret.txt:2', '..\\..\\outside\\secret.txt:2', '../../outside/secret.txt:2', 'helpers_link.py:2', 'helpers_link.py:4'];
  const answers = put(path.join(b.inp, 'answers.json'), JSON.stringify({ answers: it.answers.flatMap((choice) => cites.map((cite) => ({ item: it.item, choice, cite, quote: 'zzz-not-on-the-line' }))) }));
  const c = cli(['review', 'check', '--source', 'src', '--answers', answers, '--store', 'checked.json'], b.repo);
  const v = cli(['review', 'view', '--source', 'src', '--store', 'checked.json'], b.repo);
  noLeak([q, c, v], [b.repo]);
});

// ==== routes 5 and 6: what the reading takes from the folder by default ==================================================================
test('route 5: README.md that is a link out, default flags: the page, BRIEF.md, atlas.agent.json and the brief do not carry its words', NEEDS_MAP, (t) => {
  const b = newBox();
  toyRepo(b);
  put(path.join(b.outside, 'readme_secret.md'), README);
  if (!link(path.join(b.outside, 'readme_secret.md'), path.join(b.src, 'README.md'))) return t.skip(NO_LINK);
  const m = cli(['map', '--source', 'src'], b.repo);
  const br = cli(['brief'], b.repo);
  assert.ok(fs.existsSync(path.join(b.project, 'dist', 'atlas.agent.json')), `the page is still built: ${m.out}${m.err}`);
  assert.ok(br.out.length > 100, 'the brief is still given');
  noLeak([m, br], [b.repo]);
});

test('route 5: package.json or pyproject.toml that is a link out: the reading does not take its name or description', NEEDS_MAP, (t) => {
  for (const [name, text] of [['package.json', PKG], ['pyproject.toml', PYPROJECT]]) {
    const b = newBox();
    smallRepo(b);
    put(path.join(b.outside, name), text);
    if (!link(path.join(b.outside, name), path.join(b.src, name))) return t.skip(NO_LINK);
    const m = cli(['map', '--source', 'src', '--no-page'], b.repo);
    assert.ok(fs.existsSync(path.join(b.project, 'read', 'reading.json')), `${name}: the reading is still made: ${m.out}${m.err}`);
    assert.deepEqual(leaks([m], [b.repo]), [], `${name} is a link to a file outside the source folder`);
  }
});

test('route 6: a docs folder that is a link out, and a docs page that is: the glossary and examples do not take their sentences', NEEDS_MAP, (t) => {
  const b = newBox();
  toyRepo(b);
  put(path.join(b.outside, 'docs_a', 'queue.md'), DOC_QUEUE);
  put(path.join(b.outside, 'worker_page.md'), DOC_WORKER);
  if (!link(path.join(b.outside, 'docs_a'), path.join(b.src, 'doc'), 'dir')) return t.skip(NO_LINK);
  mk(b.src, 'docs');
  if (!link(path.join(b.outside, 'worker_page.md'), path.join(b.src, 'docs', 'worker.md'))) return t.skip(NO_LINK);
  const m = cli(['map', '--source', 'src', '--no-page'], b.repo);
  assert.ok(fs.existsSync(path.join(b.project, 'read', 'reading.json')), `the reading is still made: ${m.out}${m.err}`);
  noLeak([m], [b.repo]);
});

// ==== route 7: the .git folder ===========================================================================================================
// facts.json is written by  extract  (a hand-made project, no checker needed) and by  map  (one case below); both read the commit with the same code.
const GIT_CASES = {
  'a .git folder whose HEAD says "ref: ../../../outside/secret.txt"': (b) => put(path.join(b.src, '.git', 'HEAD'), 'ref: ../../../outside/secret.txt\n'),
  'a .git pointer file that names a folder outside': (b) => { put(path.join(b.outside, 'gitdir', 'HEAD'), SECRET); put(path.join(b.src, '.git'), 'gitdir: ../../outside/gitdir\n'); },
  'a .git folder whose HEAD is a link out': (b) => { mk(b.src, '.git'); return link(b.secret, path.join(b.src, '.git', 'HEAD')); },
};
for (const [what, plantGit] of Object.entries(GIT_CASES)) {
  test(`route 7: ${what}: extract does not write the file it names into facts.json`, (t) => {
    const b = newBox();
    smallRepo(b);
    plant(b);
    if (plantGit(b) === false) return t.skip(NO_LINK);
    const i = cli(['init'], b.repo);
    const x = cli(['extract', '--root', 'src'], b.repo);
    assert.ok(fs.existsSync(path.join(b.project, 'facts.json')), `the facts are still written: ${x.out}${x.err}`);
    noLeak([i, x], [b.repo]);
  });
}
test('route 7: a .git folder whose HEAD names a file outside: map does not put it in facts.json or the page', NEEDS_MAP, () => {
  const b = newBox();
  smallRepo(b);
  plant(b);
  GIT_CASES['a .git folder whose HEAD says "ref: ../../../outside/secret.txt"'](b);
  const m = cli(['map', '--source', 'src', '--no-page'], b.repo);
  assert.ok(fs.existsSync(path.join(b.project, 'facts.json')), `the facts are still written: ${m.out}${m.err}`);
  noLeak([m], [b.repo]);
});

// ==== route 8: the project folder says where the code is =================================================================================
test('route 8: config.json root sent outside, with a forged index: a bare "review queue" does not quote that folder', NEEDS_MAP, () => {
  const b = clone('small');
  plant(b);
  const cfg = getJson(path.join(b.project, 'config.json'));
  putJson(path.join(b.project, 'config.json'), { ...cfg, root: '../../outside' });         // from .faultline/
  const claims = getJson(mapFile(b, 'claims.json'));
  for (const c of notConfident(claims)) c.path = 'secret.txt';
  putJson(mapFile(b, 'claims.json'), claims);
  const index = getJson(mapFile(b, 'review-index.json'));
  index.mods = [];
  index.source_digest = EMPTY_DIGEST;
  putJson(mapFile(b, 'review-index.json'), index);
  const q = cli(['review', 'queue', '--out', 'q.json'], b.repo);
  noLeak([q], [b.repo]);
});

test('route 8: config.json root sent outside: story check does not echo a line of a file there', () => {
  const b = newBox();
  plant(b);
  fs.cpSync(path.join(KIOSK, 'map'), path.join(b.project, 'map'), { recursive: true });
  putJson(path.join(b.project, 'config.json'), { include: [], exclude: [], root: '../../outside' });
  const story = getJson(path.join(KIOSK, 'honest.json'));
  story.boxes.push({ id: 'leak', stage: 'sell', kind: 'step', title: 'Reads a file', plain: 'Reads a file.', status: 'live', handle: '', refs: [{ path: 'secret.txt', symbol: '', line: 2 }, { path: 'secret.txt', symbol: '', line: 14 }] });
  const file = putJson(path.join(b.inp, 'story.json'), story);
  const s = cli(['story', 'check', '--story', file, '--out', 'check.json', '--allow-stale'], b.repo);
  noLeak([s], [b.repo]);
});

test('route 8: config.json root sent outside: build --excerpts does not copy lines of a file there into the page', NEEDS_MAP, () => {
  const b = clone('toy');
  plant(b);
  const cfg = getJson(path.join(b.project, 'config.json'));
  putJson(path.join(b.project, 'config.json'), { ...cfg, root: b.outside.replace(/\\/g, '/') });   // an absolute path
  aimRef(b, 'secret.txt');
  const r = cli(['build', '--excerpts'], b.repo);
  assert.ok(fs.existsSync(path.join(b.project, 'dist', 'atlas.html')), 'the page is still there');
  noLeak([r], [b.repo]);
});

// ==== route 9: --excerpts with a path that climbs out ====================================================================================
test('route 9: build --excerpts with a box ref that climbs out of the source folder: the page does not carry the file', NEEDS_MAP, () => {
  const b = clone('toy');
  plant(b);
  aimRef(b, '../../outside/secret.txt');                       // from src/
  const r = cli(['build', '--excerpts', '--root', 'src'], b.repo);
  assert.ok(fs.existsSync(path.join(b.project, 'dist', 'atlas.html')), 'the page is still there');
  noLeak([r], [b.repo]);
});
