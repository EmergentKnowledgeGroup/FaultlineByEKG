// Questions the rules ask of the loaded project (P, see CONTRACT.md): is this function a generator, what imports are in force inside it, may a call to
// it run something else, what raise statements name, which files outside the map mention a name. Pure reads, except normalizeRaises and
// prepare, which fill derived fields the later passes use.
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_EXCEPTIONS } from './pybuiltins.mjs';
import { SKIP_DIRS, StaleInput, fileDigest, listDir } from './files.mjs';
import { tkey } from './canon.mjs';
import { resolveClass } from './classes.mjs';
import { cmpStr, startsUpper, isUpperStr, sorted } from './pyrt.mjs';

export const PLAIN_DECOS = new Set(`staticmethod classmethod property contextmanager asynccontextmanager wraps cached_property abstractmethod lru_cache
  cache dataclass overload override final functools.wraps functools.lru_cache functools.cache functools.cached_property contextlib.contextmanager
  abc.abstractmethod typing.overload`.split(/\s+/));
const SETTER = ['.setter', '.getter', '.deleter'];
// Files that launch or build the project and have no extension (or an extension that says little), found by name: a make target, a container's start
// command, a process file all name the functions they run.
const OUTSIDE_NAMES = new Set(['Makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile', 'Procfile', 'Jenkinsfile', 'Justfile', 'Rakefile']);
const OUTSIDE_NAME_RE = /^(?:Dockerfile|Containerfile)\.[\w.-]+$|\.(?:mk|dockerfile)$/;
// Dot-folders that hold how the project is built and run; every other dot-folder is left alone.
const OUTSIDE_DOT_DIRS = new Set(['.github', '.gitlab', '.circleci', '.devcontainer', '.husky']);
const OUTSIDE_EXTS = ['.py', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.lua', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.toml', '.cfg', '.ini', '.yaml', '.yml', '.json', '.html', '.sql'];
const MAX_OUTSIDE_BYTES = 2_000_000; // a larger file is a data dump or a bundle, not a place a person names a function
const WORD = /[A-Za-z_][\p{L}\p{N}_]*/gu;

/** Fill what every later pass reads: the sorted function ids. */
export function prepare(P) {
  P.fids = sorted(P.fns.keys());
  P.never ??= new Set();
  P.genCache = new Map();
  return P;
}

/** Text of a file the way Python's text mode reads it: a byte order mark dropped, every line ending a newline, bad bytes replaced. */
export function readText(file) {
  let t = fs.readFileSync(file).toString('utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  t = t.replace(/\r\n?/g, '\n');
  return t;
}

/** A generator function: calling it runs none of its body (the body runs when the result is consumed). */
export function isGen(P, fid) {
  let r = P.genCache.get(fid);
  if (r === undefined) {
    const fn = P.fns.get(fid);
    r = !!fn.gen || fn.nodes.some((nd) => (nd.ops ?? []).some((o) => o.t === 'yield'));
    P.genCache.set(fid, r);
  }
  return r;
}

const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);

/** Why a call that resolves to this function may run something else at run time, or null. Decided from the syntax alone: a decorator (it may return
 *  another function), a second definition of the name, a module name bound again by an assignment or import, a method assigned from outside its
 *  class, a class whose __new__ may return another object (so __init__ may not run). */
export function replaceable(P, fid) {
  const fn = P.fns.get(fid);
  const short = lastDot(fn.qual).split('~')[0];
  const decos = (fn.decos ?? []).filter((d) => !PLAIN_DECOS.has(d) && !PLAIN_DECOS.has(d.split('(')[0]) && !SETTER.some((s) => d.endsWith(s)));
  if (decos.length) return 'decorated by ' + decos[0].slice(0, 40);
  const twin = fn.id.includes('~') || P.fns.has(`${fn.id}~2`);
  const accessor = (fn.decos ?? []).some((d) => d === 'property' || SETTER.some((s) => d.endsWith(s)) || lastDot(d) === 'overload');
  if (twin && !accessor) return 'the name is defined twice';
  const cls = fn.cls ? P.classes.get(fn.cls) : null;
  if (!cls && !fn.qual.includes('.') && P.rebound.has(tkey(fn.path, fn.qual))) return 'the name is bound again in its module';
  if (cls) {
    if (P.patched.has(tkey(cls.name, short))) return 'the method is assigned from outside the class';
    if (short === '__init__' && P.newcls.has(cls.name)) return 'the class defines __new__';
  }
  return null;
}

/** The functions around fn, innermost first, that hold `field`: the scopes a name can be bound in. */
function scopeChain(P, fn) {
  const out = [];
  let q = fn.qual;
  while (q) {
    const g = P.fns.get(`${fn.path}::${q}`);
    if (g) out.push(g);
    q = q.includes('.') ? q.slice(0, q.lastIndexOf('.')) : '';
  }
  return out;
}

const impCache = new WeakMap();
/** The module's imports as a Map of local name -> entry. */
export function moduleImports(mod) {
  let m = impCache.get(mod);
  if (!m) impCache.set(mod, (m = mod.imports instanceof Map ? mod.imports : new Map(Object.entries(mod.imports))));
  return m;
}

