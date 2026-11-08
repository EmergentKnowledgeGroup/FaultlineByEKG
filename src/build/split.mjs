// splitStage(boxes, inStageRoutes, main, max) -> parts, an ordered list of box-id lists (each in model order), every part at most `max` boxes.
// How a stage above `max` boxes is cut into charts. The old cut walked a reading order and broke it at the quietest seam; this one finds the
// families first and cuts between them:
//   1. a leaf follows its source: an end box fed by one box, or a box with one road in and none out, is glued to that box before anything else
//   2. a hub (more than HUB_IN roads in) is a weak link: its roads weigh little so it cannot glue families together; it is set into the family
//      that sends it the most roads once the families exist, and the others reach it across charts
//   3. agglomerative clustering on the undirected roads (return roads weigh less) with a hard size cap, then a few passes of moving single units
//      to the part that holds more of their roads, never past the cap and never breaking a part in two
//   4. families with no road between them are never one chart, unless both are tiny (under SMALL_COMP boxes) and cite the same first source
//      file; boxes with no in-stage road at all go together in a final part (or parts, when there are more than `max`)
//   5. a part under TINY boxes that has a road to another part joins the part it talks to most, if the cap allows
//   6. parts are ordered by the earliest reading-order position of any of their boxes; the unconnected boxes come last
// Deterministic: no randomness, no clock, every tie broken by model or reading position.
import { indexRoutes, uniq } from './util.mjs';

export const HUB_IN = 8;       // more than this many in-stage roads in makes a hub
const RETURN_W = 0.4;          // a return road weighs this much beside a forward one
const HUB_W = 0.1;             // a road that touches a hub weighs this much
const SMALL_COMP = 4;          // families under this many boxes may share a chart if they cite one source file
const TINY = 5;                // parts under this many boxes join the part they talk to most
const RESOLUTION = 0.5;          // modularity resolution: below 1 favours fewer, larger parts
const EPS = 1e-12;

// reading order of a set of boxes: depth-first over non-return routes from the entries, main path first, reversed post-order
// (a valid topological order that survives cycles); anything left over follows in model order
export function readingOrder(boxes, routes, main = []) {
  const { out, inn, ids } = indexRoutes(boxes, routes);
  const rank = new Map(main.map((id, i) => [id, i])), pos = new Map(boxes.map((b, i) => [b.id, i]));
  const pref = (a, b) => (rank.has(a) ? rank.get(a) : 1e6 + pos.get(a)) - (rank.has(b) ? rank.get(b) : 1e6 + pos.get(b));
  const fwd = (id) => out.get(id).filter((r) => r.type !== 'return' && r.to !== id).map((r) => r.to);
  const roots = boxes.map((b) => b.id).filter((id) => !inn.get(id).some((r) => r.type !== 'return' && r.from !== id)).sort(pref);
  const seen = new Set(), post = [];
  const dfs = (root) => {
    const stack = [[root, uniq(fwd(root)).sort(pref).reverse(), 0]]; seen.add(root);
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top[2] < top[1].length) { const nx = top[1][top[2]++]; if (!seen.has(nx) && ids.has(nx)) { seen.add(nx); stack.push([nx, uniq(fwd(nx)).sort(pref).reverse(), 0]); } }
      else { post.push(top[0]); stack.pop(); }
    }
  };
  for (const r of roots.slice().reverse()) if (!seen.has(r)) dfs(r);
  for (const b of boxes) if (!seen.has(b.id)) dfs(b.id);
  return post.reverse();
}

const bump = (maps, a, b, w) => { maps[a].set(b, (maps[a].get(b) || 0) + w); maps[b].set(a, (maps[b].get(a) || 0) + w); };
const firstPath = (b) => (b && b.refs && b.refs[0] && b.refs[0].path) || null;

