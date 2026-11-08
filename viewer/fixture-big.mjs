// FIXTURE for the viewer's big-chart paths (level of detail, minimap, many halos, speed): a synthetic whole-system chart of about 230 boxes.
// No layout engine involved: boxes sit on a plain grid and routes are straight or three-segment orthogonal lines. Deterministic (seeded).
//   import { makeBigData } from './fixture-big.mjs';   const data = makeBigData({ cols: 20, rows: 12 });
const KINDS = ['step', 'decision', 'gate', 'wait', 'store', 'external', 'end'];
const VERBS = ['check', 'read', 'record', 'wait for', 'offer', 'verify', 'split', 'merge'];

export function makeBigData({ cols = 20, rows = 12, seed = 7 } = {}) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const PX = 330, PY = 150, W = 190, H = 64, id = (c, r) => 'n' + c + '_' + r;
  const nodes = {}, gnodes = [], edges = {}, gedges = [], clusters = [], stages = [];
  const nStages = 6, stageOf = c => Math.min(nStages - 1, Math.floor(c * nStages / cols));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (rnd() < 0.04) continue;
    const kind = KINDS[Math.floor(rnd() * KINDS.length)], title = 'Step ' + (c + 1) + '.' + (r + 1) + ' ' + VERBS[Math.floor(rnd() * VERBS.length)], stage = 's' + stageOf(c);
    const status = rnd() < 0.08 ? 'off' : rnd() < 0.05 ? 'test-only' : 'live';
    nodes[id(c, r)] = { id: id(c, r), title, kind, status, handle: rnd() < 0.15 ? 'H' + (1 + Math.floor(rnd() * 12)) : '', plain: 'A synthetic step used only to test the viewer, with one short sentence about what happens here.', summary: '', why: '', inputs: [], outputs: [], failure: '', refs: [], stage, family: stage };
    gnodes.push({ id: id(c, r), x: c * PX + 40, y: r * PY + 60, w: W, h: H, lines: [title.slice(0, 16), title.slice(16)].filter(Boolean), kind, title, ...(nodes[id(c, r)].handle ? { handle: nodes[id(c, r)].handle } : {}), family: stage });
  }
  let ei = 0;
  const add = (a, b, type, pts) => {
    const eid = 'big:e' + ei++, when = 'Condition ' + ei;
    edges[eid] = { id: eid, from: a, to: b, type, label: when, short: when, why: 'Synthetic.', refs: [] };
    gedges.push({ id: eid, from: a, to: b, type, label: when, lines: [when], pts, labelBox: { x: (pts[0][0] + pts[1][0]) / 2 - 40, y: (pts[0][1] + pts[1][1]) / 2 - 22, w: 80, h: 20 } });
  };
  const N = k => nodes[k], G = k => gnodes.find(n => n.id === k);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols - 1; c++) {
    const a = id(c, r), b = id(c + 1, r); if (!N(a) || !N(b)) continue;
    const A = G(a), B = G(b); add(a, b, rnd() < 0.15 ? 'deliver' : rnd() < 0.1 ? 'record' : 'forward', [[A.x + W, A.y + H / 2], [B.x, B.y + H / 2]]);
  }
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols; c += 3) {
    const a = id(c, r), b = id(c, r + 1); if (!N(a) || !N(b)) continue;
    const A = G(a), B = G(b); add(a, b, 'forward', [[A.x + W / 2, A.y + H], [B.x + W / 2, B.y]]);
  }
  for (let k = 0; k < 14; k++) {
    const c = 4 + Math.floor(rnd() * 14), r = 1 + Math.floor(rnd() * (rows - 2)), a = id(c, r), b = id(c - 3, r); if (!N(a) || !N(b)) continue;
    const A = G(a), B = G(b), yy = A.y - 22; add(a, b, 'return', [[A.x + W / 2, A.y], [A.x + W / 2, yy], [B.x + W / 2, yy], [B.x + W / 2, B.y]]);
  }
  for (let g = 0; g < nStages; g++) {
    const c0 = Math.floor(g * cols / nStages), c1 = Math.floor((g + 1) * cols / nStages) - 1;
    clusters.push({ id: 's' + g, title: 'Stage ' + (g + 1) + ' of the long journey', x: c0 * PX + 20, y: 20, w: (c1 - c0 + 1) * PX - 20, h: rows * PY + 40 });
    stages.push({ id: 's' + g, title: 'Stage ' + (g + 1) + ' of the long journey', blurb: 'A synthetic stage.' });
  }
  const geom = { width: cols * PX + 80, height: rows * PY + 100, nodes: gnodes, edges: gedges, clusters };
  const regions = stages.map(st => ({ id: st.id, title: st.title, kind: 'stage', blurb: st.blurb, nodes: Object.keys(nodes).filter(k => nodes[k].stage === st.id) }));
  const big = { id: 'big', title: 'A big synthetic whole-system map (test)', navLabel: 'Big map (test)', navSub: 'About ' + gnodes.length + ' boxes', kind: 'whole', summary: 'Synthetic chart used only to test the viewer.', geom, nodes, edges, metrics: { size: [geom.width, geom.height] }, stages, regions, portals: [] };
  return { meta: { title: 'Big synthetic map', draft: false }, nav: [{ group: 'Test', items: ['big'] }], charts: { big }, terms: [], sections: [] };
}
