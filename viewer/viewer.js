/* Faultline atlas viewer. Plain classic JS, no network, no frameworks.
   Globals expected from the inlined engine render.mjs: KIND, EDGE, renderSVG (CHIP_PALETTE is used when present). Data: <script id="atlas-data">.
   The files guides.js, breaks.js, flow.js, regions.js, whole.js, overview.js, walk.js, evidence.js and zoomtext.js are spliced into THIS closure (see the INCLUDE lines near the end), so they can
   reach every helper below. Also here: the readable floor in fit (fitFloor, autoRoom: no box name or route label is ever under 11 px at fit, panels cannot push a chart under it),
   the declared-path line and its walk (regions.js buildSpine/spineShow, walk.js), "Where it can break" (breaks.js), real roads in the box panel and the flow bar (flowRows, flow.js).
   The stable surface they should rely on is the tiny object FL:
     FL.chart()              the mounted chart context {id, chart, svg, vp, nodeEl, edgeEl, labelEl, nb, eb, ...} or null
     FL.scale()              current zoom: screen px per map unit (below 0.30 the page shows its far level of detail)
     FL.onChart(fn)          fn(ctx) after every chart mount (called once now if a chart is already mounted)
     FL.onZoom(fn)           fn(scale, previousScale) after the zoom changes (also called after a chart mount)
     FL.openPanel(title, html, o)   shows the docked panel on the right of the map and returns its body element.
                                    o = {onClick(event), onClose(), wide}.  A second call replaces the content.
     FL.closePanel()         hides it again
   Other modules add their own nav entries to GUIDES ({id, label, chip, title}) before boot; guideShow(mode, params) renders one.
   Data: atlasData = {meta, nav, charts, terms, sections}; see docs/CONTRACTS.md section 11 and the notes above DATA below. */
