// Measures of a tiled whole map that are not engine metrics: how much of the canvas is vacant inside the halos, and which roads run through
// a part that holds neither of their ends.
//   foreignTiles(edges, tileRects, tileOf) -> n      cross edges with a run inside a part rectangle other than their two end parts
//   vacancy(frame, tiles, corridors, used) -> { halo, tiles, vacant, canvas }   fractions of the canvas
//        halo = the halos' area; tiles = the parts' own area; vacant = halo area that is neither a part, the title band or side padding, nor a
//        gutter that carries a road. Measured on a 16 px grid.
import { K } from './tiles.mjs';

export function foreignTiles(edges, tileRects, tileOf) {
  let n = 0;
  for (const e of edges) {
    if (!e.cross) continue;
    const ta = tileOf.get(e.from), tb = tileOf.get(e.to); let hit = false;
    for (let k = 0; k < e.pts.length - 1 && !hit; k++) {
      const a = e.pts[k], b = e.pts[k + 1], x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
      for (let t = 0; t < tileRects.length; t++) {
        if (t === ta || t === tb) continue;
        const r = tileRects[t];
        if (x0 < r.x + r.w - 1 && x1 > r.x + 1 && y0 < r.y + r.h - 1 && y1 > r.y + 1) { hit = true; break; }
      }
    }
    if (hit) n++;
  }
  return n;
}

export function vacancy(frame, tiles, list, used) {
  const G = 16, gw = Math.ceil(frame.W / G) + 1, gh = Math.ceil(frame.H / G) + 1, halo = new Uint8Array(gw * gh), mark = new Uint8Array(gw * gh);
  const fill = (arr, x0, y0, x1, y1, v) => { for (let y = Math.max(0, Math.floor(y0 / G)); y < Math.min(gh, Math.ceil(y1 / G)); y++) for (let x = Math.max(0, Math.floor(x0 / G)); x < Math.min(gw, Math.ceil(x1 / G)); x++) arr[y * gw + x] = v; };
  for (const B of frame.blocks) {
    fill(halo, B.x0, B.y0, B.x1, B.y1, 1);
    fill(mark, B.x0, B.y0, B.x1, B.y0 + K.TITLE, 1);                                        // the title band
    fill(mark, B.x0, B.y0, B.x0 + K.PADH, B.y1, 1); fill(mark, B.x1 - K.PADH, B.y0, B.x1, B.y1, 1);
    for (const c of B.cells) { const t = tiles[c.tile]; fill(mark, c.x0, c.y0, c.x0 + t.w, c.y0 + t.h, 1); }
    for (const c of list) {                                                                  // gutters that carry roads, clipped to this halo
      if (!c.rs || !used.has(c.i)) continue;
      const bx0 = c.axis === 'v' ? c.b0 : Math.max(c.e0, B.x0), bx1 = c.axis === 'v' ? c.b1 : Math.min(c.e1, B.x1), by0 = c.axis === 'v' ? Math.max(c.e0, B.y0) : c.b0, by1 = c.axis === 'v' ? Math.min(c.e1, B.y1) : c.b1;
      if (bx1 > B.x0 && bx0 < B.x1 && by1 > B.y0 && by0 < B.y1) fill(mark, Math.max(bx0, B.x0), Math.max(by0, B.y0), Math.min(bx1, B.x1), Math.min(by1, B.y1), 1);
    }
  }
  let nh = 0, nv = 0, nm = 0; for (let i = 0; i < halo.length; i++) if (halo[i]) { nh++; if (!mark[i]) nv++; }
  let tileArea = 0; for (const B of frame.blocks) for (const c of B.cells) tileArea += tiles[c.tile].w * tiles[c.tile].h;
  const canvas = frame.W * frame.H, cellA = G * G;
  return { halo: +(nh * cellA / canvas).toFixed(3), tiles: +(tileArea / canvas).toFixed(3), vacant: +(nv * cellA / canvas).toFixed(3), canvas };
}
