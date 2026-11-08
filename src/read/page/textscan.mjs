// A check on the words of a built page: every total it states about the system must be the number in the reading's one record, and a few words must not appear.
// The page text comes from a browser (every view, every guide); this module only reads text and the reading, so it also runs on text written by hand.

/** [what the total is, pattern that finds it (group 1 is the number), the number the reading says]. */
export function totalsOf(reading) {
  const n = reading.numbers;
  const hc = reading.whoHears.counts;
  const c = (v) => String(v);
  return [
    ['functions read', /\bRead ([\d,]+) functions? in [\d,]+ files?/g, c(n.read.functions)],
    ['files read', /\bRead [\d,]+ functions? in ([\d,]+) files?/g, c(n.read.files)],
    ['boxes in the map', /([\d,]+) boxes in the map/g, c(n.read.boxes)],
    ['roads in the map', /([\d,]+) roads in the map/g, c(n.read.roads)],
    ['boxes and roads', /\b([\d,]+) boxes and [\d,]+ roads\b(?! are drawn)/g, c(n.read.boxes)],
    ['endings', /([\d,]+) endings \((?:a place|places)/g, c(n.endings.total)],
    ['endings in the code', /([\d,]+) endings in the code/g, c(n.endings.total)],
    ['failing endings', /([\d,]+) failing endings(?! are| of)/g, c(hc.total)],
    ['failing endings (of)', /\bof ([\d,]+) failing endings/g, c(hc.total)],
    ['switches found', /([\d,]+) switches found/g, c(n.switches.found)],
    ['journeys', /\b(?:All|Journeys \(|shown: )([\d,]+)(?: journeys)?\b/g, c(n.journeys.kept)],
    ['stages', /grouped into ([\d,]+) stages?/g, c(n.read.districts)],
    ['questions', /([\d,]+) questions about the code/g, c(n.open.questions)],
  ];
}

/** Words the page must not use for what the tool knows or draws (the tool is "sure", it never "proves"), and phrases that name things the page does not have. */
export const BANNED = [
  [/\bprov(?:en|ed|es|e)\b(?! by a run)/i, 'says "proven" or "proved"'],
  [/\bwhole[- ](?:system )?map\b/i, 'speaks of a whole map'],
  [/not on any box yet/i, 'says a term is "not on any box yet"'],
  [/\b[\d,]+ ending boxes\b/i, 'counts "ending boxes" as a total'],
  [/\bFails with \*/, 'says "Fails with *"'],
];

/**
 * @param {string} text the text of the page (any view)
 * @param {object} reading the reading
 * @param {{ignore?: RegExp[]}} [opt]
 * @returns {{what: string, found: string, expected: string}[]}
 */
export function scanPageText(text, reading, opt = {}) {
  const out = [];
  const norm = (s) => s.replace(/,/g, '');
  for (const [what, re, expected] of totalsOf(reading)) {
    for (const m of text.matchAll(re)) if (norm(m[1]) !== expected) out.push({ what, found: m[0].trim(), expected });
  }
  for (const [re, what] of BANNED) {
    if ((opt.ignore ?? []).some((x) => x.test(text))) continue;
    const m = re.exec(text);
    if (m) out.push({ what, found: m[0], expected: '' });
  }
  const main = reading.journeys.main;
  const tile = /the main path runs through (\d+) of them/.exec(text);
  if (tile && !main) out.push({ what: 'the main path tile', found: tile[0], expected: 'no main path found' });
  if (tile && main && Number(tile[1]) === 0) out.push({ what: 'the main path tile', found: tile[0], expected: 'at least 1 stage' });
  return out;
}
