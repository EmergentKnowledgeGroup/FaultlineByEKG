// Block arrangement for the whole-system map: stage blocks in a clean snake (stage 1, 2, 3 left to right, wrap, next row right to left, so the
// last block of a row sits above the first of the next). The stage order is the strong prior; the snake is broken only where a swap saves a lot
// (cost below) and the result says what it gave up. A pixel model (real box sizes when given) judges every row-length pattern by link length,
// dead space (what the halos do not cover) and aspect, and picks per-block mirrors.
//   arrangeBlocks(blocks, links, { nsz, gapX, gapY, streetCols, streetRows, stretch, aspect, swapPen, keep })
//     -> { cell:{id:[gc,gr]}, fh, fv, GC, GR, cost, W, H, asp, snake:{rows, displaced, flips, linkLen, dead}, alternatives:[same shape] }
//   blocks: [{id, w, h, nodes:[{id,c,r}], order}]   links: [{a:nodeId, b:nodeId, w}]   nsz: {nodeId:[w,h]} box sizes in px (default 190 x 66)
import { slotMap } from './compose.mjs';

// row-length patterns whose rows wrap boustrophedon style, each row starting under the end of the one before, never left of column 0
export function snakeShapes(S) {
  const seen = new Set(), out = [];
  const add = lens => {
    if (lens.some(l => l < 1) || lens.reduce((a, b) => a + b, 0) !== S) return;
    const key = lens.join(','); if (seen.has(key)) return; seen.add(key);
    const cells = []; let col = 0, minC = 0, maxC = 0;
    for (let r = 0; r < lens.length; r++) {
      const dir = r % 2 === 0 ? 1 : -1;
      for (let k = 0; k < lens[r]; k++) { cells.push([col + dir * k, r]); minC = Math.min(minC, col + dir * k); maxC = Math.max(maxC, col + dir * k); }
      col += dir * (lens[r] - 1);
    }
    if (minC < 0) return;                                        // the story starts top-left: a row may not run past column 0
    out.push({ lens, cells, GC: maxC + 1, GR: lens.length });
  };
  for (let R = 1; R <= S; R++) {
    const c = Math.ceil(S / R), lo = Math.floor(S / R), ex = S - lo * R;
    add([...Array(R - 1).fill(c), S - (R - 1) * c]);                                   // full rows, short last row
    if (lo >= 1) { add([...Array(ex).fill(lo + 1), ...Array(R - ex).fill(lo)]); add([...Array(R - ex).fill(lo), ...Array(ex).fill(lo + 1)]); }
  }
  return out;
}

