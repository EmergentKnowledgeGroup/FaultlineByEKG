// The verdict on one story road: are the two cited places joined in the tool map, and is the cited line where the join is?
// Four answers, and only these: joined by the tool at this line / joined by a route / related in the code / no link found.
// What was checked is that the two cited lines are joined. The `when` is bound to the arm the route takes (arm.mjs); nothing about the words is vouched for.
import { resolveRef, publicRef, IN_BOX, NOT_CODE } from './ref.mjs';
import { callRoute, MAX_CALL_HOPS } from './calls.mjs';
import { bindWhen } from './arm.mjs';
import { WINDOW, DELIVERS, RECORDS, effectIn, isRaise } from './seen.mjs';
import { cmp, plain } from './canon.mjs';

/** A story road may stand on at most this many tool roads. A longer route reads as "somewhere downstream", not as one step the agent saw. */
export const MAX_ROUTE_HOPS = 4;
/** A cited line counts as "on" a tool road when it is within this many lines of the line the road came from: a wrapped statement, a comment above a call. */
export const CITE_SLACK = 3;
/** Flags on a box that make the road standing on it no better than "related": the citation disagrees with itself. */
const CAPPING = new Set(['symbol-differs', 'cites-outside-root']);

const SAYS_RETURN = /\b(?:return|returns|returned)\b/i;
const SAYS_RAISE = /\b(?:raise|raises|raised|throw|throws|threw|fail|fails|failed|error)\b/i;

export const JOIN_WORDS = {
  line: 'joined by the tool at this line',
  route: 'joined by a route',
  related: 'related in the code',
  none: 'no link found',
};

