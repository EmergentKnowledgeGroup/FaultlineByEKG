// extract(rootDir, {include, exclude}) -> {facts, census, graph}: the deterministic code reader. No agent judgment here.
//   node src/extract/index.mjs <root> [--out dir] [--include a,b] [--exclude c,d] [--no-defaults]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discover, gitHead, treePin } from './walk.mjs';
import { readTs } from './ts_facts.mjs';
import { loadTs } from './ts_index.mjs';
import { readLua } from './lua_facts.mjs';
import { buildGraph } from './graph.mjs';
import { portableRoot } from './root.mjs';
import { buildCensus } from './census.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function findPython() {
  const tried = [];
  const cands = [];
  if (process.env.FAULTLINE_PYTHON) cands.push([process.env.FAULTLINE_PYTHON]);
  cands.push(['python3'], ['python'], ['py', '-3']);
  for (const c of cands) {
    const r = spawnSync(c[0], [...c.slice(1), '-c', 'import sys;print(sys.version_info[0]*100+sys.version_info[1])'], { encoding: 'utf8', timeout: 20000 });
    const v = r.status === 0 ? parseInt(String(r.stdout).trim(), 10) : NaN;
    if (v >= 309) return c;
    tried.push(c.join(' ') + (Number.isNaN(v) ? ' (not found)' : ` (python ${v / 100 | 0}.${v % 100})`));
  }
  throw new Error('Python 3.9 or newer is needed to read .py files; tried: ' + tried.join(', ') + '. Set FAULTLINE_PYTHON to the interpreter.');
}