(function () {
'use strict';

/* ================================================================ helpers */
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
var trunc = function (s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
/* Sentences, the careful way: a full stop ends a sentence only when a space follows it (and then something that can start one), so 0.25 s, opts.trace, worker.py:32, e.g. and Dr. Smith
   are never cut.  Nothing is ever dropped: the pieces joined with a space are the text again.  Used wherever the page shows "the first sentence or two". */
var ABBR_RX = /^(?:e\.?g|i\.?e|etc|vs|cf|approx|fig|no|nos|mr|mrs|ms|dr|st|inc|ltd|al)$/i;
function sentencesOf(text) {
  var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim(), out = [], start = 0, i, j, k, c, next, word;
  for (i = 0; i < s.length; i++) {
    c = s.charAt(i); if (c !== '.' && c !== '!' && c !== '?') continue;
    j = i; while (j + 1 < s.length && /[.!?]/.test(s.charAt(j + 1))) j++;
    k = j + 1; while (k < s.length && /["'\u2019\u201d)\]`]/.test(s.charAt(k))) k++;
    if (k < s.length && s.charAt(k) !== ' ') { i = j; continue; }                          // opts.trace, 0.25, a.b: not an end
    next = s.slice(k + 1).replace(/^\s+/, '').charAt(0);
    word = (s.slice(start, i).match(/(\S+)$/) || [''])[0].replace(/^[("'`]+/, '');
    if (next && /[a-z]/.test(next)) { i = j; continue; }                                    // a lower-case word follows: the sentence goes on
    if (c === '.' && (ABBR_RX.test(word) || /^[A-Z]$/.test(word))) { i = j; continue; }
    out.push(s.slice(start, k).trim()); start = k + 1; i = k;
  }
  if (start < s.length) out.push(s.slice(start).trim());
  return out.filter(Boolean);
}
var store = {
  get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
  set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
};
var reduced = false;
try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }
var KEY = { theme: 'faultline-atlas-theme', nav: 'faultline-atlas-nav', insp: 'faultline-atlas-insp', mini: 'faultline-atlas-mini', scen: 'faultline-atlas-scen', onboard: 'faultline-atlas-onboarded', howto: 'faultline-atlas-howto' };
/* route types: forward / return / record / deliver (the contract) */
var TYPE_WORDS = { forward: 'Normal flow', 'return': 'Return or retry', record: 'Record or side effect', deliver: 'Hand-off' };
var TYPE_HELP = { forward: 'one thing leads to the next', 'return': 'the flow loops back (dashed)', record: 'writes evidence or a side effect', deliver: 'hands something to a person or to outside' };
var TYPE_RANK = { forward: 0, deliver: 1, record: 2, 'return': 3 };
/* box kinds from the model: label, one-line help, fallback colour (the renderer's KIND table wins when it knows the kind) */
var KINDS = {
  step: ['Step', 'something the system does', '#59b7a1'], decision: ['Decision', 'a choice between roads', '#7db6bd'], wait: ['Wait', 'the flow pauses here (dashed border)', '#e2af69'],
  end: ['Ending', 'a pill: the flow stops here, or (dotted pill) hands back to the code that called', '#9aa9b9'], store: ['Store', 'a place something is kept', '#52a9de'], external: ['Outside', 'something beyond this system', '#b598e8'], gate: ['Gate', 'a rule or permission check', '#8aa6dd']
};
var STATUS_WORDS = { live: 'Live', 'default-on': 'On by default', off: 'Off by default', 'test-only': 'Test only' };
function kindOf(n) { return String((n && (n.kind || n.category)) || 'step'); }
function kindInfo(k) { var i = KINDS[String(k).toLowerCase()]; return i ? { label: i[0], help: i[1], color: i[2] } : { label: String(k), help: '', color: '#9aa9b9' }; }
function kindStyle(k) { return typeof KIND !== 'undefined' ? (KIND[k] || KIND[String(k).toLowerCase()] || null) : null; }
function catColor(k) { var K = kindStyle(k); return (K && K.color) || kindInfo(k).color; }
function eShort(e) { return (e && (e.short || e.when || e.label)) || ''; }
function eText(e) { return eShort(e) || 'Always'; }          // a route with no condition (the only road out of a box)

/* ================================================================ data
   atlasData: meta {title, draft, census, notDrawn, sourceBase, pin, roleWords, link{label,href}, exports{svg}}, nav [{group, items[chartId]}],
   charts {id: {title, navLabel, navSub, codes[], summary, kind: overview|stage|whole|detail, geom, nodes, edges, metrics, stages?, spine?, regions?, flow?, portals?}},
   terms [{term, meaning, family?, refs?}], sections [{id, title, charts[]}] (or {journeyOrder[], sections[]}).
   node: {id, title, kind, status, handle, plain, why, inputs[], outputs[], failure, refs[{path, symbol, line}], switch?, outcome?}
   route: {id, from, to, type, label (the condition), short?, why, refs, inferred?}.
   meta.sourceBase: base for source links, e.g. 'https://host/org/repo/blob/main/' or a 'file:///...' folder; may hold {path} and {line}. Absent: plain text. */
var DATA = JSON.parse(document.getElementById('atlas-data').textContent);
var META = DATA.meta || {};
if (META.toolMap) document.documentElement.classList.add('toolmap');
var UNSAID = META.toolMap ? 'not known from the code' : 'not said yet';
if (META.toolMap) {                                                      // a tool map draws no regions and no whole map: the buttons say what they do
  var tmRg = $('#rdRegions'), tmAll = $('#qAll'), tmTr = $('#traceBtn');
  if (tmRg && tmRg.firstChild) { tmRg.firstChild.nodeValue = 'Stages and loops '; tmRg.title = 'Highlight a stage or a loop'; }
  if (tmAll) { tmAll.textContent = 'Search all charts'; }
  if (tmTr) tmTr.title = tmTr.title.replace('if they are not on this chart the answer opens on the whole map', 'if they are not on one chart, the call path between their functions opens in the Reader, with any break marked');
}
var CH = DATA.charts || {};
/* who hears about an ending (model.heardBy): the words come from the build (meta.heardWords), so the page, the agent view and the docs say the same thing */
var HEARD = META.heardWords || { person: 'a person using the system is told', outside: 'sent to a party outside the system', event: 'published for whoever listens (an event, a metric, a webhook)', caller: 'thrown or returned to the code that called', log: 'only written to a log', nobody: 'no trace', unclear: 'the code does not settle it' };
var HEARD_SHORT = META.heardShort || { person: 'A person is told', outside: 'An outside party', event: 'Published as an event', caller: 'Goes back to the caller', log: 'Only in a log', nobody: 'Nobody', unclear: 'Not settled by the code' };
function heardOf(n) { return n && n.heard && n.heard.by ? n.heard : null; }
function needsHeard(n) { return !!n && String(n.kind || n.category) === 'end' && /^(failure|refusal)$/.test(n.outcome || ''); }
function capFirst(t) { t = String(t || ''); return t.charAt(0).toUpperCase() + t.slice(1); }
/* ONE name for each outcome, everywhere a person reads it (the box panel, the endings lists, the overview groups, How it fails): the model's own word, capitalised */
var OUTCOME_NAME = { success: 'Success', failure: 'Failure', refusal: 'Refusal', neutral: 'Neutral' };
function outcomeName(o) { return OUTCOME_NAME[o] || (o ? capFirst(o) : 'Outcome not labelled'); }
function endNote(n) {                                  // an ending stops the flow, or hands back to its caller; ANY box may say who hears about it (a failure can be heard about while the story goes on)
  if (!n) return '';
  var end = kindOf(n) === 'end', back = n.ending === 'back', h = heardOf(n);
  if (!end && !h) return '';
  return '<div class="end-note ' + (end ? (back ? 'back' : 'stop') : 'heard') + '">' +
    (end ? '<p><b>' + (back ? 'Hands back to its caller.' : 'Stops here.') + '</b> ' + (back ? 'A road leaves this box, so the flow goes on after it.' : 'Nothing leaves this box: the flow ends.') + '</p>' : '') +
    (h ? '<p class="end-heard"><b>Who hears:</b> ' + esc(capFirst(HEARD[h.by] || h.by)) + (h.how ? ' <span class="quiet">(' + esc(h.how) + ')</span>' : '') + '</p>' : needsHeard(n) ? '<p class="end-heard quiet"><b>Who hears:</b> ' + UNSAID + '</p>' : '') + '</div>';
}
Object.keys(CH).forEach(function (id) {                                         // tolerate lists for maps, and a missing navLabel
  var c = CH[id], toMap = function (v) { if (!Array.isArray(v)) return v || {}; var m = {}; v.forEach(function (x) { m[x.id] = x; }); return m; };
  c.id = c.id || id; c.navLabel = c.navLabel || c.title || id; c.nodes = toMap(c.nodes); c.edges = toMap(c.edges);
  if (!c.geom) c.geom = { width: 400, height: 200, nodes: [], edges: [], clusters: [] };
});
function isWhole(c) { return !!c && c.kind === 'whole'; }
function chartForNode(nid) {                                                    // a deep link without (or with a wrong) chart: prefer a stage or detail chart, then the whole map
  var best = null, rank = { stage: 0, detail: 1, whole: 2, overview: 3 };
  Object.keys(CH).forEach(function (id) { var c = CH[id]; if (!c.nodes[nid]) return; var r = rank[c.kind] == null ? 1.5 : rank[c.kind]; if (!best || r < best.r) best = { id: id, r: r }; });
  return best && best.id;
}
var GROUPS = (Array.isArray(DATA.nav) ? DATA.nav : []).map(function (g) { return { group: g.group, items: g.items.filter(function (id) { return CH[id]; }) }; }).filter(function (g) { return g.items.length; });
(function () {
  var listed = {}; GROUPS.forEach(function (g) { g.items.forEach(function (i) { listed[i] = 1; }); });
  var rest = Object.keys(CH).filter(function (id) { return !listed[id]; });
  if (rest.length) GROUPS.push({ group: 'More', items: rest });
})();
var ORDER = [].concat.apply([], GROUPS.map(function (g) { return g.items; }));
var FIRST = ORDER[0];
var GUIDES = [];                         // guides.js (or any later module) pushes {id, label, chip, title} here before boot

/* ================================================================ official handles: the names the system itself uses (a box's `handle`, a chart's `codes`, the `terms` list)
   Everything here tolerates missing data: DATA.layers, DATA.terms, node.handle, node.layers, chart.codes may all be absent.
   A definition may carry aliases (def.aliases = ['old name']): other names a reader types or an old document uses. They are searchable and
   deep-linkable (#handle=old name opens the real one) but are never chips. */
var LAY = DATA.layers || {};
if (Array.isArray(LAY)) { var layObj = {}; LAY.forEach(function (x) { var k = x && (x.handle || x.tag || x.id || x.code); if (k) layObj[k] = x; }); LAY = layObj; }
(Array.isArray(DATA.terms) ? DATA.terms : []).forEach(function (t) {           // the contract's terms list: {term, meaning, family?, refs?}
  var k = t && (t.term || t.name); if (!k) return;
  LAY[k] = Object.assign({ name: '', meaning: t.meaning || '', family: t.family || '', refs: t.refs || [], aliases: t.aliases || [] }, LAY[k] || {});
});
function strs(a) { return (Array.isArray(a) ? a : []).filter(function (t) { return typeof t === 'string' && t.trim(); }); }
function hOf(n) { return (n && (n.handle || n.tag)) || ''; }                    // the primary handle (n.tag is the older name for it)
function codesOf(n) { return strs(n && n.layers).filter(function (t) { return t !== hOf(n); }); }   // secondary names only
/* handle families. A chip's colour family is the stage its handle first appears in (box.family, else box.stage): the same chip is the same colour on the map and in every panel.
   Colours come from the renderer's CHIP_PALETTE in order of first appearance. FAMKEY: handle -> family key; FAMS: key -> {name, fill, line, ink}. */
var FAMS = {}, FAM_ORDER = [], FAMKEY = {};
var FAM_PAL = typeof CHIP_PALETTE !== 'undefined' && CHIP_PALETTE.length ? CHIP_PALETTE : [
  { fill: '#43296f', line: '#b995ff', ink: '#f6f0ff' }, { fill: '#1d3f73', line: '#6aa6ff', ink: '#eef4ff' }, { fill: '#0f4a46', line: '#3fd0bf', ink: '#e8fbf8' },
  { fill: '#5a3d0b', line: '#f0b44a', ink: '#fff6e6' }, { fill: '#2f3d4a', line: '#a9bccb', ink: '#f1f5f8' }];
function famClass(k) { return String(k).replace(/[^\w-]/g, '-'); }
var famStyle = document.createElement('style'); famStyle.id = 'famStyle'; document.head.appendChild(famStyle);
var STAGE_TITLE = {};
Object.keys(CH).forEach(function (cid) {
  var c = CH[cid];
  (Array.isArray(c.stages) ? c.stages : []).forEach(function (s) { if (s && s.id && s.title) STAGE_TITLE[s.id] = s.title; });
  (Array.isArray(c.regions) ? c.regions : []).forEach(function (r) { if (r && r.kind === 'stage' && r.id && r.title) STAGE_TITLE[r.id] = r.title; });
  ((c.geom && c.geom.clusters) || []).forEach(function (r) { if (r && r.id && r.title && !STAGE_TITLE[r.id]) STAGE_TITLE[r.id] = r.title; });
});
if (META.toolMap) (Array.isArray(DATA.stages) ? DATA.stages : []).forEach(function (s) { if (s && s.id && s.title && !STAGE_TITLE[s.id]) STAGE_TITLE[s.id] = s.title; });
/* ---- stage colours: ONE hue per stage, generated from the stage's place in the story (never named per stage). The same hue is the stage's dot in the nav, its box on
   the overview, its halo and pill on the whole map. Neighbours in the story sit far apart on the wheel (stride near 0.38 of the stages, coprime with their count),
   and every hue is used once, evenly spaced. CSS turns a hue into a colour per theme: hsl(var(--sh) var(--ss) var(--sl)) (see viewer.css). ---- */
var STAGE_LIST = (Array.isArray(DATA.stages) ? DATA.stages : []).map(function (s) { return s && s.id; }).filter(Boolean);
var STAGE_IDX = {}, STAGE_HUE = {};
(function () {
  Object.keys(CH).forEach(function (cid) { var s = CH[cid].stage; if (s && STAGE_LIST.indexOf(s) < 0 && CH[cid].kind === 'stage') STAGE_LIST.push(s); });
  var n = STAGE_LIST.length, k = Math.max(1, Math.round(n * 0.382)), gcd = function (a, b) { return b ? gcd(b, a % b) : a; };
  while (n > 1 && gcd(k, n) !== 1) k++;
  STAGE_LIST.forEach(function (id, i) { STAGE_IDX[id] = i; STAGE_HUE[id] = Math.round((205 + ((i * k) % n) * 360 / Math.max(n, 1)) % 360); });
})();
function stageNo(id) { return STAGE_IDX[id] == null ? 0 : STAGE_IDX[id] + 1; }
function stageHue(id) { return STAGE_HUE[id]; }
function stageCol(id) { return STAGE_HUE[id] == null ? '' : 'hsl(' + STAGE_HUE[id] + ' var(--ss) var(--sl))'; }           // for inline styles: resolves per theme where it is used
function stageName(id) { return STAGE_TITLE[id] || String(id).replace(/^(st|s)_/, '').replace(/[_-]+/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
var STAGE_CHARTS = {};                                                           // stage id -> its chart parts, in order
Object.keys(CH).forEach(function (cid) { var c = CH[cid]; if (c.kind === 'stage' && c.stage) (STAGE_CHARTS[c.stage] || (STAGE_CHARTS[c.stage] = [])).push(cid); });
Object.keys(STAGE_CHARTS).forEach(function (s) { STAGE_CHARTS[s].sort(function (a, b) { return (CH[a].part || 0) - (CH[b].part || 0); }); });
var HOME_OF = {};                                                                  // box id -> the stage chart that draws it
Object.keys(STAGE_CHARTS).forEach(function (sid) { STAGE_CHARTS[sid].forEach(function (cid) { Object.keys(CH[cid].nodes).forEach(function (nid) { if (!HOME_OF[nid]) HOME_OF[nid] = cid; }); }); });
function n0weak(c) { return Object.keys(c.nodes).length < 2 || !Object.keys(c.edges || {}).length; }
function stageEntry(sid) {                                                         // the part a stage opens on: where the main path enters the stage, else the part with the most boxes (never a stray one)
  var parts = STAGE_CHARTS[sid] || []; if (!parts.length) return '';
  var main = pathIdsOf(MAIN_ID), i, best = parts[0], bn = -1;
  for (i = 0; i < main.length; i++) { var c = HOME_OF[main[i]]; if (c && CH[c].stage === sid) return c; }
  parts.forEach(function (cid) { var c = CH[cid], n = Object.keys(c.nodes).length - (n0weak(c) ? 1e6 : 0); if (n > bn) { bn = n; best = cid; } });      // the biggest REAL part: a part with one box or no road inside is a stray, numbered last
  return best;
}
function stageBoxCount(id) { var n = 0; (STAGE_CHARTS[id] || []).forEach(function (cid) { n += Object.keys(CH[cid].nodes).length; }); return n; }
function ensureFam(k) {
  if (FAMS[k]) return k;
  var p = FAM_PAL[FAM_ORDER.length % FAM_PAL.length], nm = STAGE_TITLE[k] || (k === 'default' ? 'Named in the system' : String(k).replace(/^(st|s)_/, '').replace(/[_-]+/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }));
  FAMS[k] = { name: nm, fill: p.fill, line: p.line, ink: p.ink }; FAM_ORDER.push(k);
  var c = famClass(k);
  famStyle.textContent += '.fam-' + c + '{--chf:' + p.fill + ';--chl:' + p.line + ';--chi:' + p.ink + '}.atlas-svg.hf-' + c + '{--hf:' + p.line + '}:root[data-theme=light] .atlas-svg.hf-' + c + '{--hf:color-mix(in srgb,' + p.line + ' 62%,#000)}';
  return k;
}
ORDER.forEach(function (cid) {
  var c = CH[cid];
  Object.keys(c.nodes).forEach(function (nid) { var n = c.nodes[nid], t = hOf(n); if (!t || FAMKEY[t]) return; FAMKEY[t] = ensureFam(String(n.family || n.stage || 'default')); });
});
function famOf(t) { var k = FAMKEY[t] || (LAY[t] && LAY[t].family ? String(LAY[t].family) : 'default'); return ensureFam(k); }
var ALIAS_OF = null;                     // alias (lower case) -> handle, built once from the definitions
function aliasIndex() {
  if (ALIAS_OF) return ALIAS_OF; ALIAS_OF = {};
  Object.keys(LAY).forEach(function (t) { var a = LAY[t] && LAY[t].aliases; if (Array.isArray(a)) a.forEach(function (x) { if (typeof x === 'string' && x.trim() && !LAY[x]) ALIAS_OF[x.trim().toLowerCase()] = t; }); });
  return ALIAS_OF;
}
function aliasesOf(tag) { var a = LAY[tag] && LAY[tag].aliases; return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string' && x.trim(); }) : []; }
function resolveAlias(t) { var k = String(t == null ? '' : t).trim().toLowerCase(); return k && aliasIndex()[k] || null; }   // an old name -> the real name
function handleName(tag) { var i = LAY[tag]; return i && i.name && String(i.name).toLowerCase() !== String(tag).toLowerCase() ? String(i.name) : ''; }
function handleTitle(tag, suffix) { var nm = handleName(tag); return tag + (nm ? ' · ' + nm : '') + (suffix ? ' — ' + suffix : ''); }
var WBR1 = new RegExp('([._/:-])', 'g'), WBR2 = new RegExp('([a-z0-9])(?=[A-Z])', 'g');
function wbrText(t) { return esc(t).replace(WBR1, '$1<wbr>').replace(WBR2, '$1<wbr>'); }      // where a long name may wrap (after . _ / : - and between camelCase words), so a pill never breaks in the middle of a word
function hchip(tag, cls, wrap) { return '<span class="hchip fam-' + famClass(famOf(tag)) + (cls ? ' ' + cls : '') + '">' + (wrap ? '<span class="hc-t">' + wbrText(tag) + '</span>' : esc(tag)) + '</span>'; }
function hchipBtn(tag, cls) { return '<button type="button" class="hchip fam-' + famClass(famOf(tag)) + (cls ? ' ' + cls : '') + '" data-handle="' + esc(tag) + '" title="' + esc(handleTitle(tag, 'where does it engage?')) + '">' + esc(tag) + '</button>'; }
var HIDX = null;
function buildHandleIndex() {
  HIDX = {};
  var get = function (t) { var k = (!LAY[t] && resolveAlias(t)) || t; return HIDX[k] || (HIDX[k] = { tag: k, refs: [], charts: {} }); };   // a stale alias folds into the real name
  var rankC = { stage: 0, detail: 1, whole: 2, overview: 3 }, home = Object.keys(CH).map(function (id, i) { return { id: id, i: i, r: rankC[CH[id].kind] == null ? 1.5 : rankC[CH[id].kind] }; }).sort(function (a, b) { return a.r - b.r || a.i - b.i; }).map(function (x) { return x.id; });
  home.forEach(function (cid) {                                                    // a box is drawn on its stage part, again on the whole map, maybe on a detail view: it is ONE box. It is counted where it is drawn in detail first, and once.
    var c = CH[cid];
    Object.keys(c.nodes).forEach(function (nid) {
      var n = c.nodes[nid], seen = {};
      strs([hOf(n)].concat(strs(n.layers))).forEach(function (t) {
        if (!t || seen[t]) return; seen[t] = 1;
        var h = get(t); if (!h.nodeSeen) h.nodeSeen = {}; if (h.nodeSeen[nid]) return; h.nodeSeen[nid] = 1;
        h.refs.push({ chart: cid, node: nid, primary: t === hOf(n) }); h.charts[cid] = (h.charts[cid] || 0) + 1;
      });
    });
    strs(c.codes).forEach(get);
  });
  Object.keys(LAY).forEach(get);
  Object.keys(HIDX).forEach(function (t) { var h = HIDX[t]; h.fam = famOf(t); h.info = LAY[t] || null; h.count = h.refs.length; });
}
function handles() { if (!HIDX) buildHandleIndex(); return HIDX; }
function findHandle(t) {
  var H = handles(); if (!t) return null;
  if (H[t]) return H[t];
  var low = String(t).toLowerCase(), k = Object.keys(H).filter(function (x) { return x.toLowerCase() === low; })[0];
  if (!k) { var al = resolveAlias(t); if (al && H[al]) k = al; }        // an alias -> the real name
  return k ? H[k] : null;
}
function tagSort(a, b) {
  var A = HIDX[a], B = HIDX[b], oa = A.info && typeof A.info.order === 'number' ? A.info.order : null, ob = B.info && typeof B.info.order === 'number' ? B.info.order : null;
  if (oa != null && ob != null && oa !== ob) return oa - ob;
  var na = parseInt((/\d+/.exec(a) || [''])[0], 10), nb = parseInt((/\d+/.exec(b) || [''])[0], 10);
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}
function nodesWithHandle(tag) {
  var h = findHandle(tag); return h ? h.refs : [];
}

/* ================================================================ dom refs */
var app = $('#app'), nav = $('#nav'), navSelect = $('#navSelect'), canvas = $('#canvas'), insp = $('#inspector');
var chartView = $('#chartView'), readingView = $('#readingView'), tip = $('#tip'), sr = $('#sr');
var qInput = $('#q'), qAllBtn = $('#qAll'), qCount = $('#qCount'), qResults = $('#qResults');
var legendEl = $('#legend'), onboardEl = $('#onboard'), miniEl = $('#mini'), miniCanvas = $('#miniCanvas'), miniView = $('#miniView');
var pickBanner = $('#pickBanner');

/* ================================================================ state */
var S = { reading: null, sel: null, trace: null, pickFrom: null, alt: null, hover: null, autoFit: true, qAll: false, matches: [], matchIdx: -1, lastChart: FIRST, handle: null, hpanel: null, hsw: 0, hpaints: 0, pre: null };
var C = null;                         // the mounted chart context
var view = { s: 1, x: 0, y: 0 };      // screen = world * s + (x, y)
var cw = 0, ch = 0;                   // canvas size in CSS px

/* ---- the small internal API (documented at the top of this file) ---- */
var chartHooks = [], zoomHooks = [], paintHooks = [], lastZoom = 1;
function fire(list) { var a = Array.prototype.slice.call(arguments, 1); list.slice().forEach(function (fn) { try { fn.apply(null, a); } catch (e) { if (window.console) console.error(e); } }); }
var FL = {
  chart: function () { return C; },
  scale: function () { return view.s; },
  onChart: function (fn) { chartHooks.push(fn); if (C) { try { fn(C); } catch (e) { if (window.console) console.error(e); } } },
  onZoom: function (fn) { zoomHooks.push(fn); },
  onPaint: function (fn) { paintHooks.push(fn); },                  // fn() after every focus repaint (hover, pin, region): viewer/whole.js lights long roads and their labels from it
  small: function () { return smallOn(); },
  smallAsked: function () { return smallOn() && !(S.smallFor && S.smallFor.auto); },       // the smaller view because a person pressed All at once (a pin that is shown whole is a smaller view too, but nobody asked)
  prose: function (s) { return typeof gdProse === 'function' ? gdProse(s) : esc(s); },
  plain: function (s) { return typeof gdPlain === 'function' ? gdPlain(s) : String(s == null ? '' : s); },       // text the checks wrote, as a reader should see it (guides.js)
  minPx: function (kind) { return minPxFor(kind); },
  openPanel: function (title, html, o) { return openDock(title, html, o); },
  closePanel: function () { closeDock(); }
};

function announce(t) { sr.textContent = ''; setTimeout(function () { sr.textContent = t; }, 30); }

/* ================================================================ navigation list
   Start-here items, then ONE row per stage (number, colour dot, name, box count), collapsed; the current stage is expanded and lists its parts by name.
   A stage row opens that stage's first part. Charts that belong to no stage (other views, anything else) stay a flat list. The phone select has one optgroup per stage. */
var navStage = '';
function navGroups() {                                       // [{group, items:[chartId], stages:[stageId]|null}] from the data's own nav groups
  var out = [], seen = {};
  GROUPS.forEach(function (g) {
    var plain = [], stages = [];
    g.items.forEach(function (id) {
      var c = CH[id];
      if (c.kind === 'stage' && c.stage && STAGE_CHARTS[c.stage]) { if (!seen[c.stage]) { seen[c.stage] = 1; stages.push(c.stage); } }
      else plain.push(id);
    });
    if (plain.length) out.push({ group: g.group, items: plain, stages: null });
    if (stages.length) out.push({ group: 'Stages', items: [], stages: stages });
  });
  return out;
}
function navItemHTML(id, label, chip, extra) {
  var c = CH[id], n = Object.keys(c.nodes).length;
  return '<li><button class="nav-item' + (extra || '') + '" type="button" data-chart="' + esc(id) + '" title="' + esc((extra && extra.indexOf('nav-part') >= 0 ? label + ' · part ' + chip + ' · ' : (c.navSub || c.title) + ' · ') + n + (c.kind === 'overview' ? ' boxes: the stages and the groups of endings' : ' boxes')) + '">' +
    '<span class="ni-chip" aria-hidden="true">' + chip + '</span><span class="ni-label">' + esc(label) + '</span><span class="ni-count" aria-label="' + n + ' boxes">' + n + '</span></button></li>';
}
var TN = { open: {}, small: {}, stage: '', chart: '', of: null };
function toolNavStageOf(id) { if (!TN.of) { TN.of = {}; (DATA.nav || []).forEach(function (g) { if (g.fold) g.items.forEach(function (x) { TN.of[x] = g.stage; }); }); } return TN.of[id] || ''; }
function toolRowHTML(r) {
  var n = r.parts.length, on = r.parts.indexOf(TN.chart) >= 0;
  if (!CH[r.id]) return '';
  var h = '<li class="nav-fn' + (on ? ' on' : '') + '"><button class="nav-item nav-row" type="button" data-chart="' + esc(r.id) + '" title="' + esc(r.label + ' · ' + r.boxes + ' boxes' + (n > 1 ? ', in ' + n + ' parts' : '')) + '"><span class="ni-chip" aria-hidden="true">' + (n > 1 ? n : '·') + '</span><span class="ni-label">' + esc(r.label) + '</span><span class="ni-count" aria-label="' + r.boxes + ' boxes">' + r.boxes + ' boxes</span></button>';
  if (n > 1 && on) h += '<ul class="nav-parts">' + r.parts.map(function (id, i) { return '<li><button class="nav-item nav-part" type="button" data-chart="' + esc(id) + '"><span class="ni-chip" aria-hidden="true">' + (i + 1) + '</span><span class="ni-label">Part ' + (i + 1) + ' of ' + n + '</span></button></li>'; }).join('') + '</ul>';
  return h + '</li>';
}
function toolPagesHTML() {                                       // the pages a newcomer looks for first: in the top bar, and above the phone's list
  var T = META.toolMap;
  return (T.guides || []).filter(function (x) { return x.top; }).map(function (x) { return '<button type="button" class="hw-page" data-reader-view="' + esc(x.view) + '" title="' + esc(x.label + ' · ' + x.count + ' ' + x.word) + '">' + esc(x.label) + ' <b>' + x.count + '</b></button>'; }).join('') + GUIDES.filter(function (x) { return x.top && (T.hideGuides || []).indexOf(x.id) < 0; }).map(function (x) { var cnt = x.count ? x.count() : 0; return '<button type="button" class="hw-page" data-reading="' + x.id + '" title="' + esc(x.title + ' · ' + cnt + ' ' + (x.countWord || 'open questions')) + '">' + esc(x.label) + ' <b>' + cnt + '</b></button>'; }).join('');
}
function buildToolNav() {
  var T = META.toolMap, h = '', sel = '', g0 = (DATA.nav || [])[0];
  h += '<div class="nav-group"><h2 class="nav-h">Start here</h2><ul>' + (g0 ? g0.items.map(function (id) { var c = CH[id]; return c ? navItemHTML(id, c.navLabel, isWhole(c) ? '★' : (c.kind === 'overview' ? '◎' : '·'), '') : ''; }).join('') : '') + '</ul></div>';
  h += '<div class="nav-group nav-guides"><h2 class="nav-h">Guides</h2><ul>';
  (T.guides || []).forEach(function (x) { h += '<li><button class="nav-item nav-break" type="button" data-reader-view="' + esc(x.view) + '" title="' + esc(x.label + ' · ' + x.count + ' ' + x.word) + '"><span class="ni-chip" aria-hidden="true">' + x.chip + '</span><span class="ni-label">' + esc(x.label) + '</span><span class="ni-count">' + x.count + '</span></button></li>'; });
  GUIDES.forEach(function (x) {
    if ((T.hideGuides || []).indexOf(x.id) >= 0) return;
    var cnt = x.top ? (x.count ? x.count() : 0) : null;
    h += '<li><button class="nav-item' + (x.top ? ' nav-break' : '') + '" type="button" data-reading="' + x.id + '" title="' + esc(x.title) + '"><span class="ni-chip" aria-hidden="true">' + x.chip + '</span><span class="ni-label">' + esc(x.label) + '</span>' + (cnt !== null ? '<span class="ni-count" aria-label="' + cnt + '">' + cnt + '</span>' : '') + '</button></li>';
  });
  h += '</ul></div><div class="nav-group"><h2 class="nav-h">Stages<span class="nav-h-n" title="Beside a stage: how many of its functions are drawn on a chart (the stage card on the Reader home counts every function in it). Beside a function: how many boxes it has of its own."></span></h2><ul>';
  var no = 0;
  (DATA.nav || []).forEach(function (g) {
    if (!g.fold) return;
    no++;
    var hasCur = g.stage === toolNavStageOf(TN.chart), isOpen = TN.open[g.stage] !== undefined ? TN.open[g.stage] : hasCur;
    h += '<li class="nav-st' + (isOpen ? ' open' : '') + (hasCur ? ' has-cur' : '') + '"><button class="nav-item nav-stage" type="button" data-tstage="' + esc(g.stage) + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '" style="--sh:' + stageHue(g.stage) + '" title="' + esc(g.group + ' · ' + g.rows.length + ' functions with a chart, ' + g.small.length + ' small') + '"><span class="ni-chip" aria-hidden="true">' + no + '</span><span class="ns-no" aria-hidden="true">' + no + '</span><i class="ni-dot" aria-hidden="true"></i><span class="ni-label">' + esc(g.group) + '</span><span class="ni-count">' + (g.rows.length + g.small.length) + ' drawn' + '</span></button>';
    if (isOpen) {
      h += '<ul class="nav-fns" style="--sh:' + stageHue(g.stage) + '">' + g.rows.map(toolRowHTML).join('');
      if (g.small.length) {
        var so = !!TN.small[g.stage] || g.small.some(function (r) { return r.parts.indexOf(TN.chart) >= 0; });
        h += '<li class="nav-sm"><button class="nav-more" type="button" data-tsmall="' + esc(g.stage) + '" aria-expanded="' + (so ? 'true' : 'false') + '">' + (so ? 'Hide' : 'Show') + ' ' + g.small.length + ' functions of one or two boxes</button></li>' + (so ? g.small.map(toolRowHTML).join('') : '');
      }
      h += '</ul>';
    }
    h += '</li>';
    sel += '<optgroup label="' + esc(no + '. ' + g.group) + '">' + g.rows.concat(g.small).map(function (r) { return '<option value="chart:' + esc(r.id) + '">' + esc(r.label) + '</option>'; }).join('') + '</optgroup>';
  });
  h += '</ul></div>';
  nav.innerHTML = h;
  navSelect.innerHTML = '<optgroup label="Start here">' + (g0 ? g0.items.map(function (id) { return '<option value="chart:' + esc(id) + '">' + esc(CH[id].navLabel) + '</option>'; }).join('') : '') + '</optgroup>' + '<optgroup label="Guides">' + GUIDES.filter(function (x) { return (T.hideGuides || []).indexOf(x.id) < 0; }).map(function (x) { return '<option value="reading:' + x.id + '">' + esc(x.label) + '</option>'; }).join('') + '</optgroup>' + sel;
  var hp = $('#hwPages');
  if (hp) hp.innerHTML = toolPagesHTML();
  markNavCurrent(true);
}
nav.addEventListener('click', function (e) {
  var t = e.target.closest ? e.target.closest('[data-tstage],[data-tsmall]') : null; if (!t) return;
  if (t.dataset.tstage) { var s = t.dataset.tstage, was = t.getAttribute('aria-expanded') === 'true'; TN.open[s] = !was; if (CH.overview && CH.overview.nodes[s]) setTimeout(function () { openChart('overview', s, { push: true }); }, 0); } else TN.small[t.dataset.tsmall] = t.getAttribute('aria-expanded') !== 'true';
  buildNav();
});
/* a tool map draws no chart for a stage, so opening a stage (a double-click on the poster, the button in its panel, a tap on the phone) lists the functions it holds; a click on one opens its chart */
function toolStageOf(sid) { var r = null; (DATA.nav || []).forEach(function (g) { if (g.fold && g.stage === sid) r = g; }); return r; }
function toolFnRowHTML(r) { return '<li><button type="button" class="tsf-row" data-tfn="' + esc(r.id) + '"><span class="tsf-nm">' + esc(r.label) + '</span><span class="tsf-n">' + r.boxes + (r.boxes === 1 ? ' box' : ' boxes') + (r.parts.length > 1 ? ', ' + r.parts.length + ' parts' : '') + '</span></button></li>'; }
function openToolStage(sid) {
  var g = toolStageOf(sid); if (!g) return false;
  TN.open[sid] = true; buildNav();
  var n = g.rows.length + g.small.length;
  var html = '<p class="hp-note">' + esc(stageName(sid)) + ' holds ' + n + ' function' + (n === 1 ? '' : 's') + ' with a chart. Open one to see how it runs.</p><ul class="tsf-list">' + g.rows.map(toolFnRowHTML).join('') + '</ul>' +
    (g.small.length ? '<p class="hp-note">Functions of one or two boxes:</p><ul class="tsf-list">' + g.small.map(toolFnRowHTML).join('') + '</ul>' : '');
  openDock(stageName(sid) + ': its functions', html, { wide: false, onClick: function (e) { var b = e.target.closest('[data-tfn]'); if (b && CH[b.dataset.tfn]) { pushJump(); openChart(b.dataset.tfn, null, { push: true }); closeDock(); } } });
  return true;
}
function buildNav() {
  if (META.toolMap) { buildToolNav(); return; }
  var h = '', sel = '';
  navGroups().forEach(function (g, gi) {
    h += '<div class="nav-group"><h2 class="nav-h">' + esc(g.group) + (g.stages ? '<span class="nav-h-n" title="The number beside each stage is how many boxes it holds">boxes</span>' : '') + '</h2><ul>';
    if (g.stages) {
      g.stages.forEach(function (sid) {
        var parts = STAGE_CHARTS[sid], open = sid === navStage, first = stageEntry(sid), no = stageNo(sid);
        h += '<li class="nav-st' + (open ? ' open' : '') + '"><button class="nav-item nav-stage" type="button" data-chart="' + esc(first) + '" data-stage="' + esc(sid) + '" aria-expanded="' + (open ? 'true' : 'false') + '" style="--sh:' + stageHue(sid) + '" title="' + esc(stageName(sid) + ' · ' + stageBoxCount(sid) + ' boxes in ' + parts.length + (parts.length === 1 ? ' chart' : ' charts')) + '">' +
          '<span class="ni-chip" aria-hidden="true">' + (no || '·') + '</span><span class="ns-no" aria-hidden="true">' + (no || '') + '</span><i class="ni-dot" aria-hidden="true"></i><span class="ni-label">' + esc(stageName(sid)) + '</span><span class="ni-count" aria-label="' + stageBoxCount(sid) + ' boxes">' + stageBoxCount(sid) + '</span></button>';
        if (open && parts.length > 1) h += '<ul class="nav-parts" style="--sh:' + stageHue(sid) + '">' + parts.map(function (id, i) { return navItemHTML(id, CH[id].name || CH[id].navLabel, i + 1, ' nav-part'); }).join('') + '</ul>';
        h += '</li>';
      });
    } else g.items.forEach(function (id) { var c = CH[id]; h += navItemHTML(id, c.navLabel, isWhole(c) ? '★' : (c.kind === 'overview' ? '◎' : '·'), isWhole(c) ? ' nav-star' : ''); });
    if (gi === 0) GUIDES.forEach(function (x) { if (x.top) { var n = x.count ? x.count() : 0, cw0 = x.countWord || 'open questions'; h += '<li><button class="nav-item nav-break" type="button" data-reading="' + x.id + '" title="' + esc(x.title + ' · ' + n + ' ' + cw0) + '"><span class="ni-chip" aria-hidden="true">' + x.chip + '</span><span class="ni-label">' + esc(x.label) + '</span><span class="ni-count" aria-label="' + n + ' ' + cw0 + '">' + n + '</span></button></li>'; } });
    h += '</ul></div>';
    if (gi === 0 && typeof scenarioIds === 'function' && scenarioIds().length) {      // Walk a scenario: every declared path but the main one, one row each; a click starts the walk
      var sc = scenarioIds(), open = store.get(KEY.scen, sc.length <= 8 ? 'open' : 'closed') === 'open';
      h += '<div class="nav-group nav-scen-g"><h2 class="nav-h"><button type="button" class="nav-wh" id="navScenBtn" aria-expanded="' + open + '" aria-controls="navScen" title="Each one is a story the code declares, other than the main path. A click starts a walk through it."><span>Walk a scenario</span><span class="nw-n">' + sc.length + '</span><span class="nw-c" aria-hidden="true">›</span></button></h2><ul class="nav-scen" id="navScen"' + (open ? '' : ' hidden') + '>' +
        sc.map(function (pid) { var n = pathIdsOf(pid).filter(function (b) { return !!boxAny(b); }).length; return '<li><button class="nav-item nav-walk" type="button" data-walk="' + esc(pid) + '" title="' + esc(PATHS[pid].title + ' · ' + n + ' steps. ' + (PATHS[pid].blurb || '')) + '"><span class="ni-chip" aria-hidden="true">▶</span><span class="ni-label">' + esc(PATHS[pid].title) + '</span><span class="ni-count" aria-label="' + n + ' steps">' + n + '</span></button></li>'; }).join('') + '</ul></div>';
    }
  });
  if (GUIDES.length) {
    h += '<div class="nav-group"><h2 class="nav-h">Guides</h2><ul>';
    GUIDES.forEach(function (g) {
      if (g.top) return;
      h += '<li><button class="nav-item" type="button" data-reading="' + g.id + '" title="' + esc(g.title) + '"><span class="ni-chip" aria-hidden="true">' + g.chip + '</span><span class="ni-label">' + esc(g.label) + '</span></button></li>';
    });
    h += '</ul></div>';
  }
  nav.innerHTML = h;
  navGroups().forEach(function (g) {                         // phone menu: one optgroup per stage
    if (g.stages) g.stages.forEach(function (sid) { sel += '<optgroup label="' + esc(stageNo(sid) + '. ' + stageName(sid)) + '">' + STAGE_CHARTS[sid].map(function (id) { return '<option value="chart:' + esc(id) + '">' + esc(CH[id].name || CH[id].navLabel) + '</option>'; }).join('') + '</optgroup>'; });
    else sel += '<optgroup label="' + esc(g.group) + '">' + g.items.map(function (id) { return '<option value="chart:' + esc(id) + '">' + esc(CH[id].navLabel) + '</option>'; }).join('') + '</optgroup>';
  });
  /* this menu is the phone's chart list (it is not shown on any other window), and the phone does not offer the walk (phone.css): no "Walk a scenario" group here */
  if (GUIDES.length) sel += '<optgroup label="Guides">' + GUIDES.map(function (g) { return '<option value="reading:' + g.id + '">' + esc(g.label) + '</option>'; }).join('') + '</optgroup>';
  navSelect.innerHTML = sel;
  var hp = $('#hwPages');                                          // the top bar names the two pages a newcomer looks for first (shown under 1500 px, where the rail is glyphs)
  if (hp) hp.innerHTML = GUIDES.filter(function (x) { return x.top; }).map(function (x) { var cnt = x.count ? x.count() : 0; return '<button type="button" class="hw-page" data-reading="' + x.id + '" title="' + esc(x.title + ' · ' + cnt + ' ' + (x.countWord || 'open questions')) + '">' + esc(x.label) + ' <b>' + cnt + '</b></button>'; }).join('');
  markNavCurrent(true);
}
document.addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('.hw-page') : null; if (b && b.dataset.reading) openReading(b.dataset.reading, { push: true }); });
function markNavCurrent(noRebuild) {
  if (META.toolMap) { var cs = !S.reading && C ? toolNavStageOf(C.id) : '', cc = !S.reading && C ? C.id : ''; var moved = cs !== TN.stage || cc !== TN.chart; TN.stage = cs; TN.chart = cc; if (moved && !noRebuild) { buildNav(); return; } }
  var st = !S.reading && C && C.chart.kind === 'stage' ? C.chart.stage || '' : '';
  if (st !== navStage && !noRebuild) { navStage = st; buildNav(); return; }
  navStage = st;
  var multi = !!(st && STAGE_CHARTS[st] && STAGE_CHARTS[st].length > 1);
  $$('.nav-item', nav).forEach(function (b) {
    var on = S.reading ? b.dataset.reading === S.reading : (!!C && b.dataset.chart === C.id && !(b.dataset.stage && multi));
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    b.classList.toggle('in-stage', !!(b.dataset.stage && b.dataset.stage === st && !S.reading));
  });
  var cur = $('.nav-item[aria-current]', nav) || $('.nav-item.in-stage', nav);
  if (cur && cur.scrollIntoView) { var r = cur.getBoundingClientRect(), nr = nav.getBoundingClientRect(); if (nr.height > 0 && (r.top < nr.top + 4 || r.bottom > nr.bottom - 4)) cur.scrollIntoView({ block: 'nearest' }); }
  navSelect.value = S.reading ? 'reading:' + S.reading : (C ? 'chart:' + C.id : '');
  $$('.hw-page').forEach(function (b) { if (S.reading && b.dataset.reading === S.reading) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
}
nav.addEventListener('click', function (e) {
  var sb = e.target.closest('#navScenBtn');
  if (sb) { var op = sb.getAttribute('aria-expanded') !== 'true'; sb.setAttribute('aria-expanded', op ? 'true' : 'false'); $('#navScen', nav).hidden = !op; store.set(KEY.scen, op ? 'open' : 'closed'); return; }
  var b = e.target.closest('.nav-item'); if (!b) return;
  if (b.dataset.walk) { startWalk(b.dataset.walk); return; }
  if (b.dataset.chart) openChart(b.dataset.chart, null, { push: true });
  else if (b.dataset.reading) openReading(b.dataset.reading, { push: true });
});
/* the slim rail (a laptop-sized window) shows pictures and numbers only, so what is under the pointer is named at once: its name and its count, in a small card beside the rail. (A title attribute waits a second and cannot be styled.) */
(function () {
  var rt = document.createElement('div'); rt.id = 'railTip'; rt.className = 'rail-tip'; rt.hidden = true; rt.setAttribute('aria-hidden', 'true'); document.body.appendChild(rt);
  function hide() { rt.hidden = true; }
  function show(b) {
    if (!b || app.dataset.nav !== 'collapsed') { hide(); return; }
    var lab = $('.ni-label', b), n = $('.ni-count', b); if (!lab) { hide(); return; }
    rt.innerHTML = esc(lab.textContent) + (n ? '<b>' + esc(n.textContent) + '</b>' : ''); rt.hidden = false;
    var r = b.getBoundingClientRect(); rt.style.left = Math.round(r.right + 6) + 'px'; rt.style.top = Math.round(Math.max(4, r.top + r.height / 2 - rt.offsetHeight / 2)) + 'px';
  }
  nav.addEventListener('mouseover', function (e) { show(e.target.closest ? e.target.closest('.nav-item') : null); });
  nav.addEventListener('mouseleave', hide); nav.addEventListener('focusout', hide); nav.addEventListener('click', hide);
  nav.addEventListener('focusin', function (e) { show(e.target.closest ? e.target.closest('.nav-item') : null); });
  nav.addEventListener('scroll', hide, { passive: true });
})();
navSelect.addEventListener('change', function () {
  var v = navSelect.value.split(':');
  if (v[0] === 'walk') { startWalk(v.slice(1).join(':')); return; }
  if (v[0] === 'chart') openChart(v[1], null, { push: true }); else openReading(v[1], { push: true });
});

/* ================================================================ header controls */
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  var b = $('#themeBtn');
  b.textContent = t === 'dark' ? 'Light mode' : 'Dark mode';
  b.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  store.set(KEY.theme, t);
  miniColors = null; if (mm) mm.bmp = null; drawMini();
}
$('#themeBtn').addEventListener('click', function () { setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); });
/* Nav and details panel: the whole map opens with both collapsed so the map gets the window; every other chart follows the saved choice. A toggle on the whole map is remembered
   for the session only (sessionStorage, guarded), a toggle elsewhere is remembered for good. */
var ss = {
  get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } }
};
var PANEL_KEY = { nav: 'faultline-whole-nav', insp: 'faultline-whole-insp' };
function wholeNow() { return !S.reading && !!S.viewing && !!CH[S.viewing] && isWhole(CH[S.viewing]); }
function panelWanted(which) {                          // 'collapsed' or 'open': ONE choice for every chart and guide, changed only by the person. The sidebar starts open. The details panel starts closed (it is 340 px of the chart's room)
  if (which === 'insp') return store.get(KEY.insp, '') === 'open' ? 'open' : 'collapsed';   // and opens by itself only for a pin (afterSelChange), and goes again when the pin is cleared; a choice made with the Details button is kept as it is
  return store.get(KEY.nav, narrowWin() ? 'collapsed' : 'open') === 'collapsed' ? 'collapsed' : 'open';      // on a window under 1500 px wide the sidebar starts as its slim rail (the chart needs the room); the person's own choice is kept
}
function inspAuto() { return !store.get(KEY.insp, ''); }                                   // true until the person has opened or closed the details panel with the button
function applyPanelDefaults() { setNavCollapsed(panelWanted('nav') === 'collapsed', true); setInspCollapsed(panelWanted('insp') === 'collapsed', true); }
function setNavCollapsed(c, quiet) {
  app.dataset.nav = c ? 'collapsed' : 'open';
  var b = $('#navToggle');
  b.setAttribute('aria-expanded', c ? 'false' : 'true');
  b.setAttribute('aria-label', c ? 'Expand the chart list' : 'Collapse the chart list');
  b.title = c ? 'Expand the chart list' : 'Collapse the chart list';
  if (!quiet) store.set(KEY.nav, c ? 'collapsed' : 'open');
}
$('#navToggle').addEventListener('click', function () { setNavCollapsed(app.dataset.nav !== 'collapsed'); });
function setInspCollapsed(c, quiet) {
  app.dataset.insp = c ? 'collapsed' : 'open';
  if (C && !S.reading && !S.autoFit) { var ow = cw, oh = ch; measure(); relayout(ow, oh, true); }      // a chart that is not on automatic fit stays where it is; the canvas is measured now, so the resize observer finds nothing left to move
  $('#inspToggle').setAttribute('aria-pressed', c ? 'false' : 'true');
  if (!quiet) store.set(KEY.insp, c ? 'collapsed' : 'open');
}
$('#inspToggle').addEventListener('click', function () { S.roomed = false; S.pinOpened = false; setInspCollapsed(app.dataset.insp !== 'collapsed'); });      // the reader's own choice ends the automatic one
$('#legendBtn').addEventListener('click', function () { toggleLegend(legendEl.hidden); });
function toggleLegend(show) {
  if (show && S.hpanel) closeHandles();
  if (show && !dockEl.hidden) closeDock();
  legendEl.hidden = !show;
  $('#legendBtn').setAttribute('aria-expanded', show ? 'true' : 'false');
  if (show) { legendEl.innerHTML = legendHTML(); var c = $('.lg-close', legendEl); if (c) c.focus(); }
  reseatBar(true);       // the legend lies over the right of the canvas and no refit follows: the bar steps aside while it is open, and comes back when it closes
}
legendEl.addEventListener('click', function (e) {
  if (e.target.closest('.lg-close')) { toggleLegend(false); $('#legendBtn').focus(); }
  if (e.target.closest('.lg-howto')) { toggleLegend(false); showOnboard(true); }
});
$('#onboardOk').addEventListener('click', function () { store.set(KEY.onboard, '1'); onboardEl.hidden = true; canvas.focus({ preventScroll: true }); });
function showOnboard(force) {
  if (S.reading) { onboardEl.hidden = true; return; }
  onboardEl.hidden = force ? false : store.get(KEY.onboard, '') === '1';
}
$('#chartSummary').addEventListener('click', function () { var t = $('#chartSummary'); t.classList.toggle('open'); t.setAttribute('aria-expanded', t.classList.contains('open') ? 'true' : 'false'); });
$('#chartSummary').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.click(); } });

/* ================================================================ legend */
/* box kinds and route types actually present in the data (contract order first, then anything else the renderer drew) */
function usedKinds() {
  var seen = {}, order = Object.keys(KINDS), out = [];
  Object.keys(CH).forEach(function (cid) { var c = CH[cid]; Object.keys(c.nodes).forEach(function (nid) { seen[kindOf(c.nodes[nid]).toLowerCase()] = kindOf(c.nodes[nid]); }); });
  order.forEach(function (k) { if (seen[k]) out.push(seen[k]); });
  Object.keys(seen).forEach(function (k) { if (order.indexOf(k) < 0) out.push(seen[k]); });
  return out.length ? out : order;
}
function usedTypes() {
  var seen = {}, order = ['forward', 'deliver', 'record', 'return'], out = [];
  Object.keys(CH).forEach(function (cid) { var E = CH[cid].edges; Object.keys(E).forEach(function (k) { seen[E[k].type || 'forward'] = 1; }); });
  order.forEach(function (t) { if (seen[t]) out.push(t); });
  Object.keys(seen).forEach(function (t) { if (order.indexOf(t) < 0) out.push(t); });
  return out.length ? out : ['forward', 'return'];
}
function edgeColor(t) { return (typeof EDGE !== 'undefined' && EDGE[t] && EDGE[t].color) || (t === 'return' ? '#ec8f86' : '#8fb0ba'); }
function edgeDash(t) { return (typeof EDGE !== 'undefined' && EDGE[t] && EDGE[t].dash) || (t === 'return' && !(typeof EDGE !== 'undefined' && EDGE[t]) ? '7 5' : ''); }
function typeWord(t) { return TYPE_WORDS[t] || String(t).replace(/^./, function (c) { return c.toUpperCase(); }); }
function isWaitKind(k) { var K = kindStyle(k); return K ? !!K.dash : /^wait$/i.test(k); }
function isEndKind(k) { var K = kindStyle(k); return K ? !!K.pill : /^end$/i.test(k); }
function anyHandles() { return Object.keys(handles()).length > 0; }
function exampleHandle(fam) { var H = handles(), ks = Object.keys(H); for (var i = 0; i < ks.length; i++) if (H[ks[i]].fam === fam && H[ks[i]].count) return ks[i]; for (i = 0; i < ks.length; i++) if (H[ks[i]].fam === fam) return ks[i]; return ''; }

function legendHTML() {
  var cats = usedKinds().map(function (k) { var i = kindInfo(k); return [k, i.help || 'a ' + i.label.toLowerCase() + ' box']; });
  var types = usedTypes();
  var marks = types.map(function (t) {
    return '<marker id="lg-arr-' + t + '" viewBox="0 0 12 12" refX="10.5" refY="6" markerWidth="11" markerHeight="11" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1.2 L11 6 L1 10.8 L3.6 6 Z" fill="' + edgeColor(t) + '"/></marker>';
  }).join('') +
    ['in', 'out'].map(function (t) { return '<marker id="lg-arr-' + t + '" viewBox="0 0 12 12" refX="10.5" refY="6" markerWidth="12" markerHeight="12" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1.2 L11 6 L1 10.8 L3.6 6 Z" fill="var(--' + t + ')"/></marker>'; }).join('');
  var h = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' + marks + '</defs></svg>' +
    '<button class="lg-close" type="button">Close</button><h3>Boxes: what kind of step</h3>';
  cats.forEach(function (c) {
    var col = catColor(c[0]), dash = isWaitKind(c[0]) ? ' stroke-dasharray="6 3.5"' : '', rx = isEndKind(c[0]) ? 11 : 5;
    h += '<div class="lg-row"><svg class="atlas-svg" width="38" height="24" viewBox="0 0 38 24" aria-hidden="true"><rect x="2" y="2" width="34" height="20" rx="' + rx + '" fill="var(--a-node)" stroke="' + col + '" stroke-width="2.4"' + dash + '/>' +
      (isEndKind(c[0]) ? '' : String(c[0]).toLowerCase() === 'decision' ? '<path d="M3 12 L8 4.5 L13 12 L8 19.5 Z" fill="' + col + '" stroke="' + col + '" stroke-width="1.4" stroke-linejoin="round"/>' : '<rect x="3" y="6" width="3.5" height="12" rx="1.7" fill="' + col + '"/>') + '</svg><span><b>' + esc(kindInfo(c[0]).label) + '</b><small>' + esc(c[1]) + '</small></span></div>';
  });
  h += '<h3>Arrows: what kind of road</h3>';
  types.forEach(function (t) {
    var dsh = edgeDash(t);
    h += '<div class="lg-row"><svg width="58" height="18" viewBox="0 0 58 18" aria-hidden="true"><line x1="3" y1="9" x2="50" y2="9" stroke="' + edgeColor(t) + '" stroke-width="2.6"' + (dsh ? ' stroke-dasharray="' + dsh + '"' : '') + ' marker-end="url(#lg-arr-' + t + ')"/></svg><span><b>' + esc(typeWord(t)) + '</b><small>' + esc(TYPE_HELP[t] || '') + '</small></span></div>';
  });
  var ring = function (col, glyph, n, dir) {
    return '<svg class="atlas-svg" width="58" height="30" viewBox="0 0 58 30" aria-hidden="true"><rect x="5" y="4" width="40" height="20" rx="5" fill="var(--a-node)" stroke="' + col + '" stroke-width="3"/><rect x="29" y="18" width="24" height="12" rx="6" fill="' + col + '"/><path d="' + glyph + '" transform="translate(' + (dir === 'in' ? 36 : 36) + ' 24)" fill="none" stroke="var(--p-ink-' + dir + ')" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><text x="46" y="27.4" font-size="9" font-weight="700" text-anchor="middle" fill="var(--p-ink-' + dir + ')">' + n + '</text></svg>';
  };
  h += '<h3>Rings and badges on boxes</h3>' +
    '<div class="lg-row">' + ring('var(--p-in)', 'M3.6 -3 V3 M-3.4 0 H1.6 M-0.8 -2.4 L1.8 0 L-0.8 2.4', '2', 'in') + '<span><b>Teal ring, arrow in</b><small>roads arrive here from another chart; the number counts them</small></span></div>' +
    '<div class="lg-row">' + ring('var(--p-out)', 'M-3.6 -3 V3 M-1.6 0 H3.4 M0.8 -2.4 L3.4 0 L0.8 2.4', '3', 'out') + '<span><b>Orange ring, arrow out</b><small>roads leave from here for another chart</small></span></div>' +
    '<div class="lg-row"><svg class="atlas-svg" width="58" height="30" viewBox="0 0 58 30" aria-hidden="true"><rect x="12" y="6" width="34" height="18" rx="5" fill="var(--a-node)" stroke="var(--muted)" stroke-width="1.6"/><path d="M2 15 L11 9.5 V20.5 Z" fill="var(--spine,#b6f04a)"/><path d="M56 15 L47 9.5 V20.5 Z" fill="var(--spine,#b6f04a)"/></svg><span><b>Green notch</b><small>with Main path on: the path arrives here from another chart (left) or leaves for one (right)</small></span></div>';
  h += '<h3>Pills and tints</h3>' +
    '<div class="lg-row"><svg width="58" height="24" viewBox="0 0 58 24" aria-hidden="true"><rect x="2" y="3" width="54" height="18" rx="9" fill="color-mix(in srgb,var(--accent) 22%,var(--panel))" stroke="var(--accent)" stroke-width="1.4"/><circle cx="12" cy="12" r="6" fill="var(--accent)"/><rect x="23" y="10" width="26" height="4" rx="2" fill="var(--accent)" opacity=".6"/></svg><span><b>Stage pill</b><small>a stage&rsquo;s number and name on the whole map. Hover lights its roads in and out; click zooms to it</small></span></div>' +
    '<div class="lg-row"><svg class="atlas-svg" width="58" height="24" viewBox="0 0 58 24" aria-hidden="true"><rect x="3" y="3" width="52" height="18" rx="9" fill="var(--a-node)" stroke="' + catColor('end') + '" stroke-width="2.2"/></svg><span><b>Pill, solid outline</b><small>an ending that stops here: no road leaves it</small></span></div>' +
    '<div class="lg-row"><svg class="atlas-svg" width="58" height="24" viewBox="0 0 58 24" aria-hidden="true"><rect x="3" y="3" width="52" height="18" rx="9" fill="var(--a-node)" stroke="' + catColor('end') + '" stroke-width="2.2" stroke-dasharray="1.2 3.6" stroke-linecap="round"/></svg><span><b>Pill, dotted outline</b><small>an ending that hands back: a road leaves it, to the code that called. The main path can run through one</small></span></div>' +
    '<div class="lg-row"><svg width="58" height="24" viewBox="0 0 58 24" aria-hidden="true"><rect x="3" y="3" width="52" height="18" rx="5" fill="hsl(292 78% 58%)" stroke="hsl(292 85% 72%)" stroke-width="2"/></svg><span><b>Off-by-default tint</b><small>whole map, &ldquo;Off by default&rdquo; button: boxes behind a switch, or reached only by a test</small></span></div>' +
    '<div class="lg-row"><svg width="58" height="24" viewBox="0 0 58 24" aria-hidden="true"><rect x="3" y="3" width="52" height="18" rx="5" fill="none" stroke="var(--ev-sus,#e2af69)" stroke-width="2" stroke-dasharray="5 3"/></svg><span><b>Evidence rings</b><small>switch Evidence on: dashed amber is a question, solid is seen in a run, double with a lock is proved</small></span></div>';
  h += '<h3>Roads of a lit box</h3><div class="lg-row"><svg width="58" height="18" viewBox="0 0 58 18" aria-hidden="true"><line x1="3" y1="9" x2="50" y2="9" stroke="var(--in)" stroke-width="3"/></svg><span><b>Solid, cool or warm</b><small>a road going forward: cool where it arrives, warm where it leaves</small></span></div>' +
    '<div class="lg-row"><svg width="58" height="18" viewBox="0 0 58 18" aria-hidden="true"><line x1="3" y1="9" x2="50" y2="9" stroke="var(--out)" stroke-width="3" stroke-dasharray="6 6"/></svg><span><b>Dashed</b><small>a return or a retry: the same colours, dashed, as in the list above</small></span></div>';
  h += '<h3>Dim and faint</h3>' +
    '<div class="lg-row"><svg class="atlas-svg" width="38" height="24" viewBox="0 0 38 24" aria-hidden="true"><rect x="2" y="2" width="34" height="20" rx="5" fill="var(--a-node)" stroke="' + catColor('step') + '" stroke-width="2.4" stroke-dasharray="5 3" opacity=".62"/></svg><span><b>Dim box: off by default</b><small>a dashed outline and a paler box; its name still reads in full. A box only a test reaches is drawn a little paler</small></span></div>' +
    '<div class="lg-row"><svg width="58" height="18" viewBox="0 0 58 18" aria-hidden="true"><line x1="3" y1="9" x2="50" y2="9" stroke="' + edgeColor('forward') + '" stroke-width="2.6" opacity=".55"/></svg><span><b>Faint road</b><small>inferred: no code path proves it</small></span></div>' + (META.toolMap ? '<div class="lg-row"><svg class="atlas-svg" width="58" height="24" viewBox="0 0 58 24" aria-hidden="true"><rect x="3" y="3" width="52" height="18" rx="5" fill="var(--a-node)" stroke="' + catColor('step') + '" stroke-width="2" stroke-dasharray="6 4"/><text x="46" y="15" font-size="13" font-weight="700" fill="var(--ev-sus,#e2af69)">?</text></svg><span><b>Dashed, with a ?</b><small>the tool is not confident in this box or road; the Details panel says why</small></span></div>' : '');
  if (anyHandles()) {
    h += '<h3>Official handles</h3><p class="lg-note">The small tab on a box is a name the system itself uses' + (FAM_ORDER.length > 1 ? '; colour is the family' : '') + '. The toolbar’s Handles button lists them all.</p>';
    FAM_ORDER.forEach(function (k) {
      var ex = exampleHandle(k); if (!ex) return;
      h += '<div class="lg-row lg-handle">' + hchip(ex, 'lg-chip') + '<span><b>' + esc(FAMS[k].name) + '</b>' + (FAMS[k].blurb ? '<small>' + esc(FAMS[k].blurb) + '</small>' : '') + '</span></div>';
    });
  }
  var t0 = types.indexOf('forward') >= 0 ? 'forward' : types[0];
  h += '<h3>Reading aids</h3>' +
    '<div class="lg-row"><svg width="58" height="18" viewBox="0 0 58 18" aria-hidden="true"><line x1="3" y1="9" x2="50" y2="9" stroke="' + edgeColor(t0) + '" stroke-width="2.6" marker-end="url(#lg-arr-' + t0 + ')"/></svg><span><b>Arrowhead = direction</b><small>the flow always goes the way the arrow points</small></span></div>' +
    '<div class="lg-row"><svg class="atlas-svg" width="58" height="30" viewBox="0 0 58 30" aria-hidden="true"><line x1="29" y1="2" x2="29" y2="28" stroke="var(--a-deliver,#5fb4ee)" stroke-width="2.4"/><path d="M3 15 L23 15 A6 6 0 0 1 35 15 L55 15" fill="none" stroke="var(--a-forward)" stroke-width="2.4"/></svg><span><b>A little hop</b><small>one road passes over another; they are not joined</small></span></div>' +
    '<div class="lg-row"><svg width="58" height="18" viewBox="0 0 58 18" aria-hidden="true"><line x1="3" y1="9" x2="50" y2="9" stroke="var(--in)" stroke-width="3.4" marker-end="url(#lg-arr-in)"/></svg><span><b style="color:var(--in)">Cool road</b><small>when a step is pinned: arrives here</small></span></div>' +
    '<div class="lg-row"><svg width="58" height="18" viewBox="0 0 58 18" aria-hidden="true"><line x1="3" y1="9" x2="50" y2="9" stroke="var(--out)" stroke-width="3.4" marker-end="url(#lg-arr-out)"/></svg><span><b style="color:var(--out)">Warm road</b><small>when a step is pinned: leaves from here</small></span></div>' +
    '<p style="margin-top:12px"><button class="act lg-howto" type="button">Show the “How to read this” tips again</button></p>';
  return h;
}

/* ================================================================ chart mount */
var EXTRA_DEFS = ['in', 'out', 'sel', 'path', 'spine'].map(function (t) {
  return '<marker id="arr-' + t + '" viewBox="0 0 12 12" refX="10.5" refY="6" markerWidth="15" markerHeight="15" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1 1.2 L11 6 L1 10.8 L3.6 6 Z"/></marker>';
}).join('');

function showSvgLink() { var sl = $('#svgLink'); if (C && sl && SVG.ok === true) { sl.href = 'svg/' + C.id + '.svg'; sl.hidden = false; } }
var SVG = { ok: null };                                // is the svg/ folder beside the page? (null: not asked yet, 'pending': asked)
function measure() { cw = canvas.clientWidth; ch = canvas.clientHeight; }

function estGrow(g) {                                // how much larger than its layout a handle tab is drawn when this chart opens: the zoom it opens at is its readable zoom or its fit, whichever is larger (viewer/zoomtext.js grows a tab as the chart shrinks)
  var nk = (g.nodeFont || 15) / 15, fl = (MINPX + 0.03) / (15 * nk), cwe = canvas.clientWidth || cw || 1200, che = canvas.clientHeight || ch || 700;
  return chipScaleAt(Math.max(fl, Math.min(1.1, Math.min((cwe - 24) / (g.width + 40), (che - 20) / (g.height + 40)))));
}
function estGrowBadge(g) {                           // the same for a corner badge (it grows about its middle)
  var nk = (g.nodeFont || 15) / 15, fl = (MINPX + 0.03) / (15 * nk), cwe = canvas.clientWidth || cw || 1200, che = canvas.clientHeight || ch || 700;
  return badgeScaleAt(Math.max(fl, Math.min(1.1, Math.min((cwe - 24) / (g.width + 40), (che - 20) / (g.height + 40)))));
}
function mountChart(id) {
  lockHover();
  if (qInput.value) { qInput.value = ''; qCount.textContent = ''; closeResults(); }                    // a typed search belongs to the chart it was typed on: it never dims the next one
  var chart = CH[id], g = chart.geom, pad = 20;
  g.nodes.forEach(function (gn) { var dn = chart.nodes[gn.id]; if (!dn) return; if (hOf(dn) && !gn.handle) gn.handle = hOf(dn); if (hOf(dn) && !gn.tag) gn.tag = hOf(dn); if (!gn.kind && !gn.category) gn.kind = gn.category = kindOf(dn); });   // data/geom may be built by different steps
  var big = isWhole(chart) || g.edges.length > 400;                                                   // a big map: no hop-over arcs (quadratic), handle chips laid out per stage (viewer/whole.js), no hit paths on long roads
  var chipOpt = { families: FAMS, familyOf: function (hd) { return famOf(hd); } };
  if (!big && g.nodes.length <= 150) { chipOpt.grow = estGrow(g); chipOpt.pgrow = estGrowBadge(g); }                                        // the tabs are laid out clear of the road conditions at the size they will be drawn at when the chart opens
  var raw = renderSVG(g, { portals: chart.portals, chips: chipOpt, hops: !big, hitCross: !big, labels: !isWhole(chart), chipsAt: big ? chipsPerCluster(g, chipOpt) : undefined });      // portal rings + corner badges (cross-chart entries and exits) are drawn by the renderer
  var vbm = /viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(raw.slice(0, 400)), vbox = vbm ? { x: +vbm[1], y: +vbm[2], w: +vbm[3], h: +vbm[4] } : { x: -pad, y: -pad, w: g.width + pad * 2, h: g.height + pad * 2 };   // the renderer's own extent: it grows to hold a tab or a badge that hangs outside the boxes
  var inner = raw.slice(raw.indexOf('>') + 1, raw.lastIndexOf('</svg>')).replace('</defs>', EXTRA_DEFS + '</defs>');
  canvas.innerHTML = '<svg id="atlas" class="atlas-svg lod-near' + (isWhole(chart) ? ' is-whole' : chart.kind === 'overview' ? ' is-overview' : '') + '" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" role="group" aria-label="' + esc(chart.title) + '" font-family="system-ui,Segoe UI,Helvetica,Arial,sans-serif"><g id="vp">' + inner + '</g></svg>';
  var svg = $('#atlas'), vp = $('#vp');
  var X = { id: id, chart: chart, svg: svg, vp: vp, nodeEl: new Map(), edgeEl: new Map(), labelEl: new Map(), out: {}, inn: {}, nb: {}, eb: {}, lb: {}, far: [], marked: [], qMarked: [], hl: null, lod: 'near', hit: 14, W: vbox.w, H: vbox.h, x0: vbox.x, y0: vbox.y, fitS: 1, minS: 0.1, nodeCount: Object.keys(chart.nodes).length, miniOn: false, mk: null, labelsG: $('g.edge-labels', svg), raised: [], ghost: [], hovMarked: [], hMarked: [], ep: {} };
  $$('g.node', svg).forEach(function (el) {
    var nid = el.dataset.node, n = chart.nodes[nid];
    el.setAttribute('tabindex', '-1'); el.setAttribute('role', 'button');
    el.setAttribute('aria-label', (n ? n.title + '. ' + (n.plain || n.summary || '') + (hOf(n) ? ' Official handle ' + hOf(n) + '.' : '') + (n.status === 'off' ? ' Off by default.' : '') : nid));
    if (n) {
      var kd = kindOf(n); el.style.setProperty('--cat', catColor(kd)); el.setAttribute('data-kind', kd.toLowerCase()); if (n.ending) el.setAttribute('data-ending', n.ending);
      if (chart.kind === 'overview' && n.synth === 'stage' && stageHue(n.stage) != null) { el.style.setProperty('--sh', stageHue(n.stage)); el.style.setProperty('--cat', stageCol(n.stage)); el.classList.add('st-box'); }
      if (n.status && n.status !== 'live') el.classList.add('st-' + String(n.status).replace(/[^a-z-]/gi, ''));
      if (n.nc) { el.classList.add('nc'); try { var nbx = el.querySelector('.node-box'), nbb = nbx && nbx.getBBox(), nq = document.createElementNS('http://www.w3.org/2000/svg', 'text'); if (nbb) { nq.setAttribute('class', 'nc-q'); nq.setAttribute('x', nbb.x + nbb.width - 9); nq.setAttribute('y', nbb.y + 14); nq.textContent = '?'; el.appendChild(nq); } } catch (err) { /* the dashed outline still marks it */ } }
    }
    X.nodeEl.set(nid, el);
  });
  $$('g.edge.spine', svg).forEach(function (el) { el.classList.remove('spine'); });                    // the placer marks ITS spine in the geometry; the page lights only the declared path's consecutive roads (regions.js buildSpine)
  $$('g.edge', svg).forEach(function (el) {
    X.edgeEl.set(el.dataset.edge, el);
    var ed = chart.edges[el.dataset.edge]; if (!ed) return;
    el.style.setProperty('--ec', 'var(--a-' + (ed.type || 'forward') + ',' + edgeColor(ed.type || 'forward') + ')');
    if (ed.inferred) el.classList.add('inferred');
    if (ed.nc) el.classList.add('nc');
  });
  $$('g.elabel', svg).forEach(function (el) { X.labelEl.set(el.dataset.edgeLabel, el); });
  Object.keys(chart.nodes).forEach(function (nid) { X.out[nid] = []; X.inn[nid] = []; });
  var edges = Object.keys(chart.edges).map(function (k) { return chart.edges[k]; });
  edges.forEach(function (e) { (X.out[e.from] || (X.out[e.from] = [])).push(e.id); (X.inn[e.to] || (X.inn[e.to] = [])).push(e.id); });
  var rank = function (eid) { return TYPE_RANK[chart.edges[eid].type] || 0; };
  Object.keys(X.out).forEach(function (k) { X.out[k].sort(function (a, b) { return rank(a) - rank(b); }); });
  Object.keys(X.inn).forEach(function (k) { X.inn[k].sort(function (a, b) { return rank(a) - rank(b); }); });
  g.nodes.forEach(function (n) { X.nb[n.id] = { x: n.x, y: n.y, w: n.w, h: n.h }; });
  g.edges.forEach(function (e) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    e.pts.forEach(function (p) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
    X.eb[e.id] = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, mid: midPoint(e.pts) }; X.ep[e.id] = e.pts;
    if (e.labelBox && e.labelBox.w > 0) X.lb[e.id] = { x: e.labelBox.x, y: e.labelBox.y, w: e.labelBox.w, h: e.labelBox.h };
  });
  // large cluster captions for the far zoom level
  var cmap = {}; (g.clusters || []).forEach(function (c) { cmap[c.id] = c; });
  $$('g.cluster', svg).forEach(function (el) {
    var c = cmap[el.dataset.cluster]; if (!c) return;
    var t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('class', 'cl-far'); t.setAttribute('x', c.x + c.w / 2); t.setAttribute('y', c.y + c.h / 2);
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'middle'); t.setAttribute('font-size', 40);
    t.textContent = c.title || '';
    el.appendChild(t);
    X.far.push({ el: t, c: c, max: Math.max(14, Math.min(c.w * 0.92 / (Math.max(4, (c.title || '').length) * 0.66), c.h * 0.55)), last: 0 });
  });
  C = X; X.tabPlan = big ? null : chipPlan(g, chipOpt);                  // what each handle tab says (render.mjs): the chart's header says the shared parts once
  S.lastChart = id;
  if (X.nodeCount > 80) svg.classList.add('dimfast');                  // big charts: no opacity transitions (hundreds of them make every focus change slow)
  chartView.dataset.kind = chart.kind || '';                          // a stage part keeps its room for the chart: no repeated draft strip, no summary row (the flow bar and the details panel say it)
  chartView.classList.toggle('slim', isWhole(chart));                 // the whole map gets the window: no summary, handle chips, draft strip or flow bar above it
  mountPortals(X); mountRegions(X); S.pf = null; drawFlowBar();      // the flow bar can change the canvas height: draw it before measuring
  measure();
  S.autoFit = true; S.smallFor = null; S.pre = null;
  autoRoom();
  setupMini();
  var t = fitTarget(); C.fitS = t.s; C.minS = Math.min(0.12, t.s * 0.6); C.floored = !!t.floored; drawFloorNote(); keepBar(t.bar, true);
  view.s = t.s; view.x = t.x; view.y = t.y;
  C.lod = ''; lastZoom = 0; flush();
  $('#chartTitle').textContent = chartHeadTitle(chart);
  drawChartHead(chart);
  var sm = $('#chartSummary'); setSummary(sm, chart.summary || ''); sm.classList.remove('open'); sm.setAttribute('aria-expanded', 'false');
  var ex = DATA.meta && DATA.meta.exports, sl = $('#svgLink');
  // the page is often sent on its own, without the svg/ folder beside it: only offer the link when the file is really there
  sl.hidden = true;
  if (ex && ex.svg) {                                  // the folder is looked for once (a page sent on its own makes one failed request, not one per chart): found, the link is offered on every chart; not found, on none
    if (SVG.ok === true) showSvgLink(); else if (SVG.ok === null) { SVG.ok = 'pending'; var probe = new Image(); probe.onload = function () { SVG.ok = true; showSvgLink(); }; probe.onerror = function () { SVG.ok = false; }; probe.src = 'svg/' + id + '.svg'; }
  }
  document.title = chart.navLabel + ' · ' + siteName();
  applyChartSearch(true);
  applyHandleFocus();
  fire(chartHooks, X);
}
/* the tool's name is in the frame and in the tab title ("System name · Faultline atlas"), whatever an older page wrote after the system's name */
function brandTitle() { var t = String(META.title || '').replace(/\s*[·|–-]\s*interactive\s+atlas\s*$/i, '').trim(); if (!t) return 'Faultline atlas'; return /faultline/i.test(t) ? t : t + ' · Faultline atlas'; }
function siteName() { return brandTitle(); }

