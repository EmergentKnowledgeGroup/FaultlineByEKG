// Visitor half of the TS/JS function scanner: statements, branches, loops, calls and call resolution.
import { Scan, short } from './ts_scan.mjs';
import { propChain, typeNames, unwrap } from './ts_index.mjs';

const BUILTIN = new Set(['require', 'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Promise', 'Symbol',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'isNaN', 'isFinite', 'BigInt', 'Date', 'Error', 'RegExp', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Buffer', 'URL', 'encodeURIComponent', 'decodeURIComponent', 'console', 'process', 'structuredClone', 'queueMicrotask', 'fetch',
  'Reflect', 'Proxy', 'Intl', 'Atomics', 'Uint8Array', 'TypeError', 'RangeError', 'AbortController', 'Number', 'globalThis', 'window', 'document']);
const PLAIN = new Set(`get set add run start stop close open read write send recv push pop shift unshift map filter reduce forEach find some every
includes slice splice indexOf join split trim replace match test then catch finally on once off emit remove delete clear has keys values entries
toString toJSON call apply bind next resolve reject all race create update init setup reset load save parse dispatch handle process execute
fetch connect destroy end flush log info warn error debug exec query put post patch head wait notify cancel pause resume`.split(/\s+/));
const CFG_KEY = /attempt|retr|timeout|limit|max|min|delay|interval|backoff|concurren|duration|ttl|batch|threshold|enable|disable|stall|lock|drain|autorun|keep|age|rate/i;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:\-]{1,39}$/;
const isLabel = (t) => LABEL.test(t) && !/^\d+$/.test(t) && !/^[A-Z][a-z]+$/.test(t);

const P = Scan.prototype;

P.visit = function visit(n) {
  const { ts, K } = this;
  switch (n.kind) {
    case K.FunctionDeclaration: case K.MethodDeclaration: case K.Constructor: case K.GetAccessor: case K.SetAccessor:
    case K.ClassDeclaration: case K.ClassExpression:
      return;
    case K.ArrowFunction: case K.FunctionExpression:
      if (this.env.defNodes.has(n)) return;
      for (const p of n.parameters) if (ts.isIdentifier(p.name)) this.locals.add(p.name.text);
      break;
    case K.IfStatement: return this.onIf(n, false);
    case K.SwitchStatement: return this.onSwitch(n);
    case K.TryStatement: return this.onTry(n);
    case K.WhileStatement: case K.DoStatement: case K.ForStatement: case K.ForInStatement: case K.ForOfStatement: return this.onLoop(n);
    case K.ReturnStatement:
      if (this.returns.length < 300) this.returns.push({ line: this.ln(n), expr: n.expression ? this.txt(n.expression) : '' });
      if (n.expression) { this.visit(n.expression); this.emitValue(n.expression, this.ln(n), 'return', null); }
      return;
    case K.ThrowStatement: return this.onThrow(n);
    case K.VariableDeclaration: this.onVarDecl(n); break;
    case K.ConditionalExpression: this.onTernary(n); break;
    case K.CallExpression: case K.NewExpression: if (this.onCall(n)) return; break;
    case K.PropertyAccessExpression: this.onProp(n); break;
    case K.ElementAccessExpression: this.onElem(n); break;
    case K.BinaryExpression: this.onBinary(n); break;
    case K.PrefixUnaryExpression: case K.PostfixUnaryExpression: this.onUnary(n); break;
    case K.CatchClause: break;
    default: break;
  }
  ts.forEachChild(n, (c) => this.visit(c));
};

P.visitAll = function visitAll(list) { for (const s of list) this.visit(s); };

P.onIf = function onIf(n, isElif) {
  const { ts } = this;
  this.visit(n.expression);
  const els = n.elseStatement;
  let elseR = null, et = 'none';
  const chained = els && ts.isIfStatement(els);
  if (els) { elseR = chained ? [this.ln(els), this.end(els)] : this.armRange(els); et = chained ? 'elif' : this.terminal(els); }
  if (this.branches.length < 400) {
    const row = { line: this.ln(n), kind: isElif ? 'elif' : 'if', test: this.txt(n.expression), end: this.end(n), then: this.armRange(n.thenStatement), tk: this.testKind(n.expression), tt: this.terminal(n.thenStatement), et };
    if (elseR) row.else = elseR;
    this.branches.push(row);
  }
  this.visit(n.thenStatement);
  if (chained) this.onIf(els, true); else if (els) this.visit(els);
};

