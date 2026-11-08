// Channel load report: how many parallel tracks run through each column gap / row gap of a grid-map geometry, and how wide the gap
// would have to be for them to stay legible.  node src/engine/channels.mjs <geom.json> [--pitch 14] [--buf 16] [--top 20] [--json]
//
// A "column gap" is the free space between two neighbouring OCCUPIED grid columns a<b (empty columns are folded into it); the tracks that
// use it are the vertical route segments (length >= 20px) lying inside it.  Row gaps are the same with horizontal segments.
// need = (tracks-1) * pitch + 2 * buf     (pitch = route.nudge, buf = route.shapeBuffer; measured: libavoid keeps `nudge` px between tracks
//                                          only if the gap offers that much, otherwise it squeezes them evenly down to ~3px and then overlaps)
// deficit = need - width.  The fix is cfg.colGap[a] += deficit (columns) / cfg.rowGap[a] += deficit (rows).
// Edge labels need more: add ~ (label height 21px) per labelled track if the labels sit in the gap (use pitch 24).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function channelReport(g, { pitch = 14, buf = 16 } = {}) {
  const out = [];
  for (const axis of ['col', 'row']) {
    const colKey = axis === 'col' ? 'col' : 'row';
    const lo = n => (axis === 'col' ? n.x : n.y), hi = n => (axis === 'col' ? n.x + n.w : n.y + n.h);
    const byIdx = new Map();
    for (const n of g.nodes) { if (n[colKey] === undefined) continue; const l = byIdx.get(n[colKey]) || { min: 1e12, max: -1e12 }; l.min = Math.min(l.min, lo(n)); l.max = Math.max(l.max, hi(n)); byIdx.set(n[colKey], l); }
    const idx = [...byIdx.keys()].sort((p, q) => p - q);
    for (let k = 0; k + 1 < idx.length; k++) {
      const a = idx[k], b = idx[k + 1], from = byIdx.get(a).max, to = byIdx.get(b).min, width = to - from;
      if (width <= 0) continue;
      const xs = new Map();   // edge id -> coordinates of its segments inside the gap
      for (const e of g.edges) for (let i = 0; i < e.pts.length - 1; i++) {
        const p = e.pts[i], q = e.pts[i + 1];
        const along = axis === 'col' ? Math.abs(p[0] - q[0]) < 0.5 : Math.abs(p[1] - q[1]) < 0.5;           // segment runs ALONG the gap
        const len = axis === 'col' ? Math.abs(p[1] - q[1]) : Math.abs(p[0] - q[0]);
        const pos = axis === 'col' ? p[0] : p[1];
        if (!along || len < 20 || pos <= from + 1 || pos >= to - 1) continue;
        if (!xs.has(e.id)) xs.set(e.id, []);
        xs.get(e.id).push(pos);
      }
      const tracks = xs.size;
      if (!tracks) continue;
      // distinct coordinates for the spacing statistic
      const all = [...xs.values()].flat().sort((p, q) => p - q);
      const gaps = all.slice(1).map((v, i) => v - all[i]).filter(v => v > 0.5);
      const need = Math.ceil((tracks - 1) * pitch + 2 * buf);
      out.push({ axis, after: a, from: Math.round(from), to: Math.round(to), width: Math.round(width), tracks, minSpacing: gaps.length ? +Math.min(...gaps).toFixed(1) : null, need, deficit: Math.max(0, need - Math.round(width)), cfg: `${axis === 'col' ? 'colGap' : 'rowGap'}["${a}"] += ${Math.max(0, need - Math.round(width))}` });
    }
  }
  return out.sort((p, q) => q.deficit - p.deficit || q.tracks - p.tracks);
}

const same = (a, b) => { try { const x = fs.realpathSync.native(a), y = fs.realpathSync.native(b); return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y; } catch { return false; } };
const isMain = process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) {
  const a = process.argv.slice(2), flag = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  const g = JSON.parse(fs.readFileSync(a[0], 'utf8'));
  const rep = channelReport(g, { pitch: +flag('pitch', 14), buf: +flag('buf', 16) });
  if (a.includes('--json')) console.log(JSON.stringify(rep));
  else {
    console.log('axis after  width tracks minSpacing need deficit  fix');
    for (const r of rep.slice(0, +flag('top', 20))) console.log(`${r.axis}  ${String(r.after).padStart(4)} ${String(r.width).padStart(6)} ${String(r.tracks).padStart(6)} ${String(r.minSpacing).padStart(10)} ${String(r.need).padStart(4)} ${String(r.deficit).padStart(7)}  ${r.deficit ? r.cfg : 'ok'}`);
    console.log(`overloaded gaps ${rep.filter(r => r.deficit > 0).length}/${rep.length}, total missing width ${rep.reduce((s, r) => s + r.deficit, 0)}px`);
  }
}
