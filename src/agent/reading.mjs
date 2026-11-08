// What the agent commands need from a tool map's project folder beyond the compact blob: every function the scan found (not only the ones with a box), the call list
// between them, and the drawn boxes and roads the page's charts and outlines hold. Read once per command; nothing here reads the source or draws anything.
// Files: map/story-index.json (every function's first and last line, its decisions, calls and exits), map/calls.json (the call list), read/charts.json
// (function ids, charts, outlines) and read/reading.json (which functions the journeys pass through). A missing file only makes the answer thinner.
import fs from 'node:fs';
import path from 'node:path';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ANON = /<anon@(\d+)>$/;
export const MODULE = '<module>';

/** The name a person reads for a function: its plain label, or for an unnamed one where it sits. */
function nameOf(F, byId) {
  if (F.label) return F.label;
  const m = ANON.exec(F.qual);
  if (!m) return F.qual;
  const parent = F.parent && byId.get(F.parent);
  return `inner function at line ${m[1]}${parent ? ` of ${parent.label || parent.qual}` : ''}`;
}

/**
 * @param {string} dir the project folder (the one holding map/ and read/)
 * @param {{facts?:object|null}} [o] the scanner's facts when the caller already holds them (the text of each return)
 * @returns the reading index, or null when the project has no reading (a map written by hand)
 */
