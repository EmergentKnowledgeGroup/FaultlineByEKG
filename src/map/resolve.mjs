// Lexical call resolution: which project function a call lands on, from scoping and import rules alone, and how it was decided.
//   how: exact (a name in scope or an import) | self (a method of the own class, with the overrides) | typed (the receiver's class is known from
//   `x = Cls()` or an annotation) | by-name (the method name is defined once in the project: a candidate, never a road) | ext (outside the project) |
//   builtin | unresolved.
// The checkers' answers are merged afterwards (resolvemix.mjs). Nothing here guesses beyond those named rules.
import { BUILTIN_NAMES } from './pybuiltins.mjs';
import { tkey } from './canon.mjs';
import { resolveClass, findMethod, subclassesDefining } from './classes.mjs';
import { fnImports, fnShadow, fnLimpNames, normalizeRaises, prepare } from './lookup.mjs';
import { effectsOf, resolverPass, indexDefs } from './resolvemix.mjs';
import { cutNoReturn } from './noreturn.mjs';
import * as EFX from './effects.mjs';
import { classifyCall, SQL_WRITE } from './common.mjs';
import { findCallbacks } from './callbacks.mjs';
import { addSwallowEdges } from './swallow.mjs';
import { EXACT } from './roadpass.mjs';
import { fileDigest } from './files.mjs';
import { startsUpper, sorted, pyStrip } from './pyrt.mjs';

const efx = { classifyCall, lexicalDefs: EFX.lexicalDefs, decide: EFX.decide, adjust: EFX.adjust, boundaryOf: EFX.boundaryOf, isPure: EFX.isPure, SQL_WRITE };
const COMMON = new Set(`get set add run start stop close open read write send append extend items keys values update pop remove clear copy join split strip
  format encode decode load dump lower upper replace find count index sort insert flush connect commit execute info debug warning error log put post
  delete wait notify submit result cancel done create next iter emit render save call apply handle process cleanup validate parse dispatch init setup
  reset`.split(/\s+/));
const OPEN_WRITE = new Set('wax+');
const lastPart = (s) => s.slice(s.lastIndexOf('.') + 1);
const firstPart = (s) => s.split('.')[0];