P.onTernary = function onTernary(n) {
  if (this.branches.length >= 400) return;
  this.branches.push({ line: this.ln(n), kind: 'ternary', test: this.txt(n.condition), end: this.end(n), then: [this.ln(n.whenTrue), this.end(n.whenTrue)],
    else: [this.ln(n.whenFalse), this.end(n.whenFalse)], tk: this.testKind(n.condition), tt: 'other', et: 'other' });
};

P.onSwitch = function onSwitch(n) {
  const cl = n.caseBlock.clauses;
  this.visit(n.expression);
  const last = cl.length ? cl[cl.length - 1].statements : [];
  this.branches.push({ line: this.ln(n), kind: 'match', test: this.txt(n.expression), end: this.end(n), then: cl.length ? [this.ln(cl[0]), this.end(n)] : null,
    tk: 'match', tt: 'other', et: last.length ? this.terminal(last[last.length - 1]) : 'none', cases: cl.length });
  for (const c of cl) { if (c.expression) this.visit(c.expression); this.visitAll(c.statements); }
};

P.onTry = function onTry(n) {
  const { ts } = this;
  const cc = n.catchClause;
  if (cc) {
    this.branches.push({ line: this.ln(n), kind: 'try', test: 'catch', end: this.end(n), then: this.armRange(n.tryBlock), else: this.armRange(cc.block), tk: 'try', tt: this.terminal(n.tryBlock), et: this.terminal(cc.block) });
    this.tryStack.push(['*']);
  }
  this.visit(n.tryBlock);
  if (cc) {
    this.tryStack.pop();
    const stmts = cc.block.statements;
    const hasThrow = this.hasThrow(cc.block);
    const silent = stmts.every((s) => ts.isEmptyStatement(s) || (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && /^(?:console|logger|log)\b/.test(this.txt(s.expression.expression, 30))) || ts.isReturnStatement(s));
    if (this.excepts.length < 100) this.excepts.push({ line: this.ln(cc), type: 'catch', swallows: !hasThrow, broad: true, silent: silent && !hasThrow, end: this.end(cc) });
    if (cc.variableDeclaration && ts.isIdentifier(cc.variableDeclaration.name)) { this.locals.add(cc.variableDeclaration.name.text); (this.catchVars ||= new Set()).add(cc.variableDeclaration.name.text); }
    if (this.loops && this.hasKind(cc.block, ts.SyntaxKind.ContinueStatement)) this.hint(this.ln(cc), 'catch clause then continue inside a loop');
    this.visit(cc.block);
  }
  if (n.finallyBlock) this.visit(n.finallyBlock);
};

P.hasThrow = function hasThrow(node) { return this.hasKind(node, this.K.ThrowStatement); };
P.hasKind = function hasKind(node, kind) {
  let hit = false;
  const w = (c) => { if (hit || this.ts.isFunctionLike?.(c)) return; if (c.kind === kind) { hit = true; return; } this.ts.forEachChild(c, w); };
  this.ts.forEachChild(node, w);
  return hit;
};

P.onThrow = function onThrow(n) {
  const { ts } = this;
  const e = n.expression && unwrap(ts, n.expression);
  let type = '(dynamic)', msg = '';
  if (e) {
    if (ts.isNewExpression(e) || ts.isCallExpression(e)) {
      const ch = propChain(ts, e.expression);
      type = ch ? ch[ch.length - 1] : this.txt(e.expression, 30);
      if (ts.isCallExpression(e) && !/^[A-Z]/.test(type)) type = '(dynamic)';
      const a = e.arguments && e.arguments[0];
      if (a && ts.isStringLiteralLike(a)) msg = a.text; else if (a && ts.isTemplateExpression(a)) msg = a.head.text + '...';
    } else if (ts.isIdentifier(e)) type = this.catchVars && this.catchVars.has(e.text) ? '(reraise)' : e.text;
  }
  if (this.raises.length < 200) { const row = { line: this.ln(n), type, caught: type !== '(reraise)' && this.tryStack.length > 0 }; if (msg) row.msg = short(msg, 60); this.raises.push(row); }
  if (e) this.visit(e);
};

