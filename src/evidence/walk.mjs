// Walk files (CONTRACTS section 8): parse, validate, write, and import into the overlay the map draws from.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, inRanges, normSlashes } from './util.mjs';
import { buildIndex, mapStep, replayOrdered, lights } from './map.mjs';
import { makeScrub } from './scrub.mjs';

export const LABELS = ['NONE', 'SAMPLED', 'BOUNDED_INCOMPLETE', 'EXHAUSTIVE_WITHIN_MODEL'];
export const STRENGTHS = ['observed', 'replayable', 'proved-in-model', 'claimed'];
export const KINDS = ['run', 'test', 'modelcheck', 'explorer', 'manual'];
const LEVEL_RANK = { drawn: 0, suspected: 1, seen: 2, proved: 3 };
const OUTCOME_RE = /^(?:end|stuck):.+$|^(?:error|unknown)$/;

/** What a label may honestly say. Only an exhaustive search whose controls passed may say "no violation found". */
export function honestSays(label, controlsPassed) {
  if (label === 'EXHAUSTIVE_WITHIN_MODEL' && controlsPassed) {
    return 'no violation found: every state of the model was searched and the known-answer controls passed';
  }
  if (label === 'NONE') return 'not found in what was checked: nothing was checked';
  return 'not found in what was checked';
}

/** Parse walk text into {header,label,outcomes,errors}. Lenient on order, strict on shapes (see validateWalk). */
export function parseWalk(text) {
  const out = { header: null, label: null, outcomes: [], errors: [], warnings: [] };
  const rows = [];
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push([i + 1, JSON.parse(line)]); } catch (e) { out.errors.push(`line ${i + 1}: not JSON (${e.message})`); }
  });
  for (const [n, r] of rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { out.errors.push(`line ${n}: not an object`); continue; }
    if ('walk' in r) { if (out.header) out.warnings.push(`line ${n}: second header ignored`); else out.header = r; }
    else if ('label' in r) { if (out.label) out.warnings.push(`line ${n}: second label line ignored`); else out.label = r; }
    else if ('outcome' in r) out.outcomes.push({ ...r, _line: n });
    else out.warnings.push(`line ${n}: unknown line shape ignored`);
  }
  return out;
}

export function readWalkFile(file) {
  const w = parseWalk(fs.readFileSync(file, 'utf8'));
  w.file = file;
  return w;
}

/** Shape checks. Errors reject the walk; warnings are kept and printed. Also decides the label the walk may really claim. */
export function validateWalk(w) {
  const errors = [...w.errors];
  const warnings = [...w.warnings];
  const h = w.header;
  if (!h) errors.push('no header line (expected {"walk":1,...})');
  else {
    if (h.walk !== 1) errors.push(`header walk version ${JSON.stringify(h.walk)} is not 1`);
    if (typeof h.tool !== 'string' || !h.tool) errors.push('header tool is missing');
    if (!KINDS.includes(h.kind)) errors.push(`header kind ${JSON.stringify(h.kind)} is not one of ${KINDS.join('|')}`);
    if (h.pin != null && typeof h.pin !== 'string') errors.push('header pin must be a string');
  }
  const l = w.label || { label: 'NONE', controls_passed: false, explored: [], unexplored: [] };
  if (!w.label) warnings.push('no label line: treated as NONE');
  if (!LABELS.includes(l.label)) errors.push(`label ${JSON.stringify(l.label)} is not one of ${LABELS.join('|')}`);
  for (const k of ['explored', 'unexplored']) if (l[k] != null && !Array.isArray(l[k])) errors.push(`${k} must be a list`);
  let effective = LABELS.includes(l.label) ? l.label : 'NONE';
  const controls = l.controls_passed === true;
  if (effective === 'EXHAUSTIVE_WITHIN_MODEL' && (l.unexplored || []).length) {
    warnings.push('label says EXHAUSTIVE_WITHIN_MODEL but the walk lists unexplored items: treated as BOUNDED_INCOMPLETE');
    effective = 'BOUNDED_INCOMPLETE';
  }
  if (effective === 'EXHAUSTIVE_WITHIN_MODEL' && !controls) warnings.push('exhaustive without passed controls: will not say "no violation found"');
  if (effective === 'NONE' && (l.explored || []).length) warnings.push('label NONE but explored is not empty');
  w.outcomes.forEach((o, i) => {
    const at = `outcome ${i + 1} (line ${o._line})`;
    if (typeof o.outcome !== 'string' || !OUTCOME_RE.test(o.outcome)) errors.push(`${at}: outcome ${JSON.stringify(o.outcome)} must be end:<box>, stuck:<box>, error or unknown`);
    if (!STRENGTHS.includes(o.strength)) errors.push(`${at}: strength ${JSON.stringify(o.strength)} is not one of ${STRENGTHS.join('|')}`);
    if (!Array.isArray(o.steps)) errors.push(`${at}: steps must be a list`);
    else o.steps.forEach((s, j) => { if (!s || typeof s !== 'object') errors.push(`${at}: step ${j} is not an object`); });
    if (o.count != null && !(Number.isInteger(o.count) && o.count >= 1)) errors.push(`${at}: count must be a whole number of 1 or more`);
    if (o.witness != null && typeof o.witness !== 'string') errors.push(`${at}: witness must be a path or null`);
  });
  return { ok: errors.length === 0, errors, warnings, effectiveLabel: effective, controlsPassed: controls,
    says: honestSays(effective, controls) };
}

