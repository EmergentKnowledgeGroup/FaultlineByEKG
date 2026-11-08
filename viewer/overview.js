/* ================================================================ OVERVIEW POSTER, STAGE BREADCRUMB, "NOT DRAWN YET"
   Spliced into viewer.js (same closure) after whole.js.
   - overview: each stage box carries its stage's hue and number (the same hue as its dot in the nav and its halo on the whole map). Selecting a stage lists ALL its roads, the drawn
     ones and the ones the overview does not draw (chart.notDrawn), with counts, and offers a plain way in (open the stage). A note says how many roads are not drawn.
   - part charts: a breadcrumb (stage, part name, "2 of 6", previous, next).
   - a chart with no layout yet says "not drawn yet" instead of showing an empty map. */

var crumbEl = $('#chartCrumb'), ovNote = $('#ovNote'), unplacedNote = $('#unplacedNote');

/* ---------------------------------------------------------------- the stage poster (overview) */
function overviewTarget(nid) {                                        // the chart a click on this overview box opens: the stage's first part, or the chart that holds the ending
  var c = C && C.chart; if (!c || c.kind !== 'overview') return null;
  var n = c.nodes[nid]; if (!n) return null;
  if (META.toolMap && n.synth === 'stage' && toolStageOf(n.stage)) { var tg = toolStageOf(n.stage); return { stage: n.stage, list: true, fns: tg.rows.length + tg.small.length, label: n.title }; }
  if (n.synth === 'stage' && STAGE_CHARTS[n.stage]) { var ids = STAGE_CHARTS[n.stage]; return { chart: stageEntry(n.stage) || ids[0], parts: ids.length, boxes: stageBoxCount(n.stage), label: n.title }; }
  var pl = (c.portals || []).filter(function (p) { return p.node === nid && p.kind === 'detail' && CH[p.chart]; })[0];
  return pl ? { chart: pl.chart, parts: 1, boxes: (n.boxes || []).length, label: n.title, ending: true } : null;
}
function openOverviewTarget(nid) {
  var t = overviewTarget(nid); if (!t) return false;
  if (t.list) return openToolStage(t.stage);
  pushJump(); openChart(t.chart, null, { push: true }); return true;
}
function mountOverview(X) {
  ovNote.hidden = true;
  if (X.chart.kind !== 'overview') return;
  var R = 10;
  X.badges = [];
  X.chart.geom.nodes.forEach(function (gn) {                          // the number sits on the box's top-left corner, like a handle chip; it keeps 13 px on screen (ovZoom)
    var dn = X.chart.nodes[gn.id], el = X.nodeEl.get(gn.id);
    if (!dn || !el || dn.synth !== 'stage' || !stageNo(dn.stage)) return;
    var g = svgEl('g', { 'class': 'stn', 'aria-hidden': 'true' });
    g.appendChild(svgEl('circle', { cx: (gn.x + 2).toFixed(1), cy: (gn.y + 2).toFixed(1), r: R }));
    var t = svgEl('text', { x: (gn.x + 2).toFixed(1), y: (gn.y + 6.2).toFixed(1), 'text-anchor': 'middle' }); t.textContent = String(stageNo(dn.stage));
    g.appendChild(t); el.appendChild(g); X.badges.push({ el: g, cx: gn.x + 2, cy: gn.y + 2, k: 0 });
  });
  // where the main path starts and where it ends: the node of its first box and the node of its last box (a stage, or the ending group when the last box is an ending that stops)
  var sp = strs(X.chart.spine);
  [[sp[0], 'START', 'start'], [sp.length > 1 ? sp[sp.length - 1] : '', 'END', 'end']].forEach(function (t) {
    var gn = t[0] && X.chart.geom.nodes.filter(function (n) { return n.id === t[0]; })[0], el = gn && X.nodeEl.get(gn.id); if (!gn || !el) return;
    var ax = gn.x + gn.w - 2, ay = gn.y - 5, w = t[1] === 'START' ? 46 : 34, g = svgEl('g', { 'class': 'stt stt-' + t[2], 'aria-hidden': 'true' }), tt = svgEl('title');
    tt.textContent = t[1] === 'START' ? 'The main path starts here' : 'The main path ends here';
    g.appendChild(tt); g.appendChild(svgEl('rect', { x: (ax - w).toFixed(1), y: (ay - 9).toFixed(1), width: w, height: 18, rx: 9 }));
    var tx = svgEl('text', { x: (ax - w / 2).toFixed(1), y: (ay + 4).toFixed(1), 'text-anchor': 'middle' }); tx.textContent = t[1]; g.appendChild(tx);
    el.appendChild(g); X.badges.push({ el: g, cx: ax, cy: ay, k: 0 });
  });
  var onMain = {}; strs(X.chart.spine).forEach(function (id) { onMain[id] = 1; });                  // the stages the main path runs through: an outline on the box and a tag in the panel
  X.chart.geom.nodes.forEach(function (gn) { var dn = X.chart.nodes[gn.id], el = X.nodeEl.get(gn.id); if (dn && el && dn.synth === 'stage' && onMain[gn.id]) { el.classList.add('on-main'); dn.onMain = true; } });
  ovZoom(view.s);
  var nd = X.chart.notDrawn || [], drawn = Object.keys(X.chart.edges).length, total = drawn + nd.length;
  if (nd.length) { ovNote.innerHTML = '<b>' + nd.length + '</b> of <b>' + total + '</b> roads between stages are not drawn here. Select a stage to see all of its roads.'; ovNote.hidden = false; }
}
FL.onChart(mountOverview);
function ovZoom(s) {
  var X = C; if (!X || !X.badges || !X.badges.length) return;
  var k = Math.max(1, 13.5 / (12 * s)); k = Math.round(k * 20) / 20;
  X.badges.forEach(function (b) { if (b.k === k) return; b.k = k; b.el.setAttribute('transform', k > 1 ? 'translate(' + b.cx.toFixed(1) + ' ' + b.cy.toFixed(1) + ') scale(' + k + ') translate(' + (-b.cx).toFixed(1) + ' ' + (-b.cy).toFixed(1) + ')' : ''); });
}
FL.onZoom(ovZoom);

