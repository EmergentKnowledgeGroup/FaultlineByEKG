// Plain names for the stages, and one sentence each where the code gives one. A stage is named after the folder that holds most of its
// functions, else after the word its files share, else after its biggest file; the sentence is the comment on the class that dominates it,
// else the comment at the top of its biggest file. When the code has no such comment the stage says so. Same code, same names.
import { cmp } from './util.mjs';

export const DOMINANT_SHARE = 0.6;     // a folder or class holding at least this share of a stage's functions names it
export const SHARED_WORD_SHARE = 0.4;  // a word in the names of at least this share of a stage's files (and at least 3 files) names it
const MIN_SENTENCE = 25;               // a comment shorter than this says too little to be a sentence about a stage

const humanize = (s) => {
  const w = s.replace(/\.[A-Za-z0-9]+$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return w ? w[0].toUpperCase() + w.slice(1) : '';
};
const LANG_NAMES = { ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', lua: 'Lua', go: 'Go', rs: 'Rust', java: 'Java', rb: 'Ruby', php: 'PHP', c: 'C', cc: 'C++', cpp: 'C++', cs: 'C#', kt: 'Kotlin', swift: 'Swift' };
const langOf = (p) => LANG_NAMES[(/\.([A-Za-z0-9]+)$/.exec(p) || [])[1]?.toLowerCase()] || '';
const GENERIC_DIRS = new Set(['src', 'lib', 'source', 'app', 'pkg', 'internal', 'core']);

// A licence or copyright line says who owns the file, never what a stage does.
const LICENCE = /\b(copyright|licen[sc]ed? (?:under|to)|all rights reserved|SPDX-License|permission is hereby granted|without warranty|apache license|mit license|gnu (?:lesser |affero )?general public)\b|^\s*\(c\)\s|©/i;

/** Doc-comment markup turned into the word it points at: {@link Foo} -> Foo, :class:`Foo` -> Foo, `Foo` -> Foo. */
export function plainDoc(t) {
  return String(t)
    .replace(/\{@(?:link|linkplain|code|literal|see)\s+([^}|]*?)(?:\s*\|\s*([^}]*))?\}/g, (_, a, b) => (b || a).trim())
    .replace(/:(?:class|func|meth|mod|attr|exc|data|obj|ref|py:\w+):`~?([^`]*)`/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

/** The sentence a stage may be described by, or '' when the text is a licence line or still has markup in it. */
export function stageSentence(t) {
  const s = plainDoc(t);
  if (!s || LICENCE.test(s) || /(?:^|\s)@\w+|\{@|:\w+:`/.test(s)) return '';
  return s;
}

function firstSentence(raw) {
  const t = plainDoc(raw);
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(t);
  return (m ? m[1] : t).slice(0, 200);
}