/** Serialize a walk. Key order is fixed so output is byte-stable. */
export function formatWalk({ header, label, outcomes }) {
  const h = { walk: 1, tool: header.tool, kind: header.kind, pin: header.pin ?? null };
  for (const k of Object.keys(header)) if (!(k in h) && header[k] !== undefined) h[k] = header[k];
  const l = { label: label.label, controls_passed: !!label.controls_passed, explored: label.explored || [], unexplored: label.unexplored || [] };
  for (const k of Object.keys(label)) if (!(k in l) && label[k] !== undefined) l[k] = label[k];
  const rows = [h, l, ...outcomes.map((o) => {
    const r = { outcome: o.outcome, strength: o.strength, reason: o.reason ?? '', witness: o.witness ?? null, count: o.count ?? 1, steps: o.steps || [] };
    for (const k of Object.keys(o)) if (!(k in r) && !k.startsWith('_') && o[k] !== undefined) r[k] = o[k];
    return r;
  })];
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

export function writeWalkFile(file, walk) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, formatWalk(walk));
  return file;
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

function emptyBox() { return { level: 'drawn', count: 0, visits: 0, reasons: [], tools: new Set(), ev: new Map(), claimed: 0, ambiguous: 0, vias: new Set() }; }

/**
 * Read projectDir/walks/*.walk.jsonl and fold them into the overlay.
 * overlay = {boxes:{id:{level,count,reasons,stale}}, routes:{id:{count}}, notMapped, missingRoutes, stale, unexplored, labels, ...}
 * Pure reading: no process is started and nothing is written.
 *
 * The overlay goes into pages and agent files meant for sharing, so nothing from the machine a walk came from may reach it (src/evidence/scrub.mjs):
 * every path is repo-relative (or a base name when it matches nothing in the facts), free text has absolute paths, emails and secrets masked, and the
 * text of an outcome's `reason` (a log message, for walks made from logs) is left out. opts.keepMessages keeps the reasons (paths still cut).
 */
