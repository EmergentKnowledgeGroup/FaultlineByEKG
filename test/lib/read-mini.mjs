// A tiny stand-in for the map and for an independent check of journeys, on invented code (fixtures/desk).
// A function is written as a list of statements with their line numbers; from it come (1) the boxes and roads a map would have, (2) the control-flow
// graph of the same function, and (3) a check that every step of a journey can follow the one before it on that graph.
// The check shares nothing with the reading rules: it walks the graph.

const P = 'desk.py';
const T = 'ticket.ts';

/** Statements: ['call', line, key] | ['if', line, test, thenList, elseList?] | ['ret', line, expr] | ['raise', line, expr] | ['loop', line, test, body] | ['switch', line, test, [[label, caseLine, list]...]] | ['break', line] */
export const DESK = {
  handle: { path: P, line: 1, body: [
    ['call', 2, 'lookup'],
    ['if', 3, 'not user', [['raise', 4, 'PermissionError("no user")']]],
    ['if', 5, 'request.kind == "refund"', [['call', 6, 'refund'], ['ret', 7, '"refunded"']], [
      ['if', 8, 'request.kind == "close"', [['call', 9, 'close'], ['ret', 10, '"closed"']]],
    ]],
    ['call', 11, 'audit'],
    ['ret', 12, '"ok"'],
  ] },
  lookup: { path: P, line: 15, body: [
    ['if', 16, 'request.id is None', [['ret', 17, 'None']]],
    ['ret', 18, 'find(request.id)', 'find'],
  ] },
  find: { path: P, line: 21, body: [
    ['loop', 22, 'item in TABLE', [['if', 23, 'item.id == ident', [['ret', 24, 'item']]]]],
    ['ret', 25, 'None'],
  ] },
  refund: { path: P, line: 28, body: [['call', 29, 'ledgerWrite'], ['call', 30, 'notify']] },
  close: { path: P, line: 33, body: [['call', 34, 'ledgerClose']] },
  audit: { path: P, line: 37, body: [['if', 38, 'request.kind == "audit"', [['call', 39, 'logRecord']]]] },
  notify: { path: P, line: 42, body: [
    ['if', 43, 'request.quiet', [['ret', 44, 'False']]],
    ['call', 45, 'mailerSend'],
    ['ret', 46, 'True'],
  ] },
  route: { path: P, line: 49, body: [
    ['if', 50, 'path == "/refund"', [['ret', 51, 'handle_refund()', 'handle_refund', 'shared']]],
    ['if', 52, 'path == "/close"', [['ret', 53, 'handle_close()', 'handle_close', 'shared']]],
    ['ret', 54, '"not found"'],
  ] },
  handle_refund: { path: P, line: 57, body: [['call', 58, 'refund'], ['ret', 59, '"refund done"']] },
  handle_close: { path: P, line: 62, body: [['call', 63, 'close'], ['ret', 64, '"close done"']] },
  dispatch: { path: T, line: 1, body: [
    ['if', 2, '!msg.ok', [['ret', 3, '']]],
    ['switch', 5, 'msg.cmd', [['open', 6, [['call', 7, 'openTicket'], ['break', 8]]], ['close', 9, [['call', 10, 'closeTicket'], ['break', 11]]], ['default', 12, [['call', 13, 'ignore']]]]],
    ['call', 15, 'record'],
  ] },
  openTicket: { path: T, line: 18, body: [['call', 19, 'storeAdd']] },
  closeTicket: { path: T, line: 22, body: [['call', 23, 'storeRemove']] },
  ignore: { path: T, line: 26, body: [['if', 27, 'msg.loud', [['raise', 27, "new Error('unexpected message')"]]], ['call', 28, 'trace']] },
  record: { path: T, line: 31, body: [['call', 32, 'historyPush']] },
};
const fid = (k) => `${DESK[k].path}::${k}`;

/** Control-flow graph: nodes {i, k, line}, edges [from, to, label]. */
function cfgOf(key) {
  const nodes = [];
  const edges = [];
  const mk = (k, line) => (nodes.push({ i: nodes.length, k, line }), nodes.length - 1);
  const entry = mk('entry', 0);
  const exit = mk('exit', 0);
  const loopsOpen = [];
  const block = (list, from, label, after) => {
    let cur = [[from, label]];
    for (const st of list) cur = stmt(st, cur, after);
    return cur;
  };
  const link = (cur, to) => cur.forEach(([a, l]) => edges.push([a, to, l]));
  const stmt = (st, cur, after) => {
    const [kind, line] = st;
    if (kind === 'call') {
      const n = mk('call', line);
      link(cur, n);
      return [[n, 'n']];
    }
    if (kind === 'ret' || kind === 'raise') {
      const n = mk(kind, line);
      link(cur, n);
      edges.push([n, exit, 'n']);
      return [];
    }
    if (kind === 'break') {
      const n = mk('break', line);
      link(cur, n);
      after.breaks.push(n);
      return [];
    }
    if (kind === 'if') {
      const b = mk('branch', line);
      link(cur, b);
      const t = block(st[3], b, 'T', after);
      const e = st[4] ? block(st[4], b, 'F', after) : [[b, 'F']];
      return [...t, ...e];
    }
    if (kind === 'loop') {
      const b = mk('branch', line);
      link(cur, b);
      const body = block(st[3], b, 'T', after);
      body.forEach(([a, l]) => edges.push([a, b, l]));
      loopsOpen.push(b);
      return [[b, 'F']];
    }
    if (kind === 'switch') {
      const b = mk('branch', line);
      link(cur, b);
      const sub = { breaks: [] };
      let fall = [];
      const outs = [];
      for (const [, cl, list] of st[3]) {
        const c = mk('case', cl);
        edges.push([b, c, 'c']);
        link(fall, c);
        fall = block(list, c, 'n', sub);
      }
      return [...fall, ...sub.breaks.map((n) => [n, 'n']), ...outs, [b, 'nomatch']];
    }
    throw new Error(`unknown statement ${kind}`);
  };
  const end = block(DESK[key].body, entry, 'n', { breaks: [] });
  end.forEach(([a, l]) => edges.push([a, exit, l]));
  return { entry, exit, nodes, edges };
}

