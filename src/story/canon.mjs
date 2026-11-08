// Stable bytes: object keys sorted by code point, no spaces, one trailing newline. Same value, same bytes, on every machine.
import { createHash } from 'node:crypto';

/** Order two strings by Unicode code point (the default JS order is by UTF-16 unit, which differs above U+FFFF). */
export function cmp(a, b) {
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

function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort(cmp)) if (v[k] !== undefined) o[k] = norm(v[k]);
    return o;
  }
  return v;
}

export function canonJson(v) { return JSON.stringify(norm(v)) + '\n'; }
export function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

/** Why JSON.parse stopped, in our own words. Its message can quote a piece of the file, and a file in a folder someone else made may be a link to one never meant to be shown. */
export function jsonWhere(e) {
  const m = /\(line (\d+) column (\d+)\)$/.exec(String(e?.message ?? '')); // V8 ends the message with the place only when it quotes nothing
  return m ? `not valid JSON (line ${m[1]}, column ${m[2]})` : 'not valid JSON';
}

/** A function id with the suffix that tells apart two functions of one name taken off, and a module-level script named the way the map names it. */
export function normSymbol(sym) {
  return String(sym ?? '').replace(/~\d+$/, '').replace('::<script>', '::<module>');
}

/** Cut a string to at most n code points (never inside a surrogate pair), adding an ellipsis mark when cut. */
export function clip(s, n) {
  const a = Array.from(String(s ?? ''));
  return a.length <= n ? a.join('') : a.slice(0, Math.max(0, n - 1)).join('') + '…';
}

/** Text from an agent or from source, safe to print: control characters become spaces, length is capped. */
export function plain(s, n = 200) {
  return clip(String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(), n);
}
