// The story check: every box and road of a story gets a verdict from the tool map, and the story is never rewritten.
//
//   const result = checkStory(story, { mapDir, root })     // a plain object; canonJson(result) gives the bytes
//
// A story is refused whole (no verdicts) when an id is used twice. A citation that leaves the root is refused on its own: the file is never opened.
import { Layer1, MapError } from './layer1.mjs';
import { RootedSource } from './source.mjs';
import { Seen } from './seen.mjs';
import { CodeNames } from './names.mjs';
import { checkBox, FOUND_WORDS } from './box.mjs';
import { checkRoad, JOIN_WORDS, MAX_ROUTE_HOPS, CITE_SLACK } from './road.mjs';
import { WHEN_LABEL } from './arm.mjs';
import { MAX_CALL_HOPS, MAX_CITE_HOPS } from './calls.mjs';
import { canonJson, sha256, cmp } from './canon.mjs';

export const CHECK_SCHEMA = 'faultline.story-check/2';
export const TOOL = 'story-check-1';

/** Flags that only describe what the tool could not compare; they show in the hover text but do not mark the page. */
export const NOTE_FLAGS = new Set(['label-shares-nothing-with-test', 'condition-on-step', 'condition-on-call', 'condition-on-exit', 'condition-nothing-to-compare', 'names-elsewhere', 'refs-apart', 'symbol-unknown']);
/** Flags on a joined road that question what the agent wrote on it (its label or its type), not where it runs. The page marks these with a small dot. */
export const WORD_FLAGS = new Set(['else-label-on-test-arm', 'test-label-on-else-arm', 'negation-on-positive-arm', 'positive-on-negative-arm', 'labels-look-swapped', 'success-words-on-error-road', 'says-return-tool-shows-raise', 'deliver-not-seen', 'record-not-seen']);
const POLARITY = new Set(['else-label-on-test-arm', 'test-label-on-else-arm', 'negation-on-positive-arm', 'positive-on-negative-arm']);
export const isMark = (flags) => flags.some((f) => !NOTE_FLAGS.has(f) && !f.endsWith('-unsure'));

export const CANNOT_SEE = [
  'It does not read what a title, a sentence or a condition means. Those are the agent\'s words and are carried through unchanged.',
  'A road marked joined says the two cited lines are joined in the tool map. It does not say the agent describes the step correctly.',
  'A flipped condition is seen only when the label is an "else" word on the tested side, a plain "no" or "not" on a side the tool shows as positive, a label that shares words with the test and has no "no", "not" or absence word on a side the tool shows as absent, or the test itself on the else side. A flip in other words is not seen.',
  'A road that stands on a road the tool is not sure of is passed on as related in the code, never as joined.',
];

const count = (m, k) => { m[k] = (m[k] ?? 0) + 1; };
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => cmp(a[0], b[0])));

function swapPass(roads) {
  const groups = new Map();
  for (const r of roads) {
    const t = r.when?.tool;
    if (r.when?.bound !== 'arm' || !t?.box || t.note) continue;
    if (!groups.has(t.box)) groups.set(t.box, []);
    groups.get(t.box).push(r);
  }
  for (const g of groups.values()) {
    const sides = new Set(g.map((r) => r.when.tool.side));
    if (sides.size < 2) continue;
    if (!g.some((r) => r.flags.some((f) => POLARITY.has(f)))) continue;
    for (const r of g) if (!r.flags.includes('labels-look-swapped')) { r.flags.push('labels-look-swapped'); r.when.compared = 'contradicts'; }
  }
}

function pathSummary(story, roads) {
  const order = ['none', 'related', 'route', 'line'];
  const pr = new Map();
  for (const r of roads) { const k = r.from + '\0' + r.to; (pr.get(k) ?? pr.set(k, []).get(k)).push(r.join); }
  return (story.paths ?? []).filter((p) => p && typeof p.id === 'string').map((p) => {
    const bx = Array.isArray(p.boxes) ? p.boxes : [];
    const hops = {};
    for (let i = 0; i + 1 < bx.length; i++) {
      const vs = pr.get(bx[i] + '\0' + bx[i + 1]);
      count(hops, vs ? vs.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a)) : 'no-road');
    }
    return { id: p.id, steps: bx.length, hops: sortObj(hops) };
  });
}

