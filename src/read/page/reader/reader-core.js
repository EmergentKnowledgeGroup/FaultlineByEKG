/* The Reader, an overlay on a Faultline atlas page: HOME (what it is, what was read, journeys, stages), JOURNEY (a run from an outside trigger, walkable across charts),
   STAGE (its functions), FUNCTION (chart or outline, who calls it, which journeys pass it), TRACE (a call path between two functions, with breaks marked) and SWITCHES.
   Every word and number comes from the embedded reading (#rl-data); the page counts nothing itself. */
(function () {
  'use strict';
  var RL = JSON.parse(document.getElementById('rl-data').textContent);
  var root = document.getElementById('rl'), body = root.querySelector('.rl-body'), crumb = root.querySelector('.rl-crumb');
  var F = RL.fns, ST = RL.stages, J = RL.journeys, OUT = RL.outl, NUM = RL.num;
  var byStage = {}, callers = {}, fnById = {}, chartFn = {}, journeyById = {};
  F.forEach(function (f, ix) {
    f.ix = ix; fnById[f.i] = ix; (byStage[f.g] = byStage[f.g] || []).push(f);
    f.ce.forEach(function (c) { (callers[c] = callers[c] || []).push(ix); });
    f.c.forEach(function (c) { chartFn[c] = ix; });
  });
  J.forEach(function (j) { journeyById[j.id] = j; });
  var MAX_BACK = 40;           // views the Back button remembers
  var FIRST_JOURNEYS = 3;      // journeys listed on the first screen before "All journeys"
  var TILE_LINKS = 3;          // neighbouring stages named on a stage tile
  var CALLS_SHOWN = 5;         // callees named in a function's row
  var ALL_CALLS_SHOWN = 60;    // callees named on a function's own page
  var CALLERS_SHOWN = 30;      // callers named on a function's own page
  var OUTLINE_DEPTH_MAX = 60;  // nesting an outline will draw before it stops (a guard against a cycle)
  var state = { view: 'home', g: 0, q: '', small: false, fn: 0, j: null, back: [], allJ: false, jfull: false, tr: { a: -1, b: -1 } };
  var R = window.__rl = { RL: RL, F: F, ST: ST, J: J, OUT: OUT, state: state, root: root, body: body, chartFn: chartFn, fnById: fnById, callers: callers, journeyById: journeyById, views: {} };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function plural(n, a, b) { return n + ' ' + (n === 1 ? a : (b || a + 's')); }
  var n = ST.length, k = Math.max(1, Math.round(n * 0.382)); function gcd(a, b) { return b ? gcd(b, a % b) : a; } while (n > 1 && gcd(k, n) !== 1) k++;
  function hue(i) { return Math.round((205 + ((i * k) % n) * 360 / Math.max(n, 1)) % 360); }
  function col(i) { return 'hsl(' + hue(i) + ' var(--ss,60%) var(--sl,55%))'; }
  function name(f) { return (f.n || f.q).replace(/<anon@(\d+)>/g, 'anon@$1'); }
  function short(p) { return p.replace(RL.prefix ? RL.prefix + '/' : '', ''); }
  R.esc = esc; R.plural = plural; R.col = col; R.name = name; R.short = short;

  function openChart(chart, node) { if (!chart || !window.atlasOpen) return; hide(); window.atlasOpen(chart, node || null); }
  function place() {   // the Reader covers the work area: under the top bar, right of the chart list
    var t = document.getElementById('top'), nv = document.getElementById('nav'), app = document.getElementById('app');
    var left = nv && app && app.dataset.nav !== 'hidden' && nv.offsetWidth && getComputedStyle(nv).display !== 'none' ? nv.getBoundingClientRect().right : 0;
    root.style.top = (t ? t.getBoundingClientRect().bottom : 48) + 'px'; root.style.left = Math.max(0, left) + 'px';
  }
  function show(view, arg) {
    if (view) { state.view = view; if (view === 'fn') state.fn = +arg; else if (view === 'stage') { state.g = +arg; state.q = ''; state.small = false; } else if (view === 'journey') state.j = arg; }
    place(); root.hidden = false; document.body.classList.add('rl-on'); render();
  }
  function hide() { root.hidden = true; document.body.classList.remove('rl-on'); }
  function crumbs(parts) { crumb.innerHTML = parts.map(function (p) { return p.go ? '<button type="button" class="rl-link" data-go="' + esc(p.go) + '">' + esc(p.t) + '</button>' : '<b>' + esc(p.t) + '</b>'; }).join(' <span class="rl-sep">›</span> '); }
  function go(v, a) {
    state.back.push({ view: state.view, g: state.g, fn: state.fn, j: state.j, q: state.q, small: state.small, tr: state.tr });
    if (state.back.length > MAX_BACK) state.back.shift();
    if (v === 'home') state.view = 'home'; else if (v === 'stage') { state.view = 'stage'; state.g = +a; state.q = ''; state.small = false; } else if (v === 'fn') { state.view = 'fn'; state.fn = +a; } else if (v === 'journey') { state.view = 'journey'; state.j = a; } else state.view = v;
    render();
  }
  function back() { var b = state.back.pop(); if (b) { for (var x in b) state[x] = b[x]; render(); } }
  R.go = go; R.show = show; R.hide = hide; R.openChart = openChart; R.crumbs = crumbs;
  function chip(t) { return '<span class="rl-chip">' + t + '</span>'; }
  function fnLink(ix, label) { var f = F[ix]; return '<button type="button" class="rl-link" data-fn="' + ix + '">' + esc(label || name(f)) + '</button>'; }
  R.chip = chip; R.fnLink = fnLink;

  /* ---------------------------------------------------------------- HOME */
  function purposeBlock() {
    var p = RL.system.purpose || {};
    if (p.text) return '<div class="rl-purpose"><div class="rl-lab">What it is</div><p class="rl-ptext">' + esc(p.text) + '</p><p class="rl-psrc">' + esc(p.source) + '. These are the project\'s own words; this page does not rewrite them.</p></div>';
    return '<div class="rl-purpose"><div class="rl-lab">What it is</div><p class="rl-ptext rl-dim">The project does not say what it is for in its README, its package metadata or a module comment, so this page does not guess.</p><p class="rl-psrc">' + esc(p.note || '') + '</p></div>';
  }
  function listOf(a) { return '<ul class="rl-ul">' + a.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>'; }
  function confLine() {
    var c = RL.conf;
    return '<p class="rl-lead"><b>' + c.boxes + '</b> boxes and <b>' + c.roads + '</b> roads are drawn <span class="rl-nc">dashed with a ?</span> on the charts because the tool is not confident in them. Open one and the Details panel says why. A person or an agent can research those and only those.</p>';
  }
  function endLine(j) {
    var e = j.end || {};
    return e.state === 'ended' ? 'Ends: ' + esc(e.title) + (e.outcome ? ' (' + esc(e.outcome) + ')' : '') : e.state === 'returned' ? 'Ends: ' + esc(e.title) : '<span class="rl-open">Stopped here, no ending reached</span>';
  }
  function journeyRow(j) {
    var s = j.st, main = RL.rank && RL.rank.main && RL.rank.main.id === j.id;
    return '<li class="rl-row"><div class="rl-r1"><button type="button" class="rl-name" data-journey="' + esc(j.id) + '">' + esc(j.name) + '</button>' + (main ? ' <span class="rl-chip rl-main">main path</span>' : '') + '<span class="rl-loc">' + esc(j.trig.where) + '</span></div>' +
      '<div class="rl-r2">' + esc(j.trig.detail) + '</div><div class="rl-r3">' + plural(s.functions, 'function') + ' in ' + plural(s.files, 'file') + ' · ' + plural(s.work, 'place') + ' that write, delete, announce or call out' + (s.breaks ? ' · <span class="rl-open">' + plural(s.breaks, 'break') + '</span>' : '') + ' · ' + endLine(j) + '</div>' +
      '<div class="rl-act">' + (j.ch ? '<button type="button" class="rl-b rl-pri" data-walkj="' + esc(j.id) + '">Walk the short version (' + s.headline + ' steps)</button>' : '') + '<button type="button" class="rl-b" data-journey="' + esc(j.id) + '">Read it</button></div></li>';
  }
  function rankText() {
    var r = RL.rank || {};
    return '<p class="rl-lead"><b>' + (r.main ? 'Main path: ' + esc((R.journeyById[r.main.id] || {}).name || '') + '.' : 'No main path found.') + '</b> ' + (r.main ? 'It is the first journey, ' + esc(r.main.why) + '. ' : '') + 'How they are ordered: ' + esc(r.rule || '') + '</p>';
  }
  function journeysView() {
    crumbs([{ t: RL.system.name, go: 'home' }, { t: 'Journeys' }]);
    var h = '<div class="rl-bar"><h2>Journeys (' + J.length + ')</h2></div>';
    if (!J.length) return void (body.innerHTML = h + '<p class="rl-lead"><b>No main path found.</b> No outside start gave a run that crosses functions, so no journey is shown.</p>');
    h += '<p class="rl-lead">A journey is one run from an outside start (a route, an event, a timer, a command-line start, or exported code nothing in the project calls), followed through the calls it makes. It takes one arm of each decision and never an error arm, so it shows one way through, not every way. Each has a short version of about 20 steps, with the full detail one click down. ' + plural(RL.triggers, 'start') + ' were found; ' + J.length + ' shown, ' + RL.jrejected.rejectedTotal + ' runs rejected as not real journeys (they stayed in one function or were mostly loops over lists written in the code).</p>' + rankText();
    h += '<ul class="rl-list">' + J.map(journeyRow).join('') + '</ul>';
    body.innerHTML = h;
  }
  R.views.journeys = journeysView;
  function home() {
    crumbs([{ t: RL.system.name }]);
    var h = '<h1 class="rl-title">' + esc(RL.system.name) + '</h1>' + (RL.tagline ? '<p class="rl-tag">' + esc(RL.tagline) + '.</p>' : '') + purposeBlock();
    var mainJ = RL.rank && RL.rank.main ? R.journeyById[RL.rank.main.id] : null, rest = mainJ ? J.filter(function (j) { return j !== mainJ; }) : J;
    h += '<h3>Main path</h3>' + rankText() + (mainJ ? '<ul class="rl-list">' + journeyRow(mainJ) + '</ul>' : '');
    h += '<div class="rl-cols"><div><h3>What was read</h3>' + listOf(RL.st.read) + '<h3>What was not read</h3>' + listOf(RL.st.notRead) + '</div><div><h3>What is open</h3>' + listOf(RL.st.open) + confLine() +
      '<div class="rl-act"><button type="button" class="rl-b" data-guide="breaks">Where it can break</button><button type="button" class="rl-b" data-view="fails">How it fails</button><button type="button" class="rl-b" data-view="switches">Off by default</button><button type="button" class="rl-b" data-view="trace">Trace between two functions</button></div></div></div>';
    if (!J.length) h += '<h3>Journeys (0)</h3><p class="rl-lead">No outside start gave a run that crosses functions, so no journey is shown and no start or end is marked on the charts.</p>';
    else if (rest.length) {
      h += '<h3>' + (mainJ ? 'Other journeys (' + rest.length + ')' : 'Journeys (' + J.length + ')') + '</h3><ul class="rl-list">' + rest.slice(0, FIRST_JOURNEYS).map(journeyRow).join('') + '</ul>';
      if (J.length > FIRST_JOURNEYS + (mainJ ? 1 : 0)) h += '<div class="rl-more"><button type="button" class="rl-b" data-view="journeys">All ' + J.length + ' journeys</button></div>';
    }
    h += '<h3>Stages (' + ST.length + ')</h3><p class="rl-lead">A stage is a group of directories (the rule is at the foot of this page), named after the folder or file that holds most of it. The list is largest first (by functions), not in the order things happen.</p><div class="rl-grid">';
    ST.forEach(function (g, i) {
      var lk = function (arr, lab) { return arr.length ? '<div class="rl-lk"><span>' + lab + '</span> ' + arr.slice(0, TILE_LINKS).map(function (p) { return '<button type="button" class="rl-link" data-g="' + p[0] + '">' + esc(ST[p[0]].t) + '</button> ' + p[1]; }).join(', ') + '</div>' : ''; };
      h += '<div class="rl-tile" tabindex="0" data-g="' + i + '" style="--dc:' + col(i) + '"><div class="rl-tt">' + esc(g.t) + '</div><div class="rl-loc rl-sp">' + esc(g.p) + '</div><div class="rl-ab">' + (g.ab ? esc(g.ab) : '<span class="rl-dim">No comment in the code describes this stage.</span>') + '</div><div class="rl-num"><b>' + g.fns + '</b> functions · ' + g.boxes + ' boxes' + (g.ent ? ' · <b>' + g.ent + '</b> with no caller' : '') + '</div>' + lk(g.out, 'calls into') + lk(g.in, 'called from') + '</div>';
    });
    h += '</div>';
    if (RL.gapsTotal) h += '<details class="rl-det"><summary>' + plural(RL.gapsTotal, 'hop') + ' the journeys needed that the map draws no road for</summary><p class="rl-lead">At each of these the scanner resolved a call and the map has no road. The journeys use the scanner\'s call list there, and say so. The first ' + RL.gaps.length + ':</p><ul class="rl-ul">' + RL.gaps.map(function (g) { return '<li><span class="rl-loc">' + esc(g.w) + '</span> ' + esc(g.from) + ' calls ' + esc(g.to) + '</li>'; }).join('') + '</ul></details>';
    h += '<details class="rl-det"><summary>How the stages and charts were chosen</summary><div class="rl-lead">' + esc(RL.rule) + ' ' + esc(RL.rules || '') + '</div></details>';
    body.innerHTML = h;
  }
  R.views.home = home;

  /* ---------------------------------------------------------------- STAGE */
  function sortKey(f) { return [f.cb ? 1 : 0, f.an ? 1 : 0, -f.b, name(f)]; }
  function cmpF(a, b) { var x = sortKey(a), y = sortKey(b); for (var i = 0; i < x.length; i++) { if (x[i] < y[i]) return -1; if (x[i] > y[i]) return 1; } return 0; }
  function callLinks(f, max) {
    var cs = f.ce.slice(0, max || CALLS_SHOWN).map(function (ix) { return fnLink(ix); }).join(', ');
    return cs + (f.ce.length > (max || CALLS_SHOWN) ? ' +' + (f.ce.length - (max || CALLS_SHOWN)) : '');
  }
  function row(f) {
    var h = '<li class="rl-row' + (f.b < 3 ? ' rl-small' : '') + '"><div class="rl-r1"><button type="button" class="rl-name" data-fn="' + f.ix + '">' + esc(name(f)) + '</button><span class="rl-loc">' + esc(short(f.p)) + ':' + f.l + '</span></div>';
    h += '<div class="rl-r2">' + chip(plural(f.b, 'box', 'boxes')) + (f.c.length ? ' ' + chip('drawn chart') : '') + '</div>';
    h += '<div class="rl-r3"><span class="' + (f.cb ? '' : 'rl-em') + '">' + (f.cb ? 'called from ' + plural(f.cb, 'place') : 'no caller found in the code') + '</span>' + (f.oc ? ' · <span class="rl-open">' + plural(f.oc, 'call') + ' not followed</span>' : '') + '</div>';
    if (f.ce.length) h += '<div class="rl-r4"><span class="rl-lab">calls</span> ' + callLinks(f) + '</div>';
    h += '<div class="rl-act">' + (f.c.length ? '<button type="button" class="rl-b" data-chart="' + f.ix + '">Open chart</button>' : '') + '<button type="button" class="rl-b" data-fn="' + f.ix + '">' + (f.c.length ? 'Details' : 'Outline') + '</button></div></li>';
    return h + '</li>';
  }
  function stage() {
    var g = ST[state.g], fl = (byStage[state.g] || []).slice().sort(cmpF), q = state.q.toLowerCase();
    crumbs([{ t: RL.system.name, go: 'home' }, { t: g.t }]);
    var match = function (f) { return !q || (name(f) + ' ' + f.p).toLowerCase().indexOf(q) >= 0; };
    var big = fl.filter(function (f) { return f.b >= 3 && match(f); }), small = fl.filter(function (f) { return f.b < 3 && match(f); });
    var ent = big.filter(function (f) { return !f.cb; }), rest = big.filter(function (f) { return f.cb; });
    var h = '<div class="rl-bar" style="--dc:' + col(state.g) + '"><h2>' + esc(g.t) + '</h2><span class="rl-loc">' + esc(g.p) + '</span><span class="rl-num">' + g.fns + ' functions · ' + g.boxes + ' boxes · ' + g.ent + ' with no caller</span><input type="search" class="rl-q" placeholder="Filter by name or file" value="' + esc(state.q) + '" aria-label="Filter the functions"></div>' +
      '<p class="rl-lead">' + (g.ab ? esc(g.ab) + ' <span class="rl-dim">(From ' + esc(g.abf) + '.)</span>' : '<span class="rl-dim">No comment in the code describes this stage.</span>') + '</p><p class="rl-lead">Functions that nothing in the code calls come first (a callback or a dynamic call is not seen, and the row says so), then the functions called from elsewhere, biggest first. Functions of one or two boxes are hidden behind a count: they are a line or two and show up as cards on the charts of their callers.</p>';
    h += '<h3>No caller found (' + ent.length + ')</h3><ul class="rl-list">' + (ent.map(row).join('') || '<li class="rl-none">none with 3 or more boxes</li>') + '</ul>';
    h += '<h3>Called from elsewhere (' + rest.length + ')</h3><ul class="rl-list">' + (rest.map(row).join('') || '<li class="rl-none">none</li>') + '</ul>';
    h += '<div class="rl-more">' + (small.length ? '<button type="button" class="rl-b" data-small="' + (state.small ? 0 : 1) + '">' + (state.small ? 'Hide the ' + small.length + ' small functions' : plural(small.length, 'small function') + ' (1 or 2 boxes) hidden. Show them') + '</button>' : '<span class="rl-none">no small functions' + (q ? ' match' : '') + '</span>') + '</div>';
    if (state.small) h += '<ul class="rl-list">' + small.map(row).join('') + '</ul>';
    body.innerHTML = h;
    var inp = body.querySelector('.rl-q');
    inp.addEventListener('input', function () { state.q = inp.value; var pos = inp.selectionStart; stage(); var n2 = body.querySelector('.rl-q'); n2.focus(); n2.setSelectionRange(pos, pos); });
  }
  R.views.stage = stage;

  /* ---------------------------------------------------------------- FUNCTION */
  var KW = { decision: 'decision', end: 'ending', step: 'step', store: 'store', wait: 'wait', external: 'outside', loop: 'loop', open: 'continues' };
  function outlineHtml(ix) {
    var o = OUT[ix], B = o.b, Rd = o.r, kids = B.map(function () { return []; }), seen = {};
    Rd.forEach(function (r) { kids[r[0]].push(r); });
    function line(i, when, inf, backTo) {
      var b = B[i], c = b[3] >= 0 ? F[b[3]] : null, shape = b[4];
      var t = c ? '<button type="button" class="rl-link" data-fn="' + b[3] + '">→ ' + esc(name(c)) + '</button>' : esc(b[1]);
      var kind = shape === 'open' ? 'continues' : (KW[b[0]] || 'step');
      return '<div class="rl-ol"><span class="rl-kind rl-k-' + esc(b[0]) + '">' + kind + '</span> ' + (when ? '<span class="rl-when' + (inf ? ' rl-inf' : '') + '">' + esc(when) + (inf ? ' ?' : '') + '</span> ' : '') + (backTo ? '<span class="rl-back2">continues at</span> ' : '') + '<span class="rl-t">' + t + '</span>' + (b[2] ? ' <span class="rl-loc">line ' + b[2] + '</span>' : '') + '</div>';
    }
    function node(i, when, inf, depth) {
      if (seen[i]) return '<li>' + line(i, when, inf, true) + '</li>';
      seen[i] = 1;
      var h = '<li>' + line(i, when, inf, false), ks = kids[i];
      if (ks.length && depth < OUTLINE_DEPTH_MAX) h += '<ul>' + ks.map(function (r) { return node(r[1], r[2] || (ks.length > 1 ? 'then' : ''), r[3], depth + 1); }).join('') + '</ul>';
      return h + '</li>';
    }
    var hasIn = {}; Rd.forEach(function (r) { hasIn[r[1]] = 1; });
    var starts = B.map(function (_, i) { return i; }).filter(function (i) { return !hasIn[i]; });
    var h = '<ul class="rl-tree">' + (starts.length ? starts : [0]).map(function (i) { return node(i, '', 0, 0); }).join('') + '</ul>';
    var left = B.map(function (_, i) { return i; }).filter(function (i) { return !seen[i]; });
    if (left.length) h += '<ul class="rl-tree">' + left.map(function (i) { return node(i, '', 0, 0); }).join('') + '</ul>';
    return h;
  }
  function fnView() {
    var f = F[state.fn], g = ST[f.g], o = OUT[state.fn], cs = callers[state.fn] || [];
    crumbs([{ t: RL.system.name, go: 'home' }, { t: g.t, go: 'stage:' + f.g }, { t: name(f) }]);
    var h = '<div class="rl-bar" style="--dc:' + col(f.g) + '"><h2>' + esc(name(f)) + '</h2><span class="rl-loc">' + esc(f.p) + ':' + f.l + '</span></div>';
    h += '<p class="rl-lead">' + chip(plural(f.b, 'box', 'boxes')) + ' ' + (f.cb ? 'Called from ' + plural(f.cb, 'place') + '.' : 'No caller was found in the code: it may be an entry point, called from outside, called dynamically, or unused.') + (f.oc ? ' <span class="rl-open">' + plural(f.oc, 'call') + ' not followed: the function carries on there and the tool does not say where.</span>' : '') + '</p>';
    h += '<div class="rl-act">' + (f.c.length ? f.c.map(function (c, i) { return '<button type="button" class="rl-b rl-pri" data-open="' + esc(c) + '">' + (f.c.length > 1 ? 'Open chart, part ' + (i + 1) + ' of ' + f.c.length : 'Open the drawn chart') + '</button>'; }).join('') : '<span class="rl-none">No drawn chart: ' + (f.b < 2 ? 'it has one box or none.' : 'charts are drawn for the functions on a journey and then the biggest, within a budget; this one is not among them, so the outline below is all of it.') + '</span>') + '<button type="button" class="rl-b" data-trace="' + f.ix + '">Trace from here</button></div>';
    if (f.j && f.j.length) h += '<h3>Journeys that pass through it (' + f.j.length + ')</h3><div class="rl-r4">' + f.j.map(function (id) { return '<button type="button" class="rl-link" data-journey="' + esc(id) + '">' + esc(journeyById[id].name) + '</button>'; }).join(', ') + '</div>';
    if (o && o.b.length) h += '<h3>Outline (' + plural(o.b.length, 'line') + ', in the order the code runs; a road marked ? is one the tool could not prove)</h3>' + outlineHtml(state.fn);
    else if (!f.c.length) h += '<p class="rl-none">This function has no box of its own: it only calls other functions, or it was not reduced. Its calls are below.</p>';
    if (f.ce.length) h += '<h3>Calls (' + f.ce.length + ')</h3><div class="rl-r4">' + callLinks(f, ALL_CALLS_SHOWN) + '</div>';
    if (cs.length) h += '<h3>Called from (' + cs.length + ')</h3><div class="rl-r4">' + cs.slice(0, CALLERS_SHOWN).map(function (ix) { return fnLink(ix); }).join(', ') + (cs.length > CALLERS_SHOWN ? ' +' + (cs.length - CALLERS_SHOWN) : '') + '</div>';
    body.innerHTML = h;
  }
  R.views.fn = fnView;

  function render() {
    var v = R.views[state.view] || home;
    v();
    body.scrollTop = 0;
    var bb = root.querySelector('.rl-back'); if (bb) bb.hidden = !state.back.length;
    root.dataset.view = state.view;
  }
  R.render = render;
  R.openGuide = function (id) { hide(); var b = document.querySelector('.nav-item[data-reading="' + id + '"], .hw-page[data-reading="' + id + '"]'); if (b) b.click(); };
  window.readerOpen = show; window.readerHide = hide;
})();