/** A class named by an annotation: `Optional[Foo]`, `Foo | None`, `"Foo"`. */
function typeFromAnn(P, a, rel) {
  a = a.replace(/^['" ]+|['" ]+$/g, '').replace(/^Optional\[(.*)\]$/, '$1');
  a = pyStrip(a.split('|')[0]);
  return a && startsUpper(a) ? resolveClass(P, a, rel) : null;
}

function typeOfValue(P, v, rel, ann) {
  if (v.startsWith('call:')) {
    const name = v.slice(5);
    if ((name && startsUpper(name)) || (name.includes('.') && startsUpper(lastPart(name)))) return resolveClass(P, name, rel);
  }
  if (v.startsWith('name:') && ann && ann.has(v.slice(5))) return typeFromAnn(P, ann.get(v.slice(5)), rel);
  return null;
}

const annotations = (fn) => new Map((fn.params ?? []).filter((p) => p[1]).map((p) => [p[0], p[1]]));

/** self.attr types from `self.x = Cls(...)` and annotations. Deterministic, name-based. */
function indexTypes(P) {
  P.attrType = new Map();
  for (const fid of P.fids) {
    const fn = P.fns.get(fid);
    if (!fn.cls) continue;
    const ann = annotations(fn);
    for (const n of fn.nodes) {
      for (const o of n.ops ?? []) {
        if (o.t === 'set' && o.tgt.startsWith('self.') && o.tgt.split('.').length === 2) {
          const t = typeOfValue(P, o.v, fn.path, ann);
          if (t) {
            if (!P.attrType.has(fn.cls)) P.attrType.set(fn.cls, new Map());
            const m = P.attrType.get(fn.cls);
            if (!m.has(o.tgt.slice(5))) m.set(o.tgt.slice(5), t);
          }
        }
      }
    }
  }
}

/** ('name', module, name) [+ an attribute chain] -> [targets, how] */
function viaImport(P, tgt, rest) {
  const mod = tgt[1];
  let name = tgt[2];
  let path = P.modname.get(mod);
  if (path === undefined) {
    const sub = P.modname.get(`${mod}.${name}`);
    if (!sub) return [[], null];
    path = sub;
    [name, rest] = rest?.length ? [rest[0], rest.slice(1)] : [null, rest];
  }
  if (name === null) return [[], 'exact'];
  const c = P.modfn.get(tkey(path, name));
  if (c && !rest?.length) return [[c], 'exact'];
  const ck = resolveClass(P, name, path);
  if (ck) {
    if (rest && rest.length > 1) return [[], 'exact']; // `Cls.method.__get__(...)`: the call is of the attribute, not of the method
    const m = findMethod(P, ck, rest?.length ? rest[0] : '__init__');
    return [m ? [m] : [], 'exact'];
  }
  return [[], 'exact'];
}

function resolveOne(P, fn, o, imp, local, shadow, localimp) {
  const rel = fn.path;
  const parts = o.f.split('.');
  const head = parts[0];
  let to = [];
  let how = null;
  const own = ['self', 'cls', 'super()', 'this'];
  if (shadow.has(head) && !own.includes(head) && !local.has(head) && !localimp.has(head)) {
    // a local variable of that name: not the module-level function, class or import of the same name
  } else if (parts.length === 1 && localimp.has(head) && imp.has(head)) {
    const ent = imp.get(head);
    if (ent[0] === 'mod') {
      how = 'ext';
      o.x = firstPart(ent[1]);
    } else {
      [to, how] = viaImport(P, ent, null);
      if (!to.length && !how) { how = 'ext'; o.x = firstPart(ent[1]); }
    }
  } else if (parts.length === 1) {
    let scope = fn.qual;
    for (;;) {
      const cand = P.modfn.get(tkey(rel, (scope ? scope + '.' : '') + head));
      if (cand) { to = [cand]; how = 'exact'; break; }
      if (!scope.includes('.')) {
        if (scope) { scope = ''; continue; }
        break;
      }
      scope = scope.slice(0, scope.lastIndexOf('.'));
    }
    if (!to.length) {
      const ck = startsUpper(head) ? resolveClass(P, head, rel) : null;
      if (ck && head === P.classes.get(ck).name) {
        const m = findMethod(P, ck, '__init__');
        to = m ? [m] : [];
        how = 'exact';
        o.cls = ck;
      } else if (imp.has(head)) {
        const ent = imp.get(head);
        if (ent[0] === 'mod') {
          how = 'ext'; // `import os as target; target()`: a module object, not a function
          o.x = firstPart(ent[1]);
        } else {
          [to, how] = viaImport(P, ent, null);
          if (!to.length && !how) { how = 'ext'; o.x = firstPart(ent[1]); }
        }
      } else if (BUILTIN_NAMES.has(head)) how = 'builtin';
    }
  } else if ((head === 'self' || head === 'cls') && fn.cls) {
    const ck = fn.cls;
    if (parts.length === 2) {
      const m = findMethod(P, ck, parts[1]);
      if (m) {
        to = [m, ...subclassesDefining(P, ck, parts[1]).slice(0, 3)];
        how = 'self';
        o.own = m; // the method the name resolves to on this class; the rest of `to` are overrides
      }
    } else {
      const t = P.attrType.get(ck)?.get(parts[1]);
      if (t) {
        const m = parts.length === 3 ? findMethod(P, t, parts[parts.length - 1]) : null;
        if (m) { to = [m]; how = 'typed'; }
      }
    }
  } else if (head === 'super()' && fn.cls && parts.length === 2) {
    for (const b of P.classes.get(fn.cls).bases) {
      const bk = resolveClass(P, b, rel);
      const m = bk ? findMethod(P, bk, parts[1]) : null;
      if (m) { to = [m]; how = 'self'; break; }
    }
  } else if (local.has(head) && parts.length === 2) {
    const m = findMethod(P, local.get(head), parts[1]);
    if (m) {
      to = [m];
      how = 'typed';
      const subs = subclassesDefining(P, local.get(head), parts[1]);
      if (subs.length) { // the receiver's declared class has subclasses that override it: any of them may run
        to = [m, ...subs.slice(0, 4)];
        o.may = sorted(new Set(to));
      }
    }
  } else if (imp.has(head)) {
    const tgt = imp.get(head);
    if (tgt[0] === 'mod') {
      const mod = P.modname.get(tgt[1]);
      if (mod && parts.length >= 2) {
        const c = P.modfn.get(tkey(mod, parts[1]));
        if (c && parts.length === 2) { to = [c]; how = 'exact'; }
        else {
          const ck = resolveClass(P, parts[1], mod);
          if (ck && parts.length === 3) {
            const m = findMethod(P, ck, parts[2]);
            if (m) { to = [m]; how = 'exact'; }
          } else if (ck && parts.length === 2) {
            const m = findMethod(P, ck, '__init__');
            to = m ? [m] : [];
            how = 'exact';
          }
        }
      }
      if (!to.length && !mod) { how = 'ext'; o.x = firstPart(tgt[1]); }
    } else {
      [to, how] = viaImport(P, tgt, parts.slice(1));
      if (!to.length && how === null && !P.modname.get(tgt[1])) { how = 'ext'; o.x = firstPart(tgt[1]); }
    }
  } else if (startsUpper(head) && parts.length === 2) {
    const ck = resolveClass(P, head, rel);
    const m = ck ? findMethod(P, ck, parts[1]) : null;
    if (m) { to = [m]; how = 'exact'; }
  }
  const last = parts[parts.length - 1];
  if (!to.length && (how === null || how === 'builtin') && parts.length >= 2 && !COMMON.has(last) && !last.startsWith('__')) {
    const c = P.methodsByName.get(last) ?? [];
    if (c.length === 1) {
      o.cand = [...c]; // the method name is defined once in the project: a CANDIDATE, never a road
      how = 'by-name';
    }
  }
  if (to.length) o.to = sorted(new Set(to));
  o.how = how ?? 'unresolved';
}

/** A name handed over as a value, resolved by the same scoping rules as a call to it: [targets, the method the name itself lands on, how]. A class is not a
 *  function value here (naming a class is not calling its constructor), so a constructor target gives nothing. */
function resolveRef(P, fn, name, ctx) {
  const o = { f: name };
  resolveOne(P, fn, o, ctx.imp, ctx.local, ctx.shadow, ctx.limpn);
  const to = (o.to ?? []).filter((g) => !/(^|.)(__init__|constructor)(~d+)?$/.test(g.slice(g.indexOf('::') + 2)));
  if (o.cls || !EXACT.has(o.how) || !to.length || to.length !== (o.to ?? []).length) return [[], null, null];
  return [to, o.own ?? to[0], o.how];
}

/**
 * A call through a name that holds a function value: a parameter, a local assigned from something, a `self` attribute that is not a method of the
 * class. Whatever the checker or a default shows is one value it may hold, not the one it holds when the call runs, so every target is only possible.
 */
export function markFunctionValued(P, fn, o, shadow, lang) {
  if (!o.f || !o.to?.length || !EXACT.has(o.how)) return;
  const parts = o.f.split('.');
  let valued = parts.length === 1 && shadow.has(parts[0]);
  if (!valued && lang === 'py' && parts.length === 2 && (parts[0] === 'self' || parts[0] === 'cls') && fn.cls) valued = !findMethod(P, fn.cls, parts[1]);
  if (valued) o.may = sorted(new Set([...(o.may ?? []), ...o.to]));
}

/** Resolve every call and `with` op of every function, merge the checkers' answers, decide the effects, and cut the paths after calls that cannot
 *  return. Fills P.never and leaves `to`, `how`, `rs`, `defs`, `eff` and friends on the ops. */
export function resolveCalls(P) {
  prepare(P);
  normalizeRaises(P);
  indexTypes(P);
  indexDefs(P);
  P.rstat = {};
  const ctxs = new Map();
  for (const fid of P.fids) {
    const fn = P.fns.get(fid);
    const rel = fn.path;
    const imp = fnImports(P, fn);
    const shadow = fnShadow(P, fn);
    const limpn = fnLimpNames(P, fn);
    const ann = annotations(fn);
    const local = new Map();
    for (const [p, a] of ann) {
      const t = typeFromAnn(P, a, rel);
      if (t) local.set(p, t);
    }
    for (const n of fn.nodes) {
      for (const o of n.ops ?? []) {
        if (o.t === 'set' && o.tk === 'name') {
          const t = typeOfValue(P, o.v, rel, ann);
          if (t && !local.has(o.tgt)) local.set(o.tgt, t);
        }
      }
    }
    const fileish = new Map(); // `with open(p, "w") as f` makes f a file opened for writing (json.dump(x, f) is a store)
    for (const n of fn.nodes) {
      for (const o of n.ops ?? []) {
        if (o.t === 'with' && o.as && o.mode && [...o.mode].some((c) => OPEN_WRITE.has(c))) fileish.set(o.as, o.mode);
      }
    }
    ctxs.set(fid, { imp, local, shadow, limpn });
    const mod = P.mods.get(rel);
    for (const n of fn.nodes) {
      for (const o of n.ops ?? []) {
        if ((o.t === 'call' || o.t === 'with') && o.f) {
          resolveOne(P, fn, o, imp, local, shadow, limpn);
          const [status, defs] = resolverPass(P, fn, o, mod.lang);
          o.rs = status;
          markFunctionValued(P, fn, o, shadow, mod.lang);
          if (defs.length) o.defs = defs.map((d) => [...d]);
          effectsOf(P, o, imp, status, defs, mod.decls ?? [], shadow, fileish, efx);
        }
      }
    }
  }
  findCallbacks(P, ctxs, (fn, name, ctx) => resolveRef(P, fn, name, ctx));
  addSwallowEdges(P);
  P.never = cutNoReturn(P);
  P.srcDigest = fileDigest(P.root, [...P.mods.keys()]); // what the map stands on; checkFresh compares it with the files as they are now
  return P;
}
