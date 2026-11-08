// The placer talks to the engine only through CONTRACTS section 11: gridLayout, metrics, autoChannels (+ channelReport for the final widening).
// Callers may inject their own copy ({gridLayout, metrics, autoChannels, channelReport, optimiseLabels?, withPins?}) as options.engine; tests and benchmarks do.
let cached = null;

export async function loadEngine(override = null) {
  if (override) return override;
  if (cached) return cached;
  try {
    const [g, m, a, c, l] = await Promise.all([import('../engine/gridlayout.mjs'), import('../engine/metrics.mjs'), import('../engine/autochannels.mjs'), import('../engine/channels.mjs'), import('../engine/labels.mjs').catch(() => ({}))]);
    cached = { gridLayout: g.gridLayout, metrics: m.metrics, autoChannels: a.autoChannels, channelReport: c.channelReport, optimiseLabels: l.optimiseLabels, withPins: l.withPins };
  } catch (e) {
    throw new Error('place: cannot load src/engine (' + e.message.split('\n')[0] + '). Pass {engine:{gridLayout,metrics,autoChannels,channelReport}} to inject one.');
  }
  return cached;
}

export const HARD = ['nodeOverlaps', 'edgeThroughNode', 'trackOverlaps', 'labelOverlapsLabel', 'labelOverlapsNode', 'diagonalSegs', 'shortArrowStubs', 'labelMissing'];
export const hardOf = m => Object.fromEntries(HARD.filter(k => m[k] > 0).map(k => [k, m[k]]));
export const hardCount = m => HARD.reduce((s, k) => s + (m[k] > 0 ? m[k] : 0), 0);

// Edges without a condition (legal: a box with one road out needs none) must not break label sizing. Probe the engine once: if an empty label
// yields non-finite geometry, hand it a zero-width placeholder so every other number stays meaningful. A fixed engine is detected and left alone.
const probed = new WeakMap();
export async function emptyLabelFill(E) {
  if (probed.has(E)) return probed.get(E);
  let fill = false;
  try {
    const g = { id: 'probe', nodes: [{ id: 'a', title: 'A', category: 'step' }, { id: 'b', title: 'B', category: 'step' }], edges: [{ id: 'probe:e0', from: 'a', to: 'b', type: 'forward', label: '' }] };
    const geom = await E.gridLayout(g, { map: ['a b'] });
    const m = E.metrics(geom);
    fill = !(Number.isFinite(geom.width) && Number.isFinite(geom.height) && Number.isFinite(m.aspect));
  } catch { fill = true; }
  probed.set(E, fill);
  return fill;
}
export function fillLabels(g, fill) {
  if (!fill) return g;
  const t = g.text?.edges || {};
  return { ...g, edges: g.edges.map(e => ((t[e.id]?.short || e.label || '') === '' ? { ...e, label: '\u200b' } : e)) };
}