// ---- step 1 and 2: units (a box plus the leaves glued to it), hubs, and the weighted road graph between units
function buildGraph(boxes, rs, max, hubIn) {
  const ids = boxes.map((b) => b.id);
  const inN = new Map(ids.map((i) => [i, 0])), srcs = new Map(ids.map((i) => [i, new Set()])), outs = new Map(ids.map((i) => [i, new Set()]));
  const touched = new Set();
  for (const r of rs) { inN.set(r.to, inN.get(r.to) + 1); srcs.get(r.to).add(r.from); outs.get(r.from).add(r.to); touched.add(r.from); touched.add(r.to); }
  const hub = new Set(ids.filter((i) => inN.get(i) > hubIn));
  const parent = new Map(), kids = new Map();
  for (const b of boxes) {
    const id = b.id;
    if (hub.has(id) || srcs.get(id).size !== 1 || kids.has(id)) continue;
    if (!(b.kind === 'end' || (inN.get(id) === 1 && outs.get(id).size === 0))) continue;
    const p = [...srcs.get(id)][0];
    if (parent.has(p)) continue;
    parent.set(id, p); if (!kids.has(p)) kids.set(p, []); kids.get(p).push(id);
  }
  const units = [], unitOf = new Map();
  const add = (members, isHub) => { members.forEach((m) => unitOf.set(m, units.length)); units.push({ members, hub: isHub, size: members.length }); };
  for (const id of ids) {
    if (parent.has(id)) continue;
    const ks = kids.get(id) || [], room = Math.max(0, max - 1);
    add([id, ...ks.slice(0, room)], hub.has(id));
    for (let i = room; i < ks.length; i += max) add(ks.slice(i, i + max), false);   // leaves that do not fit beside their source: a unit of their own
  }
  const U = units.length, mk = () => Array.from({ length: U }, () => new Map());
  const adj = mk(), cnt = mk(), send = mk(), intra = new Array(U).fill(0);
  for (const r of rs) {
    const a = unitOf.get(r.from), b = unitOf.get(r.to);
    const w = (r.type === 'return' ? RETURN_W : 1) * (units[a].hub || units[b].hub ? HUB_W : 1);
    if (a === b) { intra[a] += w; continue; }
    bump(adj, a, b, w); bump(cnt, a, b, 1); send[a].set(b, (send[a].get(b) || 0) + 1);
  }
  const deg = units.map((u, i) => { let s = 2 * intra[i]; for (const [v, w] of adj[i]) if (!units[v].hub) s += w; return s; });
  return { units, unitOf, adj, cnt, send, deg, touched, hub };
}

// ---- step 3: agglomerative clustering (greatest modularity gain first) of one connected family, never past `max` boxes
function clusterFamily(comp, g, max, gamma) {
  const { units, adj, deg } = g, cl = new Map(), W = new Map();
  let m2 = 0;
  for (const u of comp) { cl.set(u, { u: [u], sz: units[u].size, d: deg[u] }); m2 += deg[u]; W.set(u, new Map([...adj[u]].filter(([v]) => !units[v].hub))); }
  const m = m2 / 2;
  for (;;) {
    let best = null;
    for (const [a, na] of W) for (const [b, w] of na) {
      if (b <= a) continue;
      const A = cl.get(a), B = cl.get(b);
      if (A.sz + B.sz > max) continue;
      const dq = w / m - (gamma * A.d * B.d) / (2 * m * m);
      if (dq <= EPS) continue;
      if (!best || dq > best.dq + EPS || (Math.abs(dq - best.dq) <= EPS && (a < best.a || (a === best.a && b < best.b)))) best = { a, b, dq };
    }
    if (!best) break;
    const { a, b } = best, A = cl.get(a), B = cl.get(b), Wa = W.get(a), Wb = W.get(b);
    A.u.push(...B.u); A.sz += B.sz; A.d += B.d;
    Wa.delete(b);
    for (const [c, w] of Wb) { if (c === a) continue; Wa.set(c, (Wa.get(c) || 0) + w); const Wc = W.get(c); Wc.set(a, (Wc.get(a) || 0) + w); Wc.delete(b); }
    W.delete(b); cl.delete(b);
  }
  return [...cl.values()].map((c) => ({ u: c.u, sz: c.sz }));
}

// connected components of the units, over roads between units that are not hubs
function families(g, skip) {
  const { units, adj } = g, seen = new Set(), out = [];
  for (let s = 0; s < units.length; s++) {
    if (seen.has(s) || skip.has(s) || units[s].hub) continue;
    const comp = [], stack = [s]; seen.add(s);
    while (stack.length) { const u = stack.pop(); comp.push(u); for (const v of adj[u].keys()) if (!seen.has(v) && !skip.has(v) && !units[v].hub) { seen.add(v); stack.push(v); } }
    out.push(comp.sort((a, b) => a - b));
  }
  return out;
}

