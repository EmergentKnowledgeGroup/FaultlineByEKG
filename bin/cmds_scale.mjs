// Commands for mapping a large system with several agents: plan worklist join parts.
import path from 'node:path';
import { readProject, requireRoot, CliError } from '../src/build/project.mjs';
import { loadModelReport } from '../src/model/index.mjs';
import { chartsFromModel } from '../src/build/charts.mjs';
import { partNameWarnings } from '../src/model/partnames.mjs';
import { readPlan, stageTable, stageWork, joinHandoffs, checkHandoffs, ASKS } from '../src/build/worklist.mjs';
import { parse } from './args.mjs';
import { proj, needProject, handOnly } from './cmds_project.mjs';
import { plural } from '../src/build/util.mjs';

const out = (s = '') => console.log(s);
function load(o, cmd) {
  const p = proj(o);
  needProject(p);
  handOnly(p, cmd);
  const data = readProject(p.dir);
  if (!data.facts) throw new CliError('No facts yet. Fix: run  faultline extract.', 2);
  const rep = loadModelReport(p.dir);
  if (!rep.model) throw new CliError(`The model does not load: ${(rep.refusals || []).map((r) => r.msg).join(' ') || 'unknown'}`, 1);
  return { p, ...data, model: rep.model, rep };
}

// `parts`: every chart part of a split stage and its boxes, so someone can name them (model/95-parts.json).
export async function parts(argv) {
  const { o } = parse(argv, { str: ['stage'] });
  const c = load(o, 'parts'), charts = chartsFromModel(c.model), split = charts.filter((ch) => ch.kind === 'stage' && ch.parts > 1 && (!o.stage || ch.stage === o.stage));
  if (o.stage && !charts.some((ch) => ch.stage === o.stage)) throw new CliError(`No chart is in stage ${o.stage}. Stages: ${(c.model.stages || []).map((x) => x.id).join(', ')}.`, 2);
  const byId = new Map(c.model.boxes.map((b) => [b.id, b])), short = (sym) => String(sym).split('::').slice(1).join('::') || String(sym);
  const out1 = (s) => out(s);
  for (const ch of split) {
    out(`\n${ch.id}  "${ch.name}"  (${plural(ch.boxes.length, 'box', 'boxes')}, ${plural(ch.routes.length, 'route')})`);
    const src = ch.nameBox ? `given by box ${ch.nameBox}${ch.nameBox === ch.entry ? ' (the part\'s first box)' : ' (not the first box in the part)'}` : 'none given: the first box\'s title';
    out1(`  name: ${src}`);
    const fns = new Map();
    for (const b of ch.boxes) { const r = (b.refs || [])[0]; if (r && r.symbol) fns.set(short(r.symbol), (fns.get(short(r.symbol)) || 0) + 1); }
    out1(`  holds: ${[...fns.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 3).map(([f, n]) => `${f} ${n}`).join(', ') || 'no cited functions'}`);
    out1(`  starts: ${(ch.first || []).map((id) => `${id} "${(byId.get(id) || {}).title || ''}"`).join(' > ')}`);
    if (ch.nameDup) out1(`  ! the name "${ch.nameDup}" is also another part's in this stage; this one shows as "${ch.name}"`);
    for (const x of ch.nameOther || []) out1(`  ! box ${x.box} also names this part "${x.name}"; only the first in reading order counts`);
  }
  if (!split.length) out(o.stage ? `Stage ${o.stage} is not split into parts.` : 'No stage is split into parts (a stage above 21 boxes is).');
  const probs = partNameWarnings(c.model, o.stage ? charts.filter((ch) => ch.stage === o.stage) : charts);
  if (probs.length) { out(`\nW-part-name ${probs.length}: names that may mislead (check lists them too)`); for (const w of probs.slice(0, 30)) out(`  ${w.msg}`); if (probs.length > 30) out(`  and ${probs.length - 30} more`); }
  else if (split.length) out('\nEvery part has its own name.');
  out('Name a part: model/95-parts.json  {"partNames": {"<any box id in the part>": "What this part does"}}  (48 characters at most)');
  return 0;
}

