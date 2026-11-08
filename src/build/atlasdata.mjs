// toAtlasData(model, {charts, geoms, metrics, findings, overlay, walks, gaps, finished, facts, census, sourceBase, pin}) -> atlasData
// The one blob the viewer embeds (viewer/viewer.js documents what it reads). Everything the page shows is generated here from the model:
// navigation, sections, hand-offs between charts (with a why), stage / loop / path regions, the main-path spine, the draft banner and the
// evidence overlay. No words are invented: titles, plain text and conditions are the model's own.
// Breaks (viewer): `breaks` [{key, check, state: suspect|open|lead|dismissed|wait|loop, boxes, routes, question, evidence, stage, agree?, why?}] feeds the page "Where it can break";
// a portal carries `main: true` when its route is a consecutive pair of the declared main path and `syn: true` when it is only the overview's link to a stage (not a road);
// the parts of a stage are numbered with the real ones first (one box, or no road inside, last); a literal (a number, true, undefined, OK) is never a handle;
// `meta.counts` says what each total counts; a slice region carries `path` (its declared path id) so it can be walked.
// Counts (viewer): `meta.counts` is now the ONE table of every total (counts.mjs); the page prints these and never re-counts. An end box carries `ending`: 'stop' (no road out) or 'back' (a road out: it hands back to its caller);
// `heard` {by, how} on an end box from the model's top-level `heardBy`; breaks rows may be state 'silent' (check 'silent-failure'); `loops` also lists the worked-out ones (`derived`);
// a chart part may carry `note` (the model's `partNotes`); the overview's `spine` is the stage-level sequence (consecutive distinct stages, repeats kept).
import { chartsFromModel, homeChart } from './charts.mjs';
import { mainPath, orderedStages, trunc, uniq, plural } from './util.mjs';
import { limitIsEmpty } from '../model/text.mjs';
import { DISMISS_NOTE } from '../model/checks_wait.mjs';
import { balanceLines, nameLines } from '../engine/layout.mjs';
import { heardMap, HEARD_WORDS, HEARD_SHORT, silentBox } from '../model/heard.mjs';
import { countsOf, endingModes, modeWord, workedOutLoops } from './counts.mjs';
import { waitsMap, WAIT_WORDS } from '../model/waits.mjs';
import { holdsOf, HOLD_STATE_WORDS } from './holds.mjs';

// The note to whoever checks a question (what a dismissal has to answer) rides on the evidence for the agent's commands; the reader's page does not carry it.
const forReader = (ev) => String(ev ?? '').split(DISMISS_NOTE).join(' ').replace(/ {2,}/g, ' ').trim();

// A literal is not a name: a bare number, a list of numbers, true/false/null/undefined/none or OK is a value the code returns or compares, never a handle a reader can look up.
const JUNK = /^(?:[-+]?\d+(?:\.\d+)?(?:[\s,]+[-+]?\d+(?:\.\d+)?)*|true|false|null|nil|none|undefined|nan|ok)$/i;
export const isJunkHandle = (h) => JUNK.test(String(h ?? '').trim());
const cleanHandle = (h) => (h && !isJunkHandle(h) ? h : '');

