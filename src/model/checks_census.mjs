// Checks that need the census (what the code says is there) or the overlay (what runs and tests saw):
// no-limit-loop, ending-no-test, declared-never-produced.
import { sccs } from './graph.mjs';
import { components } from './checks_flow.mjs';
import { hasCapWord, limitIsEmpty, clip, upFirst, stop } from './text.mjs';
import { refSymbol, normPath, symbolPath } from './refs.mjs';

const nonLow = (rows) => (rows || []).filter((e) => e.confidence !== 'low');
const alnum = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const lastPart = (s) => String(s ?? '').split(/[.:]/).filter(Boolean).pop() || '';
const where = (fn, line) => `${String(fn).split('::')[0]}:${line}`;

function boxFns(cx, ids) {
  const s = new Set();
  for (const id of ids) for (const r of cx.g.byId.get(id)?.refs || []) { const f = refSymbol(r); if (f) s.add(f); }
  return s;
}
function loopEvidence(cx, fnSet) {
  const rows = (cx.census?.passes || []).filter((p) => fnSet.has(p.fn) && p.bounded === false && ['loop', 'retry', 'recursion'].includes(p.kind));
  return rows.map((p) => {
    const lp = (cx.fx.functions[p.fn]?.loops || []).find((l) => l.line === p.line);
    return `code shows a ${p.kind} at ${where(p.fn, p.line)}${lp?.why ? ` (${clip(lp.why, 70)})` : ' with no count'}`;
  });
}

export function noLimitLoop(cx) {
  const out = [];
  const loops = cx.model.loops || [];
  for (const L of loops) {
    const boxes = (L.boxes || []).filter((id) => cx.g.byId.has(id));
    if (!boxes.length) continue;
    const empty = limitIsEmpty(L.limit);
    const code = loopEvidence(cx, boxFns(cx, boxes));
    if (!empty && (hasCapWord(L.limit) || !code.length)) continue;     // a stated limit stands unless the code disagrees and the words do not name a bound
    out.push({
      key: `no-limit-loop:${L.id}`, check: 'no-limit-loop', boxes, routes: [], loop: L.id,
      question: empty ? `Loop "${L.title || L.id}" shows no limit: what stops it?` : `Loop "${L.title || L.id}" names a limit but the code shows a loop with no count: what really stops it?`,
      evidence: `${empty ? 'No limit is shown on the loop.' : `The loop's limit says "${clip(L.limit, 60)}".`}${code.length ? ` ${code.slice(0, 2).map((c) => stop(upFirst(c))).join(' ')}` : ''}`,
    });
  }
  // A cycle drawn in the routes that no declared loop talks about.
  const ids = cx.g.boxes.map((b) => b.id);
  for (const c of sccs(ids, cx.g.out)) {
    const self = c.length === 1 && cx.g.out.get(c[0]).some((r) => r.to === c[0]);
    if (c.length < 2 && !self) continue;
    const set = new Set(c);
    const covered = loops.some((L) => (L.boxes || []).filter((id) => set.has(id)).length >= Math.min(2, c.length));
    if (covered) continue;
    const sorted = [...c].sort((a, b) => cx.g.order.get(a) - cx.g.order.get(b));
    const text = sorted.map((id) => `${cx.g.byId.get(id).title} ${cx.g.byId.get(id).plain ?? ''}`).join(' ') + ' ' + cx.g.routes.filter((r) => set.has(r.from) && set.has(r.to)).map((r) => `${r.when ?? ''} ${r.why ?? ''}`).join(' ');
    if (hasCapWord(text)) continue;
    out.push({
      key: `no-limit-loop:${sorted[0]}`, check: 'no-limit-loop', boxes: sorted, routes: cx.g.routes.filter((r) => set.has(r.from) && set.has(r.to)).map((r) => r.id),
      question: `A cycle runs through ${sorted.slice(0, 3).join(', ')}${sorted.length > 3 ? ', ...' : ''} with no loop entry and no limit shown: what stops it?`,
      evidence: `${sorted.length} boxes form a cycle drawn in the routes, and no loop lists them.`,
    });
  }
  return out;
}

