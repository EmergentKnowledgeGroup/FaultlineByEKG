// The plan of one run through one function: which lines the run reaches. Every branch of the function (drawn as a decision or not) gets one
// arm; the lines of the other arm are dead; an arm that leaves the function stops the run at its last line; an arm that breaks out of a loop
// kills what is left of the loop body; a switch or match takes one case. The result is a line test, so the calls and boxes a journey lists
// can never come from two arms of one branch, or from after the run has left.
import { armEnd, caseRanges, LEAVES_FUNCTION, LEAVES_BODY } from './structure.mjs';

export const RAISE_PENALTY = 1000;   // an arm that raises weighs this much less than any other: a run meant to show the work takes it only when it must
export const SITE_WEIGHT = 4;        // a call counts this many boxes when two arms are compared (a call is where the work happens)

const inRange = (r, l) => !!r && l >= r[0] && l <= r[1];

/**
 * @param {object} d
 * @param {import('./walk.mjs').Walker} d.wk
 * @param {object} d.ctx the journey's context (its truth table)
 * @param {string} d.fid
 * @param {{box:object, arm?:string}[]} d.entries boxes the run goes through, in order
 * @param {object|null} d.ended the end box the path stopped at, or null
 * @param {object[]} d.sites the function's own call sites (not those inside function values)
 * @param {object[]} d.boxes every box of the function
 * @returns {{live:(line:number)=>boolean, stop:number, notes:object[], endSite:number|null, arms:Map<number,string>, setStop:(line:number)=>void}}
 */
export function makePlan({ wk, ctx, fid, lam = -1, entries, ended, boxes }) {
  const { W } = wk;
  const path = W.fns.get(fid)?.path ?? '';
  const branches = wk.branchesOf(fid, lam);
  const loops = wk.loopsOf(fid, lam);
  const dead = [];
  const notes = [];
  const arms = new Map();
  let stop = Infinity;
  const live = (l) => l <= stop && !dead.some((r) => l >= r[0] && l <= r[1]);

  const onPath = new Set(entries.map((e) => e.box.id));
  const pathLines = entries.filter((e) => e.box !== ended).map((e) => e.box.prov.line);
  const single = ended && !(ended.prov.sites?.length > 1) ? [ended.prov.line] : [];   // an ending with one site tells where the run ends up
  const pickLines = [...pathLines, ...single];
  const decisionsAt = new Map();
  for (const b of boxes) {
    if (b.kind !== 'decision' || b.prov.rule === 'loop' || b.prov.rule === 'handler') continue;
    if (!decisionsAt.has(b.prov.line)) decisionsAt.set(b.prov.line, []);
    decisionsAt.get(b.prov.line).push(b);
  }
  const armOnPath = new Map();
  for (const e of entries) if (e.arm && e.box.kind === 'decision' && e.box.prov.rule !== 'loop') armOnPath.set(e.box.prov.line, e.arm);
  const loopAround = (l) => loops.filter((x) => l >= x.line && l <= x.end).sort((a, b) => a.end - a.line - (b.end - b.line))[0] ?? null;

  /** An arm has been chosen: the other is dead, and an arm that leaves the function or the loop body cuts what follows. */
  const take = (br, a) => {
    const range = a === 'then' ? br.then ?? null : br.else ?? null;
    const other = a === 'then' ? br.else ?? null : br.then ?? null;
    if (other) dead.push(other);
    arms.set(br.line, a);
    if (!range) return;
    const end = wk.endOfArm(fid, br, a);
    if (LEAVES_FUNCTION.has(end)) stop = Math.min(stop, range[1]);
    else if (LEAVES_BODY.has(end)) {
      const lp = loopAround(br.line);
      if (lp && lp.end > range[1]) dead.push([range[1] + 1, lp.end]);
    }
  };

  for (const br of branches) {
    if (!live(br.line) || br.kind === 'ternary') continue;
    if (br.kind === 'try') {
      if (br.else) dead.push(br.else);   // the handlers of a try are never part of a run
      continue;
    }
    if (br.kind === 'match') {
      const cases = caseRanges(W.source, path, br.then);
      if (cases.length < 2) continue;
      let k = cases.findIndex((c) => pathLines.some((l) => l >= c.from && l <= c.to));
      if (k < 0) {
        let bw = -Infinity;
        cases.forEach((c, i) => {
          const body = [c.from + 1, c.to];
          const w = wk.weigh(fid, body, lam) - (armEnd(W.source, path, body) === 'raise' ? RAISE_PENALTY : 0);
          if (w > bw) {
            bw = w;
            k = i;
          }
        });
      }
      cases.forEach((c, i) => {
        if (i !== k) dead.push([c.from, c.to]);
      });
      if (LEAVES_FUNCTION.has(armEnd(W.source, path, [cases[k].from + 1, cases[k].to]))) stop = Math.min(stop, cases[k].to);
      notes.push({ line: br.line, text: `a choice among ${cases.length} cases on ${br.test || 'a value'}: this walk follows the case ${cases[k].label}; the other ${cases.length - 1} are not shown` });
      continue;
    }
    const boxed = decisionsAt.get(br.line);
    let a = armOnPath.get(br.line);
    if (boxed && !a) {
      if (boxed.some((b) => onPath.has(b.id))) continue;   // the path went through it and no arm is known: nothing to cut
      const whole = [br.then?.[0] ?? br.line + 1, br.else ? br.else[1] : br.then?.[1] ?? br.end];
      if (!pathLines.some((l) => inRange(whole, l))) {
        dead.push(whole);   // a decision the run does not reach: none of it runs
        continue;
      }
    }
    if (!a) {
      a = wk.pickArm(fid, br, ctx, pickLines, lam);
      ctx.truth.assume(W.source.condition(path, br.line)?.text ?? br.test ?? '', a);
    }
    take(br, a);
  }

  // the ending the run stops at: of the sites a shared ending box covers, the first this run can reach after its last box
  let endSite = null;
  if (ended) {
    const all = ended.prov.sites?.length ? ended.prov.sites : [ended.prov.line];
    const after = Math.max(0, ...pathLines);
    const reach = all.filter((l) => live(l));
    endSite = reach.find((l) => l >= after) ?? reach[0] ?? all[0];
  }
  return { live, get stop() { return stop; }, notes, endSite, arms, setStop: (l) => { stop = Math.min(stop, l); } };
}
