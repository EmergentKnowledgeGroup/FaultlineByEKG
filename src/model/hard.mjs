// Gates that are always hard, draft or finished: G1 G2 G3 G4 G5 K1 L1 T1. Each pushes {code,msg,at} records.
import { refusal } from './refusal.mjs';
import { LIMITS, KINDS, STATUSES, OUTCOMES, ROUTE_TYPES, len, startsWithDescriptionVerb } from './text.mjs';
import { normPath, symbolPath, refSymbol, lookupSymbol, nearestSymbol, allRefs } from './refs.mjs';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const HARD_METRICS = ['nodeOverlaps', 'edgeThroughNode', 'trackOverlaps', 'labelOverlapsLabel', 'labelOverlapsNode', 'diagonalSegs', 'shortArrowStubs', 'labelMissing'];

// Collects offenders per (code, what): the first one is named, the rest are counted.
class Bucket {
  constructor() { this.m = new Map(); }
  add(code, what, text, fix, id) {
    const k = `${code}\u0000${what}`;
    if (!this.m.has(k)) this.m.set(k, { code, what, text, fix, ids: [] });
    this.m.get(k).ids.push(String(id));
  }
  refusals() { return [...this.m.values()].map((b) => refusal(b.code, b.what, b.text, b.fix, { at: b.ids[0], offenders: b.ids })); }
}

export function g1(model, fx) {
  const b = new Bucket();
  if (!fx.has) return [refusal('G1', 'no facts to check against', 'facts.json is missing', 'run faultline extract first')];
  for (const { owner, id, ref } of allRefs(model)) {
    const where = `${owner} ${id}`;
    if (!isObj(ref)) { b.add('G1', 'ref cites nothing', `${where} has a ref that is not an object`, 'give each ref a path, a symbol and a line', id); continue; }
    const sym = refSymbol(ref), p = normPath(ref.path || '');
    const line = ref.line == null || ref.line === 0 || ref.line === '' ? null : Number(ref.line);
    if (!sym && !p) { b.add('G1', 'ref cites nothing', `${where} has a ref with no path and no symbol`, 'cite a function as path::Qual.name from facts.json', id); continue; }
    if (line != null && !Number.isInteger(line)) { b.add('G1', 'cited line is not a whole number', `${where} cites line "${ref.line}"`, 'use an integer line inside the cited function', id); continue; }
    if (sym) {
      const f = lookupSymbol(fx, sym);
      if (!f) {
        const near = nearestSymbol(fx, sym);
        b.add('G1', 'cited symbol missing from facts', `${where} cites ${sym}`, near ? `use a symbol that facts.json lists (nearest: ${near}), or drop the ref` : 'use a symbol that facts.json lists (faultline where <file> names the box and symbols there), or drop the ref', id);
        continue;
      }
      if (p && p !== f.path) { b.add('G1', 'cited path does not match its symbol', `${where} cites path ${p} but ${sym} lives in ${f.path}`, 'make path the file part of the symbol', id); continue; }
      if (line != null && !(line >= f.line && line <= (f.end ?? f.line))) {
        b.add('G1', 'cited line outside its function', `${where} cites ${sym} at line ${line}, but that function spans ${f.line}-${f.end ?? f.line}`, 'cite a line inside the function body', id);
      }
    } else {
      const m = fx.modules.get(p);
      if (!m) b.add('G1', 'cited path missing from facts', `${where} cites ${p}`, 'cite a module that facts.json lists, or drop the ref', id);
      else if (line != null && (line < 1 || line > (m.lines || Infinity))) b.add('G1', 'cited line outside its file', `${where} cites ${p} at line ${line}, but the file has ${m.lines} lines`, 'cite a line inside the file', id);
    }
  }
  return b.refusals();
}

export function g2(model) {
  const ids = [];
  for (const bx of model.boxes || []) {
    const ok = Array.isArray(bx.refs) && bx.refs.some((r) => isObj(r) && (r.symbol || r.path));
    if (!ok) ids.push(bx.id);
  }
  return ids.length ? [refusal('G2', 'box without refs', `box ${ids[0]} cites no code`, 'add refs with at least one symbol from facts.json that shows the box is real', { at: ids[0], offenders: ids })] : [];
}

