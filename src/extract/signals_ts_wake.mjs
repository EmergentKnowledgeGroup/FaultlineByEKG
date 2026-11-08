// TypeScript/JavaScript half of the lost-wakeup signal. For one method it reports (a) a path skeleton: the calls to this.method(), the wake-like calls
// and the returns, in order, with branches kept as branches; (b) its loops that read a field in a condition or a guard and can park (await or block);
// (c) which fields a one-line getter returns. src/extract/signals.mjs turns these into `lostWakeup` rows. Raw facts only: no judgement here.
// Skeleton nodes: {t:'c',n,l} this.method() call · {t:'w',n,r,a,l} wake-like call (name, receiver text, argument count) · {t:'if',a,b} · {t:'r'} return
// {t:'x'} throw · {t:'l',b} loop body (may run zero times) · {t:'t',b,c,f} try · {t:'s',cs,d} switch (d: has a default).
import { propChain, unwrap } from './ts_index.mjs';
import { wordsOf } from './signals_words.mjs';

const EVENT_ON = new Set(['on', 'once', 'addListener', 'addEventListener', 'prependListener', 'subscribe', 'listen']);
const WAKE_WORDS = new Set(['wake', 'wakeup', 'notify', 'signal', 'resolve', 'unblock', 'unpark', 'awaken']);
const NOT_WAKE_RECV = new Set(['Promise', 'path', 'Object', 'Array', 'Reflect', 'JSON', 'Math', 'URL']);
const SLEEP_WORDS = new Set(['sleep', 'delay', 'timeout', 'timeouts', 'settimeout', 'wait4', 'nap']);
const BLOCK_NAMES = new Set(['wait', 'join', 'acquire']);
const FETCHY = /^(?:fetch|take|dequeue|recv|receive|blocking|brpop|blpop|waitfor)/i;
const TIMEY = /timeout|millis|\bms\b|seconds|delay|interval|duration/i;

