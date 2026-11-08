// The frame of the tiled whole map: real pixel positions of every halo, part cell, street and gutter, from a plan (blocks + snake rows) and a
// width table `size` (corridor id -> width or height; anything missing takes its nominal). Rebuilt each time a street or gutter changes size.
//   buildFrame(plan, size, Wt?) -> frame { W, H, rows, blocks, hs, vs, vsl, vsr, nat, size }       Wt: justify every row to this width (extra goes to streets and gutters)
//   nominal(id) -> default size of a corridor id
// Row r (r = 0..R-1) holds blocks in left-to-right x order; odd rows run right to left, so the order there is the story order reversed.
// The left and right margins ('VSL', 'VSR') are one strip each for the whole canvas; the horizontal ones are 'HS0' and 'HSend'.
import { K } from './tiles.mjs';

export const MIN = { street: 40, margin: 32, gutter: 34 };
export function nominal(id) {
  if (id === 'VSL' || id === 'VSR') return K.M0;
  if (id.startsWith('HS')) return id === 'HS0' || id === 'HSend' ? K.M0 : K.SH0;
  if (id.startsWith('VS')) return K.SV0;
  if (id.startsWith('HT') || id.startsWith('RT')) return K.HT0;
  if (id.startsWith('HB')) return K.HB0;
  return K.GUT0;                       // HG, VG
}
const sz = (size, id) => size[id] ?? nominal(id);

