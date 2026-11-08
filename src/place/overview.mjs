// placeOverview: the overview is the first thing a person sees, so it should read in story order, stage 1 near the top left. Forcing stages onto a
// grid costs far too much (several times the crossings). Starting the search from story order costs nothing: the placer treats all the stages
// in order as its spine, and we keep the best of a few seeds. The chart's real main path is put back afterwards, so the page still highlights only that.
//   readsInOrder(map, ids) -> -1..1     Spearman rank correlation between the ids' order and their reading position (rows first). 1 = perfect, 0 = random
//   placeOverview(chart, { spine, seed, budgetMs, cfg, measure }) -> Promise<cfg>    chart.boxes with synth === 'stage' are the stages, in story order
//     measure(cfg) -> Promise<{crossings, hard}>: the caller's real measurement of a config, as drawn on the page (hard = number of hard problems)
import { placeChart } from './chart.mjs';
import { ASPECT, FIT } from './objective.mjs';

const SEEDS = 3, ORDER_WEIGHT = 40;
// The poster is the first picture of the system and it opens on a landscape window: a tall one is made small by the window's height and leaves a third of the width empty.
// While the overview is placed the shape bar is the poster's own (about 1.6 to 2.2: it takes up at least 80% of a wide canvas), and a placement under it pays in the choice between seeds.
const POSTER_BAR = { lo: 1.7, hi: 2.2, barLo: 1.6, barHi: 2.4 }, ASPECT_WEIGHT = 120;
const aspectCost = (a) => (a < POSTER_BAR.barLo ? (POSTER_BAR.barLo - a) * ASPECT_WEIGHT : 0);      // one point of order is worth 40 crossings; the toy overview has order 1 and no crossings, a bigger one trades the two

export function readsInOrder(map, ids) {
  const pos = new Map();
  map.forEach((row, r) => row.trim().split(/\s+/).forEach((t, c) => { if (t !== '.') pos.set(t, [r, c]); }));
  const on = ids.filter((id) => pos.has(id)), n = on.length;
  if (n < 2) return 1;
  const rank = new Map(on.slice().sort((a, b) => pos.get(a)[0] - pos.get(b)[0] || pos.get(a)[1] - pos.get(b)[1]).map((id, i) => [id, i]));
  let d = 0;
  on.forEach((id, i) => { d += (rank.get(id) - i) ** 2; });
  return 1 - (6 * d) / (n * (n * n - 1));
}

export async function placeOverview(chart, opts = {}) {
  const { spine = null, seed = 1, budgetMs = 4000, cfg: extra, measure, log = () => {} } = opts;
  const stages = chart.boxes.filter((b) => b.synth === 'stage').map((b) => b.id);
  const graph = { id: chart.id, title: chart.title, nodes: chart.boxes, edges: chart.routes };
  let best = null;
  const saved = { ...ASPECT }, savedFit = { ...FIT };
  Object.assign(ASPECT, POSTER_BAR); FIT.weight = 0;                              // the poster is not held to the stage charts' fit scale
  try {
    for (let s = seed; s < seed + SEEDS; s++) {
      const placed = await placeChart(graph, { spine: stages.length > 1 ? stages : spine, seed: s, budgetMs, cfg: extra });
      const cfg = { ...placed, spine: spine || [] };                                // the placer's story spine was only a starting point
      if (placed.__stats) Object.defineProperty(cfg, '__stats', { value: placed.__stats, enumerable: false });
      const m = await measure(cfg), cost = m.hard * 1000 + m.crossings + (1 - readsInOrder(cfg.map, stages)) * ORDER_WEIGHT + aspectCost(m.aspect || 0);
      if (!best || cost < best.cost) best = { cfg, cost };
      log(`seed ${s - seed + 1} of ${SEEDS} tried: ${m.crossings} crossings${m.aspect ? `, aspect ${m.aspect}` : ''}${m.hard ? `, ${m.hard} hard` : ''}`);   // the poster takes a while: a line per try
    }
  } finally { Object.assign(ASPECT, saved); Object.assign(FIT, savedFit); }
  return best.cfg;
}
