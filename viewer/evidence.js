/* ================================================================ EVIDENCE LAYER
   Spliced into viewer.js (same closure) by the INCLUDE line near the end of viewer.js. Uses the FL object documented at the top of viewer.js, plus
   a few shared helpers of that closure (DATA, META, KIND, the docked panel through FL.openPanel). Its styles are in viewer/evidence.css (the
   assembler must inline that file after flow.css). The layer is a switch in the map toolbar, OFF by default; off, nothing on the page changes.
   On: outline says how we know, colour says what we found (docs/DESIGN_BARS.md, "Evidence layer"). Data, per chart, all of it optional:
     chart.evidence = { boxes:{id:{level,count,modeled,reasons[],stale,staleLevel,tools[],untested,anchorOnly,claimed,outcomes[]}}, routes:{id:{count,maybe,modeled,level?}},
       findings:[{key,check,boxes[],routes[],question,evidence,group?,falseAlarm?,next?}]  (the candidates; also read as .candidates, chart.findings, DATA.findings),
       walks:[{id?,tool,kind?,title?,outcome?,strength?,count?,says?,label?,boxes[],routes[]?}]  (a path per walk: ordered box ids; routes are found between boxes when absent),
       notDrawn:{count,items[]} (else meta.notDrawn), notMapped[], missingRoutes[], unexplored[], stale[], labels[{tool,kind,label,says}], untested[], neverSeen[] }
   The same object may sit on DATA.evidence (one overlay for every chart). Levels: drawn, suspected (a finding names it), seen, proved. */
