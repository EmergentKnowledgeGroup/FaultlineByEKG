// The corridor router of the tiled whole map. A* over the corridor graph: a state is (vertex, axis) = "at this crossing, travelling along its
// vertical (0) or horizontal (1) corridor". Cost = length x class weight + BEND per turn + a load term on every segment (and every box side).
// Nothing here reads a clock or Math.random; ties break on the order states were pushed.
//   makeRouter(net, nodes, near) -> router       nodes: [{ id, tile, x, y, w, h }] absolute rectangles at the nominal frame;
//                                                near[tile] = { v:[corridor ids], h:[...] } the corridors a box of that tile can reach
//   router.options(nodeIdx) -> { E:[opt], W:[opt], N:[opt], S:[opt] }      opt = { c, p, d, side }  corridor, position along it, stub length
//   router.route(a, b) -> path | null     path = { corr:[c...], turn:[vertex...], sa, sb, ka, kb, cost }   ka / kb: segment of the stub entry
//   router.commit(path, a, b, +1|-1)      router.load / router.cap (per segment), router.sideLoad / router.sideCap (per node x side E W N S)
import { along } from './corridors.mjs';

export const W_CLASS = { street: 0.8, gutter: 1, margin: 1.2, tile: 5 };
export const BEND = 200;
export const SIDES = ['E', 'W', 'N', 'S'];

class Heap {
  constructor() { this.k = []; this.v = []; this.n = 0; }
  push(key, val) { let i = this.n++; const k = this.k, v = this.v; while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; } k[i] = key; v[i] = val; }
  pop() {
    const k = this.k, v = this.v, top = v[0]; this.top = k[0];
    const key = k[--this.n], val = v[this.n]; let i = 0; const n = this.n;
    if (n > 0) { for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= key) break; k[i] = k[c]; v[i] = v[c]; i = c; } k[i] = key; v[i] = val; }
    return top;
  }
}

