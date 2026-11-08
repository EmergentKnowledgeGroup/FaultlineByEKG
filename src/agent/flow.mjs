// `faultline path` and `faultline impact` between functions, by the call list: they work for every function the scan found, drawn or not, and mark a hop that
// only the call list knows (the caller has no drawn chart). A function defined inside another counts as one hop from it, marked "inside". A route is what the
// calls allow, not a promise that one request takes it.
import { plural } from '../build/util.mjs';
import { callSiteBox } from './body.mjs';
import { nameList } from './fnwhere.mjs';
import { finish } from './view.mjs';

export const FUNNEL = 12;                     // a function called from more than this many places is reached, but the walk does not go on through it
const COST = { proven: 1, linked: 1, may: 3, inside: 2 };      // a cost for the weighted route: a sure call is cheapest, a "may" call or an inner function dearer
const MAX_HOPS_SHOWN = 14;
const WORD = { proven: 'calls', linked: 'is linked to', may: 'may call', inside: 'has inside it' };

/** Every step out of each function: its calls, and the functions defined inside it. Built once per reading. */
function steps(R) {
  if (R._steps) return R._steps;
  const m = new Map();
  const push = (from, s) => { if (!m.has(from)) m.set(from, []); m.get(from).push(s); };
  for (const [from, es] of R.out) for (const e of es) push(from, { to: e.to, kind: e.tier, line: e.line });
  for (const F of R.list) for (const k of F.children) push(F.id, { to: k, kind: 'inside', line: R.byId.get(k).line });
  R._steps = m;
  return m;
}

/** The cheapest route from one function to another (a plain fewest-hops one when `shortest`). null when the calls give none. */
export function route(R, from, to, shortest = false) {
  const next = steps(R), dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
  const cost = (s) => (shortest ? 1 : COST[s.kind]);
  const q = [from];
  while (q.length) {
    q.sort((a, b) => dist.get(a) - dist.get(b) || (a < b ? -1 : 1));
    const v = q.shift();
    if (done.has(v)) continue;
    done.add(v);
    if (v === to) break;
    for (const s of next.get(v) || []) {
      const d = dist.get(v) + cost(s);
      if (!dist.has(s.to) || d < dist.get(s.to)) { dist.set(s.to, d); prev.set(s.to, { from: v, ...s }); q.push(s.to); }
    }
  }
  if (!prev.has(to) && from !== to) return null;
  const hops = [];
  for (let v = to; v !== from;) { const p = prev.get(v); hops.unshift({ ...p, to: v }); v = p.from; }
  return hops;
}

/** Walk down from some functions: function -> hops from the start. A funnel is reached but not left when `stopAtFunnels`. */
function walk(R, start, stopAtFunnels) {
  const next = steps(R), dist = new Map(start.map((s) => [s, 0])), q = [...start];
  for (let h = 0; h < q.length; h++) {
    const v = q[h];
    if (stopAtFunnels && dist.get(v) > 0 && (R.inn.get(v) || []).length > FUNNEL) continue;
    for (const s of next.get(v) || []) if (!dist.has(s.to)) { dist.set(s.to, dist.get(v) + 1); q.push(s.to); }
  }
  return dist;
}

const fnName = (F) => `${F.n ? F.n + ' ' : ''}${F.anon ? F.long || F.name : F.name}`;

/** The function a resolved query stands for, or null when it stands for a file or nothing. */
export function functionOf(res) {
  if (res.kind === 'function') return res.F;
  if (res.kind === 'box') return res.F;
  return null;
}

