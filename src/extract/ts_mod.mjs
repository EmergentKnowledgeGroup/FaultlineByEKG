// Pass 1 module builder for the TS/JS reader: classes, top-level names, exports and imports of one file.
import { ClassInfo, ModInfo, collectDefs, importsOf, propChain, typeNames, unwrap } from './ts_index.mjs';

export const hasMod = (n, kind) => (n.modifiers || []).some((m) => m.kind === kind);

function heritage(ts, node) {
  const out = [];
  for (const h of node.heritageClauses || []) {
    if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const t of h.types) { const c = propChain(ts, t.expression); if (c) out.push(c.join('.')); }
  }
  return out;
}

function walkAll(node, fn) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    fn(n);
    n.forEachChild?.((c) => { stack.push(c); });
  }
}

function classProps(ts, ci, node) {
  const add = (name, names) => {
    if (!names.length) return;
    const cur = ci.props.get(name) || [];
    for (const x of names) if (!cur.includes(x) && cur.length < 3) cur.push(x);
    ci.props.set(name, cur);
  };
  const newName = (e) => { e = e && unwrap(ts, e); return e && ts.isNewExpression(e) && ts.isIdentifier(e.expression) ? [e.expression.text] : []; };
  for (const m of node.members) {
    if (ts.isPropertyDeclaration(m) && m.name && m.name.text) ci.fields.add(m.name.text);
    if (ts.isPropertyDeclaration(m) && m.name && m.name.text) add(m.name.text, [...typeNames(ts, m.type), ...newName(m.initializer)]);
    if (ts.isConstructorDeclaration(m)) {
      const ptypes = new Map();
      for (const p of m.parameters) {
        if (!ts.isIdentifier(p.name)) continue;
        const names = typeNames(ts, p.type);
        ptypes.set(p.name.text, names);
        if (p.modifiers?.some((x) => x.kind !== ts.SyntaxKind.Decorator)) ci.fields.add(p.name.text);
        if (p.modifiers?.some((x) => x.kind !== ts.SyntaxKind.Decorator)) add(p.name.text, names);
      }
      ci._ptypes = ptypes;
    }
  }
  for (const m of node.members) {
    if (!m.body) continue;
    walkAll(m.body, (n) => {
      if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
      const l = n.left;
      if (!(ts.isPropertyAccessExpression(l) && l.expression.kind === ts.SyntaxKind.ThisKeyword)) return;
      let r = unwrap(ts, n.right);
      const choices = ts.isBinaryExpression(r) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(r.operatorToken.kind) ? [r.left, r.right] : [r];
      for (const c of choices.map((x) => unwrap(ts, x))) {
        if (ts.isNewExpression(c)) add(l.name.text, newName(c));
        else if (ts.isIdentifier(c) && ci._ptypes?.has(c.text)) add(l.name.text, ci._ptypes.get(c.text));
      }
    });
  }
  delete ci._ptypes;
}

