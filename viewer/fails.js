/* ================================================================ HOW IT FAILS
   Spliced into the viewer closure after breaks.js. The one front door for "how does it fail, and who hears": the page leads with a single line (who hears, with counts by value), then lists
   EVERY failure and refusal, grouped by who hears, filterable by who hears, by failure or refusal, and by stage. Nothing is cut off ("+N more" opens), and a map with no operations stage has it too.
   The unit is a box: a failure or refusal ENDING, plus a step the model says somebody hears a failure at while the flow carries on. Who hears is only what the model's `heardBy` says;
   a box with no entry is "not said yet", never guessed. The headline numbers are META.counts.fails (counts.mjs); the lists are read from the boxes and must add up to them (a test checks it). */

var FL_BY = ['person', 'outside', 'event', 'caller', 'log', 'nobody', 'unclear', 'unsaid'];
var FL_KIND = { failure: 'Failure', refusal: 'Refusal', step: 'At a step' };
var FLF = { by: '*', kind: '*', stage: '*' };               // the filters, kept while the page is open
function flBy(k) { return k === 'unsaid' ? capFirst(UNSAID) : (HEARD_SHORT[k] || k); }
function flRows(M) {
  var rows = [];
  M.ids.forEach(function (id) {
    var n = M.box[id].n, oc = n.outcome || '', h = heardOf(n), end = kindOf(n) === 'end';
    if (end && (oc === 'failure' || oc === 'refusal')) rows.push({ id: id, kind: oc, by: h ? h.by : 'unsaid', how: h && h.how || '', stage: M.stageOf[id] || '' });
    else if (!end && h && oc !== 'success' && oc !== 'neutral') rows.push({ id: id, kind: 'step', by: h.by, how: h.how || '', stage: M.stageOf[id] || '' });
  });
  return rows;
}
function flCounts(rows) {                                    // the headline: META.counts.fails (the build's one table); an older atlas is counted from its boxes
  var F = META.counts && META.counts.fails; if (F) return F;
  var by = {}, f = { total: rows.length, failure: 0, refusal: 0, steps: 0, by: by };
  FL_BY.forEach(function (k) { by[k] = 0; });
  rows.forEach(function (r) { by[r.by] = (by[r.by] || 0) + 1; if (r.kind === 'step') f.steps++; else f[r.kind]++; });
  f.said = f.total - by.unsaid; f.reachPerson = by.person; return f;
}
function flCount() { return flCounts(flRows(gdModel())).total; }
function flRoads(M, id) {                                    // how the flow gets there: the first two roads in, the rest behind "+N more" (it opens)
  var inn = M.inn[id] || []; if (!inn.length) return '';
  var one = function (r) { return gdRoad(r, false); };
  return '<span class="gd-side"><span class="gd-sl">Reached when</span>' + inn.slice(0, 2).map(one).join('') +
    (inn.length > 2 ? '<details class="fl-more"><summary>+' + (inn.length - 2) + ' more</summary>' + inn.slice(2).map(one).join('') + '</details>' : '') + '</span>';
}
function flRow(r, M) {
  var n = M.box[r.id].n, end = kindOf(n) === 'end', words = r.by === 'unsaid' ? UNSAID : capFirst(HEARD[r.by] || r.by);
  return '<div class="gd-unit en-row fl-row" data-by="' + esc(r.by) + '" data-kind="' + esc(r.kind) + '" data-stage="' + esc(r.stage) + '">' + '<div class="fl-head">' + gdBoxLine(r.id) + 
    '<span class="gd-pill' + (r.kind === 'failure' ? '' : ' quiet') + '">' + FL_KIND[r.kind] + '</span>' + (end ? '<span class="gd-pill quiet">' + (n.ending === 'back' ? 'Hands back' : 'Stops here') + '</span>' : '') + '</div><p class="fl-gist">' + gdText(gdTake(n.plain || n.summary, 130)) + '</p>' +
    '<span class="gd-side fl-who"><span class="gd-sl">Who hears</span><span>' + esc(words) + (r.how ? ' <span class="quiet">(' + gdProse(r.how) + ')</span>' : '') + '</span></span>' + flRoads(M, r.id) + '</div>';
}
function flLead(F) {                                         // ONE line: who hears, with the counts by value
  var parts = FL_BY.filter(function (k) { return F.by[k]; }).map(function (k) { return '<button type="button" class="fl-n" data-fl-by="' + k + '" title="Show only these"><b>' + F.by[k] + '</b> ' + esc(k === 'unsaid' ? UNSAID : flBy(k).charAt(0).toLowerCase() + flBy(k).slice(1)) + '</button>'; });
  if (!F.total) return '<p class="fl-lead"><b>No failure or refusal is drawn yet.</b> The map lists no failure or refusal ending, and no step that reports one.</p>';
  return '<p class="fl-lead"><b>Who hears about the ' + F.total + ' failures and refusals:</b> each group below is one answer, and the filters further down pick one.</p>' +      /* the counts by value were in the lead, in the filter and in the contents: they are in the filter now */
    (F.reachPerson ? '' : META.toolMap && F.by.unsaid ? '<p class="fl-none"><b>' + F.by.unsaid + ' of ' + F.total + ' are ' + UNSAID + ', so this page does not say that none reach a person.</b></p>' : '<p class="fl-none"><b>None of these reach a person directly: the calling code decides.</b></p>');
}
function flChips(attr, label, items, total) {
  return '<div class="bk-chips fl-chips" role="group" aria-label="Filter by ' + esc(label) + '"><span class="en-chips-l">' + esc(label) + '</span><button type="button" class="bk-chip on" data-' + attr + '="*">All <b>' + total + '</b></button>' +
    items.map(function (it) { return '<button type="button" class="bk-chip" data-' + attr + '="' + esc(it[0]) + '">' + esc(it[1]) + ' <b>' + it[2] + '</b></button>'; }).join('') + '</div>';
}
function gdFails() {
  var M = gdModel(), rows = flRows(M), F = flCounts(rows), P = GD.params;
  if (P) { ['by', 'kind', 'stage'].forEach(function (k) { if (P.get(k)) FLF[k] = P.get(k); }); } else FLF = { by: '*', kind: '*', stage: '*' };
  var cnt = function (key, v) { return rows.filter(function (r) { return r[key] === v; }).length; };
  var kinds = ['failure', 'refusal', 'step'].filter(function (k) { return cnt('kind', k); }).map(function (k) { return [k, FL_KIND[k], cnt('kind', k)]; });
  var stages = M.stages.filter(function (s) { return cnt('stage', s.id); });
  var stageOpts = '<label class="fl-stage"><span class="en-chips-l">Stage</span><select id="flStage" aria-label="Filter by stage"><option value="*">All stages (' + rows.length + ')</option>' + stages.map(function (s) { return '<option value="' + esc(s.id) + '">' + (stageNo(s.id) ? stageNo(s.id) + ' · ' : '') + esc(s.title) + ' (' + cnt('stage', s.id) + ')</option>'; }).join('') + '</select></label>';
  var secs = FL_BY.filter(function (k) { return cnt('by', k); }).map(function (k, i) {
    var list = rows.filter(function (r) { return r.by === k; }), take = k === 'unsaid' ? 'The map does not say who hears these. Nothing is guessed: they stay here until it does.' : capFirst(HEARD[k] || k) + '.';
    return { id: 'by-' + k, title: flBy(k), count: list.length, take: take, html: gdByStage(list.map(function (r) { return r.id; }), M, function (id) { return flRow(list.filter(function (r) { return r.id === id; })[0], M); }) };
  });
  if (!secs.length) secs.push({ id: 'none', title: 'Nothing listed', take: 'No failure or refusal is drawn.', html: '<p class="gd-body quiet">The map has no failure or refusal ending and no step that reports one, so there is nothing to list.</p>' });
  var N = (META.counts && META.counts.breaks) || {};
  var top = '<div class="bk-top fl-top">' + flLead(F) +
    '<p class="gd-body quiet">' + F.failure + ' failures and ' + F.refusal + ' refusals are endings' + (F.steps ? '; ' + F.steps + ' more are steps the map says report a failure and carry on' : '') + '. ' + (F.silent ? F.silent + ' of them reach nobody or only a log: <button type="button" class="hlink" data-reading-go="breaks&section=silent">Failures and refusals nobody is told about</button>. ' : '') +
    'A refusal is the system turning something away on purpose; a failure is one it did not choose. ' + gdNumLink('What these numbers count') + '.</p>' +
    flChips('fl-by', 'Who hears', FL_BY.filter(function (k) { return cnt('by', k); }).map(function (k) { return [k, flBy(k), cnt('by', k)]; }), rows.length) +
    '<div class="fl-row2">' + flChips('fl-kind', 'Kind', kinds, rows.length) + stageOpts + '</div>' +
    '<p class="bk-empty" id="flEmpty" hidden>Nothing matches those filters.</p></div>';
  return { id: 'fails', eyebrow: 'Start here', title: 'How it fails', top: top, tldr: 'Every failure and refusal the map draws, grouped by who hears about it. Who hears is only what the map says; a failure with no answer reads "' + UNSAID + '".', secs: secs };
}
function flSync() {                                          // the three filters together: hide rows, update the group and section counts, hide what is empty
  var g = gdRoot(); if (!g || readingView.dataset.guide !== 'fails') return;
  var any = false;
  $$('.fl-row', g).forEach(function (r) { r.classList.toggle('fl-off', (FLF.by !== '*' && r.dataset.by !== FLF.by) || (FLF.kind !== '*' && r.dataset.kind !== FLF.kind) || (FLF.stage !== '*' && r.dataset.stage !== FLF.stage)); });
  $$('.gd-sec', g).forEach(function (sec) {
    var vis = 0;
    $$('.bk-grp', sec).forEach(function (grp) { var n = $$('.fl-row', grp).filter(function (r) { return !r.hidden && !r.classList.contains('fl-off'); }).length; grp.classList.toggle('bk-off', !n); var gn = $('.bk-gn', grp); if (gn) gn.textContent = n; vis += n; });
    var cn = $('.gd-n', sec); if (cn) cn.textContent = vis;
    sec.classList.toggle('fl-off', !vis); if (vis) any = true;
    var a = $('.gd-toc-a[data-sec="' + sec.dataset.id + '"]', g); if (a) { a.parentNode.hidden = !vis; var tc = $('.gd-toc-c', a); if (tc) tc.textContent = vis; }
  });
  $$('[data-fl-by]', g).forEach(function (b) { if (b.classList.contains('bk-chip')) { b.classList.toggle('on', b.dataset.flBy === FLF.by); b.setAttribute('aria-pressed', b.dataset.flBy === FLF.by ? 'true' : 'false'); } });
  $$('[data-fl-kind]', g).forEach(function (b) { b.classList.toggle('on', b.dataset.flKind === FLF.kind); b.setAttribute('aria-pressed', b.dataset.flKind === FLF.kind ? 'true' : 'false'); });
  var sel = $('#flStage', g); if (sel && sel.value !== FLF.stage) sel.value = FLF.stage;
  var em = $('#flEmpty', g); if (em) em.hidden = any;
  if (S.reading === 'fails') writeHash(false);
}
function flSet(o) { for (var k in o) FLF[k] = o[k]; flSync(); }
document.addEventListener('click', function (e) {
  if (readingView.dataset.guide !== 'fails' || !e.target.closest) return;
  var b = e.target.closest('[data-fl-by]'), k = e.target.closest('[data-fl-kind]');
  if (b) { flSet({ by: FLF.by === b.dataset.flBy && !b.classList.contains('bk-chip') ? '*' : b.dataset.flBy }); if (b.dataset.flBy !== '*') { var sec = $('#gd-by-' + b.dataset.flBy, gdRoot()); if (sec && !sec.hidden) { sec.open = true; } } return; }
  if (k) flSet({ kind: k.dataset.flKind });
});
document.addEventListener('change', function (e) { if (e.target && e.target.id === 'flStage' && readingView.dataset.guide === 'fails') flSet({ stage: e.target.value }); });
document.addEventListener('click', function (e) {            // a link from another page to a guide, with its own section ("breaks&section=silent")
  var b = e.target.closest ? e.target.closest('[data-reading-go]') : null; if (!b) return;
  var v = b.dataset.readingGo.split('&'), mode = v[0], p = new URLSearchParams(v.slice(1).join('&'));
  openReading(mode, { push: true, params: p });
});
if (typeof gdModel === 'function') GUIDES.push({ id: 'fails', label: 'How it fails', chip: railIcon('fails', '✗'), title: 'How it fails', top: true, countWord: 'failures and refusals', count: function () { return flCount(); } });

