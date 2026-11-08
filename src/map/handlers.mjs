// What a handler does with the error it takes, read off its body: the vocabulary is the call effects plus control-flow facts.
// These methods are mixed into Flow (excflow.mjs), which holds the call index and the per-function effect sets they read.
import { sorted } from './pyrt.mjs';
import { tkey } from './canon.mjs';

const TELLS = ['log', 'print', 'respond', 'emit', 'record', 'store'];
const RECORD_FIELDS = new Set(['status', 'state', 'error', 'last_error', 'ok', 'failed']);
const SAYS_SOMETHING = ['reraise', 'translate', 'respond', 'emit', 'print', 'log', 'record', 'return_value'];
const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);
const anyIn = (lab, names) => names.some((n) => lab.has(n));
const EXC_EDGE = new Set(['exc', 'unmatched', 'fin-exc']); // the edges an exception takes

export const HandlerMethods = {
  /** True when some way through the handler's body does not end in a raise: it returns, jumps, or reaches the end and carries on after the try. */
  handlerCompletes(fid, h) {
    const fn = this.P.fns.get(fid);
    this._succ ??= new Map();
    if (!this._succ.has(fid)) {
      const m = new Map();
      for (const [a, b, l] of fn.edges) if (!EXC_EDGE.has(l)) m.set(a, [...(m.get(a) ?? []), b]);
      this._succ.set(fid, m);
    }
    const succ = this._succ.get(fid);
    const seen = new Set([h]);
    const work = [h];
    while (work.length) {
      for (const y of succ.get(work.pop()) ?? []) {
        if ((fn.nodes[y].h ?? null) !== h) return true; // left the handler's body without raising
        if (!seen.has(y)) {
          seen.add(y);
          work.push(y);
        }
      }
    }
    return false;
  },

  /** Labels for a handler body: the vocabulary of classifyCall plus control-flow facts. Read only: the set is shared. */
  regionEffects(fid, h) {
    const key = tkey(fid, h);
    this._reg ??= new Map();
    if (this._reg.has(key)) return this._reg.get(key);
    const nodes = this.P.fns.get(fid).nodes;
    const v = nodes[h].var || null;
    const lab = new Set();
    const rets = [];
    if (nodes[h].uses) lab.add('uses_exc'); // the handler reads its error variable: that is not yet doing anything with it
    for (const nd of nodes) {
      if ((nd.h ?? null) !== h) continue;
      for (const o of nd.ops ?? []) {
        for (const e of o.eff ?? []) {
          lab.add(e);
          if (e.startsWith('maybe:')) lab.add('maybe');
        }
        if (o.t === 'call') {
          if (o.to?.length && o.to.every((g) => this.P.never.has(g))) lab.add('doubt:handler-calls-a-function-that-never-returns'); // it hands the error to a function that always throws
          for (const g of o.to ?? []) {
            for (const e of this.fx2.get(g) ?? []) {
              if (TELLS.includes(e)) lab.add(e + '~');
              else if (e.startsWith('maybe:') && !(o.may ?? []).includes(g)) lab.add('maybe');
            }
          }
          if (v && (o.cb ?? []).includes(v)) {
            lab.add('uses_exc');
            const f = o.f ?? '';
            if ((o.eff ?? []).some((x) => x === 'store' || x === 'emit') || /(append|add|setdefault)$/.test(f)) lab.add('record');
            if (['reject', 'next'].includes(lastDot(f))) lab.add('doubt:handler-hands-the-error-on'); // handed to the caller's side, not recorded
          }
        }
        if (o.t === 'set' && v && o.v === 'name:' + v && o.tk !== 'name') lab.add('record');
        if (o.t === 'set' && o.tk !== 'name' && (o.v.startsWith('const:str') || o.v.startsWith('const:False')) && RECORD_FIELDS.has(lastDot(o.tgt))) lab.add('record');
      }
      if (nd.k === 'raise') {
        if ((nd.exc ?? null) === null || nd.exc === v) lab.add('reraise');
        else if (nd.exc === '*' && ['name', 'attr', 'other'].includes(nd.ek)) lab.add('doubt:handler-raises-a-variable'); // the same error again or another one, not known
        else lab.add('translate');
      } else if (nd.k === 'return') rets.push(nd);
      else if (nd.k === 'jump') lab.add(nd.jt);
    }
    if (rets.length) {
      // the caller learns of the error only from a value that carries it; a constant, a default or the result of a retry tells it nothing
      if (rets.some((r) => r.sig !== 'ret:none' && !(v && (r.rv ?? []).includes(v)))) {
        lab.add('return_other');
        lab.add('maybe');
      } else if (rets.every((r) => r.sig === 'ret:none')) lab.add('return_none');
      else lab.add('return_value');
    }
    // "passes it on" is said only when every way through the body raises; with a way out that does not, it is `reraise_some`
    if (lab.has('reraise') && this.handlerCompletes(fid, h)) {
      lab.delete('reraise');
      lab.add('reraise_some');
    }
    if (lab.has('uses_exc') && !anyIn(lab, SAYS_SOMETHING.concat('reraise_some'))) lab.add('maybe'); // it reads the error and nothing says where that goes: not a claim either way
    this._reg.set(key, lab);
    return lab;
  },

  /** Why a handler's label may be a guess, as a reason code, or null. */
  handlerDoubt(fid, h) {
    const l = sorted(this.regionEffects(fid, h)).find((x) => x.startsWith('doubt:'));
    return l === undefined ? null : l.slice(6);
  },

  disposition(lab) {
    const doubt = [...lab].some((l) => l.startsWith('doubt:'));
    if (doubt && !anyIn(lab, ['respond', 'emit', 'print', 'log', 'record'])) return 'unknown'; // the label would be a guess
    for (const suffix of ['', '~']) {
      for (const [k, name] of [['reraise', 'reraise'], ['translate', 'translate'], ['respond', 'respond'], ['emit', 'emit'], ['print', 'print'], ['log', 'log'], ['record', 'record'], ['return_value', 'return']]) {
        if (lab.has(k + suffix)) return name + suffix;
      }
    }
    if (lab.has('maybe')) return 'unknown'; // something in the handler MAY log / store / answer and nothing could say: not a claim that it swallows
    if (lab.has('reraise_some')) return 'reraise-sometimes'; // one way through raises it again, another does not: neither "passes it on" nor "drops it"
    return 'swallow';
  },
};
