// The engine's public surface (CONTRACTS section 11) plus the helpers the rest of the code uses.
//   gridLayout(graph, cfg) -> Promise<geom>      metrics(geom, cfg?) -> {size, aspect, crossings, ...hard metrics, fitScale, minTextPx, score, issues}
//   autoChannels(graph, cfg, {iters, penalty}) -> Promise<{cfg, history, geom}>      renderSVG(geom, opts) -> string
export { gridLayout, parseMap, placeLabels } from './gridlayout.mjs';
export { metrics, FIT_VIEWPORT, LEGACY_FIT_VIEWPORT } from './metrics.mjs';
export { autoChannels } from './autochannels.mjs';
export { channelReport } from './channels.mjs';
export { renderSVG, edgePath, chipLayout, chipFamilies, portalMap, portalLayout, KIND, EDGE, CHIP_PALETTE, BASE_CSS } from './render.mjs';
export { optimiseLabels, withPins, quality } from './labels.mjs';
export { wrapText, wrapLabel, balanceLines, glyphs, GLYPH, FONT } from './layout.mjs';
export { findChromium, previewChart, shoot, chartCss } from './preview.mjs';
export { describeChart } from './show-chart.mjs';