P.isTrueLit = function isTrueLit(e) { e = unwrap(this.ts, e); return e.kind === this.K.TrueKeyword || (this.ts.isNumericLiteral(e) && e.text === '1'); };

P.onLoop = function onLoop(n) {
  const { ts, K } = this;
  const k = n.kind;
  let bounded = true, why = 'loop over a collection or range', kind = 'for', cond = null, body = n.statement;
  if (k === K.WhileStatement || k === K.DoStatement) {
    kind = 'while'; cond = n.expression;
    if (this.isTrueLit(cond)) [bounded, why] = this.constLoop(body);
    else if (this.mentionsCount(cond)) [bounded, why] = [true, 'test compares against a count, limit or deadline'];
    else { [bounded, why] = [false, 'no count or limit in the loop test']; const ex = []; this.loopExits(body, [], 0, ex); const hit = ex.find(([, g]) => g.some((x) => this.mentionsCount(x))); if (hit) [bounded, why] = [true, `exit at line ${hit[0]} is guarded by a count, limit or deadline`]; }
  } else if (k === K.ForStatement) {
    cond = n.condition;
    if (!cond) [bounded, why] = this.constLoop(body);
    else if (this.mentionsCount(cond)) [bounded, why] = [true, 'test compares against a count, limit or deadline'];
    else [bounded, why] = [false, 'no count or limit in the loop test'];
  } else if (n.awaitModifier) [bounded, why] = [true, 'for await over a stream (ends when the source ends)'];
  if (cond) this.visit(cond);
  if (k === K.ForStatement) {
    if (n.initializer) this.visit(n.initializer);
    if (n.incrementor) this.visit(n.incrementor);
    const decl = n.initializer && ts.isVariableDeclarationList(n.initializer) ? n.initializer.declarations[0] : null;
    if (decl && ts.isIdentifier(decl.name) && /attempt|tries|retry|retries/i.test(decl.name.text)) this.hint(this.ln(n), `loop variable '${decl.name.text}' counts tries`);
  }
  if (k === K.ForInStatement || k === K.ForOfStatement) { this.visit(n.expression); if (n.initializer) this.visit(n.initializer); }
  this.loopRows.push({ line: this.ln(n), end: this.end(n), kind, bounded, why, test: cond ? this.txt(cond, 50) : '' });
  this.loops++;
  this.visit(body);
  this.loops--;
};

P.constLoop = function constLoop(body) {
  const exits = [];
  this.loopExits(body, [], 0, exits);
  if (!exits.length) return [false, 'while true with no exit'];
  for (const [line, guards] of exits) if (guards.some((g) => this.mentionsCount(g))) return [true, `exit at line ${line} is guarded by a count, limit or deadline`];
  const [line, guards] = exits[0];
  return [false, `endless loop; exits only on ${guards.length ? this.txt(guards[guards.length - 1], 40) : 'success'} (line ${line}), no count or limit`];
};

P.loopExits = function loopExits(s, guards, depth, out) {
  const { ts, K } = this;
  if (!s) return;
  if (ts.isReturnStatement(s) || ts.isThrowStatement(s) || (ts.isBreakStatement(s) && depth === 0)) { out.push([this.ln(s), guards.slice()]); return; }
  if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && (propChain(ts, s.expression.expression) || []).join('.') === 'process.exit') { out.push([this.ln(s), guards.slice()]); return; }
  if (ts.isIfStatement(s)) { this.loopExits(s.thenStatement, [...guards, s.expression], depth, out); this.loopExits(s.elseStatement, [...guards, s.expression], depth, out); return; }
  if (ts.isBlock(s)) { for (const c of s.statements) this.loopExits(c, guards, depth, out); return; }
  if ([K.WhileStatement, K.DoStatement, K.ForStatement, K.ForOfStatement, K.ForInStatement].includes(s.kind)) { this.loopExits(s.statement, guards, depth + 1, out); return; }
  if (ts.isTryStatement(s)) { this.loopExits(s.tryBlock, guards, depth, out); if (s.catchClause) this.loopExits(s.catchClause.block, guards, depth, out); this.loopExits(s.finallyBlock, guards, depth, out); return; }
  if (ts.isSwitchStatement(s)) { for (const c of s.caseBlock.clauses) for (const x of c.statements) this.loopExits(x, guards, depth + 1, out); return; }
  if (ts.isLabeledStatement(s)) this.loopExits(s.statement, guards, depth, out);
};

