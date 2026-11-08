// Pass 1 of the TS/JS reader: definition index over every file plus the import/export resolver pass 2 uses.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const TYPE_NOISE = new Set(['string', 'number', 'boolean', 'any', 'unknown', 'void', 'never', 'null', 'undefined', 'object', 'Record', 'Map', 'Set',
  'Date', 'Error', 'Buffer', 'Function', 'Object', 'Array', 'Promise', 'Partial', 'Required', 'Readonly', 'Omit', 'Pick', 'Awaited', 'ReadonlyArray']);
const WRAPPERS = new Set(['Promise', 'Array', 'Partial', 'Required', 'Readonly', 'Awaited', 'ReadonlyArray', 'Omit', 'Pick', 'Set']);

export async function loadTs(rootDir) {
  try { return (await import('typescript')).default; } catch { /* fall through */ }
  try { return createRequire(path.join(rootDir, 'package.json'))('typescript'); } catch { return null; }
}

export function scriptKindOf(ts, file) {
  const e = path.extname(file);
  return e === '.tsx' ? ts.ScriptKind.TSX : e === '.jsx' ? ts.ScriptKind.JSX : /^\.[mc]?js$/.test(e) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

export function parse(ts, abs, text, rel) {
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, scriptKindOf(ts, abs));
}

export function lineOf(sf) {
  const starts = sf.getLineStarts();
  return (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

const isFnExpr = (ts, n) => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
const unwrap = (ts, n) => { while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression?.(n) || ts.isTypeAssertionExpression?.(n))) n = n.expression; return n; };
export { unwrap };

/** Every function and class in source order with unique qualnames. */
export function collectDefs(ts, sf) {
  const out = [], seen = new Map();
  const uniq = (q) => { const n = (seen.get(q) || 0) + 1; seen.set(q, n); return n === 1 ? q : `${q}~${n}`; };
  const push = (d) => { out.push(d); return d; };
  const blockish = (c) => c.kind === ts.SyntaxKind.Block || c.kind === ts.SyntaxKind.CaseBlock || ts.isCaseClause(c) || ts.isDefaultClause(c)
    || ts.isCatchClause(c) || (c.kind >= ts.SyntaxKind.FirstStatement && c.kind <= ts.SyntaxKind.LastStatement);
  function nested(n, prefix, cls, parent) {
    ts.forEachChild(n, (c) => { if (blockish(c)) stmt(c, prefix, cls, parent); });
  }
  function fnDef(node, qual, name, cls, parent, extra = {}) {
    if (!node.body) return null;
    const d = push({ kind: 'func', qual, node, name, cls, parent, ...extra });
    const body = node.body;
    if (ts.isBlock(body)) nested(body, qual + '.', ts.isArrowFunction(node) ? cls : null, qual);
    return d;
  }
  function classDef(n, prefix, parent, name, namedBy) {
    const q = uniq(prefix + (name || 'default'));
    push({ kind: 'class', qual: q, node: n, name: name || 'default', cls: null, parent });
    for (const m of n.members) {
      const static_ = !!(ts.getCombinedModifierFlags?.(m) & ts.ModifierFlags.Static);
      if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
        const nm = m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) || ts.isPrivateIdentifier(m.name)) ? m.name.text : null;
        if (nm) fnDef(m, uniq(`${q}.${nm}`), nm, q, parent, { static: static_ });
      } else if (ts.isConstructorDeclaration(m)) fnDef(m, uniq(`${q}.constructor`), 'constructor', q, parent, { static: false });
      else if (ts.isPropertyDeclaration(m) && m.initializer && isFnExpr(ts, m.initializer) && m.name && m.name.text) {
        fnDef(m.initializer, uniq(`${q}.${m.name.text}`), m.name.text, q, parent, { static: static_, prop: true });
      } else if (ts.isClassStaticBlockDeclaration?.(m)) nested(m.body, q + '.', q, parent);
    }
  }
  function objectMethods(obj, q, cls, parent) {
    for (const p of obj.properties) {
      const nm = p.name && p.name.text;
      if (!nm) continue;
      if (ts.isMethodDeclaration(p)) fnDef(p, uniq(`${q}.${nm}`), nm, cls, parent, { objMethod: true });
      else if (ts.isPropertyAssignment(p)) {
        const v = unwrap(ts, p.initializer);
        if (isFnExpr(ts, v)) fnDef(v, uniq(`${q}.${nm}`), nm, cls, parent, { objMethod: true });
      }
    }
  }
  function varDecl(d, prefix, cls, parent) {
    const v = unwrap(ts, d.initializer);
    if (ts.isIdentifier(d.name) && v) {
      const name = d.name.text;
      if (isFnExpr(ts, v)) fnDef(v, uniq(prefix + name), name, cls, parent, { declName: d.name });
      else if (ts.isClassExpression(v)) classDef(v, prefix, parent, name);
      else if (ts.isObjectLiteralExpression(v)) objectMethods(v, prefix + name, cls, parent);
    }
  }
  function stmt(n, prefix, cls, parent) {
    if (ts.isFunctionDeclaration(n)) { if (n.body) fnDef(n, uniq(prefix + (n.name ? n.name.text : 'default')), n.name ? n.name.text : 'default', null, parent); return; }
    if (ts.isClassDeclaration(n)) { classDef(n, prefix, parent, n.name && n.name.text); return; }
    if (ts.isVariableStatement(n)) { for (const d of n.declarationList.declarations) varDecl(d, prefix, cls, parent); return; }
    if (ts.isModuleDeclaration(n)) {
      let body = n.body, p = prefix + (n.name.text || '') + '.';
      while (body && ts.isModuleDeclaration(body)) { p += body.name.text + '.'; body = body.body; }
      if (body && ts.isModuleBlock(body)) for (const s of body.statements) stmt(s, p, cls, parent);
      return;
    }
    if (ts.isExportAssignment(n)) {
      const v = unwrap(ts, n.expression);
      if (isFnExpr(ts, v)) fnDef(v, uniq(prefix + 'default'), 'default', cls, parent);
      else if (ts.isClassExpression(v)) classDef(v, prefix, parent, 'default');
      else if (ts.isObjectLiteralExpression(v)) objectMethods(v, prefix + 'default', cls, parent);
      return;
    }
    if (ts.isExpressionStatement(n) && ts.isBinaryExpression(n.expression) && n.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = n.expression.left, r = unwrap(ts, n.expression.right);
      const t = l.getText ? null : null;
      const chain = propChain(ts, l);
      if (chain && isFnExpr(ts, r)) {
        let c = chain.slice();
        if (c[0] === 'module' && c[1] === 'exports') c = c.slice(2);
        else if (c[0] === 'exports') c = c.slice(1);
        const protoAt = c.indexOf('prototype');
        if (protoAt >= 0) c.splice(protoAt, 1);
        if (c.length) { const nm = c[c.length - 1]; fnDef(r, uniq(prefix + c.join('.')), nm, null, parent); return; }
      } else if (chain && ts.isClassExpression(r)) { classDef(r, prefix, parent, chain[chain.length - 1]); return; }
      void t;
      return;
    }
    if (isFnExpr(ts, n)) return;
    nested(n, prefix, cls, parent);
  }
  for (const s of sf.statements) stmt(s, '', null, null);
  return out;
}

