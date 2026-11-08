// What a function is called on the page. Qualified names where they exist; anonymous functions are named by where they are assigned or passed.
import { anonLine } from './world.mjs';
import { squash } from './util.mjs';

const LAMBDA = /(=>|\bfunction\b|\blambda\b)/;
const EVENT_REGISTRARS = new Set(['addEventListener', 'on', 'once', 'addListener']);

/**
 * Find the function value that starts on `line`: {p0, open, floor, tokText}. p0 is where its parameters start,
 * open the offset of the call bracket it is an argument of (-1 when none), floor the earliest offset looked at.
 */
export function locateLambda(f, line) {
  let tok = null;
  for (let n = line; n <= Math.min(line + 2, f.lineCount) && !tok; n++) {
    const a = f.offset(n);
    const seg = f.mask.slice(a, n < f.lineCount ? f.offset(n + 1) : f.text.length);
    const m = LAMBDA.exec(seg);
    if (m) tok = { off: a + m.index, text: m[1] };
  }
  if (!tok) return null;
  const mask = f.mask;
  let p0 = tok.off;
  if (tok.text === '=>') {
    let k = p0 - 1;
    while (k > 0 && /s/.test(mask[k])) k--;
    if (mask[k] === ')') {
      let d = 0;
      for (; k > 0; k--) {
        if (mask[k] === ')') d++;
        else if (mask[k] === '(' && --d === 0) break;
      }
    } else {
      while (k > 0 && /[\w$]/.test(mask[k - 1])) k--;
    }
    p0 = k;
  }
  const asyncM = /\basync\s*$/.exec(mask.slice(Math.max(0, p0 - 8), p0));
  if (asyncM) p0 -= asyncM[0].length;
  const floor = f.offset(Math.max(1, line - 8));
  let depth = 0;
  let open = -1;
  for (let k = p0 - 1; k >= floor; k--) {
    const c = mask[k];
    if (')]}'.includes(c)) depth++;
    else if ('([{'.includes(c)) {
      if (depth === 0) {
        open = k;
        break;
      }
      depth--;
    }
  }
  return { p0, open, floor, tokText: tok.text };
}

/** Where a function value that starts on `line` ends: {startLine, endLine} or null. */
export function anonSpan(source, path, line) {
  const f = source.file(path);
  if (!f || !line) return null;
  const loc = locateLambda(f, line);
  if (!loc) return null;
  const mask = f.mask;
  let depth = 0;
  let seenBlock = false;
  let end = -1;
  for (let k = loc.p0; k < mask.length; k++) {
    const c = mask[k];
    if ('([{'.includes(c)) {
      depth++;
      if (c === '{') seenBlock = true;
    } else if (')]}'.includes(c)) {
      depth--;
      if (depth < 0) {
        end = k;
        break;
      }
      if (depth === 0 && c === '}' && seenBlock) {
        end = k + 1;
        break;
      }
    } else if (depth === 0 && (c === ',' || c === ';')) {
      end = k;
      break;
    } else if (depth === 0 && c === '\n' && f.lang === 'py') {
      end = k;
      break;
    }
  }
  if (end < 0) return null;
  return { startLine: f.lineOf(loc.p0), endLine: f.lineOf(Math.max(loc.p0, end - 1)) };
}

/**
 * Describe an anonymous function from the text around its start.
 * Returns {kind, name, text}: kind is 'passed' (callback passed to NAME), 'assigned' (function assigned to NAME), 'returned', or 'plain'.
 */
