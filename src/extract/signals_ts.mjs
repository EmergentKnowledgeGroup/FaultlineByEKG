// Signal reader for TS/JS (docs/CONTRACTS.md: signals.json). Reads the same files the fact reader reads, with the same function ids,
// and reports raw per-function facts plus enum/constant uses. src/extract/signals.mjs turns these into pairs, sticky flags and so on.
// Nothing here touches facts.json or the census: this is a second, separate read of the source.
import fs from 'node:fs';
import path from 'node:path';
import { collectDefs, lineOf, loadTs, parse, propChain, unwrap } from './ts_index.mjs';
import { makeWake } from './signals_ts_wake.mjs';
import { isMsgConst, HANDLER_NAME, LIFECYCLE, TEARDOWN, wordsOf, handlingSeg, short } from './signals_words.mjs';

const EVENT_ON = new Set(['on', 'once', 'addListener', 'addEventListener', 'prependListener', 'subscribe', 'listen']);
const CMP_CALLS = new Set(['includes', 'indexOf', 'has', 'lastIndexOf']);

export async function readSignalsTs(rootDir, files, { ts: tsIn = null } = {}) {
  const ts = tsIn || await loadTs(rootDir);
  const out = { fns: [], inits: [], classes: [], enums: [], consts: [], uses: [], rawStrings: [], emptyHandlers: [], swallowed: [], skipped: [] };
  if (!ts) { out.skipped.push({ why: "the 'typescript' package is not installed" }); return out; }
  const K = ts.SyntaxKind;
  const read = (f) => { const text = fs.readFileSync(path.join(rootDir, f.path), 'utf8'); return { text, sf: parse(ts, f.path, text, f.path) }; };
  const litText = (e) => {
    e = unwrap(ts, e);
    if (!e) return null;
    if (e.kind === K.TrueKeyword) return 'true';
    if (e.kind === K.FalseKeyword) return 'false';
    if (e.kind === K.NullKeyword) return 'null';
    if (ts.isIdentifier(e) && e.text === 'undefined') return 'undefined';
    if (ts.isNumericLiteral(e)) return e.text;
    if (ts.isStringLiteralLike(e)) return JSON.stringify(e.text.length > 30 ? e.text.slice(0, 29) + '…' : e.text);
    if (ts.isPrefixUnaryExpression(e) && e.operator === K.MinusToken && ts.isNumericLiteral(e.operand)) return '-' + e.operand.text;
    if (ts.isArrayLiteralExpression(e) && !e.elements.length) return '[]';
    if (ts.isObjectLiteralExpression(e) && !e.properties.length) return '{}';
    if (ts.isNewExpression(e) && !(e.arguments && e.arguments.length) && ts.isIdentifier(e.expression) && /^(?:Map|Set|WeakMap|WeakSet)$/.test(e.expression.text)) return `new ${e.expression.text}()`;
    return null;
  };

  // ---- pass 1: enum-like definitions and message-ish constants -------------------------------------------------------------
  const enumNames = new Map();                                       // name -> [def]
  const defPos = new Set();                                          // `${path}:${pos}` of initializers that are the definitions themselves
  for (const f of files) {
    let r; try { r = read(f); } catch (e) { out.skipped.push({ path: f.path, why: short(String(e.message), 120) }); continue; }
    const { sf } = r, lineAt = lineOf(sf);
    const add = (d) => { out.enums.push(d); if (!enumNames.has(d.name)) enumNames.set(d.name, []); enumNames.get(d.name).push(d); };
    const member = (nm, init, line) => { const l = init ? litText(init) : null; if (init) defPos.add(`${f.path}:${init.getStart(sf)}`); return { name: nm, value: l && l[0] === '"' ? JSON.parse(l) : l, line }; };
    for (const s of sf.statements) {
      if (ts.isEnumDeclaration(s)) {
        const members = s.members.map((m) => member(m.name.text ?? m.name.getText(sf), m.initializer, lineAt(m.getStart(sf))));
        if (members.length) add({ name: s.name.text, path: f.path, line: lineAt(s.getStart(sf)), form: 'enum', members });
      } else if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          let v = unwrap(ts, d.initializer);
          if (ts.isCallExpression(v) && (propChain(ts, v.expression) || []).join('.') === 'Object.freeze' && v.arguments[0]) v = unwrap(ts, v.arguments[0]);
          const nm = d.name.text;
          if (ts.isObjectLiteralExpression(v) && /^[A-Z]/.test(nm)) {
            const members = []; let ok = true;
            for (const p of v.properties) {
              if (!ts.isPropertyAssignment(p) || !p.name || litText(p.initializer) === null) { ok = false; break; }
              members.push(member(p.name.text ?? p.name.getText(sf), p.initializer, lineAt(p.getStart(sf))));
            }
            if (ok && members.length >= 3) add({ name: nm, path: f.path, line: lineAt(d.getStart(sf)), form: 'const-object', members });
          } else if (isMsgConst(nm) && litText(v) !== null) {
            const l = litText(v); defPos.add(`${f.path}:${v.getStart(sf)}`);
            out.consts.push({ name: nm, path: f.path, line: lineAt(d.getStart(sf)), value: l[0] === '"' ? JSON.parse(l) : l });
          }
        }
      }
    }
  }
  const constNames = new Set(out.consts.map((c) => c.name));
  const strVals = new Set();
  for (const d of out.enums) for (const m of d.members) if (typeof m.value === 'string' && m.value.length >= 3 && !/^\d/.test(m.value)) strVals.add(m.value);
  for (const c of out.consts) if (typeof c.value === 'string' && c.value.length >= 3) strVals.add(c.value);

  // ---- pass 2: one walk per file --------------------------------------------------------------------------------------
  for (const f of files) {
    let r; try { r = read(f); } catch { continue; }
    try { walkFile(f, r.sf, r.text); } catch (e) { out.skipped.push({ path: f.path, why: short(`${e.name} while reading signals: ${e.message}`, 140) }); }
  }
  return out;

  function walkFile(f, sf, text) {
    const lineAt = lineOf(sf), defs = collectDefs(ts, sf);
    const fnDef = new Map(), clsDef = new Map(), recs = new Map();
    const clsByQual = new Map();
    for (const d of defs) { (d.kind === 'func' ? fnDef : clsDef).set(d.node, d); if (d.kind !== 'func') clsByQual.set(d.qual, d); }
    const wake = makeWake(ts, sf, lineAt, (n) => fnDef.has(n));
    const modRec = { id: `${f.path}::<module>`, path: f.path, name: '<module>', owner: '', method: false, line: 1, end: lineAt(sf.end), writes: [], calls: [], supers: 0, reads: [] };
    const recFor = (d) => {
      if (recs.has(d)) return recs.get(d);
      const nd = d.node, first = lineAt(nd.getStart(sf));
      const r = { id: `${f.path}::${d.qual}`, path: f.path, name: d.name, owner: d.qual.includes('.') ? d.qual.slice(0, d.qual.lastIndexOf('.')) : '', method: !!d.cls,
        line: d.declName ? lineAt(d.declName.getStart(sf)) : nd.name ? lineAt(nd.name.getStart(sf)) : first, end: lineAt(nd.end), writes: [], calls: [], supers: 0, reads: [] };
      recs.set(d, r); out.fns.push(r);
      if (d.cls && d.qual.slice(0, d.qual.lastIndexOf('.')) === d.cls) {            // a method itself (not a closure inside one): its path skeleton, parking loops and getter
        const sk = wake.skeleton(nd), lp = wake.loops(nd), gt = wake.getter(nd);
        if (sk) r.sk = sk;
        if (lp.length) r.lp = lp;
        if (gt) r.gt = gt;
      }
      return r;
    };
    const anc = [], clsStack = [];
    let cur = modRec, inCond = 0;
    const ln = (n) => lineAt(n.getStart(sf));
    const txt = (n, m = 60) => short(sf.text.slice(n.getStart(sf), n.end), m);
    const clean = (t) => short(t.replace(/\/\*+|\*+\/|\/\/+/g, ' ').replace(/\s+/g, ' ').trim(), 90);
    const comment = (block) => {
      if (!block || !ts.isBlock(block)) return '';
      if (!block.statements.length) { const inner = sf.text.slice(block.getStart(sf) + 1, block.end - 1); return /\/[/*]/.test(inner) ? clean(inner) : ''; }
      const rs = ts.getLeadingCommentRanges(sf.text, block.statements.pos) || [];
      return rs.length ? clean(rs.map((c) => sf.text.slice(c.pos, c.end)).join(' ')) : '';
    };
    const emptyBody = (body) => !!body && ts.isBlock(body) && body.statements.every((s) => ts.isEmptyStatement(s) || (ts.isReturnStatement(s) && !s.expression));

    // classify where an `Enum.MEMBER` / constant occurrence sits: case label, comparison, dispatch-table key, or produced
    const usageCtx = (n) => {
      let child = n;
      for (let i = anc.length - 2; i >= 0; i--) {
        const p = anc[i];
        if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression?.(p) || ts.isTypeAssertionExpression?.(p)) { child = p; continue; }
        if (ts.isCaseClause(p) && p.expression === child) return { ctx: 'case', clause: p, block: anc[i - 1] };
        if (ts.isBinaryExpression(p)) {
          const k = p.operatorToken.kind;
          if (k === K.EqualsEqualsEqualsToken || k === K.EqualsEqualsToken || k === K.ExclamationEqualsEqualsToken || k === K.ExclamationEqualsToken) return { ctx: 'cmp', bin: p };
          return { ctx: 'produce' };
        }
        if (ts.isComputedPropertyName(p)) {                             // { [Cmd.A]: handler } is a dispatch table; { [Key.A]: value } builds an object
          const o = anc[i - 1], v = o && ts.isPropertyAssignment(o) ? unwrap(ts, o.initializer) : null;
          return o && (ts.isMethodDeclaration(o) || (v && (ts.isArrowFunction(v) || ts.isFunctionExpression(v)))) ? { ctx: 'key' } : { ctx: 'produce' };
        }
        if (ts.isArrayLiteralExpression(p)) { const g = anc[i - 1]; return g && ts.isPropertyAccessExpression(g) && g.expression === p && CMP_CALLS.has(g.name.text) ? { ctx: 'cmp' } : { ctx: 'produce' }; }
        if (ts.isCallExpression(p) && p.arguments.includes(child) && ts.isPropertyAccessExpression(p.expression) && CMP_CALLS.has(p.expression.name.text)) return { ctx: 'cmp' };
        return { ctx: 'produce' };
      }
      return { ctx: 'produce' };
    };
    // the statements a case runs: an empty clause falls through to the next one that has any
    const caseBody = (block, clause) => {
      const cl = block.clauses, i = cl.indexOf(clause);
      for (let j = i; j < cl.length; j++) if (cl[j].statements.length) return cl[j].statements;
      return [];
    };
    const onlyBreak = (st) => st.length === 0 || (st.length === 1 && (ts.isBreakStatement(st[0]) || (ts.isBlock(st[0]) && st[0].statements.length === 1 && ts.isBreakStatement(st[0].statements[0]))));
    const onlyCommentOrBreak = (st) => onlyBreak(st) || (st.length === 1 && ts.isBlock(st[0]) && !st[0].statements.length);

    function onEnumUse(n, name, member) {
      const u = usageCtx(n), row = { name, member, ctx: u.ctx, fn: cur.id, path: f.path, line: ln(n) };
      if (u.ctx === 'case') { const body = caseBody(u.block, u.clause); row.empty = onlyCommentOrBreak(body); row.handlerLine = ln(u.clause); }
      else if (u.ctx === 'cmp' && u.bin) { row.empty = false; }
      out.uses.push(row);
    }
    function scanCatchBody(block, varName) {
      const s = { throws: false, errUsed: false, handled: false };
      const w = (c) => {
        if (ts.isFunctionLike?.(c) && c !== block) { if (varName) forEachId(c, (id) => { if (id === varName) s.errUsed = true; }); return; }
        if (ts.isThrowStatement(c)) s.throws = true;
        if (ts.isIdentifier(c) && varName && c.text === varName) s.errUsed = true;
        if (ts.isCallExpression(c) || ts.isNewExpression(c)) { const ch = propChain(ts, c.expression) || (ts.isIdentifier(c.expression) ? [c.expression.text] : []); if (ch.some(handlingSeg)) s.handled = true; }
        if (ts.isBinaryExpression(c) && c.operatorToken.kind === K.EqualsToken && /err|fail/i.test(txt(c.left, 40))) s.handled = true;
        if (ts.isReturnStatement(c) && c.expression && /^(?:Promise\.reject|reject)\b/.test(txt(c.expression, 30))) s.handled = true;
        ts.forEachChild(c, w);
      };
      w(block);
      return s;
    }
    function forEachId(n, fn) { const w = (c) => { if (ts.isIdentifier(c)) fn(c.text); ts.forEachChild(c, w); }; w(n); }
    const cleanupOf = (tryBlock) => {
      if (!tryBlock || tryBlock.statements.length !== 1) return false;
      let e = tryBlock.statements[0];
      e = ts.isExpressionStatement(e) ? unwrap(ts, e.expression) : null;
      if (e && ts.isAwaitExpression(e)) e = unwrap(ts, e.expression);
      if (!e || !ts.isCallExpression(e)) return false;
      const ch = propChain(ts, e.expression);
      return !!ch && TEARDOWN.test(wordsOf(ch[ch.length - 1]).join(' '));
    };
    const onlyStmt = (b) => { const st = b.statements; if (st.length !== 1) return ''; const x = st[0]; return ts.isBreakStatement(x) ? 'break' : ts.isContinueStatement(x) ? 'continue' : ts.isReturnStatement(x) ? 'return' : ''; };
    // try { require('x') } catch { ... } is how an optional dependency is probed: the failure is the answer
    const optionalLoad = (b) => { let hit = false; const w = (c) => { if (hit) return; if (ts.isCallExpression(c) && ((ts.isIdentifier(c.expression) && c.expression.text === 'require') || c.expression.kind === K.ImportKeyword)) { hit = true; return; } ts.forEachChild(c, w); }; w(b); return hit; };
    function onCatch(t) {
      const cc = t.catchClause, v = cc.variableDeclaration && ts.isIdentifier(cc.variableDeclaration.name) ? cc.variableDeclaration.name.text : null;
      const s = scanCatchBody(cc.block, v);
      if (s.throws || s.errUsed || s.handled) return;
      out.swallowed.push({ fn: cur.id, path: f.path, line: ln(cc), end: lineAt(cc.end), kind: 'catch', broad: true, empty: cc.block.statements.length === 0, only: onlyStmt(cc.block),
        comment: comment(cc.block), cleanup: cleanupOf(t.tryBlock) || optionalLoad(t.tryBlock), teardown: TEARDOWN.test(wordsOf(cur.name).join(' ')) });
    }
    function onCallee(n) {
      const callee = unwrap(ts, n.expression), args = [...(n.arguments || [])];
      const ch = propChain(ts, callee), last = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : null;
      if (ch && ch[0] === 'this' && ch.length === 2) cur.calls.push(ch[1]);
      else if (ch && ch[0] === 'super') cur.supers++;
      // `p.catch(noop)` on a promise held in a variable only marks it handled: whoever awaits p still sees the failure. `doIt().catch(noop)` loses it.
      const heldPromise = ts.isPropertyAccessExpression(callee) && !ts.isCallExpression(unwrap(ts, callee.expression));
      if (last === 'catch' && ts.isPropertyAccessExpression(callee) && args.length === 1 && !heldPromise) {
        const cb = unwrap(ts, args[0]);
        if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
          const p0 = cb.parameters[0] && ts.isIdentifier(cb.parameters[0].name) ? cb.parameters[0].name.text : null;
          const s = scanCatchBody(cb.body, p0);
          if (!s.throws && !s.errUsed && !s.handled && !(!ts.isBlock(cb.body) && ts.isCallExpression(unwrap(ts, cb.body)))) out.swallowed.push({ fn: cur.id, path: f.path, line: ln(n), end: lineAt(n.end), kind: 'promise-catch', broad: true, empty: emptyBody(cb.body), only: '', comment: comment(cb.body), cleanup: false, teardown: TEARDOWN.test(wordsOf(cur.name).join(' ')) });
        }
      }
      if (last && EVENT_ON.has(last) && args.length >= 2) {
        const cb = unwrap(ts, args[args.length - 1]);
        if ((ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && emptyBody(cb.body)) {
          out.emptyHandlers.push({ kind: 'handler', fn: cur.id, path: f.path, line: ln(n), end: lineAt(n.end), name: `${last}(${ts.isStringLiteralLike(args[0]) ? args[0].text : '...'})`, label: ts.isStringLiteralLike(args[0]) ? args[0].text : '', commented: !!comment(cb.body) });
        }
      }
    }
    function onDef(d, rec) {
      const nd = d.node;
      if (!nd.body || !emptyBody(nd.body) || (ts.getCombinedModifierFlags?.(nd) & ts.ModifierFlags.Abstract)) return;
      const cls = d.cls ? clsByQual.get(d.cls) : null;
      const heritage = !!(cls && cls.node.heritageClauses && cls.node.heritageClauses.length);
      const base = { fn: rec.id, path: f.path, line: rec.line, end: rec.end, name: d.name, commented: !!comment(nd.body) };
      const words = wordsOf(d.name);
      if (words.some((w) => LIFECYCLE.has(w)) && heritage) out.emptyHandlers.push({ kind: 'lifecycle', ...base, owner: d.cls });
      else if (HANDLER_NAME.test(d.name)) out.emptyHandlers.push({ kind: 'handler', ...base, owner: d.cls || '' });
    }

    function walk(n) {
      if (n.kind >= K.FirstTypeNode && n.kind <= K.LastTypeNode) return;
      if (ts.isEnumDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
      anc.push(n);
      const saved = cur, savedCond = inCond;
      const d = fnDef.get(n), cd = clsDef.get(n);
      if (d) { cur = recFor(d); inCond = 0; onDef(d, cur); }
      if (cd) { clsStack.push(cd); out.classes.push({ qual: cd.qual, path: f.path, bases: (n.heritageClauses || []).reduce((a, h) => a + h.types.length, 0) }); }
      try { visit(n); } finally { if (cd) clsStack.pop(); cur = saved; inCond = savedCond; anc.pop(); }
    }
    const kids = (n) => ts.forEachChild(n, walk);
    const cond = (e) => { if (!e) return; inCond++; walk(e); inCond--; };
    function visit(n) {
      switch (n.kind) {
        case K.IfStatement: cond(n.expression); walk(n.thenStatement); if (n.elseStatement) walk(n.elseStatement); return;
        case K.WhileStatement: case K.DoStatement: cond(n.expression); walk(n.statement); return;
        case K.ForStatement: if (n.initializer) walk(n.initializer); cond(n.condition); if (n.incrementor) walk(n.incrementor); walk(n.statement); return;
        case K.ConditionalExpression: cond(n.condition); walk(n.whenTrue); walk(n.whenFalse); return;
        case K.TryStatement: if (n.catchClause) onCatch(n); kids(n); return;
        case K.CaseClause: {
          const block = anc[anc.length - 2], cl = block.clauses, i = cl.indexOf(n);
          if (n.statements.length === 0 && i < cl.length - 1) break;           // falls through to the next case: not empty
          if (onlyBreak(n.statements) || (n.statements.length === 1 && ts.isBlock(n.statements[0]) && !n.statements[0].statements.length)) {
            out.emptyHandlers.push({ kind: 'case', fn: cur.id, path: f.path, line: ln(n), end: lineAt(n.end), name: txt(n.expression, 50), label: txt(n.expression, 50), commented: /\/[/*]/.test(sf.text.slice(n.getStart(sf), n.end)) });
          }
          break;
        }
        case K.PropertyDeclaration: {
          const cd = clsStack[clsStack.length - 1];
          if (cd && n.initializer && n.name && !ts.isComputedPropertyName(n.name) && !(ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) { const l = litText(n.initializer); out.inits.push({ owner: cd.qual, path: f.path, field: n.name.text, value: l, line: ln(n) }); }
          break;
        }
        case K.BinaryExpression: {
          const op = n.operatorToken.kind, left = unwrap(ts, n.left);
          if ((op === K.EqualsToken || (op >= K.FirstCompoundAssignment && op <= K.LastCompoundAssignment)) && ts.isPropertyAccessExpression(left) && unwrap(ts, left.expression).kind === K.ThisKeyword) {
            cur.writes.push([left.name.text, op === K.EqualsToken ? litText(n.right) : null, ln(n)]);
            if (op === K.EqualsToken) { walk(n.right); return; }
          }
          if (op === K.AmpersandAmpersandToken || op === K.BarBarToken || op === K.QuestionQuestionToken) { cond(n.left); walk(n.right); return; }
          break;
        }
        case K.PrefixUnaryExpression: case K.PostfixUnaryExpression:
          if ((n.operator === K.PlusPlusToken || n.operator === K.MinusMinusToken) && ts.isPropertyAccessExpression(unwrap(ts, n.operand)) && unwrap(ts, unwrap(ts, n.operand).expression).kind === K.ThisKeyword) cur.writes.push([unwrap(ts, n.operand).name.text, null, ln(n)]);
          break;
        case K.DeleteExpression: { const o = unwrap(ts, n.expression); if (ts.isPropertyAccessExpression(o) && unwrap(ts, o.expression).kind === K.ThisKeyword) cur.writes.push([o.name.text, 'delete', ln(n)]); break; }
        case K.CallExpression: onCallee(n); break;
        case K.PropertyAccessExpression: {
          const b = unwrap(ts, n.expression);
          if (b.kind === K.ThisKeyword) { if (inCond > 0) cur.reads.push([n.name.text, ln(n)]); break; }
          if (ts.isIdentifier(b) && enumNames.has(b.text)) { onEnumUse(n, b.text, n.name.text); return; }
          break;
        }
        case K.ElementAccessExpression: {
          const b = unwrap(ts, n.expression);
          if (ts.isIdentifier(b) && enumNames.has(b.text) && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression)) { onEnumUse(n, b.text, n.argumentExpression.text); return; }
          break;
        }
        case K.Identifier: {
          const p0 = anc[anc.length - 2];
          if (p0 && ((ts.isPropertyAccessExpression(p0) && p0.name === n) || ts.isQualifiedName(p0) || ts.isLabeledStatement(p0) || ts.isBreakOrContinueStatement?.(p0))) return;
        }
          if (enumNames.has(n.text)) { const p = anc[anc.length - 2]; if (!(p && (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n) && !(p && (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isClassDeclaration(p) && p.name === n)) && !isDeclName(n)) out.uses.push({ name: n.text, member: null, ctx: 'dyn', fn: cur.id, path: f.path, line: ln(n) }); }
          else if (constNames.has(n.text) && !isDeclName(n)) { const u = usageCtx(n); out.uses.push({ name: n.text, member: '', ctx: u.ctx, fn: cur.id, path: f.path, line: ln(n) }); }
          return;
        case K.StringLiteral: case K.NoSubstitutionTemplateLiteral:
          if (strVals.has(n.text) && !defPos.has(`${f.path}:${n.getStart(sf)}`)) { const u = usageCtx(n); if (u.ctx === 'produce') out.rawStrings.push({ value: n.text, path: f.path, line: ln(n) }); }
          return;
        default: break;
      }
      kids(n);
    }
    function isDeclName(id) {
      const p = anc[anc.length - 2];
      return !!p && ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isParameter(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isEnumMember(p)) && p.name === id
        || ts.isPropertyAssignment(p) && p.name === id || ts.isBindingElement(p) && p.name === id || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p));
    }
    out.fns.push(modRec);
    walk(sf);
  }
}