/* the summary shows its whole first sentence; the rest of it opens with a click (it was cut after a dozen words) */
function setSummary(el, text) {
  var ss = sentencesOf(text);
  if (ss.length < 2) { el.textContent = text; return; }
  el.innerHTML = '<span class="sum-1">' + esc(ss[0]) + '</span><span class="sum-more"> more</span><span class="sum-rest"> ' + esc(ss.slice(1).join(' ')) + '</span>';
}
/* toolbar title row: official name + plain subtitle + the handles this chart engages (clickable) */
function drawChartHead(chart) {
  var sub = $('#chartSub'); sub.textContent = chart.navSub || ''; sub.hidden = !chart.navSub || chart.kind === 'stage' || String(chart.summary || '').indexOf(String(chart.navSub).replace(/\u2026$/, '').slice(0, 40)) === 0;
  var box = $('#chartCodes'), codes = strs(chart.codes), tp = C && C.chart === chart ? C.tabPlan : null, note = '';
  if (tp && tp.shared) note += '<span class="tabnote" title="The tab is not repeated on each of these boxes: it is said here once.">On ' + tp.shared.count + ' boxes: <code>' + esc(tp.shared.handle) + '</code></span>';
  if (tp && tp.prefix) note += '<span class="tabnote" title="The tabs on the boxes leave this part out. The full name is in a tooltip on each tab and in the details panel.">Tabs drop the shared start <code>' + esc(tp.prefix) + '</code></span>';
  box.innerHTML = note + codes.map(function (t) { return hchipBtn(t); }).join('') + '<button type="button" class="hchip more" data-handles="1" hidden></button>';
  box.hidden = !codes.length;
  fitCodes();
  var made = $('#chartMade');                                      // the first screen says, once and quietly, what the page is and who made it
  if (made) { made.hidden = chart.kind !== 'overview'; if (!made.firstChild) made.innerHTML = 'This page is an interactive map of the system’s code: its stages, the roads between them and where it can break. Made by <a href="https://github.com/EmergentKnowledgeGroup/FaultlineByEKG" target="_blank" rel="noopener">Faultline · github.com/EmergentKnowledgeGroup/FaultlineByEKG</a>.'; }
}
/* the codes stay on ONE line: chips that do not fit collapse into a "+N" chip (its tooltip lists them; it opens the Handles panel) */
var fitting = false;
function fitCodes() {
  var box = $('#chartCodes'); if (!box || box.hidden || fitting) return;
  fitting = true; try { fitCodesNow(box); } finally { fitting = false; }
}
function fitCodesNow(box) {                         // one line, measured by width (the notes and the chips together); chips leave from the end, then the notes
  var chips = $$('.hchip:not(.more)', box), more = $('.more', box), notes = $$('.tabnote', box); if (!chips.length && !notes.length) return;
  chips.forEach(function (c) { c.hidden = false; }); notes.forEach(function (n) { n.hidden = false; }); more.hidden = true;
  var over = function () { return box.scrollWidth > box.clientWidth + 1; };
  if (!over() || box.clientWidth < 40) return;
  var k = chips.length, j = notes.length;
  var setMore = function () { var hid = chips.slice(k); more.hidden = !hid.length; more.textContent = '+' + hid.length; more.title = hid.map(function (c) { return c.textContent; }).join(', '); };
  if (chips.length) { do { k--; chips[k].hidden = true; setMore(); } while (k > 0 && over()); }
  while (j > 0 && over()) { j--; notes[j].hidden = true; }
  if (over()) more.hidden = true;
}
window.addEventListener('resize', fitCodes);
if (window.ResizeObserver) new ResizeObserver(function () { fitCodes(); }).observe($('#chartCodes'));

function midPoint(pts) {
  var tot = 0, i; for (i = 0; i < pts.length - 1; i++) tot += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  var h = tot / 2, a = 0;
  for (i = 0; i < pts.length - 1; i++) {
    var d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (a + d >= h && d > 0) { var f = (h - a) / d; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]; }
    a += d;
  }
  return pts[0];
}

/* ================================================================ view (pan / zoom) */
var raf = 0, anim = null;
function schedule() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; flush(); }); }
function lodOf(s) { return s < (C && isWhole(C.chart) ? 0.2 : 0.30) ? 'far' : s < 0.55 ? 'mid' : 'near'; }   // the whole map keeps its far level (merged roads, no per-road elements) until a stage is large on screen
function flush() {
  if (!C) return;
  C.vp.setAttribute('transform', 'translate(' + view.x.toFixed(2) + ' ' + view.y.toFixed(2) + ') scale(' + view.s.toFixed(5) + ')');
  var l = lodOf(view.s);
  if (l !== C.lod) { C.svg.classList.remove('lod-far', 'lod-mid', 'lod-near'); C.svg.classList.add('lod-' + l); C.lod = l; }
  if (l === 'far') {
    C.far.forEach(function (f) {
      var fs = Math.min(f.max, Math.max(13, 17 / view.s));
      if (Math.abs(fs - f.last) / (f.last || 1) > 0.03) { f.el.setAttribute('font-size', fs.toFixed(1)); f.last = fs; }
    });
  }
  var cs = Math.round(clamp(0.95 / view.s, 1, 1.5) * 20) / 20;       // handle chips grow as the chart shrinks (10.5px on screen at best)
  if (cs !== C.chipS) { C.chipS = cs; C.svg.style.setProperty('--chip-s', cs); }
  var ps = Math.round(clamp(0.95 / view.s, 1, 2.6) * 10) / 10;       // portal badges grow as the chart shrinks (about 17px on screen at best)
  if (ps !== C.pbS) { C.pbS = ps; C.svg.style.setProperty('--pb-s', ps); }
  var hw = Math.round(clamp(12 / view.s, 12, 64) / 2) * 2;
  if (hw !== C.hit) { C.hit = hw; C.svg.style.setProperty('--hit', hw + 'px'); }
  regionsFlush(); if (C.wh) wholeView();
  $('#zVal').textContent = Math.round(view.s * 100) + '%';
  updateMiniView(); drawCues();
  if (view.s !== lastZoom) { var pz = lastZoom; lastZoom = view.s; fire(zoomHooks, view.s, pz); }
  drawWordsNote();                                   // cheap (a key compare): the words notice also follows a pan or a pin that turns the automatic fit off, not only a change of zoom
}
/* the zoom bar has ONE place on a chart, the same in every state (a walk, a panel, a pin, a click on +): it never moves while the chart is open, so a button is where the pointer left it. Its place is the bottom-left corner, or, on a chart that fills the canvas, the first corner where nothing is drawn (barSpot).
   Nothing is drawn under it at the default view: the fit leaves the place free (fitTarget1). Its buttons are the same everywhere (Fit, All at once, 100%), and the note about the smaller view lies beside it, not in it. */
var zoomBarEl = $('#zoomGroup');
function cancelAnim() { anim = null; }
function setView(t, animate, ms) {
  if (!animate || reduced || cw < 10) { cancelAnim(); view.s = t.s; view.x = t.x; view.y = t.y; schedule(); return; }
  var f = { s: view.s, x: view.x, y: view.y }, t0 = performance.now(), dur = ms || 280, me = {};
  anim = me;
  var c0x = (cw / 2 - f.x) / f.s, c0y = (ch / 2 - f.y) / f.s, c1x = (cw / 2 - t.x) / t.s, c1y = (ch / 2 - t.y) / t.s;
  (function step(now) {
    if (anim !== me) return;
    var p = Math.min(1, (now - t0) / dur), e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    var s = f.s * Math.pow(t.s / f.s, e), cx = c0x + (c1x - c0x) * e, cy = c0y + (c1y - c0y) * e;
    view.s = s; view.x = cw / 2 - cx * s; view.y = ch / 2 - cy * s;
    flush();
    if (p < 1) requestAnimationFrame(step); else anim = null;
  })(t0);
}
function panelReserve() {          // the handles panel docks over the right of the canvas: fit the chart into what is left (wide screens only)
  var p = S.hpanel && !hpanel.hidden ? hpanel : !dockEl.hidden ? dockEl : null;
  if (!p || cw < 900) return 0;
  var w = p.offsetWidth + 24; return cw - w >= 560 ? w : 0;
}
/* ---- the readable floor.  No box name and no route label is ever drawn under MINPX screen pixels (zoomtext.js hides it), so "fit" never goes below the zoom where they read:
   a chart that does not fit at that zoom opens at the readable zoom, left and top aligned, and pans.  Panels opening or closing cannot push it under the line either.
   The whole map and tiny windows are exempt; the overview poster is held to its box names only (its roads are listed in the panel when a stage is selected). ---- */
var MINPX = 11, rdBarEl;
/* "All at once" is a smaller view. The reading rule (11 px) stays for the default view; in the whole-chart view the person asked for, names are drawn down to 8.5 px and road conditions to 8 px,
   so the chart still says what is in it, and the zoom bar says it is a smaller view. It ends when the person zooms in past it, asks for Fit or Reading size, or changes chart. */
var SMALL_NAME = 8.5, SMALL_LABEL = 8;
function smallOn() { return !!(S.smallFor && C && C.id === S.smallFor.chart && !isWhole(C.chart) && (view.s <= S.smallFor.s * 1.02 || performance.now() < S.smallFor.until)); }
function walkLift() { return window.matchMedia && window.matchMedia('(min-width:1001px) and (max-width:1365px)').matches ? 48 : 0; }       // 1001 to 1365 px: the walk bar stands over the zoom bar, 48 px higher than at the bottom edge (frame.css)
function narrowWin() { return window.innerWidth < 1500; }       // a laptop-sized window
var NARROW_LABEL = 9.4;       // on a laptop-sized window a road condition may be drawn as small as 9.4 px (box names keep 11); it is drawn at the same zoom as the names, so no chart is cut for the sake of its road conditions. This lowers the 11 px bar for road conditions on windows under 1500 px wide and is the owner's call to keep or revert.
function minPxFor(kind) { return smallOn() ? (kind === 'elabel' ? SMALL_LABEL : SMALL_NAME) : kind === 'elabel' && narrowWin() ? NARROW_LABEL : MINPX; }
function textBase(X) {                                     // the chart's text sizes in map units, read from the page's own CSS (so a renderer change is followed)
  if (X.tb) return X.tb;
  var q = function (sel, d) { var t = X.svg.querySelector(sel), v = t ? parseFloat(getComputedStyle(t).fontSize) : 0; return v > 0 ? v : d; };
  return (X.tb = { node: q('.node-text', 15), elabel: q('.elabel-text', 13) });
}
function namesFloor(X) { return !X || isWhole(X.chart) ? 0 : (MINPX + 0.03) / textBase(X).node; }
function fitFloor(X) {                                     // the smallest zoom at which every name and every route label of this chart reads
  if (!X || isWhole(X.chart) || cw < 700) return 0;
  var f = namesFloor(X);
  if (X.chart.kind !== 'overview' && X.labelEl.size > 0) f = Math.max(f, ((narrowWin() ? NARROW_LABEL : MINPX) + 0.03) / textBase(X).elabel);
  return f;
}
/* The zoom bar's place on a chart. Home is the bottom-left corner. A chart that fills the canvas has something drawn there, so the bar stands at the first other place where nothing is: the top-right corner, the bottom-right, the top-left, then along the top and the bottom edge.
   It is chosen when the chart opens (and when the canvas changes size) and then it stays put, so a button is where the pointer left it. barCost: what a bar at (x, y) would cover at view t. A box, a tab or a corner badge counts most, a road condition next, a road by how much of it runs under the bar. Zero is clear. */
