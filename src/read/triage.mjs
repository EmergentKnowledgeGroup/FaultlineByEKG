// Where to look if stuck. Questions about the code come first, ranked; gaps in the drawing are folded behind a count.
import { cmp, sortBy, tally } from './util.mjs';

/** Plain sentences for the reason codes a claim can carry. A code not listed here falls back to the claim's own `why` text. */
const REASON_WORDS = {
  'absence-with-open-ends': 'there are callers or handlers the tool could not see, so the tool cannot be sure of "never"',
  'negative-open-ends': 'there are callers or handlers the tool could not see, so the tool cannot be sure of "never"',
  'no-type-checker': 'no type checker ran for this language, so nothing is claimed about absence',
  'handler-may-catch': 'a handler may take the error, but the tool could not tell',
  'entry-with-open-ends': 'nothing is shown calling it, but a callback, decorator or framework could',
  'heard-unknown': 'who hears this depends on callers or handlers the tool could not see',
  'several-possible-targets': 'the call may run any of several functions',
  'one-way-out': 'a decision with only one way out drawn',
  'wait-kind-by-name': 'what the wait is on comes from a name, not a definition',
  'lock-matched-by-name-only': 'a lock matched by its name only',
  'effect-candidate': 'the call is named like an effect but no definition says it is one',
};

/** Base rank of each kind of question; higher is looked at first. */
const WEIGHT = {
  'lost-wakeup': 60, 'never-sent': 55, 'swallowed-failure': 50, 'handler-nothing-can-reach': 45, 'flag-never-cleared': 42, 'flag-sticky': 40,
  'written-never-read': 35, 'swallowed-unknown': 28, 'unreferenced': 22, 'empty-handler': 20, 'wait-no-end': 15,
};
const NEG_KIND = {
  swallowed_known_failure: 'swallowed-failure', swallowed_known_failure_unknown: 'swallowed-unknown', handler_nothing_can_reach: 'handler-nothing-can-reach',
  flag_never_cleared: 'flag-never-cleared', written_never_read: 'written-never-read', unreferenced_store: 'unreferenced', unreferenced_delete: 'unreferenced',
};

const why = (c) => REASON_WORDS[c.reason] ?? c.why ?? '';

/**
 * @returns {{questions: object[], gaps: object, counts: object}}
 */
