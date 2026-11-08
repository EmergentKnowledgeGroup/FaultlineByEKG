// Effects keyed on the RESOLVED DEFINITION, not on the callee's name.
//
// classifyCall (common.mjs) reads the text of the call, and its answer is only a CANDIDATE ("this call is named like a store"). A candidate becomes
// a real effect only when the definition the call lands on is one that has it:
//     str.replace            builtins / str.replace       -> not a store         (the name table said store: wrong)
//     Path.replace, os.replace                            -> store
// A candidate whose definition is known but is in neither table, or that no resolver answered, stays a CANDIDATE: the op carries `maybe:store`
// (a label on the call, nothing more). `maybe:` effects are never work: they create no store kind, no "does store" title, no box and no decision.
//
// Without a checker the same rules run on what the imports alone prove (`import os; os.replace(...)` is the definition os.replace, `open` is
// builtins.open), and everything else is `maybe:`.
//
// A definition is [module, qualified name]. For TypeScript the module is `lib` (the language's own library), `node:fs`, or the package name; the
// qualified name is Container.member.
import { ALLOW, PURE, BOUNDARY, BOUNDARY_PURE, RAISERS, TS_GLOBALS, AWAITABLE } from './effects_tables.mjs';
import { BOUNDARY_ROOTS } from './common.mjs';
import { sorted } from './pyrt.mjs';

const rx = (s) => new RegExp(`^(?:${s})$`);
const rows = (list) => list.map(([m, q]) => [rx(m), rx(q)]);
const AC = Object.fromEntries(Object.entries(ALLOW).map(([e, r]) => [e, rows(r)]));
const PC = rows(PURE);
const BC = Object.fromEntries(Object.entries(BOUNDARY).map(([k, r]) => [k, rows(r)]));
const BPC = rows(BOUNDARY_PURE);
const RC = RAISERS.map(([m, q, t]) => [rx(m), rx(q), t]);
const AWC = rows(AWAITABLE);
const OPEN_MODES = new Set('wax+');
const DUMPS = /^(?:dump|safe_dump|dump_all)$/;
const DUMP_MODULES = new Set(['json', 'pickle', '_pickle', 'marshal', 'plistlib', 'yaml', 'toml', 'tomli_w']);
const STD_STREAMS = new Set(['sys.stdout', 'sys.stderr', 'sys.__stdout__', 'sys.__stderr__']);

const hit = (table, mod, qual) => table.some(([m, q]) => m.test(mod) && q.test(qual));

export const confirms = (effect, mod, qual) => hit(AC[effect] ?? [], mod, qual);
export const isPure = (mod, qual) => hit(PC, mod, qual);
export const isAwaitable = (mod, qual) => hit(AWC, mod, qual);

/** [confirmed kinds, maybe kinds] for a call whose definitions outside the project are `defs` and whose import root is `root`.
 *  confirmed: a definition a row names. maybe: the call comes from a boundary package, no definition is known or none is a pure value. */
export function boundaryOf(defs, root) {
  const sure = new Set();
  const maybe = new Set();
  for (const [k, table] of Object.entries(BC)) if (defs.some(([mod, qual]) => hit(table, mod, qual))) sure.add(k);
  if (sure.size || (defs.length && defs.every(([m, q]) => isPure(m, q) || hit(BPC, m, q)))) return [sure, maybe];
  for (const [k, roots] of Object.entries(BOUNDARY_ROOTS)) {
    if (roots.has(root) || defs.some(([m]) => [...roots].some((r) => m === r || m.startsWith(r + '.')))) maybe.add(k);
  }
  return [sure, maybe];
}

/** [exception type names a call is documented to raise, known] from its resolved DEFINITIONS (op.defs), never from the last word of the callee's name.
 *  known: the definitions are in the table or are all pure values, so the call is not opaque. */
export function raisesOf(o) {
  const defs = o.defs ?? [];
  const ts = [];
  for (const [m, q] of defs) for (const [mr, qr, types] of RC) if (mr.test(m) && qr.test(q)) ts.push(...types);
  return [sorted(new Set(ts)), ts.length > 0 || (defs.length > 0 && defs.every(([m, q]) => isPure(m, q)))];
}

const inColl = (c, x) => (c instanceof Set ? c.has(x) : Array.isArray(c) ? c.includes(x) : false);

