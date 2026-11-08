// A road's `when` is bound to what the tool sees where the road starts, never judged as prose.
//
//   arm        the route leaves a decision. The tool knows which arm: the tested side or `else`. The label is compared with that arm, in the few ways
//              a program can compare words: an "else" label on the tested side, a plain "no/not" on a side the tool shows as positive, a label that is
//              the test itself on the else side. A flip that uses no such word is NOT seen. What the label means is never read.
//   error-arm  the route leaves by a failure path (a catch, a raise road). A label that only talks of success there is flagged.
//   step/call/exit  the route starts at a step, a call or an exit: there is no condition there, so the label is not compared with anything.
//   none       no `when` written.
import { isElseLabel, hasNegation, hasAbsence, covers, words, testPolarity, readsAsGood, readsAsBad } from './words.mjs';
import { plain } from './canon.mjs';
import { WINDOW } from './seen.mjs';
import { IN_BOX } from './ref.mjs';

const PHRASE = 120;
/** The arm label for a test the tool finds at the cited line when it draws no road from that test to the road's target. */
export const NOT_DRAWN = 'not drawn to this target';

export const WHEN_LABEL = {
  none: 'no condition written',
  'not-compared': 'condition not compared: the tool sees no test here',
  'no-contradiction': 'no contradiction the tool can see; meaning not read',
  contradicts: 'contradicts the arm the tool draws',
};

function armOf(L, edge, fromBox) {
  const rd = L.roads.get(edge.id);
  const outs = (L.out.get(fromBox.id) ?? []).filter((e) => L.roads.get(e.id).prov?.rule === 'cfg-edge');
  const same = new Set(outs.map((e) => e.to));
  return { label: rd.when ?? '', side: (rd.when ?? '') === 'else' ? 'else' : 'test', ambiguous: outs.length < 2 || same.size < 2 };
}

/** @returns {{text, bound, label, tool, flags}} `tool` is what the tool says at the start of the road. */
export function bindWhen(ctx, when, route, refs, own = new Set()) {
  const { L, S } = ctx;
  const text = plain(when ?? '', 120);
  const flags = [];
  if (!text) return { text: '', bound: 'none', label: 'none', tool: null, flags };
  // the route's first road binds the label only when it leaves a box the road's own cited lines stand on; otherwise the cited lines hold a different test than the route starts from
  let first = route && route.length ? route[0] : null;
  if (first && own.size && !own.has(first.from)) first = null;
  if (first) {
    const fromBox = L.boxes.get(first.from);
    const rd = L.roads.get(first.id);
    if (fromBox.kind === 'decision' && rd.prov?.rule === 'cfg-edge') {
      const test = fromBox.detail || fromBox.title || '';
      const arm = armOf(L, first, fromBox);
      const tool = { at: `${(fromBox.prov.fn ?? '').split('::')[0]}:${fromBox.prov.line}`, phrase: plain(test, PHRASE), arm: arm.side === 'else' ? 'else' : plain(arm.label, PHRASE), box: fromBox.id, side: arm.side };
      if (arm.ambiguous) return { text, bound: 'arm', label: 'not-compared', tool: { ...tool, note: 'both arms lead to the same place, so the label cannot be tied to one' }, flags };
      const tw = words(test), ww = words(text), about = covers(tw, ww);
      if (arm.side === 'test' && isElseLabel(text)) flags.push('else-label-on-test-arm');
      if (arm.side === 'else' && !isElseLabel(text) && text.toLowerCase() === test.trim().toLowerCase()) flags.push('test-label-on-else-arm');
      const pol = testPolarity(test);
      if (pol && about && hasNegation(text) && !isElseLabel(text)) {
        const positiveArm = arm.side === 'test' ? pol === 'pos' : pol === 'neg';
        if (positiveArm) flags.push('negation-on-positive-arm');
      }
      if (pol && about && !isElseLabel(text) && !hasNegation(text) && !hasAbsence(text)) {
        const negativeArm = arm.side === 'test' ? pol === 'neg' : pol === 'pos';
        if (negativeArm) flags.push('positive-on-negative-arm');
      }
      if (!about && !isElseLabel(text)) flags.push('label-shares-nothing-with-test');
      const hard = flags.some((f) => f !== 'label-shares-nothing-with-test');
      return { text, bound: 'arm', label: hard ? 'contradicts' : 'no-contradiction', tool, flags };
    }
    if (rd.prov?.rule === 'exc-edge') {                                   // the road into a catch; a road that leaves a catch carries on after the failure was dealt with
      const tool = { at: `${(fromBox.prov.fn ?? '').split('::')[0]}:${fromBox.prov.line}`, phrase: plain(rd.when || fromBox.title || '', PHRASE), arm: 'error' };
      if (readsAsGood(text) && !readsAsBad(text)) flags.push('success-words-on-error-road');
      return { text, bound: 'error-arm', label: flags.length ? 'contradicts' : 'not-compared', tool, flags };
    }
    const bound = rd.prov?.rule === 'call' || rd.prov?.rule === 'link' ? 'call' : fromBox.kind === 'end' ? 'exit' : 'step';
    flags.push(`condition-on-${bound}`);
    return { text, bound, label: 'not-compared', tool: { at: `${(fromBox.prov.fn ?? '').split('::')[0]}:${rd.prov?.line ?? fromBox.prov.line}`, phrase: plain(rd.when || fromBox.detail || fromBox.title || '', PHRASE), arm: bound }, flags };
  }
  // no route: say what the tool sees at the cited lines, and do not compare
  for (const r of refs.filter((x) => IN_BOX.has(x.status) || x.status === 'code')) {
    const a = S.at(r.chain ?? [], r.line, 2, 1);
    if (a.dec.length) return { text, bound: 'arm', label: 'not-compared', tool: { at: `${r.path}:${a.dec[0][0]}`, phrase: plain(a.dec[0][2], PHRASE), arm: NOT_DRAWN }, flags };
    if (a.calls.length) { flags.push('condition-on-call'); return { text, bound: 'call', label: 'not-compared', tool: { at: `${r.path}:${a.calls[0][0]}`, phrase: plain('calls ' + (a.calls[0][1] || ''), PHRASE), arm: 'call' }, flags }; }
    const b = S.at(r.chain ?? [], r.line, ...WINDOW.exit);
    if (b.ex.length) { flags.push('condition-on-exit'); return { text, bound: 'exit', label: 'not-compared', tool: { at: `${r.path}:${b.ex[0][0]}`, phrase: plain(b.ex[0][2], PHRASE), arm: 'exit' }, flags }; }
  }
  flags.push('condition-nothing-to-compare');
  return { text, bound: 'nothing', label: 'not-compared', tool: null, flags };
}
