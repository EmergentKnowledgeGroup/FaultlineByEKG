/* ================================================================ WHERE IT CAN BREAK
   Spliced into the viewer closure (after guides.js, which it extends: gdBuild() hands the mode "breaks" to gdBreaks(), and the shared reader shell draws it).
   The page is the product's promise: the questions the map's SHAPE raises, in the order the data gives them: kept suspects, open candidates, then the waits
   with no timeout and the loops with no limit shown, each grouped by stage; the held-back leads and the dismissed ones sit in closed sections (a dismissal is one
   reader's opinion, so it stays reachable, with its reason). Every row: the question, the stage, the box (a click opens it on its chart), a line on why it matters.
   Where walks are loaded, the rows whose boxes a run reached (proved, then seen) lead. It reads DATA.breaks (atlasdata.mjs breaksOf) and works with the evidence layer off;
   an atlas built before that field existed falls back to its findings list. A question is read from the map and never run: it is not a verdict. */

var BK_KIND = {                                  // check -> [the kind of check in plain words, one line on why it matters]
  'restart-misses': ['A stop with no restart', 'Something stops this, and what starts it again is not drawn.'],
  'shared-decision': ['One test reached from many places', 'Several callers reach the same check, and what each has finished when it gets there may differ.'],
  'never-sent': ['Handled but never sent', 'Something is waiting for a message that nothing is seen to send.'],
  'sticky-flag': ['A flag never cleared', 'A flag is set here and nothing is seen to clear it again.'],
  'wait-no-wake': ['A wait with nothing to end it', 'Nothing drawn wakes this wait: no timeout and no outside trigger.'],
  'wait-no-timeout': ['A wait with nothing to end it', 'No timeout or time-based exit is drawn for this wait.'],
  'no-limit-loop': ['A loop with no limit', 'Nothing drawn says when this loop stops repeating.'],
  'lost-wakeup': ['A wake-up that can be missed', 'Something sleeps until woken, and one path does not wake it.'],
  'empty-handler': ['A handler that does nothing', 'A caller expects something to happen here and nothing does.'],
  'swallowed-error': ['A failure that disappears', 'The code catches an error here and does not pass it on. Who hears about it?'],
  'can-only-go-back': ['Only way out goes back upstream', 'Every road out leads back, so what moves the work forward again is not drawn.'],
  'pile-up': ['Many roads in, one way out', 'Work may collect here: several roads arrive and one leaves.'],
  'hedged-route': ['A road worded with a hedge', 'The road says "may" or "can", so what decides it is not stated.'],
  'declared-never-produced': ['A declared outcome nothing produces', 'The code names this outcome and no ending drawn is shown to produce it.'],
  'ending-no-test': ['An ending no run reaches', 'The loaded runs never reached this ending.'],
  'no-way-out': ['No way out drawn', 'Roads arrive here and none is drawn leaving.'],
  'no-way-in': ['No way in drawn', 'Nothing drawn leads here, so how the work arrives is not shown.'],
  'unreached-from-start': ['Not reachable from the start', 'No road drawn leads here from where the system starts.'],
  'wait-person': ['A wait for a person', 'The system waits for someone to act (a click, a choice, a close). That is the system doing what it should, so it is not counted in the list of things to look at.'],
  'silent-failure': ['A failure or refusal nobody is told about', 'The map says nobody hears this (or, for a failure, only a log does). What happens, and who should know?']
};
var BK_SECS = [
  { st: 'suspect', id: 'kept', title: 'Kept suspects', take: 'A person read the code and kept these as worth a question.' },
  { st: 'open', id: 'open', title: 'Open candidates', take: 'Raised by the shape of the map and not yet looked at.' },
  { st: 'wait', id: 'waits', title: 'Waits with no timeout drawn', take: 'The flow pauses here and no timeout or time-based exit is drawn.' },
  { st: 'silent', id: 'silent', title: 'Failures and refusals nobody is told about', take: 'The map says a failure here is heard by nobody or only by a log, or a refusal by nobody: the person clicked and nothing showed. Each asks what happens and who should know.' },
  { st: 'loop', id: 'loops', title: 'Loops with no limit shown', take: 'Nothing drawn says when these stop repeating.' },
  { st: 'person', id: 'person', title: 'Waiting for a person', take: 'Waits the map says are for a person to act. Not counted in the things to look at. Closed by default.', closed: true },
  { st: 'lead', id: 'leads', title: 'Held-back leads', take: 'Weak shapes, too often meant on purpose to count as candidates. Closed by default.', closed: true },
  { st: 'dismissed', id: 'dismissed', title: 'Dismissed', take: 'Set aside with a reason. A dismissal is one reader’s opinion: the shape is still there.', closed: true }
];
var BK_ACTIVE = { suspect: 1, open: 1, wait: 1, loop: 1, silent: 1 };
function bkRows() {
  if (Array.isArray(DATA.breaks) && DATA.breaks.length) return DATA.breaks;
  return gdFindings().map(function (f) {                  // an atlas built before DATA.breaks: its findings, read as open candidates
    var rs = f.resolution && f.resolution.state;
    return { key: f.key, check: f.check, state: rs === 'dismissed' ? 'dismissed' : rs === 'suspect' ? 'suspect' : f.lead ? 'lead' : 'open', boxes: gdArr(f.boxes), routes: gdArr(f.routes), question: f.question || '', evidence: f.evidence || '', stage: f.cluster || '', why: f.resolution && f.resolution.why || '' };
  });
}
function bkNums() {                                          // the one set of totals (META.counts.breaks, from the build); an older atlas is counted from its rows
  var c = META.counts && META.counts.breaks; if (c) return c;
  var n = { suspect: 0, open: 0, wait: 0, loop: 0, silent: 0, lead: 0, dismissed: 0, person: 0 }; bkRows().forEach(function (r) { n[r.state] = (n[r.state] || 0) + 1; });
  return { person: n.person, kept: n.suspect, open: n.open, waits: n.wait, loops: n.loop, silent: n.silent, leads: n.lead, dismissed: n.dismissed, look: n.suspect + n.open + n.wait + n.loop + n.silent, setAside: n.lead + n.dismissed };
}
function bkCount() { return bkNums().look; }
function bkKind(r) { return BK_KIND[r.check] || [String(r.check || 'a candidate').replace(/-/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }), 'The shape of the map raises a question here.']; }
function bkCode(s) { return gdProse(s); }                  // a person reads box names: a box id the checks wrote into a question becomes that box's title, and `ticks` are code (guides.js gdProse)
function bkLevel(r) {                                      // the strongest evidence level any box of the row has: a run that reached it
  var ov = gdOverlay(), best = 0, n = 0;
  gdArr(r.boxes).forEach(function (b) { var i = ov && ov.boxes && ov.boxes[b]; if (!i) return; var l = i.level === 'proved' ? 2 : i.level === 'seen' ? 1 : 0; if (l > best) best = l; if (l && Number(i.count) > n) n = Number(i.count); });
  return best ? { lv: best === 2 ? 'proved' : 'seen', n: n } : null;
}
function bkStageOf(r, M) { return r.stage && M.stageById[r.stage] ? r.stage : (r.boxes[0] && M.stageOf[r.boxes[0]]) || ''; }
var BK_MAIN = null;
function bkOnMain(ids) { if (!BK_MAIN) { BK_MAIN = {}; pathIdsOf(MAIN_ID).forEach(function (id) { BK_MAIN[id] = 1; }); } return ids.some(function (id) { return BK_MAIN[id]; }); }
function bkRow(r, M) {
  var k = bkKind(r), bx = gdArr(r.boxes).filter(function (id) { return M.box[id]; }), st = bkStageOf(r, M), lv = r._lv;
  var own = r.check === 'wait-no-timeout' && bx[0] && M.box[bx[0]].n.failure ? M.box[bx[0]].n.failure : '';        // a wait says what happens if nothing arrives in the box's own words, when it has them
  var where = (st ? '<span class="bk-st" style="--sh:' + (stageHue(st) == null ? 200 : stageHue(st)) + '"><i></i>' + (stageNo(st) ? stageNo(st) + ' · ' : '') + esc(gdStageName(st)) + '</span>' : '') +
    bx.slice(0, 3).map(function (id) { return gdBoxBtn(id); }).join(' ') + (bx.length > 3 ? ' <details class="fl-more fl-inl"><summary>+' + (bx.length - 3) + ' more</summary>' + bx.slice(3).map(function (id) { return gdBoxBtn(id); }).join(' ') + '</details>' : '');
  return '<div class="gd-unit bk-row" data-check="' + esc(r.check) + '" data-state="' + esc(r.state) + '"' + (r.by ? ' data-by="' + esc(r.by) + '"' : '') + '><div class="bk-q">' + bkCode(r.question || k[0]) + '</div>' +
    '<div class="bk-meta"><span class="bk-kind">' + esc(k[0]) + '</span>' + (lv ? '<span class="bk-lv ' + lv.lv + '">' + (lv.lv === 'proved' ? 'Proved by a run' : 'Seen in a run' + (lv.n ? ' · ' + lv.n + '×' : '')) + '</span>' : '') +
    (r.agree > 1 ? '<span class="gd-pill quiet" title="Different checks point at the same boxes">' + r.agree + ' checks agree</span>' : '') + (bkOnMain(bx) ? '<span class="gd-pill quiet" title="A box of this question is a step of the main path">on the main path</span>' : '') + '</div>' +
    '<div class="bk-where">' + where + '</div>' + (r.state === 'suspect' && r.why && !own ? '' : '<p class="bk-why">' + (own ? '<b>If it goes wrong:</b> ' + gdProse(own) : esc(k[1])) + '</p>') +
    (r.on ? '<p class="bk-dis"><b>Waits for:</b> ' + esc((META.waitWords || {})[r.on] || r.on) + (r.how ? ' <span class="quiet">(' + gdProse(r.how) + ')</span>' : '') + '</p>' : '') +
    (r.state === 'silent' ? bkSilent(r, M) : '') +
    (r.state === 'dismissed' ? '<p class="bk-dis"><b>Dismissed:</b> ' + gdProse(r.why || 'no reason recorded') + '</p>' : '') +
    (r.state === 'suspect' && r.why ? '<p class="bk-dis bk-kept"><b>Kept because:</b> ' + gdProse(r.why) + '</p>' : '') +
    (r.evidence ? '<details class="bk-ev"' + (r._ev ? ' open' : '') + '><summary>The evidence</summary><p>' + gdProse(String(r.evidence).replace(/^candidate:\s*/i, '')) + '</p></details>' : '') + '</div>';
}
/* ---- what can hold up the main path (DATA.holds, from holds.mjs): the path's own waits, gates and loops, in path order, each with its state. A dismissed or never-questioned box still shows. ---- */
var HOLD_KIND = { wait: 'Wait', gate: 'Gate', loop: 'Loop' };
function bkLoopRegion(id) { var w = GD.M && GD.M.whole, rs = w ? gdArr(w.regions) : []; for (var i = 0; i < rs.length; i++) if (rs[i] && rs[i].kind === 'loop' && (rs[i].id === id || rs[i].id === 'loop_' + id)) return rs[i].id; return ''; }
/* a held-back lead on the path says what was caught, in the code's own terms, with the comment quoted when the code has one. The bare question ("This failure disappears here") claims more than the code shows:
   a caught error with a comment that says why is often meant, so such a row is a lead and says so. */
