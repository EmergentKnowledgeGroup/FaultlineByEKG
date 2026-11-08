// Grid-map layout + libavoid orthogonal routing + label placement.
//
// graph: { id, nodes:[{id,title,kind,handle?,family?}], edges:[{id,from,to,type,label,inferred?}], text? }. A node's kind may also be
// given as `category`. text = { nodes:{id:{title,handle}}, edges:{id:{short}} } overrides the wording without touching the graph.
// An edge with no label text gets no label pill. There is no automatic placement: cfg.map is required (placeChart writes one).
//
// layoutConfig (<project>/.faultline/layout/<chartId>.json):
// {
//   "map": [ "idA  idB  .    idC",        // ASCII map: one string per row, whitespace separated tokens.
//            ".    idD  idE  .  " ],      //   token = node id, "." = empty cell. Columns line up by token index.
//   "gapX": 120, "gapY": 64,               // channel space between columns / rows (routing + labels live here)
//   "colGap": { "2": 200 },                // optional extra gap AFTER column index N   (0-based)
//   "rowGap": { "1": 120 },                // optional extra gap AFTER row index N
//   "offset": { "idC": [0, 30] },          // optional pixel nudge of a node from its cell center
//   "align": { "idB": "left" },            // optional per-node horizontal alignment inside its column: left|center|right
//   "ports": { "<edgeId>": { "from": "E", "to": "W" } },   // optional side hints: N|E|S|W  (edgeId = the graph's own edge id)
//   "via": { "<edgeId>": [[col,row],...] },  // optional: force a route through cell-coordinate checkpoints (fractional ok; 1.5 = channel between col 1 and 2)
//   "labelAt": { "<edgeId>": { "seg": 1, "t": 0.5 } },   // optional: pin the label to segment index + fraction (see "Whole-system-scale options" below for side/from/dx/dy)
//   "groups": [ { "id":"g1","title":"STAGE","nodes":["a","b"],"pad":26 } ],   // drawn as labelled bands behind the nodes
//   "nodeMaxChars": 22, "edgeMaxChars": 20, "minNodeW": 150, "lineH": 19,
//   "glyph": { "node": 7.9, "edge": 6.9 },   // average glyph advance in px of the node font (15px) and edge-label font (13px); sizes boxes and pills
//   "route": { "segmentPenalty": 40, "crossingPenalty": 120, "shapeBuffer": 18, "nudge": 14 }
// }
//
// ---- Whole-system-scale options (all OPT-IN: a config that does not use them yields byte-identical geometry) ---------------
//   labelAt[edge] extra keys:  "side":"above|below|left|right"  put the pill NEXT to the line instead of centred ON it
//                                 (above/below suit horizontal segments, left/right vertical ones; the pill is centred on the other axis)
//                              "from":"source|target"  count "seg" from the source end (default, seg 0 = first segment) or from the
//                                 target end (seg 0 = last segment, i.e. the one with the arrowhead); "t" is then measured from the
//                                 end of that segment that lies towards the target (t 0.2 = 20% of the way back from the arrowhead side)
//                              "dx","dy"  pixel nudge applied last.
//   "labelPinFirst": true      place pinned labels (labelAt) BEFORE the automatic ones so auto labels avoid them (default: pinned labels are
//                                 placed in route-length order and earlier auto labels cannot see them).
//   "labelSearch": "wide"      when the normal candidate set only offers positions that overlap a node or another label (penalty >= 1500)
//                                 try a much denser second candidate set (t every 5%, three pill offsets from the line).
//   "pinOrder": { "<nodeId>:<N|E|S|W>": ["<edgeId or eN>", "*", "<edgeId>"] }   explicit order of the pins on one node side, from the
//                                 left (N/S sides) or top (E/W sides). "*" stands for all unlisted edges in the default order
//                                 (default order = by far-end coordinate); without "*" unlisted edges follow the listed ones. Pins are only the
//                                 STARTING order: with the default router option libavoid re-sorts/slides the end segments while nudging (measured:
//                                 3 pins on one side came out in a different order), so combine with route.fixedEnds when the order must hold.
//   route.fixedEnds: true      keep the end segments of connectors on their pins (libavoid option nudgeOrthogonalSegmentsConnectedToShapes off).
//   "pinPitch": 14             minimum distance in px between adjacent pins on a node side: nodes whose side carries k pins are made
//                                 taller (E/W) or wider (N/S) until (k-1)*pitch fits into the 80% of the side that pins use. 0/absent = off.
//                                 (libavoid may still slide connection points along the side while nudging; on a dense map this cut trackOverlaps sharply.)
//                                 Growing a node can flip the sides its edges pick, so the check is repeated (up to 6 passes) until every side fits.
//   groups[].pad               number (all sides) or { "t":..,"r":..,"b":..,"l":.. } (missing keys default to 26). The 22px title strip is
//                                 added above "t".
//   "groupIncludeLabels": true (or groups[].includeLabels) grow each group band so it contains the label pills of the edges whose both ends
//                                 are inside the group (then pad is added around that bigger box).
//   "selfLoops": { "<edgeId>": { "from":"E", "to":"N", "a":0.28, "b":0.78, "r":30 } }   hand-routed self-loop leaving side "from" at fraction
//                                 "a" of that side and re-entering side "to" at fraction "b", "r" px away from the node. from/to must be
//                                 adjacent sides (E-N, N-W, W-S, S-E or mirrored). Without this key the old fixed loop (E 28% -> N 78%) is used.
//   "spine": ["idA","idB",...] happy path: every edge from spine[i] to spine[i+1] gets spine:true in the geometry (nodes on the spine get
//                                 spine:true as well). The renderer decides what to do with the flag.
//   via points may carry pixel offsets [col,row,dx,dy] (added after the cell->pixel mapping) so parallel lanes through one channel get
//                                 different tracks; checkpoints that are exactly equal are NOT nudged apart by libavoid (measured: 1000+ overlaps).
//   "viaMode": "channel"      make via coordinates exact: x.5 is the middle of the clear channel between column x and x+1 (rows likewise) even with unequal
//                                 column widths / colGap; the default mode interpolates between column CENTRES (1.5 is then not the channel middle).
//                                 The checkpoint itself is exact (verified to 0.0px with route.nudge 0); nudging afterwards may move the segment up to
//                                 ~`nudge` px (14) away from it, towards the middle of the free space.
//   route.shards: "groups"     SPEED: libavoid pays for every crossing check against every other route, so cost grows ~quadratically with
//                                 the connector count and with route length. "groups" routes the edges whose two ends sit in the same cfg
//                                 group in one router per group and all remaining (cross-group) edges in one more router ("rest"); every
//                                 router still contains ALL nodes as obstacles. On a dense map this cuts routing time several times over.
//                                 Routers do not see each other's routes, so edges of different shards can lie on the same track (more
//                                 trackOverlaps than a single router); use it for iteration, check the final layout without it.
//   route.shardMap: { "<edgeId>": "<key>" }   explicit shard assignment (edges not listed go to "rest").
//   route.params / route.options   raw libavoid RoutingParameter / RoutingOption overrides, e.g. { "params": {"crossingPenalty": 0} }
//                                 (libavoid's own names, e.g. fixedSharedPathPenalty not sharedPathPenalty; an unknown name throws).
//                                 crossingPenalty 0 ("fast mode") routes that dense map in ~0.6 s instead of ~80 s but routes then happily
//                                 share corridors and more tracks end up on top of each other.
// gridLayout.lastTimings (function property, not part of the geometry) holds performance.now() stamps of the last call
// ({t0,tSetup,tRoute,tClean,tLabels,shards:[{edges,ms}]}).
import { AvoidLib } from 'libavoid-js';
import { wrapText, wrapLabel, nameLines, nodeSize, edgeLabelSize } from './layout.mjs';