function barParts() {                              // the tabs and the corner badges of the mounted chart in map units, once per chart
  if (C.barParts) return C.barParts;
  var tabs = [], badges = [];
  C.svg.querySelectorAll('g.chip .chip-bg').forEach(function (r) { tabs.push({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }); });
  C.svg.querySelectorAll('g.pbadge').forEach(function (e) { try { var q = e.getBBox(); if (q.width > 0) badges.push({ x: q.x, y: q.y, w: q.width, h: q.height }); } catch (err) { /* not drawn */ } });
  return (C.barParts = { tabs: tabs, badges: badges });
}
function barCost(t, x, y, w, h) {
  var P = 6, x0 = x - P, y0 = y - P, x1 = x + w + P, y1 = y + h + P, s = t.s, cs = chipScaleAt(s), ps = badgeScaleAt(s), cost = 0, k, b, i, p, len, parts = barParts();
  var ov = function (rx, ry, rw, rh) { return rx < x1 && rx + rw > x0 && ry < y1 && ry + rh > y0; };
  for (k in C.nb) { b = C.nb[k]; if (ov(b.x * s + t.x, b.y * s + t.y, b.w * s, b.h * s)) cost += 1000; }
  for (i = 0; i < parts.tabs.length; i++) { b = parts.tabs[i]; if (ov(b.x * s + t.x - 2, (b.y - b.h * (cs - 1) / 2) * s + t.y - 2, b.w * cs * s + 4, b.h * cs * s + 4)) cost += 800; }
  for (i = 0; i < parts.badges.length; i++) { b = parts.badges[i]; if (ov((b.x - b.w * (ps - 1) / 2) * s + t.x, (b.y - b.h * (ps - 1) / 2) * s + t.y, b.w * ps * s, b.h * ps * s)) cost += 700; }
  for (k in C.lb) { b = C.lb[k]; if (ov(b.x * s + t.x - 2, b.y * s + t.y - 2, b.w * s + 4, b.h * s + 4)) cost += 900; }
  for (k in C.ep) {                                  // a road is measured by how much of it runs under the bar (each run clipped to the bar's rectangle)
    p = C.ep[k]; len = 0;
    for (i = 0; i < p.length - 1; i++) len += clipLen(p[i][0] * s + t.x, p[i][1] * s + t.y, p[i + 1][0] * s + t.x, p[i + 1][1] * s + t.y, x0, y0, x1, y1);
    if (len > 8) cost += len > 30 ? 300 + len : len;
  }
  return cost;
}
function clipLen(ax, ay, bx, by, x0, y0, x1, y1) {   // the length of the part of the segment a-b inside the rectangle (Liang-Barsky)
  var dx = bx - ax, dy = by - ay, t0 = 0, t1 = 1, pp = [-dx, dx, -dy, dy], qq = [ax - x0, x1 - ax, ay - y0, y1 - ay], i, r;
  for (i = 0; i < 4; i++) {
    if (pp[i] === 0) { if (qq[i] < 0) return 0; }
    else { r = qq[i] / pp[i]; if (pp[i] < 0) { if (r > t1) return 0; if (r > t0) t0 = r; } else { if (r < t0) return 0; if (r < t1) t1 = r; } }
  }
  return t1 > t0 ? (t1 - t0) * Math.hypot(dx, dy) : 0;
}
function barSpot(t, mini) {                        // {x, y, home, cost} in canvas pixels: home when it is clear, else the first clear place, else the place that covers least
  var w = zoomBarEl.offsetWidth || 326, h = zoomBarEl.offsetHeight || 40, M = 12, wr = $('#canvasWrap').getBoundingClientRect(), cands = [{ x: M, y: ch - M - h, home: true }], ui = [], best = null, i, k, c, cost, x;
  if (!mini) {
    cands.push({ x: cw - M - w, y: M }, { x: cw - M - w, y: ch - M - h }, { x: M, y: M });         // the four corners and nothing else: the bar is never in the middle of an edge
    var cor = [[M, ch - M - h, 1, -1], [cw - M - w, M, -1, 1], [cw - M - w, ch - M - h, -1, -1], [M, M, 1, 1]], sl = [[12, 0], [0, 12], [24, 0], [12, 12], [0, 24], [36, 0], [24, 12], [12, 24], [48, 0], [36, 12], [24, 24], [60, 0], [48, 12], [36, 24], [60, 12], [48, 24], [60, 24]], si, ci;
    for (si = 0; si < sl.length; si++) for (ci = 0; ci < cor.length; ci++) cands.push({ x: cor[ci][0] + cor[ci][2] * sl[si][0], y: cor[ci][1] + cor[ci][3] * sl[si][1] });       // when a corner is covered: the same corner, nudged along its edges (up to 60 px) and inward (up to 24 px), nearest first, so it still reads as that corner
  }
  ['#regionDock .rd-bar', '#mini', '#handlePanel', '#dockPanel', '#legend'].forEach(function (sel) { var e = $(sel), r; if (!e || e.offsetParent === null) return; r = e.getBoundingClientRect(); if (r.width > 0) ui.push([r.left - wr.left - 8, r.top - wr.top - 8, r.width + 16, r.height + 16]); });
  for (i = 0; i < cands.length; i++) {
    c = cands[i]; cost = barCost(t, c.x, c.y, w, h);
    for (k = 0; k < ui.length; k++) if (c.x < ui[k][0] + ui[k][2] && c.x + w > ui[k][0] && c.y < ui[k][1] + ui[k][3] && c.y + h > ui[k][1]) cost += 5000;
    c.cost = cost; if (!best || cost < best.cost) best = c; if (!cost) break;
  }
  return best;
}
function keepBar(spot, fresh) {                    // the chosen place is kept while the chart stays open and the canvas keeps its size
  if (!C || !zoomBarEl) return;
  var key = cw + 'x' + ch + panelSig(); if (spot && (fresh || C.barKey !== key)) { C.barAt = spot; C.barKey = key; }
  drawZoomBar();
}
function panelSig() { return (S.hpanel && hpanel && !hpanel.hidden ? 'h' : '') + (dockEl && !dockEl.hidden ? 'd' : '') + (legendEl && !legendEl.hidden ? 'l' : ''); }       // which panel lies over the right of the canvas: the bar's place is chosen again when it changes
function reseatBar(always) {                              // a panel opened or closed over a view the person has set (no refit follows): the bar is placed again for the view as it is, and goes back to its place when the panel goes
  if (!C || !zoomBarEl || S.reading || (S.autoFit && !always) || C.nodeCount > 300 || cw < 700 || isWhole(C.chart) || C.chart.kind === 'overview') { if (C && !S.reading) drawZoomBar(); return; }
  var key = cw + 'x' + ch + panelSig(), spot = barSpot({ s: view.s, x: view.x, y: view.y }, !!(C.miniOn && mm && !miniEl.hidden));
  if (spot) { C.barAt = spot; C.barKey = key; } drawZoomBar();
}
function drawZoomBar() {                           // home is the bar's own place in the bottom row; anywhere else it is placed over the canvas. During a walk it is at home (the walk bar is made to stand beside it)
  if (!zoomBarEl) return;
  var at = C && C.barAt, st = zoomBarEl.style, walking = !!(S.walk && walkBar && !walkBar.hidden);
  if (!at || at.home || walking) { st.position = ''; st.left = ''; st.top = ''; st.bottom = ''; return; }
  var wr = $('#canvasWrap').getBoundingClientRect(), w = zoomBarEl.offsetWidth || 326, h = zoomBarEl.offsetHeight || 40;
  st.position = 'fixed'; st.bottom = 'auto'; st.left = Math.round(wr.left + clamp(at.x, 6, Math.max(6, cw - w - 6))) + 'px'; st.top = Math.round(wr.top + clamp(at.y, 6, Math.max(6, ch - h - 6))) + 'px';
}
function chipScaleAt(sc) { return clamp(11.15 / (11.5 * sc), 1, 1.54); }       // how much a handle tab is drawn larger than its map size at zoom sc (zoomtext.js), growing from its left edge
function badgeScaleAt(sc) { return clamp(11.15 / (10.5 * sc), 1, 2.6); }     // the same for a corner badge (it grows about its middle)
function tightOf(X, cs, ps) {                                // the box of everything drawn in the chart (boxes, tabs, badges, roads, labels) in map units, plus 3 units; never larger than the renderer's extent. with the tabs as drawn at tab scale cs (they grow to the right, past the box and past the extent)
  cs = cs > 1.004 ? Math.round(cs * 50) / 50 : 1; ps = ps > 1.004 ? Math.round(ps * 50) / 50 : 1; X.tightBy = X.tightBy || {};      // (a cache of its own: frame.js uses X.tight for something else)
  var key = cs + '/' + ps; if (X.tightBy[key]) return X.tightBy[key];
  var gs = ['g.nodes', 'g.edges', 'g.edge-labels'].map(function (q) { return X.vp.querySelector(q); }).filter(Boolean), x0u = 1e9, y0u = 1e9, x1u = -1e9, y1u = -1e9;      // (the halos group is left out: it is hidden at reading size and runs 50 units past the boxes)
  gs.forEach(function (g) { var q = g.getBBox(); if (q.width > 0 && q.height > 0) { x0u = Math.min(x0u, q.x); y0u = Math.min(y0u, q.y); x1u = Math.max(x1u, q.x + q.width); y1u = Math.max(y1u, q.y + q.height); } });
  if (cs > 1 && x0u < x1u) X.vp.querySelectorAll('g.chip .chip-bg').forEach(function (r) { var cx = +r.getAttribute('x'), cy = +r.getAttribute('y'), cwd = +r.getAttribute('width'), chh = +r.getAttribute('height'); x1u = Math.max(x1u, cx + cwd * cs); y0u = Math.min(y0u, cy - chh * (cs - 1) / 2); y1u = Math.max(y1u, cy + chh * (1 + (cs - 1) / 2)); });
  if (ps > 1 && x0u < x1u) X.vp.querySelectorAll('g.pbadge').forEach(function (e) { var q = e.getBBox(), gx = q.width * (ps - 1) / 2, gy = q.height * (ps - 1) / 2; x0u = Math.min(x0u, q.x - gx); x1u = Math.max(x1u, q.x + q.width + gx); y0u = Math.min(y0u, q.y - gy); y1u = Math.max(y1u, q.y + q.height + gy); });
  var bb = x0u < x1u ? { x: x0u, y: y0u, width: x1u - x0u, height: y1u - y0u } : X.vp.getBBox(), pad = 2, g2 = cs > 1 || ps > 1 ? 60 : 0, x0 = Math.max(X.x0 - g2, bb.x - pad), y0 = Math.max(X.y0 - g2, bb.y - pad), x1 = Math.min(X.x0 + X.W + g2, bb.x + bb.width + pad), y1 = Math.min(X.y0 + X.H + g2, bb.y + bb.height + pad);
  return (X.tightBy[key] = bb.width > 0 && bb.height > 0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: X.x0, y: X.y0, w: X.W, h: X.H });
}
function fitTarget(whole) {                      // the Regions list is a left drawer. It makes room (the chart is fitted into what is left) only while that keeps the chart readable and within one zoom step; else it lies over the chart and the chart stays where it was
  var t = fitTarget1(whole, false), r0 = leftReserve(), u;
  if (r0 > 0) { u = fitTarget1(whole, true); if (t.floored || t.s < u.s * 0.77) t = u; else { var shift = (t.x + C.x0 * t.s) - (u.x + C.x0 * u.s), pw = rgPanel.offsetWidth; t = { s: t.s, x: shift > pw ? t.x - (shift - pw) : t.x, y: u.y + C.y0 * (u.s - t.s), floored: t.floored, bar: t.bar }; } }      // (the chart moves sideways no further than the panel is wide)      // the top of the chart stays where it was (a smaller chart is not re-centred down the page)
  return t;
}
function fitTarget1(whole, noLeft) {
  var m = C.chart.kind === 'overview' || isWhole(C.chart) ? clamp(Math.min(cw, ch) * 0.04, 10, 30) : clamp(Math.min(cw, ch) * 0.01, 6, 10), mt = narrowWin() && C.chart.kind !== 'overview' && !isWhole(C.chart) ? 4 : 14,   /* the overview and the whole map carry stage halos that reach past the boxes: they keep a wider margin; a part chart does not need one (on a laptop-sized window the margins are 4 px) */ mbSmall = narrowWin() && C.chart.kind !== 'overview' && !isWhole(C.chart) ? 4 : 14, mbFull = 50, mr = panelReserve(), ml = noLeft ? 0 : leftReserve();
  var mtDock = false;
  if (C.rg && !rdock.hidden && (rdBarEl = rdock.querySelector('.rd-bar'))) mtDock = true, mt = Math.max(50, rdock.offsetTop + rdBarEl.offsetTop + rdBarEl.offsetHeight + 14 + (isWhole(C.chart) ? 18 : 0));                                    // the top-left strip for the regions dock, and 14 px of air under it
  var byDrawn = narrowWin() && C.chart.kind !== 'overview' && !isWhole(C.chart) && C.nodeCount <= 300, EX = byDrawn ? tightOf(C) : { x: C.x0, y: C.y0, w: C.W, h: C.H };      // on a laptop-sized window the chart is fitted by what is drawn (plus 3 units), not by the renderer's extent (which adds 20 units of air on every side)
  var calc = function (mb2, fx, fy) {                       // fx, fy: where the chart sits in its own slack (0.5 centred, 0 left or top, 1 right or bottom)
    fx = fx == null ? 0.5 : fx; fy = fy == null ? 0.5 : fy;
    var s = clamp(Math.min((cw - ml - mr - 2 * m) / EX.w, (ch - mt - mb2) / EX.h), 0.02, 1.1);      // a small chart is never blown up past about 110% at fit
    return { s: s, x: ml + m + fx * (cw - ml - mr - 2 * m - EX.w * s) - EX.x * s, y: mt + fy * (ch - mt - mb2 - EX.h * s) - EX.y * s, w: EX.w * s, h: EX.h * s, top: mt + fy * (ch - mt - mb2 - EX.h * s) };
  };
  var fl = whole ? 0 : fitFloor(C), floored = false, mb = mbSmall;
  var mtMin = mtDock ? Math.max(4, mt - 8) : Math.min(mt, 2);      // the fit's top margin may give way by this much when a chart that fills the canvas would otherwise be cut
  var floorView = function (mb2, fx, fy, topRoom) {         // too big to read at fit: the readable zoom, starting where the story starts (top left). fx, fy: where a chart that is smaller than the canvas in that direction sits in the slack (0.5 centred, 0 left or top, 1 right)
    var w = EX.w * fl, h = EX.h * fl, mx = m, my0 = mt, my1 = mb2, aw, ah;
    if (w > cw - ml - mr - 2 * mx) mx = Math.max(2, Math.min(m, (cw - ml - mr - w) / 2));            // too big to fit at reading size: the margins give way (down to 2 px) before a badge or a tab is cut
    if (h > ch - my0 - my1) { my1 = Math.min(my1, 2); my0 = mtMin; }
    if (topRoom) my0 = Math.max(my0, topRoom);         // topRoom: a strip along the top for the zoom bar, when no corner is clear (the chart is cut a little more at the bottom: it is already cut)
    aw = cw - ml - mr - 2 * mx; ah = ch - my0 - my1;
    return { s: fl, x: (w > aw ? ml + mx : ml + mx + (fx == null ? 0.5 : fx) * (aw - w)) - EX.x * fl, y: (h > ah ? my0 : my0 + (fy == null ? 0.5 : fy) * (ah - h)) - EX.y * fl };
  };
  var t = calc(mbSmall);
  if (byDrawn) { var cs0 = chipScaleAt(Math.max(fl, t.s)), ps0 = badgeScaleAt(Math.max(fl, t.s)); if (cs0 > 1.004 || ps0 > 1.004) { EX = tightOf(C, cs0, ps0); t = calc(mbSmall); } }      // a tab at the edge of the chart is drawn larger than it is laid out, so the fit holds it at the size it will be drawn
  var mrMini = C.miniOn && mm && !miniEl.hidden ? mm.w + 24 : 0;
  var spot = null;
  if (!(fl && t.s < fl)) {
    var strip = whole || isWhole(C.chart) || C.chart.kind === 'overview' || C.nodeCount > 300 || cw < 700 || !zoomBarEl, bar = !strip, mini1 = !!(C.miniOn && mm && !miniEl.hidden), u, sp2;
    if (bar) {                                     // the zoom bar stands at home when nothing is drawn there, else at the first other place that is clear (barSpot). With no clear place the chart moves to the top of its own slack first, and only then is made smaller to leave a strip under it
      spot = barSpot(t, mini1);
      if (spot.cost > 0) { u = calc(mbSmall, 0.5, 0); sp2 = barSpot(u, mini1); if (sp2.cost === 0) { t = u; spot = sp2; } else strip = true; }
    }
    if (strip) { mb = bar ? Math.max(mbFull, (zoomBarEl.offsetHeight || 40) + 20) : mbFull; t = calc(mb); if (bar) spot = barSpot(t, mini1); }
    if (C.miniOn && mm && !miniEl.hidden) {        // do not let the whole-chart view hide under the overview map
      var hitsMap = (cw - m - (cw - t.w) / 2 > 0) && (t.top + t.h > ch - mm.h - 24) && ((cw + t.w) / 2 > cw - mm.w - 24);
      if (hitsMap) { mb = Math.max(mb, mm.h + 26); t = calc(mb); if (bar) spot = barSpot(t, mini1); }
    }
  }
  if (fl && t.s < fl) {
    t = floorView(mbSmall); floored = true;
    if (zoomBarEl && C.chart.kind !== 'overview' && !isWhole(C.chart) && C.nodeCount <= 300 && cw >= 700 && !whole) {        // a chart that opens at reading size and fills the canvas: the zoom bar goes to the first place where nothing is drawn, else to the place that covers least
      var mini2 = !!(C.miniOn && mm && !miniEl.hidden), v, sp3;
      spot = barSpot({ s: t.s, x: t.x, y: t.y }, mini2);
      if (spot.cost > 0) { v = floorView(mbSmall, 0.5, 0); sp3 = barSpot({ s: v.s, x: v.x, y: v.y }, mini2); if (sp3.cost < spot.cost) { t = v; spot = sp3; } }
      if (spot.cost > 0 && (mr > 0 || app.dataset.insp !== 'collapsed')) {         // (a panel lies over the right of the canvas or takes its right edge)
        v = floorView(mbSmall, 0.5, 0, (zoomBarEl.offsetHeight || 40) + 26); sp3 = barSpot({ s: v.s, x: v.x, y: v.y }, mini2); if (sp3.cost < spot.cost) { t = v; spot = sp3; } }       // still none: the chart gives the bar a strip along the top (it is cut a little more at the bottom, as the panel already cuts it at the side)
    }
  }
  if (isWhole(C.chart) && typeof centreWhole === 'function') return centreWhole({ s: t.s, x: t.x, y: t.y, floored: floored, bar: spot }, ml, cw - mr);       // (whole.js) the whole map is centred by what is drawn, titles included
  return { s: t.s, x: t.x, y: t.y, floored: floored, bar: spot };
}
function fitView(animate, whole) { if (!C) return; S.autoFit = !whole; if (!whole) S.smallFor = null; var t = fitTarget(whole); if (!whole) { C.fitS = t.s; C.minS = Math.min(0.12, t.s * 0.6); keepBar(t.bar); } C.floored = !!t.floored; drawFloorNote(); setView(t, animate); }
function drawFloorNote() {                         // a chart that cannot fit at a readable zoom gets honest words: Fit is not a promise it keeps, so the button says what it does
  var el = $('#zAll'), fb = $('#zFit'), fl = !!(C && C.floored);
  if (el) { el.hidden = false; el.disabled = !fl; el.textContent = 'All at once'; el.title = fl ? 'Show the whole chart at once, small. Fit brings the words back to reading size.' : 'This chart already shows whole at a size where every name reads'; }       // the same buttons on every chart, the same names; the one that does nothing here is dimmed, not taken away
  if (fb) { fb.textContent = 'Fit'; fb.title = fl ? 'This chart is too big to show whole at a size where every name reads. Fit opens it at the smallest size where names and road conditions read; drag to see the rest (0)' : 'Fit the chart at a size where every name reads (0)'; }
}
/* a chart that cannot be read at fit with the side panels open gets the room by closing them (this chart only: the saved choice is untouched and comes back with the next chart) */
function autoRoom() {                    // a chart that cannot fit with the panels open opens at reading size and pans; no panel is closed for it. the details panel is closed until something is pinned, and a pin brings it (S.roomed)
  S.roomed = inspAuto() && app.dataset.insp === 'collapsed' && !S.reading;
}
function zoomAt(f, px, py, animate) {
  if (!C) return; S.autoFit = false; userMoved();
  var ns = clamp(view.s * f, C.minS, 4); if (ns === view.s && !animate) return;
  if (S.smallFor && ns > S.smallFor.s * 1.02) S.smallFor = null;
  var k = ns / view.s;
  setView({ s: ns, x: px - (px - view.x) * k, y: py - (py - view.y) * k }, animate, 160);
}
function zoomBy(f) { zoomAt(f, cw / 2, ch / 2, true); }
function panBy(dx, dy) { S.autoFit = false; userMoved(); setView({ s: view.s, x: view.x + dx, y: view.y + dy }, true, 140); }
function centerOn(wx, wy, s, animate) { S.autoFit = false; setView({ s: s, x: cw / 2 - wx * s, y: ch / 2 - wy * s }, animate); }
function toScreen(bb) { return { x: bb.x * view.s + view.x, y: bb.y * view.s + view.y, w: bb.w * view.s, h: bb.h * view.s }; }
/* bring a world box into view; zooms in when we are too far out to read, otherwise pans only when needed */
function reveal(bb, o) {
  if (!C || cw < 10) return; o = o || {};
  if (o.lit && S.sel && S.sel.t === 'node' && C.nb[S.sel.id] && C.chart.kind !== 'overview' && !isWhole(C.chart)) { revealLit(S.sel.id); return; }
  if (C.chart.kind === 'overview' && S.autoFit) return;                   // the poster is whole on screen: a pin or a search hit never slides it
  var minS = Math.max(o.minScale || 0.7, fitFloor(C) || namesFloor(C)), s = view.s, inset = 70;
  var padB = S.walk && walkBar && !walkBar.hidden ? Math.max(inset, walkBar.offsetHeight + 40 + walkLift()) : inset;                // during a walk the bottom of the canvas belongs to the walk bar
  if (o.also && o.also.w > 0) {                                                                                         // the step after this one is brought into view with it when both fit at this zoom
    var ub = unionBox([bb, o.also]), us = Math.max(minS, view.s);
    if (ub.w * us <= cw - 2 * inset && ub.h * us <= ch - inset - padB) bb = ub;
  }
  var sFit = Math.min((cw - 2 * inset) / bb.w, (ch - inset - padB) / bb.h);
  if (s < minS) s = clamp(sFit, minS, o.maxScale || 1.1);
  else if (bb.w * s > cw - 40 || bb.h * s > ch - 40) s = Math.max(minS, Math.min(s, sFit));
  if (s === view.s && !o.center) {
    var r = toScreen(bb);
    if (r.x >= inset * 0.5 && r.y >= inset * 0.5 && r.x + r.w <= cw - inset * 0.5 && r.y + r.h <= ch - padB * 0.5) return;
  }
  S.autoFit = false; setView({ s: s, x: cw / 2 - (bb.x + bb.w / 2) * s, y: (inset + ch - padB) / 2 - (bb.y + bb.h / 2) * s }, true);
}
/* a walk step brings its whole lit set onto the canvas: the box, the boxes it lights (a road in or out), those roads and their labels, clear of the walk bar, the dock row and the details panel, at the smallest
   zoom that still reads names (never above 100%). The zoom of the step before is kept when this step fits at it; a lit set too big for the canvas at the readable zoom is centred. */
function tabBox(id) {                              // the handle tab of a box as it is drawn at this zoom (it grows to the right), in map units; null when the box has none
  var el = C.nodeEl.get(id), r = el && el.querySelector('.chip-bg'); if (!r) return null;
  var cs = chipScaleAt(view.s), x = +r.getAttribute('x'), y = +r.getAttribute('y'), w = +r.getAttribute('width'), h = +r.getAttribute('height');
  return { x: x - 2, y: y - h * (cs - 1) / 2 - 2, w: w * cs + 4, h: h * cs + 4 };
}
function litBoxOf(id) {
  var parts = [nodeBox(id, 22), tabBox(id)], seen = {};
  (C.inn[id] || []).concat(C.out[id] || []).forEach(function (eid) {
    if (seen[eid]) return; seen[eid] = 1;
    var e = C.chart.edges[eid], o = e.from === id ? e.to : e.from, b = C.eb[eid];
    if (C.nb[o]) { parts.push(nodeBox(o, 22)); parts.push(tabBox(o)); }
    if (b) parts.push({ x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 });
    if (C.lb[eid]) parts.push({ x: C.lb[eid].x - 4, y: C.lb[eid].y - 4, w: C.lb[eid].w + 8, h: C.lb[eid].h + 8 });
  });
  return unionBox(parts);
}
function revealLit(id) {
  var lit = litBoxOf(id), vr = typeof visRect === 'function' ? visRect() : { x0: 0, x1: cw }, wk = S.walk ? (walkBar && !walkBar.hidden && walkBar.offsetHeight ? walkBar.offsetHeight : 90) : 0;
  var padB = wk ? wk + 34 + walkLift() : 50, padT = 58, padS = 22, aw = vr.x1 - vr.x0 - 2 * padS, ah = ch - padT - padB, fl = Math.min(1, fitFloor(C) || namesFloor(C)), cap = 1;
  var fits = function (z) { return lit.w * z <= aw && lit.h * z <= ah; }, s = view.s, zz = Math.min(aw / lit.w, ah / lit.h);
  if (s < fl - 0.001 || s > cap || !fits(s)) s = zz >= fl ? clamp(zz, fl, cap) : clamp(zz, C.minS, fl);       // a step whose lit set is too big for the canvas at reading size is shown in the smaller view (as a pin is), never cut
  var rx = lit.x * s + view.x, ry = lit.y * s + view.y, rw = lit.w * s, rh = lit.h * s, tx, ty;
  if (s === view.s && rx >= vr.x0 + padS && rx + rw <= vr.x1 - padS && ry >= padT && ry + rh <= ch - padB) return;
  S.autoFit = false;
  if (s !== view.s || !fits(s)) { tx = (vr.x0 + vr.x1) / 2 - (lit.x + lit.w / 2) * s; ty = padT + ah / 2 - (lit.y + lit.h / 2) * s; }
  else {
    var nx = rx < vr.x0 + padS ? vr.x0 + padS : rx + rw > vr.x1 - padS ? vr.x1 - padS - rw : rx, ny = ry < padT ? padT : ry + rh > ch - padB ? ch - padB - rh : ry;
    tx = view.x + nx - rx; ty = view.y + ny - ry;
  }
  var cb = C.nb[id];
  if (cb) {                                                      // whatever else happens, the box of this step stays on the canvas
    var px = cb.x * s + tx, py = cb.y * s + ty, pw = cb.w * s, ph = cb.h * s;
    tx += px < vr.x0 + padS ? vr.x0 + padS - px : px + pw > vr.x1 - padS ? vr.x1 - padS - (px + pw) : 0;
    ty += py < padT ? padT - py : py + ph > ch - padB ? ch - padB - (py + ph) : 0;
  }
  if (s < fl - 0.001) S.smallFor = { chart: C.id, s: s, until: performance.now() + 420, auto: true };       // (auto: the page chose it to show a pin whole; nobody pressed All at once)
  setView({ s: s, x: tx, y: ty }, true);
}
function nodeBox(id, grow) { var b = C.nb[id]; if (!b) return null; grow = grow || 0; return { x: b.x - grow, y: b.y - grow, w: b.w + 2 * grow, h: b.h + 2 * grow }; }
function unionBox(list) {
  var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  list.forEach(function (b) { if (!b) return; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function edgeBox(eid) {
  var e = C.chart.edges[eid], b = C.eb[eid];
  return unionBox([b && { x: b.x, y: b.y, w: b.w, h: b.h }, nodeBox(e.from), nodeBox(e.to)]);
}

/* a pin brings its whole lit set (the box, the boxes its roads reach, those roads and their labels) onto what the canvas shows, and clearing the pin gives the view back.
   A pin never zooms in: it pans only as far as it must, zooms out only as far as it must, and goes under reading size (the smaller view, as in "All at once") only when the lit set can be shown no other way.
   S.pre keeps the view from before the first pin; Esc, a click on empty canvas, or the pin going any other way restores it, unless the person has moved the view since. */
function snapPre() {
  if (!C || S.reading || S.sel || wholeNow() || C.chart.kind === 'overview') return;
  S.pre = { chart: C.id, s: view.s, x: view.x, y: view.y, auto: S.autoFit, cw: cw, ch: ch, small: S.smallFor, dirty: false };
}
function userMoved() { if (S.pre) S.pre.dirty = true; }
function restorePre() {
  var p = S.pre; S.pre = null;
  if (!p || p.dirty || !C || C.id !== p.chart || S.reading) return;
  measure();
  if (Math.abs(cw - p.cw) <= 2) { S.autoFit = p.auto; S.smallFor = p.small || null; setView({ s: p.s, x: p.x, y: p.y }, true, 260); }
  else if (p.auto) fitView(true);
}
function litSetBox() {
  if (!S.sel || !C) return null;
  if (S.sel.t === 'node') return C.nb[S.sel.id] ? litBoxOf(S.sel.id) : null;
  var e = C.chart.edges[S.sel.id]; if (!e) return null;
  var b = C.eb[e.id], l = C.lb[e.id];
  return unionBox([nodeBox(e.from, 22), nodeBox(e.to, 22), b && { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 }, l && { x: l.x - 4, y: l.y - 4, w: l.w + 8, h: l.h + 8 }]);
}
function pinReveal() {
  if (!C || S.reading || cw < 10 || isWhole(C.chart) || C.chart.kind === 'overview' || !S.sel) return;
  var lit = litSetBox(); if (!lit || !(lit.w > 0)) return;
  var vr = typeof visRect === 'function' ? visRect() : { x0: 0, x1: cw }, padS = 16, padT = 58, padB = 56, fl = Math.min(1, fitFloor(C) || namesFloor(C)), s = view.s, small = false, tx, ty;
  if (S.walk && walkBar && !walkBar.hidden) padB = Math.max(padB, walkBar.offsetHeight + 34 + walkLift());
  var aw = vr.x1 - vr.x0 - 2 * padS, ah = ch - padT - padB, fits = function (z) { return lit.w * z <= aw && lit.h * z <= ah; };
  if (!fits(s)) {
    var z = Math.min(aw / lit.w, ah / lit.h), sf = fl * SMALL_NAME / MINPX;
    s = clamp(z, C.minS, s);                                    // zoomed out just as far as the lit set needs (never in, never past the chart's own minimum): names read down to reading size, the smaller view (8.5 px) shows them below that, and under that the chart is calm shapes with the box's words in the panel
    small = s < fl - 0.001 && s >= sf - 0.001;
  }
  var rx = lit.x * s + view.x, ry = lit.y * s + view.y, rw = lit.w * s, rh = lit.h * s;
  if (s === view.s && rx >= vr.x0 + padS && rx + rw <= vr.x1 - padS && ry >= padT && ry + rh <= ch - padB) return;
  if (s !== view.s || !fits(s)) { tx = (vr.x0 + vr.x1) / 2 - (lit.x + lit.w / 2) * s; ty = padT + ah / 2 - (lit.y + lit.h / 2) * s; }
  else {
    tx = view.x + (rx < vr.x0 + padS ? vr.x0 + padS - rx : rx + rw > vr.x1 - padS ? vr.x1 - padS - (rx + rw) : 0);
    ty = view.y + (ry < padT ? padT - ry : ry + rh > ch - padB ? ch - padB - (ry + rh) : 0);
  }
  if (S.sel.t === 'node' && C.nb[S.sel.id]) {                   // whatever else happens, the pinned box itself stays on the canvas
    var pb = C.nb[S.sel.id], px = pb.x * s + tx, py = pb.y * s + ty, pw = pb.w * s, ph = pb.h * s;
    tx += px < vr.x0 + padS ? vr.x0 + padS - px : px + pw > vr.x1 - padS ? vr.x1 - padS - (px + pw) : 0;
    ty += py < padT ? padT - py : py + ph > ch - padB ? ch - padB - (py + ph) : 0;
  }
  S.autoFit = false;
  if (small) S.smallFor = { chart: C.id, s: s, until: performance.now() + 420, auto: true };
  setView({ s: s, x: tx, y: ty }, true);
}

/* ---- pointer: drag, pinch, wheel, click, double-click------------------------------------------------------------- */
var ptrs = new Map(), drag = null, pinch = null, suppressUntil = 0;
canvas.addEventListener('pointerdown', function (e) {
  if (!C) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  HV.down = e.target.closest ? e.target.closest('g.node,g.edge,g.elabel') : null; HV.downAt = performance.now();
  hideTip();
  if (e.pointerType !== 'mouse') dropHover();       // touch: tap = pin, never a hover preview
  if (ptrs.size === 1) { cancelAnim(); drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false }; }
  else if (ptrs.size === 2) {
    cancelAnim(); drag = null;
    var a = Array.from(ptrs.values()), r = canvas.getBoundingClientRect();
    pinch = { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, s: view.s, cx: (a[0].x + a[1].x) / 2 - r.left, cy: (a[0].y + a[1].y) / 2 - r.top, vx: view.x, vy: view.y, moved: true };
  }
});
canvas.addEventListener('pointermove', function (e) {
  if (!ptrs.has(e.pointerId)) { if (e.pointerType !== 'touch') hoverAt(e); return; }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && ptrs.size >= 2) {
    var a = Array.from(ptrs.values()), r = canvas.getBoundingClientRect();
    var d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, ccx = (a[0].x + a[1].x) / 2 - r.left, ccy = (a[0].y + a[1].y) / 2 - r.top;
    var ns = clamp(pinch.s * d / pinch.d, C.minS, 4), k = ns / pinch.s;
    S.autoFit = false; userMoved();
    view.s = ns; view.x = ccx - (pinch.cx - pinch.vx) * k; view.y = ccy - (pinch.cy - pinch.vy) * k;
    schedule(); e.preventDefault(); return;
  }
  if (drag && e.pointerId === drag.id) {
    var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; canvas.classList.add('dragging'); try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } dropHover(); }
    if (drag.moved) { S.autoFit = false; userMoved(); view.x = drag.vx + dx; view.y = drag.vy + dy; schedule(); e.preventDefault(); }
  }
});
function endPointer(e) {
  var had = ptrs.has(e.pointerId); ptrs.delete(e.pointerId);
  if (!had) return;
  if (drag && drag.id === e.pointerId) { if (drag.moved) suppressUntil = performance.now() + 120; drag = null; canvas.classList.remove('dragging'); }
  if (pinch) { suppressUntil = performance.now() + 150; if (ptrs.size < 2) { pinch = null; if (ptrs.size === 1) { var p = Array.from(ptrs.entries())[0]; drag = { id: p[0], sx: p[1].x, sy: p[1].y, vx: view.x, vy: view.y, moved: false }; } } }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('lostpointercapture', function (e) { if (drag && drag.id === e.pointerId) { drag = null; canvas.classList.remove('dragging'); } });
canvas.addEventListener('pointerleave', function () { dropHover(); });
canvas.addEventListener('wheel', function (e) {
  if (!C) return; e.preventDefault(); cancelAnim();
  var r = canvas.getBoundingClientRect(), dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= r.height;
  zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.011 : 0.0017)), e.clientX - r.left, e.clientY - r.top, false);
  dropHover();
}, { passive: false });
/* a double-click means the box the FIRST click landed on. That click pins the box, opens the details panel and refits the view, so by the second press the box may have moved from under the pointer:
   the first click's box is kept here, the second press and click are claimed for it (nothing under the pointer, a road, or a word in the panel is picked instead), and the double-click acts on that box. */
var DBL = { id: '', chart: '', x: 0, y: 0, t: 0, done: 0 };
function dblPending(e) { return e.detail >= 2 && e.button === 0 && !!DBL.id && !!C && DBL.chart === C.id && performance.now() - DBL.t < 900 && Math.hypot(e.clientX - DBL.x, e.clientY - DBL.y) < 14; }
function dblOpen(id) {                                                   // a stage on the poster opens its own chart; any other box (an ending group, a box on a chart) is zoomed to, as the help says
  var n = C && C.chart.nodes[id]; if (!n) return;
  if (C.chart.kind === 'overview' && n.synth === 'stage' && openOverviewTarget(id)) return;
  zoomToNode(id);
}
document.addEventListener('mousedown', function (e) { if (dblPending(e)) e.preventDefault(); }, true);                  // no word is selected in the panel that opened under the pointer
document.addEventListener('click', function (e) {
  if (!dblPending(e)) return;
  var id = DBL.id; DBL.id = ''; DBL.done = performance.now(); e.preventDefault(); e.stopPropagation(); dblOpen(id);
}, true);
canvas.addEventListener('click', function (e) {
  if (!C || performance.now() < suppressUntil) return;
  DBL.id = '';
  var ht = e.target.closest ? e.target.closest('text.htitle') : null;              // a region title on its halo (zoomed out): pin that region
  if (ht && !S.pickFrom) { canvas.focus({ preventScroll: true }); toggleRegion(ht.dataset.region, e.shiftKey || e.ctrlKey || e.metaKey); return; }
  var sp = e.target.closest ? e.target.closest('g.stpill') : null;                  // a stage pill on the whole map: zoom to that stage
  if (sp && !S.pickFrom) { canvas.focus({ preventScroll: true }); zoomToRegions([sp.dataset.region], true); return; }
  var t = e.target.closest ? e.target.closest('g.node,g.edge,g.elabel') : null;
  // a focus change between press and release can re-stack an edge-label pill; the press target is still the right answer then
  if (!t && HV.down && HV.down.isConnected && performance.now() - HV.downAt < 700 && e.target.closest && e.target.closest('g.edge-labels')) t = HV.down;
  if (S.pickFrom) {
    if (t && t.classList.contains('node')) completePick(t.dataset.node); else if (!t) cancelPick();
    return;
  }
  canvas.focus({ preventScroll: true });
  if (!t) { if (S.sel || S.trace) clearAll(); else if (S.regSel.length) clearRegions(); return; }
  if (t.classList.contains('node')) { DBL.id = t.dataset.node; DBL.chart = C.id; DBL.x = e.clientX; DBL.y = e.clientY; DBL.t = performance.now(); selectNode(t.dataset.node, {}); } else selectEdge(t.dataset.edge || t.dataset.edgeLabel, {});
});
canvas.addEventListener('dblclick', function (e) {
  if (!C || performance.now() - DBL.done < 400) return; var t = e.target.closest ? e.target.closest('g.node') : null; if (!t) return;
  e.preventDefault(); dblOpen(t.dataset.node);
});
function zoomToNode(id) {
  var b = nodeBox(id); if (!b) return;
  dropHover(); hideTip(); userMoved();
  var s = view.s < 1 ? 1.15 : Math.min(view.s * 1.6, 3);
  centerOn(b.x + b.w / 2, b.y + b.h / 2, s, true);
}

