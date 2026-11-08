// The call table: every call, `with` and link the rules looked at, in the order of the functions' ids, with how each was resolved. The reading layer uses it to list
// the calls the map could not follow. Rows are [function id, node index, op index, {fields}]; it is made from the loaded project after the rules ran.

import { cmpCp } from './canon.mjs';

/** Fields of an op that are kept: what was called, where, how it was resolved and what the resolver said. */
const KEEP = ['t', 'line', 'f', 'how', 'to', 'may', 'cand', 'rs', 'defs', 'eff', 'own', 'aw', 'lazy', 'x', 'tier', 'veto', 'lid'];
const KINDS = new Set(['call', 'with', 'link']);

/** @param P the loaded project (`mapSystem(...).P`) @returns {Array} rows */
export function callTable(P) {
  const rows = [];
  for (const fid of [...P.fns.keys()].sort(cmpCp)) {
    const fn = P.fns.get(fid);
    for (const nd of fn.nodes) {
      (nd.ops ?? []).forEach((o, oi) => {
        if (!KINDS.has(o.t)) return;
        const r = {};
        for (const k of KEEP) if (k in o) r[k] = o[k];
        rows.push([fid, nd.i, oi, r]);
      });
    }
  }
  return rows;
}

export const callTableText = (P) => JSON.stringify(callTable(P));
