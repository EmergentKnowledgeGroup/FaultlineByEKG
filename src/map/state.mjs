// The loaded project: what the rules start from. Built from the readers' documents, before any call is resolved.
import { tkey } from './canon.mjs';
import { fileDigest, StaleInput } from './files.mjs';

export function emptyState(root) {
  return {
    root, fns: new Map(), mods: new Map(), modname: new Map(), classes: new Map(), clsByName: new Map(), modfn: new Map(), methodsByName: new Map(),
    names: new Set(), hidden: new Set(), strs: new Set(), rebound: new Set(), patched: new Set(), newcls: new Set(), errors: [], lines: new Map(),
    resolvers: { py: null, ts: null }, env: {}, pyAnswers: null, rstat: {}, srcDigest: null, nSources: 0,
  };
}

/** The Python reader's document, with the order its classes and functions were found in. */
export function addPython(P, doc, order) {
  const fnById = new Map();
  for (const f of doc.files) for (const fn of f.fns) fnById.set(fn.id, fn);
  for (const id of order.fns) P.fns.set(id, fnById.get(id));
  const clsByKey = new Map();
  for (const f of doc.files) for (const c of f.classes) { const { key, ...rest } = c; clsByKey.set(key, rest); }
  for (const key of order.classes) P.classes.set(key, clsByKey.get(key));
  for (const [name, keys] of Object.entries(order.clsByName)) P.clsByName.set(name, [...keys]);
  for (const [name, ids] of Object.entries(order.methodsByName)) P.methodsByName.set(name, [...ids]);
  for (const f of doc.files) {
    P.mods.set(f.path, { name: f.module, imports: f.imports, lang: 'py', lines: f.lines });
    P.modname.set(f.module, f.path);
    P.lines.set(f.path, f.lines);
  }
  for (const fn of P.fns.values()) {
    if (!fn.cls && fn.qual !== '<module>') P.modfn.set(tkey(fn.path, fn.qual), P.modfn.get(tkey(fn.path, fn.qual)) ?? fn.id);
  }
  for (const k of ['names', 'hidden', 'strs', 'newcls']) for (const x of doc.facts[k]) P[k].add(x);
  for (const [rel, x] of doc.facts.rebound) P.rebound.add(tkey(rel, x));
  for (const [cls, attr] of doc.facts.patched) P.patched.add(tkey(cls, attr));
  for (const [rel, why] of doc.errors) P.errors.push([rel, why]);
}

/** A TypeScript or Lua document. Refused when its sources are no longer the ones on disk. */
export function addIr(P, doc, what) {
  if (doc.source_digest && fileDigest(P.root, doc.files.map((f) => f.path)) !== doc.source_digest) {
    throw new StaleInput(`the ${what} document was made from other sources than the ones under ${P.root}; read them again`);
  }
  if (doc.resolver) P.resolvers.ts = doc.resolver;
  if (doc.checker_stop) P.errors.push(['(typescript checker)', doc.checker_stop]);
  if (doc.env) P.env.ts = doc.env;
  for (const f of doc.files) {
    for (const k of ['names', 'hidden', 'strs']) for (const x of f[k] || []) P[k].add(x);
    if (f.errors) P.errors.push([f.path, `${f.errors} syntax error${f.errors !== 1 ? 's' : ''}: read as far as the parser got`]);
    if (f.stop) P.errors.push([f.path, f.stop]);
    const rel = f.path;
    P.mods.set(rel, { name: f.module, imports: f.imports, lang: f.lang, lines: f.lines, decls: new Set(f.decls || []), includes: [...(f.includes || [])] });
    P.modname.set(f.module, rel);
    P.lines.set(rel, f.lines);
    for (const c of f.classes) {
      P.classes.set(c.key, { name: c.name, mod: rel, bases: c.bases, methods: { ...c.methods }, attrs: {}, line: c.line });
      if (!P.clsByName.has(c.name)) P.clsByName.set(c.name, []);
      P.clsByName.get(c.name).push(c.key);
      for (const [m, fid] of Object.entries(c.methods)) {
        if (m === '__init__') continue;
        if (!P.methodsByName.has(m)) P.methodsByName.set(m, []);
        P.methodsByName.get(m).push(fid);
      }
    }
    for (const fn of f.fns) {
      P.fns.set(fn.id, fn);
      if (!fn.cls && fn.qual !== '<module>' && !fn.prop && !P.modfn.has(tkey(rel, fn.qual))) P.modfn.set(tkey(rel, fn.qual), fn.id);   // a member of an object literal is reachable as obj.name, never as the bare name
    }
  }
}

/** The loaded project from a readSystem result. */
export function loadState(sys) {
  const P = emptyState(sys.root);
  if (sys.ir.py) addPython(P, sys.ir.py, sys.order.py);
  if (sys.ir.ts) addIr(P, sys.ir.ts, 'TypeScript');
  if (sys.ir.lua) addIr(P, sys.ir.lua, 'Lua');
  if (sys.ty) {
    P.pyAnswers = sys.ty.answers;
    P.resolvers.py = sys.ty.version;
    if (sys.ty.env) P.env.py = sys.ty.env;
  }
  P.srcDigest = sys.sourceDigest;
  P.nSources = sys.sourceFiles;
  return P;
}

/** Throws StaleInput unless the files this project was loaded from are still what is on disk. */
export function checkFresh(P) {
  if (P.srcDigest === null) throw new StaleInput('this project does not record the sources it was built from; read them again');
  if (fileDigest(P.root, [...P.mods.keys()]) !== P.srcDigest) throw new StaleInput(`the sources under ${P.root} changed after this project was read; read them again`);
}
