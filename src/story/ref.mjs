// One citation (path, symbol, line) of a story box or road, resolved against the source and against Layer 1.
import { plain, normSymbol } from './canon.mjs';

/** A line the cited text says nothing on: blank, a comment, only brackets or an `end`. */
const BLANK_OR_COMMENT = /^\s*(?:$|\/\/|#|--|\/\*|\*\/|\*(?:\s|$)|end[\s;,)]*$)/;
/** A line of only brackets and separators holds code only when it is part of a statement or block a tool box starts; then the box covers it. */
const BRACKETS_ONLY = /^\s*[{}()[\];,]*\s*$/;
const SHOWN = 140;

const STRINGS = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const COMMENT = /(?:\/\/|#|--).*$/;
/** The line does not end where a statement ends: it ends in an operator, a comma, a dot or an open bracket. */
const TRAILING = /(?:\\|,|\+|-|\*|\/|&&|\|\||\.|=|\(|\?|\band|\bor|\bnot)$/;
/** The line starts by continuing the one before it. */
const LEADING = /^(?:\.|\)|\]|\}|&&|\|\||\+|\?|:|and\b|or\b)/;
const bare = (t) => t.replace(STRINGS, '""').replace(COMMENT, '').trimEnd();

/** Is line `line` the rest of the statement that starts at line `a`? Read from the source text: open brackets, a trailing operator, or a line that starts by continuing. */
export function continues(ls, a, line) {
  let depth = 0, last = '';
  for (let i = a; i < line; i++) {
    const t = bare(ls[i - 1] ?? '');
    for (const ch of t) { if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; }
    if (t.trim()) last = t.trim();
  }
  if (depth > 0) return true;
  if (TRAILING.test(last)) return true;
  return LEADING.test((ls[line - 1] ?? '').trim());
}

/** Is the cited line one that opens the block the next line stands in (an `else:`, a `try:`, a decorator, an opening brace)? */
export function opensBlock(ls, line) {
  const t = bare(ls[line - 1] ?? '').trim();
  return /[:{]$/.test(t) || t.startsWith('@');
}

/** status:
 *   refused    the path is outside the root or not a plain relative path; the file was never opened
 *   bad-ref    no usable path or line
 *   missing-file / beyond-eof / empty   the cited line does not exist or holds nothing
 *   exact / near   a tool box stands on the line / starts just above or below it
 *   code       real code inside a function the tool read, with no tool box close to the line
 *   file       real code in a file the tool read, outside any function it read
 *   unmapped   real code in a file the tool did not read */
export function resolveRef(ctx, r) {
  const { L, src } = ctx;
  const path = typeof r?.path === 'string' ? r.path : '';
  const line = r?.line;
  const out = { path: plain(path, 160), line: Number.isInteger(line) ? line : null, symbol: plain(r?.symbol ?? '', 200) };
  const rr = src.ref(path);
  if (!rr.ok) { out.status = path ? 'refused' : 'bad-ref'; out.refused = rr.why; return out; }
  out.path = rr.rel;
  if (!Number.isInteger(line) || line < 1) { out.status = 'bad-ref'; return out; }
  const ls = src.lines(rr.rel);
  if (ls == null) {
    const why = src.whyNot(rr.rel);
    if (why === 'outside') { out.status = 'refused'; out.refused = 'path leads outside the root'; } else out.status = 'missing-file';
    return out;
  }
  if (line > ls.length) { out.status = 'beyond-eof'; return out; }
  const text = ls[line - 1];
  out.text = plain(text, SHOWN);
  if (BLANK_OR_COMMENT.test(text)) { out.status = 'empty'; return out; }
  const chain = L.chain(rr.rel, line);
  out.chain = chain;
  const cited = normSymbol(r.symbol);
  out.symrel = chain.length === 0 ? 'n/a' : chain.some((f) => normSymbol(f) === cited) ? 'ok' : L.fnNames.has(cited) ? 'differs' : 'unknown';
  const shape = { continuesFrom: (a) => continues(ls, a, line), opens: () => opensBlock(ls, line) };
  for (const fid of chain) {
    const [how, ids, calls] = L.cover(fid, line, shape);
    if (how === 'exact' || how === 'near') { out.status = how; out.boxes = ids; out.fn = fid; out.calls = calls; return out; }
  }
  if (BRACKETS_ONLY.test(text)) { out.status = 'empty'; return out; }
  if (chain.length) { out.status = 'code'; out.fn = chain[0]; out.boxed = chain.some((f) => L.anchors.has(f)); return out; }
  out.status = L.mods.has(rr.rel) ? 'file' : 'unmapped';
  return out;
}

export const NOT_CODE = new Set(['empty', 'missing-file', 'beyond-eof', 'bad-ref', 'refused']);
export const IN_BOX = new Set(['exact', 'near']);
export const publicRef = (x) => {
  const o = {};
  for (const k of ['path', 'line', 'symbol', 'status', 'refused', 'text', 'symrel', 'fn']) if (x[k] !== undefined) o[k] = x[k];
  return o;
};
