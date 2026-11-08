// What a project shows its readers first: the names used in the code examples and the quick start of its README and docs.
// A journey that starts at a name the project itself demonstrates comes before one that does not. Nothing here knows any project: it reads fenced
// and indented code in markdown and reStructuredText, counts the names called or constructed there, and weights the front door more.
import nodePath from 'node:path';

export const MAX_DOC_FILES = 300;         // doc files read (the README first, then docs in path order)
export const MAX_DOC_BYTES = 400000;      // a bigger doc file is read only up to this
const START_WORDS = /quick[ _-]?start|getting[ _-]?started|get[ _-]?started|tutorial|the gist|usage|basic|hello|first steps|example/i;
const DOC_EXT = /\.(?:md|markdown|rst|txt)$/i;
const README = /^readme(?:\.[a-z]+)?$/i;
const NOT_NAMES = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'async', 'new', 'import', 'from', 'with', 'print', 'console', 'log', 'require',
  'def', 'class', 'lambda', 'assert', 'except', 'raise', 'yield', 'elif', 'else', 'try', 'not', 'and', 'or', 'in', 'is', 'super', 'self', 'this', 'true', 'false',
  'null', 'none', 'undefined', 'int', 'str', 'len', 'range', 'list', 'dict', 'set', 'map', 'filter', 'then', 'do', 'end', 'local', 'sleep', 'main',
]);

/** The code blocks of one document: [{code, heading}], from fenced blocks and (for reStructuredText) indented blocks after `::`. */
export function codeBlocks(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out = [];
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      heading = h[1];
      continue;
    }
    if (i + 1 < lines.length && /^[=\-~^"]{3,}\s*$/.test(lines[i + 1]) && line.trim() && !/^\s/.test(line) && lines[i + 1].trim().length >= Math.min(3, line.trim().length)) {
      heading = line.trim();
      continue;
    }
    const fence = /^(\s*)(```|~~~)/.exec(line);
    if (fence) {
      const body = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trimStart().startsWith(fence[2])) body.push(lines[j++]);
      out.push({ code: body.join('\n'), heading });
      i = j;
      continue;
    }
    if (/(?:::|\.\. (?:code-block|code|sourcecode)::.*)\s*$/.test(line)) {
      const body = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || /^\s{2,}\S/.test(lines[j]))) body.push(lines[j++]);
      if (body.some((b) => b.trim())) out.push({ code: body.join('\n'), heading });
      i = j - 1;
    }
  }
  return out;
}

/** Names called or constructed in a piece of code: {calls: string[], classes: string[], words: string[]} (each may repeat). */
export function namesInCode(code) {
  const calls = [];
  const classes = [];
  const words = [];
  for (const m of code.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)/g)) classes.push(m[1]);
  for (const m of code.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:<[^()<>]*>)?\s*\(/g)) if (!NOT_NAMES.has(m[1].toLowerCase())) calls.push(m[1]);
  for (const m of code.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*(?:<[^()<>]*>)?\s*\(/g)) if (!NOT_NAMES.has(m[1].toLowerCase())) calls.push(m[1]);
  for (const m of code.matchAll(/\b([A-Z][A-Za-z0-9_$]{2,})\b/g)) words.push(m[1]);
  for (const m of code.matchAll(/\bfrom\s+[\w.]+\s+import\s+([\w\s,()*]+)/g)) for (const n of m[1].split(/[\s,()]+/)) if (n && n !== '*') words.push(n);
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) if (n.trim()) words.push(n.trim().split(/\s+as\s+/)[0]);
  return { calls, classes, words };
}

/**
 * Names the project's own examples use. A name is "front" when it first appears in a front-door example (the README, a quick start), with the
 * order of that first appearance; every other mention in the docs is only counted.
 * @param {import('./source.mjs').Source} source
 * @returns {{files:number, blocks:number, front:{calls:Map<string,number>, classes:Map<string,number>, words:Map<string,number>}, docs:{calls:Map<string,number>, words:Map<string,number>}}}
 */
export function findExamples(source) {
  const res = {
    files: 0, blocks: 0, frontBlocks: 0,
    front: { calls: new Map(), classes: new Map(), words: new Map() },
    docs: { calls: new Map(), words: new Map() },
  };
  const first = (m, k, at) => {
    if (!m.has(k)) m.set(k, at);
  };
  const count = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const rel of source.docFiles(MAX_DOC_FILES)) {
    const text = source.rootText(rel);
    if (!text) continue;
    const base = nodePath.basename(rel);
    const isFront = README.test(base) && !rel.includes('/');
    const startFile = START_WORDS.test(base);
    const blocks = codeBlocks(text.slice(0, MAX_DOC_BYTES));
    if (!blocks.length) continue;
    res.files++;
    for (const b of blocks) {
      const n = namesInCode(b.code);
      res.blocks++;
      if (isFront || startFile || START_WORDS.test(b.heading)) {
        const at = res.frontBlocks++;
        for (const c of n.calls) first(res.front.calls, c, at);
        for (const c of n.classes) {
          first(res.front.classes, c, at);
          first(res.front.words, c, at);
        }
        for (const c of n.words) first(res.front.words, c, at);
      }
      for (const c of n.calls) count(res.docs.calls, c);
      for (const c of [...n.classes, ...n.words]) count(res.docs.words, c);
    }
  }
  return res;
}

export const TIER_FRONT = 0;      // the project shows this in its front-door examples
export const TIER_DOCS = 1;       // the project shows it somewhere in its docs
export const TIER_NONE = 2;       // no example shows it
export const DOCS_COUNT_CAP = 30; // mentions counted when two docs-only names are compared

/**
 * Where a function stands among the things the project's examples show. A method counts when its name is called in an example and its
 * class is named in an example; a constructor is its class. Returns {tier, at}: front-door functions are ordered by where the examples first
 * reach both names (earlier first), the others by how often the docs show them (more first).
 */
export function exampleRank(ex, qual) {
  const none = { tier: TIER_NONE, at: 0 };
  if (!ex || !ex.blocks) return none;
  const segs = qual.replace(/~\d+$/g, '').split('.').filter((s) => s && !/^<anon@/.test(s));
  const tail = segs[segs.length - 1] ?? '';
  const cls = segs.length >= 2 ? segs[segs.length - 2] : '';
  const ctor = tail === 'constructor' || tail === '__init__';
  const names = ctor ? [cls] : cls ? [tail, cls] : [tail];
  if (!names[0]) return none;
  const kinds = ctor ? ['words'] : cls ? ['calls', 'words'] : ['calls'];
  const front = names.map((n, i) => ex.front[kinds[i]].get(n));
  if (front.every((v) => v !== undefined)) return { tier: TIER_FRONT, at: Math.max(...front) };
  const docs = names.map((n, i) => (ex.docs[kinds[i]].get(n) ?? 0) + (ex.front[kinds[i]].has(n) ? 1 : 0));
  if (docs.every((v) => v > 0)) return { tier: TIER_DOCS, at: -Math.min(DOCS_COUNT_CAP, docs.reduce((a, b) => a + b, 0)) };
  return none;
}
