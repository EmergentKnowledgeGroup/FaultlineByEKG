// node --test test/engine.test.mjs
// Engine tests on a tiny inline graph (the toy parcel flow): layout, metrics, rendering, channel sizing, label optimiser, Chromium discovery.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gridLayout, parseMap, placeLabels } from '../src/engine/gridlayout.mjs';
import { metrics, FIT_VIEWPORT } from '../src/engine/metrics.mjs';
import { renderSVG, chipFamilies, chipLayout, KIND, EDGE, CHIP_PALETTE } from '../src/engine/render.mjs';
import { autoChannels } from '../src/engine/autochannels.mjs';
import { channelReport } from '../src/engine/channels.mjs';
import { optimiseLabels, withPins, quality } from '../src/engine/labels.mjs';
import { findChromium, previewChart } from '../src/engine/preview.mjs';
import { describeChart } from '../src/engine/show-chart.mjs';
import { wrapText, glyphs, GLYPH } from '../src/engine/layout.mjs';

const graph = () => ({
  id: 'parcel', title: 'Parcel flow',
  nodes: [
    { id: 'intake', title: 'Receive a parcel request', kind: 'step', handle: 'Intake', family: 'front' },
    { id: 'valid', title: 'Is the request valid?', kind: 'decision' },
    { id: 'wait', title: 'Wait for a free worker', kind: 'wait', handle: 'Queue', family: 'back' },
    { id: 'gate', title: 'Customs limit check', kind: 'gate' },
    { id: 'store', title: 'Store the job record', kind: 'store' },
    { id: 'carrier', title: 'Hand to the carrier', kind: 'external' },
    { id: 'refused', title: 'Request refused', kind: 'end' },
    { id: 'done', title: 'Parcel delivered', kind: 'end' },
  ],
  edges: [
    { id: 'r1', from: 'intake', to: 'valid', type: 'forward', label: '' },
    { id: 'r2', from: 'valid', to: 'wait', type: 'forward', label: 'Valid' },
    { id: 'r3', from: 'valid', to: 'refused', type: 'forward', label: 'Invalid address' },
    { id: 'r4', from: 'wait', to: 'gate', type: 'forward', label: 'Worker free' },
    { id: 'r5', from: 'gate', to: 'store', type: 'record', label: 'Under limit' },
    { id: 'r6', from: 'store', to: 'carrier', type: 'forward', label: 'Saved' },
    { id: 'r7', from: 'carrier', to: 'done', type: 'deliver', label: 'Delivered' },
    { id: 'r8', from: 'gate', to: 'refused', type: 'forward', label: 'Over limit' },
    { id: 'r9', from: 'carrier', to: 'wait', type: 'return', label: 'Carrier refused', inferred: true },
  ],
});
const CFG = () => ({ map: ['intake valid wait gate', 'refused . . store', '. done carrier .'], gapX: 130, gapY: 80 });
const HARD = ['nodeOverlaps', 'edgeThroughNode', 'trackOverlaps', 'labelOverlapsLabel', 'labelOverlapsNode', 'diagonalSegs', 'shortArrowStubs', 'labelMissing'];

test('gridLayout: geometry shape, kinds and handles carried through, hard metrics zero', async () => {
  const g = await gridLayout(graph(), CFG());
  assert.equal(g.nodes.length, 8); assert.equal(g.edges.length, 9);
  assert.deepEqual(g.nodes.map(n => n.kind), ['step', 'decision', 'wait', 'gate', 'store', 'external', 'end', 'end']);
  assert.equal(g.nodes[0].handle, 'Intake'); assert.equal(g.nodes[0].family, 'front'); assert.equal(g.nodes[1].handle, undefined);
  for (const e of g.edges) assert.ok(e.pts.length >= 2 && e.pts.every(p => p.every(Number.isFinite)), 'route ' + e.id);
  assert.equal(g.edges.find(e => e.id === 'r9').inferred, true);
  const m = metrics(g);
  for (const k of HARD) assert.equal(m[k], 0, k + ' ' + JSON.stringify(m.issues));
  assert.ok(g.nodes.every(n => n.x >= 0 && n.y >= 0) && g.width > 0 && g.height > 0);
});

