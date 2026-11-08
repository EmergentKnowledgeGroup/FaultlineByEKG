// Function-level reach over the calls the tool resolved. Used to say "related in the code" and to see whether two citations belong together.
import { cmp } from './canon.mjs';

/** Calls followed when asking whether the code of one box reaches the code of another: two is enough to say "related"; more would relate almost anything in a connected program. */
export const MAX_CALL_HOPS = 2;
/** Calls followed when asking whether two citations of one box belong to the same piece of code: a little wider, because a box may cite a caller and the helper it hands to. */
export const MAX_CITE_HOPS = 3;

/** Shortest route over resolved calls from any function of `srcs` to any of `dsts`, at most kmax calls. [] if they share a function. null if none. Route: [{from, line, to}] */
export function callRoute(L, srcs, dsts, kmax) {
  srcs = new Set(srcs); dsts = new Set(dsts);
  for (const s of srcs) if (dsts.has(s)) return [];
  const prev = new Map([...srcs].sort(cmp).map((s) => [s, null]));
  let frontier = [...prev.keys()];
  for (let d = 0; d < kmax && frontier.length; d++) {
    const next = [];
    for (const u of frontier) {
      for (const [v, line] of L.fcalls.get(u) ?? []) {
        if (prev.has(v)) continue;
        prev.set(v, { from: u, line, to: v });
        if (dsts.has(v)) {
          const route = [];
          for (let x = v; prev.get(x); x = prev.get(x).from) route.push(prev.get(x));
          return route.reverse();
        }
        next.push(v);
      }
    }
    frontier = next;
  }
  return null;
}

/** Do two groups of functions belong together? The same function, one inside the other, or a call route either way. */
export function belongTogether(L, a, b, kmax = MAX_CITE_HOPS) {
  const A = L.withClosures(a), B = L.withClosures(b);
  for (const x of A) if (B.has(x)) return true;
  return callRoute(L, A, B, kmax) != null || callRoute(L, B, A, kmax) != null;
}
