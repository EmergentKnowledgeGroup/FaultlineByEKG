// Tiles, stage blocks and the snake, for the tiled whole map (see docs/SCALE.md "Whole map").
//   loadTiles(model, charts, geoms) -> { stages:[{id,title,tiles:[tile]}], tiles:[tile], missing:[chartId] }
//        tile = { idx, chartId, stage, part, w, h, geom }  (w, h = the saved geometry's size, rounded up)
//   planBlock(tiles) -> block     the part grid of one stage: columns share a width, rows share a height, the column count that
//                                 brings the block nearest 1.6:1 with the least waste
//   snakeRows(blocks, links, opts) -> { rows:[[blockIdx...]] (story order inside a row), W, H, cost, ... }
// Pure and deterministic: nothing reads a clock or Math.random.
import { orderedStages } from '../build/util.mjs';

export const K = {
  PADH: 20,        // halo side padding between the halo edge and the part grid
  TITLE: 46,       // title band at the top of every halo
  GUT0: 48,        // nominal gutter between parts
  HT0: 34, HB0: 34,// nominal band above the first and below the last part row
  SV0: 64, SH0: 64, M0: 48,   // nominal street widths and the outer margin
  ASPECT: [1.3, 2.2], PITCH: 7, PITCH_MIN: 4,
};

export function loadTiles(model, charts, geoms) {
  const stages = [], tiles = [], missing = [];
  for (const s of orderedStages(model)) {
    const parts = charts.filter(c => c.kind === 'stage' && c.stage === s.id).sort((a, b) => (a.part || 1) - (b.part || 1));
    const mine = [];
    for (const c of parts) {
      const g = geoms[c.id];
      if (!g) { missing.push(c.id); continue; }
      const have = new Set(g.nodes.map(n => n.id)), lack = c.boxes.find(b => !have.has(b.id));
      if (lack) { missing.push(`${c.id} (its saved geometry is stale: no box ${lack.id})`); continue; }
      const t = { idx: tiles.length, chartId: c.id, stage: s.id, part: c.part || 1, w: Math.ceil(g.width), h: Math.ceil(g.height), geom: g };
      tiles.push(t); mine.push(t);
    }
    if (mine.length) stages.push({ id: s.id, title: s.title || s.id, tiles: mine });
  }
  return { stages, tiles, missing };
}

// The parts of one stage, packed masonry style: C columns, each part goes to the shortest column so far (leftmost on a tie), so reading order
// holds as far as the packing allows. A column is as wide as its widest part; columns have different heights. The column count is the one with the least vacant
// area (and a block shape near 1.6:1).
//   planBlock(stage) -> { id, title, tiles, C, cw, cols:[{tiles:[idx], hs:[h], w}], cells:[{tile, c, i}], w, h }
export function planBlock(stage, { aim = 1.6 } = {}) {
  const T = stage.tiles, n = T.length;
  let best = null;
  for (let C = 1; C <= n; C++) {
    const cols = Array.from({ length: C }, () => ({ tiles: [], hs: [], w: 0, h: 0 }));
    for (const t of T) {
      let c = 0; for (let j = 1; j < C; j++) if (cols[j].h < cols[c].h - 1e-9) c = j;
      const col = cols[c]; col.h += t.h + (col.tiles.length ? K.GUT0 : 0); col.tiles.push(t.idx); col.hs.push(t.h); col.w = Math.max(col.w, t.w);
    }
    const W = cols.reduce((a, c) => a + c.w, 0) + (C - 1) * K.GUT0 + 2 * K.PADH, H = K.TITLE + K.HT0 + Math.max(...cols.map(c => c.h)) + K.HB0;
    const area = T.reduce((a, t) => a + t.w * t.h, 0), waste = 1 - area / (W * H), asp = W / H;
    const cost = Math.abs(Math.log(asp / aim)) + 2.0 * waste + 0.002 * C;
    if (!best || cost < best.cost - 1e-9) best = { cost, C, cols, W, H };
  }
  const cells = []; best.cols.forEach((col, c) => col.tiles.forEach((tile, i) => cells.push({ tile, c, i })));
  return { id: stage.id, title: stage.title, tiles: T, C: best.C, cw: best.cols.map(c => c.w), cols: best.cols.map(c => ({ tiles: c.tiles, hs: c.hs, w: c.w })), cells, w: best.W, h: best.H, vacant: 1 - T.reduce((a, t) => a + t.w * t.h, 0) / (best.W * best.H) };
}

