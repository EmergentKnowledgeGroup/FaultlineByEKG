// Who hears about an ending? Decided from the code only: handler dispositions up the call graph, the effects on the path into the ending, and
// whether anything catches a raise at all. Every answer carries its evidence.
import { sorted, cpSlice } from './pyrt.mjs';

const STATUS_FIELDS = new Set(`status state error last_error detail failed ok accepted reason message result outcome phase health problem blocked refused
  last_result`.split(/\s+/));
const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);

/** effect labels (direct or via callee, marked ~) + how the path ends -> a heardBy value */
export function byFrom(lab, term) {
  const has = (k) => lab.has(k) || lab.has(k + '~');
  if (has('print')) return 'person';
  if (has('respond')) return 'caller';
  if (has('emit') || has('record') || has('store')) return 'event';
  if (has('log')) return 'log';
  if (term === 'raise' || term === 'return' || has('return_value')) return 'caller';
  return 'nobody';
}

/** The node of one of `kinds` nearest to `line` (within tol lines), or null. */
export function nearest(fn, line, kinds, tol = 2) {
  let best = null;
  for (const n of fn.nodes) {
    if (!kinds.includes(n.k)) continue;
    const spans = [n.line, ...(Object.hasOwn(n, 'eline') ? [n.eline] : [])];
    let d = Math.min(...spans.map((x) => Math.abs(line - x)));
    for (const o of n.ops ?? []) d = Math.min(d, Math.abs(line - o.line) + (n.k === 'return' || n.k === 'raise' ? 0 : 1));
    if (d <= tol && (best === null || d < best[0])) best = [d, n];
  }
  return best ? best[1] : null;
}

/** labels from the straight-line run that leads into node n, plus n itself. */
export function armLabels(red, fn, n) {
  const lab = new Set();
  let cur = n.i;
  let steps = 0;
  while (steps < 6) {
    const nd = fn.nodes[cur];
    for (const o of nd.ops ?? []) {
      for (const e of o.eff ?? []) lab.add(e);
      if (o.t === 'set' && o.tk !== 'name' && STATUS_FIELDS.has(lastDot(o.tgt).replace(/[[\]]+$/, '').replace(/^_+/, ''))) lab.add('record'); // the failure is written into a field other code can read
    }
    if (nd.k === 'handler') break;
    const ps = red.Pr(cur).map(([p]) => p);
    if (ps.length !== 1 || !['block', 'branch'].includes(fn.nodes[ps[0]].k)) break;
    if (fn.nodes[ps[0]].k === 'branch') break;
    cur = ps[0];
    steps++;
  }
  return lab;
}

/** {by, how, node} for the ending nearest to (fid, line), or null. */
export function classifyAt(M, fid, line) {
  const { P, F } = M;
  const fn = P.fns.get(fid);
  const red = M.red.get(fid);
  const n = nearest(fn, line, ['return', 'raise', 'handler'], 1) ?? nearest(fn, line, ['block', 'jump', 'return', 'raise', 'handler'], 2);
  if (n === null) return null;
  const k = n.k;
  if (k === 'raise' && n.exc) {
    const fates = F.hear(fid, n.i, lastDot(n.exc));
    const lab = armLabels(red, fn, n);
    for (const f of sorted(fates.filter((x) => x.by === 'handler'), (x) => x.depth)) {
      const hl = F.regionEffects(f.fn, f.h);
      if (hl.has('reraise') && !['print', 'respond', 'emit', 'log', 'record'].some((x) => hl.has(x))) continue;
      const d = F.disposition(hl);
      return { by: d !== 'swallow' ? byFrom(new Set([...hl, ...lab]), 'raise') : 'nobody', how: `caught at ${f.fn.slice(f.fn.indexOf('::') + 2)}:${f.line} -> ${d}`, node: k };
    }
    const unc = fates.filter((x) => x.by === 'uncaught');
    if (unc.length) {
      return { by: ['print', 'log'].some((x) => lab.has(x)) ? byFrom(lab, 'raise') : 'person', how: 'nothing catches it before the top: ' + cpSlice(unc.map((x) => x.fn.slice(x.fn.indexOf('::') + 2)).join(', '), 0, 60), node: k };
    }
    return { by: 'caller', how: 'deeper than the search limit', node: k };
  }
  if (k === 'handler') {
    const hl = F.regionEffects(fid, n.i);
    const d = F.disposition(hl);
    return { by: d !== 'swallow' ? byFrom(hl, 'handler') : 'nobody', how: `handler -> ${d}`, node: k };
  }
  const lab = armLabels(red, fn, n);
  const term = k === 'return' && n.sig !== 'ret:none' ? 'return' : 'none';
  const shown = sorted([...lab].filter((e) => ['print', 'respond', 'emit', 'log', 'store'].includes(e)));
  return { by: byFrom(lab, term), how: 'path effects ' + shown.join(',') || 'none', node: k };
}