let Avoid = null;
async function lib() { if (!Avoid) { await AvoidLib.load(); Avoid = AvoidLib.getInstance(); } return Avoid; }

const DIR = { N: 1, S: 2, W: 4, E: 8 };               // libavoid ConnDirFlags: Up=1 Down=2 Left=4 Right=8
const SIDES = ['N', 'E', 'S', 'W'];
const OUT = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] };

export function parseMap(map) {
  const cells = {};
  map.forEach((row, r) => row.trim().split(/\s+/).forEach((tok, c) => { if (tok !== '.' && tok !== '_') { if (cells[tok]) throw new Error('node placed twice in map: ' + tok); cells[tok] = { col: c, row: r }; } }));
  return cells;
}

// explicit pin order for one node side: list = default-ordered slots [{e,end}], po = ["eId", "*", ...]
function applyPinOrder(list, po) {
  const match = (s, tok) => s.e.id === tok || s.e.id.endsWith(':' + tok) || s.e.id.endsWith(':e' + tok);
  const used = new Set(), out = [];
  const take = tok => { for (const s of list) if (!used.has(s) && match(s, tok)) { used.add(s); return s; } return null; };
  const star = po.indexOf('*');
  const head = star < 0 ? po : po.slice(0, star), tail = star < 0 ? [] : po.slice(star + 1);
  for (const tok of head) { const s = take(tok); if (s) out.push(s); }
  const tailSlots = tail.map(tok => take(tok)).filter(Boolean);
  for (const s of list) if (!used.has(s)) out.push(s);
  return out.concat(tailSlots);
}

