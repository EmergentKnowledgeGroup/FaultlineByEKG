// checkProject: what `faultline check` does with the model. Reads the project dir, runs load, gates, analyze and
// propose, writes model.merged.json, proposals.json and receipts.json. Returns everything for the caller to print.
import fs from 'node:fs';
import path from 'node:path';
import { loadModelReport } from './load.mjs';
import { validateModel } from './gates.mjs';
import { analyze } from './analyze.mjs';
import { propose } from './propose.mjs';
import { makeReceipts, writeJson } from './receipts.mjs';

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}

// opts: {finished, overlay, geoms, metrics, cap, write=true, at}
export function checkProject(projectDir, opts = {}) {
  const facts = readJson(path.join(projectDir, 'facts.json'));
  const census = readJson(path.join(projectDir, 'census.json'));
  const graph = readJson(path.join(projectDir, 'graph.json'));
  const dismissed = readJson(path.join(projectDir, 'dismissed.json'), {}) || {};
  const signals = readJson(path.join(projectDir, 'signals.json'), null);
  const loaded = loadModelReport(projectDir);
  const write = opts.write !== false;

  if (loaded.refusals.length) {                                      // cannot judge a model that did not load
    const validation = { ok: false, refusals: loaded.refusals, warnings: [], gaps: { state: 'refused', items: [], tally: {}, notDrawn: {} } };
    const receipts = makeReceipts(loaded.model, facts, census, validation, [], opts);
    if (write) writeJson(path.join(projectDir, 'receipts.json'), receipts);
    return { model: loaded.model, validation, findings: [], proposals: null, receipts };
  }
  const model = loaded.model;
  const findings = analyze(model, facts, census, opts.overlay || null, { dismissed, cap: opts.cap, signals });
  const validation = validateModel(model, facts, census, { finished: !!opts.finished, geoms: opts.geoms, metrics: opts.metrics, findings, dismissed, charts: opts.charts });
  const proposals = propose(model, facts, graph, census, opts.proposeOpts || {});
  const receipts = makeReceipts(model, facts, census, validation, findings, opts);
  if (write) {
    writeJson(path.join(projectDir, 'model.merged.json'), model);
    writeJson(path.join(projectDir, 'proposals.json'), opts.proposeOpts ? { ...proposals, routes: proposals.routes.slice(0, 200) } : proposals);   // the file keeps the top 200; propose prints the rest on request
    writeJson(path.join(projectDir, 'receipts.json'), receipts);
  }
  return { model, validation, findings, proposals, receipts };
}
