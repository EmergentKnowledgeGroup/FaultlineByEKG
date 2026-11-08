// Districts: the stages of the whole-system picture. 10 to 25 of them, by one rule, the same every time.
//
// RULE (stated on the page):
//   1. Start from the directories one level under the common path prefix. Every mapped function is in exactly one.
//   2. SPLIT: while the biggest district holds more than MAX_SHARE of all mapped functions (and more than FLOOR functions), split it by its next
//      path part (a file that is still too big is split by class). A district that cannot be split into two real parts stays whole.
//   3. MERGE: while there are more than TARGET_MAX districts, merge the smallest into the district it is most tied to.
//      Tie = calls between the two (both ways) plus a bonus when they share the parent directory; ties broken by name.
//      A merge never makes a district bigger than MERGE_CAP of all functions unless nothing else is possible.
//   A merged district is named after its parts (at most three names, then "and N more").
import { cmp } from './util.mjs';

export const MAX_SHARE = 0.12;     // a district holding more than this share of all functions is split
export const FLOOR = 60;           // ... but only if it holds more than this many functions
export const TARGET_MAX = 24;      // districts above this many are merged
export const MERGE_CAP = 0.3;      // a merge may not make a district bigger than this share
export const MIN_CHILD = 8;        // a split must give at least two parts of this many functions, or the district stays whole
export const SIBLING_BONUS = 3;    // tie bonus for two districts that share a parent directory
export const DISTRICT_RULE = `Stages are groups of directories. Start from the directories one level under the common prefix; split any stage over ${MAX_SHARE * 100}% of the functions into its sub-directories (only when that gives two or more parts of ${MIN_CHILD}+ functions); then merge the smallest stage into the one it calls most until ${TARGET_MAX} or fewer remain.`;

const SEP = '\u0000';

function commonPrefix(paths) {
  const parts = paths.map((p) => p.split('/').slice(0, -1));
  if (!parts.length) return [];
  let pre = parts[0];
  for (const p of parts.slice(1)) {
    let k = 0;
    while (k < pre.length && k < p.length && pre[k] === p[k]) k++;
    pre = pre.slice(0, k);
  }
  return pre;
}

const keyStr = (k) => k.join(SEP);
const keyArr = (s) => s.split(SEP);

/**
 * @param {Map<string,{path:string, qual:string}>} info
 * @param {Map<string, number>} calls  "fidA\0fidB" -> weight (either direction)
 * @returns {{of: Map<string,string>, order: string[], titles: Map<string,string>, prefix: string[], trace: object}}
 */
