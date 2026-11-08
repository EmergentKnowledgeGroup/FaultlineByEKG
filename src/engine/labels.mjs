// Global label optimiser. gridLayout places edge labels greedily, one edge at a time (shortest route first); on a dense whole-system map
// that leaves pills sitting on the wrong line, on a node, or far from either end of a long route. optimiseLabels re-places every label on a
// finished geometry with a seeded multi-pass search (ownership first: the pill sits ON its own line wherever possible; near an end for
// long routes; never on a node, another label or a cluster caption) and returns cfg.labelAt pins that make the engine's own pinned-label
// path reproduce exactly that placement, so the result is an ordinary layout config: withPins(cfg, pins) and run gridLayout again.
//
//   const r = optimiseLabels(geom, cfg, { passes: 8, seed: 1 });   // geom = gridLayout(graph, cfg); cfg = the config that made it
//   const cfg2 = withPins(cfg, r.pins);                            // gridLayout(graph, cfg2) now reproduces r.boxes
//   r.before / r.after / r.verified    counts: labelLabel labelNode labelForeign foreignHits ambiguous farBoth titleHit
//   r.reproduced / r.pinned            { same, total }: engine reproduction of the input geometry / of the pins (must be total/total)
//   r.geom                             a copy of geom with the verified label boxes;  r.boxes aligned to geom.edges (null = no label)
//   r.better                           true when the optimised placement scores better than the engine's own (see quality); adopt the pins only then
// opts: passes (8), seed (1), start ('best': try both the engine's own placement and a greedy one, keep the better; or 'engine' / 'greedy'),
// titleBox(cluster) -> rect, longRoute (1400: a route longer than this px wants its label near an end; Infinity turns
// that off), farFrom (700: px from the nearest end beyond which the pull grows steeply), farLimit (800: the farBoth metric's distance).
// The three length numbers suit a very large map; on a chart of ordinary size raise longRoute or set it to Infinity.
// Deterministic: the only randomness is the seeded visiting order of the passes. No clock, no files (the CLI below reads and writes them).
//   node src/engine/labels.mjs <geom.json> [--cfg cfg.json] [--out pins.json] [--emit geom2.json] [--passes 8] [--seed 1]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { placeLabels } from './gridlayout.mjs';

const ov = (p, q, m = 0) => p.x < q.x + q.w - m && p.x + p.w > q.x + m && p.y < q.y + q.h - m && p.y + p.h > q.y + m;
const OFF = 1e8;                      // a cost at or above this is infeasible (a hard overlap)
const W_FOREIGN = 130, W_BEND = 25;   // weights: another route's line through the pill / this route's own bend under it

// one number for "how good is this placement" (lower is better), from the counts measure() returns; used for r.better
export const quality = m => (m.labelLabel + m.labelNode + m.titleHit) * 1000 + m.foreignHits * 50 + m.labelForeign * 50 + m.ambiguous * 20 + m.farBoth * 10;

// footprint of a cluster caption that a label must stay off: what renderSVG draws (x+12, y+8, 9.8 px a character) plus a margin
export const titleFootprint = c => ({ x: c.x + 8, y: c.y + 4, w: String(c.title || '').length * 9.8 + 16, h: 30, id: c.id });

export function withPins(cfg, pins) {
  return { ...cfg, labelAt: { ...(cfg.labelAt || {}), ...pins }, labelPinFirst: true, labelSearch: 'wide' };
}

