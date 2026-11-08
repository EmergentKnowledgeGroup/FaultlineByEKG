// Commands that build the map: init extract propose check place build look analyze.
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, readProject, readJson, writeJson, CliError, isDir, isToolMapProject, requireProject } from '../src/build/project.mjs';
import { analyzeProject, buildProject, placeWithProgress, Refused } from '../src/build/pipeline.mjs';
import { pickHints } from '../src/model/propose.mjs';
import { chartsFromModel } from '../src/build/charts.mjs';
import { look } from '../src/build/look.mjs';
import { modelForStage, stageCheck, stageCheckLines } from '../src/build/stagescope.mjs';
import { parse } from './args.mjs';
import { plural } from '../src/build/util.mjs';

const out = (s = '') => console.log(s);
const note = (s) => process.stderr.write(s + '\n');
const rel = (p) => path.relative(process.cwd(), p).split(path.sep).join('/') || '.';
export const proj = (o) => ({ ...resolveProject({ project: o.project, root: o.root }), arg: o.project ?? null });
/** Stops with the plain "no project" sentence (what to run, and the folder that is missing) unless p is a project a command can read. */
export const needProject = (p) => requireProject(p, p.arg);
const quote = (x) => (/\s/.test(x) ? `"${x}"` : x);
const fwd = (x) => String(x).replace(/\\/g, '/');
/** The exact command that reads the code again and makes this project's map and page (the project folder is named when it is not ./.faultline). */
export const refreshCommand = (p) => `faultline map --source ${p.rootKnown === false ? '<the code folder>' : quote(fwd(p.root))}${path.resolve(p.dir) === path.resolve('.faultline') ? '' : ` --project ${quote(fwd(p.dir))}`}`;
/** The commands of the hand-written way make no sense on a project that  faultline map  made: refuse, and name the command that does. */
export function handOnly(p, cmd, instead) {
  if (p.exists && isToolMapProject(p.dir)) throw new CliError(`This project holds a tool map (faultline map made it), and  ${cmd}  belongs to the hand-written way. ${instead || `To read the code again: ${refreshCommand(p)}`}`, 2);
}
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

const STARTER = (name) => ({
  schema: 'faultline.model/1',
  system: { name, tagline: '', summary: '', purpose: '' },
  stages: [], boxes: [], routes: [], paths: [{ id: 'main', title: 'Main path', boxes: [], blurb: '' }], loops: [], terms: [], ledger: {}, modules: {},
});

export async function init(argv) {
  const { o } = parse(argv, { str: ['name'] });
  const p = proj(o), dir = p.dir;
  if (p.exists && isToolMapProject(dir)) { out(`Already a project: ${rel(dir)} holds a tool map (faultline map made it). Next: faultline status   (to read the code again: ${refreshCommand(p)})`); return 0; }
  if (fs.existsSync(path.join(dir, 'model'))) { out(`Already set up: ${rel(dir)}/model exists. Next: faultline extract`); return 0; }
  fs.mkdirSync(path.join(dir, 'model'), { recursive: true });
  const name = o.name || path.basename(path.dirname(dir)) || 'System';
  writeJson(path.join(dir, 'model', '00-system.json'), STARTER(name));
  if (!fs.existsSync(path.join(dir, 'config.json'))) writeJson(path.join(dir, 'config.json'), { include: [], exclude: [] });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'layout/*.geom.json\n# walks made from logs and traces hold the text of the log lines; commit one only on purpose\nwalks/logs-*.walk.jsonl\nwalks/spans-*.walk.jsonl\n');
  out(`Created ${rel(dir)}/ (model/00-system.json, config.json).`);
  out('Next: 1) faultline extract   2) faultline propose   3) write boxes and routes into model/*.json   4) faultline check   5) faultline build');
  return 0;
}