export function pathBetween(R, data, ra, rb, a, b, c, T, shortest) {
  const A = functionOf(ra), B = functionOf(rb);
  const link = c.link(c.wholeId, null);
  if (!A || !B) return finish([`PATH: ${!A ? `"${a}" is not a function` : `"${b}" is not a function`}${(!A ? ra : rb).note ? ': ' + (!A ? ra : rb).note : ''}. Use a function number (f58), a function id, a name, file:line or a box id.`], link, T, 'faultline path <a> <b>');
  if (A.id === B.id) return finish([`PATH ${fnName(A)} -> ${fnName(B)}: the same function. faultline where ${A.n || A.id} shows its body.`], link, T, 'faultline path <a> <b>');
  const hops = route(R, A.id, B.id, shortest);
  const sure = [];
  if (ra.others && ra.others.length) sure.push(`"${a}" names ${ra.others.length + 1} functions; ${fnName(A)} was used because ${ra.why}.`);
  if (rb.others && rb.others.length) sure.push(`"${b}" names ${rb.others.length + 1} functions; ${fnName(B)} was used because ${rb.why}.`);
  if (!hops) {
    const back = route(R, B.id, A.id, shortest);
    const nf = (R.unfollowed.get(A.id) || []).length;
    return finish([`PATH ${fnName(A)} -> ${fnName(B)}: NO ROUTE in the call list. Not in the list is not the same as impossible: ${nf ? `${plural(nf, 'call')} in ${A.n || A.name} could not be traced to project code, and ` : ''}a call made by name, through a callback or at run time is not in it.`, back ? `A route exists the other way (${plural(back.length, 'hop')}): faultline path ${B.n || B.id} ${A.n || A.id}` : 'None the other way either.', ...sure], link, T, 'faultline path <a> <b>');
  }
  const L = [`PATH ${fnName(A)} -> ${fnName(B)}  ${plural(hops.length, 'hop')}  (${shortest ? 'fewest hops' : 'a sure call is preferred to a "may" call'}; a route the calls allow, not a promise that one request takes it)`, ...sure];
  const show = hops.length > MAX_HOPS_SHOWN ? [...hops.slice(0, MAX_HOPS_SHOWN - 4), null, ...hops.slice(-4)] : hops;
  for (const h of show) {
    if (!h) { L.push(`... ${hops.length - (MAX_HOPS_SHOWN - 4) - 4} hops ...`); continue; }
    const F = R.byId.get(h.from), G = R.byId.get(h.to), site = h.kind === 'inside' ? null : callSiteBox(R, F, G);
    const where = h.kind === 'inside' ? 'defined inside it, not a call' : `${h.line ? 'L' + h.line : 'line unknown'}${site ? `, box ${site.id}${site.kind === 'decision' ? ` "${site.title}"` : ''}` : ''}`;
    L.push(`${fnName(F)} ${WORD[h.kind]} ${fnName(G)}  [${where}${F.chart ? '' : '; call list only: ' + (F.boxes ? 'no chart' : 'no box') + ' for the caller'}]`);
  }
  const tiers = { may: hops.filter((h) => h.kind === 'may').length, inside: hops.filter((h) => h.kind === 'inside').length, listOnly: hops.filter((h) => !R.byId.get(h.from).chart).length };
  const notes = [tiers.may ? `${plural(tiers.may, 'hop')} "may" (the call could run another function)` : '', tiers.inside ? `${plural(tiers.inside, 'hop')} into an inner function` : '', tiers.listOnly ? `${tiers.listOnly} of ${hops.length} hops leave a function with no drawn chart` : ''].filter(Boolean);
  if (notes.length) L.push(notes.join('; '));
  return finish(L, link, T, `faultline path ${A.n || A.id} ${B.n || B.id} --budget ${T * 2}`);
}

