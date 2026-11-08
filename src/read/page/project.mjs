// From a reading (reading.json, charts.json) to a Faultline project: stages, boxes, roads, loops, one chart per drawn part, terms and who-hears entries.
// Pure: returns the model fragments and the side tables the page needs (confidence per box and road, chart of each function).
import { clip, cmp } from '../util.mjs';
import { plural } from '../../build/util.mjs';

export const HANDLE_MAX = 40;
export const OVERVIEW_FACTOR = 1.4;   // roads drawn on the stage overview per stage box (the busiest first); the rest are listed in the Details panel
export const PLAIN_MAX = 260;   // the model's limit for one box's plain text; the full wording goes in `why`
const WHEN_WORDS = { 'may call': 'possibly calls' };   // a road label must name a condition, not describe the box, so it cannot open with "may"
const HEARD_BY = { person: 'person', caller: 'caller', event: 'event', log: 'log', nobody: 'nobody', someone: 'unclear' };
const OUTCOMES = new Set(['success', 'failure', 'refusal', 'neutral']);

/** "line 12 of src/a.ts" style location text. */
const where = (b) => `${b.path}:${b.line}`;

/** Why a box exists, in plain words: said only for the boxes that stand for something other than a step of the function; nothing for an ordinary box. */
export function whyOf(b) {
  if (b.shape === 'card') return 'A call into another function (a card).';
  if (b.shape === 'stub') return 'An exit that the decision above folds into itself.';
  if (b.shape === 'open') return 'The function carries on here, but the tool could not follow these calls. This is not an ending.';
  if (b.shape === 'more') return 'Calls into other functions, gathered into one card.';
  if (b.shape === 'link') return 'The function continues in another part of its chart.';
  return '';   // an ordinary box has nothing to say here; the tool's own phrase for it is kept in `prov.raw`, out of the reader's way
}

/** Loop regions of one chart part: the loop box plus the boxes of its body that lead back to it. */
export function loopsOfPart(part) {
  const out = [];
  const fwd = new Map();
  const rev = new Map();
  for (const r of part.roads) {
    if (!fwd.has(r.from)) fwd.set(r.from, []);
    if (!rev.has(r.to)) rev.set(r.to, []);
    fwd.get(r.from).push(r);
    rev.get(r.to).push(r.from);
  }
  for (const b of part.boxes) {
    if (b.shape !== 'own' || b.rule !== 'loop') continue;
    const back = new Set([b.id]);
    const q = [b.id];
    while (q.length) for (const p of rev.get(q.shift()) ?? []) if (!back.has(p)) { back.add(p); q.push(p); }
    const body = new Set([b.id]);
    const starts = (fwd.get(b.id) ?? []).filter((r) => r.when === 'each time round').map((r) => r.to);
    const stack = [...starts];
    while (stack.length) {
      const x = stack.pop();
      if (body.has(x) || !back.has(x)) continue;
      body.add(x);
      for (const r of fwd.get(x) ?? []) stack.push(r.to);
    }
    out.push({ box: b, members: [...body].sort(cmp) });
  }
  return out;
}

/**
 * Per box: the reasons it is not confident, from the claim register. Roads: a road the tool could only guess is "may".
 * @returns {{boxes: Map<string, string[]>, claimsByBox: Map<string, object[]>}}
 */
export function boxConfidence(claims) {
  const boxes = new Map();
  for (const c of claims) {
    if (c.conf !== 'not-confident' || !c.subject || /[:\s]/.test(c.subject) || c.subject.includes('->')) continue;
    if (!boxes.has(c.subject)) boxes.set(c.subject, []);
    const why = String(c.why || c.reason || '').trim();
    const says = String(c.says || '').trim();
    const line = says ? (why ? `${says}: ${why}` : says) : why;
    if (line && !boxes.get(c.subject).includes(line)) boxes.get(c.subject).push(line);
  }
  return boxes;
}

/**
 * @param {{reading:object, charts:object, claims:object[], name?:string, tagline?:string, wordsBy?:string|null, toolMap:object}} d
 */