(function () {
'use strict';
var NS = 'http://www.w3.org/2000/svg';
var E = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var q$ = function (s, r) { return (r || document).querySelector(s); };
function sv(tag, attrs) { var e = document.createElementNS(NS, tag); if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; }
function arr(a) { return Array.isArray(a) ? a : []; }
function Q(s) { return FL.plain ? FL.plain(s) : String(s == null ? '' : s); }                      // the same as plain text, for a tooltip
function P(s) { return FL.prose ? FL.prose(s) : E(s); }                      // words the checks wrote: `ticks` become code and a box's id becomes its name (the same as the Where it can break page)
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
function fmt(n) { n = Math.round(Number(n) || 0); return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(n); }
function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }

/* ---- the words: plain, never "bug" or "dead end", never "unbounded"; "candidate", "not drawn", "no limit shown", "not found in what was checked" ---- */
var SHAPE = { 'can-only-go-back': 'only way out goes back upstream', 'pile-up': 'many roads in, one way out', 'hedged-route': 'a road worded with a hedge', 'no-limit-loop': 'a loop with no limit shown',
  'ending-no-test': 'an ending no run is seen to reach', 'declared-never-produced': 'a declared outcome nothing is shown to produce', 'no-way-out': 'no way out drawn', 'unreached-from-start': 'no drawn road leads here from the start' };
var WHY = { 'can-only-go-back': 'Every road out of this box leads back upstream, so what moves the work forward again is not drawn.',
  'pile-up': 'Several roads arrive here and one leaves, so this may be a place where work collects.',
  'hedged-route': 'A road here is worded with a hedge instead of a condition, so what decides it is not stated.',
  'no-limit-loop': 'This loop shows no limit, so nothing drawn says when it stops repeating.',
  'ending-no-test': 'The loaded evidence has no run that reached this ending.',
  'declared-never-produced': 'The code declares this outcome, but no ending drawn is shown to produce it.',
  'no-way-out': 'Roads arrive here and none is drawn leaving, so nothing shows where the work goes next.',
  'unreached-from-start': 'No road drawn leads here from where the system starts.' };
var FALSE_ALARM = { 'can-only-go-back': 'Something outside the code drawn (a timer, an operator, another service) moves the work on again, and that is how it is meant to work.',
  'pile-up': 'The roads in are alternatives that are meant to meet, and the one road out is right for every one of them.',
  'hedged-route': 'The hedge is accurate: the choice really depends on data that is only known at run time.',
  'no-limit-loop': 'Something outside the loop (a timeout, a counter kept elsewhere, a manual stop) already bounds it.',
  'ending-no-test': 'A run exists but was not loaded, or the ending can only be reached in real use.',
  'declared-never-produced': 'The value is built on the fly (from a string, from storage), so a plain read of the code cannot see where it is set.',
  'no-way-out': 'The box is a resting place on purpose: a store, or a wait for a person or an outside event.',
  'unreached-from-start': 'It is entered from outside the code drawn (an event, a schedule, another program).' };
var NEXT = { 'can-only-go-back': 'Name what triggers the later request and draw that road, or load a run that reaches this box.',
  'pile-up': 'Check the single way out against each road in, and add the missing conditions to the roads.',
  'hedged-route': 'Replace the hedge with the exact condition from the code, or mark the road as inferred.',
  'no-limit-loop': 'Write down what bounds the loop (a count, a time, a stop), or run it to its end in a walk.',
  'ending-no-test': 'Load coverage or run a walk that reaches this ending.',
  'declared-never-produced': 'Find where the value is set and draw that box, or exclude it with a reason.',
  'no-way-out': 'Draw the road out, or set the box kind to ending or wait.',
  'unreached-from-start': 'Draw the entry road, or mark the box as an entry.' };
var LV_WORDS = { drawn: 'Drawn', suspected: 'Suspected', seen: 'Seen', proved: 'Proved', stale: 'Stale' };
var LV_HELP = { drawn: 'from the code only', suspected: 'worth a question', seen: 'it ran when checked', proved: 'replayed or proved' };

var EV = { on: false, owns: false, view: 'overview', mark: null, walk: null, N: null, ctx: null, made: [], marked: [], s: 1, nogl: null, evS: null, lastNode: null, btn: null };
var ISH = /[?&#]ev(idence)?=1\b/.test(location.hash);          // a link may open the page with the layer already on (#chart=whole&ev=1); the page itself never writes it

/* ---- reading and normalising the data for the mounted chart ------------------------------------------------------------ */
function rawOf(chart) { return chart.evidence || DATA.evidence || META.evidence || null; }
function ndOf(raw) {                                              // "not drawn yet": the evidence's own list, else the page's (the census gap list)
  var nd = raw && raw.notDrawn != null ? raw.notDrawn : META.notDrawn, items = [], count = null;
  if (typeof nd === 'number') count = nd;
  else if (Array.isArray(nd)) { items = nd; count = nd.length; }
  else if (nd && typeof nd === 'object') { items = Array.isArray(nd.items) ? nd.items : Array.isArray(nd.modules) ? nd.modules : []; count = nd.count != null ? nd.count : nd.total != null ? nd.total : items.length; }
  return { count: count, items: items };
}
function stageTitles(chart) {
  var m = {};
  arr(chart.stages).forEach(function (s) { if (s && s.id) m[s.id] = s.title || s.id; });
  arr(chart.regions).forEach(function (r) { if (r && r.id && r.kind === 'stage') m[r.id] = r.title || r.id; });
  arr(chart.geom && chart.geom.clusters).forEach(function (c) { if (c && c.id && !m[c.id]) m[c.id] = c.title || c.id; });
  return m;
}
function levelOf(v) { v = String(v || 'drawn').toLowerCase(); return v === 'seen' || v === 'proved' || v === 'suspected' ? v : 'drawn'; }
function normalise(ctx) {
  var chart = ctx.chart, raw = rawOf(chart);
  if (!raw || typeof raw !== 'object') return null;
  var N = { raw: raw, box: {}, route: {}, findings: [], elsewhere: 0, walks: [], tally: { suspected: 0, seen: 0, proved: 0, stale: 0, drawn: 0 }, stages: stageTitles(chart) };
  var fl = arr(raw.findings).length ? raw.findings : arr(raw.candidates).length ? raw.candidates : arr(chart.findings).length ? chart.findings : arr(DATA.findings);
  fl.forEach(function (f) {
    if (!f || typeof f !== 'object') return;
    var bs = arr(f.boxes).filter(function (b) { return chart.nodes[b]; }), rs = arr(f.routes).filter(function (r) { return chart.edges[r]; });
    if ((arr(f.boxes).length || arr(f.routes).length) && !bs.length && !rs.length) { N.elsewhere++; return; }       // names things only drawn on another chart
    if (!arr(f.boxes).length && !arr(f.routes).length && ctx.chart.kind !== 'whole') { N.elsewhere++; return; }      // a candidate no box cites belongs to the system, not to every chart: it shows on the whole map
    var g = f.group || (bs[0] && chart.nodes[bs[0]].stage && N.stages[chart.nodes[bs[0]].stage]) || 'Elsewhere on this map';
    N.findings.push({ key: String(f.key || f.check + ':' + (bs[0] || rs[0] || N.findings.length)), check: f.check || '', boxes: bs, routes: rs, question: String(f.question || ''), evidence: String(f.evidence || ''), group: g,
      falseAlarm: f.falseAlarm || f.false_alarm || '', next: f.next || f.nextStep || f.next_step || '', why: f.why || '' });
  });
  Object.keys(chart.nodes).forEach(function (id) {
    var info = (raw.boxes && raw.boxes[id]) || null, lv = levelOf(info && info.level), sus = N.findings.filter(function (f) { return f.boxes.indexOf(id) >= 0; });
    var st = !!(info && info.stale), brk = !!(info && arr(info.outcomes).some(function (o) { return /^(stuck|error)$/.test(o); }) && (lv === 'seen' || lv === 'proved'));
    var eff = lv === 'drawn' && (sus.length || (info && info.level === 'suspected')) ? 'suspected' : lv;
    if (info && info.level === 'suspected' && lv === 'drawn') eff = 'suspected';
    if (eff === 'drawn' && !st) { N.tally.drawn++; return; }
    N.box[id] = { lv: eff, info: info || {}, sus: sus, brk: brk, stale: eff === 'drawn' && st, q: sus.length > 0 && eff !== 'suspected' };
    if (N.box[id].stale) N.tally.stale++; else N.tally[eff]++;
  });
  Object.keys(chart.edges).forEach(function (id) {
    var info = (raw.routes && raw.routes[id]) || null, sus = N.findings.filter(function (f) { return f.routes.indexOf(id) >= 0; });
    var cnt = info ? Number(info.count) || 0 : 0, mod = info ? Number(info.modeled) || 0 : 0, mb = info ? Number(info.maybe) || 0 : 0;
    var lv = info && info.level ? levelOf(info.level) : (cnt > 0 || mod > 0 || mb > 0) ? 'seen' : 'drawn';
    if (lv === 'drawn' && sus.length) lv = 'suspected';
    if (lv === 'drawn') return;
    N.route[id] = { lv: lv, info: info || {}, count: cnt, modeled: mod, maybe: mb, sus: sus, q: sus.length > 0 && lv !== 'suspected' };
  });
  arr(raw.walks).forEach(function (w, i) {
    if (!w || typeof w !== 'object') return;
    var bs = arr(w.boxes).filter(function (b) { return chart.nodes[b]; });
    N.walks.push({ id: String(w.id || w.walk || 'w' + i), w: w, boxes: bs, routes: arr(w.routes).filter(function (r) { return chart.edges[r]; }), idx: i });
  });
  return N;
}
function hasData(ctx) { return !!rawOf(ctx.chart); }
function boxTitle(id) { var n = EV.ctx && EV.ctx.chart.nodes[id]; return n ? n.title : id; }
function routeWords(id) {
  var e = EV.ctx.chart.edges[id]; if (!e) return id;
  return boxTitle(e.from) + ' → ' + boxTitle(e.to) + (eShort(e) ? ' (' + eShort(e) + ')' : '');
}

/* ---- drawing on the map ---------------------------------------------------------------------------------------------------- */
function isPill(kind) { var k = String(kind || '').toLowerCase(); return k === 'end' || (typeof KIND !== 'undefined' && KIND[k] && !!KIND[k].pill); }
function kindOfBox(id) { var n = EV.ctx.chart.nodes[id]; return (n && (n.kind || n.category)) || 'step'; }
function ringRect(b, d, rx, cls) { return sv('rect', { 'class': cls, x: (b.x - d).toFixed(1), y: (b.y - d).toFixed(1), width: (b.w + 2 * d).toFixed(1), height: (b.h + 2 * d).toFixed(1), rx: (rx + d).toFixed(1) }); }
function lockGlyph() {
  var g = sv('g', { 'class': 'ev-lock' });
  g.appendChild(sv('path', { d: 'M-3 -.6v-2.1a3 3 0 0 1 6 0v2.1' })); g.appendChild(sv('rect', { 'class': 'ev-lk', x: -4.6, y: -.8, width: 9.2, height: 6.8, rx: 1.6 }));
  return g;
}
function chipW(c) { return c[0] === 'n' ? Math.max(17, 8 + 7 * c[1].length) : c[2] ? 13.6 : 17; }
function chipEl(c, x) {                                         // one badge shape centred at x (unscaled units): a "?", a count or a lock
  var g = sv('g', { 'class': c[2] ? 'ev-q2' : '', transform: 'translate(' + x.toFixed(1) + ' 0)' }), r = c[2] ? 6.8 : 8.5;
  if (c[0] === 'n') {
    var w = chipW(c);
    g.appendChild(sv('rect', { 'class': 'ev-bd', x: -w / 2, y: -r, width: w, height: 2 * r, rx: r }));
    var t = sv('text', { 'class': 'ev-bt', y: 4.1 }); t.textContent = c[1]; g.appendChild(t);
  } else {
    g.appendChild(sv('circle', { 'class': 'ev-bd', r: r }));
    if (c[0] === 'q') { var q = sv('text', { 'class': 'ev-bt', y: 4.2 }); q.textContent = '?'; g.appendChild(q); }
    else if (c[0] === 'lock') g.appendChild(lockGlyph());
  }
  return g;
}
function badge(cx, cy, chips, title, open) {                    // chips: [[kind, text, small?], ...]; the first sits on the anchor, the rest go leftwards
  var g = sv('g', { 'class': 'ev-b', transform: 'translate(' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ')', 'data-ev-open': open, 'aria-hidden': 'true' }), s = sv('g', { 'class': 'ev-bs' }), x = 0, prev = null;
  chips.forEach(function (c) { if (prev) x -= chipW(prev) / 2 + 3 + chipW(c) / 2; s.appendChild(chipEl(c, x)); prev = c; });
  var t = sv('title'); t.textContent = title; g.appendChild(s); g.appendChild(t);
  return g;
}
function pointAt(pts, f) {
  var tot = 0, i, d; for (i = 0; i < pts.length - 1; i++) tot += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  var h = tot * f, a = 0;
  for (i = 0; i < pts.length - 1; i++) { d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); if (a + d >= h && d > 0) { var u = (h - a) / d; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u]; } a += d; }
  return pts[0];
}
function attrOf(lv) { return lv === 'suspected' ? 'sus' : lv; }                // the css says [data-ev=sus]
function tag(el, name, val) { el.setAttribute(name, val); EV.marked.push([el, name]); }
function plan(m, count) {                                       // what one box or route wears: its badge chips
  var chips = [];
  if (m.lv === 'proved') chips.push(['lock', '']);
  else if (m.lv === 'seen') chips.push(['n', fmt(count || (m.info && m.info.modeled) || 1)]);
  else if (m.lv === 'suspected') chips.push(['q', '']);
  if (m.q) chips.push(['q', '', true]);
  return chips;
}
function seenWords(m, what) {
  var n = Number(m && m.count) || 0, md = Number(m && m.modeled) || 0;
  return n > 0 ? what + ' seen ' + plural(n, 'time', 'times') : md > 0 ? what + ' reached ' + plural(md, 'time', 'times') + ' in the model' : what + ' seen';
}
function boxTip(m) {
  if (m.stale) return 'Evidence from older code (stale)';
  var s = m.lv === 'suspected' ? 'Suspected: ' + (m.sus[0] ? clip(Q(m.sus[0].question), 90) : 'a candidate') : m.lv === 'proved' ? 'Proved' : seenWords(m.info, 'Box') + (m.brk ? ', and ended stuck here' : '');
  return s + '. Click for why.';
}
function decorate() {
  var X = EV.ctx, N = EV.N; if (!X || !N) return;
  var svg = X.svg, geomEdges = {};
  arr(X.chart.geom && X.chart.geom.edges).forEach(function (e) { geomEdges[e.id] = e.pts; });
  svg.classList.add('ev-on');
  Object.keys(N.box).forEach(function (id) {
    var m = N.box[id], el = X.nodeEl.get(id), b = X.nb[id]; if (!el || !b) return;
    var rx = isPill(kindOfBox(id)) ? b.h / 2 : 11, g = sv('g', { 'class': 'ev-m', 'aria-hidden': 'true' });
    tag(el, 'data-ev', m.stale ? 'stale' : attrOf(m.lv));
    if (m.brk) tag(el, 'data-brk', '1');
    if (m.info && m.info.anchorOnly) tag(el, 'data-anchor', '1');
    if (!m.stale) {
      g.appendChild(ringRect(b, 3.5, rx, 'ev-glow')); g.appendChild(ringRect(b, m.lv === 'proved' ? 6.5 : 3.5, rx, 'ev-ring'));
      if (m.lv === 'proved') g.appendChild(ringRect(b, 2.2, rx, 'ev-ring2'));
      var chips = plan(m, m.info && m.info.count);
      if (chips.length) g.appendChild(badge(b.x + b.w - 8, b.y + b.h + 1, chips, boxTip(m), 'node:' + id));
    } else {
      g.appendChild(ringRect(b, 3.5, rx, 'ev-ring'));
      var c0 = sv('g', { 'class': 'ev-b', 'data-ev-open': 'node:' + id, transform: 'translate(' + (b.x + b.w - 6).toFixed(1) + ' ' + (b.y + b.h + 1).toFixed(1) + ')', 'aria-hidden': 'true' }), s0 = sv('g', { 'class': 'ev-bs' }), t0 = sv('title');
      s0.appendChild(sv('circle', { 'class': 'ev-bd', r: 6 })); t0.textContent = boxTip(m); c0.appendChild(s0); c0.appendChild(t0); g.appendChild(c0);
    }
    el.appendChild(g); EV.made.push(g);
  });
  Object.keys(N.route).forEach(function (id) {
    var m = N.route[id], el = X.edgeEl.get(id), pts = geomEdges[id], line = el && q$('.edge-line', el); if (!el || !line) return;
    tag(el, 'data-ev', attrOf(m.lv));
    var cnt = m.count || m.modeled || m.maybe || 0, w = m.lv === 'suspected' ? 6 : Math.min(9, 2.6 + 1.5 * Math.log2(1 + Math.max(1, cnt)));
    var band = sv('path', { 'class': 'ev-band', d: line.getAttribute('d') }); band.style.setProperty('--bw', w.toFixed(1) + 'px');
    el.insertBefore(band, line); EV.made.push(band);
    if (pts && pts.length > 1) {
      var chips = m.lv === 'suspected' ? [['q', '']] : [['n', fmt(cnt || 1)]]; if (m.q) chips.push(['q', '', true]);
      var p = pointAt(pts, 0.3), bd = badge(p[0], p[1], chips, (m.lv === 'suspected' ? 'Suspected road' : seenWords(m, 'Road')) + '. Click for why.', 'route:' + id);
      el.appendChild(bd); EV.made.push(bd);
    }
  });
  zoomed(FL.scale(), true);
}
function undecorate() {
  clearWalk();
  EV.made.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); }); EV.made = [];
  EV.marked.forEach(function (m) { m[0].removeAttribute(m[1]); }); EV.marked = [];
  if (EV.ctx) { EV.ctx.svg.classList.remove('ev-on', 'ev-nogl', 'ev-norb'); EV.ctx.svg.style.removeProperty('--ev-s'); EV.ctx.svg.style.removeProperty('--ev-bk'); }
  EV.nogl = null; EV.evS = null; EV.norb = null; EV.bk = null;
}
function zoomed(s, force) {                                     // badges keep a steady size on screen (up to 3x); below that their glyphs go and the shapes stay
  if (!EV.on || !EV.ctx || FL.chart() !== EV.ctx) return;
  var k = Math.round(Math.min(3, Math.max(1, 1 / s)) * 20) / 20, ng = s < 0.32, nr = s < 0.5, bk = Math.round(Math.min(1, Math.max(0.4, s * 2.2)) * 10) / 10;
  if (force || k !== EV.evS) { EV.evS = k; EV.ctx.svg.style.setProperty('--ev-s', k); }
  if (force || ng !== EV.nogl) { EV.nogl = ng; EV.ctx.svg.classList.toggle('ev-nogl', ng); }
  if (force || bk !== EV.bk) { EV.bk = bk; EV.ctx.svg.style.setProperty('--ev-bk', bk); }
  if (force || nr !== EV.norb) { EV.norb = nr; EV.ctx.svg.classList.toggle('ev-norb', nr); }
}

