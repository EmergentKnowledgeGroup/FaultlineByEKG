// Boxes and roads from the reduced graphs. Every box and road carries `prov`: rule, function, lines.
// Boxes and the control-flow roads live here; call roads and exception roads live in roadpass.mjs.
import { FnRed } from './reduce.mjs';
import { tclass } from './vocab.mjs';
import { RoadMethods, EXACT } from './roadpass.mjs';
import { short, replace1, uniq, sorted } from './pyrt.mjs';
import { tkey } from './canon.mjs';
import { createHash } from 'node:crypto';

const EFFECT_KINDS = new Set(['store', 'delete', 'emit', 'respond', 'print']);
const STRUCTURAL = new Set(['entry', 'exit', 'xexit']);
const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);

const EXC_EDGES = new Set(['exc', 'unmatched', 'fin-exc', 'catch']);
const JUMP_EDGES = new Set(['brk', 'cont', 'jmp']);
/** The door of a finally block an edge goes in or out by: return, exception, a jump out of a loop, or the ordinary way through. */
const doorOf = (l) => (l === 'ret' || l === 'fin-ret' ? 'ret' : EXC_EDGES.has(l) ? 'exc' : JUMP_EDGES.has(l) ? 'jmp' : 'normal');

const ID_HASH_LEN = 8; // hex digits of the hash that tells two functions with one stem apart: 32 bits; a clash after that is settled by a counter

/** The part of a box id that names its function: the file without its extension, folders as dots, characters outside letters, digits, _ and . as _,
 *  then the qualified name. Different functions can have the same stem (a-b.ts and a_b.ts, x.ts and x.js, a.b.ts and a/b.ts, accented names). */