// `plan`: one line per stage. The owner of the whole map reads this to see who is done and what nobody owns.
export async function plan(argv) {
  const { o } = parse(argv);
  const c = load(o, 'plan'), pl = readPlan(c.p.dir);
  if (!pl) { out('No stageplan.json yet. Write {"modules":{"<module path>":"<stage id>"}} in the project folder: every module in one stage or excluded in the model.'); return 1; }
  const t = stageTable(c.model, c.facts, c.census, pl);
  if (o.json) { out(JSON.stringify(t)); return 0; }
  out(`census rows left ${t.left} of ${t.total}. Modules nobody owns: ${t.unowned.length}.`);
  out('stage                modules   lines   funcs  rows  left  boxes routes');
  for (const s of t.stages) out(`${s.id.padEnd(20)} ${String(s.modules).padStart(6)} ${String(s.lines).padStart(7)} ${String(s.fns).padStart(7)} ${String(s.rows).padStart(5)} ${String(s.left).padStart(5)} ${String(s.boxes).padStart(6)} ${String(s.routes).padStart(6)}`);
  if (t.unowned.length) {
    out('\nNOBODY OWNS (give each a stage in stageplan.json, or exclude it in the model with a why):');
    for (const m of t.unowned) out(`  ${m.path} (${plural(m.lines, 'line')})`);
  }
  if (t.unownedRows) out(`\n${t.unownedRows} census rows left in modules nobody owns.`);
  return 0;
}

// `worklist <stage>`: everything one mapping agent needs to start and to see what is left. No token cap: this is a job list.
export async function worklist(argv) {
  const { pos, o } = parse(argv);
  const c = load(o, 'worklist'), pl = readPlan(c.p.dir);
  if (!pl) throw new CliError('No stageplan.json yet. Fix: write {"modules":{"<module path>":"<stage id>"}} in the project folder.', 2);
  if (!pos[0]) throw new CliError('Which stage? Fix: faultline worklist <stage id> (faultline plan lists them).', 2);
  const w = stageWork(c.model, c.facts, c.census, pl, pos[0]);
  if (!w.modules.length) throw new CliError(`No modules are planned for stage ${pos[0]}. Fix: check the id against faultline plan.`, 2);
  const ho = checkHandoffs(c.p.dir, c.model, c.facts, pos[0]);
  if (o.json) { out(JSON.stringify({ ...w, handoffs: { rows: ho.rows, ok: ho.ok, bad: ho.bad, asks: ho.asks, returns: ho.returns, g5: ho.g5 } })); return 0; }
  const lines = w.modules.reduce((a, m) => a + (m.lines || 0), 0);
  out(`STAGE ${w.stage} "${w.title}": ${plural(w.modules.length, 'module')}, ${plural(lines, 'line')}. Boxes so far ${w.boxes.length}. Census rows left ${w.left.length} of ${w.rows}.`);
  out('\nMODULES (biggest first)');
  for (const m of w.modules) out(`  ${m.path} (${m.lines})${m.doc ? '  ' + m.doc.slice(0, 90) : ''}`);
  if (w.entries.length) {
    out('\nDOORS (what the code says calls in from outside)');
    for (const e of w.entries) out(`  ${e.kind.padEnd(7)} ${e.fn}`);
  }
  if (w.switches.length) { out('\nSWITCHES'); for (const s of w.switches) out(`  ${s.id} default=${s.default}${s.offByDefault ? ' OFF BY DEFAULT' : ''}`); }
  if (w.passes.length) { out('\nLOOPS AND RETRIES'); for (const p of w.passes) out(`  ${p.fn}:${p.line} ${p.kind} ${p.bounded ? 'bounded' : 'no limit in the test'}${p.why ? '  ' + p.why : ''}`); }
  if (w.left.length) {
    out('\nROWS LEFT. Each needs a ledger line: {"box":id} {"route":id} {"merged":id,"why":...} or {"excluded":why}');
    const byFn = new Map();
    for (const r of w.left) { if (!byFn.has(r.fn)) byFn.set(r.fn, []); byFn.get(r.fn).push(r); }
    for (const [fn, rows] of [...byFn.entries()].sort()) {
      out(`  ${fn}`);
      for (const r of rows.sort((a, b) => a.line - b.line)) out(`    ${r.id}  :${r.line} ${r.what === 'ending' ? `ends ${r.kind} ${r.value ?? ''}${r.msg ? ' "' + r.msg + '"' : ''}` : `if ${r.test ?? ''}`}`);
    }
  }
  out('');
  out(`HAND-OFFS (read-only check of handoffs/*.json rows from this stage; nothing is written, and join is not yours to run)`);
  out(`hand-offs: ${ho.ok} ok, ${ho.bad.length} would not resolve`);
  for (const b of ho.bad) out(`  ${b.file}: ${b.from} -> ${b.to}  ${b.why}${b.near.length ? '  near: ' + b.near.join(', ') : ''}`);
  if (ho.asks.length) {
    out(`  ${ho.asks.length} would land with a question for a person (they go to handoffs.review.json at join):`);
    for (const a of ho.asks) out(`  ${a.file}: ${a.from} -> ${a.to}  lands on ${a.lands}: ${a.reasons.join('; ')}`);
  }
  if (ho.returns.total) out(`  returns with no "to" (${ho.returns.total}) would land by the roads: ${ho.returns.caller} on the caller, ${ho.returns.line} on the exact toLine, ${ho.returns.nearestLine} nearest toLine, ${ho.returns.first} first box (caller not found), ${ho.returns.tie} ties. Write "to" where you know the box.`);
  if (ho.g5.length) {
    out(`G5 AFTER JOIN: ${ho.g5.length} box${ho.g5.length === 1 ? '' : 'es'} would have several exits once your hand-offs are joined, and a road out of it has an empty "when" (gate G5 refuses that). Give each its condition:`);
    for (const b of ho.g5.slice(0, 40)) out(`  ${b.box}: ${b.exits} exits (${b.existing} drawn, ${b.adds} from hand-offs); no condition on ${b.empties.map((e) => (e.kind === 'route' ? `route ${e.id} -> ${e.to}` : `hand-off in ${e.file} -> ${e.to}`)).slice(0, 4).join('; ')}${b.empties.length > 4 ? ` +${b.empties.length - 4}` : ''}`);
    if (ho.g5.length > 40) out(`  and ${ho.g5.length - 40} more boxes`);
  }
  if (c.rep.refusals.length) { out(''); out(`The whole model has ${c.rep.refusals.length} problem(s) in its fragments; faultline check --stage ${pos[0]} judges only this stage and is not stopped by them.`); }
  return 0;
}

