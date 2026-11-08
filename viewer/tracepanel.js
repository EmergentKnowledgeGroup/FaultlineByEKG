/* ================================================================ TRACE A PATH: a From and a To in the toolbar
   Spliced into the viewer closure after walk.js. Trace path used to be a small button low in the details panel, and on a stage chart a target on another chart was dropped without a word.
   Now: a "Trace path" button in the toolbar opens a small panel with a From and a To, each with its own search over every chart. If both boxes are on this chart the path is drawn here; if not, the
   answer opens on the whole map (which holds every box and road), with its numbered list in the details panel. Nothing is ever ignored: a missing choice, the same box twice, no whole map and
   no route each say so, in the panel. The engine is the one the details panel's Trace path button uses (findPaths, completePick). */

var traceBtn = $('#traceBtn'), tracePanel = $('#tracePanel');
var TP = { from: '', to: '', open: false, res: { from: [], to: [] }, idx: { from: -1, to: -1 } };
function tpName(id) { var m = IDX && IDX.filter(function (r) { return r.node === id; })[0]; if (m) return m.title; var c = chartForNode(id); return c && CH[c].nodes[id] ? CH[c].nodes[id].title : id; }
function tpWhere(id) { var c = chartForNode(id); return c ? CH[c].navLabel : ''; }
function tpField(which, label) {
  return '<div class="tp-row" data-which="' + which + '"><label class="tp-l" for="tp-' + which + '">' + label + '</label><div class="tp-f"><input id="tp-' + which + '" class="tp-in" type="text" autocomplete="off" spellcheck="false" placeholder="Search a box, a handle or a function" aria-controls="tp-res-' + which + '">' +
    '<span class="tp-pick" id="tp-pick-' + which + '" hidden></span><div class="tp-res" id="tp-res-' + which + '" role="listbox" hidden></div></div></div>';
}
function tpBuild() {
  tracePanel.innerHTML = '<div class="tp-head"><b>Trace a path</b><span class="quiet">from one box to another, on any chart</span><button type="button" class="tp-x" aria-label="Close">&times;</button></div>' +
    tpField('from', 'From') + '<div class="tp-mid"><button type="button" class="tp-swap" title="Swap the two ends">⇅ Swap</button></div>' + tpField('to', 'To') +
    '<div class="tp-act"><button type="button" class="btn-solid tp-go">Trace</button><span class="tp-msg" id="tp-msg" role="status" aria-live="polite"></span></div>' +
    '<p class="tp-note">If both boxes are on this chart the path is drawn here. If not, ' + (META.toolMap ? 'the call path between their functions opens in the Reader, and a break is marked where the map has no call to follow.' : 'it opens on the whole map with its numbered list, because that map holds every box and road.') + '</p>';
}
function tpMsg(t, bad) { var m = $('#tp-msg', tracePanel); if (m) { m.textContent = t || ''; m.classList.toggle('bad', !!bad); } }
function tpSet(which, id) {
  TP[which] = id || '';
  var inp = $('#tp-' + which, tracePanel), pick = $('#tp-pick-' + which, tracePanel);
  if (id) { pick.hidden = false; pick.innerHTML = '<b>' + esc(tpName(id)) + '</b> <small>' + esc(tpWhere(id)) + '</small><button type="button" class="tp-clr" data-which="' + which + '" aria-label="Choose another">&times;</button>'; inp.hidden = true; }
  else { pick.hidden = true; pick.innerHTML = ''; inp.hidden = false; inp.value = ''; }
  tpList(which, []);
  tpMsg('');
}
function tpList(which, list) {
  var box = $('#tp-res-' + which, tracePanel); TP.res[which] = list; TP.idx[which] = list.length ? 0 : -1;
  if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = list.map(function (r, i) { return '<button type="button" class="tp-r" role="option" data-i="' + i + '" aria-selected="' + (i === 0) + '"><b>' + esc(r.title) + '</b><small>' + esc(CH[r.chart].navLabel) + (r.plain ? ' · ' + esc(trunc(r.plain, 80)) : '') + '</small></button>'; }).join('');
}
function tpSearch(which, q) {
  q = String(q || '').trim();
  if (!q) { tpList(which, []); return; }
  var seen = {}, list = matchQuery(q).filter(function (r) { if (seen[r.node]) return false; seen[r.node] = 1; return true; }).slice(0, 8);
  if (!list.length) { var box = $('#tp-res-' + which, tracePanel); box.hidden = false; box.innerHTML = '<div class="qempty">No box matches “' + esc(q) + '” on any chart.</div>'; TP.res[which] = []; TP.idx[which] = -1; return; }
  tpList(which, list);
}
function tpChoose(which, i) { var r = TP.res[which][i]; if (!r) return; tpSet(which, r.node); var other = which === 'from' ? 'to' : 'from'; var f = !TP[other] ? $('#tp-' + other, tracePanel) : $('.tp-go', tracePanel); if (f) f.focus(); }
function traceHolder(a, b) {                       // the chart that draws both ends: this one when it can (not the overview), else the whole map, else any chart that holds both
  if (C && !S.reading && C.chart.kind !== 'overview' && C.chart.nodes[a] && C.chart.nodes[b]) return C.id;
  var ids = Object.keys(CH), both = function (id) { return !!CH[id].nodes[a] && !!CH[id].nodes[b]; };
  return ids.filter(function (id) { return isWhole(CH[id]) && both(id); })[0] || ids.filter(function (id) { return CH[id].kind !== 'overview' && both(id); })[0] || '';
}
function nodeFnOf(id) { var c = chartForNode(id); return c && CH[c].nodes[id] ? CH[c].nodes[id].fn || '' : ''; }
function traceBetween(a, b, o) {                   // returns a sentence saying what happened (also spoken); '' only when it traced here without anything to add
  o = o || {};
  if (!a || !b) return tpResult('Choose both ends first: a From and a To.', true);
  if (a === b) return tpResult('Choose two different boxes.', true);
  var target = traceHolder(a, b);
  if (!target) {
    var fa = nodeFnOf(a), fb = nodeFnOf(b);
    if (META.toolMap && window.readerTrace && fa && fb && window.readerTrace(fa, fb)) { var m0 = 'The two boxes are on different charts, so the call path between their functions is open in the Reader, with any break marked.'; openTracePanel(false); announce(m0); return m0; }
    return tpResult(META.toolMap ? 'No single chart holds both boxes, and the call path between them could not be opened. Open one of them and trace from its details panel.' : 'No single chart holds both boxes, and this map has no whole-system chart to trace across. Open one of them and trace from its details panel.', true);
  }
  var moved = !C || S.reading || C.id !== target;
  if (S.reading || moved) openChart(target, null, { push: true });                                  // no box named here: the path's own reveal (below) is the only move of the view
  if (app.dataset.insp === 'collapsed') { setInspCollapsed(false, true); measure(); }            // the numbered answer lives in the details panel: it opens for it
  S.pickFrom = a; canvas.classList.add('picking'); completePick(b);
  var T = S.trace, ok = !!(T && T.res && T.res.nodes && T.res.nodes.size);
  var msg = ok ? (moved && isWhole(CH[target]) ? 'The two boxes are not on one chart, so this is the whole map, with every step of the path numbered in the details panel.' : moved ? 'Opened the chart that holds both.' : 'Traced here.')
    : 'No road connects those two boxes: roads were followed forward, then in either direction.';
  if (ok) { S.trace.note = moved ? msg : ''; renderInspector(false); openTracePanel(false); announce(msg); return msg; }          // the answer is on screen: the panel steps aside
  return tpResult(msg, !ok);
}
function tpResult(msg, bad) { tpMsg(msg, bad); announce(msg); return msg; }
function openTracePanel(open, o) {
  o = o || {};
  if (open === TP.open && !o.refill) return;
  TP.open = open; tracePanel.hidden = !open; traceBtn.setAttribute('aria-expanded', open ? 'true' : 'false'); traceBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
  if (!open) return;
  if (!tracePanel.firstChild) tpBuild();
  if (S.hpanel) closeHandles(); if (!legendEl.hidden) toggleLegend(false);
  var r = traceBtn.getBoundingClientRect(), w = Math.min(460, innerWidth - 16);
  tracePanel.style.width = w + 'px'; tracePanel.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px'; tracePanel.style.top = (r.bottom + 6) + 'px';
  var pin = S.sel && S.sel.t === 'node' && !S.reading ? S.sel.id : '';
  if (o.from) tpSet('from', o.from); else if (!TP.from && pin) tpSet('from', pin); else if (TP.from) tpSet('from', TP.from);
  if (o.to) tpSet('to', o.to); else if (TP.to) tpSet('to', TP.to); else tpSet('to', '');
  tpMsg('');
  var f = !TP.from ? $('#tp-from', tracePanel) : !TP.to ? $('#tp-to', tracePanel) : $('.tp-go', tracePanel); if (f) f.focus();
}
traceBtn.addEventListener('click', function () { openTracePanel(!TP.open); });
tracePanel.addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  if (b.classList.contains('tp-x')) { openTracePanel(false); traceBtn.focus(); return; }
  if (b.classList.contains('tp-r')) { tpChoose(b.closest('.tp-row').dataset.which, +b.dataset.i); return; }
  if (b.classList.contains('tp-clr')) { var w = b.dataset.which; tpSet(w, ''); var i = $('#tp-' + w, tracePanel); if (i) i.focus(); return; }
  if (b.classList.contains('tp-swap')) { var a = TP.from, c = TP.to; tpSet('from', c); tpSet('to', a); return; }
  if (b.classList.contains('tp-go')) traceBetween(TP.from, TP.to);
});
tracePanel.addEventListener('input', function (e) { var i = e.target.closest('.tp-in'); if (i) { if (!IDX) buildIndex(); tpSearch(i.closest('.tp-row').dataset.which, i.value); } });
tracePanel.addEventListener('keydown', function (e) {
  var i = e.target.closest('.tp-in');
  if (e.key === 'Escape') { e.stopPropagation(); if (i && TP.res[i.closest('.tp-row').dataset.which].length) { tpList(i.closest('.tp-row').dataset.which, []); return; } openTracePanel(false); traceBtn.focus(); return; }
  if (!i) return;
  var which = i.closest('.tp-row').dataset.which, n = TP.res[which].length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!n) return; e.preventDefault(); TP.idx[which] = (TP.idx[which] + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; $$('.tp-r', tracePanel.querySelector('#tp-res-' + which)).forEach(function (b, k) { b.setAttribute('aria-selected', k === TP.idx[which] ? 'true' : 'false'); if (k === TP.idx[which]) b.scrollIntoView({ block: 'nearest' }); }); }
  else if (e.key === 'Enter') { e.preventDefault(); if (n && TP.idx[which] >= 0) tpChoose(which, TP.idx[which]); else if (TP.from && TP.to) traceBetween(TP.from, TP.to); else tpMsg(i.value.trim() ? 'Nothing matches that: search again, or pick a result from the list.' : 'Type a box, a handle or a function name.', true); }
});
document.addEventListener('mousedown', function (e) { if (TP.open && !e.target.closest('#tracePanel') && !e.target.closest('#traceBtn')) { /* stay open: the chart can be clicked while tracing */ } });
FL.onChart(function () { if (TP.open) { var pin = S.sel && S.sel.t === 'node' ? S.sel.id : ''; if (!TP.from && pin) tpSet('from', pin); } });
