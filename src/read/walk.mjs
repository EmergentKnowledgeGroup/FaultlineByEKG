// The walker. It follows one run through the code from an outside trigger: across calls into the callee and back, into a function value that
// a call passes on, never into an error or handler arm, one consistent arm per decision. Where a call is not followed it says so, with the reason.
import { cmp, squash, uniq } from './util.mjs';
import { paramNames, tailName } from './callsites.mjs';
import { loopOverLiteral, endSiteLabel } from './words.mjs';
import { armEnd, deriveStructure, LEAVES_FUNCTION, LEAVES_BODY } from './structure.mjs';
import { makePlan, RAISE_PENALTY, SITE_WEIGHT } from './plan.mjs';

// Limits. Each is a stop that keeps one journey readable and bounded; none depends on the system being read.
export const MAX_DEPTH = 14;       // calls deep (a wrapper that only runs the function it is given does not count): past this a call is shown but not entered
export const MAX_NODES = 20000;     // boxes and calls collected for one journey; each call gets a fair share of what is left, so a late call is not starved by an early one
export const SIBLING_RESERVE = 60;      // boxes kept back for each call still to come in the same function, so an early call cannot use up the journey
export const MIN_SHARE = 4;           // a call that would get fewer boxes than this is shown but not entered
export const MAX_CHOICES = 3;        // possible targets of one call that are followed (the rest are counted)
export const ENDING_BONUS = 10000;   // an arm from which a run can still reach a real ending beats one from which it cannot, whatever else they hold
export const REACH_CAP = 400;      // boxes counted when comparing two arms (more than this is "plenty")

const NOISE_EFFECTS = new Set(['print', 'log']);

/** Truth the journey has already committed to: `this.x` facts are shared by the whole journey, other names belong to one function run. */
class Truth {
  constructor() {
    this.shared = new Map();
    this.local = [new Map()];
  }

  push() {
    this.local.push(new Map());
  }

  pop() {
    this.local.pop();
  }

  _map(atom) {
    return /^(?:this|self)\./.test(atom) ? this.shared : this.local[this.local.length - 1];
  }

  /** {mode:'and'|'or', lits:[{atom, neg}]} for a test, or null when the test is not a plain combination of names. */
  static parse(test) {
    let t = squash(test);
    while (/^\(.*\)$/.test(t) && balanced(t.slice(1, -1))) t = t.slice(1, -1).trim();
    const hasAnd = splitTop(t, /&&|\band\b/).length > 1;
    const hasOr = splitTop(t, /\|\||\bor\b/).length > 1;
    if (hasAnd && hasOr) return null;
    const parts = hasAnd ? splitTop(t, /&&|\band\b/) : hasOr ? splitTop(t, /\|\||\bor\b/) : [t];
    const lits = [];
    for (let p of parts) {
      p = p.trim();
      let neg = false;
      for (;;) {
        const m = /^(?:!|not\s+)\s*(.*)$/.exec(p);
        if (!m) break;
        neg = !neg;
        p = m[1].trim();
        if (/^\(.*\)$/.test(p) && balanced(p.slice(1, -1))) p = p.slice(1, -1).trim();
      }
      if (!/^[A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*)*$/.test(p)) return null;
      lits.push({ atom: p.replace(/\?\./g, '.'), neg });
    }
    return { mode: hasOr ? 'or' : 'and', lits };
  }

  value(lit) {
    const v = this._map(lit.atom).get(lit.atom);
    return v === undefined ? undefined : lit.neg ? !v : v;
  }

  /** A test of one name against one literal ("mode == 'a'"): {atom, op:'eq'|'ne', lit} or null. */
  static parseEq(test) {
    let t = squash(test);
    while (/^\(.*\)$/.test(t) && balanced(t.slice(1, -1))) t = t.slice(1, -1).trim();
    const m = /^([A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*)*)\s*(===?|!==?)\s*(["'][^"']*["']|-?[\w.]+)$/.exec(t);
    return m ? { atom: m[1].replace(/\?\./g, '.'), op: m[2].startsWith('!') ? 'ne' : 'eq', lit: m[3] } : null;
  }

  /** 'then' or 'else' when earlier choices decide this test, else null. */
  forced(test) {
    const q = Truth.parseEq(test);
    if (q) {
      const known = this._map(q.atom).get(`=${q.atom}`);
      if (known !== undefined) return (known === q.lit) === (q.op === 'eq') ? 'then' : 'else';
      return null;
    }
    const p = Truth.parse(test);
    if (!p) return null;
    const vals = p.lits.map((l) => this.value(l));
    if (p.mode === 'and') {
      if (vals.some((v) => v === false)) return 'else';
      if (vals.every((v) => v === true)) return 'then';
    } else {
      if (vals.some((v) => v === true)) return 'then';
      if (vals.every((v) => v === false)) return 'else';
    }
    return null;
  }

  assume(test, arm) {
    const q = Truth.parseEq(test);
    if (q) {
      // an equality that holds fixes the name to that literal for every later test of the same name
      if ((arm === 'then') === (q.op === 'eq')) this._map(q.atom).set(`=${q.atom}`, q.lit);
      return;
    }
    const p = Truth.parse(test);
    if (!p) return;
    const set = (l, v) => this._map(l.atom).set(l.atom, l.neg ? !v : v);
    if (arm === 'then' && p.mode === 'and') p.lits.forEach((l) => set(l, true));
    else if (arm === 'else' && p.mode === 'or') p.lits.forEach((l) => set(l, false));
    else if (p.lits.length === 1) set(p.lits[0], arm === 'then');
  }
}

function balanced(s) {
  let d = 0;
  for (const c of s) {
    if (c === '(') d++;
    else if (c === ')' && --d < 0) return false;
  }
  return d === 0;
}

