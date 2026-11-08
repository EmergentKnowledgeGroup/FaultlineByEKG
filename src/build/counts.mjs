// countsOf(model, {breaks, census, findings}) -> the one table of every total the page shows, each with ONE definition.
// The page (viewer/*.js) reads META.counts and prints these; it never re-counts a total of its own. Where a count differs from its neighbour the
// definition says why (the page's "What the numbers count" table prints exactly these). Pure: nothing here reads the disk.
import { limitIsEmpty } from '../model/text.mjs';
import { shortestRoute } from './util.mjs';
import { waitsMap } from '../model/waits.mjs';
import { holdsOf } from './holds.mjs';
import { heardMap } from '../model/heard.mjs';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const dash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');   // the page's own id form for a worked-out loop

// an end box with a road out hands back to its caller (a return road, or a forward road still to repair); one with none stops here
export function endingModes(model) {
  const out = new Map();
  for (const r of model.routes || []) { if (!out.has(r.from)) out.set(r.from, []); out.get(r.from).push(r); }
  const modes = new Map();
  for (const b of model.boxes || []) {
    if (b.kind !== 'end') continue;
    const o = out.get(b.id) || [];
    modes.set(b.id, !o.length ? 'stop' : o.some((r) => (r.type || 'forward') === 'forward') ? 'back-forward' : 'back-return');   // back-return: only return, deliver or record roads out; back-forward: a plain forward road out (the check warns W-end-exit)
  }
  return modes;   // box id -> 'stop' | 'back-return' | 'back-forward'
}
export const modeWord = (m) => (m === 'stop' ? 'stop' : m ? 'back' : '');

// A return road no declared loop already holds still makes a loop: the shortest forward road from where it lands back to where it starts.
// The page lists these as "worked out from return roads". The checks do not look at them (they have no limit field to read).
export function workedOutLoops(model, declared = model.loops || []) {
  const boxes = model.boxes || [], routes = model.routes || [], byId = new Map(boxes.map((b) => [b.id, b])), made = [], seen = new Set();
  const all = declared.map((l) => new Set(l.boxes || []));
  for (const r of routes) {
    if (r.type !== 'return' || !byId.has(r.from) || !byId.has(r.to)) continue;
    if (all.some((s) => s.has(r.from) && s.has(r.to))) continue;
    const id = 'back-' + dash(r.from) + '-' + dash(r.to);
    if (seen.has(id)) continue;
    seen.add(id);
    const p = shortestRoute(boxes, routes, r.to, r.from);
    const ids = p ? [r.to, ...p.map((x) => x.to)] : [r.to, r.from];
    all.push(new Set(ids));
    made.push({ id, title: 'Back to ' + ((byId.get(r.to) || {}).title || r.to), blurb: '', boxes: [...new Set(ids)], limit: '', derived: true });
  }
  return made;
}

// the ledger's account of each census ending row: which box it lands on, and whether that box is an end
function endingRows(model, census) {
  const rows = (census && census.endings) || [], led = model.ledger || {}, boxIds = new Set((model.boxes || []).map((b) => b.id)), ends = new Set((model.boxes || []).filter((b) => b.kind === 'end').map((b) => b.id));
  const routeTo = new Map((model.routes || []).map((r) => [r.id, r.to]));
  const onEnd = new Set(), boxRows = new Map();
  let rowsOnEnds = 0;
  for (const row of rows) {
    const l = isObj(led[row.id]) ? led[row.id] : {};
    const to = l.box && boxIds.has(l.box) ? l.box : l.merged && boxIds.has(l.merged) ? l.merged : l.route && routeTo.has(l.route) ? routeTo.get(l.route) : null;
    if (to && ends.has(to)) { rowsOnEnds++; onEnd.add(to); boxRows.set(to, (boxRows.get(to) || 0) + 1); }
  }
  return { rows: rows.length, rowsOnEnds, boxesWithRow: onEnd.size, boxRows, onEnd };
}
// an ending box with no census row: does the line it cites hold a return or raise the code reader found (and did not count as an ending), or is it neither?
function freeEndings(model, facts, onEnd) {
  const fns = (facts && facts.functions) || {};
  let returnOrRaise = 0, other = 0;
  for (const b of model.boxes || []) {
    if (b.kind !== 'end' || onEnd.has(b.id)) continue;
    const ref = (b.refs || [])[0], fn = ref && fns[ref.symbol];
    const lines = fn ? [...(fn.raises || []), ...(fn.returns || []), ...(fn.excepts || [])].map((x) => x.line) : [];
    if (ref && ref.line != null && lines.some((l) => Math.abs(l - ref.line) <= 1)) returnOrRaise++; else other++;
  }
  return { returnOrRaise, other };
}

