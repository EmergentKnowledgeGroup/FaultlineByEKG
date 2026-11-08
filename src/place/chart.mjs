// placeChart: a chart graph in, a gridLayout config out. Nobody draws a map by hand: the happy path is laid as a snake, the rest is dropped
// next to its neighbours, a cheap cell model anneals a handful of starts, and the REAL router (fast enough at chart size) judges and refines
// the best ones with node moves, swaps and port hints. Channels are then sized automatically and the final route is checked for hard metrics.
//
//   placeChart(chart, { spine, seed = 1, budgetMs = 20000, engine, evals, pull, log }) -> Promise<cfg>
//   pull {nodeId: [{side:"N|E|S|W", w}]} (optional): the box has roads leaving that way (whole-system bands); it is drawn to that border of the band
// Deterministic for (chart, spine, seed, budgetMs): the work is counted in router calls, not read off a clock. The clock is a real ceiling
// (capFactor x budgetMs, default 6): EVERY router pass checks it - starts, annealing, rerank, polish and the final repair. On the ceiling the
// best result so far is returned (a pass already running finishes first) and cfg.__stats.capped is true; that is the one case where the same
// seed may not give the same bytes. A run that never reaches the ceiling is identical to one with no ceiling. The work is counted from the
// graph size, so a dense chart (an overview, say) runs about 5 x its budget: a ceiling of 3 x capped every such chart and cost
// it quality, 6 x lets a normal run finish and still stops a runaway.
import { normalizeChart, analyze, engineGraph } from './graph.mjs';
import { makeProxy } from './proxy.mjs';
import { snakeStart, toMap } from './construct.mjs';
import { rng } from './rng.mjs';
import { loadEngine, hardCount, hardOf, emptyLabelFill, fillLabels } from './engine.mjs';
import { score, culprits } from './objective.mjs';
import { cellTerms, marginTerm } from './readability.mjs';