function splitTop(s, re) {
  const out = [];
  let depth = 0;
  let last = 0;
  const g = new RegExp(re.source, 'g');
  let m;
  while ((m = g.exec(s))) {
    depth = 0;
    for (let i = 0; i < m.index; i++) {
      if ('([{'.includes(s[i])) depth++;
      else if (')]}'.includes(s[i])) depth--;
    }
    if (depth === 0) {
      out.push(s.slice(last, m.index));
      last = m.index + m[0].length;
    }
  }
  out.push(s.slice(last));
  return out;
}

/** Identity of a visit: the function (or function value) plus the function values handed to it, so a wrapper called with a different callback is read again. */
export function unitKey(unit) {
  const base = unit.lambda !== undefined ? `${unit.fid}#${unit.lambda}` : unit.fid;
  if (!unit.passed || !unit.passed.size) return base;
  const ids = [...unit.passed.values()].map((v) => v.fn ?? `${v.lambda.parent}#${v.lambda.index}`).sort(cmp);
  return `${base}>${ids.join(',')}`;
}

/**
 * Some scanners record an if / elif / else chain as separate records that share an end line, the head's `else` holding only the last arm.
 * Make each record's `else` cover the rest of its chain, as it does in a record that nests its elif: one arm taken kills all the others.
 */
export function linkChains(branches) {
  const heads = branches.filter((b) => b.kind === 'if' || b.kind === 'elif');
  for (let i = 0; i < heads.length; i++) {
    const e = heads[i];
    if (e.kind !== 'elif') continue;
    let p = null;
    for (let j = i - 1; j >= 0; j--) {
      if (heads[j].end === e.end && heads[j].line < e.line) {
        p = heads[j];
        break;
      }
    }
    if (!p || (p.else && e.line >= p.else[0] && e.line <= p.else[1])) continue;
    // the last arm (a plain else) belongs to the end of the chain: move it from the head to this elif
    const tail = p.else ?? null;
    p.else = [e.line, p.end];
    p.et = 'elif';
    if (tail && !e.else) e.else = tail;
  }
  return branches;
}

export class Walker {
  /**
   * @param {{W:object, CM:import('./callsites.mjs').CallModel, names:object, words:Map<string,object>, ends:Map<string,object>}} deps
   */
  constructor({ W, CM, names, words, ends }) {
    Object.assign(this, { W, CM, names, words, ends });
    this._reach = new Map();
    this._arms = new Map();
  }

  // ---- structure of one function ---------------------------------------------------------------------------------
  isHandlerBox(b) {
    return b.prov.rule === 'handler';
  }

  /** Boxes reached from a box by roads inside the function that are not error roads (loop back-edges excluded). */
  reach(boxId) {
    if (this._reach.has(boxId)) return this._reach.get(boxId);
    const W = this.W;
    const seen = new Set([boxId]);
    const stack = [boxId];
    let calls = 0;
    let n = 0;
    while (stack.length && n < REACH_CAP) {
      const x = stack.pop();
      n++;
      calls += W.crossOut(x).length;
      for (const r of W.cfgOut(x)) {
        if (!seen.has(r.to) && !this.isHandlerBox(W.boxes.get(r.to))) {
          seen.add(r.to);
          stack.push(r.to);
        }
      }
    }
    const v = { boxes: seen.size, calls };
    this._reach.set(boxId, v);
    return v;
  }

  /** The scanner's block records for a function (branches and loops), or the same read from the source when the scanner gave none. */
  struct(fid, lam = -1) {
    if (!this._struct) this._struct = new Map();
    const sk = `${fid}#${lam}`;
    if (this._struct.has(sk)) return this._struct.get(sk);
    const { W, CM } = this;
    const f = W.fns.get(fid);
    const L = lam >= 0 ? CM.unit(fid).lambdas[lam] : null;
    const reg = L ? { from: L.arg.startLine, to: L.arg.endLine } : CM.region(fid);
    const owner = CM.factsOf(fid) ?? this._ownerFacts(fid);
    let branches;
    let loops;
    if (owner && Array.isArray(owner.branches)) {
      branches = owner.branches;
      loops = owner.loops ?? [];
    } else {
      const d = f && reg.to ? deriveStructure(W.source, f.path, reg.from, reg.to, f.lang) : { branches: [], loops: [] };
      branches = d.branches;
      loops = d.loops;
    }
    // only this function's own lines: not what a mapped function nested inside it (a callback, an inner function) holds
    const kids = (f?.children ?? []).map((c) => W.fns.get(c)).filter((c) => c?.mapped && c.line && CM.region(c.id).known).map((c) => CM.region(c.id));
    // A Python lambda holds an expression and never a statement, so every branch on its lines is the function's own. In other languages a function value can hold
    // statements: a branch on the line where it starts belongs to the function only when it carries on past the end of the value (`if (xs.some((x) => x.ok)) {` ...).
    const lams = f?.lang === 'py' ? [] : CM.unit(fid).lambdas.filter((x) => (lam < 0 ? true : x.parent === lam)).map((x) => [x.arg.startLine, x.arg.endLine]);
    const inLam = (r) => lams.some((v) => r.line >= v[0] && r.line <= v[1] && !(r.line === v[0] && (r.end ?? r.line) > v[1]));
    const own = (r) => r.line >= reg.from && r.line <= reg.to && !kids.some((k) => r.line >= k.from && r.line <= k.to) && !inLam(r);
    const out = { branches: linkChains(branches.filter(own).map((b) => ({ ...b })).sort((a, b) => a.line - b.line || b.end - a.end)), loops: loops.filter(own) };
    this._struct.set(sk, out);
    return out;
  }

  branchesOf(fid, lam = -1) {
    return this.struct(fid, lam).branches;
  }

  loopsOf(fid, lam = -1) {
    return this.struct(fid, lam).loops;
  }

  /** True when a line is inside the handlers of a try (what runs only when something failed). */
  inHandlers(fid, line) {
    return this.branchesOf(fid).some((b) => b.kind === 'try' && b.else && line >= b.else[0] && line <= b.else[1]);
  }