// Which box stands for a census ending? Ledger first, then the end box citing its function nearest its line.
// Without a ledger row it must be an end box that either names the value or cites exactly that line: a nearby
// line in the same function is not enough, since one function often holds several endings.
export function boxForEnding(cx, row) {
  const l = cx.model.ledger?.[row.id];
  if (l?.box && cx.g.byId.has(l.box)) return l.box;
  if (l?.merged && cx.g.byId.has(l.merged)) return l.merged;
  const val = alnum(row.value);
  let best = null, bs = -1;
  for (const c of cx.cites.get(normPath(row.fn)) || []) {
    const b = cx.g.byId.get(c.box);
    if (!b || b.kind !== 'end') continue;
    const vm = val.length >= 3 && [b.id, b.handle, b.title].some((t) => alnum(t).includes(val));
    const eq = !!row.line && c.line === row.line;
    if (!vm && !eq) continue;
    const s = (vm ? 2 : 0) + (eq ? 1 : 0);
    if (s > bs) { bs = s; best = c.box; }
  }
  return best;
}

function endingHit(cx, row) {
  const ov = cx.overlay;
  if (!ov) return null;
  const e = ov.endings?.[row.id];
  if (e) return (e.count ?? 0) > 0;
  const p = normPath(row.path || symbolPath(row.fn));
  const f = ov.lines?.[p];
  if (f) {
    if ((f.missing || []).includes(row.line)) return false;
    if ((f.executed || []).includes(row.line)) return true;
  }
  return null;                                                       // no evidence about this row: say nothing
}

// Does the loaded evidence say anything about tests or runs at all? (line lists, per-ending counts, or boxes a run looked at)
export function hasTestEvidence(ov) {
  if (!ov) return false;
  if (ov.endings || ov.lines) return true;
  return Object.values(ov.boxes || {}).some((b) => b && (b.untested === true || b.level === 'seen' || b.level === 'proved'));
}

export function endingNoTest(cx) {
  const out = [], by = new Map();                                    // box -> {rows, reason}
  const slot = (box) => { if (!by.has(box)) by.set(box, { rows: [], reason: '' }); return by.get(box); };
  // Row by row: the census ending whose line the evidence says never ran.
  for (const row of nonLow(cx.census?.endings)) {
    if (endingHit(cx, row) !== false) continue;
    const box = boxForEnding(cx, row);
    if (box) slot(box).rows.push(row);
  }
  // Box by box: an end box a run looked at and could not light, because its cited line never ran.
  for (const b of cx.g.boxes) {
    const o = cx.overlay?.boxes?.[b.id];
    if (b.kind !== 'end' || !o || o.untested !== true || o.level === 'seen' || o.level === 'proved') continue;
    const s = slot(b.id);
    s.reason = String((o.reasons || [])[0] || '');
    if (!s.rows.length) for (const row of nonLow(cx.census?.endings)) if (boxForEnding(cx, row) === b.id) s.rows.push(row);
  }
  const val = (r) => (r.value != null && r.value !== '' ? ` "${r.value}"` : '');
  for (const [box, { rows, reason }] of by) {
    const r0 = rows[0];
    const head = r0 ? `the ${r0.kind || 'ending'}${val(r0)} at ${where(r0.fn, r0.line)}` : `the ending in ${box}`;
    const what = rows.length ? rows.slice(0, 3).map((r) => `${r.kind}${val(r)} at ${where(r.fn, r.line)}`).join('; ') : box;
    out.push({
      key: `ending-no-test:${box}`, check: 'ending-no-test', boxes: [box], routes: [],
      question: `No test or run reached ${head}: what would make it happen, and is it worth a test?`,
      evidence: `Not seen in the loaded test evidence: ${what}${reason ? ` (${clip(reason, 80)})` : ''}.`,
    });
  }
  return out;
}

