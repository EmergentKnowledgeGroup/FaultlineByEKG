// The two optional libraries the readers need: the `typescript` package (to read and check TypeScript and JavaScript) and `web-tree-sitter`
// with the Lua grammar (to read Lua). Neither is a hard dependency: when one is missing the reader reports that language as not read.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const GRAMMAR = '@tree-sitter-grammars/tree-sitter-lua';

/** The `typescript` package: from `dir` when given (a folder the person named, holding node_modules/typescript), else the one installed beside this package.
 *  Never the one inside the folder being mapped: loading it would run that folder's code, and the map promises that nothing it reads is run.
 *  -> the module, or null when none is installed. A folder that was named but holds no typescript is an error. */
export async function loadTypeScript({ dir } = {}) {
  if (dir) {
    try { return createRequire(path.join(dir, 'package.json'))('typescript'); } catch (e) { throw new Error(`typescript could not be loaded from ${dir}: ${e.message}`); }
  }
  try { return (await import('typescript')).default; } catch { return null; }                    // not installed beside this package
}

/** web-tree-sitter and the Lua grammar's wasm file. -> { Parser, Language, wasm } or null when either is missing. */
export async function loadLuaGrammar({ dir } = {}) {
  const req = dir ? createRequire(path.join(dir, 'package.json')) : createRequire(import.meta.url);
  let lib, wasm;
  try { lib = await import(pathToFileURL(req.resolve('web-tree-sitter')).href); } catch { return null; }
  try { wasm = path.join(path.dirname(req.resolve(`${GRAMMAR}/package.json`)), 'tree-sitter-lua.wasm'); } catch { wasm = dir ? path.join(dir, 'node_modules', GRAMMAR, 'tree-sitter-lua.wasm') : null; }
  if (!wasm || !fs.existsSync(wasm)) return null;
  return { Parser: lib.Parser, Language: lib.Language, wasm };
}
