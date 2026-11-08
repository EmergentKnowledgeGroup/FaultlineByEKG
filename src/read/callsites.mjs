// Call sites of a function, in source order, from two kinds of evidence, each labelled:
//   map   a call or link road the tool drew (with its tier: proven, may, linked)
//   scan  a call the scanner (facts) resolved on a line where the map drew no road
// Each site also records the function values passed to it (arrow functions, lambdas, names of functions) because the callee runs those.
import { cmp } from './util.mjs';
import { anonSpan } from './names.mjs';
import { functionExtent } from './structure.mjs';

const ARROW = /^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=>/;
const FUNC_EXPR = /^(?:async\s+)?function\b/;
const LAMBDA_PY = /^lambda\b/;
const REF = /^(?:(?:this|self|cls)\.)?[A-Za-z_$][\w$]*$/;

/** Library calls that register a function to run later, from outside the caller (events, timers, threads, routes). */
export const DELAYED = new Set([
  'addEventListener', 'on', 'once', 'addListener', 'subscribe', 'setInterval', 'setTimeout', 'setImmediate', 'requestAnimationFrame', 'Timer', 'Thread',
  'create_task', 'call_later', 'call_soon', 'add_done_callback', 'register', 'schedule', 'every', 'listen', 'use', 'get', 'post', 'put', 'delete', 'patch',
]);

/** How an argument looks: 'lambda' for an inline function, 'ref' for a bare name, else null. */
export function fnValueKind(masked) {
  const t = masked.trim().replace(/^[A-Za-z_]\w*\s*=(?!=)\s*/, '');
  if (ARROW.test(t) || FUNC_EXPR.test(t) || LAMBDA_PY.test(t)) return 'lambda';
  if (REF.test(t) && !/^(?:true|false|null|undefined|None|True|False|this|self|nil)$/.test(t)) return 'ref';
  return null;
}

/** Last name segment of a function id's qualified name, skipping anonymous markers: `a.b.run` gives `run`. */
export function tailName(fid) {
  const qual = fid.includes('::') ? fid.slice(fid.indexOf('::') + 2) : fid;
  const segs = qual.split('.');
  let t = segs[segs.length - 1].replace(/~\d+$/, '');
  if (t === 'constructor' && segs.length > 1) t = segs[segs.length - 2];
  if (t === '__init__' && segs.length > 1) t = segs[segs.length - 2];
  return t;
}

/** Parameter names of a function from its declaration line: ['fn', 'opts']. */
export function paramNames(source, path, line) {
  const sig = source.signature(path, line);
  if (!sig) return [];
  const f = source.file(path);
  const inner = f.text.slice(sig.open + 1, sig.close);
  const innerMask = f.mask.slice(sig.open + 1, sig.close);
  const parts = [];
  let d = 0;
  let s = 0;
  for (let i = 0; i < innerMask.length; i++) {
    const ch = innerMask[i];
    if ('([{<'.includes(ch)) d++;
    else if (')]}>'.includes(ch) && !(ch === '>' && innerMask[i - 1] === '=')) d--;
    else if (ch === ',' && d === 0) {
      parts.push(inner.slice(s, i));
      s = i + 1;
    }
  }
  parts.push(inner.slice(s));
  const names = [];
  for (const p of parts) {
    const m = /^\s*(?:(?:public|private|protected|readonly)\s+)*(?:\.\.\.|\*{1,2})?\s*([A-Za-z_$][\w$]*)/.exec(p);
    if (m && !/^(self|this|cls)$/.test(m[1])) names.push(m[1]);
  }
  return names;
}

export class CallModel {
  constructor(W, names) {
    this.W = W;
    this.names = names;
    this.units = new Map();
    this.factsFns = new Map();
    if (W.facts?.functions) {
      for (const fid of Object.keys(W.facts.functions)) this.factsFns.set(fid, W.facts.functions[fid]);
    }
    this.byTail = new Map();
    for (const fid of W.fnIds) {
      const t = tailName(fid);
      if (!this.byTail.has(t)) this.byTail.set(t, []);
      this.byTail.get(t).push(fid);
    }
  }

  /** Calls in a function that the tool could not resolve to project code: [{name, line}] (from the call table when given, else the scanner's list). */
  openCalls(fid) {
    if (this.W.calls) return this.W.openCalls.get(fid) ?? [];
    return (this.factsOf(fid)?.unresolved ?? []).map((name) => ({ name, line: 0 }));
  }

  /** The facts entry of a function (`<module>` and `<script>` are the same thing), or null. */
  factsOf(fid) {
    return this.factsFns.get(fid) ?? this.factsFns.get(fid.replace(/::<module>$/, '::<script>')) ?? null;
  }

