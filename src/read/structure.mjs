// Block structure read from source text: the arms of if / elif / else, the handlers of a try, the cases of a switch or match, and loops.
// The scanner's facts carry the same records for the functions it read; this reads them from the file when it did not, so a journey can tell
// which lines a run does not reach (the other arm, a case that was not taken, what follows a return) without a scanner.
// Records have the scanner's shape: {line, kind, test, end, then:[a,b], else:[a,b], tt, et}. Python is read by indentation, C-like languages by braces.

const EXIT_CALL = /^(?:sys\.exit|os\._exit|exit|quit|process\.exit)\s*\(/;

/** Offset of the first character of the last statement written directly in the lines range[0]..range[1] (not inside a nested block), or -1. */
function lastStatementStart(ft, range) {
  const from = ft.offset(range[0]);
  const to = range[1] < ft.lineCount ? ft.offset(range[1] + 1) : ft.text.length;
  const m = ft.mask;
  if (ft.lang === 'py') {
    let base = -1;
    let best = -1;
    for (let n = range[0]; n <= Math.min(range[1], ft.lineCount); n++) {
      const raw = m.slice(ft.offset(n), n < ft.lineCount ? ft.offset(n + 1) : ft.text.length);
      const t = raw.trim();
      if (!t) continue;
      const ind = raw.length - raw.replace(/^[ \t]+/, '').length;
      if (base < 0) base = ind;
      if (ind === base && !/^[)\]}]/.test(t) && !/^(elif|else|except|finally)\b/.test(t)) best = ft.offset(n) + ind;
    }
    return best;
  }
  let depth = 0;
  let best = -1;
  let fresh = true;
  for (let i = from; i < to; i++) {
    const c = m[i];
    if (/\s/.test(c)) continue;
    if (fresh && depth === 0 && c !== '}' && c !== ';') {
      best = i;
      fresh = false;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      depth--;
      if (c === '}' && depth === 0) fresh = true;
    } else if (c === ';' && depth === 0) fresh = true;
  }
  return best;
}

/** The text after the header of a block that is one statement with its body written inline (`if (x) return;`, `else: raise E`, a test over several lines), or null. */
function inlineTail(ft, range) {
  const from = ft.offset(range[0]);
  const to = range[1] < ft.lineCount ? ft.offset(range[1] + 1) : ft.text.length;
  const t = ft.mask.slice(from, to);
  if (ft.lang === 'py') {
    const m = /^\s*(?:async\s+)?(?:if|elif|else|for|while|with|except|try|finally)\b/.exec(t);
    if (!m) return null;
    let d = 0;
    for (let i = m[0].length; i < t.length; i++) {
      const c = t[i];
      if ('([{'.includes(c)) d++;
      else if (')]}'.includes(c)) d--;
      else if (c === ':' && d === 0 && t[i + 1] !== '=') {
        const tail = t.slice(i + 1);
        return /^[ \t]*[^\s#]/.test(tail) ? tail.trim() : null;
      }
    }
    return null;
  }
  const m = /^\s*(?:\}\s*)?(?:else\s+)?(?:(if|for|while|switch)\s*\(|else\b|do\b)/.exec(t);
  if (!m) return null;
  let rest = t.slice(m[0].length);
  if (m[1]) {
    let d = 1;
    let i = 0;
    for (; i < rest.length && d > 0; i++) {
      if (rest[i] === '(') d++;
      else if (rest[i] === ')') d--;
    }
    if (d > 0) return null;
    rest = rest.slice(i);
  }
  rest = rest.trim();
  if (rest.startsWith('{')) return null;
  // one statement only: another statement after it means the range is a body, and its last statement decides
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0 && rest.slice(i + 1).trim()) return null;
  }
  return rest;
}

function kindOfText(t) {
  t = t.replace(/^[})\]]+\s*/, '');
  if (/^return\b/.test(t)) return 'return';
  if (/^(raise|throw)\b/.test(t)) return 'raise';
  if (/^break\b/.test(t)) return 'break';
  if (/^continue\b/.test(t)) return 'continue';
  if (EXIT_CALL.test(t)) return 'exit';
  return 'other';
}

