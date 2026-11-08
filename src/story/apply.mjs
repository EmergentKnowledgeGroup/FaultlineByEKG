// apply: the words-only path. An agent's titles and sentences go onto the tool map's own boxes, beside the tool's phrase, and nothing else moves.
//
//   const { model, report } = applyWords(mapDir, overlay)
//
// overlay: { schema?, by?, words: { "<box id>": { title?, plain? } }, claims?: [...] }
//   1. Only `schema`, `by`, `words`, `claims` are read. Any other key is refused and counted.
//   2. A word record needs an id that exists in the tool map. Only `title` and `plain` are words; any other field is refused.
//      A title is at most TITLE_MAX characters, a sentence at most PLAIN_MAX; control characters, non-text and empty values are refused.
//   3. Words never overwrite the tool's phrase: they sit in box.words = { by, title, plain }, and the tool's title and plain stay as they were.
//   4. Roads are refused: this path takes no road from an agent, however it is witnessed. (A road is the tool's, or it is the story's, checked by `check`.)
//   5. Recompute gate: the merged model is compared with the base. Anything other than `words` on a box makes the whole overlay refused.
import fs from 'node:fs';
import path from 'node:path';
import { MapError } from './layer1.mjs';
import { canonJson, sha256, cmp, plain } from './canon.mjs';

export const APPLY_SCHEMA = 'faultline.story-apply/1';
/** A title longer than this does not fit a box on the page. */
export const TITLE_MAX = 34;
/** A sentence longer than this is a paragraph, not a label. */
export const PLAIN_MAX = 260;
const OK_TOP = new Set(['schema', 'by', 'words', 'claims']);
const OK_FIELDS = new Set(['title', 'plain']);
const CTRL_TITLE = /[\u0000-\u001f\u007f]/;
const CTRL_PLAIN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const VOUCHES = /\b(?:proven|proved|verified|checked by the tool|confirmed by the tool|the tool (?:checked|verified|proved))\b/i;
const MAX_LISTED = 200;
const cpLen = (s) => Array.from(s).length;

/** Everything the tool drew must be byte-equal after the merge, except `words` on boxes. Returns the list of differences. */
export function recomputeGate(base, merged) {
  const bad = [];
  const mb = new Map(merged.boxes.map((b) => [b.id, b]));
  if (mb.size !== base.boxes.length) bad.push('box set changed');
  for (const b of base.boxes) {
    const x = mb.get(b.id);
    if (!x) { bad.push(`box ${b.id} removed`); continue; }
    const { words: _w, ...rest } = x;
    if (canonJson(rest) !== canonJson(b)) bad.push(`box ${b.id} changed`);
  }
  if (canonJson(merged.routes) !== canonJson(base.routes)) bad.push('roads changed');
  for (const k of new Set([...Object.keys(base), ...Object.keys(merged)])) {
    if (k === 'boxes' || k === 'routes') continue;
    if (canonJson(base[k]) !== canonJson(merged[k])) bad.push(`top-level ${k} changed`);
  }
  return bad;
}

