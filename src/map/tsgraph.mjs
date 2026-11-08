// The function graph of one TypeScript or JavaScript function: the same nodes, edges and ops the Python reader writes. Pure syntax; no types, no guessing.
//   makeGraph(ts, checker, pending) -> { build(node, rel, qual, cls, sourceFile) -> { rec, nested }, calleeText }
// `checker` (or null) is asked about every call it sees; its pending answers are pushed on `pending` and folded in once all function ids exist.
import { cpLen, cpSlice } from './pyrt.mjs';
export function makeGraph(ts, CK, PENDING) {
const K = ts.SyntaxKind;
const short = (s, n = 90) => { s = (s || '').replace(/\s+/g, ' ').trim(); return cpLen(s) > n ? cpSlice(s, 0, n - 3) + '...' : s; };
function calleeText(e) {
  if (!e) return null;
  switch (e.kind) {
    case K.Identifier: return e.text;
    case K.ThisKeyword: return 'self';
    case K.SuperKeyword: return 'super()';
    case K.PropertyAccessExpression: { const b = calleeText(e.expression); return (b ?? '?') + '.' + e.name.text; }
    case K.NonNullExpression: case K.ParenthesizedExpression: case K.AsExpression: case K.TypeAssertionExpression: return calleeText(e.expression);
    case K.ElementAccessExpression: case K.CallExpression: { const b = calleeText(e.expression); return b ? b + '.?' : '?'; }
    default: return '?';
  }
}
function valClass(v, sf) {
  if (!v) return 'const:None';
  switch (v.kind) {
    case K.StringLiteral: case K.NoSubstitutionTemplateLiteral: return 'const:str:' + short(v.text, 40);
    case K.NumericLiteral: return 'const:' + v.text;
    case K.TrueKeyword: return 'const:True';
    case K.FalseKeyword: return 'const:False';
    case K.NullKeyword: return 'const:None';
    case K.Identifier: return v.text === 'undefined' ? 'const:None' : 'name:' + v.text;
    case K.PropertyAccessExpression: return 'attr:' + calleeText(v);
    case K.CallExpression: return 'call:' + calleeText(v.expression);
    case K.NewExpression: return 'call:' + calleeText(v.expression);
    case K.AwaitExpression: return valClass(v.expression, sf);
    case K.ObjectLiteralExpression: {            // the constant keys name the shape of a reply
      const ks = [...new Set(v.properties.map((p) => (p.name && (p.name.kind === K.Identifier || p.name.kind === K.StringLiteral)) ? p.name.text : null).filter((x) => x))].sort();
      return 'new:dict' + (ks.length ? '{' + ks.slice(0, 6).join(',') + (ks.length > 6 ? ',...' : '') + '}' : '');
    }
    case K.ArrayLiteralExpression: return 'new:list';
    case K.TemplateExpression: return 'fstr';
    case K.ParenthesizedExpression: case K.AsExpression: case K.NonNullExpression: return valClass(v.expression, sf);
    default: return 'expr';
  }
}
const retSig = (v, sf) => { const c = valClass(v, sf); return c === 'const:None' ? 'ret:none' : 'ret:' + c; };
// the identifiers an expression reads (up to 12, sorted): whether a returned value carries a given variable
const identsOf = (v) => { const s = new Set(); if (v) (function w(n) { if (n.kind === K.Identifier) s.add(n.text); ts.forEachChild(n, w); })(v); return [...s].sort().slice(0, 12); };
const rvOf = (v) => { const r = identsOf(v); return r.length ? { rv: r } : {}; };
class FB {
  constructor(node, rel, qual, cls, sf) {
    Object.assign(this, { node, rel, qual, cls, sf, nodes: [], edges: [], nested: [], xs: [], fin: [], loops: [], labels: [], held: [], hstack: [], rd: new Set(), pend: new Map() });
    const ln = this.line(node);
    this.entry = this.nw('entry', ln, ''); this.exit = this.nw('exit', this.eline(node), ''); this.xexit = this.nw('xexit', ln, '');
  }
  line(n) { return this.sf.getLineAndCharacterOfPosition(n.getStart(this.sf)).line + 1; }
  eline(n) { return this.sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1; }
  nw(k, line, syn, eline, extra = {}) {
    const n = { i: this.nodes.length, k, line, syn, ...extra };
    if (eline && eline !== line) n.eline = eline;
    if (this.hstack.length) n.h = this.hstack[this.hstack.length - 1];
    if (k === 'block' && this.curx() !== null) n.xc = this.curx();      // the exception context the block was made in: a block is only ever extended inside the same one
    this.nodes.push(n); return n.i;
  }
  edge(a, b, l) { this.edges.push([a, b, l]); }
  conn(t, n) { for (const [a, l] of t) this.edge(a, n, l); }
  curx() { return this.xs.length ? this.xs[this.xs.length - 1] : null; }
  rett() { return this.fin.length ? this.fin[this.fin.length - 1] : this.exit; }
  addOps(n, ops) {
    if (!ops.length) return;
    (this.nodes[n].ops ||= []).push(...ops);
    if (ops.some((o) => o.t === 'call' || o.t === 'await')) {
      const x = this.curx();
      if (x !== null) { if (!this.edges.slice(-6).some((e) => e[0] === n && e[1] === x && e[2] === 'exc')) this.edge(n, x, 'exc'); }
      else this.nodes[n].esc = 1;
    }
  }
  // ---- expressions -> ops ----
  ops(e, o = [], aw = false) {
    if (!e) return o;
    const sf = this.sf, held = [...this.held];
    switch (e.kind) {
      case K.ArrowFunction: case K.FunctionExpression: this.nested.push(e); return o;
      // object-literal methods, accessors and class expressions are functions of their own: what they call is not called here
      case K.MethodDeclaration: case K.GetAccessor: case K.SetAccessor: case K.Constructor: case K.ClassExpression: this.nested.push(e); return o;
      case K.AwaitExpression: { const n = o.length; this.ops(e.expression, o, true); if (o.length === n || e.expression.kind !== K.CallExpression) o.push({ t: 'await', line: this.line(e), f: null, held }); return o; }
      case K.CallExpression: case K.NewExpression: {
        const f = calleeText(e.expression);
        this.ops(e.expression.kind === K.PropertyAccessExpression ? e.expression.expression : null, o);
        for (const a of e.arguments || []) this.ops(a, o);
        const op = { t: 'call', line: this.line(e), f: f === 'super()' ? 'super()' : f, n: (e.arguments || []).length, aw, held };
        op.col = sf.getLineAndCharacterOfPosition(e.getStart(sf)).character + 1;
        if (e.kind === K.NewExpression) op.new = 1;
        if (CK) PENDING.push({ op, p: CK.resolve(e) });
        const a0 = e.arguments && e.arguments[0];
        if (a0 && (a0.kind === K.StringLiteral || a0.kind === K.NoSubstitutionTemplateLiteral)) op.a0 = cpSlice(a0.text, 0, 80);
        // every string-literal argument, the start line of every function-expression argument, and, for emit / on / once, the receiver's static type
        { const lits = {}, fa = {};
          (e.arguments || []).slice(0, 8).forEach((a, i) => {
            if (a.kind === K.StringLiteral || a.kind === K.NoSubstitutionTemplateLiteral) lits[i] = cpSlice(a.text, 0, 80);
            else if (a.kind === K.ArrowFunction || a.kind === K.FunctionExpression) fa[i] = this.line(a);
          });
          if (Object.keys(lits).length) op.lits = lits;
          if (Object.keys(fa).length) op.fa = fa;
          if (CK && e.kind === K.CallExpression && /(^|\.)(emit|on|once|addListener|prependListener|off|removeListener)$/.test(f || '')) { const rc = CK.recvKeys(e); if (rc && rc.length) op.rc = rc; } }
        const cb = (e.arguments || []).filter((a) => a.kind === K.Identifier || a.kind === K.PropertyAccessExpression).map((a) => calleeText(a)).slice(0, 6);
        if (cb.length) op.cb = cb;
        { const ai = {}; // the name handed over at each argument position: which parameter of the callee it lands in
          (e.arguments || []).slice(0, 8).forEach((x, i) => { if (x.kind === K.Identifier || x.kind === K.PropertyAccessExpression) ai[i] = calleeText(x); });
          if (Object.keys(ai).length) op.ai = ai; }
        o.push(op); if (f) this.rd.add(f); return o;
      }
      case K.BinaryExpression: {
        const k = e.operatorToken.kind;
        if (k >= K.FirstAssignment && k <= K.LastAssignment) {
          this.ops(e.right, o);
          const l = e.left; const aug = k !== K.EqualsToken;
          if (l.kind === K.Identifier) o.push({ t: 'set', line: this.line(e), tgt: l.text, tk: 'name', v: valClass(e.right, sf), aug });
          else if (l.kind === K.PropertyAccessExpression) { o.push({ t: 'set', line: this.line(e), tgt: calleeText(l), tk: 'attr', v: valClass(e.right, sf), aug }); }
          else if (l.kind === K.ElementAccessExpression) { this.ops(l.argumentExpression, o); o.push({ t: 'set', line: this.line(e), tgt: (calleeText(l.expression) || '?') + '[]', tk: 'sub', v: valClass(e.right, sf), aug }); }
          return o;
        }
        this.ops(e.left, o); this.ops(e.right, o); return o;
      }
      case K.ConditionalExpression: this.ops(e.condition, o); this.ops(e.whenTrue, o); this.ops(e.whenFalse, o); o.push({ t: 'tern', line: this.line(e), test: short(e.condition.getText(sf), 60) }); return o;
      case K.ElementAccessExpression: {              // obj[expr]: a computed member name can reach any field, unless it is a literal
        const a = e.argumentExpression;
        if (a && a.kind !== K.StringLiteral && a.kind !== K.NumericLiteral && a.kind !== K.NoSubstitutionTemplateLiteral) o.push({ t: 'dyn', line: this.line(e), recv: e.expression.kind === K.ThisKeyword ? 'self' : '?' });
        this.ops(e.expression, o); this.ops(a, o); return o;
      }
      case K.Identifier: this.rd.add(e.text); return o;
      case K.PropertyAccessExpression: { const t = calleeText(e); if (t) this.rd.add(t); this.ops(e.expression, o); return o; }
      default: ts.forEachChild(e, (c) => { this.ops(c, o); }); return o;
    }
  }
  // break / continue: straight to the loop, or through the try-finally that sits between the jump and the loop
  jumpOut(j, kind, lp) {
    if (this.fin.length > lp.fd) { const fe = this.fin[this.fin.length - 1]; this.edge(j, fe, 'jmp'); if (!this.pend.has(fe)) this.pend.set(fe, []); this.pend.get(fe).push([kind, lp]); }
    else if (kind === 'break') lp.brk.push([j, 'brk']);
    else this.edge(j, lp.head, 'cont');
  }
  /** The labels written directly in front of the statement being entered (`a: b: for ...`), handed to the jump target that statement becomes. */
  takeLabels() { const l = this.labels; this.labels = []; return l; }
  /** The place a break or continue lands. With a label: the statement that label names. Without: a continue lands on the nearest loop, a break on the nearest
   *  loop or switch (a labelled plain statement is only reached by its own label). */
  jumpTarget(s, isContinue) {
    for (let i = this.loops.length - 1; i >= 0; i--) {
      const l = this.loops[i];
      if (s.label) { if ((l.labels ?? []).includes(s.label.text)) return isContinue && l.head === null ? null : l; continue; }
      if (l.plain) continue;
      if (isContinue && l.head === null) continue;
      return l;
    }
    return null;
  }
  // ---- statements ----
  seq(stmts, tails, p) {
    for (let i = 0; i < stmts.length; i++) { if (!tails.length) break; tails = this.stmt(stmts[i], tails, p + i); }
    return tails;
  }
  simple(s, tails, p, ops) {
    let n;
    if (tails.length === 1 && tails[0][1] === 'seq' && this.nodes[tails[0][0]].k === 'block' && !this.nodes[tails[0][0]].seal && this.nodes[tails[0][0]].xc === (this.curx() === null ? undefined : this.curx()) && this.nodes[tails[0][0]].h === (this.hstack.length ? this.hstack[this.hstack.length - 1] : undefined)) {
      n = tails[0][0]; this.nodes[n].eline = this.eline(s);
    } else { n = this.nw('block', this.line(s), p, this.eline(s)); this.conn(tails, n); }
    this.addOps(n, ops); return [[n, 'seq']];
  }
  stmt(s, tails, p) {
    const sf = this.sf;
    switch (s.kind) {
      case K.Block: return this.seq(s.statements, tails, p + '/b');
      case K.VariableStatement: { const o = []; for (const d of s.declarationList.declarations) { this.ops(d.initializer, o); if (d.name.kind === K.Identifier && d.initializer) o.push({ t: 'set', line: this.line(d), tgt: d.name.text, tk: 'name', v: valClass(d.initializer, sf), aug: false }); } return this.simple(s, tails, p, o); }
      case K.ExpressionStatement: return this.simple(s, tails, p, this.ops(s.expression));
      case K.FunctionDeclaration: case K.ClassDeclaration: this.nested.push(s); return tails;
      case K.ReturnStatement: {
        const v = s.expression;
        if (v && v.kind === K.ConditionalExpression) {
          const b = this.nw('branch', this.line(s), p, 0, { tk: 'ternary', test: short(v.condition.getText(sf), 70) });
          this.conn(tails, b); this.addOps(b, this.ops(v.condition));
          for (const [lab, arm] of [['T', v.whenTrue], ['F', v.whenFalse]]) { const r = this.nw('return', this.line(s), p + lab, 0, { sig: retSig(arm, sf), ...rvOf(arm) }); this.edge(b, r, lab); this.addOps(r, this.ops(arm)); this.edge(r, this.rett(), 'ret'); }
          return [];
        }
        const r = this.nw('return', this.line(s), p, this.eline(s), { sig: retSig(v, sf), ...rvOf(v) });
        this.conn(tails, r); if (v) this.addOps(r, this.ops(v)); this.edge(r, this.rett(), 'ret'); return [];
      }
      case K.ThrowStatement: {
        const e = s.expression; let exc = null, msg, ek = 'other';
        // ek: what was thrown, as written. Whether the text names a class or a variable is decided later, once the classes are known.
        if (e.kind === K.NewExpression || e.kind === K.CallExpression) { ek = e.kind === K.NewExpression ? 'new' : 'call'; exc = calleeText(e.expression); const a = e.arguments && e.arguments[0]; if (a && (a.kind === K.StringLiteral || a.kind === K.NoSubstitutionTemplateLiteral)) msg = short(a.text, 70); }
        else { exc = calleeText(e); ek = e.kind === K.Identifier ? 'name' : e.kind === K.PropertyAccessExpression ? 'attr' : 'other'; }
        const r = this.nw('raise', this.line(s), p, this.eline(s), { exc, ek, sig: 'raise:' + (exc ? exc.split('.').pop() : 'reraise'), ...(msg ? { msg } : {}) });
        this.conn(tails, r); this.addOps(r, this.ops(e)); const x = this.curx(); this.edge(r, x !== null ? x : this.xexit, 'exc'); return [];
      }
      case K.BreakStatement: { const j = this.nw('jump', this.line(s), p, 0, { jt: 'break' }); this.conn(tails, j); const lp = this.jumpTarget(s, false); if (lp) this.jumpOut(j, 'break', lp); return []; }
      case K.ContinueStatement: { const j = this.nw('jump', this.line(s), p, 0, { jt: 'continue' }); this.conn(tails, j); const L = this.jumpTarget(s, true); if (L) this.jumpOut(j, 'continue', L); return []; }
      case K.LabeledStatement: {
        this.labels.push(s.label.text);
        const k = s.statement.kind;
        if (k === K.LabeledStatement || k === K.WhileStatement || k === K.DoStatement || k === K.ForStatement || k === K.ForOfStatement || k === K.ForInStatement || k === K.SwitchStatement) return this.stmt(s.statement, tails, p);
        // any other labelled statement is a place `break label` can leave: the code after it is where those jumps land
        const lp = { head: null, brk: [], fd: this.fin.length, labels: this.takeLabels(), plain: true };
        this.loops.push(lp);
        const out = this.stmt(s.statement, tails, p);
        this.loops.pop();
        return out.concat(lp.brk);
      }
      case K.IfStatement: {
        const isElif = s.parent && s.parent.kind === K.IfStatement && s.parent.elseStatement === s;
        const b = this.nw('branch', this.line(s), p, 0, { tk: isElif ? 'elif' : 'if', test: short(s.expression.getText(sf), 90) });
        this.conn(tails, b); this.addOps(b, this.ops(s.expression));
        const ct = s.expression.kind === K.FalseKeyword ? false : s.expression.kind === K.TrueKeyword ? true : null;     // `if (false)`: the arm that cannot run gets no edge
        const t = ct === false ? [] : this.stmt(s.thenStatement, [[b, 'T']], p + '/b');
        const f = s.elseStatement ? (ct === true ? [] : this.stmt(s.elseStatement, [[b, 'F']], p + '/e')) : (ct === true ? [] : [[b, 'F']]);
        return t.concat(f);
      }
      case K.WhileStatement: case K.DoStatement: case K.ForStatement: case K.ForOfStatement: case K.ForInStatement: return this.loop(s, tails, p);
      case K.SwitchStatement: {
        const b = this.nw('branch', this.line(s), p, 0, { tk: 'match', test: short(s.expression.getText(sf), 70) });
        this.conn(tails, b); this.addOps(b, this.ops(s.expression));
        this.loops.push({ head: null, brk: [], fd: this.fin.length, labels: this.takeLabels() }); let fall = [], wild = false, out = [];
        s.caseBlock.clauses.forEach((c, j) => {
          if (c.kind === K.DefaultClause) wild = true;
          fall = this.seq(c.statements, [[b, 'c' + j], ...fall], p + '/c' + j);
        });
        const L = this.loops.pop(); out = fall.concat(L.brk);
        return out.concat(wild ? [] : [[b, 'nomatch']]);
      }
      case K.TryStatement: return this.tryS(s, tails, p);
      default: return this.simple(s, tails, p, []);
    }
  }
  loop(s, tails, p) {
    const sf = this.sf, isFor = s.kind === K.ForOfStatement || s.kind === K.ForInStatement;
    const test = s.kind === K.ForStatement ? short(s.condition ? s.condition.getText(sf) : '', 80) : isFor ? short(s.initializer.getText(sf) + ' of ' + s.expression.getText(sf), 80) : short(s.expression.getText(sf), 80);
    const h = this.nw('loop', this.line(s), p, 0, { tk: isFor || s.kind === K.ForStatement ? 'for' : 'while', test });
    this.conn(tails, h);
    const inf = (s.kind === K.WhileStatement && s.expression.kind === K.TrueKeyword) || (s.kind === K.ForStatement && !s.condition);
    if (inf) this.nodes[h].inf = 1;
    this.addOps(h, this.ops(isFor ? s.expression : s.kind === K.ForStatement ? s.condition : s.expression));
    this.loops.push({ head: h, brk: [], fd: this.fin.length, labels: this.takeLabels() });
    const dead = (s.kind === K.WhileStatement && s.expression.kind === K.FalseKeyword) || (s.kind === K.ForStatement && s.condition && s.condition.kind === K.FalseKeyword);
    const bt = dead ? [] : this.stmt(s.statement, [[h, 'T']], p + '/b');
    for (const [a, l] of bt) this.edge(a, h, l !== 'seq' ? l : 'loop');
    const L = this.loops.pop();
    return (inf ? [] : [[h, 'done']]).concat(L.brk);
  }
  tryS(s, tails, p) {
    const outer = this.curx(), hasFin = !!s.finallyBlock;
    let fe = null;
    if (hasFin) { fe = this.nw('final', this.line(s.finallyBlock), p + '/f'); this.xs.push(fe); this.fin.push(fe); }
    let d = null;
    if (s.catchClause) { d = this.nw('disp', this.line(s), p + '/d'); this.xs.push(d); }
    const tb = this.nw('block', this.line(s), p + '/tb'); this.conn(tails, tb);
    const bt = this.seq(s.tryBlock.statements, [[tb, 'seq']], p + '/b');
    if (d !== null) this.xs.pop();
    let ht = [];
    if (s.catchClause) {
      const c = s.catchClause, v = c.variableDeclaration && c.variableDeclaration.name.kind === K.Identifier ? c.variableDeclaration.name.text : null;
      const hn = this.nw('handler', this.line(c), p + '/h0', this.eline(c), { types: ['*'], var: v, ...(v && identsOf(c.block).includes(v) ? { uses: 1 } : {}) });
      this.edge(d, hn, 'exc'); this.hstack.push(hn);
      ht = this.seq(c.block.statements, [[hn, 'seq']], p + '/h0/b'); this.hstack.pop();
      this.edge(d, hasFin ? fe : (outer !== null ? outer : this.xexit), 'unmatched');
    }
    const normal = bt.concat(ht);
    if (!hasFin) return normal;
    this.xs.pop(); this.fin.pop(); this.conn(normal, fe);
    const ft = this.seq(s.finallyBlock.statements, [[fe, 'seq']], p + '/f');
    const into = this.edges.filter((e) => e[1] === fe);
    if (into.some((e) => e[2] === 'ret' || e[2] === 'fin-ret')) for (const [a] of ft) this.edge(a, this.rett(), 'fin-ret');   // a return out of an inner finally arrives by fin-ret
    if (into.some((e) => e[2] === 'exc' || e[2] === 'unmatched')) for (const [a] of ft) this.edge(a, outer !== null ? outer : this.xexit, 'fin-exc');
    for (const [kind, lp] of this.pend.get(fe) || []) {          // a break / continue that went through this finally leaves it by the same door
      for (const [a] of ft) {
        if (this.fin.length > lp.fd) this.edge(a, this.fin[this.fin.length - 1], 'jmp');
        else if (kind === 'break') lp.brk.push([a, 'brk']);
        else this.edge(a, lp.head, 'cont');
      }
      if (this.fin.length > lp.fd) { const o2 = this.fin[this.fin.length - 1]; if (!this.pend.has(o2)) this.pend.set(o2, []); this.pend.get(o2).push([kind, lp]); }
    }
    this.pend.delete(fe);
    for (const [a] of ft) if (this.nodes[a].k === 'block') this.nodes[a].seal = 1;     // the statement after a try must never be folded into the finally's last block
    return normal.length ? ft : [];
  }
}

// names bound in a function's own scope: parameters (destructured too), variables that are not themselves a nested function, the catch variable.
// A call of such a name is a call of the variable, never of a module-level function of the same name.
function localNames(node) {
  const out = new Set();
  const add = (nm) => { if (!nm) return; if (nm.kind === K.Identifier) out.add(nm.text); else if (nm.kind === K.ObjectBindingPattern || nm.kind === K.ArrayBindingPattern) for (const el of nm.elements) if (el.name) add(el.name); };
  for (const p of node.parameters || []) add(p.name);
  const walk = (n) => ts.forEachChild(n, (c) => {
    if (c.kind === K.FunctionDeclaration || c.kind === K.FunctionExpression || c.kind === K.ArrowFunction || c.kind === K.ClassDeclaration || c.kind === K.ClassExpression || c.kind === K.MethodDeclaration) return;
    if (c.kind === K.VariableDeclaration && !(c.initializer && (c.initializer.kind === K.ArrowFunction || c.initializer.kind === K.FunctionExpression))) add(c.name);
    if (c.kind === K.CatchClause && c.variableDeclaration) add(c.variableDeclaration.name);
    walk(c);
  });
  if (node.body) walk(node.body);
  return [...out].sort();
}

function build(node, rel, qual, cls, sf) {
  const b = new FB(node, rel, qual, cls, sf);
  const body = node.body || node;
  const tails = node.kind === K.SourceFile ? b.seq(node.statements, [[b.entry, 'seq']], '') :
    body.kind === K.Block ? b.seq(body.statements, [[b.entry, 'seq']], '') : (() => { const r = b.nw('return', b.line(body), '0', 0, { sig: retSig(body, sf) }); b.edge(b.entry, r, 'seq'); b.addOps(r, b.ops(body)); b.edge(r, b.exit, 'ret'); return []; })();
  b.conn(tails, b.exit);
  const params = (node.parameters || []).map((pm) => [pm.name.getText(sf), pm.type ? short(pm.type.getText(sf), 50) : '']);
  return { rec: { id: `${rel}::${qual}`, path: rel, qual, cls, lang: 'ts', line: node.kind === K.SourceFile ? 1 : b.line(node), end: b.eline(node), async: !!(node.modifiers || []).some((m) => m.kind === K.AsyncKeyword), ...(node.asteriskToken ? { gen: true } : {}), params, decos: [], locs: node.kind === K.SourceFile ? [] : localNames(node), nodes: b.nodes, edges: b.edges, rd: [...b.rd].sort(), entry: b.entry, exit: b.exit, xexit: b.xexit }, nested: b.nested };
}
return { build, calleeText, identsOf, short };
}