export function stemOf(fid) {
  const i = fid.indexOf('::');
  const path = fid.slice(0, i);
  const qual = fid.slice(i + 2);
  const dot = path.lastIndexOf('.');
  const base = (dot >= 0 ? path.slice(0, dot) : path).replace(/\//g, '.').replace(/[^A-Za-z0-9_.]/gu, '_');
  return `${base}.${qual.replace(/</g, '_').replace(/>/g, '_')}`;
}

/** Stems for the mapped functions. A stem that more than one function has is made unique for each of them by a hash of that function's full id, so
 *  an id depends only on its own function and on whether another one shares its stem, never on the order they were found in. */
export function stemTable(fids) {
  const count = new Map();
  for (const fid of fids) count.set(stemOf(fid), (count.get(stemOf(fid)) ?? 0) + 1);
  const out = new Map();
  for (const fid of fids) {
    const st = stemOf(fid);
    out.set(fid, count.get(st) > 1 ? `${st}-${createHash('sha256').update(fid, 'utf8').digest('hex').slice(0, ID_HASH_LEN)}` : st);
  }
  return out;
}

export function bid(fid, code, syn, stem = stemOf(fid)) {
  return `${stem}.${code}${syn.replace(/\//g, '-')}`;
}

function effOf(nodes) {
  const s = new Set();
  for (const nd of nodes) for (const o of nd.ops ?? []) for (const e of o.eff ?? []) if (EFFECT_KINDS.has(e) || e.startsWith('ext') || e.startsWith('wait')) s.add(e);
  return s;
}

/** 'RB:dict{ok,error}' -> 'a dict{ok,error}' */
function rbTitle(c) {
  const k = c.slice(3);
  if (k.startsWith('call:')) return `the result of ${k.slice(5)}()`;
  return { list: 'a list', set: 'a set', fstr: 'a string', tuple: 'a tuple' }[k] || 'a ' + k;
}

const DISP_WORDS = { translate: 'turns it into another error', swallow: 'drops it', log: 'logs it', reraise: 'passes it on', 'reraise-sometimes': 'passes it on on some paths only', return: 'returns instead', unknown: 'does something unknown' };

export function catchPhrase(c, v) {
  if (c.startsWith('raise-up')) return ' (nothing in the mapped folder above it catches it)';
  if (c.startsWith('raise-open') && v) return ` (no known catcher: ${v.open} open end${v.open !== 1 ? 's' : ''})`;
  if (c.startsWith('raise-caught') && v) {
    const ds = v.dispositions.map((d) => DISP_WORDS[d] ?? d);
    return ` (caught on a known path: a handler ${ds.join(' / ')}` + (v.open ? `; ${v.open} other end${v.open !== 1 ? 's' : ''} not followed` : '') + ')';
  }
  return c.startsWith('raise-heard') ? ' (a handler tells someone)' : '';
}

export class MapBuilder {
  constructor(P, F, V, opts = {}) {
    this.P = P;
    this.F = F;
    this.V = V;
    this.o = opts;
    this.boxes = new Map();
    this.roads = new Map();
    this.node2box = new Map();
    this.entry = new Map();
    this.cfgpairs = new Map();
  }

  /** node -> box id for one function (created on first use) */
  n2b(fid) {
    let m = this.node2box.get(fid);
    if (!m) this.node2box.set(fid, (m = new Map()));
    return m;
  }

  addBox(b) {
    if (this.boxes.has(b.id)) { // two different stems that still meet (a class named like a method of another): a counter, in the order the boxes are made
      let n = 2;
      while (this.boxes.has(`${b.id}-${n}`)) n += 1;
      b.id = `${b.id}-${n}`;
    }
    this.boxes.set(b.id, b);
    return b.id;
  }

  build() {
    const { P, F, V } = this;
    this.red = new Map();
    this.steps = new Map();
    for (const fid of P.fids) {
      const r = new FnRed(P.fns.get(fid), F, V).run();
      this.red.set(fid, r);
      this.steps.set(fid, r.steps());
    }
    // which functions are on the map: has a real box, or does effects, or takes part in a resolved call (below)
    const mapped = new Set(P.fids.filter((fid) => this.red.get(fid).boxed.size));
    for (const [fid, st] of this.steps) if (st.some(([c]) => effOf(c.map((i) => P.fns.get(fid).nodes[i])).size)) mapped.add(fid);
    // A road needs a box at each end, so a function that takes part in a resolved call joins the map: as the caller, its calls get roads that start
    // in it; as the callee, the calls to it have a box to arrive at. Without this a call to a helper with nothing of its own to show would have no
    // road at all, or only one that skips the helper.
    for (const fid of P.fids) {
      const reach = this.red.get(fid).reach;
      for (const nd of P.fns.get(fid).nodes) {
        if (!reach.has(nd.i)) continue;
        for (const o of nd.ops ?? []) {
          for (const g of [...this.callEnds(o), ...(o.cbr ?? []).filter((c) => c.kind === 'named').flatMap((c) => c.to)]) {
            if (g === fid || !P.fns.has(g)) continue;
            mapped.add(fid);
            mapped.add(g);
          }
        }
      }
    }
    // A function written inline as a callback has a box of its own only when it is on the map for its own reasons (a bare arrow that reads a field is part
    // of the code around it); its owner then joins, so the callback has a road to arrive by (a closure inside a closure carries the chain upward). A
    // named function handed over joined above, like any function that is called.
    for (let grew = true; grew;) {
      grew = false;
      for (const fid of P.fids) {
        if (mapped.has(fid)) continue;
        const reach = this.red.get(fid).reach;
        if (P.fns.get(fid).nodes.some((nd) => reach.has(nd.i) && (nd.ops ?? []).some((o) => (o.cbr ?? []).some((c) => c.to.some((g) => g !== fid && mapped.has(g)))))) {
          mapped.add(fid);
          grew = true;
        }
      }
    }
    this.mapped = mapped;
    this.stems = stemTable(P.fids.filter((fid) => mapped.has(fid)));
    const each = (fn) => { for (const fid of P.fids) if (mapped.has(fid)) fn(fid); };
    each((fid) => this.makeBoxes(fid));
    this.setupPasses();
    each((fid) => this.makeTryBoxes(fid));
    each((fid) => this.makeStartBoxes(fid));
    this.makeLandingBoxes(each);
    each((fid) => this.entryOf(fid));
    each((fid) => this.makeRoads(fid));
    each((fid) => this.makeCallRoads(fid));
    each((fid) => this.makeExcRoads(fid));
    return this;
  }

  // ---- boxes -----------------------------------------------------------------------------------------------------
  ref(fn, nd, line = null) {
    return { path: fn.path, symbol: fn.id, line: line || nd.line };
  }

  /** The line of the first op in the run that carries the effect the box names. */
  effectLine(ns, want) {
    for (const nd of ns) for (const o of nd.ops ?? []) if ((o.eff ?? []).some(want)) return o.line;
    return null;
  }

  makeBoxes(fid) {
    const { F } = this;
    const fn = this.P.fns.get(fid);
    const r = this.red.get(fid);
    const nodes = fn.nodes;
    const n2b = this.n2b(fid);
    const ends = new Map();
    const endmsg = new Map();
    for (const i of [...r.boxed.keys()].sort((a, b) => a - b)) {
      const nd = nodes[i];
      const k = r.boxed.get(i);
      if (k === 'end') {
        const c = r.termClass(i);
        if (ends.has(c)) {
          const b = this.boxes.get(ends.get(c));
          b.prov.sites.push(nd.line);
          endmsg.get(c).push([nd.line, nd.msg ?? null]);
          if (b.refs.length < 6) b.refs.push(this.ref(fn, nd)); // every site is cited, not only the first
          n2b.set(i, ends.get(c));
          continue;
        }
        endmsg.set(c, [[nd.line, nd.msg ?? null]]);
        let t = { X: 'exits the process', RB: 'returns a value to its caller (entry)' }[c] ?? null;
        if (t === null && c.startsWith('RB:')) t = `returns ${rbTitle(c)} to its caller (entry)`;
        else if (t === null && c.startsWith('raise')) t = 'raises ' + c.slice(c.indexOf(':') + 1) + (nd.msg ? `: ${nd.msg}` : '') + catchPhrase(c, r.catch.get(i));
        else if (t === null) t = 'returns ' + (nd.rtext ? nd.rtext : c.slice(2).replaceAll('const:str:', '').replaceAll('const:', ''));
        const pv = { class: c, sites: [nd.line] };
        if (r.catch.get(i)) {
          const v = r.catch.get(i);
          pv.nobody_catches = { value: v.value, open_ends: v.open, paths_uncaught: v.paths_uncaught, paths: v.paths, why: v.why.map((w) => [...w]) };
        }
        const b = this.mk(fid, 'e', nd, 'end', t, k, pv);
        ends.set(c, b);
        n2b.set(i, b);
      } else if (k === 'decision') {
        let t;
        let pv;
        if (r.chains.has(i)) {
          const tests = r.chains.get(i).map(([m]) => nodes[m].test);
          t = tests.slice(0, 3).map((x) => short(x, 40)).join(' | ') + (tests.length > 3 ? ' ...' : '');
          pv = { chain: r.chains.get(i).map(([m]) => nodes[m].line) };
        } else [t, pv] = [short(nd.test ?? '', 80), {}];
        pv.why = r.why.get(i) ?? '';
        const worked = (r.chains.has(i) ? r.chains.get(i).map(([m]) => m) : [i]).filter((m) => r.doesWork(nodes[m]));
        if (worked.length) { // the condition itself has an effect (it deletes, stores, sends): the decision says so
          pv.test_nodes = worked;
          pv.test_effects = sorted(new Set(worked.flatMap((m) => [...effOf([nodes[m]])])));
        }
        n2b.set(i, this.mk(fid, 'd', nd, 'decision', t, k, pv));
        const members = new Set((r.chains.get(i) ?? []).map(([m]) => m));
        for (const m of r.skipped) if (members.has(m)) n2b.set(m, n2b.get(i));
      } else if (k === 'loop') {
        n2b.set(i, this.mk(fid, 'l', nd, 'decision', 'loop: ' + short(nd.test ?? '', 70), k, { bound: nd.inf ? 'none' : 'test' }));
      } else if (k === 'wait') {
        const ops = (nd.ops ?? []).filter((o) => (o.eff ?? []).some((e) => e.startsWith('wait')) || (o.eff ?? []).includes('lockwith'));
        const f = ops.length ? ops[0].ctx || ops[0].f : '';
        const kind = ops.flatMap((o) => o.eff ?? []).find((e) => e.startsWith('wait')) ?? 'wait:machine';
        const pv = { on: kind.slice(5) || 'machine', calls: ops.map((o) => o.f ?? null).slice(0, 3), folded_lines: [nd.line, nd.eline ?? nd.line] };
        n2b.set(i, this.mk(fid, 'w', nd, 'wait', `waits: ${short(f || '?', 60)}`, k, pv, ops.length ? ops[0].line : null));
      } else if (k === 'handler') {
        const lab = F.regionEffects(fid, i);
        const disp = F.disposition(lab);
        n2b.set(i, this.mk(fid, 'h', nd, 'step', `on ${(nd.types ?? []).join('/')}: ${disp === 'reraise-sometimes' ? 'sometimes reraise' : disp}`, k, { disposition: disp, labels: sorted(lab) }));
      }
    }
    for (const [c, bid_] of ends) { // one message for several raises is a false sentence: say it only when the sites agree
      const ms = endmsg.get(c);
      const b = this.boxes.get(bid_);
      if (ms.length > 1) {
        b.prov.messages = ms.slice(0, 12).map(([ln, m]) => [ln, m]);
        if (new Set(ms.map(([, m]) => m)).size > 1 && c.startsWith('raise')) {
          const ty = c.slice(c.indexOf(':') + 1);
          b.title = ms[0][1] ? replace1(b.title, ': ' + ms[0][1], '') : b.title;
          b.title = replace1(b.title, 'raises ' + ty, `raises ${ty} at ${ms.length} places, with different messages`);
        }
      }
    }
    // effect steps and the prologue
    const entrySucc = r.S(fn.entry);
    const first = entrySucc.length ? entrySucc[0][0] : null;
    // a step is boxed when it does an effect or holds the prologue; a step that only calls mapped functions is folded into the box upstream of it,
    // unless the function has no other box at all: then each such step is the only place its calls can hang from
    const lonely = !r.boxed.size && !this.steps.get(fid).some(([c]) => effOf(c.map((i) => nodes[i])).size || c.includes(first));
    for (const [c] of this.steps.get(fid)) {
      const ns = c.map((i) => nodes[i]);
      const eff = effOf(ns);
      const isPro = c.includes(first);
      const calls = [];
      for (const nd of ns) for (const o of nd.ops ?? []) {
        if (o.t === 'call' && o.to?.length && EXACT.has(o.how)) calls.push(...o.to.filter((g) => this.mapped.has(g)).map((g) => g.split('::')[1]));
      }
      if (!(eff.size || isPro || (calls.length && lonely))) continue;
      const mk = eff.has('store') || eff.has('delete') ? 'store' : [...eff].some((e) => e.startsWith('ext')) ? 'external' : 'step';
      let title = eff.size ? 'does ' + sorted([...eff].map((e) => e.replaceAll('ext:', ''))).join(', ') : 'runs ' + fn.qual;
      if (calls.length) title += ' ; calls ' + uniq(calls.slice(0, 3)).join(', ');
      // cite the line of the effect itself (or of the first call), not the start of the run; the run is folded_lines
      const want = mk === 'store' ? (e) => e === 'store' || e === 'delete' : mk === 'external' ? (e) => e.startsWith('ext') : (e) => EFFECT_KINDS.has(e) || e.startsWith('ext') || e.startsWith('wait');
      let line = this.effectLine(ns, want);
      if (line === null) {
        for (const nd of ns) for (const o of nd.ops ?? []) {
          if (line === null && o.t === 'call' && o.to?.length && EXACT.has(o.how) && o.to.some((g) => this.mapped.has(g))) line = o.line;
        }
      }
      const last = ns[ns.length - 1];
      const b = this.mk(fid, 's', ns[0], mk, title, 'step', { effects: sorted(eff), nodes: ns.map((n) => n.i).slice(0, 40), folded_lines: [ns[0].line, last.eline ?? last.line] }, line);
      for (const i of c) n2b.set(i, b);
    }
  }

  /** A function on the map that still has no box (it decides nothing, does no work the map names, and nothing above its calls got a box) gets one
   *  box for the whole body, so the calls that arrive at it and the calls it makes have a box to start from and to reach. */
  makeLandingBoxes(each) {
    const withBox = new Set([...this.boxes.values()].map((b) => b.fn));
    each((fid) => {
      if (withBox.has(fid)) return;
      const fn = this.P.fns.get(fid);
      const body = fn.nodes.filter((n) => !STRUCTURAL.has(n.k));
      const nd = body[0] ?? fn.nodes[fn.entry];
      const calls = [];
      for (const n of body) for (const o of n.ops ?? []) if (this.makesRoad(o)) calls.push(...this.endsOf(o).filter((g) => this.P.fns.has(g) && g !== fid).map((g) => g.split('::')[1]));
      let title = 'runs ' + fn.qual;
      if (calls.length) title += ' ; calls ' + uniq(calls.slice(0, 3)).join(', ');
      const last = body.length ? body[body.length - 1] : nd;
      const b = this.mk(fid, 's', nd, 'step', title, 'step', { effects: [], nodes: body.map((n) => n.i).slice(0, 40), folded_lines: [nd.line, last.eline ?? last.line], landing: true });
      const n2b = this.n2b(fid);
      for (const n of body) n2b.set(n.i, b);
      this.first.set(fid, b);
    });
  }

  mk(fid, code, nd, kind, title, rule, prov, line = null) {
    const fn = this.P.fns.get(fid);
    Object.assign(prov, { rule, fn: fid, line: line || nd.line, syn: nd.syn, src: 'det' });
    const b = { id: bid(fid, code, nd.syn || '0', this.stems.get(fid)), kind, title, handle: fn.qual, status: 'live', refs: [this.ref(fn, nd, line)], prov, fn: fid };
    return this.addBox(b);
  }

  // ---- control-flow roads --------------------------------------------------------------------------------------------
  /** Per function: the finally blocks a node is inside (`inside`), and the ones that have a door of their own for jumps (`finjmp`). */
  doorsOf(fid) {
    this.doorCache ??= new Map();
    if (!this.doorCache.has(fid)) {
      const fn = this.P.fns.get(fid);
      const fb = this.finbodies(fid);
      const finals = fn.nodes.some((n) => n.k === 'final');
      const inside = (i) => {
        const r = new Set(fb.get(i) ?? []);
        if (fn.nodes[i].k === 'final') r.add(i);
        return r;
      };
      // a break or continue that goes in at a finally is the way the finally is left only when that finally has a jump out of its own; otherwise the
      // finally is simply what comes next
      const finjmp = new Set();
      if (finals) for (const [a, b, l] of fn.edges) if (JUMP_EDGES.has(l)) for (const f of inside(a)) if (!inside(b).has(f)) finjmp.add(f);
      this.doorCache.set(fid, { finals, inside, finjmp });
    }
    return this.doorCache.get(fid);
  }

  /** From node `start`, walk through folded nodes; return [boxes reached, folded terminals passed, via]. A return, and a raise that can leave the
   *  function, are terminals; a raise that a handler takes keeps walking into it. via[box] = the line of the raise statement the first path to that
   *  box went through (a handled raise), else null. A finally block is left by the door it was entered by: a walk that went in by a return leaves by the
   *  return door, one that went in by an exception by the exception door, one that went in the ordinary way by the ordinary way. `startLabel` is the edge
   *  the walk entered `start` by. */
  frontier(fid, start, startLabel = '') {
    const r = this.red.get(fid);
    const nodes = this.P.fns.get(fid).nodes;
    const n2b = this.n2b(fid);
    const seen = new Set();
    const stack = [[start, null]];
    const hit = [];
    const minor = [];
    const via = new Map();
    const fin = new Map(); // box in a finally block -> line of the return that goes through it
    const D = this.doorsOf(fid);
    const entered = (j, l) => (JUMP_EDGES.has(l) && !D.finjmp.has(j) ? 'normal' : doorOf(l));
    stack[0].push(nodes[start].k === 'final' ? [[start, entered(start, startLabel)]] : []);
    while (stack.length) {
      const [x, c, doors] = stack.shift();
      const key = `${x}|${doors.map((d) => d.join(':')).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (n2b.has(x)) {
        if (!hit.includes(n2b.get(x))) {
          hit.push(n2b.get(x));
          via.set(n2b.get(x), c);
        }
        continue;
      }
      const nd = nodes[x];
      if (nd.k === 'exit' || nd.k === 'return' || nd.nr || (nd.k === 'raise' && (r.rland.get(x) ?? { escapes: true }).escapes)) minor.push(x);
      if (nd.k === 'return') {
        for (const t of this.finWalk(fid, x).hit) if (!fin.has(t)) fin.set(t, nd.line); // the finally block runs before the function is left
        continue;
      }
      for (const [j, l] of r.S(x)) {
        let next = doors;
        if (D.finals) {
          const m = new Map(doors);
          const into = D.inside(j);
          let wrongDoor = false;
          for (const f of D.inside(x)) {
            if (into.has(f)) continue;
            const was = m.get(f); // a finally is left by the door it was entered by; a walk that started inside it has no door yet and may leave by any
            m.delete(f);
            if (was !== undefined && doorOf(l) !== was) wrongDoor = true;
          }
          if (wrongDoor) continue;
          if (nodes[j].k === 'final') m.set(j, entered(j, l));
          next = [...m].sort((a, b) => a[0] - b[0]);
        }
        stack.push([j, c || (l === 'catch' ? nd.line : null), next]);
      }
    }
    return [hit, minor, via, fin];
  }

  entryOf(fid) {
    const [hit] = this.frontier(fid, this.P.fns.get(fid).entry);
    this.entry.set(fid, hit.length ? hit[0] : this.first.get(fid));
  }

  road(a, b, typ, when, why, prov) {
    if (a === b && typ !== 'return') return;
    const k = `${a}->${b}:${when}`;
    let n = 1;
    let rid = k;
    while (this.roads.has(rid)) {
      n += 1;
      rid = `${k}#${n}`;
    }
    this.roads.set(rid, { id: rid, from: a, to: b, type: typ, when, why, prov });
    if (prov.rule === 'cfg-edge') {
      const key = tkey(a, b);
      if (!this.cfgpairs.has(key)) this.cfgpairs.set(key, []);
      this.cfgpairs.get(key).push(rid);
    }
  }

  makeRoads(fid) {
    const fn = this.P.fns.get(fid);
    const r = this.red.get(fid);
    const nodes = fn.nodes;
    const n2b = this.n2b(fid);
    const done = new Set();
    for (const i of [...n2b.keys()].sort((a, b) => a - b)) {
      const b = n2b.get(i);
      if (done.has(b)) continue;
      done.add(b);
      const bx = this.boxes.get(b);
      const rule = bx.prov.rule;
      if (rule === 'end') {
        this.finallyRoads(fid, b, bx);
        continue;
      }
      let starts = []; // [node, label text]
      if ((rule === 'step' || rule === 'try') && bx.prov.nodes?.length) {
        const comp = new Set(bx.prov.nodes);
        for (const c of [...comp].sort((a, b2) => a - b2)) for (const [j, l] of r.S(c)) if (!comp.has(j)) starts.push([j, '', l]);
      } else if (rule === 'decision') {
        if (r.chains.has(i)) {
          const [arms, els] = r.chainOf(i);
          starts = arms.filter(([, t]) => t !== null).map(([m, t]) => [t, short(nodes[m].test, 40), 'T']);
          if (els !== null) starts.push([els, 'else', 'F']);
        } else {
          const test = nodes[i].test ?? '';
          for (const [j, l] of r.S(i)) starts.push([j, l === 'T' ? short(test, 40) : l === 'F' ? 'not (' + short(test, 36) + ')' : l, l]);
        }
      } else if (rule === 'loop') {
        for (const [j, l] of r.S(i)) starts.push([j, l === 'T' ? 'each item' : 'loop over', l]);
      } else starts = r.S(i).map(([j, l]) => [j, '', l]);
      if (rule === 'decision' || rule === 'loop') bx.prov.arms = starts.length;
      for (const [st, lab, sl] of starts) {
        const [hit, minor, via, fin] = this.frontier(fid, st, sl);
        for (const [t, ln] of fin) { // an arm that returns through a finally block: the cleanup runs, and the road to it says so
          if (t === b || hit.includes(t)) continue;
          this.road(b, t, 'forward', (lab || 'then') + ', then the finally block', `${fid}:${ln} returns through the finally block`, { src: 'det', rule: 'cfg-edge', fn: fid, line: ln, tier: 'proven', basis: 'control-flow', via_finally: ln });
        }
        let drawn = 0;
        for (const t of hit) {
          if (t === b) continue;
          const typ = this.isBack(fid, i, t) ? 'return' : this.boxes.get(t).kind === 'store' ? 'record' : (this.boxes.get(t).prov.effects ?? []).includes('respond') ? 'deliver' : 'forward';
          const pv = { src: 'det', rule: 'cfg-edge', fn: fid, line: nodes[i].line, tier: 'proven', basis: 'control-flow' };
          if (via.get(t)) pv.via_raise = via.get(t); // this arm goes through a raise statement that a handler of this function takes
          this.road(b, t, typ, lab || 'then', `${fid}:${nodes[i].line} edge`, pv);
          drawn += 1;
        }
        if (!drawn && (rule === 'decision' || rule === 'loop')) {
          // the arm ends in something folded (or loops straight back): no box to draw a road to. Keep it as a folded exit, so a flow chart can draw a
          // small stub and a decision always shows both ways out
          if (minor.length) {
            const seenFe = new Set();
            for (const x of minor.slice(0, 4)) { // an arm can end in several places: each one is a way out
              const c = nodes[x].nr ? (nodes[x].nr === 'exit' ? 'X' : 'raise:*') : nodes[x].k !== 'exit' ? tclass(nodes[x]) : 'R0';
              const fe = { when: lab || 'then', line: nodes[x].line, class: c };
              if (nodes[x].rt) fe.rt = nodes[x].rt; // rethrow | unknown (a raise whose type is not known)
              else if (nodes[x].nr === 'raise') fe.rt = 'unknown'; // a call that never returns normally: the type it raises is not read
              const key = tkey(fe.line, c);
              if (!seenFe.has(key)) {
                seenFe.add(key);
                (bx.prov.folded_exits ??= []).push(fe);
              }
            }
          } else (bx.prov.folded_exits ??= []).push({ when: lab || 'then', line: nodes[st].line, class: hit.length ? 'loops-back' : 'continues' });
        }
      }
    }
  }

  /** An ending that leaves through a finally block gets a road to the first boxes in that block, and the lines of the blocks on the box. Without it a box
   *  that returns inside a try looks as if the cleanup never runs. */
  finallyRoads(fid, b, bx) {
    const nodes = this.P.fns.get(fid).nodes;
    const n2b = this.n2b(fid);
    const lines = new Set();
    const hits = new Map();
    for (const i of [...n2b.keys()].sort((x, y) => x - y)) {
      if (n2b.get(i) !== b || (nodes[i].k !== 'return' && nodes[i].k !== 'raise')) continue;
      const w = this.finWalk(fid, i);
      for (const l of w.lines) lines.add(l);
      for (const t of w.hit) if (!hits.has(t)) hits.set(t, nodes[i].line);
    }
    if (lines.size) bx.prov.runs_finally = sorted(lines);
    for (const [t, ln] of hits) {
      if (t === b) continue;
      this.road(b, t, 'forward', 'then the finally block', `${fid}:${ln} leaves through the finally block`, { src: 'det', rule: 'cfg-edge', fn: fid, line: ln, tier: 'proven', basis: 'control-flow', via_finally: ln });
    }
  }

  isBack(fid, i, t) {
    const a = this.boxes.get(this.n2b(fid).get(i));
    const b = this.boxes.get(t);
    return b.fn === fid && b.prov.line < (a ? a.prov.line : 0) && b.prov.rule === 'loop';
  }
}

Object.assign(MapBuilder.prototype, RoadMethods);