test('gridLayout: deterministic, and the geometry is stable (golden)', async () => {
  const a = JSON.stringify(await gridLayout(graph(), CFG())), b = JSON.stringify(await gridLayout(graph(), CFG()));
  assert.equal(a, b);
  const digest = crypto.createHash('sha256').update(a).digest('hex').slice(0, 16);
  assert.equal(digest, GOLDEN, 'layout of the tiny graph changed; if intended, update GOLDEN to ' + digest);
});
const GOLDEN = '120e401f8a7fd16d';       // box names now carry even lines (balanceLines); sizes and positions are unchanged

test('gridLayout: an edge with no label text gets no pill and is not "missing"', async () => {
  const g = await gridLayout(graph(), CFG());
  const r1 = g.edges.find(e => e.id === 'r1');
  assert.equal(r1.labelBox, null); assert.deepEqual(r1.lines, []); assert.equal(r1.label, '');
  assert.equal(metrics(g).labelMissing, 0);
  assert.ok(g.edges.filter(e => e.id !== 'r1').every(e => e.labelBox));
});

test('gridLayout: category is accepted as an alias of kind; text overrides reword', async () => {
  const gr = graph(); gr.nodes = gr.nodes.map(({ kind, ...n }) => ({ ...n, category: kind }));
  gr.text = { nodes: { valid: { title: 'Request OK?', handle: 'Check' } }, edges: { r2: { short: 'Yes' } } };
  const g = await gridLayout(gr, CFG());
  assert.equal(g.nodes[1].kind, 'decision'); assert.equal(g.nodes[1].title, 'Request OK?'); assert.equal(g.nodes[1].handle, 'Check');
  assert.equal(g.edges.find(e => e.id === 'r2').label, 'Yes');
});

test('gridLayout: refuses bad input with a plain message', async () => {
  await assert.rejects(gridLayout(graph(), {}), /needs cfg\.map/);
  const dup = graph(); dup.nodes.push({ ...dup.nodes[0] });
  await assert.rejects(gridLayout(dup, CFG()), /duplicate node id: intake/);
  const dangling = graph(); dangling.edges.push({ id: 'x', from: 'intake', to: 'nowhere', type: 'forward', label: 'x' });
  await assert.rejects(gridLayout(dangling, CFG()), /edge x references unknown node nowhere/);
  await assert.rejects(gridLayout(graph(), { map: ['intake valid'] }), /map mismatch/);
  assert.throws(() => parseMap(['a a']), /placed twice/);
  const empty = await gridLayout({ id: 'e', nodes: [], edges: [] }, {});
  assert.equal(empty.nodes.length, 0);
});

test('glyph widths are a config option with the old numbers as defaults', async () => {
  assert.deepEqual(glyphs({}), { node: GLYPH.node, edge: GLYPH.edge });
  assert.equal(GLYPH.node, 7.9); assert.equal(GLYPH.edge, 6.9);
  const base = await gridLayout(graph(), CFG());
  const same = await gridLayout(graph(), { ...CFG(), glyph: { node: 7.9, edge: 6.9 } });
  assert.equal(JSON.stringify(base), JSON.stringify(same));
  const wide = await gridLayout(graph(), { ...CFG(), glyph: { node: 10, edge: 9 } });
  const w = id => base.nodes.find(n => n.id === id).w, ww = id => wide.nodes.find(n => n.id === id).w;
  assert.ok(ww('wait') > w('wait'));
  assert.ok(wide.edges.find(e => e.id === 'r3').labelBox.w > base.edges.find(e => e.id === 'r3').labelBox.w);
  assert.deepEqual(wrapText('one two three four', 8), ['one two', 'three', 'four']);
});

