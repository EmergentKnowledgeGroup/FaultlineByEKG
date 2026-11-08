// Class lookups over the loaded project: which class a name means in a module, its method resolution order, which method a name finds, and which
// subclasses override it. Name-based and deterministic: nothing is guessed beyond the rules written here.
import { cmpCp } from './canon.mjs';

/** An own property of a plain object, or undefined: a method called `toString` or `constructor` must not find the object's built-ins. */
export const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);

/** An import entry from a module's imports, kept as a plain object or as a Map. */
const impOf = (imp, k) => (imp instanceof Map ? imp.get(k) : own(imp, k));

const tail = (name) => name.split('.').pop();
const head = (name) => name.split('.')[0];

/** Every dotted prefix of every module name: `a.b.c` gives `a`, `a.b`, `a.b.c`. Built once per project. */
function modulePrefixes(P) {
  if (!P._modprefix) {
    const set = new Set();
    for (const n of P.modname.keys()) {
      const parts = n.split('.');
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('.'));
    }
    P._modprefix = set;
  }
  return P._modprefix;
}

/** The class key a class name written in module `rel` means, or null. */
export function resolveClass(P, name, rel) {
  const cands = P.clsByName.get(tail(name)) || [];
  if (!cands.length) return null;
  const imp = (P.mods.get(rel) || {}).imports || {};
  const ent = impOf(imp, head(name));
  if (ent && !([ent[1], ent[1] + '.' + (ent.length > 2 ? ent[2] : '')].some((m) => P.modname.get(m))) && !modulePrefixes(P).has(ent[1])) {
    return null;                    // imported from outside the project: a name that merely matches a project class is not that class
  }
  const same = cands.filter((k) => P.classes.get(k).mod === rel);
  if (same.length) return same[0];
  const h = head(name), e = impOf(imp, h);
  if (e && e[0] === 'name') {
    const tgt = P.modname.get(e[1]);
    for (const k of cands) if (P.classes.get(k).mod === tgt) return k;
  }
  return cands.length === 1 ? cands[0] : null;
}

/** The class and the bases it names, depth first, each once. */
export function mro(P, key, seen = null) {
  const top = seen === null;
  if (top && P._mro && P._mro.has(key)) return P._mro.get(key);
  seen = seen || new Set();
  if (seen.has(key) || !P.classes.has(key)) return [];
  seen.add(key);
  const out = [key];
  const c = P.classes.get(key);
  for (const b of c.bases) {
    const bk = resolveClass(P, b, c.mod);
    if (bk) out.push(...mro(P, bk, seen));
  }
  if (top) { (P._mro ||= new Map()).set(key, out); }
  return out;
}

/** The method `name` finds on the class or its bases, or null. */
export function findMethod(P, key, name) {
  for (const k of mro(P, key)) {
    const m = own(P.classes.get(k).methods, name);
    if (m) return m;
  }
  return null;
}

/** The methods named `name` that subclasses of `key` define, sorted. */
export function subclassesDefining(P, key, name) {
  const out = [];
  for (const [k, c] of P.classes) {
    if (k !== key && mro(P, k).includes(key) && Object.hasOwn(c.methods, name)) out.push(c.methods[name]);
  }
  return out.sort(cmpCp);
}
