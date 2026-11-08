// chartsFromModel(model) -> [{id, title, summary, kind: overview|stage|whole|detail, boxes, routes, ...}]
// The tool always makes: overview (one box per stage plus one per kind of ending), one chart per stage (split above 21 boxes into families,
// see split.mjs; each part is named for its first box or the box field partName), and whole (every box). The model's own optional `charts` become detail views. Boxes and routes are the model's own
// objects (the overview's are synthesised, in the same shape), so ids are stable and shared by every view.
import { mainPath, orderedStages, stageIdOf, slug, trunc, uniq } from './util.mjs';
import { splitStage, readingOrder, entryOf } from './split.mjs';
export { readingOrder };

export const MAX_BOXES = 21;
export const OVERVIEW_ROAD_FACTOR = 2.2;   // the overview draws at most ceil(2.2 x its boxes) roads (docs/SCALE.md)
const TYPE_PICK = ['forward', 'deliver', 'record', 'return'];
const OUTCOME_WORD = { success: 'Success', failure: 'Failure', refusal: 'Refusal', neutral: 'Neutral' };

function bestType(rs) { const ts = rs.map((r) => r.type || 'forward'); return TYPE_PICK.find((t) => ts.includes(t) && (t !== 'return' || ts.every((x) => x === 'return'))) || 'forward'; }

// The overview cannot draw every stage pair at scale. It draws at most ceil(factor x boxes) roads: first the consecutive stages on the main
// path, then each box's strongest road out and in (by routes carried), then the rest by routes carried. The other roads are not lost: they
// come back as notDrawn [{id, from, to, count, when}] (busiest first). mainNodes is the main path mapped to overview boxes, in order.
export function capOverviewRoads(boxes, roads, mainNodes = [], factor = OVERVIEW_ROAD_FACTOR) {
  const cap = Math.ceil(factor * boxes.length);
  if (roads.length <= cap) return { drawn: roads, notDrawn: [], cap };
  // the main path's own stage-to-stage roads are always kept, even past the cap: the Main path toggle on the overview must light a connected line
  const at = new Map(roads.map((r, i) => [r, i])), carried = (r) => (r.via || []).length || 1;
  const byCount = (a, b) => carried(b) - carried(a) || at.get(a) - at.get(b);
  const chosen = new Set();
  const take = (r, always) => { if (r && (always || chosen.size < cap)) chosen.add(r); };
  const key = (a, b) => JSON.stringify([a, b]), byPair = new Map(roads.map((r) => [key(r.from, r.to), r]));
  const run = []; for (const n of mainNodes) if (run[run.length - 1] !== n) run.push(n);
  for (let i = 0; i + 1 < run.length; i++) take(byPair.get(key(run[i], run[i + 1])), true);
  const strongest = new Set();
  for (const b of boxes) {
    const o = roads.filter((r) => r.from === b.id).sort(byCount)[0], n = roads.filter((r) => r.to === b.id).sort(byCount)[0];
    if (o) strongest.add(o); if (n) strongest.add(n);
  }
  [...strongest].filter((r) => !chosen.has(r)).sort(byCount).forEach((r) => take(r));
  roads.filter((r) => !chosen.has(r)).sort(byCount).forEach((r) => take(r));
  return { cap, drawn: roads.filter((r) => chosen.has(r)), notDrawn: roads.filter((r) => !chosen.has(r)).sort(byCount).map((r) => ({ id: r.id, from: r.from, to: r.to, count: carried(r), when: r.when || '' })) };
}

