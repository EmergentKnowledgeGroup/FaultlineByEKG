// Graph helpers over a merged model: boxes are nodes, routes are edges. Pure, deterministic, no I/O.
// Self-loops are kept in `out`/`inn` lists but every count here ignores them unless a name says otherwise.

export const RETURN_TYPES = new Set(['return']);

export function buildGraph(model, edgeFilter = null) {
  const boxes = model.boxes || [];
  const out = new Map(), inn = new Map(), byId = new Map();
  for (const b of boxes) { byId.set(b.id, b); out.set(b.id, []); inn.set(b.id, []); }
  const order = new Map(boxes.map((b, i) => [b.id, i]));
  const routes = [];
  for (const r of model.routes || []) {
    if (!out.has(r.from) || !out.has(r.to)) continue;      // dangling routes are G3's business
    if (edgeFilter && !edgeFilter(r)) continue;
    out.get(r.from).push(r); inn.get(r.to).push(r); routes.push(r);
  }
  const outX = (id) => out.get(id).filter((r) => r.to !== id);
  const inX = (id) => inn.get(id).filter((r) => r.from !== id);
  return { boxes, byId, out, inn, outX, inX, routes, order };
}

export const isReturn = (r) => r.type === 'return';

// ids reachable from `starts` following `adj` (Map id -> [route]) with `next(route)` giving the neighbour.
export function reach(starts, adj, next, removed = null) {
  const seen = new Set(), st = [];
  for (const s of starts) if (!(removed && removed.has(s)) && !seen.has(s)) { seen.add(s); st.push(s); }
  while (st.length) {
    const u = st.pop();
    for (const r of adj.get(u) || []) {
      const v = next(r);
      if (removed && removed.has(v)) continue;
      if (!seen.has(v)) { seen.add(v); st.push(v); }
    }
  }
  return seen;
}
export const fwd = (g, starts, removed) => reach(starts, g.out, (r) => r.to, removed);
export const back = (g, starts, removed) => reach(starts, g.inn, (r) => r.from, removed);

// Tarjan, iterative so a long chain cannot blow the stack. Components come out in reverse topological order.
export function sccs(ids, out) {
  let idx = 0;
  const index = new Map(), low = new Map(), on = new Set(), stack = [], comps = [];
  for (const root of ids) {
    if (index.has(root)) continue;
    const work = [{ v: root, i: 0 }];
    index.set(root, idx); low.set(root, idx); idx++; stack.push(root); on.add(root);
    while (work.length) {
      const fr = work[work.length - 1];
      const edges = out.get(fr.v) || [];
      if (fr.i < edges.length) {
        const w = edges[fr.i++].to;
        if (!index.has(w)) {
          index.set(w, idx); low.set(w, idx); idx++; stack.push(w); on.add(w);
          work.push({ v: w, i: 0 });
        } else if (on.has(w)) low.set(fr.v, Math.min(low.get(fr.v), index.get(w)));
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1].v; low.set(p, Math.min(low.get(p), low.get(fr.v))); }
        if (low.get(fr.v) === index.get(fr.v)) {
          const c = []; let w;
          do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== fr.v);
          comps.push(c);
        }
      }
    }
  }
  return comps;
}

// Shortest list of routes from -> to by hop count, or null. Ties break on model order, so output is stable.
export function shortestRoutes(from, to, out) {
  if (from === to) return [];
  const prev = new Map([[from, null]]), q = [from];
  for (let h = 0; h < q.length; h++) {
    const u = q[h];
    if (u === to) break;
    for (const r of out.get(u) || []) if (!prev.has(r.to)) { prev.set(r.to, r); q.push(r.to); }
  }
  if (!prev.has(to)) return null;
  const path = []; let cur = to;
  while (cur !== from) { const r = prev.get(cur); path.push(r); cur = r.from; }
  return path.reverse();
}

// Boxes that are ends by kind.
export const endIds = (g) => g.boxes.filter((b) => b.kind === 'end').map((b) => b.id);
