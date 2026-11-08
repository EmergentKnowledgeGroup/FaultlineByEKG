// analyze(model, facts, census, overlay, {cap, dismissed}) -> findings[]
// Findings are candidates with a shape and one question, never verdicts. Ranked by how many different checks agree
// on the same boxes (a whole number, not a score), grouped by stage, 10 shown by default.
import { buildGraph } from './graph.mjs';
import { indexFacts, citeIndex, refSymbol } from './refs.mjs';
import { plainWords } from './refusal.mjs';
import { canOnlyGoBack, pileUp, hedgedRoute, noWayOut, noWayIn, unreachedFromStart } from './checks_flow.mjs';
import { noLimitLoop, endingNoTest, declaredNeverProduced, hasTestEvidence } from './checks_census.mjs';
import { restartMisses, stickyFlag, neverSent, emptyHandler, swallowedError } from './checks_pairs.mjs';
import { lostWakeup } from './checks_wake.mjs';
import { waitNoWake, sharedDecision } from './checks_wait.mjs';

// The fixed order of checks, which is also the tie-break between findings that tie on kept-suspect and agreement: the sharpest shapes
// (liveness and state defects) first, the flow checks next, and "no limit shown on a loop" last (it is the easiest to dismiss).
// these three read the code for one exact shape, so they rank above agreement between the softer map checks
const SHARP = new Set(['lost-wakeup', 'never-sent', 'sticky-flag']);
const sharp = (f) => (SHARP.has(f.check) ? 0 : 1);
export const CHECKS = ['lost-wakeup', 'sticky-flag', 'restart-misses', 'never-sent', 'shared-decision', 'wait-no-wake', 'empty-handler', 'swallowed-error',
  'can-only-go-back', 'declared-never-produced', 'ending-no-test', 'pile-up', 'no-way-out', 'unreached-from-start', 'no-way-in', 'hedged-route', 'no-limit-loop'];
export const SIGNAL_CHECKS = ['lost-wakeup', 'sticky-flag', 'restart-misses', 'never-sent', 'empty-handler', 'swallowed-error'];
const FOLD = { 'pile-up': ['can-only-go-back'], 'no-way-out': ['can-only-go-back'], 'no-way-in': ['declared-never-produced', 'can-only-go-back'] };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function declaredEntries(model, g, fx) {
  const entries = new Set();
  for (const p of model.paths || []) if (p.boxes?.[0] && g.byId.has(p.boxes[0])) entries.add(p.boxes[0]);
  for (const b of g.boxes) {
    if (b.kind === 'external' && g.inX(b.id).length === 0) entries.add(b.id);
    for (const r of Array.isArray(b.refs) ? b.refs : []) { const e = fx.entries.get(refSymbol(r)); if (e && e.kind !== 'test') entries.add(b.id); }
  }
  return entries;
}

