// holdsOf(model, breaks) -> what can hold up the main path, in path order: its wait boxes, its gates, and the loops that touch it.
// Computed from the declared main path (model.paths[0]) alone, so a box being dismissed (or never questioned) does not hide it: each row carries its state.
//   {kind: 'wait'|'gate'|'loop', id, title, stage, step, steps, state: 'kept'|'open'|'held'|'dismissed'|'none', why, question, limit, on, how, boxes, key}
// `step` is the first place on the path (1-based), `steps` how many times the path passes it (a box can come round again), `limit` is a loop's own limit or a wait's own timeout words
// (what the model says: nothing is read from the words of a box), `on`/`how` come from the model's `waitsFor`. The page prints these rows; so does `faultline breaks`.
import { limitIsEmpty } from '../model/text.mjs';
import { waitsMap } from '../model/waits.mjs';
import { mainPath } from './util.mjs';

const RANK = { suspect: 0, open: 1, wait: 1, loop: 1, silent: 1, lead: 2, dismissed: 3 };
const STATE = { suspect: 'kept', open: 'open', wait: 'open', loop: 'open', silent: 'open', lead: 'held', dismissed: 'dismissed' };
export const HOLD_STATE_WORDS = { kept: 'Kept as a question', open: 'Open question', held: 'Held-back lead', dismissed: 'Dismissed', none: 'No question raised' };

function stateOf(rows) {
  const live = rows.filter((r) => r.state in RANK).sort((a, b) => RANK[a.state] - RANK[b.state]);
  if (!live.length) return { state: 'none', why: '', question: '', key: '' };
  const top = live[0];
  const dis = live.find((r) => r.state === 'dismissed');
  return { state: STATE[top.state], why: top.state === 'dismissed' || top.state === 'suspect' ? top.why || '' : (dis && dis.why) || '', question: top.question || '', key: top.key || '', dismissedWhy: dis ? dis.why || '' : '' };
}

export function holdsOf(model, breaks = []) {
  const path = mainPath(model), byId = new Map((model.boxes || []).map((b) => [b.id, b])), waits = waitsMap(model), out = [];
  if (!path.length) return out;
  const pos = new Map();
  path.forEach((id, i) => { if (!pos.has(id)) pos.set(id, []); pos.get(id).push(i + 1); });
  for (const [id, at] of pos) {
    const b = byId.get(id); if (!b || (b.kind !== 'wait' && b.kind !== 'gate')) continue;
    const rows = breaks.filter((r) => (r.boxes || []).includes(id) && r.check !== 'no-limit-loop');
    const w = waits[id];
    out.push({ kind: b.kind, id, title: b.title || id, stage: b.stage || '', step: at[0], steps: at.length, ...stateOf(rows), limit: '', ...(w ? { on: w.on, ...(w.how ? { how: w.how } : {}) } : {}), boxes: [id] });
  }
  for (const l of model.loops || []) {
    const mine = (l.boxes || []).filter((id) => pos.has(id)); if (!mine.length) continue;
    const rows = breaks.filter((r) => /^(loop|no-limit-loop):/.test(String(r.key || '')) && String(r.key).split(':').slice(1).join(':') === l.id);
    const first = Math.min(...mine.map((id) => pos.get(id)[0]));
    out.push({ kind: 'loop', id: l.id, title: l.title || l.id, stage: (byId.get(mine[0]) || {}).stage || '', step: first, steps: mine.length, ...stateOf(rows), limit: limitIsEmpty(l.limit) ? '' : String(l.limit).trim(), boxes: mine, loopBoxes: (l.boxes || []).length });
  }
  return out.sort((a, b) => a.step - b.step || (a.kind === 'loop') - (b.kind === 'loop'));
}