export function buildModel({ reading, charts, claims, name, tagline, wordsBy = null, toolMap }) {
  const fnRow = new Map(charts.functions.map((f) => [f.fid, f]));
  const conf = boxConfidence(claims);
  const stages = reading.districts.list.map((d, i) => ({
    id: d.id, title: d.title, order: i + 1,
    blurb: `${plural(d.functions, 'function')}, ${plural(d.boxes, 'box', 'boxes')}, ${d.entries} with no caller in the code.`,
  }));

  // entry box of each drawn function, so a card can open the function's own chart
  const entryOf = new Map();
  const chartOf = new Map();
  for (const c of charts.charts) {
    chartOf.set(c.fid, c.id);
    for (const p of c.parts) for (const b of p.boxes) if (b.entry && b.shape === 'own') entryOf.set(c.fid, b.id);
  }

  const boxes = [];
  const routes = [];
  const loops = [];
  const modelCharts = [];
  const heardBy = {};
  const notConfident = { boxes: {}, roads: {} };
  const failing = new Map(reading.endings.failing.map((f) => [f.box, f]));
  const pageOfRef = new Map();
  let nRoad = 0;

  for (const c of charts.charts) {
    const fn = fnRow.get(c.fid);
    for (const p of c.parts) {
      const ids = [];
      for (const b of p.boxes) {
        const full = b.plain || b.title;
        const nb = {
          id: b.id, stage: b.district, kind: b.kind === 'open' ? 'step' : b.kind, title: clip(b.title, 40), status: 'live', plain: clip(full, PLAIN_MAX), why: `${whyOf(b)}${full.length > PLAIN_MAX ? ` Full wording: ${full}` : ''}`.trim(),
          refs: [{ path: b.path, line: b.line }],
          prov: { rule: b.shape === 'own' ? b.rule : b.shape, src: 'reading', fn: b.fn ?? c.fid, line: b.line, ...(b.raw && b.raw !== b.title ? { raw: clip(b.raw, 80) } : {}) },
        };
        if (b.entry && b.shape === 'own') nb.handle = clip(fn.label, HANDLE_MAX);
        if (b.outcome && OUTCOMES.has(b.outcome)) nb.outcome = b.outcome;
        else if (b.outcome === 'mixed') nb.outcome = 'neutral';
        if (b.ref) {
          pageOfRef.set(b.ref, b.id);
          const f = failing.get(b.ref);
          const h = f?.whoHears;
          if (h && HEARD_BY[h.value]) {
            const sure = h.confidence === 'confident';
            heardBy[b.id] = { by: HEARD_BY[h.value], how: `${h.detail}${sure ? '' : ' (not confident)'}` };
          }
          const why = conf.get(b.ref);
          if (why) notConfident.boxes[b.id] = why;
        }
        if (b.shape === 'card' && !b.sure) notConfident.boxes[b.id] = ['The tool could not say that this function is the one called here: several functions could be, or the call is not proven.'];
        ids.push(b.id);
        boxes.push(nb);
      }
      for (const r of p.roads) {
        const id = `r${++nRoad}`;
        const may = r.tier === 'may';
        const tierWhy = { proven: 'A road the tool is sure of.', may: 'A road the tool could not be sure of: the call may run any of several functions.', linked: 'Joined by the tool from a name written in the code (an HTTP path, a script name, an event).', open: 'The function carries on here; the call was not followed.' }[r.tier] ?? 'A road.';
        routes.push({ id, from: r.from, to: r.to, type: r.type, when: clip(WHEN_WORDS[r.when] ?? r.when, 28), why: tierWhy, refs: [], inferred: r.tier !== 'proven', prov: { rule: r.via, src: 'reading', tier: r.tier } });
        if (may) notConfident.roads[id] = [tierWhy];
      }
      for (const b of p.boxes) {
        if (b.shape === 'card' && b.target) {
          const to = entryOf.get(b.target);
          if (to) routes.push({ id: `r${++nRoad}`, from: b.id, to, type: 'forward', when: 'opens', why: 'The card stands for a function that has its own chart; this road opens it.', refs: [], inferred: false, prov: { rule: 'card-link', src: 'reading', tier: 'proven' } });
        }
      }
      for (const L of loopsOfPart(p)) {
        const t = L.box.title.replace(/^loop:\s*/i, '');
        loops.push({ id: `l_${L.box.id}`, title: clip(`loop: ${t}`, 60), blurb: `${fn.label} (${fn.path}:${L.box.line})`, boxes: L.members, limit: t });
      }
      modelCharts.push({ id: p.id, title: p.title, summary: `${c.summary}${c.parts.length > 1 ? ` Part ${p.id === c.parts[0].id ? 1 : c.parts.findIndex((x) => x.id === p.id) + 1} of ${c.parts.length}.` : ''}`, role: 'flow', boxes: ids });
    }
  }

  // a term is named by the word it defines, and two spellings of one word are one term: keep the one that has a meaning from the code
  const termByKey = new Map();
  for (const t of reading.glossary?.terms ?? []) {
    const k = t.term.toLowerCase();
    if (!termByKey.has(k) || (!termByKey.get(k).meaning && t.meaning)) termByKey.set(k, t);
  }
  const terms = [...termByKey.values()].map((t) => ({
    term: t.term,
    meaning: t.meaning
      ? `${t.meaningKind === 'used' ? 'Not a definition; how the docs use it: ' : ''}${t.meaning} (From ${t.meaningFrom}.)`
      : `No comment or document says what this is. It appears in ${t.usage.files} files${t.usage.examples?.length ? `, for example ${t.usage.examples.slice(0, 3).join(', ')}` : ''}.`,
    ...(t.meaningFrom ? { family: t.meaningFrom } : {}),
  }));

  const system = { toolMap: true, charts: { stage: false, whole: false, overviewFactor: OVERVIEW_FACTOR }, name, tagline, summary: toolMap.summary, purpose: reading.system.purpose?.text ?? '' };
  return {
    system: { schema: 'faultline.model/1', system },
    flows: { schema: 'faultline.model/1', stages, boxes, routes, loops, charts: modelCharts, terms, heardBy },
    notConfident, chartOf, wordsBy, pageOfRef,
  };
}
