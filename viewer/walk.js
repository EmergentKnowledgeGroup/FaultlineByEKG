/* ================================================================ WALK A DECLARED PATH, STEP BY STEP
   Spliced into viewer.js (same closure) after overview.js.  The main path (and any other path the model declares) is a list of boxes in order. "Walk the main path"
   is a stepper over that list: previous, next, "step n of N", the box's name.  It crosses charts on its own: the next step lives on whatever chart draws that box,
   and the path is lit there with only its consecutive steps joined (regions.js, spineShow).  The older "Tour the charts" walks the charts in reading order instead.
   S.walk = {pid, ids[], i} while a walk is on. */

var walkBar = $('#walkBar'), walkBtn = $('#walkBtn'), wkBody = $('#wkBody'), wkFill = $('#wkFill');
S.walk = null;

function boxAny(id) { var c = chartForNode(id); return c && CH[c].nodes[id] ? CH[c].nodes[id] : null; }
function walkTitle(pid) { return pid === MAIN_ID ? 'Main path' : (PATHS[pid] ? PATHS[pid].title : 'Path'); }
function walkChartFor(id) {                                            // the chart that shows this step: the one on screen when it holds the box (not the overview), else the box's home chart
  if (C && !S.reading && C.chart.kind !== 'overview' && C.chart.nodes[id]) return C.id;
  return chartForNode(id);
}
function startWalk(pid) {
  pid = pid || MAIN_ID;
  var ids = pathIdsOf(pid).filter(function (id) { return !!boxAny(id); });
  if (!ids.length) { announce('There is no path to walk.'); return; }
  var at = S.sel && S.sel.t === 'node' && !S.reading ? ids.indexOf(S.sel.id) : -1;       // a pinned box that is on the path: start there
  S.walk = { pid: pid, ids: ids, i: 0 };
  walkGo(at >= 0 ? at : 0, true);
}
function stopWalk() { S.walk = null; drawWalkBar(); announce('Walk ended.'); }
function scenarioIds() { return Object.keys(PATHS).filter(function (id) { return id !== MAIN_ID && pathIdsOf(id).filter(function (b) { return !!boxAny(b); }).length >= 2; }); }      // the declared paths other than the main path
function walkGo(i, first) {
  var w = S.walk; if (!w || i < 0 || i >= w.ids.length) return;
  w.i = i;
  var id = w.ids[i], cid = walkChartFor(id); if (!cid) return;
  var nxt = w.ids[i + 1] && w.ids[i + 1] !== id ? [w.ids[i + 1]] : null;                  // the next step comes into view with this one (when it is on the same chart and both fit)
  if (!S.reading && C && C.id === cid) selectNode(id, { reveal: true, push: true, minScale: 0.85, lit: true, also: nxt && C.nb[nxt[0]] ? nxt : null });
  else openChart(cid, id, { push: true, center: false, minScale: 0.85, landed: true, lit: true, also: nxt });   // the chart opens where its story starts; the view moves only when the step is out of sight
  spineShow(w.pid);
  drawWalkBar();
  announce('Step ' + (i + 1) + ' of ' + w.ids.length + ': ' + (boxAny(id) ? boxAny(id).title : id) + '.');
}
function walkStageOf(id) { var n = boxAny(id); return n ? (n.stage || '') : ''; }
function walkNextStage() {                                              // the first later step that is in another stage than this one
  var s = S.walk; if (!s) return -1;
  var here = walkStageOf(s.ids[s.i]);
  for (var k = s.i + 1; k < s.ids.length; k++) if (walkStageOf(s.ids[k]) !== here) return k;
  return -1;
}
function walkRoadNote(a, b) {                                           // the road from this step to the next one: said when it is inferred (no code proves it), or when no road is drawn between them
  if (!a || !b || a === b || typeof gdModel !== 'function') return '';
  var r = gdRoadBetween(a, b);
  if (!r) return ' <em class="wk-warn">no road is drawn between them</em>';
  return r.inferred ? ' <em class="wk-warn">the road is inferred, no code proves it</em>' : '';
}
function walkStep(d) {
  var w = S.walk; if (!w) return;
  var n = w.i + d; if (n < 0 || n >= w.ids.length) { announce(d > 0 ? 'This is the last step.' : 'This is the first step.'); return; }
  walkGo(n);
}
function walkSync() {                                                  // a box the READER pinned that is on the walked path moves the step marker to it.
  var w = S.walk; if (!w || !S.sel || S.sel.t !== 'node') return;
  // A path may repeat a box (a call comes back), even at two adjacent steps, so the position is the step INDEX, never the box id: the box of the step we are on is never looked up again.
  if (w.ids[w.i] === S.sel.id) return;
  var best = -1; w.ids.forEach(function (id, k) { if (id === S.sel.id && (best < 0 || Math.abs(k - w.i) < Math.abs(best - w.i))) best = k; });   // another box: the nearest step that is that box
  if (best >= 0) { w.i = best; drawWalkBar(); }
}
/* the top line of the walk bar never shows a cut stage name. It tries all of it; then without the path's name ("Main path"); then the stage's number alone (its name stays in the tooltip). */
function walkFit() {
  var top = $('.wk-top', wkBody), st = top && $('.wk-stage', top); if (!top || !st) return;
  top.classList.remove('no-kind'); st.classList.remove('no-name');
  var over = function () { return top.scrollWidth > top.clientWidth + 1; };
  if (!over()) return;
  top.classList.add('no-kind'); if (!over()) return;
  st.classList.add('no-name');
}
window.addEventListener('resize', function () { if (S.walk && !walkBar.hidden) walkFit(); });
function drawWalkBar() {
  var w = S.walk, on = !!w && !S.reading;
  walkBar.hidden = !on; walkBtn.setAttribute('aria-pressed', w ? 'true' : 'false');
  if (typeof drawZoomBar === 'function') drawZoomBar();                      // a walk keeps the zoom bar at home, where the walk bar leaves room for it
  placeMini();                                                    // the bottom row makes room for the walk bar
  walkBtn.hidden = !(pathIdsOf(MAIN_ID).length > 1);
  if (!on) return;
  var id = w.ids[w.i], n = boxAny(id) || { title: id }, nx = w.i + 1 < w.ids.length ? boxAny(w.ids[w.i + 1]) : null, here = chartForNode(id);
  var sid = n.stage, hue = sid && stageHue(sid) != null ? ' style="--sh:' + stageHue(sid) + '"' : '';
  var cross = nx && C && !C.chart.nodes[w.ids[w.i + 1]];
  wkBody.innerHTML = '<div class="wk-top"><span class="wk-kind">' + esc(walkTitle(w.pid)) + '</span><span class="wk-pos">step <b>' + (w.i + 1) + '</b> of ' + w.ids.length + '</span>' +
    (sid ? '<span class="wk-stage"' + hue + ' title="' + esc((stageNo(sid) ? 'Stage ' + stageNo(sid) + ': ' : '') + stageName(sid)) + '"><span class="ws-no">' + (stageNo(sid) || '') + '</span><span class="ws-name">' + (stageNo(sid) ? ' · ' : '') + esc(stageName(sid)) + '</span></span>' : '') + '</div>' +
    '<div class="wk-name">' + esc(n.title) + '</div>' +
    '<div class="wk-next">' + (nx ? 'then <b>' + esc(nx.title) + '</b>' + (w.ids[w.i + 1] === id ? ' <em>again: the path runs this box twice in a row</em>' : '') + (cross ? ' <em>on another chart: ' + esc(CH[chartForNode(w.ids[w.i + 1])].navLabel) + '</em>' : '') + walkRoadNote(id, w.ids[w.i + 1]) : 'This is the last step of the path.') + '</div>';
  walkFit();
  $('#wkPrev').disabled = w.i === 0; $('#wkNext').disabled = w.i >= w.ids.length - 1;
  var ns = walkNextStage(), sb = $('#wkStage'); sb.disabled = ns < 0; sb.title = ns < 0 ? 'No later step is in another stage' : 'Skip to step ' + (ns + 1) + ', the first step in ' + stageName(walkStageOf(w.ids[ns])) + ' (the stage after this one on the path)';
  wkFill.style.width = Math.round(100 * (w.i + 1) / w.ids.length) + '%';
}
walkBtn.addEventListener('click', function () {
  if (S.walk && !S.reading) { stopWalk(); return; }
  startWalk(MAIN_ID);
});
$('#wkPrev').addEventListener('click', function () { walkStep(-1); });
$('#wkNext').addEventListener('click', function () { walkStep(1); });
$('#wkEnd').addEventListener('click', function () { stopWalk(); });
$('#wkStage').addEventListener('click', function () { var k = walkNextStage(); if (k >= 0) walkGo(k); });
FL.onChart(function () { if (S.walk) drawWalkBar(); });
drawWalkBar();
