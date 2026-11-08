// placeWhole: the whole-system map. Every stage is placed as its own band (placeChart), stage blocks are arranged by how strongly they link
// (arrangeBlocks: stage order is a strong snake prior, broken only where a swap saves a lot), bands are composed into one grid of slots (a block narrower or lower than its slot is spread over it) with wide streets between blocks, long cross-stage routes get street paths (outer margins
// only for the very longest), channels are sized automatically, the final route uses a high crossing penalty, and labels go through the
// global optimiser. Any number of stages; names and colours are never assumed (tones are generated).
//
//   placeWhole(model, charts, { seed = 1, budgetMs = 120000, engine, crossingPenalty = 450, repairs = 3, maxRoutes = 7, pull = false, noLabels, log, cfg, bandCache, streetCols, streetRows }) -> Promise<cfg>
// budgetMs bounds the SEARCH (bands, arrangement, sizing). Final routes are extra and not clocked: one can take far longer than the search on a dense map;
// repairs and the street-variant fallback are capped by maxRoutes real routes (deterministic: nothing here reads a clock).
// cfg = extra engine options for bands and whole (e.g. { nodeMaxChars: 16 }); bandCache = {} (harness: filled with the placed bands on the first run, reused after).
// model = faultline.model/1 (stages, boxes, routes, paths). charts = chartsFromModel output or null; a chart of kind "whole" narrows boxes/routes.
import { placeChart } from './chart.mjs';
import { normalizeChart, engineGraph } from './graph.mjs';
import { arrangeBlocks } from './macro.mjs';
import { composeWhole } from './compose.mjs';
import { planStreets } from './streets.mjs';
import { loadEngine, hardCount, hardOf, emptyLabelFill, fillLabels } from './engine.mjs';
import { score } from './objective.mjs';

