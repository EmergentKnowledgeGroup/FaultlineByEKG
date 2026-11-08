/* ================================================================ REGIONS, HALOS, MAIN PATH (for big charts such as the whole-system map)
   Spliced into viewer.js (same closure) by the assembler.  Optional data:
     chart.regions [{id, title, kind:'stage|loop|slice', color?, blurb?, nodes:[ids] (or boxes), limit?}]   (a node may sit in several; limit = what bounds a loop, '' = none shown)
     chart.spine   [node ids]  the main (happy) path
   When a chart has node.stage and no chart.regions, the regions are DERIVED: one per stage
   (titles/blurbs from chart.stages when present) and one per named loop (chart.loops [{id, title, blurb, boxes, limit}]).
   Everything after mount is class toggling: no SVG is re-rendered when a region is hovered, pinned or a halo is switched. */
var RK_WORDS = { stage: 'Stage', loop: 'Loop', slice: 'Slice' };
var RG_GROUPS = [
  { id: 'stage', title: 'Stages', sub: (META.toolMap ? 'largest first, not by run order' : 'in story order'), kinds: ['stage'] },
  { id: 'loop', title: 'Loops & slices', sub: '', kinds: ['loop', 'slice'] }
];
var RG_PAL = {
  stage: ['#4f94ff', '#2fbfd8', '#34c997', '#7fcf4a', '#d6c437', '#f0a032', '#f26f3a', '#e5546c', '#d452a6', '#a36ced', '#7b82f0', '#58a6c2'],
  loop: ['#ff5fd0', '#f5c518', '#4de3a0', '#4cc9ff', '#ff9a3c', '#b48cff', '#9be564', '#ff7a7a']
};
var rgStyle = document.createElement('style'); rgStyle.id = 'rgStyle'; document.head.appendChild(rgStyle);
/* on a laptop-sized window the Regions bar of a part chart sits in the toolbar's second row, not over the chart's top-left corner (that corner was kept free for it: 50 px of a 737 px canvas). The Regions list itself stays a drawer on the canvas. */
function placeDockBar(kind) {
  var bar = $('.rd-bar', document), tools = $('.tb-tools'), want = narrowWin() && (kind === 'stage' || kind === 'detail') && !!tools, home = $('#regionDock');
  if (!bar || !home) return;
  if (want && bar.parentNode !== tools) tools.insertBefore(bar, tools.firstChild);
  else if (!want && bar.parentNode !== home) home.insertBefore(bar, home.firstChild);
  bar.style.display = want && home.hidden ? 'none' : '';
}
var rdock = $('#regionDock'), rgPanel = $('#regionPanel'), rdRegions = $('#rdRegions'), rdHalos = $('#rdHalos'), rdSpine = $('#rdSpine'), rdLabels = $('#rdLabels');
S.regSel = [];
var SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) { var e = document.createElementNS(SVGNS, tag); if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; }
function groupKind(k) { return k === 'stage' ? 'stage' : 'loop'; }
function prettyId(s) { return String(s).replace(/^(st|m|ln)_/, '').replace(/[_-]+/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }

/* ---- which regions does a chart have? (explicit, else derived) ---- */
function deriveRegions(chart) {
  var nodes = chart.nodes, ids = Object.keys(nodes), out = [], i;
  var byStage = {}, stageOrder = [];
  ids.forEach(function (id) {
    var n = nodes[id];
    if (n.stage) { if (!byStage[n.stage]) { byStage[n.stage] = []; stageOrder.push(n.stage); } byStage[n.stage].push(id); }
  });
  var meta = {}; (Array.isArray(chart.stages) ? chart.stages : []).forEach(function (s) { if (s && s.id) meta[s.id] = s; });
  var so = (Array.isArray(chart.stages) ? chart.stages.map(function (s) { return s.id; }) : []).filter(function (s) { return byStage[s]; });
  stageOrder.forEach(function (s) { if (so.indexOf(s) < 0) so.push(s); });
  so.forEach(function (s) { out.push({ id: s, title: (meta[s] && meta[s].title) || STAGE_TITLE[s] || prettyId(s), kind: 'stage', blurb: (meta[s] && meta[s].blurb) || '', nodes: byStage[s] }); });
  (Array.isArray(chart.loops) ? chart.loops : []).forEach(function (l) { if (l && l.id) out.push({ id: l.id, title: l.title || prettyId(l.id), kind: 'loop', blurb: l.blurb || '', limit: l.limit, total: l.total, nodes: l.boxes || l.nodes || [] }); });
  return out;
}
function normRegions(chart) {
  var explicit = Array.isArray(chart.regions) && chart.regions.length, raw = explicit ? chart.regions.slice() : deriveRegions(chart), seen = {}, cnt = {}, out = [];
  raw.forEach(function (r) {
    if (!r || typeof r !== 'object') return;
    var id = String(r.id == null ? (r.title || 'r' + out.length) : r.id); if (seen[id]) return;
    var ns = []; (Array.isArray(r.nodes) ? r.nodes : Array.isArray(r.boxes) ? r.boxes : []).forEach(function (n) { if (chart.nodes[n] && ns.indexOf(n) < 0) ns.push(n); });
    if (!ns.length) return;
    var kind = RK_WORDS[r.kind] ? r.kind : 'loop', pk = kind === 'stage' ? kind : 'loop', pal = RG_PAL[pk];
    cnt[pk] = (cnt[pk] || 0) + 1;
    var color = kind === 'stage' && STAGE_HUE[id] != null ? stageCol(id) : typeof r.color === 'string' && /^#[0-9a-f]{3,8}$|^(rgb|hsl)a?\(/i.test(r.color.trim()) ? r.color.trim() : pal[(cnt[pk] - 1) % pal.length];
    seen[id] = 1;
    out.push({ id: id, title: String(r.title || id), kind: kind, color: color, blurb: r.blurb ? String(r.blurb) : '', limit: r.limit, total: r.total > ns.length ? r.total : 0, nodes: ns, set: new Set(ns), idx: out.length, path: r.path && PATHS[r.path] ? r.path : '' });
  });
  return out;
}

/* ---- statistics (cached) ---- */
function boundaryOf(set) {
  var E = C.chart.edges, internal = 0, boundary = 0, entry = {}, exit = {};
  Object.keys(E).forEach(function (eid) {
    var e = E[eid], a = set.has(e.from), b = set.has(e.to);
    if (a && b) internal++; else if (a || b) { boundary++; if (b) (entry[e.to] || (entry[e.to] = [])).push(eid); else (exit[e.from] || (exit[e.from] = [])).push(eid); }
  });
  if (!isWhole(C.chart) && C.pnode) set.forEach(function (id) {                         // hand-offs to and from other charts cross the region's edge too
    var pn = C.pnode[id]; if (!pn) return;
    realPortals(pn['in']).forEach(function (p) { boundary++; (entry[id] || (entry[id] = [])).push('p:' + p._id); });
    realPortals(pn.out).forEach(function (p) { boundary++; (exit[id] || (exit[id] = [])).push('p:' + p._id); });
  });
  return { internal: internal, boundary: boundary, entry: entry, exit: exit };
}
function tagsOfSet(set) {
  handles();
  var seen = {}, out = [];
  set.forEach(function (id) { var n = C.chart.nodes[id]; strs([hOf(n)].concat(strs(n.layers))).forEach(function (t) { if (!seen[t]) { seen[t] = 1; out.push(t); } }); });
  return out.filter(function (t) { return HIDX[t]; }).sort(tagSort);
}
function regionStats(r) {
  if (!r._st) {
    var b = boundaryOf(r.set); r._st = { nodes: r.nodes.length, internal: b.internal, boundary: b.boundary, tags: tagsOfSet(r.set) };
    // the glance draws a stage as one box: its size is the stage's own, counted once (counts.mjs stageRoads), the same numbers the whole map prints
    var sr = C.chart.kind === 'overview' && r.kind === 'stage' && META.counts && META.counts.stageRoads && META.counts.stageRoads[r.id];
    if (sr) { r._st.nodes = sr.boxes; r._st.internal = sr.inside; r._st.boundary = sr.enter + sr.leave; }
  }
  return r._st;
}
function unionSet(regs) { var s = new Set(); regs.forEach(function (r) { r.nodes.forEach(function (n) { s.add(n); }); }); return s; }

/* ---- mount: halos, titles, pips, main path ---- */
function median(a) { var b = a.slice().sort(function (x, y) { return x - y; }); return b.length ? b[Math.floor(b.length / 2)] : 0; }
function haloMarkup(X, r, pad) {
  var boxes = r.nodes.map(function (id) { return X.nb[id]; }).filter(Boolean), pts = boxes.map(function (b) { return [b.x + b.w / 2, b.y + b.h / 2]; });
  var mk = function (p, w) {
    var s = boxes.map(function (b) { return '<rect x="' + (b.x - p).toFixed(1) + '" y="' + (b.y - p).toFixed(1) + '" width="' + (b.w + 2 * p).toFixed(1) + '" height="' + (b.h + 2 * p).toFixed(1) + '" rx="' + (p * 0.8).toFixed(1) + '"/>'; }).join('');
    // connect nearby boxes (Prim on centre distance; links longer than 900 are not drawn, so a scattered region becomes separate islands, not a bar across the chart)
    var inT = [0], rest = []; for (var i = 1; i < pts.length; i++) rest.push(i);
    while (rest.length) {
      var best = null;
      rest.forEach(function (j) { inT.forEach(function (k) { var d = Math.hypot(pts[j][0] - pts[k][0], pts[j][1] - pts[k][1]); if (!best || d < best.d) best = { d: d, j: j, k: k }; }); });
      if (best.d <= 900) s += '<line x1="' + pts[best.k][0].toFixed(1) + '" y1="' + pts[best.k][1].toFixed(1) + '" x2="' + pts[best.j][0].toFixed(1) + '" y2="' + pts[best.j][1].toFixed(1) + '" stroke-width="' + w.toFixed(1) + '"/>';
      inT.push(best.j); rest.splice(rest.indexOf(best.j), 1);
    }
    return s;
  };
  return '<g class="hl-o">' + mk(pad + 18, (pad + 18) * 1.5) + '</g><g class="hl-i">' + mk(pad, pad * 1.5) + '</g>' + ringMarkup(X, r);
}
/* A loop (or a path slice) at far zoom, where its boxes are specks and its roads hairlines: a ring through its boxes in order, closed for a loop, with a fixed-size dot at each box,
   so it reads as one connected shape whatever the zoom. It shows only while the region is hovered or pinned and the names are hidden (the roads themselves read once they can). */
function ringMarkup(X, r) {
  if (r.kind !== 'loop' && r.kind !== 'slice') return '';
  var pts = r.nodes.map(function (id) { return X.nb[id]; }).filter(Boolean).map(function (b) { return [b.x + b.w / 2, b.y + b.h / 2]; });
  if (pts.length < 2) return '';
  var d = 'M' + pts.map(function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' L'), dots = pts.map(function (p) { return 'M' + p[0].toFixed(1) + ' ' + p[1].toFixed(1) + 'h0'; }).join('');
  return '<g class="loop-ring" aria-hidden="true"><path class="lr-line" d="' + d + (r.kind === 'loop' && pts.length > 2 ? ' Z' : '') + '"/><path class="lr-dots" d="' + dots + '"/></g>';
}
/* ---- a declared path (the main path, or any other) as a line on the chart. ONLY consecutive steps of the declared path light up: a step pair that is not
   consecutive in the path is never joined, however close the boxes are.  A chart that holds a single step still carries the toggle (the step is lit, and the
   hand-off where the path arrives or leaves is marked). ---- */
var PATHS = {}, MAIN_ID = '';
(Array.isArray(DATA.paths) ? DATA.paths : []).forEach(function (p, i) { if (p && p.id) { PATHS[p.id] = { id: p.id, title: p.title || p.id, blurb: p.blurb || '', boxes: strs(p.boxes) }; if (!i) MAIN_ID = p.id; } });
function pathIdsOf(pid) { var p = PATHS[pid || MAIN_ID]; return p ? p.boxes : []; }
function buildSpine(X, ids) {
  var E = new Set(), N = [], inC = function (id) { return !!X.chart.nodes[id]; }, i;
  ids.forEach(function (id) { if (inC(id) && N.indexOf(id) < 0) N.push(id); });
  if (!N.length) return null;
  for (i = 0; i + 1 < ids.length; i++) {
    var a = ids[i], b = ids[i + 1], best = null;
    if (a === b || !inC(a) || !inC(b)) continue;
    (X.out[a] || []).forEach(function (eid) { var e = X.chart.edges[eid]; if (e.to === b && (!best || (X.chart.edges[best].type === 'return' && e.type !== 'return'))) best = eid; });
    if (best) E.add(best);
  }
  return { nodes: N, edges: E, nodeSet: new Set(N), ids: ids, merged: isWhole(X.chart) };
}
function clearSpineDraw(X) {
  var d = X.spineDraw; if (!d) return;
  if (d.glow && d.glow.parentNode) d.glow.parentNode.removeChild(d.glow);
  d.edges.forEach(function (el) { el.classList.remove('spine'); }); d.nodes.forEach(function (el) { el.classList.remove('spine-n', 'sp-enter', 'sp-leave'); });
  d.marks.forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
  X.spineDraw = null;
}
function homeNameOf(id) { var c = chartForNode(id); return c && CH[c] ? CH[c].navLabel : ''; }
function drawSpine(X, sp) {
  clearSpineDraw(X);
  if (!sp) return;
  var eg = $('g.edges', X.svg), gg = svgEl('g', { 'class': 'spine-glow' }), d = X.spineDraw = { glow: sp.merged ? null : gg, edges: [], nodes: [], marks: [] };
  sp.edges.forEach(function (eid) {
    var el = X.edgeEl.get(eid); if (!el) return;
    el.classList.add('spine'); d.edges.push(el);                                                          // only the declared path's consecutive roads wear the class (the placer's own flag is stripped at mount)
    if (sp.merged) return;                                                                              // the whole map also draws its path as one merged line (viewer/whole.js)
    if (eg) eg.appendChild(el);                                                                         // path routes draw on top of the others
    var line = $('.edge-line', el); if (line) gg.appendChild(svgEl('path', { 'class': 'sglow', d: line.getAttribute('d') }));   // glow = a wide translucent underlay (no SVG filter: filters make pan/zoom slow)
  });
  if (!sp.merged && eg) X.vp.insertBefore(gg, eg);
  sp.nodes.forEach(function (n) { var el = X.nodeEl.get(n); if (el) { el.classList.add('spine-n'); d.nodes.push(el); } });
  if (sp.merged) return;
  sp.ids.forEach(function (id, i) {                                                                     // where the path arrives from another chart, and where it leaves for one
    var el = X.nodeEl.get(id), b = X.nb[id]; if (!el || !b) return;
    var prev = i > 0 ? sp.ids[i - 1] : null, next = i + 1 < sp.ids.length ? sp.ids[i + 1] : null;
    var mk = function (dir, other) {
      var g = svgEl('g', { 'class': 'sp-io sp-' + dir, 'aria-hidden': 'true', transform: 'translate(' + (dir === 'in' ? b.x - 3 : b.x + b.w + 3).toFixed(1) + ' ' + (b.y + b.h / 2).toFixed(1) + ')' }), t = svgEl('title');
      var ob = boxAny(other); t.textContent = (dir === 'in' ? 'The path arrives here from ' : 'The path leaves here for ') + (ob ? ob.title : 'another box') + (homeNameOf(other) ? ' (on ' + homeNameOf(other) + ')' : '');
      g.appendChild(svgEl('path', { d: dir === 'in' ? 'M-18 -9 L0 0 L-18 9 Z' : 'M0 -9 L18 0 L0 9 Z' })); g.appendChild(t); el.appendChild(g); d.marks.push(g); el.classList.add(dir === 'in' ? 'sp-enter' : 'sp-leave');
    };
    if (prev && !X.chart.nodes[prev]) mk('in', prev);
    if (next && !X.chart.nodes[next]) mk('out', next);
  });
}
function mountSpine(X) {
  var ids = X.chart.kind === 'overview' ? strs(X.chart.spine).filter(function (id) { return X.chart.nodes[id]; }) : pathIdsOf(MAIN_ID);
  if (X.chart.kind !== 'overview' && !ids.length) ids = strs(X.chart.spine);                              // an atlas with no declared path list: the chart's own spine
  var sp = buildSpine(X, ids); if (!sp) return null;
  sp.pid = MAIN_ID; drawSpine(X, sp); return sp;
}
/* show a declared path on the chart now on screen (the main path unless another is asked for); true when the chart holds a step of it */
function spineShow(pid) {
  var rg = C && C.rg; if (!rg) return false;
  pid = pid || MAIN_ID;
  if (!rg.spine || rg.spine.pid !== pid) {
    var sp = buildSpine(C, pathIdsOf(pid)); if (!sp) return false;
    sp.pid = pid; rg.spine = sp; drawSpine(C, sp);
    if (C.wh) wholeSpineRefresh();
    rdSpine.hidden = false;
  }
  rg.spineOn = true; rdSpine.setAttribute('aria-pressed', 'true'); C.svg.classList.add('show-spine');
  rdSpine.textContent = pid === MAIN_ID ? 'Main path' : 'Path: ' + trunc(PATHS[pid].title, 24);
  if (pid === MAIN_ID) rdSpine.title = 'Draw the main (happy) path through the chart'; else rdSpine.title = 'Path: ' + PATHS[pid].title;
  return true;
}
function mountRegions(X) {
  X.rg = null; rdock.hidden = true; rgStyle.textContent = ''; rgPanel.hidden = true; rgPanel.innerHTML = '';
  rdRegions.setAttribute('aria-expanded', 'false');
  var list = normRegions(X.chart), spine = mountSpine(X);
  if (!list.length && !spine) return;
  var rg = X.rg = { list: list, byId: {}, memb: {}, enabled: new Set(), halosOn: true, spineOn: X.chart.kind === 'overview' && !!spine, open: false, halo: {}, titleEl: {}, titles: [], pipNodes: {}, marked: [], spine: spine };
  list.forEach(function (r) { rg.byId[r.id] = r; r.nodes.forEach(function (n) { (rg.memb[n] || (rg.memb[n] = [])).push(r.idx); }); });
  var hasStage = list.some(function (r) { return r.kind === 'stage'; });
  list.forEach(function (r) { if (!hasStage || r.kind === 'stage') if (rg.enabled.size < 14) rg.enabled.add(r.id); });      // default halos: the stages
  var css = '';
  list.forEach(function (r) { css += '.atlas-svg .node.rgc-' + r.idx + '{--rgc:' + r.color + '}'; });
  rgStyle.textContent = css;
  if (list.length) {
    var hs = Math.round(clamp(median(Object.keys(X.nb).map(function (k) { return X.nb[k].h; })) * 0.7, 34, 70));
    var halosG = svgEl('g', { 'class': 'halos' }), titlesG = svgEl('g', { 'class': 'halo-titles' }); rg.halosG = halosG; rg.hs = hs; rg.stageNo = 0; rg.labelsMode = 'num'; rg.cardId = null;
    list.forEach(function (r) {
      if (isWhole(X.chart) && r.kind === 'stage' && X.svg.querySelector('g.cluster[data-cluster="' + String(r.id).replace(/"/g, '') + '"]')) rg.halo[r.id] = X.svg.querySelector('g.cluster[data-cluster="' + String(r.id).replace(/"/g, '') + '"]');
      else if (!isWhole(X.chart)) { var g = svgEl('g', { 'class': 'halo', 'data-region': r.id }); g.style.setProperty('--rc', r.color); g.innerHTML = haloMarkup(X, r, hs); halosG.appendChild(g); rg.halo[r.id] = g; }
      var xs = [], ys = [], x0 = 1e9, x1 = -1e9, y0 = 1e9;
      r.nodes.forEach(function (n) { var b = X.nb[n]; if (!b) return; xs.push(b.x + b.w / 2); ys.push(b.y + b.h / 2); x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.w); y0 = Math.min(y0, b.y); });
      var cx = median(xs), cy = median(ys), near = null;
      r.nodes.forEach(function (n) { var b = X.nb[n]; if (!b) return; var d = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy); if (!near || d < near.d) near = { d: d, x: b.x + b.w / 2, y: b.y + b.h / 2, id: n }; });
      if (near && near.d > 260) { cx = near.x; cy = near.y; }
      if (r.kind !== 'stage' && near && X.nb[near.id]) { x0 = X.nb[near.id].x; y0 = X.nb[near.id].y; }      // a loop's or a slice's label sits ON the loop: above the member box nearest its middle, not at the corner of a bounding box that may be empty
      var t = svgEl('text', { 'class': 'htitle', 'data-region': r.id, x: x0.toFixed(1), y: (y0 - hs).toFixed(1), 'text-anchor': 'start', 'font-size': 40 });
      t.style.setProperty('--rc', r.color); if (isWhole(X.chart) && r.kind === 'stage') t.setAttribute('class', 'htitle stg'); titlesG.appendChild(t); rg.titleEl[r.id] = t;
      rg.titles.push({ el: t, r: r, bw: Math.max(200, x1 - x0), len: Math.max(4, r.title.length), last: 0, show: false, sel: false, cx: cx, cy: cy, bx: x0, by: y0 - hs, key: '', num: r.kind === 'stage' ? ++rg.stageNo : 0 });
    });
    X.vp.insertBefore(halosG, $('g.edges', X.svg)); X.vp.appendChild(titlesG);
    rg.frame = {};
    list.forEach(function (r) { var cl = X.svg.querySelector('g.cluster[data-cluster="' + String(r.id).replace(/"/g, '') + '"]'); if (cl) { cl.style.setProperty('--rc', r.color); cl.classList.add('rg-cl'); rg.frame[r.id] = cl; } });
    // pips: a step that belongs to several (active) regions wears one dot per region
    if (!isWhole(X.chart)) Object.keys(rg.memb).forEach(function (nid) {
      var ms = rg.memb[nid], el = X.nodeEl.get(nid), b = X.nb[nid]; if (ms.length < 2 || !el || !b) return;
      var pg = svgEl('g', { 'class': 'pips' }), els = [];
      ms.forEach(function (ri, k) { var c = svgEl('circle', { 'class': 'pip', cx: (b.x + 10 + k * 9.5).toFixed(1), cy: (b.y + b.h - 6.5).toFixed(1), r: 3.7, fill: list[ri].color }); pg.appendChild(c); els.push(c); });
      el.appendChild(pg); rg.pipNodes[nid] = { ms: ms, els: els };
    });
  }
  var few = list.length < 2, wh = isWhole(X.chart);                       // one region is the chart itself: no Regions, Halos or Labels controls for it
  rdock.hidden = false; placeDockBar(X.chart.kind); rdRegions.hidden = few; rdHalos.hidden = few || wh; rdLabels.hidden = few || wh; rdSpine.hidden = !spine;
  $('#rdN').textContent = list.length ? String(list.length) : '';
  rdHalos.setAttribute('aria-pressed', rg.halosOn ? 'true' : 'false'); setLabelsBtn(rg, X.svg); LAYER_KEY = 'x'; rdSpine.setAttribute('aria-pressed', rg.spineOn ? 'true' : 'false');
  X.svg.classList.toggle('show-spine', !!(spine && rg.spineOn));
  X.svg.classList.toggle('has-halos', !!list.length);
  refreshRegions();
}
function ensureHalo(r) {
  var rg = C.rg, g = svgEl('g', { 'class': 'halo', 'data-region': r.id }); g.style.setProperty('--rc', r.color);
  g.innerHTML = haloMarkup(C, r, rg.hs); rg.halosG.appendChild(g); rg.halo[r.id] = g; return g;
}
function rgActive(id) { var rg = C.rg; return (rg.halosOn && rg.enabled.has(id)) || S.regSel.indexOf(id) >= 0; }
function refreshRegions() {
  var rg = C && C.rg; if (!rg) return;
  var act = {}, hov = S.hover && S.hover.t === 'region' ? S.hover.id : null;
  rg.list.forEach(function (r) {
    var a = rgActive(r.id), s = S.regSel.indexOf(r.id) >= 0, h = rg.halo[r.id], t = rg.titles[r.idx];
    if (!h && (s || r.id === hov) && isWhole(C.chart)) h = ensureHalo(r);                // loops and slices on the whole map build their halo when first lit
    act[r.id] = a;
    if (h) { h.classList.toggle('on', a); h.classList.toggle('sel', s); h.classList.toggle('hov', r.id === hov); }
    var fr = rg.frame && rg.frame[r.id]; if (fr) { fr.classList.toggle('rg-on', a); fr.classList.toggle('rg-sel', s); fr.classList.toggle('rg-hov', r.id === hov); }
    if (t) { t.show = a || r.id === hov; t.sel = s; t.el.classList.toggle('on', t.show); t.el.classList.toggle('sel', s); t.el.classList.toggle('hov', r.id === hov); }
  });
  Object.keys(rg.pipNodes).forEach(function (nid) {
    var P = rg.pipNodes[nid], cnt = 0; P.ms.forEach(function (ri) { if (act[rg.list[ri].id]) cnt++; });
    P.els.forEach(function (el, k) { el.classList.toggle('on', cnt >= 2 && !!act[rg.list[P.ms[k]].id]); });
  });
  $$('.rg-row', rgPanel).forEach(function (row) {
    var id = row.dataset.rg, on = S.regSel.indexOf(id) >= 0;
    row.classList.toggle('on', on); $('.rg-main', row).setAttribute('aria-pressed', on ? 'true' : 'false');
    var eye = $('.rg-eye', row); if (eye) eye.setAttribute('aria-pressed', rg.halosOn && rg.enabled.has(id) ? 'true' : 'false');
  });
  var clr = $('[data-rg-clear]', rgPanel); if (clr) clr.disabled = !S.regSel.length;
  regionsFlush();
}
/* region captions: the stage NUMBER (1-12, same as the Regions list) sits small above its block; a pinned or hovered region shows its full name; the Labels button
   cycles numbers / names / off.  11-13px on screen whatever the zoom, left-aligned ABOVE the region's top edge, never centred over the steps. */
function setLabelsBtn(rg, svg) {
  var m = rg.labelsMode || 'num', word = { num: 'numbers', names: 'names', off: 'off' }[m];
  rdLabels.textContent = 'Labels: ' + word; rdLabels.setAttribute('aria-pressed', m === 'off' ? 'false' : 'true');
  rdLabels.title = 'Region captions on the map: numbers, full names, or none. Click to cycle.'; (svg || C.svg).classList.toggle('no-htitles', m === 'off');
}
/* Halos and Labels draw only where the map is zoomed out: a halo is never drawn behind boxes you can read, and region captions are for the far view (a pinned region still shows its own). Where they would draw
   nothing the two buttons say so instead of looking dead: dimmed, with the reason in their tooltips and in one line at the top of the Regions list, and a press does nothing but repeat the reason. They come alive
   at the zoom where they work. (lodOf in viewer.js: far below 30%, mid below 55%.) */
var LAYER_KEY = '';
function layerIdle() {
  if (!C || !C.rg) return { halos: false, labels: false };
  return { halos: C.lod === 'near' || (C.lod === 'mid' && C.chart.kind === 'overview'), labels: C.lod !== 'far' && !S.regSel.length };       // (on the poster a stage's halo lies behind its own box: it shows only at the far level)
}
function layerNote(st) {
  return st.halos ? 'Halos and Labels show when the map is zoomed out. Zoom out to try them.' : st.labels ? 'Labels show when the map is zoomed out further.' : '';
}
function layerIdleSync(force) {
  var st = layerIdle(), key = (st.halos ? 'h' : '') + (st.labels ? 'l' : '') + (rgPanel.hidden ? '' : 'p');
  if (key === LAYER_KEY && !force) return; LAYER_KEY = key;
  [[rdHalos, st.halos, 'Halos are soft coloured blobs behind each region, drawn when the map is zoomed out (below about ' + (C.chart.kind === 'overview' ? '30' : '55') + '%). At this zoom the boxes can be read, so nothing is drawn behind them: zoom out and this comes alive.', 'Soft coloured blobs behind each region, visible when zoomed out'],
   [rdLabels, st.labels, 'Region captions (numbers or names) are drawn when the map is zoomed out (below about 30%). At this zoom the boxes carry the names, so none are drawn: zoom out and this comes alive.', 'Region captions on the map: numbers, full names, or none. Click to cycle.']].forEach(function (b) {
    b[0].classList.toggle('rd-idle', b[1]); if (b[1]) b[0].setAttribute('aria-disabled', 'true'); else b[0].removeAttribute('aria-disabled'); b[0].title = b[1] ? b[2] : b[3];
  });
  var n = $('#rpZoom'); if (n) { n.textContent = layerNote(st); n.hidden = !layerNote(st); }
}
function regionsFlush() {
  layerIdleSync();
  var rg = C && C.rg; if (!rg || !rg.titles.length) return;
  var s = view.s, far = C.lod === 'far', mid = C.lod === 'mid', placed = [], mode = rg.labelsMode || 'num';
  var vis = mode === 'off' ? [] : rg.titles.filter(function (t) {
    var hov = t.el.classList.contains('hov'), named = mode === 'names' || t.sel || hov;
    if (!(t.show || hov)) return false;
    if (far) return named || t.num > 0;
    return t.sel || hov;
  });
  vis.sort(function (p, q) { return p.by - q.by || p.bx - q.bx; });
  vis.forEach(function (t) {
    var hov = t.el.classList.contains('hov'), named = mode === 'names' || t.sel || hov || !t.num;
    var fsS = far ? 12 : 13, per = fsS * 0.8, fit = Math.max(6, Math.floor(t.bw * s * 0.97 / per) - 1);
    var txt = !named ? String(t.num) : (t.r.title.length > fit ? t.r.title.slice(0, fit - 1).trim() + '\u2026' : t.r.title);
    if (txt !== t.key) { t.key = txt; t.el.textContent = txt; }
    var fs = fsS / s;
    if (Math.abs(fs - t.last) / (t.last || 1) > 0.03) { t.el.setAttribute('font-size', fs.toFixed(1)); t.last = fs; }
    var w = txt.length * per / s, h = fs * 1.2, y = t.by, tries = 0, hit;
    do {
      hit = null;
      for (var i = 0; i < placed.length; i++) { var q = placed[i]; if (t.bx < q.x + q.w && q.x < t.bx + w && y - h < q.y && q.y - q.h < y) { hit = q; break; } }
      if (hit) y = hit.y - hit.h - 2 / s;
    } while (hit && ++tries < 24);
    placed.push({ x: t.bx, y: y, w: w, h: h });
    t.el.setAttribute('x', t.bx.toFixed(1));
    if (Math.abs(y - (t.yy || 0)) > 0.5) { t.el.setAttribute('y', y.toFixed(1)); t.yy = y; }
  });
}
/* focus painting (called by paint()): the preview (hover) region, else the pinned ones, unless a box/route focus is active.
   Region steps + routes INSIDE the (union of) region(s): full strength; routes crossing the boundary: medium; everything else dimmed. */
function paintRegions(nodeFocus) {
  var rg = C.rg;
  if (rg) { rg.marked.forEach(function (m) { m[0].classList.remove.apply(m[0].classList, m[1]); }); rg.marked = []; }
  C.svg.classList.remove('rg-focus', 'rg-preview', 'rg-loopsel');
  if (!rg) return false;
  var hov = S.hover && S.hover.t === 'region' && rg.byId[S.hover.id] ? S.hover.id : null;
  var ids = hov ? [hov] : (nodeFocus ? [] : S.regSel.filter(function (id) { return rg.byId[id]; }));
  var hovChanged = rg.lastHov !== hov; rg.lastHov = hov;
  if (hovChanged) refreshRegions();
  if (!ids.length) return false;
  var set = new Set(), colour = {};
  ids.forEach(function (id) { var r = rg.byId[id]; r.nodes.forEach(function (n) { set.add(n); if (colour[n] == null) colour[n] = r.idx; }); });
  var add = function (el, cls) { if (!el) return; el.classList.add.apply(el.classList, cls); rg.marked.push([el, cls]); };
  var hl = { nodes: new Map(), edges: new Map() };
  set.forEach(function (n) { add(C.nodeEl.get(n), ['rg-in', 'rgc-' + colour[n]]); hl.nodes.set(n, 'sel'); });
  var E = C.chart.edges;
  Object.keys(E).forEach(function (eid) {
    var e = E[eid], a = set.has(e.from), b = set.has(e.to); if (!a && !b) return;
    var cls = a && b ? ['rg-int'] : ['rg-bnd', a ? 'rg-lv' : 'rg-ar'];      // a road crossing the edge: leaving (warm) or arriving (cool)
    add(C.edgeEl.get(eid), cls); add(C.labelEl.get(eid), cls);
    if (a && b) hl.edges.set(eid, 'sel');
  });
  C.svg.classList.add('rg-focus'); C.svg.classList.toggle('rg-preview', !!hov);
  C.svg.classList.toggle('rg-loopsel', ids.every(function (id) { return rg.byId[id].kind !== 'stage'; }));      // a loop or a slice, not a district: its own roads are the brightest thing on the map
  C.hl = hl;
  return true;
}

/* ---- selecting regions ---- */
function setRegionSel(ids, o) {
  o = o || {};
  var rg = C && C.rg; if (!rg) { S.regSel = []; return; }
  S.regSel = ids.filter(function (id, i) { return rg.byId[id] && ids.indexOf(id) === i; });
  if (S.regSel.length && !o.keepNode) { S.sel = null; S.trace = null; S.pickFrom = null; S.alt = null; canvas.classList.remove('picking'); drawPickBanner(); }
  if (S.regSel.length && wholeNow() && app.dataset.insp === 'collapsed') { var ow0 = cw, oh0 = ch; S.autoFit = false; setInspCollapsed(false, true); measure(); view.x += (cw - ow0) / 2; view.y += (ch - oh0) / 2; schedule(); }   // the panel comes with the pin; the zoom stays, and the view is moved for the new width NOW (not when the resize observer fires), so the check that follows sees the real picture   // the whole map: boxes may be too small to name, so the panel (which lists them by name) comes with the pin
  refreshRegions(); paint(); renderInspector(true);
  if (!o.noHash) writeHash(false);
  if (o.reveal && S.regSel.length) zoomToRegions(S.regSel, false);
  if (!o.quiet) {
    if (!S.regSel.length) announce('Region selection cleared.');
    else { var set = unionSet(S.regSel.map(function (id) { return rg.byId[id]; })); announce(S.regSel.map(function (id) { return rg.byId[id].title; }).join(' and ') + ' selected: ' + set.size + ' steps.'); }
  }
}
function toggleRegion(id, additive, o) {
  var cur = S.regSel.slice(), i = cur.indexOf(id);
  if (additive) { if (i >= 0) cur.splice(i, 1); else cur.push(id); }
  else cur = (i >= 0 && cur.length === 1) ? [] : [id];
  setRegionSel(cur, o || {});
}
function clearRegions() { if (S.regSel.length) setRegionSel([], {}); }
/* ---- where the reader can actually see: the canvas minus every open panel that sits over it (the regions list on the left; the handles, details-card and legend panels on the right) ---- */
function visRect() {
  var r = { x0: 0, y0: 0, x1: cw, y1: ch };
  if (cw < 900) return r;
  var cr = canvas.getBoundingClientRect();
  var side = function (el, left) { if (!el || el.hidden || !el.offsetWidth) return; var q = el.getBoundingClientRect(); if (left) r.x0 = Math.max(r.x0, q.right - cr.left + 10); else r.x1 = Math.min(r.x1, q.left - cr.left - 10); };
  side(rgPanel, true); side(hpanel, false); side(dockEl, false); side(legendEl, false);
  if (r.x1 - r.x0 < 480) { r.x0 = 0; r.x1 = cw; }                      // a window too small to share: the panels simply cover
  return r;
}
function regionBoxIds(ids) { var out = [], seen = {}; ids.forEach(function (id) { var r = C.rg && C.rg.byId[id]; if (r) r.nodes.forEach(function (n) { if (C.nb[n] && !seen[n]) { seen[n] = 1; out.push(n); } }); }); return out; }
/* Where to put the view so the names READ and something real is in it.  pool = the box ids the reader means (a pinned stage or loop, a pinned box) or null (the middle of what is visible).
   o.floor = the smallest zoom at which names read; o.fit = fit the whole thing when it can be read that way ("Zoom to it").  The window is chosen where the most of the pool's boxes sit (so a loop or a big
   stage never lands on empty canvas), and it is centred in the VISIBLE part of the canvas, not behind a panel. */
function readView(pool, o) {
  o = o || {};
  var vr = visRect(), vw = vr.x1 - vr.x0, vh = vr.y1 - vr.y0, inset = 36, all = Object.keys(C.nb), pinned = !!(pool && pool.length), ids = pinned ? pool.filter(function (id) { return C.nb[id]; }) : all;
  if (!ids.length) { ids = all; pinned = false; }
  var cx = function (b) { return b.x + b.w / 2; }, cy = function (b) { return b.y + b.h / 2; };
  var boxes = ids.map(function (id) { return C.nb[id]; }), bb = unionBox(boxes.map(function (b) { return { x: b.x, y: b.y, w: b.w, h: b.h }; }));
  var floor = o.floor || 0.75, s, sFit = Math.min((vw - 2 * inset) / bb.w, (vh - 2 * inset - 40) / bb.h);
  if (pinned && o.fit && sFit >= floor) s = Math.min(sFit, 1.1); else s = Math.min(Math.max(floor, o.fit ? floor : view.s), 1.1);
  var midW = { x: (vw / 2 + vr.x0 - view.x) / view.s, y: (vh / 2 + vr.y0 - view.y) / view.s };           // the middle of the visible canvas, in map units
  var target = pinned ? { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 } : midW;
  var hw = (vw - inset) / s / 2, hh = (vh - inset - 40) / s / 2, cands = boxes;
  if (!pinned) cands = boxes.slice().sort(function (p, q) { return Math.hypot(cx(p) - midW.x, cy(p) - midW.y) - Math.hypot(cx(q) - midW.x, cy(q) - midW.y); }).slice(0, 60);
  else if (cands.length > 240) { var stp = cands.length / 240; cands = []; for (var k = 0; k < 240; k++) cands.push(boxes[Math.floor(k * stp)]); }
  var inWin = function (px, py, b) { return Math.abs(cx(b) - px) <= hw && Math.abs(cy(b) - py) <= hh; };
  var best = null, bestN = -1, bestD = 0;
  cands.forEach(function (c) {
    var n = 0; boxes.forEach(function (b) { if (inWin(cx(c), cy(c), b)) n++; });
    var d = Math.hypot(cx(c) - target.x, cy(c) - target.y);
    if (n > bestN || (n === bestN && d < bestD)) { best = c; bestN = n; bestD = d; }
  });
  var px = cx(best), py = cy(best), sx = 0, sy = 0, m = 0;                                              // settle in the middle of the boxes the window holds
  boxes.forEach(function (b) { if (inWin(px, py, b)) { sx += cx(b); sy += cy(b); m++; } });
  if (m) { var qx = sx / m, qy = sy / m, ok = true; boxes.forEach(function (b) { if (inWin(px, py, b) && !inWin(qx, qy, b)) ok = false; }); if (ok) { px = qx; py = qy; } }
  if (pinned && bb.w * s <= vw - inset && bb.h * s <= vh - inset) { px = bb.x + bb.w / 2; py = bb.y + bb.h / 2; }   // the whole thing fits: centre it
  return { s: s, x: vr.x0 + vw / 2 - px * s, y: vr.y0 + vh / 2 - py * s + 14, boxes: bestN, whole: pinned && bb.w * s <= vw - inset && bb.h * s <= vh - inset };
}
function zoomToRegions(ids, always) {
  var rg = C.rg; if (!rg) return;
  var pool = regionBoxIds(ids), boxes = pool.map(function (n) { return nodeBox(n, 30); });
  if (!boxes.length) return;
  var bb = unionBox(boxes);
  if (!always) {                                   // pinning from a list: the zoom does not move. In view: nothing. Out of view: pan so it is (the "Zoom to it" button zooms).
    var r0 = toScreen(bb), vr = visRect();
    if (r0.x >= 20 + vr.x0 && r0.y >= 20 && r0.x + r0.w <= vr.x1 - 20 && r0.y + r0.h <= ch - 20) { drawWordsNote(); return; }
    var mid = { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 }, big = r0.w > vr.x1 - vr.x0 - 40 || r0.h > ch - 40;
    S.autoFit = false; setView({ s: view.s, x: (vr.x0 + vr.x1) / 2 - mid.x * view.s, y: ch / 2 - mid.y * view.s }, true, 320);
    if (big) { var rb = { x: bb.x, y: bb.y }; nameNote._at = rb; }
    return;
  }
  var tv = readView(pool, { fit: true, floor: Math.max(C.minS, wordsFloor() + 0.01) });
  S.autoFit = false; setView(tv, true, 360);
  showNameNote(tv.s, ids, bb);
}
/* Never lose the words silently. On ANY chart, at ANY zoom where box names or road conditions have gone, a calm notice says so and offers one button back to where they read.
   It follows wheel zoom, Fit, Whole and every other change of zoom. The overview poster and the whole map at their own fit are meant to be calm: no notice until the reader moves. */
var nameNote = $('#nameNote');
function wordsState() {
  if (!C || S.reading || !C.svg) return null;
  var tb = textBase(C), k = view.s, kind = C.chart.kind;
  return { names: k * tb.node < minPxFor('node'), labels: kind !== 'whole' && kind !== 'overview' && C.labelEl.size > 0 && k * tb.elabel < minPxFor('elabel'), kind: kind };
}
function wordsFloor() { return isWhole(C.chart) ? Math.max((MINPX + 0.03) / textBase(C).node, 0.75) : Math.max(fitFloor(C), (MINPX + 0.03) / textBase(C).node); }
function drawWordsNote() {
  if (!nameNote) return;
  var w = wordsState();
  if (smallOn()) { nameNote.hidden = true; nameNote._key = ''; return; }                                                          // the smaller view says what it draws in the zoom bar, once; this banner would say it a second time, and differently
  if (!w || (!w.names && !w.labels) || ((w.kind === 'whole' || w.kind === 'overview') && S.autoFit)) { nameNote.hidden = true; nameNote._key = ''; return; }
  var key = (w.names ? 'n' : '') + (w.labels ? 'l' : '') + (isWhole(C.chart) ? 'w' : '');
  if (nameNote._key === key && !nameNote.hidden) return;                       // the same words as a moment ago: nothing to redraw while the zoom moves
  nameNote._key = key; nameNote.hidden = false;
  nameNote.innerHTML = (w.names && w.labels ? 'Names and road conditions are hidden at this zoom.' : w.names ? 'Box names are too small to read at this zoom.' : 'Road conditions are hidden at this zoom; names still read.') + ' <button type="button" class="nn-go">Zoom to where they read</button>' + (isWhole(C.chart) ? ' <span class="quiet">or pick a box in the details panel</span>' : '');
}
function showNameNote(s, ids, bb) {                // the whole map: a region was zoomed to; the button goes to the region's busiest corner
  if (!nameNote || !C || !isWhole(C.chart)) return;
  nameNote._at = { x: bb.x + Math.min(bb.w, 600) / 2, y: bb.y + Math.min(bb.h, 400) / 2 };
  drawWordsNote();
}
if (nameNote) {
  nameNote.addEventListener('click', function (e) {
    if (!e.target.closest('.nn-go') || !C) return;
    var pool = S.regSel.length ? regionBoxIds(S.regSel) : S.sel && S.sel.t === 'node' ? [S.sel.id] : null;       // the pinned stage or loop, else the pinned box, else the middle of what is visible (never behind a panel)
    var tv = readView(pool, { floor: Math.max(C.minS, wordsFloor() + 0.01) });
    S.autoFit = false; setView(tv, true, 360); nameNote._at = null;
  });
  FL.onZoom(function () { if (nameNote._at && !nameNote.hidden) { /* keep the target while the zoom moves */ } drawWordsNote(); });
  FL.onChart(function () { nameNote._at = null; drawWordsNote(); });
}
function leftReserve() {
  if (!C || !C.rg || rgPanel.hidden || cw < 900) return 0;
  var w = rgPanel.offsetWidth + 24; return cw - w >= 560 ? w : 0;
}

/* ---- hover preview: the region card goes to the Details panel (beside the map, never over it); the floating tip is only the fallback ---- */
function renderPanelCard() {
  var el = $('#rpCard'), rg = C && C.rg; if (!el || !rg) return;
  var id = rg.cardId, r = id && rg.byId[id];
  if (!r) { el.dataset.id = ''; el.innerHTML = rgPanel.classList.contains('rp-long') ? '<p class="quiet">Hover a stage to preview it here.</p>' : '<p class="quiet">Hover a stage or a loop to see what it is, how big it is and which handles it carries. The map lights up the same region.</p>'; return; }
  var st = regionStats(r); el.dataset.id = id;
  el.innerHTML = '<div class="rpc-top">' + swatch(r) + '<span>' + esc(RK_WORDS[r.kind] || 'Region') + '</span></div><b class="rpc-t">' + esc(r.title) + '</b>' +
    '<span class="rpc-s"><b>' + st.nodes + '</b>' + (r.total ? ' of ' + r.total : '') + (r.total || st.nodes !== 1 ? ' boxes' : ' box') + ' · <b>' + st.internal + '</b>' + wRoad(st.internal) + ' inside · <b>' + st.boundary + '</b> cross the edge</span>' +
    (st.tags.length ? '<span class="rpc-s">Handles: ' + esc(st.tags.slice(0, 10).join(' · ')) + (st.tags.length > 10 ? ' · +' + (st.tags.length - 10) : '') + '</span>' : '') +
    (r.blurb ? '<span class="rpc-b">' + esc(trunc(r.blurb, 220)) + '</span>' : '') + (r.kind === 'stage' ? termLine(r.title) : '');
}
function termLine(text) { var ts = termsIn(text); return ts.length ? '<span class="rpc-t"><b>' + esc(ts[0].tag) + '</b> ' + esc(trunc(sentencesOf(ts[0].meaning)[0] || ts[0].meaning, 110)) + '</span>' : ''; }
function endRegionPreview() {
  var rg = C && C.rg; if (rg && rg.cardId) { rg.cardId = null; renderPanelCard(); }
  if (insp.dataset.prev) { delete insp.dataset.prev; renderInspector(false); }
}
function previewRegion(id) {
  var rg = C && C.rg, r = rg && rg.byId[id]; if (!r) return false;
  if (!rgPanel.hidden && $('#rpCard')) { rg.cardId = id; renderPanelCard(); return true; }
  if (!insp.getClientRects().length) return false;
  insp.dataset.prev = id; insp.innerHTML = '<p class="prev-note">Preview \u00b7 click the region to pin it</p>' + regionInspector(r); insp.scrollTop = 0; return true;
}
/* ---- region tooltip + inspector ---- */
function swatch(r) { return '<i class="rg-sw" style="--c:' + r.color + '"></i>'; }
function regionTipHTML(id) {
  var r = C.rg && C.rg.byId[id]; if (!r) return '';
  var st = regionStats(r);
  return '<span class="tip-top">' + swatch(r) + '<span class="tip-cat">' + esc(RK_WORDS[r.kind] || 'Region') + '</span></span><b>' + esc(r.title) + '</b>' +
    '<span class="tip-sub"><b class="tt-n">' + st.nodes + '</b>' + wBox(st.nodes) + ' · <b class="tt-n">' + st.internal + '</b>' + wRoad(st.internal) + ' inside · <b class="tt-n">' + st.boundary + '</b> cross the edge</span>' +
    (st.tags.length ? '<span class="tip-sub">Handles: ' + esc(st.tags.slice(0, 10).join(' · ')) + (st.tags.length > 10 ? ' · +' + (st.tags.length - 10) : '') + '</span>' : '') +
    (r.blurb ? '<span class="tip-body">' + esc(trunc(r.blurb, 130)) + '</span>' : '');
}
function nodeRows(map, dir) {
  var me = mainEdges(), isMain = function (id) { return map[id].some(function (eid) { if (eid.indexOf('p:') === 0) { var p = C.pidx[eid.slice(2)]; return !!(p && p.main); } return me.has(eid); }); };
  var ids = Object.keys(map).sort(function (a, b) { var A = C.nb[a] || { x: 0, y: 0 }, B = C.nb[b] || { x: 0, y: 0 }; return (isMain(b) ? 1 : 0) - (isMain(a) ? 1 : 0) || A.x - B.x || A.y - B.y; });
  var isMain1 = function (eid) { if (eid.indexOf('p:') === 0) { var p = C.pidx[eid.slice(2)]; return !!(p && p.main); } return me.has(eid); };
  var row = function (id) {
    var es = map[id].slice().sort(function (a, b) { return (isMain1(b) ? 1 : 0) - (isMain1(a) ? 1 : 0); }), mainTo = '', other = es.map(function (eid) {
      var t;
      if (eid.indexOf('p:') === 0) { var p = C.pidx[eid.slice(2)], tn = p && CH[p.chart].nodes[p.node2]; t = (tn ? tn.title : p ? CH[p.chart].navLabel : '?') + ' (other chart)'; }
      else { var e = C.chart.edges[eid]; t = nodeName(dir === 'in' ? e.from : e.to); }
      if (!mainTo && isMain1(eid)) mainTo = t;
      return t;
    }).filter(function (t, i, a) { return a.indexOf(t) === i; });
    return '<button type="button" class="rg-node ' + dir + (isMain(id) ? ' main' : '') + '" data-node="' + esc(id) + '"><b>' + (isMain(id) ? '<i class="r-main">main path</i>' : '') + esc(nodeName(id)) + '</b><small>' + es.length + ' road' + (es.length === 1 ? '' : 's') + (dir === 'in' ? ' in from “' : ' out to “') + esc(trunc(other[0], 38)) + '”' + (mainTo && mainTo === other[0] ? ' <i class="r-main">main path</i>' : '') + (other.length > 1 ? ' and ' + (other.length - 1) + ' other' + (other.length === 2 ? '' : 's') : '') + '</small></button>';
  };
  if (!ids.length) return '<p class="quiet">' + (dir === 'in' ? 'No road arrives from outside the region: it is closed at its start.' : 'No road leaves the region.') + '</p>';
  var h = ids.slice(0, 5).map(row).join('');
  if (ids.length > 5) h += '<details class="rg-more"><summary>Show ' + (ids.length - 5) + ' more</summary>' + ids.slice(5).map(row).join('') + '</details>';
  return h;
}
function mainJoins(set, B) {                    // the roads that join a region to the main path without the path running through it: [{inside, dir, other}], from the boundary lists
  var mp = new Set(pathIdsOf(MAIN_ID)), out = [];
  ['entry', 'exit'].forEach(function (k) {
    var dir = k === 'entry' ? 'in' : 'out';
    Object.keys(B[k] || {}).forEach(function (id) {
      (B[k][id] || []).forEach(function (eid) {
        var other = null;
        if (eid.indexOf('p:') === 0) { var p = C.pidx[eid.slice(2)]; other = p && p.node2; }
        else { var e = C.chart.edges[eid]; other = e && (dir === 'in' ? e.from : e.to); }
        if (other && mp.has(other) && !set.has(other) && !out.some(function (j) { return j.inside === id && j.other === other && j.dir === dir; })) out.push({ inside: id, dir: dir, other: other });
      });
    });
  });
  return out;
}
function mainPathNote(set, single, B) {
  var ids = pathIdsOf(MAIN_ID), runs = [], cur = null;
  if (!ids.length) return '';
  ids.forEach(function (id) { if (set.has(id)) { if (!cur) { cur = { a: id, b: id, n: 0 }; runs.push(cur); } cur.b = id; cur.n++; } else cur = null; });
  var nm = function (id) { return '<button type="button" class="mp-b" data-node="' + esc(id) + '">' + esc(trunc(nodeName(id), 40)) + '</button>'; };
  if (!runs.length) {
    var js = B ? mainJoins(set, B) : [], who = single ? esc(single.title) : 'these', ins = js.filter(function (j) { return j.dir === 'in'; }), outs = js.filter(function (j) { return j.dir === 'out'; });
    if (!js.length) return '<p class="mp-note none"><i></i>The main path does not pass through ' + who + ', and no road joins it to the main path directly.</p>';
    var groups = [], at = {};                       // one entry per box of the stage: the main-path boxes that send to it and those it sends to
    js.forEach(function (j) { var g = at[j.inside] || (at[j.inside] = { inside: j.inside, ins: [], outs: [] }); if (!at[j.inside].seen) { at[j.inside].seen = 1; groups.push(g); } (j.dir === 'in' ? g.ins : g.outs).push(j.other); });
    var bit = function (g) { var one = function (l) { return l.slice(0, 2).map(nm).join(' or ') + (l.length > 2 ? ' or ' + (l.length - 2) + ' more' : ''); }; return nm(g.inside) + ' (' + (g.ins.length ? 'a road arrives from ' + one(g.ins) : '') + (g.ins.length && g.outs.length ? '; ' : '') + (g.outs.length ? 'a road leaves for ' + one(g.outs) : '') + ')'; };
    return '<div class="mp-note beside"><i></i><span><b>Beside the main path.</b> It does not run through ' + who + ', but it is joined to it at ' + groups.slice(0, 4).map(bit).join(' and ') + (groups.length > 4 ? ' and ' + (groups.length - 4) + ' more' : '') + '.' + (ins.length && !outs.length ? ' Roads only arrive from it.' : outs.length && !ins.length ? ' Roads only leave toward it.' : '') + '</span></div>';
  }
  return '<div class="mp-note"><i></i><span>' + (runs.length === 1 ? 'The main path enters at ' + nm(runs[0].a) + (runs[0].n > 1 ? ' and leaves after ' + nm(runs[0].b) + ' (' + runs[0].n + ' boxes of it).' : ' (one box of it).') : 'The main path passes through ' + runs.length + ' times. It first enters at ' + nm(runs[0].a) + ' and leaves after ' + nm(runs[0].b) + '.') + '</span></div>';
}
function regionInspector(only) {
  var rg = C.rg, regs = only ? [only] : S.regSel.map(function (id) { return rg.byId[id]; }).filter(Boolean);
  if (!regs.length) return emptyInspector();
  var single = regs.length === 1 ? regs[0] : null, set = unionSet(regs), B = boundaryOf(set), tags = tagsOfSet(set);
  var stageIdx = '';
  if (single && single.kind === 'stage') { var sts = rg.list.filter(function (r) { return r.kind === 'stage'; }); stageIdx = ' ' + (sts.indexOf(single) + 1) + ' of ' + sts.length; }
  var h = '<p class="eyebrow">' + (single ? esc(RK_WORDS[single.kind] || 'Region') + stageIdx : regs.length + ' regions together') + '</p>' +
    '<h2>' + (single ? swatch(single) + esc(single.title) : regs.map(function (r) { return esc(r.title); }).join(' + ')) + '</h2>';
  if (!single) h += '<div class="rg-chips">' + regs.map(function (r) { return '<button type="button" class="rg-chip" style="--c:' + r.color + '" data-rg-pin="' + esc(r.id) + '" data-rg-add="1" title="Remove from the selection">' + esc(trunc(r.title, 26)) + ' ×</button>'; }).join('') + '</div>';
  var fig = single ? regionStats(single) : { nodes: set.size, internal: B.internal, boundary: B.boundary };
  h += '<div class="stat"><span><b>' + fig.nodes + '</b>' + wBox(fig.nodes) + '</span><span><b>' + fig.internal + '</b>' + wRoad(fig.internal) + ' inside</span><span><b>' + fig.boundary + '</b> cross the edge</span></div>';
  if (single && single.blurb) h += '<p class="lead">' + esc(single.blurb) + '</p>';
  if (single && single.kind === 'loop' && single.limit !== undefined) h += '<div class="callout ' + (single.limit ? '' : 'fail') + '"><b>' + (single.limit ? 'Limit' : 'No limit shown') + '</b>' + (single.limit ? ': ' + esc(single.limit) : ': nothing drawn here says what stops this loop.') + '</div>';
  h += '<div class="actions"><button type="button" class="act" data-act="rg-zoom">Zoom to ' + (single ? 'it' : 'them') + '</button>' + (single && single.path ? '<button type="button" class="act" data-rg-walk="' + esc(single.path) + '">Walk this path</button>' : '') +
    (single ? '<button type="button" class="act' + (rg.halosOn && rg.enabled.has(single.id) ? ' on' : '') + '" data-rg-halo="' + esc(single.id) + '">Halo</button>' : '') +
    '<button type="button" class="act ghost" data-act="rg-clear">Clear</button></div>';
  if (regs.length > 1) h += '<p class="quiet">Roads between the selected regions count as inside.</p>';
  if (C.chart.kind !== 'overview') h += mainPathNote(set, single, B);
  var mem = Array.from(set), listOpen = isWhole(C.chart) || !namesOn();
  var memHtml = '<details class="src rg-members"' + (listOpen ? ' open' : '') + '><summary>All ' + mem.length + ' boxes, by name</summary>' + (listOpen && !namesOn() ? '<p class="quiet" style="margin-top:6px">Their names are too small to read on the map at this zoom: pick one here to see it.</p>' : '') + '<div class="chips" style="margin-top:8px">' + mem.map(function (id) { return '<button type="button" data-node="' + esc(id) + '">' + esc(trunc(nodeName(id), 44)) + '</button>'; }).join('') + '</div>' + (mem.length > 400 ? '<p class="quiet">… and ' + (mem.length - 400) + ' more.</p>' : '') + '</details>';
  if (listOpen) h += memHtml;
  h += '<h3 class="p-in">Where the flow enters</h3>' + nodeRows(B.entry, 'in') + '<h3 class="p-out">Where the flow leaves</h3>' + nodeRows(B.exit, 'out');
  if (tags.length) h += '<h3>Official handles engaged</h3><div class="hb-also">' + tags.slice(0, 18).map(function (t) { return hchipBtn(t); }).join('') + (tags.length > 18 ? '<span class="quiet">+' + (tags.length - 18) + ' more</span>' : '') + '</div>';
  if (!listOpen) h += memHtml;
  return h;
}
function regionChipsFor(nid) {
  var rg = C.rg, ms = rg && rg.memb[nid]; if (!ms || !ms.length) return '';
  return '<h3>In these ' + (META.toolMap ? 'stages and loops' : 'regions') + '</h3><div class="rg-chips">' + ms.map(function (ri) { var r = rg.list[ri]; return '<button type="button" class="rg-chip" style="--c:' + r.color + '" data-rg-pin="' + esc(r.id) + '" title="' + esc(RK_WORDS[r.kind] + ': highlight this region') + '">' + esc(trunc(r.title, 28)) + '</button>'; }).join('') + '</div>';
}
function regionHint() {
  var rg = C.rg; if (!rg || rg.list.length < 2) return '';
  var kinds = {}; rg.list.forEach(function (r) { kinds[groupKind(r.kind)] = (kinds[groupKind(r.kind)] || 0) + 1; });
  var bits = [], pl = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };
  if (kinds.stage) bits.push(pl(kinds.stage, 'stage', 'stages')); if (kinds.loop) bits.push(pl(kinds.loop, 'loop', 'loops'));
  return '<h3>' + (META.toolMap ? 'Stages and loops' : 'Regions') + '</h3><p>This chart is cut into ' + esc(bits.join(', ')) + '. Hover a region to preview it, click to pin, Shift-click to add another: its roads stay bright, roads crossing its edge are medium, the rest fades.</p>' +
    '<div class="actions"><button type="button" class="act" data-act="rg-open">Open the regions list</button></div>';
}

/* ---- the Regions panel (left drawer on the canvas) ---- */
var rgAuto = false;
function rgWantsOpen() { try { if (sessionStorage.getItem('atlas.rgPanel') === 'closed') return false; } catch (e) {} return cw >= 1100; }
function openRegionPanel(on) {
  var rg = C && C.rg; if (!rg || !rg.list.length) return;
  if (!rgAuto) { try { sessionStorage.setItem('atlas.rgPanel', on ? 'open' : 'closed'); } catch (e) {} }
  document.body.classList.toggle('rg-open', !!on);
  rgPanel.hidden = !on; rdRegions.setAttribute('aria-expanded', on ? 'true' : 'false'); rdRegions.classList.toggle('open', !!on);
  if (on) { if (!legendEl.hidden) toggleLegend(false); drawRegionPanel(); }
  refitForPanel();
}
function drawRegionPanel() {
  var rg = C && C.rg; if (!rg || rgPanel.hidden) return;
  var keep = rgPanel.scrollTop;
  rgPanel.style.maxHeight = Math.max(180, ch - 120) + 'px'; rgPanel.classList.toggle('rp-long', rg.list.length > 12);       // a long list (the poster of a big map) gets the room: see flow.css
  var h = '<div class="rp-head"><h3>Regions <span class="rp-cnt">' + rg.list.length + '</span></h3><button type="button" class="lg-close" data-rg-close="1">Close</button></div>' +
    '<p class="rp-note">Hover to preview, click to pin, <kbd>Shift</kbd>-click (or +) to add more. The eye draws that region’s halo when zoomed out.</p><p class="rp-zoom" id="rpZoom" hidden></p>' +
    '<div class="rp-actions"><button type="button" class="act" data-rg-clear="1">Clear selection</button></div>' +
    (rg.list.length > 14 ? '<input type="search" id="rgFilter" class="rp-filter" placeholder="Filter the ' + rg.list.length + ' regions…" aria-label="Filter the regions list" autocomplete="off" spellcheck="false" value="' + esc(rg.filter || '') + '">' : '');
  RG_GROUPS.forEach(function (g) {
    var rows = rg.list.filter(function (r) { return groupKind(r.kind) === g.id; });
    if (!rows.length) return;
    var gsub = g.sub;
    if (g.id === 'loop') { var nl = rows.filter(function (r) { return r.kind === 'loop'; }).length, ns2 = rows.filter(function (r) { return r.kind === 'slice'; }).length; gsub = (nl ? nl + ' loops' : '') + (nl && ns2 ? ' + ' : '') + (ns2 ? ns2 + ' path slices' : ''); }
    var body = rows.map(function (r, i) {
      var st = r.nodes.length + (r.total ? ' of ' + r.total : '');            // a loop this chart draws only part of: "4 of 5" (the rest are on other charts)
      return '<div class="rg-row" data-rg="' + esc(r.id) + '"><button type="button" class="rg-main" data-rg-pin="' + esc(r.id) + '" aria-pressed="false" title="' + esc((RK_WORDS[r.kind] || 'Region') + (r.blurb ? ': ' + r.blurb : '')) + '">' + (g.id === 'stage' ? '<span class="rg-i">' + (i + 1) + '</span>' : '') + swatch(r) + '<span class="rg-t">' + esc(r.title) + '</span><span class="rg-n">' + st + '</span></button>' + (r.path ? '<button type="button" class="rg-walk" data-rg-walk="' + esc(r.path) + '" title="Walk this path one step at a time" aria-label="Walk ' + esc(r.title) + ' step by step">&#9654;</button>' : '') +
        '<button type="button" class="rg-eye" data-rg-halo="' + esc(r.id) + '" aria-pressed="false" aria-label="Halo for ' + esc(r.title) + '" title="Draw this region’s halo when zoomed out"><svg viewBox="0 0 20 14" width="16" height="12" aria-hidden="true"><path d="M1 7C3.5 2.8 6.6 1 10 1s6.5 1.8 9 6c-2.5 4.2-5.6 6-9 6S3.5 11.2 1 7z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="7" r="2.6" fill="currentColor"/></svg></button>' +
        '<button type="button" class="rg-add" data-rg-add="' + esc(r.id) + '" aria-label="Add ' + esc(r.title) + ' to the selection" title="Add to the selection (same as Shift-click)">+</button></div>';
    }).join('');
    h +='<div class="rp-group"><h4>' + g.title + (gsub ? ' <small>' + gsub + '</small>' : '') + '<span class="rp-gn">' + rows.length + '</span></h4>' + (g.id === 'loop' ? '<p class="rp-note">Declared loops of two or more boxes, and declared paths other than the main path (a <b>slice</b> is one of those: a walk through some of the boxes; the &#9654; walks it). Loops worked out from return roads are in the Narrative. <a class="hlink" href="#reading=scope&amp;section=numbers">What the numbers count</a></p>' : '') + body + '</div>';
  });
  rgPanel.innerHTML = h; rgPanel.scrollTop = keep; applyRegionFilter();
  rgPanel.insertAdjacentHTML('beforeend', '<div class="rp-card" id="rpCard" aria-live="polite"></div>'); renderPanelCard(); layerIdleSync(true);
  refreshRegions();
}
function applyRegionFilter() {                              // the Regions list can be long (a loop per retry): a filter box narrows it by name
  var rg = C && C.rg; if (!rg) return;
  var q = norm(rg.filter || ''), toks = q.split(' ').filter(Boolean);
  $$('.rg-row', rgPanel).forEach(function (row) { var t = norm($('.rg-t', row) ? $('.rg-t', row).textContent : ''); row.hidden = !!toks.length && !toks.every(function (k) { return t.indexOf(k) >= 0; }); });
  $$('.rp-group', rgPanel).forEach(function (g) { var any = $$('.rg-row', g).some(function (r) { return !r.hidden; }); g.hidden = !!toks.length && !any; });
}
rgPanel.addEventListener('input', function (e) { if (e.target.id === 'rgFilter' && C && C.rg) { C.rg.filter = e.target.value; applyRegionFilter(); } });
rdRegions.addEventListener('click', function () { openRegionPanel(rgPanel.hidden); });
(function () { var bar = $('.rd-bar', rdock); if (!bar || !window.MutationObserver) return; new MutationObserver(function () { bar.style.display = bar.parentNode !== rdock && rdock.hidden ? 'none' : ''; }).observe(rdock, { attributes: true, attributeFilter: ['hidden'] }); })();
rdHalos.addEventListener('click', function () {
  var rg = C && C.rg; if (!rg) return; if (rdHalos.classList.contains('rd-idle')) { announce(layerNote(layerIdle())); return; } rg.halosOn = !rg.halosOn; rdHalos.setAttribute('aria-pressed', rg.halosOn ? 'true' : 'false'); refreshRegions();
});
rdLabels.addEventListener('click', function () {
  var rg = C && C.rg; if (!rg) return; if (rdLabels.classList.contains('rd-idle')) { announce(layerNote(layerIdle())); return; } rg.labelsMode = { num: 'names', names: 'off', off: 'num' }[rg.labelsMode || 'num']; setLabelsBtn(rg); refreshRegions(); announce('Region labels: ' + rg.labelsMode + '.');
});
rdSpine.addEventListener('click', function () {
  var rg = C && C.rg; if (!rg || !rg.spine) return; rg.spineOn = !rg.spineOn; rdSpine.setAttribute('aria-pressed', rg.spineOn ? 'true' : 'false'); C.svg.classList.toggle('show-spine', rg.spineOn);
  announce(rg.spineOn ? 'Main path shown.' : 'Main path hidden.');
});
function toggleHalo(id) {
  var rg = C && C.rg; if (!rg || !rg.byId[id]) return;
  if (!rg.halosOn) { rg.halosOn = true; rg.enabled.add(id); rdHalos.setAttribute('aria-pressed', 'true'); }
  else if (rg.enabled.has(id)) rg.enabled.delete(id); else rg.enabled.add(id);
  refreshRegions(); if (S.regSel.length === 1 && S.regSel[0] === id && !S.sel) renderInspector(false);
}
rgPanel.addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  if (b.dataset.rgWalk) { startWalk(b.dataset.rgWalk); return; }
  if (b.dataset.rgClose) { openRegionPanel(false); rdRegions.focus(); return; }
  if (b.dataset.rgClear) { clearRegions(); return; }
  if (b.dataset.rgHalo) { toggleHalo(b.dataset.rgHalo); return; }
  if (b.dataset.rgAdd) { toggleRegion(b.dataset.rgAdd, true, { reveal: true }); return; }
  if (b.dataset.rgPin) toggleRegion(b.dataset.rgPin, e.shiftKey || e.ctrlKey || e.metaKey, { reveal: true });
});
rgPanel.addEventListener('mouseover', function (e) {
  if (PT.lock) return;
  var row = e.target.closest('.rg-row'); if (!row || !C || !C.rg) return;
  if (row !== rgPanel._hov) { rgPanel._hov = row; HV.x = e.clientX; HV.y = e.clientY; setHover({ t: 'region', id: row.dataset.rg }); }
});
rgPanel.addEventListener('mouseout', function (e) {
  var row = e.target.closest('.rg-row'); if (row && rgPanel._hov === row && !row.contains(e.relatedTarget)) { rgPanel._hov = null; setHover(null); }
});
rgPanel.addEventListener('mousemove', function (e) { if (rgPanel._hov) { HV.x = e.clientX; HV.y = e.clientY; placeTip(e.clientX, e.clientY); } });
