/* ================================================================ ZOOM-DEPENDENT TEXT
   Spliced into viewer.js (same closure) by the INCLUDE line near the end of viewer.js. Uses only the FL object documented at the top of viewer.js.
   The rule (docs/DESIGN_BARS.md, whole-system view): no text is ever drawn under 11 screen pixels. Below that it is hidden and the boxes become
   calm shapes by kind (kind colour fill; pills for endings and dashed waits come from the renderer); halos, glowing loops and stage numbers stay.
   How it works: every text class in the map has a size in map units, so its screen size is size * zoom (handle chips and portal badges also grow
   by their own factor). On each zoom change a handful of numbers are compared with the limit and a few classes flip on the svg root; CSS does the
   rest. Nothing is walked per box, so a 400-box chart costs the same as a 20-box one. Its own styles are injected from here (no assembler step). */
(function () {
'use strict';
var MIN = 11;                      // screen px: nothing smaller is ever drawn as text
var TARGET = 11.15;                // chips and portal badges are scaled up to this when they can be (a hair over the limit)
var TEXTS = [['node', '.node-text'], ['elabel', '.elabel-text'], ['ctitle', '.cluster-title'], ['chip', '.chip-text'], ['pbn', '.pb-n']];
var FALLBACK = { node: 15, elabel: 13, ctitle: 13, chip: 11.5, pbn: 10.5 };
var CAP = { chip: 1.54, pbn: 2.6 };  // how much a chip or a portal badge may grow (matches the viewer's own caps, a hair more for the chip)
var Z = null;                      // per-chart state

var css = [
  /* hidden text: one class per kind of text, set on the svg root by update() */
  '.atlas-svg.zt-no-node .node-text,.atlas-svg.zt-no-node .node-tab{display:none!important}',
  '.atlas-svg.zt-no-elabel .edge-labels,.atlas-svg.zt-no-elabel .elabel{display:none!important}',
  '.atlas-svg.zt-no-ctitle .cluster-title{display:none!important}',
  '.atlas-svg.zt-no-chip .chip-text{display:none!important}',
  /* a handle chip never stays on screen once its box has lost its name: a tab with no box text reads as noise */
  '.atlas-svg.zt-no-node .chip{display:none!important}',
  '.atlas-svg.zt-no-pbn .pb-n{display:none!important}',
  /* the whole-system map never carries large names over its boxes: names live in the docked list */
  '.atlas-svg.zt-whole .cl-far{display:none!important}',
  /* chips and portal badges grow as the chart shrinks, up to a cap, so their text stays at the limit as long as it can */
  '.atlas-svg .chip{transform:scale(var(--zt-chip-s,var(--chip-s,1)))}',
  '.atlas-svg .pbadge{transform:scale(var(--zt-pb-s,var(--pb-s,1)))}',
  /* calm shapes: the kind colour, softly filled. Focus colours keep winning (the same four rules the far level uses, one step more specific) */
  '.atlas-svg.zt-calm .node .node-box{fill:var(--cat);fill-opacity:.5;stroke-linejoin:round}',
  '.atlas-svg.zt-calm .node.n-in .node-box{fill:var(--in);fill-opacity:.9}',
  '.atlas-svg.zt-calm .node.n-out .node-box{fill:var(--out);fill-opacity:.9}',
  '.atlas-svg.zt-calm .node.n-path .node-box{fill:var(--path);fill-opacity:.9}',
  '.atlas-svg.zt-calm .node.sel .node-box{fill:var(--sel);fill-opacity:1}',
  /* tiny: a box under a few pixels stays a dot, whatever the zoom (the outline keeps its screen width) */
  '.atlas-svg.zt-tiny .node .node-box{vector-effect:non-scaling-stroke;stroke-width:2.2px;fill-opacity:.85}',
  '.atlas-svg.zt-tiny .node.sel .node-box{stroke-width:3.2px}',
  '.atlas-svg.zt-tiny .edge-line{vector-effect:non-scaling-stroke;stroke-width:1.1px;stroke-opacity:.7}',
  '.atlas-svg.zt-tiny .edge.rel .edge-line{stroke-width:2.4px;stroke-opacity:1}',
  '.atlas-svg.zt-tiny .cluster-box{vector-effect:non-scaling-stroke;stroke-width:1.2px}',
  /* stage numbers, standing in for the stage names while those are hidden (the far level has its own, from the halos) */
  '.atlas-svg .zt-nums{display:none;pointer-events:none}',
  '.atlas-svg.zt-no-ctitle:not(.lod-far):not(.no-htitles) .zt-nums{display:inline}',
  '.atlas-svg .zt-num{fill:var(--a-cl-ink);font-weight:750;letter-spacing:.04em;paint-order:stroke;stroke:var(--a-bg);stroke-width:.24em;stroke-linejoin:round;opacity:.95}',
  '.atlas-svg:has(.htitle.hov,.htitle.sel) .zt-nums{opacity:0}'
].join('\n');
(function () { var s = document.createElement('style'); s.id = 'ztStyle'; s.textContent = css; document.head.appendChild(s); })();

function el(tag, attrs) { var e = document.createElementNS('http://www.w3.org/2000/svg', tag); if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; }
function median(a) { if (!a.length) return 0; a = a.slice().sort(function (x, y) { return x - y; }); return a[a.length >> 1]; }
function baseSize(svg, sel, key) {                       // the text's size in map units, read from the page's own CSS so a renderer change is followed
  var t = svg.querySelector(sel); if (!t) return FALLBACK[key];
  var v = parseFloat(getComputedStyle(t).fontSize); return v > 0 ? v : FALLBACK[key];
}
function numbers(ctx) {
  if (ctx.chart.kind === 'whole') return [];                // the whole map has stage pills and band titles (viewer/whole.js)                                  // stage numbers: the halos' own numbering when the chart has it, else the clusters in order
  var cl = (ctx.chart.geom && ctx.chart.geom.clusters) || [], by = {}, out = [];
  if (ctx.rg && ctx.rg.titles) ctx.rg.titles.forEach(function (t) { if (t.num > 0 && t.r) by[t.r.id] = t.num; });
  cl.forEach(function (c, i) { var n = by[c.id] || (cl.length > 1 ? i + 1 : 0); if (n > 0) out.push({ c: c, n: n }); });
  return out;
}
function mount(ctx) {
  var svg = ctx.svg, base = {}, g = null, nums = [];
  TEXTS.forEach(function (t) { base[t[0]] = baseSize(svg, t[1], t[0]); });
  var ws = [], hs = [];
  Object.keys(ctx.nb).forEach(function (k) { ws.push(ctx.nb[k].w); hs.push(ctx.nb[k].h); });
  var list = numbers(ctx);
  if (list.length) {
    g = el('g', { 'class': 'zt-nums', 'aria-hidden': 'true' });
    list.forEach(function (o) {
      var t = el('text', { 'class': 'zt-num', x: (o.c.x + 6).toFixed(1), y: (o.c.y - 7).toFixed(1), 'font-size': 30 });
      t.textContent = String(o.n); g.appendChild(t); nums.push({ el: t, last: 30 });
    });
    ctx.vp.appendChild(g);
  }
  svg.classList.add('zt'); svg.classList.toggle('zt-whole', ctx.chart.kind === 'whole');
  Z = { ctx: ctx, svg: svg, base: base, on: {}, calm: null, tiny: null, medW: median(ws), medH: median(hs), nums: nums, chipS: null, pbS: null };
  update(FL.scale());
}
function flip(key, hidden) {                             // only touches the DOM when the answer changes
  if (Z.on[key] === hidden) return; Z.on[key] = hidden; Z.svg.classList.toggle('zt-no-' + key, hidden);
}
function update(s) {
  if (!Z || FL.chart() !== Z.ctx) return;
  var svg = Z.svg, b = Z.base, cs, ps, size, mN = FL.minPx('node'), mE = FL.minPx('elabel'), small = FL.small();
  flip('node', b.node * s < mN);
  flip('elabel', b.elabel * s < mE);
  flip('ctitle', b.ctitle * s < MIN && !small);
  if (Z.small !== small) { Z.small = small; svg.classList.toggle('zt-small', small); }
  cs = Math.round(Math.min(CAP.chip, Math.max(1, TARGET / (b.chip * s))) * 50) / 50;
  if (cs !== Z.chipS) { Z.chipS = cs; svg.style.setProperty('--zt-chip-s', cs); }
  flip('chip', b.chip * cs * s < (small ? mN : MIN) - 0.0001);
  ps = Math.round(Math.min(CAP.pbn, Math.max(1, TARGET / (b.pbn * s))) * 50) / 50;
  if (ps !== Z.pbS) { Z.pbS = ps; svg.style.setProperty('--zt-pb-s', ps); }
  flip('pbn', b.pbn * ps * s < (small ? mN : MIN) - 0.0001);
  var calm = b.node * s < mN, tiny = Z.medW * s < 20 || Z.medH * s < 7;
  if (calm !== Z.calm) { Z.calm = calm; svg.classList.toggle('zt-calm', calm); }
  if (tiny !== Z.tiny) { Z.tiny = tiny; svg.classList.toggle('zt-tiny', tiny); }
  captions(s);
  if (Z.nums.length && Z.on.ctitle) {                    // numbers 12 screen px tall, resized only when the zoom moved enough to see it
    var fs = 12 / s;
    Z.nums.forEach(function (n) { if (Math.abs(fs - n.last) / n.last > 0.03) { n.el.setAttribute('font-size', fs.toFixed(1)); n.last = fs; } });
  }
}
function captions(s) {                                   // the far level's large cluster captions (not on the whole map): hide one whose own size is under the limit
  var far = Z.ctx.far || [], i, f, hide;
  for (i = 0; i < far.length; i++) {
    f = far[i]; hide = !!f.last && f.last * s < MIN;
    if (hide !== !!f.zt) { f.zt = hide; f.el.style.display = hide ? 'none' : ''; }
  }
}

FL.onChart(mount);
FL.onZoom(function (s) { update(s); });
})();
