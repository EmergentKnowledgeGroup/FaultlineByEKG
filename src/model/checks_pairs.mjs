// Checks that read signals.json (code-level facts from src/extract/signals.mjs): restart-misses, sticky-flag, never-sent, empty-handler,
// swallowed-error. Each returns finding drafts {key, check, boxes, routes, question, evidence}; a draft may also carry `also` (checks that
// agree with it) and `weight` (a tie-break inside one check, kept out of the finding itself). A signal that no box cites is still reported,
// with its file:line, as a candidate on no box. Settings are fixed here, not tuned per system.
import { nearestBox } from './refs.mjs';
import { clip, plural } from './text.mjs';
import { wordsOf } from '../extract/signals_words.mjs';

export const SETTINGS = { reachHops: 4, linkHops: 8, funnelIn: 12, wakeHops: 2, swallowedCap: 20 };
const STOPPY = /\b(?:stop|stops|stopped|stopping|clos(?:e|es|ed|ing)|cancel\w*|abort\w*|shut(?:s|ting)?\s?down|shutdown|terminat\w*|kill\w*|disconnect\w*|pause[sd]?|pausing)\b/i;
const PROBE = /^(?:is|has|can|try|supports?|check|probe|detect|exists?|available|safe|ensure|best effort)|(?:installed|available|exists|supported)$/;
// a comment that only silences a linter says nothing about why; one with prose does
const explained = (c) => plain(c).replace(/noqa\S*|pylint:\S*|eslint-disable\S*|type:\s*ignore\S*|pragma:\S*|istanbul ignore\S*|ts-ignore|[-:,.]/gi, ' ').split(/\s+/).filter((w) => w.length > 1).length >= 3;
const live = (b) => !b || b.status === 'live' || b.status === 'default-on' || b.status === undefined;
const plain = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const shortName = (fn) => String(fn).split('::').pop().split('.').pop();
const here = (s) => `${s.path}:${s.line}`;
const boxName = (g, id) => id;                                                  // the id only: the page shows the box's name, and a quoted copy of the name would say it twice
const noBox = (where) => `No box on the map covers this (${where}). `;

// the box that stands for a signal's place in the code, or null
export function boxAt(cx, fn, line) {
  const c = nearestBox(cx.cites, fn, line || 0);
  return c && cx.g.byId.has(c.box) ? c.box : null;
}
const boxesCiting = (cx, fn) => [...new Set((cx.cites.get(fn) || []).map((c) => c.box))].filter((id) => cx.g.byId.has(id)).sort((a, b) => cx.g.order.get(a) - cx.g.order.get(b));
const dropMissing = (...ids) => [...new Set(ids.filter(Boolean))];

// Boxes within `max` forward hops of `start` (not counting start): Map id -> hops. A funnel (many roads in) is reached but not left.
export function reachHops(cx, start, max = SETTINGS.reachHops, block = null) {
  const { g } = cx, dist = new Map([[start, 0]]), q = [start];
  for (let h = 0; h < q.length; h++) {
    const u = q[h], d = dist.get(u);
    if (d >= max || (d > 0 && g.inX(u).length > SETTINGS.funnelIn)) continue;
    for (const r of g.out.get(u) || []) if (r.type !== 'record' && !dist.has(r.to) && !(block && block.has(r.to))) { dist.set(r.to, d + 1); q.push(r.to); }
  }
  dist.delete(start);
  return dist;
}

// ---- restart-misses ------------------------------------------------------------------------------------------------------------
// The stop side of a stop/start pair has a road into a wait or a loop, and the start side cannot get back to it.
function loopEntries(cx) {
  const out = [];
  for (const L of cx.model.loops || []) {
    const ids = (L.boxes || []).filter((id) => cx.g.byId.has(id)), set = new Set(ids);
    if (ids.length < 1) continue;
    const entry = ids.find((id) => cx.g.inX(id).some((r) => !set.has(r.from))) || ids[0];
    out.push({ id: L.id, title: L.title || L.id, set, entry });
  }
  return out;
}