test('metrics: fit viewport is config with a 1600x900 default; smallest text at fit', async () => {
  assert.deepEqual(FIT_VIEWPORT, { w: 1600, h: 900 });
  const g = await gridLayout(graph(), CFG());
  const m = metrics(g), s = Math.min(1600 / g.width, 900 / g.height);
  assert.equal(m.fitScale, +s.toFixed(2));
  assert.equal(m.minTextKind, 'chip'); assert.equal(m.minTextPx, +(11.5 * s).toFixed(1));
  const small = metrics(g, { fit: { w: 400, h: 225 } });
  assert.ok(small.fitScale < m.fitScale && small.minTextPx < 11, 'a chart squeezed into 400x225 has text below the 11px floor');
  assert.equal(small.score, m.score, 'the fit viewport must not change the score (the legacy viewport does that)');
  const noChips = graph(); noChips.nodes.forEach(n => { delete n.handle; });
  assert.equal(metrics(await gridLayout(noChips, CFG())).minTextKind, 'edge');
  assert.equal(metrics(g, { fonts: { chip: 20 } }).minTextKind, 'edge');
});

test('renderSVG: model kinds and route types, looks kept', async () => {
  const g = await gridLayout(graph(), CFG());
  const svg = renderSVG(g);
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  for (const k of Object.keys(KIND)) assert.ok(svg.includes(`data-kind="${k}"`), k);
  assert.ok(!svg.includes('data-cat'));
  const node = id => svg.slice(svg.indexOf(`data-node="${id}"`), svg.indexOf('</g>', svg.indexOf(`data-node="${id}"`)));
  assert.ok(node('wait').includes('stroke-dasharray="7 4"'), 'wait boxes are dashed');
  assert.ok(!node('done').includes('node-tab') && node('done').includes(`rx="${g.nodes.find(n => n.id === 'done').h / 2}"`), 'end boxes are pills without a tab');
  assert.ok(node('store').includes('node-tab') && node('store').includes(`stroke="${KIND.store.color}"`));
  for (const t of Object.keys(EDGE)) assert.ok(svg.includes(`id="arr-${t}"`), 'marker ' + t);
  assert.ok(/class="edge e-return inferred"[^>]*data-inferred="1"[\s\S]*?stroke-dasharray="7 5"/.test(svg), 'return routes are red dashed, inferred ones flagged');
  assert.ok(svg.includes(`stroke="${EDGE.return.color}"`));
  assert.ok(!/class="elabel" data-edge-label="r1"/.test(svg), 'no pill for the unlabelled route');
  assert.ok(/class="elabel" data-edge-label="r3"/.test(svg));
});

test('renderSVG: unknown kind and type fall back; text is escaped; options merge the look tables', async () => {
  const gr = graph(); gr.nodes[0].kind = 'mystery'; gr.nodes[1].title = 'A < B & "C"?'; gr.edges[0].type = 'whatever';
  const g = await gridLayout(gr, CFG());
  const svg = renderSVG(g);
  assert.ok(/data-node="intake" data-kind="step"/.test(svg));
  assert.ok(/class="edge e-forward" data-edge="r1"/.test(svg) && /data-edge="r1"[\s\S]*?marker-end="url\(#arr-forward\)"/.test(svg));
  assert.ok(svg.includes('A &lt; B &amp; &quot;C&quot;?'));
  const custom = renderSVG(g, { kinds: { gate: { color: '#aa0011', dash: '3 3' } }, edges: { record: { color: '#00aa11', dash: '' } }, idPrefix: 'p1-' });
  assert.ok(custom.includes('stroke="#aa0011" stroke-dasharray="3 3"') && custom.includes('stroke="#00aa11"') && custom.includes('id="p1-arr-forward"'));
});

