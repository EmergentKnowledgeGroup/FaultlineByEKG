// `faultline review`: a work-list for an agent, built from the not-confident claims of the claim register, and a gate that re-checks the agent's answers
// (review_check.mjs).
//
//   buildItems(map, claims, root) -> items     one per question, ordered by order(): main path first, failures next, the rest last; each has ONE concrete
//                                              question, the lines needed, and a small closed set of answers.
//
// `map` is the finished map as the review needs it: { boxes: Map id -> box (with `fn`), roads: Map id -> road, mods: [paths], fns: Map id -> {line, end, qual,
// cls, calls}, classes: Map key -> {line, mod} }. reviewView() builds it from a model file and the index map.mjs writes beside it.
import { RootedSource } from '../story/source.mjs';
import { cmp, sorted, pyStrip, cpSlice, squash } from './pyrt.mjs';

export const SCHEMA_Q = 'faultline.review-queue/1';
export const SCHEMA_A = 'faultline.review-answers/1';
export const SCHEMA_R = 'faultline.review-checked/1';
export const CANT = 'cannot-tell';
const EFFECT_WORD = {
  store: 'write to storage (a file, a database or a store)', delete: 'delete from storage', emit: 'message handed to another part of the program',
  respond: 'reply sent back to a caller', wait: 'wait that blocks until something happens', ext: 'call that leaves the process', call: 'call whose effect is unknown',
};
export const TEMPLATES = {
  effect: { pos: ['yes'], neg: ['no'] },
  catch: { pos: ['caught-at-cited-line'], neg: ['not-caught'] },
  entry: { pos: ['called-at-cited-line'], neg: ['not-called'] },
  absence: { pos: ['used-at-cited-line'], neg: ['not-used'] },
  target: { pos: null, neg: ['none-of-these'] },
  hears: { pos: ['tells-someone-at-cited-line'], neg: ['tells-no-one'] },
  handler: { pos: ['tells-someone-at-cited-line'], neg: ['tells-no-one'] },
  lock: { pos: ['yes-a-lock-or-queue'], neg: ['no-not-one'] },
  type: { pos: ['project-class', 'library-class', 'builtin-class'], neg: [] },
  excroad: { pos: ['yes-can-raise'], neg: ['no-cannot'] },
  places: { pos: ['same-meaning'], neg: ['different-meaning'] },
};
export const ANSWERS = {
  effect: ['yes', 'no'], catch: ['caught-at-cited-line', 'not-caught'], entry: ['called-at-cited-line', 'not-called'],
  absence: ['used-at-cited-line', 'not-used'], hears: ['tells-someone-at-cited-line', 'tells-no-one'], handler: ['tells-someone-at-cited-line', 'tells-no-one'],
  lock: ['yes-a-lock-or-queue', 'no-not-one'], type: ['project-class', 'library-class', 'builtin-class'], excroad: ['yes-can-raise', 'no-cannot'],
  places: ['same-meaning', 'different-meaning'],
};
const WINDOW = 4; // lines shown around the claim
const MAX_LINES = 16; // lines kept per question
const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);
const words = (s) => s.split(/[^A-Za-z0-9_]+/).filter((x) => x);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Which claim (type, reason) gets which question. */
export function templateOf(c) {
  const { type: t, reason: r } = c;
  if (c.conf !== 'not-confident' || c.pinned) return null;
  if (t === 'declined') return 'effect';
  if (t === 'call-road') return 'target';
  if (t === 'exc-road') return 'excroad';
  if (t === 'entry') return r === 'a-caller-is-on-the-map' ? null : 'entry';
  if (t === 'negative') {
    if (c.id.startsWith('n:')) return 'catch';
    if ((c.finding ?? '').startsWith('swallowed_known_failure')) return 'handler'; // does anyone hear of the failure this handler takes?
    if (c.finding === 'handler_nothing_can_reach') return 'excroad';
    return 'absence';
  }
  if (t === 'hears') return c.id.startsWith('h:') && c.template === 'handler' ? 'handler' : 'hears';
  if ((t === 'kind' || t === 'wait') && (r === 'lock-matched-by-name-only' || r === 'wait-kind-by-name')) return 'lock';
  if (t === 'kind' && (r === 'exception-type-unknown' || r === 'exception-name-in-several-classes')) return 'type';
  if (t === 'title' && r === 'one-box-covers-several-sites') return 'places';
  if (t === 'title' && r === 'title-names-a-possible-target') return 'target';
  return null;
}

