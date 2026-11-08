// Corridors of the tiled whole map: everything free of boxes. Streets and the outer margin, the gutters between parts (and above and below
// them), and the free vertical and horizontal channels inside every part (derived from the real node rectangles). Two corridors of opposite
// axes meet at a vertex when each one's extent covers the other's whole band, so a turn is legal on any track of either.
//   makeCorridors(frame, plan, tiles) -> [corridor]
//     corridor = { i, id, axis:'v'|'h', kind:'street'|'margin'|'gutter'|'tile', b0,b1 (band), u0,u1 (usable track range), e0,e1 (extent along the axis), tile, rs }
//     rs = the size-table key of a corridor that can grow (streets, gutters); tile channels are fixed.
//   makeNet(list) -> net { list, verts:[{v,h}], on:[[vertex ids sorted along corridor i]], at }       (topology: built once)
//   rebind(net, list2) -> net      the same topology with the coordinates of a rebuilt frame
import { K } from './tiles.mjs';

const free = (iv, lo, hi) => { const s = iv.slice().sort((a, b) => a[0] - b[0]), out = []; let c = lo; for (const [a, b] of s) { if (a > c) out.push([c, a]); if (b > c) c = b; } if (c < hi) out.push([c, hi]); return out; };
export const MARGIN = { street: 10, margin: 10, gutter: 10 };

export function makeCorridors(frame, plan, tiles) {
  const L = [], byId = new Map(), add = c => { c.i = L.length; c.tile = c.tile ?? -1; L.push(c); byId.set(c.id, c); return c; };
  L.near = {};
  const hband = (id, kind, y0, y1, e0, e1, rs) => { const m = MARGIN[kind] ?? 12; return add({ id, axis: 'h', kind, b0: y0, b1: y1, u0: y0 + m, u1: Math.max(y0 + m, y1 - m), e0, e1, rs }); };
  const vband = (id, kind, x0, x1, e0, e1, rs) => { const m = MARGIN[kind] ?? 12; return add({ id, axis: 'v', kind, b0: x0, b1: x1, u0: x0 + m, u1: Math.max(x0 + m, x1 - m), e0, e1, rs }); };
  const W = frame.W;
  frame.hs.forEach((s, r) => hband(s.id, (r === 0 || r === frame.hs.length - 1) ? 'margin' : 'street', s.y0, s.y1, 0, W, s.id));
  vband(frame.vsl.id, 'margin', frame.vsl.x0, frame.vsl.x1, frame.vsl.y0, frame.vsl.y1, frame.vsl.id);
  vband(frame.vsr.id, 'margin', frame.vsr.x0, frame.vsr.x1, frame.vsr.y0, frame.vsr.y1, frame.vsr.id);
  frame.vs.forEach(row => row.slice(1, -1).forEach(s => vband(s.id, 'street', s.x0, s.x1, s.y0, s.y1, s.id)));
  frame.rows.forEach((row, r) => { const B = frame.blocks[row.blocks[0]]; hband(`RT${r}`, 'gutter', B.ht.y0, B.ht.y1, 0, W, `RT${r}`); });    // the gutter above the first parts runs the whole width of its row
  for (const B of frame.blocks) {
    const row = frame.vs[B.row], left = row[B.k], right = row[B.k + 1];
    const e0 = left.x0, e1 = right.x1, blk = plan.blocks[B.bi];
    hband(B.hb.id, 'gutter', B.hb.y0, B.hb.y1, e0, e1, B.hb.id);
    for (const g of B.vg) vband(g.id, 'gutter', g.x0, g.x1, B.ht.y0, B.hb.y1, g.id);
    // the gutters between the parts of one column run across that column (and over the vertical gutters beside it), so they sit at different heights in different columns
    B.hgc.forEach((gaps, c) => { const lf = c === 0 ? left : B.vg[c - 1], rg = c === blk.C - 1 ? right : B.vg[c]; for (const g of gaps) hband(g.id, 'gutter', g.y0, g.y1, lf.x0, rg.x1, g.id); });
    for (const cell of B.cells) {
      const t = tiles[cell.tile], cw = blk.cw[cell.c], rh = t.h, col = blk.cols[cell.c], last = col.tiles.length - 1;
      const above = cell.i === 0 ? B.ht : B.hgc[cell.c][cell.i - 1], below = cell.i === last ? B.hb : B.hgc[cell.c][cell.i];
      const lft = cell.c === 0 ? left : B.vg[cell.c - 1], rgt = cell.c === blk.C - 1 ? right : B.vg[cell.c];
      const lo = lft.x0, hi = rgt.x1;
      if (!t.fx) { t.fx = free(t.geom.nodes.map(n => [n.x, n.x + n.w]), 0, cw); t.fy = free(t.geom.nodes.map(n => [n.y, n.y + n.h]), 0, rh); }
      const nv = [byId.get(lft.id).i, byId.get(rgt.id).i], nh = [byId.get(above.id).i, byId.get(below.id).i];
      L.near[t.idx] = { v: nv, h: nh, cell };
      t.fx.forEach(([a, b], j) => {                                           // vertical channels
        const u0 = a + (a > 0 ? 14 : 4), u1 = b - (b < cw ? 14 : 4); if (u1 < u0) return;
        L.near[t.idx].v.push(add({ id: `IV${t.idx}.${j}`, axis: 'v', kind: 'tile', b0: cell.x0 + a, b1: cell.x0 + b, u0: cell.x0 + u0, u1: cell.x0 + u1, e0: above.y0, e1: below.y1, tile: t.idx, rs: null }).i);
      });
      t.fy.forEach(([a, b], j) => {                                           // horizontal channels
        const u0 = a + (a > 0 ? 14 : 4), u1 = b - (b < rh ? 14 : 4); if (u1 < u0) return;
        L.near[t.idx].h.push(add({ id: `IH${t.idx}.${j}`, axis: 'h', kind: 'tile', b0: cell.y0 + a, b1: cell.y0 + b, u0: cell.y0 + u0, u1: cell.y0 + u1, e0: lo, e1: hi, tile: t.idx, rs: null }).i);
      });
    }
  }
  return L;
}