/** How a block of lines ends: 'return' | 'raise' | 'break' | 'continue' | 'exit' | 'other'. Read from the last statement written directly in the block (a `with` block is looked into: it runs and falls through). */
export function armEnd(source, path, range) {
  const ft = source.file(path);
  if (!ft || !range) return 'other';
  for (let depth = 0; depth < 4; depth++) {
    const tail = inlineTail(ft, range);
    if (tail !== null) return kindOfText(tail);
    const at = lastStatementStart(ft, range);
    if (at < 0) return 'other';
    const text = ft.mask.slice(at, at + 80);
    if (ft.lang === 'py' && /^(?:async\s+)?with\b/.test(text)) {
      const head = ft.lineOf(at);
      if (head >= range[1]) return 'other';
      range = [head + 1, range[1]];
      continue;
    }
    return kindOfText(text);
  }
  return 'other';
}

/** Does this kind of arm end stop the function for good? */
export const LEAVES_FUNCTION = new Set(['return', 'raise', 'exit']);
/** Does it leave the loop body (the rest of the body does not run)? */
export const LEAVES_BODY = new Set(['break', 'continue']);

const lineText = (ft, n) => ft.mask.slice(ft.offset(n), n < ft.lineCount ? ft.offset(n + 1) : ft.text.length);
const indentOf = (s) => {
  let w = 0;
  for (const c of s) {
    if (c === ' ') w++;
    else if (c === '\t') w += 4;
    else break;
  }
  return w;
};

