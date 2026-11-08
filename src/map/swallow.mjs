// A context manager that swallows. `with m():` leaves the block normally, or by an exception; when the manager's own `__exit__` returns True the
// exception stops there and the code after the `with` runs. The graph reader cannot know that (it does not see the class), so it gives every
// `with` a join node that the code after it follows, and leaves the decision to this pass.
//
// Only a manager that is certain to swallow gets edges: a project class whose `__exit__` has at least one return and returns the constant True at every
// one. A manager that returns something else, or only sometimes True, is left as it was.
import { findMethod } from './classes.mjs';

/** Does this project class's `__exit__` return True on every path that returns? */
function exitSwallows(P, ck) {
  const m = findMethod(P, ck, '__exit__');
  if (!m) return false;
  const rets = P.fns.get(m).nodes.filter((n) => n.k === 'return');
  return rets.length > 0 && rets.every((n) => n.sig === 'ret:const:True');
}

/** For each `with` of a swallowing project manager: an edge `swallow` from every node of the block that can raise to the join after it, and a mark on
 *  the block's raise statements (`sw`): the exception stops at the `with`, so the raise is not an ending of the function. */
export function addSwallowEdges(P) {
  for (const fid of P.fids) {
    const fn = P.fns.get(fid);
    const made = new Set();
    for (const nd of fn.nodes) {
      for (const o of nd.ops ?? []) {
        if (o.t !== 'with' || o.jp === undefined || !o.cls || !exitSwallows(P, o.cls)) continue;
        const join = fn.nodes.find((n) => n.syn === `${o.jp}/j`);
        if (!join) continue;
        for (const b of fn.nodes) {
          if (!b.syn.startsWith(`${o.jp}/b`) || made.has(b.i)) continue;
          if (b.k === 'raise') b.sw = 1;
          if (b.k === 'raise' || (b.ops ?? []).length) {
            made.add(b.i);
            fn.edges.push([b.i, join.i, 'swallow']);
          }
        }
      }
    }
  }
}
