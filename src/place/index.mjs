// src/place: the placer. CONTRACTS section 11.
//   placeChart(chartGraph, { spine, seed, budgetMs }) -> Promise<cfg>     one chart: a gridLayout config
//   placeWhole(model, charts, { seed, budgetMs })      -> Promise<cfg>     all stages composed into one gridLayout config (up to TILED_ABOVE)
//   composeTiled(model, charts, geoms, { pitch })      -> { geom, stats }   the whole map of a big system, composed from the stage parts' geometry
export { placeChart } from './chart.mjs';
export { placeOverview, readsInOrder } from './overview.mjs';
export { placeWhole } from './whole.mjs';
export { composeTiled, useTiled, TILED_ABOVE, TILED_VERSION } from './tiled.mjs';
export { stageTone } from './compose.mjs';