P.onVarDecl = function onVarDecl(d) {
  const { ts } = this;
  const init = d.initializer && unwrap(ts, d.initializer);
  if (ts.isIdentifier(d.name)) {
    const nm = d.name.text;
    this.locals.add(nm);
    let t = null;
    for (const tn of this.typeNamesOf(d.type)) { t = this.ix.resolveClass(this.mi, tn); if (t) break; }
    if (!t && init) t = this.exprType(init);
    if (t) this.types.set(nm, t);
    if (init) this.collectStr(nm, init, this.ln(d));
  } else if (ts.isObjectBindingPattern(d.name)) {
    for (const e of d.name.elements) if (ts.isIdentifier(e.name)) this.locals.add(e.name.text);
    if (init && (propChain(ts, init) || []).join('.') === 'process.env') {
      for (const e of d.name.elements) {
        const nm = (e.propertyName || e.name).text;
        this.acc.switches.push({ name: nm, path: this.mi.path, line: this.ln(e), default: e.initializer ? this.txt(e.initializer, 40) : null, kind: 'env', fn: this.fnId });
      }
    }
  }
};

P.typeNamesOf = function typeNamesOf(tn) { return tn ? typeNames(this.ts, tn) : []; };

P.collectStr = function collectStr(nm, init, line) {
  const { ts } = this;
  init = unwrap(ts, init);
  if (ts.isStringLiteralLike(init)) { if (isLabel(init.text)) { if (!this.strAssigns.has(nm)) this.strAssigns.set(nm, []); this.strAssigns.get(nm).push([line, init.text]); } }
  else if (ts.isConditionalExpression(init)) { this.collectStr(nm, init.whenTrue, line); this.collectStr(nm, init.whenFalse, line); }
};

P.onBinary = function onBinary(n) {
  const { ts, K } = this;
  const op = n.operatorToken.kind, line = this.ln(n);
  const left = unwrap(ts, n.left), right = unwrap(ts, n.right);
  if (op === K.QuestionQuestionToken || op === K.BarBarToken) {
    this.ctxDefault.set(left, n.right);
    if (this.ctxCast.has(n)) this.ctxCast.set(left, this.ctxCast.get(n));
    if (ts.isPropertyAccessExpression(left) && !this.envName(left) && CFG_KEY.test(left.name.text) && (ts.isNumericLiteral(right) || ts.isStringLiteralLike(right) || right.kind === K.TrueKeyword || right.kind === K.FalseKeyword) && this.txt(right).length <= 30) {
      this.acc.switches.push({ name: left.name.text, path: this.mi.path, line, default: ts.isStringLiteralLike(right) ? right.text : this.txt(right), kind: 'config', fn: this.fnId });
    }
  } else if ([K.EqualsEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.ExclamationEqualsToken].includes(op)) {
    const sym = this.txt(n.operatorToken, 4);
    this.ctxCmp.set(left, `${sym} ${this.txt(n.right, 30)}`); this.ctxCmp.set(right, `${sym} ${this.txt(n.left, 30)}`);
  } else if (op === K.EqualsToken || (op >= K.FirstCompoundAssignment && op <= K.LastCompoundAssignment)) {
    const target = ts.isPropertyAccessExpression(left) ? left.name.text : ts.isIdentifier(left) ? left.text : null;
    if (target && /^(?:status|state|result|outcome|verdict|reason|disposition|resolution|ending|decision)$/i.test(target) || (target && /(?:Status|State|Result|Outcome|Reason|Verdict|Decision)$/.test(target))) this.emitValue(right, line, 'assign', target);
    if (target && this.loops && /attempt|tries|retry|retries|backoff|delay/i.test(target) && !ts.isNumericLiteral(right)) this.hint(line, `counter '${target}' changes inside a loop`);
    if (ts.isIdentifier(left) && op === K.EqualsToken) { this.collectStr(left.text, right, line); const t = ts.isNewExpression(right) ? this.exprType(right) : null; if (t) this.types.set(left.text, t); }
    if ((propChain(ts, left) || []).join('.') === 'process.exitCode') this.exits.push({ line, via: 'process.exitCode', code: this.txt(n.right, 20) });
  }
};