/* ---- hover = focus.  Hovering a box, a route or a route label applies EXACTLY the same focus treatment as pinning it
   (paint() below is the only place that styles either).  A short intent delay keeps a fast sweep across the chart from
   strobing; a short leave grace and a "sticky" rule keep the focus steady while the pointer slides between a box and its
   own routes/labels.  A pin persists; hovering something else while pinned PREVIEWS it, mouse-leave returns to the pin. ---- */
var HV = { cand: null, timer: 0, x: 0, y: 0, down: null, downAt: 0 };
/* after a chart change no hover applies until the mouse really moves. The browser sends a synthetic mouse move when a new chart slides something under a still pointer; that must not light a chip or dim the chart. PT.lock holds the place the pointer was at the change. */
var PT = { x: -1, y: -1, lock: null };
function ptMove(e) { if (e.pointerType === 'touch') return; PT.x = e.clientX; PT.y = e.clientY; if (PT.lock && Math.hypot(e.clientX - PT.lock.x, e.clientY - PT.lock.y) > 3) PT.lock = null; }
window.addEventListener('pointermove', ptMove, true); window.addEventListener('mousemove', ptMove, true);
function lockHover() { PT.lock = PT.x >= 0 ? { x: PT.x, y: PT.y } : null; HV.esc = null; }
var HOVER_IN = 40, HOVER_OUT = 70, HOVER_STICKY = 320;
function sameRef(a, b) { return (!a && !b) || (a && b && a.t === b.t && a.id === b.id); }
function refOf(t) {
  if (!t) return null;
  if (t.classList.contains('htitle') || t.classList.contains('stpill')) return { t: 'region', id: t.dataset.region };
  return t.classList.contains('node') ? { t: 'node', id: t.dataset.node } : { t: 'edge', id: t.dataset.edge || t.dataset.edgeLabel };
}
function refAt(e) { return refOf(e.target.closest ? e.target.closest('g.node,g.edge,g.elabel,text.htitle,g.stpill') : null); }
function ownsRoute(nodeRef, r) {      // is r a route (or its label) that touches the hovered box?
  if (!nodeRef || nodeRef.t !== 'node' || !r || r.t !== 'edge' || !C) return false;
  var e = C.chart.edges[r.id]; return !!e && (e.from === nodeRef.id || e.to === nodeRef.id);
}
function hoverAt(e) {
  if (!C) return;
  HV.x = e.clientX; HV.y = e.clientY;
  if (PT.lock) return;
  if (HV.esc) { if (Math.hypot(e.clientX - HV.esc.x, e.clientY - HV.esc.y) < 8) return; HV.esc = null; }   // Esc clears the hover focus too, until the pointer really moves
  var h = refAt(e);
  if (!sameRef(h, HV.cand)) {
    HV.cand = h; clearTimeout(HV.timer); HV.timer = 0;
    if (!sameRef(h, S.hover)) {
      if (h) HV.timer = setTimeout(function () { HV.timer = 0; setHover(HV.cand); }, ownsRoute(S.hover, h) ? HOVER_STICKY : HOVER_IN);
      else HV.timer = setTimeout(function () { HV.timer = 0; setHover(null); }, HOVER_OUT);
    }
  }
  if (!tip.hidden) placeTip(e.clientX, e.clientY);
}
function dropHover() { clearTimeout(HV.timer); HV.timer = 0; HV.cand = null; setHover(null); }
function setHover(h, quiet) {
  if (sameRef(h, S.hover)) { if (!h) hideTip(); return; }
  S.hover = h; S.hsw++;
  paint();
  if (!h || h.t !== 'region') endRegionPreview();
  if (!h || quiet) { hideTip(); return; }
  if (S.sel && sameRef(h, S.sel)) { hideTip(); return; }                        // the pinned box already has its words in the details panel; its card is not drawn over the roads that were just lit
  var html;
  if (h.t === 'node') {
    var n = C.chart.nodes[h.id]; if (!n) { hideTip(); return; }
    if (isWhole(C.chart) && namesOn()) { hideTip(); return; }                     // the whole map's box already carries its name on screen: no tooltip repeating it
    html = '<span class="tip-top">' + (hOf(n) ? hchip(hOf(n)) : '') + '<span class="tip-cat">' + esc(kindInfo(kindOf(n)).label) + (n.status && n.status !== 'live' ? ' · ' + esc(STATUS_WORDS[n.status] || n.status) : '') + '</span></span><b>' + esc(n.title) + '</b>' +
      (hOf(n) && handleName(hOf(n)) ? '<span class="tip-sub">' + esc(handleName(hOf(n))) + '</span>' : '') + '<span class="tip-body">' + esc(trunc(n.plain || n.summary || '', 120)) + '</span>';
  } else if (h.t === 'region') {
    if (previewRegion(h.id) || isWhole(C.chart)) { hideTip(); return; }                    // the whole map lights the district and says nothing over the boxes
    html = regionTipHTML(h.id); if (!html) { hideTip(); return; }
  } else {
    var e = C.chart.edges[h.id]; if (!e) { hideTip(); return; }
    html = '<span class="tip-top"><span class="tip-cat">' + esc(typeWord(e.type || 'forward')) + (e.inferred ? ' · inferred' : '') + '</span></span><b>' + esc(eText(e)) + '</b><span class="tip-sub">' + esc(nodeName(e.from)) + ' → ' + esc(nodeName(e.to)) + '</span>';
  }
  tip.innerHTML = html; tip.hidden = false; placeTip(HV.x, HV.y);
}
/* what a pin has lit (its roads as points along them, its label pills and boxes as rectangles) is what a card must not sit on */
function litObstacles() {
  if (!C || !C.hl) return { pts: [], rects: [] };
  var key = S.hsw + ':' + S.hpaints + ':' + view.s.toFixed(3) + ':' + Math.round(view.x) + ':' + Math.round(view.y);
  if (C.lit && C.litKey === key) return C.lit;
  var cr = canvas.getBoundingClientRect(), pts = [], rects = [], step = Math.max(6, 12 / view.s);
  C.hl.edges.forEach(function (cls, id) {
    var el = C.edgeEl.get(id), p = el && el.querySelector('path.edge-line'), lb = C.labelEl.get(id);
    if (p && p.getTotalLength) { var len = p.getTotalLength(), l, q; for (l = 0; l <= len; l += step) { q = p.getPointAtLength(l); pts.push([q.x * view.s + view.x + cr.left, q.y * view.s + view.y + cr.top]); } }
    if (lb) { var b = lb.getBoundingClientRect(); if (b.width) rects.push(b); }
  });
  C.hl.nodes.forEach(function (cls, id) { var el = C.nodeEl.get(id), b = el && el.getBoundingClientRect(); if (b && b.width) rects.push(b); });
  C.lit = { pts: pts, rects: rects }; C.litKey = key; return C.lit;
}
function tipHits(X, Y, w, h, ob) {
  var i, q, p;
  for (i = 0; i < ob.rects.length; i++) { q = ob.rects[i]; if (X < q.right && X + w > q.left && Y < q.bottom && Y + h > q.top) return true; }
  for (i = 0; i < ob.pts.length; i++) { p = ob.pts[i]; if (p[0] > X - 3 && p[0] < X + w + 3 && p[1] > Y - 3 && p[1] < Y + h + 3) return true; }
  return false;
}
function placeTip(x, y) {
  if (tip.hidden) return;
  var w = tip.offsetWidth, h = tip.offsetHeight, X = x + 18, Y = y + 20, el = S.hover && S.hover.t === 'node' && C ? C.nodeEl.get(S.hover.id) : null, r = el ? el.getBoundingClientRect() : null;
  var cr = canvas.getBoundingClientRect(), bl = Math.max(6, cr.left + 6), bt = Math.max(6, cr.top + 6), br = Math.min(innerWidth - 8, cr.right - 6), bb = Math.min(innerHeight - 8, cr.bottom - 6);   // a card stays on the canvas: never over the details panel or the sidebar
  var fit = function (cx, cy) { return [Math.max(bl, Math.min(br - w, cx)), Math.max(bt, Math.min(bb - h, cy))]; };
  var cand = [];
  if (r && r.width > 0) {                                  // a box's card sits just under the box (else just over it, else beside it), never on it
    cand.push(fit(r.left + r.width / 2 - w / 2, r.bottom + 10), fit(r.left + r.width / 2 - w / 2, r.top - h - 10), fit(r.right + 12, r.top), fit(r.left - w - 12, r.top),
      fit(r.left + r.width / 2 - w / 2, r.bottom + 60), fit(r.left + r.width / 2 - w / 2, r.top - h - 60), fit(r.right + 12, r.top - h - 12), fit(r.left - w - 12, r.bottom + 12), fit(r.right + 60, r.top + 40), fit(r.left - w - 60, r.top + 40));      // more places to try, so a clear one is found more often
  } else {
    cand.push(fit(X, Y), fit(x - w - 16, Y), fit(X, y - h - 16), fit(x - w - 16, y - h - 16));
  }
  var pick = cand[0];
  if (S.sel || S.trace || (S.hover && S.hover.t === 'node' && C && C.hl && C.hl.nodes.size > 1)) {                                  // with something pinned (or lit by the pointer), a card goes where it covers none of what is lit, or is not drawn at all
    var ob = litObstacles(), k, ok = null;
    for (k = 0; k < cand.length; k++) { if (cand[k][0] > (r ? r.right : x) - 1 || cand[k][0] + w < (r ? r.left : x) + 1 || cand[k][1] > (r ? r.bottom : y) - 1 || cand[k][1] + h < (r ? r.top : y) + 1) { if (!tipHits(cand[k][0], cand[k][1], w, h, ob)) { ok = cand[k]; break; } } }
    if (!ok) { hideTip(); return; }
    pick = ok;
  } else if (r && r.width > 0) {                           // the first place (under, over, right, left) that is not on the box
    var kk; for (kk = 0; kk < cand.length; kk++) if (!(cand[kk][0] < r.right && cand[kk][0] + w > r.left && cand[kk][1] < r.bottom && cand[kk][1] + h > r.top)) { pick = cand[kk]; break; }
  }
  tip.style.left = Math.round(pick[0]) + 'px'; tip.style.top = Math.round(pick[1]) + 'px';
}
function hideTip() { tip.hidden = true; }
function namesOn() { return !!C && view.s * textBase(C).node >= MINPX; }                  // are the box names drawn at this zoom?
function nodeName(id) { var n = C && C.chart.nodes[id]; return n ? n.title : id; }

/* ================================================================ selection, highlight, trace */
function afterSelChange(o) {
  o = o || {};
  var roomedOpen = false;
  if (S.sel && wholeNow() && app.dataset.insp === 'collapsed') setInspCollapsed(false, true);      // a pinned box on the whole map brings the details panel with it
  else if (S.sel && S.roomed && !S.reading && app.dataset.insp === 'collapsed' && C && C.chart.kind === 'overview') { setInspCollapsed(false, true); S.pinOpened = true; }   // the poster is refitted into what the panel leaves (it fits whole), it is never slid to put the pinned box in the middle
  else if (S.sel && S.roomed && !S.reading && app.dataset.insp === 'collapsed') { setInspCollapsed(false, true); S.autoFit = false; measure(); roomedOpen = true; S.pinOpened = true; }   // a chart that was given the room: the pin brings the panel back, and the pinned box is kept in view (the zoom does not change)
  if (!S.sel && S.pinOpened && !S.reading && inspAuto() && app.dataset.insp === 'open') { S.pinOpened = false; setInspCollapsed(true, true); S.roomed = true; }   // the pin that brought the panel is gone: the panel goes with it (the person's own choice is never undone)
  if (S.sel && !onboardEl.hidden) { onboardEl.hidden = true; store.set(KEY.onboard, '1'); }
  paint(); renderInspector(true); writeHash(!!o.push); drawPickBanner();
  if (S.walk) walkSync();
  if (!S.sel && S.pre) restorePre();                                  // the pin is gone: the chart goes back to where it was before the pin (the panel it brought is already closed)
  if (S.sel) {
    var n = S.sel.t === 'node' ? C.chart.nodes[S.sel.id] : null;
    if (n) announce('Selected ' + n.title + '. ' + (C.inn[n.id] || []).length + ' roads arrive, ' + (C.out[n.id] || []).length + ' leave.');
    else { var e = C.chart.edges[S.sel.id]; if (e) announce('Selected road: ' + nodeName(e.from) + ' to ' + nodeName(e.to) + '. ' + eShort(e)); }
  } else announce('Selection cleared.');
}
function selectNode(id, o) {
  o = o || {}; if (!C || !C.chart.nodes[id]) return;
  if (!('reveal' in o)) snapPre();
  S.sel = { t: 'node', id: id }; S.trace = null; S.pickFrom = null; if (!o.keepAlt) S.alt = null;
  afterSelChange(o);
  if (!('reveal' in o)) pinReveal();                                  // a click on a box brings its lit set onto the canvas
  else if (o.reveal) reveal(o.reveal === 'zoom' ? nodeBox(id, 40) : unionBox([nodeBox(id, 60)]), { minScale: o.minScale || 0.7, center: o.center, lit: o.lit, also: o.also ? unionBox(o.also.map(function (k) { return nodeBox(k, 40); })) : null });
}
function selectEdge(id, o) {
  o = o || {}; if (!C || !C.chart.edges[id]) return;
  if (!('reveal' in o)) snapPre();
  S.sel = { t: 'edge', id: id }; S.trace = null; S.pickFrom = null; S.alt = null;
  afterSelChange(o);
  if (!('reveal' in o)) pinReveal();
  else if (o.reveal) reveal(edgeBox(id), { minScale: 0.6, maxScale: 1, center: o.center });
}
function clearAll() { S.sel = null; S.trace = null; S.pickFrom = null; S.alt = null; canvas.classList.remove('picking'); afterSelChange({}); }

/* focus of one box or route: the single definition used by a pin AND by a hover */
function hlForRef(ref) {
  var nodes = new Map(), edges = new Map(), put = function (m, k, v) { if (!m.has(k)) m.set(k, v); };
  if (!C || !ref) return { nodes: nodes, edges: edges };
  if (ref.t === 'node') {
    var id = ref.id; if (!C.chart.nodes[id]) return { nodes: nodes, edges: edges };
    nodes.set(id, 'sel');
    (C.inn[id] || []).forEach(function (eid) { edges.set(eid, 'in'); var f = C.chart.edges[eid].from; if (f !== id) put(nodes, f, 'n-in'); });
    (C.out[id] || []).forEach(function (eid) { if (!edges.has(eid)) edges.set(eid, 'out'); var t = C.chart.edges[eid].to; if (t !== id) put(nodes, t, 'n-out'); });
  } else {
    var e = C.chart.edges[ref.id]; if (!e) return { nodes: nodes, edges: edges };
    edges.set(e.id, 'sel'); put(nodes, e.from, 'n-in'); put(nodes, e.to, 'n-out');
  }
  return { nodes: nodes, edges: edges };
}
function previewRef() { return S.hover && S.hover.t !== 'region' && !sameRef(S.hover, S.sel) ? S.hover : null; }
function computeHL(prev) {
  var nodes = new Map(), edges = new Map(), put = function (m, k, v) { if (!m.has(k)) m.set(k, v); };
  if (!C) return { nodes: nodes, edges: edges };
  if (prev) return hlForRef(prev);
  if (S.trace) {
    var T = S.trace, nc = T.kind === 'down' ? 'n-out' : T.kind === 'up' ? 'n-in' : 'n-path', ec = T.kind === 'down' ? 'out' : T.kind === 'up' ? 'in' : 'path';
    T.nodes.forEach(function (id) { put(nodes, id, nc); });
    T.edges.forEach(function (id) { put(edges, id, ec); });
    (T.ends || []).forEach(function (id) { nodes.set(id, 'sel'); });
  } else if (S.sel) {
    return hlForRef(S.sel);
  }
  return { nodes: nodes, edges: edges };
}
/* The one painter.  Pinned/traced state or, while the pointer rests on something else, a preview of that item. */
function paint() {
  if (!C) return;
  S.hpaints++;
  C.marked.forEach(function (m) { m[0].classList.remove.apply(m[0].classList, m[1]); });
  C.marked = [];
  while (C.raised.length) { var r = C.raised.pop(); r.p.insertBefore(r.el, r.n); }      // put raised edge-label pills back where they were
  var prev = previewRef(), h = S.hover && S.hover.t === 'region' ? { nodes: new Map(), edges: new Map() } : computeHL(prev); C.hl = h;
  var add = function (el, cls) { if (!el) return; el.classList.add.apply(el.classList, cls); C.marked.push([el, cls]); };
  h.nodes.forEach(function (cls, id) { add(C.nodeEl.get(id), ['rel', cls]); });
  h.edges.forEach(function (cls, id) {
    add(C.edgeEl.get(id), ['rel', 'hi-' + cls]);
    var lb = C.labelEl.get(id);
    if (lb) { add(lb, ['rel', 'hi-' + cls]); if (C.labelsG && lb.parentNode === C.labelsG) { C.raised.push({ el: lb, p: lb.parentNode, n: lb.nextSibling }); C.labelsG.appendChild(lb); } }   // related pills above everything
  });
  C.svg.classList.toggle('has-sel', h.nodes.size > 0 || h.edges.size > 0);
  C.svg.classList.toggle('previewing', !!prev);
  if (prev && S.sel) {                                                                  // the pinned item drops to a subtle outline
    if (S.sel.t === 'node') add(C.nodeEl.get(S.sel.id), ['pin-ghost']); else { add(C.edgeEl.get(S.sel.id), ['pin-ghost']); add(C.labelEl.get(S.sel.id), ['pin-ghost']); }
  }
  if (S.hover) {                                                                        // marks what the pointer is actually over
    if (S.hover.t === 'node') add(C.nodeEl.get(S.hover.id), ['hov']); else { add(C.edgeEl.get(S.hover.id), ['hov']); add(C.labelEl.get(S.hover.id), ['hov']); }
  }
  if (C.pressed) { C.pressed.removeAttribute('aria-pressed'); C.pressed = null; }
  if (S.sel && S.sel.t === 'node') { var pe = C.nodeEl.get(S.sel.id); if (pe) { pe.setAttribute('aria-pressed', 'true'); C.pressed = pe; } }
  paintRegions(h.nodes.size > 0 || h.edges.size > 0);     // regions: only when no box / route focus is active (a region preview always wins)
  paintPortalFocus();
  drawMini();
  fire(paintHooks);
}

/* ---- trace (downstream / upstream / path) ------------------------------------------------------------------------- */
function bfs(start, dir) {
  var nodes = new Set([start]), edges = new Set(), q = [start];
  while (q.length) {
    var u = q.shift(), list = (dir === 'down' ? C.out[u] : C.inn[u]) || [];
    for (var i = 0; i < list.length; i++) {
      var eid = list[i], e = C.chart.edges[eid], v = dir === 'down' ? e.to : e.from;
      edges.add(eid); if (!nodes.has(v)) { nodes.add(v); q.push(v); }
    }
  }
  return { nodes: nodes, edges: edges };
}
function traceDir(dir) {
  if (!C || !S.sel) return;
  var origin, extra = null, ends;
  if (S.sel.t === 'node') { origin = S.sel.id; ends = [origin]; }
  else { var e = C.chart.edges[S.sel.id]; origin = dir === 'down' ? e.to : e.from; extra = e.id; ends = [e.from, e.to]; }
  var r = bfs(origin, dir);
  if (extra) r.edges.add(extra);
  S.trace = { kind: dir, origin: origin, nodes: r.nodes, edges: r.edges, ends: ends };
  S.pickFrom = null; canvas.classList.remove('picking');
  paint(); renderInspector(false); drawPickBanner();
  var bb = unionBox(Array.from(r.nodes).map(function (id) { return nodeBox(id); }));
  if (r.nodes.size > 1) reveal(bb, { minScale: 0.0001, maxScale: 1, center: false });
  announce('Tracing everything ' + (dir === 'down' ? 'downstream' : 'upstream') + ': ' + (r.nodes.size - 1) + ' more steps, ' + r.edges.size + ' roads.');
}
function startPick() {
  if (!S.sel || S.sel.t !== 'node') return;
  S.pickFrom = S.sel.id; S.trace = null; canvas.classList.add('picking');
  paint(); renderInspector(false); drawPickBanner();
  announce('Choose a second step on the chart to trace the path to it.');
}
function cancelPick() { S.pickFrom = null; canvas.classList.remove('picking'); renderInspector(false); drawPickBanner(); }
function drawPickBanner() {
  if (S.pickFrom) { pickBanner.hidden = false; pickBanner.textContent = 'Click a second step, or search for it and press Enter, to trace a road from “' + nodeName(S.pickFrom) + '”  ·  Esc cancels'; }
  else pickBanner.hidden = true;
}
function completePick(id) {
  var a = S.pickFrom; if (id === a) { announce('Pick a different step.'); return; }
  S.pickFrom = null; canvas.classList.remove('picking');
  var res = findPaths(a, id);
  S.sel = { t: 'node', id: a };
  S.trace = { kind: 'path', a: a, b: id, ends: [a, id], nodes: res ? res.nodes : new Set(), edges: res ? res.edges : new Set(), res: res };
  paint(); renderInspector(false); drawPickBanner();
  if (res) reveal(unionBox(Array.from(res.nodes).map(function (n) { return nodeBox(n); })), { minScale: 0.0001, maxScale: 1 });
  announce(res ? 'Path found: ' + res.steps.length + ' steps.' : 'No road connects those two steps.');
}
/* Trace path. If both boxes lie on one declared path, the answer follows that path and says which. Otherwise a weighted search over the forward roads of this chart: a road costs 1, a change
   of stage costs about 6, a road that is a step of the main path costs far less; ties break the same way every time. It is "a route the roads allow", never a promise that one request takes it.
   The plain fewest-steps search (shortestPaths) stays, behind a button. */
var ROUTE_COST = { road: 1, stage: 6, main: 0.2 };
function declaredRoute(a, b) {
  var order = DATA.paths || [], E = C.chart.edges, i, k;
  for (i = 0; i < order.length; i++) {
    var ids = strs(order[i].boxes), ia = ids.indexOf(a), ib = ia < 0 ? -1 : ids.indexOf(b, ia + 1), back = false;   // a path may repeat a box: a step is an index, so look for b AFTER a, and failing that a after b
    if (ib < 0) { ib = ids.indexOf(b); ia = ib < 0 ? -1 : ids.indexOf(a, ib + 1); back = ia >= 0; }
    if (ia < 0 || ib < 0 || ia === ib) continue;
    var lo = Math.min(ia, ib), hi = Math.max(ia, ib), seq = ids.slice(lo, hi + 1); if (back) seq.reverse();
    var steps = [], nodes = new Set(), edges = new Set(), ok = true;
    for (k = 0; k < seq.length; k++) {
      var n = seq[k], here = !!C.chart.nodes[n], eid = null;
      if (here) nodes.add(n);
      if (k) {
        var p = seq[k - 1], best = null;
        (C.out[p] || []).forEach(function (id) { var e = E[id]; if (e && e.to === n && (!best || (E[best].type === 'return' && e.type !== 'return'))) best = id; });
        if (best) { eid = best; edges.add(best); }
      }
      steps.push({ node: n, edge: eid, off: !here });
    }
    if (!ok) continue;
    var title = order[i].title && order[i].title !== order[i].id ? order[i].title : order[i].id;
    return { nodes: nodes, edges: edges, steps: steps.slice(1), dist: seq.length - 1, mode: 'declared', first: seq[0], last: seq[seq.length - 1], reversed: back, pathId: order[i].id, pathTitle: title, offN: steps.filter(function (x) { return x.off; }).length };
  }
  return null;
}
function weightedRoute(a, b) {
  var E = C.chart.edges, N = C.chart.nodes, main = pathIdsOf(MAIN_ID), mp = {}, i;
  for (i = 0; i + 1 < main.length; i++) mp[main[i] + '>' + main[i + 1]] = 1;
  if (!N[a] || !N[b]) return null;
  var best = {}, done = {}, heap = [], seq = 0;
  var lt = function (x, y) { return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  var push = function (it) { heap.push(it); var j = heap.length - 1; while (j > 0) { var q = (j - 1) >> 1; if (lt(heap[j], heap[q]) >= 0) break; var t = heap[j]; heap[j] = heap[q]; heap[q] = t; j = q; } };
  var pop = function () { var top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; var j = 0; for (;;) { var l = 2 * j + 1, r = l + 1, m = j; if (l < heap.length && lt(heap[l], heap[m]) < 0) m = l; if (r < heap.length && lt(heap[r], heap[m]) < 0) m = r; if (m === j) break; var t = heap[j]; heap[j] = heap[m]; heap[m] = t; j = m; } } return top; };
  best[a] = { c: 0, h: 0, via: null }; push([0, 0, 0, a]);
  while (heap.length) {
    var it = pop(), u = it[3]; if (done[u]) continue; done[u] = 1; if (u === b) break;
    var list = C.out[u] || [];
    for (i = 0; i < list.length; i++) {
      var e = E[list[i]]; if (!e || e.type === 'return') continue;
      var v = e.to, c = it[0] + (mp[e.from + '>' + e.to] ? ROUTE_COST.main : ROUTE_COST.road + ((N[e.from] && N[e.from].stage || '') !== (N[v] && N[v].stage || '') ? ROUTE_COST.stage : 0)), h = it[1] + 1, cur = best[v];
      if (!done[v] && (!cur || c < cur.c - 1e-9 || (Math.abs(c - cur.c) < 1e-9 && h < cur.h))) { best[v] = { c: c, h: h, via: list[i] }; push([c, h, ++seq, v]); }
    }
  }
  if (!best[b]) return null;
  var steps = [], nodes = new Set([a]), edges = new Set(), cur2 = b, guard = 0, changes = 0;
  while (cur2 !== a && guard++ < 5000) { var eid = best[cur2].via, ed = E[eid]; steps.unshift({ edge: eid, node: cur2 }); edges.add(eid); nodes.add(cur2); if ((N[ed.from].stage || '') !== (N[ed.to].stage || '')) changes++; cur2 = ed.from; }
  return { nodes: nodes, edges: edges, steps: steps, dist: steps.length, changes: changes };
}
function togglePlainPath() {                       // the declared / weighted answer, or the plain fewest-steps one
  var T = S.trace; if (!T || T.kind !== 'path') return;
  var res;
  if (T.res && (T.res.mode === 'declared' || T.res.mode === 'plain')) res = T.res.mode === 'plain' ? findPaths(T.a, T.b) : (weightedRoute(T.a, T.b) || shortestPaths(T.a, T.b, false));
  else res = shortestPaths(T.a, T.b, false);
  if (!res) return;
  if (!res.mode) res.mode = T.res && T.res.mode === 'forward' ? 'plain' : 'forward';
  if (res.mode === 'forward' && T.res && T.res.mode === 'declared') res.mode = 'forward';
  T.res = res; T.nodes = res.nodes; T.edges = res.edges;
  paint(); renderInspector(false);
  if (res.nodes.size) reveal(unionBox(Array.from(res.nodes).filter(function (n) { return C.chart.nodes[n]; }).map(function (n) { return nodeBox(n); })), { minScale: 0.0001, maxScale: 1 });
}
function findPaths(a, b) {
  var r = declaredRoute(a, b); if (r) return r;
  r = weightedRoute(a, b); if (r) { r.mode = 'forward'; return r; }
  r = weightedRoute(b, a); if (r) { r.mode = 'backward'; return r; }
  r = shortestPaths(a, b, true); if (r) { r.mode = 'either'; return r; }
  return null;
}
function shortestPaths(a, b, und) {
  var E = C.chart.edges;
  var fwd = function (u) { var r = [], i, l = C.out[u] || []; for (i = 0; i < l.length; i++) r.push([l[i], E[l[i]].to]); if (und) { l = C.inn[u] || []; for (i = 0; i < l.length; i++) r.push([l[i], E[l[i]].from]); } return r; };
  var rev = function (u) { var r = [], i, l = C.inn[u] || []; for (i = 0; i < l.length; i++) r.push([l[i], E[l[i]].from]); if (und) { l = C.out[u] || []; for (i = 0; i < l.length; i++) r.push([l[i], E[l[i]].to]); } return r; };
  var dist = function (s, adj) { var d = new Map([[s, 0]]), q = [s]; while (q.length) { var u = q.shift(); adj(u).forEach(function (p) { if (!d.has(p[1])) { d.set(p[1], d.get(u) + 1); q.push(p[1]); } }); } return d; };
  var dA = dist(a, fwd); if (!dA.has(b)) return null;
  var dB = dist(b, rev), D = dA.get(b), nodes = new Set([a, b]), edges = new Set();
  Object.keys(E).forEach(function (eid) {
    var e = E[eid], ok = function (u, v) { return dA.has(u) && dB.has(v) && dA.get(u) + 1 + dB.get(v) === D; };
    if (ok(e.from, e.to) || (und && ok(e.to, e.from))) { edges.add(eid); nodes.add(e.from); nodes.add(e.to); }
  });
  var steps = [], cur = a, guard = 0;
  while (cur !== b && guard++ < 2000) {
    var nxt = fwd(cur).filter(function (p) { return edges.has(p[0]) && dA.get(cur) + 1 === dA.get(p[1]) && dB.has(p[1]) && dA.get(p[1]) + dB.get(p[1]) === D; })[0];
    if (!nxt) break; steps.push({ edge: nxt[0], node: nxt[1] }); cur = nxt[1];
  }
  return { nodes: nodes, edges: edges, steps: steps, dist: D };
}

/* ---- keyboard walking: follow routes with the arrow keys -------------------------------------------------------- */
function entryNodes() {
  var ids = Object.keys(C.chart.nodes).filter(function (id) { return !(C.inn[id] || []).length; });
  if (!ids.length) ids = Object.keys(C.chart.nodes);
  return ids.sort(function (a, b) { var A = C.nb[a] || { x: 0, y: 0 }, B = C.nb[b] || { x: 0, y: 0 }; return A.x - B.x || A.y - B.y; });
}
function endNodes() {
  return Object.keys(C.chart.nodes).filter(function (id) { return !(C.out[id] || []).length; }).sort(function (a, b) { var A = C.nb[a] || { x: 0, y: 0 }, B = C.nb[b] || { x: 0, y: 0 }; return B.x - A.x || A.y - B.y; });
}
function walk(dir) {
  if (!S.sel) return false;
  if (S.sel.t === 'edge') { var e = C.chart.edges[S.sel.id]; selectNode(dir === 'next' ? e.to : e.from, { reveal: true }); return true; }
  var list = (dir === 'next' ? C.out : C.inn)[S.sel.id] || [];
  if (!list.length) { announce(dir === 'next' ? 'This is an end point: no road leaves here.' : 'This is a starting point: no road arrives here.'); return true; }
  S.alt = { origin: S.sel.id, dir: dir, list: list, idx: 0 };
  applyAlt();
  return true;
}
function applyAlt() {
  var A = S.alt, e = C.chart.edges[A.list[A.idx]], target = A.dir === 'next' ? e.to : e.from;
  var keep = S.alt;
  selectNode(target, { keepAlt: true, reveal: true });
  S.alt = keep;
  if (keep.list.length > 1) announce('Road ' + (keep.idx + 1) + ' of ' + keep.list.length + ': ' + eShort(e) + '. Press Tab or the up and down arrows for the other roads.');
}
function cycleAlt(delta, wrap) {
  var A = S.alt; if (!A || A.list.length < 2) return false;
  var n = A.idx + delta;
  if (!wrap && (n < 0 || n >= A.list.length)) return false;
  A.idx = (n + A.list.length) % A.list.length; applyAlt(); return true;
}

