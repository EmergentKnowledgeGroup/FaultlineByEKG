// The world: the tool's map (boxes, roads), its claim register, and optional extra facts, indexed once so every rule reads the same thing.
import { cmp, sortBy, langOf } from './util.mjs';

/** Road kinds the readers use. A road inside one function is `cfg` (or `exc` for an error road); a road between functions is `call` or `link`, or `callback` when it hands a function over. */
export function roadKind(r) {
  const rule = r.prov?.rule;
  if (rule === 'exc-edge') return 'exc';
  // A function handed to a call gets a road from the box holding the call to the box of that function. The owner does not call it, the callee runs it,
  // and the walk finds that out from the call's own arguments; as a plain call road it would put the owner at the head of every callback it hands over.
  if (rule === 'call' && r.prov.how === 'callback') return 'callback';
  if (rule === 'call') return 'call';
  if (rule === 'link') return 'link';
  return 'cfg';
}

export function anonLine(qual) {
  const m = /<anon@(\d+)>/.exec(qual.split('.').pop() ?? '');
  return m ? Number(m[1]) : 0;
}

export function splitFid(fid) {
  const i = fid.indexOf('::');
  return i < 0 ? { path: '', qual: fid } : { path: fid.slice(0, i), qual: fid.slice(i + 2) };
}

/**
 * @param {{model:object, claims?:object[], facts?:object|null, signals?:object|null, source:import('./source.mjs').Source}} input
 */
