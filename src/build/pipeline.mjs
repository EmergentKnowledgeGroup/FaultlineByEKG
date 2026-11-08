// The project pipeline the CLI and the agent server share.
//   analyzeProject(dir, {finished, draft, write, place, lenient, stage, log}) -> state    load, (place), walks, findings, gates;
//        throws Refused when the model cannot be judged, unless {lenient}: then the gates run on what loaded and state.loadRefusals keeps the rest
//   placeWithProgress(dir, model, charts, {only, force, seed, budgetSeconds, log}) -> rows    placeProject one chart at a time: [n/total] lines, seconds, capped
//   buildProject(dir, {finished, draft, place, excerpts, keepMessages, sourceBase, root, log}) -> report      state + atlas.html, svg/, atlas.agent.json, BRIEF.md in <dir>/dist
//        excerpts read lines of the code from `root` (no root: none); the caller decides whether that folder may be quoted (mayQuoteCode in project.mjs)
//        a draft build (or --no-place) still builds when charts have no layout: they are listed as not drawn; a finished build refuses
//   pageInfo(dir) -> {built, current, builtAt, changed, recorded}    is dist/atlas.html there, and was it built from the model and layouts that are there now (by content)
//   agentView(dir, opts) -> agentData blob      the compact map, no layout work
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadModelReport, checkProject, validateModel, analyze } from '../model/index.mjs';
import { importWalks } from '../evidence/index.mjs';
import { metrics as engineMetrics } from '../engine/index.mjs';
import { chartsFromModel } from './charts.mjs';
import { placeProject, loadLayouts, layoutPath, HARD } from './layout.mjs';
import { toAtlasData } from './atlasdata.mjs';
import { assemble } from './assemble.mjs';
import { walkPaths } from './walkpaths.mjs';
import { readProject, readJson, writeJson, writeText, CliError, isToolMapProject } from './project.mjs';
import { toolMapExtras } from '../read/page/agentx.mjs';
import { agentData } from '../agent/data.mjs';
import { brief } from '../agent/commands.mjs';
import { readPlan } from './worklist.mjs';

export class Refused extends CliError {
  constructor(refusals, title = 'REFUSED') {
    super(refusals.map((r) => r.msg).join('\n'), 1);
    this.refusals = refusals; this.title = title;
  }
}

// Place charts one at a time so the caller can print progress, and say so when the clock ceiling cut a chart short.
export async function placeWithProgress(dir, model, charts, opts = {}) {
  const { only = null, force = false, seed = 1, budgetSeconds, log = () => {}, tiled = false, classic = false } = opts;
  const todo = charts.filter((c) => !only || only.includes(c.id)), rows = [], tStart = Date.now();
  if (todo.length > 1) log(`placing ${todo.length} charts: a line as each starts and ends, and one every 20 s while a long chart runs`);
  for (let i = 0; i < todo.length; i++) {
    const c = todo[i], tag = `[${i + 1}/${todo.length}]`, t0 = Date.now();
    const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
    // a long chart (the overview poster, a dense stage) must not leave the screen silent: a line every 20 s while it runs (the timer fires whenever the placer yields)
    const beat = setInterval(() => log(`${tag} ${c.id}: still placing, ${secs()} s so far (${Math.round((Date.now() - tStart) / 1000)} s in all)`), 20000);
    let rec;
    try { rec = await placeProject(dir, model, charts, { only: [c.id], force, seed, budgetSeconds, tiled, classic, log: (m) => log(`${tag} ${String(m).replace(/ \(\d+ s\)$/, (x) => (/placing/.test(m) ? x : ` (${secs()} s)`))}`) }); }
    finally { clearInterval(beat); }
    for (const r of rec) {
      const mark = (readJson(layoutPath(dir, r.id)) || {})._faultline || {};
      const capped = !!(r.capped || mark.capped);
      if (capped) log(`${tag} ${r.id}: CAPPED at the time limit; the best layout found so far is kept (hard metrics: ${r.hard && r.hard.length ? r.hard.join(' ') : '0'})`);
      rows.push({ ...r, secs: +secs(), capped });
    }
  }
  return rows;
}

// A tool map's boxes cite a file and a line, and name their function in prov.fn. A walk finds boxes by function id, so for the walks only (the model itself is not changed),
// each reference gets the function it belongs to, when the facts have that function.
export function withWalkSymbols(model, facts) {
  if (!model.system || !model.system.toolMap) return model;
  const fns = (facts && facts.functions) || {};
  return { ...model, boxes: model.boxes.map((b) => (b.prov && b.prov.fn && fns[b.prov.fn] && (b.refs || []).some((r) => !r.symbol) ? { ...b, refs: b.refs.map((r) => (r.symbol ? r : { ...r, symbol: b.prov.fn })) } : b)) };
}