// `join`: handoffs/*.json become model/80-handoffs.json. What cannot be resolved is listed, never guessed.
export async function join(argv) {
  const { o } = parse(argv);
  const c = load(o, 'join');
  const r = joinHandoffs(c.p.dir, c.model, c.facts);
  const asks = r.review.filter((x) => ASKS.has(x.reason)).length, rt = r.returns;
  out(`join: read ${r.read} hand-offs, wrote ${r.routes} routes to model/80-handoffs.json, ${r.unresolved.length} unresolved, ${asks} for review. Running it again writes the same files.`);
  if (r.counts.laterRef + r.counts.ties + r.counts.onEnding + r.counts.lineOutside) out(`  review (handoffs.review.json): ${r.counts.laterRef} landed on a box that cites the function only as a later reference, ${r.counts.ties} ties, ${r.counts.onEnding} roads onto another stage's ending, ${r.counts.lineOutside} toLine outside the function`);
  if (rt.total) out(`  returns landed by the roads, not by a "to": ${rt.total} (${rt.caller} on the caller, ${rt.line} on the exact toLine, ${rt.nearestLine} nearest toLine, ${rt.first} first box, ${rt.tie} ties). The last three are questions: the caller was not found (handoffs.review.json says how each landed).`);
  for (const u of r.unresolved.slice(0, 40)) out(`  ${u.file}: ${u.from} -> ${u.to || u.toSymbol}  ${u.why}${u.near?.length ? '  near: ' + u.near.join(', ') : ''}`);
  if (r.unresolved.length > 40) out(`  and ${r.unresolved.length - 40} more: ${path.join(c.p.dir, 'handoffs.unresolved.json')}`);
  return 0;
}

// `signals`: read the source again for the shapes the pair, flag, message, handler and swallowed-error checks look at. Writes signals.json
// beside facts.json (or into --out DIR); facts.json and census.json are never touched. Without signals.json those checks simply do not run.
export async function signals(argv) {
  const { o } = parse(argv, { str: ['out', 'include', 'exclude', 'source'] });
  const p = proj(o);
  needProject(p);
  handOnly(p, 'signals');
  requireRoot(p);
  const data = readProject(p.dir);
  if (!data.facts) throw new CliError('No facts yet. Fix: run  faultline extract.', 2);
  const { writeProjectSignals, signalsSummary } = await import('../src/extract/signals.mjs');
  const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const cfg = { ...(data.config || {}), ...(o.include ? { include: csv(o.include) } : {}), ...(o.exclude ? { exclude: csv(o.exclude) } : {}) };
  const sig = await writeProjectSignals(p.root, p.dir, data.facts, cfg, o.out ? path.resolve(o.out) : null);
  if (o.json) { out(JSON.stringify(sig.counts)); return 0; }
  out(signalsSummary(sig));
  for (const s of (sig.skipped || []).slice(0, 5)) out(`  skipped ${s.path || ''} ${s.why || ''}`);
  out(`Wrote ${path.join(o.out ? path.resolve(o.out) : p.dir, 'signals.json')}. The checks it feeds: sticky-flag restart-misses never-sent empty-handler swallowed-error. Next: faultline analyze`);
  return 0;
}
