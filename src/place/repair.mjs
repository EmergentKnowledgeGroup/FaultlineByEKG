// Last step before the polylines: no two straight runs may lie along each other. Corridors of different blocks overlap where they run across a
// shared street or gutter (both are legal there), so two pieces can land on the same coordinate; so can a stub and a part's own route.
// Every such pair is nudged apart: the piece (or stub slot) moves by half a pitch at a time, within its corridor, to the nearest coordinate
// where nothing lies along it. Deterministic: conflicts are taken in a fixed order.
//   resolve({ axes, t, slotA, slotB, ends, inner, band, slotRange, pitch }) -> { moved, left }     mutates t (per route, per corridor) and slotA / slotB
//   axes[i][q] 'v'|'h'; ends[i] = [{ axis, edge }, { axis, edge }] box-side coordinate of both stubs; inner = fixed segments [{axis, coord, lo, hi}]
//   band[i][q] = [min, max] a track may take; slotRange[i] = [[min, max], [min, max]] the attach range of each stub
const TOL = 3.25, OVER = 5;
const OFFSETS = [];                                   // how far a run may be moved: from just clear of its neighbour outwards, fine near, coarse far
for (let d = 3.3; d < 24; d += 0.35) OFFSETS.push(d);
for (let d = 24; d <= 400; d += 4) OFFSETS.push(d);

export function resolve(S, maxIter = 8) {
  const { axes, t, slotA, slotB, ends, inner } = S, n = t.length;
  let moved = 0, left = 0; const stuck = new Set(), stuckItems = [];                       // corridors whose pieces could not be moved clear: the caller gives them spare tracks
  const build = () => {
    const items = { h: [], v: [] };
    for (const s of inner) items[s.axis].push(s);
    for (let i = 0; i < n; i++) {
      const m = t[i].length;
      for (let q = 0; q < m; q++) {
        const a = q === 0 ? slotA[i] : t[i][q - 1], b = q === m - 1 ? slotB[i] : t[i][q + 1];
        if (Math.abs(a - b) > 0.01) items[axes[i][q]].push({ axis: axes[i][q], coord: t[i][q], lo: Math.min(a, b), hi: Math.max(a, b), i, q, mov: true });
      }
      const sa = ends[i][0], sb = ends[i][1];
      items[sa.axis].push({ axis: sa.axis, coord: slotA[i], lo: Math.min(sa.edge, t[i][0]), hi: Math.max(sa.edge, t[i][0]), i, q: -1, mov: true });
      items[sb.axis].push({ axis: sb.axis, coord: slotB[i], lo: Math.min(sb.edge, t[i][m - 1]), hi: Math.max(sb.edge, t[i][m - 1]), i, q: -2, mov: true });
    }
    for (const k of ['h', 'v']) items[k].sort((a, b) => a.coord - b.coord || a.lo - b.lo);
    return items;
  };
  const bk = c => Math.floor(c / 4);
  const index = arr => { const m = new Map(); for (const it of arr) { const b = bk(it.coord); (m.get(b) || m.set(b, []).get(b)).push(it); } return m; };
  const clash = (idx, c, a0, a1, self, exclude) => {                  // an item lying along coordinate c over [a0, a1], other than this route's own
    for (let b = bk(c - TOL); b <= bk(c + TOL); b++) {
      const l = idx.get(b); if (!l) continue;
      for (const o of l) { if (o === exclude || (o.i !== undefined && o.i === self)) continue; if (Math.abs(o.coord - c) < TOL && Math.min(o.hi, a1) - Math.max(o.lo, a0) > OVER) return o; }
    }
    return null;
  };
  for (let iter = 0; iter < maxIter; iter++) {
    const items = build(), todo = [];
    for (const ax of ['h', 'v']) {
      const arr = items[ax];
      for (let k = 0; k < arr.length; k++) for (let j = k + 1; j < arr.length && arr[j].coord - arr[k].coord < TOL; j++) {
        const a = arr[k], b = arr[j]; if (a.i === b.i && a.i !== undefined) continue;
        if (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > OVER) todo.push(a.mov && b.mov ? ((a.q >= 0) !== (b.q >= 0) ? (a.q >= 0 ? a : b) : a.i > b.i ? a : b) : a.mov ? a : b.mov ? b : null);
      }
    }
    const seen = new Set(), list = todo.filter(x => x && !seen.has(x.i + ':' + x.q) && seen.add(x.i + ':' + x.q));
    if (!list.length) return { moved, left: 0, stuck: [], stuckItems: [] };
    let changed = 0; left = 0; stuckItems.length = 0;
    const ix = { h: index(items.h), v: index(items.v) };
    for (const it of list) {
      const idx = ix[it.axis], isPiece = it.q >= 0, i = it.i;
      const [lo, hi] = isPiece ? S.band[i][it.q] : S.slotRange[i][-1 - it.q];
      const cur = it.coord; let best = null;
      for (const d of OFFSETS) { let hit = false; for (const sgn of [1, -1]) { const c = cur + sgn * d; if (c < lo || c > hi) continue; if (!clash(idx, c, it.lo, it.hi, i, it)) { best = c; hit = true; break; } } if (hit) break; }
      if (best === null) { left++; if (S.corr) { const ci = isPiece ? S.corr[i][it.q] : it.q === -1 ? S.corr[i][0] : S.corr[i][S.corr[i].length - 1]; if (isPiece) stuck.add(ci); stuckItems.push([i, ci]); } continue; }
      const old = ix[it.axis].get(bk(it.coord)); old.splice(old.indexOf(it), 1);
      it.coord = best; (ix[it.axis].get(bk(best)) || ix[it.axis].set(bk(best), []).get(bk(best))).push(it);
      if (isPiece) t[i][it.q] = best; else if (it.q === -1) slotA[i] = best; else slotB[i] = best;
      moved++; changed++;
    }
    if (!changed) return { moved, left, stuck: [...stuck], stuckItems };
  }
  return { moved, left, stuck: [...stuck], stuckItems };
}
