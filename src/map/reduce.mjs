// Deterministic reduction: control-flow graph -> readable boxes.
//
// Every rule is a pure function of the graph plus three project-wide tables (see Vocab). Nothing is learned.
//   - ENDING: one box per distinct MAJOR terminal in a function. Major = process exit, raise of a project (domain) exception or of a type the
//     project never defines, return of a constant that recurs across the project (a status word), tuple holding one.
//   - DECISION: a branch (an if/elif/else chain counts once) whose arms, between the branch and its join (immediate post-dominator), end in
//     different major terminals, or do different work (calling project code or hitting an effect), or differ at all (a guard: one arm does something, the other nothing).
//   - LOOP: a loop whose body reaches a major terminal or work, or that has no exit of its own.
//   - WAIT: a block that waits (sleep, lock, join, queue get...) is its own box.
//   - STEP: a connected run of leftover nodes that does work is one box. Runs that do nothing are transparent.
//   - a function that ends up with no boxes but does work gets one STEP box; a trivial leaf gets none.
// Whatever is folded stays listed on its owner (`folded`), with lines.
import { tclass, rbClass } from './vocab.mjs';
import { sorted } from './pyrt.mjs';

const WORKEFF = new Set(['store', 'delete', 'emit', 'respond', 'print']);
const NORMAL_ONLY = new Set(['exc', 'unmatched', 'fin-exc']);
const TRIVIAL_TESTS = ['__name__', 'TYPE_CHECKING', 'sys.platform', 'os.name', 'typeof window', 'typeof document'];
const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);

export const isNormal = (l) => !NORMAL_ONLY.has(l);

export function blockEff(nd) {
  const e = new Set();
  for (const o of nd.ops ?? []) for (const x of o.eff ?? []) e.add(x);
  e.delete('lockwith');
  return e;
}

const EMPTY = { terms: new Set(), work: new Set(), tk: '', wk: '' };
const setKey = (s) => sorted(s).join('\u0000');

export class FnRed {
  constructor(fn, flow, vocab) {
    this.fn = fn;
    this.flow = flow;
    this.v = vocab;
    this.nodes = fn.nodes;
    this.succ = new Map();
    this.pred = new Map();
    for (const [a, b, l] of fn.edges) {
      if (isNormal(l)) {
        this.out(a).push([b, l]);
        this.into(b).push([a, l]);
      }
    }
    this.reach = this.reachable();
    // A raise statement does not end the function when the exception stays inside it: control goes to the handler (or through the finally) that
    // takes it. Draw that as a flow edge `catch`, so what follows a handled raise is reachable, and so a handled raise is not an ending.
    this.rland = new Map();
    this.catch = new Map(); // raise node -> the verdict on "nobody catches it"
    for (const nd of this.nodes) {
      if (nd.k === 'raise' && this.reach.has(nd.i)) {
        const r = flow.raiseLanding(fn.id, nd);
        this.rland.set(nd.i, r);
        // a finally is entered by the raise only when nothing after the try can follow it (else the path merges with the normal one and would
        // invent a way from the raise to the code after the try)
        for (const h of [...r.caught, ...r.finals.filter((f) => !this.leaks(f))]) {
          this.out(nd.i).push([h, 'catch']);
          this.into(h).push([nd.i, 'catch']);
        }
      }
    }
    this.term = new Map();
    for (const nd of this.nodes) {
      if (this.reach.has(nd.i) && nd.k === 'block' && blockEff(nd).has('exit')) {
        const ex = (nd.ops ?? []).filter((o) => (o.eff ?? []).includes('exit') && !['os._exit', 'os.abort', '_exit'].includes(o.f));
        if (ex.length) { // sys.exit raises SystemExit: a handler of this function that takes it makes this no exit
          const lr = flow.landFull(fn.id, nd.i, 'SystemExit');
          if (lr.caught.length && !lr.escapes) continue;
        }
        this.term.set(nd.i, 'X');
        this.succ.set(nd.i, []);
      }
    }
    this.ipdom = this.postdoms();
    this._tc = new Map();
  }

  out(i) {
    let a = this.succ.get(i);
    if (!a) this.succ.set(i, (a = []));
    return a;
  }

  into(i) {
    let a = this.pred.get(i);
    if (!a) this.pred.set(i, (a = []));
    return a;
  }

