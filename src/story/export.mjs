// The code index the story check reads beside the tool map: for every function the tool read (not only the ones it drew boxes for), where it starts and
// ends, and the lines of its tests, calls and exits. It is made from the reader documents alone (the same IR the rules start from), so it does not move when
// a rule changes. `map` writes it next to model.json and claims.json; nothing in it comes from an agent.
import { canonJson } from './canon.mjs';

export const INDEX_SCHEMA = 'faultline.story-index/1';
/** A test is kept to this many characters: enough to show what is tested, short enough to print. */
const TEST_CHARS = 160;

/** @param ir { py?, ts?, lua? }: the reader documents (null or missing when a language was not mapped)
 *  @param digest the source digest the readers recorded */
export function storyIndex(ir, digest) {
  const files = {};
  const fns = {};
  for (const doc of [ir.py, ir.ts, ir.lua]) {
    if (!doc) continue;
    for (const f of doc.files) {
      files[f.path] = { lines: f.lines ?? 0, lang: f.lang ?? '' };
      for (const fn of f.fns) {
        const br = [], ca = [], rt = [];
        for (const nd of fn.nodes ?? []) {
          const k = nd.k;
          if (k === 'branch' || k === 'loop' || k === 'disp' || k === 'handler') br.push([nd.line, nd.tk || k, String(nd.test ?? '').slice(0, TEST_CHARS)]);
          else if (k === 'return' || k === 'raise') rt.push([nd.line, k]);
          for (const o of nd.ops ?? []) {
            if (o.t === 'call') ca.push([o.line, o.f ?? '']);
            else if (o.t === 'tern') br.push([o.line, 'tern', '']);
            else if (o.t === 'link') ca.push([o.line, 'link']);
          }
        }
        fns[fn.id] = { p: fn.path ?? f.path, q: fn.qual ?? '', lg: fn.lang ?? f.lang ?? '', l: fn.line, e: fn.end, br, ca, rt };
      }
    }
  }
  return { schema: INDEX_SCHEMA, source_digest: digest ?? null, files, fns };
}

export const storyIndexText = (ir, digest) => canonJson(storyIndex(ir, digest));