  /** The box a call into a function lands on, unless that box sits in a handler: then the function's first box outside the handlers, or none. */
  entryOf(fid) {
    const id = this.W.entryBox(fid);
    const b = id ? this.W.boxes.get(id) : null;
    if (!b || !this.inHandlers(fid, b.prov.line)) return id;
    const alt = this.W.fns.get(fid).boxes.find((x) => x.prov.rule !== 'handler' && !this.inHandlers(fid, x.prov.line));
    return alt ? alt.id : null;
  }

  /**
   * How an arm of a branch ends ('return', 'raise', 'break', 'continue', 'exit' or 'other'): read from the source; the scanner's word is used
   * when the source reading finds nothing (an arm that starts in the middle of a test written over several lines).
   */
  endOfArm(fid, br, side) {
    const range = side === 'then' ? br.then : br.else;
    if (!range || (side === 'else' && br.et === 'elif')) return 'other';
    const path = this.W.fns.get(fid)?.path ?? '';
    const k = armEnd(this.W.source, path, range);
    const given = side === 'then' ? br.tt : br.et;
    return k === 'other' && (LEAVES_FUNCTION.has(given) || LEAVES_BODY.has(given)) ? given : k;
  }

  /**
   * True when the code that follows lines from..to (a check with nothing after it that is drawn) goes on to leave the function: the nearest
   * block around it ends in a return or a raise, before any loop around it ends.
   */
  leavesAfter(fid, from, to) {
    const { branches, loops } = this.struct(fid);
    const around = [];
    for (const br of branches) {
      if (br.kind === 'ternary' || br.kind === 'try') continue;
      for (const side of ['then', 'else']) {
        const r = side === 'then' ? br.then : br.else;
        if (r && r[0] <= from && to <= r[1] && !(br.line >= from && br.line <= to)) around.push({ size: r[1] - r[0], br, side });
      }
    }
    for (const l of loops) if (l.line < from && to <= l.end) around.push({ size: l.end - l.line, loop: true });
    around.sort((a, b) => a.size - b.size);
    for (const a of around) {
      if (a.loop) return false;
      const k = this.endOfArm(fid, a.br, a.side);
      if (LEAVES_FUNCTION.has(k)) return true;
      if (LEAVES_BODY.has(k)) return false;
    }
    return false;
  }

  /** The branch record a decision box stands for, or null. */
  branchAt(box) {
    return this.branchesOf(box.prov.fn).find((b) => b.line === box.prov.line && b.kind !== 'ternary' && b.kind !== 'try') ?? null;
  }

  /** Line ranges of the two arms of a decision, and how each ends, or null. A loop gives its body. */
  armInfo(box) {
    if (this._arms.has(box.id)) return this._arms.get(box.id);
    let info = null;
    const br = this.branchAt(box);
    const path = this.W.fns.get(box.prov.fn)?.path ?? '';
    if (br) {
      info = { kind: br.kind, then: br.then ?? null, else: br.else ?? null, end: br.end, thenEnd: this.endOfArm(box.prov.fn, br, 'then'), elseEnd: this.endOfArm(box.prov.fn, br, 'else') };
    } else {
      const lp = this.loopsOf(box.prov.fn).find((l) => l.line === box.prov.line);
      if (lp) info = { kind: 'loop', body: [box.prov.line, lp.end], end: lp.end };
    }
    this._arms.set(box.id, info);
    return info;
  }

  _ownerFacts(fid) {
    for (let p = this.W.fns.get(fid)?.parent; p; p = this.W.fns.get(p)?.parent) {
      const o = this.CM.factsOf(p);
      if (o) return o;
    }
    return null;
  }

  /** Lines of the calls and of the boxes of a function's own code, so two arms can be weighed. */
  _weighData(fid, lam = -1) {
    if (!this._wd) this._wd = new Map();
    const k = `${fid}#${lam}`;
    if (!this._wd.has(k)) {
      const f = this.W.fns.get(fid);
      this._wd.set(k, {
        sites: this.CM.unit(fid).sites.filter((s) => s.lambda === lam).map((s) => s.line),
        boxes: lam >= 0 ? [] : (f?.boxes ?? []).filter((b) => b.prov.rule !== 'handler' && b.kind !== 'end').map((b) => b.prov.line),
      });
    }
    return this._wd.get(k);
  }

  /** How much a run does inside a range of lines: calls count more than boxes. */
  weigh(fid, range, lam = -1) {
    if (!range) return 0;
    const d = this._weighData(fid, lam);
    return d.sites.filter((l) => l >= range[0] && l <= range[1]).length * SITE_WEIGHT + d.boxes.filter((l) => l >= range[0] && l <= range[1]).length;
  }

  /**
   * The arm a run takes at a branch, judged from the code alone: where the path already is, then a test already decided, then the arm
   * that does more work. An arm that leaves the function or the loop body is worth only what is inside it; the other arm is worth what is inside
   * it plus everything that follows the branch. An arm that raises is worth less than any other.
   */
  pickArm(fid, br, ctx, pathLines = [], lam = -1) {
    const { W } = this;
    const path = W.fns.get(fid)?.path ?? '';
    const T = br.then ?? null;
    const E = br.else ?? null;
    const inR = (r, l) => !!r && l >= r[0] && l <= r[1];
    const inT = pathLines.some((l) => inR(T, l));
    const inE = pathLines.some((l) => inR(E, l));
    if (inT && !inE) return 'then';
    if (inE && !inT) return 'else';
    const test = W.source.condition(path, br.line)?.text ?? br.test ?? '';
    const forced = ctx.truth.forced(test);
    if (forced) return forced;
    const L = lam >= 0 ? this.CM.unit(fid).lambdas[lam] : null;
    const reg = L ? { to: L.arg.endLine } : this.CM.region(fid);
    const tEnd = this.endOfArm(fid, br, 'then');
    const eEnd = this.endOfArm(fid, br, 'else');
    const leaves = (k) => LEAVES_FUNCTION.has(k) || LEAVES_BODY.has(k);
    // a run that goes on to a box after this branch cannot have left the function inside it
    const goesOn = pathLines.some((l) => l > br.end);
    const stays = (k) => !(goesOn && LEAVES_FUNCTION.has(k));
    if (!stays(tEnd) && stays(eEnd)) return 'else';
    if (!stays(eEnd) && stays(tEnd)) return 'then';
    const rest = this.weigh(fid, [br.end + 1, reg.to || br.end + 1], lam);
    const score = (range, end) => this.weigh(fid, range, lam) + (leaves(end) ? 0 : rest) - (end === 'raise' ? RAISE_PENALTY : 0);
    return score(T, tEnd) >= score(E, eEnd) ? 'then' : 'else';
  }

