// Readability terms that metrics alone never see (DESIGN_BARS "Map"): the happy path as a snake, sinks on the border, related boxes together,
// returns on the outside margins. Added to the metric score during the search. Cell terms work on grid positions, the margin term on geometry.
//   cellTerms(A, g, pos, W, pull) -> number        spine / sinks / pair distance on a W-wide cell grid (empty rows and columns do not matter: only differences)
//   marginTerm(A, g, geom) -> number         length of return routes that run through the central box of the map
export const W_SNAKE = 8, W_SINK = 7, W_PAIR = 2.2, W_MARGIN = 0.07, W_PULL = 3;

export function cellTerms(A, g, pos, W, pull = null) {
  const n = A.n;
  const cr = i => [pos[i] % W, (pos[i] / W) | 0];
  let t = 0;
  // bounding box of used cells (sinks must sit on its border)
  let c0 = 1e9, c1 = -1e9, r0 = 1e9, r1 = -1e9;
  for (let i = 0; i < n; i++) { const [c, r] = cr(i); if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r; }
  // snake: rows are walked in order of first visit, row 0 left to right, row 1 right to left, and so on
  const rowsSeen = [];
  const sp = A.spine.map(id => A.idx.get(id));
  for (const i of sp) { const r = cr(i)[1]; if (!rowsSeen.includes(r)) rowsSeen.push(r); }
  for (let k = 0; k + 1 < sp.length; k++) {
    const [ca, ra] = cr(sp[k]), [cb, rb] = cr(sp[k + 1]), dc = cb - ca, dr = rb - ra;
    if (dr === 0) {
      const want = rowsSeen.indexOf(ra) % 2 === 0 ? 1 : -1;
      if (Math.abs(dc) === 1) { if (dc !== want) t += W_SNAKE * 0.7; }
      else t += W_SNAKE * (0.5 + 0.35 * (Math.abs(dc) - 1)) + (Math.sign(dc) !== want ? W_SNAKE * 0.5 : 0);
    } else if (dr > 0) {                                           // a wrap: same column (or nearly) is the clean turn
      t += W_SNAKE * (0.2 * Math.abs(dc) + 0.3 * (dr - 1));
    } else t += W_SNAKE * (2.4 + 0.8 * -dr + 0.2 * Math.abs(dc));   // climbing back up breaks the left-to-right, top-to-bottom reading
  }
  { const [c, r] = cr(sp[0]); t += W_SNAKE * 0.9 * ((c - c0) + 1.2 * (r - r0)); }   // the path starts top-left
  for (let i = 0; i < n; i++) {
    const role = A.roles[A.ids[i]];
    if (role.end && !role.source && !role.decision) {
      const [c, r] = cr(i), edge = Math.min(c - c0, c1 - c, (r - r0) * 1.6, (r1 - r) * 1.6);
      t += W_SINK * Math.min(edge, 2) * (edge > 0 ? 1 : 0);
    }
  }
  if (pull) for (let i = 0; i < n; i++) {                        // whole-system bands: a box with roads to another stage sits on the border facing it
    const pl = pull[i]; if (!pl) continue; const [c, r] = cr(i);
    for (const { side, w } of pl) { const d = side === 'E' ? c1 - c : side === 'W' ? c - c0 : side === 'S' ? (r1 - r) * 1.6 : (r - r0) * 1.6; t += W_PULL * w * Math.min(d, 3); }
  }
  t += 0.45 * Math.max(0, (c1 - c0 + 1) * (r1 - r0 + 1) - n * 1.5);                // empty cells beyond 1.5x the boxes: a sprawling grid reads worse than a dense one
  for (const p of A.pairs.values()) {
    const [ca, ra] = cr(p.a), [cb, rb] = cr(p.b);
    const d = Math.abs(ca - cb) + 1.4 * Math.abs(ra - rb);
    if (d > 1.5) t += W_PAIR * p.w * (d - 1.5);
  }
  return t;
}

export function marginTerm(A, g, geom) {
  if (!A.back.size) return 0;
  const nodes = geom.nodes; if (!nodes.length) return 0;
  const cols = nodes.map(n => n.col), rows = nodes.map(n => n.row);
  const minC = Math.min(...cols), maxC = Math.max(...cols), minR = Math.min(...rows), maxR = Math.max(...rows);
  // central box: strictly between the outer rows and columns of nodes
  const xl = Math.max(...nodes.filter(n => n.col === minC).map(n => n.x + n.w)), xr = Math.min(...nodes.filter(n => n.col === maxC).map(n => n.x));
  const yt = Math.max(...nodes.filter(n => n.row === minR).map(n => n.y + n.h)), yb = Math.min(...nodes.filter(n => n.row === maxR).map(n => n.y));
  if (!(xr > xl) || !(yb > yt) || maxC - minC < 2 || maxR - minR < 2) return 0;
  const byId = new Map(geom.edges.map(e => [e.id, e]));
  let t = 0;
  for (const k of A.back) {
    const e = byId.get(g.edges[k].id); if (!e) continue;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [x0, y0] = e.pts[i], [x1, y1] = e.pts[i + 1];
      const sx0 = Math.max(Math.min(x0, x1), xl), sx1 = Math.min(Math.max(x0, x1), xr), sy0 = Math.max(Math.min(y0, y1), yt), sy1 = Math.min(Math.max(y0, y1), yb);
      if (sx1 > sx0 && Math.abs(y0 - y1) < 0.5 && y0 > yt && y0 < yb) t += sx1 - sx0;
      else if (sy1 > sy0 && Math.abs(x0 - x1) < 0.5 && x0 > xl && x0 < xr) t += sy1 - sy0;
    }
  }
  return t * W_MARGIN;
}
