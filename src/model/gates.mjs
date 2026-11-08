// validateModel(model, facts, census, {finished, geoms, metrics, findings, dismissed}) -> {refusals, warnings, gaps, ok}
// refusals: {code,msg,at,...}. In a draft the finished-only gates come back as gaps.items instead (same text, "GAP" not "REFUSE").
import { buildGraph } from './graph.mjs';
import { indexFacts, normPath } from './refs.mjs';
import { LIMITS, len } from './text.mjs';
import { g1, g2, g3, g4, g5, k1, t1, l1 } from './hard.mjs';
import { finishedGates, requiredRows, accountedAs, tally } from './finished.mjs';
import { heardIssues } from './heard.mjs';
import { waitIssues } from './waits.mjs';
import { partNameWarnings } from './partnames.mjs';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const CAP = 25;
// A switch the census cannot see (it only lists const-level switches) is named with a prefix: option:<name> env:<NAME> flag:<--name> setting:<name> owner:<what they do>
export const SWITCH_NOTE = /^\s*(?:option|env|flag|setting|owner):\s*\S/i;      // a space after the colon is fine: "flag: --name"
const asGap = (r) => ({ ...r, msg: r.msg.replace(/^REFUSE /, 'GAP ') });

function warnings(model, fx, census, g, charts = null) {
  const w = [];
  const add = (code, msg, at) => w.push({ code, msg, at });
  const seenTitle = new Map();
  for (const b of model.boxes || []) {
    const t = len(b.title);
    if (t > LIMITS.titleTarget && t <= LIMITS.titleMax) add('W-title', `box ${b.id} title is ${t} characters (target ${LIMITS.titleTarget}): cut words if it still reads`, b.id);
    if (!String(b.plain ?? '').trim()) add('W-plain', `box ${b.id} has no plain sentence yet`, b.id);
    if ((b.status === 'off' || b.status === 'default-on') && !b.switch) add('W-switch', `box ${b.id} is ${b.status} but names no switch`, b.id);
    if (b.switch && census && (census.switches || []).length && !SWITCH_NOTE.test(String(b.switch)) && !(census.switches || []).some((s) => s.id === b.switch)) add('W-switch', `box ${b.id} names switch ${b.switch}, which the census does not list`, b.id);
    const tk = String(b.title ?? '').trim().toLowerCase();
    if (tk) { if (seenTitle.has(tk)) add('W-dupe-title', `boxes ${seenTitle.get(tk)} and ${b.id} share the title "${b.title}": same words should mean the same thing`, b.id); else seenTitle.set(tk, b.id); }
  }
  // the main path is what runs with the defaults: a step that is off by default is either really live (a gate that runs and passes because a feature is off), or not on it
  const mainPath = (model.paths || [])[0], mainSteps = mainPath ? (mainPath.boxes || mainPath.steps || []) : [];
  for (const id of new Set(mainSteps)) {
    const b = g.byId.get(id);
    if (b && (b.status === 'off' || b.status === 'test-only')) add('W-main-off', `main path step ${id} is marked ${b.status}: the main path is what runs with the defaults. If the box itself runs and only what lies behind it is off, mark it live; otherwise take the path around it`, id);
  }
  for (const b of g.boxes) {
    // a decision's exits are counted with g.out, not g.outX: a road back to the box itself is an exit
    if (b.kind === 'end') { const ex = g.outX(b.id).filter((r) => (r.type ?? 'forward') === 'forward'); if (ex.length) add('W-end-exit', `end box ${b.id} has ${ex.length === 1 ? 'a forward road' : ex.length + ' forward roads'} going out (${ex[0].id}): an ending should have none, or be a different kind of box`, b.id); }
    if (b.kind === 'decision') { const n = g.out.get(b.id).length; if (n < 2) add('W-decision-one-exit', `decision box ${b.id} has ${n === 0 ? 'no exit' : 'one exit'}: a decision splits flow, so it needs at least two roads out`, b.id); }
  }
  for (const p of model.paths || []) {
    const ids = p.boxes || [];
    for (let i = 0; i + 1 < ids.length; i++) {
      if (!g.byId.has(ids[i]) || !g.byId.has(ids[i + 1])) continue;
      if (!g.out.get(ids[i]).some((r) => r.to === ids[i + 1])) { add('W-path', `path ${p.id}: no route from ${ids[i]} to ${ids[i + 1]}`, p.id); break; }
    }
  }
  const mods = new Set((fx.modules ? [...fx.modules.keys()] : []));
  if (mods.size) for (const k of Object.keys(model.modules || {})) if (!mods.has(normPath(k))) add('W-module', `modules lists ${k}, which facts.json does not`, k);
  if (census) {
    const ids = new Set([...(census.endings || []), ...(census.branches || []), ...(census.passes || []), ...(census.switches || [])].map((r) => r.id));
    const stale = Object.keys(model.ledger || {}).filter((id) => !ids.has(id));
    if (stale.length) add('W-ledger', `ledger row ${stale[0]} names a census row that is not in census.json${stale.length > 1 ? ` (and ${stale.length - 1} more)` : ''}: the code moved; re-check it`, stale[0]);
  }
  const merged = new Map();
  for (const l of Object.values(model.ledger || {})) if (isObj(l) && l.merged) merged.set(l.merged, (merged.get(l.merged) || 0) + 1);
  for (const [box, n] of merged) if (n > 25) add('W-merge', `box ${box} absorbs ${n} census rows: that may be hiding a subsystem`, box);
  for (const h of heardIssues(model)) add(h.code, h.msg, h.at);                // never a refusal: who hears about an ending is optional data, and a missing entry only asks
  for (const h of waitIssues(model)) add(h.code, h.msg, h.at);                 // never a refusal: what a wait waits for is optional data
  w.push(...partNameWarnings(model, charts));                                    // only when the caller passes the charts (check, build): the model alone does not know its parts
  const rs = model.routes || [];
  if (rs.length >= 10 && rs.filter((r) => r.inferred).length / rs.length > 0.5) add('W-inferred', 'more than half the routes are inferred: they show as lower trust', 'routes');
  return w;
}