/** Source files of the mapped project, read on demand. Only a file the map lists (`mods`) is opened, and only through RootedSource: a path that leaves the
 *  root, or a link that leads out of it, reads as missing. `mods` null opens any file under the root (a caller that holds no map). */
export class Src {
  constructor(root, mods = null) {
    this.root = root.replace(/\/+$/, '');
    this.gate = new RootedSource(root);
    this.mods = mods == null ? null : new Set(mods);
    this._t = new Map();
  }

  /** Does the map list this path? Compared as written: the digest covers exactly the listed strings. */
  has(rel) { return this.mods === null || this.mods.has(rel); }

  lines(rel) {
    if (!this._t.has(rel)) {
      const l = this.has(rel) ? this.gate.lines(rel) : null;
      if (l && l.length && l[0].charCodeAt(0) === 0xfeff) l[0] = l[0].slice(1); // a byte order mark is not part of the line (the gate's copy is ours alone)
      this._t.set(rel, l);
    }
    return this._t.get(rel);
  }

  grep(name, files, limit = 6) {
    const out = [];
    const rx = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`);
    for (const p of files) {
      const ls = this.lines(p) ?? [];
      for (let i = 0; i < ls.length; i++) {
        if (ls[i].includes(name) && rx.test(ls[i])) {
          out.push({ path: p, line: i + 1, text: cpSlice(pyStrip(ls[i]), 0, 200) });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }
}

export const norm = (s) => squash(s);

function windowLines(src, rel, line, before = 3, after = 3, lo = null, hi = null) {
  const ls = src.lines(rel) ?? [];
  const a = Math.max(1, line - before, lo || 1);
  const b = Math.min(ls.length, line + after, hi || ls.length);
  const out = [];
  for (let i = a; i <= b; i++) out.push({ path: rel, line: i, text: cpSlice(ls[i - 1].replace(/[\s]+$/, ''), 0, 220) });
  return out;
}

const textLine = (ls, i) => cpSlice(pyStrip(ls[i]), 0, 200);

/** Groups the not-confident claims into questions and fills in the lines. -> list of items, unordered.
 *  A claim whose path the map does not list gets no question (the claim file may not be the one the map was made with); `stats.skipped` counts those. */
export function buildItems(map, claims, root, files = null, stats = null) {
  const src = new Src(root, map.mods);
  const fileList = files ?? sorted(map.mods);
  const items = [];
  const groups = new Map();
  const put = (key, c) => {
    const k = JSON.stringify(key);
    if (!groups.has(k)) groups.set(k, { key, cs: [] });
    groups.get(k).cs.push(c);
  };
  const ncBoxes = new Set(claims.filter((c) => c.conf === 'not-confident' && c.id.startsWith('n:')).map((c) => c.id));
  for (const c of claims) {
    const t = templateOf(c);
    if (t === null) continue;
    if (t === 'hears' && c.id.startsWith('h:') && ncBoxes.has('n:' + c.subject)) put(['catch', 'n:' + c.subject], c); // one question per raise: who catches it also answers who hears it
    else if (t === 'target' && c.type === 'call-road') put(['target', c.fn, c.line, map.roads.get(c.subject).from], c);
    else if (t === 'lock') put([t, c.subject], c); // the box kind and its 'waits on' claim are one question
    else put([t, c.id], c);
  }
  for (const { key, cs } of groups.values()) {
    cs.sort((a, b) => cmp([a.id.startsWith('n:') ? 0 : 1, a.id], [b.id.startsWith('n:') ? 0 : 1, b.id]));
    const c = cs[0];
    const rel = c.path;
    if (!src.has(rel)) { if (stats) stats.skipped = (stats.skipped ?? 0) + 1; continue; }
    const t = key[0];
    const fid = c.fn;
    const fn = map.fns.get(fid) ?? null;
    const line = c.line || (fn ? fn.line : 1);
    const ls = src.lines(rel) ?? [];
    const [lo, hi] = fn ? [fn.line, fn.end || ls.length] : [1, ls.length];
    const isTargetRoad = t === 'target' && c.type === 'call-road';
    const item = {
      item: !isTargetRoad ? 'q:' + c.id : 'q:target:' + c.fn + ':' + c.line + ':' + map.roads.get(c.subject).from,
      template: t, claims: sorted(cs.map((x) => x.id)), where: `${rel}:${line}`, fn: fid, path: rel, line,
      main: cs.some((x) => x.main), depth: Math.min(...cs.map((x) => x.depth ?? 99)), failure: cs.some((x) => x.failure),
      reason: c.reason, lines: windowLines(src, rel, line, WINDOW, WINDOW, lo, hi), subject: [],
    };
    if (t === 'effect') {
      const f = c.call || '';
      const rootName = f.includes('.') ? f.split('.')[0] : '';
      item.question = `Is the call \`${f}\` at ${rel}:${line} a ${EFFECT_WORD[c.effect.split(':')[0]] ?? c.effect}? The tool could not decide: ${c.why}.`;
      item.subject = words(f);
      if (rootName && fn) {
        const bind = new RegExp(`(?<![A-Za-z0-9_.])${escapeRe(rootName)}\\s*(:|=(?!=)|,.*=|\\bin\\b)`);
        const found = [];
        for (let i = lo - 1; i < Math.min(hi, ls.length); i++) if (bind.test(ls[i]) && i + 1 !== line) found.push({ path: rel, line: i + 1, text: textLine(ls, i) });
        item.lines.push(...found.slice(0, 4));
        const imps = [];
        for (let i = 0; i < Math.min(ls.length, 80); i++) if (/^\s*(import|from)\s/.test(ls[i]) && ls[i].includes(rootName)) imps.push({ path: rel, line: i + 1, text: textLine(ls, i) });
        item.lines.push(...imps.slice(0, 3));
      }
      item.effect = c.effect;
      item.recv = rootName;
      if ((rootName === 'self' || rootName === 'this') && fn && map.classes.has(fn.cls)) {
        const ck = map.classes.get(fn.cls);
        if (ck.line) item.lines.push({ path: rel, line: ck.line, text: ck.mod === rel && ck.line <= ls.length ? textLine(ls, ck.line - 1) : '' });
      }
    } else if (t === 'catch') {
      const ty = (map.boxes.get(c.subject).prov.class.split(':').slice(1).join(':') ?? '') || '';
      item.question = `Is the \`${ty}\` raised at ${rel}:${line} caught anywhere? The tool could not follow all callers: ${c.why}.`;
      item.subject = [ty];
      const short = fn ? lastDot(fn.qual) : '';
      if (short) item.lines.push(...src.grep(short, fileList.filter((p) => p !== rel).slice(0, 400), 4));
    } else if (t === 'entry' || t === 'absence') {
      const nm = t === 'entry' ? (fn ? lastDot(fn.qual) : '') : c.attr || (fn ? lastDot(fn.qual) : '');
      item.question = (t === 'entry' ? `The tool saw no caller of \`${nm}\` (${rel}:${line}). Is it called from somewhere the map does not show?`
        : `${c.says} (\`${nm}\`, ${rel}:${line}). Is it used anywhere the map does not show?`) + ` Open ends: ${c.why}.`;
      item.subject = nm ? [nm] : [];
      if (nm) item.lines.push(...src.grep(nm, sorted(fileList).slice(0, 600), 5));
    } else if (t === 'target') {
      const tos = isTargetRoad ? sorted(new Set(cs.map((x) => map.roads.get(x.subject).to))) : [];
      const names = tos.filter((b) => map.boxes.has(b)).map((b) => map.boxes.get(b).fn.slice(map.boxes.get(b).fn.indexOf('::') + 2));
      let call = '';
      if (isTargetRoad) {
        const targets = tos.filter((b) => map.boxes.has(b)).map((b) => map.boxes.get(b).fn);
        let node = -1;
        for (const [ni, cl, cf, cto] of fn.calls) { // the first matching call of the last node that has one
          if (cl === c.line && cf && targets.some((g) => cto.includes(g)) && ni !== node) { call = cf; node = ni; }
        }
      } else call = c.says;
      item.candidates = names;
      const handed = isTargetRoad ? cs.map((x) => map.roads.get(x.subject)).filter((r) => r.prov.how === 'callback') : [];
      if (handed.length && handed.length === cs.length) { // functions handed to a call: the question is whether that call runs them
        const to = sorted(new Set(handed.map((r) => r.prov.callback.passed_to)));
        item.question = `At ${rel}:${line}, ${names.map((n) => `\`${n}\``).join(', ')} is handed to \`${to.join('`, `')}\`. Does that call run it? Name the one it runs.`;
        item.subject = [...names.flatMap((n) => n.split('.')), ...to.flatMap((n) => words(n))];
      } else {
        item.question = `At ${rel}:${line}, \`${call}\` may run any of: ${names.join(', ') || c.says}. Which one runs?`;
        item.subject = [...names.flatMap((n) => n.split('.')), ...words(call)];
      }
    } else if (t === 'hears' || t === 'handler') {
      item.question = `${c.says} (at ${rel}:${line}): does anything tell a person, a log or the caller about it? The tool could not decide: ${c.why}.`;
    } else if (t === 'lock') {
      item.question = `Is \`${c.call || c.says}\` at ${rel}:${line} a lock, semaphore, event or queue that the code waits on? The tool matched the name only.`;
      item.subject = words(c.call || '');
    } else if (t === 'type') {
      item.question = `What is the exception raised at ${rel}:${line} (${c.says})? ${c.why}.`;
    } else if (t === 'excroad') {
      item.question = c.finding === 'handler_nothing_can_reach'
        ? `Can the try body above the handler at ${rel}:${line} raise an error that this handler takes? The tool found nothing that can; implicit errors are not modelled.`
        : `Can the call at ${rel}:${line} raise an error that the handler (${c.why}) takes?`;
    } else if (t === 'places') {
      item.question = `${c.why}: ${c.says}. Do the places mean the same thing?`;
    }
    item.answers = [...(t === 'target' ? [...item.candidates, 'none-of-these'] : ANSWERS[t]), CANT];
    const seen = new Set();
    const uniq = [];
    for (const l of item.lines) {
      const k = `${l.path}\u0000${l.line}`;
      if (!seen.has(k)) { seen.add(k); uniq.push(l); }
    }
    item.lines = uniq.slice(0, MAX_LINES);
    items.push(item);
  }
  return items;
}

