// Small helpers that give JavaScript the exact behaviour of the Python rules the mapper was written against:
// code-point string order and length, tuple order, truthiness of empty containers, Unicode white space,
// and the JSON text Python writes for a value (sorted keys, no escaping of non-ASCII). Nothing here knows about code.
import crypto from 'node:crypto';

// ---- code points ---------------------------------------------------------------------------------------------------------
// JavaScript orders and measures strings in UTF-16 units; the rules count and order code points. The two agree unless a string
// holds a character above U+FFFF, so lengths and slices take the plain path for strings without a surrogate.
const SURR = /[\uD800-\uDFFF]/;

/** Compare two strings by code point: a surrogate pair (a character above U+FFFF) sorts after every unit from U+E000 up. */
export function cmpStr(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    if (xs !== ys && (xs ? y >= 0xe000 : x >= 0xe000)) return xs ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

/** Python order for strings, numbers, booleans and (element by element) arrays. null sorts first. */
export function cmp(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return cmpStr(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = cmp(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length < 0 ? -1 : a.length === b.length ? 0 : 1;
  }
  if (a == null || b == null) return a == null ? (b == null ? 0 : -1) : 1;
  if (typeof a === 'boolean') a = +a;
  if (typeof b === 'boolean') b = +b;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A sorted copy (ascending, stable). key maps an item to what is compared; like Python's sorted(), it is called once per item, in list order,
 *  before anything is compared (a key that fills a cache must see the items in that order). */
export function sorted(items, key) {
  const arr = Array.from(items);
  if (!key) return arr.sort(cmp);
  const keyed = arr.map((x) => [key(x), x]);
  keyed.sort((a, b) => cmp(a[0], b[0]));
  return keyed.map((k) => k[1]);
}

/** Number of code points. */
export function cpLen(s) {
  if (!SURR.test(s)) return s.length;
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** s[a:b] counted in code points (a, b >= 0 or undefined). */
export function cpSlice(s, a = 0, b) {
  if (!SURR.test(s)) return s.slice(a, b);
  return Array.from(s).slice(a, b).join('');
}

// ---- white space ---------------------------------------------------------------------------------------------------------
/** Python's str.isspace() set, as a regex class body. */
export const PYWS = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const WS_RUN = new RegExp(`[${PYWS}]+`, 'g');
const WS_EDGE = new RegExp(`^[${PYWS}]+|[${PYWS}]+$`, 'g');
export const pyStrip = (s) => s.replace(WS_EDGE, '');
/** re.sub(r'\s+', ' ', s).strip() */
export const squash = (s) => pyStrip(s.replace(WS_RUN, ' '));
/** Python's \w for str patterns (a letter, a digit, an underscore): a regex class body for use with the u flag. */
export const PYW = '\\p{L}\\p{N}_';

/** The shortening rule for box titles: white space collapsed, then cut to n code points with '...' when longer. */
export function short(s, n = 90) {
  const t = squash(s || '');
  return cpLen(t) <= n ? t : cpSlice(t, 0, n - 3) + '...';
}

/** s.replace(old, new, 1): the new text is used as it is (no $ patterns). */
export function replace1(s, old, nw) {
  const i = s.indexOf(old);
  return i < 0 ? s : s.slice(0, i) + nw + s.slice(i + old.length);
}

// ---- truthiness and containers -------------------------------------------------------------------------------------------
/** Python truthiness: empty list, dict, set, string, 0, null and false are all false. */
export function T(x) {
  if (x == null || x === false || x === 0 || x === '') return false;
  if (Array.isArray(x)) return x.length > 0;
  if (x instanceof Map || x instanceof Set) return x.size > 0;
  if (typeof x === 'object') return Object.keys(x).length > 0;
  return true;
}

export const has = (o, k) => o != null && Object.hasOwn(o, k);
/** len() of a list, string or set; 0 for null. */
export const len = (x) => (x == null ? 0 : x instanceof Set || x instanceof Map ? x.size : x.length);

/** defaultdict(list)[k].push(v) */
export function pushTo(map, k, v) {
  let a = map.get(k);
  if (a === undefined) map.set(k, (a = []));
  a.push(v);
  return a;
}
/** defaultdict(int)[k] += n */
export function inc(map, k, n = 1) {
  map.set(k, (map.get(k) ?? 0) + n);
}
/** defaultdict(set)[k].add(v) */
export function addTo(map, k, v) {
  let s = map.get(k);
  if (s === undefined) map.set(k, (s = new Set()));
  s.add(v);
  return s;
}
/** list(dict.fromkeys(items)) : first occurrence of each, in order. Items compare by identity for objects, so pass strings or numbers. */
export const uniq = (items) => Array.from(new Set(items));
/** A key that tells tuples apart: ["a", 1] and ["a", "1"] differ. */
export const tkey = (...parts) => JSON.stringify(parts);

/** re.fullmatch(pattern, s) for a pattern given as source text or a compiled RegExp. */
const fullCache = new Map();
export function fullmatch(pat, s) {
  let re = fullCache.get(pat);
  if (!re) {
    re = new RegExp(`^(?:${typeof pat === 'string' ? pat : pat.source})$`);
    fullCache.set(pat, re);
  }
  return re.test(s);
}

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// ---- JSON as Python writes it --------------------------------------------------------------------------------------------
/** A float that must print the way Python prints it: 1.0, not 1. */
export class PyFloat {
  constructor(v) {
    this.v = v;
  }
}

const ESC = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
const NEEDS_ESC = /["\\\u0000-\u001f]/;
function str(s) {
  if (!NEEDS_ESC.test(s)) return `"${s}"`;
  return `"${s.replace(/["\\\u0000-\u001f]/g, (c) => ESC[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

function num(v) {
  if (Number.isInteger(v)) return String(v);
  if (!Number.isFinite(v)) throw new Error('not a JSON number: ' + v);
  return String(v);
}

function entries(o) {
  const ks = [];
  const src = o instanceof Map ? Array.from(o.keys()) : Object.keys(o);
  for (const k of src) ks.push(k);
  return ks.sort(cmpStr);
}

/** json.dumps(value, sort_keys=True, indent=indent, ensure_ascii=False). indent = null gives the one-line form. */
export function dumps(value, indent = null) {
  const parts = [];
  const nl = (d) => (indent === null ? '' : '\n' + ' '.repeat(indent * d));
  const sep = indent === null ? ', ' : ',';
  const walk = (v, d) => {
    if (v === undefined) throw new Error('dumps: undefined value (a missing field the rules meant to write as null)');
    if (v === null) return void parts.push('null');
    if (typeof v === 'string') return void parts.push(str(v));
    if (typeof v === 'number') return void parts.push(num(v));
    if (typeof v === 'boolean') return void parts.push(v ? 'true' : 'false');
    if (v instanceof PyFloat) return void parts.push(Number.isInteger(v.v) ? v.v.toFixed(1) : String(v.v));
    if (Array.isArray(v) || v instanceof Set) {
      const a = Array.isArray(v) ? v : Array.from(v);
      if (!a.length) return void parts.push('[]');
      parts.push('[');
      a.forEach((x, i) => {
        parts.push((i ? sep : '') + nl(d + 1));
        walk(x, d + 1);
      });
      parts.push(nl(d) + ']');
      return;
    }
    const ks = entries(v);
    if (!ks.length) return void parts.push('{}');
    parts.push('{');
    ks.forEach((k, i) => {
      parts.push((i ? sep : '') + nl(d + 1) + str(k) + ': ');
      walk(v instanceof Map ? v.get(k) : v[k], d + 1);
    });
    parts.push(nl(d) + '}');
  };
  walk(value, 0);
  return parts.join('');
}

// ---- character classes ----------------------------------------------------------------------------------------------------
const UPPER = /^\p{Uppercase}/u;
/** s[:1].isupper() */
export const startsUpper = (s) => !!s && UPPER.test(s);
/** s.isupper(): at least one cased character and no lower-case one. */
export function isUpperStr(s) {
  let cased = false;
  for (const c of s) {
    if (/\p{Lowercase}|\p{Lt}/u.test(c)) return false;
    if (/\p{Uppercase}/u.test(c)) cased = true;
  }
  return cased;
}
/** s.isalnum() */
export const isAlnum = (s) => /^[\p{L}\p{N}]+$/u.test(s);

// ---- Python's text forms -----------------------------------------------------------------------------------------------------
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
const hex = (c, n) => c.toString(16).padStart(n, '0');
/** repr() of a string, a number, a boolean, null or a list of those. */
export function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  const q = v.includes("'") && !v.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of v) {
    const c = ch.codePointAt(0);
    if (ch === q || ch === '\\') out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch !== ' ' && UNPRINTABLE.test(ch)) out += c < 0x100 ? '\\x' + hex(c, 2) : c < 0x10000 ? '\\u' + hex(c, 4) : '\\U' + hex(c, 8);
    else out += ch;
  }
  return out + q;
}

/** round(x, 2) the way Python does it: half to even on exact ties, otherwise the nearer value. */
export function pyRound2(x) {
  const e = x * 8;
  if (Number.isInteger(e) && e % 2 !== 0) { // x is an odd multiple of 1/8: an exact tie at two places
    const f = Math.floor(x * 100);
    return (f % 2 === 0 ? f : f + 1) / 100;
  }
  return Number(x.toFixed(2));
}