/** The definitions the IMPORTS alone prove for a call to `o.f` (no type checker): `os.replace` after `import os` is [os, replace]; `replace(...)`
 *  after `from os import replace` is [os, replace]; `open(...)` is [builtins, open]. Anything reached through a variable or an attribute of one
 *  proves nothing -> []. `imp` is a Map of local name -> import entry. */
export function lexicalDefs(o, imp, headBuiltin, decls, shadow) {
  const f = o.f;
  const parts = f.split('.');
  if (parts.includes('?') || ['self', 'cls', 'super()', 'this'].includes(parts[0])) return [];
  const head = parts[0];
  if (inColl(shadow, head)) return []; // a parameter that shares the module's name is not the module
  const ent = imp.get(head);
  if (ent === undefined) {
    if (Object.hasOwn(TS_GLOBALS, head) && !inColl(decls, head)) {
      const [m, q] = TS_GLOBALS[head];
      return q !== head ? [[m, q + (parts.length > 1 ? '.' + parts.slice(1).join('.') : '')]] : [[m, parts.join('.')]];
    }
    return headBuiltin && parts.length === 1 ? [['builtins', f]] : [];
  }
  if (ent[0] === 'mod') return parts.length >= 2 ? [[ent[1], parts.slice(1).join('.')]] : [];
  return [[ent[1], [ent[2], ...parts.slice(1)].join('.')]];
}

/** Take back what the call as written does not do: `print(..., file=X)` writes to X (a person reads only the standard streams), and a call that
 *  returns an awaitable waits only when it is awaited. -> [keep, maybe] with the effect moved to a `maybe:` label. */
export function adjust(keepIn, maybeIn, o, defs) {
  const keep = new Set(keepIn);
  const maybe = new Set(maybeIn);
  if (keep.has('print') && o.fl != null && !STD_STREAMS.has(o.fl)) {
    keep.delete('print');
    maybe.add('maybe:print');
  }
  if (!o.aw && defs.length && defs.every(([m, q]) => isAwaitable(m, q))) {
    for (const e of sorted([...keep].filter((x) => x.startsWith('wait')))) {
      keep.delete(e);
      maybe.add('maybe:' + e);
    }
  }
  return [keep, maybe];
}

/** cands: candidate effects from the name table. defs: [[module, qual]] the resolver (or the imports) gave for the callee outside the project.
 *  status: 'project' (the callee is project code), 'ext' (outside definitions known), 'silent' (the resolver made no claim), 'dynamic' (the callee is
 *  a variable or parameter), 'none' (no resolver ran for this language). fileish: Map of names bound by `with open(.., "w") as f`.
 *  -> [confirmed effect set, set of `maybe:` labels]. */
export function decide(cands, defs, status, o, fileish) {
  const keep = new Set();
  const maybe = new Set();
  if (!cands.size || status === 'project') return [keep, maybe]; // a project callee does what its own body does; the reader sees that body
  for (const e of sorted(cands)) {
    const base = e.endsWith('?') ? e.slice(0, -1) : e;
    if (e === 'store?') {
      const mode = o.mode;
      const writing = !!mode && [...mode].some((c) => OPEN_MODES.has(c));
      if (defs.length && writing && defs.some(([m, q]) => confirms('store', m, q))) keep.add('store');
      else if (!defs.length && writing) maybe.add('maybe:store');
      continue; // a definition that is not a file store (urlopen, an image open): nothing
    }
    if (defs.length && base === 'store' && defs.some(([m, q]) => DUMP_MODULES.has(m) && DUMPS.test(q))) {
      if (fileish && (o.cb ?? []).some((c) => fileish.has(c))) keep.add(e); // handed a name that `with open(..., "w") as f` bound: a file
      else maybe.add('maybe:store'); // a file, or a StringIO: the definition cannot say
    } else if (defs.length) {
      if (defs.some(([m, q]) => confirms(base, m, q))) keep.add(e);
      else if (defs.every(([m, q]) => isPure(m, q))) continue; // the definition is known and has no such effect
      else maybe.add('maybe:' + e); // defined somewhere we have no row for: a candidate, not a fact
    } else maybe.add('maybe:' + e); // no definition known (silent resolver, dynamic callee, or no resolver at all)
  }
  return [keep, maybe];
}
