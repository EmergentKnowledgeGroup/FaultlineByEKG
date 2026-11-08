// apply (words only), the page overlay, and the command line.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { applyWords, recomputeGate, TITLE_MAX, PLAIN_MAX } from '../src/story/apply.mjs';
import { buildPage, overlayData } from '../src/story/page.mjs';
import { canonJson } from '../src/story/canon.mjs';
import { run, honest, withExtra, road, sref, scratch, MAP, ROOT, KIOSK, BIN } from './lib/story-kit.mjs';

const model = () => JSON.parse(fs.readFileSync(`${MAP}/model.json`, 'utf8'));
const ids = (kind) => model().boxes.filter((b) => b.kind === kind).map((b) => b.id);

test('apply: titles and sentences go beside the tool\'s phrase; nothing structural moves', () => {
  const [d1, d2] = ids('decision');
  const { model: m, report } = applyWords(MAP, { schema: 'x', by: 'weak-agent', words: { [d1]: { title: 'Is there a fare?', plain: 'Tests the route price.' }, [d2]: { title: 'Seats left?' } } });
  assert.equal(report.wordsAccepted, 3);
  assert.equal(report.boxesWithWords, 2);
  assert.equal(report.structureChanged, 0);
  assert.equal(report.overlayRefused, false);
  const base = model();
  const b1 = m.boxes.find((b) => b.id === d1);
  assert.deepEqual(b1.words, { by: 'weak-agent', title: 'Is there a fare?', plain: 'Tests the route price.' });
  assert.equal(b1.title, base.boxes.find((b) => b.id === d1).title, 'the tool phrase stays');
  assert.deepEqual(recomputeGate(base, m), []);
  assert.equal(canonJson(m.routes), canonJson(base.routes));
});

test('apply: the limits and refusals of the words path', () => {
  const [d1, d2, d3] = ids('decision');
  const long = 'x'.repeat(TITLE_MAX + 1), longPlain = 'y'.repeat(PLAIN_MAX + 1);
  const { report } = applyWords(MAP, {
    by: 'a', words: {
      [d1]: { title: long, plain: longPlain }, [d2]: { title: 'tab\there', plain: '   ' }, [d3]: { title: 42, colour: 'red' },
      'no.such.box': { title: 'Hello' }, [ids('end')[0]]: 'not a record',
    },
    delete: ['x'], boxes: [], claims: [{ from: d1, to: d2, witness: [{ kind: 'call', path: 'kiosk/sales.py', line: 36 }] }, null],
  });
  assert.equal(report.wordsAccepted, 0);
  assert.equal(report.boxesWithWords, 0);
  assert.ok(report.wordsRefused >= 6);
  assert.equal(report.forbidden, 3, 'two top-level keys and one field');
  assert.equal(report.claimsRefused, 2, 'roads are refused whatever the witness');
  assert.equal(report.structureChanged, 0);
  assert.ok(report.refusals.some((m) => /too long/.test(m)) && report.refusals.some((m) => /no such box/.test(m)) && report.refusals.some((m) => /takes no road/.test(m)));
});

test('apply: lint for duplicate titles, exit words on a decision, and words that vouch', () => {
  const [d1, d2] = ids('decision');
  const { report } = applyWords(MAP, { words: { [d1]: { title: 'Returns early', plain: 'The tool has verified this.' }, [d2]: { title: 'Returns early' } } });
  const codes = report.lint.map((x) => x[0]);
  assert.ok(codes.includes('W-dupe-title') && codes.includes('W-decision-titled-as-exit') && codes.includes('W-vouches') && codes.includes('W-decision-not-a-question'));
});

test('apply: the recompute gate catches a changed box, a changed road and a new key', () => {
  const base = model();
  const m = JSON.parse(JSON.stringify(base));
  m.boxes[0].kind = 'end';
  assert.ok(recomputeGate(base, m).some((x) => /changed/.test(x)));
  const m2 = JSON.parse(JSON.stringify(base)); m2.routes.pop();
  assert.ok(recomputeGate(base, m2).includes('roads changed'));
  const m3 = JSON.parse(JSON.stringify(base)); m3.extra = 1;
  assert.ok(recomputeGate(base, m3).some((x) => /top-level extra/.test(x)));
  assert.equal(applyWords(MAP, 5).report.overlayRefused, true);
});