export function describeAnon(source, path, line) {
  const f = source.file(path);
  const plain = { kind: 'plain', name: '', text: `anonymous function (line ${line || '?'})` };
  if (!f || !line) return plain;
  const loc = locateLambda(f, line);
  if (!loc) return plain;
  const { p0, open, floor } = loc;
  const mask = f.mask;
  const lead = squash(f.text.slice(Math.max(floor, p0 - 100), p0));
  const asg = /([A-Za-z_$][\w$]*)\s*(?::[^=,(){}]*)?[:=]\s*$/.exec(lead);
  if (asg && !/^(return|async|const|let|var)$/.test(asg[1])) {
    return { kind: 'assigned', name: asg[1], text: `function assigned to ${asg[1]}` };
  }
  if (open >= 0 && mask[open] === '(') {
    const pre = f.text.slice(Math.max(0, open - 120), open);
    const cm = /([A-Za-z_$][\w$]*)\s*(?:<(?:[^()<>;{}]|<[^<>]*>)*>)?\s*$/.exec(pre);
    if (cm) {
      const callee = cm[1];
      const argsBefore = squash(f.text.slice(open + 1, p0));
      const ev = /^['"`]([\w:.-]+)['"`]\s*,$/.exec(argsBefore);
      if (EVENT_REGISTRARS.has(callee)) {
        return { kind: 'passed', name: callee, event: ev ? ev[1] : '', text: ev ? `handler for the "${ev[1]}" event` : `callback passed to ${callee}` };
      }
      return { kind: 'passed', name: callee, text: `callback passed to ${callee}` };
    }
  }
  if (/\breturn\s*$/.test(lead)) return { kind: 'returned', name: '', text: 'function returned to the caller' };
  return plain;
}

/** Shorten a dotted name to its tail so it fits `n` characters. */
export const LABEL_SOFT = 44;   // leading qualifiers (module, class) are dropped until a name is this short
export const LABEL_HARD = 64;   // a name of two parts that is still longer than LABEL_SOFT is kept whole up to this length, so a sidebar row never begins with an ellipsis
export function shortQual(q, n = LABEL_SOFT) {
  if (q.length <= n) return q;
  const parts = q.split('.');
  while (parts.length > 2 && parts.join('.').length > n) parts.shift();
  const s = parts.join('.');
  if (s.length <= n || s.length <= LABEL_HARD) return s;
  return `…${s.slice(s.length - LABEL_HARD + 1)}`;
}

/**
 * Names for all functions: {label, long}. `label` is short for chart titles; `long` adds where it lives.
 * An anonymous function is named by its context, qualified by the named function that holds it.
 */
export function buildNames(W) {
  const names = new Map();
  const nameOf = (fid) => {
    if (names.has(fid)) return names.get(fid);
    const f = W.fns.get(fid);
    let out;
    if (!f) {
      out = { label: fid, long: fid, anon: null };
    } else {
      const last = f.qual.split('.').pop();
      if (f.qual === '<module>') {
        const base = f.path.split('/').pop();
        const what = f.lang === 'lua' ? 'script' : 'top-level code of';
        out = { label: `${what} ${base}`, long: `${what} ${f.path}`, anon: null };
      } else if (/<anon@\d+>/.test(last)) {
        const d = describeAnon(W.source, f.path, anonLine(f.qual));
        const holder = f.parent ? nameOf(f.parent).label : '';
        const label = d.kind === 'plain' ? (holder ? `anonymous function in ${holder}` : d.text) : d.text;
        out = { label, long: holder && d.kind !== 'plain' ? `${label} in ${holder}` : label, anon: d };
      } else {
        const segs = f.qual.split('.').filter((x) => !/^<anon@\d+>$/.test(x)).map((x) => x.replace(/~\d+$/, ''));
        const tail = segs[segs.length - 1];
        const q = (tail === 'constructor' || tail === '__init__') && segs.length > 1 ? `new ${segs[segs.length - 2]}` : segs.join('.');
        out = { label: shortQual(q, 44), long: q, anon: null };
      }
    }
    names.set(fid, out);
    return out;
  };
  for (const fid of W.fnIds) nameOf(fid);
  return { label: (fid) => nameOf(fid).label, long: (fid) => nameOf(fid).long, anon: (fid) => nameOf(fid).anon };
}