export function arrangeBlocks(blocks, links, opts = {}) {
  const { nsz = {}, gapX = 150, gapY = 84, streetCols = 220, streetRows = 170, stretch = 1.3, aspect = [1.45, 2.05], swapPen = 0.7, keep = 3, flipPen = [0.05, 0.1], dw = 190, dh = 66, haloPad = 40, xw = 1 } = opts;
  const S = blocks.length;
  if (S === 0) return { cell: {}, fh: {}, fv: {}, GC: 0, GR: 0, cost: 0, W: 0, H: 0, alternatives: [] };
  const rank = blocks.map((b, i) => i).sort((p, q) => (blocks[p].order ?? p) - (blocks[q].order ?? q));       // rank[k] = block index of the k-th stage
  const kOf = new Int32Array(S); rank.forEach((b, k) => { kOf[b] = k; });
  // flat node tables
  const off = new Int32Array(S + 1), where = new Map(); let N = 0;
  blocks.forEach((b, bi) => { off[bi] = N; b.nodes.forEach(n => { where.set(n.id, N++); }); }); off[S] = N;
  const nb = new Int32Array(N), nc = new Int32Array(N), nr = new Int32Array(N), nw = new Float64Array(N), nh = new Float64Array(N);
  blocks.forEach((b, bi) => b.nodes.forEach((n, i) => { const f = off[bi] + i, sz = nsz[n.id] || [dw, dh]; nb[f] = bi; nc[f] = n.c; nr[f] = n.r; nw[f] = sz[0]; nh[f] = sz[1]; }));
  const L = links.filter(l => where.has(l.a) && where.has(l.b) && nb[where.get(l.a)] !== nb[where.get(l.b)]).map(l => ({ a: where.get(l.a), b: where.get(l.b), w: l.w ?? 1 }));
  const L0 = L.reduce((s, l) => s + l.w, 0) * 1500 + 1;
  const bw = blocks.map(b => b.w), bh = blocks.map(b => b.h);
  let areaN = 0; for (let f = 0; f < N; f++) areaN += nw[f] * nh[f];
  const gcol = new Int32Array(N), grow = new Int32Array(N), cx = new Float64Array(N), cy = new Float64Array(N);

  function evaluate(st, sh, detail = false) {
    const { gc, gr, fh, fv } = st, GC = sh.GC, GR = sh.GR, ex = sh.ex || 1, ey = sh.ey || 1, capX = Math.max(stretch, ex * 1.1), capY = Math.max(stretch, ey * 1.1);
    const slotW = new Int32Array(GC), slotH = new Int32Array(GR);
    for (let b = 0; b < S; b++) { if (bw[b] > slotW[gc[b]]) slotW[gc[b]] = bw[b]; if (bh[b] > slotH[gr[b]]) slotH[gr[b]] = bh[b]; }
    for (let j = 0; j < GC; j++) slotW[j] = Math.ceil(slotW[j] * ex - 1e-9); for (let r = 0; r < GR; r++) slotH[r] = Math.ceil(slotH[r] * ey - 1e-9);
    const colOff = new Int32Array(GC + 1), rowOff = new Int32Array(GR + 1);
    for (let j = 0; j < GC; j++) colOff[j + 1] = colOff[j] + slotW[j];
    for (let r = 0; r < GR; r++) rowOff[r + 1] = rowOff[r] + slotH[r];
    const TC = colOff[GC], TR = rowOff[GR], colMax = new Float64Array(TC), rowMax = new Float64Array(TR);
    const cms = [], rms = [];
    for (let b = 0; b < S; b++) { cms.push(slotMap(bw[b], slotW[gc[b]], capX)); rms.push(slotMap(bh[b], slotH[gr[b]], capY, true)); }
    for (let f = 0; f < N; f++) {
      const b = nb[f], c = fh[b] ? bw[b] - 1 - nc[f] : nc[f], r = fv[b] ? bh[b] - 1 - nr[f] : nr[f];
      const g = colOff[gc[b]] + cms[b][c], h = rowOff[gr[b]] + rms[b][r];
      gcol[f] = g; grow[f] = h; if (nw[f] > colMax[g]) colMax[g] = nw[f]; if (nh[f] > rowMax[h]) rowMax[h] = nh[f];
    }
    const colX = new Float64Array(TC), rowY = new Float64Array(TR), endC = new Uint8Array(TC), endR = new Uint8Array(TR);
    for (let j = 0; j < GC - 1; j++) endC[colOff[j + 1] - 1] = 1;
    for (let r = 0; r < GR - 1; r++) endR[rowOff[r + 1] - 1] = 1;
    let x = 0, y = 0;
    for (let g = 0; g < TC; g++) { colX[g] = x; x += colMax[g] + gapX + (endC[g] ? streetCols : 0); }
    for (let h = 0; h < TR; h++) { rowY[h] = y; y += rowMax[h] + gapY + (endR[h] ? streetRows : 0); }
    const W = x - gapX, H = y - gapY;
    for (let f = 0; f < N; f++) { cx[f] = colX[gcol[f]] + colMax[gcol[f]] / 2; cy[f] = rowY[grow[f]] + rowMax[grow[f]] / 2; }
    let len = 0; for (const l of L) len += l.w * (Math.abs(cx[l.a] - cx[l.b]) + Math.abs(cy[l.a] - cy[l.b]));
    const x0 = new Float64Array(S).fill(1e18), x1 = new Float64Array(S).fill(-1e18), y0 = new Float64Array(S).fill(1e18), y1 = new Float64Array(S).fill(-1e18);
    for (let f = 0; f < N; f++) { const b = nb[f]; x0[b] = Math.min(x0[b], cx[f] - nw[f] / 2); x1[b] = Math.max(x1[b], cx[f] + nw[f] / 2); y0[b] = Math.min(y0[b], cy[f] - nh[f] / 2); y1[b] = Math.max(y1[b], cy[f] + nh[f] / 2); }
    let area = 0; for (let b = 0; b < S; b++) area += (x1[b] - x0[b] + 2 * haloPad) * (y1[b] - y0[b] + 2 * haloPad);
    const dead = Math.max(0, 1 - area / (W * H)), asp = W / H, ap = Math.max(0, aspect[0] - asp, asp - aspect[1]);
    let snakeP = 0, flips = 0, displaced = 0;
    for (let b = 0; b < S; b++) {
      const k = kOf[b], [ic, ir] = sh.cells[k], d = Math.abs(gc[b] - ic) + Math.abs(gr[b] - ir);
      if (d) { snakeP += swapPen * d; displaced++; }
      const pf = gr[b] % 2 === 1 ? 1 : 0; if (fh[b] !== pf) { snakeP += flipPen[0]; flips++; } if (fv[b]) { snakeP += flipPen[1]; flips++; }
    }
    const sparse = W * H / Math.max(1, areaN);               // canvas area per unit of box area: spreading blocks to fix the aspect is not free
    let cross = 0;                                            // crossings of the cross-stage links drawn as L paths (horizontal at the tail, vertical at the head): the macro-level crossing count
    if (xw > 0 && L.length <= 250) for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const p = L[i], q = L[j], pa = cx[p.a], pb = cx[p.b], py = cy[p.a], pby = cy[p.b], qa = cx[q.a], qb = cx[q.b], qy = cy[q.a], qby = cy[q.b];
      const h1 = (pa < pb ? pa : pb) + 1, h2 = (pa < pb ? pb : pa) - 1, g1 = (qa < qb ? qa : qb) + 1, g2 = (qa < qb ? qb : qa) - 1;
      if (qb > h1 && qb < h2 && py > Math.min(qy, qby) + 1 && py < Math.max(qy, qby) - 1) cross++;
      if (pb > g1 && pb < g2 && qy > Math.min(py, pby) + 1 && qy < Math.max(py, pby) - 1) cross++;
    }
    const cost = len / L0 + 2.0 * dead + 2.2 * ap + 0.04 * sparse + snakeP + xw * cross / Math.max(8, L.length);
    return detail ? { cost, W, H, asp, len, dead, snakeP, flips, displaced, sparse, cross } : cost;
  }

  function mirrorDescent(st, sh, cur) {
    for (let pass = 0; pass < 4; pass++) {
      let improved = false;
      for (let b = 0; b < S; b++) {
        const h0 = st.fh[b], v0 = st.fv[b]; let bestH = h0, bestV = v0, bc = cur;
        for (const [h, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { if (h === h0 && v === v0) continue; st.fh[b] = h; st.fv[b] = v; const c = evaluate(st, sh); if (c < bc - 1e-9) { bc = c; bestH = h; bestV = v; } }
        st.fh[b] = bestH; st.fv[b] = bestV; if (bc < cur - 1e-9) { cur = bc; improved = true; }
      }
      if (!improved) break;
    }
    return cur;
  }
  function snakeSt(sh) {
    const st = { gc: new Int32Array(S), gr: new Int32Array(S), fh: new Uint8Array(S), fv: new Uint8Array(S) };
    for (let k = 0; k < S; k++) { const b = rank[k]; st.gc[b] = sh.cells[k][0]; st.gr[b] = sh.cells[k][1]; st.fh[b] = st.gr[b] % 2; }
    return st;
  }
  function solve(sh) {
    const st = snakeSt(sh);
    let cur = mirrorDescent(st, sh, evaluate(st, sh));
    for (let round = 0; round < 3; round++) {            // break the snake only where a swap (with the mirrors re-chosen) saves more than its price
      let improved = false;
      for (let i = 0; i < S; i++) for (let j = i + 1; j < S; j++) {
        const bi = rank[i], bj = rank[j];
        if (st.gc[bi] === st.gc[bj] && st.gr[bi] === st.gr[bj]) continue;
        const sv = { gc: Int32Array.from(st.gc), gr: Int32Array.from(st.gr), fh: Uint8Array.from(st.fh), fv: Uint8Array.from(st.fv) };
        [st.gc[bi], st.gc[bj]] = [st.gc[bj], st.gc[bi]]; [st.gr[bi], st.gr[bj]] = [st.gr[bj], st.gr[bi]];
        const c = mirrorDescent(st, sh, evaluate(st, sh));
        if (c < cur - 1e-9) { cur = c; improved = true; } else { st.gc.set(sv.gc); st.gr.set(sv.gr); st.fh.set(sv.fh); st.fv.set(sv.fv); }
      }
      if (!improved) break;
    }
    return { st, sh, d: evaluate(st, sh, true) };
  }
  const SPREAD = [[1, 1], [1.25, 1], [1.5, 1], [1.75, 1], [2, 1], [1, 1.25], [1, 1.5], [1, 1.75], [1, 2]];     // uniform spread of every block (extra empty rows / columns): the lever that brings the aspect into the bar
  const variants = []; for (const sh of snakeShapes(S)) for (const [ex, ey] of SPREAD) variants.push({ ...sh, ex, ey });
  const shapes = variants.map(sh => ({ sh, d: evaluate(snakeSt(sh), sh, true) })).sort((p, q) => p.d.cost - q.d.cost);
  const res = shapes.slice(0, Math.max(keep + 3, 6)).map(({ sh }) => solve(sh)).sort((p, q) => p.d.cost - q.d.cost);
  const fmt = ({ st, sh, d }) => {
    const cell = {}, fh = {}, fv = {};
    blocks.forEach((b, i) => { cell[b.id] = [st.gc[i], st.gr[i]]; fh[b.id] = !!st.fh[i]; fv[b.id] = !!st.fv[i]; });
    return { cell, fh, fv, GC: sh.GC, GR: sh.GR, cost: d.cost, W: d.W, H: d.H, asp: d.asp, spread: [sh.ex || 1, sh.ey || 1], snake: { rows: sh.lens.join('+'), displaced: d.displaced, flips: d.flips, linkLen: Math.round(d.len), dead: +d.dead.toFixed(3), sparse: +d.sparse.toFixed(1), macroCrossings: d.cross } };
  };
  const out = fmt(res[0]);
  out.alternatives = res.slice(1, keep).map(fmt);
  return out;
}
