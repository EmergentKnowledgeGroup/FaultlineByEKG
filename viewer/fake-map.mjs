// FAKE LARGE MAP for the viewer's size and look tests: one whole-system chart of about 400 boxes, no layout engine and no real system behind it.
// Twelve numbered stage blocks in a snake (left to right in rows, three blocks per row), a grid of boxes in each, short hand-offs between the blocks,
// a few return routes along the top lane of a row, and loops listed by box. Deterministic (seeded). Evidence for it: ./fake-evidence.mjs.
//   import { makeFakeData } from './fake-map.mjs';   const data = makeFakeData({ cols: 6, rows: 5 });      // atlasData, chart id 'whole'
//   node viewer/fake-map.mjs --out <file.json>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KINDS = ['step', 'step', 'step', 'decision', 'gate', 'wait', 'store', 'external'];
const VERBS = ['Read', 'Check', 'Record', 'Offer', 'Verify', 'Split', 'Merge', 'Queue', 'Release', 'Score', 'Sort', 'Hold'];
const THINGS = ['the claim', 'a ticket', 'the batch', 'an invoice', 'the order', 'a lease', 'the notice', 'a slot', 'the file', 'a request'];
const STAGE_NAMES = ['Arrival', 'Screening', 'Intake desk', 'Matching', 'Scheduling', 'Work queue', 'Review', 'Approval', 'Hand-off', 'Billing', 'Follow-up', 'Closing'];
const WHENS = ['Yes', 'No', 'Within limit', 'Over limit', 'Retry', 'Timed out', 'Approved', 'Refused', 'Found', 'Missing', 'Ready', 'Later'];

