// mapSystem: from what the readers produced to the model and the claim register. The seam between the readers (index.mjs) and the rules.
//
//   const sys = await readSystem(config);                 // the readers: documents and checker answers, see CONTRACT.md
//   const { model, claims } = mapSystem(sys, { name });   // the rules: plain data, byte-identical for the same input
//   modelText(model), claimsText(claims)                  // the bytes written to disk
//
// `sys.routeFacts` (optional, from routefacts.mjs) carries the HTTP route facts of the Python files; without it no route link is drawn.
import { loadState } from './state.mjs';
import { resolveCalls } from './resolve.mjs';
import { applyLinks } from './links.mjs';
import { Flow } from './excflow.mjs';
import { Vocab } from './vocab.mjs';
import { MapBuilder } from './mapbuild.mjs';
import { modelOf, modelText } from './emit.mjs';
import { runFindings } from './findings.mjs';
import { buildClaims } from './claims.mjs';
import { annotate } from './mainpath.mjs';
import { dumps } from './pyrt.mjs';

export { modelText };
export const claimsText = (claims) => dumps(claims, 0);

/** A reply in the body of a script file is an ending (it is what the entry returns, split by reply shape). A helper function that other code calls is
 *  not an entry (its return goes to its caller), and neither is the body of a file that another file includes. */
export function markScriptEntries(P, V, lang = 'lua') {
  const included = new Set();
  for (const m of P.mods.values()) if (m.lang === lang) for (const x of m.includes ?? []) included.add(x);
  for (const [fid, fn] of P.fns) if (fn.lang === lang && fn.qual === '<module>' && !included.has(fn.path)) V.entries.add(fid);
}

/** The stages of the rule engine, in order, on a loaded project. `hook(stageName, state)` is called after each (the tests use it to compare). */
export function runRules(P, { name, routeFacts = null, hook = null } = {}) {
  const note = (s, st) => { if (hook) hook(s, st); };
  resolveCalls(P);
  note('resolved', { P });
  const links = applyLinks(P, P.root, routeFacts);
  note('linked', { P, links });
  const F = new Flow(P);
  F.run();
  const V = new Vocab(P);
  markScriptEntries(P, V);
  const M = new MapBuilder(P, F, V).build();
  const model = modelOf(M, name);
  note('model', { P, M, model });
  const claims = annotate(M, buildClaims(M, runFindings(P, F)));
  note('claims', { P, M, claims });
  return { model, claims, P, M, F, V, links };
}

/** The model and claims for a read system. The documents in `sys` are copied first (the rules write what they resolve onto the functions they read), so
 *  mapping the same `sys` twice gives the same bytes; pass `clone: false` to hand the documents over when `sys` is not used again. */
export function mapSystem(sys, opts = {}) {
  const own = opts.clone === false ? sys : { ...sys, ir: structuredClone(sys.ir) };
  const P = loadState(own);
  return runRules(P, { ...opts, routeFacts: opts.routeFacts ?? sys.routeFacts ?? null });
}