/* ================================================================ inspector */
function badgeCat(cat) {
  var cls = isWaitKind(cat) ? 'hold' : isEndKind(cat) ? 'exit' : '';
  return '<span class="badge"><i class="sw ' + cls + '" style="--c:' + catColor(cat) + '"></i>' + esc(kindInfo(cat).label) + '</span>';
}
function statusBadge(n) {
  if (!n.status || n.status === 'live') return '';
  var tip = n.status === 'off' ? 'Off by default' + (n.switch ? ': turned on by ' + n.switch : '') : n.status === 'default-on' ? 'On by default' + (n.switch ? ': can be turned off with ' + n.switch : '') : n.status === 'test-only' ? 'Only a test reaches this' : '';
  return '<span class="badge st-' + esc(String(n.status).replace(/[^a-z-]/gi, '')) + '" title="' + esc(tip) + '">' + esc(STATUS_WORDS[n.status] || n.status) + (n.switch ? ' · <code>' + esc(n.switch) + '</code>' : '') + '</span>';
}
function typeBadge(t) {
  return '<span class="badge"><svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true"><line x1="1" y1="5" x2="21" y2="5" stroke="' + edgeColor(t) + '" stroke-width="2.6"' + (edgeDash(t) ? ' stroke-dasharray="5 3"' : '') + '/></svg>' + esc(typeWord(t)) + '</span>';
}
/* source links: META.sourceBase (a folder URL, or a template holding {path} and {line}); without one the reference is plain text */
function srcHref(r) {
  var b = META.sourceBase; if (!b || !r || !r.path) return '';
  var p = String(r.path).split('/').map(encodeURIComponent).join('/');
  if (b.indexOf('{path}') >= 0) return b.replace('{path}', p).replace('{line}', r.line || '');
  return b.replace(/\/*$/, '/') + p + (r.line ? '#L' + r.line : '');
}
function fnOf(r) { var s = r && r.symbol ? String(r.symbol) : '', i = s.indexOf('::'); return i >= 0 ? s.slice(i + 2) : s; }
function pathHTML(p) { return esc(p || '').replace(/\//g, '/<wbr>'); }          // a source path may wrap after a slash, never inside a file name ("service.p / y:11137")
function refsHTML(refs, open, more) {
  refs = refs || [];
  if (!refs.length) return '';
  var pin = META.pin || (META.source && META.source.pin) || '';
  return '<details class="src"' + (open ? ' open' : '') + '><summary>' + (more ? refs.length + ' more anchor' + (refs.length === 1 ? '' : 's') : 'Source · ' + refs.length + ' anchor' + (refs.length === 1 ? '' : 's')) + '</summary><div class="src-list">' +
    refs.map(function (r) {
      var loc = pathHTML(r.path) + (r.line ? ':' + r.line : ''), href = srcHref(r);
      return '<div class="ref">' + (fnOf(r) ? '<b class="ref-fn">' + esc(fnOf(r)) + '</b>' : '') + (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + loc + '</a>' : '<span class="ref-loc">' + loc + '</span>') + '</div>' +
        (r.excerpt ? '<pre class="ref-ex" style="margin:2px 0 8px;padding:8px;overflow:auto;max-height:12em;font:12px/1.45 var(--mono,monospace);background:var(--panel2,#0003);border:1px solid var(--line,#fff2);border-radius:6px;white-space:pre">' + esc(r.excerpt) + '</pre>' : '');
    }).join('') + '</div>' + (pin ? '<p class="quiet" style="margin-top:8px;font-size:.85rem">Pinned source: ' + esc(pin) + '.</p>' : '') + '</details>';
}
function routeBtn(eid, dir, main) {
  var e = C.chart.edges[eid], other = dir === 'in' ? e.from : e.to, ty = e.type || 'forward';
  return '<button type="button" class="route ' + dir + (e.inferred ? ' inferred' : '') + (main ? ' main' : '') + '" data-edge="' + esc(eid) + '" title="' + esc(e.why || e.label || '') + '"><span class="r-label">' + (main ? '<i class="r-main">main path</i>' : '') + esc(eText(e)) + '</span><span class="r-node">' + (dir === 'in' ? 'from ' : 'to ') + esc(nodeName(other)) + (ty !== 'forward' ? '<span class="r-type"> · ' + esc(typeWord(ty)) + '</span>' : '') + (e.inferred ? '<span class="r-type"> · inferred</span>' : '') + '</span></button>';
}
function actionsHTML(sel) {
  var picking = !!S.pickFrom, tk = S.trace && S.trace.kind;
  return '<div class="actions">' +
    '<button type="button" class="act down' + (tk === 'down' ? ' on' : '') + '" data-act="down">Trace everything downstream</button>' +
    '<button type="button" class="act up' + (tk === 'up' ? ' on' : '') + '" data-act="up">Trace everything upstream</button>' +
    (sel.t === 'node' ? '<button type="button" class="act' + (picking || tk === 'path' ? ' on' : '') + '" data-act="path">Trace path…</button>' : '') +
    '<button type="button" class="act ghost" data-act="clear">Clear</button></div>';
}
function declaredNote(T, r) {                  // both boxes on one declared path: the answer follows it
  var items = [{ node: r.first, edge: null, off: !C.chart.nodes[r.first] }].concat(r.steps);
  var list = '<ol class="steps">' + items.map(function (s) {
    var cid = s.off ? chartForNode(s.node) : '', nm = (boxAny(s.node) || { title: s.node }).title;
    return '<li class="' + (s.off ? 'off' : '') + '">' + (s.off ? '<button type="button" data-open-chart="' + esc(cid || '') + '" data-open-node="' + esc(s.node) + '">' + esc(nm) + '<small>on ' + esc(cid && CH[cid] ? CH[cid].navLabel : 'another chart') + '</small></button>' : '<button type="button" data-node="' + esc(s.node) + '">' + esc(nm) + (s.edge ? '<small>' + esc(eShort(C.chart.edges[s.edge])) + '</small>' : '') + '</button>') + '</li>';
  }).join('') + '</ol>';
  return '<div class="callout path"><b>Along the declared path “' + esc(r.pathTitle) + '”: ' + (r.dist + 1) + ' boxes</b> (' + r.dist + ' step' + (r.dist === 1 ? '' : 's') + ' between them) ' + (r.reversed ? 'from “' + esc(nodeName(T.b)) + '” to “' + esc(nodeName(T.a)) + '”, the other way round' : 'from “' + esc(nodeName(T.a)) + '” to “' + esc(nodeName(T.b)) + '”') + '. Both boxes lie on that path, so the answer follows it; it is the way the map&rsquo;s author wrote one request going.' +
    (r.offN ? ' ' + r.offN + ' of its boxes ' + (r.offN === 1 ? 'is' : 'are') + ' drawn on other charts (marked below).' : '') + '<button type="button" class="act ghost sm" data-act="path-plain">Show one way the roads allow instead</button></div>' + list;
}
var WHOLE_ADJ = null;
function wholeChart() { return Object.keys(CH).map(function (id) { return CH[id]; }).filter(isWhole)[0] || null; }
function wholeReach(origin, dir) {                 // every box that can follow (down) or lead to (up) the origin, over every road the model draws
  var W = wholeChart(); if (!W || !W.nodes[origin]) return null;
  if (!WHOLE_ADJ) { WHOLE_ADJ = { down: {}, up: {} }; Object.keys(W.edges).forEach(function (k) { var e = W.edges[k]; (WHOLE_ADJ.down[e.from] = WHOLE_ADJ.down[e.from] || []).push(e.to); (WHOLE_ADJ.up[e.to] = WHOLE_ADJ.up[e.to] || []).push(e.from); }); }
  var adj = WHOLE_ADJ[dir === 'up' ? 'up' : 'down'], seen = new Set([origin]), q = [origin], h = 0;
  while (h < q.length) { var l = adj[q[h++]] || []; for (var i = 0; i < l.length; i++) if (!seen.has(l[i])) { seen.add(l[i]); q.push(l[i]); } }
  return seen;
}
function elsewhereCount(T) {                       // how many more steps lie on other charts (null when this IS the whole map, or no whole map exists)
  if (!T || (T.kind !== 'down' && T.kind !== 'up') || isWhole(C.chart)) return null;
  if (T._more != null) return T._more;
  var all = wholeReach(T.origin, T.kind); if (!all) return (T._more = null);
  var n = 0; all.forEach(function (id) { if (id !== T.origin && !C.chart.nodes[id]) n++; });
  return (T._more = n);
}
function traceOnWhole(dir) {
  var T = S.trace, W = wholeChart(); if (!T || !W) return;
  var origin = T.origin; pushJump(); openChart(W.id, origin, { push: true });
  if (C && C.chart.nodes[origin]) { selectNode(origin, { reveal: false }); traceDir(dir); }
}
function traceNote() { var h = traceNote0(); return S.trace && S.trace.note ? '<p class="tr-moved">' + esc(S.trace.note) + '</p>' + h : h; }
function traceNote0() {
  var T = S.trace; if (!T) return '';
  if (T.kind === 'path') {
    var r = T.res;
    if (!r) return '<div class="callout path"><b>No road connects</b> “' + esc(nodeName(T.a)) + '” and “' + esc(nodeName(T.b)) + '” in either direction.</div>';
    if (r.mode === 'declared') return declaredNote(T, r);
    var how = r.mode === 'forward' || r.mode === 'plain' ? 'from “' + esc(nodeName(T.a)) + '” to “' + esc(nodeName(T.b)) + '”' : r.mode === 'backward' ? 'the other way round: from “' + esc(nodeName(T.b)) + '” to “' + esc(nodeName(T.a)) + '”' : 'ignoring arrow direction (no one-way path exists)';
    var from = r.mode === 'backward' ? T.b : T.a, list = '';
    if (r.mode === 'forward' || r.mode === 'plain' || r.mode === 'backward') list = '<ol class="steps"><li><button type="button" data-node="' + esc(from) + '">' + esc(nodeName(from)) + '</button></li>' + r.steps.map(function (s) { return '<li><button type="button" data-node="' + esc(s.node) + '">' + esc(nodeName(s.node)) + '<small>' + esc(eShort(C.chart.edges[s.edge])) + '</small></button></li>'; }).join('') + '</ol>';
    var plain = r.mode === 'plain';
    return '<div class="callout path"><b>' + (plain ? 'Fewest steps: ' : 'One way the roads allow: ') + r.dist + ' step' + (r.dist === 1 ? '' : 's') + '</b> (' + (r.dist + 1) + ' boxes counting both ends) ' + how + (r.changes ? ', changing stage ' + r.changes + ' time' + (r.changes === 1 ? '' : 's') : '') + '.' + (r.mode === 'either' ? '' : plain ? ' Equally short alternatives are lit too.' : ' It is not a promise that one request takes it.') + (isWhole(C.chart) ? '' : ' <small class="quiet">Only roads on this chart are searched.</small>') +
      (r.mode === 'either' ? '' : '<button type="button" class="act ghost sm" data-act="path-plain">' + (plain ? 'Show the weighted way again' : 'Show the fewest-steps way instead') + '</button>') + '</div>' + list;
  }
  var n = T.nodes.size - (T.kind === 'down' || T.kind === 'up' ? 1 : 0), more = elsewhereCount(T);
  return '<div class="callout ' + (T.kind === 'down' ? 'out' : 'in') + '"><b>Tracing everything ' + (T.kind === 'down' ? 'downstream' : 'upstream') + ' on this chart</b>: ' + n + ' step' + (n === 1 ? '' : 's') + ' and ' + T.edges.size + ' road' + (T.edges.size === 1 ? '' : 's') + (T.kind === 'down' ? ' can follow.' : ' can lead here.') +
    (more > 0 ? ' <b>' + more + ' more step' + (more === 1 ? '' : 's') + ' lie on other charts.</b> <button type="button" class="act sm" data-act="trace-whole" data-dir="' + esc(T.kind) + '">See all of them on the whole map</button>' : more === 0 && !isWhole(C.chart) ? ' Nothing more lies on other charts.' : '') + '</div>';
}
/* compact "official handle" block at the top of a step's details: chip + full name + meaning + definition on demand */
function handleBlock(n) {
  var codes = codesOf(n), tg = hOf(n);
  if (!tg && !codes.length) return '';
  var h = '<div class="hblock' + (tg ? ' fam-' + famClass(famOf(tg)) : '') + '">';
  if (tg) {
    var inf = LAY[tg], nm = handleName(tg), hh = findHandle(tg), cnt = hh ? hh.count : 0;
    var mods = inf && Array.isArray(inf.modules) ? inf.modules.map(function (m) { return typeof m === 'string' ? m : (m && (m.path || m.name || m.module)) || ''; }).filter(Boolean) : [];
    h += '<div class="hb-main">' + hchipBtn(tg, 'hb-chip') + '<div class="hb-txt"><b>' + esc(nm || (inf ? tg : 'Official name')) + '</b>' + (inf && inf.family ? '<span class="hb-fam">' + esc(inf.family) + '</span>' : '') + '</div></div>';
    if (inf && inf.meaning) h += '<p class="hb-mean">' + esc(inf.meaning) + '</p>';
    var off = inf && typeof inf.official === 'string' ? inf.official : '';
    if (off || mods.length || (inf && inf.confidence != null && inf.confidence !== '')) {
      h += '<details class="hb-more"><summary>Official definition</summary>' + (off ? '<p>' + esc(off) + '</p>' : '') +
        (mods.length ? '<p class="quiet"><b>Source modules</b> ' + mods.map(function (m) { return '<code>' + esc(m) + '</code>'; }).join(' ') + '</p>' : '') +
        (inf.confidence != null && inf.confidence !== '' ? '<p class="quiet"><b>Confidence</b> ' + esc(typeof inf.confidence === 'object' ? JSON.stringify(inf.confidence) : inf.confidence) + '</p>' : '') + '</details>';
    }
    h += '<button type="button" class="act ghost hb-where" data-handle="' + esc(tg) + '">Where ' + esc(tg) + ' appears' + (cnt > 1 ? ' · ' + cnt + ' steps' : '') + '</button>';
  }
  if (codes.length) h += '<div class="hb-also"><span class="eyebrow">Also touches</span>' + codes.map(function (t) { return hchipBtn(t); }).join('') + '</div>';
  return h + '</div>';
}
/* a person hands an agent an exact spot: `faultline where <box>`; an agent hands a person the link */
function pointerText(id) { return 'faultline where ' + (/\s/.test(id) ? '"' + id + '"' : id); }
function copyText(txt, btn) {
  S.lastCopy = txt;
  var done = function (ok) {
    announce(ok ? 'Copied: ' + txt : 'Could not copy. Select the text and press Ctrl+C.');
    if (!btn || !btn.isConnected) return;
    var lab = btn.dataset.lab || (btn.dataset.lab = btn.textContent); btn.textContent = ok ? 'Copied ✓' : 'Copy failed'; btn.classList.toggle('copied', ok);
    clearTimeout(btn._t); btn._t = setTimeout(function () { btn.textContent = lab; btn.classList.remove('copied'); }, 1600);
  };
  var fallback = function () {
    var ta = document.createElement('textarea'); ta.value = txt; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta); done(ok);
  };
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(function () { done(true); }, fallback); return; } } catch (e) { /* fall through */ }
  fallback();
}
function ioList(arr) {
  return '<ul class="io">' + arr.map(function (x) { var t = typeof x === 'string' ? x : x && (x.name || x.title || x.text) || ''; var d = x && typeof x === 'object' ? (x.note || x.why || '') : ''; return '<li>' + esc(t) + (d ? ' <small>' + esc(d) + '</small>' : '') + '</li>'; }).join('') + '</ul>';
}
/* every road in (dir 'in') or out of a box, as the reader walks it: the roads drawn on this chart and the hand-offs to other charts, together, the main path's own road first.
   (The overview's synthetic links to a stage are not roads and are left out.) */
function mainEdges() {
  if (!C.mainE) { var sp = buildSpine(C, C.chart.kind === 'overview' ? strs(C.chart.spine) : pathIdsOf(MAIN_ID)); C.mainE = sp ? sp.edges : new Set(); }
  return C.mainE;
}
function handoffRow(p, dir) {
  var tc = CH[p.chart], tn = tc.nodes[p.node2];
  return '<button type="button" class="route ' + dir + ' hand' + (p.main ? ' main' : '') + '" data-jump="' + esc(p._id) + '" title="' + esc((p.why ? p.why + ' ' : '') + 'Opens ' + tc.navLabel + (tn ? ', ' + tn.title : '') + '.') + '"><span class="r-label">' + (p.main ? '<i class="r-main">main path</i>' : '') + esc(p.label || (tn ? tn.title : tc.navLabel)) + '</span><span class="r-node">' + (dir === 'in' ? 'from ' : 'to ') + esc(tn ? tn.title : tc.navLabel) +
    '<span class="r-type"> · in ' + esc(tc.navLabel) + '</span></span><span class="r-go" aria-hidden="true">&nearr;</span></button>';
}
function flowRows(nid, dir) {
  var list = [], ids = (dir === 'in' ? C.inn : C.out)[nid] || [], me = mainEdges(), pn = C.pnode && C.pnode[nid];
  ids.forEach(function (eid) { var e = C.chart.edges[eid]; list.push({ main: me.has(eid), rank: TYPE_RANK[e.type] || 0, here: 1, i: list.length, html: routeBtn(eid, dir, me.has(eid)) }); });
  if (pn) pn[dir].forEach(function (p) { if (!p.syn) list.push({ main: !!p.main, rank: p.kind === 'return' ? 3 : 0, here: 0, i: list.length, html: handoffRow(p, dir) }); });
  list.sort(function (x, y) { return (y.main ? 1 : 0) - (x.main ? 1 : 0) || x.rank - y.rank || y.here - x.here || x.i - y.i; });
  return list;
}
function flowSection(nid, dir, title, none) {
  var rows = flowRows(nid, dir), cap = 4;
  if (!rows.length) return '<h3 class="p-' + dir + '">' + title + '</h3><p class="quiet">' + none + '</p>';
  var h = '<h3 class="p-' + dir + '">' + title + ' <span class="cnt">' + rows.length + '</span></h3><div class="routes">' + rows.slice(0, cap).map(function (r) { return r.html; }).join('') + '</div>';
  if (rows.length > cap) h += '<details class="rg-more"><summary>Show ' + (rows.length - cap) + ' more</summary><div class="routes">' + rows.slice(cap).map(function (r) { return r.html; }).join('') + '</div></details>';
  return h;
}
/* the first source anchor is always on screen (a link when the atlas has a source base); the others fold away */
function sourceBlock(refs) {
  refs = refs || []; if (!refs.length) return '';
  var r = refs[0], loc = pathHTML(r.path) + (r.line ? ':' + r.line : ''), href = srcHref(r), pin = META.pin || (META.source && META.source.pin) || '';
  var h = '<h3>Source</h3><div class="srcq ref">' + (fnOf(r) ? '<b class="ref-fn">' + esc(fnOf(r)) + '</b>' : '') + (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + loc + '</a>' : '<span class="ref-loc">' + loc + '</span>') + '</div>';
  if (refs.length > 1) h += refsHTML(refs.slice(1), false, true);
  else if (pin) h += '<p class="quiet" style="margin-top:4px;font-size:.85rem">Pinned source: ' + esc(pin) + '.</p>';
  return h;
}
function tickText(s) { return typeof gdTicked === 'function' ? gdTicked(s, esc) : esc(s); }          // a box's own words keep their `ticks` as code (guides.js)
function noRoadOutText(n) {
  var s = n && n.shape;
  if (s === 'card') return 'This is a call into another function, so nothing is drawn leaving it on this chart. ' + (n.target ? 'Open its chart from the road above, or with the Reader button.' : 'It has no drawn chart: the Reader shows its outline.');
  if (s === 'open') return 'The function carries on here, but the tool could not follow these calls, so nothing is drawn past them. This is not an ending.';
  if (s === 'more') return 'These are calls into other functions, gathered into one card. Open the Reader to see each of them.';
  if (s === 'link') return 'The function continues in another part of its chart; the road above opens it.';
  return 'Nothing leaves here on any chart: this is where the flow ends.';
}
function toolNodeBlock(n) {
  if (!META.toolMap || !n) return '';
  var h = '';
  if (n.nc && n.nc.length) h += '<div class="callout nc-note"><b>Not confident.</b> ' + n.nc.map(function (t) { return '<span class="nc-why">' + esc(t) + '</span>'; }).join(' ') + '</div>';
  var f = n.target || n.fn;
  if (f) h += '<p class="reader-row"><button type="button" class="act ghost sm" data-reader-fn="' + esc(f) + '">' + (n.target ? 'Open the called function in the Reader' : 'Open this function in the Reader') + '</button></p>';
  return h;
}
function nodeInspector(id) {
  var n = C.chart.nodes[id];
  var arrived = S.landing && S.landing.chart === C.id && S.landing.node === id && S.jumps.length;
  var ov = C.chart.kind === 'overview' && n.synth === 'stage' && stageNo(n.stage);
  var h = (arrived ? backCard() : '') + (ov ? '<div class="eb-row"><p class="eyebrow">Stage ' + ov + ' of ' + STAGE_LIST.length + '</p></div>' : stepEyebrow(id)) + '<h2>' + esc(n.title) + '</h2>' +
    '<div class="badges">' + (ov ? '' : badgeCat(kindOf(n))) + (n.ending ? '<span class="badge alt">' + (n.ending === 'back' ? 'Hands back' : 'Stops here') + '</span>' : '') + statusBadge(n) + (n.outcome ? '<span class="badge alt">Outcome: ' + esc(outcomeName(n.outcome)) + '</span>' : '') + '</div>' + (C.chart.kind === 'overview' ? overviewOpenBlock(id) : '') + traceNote();
  var group = n.synth === 'outcome' && C.chart.kind === 'overview' && typeof outcomeGroupHTML === 'function', plain = group ? outcomeGroupLead(n) : n.plain || n.summary;
  h += '<h3>What it does</h3><p class="lead">' + tickText(plain) + '</p>';
  if (!group && n.plain && n.summary && n.summary !== n.plain) h += '<p>' + tickText(n.summary) + '</p>';
  h += group ? outcomeGroupHTML(n) : endNote(n) + toolNodeBlock(n);
  if (C.chart.kind === 'overview' && C.chart.notDrawn) return h + overviewRoads(id) + oldLinksBlock(n, id) + sourceBlock(n.refs) + '<h3 class="rest-h">Actions</h3><div class="bidrow">' + bidRow(id) + '</div>' + actionsHTML({ t: 'node' });
  h += flowSection(id, 'out', 'Where it goes next', noRoadOutText(n));
  h += flowSection(id, 'in', 'Where it came from', 'Nothing arrives here on any chart: this is a starting point.');
  h += sourceBlock(n.refs);
  h += '<h3 class="rest-h">Actions</h3><div class="bidrow">' + bidRow(id) + '</div>' + actionsHTML({ t: 'node' }) + handleBlock(n) + regionChipsFor(id);
  if (n.why) h += '<h3>Why this step exists</h3><p>' + esc(n.why) + '</p>';
  if (Array.isArray(n.inputs) && n.inputs.length) h += '<h3>Takes in</h3>' + ioList(n.inputs);
  if (Array.isArray(n.outputs) && n.outputs.length) h += '<h3>Hands on</h3>' + ioList(n.outputs);
  if (n.failure) h += '<h3>If it goes wrong</h3><div class="callout fail">' + esc(n.failure) + '</div>';
  if (n.tech) h += '<h3>Engineering name</h3><p class="quiet">' + esc(n.tech) + '</p>';
  return h + oldLinksBlock(n, id);
}
function bidRow(id) {
  return '<code class="bid" title="The stable id an agent uses for this box">' + esc(id) + '</code><button type="button" class="act ghost sm" data-act="copy-pointer" title="Copies: ' + esc(pointerText(id)) + '">Copy pointer</button><button type="button" class="act ghost sm" data-act="copy-link" title="Copies a link to this box">Copy link</button>';
}
function edgeInspector(id) {
  var e = C.chart.edges[id], short = eText(e);
  var h = '<p class="eyebrow">Road</p><h2>' + esc(nodeName(e.from)) + ' → ' + esc(nodeName(e.to)) + '</h2><div class="badges">' + typeBadge(e.type || 'forward') + (e.inferred ? '<span class="badge alt" title="No code path proves this road">Inferred</span>' : '') + '</div>' + actionsHTML({ t: 'edge' }) + traceNote();
  h += '<div class="cond"><div class="eyebrow">Road label</div><p><b>' + esc(short) + '</b></p>' + (e.label && e.short && e.label !== e.short ? '<div class="eyebrow" style="margin-top:8px">Exact original condition</div><p class="quiet">' + esc(e.label) + '</p>' : '') + '</div>';
  if (e.why) h += '<h3>Why this road exists</h3><p class="lead">' + esc(e.why) + '</p>';
  if (e.inferred) h += '<div class="callout' + (e.nc ? ' nc-note' : '') + '">' + (META.toolMap ? (e.nc ? '<b>Not confident.</b> ' + esc(e.nc.join(' ')) : 'Lower trust: ' + esc(e.why || 'no code path proves this road.')) : 'Lower trust: no code path proves this road. It is read from events, queues or configuration.') + '</div>';
  h += '<h3>Trace either end</h3><div class="pair"><button type="button" class="node-btn" data-node="' + esc(e.from) + '"><small>Comes from</small>← ' + esc(nodeName(e.from)) + '</button><div class="arrowdown" aria-hidden="true">↓</div><button type="button" class="node-btn" data-node="' + esc(e.to) + '"><small>Goes to</small>→ ' + esc(nodeName(e.to)) + '</button></div>';
  return h + refsHTML(e.refs, (e.refs || []).length <= 3);
}
function chipsFor(ids) { return '<div class="chips">' + ids.map(function (id) { return '<button type="button" data-node="' + esc(id) + '">' + esc(nodeName(id)) + '</button>'; }).join('') + '</div>'; }
function draftNote() {
  var nd = notDrawnInfo();
  if (META.draft === false || (nd.count == null && typeof META.draft !== 'boolean')) return '';
  if (!nd.count) return '<div class="callout draft-note"><b>Draft map.</b> Nothing is waiting to be drawn. It is still marked draft because it has not passed the finish check. <button type="button" class="act" data-act="draft-open">See the status</button></div>';
  return '<div class="callout draft-note"><b>Draft map.</b> ' + nd.count + ' item' + (nd.count === 1 ? ' is' : 's are') + ' not drawn yet. <button type="button" class="act" data-act="draft-open">Show what is missing</button></div>';
}
/* the how-to: shown in full on the first visit, then one line (a per-viewer convenience; the page works without storage). It stays full on the chart where it was first shown. */
function howToFull() {
  if (S.howtoChart === C.id) return true;
  var seen = store.get(KEY.howto, '') === '1';
  if (seen) return false;
  S.howtoChart = C.id; store.set(KEY.howto, '1'); return true;
}
/* a chart with no route between its boxes: say so plainly, with each box's road count (the roads it has go to other charts) */
function noRoadBlock() {
  var c = C.chart, ids = Object.keys(c.nodes);
  if (ids.length < 1 || Object.keys(c.edges).length || c.kind === 'overview' || c.kind === 'whole' || c.unplaced) return '';
  var row = function (id) {
    var pn = C.pnode && C.pnode[id], i = pn ? realPortals(pn['in']).length : 0, o = pn ? realPortals(pn.out).length : 0;
    return '<li><button type="button" data-node="' + esc(id) + '">' + esc(nodeName(id)) + '</button> <span class="quiet">' + (i + o ? (i ? i + ' in' : '') + (i && o ? ', ' : '') + (o ? o + ' out' : '') + ' on other charts' : 'no road on any chart') + '</span></li>';
  };
  return '<div class="callout no-road">' + (ids.length === 1 ? '<b>This step has no road to another step here.</b> It joins the rest through other charts.' : '<b>These steps have no road between them here.</b> Each joins the rest through other charts.') + '</div><ul class="hint-list no-road-list">' + ids.map(row).join('') + '</ul>';
}
/* A name that holds a word the glossary defines (a stage title, a part name, a stage box on the glance chart) shows that word's meaning in one line.  A term with a dot or a slash (Queue.claim, a/b) matches whole:
   a plain word matches in any case, a code-like name (capitals, digits, underscore, dot, slash) in its own case, and a neighbouring letter, digit or underscore makes it a different word (gdHas). */