/* ---- the overview's group boxes ("Failure endings (2)"): what is in the group, by who hears, and the WHOLE list (not "who hears: not said yet" and the first eight names) ---- */
function outcomeGroupLead(n) {
  var ids = gdArr(n.boxes);
  return 'Where the system finishes with the outcome ' + outcomeName(n.outcome).toLowerCase() + ': ' + ids.length + (ids.length === 1 ? ' ending box' : ' ending boxes') + '. Every one is listed below.';
}
function outcomeGroupHTML(n) {
  var M = gdModel(), ids = gdArr(n.boxes).filter(function (id) { return M.box[id]; }), oc = n.outcome || '', fr = oc === 'failure' || oc === 'refusal';
  var back = ids.filter(function (id) { return M.box[id].n.ending === 'back'; }).length, by = {};
  ids.forEach(function (id) { var h = heardOf(M.box[id].n), k = h ? h.by : 'unsaid'; by[k] = (by[k] || 0) + 1; });
  var h = '<div class="end-note ' + (back === ids.length ? 'back' : 'stop') + '"><p><b>' + ids.length + ' ' + esc(outcomeName(oc).toLowerCase()) + (META.toolMap ? ' ending boxes.' : ' endings.') + '</b> ' + (ids.length - back) + ' stop here · ' + back + ' hand back to their caller.</p>';
  if (fr) h += '<p class="end-heard"><b>Who hears:</b> ' + FL_BY.filter(function (k) { return by[k]; }).map(function (k) { return by[k] + ' ' + esc(k === 'unsaid' ? UNSAID : flBy(k).charAt(0).toLowerCase() + flBy(k).slice(1)); }).join(' · ') + '. <button type="button" class="hlink" data-reading-go="fails&kind=' + oc + '">Open them in How it fails</button></p>';
  h += '</div><h3>All ' + ids.length + (META.toolMap ? ' ending boxes' : ' endings') + '</h3><ul class="grp-list">' + ids.map(function (id) {
    var hd = heardOf(M.box[id].n), st = M.stageOf[id];
    return '<li>' + gdBoxBtn(id) + (fr ? ' <span class="gd-pill quiet">' + esc(hd ? flBy(hd.by) : 'Not said yet') + '</span>' : '') + (st && stageNo(st) ? ' <span class="quiet">' + stageNo(st) + ' · ' + esc(gdStageName(st)) + '</span>' : '') + '</li>';
  }).join('') + '</ul>';
  return h;
}
