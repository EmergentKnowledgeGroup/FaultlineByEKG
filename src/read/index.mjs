// The reading rules: from a tool map (model + claims), the source tree, and optionally the scanner's facts and signals, to a reading a page can show.
// Everything here is a pure function of its inputs: the same inputs give the same bytes.
import { Source } from './source.mjs';
import { buildWorld } from './world.mjs';
import { buildNames } from './names.mjs';
import { CallModel } from './callsites.mjs';
import { classifyEnds } from './outcomes.mjs';
import { buildBoxWords } from './boxwords.mjs';
import { Walker } from './walk.mjs';
import { findTriggers } from './entries.mjs';
import { buildJourneys, reachFromEntries } from './journeys.mjs';
import { findPurpose, findName } from './purpose.mjs';
import { findExamples } from './examples.mjs';
import { whoHears, hearsSentence } from './hears.mjs';
import { findSwitches } from './switches.mjs';
import { buildTriage } from './triage.mjs';
import { buildGlossary } from './glossary.mjs';
import { makeDistricts, DISTRICT_RULE } from './districts.mjs';
import { nameStages } from './stagewords.mjs';
import { buildCharts } from './charts.mjs';
import { buildNumbers, statementsOf } from './numbers.mjs';
import { journeyText } from './text.mjs';
import { cmp, tally } from './util.mjs';

export const READING_SCHEMA = 'faultline.reading/1';

/**
 * @param {{model:object, claims:object[], facts?:object|null, signals?:object|null, sourceRoot?:string|null, name?:string}} input
 * @returns {{reading:object, charts:object, words:object, text:string}}
 */
