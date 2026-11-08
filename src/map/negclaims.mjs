// A negative claim has THREE values: proven | unknown | not claimed.
//
// A negative claim says something is absent: nobody catches this raise, nothing calls this function, nothing reads this field, nothing can reach this
// handler, nobody hears this ending. Absence in the graph is proof only when the graph is complete where it matters, so:
//
//   "Nobody catches it" needs every caller resolved (no call site left that might be one), no same-name unresolved call site, no reference to the
//   function as a value (a callback), no framework that may call it, and the chain must end at module-level code (the interpreter), not at a
//   function that merely has no caller we can see (an entry point, a callback or dead code: we cannot tell which). Otherwise it says
//   `unknown: N open ends`, and N is the number of distinct reasons found.
//
// Without the language's type checker installed NO negative claim about that language's code is made at all: the value is `unknown` and the first
// open end is "no type checker".
//
// An open end is a pair (kind, detail):
//   unresolved-call-same-name   n call sites named like the function that no resolver pinned elsewhere
//   referenced-as-value         the name is passed or stored as a value (a callback, a handler table)
//   named-in-string             the name appears as a string literal given to getattr / hasattr / setattr, or as text when nothing calls it
//   decorated                   a decorator may register it with a framework
//   framework-base              a method of a class whose base lives outside the project
//   protocol-method             a dunder method the language calls itself
//   dynamic-attribute-access    getattr(x, <expression>) and friends exist where this could be reached
//   no-caller                   no call site resolves to it: an entry point, a callback, or dead
import { PLAIN_DECOS, fnImports } from './lookup.mjs';
import { mro, resolveClass } from './classes.mjs';
import { sorted, cpSlice, fullmatch, inc } from './pyrt.mjs';
import { tkey } from './canon.mjs';

export const PROVEN = 'proven';
export const UNKNOWN = 'unknown';
export { PLAIN_DECOS };
const HARMLESS_BASES = new Set(`object ABC abc.ABC Protocol Generic Enum IntEnum StrEnum Flag IntFlag str int float dict list set tuple bytes NamedTuple TypedDict
  Exception BaseException RuntimeError ValueError TypeError OSError KeyError LookupError ArithmeticError Error typing.Protocol typing.NamedTuple
  typing.TypedDict`.split(/\s+/));
const DYN_READ = new Set(['getattr', 'setattr', 'delattr', 'hasattr']);
// methods the language itself calls: string conversion, JSON, arithmetic on objects, thenables, iterators
const LANGUAGE_CALLS = new Set(['toString', 'toJSON', 'valueOf', 'toLocaleString', 'then', 'catch', 'finally', 'next', 'return', 'throw', 'constructor', 'toISOString']);
// context managers whose __exit__ is known not to swallow what is raised in the block
const NONSWALLOW = [['builtins', 'open'], ['io|_io', '.*'], ['threading', '.*'], ['tempfile', '.*'], ['zipfile|tarfile|gzip|bz2|lzma|wave|codecs', '.*'],
  ['sqlite3|_sqlite3', '.*'], ['subprocess', 'Popen.*'], ['socket', '.*'], ['pathlib(?:\\..*)?', '.*'], ['contextlib', 'closing|nullcontext|redirect_stdout|redirect_stderr|chdir'],
  ['fs|node:fs.*', '.*']];

/** The last dotted part of a name, without a `~2` suffix. */
export const lastName = (name) => {
  const s = name || '';
  return s.slice(s.lastIndexOf('.') + 1).split('~')[0];
};
const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);
/** The file name without its last extension: path.rsplit('/', 1)[-1].rsplit('.', 1)[0] */
const baseNoExt = (p) => {
  const b = p.slice(p.lastIndexOf('/') + 1);
  return b.includes('.') ? b.slice(0, b.lastIndexOf('.')) : b;
};