export function importWalks(projectDir, model, facts, opts = {}) {
  const ix = buildIndex(model, facts);
  const dir = path.join(projectDir || '.', 'walks');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.walk.jsonl')).sort() : [];
  const sc = makeScrub({ resolve: ix.resolvePath, fns: ix.fns }, { keepMessages: !!opts.keepMessages });
  const acc = {
    boxes: new Map(), routes: new Map(), stages: new Map(), notMapped: new Map(), missing: new Map(), stale: [], unexplored: [],
    labels: [], walks: [], rejected: [], notReached: [], warnings: ix.warnings.map((w) => ({ ...w })), staleBoxes: new Map(), untested: new Map(), sc,
  };
  const box = (id) => { if (!acc.boxes.has(id)) acc.boxes.set(id, emptyBox()); return acc.boxes.get(id); };
  for (const f of files) {
    const file = path.join(dir, f);
    const fname = sc.text(f);
    let w;
    try { w = readWalkFile(file); } catch (e) { acc.rejected.push({ walk: fname, errors: [sc.text(e.message, { cap: 240 })] }); continue; }
    const v = validateWalk(w);
    for (const msg of v.warnings) acc.warnings.push({ code: 'walk-warning', msg: sc.text(`${f}: ${msg}`, { cap: 240 }), at: fname });
    if (!v.ok) { acc.rejected.push({ walk: fname, errors: v.errors.map((e) => sc.text(e, { cap: 240 })) }); continue; }
    foldWalk(acc, ix, model, facts, fname, file, w, v, box, opts);
  }
  return finish(acc, ix, files);
}

/** Does the walk's pin match the tree we are mapping? Never an error: an importer should still read the steps. */
function pinStatus(h, facts) {
  if (h.kind === 'modelcheck') return 'not-applicable';
  if (!h.pin) return 'unknown';
  const pins = [facts?.pin?.tree, facts?.pin?.git].filter(Boolean);
  if (!pins.length) return 'unknown';
  return pins.includes(h.pin) ? 'match' : 'mismatch';
}

function staleFns(h, facts) {
  const out = new Map();
  for (const [fn, sha] of Object.entries(h.hashes || {})) {
    const now = facts?.functions?.[fn];
    if (!now) out.set(fn, 'function is gone or renamed');
    else if (now.sha256 && now.sha256 !== sha) out.set(fn, 'function body changed since the walk');
  }
  if (!h.hashes) {
    const mods = new Map((facts?.modules || []).map((m) => [normSlashes(m.path), m.sha256]));
    for (const [p, sha] of Object.entries(h.fileHashes || {})) {
      const now = mods.get(normSlashes(p));
      if (now && now !== sha) {
        for (const [fn, f] of Object.entries(facts.functions || {})) if (normSlashes(f.path) === normSlashes(p)) out.set(fn, 'file changed since the walk (function hash not recorded)');
      }
    }
  }
  return out;
}

function witnessState(w, file, projectDir) {
  if (!w) return 'none';
  const cands = [path.resolve(path.dirname(file), w), path.resolve(projectDir, w)];
  return cands.some((c) => fs.existsSync(c)) ? 'present' : 'missing';
}

