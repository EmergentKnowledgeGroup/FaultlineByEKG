// The main path, so the review queue can start there, and the annotation that orders claims by it.
//
// mainPath(M) -> [depth by function, boxes] for the functions a computed walk passes through, from every entry. The walk follows one road per box
// inside a function (prefer a box that is not an ending, the one that reaches the most boxes, ties by line; if every road ends, a success before a
// failure), steps into a callee box over a proven call road (once per path, depth <= MAX_DEPTH); at most MAX_STEPS steps per entry.
import { sorted } from './pyrt.mjs';

const MAX_DEPTH = 4;
const MAX_STEPS = 70;
const FAILURE_TYPES = new Set(['hears', 'negative', 'exc-road']);

export function mainPath(M) {
  const { P, F } = M;
  const fw = new Map();
  const calls = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const r of M.roads.values()) {
    const pv = r.prov;
    const a = M.boxes.get(r.from);
    const b = M.boxes.get(r.to);
    if (!a || !b) continue;
    if (pv.rule === 'cfg-edge' && r.type !== 'return') push(fw, r.from, r.to);
    else if (pv.rule === 'call' && pv.tier === 'proven' && a.fn !== b.fn) push(calls, r.from, r.to);
  }
  const reach = new Map();
  // the count of boxes a box reaches, a depth-first walk that skips what this walk has already seen (the memo is shared across walks)
  const reachOf = (x0, seen) => {
    if (reach.has(x0)) return reach.get(x0);
    seen.add(x0);
    const stack = [{ x: x0, i: 0, n: 1 }];
    while (stack.length) {
      const f = stack[stack.length - 1];
      const ys = fw.get(f.x) ?? [];
      let descended = false;
      while (f.i < ys.length) {
        const y = ys[f.i++];
        if (seen.has(y)) continue;
        if (reach.has(y)) { f.n += reach.get(y); continue; }
        seen.add(y);
        stack.push({ x: y, i: 0, n: 1 });
        descended = true;
        break;
      }
      if (descended) continue;
      reach.set(f.x, f.n);
      stack.pop();
      if (stack.length) stack[stack.length - 1].n += f.n;
    }
    return reach.get(x0);
  };
  const bad = (x) => M.boxes.get(x).kind === 'end' && (M.boxes.get(x).prov.class ?? '').startsWith('raise');
  const pick = (x, skip) => {
    const rs = (fw.get(x) ?? []).filter((y) => !skip.has(y));
    if (!rs.length) return null;
    const live = rs.filter((y) => M.boxes.get(y).kind !== 'end');
    if (live.length) return sorted(live, (y) => [-reachOf(y, new Set()), M.boxes.get(y).prov.line, y])[0];
    return sorted(rs, (y) => [bad(y) ? 1 : 0, M.boxes.get(y).prov.line, y])[0];
  };
  const depth = new Map();
  const boxes = new Set();
  const entries = sorted([...M.mapped].filter((fid) => !F.callers.get(fid)?.length && P.fns.get(fid).qual !== '<module>' && M.entry.get(fid)));
  const walk = (fid, d, steps, entered) => {
    let x = M.entry.get(fid);
    const skip = new Set();
    depth.set(fid, Math.min(depth.get(fid) ?? 99, d));
    while (x && steps[0] < MAX_STEPS && !skip.has(x)) {
      skip.add(x);
      boxes.add(x);
      steps[0]++;
      if (d < MAX_DEPTH) {
        for (const y of calls.get(x) ?? []) {
          const g = M.boxes.get(y).fn;
          if (!entered.has(g)) { entered.add(g); walk(g, d + 1, steps, entered); }
        }
      }
      x = pick(x, skip);
    }
  };
  for (const fid of entries) walk(fid, 0, [0], new Set([fid]));
  return [depth, boxes];
}

/** Adds `main` (the claim's function is on the computed main path), `depth` and `failure` to every claim, for ordering the queue. */
export function annotate(M, claims) {
  const [depth] = mainPath(M);
  for (const c of claims) {
    const d = depth.get(c.fn);
    c.main = d !== undefined;
    c.depth = d !== undefined ? d : 99;
    c.failure = FAILURE_TYPES.has(c.type) || ((c.type === 'kind' || c.type === 'title') && c.says.includes('raise'));
  }
  return claims;
}
