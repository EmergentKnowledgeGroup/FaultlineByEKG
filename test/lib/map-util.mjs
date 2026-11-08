// Shared helpers for the reader tests: temporary folders (under the system temp folder, which TMP / TMPDIR can point elsewhere) and optional-tool lookups.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fwd } from '../../src/map/files.mjs';
import { findPython } from '../../src/map/pyenv.mjs';
import { loadTypeScript, loadLuaGrammar } from '../../src/map/modules.mjs';

export { fwd } from '../../src/map/files.mjs';

/** A new empty folder; every file named in `files` ({ 'rel/path': text }) is written into it. */
export function tmpTree(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-rd-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return fwd(dir);
}

export const python = await findPython().catch(() => null);
export const hasPython = !!python && (python.version[0] > 3 || (python.version[0] === 3 && python.version[1] >= 10));
export const typescript = await loadTypeScript().catch(() => null);
export const luaGrammar = await loadLuaGrammar().catch(() => null);
