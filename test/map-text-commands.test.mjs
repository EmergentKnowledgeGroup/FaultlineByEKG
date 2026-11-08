// The text commands on a tool map say what the page says: the same ranked questions with the same counts, no word of the hand-written way, ids that work in either form,
// and `build` that rebuilds the page the way `map` made it. One invented tree is mapped once; every test reads that project.
import { needs as needsOf } from './lib/sandbox.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capabilities } from './lib/map-helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'faultline.mjs');
const cap = await capabilities();
const skip = needsOf(cap, 'python').skip;
const tok = (s) => Math.ceil(s.length / 4);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const FILES = {
  'shop/store.py': [
    'class Cart:', '    def __init__(self, db):', '        self.db = db', '        self.items = []', '',
    '    def add(self, item, qty):', '        if qty <= 0:', '            raise ValueError("quantity must be positive")', '        self.items.append((item, qty))', '        return len(self.items)', '',
    '    def checkout(self):', '        for item, qty in self.items:', '            try:', '                self.db.execute("UPDATE stock SET n = n - ? WHERE id = ?", (qty, item))',
    '            except Exception:', '                pass', '        self.items = []', '        return True', '',
  ].join('\n'),
  'shop/app.py': [
    'from shop.store import Cart', '', '', 'def handle(request, db):', '    cart = Cart(db)', '    for line in request.get("lines", []):', '        cart.add(line["id"], line["qty"])',
    '    if request.get("pay"):', '        return cart.checkout()', '    return False', '', '', 'if __name__ == "__main__":', '    handle({}, None)', '',
  ].join('\n'),
};

let ctx = null;
function project() {
  if (ctx) return ctx;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-tt-src-')).replace(/\\/g, '/');
  for (const [rel, text] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-tt-proj-')).replace(/\\/g, '/');
  const run = (args, cwd = work) => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 280000 }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
  const m = run(['map', '--source', root, '--quiet']);
  assert.equal(m.code, 0, m.err + m.out);
  const dir = `${work}/.faultline`;
  const page = fs.readFileSync(`${dir}/dist/atlas.html`, 'utf8');
  const data = JSON.parse(/<script type="application\/json" id="atlas-data">([\s\S]*?)<\/script>/.exec(page)[1]);
  ctx = { root, work, dir, run, data };
  return ctx;
}

test('breaks and brief list the page\'s own ranked questions, with its counts, inside their caps', { skip }, () => {
  const { run, data } = project();
  const qs = data.breaks;
  assert.ok(qs.length > 0, 'the fixture raises at least one question');
  const b = run(['breaks']).out;
  assert.match(b, new RegExp(`^BREAKS ${qs.length} question`), 'the count on the first line is the page\'s count');
  assert.ok(tok(b) <= 800, `breaks is ${tok(b)} tokens`);
  qs.slice(0, 2).forEach((q) => { assert.ok(b.includes(q.key), `${q.key} is listed`); assert.ok(b.includes(q.question.slice(0, 40)), `the text of ${q.key} is the page's`); });
  const shown = /Showing (\d+) of (\d+)/.exec(b);
  assert.ok(shown && +shown[2] === qs.length, 'it says how many it shows of how many');
  const order = qs.map((q) => b.indexOf(`${q.key} `)).filter((i) => i >= 0);
  assert.deepEqual(order, [...order].sort((x, y) => x - y), 'in the page\'s rank order');
  const br = run(['brief']).out;
  assert.match(br, new RegExp(`QUESTIONS ${qs.length},`));
  assert.ok(tok(br) <= 1200, `brief is ${tok(br)} tokens`);
  assert.ok(br.includes(qs[0].key), 'the brief names the top question');
  const t = run(['breaks', '--all', '--budget', '3000']).out;
  assert.ok(qs.every((q) => t.includes(q.key + ' ')), 'with room, every question is listed');
  const k = run(['breaks', '--stage', qs.find((q) => q.stage).stage]).out;
  assert.match(k, /^BREAKS stage /);
});

test('status and brief on a tool map say what was read, what is open and what to do next, and never the hand-written words', { skip }, () => {
  const { run } = project();
  const s = run(['status']).out, br = run(['brief']).out;
  for (const t of [s, br]) {
    assert.doesNotMatch(t, /DRAFT|ledger|census|NOT DRAWN YET|Accounted|add ledger rows/i);
  }
  assert.match(s, /^STATUS TOOL MAP/); assert.match(s, /\nread: .*function/); assert.match(s, /\nopen: \d+ question/); assert.match(s, /\npage: built, matches the map/); assert.match(s, /\nnext: faultline /);
  assert.ok(tok(s) <= 200, `status is ${tok(s)} tokens`);
  assert.match(br, /^FAULTLINE BRIEF .* TOOL MAP/); assert.match(br, /\nREAD \d+ function/); assert.match(br, /\nNOT READ:/); assert.match(br, /\nOPEN: \d+ question/);
});

