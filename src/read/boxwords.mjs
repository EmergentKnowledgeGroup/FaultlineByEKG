// Words for every box of the map : one pass, one template per rule.
import { decisionWords, endWords, handlerWords, loopWords, stepWords, tryWords, waitWords } from './words.mjs';

/** @returns {Map<string, {title:string, plain:string, raw:string, full?:string, route?:object}>} */
export function buildBoxWords(W, names, ends) {
  const out = new Map();
  for (const fid of W.mappedIds) {
    const f = W.fns.get(fid);
    for (const b of f.boxes) {
      let w;
      if (b.kind === 'end') w = endWords(b, ends.get(b.id), names);
      else if (b.prov.rule === 'handler') w = handlerWords(b);
      else if (b.prov.rule === 'try') w = tryWords(b);
      else if (b.prov.rule === 'loop') w = loopWords(W, b, f.path);
      else if (b.kind === 'wait') w = waitWords(W, b, f.path);
      else if (b.kind === 'decision') w = decisionWords(W, b, f.path, f.qual);
      else w = stepWords(W, b, names);
      out.set(b.id, w);
    }
  }
  return out;
}
