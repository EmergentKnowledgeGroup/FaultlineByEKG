// The verdict on one story box. The check is about the cited lines and the kind. The title and the sentence are never judged: they are carried through
// marked "words not checked", with the tool's own phrase at those lines beside them.
import { resolveRef, publicRef, IN_BOX, NOT_CODE } from './ref.mjs';
import { WINDOW, KIND_EFFECTS, effectIn, isRaise } from './seen.mjs';
import { belongTogether } from './calls.mjs';
import { readsAsGood, readsAsBad } from './words.mjs';
import { plain, cmp } from './canon.mjs';

export const FOUND_WORDS = {
  boxed: 'in a tool box',
  code: 'real code, no tool box',
  partial: 'partly found',
  none: 'not found',
};
const SHOWN_COVERS = 8;
const PHRASE = 90;

const phraseOf = (b) => plain(b.detail || b.title || '', PHRASE);

/** Is the story's kind of box something the tool sees at the cited lines? Returns [result, note]. result: ok | maybe | mismatch | not-checked */
function kindCheck(ctx, kind, refs, covKinds) {
  const { S } = ctx;
  const live = refs.filter((r) => IN_BOX.has(r.status) || r.status === 'code');
  const seenAt = (win) => live.map((r) => S.at(r.chain ?? [], r.line, win[0], win[1]));
  if (kind === 'decision') {
    if (covKinds.has('decision') || seenAt(WINDOW.decision).some((s) => s.dec.length)) return ['ok', ''];
    return ['mismatch', 'the tool sees no decision at the cited lines'];
  }
  if (kind === 'end') {
    if (covKinds.has('end') || seenAt(WINDOW.exit).some((s) => s.ex.length)) return ['ok', ''];
    return ['mismatch', 'the tool sees no return or raise at the cited lines'];
  }
  if (KIND_EFFECTS[kind]) {
    if (covKinds.has(kind)) return ['ok', ''];
    let weak = false;
    for (const s of seenAt(WINDOW.effect)) {
      for (const e of s.eff) {
        if (!effectIn(e[1], KIND_EFFECTS[kind])) continue;
        if (e[2] === 'confident') return ['ok', ''];
        weak = true;
      }
    }
    return weak ? ['maybe', `the tool sees a possible ${kind} here, and is not sure`] : ['mismatch', `the tool sees no ${kind} at the cited lines`];
  }
  return ['not-checked', ''];
}

/** The exits the tool sees ON the cited lines themselves (not near them): one class per exit. A box that says success is only contradicted by a raise on a line it cites. */
function exitsOnCitedLines(ctx, refs) {
  const out = [];
  for (const r of refs.filter((x) => IN_BOX.has(x.status) || x.status === 'code')) for (const e of ctx.S.at(r.chain ?? [], r.line, 0, 0).ex) out.push(e[2]);
  return out;
}

/** The tool's own words at the first cited line that has any: the call it draws there, else the box that stands on the line, else the box it is near. */
function phraseAtRefs(ctx, refs) {
  const { L } = ctx;
  for (const r of refs) {
    if (!IN_BOX.has(r.status)) continue;
    if (r.calls?.length) return plain(L.roads.get(r.calls[0]).when || 'a call', PHRASE);
    const own = (r.boxes ?? []).map((id) => L.boxes.get(id)).find((b) => b.prov?.line === r.line);
    return phraseOf(own ?? L.boxes.get(r.boxes[0]));
  }
  return '';
}