/** A call that might land on a project function without us knowing it. */
function unresolved(o) {
  if (o.to?.length) return false;
  return !(o.rs === 'ext' || o.how === 'builtin' || o.how === 'ext');
}

const count = (m, k) => m.get(k) ?? 0;

export class Neg {
  constructor(P, F) {
    this.P = P;
    this.F = F;
    this._with = new Map();
    this._imp = null;
    this._silent = new Map(); // shared memo of heard3.silentFn
    this.unres = new Map(); // last name -> [[fid, line]] of calls nothing pinned down
    this.valref = new Map(); // last name -> how often it is used as a value
    this.litnames = new Set(); // names handed to getattr / hasattr / setattr as a string
    this.dynSelf = new Map(); // class key -> getattr(self, <expression>) sites
    this.dynObj = new Map(); // language -> getattr(<object>, <expression>) / obj[<expression>]: can reach a method or field of any object
    this.dynMod = new Map(); // language -> getattr(<imported module>, <expression>): can reach a module-level function
    this.dynGlobal = new Map(); // language -> eval / exec / import_module(<expression>): can reach anything by name
    this.dynFile = new Map(); // path -> globals() in that module
    this.dynImport = new Set(); // last name of every module imported by a literal string at run time
    this.extbase = new Map();
    this._subdyn = new Map();
    for (const fid of P.fids) {
      const fn = P.fns.get(fid);
      for (const nd of fn.nodes) {
        for (const o of nd.ops ?? []) {
          if (o.t === 'call' && o.f) {
            const nm = lastName(o.f);
            if (DYN_READ.has(o.f)) {
              if (Object.hasOwn(o, 'a1')) this.litnames.add(o.a1);
              else {
                const recv = (o.cb ?? [])[0] ?? '';
                const imp = P.mods.get(fn.path).imports;
                const ent = Object.hasOwn(imp, recv.split('.')[0]) ? imp[recv.split('.')[0]] : null;
                if ((recv === 'self' || recv === 'cls') && fn.cls) inc(this.dynSelf, fn.cls);
                else if (ent && ent[0] === 'mod') inc(this.dynMod, fn.lang);
                else inc(this.dynObj, fn.lang);
              }
            } else if (o.f === 'globals') inc(this.dynFile, fn.path); // names in this module can be looked up or assigned by string
            else if (['importlib.import_module', 'import_module', '__import__'].includes(o.f) && o.a0) {
              this.dynImport.add(lastDot(o.a0.replace(/^\.+|\.+$/g, ''))); // that module is loaded by name: its names can be reached by attribute
            } else if (['eval', 'exec', '__import__', 'importlib.import_module', 'import_module'].includes(o.f)) inc(this.dynGlobal, fn.lang);
            if (unresolved(o)) {
              if (!this.unres.has(nm)) this.unres.set(nm, []);
              this.unres.get(nm).push([fid, o.line]);
            }
            for (const c of o.cb ?? []) inc(this.valref, lastName(c));
          } else if (o.t === 'dyn') {
            if (o.recv === 'self' && fn.cls) inc(this.dynSelf, fn.cls);
            else inc(this.dynObj, fn.lang);
          } else if (o.t === 'set' && typeof o.v === 'string' && (o.v.startsWith('name:') || o.v.startsWith('attr:'))) {
            inc(this.valref, lastName(o.v.slice(o.v.indexOf(':') + 1)));
          }
        }
        if (nd.k === 'return' && /^ret:(name|attr):/.test(String(nd.sig ?? ''))) inc(this.valref, lastName(nd.sig.split(':').slice(2).join(':')));
      }
    }
  }

  /** Is a claim about this function's language allowed at all? */
  enabled(fid) {
    return !!this.P.resolvers[this.P.mods.get(this.P.fns.get(fid).path).lang];
  }

