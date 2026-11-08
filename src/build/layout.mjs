// Layout for every chart: placement (src/place) writes layout/<chartId>.json, geometry (src/engine) is cached beside it.
//   placeProject(dir, model, charts, {only, force, seed, budgetSeconds, tiled, classic, log}) -> [{id, action, ms, hard, summary}]   writes layout/*.json and *.geom.json
//   loadLayouts(dir, model, charts) -> {geoms, cfgs, metrics, stale:[ids], missing:[ids]}     reads the cache; geometry is recomputed only if its key changed
// layout/<id>.json is {"_faultline":{tool,key,seed},...gridLayout config}. The key covers only the SHAPE of the chart (ids, kinds, routes, stage,
// main path): a changed title re-measures the box but keeps the placement. A file without "_faultline" is a hand override and is never replaced.
// The whole map of a big system is not a gridLayout config at all: {"_faultline":{...},"tiled":{version,seed,pitch}}. Its geometry is composed from the
// stage chart parts (src/place/tiled.mjs), so it depends on THEIR geometry and is rebuilt (seconds) whenever one of them changes.
// layout/<id>.geom.json is {key, geom, metrics, mv}: the metrics are stored with the geometry and reused while the key and the metrics version match.
//   tiled: true forces the tiled whole map, classic: true forces placeWhole; otherwise a whole above TILED_ABOVE boxes or routes is tiled.
import path from 'node:path';
import { gridLayout, metrics } from '../engine/index.mjs';
import { placeChart, placeWhole, placeOverview, composeTiled, useTiled, TILED_VERSION } from '../place/index.mjs';
import { readJson, writeJson } from './project.mjs';
import { hashOf, mainPath } from './util.mjs';

export const layoutPath = (dir, id) => path.join(dir, 'layout', id + '.json');
const geomPath = (dir, id) => path.join(dir, 'layout', id + '.geom.json');
export const HARD = ['nodeOverlaps', 'edgeThroughNode', 'trackOverlaps', 'labelOverlapsLabel', 'labelOverlapsNode', 'diagonalSegs', 'shortArrowStubs', 'labelMissing'];
const SEED_TRIES = 5;
export const METRICS_V = 2;   // bump when metrics() changes a number: stored metrics from an older version are recomputed

export function engineGraphOf(chart) {
  return {
    id: chart.id, title: chart.title,
    nodes: chart.boxes.map((b) => ({ id: b.id, title: b.title, kind: b.kind || 'step', ...(b.handle ? { handle: b.handle } : {}), family: b.stage || '' })),
    edges: chart.routes.map((r) => ({ id: r.id, from: r.from, to: r.to, type: r.type || 'forward', label: r.when || '', ...(r.inferred ? { inferred: true } : {}) })),
  };
}
// the shape key: what the placement depends on
const spineOf = (chart, model) => (chart.spine && chart.spine.length ? chart.spine : mainPath(model).filter((id) => chart.boxes.some((b) => b.id === id)));
export function shapeKey(chart, model) {
  const spine = spineOf(chart, model);
  return hashOf({ k: chart.kind, n: chart.boxes.map((b) => [b.id, b.kind, b.stage || '']), e: chart.routes.map((r) => [r.id, r.from, r.to, r.type]), s: spine, st: chart.kind === 'whole' ? (model.stages || []).map((s) => [s.id, s.order]) : 0 });
}
// The overview is a poster (docs/DESIGN_BARS.md, whole-system view): box text at twice the size (the channels keep their width, labels live in them), so every stage name reads at 13 px or more at
// fit on a 1920 x 1080 window. It is applied when the overview's geometry is built, so a saved placement needs no re-place; cfg.textScale (or cfg.gapX ...
// in the file) overrides. The boxes are measured for the bigger text and the geometry carries nodeFont for the renderer.
export const POSTER = { textScale: 2, nodeMaxChars: 17 };
// The bigger the text the less room the labels have in the channels: the scale steps down (1.5, 1.4 ... 1) until every hard metric is 0, so the page never loses the gate to its own poster.
export function posterCfg(chart, cfg, k0) {
  if (chart.kind !== 'overview') return cfg;
  const k = k0 || cfg.textScale || POSTER.textScale;
  return { ...cfg, textScale: k, nodeMaxChars: k > 1 ? POSTER.nodeMaxChars : cfg.nodeMaxChars, glyph: { node: 7.9 * k, edge: 6.9 }, lineH: 19 * k, minNodeW: 150 * (1 + (k - 1) * 0.6), ...(cfg.poster || {}) };
}
const buildGeom = async (chart, cfg) => {
  if (chart.kind !== 'overview') return gridLayout(engineGraphOf(chart), cfg);
  const want = posterCfg(chart, cfg).textScale;
  for (const k of [want, 1.8, 1.6, 1.5, 1.4, 1.3, 1.2, 1.1, 1].filter((x, i) => i === 0 || x < want)) {
    const c = posterCfg(chart, cfg, k), g = await gridLayout(engineGraphOf(chart), c);
    if (k === 1 || !HARD.some((h) => metrics(g)[h] > 0)) return k > 1 ? { ...g, nodeFont: Math.round(15 * k * 10) / 10 } : g;
  }
};
export const geomKey = (chart, cfg) => hashOf({ g: engineGraphOf(chart), c: posterCfg(chart, cfg) });
// the tiled whole's key: its own settings, the whole chart's shape, and the key of every stage part it is made of
export const tiledKey = (chart, model, t, partKeys) => hashOf({ v: TILED_VERSION, t, s: shapeKey(chart, model), p: partKeys });
const stripMark = (raw) => { const { _faultline, ...cfg } = raw || {}; return cfg; };