  // ---- choosing the boxes one run goes through -------------------------------------------------------------------
  /** Pick the arm a run takes at a decision: earlier choices first, then the arm that does more work and does not end in a failure. */
  chooseArm(box, outs, ctx, forceThen) {
    const test = box.detail ?? box.title;
    const thenR = outs.find((r) => r.when !== 'else');
    const elseR = outs.find((r) => r.when === 'else');
    if (forceThen && thenR) return { road: thenR, why: 'entered at this test' };
    const f = ctx.truth.forced(this.fullTest(box)) ?? this.eqChoice(box);
    if (f === 'then' && thenR) return { road: thenR, why: 'same test already decided' };
    if (f === 'else' && elseR) return { road: elseR, why: 'same test already decided' };
    const scored = outs.map((r) => {
      const t = this.W.boxes.get(r.to);
      let score;
      if (t.kind === 'end') {
        const e = this.ends.get(t.id);
        score = e && (e.outcome === 'failure' || e.outcome === 'refusal') ? -1e6 : e?.outcome === 'neutral' ? -2 : 0;
      } else {
        const rc = this.reach(t.id);
        score = rc.boxes + 4 * Math.max(rc.calls, this.sitesInArm(box, r)) + (this.reachesEnding(t.id) ? ENDING_BONUS : 0);
      }
      return { r, t, score };
    });
    scored.sort((a, b) => b.score - a.score || a.t.prov.line - b.t.prov.line || cmp(a.t.id, b.t.id));
    return { road: scored[0].r, why: 'the arm that carries on' };
  }

  /** True when an ending that fails or refuses is written only inside arms of branches, handlers or loops: a run can go past it. */
  isGuardExit(b) {
    const e = this.ends.get(b.id);
    if (!e || (e.outcome !== 'failure' && e.outcome !== 'refusal')) return false;
    const sites = b.prov.sites?.length ? b.prov.sites : [b.prov.line];
    const { branches, loops } = this.struct(b.prov.fn);
    const inR = (r, l) => !!r && l >= r[0] && l <= r[1];
    return sites.every((l) => branches.some((x) => x.kind !== 'ternary' && ((x.kind !== 'try' && inR(x.then, l)) || inR(x.else, l))) || loops.some((x) => l >= x.line && l <= x.end)) && branches.length + loops.length > 0;
  }

  /** True when a run from this box can reach an ending that is not a failure or a refusal, by roads inside the function that are not error roads. */
  reachesEnding(boxId) {
    if (!this._endReach) this._endReach = new Map();
    if (this._endReach.has(boxId)) return this._endReach.get(boxId);
    const W = this.W;
    const seen = new Set([boxId]);
    const stack = [boxId];
    let found = false;
    while (stack.length && !found) {
      const x = stack.pop();
      const b = W.boxes.get(x);
      if (b.kind === 'end') {
        const e = this.ends.get(x);
        if (!(e && (e.outcome === 'failure' || e.outcome === 'refusal'))) found = true;
        continue;
      }
      for (const r of W.cfgOut(x)) {
        const t = W.boxes.get(r.to);
        if (t && !seen.has(r.to) && t.prov.fn === b.prov.fn && !this.isHandlerBox(t)) {
          seen.add(r.to);
          stack.push(r.to);
        }
      }
    }
    this._endReach.set(boxId, found);
    return found;
  }

  /** Calls whose lines fall inside the arm of a decision that this road starts (0 when the arm's lines are not known). */
  sitesInArm(box, road) {
    const arms = this.armInfo(box);
    const range = arms ? (road.when === 'else' ? arms.else : arms.then) : null;
    if (!range) return 0;
    return this.CM.unit(box.prov.fn).sites.filter((s) => s.line >= range[0] && s.line <= range[1] && s.lambda === -1).length;
  }

  /**
   * A dispatch by equality ("command == 'a'", "command == 'b'", ...) is a choice of one arm among several: the arm that does the most work
   * is the one a run takes, and the other tests are then false. Returns 'then' or 'else' for a test in such a set, else null.
   */
  eqChoice(box) {
    const q = Truth.parseEq(this.fullTest(box));
    if (!q || q.op !== 'eq') return null;
    const fid = box.prov.fn;
    const sibs = this.W.fns.get(fid).boxes.filter((b) => b.kind === 'decision' && b.prov.rule !== 'loop' && Truth.parseEq(this.fullTest(b))?.atom === q.atom && Truth.parseEq(this.fullTest(b))?.op === 'eq');
    if (sibs.length < 2) return null;
    const sites = this.CM.unit(fid).sites.filter((x) => x.lambda === -1);
    const boxes = this.W.fns.get(fid).boxes.filter((b) => b.prov.rule !== 'handler');
    const weight = (b) => {
      const r = this.armInfo(b)?.then;
      if (!r) return -1;
      return sites.filter((x) => x.line >= r[0] && x.line <= r[1]).length * 4 + boxes.filter((x) => x.prov.line >= r[0] && x.prov.line <= r[1]).length;
    };
    let best = null;
    let bw = -2;
    for (const b of sibs) {
      const w = weight(b);
      if (w > bw) {
        bw = w;
        best = b;
      }
    }
    return best && bw >= 0 ? (best.id === box.id ? 'then' : 'else') : null;
  }