/* all roads of one overview box: drawn (clickable, lit on the map) and not drawn (listed, with the counterpart) */
function overviewRoads(id) {
  var c = C.chart, n = c.nodes[id], drawn = { 'in': [], out: [] }, hidden = { 'in': [], out: [] };
  Object.keys(c.edges).forEach(function (eid) {
    var e = c.edges[eid], k = (e.via || []).length || 1;
    if (e.to === id) drawn['in'].push({ id: eid, other: e.from, n: k, when: eShort(e), type: e.type });
    if (e.from === id) drawn.out.push({ id: eid, other: e.to, n: k, when: eShort(e), type: e.type });
  });
  (c.notDrawn || []).forEach(function (r) {
    if (r.to === id) hidden['in'].push({ other: r.from, n: r.count, when: r.when });
    if (r.from === id) hidden.out.push({ other: r.to, n: r.count, when: r.when });
  });
  var cnt = function (a) { return a.reduce(function (t, x) { return t + x.n; }, 0); };
  var row = function (r, dir) {
    var nm = nodeName(r.other), routes = r.n + (r.n === 1 ? ' road' : ' roads') + (r.when ? ' · ' + r.when : '');
    return r.id ? '<button type="button" class="route ' + dir + '" data-edge="' + esc(r.id) + '"><span class="r-label">' + esc(nm) + '</span><span class="r-node">' + esc(routes) + '</span></button>'
      : '<button type="button" class="route nd ' + dir + '" data-node="' + esc(r.other) + '" title="This road is not drawn on the overview. Click to select the stage at its other end."><span class="r-tag">not drawn</span><span class="r-label">' + esc(nm) + '</span><span class="r-node">' + esc(routes) + '</span></button>';
  };
  var block = function (dir, title, quiet) {
    var all = drawn[dir].concat(hidden[dir]).sort(function (a, b) { return b.n - a.n; });
    if (!all.length) return '<h3 class="p-' + dir + '">' + title + '</h3><p class="quiet">' + quiet + '</p>';
    return '<h3 class="p-' + dir + '">' + title + ' <span class="quiet">' + all.length + ' bundle' + (all.length === 1 ? '' : 's') + (META.toolMap ? '' : ' · ' + cnt(all) + ' roads') + (hidden[dir].length ? ' · ' + hidden[dir].length + ' not drawn' : '') + '</span></h3><div class="routes">' + all.map(function (r) { return row(r, dir); }).join('') + '</div>';
  };
  return (n && n.synth === 'stage' ? termsBlock(n.title) : '') + stageRoadsLine(id) + block('in', 'Roads in', 'Nothing arrives here from another stage: a starting point.') + block('out', 'Roads out', 'Nothing leaves here for another stage: an end point.');
}
function overviewOpenBlock(id) {
  var t = overviewTarget(id); if (!t) return '';
  var n = C.chart.nodes[id], hue = n.stage ? stageHue(n.stage) : null;
  if (t.list) return '<button type="button" class="btn-open" data-ov-stage="' + esc(t.stage) + '"' + (hue != null ? ' style="--sh:' + hue + '"' : '') + '>List the functions of ' + esc(t.label) + ' &rarr;<small>' + t.fns + (t.fns === 1 ? ' function' : ' functions') + ' with a chart</small></button>';
  return '<button type="button" class="btn-open" data-ov-open="' + esc(t.chart) + '"' + (hue != null ? ' style="--sh:' + hue + '"' : '') + '>Open ' + (t.ending ? 'where it is drawn' : esc(t.label)) + ' &rarr;<small>' + (t.ending ? esc(CH[t.chart].navLabel) : t.parts + (t.parts === 1 ? ' chart' : ' charts') + ' · ' + t.boxes + ' steps') + '</small></button>';
}
function stageRoadsLine(id) {                                         // the stage's own roads, counted once (counts.mjs stageRoads), the same numbers the whole map's panel prints
  if (META.toolMap) return '';                                       // a tool map states each stage's own numbers in its sentence and counts only bundles here
  var n = C.chart.nodes[id], SR = META.counts && META.counts.stageRoads, s = n && n.synth === 'stage' && SR && SR[n.stage]; if (!s) return '';
  return '<div class="ov-sum"><span><b>' + s.boxes + '</b>' + wBox(s.boxes) + '</span><span><b>' + s.inside + '</b>' + wRoad(s.inside) + ' inside</span><span><b>' + s.enter + '</b> arrive from other stages</span><span><b>' + s.leave + '</b> leave for other stages</span></div>' +
    '<p class="quiet">Roads counted one by one, as on the whole map. The lines below are bundles: each stands for every road between the same two stages.</p>';
}
function overviewSummaryBlock() {                                     // what the overview does and does not draw, in numbers, above the stage list
  var c = C.chart, nd = c.notDrawn || [], drawn = Object.keys(c.edges).length;
  if (!nd.length) return '';
  return '<div class="ov-sum"><span><b>' + drawn + '</b> stage-to-stage roads drawn</span><span><b>' + nd.length + '</b> not drawn</span><span><b>' + (drawn + nd.length) + '</b> in all</span></div>' +
    '<p class="quiet">Each road here bundles every road between the same two stages (<a class="hlink" href="#reading=scope&amp;section=numbers">what the numbers count</a>). Select a stage to see every road of it, drawn or not.</p>';
}

