// Pass 2 of the TS/JS reader: one function's facts, same shape as the Python reader's.
import crypto from 'node:crypto';
import { propChain, typeNames, unwrap } from './ts_index.mjs';

const BUILTIN = new Set(['require', 'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Promise', 'Symbol',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'isNaN', 'isFinite', 'BigInt', 'Date', 'Error', 'RegExp', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Buffer', 'URL', 'encodeURIComponent', 'decodeURIComponent', 'console', 'process', 'structuredClone', 'queueMicrotask', 'fetch', 'Reflect', 'Proxy']);
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:\-]{1,39}$/;
const isLabel = (t) => LABEL.test(t) && !/^\d+$/.test(t) && !/^[A-Z][a-z]+$/.test(t);
const SLOT_KEY = /^(?:status|state|result|outcome|verdict|reason|disposition|resolution|ending|decision)$/i;
const SLOT = /^(?:status|state|result|outcome|verdict|reason|disposition|resolution|ending|decision|phase|[a-z0-9_]+(?:Status|State|Result|Outcome|Reason|Verdict|Decision|Disposition|Phase)|[a-z0-9_]+_(?:status|state|result|outcome|reason|verdict|decision|disposition|phase))$/i;
const COUNT = /attempt|tries|retry|retries|count|limit|max|remaining|left|budget|deadline|timeout|elapsed|ticks?|iter|depth|level|num|total|size|len|idx|index|^[ijkn]$/i;
const ATTEMPT = /attempt|tries|retry|retries|backoff|delay/i;
const SLEEPY = /^(?:sleep|asleep|delay|backoff|wait|setTimeout)$/i;
const CFG_KEY = /attempt|retr|timeout|limit|max|min|delay|interval|backoff|concurren|duration|ttl|batch|threshold|enable|disable|stall|lock|drain|autorun|keep|age|rate/i;
const ROUTE_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'head', 'options']);

export const short = (s, n = 80) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 3).trimEnd() + '...'; };
export const sha16 = (lines, a, b) => crypto.createHash('sha256').update(lines.slice(a - 1, b).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() && !l.trim().startsWith('//')).join('\n')).digest('hex').slice(0, 16);