/* ---- a walk lit across the map ------------------------------------------------------------------------------------------------ */
function walkParts(wk) {                                        // the routes a walk took (named, or found between consecutive boxes) and the pairs with no route
  var X = EV.ctx, edges = wk.routes.slice(), gaps = [], seen = {}, i;
  if (!edges.length) {
    for (i = 0; i + 1 < wk.boxes.length; i++) {
      var a = wk.boxes[i], b = wk.boxes[i + 1], hit = null; if (a === b) continue;
      (X.out[a] || []).forEach(function (eid) { if (!hit && X.chart.edges[eid].to === b) hit = eid; });
      if (hit) edges.push(hit); else gaps.push([a, b]);
    }
  }
  return { edges: edges.filter(function (e) { return seen[e] ? false : (seen[e] = 1); }), gaps: gaps };
}
function clearWalk() {
  var X = EV.ctx; EV.walk = null;
  if (!X) return;
  var g = q$('.ev-wg', X.svg); if (g && g.parentNode) g.parentNode.removeChild(g);
  Array.prototype.slice.call(X.svg.querySelectorAll('.ev-wring,.ev-wglow')).forEach(function (n) { n.parentNode.removeChild(n); });
  Array.prototype.slice.call(X.svg.querySelectorAll('.ev-w')).forEach(function (n) { n.classList.remove('ev-w'); });
  X.svg.classList.remove('ev-walking');
}
function lightWalk(wk) {
  var X = EV.ctx; clearWalk(); EV.walk = wk.id;
  var parts = walkParts(wk), g = sv('g', { 'class': 'ev-wg', 'aria-hidden': 'true' }), under = sv('g'), over = sv('g'), anchor = q$('g.nodes', X.svg), seenB = {};
  parts.edges.forEach(function (eid) {
    var el = X.edgeEl.get(eid), line = el && q$('.edge-line', el); if (!line) return;
    el.classList.add('ev-w'); var l = line.getAttribute('d');
    under.appendChild(sv('path', { 'class': 'ev-wp ev-wp-g', d: l })); over.appendChild(sv('path', { 'class': 'ev-wp ev-wp-l', d: l }));
    var lb = X.labelEl.get(eid); if (lb) lb.classList.add('ev-w');
  });
  parts.gaps.forEach(function (p) { var a = X.nb[p[0]], b = X.nb[p[1]]; if (a && b) over.appendChild(sv('line', { 'class': 'ev-wgap', x1: (a.x + a.w / 2).toFixed(1), y1: (a.y + a.h / 2).toFixed(1), x2: (b.x + b.w / 2).toFixed(1), y2: (b.y + b.h / 2).toFixed(1) })); });
  g.appendChild(under); g.appendChild(over);
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(g, anchor); else X.vp.appendChild(g);
  wk.boxes.forEach(function (id) {
    if (seenB[id]) return; seenB[id] = 1;
    var el = X.nodeEl.get(id), b = X.nb[id]; if (!el || !b) return;
    var rx = isPill(kindOfBox(id)) ? b.h / 2 : 11;
    el.classList.add('ev-w'); el.appendChild(ringRect(b, 3.5, rx, 'ev-wglow')); el.appendChild(ringRect(b, 3.5, rx, 'ev-wring'));
  });
  X.svg.classList.add('ev-walking');
  return parts;
}

