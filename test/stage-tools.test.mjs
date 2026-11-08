// Stage-scoped commands and the honest build: check --stage, place --stage while another stage's file is refused, build --draft with charts that
// have no layout, status after a build, join's counts, analyze's count line. Real command line, on copies of examples/toy in the temp folder.
//   node --test test/stage-tools.test.mjs      (about 30 s)
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), BIN = path.join(ROOT, 'bin', 'faultline.mjs');
const TOY = path.join(ROOT, 'examples', 'toy', '.faultline');
const cli = (args, dir) => { const r = spawnSync(process.execPath, [BIN, ...args, '--project', dir], { encoding: 'utf8', timeout: 240000 }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const jread = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function copy(withLayout = false) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-stage-')), '.faultline');
  fs.mkdirSync(path.join(dir, 'model'), { recursive: true });
  for (const f of ['facts.json', 'census.json', 'graph.json', 'config.json', 'dismissed.json']) fs.copyFileSync(path.join(TOY, f), path.join(dir, f));
  for (const f of fs.readdirSync(path.join(TOY, 'model'))) fs.copyFileSync(path.join(TOY, 'model', f), path.join(dir, 'model', f));
  if (withLayout) fs.cpSync(path.join(TOY, 'layout'), path.join(dir, 'layout'), { recursive: true });
  return dir;
}
const cleanup = (dir) => fs.rmSync(path.dirname(dir), { recursive: true, force: true });
// a second definition of an s_intake box, in a fragment of its own: the whole model is refused (G4), and only s_intake is to blame
const breakIntake = (dir) => {
  const m = jread(path.join(dir, 'model', '10-intake.json')), b = m.boxes[1];
  fs.writeFileSync(path.join(dir, 'model', '95-dup.json'), JSON.stringify({ schema: 'faultline.model/1', boxes: [{ ...b, title: 'A second box with the same id' }] }));
  return b.id;
};

test('check --stage: only this stage is judged, every offender is listed, and a refusal in another stage does not stop it', () => {
  const dir = copy();
  const dup = breakIntake(dir);
  let r = cli(['check'], dir);
  assert.equal(r.code, 1); assert.match(r.out, /REFUSE G4 duplicate box id/);
  assert.match(r.out, /counts by code: refuse G4 1/);
  r = cli(['check', '--stage', 's_work'], dir);
  assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /check --stage s_work/); assert.match(r.out, /other stages have \d+ refusals?/); assert.match(r.out, /s_work is clean/);
  assert.ok(!r.out.includes(dup), 'the other stage\'s offender is not listed here');
  r = cli(['check', '--stage', 's_intake'], dir);
  assert.equal(r.code, 1); assert.match(r.out, /REFUSE G4 duplicate box id: 1 in this stage/); assert.ok(r.out.includes(dup));
  r = cli(['check', '--stage', 's_nowhere'], dir);
  assert.equal(r.code, 2); assert.match(r.err, /No box is in stage s_nowhere/);
  cleanup(dir);
});

test('check --stage: ALL offenders are printed (no "and N more"); whole-project check prints counts per code', () => {
  const dir = copy();
  const work = jread(path.join(dir, 'model', '30-work.json')), ref = work.boxes.find((b) => b.stage === 's_work').refs;
  const boxes = [{ id: 'w.many', stage: 's_work', kind: 'step', status: 'live', title: 'Many exits', plain: 'x', refs: ref }, ...Array.from({ length: 14 }, (_, i) => ({ id: `w.t${i}`, stage: 's_work', kind: 'step', status: 'live', title: `Target ${i}`, plain: 'x', refs: ref }))];
  const routes = boxes.slice(1).map((b, i) => ({ id: `w.r${i}`, from: 'w.many', to: b.id, type: 'forward', when: '' }));
  fs.writeFileSync(path.join(dir, 'model', '35-many.json'), JSON.stringify({ schema: 'faultline.model/1', boxes, routes }));
  let r = cli(['check', '--stage', 's_work'], dir);
  assert.equal(r.code, 1, r.out + r.err); assert.match(r.out, /REFUSE G5 .*: 14 in this stage/);
  for (let i = 0; i < 14; i++) assert.ok(r.out.includes(`w.r${i}  w.many -> w.t${i}`), `offender w.r${i} is listed`);
  assert.ok(!/and \d+ more/.test(r.out), 'nothing is hidden behind "and N more"');
  r = cli(['check'], dir);
  assert.match(r.out, /counts by code: refuse G5 14/); assert.match(r.out, /receipts\.json lists every offender/);
  const rec = jread(path.join(dir, 'receipts.json'));
  assert.equal(rec.refusals.find((x) => x.code === 'G5').offenders.length, 14, 'receipts.json keeps every offender');
  cleanup(dir);
});

