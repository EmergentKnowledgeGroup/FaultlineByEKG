// Street-level planner for long cross-stage routes. The router alone sends every long route through whatever gap is cheapest, which is often a
// narrow row gap inside a block; here each chosen edge gets a path through the STREETS between stage blocks (and, for very long ones, the outer
// margins), turned into router checkpoints with one lane per overlapping run, plus the port sides it should leave and enter by.
//   planStreets({ pos, stageOf, blockOf, extents, macro, edges, opts }) -> { via:{edgeId:[[c,r,dx,dy],..]}, ports:{edgeId:{from,to}}, info:{planned,modelCrossings,need:{"x1":px,..}} }
//   pos {nodeId:[c,r]} global cells; stageOf {nodeId:stageId}; blockOf {stageId:{gc,gr}}; extents {stageId:{col0,row0,w,h}};
//   macro {GC,GR,colOff[],colW[],rowOff[],rowH[]}; edges [{id,from,to}] cross-stage edges
// opts: { pitch:18, turn:0.15, cong:0.35, margins:(edge)=>bool outer ring allowed, laneMax:8, saIters:30000, seed, mu:0.03 }
// Coordinates are global cell units (viaMode "channel"): integer = cell centre, x.5 = middle of the clear gap between column x and x+1.
import { rng } from './rng.mjs';

const PXC = 340, PXR = 165;                // px per cell column / row (cost model only)

