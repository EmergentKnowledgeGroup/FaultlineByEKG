// Shared helpers for the evidence code: hashing, paths, JSON lines, line ranges.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Forward slashes, no leading ./ , no trailing slash. */
export function normSlashes(p) {
  let s = String(p ?? '').replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/**
 * Turn any path a tool printed (absolute, relative to another cwd, Windows or posix) into the repo-relative form
 * facts use. Order: strip a given prefix, strip facts.root, exact module match, then a unique longest-suffix match.
 * Returns null when nothing matches; never guesses between two equally good suffix matches.
 */
export function makePathResolver(facts, opts = {}) {
  const mods = new Set();
  for (const m of facts?.modules || []) mods.add(normSlashes(m.path));
  for (const f of Object.values(facts?.functions || {})) mods.add(normSlashes(f.path));
  const list = [...mods];
  const root = normSlashes(facts?.root || '').replace(/\/+$/, '');
  const strips = (opts.stripPrefix ? [].concat(opts.stripPrefix) : []).map((s) => normSlashes(s).replace(/\/+$/, ''));
  const lower = (s) => (/^[a-z]:\//i.test(s) ? s.toLowerCase() : s);
  const cache = new Map();
  return function resolve(p) {
    if (cache.has(p)) return cache.get(p);
    let s = normSlashes(p);
    for (const pre of strips) if (pre && lower(s).startsWith(lower(pre) + '/')) s = s.slice(pre.length + 1);
    if (root && lower(s).startsWith(lower(root) + '/')) s = s.slice(root.length + 1);
    let out = null;
    if (mods.has(s)) out = s;
    else {
      const parts = s.split('/').filter((x) => x && !/^[a-z]:$/i.test(x));
      for (let i = 0; i < parts.length && !out; i++) {
        const suffix = parts.slice(i).join('/');
        const hits = list.filter((m) => m === suffix || m.endsWith('/' + suffix));
        if (hits.length === 1) out = hits[0];
        else if (hits.length > 1) break; // ambiguous at this length: shorter suffixes are worse
      }
    }
    cache.set(p, out);
    return out;
  };
}

/** "file:line" or "file:line:col" -> {file,line}; Windows drive letters survive. */
export function parseRef(ref) {
  if (typeof ref !== 'string') return null;
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(ref.trim());
  if (!m) return null;
  return { file: normSlashes(m[1]), line: Number(m[2]) };
}

/** Sorted unique ints -> [[a,b],...] with adjacent runs merged. */
export function toRanges(nums) {
  const a = [...new Set(nums)].sort((x, y) => x - y);
  const out = [];
  for (const n of a) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

export const inRanges = (ranges, n) => {
  if (!ranges) return false;
  for (const [a, b] of ranges) if (n >= a && n <= b) return true;
  return false;
};

export const rangesOverlap = (ranges, lo, hi) => {
  if (!ranges) return false;
  for (const [a, b] of ranges) if (a <= hi && b >= lo) return true;
  return false;
};

/** Canonical JSON: keys sorted, so equal values hash equal. */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

export function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push(JSON.parse(line)); } catch (e) { errors.push({ line: i + 1, msg: e.message }); }
  });
  return { rows, errors };
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

export function sortedKeys(o) { return Object.keys(o).sort(); }

/** Refusal in the same shape the gates use. */
export class Refusal extends Error {
  constructor(code, what, offender, fix) {
    super(`REFUSE ${code} ${what}: ${offender}. Fix: ${fix}.`);
    this.refusal = { code, msg: this.message, at: offender };
  }
}