P.onUnary = function onUnary(n) {
  const { ts, K } = this;
  if (!this.loops || (n.operator !== K.PlusPlusToken && n.operator !== K.MinusMinusToken)) return;
  const o = unwrap(ts, n.operand);
  const nm = ts.isIdentifier(o) ? o.text : ts.isPropertyAccessExpression(o) ? o.name.text : '';
  if (nm && /attempt|tries|retry|retries|backoff|delay/i.test(nm)) this.hint(this.ln(n), `counter '${nm}' changes inside a loop`);
};

P.onObject = function onObject(n) {
  const { ts } = this;
  for (const p of n.properties) {
    if (!ts.isPropertyAssignment(p) || !p.name) continue;
    const nm = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : null;
    if (nm && /^(?:status|state|result|outcome|verdict|reason|disposition|resolution|ending|decision|phase)$/i.test(nm)) this.emitValue(p.initializer, this.ln(p), 'dict', nm);
  }
};

// ---- switches and enum uses -------------------------------------------------------------
P.envName = function envName(e) {
  const ch = propChain(this.ts, e);
  return ch && ch.length === 3 && ch[1] === 'env' && (ch[0] === 'process' || ch[0] === 'Bun') ? ch[2] : null;
};

P.pushSwitch = function pushSwitch(e, name) {
  const def = this.ctxDefault.get(e), cmp = this.ctxCmp.get(e), cast = this.ctxCast.get(e);
  const row = { name, path: this.mi.path, line: this.ln(e), default: def ? (this.ts.isStringLiteralLike(unwrap(this.ts, def)) ? unwrap(this.ts, def).text : this.txt(def, 40)) : null, kind: 'env', fn: this.fnId };
  if (cmp) row.cmp = cmp;
  if (cast) row.cast = cast;
  this.acc.switches.push(row);
};

P.onProp = function onProp(n) {
  const name = this.envName(n);
  if (name) { this.pushSwitch(n, name); return; }
  const b = unwrap(this.ts, n.expression);
  const base = this.ts.isIdentifier(b) ? b.text : this.ts.isPropertyAccessExpression(b) ? b.name.text : null;
  if (base && this.ix.enumNames.has(base)) { const k = base + '.' + n.name.text; this.acc.enumUses[k] = (this.acc.enumUses[k] || 0) + 1; }
};

P.onElem = function onElem(n) {
  const { ts } = this;
  const ch = propChain(ts, n.expression);
  if (ch && ch.join('.') === 'process.env' && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression)) this.pushSwitch(n, n.argumentExpression.text);
};

// ---- calls ---------------------------------------------------------------------------------
P.symOf = function symOf(name) {
  if (this.types.has(name)) { const t = this.types.get(name); return ['inst', t[0], t[1]]; }
  for (const sc of this.scopes) if (sc.has(name)) return ['func', `${this.mi.path}::${sc.get(name)}`];
  if (this.params.has(name)) return ['param'];
  return this.ix.lookupLocal(this.mi.path, name);
};

P.exprType = function exprType(e) {
  const { ts, K, ix } = this;
  e = unwrap(ts, e);
  if (e && ts.isAwaitExpression(e)) e = unwrap(ts, e.expression);
  if (!e) return null;
  if (e.kind === K.ThisKeyword) return this.clsQual ? [this.mi.path, this.clsQual] : null;
  if (ts.isIdentifier(e)) { if (this.types.has(e.text)) return this.types.get(e.text); const s = this.params.has(e.text) ? null : ix.lookupLocal(this.mi.path, e.text); return s && s[0] === 'inst' ? [s[1], s[2]] : null; }
  if (ts.isNewExpression(e)) { const c = unwrap(ts, e.expression); return ts.isIdentifier(c) ? ix.resolveClass(this.mi, c.text) : null; }
  if (ts.isPropertyAccessExpression(e)) {
    const b = unwrap(ts, e.expression);
    if (ts.isIdentifier(b)) { const s = this.symOf(b.text); if (s && s[0] === 'mod') { const x = ix.exportOf(s[1], e.name.text); return x && x[0] === 'inst' ? [x[1], x[2]] : null; } }
    const bt = this.exprType(b);
    return bt ? ix.propType(bt[0], bt[1], e.name.text) : null;
  }
  if (ts.isCallExpression(e)) { const [id] = this.resolveCallee(e.expression); return id ? ix.returnClass(id) : null; }
  return null;
};