/* ---- the docked panel: what is on the map, why, and what to do about it --------------------------------------------------- */
function swatch(lv, brk) {                                       // the outline of one level as a small picture (the same shapes as on the map)
  var col = brk ? 'var(--ev-brk)' : lv === 'suspected' ? 'var(--ev-sus)' : lv === 'drawn' ? 'var(--muted)' : lv === 'stale' ? 'var(--ev-stale)' : 'var(--ev-seen)';
  var base = '<rect x="9" y="5" width="24" height="12" rx="4" fill="var(--bg)" stroke="var(--line2)" stroke-width="1" opacity="' + (lv === 'drawn' ? '.8' : '1') + '"/>', ring = '';
  if (lv === 'suspected') ring = '<rect class="ev-k-ring" x="6.5" y="2.5" width="29" height="17" rx="6" style="stroke:' + col + ';stroke-dasharray:5 3"/><circle cx="33" cy="19" r="4.2" fill="' + col + '"/><text x="33" y="21.4" font-size="6.5" font-weight="800" text-anchor="middle" fill="var(--ev-sus-ink)">?</text>';
  else if (lv === 'seen') ring = '<rect class="ev-k-ring" x="6.5" y="2.5" width="29" height="17" rx="6" style="stroke:' + col + '"/><rect x="29" y="15" width="10" height="7" rx="3.5" fill="' + col + '"/>';
  else if (lv === 'proved') ring = '<rect class="ev-k-ring" x="5" y="1.5" width="32" height="19" rx="7" style="stroke:' + col + '"/><rect class="ev-k-ring" x="7.8" y="4.3" width="26.4" height="13.4" rx="5" style="stroke:' + col + '"/><circle cx="34" cy="19" r="4.2" fill="' + col + '"/>';
  else if (lv === 'stale') ring = '<rect class="ev-k-ring" x="6.5" y="2.5" width="29" height="17" rx="6" style="stroke:' + col + ';stroke-dasharray:1.5 3.5;stroke-linecap:round"/>';
  return '<svg viewBox="0 0 42 24" aria-hidden="true">' + base + ring + '</svg>';
}
function levelWord(lv, stale) { return stale ? 'Stale' : LV_WORDS[lv] || lv; }
function keyHTML() {
  return '<div class="ev-key">' + ['drawn', 'suspected', 'seen', 'proved'].map(function (l) {
    return '<div class="ev-key-row">' + swatch(l) + '<div><b>' + LV_WORDS[l] + '</b><span>' + LV_HELP[l] + '</span></div></div>';
  }).join('') + '</div>';
}
function chipsHTML(ids, max) {
  var cid = EV.ctx.id, shown = ids.slice(0, max || 6);
  return '<div class="ev-chips">' + shown.map(function (b) { return '<button type="button" class="ev-chip" data-node="' + E(b) + '" data-chart="' + E(cid) + '" title="Show on the map: ' + E(boxTitle(b)) + '">' + E(clip(boxTitle(b), 28)) + '</button>'; }).join('') +
    (ids.length > shown.length ? '<span class="ev-more">+' + (ids.length - shown.length) + ' more</span>' : '') + '</div>';
}
function shapeOf(f) {         // the same words the Where it can break page uses for this kind of check (breaks.js BK_KIND), so one check has one name on the page
  var k = typeof BK_KIND !== 'undefined' && f.check && BK_KIND[f.check];
  return k ? k[0] : SHAPE[f.check] || (f.check ? String(f.check).replace(/-/g, ' ') : 'a candidate');
}
function overviewHTML() {
  var N = EV.N, raw = N.raw, T = N.tally, h = '<div class="ev-panel">', n, nd = ndOf(raw), cap = 10, shownN = 0;
  h += '<p class="ev-lead">Outline shows how we know, colour shows what we found. A mark is a question, not a verdict, and an unproven box is never marked green.</p>' + keyHTML();
  h += '<div class="ev-tally"><span title="Boxes that one of the candidates below names. A candidate can name several boxes, so this counts boxes, not questions."><b>' + T.suspected + '</b> boxes named by a candidate</span><span><b>' + T.seen + '</b> seen</span><span><b>' + T.proved + '</b> proved</span><span><b>' + T.drawn + '</b> drawn only</span>' + (T.stale ? '<span><b>' + T.stale + '</b> stale</span>' : '') + '</div>';
  /* candidates, grouped, at most ten */
  n = N.findings.length;
  h += '<h4 class="ev-h">Candidates <span class="hp-cnt">' + n + '</span></h4>';
  var bkN = typeof bkNums === 'function' && typeof gdFindings === 'function' ? bkNums() : null;      // only when the guides are in this page
  if (bkN && n) h += '<p class="ev-more">These are the ' + n + ' highest-ranked of the ' + bkN.look + ' questions to look at. The rest, and the ' + bkN.setAside + ' set aside, are in <a class="hlink" href="#reading=breaks">Where it can break</a>; <a class="hlink" href="#reading=scope&section=numbers">what the numbers count</a> says why they differ.</p>';
  if (!n) h += '<p class="ev-more">No candidates on this map' + (N.elsewhere ? ' (' + N.elsewhere + ' on other maps)' : '') + '.' + (bkN ? ' The ' + bkN.look + ' questions to look at are listed in <a class="hlink" href="#reading=breaks">Where it can break</a>.' : '') + '</p>';       // never "These are the 0 highest-ranked"
  else {
    var groups = [], by = {};
    N.findings.slice(0, cap).forEach(function (f) { if (!by[f.group]) { by[f.group] = { name: f.group, list: [] }; groups.push(by[f.group]); } by[f.group].list.push(f); });
    groups.forEach(function (g) {
      h += '<div class="ev-grp">' + E(g.name) + '</div>';
      g.list.forEach(function (f) {
        shownN++;
        h += '<div class="ev-card" data-lv="suspected"><button type="button" class="ev-open" data-ev-open="f:' + E(f.key) + '"><span class="ev-q">' + P(f.question || shapeOf(f)) + '</span><span class="ev-shape">' + E(shapeOf(f)) + '</span></button>' +
          (f.boxes.length ? chipsHTML(f.boxes, 4) : '') + '</div>';
      });
    });
    if (n > cap) h += '<p class="ev-more">' + (n - cap) + ' more candidates are not shown here; the agent view lists them all (faultline breaks).</p>';
    if (N.elsewhere) h += '<p class="ev-more">' + N.elsewhere + ' more name things drawn only on other maps.</p>';
  }
  /* walks */
  if (N.walks.length) {
    h += '<h4 class="ev-h">Walks <span class="hp-cnt">' + N.walks.length + '</span></h4><p class="ev-more">Pick one to light its path across the map.</p>';
    N.walks.forEach(function (wk) {
      var w = wk.w, ok = wk.boxes.length > 1, on = EV.walk === wk.id, title = w.title || [w.tool, w.outcome].filter(Boolean).join(' · ') || wk.id;
      h += '<button type="button" class="ev-walk" data-ev-walk="' + E(wk.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' + (ok ? '' : ' disabled') + '><b>' + E(clip(title, 60)) + '</b>' +
        (w.count ? '<span class="ev-wn">' + fmt(w.count) + '×</span>' : '') + '<small>' + E(clip(w.says || w.label || (ok ? plural(wk.boxes.length, 'box', 'boxes') + ' on the path' : 'no path was stored for this walk'), 120)) + '</small></button>';
    });
  }
  /* what is not drawn yet */
  var nm = arr(raw.notMapped), mr = arr(raw.missingRoutes), cnt = nd.count != null ? nd.count : nd.items.length;
  h += '<h4 class="ev-h">Not drawn yet <span class="hp-cnt">' + (nd.count != null || nd.items.length ? cnt : '') + '</span></h4>';
  if (nd.count == null && !nd.items.length) h += '<p class="ev-more">This build did not report a list of what is not drawn.</p>';
  else if (!nd.items.length) h += '<p class="ev-more">' + (cnt === 0 ? 'Nothing the census lists is left undrawn.' : plural(cnt, 'item is', 'items are') + ' not drawn yet; the list is not part of this build.') + '</p>';
  else {
    h += '<ul class="ev-list">' + nd.items.slice(0, 12).map(function (it) {
      var p = typeof it === 'string' ? it : (it && (it.path || it.name || it.id)) || '', why = it && typeof it === 'object' ? it.why || it.note || '' : '';
      return '<li><code>' + E(p) + '</code>' + (why ? '<small>' + E(clip(why, 110)) + '</small>' : '') + '</li>';
    }).join('') + '</ul>' + (nd.items.length > 12 ? '<p class="ev-more">+' + (nd.items.length - 12) + ' more in the draft strip above the map.</p>' : '');
  }
  if (nm.length) h += '<details><summary>Reached in a walk, but no box for it (' + nm.length + ')</summary><ul class="ev-list">' + nm.slice(0, 10).map(function (x) { return '<li><code>' + E(x.key || '') + '</code><small>' + E(clip((x.count ? 'seen ' + plural(x.count, 'time', 'times') + '. ' : '') + (x.why || ''), 120)) + '</small></li>'; }).join('') + '</ul></details>';
  if (mr.length) h += '<details><summary>Two steps in a row with no road between them (' + mr.length + ')</summary><ul class="ev-list">' + mr.slice(0, 10).map(function (x) {
    var f = arr(x.from).map(boxTitle).join(', '), t = arr(x.to).map(boxTitle).join(', '); return '<li>' + E(clip(f, 40)) + ' → ' + E(clip(t, 40)) + '<small>the map is missing this road' + (x.count ? '; seen ' + plural(x.count, 'time', 'times') : '') + '</small></li>'; }).join('') + '</ul></details>';
  /* what was checked: the labels say it, nothing else may */
  var labs = arr(raw.labels);
  h += '<h4 class="ev-h">What was checked</h4><div class="ev-checked">';
  if (!labs.length && !N.walks.length) h += '<p>No run or test has been loaded. Everything marked here is read from the code alone, so nothing is seen or proved yet.</p>';
  else {
    if (labs.length) h += '<ul class="ev-list">' + labs.slice(0, 8).map(function (l) { return '<li><b>' + E(l.tool || l.walk || 'a walk') + '</b>' + (l.kind ? ' <small style="display:inline">(' + E(l.kind) + ')</small>' : '') + '<small>' + E(l.says || String(l.label || '').toLowerCase().replace(/_/g, ' ') || '') + '</small></li>'; }).join('') + '</ul>';
    else h += '<p>' + plural(N.walks.length, 'walk was', 'walks were') + ' loaded; none says what it covered.</p>';
  }
  var ux = arr(raw.unexplored);
  if (ux.length) h += '<details><summary>Not checked (' + ux.length + ')</summary><ul class="ev-list">' + ux.slice(0, 8).map(function (u) { return '<li><code>' + E(u.at || '') + '</code><small>' + E(clip(u.why || 'left out of the run', 100)) + '</small></li>'; }).join('') + '</ul></details>';
  var st = arr(raw.stale);
  if (st.length) h += '<details><summary>Older than the code (' + st.length + ')</summary><ul class="ev-list">' + st.slice(0, 8).map(function (u) { return '<li><code>' + E(u.fn || '') + '</code><small>' + E(clip(u.why || 'changed since the run', 100)) + '</small></li>'; }).join('') + '</ul></details>';
  var ut = arr(raw.untested).filter(function (id) { return EV.ctx.chart.nodes[id]; });
  if (ut.length) h += '<details><summary>Looked at, never ran (' + ut.length + ')</summary>' + chipsHTML(ut, 12) + '</details>';
  return h + '</div></div>';
}

/* one mark explained: why, the evidence, what would make it a false alarm, the next step to strengthen it */
function stripCand(s) { return String(s || '').replace(/^candidate:\s*/i, ''); }
function toolsText(info) { var t = arr(info && info.tools); return t.length ? ' by ' + t.slice(0, 3).join(', ') + (t.length > 3 ? ' and ' + (t.length - 3) + ' more' : '') : ''; }
function explainFinding(f, id) {
  var why = f.why || WHY[f.check] || f.question || 'This matches a shape worth a question.';
  var ev = f.evidence ? [stripCand(f.evidence)] : [];
  return { lv: 'suspected', title: id ? boxTitle(id) : (f.boxes[0] ? boxTitle(f.boxes[0]) : shapeOf(f)), question: f.question, shape: shapeOf(f), why: why, evidence: ev,
    fhead: 'What would make this a false alarm', falseAlarm: f.falseAlarm || FALSE_ALARM[f.check] || 'Something the map does not show (an outside trigger, data only known at run time) already covers it.',
    next: f.next || NEXT[f.check] || 'Run a walk through this spot, or add what the map is missing.', boxes: f.boxes, routes: f.routes };
}
function explainBox(id) {
  var m = EV.N.box[id]; if (!m) return null;
  var info = m.info || {}, reasons = arr(info.reasons).map(String);
  if (m.sus.length && m.lv === 'suspected') { var x = explainFinding(m.sus[0], id); if (m.sus.length > 1) x.evidence = x.evidence.concat(m.sus.slice(1).map(function (f) { return 'Also: ' + (f.question || shapeOf(f)); })); return x; }
  var base = { title: boxTitle(id), boxes: [id], routes: [], lv: m.lv, brk: m.brk, stale: m.stale };
  if (m.stale) return Object.assign(base, { why: 'Evidence exists for this box, but the code it cites has changed since, so it counts for nothing yet.' + (info.staleLevel ? ' It was once ' + info.staleLevel + '.' : ''), evidence: reasons,
    fhead: 'What would make this a false alarm', falseAlarm: 'The change was only a comment or a rename and the behaviour is the same.', next: 'Run the walk again against the current code.' });
  var n = Number(info.count) || 0, md = Number(info.modeled) || 0, out = arr(info.outcomes);
  var ev = reasons.slice(); if (m.sus.length) ev = ev.concat(m.sus.map(function (f) { return 'Also a candidate: ' + (f.question || shapeOf(f)); }));
  if (info.claimed) ev.push(plural(info.claimed, 'claim', 'claims') + ' with no replay file: counted for nothing.');
  if (out.length) ev.push('Outcome recorded here: ' + out.join(', ').replace(/\?/g, ' (claimed)') + '.');
  if (m.lv === 'proved') {
    var pw = (n ? 'Replayed or proved ' + plural(n, 'time', 'times') : 'Proved in the model') + toolsText(info) + (m.brk ? ', ending stuck here' : '') + '.';
    return Object.assign(base, { why: pw, evidence: ev, fhead: m.brk ? 'What would make this a false alarm' : 'What this does not show',
      falseAlarm: m.brk ? 'The run’s own rule for stuck is stricter than the real system, or this box is a place that is meant to wait.' : 'Proved here says nothing about the other roads out of this box, or about use outside what was run.',
      next: 'Keep the witness file with the run, and run again after the code changes so this stays current.' });
  }
  var sw = (n ? 'Seen ' + plural(n, 'time', 'times') : md ? 'Reached ' + plural(md, 'time', 'times') + ' in the model' : 'Seen') + toolsText(info) + (m.brk ? ', ending stuck here' : '') + '.';
  if (info.anchorOnly) sw = 'A line cited by this box ran, but no drawn road leads here, so nobody is shown to arrive.';
  return Object.assign(base, { why: sw, evidence: ev, fhead: m.brk ? 'What would make this a false alarm' : 'What this does not show',
    falseAlarm: m.brk ? 'The run’s own rule for stuck is stricter than the real system, or this box is a place that is meant to wait.' : 'It ran in what was checked. That says nothing about the other roads out of it, or about use outside that run.',
    next: m.brk ? 'Replay the run from its witness file: a replay turns seen into proved.' : 'Replay a run that reaches it (or model-check it) to turn seen into proved.' });
}
function explainRoute(id) {
  var m = EV.N.route[id]; if (!m) return null;
  var e = EV.ctx.chart.edges[id], base = { title: routeWords(id), boxes: e ? [e.from, e.to] : [], routes: [id], lv: m.lv };
  if (m.sus.length && m.lv === 'suspected') { var x = explainFinding(m.sus[0], null); x.title = routeWords(id); x.boxes = base.boxes; return x; }
  var n = m.count, md = m.modeled, ev = [];
  if (m.maybe) ev.push(plural(m.maybe, 'step', 'steps') + ' could have taken this road or a sibling; they are counted as maybe, not here.');
  if (m.sus.length) ev = ev.concat(m.sus.map(function (f) { return 'Also a candidate: ' + (f.question || shapeOf(f)); }));
  return Object.assign(base, { why: n ? 'Taken ' + plural(n, 'time', 'times') + ' in what was checked.' : md ? 'Reached ' + plural(md, 'time', 'times') + ' in the model only.' : 'Seen in what was checked.', evidence: ev,
    fhead: 'What this does not show', falseAlarm: 'A road taken in one run says nothing about the condition on it being right, or about runs that were not checked.', next: 'Replay a run over this road, or model-check it, to turn seen into proved.' });
}
function findFinding(key) { var r = null; EV.N.findings.forEach(function (f) { if (f.key === key) r = f; }); return r; }
function detailHTML(target) {
  var k = target.split(':')[0], id = target.slice(k.length + 1), x = k === 'f' ? (findFinding(id) ? explainFinding(findFinding(id), null) : null) : k === 'node' ? explainBox(id) : explainRoute(id);
  if (!x) return null;
  var lv = x.stale ? 'stale' : x.lv, sum = LV_HELP[lv] || 'older evidence', h = '<div class="ev-panel ev-d"><button type="button" class="ev-back" data-ev-back="1">‹ All evidence</button>';
  h += '<span class="ev-lv">' + swatch(lv, x.brk) + '<span>' + E(levelWord(x.lv, x.stale)) + (x.brk ? ' · ended stuck' : '') + ' <span style="font-weight:500;color:var(--muted)">· ' + E(sum) + '</span></span></span>';
  h += '<h4 class="ev-d-t">' + E(x.title) + '</h4>' + (x.question ? '<p style="margin-top:4px;font-weight:600">' + P(x.question) + '</p>' : '') + (x.shape ? '<p class="ev-more">' + E(x.shape) + '</p>' : '');
  h += '<h5 class="ev-d-h">Why it is marked</h5><p>' + P(x.why) + '</p>';
  h += '<h5 class="ev-d-h">Evidence</h5>' + (x.evidence.length ? '<ul>' + x.evidence.slice(0, 8).map(function (s) { return '<li>' + P(s) + '</li>'; }).join('') + '</ul>' : '<p class="ev-more">Nothing more is recorded.</p>');
  h += '<h5 class="ev-d-h">' + E(x.fhead) + '</h5><p>' + E(x.falseAlarm) + '</p>';
  h += '<h5 class="ev-d-h">Next step to strengthen it</h5><p>' + E(x.next) + '</p>';
  var bs = x.boxes.filter(function (b) { return EV.ctx.chart.nodes[b]; });
  if (bs.length) h += '<h5 class="ev-d-h">Where</h5>' + chipsHTML(bs, 8);
  var first = bs[0];
  h += '<div class="ev-acts">' + (first ? '<button type="button" data-node="' + E(first) + '" data-chart="' + E(EV.ctx.id) + '">Show on the map</button><button type="button" data-ev-copy="faultline where ' + E(/\s/.test(first) ? '"' + first + '"' : first) + '">Copy pointer</button>' : '') + '</div></div>';
  return h;
}

/* ---- the panel itself, opened through the viewer's docked panel (FL.openPanel) --------------------------------------------- */
var CFG = { onClick: function (e) { panelClick(e); }, onClose: function () { EV.owns = false; } };
function copyText(t, btn) {
  var done = function () { if (btn) { var o = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = o; }, 1400); } };
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).then(done, function () { fallbackCopy(t); done(); }); return; } } catch (e) { /* fall through */ }
  fallbackCopy(t); done();
}
function fallbackCopy(t) { var a = document.createElement('textarea'); a.value = t; a.setAttribute('readonly', ''); a.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); } catch (e) { /* ignore */ } document.body.removeChild(a); }
function showPanel() {
  if (!EV.on || !EV.N || !EV.ctx) return;
  var html = EV.view === 'detail' && EV.mark ? detailHTML(EV.mark) : null;
  if (!html) { EV.view = 'overview'; EV.mark = null; html = overviewHTML(); }
  FL.openPanel(EV.view === 'detail' ? 'Evidence: why it is marked' : 'Evidence', html, CFG); EV.owns = true;
}
function showDetail(target) { EV.view = 'detail'; EV.mark = target; showPanel(); }
function showOverview() { EV.view = 'overview'; EV.mark = null; showPanel(); }
function panelClick(e) {
  var t = e.target.closest ? e.target.closest('[data-ev-open],[data-ev-back],[data-ev-walk],[data-ev-copy]') : null; if (!t) return;
  if (t.hasAttribute('data-ev-open')) showDetail(t.getAttribute('data-ev-open'));
  else if (t.hasAttribute('data-ev-back')) showOverview();
  else if (t.hasAttribute('data-ev-copy')) copyText(t.getAttribute('data-ev-copy'), t);
  else if (t.hasAttribute('data-ev-walk') && !t.disabled) {
    var id = t.getAttribute('data-ev-walk'), cur = EV.walk === id, wk = EV.N.walks.filter(function (w) { return w.id === id; })[0];
    if (cur || !wk) clearWalk(); else lightWalk(wk);
    Array.prototype.slice.call(t.parentNode.querySelectorAll('[data-ev-walk]')).forEach(function (b) { b.setAttribute('aria-pressed', EV.walk === b.getAttribute('data-ev-walk') ? 'true' : 'false'); });
  }
}

