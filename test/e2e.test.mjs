// End to end and integration tests for src/build, src/agent and bin/faultline.
//   Part 1: charts, atlas data, the page assembler, no network.          Part 2: agent commands under their token budgets, the MCP server.
//   Part 3: the whole pipeline on a copy of examples/toy through the real command line: extract, propose, check (draft gaps, then finished),
//           place, build, coverage import, walk add, brief, where, breaks, path, impact, status, analyze, look (only with FAULTLINE_E2E_BROWSER=1).
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chartsFromModel, homeChart, toAtlasData, assemble } from '../src/build/index.mjs';
import { agentData, BUDGET } from '../src/agent/index.mjs';
import * as C from '../src/agent/commands.mjs';
import { makeModel } from '../src/place/synth.mjs';
import { makeAtlasData } from '../viewer/fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..'), BIN = path.join(ROOT, 'bin', 'faultline.mjs'), TOY = path.join(ROOT, 'examples', 'toy');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `fl-e2e-${n}-`));
const tok = (s) => Math.ceil(s.length / 4);
const cli = (args, cwd, input) => { const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', input, timeout: 300000 }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };

// ============================================================ part 1: charts and atlas data
const model = (o) => { const m = makeModel(o); m.schema = 'faultline.model/1'; m.loops = m.loops || []; m.terms = []; m.ledger = {}; m.modules = {}; return m; };

test('chartsFromModel: overview, a chart per stage, whole; a stage above 21 boxes is split at a seam into parts of at most 21', () => {
  const m = model({ stages: 3, perStage: 50, seed: 4 });
  const charts = chartsFromModel(m);
  assert.deepEqual(charts.map((c) => c.kind).filter((k, i, a) => a.indexOf(k) === i), ['overview', 'stage', 'whole']);
  const parts = charts.filter((c) => c.kind === 'stage');
  assert.ok(parts.length > 3, 'a 50-box stage must be split: ' + parts.length);
  for (const c of parts) assert.ok(c.boxes.length <= 21, `${c.id} has ${c.boxes.length}`);
  for (const s of m.stages) assert.equal(parts.filter((c) => c.stage === s.id).reduce((n, c) => n + c.boxes.length, 0), m.boxes.filter((b) => b.stage === s.id).length, 'every box of the stage is in exactly one part');
  assert.equal(charts.find((c) => c.kind === 'whole').boxes.length, m.boxes.length);
  assert.equal(new Set(charts.map((c) => c.id)).size, charts.length, 'chart ids are unique');
  assert.ok(homeChart(charts, m.boxes[0].id).startsWith('stage_'), 'a box opens its stage chart, not the whole map');
  assert.deepEqual(chartsFromModel(m).map((c) => c.id), charts.map((c) => c.id), 'deterministic');
});

test('chartsFromModel: the overview aggregates hand-offs and groups endings by outcome; a small stage is not split', () => {
  const m = model({ stages: 4, perStage: 8, seed: 2 });
  const ov = chartsFromModel(m)[0];
  assert.equal(ov.kind, 'overview');
  for (const s of m.stages) assert.ok(ov.boxes.some((b) => b.id === s.id && b.synth === 'stage'));
  assert.ok(ov.routes.length > 0 && ov.routes.every((r) => r.id.startsWith('o:') && r.from !== r.to));
  assert.ok(ov.boxes.some((b) => b.kind === 'end'), 'endings are summarised on the overview');
  assert.equal(chartsFromModel(m).filter((c) => c.kind === 'stage').length, 4);
});

test('toAtlasData: nav, sections, flow, hand-offs with a why on both sides, stage and loop regions, spine, draft banner', () => {
  const m = model({ stages: 4, perStage: 10, seed: 3 });
  m.loops = [{ id: 'l1', title: 'A loop', blurb: '', boxes: [m.boxes[1].id, m.boxes[2].id, m.boxes[3].id], limit: '' }];
  const charts = chartsFromModel(m);
  const gaps = { state: 'draft', items: [], tally: { endings: { total: 9, required: 9, accounted: 2 }, branches: { total: 5, required: 5, accounted: 5 }, modules: { total: 3, cited: 2, excluded: 0, uncited: 1 } }, notDrawn: { endings: { count: 7, ids: [] }, branches: { count: 0, ids: [] }, modules: { count: 1, ids: ['src/x.py'] } } };
  const d = toAtlasData(m, { charts, gaps });
  assert.deepEqual(Object.keys(d.charts), charts.map((c) => c.id));
  assert.equal(d.meta.draft, true);
  assert.deepEqual(d.meta.census.endings, { total: 9, accounted: 2 });
  assert.equal(d.meta.notDrawn.count, 8);
  assert.ok(d.nav.length >= 2 && d.sections.length >= 5);
  const all = Object.values(d.charts), cross = m.routes.filter((r) => homeChart(charts, r.from) !== homeChart(charts, r.to));
  assert.ok(cross.length > 0);
  const ports = all.flatMap((c) => c.portals), r0 = cross[0];
  const out = ports.find((p) => p.route === r0.id && p.dir === 'out'), inn = ports.find((p) => p.route === r0.id && p.dir === 'in');
  assert.ok(out && inn, 'a cross-chart route becomes a portal on both sides');
  assert.equal(out.node, r0.from); assert.equal(inn.node, r0.to); assert.equal(out.chart, homeChart(charts, r0.to)); assert.ok(out.why.length > 5 && out.label.length > 0);
  const whole = d.charts.whole;
  assert.equal(whole.kind, 'whole');
  assert.ok(whole.regions.filter((r) => r.kind === 'stage').length === 4 && whole.regions.some((r) => r.kind === 'loop' && r.limit === ''));
  assert.ok(Array.isArray(whole.spine) || m.paths.length === 0);
  for (const c of all) for (const p of c.portals) assert.ok(d.charts[p.chart], 'every portal points at a real chart');
  assert.ok(Object.values(d.charts.overview.nodes).every((n) => n.refs !== undefined && n.title.length <= 40));
});

test('assemble: one self-contained page, no network, source excerpts only when asked, stand-alone SVG per chart', async () => {
  const data = await makeAtlasData();
  const out = tmp('asm');
  const r = assemble(data, out);
  const html = fs.readFileSync(r.html, 'utf8');
  assert.equal(r.svgs.length, Object.keys(data.charts).length);
  assert.ok(!/<script[^>]*\ssrc=|<link[^>]*\shref=["']?https?:|@import|fetch\(\s*["']http/i.test(html), 'no external script, stylesheet or fetch');
  assert.ok(!/\/\*__(CSS|DATA|RENDER|JS|INCLUDE)/.test(html), 'every placeholder is filled');
  const blob = JSON.parse(/<script type="application\/json" id="atlas-data">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(Object.keys(blob.charts).length, Object.keys(data.charts).length);
  assert.ok(!html.includes('"excerpt"'), 'excerpts are off by default');
  for (const id of r.svgs) assert.ok(fs.readFileSync(path.join(out, 'svg', id + '.svg'), 'utf8').startsWith('<?xml'));
  // excerpts on: reads the file the ref points at
  const src = tmp('src'); fs.mkdirSync(path.join(src, 'parcelworks'), { recursive: true });
  fs.writeFileSync(path.join(src, 'parcelworks', 'intake.py'), Array.from({ length: 40 }, (_, i) => `line ${i + 1} of intake`).join('\n'));
  const out2 = tmp('asm2'), r2 = assemble(data, out2, { excerpts: true, root: src });
  assert.ok(fs.readFileSync(r2.html, 'utf8').includes('line 12 of intake'));
  assert.deepEqual(assemble(data, tmp('asm3')).bytes, r.bytes, 'deterministic size');
});

// ============================================================ part 2: the agent view under its budgets
function bigAgent() {
  const m = model({ stages: 12, perStage: 22, seed: 5 });
  m.system = { name: 'Synthetic system', tagline: 'a generic system', summary: 'Words '.repeat(80), purpose: 'Success is a generic outcome. '.repeat(10) };
  m.paths = [{ id: 'main', title: 'Main', boxes: m.boxes.filter((b) => b.kind !== 'end').slice(0, 120).map((b) => b.id) }];
  m.loops = m.stages.slice(0, 8).map((s, i) => ({ id: 'l' + i, title: 'Loop ' + i, blurb: '', boxes: m.boxes.filter((b) => b.stage === s.id).slice(0, 3).map((b) => b.id), limit: i % 2 ? '' : 'a stated limit that is long enough to need trimming in a brief' }));
  const findings = m.boxes.slice(0, 30).map((b, i) => ({ key: 'pile-up:' + b.id, check: 'pile-up', boxes: [b.id], routes: [], question: 'Many roads in and one way out: does every road deserve the same next step? '.repeat(2), evidence: 'candidate: evidence sentence '.repeat(8), cluster: b.stage, agree: 1, shown: i < 10 }));
  return agentData(m, { findings, gaps: { state: 'draft', items: [{ code: 'B1', msg: 'GAP B1 census rows not accounted. Fix: add ledger rows.', at: 'x' }], tally: {}, notDrawn: { endings: { count: 40, ids: [] }, branches: { count: 10, ids: [] }, modules: { count: 0, ids: [] } } } });
}

test('every agent command stays under its token budget on a 260-box system and ends with a deep link', () => {
  const d = bigAgent();
  const ids = Object.keys(d.boxes), a = ids[3], b = ids[200];
  const outs = { brief: C.brief(d), where: C.where(d, a), breaks: C.breaks(d), 'breaks --all': C.breaks(d, { all: true }), path: C.path(d, a, b), impact: C.impact(d, ids[10]), status: C.status(d) };
  for (const [name, text] of Object.entries(outs)) {
    const cmd = name.split(' ')[0];
    assert.ok(tok(text) <= BUDGET[cmd], `${name}: ${tok(text)} tokens over ${BUDGET[cmd]}`);
    assert.match(text.split('\n').pop(), /^open: .+#chart=[^&]+/, `${name} ends with a deep link`);
    assert.ok(!/\b(bug|dead end|unbounded)\b/i.test(text.replace(/not a confirmed bug/g, '')), `${name} avoids the banned claims`);
  }
  assert.ok(tok(C.brief(d, { budget: 3000 })) > tok(outs.brief), 'a raised budget gives more');
  assert.match(C.brief(d), /faultline|FAULTLINE/);
});

test('where resolves a box id, file:line, a symbol, a name; says plainly when nothing matches; path says when no route is drawn', () => {
  const d = agentData(model({ stages: 2, perStage: 6, seed: 1 }), {});
  const id = Object.keys(d.boxes)[2];
  assert.match(C.where(d, id), new RegExp('^WHERE ' + id.replace('.', '\\.')));
  assert.match(C.where(d, 'no_such_thing'), /no match|matches/i);
  assert.match(C.where(d, 'no_such_thing'), /Not drawn is not the same as absent/);
  const a = Object.keys(d.boxes).find((k) => d.boxes[k].kind === 'end'), b = Object.keys(d.boxes)[0];
  assert.match(C.path(d, a, b), /NO ROUTE DRAWN/);
});

function mcpSession(dir, messages, ms = 4000) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, 'mcp', '--project', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = ''; const got = [];
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    p.on('error', reject);
    p.on('exit', () => resolve(got));
    for (const m of messages) p.stdin.write(JSON.stringify(m) + '\n');
    const t = setInterval(() => { if (got.length >= messages.filter((m) => m.id !== undefined).length) { clearInterval(t); p.stdin.end(); } }, 100);
    setTimeout(() => { clearInterval(t); p.stdin.end(); }, ms * 4).unref();
  });
}

// ============================================================ part 3: the toy, through the command line
function copyToy(withLedger) {
  const dir = tmp('toy');
  const cp = (rel) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.copyFileSync(path.join(TOY, rel), path.join(dir, rel)); };
  for (const sub of ['parcelworks', 'web']) for (const f of fs.readdirSync(path.join(TOY, sub))) if (/\.(py|ts)$/.test(f)) cp(path.join(sub, f));
  cp('explorer_adapter.py'); cp('fixtures/coverage.json'); cp('fixtures/address-hold.walk.jsonl'); cp('.faultline/config.json');
  for (const f of fs.readdirSync(path.join(TOY, '.faultline/model'))) if (withLedger || !/^90-/.test(f)) cp(path.join('.faultline/model', f));
  return dir;
}

test('toy end to end: draft gaps first, then a ledger makes `check --finished` pass; every agent command answers', { timeout: 600000 }, async () => {
  const dir = copyToy(false);
  const run = (args) => cli(args, dir);
  let r = run(['extract']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /census: endings 21/); assert.ok(fs.existsSync(path.join(dir, '.faultline/facts.json')));
  r = run(['propose']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /WHERE TO LOOK/); assert.ok(fs.existsSync(path.join(dir, '.faultline/proposals.json')));

  // a draft shows its gaps and passes; finished refuses on the same gaps
  r = run(['check']);
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, /GAP B1/); assert.match(r.out, /endings 0\/21/); assert.match(r.out, /DRAFT: \d+ gap/);
  r = run(['check', '--finished']);
  assert.equal(r.code, 1); assert.match(r.out, /REFUSE B1/); assert.match(r.out, /REFUSED/);

  r = run(['place', '--budget', '2']);
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, /Hard metrics 0 on every chart/);
  for (const id of ['overview', 'whole', 'stage_intake']) assert.ok(fs.existsSync(path.join(dir, '.faultline/layout', id + '.json')), id);
  r = run(['place', '--budget', '2']);
  assert.match(r.err + r.out, /layout is current/, 'a second place keeps the cached layout');

  r = run(['build', '--draft']);
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, /build: DRAFT/);
  const dist = path.join(dir, '.faultline/dist');
  for (const f of ['atlas.html', 'atlas.agent.json', 'BRIEF.md', 'svg/whole.svg', 'svg/overview.svg']) assert.ok(fs.existsSync(path.join(dist, f)), f);
  const html1 = fs.readFileSync(path.join(dist, 'atlas.html'), 'utf8');
  const blob = JSON.parse(/<script type="application\/json" id="atlas-data">([\s\S]*?)<\/script>/.exec(html1)[1]);
  assert.equal(blob.meta.draft, true); assert.equal(blob.meta.census.endings.accounted, 0); assert.ok(blob.meta.notDrawn.count >= 39);
  assert.ok(blob.charts.whole.regions.length >= 5 && blob.charts.whole.portals.length === 0 && blob.charts.stage_intake.portals.length > 0);
  assert.ok(!html1.includes('if not raw.get(key)'), 'no source text in the page by default');
  assert.ok(!/<script[^>]*\ssrc=|<link[^>]*\shref=["']?https?:/i.test(html1));
  assert.ok(blob.evidence && blob.evidence.findings.length >= 3, 'candidates ride along');
  assert.match(fs.readFileSync(path.join(dist, 'BRIEF.md'), 'utf8'), /DRAFT/);

  // evidence from two sources lights the map and sharpens the candidates
  r = run(['coverage', 'import', 'fixtures/coverage.json']);
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, /26 of 26 functions/);
  r = run(['walk', 'add', 'fixtures/address-hold.walk.jsonl']);
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, /added/);
  r = run(['walk', 'add', 'fixtures/address-hold.walk.jsonl']);
  assert.equal(r.code, 1); assert.match(r.err, /exists/);
  r = run(['walk', 'list']); assert.match(r.out, /SAMPLED/);

  const brief = run(['brief']).out, where = run(['where', 'parcelworks/worker.py:32']).out, breaks = run(['breaks']).out, status = run(['status']).out;
  assert.ok(tok(brief) <= BUDGET.brief && tok(where) <= BUDGET.where && tok(breaks) <= BUDGET.breaks && tok(status) <= BUDGET.status, 'budgets hold on the real toy');
  assert.match(brief, /MAIN PATH 22/); assert.match(brief, /NO LIMIT SHOWN/); assert.match(brief, /accepted|Accounted: endings 0\/21/);
  assert.match(where, /^WHERE parcelworks\/worker\.py:32 -> work\.lease_lost/); assert.match(where, /ROADS IN 2/); assert.match(where, /untested/);
  assert.match(breaks, /declared-never-produced:report\.returned/); assert.match(breaks, /can-only-go-back:trouble\.hold_address/); assert.match(breaks, /no-limit-loop:l_report_write/); assert.match(breaks, /ending-no-test:work\.lease_lost/);
  assert.match(breaks, /SEEN STUCK\/FAILING: trouble\.hold_address\[seen stuck\]/);
  assert.doesNotMatch(breaks, /not found elsewhere[^\n]*no violation/i);
  assert.match(run(['path', 'intake.submit', 'queue.done']).out, /PATH intake\.submit -> queue\.done\s+16 hop\(s\)\s+\(along the declared path main/);
  assert.match(run(['path', 'intake.submit', 'queue.done', '--shortest']).out, /PATH intake\.submit -> queue\.done\s+7 hop/);
  assert.match(run(['impact', 'queue.claim']).out, /ENDINGS within 4 hops: .*reachable at all by forward roads 3 of 5/);
  assert.match(status, /gap B1/); assert.match(status, /charts placed: 7\/7/); assert.match(status, /page: built .*, current/); assert.match(status, /NOT FINISHED|DRAFT/);
  for (const o of [brief, where, breaks, status]) assert.match(o.trim().split('\n').pop(), /^open: .*atlas\.html#chart=/);

  r = run(['analyze', '--dismiss', 'no-limit-loop:l_report_write']);
  assert.equal(r.code, 2); assert.match(r.err, /needs --why/);

  // the ledger: copy the toy's own ledger fragment and findings resolution, and it finishes
  fs.copyFileSync(path.join(TOY, '.faultline/model/90-ledger.json'), path.join(dir, '.faultline/model/90-ledger.json'));
  fs.copyFileSync(path.join(TOY, '.faultline/dismissed.json'), path.join(dir, '.faultline/dismissed.json'));
  r = run(['check', '--finished']);
  assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /PASS: every gate holds/); assert.match(r.out, /endings 21\/21, branches 18\/18/);
  r = run(['build', '--finished']);
  assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /build: FINISHED/);
  const html2 = fs.readFileSync(path.join(dist, 'atlas.html'), 'utf8');
  const blob2 = JSON.parse(/<script type="application\/json" id="atlas-data">([\s\S]*?)<\/script>/.exec(html2)[1]);
  assert.equal(blob2.meta.draft, false); assert.equal(blob2.meta.notDrawn.count, 0);
  assert.ok(Object.keys(blob2.evidence.boxes).length >= 30 && blob2.evidence.walks.length >= 2, 'seen boxes and ordered walk paths are in the page');
  r = run(['build', '--finished']);
  assert.equal(fs.readFileSync(path.join(dist, 'atlas.html'), 'utf8'), html2, 'the same input builds the same bytes');
  r = run(['build', '--excerpts']);
  assert.ok(fs.readFileSync(path.join(dist, 'atlas.html'), 'utf8').includes('if not raw.get(key)'), 'excerpts on: the source lines are in the page');

  // the MCP server: initialize, six tools under 40 words, a real call, a refusal for a missing argument
  const got = await mcpSession(path.join(dir, '.faultline'), [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'faultline_where', arguments: { target: 'queue.claim' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'faultline_path', arguments: { from: 'queue.claim' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'faultline_status', arguments: {} } },
  ]);
  const byId = Object.fromEntries(got.map((g) => [g.id, g]));
  assert.equal(byId[1].result.protocolVersion, '2025-03-26');
  const tools = byId[2].result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ['faultline_breaks', 'faultline_brief', 'faultline_impact', 'faultline_path', 'faultline_status', 'faultline_where']);
  for (const t of tools) assert.ok(t.description.split(/\s+/).length < 40, `${t.name} description is ${t.description.split(/\s+/).length} words`);
  assert.match(byId[3].result.content[0].text, /^WHERE queue\.claim/); assert.equal(byId[4].error.code, -32602); assert.match(byId[5].result.content[0].text, /STATUS FINISHED/);
});