// hand-routed self-loop: leave side `from` at fraction a, come back to side `to` at fraction b, r px away from the node
function selfLoopRoute(n, sl, id) {
  const from = sl.from || 'E', to = sl.to || 'N', a = sl.a ?? 0.28, b = sl.b ?? 0.78, r = sl.r ?? 30;
  const horiz = s => s === 'E' || s === 'W';
  if (!OUT[from] || !OUT[to] || horiz(from) === horiz(to)) throw new Error(`selfLoops[${id}]: from/to must be adjacent sides (got ${from}/${to})`);
  const at = (s, f) => s === 'N' ? [n.x + n.w * f, n.y] : s === 'S' ? [n.x + n.w * f, n.y + n.h] : s === 'W' ? [n.x, n.y + n.h * f] : [n.x + n.w, n.y + n.h * f];
  const p0 = at(from, a), p4 = at(to, b);
  const p1 = [p0[0] + OUT[from][0] * r, p0[1] + OUT[from][1] * r], p3 = [p4[0] + OUT[to][0] * r, p4[1] + OUT[to][1] * r];
  const p2 = horiz(from) ? [p1[0], p3[1]] : [p3[0], p1[1]];
  return [p0, p1, p2, p3, p4];
}

export async function gridLayout(graph, cfg = {}) {
  const A = await lib();
  const tm = { t0: performance.now() }; gridLayout.lastTimings = tm;
  const c = { gapX: 170, gapY: 70, nodeMaxChars: 22, edgeMaxChars: 20, minNodeW: 150, lineH: 19, ...cfg };
  const warnings = [];
  const textOf = graph.text || {};
  if (!graph.nodes.length) return { id: graph.id, width: 20, height: 20, nodes: [], edges: [], clusters: [] };
  if (!c.map?.length) throw new Error('gridLayout needs cfg.map (an ASCII grid that places every node; there is no automatic placement). placeChart(graph) writes one.');
  const ids = new Set();
  for (const n of graph.nodes) { if (ids.has(n.id)) throw new Error('duplicate node id: ' + n.id); ids.add(n.id); }
  for (const e of graph.edges) for (const end of [e.from, e.to]) if (!ids.has(end)) throw new Error(`edge ${e.id} references unknown node ${end}`);
  const cells = parseMap(c.map);
  const missing = graph.nodes.filter(n => !cells[n.id]).map(n => n.id);
  const unknown = Object.keys(cells).filter(id => !graph.nodes.some(n => n.id === id));
  if (missing.length || unknown.length) throw new Error(`map mismatch. missing from map: [${missing}] unknown in map: [${unknown}]`);
  if (c.spine) { const bad = c.spine.filter(id => !cells[id]); if (bad.length) throw new Error('spine: unknown node ids [' + bad + ']'); }

  // ---- plan: node sizes -> grid positions -> sides -> ordered pin slots. `grow` = {nodeId:{w,h}} minimum sizes (pinPitch second pass)
  const makePlan = grow => {
    const N = {};
    for (const n of graph.nodes) {
      const title = textOf.nodes?.[n.id]?.title || n.title;
      const greedy = wrapText(title, c.nodeMaxChars);          // the box is sized from the greedy wrap; the name is drawn in even lines inside that same width (balanceLines: same words, same count, never wider)
      const lines = nameLines(greedy, n.kind ?? n.category);
      let { w, h } = nodeSize(greedy, c);
      if (grow?.[n.id]) { w = Math.max(w, grow[n.id].w || 0); h = Math.max(h, grow[n.id].h || 0); }
      const handle = textOf.nodes?.[n.id]?.handle || n.handle;
      N[n.id] = { id: n.id, lines, w, h, kind: n.kind ?? n.category, title, ...(handle ? { handle } : {}), ...(n.family ? { family: n.family } : {}), ...cells[n.id] };
    }
    const nCols = Math.max(...Object.values(cells).map(x => x.col)) + 1, nRows = Math.max(...Object.values(cells).map(x => x.row)) + 1;
    const colW = Array(nCols).fill(0), rowH = Array(nRows).fill(0);
    for (const n of Object.values(N)) { colW[n.col] = Math.max(colW[n.col], n.w); rowH[n.row] = Math.max(rowH[n.row], n.h); }
    const colX = [], rowY = [];
    let x = 0; for (let i = 0; i < nCols; i++) { colX[i] = x; x += colW[i] + c.gapX + (c.colGap?.[i] || 0); }
    let y = 0; for (let i = 0; i < nRows; i++) { rowY[i] = y; y += rowH[i] + c.gapY + (c.rowGap?.[i] || 0); }
    for (const n of Object.values(N)) {
      const al = c.align?.[n.id] || 'center';
      n.x = colX[n.col] + (al === 'left' ? 0 : al === 'right' ? colW[n.col] - n.w : (colW[n.col] - n.w) / 2) + (c.offset?.[n.id]?.[0] || 0);
      n.y = rowY[n.row] + (rowH[n.row] - n.h) / 2 + (c.offset?.[n.id]?.[1] || 0);
    }

    const colC = colX.map((x0, i) => x0 + colW[i] / 2), rowC = rowY.map((y0, i) => y0 + rowH[i] / 2);
    const lerpIdx = (arr, v) => { if (v <= 0) return arr[0] + v * (arr[1] - arr[0] || 200); const i = Math.floor(v); if (i >= arr.length - 1) return arr[arr.length - 1] + (v - (arr.length - 1)) * (arr[arr.length - 1] - arr[arr.length - 2] || 200); return arr[i] + (arr[i + 1] - arr[i]) * (v - i); };
    // viaMode 'channel': v = i + 0.5 is the exact middle of the clear gap between column/row i and i+1 (also with unequal column widths or colGap);
    // integers stay the cell centres and everything in between is interpolated piecewise-linearly through those three anchors.
    const chanIdx = (arr, X, W, v) => {
      const n = arr.length;
      if (v <= 0 || v >= n - 1) return lerpIdx(arr, v);
      const i = Math.floor(v), f = v - i, mid = (X[i] + W[i] + X[i + 1]) / 2;
      return f < 0.5 ? arr[i] + (mid - arr[i]) * (f * 2) : mid + (arr[i + 1] - mid) * ((f - 0.5) * 2);
    };
    const cellToPx = c.viaMode === 'channel' ? (vc, vr) => [chanIdx(colC, colX, colW, vc), chanIdx(rowC, rowY, rowH, vr)] : (vc, vr) => [lerpIdx(colC, vc), lerpIdx(rowC, vr)];

    // side choice per edge
    const E = graph.edges.map(e => {
      const a = N[e.from], b = N[e.to];
      const lines = wrapLabel(textOf.edges?.[e.id]?.short || e.label, c.edgeMaxChars);
      const rec = { ...e, a, b, lines, ...edgeLabelSize(lines, c) };
      const h = c.ports?.[e.id] || {};
      const self = e.from === e.to;
      if (self) { const sl = c.selfLoops?.[e.id]; rec.sa = sl?.from || h.from || 'E'; rec.sb = sl?.to || h.to || 'N'; }
      else {
        const dx = (b.x + b.w / 2) - (a.x + a.w / 2), dy = (b.y + b.h / 2) - (a.y + a.h / 2);
        // overlapping column ranges -> vertical connection; otherwise dominant axis
        const colOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 24, rowOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 12;
        let sa, sb;
        if (colOverlap && !rowOverlap) { sa = dy > 0 ? 'S' : 'N'; sb = dy > 0 ? 'N' : 'S'; }
        else if (rowOverlap && !colOverlap) { sa = dx > 0 ? 'E' : 'W'; sb = dx > 0 ? 'W' : 'E'; }
        else if (Math.abs(dx) >= Math.abs(dy)) { sa = dx > 0 ? 'E' : 'W'; sb = dx > 0 ? 'W' : 'E'; }
        else { sa = dy > 0 ? 'S' : 'N'; sb = dy > 0 ? 'N' : 'S'; }
        rec.sa = h.from || sa; rec.sb = h.to || sb;
      }
      return rec;
    });

    // pin slots: order edges on each node side by the coordinate of the far end (or cfg.pinOrder), then assign ids + positions
    const slots = {}; // key nodeId:side -> [{e, end:'a'|'b'}]
    for (const e of E) {
      if (e.from === e.to) continue;
      for (const end of ['a', 'b']) {
        const nid = end === 'a' ? e.from : e.to, side = end === 'a' ? e.sa : e.sb;
        (slots[nid + ':' + side] ||= []).push({ e, end });
      }
    }
    let classId = 100;
    for (const key of Object.keys(slots)) {
      const [nid, side] = key.split(':');
      let list = slots[key];
      const far = s => { const o = s.end === 'a' ? N[s.e.to] : N[s.e.from]; return (side === 'N' || side === 'S') ? o.x + o.w / 2 : o.y + o.h / 2; };
      list.sort((p, q) => far(p) - far(q));
      const po = c.pinOrder?.[key];
      if (po) list = slots[key] = applyPinOrder(list, po);
      const k = list.length;
      list.forEach((s, i) => {
        // spread slots over the middle 80% of the side; a single edge uses the center
        const t = k === 1 ? 0.5 : 0.1 + 0.8 * (i / (k - 1));
        s.px = side === 'W' ? 0 : side === 'E' ? 1 : t; s.py = side === 'N' ? 0 : side === 'S' ? 1 : t;
        s.classId = classId++; s.side = side; s.nid = nid;
      });
    }
    return { N, E, slots, cellToPx };
  };

  let plan = makePlan(null);
  if (c.pinPitch > 0) {
    // growing a node moves its centre, which can flip the side an edge picks (and so the pin count of a side): re-check after every growth
    // pass (sizes only ever grow, so this terminates; capped at 6 passes). Identical to a single pass whenever one pass already suffices.
    const need = {};
    for (let pass = 0; pass < 6; pass++) {
      let grew = false;
      for (const [key, list] of Object.entries(plan.slots)) {
        if (list.length < 2) continue;
        const [nid, side] = key.split(':'); const n = plan.N[nid];
        const L = Math.ceil((list.length - 1) * c.pinPitch / 0.8), horizSide = side === 'N' || side === 'S', dim = horizSide ? 'w' : 'h';
        if (n[dim] < L) { (need[nid] ||= {})[dim] = Math.max(need[nid]?.[dim] || 0, L); grew = true; }
      }
      if (!grew) break;
      plan = makePlan(need);
    }
  }
  const { N, E, slots, cellToPx } = plan;

  // ---- routing ---------------------------------------------------------------------------------------------------------
  const P = c.route || {};
  const makeRouter = () => {
    const router = new A.Router(A.RouterFlag.OrthogonalRouting.value);
    router.setRoutingParameter(A.RoutingParameter.segmentPenalty, P.segmentPenalty ?? 60);
    router.setRoutingParameter(A.RoutingParameter.crossingPenalty, P.crossingPenalty ?? 200);
    router.setRoutingParameter(A.RoutingParameter.fixedSharedPathPenalty, P.sharedPathPenalty ?? 4000);
    router.setRoutingParameter(A.RoutingParameter.portDirectionPenalty, P.portDirectionPenalty ?? 400);
    router.setRoutingParameter(A.RoutingParameter.shapeBufferDistance, P.shapeBuffer ?? 16);
    router.setRoutingParameter(A.RoutingParameter.idealNudgingDistance, P.nudge ?? 14);
    router.setRoutingOption(A.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes, true);
    router.setRoutingOption(A.RoutingOption.nudgeSharedPathsWithCommonEndPoint, true);
    router.setRoutingOption(A.RoutingOption.performUnifyingNudgingPreprocessingStep, true);
    router.setRoutingOption(A.RoutingOption.penaliseOrthogonalSharedPathsAtConnEnds, true);
    if (P.fixedEnds) router.setRoutingOption(A.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes, false);   // opt-in: end segments stay on their pins
    for (const [k, v] of Object.entries(P.params || {})) { if (!A.RoutingParameter[k]) throw new Error(`route.params: unknown libavoid RoutingParameter "${k}"`); router.setRoutingParameter(A.RoutingParameter[k], v); }   // opt-in raw libavoid parameter overrides
    for (const [k, v] of Object.entries(P.options || {})) { if (!A.RoutingOption[k]) throw new Error(`route.options: unknown libavoid RoutingOption "${k}"`); router.setRoutingOption(A.RoutingOption[k], !!v); }     // opt-in raw libavoid option overrides
    return router;
  };

  // route the edges E[idx[0]], E[idx[1]]... in ONE libavoid router that contains every node as an obstacle; returns {edgeIndex: pts}
  const routeSet = idx => {
    const router = makeRouter();
    const inSet = new Set(idx.map(i => E[i]));
    const shapes = {};
    for (const n of Object.values(N)) {
      shapes[n.id] = new A.ShapeRef(router, new A.Rectangle(new A.Point(n.x, n.y), new A.Point(n.x + n.w, n.y + n.h)));
    }
    for (const list of Object.values(slots)) {
      for (const s of list) {
        if (!inSet.has(s.e)) continue;
        const pin = new A.ShapeConnectionPin(shapes[s.nid], s.classId, s.px, s.py, true, 0, DIR[s.side]);
        pin.setExclusive(true);
      }
    }
    const conns = idx.map(i => {
      const e = E[i];
      const sa = slots[e.from + ':' + e.sa].find(s => s.e === e && s.end === 'a'), sb = slots[e.to + ':' + e.sb].find(s => s.e === e && s.end === 'b');
      const cr = new A.ConnRef(router, new A.ConnEnd(shapes[e.from], sa.classId), new A.ConnEnd(shapes[e.to], sb.classId));
      cr.setRoutingType(A.ConnType.ConnType_Orthogonal.value);
      const via = c.via?.[e.id];
      if (via?.length) {
        const vec = new A.CheckpointVector();
        for (const [vc, vr, vdx, vdy] of via) { const q = cellToPx(vc, vr); vec.push_back(new A.Checkpoint(new A.Point(q[0] + (vdx || 0), q[1] + (vdy || 0)))); }
        cr.setRoutingCheckpoints(vec);
      }
      return cr;
    });
    const t0 = performance.now();
    router.processTransaction();
    (tm.shards ||= []).push({ edges: idx.length, ms: Math.round(performance.now() - t0) });
    const res = {};
    conns.forEach((cr, k) => {
      const pl = cr.displayRoute(); const pts = [];
      for (let i = 0; i < pl.size(); i++) { const p = pl.at(i); pts.push([Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]); }
      res[idx[k]] = pts;
    });
    router.delete?.();
    return res;
  };

  tm.tSetup = performance.now();
  const routable = E.map((e, i) => i).filter(i => E[i].from !== E[i].to);
  const routed = {};
  if (P.shards || P.shardMap) {
    const groupsOf = new Map();                                   // node id -> first group index containing it
    (c.groups || []).forEach((g, gi) => g.nodes.forEach(id => { if (!groupsOf.has(id)) groupsOf.set(id, gi); }));
    const keyOf = i => {
      const e = E[i];
      if (P.shardMap && P.shardMap[e.id] !== undefined) return 'm:' + P.shardMap[e.id];
      if (P.shards === 'groups') { const ga = groupsOf.get(e.from); if (ga !== undefined && ga === groupsOf.get(e.to)) return 'g:' + (c.groups[ga].id ?? ga); }
      return '~rest';
    };
    const buckets = new Map();
    for (const i of routable) { const k = keyOf(i); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(i); }
    const keys = [...buckets.keys()].sort((p, q) => (p === '~rest') - (q === '~rest'));
    for (const k of keys) Object.assign(routed, routeSet(buckets.get(k)));
  } else if (routable.length) {
    Object.assign(routed, routeSet(routable));
  }
  tm.tRoute = performance.now();
  const routes = E.map((e, i) => {
    if (e.from === e.to) {
      const n = N[e.from], sl = c.selfLoops?.[e.id];
      if (sl) return selfLoopRoute(n, sl, e.id);
      const r = 30;
      return [[n.x + n.w, n.y + n.h * 0.28], [n.x + n.w + r, n.y + n.h * 0.28], [n.x + n.w + r, n.y - r], [n.x + n.w * 0.78, n.y - r], [n.x + n.w * 0.78, n.y]];
    }
    return routed[i];
  });

  // normalise: drop zero-length + collinear points
  const clean = pts => {
    const o = [];
    for (const p of pts) { const l = o[o.length - 1]; if (l && Math.abs(l[0] - p[0]) < 0.3 && Math.abs(l[1] - p[1]) < 0.3) continue; o.push(p); }
    const r = [];
    for (let i = 0; i < o.length; i++) {
      if (i > 0 && i < o.length - 1) { const a = o[i - 1], b = o[i], d = o[i + 1]; if ((Math.abs(a[0] - b[0]) < 0.3 && Math.abs(b[0] - d[0]) < 0.3) || (Math.abs(a[1] - b[1]) < 0.3 && Math.abs(b[1] - d[1]) < 0.3)) continue; }
      r.push(o[i]);
    }
    return r;
  };
  E.forEach((e, i) => { e.pts = clean(routes[i]); });

  tm.tClean = performance.now();
  placeLabels(E, N, c.labelAt || {}, { pinFirst: !!c.labelPinFirst, wide: c.labelSearch === 'wide' });
  tm.tLabels = performance.now();

  // happy path flags
  const spineEdge = new Set(), spineNode = new Set(c.spine || []);
  (c.spine || []).forEach((id, i, arr) => {
    if (i === arr.length - 1) return;
    const key = id + '>' + arr[i + 1]; spineEdge.add(key);
    if (!graph.edges.some(e => e.from === id && e.to === arr[i + 1])) warnings.push(`spine: no edge ${id} -> ${arr[i + 1]}`);
  });

  // bounding box -> shift to positive coords with padding
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  const grow = (px, py) => { minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py); };
  Object.values(N).forEach(n => { grow(n.x, n.y); grow(n.x + n.w, n.y + n.h); });
  E.forEach(e => { e.pts.forEach(p => grow(p[0], p[1])); if (e.labelBox) { grow(e.labelBox.x, e.labelBox.y); grow(e.labelBox.x + e.labelBox.w, e.labelBox.y + e.labelBox.h); } });
  const clusters = (c.groups || []).map(g => {
    const mem = g.nodes.map(id => N[id]).filter(Boolean);
    const pad = g.pad ?? 26;
    const pd = (pad !== null && typeof pad === 'object') ? { t: pad.t ?? 26, r: pad.r ?? 26, b: pad.b ?? 26, l: pad.l ?? 26 } : { t: pad, r: pad, b: pad, l: pad };
    let bx0 = Math.min(...mem.map(n => n.x)), by0 = Math.min(...mem.map(n => n.y)), bx1 = Math.max(...mem.map(n => n.x + n.w)), by1 = Math.max(...mem.map(n => n.y + n.h));
    if (g.includeLabels ?? c.groupIncludeLabels) {
      const ids = new Set(g.nodes);
      for (const e of E) if (e.labelBox && ids.has(e.from) && ids.has(e.to)) {
        bx0 = Math.min(bx0, e.labelBox.x); by0 = Math.min(by0, e.labelBox.y); bx1 = Math.max(bx1, e.labelBox.x + e.labelBox.w); by1 = Math.max(by1, e.labelBox.y + e.labelBox.h);
      }
    }
    const x0 = bx0 - pd.l, y0 = by0 - pd.t - 22, x1 = bx1 + pd.r, y1 = by1 + pd.b;
    grow(x0, y0); grow(x1, y1);
    return { id: g.id, title: g.title, x: x0, y: y0, w: x1 - x0, h: y1 - y0, tone: g.tone || null, nodes: g.nodes };
  });
  const dx = -minX + 10, dy = -minY + 10;
  return {
    id: graph.id, width: maxX - minX + 20, height: maxY - minY + 20,
    nodes: Object.values(N).map(n => ({ id: n.id, x: n.x + dx, y: n.y + dy, w: n.w, h: n.h, lines: n.lines, kind: n.kind, title: n.title, col: n.col, row: n.row, ...(n.handle ? { handle: n.handle } : {}), ...(n.family ? { family: n.family } : {}), ...(spineNode.has(n.id) ? { spine: true } : {}) })),
    edges: E.map(e => ({
      id: e.id, from: e.from, to: e.to, type: e.type, label: e.lines.join(' '), lines: e.lines,
      pts: e.pts.map(p => [p[0] + dx, p[1] + dy]),
      labelBox: e.labelBox ? { x: e.labelBox.x + dx, y: e.labelBox.y + dy, w: e.labelBox.w, h: e.labelBox.h } : null,
      sides: [e.sa, e.sb],
      ...(e.inferred ? { inferred: true } : {}),
      ...(spineEdge.has(e.from + '>' + e.to) ? { spine: true } : {}),
    })),
    clusters: clusters.map(k => ({ ...k, x: k.x + dx, y: k.y + dy })),
    ...(warnings.length ? { warnings } : {}),
  };
}

