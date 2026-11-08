// Checks that need only the map: wait-no-wake (a wait with nothing drawn that ends it by time) and shared-decision (one test reached
// from several stages). Each returns finding drafts {key, check, boxes, routes, question, evidence}. Settings are fixed, not tuned per system.
import { limitIsEmpty, clip, listMore } from './text.mjs';

// sharedStages: two other stages, or one other stage when a road in comes from inside a loop or a transaction-like step of that stage. The count is not
// fitted to what readers dismiss; a dismissal is one reader's quick opinion, so it is not a reason to drop a shape. sharedMax: a test reached from more
// than this many boxes is a shared helper by design. sharedCap: above this many on one map, the most-ranked are kept and the rest are counted in a note.
export const SETTINGS = { sharedIn: 3, sharedStages: 2, sharedMax: 6, sharedCap: 25 };
export const DISMISS_NOTE = 'A dismissal has to answer the question asked; "one function, same arguments" is not an answer.';
const TIME = /\b(?:time(?:d)?[\s-]?outs?|times?\s+out|timed\s+out|expir\w*|deadline|elapsed|ttl|too\s+long|stall\w*|lease|interval|poll\w*|periodic\w*|heartbeat|tick\w*|backoff|back\s+off|after\s+\d+|\d+\s*(?:ms|milliseconds?|s|secs?|seconds?|min|mins|minutes?|h|hours?)\b|every\s+\d+|retry\s+after|give\s+up|gives\s+up|wake\w*|sleep\w*)\b/i;
// An exit that a person, a caller or a cancel triggers is a way out someone outside can use: the wait is meant to last until they act.
const OUTSIDE_ACTOR = /\b(?:owner|users?|operators?|persons?|human|callers?|admin\w*|readers?|visitors?|players?|customers?|presses|pressed|press|clicks?|clicked|taps?|tapped|chooses?|chose|picks?|picked|selects?|selected|types?|typed|submits?|asks?|asked|opens?|dismiss\w*|approv\w*|cancel\w*|abort\w*|stops?|stopped|closes?|closed|closing|shut\s?down|gives?\s?up)\b/i;
const STOPLIKE = /\b(?:stop\w*|clos(?:e|es|ed|ing)|cancel\w*|abort\w*|shut\s?down|terminat\w*|kill\w*|disconnect\w*)\b/i;
const TXN = /\b(?:transaction\w*|commit\w*|rollback|atomic\w*|savepoint|all[\s-]or[\s-]nothing|critical\s+section|lease|lock(?:s|ed|ing)?|batch(?:es|ed)?|pipeline\w*)\b/i;
const text = (b) => `${b?.title || ''} ${b?.plain || ''} ${b?.handle || ''}`;
const list = (xs, n = 4) => listMore(xs, n, '; ');

export function waitNoWake(cx) {
  const out = [], { g } = cx;
  const loopsOf = (id) => (cx.model.loops || []).filter((L) => (L.boxes || []).includes(id));
  for (const b of g.boxes) {
    if (b.kind !== 'wait' || b.status === 'off' || b.status === 'test-only') continue;
    const ins = g.inX(b.id), exits = g.outX(b.id);
    if (!ins.length) continue;                                                   // nothing arrives here: no-way-in's business
    if (TIME.test(text(b)) || exits.some((r) => TIME.test(`${r.when || ''} ${r.why || ''}`))) continue;
    if (loopsOf(b.id).some((L) => !limitIsEmpty(L.limit))) continue;             // a stated loop limit bounds the wait
    if (exits.some((r) => OUTSIDE_ACTOR.test(`${r.when || ''}`))) continue;      // a person, a caller or a cancel can end it
    const stopIn = ins.filter((r) => { const f = g.byId.get(r.from); return STOPLIKE.test(`${r.when || ''} ${f?.title || ''} ${f?.handle || ''} ${r.from}`); });
    const road = (r, dir) => `${dir === 'in' ? r.from : r.to}${String(r.when || '').trim() ? `, when "${clip(r.when, 28)}"` : ''}`;
    out.push({
      key: `wait-no-wake:${b.id}`, check: 'wait-no-wake', boxes: [b.id], routes: [...ins, ...exits].map((r) => r.id), weight: stopIn.length ? 2 : 1,
      question: 'What wakes this if nothing arrives?',
      evidence: `No timeout or time-based exit is drawn on this wait. Roads in come from ${list(ins.map((r) => road(r, 'in')))}. ${exits.length ? `Roads out go to ${list(exits.map((r) => road(r, 'out')))}.` : 'No road out is drawn.'}${stopIn.length ? ` A road in comes from a stop-like step (${stopIn.slice(0, 2).map((r) => r.from).join(', ')}).` : ''}`,
    });
  }
  return out;
}

// One decision reached from several places. The question is what each caller has finished when it gets here, and whether what the test reads is
// complete for all of them: a helper that reads shared state partway through a batch is the shape.
export function sharedDecision(cx) {
  const out = [], { g } = cx;
  const inLoop = new Set((cx.model.loops || []).flatMap((L) => L.boxes || []));
  const stageOf = (id) => g.byId.get(id)?.stage || '';
  for (const b of g.boxes) {
    if (b.kind !== 'decision' || b.status === 'off' || b.status === 'test-only') continue;
    const ins = g.inX(b.id).filter((r) => r.type !== 'record');
    const from = [...new Set(ins.map((r) => r.from))];
    const stages = [...new Set(from.map(stageOf).filter((s) => s && s !== b.stage))];
    if (from.length < SETTINGS.sharedIn || from.length > SETTINGS.sharedMax) continue;     // more than sharedMax roads in: a shared helper by design
    const special = from.filter((id) => inLoop.has(id) || TXN.test(text(g.byId.get(id))));
    if (!special.length || special.length === from.length) continue;                  // reached the same way from everywhere: nothing differs between the contexts
    const farSpecial = special.some((id) => stageOf(id) && stageOf(id) !== b.stage);
    if (stages.length < SETTINGS.sharedStages && !(stages.length === 1 && farSpecial)) continue;
    const order = [...special, ...from.filter((id) => !special.includes(id))];
    const who = (id) => `${id} (stage ${stageOf(id) || 'none'}${inLoop.has(id) ? ', inside a declared loop' : TXN.test(text(g.byId.get(id))) ? ', looks transaction-like' : ''})`;
    out.push({
      key: `shared-decision:${b.id}`, check: 'shared-decision', boxes: [b.id, ...special.slice(0, 3)], routes: ins.map((r) => r.id), weight: Math.min(special.length, 3) + (stages.length >= 2 ? 1 : 0),
      question: `${b.id} is reached from ${order.slice(0, 3).join(', ').replace(/, ([^,]+)$/, ' and $1')}. What has each one finished when it gets here? Is what this test reads complete for all of them?`,
      evidence: `This test has roads in from ${from.length} boxes: ${list(order.map(who), 6)}. ${special.length} of them ${special.length === 1 ? 'sits inside a declared loop or looks' : 'sit inside a declared loop or look'} transaction-like. The shape is a helper that reads shared state partway through a batch. ${DISMISS_NOTE}`,
    });
  }
  if (out.length <= SETTINGS.sharedCap) return out;
  out.sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : 1));
  cx.notes?.push(`shared-decision: ${out.length} found, the ${SETTINGS.sharedCap} with the most callers inside a loop or a transaction-like step are listed and ${out.length - SETTINGS.sharedCap} are held back`);
  return out.slice(0, SETTINGS.sharedCap);
}