export function makeRouter(net, nodes, near, opts = {}) {
  const { list, verts, on } = net, minGap = opts.minGap ?? 14;
  const nV = verts.length, wOf = c => W_CLASS[c.kind] ?? 1, ctile = Int32Array.from(list, c => c.tile);   // a road may use the channels of a part only if that part holds one of its ends
  const segBase = [], cap = [], load = []; let nS = 0;                    // corridor c has on[c].length + 1 segments; segment k lies between vertex k-1 and k
  for (const c of list) { segBase[c.i] = nS; nS += on[c.i].length + 1; }
  for (let s = 0; s < nS; s++) { cap.push(Infinity); load.push(0); }
  const nbr = new Int32Array(nV * 4).fill(-1), nseg = new Int32Array(nV * 4).fill(-1), nlen = new Float64Array(nV * 4), nw = new Float64Array(nV * 4);
  const idxOn = new Int32Array(nV * 2);
  for (const c of list) {
    const o = on[c.i], a = c.axis === 'v' ? 0 : 1;
    o.forEach((vid, k) => {
      idxOn[vid * 2 + a] = k;
      if (k > 0) { const e = vid * 4 + a * 2, u = o[k - 1]; nbr[e] = u; nseg[e] = segBase[c.i] + k; nlen[e] = along(net, c, vid) - along(net, c, u); nw[e] = wOf(c); }
      if (k < o.length - 1) { const e = vid * 4 + a * 2 + 1, u = o[k + 1]; nbr[e] = u; nseg[e] = segBase[c.i] + k + 1; nlen[e] = along(net, c, u) - along(net, c, vid); nw[e] = wOf(c); }
    });
  }
  const segOf = (c, p) => { const o = on[c.i]; let lo = 0, hi = o.length; while (lo < hi) { const m = (lo + hi) >> 1; if (along(net, c, o[m]) < p) lo = m + 1; else hi = m; } return lo; };
  const sideCap = new Int32Array(nodes.length * 4).fill(1 << 20), sideSoft = new Int32Array(nodes.length * 4).fill(1 << 20), sideLoad = new Int32Array(nodes.length * 4);   // sideSoft: slots 8 px apart; sideCap: slots packed 4.5 px apart
  const loadCost = s => { const L = load[s]; return L >= cap[s] ? 2500 + 400 * (L - cap[s] + 1) : cap[s] === Infinity ? 0.5 * L : 90 * (L / cap[s]) ** 2 + 0.5 * L; };
  const sidePen = (ni, s) => { const k = ni * 4 + SIDES.indexOf(s), L = sideLoad[k]; return L >= sideCap[k] ? 300 + 100 * (L - sideCap[k] + 1) : L >= sideSoft[k] ? 30 + 12 * (L - sideSoft[k]) : 3 * L; };
  const byTile = new Map(); nodes.forEach(n => { if (!byTile.has(n.tile)) byTile.set(n.tile, []); byTile.get(n.tile).push(n); });

  // ---- options: for one box side, the nearest corridors a straight stub can reach (at most 2)
  const opt = new Map();
  function optionsOf(ni) {
    if (opt.has(ni)) return opt.get(ni);
    const n = nodes[ni], out = { E: [], W: [], N: [], S: [] }, others = byTile.get(n.tile).filter(m => m !== n);
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2, nr = near[n.tile], V = nr.v.map(i => list[i]), H = nr.h.map(i => list[i]);
    const blocked = (x0, x1, y0, y1) => others.some(m => m.x < x1 && m.x + m.w > x0 && m.y < y1 && m.y + m.h > y0);
    const yOk = c => c.e0 <= n.y + 12 && c.e1 >= n.y + n.h - 12, xOk = c => c.e0 <= n.x + 16 && c.e1 >= n.x + n.w - 16;
    const R = n.x + n.w + minGap, Lf = n.x - minGap, Bt = n.y + n.h + minGap, Tp = n.y - minGap;
    const cand = {
      E: V.filter(c => c.u1 >= R && yOk(c)).sort((a, b) => Math.max(a.u0, R) - Math.max(b.u0, R) || a.i - b.i),
      W: V.filter(c => c.u0 <= Lf && yOk(c)).sort((a, b) => Math.min(b.u1, Lf) - Math.min(a.u1, Lf) || a.i - b.i),
      S: H.filter(c => c.u1 >= Bt && xOk(c)).sort((a, b) => Math.max(a.u0, Bt) - Math.max(b.u0, Bt) || a.i - b.i),
      N: H.filter(c => c.u0 <= Tp && xOk(c)).sort((a, b) => Math.min(b.u1, Tp) - Math.min(a.u1, Tp) || a.i - b.i),
    };
    for (const s of SIDES) for (const c of cand[s]) {
      if (out[s].length >= 2) break;
      let t, d, p;
      if (s === 'E') { t = Math.max(c.u0, R); d = t - (n.x + n.w); p = cy; if (blocked(n.x + n.w, t, n.y + 12, n.y + n.h - 12)) break; }
      else if (s === 'W') { t = Math.min(c.u1, Lf); d = n.x - t; p = cy; if (blocked(t, n.x, n.y + 12, n.y + n.h - 12)) break; }
      else if (s === 'S') { t = Math.max(c.u0, Bt); d = t - (n.y + n.h); p = cx; if (blocked(n.x + 16, n.x + n.w - 16, n.y + n.h, t)) break; }
      else { t = Math.min(c.u1, Tp); d = n.y - t; p = cx; if (blocked(n.x + 16, n.x + n.w - 16, t, n.y)) break; }
      if (!on[c.i].length) continue;
      out[s].push({ c: c.i, p, d, side: s, k: segOf(c, p) });
    }
    opt.set(ni, out); return out;
  }

  // ---- one search
  const g = new Float64Array(nV * 2), prev = new Int32Array(nV * 2), stamp = new Int32Array(nV * 2), goalCost = new Float64Array(nV * 2), goalOpt = new Int32Array(nV * 2), goalStamp = new Int32Array(nV * 2);
  let epoch = 0;
  function route(ai, bi, ban = null) {
    const A = optionsOf(ai), B = optionsOf(bi), ta = nodes[ai].tile, tb = nodes[bi].tile;
    epoch++;
    const heap = new Heap(), starts = [], goals = [];
    let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
    const open = (ni, s) => sideLoad[ni * 4 + SIDES.indexOf(s)] < sideCap[ni * 4 + SIDES.indexOf(s)];     // a side with no free slot is used only when nothing else is left
    const ok = o => !ban || !ban.has(o.c);                                                           // a corridor the caller asked this route to avoid
    for (const s of SIDES) if (open(ai, s)) for (const o of A[s]) if (ok(o)) starts.push(o);
    for (const s of SIDES) if (open(bi, s)) for (const o of B[s]) if (ok(o)) goals.push(o);
    if (!starts.length) for (const s of SIDES) for (const o of A[s]) if (ok(o)) starts.push(o);
    if (!goals.length) for (const s of SIDES) for (const o of B[s]) if (ok(o)) goals.push(o);
    if (!starts.length) for (const s of SIDES) for (const o of A[s]) starts.push(o);
    if (!goals.length) for (const s of SIDES) for (const o of B[s]) goals.push(o);
    if (!starts.length || !goals.length) return null;
    let direct = null;
    goals.forEach((o, gi) => {
      const c = list[o.c], a = c.axis === 'v' ? 0 : 1, vs = on[c.i], w = wOf(c), base = o.d * 5 + sidePen(bi, o.side) + BEND + 0.5 * loadCost(segBase[c.i] + o.k);
      const gx = c.axis === 'v' ? (c.u0 + c.u1) / 2 : o.p, gy = c.axis === 'v' ? o.p : (c.u0 + c.u1) / 2;
      gx0 = Math.min(gx0, gx); gx1 = Math.max(gx1, gx); gy0 = Math.min(gy0, gy); gy1 = Math.max(gy1, gy);
      for (const vi of [o.k - 1, o.k]) if (vi >= 0 && vi < vs.length) {
        const st = vs[vi] * 2 + a, cost = base + Math.abs(along(net, c, vs[vi]) - o.p) * w;
        if (goalStamp[st] !== epoch || cost < goalCost[st]) { goalStamp[st] = epoch; goalCost[st] = cost; goalOpt[st] = gi; }
      }
    });
    const hfn = vid => { const x = net.cx[vid], y = net.cy[vid]; return 0.8 * (Math.max(0, gx0 - x, x - gx1) + Math.max(0, gy0 - y, y - gy1)); };
    const push = (st, cost, pv) => { if (stamp[st] === epoch && g[st] <= cost) return; stamp[st] = epoch; g[st] = cost; prev[st] = pv; heap.push(cost + hfn(st >> 1), st); };
    starts.forEach((o, si) => {
      const c = list[o.c], a = c.axis === 'v' ? 0 : 1, vs = on[c.i], w = wOf(c), base = o.d * 5 + sidePen(ai, o.side) + BEND + 0.5 * loadCost(segBase[c.i] + o.k);
      for (const q of goals) if (q.c === o.c && q.k === o.k) {
        const cost = base + q.d * 5 + sidePen(bi, q.side) + BEND + Math.abs(q.p - o.p) * w;
        if (!direct || cost < direct.cost) direct = { cost, o, q };
      }
      for (const vi of [o.k - 1, o.k]) if (vi >= 0 && vi < vs.length) push(vs[vi] * 2 + a, base + Math.abs(along(net, c, vs[vi]) - o.p) * w, -2 - si);
    });
    let best = direct ? direct.cost : Infinity, bestSt = -1;
    while (heap.n) {
      const st = heap.pop(), cost = g[st], vid = st >> 1;
      if (heap.top > cost + hfn(vid) + 1e-9) continue;                                   // stale entry
      if (heap.top >= best) break;
      const a = st & 1;
      if (goalStamp[st] === epoch && cost + goalCost[st] < best) { best = cost + goalCost[st]; bestSt = st; }
      for (let d = 0; d < 2; d++) { const e = vid * 4 + a * 2 + d, u = nbr[e]; if (u >= 0) push(u * 2 + a, cost + nlen[e] * nw[e] + loadCost(nseg[e]), st); }
      const cc = a ? verts[vid].v : verts[vid].h, c2 = ctile[cc]; if ((c2 < 0 || c2 === ta || c2 === tb) && !(ban && ban.has(cc))) push(vid * 2 + (1 - a), cost + BEND, st);
    }
    if (bestSt < 0 && !direct) return null;
    if (direct && direct.cost <= best) return { corr: [direct.o.c], turn: [], sa: direct.o.side, sb: direct.q.side, ka: direct.o.k, kb: direct.q.k, cost: direct.cost };
    const chain = []; let st = bestSt;
    while (st >= 0) { chain.push(st); st = prev[st]; }
    const so = starts[-2 - st], go = goals[goalOpt[bestSt]];
    chain.reverse();
    const corr = [], turn = [], corrOf = s => (s & 1 ? verts[s >> 1].h : verts[s >> 1].v);
    for (const s of chain) { const c = corrOf(s); if (!corr.length) corr.push(c); else if (corr[corr.length - 1] !== c) { corr.push(c); turn.push(s >> 1); } }
    return { corr, turn, sa: so.side, sb: go.side, ka: so.k, kb: go.k, cost: best };
  }
  // ordinal of a mark on corridor c: a vertex is its index in on[c]; a stub entering segment k is k - 0.5
  const ordOf = (c, vid) => idxOn[vid * 2 + (c.axis === 'v' ? 0 : 1)];
  function touched(p) {
    const out = [], n = p.corr.length;
    for (let i = 0; i < n; i++) {
      const c = list[p.corr[i]], o0 = i === 0 ? p.ka - 0.5 : ordOf(c, p.turn[i - 1]), o1 = i === n - 1 ? p.kb - 0.5 : ordOf(c, p.turn[i]);
      const lo = Math.min(o0, o1), hi = Math.max(o0, o1);
      for (let k = Math.floor(lo) + 1; k <= Math.ceil(hi); k++) if (k - 1 < hi && k > lo) out.push(segBase[c.i] + k);
    }
    return out;
  }
  function commit(p, ai, bi, sgn) {
    for (const s of touched(p)) load[s] += sgn;
    sideLoad[ai * 4 + SIDES.indexOf(p.sa)] += sgn; sideLoad[bi * 4 + SIDES.indexOf(p.sb)] += sgn;
  }
  return { options: optionsOf, route, commit, touched, load, cap, sideCap, sideSoft, sideLoad, segBase, segOf, ordOf, nS };
}