const BUDGET = { overview: 4, stage: 12, detail: 12, whole: 60 };   // seconds of placement search per chart; router time is extra

function record(rec, m) {
  const hard = HARD.filter((k) => m[k] > 0);
  return { ...rec, hard, crossings: m.crossings, aspect: m.aspect,
    summary: `crossings ${m.crossings}, aspect ${m.aspect}` + (hard.length ? ', HARD ' + hard.map((k) => k + '=' + m[k]).join(' ') : ', hard metrics 0') };
}
async function settle(dir, chart, cfg, rec) {
  const geom = await buildGeom(chart, cfg), m = metrics(geom);
  writeJson(geomPath(dir, chart.id), { key: geomKey(chart, cfg), geom, metrics: m, mv: METRICS_V }, { pretty: false });
  return record(rec, m);
}
const stageCharts = (charts) => charts.filter((c) => c.kind === 'stage');

// the tiled whole: composed from the stage parts' saved geometry
function tiledGeom(model, charts, geoms, t, log) { return composeTiled(model, charts, geoms, { seed: t.seed, pitch: t.pitch, log }); }

export async function placeProject(dir, model, charts, opts = {}) {
  const { only = null, force = false, seed = 1, log = () => {} } = opts, out = [];
  for (const chart of charts) {
    if (only && !only.includes(chart.id)) continue;
    const file = layoutPath(dir, chart.id), cur = readJson(file), key = shapeKey(chart, model);
    const wantTiled = chart.kind === 'whole' && (opts.tiled || (!opts.classic && useTiled(chart)));
    const isTiled = !!(cur && cur.tiled);
    if (cur && !cur._faultline) { log(`${chart.id}: hand-written layout kept`); out.push(await settle(dir, chart, stripMark(cur), { id: chart.id, action: 'override' })); continue; }
    if (cur && cur._faultline.key === key && !force && (chart.kind !== 'whole' || isTiled === wantTiled)) {
      if (isTiled) { out.push({ id: chart.id, action: 'kept', hard: [], summary: 'tiled layout is current (rebuilt from the stage parts when they change)' }); continue; }
      log(`${chart.id}: layout is current`); out.push(await settle(dir, chart, stripMark(cur), { id: chart.id, action: 'kept' })); continue;
    }
    const t0 = Date.now();
    if (wantTiled) {
      log(`${chart.id}: tiling ${chart.boxes.length} boxes, ${chart.routes.length} routes from the stage parts ...`);
      let L = await loadLayouts(dir, model, stageCharts(charts)), bad = [...L.missing, ...L.stale];
      if (bad.length) {                                                          // a part with no current layout is placed first (seconds), never an error
        log(`${chart.id}: placing ${bad.length} stage chart(s) it is made of first (${bad.slice(0, 4).join(', ')}${bad.length > 4 ? ', ...' : ''})`);
        try { await placeProject(dir, model, charts, { ...opts, only: bad, tiled: false, classic: false, force: false }); L = await loadLayouts(dir, model, stageCharts(charts)); bad = [...L.missing, ...L.stale]; }
        catch (e) { log(`${chart.id}: could not place them: ${String(e.message || e).split('\n')[0]}`); }
      }
      if (bad.length) { log(`${chart.id}: not tiled, ${bad.length} stage chart(s) have no current layout (${bad.slice(0, 4).join(', ')})`); out.push({ id: chart.id, action: 'skipped', hard: [], capped: false, summary: `${bad.length} stage chart(s) are not placed yet` }); continue; }
      const t = { version: TILED_VERSION, seed, pitch: opts.pitch || null };      // null: the composer picks it (4 above 1000 routes, else 7, stepping down if the map leaves the aspect bar)
      const g = tiledGeom(model, charts, L.geoms, t, log).geom, m = metrics(g);
      writeJson(file, { _faultline: { tool: 'place', key, seed, boxes: chart.boxes.length }, tiled: t });
      writeJson(geomPath(dir, chart.id), { key: tiledKey(chart, model, t, L.keys), geom: g, metrics: m, mv: METRICS_V }, { pretty: false });
      const rec = record({ id: chart.id, action: 'tiled', ms: Date.now() - t0, capped: false }, m);
      log(`${chart.id}: ${rec.summary} (${Math.round(rec.ms / 1000)} s)`); out.push(rec); continue;
    }
    const budgetMs = (opts.budgetSeconds || BUDGET[chart.kind] || 12) * 1000;
    log(`${chart.id}: placing ${chart.boxes.length} boxes, ${chart.routes.length} routes ...`);
    const spine = spineOf(chart, model);
    // a hard problem on one seed usually clears on another, so try a few before reporting it (the classic whole is too slow to retry)
    const tries = chart.kind === 'whole' ? 1 : SEED_TRIES;
    let rec = null, best = null;
    for (let s = seed; s < seed + tries; s++) {
      const measure = async (c) => { const m = metrics(await gridLayout(engineGraphOf(chart), posterCfg(chart, c))); return { crossings: m.crossings, aspect: m.aspect, hard: HARD.reduce((n, k) => n + (m[k] > 0 ? m[k] : 0), 0) }; };
      const cfg = chart.kind === 'whole' ? await placeWhole(model, charts, { seed: s, budgetMs })
        : chart.kind === 'overview' ? await placeOverview(chart, { spine: spine.length > 1 ? spine : null, seed: s, budgetMs, cfg: posterCfg(chart, {}), measure, log: (m) => log(`${chart.id}: ${m}`) })   // placed for its poster text size, in story order
          : await placeChart({ id: chart.id, title: chart.title, nodes: chart.boxes, edges: chart.routes }, { spine: spine.length > 1 ? spine : null, seed: s, budgetMs });
      const capped = !!(cfg.__stats && cfg.__stats.capped);
      const plain = JSON.parse(JSON.stringify(cfg));
      writeJson(file, { _faultline: { tool: 'place', key, seed: s, boxes: chart.boxes.length, ...(capped ? { capped: true } : {}) }, ...plain });
      rec = await settle(dir, chart, plain, { id: chart.id, action: 'placed', ms: Date.now() - t0, capped });
      if (!best || rec.hard.length < best.rec.hard.length) best = { s, plain, capped, rec };
      if (!rec.hard.length) break;
      if (s + 1 < seed + tries) log(`${chart.id}: seed ${s} leaves ${rec.hard.join(', ')}, trying seed ${s + 1}`);
    }
    if (best.rec !== rec) {                                                       // the last seed was not the best: put the best one back
      writeJson(file, { _faultline: { tool: 'place', key, seed: best.s, boxes: chart.boxes.length, ...(best.capped ? { capped: true } : {}) }, ...best.plain });
      rec = await settle(dir, chart, best.plain, { id: chart.id, action: 'placed', ms: Date.now() - t0, capped: best.capped });
    }
    log(`${chart.id}: ${rec.summary} (${Math.round(rec.ms / 1000)} s)`);
    out.push(rec);
  }
  return out;
}