  /** Pick the arm of a decision whose roads the tool folded away, from the calls and boxes on the lines of each arm. */
  armBySource(box, ctx, forceThen) {
    if (forceThen) return 'then';
    const forced = ctx.truth.forced(this.fullTest(box)) ?? this.eqChoice(box);
    if (forced) return forced;
    const br = this.branchAt(box);
    return br ? this.pickArm(box.prov.fn, br, ctx) : 'then';
  }

  /** Which arm of a decision a road starts, judged by where the road lands (inside the then-lines, inside the else-lines, or past the statement). */
  armOfRoad(box, road) {
    const arms = this.armInfo(box);
    const t = this.W.boxes.get(road.to);
    if (arms?.then && t && t.prov.fn === box.prov.fn) {
      const lines = [t.prov.line, ...(t.prov.sites ?? [])];
      if (lines.some((l) => l >= arms.then[0] && l <= arms.then[1])) return 'then';
      if (arms.else && lines.some((l) => l >= arms.else[0] && l <= arms.else[1])) return 'else';
      if (lines.every((l) => l > (arms.end ?? arms.then[1]))) return 'else';
    }
    return road.when === 'else' ? 'else' : 'then';
  }

  /** True when a run that skips the arm a road starts still has something to do: work in the other arm or after the whole statement. */
  hasContentBeyond(box, roadArm) {
    const arms = this.armInfo(box);
    if (!arms?.then) return false;
    const other = roadArm === 'then' ? arms.else : arms.then;
    const reg = this.CM.region(box.prov.fn);
    return this.weigh(box.prov.fn, other) + this.weigh(box.prov.fn, [arms.end + 1, reg.to || arms.end + 1]) > 0;
  }

  fullTest(box) {
    return this.words.get(box.id)?.full ?? box.detail ?? box.title;
  }

  /**
   * The boxes one run goes through inside a function, starting at `startId`.
   * A decision whose only road leads to an ending is a check: the run goes past it, down the arm that has no box, unless that arm has nothing in it.
   * @returns {{entries: object[], ended: object|null, stuck: string}}
   */
  choosePath(fid, startId, ctx, forceThen) {
    const W = this.W;
    const entries = [];
    const seen = new Set();
    const pending = [];
    let cur = startId;
    let ended = null;
    let stuck = '';
    let first = true;
    while (cur) {
      if (seen.has(cur)) {
        cur = pending.pop() ?? null;
        continue;
      }
      seen.add(cur);
      const b = W.boxes.get(cur);
      if (!b || b.prov.fn !== fid) {
        cur = pending.pop() ?? null;
        continue;
      }
      if (this.isHandlerBox(b)) {
        if (first) stuck = 'its own steps are only error handling';
        cur = pending.pop() ?? null;
        continue;
      }
      if (b.kind === 'end' && this.isGuardExit(b)) {
        // an exit that only some arm of a branch takes is not where the function goes: the run goes past it
        cur = pending.pop() ?? null;
        continue;
      }
      first = false;
      const entry = { box: b, taken: null, others: [], why: '' };
      entries.push(entry);
      if (b.kind === 'end') {
        ended = b;
        break;
      }
      const firstEntry = entries.length === 1;
      const outs = W.cfgOut(b.id).filter((r) => !this.isHandlerBox(W.boxes.get(r.to)) && W.boxes.get(r.to)?.prov.fn === fid);
      const isTest = b.kind === 'decision' && b.prov.rule !== 'loop';
      if (!outs.length) {
        if (isTest && this.armInfo(b)?.then) {
          entry.arm = this.armBySource(b, ctx, forceThen && firstEntry);
          ctx.truth.assume(this.fullTest(b), entry.arm);
          entry.why = 'chosen from the lines of each arm';
          const arms = this.armInfo(b);
          if (LEAVES_FUNCTION.has(entry.arm === 'then' ? arms.thenEnd : arms.elseEnd)) break;
        }
        if (this.leavesAfter(fid, b.prov.line, this.armInfo(b)?.end ?? b.prov.line)) break;
        cur = pending.pop() ?? null;
        continue;
      }
      if (b.prov.rule === 'loop') {
        const body = outs.find((r) => r.when === 'each item') ?? outs[0];
        const exits = outs.filter((r) => r !== body);
        if (exits.length) pending.push(exits[0].to);
        entry.taken = body;
        entry.others = exits;
        entry.why = 'enters the loop body';
        cur = body.to;
        continue;
      }
      if (outs.length === 1) {
        const only = outs[0];
        const t = W.boxes.get(only.to);
        if (isTest && t.kind === 'end' && !(forceThen && firstEntry)) {
          const roadArm = this.armOfRoad(b, only);
          const e = this.ends.get(t.id);
          const failing = !!e && (e.outcome === 'failure' || e.outcome === 'refusal');
          if (failing || this.hasContentBeyond(b, roadArm)) {
            entry.arm = roadArm === 'then' ? 'else' : 'then';
            entry.others = [only];
            entry.why = 'a check: the run goes past it';
            ctx.truth.assume(this.fullTest(b), entry.arm);
            if (this.leavesAfter(fid, b.prov.line, this.armInfo(b)?.end ?? b.prov.line)) break;
            cur = pending.pop() ?? null;
            continue;
          }
        }
        entry.taken = only;
        if (isTest) entry.arm = this.armOfRoad(b, only);
        cur = only.to;
        continue;
      }
      const pick = this.chooseArm(b, outs, ctx, forceThen && firstEntry);
      entry.arm = this.armOfRoad(b, pick.road);
      entry.taken = pick.road;
      entry.others = outs.filter((r) => r !== pick.road);
      entry.why = pick.why;
      ctx.truth.assume(this.fullTest(b), pick.road.when === 'else' ? 'else' : 'then');
      cur = pick.road.to;
    }
    return { entries, ended, stuck };
  }