var TERM_LIST = null;
function termList() {
  if (TERM_LIST) return TERM_LIST; TERM_LIST = [];
  Object.keys(LAY).forEach(function (t) { var i = LAY[t]; if (!i || !String(i.meaning || '').trim()) return; var keys = [t].concat(aliasesOf(t)); if (i.name && String(i.name).toLowerCase() !== t.toLowerCase()) keys.push(String(i.name)); TERM_LIST.push({ tag: t, keys: keys.filter(function (k) { return String(k).trim().length >= 2; }), meaning: i.meaning }); });
  return TERM_LIST;
}
function termsIn(text) {
  text = String(text || ''); if (!text || typeof gdHas !== 'function') return [];
  var low = text.toLowerCase(), out = [];
  termList().forEach(function (t) { if (t.keys.some(function (k) { return gdHas(text, low, k); })) out.push(t); });
  return out.sort(function (a, b) { return b.tag.length - a.tag.length; }).slice(0, 3);
}
function termsBlock(text, label) {
  var ts = termsIn(text); if (!ts.length) return '';
  return '<h3>' + esc(label || 'Words in this name') + '</h3><ul class="term-lines">' + ts.map(function (t) { return '<li><button type="button" class="hlink" data-term-open="' + esc(t.tag) + '">' + esc(t.tag) + '</button> <span>' + esc(trunc(sentencesOf(t.meaning)[0] || t.meaning, 140)) + '</span></li>'; }).join('') + '</ul>';
}
function emptyInspector() {
  var c = C.chart, sp = strs(c.spine).filter(function (id) { return c.nodes[id]; }), nE = Object.keys(c.edges).length;
  var first = function (list, at) { var out = at ? [at] : []; list.forEach(function (id) { if (out.indexOf(id) < 0) out.push(id); }); return out.slice(0, 8); };
  var starts = c.kind === 'overview' ? (sp.length ? [sp[0]] : entryNodes().slice(0, 8)) : first(entryNodes(), sp[0]);
  var ends = c.kind === 'overview' ? (sp.length ? [sp[sp.length - 1]] : endNodes().slice(0, 8)) : endNodes().slice(0, 8);
  var stat = c.kind === 'overview' ? '<span><b>' + STAGE_LIST.length + '</b> stages</span><span><b>' + Math.max(0, C.nodeCount - STAGE_LIST.length) + '</b> ending groups</span><span><b>' + nE + '</b> stage-to-stage roads drawn</span>' : '<span><b>' + C.nodeCount + '</b>' + wBox(C.nodeCount) + '</span><span><b>' + nE + '</b>' + wRoad(nE) + '</span>';
  var howFull = howToFull(), noRoad = noRoadBlock();
  return '<p class="eyebrow">This chart</p><h2>' + esc(c.title) + '</h2><div class="stat">' + stat + '</div><p class="lead">' + esc(c.summary) + '</p>' +
    (c.note && c.stage ? '<p class="quiet part-of">Part of the stage ' + (stageNo(c.stage) ? stageNo(c.stage) + ' · ' : '') + esc(stageName(c.stage)) + '</p>' : '') + (c.kind === 'stage' ? termsBlock((c.stage ? stageName(c.stage) + ' ' : '') + (c.name || '') + ' ' + c.title) : '') + noRoad +
    (c.kind === 'overview' ? overviewSummaryBlock() : '') + draftNote() + flowInspector() + regionHint() +
    (strs(c.codes).length ? '<h3>Official handles in this chart</h3><div class="hb-also">' + strs(c.codes).map(function (t) { return hchipBtn(t); }).join('') + '</div><p class="quiet" style="margin-top:6px">Click a handle to see every step that carries it.</p>' : '') +
    (howFull ? '<h3>How to follow it</h3>' : '<details class="howto-one"><summary>How to follow it: hover to preview, click to pin, <kbd>/</kbd> searches</summary>') + '<ul class="hint-list"><li>Hover a box or an arrow to light up its roads; click to pin it. <span class="k-in">Cool roads arrive</span>, <span class="k-out">warm roads leave</span>.</li><li>With a box pinned, press <kbd>→</kbd> or <kbd>←</kbd> to walk along its roads.</li><li><b>Trace everything downstream</b> lights up every step that can follow on this chart.</li><li>Double-click a box to zoom to it. <kbd>/</kbd> searches.</li><li><b>Copy pointer</b> on a box gives an agent the exact spot.</li></ul>' + (howFull ? '' : '</details>') +
    (c.kind === 'overview' ? mainEndsBlock() : (Object.keys(c.nodes).length === 1 ? '<h3>The one box on this chart</h3>' + chipsFor(starts.length ? starts : Object.keys(c.nodes)) + '<p class="quiet" style="margin-top:6px">It starts and ends here: this part has no road between boxes. Its roads to and from other charts are in the strip above the chart.</p>' : '<h3>' + (sp.length ? 'Where it starts · the main path enters first' : 'Where it starts') + '</h3>' + chipsFor(starts) + (ends.length ? '<h3>Where it ends</h3>' + chipsFor(ends) : '')));
}
function mainEndsBlock() {                         // the overview: the main path's FIRST box and its LAST box, by name, each opening where it is drawn
  var ids = pathIdsOf(MAIN_ID).filter(function (id) { return boxAny(id); });
  if (!ids.length) return '';
  var one = function (id, role) {
    var n = boxAny(id), cid = chartForNode(id), st = n.stage && STAGE_TITLE[n.stage] ? STAGE_TITLE[n.stage] : '', isEnd = kindOf(n) === 'end';
    return '<h3>' + role + '</h3><div class="chips"><button type="button" data-open-chart="' + esc(cid || '') + '" data-open-node="' + esc(id) + '">' + esc(n.title) + '</button></div><p class="quiet" style="margin:4px 0 0">' +
      (isEnd ? 'An ending' + (n.outcome ? ' (' + esc(n.outcome) + ')' : '') + (n.ending === 'back' ? ' that hands back' : ' that stops here') : 'A ' + esc(kindInfo(kindOf(n)).label.toLowerCase())) + (st ? ' in ' + esc(st) : '') + (cid && CH[cid] ? ', drawn on ' + esc(CH[cid].navLabel) : '') + '.</p>';
  };
  return one(ids[0], 'Where the main path starts') + one(ids[ids.length - 1], 'Where the main path ends');
}
function pickInspector() {
  return '<p class="eyebrow">Trace a path</p><h2>Choose the second step</h2><p class="lead">Starting from <b>' + esc(nodeName(S.pickFrom)) + '</b>. Click any other box on the chart, or type its name in the search box and press Enter, and a road between the two lights up. If both lie on one declared path the answer follows it; otherwise it is a road the roads allow.</p><div class="actions"><button type="button" class="act" data-act="cancel">Cancel</button></div>';
}
var lastInspKey = '';
function renderInspector(resetScroll) {
  delete insp.dataset.prev;
  if (!C) { insp.innerHTML = ''; return; }
  var key = S.pickFrom ? 'pick' : S.sel ? S.sel.t + ':' + S.sel.id : S.regSel.length ? 'rg:' + S.regSel.join(',') : 'empty:' + C.id, h;
  if (S.pickFrom) h = pickInspector(); else if (!S.sel) h = S.regSel.length ? regionInspector() : emptyInspector(); else if (S.sel.t === 'node') h = nodeInspector(S.sel.id); else h = edgeInspector(S.sel.id);
  var keep = insp.scrollTop;
  insp.innerHTML = h;
  insp.scrollTop = (resetScroll || key !== lastInspKey) ? 0 : keep;
  lastInspKey = key;
  if (insp._hov && !insp._hov.isConnected) { insp._hov = null; setHover(null); }
  if (insp._rhov && !insp._rhov.isConnected) { insp._rhov = null; setHover(null); }
}
insp.addEventListener('click', function (e) {
  var b = e.target.closest('button,a'); if (!b || !C) return;
  if (b.dataset.handle) { showHandle(b.dataset.handle); return; }
  if (b.dataset.termOpen) { var tp = new URLSearchParams(); tp.set('term', b.dataset.termOpen); openReading('glossary', { push: true, params: tp }); return; }
  if (b.dataset.jump) { jumpTo(findPortal(b.dataset.jump)); return; }
  if (b.dataset.pscroll) { var tg = $('h3.p-' + b.dataset.pscroll, insp); if (tg) insp.scrollTo({ top: tg.getBoundingClientRect().top - insp.getBoundingClientRect().top + insp.scrollTop - 8, behavior: reduced ? 'auto' : 'smooth' }); return; }
  if (b.dataset.rgPin) { toggleRegion(b.dataset.rgPin, !!b.dataset.rgAdd || e.shiftKey || e.ctrlKey || e.metaKey, { reveal: true }); return; }
  if (b.dataset.rgHalo) { toggleHalo(b.dataset.rgHalo); return; }
  if (b.dataset.rgWalk) { startWalk(b.dataset.rgWalk); return; }
  if (b.dataset.pnode) { selectNode(b.dataset.pnode, { reveal: 'zoom' }); return; }
  if (b.dataset.act) {
    var a = b.dataset.act;
    if (a === 'down' || a === 'up') traceDir(a); else if (a === 'path') { if (S.pickFrom) cancelPick(); else startPick(); } else if (a === 'clear') clearAll(); else if (a === 'cancel') cancelPick();
    else if (a === 'path-plain') { togglePlainPath(); }
    else if (a === 'trace-whole') { traceOnWhole(b.dataset.dir); }
    else if (a === 'copy-pointer') { if (S.sel && S.sel.t === 'node') copyText(pointerText(S.sel.id), b); }
    else if (a === 'copy-link') copyText(location.href.split('#')[0] + currentHash(), b);
    else if (a === 'draft-open') openDraftPanel();
    else if (a === 'back') goBack(); else if (a === 'rg-zoom') zoomToRegions(S.regSel, true); else if (a === 'rg-clear') clearRegions(); else if (a === 'rg-open') openRegionPanel(true);
    return;
  }
  if (b.dataset.edge) { selectEdge(b.dataset.edge, { reveal: true }); return; }
  if (b.dataset.chart && b.classList.contains('xbtn')) { pushJump(); openChart(b.dataset.chart, b.dataset.chartNode || null, { push: true, center: true }); return; }      // a box named in a list the panel shows (the overview's groups): open it where it is drawn
  if (b.dataset.node) { selectNode(b.dataset.node, { reveal: 'zoom' }); return; }
  if (b.dataset.ovOpen) { pushJump(); openChart(b.dataset.ovOpen, null, { push: true }); return; }
  if (b.dataset.ovStage) { openToolStage(b.dataset.ovStage); return; }
  if (b.dataset.openChart) openChart(b.dataset.openChart, b.dataset.openNode || null, { push: true });
});
/* hovering a route button in the inspector previews that route on the chart (same focus treatment, no tooltip) */
insp.addEventListener('mouseover', function (e) { if (PT.lock) return; var b = e.target.closest('[data-edge]'); if (b && C && b !== insp._hov) { insp._hov = b; setHover({ t: 'edge', id: b.dataset.edge }, true); } });
insp.addEventListener('mouseout', function (e) { var b = e.target.closest('[data-edge]'); if (b && insp._hov === b && !b.contains(e.relatedTarget)) { insp._hov = null; setHover(null); } });
/* hovering a region chip in the inspector previews that region */
insp.addEventListener('mouseover', function (e) { if (PT.lock) return; var b = e.target.closest('[data-rg-pin]'); if (b && C && C.rg && b !== insp._rhov) { insp._rhov = b; setHover({ t: 'region', id: b.dataset.rgPin }, true); } });
insp.addEventListener('mouseout', function (e) { var b = e.target.closest('[data-rg-pin]'); if (b && insp._rhov === b && !b.contains(e.relatedTarget)) { insp._rhov = null; setHover(null); } });

/* ================================================================ search */
var IDX = null;
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function buildIndex() {
  IDX = [];
  var seenN = {}, rk = { stage: 0, detail: 1, whole: 2, overview: 3 };               // a box is found where it is drawn in detail, not on the whole map that repeats it
  ORDER.map(function (cid, i) { return { cid: cid, i: i, r: rk[CH[cid].kind] == null ? 1.5 : rk[CH[cid].kind] }; }).sort(function (a, b) { return a.r - b.r || a.i - b.i; }).map(function (x) { return x.cid; }).forEach(function (cid) {
    var c = CH[cid];
    Object.keys(c.nodes).forEach(function (nid) {
      if (c.kind !== 'overview' && seenN[nid]) return; seenN[nid] = 1;
      var n = c.nodes[nid], codes = strs([hOf(n)].concat(strs(n.layers))), hx = '', akas = [];
      codes.forEach(function (t) { var i = LAY[t]; hx += ' ' + t + (i ? ' ' + (i.name || '') + ' ' + (i.meaning || '') : ''); aliasesOf(t).forEach(function (a) { akas.push(a); hx += ' ' + a; }); });
      var fns = (n.refs || []).map(fnOf).filter(Boolean), ids = [nid].concat(fns);                  // a box id or a function name typed whole finds its box first
      IDX.push({
        chart: cid, node: nid, title: n.title, plain: n.plain || n.summary || '', tech: n.tech || '', tag: hOf(n), codes: codes.concat(akas, ids).map(norm),
        t: norm(n.title), hay: norm(n.title + ' ' + nid + ' ' + (n.plain || n.summary || '') + ' ' + (n.tech || '') + ' ' + fns.join(' ') + hx)
      });
    });
  });
}
// a token matches inside any word of 3+ letters, or at the start of a word when it is 1-2 letters (so "a" or "id" do not match mid-word noise)
function hasTok(hay, tok) { return tok.length <= 2 ? (' ' + hay).indexOf(' ' + tok) >= 0 : hay.indexOf(tok) >= 0; }
function matchQuery(q) {
  if (!IDX) buildIndex();
  var toks = norm(q).split(' ').filter(Boolean), nq = norm(q);
  if (!toks.length) return [];
  var res = [];
  IDX.forEach(function (r) {
    for (var i = 0; i < toks.length; i++) if (!hasTok(r.hay, toks[i])) return;
    r = Object.assign({}, r);
    r.score = r.codes.indexOf(nq) >= 0 ? -1 : r.t.indexOf(nq) >= 0 ? 0 : toks.every(function (t) { return r.t.indexOf(t) >= 0; }) ? 1 : 2;
    res.push(r);
  });
  return res.sort(function (a, b) { return a.score - b.score; });
}
// handles whose name or meaning matches the query (a name typed whole, a part of its meaning, an alias)
function matchHandles(q) {
  var nq = norm(q), H = handles(); if (!nq) return [];
  var toks = nq.split(' ').filter(Boolean), out = [];
  Object.keys(H).forEach(function (t) {
    var nt = norm(t), nm = norm(handleName(t)), inf = LAY[t], s = null, akas = aliasesOf(t).map(norm);
    if (nt === nq) s = 0; else if (nt.indexOf(nq) === 0 && nq.length >= 2) s = 1;
    else if (akas.indexOf(nq) >= 0) s = 1;                                    // the old name typed whole finds the real one
    else if (nm && toks.every(function (k) { return hasTok(nm, k); })) s = 2;
    else if (akas.some(function (a) { return a.indexOf(nq) === 0 && nq.length >= 2; })) s = 2;
    else if (inf && inf.meaning && toks.length > 1 && toks.every(function (k) { return hasTok(norm(inf.meaning), k); })) s = 3;
    if (s != null) out.push({ tag: t, h: H[t], s: s });
  });
  return out.sort(function (a, b) { return a.s - b.s || b.h.count - a.h.count; }).slice(0, 4);
}
function applyChartSearch(quiet) {
  if (!C) return;
  C.qMarked.forEach(function (el) { el.classList.remove('q-match', 'q-cur'); }); C.qMarked = [];
  var q = qInput.value.trim();
  if (S.qAll || !q) { C.svg.classList.remove('searching'); S.matches = []; S.matchIdx = -1; if (!S.qAll) qCount.textContent = ''; return; }
  var m = matchQuery(q).filter(function (r) { return !!C.chart.nodes[r.node] && (r.chart === C.id || !!C.chart.nodes[r.node]); });
  m.sort(function (a, b) { return a.score - b.score || ((C.nb[a.node] || {}).x || 0) - ((C.nb[b.node] || {}).x || 0); });
  S.matches = m.map(function (r) { return r.node; }); S.matchIdx = -1;
  C.svg.classList.toggle('searching', S.matches.length > 0);                         // nothing matches here: nothing is dimmed (a whole chart gone near-black says nothing)
  S.matches.forEach(function (id) { var el = C.nodeEl.get(id); if (el) { el.classList.add('q-match'); C.qMarked.push(el); } });
  if (S.matches.length) qCount.textContent = S.matches.length + ' found';
  else { var elsewhere = matchQuery(q).length; if (elsewhere) qCount.innerHTML = '<button type="button" class="qmore" data-qall="1" title="Search every chart instead of just this one">' + elsewhere + ' in other charts</button>'; else qCount.textContent = 'No match'; }
}
qCount.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('[data-qall]')) qAllBtn.click(); });
function jumpMatch(delta) {
  if (!S.matches.length) {
    var q0 = qInput.value.trim(), el0 = q0 ? matchQuery(q0) : [];
    if (S.pickFrom && el0.length) { var r0 = el0.filter(function (r) { return r.node !== S.pickFrom; })[0]; if (r0) { traceBetween(S.pickFrom, r0.node); return; } }      // tracing: the box is on another chart: the answer opens on the whole map
    announce(q0 ? (el0.length ? 'No match on this chart: ' + el0.length + ' on other charts. Use All charts.' : 'No match.') : 'Type a name first.'); return;
  }
  if (S.matchIdx >= 0) { var o = C.nodeEl.get(S.matches[S.matchIdx]); if (o) o.classList.remove('q-cur'); }
  S.matchIdx = (S.matchIdx + delta + S.matches.length) % S.matches.length;
  if (S.pickFrom && S.matches[S.matchIdx] === S.pickFrom && S.matches.length > 1) S.matchIdx = (S.matchIdx + delta + S.matches.length) % S.matches.length;
  var id = S.matches[S.matchIdx], el = C.nodeEl.get(id);
  if (S.pickFrom) { qCount.textContent = (S.matchIdx + 1) + ' of ' + S.matches.length; if (id !== S.pickFrom) { completePick(id); if (el) el.classList.add('q-cur'); } else announce('Pick a different step.'); return; }      // tracing a path: the search chooses the second box
  selectNode(id, { reveal: 'zoom' });
  if (el) el.classList.add('q-cur');
  qCount.textContent = (S.matchIdx + 1) + ' of ' + S.matches.length;
}
var resIdx = -1, resList = [];
function showAllResults() {
  var q = qInput.value.trim();
  if (!q) { closeResults(); qCount.textContent = ''; return; }
  var all = matchQuery(q), hrows = matchHandles(q).map(function (x) { return { kind: 'handle', tag: x.tag, h: x.h }; });
  resList = hrows.concat(all.slice(0, 60)); resIdx = resList.length ? 0 : -1;
  var tot = all.length;
  qResults.hidden = false; qInput.setAttribute('aria-expanded', 'true');
  qResults.innerHTML = resList.length ? resList.map(function (r, i) {
    if (r.kind === 'handle') {
      var inf = LAY[r.tag];
      return '<button type="button" class="qres qres-h" role="option" id="qr' + i + '" aria-selected="' + (i === 0) + '" data-i="' + i + '"><b>' + hchip(r.tag) + ' ' + esc(handleName(r.tag) || 'Official handle') + '</b><small><span class="qwhere">Where it engages</span> · ' + r.h.count + ' step' + (r.h.count === 1 ? '' : 's') + ' in ' + Object.keys(r.h.charts).length + ' chart' + (Object.keys(r.h.charts).length === 1 ? '' : 's') + (inf && inf.meaning ? ' · ' + esc(trunc(inf.meaning, 90)) : '') + '</small></button>';
    }
    return '<button type="button" class="qres" role="option" id="qr' + i + '" aria-selected="' + (i === 0) + '" data-i="' + i + '"><b>' + (r.tag ? hchip(r.tag) + ' ' : '') + esc(r.title) + '</b><small><span class="qwhere">' + esc(CH[r.chart].navLabel) + '</span> · ' + esc(trunc(r.plain, 110)) + '</small></button>';
  }).join('') : '<div class="qempty">No step matches “' + esc(q) + '” in any chart.</div>';
  qCount.textContent = tot || hrows.length ? (tot + hrows.length) + ' found' : 'No match';
}
function closeResults() { qResults.hidden = true; resIdx = -1; resList = []; qInput.setAttribute('aria-expanded', 'false'); }
function moveRes(d) {
  if (!resList.length) return; resIdx = (resIdx + d + resList.length) % resList.length;
  $$('.qres', qResults).forEach(function (b, i) { b.setAttribute('aria-selected', i === resIdx ? 'true' : 'false'); if (i === resIdx) b.scrollIntoView({ block: 'nearest' }); });
}
function openResult(i) {
  var r = resList[i]; if (!r) return; closeResults();
  if (r.kind === 'handle') { showHandle(r.tag); return; }
  if (S.pickFrom && r.node && r.node !== S.pickFrom) {                       // tracing a path: the result is the second box; if it is on another chart, trace on the whole map, which holds both
    var a0 = S.pickFrom;
    if (!(C && C.chart.nodes[r.node])) { var wid = Object.keys(CH).filter(function (id) { return isWhole(CH[id]) && CH[id].nodes[r.node] && CH[id].nodes[a0]; })[0]; if (!wid) { announce('That step is on another chart and no chart holds both.'); return; } openChart(wid, a0, { push: true }); announce('Tracing on the whole map, which holds both steps.'); }
    S.pickFrom = a0; canvas.classList.add('picking'); completePick(r.node); return;
  }
  openChart(r.chart, r.node, { push: true, center: true });
}
qInput.addEventListener('input', function () { if (S.qAll) showAllResults(); else applyChartSearch(); });
function fitSearchPad() { qInput.style.paddingRight = (qCount.textContent ? Math.ceil(qCount.getBoundingClientRect().width) + 34 : 30) + 'px'; }      // the typed text stops before the count and the browser's clear button
if (window.MutationObserver) new MutationObserver(fitSearchPad).observe(qCount, { childList: true, characterData: true, subtree: true });
qInput.addEventListener('focus', function () { if (S.qAll && qInput.value.trim()) showAllResults(); });
qInput.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    if (!qResults.hidden) { closeResults(); return; }
    if (qInput.value) { qInput.value = ''; applyChartSearch(); qCount.textContent = ''; } else { qInput.blur(); canvas.focus({ preventScroll: true }); if (C && (S.sel || S.trace)) clearAll(); }
    return;
  }
  if (S.qAll) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (qResults.hidden) showAllResults(); else moveRes(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveRes(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (resIdx >= 0) openResult(resIdx); else showAllResults(); }
  } else if (e.key === 'Enter') { e.preventDefault(); jumpMatch(e.shiftKey ? -1 : 1); }
});
qResults.addEventListener('mousedown', function (e) { e.preventDefault(); });
qResults.addEventListener('click', function (e) { var b = e.target.closest('.qres'); if (b) openResult(+b.dataset.i); });
document.addEventListener('mousedown', function (e) { if (!qResults.hidden && !e.target.closest('#searchBox')) closeResults(); });
qAllBtn.addEventListener('click', function () {
  S.qAll = !S.qAll; qAllBtn.setAttribute('aria-pressed', S.qAll ? 'true' : 'false');
  qInput.placeholder = S.qAll ? 'Find anywhere' : 'Find a step   ( / )';
  qInput.setAttribute('aria-label', S.qAll ? 'Search steps in every chart' : 'Search steps in this chart');
  closeResults(); qCount.textContent = '';
  if (S.qAll) { if (C) { C.qMarked.forEach(function (el) { el.classList.remove('q-match', 'q-cur'); }); C.qMarked = []; C.svg.classList.remove('searching'); } if (qInput.value.trim()) showAllResults(); } else applyChartSearch();
  qInput.focus();
});

/* ================================================================ handles panel + "where does it engage?" */
var hpanel = $('#handlePanel'), handlesBtn = $('#handlesBtn');
function setHandlesBtn() { handlesBtn.setAttribute('aria-expanded', S.hpanel ? 'true' : 'false'); handlesBtn.setAttribute('aria-pressed', S.hpanel ? 'true' : 'false'); }
function refitForPanel() { if (C && !S.reading) { if (S.autoFit) fitView(true); else reseatBar(); } }
function openHandles() {
  if (!legendEl.hidden) toggleLegend(false);
  closeDock();
  S.hpanel = S.handle ? 'engage' : 'list'; hpanel.hidden = false; setHandlesBtn(); drawHandles(); refitForPanel();
  var f = $('#hpFilter', hpanel) || $('.hp-close', hpanel); if (f && S.hpanel === 'list') f.focus();
}
function closeHandles() {
  S.hpanel = null; hpanel.hidden = true; setHandlesBtn();
  if (S.handle) { S.handle = null; applyHandleFocus(); writeHash(false); }
  refitForPanel();
}
handlesBtn.addEventListener('click', function () { if (S.hpanel) closeHandles(); else openHandles(); });
function famBadge(k) { return '<span class="fam-dot fam-' + k + '" aria-hidden="true"></span>'; }
function listRows(q) {
  var H = handles(), nq = norm(q), toks = nq.split(' ').filter(Boolean), by = {}, any = false, out = '';
  Object.keys(H).forEach(function (t) {
    var h = H[t], inf = h.info;
    if (toks.length) { var hay = norm(t + ' ' + aliasesOf(t).join(' ') + ' ' + (inf ? (inf.name || '') + ' ' + (inf.meaning || '') + ' ' + (inf.family || '') : '')); if (!toks.every(function (k) { return hasTok(hay, k); })) return; }
    (by[h.fam] = by[h.fam] || []).push(t);
  });
  FAM_ORDER.forEach(function (k) {
    var list = by[k]; if (!list || !list.length) return; any = true;
    list.sort(tagSort);
    out += '<h4 class="hp-fam">' + famBadge(k) + esc(FAMS[k].name) + '</h4>';
    list.forEach(function (t) {
      var h = H[t], inf = h.info, nm = handleName(t), aka = aliasesOf(t);
      var mean = inf && inf.meaning ? inf.meaning : (h.count ? '' : 'Named by a chart, not defined yet');
      out += '<button type="button" class="hp-row" data-handle="' + esc(t) + '"' + (aka.length ? ' title="' + esc(t + ' is also called ' + aka.join(', ')) + '"' : '') + '>' + hchip(t, 'hp-chip', true) + '<span class="hp-name">' + (nm ? '<b>' + esc(nm) + '</b>' : '') + '<small' + (nm ? '' : ' class="solo"') + '>' + (aka.length ? '<i>Also called ' + esc(aka.join(', ')) + '. </i>' : '') + esc(mean || (inf && inf.family) || (function () { var r0 = h.refs[0], bn = r0 && CH[r0.chart] && CH[r0.chart].nodes[r0.node]; return bn ? 'Named on the box “' + trunc(bn.title, 46) + '”' + (h.count > 1 ? ' and ' + (h.count - 1) + ' more' : '') : 'Official handle'; })()) + '</small></span>' +
        '<span class="hp-n' + (h.count ? '' : ' zero') + '" title="' + h.count + ' box' + (h.count === 1 ? '' : 'es') + ' tagged across all charts">' + (h.count || '–') + '</span></button>';
    });
  });
  return any ? out : '<p class="qempty">No handle matches “' + esc(q) + '”.</p>';
}
function engageHTML(h) {
  var inf = h.info, c = C && C.id, refs = h.refs.slice(), groups = {}, order = [];
  refs.forEach(function (r) { (groups[r.chart] = groups[r.chart] || []).push(r); });
  ORDER.forEach(function (cid) { if (groups[cid]) order.push(cid); });
  order.sort(function (a, b) { return (a === c ? -1 : 0) - (b === c ? -1 : 0); });
  var nch = order.length, mods = inf && Array.isArray(inf.modules) ? inf.modules.map(function (m) { return typeof m === 'string' ? m : (m && (m.path || m.name || m.module)) || ''; }).filter(Boolean) : [];
  var off = inf && typeof inf.official === 'string' ? inf.official : '';
  var s = '<div class="hp-top"><button type="button" class="act ghost" data-hp="list">← All handles</button><button type="button" class="lg-close hp-close" data-hp="close">Close</button></div>' +
    '<h3 class="hp-h">Where ' + esc(h.tag) + ' engages</h3>' +
    '<div class="hb-main">' + hchip(h.tag, 'hb-chip') + '<div class="hb-txt"><b>' + esc(handleName(h.tag) || h.tag) + '</b>' + (inf && inf.family ? '<span class="hb-fam">' + esc(inf.family) + '</span>' : '') + '</div></div>' +
    (inf && inf.meaning ? '<p class="hb-mean">' + esc(inf.meaning) + '</p>' : '') +
    (aliasesOf(h.tag).length ? '<p class="quiet hb-aka"><b>Also called</b> ' + esc(aliasesOf(h.tag).join(', ')) + '</p>' : '') +
    (off || mods.length || (inf && inf.caveat) || (inf && inf.confidence != null && inf.confidence !== '') ? '<details class="hb-more"><summary>Official definition</summary>' + (off ? '<p>' + esc(off) + '</p>' : '') + (inf && inf.caveat ? '<p class="quiet"><b>Caveat</b> ' + esc(inf.caveat) + '</p>' : '') + (mods.length ? '<p class="quiet"><b>Source modules</b> ' + mods.map(function (m) { return '<code>' + esc(m) + '</code>'; }).join(' ') + '</p>' : '') + (inf && inf.confidence != null && inf.confidence !== '' ? '<p class="quiet"><b>Confidence</b> ' + esc(inf.confidence) + '</p>' : '') + '</details>' : '') +
    '<p class="hp-sum"><b>' + h.count + '</b> box' + (h.count === 1 ? '' : 'es') + ' in <b>' + nch + '</b> chart' + (nch === 1 ? '' : 's') + '. ' + (c && groups[c] ? 'The ' + groups[c].length + ' in this chart are lit; everything else is dimmed.' : (h.count ? 'None in this chart; pick a step below to open it.' : 'No step is tagged with it yet.')) + '</p>';
  order.forEach(function (cid) {
    var cc = CH[cid];
    s += '<div class="hp-group"><h4>' + (cid === c ? 'This chart · ' : '') + esc(cc.navLabel) + '<span class="hp-gn">' + groups[cid].length + '</span></h4>';
    groups[cid].forEach(function (r) {
      var n = cc.nodes[r.node]; if (!n) return;
      s += '<button type="button" class="hp-node" data-chart="' + esc(cid) + '" data-node="' + esc(r.node) + '"><b>' + esc(n.title) + '</b><small>' + (r.primary ? '' : 'also touches · ') + esc(trunc(n.plain || n.summary || '', 96)) + '</small></button>';
    });
    s += '</div>';
  });
  return s;
}
function drawHandles() {
  if (!S.hpanel) return;
  var h = S.hpanel === 'engage' && S.handle ? findHandle(S.handle) : null;
  if (S.hpanel === 'engage' && !h) S.hpanel = 'list';
  if (S.hpanel === 'engage') { hpanel.innerHTML = engageHTML(h); hpanel.scrollTop = 0; return; }
  var n = Object.keys(handles()).length;
  hpanel.innerHTML = '<div class="hp-top"><h3 class="hp-h">Official handles <span class="hp-cnt">' + n + '</span></h3><button type="button" class="lg-close hp-close" data-hp="close">Close</button></div>' +
    '<p class="hp-note">Every name the system itself uses, in system order. The number is how many steps carry it across all charts. Pick one to see where it engages.</p>' +
    '<input id="hpFilter" type="search" class="hp-filter" placeholder="Filter handles…" autocomplete="off" spellcheck="false" aria-label="Filter handles"><div id="hpList" class="hp-list">' + listRows('') + '</div>';
}
hpanel.addEventListener('input', function (e) { if (e.target.id === 'hpFilter') $('#hpList', hpanel).innerHTML = listRows(e.target.value); });
hpanel.addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  if (b.dataset.hp === 'close') { closeHandles(); handlesBtn.focus(); return; }
  if (b.dataset.hp === 'list') { S.handle = null; S.hpanel = 'list'; applyHandleFocus(); drawHandles(); writeHash(false); var f = $('#hpFilter', hpanel); if (f) f.focus(); return; }
  if (b.dataset.handle) { showHandle(b.dataset.handle); return; }
  if (b.dataset.node && b.dataset.chart) { openChart(b.dataset.chart, b.dataset.node, { push: true, center: true }); }
});
function applyHandleFocus() {
  if (!C) return;
  C.hMarked.forEach(function (el) { el.classList.remove('h-match'); }); C.hMarked = [];
  FAM_ORDER.forEach(function (k) { C.svg.classList.remove('hf-' + famClass(k)); });
  var hh = S.handle && findHandle(S.handle), any = false;
  if (hh) hh.refs.forEach(function (r) { if (r.chart !== C.id) return; var el = C.nodeEl.get(r.node); if (el) { el.classList.add('h-match'); C.hMarked.push(el); any = true; } });
  C.svg.classList.toggle('hfocus', any);
  if (any) C.svg.classList.add('hf-' + famClass(hh.fam));
  drawMini();
}
function showHandle(tag, o) {
  var hh = findHandle(tag); o = o || {};
  if (!hh) { announce('No official handle called ' + tag + '.'); return; }
  if (!legendEl.hidden) toggleLegend(false);
  closeDock();
  S.handle = hh.tag; S.hpanel = 'engage'; hpanel.hidden = false; setHandlesBtn();
  drawHandles(); applyHandleFocus(); refitForPanel();
  if (!o.noHash) writeHash(!!o.push);
  announce('Where ' + hh.tag + ' engages: ' + hh.count + ' step' + (hh.count === 1 ? '' : 's') + ' in ' + Object.keys(hh.charts).length + ' chart' + (Object.keys(hh.charts).length === 1 ? '' : 's') + '.');
}
function bestChartFor(hh) {           // the chart where this handle engages most (the current chart wins whenever it has any)
  if (C && hh.charts[C.id]) return C.id;
  var best = null, mon = null;
  for (var i = 0; i < ORDER.length; i++) {
    var id = ORDER[i], n = hh.charts[id]; if (!n) continue;
    if (isWhole(CH[id])) { mon = mon || id; continue; }      // the full-system chart holds every step: it never wins on count
    if (!best || n > hh.charts[best]) best = id;
  }
  return best || mon || (C ? C.id : FIRST);
}
// toolbar code chips (and any other data-handle chip outside the inspector/panel)
$('#chartCodes').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; if (b.dataset.handles) { S.handle = null; applyHandleFocus(); openHandles(); } else if (b.dataset.handle) showHandle(b.dataset.handle); });

/* ================================================================ docked panel (FL.openPanel) + the draft strip */
var dockEl = $('#dockPanel'), dockCfg = null;
function openDock(title, html, o) {
  o = o || {};
  if (!legendEl.hidden) toggleLegend(false);
  if (S.hpanel) closeHandles();
  var prev = dockCfg; dockCfg = o;
  if (prev && prev.onClose && prev !== o) { try { prev.onClose(); } catch (e) { /* ignore */ } }
  dockEl.innerHTML = '<div class="hp-top"><h3 class="hp-h">' + esc(title) + '</h3><button type="button" class="lg-close hp-close" data-dock="close">Close</button></div><div class="dock-body">' + html + '</div>';
  dockEl.classList.toggle('wide', !!o.wide); if (typeof gdTicks === 'function') gdTicks(dockEl);
  dockEl.hidden = false; dockEl.scrollTop = 0; refitForPanel();
  return $('.dock-body', dockEl);
}
function closeDock() {
  if (dockEl.hidden) return;
  dockEl.hidden = true; var cfg = dockCfg; dockCfg = null; refitForPanel();
  if (cfg && cfg.onClose) { try { cfg.onClose(); } catch (e) { /* ignore */ } }
}
dockEl.addEventListener('click', function (e) {
  if (e.target.closest('[data-dock=close]')) { closeDock(); return; }
  if (dockCfg && dockCfg.onClick) dockCfg.onClick(e);
  var b = e.target.closest('button[data-node][data-chart]'); if (b) openChart(b.dataset.chart, b.dataset.node, { push: true, center: true });
});

