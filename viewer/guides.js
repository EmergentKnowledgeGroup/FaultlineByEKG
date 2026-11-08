/* ================================================================ guides: generated reader (viewer/guides.js)
   Spliced into the viewer closure by the INCLUDE line in viewer.js, so it shares viewer.js scope: esc, $, $$, S, CH, DATA, META, ORDER, STAGE_TITLE, handles(), findHandle(),
   hchip(), hchipBtn(), handleName(), famOf(), openChart(), showHandle(), chartForNode(), bestChartFor(), censusRows(), notDrawnInfo(), catColor(), kindInfo(), eShort(), norm(), hasTok().
   Nothing here is written for one system: every word of every guide comes from atlasData, plus the fixed meaning of the tool's own labels (levels, walk labels).
   Guides: narrative (stages in order, main path, loops, endings) | glossary (terms and the boxes that carry them) | scope (census, coverage, not drawn yet, off by default, evidence labels)
           | ops (only when the model has an operations stage). Shared layout: sticky contents list, filter, Expand/Collapse, every section a <details> with a one-line takeaway.
   Optional top-level atlasData fields read when present (each has a fallback derived from charts): system {name,tagline,summary,purpose}, stages [{id,title,blurb,order,role}],
   paths [{id,title,boxes,blurb}], loops [{id,title,blurb,boxes,limit}], findings [...], and the evidence overlay where the evidence layer reads it (DATA.evidence,
   META.evidence or chart.evidence: {boxes,labels,walks,notMapped,...}; DATA.findings or its .findings/.candidates). A stage is an operations stage when role/kind is 'ops' or its name says so.
   Nothing throws on missing data. Deep links:  #reading=glossary&term=Lease   #reading=narrative&section=loops   #reading=glossary&q=retry                                       */

