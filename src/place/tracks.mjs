// Pieces and tracks of the tiled whole map. A routed path is a list of corridors; its piece in a corridor is a straight run along one
// track of it. Here: make the pieces, order them to cut crossings, give each its track index (symbolic: no coordinates yet), and size the
// streets and gutters from the track counts.
//   makePieces(net, paths, nodes) -> pieces[]      piece = { r, q, c, lo, hi (ordinals), dlo, dhi (turn directions), plo, phi (nominal positions) }
//   assignTracks(net, pieces, ctx) -> { T:[tracks per corridor], overflow:n, pos:[positions per fixed corridor] }
//   sizeTable(net, T, pitch) -> { corridorId: width|height }
import { along } from './corridors.mjs';
import { MIN } from './frame.mjs';

const sgn = v => (Math.abs(v) < 1e-6 ? 0 : v > 0 ? 1 : -1);
export const SPARE = 2;
const SIDE_DIR = { E: -1, W: 1, S: -1, N: 1 };            // from the corridor, which way the stub to a box on that side leads

// attach position (nominal) of a stub: the box side's middle along the side
const attach = (n, s) => (s === 'E' || s === 'W' ? n.y + n.h / 2 : n.x + n.w / 2);

export function makePieces(net, paths, nodes, routes, router) {
  const { list } = net, pieces = [];
  paths.forEach((p, r) => {
    if (!p) return;
    const n = p.corr.length, A = nodes[routes[r].a], B = nodes[routes[r].b];
    // marks M0..Mn: stub A, turn vertices, stub B; position of mark m along corridor c
    const pos = (q, m) => { const c = list[p.corr[q]]; if (m === 0) return attach(A, p.sa); if (m === n) return attach(B, p.sb); return along(net, c, p.turn[m - 1]); };
    const ord = (q, m) => (m === 0 ? p.ka - 0.5 : m === n ? p.kb - 0.5 : router.ordOf(list[p.corr[q]], p.turn[m - 1]));
    for (let q = 0; q < n; q++) {
      const c = list[p.corr[q]];
      // direction of the route just beyond each end of this piece
      const dir = m => {                                                  // m = q (start mark) or q+1 (end mark)
        if (m === 0) return SIDE_DIR[p.sa];
        if (m === n) return SIDE_DIR[p.sb];
        const nq = m === q ? q - 1 : q + 1;                               // the neighbouring corridor, which runs perpendicular
        const other = m === q ? pos(nq, m - 1) : pos(nq, m + 1);          // the neighbour's other mark
        const here = along(net, list[p.corr[nq]], p.turn[m - 1]);
        return sgn(other - here);
      };
      const o0 = ord(q, q), o1 = ord(q, q + 1), p0 = pos(q, q), p1 = pos(q, q + 1), d0 = dir(q), d1 = dir(q + 1);
      const fwd = o0 <= o1;
      pieces.push({ r, q, c: c.i, lo: fwd ? o0 : o1, hi: fwd ? o1 : o0, dlo: fwd ? d0 : d1, dhi: fwd ? d1 : d0, fwd, plo: fwd ? p0 : p1, phi: fwd ? p1 : p0, t: -1 });
    }
  });
  return pieces;
}

// order within one corridor: pieces that leave on the low side at both ends go first (lowest tracks); ties nest inner before outer
function orderKey(p) { const k1 = p.dlo + p.dhi, len = p.hi - p.lo; return [k1, k1 < 0 ? len : k1 > 0 ? -len : p.lo, p.r]; }
const cmpKey = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// first-fit with order: a piece takes the lowest track above every earlier piece of smaller key that really overlaps it, and not one that a
// touching piece uses. bad(piece, k) -> 0 free, 1 soft (a label), 2 blocked. nPos: how many tracks the corridor has (Infinity when it can grow)
export function packCorridor(ps, bad, nPos) {
  const items = ps.map(p => ({ p, key: orderKey(p) })).sort((a, b) => cmpKey(a.key, b.key));
  const done = []; let T = 0, overflow = 0;
  for (const it of items) {
    const p = it.p, used = new Set(); let tmin = 0;
    for (const q of done) {
      if (q.p.hi < p.lo - 1e-9 || q.p.lo > p.hi + 1e-9) continue;
      used.add(q.t);
      if (q.key[0] < it.key[0] && q.p.hi > p.lo + 1e-9 && q.p.lo < p.hi - 1e-9) tmin = Math.max(tmin, q.t + 1);
    }
    let pick = -1;
    const scan = (from, soft) => { for (let k = from; k < nPos && k < from + 400; k++) { if (used.has(k)) continue; const b = bad ? bad(p, k) : 0; if (b === 2 || (soft && b === 1)) continue; return k; } return -1; };
    pick = scan(tmin, true); if (pick < 0) pick = scan(tmin, false); if (pick < 0) pick = scan(0, true); if (pick < 0) pick = scan(0, false);
    if (pick < 0) { overflow++; pick = Math.max(...used, nPos === Infinity ? 0 : nPos - 1) + 1; }
    it.t = pick; p.t = pick; done.push(it); T = Math.max(T, pick + 1);
  }
  return { T, overflow };
}

