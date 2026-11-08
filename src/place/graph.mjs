// Graph preparation for the placer: normalise a chart, find back edges, pick the happy path (spine), classify roles.
//   normalizeChart(chart) -> { id, title, nodes:[{id,title,category,...}], edges:[{id,from,to,type,label,...}], text }
//   analyze(g, { spine }) -> { ids, idx, out, inn, back:Set(edgeIdx), spine:[ids], roles:{id:{source,sink,end,decision,merge}}, pairs:Map }
// A chart is either engine-shaped {nodes,edges} or model-shaped {boxes,routes} (CONTRACTS section 11 chartsFromModel); both are accepted.

export function normalizeChart(chart) {
  const nodes = (chart.nodes || chart.boxes || []).map(n => ({ ...n, category: n.category ?? n.kind ?? 'step', title: n.title ?? n.id }));
  const edges = (chart.edges || chart.routes || []).map((e, i) => ({ ...e, id: e.id ?? `${chart.id || 'chart'}:e${i}`, label: e.label ?? e.when ?? '', type: e.type ?? 'forward' }));
  return { ...chart, id: chart.id || 'chart', nodes, edges, text: chart.text || {} };
}

// the engine consumes {id,title,nodes,edges,text}; keep that exact shape so gridLayout never sees model-only fields it would trip on
export const engineGraph = g => ({ id: g.id, title: g.title, nodes: g.nodes, edges: g.edges, text: g.text });

const W_EDGE = { forward: 1, deliver: 0.75, record: 0.45, return: 0.2 };
const wOf = e => W_EDGE[e.type] ?? 0.8;

export function analyze(g, { spine: given = null } = {}) {
  const ids = g.nodes.map(n => n.id), idx = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const out = Array.from({ length: n }, () => []), inn = Array.from({ length: n }, () => []);
  g.edges.forEach((e, k) => { const a = idx.get(e.from), b = idx.get(e.to); if (a === undefined || b === undefined || a === b) return; out[a].push({ k, to: b }); inn[b].push({ k, from: a }); });

  // back edges: every 'return' edge, plus whatever closes a cycle in a DFS from the entries (iterative, edge order = input order)
  const back = new Set();
  g.edges.forEach((e, k) => { if (e.type === 'return') back.add(k); });
  const fwdIn = i => inn[i].filter(x => !back.has(x.k)).length;
  let entries = ids.map((_, i) => i).filter(i => fwdIn(i) === 0);
  if (!entries.length && n) entries = [ids.map((_, i) => i).sort((p, q) => (out[q].length - inn[q].length) - (out[p].length - inn[p].length) || p - q)[0]];
  const state = new Int8Array(n);                       // 0 new, 1 on stack, 2 done
  const dfs = root => {
    const stack = [[root, 0]]; state[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1], [v] = top;
      const list = out[v].filter(x => !back.has(x.k));
      if (top[1] < list.length) {
        const x = list[top[1]++];
        if (state[x.to] === 1) back.add(x.k);
        else if (state[x.to] === 0) { state[x.to] = 1; stack.push([x.to, 0]); }
      } else { state[v] = 2; stack.pop(); }
    }
  };
  for (const e of entries) if (state[e] === 0) dfs(e);
  for (let i = 0; i < n; i++) if (state[i] === 0) dfs(i);

  // topological order of the remaining DAG (Kahn, stable by input order)
  const indeg = new Int32Array(n);
  for (let i = 0; i < n; i++) for (const x of out[i]) if (!back.has(x.k)) indeg[x.to]++;
  const order = [], q = []; for (let i = 0; i < n; i++) if (!indeg[i]) q.push(i);
  for (let h = 0; h < q.length; h++) { const v = q[h]; order.push(v); for (const x of out[v]) if (!back.has(x.k) && --indeg[x.to] === 0) q.push(x.to); }
  const topo = order.length === n ? order : ids.map((_, i) => i);

  // happy path: given, or the heaviest path through the DAG (forward routes weigh most, so side effects never become the spine)
  let spine;
  if (given?.length) spine = given.filter(id => idx.has(id)).filter((id, i, a) => a.indexOf(id) === i);
  else {
    const best = new Float64Array(n).fill(-1), from = new Int32Array(n).fill(-1);
    for (const v of topo) { if (best[v] < 0) best[v] = 1; for (const x of out[v]) { if (back.has(x.k)) continue; const s = best[v] + wOf(g.edges[x.k]); if (s > best[x.to] + 1e-9) { best[x.to] = s; from[x.to] = v; } } }
    let end = 0; for (let i = 0; i < n; i++) if (best[i] > best[end] + 1e-9) end = i;
    // stop at a box already on the spine: when the order fell back to input order, the predecessor chain can loop
    spine = []; const onSpine = new Uint8Array(n); for (let v = end; v >= 0 && !onSpine[v]; v = from[v]) { onSpine[v] = 1; spine.push(ids[v]); }
    spine.reverse();
  }

  const roles = {};
  for (let i = 0; i < n; i++) {
    const outF = out[i].filter(x => !back.has(x.k)).length, inF = inn[i].filter(x => !back.has(x.k)).length;
    const nd = g.nodes[i];
    roles[ids[i]] = { source: inF === 0, sink: outF === 0, end: outF === 0 || nd.kind === 'end' || nd.category === 'end', decision: outF >= 2 || nd.kind === 'decision', merge: inF >= 2, deg: out[i].length + inn[i].length };
  }
  // unordered pair weights: parallel and opposite edges add up; self loops are routed by the engine, never placed
  const pairs = new Map();
  g.edges.forEach((e, k) => {
    const a = idx.get(e.from), b = idx.get(e.to); if (a === undefined || b === undefined || a === b) return;
    const key = a < b ? a * n + b : b * n + a, p = pairs.get(key) || { a: Math.min(a, b), b: Math.max(a, b), w: 0, edges: [] };
    p.w += wOf(e); p.edges.push(k); pairs.set(key, p);
  });
  return { ids, idx, n, out, inn, back, spine, roles, pairs, topo, entries };
}
