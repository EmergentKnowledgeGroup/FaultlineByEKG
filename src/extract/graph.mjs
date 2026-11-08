// graph.json builder: call and import edges, Tarjan SCCs, seeded Louvain clusters, BFS depth from entries, hubs.
import path from 'node:path';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const modOf = (id) => id.slice(0, id.indexOf('::'));

/** Iterative Tarjan. adj: Map(id -> [id]). Returns SCCs of size >= 2 as arrays. */
export function tarjan(ids, adj) {
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [], out = [];
  let counter = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work = [[root, 0]];
    index.set(root, counter); low.set(root, counter); counter++; stack.push(root); onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1];
      const [v] = top;
      const nbrs = adj.get(v) || [];
      if (top[1] < nbrs.length) {
        const w = nbrs[top[1]++];
        if (!index.has(w)) { index.set(w, counter); low.set(w, counter); counter++; stack.push(w); onStack.add(w); work.push([w, 0]); }
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      } else {
        if (low.get(v) === index.get(v)) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
          if (comp.length > 1) out.push(comp);
        }
        work.pop();
        if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(v))); }
      }
    }
  }
  return out;
}

/** Louvain on an undirected weighted graph. nodes: sorted ids; edges: Map("a\tb" -> w). Returns Map(id -> communityIndex). */
export function louvain(nodes, edgeW, seed = 1) {
  const n = nodes.length, idx = new Map(nodes.map((x, i) => [x, i]));
  let adj = Array.from({ length: n }, () => new Map());
  let m2 = 0;
  for (const [k, w] of edgeW) {
    const [a, b] = k.split('\t');
    const i = idx.get(a), j = idx.get(b);
    if (i === undefined || j === undefined || i === j) continue;
    adj[i].set(j, (adj[i].get(j) || 0) + w); adj[j].set(i, (adj[j].get(i) || 0) + w); m2 += 2 * w;
  }
  const member = Array.from({ length: n }, (_, i) => [i]);   // original nodes inside each current node
  const rnd = mulberry32(seed);
  let cur = n;
  for (let level = 0; level < 12; level++) {
    const deg = adj.map((m) => { let s = 0; for (const w of m.values()) s += w; return s; });
    const comm = Array.from({ length: cur }, (_, i) => i), tot = deg.slice();
    const order = Array.from({ length: cur }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let moved = true, passes = 0, any = false;
    while (moved && passes++ < 30) {
      moved = false;
      for (const i of order) {
        const ci = comm[i], ki = deg[i];
        const wTo = new Map();
        for (const [j, w] of adj[i]) if (j !== i) wTo.set(comm[j], (wTo.get(comm[j]) || 0) + w);
        tot[ci] -= ki;
        let best = ci, bestGain = (wTo.get(ci) || 0) - (tot[ci] * ki) / m2;
        for (const [c, w] of [...wTo].sort((a, b) => a[0] - b[0])) {
          const gain = w - (tot[c] * ki) / m2;
          if (gain > bestGain + 1e-12) { bestGain = gain; best = c; }
        }
        tot[best] += ki; comm[i] = best;
        if (best !== ci) { moved = true; any = true; }
      }
    }
    if (!any) break;
    const remap = new Map();
    for (const c of comm) if (!remap.has(c)) remap.set(c, remap.size);
    const nextAdj = Array.from({ length: remap.size }, () => new Map()), nextMember = Array.from({ length: remap.size }, () => []);
    for (let i = 0; i < cur; i++) {
      const ci = remap.get(comm[i]);
      nextMember[ci].push(...member[i]);
      for (const [j, w] of adj[i]) { const cj = remap.get(comm[j]); nextAdj[ci].set(cj, (nextAdj[ci].get(cj) || 0) + w); }
    }
    adj = nextAdj; member.length = 0; member.push(...nextMember); cur = remap.size;
    if (cur === 1) break;
  }
  const out = new Map();
  member.forEach((ms, ci) => ms.forEach((i) => out.set(nodes[i], ci)));
  return out;
}

function label(mods, fnCount) {
  if (mods.length === 1) return path.posix.basename(mods[0]).replace(/\.[a-z]+$/, '').replace(/^__init__$/, path.posix.basename(path.posix.dirname(mods[0])) || 'root');
  const dirs = new Map();
  for (const m of mods) { const parts = m.split('/'); const d = parts.length > 1 ? parts.slice(0, -1).join('/') : '.'; dirs.set(d, (dirs.get(d) || 0) + 1); }
  const topDir = [...dirs].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0][0];
  const stems = mods.map((m) => ({ s: path.posix.basename(m).replace(/\.[a-z]+$/, ''), n: fnCount.get(m) || 0 }))
    .filter((x) => x.s !== '__init__' && x.s !== 'index').sort((a, b) => b.n - a.n || cmp(a.s, b.s)).slice(0, 3).map((x) => x.s);
  const head = topDir === '.' ? '' : path.posix.basename(topDir);
  return (head ? head + ': ' : '') + (stems.join(', ') || 'modules');
}

