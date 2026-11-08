// Layout quality metrics on a geometry object. Used as an objective gate by the tuning loop and by the layout checks.
// FIT_VIEWPORT is the viewport the chart is fitted into for metrics.fitScale (default 1600x900 = the stage a viewer gives the chart at
// 1920x1080); pass cfg.fit = {w,h} to metrics(g, cfg) to use another. A smaller 1320x860 viewport is also measured, as cfg.legacyFit /
// m.fitScaleLegacy, so the target (>= 0.7 for <= 21 nodes) can be checked against it; the score penalty uses that value.
// m.minTextPx = the smallest text on screen at fit (nominal font px x fitScale) over the text kinds the chart really has; m.minTextKind
// says which. Informational: it does not enter the score or the hard metrics. cfg.fonts overrides the nominal sizes (see FONT in layout.mjs).
import { FONT } from './layout.mjs';
export const FIT_VIEWPORT = { w: 1600, h: 900 };
export const LEGACY_FIT_VIEWPORT = { w: 1320, h: 860 };
const segsOf = pts => { const s = []; for (let i = 0; i < pts.length - 1; i++) s.push([pts[i], pts[i + 1]]); return s; };
const isH = ([a, b]) => Math.abs(a[1] - b[1]) < 0.5, isV = ([a, b]) => Math.abs(a[0] - b[0]) < 0.5;
const rectsOverlap = (a, b, m = 0) => a.x < b.x + b.w - m && a.x + a.w > b.x + m && a.y < b.y + b.h - m && a.y + a.h > b.y + m;
function segHitsRect(s, r, shrink = 2) {
  const x0 = r.x + shrink, x1 = r.x + r.w - shrink, y0 = r.y + shrink, y1 = r.y + r.h - shrink;
  const [a, b] = s;
  if (isH(s)) return a[1] > y0 && a[1] < y1 && Math.max(Math.min(a[0], b[0]), x0) < Math.min(Math.max(a[0], b[0]), x1);
  if (isV(s)) return a[0] > x0 && a[0] < x1 && Math.max(Math.min(a[1], b[1]), y0) < Math.min(Math.max(a[1], b[1]), y1);
  // diagonal fallback: sample
  for (let t = 0; t <= 1; t += 0.02) { const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t; if (x > x0 && x < x1 && y > y0 && y < y1) return true; }
  return false;
}