// the wait boxes, and what the model says they wait for (the model's `waitsFor`; a wait with no entry is counted as "not said")
function waitCounts(model) {
  const w = waitsMap(model), waits = (model.boxes || []).filter((b) => b.kind === 'wait'), by = { person: 0, machine: 0, outside: 0, time: 0 };
  for (const b of waits) if (w[b.id]) by[w[b.id].on]++;
  return { boxes: waits.length, said: waits.filter((b) => w[b.id]).length, notSaid: waits.filter((b) => !w[b.id]).length, ...by };
}
// what can hold up the main path (holds.mjs): its waits, gates and the loops that touch it
function holdCounts(model, breaks) {
  const h = holdsOf(model, breaks), c = { total: h.length, wait: 0, gate: 0, loop: 0, kept: 0, open: 0, held: 0, dismissed: 0, none: 0, personWaits: 0 };
  for (const r of h) { c[r.kind]++; c[r.state]++; if (r.on === 'person') c.personWaits++; }
  return { ...c, pathSteps: ((model.paths && model.paths[0] && model.paths[0].boxes) || []).length, pathBoxes: new Set((model.paths && model.paths[0] && model.paths[0].boxes) || []).size };
}

// every failure and refusal, by who hears about it (the model's `heardBy`; a box with no entry is "unsaid"). The unit is a box: a failure or refusal ENDING, plus any other box (a step) the model says
// someone hears a failure at while the story goes on. This is the page "How it fails". (The road counts in `people` count roads, not boxes: that is why 2 ending boxes can sit under 6 roads.)
function failCounts(model, silent) {
  const heard = heardMap(model), by = { person: 0, outside: 0, event: 0, caller: 0, log: 0, nobody: 0, unclear: 0, unsaid: 0 };
  let failure = 0, refusal = 0, steps = 0;
  for (const b of model.boxes || []) {
    const isEnd = b.kind === 'end', oc = b.outcome || '', h = heard[b.id];
    if (isEnd && (oc === 'failure' || oc === 'refusal')) { if (oc === 'failure') failure++; else refusal++; by[h ? h.by : 'unsaid']++; }
    else if (!isEnd && h && oc !== 'success' && oc !== 'neutral') { steps++; by[h.by]++; }
  }
  const total = failure + refusal + steps;
  return { total, failure, refusal, steps, by, said: total - by.unsaid, reachPerson: by.person, silent };
}

// the declared main path: the steps it takes (a box that is passed twice counts twice), the different boxes among them, the stages they sit in
function mainPathCounts(model) {
  const ids = (model.paths && model.paths[0] && model.paths[0].boxes) || [], byId = new Map((model.boxes || []).map((b) => [b.id, b]));
  return { steps: ids.length, boxes: new Set(ids).size, stages: new Set(ids.map((id) => (byId.get(id) || {}).stage).filter(Boolean)).size };
}
// roads of a stage, defined ONCE: a road is a route of the model. "inside" = both ends are boxes of the stage (an ending box that belongs to the stage counts as inside), "enter" = a road arriving from another stage,
// "leave" = a road leaving for another stage. The glance chart bundles roads between the same two stages (its lines are bundles); the whole map and the stage panels count these roads. Both pages print these numbers.
function stageRoadCounts(model) {
  const stageOf = new Map((model.boxes || []).map((b) => [b.id, b.stage || '_unstaged'])), out = {};
  const row = (s) => out[s] || (out[s] = { boxes: 0, inside: 0, enter: 0, leave: 0 });
  for (const b of model.boxes || []) row(b.stage || '_unstaged').boxes++;
  for (const r of model.routes || []) {
    const a = stageOf.get(r.from), z = stageOf.get(r.to); if (a == null || z == null) continue;
    if (a === z) row(a).inside++; else { row(a).leave++; row(z).enter++; }
  }
  return out;
}
// switches: the boxes that name a switch or whose status says they sit behind one (or are reached only by a test, or are on by default). One definition, with the parts that make the total.
function switchCounts(model) {
  const bs = model.boxes || [], off = bs.filter((b) => b.status === 'off').length, test = bs.filter((b) => b.status === 'test-only').length, on = bs.filter((b) => b.status === 'default-on').length;
  const named = bs.filter((b) => String(b.switch || '').trim() || b.status === 'off' || b.status === 'test-only' || b.status === 'default-on');
  const liveNamed = bs.filter((b) => String(b.switch || '').trim() && !(b.status === 'off' || b.status === 'test-only' || b.status === 'default-on')).length;
  return { boxes: named.length, off, testOnly: test, defaultOn: on, liveNamed, offAndTest: off + test };
}

