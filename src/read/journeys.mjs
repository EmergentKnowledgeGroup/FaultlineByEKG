// Journeys: run the walker from every trigger, reject the ones that are not real runs, rank and fold the rest to a readable size.
import { cmp, sortBy } from './util.mjs';
import { TRIGGER_WEIGHT } from './entries.mjs';
import { measureTree } from './walk.mjs';
import { exampleRank, TIER_FRONT, TIER_DOCS } from './examples.mjs';

// Reading size. A journey is folded to these so a person can follow it; the full run stays reachable through "folded" steps.
export const MAX_VISITS_SHOWN = 18;     // functions entered, shown in one journey
export const MAX_STEPS_SHOWN = 110;     // steps shown in one journey
export const MAX_BOXES_PER_VISIT = 7;   // boxes shown for one function
export const DEPTH_DISCOUNT = 0.8;      // a deeper call is worth less on the page than a shallower one with the same work: the surface of the story first
export const MAX_JOURNEYS = 60;         // journeys kept (the rest are counted)
export const SAME_JOURNEY = 0.6;        // two journeys whose shown functions overlap by this much (shared / all) are the same story: the better one is kept
export const SCORE_FILES_CAP = 15;      // sizes counted when ranking journeys are capped at these
export const SCORE_FUNCTIONS_CAP = 80;
export const SCORE_WORK_CAP = 80;
export const KIND_QUOTA = { route: 20, main: 8, event: 10, timer: 6, background: 6, export: 24 };   // journeys kept per kind of trigger, so one kind cannot crowd out the rest
export const KIND_QUOTA_DEFAULT = 6;
export const LITERAL_LOOP_SHARE = 0.5;  // a journey whose loops are mostly over lists written in the code is not a run of the system
export const CLEAR_WINNER_RATIO = 1.5;   // with no example to go by, the first journey is the main path only if it reaches this many times what the next one does
export const MIN_FUNCTIONS = 2;         // a journey that never leaves its first function is not a journey

function subtreeWork(v) {
  if (v._work !== undefined) return v._work;
  let w = 0;
  for (const it of v.items) {
    if (it.t === 'box') w += (it.work ? 2 : 0) + (it.kind === 'wait' ? 2 : 0) + (it.kind === 'end' ? 1 : 0);
    else if (it.t === 'visit') w += subtreeWork(it.visit);
    else if (it.t === 'choice') for (const o of it.options) for (const x of o.items) if (x.t === 'visit') w += subtreeWork(x.visit);
  }
  v._work = w;
  return w;
}

function countSteps(v) {
  let n = 0;
  for (const it of v.items) {
    if (it.t === 'box') n++;
    else if (it.t === 'visit') n += 1 + countSteps(it.visit);
    else if (it.t === 'choice') for (const o of it.options) for (const x of o.items) if (x.t === 'visit') n += 1 + countSteps(x.visit);
  }
  return n;
}

/** Choose which visits of a tree to show: those with the most work first, parents before children. */
function chooseVisits(root) {
  const kept = new Set([root]);
  const cand = [];
  let order = 0;
  const addChildren = (v) => {
    for (const it of v.items) {
      if (it.t === 'visit') cand.push({ v: it.visit, work: subtreeWork(it.visit) * DEPTH_DISCOUNT ** Math.max(0, it.visit.depth - root.depth), order: order++ });
      else if (it.t === 'choice') for (const o of it.options) for (const x of o.items) if (x.t === 'visit') cand.push({ v: x.visit, work: subtreeWork(x.visit) * DEPTH_DISCOUNT ** Math.max(0, x.visit.depth - root.depth), order: order++ });
    }
  };
  addChildren(root);
  // a function that only hands on to another (no boxes of its own to show) does not use up the budget
  const counts = (v) => (v.items.some((i) => i.t === 'box' && !i.pure) ? 1 : 0);
  let counted = 1;
  let steps = root.items.filter((i) => i.t === 'box').length;
  while (cand.length && counted < MAX_VISITS_SHOWN && steps < MAX_STEPS_SHOWN) {
    cand.sort((a, b) => b.work - a.work || a.order - b.order);
    const c = cand.shift();
    if (c.work === 0 && kept.size >= 6) continue;
    kept.add(c.v);
    counted += counts(c.v);
    steps += 1 + Math.min(MAX_BOXES_PER_VISIT, c.v.items.filter((i) => i.t === 'box').length);
    addChildren(c.v);
  }
  return kept;
}

