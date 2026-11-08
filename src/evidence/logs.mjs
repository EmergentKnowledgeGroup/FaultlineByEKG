// Logs and traces -> walk file. Two inputs: JSON-lines logs with a configurable field map, and OpenTelemetry-style spans.
// Matching is by function name (never guessed: an ambiguous name stays unmapped) or by tag (a box id or alias).
import fs from 'node:fs';
import path from 'node:path';
import { sha256, canonical } from './util.mjs';
import { buildIndex, fnByName } from './map.mjs';
import { writeWalkFile } from './walk.mjs';
import { makeScrub, scrubText } from './scrub.mjs';

const OUTCOME_RE = /^(?:end|stuck):.+$|^(?:error|unknown)$/;
export const DEFAULT_FIELDS = { fn: 'function', file: 'file', line: 'line', tag: 'tag', time: 'ts', run: 'trace_id', level: 'level', msg: 'message' };

/** a.b.c lookup; a literal key with dots wins over a nested path. */
export function getPath(obj, p) {
  if (!obj || !p) return undefined;
  if (p in obj) return obj[p];
  let cur = obj;
  for (const k of String(p).split('.')) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[k]; }
  return cur;
}

const toMs = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e17 ? v / 1e6 : v > 1e14 ? v / 1e3 : v > 1e11 ? v : v * 1000;
  if (/^\d+$/.test(String(v))) return toMs(Number(v));
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/** Read JSON lines: returns {records, bad}. Non-JSON lines are counted, not fatal. */
export function recordsFromJsonl(text, cfg = {}) {
  const f = { ...DEFAULT_FIELDS, ...(cfg.fields || {}) };
  const errLevels = new Set((cfg.errorLevels || ['error', 'fatal', 'critical', 'exception']).map((x) => String(x).toLowerCase()));
  const records = [];
  let bad = 0;
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch { bad++; return; }
    if (!o || typeof o !== 'object') { bad++; return; }
    const lvl = getPath(o, f.level);
    const ln = getPath(o, f.line);
    records.push({
      order: i, raw: o, run: getPath(o, f.run) ?? null, time: toMs(getPath(o, f.time)),
      fn: getPath(o, f.fn) ?? null, file: getPath(o, f.file) ?? null, line: Number.isInteger(+ln) && ln !== '' && ln != null ? +ln : null,
      tag: getPath(o, f.tag) ?? null, msg: String(getPath(o, f.msg) ?? ''), error: lvl != null && errLevels.has(String(lvl).toLowerCase()),
    });
  });
  return { records, bad };
}

const OT_VALUE = (v) => {
  if (v == null || typeof v !== 'object') return v;
  for (const k of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) if (k in v) return k === 'intValue' ? Number(v[k]) : v[k];
  return undefined;
};
const otAttrs = (a) => {
  if (Array.isArray(a)) { const o = {}; for (const kv of a) o[kv.key] = OT_VALUE(kv.value); return o; }
  return a && typeof a === 'object' ? { ...a } : {};
};

/** Accept OTLP/JSON ({resourceSpans}), a bare span list, or JSON lines of either. */
export function spansFrom(text) {
  const spans = [];
  const take = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(take);
    if (x.resourceSpans) return take(x.resourceSpans);
    if (x.scopeSpans || x.instrumentationLibrarySpans) return take(x.scopeSpans || x.instrumentationLibrarySpans);
    if (x.spans) return take(x.spans);
    if (x.name !== undefined && (x.traceId || x.context || x.trace_id)) spans.push(x);
  };
  const t = text.replace(/^﻿/, '').trim();
  try { take(JSON.parse(t)); } catch { for (const line of t.split(/\r?\n/)) { try { take(JSON.parse(line)); } catch { /* skip */ } } }
  return spans;
}