export function applyWords(mapDir, overlay) {
  let base;
  try { base = JSON.parse(fs.readFileSync(path.join(mapDir, 'model.json'), 'utf8')); } catch { throw new MapError(`the tool map has no readable model.json in ${String(mapDir).replace(/\\/g, '/')}`); }
  // the merged model is written out whole, so only a file that says it is a tool model is merged: model.json may be a link to some other JSON file
  if (!base || base.schema !== 'faultline.model/1' || !Array.isArray(base.boxes)) throw new MapError(`model.json in ${String(mapDir).replace(/\\/g, '/')} is not a tool model`);
  const rep = { schema: APPLY_SCHEMA, by: '', wordsOffered: 0, wordsAccepted: 0, wordsRefused: 0, forbidden: 0, claimsOffered: 0, claimsRefused: 0, boxesWithWords: 0, lint: [], refusals: [], refusalsTotal: 0, structureChanged: 0, overlayRefused: false };
  const note = (m) => { rep.refusalsTotal++; if (rep.refusals.length < MAX_LISTED) rep.refusals.push(m); };
  const merged = { ...base, boxes: base.boxes.map((b) => ({ ...b })) };
  const boxes = new Map(merged.boxes.map((b) => [b.id, b]));
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) {
    note('the overlay is not an object');
    rep.overlayRefused = true;
    return { model: merged, report: rep };
  }
  rep.by = typeof overlay.by === 'string' ? plain(overlay.by, 40) || 'agent' : 'agent';
  for (const k of Object.keys(overlay).sort(cmp)) if (!OK_TOP.has(k)) { rep.forbidden++; note(`top-level key ${JSON.stringify(plain(k, 40))}: not words (this path reads only schema, by, words, claims)`); }
  const words = overlay.words && typeof overlay.words === 'object' && !Array.isArray(overlay.words) ? overlay.words : {};
  const titles = new Map();
  for (const id of Object.keys(words).sort(cmp)) {
    const fields = words[id];
    const label = plain(id, 60);
    if (!boxes.has(id)) { rep.wordsRefused++; rep.wordsOffered++; note(`words ${label}: no such box in the tool map`); continue; }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) { rep.wordsRefused++; rep.wordsOffered++; note(`words ${label}: not a record`); continue; }
    const clean = {};
    for (const f of Object.keys(fields).sort(cmp)) {
      const v = fields[f];
      if (!OK_FIELDS.has(f)) { rep.forbidden++; note(`words ${label}.${plain(f, 30)}: not a words field`); continue; }
      rep.wordsOffered++;
      if (typeof v !== 'string' || (f === 'title' ? CTRL_TITLE : CTRL_PLAIN).test(v) || !v.trim()) { rep.wordsRefused++; note(`words ${label}.${f}: not plain text`); continue; }
      const n = cpLen(v.trim());
      if (n > (f === 'title' ? TITLE_MAX : PLAIN_MAX)) { rep.wordsRefused++; note(`words ${label}.${f}: too long (${n} characters; the limit is ${f === 'title' ? TITLE_MAX : PLAIN_MAX})`); continue; }
      clean[f] = v.trim();
      rep.wordsAccepted++;
      if (VOUCHES.test(clean[f])) rep.lint.push(['W-vouches', id, f]);
    }
    if (Object.keys(clean).length) {
      boxes.get(id).words = { by: rep.by, ...clean };
      rep.boxesWithWords++;
      if (clean.title) { if (!titles.has(clean.title)) titles.set(clean.title, []); titles.get(clean.title).push(id); }
      const kind = boxes.get(id).kind;
      if (clean.title && kind === 'decision' && !/\?\s*$/.test(clean.title)) rep.lint.push(['W-decision-not-a-question', id, clean.title]);
      if (clean.title && kind === 'decision' && /^returns?\b/i.test(clean.title)) rep.lint.push(['W-decision-titled-as-exit', id, clean.title]);
      if (clean.title && kind !== 'end' && /^(?:returns?|raises?|throws?)\b/i.test(clean.title)) rep.lint.push(['W-exit-title-on-non-end', id, clean.title]);
    }
  }
  for (const [t, ids] of [...titles].sort((a, b) => cmp(a[0], b[0]))) if (ids.length > 1) rep.lint.push(['W-dupe-title', t, ids]);
  const claims = Array.isArray(overlay.claims) ? overlay.claims : overlay.claims == null ? [] : [null];
  rep.claimsOffered = claims.length;
  for (const c of claims) { rep.claimsRefused++; note(`road ${plain(c && typeof c === 'object' ? `${c.from}->${c.to}` : String(c), 80)}: this path takes no road from an agent`); }
  const bad = recomputeGate(base, merged);
  rep.structureChanged = bad.length;
  if (bad.length) { rep.overlayRefused = true; note('RECOMPUTE GATE: ' + bad.slice(0, 5).join('; ')); }
  rep.modelSha256 = sha256(canonJson(merged));
  return { model: merged, report: rep };
}