export function impactOf(R, data, res, query, c, T) {
  const F = functionOf(res);
  const link = c.link(c.wholeId, null);
  if (!F) return finish([`IMPACT ${query}: ${res.kind === 'file' ? 'a file, not a function: faultline where ' + query + ' lists its functions, then impact <function>' : res.note || 'no match'}`], link, T, 'faultline impact <function>');
  const start = [F.id];
  const A = walk(R, start, true), B = walk(R, start, false);
  A.delete(F.id); B.delete(F.id);
  const at = (d) => [...A.entries()].filter(([, k]) => k === d).map(([id]) => R.byId.get(id));
  const dists = [...new Set(A.values())].sort((x, y) => x - y);
  const byHop = dists.slice(0, 8).map((d) => `${d}:${at(d).length}`).join(' ') + (dists.length > 8 ? ` ... to ${dists[dists.length - 1]} hops` : '');
  const funnels = [...A.keys()].filter((id) => (R.inn.get(id) || []).length > FUNNEL).map((id) => R.byId.get(id));
  const cut = B.size - A.size;
  const L = [`IMPACT ${fnName(F)} (a function; ${F.path}:${F.line})${res.others && res.others.length ? `  [${res.others.length + 1} functions have that name; ${res.why}]` : ''}`];
  const listOnly = [...A.keys()].filter((id) => !R.byId.get(id).chart).length;
  L.push(`DOWNSTREAM ${B.size} function(s) by calls and inner functions. By hops: ${byHop || 'none'}`);
  if (cut > 0) L.push(`CUT: the walk stops at ${plural(funnels.length, 'shared function')} called from more than ${FUNNEL} places and does not go through them, so ${cut} more are not listed below: ${nameList(R, funnels.slice(0, 4)).map((nm, i) => `${nm} (${(R.inn.get(funnels[i].id) || []).length} callers)`).join(', ')}${funnels.length > 4 ? ` +${funnels.length - 4}` : ''}`);
  else if (funnels.length) L.push(`SHARED FUNCTIONS on the way (called from more than ${FUNNEL} places; they lead nowhere new): ${nameList(R, funnels.slice(0, 4)).join(', ')}${funnels.length > 4 ? ` +${funnels.length - 4}` : ''}`);
  const h1 = at(1), h2 = at(2);
  const kindOf = (id) => ((R._steps.get(F.id) || []).find((s) => s.to === id) || {}).kind;
  if (h1.length) L.push(`1 HOP (${h1.length}): ${nameList(R, h1.slice(0, 10)).map((nm, i) => nm + ({ may: ' (may)', inside: ' (inside)', linked: ' (linked)' }[kindOf(h1[i].id)] || '')).join(', ')}${h1.length > 10 ? ` +${h1.length - 10}` : ''}`);
  if (h2.length) L.push(`2 HOPS (${h2.length}): ${nameList(R, h2.slice(0, 12)).join(', ')}${h2.length > 12 ? ` +${h2.length - 12}` : ''}`);
  const rest = [...A.entries()].filter(([, d]) => d > 2).map(([id]) => R.byId.get(id)), per = {};
  for (const G of rest) per[G.stage || '-'] = (per[G.stage || '-'] || 0) + 1;
  if (rest.length) { const ps = Object.entries(per).sort((x, y) => y[1] - x[1]); L.push(`BEYOND 2 HOPS ${rest.length} function(s), by stage: ${ps.slice(0, 6).map(([s, n]) => `${s} ${n}`).join(', ')}${ps.length > 6 ? ` +${ps.length - 6} stages` : ''}`); }
  if (listOnly) L.push(`${listOnly} of the ${A.size} listed have no drawn chart: they are known from the call list; faultline where <number> gives each one's body`);
  const fails = R.failing ? [...A.keys(), F.id].flatMap((id) => (R.failing.get(id) || []).map((e) => ({ ...e, id }))) : [];
  if (fails.length) L.push(`FAILING ENDINGS in it or downstream ${fails.length}: ${fails.slice(0, 4).map((e) => `${e.page || R.byId.get(e.id).n || '-'} "${e.title}"`).join(', ')}${fails.length > 4 ? ` +${fails.length - 4}` : ''}`);
  const inn = (R.inn.get(F.id) || []).map((e) => R.byId.get(e.from)).filter(Boolean);
  const up = (() => { const seen = new Set([F.id]), q = [F.id]; for (let h = 0; h < q.length; h++) for (const e of R.inn.get(q[h]) || []) if (!seen.has(e.from)) { seen.add(e.from); q.push(e.from); } return seen.size - 1; })();
  const parent = F.parent && R.byId.get(F.parent);
  L.push(`DEPENDS ON (upstream ${up} function(s) by calls): ${inn.length ? nameList(R, inn.slice(0, 5)).join(', ') + (inn.length > 5 ? ` +${inn.length - 5}` : '') : 'no call to it is in the call list'}${parent ? `; defined inside ${fnName(parent)}` : ''}`);
  const starts = R.startsOf.get(F.id);
  if (starts) L.push(`STARTS journey ${starts.map((i) => R.journeyIds[i]).join(', ')}`);
  const cand = data.findings.filter((f) => F.n && f.boxes.some((x) => x.startsWith(F.n + '.')));
  if (cand.length) L.push(`QUESTIONS in it: ${cand.slice(0, 3).map((f) => f.key).join(' ')}${cand.length > 3 ? ` +${cand.length - 3}` : ''}`);
  return finish(L, F.chart && data.boxes[`${F.n}.0`] ? c.linkBox(`${F.n}.0`) : link, T, `faultline impact ${F.n || F.id} --budget ${T * 2}`);
}