export function recordsFromSpans(text, cfg = {}) {
  const spans = spansFrom(text);
  const depth = new Map();
  const byId = new Map();
  spans.forEach((s) => { byId.set(s.spanId || s.context?.span_id, s); });
  const depthOf = (s) => {
    const id = s.spanId || s.context?.span_id;
    if (depth.has(id)) return depth.get(id);
    const pid = s.parentSpanId || s.parent_id || s.parentId;
    const d = pid && byId.has(pid) ? depthOf(byId.get(pid)) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  const records = spans.map((s, i) => {
    const a = otAttrs(s.attributes);
    const code = a['code.function'] ?? a['code.function.name'] ?? null;
    const ns = a['code.namespace'] ?? null;
    const file = a['code.filepath'] ?? a['code.file.path'] ?? null;
    const line = a['code.lineno'] ?? a['code.line.number'] ?? null;
    const code_ = s.status?.code ?? s.status?.status_code;
    const err = code_ === 2 || String(code_).toUpperCase().includes('ERROR');
    const msg = s.status?.message || s.status?.description || (s.events || []).map((e) => otAttrs(e.attributes)['exception.message']).find(Boolean) || '';
    return {
      order: i, raw: { name: s.name, ...a, 'status.error': err, status: code_ }, run: s.traceId || s.context?.trace_id || null,
      time: toMs(s.startTimeUnixNano ?? s.start_time ?? s.startTime), depth: depthOf(s),
      fn: code, ns, file, line: Number.isInteger(+line) && line != null && line !== '' ? +line : null,
      tag: a['faultline.tag'] ?? a['faultline.box'] ?? null, name: s.name, msg: String(msg || s.name || ''), error: err,
    };
  });
  return { records, bad: 0 };
}

/**
 * Records -> walk. Records of one run (trace id, or all of them when there is none) become one ordered outcome; runs with
 * the same steps and ending are merged into one outcome with a count.
 * cfg: {fields, outcomes:[{field, equals|regex, outcome, reason?}], tool, kind, maxOutcomes}
 */
export function recordsToWalk(records, model, facts, cfg = {}, meta = {}) {
  const ix = buildIndex(model || { boxes: [] }, facts || {});
  const sc = makeScrub({ resolve: ix.resolvePath, fns: ix.fns });     // a step's file is stored repo-relative (or a base name), never as the absolute path the log printed
  const rules = (cfg.outcomes || []).map((r) => {
    if (!OUTCOME_RE.test(r.outcome)) throw new Error(`outcome rule ${JSON.stringify(r)}: outcome must be end:<box>, stuck:<box>, error or unknown`);
    return { ...r, re: r.regex ? new RegExp(r.regex) : null };
  });
  const runs = new Map();
  for (const r of records) {
    const k = r.run ?? '(all)';
    if (!runs.has(k)) runs.set(k, []);
    runs.get(k).push(r);
  }
  const groups = new Map();
  const explored = new Set();
  const hashes = {};
  let stepsTotal = 0, resolved = 0, ambiguous = 0;
  for (const [, rs] of [...runs.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    rs.sort((a, b) => ((a.time ?? 0) - (b.time ?? 0)) || ((a.depth ?? 0) - (b.depth ?? 0)) || a.order - b.order);
    const steps = [];
    let outcome = null, reason = '', firstErr = null;
    for (const r of rs) {
      const step = {};
      let sym = null;
      if (r.fn || r.name) {
        const qual = r.ns && r.fn ? fnByName(ix, `${String(r.ns).split('.').pop()}.${r.fn}`, r.file) : { id: null };
        const hit = qual.id ? qual : fnByName(ix, r.fn || r.name, r.file);
        if (hit.id) sym = hit.id; else if (hit.ambiguous) ambiguous++;
      }
      if (r.file && r.line != null) step.ref = sc.ref(`${r.file}:${r.line}`);
      if (sym) { step.sym = sym; resolved++; explored.add(sym); if (ix.fns[sym]?.sha256) hashes[sym] = ix.fns[sym].sha256; }
      const tag = r.tag ?? (!sym && (r.fn || r.name) ? (r.fn || r.name) : null);
      if (tag) step.tag = String(tag);
      if (r.msg) step.action = scrubText(r.msg, { cap: 60, emails: false });    // the message stays in the local walk, minus any machine path
      if (!step.ref && !step.sym && !step.tag) continue;
      steps.push(step);
      stepsTotal++;
      if (r.error && !firstErr) firstErr = r;
      for (const rule of rules) {
        const v = getPath(r.raw, rule.field);
        const hit = rule.re ? v != null && rule.re.test(String(v)) : rule.equals !== undefined ? v === rule.equals : false;
        if (hit) { outcome = rule.outcome; reason = rule.reason || r.msg || ''; }
      }
    }
    if (!steps.length) continue;
    if (!outcome) { outcome = firstErr ? 'error' : 'unknown'; reason = firstErr ? firstErr.msg : 'run ended in the log; the log does not say how'; }
    const sig = sha256(canonical({ outcome, steps: steps.map((s) => ({ ref: s.ref, sym: s.sym, tag: s.tag })) }));
    const g = groups.get(sig) || { outcome, strength: 'observed', reason: scrubText(reason, { cap: 160, emails: false }), witness: null, count: 0, steps };
    g.count++;
    groups.set(sig, g);
  }
  let outcomes = [...groups.values()].sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome));
  const max = cfg.maxOutcomes || 500;
  const dropped = Math.max(0, outcomes.length - max);
  outcomes = outcomes.slice(0, max);
  const walk = {
    header: { tool: cfg.tool || meta.tool || 'logs', kind: cfg.kind || 'run', pin: cfg.pin ?? facts?.pin?.tree ?? facts?.pin?.git ?? null,
      importedAgainst: { git: facts?.pin?.git ?? null, tree: facts?.pin?.tree ?? null }, hashes },
    label: { label: outcomes.length ? 'SAMPLED' : 'NONE', controls_passed: false, explored: [...explored].sort(), unexplored: [] },
    outcomes,
  };
  return { walk, stats: { records: records.length, runs: runs.size, outcomes: outcomes.length, dropped, steps: stepsTotal, resolvedByName: resolved,
    ambiguousNames: ambiguous, badLines: meta.bad || 0 } };
}

export function logsToWalk(text, model, facts, cfg = {}) {
  const { records, bad } = recordsFromJsonl(text, cfg);
  return recordsToWalk(records, model, facts, cfg, { bad, tool: 'logs-jsonl' });
}

export function spansToWalk(text, model, facts, cfg = {}) {
  const { records } = recordsFromSpans(text, cfg);
  return recordsToWalk(records, model, facts, cfg, { tool: 'otel-spans' });
}

/** Read a file, write projectDir/walks/<name>.walk.jsonl. format: jsonl | otel | auto (looks for span keys). */
export function importLogFile(file, model, facts, cfg = {}) {
  const text = fs.readFileSync(file, 'utf8');
  let format = cfg.format || 'auto';
  if (format === 'auto') format = /"(resourceSpans|traceId|trace_id)"/.test(text.slice(0, 4000)) && /"(spanId|span_id|startTimeUnixNano|start_time)"/.test(text.slice(0, 8000)) ? 'otel' : 'jsonl';
  const r = format === 'otel' ? spansToWalk(text, model, facts, cfg) : logsToWalk(text, model, facts, cfg);
  const out = cfg.out || path.join(cfg.projectDir || '.', 'walks', `${format === 'otel' ? 'spans' : 'logs'}-${path.basename(file).replace(/\.[^.]+$/, '')}.walk.jsonl`);
  writeWalkFile(out, r.walk);
  return { out, format, ...r.stats };
}