// ---- label placement ----------------------------------------------------------------------------------------------
// Greedy: for each edge, candidate positions along its route (centered ON a segment); pick the lowest-penalty one.
// opt.pinFirst: pinned (labelAt) labels are placed before all others.  opt.wide: denser fallback candidate set when the best normal one overlaps.
// E: [{id, pts, lw, lh}] (an edge with lw 0 has no label and is skipped but still counts as a line other labels avoid); N: {id:{x,y,w,h}}.
// Sets e.labelBox on every labelled edge. Exported so labels.mjs can verify its pins through the very same code path.
export function placeLabels(E, N, hints, opt = {}) {
  const placed = [];
  const segs = e => e.pts.slice(0, -1).map((p, i) => [p, e.pts[i + 1]]);
  const allSegs = E.map(e => ({ e, s: segs(e) }));
  const nodeList = Object.values(N);
  const ov = (a, b, m = 0) => a.x < b.x + b.w - m && a.x + a.w > b.x + m && a.y < b.y + b.h - m && a.y + a.h > b.y + m;
  const hitsBox = ([p, q], b) => {
    const x0 = Math.min(p[0], q[0]), x1 = Math.max(p[0], q[0]), y0 = Math.min(p[1], q[1]), y1 = Math.max(p[1], q[1]);
    return x1 > b.x && x0 < b.x + b.w && y1 > b.y && y0 < b.y + b.h;
  };
  const pinIdx = (e, ss) => { const h = hints[e.id]; if (!h) return -1; return h.from === 'target' ? ss.length - 1 - h.seg : h.seg; };
  // process shorter routes first (fewer options)
  let order = E.filter(e => e.lw > 0).sort((p, q) => routeLen(p) - routeLen(q));
  if (opt.pinFirst) order = [...order.filter(e => hints[e.id] && segs(e)[pinIdx(e, segs(e))]), ...order.filter(e => !(hints[e.id] && segs(e)[pinIdx(e, segs(e))]))];
  for (const e of order) {
    const cands = [];
    const ss = segs(e);
    const hint = hints[e.id];
    if (hint && ss[pinIdx(e, ss)]) {
      const [p, q] = ss[pinIdx(e, ss)], t = hint.t ?? 0.5;
      const fromT = hint.from === 'target';
      const cx = fromT ? q[0] + (p[0] - q[0]) * t : p[0] + (q[0] - p[0]) * t, cy = fromT ? q[1] + (p[1] - q[1]) * t : p[1] + (q[1] - p[1]) * t;
      let bx = cx - e.lw / 2, by = cy - e.lh / 2;
      if (hint.side === 'above') by = cy - e.lh - 5; else if (hint.side === 'below') by = cy + 5;
      else if (hint.side === 'left') bx = cx - e.lw - 7; else if (hint.side === 'right') bx = cx + 7;
      bx += hint.dx || 0; by += hint.dy || 0;
      const box = { x: bx, y: by, w: e.lw, h: e.lh }; e.labelBox = box; placed.push(box); continue;
    }
    ss.forEach(([p, q], si) => {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 10) return;
      const horiz = Math.abs(p[1] - q[1]) < 0.5;
      for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
        const cx = p[0] + (q[0] - p[0]) * t, cy = p[1] + (q[1] - p[1]) * t;
        const base = Math.abs(t - 0.5) * 30 + (si === 0 || si === ss.length - 1 ? 25 : 0) - Math.min(len, 400) / 12;
        const spots = [['on', cx - e.lw / 2, cy - e.lh / 2, 0]];
        if (horiz) { spots.push(['up', cx - e.lw / 2, cy - e.lh - 5, 6], ['dn', cx - e.lw / 2, cy + 5, 6]); }
        else { spots.push(['rt', cx + 7, cy - e.lh / 2, 6], ['lf', cx - e.lw - 7, cy - e.lh / 2, 6]); }
        for (const [kind, bx, by, extra] of spots) {
          // a label centered on a horizontal run must fit inside the run; beside the line it only needs to clear nodes
          const fit = horiz && kind === 'on' ? Math.min(1, len / (e.lw + 16)) : 1;
          cands.push({ box: { x: bx, y: by, w: e.lw, h: e.lh }, pen: (1 - fit) * 400 + base + extra + (!horiz && kind === 'on' ? 10 : 0) });
        }
      }
    });
    // keep the label off the arrowhead (last 18px of the route)
    const tip = e.pts[e.pts.length - 1];
    const penalize = list => {
      for (const cd of list) {
        const b = cd.box;
        if (tip && ov(b, { x: tip[0] - 18, y: tip[1] - 18, w: 36, h: 36 }, 0)) cd.pen += 300;
        for (const n of nodeList) if (ov(b, n, -2)) cd.pen += 2000;
        for (const o of placed) if (ov(b, o, -3)) cd.pen += 1500;
        for (const { e: oe, s } of allSegs) {
          if (oe === e) continue;
          for (const sg of s) if (hitsBox(sg, b)) cd.pen += 90;
        }
        // own route's other segments crossing the pill (bends inside the pill look broken)
        ss.forEach(sg => { if (hitsBox(sg, b)) cd.pen += 0; });
      }
    };
    penalize(cands);
    cands.sort((p, q) => p.pen - q.pen);
    let best = cands[0];
    if (opt.wide && (!best || best.pen >= 1500)) {
      const wide = [];
      ss.forEach(([p, q], si) => {
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (len < 10) return;
        const horiz = Math.abs(p[1] - q[1]) < 0.5;
        for (let k = 1; k <= 19; k++) {
          const t = k / 20, cx = p[0] + (q[0] - p[0]) * t, cy = p[1] + (q[1] - p[1]) * t;
          const base = Math.abs(t - 0.5) * 30 + (si === 0 || si === ss.length - 1 ? 25 : 0) - Math.min(len, 400) / 12;
          const spots = [['on', cx - e.lw / 2, cy - e.lh / 2, 0]];
          for (const off of [5, 24, 44]) {
            if (horiz) spots.push(['up', cx - e.lw / 2, cy - e.lh - off, 6 + off / 8], ['dn', cx - e.lw / 2, cy + off, 6 + off / 8]);
            else spots.push(['rt', cx + off + 2, cy - e.lh / 2, 6 + off / 8], ['lf', cx - e.lw - off - 2, cy - e.lh / 2, 6 + off / 8]);
          }
          for (const [kind, bx, by, extra] of spots) {
            const fit = horiz && kind === 'on' ? Math.min(1, len / (e.lw + 16)) : 1;
            wide.push({ box: { x: bx, y: by, w: e.lw, h: e.lh }, pen: (1 - fit) * 400 + base + extra + (!horiz && kind === 'on' ? 10 : 0) });
          }
        }
      });
      penalize(wide);
      const all = cands.concat(wide); all.sort((p, q) => p.pen - q.pen);
      best = all[0];
    }
    if (best) { e.labelBox = best.box; placed.push(best.box); }
  }
  function routeLen(e) { let l = 0; segs(e).forEach(([p, q]) => l += Math.hypot(q[0] - p[0], q[1] - p[1])); return l; }
}
