// Gates that are hard only for a finished map (a gap in a draft): B1 B2 M1 S1 S2 E1 A1. Also the census tally.
import { refusal } from './refusal.mjs';
import { normPath, refModule } from './refs.mjs';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;
const KIND_OF_PREFIX = { end: 'endings', branch: 'branches', pass: 'passes', switch: 'switches' };

// Census rows the ledger must account for: endings that are not low confidence, branches weighted decision.
export function requiredRows(census) {
  const endings = (census?.endings || []).filter((e) => e.confidence !== 'low');
  const branches = (census?.branches || []).filter((b) => b.weight === 'decision');
  return { endings, branches };
}

// How a ledger row accounts for a census row: 'box' | 'route' | 'merged' | 'excluded' | null (not accounted)
export function accountedAs(id, ledger, g, routeIds) {
  const l = ledger?.[id];
  if (!isObj(l)) return null;
  if (nonEmpty(l.box) && g.byId.has(l.box)) return 'box';
  if (nonEmpty(l.route) && routeIds.has(l.route)) return 'route';
  if (nonEmpty(l.merged) && g.byId.has(l.merged)) return 'merged';
  if (nonEmpty(l.excluded)) return 'excluded';
  return null;
}

export function citedModules(model) {
  const s = new Set();
  for (const b of model.boxes || []) for (const r of Array.isArray(b.refs) ? b.refs : []) if (isObj(r)) { const p = refModule(r); if (p) s.add(p); }
  return s;
}

export function tally(model, facts, census, g) {
  const ledger = model.ledger || {}, routeIds = new Set((model.routes || []).map((r) => r.id));
  const req = requiredRows(census);
  const count = (rows) => { let acc = 0; for (const r of rows) if (accountedAs(r.id, ledger, g, routeIds)) acc++; return { required: rows.length, accounted: acc }; };
  const cited = citedModules(model);
  const mods = (facts?.modules || []).map((m) => normPath(m.path));
  const excluded = mods.filter((p) => nonEmpty(model.modules?.[p]?.excluded));
  return {
    boxes: g.boxes.length, routes: g.routes.length, stages: (model.stages || []).length,
    inferredRoutes: (model.routes || []).filter((r) => r.inferred).length,
    endings: { total: (census?.endings || []).length, ...count(req.endings) },
    branches: { total: (census?.branches || []).length, ...count(req.branches) },
    passes: { total: (census?.passes || []).length },
    switches: { total: (census?.switches || []).length },
    modules: { total: mods.length, cited: mods.filter((p) => cited.has(p)).length, excluded: excluded.length, uncited: mods.filter((p) => !cited.has(p) && !excluded.includes(p)).length },
  };
}

// A map the tool drew from the code (system.toolMap) has no ledger to account for: nobody wrote its boxes, so these gates have nothing to check.
export const TOOL_MAP_RETIRED = new Set(['B1', 'M1', 'E1', 'S1', 'S2']);