function shownBoxes(v) {
  const boxes = v.items.filter((i) => i.t === 'box' && !i.pure);
  if (boxes.length <= MAX_BOXES_PER_VISIT) return new Set(boxes);
  const rank = (i) => (i.work || i.kind === 'wait' ? 3 : i.kind === 'end' ? 3 : i.kind === 'decision' ? 2 : 1);
  const ending = v.ended ? boxes.find((i) => i.box === v.ended.box) : null;   // the ending a run reaches is always shown
  const keep = [...boxes].sort((a, b) => (b === ending) - (a === ending) || rank(b) - rank(a) || a.line - b.line).slice(0, MAX_BOXES_PER_VISIT);
  return new Set(keep);
}

/** Flatten a kept tree to steps (a depth and a kind each). */
/**
 * The visit whose ending is the journey's: the trigger's own run when it reaches an ending box; otherwise, when the last thing the run does is a
 * call, the run that call makes (and so on down), because that is where the run ends up.
 */
export function endingVisit(root) {
  let v = root;
  for (let guard = 0; guard < 16; guard++) {
    if (v.ended) return v;
    const last = v.items[v.items.length - 1];
    if (last?.t !== 'visit') break;
    v = last.visit;
  }
  return v.ended ? v : root;   // a chain of last calls that never reaches an ending says nothing about how the run ends
}

function flatten(root, kept, W) {
  const last = endingVisit(root);
  const steps = [];
  const walk = (v, depth) => {
    const f = W.fns.get(v.fid);
    const enter = {
      kind: 'enter', depth, wd: v.depth, wrap: v.wrap || v.via?.kind === 'function value' || undefined, fn: v.label, fid: v.fid, where: `${v.path}:${v.line}`, mapped: v.mapped, via: v.via, stuck: v.stuck || undefined,
      note: v.mapped ? undefined : f?.mapped === false ? 'no boxes of its own in the map: read from the call list' : undefined,
    };
    steps.push(enter);
    const show = shownBoxes(v);
    let hidden = 0;
    for (const it of v.items) {
      if (it.t === 'box') {
        if (it.pure || !show.has(it)) {
          hidden += it.pure ? 0 : 1;
          continue;
        }
        const kind = it.rule === 'loop' ? 'loop' : it.kind === 'end' ? 'end' : it.kind === 'wait' ? 'wait' : it.work ? 'work' : it.kind === 'decision' ? 'decision' : 'step';
        steps.push({ kind, depth, line: it.line, title: it.title, plain: it.plain, raw: it.raw, box: it.box, took: it.took, notTaken: it.notTaken, outcome: it.end || undefined, shared: it.shared, final: v === last && v.ended?.box === it.box ? true : undefined });
      } else if (it.t === 'visit') {
        if (kept.has(it.visit)) walk(it.visit, depth + 1);
        else if (countSteps(it.visit) > 0 || subtreeWork(it.visit) > 0) steps.push({ kind: 'folded', depth: depth + 1, fn: it.visit.label, fid: it.visit.fid, line: it.line, steps: countSteps(it.visit), work: subtreeWork(it.visit), via: it.visit.via });
      } else if (it.t === 'choice') {
        steps.push({ kind: 'choice', depth, line: it.line, name: it.name, options: it.options.map((o) => o.name), more: it.more || undefined });
        for (const o of it.options) {
          for (const x of o.items) {
            if (x.t === 'visit') {
              if (kept.has(x.visit)) walk(x.visit, depth + 1);
              else steps.push({ kind: 'folded', depth: depth + 1, fn: x.visit.label, fid: x.visit.fid, line: x.line, steps: countSteps(x.visit), work: subtreeWork(x.visit), via: x.visit.via });
            }
          }
        }
      } else if (it.t === 'break') {
        steps.push({ kind: 'break', depth, line: it.line, reason: it.reason, gap: !!it.gap });
      } else if (it.t === 'note') {
        steps.push({ kind: 'note', depth, text: it.text });
      }
    }
    if (hidden > 0) enter.more = hidden;   // boxes of this function that the list leaves out: said on its own line, never as a last line
  };
  walk(root, 0);
  return steps;
}