  /** Line range a function covers: {from, to, known}. */
  region(fid) {
    const f = this.W.fns.get(fid);
    if (!f) return { from: 0, to: 0, known: false };
    if (f.end) return { from: f.line, to: f.end, known: true };
    const sp = this.W.spans.get(fid);          // the exact lines the readers saw, before any guess from the text
    if (sp) return { from: sp.from, to: sp.to, known: true };
    if (f.anon) {
      const sp = anonSpan(this.W.source, f.path, f.line);
      if (sp) return { from: sp.startLine, to: sp.endLine, known: true };
    }
    if (f.mapped && f.boxes.length && !f.anon) {
      // no extent from the scanner: read it from the source, from the signature above the first box to the end of the body
      if (!this._extents) this._extents = new Map();
      if (!this._extents.has(fid)) {
        const lines = f.boxes.flatMap((b) => [b.prov.line, ...(b.prov.sites ?? [])]);
        this._extents.set(fid, functionExtent(this.W.source, f.path, Math.min(...lines), Math.max(...lines), f.lang));
      }
      const ex = this._extents.get(fid);
      if (ex) return { from: ex.from, to: ex.to, known: true };
    }
    const last = f.boxes.length ? Math.max(...f.boxes.map((b) => Math.max(b.prov.line, ...(b.prov.sites ?? [0])))) : f.line;
    return { from: f.line, to: last, known: false };
  }

  /**
   * The unit of a function: its region and its call sites in source order.
   * A site is {line, off, callee, toBox, tier, rule, source, fromBox, name, fnArgs, lambda}.
   * `lambda` is the index of the function value (in unit.lambdas) the site sits inside, or -1 when the function makes the call itself.
   */
  unit(fid) {
    if (this.units.has(fid)) return this.units.get(fid);
    const u = { fid, sites: [], lambdas: [], region: null };
    this.units.set(fid, u);
    const W = this.W;
    const f = W.fns.get(fid);
    if (!f) return u;
    const region = this.region(fid);
    u.region = region;
    const sites = [];
    // map sites
    for (const b of f.boxes) {
      for (const r of W.crossOut(b.id)) {
        const g = W.fnOf(r.to);
        if (!g || g === fid) continue;
        const lines = r.prov.lines?.length ? r.prov.lines : [r.prov.line ?? b.prov.line];
        for (const ln of lines) {
          sites.push({ line: ln, callee: g, toBox: r.to, tier: r.prov.tier ?? 'proven', rule: r.prov.rule, kind: r.kind, source: 'map', fromBox: b.id, road: r.id, via: r.prov.via ?? null, lit: r.prov.lit ?? null });
        }
      }
    }
    // scan sites
    let owner = this.factsOf(fid);
    let ownerFid = fid;
    if (!owner) {
      for (let p = f.parent; p && !owner; p = W.fns.get(p)?.parent) {
        owner = this.factsOf(p);
        ownerFid = p;
      }
    }
    if (owner && region.to) {
      const mappedKids = f.children.map((c) => W.fns.get(c)).filter((c) => c.mapped && c.line);
      const have = new Set(sites.map((s) => `${s.line}|${tailName(s.callee)}`));
      for (const row of owner.callAt ?? []) {
        const [idx, ln] = row;
        const callee = owner.calls?.[idx];
        if (!callee || ln < region.from || ln > region.to) continue;
        if (have.has(`${ln}|${tailName(callee)}`)) continue;
        if (ownerFid !== fid || f.anon) {
          // inside a mapped child (or, for an anonymous function, the enclosing function's other code): belongs to that unit
          if (mappedKids.some((k) => {
            const kr = this.region(k.id);
            return kr.known && ln >= kr.from && ln <= kr.to;
          })) continue;
        } else if (mappedKids.some((k) => {
          const kr = this.region(k.id);
          return kr.known && ln >= kr.from && ln <= kr.to;
        })) continue;
        const g = this.W.fns.get(callee) ? callee : null;
        if (!g) continue;
        sites.push({ line: ln, callee: g, toBox: null, tier: 'scan', rule: 'scan', kind: 'call', source: 'scan', fromBox: null, via: null, lit: null });
      }
    }
    // the source call expressions of the whole region: their function-value arguments decide which sites run now and which run later
    const path = f.path;
    const allCalls = region.to ? W.source.calls(path, region.from, region.to) : [];
    const byLine = new Map();
    for (const c of allCalls) {
      if (!byLine.has(c.line)) byLine.set(c.line, []);
      byLine.get(c.line).push(c);
    }
    const used = new Map();
    for (const s of sites) {
      const t = s.kind === 'link' ? null : tailName(s.callee);
      if (!t) continue;
      const cands = (byLine.get(s.line) ?? []).filter((c) => c.name === t);
      const k = `${s.line}|${t}`;
      const n = used.get(k) ?? 0;
      used.set(k, n + 1);
      const c = cands[n] ?? cands[0];
      if (!c) continue;
      s.off = c.open;
      s.name = c.full;
      c.site = s;
    }
    sites.sort((a, b) => a.line - b.line || (a.off ?? 0) - (b.off ?? 0) || cmp(a.callee, b.callee) || cmp(a.source, b.source));
    const lambdas = [];
    for (const c of allCalls) {
      const args = W.source.args(path, c.open);
      const fnArgs = [];
      args.forEach((a, i) => {
        const kind = fnValueKind(a.masked);
        if (kind) fnArgs.push({ index: i, kind, start: a.start, end: a.end, startLine: a.startLine, endLine: a.endLine, text: a.text, kw: /^([A-Za-z_]\w*)\s*=(?!=)/.exec(a.masked)?.[1] ?? null });
      });
      if (c.site) c.site.fnArgs = fnArgs;
      for (const arg of fnArgs) {
        if (arg.kind !== 'lambda') continue;
        lambdas.push({ call: c, site: c.site ?? null, name: c.name, arg, index: lambdas.length, delayed: !c.site && DELAYED.has(c.name) });
      }
    }
    const inside = (off, L) => off > L.arg.start && off < L.arg.end;
    for (const L of lambdas) {
      L.parent = -1;
      let best = null;
      for (const M of lambdas) if (M !== L && inside(L.call.open, M) && (!best || M.arg.end - M.arg.start < best.arg.end - best.arg.start)) best = M;
      if (best) L.parent = best.index;
      // a function value handed to a library call that runs it on the spot (forEach, then, an executor) is part of the caller's own run
      L.inline = !L.site && !L.delayed;
    }
    for (const s of sites) {
      s.lambda = -1;
      if (s.off === undefined) continue;
      let best = null;
      for (const L of lambdas) if (L.site !== s && inside(s.off, L) && (!best || L.arg.end - L.arg.start < best.arg.end - best.arg.start)) best = L;
      while (best && best.inline) best = best.parent >= 0 ? lambdas[best.parent] : null;
      if (best) s.lambda = best.index;
    }
    // calls to registering library functions (events, timers, threads, routes) that hand over a function to run later
    u.externals = [];
    for (const call of allCalls) {
      if (call.site || !DELAYED.has(call.name)) continue;
      const args = W.source.args(path, call.open).map((x, i) => ({ index: i, kind: fnValueKind(x.masked), text: x.text, startLine: x.startLine, endLine: x.endLine, start: x.start, end: x.end }));
      if (!args.some((x) => x.kind)) continue;
      u.externals.push({ name: call.name, recv: call.recv, line: call.line, off: call.open, args, recvText: W.source.receiverText(path, call.nameOff) });
    }
    u.sites = sites;
    u.lambdas = lambdas;
    return u;
  }