function headerText(S) {
  const j = S.join, f = S.found;
  const w = S.whenLabel.contradicts ?? 0;
  const a = `Story against the tool map: ${S.roads} roads: ${j.line} joined by the tool at the cited line, ${j.route} joined by a route, ${j.related} related in the code, ${j.none} no link found`;
  const b = w ? `; ${w} carry a label that contradicts the arm the tool draws` : '';
  const c = `. ${S.boxes} boxes: ${f.boxed} in a tool box, ${f.code} real code with no tool box, ${f.partial} partly found, ${f.none} not found`;
  return a + b + c + '. Titles, sentences and conditions are the agent\'s words and are not checked.';
}

/** The verdicts, or a refusal. `opts`: { mapDir, root, allowStale }. */
export function checkStory(story, opts) {
  const L = new Layer1(opts.mapDir);
  const src = new RootedSource(opts.root);
  const fresh = L.isFresh(src.root);
  const base = { schema: CHECK_SCHEMA, tool: TOOL };
  if (fresh === false && !opts.allowStale) {
    return { ...base, refused: [{ code: 'M-stale', msg: 'the files under the source root are not the ones the tool map was built from; build the map again', at: '' }] };
  }
  const ctx = { L, src, S: new Seen(L), names: new CodeNames(L, src) };
  const skip = new Set(story.boxes.flatMap((b) => [b.id, String(b.id).split('.').pop()]));
  const boxes = new Map();
  for (const b of story.boxes) boxes.set(b.id, checkBox(ctx, b, skip));
  const roads = story.routes.map((r) => checkRoad(ctx, r, boxes, MAX_ROUTE_HOPS));
  swapPass(roads);
  for (const r of roads) r.flags = [...new Set(r.flags)].sort(cmp);
  const S = { boxes: boxes.size, roads: roads.length, found: { boxed: 0, code: 0, partial: 0, none: 0 }, join: { line: 0, route: 0, related: 0, none: 0 }, whenLabel: {}, flags: {}, boxKinds: {}, roadTypes: {}, marked: { boxes: 0, roads: 0 } };
  for (const m of boxes.values()) {
    S.found[m.out.found]++;
    count(S.boxKinds, `${m.out.kind}/${m.out.found}`);
    for (const f of m.out.flags) count(S.flags, f);
    if (isMark(m.out.flags) || m.out.found === 'partial' || m.out.found === 'none') S.marked.boxes++;
  }
  for (const r of roads) {
    S.join[r.join]++;
    count(S.whenLabel, r.when.compared);
    count(S.roadTypes, `${r.type}/${r.join}`);
    for (const f of r.flags) count(S.flags, f);
    if (isMark(r.flags) || r.join === 'related' || r.join === 'none') S.marked.roads++;
  }
  S.whenLabel = sortObj(S.whenLabel); S.flags = sortObj(S.flags); S.boxKinds = sortObj(S.boxKinds); S.roadTypes = sortObj(S.roadTypes);
  S.paths = pathSummary(story, roads);
  S.header = headerText(S);
  S.cannotSee = CANNOT_SEE;
  return {
    ...base,
    map: { sourceDigest: L.digest, fresh: fresh === true ? true : fresh === false ? false : null, boxes: L.boxes.size, roads: L.roads.size },
    story: { sha256: sha256(canonJson({ boxes: story.boxes, routes: story.routes, paths: story.paths ?? [] })), boxes: story.boxes.length, roads: story.routes.length },
    limits: { maxRouteHops: MAX_ROUTE_HOPS, citeSlack: CITE_SLACK, maxCallHops: MAX_CALL_HOPS, maxCiteHops: MAX_CITE_HOPS },
    vocabulary: { found: FOUND_WORDS, join: JOIN_WORDS, when: WHEN_LABEL },
    summary: S,
    boxes: Object.fromEntries([...boxes].sort((a, b) => cmp(a[0], b[0])).map(([id, m]) => [id, m.out])),
    roads: Object.fromEntries(roads.map((r) => [r.id, r]).sort((a, b) => cmp(a[0], b[0]))),
  };
}

export { MapError };
