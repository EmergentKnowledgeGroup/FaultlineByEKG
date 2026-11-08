/* ================================================================ THE WHOLE MAP AT SCALE (large maps)
   Spliced into viewer.js (same closure). Only does anything for a chart of kind 'whole' (the helpers at the top also serve any chart with more than 400 roads).
   What it adds on top of regions.js:
   - handle chips laid out per stage (chipsPerCluster): the renderer's own layout is quadratic in the whole map; here each cell only sees its own neighbours.
   - far level of detail: the roads are merged into two single paths (inside stages, between stages) and the per-road elements are hidden; a pan or zoom then paints a
     handful of elements instead of one for every road. The per-road elements come back as the map is zoomed in, and for anything lit.
   - district tint: each stage's halo (its cluster) carries the stage's hue; a screen-space pill (number + name, 13 px) pinned at the top-left of the halo, the plain title in the
     halo's title band once the halo is large on screen.
   - long roads (data-cross) are soft ribbons: thin, faint and cool at far zoom, brighter as you zoom in; the dock's "Long roads" button cycles faint / on / off.
   - focus: a lit long road shows its condition (focusLabel), made lazily and only for what is lit, in screen space; hovering a stage pill lights its district.
   - main path: one merged line of constant screen width with a soft glow (default off). */

/* ---------------------------------------------------------------- handle chips, laid out per cell */
function chipsPerCluster(g, copt) {
  var copt2 = {}; for (var q0 in copt) copt2[q0] = copt[q0]; copt2.attach = false;        // the whole map draws no road conditions, so the tabs keep clear of nothing that moves (and its open time is as it was)
  var CELL = 1800, MARGIN = 44, cells = {}, out = {}, keys = [];
  g.nodes.forEach(function (n) {
    var k = Math.floor(n.x / CELL) + ',' + Math.floor(n.y / CELL);
    if (!cells[k]) { cells[k] = []; keys.push(k); }
    cells[k].push(n);
  });
  var eb = g.edges.map(function (e) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    e.pts.forEach(function (p) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; });
    return { e: e, x0: x0, y0: y0, x1: x1, y1: y1 };
  });
  keys.forEach(function (k) {
    var mine = cells[k], tagged = mine.some(function (n) { return n.handle && String(n.handle).trim(); });
    if (!tagged) return;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    mine.forEach(function (n) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); });
    x0 -= MARGIN; y0 -= MARGIN; x1 += MARGIN; y1 += MARGIN;
    var set = {}; mine.forEach(function (n) { set[n.id] = 1; });
    var nodes = mine.slice();                                           // the cell's own boxes, plus neighbours close enough to touch a chip (kept as obstacles only: no handle)
    g.nodes.forEach(function (n) { if (!set[n.id] && n.x < x1 && n.x + n.w > x0 && n.y < y1 && n.y + n.h > y0) { var c = {}; for (var q in n) c[q] = n[q]; c.handle = ''; nodes.push(c); } });
    var edges = [];
    eb.forEach(function (b) {
      if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) return;
      var P = b.e.pts;
      for (var i = 0; i < P.length - 1; i++) {
        var a = P[i], c = P[i + 1];
        if (Math.max(a[0], c[0]) < x0 || Math.min(a[0], c[0]) > x1 || Math.max(a[1], c[1]) < y0 || Math.min(a[1], c[1]) > y1) continue;
        edges.push({ id: b.e.id, pts: [a, c], labelBox: b.e.labelBox || null });
      }
    });
    var L = chipLayout({ width: g.width, height: g.height, nodes: nodes, edges: edges, clusters: [] }, copt2);
    mine.forEach(function (n) { if (L[n.id]) out[n.id] = L[n.id]; });
  });
  return out;
}