/* ---- the switch, the hooks and the clicks ------------------------------------------------------------------------------------ */
function addButton() {
  var bar = q$('.rd-bar'); if (!bar) return null;                 // the bar sits in the toolbar on a laptop-sized window (regions.js placeDockBar), so it is not looked for inside the dock
  var b = document.createElement('button');
  b.id = 'rdEvidence'; b.type = 'button'; b.className = 'chip-btn'; b.hidden = true; b.setAttribute('aria-pressed', 'false');
  b.title = 'Show where the map is backed by evidence: outline says how we know, colour says what we found. Off by default.';
  b.innerHTML = '<span class="ev-sw" aria-hidden="true"></span>Evidence';
  bar.appendChild(b); b.addEventListener('click', function () { setOn(!EV.on, true); });
  return b;
}
function say(t) { var sr = q$('#sr'); if (sr) { sr.textContent = ''; setTimeout(function () { sr.textContent = t; }, 30); } }
function setOn(on, open) {
  if (on && !EV.N) return;
  EV.on = !!on; if (EV.btn) EV.btn.setAttribute('aria-pressed', EV.on ? 'true' : 'false');
  if (open) say(EV.on ? 'Evidence on. ' + EV.N.findings.length + ' candidates, ' + EV.N.tally.seen + ' boxes seen, ' + EV.N.tally.proved + ' proved. Details are in the panel beside the map.' : 'Evidence off.');
  if (EV.on) {
    decorate();
    if (open) { var rr = q$('#rdRegions'); if (rr && rr.getAttribute('aria-expanded') === 'true') rr.click(); showOverview(); }       // one docked list at a time: the regions list gives the map its room back
  }
  else { undecorate(); if (EV.owns) { FL.closePanel(); } EV.owns = false; EV.view = 'overview'; EV.mark = null; }
}
function placeButton() {
  var dock = q$('#regionDock'), has = !!EV.N;
  if (!EV.btn) EV.btn = addButton(); if (!EV.btn) return;
  EV.btn.hidden = !has;
  if (has && dock && dock.hidden) {                          // a chart with no regions has no toolbar: show it, with this switch alone
    dock.hidden = false; ['rdRegions', 'rdHalos', 'rdLabels', 'rdSpine'].forEach(function (id) { var b = q$('#' + id); if (b) b.hidden = true; });
  }
}
FL.onChart(function (ctx) {
  EV.ctx = ctx; EV.made = []; EV.marked = []; EV.walk = null; EV.nogl = null; EV.evS = null; EV.lastSel = null;
  EV.N = hasData(ctx) ? normalise(ctx) : null;
  placeButton();
  var link = ISH; ISH = false;                                // a link asks for the layer on the first chart only
  if (link && EV.N) { setOn(true, true); return; }
  if (EV.on && EV.N) { decorate(); if (EV.owns) { EV.view = 'overview'; EV.mark = null; showPanel(); } }
  else if (EV.owns) { EV.owns = false; FL.closePanel(); }
});
FL.onZoom(function (s) { zoomed(s, false); });

