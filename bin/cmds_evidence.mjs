// Evidence commands: walk add, walk list, coverage import, evidence <sub> (passthrough to src/evidence/cli.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { readProject, readJson, CliError } from '../src/build/project.mjs';
import { withWalkSymbols } from '../src/build/pipeline.mjs';
import { readWalkFile, validateWalk, writeWalkFile, cleanWalk, importWalks, importCoverageFile } from '../src/evidence/index.mjs';
import { makeScrub, isAbsolute } from '../src/evidence/scrub.mjs';
import { makePathResolver } from '../src/evidence/util.mjs';
import { run as evidenceRun } from '../src/evidence/cli.mjs';
import { loadModelReport } from '../src/model/index.mjs';
import { parse } from './args.mjs';
import { proj, needProject } from './cmds_project.mjs';

const out = (s = '') => console.log(s);
const rel = (p) => path.relative(process.cwd(), p).split(path.sep).join('/') || '.';

function needFacts(p) {
  const P = readProject(p.dir);
  if (!P.facts) throw new CliError(`${rel(p.dir)} has no facts.json. Fix: run  faultline extract  first.`, 2);
  return P;
}
const modelOrNull = (dir) => { const l = loadModelReport(dir); return l.refusals.length || !l.model.boxes.length ? null : withWalkSymbols(l.model, readJson(path.join(dir, 'facts.json'), null)); };

export async function walk(argv) {
  const [sub, ...rest] = argv;
  if (sub === 'add') return walkAdd(rest);
  if (sub === 'list') return walkList(rest);
  throw new CliError('Usage: faultline walk add FILE.walk.jsonl [--name NAME] [--force]   |   faultline walk list', 2);
}

async function walkAdd(argv) {
  const { pos, o } = parse(argv, { str: ['name'], bool: ['force'] });
  const p = proj(o);
  needProject(p);
  if (!pos[0]) throw new CliError('Usage: faultline walk add FILE.walk.jsonl', 2);
  const src = path.resolve(pos[0]);
  if (!fs.existsSync(src)) throw new CliError(`${pos[0]} does not exist.`, 2);
  let w, v;
  try { w = readWalkFile(src); v = validateWalk(w); } catch (e) { throw new CliError(`${pos[0]} is not a readable walk: ${String(e.message).split('\n')[0]}`, 1); }
  if (!v.ok) { for (const e of v.errors) out(`REFUSE walk ${path.basename(src)}: ${e}`); out('Not added. Walk format: docs/CONTRACTS.md section 8.'); return 1; }
  const name = (o.name || path.basename(src).replace(/\.walk\.jsonl$|\.jsonl$|\.json$/, '')).replace(/[^\w.-]+/g, '_');
  const dest = path.join(p.dir, 'walks', name + '.walk.jsonl');
  if (fs.existsSync(dest) && !o.force) throw new CliError(`${rel(dest)} exists. Fix: --name OTHER or --force.`, 1);
  // The stored file is a cleaned copy, not the original: whoever commits .faultline/ commits what is in walks/. Paths become repo-relative (or a file name),
  // home folders, emails and secrets are masked; the words of a reason stay. The original is left where it was.
  const facts = readProject(p.dir).facts;
  const sc = makeScrub({ resolve: facts ? makePathResolver(facts) : null, fns: facts?.functions || {} });
  const toProject = (wit) => {                                  // a witness file on this machine: kept as a path from the project folder if it lies in the source folder, else just its file name
    if (!path.isAbsolute(wit)) return isAbsolute(wit) ? sc.path(wit) : wit;
    const r = path.relative(p.root, wit);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? path.relative(p.dir, wit).split(path.sep).join('/') : sc.path(wit);
  };
  const clean = cleanWalk(w, sc, { witness: toProject });
  writeWalkFile(dest, clean);
  for (const m of v.warnings) out(`warn: ${m}`);
  out(`added ${rel(dest)}: ${w.header.tool} (${w.header.kind}), ${w.outcomes.length} outcome(s). ${v.says}`);
  out('The stored copy is cleaned: paths are repo-relative or a file name, home folders, emails and secrets are masked. Your original is unchanged.');
  out('Next: faultline build   (the page and BRIEF pick it up)   or  faultline breaks');
  return 0;
}

async function walkList(argv) {
  const { o } = parse(argv);
  const p = proj(o), P = needFacts(p), model = modelOrNull(p.dir);
  if (!model) throw new CliError('The model does not load or has no boxes yet. Fix: faultline check', 1);
  const ov = importWalks(p.dir, model, P.facts);
  if (o.json) { out(JSON.stringify({ labels: ov.labels, summary: ov.summary, rejected: ov.rejected })); return 0; }
  if (!ov.labels.length && !ov.rejected.length) { out('No walks loaded. Add one:  faultline walk add FILE   or   faultline coverage import FILE'); return 0; }
  for (const l of ov.labels) out(`${l.walk}  [${l.label}]  ${l.says}`);
  for (const r of ov.rejected) out(`REJECTED ${r.walk}: ${r.errors.join('; ')}`);
  const s = ov.summary;
  out(`boxes with evidence ${s.boxesWithEvidence}/${s.boxes}; steps not mapped ${s.notMapped}; gaps (no drawn route) ${s.missingRoutes}; stale boxes ${s.staleBoxes}`);
  return 0;
}

export async function coverage(argv) {
  const [sub, ...rest] = argv;
  if (sub !== 'import') throw new CliError('Usage: faultline coverage import FILE [--format coverage-py|lcov|istanbul] [--strip-prefix P]', 2);
  const { pos, o } = parse(rest, { str: ['format', 'strip-prefix', 'out'] });
  const p = proj(o), P = needFacts(p);
  if (!pos[0]) throw new CliError('Usage: faultline coverage import FILE', 2);
  if (!fs.existsSync(pos[0])) throw new CliError(`${pos[0]} does not exist.`, 2);
  const r = importCoverageFile(pos[0], P.facts, { projectDir: p.dir, format: o.format || 'auto', stripPrefix: o['strip-prefix'], out: o.out, model: modelOrNull(p.dir) || undefined });
  out(`${r.tool}: ${r.ran} of ${r.functionsSeen} functions had a body line run; ${r.matchedFiles}/${r.files} files matched${r.unmatchedFiles && r.unmatchedFiles.length ? ` (not in the map: ${r.unmatchedFiles.slice(0, 3).join(', ')}${r.unmatchedFiles.length > 3 ? ', ...' : ''})` : ''}`);
  out(`walk: ${rel(r.out)}. A box lights only when a cited function BODY ran; the def line runs at import and proves nothing.`);
  out('Next: faultline build   or   faultline breaks');
  return 0;
}

// logs, statechart and explorer imports: handed to src/evidence/cli.mjs
export async function evidence(argv) {
  const sub = argv[0];
  const known = ['import-logs', 'import-statechart', 'explore', 'walks', 'import-coverage'];
  if (!known.includes(sub)) throw new CliError(`Usage: faultline evidence <${known.join('|')}> ...`, 2);
  const o = argv.slice(1), i = o.indexOf('--project');
  const withProject = i >= 0 ? o : ['--project', proj({}).dir, ...o];
  return evidenceRun(sub === 'explore' ? argv : [sub, ...withProject]);
}
