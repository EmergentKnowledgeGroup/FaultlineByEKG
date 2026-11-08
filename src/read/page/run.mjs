// `faultline map`: from a source folder to a finished page in one run, with no agent.
//   read the code and ask the checkers -> apply the rules (the map) -> scan (facts, signals) -> the reading -> the page project -> place -> build -> inject the Reader
// Every stage writes into the project folder (default ./.faultline). Same sources, same bytes. Nothing is written under the source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSystem as readCode } from '../../map/index.mjs';
import { discover } from '../../extract/walk.mjs';
import { findPython } from '../../map/pyenv.mjs';
import { mapSystem, modelText, claimsText } from '../../map/mapsystem.mjs';
import { readRouteFacts } from '../../map/routefacts.mjs';
import { reviewIndex } from '../../map/review.mjs';
import { dumps } from '../../map/pyrt.mjs';
import { callTableText } from '../../map/calltable.mjs';
import { storyIndex, storyIndexText } from '../../story/export.mjs';
import { extract, writeOutputs, summary as scanSummary } from '../../extract/index.mjs';
import { writeProjectSignals, signalsSummary } from '../../extract/signals.mjs';
import { buildProject } from '../../build/pipeline.mjs';
import { readSystem as readReading } from '../index.mjs';
import { stableStringify } from '../util.mjs';
import { buildModel } from './project.mjs';
import { injectPage } from './inject.mjs';
import { buildAsk } from './agentx.mjs';
import { CliError } from '../../build/project.mjs';
import { plural } from '../../build/util.mjs';
import { HOT_BYTES } from '../charts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN_PY = [3, 10];
export const PAGE_LIMIT = 15500000;   // a page stays under 16 000 000 bytes; this leaves room for what the estimate cannot see
const fwd = (p) => path.resolve(p).replace(/\\/g, '/');
const secs = (t0) => +((performance.now() - t0) / 1000).toFixed(1);

/** The folders of one tool-map project. */
export function layout(project) {
  const dir = fwd(project);
  return { dir, map: `${dir}/map`, read: `${dir}/read` };
}

/** A project folder that holds a map written by hand (not one `faultline map` wrote) is not overwritten. */
export function refuseHandMade(dir) {
  const sys = path.join(dir, 'model', '00-system.json');
  if (!fs.existsSync(sys)) return;
  let mine = false;
  try { mine = !!JSON.parse(fs.readFileSync(sys, 'utf8')).system?.toolMap; } catch { /* unreadable: not ours */ }
  const others = fs.readdirSync(path.join(dir, 'model')).filter((f) => f.endsWith('.json') && f !== '00-system.json' && f !== '10-flows.json');
  if (!mine || others.length) throw new Error(`${dir} holds a map written by hand (model/ has files faultline map did not write). Give --project another folder, so that neither map overwrites the other.`);
}

/** A folder given as a scope (`src/`, `src\`, `./src`) is the same folder without the trailing slash, so no path ends up with a double slash. */
const folderPrefix = (p) => String(p).replace(/^\.\//, '').replace(/[\\/]+$/, '');

/** Which languages to read and how: the flags, else a config file, else every language found under the source. Python is dropped, with a note, when the machine has none. */
export async function chooseLanguages(root, opt, notes, scan = {}) {
  const config = {};
  if (opt.config) config.cfg = JSON.parse(fs.readFileSync(opt.config, 'utf8'));
  const c = config.cfg ?? {};
  delete config.cfg;
  if (opt.python) c.python = { include: opt.python, exclude: opt['python-exclude'] ?? [] };
  if (opt.typescript !== undefined) c.typescript = { prefix: folderPrefix(opt.typescript), exclude: opt['ts-exclude'] ?? [], ...(opt.tsconfig ? { tsconfig: opt.tsconfig } : {}) };
  if (opt.lua !== undefined) c.lua = { prefix: folderPrefix(opt.lua) };
  if (!c.python && !c.typescript && !c.lua) {
    // no language named: read exactly the files the scanner counts as source, so every box can cite a file the scan lists
    const src = discover(root, { include: scan.include || [], exclude: scan.exclude || [], defaults: !scan.noDefaults }).files.filter((f) => f.role === 'src');
    const by = (...langs) => src.filter((f) => langs.includes(f.lang)).map((f) => f.path);
    const py = by('py'), ts = by('ts', 'js'), lua = by('lua');
    if (py.length) c.python = { include: py, exclude: [] };
    if (ts.length) c.typescript = { prefix: '', exclude: [], only: ts };
    if (lua.length) c.lua = { prefix: '', only: lua };
  }
  let noPython = false;
  if (c.python) {
    let p = null;
    try { p = await findPython(opt.interpreter); } catch (e) { if (opt.interpreter) throw e; }
    if (!p || p.version[0] < MIN_PY[0] || (p.version[0] === MIN_PY[0] && p.version[1] < MIN_PY[1])) {
      notes.push({ code: 'no-python', text: `Python files were not read: Python ${MIN_PY.join('.')} or newer was not found${p ? ` (found ${p.version.join('.')})` : ''}. Install it, or name one with --interpreter.` });
      delete c.python;
      noPython = true;
    }
  }
  if (!c.python && !c.typescript && !c.lua) throw new Error(`nothing to read: no ${noPython ? 'readable ' : ''}Python, TypeScript, JavaScript or Lua files under ${root}${noPython ? ' (Python was not found)' : ''}`);
  return { config: c, noPython };
}

const noteText = (n) => (n.code === 'no-checker' ? 'the Python type checker (ty) is not installed: run  faultline setup  for it. Until then the map makes no negative claims about Python and leaves its effects as "maybe:".' : n.text);

/** Run a node script as a child; resolves { code, tail }. */
function child(args, heap) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [`--max-old-space-size=${heap}`, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let tail = '';
    const keep = (c) => { tail = (tail + c).slice(-4000); };
    p.stdout.on('data', keep); p.stderr.on('data', keep);
    p.on('error', (e) => resolve({ code: 1, tail: String(e.message) }));
    p.on('close', (code) => resolve({ code, tail }));
  });
}