// Values the code writes as plain literals, which the census (endings only) cannot see: the quoted strings and member names inside every function's return
// expressions (facts), and the declared string values signals.json saw assigned, put in a dict, returned or passed on (signals.produced). Where signals.json
// is missing or old, assignments and dict literals were NOT searched, and a candidate says so.
function literalValues(cx) {
  const set = new Set();
  for (const f of Object.values(cx.facts?.functions || {})) for (const r of f.returns || []) {
    const t = String(r.expr ?? '');
    for (const m of t.matchAll(/["'`]([^"'`]{1,60})["'`]/g)) set.add(alnum(m[1]));
    for (const m of t.matchAll(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+/g)) set.add(alnum(lastPart(m[0])));
  }
  const sp = cx.signals && cx.signals.produced;
  const searchedAssignments = !!sp && typeof sp === 'object';
  if (searchedAssignments) for (const k of Object.keys(sp)) set.add(alnum(k));
  set.delete('');
  return { set, searchedAssignments };
}

export function declaredNeverProduced(cx) {
  const out = [], by = new Map();
  const produced = new Set();
  for (const e of cx.census?.endings || []) { produced.add(alnum(e.value)); produced.add(alnum(lastPart(e.value))); }
  const lits = literalValues(cx);
  for (const v of lits.set) produced.add(v);
  // Where the reader counts how often each enum member is mentioned in code (facts.enums[].uses), a member mentioned
  // anywhere is not "never produced", and a member mentioned nowhere is direct evidence.
  const uses = new Map();
  for (const e of cx.facts?.enums || []) if (e.uses && e.members) (e.values || []).forEach((v, i) => uses.set(`${e.name}|${alnum(v)}`, { n: e.uses[e.members[i]], member: e.members[i] }));
  for (const t of cx.census?.outcomeTypes || []) {
    for (const v of t.values || []) {
      const nv = alnum(v), u = uses.get(`${t.name}|${nv}`);
      if (nv.length < 3 || produced.has(nv) || (u && u.n > 0)) continue;
      let best = null, bs = 0;
      for (const b of cx.g.boxes) {
        let s = 0;
        if (alnum(b.handle) === nv || alnum(lastPart(b.id)) === nv) s = 3;
        else if (alnum(b.title) === nv || alnum(b.title).includes(nv)) s = 2;
        else if (alnum(b.plain).includes(nv)) s = 1;
        if (s && b.kind === 'end') s += 0.5;
        if (s > bs) { bs = s; best = b; }
      }
      if (!best || bs < 2) continue;                                 // a value the map does not name is a census gap, not this finding
      // States that roads lead into are often set through strings the extractor cannot follow; only an end box, or a box
      // nothing leads to, is the map and the code disagreeing about whether this value ever happens.
      if (best.kind !== 'end' && cx.g.inX(best.id).length > 0) continue;
      const ob = cx.overlay?.boxes?.[best.id];
      if (['seen', 'proved'].includes(ob?.level) && !ob.anchorOnly) continue;   // a run arrived at it: it is produced (a cited line that merely ran does not count: anchorOnly)
      if (!by.has(best.id)) by.set(best.id, []);
      by.get(best.id).push({ type: t, value: v, never: u && u.n === 0 ? u.member : null });
    }
  }
  const note = lits.searchedAssignments ? ' Return literals and the string values signals.json saw assigned, put in a dict or returned, were searched: none match.' : ' Assignments and dict literals were not searched (no signals.json with a produced list: run faultline signals), so a value set only that way would not be seen.';
  for (const [box, items] of by) {
    const i0 = items[0], noIn = cx.g.inX(box).length === 0;
    out.push({
      key: `declared-never-produced:${box}`, check: 'declared-never-produced', boxes: [box], routes: [],
      question: `${i0.type.name} lists "${i0.value}" but no ending in the code sets it: is it kept for later, or left over?`,
      evidence: `${i0.type.name} declares ${items.map((x) => `"${x.value}"`).join(', ')}${i0.type.path ? ` (${where(i0.type.path + '::', i0.type.line)})` : ''}, and the census finds no ending that produces ${items.length > 1 ? 'them' : 'it'}.${items.some((x) => x.never) ? ` No code refers to ${items.filter((x) => x.never).map((x) => `${x.type.name}.${x.never}`).join(', ')}.` : ''}${note}${noIn ? ' The box has no road in.' : ''}`,
    });
  }
  return out;
}
