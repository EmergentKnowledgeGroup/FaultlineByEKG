/* ================================================================ FLOW: portals between charts, the flow bar, "Follow the flow", nav dots
   Spliced into viewer.js (same closure) by the assembler.  Every field is optional:
     chart.flow    {role, order, prev[], next[], blurb}
     chart.portals [{id, node, dir:'in'|'out', chart, node2, kind, label, why}]   node = step in THIS chart, chart/node2 = the other end
     DATA.sections [{id, title, charts[]}]  (or {journeyOrder[], sections[]}; DATA.portalsMeta is read too).  The walk order is journeyOrder, else the sections' charts in order, else the nav order.
     DATA.meta.roleWords {role: 'Words shown'} adds to the built-in role words
   The coloured rings + corner badges on the boxes themselves are drawn by render.mjs (renderSVG(g, {portals})). */
var PM = DATA.portalsMeta || (DATA.sections && !Array.isArray(DATA.sections) ? DATA.sections : {});
var SECTIONS = (Array.isArray(DATA.sections) ? DATA.sections : Array.isArray(PM.sections) ? PM.sections : []).filter(function (s) { return s && Array.isArray(s.charts); });
var JOURNEY = strs(PM.journeyOrder || DATA.journeyOrder).filter(function (id) { return CH[id]; });
if (!JOURNEY.length) SECTIONS.forEach(function (s) { s.charts.forEach(function (id) { if (CH[id] && JOURNEY.indexOf(id) < 0) JOURNEY.push(id); }); });
var SECT_COL = ['#5aa8ff', '#33c6d6', '#45d19f', '#d9c442', '#f2a03c', '#ef6a6a', '#b88af2', '#7f93f0', '#e07ac4'];
var SECT_OF = {};
SECTIONS.forEach(function (s, i) { var sg = String(s.id || '').replace(/^sec_/, ''); s.color = s.color || (STAGE_HUE[sg] != null ? stageCol(sg) : SECT_COL[i % SECT_COL.length]); s.charts.forEach(function (id) { if (CH[id]) SECT_OF[id] = s; }); });
var ROLE_WORDS = Object.assign({ overview: 'Overview', stage: 'Stage', whole: 'Whole system', detail: 'Detail', loop: 'Loop', ending: 'Ending', evidence: 'Evidence' }, META.roleWords || {});   // other role words come from the data
var KIND_WORDS = { detail: 'Detail', handoff: 'Hand-off', 'return': 'Return' };
var KIND_LONG = { detail: 'Opens the detail of this step', handoff: 'The flow is handed over', 'return': 'The flow loops back' };
function roleWord(r) { return ROLE_WORDS[r] || String(r || '').replace(/[-_]+/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
function flowOf(c) { var f = c && c.flow; return f && typeof f === 'object' ? f : null; }
function portalsOf(c) {
  return (c && Array.isArray(c.portals) ? c.portals : []).filter(function (p) { return p && typeof p === 'object' && p.node && c.nodes[p.node] && CH[p.chart]; });
}
function realPortals(list) { return list.filter(function (p) { return !p.syn; }); }          // a road between charts, not a link the overview makes to a stage
function pdir(p) { return p.dir === 'out' ? 'out' : 'in'; }
function secDot(id) { var s = SECT_OF[id]; return s ? '<i class="fc-dot" style="background:' + s.color + '"></i>' : ''; }

var flowBar = $('#flowBar'), fbPrev = $('#fbPrev'), fbNext = $('#fbNext'), fbHere = $('#fbHere'), fbMore = $('#fbMore'), fbStrip = $('#fbStrip'), fbJourney = $('#fbJourney'), followBtn = $('#followBtn');
S.jumps = []; S.follow = false; S.pf = null; S.landing = null;

/* ---- per-chart portal index (called from mountChart) ---- */
function mountPortals(X) {
  X.portals = portalsOf(X.chart); X.pnode = {}; X.pchart = { 'in': {}, out: {} }; X.pidx = {}; X.pMarked = [];
  X.portals.forEach(function (p, i) {
    p._id = p.id || (X.id + ':p' + i); X.pidx[p._id] = p;
    var d = pdir(p), n = X.pnode[p.node] || (X.pnode[p.node] = { 'in': [], out: [] });
    n[d].push(p); (X.pchart[d][p.chart] || (X.pchart[d][p.chart] = [])).push(p);
  });
}
function findPortal(id) { return C && C.pidx ? C.pidx[id] : null; }

/* ---- navigation list: a coloured dot per section (portalsMeta.sections) ---- */
function decorateNav() { /* the stage rows of the nav carry their own colour dot (viewer.js buildNav) */ }

/* ---- the flow bar: [comes from]  THIS CHART (role + blurb)  [leads to] + the thin journey strip ---- */
function flowLists(X) {
  var pick = function (d) {
    var ids = Object.keys(X.pchart[d]).filter(function (id) { return id !== X.id && realPortals(X.pchart[d][id]).length; });
    var main = function (id) { return realPortals(X.pchart[d][id]).some(function (p) { return p.main; }) ? 1 : 0; }, cnt = function (id) { return realPortals(X.pchart[d][id]).length; };
    return ids.map(function (id, i) { return { id: id, i: i }; }).sort(function (a, b) { return main(b.id) - main(a.id) || cnt(b.id) - cnt(a.id) || a.i - b.i; }).map(function (x) { return x.id; });
  };
  return { prev: pick('in'), next: pick('out') };
}
function readingNeighbours(X) {                                   // the chart before and after this one in the guided order: a neighbour in the reading, not a road
  var i = JOURNEY.indexOf(X.id);
  return { i: i, n: JOURNEY.length, prev: i > 0 ? JOURNEY[i - 1] : null, next: i >= 0 && i < JOURNEY.length - 1 ? JOURNEY[i + 1] : null };
}
function chipHTML(id, d) {
  var ps = realPortals(C.pchart[d][id] || []), n = ps.length, c = CH[id], main = ps.some(function (p) { return p.main; });
  return '<button type="button" class="fchip' + (main ? ' main' : '') + '" data-fc="' + esc(id) + '" data-dir="' + d + '" title="' + esc(c.navLabel + (c.navSub ? ' · ' + c.navSub : '') + (main ? '  —  the main path goes this way' : '') + (n ? '  —  ' + n + ' road' + (n === 1 ? '' : 's') + (d === 'in' ? ' in' : ' out') + ': hover to see where' : '  —  click to open')) + '">' +
    secDot(id) + (main ? '<i class="fc-main" aria-hidden="true"></i>' : '') + '<span class="fc-t">' + esc(chipLabel(id)) + '</span>' + (n > 1 ? '<span class="fc-n">' + n + '</span>' : '') + '</button>';
}
function backNote() {
  var b = S.jumps[S.jumps.length - 1]; if (!b || !CH[b.chart] || (C && b.chart === C.id)) return null;      // never a chip back to the chart on screen
  var bn = b.sel && b.sel.t === 'node' && CH[b.chart].nodes[b.sel.id] ? CH[b.chart].nodes[b.sel.id].title : '';
  return { chart: CH[b.chart], node: bn };
}
var chartStepEl = $('#chartStep'), csPrev = $('#csPrev'), csNext = $('#csNext'), csPos = $('#csPos');
function drawChartStep() {                                       // the pair in the top bar: same place on every chart; in a guide it keeps its room and says nothing
  var X = !S.reading && C ? C : null, rn = X ? readingNeighbours(X) : null;
  chartStepEl.classList.toggle('off', !X || !rn || rn.i < 0);
  if (!X || !rn || rn.i < 0) { csPrev.disabled = csNext.disabled = true; csPrev.dataset.rd = csNext.dataset.rd = ''; csPos.textContent = ''; return; }
  csPrev.disabled = !rn.prev; csPrev.dataset.rd = rn.prev || ''; csPrev.title = rn.prev ? 'Previous in the reading order: ' + CH[rn.prev].navLabel : 'This is the first chart';
  csNext.disabled = !rn.next; csNext.dataset.rd = rn.next || ''; csNext.title = rn.next ? 'Next in the reading order: ' + CH[rn.next].navLabel : 'This is the last chart';
  csPos.textContent = 'chart ' + (rn.i + 1) + ' of ' + rn.n;
}
function drawFlowBar() {
  drawChartStep();
  followBtn.hidden = JOURNEY.length < 2;           // "Tour the charts" is in the top bar however the page was opened, a #reading link included (before any chart is open)
  if (!C) return;
  var X = C, f = flowOf(X.chart), L = flowLists(X), bk = backNote(), have = !!(f || X.portals.length || bk);
  followBtn.hidden = JOURNEY.length < 2;
  var stg0 = X.chart.kind === 'stage' && STAGE_IDX[X.chart.stage] != null;
  flowBar.hidden = !(S.follow || bk || L.prev.length || L.next.length || (stg0 && have));   // a row with nothing to say is not drawn (the overview, and a detail chart with no road to or from another chart, have no bar)
  flowBar.classList.toggle('no-here', !stg0);
  if (flowBar.hidden) return;
  var side = function (ids, d) {
    if (!ids.length) return '';                      // an empty side says nothing at all (no "no road arrives from another chart")
    return '<span class="fb-lab"><span class="lt">' + (d === 'in' ? 'From' : 'Leads to') + '</span></span>' + ids.map(function (id) { return chipHTML(id, d); }).join('') + '<button type="button" class="fchip fc-more" hidden></button>';
  };
  fbPrev.innerHTML = (bk ? '<button type="button" class="fb-back" data-act="back" title="Back (Alt+←): ' + esc(bk.chart.navLabel + (bk.node ? ' · ' + bk.node : '')) + '">↩ Back to ' + esc(trunc(bk.chart.navLabel, 24)) + '</button>' : '') + side(L.prev, 'in');
  fbNext.innerHTML = side(L.next, 'out');
  var s = SECT_OF[X.id], role = f && f.role ? roleWord(f.role) : '', rn = readingNeighbours(X);
  var blurb = X.chart.kind === 'stage' ? ((f && f.blurb) || X.chart.navSub || '') : '';        // a stage's blurb is not shown anywhere else; other charts show their summary in the toolbar already
  var rnav = '';                                                  // previous / next chart live in the top bar now (drawChartStep): their place does not depend on this row
  var stg = X.chart.kind === 'stage' && STAGE_IDX[X.chart.stage] != null;           // a stage part: the breadcrumb above the chart says where it is, so this says only which stage
  if (stg) fbHere.innerHTML = '<span class="fb-role" style="--rc:' + stageCol(X.chart.stage) + '">Stage ' + stageNo(X.chart.stage) + ' of ' + STAGE_LIST.length + '</span><span class="fb-txt" title="' + esc(blurb) + '"><b>' + esc(stageName(X.chart.stage)) + '</b></span>' + rnav;
  else fbHere.innerHTML = (role ? '<span class="fb-role" style="--rc:' + (s ? s.color : 'var(--accent)') + '">' + esc(role) + '</span>' : '') + '<span class="fb-txt" title="' + esc(blurb) + '"><b>' + esc(X.chart.kind === 'stage' ? X.chart.navLabel : role || X.chart.navLabel) + '</b>' + (blurb ? ' ' + esc(blurb) : '') + '</span>' + rnav;
  drawStrip(); drawFollow();
  fitFlowRows();
}
function fitFlowRows() { [fbPrev, fbNext].forEach(fitFlowRow); }
function fitFlowRow(box) {
  if (flowBar.hidden || box.offsetParent === null) return;
  var chips = $$('.fchip:not(.fc-more)', box), more = $('.fc-more', box); if (!chips.length || !more) return;
  chips.forEach(function (c) { c.hidden = false; }); more.hidden = true; box.classList.remove('wrapped');
  if (getComputedStyle(flowBar).getPropertyValue('--fb-wrap').trim() === '1') return;      // phone layout: chips wrap, nothing collapses
  var anchor = $('.fb-lab', box) || chips[0], top0 = anchor.offsetTop, fits = function (el) { return el.offsetTop <= top0 + 3; };
  var vis = chips.filter(fits);
  if (vis.length === chips.length) return;
  more.hidden = false; more._hid = [];
  var setMore = function () { var hid = chips.slice(vis.length); more._hid = hid; more.textContent = '+' + hid.length; more.title = hid.map(function (c) { return CH[c.dataset.fc].navLabel; }).join(', '); };
  chips.slice(vis.length).forEach(function (c) { c.hidden = true; }); setMore();
  while (vis.length > 0 && !fits(more)) { vis.pop().hidden = true; setMore(); }
}
window.addEventListener('resize', function () { if (!flowBar.hidden) fitFlowRows(); });
if (window.ResizeObserver) new ResizeObserver(function () { if (!flowBar.hidden) fitFlowRows(); }).observe(flowBar);

function drawStrip() {
  if (JOURNEY.length < 2) { fbStrip.hidden = true; return; }
  fbStrip.hidden = !S.follow;                       // the coloured strip is the progress of "Tour the charts" and is drawn only while the tour is on (it was an unexplained barcode)
  var cur = JOURNEY.indexOf(C.id), h = '';
  JOURNEY.forEach(function (id, i) {
    var s = SECT_OF[id], c = CH[id], first = i === 0 || SECT_OF[JOURNEY[i - 1]] !== s;
    h += '<button type="button" class="fs-seg' + (i === cur ? ' cur' : i < cur ? ' done' : '') + (first && i ? ' first' : '') + '" data-fs="' + esc(id) + '" style="--sc:' + (s ? s.color : 'var(--accent)') + '" title="' + (i + 1) + ' of ' + JOURNEY.length + ' · ' + esc(c.navLabel) + (s ? ' · ' + esc(s.title) : '') + '" aria-label="' + (i + 1) + ' of ' + JOURNEY.length + ': ' + esc(c.navLabel) + '"' + (i === cur ? ' aria-current="step"' : '') + '></button>';
  });
  fbStrip.innerHTML = h;
}
function journeyNeighbors() {
  var i = JOURNEY.indexOf(C.id), n = JOURNEY.length;
  return { i: i, prev: i > 0 ? JOURNEY[i - 1] : null, next: i < 0 ? JOURNEY[0] : (i < n - 1 ? JOURNEY[i + 1] : null) };
}
function drawFollow() {
  followBtn.setAttribute('aria-pressed', S.follow ? 'true' : 'false');
  fbJourney.hidden = !S.follow; flowBar.classList.toggle('following', !!S.follow);
  if (!S.follow || !C) return;
  var J = journeyNeighbors(), s = SECT_OF[C.id], n = JOURNEY.length, p = $('#fjPrev'), x = $('#fjNext');
  p.disabled = !J.prev && J.i >= 0; x.disabled = !J.next;
  p.hidden = J.i < 0; x.textContent = J.i < 0 ? 'Start the walk ›' : 'Next section ›';
  p.title = J.prev ? 'Previous: ' + CH[J.prev].navLabel : 'This is the first section'; x.title = J.next ? (J.i < 0 ? 'Start at ' : 'Next: ') + CH[J.next].navLabel : 'This is the last section';
  $('#fjPos').innerHTML = J.i < 0 ? 'This chart is outside the guided walk (' + n + ' sections).' :
    '<b>' + (J.i + 1) + ' / ' + n + '</b>' + (s ? ' · <span class="fj-sec" style="--sc:' + s.color + '">' + esc(s.title) + '</span>' : '') + (J.next ? '<span class="fj-next"> · next: ' + esc(CH[J.next].navLabel) + '</span>' : '<span class="fj-next"> · the last section</span>');
}
function setFollow(on, o) {
  S.follow = !!on; drawFlowBar();
  if (S.follow && C && JOURNEY.indexOf(C.id) < 0 && !(o && o.stay)) openChart(JOURNEY[0], null, { push: true });
  announce(S.follow ? 'Tour the charts: step through them in reading order.' : 'Tour the charts off.');
}
followBtn.addEventListener('click', function () {
  if (S.reading && C) { openChart(S.lastChart, null, { push: true }); setFollow(true, { stay: true }); return; }     // from a guide: back to the diagrams, walk on
  setFollow(!S.follow);
});
function bestPortalTo(chartId, d) { var l = C && C.pchart[d][chartId]; return l && l.length ? l[0] : null; }
function followStep(delta) {
  if (!C) return;
  var J = journeyNeighbors(), target = delta > 0 ? J.next : J.prev; if (!target) { announce(delta > 0 ? 'This is the last section.' : 'This is the first section.'); return; }
  var p = J.i >= 0 ? bestPortalTo(target, delta > 0 ? 'out' : 'in') : null;
  if (p) jumpTo(p); else { pushJump(); openChart(target, null, { push: true }); }
}
$('#fjPrev').addEventListener('click', function () { followStep(-1); });
$('#fjNext').addEventListener('click', function () { followStep(1); });
chartStepEl.addEventListener('click', function (e) { var b = e.target.closest('.fb-rdb'); if (!b || b.disabled || !b.dataset.rd) return; pushJump(); openChart(b.dataset.rd, null, { push: true }); });
fbStrip.addEventListener('click', function (e) { var b = e.target.closest('.fs-seg'); if (!b || b.dataset.fs === (C && C.id)) return; pushJump(); openChart(b.dataset.fs, null, { push: true }); });

/* ---- chips: click = open (landing on the connected step when there is one); hover/focus = light up the portal steps on THIS chart ---- */
function setPortalFocus(pf) {
  if (JSON.stringify(pf) === JSON.stringify(S.pf)) return;
  S.pf = pf; paintPortalFocus();
  $$('.fchip.on', flowBar).forEach(function (c) { c.classList.remove('on'); });
  if (pf) $$('.fchip[data-fc="' + pf.chart + '"][data-dir="' + pf.dir + '"]', flowBar).forEach(function (c) { c.classList.add('on'); });
}
function paintPortalFocus() {
  if (!C || !C.pMarked) return;
  C.pMarked.forEach(function (m) { m[0].classList.remove.apply(m[0].classList, m[1]); }); C.pMarked = [];
  var pf = S.pf, any = false;
  if (pf && C.pchart[pf.dir] && C.pchart[pf.dir][pf.chart]) {
    C.pchart[pf.dir][pf.chart].forEach(function (p) {
      var el = C.nodeEl.get(p.node), cl = ['p-hot', 'p-hot-' + pf.dir]; if (!el) return;
      el.classList.add.apply(el.classList, cl); C.pMarked.push([el, cl]); any = true;
    });
  }
  C.svg.classList.toggle('pfocus', any);
}
function openFlowChip(id, d) {
  var p = C && C.pchart[d] && C.pchart[d][id] ? C.pchart[d][id][0] : null;
  closeFbMore();
  if (p) jumpTo(p); else { pushJump(); openChart(id, null, { push: true }); }
}
function closeFbMore() { fbMore.hidden = true; fbMore.innerHTML = ''; fbMore.style.maxHeight = ''; }
/* the +N list lies wholly inside the window: it is fixed to the window, measured, kept 8 px from the right edge, and as tall as the room under the chip (it scrolls when there are more rows than room, so every row can be reached) */
function placeFbMore(chip) {
  fbMore.hidden = false; fbMore.style.maxHeight = ''; fbMore.scrollTop = 0;
  var r = chip.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight, w = fbMore.offsetWidth, top = r.bottom + 4;
  fbMore.style.left = Math.max(8, Math.min(r.left, vw - w - 12)) + 'px'; fbMore.style.top = top + 'px';
  fbMore.style.maxHeight = Math.max(96, vh - top - 12) + 'px';
}
window.addEventListener('resize', function () { if (!fbMore.hidden) closeFbMore(); });
function flowSideEvents(box) {
  box.addEventListener('mouseover', function (e) { if (PT.lock) return; var b = e.target.closest('.fchip[data-fc]'); if (b) setPortalFocus({ chart: b.dataset.fc, dir: b.dataset.dir }); });
  box.addEventListener('mouseout', function (e) { var b = e.target.closest('.fchip[data-fc]'); if (b && !b.contains(e.relatedTarget)) setPortalFocus(null); });
  box.addEventListener('focusin', function (e) { var b = e.target.closest('.fchip[data-fc]'); if (b) setPortalFocus({ chart: b.dataset.fc, dir: b.dataset.dir }); });
  box.addEventListener('focusout', function (e) { var b = e.target.closest('.fchip[data-fc]'); if (b && !b.contains(e.relatedTarget)) setPortalFocus(null); });
  box.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.classList.contains('fc-more')) {                       // the "+N" chip lists the chips that did not fit
      if (!fbMore.hidden) { closeFbMore(); return; }
      var d = box === fbPrev ? 'in' : 'out', hid = b._hid || [];
      fbMore.innerHTML = hid.map(function (c) { return chipHTML(c.dataset.fc, d); }).join('');
      placeFbMore(b);
      return;
    }
    if (b.dataset.act === 'back') { goBack(); return; }
    if (b.dataset.fc) openFlowChip(b.dataset.fc, b.dataset.dir);
  });
}
flowSideEvents(fbPrev); flowSideEvents(fbNext);
fbMore.addEventListener('mouseover', function (e) { if (PT.lock) return; var b = e.target.closest('.fchip[data-fc]'); if (b) setPortalFocus({ chart: b.dataset.fc, dir: b.dataset.dir }); });
fbMore.addEventListener('mouseout', function (e) { var b = e.target.closest('.fchip[data-fc]'); if (b && !b.contains(e.relatedTarget)) setPortalFocus(null); });
fbMore.addEventListener('click', function (e) { var b = e.target.closest('.fchip[data-fc]'); if (b) openFlowChip(b.dataset.fc, b.dataset.dir); });
document.addEventListener('mousedown', function (e) { if (!fbMore.hidden && !e.target.closest('#fbMore') && !e.target.closest('.fc-more')) closeFbMore(); });