  /** successors / predecessors over the normal edges (plus `catch`), never undefined */
  S(i) { return this.succ.get(i) ?? []; }
  Pr(i) { return this.pred.get(i) ?? []; }

  /** Can control run from the finally block `fe` on to code after its try statement? */
  leaks(fe) {
    const pre = this.nodes[fe].syn;
    for (const [a, b, l] of this.fn.edges) {
      if (isNormal(l) && l !== 'fin-ret' && this.nodes[a].syn.startsWith(pre) && !this.nodes[b].syn.startsWith(pre) && this.nodes[b].k !== 'exit') return true;
    }
    return false;
  }

  reachable() {
    const allsucc = new Map();
    for (const [a, b] of this.fn.edges) {
      if (!allsucc.has(a)) allsucc.set(a, []);
      allsucc.get(a).push(b);
    }
    const seen = new Set([this.fn.entry]);
    const work = [this.fn.entry];
    while (work.length) for (const y of allsucc.get(work.pop()) ?? []) if (!seen.has(y)) { seen.add(y); work.push(y); }
    return seen;
  }

  /** Immediate post-dominators on the normal-edge graph (Cooper-Harvey-Kennedy), virtual exit = -1. */
  postdoms() {
    const nodes = [...this.reach].sort((a, b) => a - b);
    const succ = new Map(nodes.map((i) => [i, this.S(i).map(([j]) => j).filter((j) => this.reach.has(j))]));
    const rev = new Map([[-1, []]]);
    const revOf = (j) => { let a = rev.get(j); if (!a) rev.set(j, (a = [])); return a; };
    for (const i of nodes) {
      if (!succ.get(i).length) revOf(-1).push(i);
      for (const j of succ.get(i)) revOf(j).push(i);
    }
    const order = [];
    const seen = new Set([-1]);
    const stack = [{ x: -1, list: revOf(-1), k: 0 }]; // postorder of the reversed graph from the virtual exit
    while (stack.length) {
      const top = stack[stack.length - 1];
      let pushed = false;
      while (top.k < top.list.length) {
        const y = top.list[top.k++];
        if (!seen.has(y)) { seen.add(y); stack.push({ x: y, list: revOf(y), k: 0 }); pushed = true; break; }
      }
      if (!pushed) { order.push(top.x); stack.pop(); }
    }
    const num = new Map(order.map((x, k) => [x, k]));
    const idom = new Map([[-1, -1]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (let q = order.length - 1; q >= 0; q--) {
        const b = order[q];
        if (b === -1) continue;
        const sb = succ.get(b);
        const ps = (sb.length ? sb : [-1]).filter((s) => idom.has(s));
        if (!ps.length) continue;
        let nw = ps[0];
        for (const s of ps.slice(1)) {
          let a = nw;
          let c = s;
          while (a !== c) {
            while (num.get(a) < num.get(c)) a = idom.get(a);
            while (num.get(c) < num.get(a)) c = idom.get(c);
          }
          nw = a;
        }
        if (idom.get(b) !== nw) { idom.set(b, nw); changed = true; }
      }
    }
    return idom;
  }

  region(start, join) {
    const seen = new Set();
    const work = [start];
    while (work.length) {
      const x = work.pop();
      if (seen.has(x) || x === join || !this.reach.has(x)) continue;
      seen.add(x);
      for (const [j] of this.S(x)) work.push(j);
    }
    return seen;
  }

  /** the terminal class of node i if it is a MAJOR ending, else null */
  termClass(i) {
    if (this._tc.has(i)) return this._tc.get(i);
    const r = this.termClass0(i);
    this._tc.set(i, r);
    return r;
  }

  termClass0(i) {
    const nd = this.nodes[i];
    if (nd.k === 'raise' && !(this.rland.get(i) ?? { escapes: true }).escapes) return null; // handled inside the function: a jump to the handler, not an ending
    const c = nd.k === 'return' || nd.k === 'raise' ? tclass(nd) : this.term.has(i) ? 'X' : null;
    if (c === null) return null;
    if (this.v.major(c)) return c;
    if (nd.k === 'return' && c === 'RV' && this.v.entries.has(this.fn.id)) return rbClass(nd.sig);
    if (nd.k === 'raise' && nd.exc && nd.exc !== '*' && (nd.h ?? null) === null) {
      const F = this.flow;
      const fates = F.neg.hear3(this.fn.id, i, lastDot(nd.exc), 4, 8);
      const hs = fates.filter((f) => f.by === 'handler' && !f.hmay);
      const disp = new Map(hs.map((f) => [f, F.disposition(F.regionEffects(f.fn, f.h)).replace(/~+$/, '')]));
      for (const f of hs) { // someone provably tells someone: a positive claim, hidden callers do not undo it
        if (!f.may && ['respond', 'emit', 'print', 'record'].includes(disp.get(f))) return 'raise-heard:' + c.slice(6); // a handler that only translates tells no one
      }
      const v = F.neg.verdict(this.fn.id, fates);
      if (hs.length && (v || hs.some((f) => disp.get(f) === 'translate'))) {
        // a handler is known on some path, so "no known catcher" would be false; what it does is said as it is
        this.catch.set(i, { value: 'caught', open: v ? v.open : 0, paths_uncaught: v ? v.paths_uncaught : 0, paths: fates.length, why: v ? v.why : [], handlers: hs.length, dispositions: sorted(new Set(disp.values())) });
        return 'raise-caught:' + c.slice(6);
      }
      if (v) { // "nobody catches it" is a claim with three values. proven -> raise-up; anything we cannot close -> raise-open
        this.catch.set(i, v);
        return (v.value === 'proven' ? 'raise-up:' : 'raise-open:') + c.slice(6);
      }
    }
    return null;
  }

  summary(nodeset) {
    const terms = new Set();
    const work = new Set();
    for (const i of nodeset) {
      const c = this.termClass(i);
      if (c) terms.add(c);
      for (const o of this.nodes[i].ops ?? []) {
        if (o.t === 'call') {
          for (const g of o.to ?? []) if (o.how !== 'by-name') work.add(g);
          for (const e of o.eff ?? []) if (WORKEFF.has(e) || e.startsWith('wait') || e.startsWith('ext')) work.add(e);
        }
      }
    }
    return { terms, work, tk: setKey(terms), wk: setKey(work) };
  }

  /** if/elif chain starting at head i -> [[test node, T-arm start]], else-arm start */
  chainOf(i) {
    const arms = [];
    let cur = i;
    for (;;) {
      const t = this.S(cur).find(([, l]) => l === 'T');
      const f = this.S(cur).find(([, l]) => l === 'F');
      arms.push([cur, t ? t[0] : null]);
      const fj = f ? f[0] : null;
      if (fj !== null && this.nodes[fj].k === 'branch' && this.nodes[fj].tk === 'elif' && this.Pr(fj).length === 1 && !this.doesWork(this.nodes[fj])) { cur = fj; continue; }
      return [arms, fj];
    }
  }

  run() {
    const boxed = new Map();
    const chains = new Map();
    const skipped = new Set();
    this.why = new Map();
    for (const i of [...this.reach].sort((a, b) => a - b)) {
      const nd = this.nodes[i];
      const k = nd.k;
      if (k === 'branch' && ['if', 'ternary', 'match', 'elif'].includes(nd.tk)) {
        if (nd.tk === 'elif' && !this.doesWork(nd) && this.Pr(i).some(([p, l]) => l === 'F' && this.nodes[p].k === 'branch')) { skipped.add(i); continue; }
        if (this.trivial(nd)) continue;
        let starts;
        if (nd.tk === 'match') starts = this.S(i).map(([j]) => j);
        else {
          const [arms, els] = this.chainOf(i);
          starts = [...arms.map(([, t]) => t), els];
          chains.set(i, arms);
          for (const [m] of arms.slice(1)) skipped.add(m);
        }
        const J = this.ipdom.has(i) ? this.ipdom.get(i) : -1;
        const sums = starts.map((s) => (s !== null ? this.summary(this.region(s, J)) : EMPTY));
        const L = new Set(sums.map((s) => s.tk));
        const W = sums.filter((s) => s.work.size).map((s) => s.wk);
        const testsWork = (nd.tk === 'match' ? [i] : chains.get(i).map(([m]) => m)).some((m) => this.doesWork(this.nodes[m]));
        if (L.size > 1) { boxed.set(i, 'decision'); this.why.set(i, 'E'); }
        else if (W.length >= 2 && new Set(W).size > 1) { boxed.set(i, 'decision'); this.why.set(i, 'W'); }
        else if (testsWork) { boxed.set(i, 'decision'); this.why.set(i, 'T'); } // the condition itself stores, sends or waits: folding it into a step would hide that there are two ways on
        else if (new Set(sums.map((s) => s.tk + '\u0001' + s.wk)).size > 1) {
          // the arms do different things, and one of them may do nothing (a guard: `if x: store`). Without this a one-armed decision is folded into the step around it.
          boxed.set(i, 'decision');
          this.why.set(i, 'D');
        }
      } else if (k === 'loop') {
        const t0 = this.S(i).find(([, l]) => l === 'T');
        const body = t0 ? t0[0] : null;
        let s = EMPTY;
        let waits = false;
        if (body !== null) {
          const reg = this.region(body, i);
          s = this.summary(reg);
          waits = [...reg].some((j) => this.nodes[j].k === 'block' && this.isWait(this.nodes[j]));
        }
        if (nd.inf || s.terms.size || waits || s.work.size) boxed.set(i, 'loop'); // a loop whose body does work (a call or an effect) is shown
      } else if (k === 'disp') {
        // nothing: a dispatch node only routes
      } else if (k === 'return' || k === 'raise' || this.term.has(i)) {
        if (this.termClass(i)) boxed.set(i, 'end');
      }
      if (!boxed.has(i) && k === 'block' && this.isWait(nd)) boxed.set(i, 'wait');
    }
    // a try is a decision when a handler ends in a major terminal or answers/records/translates
    for (const i of [...this.reach].sort((a, b) => a - b)) {
      if (this.nodes[i].k === 'handler' && !boxed.has(i)) {
        const lab = this.flow.regionEffects(this.fn.id, i);
        const reg = this.nodes.filter((n) => (n.h ?? null) === i && this.reach.has(n.i)).map((n) => n.i);
        const s = this.summary(reg);
        const disp = this.flow.disposition(lab);
        if (s.terms.size || s.work.size || ['respond', 'emit', 'print', 'record', 'translate', 'respond~', 'emit~', 'print~'].includes(disp)) boxed.set(i, 'handler'); // a handler that does work is an exception path worth a box
      }
    }
    this.boxed = boxed;
    this.chains = chains;
    this.skipped = skipped;
    return this;
  }

  /** Does a node's own code do work the map names (an effect, a wait, an outside call)? */
  doesWork(nd) {
    return (nd.ops ?? []).some((o) => o.t === 'call' && (o.eff ?? []).some((e) => WORKEFF.has(e) || e.startsWith('wait') || e.startsWith('ext')));
  }

  isWait(nd) {
    for (const o of nd.ops ?? []) {
      if ((o.eff ?? []).some((e) => e.startsWith('wait'))) return true;
      if ((o.eff ?? []).includes('lockwith') && o.ctx != null && this.flow.blocking.has(`${this.fn.id}\u0000${o.ctx}`)) return true;
    }
    return false;
  }

  trivial(nd) {
    const t = nd.test ?? '';
    return TRIVIAL_TESTS.some((s) => t.includes(s));
  }

  /** The straight runs of leftover nodes that do work: [[nodes], work set]. */
  steps() {
    const interior = [...this.reach].filter((i) => !this.boxed.has(i) && !['entry', 'exit', 'xexit'].includes(this.nodes[i].k));
    const parent = new Map(interior.map((i) => [i, i]));
    // a step is a straight run: two nodes join only along an edge that is the one way out of the first and the one way in to the second.
    // Joining through a shared successor would put two exclusive arms in one box.
    const find = (x) => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)));
        x = parent.get(x);
      }
      return x;
    };
    for (const i of interior) {
      for (const [j] of this.S(i)) if (parent.has(j) && this.S(i).length === 1 && this.Pr(j).length === 1) parent.set(find(i), find(j));
    }
    const comps = new Map();
    for (const i of interior) {
      const r = find(i);
      if (!comps.has(r)) comps.set(r, []);
      comps.get(r).push(i);
    }
    const out = [];
    for (const c of comps.values()) {
      c.sort((a, b) => a - b);
      const w = this.summary(c).work;
      if (w.size) out.push([c, w]);
    }
    return out.sort((a, b) => a[0][0] - b[0][0]);
  }
}