export function validateModel(model, facts, census, opts = {}) {
  const finished = !!opts.finished;
  const g = buildGraph(model);
  const fx = indexFacts(facts);
  const refusals = [];
  refusals.push(...g1(model, fx), ...g2(model), ...g3(model), ...g4(model), ...g5(g), ...k1(model));
  const lay = l1(opts.geoms, opts.metrics);
  refusals.push(...lay.refusals, ...t1(model));
  const fin = finishedGates(model, facts, census, g, opts);
  const items = [];
  if (finished) refusals.push(...fin); else items.push(...fin.map(asGap));
  const warn = [...warnings(model, fx, census, g, opts.charts || null), ...lay.warnings];

  // what is not drawn yet, as lists and counts beside the map
  const ledger = model.ledger || {}, routeIds = new Set((model.routes || []).map((r) => r.id));
  const req = requiredRows(census), notDrawn = {};
  const undrawn = (rows) => rows.filter((r) => !accountedAs(r.id, ledger, g, routeIds)).map((r) => r.id);
  const e = undrawn(req.endings), b = undrawn(req.branches);
  notDrawn.endings = { count: e.length, ids: e.slice(0, CAP) };
  notDrawn.branches = { count: b.length, ids: b.slice(0, CAP) };
  const cited = new Set();
  for (const bx of model.boxes || []) for (const r of Array.isArray(bx.refs) ? bx.refs : []) if (isObj(r)) cited.add(normPath(r.path || String(r.symbol || '').split('::')[0]));
  const um = facts ? (facts.modules || []).map((m) => normPath(m.path)).filter((p) => !cited.has(p) && !String(model.modules?.[p]?.excluded ?? '').trim()) : [];
  notDrawn.modules = { count: um.length, ids: um.slice(0, CAP) };
  if (Array.isArray(opts.findings)) {
    const d = opts.dismissed || {};
    const open = opts.findings.filter((f) => !f.lead && !(isObj(d[f.key]) && (d[f.key].suspect === true || String(d[f.key].why ?? '').trim())));
    notDrawn.findings = { count: open.length, ids: open.slice(0, CAP).map((f) => f.key) };
  }
  const state = !finished ? 'draft' : refusals.length ? 'refused' : 'finished';
  const gaps = { state, items, tally: tally(model, facts, census, g), notDrawn };
  return { ok: refusals.length === 0, refusals, warnings: warn, gaps };
}
