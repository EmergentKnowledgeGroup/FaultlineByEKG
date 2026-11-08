/* Frame pass (viewer/frame.js, same closure as viewer.js, included after look.js). */

/* ---- road-label pills fit their words: even padding left and right, the words clear of the border.
   The renderer draws each pill from the placer's estimate of the words' width, which is about twice the real width, and puts the words against the road: the words ended up
   pressed to one border with the rest empty. After the chart is in the page the pill is cut to the words it holds (4 map units each side). The side beside the road does not move. ---- */
(function () {
  var PAD = 4;
  function tighten(X) {
    if (!X || X.tight || isWhole(X.chart)) return;
    var svg = X.svg, hid = svg.classList.contains('zt-no-elabel'), items = [], i, g, bg, ts, bb, x0, x1, y0, y1, j, b;
    if (hid || !X.labelEl.size) return;
    svg.classList.add('fl-measure');                                                         // measured in the weight a lit pill uses, so a lit pill never has less room than a dim one
    X.labelEl.forEach(function (el) {
      bg = el.querySelector('.elabel-bg'); ts = el.querySelectorAll('.elabel-text'); if (!bg || !ts.length) return;
      x0 = 1e9; x1 = -1e9; y0 = 1e9; y1 = -1e9;
      for (j = 0; j < ts.length; j++) { try { b = ts[j].getBBox(); } catch (e) { return; } if (!b.width) return; x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.width); y0 = Math.min(y0, b.y); y1 = Math.max(y1, b.y + b.height); }
      items.push([bg, x0, x1]);
    });
    svg.classList.remove('fl-measure');
    for (i = 0; i < items.length; i++) { g = items[i]; g[0].setAttribute('x', (g[1] - PAD).toFixed(2)); g[0].setAttribute('width', (g[2] - g[1] + 2 * PAD).toFixed(2)); }
    X.tight = true;
  }
  FL.onChart(function (X) { tighten(X); });
  FL.onZoom(function () { if (C && !C.tight) tighten(C); });
})();

/* ---- a tab never lies on another tab or on another box's name at the size the chart opens at.
   The layout (render.mjs chipLayout) keeps tabs clear at the growth it expects, and in a dense place it settles for a tab that is clear only without growth. At the real zoom such a tab grows onto its neighbour. Here the tab that would
   cover something is cut shorter (with the cut mark; its full name stays in its tooltip) until it clears it, never below 9 characters. Only tabs that collide are touched. ---- */
(function () {
  var CH = 7.05, PAD = 12, MARK = '···';
  function rectOf(x, y, w, h) { return { x: x, y: y, w: w, h: h }; }
  function hit(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
  function textRect(t) { try { var q = t.getBBox(); return q.width > 0 ? rectOf(q.x, q.y, q.width, q.height) : null; } catch (e) { return null; } }
  function shorter(s, full) {                              // three characters shorter: the cut mark stays between the start and the end of the name
    var i = s.indexOf(MARK), head, tail, m;
    if (full && full.length > s.length && typeof middleCut === 'function' && s.length - 3 >= 9) {         // cut again from the whole name, so both ends of the cut stay on a word or path boundary where one is within reach
      m = middleCut(full, s.length - 3, Math.round((s.length - 4) * 0.42)); if (m.length < s.length && m.indexOf(MARK) > 0) return m;
    }
    if (i < 0) { var c = s.length - 3; return c >= 9 && typeof middleCut === 'function' ? middleCut(s, c, Math.round((c - 1) * 0.42)) : s; }
    head = s.slice(0, i); tail = s.slice(i + MARK.length);
    if (s.length <= 9) return s;
    if (head.length >= tail.length && head.length > 2) head = head.slice(0, -1); else if (tail.length > 2) tail = tail.slice(1); else head = head.slice(0, -1);
    return head + MARK + tail;
  }
  function setText(c, s) {
    var tx = c.tx, i = s.indexOf(MARK), w = Math.round(s.length * CH + PAD);
    while (tx.firstChild) tx.removeChild(tx.firstChild);
    if (i < 0) tx.appendChild(document.createTextNode(s));
    else { tx.appendChild(document.createTextNode(s.slice(0, i))); var ts = document.createElementNS('http://www.w3.org/2000/svg', 'tspan'); ts.setAttribute('class', 'chip-cut'); ts.textContent = MARK; tx.appendChild(ts); tx.appendChild(document.createTextNode(s.slice(i + MARK.length))); }
    c.bg.setAttribute('width', w); tx.setAttribute('x', (c.x + w / 2).toFixed(1)); c.w = w; c.s = s;
    if (!c.g.querySelector('title') && c.full) { var ti = document.createElementNS('http://www.w3.org/2000/svg', 'title'); ti.textContent = c.full; c.g.insertBefore(ti, c.g.firstChild); }
  }
  function fixTabs(X) {
    if (!X || isWhole(X.chart) || X.chart.kind === 'overview' || X.nodeCount > 150) return;
    var cs = chipScaleAt(view.s), chips = [], words = [], moved = 0, i, j, k, guard;
    X.svg.querySelectorAll('g.chip').forEach(function (g) {
      var bg = g.querySelector('.chip-bg'), tx = g.querySelector('.chip-text'), nd = g.closest('g.node'); if (!bg || !tx || !nd) return;
      chips.push({ g: g, bg: bg, tx: tx, node: nd, x: +bg.getAttribute('x'), y: +bg.getAttribute('y'), w: +bg.getAttribute('width'), h: +bg.getAttribute('height'), s: tx.textContent, full: g.getAttribute('data-handle') || '' });
    });
    if (chips.length < 1) return;
    X.svg.querySelectorAll('g.node').forEach(function (n) { n.querySelectorAll('.node-text').forEach(function (t) { var r = textRect(t); if (r) words.push({ node: n, r: r }); }); });
    X.svg.querySelectorAll('g.elabel .elabel-bg').forEach(function (r) { var q = textRect(r); if (q) words.push({ node: null, r: q }); });      // a road condition is words too
    var env = function (c) { return rectOf(c.x - 1, c.y - c.h * (cs - 1) / 2 - 1, c.w * cs + 2, c.h * cs + 2); };
    var clash = function (c) {
      var e = env(c), o;
      for (k = 0; k < chips.length; k++) { o = chips[k]; if (o !== c && hit(e, env(o))) return true; }
      for (k = 0; k < words.length; k++) { if (hit(e, words[k].r)) return true; }
      return false;
    };
    var order = chips.slice().sort(function (a, b) { return b.w - a.w; });
    for (i = 0; i < order.length; i++) {
      var c = order[i], was = c.s; guard = 0;
      while (clash(c) && guard++ < 12) { var n = shorter(c.s, c.full); if (n === c.s) break; setText(c, n); }
      if (clash(c)) setText(c, was);                       // shortening does not clear it (it is on the box's own words, say): the tab is left as the layout drew it, not cut for nothing
      else if (c.s !== was) moved++;
    }
    if (moved) { X.tightBy = null; }
  }
  FL.onChart(function (X) { fixTabs(X); setTimeout(function () { if (FL.chart() === X) fixTabs(X); }, 450); });
})();
