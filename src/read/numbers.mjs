// One source of numbers. Every count a page states comes from this record, and the sentences that quote them are built here too,
// so two parts of a page cannot disagree. A tool map has no ledger to fill; what the page states instead is what was read, what was not, and what is open.
import { plural, tally } from './util.mjs';

/** The language a person sees in a count: the readers treat JavaScript and TypeScript as one family ('ts'), but a count of "ts" files that are really .js files is wrong. */
const shownLang = (f) => (f.lang === 'ts' && /\.[cm]?jsx?$/i.test(f.path) ? 'js' : f.lang);

/** Folded exits that are a way out of the function (a return or a raise) and not a loop going round again. */
const LOOP_CLASSES = new Set(['loops-back', 'continues']);

/**
 * Call sites that may run any of several functions: one per function, line and written name, counted from the call table (a site whose
 * resolved and possible targets together name more than one function). Without a call table, the may-tier call roads that are not a function
 * handed to another call, one per function and line.
 */
export function severalTargetSites(W) {
  const seen = new Set();
  if (W.calls) {
    for (const row of W.calls) {
      const o = row[3];
      if (o?.t !== 'call') continue;
      if (new Set([...(o.to ?? []), ...(o.may ?? [])]).size > 1) seen.add(`${row[0]}|${o.line}|${o.f}`);
    }
    return seen.size;
  }
  for (const r of W.model.routes) if (r.prov.rule === 'call' && r.prov.tier === 'may' && r.prov.how !== 'callback') seen.add(`${r.prov.fn}|${r.prov.line}`);
  return seen.size;
}