test('place --stage: works while another stage\'s fragment is refused, using only that stage\'s fragments; plain place refuses', () => {
  const dir = copy();
  breakIntake(dir);
  let r = cli(['place', '--budget', '2'], dir);
  assert.equal(r.code, 1); assert.match(r.out, /refused/);
  r = cli(['place', '--stage', 's_work', '--budget', '2'], dir);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /using only s_work's fragments/); assert.match(r.err, /\[1\/1\] stage_work: placing \d+ boxes, \d+ routes/);
  assert.match(r.err, /\[1\/1\] stage_work: .*\(\d+\.\d s\)/, 'per-chart seconds');
  assert.ok(fs.existsSync(path.join(dir, 'layout', 'stage_work.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'layout', 'overview.json')), 'only that stage\'s charts');
  r = cli(['place', '--stage', 's_work', '--budget', '2'], dir);
  assert.match(r.err, /layout is current/, 'a second run keeps the layout');
  cleanup(dir);
});

test('build --draft (and --no-place) builds with charts that have no layout and lists them; --finished refuses; status says the page is not finished', () => {
  const dir = copy();
  let r = cli(['build', '--draft', '--no-place'], dir);
  assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /build: DRAFT/); assert.match(r.out, /charts with no layout, listed on the page as not drawn \(7\)/);
  const html = fs.readFileSync(path.join(dir, 'dist', 'atlas.html'), 'utf8');
  const blob = JSON.parse(/<script type="application\/json" id="atlas-data">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(blob.meta.draft, true); assert.equal(blob.meta.unplaced.length, 7);
  assert.ok(blob.meta.notDrawn.items.some((i) => i.id === 'overview' && /no layout/.test(i.why)));
  assert.equal(blob.charts.overview.unplaced, true);
  r = cli(['build', '--no-place'], dir);
  assert.equal(r.code, 0, 'no-place alone also builds'); assert.match(r.out, /DRAFT/);
  r = cli(['build', '--finished', '--no-place'], dir);
  assert.equal(r.code, 1); assert.match(r.err, /No layout for chart\(s\)/);
  r = cli(['status'], dir);
  assert.match(r.out, /STATUS GATES PASS, NOT FINISHED/); assert.match(r.out, /charts placed: 0\/7/);
  cleanup(dir);
});

test('status: FINISHED only after place and build; a changed model makes the page out of date', () => {
  const dir = copy();
  let r = cli(['status'], dir);
  assert.match(r.out, /page: NOT BUILT/); assert.match(r.out, /STATUS GATES PASS, NOT FINISHED/);
  r = cli(['build', '--finished', '--budget', '2'], dir);
  assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /build: FINISHED/);
  r = cli(['status'], dir);
  assert.match(r.out, /^STATUS FINISHED/); assert.match(r.out, /page: built .*, current/);
  assert.ok(Math.ceil(r.out.length / 4) <= 200, 'under 200 tokens');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'model', '30-work.json'), later, later);
  r = cli(['status'], dir);
  assert.match(r.out, /^STATUS FINISHED/, 'a newer file time alone changes nothing'); assert.match(r.out, /page: built .*, current/);
  fs.appendFileSync(path.join(dir, 'model', '30-work.json'), ' ');
  r = cli(['status'], dir);
  assert.match(r.out, /NOT FINISHED/); assert.match(r.out, /OUT OF DATE \(model\/30-work\.json changed\)/);
  cleanup(dir);
});

test('join prints its counts; analyze says "N of M shown"', () => {
  const dir = copy();
  const model = jread(path.join(dir, 'model', '20-queue.json')), facts = jread(path.join(dir, 'facts.json'));
  const sym = Object.keys(facts.functions).find((s) => model.boxes.some((b) => b.refs && b.refs[0] && b.refs[0].symbol === s));
  const from = jread(path.join(dir, 'model', '10-intake.json')).boxes[0].id;
  fs.mkdirSync(path.join(dir, 'handoffs'));
  fs.writeFileSync(path.join(dir, 'handoffs', 'a.json'), JSON.stringify([{ from, toSymbol: sym, when: 'Hands over', why: 'x' }, { from, toSymbol: 'nowhere.py::none', when: 'Bad', why: 'x' }]));
  let r = cli(['join'], dir);
  assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /join: read 2 hand-offs, wrote 1 routes .* 1 unresolved, \d+ for review/);
  assert.ok(fs.existsSync(path.join(dir, 'handoffs.review.json')));
  r = cli(['analyze'], dir);
  assert.match(r.out, /analyze: \d+ of \d+ shown/);
  cleanup(dir);
});