export function chartsFromModel(model, opts = {}) {
  const max = opts.maxBoxes ?? MAX_BOXES;
  const sysCharts = (model.system && model.system.charts) || {};                    // model.system.charts {stage:false, whole:false}: a reading layer that serves stages as lists and draws only the charts people open
  const wantStage = (opts.stageCharts ?? sysCharts.stage) !== false, wantWhole = (opts.whole ?? sysCharts.whole) !== false;
  const boxes = model.boxes || [], boxIds = new Set(boxes.map((b) => b.id)), routes = (model.routes || []).filter((r) => boxIds.has(r.from) && boxIds.has(r.to));   // a Set, not boxes.some() per road
  const byId = new Map(boxes.map((b) => [b.id, b])), stages = orderedStages(model), main = mainPath(model);
  const stageOf = (id) => stageIdOf(model, byId.get(id));
  // each stage's boxes and its inside roads, bucketed ONCE (same order as the old per-stage filters): the old code filtered every box and every road once per stage
  const boxesOfStage = new Map(), roadsInStage = new Map();
  for (const b of boxes) { const s = stageIdOf(model, b); if (!boxesOfStage.has(s)) boxesOfStage.set(s, []); boxesOfStage.get(s).push(b); }
  for (const r of routes) { const a = stageOf(r.from); if (a === stageOf(r.to)) { if (!roadsInStage.has(a)) roadsInStage.set(a, []); roadsInStage.get(a).push(r); } }
  const used = new Set(), charts = [];
  const idFor = (want) => { let id = want, n = 2; while (used.has(id)) id = `${want}_${n++}`; used.add(id); return id; };
  const sys = model.system || {};

  // ---- overview: a box per stage, a box per kind of ending, aggregated hand-offs
  const ovBoxes = [], ovRoutes = [], nodeOfBox = new Map();
  const taken = new Set(stages.map((s) => s.id));
  for (const s of stages) {
    const mine = boxesOfStage.get(s.id) || [];
    if (!mine.length) continue;
    const refs = []; for (const b of mine) for (const r of b.refs || []) if (refs.length < 3 && !refs.some((x) => x.path === r.path && x.symbol === r.symbol)) refs.push(r);
    const titles = mine.slice(0, 4).map((b) => b.title).join(', ');
    ovBoxes.push({ id: s.id, kind: 'step', status: 'live', title: trunc(s.title || s.id, 64), plain: trunc(s.blurb || `${mine.length} boxes: ${titles}.`, 260),
      why: `${mine.length} boxes in this stage. Open it for the detail.`, stage: s.id, refs, synth: 'stage', boxes: mine.map((b) => b.id) });
    mine.forEach((b) => nodeOfBox.set(b.id, s.id));
  }
  const ends = boxes.filter((b) => b.kind === 'end');
  for (const oc of ['success', 'failure', 'refusal', 'neutral']) {
    const es = ends.filter((b) => (b.outcome || 'neutral') === oc);
    if (!es.length) continue;
    let id = `end_${oc}`; while (taken.has(id)) id += '_';
    taken.add(id);
    const one = es.length === 1;
    ovBoxes.push({ id, kind: 'end', status: 'live', title: one ? trunc(es[0].title, 64) : `${OUTCOME_WORD[oc]} endings (${es.length})`,
      plain: trunc(one ? es[0].plain : `Where the system finishes with outcome ${oc}: ${es.map((b) => b.title).join('; ')}.`, 260),
      why: one ? '' : `${es.length} end boxes share the outcome ${oc}.`, outcome: oc, refs: es[0].refs || [], synth: 'outcome', boxes: es.map((b) => b.id) });
    es.forEach((b) => nodeOfBox.set(b.id, id));
  }
  const agg = new Map();
  for (const r of routes) {
    const a = stageOf(r.from), t = byId.get(r.to), b = t.kind === 'end' ? nodeOfBox.get(r.to) : stageOf(r.to);
    if (!a || !b || a === b) continue;
    const k = a + '\u0000' + b;
    if (!agg.has(k)) agg.set(k, { a, b, rs: [] });
    agg.get(k).rs.push(r);
  }
  const mainSet = new Set(main);
  for (const { a, b, rs } of agg.values()) {
    const pick = rs.find((r) => r.when && mainSet.has(r.from) && mainSet.has(r.to)) || rs.find((r) => r.when) || rs[0];
    const many = uniq(rs.map((r) => r.when).filter(Boolean)).length;
    ovRoutes.push({ id: `o:${a}>${b}`, from: a, to: b, type: bestType(rs), when: many > 1 ? `${trunc(pick.when || '', 22)} +${many - 1}` : trunc(pick.when || '', 28),
      why: rs.length === 1 ? (pick.why || '') : `${rs.length} roads carry this stage-to-stage road: ${rs.slice(0, 4).map((r) => r.id).join(', ')}${rs.length > 4 ? ', ...' : ''}.`,
      inferred: rs.every((r) => r.inferred), via: rs.map((r) => r.id) });
  }
  const spineOv = uniq(main.map((id) => nodeOfBox.get(id)).filter(Boolean));
  // the main path stage by stage: consecutive distinct stages, repeats kept (the order the walk really takes them). An end box with a road out hands back to its caller, so it counts
  // as its own stage; only the path's last box, an end with no road out, is the ending node.
  const hasOut = new Set(routes.map((r) => r.from));
  const mainNode = (id) => { const b = byId.get(id); if (!b) return null; return b.kind === 'end' && !hasOut.has(id) ? nodeOfBox.get(id) : stageOf(id); };   // a path naming a box that is not in the model (a partial load) is skipped
  const mainRun = []; for (const n of main.map(mainNode).filter(Boolean)) if (mainRun[mainRun.length - 1] !== n) mainRun.push(n);
  const capped = capOverviewRoads(ovBoxes, ovRoutes, main.map(mainNode).filter(Boolean), opts.overviewFactor ?? sysCharts.overviewFactor);
  const ovNote = capped.notDrawn.length ? ` Shows ${capped.drawn.length} of ${ovRoutes.length} stage-to-stage roads (each bundles every road between the same two stages): the main path, each stage's busiest roads in and out, then the busiest others. ${capped.notDrawn.length} not drawn here; select a stage to list all of its roads.` : '';
  charts.push({ id: idFor('overview'), spine: spineOv.length > 1 ? spineOv : undefined, mainRun, title: sys.name ? `${sys.name} at a glance` : 'The system at a glance',
    summary: (trunc(sys.summary || sys.tagline || '', 400 - ovNote.length) + ovNote).trim(), kind: 'overview', boxes: ovBoxes, routes: capped.drawn, notDrawn: capped.notDrawn });

  // ---- one chart per stage; above `max` boxes it is split into parts
  for (const s of (wantStage ? stages : [])) {
    const mine = boxesOfStage.get(s.id) || [];
    if (!mine.length) continue;
    const inStage = roadsInStage.get(s.id) || [];
    const parts = mine.length <= max ? [mine.map((b) => b.id)] : splitStage(mine, inStage, main, max);
    const base = `stage_${slug(s.id)}`, many = parts.length > 1;
    const order = many ? readingOrder(mine, inStage, main) : [], at = new Map(order.map((id, i) => [id, i])), names = new Set();
    parts.forEach((ids, i) => {
      const set = new Set(ids), pb = mine.filter((b) => set.has(b.id));
      const pr = inStage.filter((r) => set.has(r.from) && set.has(r.to));
      let name = '', note = '', nameBox = null, nameDup = null, nameOther = [], first = [];
      if (many) {   // the box field partName if any box of the part has one (first in reading order), else the title of the part's entry box
        const given = (b) => model.partNames?.[b.id] || b.partName;   // model.partNames {boxId: name} names a part from one place, without touching the stage's own files
        const has = (b) => typeof given(b) === 'string' && given(b).trim();
        const ordered = pb.slice().sort((x, y) => at.get(x.id) - at.get(y.id)), named = ordered.find(has);
        name = trunc((named ? given(named) : byId.get(entryOf(ids, order)).title || '').trim(), 48);
        first = ordered.slice(0, 4).map((b) => b.id);                         // the part's first boxes in reading order: what `faultline parts` shows
        nameBox = named ? named.id : null;                                  // which box gave the name (null: the entry box's title); parts and W-part-name read it
        nameOther = named ? ordered.filter((b) => b !== named && has(b) && trunc(given(b).trim(), 48) !== name).map((b) => ({ box: b.id, name: trunc(given(b).trim(), 48) })) : [];
        if (names.has(name)) { nameDup = name; name = `${name} (${i + 1})`; }  // the same name twice in one stage: kept apart by a number here, and flagged (W-part-name)
        names.add(name);
        const noteOf = (b) => { const t = model.partNotes?.[b.id]; return typeof t === 'string' ? t.trim() : ''; };   // model.partNotes {boxId: "one line"}: what this part is for, read like partNames; it is not part of the geometry key
        const noted = pb.slice().sort((x, y) => at.get(x.id) - at.get(y.id)).find((b) => noteOf(b));
        note = noted ? trunc(noteOf(noted), 160) : '';
      }
      const loose = many && pb.length > 1 && !pr.length ? ' None of these boxes has a road to another box in this stage.' : '';
      const tail = `${pb.length} boxes, ${pr.length} roads.${loose}`, lead = trunc(note || s.blurb || '', 399 - tail.length);   // the counts always survive the cut; a part's own note replaces the stage blurb
      charts.push({ id: idFor(many ? `${base}_${i + 1}` : base), title: many ? `${s.title}: ${name}` : s.title,
        summary: `${lead} ${tail}`.trim(),
        kind: 'stage', stage: s.id, part: i + 1, parts: parts.length, ...(many ? { name, entry: first[0], first, nameBox, ...(nameDup ? { nameDup } : {}), ...(nameOther.length ? { nameOther } : {}) } : {}), ...(note ? { note } : {}), boxes: pb, routes: pr });
    });
  }

  // ---- the model's own extra views
  for (const c of model.charts || []) {
    const set = new Set((c.boxes || []).filter((id) => byId.has(id)));
    if (!set.size) continue;
    const pb = boxes.filter((b) => set.has(b.id));
    charts.push({ id: idFor(c.id && !/^(overview|whole)$/.test(c.id) ? c.id : `detail_${slug(c.id || c.title || 'view')}`), title: c.title || c.id, summary: trunc(c.summary || '', 400),
      kind: 'detail', role: c.role || 'detail', boxes: pb, routes: routes.filter((r) => set.has(r.from) && set.has(r.to)) });
  }

  // ---- whole
  if (wantWhole) charts.push({ id: idFor('whole'), title: sys.name ? `All of ${sys.name} on one map` : 'The whole system', summary: trunc(sys.summary || '', 400), kind: 'whole', boxes, routes });
  return charts;
}

// the chart a deep link for a box should open: its stage chart, else a detail view, else the whole map
export function homeChart(charts, boxId) {
  const rank = { stage: 0, detail: 1, whole: 2 };
  let best = null;
  for (const c of charts) {
    if (rank[c.kind] === undefined || !c.boxes.some((b) => b.id === boxId)) continue;
    if (!best || rank[c.kind] < rank[best.kind]) best = c;
  }
  return best ? best.id : null;
}
