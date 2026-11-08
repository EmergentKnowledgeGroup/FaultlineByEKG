// One number for "how good is this geometry" (lower is better). Order of importance follows DESIGN_BARS: hard metrics first (they must reach 0),
// then crossings, then readable shape (aspect, fit), then length and bends. Weights are chosen so one crossing outweighs a lot of bends.
export const ASPECT = { lo: 1.4, hi: 2.1, barLo: 1.3, barHi: 2.2 };            // lo and hi: inside the 1.3..2.2 bar with a margin, so one more label row cannot push a chart out of it
// A chart has to fit the page's own canvas at the size where every name and road condition reads (11 px, about 0.85 of map size): about 1.8k x 0.96k map units at 1920 x 1080.
// One that does not opens cut at its right and bottom edge. Under this fit scale (measured in the 1600 x 900 window of metrics.fitScale) a placement pays steeply; the poster has its own bar.
export const FIT = { min: 0.92, weight: 6000 };
export const W_HARD = { nodeOverlaps: 500, edgeThroughNode: 400, diagonalSegs: 400, labelMissing: 90, labelOverlapsNode: 90, labelOverlapsLabel: 90, shortArrowStubs: 50, trackOverlaps: 30 };

export function score(m) {
  let s = 0;
  for (const k in W_HARD) s += (m[k] || 0) * W_HARD[k];
  s += m.crossings * 100 + (m.labelOverlapsEdge || 0) * 4 + m.bends * 3.5 + m.longestEdge / 9 + m.totalLen / 120;
  if (m.aspect < ASPECT.lo) s += (ASPECT.lo - m.aspect) * 160; else if (m.aspect > ASPECT.hi) s += (m.aspect - ASPECT.hi) * 160;
  if (m.aspect < ASPECT.barLo) s += (ASPECT.barLo - m.aspect) * 900; else if (m.aspect > ASPECT.barHi) s += (m.aspect - ASPECT.barHi) * 900;      // outside the bar: steep
  if (m.fitScale < FIT.min && FIT.weight) s += (FIT.min - m.fitScale) * FIT.weight;
  if (m.fitScale < 0.95) s += (0.95 - m.fitScale) * 320;                        // below 0.95 the chart is penalised: compact is part of the look
  return s;
}

// pairs of edge ids that cross, plus per-edge bend counts: the search uses them to decide which nodes to move first
export function culprits(geom) {
  const segs = e => { const r = []; for (let i = 0; i < e.pts.length - 1; i++) r.push([e.pts[i], e.pts[i + 1]]); return r; };
  const isH = ([a, b]) => Math.abs(a[1] - b[1]) < 0.5, isV = ([a, b]) => Math.abs(a[0] - b[0]) < 0.5;
  const S = geom.edges.map(e => segs(e)), cross = [];
  for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
    let hit = false;
    for (const a of S[i]) { for (const b of S[j]) {
      if (!((isH(a) && isV(b)) || (isV(a) && isH(b)))) continue;
      const h = isH(a) ? a : b, v = isH(a) ? b : a;
      const hx0 = Math.min(h[0][0], h[1][0]), hx1 = Math.max(h[0][0], h[1][0]), vy0 = Math.min(v[0][1], v[1][1]), vy1 = Math.max(v[0][1], v[1][1]);
      if (v[0][0] > hx0 + 0.5 && v[0][0] < hx1 - 0.5 && h[0][1] > vy0 + 0.5 && h[0][1] < vy1 - 0.5) { hit = true; break; }
    } if (hit) break; }
    if (hit) cross.push([i, j]);
  }
  const len = geom.edges.map(e => { let l = 0; for (let i = 0; i < e.pts.length - 1; i++) l += Math.abs(e.pts[i + 1][0] - e.pts[i][0]) + Math.abs(e.pts[i + 1][1] - e.pts[i][1]); return l; });
  return { cross, len, bends: geom.edges.map(e => Math.max(0, e.pts.length - 2)) };
}