export function optimiseLabels(geom, cfg = {}, opts = {}) {
  const passes = opts.passes ?? 8, LONG = opts.longRoute ?? 1400, FAR = opts.farFrom ?? 700, FAR_LIMIT = opts.farLimit ?? 800;
  const log = [];
  const NODES = geom.nodes;
  const TITLES = (geom.clusters || []).filter(c => c.title).map(opts.titleBox || titleFootprint);

  // edges: every edge's line is an obstacle; only edges with a label box get placed
  const E = geom.edges.map((e, i) => {
    const has = !!e.labelBox, pts = e.pts;
    let acc = 0;
    const cum = pts.map((p, k) => (k ? (acc += Math.abs(p[0] - pts[k - 1][0]) + Math.abs(p[1] - pts[k - 1][1])) : 0));
    return { id: e.id, i, has, pts, lw: has ? e.labelBox.w : 0, lh: has ? e.labelBox.h : 0, box: e.labelBox, L: acc, cum };
  });

  // ---- reproduce the engine (also the verification path for the pins)
  const engineRun = (hints, opt) => {
    const EE = E.map(e => ({ id: e.id, pts: e.pts, lw: e.lw, lh: e.lh }));
    const NN = Object.fromEntries(NODES.map(n => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h }]));
    placeLabels(EE, NN, hints, opt);
    return EE.map(e => e.labelBox || null);
  };
  const same = (a, b) => !!a && !!b && Math.abs(a.x - b.x) <= 0.6 && Math.abs(a.y - b.y) <= 0.6;
  const reproduced = { same: 0, total: E.filter(e => e.has).length };
  {
    const re = engineRun(cfg.labelAt || {}, { pinFirst: !!cfg.labelPinFirst, wide: cfg.labelSearch === 'wide' });
    E.forEach((e, k) => { if (e.has && same(re[k], e.box)) reproduced.same++; });
  }

  // ---- geometry helpers: every route segment, in a coarse grid so a pill only meets the lines near it
  const SEG = [];
  E.forEach((e, ei) => { for (let i = 0; i < e.pts.length - 1; i++) { const [x0, y0] = e.pts[i], [x1, y1] = e.pts[i + 1]; SEG.push({ ei, i, minx: Math.min(x0, x1), maxx: Math.max(x0, x1), miny: Math.min(y0, y1), maxy: Math.max(y0, y1) }); } });
  const CELL = 240, grid = new Map(), gk = (cx, cy) => cx + ',' + cy;
  SEG.forEach((s, si) => { for (let cx = Math.floor(s.minx / CELL); cx <= Math.floor(s.maxx / CELL); cx++) for (let cy = Math.floor(s.miny / CELL); cy <= Math.floor(s.maxy / CELL); cy++) { const k = gk(cx, cy); (grid.get(k) || grid.set(k, []).get(k)).push(si); } });
  const segsNear = (b, m = 0) => {
    const out = new Set();
    for (let cx = Math.floor((b.x - m) / CELL); cx <= Math.floor((b.x + b.w + m) / CELL); cx++) for (let cy = Math.floor((b.y - m) / CELL); cy <= Math.floor((b.y + b.h + m) / CELL); cy++) { const l = grid.get(gk(cx, cy)); if (l) for (const si of l) out.add(si); }
    return out;
  };
  const hit = (s, b, m = 0) => s.maxx > b.x - m && s.minx < b.x + b.w + m && s.maxy > b.y - m && s.miny < b.y + b.h + m;
  const dist = (s, b) => Math.hypot(Math.max(s.minx - (b.x + b.w), b.x - s.maxx, 0), Math.max(s.miny - (b.y + b.h), b.y - s.maxy, 0));   // 0 when they touch
  const SEGIDX = E.map((e, ei) => { const o = []; SEG.forEach((s, si) => { if (s.ei === ei) o[s.i] = si; }); return o; });

  // ---- metrics (also used on the engine's own placement)
  function measure(boxes) {
    const m = { labelLabel: 0, labelNode: 0, labelForeign: 0, foreignHits: 0, ambiguous: 0, farBoth: 0, titleHit: 0 };
    const worst = { ambiguous: [], far: [], title: [], foreign: [] };
    E.forEach((e, ei) => {
      const b = boxes[ei]; if (!b) return;
      for (let k = ei + 1; k < E.length; k++) if (boxes[k] && ov(b, boxes[k], 0)) m.labelLabel++;
      for (const n of NODES) if (ov(b, n, 0)) m.labelNode++;
      let fh = 0, ownD = 1e9, forD = 1e9;
      for (const si of segsNear(b, 60)) { const s = SEG[si], d = dist(s, b); if (s.ei === ei) ownD = Math.min(ownD, d); else { forD = Math.min(forD, d); if (hit(s, b)) fh++; } }
      if (fh) { m.labelForeign++; m.foreignHits += fh; worst.foreign.push(e.id); }
      if (forD < ownD) { m.ambiguous++; worst.ambiguous.push(e.id); }
      // distance along the route from the label centre to both ends
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2; let best = 1e9, along = 0;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const s = { minx: Math.min(e.pts[i][0], e.pts[i + 1][0]), maxx: Math.max(e.pts[i][0], e.pts[i + 1][0]), miny: Math.min(e.pts[i][1], e.pts[i + 1][1]), maxy: Math.max(e.pts[i][1], e.pts[i + 1][1]) };
        const d = Math.hypot(Math.max(s.minx - cx, cx - s.maxx, 0), Math.max(s.miny - cy, cy - s.maxy, 0));
        if (d < best) { best = d; along = e.cum[i] + Math.abs(cx - e.pts[i][0]) + Math.abs(cy - e.pts[i][1]); }
      }
      if (Math.min(along, e.L - along) > FAR_LIMIT) { m.farBoth++; worst.far.push(e.id); }
      for (const t of TITLES) if (ov(b, t, 0)) { m.titleHit++; worst.title.push(e.id + '@' + t.id); }
    });
    return { m, worst };
  }
  const before = measure(E.map(e => e.box || null));

  // ---- candidates: positions ON each long-enough run (t every 4%), plus beside the line; the engine's own box is always one of them
  const candidates = e => {
    const out = [];
    for (let si = 0; si < e.pts.length - 1; si++) {
      const [x0, y0] = e.pts[si], [x1, y1] = e.pts[si + 1];
      const len = Math.abs(x1 - x0) + Math.abs(y1 - y0); if (len < 20) continue;
      const horiz = Math.abs(y0 - y1) < 0.5, need = (horiz ? e.lw : e.lh) + 12;
      for (let t = 0.08; t <= 0.921; t += 0.04) {
        const tt = +t.toFixed(3), cx = x0 + (x1 - x0) * tt, cy = y0 + (y1 - y0) * tt;
        const spots = [[0, 0, 'on']];
        if (horiz) spots.push([0, -(e.lh / 2 + 6), 'up'], [0, e.lh / 2 + 6, 'dn']); else spots.push([e.lw / 2 + 8, 0, 'rt'], [-(e.lw / 2 + 8), 0, 'lf']);
        for (const [dx, dy, kind] of spots) out.push({ si, t: tt, kind, dx, dy, box: { x: cx - e.lw / 2 + dx, y: cy - e.lh / 2 + dy, w: e.lw, h: e.lh }, along: e.cum[si] + len * tt, fits: len >= need, len });
      }
    }
    return out;
  };
  const CAND = E.map(e => {
    if (!e.has) return [];
    const cs = candidates(e), b = e.box, bx = b.x + b.w / 2, by = b.y + b.h / 2;
    let bestSi = 0, bd = 1e9;
    for (let si = 0; si < e.pts.length - 1; si++) {
      const [x0, y0] = e.pts[si], [x1, y1] = e.pts[si + 1];
      const d = Math.hypot(Math.max(Math.min(x0, x1) - bx, bx - Math.max(x0, x1), 0), Math.max(Math.min(y0, y1) - by, by - Math.max(y0, y1), 0));
      if (d < bd) { bd = d; bestSi = si; }
    }
    const [x0, y0] = e.pts[bestSi], [x1, y1] = e.pts[bestSi + 1], len = Math.abs(x1 - x0) + Math.abs(y1 - y0) || 1;
    const t = Math.abs(x1 - x0) > Math.abs(y1 - y0) ? Math.max(0, Math.min(1, (bx - x0) / (x1 - x0))) : Math.max(0, Math.min(1, (by - y0) / (y1 - y0)));
    const cx = x0 + (x1 - x0) * t, cy = y0 + (y1 - y0) * t;
    cs.push({ si: bestSi, t: +t.toFixed(4), kind: 'orig', dx: bx - cx, dy: by - cy, box: { x: b.x, y: b.y, w: b.w, h: b.h }, along: e.cum[bestSi] + len * t, fits: true, len });
    return cs;
  });
  // last resort for a label with no feasible candidate: boxes in a neighbourhood of the route, detached from the line and penalised by the gap
  const freeCands = e => {
    const out = [];
    for (let si = 0; si < e.pts.length - 1; si++) {
      const [x0, y0] = e.pts[si], [x1, y1] = e.pts[si + 1], len = Math.abs(x1 - x0) + Math.abs(y1 - y0); if (len < 12) continue;
      const cx = x0 + (x1 - x0) * 0.5, cy = y0 + (y1 - y0) * 0.5;
      for (let dx = -240; dx <= 240; dx += 12) for (let dy = -150; dy <= 150; dy += 10) {
        const box = { x: cx - e.lw / 2 + dx, y: cy - e.lh / 2 + dy, w: e.lw, h: e.lh };
        let gap = 1e9;
        for (let sj = 0; sj < e.pts.length - 1; sj++) gap = Math.min(gap, dist({ minx: Math.min(e.pts[sj][0], e.pts[sj + 1][0]), maxx: Math.max(e.pts[sj][0], e.pts[sj + 1][0]), miny: Math.min(e.pts[sj][1], e.pts[sj + 1][1]), maxy: Math.max(e.pts[sj][1], e.pts[sj + 1][1]) }, box));
        out.push({ si, t: 0.5, kind: 'free', dx, dy, box, along: e.cum[si] + len * 0.5, fits: true, len, gap });
      }
    }
    return out;
  };

  // ---- cost of one candidate given the boxes already placed (OFF = infeasible)
  const boxes = E.map(() => null), choice = E.map(() => null);
  function cost(e, ei, c) {
    const b = c.box; let p = 0;
    for (const n of NODES) if (ov(b, n, -3)) return 1e9;
    for (const t of TITLES) if (ov(b, t, 0)) return 1e9;
    for (let k = 0; k < E.length; k++) if (k !== ei && boxes[k] && ov(b, boxes[k], -4)) return 1e9;
    const tip = e.pts[e.pts.length - 1]; if (ov(b, { x: tip[0] - 20, y: tip[1] - 20, w: 40, h: 40 }, 0)) p += 400;
    const st = e.pts[0]; if (ov(b, { x: st[0] - 12, y: st[1] - 12, w: 24, h: 24 }, 0)) p += 150;
    let foreign = 0, bends = 0, nearForeign = 0;
    for (const si of segsNear(b, 14)) {
      const s = SEG[si];
      if (s.ei === ei) { if (hit(s, b, -1) && si !== SEGIDX[ei][c.si]) bends++; continue; }
      if (hit(s, b)) foreign++; else if (c.kind !== 'on' && hit(s, b, 11)) nearForeign++;
    }
    p += foreign * W_FOREIGN + bends * W_BEND + nearForeign * 45;
    if (c.kind !== 'on') p += 18;
    if (!c.fits && c.kind === 'on') p += 90;
    // position along the route: near an end for long routes, centred for short ones
    const dmin = Math.min(c.along, e.L - c.along);
    if (e.L > LONG) p += Math.min(dmin, 5000) * 0.025 + (dmin > FAR ? (dmin - FAR) * 0.15 : 0);
    else p += Math.abs(c.along - e.L / 2) * 0.01;
    p += Math.min(c.len, 400) * -0.02;   // prefer long segments (the label sits clearly on one run)
    return p;
  }
  const place = ei => {
    let best = null, bc = Infinity;
    for (const c of CAND[ei]) { const p = cost(E[ei], ei, c); if (p < bc) { bc = p; best = c; } }
    if (bc >= OFF) {
      for (const c of freeCands(E[ei])) { const p = cost(E[ei], ei, c); if (p >= OFF) continue; const q = p + 60 + c.gap * 0.6; if (q < bc || bc >= OFF) { bc = q; best = c; } }
    }
    return { best, bc };
  };
  const total = () => E.reduce((s, e) => s + (e.has ? (e.cost < OFF ? e.cost : 5e4) : 0), 0);

  // ---- two starting points, each followed by the same seeded improvement passes. The result replaces the engine's own placement only if it is
  // strictly better by quality(); among the two, lower quality then lower cost wins. So r.boxes is never worse than the input.
  //   'greedy': place the labels with the fewest options first;  'engine': start from the placement the engine already made;
  //   'unchanged': the engine's own placement, no passes, no repair (what you get when nothing beats it)
  const labelled = E.map((e, i) => i).filter(i => E[i].has);
  const order = labelled.slice().sort((p, q) => CAND[p].length - CAND[q].length || E[p].L - E[q].L);
  const solve = mode => {
    let sd = opts.seed ?? 1;
    const rnd = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
    const lg = [];
    for (let i = 0; i < E.length; i++) { boxes[i] = null; choice[i] = null; E[i].cost = 0; }
    if (mode === 'greedy') {
      for (const ei of order) { const { best, bc } = place(ei); choice[ei] = best; boxes[ei] = best ? best.box : null; E[ei].cost = bc; }
    } else {
      for (const ei of labelled) { choice[ei] = CAND[ei][CAND[ei].length - 1]; boxes[ei] = choice[ei].box; }
      for (const ei of labelled) E[ei].cost = cost(E[ei], ei, choice[ei]);
    }
    lg.push(`${mode} start: total cost ${Math.round(total())}, unplaceable ${labelled.filter(i => E[i].cost >= OFF).length}`);
    for (let pass = 0; pass < (mode === 'unchanged' ? 0 : passes); pass++) {
      let changed = 0;
      const ord = labelled.slice();
      for (let k = ord.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [ord[k], ord[j]] = [ord[j], ord[k]]; }
      for (const ei of ord) {
        const old = choice[ei], oldBox = boxes[ei]; boxes[ei] = null;
        const { best, bc } = place(ei);
        const oldC = old ? cost(E[ei], ei, old) : 1e9;
        if (best && bc < oldC - 0.5) { choice[ei] = best; boxes[ei] = best.box; E[ei].cost = bc; changed++; } else { boxes[ei] = oldBox; E[ei].cost = oldC; }
      }
      lg.push(`${mode} pass ${pass}: changed ${changed}, total cost ${Math.round(total())}`);
      if (!changed) break;
    }
    // repair: a label with no feasible candidate takes the engine's own box and the labels in its way are placed again
    const repaired = [];
    for (const ei of mode === 'unchanged' ? [] : labelled.filter(i => E[i].cost >= OFF)) {
      const orig = CAND[ei][CAND[ei].length - 1], bad = [];
      for (let k = 0; k < E.length; k++) if (k !== ei && boxes[k] && ov(orig.box, boxes[k], -4)) bad.push(k);
      repaired.push({ edge: E[ei].id, displaces: bad.map(k => E[k].id) });
      choice[ei] = orig; boxes[ei] = orig.box; E[ei].cost = 0;
      for (const k of bad) boxes[k] = null;
      for (const k of bad) { const { best, bc } = place(k); choice[k] = best; boxes[k] = best ? best.box : null; E[k].cost = bc; }
    }
    const bx = boxes.slice(), ms = measure(bx);
    return { mode, boxes: bx, choice: choice.slice(), costs: E.map(e => e.cost), repaired, ms, q: quality(ms.m), total: total(), log: lg };
  };
  const starts = opts.start === 'greedy' ? ['greedy'] : opts.start === 'engine' ? ['engine'] : ['engine', 'greedy'];
  const unchanged = solve('unchanged'), sols = starts.map(solve);
  let win = unchanged;
  for (const x of sols) if (x.q < win.q || (win !== unchanged && x.q === win.q && x.total < win.total - 0.5)) win = x;
  for (const x of [unchanged, ...sols]) log.push(...x.log);
  log.push('chosen start: ' + win.mode);
  boxes.splice(0, boxes.length, ...win.boxes); choice.splice(0, choice.length, ...win.choice); E.forEach((e, i) => { e.cost = win.costs[i]; });
  const after = win.ms, repaired = win.repaired;

  // ---- pins, verified through the engine's own pinned path
  const pins = {};
  E.forEach((e, ei) => {
    const c = choice[ei]; if (!c) return;
    pins[e.id] = { seg: c.si, t: c.t, ...(c.dx ? { dx: Math.round(c.dx * 10) / 10 } : {}), ...(c.dy ? { dy: Math.round(c.dy * 10) / 10 } : {}) };
  });
  const ver = engineRun(pins, { pinFirst: true, wide: true });
  const pinned = { same: 0, total: labelled.length };
  E.forEach((e, k) => { if (e.has && same(ver[k], boxes[k])) pinned.same++; });
  const vm = measure(ver);
  const geom2 = { ...geom, edges: geom.edges.map((e, k) => (e.labelBox && ver[k] ? { ...e, labelBox: { x: ver[k].x, y: ver[k].y, w: ver[k].w, h: ver[k].h } } : e)) };
  return { pins, boxes: ver, geom: geom2, better: quality(vm.m) < quality(before.m), start: win.mode, before: before.m, after: after.m, verified: vm.m, worst: vm.worst, reproduced, pinned, repaired, unplaceable: labelled.filter(i => E[i].cost >= OFF).length, log };
}