export async function analyzeProject(dir, opts = {}) {
  const { finished = false, draft = false, write = false, place = false, log = () => {}, seed = 1, budgetSeconds, lenient = false, stage = null, proposeOpts } = opts;
  const P = readProject(dir);
  if (!P.facts || !P.census) throw new CliError(`${dir} has no facts.json / census.json. Fix: run  faultline extract  first.`, 2);
  const loaded = loadModelReport(dir);
  if (loaded.refusals.length && !lenient) throw new Refused(loaded.refusals);
  const model = loaded.model;
  if (!model.boxes.length) throw new CliError(`The model in ${dir}/model has no boxes yet. Fix: run  faultline propose  and write the first boxes (see the README, step 3).`, 2);
  const charts = chartsFromModel(model), mine = stage ? charts.filter((c) => c.stage === stage) : charts;
  let L = await loadLayouts(dir, model, mine), placed = [];
  if (place && (L.missing.length || L.stale.length)) {
    placed = await placeWithProgress(dir, model, mine, { only: [...L.missing, ...L.stale], seed, budgetSeconds, log });
    L = await loadLayouts(dir, model, mine);
  }
  const overlay = importWalks(dir, withWalkSymbols(model, P.facts), P.facts, { keepMessages: !!opts.keepMessages });
  let result;
  if (loaded.refusals.length) {               // lenient: judge what loaded; the problems in the fragments are kept beside the gate results
    const findings = analyze(model, P.facts, P.census, overlay, { dismissed: P.dismissed, signals: P.signals });
    const validation = validateModel(model, P.facts, P.census, { finished, geoms: L.metrics, metrics: engineMetrics, findings, dismissed: P.dismissed, charts });
    result = { model, validation, findings };
  } else result = checkProject(dir, { finished, overlay, geoms: L.metrics, metrics: engineMetrics, write, proposeOpts: opts.proposeOpts, charts });
  // the state is what the gates say: finished when every finished-only gate also holds, draft otherwise (--draft keeps the label draft)
  let gaps = result.validation.gaps;
  if (!finished && !draft && !result.validation.refusals.length && !gaps.items.length) {
    const fin = validateModel(model, P.facts, P.census, { finished: true, geoms: L.metrics, metrics: engineMetrics, findings: result.findings, dismissed: P.dismissed, charts });
    if (!fin.refusals.length) gaps = { ...gaps, state: 'finished' };
  }
  const hardOn = Object.entries(L.metrics).filter(([, m]) => HARD.some((k) => m[k] > 0)).map(([id]) => id);
  return { dir, ...P, model, charts, plan: readPlan(dir), layout: L, placed, overlay, result, validation: result.validation, findings: result.findings, gaps, hardOn, loadRefusals: loaded.refusals };
}

// What a page is built from, by content and not by file time (a fresh checkout or a copy changes every time and no content): the model fragments, the saved layouts
// and, for a tool map, its reading. -> { 'model/10-flows.json': '<12 hex>', ... }. Line endings are not content.
export function pageInputs(dir) {
  const out = {};
  const digest = (file) => createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
  const add = (sub, ok) => { try { for (const f of fs.readdirSync(path.join(dir, sub)).sort()) if (ok(f)) out[`${sub}/${f}`] = digest(path.join(dir, sub, f)); } catch { /* no such folder */ } };
  add('model', (f) => f.endsWith('.json'));
  add('layout', (f) => f.endsWith('.json') && !f.endsWith('.geom.json'));
  if (isToolMapProject(dir)) { add('read', (f) => f.endsWith('.json') || f.endsWith('.txt')); add('page', (f) => f.endsWith('.json')); }
  return out;
}

// is the built page there, and was it built from what is there now? The build records the digest of its inputs in dist/atlas.agent.json (layout.page.inputs);
// a page with no record (built by an older version) is built but cannot be called current.
//   -> { built, current, builtAt, changed, recorded }   changed: the first input that differs from the record, 'path changed|added|removed'
export function pageInfo(dir) {
  const st = (f) => { try { return fs.statSync(f); } catch { return null; } };
  const page = st(path.join(dir, 'dist', 'atlas.html'));
  if (!page) return { built: false, current: false, builtAt: null, changed: '', recorded: false };
  const agent = readJson(path.join(dir, 'dist', 'atlas.agent.json'), null);
  const was = agent && agent.layout && agent.layout.page && agent.layout.page.inputs;
  const info = { built: true, current: false, builtAt: page.mtime.toISOString(), changed: '', recorded: !!was };
  if (!was) return info;
  const now = pageInputs(dir);
  const diff = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort().find((k) => was[k] !== now[k]);
  info.current = !diff;
  if (diff) info.changed = `${diff} ${!(diff in was) ? 'was added' : !(diff in now) ? 'was removed' : 'changed'}`;
  return info;
}

