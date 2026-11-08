// TypeScript and JavaScript -> the function-graph document (same shape as the Python reader's), with the type checker's answer folded into every call.
//   readTypeScript({ ts, root, prefix, exclude, only, tsconfig, check }) -> document
// Files: every .ts .tsx .js .mjs .cjs file under `root` whose path starts with `prefix` and not with any `exclude` prefix; declaration files, test and
// spec files and the folders in SKIP are left out. Given `only` (a list of paths), just those of them are kept.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makeChecker } from './tscheck.mjs';
import { makeGraph } from './tsgraph.mjs';
import { listDir, fileDigest } from './files.mjs';
import { cmpCp } from './canon.mjs';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.faultline', 'tests', 'test', '__tests__']);

function walkDir(d, rel = '') {
  const res = [];
  for (const e of listDir(d)) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDir) { if (!SKIP.has(e.name)) res.push(...walkDir(path.join(d, e.name), r)); }
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) res.push(r);
  }
  return res;
}

export async function readTypeScript({ ts, root, prefix = '', exclude = [], only = null, tsconfig = null, check = 'auto' }) {
const K = ts.SyntaxKind;
const incPrefix = prefix, excl = exclude;
let CHECK = check || null;                         // 'auto' | 'zero' | 'tsconfig' | null
const TSCONFIG_REL = tsconfig || null;
const wanted = only ? new Set(only) : null;
const files = walkDir(root).filter((r) => r.startsWith(incPrefix) && !excl.some((x) => r.startsWith(x)) && (!wanted || wanted.has(r)));
const modOf = (rel) => rel.replace(/\.(d\.)?(tsx?|jsx?|mjs|cjs)$/, '').replace(/\/index$/, '').replace(/\//g, '.');
const fileSet = new Set(files.map(modOf));
// the checker's configuration is part of the answer, so it is decided here and written to the header: a tsconfig.json at the root (or the one named
// with `tsconfig`) makes `paths` aliases such as "@/*" resolve; without one the checker runs zero-config
// the configuration to use: the one named; else, among the tsconfig.json files of the project (three levels down), the one that declares `paths` / `baseUrl` and
// sits over the most files; else the root one. A monorepo has one program here, so the package with the aliases wins.
function pickConfig() {
  const found = [];
  const walk = (d, rel, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => cmpCp(a.name, b.name))) {
      if (e.isDirectory() && depth < 3 && !SKIP.has(e.name) && e.name !== 'node_modules') walk(path.join(d, e.name), rel ? rel + '/' + e.name : e.name, depth + 1);
      else if (e.isFile() && e.name === 'tsconfig.json') found.push(rel ? rel + '/tsconfig.json' : 'tsconfig.json');
    }
  };
  walk(root, '', 0);
  let best = null, bestN = -1;
  for (const c of found) {
    let co = {};
    try { co = (ts.readConfigFile(path.join(root, c), ts.sys.readFile).config || {}).compilerOptions || {}; } catch { continue; }
    if (!co.paths && !co.baseUrl) continue;
    const dir = path.posix.dirname(c) === '.' ? '' : path.posix.dirname(c);
    const n = (co.paths ? 1e6 : 0) + files.filter((f) => !dir || f.startsWith(dir + '/')).length;       // aliases first, then the most files
    if (n > bestN) { best = c; bestN = n; }
  }
  return best || (found.includes('tsconfig.json') ? 'tsconfig.json' : null);
}
const rootCfg = TSCONFIG_REL || pickConfig();
if (CHECK === true || CHECK === 'auto') CHECK = rootCfg ? 'tsconfig' : 'zero';
const CFG_USED = CHECK === 'tsconfig' ? rootCfg : null;
let CK = null;
let CHECKER_STOP = null;
if (CHECK) {
  try { CK = makeChecker(ts, root, files, CHECK === 'tsconfig' ? 'tsconfig' : 'zero', CFG_USED || undefined); } catch (e) {
    // an expression nested deeper than the stack of this process: the checker binds the whole program at once, so it gives no answer for any file
    if (!(e instanceof RangeError)) throw e;
    CHECKER_STOP = 'the TypeScript checker ran out of stack on a very deeply nested expression, so TypeScript was read without it: no call is resolved by type';
    CHECK = null;
  }
}
// what the checker had to work with besides the project's own files
function nodeModulesDigest() {
  const nm = path.join(root, 'node_modules');
  if (!fs.existsSync(nm)) return 'absent';
  const out = [];
  for (const e of fs.readdirSync(nm, { withFileTypes: true }).sort((a, b) => cmpCp(a.name, b.name))) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dirs = e.name.startsWith('@') ? fs.readdirSync(path.join(nm, e.name)).sort().map((s) => e.name + '/' + s) : [e.name];
    for (const d of dirs) { try { out.push(d + '@' + JSON.parse(fs.readFileSync(path.join(nm, d, 'package.json'), 'utf8')).version); } catch { out.push(d + '@?'); } }
  }
  const h = createHash('sha256').update(out.join('\n')).digest('hex').slice(0, 12);
  return `present: ${out.length} packages, digest ${h}`;
}
const ENV = CHECK ? { tsc: ts.version, config: CHECK === 'tsconfig' ? (CFG_USED || 'tsconfig.json') : 'zero-config', node_modules: nodeModulesDigest() } : null;
// tsconfig `paths` aliases for the import map (lexical resolution), nearest tsconfig.json at or above the importing file
const cfgCache = new Map();
function cfgFor(dirRel) {
  let d = dirRel;
  const chain = [];
  for (;;) {
    if (cfgCache.has(d)) { const c = cfgCache.get(d); for (const x of chain) cfgCache.set(x, c); return c; }
    chain.push(d);
    const f = path.join(root, d, 'tsconfig.json');
    if (fs.existsSync(f)) {
      let co = {}, cur = f, depth = 0;
      while (cur && depth++ < 4) {
        const c = ts.readConfigFile(cur, ts.sys.readFile);
        const o = (c.config && c.config.compilerOptions) || {};
        co = { ...o, ...co, paths: { ...(o.paths || {}), ...(co.paths || {}) }, baseUrl: co.baseUrl || o.baseUrl };
        const ex = c.config && c.config.extends;
        cur = typeof ex === 'string' && ex.startsWith('.') ? path.resolve(path.dirname(cur), ex.endsWith('.json') ? ex : ex + '.json') : null;
      }
      const r = { dir: d, baseUrl: co.baseUrl, paths: co.paths };
      for (const x of chain) cfgCache.set(x, r);
      return r;
    }
    if (!d) break;
    d = path.posix.dirname(d); if (d === '.') d = '';
  }
  for (const x of chain) cfgCache.set(x, null);
  return null;
}
function aliasOf(spec, rel, fileSet, modOf) {
  const cfg = cfgFor(path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel));
  if (!cfg || !cfg.paths) return null;
  for (const [pat, targets] of Object.entries(cfg.paths)) {
    const star = pat.indexOf('*');
    let cap = null;
    if (star < 0) { if (spec !== pat) continue; cap = ''; }
    else { const pre = pat.slice(0, star), post = pat.slice(star + 1); if (!(spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length)) continue; cap = spec.slice(pre.length, spec.length - post.length); }
    for (const t of targets) {
      const base = path.posix.normalize(path.posix.join(cfg.dir, cfg.baseUrl || '.', t.replace('*', cap)));
      const m = base.replace(/\.(d\.)?(tsx?|jsx?|mjs|cjs)$/, '').replace(/\/index$/, '').replace(/\//g, '.');
      if (fileSet.has(m)) return m;
      if (fileSet.has(m + '.index')) return m + '.index';
    }
  }
  return null;
}
const PENDING = [], declFid = new Map();
const { build, calleeText } = makeGraph(ts, CK, PENDING);
const outFiles = [];
const pendingBefore = (n) => PENDING.length = Math.min(PENDING.length, n);
for (const rel of files) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const nPending = PENDING.length, nOut = outFiles.length;
  try {
  const sf = CK ? CK.sourceFile(rel) : ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : undefined);
  const mod = modOf(rel), imports = {}, classes = [], fns = [], seen = new Map();
  const resolve = (spec) => {
    if (!spec.startsWith('.')) { const al = aliasOf(spec, rel, fileSet, modOf); return al || spec.split('/')[0].replace(/^@/, '@'); }
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec.replace(/\.(js|mjs|cjs|ts)$/, '')));
    const m = base.replace(/\//g, '.');
    return fileSet.has(m) ? m : fileSet.has(m + '.index') ? m + '.index' : m;
  };
  for (const st of sf.statements) {
    if (st.kind === K.ImportDeclaration && st.importClause) {
      const m = resolve(st.moduleSpecifier.text), ic = st.importClause;
      if (ic.name) imports[ic.name.text] = ['name', m, 'default'];
      if (ic.namedBindings) {
        if (ic.namedBindings.kind === K.NamespaceImport) imports[ic.namedBindings.name.text] = ['mod', m];
        else for (const el of ic.namedBindings.elements) imports[el.name.text] = ['name', m, (el.propertyName || el.name).text];
      }
    }
  }
  const uniq = (q) => { const n = (seen.get(q) || 0) + 1; seen.set(q, n); return n > 1 ? `${q}~${n}` : q; };
  const isExp = (n) => !!(n && (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export));      // `export` (or `export default`) on the declaration
  const addFn = (node, qual, cls) => {
    const { rec, nested } = build(node, rel, uniq(qual), cls, sf);
    fns.push(rec);
    declFid.set(node, rec.id);
    // exp: something outside the project can call this (an exported function, or a non-private member of an exported class)
    const cd = node.parent && (node.parent.kind === K.ClassDeclaration || node.parent.kind === K.ClassExpression) ? node.parent : null;
    if (node.kind === K.FunctionDeclaration ? isExp(node) : cd ? isExp(cd) && !(ts.getCombinedModifierFlags(node) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) : false) rec.exp = 1;
    if ((node.kind === K.FunctionDeclaration && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default)) ||
        ((node.kind === K.ArrowFunction || node.kind === K.FunctionExpression) && node.parent && node.parent.kind === K.ExportAssignment && !node.parent.isExportEquals)) rec.dflt = 1; // the module's default export: its importers name it as they like
    if (CK && cd && node.name && CK.overridesExternal(node)) rec.ob = 1;      // an outside base class declares this member: it may call it
    for (const n of nested) visitDecl(n, qual + '.', null);
    return rec;
  };
  function visitDecl(n, prefix, cls) {
    if (n.kind === K.FunctionDeclaration && n.name && n.body) addFn(n, prefix + n.name.text, cls);
    else if ((n.kind === K.MethodDeclaration || n.kind === K.GetAccessor || n.kind === K.SetAccessor) && n.body && n.parent && n.parent.kind === K.ObjectLiteralExpression) {
      const rec = addFn(n, prefix + (n.name.kind === K.ComputedPropertyName ? `<anon@${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}>` : n.name.getText(sf)), cls);
      rec.prop = 1;                                  // a member of an object literal: reachable as obj.name, never as the bare name `name`
    } else if (n.kind === K.ArrowFunction || n.kind === K.FunctionExpression) {
      let nm = n.name ? n.name.text : null;
      const p = n.parent;
      let prop = false;
      if (!nm && p && p.kind === K.VariableDeclaration && p.name.kind === K.Identifier) nm = p.name.text;
      if (!nm && p && p.kind === K.PropertyAssignment && p.name.kind === K.Identifier) { nm = p.name.text; prop = true; }
      if (!nm && p && p.kind === K.BinaryExpression) nm = calleeText(p.left).replace(/^self\./, '');
      const rec = addFn(n, prefix + (nm || `<anon@${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}>`), cls);
      if (prop) rec.prop = 1;
    } else if (n.kind === K.ClassDeclaration || n.kind === K.ClassExpression) {
      let cn = n.name ? n.name.text : null;
      if (!cn && n.parent && n.parent.kind === K.VariableDeclaration && n.parent.name.kind === K.Identifier) cn = n.parent.name.text;
      cn = cn || '<anon>';
      const key = `${mod}:${prefix}${cn}`;
      const bases = (n.heritageClauses || []).filter((h) => h.token === K.ExtendsKeyword).flatMap((h) => h.types.map((t) => t.expression.getText(sf)));
      const c = { key, name: cn, bases, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, methods: {} };
      classes.push(c);
      for (const m of n.members) {
        if ((m.kind === K.MethodDeclaration || m.kind === K.Constructor || m.kind === K.GetAccessor || m.kind === K.SetAccessor) && m.body) {
          const nm = m.kind === K.Constructor ? 'constructor' : m.name.getText(sf);
          const rec = addFn(m, `${prefix}${cn}.${nm}`, key); c.methods[nm] = rec.id;
          if (nm === 'constructor') c.methods['__init__'] = rec.id;
        } else if (m.kind === K.PropertyDeclaration && m.initializer && (m.initializer.kind === K.ArrowFunction || m.initializer.kind === K.FunctionExpression)) {
          const rec = addFn(m.initializer, `${prefix}${cn}.${m.name.getText(sf)}`, key); c.methods[m.name.getText(sf)] = rec.id;
        }
      }
    }
  }
  const top = build(sf, rel, '<module>', null, sf); fns.push(top.rec);
  for (const n of top.nested) visitDecl(n, '', null);
  for (const st of sf.statements) {                 // exported / top-level const f = () => ...
    if (st.kind === K.VariableStatement) for (const d of st.declarationList.declarations) if (d.initializer && (d.initializer.kind === K.ArrowFunction || d.initializer.kind === K.FunctionExpression) && !fns.some((f) => f.line === sf.getLineAndCharacterOfPosition(d.initializer.getStart(sf)).line + 1 && f.qual.startsWith(d.name.getText(sf)))) visitDecl(d.initializer, '', null);
  }
  for (const st of sf.statements) { // `export default name;` makes a function declared elsewhere in the file the default export
    if (st.kind === K.ExportAssignment && !st.isExportEquals && st.expression.kind === K.Identifier) for (const f of fns) if (f.qual === st.expression.text) f.dflt = 1;
  }
  const decls = new Set();                          // every name this file declares: a global such as `console` is the global only if the file does not
  (function w(n) {
    if ((n.kind === K.VariableDeclaration || n.kind === K.Parameter || n.kind === K.FunctionDeclaration || n.kind === K.ClassDeclaration || n.kind === K.BindingElement) && n.name && n.name.kind === K.Identifier) decls.add(n.name.text);
    ts.forEachChild(n, w);
  })(sf);
  // every identifier read anywhere, and the ones read where the graph reader does not look (decorators, parameter defaults, class-body initializers,
  // heritage clauses, computed names, static blocks): used only to refuse an absence claim, never to draw a road
  const names = new Set(), hidden = new Set();
  const DECL = new Set([K.FunctionDeclaration, K.ClassDeclaration, K.MethodDeclaration, K.PropertyDeclaration, K.Parameter, K.VariableDeclaration, K.BindingElement, K.GetAccessor, K.SetAccessor,
    K.PropertyAssignment, K.PropertySignature, K.MethodSignature, K.EnumMember, K.TypeAliasDeclaration, K.InterfaceDeclaration, K.TypeParameter, K.EnumDeclaration, K.ModuleDeclaration, K.ImportClause, K.NamespaceImport, K.FunctionExpression, K.ClassExpression]);
  (function w(n, hid) {
    if (n.kind === K.Identifier) {
      const p = n.parent;
      const isDecl = p && ((p.name === n && DECL.has(p.kind)) || (p.kind === K.ImportSpecifier && p.propertyName && p.name === n));
      if (!isDecl) { names.add(n.text); if (hid) hidden.add(n.text); }
    }
    ts.forEachChild(n, (c) => {
      let h = hid;
      if (c.kind === K.Decorator || c.kind === K.HeritageClause || c.kind === K.ComputedPropertyName || c.kind === K.ClassStaticBlockDeclaration) h = true;
      else if (n.kind === K.Parameter && c === n.initializer) h = true;
      else if (n.kind === K.PropertyDeclaration && c === n.initializer && !(c.kind === K.ArrowFunction || c.kind === K.FunctionExpression)) h = true;
      w(c, h);
    });
  })(sf, false);
  const strs = new Set();
  (function w(n) { if ((n.kind === K.StringLiteral || n.kind === K.NoSubstitutionTemplateLiteral) && /^[A-Za-z_$][\w$]{0,60}$/.test(n.text)) strs.add(n.text); ts.forEachChild(n, w); })(sf);
  const perr = (sf.parseDiagnostics || []).length;
  outFiles.push({ path: rel, module: mod, lang: 'ts', ...(perr ? { errors: perr } : {}), lines: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1, imports, classes, fns, decls: [...decls].sort(), names: [...names].sort(), hidden: [...hidden].sort(), strs: [...strs].sort() });
  } catch (e) {
    // a statement nested or chained deeper than the stack of this process (or of the checker) can follow: the file is left out and the header says so
    if (!(e instanceof RangeError)) throw e;
    pendingBefore(nPending);
    outFiles.length = nOut;
    outFiles.push({ path: rel, module: modOf(rel), lang: 'ts', stop: 'too deeply nested for the reader (stack overflow): none of its functions are on the map', lines: text.split('\n').length, imports: {}, classes: [], fns: [], decls: [], names: [], hidden: [], strs: [] });
  }
}
if (CK) for (const { op, p } of PENDING) {
  try { op.r = CK.finish(p, declFid); } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    op.r = { to: [], may: [], cand: [], k: 'dynamic', x: [] }; // the checker could not follow this call chain: no answer
  }
}
return { schema: 'fldet.ir/1', ...(CHECKER_STOP ? { checker_stop: CHECKER_STOP } : {}), source_digest: fileDigest(root, outFiles.map((f) => f.path)), resolver: CK ? `tsc ${ts.version} (${CHECK === 'tsconfig' ? 'tsconfig' : 'zero-config'})` : undefined, env: ENV || undefined, files: outFiles };
}