/** The order of the work-list: what matters most first.
 *    main-failure   on the computed main path, and about a failure (a raise, a handler, an exception road, an absence)
 *    main           on the main path, anything else
 *    failure        off the main path, about a failure
 *    rest
 *  Within a tier: nearest to an entry first (depth), failures before others, then place. The tier is stored on the item. */
export function order(items) {
  for (const it of items) it.tier = it.main ? (it.failure ? 'main-failure' : 'main') : it.failure ? 'failure' : 'rest';
  const rank = { 'main-failure': 0, main: 1, failure: 2, rest: 3 };
  const keyed = items.map((it) => [[rank[it.tier], it.depth, it.path, it.line || 0, it.item], it]);
  keyed.sort((a, b) => cmp(a[0], b[0]));
  keyed.forEach(([, it], i) => { it.rank = i + 1; });
  return keyed.map((k) => k[1]);
}

/** What the review needs from a map, built from the files map.mjs wrote: model.json (boxes, roads), claims.json and review-index.json. */
export function reviewView(modelDoc, index) {
  const boxes = new Map(modelDoc.boxes.map((b) => [b.id, { ...b, fn: b.prov.fn }]));
  const roads = new Map(modelDoc.routes.map((r) => [r.id, r]));
  return {
    boxes, roads, mods: index.mods,
    fns: new Map(Object.entries(index.fns)),
    classes: new Map(Object.entries(index.classes)),
  };
}

/** The slice of the loaded project the review reads, as plain data for review-index.json. */
export function reviewIndex(P, claims) {
  const want = new Set(claims.filter((c) => c.fn).map((c) => c.fn));
  const fns = {};
  const classes = {};
  for (const fid of P.fids) {
    if (!want.has(fid)) continue;
    const fn = P.fns.get(fid);
    const calls = [];
    for (const nd of fn.nodes) for (const o of nd.ops ?? []) if (o.t === 'call') calls.push([nd.i, o.line, o.f ?? null, o.to ?? []]);
    fns[fid] = { line: fn.line, end: fn.end ?? null, qual: fn.qual, cls: fn.cls ?? null, calls };
    if (fn.cls && P.classes.has(fn.cls)) classes[fn.cls] = { line: P.classes.get(fn.cls).line ?? null, mod: P.classes.get(fn.cls).mod };
  }
  return { schema: 'fl.review-index/1', source_digest: P.srcDigest, mods: sorted(P.mods.keys()), fns, classes };
}

