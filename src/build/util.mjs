// Small shared helpers for src/build and src/agent. No dependencies.
import crypto from 'node:crypto';

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// stable JSON: object keys sorted, so the same data hashes the same
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
export const hashOf = (v) => sha(canon(v)).slice(0, 16);

export const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, Math.max(1, n - 1)).replace(/\s+\S*$/, '') + '…' : s; };
export const slug = (s) => String(s).replace(/^(st|s)_/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'x';
export const uniq = (a) => [...new Set(a)];
export const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

// the first path is the happy path; its order ranks boxes everywhere
export function mainPath(model) { return (model.paths && model.paths[0] && model.paths[0].boxes) || []; }

// stages in story order (order, then declaration order); boxes with an unknown stage go to a generated one
export function orderedStages(model) {
  const known = new Set((model.stages || []).map((s) => s.id));
  const list = (model.stages || []).map((s, i) => ({ ...s, _i: i })).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a._i - b._i).map(({ _i, ...s }) => s);
  if ((model.boxes || []).some((b) => !known.has(b.stage))) list.push({ id: '_unstaged', title: 'Unstaged', blurb: 'Boxes whose stage is not declared.', order: 1e9 });
  return list;
}
// O(1): the old form scanned every stage for every box, so a model with S stages and B boxes cost S x B string compares per call site
const _stageSets = new WeakMap();
export const stageIdOf = (model, box) => {
  const arr = model.stages || []; let c = _stageSets.get(arr);
  if (!c || c.n !== arr.length) { c = { n: arr.length, set: new Set(arr.map((s) => s.id)) }; _stageSets.set(arr, c); }
  return c.set.has(box.stage) ? box.stage : '_unstaged';
};

// graph helpers over a box list and route list
export function indexRoutes(boxes, routes) {
  const ids = new Set(boxes.map((b) => b.id)), out = new Map(), inn = new Map();
  boxes.forEach((b) => { out.set(b.id, []); inn.set(b.id, []); });
  for (const r of routes) if (ids.has(r.from) && ids.has(r.to)) { out.get(r.from).push(r); inn.get(r.to).push(r); }
  return { ids, out, inn };
}

// BFS shortest route (fewest hops) over route objects; avoids return routes first, falls back to all
export function shortestRoute(boxes, routes, a, b, { allowReturn = false } = {}) {
  const { ids, out } = indexRoutes(boxes, routes);
  if (!ids.has(a) || !ids.has(b)) return null;
  const run = (ok) => {
    const prev = new Map([[a, null]]), q = [a];
    for (let h = 0; h < q.length; h++) {
      const v = q[h];
      if (v === b) break;
      for (const r of out.get(v)) if (ok(r) && !prev.has(r.to)) { prev.set(r.to, r); q.push(r.to); }
    }
    if (!prev.has(b)) return null;
    const path = []; let cur = b;
    while (prev.get(cur)) { path.unshift(prev.get(cur)); cur = prev.get(cur).from; }
    return path;
  };
  return run((r) => r.type !== 'return') || (allowReturn ? run(() => true) : null);
}

// A route the roads allow, not a promise that one request takes it. A weighted search over forward roads (never a return road unless allowReturn): each road costs 1, each change of
// stage costs `stageCost` (about 6), a road between two consecutive boxes of the main path costs `mainCost` (much less). Ties break by fewer hops, then by the order the roads are listed,
// so the same map always gives the same answer. `stageOf(box)` defaults to box.stage. Used by the page's Trace path and by `faultline path`; `--shortest` is still the plain shortestRoute.
export const ROUTE_COST = { road: 1, stage: 6, main: 0.2 };
export function weightedRoute(boxes, routes, a, b, { allowReturn = false, main = [], stageOf = (x) => x.stage || '', stageCost = ROUTE_COST.stage, mainCost = ROUTE_COST.main } = {}) {
  const { ids, out } = indexRoutes(boxes, routes);
  if (!ids.has(a) || !ids.has(b)) return null;
  const st = new Map(boxes.map((x) => [x.id, stageOf(x)])), mainPair = new Set();
  for (let i = 0; i + 1 < main.length; i++) mainPair.add(main[i] + '>' + main[i + 1]);
  const order = new Map(routes.map((r, i) => [r.id, i]));
  const cost = (r) => (mainPair.has(r.from + '>' + r.to) ? mainCost : ROUTE_COST.road + (st.get(r.from) !== st.get(r.to) ? stageCost : 0));
  const best = new Map([[a, { c: 0, h: 0, o: -1, via: null }]]), done = new Set(), heap = [[0, 0, -1, a]];
  const lt = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (x[3] < y[3] ? -1 : x[3] > y[3] ? 1 : 0);
  const push = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (lt(heap[i], heap[p]) >= 0) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && lt(heap[l], heap[m]) < 0) m = l; if (r < heap.length && lt(heap[r], heap[m]) < 0) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
  while (heap.length) {
    const [c, h, , v] = pop();
    if (done.has(v)) continue;
    done.add(v);
    if (v === b) break;
    for (const r of out.get(v)) {
      if (!allowReturn && r.type === 'return') continue;
      const nc = c + cost(r), nh = h + 1, o = order.get(r.id) ?? 0, cur = best.get(r.to);
      if (!done.has(r.to) && (!cur || nc < cur.c - 1e-9 || (Math.abs(nc - cur.c) < 1e-9 && (nh < cur.h || (nh === cur.h && o < cur.o))))) { best.set(r.to, { c: nc, h: nh, o, via: r }); push([nc, nh, o, r.to]); }
    }
  }
  if (!best.has(b)) return null;
  const path = []; let cur = b;
  while (best.get(cur) && best.get(cur).via) { path.unshift(best.get(cur).via); cur = best.get(cur).via.from; }
  return path;
}

export const tok = (s) => Math.ceil(String(s).length / 4);   // CONTRACTS section 10: tokens are chars/4