function bfs(L, srcs, dsts, sureOnly, kmax) {
  srcs = new Set(srcs); dsts = new Set(dsts);
  for (const s of srcs) if (dsts.has(s)) return [];
  const prev = new Map([...srcs].sort(cmp).map((s) => [s, null]));
  let frontier = [...prev.keys()];
  for (let d = 0; d < kmax && frontier.length; d++) {
    const next = [];
    for (const u of frontier) {
      for (const e of L.out.get(u) ?? []) {
        if ((sureOnly && !e.sure) || prev.has(e.to)) continue;
        prev.set(e.to, e);
        if (dsts.has(e.to)) {
          const route = [];
          for (let x = e.to; prev.get(x); x = prev.get(x).from) route.push(prev.get(x));
          return route.reverse();
        }
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return null;
}

function roadLines(L, id) {
  const pv = L.roads.get(id).prov ?? {};
  const ls = new Set([...(pv.lines ?? []), pv.line, pv.handler_line].filter(Number.isInteger));
  return [(pv.fn ?? '').split('::')[0], ls];
}

/** Is a cited line where the tool's route is? on | loose | off | empty */
function citeOn(ctx, refs, route, ends, fnEnds) {
  const valid = refs.filter((r) => !NOT_CODE.has(r.status));
  if (refs.length && !valid.length) return 'empty';
  if (!valid.length) return 'off';
  const { L } = ctx;
  const rboxes = new Set(route.flatMap((e) => [e.from, e.to]));
  for (const r of valid) {
    if ((r.boxes ?? []).some((b) => rboxes.has(b))) return 'on';
    for (const e of route) { const [p, ls] = roadLines(L, e.id); if (p === r.path && [...ls].some((x) => Math.abs(r.line - x) <= CITE_SLACK)) return 'on'; }
  }
  const efns = new Set([...ends].map((id) => L.boxes.get(id).prov.fn).concat([...fnEnds]));
  for (const r of valid) {                                  // a cited call that goes into a function of either end is the join itself
    for (const fid of r.chain ?? []) for (const t of L.callTargets(fid, r.line, 1)) if (efns.has(t)) return 'on';
  }
  return valid.some((r) => (r.boxes ?? []).some((b) => ends.has(b)) || efns.has(r.fn)) ? 'loose' : 'off';
}

function fnCite(ctx, refs, croute, ends) {
  const valid = refs.filter((r) => !NOT_CODE.has(r.status));
  if (refs.length && !valid.length) return 'empty';
  for (const r of valid) for (const s of croute) if (s.from.split('::')[0] === r.path && Math.abs(r.line - s.line) <= CITE_SLACK) return 'on';
  return valid.some((r) => ends.has(r.fn)) ? 'loose' : 'off';
}

const tierName = (e) => (e.tier === 'proven' ? 'sure' : e.tier);
const view = (ctx, route) => route.map((e) => {
  const r = ctx.L.roads.get(e.id), a = ctx.L.boxes.get(e.from), b = ctx.L.boxes.get(e.to);
  return { road: e.id, from: e.from, to: e.to, tier: tierName(e), confident: e.sure, rule: r.prov?.rule ?? '', when: plain(r.when ?? '', 60), fromPhrase: plain(a.detail || a.title || '', 70), toPhrase: plain(b.detail || b.title || '', 70) };
});

/** Evidence the tool holds that a road typed `deliver` / `record` is what it says. */
function typeSeen(ctx, type, refs, route) {
  const live = refs.filter((r) => IN_BOX.has(r.status) || r.status === 'code');
  const want = type === 'deliver' ? DELIVERS : RECORDS;
  for (const r of live) {
    const a = ctx.S.at(r.chain ?? [], r.line, ...WINDOW.effect);
    if (a.eff.some((e) => effectIn(e[1], want))) return true;
    if (type === 'deliver' && a.deliver.length) return true;
  }
  return route.some((e) => ctx.L.roads.get(e.id).type === type);
}

export function checkRoad(ctx, r, boxes, kmax = MAX_ROUTE_HOPS) {
  const { L } = ctx;
  const refs = (Array.isArray(r.refs) ? r.refs : []).map((x) => resolveRef(ctx, x));
  const A = boxes.get(r.from), B = boxes.get(r.to);
  const flags = [];
  let join = 'none', why = 'no tool road joins them', route = [], via = '', scope = 'boxes', croute = null, weak = false;
  const out = { id: r.id, from: r.from, to: r.to, type: r.type ?? 'forward' };
  let ownBoxes = new Set();
  if (!A || !B) {
    flags.push('end-missing');
    why = 'a road end is not a box of the story';
  } else {
    const own = new Set(refs.filter((x) => IN_BOX.has(x.status)).flatMap((x) => x.boxes));
    ownBoxes = own;
    const pick = (cov) => { const s = new Set(cov.keys()); const o = new Set([...s].filter((x) => own.has(x))); return o.size ? o : s; };
    const ownF = new Set(refs.filter((x) => x.fn && (IN_BOX.has(x.status) || x.status === 'code')).map((x) => x.fn));
    const side = (m) => { const all = new Set(m.fnLines.keys()); const o = new Set([...all].filter((x) => ownF.has(x))); return o.size ? o : all; };
    const FA0 = side(A), FB0 = side(B);
    const FA = L.withClosures(FA0), FB = L.withClosures(FB0);
    // The join is looked for first on each box's first citation. A second citation can only make a road "related": it is a place a box may cite to borrow a road.
    const attempt = (CA, CB) => {
      const o = { found: null, route: [], join: 'none', via: '', why: '', weak: false };
      if (!CA.size || !CB.size) return o;
      const dst = new Set([...CB].filter((x) => !CA.has(x)));          // a box both ends stand on is not a road between them
      let found = dst.size ? bfs(L, CA, dst, true, kmax) : [];
      if (found && !found.length) { o.via = 'same-tool-box'; return o; }
      if (found) { o.found = found; o.route = found; o.join = found.length === 1 ? 'line' : 'route'; o.why = found.length === 1 ? 'a tool road joins them' : `a route of ${found.length} tool roads joins them`; return o; }
      if (r.type === 'return') {
        const rv = bfs(L, CB, CA, true, kmax);
        if (rv && rv.some((e) => L.roads.get(e.id).prov?.rule === 'call')) { o.found = rv; o.route = rv; o.join = 'route'; o.via = 'call-return'; o.why = `a return: the to-box leads to the from-box over ${rv.length} tool road(s), one of them a call`; return o; }
      }
      const rw = bfs(L, CA, CB, false, kmax);
      if (rw && rw.length) { o.route = rw; o.join = 'related'; o.weak = true; o.why = 'joined only over roads the tool is not sure of (' + [...new Set(rw.filter((e) => !e.sure).map(tierName))].sort().join(', ') + ')'; flags.push('stands-on-weak-road'); }
      return o;
    };
    const first = (m) => { const s = new Set(m.covFirst.keys()); const o = new Set([...s].filter((x) => own.has(x))); return o.size ? o : s; };
    let got = attempt(first(A), first(B));
    if (!got.found && !got.weak) {
      const wide = attempt(pick(A.cov), pick(B.cov));
      if (wide.found) { got = { ...wide, join: 'related', why: wide.why + '; but only through a second citation of a box', found: null }; flags.push('second-citation'); }
      else if (wide.weak && !got.weak) got = wide;
      else if (!got.via) got.via = wide.via;
    }
    ({ route, join, via, why, weak } = { route: got.route, join: got.join === 'none' ? 'none' : got.join, via: got.via, why: got.join === 'none' ? why : got.why, weak: got.weak });
    const CA = pick(A.cov), CB = pick(B.cov);
    if (join === 'none' && FA.size && FB.size) {
      if ([...FA].some((x) => FB.has(x))) {
        const la = [...A.fnLines].filter(([k]) => FB.has(k)).flatMap(([, v]) => v), lb = [...B.fnLines].filter(([k]) => FA.has(k)).flatMap(([, v]) => v);
        const a0 = la.length ? la : [...A.fnLines.values()].flat(), b0 = lb.length ? lb : [...B.fnLines.values()].flat();
        if (Math.min(...a0) <= Math.max(...b0)) { join = 'related'; scope = 'functions'; via = via || 'same-function'; why = 'both boxes are in one function, the from-box first in line order; the tool draws no road between the boxes'; }
        else why = 'both boxes are in one function, the to-box above the from-box (a loop could do that; the tool draws no such road)';
      } else {
        const cr = callRoute(L, FA, FB, MAX_CALL_HOPS);
        if (cr && cr.length) { croute = cr; join = 'related'; scope = 'functions'; via = 'function-calls'; why = `the tool draws no road between the boxes, but the code of the from-box reaches the code of the to-box over ${cr.length} call(s)`; }
      }
    }
    if ((join === 'line' || join === 'route') && via !== 'call-return') {   // a route that leaves a decision by an arm the cited line does not pin down
      const f0 = L.roads.get(route[0].id);
      if (f0.prov?.rule === 'cfg-edge' && L.boxes.get(f0.from).kind === 'decision' && A.cov.get(f0.from) === 'near') {
        join = 'related'; why += '; the cited line is only near the decision, so which arm the road means is not pinned down'; flags.push('arm-unpinned');
      }
    }
    const ends = new Set([...CA, ...CB]);
    const cite = scope === 'functions' && croute ? fnCite(ctx, refs, croute, new Set([...FA, ...FB])) : citeOn(ctx, refs, route, ends, new Set([...FA, ...FB]));
    out.cite = cite;
    if ((join === 'line' || join === 'route') && (cite === 'off' || cite === 'loose')) {
      join = 'related'; why += "; the cited line is not where the tool's route is"; flags.push(cite === 'off' ? 'cite-off' : 'cite-loose');
    } else if (cite === 'empty') {
      flags.push('cites-nothing');
      if (join !== 'none') { join = 'none'; why = 'every cited line holds nothing'; } else why += '; every cited line holds nothing';
    } else if (cite === 'off' || cite === 'loose') flags.push(cite === 'off' ? 'cite-off' : 'cite-loose');
    for (const m of [A, B]) {
      const bad = m.out.flags.filter((f) => CAPPING.has(f));
      if (bad.length && (join === 'line' || join === 'route')) { join = 'related'; why += `; a box it stands on is flagged (${bad.join(', ')})`; flags.push('end-box-flagged'); break; }
    }
    // a road that stands on a not-confident tool road inherits that, however the join was found
    if (route.some((e) => !e.sure) && (join === 'line' || join === 'route')) { join = 'related'; flags.push('stands-on-weak-road'); }
  }
  if (!('cite' in out)) out.cite = 'off';
  if (refs.some((x) => x.status === 'refused')) flags.push('cites-outside-root');
  if (refs.some((x) => x.symrel === 'unknown')) flags.push('symbol-unknown');
  if (refs.some((x) => x.symrel === 'differs')) {
    flags.push('symbol-differs');
    if (join === 'line' || join === 'route') { join = 'related'; why += '; the function named in a citation is not the function that holds the cited line'; }
  }
  const cond = bindWhen(ctx, r.when, route, refs, ownBoxes);
  flags.push(...cond.flags);
  const t = r.type ?? 'forward';
  // the road starts at a raise only when every cited line of its from-box is in a tool box and every one of those boxes is a raise
  const atStart = A && A.out.found === 'boxed' ? [...A.cov.keys()].map((id) => L.boxes.get(id)) : [];
  const startsAtRaise = atStart.length > 0 && atStart.every((b) => b.kind === 'end' && isRaise(b.prov?.class));
  if (startsAtRaise && SAYS_RETURN.test(cond.text) && !SAYS_RAISE.test(cond.text)) flags.push('says-return-tool-shows-raise');
  if ((t === 'deliver' || t === 'record') && (join !== 'none') && !typeSeen(ctx, t, refs, route)) flags.push(`${t}-not-seen`);
  const toolPhrase = cond.tool?.phrase ?? '';
  Object.assign(out, {
    join, joinWords: JOIN_WORDS[join], why, flags, scope, via, hops: route.length || (croute ? croute.length : null),
    when: { text: cond.text, bound: cond.bound, compared: cond.label, tool: cond.tool, checked: false },
    words: { checked: false, when: cond.text },
    route: croute ? croute.map((s) => ({ fn: s.from, line: s.line, calls: s.to })) : view(ctx, route),
    refs: refs.map(publicRef), toolPhrase,
  });
  if (weak || route.some((e) => !e.sure)) out.inherits = 'a road the tool is not sure of';
  return out;
}