export function g3(model) {
  const b = new Bucket();
  const boxIds = new Set((model.boxes || []).map((x) => x.id)), routeIds = new Set((model.routes || []).map((x) => x.id));
  const stageIds = new Set((model.stages || []).map((x) => x.id));
  for (const r of model.routes || []) {
    const miss = [];
    if (!boxIds.has(r.from)) miss.push(`from "${r.from ?? ''}"`);
    if (!boxIds.has(r.to)) miss.push(`to "${r.to ?? ''}"`);
    if (miss.length) b.add('G3', 'dangling route', `route ${r.id} has ${miss.join(' and ')}, which is not a box`, 'point the route at box ids that exist, or add the box', r.id);
  }
  if (stageIds.size) for (const x of model.boxes || []) if (!stageIds.has(x.stage)) b.add('G3', 'dangling stage', `box ${x.id} sits in stage "${x.stage ?? ''}", which is not defined`, 'set the box stage to an id listed under stages', x.id);
  const lists = [['paths', 'path'], ['loops', 'loop'], ['charts', 'chart']];
  for (const [key, label] of lists) for (const it of model[key] || []) {
    const miss = (it.boxes || []).filter((id) => !boxIds.has(id));
    if (miss.length) b.add('G3', `dangling ${label} member`, `${label} ${it.id} lists box "${miss[0]}", which is not a box`, `list only box ids that exist in ${label} ${it.id}`, it.id);
  }
  for (const [id, row] of Object.entries(model.ledger || {})) {
    if (!isObj(row)) continue;
    if (row.box != null && !boxIds.has(row.box)) b.add('G3', 'dangling ledger row', `ledger row ${id} points at box "${row.box}", which is not a box`, 'point each ledger row at an existing box or route', id);
    else if (row.merged != null && !boxIds.has(row.merged)) b.add('G3', 'dangling ledger row', `ledger row ${id} merges into box "${row.merged}", which is not a box`, 'point each ledger row at an existing box or route', id);
    else if (row.route != null && !routeIds.has(row.route)) b.add('G3', 'dangling ledger row', `ledger row ${id} points at route "${row.route}", which is not a route`, 'point each ledger row at an existing box or route', id);
  }
  return b.refusals();
}

export function g4(model) {
  const out = [];
  const defs = [['boxes', 'box', 'id'], ['routes', 'route', 'id'], ['stages', 'stage', 'id'], ['loops', 'loop', 'id'], ['paths', 'path', 'id'], ['charts', 'chart', 'id']];
  for (const [key, label, f] of defs) {
    const seen = new Set(), dup = [];
    for (const row of model[key] || []) {
      const id = row?.[f];
      if (id == null || id === '') dup.push(`(no ${f})`);
      else if (seen.has(id)) dup.push(id); else seen.add(id);
    }
    if (dup.length) out.push(refusal('G4', `duplicate ${label} id`, dup[0] === `(no ${f})` ? `a ${label} has no id` : `"${dup[0]}" is used by two ${key}`, `give every ${label} its own id; ids are never reused for a different thing`, { at: dup[0], offenders: dup }));
  }
  const terms = new Set(), td = [];
  for (const t of model.terms || []) { const k = String(t.term ?? '').toLowerCase(); if (terms.has(k)) td.push(t.term); else terms.add(k); }
  if (td.length) out.push(refusal('G4', 'duplicate term', `"${td[0]}" is defined twice`, 'define each term once, with the system\'s own word', { at: td[0], offenders: td }));
  return out;
}

export function g5(g) {
  const bad = [];
  for (const bx of g.boxes) {
    const ex = g.outX(bx.id);
    if (ex.length >= 2) for (const r of ex) if (!String(r.when ?? '').trim()) bad.push({ id: r.id, box: bx.id, n: ex.length });
  }
  if (!bad.length) return [];
  const f = bad[0];
  return [refusal('G5', 'route with no condition out of a box with several exits', `route ${f.id} leaves ${f.box} (${f.n} exits) with an empty "when"`, 'write the condition that sends flow down this road, such as "Queue empty", or "Otherwise" for the catch-all', { at: f.id, offenders: bad.map((x) => x.id) })];
}