export function analyze(model, facts, census, overlay = null, opts = {}) {
  const g = buildGraph(model), fx = indexFacts(facts);
  const cx = { model, facts, census: census || null, overlay: overlay || null, signals: opts.signals || null, g, fx, cites: citeIndex(model), endIds: g.boxes.filter((b) => b.kind === 'end').map((b) => b.id) };
  cx.entries = declaredEntries(model, g, fx);
  const notes = cx.notes = [];
  if (!cx.endIds.length) notes.push('no end boxes drawn: can-only-go-back was skipped');
  if (!cx.entries.size) notes.push('no declared entry: no-way-in and unreached-from-start were skipped');
  if (!census) notes.push('no census: loop, ending and outcome checks used the model alone');
  else if (!hasTestEvidence(overlay)) notes.push('no test or coverage evidence loaded: ending-no-test was skipped');
  if (cx.signals && cx.signals.pin && facts?.pin?.tree && cx.signals.pin !== facts.pin.tree) notes.push('signals.json was read from a different tree than facts.json: run faultline signals so the pair, flag and handler checks match the code');
  if (!cx.signals) notes.push('no signals.json: the pair, flag, message, handler and swallowed-error checks were skipped (faultline signals writes it)');

  const sigChecks = cx.signals ? [lostWakeup, stickyFlag, restartMisses, neverSent, emptyHandler, swallowedError] : [];
  const raw = [canOnlyGoBack, pileUp, hedgedRoute, noLimitLoop, endingNoTest, declaredNeverProduced, noWayOut, noWayIn, unreachedFromStart, waitNoWake, sharedDecision, ...sigChecks].flatMap((f) => f(cx));
  const weight = new Map(raw.map((f) => [f.key, f.weight || 0]));       // a tie-break inside one check; never part of the finding

  // which different checks touched each box, before anything is folded away
  const boxChecks = new Map();
  for (const f of raw) if (f.check !== 'hedged-route') for (const id of f.boxes) { if (!boxChecks.has(id)) boxChecks.set(id, new Set()); boxChecks.get(id).add(f.check); }

  // fold: one idea, one finding. A pile-up inside a closed region is the same idea as the region.
  const kept = [], byKey = new Map();
  for (const f of raw) { if (!byKey.has(f.key)) { byKey.set(f.key, f); } }
  const list = [...byKey.values()];
  const targets = (f) => (FOLD[f.check] || []).flatMap((c) => list.filter((t) => t.check === c && t.boxes.some((id) => f.boxes.includes(id))));
  for (const f of list) {
    const t = targets(f)[0];
    if (t) { (t.also ||= []).push(f.check); t.evidence += ` Another check finds the same boxes (${f.check.replace(/-/g, ' ')}): ${f.evidence}`; }
    else kept.push(f);
  }

  const stageOrder = new Map((model.stages || []).map((s, i) => [s.id, Number(s.order ?? i + 1)]));
  const clusterOf = (f) => {
    const n = new Map();
    for (const id of f.boxes) { const s = g.byId.get(id)?.stage || ''; n.set(s, (n.get(s) || 0) + 1); }
    return [...n.entries()].sort((a, b) => b[1] - a[1] || (stageOrder.get(a[0]) ?? 99) - (stageOrder.get(b[0]) ?? 99))[0]?.[0] || '';
  };
  const dismissed = opts.dismissed || {};
  const out = kept.map((f) => {
    const checks = new Set(f.check === 'hedged-route' ? [f.check] : [f.check, ...(f.also || [])]);
    if (f.check !== 'hedged-route') for (const id of f.boxes) for (const c of boxChecks.get(id) || []) checks.add(c);
    const o = {
      key: f.key, check: f.check, boxes: f.boxes, routes: f.routes, level: 'suspected',
      question: plainWords(f.question), evidence: plainWords(f.evidence),
      cluster: clusterOf(f), agree: checks.size,
    };
    if (f.also?.length) o.also = [...new Set(f.also)];
    if (f.lead) o.lead = true;
    const d = dismissed[f.key];
    if (isObj(d)) o.resolution = d.suspect === true ? { state: 'suspect', why: String(d.why ?? '') } : String(d.why ?? '').trim() ? { state: 'dismissed', why: String(d.why) } : undefined;
    if (!o.resolution) delete o.resolution;
    if (o.lead && o.resolution?.state === 'suspect') delete o.lead;                // someone kept it as a suspect: it is a candidate now
    return o;
  });
  // Order: kept suspects first (a person already read the code), then how many different checks agree, then the fixed check order, then the
  // check's own weight (a wait fed by a stop-like step, a handler that is empty), then stage order and key so the order never wobbles.
  const suspectFirst = (f) => (f.resolution?.state === 'suspect' ? 0 : 1);
  out.sort((a, b) => (a.lead ? 1 : 0) - (b.lead ? 1 : 0) || suspectFirst(a) - suspectFirst(b) || sharp(a) - sharp(b) || b.agree - a.agree || CHECKS.indexOf(a.check) - CHECKS.indexOf(b.check) || (weight.get(b.key) || 0) - (weight.get(a.key) || 0)
    || (stageOrder.get(a.cluster) ?? 99) - (stageOrder.get(b.cluster) ?? 99) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // Which are shown: kept suspects (a person already read the code) take at most half of the slots, so new shapes show; open candidates fill the rest
  // by rank; if there are not enough open ones, more kept suspects fill in. A lead is never shown by default, and a dismissed one never is.
  const cap = opts.cap ?? 10, suspects = out.filter((f) => f.resolution?.state === 'suspect'), open = out.filter((f) => !f.lead && !f.resolution);
  const keptSlots = Math.min(suspects.length, Math.floor(cap / 2)), openSlots = Math.min(open.length, cap - keptSlots);
  const keptShown = Math.min(suspects.length, cap - openSlots), showSet = new Set([...suspects.slice(0, keptShown), ...open.slice(0, openSlots)]);
  for (const f of out) f.shown = showSet.has(f);
  // a dismissal whose key no longer fires stays in the file; it is counted here, not refused. A signal check's keys are not judged when signals.json is missing.
  const known = new Set(raw.map((f) => f.key)), orphans = Object.keys(dismissed).filter((k) => !known.has(k) && (cx.signals || !SIGNAL_CHECKS.includes(k.split(':')[0])));
  if (orphans.length) notes.push(`${orphans.length} entr${orphans.length === 1 ? 'y' : 'ies'} in dismissed.json match no candidate now (kept in the file, not an error): ${orphans.slice(0, 3).join(', ')}${orphans.length > 3 ? ', ...' : ''}`);
  Object.defineProperty(out, 'orphans', { value: orphans, enumerable: false });
  Object.defineProperty(out, 'notes', { value: notes, enumerable: false });
  return out;
}

// Findings that are shown, grouped by stage in stage order: [{cluster, title, findings}], plus how many are held back.
export function groupFindings(findings, model) {
  const order = new Map((model.stages || []).map((s, i) => [s.id, i]));
  const title = new Map((model.stages || []).map((s) => [s.id, s.title || s.id]));
  const groups = new Map();
  for (const f of findings) if (f.shown) { if (!groups.has(f.cluster)) groups.set(f.cluster, []); groups.get(f.cluster).push(f); }
  const list = [...groups.entries()].sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99)).map(([cluster, fs]) => ({ cluster, title: title.get(cluster) || cluster || 'unstaged', findings: fs }));
  return { groups: list, hidden: findings.filter((f) => !f.shown && f.resolution?.state !== 'dismissed').length, dismissed: findings.filter((f) => f.resolution?.state === 'dismissed').length };
}