export const HEADLINE_MAX = 22;      // steps in the short version of a journey (a reader can hold about this many)
export const HEADLINE_DEPTH = 4;     // the short version goes this many real calls deep at most (a pass-through call does not count)
const HEAD_SCORE = { end: 9, wait: 8, work: 8, loop: 5, decision: 5, break: 6, choice: 3, note: 3, folded: 1, step: 2 };

/**
 * The short version: about HEADLINE_MAX steps of the full list, flagged `hl`. A call whose callee does no work, waits for nothing and writes
 * nothing is a helper: it stays as one line with the count of steps inside it (`col`). A step deeper than HEADLINE_DEPTH, or inside a helper, is left to
 * the full list. When there are more candidates than room, the ones that do work and the ones nearest the surface stay.
 */
export function markHeadline(steps) {
  const n = steps.length;
  const segEnd = (i) => {
    const d = steps[i].depth;
    let j = i + 1;
    while (j < n && steps[j].depth >= d && !(steps[j].kind === 'enter' && steps[j].depth <= d)) j++;
    return j;
  };
  // owner[i]: the call a step belongs to (for a call, the call that made it); wd[i]: how many real calls deep it is (a pass-through does not count)
  const owner = new Array(n).fill(-1);
  const wd = new Array(n).fill(0);
  const at = [];
  for (let i = 0; i < n; i++) {
    const s = steps[i];
    if (s.kind === 'enter') {
      owner[i] = s.depth > 0 ? at[s.depth - 1] ?? -1 : -1;
      at[s.depth] = i;
      wd[i] = s.wd ?? s.depth;
    } else {
      owner[i] = at[s.kind === 'folded' ? s.depth - 1 : s.depth] ?? -1;
      wd[i] = owner[i] >= 0 ? wd[owner[i]] : 0;
    }
  }
  const inHelper = new Array(n).fill(false);
  const helper = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (steps[i].kind !== 'enter' || steps[i].depth === 0 || steps[i].wrap) continue;
    const end = segEnd(i);
    if (!steps.slice(i + 1, end).some((s) => s.kind === 'work' || s.kind === 'wait')) {
      helper[i] = true;
      for (let j = i + 1; j < end; j++) inHelper[j] = true;
    }
  }
  const score = (i) => {
    const s = steps[i];
    if (s.final || s.kind === 'finish' || (s.kind === 'enter' && s.depth === 0)) return Infinity;
    if (inHelper[i] || wd[i] > HEADLINE_DEPTH) return -1;
    if (s.kind === 'enter') return s.wrap ? -1 : (helper[i] ? 2 : 7) - wd[i] * 1.5;
    return (HEAD_SCORE[s.kind] ?? 1) - wd[i] * (s.kind === 'decision' ? 2 : 1.5);
  };
  let cand = steps.map((_, i) => i).filter((i) => score(i) > 0);
  if (cand.length > HEADLINE_MAX) {
    const keep = new Set([...cand].sort((a, b) => score(b) - score(a) || a - b).slice(0, HEADLINE_MAX));
    // a step that stays brings the real call it is inside with it
    const parent = (i) => {
      let p = owner[i];
      while (p >= 0 && steps[p].wrap) p = owner[p];
      return p;
    };
    for (const i of [...keep]) {
      for (let p = parent(i); p >= 0 && !keep.has(p); p = parent(p)) keep.add(p);
    }
    cand = cand.filter((i) => keep.has(i));
  }
  const chosen = new Set(cand);
  for (let i = 0; i < n; i++) {
    if (!chosen.has(i)) continue;
    steps[i].hl = true;
    steps[i].hd = wd[i];
    if (steps[i].kind === 'enter' && steps[i].depth > 0) {
      const end = segEnd(i);
      let shown = 0;
      for (let j = i + 1; j < end; j++) if (chosen.has(j)) shown++;
      const col = end - i - 1 - shown;
      if (col > 0) steps[i].col = col;
    }
  }
  return steps;
}