export async function extract(argv) {
  const { o } = parse(argv, { str: ['include', 'exclude'], bool: ['no-defaults'] });
  const p = proj(o); needProject(p); handOnly(p, 'extract');
  const cfg = readJson(path.join(p.dir, 'config.json'), {}) || {};
  const { extract: run, writeOutputs, summary } = await import('../src/extract/index.mjs');
  if (!isDir(p.root)) throw new CliError(`Source folder ${p.root} does not exist. Fix: pass --root DIR.`, 2);
  note(`reading ${p.root} ...`);
  const res = await run(p.root, { include: o.include ? csv(o.include) : cfg.include || [], exclude: o.exclude ? csv(o.exclude) : cfg.exclude || [], noDefaults: !!o['no-defaults'] });
  writeOutputs(res, p.dir);
  out(summary(res));
  out(`Wrote ${rel(p.dir)}/facts.json census.json graph.json. Next: faultline propose`);
  try {                                                               // signals.json: a second, separate read of the source (docs/CONTRACTS.md)
    const { writeProjectSignals, signalsSummary } = await import('../src/extract/signals.mjs');
    out(`${signalsSummary(await writeProjectSignals(p.root, p.dir, res.facts, cfg))}   (wrote ${rel(p.dir)}/signals.json)`);
  } catch (e) { note(`signals.json not written: ${String(e.message).slice(0, 160)}`); }
  return 0;
}

const num = (v, d) => { if (v === undefined) return d; const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new CliError(`Expected a whole number, got "${v}".`, 2); return n; };

export async function propose(argv) {
  const { o } = parse(argv, { str: ['stage', 'limit', 'offset'], bool: ['cross-stage', 'into-islands'] });
  const p = proj(o); needProject(p); handOnly(p, 'propose', 'The questions the reading raised: faultline breaks.');
  const s = await analyzeProject(p.dir, { write: true, proposeOpts: { maxRoutes: Infinity, perBox: Infinity } });
  const pr = s.result.proposals;
  const lim = num(o.limit, 40);
  const hints = pickHints(pr.routes, { stage: o.stage, crossStage: !!o['cross-stage'], intoIslands: !!o['into-islands'], limit: lim, offset: num(o.offset, 0) });
  if (o.json) { out(JSON.stringify({ ...pr, routes: hints.shown, hints: { total: hints.total, matched: hints.matched, from: hints.from } })); return 0; }
  const c = pr.counts || {};
  out(`propose: ${c.routes ?? 0} route hints from the call graph, ${c.unsupportedRoutes ?? 0} drawn routes with no code behind them, ${c.unaccounted ?? 0} census rows not in the ledger, ${c.hotspots ?? 0} uncited hotspots, ${c.unmappedModules ?? 0} modules not cited.`);
  const filt = [o.stage ? `stage ${o.stage}` : '', o['cross-stage'] ? 'cross-stage' : '', o['into-islands'] ? 'into boxes with no road in' : ''].filter(Boolean).join(', ');
  const noIn = pr.routes.filter((r) => r.intoNoWayIn).length;
  out(`HINTS ${hints.shown.length ? `${hints.from + 1}-${hints.from + hints.shown.length}` : 'none'} of ${hints.matched}${filt ? ` matching (${filt})` : ''}, ${hints.total} in all (${c.sameCallElsewhere || 0} more left out: the same call seen from another box that cites the function higher up); ${noIn} run into a box with no road in. Roads that connect an island come first, then the shortest call chains.`);
  hints.shown.forEach((r, i) => {
    const tags = [r.intoNoWayIn ? 'INTO NO-WAY-IN' : '', r.fromIsland ? 'from an island' : r.fromNoWayOut ? 'from a dead end' : '', r.crossStage ? `${r.fromStage} -> ${r.toStage}` : '', r.reverse ? 'road already drawn the other way' : ''].filter(Boolean);
    out(` ${hints.from + i + 1}. ${r.from} -> ${r.to}  ${r.type}, ${r.evidence.hops} call${r.evidence.hops === 1 ? '' : 's'}${tags.length ? '  [' + tags.join('; ') + ']' : ''}`);
    const held = r.holder ? `held by ${r.from}${r.alsoFrom && r.alsoFrom.length ? ` (the same call from ${r.alsoFrom.slice(0, 3).join(', ')}${r.alsoFrom.length > 3 ? ` +${r.alsoFrom.length - 3}` : ''}: they cite that line too)` : ''}` : r.evidence.hops > 1 ? 'in code no box cites' : `no box cites a line above it, so ${r.from} is the nearest`;
    out(`    call at ${r.site ? `${r.site.at}${r.site.lineKnown ? '' : ' (line not recorded)'} in ${r.site.fn}${r.site.calls > 1 ? ` (${r.site.calls} calls)` : ''}` : '?'}; ${held}${r.evidence.hops > 1 ? `; via ${r.evidence.chain.slice(1, -1).map((f) => f.split('::').pop()).join(' > ')}` : ''}`);
    if (r.conditionHints.length) out(`    tests on the way: ${r.conditionHints.slice(0, 2).map((h) => `${h.at} ${h.text}`).join(' | ')}`);
  });
  if (o['into-islands'] && c.noWayInNoHint) {
    out(`  ${c.noWayInNoHint} of ${c.noWayIn} boxes with no road in have no hint from a box (an entry point, an event, or called only from code no box cites). Their direct callers in the call graph:`);
    for (const b of pr.noWayInNoHint.slice(0, lim || 60)) out(`   ${b.box} [${b.stage}] ${b.kind}${b.entry ? ' (a door: ' + b.entry + ')' : ''} "${b.title}": ${b.callerCount ? b.callers.map((k) => `${k.at || k.fn} in ${k.fn.split('::').pop()} ${k.boxes.length ? '(box ' + k.boxes.join(',') + ')' : '(no box cites it)'}`).join('; ') + (b.callerCount > b.callers.length ? ` +${b.callerCount - b.callers.length}` : '') : 'no caller found'}`);
  }
  if (hints.from + hints.shown.length < hints.matched) out(`  ${hints.matched - hints.from - hints.shown.length} more: --offset ${hints.from + hints.shown.length}  (or --limit N, --limit 0 for all)`);
  const look1 = (pr.whereToLook || []).filter((w) => w.kind !== 'route' || !hints.shown.length).slice(0, 9);      // the route hints are listed above
  if (look1.length) { out('WHERE TO LOOK'); look1.forEach((w, i) => out(` ${i + 1}. [${w.kind}] ${w.at}: ${w.ask}`)); }
  out(`Wrote ${rel(p.dir)}/proposals.json (the top 200 hints, ledger drafts and route evidence inside). Filters: --stage ID  --cross-stage  --into-islands  --limit N  --offset N`);
  return 0;
}

