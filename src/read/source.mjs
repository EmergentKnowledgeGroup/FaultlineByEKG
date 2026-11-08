// Reading source text: line access, a mask that hides strings and comments, balanced statements, call expressions and their arguments.
// Everything is a pure function of the file text. A missing file gives null/empty answers, never an exception.
import fs from 'node:fs';
import nodePath from 'node:path';
import { langOf, squash } from './util.mjs';
import { maskCode } from './mask.mjs';

const KEYWORDS_NOT_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'void', 'await', 'async', 'elif', 'with', 'def', 'class', 'lambda',
  'not', 'and', 'or', 'in', 'is', 'print_', 'yield', 'throw', 'delete', 'new', 'super', 'import', 'from', 'except', 'assert', 'raise', 'until', 'repeat', 'then', 'end', 'do', 'else',
]);

class FileText {
  constructor(text, lang) {
    this.text = text;
    this.lang = lang;
    this.mask = maskCode(text, lang);
    this.starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') this.starts.push(i + 1);
  }

  get lineCount() {
    return this.starts.length;
  }

  /** 1-based line to the offset of its first character. */
  offset(line) {
    return this.starts[Math.max(0, Math.min(line - 1, this.starts.length - 1))];
  }

  lineOf(offset) {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  line(n) {
    if (n < 1 || n > this.starts.length) return '';
    const a = this.starts[n - 1];
    const b = n < this.starts.length ? this.starts[n] - 1 : this.text.length;
    return this.text.slice(a, b).replace(/\r$/, '');
  }

  /** Offset of the bracket that closes the one opened at `open`, or -1. */
  closeOf(open) {
    const pairs = { '(': ')', '[': ']', '{': '}' };
    const want = pairs[this.mask[open]];
    if (!want) return -1;
    let depth = 0;
    for (let i = open; i < this.mask.length; i++) {
      const c = this.mask[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) return c === want ? i : -1;
      }
    }
    return -1;
  }
}

export { maskCode };

export class Source {
  /** @param {string|null} root directory of the mapped source tree (read only) */
  constructor(root) {
    this.root = root ? nodePath.resolve(root) : null;
    this.cache = new Map();
  }

  file(p) {
    if (!this.root || !p) return null;
    if (this.cache.has(p)) return this.cache.get(p);
    let ft = null;
    try {
      const full = nodePath.join(this.root, p);
      if (full.startsWith(this.root) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        ft = new FileText(fs.readFileSync(full, 'utf8'), langOf(p));
      }
    } catch {
      ft = null;
    }
    this.cache.set(p, ft);
    return ft;
  }

  has(p) {
    return this.file(p) !== null;
  }

  /** The raw text of a root-level file (README, package.json ...) or null. */
  rootText(name) {
    if (!this.root) return null;
    try {
      const full = nodePath.join(this.root, name);
      return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : null;
    } catch {
      return null;
    }
  }

  /** Names of the files directly under the root, sorted. */
  rootNames() {
    if (!this.root) return [];
    try {
      return fs.readdirSync(this.root).sort();
    } catch {
      return [];
    }
  }

  /**
   * Documentation files, relative to the root and in a fixed order: the README files at the root first, then the text files under a
   * docs folder in path order. At most `cap` are listed.
   */
  docFiles(cap) {
    if (!this.root) return [];
    const out = [];
    const isDoc = (n) => /\.(?:md|markdown|rst|txt)$/i.test(n);
    for (const n of this.rootNames()) if (/^readme(?:\.[a-z]+)?$/i.test(n) && this._isFile(n)) out.push(n);
    const walk = (rel, depth) => {
      let names = [];
      try {
        names = fs.readdirSync(nodePath.join(this.root, rel)).sort();
      } catch {
        return;
      }
      for (const n of names) {
        if (out.length >= cap) return;
        const r = rel ? `${rel}/${n}` : n;
        if (this._isFile(r)) {
          if (isDoc(n)) out.push(r);
        } else if (depth < 6 && !/^(?:node_modules|\.git|vendor|dist|build)$/.test(n)) walk(r, depth + 1);
      }
    };
    for (const d of ['docs', 'doc', 'documentation']) if (this.rootNames().includes(d)) walk(d, 0);
    return out.slice(0, cap);
  }