// cached layout and geometry that still match the model. A stale or missing chart is listed, not placed. The tiled whole is rebuilt from the stage parts.
export async function loadLayouts(dir, model, charts) {
  const geoms = {}, cfgs = {}, ms = {}, keys = {}, stale = [], missing = [];
  const save = (id, key, geom, m) => writeJson(geomPath(dir, id), { key, geom, metrics: m, mv: METRICS_V }, { pretty: false });
  for (const chart of charts) {
    const raw = readJson(layoutPath(dir, chart.id));
    if (!raw) { missing.push(chart.id); continue; }
    const cfg = stripMark(raw);
    if (raw._faultline && raw._faultline.key !== shapeKey(chart, model)) { stale.push(chart.id); continue; }
    const cached = readJson(geomPath(dir, chart.id));
    let geom = null, key;
    if (raw.tiled) {
      const parts = stageCharts(charts);
      if (parts.some((c) => !geoms[c.id])) { stale.push(chart.id); continue; }
      key = tiledKey(chart, model, raw.tiled, Object.fromEntries(parts.map((c) => [c.id, keys[c.id]])));
      geom = cached && cached.key === key ? cached.geom : null;
      if (!geom) {
        try { geom = tiledGeom(model, charts, geoms, raw.tiled).geom; save(chart.id, key, geom, metrics(geom)); }
        catch (e) { stale.push(chart.id); continue; }
      }
    } else {
      key = geomKey(chart, cfg);
      geom = cached && cached.key === key ? cached.geom : null;
      if (!geom) {
        try { geom = await buildGeom(chart, cfg); save(chart.id, key, geom, metrics(geom)); }
        catch (e) { stale.push(chart.id); continue; }
      }
    }
    let m = cached && cached.key === key && cached.mv === METRICS_V ? cached.metrics : null;
    if (!m) { m = metrics(geom); save(chart.id, key, geom, m); }
    cfgs[chart.id] = cfg; geoms[chart.id] = geom; ms[chart.id] = m; keys[chart.id] = key;
  }
  return { geoms, cfgs, metrics: ms, keys, stale, missing };
}