test('cli: friendly errors, never a stack; a project dir is found from inside .faultline', () => {
  const empty = tmp('empty');
  let r = cli(['brief'], empty);
  assert.equal(r.code, 2); assert.match(r.err, /^faultline: No project here: .*\. Fix: .*faultline map --source /); assert.doesNotMatch(r.err, /\n\s+at /);
  r = cli(['frobnicate'], empty); assert.equal(r.code, 2); assert.match(r.err, /unknown command/);
  r = cli(['where'], empty); assert.equal(r.code, 2);
  r = cli(['init'], empty); assert.equal(r.code, 0); assert.ok(fs.existsSync(path.join(empty, '.faultline/model/00-system.json')));
  r = cli(['build'], empty); assert.equal(r.code, 2); assert.match(r.err, /facts\.json/);
  r = cli(['extract', '--bogus'], empty); assert.equal(r.code, 2); assert.match(r.err, /Unknown option --bogus/);
  fs.writeFileSync(path.join(empty, 'a.py'), 'def f(x):\n    if x:\n        return "yes"\n    return "no"\n');
  r = cli(['extract'], path.join(empty, '.faultline')); assert.equal(r.code, 0, r.err); assert.match(r.out, /files read 1/, 'from inside .faultline the source root is its parent');
  r = cli(['help'], empty); assert.equal(r.code, 0); assert.match(r.out, /Faultline by EKG/);
});

test('look: PNGs for each chart (only when FAULTLINE_E2E_BROWSER=1, one headless browser)', { skip: process.env.FAULTLINE_E2E_BROWSER !== '1' && 'needs a headless browser: set FAULTLINE_E2E_BROWSER=1' }, () => {
  const dir = path.join(TOY, '.faultline');
  const r = cli(['look', 'overview', 'whole'], TOY);
  assert.equal(r.code, 0, r.err + r.out);
  for (const id of ['overview', 'whole']) assert.ok(fs.statSync(path.join(dir, 'dist/png', id + '.png')).size > 5000);
});
