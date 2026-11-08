/* Looks (viewer/look.js, same closure as viewer.js, included after zoomtext.js).
   Edge cues: a chart that does not fit says so at the edges that are cut. A soft fade and a small "more" tab sit on each edge where a box runs off the canvas, so the reader
   knows there is more to see (and which way) instead of finding a box cut in half. Drawn for charts of up to 300 boxes; never on the whole map or the overview poster. */
var CUE = { els: {}, key: '' };
(function () {
  var wrap = $('#canvasWrap'); if (!wrap) return;
  [['l', '\u2039 more'], ['r', 'more \u203a'], ['t', '\u2303 more'], ['b', '\u2304 more']].forEach(function (k) {
    var d = document.createElement('div'); d.className = 'edgecue ec-' + k[0]; d.hidden = true; d.setAttribute('aria-hidden', 'true');
    d.innerHTML = '<i>' + k[1] + '</i>'; wrap.appendChild(d); CUE.els[k[0]] = d;
  });
})();
function cueBounds() {                                   // the boxes' own bounding box in map units, once per chart
  if (C.cueBB) return C.cueBB;
  var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, k, b;
  for (k in C.nb) { b = C.nb[k]; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return (C.cueBB = { x0: x0, y0: y0, x1: x1, y1: y1 });
}
function cueState() {
  var on = { l: false, r: false, t: false, b: false };
  if (C && !S.reading && !isWhole(C.chart) && C.chart.kind !== 'overview' && C.nodeCount <= 300 && cw > 300) {
    var bb = cueBounds(), s = view.s, l = bb.x0 * s + view.x, r = bb.x1 * s + view.x, t = bb.y0 * s + view.y, b = bb.y1 * s + view.y;
    on.l = l < -3; on.r = r > cw + 3; on.t = t < -3; on.b = b > ch + 3;
  }
  return on;
}
function drawCues() {
  var els = CUE.els, on = cueState();
  var key = (on.l ? 'l' : '') + (on.r ? 'r' : '') + (on.t ? 't' : '') + (on.b ? 'b' : '');
  if (key !== CUE.key) { CUE.key = key; for (var k in els) els[k].hidden = !on[k]; }
  if (key) { clearTimeout(CUE.t); CUE.t = setTimeout(function () { var o2 = cueState(); if (o2.l || o2.r || o2.t || o2.b) placeCues(o2); }, 80); }      // the tabs settle where the view rests
}
/* a "more" tab goes where it covers no box and no other control (it sat in the middle of its edge, on whatever box ran off there); with no such place the fade alone says it */
function cueObstacles() {
  var wr = $('#canvasWrap').getBoundingClientRect(), out = [], r, ns = C.svg.querySelectorAll('g.node'), i;
  for (i = 0; i < ns.length; i++) { r = ns[i].getBoundingClientRect(); if (r.width > 0) out.push([r.left - wr.left - 6, r.top - wr.top - 6, r.width + 12, r.height + 12]); }       // the box with its tab, its badge and its path mark: what is drawn
  C.labelEl.forEach(function (e) { r = e.getBoundingClientRect(); if (r.width > 0) out.push([r.left - wr.left - 6, r.top - wr.top - 6, r.width + 12, r.height + 12]); });       // a road condition is something a tab must not sit on
  var lr = C.svg.querySelectorAll('.edge.rel .edge-line'), li, ln, lk, lp, lm, lq;
  for (li = 0; li < lr.length && li < 40; li++) { lp = lr[li]; lm = lp.getScreenCTM(); if (!lm || !lp.getTotalLength) continue; ln = lp.getTotalLength(); for (lk = 0; lk <= ln; lk += 14) { var pp = lp.getPointAtLength(lk); lq = { x: pp.x * lm.a + pp.y * lm.c + lm.e, y: pp.x * lm.b + pp.y * lm.d + lm.f }; out.push([lq.x - wr.left - 9, lq.y - wr.top - 9, 18, 18]); } }       // and neither a lit road
  ['#regionDock', '#zoomGroup', '#zNote', '#walkBar', '#ovNote', '#mini', '#legend', '#tracePanel', '#handlePanel', '#dockPanel', '#pickBanner', '#nameNote'].forEach(function (sel) {
    var e = $(sel), r; if (!e || e.hidden || !e.offsetParent && getComputedStyle(e).position !== 'fixed') return;
    r = e.getBoundingClientRect(); if (r.width > 0) out.push([r.left - wr.left - 6, r.top - wr.top - 6, r.width + 12, r.height + 12]);
  });
  return out;
}
function placeCues(on) {
  var ob = cueObstacles(), hit = function (x, y, w, h) { for (var i = 0; i < ob.length; i++) { var o = ob[i]; if (x < o[0] + o[2] && x + w > o[0] && y < o[1] + o[3] && y + h > o[1]) return true; } return false; };
  var placed = [], k, el, i, w, h, best, pos, d, along, fixed, horiz;
  for (k in CUE.els) {
    if (!on[k]) continue; el = CUE.els[k].firstChild; w = el.offsetWidth || 64; h = el.offsetHeight || 24; horiz = k === 't' || k === 'b';
    best = null;
    along = horiz ? cw : ch;
    for (i = 0; i < 80 && !best; i++) {                                    // from the middle of the edge outwards, both ways
      d = Math.ceil(i / 2) * 18 * (i % 2 ? 1 : -1); pos = Math.round((along - (horiz ? w : h)) / 2 + d);
      if (pos < 8 || pos > along - (horiz ? w : h) - 8) continue;
      var x = k === 'l' ? 8 : k === 'r' ? cw - 8 - w : pos, y = k === 't' ? 8 : k === 'b' ? ch - 8 - h : pos;
      if (hit(x, y, w, h)) continue;
      for (var q = 0; q < placed.length; q++) if (x < placed[q][0] + placed[q][2] && x + w > placed[q][0] && y < placed[q][1] + placed[q][3] && y + h > placed[q][1]) break;
      if (q < placed.length) continue;
      best = [x, y, w, h];
    }
    el.style.visibility = best ? '' : 'hidden';
    if (best) { var cn = CUE.els[k]; el.style.position = 'absolute'; el.style.left = (best[0] - cn.offsetLeft) + 'px'; el.style.top = (best[1] - cn.offsetTop) + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto'; placed.push(best); }
  }
}

/* "All at once" is a smaller view (viewer.js smallOn): the zoom bar says so, and Reading size is the way back. */
(function () {
  var note = $('#zNote'), fit = $('#zFit'), all = $('#zAll'); if (!note) return;
  function sync() { var on = FL.small(); if (note.hidden === on) note.hidden = !on; if (all) all.classList.toggle('open', FL.smallAsked()); if (on) { var w = wordsState(), t = w && w.names ? 'Smaller view: names and road conditions are too small to draw at this size' : w && w.labels ? 'Smaller view: names are drawn small; road conditions are hidden at this size' : 'Smaller view: names and conditions are drawn small'; if (note.textContent !== t) note.textContent = t; } }
  FL.onZoom(sync); FL.onChart(function () { sync(); });
})();

/* wording: a count of one is "1 box" and "1 road", never "1 boxes" */
function wBox(n) { return n === 1 ? ' box' : ' boxes'; }
function wRoad(n) { return n === 1 ? ' road' : ' roads'; }

/* the overview map (minimap) goes to the corner where it covers the fewest boxes: bottom right, else top right */
var miniTimer = 0;
function placeMini() {
  clearTimeout(miniTimer);
  miniTimer = setTimeout(function () {
    var dk0 = $('#bdock'); if (dk0 && (!miniEl || miniEl.hidden)) dk0.style.paddingRight = '';
    if (!miniEl || miniEl.hidden || !C) return;
    var w = miniEl.offsetWidth, h = miniEl.offsetHeight, k, b, x, y, cover = function (top) {
      var a = 0, x0 = cw - 12 - w, y0 = top ? 12 : ch - 12 - h;
      for (k in C.nb) { b = C.nb[k]; x = b.x * view.s + view.x; y = b.y * view.s + view.y; a += Math.max(0, Math.min(x + b.w * view.s, x0 + w) - Math.max(x, x0)) * Math.max(0, Math.min(y + b.h * view.s, y0 + h) - Math.max(y, y0)); }
      return a;
    };
    var top = cover(true) < cover(false) * 0.5 || (S.walk && !walkBar.hidden);                      // during a walk the bottom row belongs to the walk bar
    miniEl.classList.toggle('mini-top', top);
    var dk = $('#bdock'); if (dk) dk.style.paddingRight = top ? '' : (w + 12) + 'px';              // the bottom row leaves the corner to the overview map
  }, 160);
}
FL.onZoom(placeMini); FL.onChart(placeMini);