function foldWalk(acc, ix, model, facts, name, file, w, v, box, opts) {
  const sc = acc.sc;
  const h = { ...w.header, tool: sc.text(w.header.tool, { cap: 60 }) };
  // what mapStep says about a step, with the step's own words swapped for their cleaned forms, so no raw path or tag is in a reason
  const whyOf = (why, s, c) => {
    let t = String(why);
    for (const [raw, clean] of [[s.ref, c.ref], [s.sym, c.sym], [s.tag, c.tag]]) if (typeof raw === 'string' && raw && clean != null) t = t.split(raw).join(clean);
    return sc.text(t, { cap: 240 });
  };
  const projectDir = path.dirname(path.dirname(file));
  const pin = pinStatus(h, facts);
  // a pin is the only anchor of a walk without function hashes; with hashes, staleness is decided per box and the pin is just a note
  if (pin === 'mismatch' && !h.hashes && !h.fileHashes && (h.kind === 'run' || h.kind === 'test')) acc.warnings.push({ code: 'pin-differs', msg: `${name}: walk pin differs from the tree pin; read anyway, per-box staleness needs function hashes in the walk`, at: name });
  const stale = staleFns(h, facts);
  const staleOf = new Map(); // box id -> the stale functions it cites
  for (const [fn, why] of stale) for (const c of ix.fnBoxes.get(fn) || []) { if (!staleOf.has(c.box)) staleOf.set(c.box, []); staleOf.get(c.box).push({ fn, why }); }
  const info = { walk: name, tool: h.tool, kind: h.kind, label: w.label?.label || 'NONE', effectiveLabel: v.effectiveLabel,
    controls_passed: v.controlsPassed, says: v.says, pin: pin, outcomes: w.outcomes.length, steps: 0, mapped: 0, notMapped: 0,
    gaps: 0, explainedPrefix: null };
  const lab = { walk: name, tool: h.tool, kind: h.kind, label: info.label, effective: v.effectiveLabel,
    controls_passed: v.controlsPassed, says: v.says, found: 0 };
  acc.labels.push(lab);
  const examined = new Map();
  const lit = new Set();
  const deny = new Set((w.label?.unexplored || []).map((u) => u?.at).filter((a) => ix.boxes.has(a)));
  const model_only = h.kind === 'modelcheck';
  const target = (t) => {
    if (ix.boxes.has(t)) return [t];
    if (ix.fnBoxes.has(t)) return ix.fnBoxes.get(t).map((c) => c.box);
    return [];
  };
  const note = (id, strength, level, count, reason, via, ambiguous) => {
    const b = box(id);
    b.tools.add(h.tool);
    if (level !== 'drawn') b.vias.add(via);
    const stl = staleOf.has(id);
    const modeled = strength === 'proved-in-model';
    const key = (stl ? 'stale:' : 'fresh:') + level + (modeled ? ':model' : '');
    const e = b.ev.get(key) || { level, count: 0, visits: 0, stale: stl, modeled, reasons: new Set() };
    if (!modeled) { e.count += count; e.visits += 1; } else e.modelRuns = (e.modelRuns || 0) + count;
    if (reason) e.reasons.add(reason);
    b.ev.set(key, e);
    if (ambiguous) b.ambiguous += 1;
    if (stl) acc.staleBoxes.set(id, staleOf.get(id));
  };
  w.outcomes.forEach((o, oi) => {
    const count = o.count || 1;
    let strength = o.strength;
    const wit = witnessState(o.witness, file, projectDir);
    if ((strength === 'replayable' || strength === 'proved-in-model') && wit !== 'present') {
      acc.warnings.push({ code: 'witness-missing', msg: `${name}: outcome ${oi + 1} claims ${strength} but its witness is ${wit === 'none' ? 'null' : 'not on disk'}: counted as claimed`, at: name });
      strength = 'claimed';
    }
    const steps = o.steps.length > 200000 ? o.steps.slice(0, 200000) : o.steps;
    info.steps += steps.length;
    const mapped = steps.map((s) => mapStep(ix, s));
    for (let i = 0; i < mapped.length; i++) {
      const m = mapped[i];
      if (m.status === 'mapped') info.mapped++;
      else if (m.status === 'stage') { bump(acc.stages, m.stage, count); info.mapped++; }
      else {
        info.notMapped++;
        const s = steps[i];
        const c = { ref: s.ref == null ? null : sc.ref(s.ref), sym: s.sym == null ? null : sc.sym(s.sym), tag: s.tag == null ? null : sc.text(s.tag) };
        const key = c.sym || c.ref || c.tag || '(empty step)';
        const cur = acc.notMapped.get(key) || { key, count: 0, walks: new Set(), why: whyOf(m.why, s, c), example: c };
        cur.count += count; cur.walks.add(name);
        acc.notMapped.set(key, cur);
      }
    }
    const observed = strength === 'observed' || strength === 'replayable';
    const said = sc.message(o.reason);            // '' unless the person asked to keep messages
    const reasonBase = `${h.tool}${said ? ': ' + said : ''}`;
    // 1. light the boxes the steps reached
    if (o.unordered) {
      lightUnordered(ix, steps, mapped, count, strength, h, (id, c, why, amb) => { lit.add(id); if (observed) note(id, strength, 'seen', c, why, 'cover', amb); }, examined);
    } else if (strength !== 'claimed') {
      const rp = replayOrdered(ix, mapped, { rests: o.granularity === 'state' });
      info.gaps += rp.gaps.length;
      info.viaCall = (info.viaCall || 0) + rp.viaCall;
      info.viaGlue = (info.viaGlue || 0) + rp.viaGlue;
      if (info.explainedPrefix == null || rp.gaps.length) info.explainedPrefix = rp.explainedPrefix;
      let prevL = [];
      rp.seq.forEach(({ i }) => {
        const m = mapped[i];
        let L = lights(m);
        const kept = L.filter((b) => !deny.has(b));
        if (kept.length) L = kept;
        for (const id of L) {
          lit.add(id);
          if (observed) note(id, strength, 'seen', count, reasonBase, m.via, L.length > 1);
        }
        const hits = [];
        for (const a of prevL) for (const b of L) if (a !== b && ix.between.has(a + '\u0000' + b)) hits.push([a, b]);
        if (hits.length === 1) {
          const rids = ix.between.get(hits[0][0] + '\u0000' + hits[0][1]);
          for (const rid of rids) {
            const r = acc.routes.get(rid) || { count: 0, maybe: 0, modeled: 0 };
            if (!observed) r.modeled += count; else if (rids.length === 1) r.count += count; else r.maybe += count;
            acc.routes.set(rid, r);
          }
        }
        prevL = L;
      });
      for (const g of rp.gaps) {
        const key = g.from.slice().sort().join(',') + '>' + g.to.slice().sort().join(',');
        const cur = acc.missing.get(key) || { from: g.from.slice().sort(), to: g.to.slice().sort(), count: 0, walks: new Set(), evidence: g.evidence,
          first: false, explainedPrefix: g.explainedPrefix, steps: rp.mappedSteps, outcome: sc.text(o.outcome), via: g.prevFn && g.fn ? `${g.prevFn} -> ${g.fn}` : '' };
        cur.count += count; cur.walks.add(name);
        if (g.first) { cur.first = true; cur.explainedPrefix = Math.min(cur.explainedPrefix, g.explainedPrefix); }
        acc.missing.set(key, cur);
      }
    } else {
      for (const s of mapped) for (const c of s.cands.slice(0, 1)) box(c.box).claimed += 1;
    }
    // 2. the outcome's own box
    const m = /^(end|stuck):(.+)$/.exec(o.outcome);
    if (m) {
      const ids = target(m[2]);
      if (!ids.length) {
        const otag = sc.ref(m[2]), okey = `${m[1]}:${otag}`;               // the target is cleaned like a ref: an absolute path after end: becomes its file name
        const cur = acc.notMapped.get(okey) || { key: okey, count: 0, walks: new Set(), why: `outcome target ${otag} is no box or cited symbol`, example: { ref: null, sym: null, tag: otag } };
        cur.count += count; cur.walks.add(name); acc.notMapped.set(okey, cur);
      }
      for (const id of ids) {
        lit.add(id);
        const what = m[1] === 'stuck' ? 'stuck here' : 'ended here';
        if (strength === 'replayable' || strength === 'proved-in-model') note(id, strength, 'proved', count, `${strength === 'replayable' ? 'replayed' : 'proved in the model'} ${what} (${reasonBase})`, 'outcome', false);
        else if (strength === 'observed') note(id, strength, 'seen', count, `observed ${what} (${reasonBase})`, 'outcome', false);
        else box(id).claimed += 1;
        const b = box(id);
        (b.outcomes ||= new Set()).add(m[1] + (strength === 'claimed' ? '?' : ''));
      }
    } else if (o.outcome === 'error' && strength !== 'claimed') {
      // an error ends at the last step that has a box: that box is where it was seen (or proved) to go wrong
      let li = mapped.length - 1;
      while (li >= 0 && mapped[li].status !== 'mapped') li--;
      if (li >= 0) {
        let L = lights(mapped[li]);
        const kept = L.filter((b) => !deny.has(b));
        if (kept.length) L = kept;
        for (const id of L) {
          lit.add(id);
          const proved = strength === 'replayable' || strength === 'proved-in-model';
          note(id, strength, proved ? 'proved' : 'seen', count, `${proved ? (strength === 'replayable' ? 'replayed' : 'proved in the model') : 'observed'} error here (${reasonBase})`, 'outcome', L.length > 1);
          (box(id).outcomes ||= new Set()).add('error');
        }
      }
    }
  });
  lab.found = w.outcomes.filter((o) => /^(stuck:|error$)/.test(o.outcome) && o.strength !== 'claimed').length;
  if (lab.found) {
    const all = v.effectiveLabel === 'EXHAUSTIVE_WITHIN_MODEL' && v.controlsPassed;
    lab.says = `${lab.found} stuck or failing ending(s) found${all ? '; every state of the model was searched and the controls passed' : '; not found elsewhere in what was checked, more may exist'}`;
  }
  // label lists
  // Explored lists light boxes only for explorer walks or walks with no steps; with steps, the steps are the evidence.
  const noSteps = info.steps === 0;
  if (!model_only && (h.kind === 'explorer' || noSteps)) for (const e of w.label?.explored || []) {
    const ids = e && typeof e === 'string' ? target(e) : [];
    for (const id of ids) { if (!lit.has(id)) { lit.add(id); note(id, 'observed', 'seen', 1, `${h.tool} explored it`, 'explored', false); } }
  }
  if (Array.isArray(w.label?.notReached) && w.label.notReached.length) acc.notReached.push({ walk: name, tool: h.tool, boxes: w.label.notReached.filter((b) => ix.boxes.has(b)) });
  for (const u of w.label?.unexplored || []) {
    const at = u?.at ?? String(u);
    const why = u?.why ? sc.text(u.why, { cap: 160 }) : '';
    acc.unexplored.push({ walk: name, tool: h.tool, at: sc.text(at), boxes: target(at), why });
    for (const id of target(at)) if (!examined.has(id)) examined.set(id, why ? `${h.tool}: ${why}` : `${h.tool}: nothing ran for it`);
  }
  // boxes whose every cited function was looked at by a coverage-like walk and none ran
  if (examined.size) for (const [id, why] of examined) if (!lit.has(id)) {
    const cur = acc.untested.get(id) || [];
    cur.push(why);
    acc.untested.set(id, cur);
  }
  for (const [fn, why] of stale) acc.stale.push({ walk: name, fn: sc.sym(fn), boxes: (ix.fnBoxes.get(fn) || []).map((c) => c.box), why });
  acc.walks.push(info);
}