  extBase(ck) {
    if (this.extbase.has(ck)) return this.extbase.get(ck);
    const P = this.P;
    let res = null;
    for (const k of mro(P, ck)) {
      const c = P.classes.get(k);
      for (const b of c.bases) {
        if (resolveClass(P, b, c.mod) === null && !HARMLESS_BASES.has(lastDot(b)) && !HARMLESS_BASES.has(b)) { res = b; break; }
      }
      if (res) break;
    }
    this.extbase.set(ck, res);
    return res;
  }

  subclassDyn(ck) {
    if (this._subdyn.has(ck)) return this._subdyn.get(ck);
    let n = 0;
    const own = mro(this.P, ck);
    for (const k of this.P.classes.keys()) if (mro(this.P, k).includes(ck) || own.includes(k)) n += count(this.dynSelf, k);
    this._subdyn.set(ck, n);
    return n;
  }

  /** The `with` contexts around node n of function fid whose manager may swallow an exception raised inside the block (an ordinary class with an
   *  __exit__ that returns True, an @contextmanager that catches). Known non-swallowing managers (files, locks ...) are not listed. */
  swallowingWith(fid, n) {
    const ctxs = this.P.fns.get(fid).nodes[n].w ?? [];
    if (!ctxs.length) return [];
    if (!this._with.has(fid)) {
      const m = new Map();
      for (const nd of this.P.fns.get(fid).nodes) for (const o of nd.ops ?? []) if (o.t === 'with' && !m.has(o.ctx ?? null)) m.set(o.ctx ?? null, o);
      this._with.set(fid, m);
    }
    const out = [];
    for (const c of ctxs) {
      const o = this._with.get(fid).get(c);
      if (o === undefined) { out.push(c); continue; }
      if ((o.eff ?? []).includes('lockwith') || (lastDot(o.f ?? '') === 'open' && o.rs !== 'project')) continue;
      if (o.to?.length || !o.defs?.length) { out.push(c); continue; } // a project manager, or one nothing is known about
      if (!o.defs.every(([mm, qq]) => NONSWALLOW.some(([a, b]) => fullmatch(a, mm) && fullmatch(b, qq)))) out.push(c);
    }
    return out;
  }

  /** Project modules that import the module at `path`, at module level or inside a function: the code that runs its module-level statements.
   *  Importing `a.b.c` runs the `__init__` of `a` and of `a.b` too, so they count as importers of those packages. */
  importers(path) {
    if (this._imp === null) {
      const P = this.P;
      this._imp = new Map();
      const note = (rel, ents) => {
        for (const v of ents) {
          const cands = [v[1], ...(v.length > 2 ? [`${v[1]}.${v[2]}`] : [])];
          for (const c of cands) {
            const parts = c.split('.');
            for (let k = 1; k <= parts.length; k++) {
              const tgt = P.modname.get(parts.slice(0, k).join('.'));
              if (tgt && tgt !== rel) {
                if (!this._imp.has(tgt)) this._imp.set(tgt, new Set());
                this._imp.get(tgt).add(rel);
              }
            }
          }
        }
      };
      for (const [rel, m] of P.mods) note(rel, Object.values(m.imports));
      for (const fn of P.fns.values()) if (fn.limp && Object.keys(fn.limp).length) note(fn.path, fnImports(P, fn).values());
    }
    return sorted(this._imp.get(path) ?? []);
  }

  /** Is this module run directly (a `__main__` guard, or a file named __main__)? Only then is 'nobody imports it' the end of the line. */
  isScript(path) {
    if (path.endsWith('__main__.py')) return true;
    const fn = this.P.fns.get(`${path}::<module>`);
    return !!fn && fn.nodes.some((n) => String(n.test ?? '').includes('__main__'));
  }