export function makeFakeData({ cols = 6, rows = 6, perRow = 3, nStages = 12, seed = 11 } = {}) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const W = 190, H = 64, PX = 250, PY = 118, PADX = 34, PADT = 56, PADB = 30, GX = 150, GY = 130;
  const bw = cols * PX - (PX - W) + 2 * PADX, bh = (rows - 1) * PY + H + PADT + PADB;
  const nodes = {}, gnodes = [], edges = {}, gedges = [], clusters = [], stages = [];
  const cell = {};                                                       // 'stage:c:r' -> node id
  const addEdge = (a, b, type, pts, when) => {
    const id = 'r' + gedges.length, label = when || '';
    edges[id] = { id, from: a, to: b, type, label, short: label, why: label ? 'The route is taken when: ' + label.toLowerCase() + '.' : 'The next step follows.', refs: [], inferred: type === 'deliver' && rnd() < 0.3 };
    const e = { id, from: a, to: b, type, label, lines: label ? [label] : [], pts };
    if (label) { const m = pts.length > 2 ? Math.floor(pts.length / 2) : 0, p = pts[m], q = pts[m + 1] || pts[m]; e.labelBox = { x: (p[0] + q[0]) / 2 - 36, y: (p[1] + q[1]) / 2 - 22, w: 72, h: 18 }; }
    gedges.push(e); return id;
  };
  for (let k = 0; k < nStages; k++) {
    const col = k % perRow, row = Math.floor(k / perRow), bx = col * (bw + GX) + 20, by = row * (bh + GY) + 20, sid = 's' + (k + 1);
    clusters.push({ id: sid, title: STAGE_NAMES[k % STAGE_NAMES.length], x: bx, y: by, w: bw, h: bh });
    stages.push({ id: sid, title: STAGE_NAMES[k % STAGE_NAMES.length], blurb: 'A made-up stage used only to test the viewer.' });
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const forced = (c === 0 && r === 0) || (c === cols - 1 && r === rows - 1);
      if (!forced && rnd() < 0.07) continue;
      const kind = r === rows - 1 && c === cols - 1 ? (k === nStages - 1 ? 'end' : 'step') : (rnd() < 0.05 ? 'end' : KINDS[Math.floor(rnd() * KINDS.length)]);
      const id = 'b' + (k + 1) + '_' + c + '_' + r, title = VERBS[Math.floor(rnd() * VERBS.length)] + ' ' + THINGS[Math.floor(rnd() * THINGS.length)];
      const status = rnd() < 0.06 ? 'off' : rnd() < 0.04 ? 'test-only' : 'live', handle = rnd() < 0.1 ? 'H' + (1 + Math.floor(rnd() * 9)) : '';
      nodes[id] = { id, title, kind, status, handle, plain: 'A made-up step in stage ' + (k + 1) + '. It exists only so the viewer can be tested at size.', summary: '', why: '', inputs: [], outputs: [], failure: '',
        refs: [{ path: 'fake/stage' + (k + 1) + '.py', symbol: 'fake/stage' + (k + 1) + '.py::step_' + c + '_' + r, line: 10 + r * 20 + c }], switch: '', outcome: kind === 'end' ? 'success' : '', stage: sid, family: sid };
      const gx = bx + PADX + c * PX, gy = by + PADT + r * PY, ws = title.split(' '), half = Math.ceil(ws.length / 2);
      gnodes.push({ id, x: gx, y: gy, w: W, h: H, lines: ws.length > 2 ? [ws.slice(0, half).join(' '), ws.slice(half).join(' ')] : [title], kind, title, ...(handle ? { handle, tag: handle } : {}) });
      cell[sid + ':' + c + ':' + r] = id;
    }
    const G = id => gnodes.find(n => n.id === id);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols - 1; c++) {
      const a = cell[sid + ':' + c + ':' + r], b = cell[sid + ':' + (c + 1) + ':' + r]; if (!a || !b) continue;
      const A = G(a), B = G(b), dec = nodes[a].kind === 'decision' || nodes[a].kind === 'gate';
      addEdge(a, b, rnd() < 0.12 ? 'record' : rnd() < 0.1 ? 'deliver' : 'forward', [[A.x + W, A.y + H / 2], [B.x, B.y + H / 2]], dec || rnd() < 0.18 ? WHENS[Math.floor(rnd() * WHENS.length)] : '');
    }
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols; c += 2) {
      const a = cell[sid + ':' + c + ':' + r], b = cell[sid + ':' + c + ':' + (r + 1)]; if (!a || !b) continue;
      const A = G(a), B = G(b); addEdge(a, b, 'forward', [[A.x + W / 2, A.y + H], [B.x + W / 2, B.y]], rnd() < 0.3 ? WHENS[Math.floor(rnd() * WHENS.length)] : '');
    }
    for (let q = 0; q < 2; q++) {                                         // a return route above a row: out of the top of one box, along the lane, into the top of an earlier one
      const r = 1 + Math.floor(rnd() * (rows - 1)), c = 2 + Math.floor(rnd() * (cols - 2)), a = cell[sid + ':' + c + ':' + r], b = cell[sid + ':' + (c - 2) + ':' + r]; if (!a || !b) continue;
      const A = G(a), B = G(b), yy = A.y - 22; addEdge(a, b, 'return', [[A.x + W / 2, A.y], [A.x + W / 2, yy], [B.x + W / 2, yy], [B.x + W / 2, B.y]], 'Retry');
    }
  }
  const G = id => gnodes.find(n => n.id === id);
  for (let k = 0; k < nStages - 1; k++) {                                // hand-offs: last box of a stage to the first box of the next
    const sid = 's' + (k + 1), a = cell[sid + ':' + (cols - 1) + ':' + (rows - 1)], b = cell['s' + (k + 2) + ':0:0'], A = G(a), B = G(b), wrap = (k + 1) % perRow === 0;
    if (!wrap) { const gx = A.x + W + (PADX + GX / 2); addEdge(a, b, 'forward', [[A.x + W, A.y + H / 2], [gx, A.y + H / 2], [gx, B.y + H / 2], [B.x, B.y + H / 2]], ''); }
    else { const lane = A.y + H + PADB + GY / 2; addEdge(a, b, 'forward', [[A.x + W / 2, A.y + H], [A.x + W / 2, lane], [B.x + W / 2, lane], [B.x + W / 2, B.y]], ''); }
  }
  const width = perRow * bw + (perRow - 1) * GX + 60, height = Math.ceil(nStages / perRow) * bh + (Math.ceil(nStages / perRow) - 1) * GY + 60;
  const geom = { width, height, nodes: gnodes, edges: gedges, clusters };
  const ids = Object.keys(nodes), spine = [];
  for (let k = 0; k < nStages; k++) { const sid = 's' + (k + 1); spine.push(cell[sid + ':0:0'], cell[sid + ':' + (cols - 1) + ':' + (rows - 1)]); }
  const loops = [1, 4, 7].map((k, i) => ({ id: 'l' + (i + 1), title: 'Retry loop ' + (i + 1), blurb: 'A made-up loop.', boxes: [cell['s' + k + ':1:1'], cell['s' + k + ':2:1'], cell['s' + k + ':3:1']].filter(Boolean), limit: i ? 'MAX_TRIES' : '' }));
  const whole = { id: 'whole', title: 'A large made-up system, end to end', navLabel: 'Whole system', navSub: 'About ' + ids.length + ' boxes', kind: 'whole', summary: 'A made-up whole-system map used only to test the viewer at size.',
    nodes, edges, geom, stages, loops, spine: spine.filter(Boolean), flow: { role: 'whole', order: 1, blurb: 'Everything on one page.' } };
  return { meta: { title: 'Large made-up map', draft: true, notDrawn: { count: 7, items: ['fake/legacy.py', 'fake/batch_job.py', 'fake/admin_tools.py', 'fake/cron_tasks.py', 'fake/mailer.py', 'fake/export.py', 'fake/seed.py'] },
    census: { endings: { total: 20, accounted: 16 }, branches: { total: 90, accounted: 71 } } }, nav: [{ group: 'Test', items: ['whole'] }], stages: stages.map((s) => ({ ...s })), charts: { whole }, terms: [], sections: [] };       // (stages at the top, as the build writes them: they give each stage its number)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const i = process.argv.indexOf('--out'), out = i >= 0 ? process.argv[i + 1] : '';
  const d = makeFakeData({});
  const c = d.charts.whole;
  console.log('boxes', Object.keys(c.nodes).length, 'routes', Object.keys(c.edges).length, 'size', c.geom.width + 'x' + c.geom.height, 'aspect', (c.geom.width / c.geom.height).toFixed(2));
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(path.resolve(out), JSON.stringify(d)); console.log('wrote', out); }
}
