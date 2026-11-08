// Canonical bytes. A map is only reproducible if every step writes the same text for the same data, on every machine.
//   cmpCp       order strings by Unicode code point (the default JS sort orders by UTF-16 unit, which differs for characters above U+FFFF)
//   canonJson   JSON with keys sorted by code point and one value per line, no indentation; the same text on every platform
//   tkey        one string key for a pair (or more) of strings, for Map and Set keys
import { createHash } from 'node:crypto';

/** Compare two strings by code point: negative, zero or positive. */
export function cmpCp(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x !== y) {
      // a surrogate (U+D800..U+DFFF) stands for a code point above U+FFFF, so it sorts after every unit from U+E000 up
      if (x >= 0xd800 && y >= 0xd800) { x += x >= 0xe000 ? -0x800 : 0x2000; y += y >= 0xe000 ? -0x800 : 0x2000; }
      return x - y;
    }
  }
  return a.length - b.length;
}

/** A copy of the array sorted by code point. */
export const sortedCp = (xs) => [...xs].sort(cmpCp);

/** The keys of a Map or object, sorted by code point. */
export const sortedKeys = (m) => sortedCp(m instanceof Map ? m.keys() : Object.keys(m));

const SEP = '\u0000';
/** One string for a tuple of strings and numbers, safe as a Map or Set key. */
export const tkey = (...parts) => parts.join(SEP);
/** The parts of a tkey, as strings. */
export const untkey = (k) => k.split(SEP);

const str = (s) => JSON.stringify(s);

/** JSON text with keys sorted by code point and every array element and object member on its own line.
 *  Integers and strings only: a non-integer number would be written differently by other languages, so it throws instead of guessing. */
export function canonJson(v) {
  const out = [];
  const w = (x) => {
    if (x === null || x === undefined) { out.push('null'); return; }
    if (x === true || x === false) { out.push(x ? 'true' : 'false'); return; }
    if (typeof x === 'number') {
      if (!Number.isSafeInteger(x)) throw new Error(`canonJson: ${x} is not a safe integer`);
      out.push(String(x)); return;
    }
    if (typeof x === 'string') { out.push(str(x)); return; }
    if (Array.isArray(x)) {
      if (!x.length) { out.push('[]'); return; }
      out.push('[\n');
      x.forEach((e, i) => { if (i) out.push(',\n'); w(e); });
      out.push('\n]'); return;
    }
    if (x instanceof Set) { w(sortedCp(x)); return; }
    const ents = x instanceof Map ? [...x.entries()] : Object.entries(x).filter(([, e]) => e !== undefined);
    if (!ents.length) { out.push('{}'); return; }
    ents.sort((a, b) => cmpCp(a[0], b[0]));
    out.push('{\n');
    ents.forEach(([k, e], i) => { if (i) out.push(',\n'); out.push(str(k), ': '); w(e); });
    out.push('\n}');
  };
  w(v);
  return out.join('');
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