export function restartMisses(cx) {
  const out = [], sig = cx.signals;
  if (!sig?.pairs?.length) return out;
  const loops = loopEntries(cx);
  for (const p of sig.pairs) {
    const drawn = (id) => !['end', 'external'].includes(cx.g.byId.get(id).kind) && cx.g.outX(id).length > 0;   // no road out says nothing about what start does; an external box is the outside caller, whose roads are unrelated calls
    const S = boxesCiting(cx, p.stop.fn).filter(drawn), T = boxesCiting(cx, p.start.fn).filter(drawn);
    if (!S.length || !T.length) continue;
    const misses = new Map();                                                     // target id -> {hops, via, kind}
    for (const s of S) {
      const rs0 = reachHops(cx, s), far = reachHops(cx, s, SETTINGS.linkHops);
      for (const t of T) {
        if (t === s) continue;
        const rt = reachHops(cx, t);
        // The exemption: one box leads to the other with no wait between them (a switch drawn as a chain), not two separate flows. A pause normally leads to a
        // paused wait and then to its resume: with a wait between, compare what the stop side reaches BEFORE that wait with what the start side reaches after it.
        const waits = far.has(t) ? [...far.keys()].filter((w) => w !== t && w !== s && cx.g.byId.get(w).kind === 'wait' && reachHops(cx, w, SETTINGS.linkHops).has(t)) : [];
        if (far.has(t) ? !waits.length : rt.has(s)) continue;                       // a chain with no wait between, or the start side leading on to the stop side
        const rs = waits.length ? reachHops(cx, s, SETTINGS.reachHops, new Set(waits)) : rs0;
        const note = (id, kind, label) => { if (!rs.has(id) || rt.has(id) || id === t || id === s) return; if (!misses.has(id) || rs.get(id) < misses.get(id).hops) misses.set(id, { hops: rs.get(id), kind, label, from: s, start: t, between: waits[0] || '' }); };
        for (const [id] of rs) if (cx.g.byId.get(id).kind === 'wait') note(id, 'wait', boxName(cx.g, id));
        for (const L of loops) {
          if (L.set.has(t) || L.set.has(s)) continue;
          const hit = [...L.set].some((id) => rs.has(id));
          if (hit && !rt.has(L.entry) && L.entry !== t) note(L.entry, 'loop', `${L.entry}, the entry of a loop`);
        }
      }
    }
    // a miss is only worth asking about when the stop side is close to it; farther ones are listed as context
    const near = [...misses.entries()].filter(([, m]) => m.hops <= SETTINGS.wakeHops).sort((a, b) => a[1].hops - b[1].hops || cx.g.order.get(a[0]) - cx.g.order.get(b[0]));
    if (!near.length) continue;
    const [id0, m0] = near[0], sn = shortName(p.stop.fn), tn = shortName(p.start.fn);
    out.push({
      key: `restart-misses:${p.stop.fn}>${p.start.fn}`, check: 'restart-misses', boxes: dropMissing(m0.from, m0.start, ...near.slice(0, 3).map(([id]) => id)), routes: [],
      question: `\`${sn}\` reaches ${m0.label}; \`${tn}\` doesn't reach it. What wakes ${m0.kind === 'loop' ? 'that loop' : 'it'} after a ${tn}?`,
      evidence: `The ${p.family} pair is in ${p.owner || p.path}. ${m0.between ? `A wait (${m0.between}) lies between \`${sn}\` and \`${tn}\`, so this compares what \`${sn}\` reaches before it with what \`${tn}\` reaches after it. ` : ''}From \`${sn}\` the flow reaches ${near.slice(0, 3).map(([id, m]) => `${id} (${plural(m.hops, 'hop')}${m.kind === 'loop' ? ', a loop entry' : ', a wait'})`).join(', ')} within ${SETTINGS.reachHops} hops. From \`${tn}\` (${m0.start}) it reaches ${near.length === 1 ? 'nothing there' : 'none of them'} within ${SETTINGS.reachHops} hops.`,
    });
  }
  return out;
}

// ---- sticky-flag ---------------------------------------------------------------------------------------------------------------
export function stickyFlag(cx) {
  const out = [];
  for (const s of cx.signals?.sticky || []) {
    const sb = boxAt(cx, s.stop.setIn || s.stop.fn, s.stop.setAt || s.stop.line), tb = boxAt(cx, s.start.fn, s.start.line);
    const boxes = dropMissing(sb, tb), sn = shortName(s.stop.fn), tn = shortName(s.start.fn);
    const rd = s.reads.slice(0, 3).map((r) => `\`${r.name}\` (line ${r.line})`).join(', ');
    out.push({
      key: `sticky-flag:${s.stop.fn}:${s.field}`, check: 'sticky-flag', boxes, routes: [], at: boxes.length ? '' : `${s.path}:${s.stop.setAt || s.stop.line}`,
      question: `\`${sn}\` sets \`${s.field}\` to ${s.value}, \`${tn}\` never clears it. Does anything read it after a ${tn}?`,
      evidence: `${boxes.length ? '' : noBox(`${s.path}:${s.stop.setAt || s.stop.line}`)}The method \`${sn}\` sets \`${s.field}\` = ${s.value}. The method \`${tn}\` and what it calls never assign \`${s.field}\`. It is read in a condition by ${rd}${s.readCount > 3 ? ` and ${s.readCount - 3} more` : ''}.${s.otherWrites.length ? ` Elsewhere it is set to ${s.otherWrites.map((o) => `${o.value ?? '(computed)'} in \`${o.name}\``).join(', ')}.` : ''}`,
    });
  }
  return out;
}

