// What an agent may add to a deterministic map, and how the tool checks it.
//
//   words   : title / plain / blurb on a box or stage that already exists                        -> accepted
//   roads   : a new road only with a witness (file, line, kind) that the tool re-reads from the source and that names the target; accepted roads are
//             marked prov.src='agent', inferred=true and counted
//   anything that would delete or change a proven field (kind, refs, an existing road, prov)       -> refused
// Nothing here asks a model anything; it only checks what a model wrote.
import path from 'node:path';
import { readText } from './lookup.mjs';
import { sorted, cpSlice } from './pyrt.mjs';

const WORD_FIELDS = ['title', 'plain', 'blurb'];
const MAX_WORDS = 400; // longest title, plain text or blurb an agent may set
const MAX_WHEN = 80;
const MAX_WHY = 200;
export const TIER = 'claimed'; // an agent's road, witnessed by a line the tool re-read. Drawn differently, counted, removable with one flag.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A road a->b is witnessed when the cited line lies inside a's function and names b's function. */
export function witnessOk(root, boxes, a, b, w) {
  let lines;
  let line;
  let kind;
  let rel;
  try {
    ({ path: rel, kind } = w);
    line = Number.parseInt(w.line, 10);
    if (!rel || Number.isNaN(line) || !kind) throw new Error('incomplete');
    lines = readText(path.join(root, rel)).split('\n');
  } catch {
    return [false, 'witness file or line unreadable'];
  }
  if (!(line > 0 && line <= lines.length)) return [false, 'line out of range'];
  const text = lines[line - 1];
  const ba = boxes.get(a);
  const bb = boxes.get(b);
  if (!ba || !bb) return [false, 'unknown box'];
  const fa = ba.prov.fn;
  const fb = bb.prov.fn;
  if (!fa.startsWith(rel + '::')) return [false, 'witness is not in the source function'];
  const name = fb.slice(fb.indexOf('::') + 2).split('.').pop().split('~')[0];
  if (kind === 'call') {
    if (!new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}\\s*\\(`).test(text)) return [false, 'the line does not call the target'];
  } else if (kind === 'string-ref') {
    if (!new RegExp(`['"][^'"]*${escapeRe(name)}[^'"]*['"]`).test(text)) return [false, 'the line does not name the target in a string'];
  } else return [false, 'unknown witness kind'];
  return [true, 'ok'];
}

/** -> [the model with the overlay applied, a log of what was accepted and refused]. The model passed in is not changed. */
export function applyOverlay(model, overlay, root) {
  const m = structuredClone(model);
  const boxes = new Map(m.boxes.map((b) => [b.id, b]));
  const stages = new Map(m.stages.map((s) => [s.id, s]));
  const log = { words_accepted: 0, words_refused: 0, roads_accepted: 0, roads_refused: 0, refusals: [] };
  for (const [kind, table] of [['box', overlay.boxes ?? {}], ['stage', overlay.stages ?? {}]]) {
    const pool = kind === 'box' ? boxes : stages;
    for (const i of sorted(Object.keys(table))) {
      const fields = table[i];
      if (!pool.has(i)) {
        log.words_refused += Object.keys(fields).length;
        log.refusals.push(`${kind} ${i}: no such id`);
        continue;
      }
      for (const f of sorted(Object.keys(fields))) {
        const v = fields[f];
        if (WORD_FIELDS.includes(f) && typeof v === 'string') {
          pool.get(i)[f] = cpSlice(v, 0, MAX_WORDS);
          log.words_accepted += 1;
        } else {
          log.words_refused += 1;
          log.refusals.push(`${kind} ${i}.${f}: not a words field`);
        }
      }
    }
  }
  const have = new Set(m.routes.map((r) => `${r.from}\u0000${r.to}`));
  for (const r of overlay.roads ?? []) {
    const a = r.from;
    const b = r.to;
    if (have.has(`${a}\u0000${b}`)) {
      log.roads_refused += 1;
      log.refusals.push(`road ${a}->${b}: the tool already drew it`);
      continue;
    }
    const [ok, why] = witnessOk(root, boxes, a, b, r.witness ?? {});
    if (!ok) {
      log.roads_refused += 1;
      log.refusals.push(`road ${a}->${b}: ${why}`);
      continue;
    }
    m.routes.push({ id: `a:${a}->${b}`, from: a, to: b, type: 'forward', when: cpSlice(String(r.when ?? ''), 0, MAX_WHEN), why: cpSlice(String(r.why ?? ''), 0, MAX_WHY), refs: [], inferred: true,
      prov: { src: 'agent', rule: 'witnessed', tier: TIER, witness: r.witness } });
    log.roads_accepted += 1;
  }
  for (const k of [...(overlay.delete ?? []), ...(overlay.retype ?? [])]) log.refusals.push(`${k}: tool-proven things cannot be deleted or changed by an agent`);
  return [m, log];
}
