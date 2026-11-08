// Cheap cell-level cost model of a placement, used for the construction and the first annealing pass. The real router is the final judge
// (chart.mjs); this only has to rank placements well enough that the router sees a handful of good starting points.
//   makeProxy(A, g, {W,H}) -> { cost(pos), anneal(pos, rand, iters) }
// pos[i] = cell index (c + r * W) of node i on a W x H cell grid; empty cells hold -1 in occ.
// Edge model in cell units: aligned = one straight run; otherwise the better of the two L routes (corner cell must be free).

const PY = 0.5;             // grid pitch is about 350 x 165 px, so a row is about half a column
const XW = 7;               // one crossing is worth a long detour: they are what readers hate
const STRIDE = 8;           // route record: [count, x0,y0, x1,y1, x2,y2]

export function makeProxy(A, g, { W, H, aspectLo = 1.45, aspectHi = 2.1, pitchX = 1, pitchY = PY } = {}) {
  const n = A.n, cells = W * H;
  const spineNext = new Map(); for (let i = 0; i + 1 < A.spine.length; i++) spineNext.set(A.spine[i], A.spine[i + 1]);
  const E = [];                                                  // one per unordered pair, weights summed, flags from the strongest member
  for (const p of A.pairs.values()) {
    const ed = p.edges.map(k => g.edges[k]);
    const spine = ed.some(e => spineNext.get(e.from) === e.to);
    E.push({ a: p.a, b: p.b, w: p.w + (spine ? 2.2 : 0), spine, back: p.edges.every(k => A.back.has(k)) });
  }
  const m = E.length;
  const inc = Array.from({ length: n }, () => []);
  E.forEach((e, i) => { inc[e.a].push(i); inc[e.b].push(i); });
  const sinkNode = A.ids.map(id => A.roles[id].end && !A.roles[id].source);
  const startNode = A.idx.get(A.spine[0]);
  const spineSteps = []; for (let i = 0; i + 1 < A.spine.length; i++) spineSteps.push([A.idx.get(A.spine[i]), A.idx.get(A.spine[i + 1])]);
  const pw = E.map(e => Math.min(1.6, 0.5 + 0.5 * e.w));        // crossing weight per edge (heavier edges hurt more to cross)

  const st = { pos: null, occ: new Int32Array(cells).fill(-1), R: new Float64Array(m * STRIDE), L: new Float64Array(m) };

  function edgeRoute(i, S) {
    const e = E[i], pa = S.pos[e.a], pb = S.pos[e.b], occ = S.occ;
    const c1 = pa % W, r1 = (pa / W) | 0, c2 = pb % W, r2 = (pb / W) | 0, dc = c2 - c1, dr = r2 - r1, o = i * STRIDE, R = S.R;
    const between = (ca, ra, cb, rb) => {                        // occupied cells strictly inside a straight run
      let k = 0;
      if (ra === rb) { const lo = Math.min(ca, cb), hi = Math.max(ca, cb); for (let c = lo + 1; c < hi; c++) if (occ[ra * W + c] >= 0) k++; }
      else { const lo = Math.min(ra, rb), hi = Math.max(ra, rb); for (let r = lo + 1; r < hi; r++) if (occ[r * W + ca] >= 0) k++; }
      return k;
    };
    let blocked = 0, bends = 0;
    if (dc === 0 || dr === 0) { R[o] = 2; R[o + 1] = c1; R[o + 2] = r1; R[o + 3] = c2; R[o + 4] = r2; blocked = between(c1, r1, c2, r2); }
    else {
      const bH = between(c1, r1, c2, r1) + between(c2, r1, c2, r2) + (occ[r1 * W + c2] >= 0 ? 1 : 0);
      const bV = between(c1, r1, c1, r2) + between(c1, r2, c2, r2) + (occ[r2 * W + c1] >= 0 ? 1 : 0);
      const useH = bH < bV || (bH === bV && Math.abs(dc) * pitchX >= Math.abs(dr) * pitchY);
      R[o] = 3; R[o + 1] = c1; R[o + 2] = r1; if (useH) { R[o + 3] = c2; R[o + 4] = r1; } else { R[o + 3] = c1; R[o + 4] = r2; } R[o + 5] = c2; R[o + 6] = r2;
      blocked = useH ? bH : bV; bends = 1;
    }
    const d = Math.abs(dc) * pitchX + Math.abs(dr) * pitchY, adj = Math.abs(dc) + Math.abs(dr) === 1;
    let c = e.w * (d + bends * 0.5 - (adj ? 0.35 : 0)) + blocked * (3.2 + e.w);
    if (e.back && !adj) c += 0.4 * e.w * d;                      // returns want to stay short: the long ones are the ugly ones
    S.L[i] = c;
  }
  function cross(RA, i, RB, j) {
    let k = 0; const oi = i * STRIDE, oj = j * STRIDE;
    for (let s = 0; s < RA[oi] - 1; s++) {
      const ax0 = RA[oi + 1 + 2 * s], ay0 = RA[oi + 2 + 2 * s], ax1 = RA[oi + 3 + 2 * s], ay1 = RA[oi + 4 + 2 * s], ah = ay0 === ay1;
      for (let t = 0; t < RB[oj] - 1; t++) {
        const bx0 = RB[oj + 1 + 2 * t], by0 = RB[oj + 2 + 2 * t], bx1 = RB[oj + 3 + 2 * t], by1 = RB[oj + 4 + 2 * t], bh = by0 === by1;
        if (ah === bh) {                                         // collinear shared stretch: the router lays them side by side, cheap but not free
          if (ah && ay0 === by0) { if (Math.min(Math.max(ax0, ax1), Math.max(bx0, bx1)) - Math.max(Math.min(ax0, ax1), Math.min(bx0, bx1)) > 0.01) k += 0.15 / XW; }
          else if (!ah && ax0 === bx0) { if (Math.min(Math.max(ay0, ay1), Math.max(by0, by1)) - Math.max(Math.min(ay0, ay1), Math.min(by0, by1)) > 0.01) k += 0.15 / XW; }
          continue;
        }
        const hx0 = ah ? Math.min(ax0, ax1) : Math.min(bx0, bx1), hx1 = ah ? Math.max(ax0, ax1) : Math.max(bx0, bx1), hy = ah ? ay0 : by0;
        const vx = ah ? bx0 : ax0, vy0 = ah ? Math.min(by0, by1) : Math.min(ay0, ay1), vy1 = ah ? Math.max(by0, by1) : Math.max(ay0, ay1);
        if (vx > hx0 + 1e-6 && vx < hx1 - 1e-6 && hy > vy0 + 1e-6 && hy < vy1 - 1e-6) k += 1;
      }
    }
    return k * XW * Math.min(pw[i], pw[j]);
  }
  function nodeTerm(i, pos) {
    const p = pos[i], c = p % W, r = (p / W) | 0; let t = 0;
    if (sinkNode[i]) t += 1.4 * Math.min(c, W - 1 - c, (r * pitchY) / pitchX, ((H - 1 - r) * pitchY) / pitchX);
    if (i === startNode) t += 0.9 * (c + r * 0.8);
    return t;
  }
  function globalTerm(pos) {                                     // happy path steps + overall shape
    let t = 0;
    for (const [u, v] of spineSteps) {
      const pu = pos[u], pv = pos[v], dc = (pv % W) - (pu % W), dr = ((pv / W) | 0) - ((pu / W) | 0);
      if (dr < 0) t += 2.2 + 0.6 * -dr;
      const dd = Math.abs(dc) + Math.abs(dr); if (dd > 1) t += 0.6 * (dd - 1);
    }
    let c0 = W, c1 = -1, r0 = H, r1 = -1;
    for (let i = 0; i < n; i++) { const p = pos[i], c = p % W, r = (p / W) | 0; if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r; }
    const bw = c1 - c0 + 1, bh = r1 - r0 + 1, asp = (bw * pitchX) / (bh * pitchY);   // cell box -> approximate pixel aspect
    if (asp < aspectLo) t += (aspectLo - asp) * 14; else if (asp > aspectHi) t += (asp - aspectHi) * 14;
    return t + (bw * bh - n) * 0.55;                             // empty cells inside the box cost: spread, but never sprawl
  }
  const load = (S, pos) => { S.pos = pos; S.occ.fill(-1); for (let i = 0; i < n; i++) S.occ[pos[i]] = i; for (let i = 0; i < m; i++) edgeRoute(i, S); };
  function total(S) {
    let t = globalTerm(S.pos);
    for (let i = 0; i < m; i++) t += S.L[i];
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) t += cross(S.R, i, S.R, j);
    for (let i = 0; i < n; i++) t += nodeTerm(i, S.pos);
    return t;
  }
  const fresh = () => ({ pos: null, occ: new Int32Array(cells).fill(-1), R: new Float64Array(m * STRIDE), L: new Float64Array(m) });
  function cost(p) { const S = fresh(); load(S, Int32Array.from(p)); return total(S); }

  function anneal(p0, rand, iters, { t0 = 3.2, t1 = 0.12 } = {}) {
    const S = fresh(); load(S, Int32Array.from(p0));
    let curCost = total(S), bestCost = curCost, best = Int32Array.from(S.pos);
    const Rold = new Float64Array(m * STRIDE), Lold = new Float64Array(m), mark = new Uint8Array(m);
    for (let it = 0; it < iters; it++) {
      const T = t0 * Math.pow(t1 / t0, it / iters), pos = S.pos;
      const a = rand.int(n), mode = rand(); let target;
      if (mode < 0.55 && inc[a].length) {                        // next to one of a's neighbours
        const ei = rand.pick(inc[a]), q = pos[E[ei].a === a ? E[ei].b : E[ei].a], qc = q % W, qr = (q / W) | 0, d = rand.int(4);
        const nc = qc + (d === 0 ? 1 : d === 1 ? -1 : 0), nr = qr + (d === 2 ? 1 : d === 3 ? -1 : 0);
        target = nc >= 0 && nc < W && nr >= 0 && nr < H ? nr * W + nc : rand.int(cells);
      } else if (mode < 0.8) { const c = pos[a] % W, r = (pos[a] / W) | 0, nc = c + rand.int(3) - 1, nr = r + rand.int(3) - 1; target = nc >= 0 && nc < W && nr >= 0 && nr < H ? nr * W + nc : rand.int(cells); }
      else target = rand.int(cells);
      if (target === pos[a]) continue;
      const b = S.occ[target];
      Rold.set(S.R); Lold.set(S.L);
      const gOld = globalTerm(pos) + nodeTerm(a, pos) + (b >= 0 ? nodeTerm(b, pos) : 0);
      const pa = pos[a]; pos[a] = target; S.occ[target] = a; if (b >= 0) { pos[b] = pa; S.occ[pa] = b; } else S.occ[pa] = -1;
      for (let i = 0; i < m; i++) edgeRoute(i, S);
      // changed edges: any whose record moved, whose blocking changed, or that touch a or b
      mark.fill(0); const C = [];
      for (let i = 0; i < m; i++) {
        let ch = Lold[i] !== S.L[i];
        for (let q = 0; !ch && q < STRIDE; q++) ch = Rold[i * STRIDE + q] !== S.R[i * STRIDE + q];
        if (ch) { mark[i] = 1; C.push(i); }
      }
      let before = 0, after = 0;
      for (const i of C) { before += Lold[i]; after += S.L[i]; }
      for (const i of C) for (let j = 0; j < m; j++) { if (j === i || (mark[j] && j < i)) continue; before += cross(Rold, i, Rold, j); after += cross(S.R, i, S.R, j); }
      const gNew = globalTerm(pos) + nodeTerm(a, pos) + (b >= 0 ? nodeTerm(b, pos) : 0);
      const delta = (after - before) + (gNew - gOld);
      if (delta <= 0 || rand() < Math.exp(-delta / T)) {
        curCost += delta;
        if (curCost < bestCost - 1e-9) { bestCost = curCost; best = Int32Array.from(pos); }
      } else {
        pos[a] = pa; S.occ[pa] = a; if (b >= 0) { pos[b] = target; S.occ[target] = b; } else S.occ[target] = -1;
        S.R.set(Rold); S.L.set(Lold);
      }
    }
    return { pos: best, cost: cost(best) };
  }
  return { E, cost, anneal, W, H, cells };
}
