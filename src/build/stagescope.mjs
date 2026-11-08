// One stage at a time. A map written by many agents has refusals in other people's files; a stage agent must still be able to judge,
// place and look at its own part.
//   stageScope(model, census, plan, stage)      which ids belong to the stage: boxes, routes, loops, census rows, modules
//   loadScopedModel(dir, stage)                 only the stage's fragments plus 00-*: {model, refusals, files}
//   modelForStage(dir, stage)                   the full model when it merges cleanly, else the scoped one: {model, scoped, note, refusals}
//   stageCheck(state, stage, {finished})        the gates, findings and warnings that are about this stage, ALL of them, and a count of the rest
import { readFragments, mergeFragments, loadModelReport } from '../model/index.mjs';
import { buildGraph } from '../model/graph.mjs';
import { refModule, symbolPath, normPath } from '../model/refs.mjs';
import { stageOf } from './worklist.mjs';
import { trunc } from './util.mjs';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const ROW_KINDS = [['endings', 'ending'], ['branches', 'decision'], ['passes', 'loop'], ['switches', 'switch']];

export function stageScope(model, census, plan, stage) {
  const boxes = new Set((model.boxes || []).filter((b) => b.stage === stage).map((b) => b.id));
  const routes = new Set((model.routes || []).filter((r) => boxes.has(r.from)).map((r) => r.id));
  const loops = new Set((model.loops || []).filter((l) => (l.boxes || []).some((id) => boxes.has(id))).map((l) => l.id));
  // a module belongs to the stage that owns it in the plan, else to the stage whose boxes cite it most
  const votes = new Map();
  for (const b of model.boxes || []) for (const r of Array.isArray(b.refs) ? b.refs : []) {
    const p = refModule(r); if (!p) continue;
    if (!votes.has(p)) votes.set(p, new Map());
    const m = votes.get(p); m.set(b.stage, (m.get(b.stage) || 0) + 1);
  }
  const moduleStage = (p) => {
    const planned = plan && (plan.modules?.[p] || null); if (planned) return planned;
    const m = votes.get(p); if (!m) return null;
    return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  };
  const modules = new Set();
  for (const p of new Set([...Object.keys(plan?.modules || {}).map(normPath), ...votes.keys()])) if (moduleStage(p) === stage) modules.add(p);
  const rows = new Set(), rowInfo = new Map();
  for (const [key, what] of ROW_KINDS) for (const r of census?.[key] || []) {
    rowInfo.set(r.id, { ...r, what });
    const s = (plan && stageOf(plan, r.fn)) || moduleStage(symbolPath(r.fn || ''));
    if (s === stage) rows.add(r.id);
  }
  for (const [id, l] of Object.entries(model.ledger || {})) if (isObj(l) && [l.box, l.merged].some((x) => x && boxes.has(x))) rows.add(id);
  return { stage, boxes, routes, loops, rows, modules, rowInfo, has: (id) => boxes.has(id) || routes.has(id) || loops.has(id) || rows.has(id) || modules.has(id) };
}

// ---------------------------------------------------------------------------------------------------------------- the model, scoped
export function loadScopedModel(dir, stage) {
  const r = readFragments(dir), owner = new Map();
  for (const f of r.fragments) for (const b of f.data.boxes || []) if (isObj(b) && b.id && !owner.has(b.id)) owner.set(b.id, b.stage);
  const mine = (id) => owner.get(id) === stage;
  const keep = r.fragments.filter(({ file, data }) => {
    if (!isObj(data)) return false;
    if (/^00-/.test(file)) return true;
    if ((data.stages || []).some((s) => isObj(s) && s.id === stage)) return true;
    if ((data.boxes || []).some((b) => isObj(b) && b.stage === stage)) return true;
    if ((data.routes || []).some((x) => isObj(x) && mine(x.from))) return true;
    if ((data.loops || []).some((l) => isObj(l) && (l.boxes || []).some(mine))) return true;
    return Object.values(data.ledger || {}).some((l) => isObj(l) && [l.box, l.merged].some((id) => id && mine(id)));
  });
  const m = mergeFragments(keep);
  return { model: m.model, refusals: m.refusals, files: keep.map((f) => f.file), skipped: r.fragments.length - keep.length };
}

// The full model when every fragment merges cleanly (so every key matches the whole map's), else only this stage's fragments.
export function modelForStage(dir, stage) {
  const full = loadModelReport(dir);
  if (!full.refusals.length || !stage) return { model: full.model, scoped: false, note: '', refusals: full.refusals };
  const sc = loadScopedModel(dir, stage);
  return { model: sc.model, scoped: true, refusals: sc.refusals, otherRefusals: full.refusals.length,
    note: `the whole model is refused (${full.refusals.length} problem${full.refusals.length === 1 ? '' : 's'} in the fragments); using only ${stage}'s fragments plus 00-* (${sc.files.length} files, ${sc.skipped} left out)` };
}

// ---------------------------------------------------------------------------------------------------------------- the check
const whatOf = (msg) => msg.replace(/^(?:REFUSE|GAP) \S+ /, '').split(': ')[0];
const fixOf = (msg) => { const m = / Fix: (.*)$/.exec(msg); return m ? m[1].replace(/\.$/, '') : ''; };

