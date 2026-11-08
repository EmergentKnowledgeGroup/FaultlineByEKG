// What the tool map holds at or near a cited line: decisions, exits, calls, effects, who is told. Read from Layer 1 only.
import { cmp } from './canon.mjs';

/** Window around a cited line, in lines above and below, in which a test / an exit / a call is taken as "the one the agent means". An agent often cites the body line under a test, or the line of a wrapped statement. */
export const WINDOW = {
  decision: [2, 1],
  exit: [1, 2],
  call: [1, 1],
  effect: [1, 2],
};

/** Effect names that belong to each story box kind. `ext:*` and `wait:*` stand for any suffix. */
export const KIND_EFFECTS = {
  store: ['store', 'delete', 'ext:db'],
  wait: ['wait:*'],
  external: ['ext:*'],
};
/** Effects that mean something leaves for a person or another party: used for roads typed `deliver`. */
export const DELIVERS = ['print', 'respond', 'emit', 'ext:network', 'ext:gui'];
/** Effects that mean the system writes something down or sends something: used for roads typed `record`. */
export const RECORDS = ['store', 'delete', 'emit', 'print', 'ext:db', 'ext:network'];

export const effectIn = (effect, list) => list.some((p) => (p.endsWith('*') ? effect.startsWith(p.slice(0, -1)) : effect === p));
/** Exceptions a program raises to stop normally: a raise of one of these is an ordinary ending, not a failure. */
const NORMAL_END = /^raise[\w-]*:(?:SystemExit|StopIteration|StopAsyncIteration)\b/;
export const isRaise = (cls) => /^raise/.test(cls ?? '') && !NORMAL_END.test(cls ?? '');

const lowerBound = (a, line) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m][0] < line) lo = m + 1; else hi = m; } return lo; };
function within(a, lo, hi) { const out = []; for (let i = lowerBound(a, lo); i < a.length && a[i][0] <= hi; i++) out.push(a[i]); return out; }

export class Seen {
  constructor(L) { this.L = L; this.cache = new Map(); this.roadsOf = null; }

  _roadsByFn() {
    if (this.roadsOf) return this.roadsOf;
    this.roadsOf = new Map();
    for (const [id, r] of this.L.roads) {
      const fn = r.prov?.fn;
      if (!fn) continue;
      if (!this.roadsOf.has(fn)) this.roadsOf.set(fn, []);
      this.roadsOf.get(fn).push(id);
    }
    return this.roadsOf;
  }

  facts(fid) {
    if (this.cache.has(fid)) return this.cache.get(fid);
    const L = this.L;
    const f = { dec: [], ex: [], calls: [], eff: [], hears: [], deliver: [] };
    for (const id of L.boxesOfFn.get(fid) ?? []) {
      const b = L.boxes.get(id);
      const pv = b.prov ?? {};
      const lines = [...new Set([pv.line, ...(pv.chain ?? [])].filter(Number.isInteger))];
      if (b.kind === 'decision') for (const l of lines) f.dec.push([l, id, b.detail || b.title || '']);
      if (b.kind === 'end') for (const l of new Set([pv.line, ...(pv.sites ?? [])].filter(Number.isInteger))) f.ex.push([l, id, pv.class ?? '']);
      for (const x of pv.folded_exits ?? []) if (Number.isInteger(x.line)) f.ex.push([x.line, id, x.class ?? '']);
      const effs = [...(pv.effects ?? [])];
      if (b.kind === 'store') effs.push('store');
      if (b.kind === 'wait') effs.push('wait:machine');
      for (const e of effs) for (const l of new Set([pv.line, ...(pv.sites ?? [])].filter(Number.isInteger))) f.eff.push([l, e, 'confident', id]);
    }
    for (const e of L.effects.get(fid) ?? []) f.eff.push([e.line, e.effect, e.conf, null]);
    const ix = L.fns.get(fid);
    for (const c of ix?.br ?? []) if (Number.isInteger(c[0])) f.dec.push([c[0], null, c[2] ?? '']);
    for (const c of ix?.rt ?? []) if (Number.isInteger(c[0])) f.ex.push([c[0], null, c[1]]);
    for (const c of ix?.ca ?? []) if (Number.isInteger(c[0])) f.calls.push([c[0], c[1] ?? '', [], null]);
    for (const rid of this._roadsByFn().get(fid) ?? []) {
      const r = L.roads.get(rid);
      if (r.prov.rule === 'call' || r.prov.rule === 'link') f.calls.push([r.prov.line, r.when ?? '', [], rid]);
      if (r.type === 'deliver' && Number.isInteger(r.prov.line)) f.deliver.push([r.prov.line, rid]);
    }
    for (const h of L.hears.get(fid) ?? []) f.hears.push([h.line, h.conf, h.says]);
    for (const k of Object.keys(f)) f[k].sort((x, y) => x[0] - y[0] || cmp(String(x[1]), String(y[1])));
    this.cache.set(fid, f);
    return f;
  }

  /** What the tool holds in [line - back, line + fwd], over a list of functions (a closure and the function around it). */
  at(chain, line, back, fwd) {
    const out = { dec: [], ex: [], calls: [], eff: [], hears: [], deliver: [] };
    for (const fid of chain) {
      const f = this.facts(fid);
      for (const k of Object.keys(out)) out[k].push(...within(f[k], line - back, line + fwd));
    }
    return out;
  }
}