/* ---- jumping between charts, with a back stack (Alt+Left) ---- */
function pushJump() {
  if (!C) return;
  S.jumps.push({ chart: C.id, sel: S.sel ? { t: S.sel.t, id: S.sel.id } : null, view: { s: view.s, x: view.x, y: view.y }, fit: !!S.autoFit });
  if (S.jumps.length > 40) S.jumps.shift();
}
function jumpTo(p) {
  if (!C || !p || !CH[p.chart]) return;
  var tn = CH[p.chart].nodes[p.node2] ? p.node2 : null;
  pushJump();
  openChart(p.chart, tn, { push: true, center: true, minScale: 0.85, landed: true });
  announce((pdir(p) === 'out' ? 'Continued in ' : 'Came from ') + CH[p.chart].navLabel + (tn ? ', ' + CH[p.chart].nodes[tn].title : '') + '. Press Alt and the left arrow to go back.');
}
function goBack() {
  var b = S.jumps.pop(); if (!b) return false;
  var node = b.sel && b.sel.t === 'node' && CH[b.chart].nodes[b.sel.id] ? b.sel.id : null, edge = b.sel && b.sel.t === 'edge' && CH[b.chart].edges[b.sel.id] ? b.sel.id : null;
  openChart(b.chart, node, { push: true, edge: edge, restoreView: b.fit ? 'fit' : b.view });
  announce('Back in ' + CH[b.chart].navLabel + '.');
  return true;
}
function flashLanded(id) {
  var el = C && C.nodeEl.get(id); if (!el) return;
  el.classList.remove('landed'); void el.getBoundingClientRect(); el.classList.add('landed');
  setTimeout(function () { el.classList.remove('landed'); }, 2200);
}