export function buildTriage(W, names) {
  const qs = [];
  const add = (q) => qs.push(q);
  // ---- claims about absence ------------------------------------------------------------------------------------------
  for (const c of W.claimsOfType('negative')) {
    const kind = NEG_KIND[c.finding] ?? 'unreferenced';
    const f = c.fn ? W.fns.get(c.fn) : null;
    add({
      kind, text: capital(c.says), confidence: c.conf, where: c.path ? { path: c.path, line: c.line, fn: c.fn ? names.label(c.fn) : '' } : null,
      because: c.conf === 'confident' ? 'The tool is sure: the type checker ran and nothing is left open.' : `The tool is not sure: ${why(c)}.`, evidence: c.id,
      rank: (WEIGHT[kind] ?? 20) + (c.conf === 'confident' ? 10 : 0) + (c.failure ? 3 : 0) + (f && c.main ? 2 : 0),
    });
  }
  // ---- waits the tool could not relate to a time limit ---------------------------------------------------------------
  for (const c of W.claimsOfType('wait')) {
    const on = /waits on (\w+)/.exec(c.says)?.[1];
    if (on === 'time') continue;
    add({
      kind: 'wait-no-end', text: `${c.fn ? names.label(c.fn) : 'a function'} waits on ${on === 'person' ? 'a person' : 'another program or task'} (line ${c.line}). Is there a time limit or a way to give up?`,
      confidence: c.conf, where: { path: c.path, line: c.line, fn: c.fn ? names.label(c.fn) : '' }, because: 'The tool sees the wait; it does not read a time limit for it.', evidence: c.id,
      rank: WEIGHT['wait-no-end'] + (c.conf === 'confident' ? 5 : 0) + (c.main ? 2 : 0),
    });
  }
  // ---- the scanner's signals, when given -----------------------------------------------------------------------------
  const sg = W.signals;
  if (sg) {
    for (const s of sg.lostWakeup ?? []) {
      add({
        kind: 'lost-wakeup', text: `${s.start?.name ?? 'a function'} puts "${s.field}" back, and the loop in ${s.loop?.name ?? 'a function'} reads it, but only some paths from ${s.start?.name ?? 'it'} reach that loop. If the loop is parked, what wakes it?`,
        confidence: 'not-confident', where: s.start ? { path: s.path, line: s.start.line, fn: s.start.name } : null, because: 'Found by pairing the code that stops something with the code that restarts it.', evidence: s.pair,
        rank: WEIGHT['lost-wakeup'] + 3,
      });
    }
    for (const s of sg.neverSent ?? []) {
      add({
        kind: 'never-sent', text: `${s.name} is handled${s.handled?.[0] ? ` (${s.handled[0].path}:${s.handled[0].line})` : ''} but nothing sends it.${s.handlerEmpty ? ' Its handler body is empty.' : ''}`,
        confidence: 'not-confident', where: s.handled?.[0] ? { path: s.handled[0].path, line: s.handled[0].line, fn: '' } : null, because: 'It appears only as a case label in the code read.', evidence: s.name,
        rank: WEIGHT['never-sent'],
      });
    }
    for (const s of sg.sticky ?? []) {
      add({
        kind: 'flag-sticky', text: `${s.owner ? `${s.owner}: ` : ''}"${s.field}" is set to ${s.value} when it stops (${s.stop?.name ?? ''}) and the code that starts it again does not set it back.`,
        confidence: 'not-confident', where: s.stop ? { path: s.path, line: s.stop.line, fn: s.stop.name } : null, because: 'Found by pairing stop and start code.', evidence: s.pair, rank: WEIGHT['flag-sticky'],
      });
    }
    for (const s of sg.swallowed ?? []) {
      if (!s.empty && !s.broad) continue;
      add({
        kind: 'swallowed-failure', text: `An error is caught and dropped at ${s.path}:${s.line}${s.comment ? ` (comment: "${s.comment}")` : ''}.`,
        confidence: 'not-confident', where: { path: s.path, line: s.line, fn: s.fn ? names.label(s.fn) : '' }, because: s.cleanup || s.teardown ? 'It looks like cleanup, so it may be on purpose.' : 'Nothing in the handler tells anyone.', evidence: `${s.path}:${s.line}`,
        rank: WEIGHT['swallowed-failure'] - 10 - (s.cleanup || s.teardown ? 15 : 0) + (s.broad ? 2 : 0),
      });
    }
  }
  const ranked = sortBy(qs, (q) => -q.rank, (q) => q.where?.path ?? '', (q) => q.where?.line ?? 0, (q) => q.text);
  ranked.forEach((q, i) => {
    q.id = `q${i + 1}`;
  });

  // ---- gaps in the drawing: how the map is drawn, not what the code does ----------------------------------------------
  const gaps = { total: 0, byKind: {}, sample: {} };
  const noteGap = (kind, rec) => {
    gaps.total++;
    gaps.byKind[kind] = (gaps.byKind[kind] ?? 0) + 1;
    (gaps.sample[kind] ??= []);
    if (gaps.sample[kind].length < 5) gaps.sample[kind].push(rec);
  };
  for (const fid of W.mappedIds) {
    const f = W.fns.get(fid);
    for (const b of f.boxes) {
      const outs = W.cfgOut(b.id);
      const rec = { path: f.path, line: b.prov.line, fn: names.label(fid), box: b.id };
      if (b.kind === 'decision' && b.prov.rule !== 'loop' && outs.length === 1) noteGap('decision-with-one-way-out-drawn', rec);
      const hasIn = (W.inn.get(b.id) ?? []).length > 0;
      if (!hasIn && W.entryBox(fid) !== b.id && b.prov.rule !== 'handler') noteGap('box-with-no-way-in-drawn', rec);
    }
    for (const r of W.calleesOf.get(fid) ?? []) if (r.prov.tier === 'may') noteGap('call-with-several-possible-targets', { path: f.path, line: r.prov.line, fn: names.label(fid), box: r.from });
  }
  const sorted = (k) => Object.fromEntries(Object.entries(gaps.byKind).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([x, y]) => [x, y]));
  gaps.byKind = sorted();
  const counts = {
    questions: ranked.length,
    byKind: Object.fromEntries(tally(ranked, (q) => q.kind)),
    confident: ranked.filter((q) => q.confidence === 'confident').length,
    gaps: gaps.total,
    candidates: ranked.length + gaps.total,
  };
  return { questions: ranked, gaps, counts };
}

function capital(s) {
  const t = String(s ?? '');
  return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
}