  // ---- one run through a unit ---------------------------------------------------------------------------------------
  /**
   * Visit a unit: a mapped function (boxes and calls), an unmapped function (calls only) or an unmapped function value (its calls only).
   * `u` = {fid, lambda?: index, startBox?, forceThen?, via, passed?}. Returns a visit {fid, label, via, items, ...}.
   */
  visit(u, ctx, depth) {
    const budget = u.budget ?? MAX_NODES;
    let used = 0;
    const { W, CM } = this;
    const fid = u.fid;
    const f = W.fns.get(fid);
    const key = unitKey(u);
    const label = u.label ?? this.names.label(fid);
    const lamLine = u.lambda !== undefined ? CM.unit(fid).lambdas[u.lambda]?.arg.startLine : 0;
    const visit = { fid, key, label, via: u.via, depth, items: [], path: f?.path ?? '', line: lamLine || (f?.line ?? 0), mapped: !!f?.mapped && u.lambda === undefined, stuck: '' };
    ctx.seen.add(key);
    ctx.stack.add(fid);
    ctx.keys.add(key);
    ctx.truth.push();
    const unit = CM.unit(fid);
    let sites = unit.sites.filter((s) => s.lambda === (u.lambda ?? -1));
    // function values handed to this unit: they run where the unit calls its parameter
    const invoked = new Set();
    for (const [name, value] of u.passed ?? []) {
      const invs = this.findInvocations(fid, u.lambda, name);
      for (const inv of invs) sites.push({ line: inv.line, off: inv.off, callee: null, value, source: 'function value', tier: 'passed', kind: 'call', paramName: name });
      if (invs.length) invoked.add(name);
      else if (!sites.some((s) => s.fnArgs?.some((a) => a.kind === 'ref' && a.text === name)) && !this.mentions(fid, name)) visit.items.push({ t: 'note', text: `gets a function ("${name}") that this code does not call directly` });
    }
    let boxEntries = [];
    let plan = null;
    let ended = null;
    const onPath = new Set();
    const lam = u.lambda ?? -1;
    {
      if (f?.mapped && lam < 0 && f.boxes.length) {
        const at = u.startBox ? W.boxes.get(u.startBox) : null;
        const startId = at && !this.inHandlers(fid, at.prov.line) ? u.startBox : this.entryOf(fid);
        const p = this.choosePath(fid, startId, ctx, u.forceThen);
        boxEntries = p.entries;
        ended = p.ended;
        visit.stuck = p.stuck || (startId ? '' : 'its own steps are only error handling');
        for (const e of boxEntries) onPath.add(e.box.id);
        plan = makePlan({ wk: this, ctx, fid, lam, entries: boxEntries, ended, boxes: f.boxes });
        // a landing box is the place a road arrives at, in a function that decides nothing and does no named work; it is not a step of the story
        boxEntries = boxEntries.filter((e) => e.box === ended || (plan.live(e.box.prov.line) && !e.box.prov.landing));
        if (ended) {
          // the run stops at the end of the ending's own statement
          const ex = W.source.exitExpr(f.path, plan.endSite);
          plan.setStop(ex?.endLine ?? plan.endSite);
          visit.ended = { box: ended.id, site: plan.endSite };
        }
      } else plan = makePlan({ wk: this, ctx, fid, lam, entries: [], ended: null, boxes: lam >= 0 ? [] : f?.boxes ?? [] });
      sites = sites.filter((s) => plan.live(s.line) && !(s.source === 'map' && s.fromBox && f?.mapped && f.boxes.length && !onPath.has(s.fromBox)));
      for (const n of plan.notes) sites.push({ source: 'note', tier: 'note', kind: 'note', line: n.line, off: -1, text: n.text });
    }
    {
      const seenInv = new Set();
      sites = sites.sort((a, b) => a.line - b.line).filter((s) => {
        if (s.source !== 'function value') return true;
        if (seenInv.has(s.paramName)) return false;
        seenInv.add(s.paramName);
        return true;
      });
    }
    // several possible targets on one line become one choice (every option is shown, none is picked)
    const grouped = [];
    const choices = new Map();
    for (const s of sites) {
      if (s.tier !== 'may') {
        grouped.push(s);
        continue;
      }
      const k = `${s.line}|${tailName(s.callee)}`;
      if (!choices.has(k)) {
        const c = { line: s.line, off: s.off, source: 'choice', tier: 'choice', kind: 'call', alts: [], name: tailName(s.callee) };
        choices.set(k, c);
        grouped.push(c);
      }
      choices.get(k).alts.push(s);
    }
    sites = grouped;
    // merge boxes and sites in the order they run
    const pend = [...sites].sort((a, b) => a.line - b.line || (a.off ?? 0) - (b.off ?? 0));
    let halted = false;
    const emitSites = (limitLine, inclusive) => {
      while (!halted && pend.length && (inclusive ? pend[0].line <= limitLine : pend[0].line < limitLine)) {
        const share = Math.max(0, budget - used - pend.length * SIBLING_RESERVE);
        used += this.descend(pend.shift(), fid, u, visit, ctx, depth, share);
        const last = visit.items[visit.items.length - 1];
        if (last?.t === 'visit' && last.visit.raises) halted = true;   // a call that always raises ends this run too
      }
    };
    for (const e of boxEntries) {
      if (halted) break;
      const isEnd = e.box === ended;
      if (isEnd) emitSites(plan.stop, true);   // the calls inside a return or raise run before it
      else if (e.box.kind === 'decision') emitSites(Math.max(e.box.prov.line, W.source.condition(f.path, e.box.prov.line)?.endLine ?? 0), true);   // the calls inside the test run before the test is decided
      else emitSites(e.box.prov.line, false);
      if (halted) break;
      visit.items.push(this.boxItem(e, isEnd ? plan.endSite : null));
      used += 1;
    }
    if (!halted) emitSites(Infinity, true);
    if (halted) visit.raises = true;
    else if (ended && visit.ended) {
      const st = this.ends.get(ended.id)?.sites.find((x) => x.line === visit.ended.site);
      visit.raises = st?.kind === 'raise' || st?.kind === 'throw';
    }
    ctx.truth.pop();
    ctx.stack.delete(fid);
    ctx.keys.delete(key);
    ctx.nodes += used;
    visit.used = used;
    return visit;
  }

