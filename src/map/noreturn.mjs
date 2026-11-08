// Calls that cannot return. Control does not go on past a call to the process exit, nor past a call to a function whose every path ends in a
// raise, an exit, or another such call. Without this a box after such a call looks reachable from the box that made it.
//
// cutNoReturn(P) removes the normal edges that leave the node holding such a call (an exception edge stays: a handler of the same function still
// takes over) and returns the set of functions that cannot return. It runs after calls are resolved, so the edges every later pass reads already
// say that nothing follows. A function is taken to return never only when its exit node cannot be reached from its entry by any edge; a
// generator, a module body, an abstract method and a function whose graph the reader could not model completely are never in that set.
import { isGen } from './lookup.mjs';

const MAX_ROUNDS = 12; // each round can only add functions that call an earlier round's, so call chains this deep settle
const EXC_LABELS = new Set(['exc', 'unmatched', 'fin-exc', 'swallow']); // the edges an exception takes; a context manager that swallows it sends it to the code after the with
const EXACT = new Set(['exact', 'self', 'typed']);

function exitReachable(fn, cutNodes) {
  const succ = new Map();
  for (const [a, b, l] of fn.edges) {
    if (cutNodes.has(a) && !EXC_LABELS.has(l)) continue;
    if (!succ.has(a)) succ.set(a, []);
    succ.get(a).push(b);
  }
  const seen = new Set([fn.entry]);
  const work = [fn.entry];
  while (work.length) for (const y of succ.get(work.pop()) ?? []) if (!seen.has(y)) { seen.add(y); work.push(y); }
  return seen.has(fn.exit);
}

/** An abstract method: its body only says a subclass must supply it, so a call may land on an override the project does not show. */
export function isStub(fn) {
  const last = (d) => d.slice(d.lastIndexOf('.') + 1);
  return (fn.decos ?? []).some((d) => last(d) === 'abstractmethod') ||
    fn.nodes.some((nd) => nd.k === 'raise' && last(nd.exc ?? '') === 'NotImplementedError');
}

export function stops(P, o, never) {
  if (o.t !== 'call' || o.lazy) return false;
  if ((o.eff ?? []).includes('exit')) return true;
  if (!o.to?.length || !EXACT.has(o.how)) return false;
  const may = new Set(o.may ?? []);
  for (const g of o.to) {
    if (may.has(g) || !never.has(g)) return false;
    if (P.fns.get(g).async && !o.aw) return false; // a coroutine / promise is created here, not run
  }
  return true;
}

export function cutNoReturn(P) {
  const never = new Set();
  const cutset = new Map(P.fids.map((fid) => [fid, new Set()]));
  const modeled = new Set(P.fids.filter((fid) => {
    const fn = P.fns.get(fid);
    return fn.qual !== '<module>' && !isGen(P, fid) && !isStub(fn) && !fn.nodes.some((nd) => nd.unmodelled);
  }));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = false;
    for (const fid of P.fids) {
      const cs = cutset.get(fid);
      for (const nd of P.fns.get(fid).nodes) {
        if (!cs.has(nd.i) && (nd.ops ?? []).some((o) => stops(P, o, never))) { cs.add(nd.i); changed = true; }
      }
    }
    for (const fid of P.fids) {
      if (!modeled.has(fid) || never.has(fid)) continue;
      if (!exitReachable(P.fns.get(fid), cutset.get(fid))) { never.add(fid); changed = true; }
    }
    if (!changed) break;
  }
  for (const [fid, ns] of cutset) {
    if (ns.size) {
      const fn = P.fns.get(fid);
      fn.edges = fn.edges.filter((e) => !(ns.has(e[0]) && !EXC_LABELS.has(e[2])));
      for (const nd of fn.nodes) {
        if (!ns.has(nd.i)) continue;
        // the node ends at its first stopping call: whatever the same node does after it never runs, so it is not part of the graph (no road, no effect)
        const at = nd.ops.findIndex((o) => stops(P, o, never));
        nd.nr = nd.ops[at].eff?.includes('exit') ? 'exit' : 'raise';
        nd.ops = nd.ops.slice(0, at + 1);
      }
    }
  }
  return never;
}