export function makeWake(ts, sf, lineAt, isDef) {
  const K = ts.SyntaxKind;
  const ln = (n) => lineAt(n.getStart(sf));
  const chainText = (n) => {
    const c = propChain(ts, n);
    if (!c) return '';
    return (c[0] === 'this' ? ['@', ...c.slice(1)] : c).join('.');
  };
  const isFn = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n);
  const wakeName = (name) => name === 'add' || name === 'put' || WAKE_WORDS.has(wordsOf(name)[0]) || wordsOf(name).some((w) => WAKE_WORDS.has(w)) || name === 'set';

  // ---- skeleton ---------------------------------------------------------------------------------------------------------
  function expr(n, out) {
    if (!n || isDef(n)) return;
    n = unwrap(ts, n);
    if (!n) return;
    if (isFn(n)) return;                                                        // not run here
    if (ts.isCallExpression(n)) {
      const callee = unwrap(ts, n.expression), ch = propChain(ts, callee);
      const last = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
      if (ts.isPropertyAccessExpression(callee)) expr(callee.expression, out); else if (!ts.isIdentifier(callee)) expr(callee, out);
      const handler = last && EVENT_ON.has(last);
      for (const a of n.arguments) {
        const u = unwrap(ts, a);
        if (isFn(u)) { const inner = []; if (u.body && !isDef(u)) { if (ts.isBlock(u.body)) stmts(u.body.statements, inner); else expr(u.body, inner); } if (handler) out.push({ t: 'if', a: inner, b: [] }); else out.push(...inner); }
        else expr(a, out);
      }
      const l = ln(n);
      if (ch && ch[0] === 'this' && ch.length === 2) out.push({ t: 'c', n: ch[1], l });
      if (last && wakeName(last) && !(ts.isPropertyAccessExpression(callee) && NOT_WAKE_RECV.has(chainText(callee.expression)))) {
        if (last !== 'set' || n.arguments.length === 0) out.push({ t: 'w', n: last, r: ts.isPropertyAccessExpression(callee) ? chainText(callee.expression) : '', a: n.arguments.length, l });
      }
      return;
    }
    if (ts.isBinaryExpression(n) && (n.operatorToken.kind === K.AmpersandAmpersandToken || n.operatorToken.kind === K.BarBarToken || n.operatorToken.kind === K.QuestionQuestionToken)) {
      expr(n.left, out); const r = []; expr(n.right, r); if (r.length) out.push({ t: 'if', a: r, b: [] }); return;
    }
    if (ts.isConditionalExpression(n)) {
      expr(n.condition, out); const a = [], b = []; expr(n.whenTrue, a); expr(n.whenFalse, b); if (a.length || b.length) out.push({ t: 'if', a, b }); return;
    }
    ts.forEachChild(n, (c) => expr(c, out));
  }
  function stmt(s, out) {
    if (!s || isDef(s)) return;
    switch (s.kind) {
      case K.Block: stmts(s.statements, out); return;
      case K.IfStatement: { expr(s.expression, out); const a = [], b = []; stmt(s.thenStatement, a); if (s.elseStatement) stmt(s.elseStatement, b); out.push({ t: 'if', a, b }); return; }
      case K.ReturnStatement: expr(s.expression, out); out.push({ t: 'r' }); return;
      case K.ThrowStatement: expr(s.expression, out); out.push({ t: 'x' }); return;
      case K.ForStatement: { if (s.initializer) expr(s.initializer, out); const b = []; if (s.condition) expr(s.condition, b); stmt(s.statement, b); if (s.incrementor) expr(s.incrementor, b); out.push({ t: 'l', b }); return; }
      case K.ForOfStatement: case K.ForInStatement: { expr(s.expression, out); const b = []; stmt(s.statement, b); out.push({ t: 'l', b }); return; }
      case K.WhileStatement: { expr(s.expression, out); const b = []; stmt(s.statement, b); out.push({ t: 'l', b }); return; }
      case K.DoStatement: stmt(s.statement, out); expr(s.expression, out); return;
      case K.TryStatement: {
        const b = [], c = [], f = []; stmt(s.tryBlock, b); if (s.catchClause) { const cc = []; stmt(s.catchClause.block, cc); c.push(cc); } if (s.finallyBlock) stmt(s.finallyBlock, f);
        out.push({ t: 't', b, c, f }); return;
      }
      case K.SwitchStatement: {
        expr(s.expression, out); const cs = []; let d = false;
        for (const cl of s.caseBlock.clauses) { if (ts.isDefaultClause(cl)) d = true; const x = []; stmts(cl.statements, x); cs.push(x); }
        out.push({ t: 's', cs, d }); return;
      }
      case K.LabeledStatement: stmt(s.statement, out); return;
      case K.ExpressionStatement: expr(s.expression, out); return;
      case K.VariableStatement: for (const d of s.declarationList.declarations) expr(d.initializer, out); return;
      default: return;
    }
  }
  function stmts(list, out) { for (const s of list) stmt(s, out); }
  // a branch with no call, wake or return in it still matters (it is a path with nothing on it); a whole skeleton with none of them is dropped
  const meaningful = (nodes) => nodes.some((x) => x.t === 'c' || x.t === 'w' || x.t === 'r' || (x.t === 'if' && (meaningful(x.a) || meaningful(x.b))) || (x.t === 'l' && meaningful(x.b))
    || (x.t === 't' && (meaningful(x.b) || x.c.some(meaningful) || meaningful(x.f))) || (x.t === 's' && x.cs.some(meaningful)));
  function skeleton(fnNode) {
    const out = [];
    if (!fnNode.body) return undefined;
    if (ts.isBlock(fnNode.body)) stmts(fnNode.body.statements, out); else expr(fnNode.body, out);
    return meaningful(out) ? out : undefined;
  }

  // ---- loops that read a field and can park ------------------------------------------------------------------------------
  function readsIn(n, how, out) {
    if (!n) return;
    const w = (c) => {
      if (!c || isDef(c) || isFn(c)) return;
      if (ts.isPropertyAccessExpression(c) && unwrap(ts, c.expression).kind === K.ThisKeyword) out.push({ name: c.name.text, line: ln(c), how });
      ts.forEachChild(c, w);
    };
    w(n);
  }
  const isSleepExpr = (e) => {
    e = unwrap(ts, e);
    if (!e) return false;
    if (ts.isCallExpression(e)) {
      const callee = unwrap(ts, e.expression), nm = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
      return e.arguments.length > 0 && wordsOf(nm).some((w) => SLEEP_WORDS.has(w));
    }
    if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Promise') return /\bsetTimeout\b/.test(e.getText(sf));
    return false;
  };
  function blockOf(n) {                                                         // await / for await / blocking call -> {kind,name,recv,line,timed} or null
    if (ts.isAwaitExpression(n)) {
      const e = unwrap(ts, n.expression);
      if (ts.isCallExpression(e)) {
        const callee = unwrap(ts, e.expression), name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
        const timedArg = e.arguments.some((a) => ts.isNumericLiteral(unwrap(ts, a)) || TIMEY.test(a.getText(sf)));
        return { kind: 'await', name, recv: ts.isPropertyAccessExpression(callee) ? chainText(callee.expression) : '', line: ln(n), timed: isSleepExpr(e) || ((BLOCK_NAMES.has(name) || FETCHY.test(name)) && timedArg) };
      }
      return { kind: 'await', name: '', recv: chainText(e), line: ln(n), timed: isSleepExpr(e) };
    }
    if (ts.isForOfStatement(n) && n.awaitModifier) return { kind: 'for await', name: '', recv: chainText(n.expression), line: ln(n), timed: false };
    if (ts.isCallExpression(n)) {
      const callee = unwrap(ts, n.expression);
      if (!ts.isPropertyAccessExpression(callee)) return null;
      const name = callee.name.text, timedArg = n.arguments.some((a) => ts.isNumericLiteral(unwrap(ts, a)) || TIMEY.test(a.getText(sf)));
      if (BLOCK_NAMES.has(name) || (name === 'get' && n.arguments.length === 0) || FETCHY.test(name)) return { kind: 'call', name, recv: chainText(callee.expression), line: ln(n), timed: timedArg };
    }
    return null;
  }
  function blocksIn(n, out) {
    const awaited = new Set();                                                  // a call that is awaited is one block, not two
    const w = (c) => {
      if (!c || isDef(c) || isFn(c)) return;
      if (!awaited.has(c)) {
        const b = blockOf(c);
        if (b) { out.push(b); if (ts.isAwaitExpression(c)) awaited.add(unwrap(ts, c.expression)); }
      }
      ts.forEachChild(c, w);
    };
    w(n);
  }
  const skips = (st) => {                                                       // the then-branch ends in continue / break / return
    const last = ts.isBlock(st) ? st.statements[st.statements.length - 1] : st;
    return !!last && (ts.isContinueStatement(last) || ts.isBreakStatement(last) || ts.isReturnStatement(last));
  };
  function guardsIn(body, out) {                                                // an `if` directly in the loop body (or a plain block of it) that skips or breaks
    const list = ts.isBlock(body) ? body.statements : [body];
    for (const s of list) {
      if (ts.isIfStatement(s) && skips(s.thenStatement)) readsIn(s.expression, 'guard', out);
      else if (ts.isBlock(s)) guardsIn(s, out);
    }
  }
  function loops(fnNode) {
    const out = [];
    const visit = (n) => {
      if (!n || (n !== fnNode && (isDef(n) || isFn(n)))) return;
      if (ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) {
        const reads = [];
        readsIn(ts.isForStatement(n) ? n.condition : n.expression, 'condition', reads);
        guardsIn(n.statement, reads);
        const blocks = [];
        blocksIn(n.statement, blocks);
        if (ts.isForOfStatement(n) && n.awaitModifier) blocks.push({ kind: 'for await', name: '', recv: chainText(n.expression), line: ln(n), timed: false });
        const seen = new Set(), uniq = (r) => { const k = `${r.name}:${r.line}:${r.how}`; if (seen.has(k)) return false; seen.add(k); return true; };
        const rr = reads.filter(uniq);
        if (rr.length && blocks.length) out.push({ line: ln(n), end: lineAt(n.end), kind: ts.isWhileStatement(n) ? 'while' : ts.isDoStatement(n) ? 'do' : 'for', reads: rr, blocks: blocks.slice(0, 8) });
      }
      ts.forEachChild(n, visit);
    };
    if (fnNode.body) visit(fnNode.body);
    return out;
  }
  function getter(fnNode) {                                                     // isPaused() { return this.paused } -> ['paused']
    const b = fnNode.body;
    if (!b) return undefined;
    let e = null;
    if (ts.isBlock(b)) { if (b.statements.length === 1 && ts.isReturnStatement(b.statements[0])) e = b.statements[0].expression; } else e = b;
    if (!e) return undefined;
    const reads = []; readsIn(e, 'getter', reads);
    return reads.length ? [...new Set(reads.map((r) => r.name))].slice(0, 4) : undefined;
  }
  return { skeleton, loops, getter };
}
