// Fitting words under a cap without cutting a sentence in half: the whole sentences that fit, or nothing.

/** Sentences of a text, each kept whole. */
export function sentences(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out = [];
  let from = 0;
  const end = /[.!?]["')\]]?(?=\s+[A-Z("'‘“]|$)/g;
  for (let m = end.exec(t); m; m = end.exec(t)) { out.push(t.slice(from, m.index + m[0].length).trim()); from = m.index + m[0].length; }
  if (from < t.length) out.push(t.slice(from).trim());
  return out.filter(Boolean);
}

/**
 * The longest run of whole sentences from the start of `text` that fits in `n` characters. Nothing when even the first sentence does not fit:
 * the caller then leaves the field out instead of showing half of it.
 */
export function whole(text, n) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  let out = '';
  for (const s of sentences(t)) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > n) break;
    out = next;
  }
  return out;
}

/**
 * `whole`, and when even the first sentence is too long, the clauses (cut at a comma or semicolon) that fit. Never a phrase cut in the middle: nothing when no clause fits.
 */
export function fitPhrase(text, n) {
  const w = whole(text, n);
  if (w) return w;
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  let out = '';
  for (const part of t.split(/(?<=[,;]) /)) {
    const next = out ? `${out} ${part}` : part;
    if (next.replace(/[,;.]$/, '').length > n) break;
    out = next;
  }
  return out.replace(/[,;.]$/, '');
}