/** Kinds of start that are a plain call of the function: only then does its last line hand control back to a caller. A request, an event, a timer or a command line start is run by something else. */
const CALL_STARTS = new Set(['export']);

/**
 * How the trigger's own run ends: a named ending (the ending box it reached, at the site on its own route), or an honest "stopped here".
 * `caller` is the label of a function that calls the trigger, when the code has one. Returns the step to add (or null when the run's last box already is the ending, which is then flagged `final`).
 */
export function finishOf(root, steps, caller = null) {
  if (steps.some((s) => s.final)) return null;
  const ev = endingVisit(root);
  const items = ev.items;
  const lastItem = items[items.length - 1];
  const label = ev.label;
  const stopped = (plain, line) => ({ kind: 'finish', depth: 0, state: 'stopped', title: 'Stopped here, no ending reached', plain, line });
  if (ev.raises) {
    const callee = [...items].reverse().find((it) => it.t === 'visit' && it.visit.raises);
    return stopped(callee ? `${callee.visit.label} ends by raising an error on the way this walk goes, so ${label} does not carry on past it.` : `${label} ends by raising an error on the way this walk goes.`, callee?.line);
  }
  if (ev.stuck) return stopped(`${label}: ${ev.stuck}.`);
  if (lastItem?.t === 'break') return stopped(`The run goes on, but ${lastItem.reason}.`, lastItem.line);
  // the function simply reaches its last line: that is an ending, said plainly. One that something else in the code calls hands control back to its caller; one nothing calls just finishes.
  if (caller) return { kind: 'finish', depth: 0, state: 'returned', title: `Returns to ${caller}`, plain: `${label} reaches its last line and hands control back to its caller (${caller} is one). The map draws no return box on this route.`, outcome: 'neutral' };
  return { kind: 'finish', depth: 0, state: 'returned', title: `${label} finishes`, plain: `${label} runs to its last line and finishes. The map draws no return box on this route.`, outcome: 'neutral' };
}

/** Engine gaps: every hop that was followed from the scanner's call list or by name because the map has no road there. */
function gapsOf(root, W) {
  const gaps = [];
  const walk = (v) => {
    for (const it of v.items) {
      if (it.t === 'visit') {
        const via = it.visit.via;
        if (via?.kind === 'call' && via.evidence === 'scan') {
          gaps.push({ path: it.visit.callerFid ? W.fns.get(it.visit.callerFid)?.path : '', line: it.line, from: it.visit.callerFid, to: it.visit.fid, note: 'the scanner resolves this call; the map has no road for it' });
        }
        walk(it.visit);
      } else if (it.t === 'choice') for (const o of it.options) for (const x of o.items) if (x.t === 'visit') walk(x.visit);
      else if (it.t === 'break' && it.gap) gaps.push({ path: v.path, line: it.line, from: v.fid, to: '', note: it.reason });
    }
  };
  walk(root);
  return gaps;
}

/**
 * Run every trigger and keep the journeys that are real runs.
 * @returns {{journeys: object[], rejected: object, considered: number, none: boolean}}
 */
