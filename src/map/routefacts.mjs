// Runs routefacts.py: the facts about HTTP routes in Python files that the link rule in links_http.mjs reads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPython, requireRecentPython } from './pyenv.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'routefacts.py');

/** -> the parsed facts for the Python files `rels` (project-relative) under `root`. `work` is a folder for two small scratch files. */
export async function readRouteFacts({ root, rels, work = os.tmpdir(), interpreter = null }) {
  if (!rels.length) return { schema: 'fl.routefacts/1', files: [] };
  const py = requireRecentPython(await findPython(interpreter));
  fs.mkdirSync(work, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const list = path.join(work, `routefacts-${stamp}.in.json`);
  const out = path.join(work, `routefacts-${stamp}.out.json`);
  fs.writeFileSync(list, JSON.stringify(rels));
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(py.exe, ['-I', SCRIPT, root, list, out], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      const err = [];
      p.stderr.on('data', (c) => err.push(c));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`the route-fact reader failed (exit ${code}): ${Buffer.concat(err).toString('utf8').slice(-400)}`))));
    });
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } finally {
    for (const f of [list, out]) fs.rmSync(f, { force: true });
  }
}