export function readSystem(input) {
  const source = new Source(input.sourceRoot ?? null);
  const W = buildWorld({ model: input.model, claims: input.claims ?? [], facts: input.facts ?? null, signals: input.signals ?? null, calls: input.calls ?? null, spans: input.spans ?? null, source });
  const names = buildNames(W);
  const CM = new CallModel(W, names);

  // endings, words, who hears
  const E = classifyEnds(W, names);
  const endsByBox = new Map(E.ends.map((e) => [e.box, e]));
  const words = buildBoxWords(W, names, endsByBox);

  // districts
  const info = new Map(W.mappedIds.map((f) => [f, { path: W.fns.get(f).path, qual: W.fns.get(f).qual }]));
  const wcalls = new Map();
  for (const a of W.mappedIds) {
    for (const r of W.calleesOf.get(a) ?? []) {
      const b = W.fnOf(r.to);
      if (b && b !== a && info.has(b)) wcalls.set(`${a}\u0000${b}`, (wcalls.get(`${a}\u0000${b}`) ?? 0) + 1);
    }
  }
  const districts = makeDistricts(info, wcalls);
  const stageWords = nameStages({ W, districts });

  // journeys
  const T = findTriggers(W, CM, names, words);
  const walker = new Walker({ W, CM, names, words, ends: endsByBox });
  // the route an ending sits under: the route decision whose arm holds its line
  const routeBoxes = new Map();
  for (const fid of W.mappedIds) for (const b of W.fns.get(fid).boxes) if (words.get(b.id)?.route) routeBoxes.set(fid, [...(routeBoxes.get(fid) ?? []), { box: b, label: words.get(b.id).route.label }]);
  const routeOf = (fid, line) => {
    let best = null;
    for (const r of routeBoxes.get(fid) ?? []) {
      const t = walker.armInfo(r.box)?.then;
      if (t && line >= t[0] && line <= t[1] && (!best || t[1] - t[0] < best.span)) best = { label: r.label, span: t[1] - t[0] };
    }
    return best?.label ?? '';
  };
  const hears = whoHears(W, E.ends, routeOf, names);
  const examples = findExamples(source);
  const J = buildJourneys({ W, walker, triggers: T.triggers, names, examples });
  const reach = reachFromEntries({ W, CM, entryFids: [...T.triggers.map((t) => (t.lambda === undefined ? t.fid : t.fid)), ...T.uncalled] });
  const extraHot = new Set();
  for (const j of J.journeys) for (const s of j.steps) if (s.kind === 'enter' && s.mapped) extraHot.add(s.fid);

  // charts, outlines
  const C = buildCharts({ W, CM, names, words, ends: endsByBox, districts, extraHot, budget: input.chartBytes ?? undefined });
  const pageId = (boxId) => C.pageBoxOf.get(boxId)?.id ?? null;
  for (const j of J.journeys) for (const s of j.steps) if (s.box) s.pageBox = pageId(s.box);

  // the other readings
  const purpose = findPurpose(source, input.facts ?? null);
  const systemName = findName(source);
  const switches = findSwitches(W, words);
  const triage = buildTriage(W, names);
  const glossary = buildGlossary(W, names, words);
  const claims = input.claims ?? [];
  const numbers = buildNumbers({ W, ends: E.ends, sites: E.sites, hears, journeys: J, triggers: T.triggers, uncalled: T.uncalled, reach, switches, triage, glossary, charts: C, districts, claims, purpose });
  const statements = statementsOf(numbers, input.notes ?? []);

  // engine gaps: every hop a journey needed that the map does not draw
  const gapMap = new Map();
  for (const j of J.journeys) {
    for (const g of j.gaps) {
      const k = `${g.path}:${g.line}:${g.from}:${g.to}`;
      if (!gapMap.has(k)) gapMap.set(k, { ...g, journeys: [] });
      gapMap.get(k).journeys.push(j.id);
    }
  }
  const engineGaps = [...gapMap.values()].map((g) => ({ ...g, fromLabel: g.from ? names.label(g.from) : '', toLabel: g.to ? names.label(g.to) : '' })).sort((a, b) => cmp(a.path, b.path) || a.line - b.line || cmp(a.to, b.to));

  const failing = hears.rows.map((r) => ({
    box: r.box, page: pageId(r.box), fn: r.fnLabel, where: `${r.path}:${r.line}`, outcome: r.outcome, title: r.title, plain: r.plain, route: r.route, status: r.status, shared: r.shared,
    whoHears: { value: r.hears.value, detail: r.hears.detail, confidence: r.hears.confidence },
  }));

  const reading = {
    schema: READING_SCHEMA,
    inputs: { modelTool: input.model.tool ?? null, modelSchema: input.model.schema ?? null, claims: claims.length, facts: !!input.facts, signals: !!input.signals, calls: !!input.calls, spans: !!input.spans, source: !!input.sourceRoot },
    system: {
      name: input.name || systemName.name || input.model.system?.name || '', nameFrom: input.name ? 'given' : systemName.from, purpose, languages: numbers.read.languages, resolvers: input.model.system?.resolvers ?? {},
    },
    numbers,
    statements,
    districts: {
      rule: DISTRICT_RULE, prefix: districts.prefix.join('/'), trace: districts.trace,
      list: districts.order.map((id) => {
        const fns = W.mappedIds.filter((f) => districts.of.get(f) === id);
        const out = new Map();
        const inn = new Map();
        for (const f of fns) {
          for (const r of W.calleesOf.get(f) ?? []) {
            const g = W.fnOf(r.to);
            const d = districts.of.get(g);
            if (d && d !== id) out.set(d, (out.get(d) ?? 0) + 1);
          }
          for (const r of W.callersOf.get(f) ?? []) {
            const g = W.fnOf(r.from);
            const d = districts.of.get(g);
            if (d && d !== id) inn.set(d, (inn.get(d) ?? 0) + 1);
          }
        }
        const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 5).map(([d, n]) => ({ district: d, calls: n }));
        const sw = stageWords.get(id);
        return { id, title: sw.name, path: sw.path, about: sw.about, aboutFrom: sw.aboutFrom, functions: fns.length, boxes: fns.reduce((n, f) => n + W.fns.get(f).boxes.length, 0), entries: fns.filter((f) => !(W.callersOf.get(f) ?? []).length).length, callsOut: top(out), callsIn: top(inn) };
      }),
    },
    journeys: {
      list: J.journeys,
      none: J.none,
      main: J.main,
      ranking: J.ranking,
      noneNote: J.main ? '' : 'no main path found',
      rejected: J.rejected,
      engineGaps,
      triggers: T.triggers.map((t) => ({ kind: t.kind, label: t.label, fn: t.fid, where: `${W.fns.get(t.fid)?.path ?? ''}:${t.line ?? W.fns.get(t.fid)?.line ?? 0}`, detail: t.detail })),
      uncalled: T.uncalled.map((f) => ({ fn: f, label: names.label(f), where: `${W.fns.get(f).path}:${W.fns.get(f).line}` })),
      reach,
    },
    endings: {
      byOutcome: numbers.endings.byOutcome,
      failing,
      sites: E.sites.length,
      note: 'An open end (calls not followed) is not an ending: it is drawn as "continues, call not followed" and never counted here.',
    },
    whoHears: { counts: hears.counts, sentence: hearsSentence(hears.counts) },
    switches,
    triage,
    glossary,
  };
  const charts = { schema: `${READING_SCHEMA}.charts`, functions: C.functions, charts: C.charts, outlines: C.outlines, stats: C.stats };
  const wordsOut = {};
  for (const [id, w] of [...words.entries()].sort((a, b) => cmp(a[0], b[0]))) wordsOut[id] = { title: w.title, plain: w.plain, raw: w.raw, page: pageId(id) };
  const text = J.journeys.map(journeyText).join('\n\n') + (J.none ? 'no main path found\n' : '\n');
  return { reading, charts, words: wordsOut, text, world: W };
}

export { tally };
