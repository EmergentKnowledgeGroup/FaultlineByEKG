// Shared set-up for the rule tests: what this machine can read (Python, the Python checker, TypeScript, Lua) and a cached map of each fixture.
// The checker is looked for where `faultline setup` puts it; scratch folders go in the system temp folder (TMP / TEMP / TMPDIR move it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSystem } from '../../src/map/index.mjs';
import { mapSystem } from '../../src/map/mapsystem.mjs';
import { findPython } from '../../src/map/pyenv.mjs';
import { readRouteFacts } from '../../src/map/routefacts.mjs';
import { fwd } from '../../src/map/files.mjs';
import { tyBinary } from '../../src/map/tools.mjs';
import { loadTypeScript, loadLuaGrammar } from '../../src/map/modules.mjs';

export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'map').replace(/\\/g, '/');
export const WORK = path.resolve(path.join(os.tmpdir(), 'faultline-map-tests')).replace(/\\/g, '/');

let caps = null;
/** What this machine can do: { python, checker, typescript, lua } (each true or false). */
export async function capabilities() {
  if (caps) return caps;
  let python = false;
  try { python = !!(await findPython()); } catch { python = false; }
  let typescript = false;
  try { typescript = !!(await loadTypeScript()); } catch { typescript = false; }
  let lua = false;
  try { lua = !!(await loadLuaGrammar()); } catch { lua = false; }
  caps = { python, checker: python && !!tyBinary(), typescript, lua };
  return caps;
}

const cache = new Map();
/** The map of a fixture under test/fixtures: { sys, res } where res is what mapSystem returns. */
export async function build(name, { py = false, ts = false, lua = false, include = ['**'] } = {}) {
  const key = JSON.stringify([name, py, ts, lua, include]);
  if (cache.has(key)) return cache.get(key);
  const root = `${FIX}/${name}`;
  fs.mkdirSync(WORK, { recursive: true });
  const config = {
    root, work: `${WORK}/${name}`, 
    ...(py ? { python: { include, exclude: [] } } : {}), ...(ts ? { typescript: { prefix: '' } } : {}), ...(lua ? { lua: { prefix: '' } } : {}),
  };
  const sys = await readSystem(config);
  if (sys.ir.py) sys.routeFacts = await readRouteFacts({ root, rels: sys.ir.py.files.map((f) => f.path), work: WORK, interpreter: config.interpreter });
  const res = mapSystem(sys, { name });
  const out = { sys, res };
  cache.set(key, out);
  return out;
}

// ---- readers of a built map --------------------------------------------------------------------------------------------
export const boxesOf = (b, fn, kw = {}) => b.res.model.boxes.filter((x) => x.prov.fn.endsWith('::' + fn) && Object.entries(kw).every(([k, v]) => x[k] === v || x.prov[k] === v));
export function roadsOf(b, fn, rule = null) {
  const bx = new Map(b.res.model.boxes.map((x) => [x.id, x]));
  return b.res.model.routes.filter((r) => bx.get(r.from).prov.fn.endsWith('::' + fn) && (rule === null || r.prov.rule === rule)).map((r) => [bx.get(r.from), r, bx.get(r.to)]);
}
export const claimsOf = (b, fn, type = null) => b.res.claims.filter((c) => c.fn.endsWith('::' + fn) && (type === null || c.type === type));
/** The claims of `type` in the function whose id ends with fnSuffix and whose words match the regex (and sit on `line`, when given). */
export const hits = (b, fnSuffix, type, rx, line = null) => b.res.claims.filter((c) => c.fn.endsWith(fnSuffix) && c.type === type && new RegExp(rx).test(c.says) && (line === null || c.line === line));
export function handlerDisposition(b, fn) {
  const { P, F } = b.res;
  const fid = P.fids.find((f) => f.endsWith('::' + fn));
  const h = P.fns.get(fid).nodes.find((n) => n.k === 'handler');
  if (!h) throw new Error('no handler in ' + fn);
  return F.disposition(F.regionEffects(fid, h.i));
}

/** Like `build`, for a tree written on the fly: files is { 'rel/path': text }. Each call writes a new folder, so nothing is cached. */
export async function buildFiles(files, { py = false, ts = false, lua = false, include = ['**'], name = 'tree' } = {}) {
  fs.mkdirSync(WORK, { recursive: true });
  const root = fwd(fs.mkdtempSync(path.join(WORK, 'tree-')));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const config = {
    root, work: `${root}/_work`, 
    ...(py ? { python: { include, exclude: [] } } : {}), ...(ts ? { typescript: { prefix: '' } } : {}), ...(lua ? { lua: { prefix: '' } } : {}),
  };
  const sys = await readSystem(config);
  if (sys.ir.py) sys.routeFacts = await readRouteFacts({ root, rels: sys.ir.py.files.map((f) => f.path), work: WORK, interpreter: config.interpreter });
  const res = mapSystem(sys, { name });
  return { sys, res, root };
}

/** Every call a resolver pinned to a project function, in a function the map shows, that has no road from that function to the callee on its line:
 *  the calls the map could not draw. Empty when every call has its road. */
export function callsWithoutRoad(b) {
  const { P, M, model } = b.res;
  const bfn = new Map(model.boxes.map((x) => [x.id, x.prov.fn]));
  const drawn = new Set();
  for (const r of model.routes) {
    if (r.prov.rule !== 'call') continue;
    for (const ln of r.prov.lines ?? [r.prov.line]) drawn.add(`${r.prov.fn}\u0000${ln}\u0000${bfn.get(r.to)}`);
  }
  const missing = [];
  for (const fid of P.fids) {
    const reach = M.red.get(fid).reach;
    for (const nd of P.fns.get(fid).nodes) {
      if (!reach.has(nd.i)) continue;
      for (const o of nd.ops ?? []) {
        if (!((o.t === 'call' || o.t === 'with') && o.to?.length && ['exact', 'self', 'typed'].includes(o.how))) continue;
        for (const g of o.to) if (g !== fid && P.fns.has(g) && !drawn.has(`${fid}\u0000${o.line}\u0000${g}`)) missing.push(`${fid}:${o.line} -> ${g}`);
      }
    }
  }
  return missing;
}