/* a mark opens its explanation; a pinned (clicked or walked-to) box that wears a mark does too, once the panel is open */
function pinnedKey() {
  var p = new URLSearchParams(location.hash.replace(/^#/, '')), n = p.get('node'), e = p.get('edge');
  return n ? 'node:' + n : e ? 'route:' + e : null;
}
function syncSel() {
  if (!EV.on || !EV.N || !EV.owns) return;
  var key = pinnedKey(); if (key === EV.lastSel) return; EV.lastSel = key;
  if (!key) return;
  var k = key.split(':')[0], id = key.slice(k.length + 1);
  if (k === 'node' ? EV.N.box[id] : EV.N.route[id]) showDetail(key);
}
var cv = q$('#canvas');
if (cv) cv.addEventListener('click', function (e) {
  if (!EV.on) return;
  var b = e.target.closest ? e.target.closest('.ev-b') : null;
  if (b) { var t = b.getAttribute('data-ev-open'); EV.lastSel = pinnedKey(); showDetail(t); return; }
  setTimeout(syncSel, 0);
});
document.addEventListener('keyup', function () { if (EV.on) setTimeout(syncSel, 30); });
window.addEventListener('hashchange', function () { if (EV.on) setTimeout(syncSel, 0); });
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' || !EV.walk) return;
  clearWalk(); var d = q$('#dockPanel'); if (d) Array.prototype.slice.call(d.querySelectorAll('[data-ev-walk]')).forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
}, true);
window.atlasEvidence = function () { return { on: EV.on, owns: EV.owns, view: EV.view, mark: EV.mark, walk: EV.walk, tally: EV.N && EV.N.tally, findings: EV.N ? EV.N.findings.length : 0, boxes: EV.N ? Object.keys(EV.N.box).length : 0, routes: EV.N ? Object.keys(EV.N.route).length : 0 }; };
})();
