// Who hears about a failure. Filled from the claim register, each answer carrying its confidence.
// "Not known from the code" is the answer whenever the register does not say; "nobody" is only said when the register proves it.
import { endSiteLabel } from './words.mjs';

const HEARD_BY = {
  person: 'a person (a handler prints it where someone runs the program)',
  caller: 'the caller (the error travels up to the code that called this)',
  event: 'an event listener (it is announced as an event)',
  log: 'the error output (nothing catches it, so the traceback is printed where the program runs)',
  client: 'the client that made the request (the HTTP status is sent back to it)',
};
export const HEARD_KEYS = ['person', 'client', 'caller', 'event', 'log', 'someone', 'nobody', 'unknown'];

/** Read one claim's `says` into {value, detail}. */
export function readHears(c) {
  const says = c.says ?? '';
  let m;
  if ((m = /^heard by (person|caller|event|log)$/.exec(says))) {
    // "a person" is someone who sees a message a handler prints; a traceback of an uncaught error, or an error a handler turns into another, is not that
    const why = c.why ?? '';
    if (m[1] === 'person' && /traceback prints/.test(why)) return { value: 'log', detail: HEARD_BY.log };
    if (m[1] === 'person' && /->\s*(translate|reraise|return)\b/.test(why)) return { value: 'caller', detail: HEARD_BY.caller };
    return { value: m[1], detail: HEARD_BY[m[1]] };
  }
  if (/^a handler tells someone$/.test(says)) return { value: 'someone', detail: 'someone: a handler on the way reports it' };
  if (/^nobody/.test(says) || c.reason === 'nobody-closed') return { value: 'nobody', detail: 'nobody: every path the code has ends in silence (the tool is sure)' };
  if (/^who hears$/.test(says) || /^no known catcher/.test(says) || c.reason === 'heard-unknown') {
    return { value: 'unknown', detail: `not known from the code${/no known catcher[^)]*/.exec(says) ? ` (${/no known catcher[^)]*/.exec(says)[0]})` : ''}` };
  }
  return { value: 'unknown', detail: 'not known from the code' };
}

/** The answer for one ending box, from the register. */
function boxAnswer(W, boxId) {
  const cl = W.claimsOf(boxId, 'hears');
  if (!cl.length) return { value: 'unknown', detail: 'not known from the code (the tool made no claim about this ending)', confidence: 'none', reason: '', claim: null };
  // the most informative claim: a known value beats unknown; confident beats not
  const rank = (c) => (readHears(c).value !== 'unknown' ? 2 : 0) + (c.conf === 'confident' ? 1 : 0);
  const best = [...cl].sort((a, b) => rank(b) - rank(a) || (a.id < b.id ? -1 : 1))[0];
  const r = readHears(best);
  return { value: r.value, detail: r.detail, confidence: best.conf, reason: best.reason ?? '', claim: best.id };
}

const emptyCounts = () => ({ total: 0, person: 0, client: 0, caller: 0, event: 0, log: 0, someone: 0, nobody: 0, unknown: 0, noClaim: 0, confident: 0, notConfident: 0 });

/**
 * Every failing or refusing ending, one row per place in the code (a shared ending box is several places), with who hears about it.
 * An ending that answers an HTTP status is heard by the client that asked: the status is in the code, so that answer is as sure as the status.
 * @param {object} W world
 * @param {object[]} ends from classifyEnds
 * @param {(fid:string, line:number)=>string} routeOf the route an ending sits under, or ''
 * @param {{label:(fid:string)=>string}} names
 * @returns {{rows: object[], byBox: Map<string, object>, counts: object}}
 */
export function whoHears(W, ends, routeOf = () => '', names = { label: (f) => f }) {
  const rows = [];
  const byBox = new Map();
  const counts = emptyCounts();
  for (const e of ends) {
    const bad = e.sites.filter((s) => s.outcome === 'failure' || s.outcome === 'refusal');
    if (!bad.length) continue;
    const box = boxAnswer(W, e.box);
    byBox.set(e.box, box);
    for (const s of bad) {
      const status = /HTTP (\d{3})/.exec(s.why)?.[1] ?? '';
      const label = endSiteLabel({ cls: e.cls }, s);
      let h = box;
      if (status) h = { value: 'client', detail: HEARD_BY.client, confidence: 'confident', reason: 'http-status', claim: null };
      rows.push({
        box: e.box, fn: e.fn, fnLabel: names.label(e.fn), path: e.path, line: s.line, outcome: s.outcome, title: label.t, plain: label.p, status, route: routeOf(e.fn, s.line),
        shared: e.sites.length > 1, hears: h, caught: s.caught || '',
      });
      counts.total++;
      counts[h.value]++;
      if (h.confidence === 'none') counts.noClaim++;
      else if (h.confidence === 'confident') counts.confident++;
      else counts.notConfident++;
    }
  }
  return { rows, byBox, counts };
}

/** One honest sentence about who hears, built only from the counts. */
export function hearsSentence(counts) {
  if (!counts.total) return 'No failing endings were found, so there is nothing to say about who hears.';
  const known = counts.person + counts.client + counts.caller + counts.event + counts.log + counts.someone + counts.nobody;
  const parts = [];
  if (counts.client) parts.push(`${counts.client} answer an HTTP error to the client that asked`);
  if (counts.caller) parts.push(`${counts.caller} travel up to the caller`);
  if (counts.person) parts.push(`${counts.person} are printed by a handler for a person`);
  if (counts.event) parts.push(`${counts.event} are announced as events`);
  if (counts.log) parts.push(`${counts.log} end in the error output`);
  if (counts.someone) parts.push(`${counts.someone} are reported by a handler`);
  if (counts.nobody) parts.push(`${counts.nobody} reach nobody (the tool is sure)`);
  const unknownText = `${counts.unknown} not known from the code`;
  return `Of ${counts.total} failing endings, ${known ? `${parts.join(', ')}; ` : ''}${unknownText}.`;
}

