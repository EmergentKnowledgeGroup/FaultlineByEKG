// From symbolic paths to coordinates: attach slots on the box sides, final track positions, and the polyline of every cross-part route.
//   tileObstacles(tile) -> { v, h, lab, ends }   a part's own route segments, label pills and the ends of its routes on each box side (local coordinates)
//   slotsOf(node, side, occupied, spacing) -> [coordinate]    attach positions along a box side, away from corners and from route ends already there
//   placeStubs(items, nodesAbs, tracks) -> Map "node:side" -> [{ item, at }]    assigns the slots in the order that avoids stub crossings
//   polylineOf(path, A, B, sa, sb, slotA, slotB, tracks) -> [[x,y]...]
import { SIDES } from './hroute.mjs';

export function tileObstacles(tile) {
  const v = [], h = [], lab = [], ends = {}, nodes = new Map(tile.geom.nodes.map(n => [n.id, n]));
  const side = (n, p) => { const d = { E: Math.abs(p[0] - (n.x + n.w)), W: Math.abs(p[0] - n.x), N: Math.abs(p[1] - n.y), S: Math.abs(p[1] - (n.y + n.h)) }; return Object.keys(d).sort((a, b) => d[a] - d[b])[0]; };
  for (const e of tile.geom.edges) {
    const P = e.pts;
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1];
      if (Math.abs(a[0] - b[0]) < 0.5) v.push({ x: a[0], y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
      else if (Math.abs(a[1] - b[1]) < 0.5) h.push({ y: a[1], x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]) });
    }
    if (e.labelBox) lab.push({ x: e.labelBox.x, y: e.labelBox.y, w: e.labelBox.w, h: e.labelBox.h });
    for (const [nid, p] of [[e.from, P[0]], [e.to, P[P.length - 1]]]) {
      const n = nodes.get(nid); if (!n || !p) continue;
      const s = side(n, p), k = nid + ':' + s; (ends[k] ||= []).push(s === 'E' || s === 'W' ? p[1] : p[0]);
    }
  }
  return { v, h, lab, ends };
}

export function sideRange(n, side) {
  const horiz = side === 'E' || side === 'W', lo = horiz ? n.y : n.x, len = horiz ? n.h : n.w, pill = n.kind === 'end', margin = horiz ? 12 : 16;
  let a = lo + margin, b = lo + len - margin;
  if (pill) { if (horiz) { const c = lo + len / 2; a = Math.max(a, c - 10); b = Math.min(b, c + 10); } else { a = Math.max(a, n.x + n.h / 2 + 4); b = Math.min(b, n.x + n.w - n.h / 2 - 4); } }
  return [a, b];
}
export function slotsOf(n, side, occupied = [], spacing = 8, minAway = 7.5) {
  const [a, b] = sideRange(n, side);
  const cnt = Math.floor((b - a) / spacing + 1e-9) + 1; if (cnt <= 0) return [];
  const mid = (a + b) / 2, out = [];
  for (let i = 0; i < cnt; i++) { const p = mid + (i - (cnt - 1) / 2) * spacing; if (!occupied.some(o => Math.abs(o - p) < minAway)) out.push(p); }
  return out;
}

// items: [{ node, side, key (route id), c (corridor), tc (track coordinate), away (-1|+1 along the corridor) }]
export function placeStubs(items, nodes, endsOf) {
  const groups = new Map();
  for (const it of items) { const k = it.node + ':' + it.side; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  const out = new Map();
  for (const [k, g] of groups) {
    const n = nodes[g[0].node], side = g[0].side, edge = side === 'E' ? n.x + n.w : side === 'W' ? n.x : side === 'S' ? n.y + n.h : n.y;
    const near = it => (side === 'E' || side === 'S' ? it.tc - edge : edge - it.tc);
    const low = g.filter(it => it.away < 0).sort((a, b) => near(a) - near(b) || a.key - b.key);
    const high = g.filter(it => it.away >= 0).sort((a, b) => near(b) - near(a) || a.key - b.key);
    const order = [...low, ...high], m = order.length, occ = endsOf[n.id + ':' + side] || [];
    let S = slotsOf(n, side, occ, 8);
    for (const [sp, away] of [[6, 5.6], [4.5, 4.1], [3.4, 3.3]]) if (S.length < m) S = slotsOf(n, side, occ, sp, away);
    if (S.length < m) S = slotsOf(n, side, [], 3.2, 0);
    const start = Math.max(0, Math.floor((S.length - m) / 2));
    order.forEach((it, i) => { const at = S[Math.min(S.length - 1, start + i)]; (out.get(k) || out.set(k, []).get(k)).push({ it, at }); });
  }
  return out;
}

const edgePoint = (n, side, s) => (side === 'E' ? [n.x + n.w, s] : side === 'W' ? [n.x, s] : side === 'N' ? [s, n.y] : [s, n.y + n.h]);
// t[q] = the coordinate of the track of corridor q of the path (x for a vertical corridor, y for a horizontal one)
export function polylineOf(path, axes, A, B, slotA, slotB, t) {
  const n = path.corr.length, P = [edgePoint(A, path.sa, slotA)];
  const at = (q, a) => (axes[q] === 'v' ? [t[q], a] : [a, t[q]]);                      // a point on corridor q's track, `a` along it
  P.push(at(0, slotA));
  for (let q = 1; q < n; q++) P.push(axes[q] === 'h' ? [t[q - 1], t[q]] : [t[q], t[q - 1]]);
  P.push(at(n - 1, slotB));
  P.push(edgePoint(B, path.sb, slotB));
  const out = [];
  for (const p of P) { const l = out.length; if (l && Math.abs(out[l - 1][0] - p[0]) < 1e-6 && Math.abs(out[l - 1][1] - p[1]) < 1e-6) continue; out.push([p[0], p[1]]); }
  for (let i = out.length - 2; i > 0; i--) {                                              // drop a middle point on a straight run
    const a = out[i - 1], b = out[i], c = out[i + 1];
    if ((Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(b[0] - c[0]) < 1e-6) || (Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(b[1] - c[1]) < 1e-6)) out.splice(i, 1);
  }
  return out;
}
export { SIDES };