/** Boxes, roads and facts as a map would give them for the functions named. */
export function deskModel(keys = Object.keys(DESK), { withFacts = true } = {}) {
  const boxes = [];
  const routes = [];
  const facts = { schema: 'faultline.facts/1', modules: [], functions: {}, entries: [], switches: [] };
  const entryOf = new Map();
  for (const k of keys) {
    const f = DESK[k];
    const id = fid(k);
    const mine = [];
    const add = (suffix, kind, line, rule, title, prov = {}, extra = {}) => {
      const b = { id: `${k}.${suffix}`, kind, title, detail: title, plain: '', stage: 's', status: 'live', handle: k, refs: [{ path: f.path, line, symbol: id }], prov: { fn: id, line, rule, src: 'det', ...prov }, ...extra };
      boxes.push(b);
      mine.push(b);
      return b;
    };
    const walk = (list, ctx) => {
      for (const st of list) {
        const [kind, line] = st;
        if (kind === 'if') {
          const d = add(`d${line}`, 'decision', line, 'decision', st[2]);
          st.box = d;
          walk(st[3], d);
          if (st[4]) walk(st[4], d);
        } else if (kind === 'loop') {
          const d = add(`l${line}`, 'decision', line, 'loop', `loop: ${st[2]}`);
          st.box = d;
          walk(st[3], d);
        } else if ((kind === 'ret' || kind === 'raise') && st[4] === 'shared') {
          // returns that share one box, as the map does for endings that say the same thing
          const old = mine.find((b) => b.id === `${k}.eshared`);
          if (old) old.prov.sites.push(line);
          else add('eshared', 'end', line, 'end', 'returns a value', { sites: [line], class: 'RB:call' }, { outcome: 'success' });
        } else if (kind === 'ret' || kind === 'raise') {
          const e = add(`e${line}`, 'end', line, 'end', kind === 'raise' ? `raises ${st[2]}` : `returns ${st[2]}`, { sites: [line], class: kind === 'raise' ? 'raise:Error' : 'R:const' }, { outcome: kind === 'raise' ? 'failure' : 'success' });
          st.box = e;
        } else if (kind === 'switch') {
          for (const [, , l] of st[3]) walk(l, ctx);
        }
      }
    };
    walk(f.body, null);
    entryOf.set(k, mine[0] ?? null);
    f.boxes = mine;
  }
  // roads inside a function: from each box to the next boxes the control-flow graph reaches without passing another box
  for (const k of keys) {
    const g = cfgOf(k);
    const f = DESK[k];
    const boxAt = new Map(f.boxes.map((b) => [b.prov.line, b]));
    for (const b of f.boxes) for (const x of b.prov.sites ?? []) boxAt.set(x, b);
    const succ = new Map();
    for (const [a, b, l] of g.edges) succ.set(a, [...(succ.get(a) ?? []), [b, l]]);
    for (const n of g.nodes) {
      const from = n.k === 'branch' || n.k === 'ret' || n.k === 'raise' ? boxAt.get(n.line) : null;
      if (!from || from.kind === 'end') continue;
      for (const [b0, l0] of succ.get(n.i) ?? []) {
        const seen = new Set();
        const go = (x, label) => {
          if (seen.has(x)) return;
          seen.add(x);
          const m = g.nodes[x];
          const bx = (m.k === 'branch' || m.k === 'ret' || m.k === 'raise') && boxAt.get(m.line);
          if (bx) {
            routes.push({ id: `${from.id}->${bx.id}:${label}`, from: from.id, to: bx.id, type: 'forward', when: label === 'F' ? 'else' : from.prov.rule === 'loop' ? 'each item' : from.title, why: '', refs: [], inferred: false, prov: { rule: 'cfg-edge', tier: 'proven', basis: 'control-flow', src: 'det', line: 0 } });
            return;
          }
          for (const [y] of succ.get(x) ?? []) go(y, label);
        };
        go(b0, l0 === 'F' ? 'F' : 'T');
      }
    }
  }
  // calls: a road from the nearest box above the call (the first box when none) to the first box of the callee
  const calleeKey = (name) => keys.find((k) => k === name);
  for (const k of keys) {
    const f = DESK[k];
    const calls = [];
    const collect = (list) => list.forEach((st) => {
      if (st[0] === 'call') calls.push([st[1], st[2]]);
      if (st[0] === 'ret' && st[3]) calls.push([st[1], st[3]]);
      if (st[0] === 'if') { collect(st[3]); if (st[4]) collect(st[4]); }
      if (st[0] === 'loop') collect(st[3]);
      if (st[0] === 'switch') st[3].forEach(([, , l]) => collect(l));
    });
    collect(f.body);
    const sorted = [...f.boxes].sort((a, b) => a.prov.line - b.prov.line);
    for (const [line, name] of calls) {
      const target = calleeKey(name) && entryOf.get(calleeKey(name));
      if (!target) continue;
      // the box whose range the call is in: the nearest decision above it, else the nearest box, else the first
      const above = sorted.filter((b) => b.prov.line <= line && b.kind !== 'end');
      const from = above[above.length - 1] ?? sorted[0];
      if (!from) continue;
      routes.push({ id: `${from.id}->${target.id}:call${line}`, from: from.id, to: target.id, type: 'forward', when: `calls ${name}`, why: '', refs: [], inferred: false, prov: { rule: 'call', tier: 'proven', basis: 'type', src: 'det', line, lines: [line], how: 'exact' } });
    }
    const fx = { path: f.path, qual: k, line: f.line, end: Math.max(...f.boxes.map((b) => b.prov.line), f.line) + 3, doc: '', async: false, decorators: [], calls: [], unresolved: [], returns: [], raises: [], excepts: [], callAt: [] };   // no branch records: the blocks are read from the source
    facts.functions[fid(k)] = fx;
  }
  const model = { schema: 'faultline.model/1', tool: 'test', system: { name: 'desk', resolvers: {}, environment: {}, says: [], undecided: {}, unread: [] }, stages: [], boxes, routes, loops: [], paths: [], charts: [], terms: [] };
  facts.entries.push({ fn: fid('handle'), kind: 'export', why: 'exported' }, { fn: fid('route'), kind: 'export', why: 'exported' }, { fn: fid('dispatch'), kind: 'export', why: 'exported' });
  return { model, claims: [], facts: withFacts ? facts : null, entryOf };
}

