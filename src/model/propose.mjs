// propose(model, facts, graph, census?, opts?) -> what the algorithms can offer an interpreting agent.
// Routes come from the call graph (with the chain as evidence); the agent only names the condition.
import { buildGraph, shortestRoutes } from './graph.mjs';
import { indexFacts, citeIndex, refSymbol, normPath, symbolPath } from './refs.mjs';
import { slug, uniq } from './text.mjs';
import { requiredRows, accountedAs } from './finished.mjs';
import { plainWords } from './refusal.mjs';

const DEF = { maxHops: 3, supportHops: 5, hubIn: 12, maxRoutes: 200, perBox: 12, maxStages: 14, list: 60, look: 14 };
const titleCase = (s) => String(s || '').replace(/[_\-./]+/g, ' ').trim().replace(/\s+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());

function callIndex(graph, o) {
  const adj = new Map(), hubs = new Set(), rev = new Map();
  for (const [a, b] of graph?.callEdges || []) { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); if (!rev.has(b)) rev.set(b, []); rev.get(b).push(a); }
  for (const h of graph?.hubs || []) if ((h.in ?? 0) >= o.hubIn) hubs.add(h.fn);
  for (const list of adj.values()) list.sort();
  for (const list of rev.values()) list.sort();
  return { adj, hubs, rev };
}

// Walk the call graph from a set of seed functions. `stop` ends a walk at a function without expanding it.
function walk(seeds, ci, maxHops, stop) {
  const dist = new Map(seeds.map((s) => [s, { hops: 0, parent: null }])), q = [...seeds];
  for (let h = 0; h < q.length; h++) {
    const u = q[h], d = dist.get(u).hops;
    if (d >= maxHops) continue;
    if (d > 0 && (ci.hubs.has(u) || (stop && stop(u)))) continue;
    for (const v of ci.adj.get(u) || []) if (!dist.has(v)) { dist.set(v, { hops: d + 1, parent: u }); q.push(v); }
  }
  return dist;
}
const chainTo = (dist, fn) => { const c = []; for (let u = fn; u != null; u = dist.get(u).parent) c.push(u); return c.reverse(); };

// The tests and handlers that lead to a call, nearest first: those above the call line (the condition that sends flow there), then the rest. 4 at most.
function hintsFor(fx, fn, callLine = null) {
  const f = fx.functions[fn]; if (!f) return [];
  const out = [];
  for (const b of f.branches || []) if (b.test) out.push({ at: `${f.path}:${b.line}`, text: String(b.test).slice(0, 80), line: b.line });
  for (const e of f.excepts || []) out.push({ at: `${f.path}:${e.line}`, text: `except ${e.type}${e.swallows ? ' (swallowed)' : ''}`, line: e.line });
  if (callLine != null) out.sort((a, b) => (a.line <= callLine ? 0 : 1) - (b.line <= callLine ? 0 : 1) || (a.line <= callLine ? callLine - a.line : a.line - callLine) - (b.line <= callLine ? callLine - b.line : b.line - callLine));
  return out.slice(0, 4).map(({ line, ...h }) => h);
}

// Where `caller` calls `callee`: the first call line and how many calls, from callAt ([[index into calls, line], ...]). {line:null} when extract did not record lines.
function callSite(fx, caller, callee) {
  const f = fx.functions[caller]; if (!f) return null;
  const ix = []; (f.calls || []).forEach((c, i) => { if (c === callee) ix.push(i); });
  const lines = (f.callAt || []).filter((r) => ix.includes(r[0])).map((r) => r[1]).sort((a, b) => a - b);
  return { path: f.path, fn: caller, callee, line: lines.length ? lines[0] : null, count: lines.length || ix.length };
}

// Which route hints to print. routes: propose().routes (already sorted, islands first). o: {stage, crossStage, intoIslands, limit, offset}.
// -> {total, matched, shown}. A stage filter keeps a hint that starts or ends in that stage. limit 0 means all.
export function pickHints(routes, o = {}) {
  const keep = routes.filter((r) => (!o.stage || r.fromStage === o.stage || r.toStage === o.stage) && (!o.crossStage || r.crossStage) && (!o.intoIslands || r.intoNoWayIn));
  const limit = o.limit === 0 ? keep.length : Math.max(1, o.limit ?? 40), at = Math.max(0, o.offset ?? 0);
  return { total: routes.length, matched: keep.length, shown: keep.slice(at, at + limit), from: at };
}