const sameFile = (a, b) => { try { const x = fs.realpathSync.native(a), y = fs.realpathSync.native(b); return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y; } catch { return false; } };
if (process.argv[1] && sameFile(process.argv[1], fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2), flag = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  if (!a[0]) { console.error('usage: labels.mjs <geom.json> [--cfg cfg.json] [--out pins.json] [--emit geom2.json] [--passes 8] [--seed 1]'); process.exit(2); }
  const geom = JSON.parse(fs.readFileSync(a[0], 'utf8')), cfg = flag('cfg', null) ? JSON.parse(fs.readFileSync(flag('cfg'), 'utf8')) : {};
  const r = optimiseLabels(geom, cfg, { passes: +flag('passes', 8), seed: +flag('seed', 1) });
  console.log(`engine reproduction: ${r.reproduced.same}/${r.reproduced.total} label boxes identical`);
  console.log('BEFORE  ', JSON.stringify(r.before)); console.log('AFTER   ', JSON.stringify(r.after)); console.log('VERIFIED', JSON.stringify(r.verified));
  console.log(`engine pinned-path verification: ${r.pinned.same}/${r.pinned.total} boxes reproduce; repaired ${r.repaired.length}; unplaceable ${r.unplaceable}`);
  for (const l of r.log) console.log(l);
  if (flag('out', null)) { fs.writeFileSync(flag('out'), JSON.stringify(r.pins)); console.log('wrote', flag('out'), Object.keys(r.pins).length, 'pins'); }
  if (flag('emit', null)) { fs.writeFileSync(flag('emit'), JSON.stringify(r.geom)); console.log('wrote', flag('emit')); }
}