/** Place every chart: the small ones in parallel shards (each chart is placed on its own, so the shard count does not change a layout), then the overview, then a repair pass. */
export async function placeAll(projDir, chartCount, log) {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const shards = chartCount < 40 ? 1 : Math.max(1, Math.min(4, cpus - 1));
  const script = (f) => path.join(here, f);
  const runs = [];
  for (let i = 0; i < shards; i++) runs.push(child([script('place.mjs'), projDir, ...(shards > 1 ? ['--shard', `${i}/${shards}`] : [])], 4096));
  const done = await Promise.all(runs);
  const bad = done.find((r) => r.code !== 0);
  if (bad) throw new Error(`placing charts failed (exit ${bad.code}): ${bad.tail.split('\n').slice(-4).join(' | ')}`);
  const ov = await child([script('place.mjs'), projDir, '--only', 'overview'], 8192);
  if (ov.code !== 0) throw new Error(`placing the overview failed (exit ${ov.code}): ${ov.tail.split('\n').slice(-4).join(' | ')}`);
  const rep = await child([script('repair.mjs'), projDir], 8192);
  const left = /charts with a hard defect: (\d+)/.exec(rep.tail);
  const after = [...rep.tail.matchAll(/(\d+) left/g)].pop();
  log(`placed ${plural(chartCount, 'chart')} in ${plural(shards, 'shard')}${rep.code === 0 ? '; hard defects: none' : `; hard defects left: ${after ? after[1] : left ? left[1] : '?'}`}`);
  return { shards, hardLeft: rep.code === 0 ? 0 : Number(after ? after[1] : left ? left[1] : 1) };
}

/**
 * Rebuild a tool map's page from the project folder alone: the page, its Reader, atlas.agent.json and BRIEF.md. The code is not read and no chart is placed.
 * Refuses, naming the command, when a part of the reading or a layout is missing. `fix` is the exact command that makes the project again.
 */
export async function rebuildToolPage(projDir, { root = null, excerpts = false, keepMessages = false, sourceBase = '', fix = 'faultline map --source <the code folder>' } = {}) {
  const L = layout(projDir);
  const missing = ['reading.json', 'charts.json', 'words.json'].filter((x) => !fs.existsSync(`${L.read}/${x}`));
  if (missing.length) throw new CliError(`This tool map's reading is incomplete (${missing.join(', ')} not in ${L.read}). Fix: ${fix}`, 1);
  if (!fs.existsSync(`${L.dir}/page/side.json`)) throw new CliError(`This tool map has no page/side.json. Fix: ${fix}`, 1);
  if (!fs.existsSync(`${L.dir}/page/ask.json`)) {       // a project made before the text commands shared the page's questions
    const J = (x) => JSON.parse(fs.readFileSync(`${L.read}/${x}`, 'utf8'));
    fs.writeFileSync(`${L.dir}/page/ask.json`, stableStringify(buildAsk({ reading: J('reading.json'), charts: J('charts.json') })));
  }
  const refuseUnplaced = (ids) => `${ids.length} chart(s) have no layout (${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', ...' : ''}), so the page cannot be rebuilt as it was made. Fix: ${fix}`;
  const r = await buildProject(L.dir, { finished: false, draft: true, place: false, root, excerpts, keepMessages, sourceBase, refuseUnplaced });
  injectPage({ readDir: L.read, projDir: L.dir, readerDir: path.join(here, 'reader') });
  return { ...r, bytes: fs.statSync(r.html).size };
}