export function makeDistricts(info, calls) {
  const fids = [...info.keys()].sort(cmp);
  const pre = commonPrefix(fids.map((f) => info.get(f).path));
  const n0 = pre.length;
  const total = fids.length;
  const comps = new Map();
  for (const fid of fids) {
    const f = info.get(fid);
    const c = f.path.split('/').slice(n0);
    const q = f.qual.split('.');
    comps.set(fid, [...c, ...(q.length > 1 && !q[0].startsWith('<') ? [q[0]] : [])]);
  }
  const groups = new Map();
  const put = (k, fid) => {
    const s = keyStr(k);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(fid);
  };
  for (const fid of fids) put(comps.get(fid).slice(0, 1), fid);
  const trace = { start: groups.size, splits: 0, merges: 0, keptWhole: [] };
  const frozen = new Set();
  for (let guard = 0; guard < 300; guard++) {
    const cands = [...groups.keys()].filter((k) => !frozen.has(k));
    if (!cands.length) break;
    const big = cands.sort((a, b) => groups.get(b).length - groups.get(a).length || cmp(b, a))[0];
    const items = groups.get(big);
    if (items.length <= Math.max(FLOOR, MAX_SHARE * total)) break;
    const d = keyArr(big).length;
    const kids = new Map();
    const rest = [];
    for (const fid of items) {
      const c = comps.get(fid);
      if (c.length > d) {
        const ks = keyStr(c.slice(0, d + 1));
        if (!kids.has(ks)) kids.set(ks, []);
        kids.get(ks).push(fid);
      } else rest.push(fid);
    }
    const real = [...kids.values()].filter((v) => v.length >= MIN_CHILD);
    if (real.length < 2) {
      frozen.add(big);
      trace.keptWhole.push(keyArr(big).join('/'));
      continue;
    }
    groups.delete(big);
    const small = [...rest];
    for (const [k, v] of kids) {
      if (v.length >= MIN_CHILD) groups.set(k, v);
      else small.push(...v);
    }
    if (small.length) groups.set(keyStr([...keyArr(big), '(other)']), small);
    trace.splits++;
  }
  // merge
  const where = new Map();
  for (const [k, v] of groups) for (const fid of v) where.set(fid, k);
  const names = new Map([...groups.keys()].map((k) => [k, [k]]));
  const osize = new Map([...groups].map(([k, v]) => [k, v.length]));
  const tieOf = () => {
    const tie = new Map();
    for (const [pair, w] of calls) {
      const [a, b] = pair.split(SEP);
      const ka = where.get(a);
      const kb = where.get(b);
      if (ka && kb && ka !== kb) {
        tie.set(`${ka}\u0001${kb}`, (tie.get(`${ka}\u0001${kb}`) ?? 0) + w);
        tie.set(`${kb}\u0001${ka}`, (tie.get(`${kb}\u0001${ka}`) ?? 0) + w);
      }
    }
    return tie;
  };
  let tie = tieOf();
  while (groups.size > TARGET_MAX) {
    const small = [...groups.keys()].sort((a, b) => groups.get(a).length - groups.get(b).length || cmp(a, b))[0];
    let best = null;
    let bs = -1;
    for (const k of [...groups.keys()].sort(cmp)) {
      if (k === small) continue;
      const ka = keyArr(small);
      const kb = keyArr(k);
      let s = (tie.get(`${small}\u0001${k}`) ?? 0) + (ka.length > 1 && keyStr(ka.slice(0, -1)) === keyStr(kb.slice(0, -1)) ? SIBLING_BONUS : 0);
      if (groups.get(k).length + groups.get(small).length > MERGE_CAP * total) s -= 1e6;
      if (s > bs || (s === bs && best !== null && k < best)) {
        best = k;
        bs = s;
      }
    }
    const a = keyArr(small);
    const b = keyArr(best);
    const shared = [];
    for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) shared.push(a[i]);
    const slug = (s) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'x';
    const last = (o) => slug(keyArr(o).pop());
    let key = keyStr([...shared, `+${[...new Set([...names.get(small), ...names.get(best)].map(last))].sort(cmp).slice(0, 3).join('+')}`]);
    while (groups.has(key) && key !== small && key !== best) key += '_';
    const merged = [...groups.get(small), ...groups.get(best)];
    const na = names.get(small);
    const nb = names.get(best);
    groups.delete(small);
    groups.delete(best);
    names.delete(small);
    names.delete(best);
    groups.set(key, merged);
    names.set(key, [...na, ...nb]);
    for (const fid of merged) where.set(fid, key);
    tie = tieOf();
    trace.merges++;
  }
  const title = (k) => {
    const nm = (o) => keyArr(o).join('/').replace('/(other)', ' (other files)');
    const ts = [...names.get(k)].sort((x, y) => (osize.get(y) ?? 0) - (osize.get(x) ?? 0) || cmp(x, y)).map(nm);
    if (ts.length === 1) return ts[0];
    return ts.slice(0, 3).join(', ') + (ts.length > 3 ? ` and ${ts.length - 3} more` : '');
  };
  const order = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length || cmp(a, b));
  const ids = new Map(order.map((k, i) => [k, `d${i + 1}`]));
  const of = new Map();
  for (const [k, v] of groups) for (const fid of v) of.set(fid, ids.get(k));
  const titles = new Map(order.map((k) => [ids.get(k), title(k)]));
  return { of, order: order.map((k) => ids.get(k)), titles, prefix: pre, trace };
}
