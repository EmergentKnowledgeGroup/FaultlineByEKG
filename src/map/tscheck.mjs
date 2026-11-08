// The TypeScript resolver: tsc's checker answers "what does this call land on?" for the TypeScript reader (tsir.mjs).
//   makeChecker(ts, root, files, mode) -> { program, sourceFile(rel), resolve(callNode) -> pending, finish(pending, declFid) -> r }
// r = { k: 'project'|'ext'|'dynamic'|'silent', to: [fid], may: [fid], cand: [fid], x: [[module, qualified name]] }
//   to    the one target the checker proves (a declared method or function with a body in the project)
//   may   targets that are only possible: the overrides and implementations found by NOMINAL class-hierarchy analysis
//         (extends / implements as written), and the several targets of an ambiguous union
//   cand  candidates that get NO road: classes that are merely STRUCTURALLY assignable to an interface or to an anonymous type
//         (a type literal is not a class hierarchy)
//   x     where an outside callee is defined: ['lib', 'String.replace'], ['node:fs', 'fs.writeFileSync'], ['some-package', 'Client.send']
import path from 'node:path';

const norm = (p) => p.replace(/\\/g, '/');

export function makeChecker(ts, root, files, mode, tsconfigRel) {
  const abs = files.map((f) => norm(path.resolve(root, f)));
  const projSet = new Set(abs);
  let options;
  const tsconfig = tsconfigRel ? path.resolve(root, tsconfigRel) : path.join(root, 'tsconfig.json');
  if (mode === 'tsconfig' && ts.sys.fileExists(tsconfig)) {
    const cfg = ts.readConfigFile(tsconfig, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(tsconfig));
    options = { ...parsed.options, allowJs: true, noEmit: true, incremental: false, declaration: false, composite: false, skipLibCheck: true };
  } else {
    options = { allowJs: true, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, jsx: ts.JsxEmit.Preserve, experimentalDecorators: true };
  }
  const host = ts.createCompilerHost(options, true);       // true: parents are set, the reader reads them
  const program = ts.createProgram(abs, options, host);
  const checker = program.getTypeChecker();
  const sourceFile = (rel) => program.getSourceFile(norm(path.resolve(root, rel)));

  const unwrap = (n) => { while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n))) n = n.expression; return n; };
  const isFn = (n) => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
  const resolveSym = (s) => (s && (s.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(s) : s);

  // ---- where is a declaration? -----------------------------------------------------------------------------------------
  function whereOf(d) {
    const f = norm(d.getSourceFile().fileName);
    if (projSet.has(f)) return { where: 'project' };
    const m = f.match(/\/node_modules\/(.*)$/);
    if (/(^|\/)typescript\/lib\/lib\.[A-Za-z0-9.]+\.d\.ts$/.test(f) || /^lib\.[A-Za-z0-9.]+\.d\.ts$/.test(path.basename(f))) return { where: 'ext', mod: 'lib' };
    if (m) {
      const sub = m[1];
      if (sub.startsWith('@types/node/')) return { where: 'ext', mod: 'node:' + sub.slice(12).replace(/(\/index)?\.d\.ts$/, '') };
      const parts = sub.replace(/^@types\//, '').split('/');
      return { where: 'ext', mod: parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] };
    }
    return { where: 'ext', mod: 'excluded:' + path.basename(f) };
  }
  function containerOf(d) {
    for (let p = d.parent; p; p = p.parent) {
      if ((ts.isClassLike(p) || ts.isInterfaceDeclaration(p)) && p.name) return p.name.text;
      if (ts.isTypeLiteralNode(p)) return '<type>';
      if (ts.isModuleDeclaration(p)) return null;           // `declare module 'fs' { function ... }`: the module is the container
    }
    return null;
  }
  const hasBody = (x) => (ts.isFunctionDeclaration(x) || ts.isMethodDeclaration(x) || ts.isConstructorDeclaration(x) || ts.isGetAccessor(x) || ts.isSetAccessor(x)) && !!x.body;
  function describe(d0) {
    let d = d0;                                               // an overload signature stands for the implementation that has the body
    if ((ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) || ts.isConstructorDeclaration(d)) && !d.body && d.symbol) d = d.symbol.declarations.find(hasBody) || d;
    const w = whereOf(d);
    const sf = d.getSourceFile();
    const nm = d.name && d.name.getText ? d.name.getText(sf) : ts.isConstructorDeclaration(d) ? 'constructor' : ts.isClassLike(d) && d.name ? d.name.text : '?';
    const cont = containerOf(d);
    return { ...w, node: d, qual: (cont ? cont + '.' : '') + nm, iface: ts.isMethodSignature(d) || ts.isPropertySignature(d) || ts.isCallSignatureDeclaration(d) || ts.isConstructSignatureDeclaration(d),
      abstractM: !!(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Abstract) };
  }
  // the node the reader registered under a function id for this declaration
  function fnNode(d) {
    if ((ts.isPropertyDeclaration(d) || ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer && isFn(unwrap(d.initializer))) return unwrap(d.initializer);
    if (ts.isClassLike(d)) { const c = d.members.find((m) => ts.isConstructorDeclaration(m) && m.body); return c || null; }
    return d;
  }

  // ---- class hierarchy, nominal only ---------------------------------------------------------------------------------------
  const classes = [];
  const visitClasses = (n) => { if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) { const t = checker.getTypeAtLocation(n); if (t && t.symbol) classes.push({ decl: n, sym: t.symbol, type: t }); } ts.forEachChild(n, visitClasses); };
  const srcFiles = program.getSourceFiles().filter((sf) => projSet.has(norm(sf.fileName)));
  for (const sf of srcFiles) visitClasses(sf);
  const parentsOf = new Map();
  const addParent = (c, p) => { if (!p) return; if (!parentsOf.has(c)) parentsOf.set(c, new Set()); parentsOf.get(c).add(p); };
  const visitHeritage = (n) => {
    if ((ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isInterfaceDeclaration(n)) && n.heritageClauses) {
      const t = checker.getTypeAtLocation(n);
      for (const hc of n.heritageClauses) for (const e of hc.types) { const s = resolveSym(checker.getSymbolAtLocation(e.expression)); if (t && t.symbol) addParent(t.symbol, s); }
    }
    ts.forEachChild(n, visitHeritage);
  };
  for (const sf of srcFiles) visitHeritage(sf);
  const descendants = new Map();                              // symbol -> classes that extend or implement it, as written
  for (const c of classes) {
    const seen = new Set(), stack = [c.sym];
    while (stack.length) { const s = stack.pop(); for (const p of parentsOf.get(s) || []) if (!seen.has(p)) { seen.add(p); stack.push(p); } }
    for (const p of seen) { if (!descendants.has(p)) descendants.set(p, new Set()); descendants.get(p).add(c); }
  }
  const structCache = new Map();
  function structuralSubs(sym) {                              // assignable but never declared: candidates, never roads
    if (structCache.has(sym)) return structCache.get(sym);
    const declared = descendants.get(sym) || new Set(), out = new Set();
    if (sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeLiteral)) {
      const target = checker.getDeclaredTypeOfSymbol(sym);
      for (const c of classes) { if (declared.has(c) || c.sym === sym) continue; try { if (checker.isTypeAssignableTo(c.type, target)) out.add(c); } catch { /* ignore */ } }
    }
    structCache.set(sym, out);
    return out;
  }
  function receiverSymbols(recv) {
    const out = new Set();
    const add = (t, depth) => {
      if (!t || depth > 5) return;
      if (t.isUnion && t.isUnion()) { t.types.forEach((x) => add(x, depth + 1)); return; }
      if (t.flags & ts.TypeFlags.Intersection) { t.types.forEach((x) => add(x, depth + 1)); return; }
      if (t.flags & ts.TypeFlags.TypeParameter) { const c = checker.getBaseConstraintOfType(t); if (c && c !== t) add(c, depth + 1); return; }
      const nn = checker.getNonNullableType(t); if (nn !== t) { add(nn, depth + 1); return; }
      if (t.symbol) out.add(t.symbol);
    };
    add(checker.getTypeAtLocation(recv), 0);
    return [...out];
  }
  function membersOf(c, nm) {
    const out = [];
    const mem = checker.getPropertyOfType(c.type, nm);
    for (const d of (mem && mem.declarations) || []) {
      if (ts.isMethodSignature(d) || ts.isPropertySignature(d)) continue;
      if ((ts.isMethodDeclaration(d) || ts.isGetAccessor(d)) && !d.body) continue;
      if (ts.isPropertyDeclaration(d) && !(d.initializer && isFn(unwrap(d.initializer)))) continue;
      out.push(d);
    }
    return out;
  }

  // does this method (of a project class) override or implement something an OUTSIDE base class declares? Then that base may call it.
  // A base the checker cannot see (unresolved import: type `any`) counts as yes: we do not know what it calls.
  function overridesExternal(m) {
    const cd = m.parent;
    if (!cd || !(ts.isClassDeclaration(cd) || ts.isClassExpression(cd)) || !m.name) return false;
    const nm = m.name.getText(m.getSourceFile());
    const seen = new Set();
    const walk = (t) => {
      if (!t || seen.has(t)) return false;
      seen.add(t);
      if (t.flags & ts.TypeFlags.Any) return true;
      const p = checker.getPropertyOfType(t, nm);
      if (p && (p.declarations || []).some((d) => !projSet.has(norm(d.getSourceFile().fileName)))) return true;
      let bases = [];
      try { bases = checker.getBaseTypes(t.target || t) || []; } catch { bases = []; }
      return bases.some(walk);
    };
    for (const hc of cd.heritageClauses || []) for (const e of hc.types) { const t = checker.getTypeAtLocation(e.expression); if (t && (t.flags & ts.TypeFlags.Any || walk(t))) return true; }
    return false;
  }

  // ---- one call ---------------------------------------------------------------------------------------------------------------
  function resolve(n) {
    const callee = n.expression;
    const p = { staticDecls: [], ext: [], impls: [], cands: [], kind: 'silent' };
    let sig = null;
    try { sig = checker.getResolvedSignature(n); } catch { sig = null; }
    let decls = sig && sig.declaration ? [sig.declaration] : [];
    let nameNode = unwrap(callee);
    nameNode = ts.isPropertyAccessExpression(nameNode) ? nameNode.name : ts.isElementAccessExpression(nameNode) ? nameNode.argumentExpression : nameNode;
    let sym = null;
    if (!decls.length) {
      sym = nameNode && (callee.kind === ts.SyntaxKind.SuperKeyword ? checker.getTypeAtLocation(callee).symbol : checker.getSymbolAtLocation(nameNode));
      const rs = resolveSym(sym);
      decls = ((rs && rs.declarations) || []).filter((d) => ts.isFunctionLike(d) || ts.isClassLike(d) || ts.isPropertySignature(d) || ts.isPropertyDeclaration(d) || ts.isVariableDeclaration(d) || ts.isMethodSignature(d));
      if (!decls.length) {
        const vd = ((rs && rs.declarations) || []).some((d) => ts.isParameter(d) || ts.isVariableDeclaration(d) || ts.isBindingElement(d));
        p.kind = vd ? 'dynamic' : 'silent';
      }
    }
    for (const d of decls) {
      if (ts.isParameter(d) || (ts.isVariableDeclaration(d) && !(d.initializer && isFn(unwrap(d.initializer))))) { p.kind = 'dynamic'; continue; }
      const ds = describe(d);
      if (ds.where === 'project') p.staticDecls.push(ds); else p.ext.push([ds.mod, ds.qual]);
    }
    // nominal class-hierarchy analysis: overrides and implementations of the method as WRITTEN in extends / implements
    const cal = unwrap(callee);
    if (ts.isPropertyAccessExpression(cal) && cal.expression.kind !== ts.SyntaxKind.SuperKeyword) {
      const nm = cal.name.text, recv = receiverSymbols(cal.expression), seen = new Set();
      for (const s of recv) {
        const anon = !!(s.flags & ts.SymbolFlags.TypeLiteral) || s.name === '__type' || s.name === '__object';
        const subs = new Set(classes.filter((c) => c.sym === s));
        if (!anon) for (const c of descendants.get(s) || []) subs.add(c);
        for (const c of subs) for (const d of membersOf(c, nm)) { const ds = describe(d); if (ds.where === 'project' && !seen.has(ds.node)) { seen.add(ds.node); p.impls.push(ds); } }
        if (s.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeLiteral)) {
          for (const c of structuralSubs(s)) for (const d of membersOf(c, nm)) { const ds = describe(d); if (ds.where === 'project') p.cands.push(ds); }
        }
        if (anon) p.anon = true;
      }
    }
    if (ts.isNewExpression(n) && !p.staticDecls.length && !p.ext.length) {              // a class with no constructor of its own: its base's
      const rs = resolveSym(checker.getSymbolAtLocation(nameNode));
      for (const cd of (rs && rs.declarations) || []) if (ts.isClassLike(cd)) { const ct = fnNodeCtor(cd); if (ct) p.staticDecls.push(describe(ct)); }
    }
    return p;
  }
  function fnNodeCtor(cd) {
    const seen = new Set();
    let cur = cd;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const c = cur.members.find((m) => ts.isConstructorDeclaration(m) && m.body);
      if (c) return c;
      const base = (cur.heritageClauses || []).find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
      if (!base) return null;
      const s = resolveSym(checker.getSymbolAtLocation(base.types[0].expression));
      cur = ((s && s.declarations) || []).find((x) => ts.isClassLike(x)) || null;
    }
    return null;
  }

  // ---- fold the pending answer into function ids, once the reader knows them all -----------------------------------------------
  function finish(p, declFid) {
    const id = (ds) => { const fnn = fnNode(ds.node); return fnn ? declFid.get(fnn) || null : null; };
    const to = [], may = [], cand = [];
    for (const ds of p.staticDecls) {
      if (ds.iface || ds.abstractM || (!hasBody(ds.node) && !fnNode(ds.node))) continue;       // no body: the implementations stand in (below, as `may`)
      const i = id(ds);
      if (i) to.push(i);
    }
    for (const ds of p.impls) { const i = id(ds); if (i && !to.includes(i)) may.push(i); }
    for (const ds of p.cands) { const i = id(ds); if (i && !to.includes(i) && !may.includes(i) && !cand.includes(i)) cand.push(i); }
    const uniq = (a) => [...new Set(a)].sort();
    const r = { to: uniq(to), may: uniq(may), cand: uniq(cand).slice(0, 8) };
    if (p.anon) { r.anon = true; r.may = []; }                // an anonymous receiver gets no nominal expansion at all
    if (r.to.length || r.may.length) r.k = 'project';
    else if (p.staticDecls.length || p.impls.length) r.k = 'project';                   // project code with no body to point at: abstract / interface method
    else if (p.ext.length) r.k = 'ext';
    else r.k = p.kind;
    r.x = p.ext.map((e) => [e[0], e[1]]).sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
    if (r.k === 'project' && !r.to.length && !r.may.length && !p.staticDecls.length) r.k = 'silent';
    return r;
  }
  // The static type of the receiver of `x.m(...)`, as `<path>::<Name>` for a class or interface declared in the project
  // and `ext:<Name>` for one declared outside it. A union lists each member. null when the callee is not a property access.
  function recvKeys(call) {
    const e = unwrap(call.expression);
    if (!e || !ts.isPropertyAccessExpression(e)) return null;
    const out = new Set();
    for (const s of receiverSymbols(e.expression)) {
      const d = (s.declarations || []).find((x) => projSet.has(norm(x.getSourceFile().fileName)));
      out.add(d ? norm(path.relative(root, d.getSourceFile().fileName)) + '::' + s.name : 'ext:' + s.name);
    }
    return [...out].sort();
  }
  return { program, checker, sourceFile, resolve, finish, options, overridesExternal, recvKeys };
}
