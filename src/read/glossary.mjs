// A glossary of the terms the code uses: names that recur across files. A meaning comes from, in this order: the comment on the class, a code
// comment that says what the word is, a sentence in the README or docs that says what it is, and last a README or docs sentence that merely uses it
// (said to be a use, not a definition). Each meaning says where it came from. A term nothing explains says so. A term is never defined by the first box of a function.
import { clip, cmp, squash } from './util.mjs';

export const MIN_FILES = 3;           // a word is a term when it appears in the names of at least this many files
export const MIN_NAMES = 4;           // ... and in at least this many different names
export const MAX_CLASS_TERMS = 15;
export const MAX_WORD_TERMS = 30;
export const MAX_DOC_FILES = 300;     // doc files whose prose is searched for meanings (README first, then docs in path order)
export const MAX_DOC_BYTES = 200000;  // read from a doc file, at most
export const USE_MIN = 40;            // a sentence that only uses a term must be at least this long to say anything,
export const USE_MAX = 220;           // ... and at most this long to be read as one line

const STOP = new Set(('get set is has can add remove create delete update make build run start stop init new from for with this that value data item items list name names type types args opts options config result results error errors index key keys ' +
  'path file files text string number array object function callback handler handle process check read write load save find all any each next prev last first count size length time date state status info message messages event events call calls context node nodes ' +
  'client server request response user users params param self cls undefined null true false main test tests helper helpers util utils base class method methods default defaults emit constructor close open clear reset apply parse format render wrap into onto than then when where which while their there these those have been being does done just like also only over under after before about other some such very more most much many ' +
  'convert normalize validate ensure resolve register unregister create_ remove_ instance impl internal inner outer local global public private static async await return returns raw args kwargs ' +
  'need needs needed want wanted should would could must might shall will used uses using useful able allowed allow allows required require requires optional current currently pending ready enabled disabled valid invalid ' +
  'good best better bad worst same different another every either neither between within without through during across along around because since until unless although however therefore whether either another ' +
  'thing things stuff something nothing anything everything someone anyone everyone case cases kind kinds sort sorts part parts whole piece pieces bit bits level levels point points place places way ways step steps ' +
  'make makes made making take takes took taken taking give gives gave given giving keep keeps kept keeping let lets put puts set sets sets show shows shown showing send sends sent sending ' +
  'try tries tried trying maybe perhaps already still yet again once twice often never always sometimes usually mostly nearly almost enough several few little').split(/\s+/));

function words(ident) {
  return ident
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-$]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => /^[a-z]{4,}$/.test(w));
}

const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A sentence defines a term only when the term is its subject: "A stalled job is one that ...", "Drained means ...", "Jobs in the system are ...".
 * Strong: the term follows at most an article and the verb is followed by what the thing is ("a", "the", "one", "equivalent to"...).
 * Weak: one describing word may come before the term, and "is" / "are" may be followed by anything but a verb form ("is consuming" and "are processed"
 * say what happens, not what a thing is).
 */
function definitional(sentence, term, strong = false) {
  const t = escRe(term);
  const subject = strong ? '^(?:(?:a|an|the)\\s+)?' : '^(?:(?:a|an|the)\\s+)?(?:[\\w-]+\\s+)?';
  const verb = strong ? '(?:(?:is|are)\\s+(?:a|an|the|one|any|nothing|something|equivalent|just|simply)\\b|(?:means|represents|refers to|stands for)\\b)' : '(?:(?:is|are)\\s+(?!\\w+(?:ed|ing)\\b)|(?:means|represents|refers to|stands for)\\b)';
  return new RegExp(`${subject}${t}s?(?:\\s+(?:in|of|within)\\s+(?:the\\s+)?[\\w-]+(?:\\s+[\\w-]+)?)?\\s+${verb}`, 'i').test(squash(sentence));
}

function firstSentence(s) {
  const t = squash(s);
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(t);
  return clip(m ? m[1] : t, 240);
}

