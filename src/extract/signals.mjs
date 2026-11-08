// signals.json: code-level facts for the pair, state and handler checks. A second, separate read of the source: facts.json and
// census.json are never touched. buildSignals reads the files, signalsFromRaw turns raw per-function facts into pairs, sticky flags,
// never-sent names, empty handlers and swallowed errors (pure, so tests can feed it small inputs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { familyOf, MSG_ENUM_NAME } from './signals_words.mjs';
import { lostWakeups } from './signals_wake.mjs';
import { portableRoot } from './root.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SIGNALS_SCHEMA = 'faultline.signals/1';
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// What a stop side writes when it is only emptying something out: that is clean-up, not a flag left set.
const EMPTY_LIT = new Set(['clear()', '""', '0', 'null', 'undefined', '[]', '{}', 'new Map()', 'new Set()', 'new WeakMap()', 'new WeakSet()', 'delete']);

// ---- pure part: raw -> signals --------------------------------------------------------------------------------------------
export function signalsFromRaw(raw) {
  const fns = raw.fns || [], byId = new Map(fns.map((f) => [f.id, f]));
  const classes = new Map((raw.classes || []).map((c) => [`${c.path}::${c.qual}`, c]));
  const groups = new Map();                                                    // path::owner -> [fn]
  for (const f of fns) { if (f.name === '<module>') continue; const k = `${f.path}::${f.owner}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
  const method = (owner, path_, name) => (groups.get(`${path_}::${owner}`) || []).find((m) => m.name === name);
  const fnRef = (f) => ({ fn: f.id, name: f.name, line: f.line, end: f.end });

  // pairs
  const pairs = [];
  for (const [gk, list] of groups) {
    const slots = new Map();                                                   // family|stem -> {stop:[], start:[]}
    for (const f of list) for (const m of familyOf(f.name)) {
      const k = `${m.family}|${m.stem}`;
      if (!slots.has(k)) slots.set(k, { family: m.family, stem: m.stem, stop: [], start: [] });
      slots.get(k)[m.side].push(f);
    }
    for (const s of slots.values()) {
      if (!s.stop.length || !s.start.length) continue;
      const a = s.stop.sort((x, y) => x.line - y.line)[0], b = s.start.sort((x, y) => x.line - y.line)[0];
      if (a.id === b.id) continue;
      pairs.push({ id: `${gk}|${s.family}|${s.stem}`, path: a.path, owner: a.owner, ownerIsClass: classes.has(`${a.path}::${a.owner}`), family: s.family, stem: s.stem, stop: fnRef(a), start: fnRef(b) });
    }
  }
  pairs.sort((a, b) => cmp(a.id, b.id));

  // what each side assigns, following this.method() calls inside the same class (a few hops)
  const closure = (f, depth = 3) => {
    const seen = new Map([[f.id, f]]), q = [[f, 0]]; let open = f.supers > 0;
    while (q.length) {
      const [x, d] = q.shift();
      for (const c of x.calls || []) {
        const m = method(x.owner, x.path, c);
        if (m) { if (!seen.has(m.id) && d < depth) { seen.set(m.id, m); q.push([m, d + 1]); } } else open = true;
      }
      if (x.supers > 0) open = true;
    }
    return { fns: [...seen.values()], open };
  };
  const effective = (f) => {
    const c = closure(f);
    return { rows: c.fns.flatMap((x) => (x.writes || []).map(([field, value, line]) => ({ field, value, line, fn: x.id }))), open: c.open, fns: c.fns };
  };
  const fieldWrites = {}, sticky = [];
  for (const p of pairs) {
    if (!p.ownerIsClass) continue;
    const a = byId.get(p.stop.fn), b = byId.get(p.start.fn), ea = effective(a), eb = effective(b);
    fieldWrites[p.id] = { stop: ea.rows.map(({ field, value, line, fn }) => ({ field, value, line, fn })), start: eb.rows.map(({ field, value, line, fn }) => ({ field, value, line, fn })) };
    const startFields = new Set(eb.rows.map((r) => r.field));
    const cls = classes.get(`${p.path}::${p.owner}`);
    const seenField = new Set();
    for (const w of ea.rows) {
      if (w.value === null || EMPTY_LIT.has(w.value) || startFields.has(w.field) || seenField.has(w.field)) continue;
      const owners = groups.get(`${p.path}::${p.owner}`) || [];
      if ((b.reads || []).some(([fld]) => fld === w.field)) continue;          // the start function checks it itself: a choice, not a slip
      const readers = owners.filter((x) => !ea.fns.includes(x) && x.id !== b.id).flatMap((x) => (x.reads || []).filter(([fld]) => fld === w.field).map(([, line]) => ({ fn: x.id, name: x.name, line })));
      if (!readers.length) continue;
      if (eb.open && cls && cls.bases > 0 && ((closure(b).fns.some((x) => x.supers > 0)))) continue;     // the start side may call an inherited method that clears it
      seenField.add(w.field);
      const others = [...owners.filter((x) => !ea.fns.includes(x)).flatMap((x) => (x.writes || []).filter(([fld]) => fld === w.field).map(([, value, line]) => ({ fn: x.id, name: x.name, value, line }))),
        ...(raw.inits || []).filter((i) => i.path === p.path && i.owner === p.owner && i.field === w.field).map((i) => ({ fn: `${p.path}::${p.owner}`, name: '(initial value)', value: i.value, line: i.line }))];
      sticky.push({ pair: p.id, family: p.family, path: p.path, owner: p.owner, field: w.field, value: w.value, stop: { ...p.stop, setAt: w.line, setIn: w.fn }, start: p.start,
        reads: uniqBy(readers, (r) => r.fn + ':' + r.line).slice(0, 4), readCount: uniqBy(readers, (r) => r.fn + ':' + r.line).length, otherWrites: others.slice(0, 3), startOpen: eb.open });
    }
  }
  sticky.sort((a, b) => cmp(a.pair, b.pair) || cmp(a.field, b.field));

  return {
    pairs, fieldWrites, sticky, lostWakeup: lostWakeups({ pairs, fieldWrites, groups, byId, classes }),
    neverSent: neverSent(raw),
    produced: producedIndex(raw.rawStrings || []),
    emptyHandlers: dedupe(raw.emptyHandlers || [], (e) => `${e.path}:${e.line}:${e.kind}:${e.name}`),
    swallowed: dedupe(raw.swallowed || [], (e) => `${e.path}:${e.line}:${e.kind}`),
  };
}

const uniqBy = (rows, key) => { const seen = new Set(); return rows.filter((r) => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; }); };
const dedupe = (rows, key) => { const seen = new Set(); return rows.filter((r) => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => cmp(a.path, b.path) || a.line - b.line || cmp(a.kind, b.kind)); };

// The declared string values (enum members, constants) that the code writes somewhere as a plain literal: assigned, put in a dict, returned, passed on.
// { "<value>": {n, at:["path:line", ...3]} }, keys sorted. The declared-never-produced check reads it to see values produced by assignment.
function producedIndex(rows) {
  const by = new Map();
  for (const r of rows) { if (!by.has(r.value)) by.set(r.value, []); by.get(r.value).push(`${r.path}:${r.line}`); }
  return Object.fromEntries([...by.keys()].sort(cmp).map((k) => { const at = [...new Set(by.get(k))].sort(cmp); return [k, { n: at.length, at: at.slice(0, 3) }]; }));
}

function neverSent(raw) {
  const defs = new Map();
  for (const d of raw.enums || []) { if (!defs.has(d.name)) defs.set(d.name, []); defs.get(d.name).push(d); }
  const used = new Map(), dyn = new Set();
  for (const u of raw.uses || []) { if (u.ctx === 'dyn') { dyn.add(u.name); continue; } const k = `${u.name}\u0000${u.member}`; if (!used.has(k)) used.set(k, []); used.get(k).push(u); }
  const sent = new Set((raw.rawStrings || []).map((r) => r.value));
  const out = [];
  const judge = (name, member, def, value, form) => {
    const rows = used.get(`${name}\u0000${member}`) || [];
    const handled = rows.filter((r) => r.ctx !== 'produce');
    if (!handled.length || rows.length !== handled.length) return;
    if ((value === null || /^-?\d+(?:\.\d+)?$/.test(value)) && !MSG_ENUM_NAME.test(name)) return;        // plain numbers: codes that come from outside
    if (typeof value === 'string' && value.length >= 3 && sent.has(value)) return;     // the same text is sent somewhere as a plain string
    const cases = handled.filter((r) => r.ctx === 'case' || r.ctx === 'cmp');
    out.push({ name: member ? `${name}.${member}` : name, enum: name, member: member || null, form, path: def.path, line: def.line, value: value ?? null,
      handled: handled.slice(0, 5).map((r) => ({ fn: r.fn, path: r.path, line: r.line, ctx: r.ctx, empty: !!r.empty })), handlerCount: handled.length,
      handlerEmpty: cases.length > 0 && cases.every((r) => r.empty) });
  };
  for (const [name, list] of defs) {
    if (list.length !== 1 || dyn.has(name)) continue;
    for (const m of list[0].members) judge(name, m.name, { path: list[0].path, line: m.line }, m.value, list[0].form);
  }
  for (const c of raw.consts || []) if (!dyn.has(c.name)) judge(c.name, '', c, c.value, 'constant');
  return out.sort((a, b) => cmp(a.path, b.path) || a.line - b.line || cmp(a.name, b.name));
}

// A name handled in one language is often sent by another (a TypeScript client of a Python server, a Lua script): if its text appears
// as a quoted string anywhere in the code read, outside the line that defines it, something may send it, so it is not reported.
function otherLanguageSenders(root, files, rows) {
  const cands = rows.filter((r) => typeof r.value === 'string' && r.value.length >= 3 && !/^-?\d/.test(r.value));
  if (!cands.length) return rows;
  const found = new Set(), esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const res = cands.map((r) => [r, new RegExp("[\"'`]" + esc(r.value) + "[\"'`]")]);
  for (const f of files) {
    let text; try { text = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (const [r, re] of res) {
      if (found.has(r) || !text.includes(r.value)) continue;
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i]) && !(f.path === r.path && i + 1 === r.line) && !/^\s*(?:case\b|if\b|elif\b|else\b)/.test(lines[i]) && !/(?:===?|!==?)\s*["'`]/.test(lines[i])) { found.add(r); break; }
    }
  }
  return rows.filter((r) => !found.has(r));
}