/* ---------------------------------------------------------------- small helpers */
function polyD(pts) {
  var d = '', i;
  for (i = 0; i < pts.length; i++) d += (i ? 'L' : 'M') + Math.round(pts[i][0]) + ' ' + Math.round(pts[i][1]);
  return d;
}
var measureCtx = null;
function textW(str, font) {
  try { if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d'); measureCtx.font = font; return measureCtx.measureText(str).width; } catch (e) { return str.length * 7.4; }
}
var PILL_FONT = '650 13px system-ui,"Segoe UI",Helvetica,Arial,sans-serif';
var BAND_AT = 0.5;                                                    // from this zoom on a stage's halo is large enough to carry its title in its own title band
var LONG_MODES = ['off', 'faint', 'on'];                 // the default is off: at the default zoom it is the readable picture ("faint" wraps every district in grey cables). A lit stage or loop still shows its own long roads.
var rdLong = $('#rdLong'), rdOff = $('#rdOff');
/* the "Off by default" overlay: the boxes behind a switch (or reached only by a test) take a tint of their own; everything else steps back. A class on the svg root, so it costs nothing per box. */
function offCount(X) { var n = 0; Object.keys(X.chart.nodes).forEach(function (id) { var st = X.chart.nodes[id].status; if (st === 'off' || st === 'test-only') n++; }); return n; }
function setOffTint(on) {
  if (!C || !isWhole(C.chart)) return;
  C.svg.classList.toggle('show-off', !!on); rdOff.setAttribute('aria-pressed', on ? 'true' : 'false');
  announce(on ? 'Boxes that are off by default are tinted.' : 'The off-by-default tint is off.');
}
rdOff.addEventListener('click', function () { setOffTint(!C.svg.classList.contains('show-off')); });

/* ---------------------------------------------------------------- mount */
function mountWhole(X) {
  if (!isWhole(X.chart)) { rdLong.hidden = true; rdOff.hidden = true; return; }
  var g = X.chart.geom, svg = X.svg, vp = X.vp, intD = [], crossD = [], spineD = [], sp = X.rg && X.rg.spine && X.rg.spine.edges;
  g.edges.forEach(function (e) {
    var d = polyD(e.pts); (e.cross ? crossD : intD).push(d);
    if (sp && sp.has(e.id)) spineD.push(d);
  });
  var farl = svgEl('g', { 'class': 'farl' });
  farl.appendChild(svgEl('path', { 'class': 'fl-int', d: intD.join('') }));
  farl.appendChild(svgEl('path', { 'class': 'fl-x', d: crossD.join('') }));
  var edgesG = $('g.edges', svg); vp.insertBefore(farl, edgesG);
  var spg = svgEl('g', { 'class': 'spine-w' });
  spg.appendChild(svgEl('path', { 'class': 'sw-glow', d: spineD.join('') })); spg.appendChild(svgEl('path', { 'class': 'sw-line', d: spineD.join('') }));
  vp.insertBefore(spg, edgesG);
  X.wh = { pills: [], clusters: {}, mode: 'off', hits: false, state: '', fl: null, ge: null, fitCache: {}, cull: [] };
  groupByStage(X);
  // district tint + the title that lives in the halo's title band
  (g.clusters || []).forEach(function (c) {
    var el = $('g.cluster[data-cluster="' + String(c.id).replace(/"/g, '') + '"]', svg), no = stageNo(c.id), hue = stageHue(c.id);
    if (!el) return;
    X.wh.clusters[c.id] = c;
    if (hue != null) { el.style.setProperty('--sh', hue); el.classList.add('st-cl'); }
    var band = c.titleBand || 46, t = svgEl('text', { 'class': 'cl-band', x: (c.x + 22).toFixed(1), y: (c.y + band * 0.72).toFixed(1), 'font-size': Math.min(26, band * 0.58).toFixed(1) });
    t.innerHTML = (no ? '<tspan class="cb-no">' + no + '</tspan><tspan dx="12">' : '<tspan>') + esc(c.title || stageName(c.id)) + '</tspan>';
    el.appendChild(t);
  });
  // the pills (screen-space, one per stage that has a halo)
  var pg = svgEl('g', { 'class': 'stpills' });
  (g.clusters || []).forEach(function (c) {
    if (stageHue(c.id) == null && !c.title) return;
    var no = stageNo(c.id), nm = c.title || stageName(c.id), p = svgEl('g', { 'class': 'stpill', 'data-region': c.id, tabindex: '-1', role: 'button', 'aria-label': (no ? 'Stage ' + no + ': ' : '') + nm + '. Click to zoom to it.' });
    p.style.setProperty('--sh', stageHue(c.id) == null ? 200 : stageHue(c.id));
    var bg = svgEl('rect', { 'class': 'stp-bg', x: 0, y: -13, height: 26, rx: 13, width: 60 });
    var dot = svgEl('circle', { 'class': 'stp-dot', cx: 14, cy: 0, r: 10 });
    var num = svgEl('text', { 'class': 'stp-no', x: 14, y: 4.4, 'text-anchor': 'middle' }); num.textContent = no ? String(no) : '';
    var tx = svgEl('text', { 'class': 'stp-t', x: 30, y: 4.9 }); tx.textContent = nm;
    p.appendChild(bg); p.appendChild(dot); p.appendChild(num); p.appendChild(tx); pg.appendChild(p);
    X.wh.pills.push({ el: p, c: c, bg: bg, tx: tx, dot: dot, num: num, name: nm, full: textW(nm, PILL_FONT), key: '', no: no });
  });
  vp.appendChild(pg);
  // dock: long roads
  rdLong.hidden = false; rdLong.title = longTitle(X); setLongMode(X.wh.mode, true);
  var no = offCount(X); rdOff.hidden = !no; rdOff.textContent = 'Off by default · ' + no; rdOff.setAttribute('aria-pressed', 'false');
  wholeZoom(view.s, true);
}
FL.onChart(mountWhole);
function wholeSpineRefresh() {                                          // the merged path line again, for another declared path (viewer/walk.js)
  var X = C, sp = X && X.rg && X.rg.spine && X.rg.spine.edges, d = [];
  if (!X || !X.wh) return;
  X.chart.geom.edges.forEach(function (e) { if (sp && sp.has(e.id)) d.push(polyD(e.pts)); });
  $$('.spine-w path', X.svg).forEach(function (p) { p.setAttribute('d', d.join('')); });
}

/* ---------------------------------------------------------------- culling and text on demand.
   What costs a frame on a big map is not what is visible: every SVG text element in the document is laid out again each time the scale changes, even in a hidden group
   (measured: about 5 microseconds each, 60 ms for 9,700 of them), and every element costs a little on every restyle. So:
   - each stage's boxes, inside roads and road labels sit in groups of their own, and the groups are taken OUT of the document while the stage's halo is off screen;
   - the text of the boxes is taken out below the zoom where it is readable (11 px), and the road labels are only made (once, per stage) when the zoom could show them.
   Long roads stay in a group that is always there. The page itself keeps one text per stage pill and title, a few hundred at most. */
var TEXT_AT = 0.72, LABEL_AT = 0.84;
function labelMarkup(e) {
  var b = e.labelBox, h = '<g class="elabel" data-edge-label="' + esc(e.id) + '"><rect x="' + (b.x - 3).toFixed(1) + '" y="' + (b.y - 1).toFixed(1) + '" width="' + (b.w + 6).toFixed(1) + '" height="' + (b.h + 2).toFixed(1) + '" rx="6" class="elabel-bg"/>';
  (e.lines || []).forEach(function (l, i) { h += '<text x="' + (b.x + b.w / 2).toFixed(1) + '" y="' + (b.y + 12.5 + i * 15).toFixed(1) + '" text-anchor="middle" class="elabel-text">' + esc(l) + '</text>'; });
  return h + '</g>';
}
function groupByStage(X) {
  var g = X.chart.geom, nodesG = $('g.nodes', X.svg), edgesG = $('g.edges', X.svg), of = {}, W = X.wh, by = {};
  if (!nodesG || !edgesG || !(g.clusters || []).length) return;
  W.lroot = svgEl('g', { 'class': 'edge-labels' }); X.vp.appendChild(W.lroot);
  g.clusters.forEach(function (c) {
    (c.nodes || []).forEach(function (id) { of[id] = c.id; });
    var ng = svgEl('g', { 'class': 'cull cn' }), eg = svgEl('g', { 'class': 'cull ce' });
    nodesG.appendChild(ng); edgesG.appendChild(eg);
    by[c.id] = { c: c, ng: ng, eg: eg, lg: null, edges: [], in: true, tx: true, lgIn: false, texts: [] }; W.cull.push(by[c.id]);
  });
  var xg = svgEl('g', { 'class': 'xroads' });
  g.nodes.forEach(function (n) { var b = by[of[n.id]], el = X.nodeEl.get(n.id); if (b && el) b.ng.appendChild(el); });
  g.edges.forEach(function (e) {
    var el = X.edgeEl.get(e.id); if (!el) return;
    var a = of[e.from], z = of[e.to];
    if (!e.cross && a && a === z && by[a]) { by[a].eg.appendChild(el); if (e.labelBox && e.lines && e.lines.length) by[a].edges.push(e); } else xg.appendChild(el);
  });
  edgesG.appendChild(xg); W.xg = xg;
  W.cull.forEach(function (b) {                                       // the box texts of a stage, with where each one belongs
    b.ng.querySelectorAll('text').forEach(function (t) { b.texts.push([t.parentNode, t]); });
  });
  wholeView(true);
}
function setStageTexts(b, on) {
  if (on === b.tx) return; b.tx = on;
  if (on) b.texts.forEach(function (p) { p[0].appendChild(p[1]); }); else b.texts.forEach(function (p) { if (p[1].parentNode) p[1].parentNode.removeChild(p[1]); });
}
function buildLabels(b) {                                             // the road labels of one stage, made once, the first time the zoom could show them
  var h = '', X = C;
  b.edges.forEach(function (e) { h += labelMarkup(e); });
  b.lg = svgEl('g', { 'class': 'cull cl' }); b.lg.innerHTML = h;
  b.lg.querySelectorAll('g.elabel').forEach(function (el) { X.labelEl.set(el.getAttribute('data-edge-label'), el); });
  return b.lg;
}
function wholeView(force) {                                           // after every pan or zoom
  var W = C && C.wh; if (!W || !W.cull.length) return;
  var s = view.s, m = 0.25 * Math.max(cw, ch) / s, x0 = -view.x / s - m, y0 = -view.y / s - m, x1 = (cw - view.x) / s + m, y1 = (ch - view.y) / s + m;
  var textOn = s >= TEXT_AT, labelOn = s >= LABEL_AT, nodesG = $('g.nodes', C.svg), edgesG = $('g.edges', C.svg), relit = false, budget = force ? 1e9 : 1, later = false;   // at most one stage is brought in per frame: a pan across a boundary never costs two
  W.cull.forEach(function (b) {
    var c = b.c, on = !(c.x > x1 || c.x + c.w < x0 || c.y > y1 || c.y + c.h < y0);
    setStageTexts(b, textOn);
    if (on && !b.in) { if (budget > 0) { budget--; nodesG.appendChild(b.ng); edgesG.insertBefore(b.eg, W.xg); b.in = true; } else later = true; }
    else if (!on && b.in) { if (b.ng.parentNode) nodesG.removeChild(b.ng); if (b.eg.parentNode) edgesG.removeChild(b.eg); b.in = false; }
    var wantL = b.in && labelOn;
    if (wantL && !b.lgIn) { if (budget > 0) { budget--; if (!b.lg) buildLabels(b); W.lroot.appendChild(b.lg); b.lgIn = true; relit = true; } else later = true; }
    else if (!wantL && b.lgIn) { W.lroot.removeChild(b.lg); b.lgIn = false; }
  });
  if (later) schedule();
  if (relit && C.hl && (C.hl.nodes.size || C.hl.edges.size)) paint();     // labels made while something is lit take the lit look
}
/* ---------------------------------------------------------------- long roads button */
function setLongMode(m, quiet) {
  var W = C && C.wh; if (!W) return;
  W.mode = m; LONG_MODES.forEach(function (k) { C.svg.classList.toggle('lr-' + k, k === m); });
  if (m === 'on' && view.s >= 0.55 && !W.hits) makeHits();
  rdLong.textContent = 'Long roads: ' + m; rdLong.setAttribute('aria-pressed', m === 'faint' ? 'mixed' : m === 'on' ? 'true' : 'false');
  if (!quiet) announce('Long roads ' + m + '.');
}
var LONG_BIG = 500;                                                  // above this many boxes "on" is a solid mat: it is not offered, and the button says why
function longModesFor(X) { return X && Object.keys(X.chart.nodes).length > LONG_BIG ? ['off', 'faint'] : LONG_MODES; }
function longTitle(X) {
  return longModesFor(X).length < 3 ? 'The long roads that run between stages: off (the default: a lit stage or loop still shows its own) or faint (they brighten as you zoom in). Each click switches between the two. "On" is not offered on a map of more than ' + LONG_BIG + ' boxes: all ' + Object.keys(X.chart.edges).length.toLocaleString('en-US') + ' roads at once is a solid mat that hides the map. Light a stage or a loop to see its long roads, or open the glance chart for the stage-to-stage roads.'
    : 'The long roads that run between stages: off (the default: a lit stage or loop still shows its own), faint (they brighten as you zoom in) or on. Each click goes to the next, and the one after "on" is off.';
}
rdLong.addEventListener('click', function () { var W = C && C.wh; if (!W) return; var ms = longModesFor(C); setLongMode(ms[(ms.indexOf(W.mode) + 1) % ms.length]); });

/* "100%" on the whole map lands on a stage, never on the gutter between two: the stage nearest the middle of what is visible, at actual size, its top left (and so its title) in view when it is bigger than the canvas, centred when it is smaller */
function whole100() {
  var W = C && C.wh; if (!W) return false;
  var vr = visRect(), mx = (vr.x0 + vr.x1) / 2, my = ch / 2, best = null, bd = 1e18;
  Object.keys(W.clusters).forEach(function (id) {
    var c = W.clusters[id], x0 = c.x * view.s + view.x, y0 = c.y * view.s + view.y, x1 = x0 + c.w * view.s, y1 = y0 + c.h * view.s;
    var dx = Math.max(x0 - mx, 0, mx - x1), dy = Math.max(y0 - my, 0, my - y1), d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = c; }
  });
  if (!best) return false;
  var aw = vr.x1 - vr.x0 - 48, ah = ch - 140, tx = best.w <= aw ? mx - (best.x + best.w / 2) : vr.x0 + 24 - best.x, ty = best.h <= ah ? 64 + ah / 2 - (best.y + best.h / 2) : 64 - best.y;
  S.autoFit = false; setView({ s: 1, x: tx, y: ty }, true, 320); return true;
}

/* ---------------------------------------------------------------- the whole map is centred by what is drawn
   The layout's own extent keeps empty room on its left, and a stage pill runs on past a narrow halo (to the next pill in its row, or the canvas edge), so centring the extent leaves a wide empty strip on one side and a title near the other edge.
   At the fit, the left and right gaps are made equal: the leftmost halo or pill and the rightmost halo or pill (titles included) are centred in the canvas. Only the view moves; nothing in the geometry does. */
function centreWhole(t, lo, hi) {                   // lo, hi: the canvas room a left drawer and a right panel leave (the map is centred in that)
  var W = C && C.wh, g = C && C.chart.geom; if (!W || !g || !W.pills || !W.pills.length || !g.clusters || !g.clusters.length) return t;
  var s = t.s, vx = t.x, vy = t.y, scr = W.pills.map(function (P) { return { l: P.c.x * s + vx + 9, t: P.c.y * s + vy + 6 }; }), L = 1e9, R = -1e9;
  g.clusters.forEach(function (c) { L = Math.min(L, c.x * s + vx); R = Math.max(R, (c.x + c.w) * s + vx); });
  W.pills.forEach(function (P, pi) {
    var c = P.c, me = scr[pi], lim = cw - 12, o, availW, lines, tw = 0, w;
    for (o = 0; o < scr.length; o++) if (o !== pi && Math.abs(scr[o].t - me.t) < 30 && scr[o].l > me.l + 4 && scr[o].l - 8 < lim) lim = scr[o].l - 8;       // the next pill in this row (as wholeZoom finds it)
    availW = Math.max(c.w * s - 30 - 16, lim - me.l - 30 - 12);
    lines = P.no ? pillLines(P, availW) : [P.name]; lines.forEach(function (l) { tw = Math.max(tw, textW(l, PILL_FONT)); });
    w = 30 + (tw ? tw + 12 : 0) + (P.no ? 0 : -6);
    L = Math.min(L, me.l); R = Math.max(R, me.l + Math.max(28, w));
  });
  if (!(R > L)) return t;
  lo = lo || 0; hi = hi == null ? cw : hi;
  return { s: t.s, x: t.x + ((hi - R) - (L - lo)) / 2, y: t.y, floored: t.floored, bar: t.bar };
}

/* ---------------------------------------------------------------- zoom: pills, band titles, hit paths */
function pillFit(P, availW) {                                         // the name that fits in availW screen px, with an ellipsis; the number always stays
  var full = P.full;
  if (full <= availW) return P.name;
  if (availW < 24) return '';
  var k = 'a' + Math.round(availW / 6) + P.c.id, hit = C.wh.fitCache[k];
  if (hit != null) return hit;
  var lo = 1, hi = P.name.length - 1, best = 1;
  while (lo <= hi) { var mid = (lo + hi) >> 1, w = textW(P.name.slice(0, mid).replace(/\s+$/, '') + '…', PILL_FONT); if (w <= availW) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return (C.wh.fitCache[k] = P.name.slice(0, best).replace(/\s+$/, '') + '…');
}
/* a stage's pill may be wider than its tile: it runs on to the next pill in its row (or the canvas edge), and a name that still does not fit goes on a second line, cut only at the end of that.
   (It was cut at the tile's width, with a gutter beside it.) */
function cutTo(str, availW) {
  if (textW(str, PILL_FONT) <= availW) return str;
  var lo = 1, hi = str.length - 1, best = 1;
  while (lo <= hi) { var mid = (lo + hi) >> 1; if (textW(str.slice(0, mid).replace(/\s+$/, '') + '…', PILL_FONT) <= availW) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return str.slice(0, best).replace(/\s+$/, '') + '…';
}
function pillLines(P, availW) {                                       // the name as one or two lines that fit availW screen px
  if (P.full <= availW) return [P.name];
  if (availW < 24) return [''];
  var k = 'L' + Math.round(availW / 4) + P.c.id, hit = C.wh.fitCache[k]; if (hit) return hit;
  var words = P.name.split(/\s+/), best = null, i, a, b, m, out;
  for (i = 1; i < words.length; i++) {
    a = words.slice(0, i).join(' '); b = words.slice(i).join(' ');
    if (textW(a, PILL_FONT) <= availW && textW(b, PILL_FONT) <= availW) { m = Math.max(textW(a, PILL_FONT), textW(b, PILL_FONT)); if (!best || m < best.m) best = { l: [a, b], m: m }; }
  }
  if (best) out = best.l;
  else {
    var first = '', j = 0; while (j < words.length && textW((first ? first + ' ' : '') + words[j], PILL_FONT) <= availW) { first += (first ? ' ' : '') + words[j]; j++; }
    out = first && j < words.length ? [first, cutTo(words.slice(j).join(' '), availW)] : [cutTo(P.name, availW)];
  }
  return (C.wh.fitCache[k] = out);
}
function setPillLines(P, lines) {
  var tx = P.tx; while (tx.firstChild) tx.removeChild(tx.firstChild);
  if (lines.length === 1) { tx.setAttribute('y', '4.9'); tx.textContent = lines[0]; P.dot.setAttribute('cy', '0'); P.num.setAttribute('y', '4.4'); P.bg.setAttribute('height', '26'); P.bg.setAttribute('rx', '13'); return; }
  var l1 = svgEl('tspan', { x: 30 }), l2 = svgEl('tspan', { x: 30, dy: 15 }); l1.textContent = lines[0]; l2.textContent = lines[1]; tx.setAttribute('y', '-1.2'); tx.appendChild(l1); tx.appendChild(l2);
  P.dot.setAttribute('cy', '5.6'); P.num.setAttribute('y', '10'); P.bg.setAttribute('height', '37'); P.bg.setAttribute('rx', '15');
}
function wholeZoom(s, force) {
  var W = C && C.wh; if (!W) return;
  var bands = s >= BAND_AT, st = bands ? 'bands' : 'pills';
  if (st !== W.state) { W.state = st; C.svg.classList.toggle('st-bands', bands); C.svg.classList.toggle('st-pills', !bands); force = true; }
  if (!bands) {
    var k = 1 / s, scr = W.pills.map(function (P) { return { l: P.c.x * s + view.x + 9, t: P.c.y * s + view.y + 6 }; });
    W.pills.forEach(function (P, pi) {
      var c = P.c, me = scr[pi], lim = cw - 12, o, availW, lines, key, tw, w;
      for (o = 0; o < scr.length; o++) if (o !== pi && Math.abs(scr[o].t - me.t) < 30 && scr[o].l > me.l + 4 && scr[o].l - 8 < lim) lim = scr[o].l - 8;       // the next pill in this row
      availW = Math.max(c.w * s - 30 - 16, lim - me.l - 30 - 12);
      lines = P.no ? pillLines(P, availW) : [P.name]; key = lines.join('|');
      if (key !== P.key || force) {
        P.key = key; setPillLines(P, lines); tw = 0; lines.forEach(function (l) { tw = Math.max(tw, textW(l, PILL_FONT)); });
        w = 30 + (tw ? tw + 12 : 0) + (P.no ? 0 : -6);
        P.bg.setAttribute('width', Math.max(28, w).toFixed(0));
      }
      P.el.setAttribute('transform', 'translate(' + (c.x + 9 * k).toFixed(1) + ' ' + (c.y + 6 * k).toFixed(1) + ') scale(' + k.toFixed(5) + ')');
    });
  }
  if (s >= 0.55 && !W.hits && W.mode === 'on') makeHits();
  placeFocusLabels();
}
FL.onZoom(function (s) { wholeZoom(s, false); });
function makeHits() {                                                 // wide invisible hit paths for the long roads: only once the map is zoomed in
  var W = C.wh; W.hits = true;
  C.edgeEl.forEach(function (el) {
    if (!el.hasAttribute('data-cross') || el.firstChild && el.firstChild.classList && el.firstChild.classList.contains('edge-hit')) return;
    var line = el.querySelector('.edge-line'); if (!line) return;
    el.insertBefore(svgEl('path', { 'class': 'edge-hit', d: line.getAttribute('d') }), line);
  });
}

/* ---------------------------------------------------------------- focus: lit long roads show their condition, and a stage pill lights its district */
function geomEdge(id) {
  var W = C.wh; if (!W.ge) { W.ge = {}; C.chart.geom.edges.forEach(function (e) { W.ge[e.id] = e; }); }
  return W.ge[id];
}
function litLabelEdges() {                                            // the roads of the focused box or road that have a condition to show
  var h = C.hl, out = [];
  if (!h || !h.edges.size || C.svg.classList.contains('rg-focus')) return out;
  h.edges.forEach(function (cls, id) { var e = geomEdge(id); if (e && e.cross && e.focusLabel && e.lines && e.lines.length) out.push({ e: e, cls: cls }); });
  out.sort(function (a, b) { return (a.cls === 'sel' ? 0 : 1) - (b.cls === 'sel' ? 0 : 1); });
  return out.slice(0, 80);
}
function focusLabelEl(e, cls) {                                       // made the first time a road is lit, then reused
  var W = C.wh, fl = W.fl || (W.fl = { g: svgEl('g', { 'class': 'focus-labels' }), cache: {}, shown: [] });
  if (!fl.g.parentNode) C.vp.appendChild(fl.g);
  var el = fl.cache[e.id];
  if (!el) {
    var b = e.focusLabel;
    el = svgEl('g', { 'class': 'elabel fl', 'data-edge-label': e.id });
    el.appendChild(svgEl('rect', { 'class': 'elabel-bg', x: (b.x - 3).toFixed(1), y: (b.y - 1).toFixed(1), width: (b.w + 6).toFixed(1), height: (b.h + 2).toFixed(1), rx: 6 }));
    e.lines.forEach(function (l, i) { var t = svgEl('text', { 'class': 'elabel-text', x: (b.x + b.w / 2).toFixed(1), y: (b.y + 12.5 + i * 15).toFixed(1), 'text-anchor': 'middle' }); t.textContent = l; el.appendChild(t); });
    fl.cache[e.id] = el; fl.g.appendChild(el);
  }
  el.setAttribute('class', 'elabel fl rel hi-' + cls);
  return el;
}
function litHits() {                                                  // a lit long road can be clicked: give it its hit path
  var h = C.hl; if (!h) return;
  h.edges.forEach(function (cls, id) {
    var el = C.edgeEl.get(id); if (!el || !el.hasAttribute('data-cross') || el.querySelector('.edge-hit')) return;
    var line = el.querySelector('.edge-line'); if (line) el.insertBefore(svgEl('path', { 'class': 'edge-hit', d: line.getAttribute('d') }), line);
  });
}
function placeFocusLabels() {                                         // screen-space size (about 13 px at any zoom), greedy so two labels never sit on each other
  var W = C && C.wh, fl = W && W.fl; if (!fl) return;
  var s = view.s, k = Math.max(1, 1 / s), taken = [];
  fl.shown.forEach(function (it) {
    var b = it.e.focusLabel, cx = b.x + b.w / 2, cy = b.y + b.h / 2, w = (b.w + 6) * k * s, h = (b.h + 2) * k * s;
    var x = view.x + cx * s - w / 2, y = view.y + cy * s - h / 2, hit = false, i;
    if (x > cw || x + w < 0 || y > ch || y + h < 0) hit = true;     // off screen: leave it hidden
    for (i = 0; !hit && i < taken.length; i++) { var q = taken[i]; if (x < q.x + q.w + 4 && q.x < x + w + 4 && y < q.y + q.h + 3 && q.y < y + h + 3) hit = true; }
    it.el.setAttribute('display', hit ? 'none' : 'inline');
    if (!hit) taken.push({ x: x, y: y, w: w, h: h });
    it.el.setAttribute('transform', k > 1.001 ? 'translate(' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ') scale(' + k.toFixed(4) + ') translate(' + (-cx).toFixed(1) + ' ' + (-cy).toFixed(1) + ')' : '');
  });
}
function wholePaint() {
  var W = C && C.wh; if (!W) return;
  // pills: lit when their district is hovered or pinned
  var hov = S.hover && S.hover.t === 'region' ? S.hover.id : null;
  W.pills.forEach(function (P) { P.el.classList.toggle('hov', P.c.id === hov); P.el.classList.toggle('sel', S.regSel.indexOf(P.c.id) >= 0); });
  // lit long roads: their conditions
  litHits();
  var lit = litLabelEdges(), fl = W.fl;
  if (fl) fl.shown.forEach(function (it) { it.el.setAttribute('display', 'none'); });
  if (!lit.length) { if (fl) fl.shown = []; return; }
  fl = W.fl; var shown = [];
  lit.forEach(function (o) { shown.push({ e: o.e, el: focusLabelEl(o.e, o.cls) }); });
  W.fl.shown = shown; placeFocusLabels();
}
FL.onPaint(wholePaint);