  boxItem(e, endSite) {
    const w = this.words.get(e.box.id) ?? { title: e.box.title, plain: '', raw: e.box.title };
    const item = { t: 'box', box: e.box.id, kind: e.box.kind, rule: e.box.prov.rule, line: e.box.prov.line, title: w.title, plain: w.plain, raw: w.raw };
    if (e.box.kind === 'end') {
      const rec = this.ends.get(e.box.id);
      item.end = rec?.outcome ?? '';
      const st = endSite != null ? rec?.sites.find((x) => x.line === endSite) : null;
      if (st && rec.sites.length > 1) {
        // a shared ending box: this run's own ending is the site on its route
        const l = endSiteLabel(rec, st);
        item.title = l.t;
        item.plain = l.p;
        item.line = st.line;
        item.end = st.outcome;
        item.shared = rec.sites.length;
      } else if (st) item.line = st.line;
    }
    if (e.others.length && (e.taken || e.arm)) {
      const yes = e.box.kind === 'decision' && e.box.prov.rule !== 'loop';
      item.took = yes ? (e.arm === 'else' ? 'no' : 'yes') : 'into the loop';
      item.notTaken = e.others.map((r) => ({ when: yes ? (r.when === 'else' ? 'no' : 'yes') : 'after the loop', to: this.words.get(r.to)?.title ?? '' })).slice(0, 2);
    }
    if (!item.took && e.arm && e.box.kind === 'decision' && e.box.prov.rule !== 'loop') item.took = e.arm === 'else' ? 'no' : 'yes';
    const eff = (e.box.prov.effects ?? []).filter((x) => !NOISE_EFFECTS.has(x.replace(/^maybe:/, '')));
    if (eff.length && !eff.every((x) => x.startsWith('maybe:'))) item.work = true;
    if (e.box.prov.rule === 'loop' && loopOverLiteral(e.box)) item.literalLoop = true;
    if (this.words.get(e.box.id)?.pure) item.pure = true;
    return item;
  }

  /** True when `name` is written anywhere in the body of a function other than its signature (the function value is passed on or kept). */
  mentions(fid, name) {
    const f = this.W.fns.get(fid);
    const reg = this.CM.region(fid);
    const ft = f && reg.to ? this.W.source.file(f.path) : null;
    if (!ft) return false;
    const sig = this.W.source.signature(f.path, f.line);
    const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
    for (let n = Math.max(reg.from, (sig ? sig.endLine : f.line) + 1); n <= reg.to; n++) {
      if (re.test(ft.mask.slice(ft.offset(n), n < ft.lineCount ? ft.offset(n + 1) : ft.text.length))) return true;
    }
    return false;
  }

  /** Every place `name` is called inside a unit: [{line, off}] in source order. */
  findInvocations(fid, lambdaIndex, name) {
    const { CM, W } = this;
    const f = W.fns.get(fid);
    if (!f) return [];
    const reg = CM.region(fid);
    const ft = reg.to ? W.source.file(f.path) : null;
    if (!ft) return [];
    const esc = name.replace(/\$/g, '\\$');
    const re = new RegExp(`(?<![\\w$.])${esc}\\s*(?:\\?\\.)?\\(|\\b${esc}\\.(?:call|apply)\\(`, 'g');
    const decl = W.source.signature(f.path, f.line);
    const from = f.anon ? reg.from : Math.max(reg.from, (decl ? decl.endLine : f.line) + 1);
    const lo = u0(lambdaIndex, CM, fid, from);
    const out = [];
    for (let n = lo; n <= reg.to; n++) {
      const seg = ft.mask.slice(ft.offset(n), n < ft.lineCount ? ft.offset(n + 1) : ft.text.length);
      re.lastIndex = 0;
      const m = re.exec(seg);
      if (m) out.push({ line: n, off: ft.offset(n) + m.index });
    }
    return out;
  }