export function propChain(ts, node) {
  const parts = [];
  let n = node;
  while (n) {
    n = unwrap(ts, n);
    if (ts.isPropertyAccessExpression(n)) { parts.push(n.name.text); n = n.expression; }
    else if (ts.isIdentifier(n)) { parts.push(n.text); return parts.reverse(); }
    else if (n.kind === ts.SyntaxKind.ThisKeyword) { parts.push('this'); return parts.reverse(); }
    else if (n.kind === ts.SyntaxKind.SuperKeyword) { parts.push('super'); return parts.reverse(); }
    else return null;
  }
  return null;
}

/** Candidate class names in a type annotation, reading order. */
export function typeNames(ts, tn, out = [], depth = 0) {
  if (!tn || depth > 6) return out;
  if (ts.isTypeReference?.(tn) || tn.kind === ts.SyntaxKind.TypeReference) {
    const nm = ts.isIdentifier(tn.typeName) ? tn.typeName.text : tn.typeName.right.text;
    if (!TYPE_NOISE.has(nm)) out.push(nm);
    if (!TYPE_NOISE.has(nm) || WRAPPERS.has(nm)) for (const a of tn.typeArguments || []) typeNames(ts, a, out, depth + 1);
  } else if (ts.isUnionTypeNode(tn) || ts.isIntersectionTypeNode(tn)) for (const t of tn.types) typeNames(ts, t, out, depth + 1);
  else if (ts.isParenthesizedTypeNode(tn)) typeNames(ts, tn.type, out, depth + 1);
  else if (ts.isArrayTypeNode(tn)) typeNames(ts, tn.elementType, out, depth + 1);
  else if (ts.isTypeOperatorNode?.(tn)) typeNames(ts, tn.type, out, depth + 1);
  return out;
}

export class ClassInfo {
  constructor(qual, name, line, end) { Object.assign(this, { qual, name, line, end, bases: [], methods: new Map(), statics: new Map(), props: new Map(), fields: new Set(), hidden: new Set(), isEnum: false }); }
}

export class ModInfo {
  constructor(p) {
    Object.assign(this, { path: p, dir: path.posix.dirname(p), funcs: new Map(), top: new Map(), classes: new Map(), vars: new Map(),
      imports: new Map(), exports: new Map(), stars: [], reexports: new Map(), rawImports: [] });
  }
}