// "G5 12, B1 340": how many offenders each code has (a record names the first and counts the rest)
const byCode = (recs) => { const m = new Map(); for (const r of recs) m.set(r.code, (m.get(r.code) || 0) + (r.count || (r.offenders && r.offenders.length) || 1)); return [...m.entries()].map(([c, n]) => `${c} ${n}`).join(', '); };
const countsLine = (v) => [v.refusals.length ? `refuse ${byCode(v.refusals)}` : '', v.gaps.items.length ? `gap ${byCode(v.gaps.items)}` : '', v.warnings.length ? `warn ${byCode(v.warnings)}` : ''].filter(Boolean).join(' | ');

export async function check(argv) {
  const { o } = parse(argv, { str: ['stage'], bool: ['finished', 'draft'] });
  const p = proj(o); needProject(p); handOnly(p, 'check', 'What was read and what is open: faultline status.');
  const finished = !!o.finished;
  if (o.stage) return checkStage(p, o, finished);
  let s;
  try { s = await analyzeProject(p.dir, { finished, write: true }); }
  catch (e) {
    if (e instanceof Refused) {
      for (const r of e.refusals) out(r.msg);
      out(`counts by code: refuse ${byCode(e.refusals)} (receipts.json lists every offender)`);
      out(`check: refused (${e.refusals.length}). Receipts written. To work on one stage anyway:  faultline check --stage <id>`);
      return 1;
    }
    throw e;
  }
  const v = s.validation, g = v.gaps, t = g.tally || {};
  if (o.json) { out(JSON.stringify({ state: g.state, refusals: v.refusals, gaps: g.items, tally: t, warnings: v.warnings, findings: s.findings.length })); return v.refusals.length ? 1 : 0; }
  const acc = (k) => (t[k] ? `${k} ${t[k].accounted}/${t[k].required ?? t[k].total}` : '');
  out(`check ${finished ? '--finished' : '(draft)'}: ${plural(t.boxes, 'box', 'boxes')}, ${plural(t.routes, 'route')}, ${plural(t.stages, 'stage')} | ledger: ${[acc('endings'), acc('branches')].filter(Boolean).join(', ')}, modules ${t.modules ? t.modules.cited + t.modules.excluded : 0}/${t.modules ? t.modules.total : 0}`);
  for (const r of v.refusals) out(r.msg);
  for (const x of g.items) out(x.msg);
  for (const w of v.warnings.slice(0, 6)) out(`warn ${w.code}: ${w.msg}`);
  if (v.warnings.length > 6) out(`warn: ${v.warnings.length - 6} more warnings in receipts.json`);
  if (v.refusals.length || g.items.length || v.warnings.length) out(`counts by code: ${countsLine(v)}  (receipts.json lists every offender; faultline check --stage <id> lists one stage's in full)`);
  { const sh = s.findings.filter((f) => f.shown).length; out(`candidates: ${sh} of ${s.findings.length} shown${sh < s.findings.length ? '; faultline analyze --all for the rest' : '; faultline analyze'}`); }
  if (v.refusals.length) { out(`REFUSED: ${v.refusals.length} gate(s) failed${finished ? ' (finished)' : ''}. Nothing is built from a refused model.`); return 1; }
  out(finished ? 'PASS: every gate holds. Next: faultline build --finished' : (g.items.length ? `DRAFT: ${g.items.length} gap(s) listed above; build still works and shows them on the page. Next: faultline build` : 'Clean. Next: faultline build --finished'));
  return 0;
}