P.resolveCallee = function resolveCallee(callee, isNew = false) {
  const { ts, K, ix } = this;
  callee = unwrap(ts, callee);
  if (ts.isIdentifier(callee)) {
    const nm = callee.text, s = this.symOf(nm);
    if (!s) return BUILTIN.has(nm) ? [null, 'builtin'] : [null, 'unres'];
    if (s[0] === 'func') return isNew ? [null, 'local'] : [s[1], 'ok'];
    if (s[0] === 'class') { const c = ix.findMethod(s[1], s[2], 'constructor'); return c ? [c, 'ok'] : [null, 'local']; }
    return s[0] === 'ext' ? [null, 'ext'] : [null, 'local'];
  }
  if (callee.kind === K.SuperKeyword) {
    const ci = this.clsQual && this.mi.classes.get(this.clsQual);
    for (const b of (ci && ci.bases) || []) { const bc = ix.resolveClass(this.mi, b); const m = bc && ix.findMethod(bc[0], bc[1], 'constructor'); if (m) return [m, 'ok']; }
    return [null, 'local'];
  }
  if (ts.isPropertyAccessExpression(callee)) return this.resolveMember(callee.expression, callee.name.text);
  return [null, 'local'];
};

P.resolveMember = function resolveMember(obj, name) {
  const { ts, K, ix } = this;
  obj = unwrap(ts, obj);
  if (obj && ts.isAwaitExpression(obj)) obj = unwrap(ts, obj.expression);
  if (obj.kind === K.ThisKeyword) {
    if (!this.clsQual) return [null, 'local'];
    const m = ix.findMethod(this.mi.path, this.clsQual, name);
    if (m) return [m, 'ok'];
    const ci = this.mi.classes.get(this.clsQual);
    if (ci && ci.fields.has(name)) return [null, 'local'];
    return ix.hasOpenBases(this.mi.path, this.clsQual) ? [null, 'local'] : [null, 'unres_self'];
  }
  if (obj.kind === K.SuperKeyword) {
    const ci = this.clsQual && this.mi.classes.get(this.clsQual);
    for (const b of (ci && ci.bases) || []) { const bc = ix.resolveClass(this.mi, b); const m = bc && ix.findMethod(bc[0], bc[1], name); if (m) return [m, 'ok']; }
    return [null, 'local'];
  }
  if (ts.isIdentifier(obj)) {
    const s = this.symOf(obj.text);
    if (!s) { if (BUILTIN.has(obj.text)) return [null, 'builtin']; }
    else if (s[0] === 'inst' || s[0] === 'class') { const m = ix.findMethod(s[1], s[2], name); if (m) return [m, 'ok']; }
    else if (s[0] === 'mod') {
      const x = ix.exportOf(s[1], name);
      if (x && x[0] === 'func') return [x[1], 'ok'];
      if (x && x[0] === 'class') { const c = ix.findMethod(x[1], x[2], 'constructor'); return c ? [c, 'ok'] : [null, 'local']; }
      return [null, x ? 'local' : 'unres_mod'];
    } else if (s[0] === 'ext') return [null, 'ext'];
    else if (s[0] === 'func') return [null, 'local'];
  } else {
    const t = this.exprType(obj);
    if (t) { const m = ix.findMethod(t[0], t[1], name); if (m) return [m, 'ok']; }
  }
  const recv = ts.isIdentifier(obj) ? obj.text : ts.isPropertyAccessExpression(obj) ? obj.name.text : null;
  const g = recv && ix.guessMethod(recv, name);
  return g ? [g, 'ok'] : [null, 'weak'];
};

P.weakTarget = function weakTarget(name) {
  if (name.length < 4 || PLAIN.has(name)) return null;
  const c = this.ix.methodIndex.get(name);
  return c && c.length === 1 ? c[0] : null;
};

P.entryFromRef = function entryFromRef(ref, line, kind, why) {
  const { ts } = this;
  if (!ref) return;
  ref = unwrap(ts, ref);
  if (ts.isArrowFunction(ref) || ts.isFunctionExpression(ref)) { if (!this.env.defNodes.has(ref)) this.acc.entries.push({ fn: this.fnId, kind, why: `${why} (inline, line ${line})` }); return; }
  const [id, st] = ts.isIdentifier(ref) ? this.resolveCallee(ref) : ts.isPropertyAccessExpression(ref) ? this.resolveMember(ref.expression, ref.name.text) : [null, ''];
  if (id && st === 'ok') this.acc.entries.push({ fn: id, kind, why: `${why} (line ${line})` });
};

