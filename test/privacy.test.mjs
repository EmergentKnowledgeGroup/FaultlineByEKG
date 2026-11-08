// A page or agent file made for sharing must carry nothing from the machine that built it or from the logs it imported:
// no home folder, no absolute path, no email, no host name, no token, no log text (unless --keep-messages asks for the text).
// Part 1: the scrubbers and importWalks. Part 2: the real command line on a copy of the toy that lives under a nasty path, with a nasty log.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importWalks, formatWalk, writeWalkFile, logsToWalk } from '../src/evidence/index.mjs';
import { scrubText, makeScrub, baseName } from '../src/evidence/scrub.mjs';
import { portableRoot, resolveRoot } from '../src/extract/root.mjs';
import { loadModelReport } from '../src/model/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..'), BIN = path.join(ROOT, 'bin', 'faultline.mjs'), TOY = path.join(ROOT, 'examples', 'toy');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-privacy-'));
after(() => { fs.rmSync(BASE, { recursive: true, force: true }); });
const slash = (p) => p.split(path.sep).join('/');
const cli = (args, cwd) => { const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', timeout: 300000 }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };

// everything a stranger's machine could leave behind
const HOME_DIR = 'zq-home-marker/Users/bobsmith/secretproj';
const SECRETS = ['bobsmith', 'Bob Smith', 'zq-home-marker', 'secretproj', 'alice@example.com', 'carol@corp.example.org', 'dave@corp.example.org', 'erin@secret.example', 'db-7.internal', 'abcdef0123456789abcdef0123456789',
  'order 4411', 'refund denied', 'blew up for'];
const ABS = [/\b[A-Za-z]:[\\/]{1,2}[A-Za-z]/, /\/(?:home|Users|root)\//, /\\\\(?:home|Users)\\\\/, /file:\/\/\/[A-Za-z~]/];
const leaks = (text) => [...SECRETS.filter((s) => text.includes(s)), ...ABS.filter((r) => r.test(text)).map(String)];

// ---------------------------------------------------------------------------------------------------------------- part 1
test('scrubText: absolute paths shrink to their base name, emails and secrets are masked, nothing is left long', () => {
  assert.equal(scrubText('open C:\\Users\\bob\\proj\\a.py:12 failed'), 'open a.py:12 failed');
  assert.equal(scrubText('see /home/bob/proj/a.py and ~/notes/b.txt'), 'see a.py and b.txt');
  assert.equal(scrubText('\\\\fileserver\\share\\bob\\c.py went'), 'c.py went');
  assert.equal(scrubText('read file:///C:/Users/bob/d.py'), 'read d.py');
  assert.equal(scrubText('mail bob.smith+x@corp.example.org now'), 'mail <email> now');
  assert.equal(scrubText('mail bob@corp.example.org now', { emails: false }), 'mail bob@corp.example.org now', 'with emails:false (kept messages) only paths are cut');
  assert.match(scrubText('token=abcdef0123456789abcdef0123456789 password: hunter2'), /token=<secret> password: <secret>/);
  assert.equal(scrubText('https://bob:pw@host.example/x'), 'https://<creds>@host.example/x');
  assert.equal(scrubText('GET /api/users'), 'GET /api/users', 'a one-or-two part URL path is not a machine path');
  assert.ok(scrubText('x'.repeat(500), { cap: 40 }).length <= 40);
  assert.equal(baseName('C:\\a\\b\\c.py'), 'c.py');
});

test('scrubText: a path after a colon is cut, and a home folder never leaves a person\'s name behind, spaces or not', () => {
  assert.equal(scrubText('end:/home/zqbobsmith/zqend'), 'end:zqend');
  assert.equal(scrubText('open:/home/bob/p/x.py then at:C:\\Users\\bob\\x.py'), 'open:x.py then at:x.py');
  assert.equal(scrubText('file:/home/bob/x.py'), 'x.py');
  assert.equal(scrubText('file:///C:/Users/Bob Smith/x.py'), 'x.py');
  assert.equal(scrubText('C:\\Users\\Bob Smith\\proj\\a.py failed'), 'a.py failed');
  assert.equal(scrubText('/Users/Bob Smith/Library/x.py'), 'x.py');
  assert.equal(scrubText('/mnt/c/Users/Bob Smith/x.py'), 'x.py');
  for (const home of ['/home/bob', '/home/bob/', '/Users/bob', 'C:\\Users\\Bob Smith', 'C:/Users/bob', 'file:///home/bob']) assert.equal(scrubText(home), '<home>', home);
  assert.equal(scrubText('cd /home/bob and then /tmp/x'), 'cd <home> and then x', 'a name without spaces ends where the words go on');
  assert.equal(scrubText('see http://host.example/a/b/c and GET /users/123'), 'see http://host.example/a/b/c and GET /users/123', 'URLs and URL paths are not machine paths');
  for (const p of ['~bob/x.py', 'C:\\Users\\Bob Smith\\z.py', '/home/bob smith/x.py']) assert.ok(!/Smith|smith|bob/.test(scrubText(p)), p);
  // folders with spaces that are not a home folder, and a company folder inside a home folder
  assert.equal(scrubText('C:/Dev/Bob Smith/proj/a.py failed'), 'a.py failed');
  assert.equal(scrubText('C:/Users/Bob Smith/OneDrive - Acme Corp/proj/a.py failed'), 'a.py failed');
  assert.equal(scrubText('/srv/My Project/src/x.py'), 'x.py');
  assert.equal(scrubText('failed C:/a/b.py and then C:/c/d.py'), 'failed b.py and then d.py', 'two paths in one line stay two paths');
  assert.equal(makeScrub({ resolve: null }).sym('C:\\Dev\\Bob Smith\\p\\x.py'), 'x.py', 'a bare absolute path where a symbol is expected is cut like a path');
});

test('scrubText: a home folder written without its leading slash, and a network share URL, lose the name too', () => {
  assert.equal(scrubText('../../home/bob/x.py'), 'x.py');
  assert.equal(scrubText('see ../../home/bob/x.py failed'), 'see x.py failed');
  assert.equal(scrubText('./Users/Bob Smith/proj/a.py'), 'a.py', 'spaces in the name are cut with it');
  assert.equal(scrubText('src/../../home/bob/x.py'), 'src/x.py');
  assert.equal(scrubText('Users\\bob\\x.py'), 'x.py');
  assert.equal(scrubText('open users\\Bob Smith\\docs\\q.txt now'), 'open q.txt now');
  assert.equal(scrubText('Users/bob/Library/x.py'), 'x.py');
  assert.equal(scrubText('smb://nas/share/bob/x.py'), 'x.py');
  assert.equal(scrubText('(cifs://srv/sh/bob/y.txt:12) failed'), '(y.txt:12) failed');
  assert.equal(scrubText('nfs://nas/export/bob/z.py, then'), 'z.py, then');
  for (const p of ['../../home/bob/x.py', 'Users\\bob\\x.py', 'smb://nas/share/bob/x.py', './Users/Bob Smith/proj/a.py']) assert.ok(!/bob|Bob|Smith|nas/.test(scrubText(p)), p);
  // what must stay: a relative path that merely has a "home" or "Users" part, and web URLs
  for (const keep of ['go home/away today', 'see src/home/page/a.ts', '../home/page.ts', '../src/a/b/c.ts', 'the Users/Groups screen', 'https://example.com/Users/bob/profile', 'http://host.example/a/b/c'])
    assert.equal(scrubText(keep), keep, keep);
});

test('scrubText: a share with forward slashes, a home folder named only by its steps up, and a short ssh remote lose the name', () => {
  assert.equal(scrubText('//nas/share/piper/x.py'), 'x.py');
  assert.equal(scrubText('opened //fileserver/data/piper/notes/y.txt:7 twice'), 'opened y.txt:7 twice');
  assert.equal(scrubText('git@host.example:piper/widgets.git'), 'widgets.git');
  assert.equal(scrubText('remote deploy@build.example.org:team/app/site.git failed'), 'remote site.git failed');
  assert.equal(scrubText('../../home/piper'), '<home>');
  assert.equal(scrubText('cwd ../../../Users/piper, then'), 'cwd <home>, then');
  for (const p of ['//nas/share/piper/x.py', 'git@host.example:piper/widgets.git', '../../home/piper']) assert.ok(!/piper/.test(scrubText(p)), p);
  // what must stay: a protocol-relative web address, a code comment, a project folder called home, a plain email, an address with a port
  for (const keep of ['<script src="//cdn.example.com/lib/a.js">', '// see the note above', '../home/page.ts', 'mail me@corp.example.org: soon', 'call host.example:8080/api'])
    assert.equal(scrubText(keep, { emails: false }), keep, keep);
});

test('scrubText: the secret shapes it claims to mask are masked', () => {
  const secret = ['Authorization: Bearer abc.def.ghi', 'Bearer abcdefghijklmnop', 'Basic dXNlcjpwYXNz', 'sk-abcdefghijklmnopqrstuvwxyz012345', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0123456789abcdef', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-1234567890-abcdefghij', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef', 'AIzaSyA-0123456789abcdefghijklmnopqrstuv',
    'client_secret=zzTopSecret1 access_token: zzTopSecret2 x-api-key: zzTopSecret3', '{"password":"zzTopSecret4"}', 'postgres://bob:zzTopSecret5@db.example/acme',
    '-----BEGIN RSA PRIVATE KEY-----\nzzTopSecret6\n-----END RSA PRIVATE KEY-----'];
  for (const c of secret) assert.ok(!/zzTopSecret|abc\.def|abcdefghijklmnop|dXNlcjpwYXNz|AKIAABCDEF|abcdefghijklmnopqrstuvwxyz012345|1234567890-abcdefghij|eyJhbGci|AIzaSy|11ABCDEFG/.test(scrubText(c)), `${c} -> ${scrubText(c)}`);
  assert.equal(scrubText('Authorization: Bearer abc.def.ghi'), 'Authorization: <secret>');
  assert.equal(scrubText('post https://hooks.slack.com/services/T000/B000/XXXXXXXX now'), 'post <webhook> now');
  assert.equal(scrubText('author: Bob'), 'author: Bob', 'only the named keys are values to hide');
});

test('makeScrub: a path that matches a module becomes the repo-relative form; one that matches nothing becomes its base name', () => {
  const sc = makeScrub({ resolve: (p) => (/parcelworks\/cli\.py$/.test(p) ? 'parcelworks/cli.py' : null), fns: { 'parcelworks/cli.py::main': {} } });
  assert.equal(sc.ref('C:\\Users\\bobsmith\\p\\parcelworks\\cli.py:20'), 'parcelworks/cli.py:20');
  assert.equal(sc.ref('/home/bobsmith/other/x.py:9'), 'x.py:9');
  assert.equal(sc.ref('../../outside/y.py:3'), 'outside/y.py:3');
  assert.equal(sc.sym('parcelworks/cli.py::main'), 'parcelworks/cli.py::main');
  assert.equal(sc.sym('/home/bobsmith/other/x.py::Thing.run'), 'x.py::Thing.run');
  assert.equal(sc.message('anything'), '', 'messages are dropped unless asked for');
  assert.equal(makeScrub({ resolve: null }, { keepMessages: true }).message('boom at /home/bob/x/y.py for a@b.example'), 'boom at y.py for a@b.example');
});

test('portableRoot: only ".." steps or null are ever written, and an older absolute root still reads', () => {
  const proj = path.join(BASE, 'p1', 'src', '.faultline');
  assert.equal(portableRoot(path.join(BASE, 'p1', 'src'), proj), '..');
  assert.equal(portableRoot(path.join(BASE, 'p1'), proj), '../..');
  assert.equal(portableRoot(proj, proj), '.');
  assert.equal(portableRoot(path.join(BASE, 'elsewhere'), proj), null, 'a project outside its source folder names no folder');
  assert.equal(portableRoot(null, proj), null);
  assert.equal(resolveRoot('..', proj), path.join(BASE, 'p1', 'src'));
  assert.equal(resolveRoot('Q:/old/absolute', proj), 'Q:/old/absolute');
  assert.equal(resolveRoot(null, proj), null);
});

function toyProject(name) {
  const dir = path.join(BASE, name, ...HOME_DIR.split('/'), '.faultline');
  fs.mkdirSync(path.join(dir, 'walks'), { recursive: true });
  const { model } = loadModelReport(path.join(TOY, '.faultline'));
  const facts = JSON.parse(fs.readFileSync(path.join(TOY, '.faultline', 'facts.json'), 'utf8'));
  facts.root = slash(path.dirname(dir));                                  // the machine's own folder, as extract used to write it
  return { dir, model, facts };
}
const nastyWalk = (root) => formatWalk({
  header: { tool: 'mytool for erin@secret.example', kind: 'run', pin: null },
  label: { label: 'SAMPLED', controls_passed: false, explored: [], unexplored: [{ at: 'parcelworks/report.py::publish', why: 'erin@secret.example did not run it from /home/bobsmith/x/y.py' }] },
  outcomes: [{
    outcome: 'error', strength: 'observed', reason: 'order 4411 refund denied for alice@example.com in C:\\Users\\bobsmith\\secretproj\\a.py', witness: null, count: 1,
    steps: [{ ref: `${root}/parcelworks/cli.py:14` }, { ref: 'C:\\Users\\bobsmith\\somewhere\\parcelworks\\jobqueue.py:77' },{ ref: '/home/bobsmith/x/y.py:5' },
      { sym: '/home/bobsmith/x/y.py::Thing.run' }, { tag: 'mail dave@corp.example.org' }, { ref: `${root}/nothing/here.py:1` }, { tag: 'C:\\Users\\Bob Smith\\p\\q.py' }],
  }, {
    outcome: 'end:/home/bobsmith/zqend', strength: 'observed', reason: 'ended', witness: null, count: 1, steps: [],
  }],
});

test('importWalks: a nasty walk gives an overlay with no path, email, host or message; the mapped steps still light their boxes', () => {
  const { dir, model, facts } = toyProject('t1');
  fs.writeFileSync(path.join(dir, 'walks', 'nasty.walk.jsonl'), nastyWalk(facts.root));
  const ov = importWalks(dir, model, facts);
  assert.deepEqual(leaks(JSON.stringify(ov)), []);
  assert.equal(ov.boxes['intake.submit']?.level, 'seen', 'an absolute path under the root still maps');
  assert.ok(ov.boxes['queue.claim'] || ov.summary.boxesWithEvidence >= 1);
  const keys = ov.notMapped.map((n) => n.key);
  assert.ok(keys.includes('y.py:5') && keys.includes('here.py:1') && keys.includes('q.py') && keys.includes('end:zqend'), 'a path that matches nothing is its base name, also after a colon and in a spaced home folder: ' + keys);
  assert.ok(ov.labels.every((l) => !/@/.test(l.tool)) && ov.unexplored.every((u) => !/@|bobsmith/.test(u.why + u.at)));
  assert.ok(Object.values(ov.boxes).every((b) => b.reasons.every((r) => !/refund|4411|alice/.test(r))));
});

test('importWalks: keepMessages keeps the words of a reason, still with no machine path', () => {
  const { dir, model, facts } = toyProject('t2');
  fs.writeFileSync(path.join(dir, 'walks', 'nasty.walk.jsonl'), nastyWalk(facts.root));
  const ov = importWalks(dir, model, facts, { keepMessages: true });
  const text = JSON.stringify(ov);
  assert.ok(text.includes('refund denied') && text.includes('alice@example.com'), 'the person asked for the message');
  assert.deepEqual(leaks(text).filter((x) => !['order 4411', 'refund denied', 'alice@example.com'].includes(x)), []);
});

test('logsToWalk: a step stores a repo-relative file and the message loses its machine path', () => {
  const { model, facts } = toyProject('t3');
  const line = JSON.stringify({ trace_id: 't', ts: 1, function: 'cmd_submit', file: `${facts.root}/parcelworks/cli.py`, line: 14, level: 'error', message: 'failed in C:\\Users\\bobsmith\\p\\a.py for alice@example.com' });
  const { walk } = logsToWalk(line, model, facts, {});
  const text = JSON.stringify(walk);
  assert.equal(walk.outcomes[0].steps[0].ref, 'parcelworks/cli.py:14');
  assert.ok(!/bobsmith|zq-home-marker|[A-Za-z]:[\\/]/.test(text), text);
  assert.match(walk.outcomes[0].reason, /failed in a\.py/);
});

// ---------------------------------------------------------------------------------------------------------------- part 2
function copyToy(name) {
  const dir = path.join(BASE, name, ...HOME_DIR.split('/'));
  const cp = (rel) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.copyFileSync(path.join(TOY, rel), path.join(dir, rel)); };
  for (const sub of ['parcelworks', 'web']) for (const f of fs.readdirSync(path.join(TOY, sub))) if (/\.(py|ts)$/.test(f)) cp(path.join(sub, f));
  cp('explorer_adapter.py'); cp('.faultline/config.json');
  for (const f of fs.readdirSync(path.join(TOY, '.faultline/model'))) cp(path.join('.faultline/model', f));
  return dir;
}
function scanDist(dir) {
  const found = {};
  const walkDir = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkDir(p); else if (!/\.png$/.test(e.name)) { const l = leaks(fs.readFileSync(p, 'utf8')); if (l.length) found[slash(path.relative(dir, p))] = l; } } };
  walkDir(dir);
  return found;
}