export function metrics(g, cfg = {}) {
  const fit = { ...FIT_VIEWPORT, ...(cfg.fit || {}) }, legacyFit = { ...LEGACY_FIT_VIEWPORT, ...(cfg.legacyFit || {}) }, fonts = { ...FONT, ...(cfg.fonts || {}) };
  const nodeById = Object.fromEntries(g.nodes.map(n => [n.id, n]));
  const m = {
    size: [Math.round(g.width), Math.round(g.height)], aspect: +(g.width / g.height).toFixed(2),
    nodes: g.nodes.length, edges: g.edges.length,
    crossings: 0, trackOverlaps: 0, edgeThroughNode: 0, nodeOverlaps: 0,
    labelOverlapsLabel: 0, labelOverlapsNode: 0, labelOverlapsEdge: 0, labelMissing: 0,
    diagonalSegs: 0, shortArrowStubs: 0, bends: 0, totalLen: 0, longestEdge: 0, issues: [],
  };
  const S = g.edges.map(e => ({ e, segs: segsOf(e.pts) }));
  const boxOf = pts => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; } return [x0, y0, x1, y1]; };
  S.forEach(o => { o.box = boxOf(o.e.pts); });
  const nearBox = (b, r, m) => b[0] < r.x + r.w - m && b[2] > r.x + m && b[1] < r.y + r.h - m && b[3] > r.y + m;      // can a segment inside box b reach rect r (inset m)?
  // node/node overlap
  for (let i = 0; i < g.nodes.length; i++) for (let j = i + 1; j < g.nodes.length; j++)
    if (rectsOverlap(g.nodes[i], g.nodes[j], 1)) { m.nodeOverlaps++; m.issues.push(`nodes overlap: ${g.nodes[i].id}/${g.nodes[j].id}`); }
  for (const { e, segs, box } of S) {
    let len = 0;
    segs.forEach((s, k) => {
      len += Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
      if (!isH(s) && !isV(s)) m.diagonalSegs++;
    });
    m.bends += Math.max(0, e.pts.length - 2); m.totalLen += len; m.longestEdge = Math.max(m.longestEdge, len);
    const last = segs[segs.length - 1];
    if (last && Math.hypot(last[1][0] - last[0][0], last[1][1] - last[0][1]) < 14) m.shortArrowStubs++;
    // edge through nodes (other than endpoints' own boxes)
    for (const n of g.nodes) {
      if (n.id === e.from || n.id === e.to || !nearBox(box, n, 2)) continue;
      if (segs.some(s => segHitsRect(s, n))) { m.edgeThroughNode++; m.issues.push(`edge ${e.id} passes through node ${n.id}`); }
    }
    // own endpoints: segment interior cuts through its own node
    for (const nid of new Set([e.from, e.to])) {
      const n = nodeById[nid];
      segs.forEach((s, k) => { if (e.from === e.to) return; if (segHitsRect(s, n, 3)) { m.edgeThroughNode++; m.issues.push(`edge ${e.id} runs inside own node ${nid}`); } });
    }
  }
  // edge/edge crossings and shared tracks. Only pairs that share a cell of a coarse grid can cross or run along each other (every segment is
  // registered over its box grown by 3.5 px, the track tolerance), so the pairs are found through the grid and then tested exactly as before, in the same order.
  {
    const CELL = 320, cells = new Map(), E = S.length, seen = new Set(), keys = [];
    S.forEach(({ segs }, ei) => {
      let last = null;
      for (const sg of segs) {
        if (!isH(sg) && !isV(sg)) continue;
        const x0 = Math.min(sg[0][0], sg[1][0]) - 3.5, x1 = Math.max(sg[0][0], sg[1][0]) + 3.5, y0 = Math.min(sg[0][1], sg[1][1]) - 3.5, y1 = Math.max(sg[0][1], sg[1][1]) + 3.5;
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
          const k = (cx + 512) * 8192 + (cy + 512); let arr = cells.get(k); if (!arr) cells.set(k, arr = []);
          if (arr[arr.length - 1] !== ei) arr.push(ei);
        }
      }
    });
    for (const arr of cells.values()) for (let p = 0; p < arr.length; p++) for (let q = p + 1; q < arr.length; q++) { const k = Math.min(arr[p], arr[q]) * E + Math.max(arr[p], arr[q]); if (!seen.has(k)) { seen.add(k); keys.push(k); } }
    keys.sort((x, y) => x - y);
    for (const k of keys) {
      const i = Math.floor(k / E), j = k % E;
      for (const a of S[i].segs) for (const b of S[j].segs) {
        if (isH(a) && isV(b) || isV(a) && isH(b)) {
          const h = isH(a) ? a : b, v = isH(a) ? b : a;
          const hx0 = Math.min(h[0][0], h[1][0]), hx1 = Math.max(h[0][0], h[1][0]), vy0 = Math.min(v[0][1], v[1][1]), vy1 = Math.max(v[0][1], v[1][1]);
          if (v[0][0] > hx0 + 0.5 && v[0][0] < hx1 - 0.5 && h[0][1] > vy0 + 0.5 && h[0][1] < vy1 - 0.5) m.crossings++;
        } else if (isH(a) && isH(b) && Math.abs(a[0][1] - b[0][1]) < 3) {
          const o = Math.min(Math.max(a[0][0], a[1][0]), Math.max(b[0][0], b[1][0])) - Math.max(Math.min(a[0][0], a[1][0]), Math.min(b[0][0], b[1][0]));
          if (o > 6) { m.trackOverlaps++; m.issues.push(`tracks overlap ${S[i].e.id}/${S[j].e.id} (${Math.round(o)}px, horizontal)`); }
        } else if (isV(a) && isV(b) && Math.abs(a[0][0] - b[0][0]) < 3) {
          const o = Math.min(Math.max(a[0][1], a[1][1]), Math.max(b[0][1], b[1][1])) - Math.max(Math.min(a[0][1], a[1][1]), Math.min(b[0][1], b[1][1]));
          if (o > 6) { m.trackOverlaps++; m.issues.push(`tracks overlap ${S[i].e.id}/${S[j].e.id} (${Math.round(o)}px, vertical)`); }
        }
      }
    }
  }
  // labels
  const lab = g.edges.filter(e => e.labelBox);
  m.labelMissing = g.edges.filter(e => !e.labelBox && !e.focusLabel && (e.lines ? e.lines.length : e.label)).length;   // an edge with no label text needs no pill
  for (let i = 0; i < lab.length; i++) {
    const a = lab[i].labelBox;
    for (let j = i + 1; j < lab.length; j++) if (rectsOverlap(a, lab[j].labelBox, 0)) { m.labelOverlapsLabel++; m.issues.push(`labels overlap ${lab[i].id}/${lab[j].id}`); }
    for (const n of g.nodes) if (rectsOverlap(a, n, 0)) { m.labelOverlapsNode++; m.issues.push(`label ${lab[i].id} overlaps node ${n.id}`); }
    for (const { e, segs, box } of S) { if (e.id === lab[i].id || !nearBox(box, a, 0)) continue; if (segs.some(s => segHitsRect(s, { x: a.x, y: a.y, w: a.w, h: a.h }, 0))) { m.labelOverlapsEdge++; } }
  }
  m.totalLen = Math.round(m.totalLen);
  m.longestEdge = Math.round(m.longestEdge);
  m.fitScale = +Math.min(fit.w / g.width, fit.h / g.height).toFixed(2); // scale at which the chart fits the fit viewport (default 1600x900)
  m.fitScaleLegacy = +Math.min(legacyFit.w / g.width, legacyFit.h / g.height).toFixed(2); // the same for the smaller 1320x860 viewport (target >= 0.7 for <=21 nodes)
  // smallest text on screen at fit: nominal px x the real (unrounded) fit scale, over the text kinds present
  const present = [['node', g.nodes.length > 0], ['edge', lab.length > 0], ['cluster', (g.clusters || []).some(c => c.title)], ['chip', g.nodes.some(n => n.handle || n.tag)]].filter(([, on]) => on);
  const s = Math.min(fit.w / g.width, fit.h / g.height);
  let small = null;
  for (const [k] of present) if (!small || fonts[k] < fonts[small]) small = k;
  m.minTextPx = small ? +(fonts[small] * s).toFixed(1) : null;
  m.minTextKind = small;
  // single scalar for ranking attempts (lower is better)
  const aspectPenalty = m.aspect < 1.25 ? (1.25 - m.aspect) * 60 : m.aspect > 2.4 ? (m.aspect - 2.4) * 60 : 0;
  m.score = Math.round(m.nodeOverlaps * 500 + m.edgeThroughNode * 200 + m.trackOverlaps * 120 + m.labelOverlapsLabel * 80 + m.labelOverlapsNode * 80 +
    m.labelOverlapsEdge * 20 + m.diagonalSegs * 40 + m.shortArrowStubs * 15 + m.crossings * 6 + m.bends * 1.2 + m.longestEdge / 40 + aspectPenalty + m.labelMissing * 30 + (m.fitScaleLegacy < 0.7 && g.nodes.length <= 22 ? (0.7 - m.fitScaleLegacy) * 500 : 0));
  m.issues = m.issues.slice(0, 30);
  return m;
}