// Cut a text at the end of a sentence (never at a decimal, a dotted name or an abbreviation) so it fits in max characters; a single long sentence is cut at a word with an ellipsis.
const ABBR = /^(?:e\.?g|i\.?e|etc|vs|cf|approx|fig|no|nos|mr|mrs|ms|dr|st|inc|ltd|al)$/i;
export function sentencesOf(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim(), out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '.' && c !== '!' && c !== '?') continue;
    let j = i; while (j + 1 < s.length && /[.!?]/.test(s[j + 1])) j++;
    let k = j + 1; while (k < s.length && /["'’”)\]`]/.test(s[k])) k++;
    if (k < s.length && s[k] !== ' ') { i = j; continue; }                                   // opts.trace, 0.25, a.b: not an end
    const next = s.slice(k + 1).trimStart()[0] || '';
    const word = (s.slice(start, i).match(/(\S+)$/) || [''])[0].replace(/^[("'`]+/, '');
    if (next && /[a-z]/.test(next)) { i = j; continue; }                                    // a lower-case word follows: the sentence goes on
    if (c === '.' && (ABBR.test(word) || /^[A-Z]$/.test(word))) { i = j; continue; }
    out.push(s.slice(start, k).trim()); start = k + 1; i = k;
  }
  if (start < s.length) out.push(s.slice(start).trim());
  return out.filter(Boolean);
}
export function sentenceClip(text, max) {
  const ss = sentencesOf(text); let out = '';
  for (const x of ss) { const t = out ? out + ' ' + x : x; if (t.length > max) break; out = t; }
  return out || trunc(String(text ?? ''), max);
}

const refsOut = (refs) => (Array.isArray(refs) ? refs : []).map((r) => ({ path: r.path, symbol: r.symbol, ...(r.line != null ? { line: r.line } : {}) }));

export function nodeData(b, ex = {}) {
  return {
    ...(ex.ending ? { ending: ex.ending } : {}), ...(ex.heard ? { heard: ex.heard } : {}), ...(ex.waits ? { waits: ex.waits } : {}),
    id: b.id, title: b.title, kind: b.kind || 'step', status: b.status || 'live', handle: cleanHandle(b.handle), plain: b.plain || '', summary: b.plain || '', why: b.why || '',
    inputs: b.inputs || [], outputs: b.outputs || [], failure: b.failure || '', refs: refsOut(b.refs), switch: b.switch || '', outcome: b.outcome || '',
    stage: b.stage || '', family: b.stage || '', ...(b.aliases && b.aliases.length ? { aliases: b.aliases } : {}), ...(b.synth ? { synth: b.synth, boxes: b.boxes } : {}),
  };
}
export function edgeData(r, refsByBox) {
  const when = r.when || '';
  return { id: r.id, from: r.from, to: r.to, type: r.type || 'forward', label: when, short: when, why: r.why || '', refs: refsOut(r.refs && r.refs.length ? r.refs : (refsByBox && refsByBox.get(r.from)) || []),
    inferred: !!r.inferred, ...(r.via ? { via: r.via } : {}) };
}

function metricsOut(m) {
  if (!m) return { size: [400, 200] };
  const o = { size: m.size || [0, 0] };
  for (const k of ['aspect', 'crossings', 'bends', 'fitScale', 'minTextPx', 'score', 'nodeOverlaps', 'edgeThroughNode', 'trackOverlaps', 'labelOverlapsLabel', 'labelOverlapsNode', 'diagonalSegs', 'shortArrowStubs', 'labelMissing']) if (m[k] != null) o[k] = m[k];
  return o;
}

// hand-offs: a route whose ends live in different charts becomes a portal on both sides, with the condition as its label and the route's why
function buildPortals(model, charts, byId) {
  const P = Object.fromEntries(charts.map((c) => [c.id, []]));
  const mp = mainPath(model), mainPair = new Set(); for (let i = 0; i + 1 < mp.length; i++) mainPair.add(mp[i] + '>' + mp[i + 1]);   // consecutive steps of the declared main path: a hand-off that is one of them is the main path's own road
  const home = new Map(model.boxes.map((b) => [b.id, homeChart(charts, b.id)]));
  const title = (id) => (byId.get(id) || {}).title || id;
  const chartTitle = (cid) => (charts.find((c) => c.id === cid) || {}).title || cid;
  for (const r of model.routes || []) {
    const a = home.get(r.from), b = home.get(r.to);
    if (!a || !b || a === b) continue;
    const kind = r.type === 'return' ? 'return' : 'handoff';
    const why = r.why || `Route ${r.id} runs from ${chartTitle(a)} to ${chartTitle(b)}.`, mn = mainPair.has(r.from + '>' + r.to) ? { main: true } : {};
    P[a].push({ id: `${a}:${r.id}:out`, node: r.from, dir: 'out', chart: b, node2: r.to, kind, label: r.when || `To ${trunc(title(r.to), 28)}`, why, route: r.id, ...mn });
    P[b].push({ id: `${b}:${r.id}:in`, node: r.to, dir: 'in', chart: a, node2: r.from, kind, label: r.when || `From ${trunc(title(r.from), 26)}`, why, route: r.id, ...mn });
  }
  // overview boxes open the chart that holds their detail
  const ov = charts.find((c) => c.kind === 'overview');
  if (ov) for (const n of ov.boxes) {
    const first = (n.boxes || [])[0], target = first && home.get(first);
    if (target && target !== ov.id) P[ov.id].push({ id: `${ov.id}:${n.id}:detail`, node: n.id, dir: 'out', chart: target, node2: first, kind: 'detail', label: `Open ${trunc(n.title, 26)}`, why: n.why || `${n.title} is drawn in full on its own chart.`, syn: true });
    if (target && target !== ov.id && n.synth === 'stage') P[target].push({ id: `${target}:${n.id}:zoomed`, node: first, dir: 'in', chart: ov.id, node2: n.id, kind: 'handoff', label: `Part of ${trunc(n.title, 22)}`, why: `On the overview this whole chart is the single box ${n.title}.`, syn: true });
  }
  return P;
}

function nameOf(c, part) { return c.kind === 'stage' && c.parts > 1 ? `${(c.title || '').replace(/ \(part .*$/, '')} ${part || c.part}/${c.parts}` : c.title; }

function buildNav(charts) {
  const by = (k) => charts.filter((c) => c.kind === k).map((c) => c.id);
  const g = [{ group: 'Start here', items: [...by('overview'), ...by('whole')] }];
  if (by('stage').length) g.push({ group: 'Stages', items: by('stage') });
  if (by('detail').length) g.push({ group: 'Other views', items: by('detail') });
  return g.filter((x) => x.items.length);
}

// sections drive the colour dots, "Follow the flow" and the journey strip: overview, one section per stage, other views, then everything on one map
function buildSections(charts, stages) {
  const out = [], ov = charts.filter((c) => c.kind === 'overview');
  if (ov.length) out.push({ id: 'sec_start', title: 'The big picture', charts: ov.map((c) => c.id) });
  for (const s of stages) {
    const cs = charts.filter((c) => c.kind === 'stage' && c.stage === s.id).map((c) => c.id);
    if (cs.length) out.push({ id: 'sec_' + s.id, title: s.title || s.id, charts: cs });
  }
  const det = charts.filter((c) => c.kind === 'detail').map((c) => c.id);
  if (det.length) out.push({ id: 'sec_views', title: 'Other views', charts: det });
  const wh = charts.filter((c) => c.kind === 'whole').map((c) => c.id);
  if (wh.length) out.push({ id: 'sec_whole', title: 'Everything on one map', charts: wh });
  return out;
}

function buildFlow(charts, stages) {
  const order = [...charts.filter((c) => c.kind === 'overview'), ...charts.filter((c) => c.kind === 'stage'), ...charts.filter((c) => c.kind === 'detail'), ...charts.filter((c) => c.kind === 'whole')];
  const sTitle = Object.fromEntries(stages.map((s) => [s.id, s]));
  const blurb = (c) => c.kind === 'overview' ? 'Start here: the stages in order and the ways the system ends.'
    : c.kind === 'whole' ? 'Everything on one page. Hover a stage in the Regions list to light it up.'
    : c.kind === 'stage' ? sentenceClip(c.note || (sTitle[c.stage] || {}).blurb || c.summary, 200) : sentenceClip(c.summary, 200);
  return Object.fromEntries(order.map((c, i) => [c.id, { role: c.kind === 'detail' ? 'detail' : c.kind, order: i + 1, prev: i ? [order[i - 1].id] : [], next: i < order.length - 1 ? [order[i + 1].id] : [], blurb: blurb(c) }]));
}

// the overview's own text: the system summary cut at the end of a sentence, then the note on what the poster does not draw
function overviewSummary(c, model) {
  const sys = model.system || {}, text = sys.summary || sys.tagline || '', at = String(c.summary || '').lastIndexOf(' Shows '), note = at >= 0 ? c.summary.slice(at + 1) : '';
  return ((text ? sentenceClip(text, 400 - note.length) : at >= 0 ? c.summary.slice(0, at) : c.summary) + (note ? ' ' + note : '')).trim();
}
function metaTitle(model) { return `${(model.system && model.system.name) || 'System'} · Faultline atlas`; }

export function pinText(facts, given) {
  if (given) return given;
  const p = facts && facts.pin;
  return p ? (p.git ? `git ${String(p.git).slice(0, 10)}` : p.tree ? `tree ${String(p.tree).slice(0, 10)}` : '') : '';
}

// the census as the viewer's draft banner reads it: endings and branches count the rows the ledger must account for
export function censusMeta(gaps) {
  const t = (gaps && gaps.tally) || {}, c = {};
  if (t.endings) c.endings = { total: t.endings.required, accounted: t.endings.accounted };
  if (t.branches) c.branches = { total: t.branches.required, accounted: t.branches.accounted };
  if (t.modules) c.modules = { total: t.modules.total, accounted: (t.modules.cited || 0) + (t.modules.excluded || 0) };
  return c;
}

// the list beside the map for everything not drawn yet: one line each, file:line where there is one
export function notDrawnOf(gaps, census, cap = 60) {
  const nd = (gaps && gaps.notDrawn) || {}, items = [];
  const rows = new Map([...(census && census.endings) || [], ...(census && census.branches) || []].map((r) => [r.id, r]));
  const at = (r) => (r && r.fn ? `${String(r.fn).split('::')[0]}:${r.line}` : '');
  for (const id of (nd.endings && nd.endings.ids) || []) { const r = rows.get(id); items.push({ path: at(r) || id, why: `ending${r && r.value != null ? ` "${trunc(r.value, 30)}"` : ''} is not accounted for in the ledger`, id }); }
  for (const id of (nd.branches && nd.branches.ids) || []) { const r = rows.get(id); items.push({ path: at(r) || id, why: `decision${r && r.test ? ` "${trunc(r.test, 40)}"` : ''} is not accounted for in the ledger`, id }); }
  for (const p of (nd.modules && nd.modules.ids) || []) items.push({ path: p, why: 'no box cites this file and it is not excluded' });
  const count = ((nd.endings && nd.endings.count) || 0) + ((nd.branches && nd.branches.count) || 0) + ((nd.modules && nd.modules.count) || 0);
  return { count, items: items.slice(0, cap), note: count > Math.min(cap, items.length) ? `${count - Math.min(cap, items.length)} more not listed here; faultline status gives the counts` : '' };
}

// evidence the page can light: per-box levels, routes, candidates, ordered walk paths, and what the importer could not place
function evidenceOf(model, { findings, overlay, walks, stagesById }) {
  const shown = (findings || []).filter((f) => f.shown !== false);
  const hasWalks = overlay && overlay.summary && overlay.summary.walksRead > 0;
  if (!shown.length && !hasWalks) return null;
  const ev = {
    boxes: (overlay && overlay.boxes) || {}, routes: (overlay && overlay.routes) || {},
    findings: shown.map((f) => ({ key: f.key, check: f.check, boxes: f.boxes || [], routes: f.routes || [], question: f.question, evidence: forReader(f.evidence), group: (stagesById[f.cluster] || {}).title || f.cluster || '',
      ...(f.agree > 1 ? { agree: f.agree } : {}) })),
    walks: walks || [],
  };
  if (overlay) for (const k of ['notMapped', 'missingRoutes', 'unexplored', 'stale', 'labels', 'untested', 'neverSeen', 'notReached']) if (overlay[k] && overlay[k].length) ev[k] = overlay[k];
  return ev;
}

// the parts of a stage read best with the real ones first: a part with one box, or with no road inside it, goes last (the part numbers follow this order)
export function partOrder(charts, main = []) {
  // Numbering of the parts of a stage (chart ids never change). Part 1 is the one the stage OPENS on: where the main path enters it, else the biggest real part. After it, the real parts
  // (two or more boxes and a road inside) keep their reading order when the main path goes through the stage, and go biggest first when it does not; the weak ones (one box, or no road inside) come last.
  const weak = (c) => c.boxes.length < 2 || !c.routes.length, no = new Map(), at = new Map();
  main.forEach((id, i) => { if (!at.has(id)) at.set(id, i); });
  const stages = [...new Set(charts.filter((c) => c.kind === 'stage').map((c) => c.stage))];
  for (const sid of stages) {
    const cs = charts.filter((c) => c.kind === 'stage' && c.stage === sid);
    if (cs.length < 2) continue;
    let entry = null, best = Infinity;
    for (const c of cs) for (const b of c.boxes) { const i = at.get(b.id); if (i != null && i < best) { best = i; entry = c; } }
    const hasMain = !!entry;
    if (!entry) { const real = cs.filter((c) => !weak(c)); entry = (real.length ? real : cs).reduce((m, c) => (c.boxes.length > m.boxes.length ? c : m)); }
    cs.map((c, i) => ({ c, i })).sort((x, y) => (y.c === entry) - (x.c === entry) || (weak(x.c) ? 1 : 0) - (weak(y.c) ? 1 : 0) || (hasMain || weak(x.c) ? 0 : y.c.boxes.length - x.c.boxes.length) || x.i - y.i).forEach((x, k) => no.set(x.c.id, k + 1));
  }
  const sortedStage = new Map(stages.map((sid) => [sid, charts.filter((c) => c.kind === 'stage' && c.stage === sid).sort((a, b) => (no.get(a.id) || a.part || 1) - (no.get(b.id) || b.part || 1))]));
  const seen = new Map(), out = charts.map((c) => { if (c.kind !== 'stage') return c; const k = seen.get(c.stage) || 0; seen.set(c.stage, k + 1); return sortedStage.get(c.stage)[k]; });
  return { charts: out, partNo: no };
}

// Where it can break: every finding with the state a reader can act on (kept suspect, open, lead, dismissed with its reason), plus the waits with no time-based exit and the loops with no limit
// that no finding already lists. A shape the map raises as a question, read and not run: never a verdict.
const TIME = /\b(?:time(?:d)?[\s-]?outs?|times?\s+out|timed\s+out|expir\w*|deadline|elapsed|ttl|too\s+long|stall\w*|lease|interval|poll\w*|periodic\w*|heartbeat|tick\w*|backoff|back\s+off|after\s+\d+|\d+\s*(?:ms|milliseconds?|s|secs?|seconds?|min|mins|minutes?|h|hours?)\b|every\s+\d+|retry\s+after|give\s+up|gives\s+up|wake\w*|sleep\w*)\b/i;
export function breaksOf(model, findings) {
  const byId = new Map(model.boxes.map((b) => [b.id, b])), order = new Map(orderedStages(model).map((s, i) => [s.id, i]));
  const stageOf = (ids) => { const n = new Map(); for (const id of ids) { const st = (byId.get(id) || {}).stage || ''; n.set(st, (n.get(st) || 0) + 1); } return [...n.entries()].sort((a, b) => b[1] - a[1] || (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99))[0]?.[0] || ''; };
  const rows = [], have = new Set();
  for (const f of findings || []) {
    const rs = f.resolution && f.resolution.state, state = rs === 'dismissed' ? 'dismissed' : rs === 'suspect' ? 'suspect' : f.lead ? 'lead' : 'open';
    rows.push({ key: f.key, check: f.check, state, boxes: f.boxes || [], routes: f.routes || [], question: f.question || '', evidence: forReader(f.evidence), stage: f.cluster || stageOf(f.boxes || []),
      ...(f.agree > 1 ? { agree: f.agree } : {}), ...(f.resolution && f.resolution.why ? { why: f.resolution.why } : {}), ...(f.shown ? { shown: true } : {}) });
    have.add(f.key);
  }
  const ins = new Map(), outs = new Map();
  for (const r of model.routes || []) { if (!ins.has(r.to)) ins.set(r.to, []); ins.get(r.to).push(r); if (!outs.has(r.from)) outs.set(r.from, []); outs.get(r.from).push(r); }
  const waits = waitsMap(model);
  for (const b of model.boxes) {
    if (b.kind !== 'wait' || have.has('wait-no-wake:' + b.id)) continue;
    const w = waits[b.id];
    if (w && w.on === 'person') {          // a wait on a person: the system doing what it should. Filed apart, outside the count of things to look at.
      rows.push({ key: 'person-wait:' + b.id, check: 'wait-person', state: 'person', boxes: [b.id], routes: [], stage: b.stage || '', question: '', on: 'person', ...(w.how ? { how: w.how } : {}), evidence: w.how ? 'The map says: ' + w.how + '.' : '' });
      continue;
    }
    if (b.status === 'off' || b.status === 'test-only') continue;
    const i = ins.get(b.id) || [], o = outs.get(b.id) || [];
    if (!i.length || TIME.test(`${b.title} ${b.plain} ${b.handle || ''}`) || o.some((r) => TIME.test(`${r.when || ''} ${r.why || ''}`))) continue;
    rows.push({ key: 'wait:' + b.id, check: 'wait-no-timeout', state: 'wait', boxes: [b.id], routes: [], stage: b.stage || '', question: 'What ends this wait if nothing arrives?', ...(w ? { on: w.on, ...(w.how ? { how: w.how } : {}) } : {}),
      evidence: 'No timeout or time-based exit is drawn. ' + (o.length ? 'Ways out drawn: ' + o.slice(0, 3).map((r) => r.when || 'always').join('; ') + '.' : 'No road out is drawn.') });
  }
  for (const l of model.loops || []) {
    const boxes = (l.boxes || []).filter((id) => byId.has(id));
    if (boxes.length < 2 || !limitIsEmpty(l.limit) || have.has('no-limit-loop:' + l.id)) continue;
    rows.push({ key: 'loop:' + l.id, check: 'no-limit-loop', state: 'loop', boxes, routes: [], stage: stageOf(boxes), question: 'What stops this loop?', evidence: ('Loop "' + (l.title || l.id) + '": no limit is shown on the map.' + (l.blurb ? ' ' + sentenceClip(l.blurb, 160) : '')) });
  }
  // Failures nobody is told about: a failure ending the model says is heard by nobody or only by a log. A question, never a gate: no check, count or finished rule depends on it.
  const heard = heardMap(model);
  for (const b of model.boxes) {
    const h = heard[b.id];
    if (!silentBox(b, h)) continue;
    rows.push({ key: 'silent:' + b.id, check: 'silent-failure', state: 'silent', boxes: [b.id], routes: [], stage: b.stage || '', question: 'What happens, and who should know?', by: h.by, ...(h.how ? { how: h.how } : {}),
      evidence: `The map's own note says ${HEARD_WORDS[h.by]}${h.how ? ': ' + h.how : ''}.` });
  }
  return rows;
}

// the road conditions of one chart in even lines (engine/layout.mjs balanceLines): same line count, never wider, so the pill the placer kept still holds them
// A box name gets the same rule (a layout placed before the rule keeps its greedy lines): the box was sized from the greedy wrap and balanceLines is never wider, so no box changes size.
function evenLabels(g) {
  const many = (xs) => xs && xs.some((e) => e.lines && e.lines.length > 1), even = (e) => { if (!e.lines || e.lines.length < 2) return e; const l = e.kind ? nameLines(e.lines, e.kind) : balanceLines(e.lines); return l === e.lines ? e : { ...e, lines: l }; };
  if (!many(g.edges) && !many(g.nodes)) return g;
  return { ...g, ...(many(g.nodes) ? { nodes: g.nodes.map(even) } : {}), ...(many(g.edges) ? { edges: g.edges.map(even) } : {}) };
}

export function toAtlasData(model, opts = {}) {
  const { geoms = {}, metrics = {}, findings = [], overlay = null, walks = [], gaps = null, finished = false, facts = null, census = null, sourceBase = '' } = opts;
  const { charts, partNo } = partOrder(opts.charts || chartsFromModel(model), mainPath(model));            // parts of a stage: the ones with real boxes and roads first
  const stages = orderedStages(model), stagesById = Object.fromEntries(stages.map((s) => [s.id, s]));
  const byId = new Map(model.boxes.map((b) => [b.id, b])), refsByBox = new Map(model.boxes.map((b) => [b.id, b.refs]));
  const portals = buildPortals(model, charts, byId), flow = buildFlow(charts, stages), main = mainPath(model);
  const mainStageCount = new Set(main.map((id) => (byId.get(id) || {}).stage).filter(Boolean)).size;       // "13 stages" is a set of stages, not a journey: a plain job meets only these
  const modes = endingModes(model), heard = heardMap(model), waitsOf = waitsMap(model), lim = (l) => (limitIsEmpty(l.limit) ? '' : l.limit);   // a placeholder limit ("none", "?") says nothing: it is shown as no limit
  const out = {};
  for (const c of charts) {
    const ids = new Set(c.boxes.map((b) => b.id));
    const nodes = Object.fromEntries(c.boxes.map((b) => [b.id, nodeData(b, { ending: modeWord(modes.get(b.id)), heard: heard[b.id], waits: b.kind === 'wait' ? waitsOf[b.id] : undefined })]));
    const edges = Object.fromEntries(c.routes.map((r) => [r.id, edgeData(r, refsByBox)]));
    const geom0 = geoms[c.id] || { width: 400, height: 200, nodes: [], edges: [], clusters: [] };
    const geom1 = geom0.nodes.some((n) => n.handle && isJunkHandle(n.handle)) ? { ...geom0, nodes: geom0.nodes.map((n) => (n.handle && isJunkHandle(n.handle) ? { ...n, handle: '', ...(n.tag ? { tag: '' } : {}) } : n)) } : geom0;   // no chip for a literal
    const geom = evenLabels(geom1);                          // a road condition that wraps does so in even lines, never a number or a lone last word on a line of its own
    const part = partNo.get(c.id) || c.part;
    const ch = { id: c.id, title: c.title, navLabel: nameOf(c, part), navSub: c.kind === 'overview' ? plural(stages.length, 'stage') + (mainStageCount ? '; the main path runs through ' + mainStageCount + ' of them' : '') : c.kind === 'whole' ? `${plural(c.boxes.length, 'box', 'boxes')}, ${plural(c.routes.length, 'road')}`
        : c.kind === 'stage' ? `${plural(c.boxes.length, 'box', 'boxes')}, ${plural(c.routes.length, 'road')}` : trunc(c.summary, 60),
      codes: uniq(c.boxes.map((b) => cleanHandle(b.handle)).filter(Boolean)), summary: c.kind === 'overview' ? overviewSummary(c, model) : c.summary, kind: c.kind, geom, nodes, edges, metrics: metricsOut(metrics[c.id]), flow: flow[c.id], portals: portals[c.id] || [] };
    if (c.kind === 'stage') { ch.stage = c.stage; if (c.parts > 1) { ch.part = part; ch.parts = c.parts; ch.name = c.name || ''; } }   // the viewer groups the nav by stage and writes the part breadcrumb
    if (c.note) ch.note = c.note;               // the model's partNotes: one line on what this part of the stage is for
    if (c.notDrawn) ch.notDrawn = c.notDrawn;   // overview roads the chart does not draw: [{id, from, to, count, when}]
    const sp = c.spine && c.spine.length ? c.spine : main.filter((id) => ids.has(id));
    if (c.kind === 'overview' && c.mainRun && c.mainRun.length > 1) ch.spine = c.mainRun;       // the overview lights the main path stage by stage: consecutive distinct stages, repeats kept
    else if (sp.length >= 1) ch.spine = sp;                                         // one main-path step is enough for the chart to carry the Main path toggle
    const loopsHere = (model.loops || []).map((l) => ({ ...l, total: (l.boxes || []).length, boxes: (l.boxes || []).filter((id) => ids.has(id)) })).filter((l) => l.boxes.length >= 2);
    if (c.kind === 'whole') {
      ch.stages = stages.filter((s) => c.boxes.some((b) => (b.stage === s.id) || (s.id === '_unstaged' && !stagesById[b.stage]))).map((s) => ({ id: s.id, title: s.title, blurb: s.blurb || '', order: s.order, ...(s.role ? { role: s.role } : {}) }));
      const used = new Set(ch.stages.map((s) => s.id));
      ch.regions = ch.stages.map((s) => ({ id: s.id, title: s.title, kind: 'stage', blurb: s.blurb, nodes: c.boxes.filter((b) => (stagesById[b.stage] ? b.stage : '_unstaged') === s.id).map((b) => b.id) }));
      for (const l of loopsHere) { const id = used.has(l.id) ? 'loop_' + l.id : l.id; used.add(id); ch.regions.push({ id, title: l.title || l.id, kind: 'loop', blurb: l.blurb || '', limit: lim(l), nodes: l.boxes }); }
      for (const p of (model.paths || []).slice(1)) {
        const nodes = (p.boxes || []).filter((id) => ids.has(id)); if (nodes.length < 2) continue;
        const id = used.has(p.id) ? 'path_' + p.id : p.id; used.add(id);
        ch.regions.push({ id, title: p.title || p.id, kind: 'slice', blurb: p.blurb || '', nodes, path: p.id });
      }
    } else if (c.kind !== 'overview') ch.loops = loopsHere.map((l) => ({ id: l.id, title: l.title || l.id, blurb: l.blurb || '', boxes: l.boxes, limit: lim(l), ...(l.total > l.boxes.length ? { total: l.total } : {}) }));      // total: the loop's boxes in all, when this chart draws only some of them
    out[c.id] = ch;
  }
  const draft = !(gaps ? gaps.state === 'finished' : finished);
  const nd = notDrawnOf(gaps, census);
  const sys = model.system || {};
  const ev = evidenceOf(model, { findings, overlay, walks, stagesById });
  const breaks = breaksOf(model, findings), counts = countsOf(model, { breaks, census, findings, facts }), holds = holdsOf(model, breaks);
  return {
    meta: { title: metaTitle(model), generator: 'Faultline by EKG', draft, pin: pinText(facts, opts.pin), census: censusMeta(gaps), notDrawn: nd, counts, heardWords: HEARD_WORDS, heardShort: HEARD_SHORT, ...(Object.keys(waitsOf).length ? { waitWords: WAIT_WORDS } : {}), holdWords: HOLD_STATE_WORDS, ...(sourceBase ? { sourceBase } : {}), roleWords: { detail: 'Other view' }, exports: { svg: true } },
    system: { name: sys.name || '', tagline: sys.tagline || '', summary: sys.summary || '', purpose: sys.purpose || '' },
    stages: stages.map((s) => ({ id: s.id, title: s.title, blurb: s.blurb || '', order: s.order, ...(s.role ? { role: s.role } : {}) })),
    paths: (model.paths || []).map((p) => ({ id: p.id, title: p.title || p.id, blurb: p.blurb || '', boxes: p.boxes || [] })),
    loops: [...(model.loops || []).map((l) => ({ id: l.id, title: l.title || l.id, blurb: l.blurb || '', boxes: l.boxes || [], limit: lim(l) })), ...workedOutLoops(model)],   // declared first, then the ones worked out from return roads (derived: true)
    nav: buildNav(charts), charts: out, terms: (model.terms || []).filter((t) => !isJunkHandle(t && (t.term || t.name))), sections: buildSections(charts, stages),
    ...(ev ? { evidence: ev, findings: ev.findings } : {}),
    ...(breaks.length ? { breaks } : {}),
    ...(holds.length ? { holds } : {}),
  };
}