// ---- reading the source -------------------------------------------------------------------------------------------------
function runPython(rootDir, files, findPython) {
  const bin = findPython();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-sig-'));
  const listFile = path.join(dir, 'files.json'), outFile = path.join(dir, 'raw.json');
  try {
    fs.writeFileSync(listFile, JSON.stringify({ root: rootDir, files: files.map((f) => ({ path: f.path, role: 'src' })) }));
    const r = spawnSync(bin[0], [...bin.slice(1), '-B', '-I', path.join(here, 'signals_py.py'), '--list', listFile, '--out', outFile],
      { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 600000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    if (r.status !== 0) throw new Error('python signal reader failed: ' + String(r.stderr || r.error || '').slice(-600));
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } finally {
    for (const f of [listFile, outFile]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    try { fs.rmdirSync(dir); } catch { /* not empty */ }
  }
}

// files: [{path, lang:'py'|'ts'|'js'}] (source files only; tests are not read)
export async function buildSignals(rootDir, files, opts = {}) {
  const t0 = Date.now(), root = path.resolve(rootDir);
  const py = files.filter((f) => f.lang === 'py'), tsf = files.filter((f) => f.lang === 'ts' || f.lang === 'js');
  const parts = [], skipped = [];
  if (py.length) {
    const { findPython } = await import('./index.mjs');
    const raw = runPython(root, py, findPython);
    skipped.push(...raw.skipped.map((s) => ({ ...s, lang: 'py' })));
    parts.push(signalsFromRaw(raw));
  }
  if (tsf.length) {
    const { readSignalsTs } = await import('./signals_ts.mjs');
    const raw = await readSignalsTs(root, tsf, { ts: opts.ts || null });
    skipped.push(...raw.skipped.map((s) => ({ ...s, lang: 'ts' })));
    parts.push(signalsFromRaw(raw));
  }
  const cat = (k) => parts.flatMap((p) => p[k]);
  const neverSentRows = otherLanguageSenders(root, files, cat('neverSent'));
  const sort = (rows, f) => rows.sort(f);
  const fieldWrites = Object.assign({}, ...parts.map((p) => p.fieldWrites));
  const produced = {};
  for (const p of parts) for (const [k, v] of Object.entries(p.produced || {})) { const w = produced[k]; produced[k] = w ? { n: w.n + v.n, at: [...w.at, ...v.at].sort(cmp).slice(0, 3) } : v; }
  const sig = {
    schema: SIGNALS_SCHEMA, root: root.replace(/\\/g, '/'), pin: opts.pin || null,
    languages: { py: py.length, ts: tsf.length },
    pairs: sort(cat('pairs'), (a, b) => cmp(a.id, b.id)), fieldWrites, sticky: cat('sticky'), lostWakeup: cat('lostWakeup'), neverSent: neverSentRows, produced: Object.fromEntries(Object.keys(produced).sort(cmp).map((k) => [k, produced[k]])),
    emptyHandlers: cat('emptyHandlers'), swallowed: cat('swallowed'), skipped: skipped.slice(0, 50),
  };
  sig.counts = { pairs: sig.pairs.length, sticky: sig.sticky.length, lostWakeup: sig.lostWakeup.length, lostWakeupPolling: sig.lostWakeup.filter((x) => x.polls).length, neverSent: sig.neverSent.length, produced: Object.keys(sig.produced).length, emptyHandlers: sig.emptyHandlers.length, swallowed: sig.swallowed.length, skipped: skipped.length };
  sig.seconds = +((Date.now() - t0) / 1000).toFixed(2);
  return sig;
}

// The files the fact reader read: facts.modules, so function ids line up. Without facts, the same walker extract uses.
export async function signalFiles(rootDir, facts, cfg = {}) {
  if (facts && Array.isArray(facts.modules) && facts.modules.length) return facts.modules.filter((m) => ['py', 'ts', 'js', 'lua'].includes(m.lang)).map((m) => ({ path: m.path, lang: m.lang }));
  const { discover } = await import('./walk.mjs');
  return discover(rootDir, { include: cfg.include || [], exclude: cfg.exclude || [], defaults: !cfg.noDefaults }).files.filter((f) => f.role === 'src' && ['py', 'ts', 'js', 'lua'].includes(f.lang)).map((f) => ({ path: f.path, lang: f.lang }));
}

export function writeSignals(dir, sig) {
  fs.mkdirSync(dir, { recursive: true });
  const { seconds, ...kept } = sig;                                  // how long the read took is for the summary line, not for a file that must be the same every time
  fs.writeFileSync(path.join(dir, 'signals.json'), JSON.stringify({ ...kept, root: portableRoot(sig.root, dir) }));      // never a machine path
}
export function readSignals(dir) {
  try { const s = JSON.parse(fs.readFileSync(path.join(dir, 'signals.json'), 'utf8').replace(/^﻿/, '')); return s && s.schema === SIGNALS_SCHEMA ? s : null; } catch { return null; }
}

export function signalsSummary(sig) {
  const c = sig.counts || {};
  return `signals: pairs ${c.pairs}   sticky ${c.sticky}   lost-wakeup ${c.lostWakeup ?? 0}${c.lostWakeupPolling ? ` (${c.lostWakeupPolling} polling)` : ''}   never-sent ${c.neverSent}   empty handlers ${c.emptyHandlers}   swallowed ${c.swallowed}${c.skipped ? `   skipped ${c.skipped}` : ''}   ${sig.seconds}s`;
}

// Read the source for a project and write signals.json beside facts.json. cfg is the project's config.json (include/exclude).
export async function writeProjectSignals(rootDir, dir, facts, cfg = {}, outDir = null) {
  const files = await signalFiles(rootDir, facts, cfg);
  const sig = await buildSignals(rootDir, files, { pin: facts && facts.pin ? facts.pin.tree : null });
  writeSignals(outDir || dir, sig);
  return sig;
}