const W_TYPE = { forward: 1, deliver: 0.8, record: 0.5, return: 0.4 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export async function placeWhole(model, charts = null, opts = {}) {
  const { seed = 1, budgetMs = 120000, engine, log = () => {}, crossingPenalty = 450, gapX = 150, gapY = 84 } = opts;
  const t0 = performance.now(), E = await loadEngine(engine), stats = { bands: 0, ms: {}, fastRoutes: 0, realRoutes: 0 };
  const lap = k => { stats.ms[k] = Math.round(performance.now() - t0); };

  // ---------------------------------------------------------------- 1. data: boxes, routes, stages in order
  const whole = (charts || []).find(c => c.kind === 'whole');
  const pickIds = (list, all) => { if (!list?.length) return all; const idOf = x => (typeof x === 'string' ? x : x.id); const keep = new Set(list.map(idOf)); return all.filter(x => keep.has(x.id)); };
  const boxes = pickIds(whole?.boxes, model.boxes || []);
  const have = new Set(boxes.map(b => b.id));
  const routes = pickIds(whole?.routes, model.routes || []).filter(r => have.has(r.from) && have.has(r.to));
  let stages = (model.stages || []).slice().sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
  const known = new Set(stages.map(s => s.id));
  if (boxes.some(b => !known.has(b.stage))) stages.push({ id: '_unstaged', title: 'Unstaged', order: 1e9 });
  const stageOfBox = Object.fromEntries(boxes.map(b => [b.id, known.has(b.stage) ? b.stage : '_unstaged']));
  stages = stages.filter(s => boxes.some(b => stageOfBox[b.id] === s.id));
  if (!stages.length) throw new Error('placeWhole: no boxes');
  const graph = normalizeChart({ id: 'whole', title: model.system?.name || 'Whole system', nodes: boxes, edges: routes });
  const eg = fillLabels(engineGraph(graph), await emptyLabelFill(E));
  const spineAll = model.paths?.[0]?.boxes || null;
  const nB = boxes.length, nR = routes.length;

  // ---------------------------------------------------------------- 2. one band per stage (pass 1: shape and size; pass 2 re-places each band with a pull toward the neighbours it talks to)
  const sizeOf = s => { const n = boxes.filter(b => stageOfBox[b.id] === s.id).length; return n + 0.5 * routes.filter(r => stageOfBox[r.from] === s.id && stageOfBox[r.to] === s.id).length; };
  const totalSize = stages.reduce((s, st) => s + sizeOf(st), 0);
  const placeBands = async (share, pass, pull) => {
    const out = {};
    for (const [i, s] of stages.entries()) {
      const nodes = boxes.filter(b => stageOfBox[b.id] === s.id), ids = new Set(nodes.map(n => n.id));
      const edges = routes.filter(r => ids.has(r.from) && ids.has(r.to));
      const spine = spineAll ? spineAll.filter(id => ids.has(id)) : null;
      const b = clamp(Math.round(budgetMs * share * sizeOf(s) / totalSize), 1000, 20000);
      out[s.id] = await placeChart({ id: s.id, title: s.title, nodes, edges }, { seed: seed * 101 + i + pass * 7919, budgetMs: b, engine, spine: spine?.length > 1 ? spine : null, gapX, gapY, crossingPenalty: 200, pull, cfg: opts.cfg });
      stats.bands++;
    }
    return out;
  };
  let bands = opts.bandCache?.bands || await placeBands(opts.pull ? 0.12 : 0.45, 0, null);
  if (opts.bandCache) opts.bandCache.bands = bands;
  lap('bands1');

  // ---------------------------------------------------------------- 3. arrange the blocks by link strength; judge the few best block-grid shapes by a fast routed score
  const blocks = stages.map((s, i) => {
    const rows = bands[s.id].map.map(r => r.trim().split(/\s+/)), nodes = [];
    rows.forEach((row, r) => row.forEach((t, c) => { if (t !== '.') nodes.push({ id: t, c, r }); }));
    return { id: s.id, w: Math.max(...rows.map(r => r.length)), h: rows.length, nodes, order: i };
  });
  const crossRoutes = routes.filter(r => stageOfBox[r.from] !== stageOfBox[r.to]);
  const links = crossRoutes.map(r => ({ a: r.from, b: r.to, w: W_TYPE[r.type] ?? 0.8 }));
  const sizeProbe = async () => {                  // real box sizes from one fast layout of a plain snake (sizes do not depend on the arrangement)
    const plain = arrangeBlocks(blocks, links, { seed });
    const comp0 = composeWhole({ stages, bands, arrangement: plain, base: { gapX, gapY, nodeMaxChars: 22, edgeMaxChars: 20, ...(opts.cfg || {}), route: { crossingPenalty: 0 } } });
    const g0 = await E.gridLayout(eg, comp0.cfg), nsz = {};
    for (const n of g0.nodes) nsz[n.id] = [n.w, n.h];
    return nsz;
  };
  const nsz = await sizeProbe();
  const arrangement = arrangeBlocks(blocks, links, { seed, nsz, gapX, gapY });
  lap('macro'); log('macro', arrangement.GC + 'x' + arrangement.GR, 'cost', arrangement.cost.toFixed(3), 'asp', arrangement.asp?.toFixed(2), JSON.stringify(arrangement.snake), 'alternatives', arrangement.alternatives.map(a => a.snake.rows + ':' + a.cost.toFixed(3)).join(' '));

  const base = { gapX, gapY, nodeMaxChars: 22, edgeMaxChars: 20, ...(opts.cfg || {}), spine: (spineAll || []).filter(id => have.has(id)), route: { crossingPenalty, ...(nR > 1500 ? { shards: 'groups' } : {}), ...(opts.route || {}) } };   // one router for the final route up to ~1500 routes; sharded routers cannot see each other's tracks
  const sizeIt = async c => { const ac = await E.autoChannels(eg, c, { iters: 8, penalty: 0 }); stats.fastRoutes += ac.history?.length || 1; if (!ac.geom) ac.geom = await E.gridLayout(eg, { ...ac.cfg, route: { ...(ac.cfg.route || {}), crossingPenalty: 0 } }); return ac; };
  const fastScore = ac => (ac.geom ? score(E.metrics(ac.geom)) : 1e12);
  const trial = async (bandSet, arr) => { const comp = composeWhole({ stages, bands: bandSet, arrangement: arr, base, streetCols: opts.streetCols, streetRows: opts.streetRows }), sized = await sizeIt(comp.cfg), asp = E.metrics(sized.geom).aspect; return { comp, sized, sc: fastScore(sized), arr, key: fastScore(sized) + Math.max(0, 1.3 - asp, asp - 2.2) * 3000 }; };
  const better = (a, b) => !b || a.key < b.key;          // fast score plus 3000 per unit of aspect outside the 1.3..2.2 bar: a shape outside it must be much better elsewhere
  let best = null;
  for (const arr of [arrangement, ...arrangement.alternatives]) {
    const t = await trial(bands, arr); log('shape', arr.GC + 'x' + arr.GR, 'fast score', Math.round(t.sc), 'aspect', E.metrics(t.sized.geom).aspect);
    if (better(t, best)) best = t;
  }
  // optional pass 2 (opts.pull = true): re-place every band with a pull toward the blocks its routes lead to (mirrors dropped: the pull orients the bands itself); kept only if it routes better.
  // Off by default: on the toy, a large synthetic map and a dense map it was never kept, and costs about a third of the band budget.
  const pull = {};
  for (const r of crossRoutes) {
    const sa = stageOfBox[r.from], sb = stageOfBox[r.to], [c1, r1] = best.arr.cell[sa], [c2, r2] = best.arr.cell[sb], dx = c2 - c1, dy = r2 - r1;
    const add = (id, side, w) => { const l = (pull[id] ||= []); const e = l.find(x => x.side === side); if (e) e.w += w; else l.push({ side, w }); };
    const wgt = 1 / (1 + 0.15 * (Math.abs(dx) + Math.abs(dy)));
    const sides = (dxx, dyy) => { const o = []; if (dxx) o.push(dxx > 0 ? 'E' : 'W'); if (dyy) o.push(dyy > 0 ? 'S' : 'N'); return o; };
    const ss = sides(dx, dy); if (!ss.length) continue;
    for (const s of ss) add(r.from, s, wgt / ss.length);
    for (const s of sides(-dx, -dy)) add(r.to, s, wgt / ss.length);
  }
  for (const id of Object.keys(pull)) { const tot = pull[id].reduce((s, x) => s + x.w, 0); pull[id].forEach(x => { x.w = Math.min(1.5, x.w / Math.max(1, tot) * Math.min(2, tot) + 0.2); }); }
  if (opts.pull) {
  const bands2 = await placeBands(0.4, 1, pull);
  const noFlip = { ...best.arr, fh: Object.fromEntries(stages.map(s => [s.id, false])), fv: Object.fromEntries(stages.map(s => [s.id, false])) };
  const t2 = await trial(bands2, noFlip);
  log('pull pass', 'fast score', Math.round(t2.sc), 'vs', Math.round(best.sc));
  stats.pullKept = better(t2, best); if (stats.pullKept) { best = t2; bands = bands2; }
  }
  lap('bands'); log('bands', stats.bands, stats.ms.bands + 'ms');

  // ---------------------------------------------------------------- 4. streets for the long routes (outer margins only for the very longest), channel sizing
  const comp = best.comp;
  let cfg = best.sized.cfg;
  const pos = {}; comp.cfg.map.forEach((row, r) => row.split(' ').forEach((t, c) => { if (t !== '.') pos[t] = [c, r]; }));
  const bd = (a, b) => { const p = comp.blockOf[stageOfBox[a]], q = comp.blockOf[stageOfBox[b]]; return Math.abs(p.gc - q.gc) + Math.abs(p.gr - q.gr); };
  const far = crossRoutes.filter(r => bd(r.from, r.to) >= 2 && !(comp.cfg.ports && comp.cfg.ports[r.id]));
  const veryLong = Math.max(3, comp.macro.GC + comp.macro.GR - 2);
  let usedStreets = false;
  const plainCfg = best.sized.cfg;
  if (far.length) {
    const pl = planStreets({ pos, stageOf: stageOfBox, blockOf: comp.blockOf, extents: comp.extents, macro: comp.macro, edges: far, opts: { seed, margins: e => bd(e.from, e.to) >= veryLong } });
    log('streets', pl.info.planned, 'planned, model crossings', pl.info.modelCrossingsBeforeSA, '->', pl.info.modelCrossings);
    // a lane offset is an exact checkpoint in pixels: every street that carries lanes is made wider than twice its widest offset, so no checkpoint can land inside a box
    const wide = { ...comp.cfg, via: pl.via, ports: { ...(comp.cfg.ports || {}), ...pl.ports }, viaMode: 'channel', colGap: { ...comp.cfg.colGap }, rowGap: { ...comp.cfg.rowGap } }, mc = comp.macro;
    for (const [k, off] of Object.entries(pl.info.need)) {
      const axis = k[0], i = +k.slice(1);
      if (axis === 'x' && i >= 1 && i <= mc.GC - 1) { const col = mc.colOff[i - 1] + mc.colW[i - 1] - 1; wide.colGap[col] = Math.max(wide.colGap[col] || 0, Math.ceil(2 * off + 80)); }
      if (axis === 'y' && i >= 1 && i <= mc.GR - 1) { const row = mc.rowOff[i - 1] + mc.rowH[i - 1] - 1; wide.rowGap[row] = Math.max(wide.rowGap[row] || 0, Math.ceil(2 * off + 80)); }
    }
    const withStreets = await sizeIt(wide);
    const asp = E.metrics(withStreets.geom).aspect, ws = { ...best, sized: withStreets, sc: fastScore(withStreets), key: fastScore(withStreets) + Math.max(0, 1.3 - asp, asp - 2.2) * 3000 };
    if (better(ws, best)) { cfg = withStreets.cfg; usedStreets = true; best = ws; }
  }
  lap('sized'); log('sized', usedStreets ? 'with streets' : 'plain', 'fast score', Math.round(best.sc));

  // ---------------------------------------------------------------- 5. real route with the high crossing penalty, hard-metric repair
  let geom = await E.gridLayout(eg, cfg), m = E.metrics(geom); stats.realRoutes++;
  const maxRepair = opts.repairs ?? 3, maxRoutes = opts.maxRoutes ?? 7;     // a real route costs 10 s to 95 s (dense charts): repairs and the fallback are counted in routes, not time
  // one repair step: pass 0 widens the overloaded channels the report names; later passes also space the tracks wider (route.nudge) and re-size every channel for the new pitch
  const repairStep = async (c, g, pass) => {
    const rep = E.channelReport ? E.channelReport(g, { pitch: c.route?.nudge ?? 14, buf: c.route?.shapeBuffer ?? 16 }).filter(r => r.deficit > 0) : [];
    let out = { ...c, colGap: { ...c.colGap }, rowGap: { ...c.rowGap } };
    if (rep.length) for (const r of rep) { const mp = r.axis === 'col' ? out.colGap : out.rowGap; mp[r.after] = (mp[r.after] || 0) + Math.ceil(r.deficit * 1.3); }
    else if (pass === 0) { out.gapX = Math.round(out.gapX * 1.12); out.gapY = Math.round(out.gapY * 1.12); }
    if (pass >= 1) { const ac = await E.autoChannels(eg, { ...out, route: { ...out.route, nudge: (out.route?.nudge ?? 14) + 6 * pass } }, { iters: 5, penalty: 0 }); stats.fastRoutes += ac.history?.length || 1; out = ac.cfg; }
    return out;
  };
  for (let pass = 0; pass < maxRepair && hardCount(m) > 0 && stats.realRoutes < maxRoutes; pass++) {
    cfg = await repairStep(cfg, geom, pass);
    geom = await E.gridLayout(eg, cfg); m = E.metrics(geom); stats.realRoutes++;
    log('repair', pass, JSON.stringify(hardOf(m)));
  }
  if (hardCount(m) > 0 && usedStreets && stats.realRoutes < maxRoutes) {          // street checkpoints are the usual cause: fall back to the plain variant
    log('fallback to the plain variant, hard', JSON.stringify(hardOf(m)));
    cfg = plainCfg; geom = await E.gridLayout(eg, cfg); m = E.metrics(geom); stats.realRoutes++; stats.fellBack = true;
    for (let pass = 0; pass < maxRepair && hardCount(m) > 0 && stats.realRoutes < maxRoutes; pass++) {
      cfg = await repairStep(cfg, geom, pass);
      geom = await E.gridLayout(eg, cfg); m = E.metrics(geom); stats.realRoutes++;
      log('repair (plain)', pass, JSON.stringify(hardOf(m)));
    }
  }
  lap('routed');

  // ---------------------------------------------------------------- 6. labels: the engine's global optimiser, pinned; adopted only when it is better and no hard metric gets worse
  if (!opts.noLabels && E.optimiseLabels) {
    const r = E.optimiseLabels(geom, cfg, { passes: 6, seed });
    stats.labels = { better: r.better, before: r.before, after: r.after, reproduced: r.reproduced, pinned: r.pinned };
    // routes do not depend on labels, and the optimiser verifies its pins against the engine's own placement, so no second full route is needed
    const sameAll = x => x && x.same === x.total;
    if (r.better && sameAll(r.pinned) && r.geom) {
      const m2 = E.metrics(r.geom);
      log('labels', 'hard', hardCount(m), '->', hardCount(m2));
      if (hardCount(m2) <= hardCount(m)) { cfg = E.withPins(cfg, r.pins); geom = r.geom; m = m2; }
    }
  }
  lap('labels');
  stats.metrics = { crossings: m.crossings, bends: m.bends, longestEdge: m.longestEdge, aspect: m.aspect, size: m.size, fitScale: m.fitScale, hard: hardOf(m) };
  stats.usedStreets = usedStreets; stats.boxes = nB; stats.routes = nR; stats.stages = stages.length; stats.totalMs = Math.round(performance.now() - t0);
  Object.defineProperty(cfg, '__stats', { value: stats, enumerable: false });
  return cfg;
}
