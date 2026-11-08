/* Story overlay for a Faultline atlas page. It reads #sc-data (the story check, trimmed) and marks the story's boxes and roads by what the tool map says.
   It adds attributes, a few small marks and one bar. It never edits the story or the page's own data, and "Marks off" returns the page to how it was drawn. */
(function () {
  var el = document.getElementById('sc-data');
  if (!el) return;
  var D;
  try { D = JSON.parse(el.textContent); } catch (e) { return; }
  var KEY = 'story-overlay-marks', on = true, NS = 'http://www.w3.org/2000/svg';
  try { on = localStorage.getItem(KEY) !== 'off'; } catch (e) { on = true; }

  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  // ---- the bar: counts, a switch, and a fold-out that says what the marks mean and what they cannot see
  var bar = h('div'); bar.id = 'sc-bar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Story against the tool map');
  var row = h('div', 'sc-row'); bar.appendChild(row);
  row.appendChild(h('span', 'sc-title', 'Story vs tool map'));
  D.counts.forEach(function (c) { var s = h('span', 'sc-n' + (c.mark ? ' sc-n-mark' : ''), c.n + ' ' + c.t); s.title = c.tip; row.appendChild(s); });
  var more = h('button', 'sc-btn', 'About'); more.type = 'button'; more.setAttribute('aria-expanded', 'false'); row.appendChild(more);
  var sw = h('button', 'sc-btn sc-switch'); sw.type = 'button'; row.appendChild(sw);
  var about = h('div', 'sc-about'); about.hidden = true;
  D.about.forEach(function (t) { about.appendChild(h('p', null, t)); });
  bar.appendChild(about);
  document.body.appendChild(bar);
  var tip = h('div'); tip.id = 'sc-tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true; document.body.appendChild(tip);

  function svg(tag, attrs) { var n = document.createElementNS(NS, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); return n; }

  function mark() {
    var cv = document.getElementById('canvas');
    sw.textContent = on ? 'Marks on' : 'Marks off'; sw.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (!cv) return;
    cv.setAttribute('data-sc', on ? 'on' : 'off');
    cv.querySelectorAll('g.edge[data-edge]').forEach(function (g) {
      var r = D.roads[g.getAttribute('data-edge')];
      if (!r) { g.removeAttribute('data-sc-j'); g.removeAttribute('data-sc-f'); return; }
      if (r.j) g.setAttribute('data-sc-j', r.j); else g.removeAttribute('data-sc-j');
      if (r.f) g.setAttribute('data-sc-f', '1'); else g.removeAttribute('data-sc-f');
      if ((r.j === 'none' || r.f) && !g.querySelector('.sc-mk')) {
        var p = g.querySelector('.edge-line');
        if (!p || !p.getTotalLength) return;
        var pt = p.getPointAtLength(p.getTotalLength() / 2), m = svg('g', { 'class': 'sc-mk' });
        if (r.j === 'none') { m.appendChild(svg('circle', { 'class': 'ring', cx: pt.x, cy: pt.y, r: 7.5 })); var t = svg('text', { x: pt.x, y: pt.y + 3.6, 'text-anchor': 'middle' }); t.textContent = '?'; m.appendChild(t); }
        else m.appendChild(svg('circle', { 'class': 'dot', cx: pt.x, cy: pt.y, r: 3.6 }));
        g.appendChild(m);
      }
    });
    cv.querySelectorAll('g.node[data-node]').forEach(function (g) {
      var b = D.boxes[g.getAttribute('data-node')];
      if (!b) { g.removeAttribute('data-sc-b'); g.removeAttribute('data-sc-f'); return; }
      if (b.b) g.setAttribute('data-sc-b', b.b); else g.removeAttribute('data-sc-b');
      if (b.f) g.setAttribute('data-sc-f', '1'); else g.removeAttribute('data-sc-f');
      if ((b.b || b.f) && !g.querySelector('.sc-mk')) {
        var r = g.querySelector('.node-box');
        if (!r) return;
        var x = +r.getAttribute('x') + +r.getAttribute('width') - 8, y = +r.getAttribute('y') + 8, m = svg('g', { 'class': 'sc-mk' });
        if (b.b === 'none') { m.appendChild(svg('circle', { 'class': 'ring', cx: x, cy: y, r: 6.5 })); var q = svg('text', { x: x, y: y + 3.2, 'text-anchor': 'middle' }); q.textContent = '?'; m.appendChild(q); }
        else m.appendChild(svg('circle', { 'class': 'dot', cx: x, cy: y, r: 3.2 }));
        g.appendChild(m);
      }
    });
  }
  var timer = null;
  function later() { clearTimeout(timer); timer = setTimeout(mark, 60); }
  new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
  mark();

  sw.addEventListener('click', function () { on = !on; try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {} if (!on) tip.hidden = true; mark(); });
  more.addEventListener('click', function () { about.hidden = !about.hidden; more.setAttribute('aria-expanded', about.hidden ? 'false' : 'true'); bar.classList.toggle('sc-open', !about.hidden); });

  // ---- the tool's words on hover
  function show(item, ev) {
    tip.textContent = '';
    tip.appendChild(h('div', 'sc-head', item.h));
    item.l.forEach(function (t) { tip.appendChild(h('div', t.k === 'words' ? 'sc-words' : t.k === 'tool' ? 'sc-tool' : t.k === 'flag' ? 'sc-flag' : 'sc-line', t.t)); });
    tip.hidden = false;
    var w = tip.offsetWidth, ht = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, ev.clientX + 14)) + 'px';
    tip.style.top = Math.max(8, Math.min(window.innerHeight - ht - 8, ev.clientY + 14)) + 'px';
  }
  document.addEventListener('mousemove', function (ev) {
    if (!on) { tip.hidden = true; return; }
    var t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest('#sc-bar')) { tip.hidden = true; return; }
    var e = t.closest('g.edge[data-edge], g.elabel[data-edge-label]'), n = t.closest('g.node[data-node]');
    var item = e ? D.roads[e.getAttribute('data-edge') || e.getAttribute('data-edge-label')] : n ? D.boxes[n.getAttribute('data-node')] : null;
    if (item) show(item, ev); else tip.hidden = true;
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') tip.hidden = true; });
})();