// check --stage: only this stage's boxes, routes, loops, ledger rows and modules are judged, and every offender is listed. A problem in
// another stage's file is counted on one line and never stops the command.
async function checkStage(p, o, finished) {
  const s = await analyzeProject(p.dir, { finished, write: false, lenient: true, stage: o.stage });
  if (!s.model.boxes.some((b) => b.stage === o.stage)) throw new CliError(`No box is in stage ${o.stage}. Stages: ${(s.model.stages || []).map((x) => x.id).join(', ')}.`, 2);
  const rep = stageCheck(s, o.stage, { finished });
  if (o.json) { const { g, describe, ...plain } = rep; out(JSON.stringify(plain)); return rep.problems.some((x) => x.kind === 'refuse') ? 1 : 0; }
  for (const l of stageCheckLines(rep)) out(l);
  const bad = rep.problems.filter((x) => x.kind === 'refuse').length;
  if (bad) { out(`REFUSED: ${bad} gate(s) fail in ${o.stage}${finished ? ' (finished)' : ''}.`); return 1; }
  out(rep.problems.length ? `DRAFT: ${rep.problems.length} gap(s) listed above for ${o.stage}.` : `${o.stage} is clean${finished ? '' : ' (draft gates)'}.`);
  return 0;
}

export async function place(argv) {
  const { pos, o } = parse(argv, { str: ['seed', 'budget', 'stage'], bool: ['force', 'tiled', 'classic', 'prune'] });
  const p = proj(o); needProject(p); handOnly(p, 'place', `faultline map places its own charts. To read the code again: ${refreshCommand(p)}`);
  if (o.tiled && o.classic) throw new CliError('--tiled and --classic cannot be used together.', 2);
  // the whole model when it merges cleanly; with --stage and a refusal somewhere else, only that stage's fragments plus 00-*
  const m = modelForStage(p.dir, o.stage || null);
  if (m.refusals.length) { for (const r of m.refusals) out(r.msg); out(o.stage ? `place: ${o.stage}'s own fragments are refused.` : 'place: refused. To place one stage anyway:  faultline place --stage <id>'); return 1; }
  if (m.note) note(m.note);
  const charts = chartsFromModel(m.model);
  const bad = pos.filter((id) => !charts.some((c) => c.id === id));
  if (bad.length) throw new CliError(`No chart named ${bad.join(', ')}. Charts: ${charts.map((c) => c.id).join(', ')}.`, 2);
  let only = pos.length ? pos : null;
  if (o.stage) {
    const mine = charts.filter((c) => c.stage === o.stage).map((c) => c.id);
    if (!mine.length) throw new CliError(`Stage ${o.stage} has no chart. Stages: ${(m.model.stages || []).map((x) => x.id).join(', ')}.`, 2);
    only = pos.length ? pos.filter((id) => mine.includes(id)) : mine;
  }
  // layouts left behind by an earlier partition: a file in layout/ that no chart has the name of now. Listed always, removed only with --prune.
  const lay = path.join(p.dir, 'layout'), ids = new Set(charts.map((ch) => ch.id));
  const mine = o.stage ? new RegExp(`^stage_${String(o.stage).replace(/^(st|s)_/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()}(_\\d+)?$`) : null;
  const stale = (fs.existsSync(lay) ? fs.readdirSync(lay) : []).filter((f) => f.endsWith('.json') && !f.endsWith('.geom.json')).map((f) => f.slice(0, -5)).filter((id) => !ids.has(id) && (!mine || mine.test(id))).sort();
  const t0 = Date.now();
  const rows = await placeWithProgress(p.dir, m.model, charts, { only, force: !!o.force, seed: +o.seed || 1, budgetSeconds: o.budget ? +o.budget : undefined, tiled: !!o.tiled, classic: !!o.classic, log: note });
  const hard = rows.filter((r) => r.hard.length), capped = rows.filter((r) => r.capped);
  out(`place: ${rows.filter((r) => r.action === 'placed').length} placed, ${rows.filter((r) => r.action !== 'placed').length} kept, ${Math.round((Date.now() - t0) / 1000)} s. ${hard.length ? 'HARD metrics non-zero on ' + hard.map((r) => r.id).join(', ') + ' (check will refuse L1)' : 'Hard metrics 0 on every chart.'}`);
  if (capped.length) out(`CAPPED at the time limit (best layout so far kept; raise --budget to search longer): ${capped.map((r) => `${r.id} ${r.secs} s`).join(', ')}`);
  if (stale.length) {
    if (o.prune) {
      for (const id of stale) for (const f of [`${id}.json`, `${id}.geom.json`]) { try { fs.unlinkSync(path.join(lay, f)); } catch { /* no geometry cache for it */ } }
      out(`pruned ${stale.length} stale layout${stale.length === 1 ? '' : 's'} (no chart has these names now): ${stale.slice(0, 12).join(' ')}${stale.length > 12 ? ` and ${stale.length - 12} more` : ''}`);
    } else out(`STALE: ${stale.length} layout file${stale.length === 1 ? '' : 's'} in ${rel(lay)}/ belong to no chart now (an earlier partition): ${stale.slice(0, 12).join(' ')}${stale.length > 12 ? ` and ${stale.length - 12} more` : ''}. faultline place --prune removes them${o.stage ? ` (only ${o.stage}'s` + ')' : ''}.`);
  }
  out(`Layouts are in ${rel(p.dir)}/layout/<chart>.json: edit one and drop its "_faultline" line to keep it by hand.`);
  return hard.length ? 1 : 0;
}

// `build` on a tool map's project: rebuild its page the way faultline map built it (the Reader and all), from the map and reading already there. No source is read and nothing is placed.
async function buildToolMap(p, o) {
  if (o.finished || o.draft) throw new CliError(`A tool map has no gates to finish and no draft state, so ${o.finished ? '--finished' : '--draft'} does not apply. faultline build  rebuilds its page; to read the code again: ${refreshCommand(p)}`, 2);
  const { rebuildToolPage } = await import('../src/read/page/run.mjs');
  const r = await rebuildToolPage(p.dir, { root: p.root, excerpts: !!o.excerpts, keepMessages: !!o['keep-messages'], sourceBase: o['source-base'] || '', fix: refreshCommand(p) });
  out(`build: tool map page  ${rel(r.html)} (${Math.round(r.bytes / 1024)} KB, ${r.svgs.length} charts, ${r.walks} walk path(s))`);
  out(`  also: ${rel(path.join(r.out, 'atlas.agent.json'))}, ${rel(path.join(r.out, 'BRIEF.md'))}, ${rel(path.join(r.out, 'svg'))}/`);
  out('Next: faultline status   (or open the atlas.html in a browser)');
  return 0;
}

export async function build(argv) {
  const { o } = parse(argv, { str: ['source-base', 'seed', 'budget'], bool: ['finished', 'draft', 'no-place', 'excerpts', 'keep-messages'] });
  const p = proj(o); needProject(p);
  if (o.finished && o.draft) throw new CliError('Choose --draft or --finished, not both.', 2);
  if (isToolMapProject(p.dir)) return buildToolMap(p, o);
  const finished = !!o.finished;
  let r;
  try { r = await buildProject(p.dir, { finished, draft: !!o.draft, place: !o['no-place'], excerpts: !!o.excerpts, keepMessages: !!o['keep-messages'], sourceBase: o['source-base'] || '', root: p.root, seed: +o.seed || 1, budgetSeconds: o.budget ? +o.budget : undefined, log: note }); }
  catch (e) { if (e instanceof Refused) { for (const x of e.refusals) out(x.msg); out(`build: REFUSED (${e.refusals.length}). Fix the lines above, or build without --finished.`); return 1; } throw e; }
  const g = r.state.gaps;
  out(`build: ${r.draft ? 'DRAFT' : 'FINISHED'}  ${rel(r.html)} (${Math.round(r.bytes / 1024)} KB, ${r.svgs.length} charts, ${r.walks} walk path(s))`);
  if (r.unplaced.length) out(`  charts with no layout, listed on the page as not drawn (${r.unplaced.length}): ${r.unplaced.slice(0, 10).join(' ')}${r.unplaced.length > 10 ? ` and ${r.unplaced.length - 10} more` : ''}; faultline place   then build again`);
  if (r.draft && g.items.length) out(`  not drawn yet: ${g.items.map((x) => x.code).join(' ')}; faultline status lists them`);
  out(`  also: ${rel(path.join(r.out, 'atlas.agent.json'))}, ${rel(path.join(r.out, 'BRIEF.md'))}, ${rel(path.join(r.out, 'svg'))}/`);
  out('Next: faultline look --page   (PNGs to view)   or open the atlas.html in a browser.');
  return 0;
}

export async function lookCmd(argv) {
  const { pos, o } = parse(argv, { str: ['width', 'height', 'stage'], bool: ['page', 'ev'] });
  const p = proj(o); needProject(p);
  const r = await look(p.dir, { page: !!o.page, ev: !!o.ev, stage: o.stage || null, ids: pos.length ? pos : null, width: o.width ? +o.width : undefined, height: o.height ? +o.height : undefined });
  for (const n of r.notes || []) out(`look: ${n}`);
  if (!r.ok) { out(`look: skipped. ${r.reason}`); return 1; }
  for (const f of r.files) out(rel(f));
  if (r.errors && r.errors.length) out(`page errors: ${[...new Set(r.errors)].join(' | ')}`);
  out(`look: ${r.files.length} image(s). Open them to see what a person sees.`);
  return r.errors && r.errors.length ? 1 : 0;
}

export async function analyzeCmd(argv) {
  const { o } = parse(argv, { str: ['dismiss', 'keep', 'why', 'by', 'stage'], bool: ['all', 'full'] });
  const p = proj(o); needProject(p); handOnly(p, 'analyze', 'The questions the reading raised: faultline breaks.');
  const file = path.join(p.dir, 'dismissed.json');
  for (const [flag, suspect] of [['dismiss', false], ['keep', true]]) if (o[flag]) {
    if (!o.why || o.why === true) throw new CliError(`--${flag} needs --why "one sentence". A finding is resolved by a reason, never by silence.`, 2);
    const d = readJson(file, {}) || {};
    const by = o.by && o.by !== true ? o.by : 'agent', at = new Date().toISOString().slice(0, 10);          // who answered: --by, else "agent", never "unknown"
    d[o[flag]] = suspect ? { suspect: true, why: o.why, by, at } : { why: o.why, by, at };
    writeJson(file, d);
    out(`${suspect ? 'kept as a suspect' : 'dismissed'}: ${o[flag]} (${rel(file)})`);
  }
  const s = await analyzeProject(p.dir, { write: false });
  if (o.stage && !s.model.boxes.some((b) => b.stage === o.stage) && !s.findings.some((f) => f.cluster === o.stage)) throw new CliError(`No box is in stage ${o.stage}. Stages: ${(s.model.stages || []).map((x) => x.id).join(', ')}.`, 2);
  // --stage keeps a candidate that sits in that stage (its group, or any box of it); --all lists every one, a line each unless --full; without --all the shown ones
  const here = (f) => !o.stage || f.cluster === o.stage || f.boxes.some((b) => (s.model.boxes.find((x) => x.id === b) || {}).stage === o.stage);
  const pool = s.findings.filter(here), fs1 = pool.filter((f) => o.all || f.shown);
  if (o.json) { out(JSON.stringify(fs1)); return 0; }
  const gone = s.findings.filter((f) => f.resolution && f.resolution.state === 'dismissed').length;
  const nLead = s.findings.filter((f) => f.lead && !(f.resolution && f.resolution.state === 'dismissed')).length;
  out(`analyze${o.stage ? ' --stage ' + o.stage : ''}: ${fs1.length} of ${pool.length} ${o.all ? 'listed' : 'shown'}${!o.all && fs1.length < pool.length ? '; --all lists the rest, a line each (--full for every field)' : ''}${o.stage && pool.length < s.findings.length ? ` (${s.findings.length} in the whole map)` : ''}${gone ? ` (${gone} dismissed)` : ''}${nLead ? `, ${nLead} lead(s) not counted as candidates (--all lists them)` : ''}. A candidate is a shape worth a question, not a confirmed problem.`);
  const byStage = new Map();
  for (const f of fs1) { const k = f.cluster || 'map'; if (!byStage.has(k)) byStage.set(k, []); byStage.get(k).push(f); }
  for (const [k, list] of byStage) {
    out(`[${k}]`);
    for (const f of list) {
      if (o.all && !o.full) { out(`  ${f.key}  [${f.boxes.slice(0, 2).join(',') || 'no box'}${f.boxes.length > 2 ? '+' + (f.boxes.length - 2) : ''}]${f.lead ? ' LEAD' : ''}${f.agree > 1 ? ` ${f.agree} agree` : ''}${f.resolution ? ' ' + f.resolution.state : ''}  ? ${f.question.length > 100 ? f.question.slice(0, 97) + '...' : f.question}`); continue; }
      out(`  ${f.key}${f.lead ? '  (LEAD: a weak shape, not a candidate; no gate counts it)' : ''}${f.agree > 1 ? `  (${f.agree} checks agree)` : ''}`); out(`    ? ${f.question}`); out(`    ${f.evidence}`); if (f.resolution) out(`    ${f.resolution.state === 'suspect' ? 'kept as a suspect' : 'dismissed'}: ${f.resolution.why}`); }
  }
  if (!fs1.length) out('  none from the checks that ran (that is not proof the map is clean)');
  for (const n of s.findings.notes || []) out(`note: ${n}`);
  out('Resolve one:  faultline analyze --dismiss KEY --why "..." [--by NAME]   or   --keep KEY --why "..."   (written to dismissed.json, see faultline help)');
  out('A dismissal has to answer the question the candidate asks. "One function, same arguments" is not an answer to what each caller has finished, and "the loop re-checks" is not an answer to what wakes it.');
  return 0;
}