function runPython(rootDir, files, stats) {
  const bin = findPython();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-'));
  const listFile = path.join(dir, 'files.json'), outFile = path.join(dir, 'py.json');
  try {
    fs.writeFileSync(listFile, JSON.stringify({ root: rootDir, files: files.map((f) => ({ path: f.path, role: f.role })) }));
    const r = spawnSync(bin[0], [...bin.slice(1), '-B', '-I', path.join(here, 'python_facts.py'), '--list', listFile, '--out', outFile],
      { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 900000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    if (r.status !== 0) throw new Error('python reader failed: ' + String(r.stderr || r.error || '').slice(-800));
    const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    stats.python = out.stats;
    return out;
  } finally {
    for (const f of [listFile, outFile]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
    try { fs.rmdirSync(dir); } catch { /* not empty or gone */ }
  }
}

const empty = () => ({ modules: [], functions: {}, entries: [], switches: [], enums: [], skipped: [], classBases: {} });

export async function extract(rootDir, opts = {}) {
  const t0 = Date.now();
  const root = path.resolve(rootDir);
  const stats = { files: 0 };
  const found = discover(root, { include: opts.include || [], exclude: opts.exclude || [], defaults: !opts.noDefaults });
  // noPython: the machine has no Python 3.9 or newer, so .py files are listed as skipped and the rest is read
  const files = opts.noPython ? found.files.filter((f) => f.lang !== 'py') : found.files;
  const skippedWalk = opts.noPython ? [...found.skipped, ...found.files.filter((f) => f.lang === 'py').map((f) => ({ path: f.path, why: 'Python was not found' }))] : found.skipped;
  stats.files = files.length;
  const byLang = (l) => files.filter((f) => f.lang === l);
  const py = byLang('py').length ? runPython(root, byLang('py'), stats) : empty();
  const lua = byLang('lua').length ? await readLua(root, byLang('lua').map((f) => ({ path: f.path, role: f.role }))) : { ...empty(), luaScripts: new Map() };
  const tsFiles = files.filter((f) => f.lang === 'ts' || f.lang === 'js').map((f) => ({ path: f.path, role: f.role }));
  let tsr = empty();
  if (tsFiles.length) {
    const ts = await loadTs(root);
    tsr = await readTs(root, tsFiles, { luaScripts: lua.luaScripts, ts });
    stats.ts = tsr.stats;
  }
  const parts = [py, tsr, lua];
  const modules = parts.flatMap((p) => p.modules).sort((a, b) => cmp(a.path, b.path));
  const functions = {};
  for (const id of parts.flatMap((p) => Object.keys(p.functions)).sort((a, b) => {
    const fa = parts.map((p) => p.functions[a]).find(Boolean), fb = parts.map((p) => p.functions[b]).find(Boolean);
    return cmp(fa.path, fb.path) || fa.line - fb.line || cmp(a, b);
  })) functions[id] = parts.map((p) => p.functions[id]).find(Boolean);
  for (const f of Object.values(functions)) if (f.callAt && !f.callAt.length) delete f.callAt;
  const entries = parts.flatMap((p) => p.entries).filter((e) => functions[e.fn] || e.kind === 'test')
    .map((e) => (e.kind === 'test' ? { ...e, calls: (e.calls || []).filter((c) => functions[c]) } : e))
    .sort((a, b) => cmp(a.fn, b.fn) || cmp(a.kind, b.kind));
  const switches = parts.flatMap((p) => p.switches).sort((a, b) => cmp(a.path, b.path) || a.line - b.line || cmp(a.name, b.name));
  const enums = parts.flatMap((p) => p.enums).sort((a, b) => cmp(a.path, b.path) || a.line - b.line || cmp(a.name, b.name));
  const classBases = {};
  for (const p of parts) for (const [k, v] of Object.entries(p.classBases || {})) if (!classBases[k]) classBases[k] = v;
  const languages = {};
  for (const m of modules) languages[m.lang] = (languages[m.lang] || 0) + 1;
  const skipped = [...skippedWalk, ...parts.flatMap((p) => p.skipped)].sort((a, b) => cmp(a.path, b.path));
  const facts = {
    schema: 'faultline.facts/1', root: root.replace(/\\/g, '/'), pin: { git: gitHead(root), tree: treePin(root, files) }, languages, modules, functions, entries, switches, enums,
    classBases: Object.fromEntries(Object.entries(classBases).sort((a, b) => cmp(a[0], b[0]))), skipped,
  };
  const graph = buildGraph(facts, { seed: opts.seed || 1 });
  const census = buildCensus(facts, graph);
  stats.seconds = +((Date.now() - t0) / 1000).toFixed(2);
  stats.peakRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
  return { facts, census, graph, stats };
}

export function writeOutputs(res, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const facts = { ...res.facts, root: portableRoot(res.facts.root, outDir) };      // res.facts keeps the real root for this run; the file never holds it
  for (const [name, data] of [['facts.json', facts], ['census.json', res.census], ['graph.json', res.graph]]) fs.writeFileSync(path.join(outDir, name), JSON.stringify(data));
}

export function summary(res) {
  const { facts: f, census: c, graph: g, stats: s } = res;
  const nf = Object.keys(f.functions).length;
  const lines = [
    `files read ${s.files}   modules ${f.modules.length}   functions ${nf}   languages ${JSON.stringify(f.languages)}   skipped ${f.skipped.length}`,
    `entries ${f.entries.filter((e) => e.kind !== 'test').length} (+${f.entries.filter((e) => e.kind === 'test').length} tests)   switches ${f.switches.length}   enums ${f.enums.length}`,
    `census: endings ${c.counts.endings} (required ${c.counts.endingsRequired})   branches ${c.counts.branches} (decision ${c.counts.decisionBranches}, guard ${c.counts.guardBranches}, trivial ${c.counts.trivialBranches})   passes ${c.counts.passes}   switches ${c.counts.switches}   outcome types ${c.counts.outcomeTypes}   raw returns+raises ${c.counts.rawReturnsAndRaises}`,
    `graph: call edges ${g.callEdges.length} (+${g.weakCallEdges.length} weak)   import edges ${g.importEdges.length}   scc ${g.scc.length}   clusters ${g.clusters.length}   reached ${Object.keys(g.depth).length}/${nf}   hubs ${g.hubs.length}`,
    `time ${s.seconds}s   node peak RSS ${s.peakRssMb} MB` + (s.python ? `   python ${s.python.seconds}s peak ${s.python.peakRssMb} MB` : ''),
  ];
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const root = a.find((x) => !x.startsWith('--') && a[a.indexOf(x) - 1] !== '--out' && a[a.indexOf(x) - 1] !== '--include' && a[a.indexOf(x) - 1] !== '--exclude');
  if (!root) { console.error('usage: node src/extract/index.mjs <root> [--out dir] [--include a,b] [--exclude c,d] [--no-defaults]'); process.exit(2); }
  const res = await extract(root, { include: (val('--include') || '').split(',').filter(Boolean), exclude: (val('--exclude') || '').split(',').filter(Boolean), noDefaults: a.includes('--no-defaults') });
  if (val('--out')) writeOutputs(res, val('--out'));
  console.log(summary(res));
}
