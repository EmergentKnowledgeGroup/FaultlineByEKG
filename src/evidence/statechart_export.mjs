// Statechart output folder (report.md + chart.mmd of a TLA+ statechart run) + a small mapping file -> walk file.
// One walk outcome per rule that breaks, strength proved-in-model. Chart states map to box ids through the mapping;
// a state with no mapping stays unmapped (never guessed).
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './util.mjs';
import { writeWalkFile } from './walk.mjs';

const slug = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60) || 'rule';

/** chart.mmd -> Map of state id (s0) to its label. Handles flat, nested ("state "x" as s1 {") and region charts. */
export function parseChart(text) {
  const labels = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^(s\d+):\s*(.+)$/.exec(line);
    if (m) { labels.set(m[1], m[2]); continue; }
    m = /^state\s+"(.*)"\s+as\s+(s\d+)\b/.exec(line);
    if (m) labels.set(m[2], m[1]);
  }
  return labels;
}

/** report.md -> {name, notes, sections:[{rule, steps:[{action,state}], loops, stops, text}], holds, notChecked, stopped}. */
export function parseReport(text, knownLabels = []) {
  const lines = text.split(/\r?\n/);
  const out = { name: '', reached: null, sections: [], holds: [], notChecked: [], stopped: false, notes: [] };
  const labels = [...new Set(knownLabels)].sort((a, b) => b.length - a.length);
  let i = 0;
  if (/^#\s+/.test(lines[0] || '')) { out.name = lines[0].replace(/^#\s+/, '').trim(); i = 1; }
  let cur = null;
  const splitStep = (t) => {
    for (const L of labels) {
      if (t === L) return { action: '', state: L };
      if (t.endsWith(': ' + L)) return { action: t.slice(0, t.length - L.length - 2), state: L };
    }
    const k = t.indexOf(': ');
    return k < 0 ? { action: '', state: t } : { action: t.slice(0, k), state: t.slice(k + 2) };
  };
  let inFence = false;
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith('```')) { inFence = !inFence; if (cur) cur.text.push(ln); continue; }
    if (inFence) { if (cur) cur.text.push(ln); continue; }
    let m = /^##\s+(.+?)\s+breaks\s*$/.exec(ln);
    if (m) { cur = { kind: 'breaks', rule: m[1], steps: [], loops: null, stops: null, counterexample: null, text: [ln] }; out.sections.push(cur); continue; }
    if (/^##\s+Rules that hold/.test(ln)) { cur = { kind: 'holds', text: [] }; continue; }
    if (/^##\s+Rules not checked/.test(ln)) { cur = { kind: 'notchecked', text: [] }; continue; }
    if (/^##\s+/.test(ln)) { cur = null; continue; }
    if (!cur) {
      if ((m = /^TLC reached (\d+) states and (\d+) steps/.exec(ln))) out.reached = { states: +m[1], steps: +m[2] };
      if (/^TLC stopped the drawing run|^TLC stopped with exit/.test(ln)) out.stopped = true;
      continue;
    }
    cur.text.push(ln);
    if (cur.kind === 'holds') { if (ln.trim() && !/^TLC /.test(ln)) out.holds.push(...ln.split(',').map((x) => x.trim()).filter(Boolean)); continue; }
    if (cur.kind === 'notchecked') {
      if (/^TLC stopped with exit/.test(ln)) out.stopped = true;
      else if (ln.trim() && !out.notChecked.length && !/^```/.test(ln)) out.notChecked.push(...ln.split(',').map((x) => x.trim()).filter(Boolean));
      continue;
    }
    if ((m = /^(\d+)\.\s+(.*)$/.exec(ln))) {
      const st = splitStep(m[2]);
      cur.steps.push({ n: +m[1], action: +m[1] === 0 ? '' : st.action, state: st.state });
    } else if ((m = /counterexample is in (\S+?)\./.exec(ln))) cur.counterexample = m[1];
    else if ((m = /^The run loops through (.+) forever\./.exec(ln))) cur.loops = m[1];
    else if ((m = /^The run stops in "(.*)" forever\./.exec(ln))) cur.stops = m[1];
  }
  return out;
}

/** Resolve a state label through the mapping: exact label, then chart id, then patterns. */
function boxFor(label, chart, mapping) {
  const states = mapping.states || {};
  if (label in states) return states[label];
  for (const [id, lab] of chart) if (lab === label && id in states) return states[id];
  for (const p of mapping.patterns || []) if (new RegExp(p.match).test(label)) return p.box;
  return null;
}

/**
 * Build the walk. dir holds report.md (required) and chart.mmd, <Name>.tla, tlc-*.out (all optional).
 * mapping: {states:{label|sN: boxId}, patterns:[{match,box}], tool?, controlsPassed?, pin?, hashes?}
 */
export function statechartToWalk(dir, mapping, opts = {}) {
  const rp = path.join(dir, 'report.md');
  if (!fs.existsSync(rp)) throw new Error(`no report.md in ${dir}: the folder must hold the model checker's report.md (format in skills/faultline/references/evidence.md)`);
  const reportText = fs.readFileSync(rp, 'utf8');
  const cp = path.join(dir, 'chart.mmd');
  const chart = fs.existsSync(cp) ? parseChart(fs.readFileSync(cp, 'utf8')) : new Map();
  const rep = parseReport(reportText, [...chart.values()]);
  const tla = fs.readdirSync(dir).find((f) => f.endsWith('.tla'));
  const pin = mapping.pin || sha256(tla ? fs.readFileSync(path.join(dir, tla), 'utf8') : reportText);
  const unmapped = new Set();
  const outcomes = [];
  for (const sec of rep.sections.filter((s) => s.kind === 'breaks')) {
    const boxes = sec.steps.map((s) => boxFor(s.state, chart, mapping));
    const steps = sec.steps.map((s, i) => {
      const st = {};
      if (boxes[i]) st.tag = boxes[i]; else { st.tag = `state:${s.state}`; unmapped.add(s.state); }
      if (s.action) st.action = s.action;
      return st;
    });
    const lastLabel = sec.steps.length ? sec.steps[sec.steps.length - 1].state : null;
    const lastBox = boxes.length ? boxes[boxes.length - 1] : null;
    const deadlock = /deadlock/i.test(sec.rule);
    const forever = sec.stops != null || sec.loops != null;
    let outcome = 'error', reason = `rule ${sec.rule} breaks at "${lastLabel ?? '?'}"`;
    if (deadlock || sec.stops != null) {
      outcome = lastBox ? `stuck:${lastBox}` : 'unknown';
      reason = deadlock ? `${sec.rule}: no step leaves "${lastLabel}"` : `${sec.rule}: the run stops in "${sec.stops}" forever`;
    } else if (sec.loops != null) {
      outcome = lastBox ? `stuck:${lastBox}` : 'unknown';
      reason = `${sec.rule}: the run loops through ${sec.loops} forever`;
    }
    if (outcome === 'unknown') reason += '; that state has no box in the mapping';
    const wdir = `${opts.witnessBase || 'statechart'}.witness`;
    const wfile = `${wdir}/${slug(sec.rule)}.json`;
    const witness = { kind: 'faultline.witness/1', source: 'statechart', rule: sec.rule, forever,
      steps: sec.steps.map((s) => ({ action: s.action, state: s.state })), tlcOutput: sec.counterexample, section: sec.text.join('\n').trim() };
    outcomes.push({ outcome, strength: 'proved-in-model', reason, witness: wfile, count: 1, steps, granularity: 'state', _witness: witness });
  }
  const explored = [...new Set([...chart.values()].map((l) => boxFor(l, chart, mapping)).filter(Boolean))].sort();
  const unexplored = rep.notChecked.map((r) => ({ at: r, why: 'TLC stopped before it checked this rule' }));
  if (rep.stopped && !unexplored.length) unexplored.push({ at: rep.name || 'model', why: 'TLC stopped before it finished' });
  const label = rep.reached ? (rep.stopped || unexplored.length ? 'BOUNDED_INCOMPLETE' : 'EXHAUSTIVE_WITHIN_MODEL') : 'NONE';
  const header = { tool: mapping.tool || 'statechart@tlc', kind: 'modelcheck', pin, rulesHold: rep.holds,
    ...(mapping.hashes ? { hashes: mapping.hashes } : {}) };
  const walk = { header, label: { label, controls_passed: mapping.controlsPassed === true, explored, unexplored }, outcomes };
  const unmappedAll = [...new Set([...chart.values()].filter((l) => !boxFor(l, chart, mapping)))].sort();
  return { walk, stats: { name: rep.name, rulesBroken: outcomes.length, rulesHold: rep.holds, notChecked: rep.notChecked, unmappedChartStates: unmappedAll,
    unmappedPathStates: [...unmapped].sort(), label } };
}

/** Write <out> and its witness files next to it. Returns the stats plus the paths written. */
export function exportStatechart(dir, mappingFile, out, opts = {}) {
  const mapping = typeof mappingFile === 'string' ? JSON.parse(fs.readFileSync(mappingFile, 'utf8')) : mappingFile;
  const base = path.basename(out).replace(/\.walk\.jsonl$/, '');
  const { walk, stats } = statechartToWalk(dir, mapping, { ...opts, witnessBase: base });
  const written = [];
  for (const o of walk.outcomes) {
    const wp = path.join(path.dirname(out), o.witness);
    fs.mkdirSync(path.dirname(wp), { recursive: true });
    fs.writeFileSync(wp, JSON.stringify(o._witness, null, 1) + '\n');
    written.push(wp);
    delete o._witness;
  }
  writeWalkFile(out, walk);
  return { out, witnesses: written, ...stats };
}