export function importsOf(ts, sf) {
  const out = [];
  const add = (spec, node, bind) => out.push({ spec, bind, line: node.pos });
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      const spec = s.moduleSpecifier.text, ic = s.importClause;
      if (!ic) { add(spec, s, null); continue; }
      if (ic.name) add(spec, s, { local: ic.name.text, name: 'default' });
      const nb = ic.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) add(spec, s, { local: nb.name.text, name: '*' });
      else if (nb) for (const e of nb.elements) add(spec, s, { local: e.name.text, name: (e.propertyName || e.name).text });
    } else if (ts.isImportEqualsDeclaration(s) && ts.isExternalModuleReference(s.moduleReference) && ts.isStringLiteral(s.moduleReference.expression)) {
      add(s.moduleReference.expression.text, s, { local: s.name.text, name: '*' });
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        const c = d.initializer && unwrap(ts, d.initializer);
        const req = c && ts.isCallExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'require' && c.arguments[0] && ts.isStringLiteral(c.arguments[0]) ? c.arguments[0].text : null;
        if (!req) continue;
        if (ts.isIdentifier(d.name)) add(req, s, { local: d.name.text, name: '*' });
        else if (ts.isObjectBindingPattern(d.name)) for (const e of d.name.elements) if (ts.isIdentifier(e.name)) add(req, s, { local: e.name.text, name: (e.propertyName || e.name).text });
      }
    }
  }
  return out;
}