export function propose(model, facts, graph, census = null, opts = {}) {
  const o = { ...DEF, ...opts };
  const g = buildGraph(model), fx = indexFacts(facts), cites = citeIndex(model), ci = callIndex(graph, o);
  const boxFns = new Map(g.boxes.map((b) => [b.id, uniq((Array.isArray(b.refs) ? b.refs : []).map(refSymbol).filter((s) => fx.functions[s]))]));
  const citedBy = new Map();                                         // fn -> [box ids]
  for (const [id, fns] of boxFns) for (const f of fns) { if (!citedBy.has(f)) citedBy.set(f, []); citedBy.get(f).push(id); }
  const have = new Set(g.routes.map((r) => `${r.from}>${r.to}`));
  const stageOrder = new Map((model.stages || []).map((s, i) => [s.id, Number(s.order ?? i + 1)]));
  // the boxes that hold a call site: of those citing the calling function, the ones whose cited line is the last at or above the call (all of them when several
  // cite that same line); [] when no box cites the function or none cites a line above the call. A hint from a box that does not hold the call is the same call again.
  const holdersOf = (fn, line) => {
    const list = cites.get(fn) || [];
    const above = list.filter((c) => c.line && line != null && c.line <= line);
    if (!above.length) return [];
    const top = Math.max(...above.map((c) => c.line));
    return above.filter((c) => c.line === top).map((c) => c.box);
  };
  let sameCall = 0;

  // 1. routes the call graph already shows between boxes that the model does not connect
  const routes = [];
  for (const A of g.boxes) {
    const seeds = boxFns.get(A.id); if (!seeds.length) continue;
    const mine = new Set(seeds);
    const dist = walk(seeds, ci, o.maxHops, (f) => (citedBy.get(f) || []).some((id) => id !== A.id) && !mine.has(f));
    const best = new Map();
    for (const [fn, d] of dist) {
      if (d.hops === 0 || mine.has(fn)) continue;
      for (const bid of citedBy.get(fn) || []) {
        if (bid === A.id || have.has(`${A.id}>${bid}`)) continue;
        const chain = chainTo(dist, fn), cur = best.get(bid);
        if (!cur || chain.length < cur.length || (chain.length === cur.length && chain.join() < cur.join())) best.set(bid, chain);
      }
    }
    const rows = [...best.entries()].sort((a, b) => a[1].length - b[1].length || g.order.get(a[0]) - g.order.get(b[0])).slice(0, o.perBox);
    for (const [bid, chain] of rows) {
      const upstream = shortestRoutes(bid, A.id, g.out) != null;
      const caller = chain[chain.length - 2] || chain[0], site = callSite(fx, caller, chain[chain.length - 1]);
      const held = holdersOf(caller, site && site.line), T = g.byId.get(bid);
      if (held.length && !held.includes(A.id)) { sameCall++; continue; }
      routes.push({
        from: A.id, to: bid, type: upstream ? 'return' : 'forward', when: '',
        evidence: { chain, hops: chain.length - 1 },
        ...(site ? { site: { at: `${site.path}:${site.line ?? fx.functions[caller].line}`, lineKnown: site.line != null, fn: caller.split('::').slice(1).join('::'), calls: site.count } } : {}),
        holder: held.length ? { box: held[0], isFrom: true, also: held.length - 1 } : null,
        conditionHints: hintsFor(fx, caller, site && site.line),
        reverse: have.has(`${bid}>${A.id}`),
        fromStage: A.stage || '', toStage: T.stage || '', crossStage: (A.stage || '') !== (T.stage || ''),
        intoNoWayIn: g.inX(bid).length === 0, fromNoWayOut: A.kind !== 'end' && g.outX(A.id).length === 0 && g.inX(A.id).length > 0,
        fromIsland: g.inX(A.id).length === 0 && g.outX(A.id).length === 0,
      });
    }
  }
  // what connects an island comes first: a road into a box nothing leads to, from a box the map reaches (it draws the island in), then from one it does not,
  // then a road out of a box that goes nowhere; the rest. Then the call-graph distance, the box that really holds the call, and the box order.
  const tier = (r) => (r.intoNoWayIn ? (r.fromIsland ? 1 : 0) : r.fromNoWayOut || r.fromIsland ? 2 : 3);
  routes.sort((a, b) => tier(a) - tier(b) || a.evidence.hops - b.evidence.hops || g.order.get(a.from) - g.order.get(b.from) || g.order.get(a.to) - g.order.get(b.to));
  // boxes that cite the same line of the calling function are the same call seen several times: keep the first, name the others
  const bySite = new Map(), merged = [];
  for (const r of routes) {
    if (r.holder && r.holder.also > 0 && r.site) {
      const k = `${r.to}|${r.site.at}`;
      if (bySite.has(k)) { bySite.get(k).alsoFrom.push(r.from); sameCall++; continue; }
      r.alsoFrom = []; bySite.set(k, r);
    }
    merged.push(r);
  }
  routes.length = 0; routes.push(...merged);
  const routesTotal = routes.length;
  const hinted = new Set(routes.filter((r) => r.intoNoWayIn).map((r) => r.to));
  const noWayIn = g.boxes.filter((b) => g.inX(b.id).length === 0).map((b) => b.id), noHint = noWayIn.filter((id) => !hinted.has(id));
  // a box nothing leads to and no hint reaches: who calls its functions, so the integrator need not write a call-graph script. Doors (entries) are named.
  const callersOf = (id) => {
    const out = [];
    for (const fn of boxFns.get(id) || []) for (const c of ci.rev.get(fn) || []) {
      if (c === fn) continue;
      const site = callSite(fx, c, fn), hs = holdersOf(c, site && site.line), cb = hs.length ? hs : (citedBy.get(c) || []).filter((x) => x !== id);
      out.push({ fn: c, calls: fn, at: site ? `${site.path}:${site.line ?? fx.functions[c].line}` : '', lineKnown: !!(site && site.line != null), boxes: cb.slice(0, 3) });
    }
    return out.sort((a, b) => (b.boxes.length ? 1 : 0) - (a.boxes.length ? 1 : 0) || (a.fn < b.fn ? -1 : 1));
  };
  const lonely = noHint.map((id) => {
    const b = g.byId.get(id), callers = callersOf(id), door = (boxFns.get(id) || []).map((f) => fx.entries.get(f)).find((e) => e && e.kind !== 'test');
    return { box: id, kind: b.kind, stage: b.stage || '', title: b.title || '', entry: door ? door.kind : null, callerCount: callers.length, callers: callers.slice(0, 4) };
  }).sort((a, b) => (b.callerCount > 0 ? 1 : 0) - (a.callerCount > 0 ? 1 : 0) || g.order.get(a.box) - g.order.get(b.box)).slice(0, o.list);
  routes.length = Math.min(routes.length, o.maxRoutes);

  // 2. drawn routes that the call graph does not support (events, queues and config are fine if marked inferred)
  const unsupported = [];
  const reachCache = new Map();
  for (const r of g.routes) {
    if (r.inferred) continue;
    const a = boxFns.get(r.from), b = boxFns.get(r.to);
    if (!a?.length || !b?.length) continue;
    if (a.some((f) => b.includes(f))) continue;                       // both live in one function: ordered steps, not calls
    const reachOf = (id, fns) => { if (!reachCache.has(id)) reachCache.set(id, walk(fns, ci, o.supportHops, null)); return reachCache.get(id); };
    if (b.some((f) => reachOf(r.from, a).has(f))) continue;
    if (a.some((f) => reachOf(r.to, b).has(f))) continue;               // the callee handing back to its caller is a road too
    unsupported.push({ route: r.id, from: r.from, to: r.to, why: `no call path from ${a[0]} to ${b[0]} within ${o.supportHops} calls` });
  }

  // 3. stages from clusters, only while the model has none
  const stages = [];
  if (!(model.stages || []).length && graph?.clusters?.length) {
    const depth = graph.depth || {};
    const rows = graph.clusters.map((c) => {
      const ds = (c.fns || []).map((f) => depth[f]).filter((d) => d != null);
      return { c, d: ds.length ? Math.min(...ds) : 999 };
    }).sort((a, b) => a.d - b.d || (b.c.fns?.length || 0) - (a.c.fns?.length || 0) || (a.c.id < b.c.id ? -1 : 1));
    const used = new Set(), req = requiredRows(census);
    const endFns = new Set(req.endings.map((e) => e.fn));
    const decCount = new Map(); for (const b of req.branches) decCount.set(b.fn, (decCount.get(b.fn) || 0) + 1);
    rows.forEach(({ c }, i) => {
      let id = `s_${slug(c.label || c.id)}`; while (used.has(id)) id += '_';
      used.add(id);
      const seeds = (c.fns || []).map((fn) => {
        const why = [];
        const en = fx.entries.get(fn); if (en && en.kind !== 'test') why.push(`entry (${en.kind})`);
        if (endFns.has(fn)) why.push('has endings');
        if ((decCount.get(fn) || 0) >= 2) why.push(`${decCount.get(fn)} decisions`);
        return { fn, why: why.join(', '), depth: depth[fn] ?? 999 };
      }).filter((s) => s.why).sort((a, b) => a.depth - b.depth || (a.fn < b.fn ? -1 : 1)).slice(0, 6).map(({ fn, why }) => ({ fn, why }));
      stages.push({ id, title: titleCase(c.label || c.id), blurb: '', order: i + 1, color: null, cluster: c.id, modules: (c.modules || []).slice(0, 12), fnCount: (c.fns || []).length, cohesion: c.cohesion ?? null, seeds });
    });
    if (stages.length > o.maxStages) {
      const tail = stages.splice(o.maxStages - 1);
      stages.push({ id: 's_other', title: 'Other', blurb: '', order: stages.length + 1, color: null, cluster: tail.map((t) => t.cluster).join('+'), modules: tail.flatMap((t) => t.modules).slice(0, 12), fnCount: tail.reduce((n, t) => n + t.fnCount, 0), cohesion: null, seeds: [] });
    }
  }

  // 4. modules no box cites and the model does not exclude
  const cited = new Set(), stageOfModule = new Map();
  for (const b of g.boxes) for (const r of Array.isArray(b.refs) ? b.refs : []) { const p = normPath(r.path || symbolPath(r.symbol)); if (p) { cited.add(p); if (!stageOfModule.has(p)) stageOfModule.set(p, new Map()); const m = stageOfModule.get(p); m.set(b.stage, (m.get(b.stage) || 0) + 1); } }
  const nb = new Map();
  for (const [a, b] of graph?.importEdges || []) { for (const [x, y] of [[a, b], [b, a]]) { if (!nb.has(x)) nb.set(x, []); nb.get(x).push(y); } }
  const clusterOf = new Map();
  for (const c of graph?.clusters || []) for (const m of c.modules || []) clusterOf.set(normPath(m), c.id);
  const unmappedModules = (facts?.modules || []).map((m) => ({ m, p: normPath(m.path) })).filter(({ p }) => !cited.has(p) && !String(model.modules?.[p]?.excluded ?? '').trim()).map(({ m, p }) => {
    const votes = new Map();
    for (const n of nb.get(p) || []) for (const [st, k] of stageOfModule.get(normPath(n)) || []) votes.set(st, (votes.get(st) || 0) + k);
    const top = [...votes.entries()].sort((a, b) => b[1] - a[1] || (stageOrder.get(a[0]) ?? 99) - (stageOrder.get(b[0]) ?? 99))[0];
    const fns = (fx.byPath.get(p) || []).slice().sort((a, b) => (fx.functions[b].branches?.length || 0) - (fx.functions[a].branches?.length || 0) || (a < b ? -1 : 1)).slice(0, 3);
    return { path: p, lines: m.lines ?? 0, cluster: clusterOf.get(p) || null, suggestedStage: top ? top[0] : null, fns };
  }).sort((a, b) => b.lines - a.lines || (a.path < b.path ? -1 : 1));

  // 5. census rows the ledger does not account for, with the box that most likely stands for each
  const unaccounted = [], ledgerDraft = {};
  if (census) {
    const ledger = model.ledger || {}, routeIds = new Set((model.routes || []).map((r) => r.id)), req = requiredRows(census);
    const pick = (row, preferEnd) => {
      const list = cites.get(normPath(row.fn)) || []; let best = null, bs = Infinity;
      for (const c of list) { const b = g.byId.get(c.box); const d = (c.line ? Math.abs(c.line - (row.line || 0)) : 1e5) - (preferEnd && b?.kind === 'end' ? 1e4 : 0); if (d < bs) { bs = d; best = c.box; } }
      return best;
    };
    for (const [rows, kind] of [[req.endings, 'ending'], [req.branches, 'branch']]) for (const row of rows) {
      if (accountedAs(row.id, ledger, g, routeIds)) continue;
      const box = pick(row, kind === 'ending');
      unaccounted.push({ id: row.id, kind, at: `${String(row.fn).split('::')[0]}:${row.line}`, fn: row.fn, ...(kind === 'ending' ? { value: row.value ?? null } : { test: row.test ?? null }), suggestedBox: box });
      if (box) ledgerDraft[row.id] = { box };
    }
  }

  // 6. functions no box cites that carry the signs of a failure path
  const hotspots = [];
  for (const [fn, f] of Object.entries(fx.functions)) {
    if (citedBy.has(fn)) continue;
    const sig = [];
    if ((f.loops || []).some((l) => l.bounded === false)) sig.push('a loop with no count');
    if ((f.excepts || []).some((e) => e.swallows)) sig.push('an error swallowed');
    if ((f.raises || []).length) sig.push(`${f.raises.length} raise${f.raises.length > 1 ? 's' : ''}`);
    if ((f.branches || []).length >= 4) sig.push(`${f.branches.length} branches`);
    if (sig.length) hotspots.push({ fn, signals: sig.length, why: sig.join(', ') });
  }
  hotspots.sort((a, b) => b.signals - a.signals || (a.fn < b.fn ? -1 : 1));

  // 7. the short list for the interpreting agent
  const look = [];
  for (const m of unmappedModules.slice(0, 4)) look.push({ kind: 'module', at: m.path, ask: `No box cites ${m.path} (${m.lines} lines${m.suggestedStage ? `, next to stage ${m.suggestedStage}` : ''}): which box covers it, or exclude it with a reason?` });
  for (const r of routes.slice(0, 5)) look.push({ kind: 'route', at: `${r.from} -> ${r.to}`, ask: `The calls ${r.evidence.chain.map((c) => c.split('::')[1] || c).join(' -> ')} connect ${r.from} to ${r.to}: what condition sends flow along it?` });
  for (const u of unaccounted.filter((x) => x.kind === 'ending').slice(0, 4)) look.push({ kind: 'ending', at: u.id, ask: `Ending ${u.value != null ? `"${u.value}" ` : ''}at ${u.at} is not in the ledger${u.suggestedBox ? ` (nearest box ${u.suggestedBox})` : ' and no box cites its function'}: which box shows it?` });
  for (const h of hotspots.slice(0, 3)) look.push({ kind: 'function', at: h.fn, ask: `${h.fn} has ${h.why} and no box cites it: is it part of a failure path the map should show?` });
  for (const u of unsupported.slice(0, 3)) look.push({ kind: 'unsupported-route', at: u.route, ask: `Route ${u.route} (${u.from} -> ${u.to}) has no call path behind it: mark it inferred if an event or queue joins them, or fix the cite.` });

  return {
    routes, stages, unmappedModules: unmappedModules.slice(0, o.list), unaccounted: unaccounted.slice(0, o.list), ledgerDraft,
    unsupportedRoutes: unsupported.slice(0, o.list), hotspots: hotspots.slice(0, 12), whereToLook: look.slice(0, o.look).map((w) => ({ ...w, ask: plainWords(w.ask) })),
    noWayInNoHint: lonely, counts: { routes: routesTotal, sameCallElsewhere: sameCall, noWayIn: noWayIn.length, noWayInNoHint: noHint.length, unmappedModules: unmappedModules.length, unaccounted: unaccounted.length, unsupportedRoutes: unsupported.length, hotspots: hotspots.length },
  };
}