// ---- step 4: tiny families that cite the same first source file may share a chart
function groupSmall(comps, g, boxOf, max) {
  const keyOf = (comp) => {
    const ks = uniq(comp.flatMap((u) => g.units[u].members).map((id) => firstPath(boxOf.get(id))));
    return ks.length === 1 ? ks[0] : null;
  };
  const out = [], byKey = new Map();
  for (const comp of comps) {
    const sz = comp.reduce((n, u) => n + g.units[u].size, 0), key = keyOf(comp);
    const hit = key && (byKey.get(key) || []).find((p) => p.sz + sz <= max);
    if (hit) { hit.u.push(...comp); hit.sz += sz; continue; }
    const p = { u: comp.slice(), sz }; out.push(p);
    if (key) { if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(p); }
  }
  return out;
}

export function splitStage(boxes, routes, main = [], max = 21, opts = {}) {
  const n = boxes.length;
  if (!n) return [];
  if (n <= max) return [boxes.map((b) => b.id)];
  const hubIn = opts.hubIn ?? HUB_IN, tiny = Math.min(opts.tiny ?? TINY, max), small = opts.small ?? SMALL_COMP;
  const ids = boxes.map((b) => b.id), pos = new Map(ids.map((id, i) => [id, i])), boxOf = new Map(boxes.map((b) => [b.id, b]));
  const rs = routes.filter((r) => r.from !== r.to && pos.has(r.from) && pos.has(r.to));
  const rpos = new Map(readingOrder(boxes, rs, main).map((id, i) => [id, i]));
  const g = buildGraph(boxes, rs, max, hubIn), { units, cnt, send } = g;
  const early = (members) => Math.min(...members.map((id) => rpos.get(id)));
  const lead = (p) => Math.min(...p.u);   // a part's first unit, for tie-breaks

  // boxes with no in-stage road at all are set aside for the final part
  const lone = new Set(units.map((u, i) => (u.size === 1 && !u.hub && !g.touched.has(u.members[0]) ? i : -1)).filter((i) => i >= 0));
  const owner = new Array(units.length).fill(null);
  let parts = [];
  const claim = (p) => { parts.push(p); for (const u of p.u) owner[u] = p; return p; };

  const fams = families(g, lone), big = [], tinyFams = [], sats = [];
  const nearHub = (comp) => comp.some((u) => [...g.adj[u].keys()].some((v) => units[v].hub));
  for (const comp of fams) {
    const sz = comp.reduce((s, u) => s + units[u].size, 0);
    if (sz > max) clusterFamily(comp, g, max, opts.resolution ?? RESOLUTION).forEach((p) => big.push(p));
    else if (sz < small) (nearHub(comp) ? sats : tinyFams).push(comp);   // a tiny family whose only roads run to a hub waits for the hub
    else big.push({ u: comp, sz });
  }
  groupSmall(tinyFams, g, boxOf, max).forEach((p) => big.push(p));
  big.forEach(claim);

  // hubs: into the part that sends them the most roads and has room; else a part of their own
  const hubs = units.map((u, i) => (u.hub ? i : -1)).filter((i) => i >= 0).sort((a, b) => early(units[a].members) - early(units[b].members));
  for (const h of hubs) {
    const tally = new Map();
    for (const v of g.cnt[h].keys()) {
      const q = owner[v]; if (!q) continue;
      const t = tally.get(q) || [0, 0]; t[0] += send[v].get(h) || 0; t[1] += send[h].get(v) || 0; tally.set(q, t);
    }
    const cands = [...tally].sort((x, y) => y[1][0] - x[1][0] || y[1][1] - x[1][1] || lead(x[0]) - lead(y[0]));
    const to = cands.find(([q]) => q.sz + units[h].size <= max);
    if (to) { to[0].u.push(h); to[0].sz += units[h].size; owner[h] = to[0]; } else claim({ u: [h], sz: units[h].size });
  }

  // tiny families whose only roads run to a hub join the part that holds that hub, if there is room; else they pair up by file like the others
  const left = [];
  for (const comp of sats) {
    const sz = comp.reduce((t, u) => t + units[u].size, 0), tally = new Map();
    for (const u of comp) for (const [v, c] of cnt[u]) if (units[v].hub && owner[v]) tally.set(owner[v], (tally.get(owner[v]) || 0) + c);
    const to = [...tally].sort((x, y) => y[1] - x[1] || lead(x[0]) - lead(y[0])).find(([q]) => q.sz + sz <= max);
    if (!to) { left.push(comp); continue; }
    to[0].u.push(...comp); to[0].sz += sz; for (const u of comp) owner[u] = to[0];
  }
  groupSmall(left, g, boxOf, max).forEach(claim);

  const live = () => parts.filter((p) => p.u.length);
  const talk = (p) => { const m = new Map(); for (const u of p.u) for (const [v, c] of cnt[u]) { const q = owner[v]; if (q && q !== p) m.set(q, (m.get(q) || 0) + c); } return m; };

  // step 5: a small part that has a road to another part joins the one it talks to most, if the cap allows
  const mergeTiny = () => {
    const stuck = new Set();
    for (;;) {
      const p = live().filter((x) => x.sz < tiny && !stuck.has(x)).sort((a, b) => a.sz - b.sz || lead(a) - lead(b))[0];
      if (!p) return;
      const to = [...talk(p)].sort((x, y) => y[1] - x[1] || lead(x[0]) - lead(y[0])).find(([q]) => q.sz + p.sz <= max);
      if (!to) { stuck.add(p); continue; }
      const q = to[0];
      for (const u of p.u) owner[u] = q;
      q.u.push(...p.u); q.sz += p.sz; p.u = []; p.sz = 0;
    }
  };

  // moving single units to the part that holds more of their roads; the part they leave must stay in one piece
  const stays = (p, u) => {
    const rest = p.u.filter((x) => x !== u);
    if (rest.length < 2) return true;
    const inP = new Set(rest), seen = new Set([rest[0]]), stack = [rest[0]];
    while (stack.length) { const x = stack.pop(); for (const v of cnt[x].keys()) if (inP.has(v) && !seen.has(v)) { seen.add(v); stack.push(v); } }
    return seen.size === rest.length;
  };
  const refine = () => {
    const order = units.map((_, i) => i).filter((i) => !units[i].hub && !lone.has(i)).sort((a, b) => early(units[a].members) - early(units[b].members));
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const u of order) {
        const cur = owner[u], w = new Map();
        for (const [v, x] of g.adj[u]) { const q = owner[v]; if (q) w.set(q, (w.get(q) || 0) + x); }
        let best = null, gain = EPS;
        for (const [q, x] of [...w].sort((a, b) => lead(a[0]) - lead(b[0]))) {
          if (q === cur || q.sz + units[u].size > max) continue;
          const d = x - (w.get(cur) || 0);
          if (d > gain + EPS && stays(cur, u)) { best = q; gain = d; }
        }
        if (!best) continue;
        cur.u = cur.u.filter((x) => x !== u); cur.sz -= units[u].size;
        best.u.push(u); best.sz += units[u].size; owner[u] = best; moved = true;
      }
      if (!moved) break;
    }
  };
  mergeTiny(); refine(); mergeTiny(); refine(); mergeTiny();
  parts = live();

  // order: by the earliest reading position of any box; model order inside a part
  const out = parts.map((p) => p.u.flatMap((u) => units[u].members).sort((a, b) => pos.get(a) - pos.get(b)));
  out.sort((a, b) => Math.min(...a.map((id) => rpos.get(id))) - Math.min(...b.map((id) => rpos.get(id))));
  if (lone.size) {
    const loose = [...lone].flatMap((u) => units[u].members).sort((a, b) => pos.get(a) - pos.get(b));
    const files = uniq(loose.map((id) => firstPath(boxOf.get(id)) || ''));
    const grouped = loose.slice().sort((a, b) => files.indexOf(firstPath(boxOf.get(a)) || '') - files.indexOf(firstPath(boxOf.get(b)) || '') || pos.get(a) - pos.get(b));
    const k = Math.ceil(grouped.length / max), per = Math.ceil(grouped.length / k);
    for (let i = 0; i < grouped.length; i += per) out.push(grouped.slice(i, i + per).sort((a, b) => pos.get(a) - pos.get(b)));
  }
  return out;
}

// the entry box of a part: its first box in reading order (`order` is readingOrder of the whole stage)
export function entryOf(ids, order) {
  const at = new Map(order.map((id, i) => [id, i]));
  return ids.slice().sort((a, b) => at.get(a) - at.get(b))[0];
}