const cen = c => (c.u0 + c.u1) / 2;
export function makeNet(list) {
  const V = list.filter(c => c.axis === 'v'), H = list.filter(c => c.axis === 'h'), verts = [], on = list.map(() => []);
  for (const v of V) for (const h of H) {
    if (v.e0 <= h.b0 + 1e-6 && v.e1 >= h.b1 - 1e-6 && h.e0 <= v.b0 + 1e-6 && h.e1 >= v.b1 - 1e-6) { const id = verts.length; verts.push({ v: v.i, h: h.i }); on[v.i].push(id); on[h.i].push(id); }
  }
  const net = { list, verts, on, pos: [], cx: [], cy: [] };
  fill(net);
  for (const c of list) on[c.i].sort((a, b) => (c.axis === 'v' ? net.cy[a] - net.cy[b] : net.cx[a] - net.cx[b]) || a - b);
  return net;
}
function fill(net) {
  net.verts.forEach((t, i) => { net.cx[i] = cen(net.list[t.v]); net.cy[i] = cen(net.list[t.h]); });
}
export function rebind(net, list2) {
  if (list2.length !== net.list.length) throw new Error('rebind: corridor count changed');
  list2.forEach((c, i) => { if (c.id !== net.list[i].id) throw new Error('rebind: corridor order changed at ' + c.id); });
  const n2 = { ...net, list: list2, cx: [], cy: [] }; fill(n2);
  return n2;
}
export const along = (net, c, vid) => (c.axis === 'v' ? net.cy[vid] : net.cx[vid]);

// Two corridors that run the same way and share a stretch (the same street band crossed from two rows, the same gutter reached from two parts)
// would put their tracks on the same coordinates. Their track lattices are given opposite phases (half a pitch apart), so no two tracks of
// corridors that overlap are ever nearer than half a pitch. phasesOf(list) -> [0 | 0.5] per corridor (a greedy two-colouring of the overlaps).
export function phasesOf(list) {
  const ph = list.map(() => -1), adj = list.map(() => []), ov = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 0.5;
  for (const ax of ['v', 'h']) {
    const cs = list.filter(c => c.axis === ax).sort((p, q) => p.b0 - q.b0 || p.i - q.i);
    for (let i = 0; i < cs.length; i++) for (let j = i - 1; j >= 0; j--) {
      const c = cs[i], d = cs[j]; if (d.b1 <= c.b0 + 0.5 && j < i - 40) break;
      if (ov(c.b0, c.b1, d.b0, d.b1) && ov(c.e0, c.e1, d.e0, d.e1)) { adj[c.i].push(d.i); adj[d.i].push(c.i); }
    }
  }
  for (const c of list) {                                           // breadth-first two-colouring of every connected group of overlapping corridors
    if (ph[c.i] >= 0) continue;
    ph[c.i] = 0; const q = [c.i];
    for (let h = 0; h < q.length; h++) for (const n of adj[q[h]]) if (ph[n] < 0) { ph[n] = 1 - ph[q[h]]; q.push(n); }
  }
  return ph.map(p => p * 0.5);
}
