// Facts and ref helpers shared by the gates, analyze and propose.

export const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
export const symbolPath = (sym) => normPath(String(sym ?? '').split('::')[0]);

export function indexFacts(facts) {
  const functions = facts?.functions || {};
  const modules = new Map((facts?.modules || []).map((m) => [normPath(m.path), m]));
  const enums = new Map();
  for (const e of facts?.enums || []) enums.set(`${normPath(e.path)}::${e.name}`, { path: normPath(e.path), line: e.line, end: (e.line || 0) + (e.values?.length || 0) + 1, name: e.name, enumValues: e.values || [] });
  const byPath = new Map();                                            // path -> [fn ids]
  for (const id of Object.keys(functions)) {
    const p = normPath(functions[id].path ?? symbolPath(id));
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push(id);
  }
  const entries = new Map((facts?.entries || []).map((e) => [e.fn, e]));
  return { functions, modules, enums, byPath, entries, has: !!facts };
}

export function lookupSymbol(fx, sym) {
  const s = normPath(sym);
  return fx.functions[s] || fx.enums.get(s) || null;
}

// Every ref in the model with where it lives: [{owner:'box'|'route'|'term', id, ref}]
export function allRefs(model) {
  const out = [];
  for (const b of model.boxes || []) for (const ref of Array.isArray(b.refs) ? b.refs : []) out.push({ owner: 'box', id: b.id, ref });
  for (const r of model.routes || []) for (const ref of Array.isArray(r.refs) ? r.refs : []) out.push({ owner: 'route', id: r.id, ref });
  for (const t of model.terms || []) for (const ref of Array.isArray(t.refs) ? t.refs : []) out.push({ owner: 'term', id: t.term, ref });
  return out;
}

export function refSymbol(ref) { return normPath(ref?.symbol || ''); }
export function refModule(ref) { return normPath(ref?.path || symbolPath(ref?.symbol)); }

// Small edit distance for "did you mean" hints. Bounded: gives up above `max`.
export function editDistance(a, b, max = 6) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

export function nearestSymbol(fx, sym) {
  const s = normPath(sym), p = symbolPath(s), q = s.includes('::') ? s.split('::').slice(1).join('::') : s;
  const pool = fx.byPath.get(p) || [];
  let best = null, bd = 7;
  for (const id of pool) {
    const d = editDistance(q, id.split('::').slice(1).join('::'), 6);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}

// Which function body contains (path, line)? Innermost (smallest span) wins.
export function functionAt(fx, p, line) {
  let best = null, span = Infinity;
  for (const id of fx.byPath.get(normPath(p)) || []) {
    const f = fx.functions[id];
    if (line >= f.line && line <= (f.end ?? f.line) && (f.end ?? f.line) - f.line < span) { best = id; span = (f.end ?? f.line) - f.line; }
  }
  return best;
}

// Boxes that cite a function, with the cited line each: fn -> [{box, line}]
export function citeIndex(model) {
  const idx = new Map();
  for (const b of model.boxes || []) for (const ref of Array.isArray(b.refs) ? b.refs : []) {
    const s = refSymbol(ref); if (!s) continue;
    if (!idx.has(s)) idx.set(s, []);
    idx.get(s).push({ box: b.id, line: Number(ref.line) || 0 });
  }
  return idx;
}

// Pick the box whose cited line is nearest `line`, among boxes citing `fn`. `prefer` is an optional predicate/score.
export function nearestBox(cites, fn, line, score = null) {
  const list = cites.get(fn) || [];
  let best = null, bs = Infinity;
  for (const c of list) {
    const d = (c.line ? Math.abs(c.line - line) : 1e6 - 1) - (score ? score(c.box) * 10000 : 0);
    if (d < bs) { bs = d; best = c; }
  }
  return best;
}