/** A comment on the line above a declaration or at the end of its line. '' when none. */
function commentNear(source, path, line) {
  const f = source.file(path);
  if (!f) return '';
  const here = f.line(line);
  const tr = /(?:\/\/|#|--)\s*(.{12,})$/.exec(here);
  if (tr && !/^\s*(?:\/\/|#|--)/.test(here)) return squash(tr[1]);
  const up = f.line(line - 1).trim();
  const m = /^(?:\/\/+|#+|\*+|\/\*\*?|--+)\s*(.{12,}?)(?:\*\/)?$/.exec(up);
  return m ? squash(m[1]) : '';
}

/** A comment says something about a term only if it is a sentence, not the term repeated. */
function usable(text, term) {
  const t = squash(text ?? '');
  return t.length >= 25 && /\s/.test(t) && t.toLowerCase() !== term.toLowerCase();
}

/** The sentences of the project's README and docs, outside code blocks, with the file each is in: [{s, rel}]. */
export function docSentences(source) {
  const out = [];
  for (const rel of source.docFiles(MAX_DOC_FILES)) {
    if (/(?:^|[/_.-])(?:change-?log|changes|history|releases?|news|migrat\w*)(?:[/_.-]|$)/i.test(rel)) continue;   // what changed is not what a thing is
    const raw = source.rootText(rel);
    if (!raw) continue;
    let fence = false;
    const prose = [];
    for (const line of raw.slice(0, MAX_DOC_BYTES).replace(/\r/g, '').split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence;
        continue;
      }
      if (fence || /^\s*(?:<|\||!\[|\{[%{]|:::|#{1,6}\s*$|[=\-~]{3,}\s*$)/.test(line)) {   // markup that is not prose: tags, tables, images, template and admonition lines
        prose.push('');
        continue;
      }
      const bullet = /^\s*[-*+]\s+\**([^*:–—-]{2,30})\**\s*[:–—-]\s+(.{20,})$/.exec(line);
      prose.push(bullet ? `${bullet[1].trim()} is ${bullet[2].trim()}` : line.replace(/^\s*#{1,6}\s*/, '').replace(/^\s*[-*+]\s+/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]{1,3}/g, ''));
    }
    for (const para of prose.join('\n').split(/\n\s*\n/)) {
      for (const s of squash(para).split(/(?<=[.!?])\s+(?=[A-Z])/)) if (s.length >= 20) out.push({ s, rel });
    }
  }
  return out;
}

function classLine(source, path, name) {
  const f = source.file(path);
  if (!f) return 0;
  const re = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${name}\\b`);
  for (let n = 1; n <= f.lineCount; n++) if (re.test(f.line(n))) return n;
  return 0;
}

/**
 * @returns {{terms: object[], count: number, withMeaning: number, defined: number}}
 */
export function buildGlossary(W, names, words_) {
  const classes = new Map();
  const wordIdents = new Map();
  const fieldFiles = new Map();
  for (const fid of W.mappedIds) {
    const f = W.fns.get(fid);
    const segs = f.qual.split('.').filter((s) => !/^<anon@/.test(s) && s !== '<module>');
    if (segs.length > 1 && /^[A-Z][A-Za-z0-9]+$/.test(segs[0])) {
      if (!classes.has(segs[0])) classes.set(segs[0], { files: new Set(), names: new Set(), path: f.path });
      const c = classes.get(segs[0]);
      c.files.add(f.path);
      c.names.add(segs.slice(1).join('.'));
    }
    for (const s of segs) {
      for (const w of words(s.replace(/~\d+$/, ''))) {
        if (STOP.has(w)) continue;
        if (!wordIdents.has(w)) wordIdents.set(w, { files: new Set(), names: new Set(), examples: [] });
        const e = wordIdents.get(w);
        e.files.add(f.path);
        e.names.add(s);
        if (e.examples.length < 6 && !e.examples.includes(s)) e.examples.push(s);
      }
    }
    for (const b of f.boxes) {
      if (b.kind !== 'decision') continue;
      const full = words_.get(b.id)?.full ?? b.detail ?? '';
      for (const m of full.matchAll(/(?:this|self)\.([A-Za-z_$][\w$]*)/g)) {
        for (const w of words(m[1])) {
          if (STOP.has(w)) continue;
          if (!fieldFiles.has(w)) fieldFiles.set(w, new Map());
          if (!fieldFiles.get(w).has(m[1])) fieldFiles.get(w).set(m[1], { path: f.path, line: b.prov.line });
        }
      }
    }
  }
  const comments = [];
  for (const ff of W.fns.values()) if (ff.doc) comments.push({ s: ff.doc, path: ff.path, line: ff.line });
  for (const m of W.facts?.modules ?? []) if (m.doc) comments.push({ s: m.doc, path: m.path, line: 1 });
  const docs = docSentences(W.source);

  /** What the project's own words say about a term: a code comment, a docs sentence that says what it is, a docs sentence that uses it. */
  const meaningOf = (term, fieldHint) => {
    for (const d of comments) {
      const hit = squash(d.s).split(/(?<=[.!?])\s+/).find((x) => definitional(x, term));
      if (hit && hit.length >= 20) return { meaning: clip(hit, 240), from: `a comment at ${d.path}:${d.line}`, kind: 'defined' };
    }
    // among the sentences that say what it is: the README first, then a page named for the term, then the shortest
    const rank = (d) => [d.rel.includes('/') ? 1 : 0, new RegExp(`(?:^|[/_.-])${escRe(term)}s?(?:[/_.-]|$)`, 'i').test(d.rel) ? 0 : 1, d.s.length];
    const pick = (strong) => docs.filter((d) => definitional(d.s, term, strong)).sort((a, b) => { const x = rank(a); const y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; })[0];
    const dd = pick(true) ?? pick(false);
    if (dd) return { meaning: clip(dd.s, 240), from: `${dd.rel}`, kind: 'defined' };
    if (fieldHint) {
      const c = commentNear(W.source, fieldHint.path, fieldHint.line);
      if (c) return { meaning: clip(c, 240), from: `a comment next to ${fieldHint.name} (${fieldHint.path}:${fieldHint.line})`, kind: 'defined' };
    }
    const re = new RegExp(`\\b${escRe(term)}s?\\b`, 'i');
    const use = docs.find((d) => d.s.length >= USE_MIN && d.s.length <= USE_MAX && re.test(d.s));
    if (use) return { meaning: clip(use.s, 240), from: `${use.rel}`, kind: 'used' };
    return null;
  };

  const terms = [];
  const classRows = [...classes.entries()].filter(([, c]) => c.files.size >= 1 && c.names.size >= 3).sort((a, b) => b[1].names.size - a[1].names.size || cmp(a[0], b[0])).slice(0, MAX_CLASS_TERMS);
  for (const [name, c] of classRows) {
    const line = classLine(W.source, c.path, name);
    const doc = line ? W.source.docFor(c.path, line) : '';
    let meaning = null;
    let from = null;
    let kind = null;
    if (usable(doc, name)) {
      meaning = firstSentence(doc);
      from = `the comment on class ${name} (${c.path}:${line})`;
      kind = 'defined';
    } else {
      const m = meaningOf(name, null);
      if (m) ({ meaning, from, kind } = { meaning: m.meaning, from: m.from, kind: m.kind });
    }
    terms.push({
      term: name, kind: 'class', meaning, meaningFrom: from, meaningKind: kind,
      usage: { files: c.files.size, names: c.names.size, examples: [...c.names].sort(cmp).slice(0, 5), where: [...c.files].sort(cmp).slice(0, 4) },
    });
  }
  const wordRows = [...wordIdents.entries()].filter(([, e]) => e.files.size >= MIN_FILES && e.names.size >= MIN_NAMES).sort((a, b) => b[1].files.size * 2 + b[1].names.size - (a[1].files.size * 2 + a[1].names.size) || cmp(a[0], b[0])).slice(0, MAX_WORD_TERMS);
  for (const [w, e] of wordRows) {
    const first = fieldFiles.has(w) ? [...fieldFiles.get(w).entries()].sort((a, b) => cmp(a[0], b[0]))[0] : null;
    const m = meaningOf(w, first ? { name: first[0], path: first[1].path, line: first[1].line } : null);
    terms.push({
      term: w, kind: 'word', meaning: m?.meaning ?? null, meaningFrom: m?.from ?? null, meaningKind: m?.kind ?? null,
      usage: { files: e.files.size, names: e.names.size, examples: e.examples.slice(0, 5), where: [...e.files].sort(cmp).slice(0, 4) },
    });
  }
  return { terms, count: terms.length, withMeaning: terms.filter((t) => t.meaning).length, defined: terms.filter((t) => t.meaningKind === 'defined').length };
}
