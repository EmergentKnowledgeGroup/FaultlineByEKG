// lost-wakeup: a flag is flipped so that a loop should carry on, but on some path nothing wakes the loop if it is parked. Reads signals.json `lostWakeup`
// (src/extract/signals_wake.mjs): the stop/start pair, the field both assign, the loop in another method that reads it and can park, and the start side's
// calls and wake-like calls. A loop that only polls (every blocking call is a sleep with a time) is kept in signals.json with `polls: true` and not reported.
import { boxAt } from './checks_pairs.mjs';
import { DISMISS_NOTE } from './checks_wait.mjs';

const shortName = (fn) => String(fn).split('::').pop().split('.').pop();
const verbFor = (v) => (/^(?:false|null|undefined|0|""|clear\(\)|\[\]|\{\})$/.test(String(v)) ? 'clears' : /^(?:true|set\(\))$/.test(String(v)) ? 'sets' : 'changes');
const lines = (xs) => [...new Set(xs.map((x) => x.line))].slice(0, 3).join(', ');

export function lostWakeup(cx) {
  const out = [];
  for (const w of cx.signals?.lostWakeup || []) {
    if (w.polls) continue;                                                       // a polling loop re-checks the flag by itself
    const sn = w.stop.name, tn = w.start.name, G = w.loop.name, F = w.field;
    const sb = boxAt(cx, w.start.fn, w.start.line), lb = boxAt(cx, w.loop.fn, w.loop.readAt);
    const boxes = [...new Set([sb, lb].filter(Boolean))];
    const some = w.startCalls.length > 0;
    const wait = w.blocks.find((b) => !b.timed) || w.blocks[0];
    const recvOf = (r) => (r === '@' ? 'this' : String(r).replace(/^@\./, ''));         // "@" is how the reader writes "this"
    const waitText = `${wait.kind === 'for await' ? 'for await' : wait.kind === 'await' ? 'await' : 'blocks on'}${wait.name ? ` ${wait.recv ? recvOf(wait.recv) + '.' : ''}${wait.name}()` : wait.recv ? ` ${recvOf(wait.recv)}` : ''} (${w.path}:${wait.line})`;
    out.push({
      key: `lost-wakeup:${w.start.fn}:${F}>${G}`, check: 'lost-wakeup', boxes, routes: [], at: boxes.length ? '' : `${w.path}:${w.start.line}`,
      weight: (some ? 1 : 2) * 10 - (w.startOpen ? 5 : 0),
      question: `\`${tn}\` ${verbFor(w.start.value)} \`${F}\`, which the loop in \`${G}\` reads, but ${some ? 'only calls it in one branch' : 'never calls it'}. If that loop is parked, what wakes it?`,
      evidence: `${boxes.length ? '' : `No box on the map covers this (${w.path}:${w.start.line}). `}The method \`${sn}\` sets \`${F}\` = ${w.stop.value} (${w.path}:${w.stop.setAt}) and the method \`${tn}\` (${w.path}:${w.start.line}) puts it back to ${w.start.value} (${w.path}:${w.start.restoreAt}). `
        + `The loop in \`${G}\` (${w.path}:${w.loop.line}-${w.loop.end}) reads \`${F}\`${w.loop.via ? ` through \`${w.loop.via}()\`` : ''} in its ${w.loop.how} (${w.path}:${w.loop.readAt}) and parks at \`${waitText.replace(/ \([^()]*\)$/, '')}\` (${w.path}:${wait.line}). `
        + `${w.blocks.some((b) => b.timed) ? `The loop also has a timed wait (${w.path}:${w.blocks.find((b) => b.timed).line}), which may let it re-check by itself. ` : ''}\`${tn}\` ${some ? `reaches \`${G}\` only on some paths (the calls that lead to it are at ${w.path}:${lines(w.startCalls)})` : `does not call \`${G}\` or anything that always calls it`}. `
        + `${w.startWakes.length ? `Its wake-like calls (${w.startWakes.map((x) => `\`${x.name}\` at ${w.path}:${x.line}`).join(', ')}) are not on every path.` : 'It makes no wake-like call (set, notify, resolve, wake, signal, or add/put on what the loop waits on).'} An emit is not a wake.`
        + `${w.startOpen ? ' It also calls a method the class inherits, which this read cannot see into.' : ''} ${DISMISS_NOTE}`,
    });
  }
  return out;
}
