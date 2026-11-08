// The tiled whole map: every stage chart part keeps its saved geometry as a tile, tiles sit in stage blocks, blocks in a snake of rows, and the
// routes between parts run through streets and gutters found by a fast corridor router. No libavoid, no search, no clock. docs/SCALE.md.
//   composeTiled(model, charts, geoms, { pitch, passes, lap, log }) -> { geom, stats }
//     geom = { id:'whole', width, height, nodes, edges, clusters }   same shape as any chart; cross-part edges carry cross:true and focusLabel
//     (opts.lap(phase) is called after each phase so the caller can time it; this module never reads a clock)
import { wrapLabel } from '../engine/layout.mjs';
import { orderedStages } from '../build/util.mjs';
import { loadTiles, planBlock, snakeRows, K } from './tiles.mjs';
import { buildFrame } from './frame.mjs';
import { makeCorridors, makeNet, rebind, phasesOf } from './corridors.mjs';
import { makeRouter, SIDES } from './hroute.mjs';
import { makePieces, assignTracks, sizeTable, trackPositions, segCaps, SPARE } from './tracks.mjs';
import { tileObstacles, slotsOf, sideRange, placeStubs, polylineOf } from './lines.mjs';
import { resolve } from './repair.mjs';
import { foreignTiles, vacancy } from './measure.mjs';
import { stageTone } from './compose.mjs';
import { metrics } from '../engine/metrics.mjs';

export const TILED_VERSION = 1;
export const TILED_ABOVE = { boxes: 120, routes: 220 };
export const useTiled = (chart) => chart.boxes.length > TILED_ABOVE.boxes || chart.routes.length > TILED_ABOVE.routes;

const HARD = ['nodeOverlaps', 'edgeThroughNode', 'trackOverlaps', 'labelOverlapsLabel', 'labelOverlapsNode', 'diagonalSegs', 'shortArrowStubs', 'labelMissing'];

export function composeTiled(model, charts, geoms, opts = {}) {
  const lap = opts.lap || (() => {}), log = opts.log || (() => {});
  // ---- tiles, blocks, snake
  const L = loadTiles(model, charts, geoms);
  if (L.missing.length) throw new Error(`tiled: no geometry for stage chart(s) ${L.missing.slice(0, 5).join(', ')}${L.missing.length > 5 ? ' ...' : ''}; place them first`);
  const { tiles } = L, blocks = L.stages.map(s => planBlock(s)), sIdx = new Map(L.stages.map((s, i) => [s.id, i]));
  const tileOf = new Map(); for (const c of charts) if (c.kind === 'stage') { const t = tiles.find(x => x.chartId === c.id); if (t) for (const b of c.boxes) tileOf.set(b.id, t.idx); }
  const whole = charts.find(c => c.kind === 'whole'), all = whole ? whole.routes : model.routes;
  const cnt = new Map();
  for (const r of all) { const a = sIdx.get(tiles[tileOf.get(r.from)]?.stage), b = sIdx.get(tiles[tileOf.get(r.to)]?.stage); if (a === undefined || b === undefined || a === b) continue; const k = Math.min(a, b) * 1e4 + Math.max(a, b); cnt.set(k, (cnt.get(k) || 0) + 1); }
  const links = [...cnt].map(([k, w]) => ({ a: Math.floor(k / 1e4), b: k % 1e4, w }));
  lap('tiles');
  const C = { model, charts, L, tiles, blocks, tileOf, all, opts, lap, log };
  const first = snakeRows(blocks, links, { keep: opts.candidates ?? 5 });
  // each candidate snake (a different row break) is laid out, routed and measured; the best one wins: bars first (hard metrics, aspect), then crossings and length
  let best = null; const tried = [];
  for (const sn of [first, ...first.alternatives].slice(0, opts.candidates ?? 4)) {
    let r; try { r = layoutOnce(C, sn); } catch (e) { tried.push({ rows: sn.rows.length, error: e.message }); continue; }
    const m = metrics(r.geom), hard = HARD.reduce((a, k) => a + (m[k] || 0), 0), asp = m.aspect < K.ASPECT[0] ? K.ASPECT[0] - m.aspect : m.aspect > K.ASPECT[1] ? m.aspect - K.ASPECT[1] : 0;
    r.score = hard * 1e7 + (asp > 0 ? 1e6 + asp * 1e5 : 0) + (r.stats.assignOverflow || 0) * 1e5 + (r.stats.foreignTile || 0) * 2000 + (r.stats.vacancy.vacant > 0.12 ? (r.stats.vacancy.vacant - 0.12) * 4e5 : 0) + m.crossings + m.totalLen / 200 + 40000 * Math.abs(Math.log(m.aspect / 1.7));
    r.m = m; tried.push({ rows: sn.rows.length, aspect: m.aspect, hard, crossings: m.crossings, len: m.totalLen, pitch: r.stats.pitch, score: Math.round(r.score) });
    if (!best || r.score < best.score) best = r;
    if (!opts.candidates && hard === 0 && asp === 0 && sn === first) { /* the best-cost snake is in the bar: still compare the others, they are cheap */ }
  }
  if (!best) throw new Error('tiled: no snake could be laid out: ' + tried.map(t => t.error).join('; '));
  best.stats.tried = tried; best.stats.snake = { rows: best.rows, cost: best.snakeCost };
  return best;
}

