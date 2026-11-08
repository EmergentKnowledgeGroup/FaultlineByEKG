// Compose per-stage band configs into one whole-system gridLayout config. Stage blocks sit on a block grid (slots): every block column has a
// width in grid columns, every block row a height. A block narrower or lower than its slot is spread over it (its columns / rows are mapped
// onto the slot, up to a stretch cap, then centred), so the halo fills the slot and what is left over reads as a street, not a hole.
//   mirrorBand(band, hf, vf) -> band               left/right and top/bottom mirror of a band config (map, ports, colGap, rowGap)
//   stageTone(i, n) -> '#rrggbb'                   generated palette: golden-angle hues, fixed lightness and saturation, never named
//   slotMap(w, slot, cap) -> number[]              local column (or row) index -> index inside a slot of `slot` columns
//   composeWhole({ stages, bands, arrangement, streetCols, streetRows, haloPad, stretch }) -> { cfg, extents, macro, blockOf }
const SW_H = { E: 'W', W: 'E', N: 'N', S: 'S' }, SW_V = { N: 'S', S: 'N', E: 'E', W: 'W' };

export function stageTone(i, n) {
  const h = ((i * 137.508) + 205) % 360, s = 0.46, l = 0.62;
  const a = s * Math.min(l, 1 - l), f = k => { const kk = (k + h / 30) % 12; const c = l - a * Math.max(-1, Math.min(kk - 3, 9 - kk, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
}

export function mirrorBand(band, hf, vf) {
  const rows = band.map.map(r => r.trim().split(/\s+/));
  const bw = Math.max(...rows.map(r => r.length)), bh = rows.length;
  let map = rows.map(r => r.slice()); if (hf) map = map.map(r => r.slice().reverse()); if (vf) map = map.slice().reverse();
  const out = { ...band, map: map.map(r => r.join(' ')) };
  const sw = s => { let t = s; if (hf) t = SW_H[t]; if (vf) t = SW_V[t]; return t; };
  if (band.ports) { out.ports = {}; for (const [k, v] of Object.entries(band.ports)) out.ports[k] = { from: v.from && sw(v.from), to: v.to && sw(v.to) }; }
  if (band.colGap) { out.colGap = {}; for (const [k, v] of Object.entries(band.colGap)) out.colGap[hf ? bw - 2 - +k : +k] = v; }
  if (band.rowGap) { out.rowGap = {}; for (const [k, v] of Object.entries(band.rowGap)) out.rowGap[vf ? bh - 2 - +k : +k] = v; }
  return out;
}

// local index c (0..w-1) -> index inside a slot of `slot` columns. Order and distinctness are kept; the block is spread by at most `cap`
// (so 3 columns never become 9) and centred in what is left (`top`: pushed to the start instead, so the blocks of a row share their top edge).
export function slotMap(w, slot, cap = 1.3, top = false) {
  if (w >= slot) return Array.from({ length: w }, (_, c) => c);
  if (w <= 1) return [top ? 0 : Math.floor((slot - 1) / 2)];
  const w2 = Math.min(slot, Math.max(w, Math.round((w - 1) * cap) + 1)), off = top ? 0 : Math.floor((slot - w2) / 2);
  return Array.from({ length: w }, (_, c) => off + Math.round(c * (w2 - 1) / (w - 1)));
}

export function composeWhole({ stages, bands, arrangement, streetCols = 220, streetRows = 170, haloPad = 34, base = {}, stretch = 1.3 }) {
  const { cell, fh, fv, GC, GR } = arrangement, [ex, ey] = arrangement.spread || [1, 1], capX = Math.max(stretch, ex * 1.1), capY = Math.max(stretch, ey * 1.1);
  const grids = {}, size = {};
  for (const s of stages) {
    const b = mirrorBand(bands[s.id], fh[s.id], fv[s.id]);
    grids[s.id] = { band: b, rows: b.map.map(r => r.trim().split(/\s+/)) };
    size[s.id] = { w: Math.max(...grids[s.id].rows.map(r => r.length)), h: grids[s.id].rows.length };
  }
  const colW = Array(GC).fill(0), rowH = Array(GR).fill(0);
  for (const s of stages) { const [c, r] = cell[s.id]; colW[c] = Math.max(colW[c], size[s.id].w); rowH[r] = Math.max(rowH[r], size[s.id].h); }
  const colOff = [], rowOff = []; let a = 0;
  for (let j = 0; j < GC; j++) colW[j] = Math.ceil(colW[j] * ex - 1e-9); for (let r = 0; r < GR; r++) rowH[r] = Math.ceil(rowH[r] * ey - 1e-9);
  for (let j = 0; j < GC; j++) { colOff[j] = a; a += colW[j]; } a = 0;
  for (let r = 0; r < GR; r++) { rowOff[r] = a; a += rowH[r]; }
  const gridCols = colW.reduce((x, y) => x + y, 0), gridRows = rowH.reduce((x, y) => x + y, 0);
  const rows = Array.from({ length: gridRows }, () => Array(gridCols).fill('.'));
  const cfg = { ...base, map: null, colGap: {}, rowGap: {}, ports: {}, groups: [] };
  const extents = {}, blockOf = {};
  stages.forEach((s, si) => {
    const [gc, gr] = cell[s.id], { rows: grid, band } = grids[s.id], present = [];
    const cm = slotMap(size[s.id].w, colW[gc], capX), rm = slotMap(size[s.id].h, rowH[gr], capY, true);
    const col0 = colOff[gc] + cm[0], row0 = rowOff[gr] + rm[0];
    extents[s.id] = { col0, row0, w: cm[cm.length - 1] - cm[0] + 1, h: rm[rm.length - 1] - rm[0] + 1 }; blockOf[s.id] = { gc, gr };
    grid.forEach((row, r) => row.forEach((t, c) => { if (t !== '.') { rows[rowOff[gr] + rm[r]][colOff[gc] + cm[c]] = t; present.push(t); } }));
    for (const [k, v] of Object.entries(band.ports || {})) cfg.ports[k] = v;
    for (const [k, v] of Object.entries(band.rowGap || {})) { const g = rowOff[gr] + (rm[+k] ?? rm[rm.length - 1]); cfg.rowGap[g] = Math.max(cfg.rowGap[g] || 0, v); }
    for (const [k, v] of Object.entries(band.colGap || {})) { const g = colOff[gc] + (cm[+k] ?? cm[cm.length - 1]); cfg.colGap[g] = Math.max(cfg.colGap[g] || 0, v); }
    cfg.groups.push({ id: s.id, title: (si + 1) + ' · ' + String(s.title || s.id).toUpperCase(), nodes: present, pad: haloPad, tone: stageTone(si, stages.length) });
  });
  cfg.map = rows.map(r => r.join(' '));
  for (let j = 0; j < GC - 1; j++) { const last = colOff[j] + colW[j] - 1; cfg.colGap[last] = Math.max(cfg.colGap[last] || 0, streetCols); }
  for (let r = 0; r < GR - 1; r++) { const last = rowOff[r] + rowH[r] - 1; cfg.rowGap[last] = Math.max(cfg.rowGap[last] || 0, streetRows); }
  if (!Object.keys(cfg.ports).length) delete cfg.ports;
  return { cfg, extents, blockOf, macro: { GC, GR, colOff, colW, rowOff, rowH, gridCols, gridRows } };
}