/** @returns {object} the numbers record */
export function buildNumbers({ W, ends, sites, hears, journeys, triggers, uncalled, reach, switches, triage, glossary, charts, districts, claims, purpose }) {
  const files = new Set(W.mappedIds.map((f) => W.fns.get(f).path));
  const langs = Object.fromEntries(tally(W.mappedIds, (f) => shownLang(W.fns.get(f))).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const roadTiers = Object.fromEntries(tally(W.model.routes.filter((r) => r.kind === 'call' || r.kind === 'link'), (r) => r.prov.tier ?? 'proven').sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const unmapped = W.fnIds.filter((f) => !W.fns.get(f).mapped);
  // every function the map's readers saw when the model says so; else the functions the scanner listed that have no box
  const counted = W.model.system?.functions;
  const fnNoBox = counted ? counted.withoutBoxes : unmapped.length;
  const fnInCode = counted ? counted.read : W.fnIds.length;
  const unresolved = W.calls ? [...W.openCalls.values()].reduce((n, a) => n + a.length, 0) : W.facts ? [...(W.facts.functions ? Object.values(W.facts.functions) : [])].reduce((n, f) => n + (f.unresolved?.length ?? 0), 0) : null;
  // an ending is one place in the code where a function returns or raises. These are the ones with a box of their own; a decision also folds
  // the exits of its arms into itself, and a function of one return has no box at all, so this is not a count of every return in the code
  const foldedExits = W.model.boxes.reduce((n, b) => n + (b.prov.folded_exits ?? []).filter((fe) => !LOOP_CLASSES.has(fe.class)).length, 0);
  const siteOutcome = Object.fromEntries(tally(sites, (s) => s.outcome).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const allGaps = new Map();
  for (const j of journeys.journeys) for (const g of j.gaps) allGaps.set(`${g.path}:${g.line}:${g.to}`, g);
  const n = {
    read: {
      files: files.size, languages: langs, functions: W.mappedIds.length, boxes: W.model.boxes.length, roads: W.model.routes.length, callRoads: roadTiers,
      loops: W.model.boxes.filter((b) => b.prov.rule === 'loop').length, districts: districts.order.length, chartedFunctions: charts.stats.chartedFunctions, chartParts: charts.stats.chartParts, outlines: charts.stats.outlines,
      claims: claims.length, claimsConfident: claims.filter((c) => c.conf === 'confident').length, claimsNotConfident: claims.filter((c) => c.conf !== 'confident').length,
      resolvers: W.model.system?.resolvers ?? {},
    },
    notRead: {
      functionsWithoutBoxes: fnNoBox, functionsInCode: fnInCode, unresolvedCalls: unresolved, callsWithSeveralTargets: severalTargetSites(W), roadsMayRun: roadTiers.may ?? 0,
      scanHopsUsedByJourneys: allGaps.size, unreadFiles: (W.model.system?.unread ?? []).length,
    },
    endings: {
      total: sites.length, boxes: ends.length, byOutcome: siteOutcome, failing: hears.counts.total, folded: foldedExits,
    },
    whoHears: hears.counts,
    entries: { triggers: triggers.length, byKind: Object.fromEntries(tally(triggers, (t) => t.kind).sort((a, b) => (a[0] < b[0] ? -1 : 1))), uncalledOther: uncalled.length },
    journeys: { kept: journeys.journeys.length, considered: journeys.rejected.considered, rejected: journeys.rejected, noMainPath: journeys.main === null },
    reach: { reachedFunctions: reach.functions, reachedMappedFunctions: reach.mappedFunctions, reachedBoxes: reach.boxes },
    switches: { found: switches.count, withDefault: switches.withDefault, defaultNotRead: switches.notRead, offByDefault: switches.offByDefault, defaultFalsy: switches.defaultFalsy, defaultOn: switches.defaultOn, defaultValue: switches.defaultValue },
    open: { questions: triage.counts.questions, questionsConfident: triage.counts.confident, gapsInDrawing: triage.counts.gaps, claimsNotConfident: claims.filter((c) => c.conf !== 'confident').length },
    glossary: { terms: glossary.count, withMeaning: glossary.withMeaning },
    purpose: { found: !!purpose.text },
  };
  return n;
}

/** The sentences a page quotes, built from the numbers and nothing else. */
export function statementsOf(n, notes = []) {
  const r = n.read;
  const lang = Object.entries(r.languages).map(([k, v]) => `${v} ${k}`).join(', ');
  const read = [
    `Read ${plural(r.functions, 'function')} in ${plural(r.files, 'file')} (${lang || 'no language known'}): ${plural(r.boxes, 'box', 'boxes')} and ${plural(r.roads, 'road')}, grouped into ${plural(r.districts, 'stage')}.`,
    `${plural(r.claims, 'claim')} were made about it: ${r.claimsConfident} confident (a type checker or the flow graph decided), ${r.claimsNotConfident} not confident.`,
    `${plural(n.endings.total, 'ending')} (a place where a function returns or raises) with a box of their own: ${Object.entries(n.endings.byOutcome).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}. ${plural(n.endings.folded, 'more exit')} sit inside the decision that leads to them and have no box. This is not a count of every return in the code.`,
  ];
  const notRead = [
    ...notes,                                   // what the run itself could not read (no Python, no type checker), in the words it printed
    n.notRead.functionsWithoutBoxes ? `${n.notRead.functionsWithoutBoxes} of the ${plural(n.notRead.functionsInCode, 'function')} in the code have no box of their own in the map (nothing in them was drawn as a decision, an effect or an ending); the calls they make are read from the scanner's call list.` : 'Every function in the code has a box in the map.',
    n.notRead.unresolvedCalls === null ? 'Neither the call table nor scanner facts were given, so calls the tool could not resolve are not counted.' : `${plural(n.notRead.unresolvedCalls, 'call')} could not be resolved to project code; the function carries on there ("continues, call not followed").`,
    `${plural(n.notRead.callsWithSeveralTargets, 'call site')} may run any of several functions; the tool did not pick one.`,
    n.notRead.scanHopsUsedByJourneys ? `${plural(n.notRead.scanHopsUsedByJourneys, 'hop')} in the journeys come from the scanner's call list because the map draws no road there (listed under engine gaps).` : '',
  ].filter(Boolean);
  const open = [
    `${plural(n.open.questions, 'question')} about the code (${n.open.questionsConfident} the tool is sure of, the rest not confident).`,
    `${plural(n.open.gapsInDrawing, 'gap')} in the drawing, folded: these say how the map is drawn, not what the code does.`,
    n.whoHears.total ? `Who hears: ${n.whoHears.unknown} of ${n.whoHears.total} failing endings are not known from the code.` : 'There are no failing endings to say who hears.',
    `${n.journeys.kept ? `${plural(n.journeys.kept, 'journey')} shown from ${plural(n.entries.triggers, 'start')}; ${n.journeys.rejected.rejectedTotal} runs were rejected as not real journeys.` : 'No journey was found: no start gave a run that crosses functions.'}${n.journeys.noMainPath ? ' No main path found.' : ''}`,
    `From all entries (${n.entries.triggers} starts and ${n.entries.uncalledOther} other uncalled functions) the code reaches ${n.reach.reachedMappedFunctions} of ${n.read.functions} mapped functions and ${n.reach.reachedBoxes} of ${n.read.boxes} boxes (counting every road, error roads included).`,
  ];
  return { read, notRead, open };
}
