// readSystem(config): reads every mapped language and asks the checkers, returning plain data. See CONTRACT.md.
import { findFiles, fileDigest, requireAbsolute, fwd } from './files.mjs';
import { readPython } from './pyread.mjs';
import { findPython, requireRecentPython } from './pyenv.mjs';
import { readTypeScript } from './tsir.mjs';
import { readLua } from './luair.mjs';
import { loadTypeScript, loadLuaGrammar } from './modules.mjs';
import { resolvePython } from './tyres.mjs';
import { tyBinary } from './tools.mjs';
import { plural } from '../build/util.mjs';

export { loadState, checkFresh } from './state.mjs';
export { canonJson, cmpCp, sortedCp, tkey, sha256 } from './canon.mjs';
export { StaleInput } from './files.mjs';
export * as resolvemix from './resolvemix.mjs';
export * as classes from './classes.mjs';

const PY_EXTS = ['.py'];
const ms = (t0) => Math.round(performance.now() - t0);

export async function readSystem(config) {
  const root = fwd(requireAbsolute('config.root', config.root));
  requireAbsolute('config.work', config.work);
  if (config.tools) requireAbsolute('config.tools', config.tools);
  const log = config.log || (() => {});
  const notes = [], timings = {};
  const mods = config.modules || {};
  const sys = { schema: 'fl.read/1', root, ir: { py: null, ts: null, lua: null }, order: { py: null }, ty: null, tyMeta: null, sourceFiles: 0, sourceDigest: null, notes, timings };
  let t = performance.now();
  let pyFiles = [];
  if (config.python) {
    const python = requireRecentPython(await findPython(config.interpreter));
    pyFiles = findFiles(root, config.python.include || [], config.python.exclude || [], PY_EXTS);
    const r = await readPython({ root, files: pyFiles, python });
    sys.ir.py = r.ir;
    sys.order.py = r.order;
    timings.py = ms(t);
    log(`python: ${plural(r.ir.files.length, 'file')} read in ${timings.py} ms`);
  }
  if (config.typescript) {
    t = performance.now();
    const ts = await loadTypeScript({ dir: mods.typescript });
    if (ts) sys.ir.ts = await readTypeScript({ ts, root, ...config.typescript });
    else notes.push({ code: 'no-typescript', text: 'the typescript package that comes with Faultline is not installed (run  npm install  in its folder), so TypeScript and JavaScript files were not read. Faultline never loads a typescript from the folder it maps: that would run the code it is only meant to read.' });
    timings.ts = ms(t);
    if (sys.ir.ts) log(`typescript and javascript: ${plural(sys.ir.ts.files.length, 'file')} read in ${timings.ts} ms`);
  }
  if (config.lua) {
    t = performance.now();
    const grammar = await loadLuaGrammar({ dir: mods.wasm });
    if (grammar) sys.ir.lua = await readLua({ grammar, root, prefix: config.lua.prefix || '', only: config.lua.only });
    else notes.push({ code: 'no-lua-grammar', text: 'web-tree-sitter or the Lua grammar is not installed, so Lua files were not read' });
    timings.lua = ms(t);
    if (sys.ir.lua) log(`lua: ${plural(sys.ir.lua.files.length, 'file')} read in ${timings.lua} ms`);
  }
  if (sys.ir.py) {
    t = performance.now();
    if (!tyBinary(config.tools)) {
      notes.push({ code: 'no-checker', text: 'the Python type checker is not installed (run setup): no negative claims about Python, and Python effects stay "maybe:"' });
    } else {
      if (!config.work) throw new Error('config.work is needed to run the Python checker: an absolute folder for its mirror and cache');
      const d = await resolvePython({ doc: sys.ir.py, name: config.name || 'system', root, rels: pyFiles, work: config.work, tools: config.tools, interpreter: config.interpreter, log });
      const { key, meta, ...answers } = d;
      sys.ty = answers;
      sys.tyMeta = meta;
      if (d.incomplete) notes.push({ code: 'checker-incomplete', text: 'the Python type checker did not finish or never gave a steady answer for some calls; its answers were not kept' });
    }
    timings.ty = ms(t);
  }
  const read = [...Object.values(sys.ir)].filter(Boolean).flatMap((doc) => doc.files.map((f) => f.path));
  sys.sourceFiles = read.length;
  sys.sourceDigest = fileDigest(root, read);
  return sys;
}