export function buildWorld({ model, claims = [], facts = null, signals = null, calls = null, spans = null, source }) {
  const W = { model, claims, facts, signals, source, calls };
  // the exact start and end line of each function the map's readers saw (the code index: {fid: {l, e}}); used before any guess from the text
  W.spans = new Map();
  for (const fid of Object.keys(spans ?? {}).sort(cmp)) if (spans[fid].l && spans[fid].e) W.spans.set(fid, { from: spans[fid].l, to: spans[fid].e });
  // the tool's call table: rows [fid, node, op, {f, line, how, rs, ...}]; a call it could not resolve to project code is an open end
  W.openCalls = new Map();
  for (const row of calls ?? []) {
    const o = row[3] ?? {};
    if (o.how !== 'unresolved' || o.rs === 'ext') continue;
    if (!W.openCalls.has(row[0])) W.openCalls.set(row[0], []);
    W.openCalls.get(row[0]).push({ name: o.f ?? '', line: o.line ?? 0 });
  }
  W.boxes = new Map();
  for (const b of model.boxes) W.boxes.set(b.id, b);

  // ---- functions ------------------------------------------------------------------------------------------------
  const fns = new Map();
  for (const b of model.boxes) {
    const fid = b.prov.fn;
    let f = fns.get(fid);
    if (!f) {
      const { path, qual } = splitFid(fid);
      f = { id: fid, path, qual, lang: langOf(path), boxes: [], mapped: true, anon: /<anon@\d+>/.test(qual.split('.').pop() ?? ''), parent: null, children: [] };
      fns.set(fid, f);
    }
    f.boxes.push(b);
  }
  if (facts?.functions) {
    for (const fid of Object.keys(facts.functions).sort(cmp)) {
      const ff = facts.functions[fid];
      let f = fns.get(fid);
      if (!f) {
        f = { id: fid, path: ff.path ?? splitFid(fid).path, qual: ff.qual ?? splitFid(fid).qual, lang: langOf(ff.path ?? fid), boxes: [], mapped: false, anon: false, parent: null, children: [] };
        fns.set(fid, f);
      }
      f.line = ff.line;
      f.end = ff.end;
      f.doc = ff.doc ?? '';
      f.async = !!ff.async;
      f.decorators = ff.decorators ?? [];
      f.fact = ff;
    }
  }
  for (const f of fns.values()) {
    f.boxes = sortBy(f.boxes, (b) => b.prov.line, (b) => b.id);
    if (f.line === undefined) f.line = f.anon ? anonLine(f.qual) || f.boxes[0]?.prov.line || 0 : f.boxes[0]?.prov.line ?? 0;
    f.mappedBoxes = f.boxes.length;
  }
  // parents: the nearest enclosing function that exists
  for (const f of fns.values()) {
    const segs = f.qual.split('.');
    for (let k = segs.length - 1; k >= 1; k--) {
      const pid = `${f.path}::${segs.slice(0, k).join('.')}`;
      if (fns.has(pid)) {
        f.parent = pid;
        fns.get(pid).children.push(f.id);
        break;
      }
    }
  }
  for (const f of fns.values()) f.children.sort(cmp);
  W.fns = fns;
  W.fnIds = [...fns.keys()].sort(cmp);
  W.mappedIds = W.fnIds.filter((id) => fns.get(id).mapped);

  // ---- roads ------------------------------------------------------------------------------------------------------
  W.out = new Map();
  W.inn = new Map();
  for (const b of model.boxes) {
    W.out.set(b.id, []);
    W.inn.set(b.id, []);
  }
  for (const r of model.routes) {
    if (!W.out.has(r.from) || !W.inn.has(r.to)) continue;
    r.kind = roadKind(r);
    W.out.get(r.from).push(r);
    W.inn.get(r.to).push(r);
  }
  W.fnOf = (boxId) => W.boxes.get(boxId)?.prov.fn;
  W.cfgOut = (boxId) => (W.out.get(boxId) ?? []).filter((r) => r.kind === 'cfg' && r.type !== 'return');
  W.excOut = (boxId) => (W.out.get(boxId) ?? []).filter((r) => r.kind === 'exc');
  W.crossOut = (boxId) => (W.out.get(boxId) ?? []).filter((r) => r.kind === 'call' || r.kind === 'link');

  // callers / callees between functions
  W.callersOf = new Map();
  W.calleesOf = new Map();
  for (const r of model.routes) {
    if (r.kind !== 'call' && r.kind !== 'link') continue;
    const a = W.fnOf(r.from);
    const b = W.fnOf(r.to);
    if (!a || !b || a === b) continue;
    if (!W.calleesOf.has(a)) W.calleesOf.set(a, []);
    if (!W.callersOf.has(b)) W.callersOf.set(b, []);
    W.calleesOf.get(a).push(r);
    W.callersOf.get(b).push(r);
  }
  for (const fid of W.fnIds) {
    if (!W.calleesOf.has(fid)) W.calleesOf.set(fid, []);
    if (!W.callersOf.has(fid)) W.callersOf.set(fid, []);
  }

  // ---- entry boxes ------------------------------------------------------------------------------------------------
  W.entryBox = (fid) => {
    const f = fns.get(fid);
    if (!f || !f.boxes.length) return null;
    if (f._entry !== undefined) return f._entry;
    const tally = new Map();
    for (const r of W.callersOf.get(fid) ?? []) {
      if (W.fnOf(r.from) !== fid) tally.set(r.to, (tally.get(r.to) ?? 0) + 1);
    }
    let best = null;
    if (tally.size) {
      best = [...tally.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0][0];
    } else {
      const inFn = new Set();
      for (const b of f.boxes) for (const r of W.out.get(b.id)) if (r.type !== 'return' && W.fnOf(r.to) === fid) inFn.add(r.to);
      const roots = f.boxes.filter((b) => !inFn.has(b.id) && b.prov.rule !== 'handler');
      best = (roots[0] ?? f.boxes[0]).id;
    }
    f._entry = best;
    return best;
  };

  // ---- claims -----------------------------------------------------------------------------------------------------
  W.claimsBySubject = new Map();
  W.claimsByType = new Map();
  for (const c of claims) {
    if (!W.claimsBySubject.has(c.subject)) W.claimsBySubject.set(c.subject, []);
    W.claimsBySubject.get(c.subject).push(c);
    if (!W.claimsByType.has(c.type)) W.claimsByType.set(c.type, []);
    W.claimsByType.get(c.type).push(c);
  }
  W.claimsOf = (boxId, type) => (W.claimsBySubject.get(boxId) ?? []).filter((c) => !type || c.type === type);
  W.claimsOfType = (type) => W.claimsByType.get(type) ?? [];
  return W;
}

/** Boxes of a function in reading order. */
export function boxesOf(W, fid) {
  return W.fns.get(fid)?.boxes ?? [];
}