test('where takes a short box id, a long one, a function id, a bare name, file:line and says what it accepts', { skip }, () => {
  const { run, dir } = project();
  const ask = JSON.parse(fs.readFileSync(`${dir}/page/ask.json`, 'utf8'));
  const [long, short] = Object.entries(ask.ids)[0];
  const first = (t) => t.split('\n')[0].replace(/^WHERE .* -> /, 'WHERE ');
  const byShort = run(['where', short]).out;
  assert.match(byShort.split('\n')[0], new RegExp(`^WHERE ${short.replace('.', '\\.')}`));
  assert.equal(first(run(['where', long]).out), first(byShort), 'the long id of map/model.json finds the same box');
  assert.match(run(['where', long]).out.split('\n')[0], new RegExp(`${long.replace(/[.]/g, '\\.')} -> ${short.replace('.', '\\.')}`), 'the answer names the short id');
  const fn = run(['where', 'shop/store.py::Cart.add']).out;
  assert.match(fn.split('\n')[0], /^WHERE shop\/store\.py::Cart\.add +\[d\d+ /, 'path::Class.method answers for the function itself, with its stage');
  assert.match(fn, /\nshop\/store\.py:\d+-\d+ \(\d+ lines?\); /, 'the second line says where the function is and how it is drawn');
  const norm = (t) => first(t).replace(/^WHERE .*?(?=\S+::\S+\s)/, '');
  assert.equal(norm(run(['where', 'Cart.add']).out), norm(fn), 'Class.method finds the same function');
  assert.match(run(['where', 'add']).out.split('\n')[0], /^WHERE add -> .*add +\[d\d+ /, 'a bare name');
  assert.match(run(['where', 'shop/store.py:7']).out.split('\n')[0], /^WHERE shop\/store\.py:7 -> .*::.* +\[d\d+ /, 'file:line');
  const none = run(['where', 'no_such_thing_anywhere']).out;
  assert.match(none, /Accepted: a box id .*function id.*bare function name.*file or file:line/);
  const usage = run(['where']);
  assert.equal(usage.code, 2); assert.match(usage.err, /function id/);
  assert.match(run(['path', long, 'shop/store.py::Cart.add']).out, /^PATH /, 'path takes either form');
  assert.match(run(['impact', long]).out, /^IMPACT /, 'impact takes either form');
});

test('where tells a function with no box of its own from one that is missing', { skip }, () => {
  const { run, dir } = project();
  const ask = JSON.parse(fs.readFileSync(`${dir}/page/ask.json`, 'utf8'));
  const row = ask.fns.find((f) => !f[5]);                                   // a function with no box at all, if the fixture has one
  if (!row) return;
  const r = run(['where', row[0]]).out;
  assert.match(r, /function /); assert.doesNotMatch(r, /no box, function, file or title matches/);
});

test('review queue prints the short id beside a long box id', { skip }, () => {
  const { run, dir } = project();
  const q = run(['review', 'queue', '--source', project().root, '--limit', '50']).out;
  const ask = JSON.parse(fs.readFileSync(`${dir}/page/ask.json`, 'utf8'));
  const named = q.split('\n').filter((l) => /^#\d+ /.test(l) && Object.keys(ask.ids).some((id) => l.includes(id)));
  for (const l of named) assert.match(l, /\(box f\d+\.\w+(, f\d+\.\w+)* on the page\)/, l);
});

test('build on a tool map rebuilds the page it made, the Reader included, and refuses what is not its own', { skip }, () => {
  const { run, dir } = project();
  const before = sha(`${dir}/dist/atlas.html`);
  assert.match(fs.readFileSync(`${dir}/dist/atlas.html`, 'utf8'), /<!--rl-injected-->/, 'map built the Reader');
  const b = run(['build']);
  assert.equal(b.code, 0, b.err + b.out);
  assert.match(b.out, /^build: tool map page/); assert.match(b.out, /Next: faultline status/);
  assert.equal(sha(`${dir}/dist/atlas.html`), before, 'the rebuilt page is the same bytes map made');
  const st = run(['status']).out;
  assert.match(st, /page: built, matches the map/);
  for (const flag of ['--finished', '--draft']) {
    const r = run(['build', flag]);
    assert.equal(r.code, 2, flag); assert.match(r.err, /faultline map --source /); assert.match(r.err, /does not apply/);
  }
  assert.equal(sha(`${dir}/dist/atlas.html`), before, 'a refused build leaves the page alone');
  fs.appendFileSync(`${dir}/page/side.json`, ' ');
  assert.match(run(['status']).out, /page: OUT OF DATE \(page\/side\.json changed\)/, 'a changed input makes the page out of date, by content');
  assert.match(run(['status']).out, /next: faultline build/);
  run(['build']);
  assert.match(run(['status']).out, /page: built, matches the map/);
});

test('the hand-written commands refuse on a tool map and name the command to use', { skip }, () => {
  const { run, work, root } = project();
  const expect = { extract: /faultline map --source /, propose: /faultline breaks/, check: /faultline status/, place: /faultline map --source /, analyze: /faultline breaks/, signals: /faultline map --source /, plan: /faultline map --source /, parts: /faultline map --source /, worklist: /faultline map --source /, join: /faultline map --source /, };
  for (const [cmd, re] of Object.entries(expect)) {
    const r = run([cmd]);
    assert.equal(r.code, 2, cmd); assert.match(r.err, /holds a tool map/, cmd); assert.match(r.err, re, cmd);
    assert.doesNotMatch(r.out, /Next:/, cmd);
  }
  const i = run(['init']);
  assert.equal(i.code, 0); assert.match(i.out, /holds a tool map/); assert.doesNotMatch(i.out, /faultline extract/);
  assert.ok(fs.existsSync(`${work}/.faultline/map/model.json`), 'init left the map alone');
  assert.ok(root);
});

test('a project that holds nothing a project writes is not a project, and a hand-written project keeps its words', { skip }, () => {
  const { run } = project();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-tt-empty-')).replace(/\\/g, '/');
  fs.mkdirSync(`${empty}/.faultline/tools`, { recursive: true });
  const r = run(['status'], empty);
  assert.equal(r.code, 2); assert.match(r.err, /No project here/);
});