/* ---------------------------------------------------------------- the breadcrumb on a stage part */
function chartHeadTitle(chart) { return chart.kind === 'stage' && chart.parts > 1 && chart.name ? chart.name : chart.title; }
function drawCrumb(chart) {
  if (chart.kind !== 'stage' || !chart.stage || STAGE_IDX[chart.stage] == null) { crumbEl.hidden = true; crumbEl.innerHTML = ''; return; }
  var sid = chart.stage, parts = STAGE_CHARTS[sid] || [], i = parts.indexOf(chart.id), no = stageNo(sid);
  var h = '<button type="button" class="cr-st" data-crumb="' + esc(stageEntry(sid) || parts[0] || chart.id) + '" style="--sh:' + stageHue(sid) + '" title="Open the part of this stage where the main path enters it"><span class="cr-no">' + no + '</span><span class="cr-stn">' + esc(stageName(sid)) + '</span></button>';
  if (parts.length > 1) {
    h += '<span class="cr-sep" aria-hidden="true">&rsaquo;</span><span class="cr-part" title="' + esc(chart.name || chart.title) + '">' + esc(chart.name || chart.title) + '</span><span class="cr-pos">' + (i + 1) + ' of ' + parts.length + '</span>' +
      '<span class="cr-cnt">' + Object.keys(chart.nodes).length + wBox(Object.keys(chart.nodes).length) + ' · ' + Object.keys(chart.edges).length + wRoad(Object.keys(chart.edges).length) + '</span><span class="cr-nav" style="--sh:' + stageHue(sid) + '"><button type="button" class="cr-b" data-crumb="' + esc(parts[i - 1] || '') + '"' + (i > 0 ? '' : ' disabled') + ' aria-label="Previous part of this stage" title="The part of this stage before this one"><span class="cr-ch">&lsaquo;</span><span class="cr-bt">Previous part</span></button>' +
      '<button type="button" class="cr-b" data-crumb="' + esc(parts[i + 1] || '') + '"' + (i < parts.length - 1 ? '' : ' disabled') + ' aria-label="Next part of this stage" title="The part of this stage after this one"><span class="cr-bt">Next part</span><span class="cr-ch">&rsaquo;</span></button></span>';
  }
  crumbEl.innerHTML = h; crumbEl.hidden = false; crumbEl.style.setProperty('--sh', stageHue(sid));
  $('.tb-title').classList.toggle('crumb-title', parts.length > 1);        // the part's name sits in the breadcrumb, so it is not written twice
}
crumbEl.addEventListener('click', function (e) {
  var b = e.target.closest('[data-crumb]'); if (!b || !b.dataset.crumb || b.disabled) return;
  openChart(b.dataset.crumb, null, { push: true });
});
FL.onChart(function (X) { if (X.chart.kind !== 'stage') $('.tb-title').classList.remove('crumb-title'); drawCrumb(X.chart); });