/** Coverage-style steps: unordered, may carry executed/missed line ranges. A box lights only when a cited BODY line ran. */
function lightUnordered(ix, steps, mapped, count, strength, h, hit, examined) {
  const miss = (id, why) => { if (!examined.has(id)) examined.set(id, why); };
  steps.forEach((s, i) => {
    const fn = s.sym && ix.fnBoxes.has(s.sym) ? s.sym : mapped[i].fn;
    const cites = fn ? ix.fnBoxes.get(fn) : null;
    if (!cites) return;
    for (const c of cites) {
      let ok = c.lines.length === 0;
      let nope = null;
      let why = `cited function ${fn.split('::').pop()} body ran`;
      for (const L of c.lines) {
        if (inRanges(s.missed, L)) { nope = `${h.tool}: cited line ${L} never ran`; continue; }
        if (inRanges(s.ranges, L)) { ok = true; why = `cited line ${L} ran`; break; }
        if (!s.ranges) { ok = true; break; }
        ok = true; // not an executable line (comment, signature, blank): fall back to the body having run
      }
      if (ok) hit(c.box, s.hits ?? count, `${h.tool}: ${why}`, false);
      else miss(c.box, nope || `${h.tool}: nothing ran for it`);
    }
  });
}

function finish(acc, ix, files) {
  const boxes = {};
  const hasRoadIn = new Set(ix.routes.map((r) => r.to));
  for (const [id, b] of [...acc.boxes.entries()].sort((a, c) => (ix.order.get(a[0]) ?? 1e9) - (ix.order.get(c[0]) ?? 1e9))) {
    let best = null, bestStale = null;
    for (const e of b.ev.values()) {
      const slot = e.stale ? 'stale' : 'fresh';
      const cur = slot === 'fresh' ? best : bestStale;
      if (!cur || LEVEL_RANK[e.level] > LEVEL_RANK[cur.level]) { if (slot === 'fresh') best = e; else bestStale = e; }
    }
    const fresh = [...b.ev.values()].filter((e) => !e.stale);
    const out = {
      level: best ? best.level : 'drawn',
      count: fresh.reduce((n, e) => n + e.count, 0),
      modeled: fresh.reduce((n, e) => n + (e.modelRuns || 0), 0),
      visits: fresh.reduce((n, e) => n + e.visits, 0),
      reasons: [...new Set(fresh.flatMap((e) => [...e.reasons]))].slice(0, 6),
      stale: acc.staleBoxes.has(id) && !best,
      tools: [...b.tools].sort(),
    };
    if (bestStale && !best) { out.staleLevel = bestStale.level; out.reasons = [...bestStale.reasons].slice(0, 3); }
    // an end box nothing leads into, lit only because a cited line ran: the line ran, nobody arrived
    if (best && ix.boxes.get(id)?.kind === 'end' && !hasRoadIn.has(id) && [...b.vias].every((v) => v === 'ref' || v === 'sym' || v === 'cover')) {
      out.anchorOnly = true;
      out.reasons = [...out.reasons.slice(0, 2), 'no drawn road leads here: its cited line ran, which does not show anyone arrives'];
    }
    if (b.claimed) out.claimed = b.claimed;
    if (b.ambiguous) out.ambiguous = b.ambiguous;
    if (b.outcomes) out.outcomes = [...b.outcomes].sort();
    if (acc.untested.has(id) && out.level === 'drawn') { out.untested = true; out.reasons = acc.untested.get(id).slice(0, 3); }
    boxes[id] = out;
  }
  for (const [id, why] of acc.untested) if (!boxes[id]) boxes[id] = { level: 'drawn', count: 0, visits: 0, reasons: why.slice(0, 3), stale: false, tools: [], untested: true };
  const routes = {};
  for (const [id, r] of [...acc.routes.entries()].sort()) if (!id.startsWith('~')) routes[id] = r;
  const missingRoutes = [...acc.missing.values()].map((m) => ({ ...m, walks: [...m.walks].sort() }))
    .sort((a, b) => Number(b.first) - Number(a.first) || b.count - a.count || a.from.join().localeCompare(b.from.join()));
  const notMapped = [...acc.notMapped.values()].map((n) => ({ ...n, walks: [...n.walks].sort() })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const stale = acc.stale.sort((a, b) => a.fn.localeCompare(b.fn));
  const stages = {};
  for (const [id, c] of acc.stages) stages[id] = { count: c };
  const seen = Object.entries(boxes).filter(([, b]) => b.level === 'seen' || b.level === 'proved').map(([id]) => id);
  const never = ix.boxes.size && acc.walks.length ? [...ix.boxes.keys()].filter((id) => !boxes[id] || (boxes[id].level === 'drawn' && !boxes[id].stale)) : [];
  return {
    boxes, routes, stages, notMapped, missingRoutes, stale, unexplored: acc.unexplored, labels: acc.labels, notReached: acc.notReached,
    walks: acc.walks, rejected: acc.rejected, warnings: acc.warnings,
    untested: [...acc.untested.keys()].sort((a, b) => (ix.order.get(a) ?? 0) - (ix.order.get(b) ?? 0)),
    neverSeen: never,
    summary: { walkFiles: files.length, walksRead: acc.walks.length, boxesWithEvidence: seen.length, boxes: ix.boxes.size, notMapped: notMapped.length,
      missingRoutes: missingRoutes.length, staleBoxes: acc.staleBoxes.size },
  };
}