  /** The mapped function that is the function value `arg` (an anonymous function starting on the same line), or null. */
  mappedLambda(fid, arg) {
    const f = this.W.fns.get(fid);
    if (!f) return null;
    for (const c of f.children) {
      const k = this.W.fns.get(c);
      if (k.mapped && k.anon && k.line >= arg.startLine && k.line <= arg.startLine + 1) return c;
    }
    return null;
  }

  /** Resolve a bare function name used as a value (`this.run`, `handler`) to a function id from the place it is written in. */
  resolveRef(fid, text) {
    const W = this.W;
    const f = W.fns.get(fid);
    if (!f) return null;
    const t = text.trim().replace(/^[A-Za-z_]\w*\s*=(?!=)\s*/, '');
    const m = /^(this|self|cls)\.([A-Za-z_$][\w$]*)$/.exec(t);
    const name = m ? m[2] : t;
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
    const segs = f.qual.split('.').filter((s) => !/^<anon@/.test(s));
    if (m) {
      for (let k = segs.length - 1; k >= 1; k--) {
        const cand = `${f.path}::${segs.slice(0, k).join('.')}.${name}`;
        if (W.fns.has(cand)) return cand;
      }
      return null;
    }
    for (let k = segs.length; k >= 0; k--) {
      const cand = `${f.path}::${[...segs.slice(0, k), name].join('.')}`;
      if (W.fns.has(cand)) return cand;
    }
    const same = (this.byTail.get(name) ?? []).filter((id) => W.fns.get(id).path === f.path);
    return same.length === 1 ? same[0] : null;
  }
}