// positions of the tracks of a corridor, centred in its usable range: resizable ones have exactly T, tile channels a fixed grid
export function trackPositions(c, T, pitch, phase = 0) {
  const ph = phase * pitch;
  if (c.rs) { if (T <= 0) return []; const k0 = Math.round(((c.u0 + c.u1) / 2 - ph) / pitch - (T - 1) / 2); return Array.from({ length: T }, (_, j) => ph + pitch * (k0 + j)); }      // T = the tracks the pieces need plus the spare ones
  const k0 = Math.ceil((c.u0 - ph) / pitch - 1e-9), k1 = Math.floor((c.u1 - ph) / pitch + 1e-9);
  return k1 < k0 ? [(c.u0 + c.u1) / 2] : Array.from({ length: k1 - k0 + 1 }, (_, j) => ph + pitch * (k0 + j));
}

// obstacles a tile channel must keep clear of: the part's own routes running along it, and (softly) its label pills. ctx.obst[tile] = { v:[{x,y0,y1}], h:[{y,x0,x1}], lab:[{x,y,w,h}] }
function badFn(c, ctx, positions) {
  const o = ctx.obst[c.tile]; if (!o) return null;
  const isV = c.axis === 'v', segs = (isV ? o.v : o.h).filter(s => (isV ? s.x : s.y) > c.b0 - 4 && (isV ? s.x : s.y) < c.b1 + 4);
  const labs = o.lab.filter(l => (isV ? l.x < c.b1 && l.x + l.w > c.b0 : l.y < c.b1 && l.y + l.h > c.b0));
  const cell = ctx.cell[c.tile], nom = ctx.cellNom ? ctx.cellNom[c.tile] : cell, d = isV ? cell.y0 - nom.y0 : cell.x0 - nom.x0;   // marks were measured at the nominal frame
  return (p, k) => {
    const s = positions[k]; if (s === undefined) return 2;
    const lo = Math.max(p.plo + d - 6, isV ? cell.y0 : cell.x0), hi = Math.min(p.phi + d + 6, isV ? cell.y1 : cell.x1);
    if (hi <= lo) return 0;
    for (const g of segs) { const gc = isV ? g.x : g.y, g0 = isV ? g.y0 : g.x0, g1 = isV ? g.y1 : g.x1; if (Math.abs(gc - s) < 3.7 && g0 < hi && g1 > lo) return 2; }
    for (const l of labs) { const a0 = isV ? l.x : l.y, a1 = a0 + (isV ? l.w : l.h), l0 = isV ? l.y : l.x, l1 = l0 + (isV ? l.h : l.w); if (s > a0 - 1 && s < a1 + 1 && l0 < hi && l1 > lo) return 1; }
    return 0;
  };
}

export function assignTracks(net, pieces, ctx, which = 'all') {
  const { list } = net, by = list.map(() => []);
  for (const p of pieces) by[p.c].push(p);
  const T = list.map(() => 0); let overflow = 0;
  for (const c of list) {
    if (!by[c.i].length) continue;
    let r;
    if (c.rs) { if (which === 'fixed') continue; r = packCorridor(by[c.i], null, Infinity); }
    else {
      if (which === 'rs') continue;
      let P = ctx.pos ? ctx.pos[c.i] : trackPositions(c, 0, ctx.pitch); r = packCorridor(by[c.i], badFn(c, ctx, P), P.length);
      for (let pp = ctx.pitch - 0.5; r.overflow && pp >= 3.2; pp = pp > 3.2 ? Math.max(3.2, pp - 0.4) : 0) { P = trackPositions(c, 0, pp, ctx.phase ? ctx.phase[c.i] : 0); r = packCorridor(by[c.i], badFn(c, ctx, P), P.length); if (!r.overflow && ctx.pos) { ctx.pos[c.i] = P; ctx.tight = (ctx.tight || 0) + 1; } }
    }
    T[c.i] = r.T; overflow += r.overflow;
  }
  return { T, overflow, by };
}

export function sizeTable(net, T, pitch, more = {}) {
  const need = {};
  for (const c of net.list) {
    if (!c.rs) continue;
    const m = (c.u0 - c.b0);                                               // the corridor's own margin
    const kind = c.kind === 'margin' ? 'margin' : c.kind;
    const n = T[c.i] > 0 ? T[c.i] + SPARE + (more[c.id] || 0) : 0;                           // spare tracks: room to nudge a piece clear of a neighbour
    need[c.id] = Math.max(MIN[kind] ?? 44, n > 0 ? (n - 1) * pitch + 2 * m + pitch : 0);
  }
  return need;
}

// capacity of every segment of a tile channel: the pitch-spaced tracks no route of the part runs along over that stretch (soft label hits still count)
export function segCaps(net, router, ctx) {
  const { list, on } = net;
  for (const c of list) {
    if (c.rs) continue;
    const P = trackPositions(c, 0, ctx.pitch), bad = badFn(c, ctx, P), vs = on[c.i], cell = ctx.cell[c.tile];
    for (let k = 0; k <= vs.length; k++) {
      const a = k === 0 ? c.e0 : along(net, c, vs[k - 1]), b = k === vs.length ? c.e1 : along(net, c, vs[k]);
      const p = { plo: Math.min(a, b), phi: Math.max(a, b) };
      let n = 0; if (bad) for (let q = 0; q < P.length; q++) { if (bad(p, q) !== 2) n++; } else n = P.length;
      router.cap[router.segBase[c.i] + k] = Math.max(1, n);
    }
  }
}