export function buildMod(ts, sf, rel, lineAt) {
  const mi = new ModInfo(rel);
  const defs = collectDefs(ts, sf);
  const cnode = new Map();
  for (const d of defs) {
    if (d.kind === 'class') {
      const ci = new ClassInfo(d.qual, d.name, lineAt(d.node.getStart(sf)), lineAt(d.node.end));
      ci.bases = heritage(ts, d.node);
      mi.classes.set(d.qual, ci);
      cnode.set(d.qual, d.node);
      if (!d.qual.includes('.')) mi.top.set(d.name, { k: 'class', qual: d.qual });
    }
  }
  mi.ret = new Map();
  for (const d of defs) {
    if (d.kind !== 'func') continue;
    mi.funcs.set(d.qual, lineAt(d.node.getStart(sf)));
    if (d.node.type) mi.ret.set(d.qual, typeNames(ts, d.node.type));
    if (d.cls && mi.classes.has(d.cls) && d.qual.startsWith(d.cls + '.') && !d.qual.slice(d.cls.length + 1).includes('.')) {
      const ci = mi.classes.get(d.cls);
      ci.methods.set(d.name, d.qual);
      if (hasMod(d.node, ts.SyntaxKind.PrivateKeyword) || hasMod(d.node, ts.SyntaxKind.ProtectedKeyword) || (d.node.name && ts.isPrivateIdentifier(d.node.name))) ci.hidden.add(d.name);
    }
    if (!d.qual.includes('.') && !d.cls) mi.top.set(d.name, { k: 'func', qual: d.qual });
  }
  for (const [q, n] of cnode) classProps(ts, mi.classes.get(q), n);
  mi.rawImports = importsOf(ts, sf);
  const exp = (name, v) => mi.exports.set(name, v);
  for (const s of sf.statements) {
    const isExp = hasMod(s, ts.SyntaxKind.ExportKeyword), isDef = hasMod(s, ts.SyntaxKind.DefaultKeyword);
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && isExp) {
      const nm = s.name ? s.name.text : 'default';
      const q = [...mi.classes.keys(), ...mi.funcs.keys()].includes(nm) ? nm : nm;
      const k = ts.isClassDeclaration(s) ? 'class' : 'func';
      exp(isDef ? 'default' : nm, { k, qual: q });
      if (isDef && s.name) exp(nm, { k, qual: q });
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const nm = d.name.text, v = d.initializer && unwrap(ts, d.initializer);
        if (v && ts.isNewExpression(v) && ts.isIdentifier(v.expression)) mi.vars.set(nm, v.expression.text);
        if (isExp) exp(nm, mi.top.has(nm) ? { k: mi.top.get(nm).k, qual: nm } : { k: 'local', name: nm });
      }
    } else if (ts.isExportDeclaration(s)) {
      const spec = s.moduleSpecifier && s.moduleSpecifier.text;
      if (!s.exportClause) { if (spec) mi.stars.push(spec); }
      else if (ts.isNamespaceExport(s.exportClause)) { if (spec) mi.reexports.set(s.exportClause.name.text, { spec, name: '*' }); }
      else for (const e of s.exportClause.elements) {
        const out = e.name.text, orig = (e.propertyName || e.name).text;
        if (spec) mi.reexports.set(out, { spec, name: orig }); else exp(out, { k: 'local', name: orig });
      }
    } else if (ts.isExportAssignment(s)) {
      const v = unwrap(ts, s.expression);
      if (ts.isIdentifier(v)) exp('default', { k: 'local', name: v.text });
      else if (mi.funcs.has('default')) exp('default', { k: 'func', qual: 'default' });
      else if (mi.classes.has('default')) exp('default', { k: 'class', qual: 'default' });
    } else if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const chain = propChain(ts, s.expression.left), r = unwrap(ts, s.expression.right);
      if (!chain) continue;
      if (chain.join('.') === 'module.exports') {
        if (ts.isObjectLiteralExpression(r)) {
          for (const p of r.properties) {
            if (ts.isShorthandPropertyAssignment(p)) exp(p.name.text, { k: 'local', name: p.name.text });
            else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer) && p.name.text) exp(p.name.text, { k: 'local', name: p.initializer.text });
          }
        } else if (ts.isIdentifier(r)) exp('default', { k: 'local', name: r.text });
      } else if ((chain[0] === 'exports' || chain.slice(0, 2).join('.') === 'module.exports') && chain.length >= 2) {
        const nm = chain[chain.length - 1];
        if (ts.isIdentifier(r)) exp(nm, { k: 'local', name: r.text });
        else if (mi.funcs.has(nm)) exp(nm, { k: 'func', qual: nm });
        else if (mi.funcs.has(chain.slice(chain[0] === 'exports' ? 1 : 2).join('.'))) exp(nm, { k: 'func', qual: chain.slice(chain[0] === 'exports' ? 1 : 2).join('.') });
      }
    }
  }
  return { mi, defs };
}