var GD = { st: {}, pos: {}, pin: null, raf: 0, bulk: false, wired: false, print: null, ptimer: 0, M: null, off: 60 };
/* the slim left rail (a laptop-sized window) shows one small picture per guide instead of a letter or a mark: a crack for where it can break, an arrow that stops at a wall for how it fails, so neither reads as "close" or "error" */
var RAIL_SVG = {
  breaks: '<path d="M3 2.6h10v10.8H3z" opacity=".5"/><path d="M8.7 2.6 6.9 6.5l3 1.5-2.3 3.5.6 1.9"/>',
  fails: '<path d="M2 8h7.2"/><path d="M6.6 4.9 9.7 8l-3.1 3.1"/><path d="M12.8 3v10"/>',
  narrative: '<path d="M2.5 4h11M2.5 8h11M2.5 12h7"/>',
  glossary: '<path d="M4 2.6h7.6a1 1 0 0 1 1 1v9.8H5a1 1 0 0 1-1-1z"/><path d="M4 12.4a1 1 0 0 1 1-1h7.6"/>',
  scope: '<circle cx="7" cy="7" r="4.1"/><path d="m10.2 10.2 3.3 3.3"/>',
  ops: '<circle cx="8" cy="8" r="2.2"/><path d="M8 2.2v1.7M8 12.1v1.7M2.2 8h1.7M12.1 8h1.7M3.9 3.9l1.2 1.2M10.9 10.9l1.2 1.2M12.1 3.9l-1.2 1.2M5.1 10.9l-1.2 1.2"/>'
};
function railIcon(id, fallback) { return RAIL_SVG[id] ? '<svg class="rail-ic" viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + RAIL_SVG[id] + '</svg>' : fallback; }
function gdArr(v) { return Array.isArray(v) ? v : []; }
function gdS(v) { return typeof v === 'string' ? v.trim() : ''; }
function gdN(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function gdUniq(a) { var o = {}; return a.filter(function (x) { if (!x || o[x]) return false; o[x] = 1; return true; }); }
function gdSlug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function gdCap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
function gdPlural(n, w, ws) { return n + ' ' + (n === 1 ? w : (ws || w + 's')); }
function gdTake(s, min) {                    // first one or two sentences: a ONE-LINE takeaway (never starts mid-sentence, never drops a piece: see sentencesOf)
  var ss = sentencesOf(s), out = '', i;
  for (i = 0; i < ss.length && out.length < (min || 60); i++) out += (out ? ' ' : '') + ss[i];
  return out || String(s || '').replace(/\s+/g, ' ').trim();
}
function gdPretty(id) { return String(id || '').replace(/^(st|s)_/, '').replace(/[_.-]+/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
function gdState() { var k = S.reading || '_'; return GD.st[k] || (GD.st[k] = { section: '', term: '', q: '' }); }
function guideHashTail() {                 // appended to #reading=<guide> by viewer.js currentHash()
  var st = S.reading && GD.st[S.reading]; if (!st) return '';
  var fl = S.reading === 'fails' && typeof FLF !== 'undefined' ? (FLF.by !== '*' ? '&by=' + encodeURIComponent(FLF.by) : '') + (FLF.kind !== '*' ? '&kind=' + encodeURIComponent(FLF.kind) : '') + (FLF.stage !== '*' ? '&stage=' + encodeURIComponent(FLF.stage) : '') : '';
  return (st.term ? '&term=' + encodeURIComponent(st.term) : st.section ? '&section=' + encodeURIComponent(st.section) : '') + (st.q ? '&q=' + encodeURIComponent(st.q) : '') + fl;
}
function gdSetSub(o) { var st = gdState(); for (var k in o) st[k] = o[k]; if (S.reading) writeHash(false); }

/* ---- official handles inside prose become small buttons that open the "Where X engages" view -------------------------- */
var gdLinkRx = null, gdLinkN = -1;
function gdLinkable(t, h) { return t.length >= 3 && h.count > 0 && /[A-Z0-9_.\/]/.test(t) && !/^\d+$/.test(t) && esc(t) === t; }
function gdRx() {
  var H = handles(), keys = Object.keys(H), n = keys.length; if (gdLinkRx !== null && gdLinkN === n) return gdLinkRx;
  var toks = keys.filter(function (t) { return gdLinkable(t, H[t]); }).sort(function (a, b) { return b.length - a.length; }).map(function (t) { return t.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); });
  gdLinkN = n; gdLinkRx = toks.length ? new RegExp('(^|[^A-Za-z0-9_])(' + toks.join('|') + ')(?![A-Za-z0-9_])', 'g') : false;
  return gdLinkRx;
}
function gdText(s) {
  var rx = gdRx(), link = function (e) { return rx ? e.replace(rx, function (m, pre, t) { return pre + '<button type="button" class="hlink" data-handle="' + t + '" title="Where ' + t + ' engages">' + t + '</button>'; }) : e; };
  return gdTicked(s, function (t) { return link(esc(t)); });
}
/* text that carries `ticks` (the model's and the checks' own words): what sits between a pair is code, drawn in the code font, and the ticks themselves are never shown. A single tick with no pair stays as written.
   plain(t) turns each stretch of ordinary text into html. */
function gdTicked(s, plain, code) {
  var parts = String(s == null ? '' : s).split('`'), out = '', i;
  if (parts.length % 2 === 0) { var last = parts.pop(); parts[parts.length - 1] += '`' + last; }
  for (i = 0; i < parts.length; i++) out += i % 2 ? (parts[i] ? (code ? code(parts[i]) : '<code>' + esc(parts[i]) + '</code>') : '') : plain(parts[i]);
  return out;
}
/* prose a person reads. Ticked text is code; the id of a box the checks wrote in ("fetch.lua_pop_wait") is that box's own name; "stage s_add" is the stage's name. No internal id reaches the page. */
function gdProse(s) {
  var M = gdModel(), name = function (w) { return '<span class="bk-nm">' + esc(gdTitle(w)) + '</span>'; };
  return gdTicked(s, function (t) {
    return esc(t).replace(/\b([Ss]tage )([A-Za-z_][\w-]*)\b/g, function (m, a, id) { return M.stageById[id] ? a + esc(gdStageName(id)) : m; })
      .replace(/[A-Za-z_][\w-]*(?:\.[\w-]+)+/g, function (w) { return M.box[w] ? name(w) : w; })
      .replace(/\bl_[A-Za-z0-9_]+\b/g, function (w) { var t = gdLoopTitle(M, w); return t ? '<span class="bk-nm">' + esc(t) + '</span>' : w; });       // a loop's id is the loop's own title
  }, function (c) { return M.box[c.trim()] ? name(c.trim()) : '<code>' + esc(c) + '</code>'; });
}
function gdLoopTitle(M, id) {            // a declared loop's title by its id ("l_retry"), or ''
  if (!M.loopTitles) { M.loopTitles = Object.create(null); (M.loops || []).forEach(function (l) { if (l && l.id && l.title) M.loopTitles[l.id] = l.title; }); }
  return M.loopTitles[id] || '';
}
/* the same words as plain text (a tooltip, a label): no ticks, and a box's id is its name */
function gdPlain(s) {
  var M = gdModel();
  return String(s == null ? '' : s).split('`').join('').replace(/\b([Ss]tage )([A-Za-z_][\w-]*)\b/g, function (m, a, id) { return M.stageById[id] ? a + gdStageName(id) : m; }).replace(/[A-Za-z_][\w-]*(?:\.[\w-]+)+/g, function (w) { return M.box[w] ? gdTitle(w) : w; }).replace(/\bl_[A-Za-z0-9_]+\b/g, function (w) { return gdLoopTitle(M, w) || w; });
}
/* whatever text still has a pair of ticks in it when a page is drawn gets them turned into code (a safety net for text that did not come through gdText or gdProse) */
function gdTicks(root) {
  if (!root) return;
  var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), hit = [], n, p;
  while ((n = w.nextNode())) { if (n.nodeValue.indexOf('`') < 0) continue; p = n.parentElement; if (p && !/^(CODE|PRE|SCRIPT|STYLE|TEXTAREA)$/.test(p.tagName)) hit.push(n); }
  hit.forEach(function (t) {
    var parts = t.nodeValue.split('`'), f, i, c; if (parts.length < 3) return;
    if (parts.length % 2 === 0) { var last = parts.pop(); parts[parts.length - 1] += '`' + last; }
    f = document.createDocumentFragment();
    for (i = 0; i < parts.length; i++) { if (!parts[i]) continue; if (i % 2) { c = document.createElement('code'); c.textContent = parts[i]; f.appendChild(c); } else f.appendChild(document.createTextNode(parts[i])); }
    t.parentNode.replaceChild(f, t);
  });
}
function gdChips(tags, max, btn) {
  tags = tags.filter(function (t) { return findHandle(t); }); if (!tags.length) return '';
  var shown = max ? tags.slice(0, max) : tags;
  return shown.map(function (t) { return btn ? hchipBtn(t) : hchip(t); }).join('') + (max && tags.length > max ? '<span class="hchip more" title="' + esc(tags.slice(max).join(', ')) + '">+' + (tags.length - max) + '</span>' : '');
}
function gdEngageChart(h) { return bestChartFor(h); }
function gdOpenEngage(tag, cid) {          // -> the chart view with the "Where <tag> engages" panel open
  var h = findHandle(tag); if (!h) { announce('No official handle called ' + tag + '.'); return; }
  S.handle = h.tag; openChart(cid && CH[cid] ? cid : gdEngageChart(h), null, { push: true }); showHandle(h.tag, { push: true });
}
function gdLight(cid, rid) {               // open a chart with a stage or loop lit (the regions list of the whole-system map)
  openChart(cid, null, { push: true });
  if (typeof setRegionSel === 'function' && C && C.rg && C.rg.byId[rid]) setRegionSel([rid], { reveal: true });
}

/* ================================================================ the model: everything the guides say is read from here
   Built once from atlasData. Charts that carry it: stage, detail and whole charts (the overview holds stage summaries, not boxes, unless nothing else exists). */
function gdChartRank(c) { var r = { stage: 0, detail: 1, whole: 2, overview: 3 }[c.kind]; return r == null ? 1.5 : r; }
function gdTitle(id) { var b = GD.M && GD.M.box[id]; return b ? (b.n.title || id) : id; }
function gdShort(M, a, b) {                // shortest forward road between two boxes (no return roads), or null
  if (a === b) return [a];
  var prev = {}, q = [a], i = 0; prev[a] = null;
  while (i < q.length) {
    var x = q[i++], o = M.out[x] || [];
    for (var k = 0; k < o.length; k++) {
      var t = o[k].to; if (o[k].type === 'return' || t in prev) continue;
      prev[t] = x; if (t === b) { var p = [b]; while (prev[p[0]] != null) p.unshift(prev[p[0]]); return p; }
      q.push(t);
    }
  }
  return null;
}
var GD_OPS_RX = /\b(ops|operations?|operational|operators?|admin|administration|maintenance|monitoring|deploy(ment)?|devops|sre|incident|on[- ]?call|runbook|infrastructure|housekeeping|back[- ]?office)\b/i;

function gdModel() {
  if (GD.M) return GD.M;
  var M = GD.M = { box: Object.create(null), ids: [], routes: [], out: {}, inn: {}, stages: [], stageById: Object.create(null), stageOf: {}, loops: [], path: null, ends: [], entries: [], offs: [], sys: {}, real: [], whole: null };
  var all = ORDER.filter(function (id) { return CH[id]; }), real = all.filter(function (id) { return CH[id].kind !== 'overview'; });
  if (!real.length) real = all;
  M.real = real = real.map(function (id, i) { return { id: id, i: i, r: gdChartRank(CH[id]) }; }).sort(function (a, b) { return a.r - b.r || a.i - b.i; }).map(function (x) { return x.id; });
  real.forEach(function (cid) { if (!M.whole && isWhole(CH[cid])) M.whole = CH[cid]; });
  real.forEach(function (cid) {
    var c = CH[cid];
    Object.keys(c.nodes).forEach(function (nid) {
      var n = c.nodes[nid], b = M.box[nid];
      if (!b) { b = M.box[nid] = { id: nid, n: n, charts: [] }; M.ids.push(nid); } else if (!b.n.plain && n.plain) b.n = n;
      b.charts.push(cid);
    });
  });
  var seenE = {}, hasRoad = {};
  real.forEach(function (cid) {
    var c = CH[cid];
    Object.keys(c.edges).forEach(function (eid) {
      var e = c.edges[eid]; if (!M.box[e.from] || !M.box[e.to]) return;
      var k = e.from + '|' + e.to + '|' + (e.type || '') + '|' + eShort(e);
      if (seenE[k]) { if (!seenE[k].why && e.why) seenE[k].why = e.why; return; }
      seenE[k] = { id: e.id || eid, from: e.from, to: e.to, type: e.type || 'forward', when: eShort(e), why: e.why || '', inferred: !!e.inferred, refs: gdArr(e.refs) };
      M.routes.push(seenE[k]); hasRoad[e.from + '|' + e.to] = 1;
    });
  });
  real.forEach(function (cid) {            // a hand-off between charts that no chart draws as a route (a map with no whole-system chart)
    gdArr(CH[cid].portals).forEach(function (p) {
      var a = p.dir === 'in' ? p.node2 : p.node, b = p.dir === 'in' ? p.node : p.node2;
      if (!a || !b || !M.box[a] || !M.box[b] || hasRoad[a + '|' + b]) return;
      hasRoad[a + '|' + b] = 1; M.routes.push({ id: 'portal:' + a + ':' + b, from: a, to: b, type: 'forward', when: gdS(p.label), why: gdS(p.why), inferred: false, refs: [], portal: true });
    });
  });
  M.routes.forEach(function (r) { (M.out[r.from] = M.out[r.from] || []).push(r); (M.inn[r.to] = M.inn[r.to] || []).push(r); });
  gdStages(M); gdSystem(M);
  M.ends = M.ids.filter(function (id) { return kindOf(M.box[id].n) === 'end'; });
  M.entries = M.ids.filter(function (id) { return !(M.inn[id] || []).length; });
  M.offs = M.ids.filter(function (id) { var s = M.box[id].n.status; return s === 'off' || s === 'test-only' || s === 'default-on'; });
  M.path = gdPath(M); M.loops = gdLoops(M);
  return M;
}
function gdStages(M) {
  var top = gdArr(DATA.stages).length ? DATA.stages : gdArr(DATA.model && DATA.model.stages);
  var wst = M.whole ? (gdArr(M.whole.stages).length ? M.whole.stages : gdArr(M.whole.regions).filter(function (r) { return r && r.kind === 'stage'; })) : [];
  var ensure = function (id) {
    return M.stageById[id] || (M.stageById[id] = (M.stages[M.stages.push({ id: id, title: '', blurb: '', order: null, role: '', boxes: [], chart: '', members: [] }) - 1]));
  };
  [top, wst].forEach(function (list) {
    list.forEach(function (s) {
      if (!s || !s.id) return; var o = ensure(s.id);
      o.title = o.title || gdS(s.title); o.blurb = o.blurb || gdS(s.blurb || s.summary); if (o.order == null) o.order = gdN(s.order);
      o.role = o.role || gdS(s.role || s.kind) || (s.ops ? 'ops' : ''); if (!o.members.length) o.members = gdArr(s.nodes || s.boxes);
    });
  });
  M.ids.forEach(function (id) { var sid = gdS(M.box[id].n.stage); if (sid) { ensure(sid); M.stageOf[id] = sid; } });
  M.stages.forEach(function (s) { s.members.forEach(function (id) { if (M.box[id] && !M.stageOf[id]) M.stageOf[id] = s.id; }); });
  M.real.forEach(function (cid) {          // a stage chart names its stage by the stage most of its boxes belong to
    var c = CH[cid]; if (c.kind !== 'stage') return; var cnt = {}, best = '', top2 = 0;
    Object.keys(c.nodes).forEach(function (nid) { var s = M.stageOf[nid]; if (s) { cnt[s] = (cnt[s] || 0) + 1; if (cnt[s] > top2) { top2 = cnt[s]; best = s; } } });
    if (best && !M.stageById[best].chart) { var st = M.stageById[best]; st.chart = cid; st.blurb = st.blurb || gdS(c.summary); st.title = st.title || gdS(c.navLabel); }
  });
  var loose = M.ids.filter(function (id) { return !M.stageOf[id]; });
  if (loose.length) { var o = ensure(M.stages.length ? '_other' : '_all'); o.title = M.stages.length > 1 ? 'Other boxes' : 'The system'; loose.forEach(function (id) { M.stageOf[id] = o.id; }); }
  M.stages.forEach(function (s, i) { s.i = i; s.title = s.title || STAGE_TITLE[s.id] || gdPretty(s.id); });
  if (M.stages.length && M.stages.every(function (s) { return s.order != null; })) M.stages.sort(function (a, b) { return a.order - b.order || a.i - b.i; });
  M.stages.forEach(function (s, i) { s.i = i; s.boxes = M.ids.filter(function (id) { return M.stageOf[id] === s.id; }); s.ops = /^ops$/i.test(s.role) || GD_OPS_RX.test(s.title + ' ' + s.id.replace(/[_.]+/g, ' ')); });
}
function gdSystem(M) {
  var sy = DATA.system || META.system || (DATA.model && DATA.model.system) || {}, ov = null;
  ORDER.forEach(function (id) { if (!ov && CH[id] && CH[id].kind === 'overview') ov = CH[id]; });
  var name = gdS(sy.name) || gdS(META.title).replace(/\s*[·|–-]\s*(interactive\s+|faultline\s+)?(atlas|map)\s*$/i, '');
  M.sys = { name: name, tagline: gdS(sy.tagline), summary: gdS(sy.summary) || gdS(ov && ov.summary) || gdS(M.whole && M.whole.summary), purpose: gdS(sy.purpose) };
}

/* ---- main path, loops --------------------------------------------------------------------------------------------------- */
function gdPath(M) {
  var P = gdArr(DATA.paths).length ? DATA.paths : gdArr(DATA.model && DATA.model.paths), cand = [], keep = function (ids) { return gdUniq(gdArr(ids)).filter(function (id) { return M.box[id]; }); };
  if (P.length && P[0]) cand.push({ ids: P[0].boxes, title: gdS(P[0].title), blurb: gdS(P[0].blurb) });
  if (M.whole) cand.push({ ids: M.whole.spine });
  var joined = []; M.stages.forEach(function (s) { var c = s.chart && CH[s.chart]; if (c) gdArr(c.spine).forEach(function (id) { joined.push(id); }); });
  cand.push({ ids: joined });
  for (var i = 0; i < cand.length; i++) { var ids = keep(cand[i].ids); if (ids.length >= 2) return { ids: ids, title: cand[i].title || 'Main path', blurb: cand[i].blurb || '', derived: false }; }
  var start = M.entries.filter(function (id) { return kindOf(M.box[id].n) !== 'store'; })[0] || M.entries[0] || M.ids[0], best = null;   // none declared: the longest shortest road from the start to a happy ending
  if (start == null) return { ids: [], title: 'Main path', blurb: '', derived: true };
  var pick = function (list) { list.forEach(function (e) { var p = gdShort(M, start, e); if (p && (!best || p.length > best.length)) best = p; }); };
  pick(M.ends.filter(function (id) { return M.box[id].n.outcome === 'success'; })); if (!best) pick(M.ends);
  return { ids: best || [start], title: 'Main path', blurb: '', derived: true };
}
function gdLoops(M) {
  var L = [], seen = {}, add = function (l, ix) {
    var id = gdS(l && l.id) || ('loop-' + (L.length + 1)); if (!l || seen[id]) return;
    var boxes = gdUniq(gdArr(l.boxes || l.nodes)).filter(function (b) { return M.box[b]; }); if (!boxes.length) return;
    seen[id] = 1; L.push({ id: id, title: gdS(l.title) || 'Loop ' + (L.length + 1), blurb: gdS(l.blurb || l.summary), boxes: boxes, limit: gdS(l.limit), derived: !!l.derived });
  };
  (gdArr(DATA.loops).length ? DATA.loops : gdArr(DATA.model && DATA.model.loops)).forEach(add);
  M.real.forEach(function (cid) { var c = CH[cid]; gdArr(c.regions).filter(function (r) { return r && r.kind === 'loop'; }).forEach(add); gdArr(c.loops).forEach(add); });
  if (META.counts && META.counts.loops) return L;          // the build already worked the others out from the return roads (DATA.loops, derived: true)
  M.routes.forEach(function (r) {          // an atlas built before a return road no declared loop holds still makes a loop
    if (r.type !== 'return' || L.some(function (l) { return l.boxes.indexOf(r.from) >= 0 && l.boxes.indexOf(r.to) >= 0; })) return;
    var p = gdShort(M, r.to, r.from) || [r.to, r.from];
    L.push({ id: 'back-' + gdSlug(r.from) + '-' + gdSlug(r.to), title: 'Back to ' + gdTitle(r.to), blurb: '', boxes: gdUniq(p), limit: '', derived: true });
  });
  return L;
}
function gdLoopRoads(M, l) {               // the roads into a loop, out of it, and the return roads that close it
  var set = {}; l.boxes.forEach(function (b) { set[b] = 1; });
  var inn = [], out = [], back = [];
  M.routes.forEach(function (r) {
    var f = set[r.from], t = set[r.to];
    if (f && t) { if (r.type === 'return') back.push(r); } else if (t) inn.push(r); else if (f) out.push(r);
  });
  return { inn: inn, out: out, back: back };
}

/* ---- every total the page prints comes from here: META.counts (src/build/counts.mjs), one definition each. An older atlas is counted from the page's own model in the same shape. ---- */
function gdCounts(M) {
  if (GD.CN) return GD.CN;
  var c = META.counts;
  if (c && c.ends && c.loops) return (GD.CN = c);
  var stop = M.ends.filter(function (id) { return !(M.out[id] || []).length; }).length, oc = { success: 0, failure: 0, refusal: 0, neutral: 0 }, nl = M.loops.filter(function (l) { return !l.limit; }).length, wk = M.loops.filter(function (l) { return l.derived; }).length;
  M.ends.forEach(function (id) { var o = M.box[id].n.outcome; oc[oc[o] != null ? o : 'neutral']++; });
  return (GD.CN = { boxes: M.ids.length, roads: M.routes.length, roadsInferred: M.routes.filter(function (r) { return r.inferred; }).length, roadsBack: M.routes.filter(function (r) { return r.type === 'return'; }).length, stages: M.stages.length,
    ends: { boxes: M.ends.length, stop: stop, back: M.ends.length - stop, outcome: oc }, loops: { declared: M.loops.length - wk, workedOut: wk, total: M.loops.length, noLimit: nl, noLimitDeclared: nl - wk, noLimitWorkedOut: wk } });
}
var GD_NUMS_HREF = '#reading=scope&section=numbers';
function gdNumLink(label) { return '<a class="hlink gd-numlink" href="' + GD_NUMS_HREF + '" title="Open the table that says what each number on this page counts">' + esc(label || 'What the numbers count') + '</a>'; }
function gdN1(n) { return typeof n === 'number' ? n.toLocaleString('en-US') : String(n); }

/* ---- little pieces of HTML shared by the guides ----------------------------------------------------------------------- */
function gdBtn(cid, nid, label) {
  cid = cid && CH[cid] ? cid : (nid ? chartForNode(nid) : ''); if (!cid || !CH[cid]) return esc(label || nid || '');
  return '<button type="button" class="xbtn" data-chart="' + esc(cid) + '" data-chart-node="' + esc(nid || '') + '" title="Open this on the map">' + esc(label || (CH[cid].navLabel)) + ' ↗</button>';
}
function gdBoxBtn(id, label) { return gdBtn(chartForNode(id), id, label || gdTitle(id)); }
function gdDot(id) { var n = GD.M.box[id] && GD.M.box[id].n, k = kindOf(n); return '<i class="gd-dot" style="background:' + esc(catColor(k)) + '" title="' + esc(kindInfo(k).label) + '"></i>'; }
function gdMark(n) {                       // small marks for boxes that are off, test-only or on by default
  var s = n && n.status; if (s === 'off' || s === 'test-only' || s === 'default-on') return '<span class="gd-pill gd-mk' + (s === 'default-on' ? ' quiet' : '') + '" title="' + esc(STATUS_WORDS[s]) + (n.switch ? ' · switch ' + esc(n.switch) : '') + '">' + esc(STATUS_WORDS[s]) + '</span>';
  return '';
}
function gdBoxLine(id, o) {                // dot + title button + handle chip (+ status mark) + optional gist
  var b = GD.M.box[id]; if (!b) return esc(id); o = o || {}; var n = b.n, h = hOf(n);
  return '<span class="gd-bl">' + gdDot(id) + gdBoxBtn(id) + (h && findHandle(h) ? hchipBtn(h) : '') + gdMark(n) + (o.gist ? '<span class="gd-pt">' + gdText(gdTake(n.plain || n.summary, o.gist)) + '</span>' : '') + '</span>';
}
function gdRoad(r, fromSide) {             // "Condition → Target" (or "Source: Condition") for one route
  var m = GD.M, cond = r.when || 'Always', who = fromSide ? r.to : r.from;
  return '<span class="gd-rd' + (r.type === 'return' ? ' back' : '') + '">' + (r.type === 'return' ? '<span class="gd-ret" title="Loops back">↩</span> ' : '') +
    '<span class="gd-cond">' + gdText(cond) + '</span> <span class="gd-arrow">' + (fromSide ? '→' : '←') + '</span> ' + gdBoxBtn(who) + (r.inferred ? ' <span class="gd-pill quiet" title="No code path proves this road">inferred</span>' : '') + '</span>';
}
function gdRoadVia(r, fromSide) {          // the road with the box of THIS stage it touches named first ("Box: Condition → Target"), so two roads with the same words from different boxes do not read as one row twice
  return gdBoxBtn(fromSide ? r.from : r.to) + '<span class="quiet">: </span>' + gdRoad(r, fromSide);
}
function gdStageName(sid) { var s = GD.M.stageById[sid]; return s ? s.title : ''; }
function gdChain(ids, cap) {               // box titles in order joined by arrows, each a button
  var shown = cap && ids.length > cap ? ids.slice(0, cap) : ids;
  return '<span class="gd-chain">' + shown.map(function (id) { return gdBoxBtn(id); }).join(' <span class="gd-arrow">→</span> ') + (shown.length < ids.length ? gdMoreOpen(ids.length - shown.length, ids.slice(shown.length).map(function (id) { return gdBoxBtn(id); }).join(' <span class="gd-arrow">→</span> '), true) : '') + '</span>';
}
function gdMoreOpen(n, restHTML, inline) { return '<details class="fl-more' + (inline ? ' fl-inl' : '') + '"><summary>+' + n + ' more</summary>' + restHTML + '</details>'; }      // a "+N more" is a real control: it opens the rest
function gdList(items) { return items.length ? '<ul class="gd-list">' + items.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>' : ''; }
function gdStat(n, l, sm) { return '<div class="gd-stat"><b>' + esc(n) + '</b><span>' + esc(l) + '</span>' + (sm ? '<small>' + esc(sm) + '</small>' : '') + '</div>'; }
function gdKV(rows) {
  rows = rows.filter(function (r) { return r && r[1]; });
  return rows.length ? '<div class="gd-kv">' + rows.map(function (r) { return '<div class="gd-kr"><span class="gd-kl">' + esc(r[0]) + '</span><span class="gd-kd">' + r[1] + '</span></div>'; }).join('') + '</div>' : '';
}

/* ================================================================ narrative: stages in order, main path, loops, endings */
var GD_OUTCOME = { success: ['Success', 'ends well'], refusal: ['Refusal', 'turned away on purpose'], failure: ['Failure', 'ends badly'], neutral: ['Neutral', 'ends without a verdict'], '': ['Outcome not labelled', 'the model gives no outcome'] };
function gdKinds(ids) {
  var c = {}; ids.forEach(function (id) { var k = kindOf(GD.M.box[id].n); c[k] = (c[k] || 0) + 1; });
  var P = { external: ['outside party', 'outside parties'] };
  return Object.keys(c).map(function (k) { var w = P[k] || [kindInfo(k).label.toLowerCase(), kindInfo(k).label.toLowerCase() + 's']; return c[k] + ' ' + w[c[k] === 1 ? 0 : 1]; }).join(' · ');
}
function gdRoadBetween(a, b) { var o = GD.M.out[a] || []; for (var i = 0; i < o.length; i++) if (o[i].to === b) return o[i]; return null; }
function gdLitBtn(rid, label) {
  var w = GD.M.whole; if (!w || !(gdArr(w.regions).concat(gdArr(w.stages)).some(function (r) { return r && r.id === rid; }))) return '';
  return '<button type="button" class="xbtn" data-light="' + esc(w.id) + '|' + esc(rid) + '" title="Light it up on the whole-system map">' + esc(label || 'Light it up') + ' ↗</button>';
}
function gdNarOverview(M) {
  var CN = gdCounts(M), nr = CN.roads, name = M.sys.name || 'This system', h = '';
  h += '<p class="gd-body">' + gdText(M.sys.summary || (name + ' runs through ' + gdPlural(M.stages.length, 'stage') + ', ' + gdPlural(M.ids.length, 'box', 'boxes') + ' joined by ' + gdPlural(nr, 'road') + '.')) + '</p>';
  if (META.toolMap) h += '<p class="gd-lbl">What counts as success</p><p class="gd-body">' + esc(META.toolMap.successText) + '</p>';
  else if (M.sys.purpose) h += '<p class="gd-lbl">What counts as success</p><p class="gd-body">' + gdText(M.sys.purpose) + '</p>';
  h += '<div class="gd-stats">' + (META.toolMap ? gdToolStats(M) : gdStat(M.stages.length, 'stages', 'the main path runs through ' + (gdCounts(M).mainPath ? gdCounts(M).mainPath.stages : gdUniq(M.path.ids.map(function (id) { return M.stageOf[id]; })).length) + ' of them') + gdStat(CN.boxes, 'boxes', gdKinds(M.ids).split(' · ').slice(0, 3).join(' · '))) +
    (META.toolMap ? '' : gdStat(nr, 'roads', CN.roadsBack + ' go back upstream') + gdStat(CN.loops.total, 'loops', CN.loops.declared + ' declared + ' + CN.loops.workedOut + ' worked out from return roads; ' + CN.loops.noLimit + ' have no limit written on the map')) +
    (META.toolMap ? '' : gdStat(CN.ends.boxes, 'ending boxes', CN.ends.stop + ' stop here, ' + CN.ends.back + ' hand back to their caller')) + '</div>' +
    '<p class="gd-note quiet">' + gdNumLink('What these numbers count') + ' says how each one is counted and why it differs from the number next to it.</p>';
  if (M.stages.length) { var noOrder = META.toolMap && META.toolMap.stageOrder === false; h += '<p class="gd-lbl">' + (noOrder ? 'The stages (largest first, by functions; the map does not claim an order in which they run)' : 'The stages in order') + '</p><div class="mini-flow">' + M.stages.map(function (s) { return gdBtn(s.chart, s.boxes[0], s.title); }).join(noOrder ? ' ' : '<span aria-hidden="true">→</span>') + '</div>'; }
  var ent = gdUniq(gdArr(DATA.paths).map(function (p) { return gdArr(p.boxes)[0]; })).filter(function (id) { return M.box[id]; });
  if (!ent.length) ent = M.entries.filter(function (id) { return kindOf(M.box[id].n) !== 'store'; });
  if (ent.length) h += gdKV([[gdArr(DATA.paths).length ? 'Where it starts (the first box of each declared path)' : 'Where it starts', ent.slice(0, 4).map(function (id) { return gdBoxLine(id); }).join(' ') + (ent.length > 4 ? gdMoreOpen(ent.length - 4, ent.slice(4).map(function (id) { return gdBoxLine(id); }).join(' '), true) : '')]]);
  if (META.draft !== false) h += '<p class="notice">This map is a draft. What is not drawn yet is listed in <button type="button" class="hlink gd-tl" data-reading="scope">Evidence and scope</button>; read the guides as what the model says so far.</p>';
  return h;
}
function gdToolStats(M) {
  var T = META.toolMap, N = T.nums, E = T.endings, o = E.byOutcome;
  return gdStat(M.stages.length, 'stages', T.mainTile) + gdStat(N.boxes, 'boxes in the map', N.functions + ' functions in ' + N.files + ' files') + gdStat(N.roads, 'roads', N.roadsUnsure + ' calls may run any of several functions') + gdStat(N.loops, 'loops', 'written in the code') +
    gdStat(E.total, 'endings', (o.success || 0) + ' success · ' + (o.failure || 0) + ' failure · ' + (o.refusal || 0) + ' refusal · ' + (o.neutral || 0) + ' neutral');
}
function gdMainJourney(M) {
  var T = META.toolMap, P = T.mainPath;
  var h = '<p class="gd-body"><b>' + (P ? 'The main path is the journey \u201c' + esc(P.name) + '\u201d.' : 'No main path found.') + '</b> ' + esc(T.rule || '') + '</p>';
  if (!P) return h + '<p class="cross-links"><button type="button" class="xbtn" data-reader-view="journeys">The journeys the tool did find \u2197</button></p>';
  h += '<p class="gd-body">' + (P.why ? 'It is first because ' + esc(P.why) + '. ' : '') + 'It runs through ' + P.stages + ' of the ' + M.stages.length + ' stages. The short version, step by step:</p>';
  h += '<ol class="gd-steps">' + P.steps.map(function (x, i) { return '<li class="gd-step"><span class="gd-sn">' + (i + 1) + '</span><div class="gd-stp"><b>' + esc(x.t) + '</b></div></li>'; }).join('') + '</ol>';
  return h + '<p class="cross-links"><button type="button" class="xbtn" data-reader-walk="' + esc(P.id) + '">Walk it step by step \u2197</button> <button type="button" class="xbtn" data-reader-journey="' + esc(P.id) + '">Read the whole journey \u2197</button></p>';
}
function gdToolEndsIntro(M) {
  var T = META.toolMap, E = T.endings;
  return '<p class="gd-body"><b>' + E.total + ' endings in the code</b> (a place where a function returns or raises); <b>' + E.failing + '</b> of them fail or refuse, and <button type="button" class="hlink" data-reader-view="fails">How it fails</button> lists each with who hears about it. The ' + M.ends.length + ' ending boxes below are the ones drawn on the charts: a box can stand for several endings, and an exit that a decision folds into itself is drawn once for each decision.</p>';
}
function gdToolNumbers(M) {
  var T = META.toolMap, N = T.nums, E = T.endings, S = T.sw;
  var rows = [
    [N.functions, 'functions', 'The functions the tool read and drew boxes for (' + N.files + ' files).'],
    [N.boxes, 'boxes in the map', 'The steps, decisions, waits and endings the tool drew for the code. A chart draws more boxes than this: it adds a card for each call and a marker where a call was not followed.'],
    [N.roads, 'roads in the map', 'The ways the flow goes from one box to the next, and calls from one function to another.'],
    [E.total, 'endings', 'Places where a function returns or raises. One drawn ending box can stand for several of them.'],
    [E.failing, 'failing endings', 'The endings that fail or refuse (HTTP 400 or more, a raise, or a refusal-shaped name). All are listed in How it fails.'],
    [S.count, 'switches found', 'Options, settings, flags and environment variables that a decision tests. ' + S.off + ' are off by default; ' + S.line],
    [N.journeys, 'journeys', 'Runs from an outside start, followed through the calls they make.'],
    [N.stages, 'stages', 'Groups of directories, named after the folder or file that holds most of each.'],
    [N.loops, 'loops', 'Loops written in the code.'],
    [N.questions, 'questions about the code', N.questionsSure + ' the tool is sure of; the rest are not confident.']
  ];
  return '<p class="gd-body">Every total on the page comes from one record the reading wrote. A number with a different meaning has a different name.</p><div class="table-wrap"><table class="gd-tbl"><tbody>' + rows.map(function (r) { return gdNumRow(gdN1(r[0]), esc(r[1]), esc(r[2])); }).join('') + '</tbody></table></div>';
}
function gdToolMarks() {
  return '<p class="gd-body">Nothing here was run, so nothing is seen in a run. A solid box or road is one the tool is sure of. A dashed box with a ?, or a dashed road, is one it is not sure of; its Details panel says why. A sentence the code gives (a comment, a README line) is quoted with where it came from.</p>';
}
function gdNarPath(M) {
  if (META.toolMap) return gdMainJourney(M);
  var p = M.path, ids = p.ids, h = '';
  if (!ids.length) return META.toolMap ? '<p class="quiet"><b>No main path found.</b> The Reader lists the journeys the tool did find, each one a run from an outside trigger.</p>' : '<p class="quiet">No main path could be worked out: no box has a road to an ending.</p>';
  var stages = gdUniq(ids.map(function (id) { return M.stageOf[id]; })), MP = gdCounts(M).mainPath, steps = !p.derived && MP && MP.steps ? MP.steps : ids.length;
  h += '<p class="gd-body">' + (p.blurb ? gdText(p.blurb) + ' ' : '') + 'The happy path takes <b>' + gdPlural(steps, 'step') + '</b>' + (steps !== ids.length ? ' (' + ids.length + ' different boxes: calls come back, so a box can be passed more than once; each is listed once below)' : '') + ', across ' + gdPlural(stages.length, 'stage') + ' of the ' + M.stages.length + '. ' +
    (p.derived ? 'No main path is declared, so this is the longest shortest road from the start to a happy ending: treat it as a draft. ' : '') + 'Side roads are listed under each step.</p>';
  var last = null;
  h += '<ol class="gd-steps">' + ids.map(function (id, i) {
    var n = M.box[id].n, s = M.stageOf[id], br = '', r = i ? gdRoadBetween(ids[i - 1], id) : null;
    if (s !== last && M.stages.length > 1) { br = '<li class="gd-brk">' + (M.stageById[s] ? 'Stage ' + (M.stageById[s].i + 1) + ' · ' + esc(M.stageById[s].title) : '') + '</li>'; }
    last = s;
    var side = (M.out[id] || []).filter(function (x) { return x.to !== ids[i + 1]; });
    return br + '<li class="gd-step"><span class="gd-sn">' + (i + 1) + '</span><div class="gd-stp">' + gdBoxLine(id) + (r && r.when ? ' <span class="gd-cond" title="The condition on the road in">after: ' + esc(r.when) + '</span>' : '') +
      '<p class="gd-pt">' + gdText(gdTake(n.plain || n.summary, 100)) + '</p>' +
      (side.length ? '<div class="gd-side"><span class="gd-sl">Other roads</span>' + side.slice(0, 4).map(function (x) { return gdRoad(x, true); }).join('') + (side.length > 4 ? gdMoreOpen(side.length - 4, side.slice(4).map(function (x) { return gdRoad(x, true); }).join('')) : '') + '</div>' : '') + '</div></li>';
  }).join('') + '</ol>';
  return h + '<p class="cross-links"><button type="button" class="xbtn" data-walk="' + esc(MAIN_ID) + '">Walk it step by step ↗</button> ' + (M.whole ? '<button type="button" class="xbtn" data-gd-spine="' + esc(M.whole.id) + '">Show the main path on the whole-system map ↗</button>' : '') + '</p>';
}
function gdNarStage(M, s) {
  var set = {}; s.boxes.forEach(function (b) { set[b] = 1; });
  var inn = [], out = [];
  M.routes.forEach(function (r) { if (set[r.to] && !set[r.from]) inn.push(r); else if (set[r.from] && !set[r.to]) out.push(r); });
  var starts = s.boxes.filter(function (id) { return !(M.inn[id] || []).length || (M.inn[id] || []).every(function (r) { return !set[r.from]; }); });
  var onPath = M.path.ids.filter(function (id) { return set[id]; }), dec = s.boxes.filter(function (id) { var k = kindOf(M.box[id].n); return (k === 'decision' || k === 'gate') && (M.out[id] || []).length > 1; });
  var loops = M.loops.filter(function (l) { return l.boxes.filter(function (b) { return set[b]; }).length * 2 >= l.boxes.length; });
  var ends = s.boxes.filter(function (id) { return M.ends.indexOf(id) >= 0; }), offs = s.boxes.filter(function (id) { return M.offs.indexOf(id) >= 0; });
  var more = function (list, n, one, asList) { return list.length > n ? gdMoreOpen(list.length - n, asList ? gdList(list.slice(n).map(one)) : list.slice(n).map(one).join(' '), !asList) : ''; };
  var h = '<p class="gd-body">' + gdText(s.blurb || (s.title + ' holds ' + gdPlural(s.boxes.length, 'box', 'boxes') + '.')) + '</p>';
  h += gdKV([
    ['Boxes', esc(gdKinds(s.boxes)) || ''],
    ['Starts at', starts.slice(0, 3).map(function (id) { return gdBoxLine(id); }).join(' ') + more(starts, 3, function (id) { return gdBoxLine(id); })],
    ['Comes in from', gdList(inn.slice(0, 6).map(function (r) { return gdRoadVia(r, false) + ' <span class="quiet">' + esc(gdStageName(M.stageOf[r.from])) + '</span>'; })) + more(inn, 6, function (r) { return gdRoadVia(r, false) + ' <span class="quiet">' + esc(gdStageName(M.stageOf[r.from])) + '</span>'; }, true)],
    ['Goes out to', gdList(out.slice(0, 6).map(function (r) { return gdRoadVia(r, true) + ' <span class="quiet">' + esc(gdStageName(M.stageOf[r.to])) + '</span>'; })) + more(out, 6, function (r) { return gdRoadVia(r, true) + ' <span class="quiet">' + esc(gdStageName(M.stageOf[r.to])) + '</span>'; }, true)],
    ['On the main path', onPath.length ? gdChain(onPath, 8) : ''],
    ['Decisions', gdList(dec.slice(0, 6).map(function (id) { return gdBoxBtn(id) + '<span class="gd-side"><span class="gd-sl">Roads out</span>' + (M.out[id] || []).slice(0, 4).map(function (r) { return gdRoad(r, true); }).join('') + '</span>'; })) + more(dec, 6, function (id) { return gdBoxBtn(id) + '<span class="gd-side"><span class="gd-sl">Roads out</span>' + (M.out[id] || []).slice(0, 4).map(function (r) { return gdRoad(r, true); }).join('') + '</span>'; }, true)],
    ['Loops here', loops.map(function (l) { return '<span class="gd-bl">' + esc(l.title) + ' <span class="gd-pill' + (l.limit ? '' : ' warn') + '">' + (l.limit ? 'Limit: ' + esc(l.limit) : 'No limit shown') + '</span></span>'; }).join(' ')],
    ['Endings', ends.map(function (id) { return gdBoxLine(id) + ' <span class="gd-pill quiet">' + esc((GD_OUTCOME[M.box[id].n.outcome || ''] || GD_OUTCOME['']) [0]) + '</span>'; }).join(' ')],
    ['Behind a switch or test only', offs.slice(0, 5).map(function (id) { return gdBoxLine(id); }).join(' ') + more(offs, 5, function (id) { return gdBoxLine(id); })]
  ]);
  h += '<details class="gd-sub"><summary>All ' + gdPlural(s.boxes.length, 'box', 'boxes') + ' in this stage</summary><ul class="gd-list">' + s.boxes.map(function (id) { return '<li>' + gdBoxLine(id, { gist: 110 }) + '</li>'; }).join('') + '</ul></details>';
  h += '<p class="cross-links">' + (s.chart ? gdBtn(s.chart, s.boxes[0], 'Open the ' + s.title + ' chart') : '') + gdLitBtn(s.id, 'Light up ' + s.title) + '</p>';
  return h;
}
function gdNarLoops(M) {
  if (!M.loops.length) return '<p class="gd-body quiet">No loop is declared and no return road is drawn on this map.</p>';
  var more = function (list, n, one, asList) { return list.length > n ? gdMoreOpen(list.length - n, asList ? gdList(list.slice(n).map(one)) : list.slice(n).map(one).join(' '), !asList) : ''; };
  var CN = gdCounts(M), L = CN.loops;
  return '<p class="gd-body">A loop is where work can come round again. Each one says what bounds it; &ldquo;No limit shown&rdquo; means nothing written on the map stops it, not that it is unbounded.</p>' +
    '<p class="gd-body"><b>' + L.total + ' loops</b>: ' + L.declared + ' declared by the map&rsquo;s author and ' + L.workedOut + ' worked out from return roads that no declared loop holds. <b>' + L.noLimit + ' have no limit written on the map</b> (' + L.noLimitDeclared + ' declared, ' + L.noLimitWorkedOut + ' worked out).' +
    (L.raised != null ? ' <b>' + L.raised + ' were raised as questions</b> in <a class="hlink" href="#reading=breaks">Where it can break</a>: ' + L.raisedNoLimit + ' declared loops with no limit' + (L.raisedDisputed ? ', and ' + L.raisedDisputed + ' declared loops whose written limit the code seems to contradict' : '') + (L.raisedCycle ? ', and ' + L.raisedCycle + ' cycle' + (L.raisedCycle === 1 ? '' : 's') + ' of roads that no loop lists' : '') + '. The ' + L.noLimitWorkedOut + ' worked-out loops are not checked: they have no limit field to read, so they are listed here and nowhere else.' : '') + ' ' + gdNumLink('What these numbers count') + '.</p>' +
    M.loops.map(function (l) {
      var rd = gdLoopRoads(M, l);
      return '<div class="gd-lp"><div class="gd-lp1"><b>' + esc(l.title) + '</b><span class="gd-pill' + (l.limit ? '' : ' warn') + '">' + (l.limit ? 'Limit: ' + esc(l.limit) : 'No limit shown') + '</span>' + (l.derived ? '<span class="gd-pill quiet" title="Worked out from a return road; the map does not declare it">from a return road</span>' : '') + '</div>' +
        (l.blurb ? '<p class="gd-body">' + gdText(l.blurb) + '</p>' : '') + '<p>' + gdChain(l.boxes, 8) + '</p>' +
        gdKV([['Enters from', gdList(rd.inn.slice(0, 3).map(function (r) { return gdRoad(r, false); })) + more(rd.inn, 3, function (r) { return gdRoad(r, false); }, true)], ['Comes round again when', gdList(rd.back.slice(0, 3).map(function (r) { return gdRoad(r, true); }))],
          ['Leaves when', gdList(rd.out.slice(0, 4).map(function (r) { return gdRoad(r, true); })) + more(rd.out, 4, function (r) { return gdRoad(r, true); }, true)]]) +
        '<p class="cross-links">' + gdLitBtn(l.id, 'Light up this loop') + '</p></div>';
    }).join('');
}
function gdByStage(ids, M, rowFn) {           // box ids grouped by stage in stage order: [<div class="bk-grp">...] (the same look as Where it can break)
  var by = {}, ord = [];
  ids.forEach(function (id) { var st = M.stageOf[id] || '_'; if (!by[st]) { by[st] = []; ord.push(st); } by[st].push(id); });
  var idx = function (st) { var i = M.stages.findIndex(function (x) { return x.id === st; }); return i < 0 ? 999 : i; };
  ord.sort(function (a, b) { return idx(a) - idx(b); });
  return ord.map(function (st) {
    var S = M.stageById[st];
    return '<div class="bk-grp"><h4 class="bk-gh"' + (S ? ' style="--sh:' + (stageHue(st) == null ? 200 : stageHue(st)) + '"' : '') + '><i></i>' + (S ? (stageNo(st) ? stageNo(st) + ' · ' : '') + esc(S.title) : 'Elsewhere') + '<span class="bk-gn">' + by[st].length + '</span></h4>' + by[st].map(rowFn).join('') + '</div>';
  }).join('');
}
function gdEndCodeSentence(E) {              // what the code reader counts, and why there are more ending boxes than code endings: verified from the census, the ledger and the facts, never guessed
  var s = 'The code reader lists <b>' + gdN1(E.census) + ' endings in the code</b>' + (E.statements ? ' (of the ' + gdN1(E.statements) + ' return and raise statements it read, it kept the ones it was confident end something)' : '') + '. ' +
    gdN1(E.censusOnEnds) + ' of them are drawn as ending boxes (' + gdN1(E.boxesWithRow) + ' boxes, some taking several rows); the other ' + gdN1(E.censusElsewhere) + ' are accounted for by a step, a decision or a road. ' +
    'The other <b>' + gdN1(E.boxesWithoutRow) + ' ending boxes have no code row</b>: they were drawn from reading the code' + (E.returnOrRaise != null ? ' (' + gdN1(E.returnOrRaise) + ' cite a return or raise the reader did not count as an ending, ' + gdN1(E.other) + ' cite a line that is neither)' : '') + '.';
  return s;
}
function gdNarEnds(M) {
  if (!M.ends.length) return '<p class="gd-body quiet">No ending box is drawn yet.</p>';
  var by = {}; M.ends.forEach(function (id) { var o = M.box[id].n.outcome || ''; (by[o] = by[o] || []).push(id); });
  var order = ['success', 'refusal', 'failure', 'neutral', ''].filter(function (o) { return by[o]; }).concat(Object.keys(by).filter(function (o) { return ['success', 'refusal', 'failure', 'neutral', ''].indexOf(o) < 0; }));
  var row = function (id) {
    var inn = M.inn[id] || [];
    var hd = heardOf(M.box[id].n), hbit = hd ? ' <span class="gd-pill quiet" title="' + esc(capFirst(HEARD[hd.by] || hd.by) + (hd.how ? ': ' + hd.how : '')) + '">' + esc(HEARD_SHORT[hd.by] || hd.by) + '</span>' : needsHeard(M.box[id].n) ? ' <span class="gd-pill quiet">Who hears: ' + UNSAID + '</span>' : '';
    return '<div class="gd-unit en-row" data-out="' + esc(M.box[id].n.outcome || '') + '" data-end="' + (M.box[id].n.ending === 'back' ? 'back' : 'stop') + '">' + gdBoxLine(id, { gist: 110 }) + '<span class="gd-pill quiet">' + (M.box[id].n.ending === 'back' ? 'Hands back' : 'Stops here') + '</span>' + hbit + (inn.length ? '<span class="gd-side"><span class="gd-sl">Reached when</span>' + inn.slice(0, 3).map(function (r) { return gdRoad(r, false); }).join('') + (inn.length > 3 ? gdMoreOpen(inn.length - 3, inn.slice(3).map(function (r) { return gdRoad(r, false); }).join('')) : '') + '</span>' : '') + '</div>';
  };
  var CN = gdCounts(M), E = CN.ends;
  var nBack = M.ends.filter(function (id) { return M.box[id].n.ending === 'back'; }).length;
  var chipsEnd = '<div class="bk-chips en-chips" role="group" aria-label="Filter the endings by whether they stop or hand back"><span class="en-chips-l">Does it stop</span><button type="button" class="bk-chip on" data-en-end="*">All <b>' + M.ends.length + '</b></button><button type="button" class="bk-chip" data-en-end="stop">Stops here <b>' + (M.ends.length - nBack) + '</b></button><button type="button" class="bk-chip" data-en-end="back">Hands back <b>' + nBack + '</b></button></div>';
  var chips = '<div class="bk-chips en-chips" role="group" aria-label="Filter the endings by outcome"><button type="button" class="bk-chip on" data-en-out="*">All <b>' + M.ends.length + '</b></button>' + order.map(function (o) { return '<button type="button" class="bk-chip" data-en-out="' + esc(o) + '">' + esc((GD_OUTCOME[o] || [gdCap(o)])[0]) + ' <b>' + by[o].length + '</b></button>'; }).join('') + '</div>';
  if (META.toolMap) return gdToolEndsIntro(M) + chips + order.map(function (o) { var lab = GD_OUTCOME[o] || [gdCap(o), '']; return '<div class="en-out" data-out="' + esc(o) + '"><p class="gd-lbl">' + esc(lab[0]) + ' \u00b7 ' + by[o].length + (lab[1] ? ' <span class="quiet">' + esc(lab[1]) + '</span>' : '') + '</p>' + gdByStage(by[o], M, row) + '</div>'; }).join('');
  return '<p class="gd-body"><b>Who hears about the failures and refusals</b> is on its own page: <button type="button" class="hlink" data-reading-go="fails">How it fails</button>.</p><p class="gd-body"><b>' + E.boxes + ' ending boxes</b>: <b>' + E.stop + ' stop here</b> (no road leaves them: the path ends) and <b>' + E.back + ' hand back to their caller</b> (a road leaves them, so the flow goes on after them; the main path can run through one). Each is listed with the conditions on the roads that lead there.</p>' +
    (E.census != null ? '<p class="gd-body">' + gdEndCodeSentence(E) + ' ' + gdNumLink() + '.</p>' : '') + chips + chipsEnd +
    order.map(function (o) {
      var lab = GD_OUTCOME[o] || [gdCap(o), ''];
      return '<div class="en-out" data-out="' + esc(o) + '"><p class="gd-lbl">' + esc(lab[0]) + ' · ' + by[o].length + (lab[1] ? ' <span class="quiet">' + esc(lab[1]) + '</span>' : '') + '</p>' + gdByStage(by[o], M, row) + '</div>';
    }).join('');
}
function gdNarrative() {
  var M = gdModel(), secs = [];
  secs.push({ id: 'overview', title: 'The system in one page', take: gdTake(M.sys.summary, 40) || gdPlural(gdCounts(M).stages, 'stage') + ', ' + gdPlural(gdCounts(M).boxes, 'box', 'boxes') + ', ' + gdPlural(gdCounts(M).ends.boxes, 'ending box', 'ending boxes') + '.', html: gdNarOverview(M) });
  secs.push({ id: 'path', title: META.toolMap ? 'Main path' : M.path.title || 'Main path', count: META.toolMap ? (META.toolMap.mainPath ? META.toolMap.mainPath.steps.length : 0) : (!M.path.derived && gdCounts(M).mainPath && gdCounts(M).mainPath.steps) || M.path.ids.length, take: META.toolMap ? (META.toolMap.mainPath ? META.toolMap.mainPath.name : 'No main path found.') : M.path.ids.length ? gdTitle(M.path.ids[0]) + ' to ' + gdTitle(M.path.ids[M.path.ids.length - 1]) + ', step by step, with the side roads.' : 'No main path yet.', html: gdNarPath(M) });
  M.stages.forEach(function (s) {
    secs.push({ id: 'stage-' + gdSlug(s.id), title: s.title, num: s.i + 1, count: META.toolMap && META.toolMap.stageNames[s.id] ? META.toolMap.stageNames[s.id].boxes : s.boxes.length, take: gdTake(s.blurb, 40) || gdKinds(s.boxes), chips: gdChips(gdUniq(s.boxes.map(function (id) { return hOf(M.box[id].n); })), 3, false), html: gdNarStage(M, s) });
  });
  secs.push({ id: 'loops', title: 'Loops and retries', count: gdCounts(M).loops.total, take: M.loops.length ? M.loops.map(function (l) { return l.title; }).join(' · ') : 'None drawn.', html: gdNarLoops(M) });
  secs.push({ id: 'endings', title: 'Endings', count: META.toolMap ? META.toolMap.endings.total : gdCounts(M).ends.boxes, take: M.ends.length ? gdUniq(M.ends.map(function (id) { return (GD_OUTCOME[M.box[id].n.outcome || ''] || [''])[0]; })).join(' · ') : 'None drawn.', html: gdNarEnds(M) });
  return { id: 'narrative', eyebrow: 'Read it like a story', title: 'The narrative', tldr: M.sys.tagline || gdTake(M.sys.summary, 80) || 'The stages in order, the main path through them, where work loops, and every way it can end.', secs: secs };
}

/* ================================================================ glossary: the system's own names, and where each engages */
function gdHas(hay, low, tag) {            // whole-word search; exact case for code-like names, any case for plain words
  var cs = /[_0-9.\/]/.test(tag) || (tag === tag.toUpperCase() && /[A-Z]/.test(tag)), s = cs ? hay : low, t = cs ? tag : tag.toLowerCase(), i = s.indexOf(t), re = /[a-z0-9_]/i;
  while (i >= 0) { if (!re.test(s.charAt(i - 1)) && !re.test(s.charAt(i + t.length))) return true; i = s.indexOf(t, i + 1); }
  return false;
}
function gdFlow(M) {                       // box id -> position in reading order (stages in order, boxes in model order)
  if (M.flow) return M.flow; M.flow = {}; var i = 0;
  M.stages.forEach(function (s) { s.boxes.forEach(function (id) { M.flow[id] = i++; }); });
  return M.flow;
}
function gdGlossModel() {
  var M = gdModel(), H = handles(), flow = gdFlow(M), ents = [], hay = {};
  M.ids.forEach(function (id) { var n = M.box[id].n, t = [n.title, n.plain, n.why, n.failure].concat(gdArr(n.inputs), gdArr(n.outputs)).join(' \n '); hay[id] = [t, t.toLowerCase()]; });
  Object.keys(H).forEach(function (tag, ti) {
    var h = H[tag], info = h.info || {}, seen = {}, carriers = [], min = 1e9;
    h.refs.forEach(function (r) {
      if (seen[r.node]) { if (r.primary) seen[r.node].primary = true; return; }
      var c = { id: r.node, primary: r.primary, chart: r.chart, inModel: !!M.box[r.node] }; seen[r.node] = c; carriers.push(c);
      if (flow[r.node] != null && flow[r.node] < min) min = flow[r.node];
    });
    carriers.sort(function (a, b) { return (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || (flow[a.id] == null ? 1e9 : flow[a.id]) - (flow[b.id] == null ? 1e9 : flow[b.id]); });
    var mentions = [];
    if (tag.length >= 3) M.ids.forEach(function (id) { if (!seen[id] && gdHas(hay[id][0], hay[id][1], tag)) mentions.push(id); });
    var first = carriers.length && M.box[carriers[0].id] ? M.stageOf[carriers[0].id] : '';
    ents.push({ tag: tag, h: h, info: info, name: handleName(tag), meaning: gdS(info.meaning), family: gdS(info.family), aliases: aliasesOf(tag), refs: gdArr(info.refs), carriers: carriers, mentions: mentions, min: min, ti: ti, stage: first });
  });
  ents.sort(function (a, b) { return a.min - b.min || a.ti - b.ti; });
  var groups = [], by = {};
  ents.forEach(function (e) {
    var key = e.family ? 'f:' + e.family : e.stage && M.stageById[e.stage] ? 's:' + e.stage : 'o', g = by[key];
    if (!g) { g = by[key] = { id: gdSlug(key), title: e.family ? e.family : e.stage && M.stageById[e.stage] ? 'Named in ' + M.stageById[e.stage].title : 'Other names', items: [] }; groups.push(g); }
    g.items.push(e);
  });
  if (groups.length > 7) {                 // many tiny groups read worse than one: fold the small ones together
    var big = groups.filter(function (g) { return g.items.length >= 3; }), small = groups.filter(function (g) { return g.items.length < 3; });
    if (small.length > 1) { var m = { id: 'more-names', title: 'More names', items: [] }; small.forEach(function (g) { m.items = m.items.concat(g.items); }); groups = big.concat([m]); }
  }
  return groups;
}
function gdCard(e) {
  var tag = e.tag, M = gdModel(), nC = e.carriers.length, stages = gdUniq(e.carriers.map(function (c) { return M.stageOf[c.id]; })).length;
  var first = nC && M.box[e.carriers[0].id] ? M.box[e.carriers[0].id].n : null, mean = e.meaning || (first && first.plain) || '';
  var foot = nC ? '<span class="gd-cf-i"><b>' + nC + '</b> ' + (nC === 1 ? 'box' : 'boxes') + (stages > 1 ? ' · <b>' + stages + '</b> stages' : '') + '</span>' : '<span class="gd-cf-i quiet">no box carries this name</span>';
  var s = '<details class="gd-card gd-unit fam-' + famClass(famOf(tag)) + '" data-term="' + esc(tag) + '" id="gd-t-' + esc(gdSlug(tag)) + '"><summary><div class="gd-csum">' +
    '<span class="gd-ch1">' + hchip(tag) + (e.name ? '<b class="gd-cn">' + esc(e.name) + '</b>' : '') + '</span>' +
    '<span class="gd-cm">' + esc(mean || 'Named by a chart; no definition recorded yet.') + '</span><span class="gd-cf">' + foot + (e.family ? '<span class="gd-pill quiet">' + esc(e.family) + '</span>' : '') + '<span class="gd-more" aria-hidden="true">details</span></span></div></summary><div class="gd-ci"><div class="gd-ci-l">';
  s += '<p class="gd-lbl">' + (e.meaning ? 'In plain words' : 'As the box says it') + '</p><p>' + gdText(mean || 'No definition is recorded for this name yet.') + '</p>';
  if (e.aliases.length) s += '<p class="gd-io"><b>Also called</b> ' + esc(e.aliases.join(', ')) + '</p>';
  if (first && first.why && e.meaning) s += '<p class="gd-io"><b>Why the box exists</b> ' + gdText(first.why) + '</p>';
  if (e.refs.length) s += '<details class="gd-sub"><summary>Defined in source</summary><ul class="gd-refs">' + e.refs.slice(0, 8).map(function (r) {
    var t = typeof r === 'string' ? r : (r.symbol || r.path || '') + (r.line ? ':' + r.line : ''); return '<li><code>' + esc(t) + '</code></li>'; }).join('') + '</ul></details>';
  s += '</div><div class="gd-ci-r">';
  if (nC) {
    s += '<p class="gd-lbl">Carried by</p><div class="gd-eng">' + e.carriers.slice(0, 12).map(function (c) {
      var b = M.box[c.id], t = b ? b.n.title : ((CH[c.chart] && CH[c.chart].nodes[c.id]) || {}).title || c.id, st = b ? gdStageName(M.stageOf[c.id]) : '';
      return '<button type="button" class="gd-chbtn" data-chart="' + esc(chartForNode(c.id) || c.chart) + '" data-chart-node="' + esc(c.id) + '" title="' + esc(c.primary ? 'Open this box' : 'Open this box: it also touches ' + tag) + '">' + esc(t) + (st ? '<i>' + esc(st) + '</i>' : '') + (c.primary ? '' : '<i>also</i>') + '</button>'; }).join('') + '</div>' +
      (nC > 12 ? gdMoreOpen(nC - 12, '<div class="gd-eng">' + e.carriers.slice(12).map(function (c) { var b = M.box[c.id], t = b ? b.n.title : ((CH[c.chart] && CH[c.chart].nodes[c.id]) || {}).title || c.id; return '<button type="button" class="gd-chbtn" data-chart="' + esc(chartForNode(c.id) || c.chart) + '" data-chart-node="' + esc(c.id) + '">' + esc(t) + '</button>'; }).join('') + '</div>') : '');
  } else s += '<p class="gd-lbl">Carried by</p><p class="quiet">No box carries this name yet.</p>';
  if (e.mentions.length) s += '<p class="gd-lbl">Mentioned in the text of</p><div class="gd-eng">' + e.mentions.slice(0, 6).map(function (id) { return '<button type="button" class="gd-chbtn" data-chart="' + esc(chartForNode(id)) + '" data-chart-node="' + esc(id) + '">' + esc(gdTitle(id)) + '<i>' + esc(gdStageName(M.stageOf[id])) + '</i></button>'; }).join('') + '</div>' + (e.mentions.length > 6 ? gdMoreOpen(e.mentions.length - 6, '<div class="gd-eng">' + e.mentions.slice(6).map(function (id) { return '<button type="button" class="gd-chbtn" data-chart="' + esc(chartForNode(id)) + '" data-chart-node="' + esc(id) + '">' + esc(gdTitle(id)) + '<i>' + esc(gdStageName(M.stageOf[id])) + '</i></button>'; }).join('') + '</div>') : '');
  if (nC) s += '<p><button type="button" class="gd-act" data-engage="' + esc(tag) + '">Where ' + esc(tag) + ' engages ↗</button></p>';
  return s + '</div></div></details>';
}
var GD_TERMS = null;
function gdTermKeys() { if (!GD_TERMS) { GD_TERMS = {}; gdArr(DATA.terms).forEach(function (t) { var k = t && (t.term || t.name); if (k) GD_TERMS[k] = 1; }); } return GD_TERMS; }
function gdGlossary() {                      // the model's own terms first (this system's words), the code handles after them in a closed section
  var M = gdModel(), groups = gdGlossModel(), n = 0, carried = 0, secs = [], T = gdTermKeys(), terms = [], codes = [];
  groups.forEach(function (g) { g.items.forEach(function (e) { n++; if (e.carriers.length) carried++; (T[e.tag] ? terms : codes).push(e); }); });
  terms.sort(function (a, b) { return a.min - b.min || a.ti - b.ti; });
  if (terms.length) secs.push({ id: 'words', title: 'This system’s words', count: terms.length, take: terms.slice(0, 5).map(function (e) { return e.tag; }).join(' · ') + (terms.length > 5 ? ' …' : ''), chips: gdChips(terms.map(function (e) { return e.tag; }), 3, false), html: '<p class="gd-body">The words this map itself defines, in the order the system meets them. A stage or part name that holds one of them shows its meaning in the details panel.</p><div class="gd-grid">' + terms.map(gdCard).join('') + '</div>' });
  if (codes.length) {
    var by = {}, ord = []; groups.forEach(function (g) { var its = g.items.filter(function (e) { return !T[e.tag]; }); if (its.length) { ord.push(g.title); by[g.title] = (by[g.title] || []).concat(its); } });
    secs.push({ id: 'handles', title: terms.length ? 'Code handles' : 'Names in the code', count: codes.length, closed: !!terms.length, take: terms.length ? 'The names the code carries on its boxes (functions, options, switches), with the boxes that carry them. Closed: the words above come first.' : codes.slice(0, 4).map(function (e) { return e.tag; }).join(' · ') + (codes.length > 4 ? ' …' : ''),
      chips: gdChips(codes.map(function (e) { return e.tag; }), 3, false), html: ord.map(function (t) { return '<h4 class="bk-gh gl-gh">' + esc(t) + '<span class="bk-gn">' + by[t].length + '</span></h4><div class="gd-grid">' + by[t].map(gdCard).join('') + '</div>'; }).join('') });
  }
  if (!secs.length) secs.push({ id: 'none', title: 'No names yet', take: 'The map lists no terms and no box carries a handle.', html: '<p class="gd-body quiet">Add <code>terms</code> to the model, or give a box a <code>handle</code>, and they will be listed here with the boxes that carry them.</p>' });
  return { id: 'glossary', eyebrow: 'The system’s own words', title: 'Glossary', units: 'cards',
    tldr: n ? (terms.length ? gdPlural(terms.length, 'word') + ' the map defines, then ' + gdPlural(codes.length, 'code handle') + '. ' + carried + ' of the ' + n + ' names are carried by at least one box' : gdPlural(n, 'name') + ', ' + carried + ' of them carried by at least one box') + '. Plain words explain; official names say where in the system to look. Terms are listed in the order the system meets them.' : 'The words this system uses for its own parts.', secs: secs };
}

/* ================================================================ evidence and scope */
var GD_LEVELS = [
  ['drawn', 'Drawn', 'Normal, slightly muted.', 'The map says this box is here and the code it cites exists.', 'That it ever ran, or that it works.'],
  ['suspected', 'Suspected', 'Dashed amber with a question mark.', 'A check found a shape worth a question: a candidate, not a verdict.', 'That anything is wrong. Each candidate says what would make it a false alarm.'],
  ['seen', 'Seen', 'Solid, with a count.', 'A recorded run, test or coverage run reached this box; the count says how often.', 'That the other roads behave, or that it happens outside the recorded runs.'],
  ['proved', 'Proved', 'Double outline with a lock.', 'A replayable walk, or a search that finished inside its model, shows it.', 'Anything outside the model or the inputs that were checked.']
];
var GD_WALKS = [
  ['NONE', 'Nothing explored.', 'Nothing. The box stays drawn.'],
  ['SAMPLED', 'Some starting states were tried.', '“Not found in what was checked.”'],
  ['BOUNDED_INCOMPLETE', 'A search ran out of budget with places left open.', '“Not found in what was checked”, plus the open places.'],
  ['EXHAUSTIVE_WITHIN_MODEL', 'Every state in the model was explored.', 'With the known-answer controls passed, and only then: “no violation found” inside the model.']
];
var GD_STRENGTH = [['observed', 'Seen in a run or test.'], ['replayable', 'A saved witness repeats it.'], ['proved-in-model', 'A search of the model shows it.'], ['claimed', 'A source says so; nothing here checks it.']];
function gdOverlay() {
  var o = DATA.evidence || META.evidence || DATA.overlay || META.overlay; if (o) return o;
  for (var i = 0; i < ORDER.length; i++) if (CH[ORDER[i]] && CH[ORDER[i]].evidence) return CH[ORDER[i]].evidence;
  return null;
}
function gdFindings() {
  var ov = gdOverlay(), L = gdArr(DATA.findings).length ? DATA.findings : gdArr(META.findings).length ? META.findings : gdArr(ov && ov.findings).length ? ov.findings : gdArr(ov && ov.candidates);
  if (L.length) return L;
  var seen = {}; ORDER.forEach(function (id) { gdArr(CH[id] && CH[id].findings).forEach(function (x) { var k = x.key || JSON.stringify(x); if (!seen[k]) { seen[k] = 1; L = L.concat([x]); } }); });
  return L;
}
function gdNotDrawn() {                    // the overlay's list wins, as in the evidence layer; else the meta list the draft strip uses
  var ov = gdOverlay(), nd = ov && ov.notDrawn; if (nd == null) return notDrawnInfo();
  var items = Array.isArray(nd) ? nd : gdArr(nd.items || nd.modules), count = typeof nd === 'number' ? nd : gdN(nd.count != null ? nd.count : nd.total);
  return { count: count != null ? count : items.length, items: items, note: (nd && (nd.summary || nd.note)) || '' };
}
function gdMeters(rows) {
  return '<div class="gd-meters">' + rows.map(function (r) {
    var pct = r.done != null && r.total ? Math.min(100, Math.round(100 * r.done / r.total)) : (r.pct != null ? r.pct : null);
    return '<div class="gd-meter"><span class="gd-ml">' + esc(r.label) + '</span><span class="gd-mn">' + (r.done != null ? r.done + ' of ' + r.total : r.total) + '</span>' + (pct != null ? '<span class="gd-mb" role="img" aria-label="' + pct + ' percent"><i style="width:' + pct + '%"></i></span>' : '<span class="gd-mb"></span>') + '</div>';
  }).join('') + '</div>';
}
function gdScopeCensus(M) {
  var rows = censusRows(META.census), draft = META.draft !== false, text = META.census && typeof META.census === 'object' && (META.census.summary || META.census.text) || (typeof META.census === 'string' ? META.census : ''), h = '';
  h += '<p class="gd-body"><span class="gd-pill ' + (draft ? 'warn' : 'ok') + '">' + (draft ? 'Draft' : 'Fully drawn') + '</span> ' + (draft ?
    'This map is a draft. It says plainly what is not drawn yet, so a thin map is never mistaken for a finished one. It becomes finished when every ending, decision branch, loop and module is accounted for.' :
    'This map is fully drawn: every ending, decision branch, loop and module is accounted for by a box, a road, a merge or a written exclusion. That is about the DRAWING, not about the system: nothing here is verified unless a run is loaded.') + '</p>';
  if (text) h += '<p class="gd-body">' + esc(text) + '</p>';
  if (rows.length) h += '<p class="gd-lbl">Census · what a plain read of the code found, and how much is accounted for</p>' + gdMeters(rows) +
    '<p class="gd-note quiet">The census is a floor taken from the code, never from logs or traces. “Accounted for” means a box or road carries it, it is merged into one, or it is excluded with a reason.</p>';
  else h += '<p class="gd-body quiet">This atlas carries no census. The numbers below are counted from the map itself.</p>';
  if (META.pin) h += gdKV([['Source pinned at', '<code>' + esc(META.pin) + '</code>']]);
  return h;
}
function gdScopeCoverage(M) {
  var files = {}, nref = 0, CN = gdCounts(M); M.ids.forEach(function (id) { gdArr(M.box[id].n.refs).forEach(function (r) { if (r && r.path) { files[r.path] = 1; nref++; } }); });
  var inf = CN.roadsInferred, max = 1; M.stages.forEach(function (s) { if (s.boxes.length > max) max = s.boxes.length; });
  var h = '<div class="gd-stats">' + gdStat(CN.boxes, 'boxes drawn', CN.stages + ' stages') + gdStat(Object.keys(files).length, 'source files cited', nref + ' citations') +
    gdStat(CN.roads, 'roads drawn', inf + ' inferred, ' + (CN.roads - inf) + ' with a code path') + gdStat(M.offs.length, 'off, test-only or on by default', 'see the next sections') + '</div>';
  h += '<p class="gd-lbl">Boxes per stage</p>' + gdMeters(M.stages.map(function (s) { return { label: s.title, total: s.boxes.length, pct: Math.round(100 * s.boxes.length / max) }; }));
  return h + '<p class="gd-note quiet">Drawn means “has a box”, not “is understood”. A stage with few boxes may be thin or may be small: compare it with the census above.</p>';
}
function gdScopeNotDrawn(M) {
  var nd = gdNotDrawn(), h = '';
  if (nd.count == null) return '<p class="gd-body quiet">This atlas does not list what is not drawn. Run <code>faultline status</code> for the current gaps.</p>';
  if (!nd.count) return '<p class="gd-body">Nothing is listed as not drawn: every module is cited by a box or excluded with a reason.</p>';
  h += '<p class="gd-body">' + gdPlural(nd.count, 'part') + ' of the code ' + (nd.count === 1 ? 'has' : 'have') + ' no box yet. They are a list, not a hole in the map: nothing here says they are unimportant.' + (nd.note ? ' ' + esc(nd.note) : '') + '</p>';
  if (nd.items.length) h += '<ul class="gd-list">' + nd.items.map(function (it) {
    if (typeof it === 'string') return '<li><code>' + esc(it) + '</code></li>';
    var nm = it.path || it.module || it.title || it.id || it.name || '', why = it.why || it.reason || it.note || ''; return '<li><code>' + esc(nm) + '</code>' + (why ? ' <span class="quiet">' + esc(why) + '</span>' : '') + '</li>'; }).join('') + '</ul>' +
    '';
  return h;
}
function gdSwitchRows(M, ids) {               // boxes grouped by the switch that governs them, biggest group first
  var by = {}, ord = [];
  ids.forEach(function (id) { var n = M.box[id].n, k = n.switch || ''; if (!by[k]) { by[k] = { sw: k, ids: [], stages: [], test: 0 }; ord.push(k); } var g = by[k]; g.ids.push(id); if (n.status === 'test-only') g.test++; var st = M.stageOf[id]; if (st && g.stages.indexOf(st) < 0) g.stages.push(st); });
  return ord.map(function (k) { return by[k]; }).sort(function (a, b) { return (a.sw ? 0 : 1) - (b.sw ? 0 : 1) || b.ids.length - a.ids.length; });
}
function gdSwitchTable(M, rows, how) {
  var terms = LAY;
  return '<div class="table-wrap"><table class="gd-tbl"><thead><tr><th>Switch</th><th>Boxes</th><th>' + how + '</th><th>Stages</th></tr></thead><tbody>' + rows.map(function (g) {
    var t = g.sw && terms[g.sw], mean = t && t.meaning ? gdTake(t.meaning, 70) : '';
    var name = g.sw ? '<code>' + esc(g.sw) + '</code>' : '<span class="quiet">' + (g.test === g.ids.length ? 'No switch: only a test reaches these' : 'No switch named') + '</span>';
    return '<tr><td>' + name + '</td><td class="gd-num2">' + g.ids.length + '</td><td>' + (mean ? esc(mean) : g.sw ? '<span class="quiet">The map does not say what turns <code>' + esc(g.sw) + '</code> on.</span>' : '<span class="quiet">' + (g.test === g.ids.length ? 'Only a test reaches these.' : 'The map names no switch for these.') + '</span>') + '</td><td>' + g.stages.slice(0, 3).map(function (st) { return esc(gdStageName(st)); }).join(', ') + (g.stages.length > 3 ? ' +' + (g.stages.length - 3) : '') + '</td></tr>' +
      '<tr class="gd-sub-row"><td colspan="4"><details><summary>The ' + g.ids.length + ' box' + (g.ids.length === 1 ? '' : 'es') + '</summary><div class="chips" style="margin-top:6px">' + g.ids.map(function (id) { return gdBoxBtn(id); }).join(' ') + '</div></details></td></tr>';
  }).join('') + '</tbody></table></div>';
}
function gdScopeOff(M) {
  var off = M.ids.filter(function (id) { var s = M.box[id].n.status; return s === 'off' || s === 'test-only'; }), on = M.ids.filter(function (id) { return M.box[id].n.status === 'default-on'; });
  if (!off.length && !on.length) return '<p class="gd-body quiet">No box is marked off by default, on by default or test-only.</p>';
  var nTest = off.filter(function (id) { return M.box[id].n.status === 'test-only'; }).length;
  var h = '<p class="gd-body">These <b>' + off.length + '</b> boxes are off until something turns them on (' + (off.length - nTest) + '), or only a test reaches them (' + nTest + '). They are drawn dimmer. The map shows what would happen if they were on; it does not say they have ever run.' + (M.whole ? ' <button type="button" class="xbtn" data-gd-off="' + esc(M.whole.id) + '">Tint them on the whole map ↗</button>' : '') + '</p>';
  h += off.length ? gdSwitchTable(M, gdSwitchRows(M, off), 'What turns it on') : '<p class="quiet">Nothing is off by default.</p>';
  if (on.length) h += '<details class="gd-sub"><summary>On by default · ' + on.length + ' boxes (these run unless a switch turns them off)</summary>' + gdSwitchTable(M, gdSwitchRows(M, on), 'What turns it off') + '</details>';
  return h;
}
function gdScopeInferred(M) {
  var inf = M.routes.filter(function (r) { return r.inferred; });
  return '<p class="gd-body">No code path proves these roads (events, queues, configuration). They are drawn fainter and badged &ldquo;Inferred&rdquo;: treat them as lower trust until a run shows them.</p>' +
    gdList(inf.map(function (r) { return gdBoxBtn(r.from) + ' <span class="gd-arrow">→</span> ' + gdBoxBtn(r.to) + ' <span class="gd-cond">' + esc(r.when || 'Always') + '</span>'; }));
}
function gdLevelCounts(M) {
  var ov = gdOverlay(), c = { drawn: 0, suspected: 0, seen: 0, proved: 0 }, sus = {};
  gdFindings().forEach(function (f) { gdArr(f && f.boxes).forEach(function (b) { sus[b] = 1; }); });
  M.ids.forEach(function (id) { var lv = (ov && ov.boxes && ov.boxes[id] && ov.boxes[id].level) || (M.box[id].n.level) || 'drawn'; if (lv === 'drawn' && sus[id]) lv = 'suspected'; c[c[lv] != null ? lv : 'drawn']++; });
  return c;
}
function gdScopeLevels(M) {
  var c = gdLevelCounts(M);
  return '<p class="gd-body">The evidence layer is a switch, off by default. Outline says how we know; colour says what we found; colour appears only where there is evidence. Unproven never shows green.</p>' +
    '<div class="table-wrap"><table class="gd-tbl"><thead><tr><th>Mark</th><th>Looks like</th><th>Means</th><th>Does not prove</th><th>In this map</th></tr></thead><tbody>' + GD_LEVELS.map(function (l) {
      return '<tr><td><b>' + l[1] + '</b></td><td>' + l[2] + '</td><td>' + l[3] + '</td><td>' + l[4] + '</td><td class="gd-num2">' + c[l[0]] + '</td></tr>'; }).join('') + '</tbody></table></div>' +
    '<p class="gd-lbl">How far a search got (walk label)</p><div class="table-wrap"><table class="gd-tbl"><thead><tr><th>Label</th><th>Means</th><th>May say</th></tr></thead><tbody>' + GD_WALKS.map(function (l) {
      return '<tr><td><code>' + l[0] + '</code></td><td>' + l[1] + '</td><td>' + l[2] + '</td></tr>'; }).join('') + '</tbody></table></div>' +
    '<p class="gd-lbl">How strong one finding is</p>' + gdKV(GD_STRENGTH.map(function (s) { return [s[0], esc(s[1])]; })) +
    '<p class="gd-note quiet">A map line never reads “bug” or “dead end”: it reads “candidate” plus its shape. “Not drawn” never means “does not exist”. “No limit shown” never means “unbounded”.</p>';
}
function gdScopeFindings(M) {
  var F = gdFindings(), by = {}, order = [], shown = 0, cap = 10;
  F.forEach(function (f) { var k = gdS(f.cluster) || ((M.box[gdArr(f.boxes)[0]] && gdStageName(M.stageOf[f.boxes[0]])) || 'Elsewhere'); if (!by[k]) { by[k] = []; order.push(k); } by[k].push(f); });
  var BN = typeof bkNums === 'function' ? bkNums() : null;
  return '<p class="gd-body">' + gdPlural(F.length, 'candidate') + '. A candidate is a question the map raises, with the evidence for it; it is not a verdict. Showing up to ' + cap + '.' + (BN ? ' These are the highest-ranked of the <b>' + BN.look + ' questions to look at</b> in <a class="hlink" href="#reading=breaks">Where it can break</a>; ' + gdNumLink('what the numbers count') + ' says why the numbers differ.' : '') + '</p>' + order.map(function (k) {
    var items = by[k].slice(0, Math.max(0, cap - shown)); shown += items.length; if (!items.length) return '';
    return '<p class="gd-lbl">' + esc(k) + '</p>' + gdList(items.map(function (f) {
      return '<b>' + esc(gdS(f.check).replace(/-/g, ' ') || 'candidate') + '</b> ' + gdArr(f.boxes).slice(0, 4).map(function (b) { return M.box[b] ? gdBoxBtn(b) : esc(b); }).join(' ') + '<br>' + esc(f.question || '') + (f.evidence ? ' <span class="quiet">' + esc(f.evidence) + '</span>' : '');
    }));
  }).join('') + (F.length > cap ? '<p class="quiet">… and ' + (F.length - cap) + ' more: <a class="hlink" href="#reading=breaks">Where it can break</a> lists every one.</p>' : '');
}
function gdHasWalks(ov) { return !!ov && ['labels', 'walks', 'notMapped', 'missingRoutes', 'stale', 'unexplored', 'untested', 'neverSeen'].some(function (k) { return gdArr(ov[k]).length; }); }
function gdScopeWalks(M) {
  var ov = gdOverlay(), L = gdArr(ov.labels), W = gdArr(ov.walks), nm = gdArr(ov.notMapped), mr = gdArr(ov.missingRoutes), st = gdArr(ov.stale), ux = gdArr(ov.unexplored), ut = gdArr(ov.untested);
  var h = '<p class="gd-body">Runs, tests and searches imported from other tools. A box lights up only when a run reached it; steps that match no box, and roads seen but not drawn, are listed so the map can be fixed rather than the run ignored.</p>';
  h += '<div class="gd-stats">' + gdStat(W.length || L.length, 'walks imported') + gdStat(nm.length, 'steps not mapped', 'no box matches them') + gdStat(mr.length, 'missing roads', 'seen in a run, not drawn') + gdStat(st.length + ux.length + ut.length, 'stale, unexplored or untested') + '</div>';
  if (L.length) h += '<p class="gd-lbl">Labels</p>' + gdList(L.slice(0, 12).map(function (w) { return '<code>' + esc(w.tool || w.walk || '') + '</code> <span class="gd-pill quiet">' + esc(w.effective || w.label || '') + '</span> ' + esc(w.says || ''); }));
  if (W.length) h += '<p class="gd-lbl">Walks</p>' + gdList(W.slice(0, 12).map(function (w) { return '<code>' + esc(w.tool || w.id || '') + '</code>' + (w.strength ? ' <span class="gd-pill quiet">' + esc(w.strength) + '</span>' : '') + (w.outcome ? ' <span class="gd-pill quiet">' + esc(w.outcome) + '</span>' : '') + (w.count ? ' <span class="quiet">x' + esc(w.count) + '</span>' : '') + (w.says ? ' ' + esc(w.says) : '') + (gdArr(w.boxes).length ? '<br>' + gdChain(gdArr(w.boxes).filter(function (id) { return M.box[id]; }), 6) : ''); }));
  return h;
}
function gdNumRow(num, what, why) { return '<tr><td class="gd-numc"><b>' + num + '</b></td><td>' + what + '</td><td>' + (why || '<span class="quiet">&nbsp;</span>') + '</td></tr>'; }
function gdScopeNumbers(M) {
  var C = gdCounts(M), E = C.ends || {}, L = C.loops || {}, B = C.breaks, P = C.people, ov = Object.keys(CH).map(function (id) { return CH[id]; }).filter(function (c) { return c.kind === 'overview'; })[0];
  var ovAll = ov ? Object.keys(ov.edges || {}).length + gdArr(ov.notDrawn).length : 0, rows = [];
  rows.push(gdNumRow(gdN1(C.boxes) + ' boxes', 'Everything drawn as a box: steps, decisions, waits, stores, outside parties and endings.', 'Not functions or files: one function can be several boxes, and some boxes cite no single function.'));
  rows.push(gdNumRow(gdN1(C.roads) + ' roads', 'Every arrow between two boxes. ' + gdN1(C.roadsBack) + ' of them go back upstream (return roads).', ov && ovAll ? 'The glance chart draws roads between stages: each one bundles every road between the same two stages, so it says &ldquo;' + Object.keys(ov.edges).length + ' of ' + ovAll + ' hand-offs&rdquo;, a count of bundles.' : ''));
  if (E.boxes != null) rows.push(gdNumRow(gdN1(E.boxes) + ' ending boxes', 'Boxes of kind Ending. <b>' + gdN1(E.stop) + ' stop here</b> (no road leaves them) and <b>' + gdN1(E.back) + ' hand back to their caller</b> (a road leaves them).', 'Only the ones that stop here end a path. A box that hands back can sit in the middle of the main path.'));
  if (E.census != null) rows.push(gdNumRow(gdN1(E.census) + ' endings in the code', gdEndCodeSentence(E), 'The reader counts return and raise statements it is confident are endings; the map counts boxes drawn by reading. The two are different units, so neither is a sub-total of the other.'));
  if (E.outcome) rows.push(gdNumRow('Success ' + E.outcome.success + ' · Refusal ' + E.outcome.refusal + ' · Failure ' + E.outcome.failure + ' · Neutral ' + E.outcome.neutral, 'Ending boxes by their outcome. This is the split on the glance chart and in the Narrative.', P ? 'Counted as <b>roads</b> instead of boxes, ' + gdN1(P.total) + ' roads end in a failure or a refusal or hand something out (Failure ' + P.failure + ' · Refusal ' + P.refusal + ' · Hand-off ' + P.handoff + ' · Success ' + P.success + ' · Neutral ' + P.neutral + '). A road counts here only if it lands on a failure or refusal ending, or delivers something, so a success or neutral ending appears only when a delivering road reaches it, and the two splits differ by design. <button type="button" class="hlink" data-reading-go="fails">How it fails</button> counts boxes.' : ''));
  if (L.total != null) rows.push(gdNumRow(gdN1(L.total) + ' loops', gdN1(L.declared) + ' declared by the map&rsquo;s author + ' + gdN1(L.workedOut) + ' worked out from return roads that no declared loop holds.', 'The Regions list on the whole map shows ' + gdN1(L.spanning != null ? L.spanning : L.declared) + ' loops' + (C.slices != null ? ' + ' + gdN1(C.slices) + ' path slices' : '') + ': only declared loops of two or more boxes, and a slice is a declared path other than the main path. That is why it is not ' + gdN1(L.total) + '.'));
  if (L.noLimit != null) rows.push(gdNumRow(gdN1(L.noLimit) + ' loops with no limit written', gdN1(L.noLimitDeclared) + ' declared loops that state no limit + ' + gdN1(L.noLimitWorkedOut) + ' worked-out loops (they have no limit field).', L.raised != null ? '<b>' + gdN1(L.raised) + ' were raised as questions</b> in Where it can break: ' + gdN1(L.raisedNoLimit) + ' declared loops with no limit' + (L.raisedDisputed ? ' + ' + gdN1(L.raisedDisputed) + ' declared loops whose written limit the code seems to contradict' : '') + (L.raisedCycle ? ' + ' + gdN1(L.raisedCycle) + ' cycle' + (L.raisedCycle === 1 ? '' : 's') + ' of roads that no loop lists' : '') + '. The ' + gdN1(L.noLimitWorkedOut) + ' worked-out loops are never checked, which is why the loops with no limit written are more than the questions raised.' : ''));
  if (B) rows.push(gdNumRow(gdN1(B.look) + ' to look at', gdN1(B.kept) + ' kept suspects + ' + gdN1(B.waits) + ' waits with no timeout' + (B.open ? ' + ' + gdN1(B.open) + ' open candidates' : '') + (B.loops ? ' + ' + gdN1(B.loops) + ' loops with no limit that no question lists' : '') + (B.silent ? ' + ' + gdN1(B.silent) + ' failures and refusals nobody is told about' : '') + '. This is the number beside Where it can break in the sidebar.', gdN1(B.setAside) + ' are set aside (' + gdN1(B.leads) + ' held-back leads + ' + gdN1(B.dismissed) + ' dismissed, each with its reason). ' + (C.candidates ? 'The Evidence switch on a chart shows only the ' + gdN1(C.candidates.onMap) + ' highest-ranked candidates and lights ' + gdN1(C.candidates.boxesNamed) + ' boxes: those are boxes, not questions.' : '')));
  var MPc = C.mainPath;
  if (MPc && MPc.steps) rows.push(gdNumRow(gdN1(MPc.steps) + ' steps on the main path' + (MPc.boxes !== MPc.steps ? ', ' + gdN1(MPc.boxes) + ' different boxes' : ''), 'The declared main path takes ' + gdN1(MPc.steps) + ' steps' + (MPc.boxes !== MPc.steps ? '; a box that is passed twice (calls come back) is one box and two steps, so there are ' + gdN1(MPc.boxes) + ' different boxes' : ', each a different box') + ', in ' + MPc.stages + ' of the ' + C.stages + ' stages.', 'The Trace panel says "N boxes (N-1 steps between them)": a path of N boxes has N-1 steps from the first to the last. The glance chart says which stages the path runs through; a plain job meets only those.'));
  if (C.stageRoads && Object.keys(C.stageRoads).length) rows.push(gdNumRow('Roads of a stage', 'For each stage: roads <b>inside</b> it (both ends are its boxes; an ending box of the stage counts as inside), roads that <b>arrive</b> from other stages and roads that <b>leave</b> for them. The stage panels on the glance chart and the whole map print these.', 'The lines on the glance chart are bundles: each stands for every road between the same two stages, so counting its lines gives fewer, and counting roads that reach an ending group gives more. Both pages now count roads this one way.'));
  var SW = C.switches;
  if (SW) rows.push(gdNumRow(gdN1(SW.boxes) + ' switches and settings', gdN1(SW.off) + ' off by default + ' + gdN1(SW.testOnly) + ' test only + ' + gdN1(SW.defaultOn) + ' on by default' + (SW.liveNamed ? ' + ' + gdN1(SW.liveNamed) + ' that name a switch and are drawn live' : '') + '. This is the count at the top of the Switches and settings section.', 'Off by default (' + gdN1(SW.offAndTest) + ' boxes: off + test only) leaves out the on-by-default ones and the ' + gdN1(SW.liveNamed || 0) + ' live ones, which is why the two numbers differ.'));
  var FC = C.fails;
  if (FC && FC.total != null) rows.push(gdNumRow(gdN1(FC.total) + ' failures and refusals', gdN1(FC.failure) + ' failure endings + ' + gdN1(FC.refusal) + ' refusal endings' + (FC.steps ? ' + ' + gdN1(FC.steps) + ' steps the map says report a failure and carry on' : '') + '. The page <button type="button" class="hlink" data-reading-go="fails">How it fails</button> lists every one, by who hears: ' + ['person', 'outside', 'event', 'caller', 'log', 'nobody', 'unclear', 'unsaid'].filter(function (k) { return FC.by[k]; }).map(function (k) { return FC.by[k] + ' ' + (k === 'unsaid' ? 'not said yet' : HEARD_SHORT[k].charAt(0).toLowerCase() + HEARD_SHORT[k].slice(1)); }).join(', ') + '.', 'The unit is a box. The road counts above (the glance chart’s stage-to-stage roads, the roads that hand something out) count roads, so they are bigger: several roads can reach one ending.'));
  if (C.waits && C.waits.boxes) rows.push(gdNumRow(gdN1(C.waits.boxes) + ' wait boxes', C.waits.said ? gdN1(C.waits.said) + ' say what they wait for: ' + ['person', 'machine', 'outside', 'time'].filter(function (k) { return C.waits[k]; }).map(function (k) { return gdN1(C.waits[k]) + ' for ' + ((META.waitWords || {})[k] || k); }).join(', ') + (C.waits.notSaid ? '; ' + gdN1(C.waits.notSaid) + ' not said' : '') + '.' : 'None of them says what it waits for (the map gives no <code>waitsFor</code>).', C.waits.person ? gdN1(C.waits.person) + ' waits for a person are filed apart in Where it can break and are <b>not counted</b> in the ' + gdN1(B.look) + ' to look at.' : ''));
  if (C.holds && C.holds.total) rows.push(gdNumRow(gdN1(C.holds.total) + ' places on the main path that can hold it up', gdN1(C.holds.wait) + ' waits + ' + gdN1(C.holds.gate) + ' gates + ' + gdN1(C.holds.loop) + ' loops that touch the declared main path (' + gdN1(C.holds.pathSteps) + ' steps, ' + gdN1(C.holds.pathBoxes) + ' different boxes: calls come back). ' + gdN1(C.holds.kept) + ' kept as a question, ' + gdN1(C.holds.open) + ' open, ' + gdN1(C.holds.held) + ' held back, ' + gdN1(C.holds.dismissed) + ' dismissed, ' + gdN1(C.holds.none) + ' with no question raised.', 'Not extra questions: the first section of Where it can break lists them from the path, and a place that also has a question counts once there too.'));
  if (C.status) rows.push(gdNumRow(gdN1(C.status.off + C.status.testOnly) + ' boxes off by default', gdN1(C.status.off) + ' are off until something turns them on + ' + gdN1(C.status.testOnly) + ' only a test reaches.', C.status.defaultOn ? gdN1(C.status.defaultOn) + ' more boxes are on by default and are not counted here.' : ''));
  var ce = META.census || {};
  if (ce.endings || ce.branches || ce.modules) rows.push(gdNumRow(['endings', 'branches', 'modules'].filter(function (k) { return ce[k]; }).map(function (k) { return ce[k].accounted + '/' + ce[k].total + ' ' + k; }).join(' · '), 'Census rows accounted for: each has a box, a road, a merge or a written exclusion.', 'A row accounted for is about the drawing, not about the system. It says nothing about how many boxes there are.'));
  return '<p class="gd-body">Every total on this page is counted once, from the data, with one definition. Where two numbers sit side by side and differ, this says why.</p>' +
    '<div class="table-wrap"><table class="gd-tbl gd-numbers"><thead><tr><th>Number</th><th>What it counts</th><th>Why it differs from its neighbours</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
}
function gdScopeTool() {
  var M = gdModel(), T = META.toolMap, secs = [], S = T.sw || {};
  var gdScopeNumbers = gdToolNumbers, gdScopeLevels = gdToolMarks;
  secs.push({ id: 'read', title: 'What was read and what is open', take: T.read[0], html: '<p class="gd-lbl">Read</p>' + gdList(T.read.map(esc)) + '<p class="gd-lbl">Not read</p>' + gdList(T.notRead.map(esc)) + '<p class="gd-lbl">Open</p>' + gdList(T.open.map(esc)) + '<p class="gd-body">' + T.conf.boxes + ' boxes and ' + T.conf.roads + ' roads are drawn dashed because the tool is not confident in them.</p>' });
  secs.push({ id: 'numbers', title: 'What the numbers count', take: 'Each total on the page, what it counts, and why it differs from the one beside it.', html: gdScopeNumbers(M) });
  secs.push({ id: 'switches', title: 'Off by default', count: S.count, take: S.line, html: '<p class="gd-body">' + esc(S.line) + ' <button type="button" class="xbtn" data-reader-view="switches">Open the list ↗</button></p>' });
  if (M.routes.some(function (r) { return r.inferred; })) secs.push({ id: 'inferred', title: 'Roads the tool is not sure of', count: T.nums.roadsUnsure, take: 'Calls that may run any of several functions, and names the tool joined.', html: gdScopeInferred(M) });
  secs.push({ id: 'levels', title: 'What the marks mean', take: 'Solid, and dashed with a ?.', html: gdScopeLevels(M) });
  return { id: 'scope', eyebrow: 'What this map can and cannot tell you', title: 'Evidence and scope', tldr: 'What was read, what was not, what is open, and which parts are off by default.', secs: secs };
}
function gdScope() {
  if (META.toolMap) return gdScopeTool();
  var M = gdModel(), ov = gdOverlay(), F = gdFindings(), nd = gdNotDrawn(), rows = censusRows(META.census), secs = [];
  secs.push({ id: 'numbers', title: 'What the numbers count', take: 'Each total on the page, what it counts, and why it differs from the one beside it.', html: gdScopeNumbers(M) });
  secs.push({ id: 'census', title: 'Draft or finished', take: (META.draft !== false ? 'Draft' : 'Fully drawn') + (rows.length ? ' · ' + rows.slice(0, 3).map(function (r) { return r.label + ' ' + (r.done != null ? r.done + '/' + r.total : r.total); }).join(' · ') : ''), html: gdScopeCensus(M) });
  secs.push({ id: 'coverage', title: 'What the map covers', take: gdPlural(gdCounts(M).boxes, 'box', 'boxes') + ' in ' + gdPlural(gdCounts(M).stages, 'stage') + ', ' + gdPlural(gdCounts(M).roads, 'road') + '.', html: gdScopeCoverage(M) });
  secs.push({ id: 'notdrawn', title: 'Not drawn yet', count: nd.count == null ? null : nd.count, take: nd.count ? 'A list beside the map, never empty space on it.' : 'Nothing listed.', html: gdScopeNotDrawn(M) });
  var nOff = M.ids.filter(function (id) { var st = M.box[id].n.status; return st === 'off' || st === 'test-only'; }).length;
  secs.push({ id: 'switches', title: 'Off by default and test only', count: nOff, take: nOff ? 'Boxes behind a switch, grouped by switch. Drawn dimmer; the map does not say they have run.' : 'None.', html: gdScopeOff(M) });
  if (M.routes.some(function (r) { return r.inferred; })) secs.push({ id: 'inferred', title: 'Roads no code proves', count: gdCounts(M).roadsInferred, take: 'Events, queues and configuration: lower trust.', html: gdScopeInferred(M) });
  if (F.length) secs.push({ id: 'candidates', title: 'Candidates to check', count: F.length, take: 'Questions the map raises, each with its evidence.', html: gdScopeFindings(M) });
  if (gdHasWalks(ov)) secs.push({ id: 'walks', title: 'What was walked', take: 'Imported runs, and where they did not fit the map.', html: gdScopeWalks(M) });
  secs.push({ id: 'levels', title: 'Evidence labels', take: 'Drawn, suspected, seen, proved; and what each does not prove.', html: gdScopeLevels(M) });
  return { id: 'scope', eyebrow: 'What this map can and cannot tell you', title: 'Evidence and scope', tldr: 'How complete the map is, what is not drawn yet, which parts are off by default, and what each evidence label does and does not prove.', secs: secs };
}

/* ================================================================ ops: only when the model has an operations stage (role 'ops', or a name that says so) */
function gdHasOps() { return gdModel().stages.some(function (s) { return s.ops; }); }
function gdOpsControls(M, opsIds) {
  var rows = [], seen = {};
  M.ids.forEach(function (id) { var n = M.box[id].n; if (n.switch || M.offs.indexOf(id) >= 0) rows.push({ id: id, n: n, sw: n.switch || '', ops: !!opsIds[id] }); });
  rows.sort(function (a, b) { return (b.ops ? 1 : 0) - (a.ops ? 1 : 0); });
  var h = rows.length ? '<div class="table-wrap"><table class="gd-tbl"><thead><tr><th>Switch</th><th>State</th><th>What it does</th><th>Where it bites</th></tr></thead><tbody>' + rows.map(function (r) {
    var t = r.sw && LAY[r.sw]; seen[r.sw] = 1;
    return '<tr><td>' + (r.sw ? '<code>' + esc(r.sw) + '</code>' : '<span class="quiet">none named</span>') + '</td><td>' + gdMark(r.n) + '</td><td>' + gdText(gdTake((t && t.meaning) || r.n.plain || '', 60)) + '</td><td>' + gdBoxBtn(r.id) + ' <span class="quiet">' + esc(gdStageName(M.stageOf[r.id])) + '</span></td></tr>';
  }).join('') + '</tbody></table></div>' : '<p class="gd-body quiet">No box sits behind a switch.</p>';
  var settings = Object.keys(LAY).filter(function (k) { return /setting|switch|config|flag|limit|option/i.test(LAY[k].family || '') && !seen[k]; });
  if (settings.length) h += '<p class="gd-lbl">Other settings the system names</p>' + gdKV(settings.slice(0, 20).map(function (k) { return [k, gdText(LAY[k].meaning || '')]; }));
  return h;
}
function gdOpsKind(M, kinds, none) {
  var ids = M.ids.filter(function (id) { return kinds.indexOf(kindOf(M.box[id].n)) >= 0; });
  return ids.length ? gdList(ids.slice(0, 40).map(function (id) { return gdBoxLine(id, { gist: 110 }) + ' <span class="quiet">' + esc(gdStageName(M.stageOf[id])) + '</span>'; })) + (ids.length > 40 ? gdMoreOpen(ids.length - 40, gdList(ids.slice(40).map(function (id) { return gdBoxLine(id, { gist: 110 }) + ' <span class="quiet">' + esc(gdStageName(M.stageOf[id])) + '</span>'; }))) : '') : '<p class="gd-body quiet">' + none + '</p>';
}
function gdOpsFail(M, opsIds) {
  var ids = M.ids.filter(function (id) { return gdS(M.box[id].n.failure); }).sort(function (a, b) { return (opsIds[b] ? 1 : 0) - (opsIds[a] ? 1 : 0); });
  if (!ids.length) return '<p class="gd-body quiet">No box records what happens when it goes wrong.</p>';
  return '<p class="gd-body">What each box says about its own failure, and where the work goes next. Parts of operations come first.</p>' + gdList(ids.slice(0, 40).map(function (id) {
    var o = (M.out[id] || []).slice(0, 2);
    return gdBoxLine(id) + ' <span class="quiet">' + esc(gdStageName(M.stageOf[id])) + '</span><span class="gd-side"><span class="gd-sl">If it goes wrong</span><span>' + gdText(M.box[id].n.failure) + '</span></span>' +
      (o.length ? '<span class="gd-side"><span class="gd-sl">Then</span>' + o.map(function (r) { return gdRoad(r, true); }).join('') + '</span>' : '');
  })) + (ids.length > 40 ? '<p class="quiet">… and ' + (ids.length - 40) + ' more.</p>' : '');
}
function gdOpsLimits(M) {
  var h = M.loops.length ? '<p class="gd-lbl">Loops and what bounds them</p>' + gdList(M.loops.slice().sort(function (a, b) { return (a.limit ? 1 : 0) - (b.limit ? 1 : 0); }).map(function (l) {
    return '<b>' + esc(l.title) + '</b> <span class="gd-pill' + (l.limit ? '' : ' warn') + '">' + (l.limit ? 'Limit: ' + esc(l.limit) : 'No limit shown') + '</span> ' + gdChain(l.boxes, 5); })) : '';
  return h + '<p class="gd-lbl">Waits and gates</p>' + gdOpsKind(M, ['wait', 'gate'], 'No wait or gate box is drawn.');
}
var GD_BY_ORDER = ['person', 'outside', 'event', 'caller', 'log', 'nobody', 'unclear', 'unsaid'];
function gdPeopleRoads(M) { return M.routes.filter(function (r) { return r.type === 'deliver' || (kindOf(M.box[r.to].n) === 'end' && /failure|refusal/.test(M.box[r.to].n.outcome || '')); }); }
function gdHeardKey(M, r) { var n = M.box[r.to].n, h = kindOf(n) === 'end' ? heardOf(n) : null; return h ? h.by : 'unsaid'; }
function gdHeardLabel(k) { return k === 'unsaid' ? 'Not said yet' : (HEARD_SHORT[k] || k); }
function gdOpsPeople(M) {
  var rs = gdPeopleRoads(M);
  if (!rs.length) return '<p class="gd-body quiet">No road is drawn as a hand-off to a person or outside.</p>';
  var CN = gdCounts(M);
  var kind = function (r) { var o = kindOf(M.box[r.to].n) === 'end' ? (M.box[r.to].n.outcome || 'neutral') : 'handoff'; return o; };
  var lab = { failure: 'Failure', refusal: 'Refusal', success: 'Success', neutral: 'Neutral', handoff: 'Hand-off, not an ending' }, cnt = {}, order = ['failure', 'refusal', 'handoff', 'success', 'neutral'], cb = {};
  rs.forEach(function (r) { var k = kind(r), b = gdHeardKey(M, r); cnt[k] = (cnt[k] || 0) + 1; cb[b] = (cb[b] || 0) + 1; });
  var by = {};
  rs.forEach(function (r) { var b = gdHeardKey(M, r); (by[b] = by[b] || []).push(r); });
  var ordBy = GD_BY_ORDER.filter(function (b) { return by[b]; });
  var fr = M.ends.filter(function (id) { return needsHeard(M.box[id].n); }), said = fr.filter(function (id) { return heardOf(M.box[id].n); }).length;
  var chipsBy = '<div class="bk-chips en-chips" role="group" aria-label="Filter by who hears"><span class="en-chips-l">Who hears</span><button type="button" class="bk-chip on" data-en-by="*">All <b>' + rs.length + '</b></button>' + ordBy.map(function (b) { return '<button type="button" class="bk-chip" data-en-by="' + b + '">' + esc(gdHeardLabel(b)) + ' <b>' + cb[b] + '</b></button>'; }).join('') + '</div>';
  var chipsOut = '<div class="bk-chips en-chips" role="group" aria-label="Filter by outcome"><span class="en-chips-l">How it ends</span><button type="button" class="bk-chip on" data-en-out="*">All <b>' + rs.length + '</b></button>' + order.filter(function (k) { return cnt[k]; }).map(function (k) { return '<button type="button" class="bk-chip" data-en-out="' + k + '">' + lab[k] + ' <b>' + cnt[k] + '</b></button>'; }).join('') + '</div>';
  return '<p class="gd-body fl-point"><b>Each failure and refusal as a box, by who hears,</b> is the page <button type="button" class="hlink" data-reading-go="fails">How it fails</button>. This list counts roads.</p><p class="gd-body">All <b>' + rs.length + '</b> roads that hand something to a person or to the outside world, or that end in a refusal or a failure, none cut off. They are grouped by <b>who hears about the ending</b>, as the map&rsquo;s author wrote it down for the ending box the road lands on. ' +
    'Of the <b>' + fr.length + '</b> failure and refusal ending boxes, <b>' + said + '</b> say who hears' + (fr.length - said ? ' and <b>' + (fr.length - said) + ' are ' + UNSAID + '</b> (the page never guesses: &ldquo;' + UNSAID + '&rdquo; means ' + (META.toolMap ? 'the code and the claims the tool made do not settle it' : 'no one has written it down') + ')' : '') + '. ' +
    (CN.people ? 'This counts roads; the glance and the Narrative count boxes. ' : '') + gdNumLink() + '.</p>' + chipsBy + chipsOut +
    ordBy.map(function (b) {
      return '<div class="bk-grp en-by" data-by="' + b + '"><h4 class="bk-gh"><i></i>' + esc(gdHeardLabel(b)) + '<span class="bk-gn">' + by[b].length + '</span></h4>' + (b === 'unsaid' ? '<p class="quiet">The map does not say who hears these. Roads that land on a success or neutral ending, or hand something out without landing on an ending, are here too.</p>' : '<p class="quiet">' + esc(capFirst(HEARD[b] || '')) + '.</p>') +
        by[b].map(function (r) { var h = kindOf(M.box[r.to].n) === 'end' ? heardOf(M.box[r.to].n) : null; return '<div class="gd-unit en-row" data-out="' + kind(r) + '" data-by="' + b + '">' + gdBoxBtn(r.from) + ' <span class="gd-arrow">→</span> ' + gdBoxBtn(r.to) + ' <span class="gd-cond">' + esc(r.when || 'Always') + '</span> <span class="gd-pill quiet">' + lab[kind(r)] + '</span>' + (h && h.how ? ' <span class="quiet">' + esc(h.how) + '</span>' : '') + ' <span class="quiet">' + esc(gdStageName(M.stageOf[r.from])) + '</span></div>'; }).join('') + '</div>';
    }).join('');
}
function gdOps() {
  var M = gdModel(), ops = M.stages.filter(function (s) { return s.ops; }), opsIds = {}, secs = [];
  ops.forEach(function (s) { s.boxes.forEach(function (b) { opsIds[b] = 1; }); });
  ops.forEach(function (s) { secs.push({ id: 'ops-' + gdSlug(s.id), title: s.title, num: s.i + 1, count: s.boxes.length, take: gdTake(s.blurb, 40) || gdKinds(s.boxes), html: gdNarStage(M, s) }); });
  secs.push({ id: 'controls', title: 'Switches and settings', count: M.ids.filter(function (id) { return M.box[id].n.switch || M.offs.indexOf(id) >= 0; }).length, take: (function () { var W = gdCounts(M).switches; return W ? W.boxes + ' boxes = ' + W.off + ' off by default + ' + W.testOnly + ' test only + ' + W.defaultOn + ' on by default' + (W.liveNamed ? ' + ' + W.liveNamed + ' that name a switch but are drawn live' : '') + '.' : 'What an operator can turn on or off, and where it bites.'; })(), html: gdOpsControls(M, opsIds) });
  secs.push({ id: 'stores', title: 'Stores and outside parties', take: 'Where things are kept, and who is beyond this system.', html: gdOpsKind(M, ['store', 'external'], 'No store or outside party is drawn.') });
  secs.push({ id: 'limits', title: 'Limits, waits and gates', count: gdCounts(M).loops.total, take: 'What bounds each loop, and where the flow pauses.', html: gdOpsLimits(M) });
  secs.push({ id: 'failure', title: 'When it goes wrong', take: 'Each box’s own failure note and what happens next.', html: gdOpsFail(M, opsIds) });
  secs.push({ id: 'people', title: 'Who hears about failures and refusals', count: gdPeopleRoads(M).length, take: 'Every road that hands something out or ends in a refusal or failure, grouped by who is told.', html: gdOpsPeople(M) });
  return { id: 'ops', eyebrow: 'For the people who run it', title: 'Operations', tldr: 'The operations stage' + (ops.length === 1 ? '' : 's') + ' (' + ops.map(function (s) { return s.title; }).join(', ') + '), then what an operator can switch, what bounds the loops, and what each box says about its own failure.', tldrPlain: true, secs: secs };
}

/* ================================================================ the shared reader shell */
function gdSecHTML(s, open, next) {
  return '<details class="gd-sec" id="gd-' + esc(s.id) + '" data-id="' + esc(s.id) + '"' + (open ? ' open' : '') + '><summary><div class="gd-sum"><span class="gd-chev" aria-hidden="true"></span>' +
    '<span class="gd-t">' + (s.num ? '<span class="gd-num">' + s.num + '</span>' : '') + '<span class="gd-tt">' + esc(s.title) + '</span>' + (s.count != null ? '<span class="gd-n">' + s.count + '</span>' : '') + '</span>' +
    '<span class="gd-take">' + esc(s.take || '') + '</span><span class="gd-meta">' + (s.chips || '') + '<button type="button" class="gd-lk" data-gd-link="' + esc(s.id) + '" aria-label="Copy a link to this section" title="Copy a link to this section">#</button></span></div></summary>' +
    '<div class="gd-in">' + s.html + (next ? '<div class="gd-foot gd-foot-sm"><button type="button" class="gd-next gd-next-sm" data-gd-goto="' + esc(next.id) + '">Next · ' + esc(next.title) + ' ↓</button></div>' : '') + '</div></details>';
}
function gdBuild(mode) { return mode === 'narrative' ? gdNarrative() : mode === 'glossary' ? gdGlossary() : mode === 'scope' ? gdScope() : mode === 'breaks' ? gdBreaks() : mode === 'fails' ? gdFails() : gdOps(); }
function gdRender(mode, params) {
  var g = gdBuild(mode), focusParams = !!(params && (params.get('section') || params.get('term')));
  var toc = g.secs.map(function (s) {
    return '<li><a class="gd-toc-a" href="#reading=' + mode + '&section=' + encodeURIComponent(s.id) + '" data-sec="' + esc(s.id) + '">' + (s.num ? '<span class="gd-toc-n">' + s.num + '</span>' : '') + '<span class="gd-toc-t">' + esc(s.tocTitle || s.title) + '</span>' + (s.count != null ? '<span class="gd-toc-c">' + s.count + '</span>' : '') + '</a></li>';
  }).join('');
  return '<div class="gd" data-guide="' + mode + '"><aside class="gd-toc" aria-label="Contents of this guide"><p class="gd-toc-h">On this page</p><ol>' + toc + '</ol></aside>' +
    '<div class="gd-main"><header class="gd-top"><div class="gd-top-t"><p class="eyebrow">' + esc(g.eyebrow) + '</p><h2>' + esc(g.title) + '</h2><p class="gd-tldr">' + (g.tldrPlain ? esc(g.tldr) : gdText(g.tldr)) + '</p></div>' +
    '<button type="button" class="xbtn gd-back" data-chart="' + esc(S.lastChart) + '">← Back to the diagrams</button></header>' +
    '<div class="gd-bar" role="toolbar" aria-label="Guide tools"><div class="gd-search"><input type="search" id="gdFilter" class="gd-filter" placeholder="Filter this guide   ( / )" aria-label="Filter this guide" autocomplete="off" spellcheck="false"><span id="gdCount" class="gd-count" role="status" aria-live="polite"></span></div>' +
    '<div class="gd-btns"><button type="button" class="gd-btn" data-gd="expand">Expand all</button><button type="button" class="gd-btn" data-gd="collapse">Collapse all</button>' +
    (g.units ? '<button type="button" class="gd-btn" data-gd="units" aria-pressed="false" title="Open or close every card inside the open sections">All ' + esc(g.units) + '</button>' : '') + '<button type="button" class="gd-btn gd-btn-q" data-gd="print" title="Print this guide with everything expanded">Print</button></div></div>' +
    (g.top || '') + '<div class="gd-secs">' + g.secs.map(function (s, i) { return gdSecHTML(s, s.open != null ? !!s.open && !focusParams : i === 0 && !focusParams && !s.closed, g.secs[i + 1]); }).join('') + '</div><p class="gd-none" id="gdNone" hidden>Nothing in this guide matches that filter.</p></div></div>';
}

/* ---- behaviour -------------------------------------------------------------------------------------------------------- */
function gdRoot() { return readingView.querySelector('.gd'); }
function gdIsDesktopScroll() { try { return getComputedStyle(readingView).overflowY === 'auto'; } catch (e) { return true; } }
function gdSticky() { var w = $('.nav-select-wrap'); return w && w.offsetHeight && getComputedStyle(w).position === 'sticky' ? w.offsetHeight : 0; }
function gdMeasure() {
  var g = gdRoot(); if (!g) return;
  var bar = $('.gd-bar', g), toc = $('.gd-toc', g), st = gdSticky(), desk = gdIsDesktopScroll();
  readingView.style.setProperty('--gd-st', st + 'px');
  var off = desk ? (bar ? bar.offsetHeight : 48) + 12 : st + (toc ? toc.offsetHeight : 0) + 12;
  readingView.style.setProperty('--gd-sm', off + 'px'); GD.off = off;
}
function gdMatch(hay, toks) { for (var i = 0; i < toks.length; i++) if (!hasTok(hay, toks[i])) return false; return true; }
function gdIndex(g) {                      // searchable text for every section and every card, computed once per render
  $$('.gd-sec', g).forEach(function (sec) {
    var whole = sec.cloneNode(true); $$('.gd-foot', whole).forEach(function (e) { e.remove(); });       // the "Next: <other section>" buttons are navigation, not content
    sec.dataset.s = norm(whole.textContent);
    $$('.gd-unit', whole).forEach(function (u) { u.remove(); });
    sec.dataset.head = norm(whole.textContent);
    $$('.gd-unit', sec).forEach(function (u) {      // a card is found by its name, handle, meaning and aliases; the boxes that carry it are not searched ("lease" should find Lease, not every box that mentions it)
      var c = u.cloneNode(true); $$('.gd-eng, .gd-sub', c).forEach(function (e) { e.remove(); }); u.dataset.s = norm(c.textContent);
    });
  });
}
function gdFilter(q, quiet) {
  var g = gdRoot(); if (!g) return; q = String(q || '');
  var inp = $('#gdFilter', g); if (inp && inp.value !== q) inp.value = q;
  var toks = norm(q).split(' ').filter(Boolean), secs = $$('.gd-sec', g), nUnit = 0, nSec = 0, anySecShown = false;
  secs.forEach(function (sec) {
    var units = $$('.gd-unit', sec);
    if (!toks.length) { if (sec._was != null) { sec.open = sec._was; sec._was = null; } sec.hidden = false; units.forEach(function (u) { u.hidden = false; }); return; }
    var headHit = gdMatch(sec.dataset.head, toks), hits = units.filter(function (u) { return gdMatch(u.dataset.s, toks); });
    var show = headHit || hits.length > 0 || (!units.length && gdMatch(sec.dataset.s, toks));
    if (show && sec._was == null) sec._was = sec.open;
    sec.hidden = !show; if (show) { sec.open = true; anySecShown = true; }
    units.forEach(function (u) { u.hidden = hits.length ? hits.indexOf(u) < 0 : false; });
    if (show) { if (hits.length) nUnit += hits.length; else nSec++; }
  });
  $$('.gd-toc-a', g).forEach(function (a) { var s = $('#gd-' + a.dataset.sec, g); a.parentNode.hidden = !!(s && s.hidden); });
  var cnt = $('#gdCount', g), none = $('#gdNone', g);
  if (cnt) cnt.textContent = toks.length ? (anySecShown ? (nUnit ? nUnit + ' match' + (nUnit === 1 ? '' : 'es') : '') + (nUnit && nSec ? ' + ' : '') + (nSec ? nSec + ' section' + (nSec === 1 ? '' : 's') : '') : 'no matches') : '';
  if (none) none.hidden = !(toks.length && !anySecShown);
  if (!quiet) { clearTimeout(GD.ptimer); GD.ptimer = setTimeout(function () { gdSetSub({ q: q.trim() }); }, 350); }
  if (typeof bkSync === 'function') bkSync();
  gdMeasure(); gdSpy();
}
function gdMarkToc(id) {
  var g = gdRoot(); if (!g) return;
  $$('.gd-toc-a', g).forEach(function (a) {
    if (a.dataset.sec === id) {
      a.setAttribute('aria-current', 'location');
      var toc = a.closest('.gd-toc'), r = a.getBoundingClientRect(), t = toc && toc.getBoundingClientRect();
      if (toc && gdIsDesktopScroll()) { if (toc.scrollHeight > toc.clientHeight + 4 && (r.top < t.top || r.bottom > t.bottom)) toc.scrollTop += r.top - t.top - 40; }
      else if (toc && (r.left < t.left || r.right > t.right)) toc.scrollLeft += r.left - t.left - (t.width - r.width) / 2;
    } else a.removeAttribute('aria-current');
  });
}
function gdSpy() {
  var g = gdRoot(); if (!g || readingView.hidden) return;
  var secs = $$('.gd-sec', g).filter(function (x) { return !x.hidden; }); if (!secs.length) return;
  var desk = gdIsDesktopScroll(), sc = desk ? readingView : document.scrollingElement || document.documentElement, off = GD.off || 60;
  var vt = desk ? readingView.getBoundingClientRect().top : 0, vb = desk ? readingView.getBoundingClientRect().bottom : window.innerHeight;
  var pe = GD.pin && $('#gd-' + GD.pin, g);                                  // a contents click / deep link stays selected while its heading is on screen
  if (pe && !pe.hidden) { var pr = pe.getBoundingClientRect(); if (pr.top >= vt - 4 && pr.top < vb - 30) { gdMarkToc(GD.pin); return; } }
  GD.pin = null;
  var line = vt + off + 2 + Math.max(0, (vb - vt - off) * 0.18), cur = secs.filter(function (x) { return x.open; })[0] || secs[0];     // the "reading line": a little below the sticky bar. at the top of the page the mark is on the first section that is OPEN (a shut one above it is a row, not what is being read)
  if (sc.scrollTop > 2) for (var i = 0; i < secs.length; i++) { if (secs[i].getBoundingClientRect().top <= line) cur = secs[i]; else break; }
  var scrollable = sc.scrollHeight > sc.clientHeight + 12, atEnd = scrollable && sc.scrollTop > 0 && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 3;
  if (atEnd && secs[secs.length - 1].open) cur = secs[secs.length - 1];      // the last section may be too short to reach the reading line
  if (!cur.open) { var nx = null, jj; for (jj = secs.indexOf(cur) + 1; jj < secs.length && !nx; jj++) if (secs[jj].open) nx = secs[jj]; if (nx && nx.getBoundingClientRect().top < vb - 60) cur = nx; }      // a shut row at the reading line gives the mark to the open section just under it, when that one is on screen
  gdMarkToc(cur.dataset.id);
}
function gdOnScroll() { if (!S.reading || GD.raf) return; GD.raf = requestAnimationFrame(function () { GD.raf = 0; gdSpy(); if (S.reading) GD.pos[S.reading] = gdIsDesktopScroll() ? readingView.scrollTop : window.scrollY; }); }
function gdScrollTo(el, quiet) {
  if (!el) return; var behavior = reduced || quiet ? 'auto' : 'smooth';
  try { el.scrollIntoView({ block: 'start', behavior: behavior }); } catch (e) { el.scrollIntoView(); }
}
function gdOpenSection(id, o) {
  o = o || {}; var g = gdRoot(); if (!g) return false; var sec = $('#gd-' + id, g); if (!sec || !sec.classList.contains('gd-sec')) return false;
  if (sec.hidden) gdFilter('', true);
  sec.open = true; gdMeasure(); gdMarkToc(id); GD.pin = id;
  if (o.scroll !== false) gdScrollTo(sec, o.quiet);
  if (o.focus) { var sm = $('summary', sec); if (sm) sm.focus({ preventScroll: true }); }
  if (o.hash !== false) gdSetSub({ section: id, term: '' });
  return true;
}
function gdOpenTerm(term, o) {
  o = o || {}; var g = gdRoot(); if (!g || !term) return false; var low = String(term).toLowerCase(), card = null;
  if (!handles()[term]) { var al = resolveAlias(term); if (al) { term = al; low = al.toLowerCase(); } }      // an old name opens its current card
  $$('.gd-card[data-term]', g).forEach(function (c) { if (!card && (c.dataset.term.toLowerCase() === low || gdSlug(c.dataset.term) === gdSlug(term))) card = c; });
  if (!card) return false;
  if (card.hidden) gdFilter('', true);
  var sec = card.closest('.gd-sec'); if (sec) { sec.hidden = false; sec.open = true; }
  GD.bulk = true; card.open = true; GD.bulk = false;
  gdMeasure(); if (sec) { gdMarkToc(sec.dataset.id); GD.pin = sec.dataset.id; }
  gdScrollTo(card, o.quiet);
  card.classList.add('gd-flash'); setTimeout(function () { card.classList.remove('gd-flash'); }, 2200);
  if (o.focus) { var sm = $('summary', card); if (sm) sm.focus({ preventScroll: true }); }
  if (o.hash !== false) gdSetSub({ term: card.dataset.term, section: '' });
  return true;
}
function gdBulk(open, what) {
  var g = gdRoot(); if (!g) return; GD.bulk = true;
  if (what === 'units') { $$('.gd-unit', g).forEach(function (u) { if (!u.hidden && u.tagName === 'DETAILS') u.open = open; }); }
  else { $$('.gd-sec', g).forEach(function (s) { if (!s.hidden) s.open = open; }); if (!open) { $$('details.gd-unit', g).forEach(function (u) { u.open = false; }); var ub = $('[data-gd=units]', g); if (ub) ub.setAttribute('aria-pressed', 'false'); } }
  GD.bulk = false; gdMeasure(); gdSpy();
  if (!open && what !== 'units') gdSetSub({ term: '' });
}
function gdCopyLink(id) {
  var url = location.href.split('#')[0] + '#reading=' + S.reading + '&section=' + encodeURIComponent(id), done = function () { announce('Link to this section copied.'); }, g = gdRoot();
  gdSetSub({ section: id, term: '' });
  var fallback = function () { try { var ta = document.createElement('textarea'); ta.value = url; ta.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); } catch (e) { announce('Copy failed. The address bar holds the link.'); } };
  try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fallback); else fallback(); } catch (e) { fallback(); }
  var b = g && $('[data-gd-link="' + id + '"]', g); if (b) { b.classList.add('done'); setTimeout(function () { b.classList.remove('done'); }, 1400); }
}
function gdApply(params, fresh) {
  var g = gdRoot(); if (!g) return; gdMeasure();
  var q = params && params.get('q'), term = params && params.get('term'), sec = params && params.get('section');
  if (q != null && q !== '') { gdFilter(q, true); gdState().q = q.trim(); }
  var go = function () {
    var did = false;
    if (term) did = gdOpenTerm(term, { quiet: true });
    if (!did && sec) did = gdOpenSection(sec, { quiet: true });
    if (!did && fresh) { if (gdIsDesktopScroll()) readingView.scrollTop = 0; else window.scrollTo(0, 0); }
    gdSpy();
  };
  requestAnimationFrame(function () { requestAnimationFrame(go); });
}
function guideShow(mode, params) {         // called by openReading(): render once, then just re-apply deep-link parameters
  if (params && !(params.get('term') || params.get('section') || params.get('q') || (mode === 'fails' && (params.get('by') || params.get('kind') || params.get('stage'))))) params = null;      // a bare #reading=<guide> is not a deep link
  GD.params = params;
  var g = gdRoot(), fresh = !g || readingView.dataset.guide !== mode;
  readingView.classList.add('gd-host');
  if (fresh) {
    try { readingView.innerHTML = gdRender(mode, params); }
    catch (err) { readingView.innerHTML = '<div class="gd"><div class="gd-main"><p class="notice">This guide could not be built from the data (' + esc(err && err.message) + ').</p></div></div>'; }
    readingView.dataset.guide = mode; gdTicks(readingView);
    var root = gdRoot(); if (root && $('.gd-sec', root)) { gdIndex(root); gdMeasure(); if (mode === 'breaks') bkSync(); if (mode === 'fails') flSync(); }
    GD.st[mode] = { section: '', term: '', q: '' };
  }
  gdWire();
  if (mode === 'fails' && params && !fresh) { FLF = { by: params.get('by') || '*', kind: params.get('kind') || '*', stage: params.get('stage') || '*' }; flSync(); }
  if (params) gdApply(params, fresh);
  else if (fresh) { readingView.scrollTop = 0; try { window.scrollTo(0, 0); } catch (e) { /* ignore */ } requestAnimationFrame(function () { gdMeasure(); gdSpy(); }); }
  else requestAnimationFrame(function () { try { if (gdIsDesktopScroll()) readingView.scrollTop = GD.pos[mode] || 0; else window.scrollTo(0, GD.pos[mode] || 0); } catch (e) { /* ignore */ } gdMeasure(); gdSpy(); });
}
function gdShowSpine(cid) {                // the whole-system map with its main path switched on
  openChart(cid, null, { push: true });
  if (C && C.rg && C.rg.spine && !C.rg.spineOn && typeof rdSpine !== 'undefined') rdSpine.click();
}
function gdEnFilter(btn) {                  // chips on the endings lists (Narrative, Operations): outcome, stops / hands back, who hears. Each row of chips filters on its own; they combine.
  var sec = btn.closest('.gd-sec'), grp = btn.closest('.en-chips'); if (!sec || !grp) return;
  $$('.bk-chip', grp).forEach(function (c) { var on = c === btn; c.classList.toggle('on', on); c.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  var f = { out: '*', by: '*', end: '*' };
  $$('.en-chips .bk-chip.on', sec).forEach(function (c) { if (c.dataset.enOut != null) f.out = c.dataset.enOut; if (c.dataset.enBy != null) f.by = c.dataset.enBy; if (c.dataset.enEnd != null) f.end = c.dataset.enEnd; });
  $$('.en-row', sec).forEach(function (r) { r.classList.toggle('bk-off', (f.out !== '*' && r.dataset.out !== f.out) || (f.by !== '*' && r.dataset.by !== f.by) || (f.end !== '*' && r.dataset.end !== f.end)); });
  $$('.bk-grp', sec).forEach(function (g) { var n = $$('.en-row', g).filter(function (r) { return !r.classList.contains('bk-off') && !r.hidden; }).length; g.classList.toggle('bk-off', !n); var gn = $('.bk-gn', g); if (gn) gn.textContent = n; });
  $$('.en-out', sec).forEach(function (o) { o.classList.toggle('bk-off', !$$('.en-row', o).some(function (r) { return !r.classList.contains('bk-off') && !r.hidden; })); });
}
function gdWire() {
  if (GD.wired) return; GD.wired = true;
  readingView.addEventListener('click', function (e) {
    var b = e.target.closest('button, a.gd-toc-a'); if (!b) return;
    if (b.classList.contains('gd-toc-a')) { e.preventDefault(); gdOpenSection(b.dataset.sec, { focus: true }); return; }
    var d = b.dataset;
    if (b.classList.contains('gd-back')) { openChart(S.lastChart, null, { push: true }); return; }          // the chart you were last looking at, even if the guide was kept while you browsed
    if (d.gdLink) { e.preventDefault(); gdCopyLink(d.gdLink); return; }
    if (d.gd) { if (d.gd === 'expand') gdBulk(true); else if (d.gd === 'collapse') gdBulk(false); else if (d.gd === 'units') { var on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', on ? 'true' : 'false'); gdBulk(on, 'units'); } else if (d.gd === 'print') window.print(); return; }
    if (d.gdGoto) { gdOpenSection(d.gdGoto, { focus: true }); return; }
    if (d.engage) { gdOpenEngage(d.engage, d.engageChart || null); return; }
    if (d.handle) { gdOpenEngage(d.handle, null); return; }
    if (d.reading) { openReading(d.reading, { push: true }); return; }
    if (d.light) { var lp = d.light.split('|'); gdLight(lp[0], lp[1]); return; }
    if (d.gdSpine) { gdShowSpine(d.gdSpine); return; }
    if (d.gdOff) { openChart(d.gdOff, null, { push: true }); if (typeof setOffTint === 'function') setOffTint(true); return; }
    if (d.walk) { startWalk(d.walk); return; }
    if (d.enOut != null || d.enBy != null || d.enEnd != null) { gdEnFilter(b); return; }
    if (d.chart) { openChart(d.chart, d.chartNode || null, { push: true, center: true }); return; }
  });
  readingView.addEventListener('input', function (e) { if (e.target.id === 'gdFilter') gdFilter(e.target.value); });
  readingView.addEventListener('keydown', function (e) {
    if (e.target.id === 'gdFilter' && e.key === 'Escape') { e.stopPropagation(); if (e.target.value) { e.target.value = ''; gdFilter(''); } else e.target.blur(); }
  });
  readingView.addEventListener('toggle', function (e) {            // a glossary card opened by hand becomes the deep link
    var t = e.target; if (GD.bulk || !t.classList || !t.classList.contains('gd-card') || !t.dataset.term) return;
    var st = gdState(); if (t.open) gdSetSub({ term: t.dataset.term, section: '' }); else if (st.term === t.dataset.term) gdSetSub({ term: '' });
  }, true);
  ['wheel', 'touchstart', 'keydown'].forEach(function (ev) { readingView.addEventListener(ev, function (e) { if (ev !== 'keydown' || /^(Arrow|Page|Home|End| )/.test(e.key)) GD.pin = null; }, { passive: true }); });
  readingView.addEventListener('scroll', gdOnScroll, { passive: true }); window.addEventListener('scroll', gdOnScroll, { passive: true });
  window.addEventListener('resize', function () { if (S.reading) { gdMeasure(); gdSpy(); } });
  document.addEventListener('keydown', function (e) {
    if (!S.reading || e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    var f = $('#gdFilter'); if (f) { e.preventDefault(); f.focus(); f.select(); }
  });
  var openAll = function () { if (!S.reading || GD.print) return; GD.print = $$('details', readingView).map(function (d) { return [d, d.open]; }); GD.bulk = true; GD.print.forEach(function (p) { p[0].open = true; }); GD.bulk = false; };
  var restore = function () { if (!GD.print) return; GD.bulk = true; GD.print.forEach(function (p) { p[0].open = p[1]; }); GD.bulk = false; GD.print = null; };
  window.addEventListener('beforeprint', openAll); window.addEventListener('afterprint', restore);
  try { var mq = window.matchMedia('print'); var h = function (ev) { if (ev.matches) openAll(); else restore(); }; if (mq.addEventListener) mq.addEventListener('change', h); else if (mq.addListener) mq.addListener(h); } catch (e) { /* ignore */ }
}

/* ---- register the guides (viewer.js draws them under "Guides" before boot) -------------------------------------------- */
GUIDES.push({ id: 'narrative', label: 'Narrative', chip: railIcon('narrative', 'N'), title: 'The narrative' });
GUIDES.push({ id: 'glossary', label: 'Glossary', chip: railIcon('glossary', 'G'), title: 'Glossary' });
GUIDES.push({ id: 'scope', label: 'Evidence and scope', chip: railIcon('scope', 'E'), title: 'Evidence and scope' });
try { if (gdHasOps()) GUIDES.push({ id: 'ops', label: 'Operations', chip: railIcon('ops', 'O'), title: 'Operations' }); } catch (err) { /* the other guides still work */ }