/** The imports in force inside a function: the module's, then the function-local ones of it and of every function around it. -> Map */
export function fnImports(P, fn) {
  const mod = P.mods.get(fn.path);
  const imp = moduleImports(mod);
  const chain = scopeChain(P, fn).filter((g) => g.limp && Object.keys(g.limp).length);
  if (!chain.length) return imp;
  const out = new Map(imp);
  const mname = mod.name;
  const pkg = fn.path.endsWith('__init__.py') ? mname : mname.includes('.') ? mname.slice(0, mname.lastIndexOf('.')) : '';
  for (const g of chain.reverse()) {
    for (const [k, v] of Object.entries(g.limp)) {
      if (v[0] === 'name') {
        let base = v[1];
        const level = v.length > 3 ? v[3] : 0;
        if (level) {
          let p = pkg ? pkg.split('.') : [];
          p = level > 1 ? p.slice(0, p.length - (level - 1)) : p;
          base = [...p, ...(v[1] ? [v[1]] : [])].join('.');
        }
        out.set(k, ['name', base, v[2]]);
      } else out.set(k, v.slice(0, 2));
    }
  }
  return out;
}

/** Names imported inside this function or one around it: the import is the closest binding, so it beats a module-level function of the same name. */
export function fnLimpNames(P, fn) {
  const out = new Set();
  for (const g of scopeChain(P, fn)) if (g.limp) for (const k of Object.keys(g.limp)) out.add(k);
  return out;
}

/** Names bound as locals in this function or in one around it (parameters, assignment, loop and with targets, except-as, walrus): a call to such a
 *  name is a call of a variable, never of the module-level function or import of the same name. */
export function fnShadow(P, fn) {
  const out = new Set();
  for (const g of scopeChain(P, fn)) {
    if (Object.hasOwn(g, 'locs')) for (const x of g.locs) out.add(x);
    else for (const p of g.params ?? []) out.add(p[0].replace(/^\*+/, '')); // Lua: the parameters
  }
  return out;
}

/** The exception class a `raise`/`throw` names, or null when the text is a variable or a factory call. A class is: a project class, a builtin
 *  exception, or a CamelCase name (imported or defined where we do not look). Never a lower-case name and never an ALL_CAPS constant. */
export function className(P, text, ek, rel) {
  if (!text || ek === 'other') return null;
  const last = lastDot(text);
  if (resolveClass(P, text, rel)) return last;
  if (BUILTIN_EXCEPTIONS.has(last)) return last;
  if (startsUpper(last) && !isUpperStr(last)) return last;
  return null;
}

/** `raise err` where err is the variable an enclosing `except ... as err` bound is a rethrow, not a type. A raise of any other variable or of a
 *  factory's result has an unknown type, written `*` (never the variable's name). Idempotent. */
export function normalizeRaises(P) {
  for (const fid of P.fids) {
    const fn = P.fns.get(fid);
    const nodes = fn.nodes;
    for (const n of nodes) {
      if (n.k !== 'raise' || n.norm) continue;
      n.norm = 1;
      const exc = n.exc ?? null;
      let ek = n.ek ?? null;
      if (exc === null && ek === null) { // bare `raise`
        n.rt = 'rethrow';
        n.sig = 'raise:reraise';
        continue;
      }
      if (ek === null) ek = !exc.includes('.') ? 'name' : 'attr';
      let h = n.h ?? null;
      let v = null;
      while (h !== null && ek === 'name') {
        if ((nodes[h].var ?? null) === exc) { v = exc; break; }
        h = nodes[h].h ?? null;
      }
      if (v !== null) {
        n.exc = null;
        n.rt = 'rethrow';
        n.var = v;
        n.sig = 'raise:reraise';
        continue;
      }
      const t = className(P, exc, ek, fn.path);
      if (t === null) {
        n.raised = exc;
        n.exc = '*';
        n.rt = 'unknown';
        n.sig = 'raise:*';
      } else n.sig = 'raise:' + t;
    }
  }
}

/** Every file under the project root that the map did not read and that mentions one of `names`: {name: [path, line]}. The first mention in path
 *  order wins. "Nothing names this function" is said only after this search comes back empty. Source-like files only (prose is not searched), plus the extensionless build and launch files in OUTSIDE_NAMES; no
 *  dot-folders except OUTSIDE_DOT_DIRS, and none of SKIP_DIRS; a file larger than MAX_OUTSIDE_BYTES is skipped. */
export function outsideMentions(P, names) {
  const want = new Set(names);
  const found = new Map();
  if (!want.size) return found;
  const walk = (dir, rel) => {
    const ents = listDir(dir);
    for (const e of ents) {
      if (!e.isFile || !(OUTSIDE_EXTS.some((x) => e.name.endsWith(x)) || OUTSIDE_NAMES.has(e.name) || OUTSIDE_NAME_RE.test(e.name))) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (P.mods.has(r)) continue;
      const full = path.join(dir, e.name);
      let text;
      try {
        if (fs.statSync(full).size > MAX_OUTSIDE_BYTES) continue;
        text = readText(full);
      } catch { continue; }
      const present = new Set(text.match(WORD) ?? []);
      const hit = [...want].filter((w) => present.has(w) && !found.has(w));
      if (hit.length) {
        const hs = new Set(hit);
        text.split('\n').forEach((line, i) => {
          const here = [...new Set(line.match(WORD) ?? [])].filter((w) => hs.has(w)).sort(cmpStr);
          for (const w of here) if (!found.has(w)) found.set(w, [r, i + 1]);
        });
      }
      if (found.size === want.size) return true;
    }
    for (const e of ents) {
      if (e.isDir && !SKIP_DIRS.has(e.name) && (!e.name.startsWith('.') || OUTSIDE_DOT_DIRS.has(e.name)) && walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name) === true) return true;
    }
    return false;
  };
  walk(P.root, '');
  return found;
}

/** Throw StaleInput unless the files this map was built from are still what is on disk (a map kept in a cache). */
export function checkFresh(P) {
  if (P.srcDigest == null) throw new StaleInput('this map does not record the sources it was built from; build it again');
  if (fileDigest(P.root, [...P.mods.keys()]) !== P.srcDigest) throw new StaleInput(`the sources under ${P.root} changed after this map was built; build it again`);
}