export function buildGraph(facts, { seed = 1 } = {}) {
  const fns = facts.functions, ids = Object.keys(fns);
  const strong = new Set(), weak = new Set();
  const adj = new Map(), wadj = new Map(), inDeg = new Map(), outDeg = new Map();
  for (const id of ids) {
    const f = fns[id];
    const outs = [];
    for (const c of f.calls || []) if (c !== id && fns[c]) { strong.add(id + '\t' + c); outs.push(c); }
    adj.set(id, outs);
    const wo = [];
    for (const c of f.weakCalls || []) if (c !== id && fns[c] && !strong.has(id + '\t' + c)) { weak.add(id + '\t' + c); wo.push(c); }
    wadj.set(id, wo);
  }
  for (const k of strong) { const [a, b] = k.split('\t'); inDeg.set(b, (inDeg.get(b) || 0) + 1); outDeg.set(a, (outDeg.get(a) || 0) + 1); }
  const callEdges = [...strong].sort().map((k) => k.split('\t'));
  const weakCallEdges = [...weak].sort().map((k) => k.split('\t'));
  const mods = new Set(facts.modules.map((m) => m.path));
  const importEdges = [];
  for (const m of facts.modules) for (const t of m.imports || []) if (mods.has(t) && t !== m.path) importEdges.push([m.path, t]);
  importEdges.sort((a, b) => cmp(a[0] + '\t' + a[1], b[0] + '\t' + b[1]));
  // SCCs on strong edges only: real recursion or mutual-call cycles
  const sccs = tarjan(ids.slice().sort(), adj).map((c) => c.sort()).sort((a, b) => b.length - a.length || cmp(a[0], b[0]));
  const scc = sccs.map((c, i) => ({ id: 'scc' + i, fns: c }));
  // clusters: Louvain over modules; weights = import edges + cross-module calls (weak calls count half)
  const edgeW = new Map();
  const bump = (a, b, w) => { if (a === b) return; const k = cmp(a, b) < 0 ? a + '\t' + b : b + '\t' + a; edgeW.set(k, (edgeW.get(k) || 0) + w); };
  for (const [a, b] of importEdges) bump(a, b, 1);
  for (const [a, b] of callEdges) bump(modOf(a), modOf(b), 1);
  for (const [a, b] of weakCallEdges) bump(modOf(a), modOf(b), 0.5);
  const modList = facts.modules.map((m) => m.path).sort();
  const comm = louvain(modList, edgeW, seed);
  const groups = new Map();
  for (const m of modList) { const c = comm.get(m); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(m); }
  // fold tiny communities into their best neighbour, and unconnected leftovers into one cluster per folder
  const inc = new Map();
  for (const [k, w] of edgeW) { const [a, b] = k.split('\t'); if (!inc.has(a)) inc.set(a, new Map()); if (!inc.has(b)) inc.set(b, new Map()); inc.get(a).set(b, w); inc.get(b).set(a, w); }
  const owner = new Map();
  for (const [c, ms] of groups) for (const m of ms) owner.set(m, c);
  for (const [c, ms] of [...groups].sort((a, b) => a[1].length - b[1].length || cmp(a[1][0], b[1][0]))) {
    if (ms.length >= 3) continue;
    const pull = new Map();
    for (const m of ms) for (const [o, w] of inc.get(m) || []) { const oc = owner.get(o); if (oc !== c) pull.set(oc, (pull.get(oc) || 0) + w); }
    const best = [...pull].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    if (best && groups.get(best[0]).length + ms.length <= Math.max(12, modList.length / 3)) { groups.get(best[0]).push(...ms); for (const m of ms) owner.set(m, best[0]); groups.delete(c); }
  }
  const loose = [];
  for (const [c, ms] of [...groups]) if (ms.length < 3 && !ms.some((m) => (inc.get(m) || new Map()).size)) { loose.push(...ms); groups.delete(c); }
  const byDir = new Map();
  for (const m of loose) { const d = path.posix.dirname(m); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(m); }
  let extra = 1e6;
  for (const [, ms] of [...byDir].sort((a, b) => cmp(a[0], b[0]))) groups.set(extra++, ms);
  const fnsByMod = new Map();
  for (const id of ids) { const m = modOf(id); if (!fnsByMod.has(m)) fnsByMod.set(m, []); fnsByMod.get(m).push(id); }
  const fnCount = new Map([...fnsByMod].map(([m, l]) => [m, l.length]));
  const list = [...groups.values()].map((ms) => ms.slice().sort()).map((ms) => ({ ms, n: ms.reduce((s, m) => s + (fnCount.get(m) || 0), 0) }))
    .sort((a, b) => b.n - a.n || b.ms.length - a.ms.length || cmp(a.ms[0], b.ms[0]));
  const clusters = list.map(({ ms }, i) => {
    const set = new Set(ms);
    let inside = 0, across = 0;
    for (const [k, w] of edgeW) { const [a, b] = k.split('\t'); const ia = set.has(a), ib = set.has(b); if (ia && ib) inside += w; else if (ia || ib) across += w; }
    return { id: 'c' + i, modules: ms, fns: ms.flatMap((m) => (fnsByMod.get(m) || []).slice().sort()), cohesion: inside + across ? +(inside / (inside + across)).toFixed(2) : 0, label: label(ms, fnCount) };
  });
  // depth: BFS from entries over strong and weak edges
  const depth = {};
  const roots = [...new Set(facts.entries.filter((e) => e.kind !== 'test' && fns[e.fn]).map((e) => e.fn))].sort();
  let frontier = roots;
  for (const r of roots) depth[r] = 0;
  for (let d = 1; frontier.length; d++) {
    const next = [];
    for (const u of frontier) for (const v of [...(adj.get(u) || []), ...(wadj.get(u) || [])]) if (!(v in depth)) { depth[v] = d; next.push(v); }
    frontier = next.sort();
  }
  const hubs = ids.filter((id) => (inDeg.get(id) || 0) >= 4 && !id.endsWith('::<module>'))
    .map((id) => ({ fn: id, in: inDeg.get(id) || 0, out: outDeg.get(id) || 0 }))
    .sort((a, b) => b.in - a.in || b.out - a.out || cmp(a.fn, b.fn)).slice(0, 40);
  return { schema: 'faultline.graph/1', callEdges, importEdges, scc, clusters, depth, hubs, weakCallEdges };
}