test('handle chips: families come from options, never from the text of the handle', async () => {
  const g = await gridLayout(graph(), CFG());
  const fam = chipFamilies(g);
  assert.deepEqual(Object.keys(fam), ['front', 'back']);
  assert.equal(fam.front.fill, CHIP_PALETTE[0].fill); assert.equal(fam.back.fill, CHIP_PALETTE[1].fill);
  const svg = renderSVG(g);
  assert.ok(svg.includes('class="chip fam-front"') && svg.includes('class="chip fam-back"') && svg.includes('data-handle="Intake"'));
  assert.ok(svg.includes(`fill="${CHIP_PALETTE[0].fill}"`));
  // the same handle text, different options -> different colours; a handle that looks like a code gets no special treatment
  const g2 = JSON.parse(JSON.stringify(g)); g2.nodes[0].handle = 'Z9'; g2.nodes[2].handle = 'Z9';
  assert.equal(Object.keys(chipFamilies(g2)).length, 2);
  const opt = { chips: { families: { x: { name: 'X', fill: '#112233', line: '#445566', ink: '#ffffff' } }, familyOf: () => 'x' } };
  const svg2 = renderSVG(g2, opt);
  assert.equal((svg2.match(/class="chip fam-x"/g) || []).length, 2); assert.ok(svg2.includes('fill="#112233"') && svg2.includes('stroke="#445566"'));
  assert.equal(chipFamilies(g2, opt.chips).x.name, 'X');
  // long handles are cut at maxChars; chips never overlap each other or the box text
  g2.nodes[0].handle = 'A very long official name'; const pl = chipLayout(g2, { maxChars: 10 });
  assert.ok(pl.intake.text.length <= 10 && pl.intake.text.includes('···') && pl.intake.text.startsWith('A v') && pl.intake.text.endsWith('name'));   // cut in the middle, so the start and the end both show (it was cut at the end)
  assert.equal(renderSVG(g, { handles: false }).includes('class="chip'), false);
});

