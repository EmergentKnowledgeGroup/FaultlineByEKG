// Thin command layer over the evidence code, so bin/faultline can call run(argv) without knowing the internals.
//   import-coverage <file> [--format coverage-py|lcov|istanbul] [--strip-prefix P] [--out F]
//   import-logs <file> [--config cfg.json] [--format jsonl|otel] [--out F]
//   import-statechart <dir> --map mapping.json [--out F]
//   explore [explorer flags] -- <adapter command...>       (see explorer/runner.mjs)
//   walks                                                  (print what the imported walks say)
// Common: --project DIR (default .faultline). Facts come from DIR/facts.json, the model from DIR/model.merged.json or DIR/model/*.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importWalks } from './walk.mjs';
import { importCoverageFile } from './coverage.mjs';
import { importLogFile } from './logs.mjs';
import { exportStatechart } from './statechart_export.mjs';
import { main as exploreMain } from './explorer/runner.mjs';
import { resolveRoot } from '../extract/root.mjs';

export function loadProject(dir) {
  const facts = fs.existsSync(path.join(dir, 'facts.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'facts.json'), 'utf8')) : null;
  if (facts) facts.root = resolveRoot(facts.root, dir);      // facts.json stores the root as '..' steps; the importer wants the folder on this machine
  let model = null;
  const merged = path.join(dir, 'model.merged.json');
  const frag = path.join(dir, 'model');
  if (fs.existsSync(merged)) model = JSON.parse(fs.readFileSync(merged, 'utf8'));
  else if (fs.existsSync(frag)) {
    model = { boxes: [], routes: [], stages: [] };
    for (const f of fs.readdirSync(frag).filter((x) => x.endsWith('.json')).sort()) {
      const j = JSON.parse(fs.readFileSync(path.join(frag, f), 'utf8'));
      for (const k of Object.keys(model)) if (j[k]) model[k].push(...j[k]);
    }
  }
  return { facts, model };
}

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

export async function run(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'explore') return exploreMain(rest);
  const { pos, opt } = parse(rest);
  const projectDir = path.resolve(opt.project || '.faultline');
  const { facts, model } = loadProject(projectDir);
  const need = (what) => { if (!what) { console.error(`REFUSE no_${what === facts ? 'facts' : 'model'} evidence: ${projectDir} has no ${what === facts ? 'facts.json' : 'model'}. Fix: run faultline extract first.`); return false; } return true; };
  if (cmd === 'import-coverage') {
    if (!pos[0] || !need(facts)) return 2;
    const r = importCoverageFile(pos[0], facts, { projectDir, format: opt.format || 'auto', stripPrefix: opt['strip-prefix'], out: opt.out, model: model || undefined });
    console.log(`${r.tool}: ${r.ran} of ${r.functionsSeen} functions had a body line run; ${r.matchedFiles}/${r.files} files matched${r.unmatchedFiles.length ? ` (not in facts: ${r.unmatchedFiles.slice(0, 3).join(', ')}${r.unmatchedFiles.length > 3 ? ', ...' : ''})` : ''}\nwalk: ${r.out}`);
    return 0;
  }
  if (cmd === 'import-logs') {
    if (!pos[0] || !need(facts)) return 2;
    const cfg = opt.config ? JSON.parse(fs.readFileSync(opt.config, 'utf8')) : {};
    const r = importLogFile(pos[0], model, facts, { ...cfg, projectDir, format: opt.format || cfg.format, out: opt.out });
    console.log(`${r.format}: ${r.runs} run(s) -> ${r.outcomes} outcome(s), ${r.steps} steps, ${r.resolvedByName} matched a function by name\nwalk: ${r.out}`);
    return 0;
  }
  if (cmd === 'import-statechart') {
    if (!pos[0] || !opt.map) { console.error('usage: import-statechart <dir> --map mapping.json [--out F]'); return 2; }
    const out = path.resolve(opt.out || path.join(projectDir, 'walks', `statechart-${path.basename(path.resolve(pos[0]))}.walk.jsonl`));
    const r = exportStatechart(pos[0], opt.map, out);
    console.log(`${r.name}: ${r.rulesBroken} rule(s) break, ${r.rulesHold.length} hold, label ${r.label}${r.unmappedChartStates.length ? `; chart states with no box: ${r.unmappedChartStates.join(', ')}` : ''}\nwalk: ${r.out}`);
    return 0;
  }
  if (cmd === 'walks') {
    if (!need(model)) return 2;
    const ov = importWalks(projectDir, model, facts || {});
    for (const l of ov.labels) console.log(`${l.walk}: ${l.effective} - ${l.says}`);
    console.log(JSON.stringify(ov.summary));
    return 0;
  }
  console.error('usage: evidence <import-coverage|import-logs|import-statechart|explore|walks> ...');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e.stack || e.message); process.exitCode = 1; });
}
