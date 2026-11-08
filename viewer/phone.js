/* The phone (viewer/phone.js, same closure as viewer.js, included last).
   The poster and the whole map are drawings of a dozen stages and hundreds of roads. On a phone-sized screen (narrow, or a phone held sideways) they come out as a clump of
   unnamed bars, so there a plain list of the stages stands where the drawing would be: a number, the name, one plain sentence, and a tap to open that stage's chart.
   The list is built for every window (it is cheap) and phone.css decides when it shows; nothing here measures the window or runs a layout. A chart of one stage keeps its drawing. */
var PHONE = { el: null, key: '', charts: false };
(function () {
  var wrap = $('#canvasWrap'); if (!wrap || !wrap.parentNode) return;
  var sec = document.createElement('section'); sec.id = 'phoneStages'; sec.className = 'ph-stages'; sec.hidden = true; sec.setAttribute('aria-label', 'The stages');
  wrap.parentNode.insertBefore(sec, wrap); PHONE.el = sec;
  sec.addEventListener('click', function (e) {
    var st = e.target.closest ? e.target.closest('[data-ph-stage]') : null;
    if (st) {                                                       // a stage of a tool map: show or hide the functions under it
      var ul = st.nextElementSibling, open = st.getAttribute('aria-expanded') !== 'true';
      if (open && ul && !ul.firstChild) {
        var g = (DATA.nav || []).filter(function (x) { return x.fold && x.stage === st.dataset.phStage; })[0];
        ul.innerHTML = g ? g.rows.concat(g.small).map(function (r) { return '<li><button type="button" class="ph-fn" data-ph-chart="' + esc(r.id) + '"><span class="ph-fnm">' + esc(r.label) + '</span><span class="ph-fnn">' + r.boxes + wBox(r.boxes) + '</span></button></li>'; }).join('') : '';
      }
      st.setAttribute('aria-expanded', open ? 'true' : 'false'); if (ul) ul.hidden = !open;
      return;
    }
    var b = e.target.closest ? e.target.closest('[data-ph-chart]') : null; if (!b || !CH[b.dataset.phChart]) return;
    if (typeof pushJump === 'function') pushJump();
    openChart(b.dataset.phChart, null, { push: true });
    window.scrollTo(0, 0);
  });
})();
function phoneToolRows() {                                          // a tool map draws no chart of a stage: each stage is a row, and a tap lists its functions
  var blurb = {}, no = 0, rows = [];
  (Array.isArray(DATA.stages) ? DATA.stages : []).forEach(function (s) { if (s && s.id && s.blurb) blurb[s.id] = s.blurb; });
  (DATA.nav || []).forEach(function (g) {
    if (!g.fold) return;
    no++;
    var n = g.rows.length + g.small.length;
    rows.push('<li class="ph-st"><button type="button" class="ph-row" data-ph-stage="' + esc(g.stage) + '" aria-expanded="false" style="--sh:' + stageHue(g.stage) + '" aria-label="' + esc(no + '. ' + g.group + '. ' + n + ' functions. Show them.') + '">' +
      '<span class="ph-no" aria-hidden="true">' + no + '</span><span class="ph-main"><b class="ph-nm">' + esc(g.group) + '</b>' + (blurb[g.stage] ? '<span class="ph-bl">' + esc(blurb[g.stage]) + '</span>' : '') +
      '<span class="ph-meta">' + n + (n === 1 ? ' function' : ' functions') + ' with a chart</span></span><span class="ph-go" aria-hidden="true">&rsaquo;</span></button><ul class="ph-fns" hidden></ul></li>');
  });
  return rows;
}
function phoneStageRows() {
  if (META.toolMap) return phoneToolRows();
  var ovId = Object.keys(CH).filter(function (id) { return CH[id].kind === 'overview'; })[0], main = {}, blurb = {};
  if (ovId) strs(CH[ovId].spine).forEach(function (id) { main[id] = 1; });
  (Array.isArray(DATA.stages) ? DATA.stages : []).forEach(function (s) { if (s && s.id && s.blurb) blurb[s.id] = s.blurb; });
  var rows = [];
  STAGE_LIST.forEach(function (sid) {
    var entry = STAGE_CHARTS[sid] ? stageEntry(sid) : ''; if (!entry) return;
    var parts = STAGE_CHARTS[sid].length, bx = stageBoxCount(sid), text = blurb[sid] || (ovId && CH[ovId].nodes[sid] && (CH[ovId].nodes[sid].plain || CH[ovId].nodes[sid].summary)) || '';
    rows.push('<li><button type="button" class="ph-row" data-ph-chart="' + esc(entry) + '" style="--sh:' + stageHue(sid) + '" aria-label="' + esc(stageNo(sid) + '. ' + stageName(sid) + '. Open its chart.') + '">' +
      '<span class="ph-no" aria-hidden="true">' + stageNo(sid) + '</span>' +
      '<span class="ph-main"><b class="ph-nm">' + esc(stageName(sid)) + '</b>' + (text ? '<span class="ph-bl">' + esc(text) + '</span>' : '') +
      '<span class="ph-meta">' + bx + wBox(bx) + ' &middot; ' + parts + (parts === 1 ? ' chart' : ' charts') + (main[sid] ? ' &middot; <span class="ph-on">on the main path</span>' : '') + '</span></span>' +
      '<span class="ph-go" aria-hidden="true">&rsaquo;</span></button></li>');
  });
  PHONE.charts = !rows.length;
  if (!rows.length) {                                                 // a map whose charts carry no stage: its charts themselves, in reading order
    ORDER.filter(function (id) { return CH[id] && (CH[id].kind === 'stage' || CH[id].kind === 'detail'); }).slice(0, 60).forEach(function (cid, i) {
      var c = CH[cid], bx = Object.keys(c.nodes).length;
      rows.push('<li><button type="button" class="ph-row" data-ph-chart="' + esc(cid) + '" style="--sh:' + (200 + (i * 37) % 160) + '" aria-label="' + esc((i + 1) + '. ' + (c.name || c.navLabel || c.title) + '. Open its chart.') + '">' +
        '<span class="ph-no" aria-hidden="true">' + (i + 1) + '</span><span class="ph-main"><b class="ph-nm">' + esc(c.name || c.navLabel || c.title) + '</b>' + (c.navSub ? '<span class="ph-bl">' + esc(c.navSub) + '</span>' : '') +
        '<span class="ph-meta">' + bx + wBox(bx) + '</span></span><span class="ph-go" aria-hidden="true">&rsaquo;</span></button></li>');
    });
  }
  return rows;
}
FL.onChart(function (X) {
  var el = PHONE.el; if (!el) return;
  var kind = X.chart.kind, whole = isWhole(X.chart);
  if (kind !== 'overview' && !whole) { el.hidden = true; el.innerHTML = ''; PHONE.key = ''; return; }
  var key = whole ? 'whole' : 'overview'; el.hidden = false; if (PHONE.key === key) return; PHONE.key = key;
  var rows = phoneStageRows(), sys = DATA.system && DATA.system.name ? DATA.system.name : 'this system';
  var pages = META.toolMap ? toolPagesHTML() : GUIDES.filter(function (x) { return x.top; }).map(function (x) { var cnt = x.count ? x.count() : 0; return '<button type="button" class="hw-page" data-reading="' + x.id + '" title="' + esc(x.title) + '">' + esc(x.label) + ' <b>' + cnt + '</b></button>'; }).join('');
  el.innerHTML = '<p class="ph-lead">' + (whole ? 'The whole map draws every box of ' + esc(sys) + ' at once, which is too much for a phone screen. ' : '') +
    'The full map reads best on a bigger screen. Here are the ' + rows.length + (PHONE.charts ? ' charts' : META.toolMap ? ' stages, largest first' : ' stages in the order the story runs') + '; tap one to ' + (META.toolMap ? 'see its functions.' : 'open its chart.') + '</p>' +
    (pages ? '<p class="ph-pages"><span class="ph-pl">Or read it as pages</span>' + pages + '</p>' : '') +
    '<ol class="ph-list">' + rows.join('') + '</ol>';
});
/* After a tap on a box, its details open under the map, off the screen. A small "Details" button says so and takes you there; it is there only on a phone, only while something is pinned, and only while the details are out of sight. */
(function () {
  var insp = $('#inspector'); if (!insp || !window.IntersectionObserver || !window.matchMedia) return;
  var mq = window.matchMedia('(max-width:800px),(max-height:520px) and (max-width:1000px)'), seen = false;
  var pill = document.createElement('button'); pill.type = 'button'; pill.id = 'phDetails'; pill.className = 'ph-details'; pill.hidden = true;
  pill.setAttribute('aria-label', 'Show the details of the pinned box, under the map'); pill.innerHTML = 'Details <span aria-hidden="true">&darr;</span>';
  document.body.appendChild(pill);
  function sync() { pill.hidden = !(mq.matches && S.sel && !S.reading && !seen && insp.getBoundingClientRect().height > 0); }
  new IntersectionObserver(function (es) { seen = es[es.length - 1].isIntersecting; sync(); }).observe(insp);
  if (window.MutationObserver) new MutationObserver(sync).observe(insp, { childList: true });
  if (mq.addEventListener) mq.addEventListener('change', sync);
  pill.addEventListener('click', function () { insp.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
})();