/** The graphs the check reads: by function id. */
export function deskGraphs(keys = Object.keys(DESK)) {
  return Object.fromEntries(keys.map((k) => [fid(k), { ...cfgOf(k), file: DESK[k].path }]));
}

/**
 * Every step of a journey must be reachable from the one before it, on the arm it took, in its own call. Returns the steps that are not.
 * Frames follow the journey's depth: a call is an event of the caller at the line it was made on.
 */
export function impossibleSteps(journey, graphs) {
  const bad = [];
  const stack = {};
  const closure = (g, start, S) => {
    const seen = new Set(start);
    const w = [...start];
    while (w.length) for (const [y] of S.get(w.pop()) ?? []) if (!seen.has(y)) { seen.add(y); w.push(y); }
    return seen;
  };
  const frame = (fidx) => {
    const g = graphs[fidx];
    if (!g) return null;
    const S = new Map();
    for (const [a, b, l] of g.edges) S.set(a, [...(S.get(a) ?? []), [b, l]]);
    return { g, S, cur: closure(g, [g.entry], S) };
  };
  const event = (fr, line, took, what) => {
    if (!fr) return;
    const here = fr.g.nodes.filter((n) => n.line === line && n.k !== 'entry' && n.k !== 'exit').map((n) => n.i);
    const ok = here.filter((x) => fr.cur.has(x));
    if (!ok.length) {
      bad.push(`${what} at line ${line}`);
      return;
    }
    const next = [];
    for (const x of ok) {
      const n = fr.g.nodes[x];
      if ((took === 'yes' || took === 'no') && n.k === 'branch') {
        for (const [y, l] of fr.S.get(x) ?? []) if (took === 'yes' ? l === 'T' : l === 'F' || l === 'nomatch') next.push(y);
      } else next.push(x);
    }
    fr.cur = closure(fr.g, next.length ? next : ok, fr.S);
  };
  for (const st of journey.steps) {
    const d = st.depth ?? 0;
    for (const k of Object.keys(stack)) if (+k > d) delete stack[k];
    if (st.kind === 'enter') {
      if (st.via?.kind === 'call' && st.via.line && stack[d - 1]) event(stack[d - 1], st.via.line, null, `call into ${st.fn}`);
      stack[d] = frame(st.fid);
    } else if (['decision', 'loop', 'work', 'wait', 'end', 'step'].includes(st.kind)) event(stack[d], st.line, st.took, `${st.kind} "${st.title}"`);
    else if (st.kind === 'folded' && st.line && stack[d - 1]) event(stack[d - 1], st.line, null, `call to ${st.fn}`);
  }
  return bad;
}

export { fid, DESK as DESK_STATEMENTS, P as DESK_PY, T as DESK_TS };
