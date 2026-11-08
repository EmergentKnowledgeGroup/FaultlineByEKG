// Parsers for the three coverage formats. Each returns a Map: file path as printed -> FileCov
//   FileCov = {executed:Set<line>, missing:Set<line>, fns:[{name,start,hits}], missedBranches:[[from,to]]}
// Line numbers are 1-based. No path resolution here; see coverage.mjs.

const newCov = () => ({ executed: new Set(), missing: new Set(), fns: [], missedBranches: [] });

/** coverage.py JSON (format 2 and 3): files{path:{executed_lines,missing_lines,missing_branches,functions}}. */
export function parseCoveragePy(json) {
  const out = new Map();
  for (const [file, f] of Object.entries(json.files || {})) {
    const c = newCov();
    for (const n of f.executed_lines || []) c.executed.add(n);
    for (const n of f.missing_lines || []) c.missing.add(n);
    for (const b of f.missing_branches || []) if (Array.isArray(b) && b.length === 2) c.missedBranches.push(b);
    // The per-function block lists the def line as executed (it runs at import), so it cannot say whether a body ran.
    out.set(file, c);
  }
  return { files: out, tool: `coverage.py@${json.meta?.version || '?'}`, branch: !!json.meta?.branch_coverage };
}

/** lcov tracefile: SF, FN (start,name or start,end,name), FNDA, DA, BRDA, end_of_record. */
export function parseLcov(text) {
  const out = new Map();
  let cur = null, name = null;
  const fnIdx = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(':');
    const key = i < 0 ? line : line.slice(0, i);
    const val = i < 0 ? '' : line.slice(i + 1);
    if (key === 'SF') { name = val; cur = out.get(name) || newCov(); out.set(name, cur); fnIdx.clear(); }
    else if (!cur) continue;
    else if (key === 'FN') {
      const p = val.split(',');
      const start = Number(p[0]);
      const fname = p.length >= 3 ? p.slice(2).join(',') : p.slice(1).join(',');
      const fn = { name: fname, start, hits: 0 };
      cur.fns.push(fn); fnIdx.set(fname, fn);
    } else if (key === 'FNDA') {
      const j = val.indexOf(',');
      const hits = Number(val.slice(0, j));
      const fn = fnIdx.get(val.slice(j + 1));
      if (fn) fn.hits = hits;
    } else if (key === 'DA') {
      const p = val.split(',');
      const ln = Number(p[0]), n = Number(p[1]);
      if (Number.isFinite(ln)) (n > 0 ? cur.executed : cur.missing).add(ln);
    } else if (key === 'BRDA') {
      const p = val.split(',');
      if (p[3] === '-' || Number(p[3]) === 0) cur.missedBranches.push([Number(p[0]), null]);
    } else if (key === 'end_of_record') { cur = null; }
  }
  for (const c of out.values()) for (const n of c.executed) c.missing.delete(n); // a line hit in any block ran
  return { files: out, tool: 'lcov', branch: [...out.values()].some((c) => c.missedBranches.length) };
}

/** istanbul coverage-final.json: {absPath:{statementMap,s,fnMap,f,branchMap,b}}. A statement counts on its start line. */
export function parseIstanbul(json) {
  const out = new Map();
  for (const [key, f] of Object.entries(json)) {
    if (!f || typeof f !== 'object' || !f.statementMap) continue;
    const file = f.path || key;
    const c = newCov();
    for (const [id, loc] of Object.entries(f.statementMap)) {
      const ln = loc?.start?.line;
      if (!Number.isInteger(ln)) continue;
      ((f.s?.[id] || 0) > 0 ? c.executed : c.missing).add(ln);
    }
    for (const n of c.executed) c.missing.delete(n);
    for (const [id, fn] of Object.entries(f.fnMap || {})) {
      c.fns.push({ name: fn.name, start: fn.decl?.start?.line ?? fn.loc?.start?.line ?? fn.line ?? null, hits: f.f?.[id] || 0 });
    }
    for (const [id, br] of Object.entries(f.branchMap || {})) {
      (f.b?.[id] || []).forEach((n, k) => { if (n === 0) c.missedBranches.push([br.loc?.start?.line ?? br.line, k]); });
    }
    out.set(file, c);
  }
  return { files: out, tool: 'istanbul', branch: [...out.values()].some((c) => c.missedBranches.length) };
}

/** Look at the bytes and say which format this is. */
export function detectFormat(text) {
  const t = text.replace(/^﻿/, '').trimStart();
  if (/^(TN:|SF:)/m.test(t.slice(0, 2000)) && !t.startsWith('{')) return 'lcov';
  if (t.startsWith('{')) {
    let j;
    try { j = JSON.parse(t); } catch { return null; }
    if (j && j.files && typeof j.files === 'object' && (j.meta || Object.values(j.files)[0]?.executed_lines)) return 'coverage-py';
    const first = j && Object.values(j)[0];
    if (first && typeof first === 'object' && first.statementMap) return 'istanbul';
  }
  return null;
}

export function parseCoverage(text, format = 'auto') {
  const fmt = format === 'auto' ? detectFormat(text) : format;
  if (fmt === 'lcov') return { fmt, ...parseLcov(text) };
  if (fmt === 'coverage-py') return { fmt, ...parseCoveragePy(JSON.parse(text.replace(/^﻿/, ''))) };
  if (fmt === 'istanbul') return { fmt, ...parseIstanbul(JSON.parse(text.replace(/^﻿/, ''))) };
  throw new Error(`cannot tell the coverage format (use format: coverage-py | lcov | istanbul)${format !== 'auto' ? `; got ${format}` : ''}`);
}