export function countsOf(model, o = {}) {
  const { breaks = [], census = null, findings = [], facts = null } = o;
  const boxes = model.boxes || [], routes = model.routes || [], loops = model.loops || [];
  const ends = boxes.filter((b) => b.kind === 'end'), modes = endingModes(model), er = endingRows(model, census);
  const outcome = { success: 0, failure: 0, refusal: 0, neutral: 0 };
  for (const b of ends) { const k = outcome[b.outcome] != null ? b.outcome : 'neutral'; outcome[k]++; }
  const stop = ends.filter((b) => modes.get(b.id) === 'stop').length, backReturn = ends.filter((b) => modes.get(b.id) === 'back-return').length, backForward = ends.filter((b) => modes.get(b.id) === 'back-forward').length;
  // hand-offs to a person: the roads the Operations page lists (a deliver road, or any road that lands on a failure or refusal ending), one per (from, to, type, condition) like the page's own list
  const endBy = new Map(ends.map((b) => [b.id, b])), seen = new Set(), people = { total: 0, failure: 0, refusal: 0, handoff: 0, success: 0, neutral: 0 };
  for (const r of routes) {
    const t = endBy.get(r.to), oc = t ? t.outcome || 'neutral' : '';
    if (!(r.type === 'deliver' || (t && /failure|refusal/.test(oc)))) continue;
    const k = [r.from, r.to, r.type || 'forward', r.when || ''].join('|'); if (seen.has(k)) continue; seen.add(k);
    people.total++; people[t ? (people[oc] != null ? oc : 'neutral') : 'handoff']++;
  }
  // loops
  const worked = workedOutLoops(model), noLimitDecl = loops.filter((l) => limitIsEmpty(l.limit)).length;
  const loopIds = new Set(loops.map((l) => l.id)), nl = breaks.filter((b) => b.check === 'no-limit-loop');
  const lid = (b) => String(b.key || '').split(':').slice(1).join(':');
  const raisedNoLimit = nl.filter((b) => loopIds.has(lid(b)) && limitIsEmpty((loops.find((l) => l.id === lid(b)) || {}).limit)).length;
  const raisedDisputed = nl.filter((b) => loopIds.has(lid(b))).length - raisedNoLimit, raisedCycle = nl.length - raisedNoLimit - raisedDisputed;
  const n = { suspect: 0, open: 0, wait: 0, loop: 0, silent: 0, lead: 0, dismissed: 0, person: 0 };
  for (const b of breaks) n[b.state] = (n[b.state] || 0) + 1;
  const status = { off: 0, testOnly: 0, defaultOn: 0 };
  for (const b of boxes) { if (b.status === 'off') status.off++; else if (b.status === 'test-only') status.testOnly++; else if (b.status === 'default-on') status.defaultOn++; }
  const named = new Set(); for (const f of findings) if (f.shown !== false) for (const id of f.boxes || []) named.add(id);
  const look = n.suspect + n.open + n.wait + n.loop + n.silent;
  return {
    boxes: boxes.length, roads: routes.length, roadsInferred: routes.filter((r) => r.inferred).length, roadsBack: routes.filter((r) => r.type === 'return').length, stages: (model.stages || []).length,
    ends: { boxes: ends.length, stop, back: backReturn + backForward, backReturn, backForward, outcome,
      ...(census ? { census: er.rows, statements: (census && census.counts && census.counts.rawReturnsAndRaises) || 0, lowConfidence: (census && census.counts && census.counts.droppedLowEndings) || 0, ...freeEndings(model, facts, er.onEnd), censusOnEnds: er.rowsOnEnds, censusElsewhere: er.rows - er.rowsOnEnds, boxesWithRow: er.boxesWithRow, boxesWithoutRow: ends.length - er.boxesWithRow } : {}) },
    people,
    loops: { declared: loops.length, spanning: loops.filter((l) => (l.boxes || []).length >= 2).length, workedOut: worked.length, total: loops.length + worked.length,
      noLimit: noLimitDecl + worked.length, noLimitDeclared: noLimitDecl, noLimitWorkedOut: worked.length,
      raised: nl.length, raisedNoLimit, raisedDisputed, raisedCycle, raisedKept: nl.filter((b) => b.state === 'suspect').length, raisedSetAside: nl.filter((b) => b.state === 'dismissed').length },
    slices: Math.max(0, (model.paths || []).length - 1),
    breaks: { kept: n.suspect, open: n.open, waits: n.wait, loops: n.loop, silent: n.silent, look, leads: n.lead, dismissed: n.dismissed, setAside: n.lead + n.dismissed, person: n.person },
    mainPath: mainPathCounts(model),
    stageRoads: stageRoadCounts(model),
    switches: switchCounts(model),
    fails: failCounts(model, n.silent),
    waits: waitCounts(model),
    holds: holdCounts(model, breaks),
    candidates: { onMap: findings.filter((f) => f.shown !== false).length, boxesNamed: named.size },
    status,
    heard: { said: Object.keys(isObj(model.heardBy) ? model.heardBy : {}).length, silent: n.silent },
  };
}