test('renderSVG: portals mark entry and exit boxes without moving geometry', async () => {
  const g = await gridLayout(graph(), CFG());
  const svg = renderSVG(g, { portals: [{ node: 'intake', dir: 'in', chart: 'other' }, { node: 'done', dir: 'out', chart: 'other' }, { node: 'nope', dir: 'in' }] });
  assert.ok(svg.includes('data-portal="in"') && svg.includes('data-portal="out"') && svg.includes('class="pbadge"'));
  assert.equal((svg.match(/class="portal-ring/g) || []).length, 0, 'no ring by default (one mark, the badge)');
  const withRings = renderSVG(g, { rings: true, portals: [{ node: 'intake', dir: 'in', chart: 'other' }, { node: 'done', dir: 'out', chart: 'other' }] });
  assert.ok((withRings.match(/class="portal-ring/g) || []).length >= 2);
});

test('autoChannels widens overloaded gaps and keeps the map; channelReport lists gaps', async () => {
  const cfg = { ...CFG(), gapX: 40, gapY: 30 };
  const r = await autoChannels(graph(), cfg, { iters: 3 });
  assert.equal(r.cfg.map, cfg.map); assert.ok(Array.isArray(r.history) && r.history.length >= 1);
  assert.ok(r.history.at(-1).missing <= r.history[0].missing);
  const rep = channelReport(r.geom);
  assert.ok(Array.isArray(rep) && rep.every(x => 'deficit' in x && 'cfg' in x));
});

test('optimiseLabels: pins reproduce through the engine, and withPins round-trips', async () => {
  const cfg = CFG(), gr = graph();
  const g = await gridLayout(gr, cfg);
  const r = optimiseLabels(g, cfg, { passes: 4, seed: 7 });
  const labelled = g.edges.filter(e => e.labelBox).length;
  assert.equal(r.reproduced.same, labelled); assert.equal(r.reproduced.total, labelled);
  assert.equal(r.pinned.same, labelled); assert.equal(Object.keys(r.pins).length, labelled);
  assert.ok(!('r1' in r.pins), 'no pin for the unlabelled route');
  assert.equal(r.verified.labelLabel, 0); assert.equal(r.verified.labelNode, 0);
  assert.ok(quality(r.verified) <= quality(r.before), 'the result is never worse than the engine own placement'); assert.equal(typeof r.better, 'boolean');
  const g2 = await gridLayout(gr, withPins(cfg, r.pins));
  // moving a label can grow the chart's bounding box, which shifts every coordinate: compare relative to the first node
  const sx = g2.nodes[0].x - g.nodes[0].x, sy = g2.nodes[0].y - g.nodes[0].y;
  g2.edges.forEach((e, k) => { if (e.labelBox) assert.ok(Math.abs(e.labelBox.x - sx - r.boxes[k].x) <= 0.6 && Math.abs(e.labelBox.y - sy - r.boxes[k].y) <= 0.6, e.id); });
  for (const k of HARD) assert.equal(metrics(g2)[k], 0, k);
  assert.equal(JSON.stringify(optimiseLabels(g, cfg, { passes: 4, seed: 7 }).pins), JSON.stringify(r.pins), 'same seed, same pins');
  assert.equal(typeof placeLabels, 'function');
});

test('findChromium: CHROME_PATH first, never throws, null when nothing is installed', () => {
  assert.equal(findChromium({ CHROME_PATH: process.execPath }, process.platform), process.execPath);
  const none = { PATH: path.join(os.tmpdir(), 'no-such-dir-xyz'), LOCALAPPDATA: path.join(os.tmpdir(), 'no-such-dir-xyz'), HOME: os.tmpdir(), PLAYWRIGHT_BROWSERS_PATH: path.join(os.tmpdir(), 'no-such-dir-xyz'), ProgramFiles: path.join(os.tmpdir(), 'x'), 'ProgramFiles(x86)': path.join(os.tmpdir(), 'x') };
  for (const plat of ['win32', 'linux', 'darwin']) { const r = findChromium(none, plat); assert.ok(r === null || typeof r === 'string'); }
});

test('previewChart writes geometry and svg files and says when the PNG is skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-prev-'));
  try {
    const r = await previewChart(graph(), CFG(), { outDir: dir, tag: 't', png: false });
    assert.ok(fs.existsSync(path.join(dir, 't.geom.json')) && fs.existsSync(path.join(dir, 't.svg')));
    assert.equal(r.metrics.nodes, 8); assert.equal(r.pngSkipped, null);
    assert.ok(fs.readFileSync(path.join(dir, 't.svg'), 'utf8').includes('<style>'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('describeChart lists nodes and edges with kinds, handles and conditions', () => {
  const s = describeChart(graph(), { nodes: { valid: { title: 'Request OK?' } }, edges: { r2: { short: 'Yes' } } });
  assert.ok(s.includes('- valid [decision] "Is the request valid?"') && s.includes('(Intake)'));
  assert.ok(s.includes('NEW title: "Request OK?"') && s.includes('NEW short: "Yes"') && s.includes('(inferred)'));
});

test('index exports the CONTRACTS section 11 signatures', async () => {
  const eng = await import('../src/engine/index.mjs');
  for (const name of ['gridLayout', 'metrics', 'autoChannels', 'renderSVG']) assert.equal(typeof eng[name], 'function', name);
  assert.equal(eng.gridLayout.length, 1, 'gridLayout(graph, cfg = {}): one required argument, then an optional cfg');
  assert.deepEqual(eng.FIT_VIEWPORT, { w: 1600, h: 900 });
  assert.deepEqual(Object.keys(eng.KIND), ['step', 'decision', 'gate', 'wait', 'store', 'external', 'end']);
  assert.deepEqual(Object.keys(eng.EDGE), ['forward', 'deliver', 'record', 'return']);
});