function layoutOnce(C, sn, hooks) {
  const { model, charts, L, tiles, blocks, tileOf, all, opts, lap, log } = C;
  let pitch = opts.pitch ?? (all.length > 1000 ? 4 : K.PITCH);   // big systems start tight: a great many roads need narrow ribbons
  const stats = { pitch };
  const plan = { blocks, rows: sn.rows }; stats.snakeAsp = +sn.asp.toFixed(2);
  // ---- nominal frame, corridors, graph
  let need = {};
  const f0 = buildFrame(plan, need), frame = buildFrame(plan, need, f0.W);
  let list = makeCorridors(frame, plan, tiles), net = makeNet(list);
  stats.corridors = list.length; stats.vertices = net.verts.length;
  const nodes = [], nodeIdx = new Map(), cellOf = [];
  for (const B of frame.blocks) for (const cell of B.cells) {
    cellOf[cell.tile] = { x0: cell.x0, y0: cell.y0, x1: cell.x1, y1: cell.y1 };
    for (const n of tiles[cell.tile].geom.nodes) { nodeIdx.set(n.id, nodes.length); nodes.push({ id: n.id, tile: cell.tile, x: cell.x0 + n.x, y: cell.y0 + n.y, w: n.w, h: n.h, kind: n.kind, lx: n.x, ly: n.y }); }
  }
  // ---- routes: inside a part they keep the part's points; the others are routed
  const internal = new Set(); for (const t of tiles) for (const e of t.geom.edges) internal.add(e.id);
  const cross = [];
  const bc = idx => { const t = cellOf[idx]; return [(t.x0 + t.x1) / 2, (t.y0 + t.y1) / 2]; };
  for (const r of all) {
    const ta = tileOf.get(r.from), tb = tileOf.get(r.to);
    if (ta === undefined || tb === undefined) throw new Error(`tiled: route ${r.id} has an end that is in no stage chart`);
    if (ta === tb) { if (!internal.has(r.id)) throw new Error(`tiled: route ${r.id} is inside part ${tiles[ta].chartId} but its saved geometry lacks it (re-place that chart)`); continue; }
    const pa = bc(ta), pb = bc(tb);
    cross.push({ r, a: nodeIdx.get(r.from), b: nodeIdx.get(r.to), bd: Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) });
  }
  cross.sort((p, q) => q.bd - p.bd || (p.r.id < q.r.id ? -1 : 1));
  stats.cross = cross.length;
  const obs = tiles.map(t => (t.obs ||= tileObstacles(t)));
  const shift = (t, c) => ({ v: obs[t].v.map(s => ({ x: s.x + c.x0, y0: s.y0 + c.y0, y1: s.y1 + c.y0 })), h: obs[t].h.map(s => ({ y: s.y + c.y0, x0: s.x0 + c.x0, x1: s.x1 + c.x0 })), lab: obs[t].lab.map(l => ({ x: l.x + c.x0, y: l.y + c.y0, w: l.w, h: l.h })) });
  const endsFor = cm => { const o = {}; tiles.forEach((t, i) => { const c = cm[i]; for (const [k, v] of Object.entries(obs[i].ends)) o[k] = v.map(p => p + (k.endsWith(':E') || k.endsWith(':W') ? c.y0 : c.x0)); }); return o; };
  const endsAbs = endsFor(cellOf);
  lap('frame');
  // ---- route in two passes (the second re-routes each route with the loads of all the others)
  const nomCtx = { obst: tiles.map((_, i) => shift(i, cellOf[i])), cell: cellOf, pitch };
  const router = makeRouter(net, nodes, list.near);
  segCaps(net, router, nomCtx);
  nodes.forEach((n, ni) => SIDES.forEach((s, si) => { const ends = endsAbs[n.id + ':' + s] || []; router.sideSoft[ni * 4 + si] = Math.max(1, slotsOf(n, s, ends, 8).length); router.sideCap[ni * 4 + si] = Math.max(router.sideSoft[ni * 4 + si], slotsOf(n, s, ends, 4.5, 4.1).length); }));
  const paths = new Array(cross.length).fill(null);
  const routeAll = pass => { for (let i = 0; i < cross.length; i++) { if (pass && paths[i]) router.commit(paths[i], cross[i].a, cross[i].b, -1); const p = router.route(cross[i].a, cross[i].b); paths[i] = p; if (p) router.commit(p, cross[i].a, cross[i].b, 1); } };
  routeAll(0); lap('route1'); for (let p = 1; p <= (opts.passes ?? 3); p++) { routeAll(1); lap('route' + (p + 1)); }
  stats.unrouted = paths.filter(p => !p).length;
  if (stats.unrouted) throw new Error(`tiled: ${stats.unrouted} route(s) found no path (e.g. ${cross[paths.findIndex(p => !p)].r.id})`);
  // ---- pieces, tracks, street sizes; the frame is rebuilt at the sizes the tracks need. A pitch that overflows a part's channels or leaves the aspect bar steps down.
  const rr = cross.map(c => ({ a: c.a, b: c.b }));
  let pieces = makePieces(net, paths, nodes, rr, router);
  lap('pieces');
  const pitches = opts.pitches || [pitch, 6, 5, 4].filter((p, i) => i === 0 || p < pitch);
  const edgeOf = (nd, side) => (side === 'E' ? nd.x + nd.w : side === 'W' ? nd.x : side === 'S' ? nd.y + nd.h : nd.y), horiz = side => side === 'E' || side === 'W';
  let byRoute, usedCorr;
  const refresh = () => { byRoute = cross.map(() => []); for (const p of pieces) byRoute[p.r][p.q] = p; usedCorr = new Set(pieces.map(p => p.c)); };
  refresh();
  // one full settling at a pitch: track counts -> street sizes -> frame -> positions -> stub slots -> nudges. `more`: spare tracks asked for by corridors that could not be cleared.
  const settle = (pitchUsed, more) => {
    nomCtx.pitch = pitchUsed;
    const A = assignTracks(net, pieces, nomCtx, 'rs');
    let need = sizeTable(net, A.T, pitchUsed, more);
    const fn0 = buildFrame(plan, need); let Wt = fn0.W;
    // a map just outside the aspect bar is brought in by widening its streets (wider) or its row streets (taller), not by squeezing the tracks
    if (fn0.W / fn0.H < K.ASPECT[0]) Wt = Math.ceil(fn0.H * (K.ASPECT[0] + 0.02));
    else if (fn0.W / fn0.H > K.ASPECT[1] && sn.rows.length > 1) { const add = (fn0.W / (K.ASPECT[1] - 0.02) - fn0.H) / (sn.rows.length - 1); need = { ...need }; for (let r = 1; r < sn.rows.length; r++) need['HS' + r] = (need['HS' + r] ?? K.SH0) + add; }
    const fin = buildFrame(plan, need, Wt), list2 = makeCorridors(fin, plan, tiles), net2 = rebind(net, list2);
    const cellF = []; for (const B of fin.blocks) for (const cell of B.cells) cellF[cell.tile] = { x0: cell.x0, y0: cell.y0, x1: cell.x1, y1: cell.y1 };
    const phase = pitchUsed >= 6.5 ? phasesOf(list2) : list2.map(() => 0);
    const posF = list2.map(c => (c.rs ? trackPositions(c, A.T[c.i] + (A.T[c.i] > 0 ? SPARE + (more[c.id] || 0) : 0), pitchUsed, phase[c.i]) : usedCorr.has(c.i) ? trackPositions(c, 0, pitchUsed, phase[c.i]) : null));
    const fctx = { obst: tiles.map((_, i) => shift(i, cellF[i])), cell: cellF, cellNom: cellOf, pitch: pitchUsed, pos: posF, phase };
    const F = assignTracks(net2, pieces, fctx, 'fixed');
    const nodesF = nodes.map(n => ({ ...n, x: cellF[n.tile].x0 + n.lx, y: cellF[n.tile].y0 + n.ly }));
    const tcOf = p => { const P = posF[p.c]; return P ? P[Math.min(p.t, P.length - 1)] : 0; };
    const items = [];
    cross.forEach((cr, i) => {
      const pa = byRoute[i][0], pz = byRoute[i][byRoute[i].length - 1], path = paths[i];
      const away = (p, startMark) => (startMark ? (p.fwd ? 1 : -1) : (p.fwd ? -1 : 1));
      items.push({ node: cr.a, side: path.sa, key: i, c: pa.c, tc: tcOf(pa), away: away(pa, true), end: 'A' });
      items.push({ node: cr.b, side: path.sb, key: i, c: pz.c, tc: tcOf(pz), away: away(pz, false), end: 'B' });
    });
    const slots = placeStubs(items, nodesF, endsFor(cellF));
    const slotOf = new Map(); for (const arr of slots.values()) for (const { it, at } of arr) slotOf.set(it.key + it.end, at);
    // nothing may run along anything else: nudge the few pieces and stubs that do
    const axesR = cross.map((_, i) => paths[i].corr.map(c => list2[c].axis)), tR = cross.map((_, i) => byRoute[i].map(tcOf));
    const slotA = cross.map((_, i) => slotOf.get(i + 'A')), slotB = cross.map((_, i) => slotOf.get(i + 'B'));
    const ends = cross.map((cr, i) => [{ axis: horiz(paths[i].sa) ? 'h' : 'v', edge: edgeOf(nodesF[cr.a], paths[i].sa) }, { axis: horiz(paths[i].sb) ? 'h' : 'v', edge: edgeOf(nodesF[cr.b], paths[i].sb) }]);
    const band = cross.map((cr, i) => paths[i].corr.map((ci, q) => {
      const c = list2[ci]; let lo = c.rs ? c.u0 - 3 : c.u0, hi = c.rs ? c.u1 + 3 : c.u1;
      for (const [qq, side, edge] of [[0, paths[i].sa, ends[i][0].edge], [paths[i].corr.length - 1, paths[i].sb, ends[i][1].edge]]) if (q === qq) { if (side === 'E' || side === 'S') lo = Math.max(lo, edge + 15); else hi = Math.min(hi, edge - 15); }
      return [lo, hi];
    }));
    const slotRange = cross.map((cr, i) => [sideRange(nodesF[cr.a], paths[i].sa), sideRange(nodesF[cr.b], paths[i].sb)]);
    const inner = []; tiles.forEach((tl, ti) => { const c = cellF[ti]; for (const g of obs[ti].v) inner.push({ axis: 'v', coord: g.x + c.x0, lo: g.y0 + c.y0, hi: g.y1 + c.y0 }); for (const g of obs[ti].h) inner.push({ axis: 'h', coord: g.y + c.y0, lo: g.x0 + c.x0, hi: g.x1 + c.x0 }); });
    const rep = resolve({ axes: axesR, t: tR, slotA, slotB, ends, inner, band, slotRange, pitch: pitchUsed, corr: paths.map(p => p.corr) });
    return { pitchUsed, A, F, fin, list2, net2, cellF, posF, nodesF, slotOf, axesR, tR, slotA, slotB, rep, tcOf, fctx };
  };
  let S = null;
  for (let pi = 0; pi < pitches.length; pi++) {
    const more = {};
    for (let round = 0; round < 6; round++) {
      S = settle(pitches[pi], more);
      if (!S.rep.stuck.length) break;
      for (const ci of S.rep.stuck) { const id = S.list2[ci].id; if (S.list2[ci].rs) more[id] = (more[id] || 0) + 2 + round; }           // give the crowded corridor room to move its runs apart
      stats.spareRounds = round + 1;
    }
    const asp = S.fin.W / S.fin.H;
    if (pi < pitches.length - 1 && (S.F.overflow || asp < K.ASPECT[0] || asp > K.ASPECT[1] || S.fin.W > 40000)) continue;
    break;
  }
  // runs that no nudge could clear: those routes are sent round another way (told to keep out of the corridor they were stuck in) and everything is settled again
  const banned = new Map();
  for (let round = 0; round < (opts.rerouteRounds ?? 4) && S.rep.stuckItems.length; round++) {
    let any = false;
    for (const [i, ci] of S.rep.stuckItems) { if (!banned.has(i)) banned.set(i, new Set()); if (!banned.get(i).has(ci)) { banned.get(i).add(ci); any = true; } }
    if (!any) break;
    for (const i of [...new Set(S.rep.stuckItems.map(x => x[0]))]) { router.commit(paths[i], cross[i].a, cross[i].b, -1); const p = router.route(cross[i].a, cross[i].b, banned.get(i)); if (p) paths[i] = p; router.commit(paths[i], cross[i].a, cross[i].b, 1); }
    pieces = makePieces(net, paths, nodes, rr, router); refresh();
    const more = {}; let T2;
    for (let sub = 0; sub < 4; sub++) { T2 = settle(S.pitchUsed, more); if (!T2.rep.stuck.length) break; for (const ci of T2.rep.stuck) { const id = T2.list2[ci].id; if (T2.list2[ci].rs) more[id] = (more[id] || 0) + 2 + sub; } }
    S = T2; stats.rerouted = (stats.rerouted || 0) + banned.size;
  }
  const { fin, list2, net2, cellF, A, F, posF, nodesF, slotOf, axesR, tR, slotA, slotB, rep, tcOf } = S;
  stats.pitch = S.pitchUsed; stats.assignOverflow = F.overflow; stats.tightChannels = S.fctx.tight || 0; stats.nudged = rep.moved; stats.unresolved = rep.left;
  lap('coords');
  // ---- output geometry
  const outNodes = [], outEdges = [], spineSet = new Set(model.paths?.[0]?.boxes || []);
  const mainPairs = new Set(); (model.paths?.[0]?.boxes || []).forEach((id, i, a) => { if (i) mainPairs.add(a[i - 1] + '>' + id); });
  for (const B of fin.blocks) for (const cell of B.cells) {
    const t = tiles[cell.tile], dx = cell.x0, dy = cell.y0;
    for (const n of t.geom.nodes) outNodes.push({ ...n, x: n.x + dx, y: n.y + dy, ...(spineSet.has(n.id) ? { spine: true } : {}) });
    for (const e of t.geom.edges) outEdges.push({ ...e, pts: e.pts.map(p => [p[0] + dx, p[1] + dy]), labelBox: e.labelBox ? { ...e.labelBox, x: e.labelBox.x + dx, y: e.labelBox.y + dy } : e.labelBox });
  }
  cross.forEach((cr, i) => {
    const path = paths[i];
    const pts = polylineOf(path, axesR[i], nodesF[cr.a], nodesF[cr.b], slotA[i], slotB[i], tR[i]);
    const label = cr.r.when || '', lines = label ? wrapLabel(label, 20) : [];
    const e = { id: cr.r.id, from: cr.r.from, to: cr.r.to, type: cr.r.type || 'forward', label: lines.join(' '), lines, pts, labelBox: null, sides: [path.sa, path.sb], cross: true };
    if (lines.length) {
      let bi = 0, bl = -1; for (let k = 0; k < pts.length - 1; k++) { const l = Math.abs(pts[k + 1][0] - pts[k][0]) + Math.abs(pts[k + 1][1] - pts[k][1]); if (l > bl) { bl = l; bi = k; } }
      const w = Math.max(...lines.map(s => s.length)) * 6.9 + 12, h = lines.length * 15 + 6, mx = (pts[bi][0] + pts[bi + 1][0]) / 2, my = (pts[bi][1] + pts[bi + 1][1]) / 2;
      e.focusLabel = { x: Math.round((mx - w / 2) * 10) / 10, y: Math.round((my - h / 2) * 10) / 10, w: Math.round(w * 10) / 10, h };
    }
    if (cr.r.inferred) e.inferred = true;
    if (mainPairs.has(cr.r.from + '>' + cr.r.to)) e.spine = true;
    outEdges.push(e);
  });
  const clusters = fin.blocks.map((B, bi) => ({ id: L.stages[bi].id, title: L.stages[bi].title, x: B.x0, y: B.y0, w: B.x1 - B.x0, h: B.y1 - B.y0, tone: stageTone(bi, L.stages.length), titleBand: K.TITLE, nodes: L.stages[bi].tiles.flatMap(t => t.geom.nodes.map(n => n.id)) }));
  const geom = { id: 'whole', width: Math.ceil(fin.W), height: Math.ceil(fin.H), nodes: outNodes, edges: outEdges, clusters };
  stats.size = [geom.width, geom.height];
  stats.foreignTile = foreignTiles(outEdges, tiles.map((t, i) => ({ x: cellF[i].x0, y: cellF[i].y0, w: t.w, h: t.h })), tileOf);
  stats.vacancy = vacancy(fin, tiles, list2, usedCorr);
  lap('output');
  return { geom, stats, rows: sn.rows.map(r => r.length).join('+'), snakeCost: +sn.cost.toFixed(3), _dbg: { fin, plan, net: net2, pieces, paths, cross, A, need, tiles, byRoute, tcOf, slotOf, nodesF, posF, tR, slotA, slotB, axesR, router, nodes } };
}