// ---- never-sent ----------------------------------------------------------------------------------------------------------------
export function neverSent(cx) {
  const out = [];
  for (const n of cx.signals?.neverSent || []) {
    const h = n.handled.find((x) => boxAt(cx, x.fn, x.line)) || n.handled[0];
    const box = h ? boxAt(cx, h.fn, h.line) : null;
    const where = h ? `${h.path}:${h.line}` : `${n.path}:${n.line}`;
    const kinds = [...new Set(n.handled.map((x) => (x.ctx === 'case' ? 'a case label' : x.ctx === 'key' ? 'a handler table key' : 'a comparison')))];
    out.push({
      key: `never-sent:${n.name}`, check: 'never-sent', boxes: dropMissing(box), routes: [], at: box ? '' : where, also: n.handlerEmpty ? ['empty-handler'] : [],
      question: `\`${n.name}\` is handled but nothing sends it. Was the sender lost, or is the handler a leftover?`,
      evidence: `${box ? '' : noBox(where)}The name \`${n.name}\` appears only as ${kinds.join(' and ')} (${plural(n.handlerCount, 'place')}, first ${where}) and is never assigned, passed or sent in the code read.${n.handlerEmpty ? ' Its handler body is empty.' : ''}`,
    });
  }
  return out;
}

// ---- empty-handler -------------------------------------------------------------------------------------------------------------
const roadNamed = (cx, id) => {
  const b = cx.g.byId.get(id), roads = [...cx.g.inX(id), ...cx.g.outX(id)];
  return STOPPY.test(`${b?.title || ''} ${b?.handle || ''} ${id}`) || roads.some((r) => STOPPY.test(`${r.when || ''} ${r.id}`));
};
export function emptyHandler(cx) {
  const out = [], covered = new Set();                                           // an empty case that never-sent already reports is one idea, not two
  for (const n of cx.signals?.neverSent || []) if (n.handlerEmpty) for (const h of n.handled) covered.add(`${h.path}:${h.line}`);
  for (const e of cx.signals?.emptyHandlers || []) {
    if (e.kind === 'case' && covered.has(`${e.path}:${e.line}`)) continue;
    const box = boxAt(cx, e.fn, e.line);
    if (box ? !roadNamed(cx, box) : e.kind !== 'lifecycle') continue;               // on the map it must sit on a stop/close/cancel road; off the map only a lifecycle method itself qualifies
    if (e.commented && e.kind !== 'lifecycle') continue;                           // a comment saying why it does nothing is an answer already
    const what = e.kind === 'case' ? `case ${e.label}` : e.name;
    out.push({
      key: `empty-handler:${e.path}:${e.fn.split('::')[1] || ''}:${e.kind}:${e.name}`, check: 'empty-handler', boxes: dropMissing(box), routes: [], at: box ? '' : `${e.path}:${e.line}`,
      question: `\`${e.kind === 'case' ? what : `${e.name}()`}\` does nothing here. What does a caller expect?`,
      evidence: `${box ? '' : noBox(`${e.path}:${e.line}`)}${e.kind === 'lifecycle' ? `The method \`${e.name}\` is empty, on a class that extends or implements another${e.owner ? ` (${e.owner})` : ''}` : e.kind === 'case' ? `The case \`${e.label}\` has an empty body` : `The handler \`${e.name}\` has an empty body`}${e.commented ? ' (it has a comment)' : ''}.`,
    });
  }
  return out;
}

// ---- swallowed-error -----------------------------------------------------------------------------------------------------------
export function swallowedError(cx) {
  const rows = [];
  for (const s of cx.signals?.swallowed || []) {
    if (!s.broad || s.cleanup || s.only === 'break') continue;                     // a narrow, expected exception, a best-effort clean-up call and a loop that ends on the error are choices
    const box = boxAt(cx, s.fn, s.line), b = box ? cx.g.byId.get(box) : null;
    if (box && (!live(b) || b.kind === 'end')) continue;                           // a box that is an ending is where the map already says what the failure leads to
    // an error someone explained in a comment, or a probe that answers yes/no by failing, is less likely to be a slip: those go last
    const tier = (explained(s.comment) ? 1 : 0) + (PROBE.test(wordsOf(shortName(s.fn)).join(' ')) ? 1 : 0);
    rows.push({ s, box, tier, central: box ? cx.g.inX(box).length : -1 });
  }
  rows.sort((a, c) => a.tier - c.tier || c.central - a.central || (a.s.path + a.s.line < c.s.path + c.s.line ? -1 : 1));
  return rows.slice(0, SETTINGS.swallowedCap).map(({ s, box, central, tier }) => {
    const how = s.empty ? (s.comment ? `an empty block with only a comment ("${clip(s.comment, 140)}")` : 'an empty block') : `a block that neither rethrows, logs nor passes the error on${s.comment ? ` (comment: "${clip(s.comment, 140)}")` : ''}`;
    const kind = s.kind === 'promise-catch' ? '.catch(...)' : s.kind === 'except' ? 'except' : 'catch';
    return {
      key: `swallowed-error:${s.path}:${s.fn.split('::')[1] || ''}:${s.line}`, check: 'swallowed-error', lead: true, boxes: dropMissing(box), routes: [], weight: (2 - tier) * 100 + Math.max(0, Math.min(central, 99)), at: box ? '' : `${s.path}:${s.line}`,
      question: 'This failure disappears here. Who finds out?',
      evidence: `${box ? '' : noBox(here(s))}${kind === 'except' ? 'An' : 'A'} \`${kind}\` at ${here(s)} is ${how}.${box ? ` This box has ${plural(central, 'road')} in.` : ''}`,
    };
  });
}