export class TsIndex {
  constructor(rootDir, paths, tsconfig) {
    this.root = rootDir; this.paths = new Set(paths); this.mods = new Map();
    this.methodIndex = new Map(); this.clsTokens = new Map(); this.enumNames = new Set();
    this.aliases = tsconfig || { baseUrl: null, paths: [] };
  }
  add(mi, indexMethods = true) {
    this.mods.set(mi.path, mi);
    if (!indexMethods) return;
    for (const [q, ci] of mi.classes) {
      for (const [m, mq] of ci.methods) { if (!this.methodIndex.has(m)) this.methodIndex.set(m, []); this.methodIndex.get(m).push(`${mi.path}::${mq}`); }
      const low = ci.name.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g)?.map((w) => w.toLowerCase()) || [];
      for (let i = 0; i < low.length; i++) { const k = low.slice(i).join('_'); if (!this.clsTokens.has(k)) this.clsTokens.set(k, []); this.clsTokens.get(k).push([mi.path, q]); }
    }
  }
  resolveFile(fromPath, spec) {
    const cands = [];
    const tryBase = (base) => {
      base = path.posix.normalize(base);
      cands.push(base);
      const ext = path.posix.extname(base);
      const stem = ext ? base.slice(0, -ext.length) : base;
      if (/^\.[mc]?js$/.test(ext)) for (const e of (ext === '.mjs' ? ['.mts'] : ext === '.cjs' ? ['.cts'] : ['.ts', '.tsx'])) cands.push(stem + e);
      for (const e of EXTS) cands.push(base + e);
      for (const e of EXTS) cands.push(base + '/index' + e);
    };
    if (spec.startsWith('.')) tryBase(path.posix.join(path.posix.dirname(fromPath), spec));
    else {
      for (const a of this.aliases.paths) {
        const m = a.re.exec(spec);
        if (m) for (const t of a.targets) tryBase(path.posix.join(this.aliases.baseUrl || '', t.replace('*', m[1] || '')));
      }
      if (this.aliases.baseUrl !== null) tryBase(path.posix.join(this.aliases.baseUrl, spec));
    }
    for (const c of cands) if (this.paths.has(c)) return c;
    return null;
  }
  link() {
    for (const mi of this.mods.values()) {
      for (const im of mi.rawImports) {
        const target = this.resolveFile(mi.path, im.spec);
        const ext = im.spec.startsWith('.') ? null : (im.spec.startsWith('@') ? im.spec.split('/').slice(0, 2).join('/') : im.spec.split('/')[0]);
        im.target = target; im.ext = target ? null : ext;
        if (im.bind) mi.imports.set(im.bind.local, { path: target, ext: target ? null : ext, name: im.bind.name });
      }
    }
  }
  // ---- symbol resolution ---------------------------------------------------
  /** What an exported name of module `p` is. */
  exportOf(p, name, depth = 0, seen = new Set()) {
    const mi = this.mods.get(p);
    if (!mi || depth > 8 || seen.has(p + '#' + name)) return null;
    seen.add(p + '#' + name);
    if (name === '*') return ['mod', p];
    const local = mi.exports.get(name);
    if (local) return this.localSym(mi, local, depth);
    const re = mi.reexports.get(name);
    if (re) {
      const t = this.resolveFile(p, re.spec);
      if (!t) return ['ext', re.spec];
      return re.name === '*' ? ['mod', t] : this.exportOf(t, re.name, depth + 1, seen);
    }
    for (const s of mi.stars) {
      const t = this.resolveFile(p, s);
      if (!t) continue;
      const r = this.exportOf(t, name, depth + 1, seen);
      if (r) return r;
    }
    return null;
  }
  localSym(mi, local, depth = 0) {
    if (local.k === 'local') return this.lookupLocal(mi.path, local.name, depth + 1);
    return local.k === 'func' ? ['func', `${mi.path}::${local.qual}`] : local.k === 'class' ? ['class', mi.path, local.qual] : ['other'];
  }
  /** A top-level name in module `p`: own declaration, else its import. */
  lookupLocal(p, name, depth = 0) {
    const mi = this.mods.get(p);
    if (!mi || depth > 8) return null;
    if (mi.top.has(name)) { const t = mi.top.get(name); return t.k === 'func' ? ['func', `${p}::${t.qual}`] : ['class', p, t.qual]; }
    if (mi.vars.has(name)) {
      const v = mi.vars.get(name);
      const c = this.resolveClass(mi, v);
      if (c) return ['inst', c[0], c[1]];
    }
    const im = mi.imports.get(name);
    if (im) return this.followImport(im, depth);
    return null;
  }
  followImport(im, depth = 0) {
    if (!im.path) return ['ext', im.ext];
    if (im.name === '*') return ['mod', im.path];
    return this.exportOf(im.path, im.name, depth + 1) || null;
  }
  resolveClass(mi, name) {
    const r = this.lookupLocal(mi.path, name);
    return r && (r[0] === 'class' || r[0] === 'inst') ? [r[1], r[2]] : null;
  }
  findMethod(p, cq, name, seen = new Set(), staticOnly = false) {
    const key = p + '#' + cq;
    if (seen.has(key)) return null;
    seen.add(key);
    const mi = this.mods.get(p), ci = mi && mi.classes.get(cq);
    if (!ci) return null;
    const m = ci.methods.get(name);
    if (m) return `${p}::${m}`;
    for (const b of ci.bases) {
      const bc = this.resolveClass(mi, b);
      if (bc) { const r = this.findMethod(bc[0], bc[1], name, seen); if (r) return r; }
    }
    return null;
  }
  propType(p, cq, prop, seen = new Set()) {
    const key = p + '#' + cq;
    if (seen.has(key)) return null;
    seen.add(key);
    const mi = this.mods.get(p), ci = mi && mi.classes.get(cq);
    if (!ci) return null;
    for (const tn of ci.props.get(prop) || []) { const r = this.resolveClass(mi, tn); if (r) return r; }
    for (const b of ci.bases) {
      const bc = this.resolveClass(mi, b);
      if (bc) { const r = this.propType(bc[0], bc[1], prop, seen); if (r) return r; }
    }
    return null;
  }
  returnClass(fnId) {
    const i = fnId.indexOf('::');
    const mi = this.mods.get(fnId.slice(0, i));
    for (const n of (mi && mi.ret && mi.ret.get(fnId.slice(i + 2))) || []) { const c = this.resolveClass(mi, n); if (c) return c; }
    return null;
  }
  hasOpenBases(p, cq) {
    const mi = this.mods.get(p), ci = mi && mi.classes.get(cq);
    return !ci || ci.bases.some((b) => !this.resolveClass(mi, b));
  }
  guessMethod(recv, name) {
    const found = [];
    for (const [p, q] of this.clsTokens.get(recv.replace(/^_+/, '').toLowerCase()) || []) {
      const m = this.findMethod(p, q, name);
      if (m && !found.includes(m)) found.push(m);
    }
    return found.length === 1 ? found[0] : null;
  }
}

/** tsconfig paths -> [{re, targets}]; comments allowed. Missing file gives the empty alias set. */
export function readAliases(ts, rootDir) {
  const out = { baseUrl: null, paths: [] };
  try {
    const f = path.join(rootDir, 'tsconfig.json');
    if (!fs.existsSync(f)) return out;
    const j = ts.parseConfigFileTextToJson(f, fs.readFileSync(f, 'utf8')).config || {};
    const co = j.compilerOptions || {};
    if (co.baseUrl) out.baseUrl = path.posix.normalize(co.baseUrl.replace(/\\/g, '/')).replace(/^\.$/, '');
    for (const [k, v] of Object.entries(co.paths || {})) {
      const re = new RegExp('^' + k.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*', '(.*)') + '$');
      out.paths.push({ re, targets: v.map((t) => path.posix.normalize(t.replace(/\\/g, '/'))) });
      if (out.baseUrl === null) out.baseUrl = '';
    }
  } catch { /* unreadable tsconfig: plain relative imports only */ }
  return out;
}
