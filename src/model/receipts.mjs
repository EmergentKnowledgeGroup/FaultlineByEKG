// receipts.json: a record of what `check` found. It is never trusted: build re-runs every gate itself.
// No clock in here, so the same input gives the same bytes. Pass opts.at if a stamp is wanted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const GATE_ORDER = ['G1', 'G2', 'G3', 'G4', 'G5', 'K1', 'L1', 'T1', 'B1', 'B2', 'M1', 'S1', 'S2', 'E1', 'A1'];
const FINISHED_ONLY = new Set(['B1', 'B2', 'M1', 'S1', 'S2', 'E1', 'A1']);

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export const hashOf = (v) => crypto.createHash('sha256').update(canonical(v)).digest('hex');

// a record names its first offender in the message; the receipt keeps every offender so nothing hides behind "and N more"
const offenderRecord = ({ code, msg, at, offenders, count }) => ({ code, msg, at, ...(offenders && offenders.length ? { offenders } : {}), ...(count > 1 ? { count } : {}) });

// validation: the object validateModel returned. findings: analyze output.
export function makeReceipts(model, facts, census, validation, findings = [], opts = {}) {
  const refused = new Map(), gap = new Map();
  for (const r of validation.refusals) refused.set(r.code, (refused.get(r.code) || 0) + 1);
  for (const r of validation.gaps.items) gap.set(r.code, (gap.get(r.code) || 0) + 1);
  const gates = GATE_ORDER.map((code) => {
    if (refused.has(code)) return { code, status: 'refuse', count: refused.get(code) };
    if (gap.has(code)) return { code, status: 'gap', count: gap.get(code) };
    if (!opts.finished && FINISHED_ONLY.has(code) && !gap.has(code)) return { code, status: 'pass-in-draft', count: 0 };
    return { code, status: 'pass', count: 0 };
  });
  const state = validation.gaps.state;
  const r = {
    schema: 'faultline.receipts/1',
    state,
    result: validation.refusals.length ? 'refused' : validation.gaps.items.length ? 'gaps' : 'clean',
    pin: { model: hashOf(model), facts: facts?.pin?.tree ?? null, census: census ? hashOf(census) : null },
    gates,
    refusals: validation.refusals.map(offenderRecord),
    gapItems: validation.gaps.items.map(offenderRecord),
    warnings: validation.warnings,
    tally: validation.gaps.tally,
    notDrawn: validation.gaps.notDrawn,
    findings: findings.map((f) => ({ ...f })),
    findingNotes: [...(findings.notes || [])],
  };
  if (opts.at) r.at = opts.at;
  return r;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1) + '\n');
  return file;
}
export function writeReceipts(projectDir, receipts) { return writeJson(path.join(projectDir, 'receipts.json'), receipts); }