// Blocks go in rows in story order (left to right, then right to left). A small search over where the rows break: dead space, aspect outside
// the bar, link length. links: [{a, b, w}] block indexes and the routes between them. Every partition for every candidate row width is scored.
export function snakeRows(blocks, links = [], o = {}) {
  const S = blocks.length, lo = o.aspect?.[0] ?? K.ASPECT[0], hi = o.aspect?.[1] ?? K.ASPECT[1];
  const sv = o.sv ?? K.SV0, sh = o.sh ?? K.SH0, mg = o.mg ?? K.M0;
  const w = blocks.map(b => b.w), h = blocks.map(b => b.h), area = blocks.reduce((a, b) => a + b.w * b.h, 0);
  const pre = [0]; for (let i = 0; i < S; i++) pre.push(pre[i] + w[i]);
  const rowW = (a, b) => pre[b] - pre[a] + (b - a - 1) * sv + 2 * mg;       // blocks a..b-1 in one row
  const cands = new Set();
  for (let a = 0; a < S; a++) for (let b = a + 1; b <= S; b++) cands.add(Math.round(rowW(a, b)));
  const seen = new Set(), out = [];
  for (const Wt of [...cands].sort((p, q) => p - q)) {
    const f = Array(S + 1).fill(Infinity), from = Array(S + 1).fill(-1); f[0] = 0;
    for (let i = 1; i <= S; i++) for (let j = 0; j < i; j++) {
      const wr = rowW(j, i); if (wr > Wt && i - j > 1) continue;
      const c = f[j] + ((Wt - Math.max(wr, 0)) / Wt) ** 2 + 0.02;                 // squared slack per row, a small price per row
      if (c < f[i]) { f[i] = c; from[i] = j; }
    }
    if (!isFinite(f[S])) continue;
    const cuts = []; for (let i = S; i > 0; i = from[i]) cuts.unshift([from[i], i]);
    const key = cuts.map(c => c.join('-')).join(',');
    if (seen.has(key)) continue; seen.add(key);
    out.push(scoreRows(cuts));
  }
  function scoreRows(cuts) {
    const rows = cuts.map(([a, b]) => Array.from({ length: b - a }, (_, k) => a + k));
    const W = Math.max(...rows.map(r => rowW(r[0], r[r.length - 1] + 1)));
    const rh = rows.map(r => Math.max(...r.map(i => h[i]))), H = rh.reduce((a, b) => a + b, 0) + (rows.length + 1) * sh;
    const asp = W / H, dead = Math.max(0, 1 - area / (W * H));
    // block centres at natural spacing, for the link term (odd rows run right to left)
    const cx = [], cy = []; let y = sh;
    rows.forEach((r, ri) => {
      const wr = rowW(r[0], r[r.length - 1] + 1); let x = ri % 2 === 0 ? mg : W - wr + mg;
      const order = ri % 2 === 0 ? r : r.slice().reverse();                        // left to right placement order
      for (const i of order) { cx[i] = x + w[i] / 2; cy[i] = y + rh[ri] / 2; x += w[i] + sv; }
      y += rh[ri] + sh;
    });
    let ll = 0, lw = 0; for (const l of links) { ll += l.w * (Math.abs(cx[l.a] - cx[l.b]) + Math.abs(cy[l.a] - cy[l.b])); lw += l.w; }
    const link = lw ? ll / lw / (W + H) : 0, ap = Math.max(0, lo - asp, asp - hi);
    let mis = 0; rows.forEach((r, ri) => { for (const i of r) mis += w[i] * (rh[ri] - h[i]); });               // vacant canvas under blocks shorter than their row
    mis /= W * H;
    const cost = 3 * dead + 6 * ap + 0.5 * Math.abs(Math.log(asp / 1.7)) + 1.0 * link + 2.5 * mis;
    return { rows, W, H, asp, dead, link, cost, rh, mis };
  }
  out.sort((p, q) => p.cost - q.cost || p.rows.length - q.rows.length);
  // alternatives: the best partition of every other row count first (cheapest first), then the next cheapest overall
  const picked = [out[0]], rowsSeen = new Set([out[0].rows.length]);
  for (const c of out.slice(1)) if (!rowsSeen.has(c.rows.length)) { rowsSeen.add(c.rows.length); picked.push(c); }
  for (const c of out.slice(1)) if (!picked.includes(c)) picked.push(c);
  return { ...out[0], alternatives: picked.slice(1, 1 + (o.keep ?? 4)) };
}