export function loadReading(dir, o = {}) {
  const charts = readJson(path.join(dir, 'read', 'charts.json'));
  if (!charts) return null;
  const spans = readJson(path.join(dir, 'map', 'story-index.json'));
  const calls = readJson(path.join(dir, 'map', 'calls.json')) || [];
  const reading = readJson(path.join(dir, 'read', 'reading.json'));
  const facts = o.facts || null;

  // ---- every function: the scan's list first, the reading's rows over it ------------------------------------------------------
  const byId = new Map();
  const add = (id, rec) => { const F = byId.get(id) || { id, qual: '', path: '', line: 0, end: 0, mapped: false, boxes: 0, chart: null, anon: false, n: null, label: '', long: '', stage: '', br: [], ca: [], rt: [], parent: null, children: [] }; Object.assign(F, rec); byId.set(id, F); return F; };
  const split = (id) => { const i = id.indexOf('::'); return i < 0 ? { path: '', qual: id } : { path: id.slice(0, i), qual: id.slice(i + 2) }; };
  for (const [id, s] of Object.entries((spans && spans.fns) || {})) add(id, { path: s.p, qual: s.q, line: s.l, end: s.e, br: s.br || [], ca: s.ca || [], rt: s.rt || [] });
  if (!spans && facts && facts.functions) for (const [id, f] of Object.entries(facts.functions)) add(id, { path: f.path, qual: f.qual, line: f.line, end: f.end, br: (f.branches || []).map((b) => [b.line, b.kind, b.test || '']), ca: [], rt: [...(f.returns || []).map((r) => [r.line, 'return']), ...(f.raises || []).map((r) => [r.line, 'raise'])] });
  const nOfId = new Map();
  for (const r of charts.functions) {
    const s = split(r.fid);
    const F = add(r.fid, { path: r.path, qual: byId.has(r.fid) ? byId.get(r.fid).qual : s.qual, line: byId.has(r.fid) && byId.get(r.fid).line ? byId.get(r.fid).line : r.line, mapped: true, cline: r.line, boxes: r.boxes, chart: r.chart || null, anon: !!r.anonymous, n: r.id, label: r.label, long: r.long, stage: r.district });
    nOfId.set(r.id, F);
  }
  // the nearest enclosing function that exists: Queue.add holds Queue.add.<anon@340>
  for (const F of byId.values()) {
    const segs = F.qual.split('.');
    for (let k = segs.length - 1; k >= 1; k--) {
      const pid = `${F.path}::${segs.slice(0, k).join('.')}`;
      if (byId.has(pid) && pid !== F.id) { F.parent = pid; byId.get(pid).children.push(F.id); break; }
    }
    if (!F.anon && ANON.test(F.qual)) F.anon = true;
  }
  for (const F of byId.values()) { F.name = nameOf(F, byId); F.children.sort(cmp); }
  const stageOfFile = new Map();
  for (const F of byId.values()) if (F.stage && !stageOfFile.has(F.path)) stageOfFile.set(F.path, F.stage);
  for (const F of byId.values()) if (!F.stage) F.stage = stageOfFile.get(F.path) || '';

  const list = [...byId.values()].sort((a, b) => cmp(a.path, b.path) || a.line - b.line || cmp(a.id, b.id));
  const byFile = new Map();
  for (const F of list) { if (!byFile.has(F.path)) byFile.set(F.path, []); byFile.get(F.path).push(F); }
  const files = new Map(Object.entries((spans && spans.files) || {}).map(([p, v]) => [p, v.lines || 0]));

  // ---- the call list: who calls whom, with how sure ----------------------------------------------------------------------------
  const TIER_RANK = { proven: 0, linked: 1, may: 2 };
  const edges = new Map();               // from|to -> edge, the strongest tier first, the first call line
  const unfollowed = new Map();          // function -> calls the tool could not resolve to project code
  const edgeKey = (a, b) => `${a}\u0000${b}`;
  const note = (from, to, line, tier, name) => {
    if (from === to || !byId.has(from) || !byId.has(to)) return;
    const k = edgeKey(from, to), e = edges.get(k);
    if (!e) { edges.set(k, { from, to, line, tier, name, sites: 1 }); return; }
    e.sites++;
    if (TIER_RANK[tier] < TIER_RANK[e.tier]) { e.tier = tier; e.line = line; e.name = name; } else if (TIER_RANK[tier] === TIER_RANK[e.tier] && line && (!e.line || line < e.line)) { e.line = line; e.name = name; }
  };
  const callSites = new Map();           // function -> every call site in line order: {line, name, to:[function ids], tier, how, rs}
  for (const row of calls) {
    const [from, , , c] = row;
    if (!c) continue;
    const to = c.to || [], may = new Set(c.may || []);
    const site = { line: c.line || 0, name: c.f || '', to, tier: c.t === 'link' ? 'linked' : may.size ? 'may' : 'proven', how: c.how || '', rs: c.rs || '' };
    if (!callSites.has(from)) callSites.set(from, []);
    callSites.get(from).push(site);
    for (const t of to) note(from, t, site.line, c.t === 'link' ? 'linked' : may.has(t) ? 'may' : 'proven', site.name);
    if (!to.length && c.how === 'unresolved' && c.rs !== 'ext') { if (!unfollowed.has(from)) unfollowed.set(from, []); unfollowed.get(from).push({ name: site.name, line: site.line }); }
  }
  for (const v of callSites.values()) v.sort((a, b) => a.line - b.line);
  const out = new Map(), inn = new Map();
  for (const e of [...edges.values()].sort((a, b) => cmp(a.from, b.from) || a.line - b.line || cmp(a.to, b.to))) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e);
    if (!inn.has(e.to)) inn.set(e.to, []);
    inn.get(e.to).push(e);
  }

  // ---- which functions the journeys pass through (the main one first) ---------------------------------------------------------
  const jr = new Map(), J = (reading && reading.journeys) || { list: [], main: null };
  const mainIx = J.list.findIndex((j) => j.id === J.main);
  const journeyNames = J.list.map((j) => j.name), journeyIds = J.list.map((j) => j.id);
  const startsOf = new Map();            // function -> the journeys it starts
  J.list.forEach((j, i) => { const t = j.trigger && j.trigger.fn; if (t) { if (!startsOf.has(t)) startsOf.set(t, []); startsOf.get(t).push(i); } });
  J.list.forEach((j, i) => { for (const f of j.functionsReached || []) if (!jr.has(f)) jr.set(f, i); });

  // ---- the drawn bodies: charts first, then outlines -----------------------------------------------------------------------------
  const chartOf = new Map(charts.charts.map((c) => [c.fid, c]));
  const outlineOf = new Map(charts.outlines.map((x) => [x.fid, x]));
  // the text of what each function returns, when the scanner's facts are at hand
  const returnsOf = (id) => { const f = facts && facts.functions && facts.functions[id]; return f ? new Map([...(f.returns || []).map((r) => [r.line, r.expr]), ...(f.raises || []).map((r) => [r.line, r.type ? `raise ${r.type}` : 'raise'])]) : null; };

  // the failing endings the reading lists, by the function they sit in
  const failing = new Map();
  for (const e of (reading && reading.endings && reading.endings.failing) || []) {
    const m = /^(.*):(d+)$/.exec(e.where || '');
    const F = m && innermost(byFile, m[1], +m[2]);
    if (F) { if (!failing.has(F.id)) failing.set(F.id, []); failing.get(F.id).push({ title: e.title, page: e.page || '', line: +m[2], outcome: e.outcome }); }
  }

  return {
    failing, dir, list, byId, byN: nOfId, byFile, files, out, inn, unfollowed, callSites, chartOf, outlineOf, returnsOf,
    jr, mainIx, journeyNames, journeyIds, startsOf, mainSet: mainIx >= 0 ? new Set(J.list[mainIx].functionsReached || []) : new Set(),
    edgesCount: edges.size,
  };
}

/** The function whose lines hold `line` in `file`: the innermost one, then the one that starts last. */
export function functionAt(R, file, line) { return innermost(R.byFile, file, line); }
function innermost(byFile, file, line) {
  const fs_ = byFile.get(file) || [];
  let best = null;
  for (const F of fs_) {
    if (line < F.line || line > F.end) continue;
    if (!best || (F.end - F.line) < (best.end - best.line) || ((F.end - F.line) === (best.end - best.line) && F.line > best.line)) best = F;
  }
  return best;
}