export function buildFrame(plan, size = {}, Wt = null) {
  const { blocks, rows } = plan, R = rows.length;
  const xorder = rows.map((r, ri) => (ri % 2 === 0 ? r : r.slice().reverse()));
  const hsId = r => (r === R ? 'HSend' : `HS${r}`);
  const vsId = (r, k) => `VS${r}.${k}`;                                           // interior streets: k = 1 .. K-1
  const blockW = bi => { const b = blocks[bi]; let w = 2 * K.PADH; b.cw.forEach(c => { w += c; }); for (let c = 1; c < b.C; c++) w += sz(size, `VG${bi}.${c}`); return w; };
  const mL = sz(size, 'VSL'), mR = sz(size, 'VSR');
  const rowNat = r => { let w = mL + mR; for (let k = 1; k < xorder[r].length; k++) w += sz(size, vsId(r, k)); for (const bi of xorder[r]) w += blockW(bi); return w; };
  const nat = rows.map((_, r) => rowNat(r));
  const W = Wt ?? Math.max(...nat);
  const extra = rows.map((_, r) => Math.max(0, W - nat[r]));
  // a row's extra width goes to its interior streets (weight 1) and the gutters inside its blocks (0.7); a row with neither widens its blocks' side padding
  const wsum = rows.map((_, r) => (xorder[r].length - 1) + xorder[r].reduce((a, bi) => a + 0.7 * (blocks[bi].C - 1), 0));
  const share = (r, wt) => (wsum[r] > 0 ? extra[r] * wt / wsum[r] : 0);
  const padX = r => (wsum[r] > 0 ? 0 : extra[r] / (2 * xorder[r].length));
  const out = { W, rows: [], blocks: [], hs: [], vs: [], nat, size: {} };
  const put = (id, v) => { out.size[id] = v; return v; };
  // ---- heights: a column is its parts plus the gutters between them; a block is its tallest column; a row is its tallest block.
  const gapId = (bi, c, i) => `HG${bi}.${c}.${i}`;
  const colNat = (bi, c) => { const col = blocks[bi].cols[c]; let v = col.hs.reduce((a, b) => a + b, 0); for (let i = 1; i < col.tiles.length; i++) v += sz(size, gapId(bi, c, i)); return v; };
  const content = bi => Math.max(...blocks[bi].cols.map((_, c) => colNat(bi, c)));
  const bandH = (bi, r) => K.TITLE + sz(size, `RT${r}`) + content(bi) + sz(size, `HB${bi}`);      // RT: the gutter above the first parts, one for the whole row
  let y = 0;
  const hs0 = put(hsId(0), sz(size, hsId(0))); out.hs.push({ id: hsId(0), y0: 0, y1: hs0 }); y = hs0;
  const rowTop = [], rowH = [];
  for (let r = 0; r < R; r++) {
    rowTop[r] = y; rowH[r] = Math.max(...xorder[r].map(bi => bandH(bi, r))); y += rowH[r];
    const h = put(hsId(r + 1), sz(size, hsId(r + 1))); out.hs.push({ id: hsId(r + 1), y0: y, y1: y + h }); y += h;
  }
  out.H = y;
  put('VSL', mL); put('VSR', mR);
  out.vsl = { id: 'VSL', x0: 0, x1: mL, y0: 0, y1: out.H, kind: 'margin' };
  out.vsr = { id: 'VSR', x0: W - mR, x1: W, y0: 0, y1: out.H, kind: 'margin' };
  // ---- x layout of every row
  for (let r = 0; r < R; r++) {
    let x = mL; const vrow = [out.vsl], px = padX(r);
    xorder[r].forEach((bi, k) => {
      const b = blocks[bi], B = { bi, row: r, k, x0: x, y0: rowTop[r], y1: rowTop[r] + rowH[r], cells: [], vg: [], hg: [] };
      let cx = x + K.PADH + px; const colX = [];
      for (let c = 0; c < b.C; c++) {
        colX.push(cx); cx += b.cw[c];
        if (c < b.C - 1) { const id = `VG${bi}.${c + 1}`, w = put(id, sz(size, id) + share(r, 0.7)); B.vg.push({ id, x0: cx, x1: cx + w }); cx += w; }
      }
      B.x1 = cx + K.PADH + px; x = B.x1;
      // a block whose row is more than 15% taller than it is keeps its own height (the street takes the rest); otherwise it fills the row
      const nat = bandH(bi, r), haloH = (rowH[r] - nat) / rowH[r] > 0.15 ? nat : rowH[r];
      B.y1 = rowTop[r] + haloH;
      const ht = put(`RT${r}`, sz(size, `RT${r}`)), hb = put(`HB${bi}`, sz(size, `HB${bi}`));
      B.ht = { id: `RT${r}`, y0: rowTop[r] + K.TITLE, y1: rowTop[r] + K.TITLE + ht };
      const target = haloH - K.TITLE - ht - hb;                                      // every column is made this tall: the spare height goes into its gutters
      B.hgc = [];
      b.cols.forEach((col, c) => {
        let cy = B.ht.y1; const slack = target - colNat(bi, c), ng = col.tiles.length - 1, gaps = [];
        const extra = ng > 0 ? Math.min(slack, ng * 80) : slack, rest = slack - extra;                 // gutters widen by at most 80 px each; what is left is room under the last part
        col.tiles.forEach((tile, i) => {
          const y0 = cy, y1 = y0 + col.hs[i] + (i === ng ? rest : 0);                    // the spare height a column cannot spread is room under its last part
          B.cells.push({ tile, c, i, x0: colX[c], y0, x1: colX[c] + b.cw[c], y1 });
          cy = y1;
          if (i < ng) { const id = gapId(bi, c, i + 1), g = put(id, sz(size, id) + extra / ng); gaps.push({ id, y0: cy, y1: cy + g }); cy += g; }
        });
        B.hgc.push(gaps);
      });
      B.hb = { id: `HB${bi}`, y0: B.ht.y1 + target, y1: B.ht.y1 + target + hb };
      out.blocks[bi] = B;
      if (k < xorder[r].length - 1) { const id = vsId(r, k + 1), w = put(id, sz(size, id) + share(r, 1)); vrow.push({ id, x0: x, x1: x + w, y0: out.hs[r].y0, y1: out.hs[r + 1].y1, kind: 'street' }); x += w; }
    });
    vrow.push(out.vsr);
    if (Math.abs(x + mR - W) > 1e-6) throw new Error(`frame: row ${r} is ${x + mR} wide, expected ${W}`);
    out.rows.push({ y0: rowTop[r], y1: rowTop[r] + rowH[r], blocks: xorder[r].slice() });
    out.vs.push(vrow);
  }
  return out;
}