test('apply: the same words give the same bytes', () => {
  const o = { by: 'a', words: { [ids('end')[0]]: { title: 'An ending' } } };
  assert.equal(canonJson(applyWords(MAP, o).model), canonJson(applyWords(MAP, o).model));
});

const PAGE = '<!doctype html><html><head><title>t</title></head><body><div id="canvas"></div></body></html>';

test('page: marks, counts and the switch are added once, and nothing in the overlay says "proven"', () => {
  const s = withExtra([], [road('x', 'look', 'hasfare', 'Only when the moon is full', [sref(36)]), road('lost', 'sold', 'look', '', [sref(52)])]);
  s.boxes[0].title = '</script><img src=x onerror=alert(1)>';
  const dir = scratch('page');
  fs.writeFileSync(`${dir}/check.json`, canonJson(run(s)));
  fs.writeFileSync(`${dir}/page.html`, PAGE);
  const a = buildPage(`${dir}/check.json`, `${dir}/page.html`);
  assert.equal((a.html.match(/<!--story-overlay-->/g) ?? []).length, 1);
  assert.ok(a.html.includes('id="sc-data"') && a.html.includes('Marks') && a.html.indexOf('<!--story-overlay-->') < a.html.lastIndexOf('</body>'));
  assert.ok(!/proven/i.test(a.html.slice(a.html.indexOf('<!--story-overlay-->'))), 'no "proven" in the overlay');
  assert.ok(!a.html.includes('</script><img'), 'agent text cannot close the script block');
  fs.writeFileSync(`${dir}/page2.html`, a.html);
  const b = buildPage(`${dir}/check.json`, `${dir}/page2.html`);
  assert.equal(b.html, a.html, 'running it again on its own output changes nothing');
  assert.equal(a.nRoads, 9);
  const data = overlayData(JSON.parse(fs.readFileSync(`${dir}/check.json`, 'utf8')));
  assert.equal(data.roads.lost.j, 'none');
  assert.equal(data.roads.x.j, '');
  assert.ok(data.roads.x.l.some((l) => l.k === 'words' && /not checked/.test(l.t)) && data.roads.x.l.some((l) => l.k === 'tool'));
  assert.ok(data.counts.find((c) => c.t === 'no link found').n >= 1);
});

test('command line: check writes the same bytes twice, refuses a duplicate id with exit 3, and a missing map with exit 4', () => {
  const dir = scratch('cli');
  const story = `${dir}/honest.json`;
  fs.writeFileSync(story, JSON.stringify(honest()));
  const go = (args) => spawnSync(process.execPath, [BIN, 'story', ...args], { encoding: 'utf8' });
  const a = go(['check', '--story', story, '--map', MAP, '--source', ROOT, '--out', `${dir}/a.json`, '--allow-stale']);
  const b = go(['check', '--story', story, '--map', MAP, '--source', ROOT, '--out', `${dir}/b.json`, '--allow-stale']);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(fs.readFileSync(`${dir}/a.json`, 'utf8'), fs.readFileSync(`${dir}/b.json`, 'utf8'));
  assert.match(a.stdout, /7 joined by the tool at the cited line/);
  const dup = honest(); dup.routes.push({ ...dup.routes[0] });
  fs.writeFileSync(`${dir}/dup.json`, JSON.stringify(dup));
  const c = go(['check', '--story', `${dir}/dup.json`, '--map', MAP, '--source', ROOT, '--out', `${dir}/c.json`, '--allow-stale']);
  assert.equal(c.status, 3);
  assert.match(c.stderr, /duplicate road id/);
  assert.ok(JSON.parse(fs.readFileSync(`${dir}/c.json`, 'utf8')).refused, 'a refused story gets no verdicts');
  const d = go(['check', '--story', story, '--map', `${dir}/nothing`, '--source', ROOT, '--out', `${dir}/d.json`]);
  assert.equal(d.status, 4);
  assert.equal(go([]).status, 2);
  const words = `${dir}/words.json`;
  fs.writeFileSync(words, JSON.stringify({ words: { [model().boxes[0].id]: { title: 'A title' } } }));
  const e = go(['apply', '--map', MAP, '--words', words, '--out', `${dir}/applied.json`, '--report', `${dir}/report.json`]);
  assert.equal(e.status, 0, e.stderr);
  assert.match(e.stdout, /structure changed: 0/);
});
