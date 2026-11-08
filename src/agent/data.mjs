// agentData(model, {facts, findings, overlay, gaps, charts, finished, pin}) -> compact JSON (dist/atlas.agent.json, schema faultline.agent/1)
// The same map as the page, flattened for a reader that pays per token: ids everywhere, no layout, no prose beyond the model's own words.
// Every agent command works from this blob alone. Keys are short on purpose; tokenCost is measured as chars/4.
import { chartsFromModel, homeChart } from '../build/charts.mjs';
import { orderedStages, stageIdOf, mainPath } from '../build/util.mjs';
import { pinText, censusMeta } from '../build/atlasdata.mjs';
import { heardMap, HEARD_WORDS, silentBox } from '../model/heard.mjs';
import { endingModes, modeWord } from '../build/counts.mjs';

export const SCHEMA = 'faultline.agent/1';

export function agentData(model, opts = {}) {
  const { facts = null, overlay = null, finished = false, toolMap: tm = null } = opts;
  // A tool map's questions are the reading's, the ones its page lists, and the older analysis of the drawn shapes is left out; it has no ledger, so no gaps.
  const findings = tm ? tm.questions.map((q) => ({ key: q.key, check: q.check, boxes: q.boxes, routes: [], question: q.question, evidence: q.evidence, cluster: q.stage || '', agree: 1, shown: true, ...(q.sure ? { sure: true } : {}), ...(q.state === 'wait' ? { wait: true } : {}) })) : (opts.findings || []);
  const gaps = tm ? null : (opts.gaps || null);
  const charts = opts.charts || chartsFromModel(model), stages = orderedStages(model);
  const boxes = {}, routes = {};
  const inn = new Map(model.boxes.map((b) => [b.id, []])), out = new Map(model.boxes.map((b) => [b.id, []]));
  for (const r of model.routes || []) { (out.get(r.from) || []).push(r.id); (inn.get(r.to) || []).push(r.id); }
  const ov = (overlay && overlay.boxes) || {}, ro = (overlay && overlay.routes) || {};
  const cited = new Set(), heard = heardMap(model), modes = endingModes(model);
  for (const b of model.boxes) {
    const e = ov[b.id];
    const o = { title: b.title, kind: b.kind, stage: stageIdOf(model, b), status: b.status || 'live', plain: b.plain || '', in: inn.get(b.id), out: out.get(b.id), chart: homeChart(charts, b.id) };
    if (b.handle) o.handle = b.handle;
    if (b.why) o.why = b.why;
    if (b.failure) o.failure = b.failure;
    if (b.switch) o.switch = b.switch;
    if (b.outcome) o.outcome = b.outcome;
    if (b.kind === 'end') o.ending = modeWord(modes.get(b.id));            // 'stop' (no road out) or 'back' (a road out: it hands back to its caller)
    if (heard[b.id]) o.heard = heard[b.id];                                  // {by, how}: who hears about this ending, as the model says; absent = not said yet
    o.refs = (b.refs || []).map((r) => { cited.add(r.path); return [r.path, r.line || 0, r.symbol || (tm && b.prov && b.prov.fn) || '']; });   // a tool map's box names its function in prov.fn
    o.level = e ? e.level : 'drawn';
    if (e) {
      if (e.count) o.count = e.count;
      if (e.stale) o.stale = true;
      if (e.untested) o.untested = true;
      if (e.anchorOnly) o.anchorOnly = true;
      if (e.outcomes && e.outcomes.length) o.walkOutcomes = e.outcomes;
      if (e.reasons && e.reasons.length) o.why2 = e.reasons.slice(0, 2);
    }
    boxes[b.id] = o;
  }
  for (const r of model.routes || []) {
    const o = { from: r.from, to: r.to, type: r.type || 'forward', when: r.when || '' };
    if (r.why) o.why = r.why;
    if (r.inferred) o.inferred = true;
    if (ro[r.id] && (ro[r.id].count || ro[r.id].modeled)) o.seen = ro[r.id].count || 0;
    routes[r.id] = o;
  }
  // function ranges for the files boxes cite, so `where file:line` can find the function a line sits in
  const fnRanges = {};
  if (facts && facts.functions) for (const [id, f] of Object.entries(facts.functions)) if (cited.has(f.path)) (fnRanges[f.path] ||= []).push([f.line, f.end, id]);
  for (const k of Object.keys(fnRanges)) fnRanges[k].sort((a, b) => a[0] - b[0]);
  const t = (gaps && gaps.tally) || {}, nd = (gaps && gaps.notDrawn) || {};
  return {
    schema: SCHEMA, state: tm ? 'tool-map' : gaps ? gaps.state : finished ? 'finished' : 'draft', pin: pinText(facts, opts.pin),
    system: { name: (model.system || {}).name || '', tagline: (model.system || {}).tagline || '', summary: (model.system || {}).summary || '', purpose: (model.system || {}).purpose || '', ...((model.system || {}).toolMap ? { toolMap: true } : {}) },
    counts: { boxes: model.boxes.length, routes: (model.routes || []).length, stages: stages.length, loops: (model.loops || []).length, inferred: (model.routes || []).filter((r) => r.inferred).length },
    census: tm ? {} : censusMeta(gaps), tally: t,
    notDrawn: { endings: (nd.endings || {}).count || 0, branches: (nd.branches || {}).count || 0, modules: (nd.modules || {}).count || 0, ids: { endings: (nd.endings || {}).ids || [], branches: (nd.branches || {}).ids || [], modules: (nd.modules || {}).ids || [] } },
    ...(tm ? { toolMap: { nums: tm.nums, notes: tm.notes || [], read: tm.statements.read, notRead: tm.statements.notRead, open: tm.statements.open, fns: tm.fns || [], undrawn: tm.undrawn || {} }, alias: tm.ids } : {}),
    gaps: ((gaps && gaps.items) || []).map((g) => ({ code: g.code, msg: g.msg.replace(/^GAP [A-Z0-9]+ /, '').replace(/ Fix: .*$/, ''), fix: (/ Fix: (.*)$/.exec(g.msg) || [])[1] || '', at: g.at })),
    stages: stages.map((s) => ({ id: s.id, title: s.title, blurb: s.blurb || '', order: s.order, boxes: model.boxes.filter((b) => stageIdOf(model, b) === s.id).map((b) => b.id) })),
    boxes, routes,
    paths: (model.paths || []).map((p) => ({ id: p.id, title: p.title || p.id, blurb: p.blurb || '', boxes: p.boxes || [] })),
    loops: (model.loops || []).map((l) => ({ id: l.id, title: l.title || l.id, blurb: l.blurb || '', boxes: l.boxes || [], limit: l.limit || '' })),
    main: mainPath(model),
    heardWords: HEARD_WORDS,
    silent: model.boxes.filter((b) => silentBox(b, heard[b.id])).map((b) => b.id),   // boxes whose failure nobody is told about (heard by nobody, or only a log; not a success, refusal or neutral outcome)
    findings: findings.map((f) => ({ key: f.key, check: f.check, boxes: f.boxes || [], routes: f.routes || [], question: f.question, evidence: f.evidence, cluster: f.cluster || '', agree: f.agree || 1, shown: f.shown !== false, resolution: f.resolution || null, ...(f.lead ? { lead: true } : {}), ...(f.sure ? { sure: true } : {}), ...(f.wait ? { wait: true } : {}) })),
    charts: charts.filter((c) => c.kind !== 'overview').map((c) => ({ id: c.id, kind: c.kind, title: c.title, stage: c.stage || '' })),
    evidence: overlay ? {
      walks: (overlay.summary || {}).walksRead || 0, labels: (overlay.labels || []).map((l) => ({ tool: l.tool, label: l.effective, says: l.says })),
      notMapped: (overlay.notMapped || []).length, missingRoutes: (overlay.missingRoutes || []).slice(0, 8).map((m) => ({ from: m.from, to: m.to, count: m.count })),
      stale: (overlay.stale || []).slice(0, 12).map((s) => ({ fn: s.fn, boxes: s.boxes })), unexplored: (overlay.unexplored || []).slice(0, 12).map((u) => ({ at: u.at, boxes: u.boxes, why: u.why })),
      untested: overlay.untested || [], proved: Object.entries(ov).filter(([, v]) => v.level === 'proved').map(([id]) => id), seen: Object.entries(ov).filter(([, v]) => v.level === 'seen').map(([id]) => id),
    } : null,
    layout: opts.layout || null,
    fnRanges,
  };
}