  // ---- one call -------------------------------------------------------------------------------------------------------
  descend(site, callerFid, u, visit, ctx, depth, budget) {
    const { W, CM } = this;
    if (budget < MIN_SHARE) {
      visit.items.push({ t: 'break', reason: 'the journey is cut here (too long to show it all)', line: site.line });
      return 1;
    }
    if (site.source === 'note') {
      visit.items.push({ t: 'note', text: site.text, line: site.line });
      return 1;
    }
    if (site.source === 'choice') {
      const shown = site.alts.slice(0, MAX_CHOICES);
      const item = { t: 'choice', name: site.name, line: site.line, options: [], more: site.alts.length - shown.length };
      visit.items.push(item);
      let spent = 1;
      for (const alt of shown) {
        const tmp = { items: [] };
        spent += this.descend({ ...alt, tier: 'may-alt' }, callerFid, u, tmp, ctx, depth, Math.floor(budget / shown.length));
        item.options.push({ name: this.names.label(alt.callee), items: tmp.items });
      }
      return spent;
    }
    // a function value that the callee runs
    if (site.source === 'function value') {
      const v = site.value;
      const target = v.fn ? { fid: v.fn } : { fid: v.lambda.parent, lambda: v.lambda.index };
      const label = v.fn ? this.names.label(v.fn) : `callback passed to ${v.host}`;
      return this.enter({ ...target, label, via: { kind: 'function value', line: site.line, name: site.paramName, evidence: v.fn ? 'passed by name' : 'passed inline', by: this.names.label(callerFid), where: `${W.fns.get(callerFid)?.path ?? ''}:${site.line}` }, budget }, site, callerFid, visit, ctx, depth);
    }
    const g = site.callee;
    const gf = W.fns.get(g);
    const gname = this.names.label(g);
    const base = { t: 'call', callee: g, name: gname, line: site.line, evidence: site.source === 'map' ? (site.tier === 'linked' ? 'linked' : 'map') : 'scan', tier: site.tier };
    if (site.tier === 'may') {
      visit.items.push({ ...base, t: 'break', reason: `may call ${gname} (the tool found several possible targets and did not pick one)`, gap: false });
      return 1;
    }
    if (!gf) {
      visit.items.push({ ...base, t: 'break', reason: `calls ${gname}, which is not in the map`, gap: true });
      return 1;
    }
    if (depth >= MAX_DEPTH) {
      visit.items.push({ ...base, t: 'break', reason: `calls ${gname}; not entered (the journey is already ${MAX_DEPTH} calls deep)`, gap: false });
      return 1;
    }
    // function values passed in this call
    const passed = new Map();
    const params = gf.mapped || CM.factsOf(g) ? paramNames(W.source, gf.path, gf.line) : [];
    const unitCaller = CM.unit(callerFid);
    for (const a of site.fnArgs ?? []) {
      const name = a.kw ?? params[a.index];
      if (!name) continue;
      if (a.kind === 'lambda') {
        const mapped = CM.mappedLambda(callerFid, a);
        const li = unitCaller.lambdas.findIndex((L) => L.arg === a);
        passed.set(name, mapped ? { fn: mapped } : { lambda: { parent: callerFid, index: li }, host: tailName(g) });
      } else if (u.passed?.has(a.text)) {
        passed.set(name, u.passed.get(a.text));
      } else {
        const r = CM.resolveRef(callerFid, a.text);
        if (r) passed.set(name, { fn: r });
      }
    }
    if (site.kind === 'link' && site.toBox) base.link = site.lit ?? true;
    const forceThen = site.kind === 'link' && W.boxes.get(site.toBox)?.kind === 'decision';
    const startBox = site.toBox ?? W.entryBox(g);
    const via = { kind: site.kind === 'link' ? 'link' : 'call', line: site.line, evidence: base.evidence, tier: site.tier, lit: site.lit ?? undefined };
    return this.enter({ fid: g, startBox, forceThen, via, passed, budget }, site, callerFid, visit, ctx, depth, base);
  }

  /** A function value that is run, or a function that only runs the function values it is given, adds no depth: it is the same step of the story. */
  isWrapper(unit) {
    if (unit.via?.kind === 'function value') return true;
    if (!unit.passed || !unit.passed.size) return false;
    const f = this.W.fns.get(unit.fid);
    if (!f || !f.boxes.length) return true;
    const entry = this.W.boxes.get(this.W.entryBox(unit.fid));
    return !entry || this.isHandlerBox(entry);
  }

  enter(unit, site, callerFid, visit, ctx, depth, base) {
    const key = unitKey(unit);
    if (ctx.keys.has(key)) {
      visit.items.push({ t: 'break', reason: `runs ${unit.label ?? this.names.label(unit.fid)} again while it is already running (a cycle)`, line: site.line });
      return 1;
    }
    if (ctx.seen.has(key)) {
      visit.items.push({ t: 'again', callee: unit.fid, name: unit.label ?? this.names.label(unit.fid), line: site.line });
      return 1;
    }
    const wrap = this.isWrapper(unit);
    const child = this.visit(unit, ctx, depth + (wrap ? 0 : 1));
    child.wrap = wrap;
    child.callLine = site.line;
    child.callerFid = callerFid;
    visit.items.push({ t: 'visit', visit: child, name: child.label, line: site.line, evidence: base?.evidence ?? unit.via?.evidence });
    return child.used + 1;
  }

  /** Run a journey from a trigger: {fid, startBox?, forceThen?, lambda?, label?}. */
  run(trigger) {
    const ctx = { stack: new Set(), keys: new Set(), seen: new Set(), nodes: 0, truth: new Truth() };
    const root = this.visit({ ...trigger, via: { kind: 'trigger' } }, ctx, 0);
    return { root, nodes: ctx.nodes };
  }
}

/** Count what a visit tree reaches: functions, files, work boxes, breaks. */
export function measureTree(root, W) {
  const fns = new Set();
  const files = new Set();
  const m = { steps: 0, work: 0, breaks: 0, gaps: 0, literalLoops: 0, loops: 0, visits: 0, boxes: 0 };
  const walk = (v) => {
    m.visits++;
    fns.add(v.fid);
    if (v.path) files.add(v.path);
    for (const it of v.items) {
      if (it.t === 'box') {
        m.steps++;
        m.boxes++;
        if (it.work) m.work++;
        if (it.rule === 'loop') {
          m.loops++;
          if (it.literalLoop) m.literalLoops++;
        }
      } else if (it.t === 'break') {
        m.breaks++;
        if (it.gap) m.gaps++;
      } else if (it.t === 'visit') walk(it.visit);
      else if (it.t === 'choice') for (const o of it.options) for (const x of o.items) if (x.t === 'visit') walk(x.visit);
    }
  };
  walk(root);
  return { ...m, fns: fns.size, files: files.size, fnSet: uniq([...fns]).sort(cmp), fileSet: [...files].sort(cmp), tail: tailName(root.fid) };
}

function u0(lambdaIndex, CM, fid, from) {
  if (lambdaIndex === undefined) return from;
  const L = CM.unit(fid).lambdas[lambdaIndex];
  return L ? L.arg.startLine : from;
}