export function planStreets({ pos, stageOf, blockOf, extents, macro, edges, opts = {} }) {
  const pitch = opts.pitch ?? 18, turnPen = opts.turn ?? 0.15, cong = opts.cong ?? 0.35, LMAX = opts.laneMax ?? 8;
  const R = rng(opts.seed ?? 12345);
  const occ = new Set(Object.values(pos).map(p => p[0] + ',' + p[1]));
  // street lines: X = left margin, one per block-column boundary, right margin; Y likewise
  const X = [-0.9, ...Array.from({ length: macro.GC - 1 }, (_, j) => macro.colOff[j] + macro.colW[j] - 1 + 0.5), macro.colOff[macro.GC - 1] + macro.colW[macro.GC - 1] - 1 + 0.9];
  const Y = [-1.1, ...Array.from({ length: macro.GR - 1 }, (_, r) => macro.rowOff[r] + macro.rowH[r] - 1 + 0.5), macro.rowOff[macro.GR - 1] + macro.rowH[macro.GR - 1] - 1 + 1.1];
  const lineOK = (axis, i, marg) => marg || (axis === 'x' ? (i > 0 && i < X.length - 1) : (i > 0 && i < Y.length - 1));

  const exits = (id, marg) => {
    const [c, r] = pos[id], b = blockOf[stageOf[id]], e = extents[stageOf[id]], res = [];
    const blockedRow = d => { let n = 0; for (let cc = c + d; cc >= e.col0 && cc < e.col0 + e.w; cc += d) if (occ.has(cc + ',' + r)) n++; return n; };
    const blockedCol = d => { let n = 0; for (let rr = r + d; rr >= e.row0 && rr < e.row0 + e.h; rr += d) if (occ.has(c + ',' + rr)) n++; return n; };
    const adj = (dc, dr) => occ.has((c + dc) + ',' + (r + dr));
    const add = (side, axis, idx, pt, dist, blocked, a) => { if (!lineOK(axis, idx, marg)) return; const u = axis === 'x' ? PXC : PXR; res.push({ side, axis, idx, pt, cost: dist + blocked * 1.6 * u + (a ? 0.9 * u : 0) }); };
    add('E', 'x', b.gc + 1, [X[b.gc + 1], r], Math.abs(X[b.gc + 1] - c) * PXC, blockedRow(1), adj(1, 0));
    add('W', 'x', b.gc, [X[b.gc], r], Math.abs(X[b.gc] - c) * PXC, blockedRow(-1), adj(-1, 0));
    add('S', 'y', b.gr + 1, [c, Y[b.gr + 1]], Math.abs(Y[b.gr + 1] - r) * PXR, blockedCol(1), adj(0, 1));
    add('N', 'y', b.gr, [c, Y[b.gr]], Math.abs(Y[b.gr] - r) * PXR, blockedCol(-1), adj(0, -1));
    return res;
  };
  const usage = new Map();
  const fixedAlong = axis => (axis === 'x' ? Y : X);
  const ivals = (axis, a, b) => { const F = fixedAlong(axis), lo = Math.min(a, b), hi = Math.max(a, b), out = []; for (let k = -1; k < F.length; k++) { const f0 = k < 0 ? -Infinity : F[k], f1 = k + 1 < F.length ? F[k + 1] : Infinity; const o = Math.min(hi, f1) - Math.max(lo, f0); if (o > 1e-9) out.push([k, o]); } return out; };
  const usedLen = (axis, idx, a, b) => ivals(axis, a, b).reduce((s, [k, o]) => s + o * (usage.get(axis + idx + ':' + k) || 0), 0);
  const addUse = (axis, idx, a, b) => { for (const [k] of ivals(axis, a, b)) usage.set(axis + idx + ':' + k, (usage.get(axis + idx + ':' + k) || 0) + 1); };

  function shortest(a, b, marg) {                                  // Dijkstra over street intersections; turns only at intersections
    const key = (axis, idx, s) => axis + idx + '@' + s.toFixed(3), V = new Map();
    const addV = (axis, idx, s) => { const k = key(axis, idx, s); if (!V.has(k)) V.set(k, { axis, idx, s, k }); return V.get(k); };
    const pa = a.axis === 'x' ? a.pt[1] : a.pt[0], pb = b.axis === 'x' ? b.pt[1] : b.pt[0];
    const start = addV(a.axis, a.idx, pa), goal = addV(b.axis, b.idx, pb);
    for (let i = 0; i < X.length; i++) if (lineOK('x', i, marg)) for (let j = 0; j < Y.length; j++) if (lineOK('y', j, marg)) { addV('x', i, Y[j]); addV('y', j, X[i]); }
    const byLine = new Map();
    for (const v of V.values()) { const lk = v.axis + v.idx; if (!byLine.has(lk)) byLine.set(lk, []); byLine.get(lk).push(v); }
    for (const l of byLine.values()) l.sort((p, q) => p.s - q.s);
    const nbr = v => {
      const out = [], l = byLine.get(v.axis + v.idx), i = l.indexOf(v);
      for (const d of [-1, 1]) { const w = l[i + d]; if (w) { const unit = v.axis === 'x' ? PXR : PXC; out.push([w, Math.abs(w.s - v.s) * unit + cong * usedLen(v.axis, v.idx, v.s, w.s) * unit + 1]); } }
      if (v.axis === 'x') { for (let j = 0; j < Y.length; j++) if (Math.abs(Y[j] - v.s) < 1e-6 && lineOK('y', j, marg)) out.push([V.get(key('y', j, X[v.idx])), turnPen * 900]); }
      else { for (let i2 = 0; i2 < X.length; i2++) if (Math.abs(X[i2] - v.s) < 1e-6 && lineOK('x', i2, marg)) out.push([V.get(key('x', i2, Y[v.idx])), turnPen * 900]); }
      return out;
    };
    const dist = new Map([[start.k, 0]]), prev = new Map(), done = new Set(), pq = [[0, start]];
    while (pq.length) {
      pq.sort((p, q) => p[0] - q[0]); const [d, v] = pq.shift();
      if (done.has(v.k)) continue; done.add(v.k);
      if (v.k === goal.k) break;
      for (const [w, c] of nbr(v)) { if (!w) continue; const nd = d + c; if (nd < (dist.get(w.k) ?? Infinity)) { dist.set(w.k, nd); prev.set(w.k, v); pq.push([nd, w]); } }
    }
    if (!dist.has(goal.k)) return null;
    const pts = []; let v = goal; while (v) { pts.push(v); v = prev.get(v.k); } pts.reverse();
    return { pts, cost: dist.get(goal.k) };
  }
  const manh = e => Math.abs(pos[e.from][0] - pos[e.to][0]) * PXC + Math.abs(pos[e.from][1] - pos[e.to][1]) * PXR;
  const sel = edges.filter(e => pos[e.from] && pos[e.to]).sort((p, q) => manh(q) - manh(p));
  const plans = [];
  for (const e of sel) {
    const marg = !!opts.margins?.(e), ex = exits(e.from, marg), en = exits(e.to, marg);
    let best = null;
    for (const a of ex) for (const b of en) { const path = shortest(a, b, marg); if (!path) continue; const total = a.cost + b.cost + path.cost; if (!best || total < best.total) best = { a, b, path, total }; }
    if (!best) continue;
    for (let k = 0; k + 1 < best.path.pts.length; k++) { const p = best.path.pts[k], q = best.path.pts[k + 1]; if (p.axis === q.axis && p.idx === q.idx) addUse(p.axis, p.idx, p.s, q.s); }
    plans.push({ e, ...best });
  }
  // runs per street line; one lane (px offset = lane * pitch) per overlapping run, found by centre-out placement, then annealed on the exact crossing count
  const runs = [];
  plans.forEach((pl, pi) => {
    const pts = pl.path.pts; pl.runs = []; pl.runIdx = []; let i = 0;
    while (i < pts.length) { let j = i; while (j + 1 < pts.length && pts[j + 1].axis === pts[i].axis && pts[j + 1].idx === pts[i].idx) j++; pl.runs.push({ axis: pts[i].axis, idx: pts[i].idx, s0: pts[i].s, s1: pts[j].s }); i = j + 1; }
    pl.runs.forEach(r => { pl.runIdx.push(runs.length); runs.push({ pi, axis: r.axis, idx: r.idx, lo: Math.min(r.s0, r.s1), hi: Math.max(r.s0, r.s1), lane: 0, placed: false }); });
  });
  const viaOf = pi => {
    const pl = plans[pi], pts = [];
    pl.runs.forEach((r, k) => {
      const o = runs[pl.runIdx[k]].lane * pitch, mk = s => (r.axis === 'x' ? [X[r.idx], s] : [s, Y[r.idx]]), p0 = mk(r.s0), p1 = mk(r.s1);
      const add = (p, dx, dy) => { const last = pts[pts.length - 1]; if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) { last[2] += dx; last[3] += dy; return; } pts.push([p[0], p[1], dx, dy]); };
      const dx = r.axis === 'x' ? o : 0, dy = r.axis === 'y' ? o : 0;
      add(p0, dx, dy); if (Math.abs(r.s0 - r.s1) > 1e-6) add(p1, dx, dy);
    });
    return pts;
  };
  const polySegs = pi => {
    const pl = plans[pi], via = viaOf(pi), nodePx = id => [pos[id][0] * PXC, pos[id][1] * PXR];
    const P = [nodePx(pl.e.from), ...via.map(v => [v[0] * PXC + v[2], v[1] * PXR + v[3]]), nodePx(pl.e.to)], out = [], eq = (a, b) => Math.abs(a - b) < 1e-6;
    for (let k = 0; k + 1 < P.length; k++) {
      const p = P[k], q = P[k + 1];
      if (eq(p[0], q[0]) || eq(p[1], q[1])) { out.push([p, q]); continue; }
      let corner;
      if (k === 0) corner = (pl.a.side === 'E' || pl.a.side === 'W') ? [q[0], p[1]] : [p[0], q[1]];
      else if (k + 2 === P.length) corner = (pl.b.side === 'E' || pl.b.side === 'W') ? [p[0], q[1]] : [q[0], p[1]];
      else corner = [q[0], p[1]];
      out.push([p, corner], [corner, q]);
    }
    return out.filter(([p, q]) => !(eq(p[0], q[0]) && eq(p[1], q[1])));
  };
  const crossSegs = (A, B) => {
    let c = 0;
    for (const a of A) for (const b of B) {
      const ah = Math.abs(a[0][1] - a[1][1]) < 1e-6, bh = Math.abs(b[0][1] - b[1][1]) < 1e-6; if (ah === bh) continue;
      const h = ah ? a : b, v = ah ? b : a, hx0 = Math.min(h[0][0], h[1][0]), hx1 = Math.max(h[0][0], h[1][0]), vy0 = Math.min(v[0][1], v[1][1]), vy1 = Math.max(v[0][1], v[1][1]);
      if (v[0][0] > hx0 + 1e-6 && v[0][0] < hx1 - 1e-6 && h[0][1] > vy0 + 1e-6 && h[0][1] < vy1 - 1e-6) c++;
    }
    return c;
  };
  const padCell = 0.3;
  const overlaps = (a, b) => a.axis === b.axis && a.idx === b.idx && a.lo - padCell < b.hi && b.lo - padCell < a.hi;
  const conflicts = (ri, lane) => { const r = runs[ri]; for (let j = 0; j < runs.length; j++) if (j !== ri && runs[j].lane === lane && runs[j].placed && overlaps(r, runs[j])) return j; return -1; };
  for (const ri of runs.map((_, i) => i).sort((a, b) => (runs[b].hi - runs[b].lo) - (runs[a].hi - runs[a].lo))) {
    for (let t = 0; t <= 2 * LMAX; t++) { const lane = t % 2 ? -Math.ceil(t / 2) : t / 2; if (conflicts(ri, lane) < 0) { runs[ri].lane = lane; break; } }
    runs[ri].placed = true;
  }
  const segs = plans.map((_, pi) => polySegs(pi)), pair = Array.from({ length: plans.length }, () => new Float64Array(plans.length));
  let total = 0;
  for (let i = 0; i < plans.length; i++) for (let j = i + 1; j < plans.length; j++) { const c = crossSegs(segs[i], segs[j]); pair[i][j] = pair[j][i] = c; total += c; }
  const startTotal = total, mu = opts.mu ?? 0.03, iters = plans.length > 1 ? (opts.saIters ?? 30000) : 0;
  for (let it = 0; it < iters && runs.length; it++) {
    const ri = R.int(runs.length), r = runs[ri], lane = R() < 0.7 ? r.lane + (R() < 0.5 ? -1 : 1) * (1 + R.int(3)) : R.int(2 * LMAX + 1) - LMAX;
    if (lane === r.lane || Math.abs(lane) > LMAX) continue;
    const cj = conflicts(ri, lane), old = r.lane; let other = null;
    if (cj >= 0) { r.lane = 1e9; const ok = conflicts(cj, old) < 0; r.lane = old; if (!ok) continue; other = cj; }
    const aff = new Set([r.pi]); if (other !== null) aff.add(runs[other].pi);
    let before = 0; for (const a of aff) for (let b = 0; b < plans.length; b++) if (b !== a && !(aff.has(b) && b < a)) before += pair[a][b];
    r.lane = lane; if (other !== null) runs[other].lane = old;
    const ns = new Map(); for (const a of aff) ns.set(a, polySegs(a));
    let after = 0; const np = [];
    for (const a of aff) for (let b = 0; b < plans.length; b++) { if (b === a || (aff.has(b) && b < a)) continue; const c = crossSegs(ns.get(a), aff.has(b) ? ns.get(b) : segs[b]); after += c; np.push([a, b, c]); }
    const dLane = (Math.abs(lane) - Math.abs(old) + (other !== null ? Math.abs(old) - Math.abs(lane) : 0)) * mu;
    if (after - before + dLane <= 0) { for (const [a, b, c] of np) pair[a][b] = pair[b][a] = c; for (const a of aff) segs[a] = ns.get(a); total += after - before; }
    else { r.lane = old; if (other !== null) runs[other].lane = lane; }
  }
  const via = {}, ports = {}, info = { planned: plans.length, modelCrossings: total, modelCrossingsBeforeSA: startTotal, need: {} };
  for (const r of runs) { const k = r.axis + r.idx, off = Math.abs(r.lane) * pitch; if (off > (info.need[k] || 0)) info.need[k] = off; }   // widest lane offset (px) per street: the street must be wider than twice this, or a checkpoint lands inside a box
  plans.forEach((pl, pi) => { via[pl.e.id] = viaOf(pi).map(p => [+p[0].toFixed(3), +p[1].toFixed(3), Math.round(p[2]), Math.round(p[3])]); ports[pl.e.id] = { from: pl.a.side, to: pl.b.side }; });
  return { via, ports, info };
}