export class Scan {
  constructor(env, mi, sf, lines, lineAt, d, acc, children, isModule = false) {
    const { ts } = env;
    Object.assign(this, { env, ts, K: ts.SyntaxKind, ix: env.ix, mi, sf, lines, lineAt, d, acc, isModule, node: d.node, qual: d.qual, clsQual: d.cls || null });
    this.fnId = `${mi.path}::${d.qual}`;
    this.scopes = [];
    for (let q = d.qual; q; q = q.includes('.') ? q.slice(0, q.lastIndexOf('.')) : null) if (children.has(q)) this.scopes.push(children.get(q));
    this.types = new Map(); this.params = new Set(); this.locals = new Set();
    this.callIdx = new Map(); this.callAt = []; this.unres = []; this.weak = [];
    this.branches = []; this.returns = []; this.raises = []; this.excepts = []; this.loopRows = []; this.hints = []; this.emits = []; this.exits = [];
    this.loops = 0; this.tryStack = []; this.recursive = []; this.strAssigns = new Map(); this.varReturns = [];
    this.ctxDefault = new Map(); this.ctxCmp = new Map(); this.ctxCast = new Map();
    if (!isModule) this.initParams();
  }
  txt(n, max = 80) { return short(this.sf.text.slice(n.getStart(this.sf), n.end), max); }
  ln(n) { return this.lineAt(n.getStart(this.sf)); }
  end(n) { return this.lineAt(n.end); }
  initParams() {
    for (const p of this.node.parameters || []) {
      if (!this.ts.isIdentifier(p.name)) continue;
      this.params.add(p.name.text); this.locals.add(p.name.text);
      for (const tn of typeNames(this.ts, p.type)) { const c = this.ix.resolveClass(this.mi, tn); if (c) { this.types.set(p.name.text, c); break; } }
    }
  }
  run() {
    const { ts, node } = this;
    if (this.isModule) for (const s of node.statements) this.visit(s);
    else if (node.body && !ts.isBlock(node.body)) {
      this.returns.push({ line: this.ln(node.body), expr: this.txt(node.body) });
      this.visit(node.body); this.emitValue(node.body, this.ln(node.body), 'return', null);
    } else if (node.body) this.visit(node.body);
    for (const [line, v] of this.varReturns) for (const [al, val] of this.strAssigns.get(v) || []) this.addEmit(al, 'return', null, val, null, null, 'var:' + v);
    return this.record();
  }
  record() {
    const { node, sf } = this;
    const calls = [...this.callIdx.keys()].filter((c) => c !== this.fnId);
    const idx = new Map(calls.map((c, i) => [c, i]));
    const all = [...this.callIdx.keys()];
    const rec = { path: this.mi.path, qual: this.qual, line: 1, end: this.lines.length, sha256: '', doc: '', async: false, decorators: [], calls, unresolved: [], branches: [], returns: [], raises: [], excepts: [], loops: [], retryHints: [] };
    if (!this.isModule) {
      const first = this.lineAt(node.getStart(sf));
      rec.line = this.d.declName ? this.ln(this.d.declName) : node.name ? this.ln(node.name) : first;
      rec.end = this.end(node);
      rec.sha256 = sha16(this.lines, first, rec.end);
      rec.async = !!(node.modifiers || []).some((m) => m.kind === this.K.AsyncKeyword);
      rec.decorators = (this.ts.getDecorators?.(node) || []).map((x) => short(x.getText(sf), 60));
      rec.doc = this.docOf(node);
    } else rec.sha256 = crypto.createHash('sha256').update(this.mi.path).digest('hex').slice(0, 16);
    if (this.recursive.length) this.loopRows.push({ line: this.recursive[0], end: this.recursive[0], kind: 'recursion', ...this.recBound() });
    rec.unresolved = [...new Set(this.unres.filter((u) => !this.locals.has(u.split('.')[0]) || u.startsWith('this.')))].sort().slice(0, 20);
    Object.assign(rec, { branches: this.branches.slice(0, 400), returns: this.returns.slice(0, 300), raises: this.raises.slice(0, 200), excepts: this.excepts.slice(0, 100), loops: this.loopRows.slice(0, 100), retryHints: this.hints });
    if (this.callAt.length) rec.callAt = this.callAt.filter((r) => idx.has(all[r[0]])).map((r) => [idx.get(all[r[0]]), ...r.slice(1)]).slice(0, 600);
    if (this.weak.length) rec.weakCalls = this.weak.filter((w) => w !== this.fnId).slice(0, 30);
    if (this.emits.length) rec.emits = this.emits.slice(0, 200);
    if (this.exits.length) rec.exits = this.exits.slice(0, 20);
    return rec;
  }
  recBound() {
    for (const b of this.branches) if (/depth|level|limit|max|remaining|budget|hops/i.test(b.test)) return { bounded: true, why: `a test on depth, level or limit near line ${b.line}` };
    return { bounded: false, why: 'calls itself; no depth or limit test seen' };
  }
  docOf(node) {
    const ranges = this.ts.getLeadingCommentRanges(this.sf.text, node.pos) || [];
    for (let i = ranges.length - 1; i >= 0; i--) {
      const t = this.sf.text.slice(ranges[i].pos, ranges[i].end);
      if (t.startsWith('/**')) return short(t.replace(/^\/\*\*|\*\/$/g, '').split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).find((l) => l && !l.startsWith('@')) || '', 120);
    }
    return '';
  }
  // ---- helpers ---------------------------------------------------------------
  addEmit(line, kind, slot, value, enumName, member, via) {
    const row = { line, kind };
    if (slot) row.slot = slot;
    if (value != null) row.value = value;
    if (enumName) { row.enum = enumName; row.member = member; }
    if (via) row.via = via;
    if (!this.emits.some((r) => JSON.stringify(r) === JSON.stringify(row))) this.emits.push(row);
  }
  enumMember(e) {
    e = unwrap(this.ts, e);
    if (!this.ts.isPropertyAccessExpression(e)) return null;
    const ch = propChain(this.ts, e);
    if (ch && ch.length >= 2 && this.ix.enumNames.has(ch[ch.length - 2])) return [ch[ch.length - 2], ch[ch.length - 1]];
    return null;
  }
  emitValue(v, line, kind, slot) {
    const { ts } = this;
    v = unwrap(ts, v);
    if (!v) return;
    if (ts.isStringLiteralLike(v)) { if (isLabel(v.text)) this.addEmit(line, kind, slot, v.text); }
    else if (ts.isObjectLiteralExpression(v) && (kind === 'return' || kind === 'assign')) {
      for (const p of v.properties) if (ts.isPropertyAssignment(p) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && SLOT_KEY.test(p.name.text)) this.emitValue(p.initializer, this.ln(p), 'dict', p.name.text);
    }
    else if (ts.isConditionalExpression(v)) { this.emitValue(v.whenTrue, line, kind, slot); this.emitValue(v.whenFalse, line, kind, slot); }
    else if (ts.isPropertyAccessExpression(v)) { const m = this.enumMember(v); if (m) this.addEmit(line, kind, slot, null, m[0], m[1]); }
    else if (ts.isIdentifier(v) && kind === 'return') this.varReturns.push([line, v.text]);
    else if (ts.isArrayLiteralExpression(v) && kind === 'return' && v.elements.length >= 2 && v.elements.length <= 3 && !v.elements.every((x) => ts.isStringLiteralLike(x))) this.emitValue(v.elements[0], line, 'tuple', slot);
  }
  hint(line, why) { if (this.hints.length < 8 && !this.hints.some((h) => h.line === line)) this.hints.push({ line, why }); }
  caughtNow() {
    if (!this.tryStack.length) return '';
    const s = new Set(this.tryStack.flat());
    return s.has('*') ? '*' : [...s].sort().join('|');
  }
  addCall(fid, line) {
    if (!fid) return;
    if (!this.callIdx.has(fid)) this.callIdx.set(fid, this.callIdx.size);
    const row = [this.callIdx.get(fid), line]; const c = this.caughtNow(); if (c) row.push(c);
    if (!this.callAt.some((r) => r[0] === row[0] && r[1] === row[1])) this.callAt.push(row);
  }
  armRange(s) {
    if (!s) return null;
    if (this.ts.isBlock(s)) return s.statements.length ? [this.ln(s.statements[0]), this.end(s.statements[s.statements.length - 1])] : null;
    return [this.ln(s), this.end(s)];
  }
  terminal(s) {
    const { ts } = this;
    if (!s) return 'none';
    if (ts.isBlock(s)) return s.statements.length ? this.terminal(s.statements[s.statements.length - 1]) : 'none';
    if (ts.isReturnStatement(s)) return 'return';
    if (ts.isThrowStatement(s)) return 'raise';
    if (ts.isContinueStatement(s)) return 'continue';
    if (ts.isBreakStatement(s)) return 'break';
    if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && /^process\.exit$/.test((propChain(ts, s.expression.expression) || []).join('.'))) return 'exit';
    return 'other';
  }
  testKind(e) {
    const { ts, K } = this;
    e = unwrap(ts, e);
    if (ts.isPrefixUnaryExpression(e) && e.operator === K.ExclamationToken) { const o = unwrap(ts, e.operand); return ts.isCallExpression(o) || ts.isBinaryExpression(o) ? this.testKind(o) : 'none'; }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return 'none';
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === K.AmpersandAmpersandToken || op === K.BarBarToken || op === K.QuestionQuestionToken) { const a = this.testKind(e.left), b = this.testKind(e.right); return a === b ? a : 'bool'; }
      if (op === K.InstanceOfKeyword) return 'type';
      const nullish = (x) => { x = unwrap(ts, x); return x.kind === K.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined'); };
      if (nullish(e.left) || nullish(e.right)) return 'none';
      if (ts.isTypeOfExpression(unwrap(ts, e.left))) return 'type';
      return 'cmp';
    }
    if (ts.isCallExpression(e)) return /isArray|isNaN|isFinite|isInteger/.test(this.txt(e.expression, 40)) ? 'type' : 'call';
    return ts.isLiteralExpression?.(e) ? 'const' : 'other';
  }
  mentionsCount(e) {
    const { ts, K } = this;
    let hit = false;
    const walk = (n) => {
      if (hit) return;
      if (ts.isBinaryExpression(n) && [K.LessThanToken, K.LessThanEqualsToken, K.GreaterThanToken, K.GreaterThanEqualsToken].includes(n.operatorToken.kind)) {
        const probe = (x) => { if (hit) return; if (ts.isIdentifier(x) && COUNT.test(x.text)) hit = true; else if (ts.isPropertyAccessExpression(x) && COUNT.test(x.name.text)) hit = true; else if (ts.isNumericLiteral(x)) hit = true; else if (ts.isCallExpression(x) && /Date\.now|performance\.now|\.now$|Time$/.test(this.txt(x.expression, 40))) hit = true; else ts.forEachChild(x, probe); };
        probe(n.left); probe(n.right);
      }
      ts.forEachChild(n, walk);
    };
    walk(e);
    return hit;
  }
}
