// Small deterministic helpers shared by the reading rules.
// Nothing here depends on locale, the clock, the file system order or object key order.

/** Code-point order comparison (never localeCompare: it depends on the machine). */
export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort a copy by one or more key functions; keys compare as numbers or strings, ties fall through to the next key. */
export function sortBy(arr, ...keys) {
  return [...arr].sort((x, y) => {
    for (const k of keys) {
      const a = k(x);
      const b = k(y);
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return 0;
  });
}

/** JSON with every object's keys sorted: the same value always gives the same bytes. */
export function stableStringify(value, indent) {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort(cmp)) {
      if (v[k] !== undefined) out[k] = sortKeys(v[k]);
    }
    return out;
  }
  return v;
}

/** Collapse runs of white space (including new lines) to one space. */
export function squash(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Cut `s` to at most `n` characters. A cut is always marked with an ellipsis and happens at a word edge when one is near,
 * so a reader sees "...", never a half token.
 */
export function clip(s, n) {
  s = squash(s);
  if (s.length <= n) return s;
  const room = n - 1;
  let cut = s.slice(0, room);
  const edge = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf(','), cut.lastIndexOf('.'), cut.lastIndexOf('('));
  if (edge >= room * 0.6) cut = cut.slice(0, edge);
  return cut.replace(/[\s,.(]+$/, '') + '…';
}

/** `s` in double quotes. When it had to be cut the ellipsis ends it and no closing quote follows, so a cut text never looks whole. */
export function quoted(s, n) {
  const t = squash(s);
  return t.length <= n ? `"${t}"` : `"${clip(t, n)}`;
}

/** Count items by a key function: [[key, count], ...] biggest first, ties by key. */
export function tally(items, keyOf) {
  const m = new Map();
  for (const x of items) {
    const k = keyOf(x);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || cmp(String(a[0]), String(b[0])));
}

/** "1 box", "2 boxes". */
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many ?? one + 's'}`;
}

/** A short, stable, hash-free id piece from any text. */
export function slug(s) {
  return String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'x';
}

/** Language of a file by its extension. */
export function langOf(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  const e = m ? m[1].toLowerCase() : '';
  if (e === 'py' || e === 'pyi') return 'py';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].includes(e)) return 'ts';
  if (e === 'lua') return 'lua';
  return e || 'other';
}

export function uniq(arr) {
  return [...new Set(arr)];
}