export function buildJourneys({ W, walker, triggers, names, examples = null }) {
  const cands = [];
  const rejected = { oneFunction: 0, literalLoops: 0, sameFile: 0, duplicate: 0, noBoxes: 0 };
  for (const t of triggers) {
    const run = walker.run({ fid: t.fid, startBox: t.startBox, forceThen: t.forceThen, lambda: t.lambda, label: t.lambda !== undefined ? names.label(t.fid) : undefined });
    const m = measureTree(run.root, W);
    cands.push({ t, run, m });
  }
  // reject
  const survive = [];
  const multiFile = cands.some((c) => c.m.files >= 2 && c.m.fns >= MIN_FUNCTIONS);
  for (const c of cands) {
    if (c.m.fns < MIN_FUNCTIONS) {
      rejected.oneFunction++;
      c.reject = 'stays in one function';
    } else if (c.m.loops > 0 && c.m.literalLoops / Math.max(1, c.m.boxes) >= LITERAL_LOOP_SHARE && c.m.literalLoops / c.m.loops >= LITERAL_LOOP_SHARE) {
      rejected.literalLoops++;
      c.reject = 'mostly loops over lists written in the code';
    } else if (multiFile && c.m.files < 2) {
      rejected.sameFile++;
      c.reject = 'never leaves its own file while other journeys do';
    } else survive.push(c);
  }
  // rank: a wider, deeper story that does more work comes first, with every size capped so one huge tree cannot outrank all others
  for (const c of survive) {
    c.score = (TRIGGER_WEIGHT[c.t.kind] ?? 1) * 2 + Math.min(c.m.files, SCORE_FILES_CAP) * 3 + Math.min(c.m.fns, SCORE_FUNCTIONS_CAP) + Math.min(c.m.work, SCORE_WORK_CAP) * 2 - Math.min(c.m.breaks, 10) * 0.5 - Math.min(c.m.gaps, 10);
  }
  for (const c of survive) c.ex = c.t.lambda !== undefined ? { tier: 2, at: 0 } : exampleRank(examples, W.fns.get(c.t.fid)?.qual ?? '');
  // what the project shows first comes first (its README and quick-start examples in the order it gives them, then its docs), then entry points by the work they reach
  const byRank = [(c) => c.ex.tier, (c) => c.ex.at, (c) => -(TRIGGER_WEIGHT[c.t.kind] ?? 0), (c) => -c.score, (c) => c.t.label, (c) => c.t.fid];
  const ranked = sortBy(survive, ...byRank);
  const keptC = [];
  const perKind = {};
  for (const c of ranked) {
    // two journeys that show nearly the same functions tell the same story: keep the better one
    c.visits = chooseVisits(c.run.root);
    const shown = new Set([...c.visits].map((v) => v.fid));
    const overlap = (k) => {
      let both = 0;
      for (const x of shown) if (k.shown.has(x)) both++;
      return both / (shown.size + k.shown.size - both);
    };
    const dupIdx = keptC.findIndex((k) => overlap(k) >= SAME_JOURNEY);
    if (dupIdx >= 0) {
      // the same story from two doors: keep the outer one (the one whose run passes through the other's door)
      const k = keptC[dupIdx];
      if (shown.has(k.t.fid) && !k.shown.has(c.t.fid)) {
        c.shown = shown;
        keptC[dupIdx] = c;
        perKind[k.t.kind]--;
        perKind[c.t.kind] = (perKind[c.t.kind] ?? 0) + 1;
      }
      rejected.duplicate++;
      continue;
    }
    if (keptC.length >= MAX_JOURNEYS) break;
    if ((perKind[c.t.kind] ?? 0) >= (KIND_QUOTA[c.t.kind] ?? KIND_QUOTA_DEFAULT)) {
      rejected.overQuota = (rejected.overQuota ?? 0) + 1;
      continue;
    }
    c.shown = shown;
    perKind[c.t.kind] = (perKind[c.t.kind] ?? 0) + 1;
    keptC.push(c);
  }
  const ordered = sortBy(keptC, ...byRank);
  keptC.length = 0;
  keptC.push(...ordered);
  const journeys = keptC.map((c, i) => {
    const keptVisits = c.visits;
    const steps = flatten(c.run.root, keptVisits, W);
    const callerFid = (W.callersOf.get(c.t.fid) ?? []).map((r) => W.fnOf(r.from)).find((g) => g && g !== c.t.fid);
    const fin = finishOf(c.run.root, steps, callerFid && CALL_STARTS.has(c.t.kind) ? names.label(callerFid) : null);
    if (fin) steps.push(fin);
    markHeadline(steps);
    const last = steps.find((x) => x.final) ?? fin;
    return {
      id: `j${i + 1}`,
      name: journeyName(c.t, names),
      trigger: { kind: c.t.kind, label: c.t.label, detail: c.t.detail, fn: c.t.fid, where: `${W.fns.get(c.t.fid)?.path ?? ''}:${c.t.line ?? W.fns.get(c.t.fid)?.line ?? 0}` },
      stats: {
        functions: c.m.fns, files: c.m.files, steps: c.m.steps, work: c.m.work, breaks: c.m.breaks, gaps: c.m.gaps,
        stepsShown: steps.length, functionsShown: keptVisits.size, headline: steps.filter((x) => x.hl).length,
        endState: last?.state ?? 'ended', endTitle: last?.title ?? '', endOutcome: last?.outcome ?? '',
      },
      example: c.ex.tier === TIER_FRONT ? 'front' : c.ex.tier === TIER_DOCS ? 'docs' : '',
      steps,
      gaps: gapsOf(c.run.root, W),
      files: c.m.fileSet,
      functionsReached: c.m.fnSet,
    };
  });
  // the main path is the first journey, by a stated rule; with nothing to go by it is none
  const reach = (c) => c.m.work * 2 + c.m.fns;
  let main = null;
  let rule;
  const withEx = keptC.filter((c) => c.ex.tier === TIER_FRONT).length;
  if (!keptC.length) rule = 'There is no journey, so there is no main path.';
  else if (withEx) {
    main = { id: 'j1', why: 'the first example in README or quick-start that reaches code' };
    rule = `Journeys are ordered by what the project itself shows first: those that start at a name in the README or quick-start examples come first, in the order the examples give them (${withEx} do), then those the docs mention, then the rest by how much work the run reaches. The main path is the first.`;
  } else if (keptC.length === 1) {
    main = { id: 'j1', why: 'the only journey found' };
    rule = 'No README or docs example names an entry point. There is one journey, so it is the main path.';
  } else if (reach(keptC[0]) >= CLEAR_WINNER_RATIO * reach(keptC[1])) {
    main = { id: 'j1', why: `it reaches ${keptC[0].m.fns} functions and ${keptC[0].m.work} places that do work, at least ${CLEAR_WINNER_RATIO} times what the next journey does` };
    rule = `No README or docs example names an entry point, so journeys are ordered by the work they reach. The first reaches at least ${CLEAR_WINNER_RATIO} times as much as the second, so it is the main path.`;
  } else rule = `No README or docs example names an entry point, so journeys are ordered by the work they reach (the kind of start, files, functions, and places that write, delete, announce or call out). No journey reaches ${CLEAR_WINNER_RATIO} times as much as the next, so no main path is named.`;
  const ranking = { by: withEx ? 'examples' : 'work', rule, main, examples: examples ? { files: examples.files, blocks: examples.blocks, frontBlocks: examples.frontBlocks } : null };
  return { journeys, ranking, rejected: { ...rejected, kept: journeys.length, considered: cands.length, rejectedTotal: cands.length - survive.length }, none: journeys.length === 0, main: main ? journeys[0].id : null };
}