const SIDES = ['N', 'E', 'S', 'W'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export async function placeChart(chart, opts = {}) {
  const { spine, seed = 1, budgetMs = 20000, engine, log = () => {}, gapX = 150, gapY = 84, crossingPenalty = 200 } = opts;
  const t0 = performance.now();
  const E = await loadEngine(engine);
  const g = normalizeChart(chart), eg = fillLabels(engineGraph(g), await emptyLabelFill(E));
  for (const n of g.nodes) if (n.id === '.' || n.id === '_' || /\s/.test(n.id)) throw new Error(`placeChart: node id "${n.id}" cannot be a grid token (no whitespace, not "." or "_")`);
  const stats = { evals: 0, sizedEvals: 0, cached: 0, starts: 0, capped: false, ms: 0 };
  // asked before every router pass. The ceiling counts passes, never the clock, so a busy machine still gives the same layout
  let passCap = Infinity;
  const over = () => { if (stats.evals + stats.sizedEvals >= passCap) { stats.capped = true; return true; } return false; };
  const done = cfg => { stats.ms = Math.round(performance.now() - t0); Object.defineProperty(cfg, '__stats', { value: stats, enumerable: false }); return cfg; };
  if (!g.nodes.length) return done({ map: [], gapX, gapY });
  const A = analyze(g, { spine });
  const base = { gapX, gapY, nodeMaxChars: 22, edgeMaxChars: 20, spine: A.spine, route: { crossingPenalty }, ...(opts.cfg || {}) };   // opts.cfg: extra engine options, e.g. { pinPitch: 14 }
  if (g.nodes.length === 1) return done({ ...base, map: [A.ids[0]] });
  const rand = rng(seed), nE = g.edges.length;
  const nEvals = opts.evals ?? clamp(Math.round(budgetMs * 0.5 / (2 + 0.35 * (A.n + nE))), A.n + nE > 150 ? 10 : 40, 4000);   // a big chart has no floor of 40 router passes
  passCap = opts.passCap ?? nEvals * (opts.capFactor ?? 6);
  const proxyIters = clamp(Math.round(budgetMs * 0.7 * Math.min(1, 25 / Math.max(25, nE))), 2500, 24000);
  const nStarts = opts.starts ?? (budgetMs >= 10000 ? 10 : 5);
  const edgeById = new Map(g.edges.map(e => [e.id, e]));
  const pullArr = opts.pull ? A.ids.map(id => opts.pull[id] || null) : null;

  // ---------------------------------------------------------------- engine evaluation, cached by map + port hints (+ sized or not)
  const cache = new Map(), elite = new Map();
  let bestAny = null;                                             // the best router result of any kind so far: what a capped run falls back on
  const mkCfg = (map, ports) => ({ ...base, map, ...(ports && Object.keys(ports).length ? { ports } : {}) });
  async function evaluate(pos, W, H, ports, sized = false) {
    const { map } = toMap(A, pos, W, H);
    const key = (sized ? 'S' : 'U') + map.join('|') + '#' + Object.keys(ports || {}).sort().map(k => k + ports[k].from + ports[k].to).join(',');
    const hit = cache.get(key); if (hit) { stats.cached++; return hit; }
    let cfg = mkCfg(map, ports), geom;
    try {
      if (sized) { stats.sizedEvals++; cfg = (await E.autoChannels(eg, cfg, { iters: 4, penalty: 0 })).cfg; } else stats.evals++;
      geom = await E.gridLayout(eg, cfg);
    } catch (e) { const r = { score: 1e9, m: null, geom: null, cfg, map }; cache.set(key, r); return r; }
    const m = E.metrics(geom), r = { score: score(m) + cellTerms(A, g, pos, W, pullArr) + marginTerm(A, g, geom), m, geom, cfg, map };
    if (!sized && (!bestAny || r.score < bestAny.score)) bestAny = r;
    if (cache.size > 3000) cache.clear();
    cache.set(key, r);
    if (!sized) { elite.set(key, { score: r.score, pos: Int32Array.from(pos), W, H, ports: { ...(ports || {}) } }); if (elite.size > 160) pruneElite(); }
    return r;
  }
  function pruneElite() { const keep = [...elite.entries()].sort((a, b) => a[1].score - b[1].score).slice(0, 40); elite.clear(); for (const [k, v] of keep) elite.set(k, v); }

  // ---------------------------------------------------------------- starts: snake constructions, annealed in the cell model, then judged by the router
  const sq = Math.sqrt(1.14 * A.n), Ws = [...new Set([-1, 0, 1, 2].map(d => Math.max(2, Math.round(sq) + d)))];
  const starts = [];
  let k = 0;
  for (const rowStep of [2, 1]) for (const W of Ws) {
    if (starts.length && over()) break;
    const H = Math.max(Math.ceil(A.n * 1.3 / W), (Math.ceil(A.spine.length / W) - 1) * rowStep + 2);
    const r = rand.fork(k++), p0 = snakeStart(A, g, { W, H, rowStep, rand: r });
    if (!p0) continue;
    const res = makeProxy(A, g, { W, H }).anneal(p0, r, proxyIters);
    starts.push({ W, H, pos: res.pos, pc: res.cost, rowStep });
  }
  if (!starts.length) throw new Error('placeChart: could not construct any start');
  starts.sort((a, b) => a.pc - b.pc);
  const judged = [];
  for (const s of starts.slice(0, nStarts)) {
    if (judged.length && over()) break;                           // at least one start is always judged: there must be something to return
    const r = await evaluate(s.pos, s.W, s.H, null); judged.push({ ...s, r }); stats.starts++;
  }
  judged.sort((a, b) => a.r.score - b.r.score);
  log('starts', judged.map(j => `${j.W}x${j.H}/${j.rowStep}:${j.r.score.toFixed(0)}`).join(' '));

  // ---------------------------------------------------------------- phase A: annealing with the router on default channels
  const padded = (pos, W, H, ports) => {                         // compact, then pad one empty cell on every side so moves can open rows and columns
    const rows = toMap(A, pos, W, H).map.map(r => r.split(' ')), Wp = rows[0].length + 2, Hp = rows.length + 2, p = new Int32Array(A.n);
    rows.forEach((row, r) => row.forEach((tok, c) => { if (tok !== '.') p[A.idx.get(tok)] = (r + 1) * Wp + (c + 1); }));
    return { pos: p, Wp, Hp, ports: { ...(ports || {}) } };
  };
  const aEvals = Math.round(nEvals * 0.62);
  const SHARE = [0.38, 0.26, 0.2, 0.16];                          // independent restarts beat one long run: the landscape is rugged
  for (let si = 0; si < Math.min(SHARE.length, judged.length); si++) {
    if (over()) break;
    const st = padded(judged[si].pos, judged[si].W, judged[si].H, null);
    await anneal(st, Math.max(12, Math.round(aEvals * SHARE[si])), rand.fork(900 + si), false, 45);
  }

  // ---------------------------------------------------------------- rerank the elite with channels sized, then phase B polishes with sized evaluation
  const top = [...elite.values()].sort((a, b) => a.score - b.score).slice(0, 8);
  let bestS = null;
  for (const c of top) { if (bestS && over()) break; const p = padded(c.pos, c.W, c.H, c.ports), r = await evaluate(p.pos, p.Wp, p.Hp, p.ports, true); if (r.m && (!bestS || r.score < bestS.r.score)) bestS = { ...p, r }; }
  log('rerank', top.map(c => c.score.toFixed(0)).join(' '), '->', bestS && bestS.r.score.toFixed(0));
  const bEvals = Math.round(nEvals * 0.38 / 3.5);
  if (bestS && bEvals >= 8 && !over()) bestS = await anneal(bestS, bEvals, rand.fork(777), true, 18, bestS);
  if (!bestS && bestAny && bestAny.m) bestS = { pos: null, Wp: 0, Hp: 0, ports: {}, r: bestAny };   // capped before any sized result: the best default-channel one stands
  if (!bestS) throw new Error('placeChart: the router rejected every candidate');
  if (!over() && bestS.pos) bestS = await polish(bestS, Math.max(30, Math.round(nEvals * 0.14)));

  async function anneal(st, iters, R, sized, T0, startRes = null) {
    let { pos, Wp, Hp, ports } = st, cur = startRes ? startRes.r : await evaluate(pos, Wp, Hp, ports, sized);
    let best = { pos: Int32Array.from(pos), Wp, Hp, ports: { ...ports }, r: cur }, cu = culprits(cur.geom || { edges: [] });
    const T1 = 1.2, occ = new Int32Array(Wp * Hp).fill(-1), cells = Wp * Hp;
    const nbrs = Array.from({ length: A.n }, () => []);
    for (const p of A.pairs.values()) { nbrs[p.a].push(p.b); nbrs[p.b].push(p.a); }
    for (let it = 0; it < iters; it++) {
      if (over()) break;
      const T = T0 * Math.pow(T1 / T0, it / iters);
      occ.fill(-1); for (let i = 0; i < A.n; i++) occ[pos[i]] = i;
      const np = Int32Array.from(pos); let nports = ports; const kind = R();
      const hot = [];                                            // nodes at the ends of crossing / bendy edges move first
      for (const [i, j] of cu.cross) for (const e of [i, j]) { const ed = g.edges[e]; hot.push(A.idx.get(ed.from), A.idx.get(ed.to)); }
      cu.bends.forEach((b, e) => { if (b >= 3) { const ed = g.edges[e]; hot.push(A.idx.get(ed.from), A.idx.get(ed.to)); } });
      if (kind < 0.72) {                                         // move or swap one node
        const a = hot.length && R() < 0.7 ? hot[R.int(hot.length)] : R.int(A.n);
        if (a === undefined) continue;
        let target; const q = R();
        if (q < 0.6 && nbrs[a].length) { const o = np[R.pick(nbrs[a])], oc = o % Wp, orr = (o / Wp) | 0, d = R.int(4), nc = oc + (d === 0 ? 1 : d === 1 ? -1 : 0), nr = orr + (d === 2 ? 1 : d === 3 ? -1 : 0); target = nc >= 0 && nc < Wp && nr >= 0 && nr < Hp ? nr * Wp + nc : R.int(cells); }
        else if (q < 0.85) { const c = np[a] % Wp, r = (np[a] / Wp) | 0, nc = c + R.int(5) - 2, nr = r + R.int(3) - 1; target = nc >= 0 && nc < Wp && nr >= 0 && nr < Hp ? nr * Wp + nc : R.int(cells); }
        else target = R.int(cells);
        if (target === np[a]) continue;
        const b = occ[target], pa = np[a]; np[a] = target; if (b >= 0) np[b] = pa;
        nports = dropPorts(ports, b >= 0 ? [a, b] : [a], R);
      } else if (kind < 0.84) {                                  // swap two whole rows or columns
        const byRow = R() < 0.5, lim = byRow ? Hp : Wp, x = R.int(lim), y = R.int(lim); if (x === y) continue;
        for (let i = 0; i < A.n; i++) { const c = np[i] % Wp, r = (np[i] / Wp) | 0; if (byRow) { if (r === x) np[i] = y * Wp + c; else if (r === y) np[i] = x * Wp + c; } else if (c === x) np[i] = r * Wp + y; else if (c === y) np[i] = r * Wp + x; }
        nports = {};
      } else {                                                   // port hint on a crossing or bendy edge
        const pool = []; for (const [i, j] of cu.cross) pool.push(i, j); cu.bends.forEach((b, e) => { if (b >= 2) pool.push(e); });
        const e = pool.length && R() < 0.8 ? pool[R.int(pool.length)] : R.int(nE), ed = g.edges[e];
        if (!ed || ed.from === ed.to) continue;
        nports = { ...ports };
        if (R() < 0.18) delete nports[ed.id]; else nports[ed.id] = { from: R.pick(SIDES), to: R.pick(SIDES) };
      }
      const r = await evaluate(np, Wp, Hp, nports, sized);
      if (!r.m) continue;
      const d = r.score - cur.score;
      if (d <= 0 || R() < Math.exp(-d / T)) {
        pos = np; ports = nports; cur = r; cu = culprits(r.geom);
        if (r.score < best.r.score - 1e-9) best = { pos: Int32Array.from(pos), Wp, Hp, ports: { ...ports }, r };
      }
    }
    return best;
  }
  // phase C: with channels already sized, try every pair of port sides on the edges that still cross or bend a lot, keep what the router likes better
  async function polish(st, budget) {
    let cur = st, used = 0;
    const evalFixed = async (cfg, ports) => {
      const geom = await E.gridLayout(eg, cfg), m = E.metrics(geom); used++;
      return { score: score(m) + cellTerms(A, g, st.pos, st.Wp, pullArr) + marginTerm(A, g, geom), m, geom, cfg };
    };
    for (let round = 0; round < 3 && used < budget && !over(); round++) {
      let improved = false;
      const cu = culprits(cur.r.geom), count = new Map();
      for (const [i, j] of cu.cross) { count.set(i, (count.get(i) || 0) + 1); count.set(j, (count.get(j) || 0) + 1); }
      cu.bends.forEach((b, e) => { if (b >= 4) count.set(e, (count.get(e) || 0) + 0.5); });
      const pool = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]);
      for (const e of pool) {
        const ed = g.edges[e]; if (ed.from === ed.to) continue;
        for (const sa of SIDES) for (const sb of SIDES) {
          if (used >= budget || over()) break;
          const ports = { ...cur.ports, [ed.id]: { from: sa, to: sb } };
          if (cur.ports[ed.id] && cur.ports[ed.id].from === sa && cur.ports[ed.id].to === sb) continue;
          const r = await evalFixed({ ...cur.r.cfg, ports }, ports);
          if (r.m && r.score < cur.r.score - 1e-9) { cur = { ...cur, ports, r }; improved = true; }
        }
      }
      if (!improved) break;
    }
    stats.polishEvals = used;
    return cur;
  }
  function dropPorts(ports, moved, R) {                          // a port hint is about a side relative to where the other end was: forget it when an end moves
    const ids = new Set(moved.map(i => A.ids[i])), out = {};
    for (const [eid, v] of Object.entries(ports)) { const ed = edgeById.get(eid); if (ed && (ids.has(ed.from) || ids.has(ed.to)) && R() < 0.85) continue; out[eid] = v; }
    return out;
  }

  // ---------------------------------------------------------------- final route and hard-metric repair
  const fin = await finalize(bestS.r);
  log('final', JSON.stringify({ x: fin.m.crossings, bends: fin.m.bends, asp: fin.m.aspect, hard: hardOf(fin.m), evals: stats.evals, sized: stats.sizedEvals }));
  return done(fin.cfg);

  async function finalize(r0) {                                   // r0 already holds the routed geometry of its cfg: route again only to improve it, and only inside the ceiling
    let c = r0.cfg, geom = r0.geom, m = r0.m;
    if (!geom || !m) { geom = await E.gridLayout(eg, c); m = E.metrics(geom); }
    let sc = score(m) + hardCount(m) * 1000;
    for (const pen of [500, 1200]) {                              // the search ran at the default penalty; a higher one sometimes untangles the last crossing
      if (over()) break;
      const c2 = { ...c, route: { ...(c.route || {}), crossingPenalty: pen } }, g2 = await E.gridLayout(eg, c2), m2 = E.metrics(g2), s2 = score(m2) + hardCount(m2) * 1000;
      if (s2 < sc - 1e-9) { c = c2; geom = g2; m = m2; sc = s2; }
    }
    for (let pass = 0; pass < 5 && hardCount(m) > 0 && !over(); pass++) {
      const rep = E.channelReport ? E.channelReport(geom, { pitch: c.route?.nudge ?? 14, buf: c.route?.shapeBuffer ?? 16 }).filter(r => r.deficit > 0) : [];
      c = { ...c, colGap: { ...(c.colGap || {}) }, rowGap: { ...(c.rowGap || {}) } };
      if (rep.length) for (const r of rep) { const mp = r.axis === 'col' ? c.colGap : c.rowGap; mp[r.after] = (mp[r.after] || 0) + Math.ceil(r.deficit * 1.3); }
      else { c.gapX = Math.round(c.gapX * 1.15); c.gapY = Math.round(c.gapY * 1.15); }
      geom = await E.gridLayout(eg, c); m = E.metrics(geom);
    }
    return { cfg: c, geom, m };
  }
}