function bkHeldWhy(h) {
  var br = h.key ? bkRows().filter(function (r) { return r.key === h.key; })[0] : null, ev = br && br.evidence ? String(br.evidence).replace(/^candidate:\s*/i, '').replace(/\s*This box has \d+ roads? in\.\s*$/, '') : '';
  if (br && br.check === 'swallowed-error' && ev) return '<p class="bk-why"><b>An error is caught and not passed on.</b> ' + gdProse(ev) + (/\bcomment\b/i.test(ev) ? ' The comment gives a reason, so this is only a lead: held back, and not counted as a question.' : ' No comment says why. It is only a lead: held back, and not counted as a question.') + '</p>';
  return '<p class="bk-why">' + bkCode(h.question || '') + '</p>' + (ev ? '<p class="bk-why quiet">' + gdProse(ev) + '</p>' : '');
}
function bkHold(h, M) {
  var HC = META.counts && META.counts.holds, st = h.stage && M.stageById[h.stage] ? h.stage : (M.stageOf[h.boxes[0]] || ''), WW = META.waitWords || {}, HW = META.holdWords || {};
  var lr = h.kind === 'loop' ? bkLoopRegion(h.id) : '', name = h.kind === 'loop' ? (lr ? gdLitBtn(lr, h.title) : esc(h.title)) : gdBoxBtn(h.id);
  var where = st ? '<span class="bk-st" style="--sh:' + (stageHue(st) == null ? 200 : stageHue(st)) + '"><i></i>' + (stageNo(st) ? stageNo(st) + ' · ' : '') + esc(gdStageName(st)) + '</span>' : '';
  var line = h.kind === 'loop' ? (h.limit ? '<b>Limit:</b> ' + gdProse(h.limit) : '<b>Limit:</b> none shown on the map') :
    h.kind === 'wait' ? (h.how ? '<b>Waits for ' + esc(WW[h.on] || h.on) + ':</b> ' + gdProse(h.how) : '<b>Timeout:</b> not said on the map') :
    '<b>A gate:</b> ' + gdText(gdTake((M.box[h.id] && M.box[h.id].n.plain) || '', 140));
  var why = h.state === 'dismissed' ? '<p class="bk-dis"><b>Dismissed:</b> ' + gdProse(h.why || 'no reason recorded') + '</p>' :
    h.state === 'kept' ? '<p class="bk-dis bk-kept"><b>Kept as a question:</b> ' + bkCode(h.question || '') + (h.why ? ' <span class="quiet">Kept because: ' + gdProse(h.why) + '</span>' : '') + '</p>' :
    h.state === 'held' ? bkHeldWhy(h) :
    h.state === 'open' ? '<p class="bk-why">' + bkCode(h.question || '') + '</p>' :'<p class="bk-why quiet">No question was raised on it' + (h.on === 'person' ? '; it waits for a person.' : '.') + '</p>';
  if (h.dismissedWhy && h.state !== 'dismissed') why += '<p class="bk-dis"><b>Another question here was dismissed:</b> ' + gdProse(h.dismissedWhy) + '</p>';
  return '<div class="gd-unit bk-row bk-hold" data-hold="' + esc(h.kind) + '" data-hstate="' + esc(h.state) + '"><div class="bk-q">' + name + '</div><div class="bk-meta"><span class="bk-kind">' + HOLD_KIND[h.kind] + '</span>' +
    '<span class="bk-hs bk-hs-' + esc(h.state) + '">' + esc(HW[h.state] || h.state) + '</span><span class="gd-pill quiet" title="Where the declared main path passes it">step ' + h.step + (HC ? ' of ' + HC.pathSteps : '') + (h.kind === 'loop' && h.steps > 1 ? ' · ' + h.steps + ' of its boxes are on the path' : h.steps > 1 ? ' · the path passes it ' + h.steps + ' times' : '') + '</span></div>' +
    '<div class="bk-where">' + where + '</div><p class="bk-why">' + line + '</p>' + why + '</div>';
}
function bkHoldSection(M) {
  var H = gdArr(DATA.holds), HC = META.counts && META.counts.holds; if (!H.length) return null;
  var n = function (k) { return H.filter(function (h) { return h.kind === k; }).length; }, p = pathIdsOf(MAIN_ID).length;
  var intro = '<p class="gd-body">This is read from the declared main path alone (' + (HC ? HC.pathSteps + ' steps, ' + HC.pathBoxes + ' different boxes: calls come back' : p + ' steps') + '): its waits, its gates and the loops that touch it, in the order the path meets them. A box shows here whether a question was raised on it or not, and a dismissed one stays: dismissing a question does not make the place go away. The sections below are the questions; this is the road itself.</p>' +
    '<p class="gd-body quiet">' + H.length + ' places: ' + [n('wait') ? gdPlural(n('wait'), 'wait') : '', n('gate') ? gdPlural(n('gate'), 'gate') : '', n('loop') ? gdPlural(n('loop'), 'loop') : ''].filter(Boolean).join(', ') + '. Not extra questions: a place that is also in a section below is the same question seen from the path.</p>';
  return { id: 'holds', title: 'What can hold up the main path', count: H.length, take: 'The main path’s own waits, gates and loops, in path order, each with its state and its limit or timeout.', html: intro + H.map(function (h) { return bkHold(h, M); }).join('') };
}
function bkSilent(r, M) {                                    // what happens (the box's own words) and who hears (the model's heardBy), never a guess
  var id = gdArr(r.boxes)[0], n = id && M.box[id] && M.box[id].n;
  return (n && n.plain ? '<p class="bk-dis"><b>What happens:</b> ' + gdText(gdTake(n.plain, 160)) + '</p>' : '') +
    '<p class="bk-dis bk-kept"><b>Who hears:</b> ' + esc(capFirst(HEARD[r.by] || r.by || '')) + (r.how ? ' <span class="quiet">(' + gdProse(r.how) + ')</span>' : '') + '</p>';
}
function bkGroups(rows, M, firstOpen) {                               // rows grouped by stage, in stage order; inside a group the data's own order
  var by = {}, ord = [];
  rows.forEach(function (r) { var s = bkStageOf(r, M) || '_'; if (!by[s]) { by[s] = []; ord.push(s); } by[s].push(r); });
  var idx = function (s) { var i = M.stages.findIndex ? M.stages.findIndex(function (x) { return x.id === s; }) : -1; return i < 0 ? 999 : i; };
  ord.sort(function (a, b) { return idx(a) - idx(b); });
  if (firstOpen && ord.length && by[ord[0]].length) by[ord[0]][0]._ev = true;                // the first question on the page shows its evidence, so the first screen holds a question and what it rests on
  return ord.map(function (s) {
    var st = s === '_' ? null : M.stageById[s];
    return '<div class="bk-grp"><h4 class="bk-gh"' + (st ? ' style="--sh:' + (stageHue(s) == null ? 200 : stageHue(s)) + '"' : '') + '><i></i>' + (st ? (stageNo(s) ? stageNo(s) + ' · ' : '') + esc(st.title) : 'Elsewhere') + '<span class="bk-gn">' + by[s].length + '</span></h4>' + by[s].map(function (r) { return bkRow(r, M); }).join('') + '</div>';
  }).join('');
}
function bkByChips(list) {                                   // inside the silent section: nobody, or only a log
  var by = {}; list.forEach(function (r) { by[r.by || ''] = (by[r.by || ''] || 0) + 1; });
  return '<div class="bk-chips bk-bychips" role="group" aria-label="Filter by who hears"><button type="button" class="bk-chip on" data-bk-by="*">Both <b>' + list.length + '</b></button>' +
    ['nobody', 'log'].filter(function (k) { return by[k]; }).map(function (k) { return '<button type="button" class="bk-chip" data-bk-by="' + k + '">' + esc(HEARD_SHORT[k]) + ' <b>' + by[k] + '</b></button>'; }).join('') + '</div>';
}
function gdBreaks() {
  var M = gdModel(), rows = bkRows().map(function (r) { var c = Object.assign({}, r); c.boxes = gdArr(r.boxes); c.routes = gdArr(r.routes); c.question = r.question || ''; c._lv = bkLevel(c); return c; });
  var kinds = {}, closed = {}, apart = {}, order = [];                // per kind: the rows in the open sections, and the rows held back or dismissed
  rows.forEach(function (r) { var l = bkKind(r)[0]; if (!(l in kinds)) { kinds[l] = 0; closed[l] = 0; apart[l] = 0; order.push(l); } if (BK_ACTIVE[r.state]) kinds[l]++; else if (r.state === 'person') apart[l]++; else closed[l]++; });
  order.sort(function (a, b) { return (kinds[b] + closed[b] * 0.001) - (kinds[a] + closed[a] * 0.001); });
  var N = bkNums();
  var CNl0 = gdCounts(M).loops, nlk0 = kinds['A loop with no limit'] != null ? (kinds['A loop with no limit'] + (closed['A loop with no limit'] || 0)) : 0;
  var loopNoteHTML = nlk0 && CNl0 && CNl0.noLimit != null ? '<p class="gd-body quiet"><b>Loops with no limit:</b> ' + CNl0.noLimit + ' loops have no limit written on the map; ' + (CNl0.raised != null ? CNl0.raised : nlk0) + ' were raised as questions. The other ' + (CNl0.noLimitWorkedOut || 0) + ' are worked out from return roads and are not checked, because they have no limit field to read. They are listed under <a class="hlink" href="#reading=narrative&section=loops">Loops and retries</a>.</p>' : '';
  var secs = [], holdSec = bkHoldSection(M), ran = rows.filter(function (r) { return r._lv && BK_ACTIVE[r.state]; }).sort(function (a, b) { return (b._lv.lv === 'proved' ? 1 : 0) - (a._lv.lv === 'proved' ? 1 : 0) || (b._lv.n || 0) - (a._lv.n || 0); });
  if (ran.length) secs.push({ id: 'ran', title: 'Reached by a run', count: ran.length, take: 'Proved first, then seen: a loaded run or test went through these boxes.', html: '<p class="gd-body">These questions sit on boxes a recorded run reached. That makes them more worth a look; it does not make them bugs. Proved ones come first, then the ones seen most often; the stage is on each row.</p>' + ran.map(function (r) { return bkRow(r, M); }).join('') });
  if (holdSec) secs.unshift(holdSec);
  var evDone = false;                                      // the first question of the first section of questions shows its evidence
  BK_SECS.forEach(function (S) {
    var list = rows.filter(function (r) { return r.state === S.st && !(BK_ACTIVE[S.st] && r._lv); });
    if (!list.length) return;
    var intro = S.st === 'dismissed' ? '<p class="gd-body">Each was set aside with a reason. A dismissal answers one reader’s question once: it does not prove the shape is harmless.</p>' : S.st === 'lead' ? '<p class="gd-body">A lead is a weak shape, too often meant on purpose to be called a candidate. No gate counts it. It is here so nothing is hidden.</p>' : '';
    if (S.st === 'person') intro = '<p class="gd-body">The map says each of these waits for a person (a click, a choice, a window to close). That is the system doing what it should. They are <b>not counted</b> in the ' + N.look + ' things to look at above. If a person never comes, nothing here will move.</p>';
    if (S.st === 'silent') intro = '<p class="gd-body">The map&rsquo;s author wrote down who hears each of these failures, and the answer is nobody or only a log. That is a question, not a verdict: each asks what happens, and who should know. No check, count or finished rule depends on this section.</p>' + bkByChips(list);
    secs.push({ id: S.id, title: S.title, count: list.length, take: S.take, closed: S.closed, html: intro + (S.st === 'loop' ? loopNoteHTML : '') + bkGroups(list, M, !!(BK_ACTIVE[S.st] && list.length && !evDone && (evDone = true))) });
  });
  if (!secs.length) secs.push({ id: 'none', title: 'Nothing raised', take: 'The checks raised no question on this map.', html: '<p class="gd-body quiet">The checks found no shape worth a question. That says nothing about runs: this map was read, not run.</p>' });
  var chips = '<button type="button" class="bk-chip on" data-bk-kind="">All <b>' + N.look + '</b>' + (N.setAside ? '<span class="bk-cn" title="held-back leads and dismissed ones, in their closed sections">· ' + N.setAside + ' set aside</span>' : '') + '</button>' +
    (function () { var one = function (l) { return '<button type="button" class="bk-chip' + (kinds[l] ? '' : ' bk-zero') + '" data-bk-kind="' + esc(l) + '">' + esc(l) + (kinds[l] ? ' <b>' + kinds[l] + '</b>' : '') + (apart[l] ? '<span class="bk-cn" title="waits for a person: filed apart, not counted in the things to look at">· ' + apart[l] + ' filed apart</span>' : '') + (closed[l] ? '<span class="bk-cn" title="held-back leads and dismissed ones, in their closed sections">· ' + closed[l] + ' set aside</span>' : '') + '</button>'; }, on = order.filter(function (l) { return kinds[l]; }), off = order.filter(function (l) { return !kinds[l]; }); return on.map(one).join('') + (off.length ? '<details class="bk-zerod"><summary>' + off.length + ' more kinds, none in the open sections</summary><span class="bk-zerow">' + off.map(function (l) { return '<span class="bk-zn">' + esc(l) + (apart[l] ? ' · ' + apart[l] + ' filed apart' : '') + (closed[l] ? ' · ' + closed[l] + ' set aside' : '') + '</span>'; }).join('') + '</span></details>' : ''); })();
  var parts = [[N.kept, 'kept suspect', 'kept suspects'], [N.open, 'open candidate', 'open candidates'], [N.waits, 'wait with no timeout', 'waits with no timeout'], [N.silent, 'silent failure', 'silent failures'], [N.loops, 'loop with no limit that no question lists', 'loops with no limit that no question lists']].filter(function (p) { return p[0]; });
  var sum = '<p class="bk-sum"><b>' + N.look + ' to look at</b>' + (parts.length ? ' = ' + parts.map(function (p) { return p[0] + ' ' + (p[0] === 1 ? p[1] : p[2]); }).join(' + ') : '') + (N.setAside ? '; <b>' + N.setAside + ' set aside</b> (' + [N.leads ? N.leads + ' held-back lead' + (N.leads === 1 ? '' : 's') : '', N.dismissed ? N.dismissed + ' dismissed' : ''].filter(Boolean).join(' + ') + ')' : '') + '.' + (N.person ? ' <b>' + N.person + (N.person === 1 ? ' wait for a person</b> is' : ' waits for a person</b> are') + ' filed apart and not counted here.' : '') + ' ' + gdNumLink('What the numbers count') + '.</p>';
  var pinRaw = String(META.pin || (META.source && META.source.pin) || '').trim(), pinM = /^(git|tree)\s+([0-9a-f]+)$/i.exec(pinRaw);          // the commit the code was read at, when the page has one (the build writes "git <sha>", or "tree <sha>" when the source has no commit)
  var pin0 = pinM ? pinM[2].slice(0, 7) : pinRaw.slice(0, 10), isTree = pinM && pinM[1].toLowerCase() === 'tree';
  var top = '<div class="bk-top"><p class="bk-note"><b>Questions the map’s shape raises, read from ' + (pin0 ? 'the files in the folder (' + (isTree ? 'tree <code>' + esc(pin0) + '</code>' : 'git HEAD was <code>' + esc(pin0) + '</code>; edits not yet committed are read too') + ')' : 'the code and the map') + ', not run.</b> Nothing was executed, so some of these questions will be wrong. None is a verdict.</p>' +
    sum + '<div class="bk-chips" role="group" aria-label="Filter by kind of check">' + chips + '</div><p class="bk-empty" id="bkEmpty" hidden>No question of that kind in the open sections.</p>' + stuckNote(secs, N) + '</div>';      // the first screen is the questions: one note (not run, said once), one line of numbers, the filter, then the first question with its evidence
  var firstOpen = secs.filter(function (x) { return x.id === 'kept'; })[0] || secs.filter(function (x) { return x.id === 'open' || x.id === 'waits' || x.id === 'silent' || x.id === 'loops'; })[0] || secs[0];
  secs.forEach(function (x) { x.open = x === firstOpen; });
  return { id: 'breaks', eyebrow: 'Start here', title: 'Where it can break', top: top, tldr: '', secs: secs };
}
function stuckNote(secs, N) {                                    // a pointer for the reader whose question is "why did it stop": only to sections that exist
  var has = function (id) { return secs.some(function (x) { return x.id === id; }); }, links = [];
  if (has('holds')) links.push('<button type="button" class="hlink" data-gd-goto="holds">what can hold up the main path</button>');
  if (has('waits')) links.push('<button type="button" class="hlink" data-gd-goto="waits">' + (META.toolMap ? 'a program or task waits with no timeout' : 'the machine waits elsewhere with no timeout') + '</button>');
  if (has('silent')) links.push('<button type="button" class="hlink" data-gd-goto="silent">the failures and refusals nobody is told about</button>');
  if (has('loops')) links.push('<button type="button" class="hlink" data-gd-goto="loops">the loops with no limit</button>');
  if (META.toolMap) { if (has('open')) links.push('<button type="button" class="hlink" data-gd-goto="open">the open questions</button>'); return links.length ? '<p class="bk-stuck"><b>If something got stuck or stopped moving,</b> start with ' + links.join(', then ') + '.</p>' : ''; }
  return '<p class="bk-stuck"><b>If something got stuck or stopped moving,</b> start with ' + (links.length ? links.join(', then ') + ', then ' : '') + 'the kept suspects.</p>';
}
function bkSync() {                                          // chip filter + the guide's own filter: hide empty stage groups, update the section counts
  var g = gdRoot(); if (!g || readingView.dataset.guide !== 'breaks') return;
  var kind = (gdState().kind) || '';
  $$('.bk-row:not(.bk-hold)', g).forEach(function (r) { var k = bkKind({ check: r.dataset.check })[0]; r.classList.toggle('bk-off', !!kind && k !== kind); });
  $$('.bk-chip[data-bk-kind]', g).forEach(function (c) { c.classList.toggle('on', (c.dataset.bkKind || '') === kind); c.setAttribute('aria-pressed', (c.dataset.bkKind || '') === kind ? 'true' : 'false'); });
  var any = false;
  $$('.gd-sec', g).forEach(function (sec) {
    if (sec.dataset.id === 'holds') { any = true; return; }                  // the main path's own places are not questions: no kind filter touches them
    $$('.bk-grp', sec).forEach(function (grp) { var n = $$('.bk-row', grp).filter(function (r) { return !r.hidden && !r.classList.contains('bk-off') && !r.classList.contains('bk-by-off'); }).length; grp.classList.toggle('bk-off', !n); var gn = $('.bk-gn', grp); if (gn) gn.textContent = n; });
    var vis = $$('.bk-row', sec).filter(function (r) { return !r.hidden && !r.classList.contains('bk-off') && !r.classList.contains('bk-by-off'); }).length;
    var cn = $('.gd-n', sec); if (cn && (sec.dataset.id !== 'none')) cn.textContent = vis;
    if (vis) any = true;
  });
  var em = $('#bkEmpty', g); if (em) em.hidden = any || !kind;
}
document.addEventListener('click', function (e) {
  var bb = e.target.closest ? e.target.closest('[data-bk-by]') : null;
  if (bb && readingView.dataset.guide === 'breaks') {
    var sec = bb.closest('.gd-sec'), v = bb.dataset.bkBy; if (!sec) return;
    $$('.bk-bychips .bk-chip', sec).forEach(function (c) { c.classList.toggle('on', c === bb); c.setAttribute('aria-pressed', c === bb ? 'true' : 'false'); });
    $$('.bk-row', sec).forEach(function (r) { r.classList.toggle('bk-by-off', v !== '*' && r.dataset.by !== v); });
    $$('.bk-grp', sec).forEach(function (g) { var k = $$('.bk-row', g).filter(function (r) { return !r.classList.contains('bk-by-off') && !r.classList.contains('bk-off'); }).length; g.classList.toggle('bk-by-off', !k); var gn = $('.bk-gn', g); if (gn) gn.textContent = k; });
    var cn = $('.gd-n', sec); if (cn) cn.textContent = $$('.bk-row', sec).filter(function (r) { return !r.classList.contains('bk-by-off'); }).length;
    return;
  }
  var b = e.target.closest ? e.target.closest('[data-bk-kind]') : null; if (!b || readingView.dataset.guide !== 'breaks') return;
  gdState().kind = b.dataset.bkKind || ''; bkSync();
});
if (typeof gdModel === 'function') GUIDES.push({ id: 'breaks', label: 'Where it can break', chip: railIcon('breaks', '!'), title: 'Where it can break', top: true, count: function () { return bkCount(); } });     // (a page built without guides.js has no such page)