// Returns refusal records for the finished-only gates that fail. The caller decides refusal or gap.
export function finishedGates(model, facts, census, g, opts = {}) {
  const out = [];
  const ledger = model.ledger || {}, routeIds = new Set((model.routes || []).map((r) => r.id));
  const req = requiredRows(census);
  const hasCensus = !!census;

  // B1: census ending or decision branch unaccounted in the ledger. With no census there is nothing to account against.
  if (!hasCensus) out.push(refusal('B1', 'no census to account against', 'census.json is missing', 'run faultline extract first, then give every census row a ledger entry', { at: 'census.json' }));
  if (hasCensus) {
    const miss = [];
    const where = (r) => (r.fn ? `${String(r.fn).split('::')[0]}:${r.line}` : '');
    for (const e of req.endings) if (!accountedAs(e.id, ledger, g, routeIds)) {
      const bits = [e.value != null && e.value !== '' ? `value "${e.value}"` : '', where(e)].filter(Boolean).join(', ');
      miss.push({ id: e.id, text: `ending ${e.id}${bits ? ` (${bits})` : ''}` });
    }
    for (const b of req.branches) if (!accountedAs(b.id, ledger, g, routeIds)) {
      const bits = [where(b), b.test ? `"${String(b.test).slice(0, 40)}"` : ''].filter(Boolean).join(', ');
      miss.push({ id: b.id, text: `decision branch ${b.id}${bits ? ` (${bits})` : ''}` });
    }
    if (miss.length) {
      const total = req.endings.length + req.branches.length;
      out.push(refusal('B1', `census rows not accounted in the ledger (${miss.length} of ${total})`, miss[0].text,
        'give each census row a ledger entry: {"box":id}, {"route":id}, {"merged":boxId,"why":"..."} or {"excluded":"why"}; faultline propose lists a suggested box for each',
        { at: miss[0].id, offenders: miss.map((m) => m.id), extra: { missing: miss.length, total } }));
    }
  }

  // B2: merges above 8 per box need a why per row; exclusions above 25% of a census kind
  const merges = new Map();
  for (const [id, l] of Object.entries(ledger)) if (isObj(l) && nonEmpty(l.merged)) { if (!merges.has(l.merged)) merges.set(l.merged, []); merges.get(l.merged).push({ id, why: l.why }); }
  const MERGE_CAP = opts.mergeCap ?? 8, EXCL_MAX = opts.exclusionShare ?? 0.25;
  const noWhy = [];
  for (const [box, rows] of merges) if (rows.length > MERGE_CAP) for (const r of rows) if (!nonEmpty(r.why)) noWhy.push({ box, n: rows.length, id: r.id });
  if (noWhy.length) {
    const f = noWhy[0];
    out.push(refusal('B2', `merges above ${MERGE_CAP} per box need a why on every row`, `box ${f.box} merges ${f.n} census rows and row ${f.id} has no why`, 'write a "why" on each merged row saying what it shares with the box, or split the box so one box does not hide a subsystem', { at: f.box, offenders: noWhy.map((x) => x.id) }));
  }
  if (hasCensus) {
    const denom = { endings: req.endings.length, branches: req.branches.length, passes: (census.passes || []).length, switches: (census.switches || []).length };
    const exc = { endings: 0, branches: 0, passes: 0, switches: 0 };
    for (const [id, l] of Object.entries(ledger)) {
      if (!isObj(l) || !nonEmpty(l.excluded)) continue;
      const kind = KIND_OF_PREFIX[id.split(':')[0]];
      if (kind) exc[kind]++;
    }
    for (const kind of Object.keys(denom)) {
      if (denom[kind] > 0 && exc[kind] / denom[kind] > EXCL_MAX) {
        out.push(refusal('B2', `exclusions above ${Math.round(EXCL_MAX * 100)}% of a census kind`, `${exc[kind]} of ${denom[kind]} ${kind} (${Math.round((100 * exc[kind]) / denom[kind])}%) are excluded`, `draw the ${kind} instead of excluding them, or merge them into boxes with a why; exclusions are for rows that truly do not matter`, { at: kind }));
      }
    }
  }

  // M1: every module cited by some box or excluded with a reason
  if (facts) {
    const cited = citedModules(model);
    const bad = (facts.modules || []).map((m) => normPath(m.path)).filter((p) => !cited.has(p) && !nonEmpty(model.modules?.[p]?.excluded));
    if (bad.length) out.push(refusal('M1', 'module neither cited nor excluded', `${bad[0]} is cited by no box`, `cite it from a box ref, or add modules["${bad[0]}"] = {"excluded":"why"}`, { at: bad[0], offenders: bad }));
  }

  // S1: a straight list (60%+ of boxes with exactly one road in and one out) while the census has 10+ decision branches
  const decisions = (census?.branches || []).filter((b) => b.weight === 'decision').length;
  if (hasCensus && decisions >= 10 && g.boxes.length) {
    const straight = g.boxes.filter((b) => g.inX(b.id).length === 1 && g.outX(b.id).length === 1).length;
    const share = straight / g.boxes.length;
    if (share >= 0.6) out.push(refusal('S1', 'the map is a straight list', `${straight} of ${g.boxes.length} boxes (${Math.round(share * 100)}%) have exactly one road in and one out, while the census has ${decisions} decision branches`,
      'draw the refusals, retries, holds and other branches the census lists: a real system has boxes with several exits', { at: 'map' }));
  }

  // S2: no return route though the census has loops or retries
  if (hasCensus && (census.passes || []).length > 0 && !g.routes.some((r) => r.type === 'return')) {
    out.push(refusal('S2', 'no return route drawn', `the census lists ${(census.passes || []).length} loops or retries and no route has type "return"`, 'draw the road back for each loop or retry as a return route, and list it under loops with its limit', { at: 'map' }));
  }

  // E1: fewer end boxes than distinct non-low outcome values
  if (hasCensus) {
    // a value counts unless the ledger sends its rows somewhere that is not an end (a non-end box, a route, a merge into a non-end box, an exclusion);
    // "JobStatus.DONE" and "done" are one value. Rows with no ledger entry still count, so a draft keeps its old reading.
    const endIds = new Set(g.boxes.filter((b) => b.kind === 'end').map((b) => b.id));
    const norm = (v) => String(v).replace(/^[A-Za-z_]\w*\./, '').toLowerCase();
    const notAnEnd = (id) => { const how = accountedAs(id, ledger, g, routeIds), l = ledger[id]; return how === 'route' || how === 'excluded' || (how === 'box' && !endIds.has(l.box)) || (how === 'merged' && !endIds.has(l.merged)); };
    const vals = new Set((census.endings || []).filter((e) => e.confidence !== 'low' && (e.kind === 'outcome' || e.kind === 'status') && e.value != null && e.value !== '' && !notAnEnd(e.id)).map((e) => norm(e.value)));
    const ends = g.boxes.filter((b) => b.kind === 'end').length;
    if (vals.size > ends) out.push(refusal('E1', 'fewer end boxes than outcome values in the census', `${ends} end boxes for ${vals.size} distinct outcome values (${[...vals].slice(0, 6).join(', ')}${vals.size > 6 ? ', ...' : ''})`, 'draw an end box for each way the system can finish, or merge values into one end box with a ledger why', { at: 'map' }));
  }

  // A1: every finding is either kept as a suspect or dismissed with a why. A lead (a shape too often meant on purpose to ask about) is not a finding yet.
  if (Array.isArray(opts.findings)) {
    const d = opts.dismissed || {};
    const open = opts.findings.filter((f) => { const r = d[f.key]; return !(isObj(r) && (r.suspect === true || nonEmpty(r.why))) && !f.lead; });
    if (open.length) out.push(refusal('A1', 'finding unresolved', `${open[0].key}: ${open[0].question}`, 'mark it a suspect or dismiss it with a why in dismissed.json: {"<key>":{"why":"...","by":"...","at":"..."}} or {"<key>":{"suspect":true,"why":"..."}}', { at: open[0].key, offenders: open.map((f) => f.key) }));
  }
  return model.system && model.system.toolMap ? out.filter((r) => !TOOL_MAP_RETIRED.has(r.code)) : out;
}