/* draft or finished, the census tally and what is not drawn yet: one slim strip above the map (never text over the map) */
function numOrNull(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function nice(k) { return String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase(); }
/* what each census total counts, said where the number sits: the census reads the CODE (what a plain read of it found), the map draws BOXES; the table "What the numbers count" (guides.js) says how they relate */
var CENSUS_LABEL = { endings: 'endings in the code', branches: 'branches in the code', passes: 'loops and retries in the code', switches: 'switches in the code', modules: 'source files', outcomes: 'outcome values in the code' };
function censusRows(c) {
  var rows = [], put = function (k, v, lab) {
    var t, d;
    if (typeof v === 'number') { t = v; d = null; }
    else if (v && typeof v === 'object') { t = numOrNull(v.total != null ? v.total : v.found); d = numOrNull(v.accounted != null ? v.accounted : v.drawn != null ? v.drawn : v.covered != null ? v.covered : v.done); lab = lab || v.label; }
    if (t == null) return;
    rows.push({ key: k, label: lab || CENSUS_LABEL[k] || nice(k), total: t, done: d });
  };
  if (!c || typeof c !== 'object') return rows;
  if (Array.isArray(c.rows)) c.rows.forEach(function (r) { if (r) put(r.kind || r.key || r.label, r, r.label); });
  else Object.keys(c).forEach(function (k) { if (!/^(summary|text|note|rawReturnsAndRaises)$/.test(k)) put(k, c[k]); });
  return rows;
}
function notDrawnInfo() {
  var nd = META.notDrawn, items = [], count = null, note = '';
  if (typeof nd === 'number') count = nd;
  else if (Array.isArray(nd)) { items = nd; count = nd.length; }
  else if (nd && typeof nd === 'object') {
    items = Array.isArray(nd.items) ? nd.items : Array.isArray(nd.modules) ? nd.modules : [];
    count = numOrNull(nd.count != null ? nd.count : nd.total); if (count == null) count = items.length; note = nd.summary || nd.note || '';
  }
  return { count: count, items: items, note: note };
}
function drawDraftBar() {
  var bar = $('#draftBar'); if (!bar) return;
  if (META.toolMap) { drawToolMapBar(bar); return; }
  var rows = censusRows(META.census), nd = notDrawnInfo(), known = typeof META.draft === 'boolean';
  if (!known && !rows.length && nd.count == null) { bar.hidden = true; return; }
  var draft = META.draft !== false, h = '<span class="db-state ' + (draft ? 'draft' : 'done') + '">' + (draft ? 'Draft' : 'Fully drawn') + '</span><span class="db-state db-who" title="The words on the boxes and roads were written by an agent or a person who read the code. A program checked the map and placed the boxes on the charts. The tool page says Read by a program where a program read the code and wrote the words.">Words by an agent or person, placed by a program</span>';
  var text = META.census && typeof META.census === 'object' && (META.census.summary || META.census.text) || (typeof META.census === 'string' ? META.census : '');
  if (rows.length || text) {
    h += '<span class="db-tally"><span class="db-lab">Accounted for</span> ' + (text ? esc(text) : rows.slice(0, 4).map(function (r) {
      return '<span class="db-row">' + esc(r.label) + ' <b>' + (r.done != null ? r.done + '/' + r.total : r.total) + '</b></span>';
    }).join('')) + (!text && rows.length > 4 ? '<span class="db-row">+' + (rows.length - 4) + ' more</span>' : '') + '</span>';
  }
  if (rows.length || text) h += '<span class="db-why">' + (draft ? 'Not every one has a box yet.' : 'Each has a box, or a stated reason it has none.') + ' Read from the code, not run.</span>';      // what the row means, beside the row
  if (nd.count) h += '<button type="button" class="db-nd" aria-haspopup="true">Not drawn yet <b>' + nd.count + '</b></button>';
  else if (nd.count === 0) { /* nothing left to draw is not a button: there is nothing to open */ }
  else if (rows.length) h += '<button type="button" class="db-nd" aria-haspopup="true">Details</button>';
  bar.innerHTML = h; bar.hidden = false; bar.classList.toggle('is-draft', draft);
  var tl = $('.db-tally', bar); if (tl) tl.title = 'These count what a plain read of the code found (return and raise statements it is sure are endings, decision branches, files). The map counts boxes: a different unit, so a total here is not a number of boxes. The Evidence and scope page, under What the numbers count, says how each is counted.';
  bar.title = !draft ? 'Fully drawn means every ending, branch, loop and module is accounted for by a box. It does not mean verified: nothing here is seen or proved unless a run is loaded (see Evidence and scope).' : 'A draft map: it shows what is not drawn yet. It becomes finished when every ending, branch, loop and module is accounted for.';
}
function drawToolMapBar(bar) {
  var T = META.toolMap, N = T.nums || {}, c = C && C.chart && C.chart.ncCount;
  var h = '<span class="db-state done">Read by a program</span><span class="db-tally"><span class="db-lab">Read</span> <span class="db-row"><b>' + (N.functions || 0) + '</b> functions</span><span class="db-row"><b>' + (N.boxes || 0) + '</b> boxes</span><span class="db-row"><b>' + (N.roads || 0) + '</b> roads</span></span>' +
    '<span class="db-tally"><span class="db-lab">Open</span> <span class="db-row"><b>' + (N.questions || 0) + '</b> questions</span><span class="db-row"><b>' + (N.claimsNotConfident || 0) + '</b> claims not confident</span></span>';
  if (c) h += '<span class="db-tally db-nc"><span class="db-lab">This chart</span> <span class="db-row"><b>' + c.boxes + '</b> ' + (c.boxes === 1 ? 'box' : 'boxes') + ' and <b>' + c.roads + '</b> ' + (c.roads === 1 ? 'road' : 'roads') + ' drawn dashed (not confident)</span></span>';
  h += '<button type="button" class="db-nd" aria-haspopup="true">What was read and what is open</button>';
  bar.innerHTML = h; bar.hidden = false; bar.classList.remove('is-draft'); bar.classList.add('is-toolmap');
  bar.title = (T.tagline || '') + '. Every number here comes from one record the reading wrote. Nothing here is run or verified.';
}
function toolMapPanelHTML() {
  var T = META.toolMap, list = function (a) { return '<ul class="dk-list">' + a.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>'; };
  return '<p class="hp-note">' + esc(T.tagline || '') + '. These sentences are built from one record of numbers; the page counts nothing itself.</p><h4 class="dk-h">What was read</h4>' + list(T.read) + '<h4 class="dk-h">What was not read</h4>' + list(T.notRead) + '<h4 class="dk-h">What is open</h4>' + list(T.open) +
    '<h4 class="dk-h">Not confident</h4><p class="hp-note">' + T.conf.boxes + ' boxes and ' + T.conf.roads + ' roads are drawn dashed on the charts. Open one and the Details panel says why the tool is not confident in it.</p>';
}
function draftPanelHTML() {
  var rows = censusRows(META.census), nd = notDrawnInfo(), draft = META.draft !== false, h = '';
  h += '<p class="hp-note">' + (draft ? 'This map is a <b>draft</b>. It says plainly what is not drawn yet, so a thin map is never mistaken for a finished one. It becomes finished when every ending, branch, loop and module is accounted for.' : 'This map is <b>finished</b>: every ending, branch, loop and module is accounted for.') + '</p>';
  if (rows.length) {
    h += '<h4 class="dk-h">Census</h4><p class="hp-note">What a plain read of the code found, and how much of it a box or an exclusion already covers.</p><div class="dk-meter">';
    rows.forEach(function (r) {
      var pct = r.done != null && r.total ? Math.min(100, Math.round(100 * r.done / r.total)) : null;
      h += '<div class="dk-row"><span class="dk-l">' + esc(r.label) + '</span><span class="dk-n">' + (r.done != null ? r.done + ' of ' + r.total : r.total) + '</span>' + (pct != null ? '<span class="dk-bar" role="img" aria-label="' + pct + ' percent"><i style="width:' + pct + '%"></i></span>' : '') + '</div>';
    });
    h += '</div>';
  }
  if (nd.count != null) {
    h += '<h4 class="dk-h">Not drawn yet <span class="hp-cnt">' + nd.count + '</span></h4>' + (nd.note ? '<p class="hp-note">' + esc(nd.note) + '</p>' : '');
    if (nd.items.length) {
      h += '<ul class="dk-list">' + nd.items.slice(0, 80).map(function (it) {
        if (typeof it === 'string') return '<li><code>' + esc(it) + '</code></li>';
        var nm = it.path || it.module || it.title || it.id || it.name || '', why = it.why || it.reason || it.note || '';
        return '<li><code>' + esc(nm) + '</code>' + (why ? '<small>' + esc(why) + '</small>' : '') + '</li>';
      }).join('') + '</ul>';
    } else if (nd.count) h += '<p class="hp-note">The list is in the brief (<code>faultline brief</code>).</p>';
  }
  return h;
}
var DRAFT_TITLE = META.toolMap ? 'What was read and what is open' : 'Draft status';
function openDraftPanel() { openDock(DRAFT_TITLE, META.toolMap ? toolMapPanelHTML() : draftPanelHTML(), { wide: false }); }
if (META.toolMap) FL.onChart(function () { drawDraftBar(); });
if ($('#draftBar')) $('#draftBar').addEventListener('click', function (e) { if (e.target.closest('.db-nd')) { if (dockEl.hidden || dockEl.querySelector('.hp-h') && dockEl.querySelector('.hp-h').textContent !== DRAFT_TITLE) openDraftPanel(); else closeDock(); } });

/* ================================================================ minimap
   A small dark card in the corner of a big chart. It shows only once the chart is zoomed in past fit (at fit the whole chart is already on screen), and can be closed
   (x on the card, or the toolbar's Map button). The static picture (district tints, boxes) is drawn once per chart and theme; a repaint only blits it and adds what is lit. */
var miniColors = null, mm = null;
function stageRGB(id, a) {                                       // the canvas cannot use css variables: the same hue as the page, per theme
  var h = stageHue(id), light = document.documentElement.getAttribute('data-theme') === 'light';
  return 'hsla(' + (h == null ? 200 : h) + ',' + (light ? 60 : 55) + '%,' + (light ? 40 : 58) + '%,' + a + ')';
}
function setupMini() {
  var big = C.W > 2600 || C.H > 2600 || C.nodeCount > 80;
  $('#mmToggle').hidden = !big;
  C.miniOn = big && store.get(KEY.mini, '1') !== '0';
  $('#mmToggle').setAttribute('aria-pressed', C.miniOn ? 'true' : 'false');
  if (!C.miniOn) { mm = null; miniEl.hidden = true; return; }
  var mw = Math.round(clamp(cw * 0.13, 120, 200)), k0 = mw / C.W, mh = Math.round(clamp(C.H * k0, 44, 120));
  var k = Math.min(mw / C.W, mh / C.H), dpr = window.devicePixelRatio || 1;
  mm = { w: mw, h: mh, k: k, ox: (mw - C.W * k) / 2, oy: (mh - C.H * k) / 2, dpr: dpr, bmp: null, ge: null };
  miniCanvas.width = mw * dpr; miniCanvas.height = mh * dpr; miniCanvas.style.width = mw + 'px'; miniCanvas.style.height = mh + 'px';
  if (!$('.mini-x', miniEl)) { var x = document.createElement('button'); x.type = 'button'; x.className = 'mini-x'; x.setAttribute('aria-label', 'Hide the overview map'); x.title = 'Hide the overview map'; x.textContent = '×'; miniEl.appendChild(x); x.addEventListener('pointerdown', function (e) { e.stopPropagation(); }); x.addEventListener('click', function (e) { e.stopPropagation(); store.set(KEY.mini, '0'); setupMini(); }); }
  updateMiniView();
}
function miniBitmap() {
  var cv = document.createElement('canvas'), k = mm.k, ox = mm.ox - C.x0 * k, oy = mm.oy - C.y0 * k, g = C.chart.geom;
  cv.width = mm.w * mm.dpr; cv.height = mm.h * mm.dpr;
  var ctx = cv.getContext('2d'); ctx.setTransform(mm.dpr, 0, 0, mm.dpr, 0, 0);
  var cs = getComputedStyle(document.documentElement), line = cs.getPropertyValue('--line2').trim() || '#456', muted = cs.getPropertyValue('--muted').trim() || '#9ab';
  (g.clusters || []).forEach(function (c) {
    ctx.fillStyle = stageRGB(c.id, 0.2); ctx.strokeStyle = stageHue(c.id) == null ? line : stageRGB(c.id, 0.7); ctx.lineWidth = 1;
    ctx.fillRect(ox + c.x * k, oy + c.y * k, c.w * k, c.h * k); ctx.strokeRect(ox + c.x * k, oy + c.y * k, c.w * k, c.h * k);
  });
  if (g.edges.length <= 700) {
    ctx.globalAlpha = 0.35; ctx.strokeStyle = muted; ctx.lineWidth = 0.7;
    g.edges.forEach(function (e) { ctx.beginPath(); e.pts.forEach(function (p, i) { var x = ox + p[0] * k, y = oy + p[1] * k; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); });
  }
  ctx.globalAlpha = 0.85;
  g.nodes.forEach(function (n) { ctx.fillStyle = catColor(n.kind || n.category); ctx.fillRect(ox + n.x * k, oy + n.y * k, Math.max(1.4, n.w * k), Math.max(1.4, n.h * k)); });
  return cv;
}
function drawMini() {
  if (!C || !C.miniOn || !mm || miniEl.hidden) return;
  var ctx = miniCanvas.getContext('2d');
  if (!mm.bmp) mm.bmp = miniBitmap();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, miniCanvas.width, miniCanvas.height); ctx.drawImage(mm.bmp, 0, 0);
  var hl = C.hl && (C.hl.nodes.size || C.hl.edges.size) ? C.hl : null; if (!hl) return;
  if (!miniColors) miniColors = { sel: getComputedStyle(document.documentElement).getPropertyValue('--sel').trim() || '#fd4' };
  ctx.setTransform(mm.dpr, 0, 0, mm.dpr, 0, 0);
  var k = mm.k, ox = mm.ox - C.x0 * k, oy = mm.oy - C.y0 * k;
  if (!mm.ge) { mm.ge = {}; C.chart.geom.edges.forEach(function (e) { mm.ge[e.id] = e; }); }
  ctx.globalAlpha = 1; ctx.lineWidth = 1.3; ctx.strokeStyle = miniColors.sel;
  hl.edges.forEach(function (cls, id) { var e = mm.ge[id]; if (!e) return; ctx.beginPath(); e.pts.forEach(function (p, i) { var x = ox + p[0] * k, y = oy + p[1] * k; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); });
  ctx.fillStyle = miniColors.sel;
  hl.nodes.forEach(function (cls, id) { var n = C.nb[id]; if (n) ctx.fillRect(ox + n.x * k - 1, oy + n.y * k - 1, Math.max(3, n.w * k + 2), Math.max(3, n.h * k + 2)); });
}
function updateMiniView() {
  if (!C || !C.miniOn || !mm) return;
  var show = !S.reading && view.s > C.fitS * 1.45;
  if (show === miniEl.hidden) { miniEl.hidden = !show; if (show) drawMini(); }
  if (!show) return;
  var k = mm.k, wx = -view.x / view.s, wy = -view.y / view.s, ww = cw / view.s, wh = ch / view.s;
  miniView.style.left = (mm.ox + (wx - C.x0) * k) + 'px'; miniView.style.top = (mm.oy + (wy - C.y0) * k) + 'px';
  miniView.style.width = Math.max(4, ww * k) + 'px'; miniView.style.height = Math.max(4, wh * k) + 'px';
}
function miniGo(e) {
  if (!mm) return; var r = miniCanvas.getBoundingClientRect();
  var wx = (e.clientX - r.left - mm.ox) / mm.k + C.x0, wy = (e.clientY - r.top - mm.oy) / mm.k + C.y0;
  S.autoFit = false; userMoved(); cancelAnim(); view.x = cw / 2 - wx * view.s; view.y = ch / 2 - wy * view.s; schedule();
}
var miniDown = false;
miniEl.addEventListener('pointerdown', function (e) { miniDown = true; try { miniEl.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } miniGo(e); e.preventDefault(); });
miniEl.addEventListener('pointermove', function (e) { if (miniDown) miniGo(e); });
miniEl.addEventListener('pointerup', function () { miniDown = false; });
miniEl.addEventListener('pointercancel', function () { miniDown = false; });
$('#mmToggle').addEventListener('click', function () {
  if (!C) return; var on = $('#mmToggle').getAttribute('aria-pressed') !== 'true';
  store.set(KEY.mini, on ? '1' : '0'); setupMini();
  if (META.toolMap) {
    var nn = $('#nameNote'), say = on ? (miniEl.hidden ? 'Overview map on. It appears in the corner once you zoom in; at this zoom the whole chart is already in view.' : 'Overview map on.') : 'Overview map off.';
    if (nn) { nn.textContent = say; nn.hidden = false; clearTimeout(nn._t); nn._t = setTimeout(function () { nn.hidden = true; }, 3800); }
    announce(say);
  }
});

/* ================================================================ zoom buttons */
$('#zIn').addEventListener('click', function () { zoomBy(1.3); });
$('#zOut').addEventListener('click', function () { zoomBy(1 / 1.3); });
$('#zFit').addEventListener('click', function () { userMoved(); fitView(true); });
$('#zAll').addEventListener('click', function () { userMoved(); fitView(true, true); if (C && !isWhole(C.chart)) S.smallFor = { chart: C.id, s: fitTarget(true).s, until: performance.now() + 420 }; flush(); });
$('#z100').addEventListener('click', function () { if (!C) return; userMoved(); if (isWhole(C.chart) && typeof whole100 === 'function' && whole100()) return; S.autoFit = false; zoomAt(1 / view.s, cw / 2, ch / 2, true); });

/* ================================================================ layout changes */
/* a panel that opens or closes on the right moves only the canvas's right edge: the chart stays where it is (anchored left). A window that is resized keeps the chart centred, as before. */
function relayout(ow, oh, panel) {
  if (!C || cw < 10 || ch < 10 || S.reading) return;
  setupMini();
  if (S.autoFit || ow < 10) { var t = fitTarget(); C.fitS = t.s; C.minS = Math.min(0.12, t.s * 0.6); if (S.autoFit) { C.floored = !!t.floored; drawFloorNote(); setView(t, false); } keepBar(t.bar); }
  else if (!panel) { view.x += (cw - ow) / 2; view.y += (ch - oh) / 2; schedule(); drawZoomBar(); }
}
var ro = new ResizeObserver(function () { var ow = cw, oh = ch; measure(); relayout(ow, oh, false); });
ro.observe(canvas);

/* ================================================================ keyboard */
/* the ring around the whole canvas is for a person who tabbed into it; a click on a box, then Esc, leaves none */
var lastKeyTab = false;
document.addEventListener('keydown', function (e) { lastKeyTab = e.key === 'Tab'; }, true);
document.addEventListener('pointerdown', function () { lastKeyTab = false; }, true);
canvas.addEventListener('focus', function () { canvas.classList.toggle('kb-ring', lastKeyTab); });
canvas.addEventListener('blur', function () { canvas.classList.remove('kb-ring'); });
function inGraphFocus(t) { return t === document.body || t === document.documentElement || t === canvas || canvas.contains(t); }
document.addEventListener('keydown', function (e) {
  var t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (e.key === 'Escape') {
    if (!qResults.hidden) { closeResults(); return; }
    if (!fbMore.hidden) { closeFbMore(); return; }
    if (typeof TP !== 'undefined' && TP.open) { openTracePanel(false); return; }
    if (S.pickFrom) { cancelPick(); return; }
    if (!dockEl.hidden) { closeDock(); return; }
    if (S.hpanel && !S.reading) { closeHandles(); handlesBtn.focus(); return; }
    if (!S.reading && (S.walk || S.follow)) { if (S.walk) stopWalk(); if (S.follow) setFollow(false); return; }                  // Esc leaves a walk or a tour of the charts (the top bar says Esc clears)
    if (C && !S.reading && (S.sel || S.trace || S.hover)) { HV.esc = { x: HV.x, y: HV.y }; dropHover(); if (S.sel || S.trace) { clearAll(); return; } if (!S.regSel.length) return; }
    if (C && !S.reading && S.regSel.length) { clearRegions(); return; }
    if (C && !S.reading && !rgPanel.hidden) { openRegionPanel(false); rdRegions.focus(); return; }
    if (!legendEl.hidden) { toggleLegend(false); $('#legendBtn').focus(); return; }
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowLeft' && !typing && !S.reading && S.jumps.length) { e.preventDefault(); goBack(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.key === ']' || e.key === '[') && !S.reading && S.walk) { e.preventDefault(); walkStep(e.key === ']' ? 1 : -1); return; }
  if ((e.key === ']' || e.key === '[') && !S.reading && JOURNEY.length > 1) { e.preventDefault(); if (!S.follow) setFollow(true, { stay: true }); followStep(e.key === ']' ? 1 : -1); return; }
  if (e.key === '/' && !S.reading) { e.preventDefault(); qInput.focus(); qInput.select(); return; }
  if (S.reading || !C) return;
  switch (e.key) {
    case '+': case '=': e.preventDefault(); zoomBy(1.25); return;
    case '-': case '_': e.preventDefault(); zoomBy(0.8); return;
    case '0': e.preventDefault(); userMoved(); fitView(true); return;
  }
  if (!inGraphFocus(t)) return;
  if (e.key === 'Tab') {
    if (S.alt && S.alt.list.length > 1 && cycleAlt(e.shiftKey ? -1 : 1, false)) { e.preventDefault(); } else S.alt = null;
    return;
  }
  if (e.key === 'Enter' && !S.sel) { var en = entryNodes()[0]; if (en) { e.preventDefault(); selectNode(en, { reveal: 'zoom' }); } return; }
  var arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!arrow) return;
  e.preventDefault();
  if (e.shiftKey || !S.sel) { panBy(-arrow[0] * 120, -arrow[1] * 120); return; }
  if (arrow[0] === 1) walk('next');
  else if (arrow[0] === -1) walk('prev');
  else if (!(S.alt && cycleAlt(arrow[1], true))) panBy(0, -arrow[1] * 120);
});

/* ================================================================ routing (URL hash) */
function currentHash() {
  if (S.reading) return '#reading=' + S.reading + guideHashTail();
  if (!C) return '';
  var h = '#chart=' + encodeURIComponent(C.id);
  if (S.sel && S.sel.t === 'node') h += '&node=' + encodeURIComponent(S.sel.id);
  else if (S.sel && S.sel.t === 'edge') h += '&edge=' + encodeURIComponent(S.sel.id);
  if (S.handle) h += '&handle=' + encodeURIComponent(S.handle);
  if (S.regSel.length) h += '&region=' + S.regSel.map(encodeURIComponent).join(',');
  return h;
}
function writeHash(push) {
  var h = currentHash(); if (!h || location.hash === h) return;
  try { (push ? history.pushState : history.replaceState).call(history, null, '', h); } catch (e) { try { location.hash = h; } catch (_) { /* ignore */ } }
}
function showMode(mode) {
  app.dataset.mode = mode; document.body.classList.toggle('is-reading', mode === 'reading');       // the how-to line is about boxes and roads; a reading page has none
  chartView.hidden = mode !== 'chart'; readingView.hidden = mode !== 'reading';
  if (mode === 'chart') { onboardEl.hidden = store.get(KEY.onboard, '') === '1'; } else { onboardEl.hidden = true; hideTip(); }
}
function openChart(id, nodeId, o) {
  o = o || {};
  if (!CH[id]) id = FIRST;
  if (!o.noHash && !o.restoreView && C && C.id !== id && S.jumps.length && S.jumps[S.jumps.length - 1].chart === id) S.jumps.pop();      // arriving by the rail, the menu or a chip at the chart the Back chip points to: that way back is used up, and the chart does not offer a way back to itself
  var changed = !C || C.id !== id, wasReading = !!S.reading;
  S.reading = null; S.viewing = id; showMode('chart');
  if (changed) { clearTimeout(HV.timer); HV.timer = 0; HV.cand = null; S.hover = null; S.regSel = []; closeFbMore(); hideTip(); S.viewing = id; mountChart(id); } else if (wasReading) { measure(); if (S.autoFit) fitView(false); setupMini(); }
  S.sel = null; S.trace = null; S.pickFrom = null; S.alt = null; S.pre = null; canvas.classList.remove('picking');
  if (nodeId && C.chart.nodes[nodeId]) S.sel = { t: 'node', id: nodeId };
  else if (o.edge && C.chart.edges[o.edge]) S.sel = { t: 'edge', id: o.edge };
  if (S.sel && wholeNow() && app.dataset.insp === 'collapsed') setInspCollapsed(false, true);      // a deep link to a box on the whole map brings the details panel
  else if (S.sel && S.roomed && app.dataset.insp === 'collapsed' && C.chart.kind === 'overview') { setInspCollapsed(false, true); S.pinOpened = true; }
  else if (S.sel && S.roomed && app.dataset.insp === 'collapsed') { setInspCollapsed(false, true); S.autoFit = false; measure(); }      // and so does one on a chart that was given the room (the zoom stays)
  S.landing = o.landed && S.sel && S.sel.t === 'node' ? { chart: C.id, node: S.sel.id } : null;
  paint(); renderInspector(true); drawPickBanner(); markNavCurrent();
  applyHandleFocus(); if (S.hpanel === 'engage') drawHandles();
  if (o.restoreView) { if (o.restoreView === 'fit') { if (!changed) fitView(true); } else { S.autoFit = false; setView(o.restoreView, !changed, 320); } }       // coming back: put the view exactly where it was
  else if (S.sel && S.sel.t === 'node') reveal(nodeBox(nodeId, 70), { minScale: o.minScale || 0.8, center: o.center !== false, lit: o.lit, also: o.also ? unionBox(o.also.filter(function (k) { return C.nb[k]; }).map(function (k) { return nodeBox(k, 40); })) : null });   // (no move on the poster: reveal returns while it is fitted)
  else if (S.sel) reveal(edgeBox(S.sel.id), { minScale: 0.6, maxScale: 1, center: true });
  if (S.landing) flashLanded(S.landing.node);
  drawFlowBar();
  if (o.push !== false && !o.noHash) writeHash(changed || wasReading ? !!o.push : false);
  if (changed) announce('Opened ' + C.chart.title + '.');
}
function openReading(mode, o) {
  o = o || {};
  if (!GUIDES.some(function (g) { return g.id === mode; })) return;
  S.reading = mode; S.viewing = null; showMode('reading'); dropHover(); drawChartStep(); if (typeof followBtn !== 'undefined' && followBtn) followBtn.hidden = JOURNEY.length < 2;
  guideShow(mode, o.params || null);
  var g = GUIDES.filter(function (x) { return x.id === mode; })[0];
  document.title = g.title + ' · ' + siteName();
  markNavCurrent(); insp.innerHTML = '';
  if (!o.noHash) writeHash(!!o.push);
  announce('Opened ' + g.title + '.');
  if (o.focus !== false) readingView.focus({ preventScroll: true });
}
function route(first) {
  var p = new URLSearchParams(location.hash.replace(/^#/, '')), rd = p.get('reading');
  if (rd && GUIDES.some(function (g) { return g.id === rd; })) { openReading(rd, { noHash: true, focus: false, params: p }); return; }
  var hd = p.get('handle'), hh = hd ? findHandle(hd) : null;
  var id = p.get('chart'), want = p.get('node');
  if (want && (!CH[id] || !CH[id].nodes[want])) id = chartForNode(want) || id;                 // #node=<box> alone, or a chart that does not hold it
  if (!CH[id]) id = hh ? bestChartFor(hh) : FIRST;
  if (!first && S.jumps.length && S.jumps[S.jumps.length - 1].chart === id) S.jumps.pop();      // the browser's Back button undid a portal jump: keep our own stack in step
  S.handle = hh ? hh.tag : null;                                  // before the chart mounts, so the first paint already has the focus
  openChart(id, p.get('node'), { edge: p.get('edge'), noHash: true });
  var rgp = p.get('region');
  if (rgp && C && C.rg) setRegionSel(rgp.split(','), { noHash: true, quiet: true, keepNode: !!p.get('node') });
  if (hh) showHandle(hh.tag, { noHash: true }); else if (S.hpanel) { S.hpanel = null; hpanel.hidden = true; setHandlesBtn(); }
  if (first) writeHash(false);
}
window.addEventListener('hashchange', function () { route(false); });
window.addEventListener('popstate', function () { route(false); });

/* ================================================================ guides: compact reader (viewer/guides.js) */
/*__INCLUDE:guides.js__*/
/*__INCLUDE:breaks.js__*/
/*__INCLUDE:fails.js__*/

/*__INCLUDE:flow.js__*/
/*__INCLUDE:regions.js__*/
/*__INCLUDE:whole.js__*/
/*__INCLUDE:overview.js__*/
/*__INCLUDE:walk.js__*/
/*__INCLUDE:tracepanel.js__*/

/* later modules (own files, same closure): evidence layer and zoom-dependent text. They use FL, defined near the top. */
/*__INCLUDE:evidence.js__*/
/*__INCLUDE:zoomtext.js__*/
/*__INCLUDE:look.js__*/
/*__INCLUDE:frame.js__*/
/*__INCLUDE:phone.js__*/

/* ================================================================ boot */
buildNav(); decorateNav(); applyPanelDefaults();
(function () { var t = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; var b = $('#themeBtn'); b.textContent = t === 'dark' ? 'Light mode' : 'Dark mode'; b.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'); })();
$('#siteTitle').textContent = brandTitle(); if (META.title) document.title = brandTitle();
drawDraftBar();
(function () { var l = META.link, a = $('#extraLink'); if (a && l && l.href) { a.href = l.href; a.textContent = l.label || l.href; a.hidden = false; } })();
route(true);
// debugging / test hook
window.atlasInspect = function () {
  return {
    chart: C && C.id, reading: S.reading, pinned: S.sel, hover: S.hover, handle: S.handle, handlePanel: S.hpanel, hoverSwitches: S.hsw, paints: S.hpaints,
    trace: S.trace && { kind: S.trace.kind, nodes: S.trace.nodes.size, edges: S.trace.edges.size },
    scale: view.s, bar: C && C.barAt ? { x: Math.round(C.barAt.x), y: Math.round(C.barAt.y), home: !!C.barAt.home, cost: Math.round(C.barAt.cost) } : null, floored: !!(C && C.floored), roomed: !!S.roomed, lod: C && C.lod, view: { x: view.x, y: view.y, cw: cw, ch: ch }, matches: S.matches.length, charts: ORDER.slice(), lastCopy: S.lastCopy || null, dock: !dockEl.hidden, draft: META.draft,
    fit: C && !isWhole(C.chart) ? { W: C.W, H: C.H, x0: C.x0, y0: C.y0, bb: C.nodeCount <= 300 ? cueBounds() : null } : null, nodes: C ? Object.keys(C.chart.nodes).length : 0, edges: C ? Object.keys(C.chart.edges).length : 0,
    portals: C && C.portals ? C.portals.length : 0, jumps: S.jumps.length, follow: S.follow, portalFocus: S.pf,
    regions: C && C.rg ? { n: C.rg.list.length, selected: S.regSel.slice(), halosOn: C.rg.halosOn, spineOn: C.rg.spineOn, panel: !rgPanel.hidden, haloOn: Object.keys(C.rg.halo).filter(function (k) { return C.rg.halo[k].classList.contains('on'); }).length } : null
  };
};
window.atlasFL = FL;
window.atlasTermsIn = function (t) { return termsIn(t).map(function (x) { return { tag: x.tag, meaning: x.meaning }; }); };
window.atlasPortalJump = function (id) { var p = findPortal(id); if (p) jumpTo(p); return !!p; };
window.atlasZoomTo = function (s, wx, wy) { if (!C) return; centerOn(wx == null ? C.x0 + C.W / 2 : wx, wy == null ? C.y0 + C.H / 2 : wy, s, false); flush(); };
window.atlasOpen = function (id, node) { openChart(id, node, { push: true }); };
})();