/** The comment at the top of a file: a docstring, or a leading block of comment lines. '' when none. */
export function moduleComment(source, path) {
  const f = source.file(path);
  if (!f) return '';
  const lines = [];
  for (let n = 1; n <= Math.min(f.lineCount, 40); n++) {
    const raw = f.line(n);
    const t = raw.trim();
    if (!t || /^#!/.test(t) || /^(?:from|import)\s+__future__/.test(t)) {
      if (lines.length) break;
      continue;
    }
    if (f.lang === 'py') {
      const m = /^[rRuUbB]*("""|''')/.exec(t);
      if (!m) return '';
      const start = f.offset(n) + raw.indexOf(m[1]) + 3;
      const end = f.text.indexOf(m[1], start);
      return firstSentence((end < 0 ? f.text.slice(start, start + 400) : f.text.slice(start, end)).split(/\n\s*\n/)[0]);
    }
    if (/^(?:\/\*\*?|\*|\/\/+|--+)/.test(t)) lines.push(t.replace(/^\/\*\*?|\*\/$|^\*+|^\/\/+|^--+/g, '').trim());
    else break;
    if (/\*\/\s*$/.test(t) && !/^\/\//.test(t)) break;
  }
  const text = lines.filter((l) => l && !/^@\w+/.test(l) && !/^[=\-*#~_ ]{4,}$/.test(l)).join(' ');
  return text ? firstSentence(text) : '';
}

/**
 * @param {{W:object, districts:object}} d
 * @returns {Map<string,{name:string, path:string, about:string, aboutFrom:string}>} by stage id
 */
export function nameStages({ W, districts }) {
  const common = districts.prefix.join('/');
  const members = new Map();
  for (const fid of W.mappedIds) {
    const id = districts.of.get(fid);
    if (!id) continue;
    if (!members.has(id)) members.set(id, []);
    members.get(id).push(fid);
  }
  const out = new Map();
  for (const id of districts.order) {
    const fids = members.get(id) ?? [];
    const byFile = new Map();
    const byDir = new Map();
    const byClass = new Map();
    for (const fid of fids) {
      const f = W.fns.get(fid);
      byFile.set(f.path, (byFile.get(f.path) ?? 0) + 1);
      const dirs = f.path.split('/').slice(0, -1);
      for (let k = dirs.length; k >= 1; k--) {
        const d = dirs.slice(0, k).join('/');
        byDir.set(d, (byDir.get(d) ?? 0) + 1);
      }
      const segs = f.qual.split('.').filter((s) => !/^<anon@/.test(s));
      if (segs.length > 1 && /^[A-Z]/.test(segs[0])) {
        const key = `${f.path}\u0000${segs[0]}`;
        byClass.set(key, (byClass.get(key) ?? 0) + 1);
      }
    }
    const files = [...byFile.keys()].sort(cmp);
    const bigFile = [...byFile.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0] ?? '';
    // the name
    let name = '';
    if (files.length === 1) name = humanize(files[0].split('/').pop());
    if (!name) {
      // the deepest folder that holds most of the stage
      const dirs = [...byDir.entries()].filter(([, n]) => n >= DOMINANT_SHARE * fids.length).sort((a, b) => b[0].split('/').length - a[0].split('/').length || cmp(a[0], b[0]));
      const d = dirs.find(([x]) => !(common === x || common.startsWith(`${x}/`)))?.[0] ?? '';   // a folder every stage sits in names the project, not the stage
      const last = d.split('/').pop();
      if (last && !GENERIC_DIRS.has(last.toLowerCase())) name = humanize(last);
    }
    if (!name) {
      const count = new Map();
      for (const p of files) for (const w of new Set(humanize(p.split('/').pop()).toLowerCase().split(' ').filter((x) => x.length >= 4))) count.set(w, (count.get(w) ?? 0) + 1);
      const top = [...count.entries()].filter(([, n]) => n >= 3 && n >= SHARED_WORD_SHARE * files.length).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0];
      if (top) name = humanize(top[0]);
    }
    if (!name) name = `${humanize(bigFile.split('/').pop())} and ${files.length - 1} other file${files.length === 2 ? '' : 's'}`;
    // the sentence
    let about = '';
    let aboutFrom = '';
    const topClass = [...byClass.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0];
    if (topClass && topClass[1] >= DOMINANT_SHARE * fids.length) {
      const [path, cls] = topClass[0].split('\u0000');
      const line = W.source.classLine(path, cls);
      const doc = line ? stageSentence(W.source.docFor(path, line)) : '';
      if (doc.length >= MIN_SENTENCE) {
        about = firstSentence(doc);
        aboutFrom = `the comment on class ${cls} (${path}:${line})`;
      }
    }
    if (!about && bigFile) {
      const doc = stageSentence(moduleComment(W.source, bigFile) || (W.facts?.modules ?? []).find((m) => m.path === bigFile)?.doc || '');
      if (doc.length >= MIN_SENTENCE) {
        about = firstSentence(doc);
        aboutFrom = `the comment at the top of ${bigFile}`;
      }
    }
    out.set(id, { name, path: districts.titles.get(id) ?? '', about, aboutFrom, ranked: [...byFile.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map((e) => e[0]) });
  }
  // Two stages with one name are told apart by a plain word, never a bracket, a slash or a file extension: the name of the stage's own
  // biggest file, else its next biggest; a plain-word language ("in Python") only where the clashing stages are written in different languages.
  const seen = new Map();
  for (const [id, v] of out) seen.set(v.name, [...(seen.get(v.name) ?? []), id]);
  const taken = new Set([...seen.entries()].filter(([, ids]) => ids.length === 1).map(([n]) => n));
  for (const [name, ids] of seen) {
    if (ids.length < 2) continue;
    const stems = (id) => [...new Set(out.get(id).ranked.map((p) => humanize(p.split('/').pop())).filter(Boolean))];
    const byWord = new Map();
    for (const id of ids) byWord.set(stems(id)[0] || name, [...(byWord.get(stems(id)[0] || name) ?? []), id]);
    for (const [word, group] of byWord) {
      const langs = group.map((id) => langOf(out.get(id).ranked[0] || ''));
      const distinct = group.length > 1 && langs.every(Boolean) && new Set(langs).size === group.length;
      group.forEach((id, i) => {
        const v = out.get(id);
        const tries = distinct ? [`${word} in ${langs[i]}`] : [word, ...stems(id).slice(1)];
        let pick = tries.find((t) => !taken.has(t));
        for (let k = 2; !pick; k++) if (!taken.has(`${word} ${k}`)) pick = `${word} ${k}`;
        taken.add(pick);
        v.name = pick;
      });
    }
  }
  return out;
}