/* ---- inspector pieces ---- */
function connCard(p, d) {
  var tc = CH[p.chart], tn = tc.nodes[p.node2], kind = KIND_WORDS[p.kind] ? p.kind : 'detail';
  return '<div class="pconn ' + d + '"><div class="pc-head"><span class="pc-kind k-' + kind + '" title="' + esc(KIND_LONG[kind]) + '">' + esc(KIND_WORDS[kind]) + '</span><b class="pc-label">' + esc(p.label || (tn ? tn.title : tc.navLabel)) + '</b>' +
    '<button type="button" class="act pc-jump" data-jump="' + esc(p._id) + '" title="' + esc((d === 'in' ? 'Open where it comes from: ' : 'Open where it continues: ') + tc.navLabel + (tn ? ' · ' + tn.title : '')) + '">Jump ↗</button></div>' +
    '<div class="pc-to">' + (d === 'in' ? 'from ' : 'into ') + '<span class="pc-ch">' + esc(tc.navLabel) + '</span>' + (tn ? '<span class="pc-nd"> · ' + esc(tn.title) + '</span>' : '') + '</div>' +
    (p.why ? '<details class="pc-why"><summary>Why this connection</summary><p>' + esc(p.why) + '</p></details>' : '') + '</div>';
}
function backCard() {
  var bk = backNote(); if (!bk) return '';
  return '<div class="back-card"><button type="button" class="act" data-act="back">↩ Back to ' + esc(bk.chart.navLabel) + (bk.node ? ' · ' + esc(trunc(bk.node, 34)) : '') + '</button><span class="quiet">Alt + ← also goes back</span></div>';
}
function pglyph(d) {      // the same glyph as the badge on the box (arrow into / out of a wall)
  return '<svg class="pg" viewBox="-6 -6 12 12" width="13" height="13" aria-hidden="true"><path d="' + (d === 'in' ? 'M4.6 -4.2 V4.2 M-4.4 0 H2.2 M-0.8 -3 L2.4 0 L-0.8 3' : 'M-4.6 -4.2 V4.2 M-2.2 0 H4.4 M1.2 -3 L4.4 0 L1.2 3') + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
/* the "Step" eyebrow line, with two small pills (right-aligned, no extra height) that scroll to the connections block below */
function stepEyebrow(nid) {
  var pn = C.pnode && C.pnode[nid], pills = '', pin = pn ? realPortals(pn['in']).length : 0, pout = pn ? realPortals(pn.out).length : 0;
  if (pin) pills += '<button type="button" class="ppill in" data-pscroll="in" title="Entered from another chart (' + pin + '): show">' + pglyph('in') + '<b>' + pin + '</b></button>';
  if (pout) pills += '<button type="button" class="ppill out" data-pscroll="out" title="Leaves for another chart (' + pout + '): show">' + pglyph('out') + '<b>' + pout + '</b></button>';
  return '<div class="eb-row"><p class="eyebrow">Step</p>' + (pills ? '<span class="pps">' + pills + '</span>' : '') + '</div>';
}
function portalBlock(nid) {
  var pn = C.pnode && C.pnode[nid]; if (!pn || (!pn['in'].length && !pn.out.length)) return '';
  var h = '<div class="pblock" aria-label="Connections to other charts">';
  if (pn['in'].length) h += '<h3 class="p-in">' + pglyph('in') + ' Comes from</h3>' + pn['in'].map(function (p) { return connCard(p, 'in'); }).join('');
  if (pn.out.length) h += '<h3 class="p-out">' + pglyph('out') + ' Continues in</h3>' + pn.out.map(function (p) { return connCard(p, 'out'); }).join('');
  return h + '</div>';
}
/* chart-level inspector (nothing pinned): where this chart sits and every way in and out */
function flowInspector() {
  var X = C, f = flowOf(X.chart), L = flowLists(X), s = SECT_OF[X.id], h = '';
  if (!f && !realPortals(X.portals).length) return backCard();
  h += backCard() + '<h3>Where this fits</h3>';
  if (f && f.role) h += '<p class="fit-role"><span class="fb-role" style="--rc:' + (s ? s.color : 'var(--accent)') + '">' + esc(roleWord(f.role)) + '</span>' + (s ? '<span class="quiet"> ' + esc(s.title) + '</span>' : '') + '</p>';
  if (f && f.blurb && String(X.chart.summary || '').indexOf(String(f.blurb).slice(0, 40)) !== 0) h += '<p class="lead">' + esc(f.blurb) + '</p>';      // never the same sentence twice (the summary above already opens with it)
  var group = function (d, title, ids) {
    if (!ids.length) return '<h3 class="' + (d === 'in' ? 'p-in' : 'p-out') + '">' + title + '</h3><p class="quiet">' + (d === 'in' ? 'No road enters this chart from another chart.' : 'No road leaves this chart for another chart.') + '</p>';
    var conns = 0; ids.forEach(function (id) { conns += realPortals(X.pchart[d][id] || []).length; });
    var out = '<details class="fwrap ' + d + '"' + (ids.length <= 3 ? ' open' : '') + '><summary><b class="' + (d === 'in' ? 'p-in' : 'p-out') + '">' + title + '</b><span class="fw-n">' + ids.length + ' chart' + (ids.length === 1 ? '' : 's') + (conns ? ' · ' + conns + ' connection' + (conns === 1 ? '' : 's') : '') + '</span></summary>';
    ids.forEach(function (id) {
      var list = realPortals(X.pchart[d][id] || []);
      out += '<div class="fgrp"><button type="button" class="fgrp-h" data-open-chart="' + esc(id) + '" title="Open ' + esc(CH[id].navLabel) + '">' + secDot(id) + '<span>' + esc(CH[id].navLabel) + '</span><em>open ↗</em></button>';
      list.forEach(function (p) {
        var kind = KIND_WORDS[p.kind] ? p.kind : 'detail';
        out += '<button type="button" class="fgrp-r" data-pnode="' + esc(p.node) + '" title="Select this step on the chart"><span class="pc-kind k-' + kind + '">' + esc(KIND_WORDS[kind]) + '</span><span class="fg-l">' + esc(p.label || '') + '</span><small>at “' + esc(trunc(X.chart.nodes[p.node].title, 40)) + '”</small></button>';
      });
      out += '</div>';
    });
    return out + '</details>';
  };
  if (X.chart.kind !== 'overview') h += group('in', 'Comes in from', L.prev) + group('out', 'Leaves for', L.next);
  return h;
}
/* a per-step "Connected flowcharts" link, shown only when the step has no portal of its own */
function oldLinksBlock(n, nid) {
  if (C.pnode && C.pnode[nid]) return '';
  var links = (n.links || []).filter(function (l) { return CH[l.chart]; });
  if (!links.length) return '';
  return '<h3>Connected flowcharts</h3><div class="chips">' + links.map(function (l) { return '<button type="button" data-open-chart="' + esc(l.chart) + '" data-open-node="' + esc(l.node || '') + '">' + esc((l.label && l.label !== 'Explore this flow' ? l.label : CH[l.chart].navLabel)) + ' ↗</button>'; }).join('') + '</div>';
}