export function checkBox(ctx, b, skipNames) {
  const { L } = ctx;
  const refs = (Array.isArray(b.refs) ? b.refs : []).map((r) => resolveRef(ctx, r));
  const n = refs.length;
  const inBox = refs.filter((r) => IN_BOX.has(r.status));
  const code = refs.filter((r) => r.status === 'code');
  const bad = refs.filter((r) => NOT_CODE.has(r.status));
  const good = inBox.length + code.length;
  const flags = [];
  const cov = new Map();
  for (const r of inBox) for (const id of r.boxes) if (!cov.has(id)) cov.set(id, r.status);
  const covKinds = new Set([...cov.keys()].map((id) => L.boxes.get(id).kind));
  let v, why;
  if (n === 0) { v = 'none'; why = 'no citation'; flags.push('no-citation'); }
  else if (inBox.length === n) { v = 'boxed'; why = `${cov.size} tool box${cov.size === 1 ? '' : 'es'} at the cited lines`; }
  else if (good === n) { v = 'code'; why = `${code.length} of ${n} cited lines are real code in a function the tool read, with no tool box at the line` + (inBox.length ? `; ${inBox.length} are in a tool box` : ''); }
  else if (good) { v = 'partial'; why = `${good} of ${n} cited lines are code the tool read; ${n - good} are not`; }
  else { v = 'none'; why = bad.length === n ? 'every cited line holds nothing, is not in the file, or was refused' : 'the cited lines are not code the tool read'; }
  if (refs.some((r) => r.status === 'refused')) flags.push('cites-outside-root');
  if (bad.some((r) => r.status !== 'refused')) flags.push('cites-nothing');

  const [kc] = n ? kindCheck(ctx, b.kind, refs, covKinds) : ['not-checked', ''];
  if (kc === 'mismatch') flags.push(`no-${b.kind}-at-cite`);
  else if (kc === 'maybe') flags.push(`${b.kind}-unsure`);

  if (refs.some((r) => r.symrel === 'differs')) flags.push('symbol-differs');
  else if (refs.some((r) => r.symrel === 'unknown')) flags.push('symbol-unknown');

  const live = refs.filter((r) => IN_BOX.has(r.status) || r.status === 'code');
  const groups = [];
  for (const r of live) { const k = (r.chain ?? []).join('|'); if (k && !groups.some((g) => g.k === k)) groups.push({ k, fns: r.chain }); }
  let apart = false;
  for (let i = 0; i < groups.length && !apart; i++) for (let j = i + 1; j < groups.length && !apart; j++) {
    const same = groups[i].fns[0].split('::')[0] === groups[j].fns[0].split('::')[0];
    if (!same && !belongTogether(L, groups[i].fns, groups[j].fns)) apart = true;
  }
  if (apart) flags.push('refs-apart');

  if (b.kind === 'end') {
    const cls = exitsOnCitedLines(ctx, refs);
    const raises = cls.length > 0 && cls.every(isRaise);
    const text = `${b.title ?? ''} ${b.plain ?? ''}`;
    const says = b.outcome ? b.outcome === 'success' : readsAsGood(text) && !readsAsBad(text);       // an outcome the agent set outranks a guess from the words
    if (raises && says) {
      flags.push('raise-titled-success');
    }
  }

  const mt = ctx.names.mentions([b.title, b.plain, b.why, b.handle].filter((x) => typeof x === 'string').join(' '), refs, skipNames);
  if (mt && mt.nowhere.length) {
    flags.push('name-not-in-code');
  } else if (mt && mt.n >= 2 && mt.fn + mt.file === 0) flags.push('names-elsewhere');

  const covers = [...cov].sort((a, c) => cmp(a[0], c[0])).slice(0, SHOWN_COVERS).map(([id, how]) => {
    const tb = L.boxes.get(id);
    return { box: id, how, kind: tb.kind, phrase: phraseOf(tb) };
  });
  const toolPhrase = phraseAtRefs(ctx, refs) || (covers.length ? covers[0].phrase : (refs.find((r) => r.text) ?? {}).text ?? '');
  const o = {
    id: b.id, kind: b.kind ?? '', found: v, foundWords: FOUND_WORDS[v], why, kindCheck: kc, flags: [...new Set(flags)].sort(cmp),
    toolPhrase, covers, nCovers: cov.size,
    words: { checked: false, title: plain(b.title ?? '', 80), plain: plain(b.plain ?? '', 260) },
    refs: refs.map(publicRef),
  };
  if (mt) o.names = mt;
  const fl = new Map();
  for (const r of live) if (r.fn) { if (!fl.has(r.fn)) fl.set(r.fn, []); fl.get(r.fn).push(r.line); }
  const covFirst = new Map();
  if (IN_BOX.has(refs[0]?.status)) for (const id of refs[0].boxes) covFirst.set(id, refs[0].status);
  return { out: o, cov, covFirst, fnLines: fl, refs };
}