/* a flow-bar chip names the part, and the stage only when it is a different stage from the one on screen */
function chipLabel(id) {
  var c = CH[id]; if (!c) return id;
  if (c.kind !== 'stage' || !c.stage) return c.navLabel;
  var nm = c.name || c.title, here = C && C.chart.kind === 'stage' && C.chart.stage === c.stage;
  return here || !c.name ? nm : stageName(c.stage) + ' · ' + nm;
}

/* ---------------------------------------------------------------- a chart with no layout yet */
FL.onChart(function (X) {
  var un = !!X.chart.unplaced;
  unplacedNote.hidden = !un;
  if (un) unplacedNote.innerHTML = '<b>Not drawn yet</b>This chart has boxes and roads in the data, but no layout has been made for it. It is listed in the draft status; the details panel still lists its boxes.';
});

/* ---------------------------------------------------------------- a chart whose boxes have no road between them: said on the chart too */
FL.onChart(function (X) {
  var c = X.chart, ids = Object.keys(c.nodes), none = ids.length >= 1 && !Object.keys(c.edges).length && c.kind !== 'overview' && c.kind !== 'whole' && !c.unplaced;
  if (none) { ovNote.innerHTML = ids.length === 1 ? 'This step has no road to another step here; it joins the rest through other charts. The details panel says how many roads it has.' : 'These <b>' + ids.length + '</b> steps have no road between them here; each joins the rest through other charts. The details panel lists each one’s roads.'; ovNote.hidden = false; }
  else if (c.kind !== 'overview') ovNote.hidden = true;
});
