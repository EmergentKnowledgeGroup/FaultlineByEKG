// What an agent typed -> the function or box it means, on a tool map. Every function the scan found can be named, not only the ones with a box.
// Order: box id (short, or the long one of map/model.json), page function id (f58) and its box (f58.2) or chart (c58), function id (path::Class.method),
// file:line, file, bare name (Class.method or method), words from a box title.
import { functionAt, MODULE } from './reading.mjs';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);       // a name such as "constructor" or "toString" is not a key of a plain object
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

/** The function a page box belongs to: the function id its first reference names. */
export function fnOfBox(R, data, boxId) {
  const b = has(data.boxes, boxId) ? data.boxes[boxId] : null;
  const ref = b && b.refs.find((r) => r[2]);
  return ref ? R.byId.get(ref[2]) || null : null;
}

/** How many places call a function, by the call list. */
export const callerCount = (R, F) => (R.inn.get(F.id) || []).length;

/**
 * Candidates for one name, best first. A function on the main journey comes first (it is the one a stranger most likely means), then one on an earlier journey,
 * then one with a drawn chart, one with more callers, one with more boxes; a named function before an unnamed one; the function id settles a tie.
 */
const rankKey = (R, q, F) => [R.mainSet.has(F.id) ? 0 : 1, F.qual === q ? 0 : 1, R.jr.has(F.id) ? R.jr.get(F.id) : 1e9, F.chart ? 0 : 1, -callerCount(R, F), -F.boxes, F.anon ? 1 : 0, F.id];
const cmpKey = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
export function rankNamed(R, list, q) {
  return list.map((F) => [rankKey(R, q, F), F]).sort((x, y) => cmpKey(x[0], y[0])).map((x) => x[1]);
}

/** Why the first of several same-named functions was picked over the next one, in plain words: the first thing that tells them apart. */
export function pickWhy(R, F, next, q) {
  const a = rankKey(R, q, F), b = rankKey(R, q, next);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (i === 0) return 'it is on the main journey and the other is not';
  if (i === 1) return 'its name matches in full';
  if (i === 2) return `it is on an earlier journey (${R.journeyIds[R.jr.get(F.id)]})`;
  if (i === 3) return 'it has a drawn chart and the other has none';
  if (i === 4) return `it has more callers (${-a[4]} against ${-b[4]})`;
  if (i === 5) return `it has more boxes (${-a[5]} against ${-b[5]})`;
  return 'nothing tells them apart, so the one whose file name sorts first is shown';
}

function fileMatches(R, file) {
  const f = norm(file), all = [...new Set([...R.byFile.keys(), ...R.files.keys()])];
  const exact = all.filter((p) => p === f);
  if (exact.length) return exact;
  return all.filter((p) => p.endsWith('/' + f)).sort();
}

/**
 * @returns one of
 *   {kind:'box', box, F}                       a box the page draws
 *   {kind:'function', F, how, mark?, line?, others?, why?}   a function (others: more that share the name)
 *   {kind:'file', file, fns}                   a file with no line given
 *   {kind:'titles', boxes}                     words from box titles
 *   {kind:'none', note}
 */
export function locate(R, data, q) {
  const raw = String(q || '').trim();
  if (!raw) return { kind: 'none', note: 'nothing given' };
  if (has(data.boxes, raw)) return { kind: 'box', box: raw, F: fnOfBox(R, data, raw) };
  const al = data.alias && has(data.alias, raw) ? data.alias[raw] : null;
  if (al && has(data.boxes, al)) return { kind: 'box', box: al, F: fnOfBox(R, data, al), long: raw };
  const tm = data.toolMap || {};
  const un = tm.undrawn && has(tm.undrawn, raw) ? tm.undrawn[raw] : null;
  if (un && R.byId.has(un)) return { kind: 'function', F: R.byId.get(un), how: 'box', long: raw };
  const lc = raw.toLowerCase();
  const m = /^([fc])(\d+)(?:\.(\w+))?$/.exec(raw);
  if (m && R.byN.has('f' + m[2])) {
    const F = R.byN.get('f' + m[2]);
    return { kind: 'function', F, how: m[1] === 'c' ? 'chart' : m[3] ? 'box' : 'fn', ...(m[3] ? { mark: `f${m[2]}.${m[3]}` } : {}) };
  }
  if (R.byId.has(raw)) return { kind: 'function', F: R.byId.get(raw), how: 'id' };
  const nid = [...R.byId.keys()].find((id) => norm(id) === norm(raw));
  if (nid) return { kind: 'function', F: R.byId.get(nid), how: 'id' };

  const lm = /^(.+?):(\d+)$/.exec(norm(raw));
  const file = lm ? lm[1] : norm(raw), line = lm ? +lm[2] : null;
  const hits = fileMatches(R, file);
  if (hits.length) {
    const rank = (p) => [R.byFile.get(p) && R.byFile.get(p).some((F) => R.mainSet.has(F.id)) ? 0 : 1, p];
    hits.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || (x[1] < y[1] ? -1 : 1); });
    const f = hits[0];
    const others = hits.slice(1);
    if (line == null) return { kind: 'file', file: f, fns: (R.byFile.get(f) || []).filter((F) => F.qual !== MODULE || (R.byFile.get(f) || []).length === 1), others };
    const F = functionAt(R, f, line);
    if (F) return { kind: 'function', F, how: 'line', line, file: f, others: [] , fileOthers: others };
    const total = R.files.get(f);
    return { kind: 'none', note: `line ${line} is not inside any function of ${f}${total ? `, which has ${total} lines` : ''}${total && line > total ? ': the line is past the end of the file' : ''}` };
  }
  if (lm && !hits.length) return { kind: 'none', note: `${lm[1]} is not a file the map read` };

  const named = R.list.filter((F) => (F.qual !== MODULE || raw === MODULE) && (F.qual === raw || F.qual.endsWith('.' + raw) || F.name === raw || F.long === raw));
  if (named.length) {
    const ranked = rankNamed(R, named, raw);
    return { kind: 'function', F: ranked[0], how: 'name', others: ranked.slice(1), why: ranked.length > 1 ? pickWhy(R, ranked[0], ranked[1], raw) : '' };
  }
  const titles = Object.keys(data.boxes).filter((id) => data.boxes[id].title.toLowerCase().includes(lc));
  if (titles.length) return { kind: 'titles', boxes: titles };
  return { kind: 'none', note: `no box, function, file or title matches "${raw}"` };
}