test('the real command line: a plain build, then a nasty log and walk, then a build: no machine path or log text reaches dist/ or the stored files', { timeout: 600000 }, () => {
  const dir = copyToy('cli1'), fl = path.join(dir, '.faultline'), run = (...a) => cli(a, dir);
  let r = run('extract');
  assert.equal(r.code, 0, r.out);
  for (const f of ['facts.json', 'signals.json']) {
    const t = fs.readFileSync(path.join(fl, f), 'utf8');
    assert.equal(JSON.parse(t).root, '..', `${f} remembers the source folder as ".." and names no folder`);
    assert.deepEqual(leaks(t), [], f);
  }
  r = run('build', '--draft', '--budget', '2');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(scanDist(path.join(fl, 'dist')), {}, 'a plain build embeds nothing of the machine it was built on');

  const root = slash(dir), abs = (f) => `${root}/${f}`;
  const rec = (o) => JSON.stringify(o);
  const log = [
    rec({ trace_id: 't1', ts: 1, function: 'cmd_submit', file: abs('parcelworks/cli.py'), line: 14, message: 'order 4411 for alice@example.com' }),
    rec({ trace_id: 't1', ts: 2, function: 'claim', file: abs('parcelworks/jobqueue.py'), line: 77, message: 'host db-7.internal token=abcdef0123456789abcdef0123456789' }),
    rec({ trace_id: 't1', ts: 3, function: 'no_such_fn', file: 'C:\\Users\\bobsmith\\other\\x.py', line: 9, level: 'error', message: 'refund denied: blew up for carol@corp.example.org in C:\\Users\\bobsmith\\other\\x.py' }),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(BASE, 'app.jsonl'), log);
  fs.writeFileSync(path.join(BASE, 'hand.walk.jsonl'), nastyWalk(root));
  r = run('evidence', 'import-logs', path.join(BASE, 'app.jsonl'), '--project', fl);
  assert.equal(r.code, 0, r.out);
  r = run('walk', 'add', path.join(BASE, 'hand.walk.jsonl'));
  assert.equal(r.code, 0, r.out);
  const stored = fs.readFileSync(path.join(fl, 'walks', 'logs-app.walk.jsonl'), 'utf8');
  assert.ok(!/bobsmith|zq-home-marker|[A-Za-z]:[\\/]/.test(stored), 'the stored log walk holds repo-relative files, not the machine path');
  // a walk added by hand is stored cleaned too: git does not ignore it, so it must hold no path, name, email or host (the words of the reason stay)
  const added = fs.readFileSync(path.join(fl, 'walks', 'hand.walk.jsonl'), 'utf8');
  assert.deepEqual(leaks(added).filter((x) => !['order 4411', 'refund denied'].includes(x)), [], 'walk add stores a cleaned copy');
  assert.ok(added.includes('refund denied') && added.includes('parcelworks/cli.py:14'), 'the reason words stay, and a path in the source folder becomes repo-relative');
  assert.ok(fs.readFileSync(path.join(BASE, 'hand.walk.jsonl'), 'utf8').includes('bobsmith'), 'the original file is left as it was');

  r = run('build', '--draft', '--budget', '2');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(scanDist(path.join(fl, 'dist')), {}, 'imported logs and walks add nothing private to the page, the agent file, the brief or the svgs');
  const agent = fs.readFileSync(path.join(fl, 'dist', 'atlas.agent.json'), 'utf8');
  assert.ok(agent.includes('"evidence"') && /logs-jsonl/.test(agent), 'the evidence is there, only the private parts are not');

  r = run('build', '--draft', '--budget', '2', '--keep-messages');
  assert.equal(r.code, 0, r.out);
  const kept = scanDist(path.join(fl, 'dist'));
  const bad = Object.values(kept).flat().filter((x) => !['order 4411', 'refund denied', 'blew up for', 'did not run it', 'alice@example.com', 'carol@corp.example.org', 'dave@corp.example.org', 'erin@secret.example'].includes(x));
  assert.deepEqual(bad, [], '--keep-messages brings back the words, never a path, host or token');
  assert.ok(Object.values(kept).flat().some((x) => /refund denied|blew up for/.test(x)), '--keep-messages puts the message in');
});

test('init: the starter .gitignore keeps walks made from logs out of git', () => {
  const dir = path.join(BASE, 'init1'); fs.mkdirSync(dir, { recursive: true });
  const r = cli(['init'], dir);
  assert.equal(r.code, 0, r.out);
  const gi = fs.readFileSync(path.join(dir, '.faultline', '.gitignore'), 'utf8');
  assert.match(gi, /walks\/logs-\*\.walk\.jsonl/); assert.match(gi, /walks\/spans-\*\.walk\.jsonl/); assert.match(gi, /layout\/\*\.geom\.json/);
});