/**
 * @param opt  { source, project, name, 'no-page', config, python[], 'python-exclude'[], typescript, 'ts-exclude'[], tsconfig, lua, tools, interpreter, work, quiet }
 * @returns {{ times:Object, notes:Array, files:Object, page:?string }}
 */
export async function mapToPage(opt, say = console.log) {
  const root = fwd(opt.source);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`the source folder ${root} does not exist`);
  const L = layout(opt.project);
  const notes = [], times = {};
  refuseHandMade(L.dir);
  const log = opt.quiet ? () => {} : say;
  const stage = (n, total, what) => log(`[${n}/${total}] ${what}`);
  const total = opt['no-page'] ? 5 : 7;
  fs.mkdirSync(L.map, { recursive: true });
  fs.mkdirSync(L.read, { recursive: true });
  let t = performance.now();

  stage(1, total, 'reading the code');
  fs.mkdirSync(L.dir, { recursive: true });
  const cfgFile = `${L.dir}/config.json`;
  if (!fs.existsSync(cfgFile)) fs.writeFileSync(cfgFile, JSON.stringify({ include: [], exclude: [] }, null, 2) + '\n');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) || {};
  const { config, noPython } = await chooseLanguages(root, opt, notes, cfg);
  config.root = root;
  config.work = opt.work ? fwd(opt.work) : `${L.map}/_work`;
  if (opt.tools) config.tools = fwd(opt.tools);
  if (opt.interpreter) config.interpreter = opt.interpreter;
  config.log = opt.quiet ? () => {} : (m) => log(`      ${m}`);
  const sys = await readCode(config);
  notes.push(...sys.notes);
  times.read = secs(t);

  t = performance.now();
  stage(2, total, 'applying the rules');
  if (sys.ir.py) sys.routeFacts = await readRouteFacts({ root, rels: sys.ir.py.files.map((f) => f.path), work: config.work, interpreter: config.interpreter });
  const name = opt.name ?? path.basename(root);
  const res = mapSystem(sys, { name, clone: false });
  const put = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text, { encoding: 'utf8' });
  put(L.map, 'model.json', modelText(res.model));
  put(L.map, 'claims.json', claimsText(res.claims));
  put(L.map, 'review-index.json', dumps(reviewIndex(res.P, res.claims), 0));
  const index = storyIndex(sys.ir, sys.sourceDigest);
  put(L.map, 'story-index.json', storyIndexText(sys.ir, sys.sourceDigest));
  put(L.map, 'calls.json', callTableText(res.P));
  const confident = res.claims.filter((c) => c.conf === 'confident').length;
  const line = `${name}: ${plural(res.model.boxes.length, 'box', 'boxes')}, ${plural(res.model.routes.length, 'road')}, ${plural(res.claims.length, 'claim')} (${confident} confident, ${res.claims.length - confident} not)`;
  log(`      ${line.slice(name.length + 2)}`);
  times.map = secs(t);

  t = performance.now();
  stage(3, total, 'scanning for facts and signals');
  const scan = await extract(root, { include: cfg.include || [], exclude: cfg.exclude || [], noDefaults: !!cfg.noDefaults, noPython });
  writeOutputs(scan, L.dir);
  log(`      ${scanSummary(scan).split('\n')[0]}`);
  try { log(`      ${signalsSummary(await writeProjectSignals(root, L.dir, scan.facts, cfg))}`); } catch (e) { notes.push({ code: 'no-signals', text: `signals were not written: ${String(e.message).slice(0, 160)}` }); }
  times.scan = secs(t);

  const J = (f) => JSON.parse(fs.readFileSync(`${L.dir}/${f}`, 'utf8'));
  const facts = J('facts.json');
  const signals = fs.existsSync(`${L.dir}/signals.json`) ? J('signals.json') : null;
  const calls = JSON.parse(fs.readFileSync(`${L.map}/calls.json`, 'utf8'));
  const w = (f, v, indent) => fs.writeFileSync(`${L.read}/${f}`, `${stableStringify(v, indent)}
`, 'utf8');
  const tagline = 'A program read the code and drew this; no agent wrote any of it';
  const add = (k, t0) => { times[k] = +((times[k] ?? 0) + secs(t0)).toFixed(1); };
  let result = { line, times, notes, files: { map: L.map, read: L.read, project: L.dir }, page: null };

  // The page must stay under PAGE_LIMIT bytes. The charts are chosen by an estimate of their bytes (charts.mjs); when the finished page is still over, the budget
  // is lowered by the excess and the page made again (layouts already placed are kept). The same code always gives the same page, so it always takes the same steps.
  let chartBytes;
  for (let attempt = 0; ; attempt++) {
    t = performance.now();
    stage(4, total, 'writing the reading');
    const out = readReading({ model: res.model, claims: res.claims, facts, signals, calls, spans: index.fns, sourceRoot: root, name: opt.name, notes: notes.map(noteText), chartBytes });
    w('reading.json', out.reading, 1); w('charts.json', out.charts); w('words.json', out.words);
    fs.writeFileSync(`${L.read}/journeys.txt`, out.text, 'utf8');
    const n = out.reading.numbers;
    log(`      ${plural(n.read.functions, 'function')}, ${plural(n.journeys.kept, 'journey')}, ${plural(n.open.questions, 'question')}, ${plural(out.charts.stats.chartedFunctions, 'function chart')}`);
    add('reading', t);
    result = { ...result, numbers: n, charts: out.charts.stats.chartedFunctions };

    t = performance.now();
    stage(5, total, 'writing the page project');
    const reading = out.reading;
    const pname = opt.name || reading.system.name || 'This system';
    const p = reading.system.purpose;
    const summaryText = (p?.text ? `${p.text} (${p.source}.)` : "No statement of purpose was found in the project's README, package metadata or module comments.").slice(0, 400);
    const m = buildModel({ reading, charts: out.charts, claims: res.claims, name: pname, tagline, wordsBy: null, toolMap: { summary: summaryText } });
    for (const d of ['model', 'page']) fs.mkdirSync(`${L.dir}/${d}`, { recursive: true });
    fs.writeFileSync(`${L.dir}/model/00-system.json`, stableStringify(m.system, 1));
    fs.writeFileSync(`${L.dir}/model/10-flows.json`, JSON.stringify(m.flows));
    fs.writeFileSync(`${L.dir}/page/side.json`, stableStringify({ notConfident: m.notConfident, wordsBy: null, tagline }));
    fs.writeFileSync(`${L.dir}/page/ask.json`, stableStringify(buildAsk({ reading: out.reading, charts: out.charts, notes: notes.map(noteText), mapBoxes: res.model.boxes })));   // what the text commands say beside the page: the same questions, numbers and ids
    log(`      ${plural(m.flows.stages.length, 'stage')}, ${plural(m.flows.boxes.length, 'box', 'boxes')}, ${plural(m.flows.routes.length, 'road')}, ${plural(m.flows.charts.length, 'chart')}`);
    add('project', t);
    if (opt['no-page']) break;

    t = performance.now();
    stage(6, total, 'placing the charts');
    const placed = await placeAll(L.dir, m.flows.charts.length, (x) => log(`      ${x}`));
    result.hardLeft = placed.hardLeft;
    add('place', t);

    t = performance.now();
    stage(7, total, 'building the page');
    await buildProject(L.dir, { finished: false, draft: true, place: false, root, log: () => {} });
    injectPage({ readDir: L.read, projDir: L.dir, readerDir: path.join(here, 'reader') });
    add('build', t);
    const html = `${L.dir}/dist/atlas.html`;
    result.page = html;
    result.pageBytes = fs.statSync(html).size;
    if (result.pageBytes <= PAGE_LIMIT || attempt >= 3) break;
    chartBytes = Math.max(0, (chartBytes ?? HOT_BYTES) - Math.ceil((result.pageBytes - PAGE_LIMIT) * 1.25));
    log(`      the page is ${(result.pageBytes / 1e6).toFixed(1)} MB, over the ${(PAGE_LIMIT / 1e6).toFixed(1)} MB limit: drawing fewer charts (budget ${(chartBytes / 1e6).toFixed(1)} MB)`);
  }
  for (const x of notes) log(`note: ${noteText(x)}`);
  return result;
}
