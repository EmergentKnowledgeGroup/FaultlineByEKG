// Scale helpers for mapping a large system with several agents. Plain facts, no judgement.
//   stageplan.json  {"modules":{"<module path>":"<stage id>"},"split":{"<module path>":[{"match":"<regex on qualname>","stage":"<stage id>"}]}}
//                   who owns which module; split hands parts of one very large module to other stages, first match wins
//   stageTable      one line per stage, plus modules nobody owns
//   stageWork       what one stage still has to draw: modules, doors, switches, loops, census rows left
//   joinHandoffs    roads between stages, written by the side that knows the code, resolved to boxes here (landing rule: handoffs.mjs)
//   checkHandoffs   the same resolution for ONE stage's own hand-offs, writing nothing: what a stage agent runs instead of join
import path from 'node:path';
import fs from 'node:fs';
import { readJson } from './project.mjs';
import { requiredRows, accountedAs } from '../model/finished.mjs';
import { buildGraph } from '../model/graph.mjs';
import { normPath, symbolPath } from '../model/refs.mjs';
export { joinHandoffs, checkHandoffs, resolveHandoffs, landingFor, ASKS } from './handoffs.mjs';

export const readPlan = (dir) => readJson(path.join(dir, 'stageplan.json'), null);

export function stageOf(plan, fn) {
  const mod = symbolPath(fn), qual = String(fn).split('::').slice(1).join('::');
  for (const r of plan?.split?.[mod] || []) if (new RegExp(r.match).test(qual)) return r.stage;
  return plan?.modules?.[mod] || null;
}

function rowsOf(census) {
  const { endings, branches } = requiredRows(census);
  return [...endings.map((r) => ({ ...r, what: 'ending' })), ...branches.map((r) => ({ ...r, what: 'decision' }))];
}

export function stageTable(model, facts, census, plan) {
  const g = buildGraph(model), routeIds = new Set((model.routes || []).map((r) => r.id)), mods = plan?.modules || {};
  const blank = (id, title) => ({ id, title, modules: 0, lines: 0, fns: 0, rows: 0, left: 0, boxes: 0, routes: 0 });
  const by = new Map((model.stages || []).map((s) => [s.id, blank(s.id, s.title)]));
  const row = (id) => { if (!by.has(id)) by.set(id, blank(id, '(not a stage in the model)')); return by.get(id); };
  const excluded = model.modules || {}, unowned = [];
  for (const m of facts.modules || []) {
    const s = mods[normPath(m.path)];
    if (s) { const r = row(s); r.modules++; r.lines += m.lines || 0; }
    else if (!excluded[normPath(m.path)]?.excluded) unowned.push(m);
  }
  for (const id of Object.keys(facts.functions || {})) { const s = stageOf(plan, id); if (s) row(s).fns++; }
  let unownedRows = 0, left = 0, total = 0;
  for (const r of rowsOf(census)) {
    total++;
    const done = !!accountedAs(r.id, model.ledger, g, routeIds), s = stageOf(plan, r.fn);
    if (!done) left++;
    if (s) { const t = row(s); t.rows++; if (!done) t.left++; } else if (!done) unownedRows++;
  }
  for (const b of g.boxes) if (b.stage) row(b.stage).boxes++;
  for (const r of g.routes) { const a = g.byId.get(r.from), b = g.byId.get(r.to); if (a && b && a.stage === b.stage && a.stage) row(a.stage).routes++; }
  return { stages: [...by.values()], unowned: unowned.map((m) => ({ path: m.path, lines: m.lines })), unownedRows, left, total };
}

export function stageWork(model, facts, census, plan, stage) {
  const g = buildGraph(model), routeIds = new Set((model.routes || []).map((r) => r.id)), mods = plan?.modules || {};
  const inStage = (fn) => stageOf(plan, fn) === stage;
  const mine = new Set(Object.entries(mods).filter(([, s]) => s === stage).map(([p]) => normPath(p)));
  for (const [p, rules] of Object.entries(plan?.split || {})) if (rules.some((r) => r.stage === stage)) mine.add(normPath(p));
  const modules = (facts.modules || []).filter((m) => mine.has(normPath(m.path))).map((m) => ({ path: m.path, lines: m.lines, doc: m.doc || '' })).sort((a, b) => b.lines - a.lines);
  const entries = (facts.entries || []).filter((e) => e.kind !== 'test' && inStage(e.fn)).map((e) => ({ fn: e.fn, kind: e.kind }));
  const switches = (census.switches || []).filter((s) => mine.has(normPath(s.path))).map((s) => ({ id: s.id, line: s.line, default: s.default, offByDefault: !!s.offByDefault }));
  const passes = (census.passes || []).filter((p) => inStage(p.fn)).map((p) => ({ fn: p.fn, line: p.line, kind: p.kind, bounded: p.bounded, why: p.why || '' }));
  const rows = rowsOf(census).filter((r) => inStage(r.fn));
  const left = rows.filter((r) => !accountedAs(r.id, model.ledger, g, routeIds));
  const boxes = g.boxes.filter((b) => b.stage === stage).map((b) => b.id);
  return { stage, title: (model.stages || []).find((s) => s.id === stage)?.title || '', modules, entries, switches, passes, rows: rows.length, left, boxes };
}

