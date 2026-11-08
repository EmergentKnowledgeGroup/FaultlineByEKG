// Coverage -> walk file. A box lights only if a cited function's BODY ran: the def line runs at import, so it never counts.
// Coverage has no order, so the outcome is marked unordered and the importer skips missing-route detection for it.
import fs from 'node:fs';
import path from 'node:path';
import { makePathResolver, toRanges, normSlashes } from './util.mjs';
import { parseCoverage } from './coverage_formats.mjs';
import { writeWalkFile } from './walk.mjs';

/** Body lines of a function: everything after the def line (a one-line function has no separable body). */
const bodyOf = (f) => (f.end > f.line ? [f.line + 1, f.end] : [f.line, f.line]);

function mergeCov(a, b) {
  for (const n of b.executed) a.executed.add(n);
  for (const n of b.missing) a.missing.add(n);
  a.fns.push(...b.fns); a.missedBranches.push(...b.missedBranches);
  for (const n of a.executed) a.missing.delete(n);
  return a;
}

/** Hit count for one function from FN/FNDA or fnMap data, matched by declaration line, then by name. Null when unknown. */
function fnHits(cov, f) {
  const tail = String(f.qual).split('.').pop();
  let hit = cov.fns.find((x) => x.start != null && Math.abs(x.start - f.line) <= 1 && (x.name === tail || x.name === f.qual || x.name.endsWith('.' + tail)));
  if (!hit) hit = cov.fns.find((x) => x.start === f.line);
  return hit ? hit.hits : null;
}

/**
 * Build a walk from coverage text (or an already parsed result). facts is required: it says where each function's body is.
 * opts: {format, model, tool, kind, stripPrefix, pin, onlyCited}
 */
export function coverageToWalk(input, facts, opts = {}) {
  const parsed = typeof input === 'string' ? parseCoverage(input, opts.format || 'auto') : input;
  const resolve = makePathResolver(facts, { stripPrefix: opts.stripPrefix });
  const byPath = new Map();
  const unmatchedFiles = [];
  for (const [printed, cov] of parsed.files) {
    const p = resolve(printed);
    if (!p) { unmatchedFiles.push(normSlashes(printed)); continue; }
    byPath.set(p, byPath.has(p) ? mergeCov(byPath.get(p), cov) : cov);
  }
  const cited = opts.model && opts.onlyCited !== false
    ? new Set((opts.model.boxes || []).flatMap((b) => (b.refs || []).map((r) => r.symbol).filter(Boolean))) : null;
  const steps = [];
  const unexplored = [];
  const explored = [];
  const hashes = {};
  const notes = [];
  let seen = 0;
  const ids = Object.keys(facts.functions || {}).sort();
  for (const id of ids) {
    const f = facts.functions[id];
    const cov = byPath.get(normSlashes(f.path));
    if (!cov || (cited && !cited.has(id))) continue;
    seen++;
    const [lo, hi] = bodyOf(f);
    const exec = [], miss = [];
    for (let n = lo; n <= hi; n++) { if (cov.executed.has(n)) exec.push(n); else if (cov.missing.has(n)) miss.push(n); }
    const oneLine = f.end <= f.line;
    const hits = fnHits(cov, f);
    // One-line functions: the def line and the body are the same line, so only function counters can tell.
    const ran = oneLine ? (hits != null && hits > 0) : (exec.length > 0 || (hits != null && hits > 0));
    if (oneLine && hits == null && exec.length) notes.push(`${id}: one-line function, no function counter: not counted as run`);
    if (f.sha256) hashes[id] = f.sha256;
    if (!ran) { unexplored.push({ at: id, why: 'body did not run' }); continue; }
    explored.push(id);
    const step = { ref: `${normSlashes(f.path)}:${exec.length ? exec[0] : lo}`, sym: id };
    if (exec.length || miss.length) { step.ranges = toRanges(exec); if (miss.length) step.missed = toRanges(miss); }
    if (hits != null && hits > 0 && parsed.fmt !== 'coverage-py') step.hits = hits;
    const mb = cov.missedBranches.filter((b) => b[0] >= lo && b[0] <= hi);
    if (mb.length) step.missedBranches = mb;
    steps.push(step);
  }
  const tool = opts.tool || parsed.tool;
  const pin = opts.pin ?? facts.pin?.tree ?? facts.pin?.git ?? null;
  const ranCount = steps.length;
  const walk = {
    header: { tool, kind: opts.kind || 'test', pin, importedAgainst: { git: facts.pin?.git ?? null, tree: facts.pin?.tree ?? null },
      format: parsed.fmt, hashes },
    label: { label: ranCount ? 'SAMPLED' : 'NONE', controls_passed: false, explored, unexplored },
    outcomes: ranCount ? [{ outcome: 'unknown', strength: 'observed', unordered: true,
      reason: `${ranCount} of ${seen} functions had a body line run`, witness: null, count: 1, steps }] : [],
  };
  return { walk, stats: { format: parsed.fmt, tool, files: parsed.files.size, matchedFiles: byPath.size, unmatchedFiles: unmatchedFiles.sort(),
    functionsSeen: seen, ran: ranCount, notRun: unexplored.length, notes } };
}

/** Read a coverage file, write projectDir/walks/<name>.walk.jsonl, and say what happened. */
export function importCoverageFile(file, facts, opts = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const { walk, stats } = coverageToWalk(text, facts, opts);
  const out = opts.out || path.join(opts.projectDir || '.', 'walks', `${/^coverage/i.test(path.basename(file)) ? '' : 'coverage-'}${path.basename(file).replace(/\.[^.]+$/, '')}.walk.jsonl`);
  writeWalkFile(out, walk);
  return { out, ...stats };
}

/**
 * Which boxes never ran, from the overlay the importer produced. Plain text, small, for people and for the toy report.
 */
export function neverRan(overlay, model) {
  const rows = [];
  for (const b of model.boxes || []) {
    const o = overlay.boxes[b.id];
    if (o?.untested) rows.push({ box: b.id, kind: b.kind, why: o.reasons[0] || 'nothing ran for it' });
  }
  return rows;
}
