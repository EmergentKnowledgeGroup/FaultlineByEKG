/* Reader part 2: journeys (read and walk across charts), the call-path trace, switches, the walk bar and the page wiring. Needs reader-core.js (window.__rl). */
(function () {
  'use strict';
  var R = window.__rl, RL = R.RL, F = R.F, J = R.J, state = R.state, body = R.body, root = R.root, esc = R.esc, plural = R.plural, name = R.name, chip = R.chip, fnLink = R.fnLink, crumbs = R.crumbs;

  /* ---------------------------------------------------------------- JOURNEY */
  var INDENT_DEPTH_MAX = 8;   // a journey step is indented by its call depth, up to this many levels
  var INDENT_PX = 18;
  var RESULTS_SHOWN = 8;      // functions offered while typing in the trace boxes
  var ROWS_PER_PAGE = 100;    // failing endings drawn before "show more"
  var MARK = { e: 'enters', d: 'decision', l: 'loop', x: 'does work', w: 'waits', n: 'ends', s: 'step', ch: 'one of', f: 'calls', b: 'break', t: '', fin: '' };
  function stepHtml(s, i, j, short) {
    var dd = short ? (s.hd || 0) : s.d;
    var pad = 'style="margin-left:' + Math.min(dd, INDENT_DEPTH_MAX) * INDENT_PX + 'px"', h, cls = 'rl-js rl-jk-' + s.k;
    var show = (s.c ? '<button type="button" class="rl-b rl-sm" data-st="' + i + '" data-j="' + esc(j.id) + '" data-short="' + (short ? 1 : 0) + '">Show on the chart</button>' : '');
    var at = ' data-sti="' + i + '"';
    if (s.k === 't') return '<li class="' + cls + '" ' + pad + at + '><span class="rl-dim">' + esc(s.t) + '</span></li>';
    if (s.k === 'fin') return '<li class="' + cls + ' rl-fin-' + esc(s.st) + '" ' + pad + at + '><span class="rl-kind ' + (s.st === 'stopped' ? 'rl-open' : '') + '">' + (s.st === 'stopped' ? 'stopped' : 'ends') + '</span> <b>' + esc(s.t) + '</b> <span class="rl-dim">' + esc(s.p) + '</span></li>';
    if (s.k === 'e') {
      h = '<span class="rl-kind">' + (short && s.ci ? 'calls' : 'enters') + '</span> ' + (s.f !== undefined ? '<button type="button" class="rl-link" data-fn="' + s.f + '">' + esc(s.t) + '</button>' : esc(s.t)) + ' <span class="rl-loc">' + esc(s.w) + '</span>' + (s.v ? ' <span class="rl-via">' + esc(s.v) + '</span>' : '') + (s.s ? ' <span class="rl-open">' + esc(s.s) + '</span>' : '') + (s.c ? '' : ' <span class="rl-dim">no chart</span>') +
        (short && s.ci ? ' <button type="button" class="rl-link rl-more-in" data-full="' + i + '">' + plural(s.ci, 'step') + ' inside</button>' : '') + (!short && s.mo ? ' <span class="rl-dim">(' + plural(s.mo, 'box', 'boxes') + ' of it not listed)</span>' : '');
    } else if (s.k === 'ch') h = '<span class="rl-kind">calls one of</span> ' + s.o.map(esc).join(' <span class="rl-dim">or</span> ') + (s.n ? ' and ' + s.n + ' more' : '') + ' <span class="rl-dim">(line ' + s.l + '; the tool could not tell which, so none is followed as the one)</span>';
    else if (s.k === 'f') h = '<span class="rl-kind">calls</span> ' + (s.f !== undefined ? '<button type="button" class="rl-link" data-fn="' + s.f + '">' + esc(s.t) + '</button>' : esc(s.t)) + ' <span class="rl-dim">(' + plural(s.n, 'step') + ' not listed here; line ' + s.l + ')</span>';
    else if (s.k === 'b') h = '<span class="rl-kind rl-open">break</span> <span class="rl-open">' + esc(s.t) + '</span> <span class="rl-dim">(line ' + s.l + (s.g ? '; the map has no road here' : '') + ')</span>';
    else h = '<span class="rl-kind rl-k-' + s.k + '">' + MARK[s.k] + '</span> ' + (s.o ? '<span class="rl-when">' + esc(s.o) + '</span> ' : '') + esc(s.t) + (s.l ? ' <span class="rl-loc">line ' + s.l + '</span>' : '') + (s.u ? ' <span class="rl-chip">' + esc(s.u) + '</span>' : '') + (s.fi ? ' <span class="rl-chip rl-final">the ending</span>' : '') + (s.a ? ' <span class="rl-dim">other way: ' + s.a.map(esc).join('; ') + '</span>' : '');
    return '<li class="' + cls + '" ' + pad + at + '>' + h + ' ' + show + '</li>';
  }
  function endBlock(j) {
    var e = j.end || {};
    if (e.state === 'ended') return '<p class="rl-lead"><b>How it ends:</b> ' + esc(e.title) + (e.outcome ? ' <span class="rl-chip">' + esc(e.outcome) + '</span>' : '') + '. This is the ending on this run\'s own route, not a shared box.</p>';
    if (e.state === 'returned') return '<p class="rl-lead"><b>How it ends:</b> ' + esc(e.title) + '. ' + esc(e.plain || '') + '</p>';
    return '<p class="rl-lead"><b class="rl-open">Stopped here, no ending reached.</b> ' + esc(e.plain || e.title || '') + '</p>';
  }
  function journey() {
    var j = R.journeyById[state.j] || J[0];
    if (!j) { body.innerHTML = '<p class="rl-none">No journey.</p>'; return; }
    crumbs([{ t: RL.system.name, go: 'home' }, { t: 'Journeys', go: 'journeys' }, { t: j.name }]);
    var s = j.st, full = !!state.jfull, main = RL.rank && RL.rank.main && RL.rank.main.id === j.id;
    var h = '<div class="rl-bar"><h2>' + esc(j.name) + '</h2>' + (main ? '<span class="rl-chip rl-main">main path</span>' : '') + '<span class="rl-loc">' + esc(j.trig.where) + '</span></div>';
    h += '<p class="rl-lead"><b>' + esc(j.trig.detail) + '.</b> It reaches ' + plural(s.functions, 'function') + ' in ' + plural(s.files, 'file') + ' and passes ' + plural(s.work, 'place') + ' that write, delete, announce or call out. ' +
      (s.breaks ? '<span class="rl-open">' + plural(s.breaks, 'break') + ' where the run cannot be followed.</span> ' : 'It has no break: every call on it was followed. ') + (s.gaps ? plural(s.gaps, 'hop') + ' come from the scanner call list because the map draws no road there. ' : '') +
      'It takes one arm of each decision and never an error arm.</p>' + endBlock(j);
    h += '<div class="rl-act">' + (j.ch ? '<button type="button" class="rl-b rl-pri" data-walkj="' + esc(j.id) + '">Walk the short version (' + s.headline + ' steps)</button><button type="button" class="rl-b" data-walkfull="' + esc(j.id) + '">Walk all ' + j.steps.length + ' steps</button>' : '<span class="rl-dim">No step of this journey is drawn on a chart, so there is nothing to walk on the page.</span> ') + '<button type="button" class="rl-b" data-jmode="' + (full ? 0 : 1) + '">' + (full ? 'Show the short version' : 'Show all ' + j.steps.length + ' steps') + '</button></div>';
    h += '<h3>' + (full ? 'The full detail (' + j.steps.length + ' steps)' : 'The short version (' + s.headline + ' of ' + j.steps.length + ' steps; calls that only help are folded into one line)') + '</h3>';
    h += '<ol class="rl-jlist">' + j.steps.map(function (st, i) { return (full || st.h) ? stepHtml(st, i, j, !full) : ''; }).join('') + '</ol>';
    body.innerHTML = h;
  }
  R.views.journey = journey;

  /* ---------------------------------------------------------------- the walk bar: a journey, step by step, across charts */
  var bar = document.createElement('div');
  bar.id = 'rlWalk'; bar.className = 'rl-walk'; bar.hidden = true; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Walking a journey step by step');
  bar.innerHTML = '<button type="button" class="rl-wb" data-wk="prev" aria-label="Previous step">&lsaquo;</button><div class="rl-wbody" aria-live="polite"></div><button type="button" class="rl-wb" data-wk="next" aria-label="Next step">&rsaquo;</button><button type="button" class="rl-wl" data-wk="mode" title="Switch between the short version and the full detail">Full detail</button><button type="button" class="rl-wl" data-wk="list" title="The journey as a list">List</button><button type="button" class="rl-wl" data-wk="stop" aria-label="Stop walking" title="Stop walking">&times;</button><div class="rl-wprog" aria-hidden="true"><i></i></div>';
  document.body.appendChild(bar);
  var W = { j: null, i: 0, idx: [], full: false };
  function walkIdx(j, full) { var a = []; j.steps.forEach(function (s, i) { if (full ? s.k !== 't' : s.h) a.push(i); }); return a; }
  function stepText(s) {
    if (s.k === 'e') return '<b>' + (s.ci ? 'Calls ' : 'Enters ') + esc(s.t) + '</b> <span class="rl-loc">' + esc(s.w) + '</span>' + (s.ci ? ' <span class="rl-dim">(' + plural(s.ci, 'step') + ' inside, in the full detail)</span>' : '') + (s.v ? '<br><span class="rl-dim">' + esc(s.v) + '</span>' : '') + (s.s ? '<br><span class="rl-open">' + esc(s.s) + '</span>' : '');
    if (s.k === 'fin') return '<b' + (s.st === 'stopped' ? ' class="rl-open"' : '') + '>' + esc(s.t) + '</b><br><span class="rl-dim">' + esc(s.p) + '</span>';
    if (s.k === 'b') return '<b class="rl-open">Break: ' + esc(s.t) + '</b> <span class="rl-dim">line ' + s.l + (s.g ? '. The map has no road here; the journey stops following this call.' : '.') + '</span>';
    if (s.k === 'ch') return '<b>Calls one of ' + s.o.map(esc).join(' or ') + '</b><br><span class="rl-dim">The tool could not tell which, so none is followed as the one.</span>';
    if (s.k === 'f') return '<b>Calls ' + esc(s.t) + '</b> <span class="rl-dim">(' + plural(s.n, 'step') + ' not listed)</span>';
    return '<b>' + MARK[s.k][0].toUpperCase() + MARK[s.k].slice(1) + ': ' + esc(s.t) + '</b>' + (s.o ? ' <span class="rl-when">' + esc(s.o) + '</span>' : '') + (s.fi ? ' <span class="rl-chip rl-final">the ending</span>' : '') + (s.a ? '<br><span class="rl-dim">other way: ' + s.a.map(esc).join('; ') + '</span>' : '');
  }
  function walkDraw() {
    var j = W.j, s = j.steps[W.idx[W.i]], on = s.c ? '' : ' <span class="rl-dim">· not on a chart: the call is read from the call list</span>';
    bar.querySelector('.rl-wbody').innerHTML = '<span class="rl-wpos">' + esc(j.name) + ' · step ' + (W.i + 1) + ' of ' + W.idx.length + ' · ' + (W.full ? 'full detail' : 'short version') + '</span>' + stepText(s) + on;
    bar.querySelector('.rl-wprog i').style.width = Math.round(((W.i + 1) / W.idx.length) * 100) + '%';
    bar.querySelector('[data-wk=prev]').disabled = W.i === 0; bar.querySelector('[data-wk=next]').disabled = W.i === W.idx.length - 1;
    bar.querySelector('[data-wk=mode]').textContent = W.full ? 'Short version' : 'Full detail';
    bar.dataset.kind = s.k;
  }
  function clearHighlight() {      // a step that is not on a chart leaves no box lit on the chart that was open
    try { var I = window.atlasInspect && window.atlasInspect(); if (I && I.chart && I.pinned && window.atlasOpen) window.atlasOpen(I.chart, null); } catch (err) { /* nothing to clear */ }
  }
  function walkGo(i) {
    W.i = Math.max(0, Math.min(W.idx.length - 1, i));
    var s = W.j.steps[W.idx[W.i]];
    if (s.c && window.atlasOpen) window.atlasOpen(s.c, s.b || null); else clearHighlight();
    walkDraw();
  }
  function walkStart(id, at, full) {
    var j = R.journeyById[id]; if (!j) return;
    W.j = j; W.full = !!full; W.idx = walkIdx(j, W.full);
    var first = 0;
    if (at != null) { first = W.idx.indexOf(at); if (first < 0) first = Math.max(0, W.idx.findIndex(function (x) { return x >= at; })); }
    R.hide(); bar.hidden = false; document.body.classList.add('rl-walking'); walkGo(first);
  }
  function walkMode() {
    var cur = W.idx[W.i]; W.full = !W.full; W.idx = walkIdx(W.j, W.full);
    var p = W.idx.findIndex(function (x) { return x >= cur; }); walkGo(p < 0 ? W.idx.length - 1 : p);
  }
  function walkStop() { bar.hidden = true; document.body.classList.remove('rl-walking'); }
  bar.addEventListener('click', function (e) {
    var b = e.target.closest('[data-wk]'); if (!b) return;
    if (b.dataset.wk === 'prev') walkGo(W.i - 1); else if (b.dataset.wk === 'next') walkGo(W.i + 1); else if (b.dataset.wk === 'stop') walkStop(); else if (b.dataset.wk === 'mode') walkMode(); else if (b.dataset.wk === 'list') { walkStop(); R.show('journey', W.j.id); }
  });
  R.walkStart = walkStart;

  /* ---------------------------------------------------------------- TRACE: a call path between two functions, breaks marked */
  function find(q) {
    q = q.trim().toLowerCase(); if (!q) return [];
    var a = [], b = [];
    F.forEach(function (f) { var n = name(f).toLowerCase(); if (n === q || n.indexOf(q) === 0) a.push(f); else if (n.indexOf(q) >= 0 || f.p.toLowerCase().indexOf(q) >= 0) b.push(f); });
    return a.concat(b).slice(0, RESULTS_SHOWN);
  }
  var scanAdj = null;   // calls the scanner resolved where the map draws no road (the hops journeys had to borrow): [to, where]
  function scanOf(x) { if (!scanAdj) { scanAdj = {}; (RL.scan || []).forEach(function (g) { (scanAdj[g[0]] = scanAdj[g[0]] || []).push([g[1], g[2]]); }); } return scanAdj[x] || []; }
  function bfs(from, to) {
    var prev = {}, how = {}, q = [from], seen = {}; seen[from] = 1;
    while (q.length) {
      var x = q.shift(); if (x === to) break;
      F[x].ce.forEach(function (y) { if (!seen[y]) { seen[y] = 1; prev[y] = x; how[y] = ''; q.push(y); } });
      scanOf(x).forEach(function (g) { if (!seen[g[0]]) { seen[g[0]] = 1; prev[g[0]] = x; how[g[0]] = g[1]; q.push(g[0]); } });
    }
    if (!seen[to]) return { path: null, seen: seen };
    var p = [to]; while (p[0] !== from) p.unshift(prev[p[0]]);
    return { path: p, seen: seen, how: how };
  }
  function openIn(seen) { var n = 0, fns = 0; Object.keys(seen).forEach(function (x) { fns++; n += F[x].oc || 0; }); return { fns: fns, calls: n }; }
  function chainHtml(p, how) {
    return '<ol class="rl-chain">' + p.map(function (x, i) { var f = F[x]; return '<li>' + (i ? '<span class="rl-dim">calls</span> ' : '<span class="rl-dim">starts at</span> ') + fnLink(x) + ' <span class="rl-loc">' + esc(f.p) + ':' + f.l + '</span> ' + (f.c.length ? '<button type="button" class="rl-b rl-sm" data-open="' + esc(f.c[0]) + '">chart</button>' : '<span class="rl-dim">no chart</span>') + (i && how && how[x] ? ' <span class="rl-via">' + esc(how[x]) + '</span>' : '') + '</li>'; }).join('') + '</ol>';
  }
  function traceResult() {
    var a = state.tr.a, b = state.tr.b, el = body.querySelector('.rl-tres'); if (!el) return;
    if (a < 0 || b < 0) { el.innerHTML = '<p class="rl-none">Choose both ends.</p>'; return; }
    if (a === b) { el.innerHTML = '<p class="rl-none">Choose two different functions.</p>'; return; }
    var r = bfs(a, b), h;
    if (r.path) h = '<p class="rl-lead"><b>A call path of ' + plural(r.path.length - 1, 'call') + '.</b> The shortest one found; there may be others. Each step is a call the map draws (a road it marked "may call" is a guess, not a proof), a call the scanner found where the map draws no road, or a function passed to another that runs it; those are marked.</p>' + chainHtml(r.path, r.how);
    else {
      var o = openIn(r.seen), rb = bfs(b, a);
      h = '<p class="rl-lead"><b class="rl-open">Break: no call path found from ' + esc(name(F[a])) + ' to ' + esc(name(F[b])) + '.</b> From ' + esc(name(F[a])) + ' the map reaches ' + plural(o.fns - 1, 'other function') + '. ' + (o.calls ? 'Those functions have <b>' + o.calls + '</b> calls the tool could not follow (drawn as "continues" markers on their charts), so a path may exist through code it could not see.' : 'None of them has an unfollowed call, so the map says there is no path.') + '</p>';
      if (rb.path) h += '<p class="rl-lead">The other way round there is one, from ' + esc(name(F[b])) + ' to ' + esc(name(F[a])) + ':</p>' + chainHtml(rb.path, rb.how);
    }
    el.innerHTML = h;
  }
  function pickBlock(side, label) {
    var f = state.tr[side] >= 0 ? F[state.tr[side]] : null;
    return '<div class="rl-pick" data-side="' + side + '"><label class="rl-lab">' + label + '</label>' + (f ? '<div class="rl-picked"><b>' + esc(name(f)) + '</b> <span class="rl-loc">' + esc(f.p) + ':' + f.l + '</span> <button type="button" class="rl-b rl-sm" data-trclr="' + side + '">change</button></div>' : '<input type="search" class="rl-q rl-trin" data-side="' + side + '" placeholder="Type a function name" autocomplete="off"><div class="rl-res"></div>') + '</div>';
  }
  function trace() {
    crumbs([{ t: RL.system.name, go: 'home' }, { t: 'Trace between two functions' }]);
    body.innerHTML = '<div class="rl-bar"><h2>Trace between two functions</h2></div><p class="rl-lead">Follows the calls the map draws from one function to another, across charts and files. When there is no path it says where the break is: how many calls the tool could not follow on the way. It reads calls, not data, so it says nothing about what the functions pass to each other.</p>' +
      '<div class="rl-picks">' + pickBlock('a', 'From') + pickBlock('b', 'To') + '</div><div class="rl-tres"></div>';
    traceResult();
  }
  R.views.trace = trace;
  body.addEventListener('input', function (e) {
    var i = e.target.closest('.rl-trin'); if (!i) return;
    var res = i.parentNode.querySelector('.rl-res'), list = find(i.value);
    res.innerHTML = list.length ? list.map(function (f) { return '<button type="button" class="rl-r" data-trpick="' + f.ix + '" data-side="' + i.dataset.side + '"><b>' + esc(name(f)) + '</b> <span class="rl-loc">' + esc(f.p) + ':' + f.l + '</span></button>'; }).join('') : (i.value.trim() ? '<div class="rl-none">No function matches.</div>' : '');
  });
  window.readerTrace = function (fa, fb) {
    var a = R.fnById[fa], b = R.fnById[fb];
    if (a === undefined || b === undefined) return false;
    state.tr = { a: a, b: b }; R.show('trace'); return true;
  };

  /* ---------------------------------------------------------------- SWITCHES */
  function switches() {
    crumbs([{ t: RL.system.name, go: 'home' }, { t: 'Off by default' }]);
    var I = RL.swInfo, S = RL.switches.slice().sort(function (x, y) { return (y.off ? 1 : 0) - (x.off ? 1 : 0) || y.n - x.n || (x.name < y.name ? -1 : 1); });
    var offs = S.filter(function (x) { return x.off; }), names = offs.slice(0, 8).map(function (x) { return '<code>' + esc(x.name) + '</code>'; }).join(', ');
    var h = '<div class="rl-bar"><h2>Off by default</h2></div><p class="rl-lead rl-answer"><b>' + (offs.length ? plural(offs.length, 'setting is', 'settings are') + ' off by default' : 'None of the ' + I.count + ' switches found is shown to be off by default') + '</b>' + (offs.length ? ': ' + names + (offs.length > 8 ? ' and ' + (offs.length - 8) + ' more' : '') : '') + '. Off means the name says a feature is on or off (enabled, disabled, skip, allow, auto) and the code gives the default that turns it off.</p>';
    h += '<p class="rl-lead">Of <b>' + I.count + '</b> switches found: <b>' + I.off + '</b> off by default; <b>' + I.falsy + '</b> default to false, none, or zero, but the name does not say whether that means off (listed as <i>default false</i>, not counted as off); <b>' + I.on + '</b> default to on; ' + (I.count - I.off - I.falsy - I.on - I.notRead > 0 ? '<b>' + (I.count - I.off - I.falsy - I.on - I.notRead) + '</b> default to a value that is neither on nor off; ' : '') + '<b>' + I.notRead + '</b> have no default the tool could read. It says so rather than guessing.</p>';
    h += '<ul class="rl-ul rl-cant">' + I.cannotSee.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
    var row = function (s) {
      var d = s.def ? 'default <code>' + esc(s.def.literal) + '</code> <span class="rl-loc">' + esc(s.def.path) + ':' + s.def.line + '</span>' : '<span class="rl-dim">' + esc(s.note || 'default not read') + '</span>';
      return '<li class="rl-row"><div class="rl-r1"><b>' + esc(s.name) + '</b> ' + chip(esc(s.kind)) + (s.off ? ' <span class="rl-chip rl-off">off by default</span>' : s.di === 'falsy' ? ' <span class="rl-chip">default false (not shown to mean off)</span>' : '') + '</div><div class="rl-r2">' + d + ' · tested in ' + plural(s.n, 'place') + '</div>' +
        '<div class="rl-r4">' + s.uses.map(function (u) { return '<div class="rl-use"><span class="rl-loc">' + esc(u.path) + ':' + u.line + '</span> <code>' + esc(u.test) + '</code> ' + (u.part ? '<button type="button" class="rl-b rl-sm" data-chartbox="' + esc(u.part) + '" data-box="' + esc(u.b) + '">on the chart</button>' : u.f >= 0 ? '<button type="button" class="rl-b rl-sm" data-fn="' + u.f + '">function</button>' : '') + '</div>'; }).join('') + (s.n > s.uses.length ? '<div class="rl-dim">and ' + (s.n - s.uses.length) + ' more</div>' : '') + '</div></li>';
    };
    var grp = function (title, pred, open) {
      var a = S.filter(pred);
      return a.length ? '<details class="rl-det"' + (open ? ' open' : '') + '><summary>' + esc(title) + ' (' + a.length + ')</summary><ul class="rl-list">' + a.map(row).join('') + '</ul></details>' : '';
    };
    h += grp('Off by default', function (s) { return s.off; }, true) + grp('Default false, none or zero (the name does not say that means off)', function (s) { return !s.off && s.di === 'falsy'; }, true) + grp('On by default, or another value', function (s) { return s.di === 'on' || s.di === 'value'; }, false) + grp('Default not read', function (s) { return s.di === 'unread'; }, false);
    body.innerHTML = h;
  }
  R.views.switches = switches;


  /* ---------------------------------------------------------------- HOW IT FAILS: every failing ending, by who hears about it */
  var BYWORD = { person: 'a person', client: 'the client that asked (HTTP status)', caller: 'the caller', event: 'an event listener', log: 'the error output', someone: 'someone (a handler reports it)', nobody: 'nobody (the tool is sure)', unknown: 'not known from the code' };
  var FL = { by: '*', oc: '*', n: ROWS_PER_PAGE, q: '' };
  function failGroups(rows) {
    var m = {}, out = [];
    rows.forEach(function (r) {
      var k = [r.fn, r.t, r.o, r.status, r.route, r.h.value, r.p].join('|');
      if (!m[k]) { m[k] = { r: r, lines: [] }; out.push(m[k]); }
      m[k].lines.push(r.w);
    });
    return out;
  }
  function fails() {
    crumbs([{ t: RL.system.name, go: 'home' }, { t: 'How it fails' }]);
    var L = RL.failing, C = RL.hears.counts, keys = ['client', 'caller', 'person', 'event', 'log', 'someone', 'nobody', 'unknown'];
    var q = FL.q.trim().toLowerCase();
    var rows = L.filter(function (r) { return (FL.by === '*' || r.h.value === FL.by) && (FL.oc === '*' || r.o === FL.oc) && (!q || (r.t + ' ' + r.fn + ' ' + r.w + ' ' + r.p + ' ' + (r.route || '') + ' ' + (r.status || '')).toLowerCase().indexOf(q) >= 0); });
    var G = failGroups(rows);
    var h = '<div class="rl-bar"><h2>How it fails</h2><span class="rl-num"><b>' + C.total + '</b> failing endings</span></div>';
    h += '<p class="rl-lead">' + esc(RL.hears.sentence) + ' An ending is a place in the code where a function returns or raises. It counts as failing when it answers an HTTP status of 400 or more, raises, or has a name that says it refuses. A route handler is listed one row per route and status. "Not known from the code" means the code and the tool claims do not settle who hears about it; this page never says that nobody hears unless the tool is sure' + (C.nobody ? '' : ' (none is)') + '. ' + C.notConfident + ' of the answers are not confident' + (C.noClaim ? ' and ' + C.noClaim + ' have no claim at all' : '') + '.</p>';
    h += '<div class="rl-chips"><span class="rl-lab">Who hears</span> <button type="button" class="rl-chipb' + (FL.by === '*' ? ' on' : '') + '" data-flby="*">All ' + C.total + '</button>' + keys.filter(function (k) { return C[k]; }).map(function (k) { return '<button type="button" class="rl-chipb' + (FL.by === k ? ' on' : '') + '" data-flby="' + k + '">' + esc(BYWORD[k]) + ' ' + C[k] + '</button>'; }).join('') + '</div>';
    var oc = {}; L.forEach(function (r) { oc[r.o] = (oc[r.o] || 0) + 1; });
    h += '<div class="rl-chips"><span class="rl-lab">Outcome</span> <button type="button" class="rl-chipb' + (FL.oc === '*' ? ' on' : '') + '" data-floc="*">All</button>' + Object.keys(oc).sort().map(function (k) { return '<button type="button" class="rl-chipb' + (FL.oc === k ? ' on' : '') + '" data-floc="' + k + '">' + k + ' ' + oc[k] + '</button>'; }).join('') + '</div>';
    h += '<input type="search" class="rl-q rl-flq" placeholder="Filter by function, file, route, status or words" value="' + esc(FL.q) + '" aria-label="Filter the failing endings">';
    h += '<p class="rl-lead">' + rows.length + ' endings in ' + G.length + ' rows' + (G.length > FL.n ? ', the first ' + FL.n : '') + '. A row for a function with no drawn chart links to the function, whose outline lists it.</p><ul class="rl-list">' + G.slice(0, FL.n).map(function (g) {
      var r = g.r;
      return '<li class="rl-row"><div class="rl-r1"><b>' + esc(r.t) + '</b> <span class="rl-chip">' + esc(r.o) + '</span>' + (r.status ? ' <span class="rl-chip">HTTP ' + esc(r.status) + '</span>' : '') + (r.route ? ' <span class="rl-chip">' + esc(r.route) + '</span>' : '') + ' <span class="rl-loc">' + esc(g.lines.length > 1 ? g.lines.length + ' places: ' + g.lines.slice(0, 4).join(', ') + (g.lines.length > 4 ? ' and ' + (g.lines.length - 4) + ' more' : '') : r.w) + '</span> ' + esc(r.fn) + '</div>' + (r.p ? '<div class="rl-r2">' + esc(r.p) + '</div>' : '') +
        '<div class="rl-r3"><b>Who hears:</b> ' + esc(BYWORD[r.h.value] || r.h.value) + ' <span class="rl-dim">(' + esc(r.h.confidence === 'confident' ? 'confident' : r.h.confidence === 'none' ? 'the tool made no claim' : 'not confident') + (r.h.value === 'unknown' && r.h.detail && /no known catcher/.test(r.h.detail) ? '; ' + esc(r.h.detail.replace(/^not known from the code \(|\)$/g, '')) : '') + ')</span></div>' +
        '<div class="rl-act">' + (r.c ? '<button type="button" class="rl-b rl-sm" data-chartbox="' + esc(r.c) + '" data-box="' + esc(r.b) + '">On the chart</button>' : '') + (r.f >= 0 ? '<button type="button" class="rl-b rl-sm" data-fn="' + r.f + '">The function</button>' : '') + '</div></li>';
    }).join('') + '</ul>' + (G.length > FL.n ? '<div class="rl-more"><button type="button" class="rl-b" data-flmore="1">Show ' + ROWS_PER_PAGE + ' more</button></div>' : '');
    body.innerHTML = h;
  }
  R.views.fails = fails;
  body.addEventListener('input', function (e) {
    var i = e.target.closest('.rl-flq'); if (!i) return;
    FL.q = i.value; FL.n = ROWS_PER_PAGE; var pos = i.selectionStart; fails(); var j = body.querySelector('.rl-flq'); j.focus(); j.setSelectionRange(pos, pos);
  });
  body.addEventListener('click', function (e) {
    var t = e.target.closest('[data-flby],[data-floc],[data-flmore]'); if (!t) return;
    if (t.dataset.flby) { FL.by = t.dataset.flby; FL.n = ROWS_PER_PAGE; } else if (t.dataset.floc) { FL.oc = t.dataset.floc; FL.n = ROWS_PER_PAGE; } else FL.n += ROWS_PER_PAGE;
    var y = body.scrollTop; fails(); body.scrollTop = y;
  });

  /* ---------------------------------------------------------------- wiring */
  root.addEventListener('click', function (e) {
    var t = e.target.closest('[data-go],[data-g],[data-fn],[data-chart],[data-open],[data-journey],[data-walkj],[data-walkfull],[data-jmode],[data-full],[data-st],[data-small],[data-alljourneys],[data-view],[data-guide],[data-trace],[data-trpick],[data-trclr],[data-chartbox],.rl-close,.rl-back'); if (!t) return;
    var d = t.dataset;
    if (t.classList.contains('rl-close')) { R.hide(); return; }
    if (t.classList.contains('rl-back')) { var b = state.back.pop(); if (b) { for (var x in b) state[x] = b[x]; R.render(); } return; }
    if (d.go) { var p = d.go.split(':'); R.go(p[0], p[1]); return; }
    if (d.small != null) { state.small = d.small === '1'; R.views.stage(); return; }
    if (d.alljourneys != null) { state.allJ = d.alljourneys === '1'; R.render(); return; }
    if (d.walkj) { walkStart(d.walkj, null, false); return; }
    if (d.walkfull) { walkStart(d.walkfull, null, true); return; }
    if (d.jmode != null) { state.jfull = d.jmode === '1'; R.render(); return; }
    if (d.full != null) { state.jfull = true; R.render(); var el = body.querySelector('[data-sti="' + d.full + '"]'); if (el) el.scrollIntoView({ block: 'center' }); return; }
    if (d.st != null) { walkStart(d.j, +d.st, d.short !== '1'); return; }
    if (d.chartbox) { R.openChart(d.chartbox, d.box); return; }
    if (d.chart != null) { var f = F[+d.chart]; R.openChart(f.c[0]); return; }
    if (d.open) { R.openChart(d.open); return; }
    if (d.journey) { state.jfull = false; R.go('journey', d.journey); return; }
    if (d.view) { R.go(d.view); return; }
    if (d.guide) { R.openGuide(d.guide); return; }
    if (d.trace != null) { state.tr = { a: +d.trace, b: -1 }; R.go('trace'); return; }
    if (d.trpick != null) { state.tr[d.side] = +d.trpick; R.views.trace(); return; }
    if (d.trclr) { state.tr[d.trclr] = -1; R.views.trace(); return; }
    if (d.fn != null) { R.go('fn', d.fn); return; }
    if (d.g != null) R.go('stage', d.g);
  });
  root.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.classList.contains('rl-tile')) R.go('stage', e.target.dataset.g); if (e.key === 'Escape') R.hide(); });

  /* the Reader button: opens on what is pinned. A card opens the function it stands for; a box opens its own function; else the chart's function. */
  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'btn'; btn.id = 'rlBtn'; btn.textContent = 'Reader'; btn.title = 'What the system is, its journeys, its stages, and every function as a chart or an outline';
  function context() {
    try {
      var I = window.atlasInspect(), pin = I.pinned && I.pinned.t === 'node' ? I.pinned.id : null, ix;
      if (pin) { if (RL.cards && RL.cards[pin] !== undefined) return RL.cards[pin]; ix = R.fnById[pin.split('.')[0]]; if (ix !== undefined) return ix; }
      if (I.chart && R.chartFn[I.chart] !== undefined) return R.chartFn[I.chart];
    } catch (err) { /* open on home */ }
    return null;
  }
  btn.addEventListener('click', function () { if (!root.hidden) { R.hide(); return; } var ix = context(); if (ix !== null) R.show('fn', ix); else R.show('home'); });
  var ta = document.querySelector('.top-actions'); if (ta) ta.insertBefore(btn, ta.firstChild);
  // the Reader steps aside for anything else that opens: the chart list, the legend, the trace, the handles, the details. This runs in the capture phase,
  // because the page stops a click on a guide or a chart row from reaching a listener further out.
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('#legendBtn, #traceBtn, #handlesBtn, #qAll, #csPrev, #csNext, #nav .nav-item, .hw-page, #mmToggle, #inspToggle') : null;
    if (el && !root.hidden) R.hide();
  }, true);
  document.addEventListener('click', function (e) {
    var rd = e.target.closest ? e.target.closest('[data-reader-fn]') : null;     // a button inside the Details panel
    if (rd) { var ix = R.fnById[rd.dataset.readerFn]; if (ix !== undefined) R.show('fn', ix); }
    var rv = e.target.closest ? e.target.closest('[data-reader-view]') : null;     // a link in the chart list
    if (rv) R.show(rv.dataset.readerView);
    var rj = e.target.closest ? e.target.closest('[data-reader-journey]') : null;     // a button in the narrative
    if (rj) { state.jfull = false; R.show('journey', rj.dataset.readerJourney); }
    var rw = e.target.closest ? e.target.closest('[data-reader-walk]') : null;
    if (rw) walkStart(rw.dataset.readerWalk, null, false);
  });
  window.addEventListener('resize', function () { if (!root.hidden) { var t = document.getElementById('top'); root.style.top = (t ? t.getBoundingClientRect().bottom : 48) + 'px'; } });
  var h0 = location.hash; if (!h0 || h0 === '#' || /^#chart=overview(&|$)/.test(h0)) setTimeout(function () { R.show('home'); }, 0);
})();