  /** Why a function may have callers that the graph does not show (no `no-caller` here: the caller of this method adds it). -> [[kind, detail]] */
  openEnds(g) {
    const P = this.P;
    const fn = P.fns.get(g);
    const short = lastName(fn.qual);
    const out = [];
    const u = this.unres.get(short);
    if (u?.length) out.push(['unresolved-call-same-name', u.length]);
    if (this.valref.get(short)) out.push(['referenced-as-value', this.valref.get(short)]);
    if (P.hidden.has(short) && fn.qual !== '<module>') out.push(['referenced-in-unread-code', short]); // named inside a lambda, a default argument, a decorator or a class body
    if (fn.dflt) out.push(['default-export', short]); // whoever imports a default export gives it a name of their own, in this project or outside it
    if (this.litnames.has(short)) out.push(['named-in-string', short]);
    else if (P.strs.has(short) && fn.qual !== '<module>' && !this.F.callers.get(g)?.length) out.push(['named-in-string', short]); // no caller is shown and the name is written as text somewhere
    const decos = (fn.decos ?? []).filter((d) => !PLAIN_DECOS.has(d) && !PLAIN_DECOS.has(d.split('(')[0]));
    if (decos.length) out.push(['decorated', cpSlice(decos[0], 0, 40)]);
    let n;
    if (fn.cls) {
      const b = this.extBase(fn.cls);
      if (b && (fn.lang === 'py' || fn.ob || !P.resolvers.ts)) out.push(['framework-base', cpSlice(b, 0, 40)]); // TS with a checker: only members an outside base declares
      n = this.subclassDyn(fn.cls) + count(this.dynObj, fn.lang) + count(this.dynGlobal, fn.lang); // a method can be fetched off any object by a computed name
    } else n = count(this.dynMod, fn.lang) + count(this.dynGlobal, fn.lang); // a function only off a module, or from globals()
    if ((short.startsWith('__') && short.endsWith('__') && short !== '__init__') || (fn.lang !== 'py' && fn.cls && (LANGUAGE_CALLS.has(short) || short.startsWith('[')))) out.push(['protocol-method', short]);
    const mod = baseNoExt(fn.path);
    const segs = fn.path.split('/');
    n += count(this.dynFile, fn.path) + (this.dynImport.has(mod) || (mod === '__init__' && this.dynImport.has(segs[segs.length - 2])) ? 1 : 0);
    if (n && fn.qual !== '<module>' && fn.lang === 'py') out.push(['dynamic-attribute-access', n]);
    return out;
  }