P.onCall = function onCall(n) {
  const { ts, K } = this;
  const isNew = n.kind === K.NewExpression;
  const callee = unwrap(ts, n.expression);
  const line = this.ln(n);
  const args = n.arguments ? [...n.arguments] : [];
  const ch = propChain(ts, callee);
  const last = ch ? ch[ch.length - 1] : ts.isIdentifier(callee) ? callee.text : null;
  const full = ch ? ch.join('.') : '';
  let handledCatch = false;
  if (full === 'process.exit' || full === 'Deno.exit') this.exits.push({ line, via: full, code: args[0] ? this.txt(args[0], 20) : '' });
  if (ts.isIdentifier(callee) && ['Number', 'parseInt', 'parseFloat', 'Boolean', 'String'].includes(callee.text) && args[0]) this.ctxCast.set(unwrap(ts, args[0]), callee.text);
  if (full === 'Deno.env.get' && args[0] && ts.isStringLiteralLike(args[0])) this.acc.switches.push({ name: args[0].text, path: this.mi.path, line, default: null, kind: 'env', fn: this.fnId });
  if (this.loops && last) {
    if (/^(?:sleep|asleep|delay|backoff|wait|setTimeout)$/i.test(last) || /backoff/i.test(last)) this.hint(line, `sleep call ${full || last}`);
    else if (/retry|retries/i.test(last)) this.hint(line, `retry call ${full || last}`);
  }
  if (last === 'catch' && ts.isPropertyAccessExpression(callee) && args.length) {
    const cb = unwrap(ts, args[0]);
    const swallow = (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) ? !this.hasThrow(cb.body) : true;
    if (this.excepts.length < 100) this.excepts.push({ line, type: 'Promise.catch', swallows: swallow, broad: true, silent: false, end: this.end(n) });
    if (swallow) this.tryStack.push(['*']);
    this.visit(callee.expression);
    if (swallow) this.tryStack.pop();
    for (const a of args) this.visit(a);
    handledCatch = true;
  }
  if (!isNew && last && ROUTE_VERB.has(last) && args.length >= 2 && ts.isStringLiteralLike(args[0]) && args[0].text.startsWith('/'))
    for (const a of args.slice(1)) this.entryFromRef(a, line, 'route', `${last.toUpperCase()} ${args[0].text}`);
  if (isNew && ts.isIdentifier(callee) && /Worker$/.test(callee.text) && args[1]) this.entryFromRef(args[1], line, 'worker', 'worker processor');
  if (!isNew && last === 'on' && args.length >= 2 && ts.isStringLiteralLike(args[0]) && !ts.isArrowFunction(unwrap(ts, args[1]))) this.entryFromRef(args[1], line, 'handler', `listens to '${args[0].text}'`);
  if (!isNew && (last === 'setInterval' || last === 'setImmediate') && args[0]) this.entryFromRef(args[0], line, 'worker', 'timer callback');
  const [fid, st] = this.resolveCallee(n.expression, isNew);
  if (fid) { this.addCall(fid, line); if (fid === this.fnId) this.recursive.push(line); }
  else if (st === 'weak' && last) { const w = this.weakTarget(last); if (w && !this.weak.includes(w)) this.weak.push(w); }
  else if ((st === 'unres' || st === 'unres_self' || st === 'unres_mod') && full && this.unres.length < 40) this.unres.push(full.replace(/^this\./, 'this.'));
  for (const a of args) {
    const ua = unwrap(ts, a);
    if (ts.isStringLiteralLike(ua) && this.env.luaScripts.has(ua.text)) this.addCall(this.env.luaScripts.get(ua.text), line);
    else if (ts.isIdentifier(ua) && !this.params.has(ua.text)) { const [id, s2] = this.resolveCallee(ua); if (id && s2 === 'ok') this.addCall(id, line); }
    else if (ts.isPropertyAccessExpression(ua) && unwrap(ts, ua.expression).kind === K.ThisKeyword) { const [id, s2] = this.resolveMember(ua.expression, ua.name.text); if (id && s2 === 'ok') this.addCall(id, line); }
  }
  return handledCatch;
};

const ROUTE_VERB = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'head', 'options']);
