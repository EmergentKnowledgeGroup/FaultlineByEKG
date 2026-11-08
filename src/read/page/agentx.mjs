// What the text commands (brief, where, breaks, path, impact, status) need from a tool map beyond its model, so that they say the same thing the page says:
//   the page's own ranked questions (the "Where it can break" page), the sentences and numbers of what was read, not read and open, and the table from the long
//   box ids of map/model.json to the short ones the page prints. Written to <project>/page/ask.json by  faultline map ; read by the agent view.
// Nothing here reads the source or draws anything.
import fs from 'node:fs';
import path from 'node:path';

export const ASK_SCHEMA = 'faultline.ask/1';
const CHECK_OF = { 'swallowed-failure': 'swallowed-error', 'swallowed-unknown': 'swallowed-error', 'flag-never-cleared': 'sticky-flag', 'flag-sticky': 'sticky-flag', 'wait-no-end': 'wait-no-wake', 'handler-nothing-can-reach': 'empty-handler', 'written-never-read': 'never-read' };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** Page questions from the reading's ranked questions, in the shape the "Where it can break" page reads. `entryBoxOf`: function id -> its entry box on the page. */
export function buildBreaks(reading, fns, entryBoxOf) {
  return reading.triage.questions.map((q) => {
    const f = q.where ? fns.find((r) => r.path === q.where.path && (r.label === q.where.fn || r.long === q.where.fn)) : null;
    const entry = f ? entryBoxOf.get(f.id) : null;
    const sure = q.confidence === 'confident';
    return {
      key: q.id, check: CHECK_OF[q.kind] ?? q.kind, state: 'open', boxes: entry ? [entry] : [], routes: [], question: q.text,
      evidence: `${/^The tool is (not )?sure/.test(q.because) ? '' : sure ? 'The tool is sure. ' : 'Not confident. '}${q.because}${q.where ? ` (${q.where.path}:${q.where.line}, in ${q.where.fn})` : ' (on no box)'}`,
      stage: f ? f.district : '', shown: true,
    };
  });
}

/** The entry box of each function (function id -> page box id) and the page id of each box that has a long id. */
export function boxTables(charts) {
  const entryBoxOf = new Map();
  const ids = {};
  for (const c of charts.charts) for (const p of c.parts) for (const b of p.boxes) {
    if (b.entry && b.shape === 'own') entryBoxOf.set(c.fn, b.id);
    if (b.ref && (b.shape === 'own' || !(b.ref in ids))) ids[b.ref] = b.id;
  }
  return { entryBoxOf, ids };
}

/** @returns the ask record: questions (the page's list), numbers, the three lists of sentences and the id table */
export function buildAsk({ reading, charts, notes = [], mapBoxes = [] }) {
  const { entryBoxOf, ids } = boxTables(charts);
  // boxes of the map that the page draws no box for (their function is listed as an outline): long id -> function id
  const undrawn = {};
  for (const b of mapBoxes) if (!(b.id in ids)) undrawn[b.id] = (b.prov && b.prov.fn) || (b.refs && b.refs[0] && b.refs[0].symbol) || '';
  const questions = buildBreaks(reading, charts.functions, entryBoxOf);
  const n = reading.numbers;
  const sure = reading.triage.questions.map((q) => q.confidence === 'confident');
  questions.forEach((q, i) => { if (sure[i]) q.sure = true; });
  for (const q of questions) if (q.check === 'wait-no-wake') q.state = 'wait';
  return {
    schema: ASK_SCHEMA,
    questions,
    nums: {
      functions: n.read.functions, files: n.read.files, languages: n.read.languages, boxes: n.read.boxes, roads: n.read.roads, loops: n.read.loops, stages: n.read.districts,
      claims: n.read.claims, claimsConfident: n.read.claimsConfident, claimsNotConfident: n.read.claimsNotConfident,
      noBoxes: n.notRead.functionsWithoutBoxes, unresolved: n.notRead.unresolvedCalls, severalTargets: n.notRead.callsWithSeveralTargets, unreadFiles: n.notRead.unreadFiles,
      questions: questions.length, questionsSure: sure.filter(Boolean).length, gaps: n.open.gapsInDrawing, journeys: n.journeys.kept,
      endings: n.endings.total, failing: n.whoHears.total, hearerUnknown: n.whoHears.unknown,
    },
    notes,
    statements: reading.statements,
    fns: charts.functions.map((x) => [x.fid, x.label, x.path, x.line, x.district, x.boxes, x.chart || '', x.callers]),   // [function id, name, file, line, stage, boxes, chart, callers]: for a function that has no box of its own
    ids,
    undrawn,
  };
}

/** The ask record of a tool map project, or null when it has none (a map written by hand, or a project folder without its reading). */
export function toolMapExtras(projDir) {
  const file = path.join(projDir, 'page', 'ask.json');
  try { return read(file); } catch { /* not written yet: try the reading */ }
  const rd = path.join(projDir, 'read');
  try { return buildAsk({ reading: read(path.join(rd, 'reading.json')), charts: read(path.join(rd, 'charts.json')) }); } catch { return null; }
}