export function journeyName(t, names) {
  if (t.kind === 'route') return `A request for ${t.label}`;
  if (t.kind === 'event') return `When the ${t.label} fires${t.lambda === undefined && !/^(callback|handler|anonymous|function)/.test(names.label(t.fid)) ? `: ${names.label(t.fid)}` : ''}`;
  if (t.kind === 'timer') return `On a timer: ${names.label(t.fid)}`;
  if (t.kind === 'background') return `In the background: ${names.label(t.fid)}`;
  if (t.kind === 'main') return `Running ${names.label(t.fid).replace(/^command line: /, '')} from the command line`;
  return `A call to ${names.label(t.fid)}`;
}

/** What all entries can reach, over every road and every scanner call (nothing is chosen): functions and boxes. */
export function reachFromEntries({ W, CM, entryFids }) {
  const seen = new Set();
  const stack = [...entryFids];
  while (stack.length) {
    const x = stack.pop();
    if (seen.has(x)) continue;
    seen.add(x);
    for (const r of W.calleesOf.get(x) ?? []) {
      const g = W.fnOf(r.to);
      if (g && !seen.has(g)) stack.push(g);
    }
    const ff = CM.factsOf(x);
    for (const c of ff?.calls ?? []) if (W.fns.has(c) && !seen.has(c)) stack.push(c);
    // nested functions run when the function that holds them runs them: count them with the holder
    for (const k of W.fns.get(x)?.children ?? []) if (!seen.has(k)) stack.push(k);
  }
  let boxes = 0;
  let mapped = 0;
  for (const fid of seen) {
    const f = W.fns.get(fid);
    if (f?.mapped) {
      mapped++;
      boxes += f.boxes.length;
    }
  }
  return { functions: seen.size, mappedFunctions: mapped, boxes };
}
