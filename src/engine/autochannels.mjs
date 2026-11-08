// Automatic channel sizing: widen colGap / rowGap until no column or row gap is overloaded with parallel tracks.
//
//   node src/engine/autochannels.mjs <graph.json> --cfg <in.json> --out <sized.json> [--text text.json] [--iters 8] [--damp 1] [--pitch <default: cfg route.nudge, else 14>] [--maxAdd 1500]
//
// Why: libavoid chooses routes by length/crossings only, it knows nothing about channel capacity. When more tracks run through a gap than
// fit (about `pitch` px each plus 2 x shapeBuffer) it squeezes them together and finally lays them on top of each other (trackOverlaps).
// This helper routes in FAST mode (crossingPenalty 0: much faster than a full route), measures every gap with
// channels.mjs and adds the missing width to cfg.colGap / cfg.rowGap, then repeats.  Placement (the ASCII map) is never touched.
// Measured on a deliberately bad stage-banded synthetic map: trackOverlaps fell from over a hundred to 1 in 4 iterations (5 s); the following full-penalty route
// had all eight hard metrics at 0.  The sized cfg is written to --out; route it normally afterwards (or with route.shards for speed).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gridLayout } from './gridlayout.mjs';
import { metrics } from './metrics.mjs';
import { channelReport } from './channels.mjs';

// returns { cfg (sized copy), history:[{iter,ms,size,trackOverlaps,overloaded,missing}], geom (last FAST geometry) }
export async function autoChannels(graph, cfg, { iters = 8, damp = 1, pitch = null, maxAdd = 1500, penalty = 0, log = () => {} } = {}) {
  const c = { ...cfg, colGap: { ...(cfg.colGap || {}) }, rowGap: { ...(cfg.rowGap || {}) } };
  const added = {};
  const history = []; let geom;
  for (let it = 0; it <= iters; it++) {
    const t0 = performance.now();
    geom = await gridLayout(graph, { ...c, route: { ...(c.route || {}), crossingPenalty: penalty } });
    const m = metrics(geom), rep = channelReport(geom, { pitch: pitch ?? c.route?.nudge ?? 14, buf: c.route?.shapeBuffer ?? 16 }), over = rep.filter(r => r.deficit > 0);
    const h = { iter: it, ms: Math.round(performance.now() - t0), size: m.size, trackOverlaps: m.trackOverlaps, overloaded: over.length, gaps: rep.length, missing: over.reduce((s, r) => s + r.deficit, 0) };
    history.push(h); log(h);
    if (!over.length || it === iters) break;
    for (const r of over) {
      const map = r.axis === 'col' ? c.colGap : c.rowGap, key = r.axis + r.after;
      const add = Math.min(Math.ceil(r.deficit * damp), Math.max(0, maxAdd - (added[key] || 0)));
      if (add > 0) { map[r.after] = (map[r.after] || 0) + add; added[key] = (added[key] || 0) + add; }
    }
  }
  return { cfg: c, history, geom };
}

const same = (a, b) => { try { const x = fs.realpathSync.native(a), y = fs.realpathSync.native(b); return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y; } catch { return false; } };
const isMain = process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) {
  const a = process.argv.slice(2), flag = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  const gp = a[0], cfgPath = flag('cfg', null), out = flag('out', null);
  if (!gp || !cfgPath) { console.error('usage: autochannels.mjs <graph.json> --cfg <in.json> [--out <sized.json>] [--text text.json] [--iters 8] [--damp 1] [--pitch n] [--maxAdd 1500]'); process.exit(2); }
  const graph = readJson(gp), cfg = readJson(cfgPath);
  if (flag('text', null)) graph.text = readJson(flag('text'));
  if (!cfg?.map) throw new Error('no cfg with a map at ' + cfgPath);
  const r = await autoChannels(graph, cfg, { iters: +flag('iters', 8), damp: +flag('damp', 1), pitch: flag('pitch', null) === null ? null : +flag('pitch'), maxAdd: +flag('maxAdd', 1500), log: h => console.log(`iter ${h.iter}: ${h.ms}ms size ${h.size.join('x')} trackOverlaps ${h.trackOverlaps} overloaded ${h.overloaded}/${h.gaps} missing ${h.missing}px`) });
  if (out) { fs.writeFileSync(out, JSON.stringify(r.cfg, null, 1)); console.log('wrote', out); }
}