// ---- Python: indentation --------------------------------------------------------------------------------------------------
function derivePy(source, path, from, to) {
  const ft = source.file(path);
  const branches = [];
  const loops = [];
  const N = Math.min(to, ft.lineCount);
  const sig = [];
  for (let n = from; n <= N; n++) {
    const raw = lineText(ft, n);
    if (raw.trim()) sig.push({ n, t: raw.trim(), ind: indentOf(raw) });
  }
  const idxAfter = (line) => {
    let lo = 0;
    let hi = sig.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sig[mid].n > line) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const headEnd = (k) => {
    const st = source.statement(path, sig[k].n);
    return Math.max(sig[k].n, st?.endLine ?? sig[k].n);
  };
  /** The block of the header at sig[k]: [first, last] lines (the header line itself when the body is written after the colon), or null. */
  const blockOf = (k) => {
    const he = headEnd(k);
    const hdr = lineText(ft, he).trim();
    const colon = hdr.lastIndexOf(':');
    if (colon >= 0 && colon < hdr.length - 1 && !/^#/.test(hdr.slice(colon + 1).trim())) return [he, he];
    let first = null;
    let last = null;
    for (let j = idxAfter(he); j < sig.length; j++) {
      if (sig[j].ind <= sig[k].ind) break;
      if (first === null) first = sig[j].n;
      last = sig[j].n;
    }
    return first === null ? null : [first, last];
  };
  /** The next statement after a line, when it sits at the given indent (a continuation: elif, else, except, finally), else -1. */
  const contAt = (line, ind) => {
    const j = idxAfter(line);
    return j < sig.length && sig[j].ind === ind ? j : -1;
  };
  const chainEnd = (k) => {
    const b = blockOf(k);
    const end = b ? b[1] : headEnd(k);
    const j = contAt(end, sig[k].ind);
    return j >= 0 && /^(elif|else)\b/.test(sig[j].t) ? chainEnd(j) : end;
  };
  for (let k = 0; k < sig.length; k++) {
    const x = sig[k];
    const m = /^(?:async\s+)?(if|elif|try|for|while|match)\b/.exec(x.t);
    if (!m) continue;
    const kw = m[1];
    const blk = blockOf(k);
    if (!blk) continue;
    if (kw === 'for' || kw === 'while') {
      loops.push({ line: x.n, end: blk[1], kind: kw, test: x.t.replace(/:\s*$/, '') });
    } else if (kw === 'if' || kw === 'elif') {
      let elseRange = null;
      let et = 'none';
      let end = blk[1];
      const j = contAt(blk[1], x.ind);
      if (j >= 0 && /^elif\b/.test(sig[j].t)) {
        end = chainEnd(j);
        elseRange = [sig[j].n, end];
        et = 'elif';
      } else if (j >= 0 && /^else\b/.test(sig[j].t)) {
        const eb = blockOf(j);
        if (eb) {
          elseRange = eb;
          end = eb[1];
          et = armEnd(source, path, eb);
        }
      }
      branches.push({ line: x.n, kind: kw, test: x.t.replace(/^(el)?if\s+/, '').replace(/:\s*$/, ''), end, then: blk, ...(elseRange ? { else: elseRange } : {}), tt: armEnd(source, path, blk), et });
    } else if (kw === 'try') {
      let handlers = null;
      let end = blk[1];
      for (let j = contAt(end, x.ind); j >= 0 && /^(except|else|finally)\b/.test(sig[j].t); j = contAt(end, x.ind)) {
        const eb = blockOf(j);
        if (!eb) break;
        if (/^except\b/.test(sig[j].t)) handlers = handlers ? [handlers[0], eb[1]] : eb.slice();
        end = eb[1];
      }
      branches.push({ line: x.n, kind: 'try', test: 'except', end, then: blk, ...(handlers ? { else: handlers } : {}), tt: 'other', et: 'other' });
    } else if (kw === 'match') {
      branches.push({ line: x.n, kind: 'match', test: x.t.replace(/^match\s+/, '').replace(/:\s*$/, ''), end: blk[1], then: blk, tt: 'other', et: 'other' });
    }
  }
  return { branches, loops };
}

// ---- C-like: braces --------------------------------------------------------------------------------------------------------
function deriveBrace(source, path, from, to) {
  const ft = source.file(path);
  const branches = [];
  const loops = [];
  const N = Math.min(to, ft.lineCount);
  const mask = ft.mask;
  const lineStart = (n) => ft.offset(n);
  const ws = (i) => {
    while (i < mask.length && /\s/.test(mask[i])) i++;
    return i;
  };
  /** From the offset after a header's closing paren: the block {open, close} or a single statement's end offset. */
  const bodyAt = (i) => {
    i = ws(i);
    if (mask[i] === '{') {
      const c = ft.closeOf(i);
      return c < 0 ? null : { open: i, close: c, braces: true };
    }
    // a single statement: to the next `;` at depth 0
    let d = 0;
    for (let k = i; k < mask.length; k++) {
      const ch = mask[k];
      if ('([{'.includes(ch)) d++;
      else if (')]}'.includes(ch)) d--;
      else if (ch === ';' && d <= 0) return { open: i, close: k, braces: false };
    }
    return null;
  };
  const rangeOf = (b) => {
    if (!b) return null;
    const a = ft.lineOf(b.open);
    const z = ft.lineOf(b.close);
    if (!b.braces || a === z) return [a, z];
    const first = ft.lineOf(ws(b.open + 1));
    // the last line of the body is the line of its last character before the closing brace: the indent in front of a `} else if (...) {` line is not part of the body
    let back = b.close - 1;
    while (back > b.open && /\s/.test(mask[back])) back--;
    const lastBefore = ft.lineOf(Math.max(b.open, back));
    let zz = lastBefore;
    while (zz > first && !lineText(ft, zz).trim().replace(/[}\s;]/g, '')) zz--;
    return [Math.min(first, zz), zz];
  };
  const parenEnd = (open) => ft.closeOf(open);
  const re = /(^|[^\w$.])(if|for|while|switch|try|do)\b/g;
  const scan = mask.slice(lineStart(from), N < ft.lineCount ? lineStart(N + 1) : mask.length);
  const base = lineStart(from);
  let m;
  while ((m = re.exec(scan))) {
    const kw = m[2];
    const kwOff = base + m.index + m[1].length;
    const line = ft.lineOf(kwOff);
    // `else if` is read as part of its chain, not as a new head
    const before = mask.slice(Math.max(0, kwOff - 8), kwOff);
    const isElseIf = kw === 'if' && /\belse\s*$/.test(before);
    let p = ws(kwOff + kw.length);
    if (kw === 'try' || kw === 'do') {
      const b = bodyAt(p);
      if (!b) continue;
      if (kw === 'do') {
        loops.push({ line, end: ft.lineOf(b.close), kind: 'do', test: '' });
        continue;
      }
      let handlers = null;
      let end = ft.lineOf(b.close);
      let q = ws(b.close + 1);
      for (;;) {
        const mm = /^(catch|finally)\b/.exec(mask.slice(q, q + 8));
        if (!mm) break;
        let r = q + mm[1].length;
        r = ws(r);
        if (mask[r] === '(') r = ws(parenEnd(r) + 1);
        const hb = bodyAt(r);
        if (!hb) break;
        const hr = [ft.lineOf(q), ft.lineOf(hb.close)];
        if (mm[1] === 'catch') handlers = handlers ? [handlers[0], hr[1]] : hr;
        end = hr[1];
        q = ws(hb.close + 1);
      }
      branches.push({ line, kind: 'try', test: 'catch', end, then: rangeOf(b), ...(handlers ? { else: handlers } : {}), tt: 'other', et: 'other' });
      continue;
    }
    if (mask[p] !== '(') continue;
    const pe = parenEnd(p);
    if (pe < 0) continue;
    const testText = source.slice(path, line, ft.lineOf(pe)).replace(/\s+/g, ' ');
    const tm = /\(\s*(.*)\)\s*\{?\s*$/.exec(testText);
    const test = tm ? tm[1] : '';
    const b = bodyAt(pe + 1);
    if (!b) continue;
    if (kw === 'for' || kw === 'while') {
      loops.push({ line, end: ft.lineOf(b.close), kind: kw, test });
      continue;
    }
    if (kw === 'switch') {
      branches.push({ line, kind: 'match', test, end: ft.lineOf(b.close), then: rangeOf(b), tt: 'other', et: 'other' });
      continue;
    }
    // if: follow the chain of `else if` / `else`
    const thenR = rangeOf(b);
    let elseR = null;
    let et = 'none';
    let chainEnd = ft.lineOf(b.close);
    let q = ws(b.close + 1);
    if (/^else\b/.test(mask.slice(q, q + 5))) {
      let r = ws(q + 4);
      if (/^if\b/.test(mask.slice(r, r + 3))) {
        // the chain: the head of the next `if` is found by the same scan; here only its extent
        let cur = b;
        let end = ft.lineOf(b.close);
        for (;;) {
          const qq = ws(cur.close + 1);
          if (!/^else\b/.test(mask.slice(qq, qq + 5))) break;
          let rr = ws(qq + 4);
          if (/^if\b/.test(mask.slice(rr, rr + 3))) {
            rr = ws(rr + 2);
            if (mask[rr] !== '(') break;
            const nb = bodyAt(parenEnd(rr) + 1);
            if (!nb) break;
            cur = nb;
            end = ft.lineOf(nb.close);
          } else {
            const nb = bodyAt(rr);
            if (!nb) break;
            end = ft.lineOf(nb.close);
            cur = nb;
            break;
          }
        }
        elseR = [ft.lineOf(q), end];
        chainEnd = end;
        et = 'elif';
      } else {
        const eb = bodyAt(r);
        if (eb) {
          elseR = rangeOf(eb);
          chainEnd = ft.lineOf(eb.close);
          et = armEnd(source, path, elseR);
        }
      }
    }
    if (isElseIf) {
      branches.push({ line, kind: 'elif', test, end: chainEnd, then: thenR, ...(elseR ? { else: elseR } : {}), tt: armEnd(source, path, thenR), et });
    } else {
      branches.push({ line, kind: 'if', test, end: chainEnd, then: thenR, ...(elseR ? { else: elseR } : {}), tt: armEnd(source, path, thenR), et });
    }
  }
  return { branches, loops };
}

/**
 * Branches and loops of the lines from..to of a file, in the scanner's shape. Languages without a reader here give none.
 * @returns {{branches: object[], loops: object[]}}
 */
export function deriveStructure(source, path, from, to, lang) {
  const ft = source.file(path);
  if (!ft || !from || !to) return { branches: [], loops: [] };
  let r;
  try {
    r = lang === 'py' ? derivePy(source, path, from, to) : lang === 'ts' ? deriveBrace(source, path, from, to) : { branches: [], loops: [] };
  } catch {
    r = { branches: [], loops: [] };
  }
  r.branches.sort((a, b) => a.line - b.line || b.end - a.end);
  return r;
}

/**
 * The cases of a switch or match whose body is the line range `range`: [{label, from, to}], or [] when fewer than two are found.
 * A case label is a line that starts with `case` or `default` at the shallowest indent that has one.
 */
export function caseRanges(source, path, range) {
  const ft = source.file(path);
  if (!ft || !range) return [];
  const labels = [];
  for (let n = range[0]; n <= Math.min(range[1], ft.lineCount); n++) {
    const raw = lineText(ft, n);
    const t = raw.trim();
    if (/^(case\b|default\s*:)/.test(t)) labels.push({ n, ind: indentOf(raw), t });
  }
  if (labels.length < 2) return [];
  const ind = Math.min(...labels.map((l) => l.ind));
  const top = labels.filter((l) => l.ind === ind);
  if (top.length < 2) return [];
  return top.map((l, i) => ({ label: l.t.replace(/:\s*(\{)?\s*$/, '').replace(/^case\s+/, '').slice(0, 60), from: l.n, to: i + 1 < top.length ? top[i + 1].n - 1 : range[1] }));
}

const NOT_A_FUNCTION_HEAD = /^(?:if|for|while|switch|catch|else|try|finally|do|with)\b|^\}?\s*else\b/;

/**
 * Where a function lies in its file when the scanner gave no extent: from its signature to the end of its body. The function is known only by
 * the lines of its first and last box, so the signature is looked for above the first box and the end below the last.
 * @returns {{from:number, to:number}|null}
 */
export function functionExtent(source, path, firstBox, lastBox, lang) {
  const ft = source.file(path);
  if (!ft || !firstBox) return null;
  if (lang === 'py') {
    const ind0 = indentOf(lineText(ft, firstBox));
    let head = 0;
    for (let n = firstBox - 1; n >= 1; n--) {
      const raw = lineText(ft, n);
      const t = raw.trim();
      if (!t) continue;
      const ind = indentOf(raw);
      if (ind < ind0) {
        if (/^(?:async\s+)?def\b/.test(t)) head = n;
        break;
      }
    }
    if (!head) return null;
    const hind = indentOf(lineText(ft, head));
    let end = Math.max(head, lastBox);
    for (let n = head + 1; n <= ft.lineCount; n++) {
      const raw = lineText(ft, n);
      if (!raw.trim()) continue;
      if (indentOf(raw) <= hind && n > lastBox) break;
      end = Math.max(end, n);
      if (indentOf(raw) <= hind && n <= lastBox) continue;
    }
    return { from: head, to: end };
  }
  if (lang !== 'ts') return null;
  const m = ft.mask;
  let i = ft.offset(firstBox);
  for (let guard = 0; guard < 40; guard++) {
    let depth = 0;
    let open = -1;
    for (let k = i - 1; k >= 0; k--) {
      const c = m[k];
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) {
          open = k;
          break;
        }
        depth--;
      }
    }
    if (open < 0) return null;
    const before = m.slice(Math.max(0, open - 200), open);
    // the head is what follows the last statement end or block start: `if (a) { handler = () => {` has the head `handler = () =>`, not `if (a) { handler = () =>`
    const head = before.slice(Math.max(before.lastIndexOf(';'), before.lastIndexOf('{')) + 1).replace(/^[\s}]+/, '').replace(/\s+/g, ' ').trim();
    const stmt = head.slice(head.lastIndexOf('}') + 1).trim();
    if (!NOT_A_FUNCTION_HEAD.test(stmt) && /[)]\s*(?::[^{]*)?(?:=>)?\s*$/.test(stmt)) {
      const close = ft.closeOf(open);
      if (close < 0) return null;
      return { from: ft.lineOf(Math.max(0, open - stmt.length - 1)), to: Math.max(ft.lineOf(close), lastBox) };
    }
    i = open;
  }
  return null;
}