// state: an analyzeProject() state built lenient. -> {stage, counts, problems:[{kind, code, what, fix, mine:[{id, text}], other:n}], warnings, findings, other}
export function stageCheck(state, stage, o = {}) {
  const { model, census, findings, validation } = state, plan = state.plan || null;
  const sc = stageScope(model, census, plan, stage), g = buildGraph(model);
  const boxOf = new Map((model.boxes || []).map((b) => [b.id, b])), routeOf = new Map((model.routes || []).map((r) => [r.id, r]));
  const describe = (id) => {
    const b = boxOf.get(id), r = routeOf.get(id), c = sc.rowInfo.get(id), f = findings.find((x) => x.key === id);
    if (b) return `${id}  "${trunc(b.title, 60)}"`;
    if (r) return `${id}  ${r.from} -> ${r.to}${r.when ? `  "${trunc(r.when, 40)}"` : '  (no condition)'}`;
    if (c) return `${id}  ${c.fn ? `${String(c.fn).split('::')[0]}:${c.line}` : ''}  ${c.what}${c.value != null && c.value !== '' ? ` "${trunc(String(c.value), 30)}"` : ''}${c.test ? ` "${trunc(String(c.test), 40)}"` : ''}`.trimEnd();
    if (f) return `${id}  ${trunc(f.question, 90)}`;
    return id;
  };
  const chartIds = new Set((state.charts || []).filter((c) => c.stage === stage).map((c) => c.id));
  const records = [...validation.refusals.map((r) => ({ kind: 'refuse', r })), ...validation.gaps.items.map((r) => ({ kind: 'gap', r }))];
  const problems = [];
  let otherRefusals = 0, otherGaps = 0;
  for (const { kind, r } of records) {
    const ids = r.offenders && r.offenders.length ? r.offenders : r.at ? [r.at] : [];
    const mine = ids.filter((id) => sc.has(id) || chartIds.has(id));
    const rest = (ids.length ? ids.length : r.count || 1) - mine.length;
    if (kind === 'refuse') otherRefusals += rest; else otherGaps += rest;
    if (mine.length) problems.push({ kind, code: r.code, what: whatOf(r.msg), fix: fixOf(r.msg), mine: mine.map((id) => ({ id, text: describe(id) })), other: rest });
  }
  const warnings = validation.warnings.filter((w) => sc.has(w.at) || sc.has(String(w.at))).map((w) => ({ code: w.code, msg: w.msg, at: w.at }));
  const cands = findings.filter((f) => !f.lead && !(f.resolution && f.resolution.state === 'dismissed') && f.boxes.some((id) => sc.boxes.has(id)));
  const loadRefusals = (state.loadRefusals || []).filter((r) => r.code === 'F1');   // a duplicate id is also found by the gates, once; an unreadable file is found only here
  const left = problems.filter((p) => p.code === 'B1').reduce((n, p) => n + p.mine.length, 0);
  return { stage, title: ((model.stages || []).find((s) => s.id === stage) || {}).title || '',
    counts: { boxes: sc.boxes.size, routes: sc.routes.size, loops: sc.loops.size, rows: sc.rows.size, left },
    problems, warnings, findings: cands, other: { refusals: otherRefusals + loadRefusals.length, gaps: otherGaps }, finished: !!o.finished, state: validation.gaps.state, g, describe };
}

export function stageCheckLines(rep) {
  const L = [], c = rep.counts;
  L.push(`check --stage ${rep.stage}${rep.title ? ` "${rep.title}"` : ''} ${rep.finished ? '--finished' : '(draft)'}: ${c.boxes} boxes, ${c.routes} routes, ${c.loops} loops, ${c.rows} ledger rows${c.left ? ` (${c.left} still unaccounted)` : ''}`);
  for (const p of rep.problems) {
    L.push(`${p.kind === 'refuse' ? 'REFUSE' : 'GAP'} ${p.code} ${p.what}: ${p.mine.length} in this stage${p.other ? ` (${p.other} more in other stages)` : ''}`);
    for (const m of p.mine) L.push(`  ${m.text}`);
    if (p.fix) L.push(`  Fix: ${p.fix}`);
  }
  if (rep.warnings.length) {
    L.push(`WARNINGS ${rep.warnings.length}`);
    for (const w of rep.warnings) L.push(`  warn ${w.code}: ${w.msg}`);
  }
  if (rep.findings.length) {
    L.push(`CANDIDATES ${rep.findings.length} (a shape worth a question, not a confirmed problem)`);
    for (const f of rep.findings) L.push(`  ${f.key}${f.agree > 1 ? `  (${f.agree} checks agree)` : ''}: ${f.question}`);
  }
  if (rep.other.refusals || rep.other.gaps) L.push(`other stages have ${rep.other.refusals} refusal${rep.other.refusals === 1 ? '' : 's'}${rep.other.gaps ? ` and ${rep.other.gaps} gap${rep.other.gaps === 1 ? '' : 's'}` : ''}; they do not stop this check`);
  return L;
}