  _isFile(rel) {
    try {
      return fs.statSync(nodePath.join(this.root, rel)).isFile();
    } catch {
      return false;
    }
  }

  line(p, n) {
    const f = this.file(p);
    return f ? f.line(n) : '';
  }

  /** Source lines from..to (1-based, inclusive) joined by new lines. */
  slice(p, from, to) {
    const f = this.file(p);
    if (!f) return '';
    const out = [];
    for (let n = from; n <= Math.min(to, f.lineCount); n++) out.push(f.line(n));
    return out.join('\n');
  }

  /**
   * The statement that starts on `line`: text and last line. Brackets are balanced on the masked text; a C-like statement ends at `;`
   * or at a line end with no open bracket and no dangling operator; a Python statement ends at a line end with no open bracket and no `\`.
   */
  statement(p, line, maxLines = 40) {
    const f = this.file(p);
    if (!f || line < 1 || line > f.lineCount) return null;
    const start = f.offset(line);
    let depth = 0;
    let end = start;
    let lastLine = line;
    for (let n = line; n < Math.min(f.lineCount + 1, line + maxLines); n++) {
      const a = f.offset(n);
      const b = n < f.lineCount ? f.offset(n + 1) - 1 : f.text.length;
      const seg = f.mask.slice(a, b);
      for (const ch of seg) {
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
      }
      end = b;
      lastLine = n;
      const trimmed = seg.replace(/\s+$/, '');
      const nextTrim = n < f.lineCount ? f.mask.slice(f.offset(n + 1), f.offset(n + 2) - 1).trim() : '';
      if (depth <= 0) {
        if (f.lang === 'py') {
          if (!trimmed.endsWith('\\')) break;
        } else if (/[;{}]$/.test(trimmed) || !/[-+*/%&|?:,=<>(.]$/.test(trimmed) && !/^[.?&|+\-*/%=<>:]/.test(nextTrim)) break;
      }
    }
    return { text: f.text.slice(start, end), endLine: lastLine };
  }

  /**
   * The signature of the function declared on `line`: the text up to the end of its parameter list and the line that ends it.
   * (A whole statement would run on into the body.) Null when the line has no parameter list.
   */
  signature(p, line) {
    const f = this.file(p);
    if (!f || line < 1 || line > f.lineCount) return null;
    const start = f.offset(line);
    const limit = Math.min(f.text.length, f.offset(Math.min(f.lineCount, line + 3)) + 400);
    const open = f.mask.slice(start, limit).indexOf("(");
    if (open < 0) return null;
    const close = f.closeOf(start + open);
    if (close < 0) return null;
    return { text: f.text.slice(start, close + 1), endLine: f.lineOf(close), open: start + open, close };
  }

  /**
   * The condition of a branch or loop that starts on `line` (`if (..)`, `} else if (..)`, `while (..)`, `elif ..:`, `for (..)`, `for x in y:`).
   * Returns {kind, text} with the whole expression, or null.
   */
  condition(p, line) {
    const here = this.conditionAt(p, line);
    if (here) return here;
    // the tool may point at a line inside a test that runs over several lines: look back for the keyword that opens it
    for (let k = 1; k <= 6 && line - k >= 1; k++) {
      const up = this.conditionAt(p, line - k);
      if (up && up.endLine >= line) return up;
    }
    return null;
  }

  conditionAt(p, line) {
    const f = this.file(p);
    if (!f) return null;
    const a = f.offset(line);
    const lineMask = f.mask.slice(a, f.offset(line + 1) > a ? f.offset(line + 1) : f.text.length);
    if (f.lang === 'py') {
      const m = /^\s*(async\s+)?(elif|if|while|for)\b/.exec(lineMask);
      if (!m) return null;
      const st = this.statement(p, line);
      if (!st) return null;
      const stMask = f.mask.slice(a, a + st.text.length);
      let depth = 0;
      let colon = -1;
      for (let i = m[0].length; i < stMask.length; i++) {
        const ch = stMask[i];
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if (ch === ':' && depth === 0) {
          colon = i;
          break;
        }
      }
      const body = st.text.slice(m[0].length, colon < 0 ? undefined : colon);
      return { kind: m[2], text: squash(body), endLine: st.endLine };
    }
    const m = /(?:^|[^\w$])(?:else\s+)?(if|while|for|switch|until)\s*\(/.exec(lineMask) || (f.lang === 'lua' ? /^\s*(elseif|if|while)\b/.exec(lineMask) : null);
    if (!m) return null;
    if (f.lang === 'lua') {
      const st = this.statement(p, line);
      const km = st ? /^\s*(elseif|if|while)\b/.exec(f.mask.slice(a, a + st.text.length)) : null;
      if (!st || !km) return null;
      const rest = f.mask.slice(a + km[0].length, a + st.text.length);
      const cut = rest.search(/\b(then|do)\b/);
      return { kind: km[1], text: squash(st.text.slice(km[0].length, cut >= 0 ? km[0].length + cut : undefined)), endLine: st.endLine };
    }
    const open = a + m.index + m[0].length - 1;
    const close = f.closeOf(open);
    if (close < 0) return null;
    return { kind: m[1], text: squash(f.text.slice(open + 1, close)), endLine: f.lineOf(close) };
  }

  /** The expression after `return`/`throw`/`raise` on `line`: {kind, text, endLine} or null. */
  exitExpr(p, line) {
    const f = this.file(p);
    if (!f) return null;
    const a = f.offset(line);
    const lm = f.mask.slice(a, f.offset(line + 1) > a ? f.offset(line + 1) : f.text.length);
    const m = /(?:^|[\s;{}])(return|throw|raise)\b/.exec(lm);
    if (!m) return null;
    const st = this.statement(p, line);
    if (!st) return null;
    const kwAt = m.index + m[0].length - m[1].length;
    let text = st.text.slice(kwAt + m[1].length);
    text = text.replace(/[;\s]+$/, '').replace(/^\s+/, '');
    return { kind: m[1], text: squash(text), endLine: st.endLine };
  }

  /**
   * Call expressions whose name starts on lines from..to: [{line, name, recv, full, open, args:[{text, start, end}]}].
   * `name` is the last segment (`push` for `this.items.push(..)`), `recv` the dotted receiver, `full` all of it.
   */
  calls(p, from, to) {
    const f = this.file(p);
    if (!f) return [];
    const out = [];
    const a = f.offset(from);
    const b = Math.min(f.text.length, to + 1 <= f.lineCount ? f.offset(Math.min(f.lineCount, to + 9)) : f.text.length);
    const limit = to + 1 <= f.lineCount ? f.offset(to + 1) : f.text.length;
    const re = /([A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.|::|:)\s*[A-Za-z_$][\w$]*)*)\s*(?:<(?:[^()<>;{}]|<[^<>]*>)*>)?\s*\(/g;
    const seg = f.mask.slice(a, b);
    let m;
    while ((m = re.exec(seg))) {
      const full = m[1].replace(/\s+/g, '');
      const parts = full.split(/\?\.|\.|::|:/);
      const name = parts[parts.length - 1];
      if (KEYWORDS_NOT_CALLS.has(name) && parts.length === 1) continue;
      if (a + m.index >= limit) break;
      const before = seg.slice(Math.max(0, m.index - 12), m.index);
      if (/\b(def|function|class|fn)\s+$/.test(before)) continue;
      const open = a + m.index + m[0].length - 1;
      const isNew = /\bnew\s+$/.test(before);
      out.push({ line: f.lineOf(a + m.index), name: isNew ? name : name, recv: parts.slice(0, -1).join('.'), full, open, nameOff: a + m.index + m[1].lastIndexOf(name), isNew, args: null });
    }
    return out;
  }

  /** The text a call is made on: what stands before `.name(` back to the start of the statement ("$(\"send\")", "window"). */
  receiverText(p, nameOff) {
    const f = this.file(p);
    if (!f) return '';
    let k = nameOff - 1;
    while (k >= 0 && /\s/.test(f.mask[k])) k--;
    if (f.mask[k] === '?') k--;
    if (f.mask[k] !== '.') return '';
    let start = k;
    let depth = 0;
    for (let i = k - 1; i >= Math.max(0, k - 80); i--) {
      const c = f.mask[i];
      if (')]}'.includes(c)) depth++;
      else if ('([{'.includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && /[;,=\n{}]/.test(c)) break;
      start = i;
    }
    return squash(f.text.slice(start, k)).replace(/^(?:await|return|void)\s+/, '').replace(/\?$/, '');
  }

  /** The arguments of a call whose `(` is at `open`: [{text, start, end}] at depth 1 (text is the original, trimmed). */
  args(p, open) {
    const f = this.file(p);
    if (!f) return [];
    const close = f.closeOf(open);
    if (close < 0) return [];
    const res = [];
    let depth = 0;
    let s = open + 1;
    for (let i = open + 1; i < close; i++) {
      const ch = f.mask[i];
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ',' && depth === 0) {
        res.push(this._arg(f, s, i));
        s = i + 1;
      }
    }
    if (f.mask.slice(s, close).trim() !== '') res.push(this._arg(f, s, close));
    if (f.lang !== 'ts') return res;
    const merged = [];
    for (const a of res) {
      const prev = merged[merged.length - 1];
      if (prev && /^<\s*[A-Za-z_$]/.test(prev.masked) && (prev.masked.match(/</g) ?? []).length > (prev.masked.match(/>/g) ?? []).length) {
        prev.masked = `${prev.masked}, ${a.masked}`;
        prev.text = `${prev.text}, ${a.text}`;
        prev.end = a.end;
        prev.endLine = a.endLine;
      } else merged.push(a);
    }
    return merged;
  }

  _arg(f, s, e) {
    const raw = f.text.slice(s, e);
    const lead = raw.length - raw.trimStart().length;
    return { text: squash(raw), start: s + lead, end: e, masked: squash(f.mask.slice(s, e)), startLine: f.lineOf(s + lead), endLine: f.lineOf(Math.max(s, e - 1)) };
  }

  /** The offset-to-line map for a file (used by callers that hold offsets). */
  lineOf(p, offset) {
    const f = this.file(p);
    return f ? f.lineOf(offset) : 0;
  }

  /** A doc comment or docstring that belongs to the declaration on `line`; first paragraph, white space squashed. '' when none. */
  docFor(p, line) {
    const f = this.file(p);
    if (!f) return '';
    if (f.lang === 'py') {
      const st = this.statement(p, line);
      if (!st) return '';
      const nl = st.endLine + 1;
      for (let n = nl; n < Math.min(nl + 3, f.lineCount + 1); n++) {
        const t = f.line(n).trim();
        if (t === '') continue;
        const m = /^[rRuUbB]*("""|''')/.exec(t);
        if (m) {
          const startOff = f.offset(n) + f.line(n).indexOf(m[1]) + 3;
          const end = f.text.indexOf(m[1], startOff);
          return firstParagraph(f.text.slice(startOff, end < 0 ? startOff + 400 : end));
        }
        const s1 = /^[rRuUbB]*(["'])(.*?)\1\s*$/.exec(t);
        return s1 ? squash(s1[2]) : '';
      }
      return '';
    }
    const lines = [];
    for (let n = line - 1; n >= 1 && line - n < 40; n--) {
      const t = f.line(n).trim();
      if (t === '') break;
      if (/^(@|\[|#\[)/.test(t) || /^(export|public|private|protected|static|async|readonly)\b.*[;{]$/.test(t) === false && /^[A-Za-z_$@].*\)\s*$/.test(t) && lines.length === 0 && /^@/.test(t)) continue;
      if (/^(\/\*\*?|\*|\*\/|\/\/|--)/.test(t) || (lines.length && /\*\/$/.test(t))) lines.unshift(t);
      else break;
    }
    if (!lines.length) return '';
    return firstParagraph(lines.map((l) => l.replace(/^\/\*\*?|\*\/$|^\*+|^\/\/+|^--+/g, '').trim()).filter((l) => !/^@\w+/.test(l)).join('\n'));
  }

  /** The line where `class Name` is declared in a file (0 when it is not). */
  classLine(p, name) {
    const f = this.file(p);
    if (!f) return 0;
    const re = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${name}\\b`);
    for (let n = 1; n <= f.lineCount; n++) if (re.test(f.line(n))) return n;
    return 0;
  }

  /** The first line number at or after `from` whose masked text matches `re` (within `to`), or 0. */
  find(p, re, from, to) {
    const f = this.file(p);
    if (!f) return 0;
    for (let n = from; n <= Math.min(to, f.lineCount); n++) if (re.test(f.line(n))) return n;
    return 0;
  }
}

function firstParagraph(s) {
  const paras = s.replace(/\r/g, '').split(/\n\s*\n/);
  return squash(paras[0] ?? '');
}