export function k1(model) {
  const b = new Bucket();
  for (const bx of model.boxes || []) {
    if (!bx.kind || !KINDS.includes(bx.kind)) b.add('K1', 'box without a valid kind', `box ${bx.id} has kind "${bx.kind ?? ''}"`, `set kind to one of ${KINDS.join(', ')}`, bx.id);
    if (!bx.status || !STATUSES.includes(bx.status)) b.add('K1', 'box without a valid status', `box ${bx.id} has status "${bx.status ?? ''}"`, `set status to one of ${STATUSES.join(', ')}`, bx.id);
    if (bx.kind === 'end' && !OUTCOMES.includes(bx.outcome)) b.add('K1', 'end box without an outcome', `box ${bx.id} has outcome "${bx.outcome ?? ''}"`, `set outcome to one of ${OUTCOMES.join(', ')}`, bx.id);
  }
  for (const r of model.routes || []) if (!ROUTE_TYPES.includes(r.type)) b.add('K1', 'route without a valid type', `route ${r.id} has type "${r.type ?? ''}"`, `set type to one of ${ROUTE_TYPES.join(', ')}`, r.id);
  return b.refusals();
}

export function t1(model) {
  const b = new Bucket();
  for (const bx of model.boxes || []) {
    const t = len(bx.title);
    if (!t) b.add('T1', 'box without a title', `box ${bx.id} has no title`, 'write a title of 34 characters or fewer: a verb phrase for actions, a noun for states', bx.id);
    else if (t > LIMITS.titleMax) b.add('T1', 'title over the limit', `box ${bx.id} title is ${t} characters (hard max ${LIMITS.titleMax})`, `cut words to ${LIMITS.titleTarget} characters or fewer; put detail in plain`, bx.id);
    if (len(bx.plain) > LIMITS.plainMax) b.add('T1', 'plain text over the limit', `box ${bx.id} plain is ${len(bx.plain)} characters (max ${LIMITS.plainMax})`, 'cut to one or two sentences in plain words', bx.id);
  }
  for (const r of model.routes || []) {
    const w = String(r.when ?? '');
    if (len(w) > LIMITS.whenMax) b.add('T1', 'route condition over the limit', `route ${r.id} when is ${len(w)} characters (max ${LIMITS.whenMax}): "${w}"`, 'say the condition in a few words and move the detail into why', r.id);
    if (w.trim() && startsWithDescriptionVerb(w)) b.add('T1', 'route condition reads as a description', `route ${r.id} when starts with "${w.trim().split(/\s+/)[0]}": "${w}"`, 'name the condition ("Queue empty"), not what the box does ("checks the queue")', r.id);
  }
  return b.refusals();
}

// geoms: {chartId: metricsObject | {metrics} | geom}. A geom needs opts.metrics (engine metrics()) to be measured.
export function l1(geoms, metricsFn) {
  if (!geoms) return { refusals: [], warnings: [] };
  const bad = [], warnings = [];
  for (const [chart, g] of Object.entries(geoms)) {
    let m = null;
    if (g && HARD_METRICS.some((k) => typeof g[k] === 'number')) m = g;
    else if (g?.metrics && typeof g.metrics === 'object') m = g.metrics;
    else if (typeof metricsFn === 'function' && g) { try { m = metricsFn(g); } catch { m = null; } }
    if (!m) { warnings.push({ code: 'W-layout', msg: `layout for chart ${chart} was not measured: pass metrics or opts.metrics`, at: chart }); continue; }
    const hit = HARD_METRICS.filter((k) => Number(m[k]) > 0);
    if (hit.length) bad.push({ chart, hit: hit.map((k) => `${k}=${m[k]}`) });
  }
  const refusals = bad.length ? [refusal('L1', 'layout has hard problems', `chart ${bad[0].chart} has ${bad[0].hit.join(', ')}`, 'move or widen the cells in layout/<chart>.json (or re-run the placer) until every hard metric is 0', { at: bad[0].chart, offenders: bad.map((x) => x.chart) })] : [];
  return { refusals, warnings };
}