const layoutInfo = (s) => ({ charts: s.charts.length, placed: Object.keys(s.layout.geoms).length, stale: [...s.layout.stale, ...s.layout.missing], hard: s.hardOn.length, page: pageInfo(s.dir) });

export function agentFrom(s, o = {}) {
  // a tool map's questions, numbers and ids are the reading's, the same ones its page shows (src/read/page/agentx.mjs); a map written by hand has none of that
  const toolMap = s.model.system && s.model.system.toolMap ? toolMapExtras(s.dir) : null;
  return agentData(s.model, { facts: s.facts, findings: s.findings, overlay: s.overlay, gaps: s.gaps, charts: s.charts, finished: o.finished, layout: layoutInfo(s), toolMap });
}
export async function agentView(dir, o = {}) {
  const s = await analyzeProject(dir, { finished: !!o.finished, write: false });
  return { data: agentFrom(s, o), state: s };
}

export async function buildProject(dir, opts = {}) {
  const { finished = false, place = true, excerpts = false, sourceBase = '', root = null, log = () => {} } = opts;
  const s = await analyzeProject(dir, { finished, draft: !!opts.draft, write: true, place, log, seed: opts.seed, budgetSeconds: opts.budgetSeconds, keepMessages: !!opts.keepMessages });
  if (s.validation.refusals.length) throw new Refused(s.validation.refusals);
  const unplaced = s.charts.filter((c) => !s.layout.geoms[c.id]).map((c) => c.id);
  if (unplaced.length && opts.refuseUnplaced) throw new CliError(opts.refuseUnplaced(unplaced), 1);
  if (unplaced.length && (finished || !(opts.draft || !place))) throw new CliError(`No layout for chart(s): ${unplaced.slice(0, 12).join(', ')}${unplaced.length > 12 ? ` (and ${unplaced.length - 12} more)` : ''}. Fix: run  faultline place${finished ? '' : '  (or build with --draft to list them as not drawn)'}.`, 1);
  const walks = walkPaths(dir, withWalkSymbols(s.model, s.facts), s.facts);
  const cfg = s.config || {};
  const data = toAtlasData(s.model, { charts: s.charts, geoms: s.layout.geoms, metrics: s.layout.metrics, findings: s.findings, overlay: s.overlay, walks, gaps: s.gaps, finished: s.gaps.state === 'finished',
    facts: s.facts, census: s.census, sourceBase: sourceBase || cfg.sourceBase || '' });
  if (unplaced.length) {                       // the page says so: a blank chart is never passed off as an empty one
    const nd = data.meta.notDrawn, items = unplaced.map((id) => ({ path: id, why: 'this chart has no layout yet (faultline place ' + id + ')', id }));
    data.meta.notDrawn = { ...nd, count: (nd.count || 0) + unplaced.length, items: [...items, ...nd.items], note: nd.note };
    data.meta.draft = true; data.meta.unplaced = unplaced;
    for (const id of unplaced) if (data.charts[id]) data.charts[id].unplaced = true;
  }
  const out = path.join(dir, 'dist');
  const asm = assemble(data, out, { excerpts, root });                                  // the folder the caller named, never the one facts.json remembers: that file may be someone else's
  const honest = unplaced.length && s.gaps.state === 'finished' ? { ...s, gaps: { ...s.gaps, state: 'draft' } } : s;   // gates may pass, but a page with blank charts is not finished
  const agent = agentFrom(honest, { finished: honest.gaps.state === 'finished' });
  if (agent.layout && agent.layout.page) { delete agent.layout.page.builtAt; Object.assign(agent.layout.page, { built: true, current: true, changed: '', recorded: true, inputs: pageInputs(dir) }); }   // a build time makes two builds of the same map differ; `status` reads the page's time from disk, not from this file. The inputs are what it was built from, by content.
  if (agent.toolMap) { delete agent.toolMap.fns; delete agent.toolMap.undrawn; }
  delete agent.alias;                                                                  // the long-to-short box id table is for the commands; the file for other readers does not carry it
  writeJson(path.join(out, 'atlas.agent.json'), agent, { pretty: false });
  writeText(path.join(out, 'BRIEF.md'), brief(agent, { linkBase: 'atlas.html' }) + '\n');
  return { ...asm, state: s, data, agent, out, draft: data.meta.draft, walks: walks.length, unplaced };
}