  // ---- nobody catches it -----------------------------------------------------------------------------------------------
  /** Fates of exception type t raised at (fid, node), up the call graph. Each fate: {by, fn, depth, may, ...}
   *   handler  a handler takes it                    top   nothing took it and the chain ended at module-level code
   *   open     the chain ended where callers may exist that we cannot see (why = the open ends)
   *   deep     the search limit.      `may` = a possible (not proven) call edge is on the path. */
  hear3(fid, node, t, maxdepth = 6, cap = 14) {
    const { F, P } = this;
    const fates = [];
    const seen = new Set();
    const opened = new Set();
    const q = [[fid, node, 0, false]];
    while (q.length && fates.length < cap) {
      const [f, n, d, may0] = q.shift();
      let may = may0;
      const sw = this.swallowingWith(f, n);
      if (sw.length) fates.push({ by: 'open', fn: f, why: sw.slice(0, 2).map((c) => ['with-block-may-swallow', cpSlice(c, 0, 40)]), depth: d, may });
      const res = F.land(f, n, t);
      let esc = false;
      for (const r of res) {
        if (r[0] === 'caught') fates.push({ by: 'handler', fn: f, h: r[1], line: P.fns.get(f).nodes[r[1]].line, depth: d, may: may || r[2], hmay: r[2] });
        else esc = true;
      }
      if (res.some((r) => r[0] === 'caught' && r[2])) may = true; // the walk goes on only if a handler that may take it did not: whatever it reaches further up is only possible
      if (!esc) continue;
      const callers = sorted(F.callers.get(f) ?? []);
      const floats = (cf, cn) => F.floating.has(tkey(cf, cn, f));
      let cs = callers.filter(([cf, cn]) => !floats(cf, cn)).map(([cf, cn, ln, how, tier]) => [cf, cn, ln, how, tier, false]);
      if (callers.some(([cf, cn]) => floats(cf, cn))) fates.push({ by: 'open', fn: f, why: [['not-awaited-call', '']], depth: d, may }); // the promise goes somewhere else
      cs = cs.concat(sorted(F.candCallers.get(f) ?? []).map(([cf, cn, ln, how]) => [cf, cn, ln, how, 'may', true]));
      if (!opened.has(f)) {
        const why = this.openEnds(f);
        if (why.length) { fates.push({ by: 'open', fn: f, why, depth: d, may }); opened.add(f); }
      }
      const fnf = P.fns.get(f);
      if (!cs.length) {
        if (fnf.qual === '<module>') {
          const imps = this.importers(fnf.path);
          let mod = baseNoExt(fnf.path);
          if (mod === '__init__') mod = fnf.path.includes('/') ? fnf.path.split('/').slice(-2)[0] : mod;
          if (imps.length) fates.push({ by: 'open', fn: f, why: [['imported-by', imps.length]], depth: d, may }); // a module-level statement runs in whoever imports the module
          else if (this.dynImport.has(mod)) fates.push({ by: 'open', fn: f, why: [['imported-by-a-string', mod]], depth: d, may });
          else if (!this.isScript(fnf.path)) fates.push({ by: 'open', fn: f, why: [['module-may-be-imported-from-outside', '']], depth: d, may }); // a library module
          else fates.push({ by: 'top', fn: f, depth: d, may });
        } else if (fnf.exp) {
          // exported: callers outside the project exist by definition. They receive the exception (so the caller hears), and whether they catch it is
          // theirs to say: an open end for "nobody catches it", not a top.
          fates.push({ by: 'api', fn: f, depth: d, may, why: [['exported-callers-outside', '']] });
        } else fates.push({ by: 'open', fn: f, why: [['no-caller', '']], depth: d, may });
      } else if (d >= maxdepth) fates.push({ by: 'deep', fn: f, depth: d, may });
      else {
        for (const [cf, cn, , , tier, cand] of cs) {
          const k = tkey(cf, cn);
          if (!seen.has(k)) { seen.add(k); q.push([cf, cn, d + 1, may || tier === 'may' || cand]); }
        }
      }
    }
    return fates;
  }

  /** The claim "nobody catches it" for a raise whose fates are given. -> null when there is nothing to claim about (every path ends in a handler),
   *  else {value: proven | unknown, open: N, paths_uncaught, paths, why: [...]} */
  verdict(fid, fates) {
    const tops = fates.filter((f) => f.by === 'top');
    const opens = fates.filter((f) => ['open', 'deep', 'api'].includes(f.by));
    const hs = fates.filter((f) => f.by === 'handler');
    if (!tops.length && !opens.length) return null;
    const on = this.enabled(fid);
    const ends = [];
    for (const f of opens) for (const w of f.why ?? [['deep', '']]) ends.push([f.fn.slice(f.fn.indexOf('::') + 2), ...w]);
    for (const f of hs) {
      if (f.hmay) ends.push([f.fn.slice(f.fn.indexOf('::') + 2), 'handler-type-not-a-plain-class', String(this.P.fns.get(f.fn).nodes[f.h].line)]); // a handler whose type is not plainly a class may take it
    }
    const nOpen = new Set(ends.map((e) => tkey(e[0], e[1]))).size + (on ? 0 : 1);
    const proven = on && tops.length > 0 && !opens.length && !hs.length && !tops.some((f) => f.may);
    const why = [...(on ? [] : [['no-type-checker', '']]), ...ends.slice(0, 4).map((e) => e.slice(1))];
    return { value: proven ? PROVEN : UNKNOWN, open: proven ? 0 : Math.max(1, nOpen), paths_uncaught: tops.length + opens.length, paths: fates.length, why: why.slice(0, 5) };
  }
}
