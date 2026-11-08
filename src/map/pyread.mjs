// Reads Python files by running the stdlib-only reader script (py/pyread.py) on the machine's Python, and returns its document.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPython, requireRecentPython } from './pyenv.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'py', 'pyread.py');

/** -> { ir: the reader document { schema, files, errors, facts }, order: the order classes and functions were found in }. `files` are paths relative to `root`. */
export async function readPython({ root, files, interpreter, python }) {
  const py = requireRecentPython(python || await findPython(interpreter));
  const req = JSON.stringify({ root, files });
  const out = await new Promise((resolve, reject) => {
    const p = spawn(py.exe, ['-I', '-B', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const so = [], se = [];
    p.stdout.on('data', (c) => so.push(c));
    p.stderr.on('data', (c) => se.push(c));
    p.on('error', reject);
    p.on('close', (code) => {
      const text = Buffer.concat(so).toString('utf8');
      if (code === 0) return resolve(text);
      let why = Buffer.concat(se).toString('utf8').slice(-600);
      try { why = JSON.parse(text).refused || why; } catch { /* the script printed no refusal */ }
      reject(new Error(`the Python reader failed (exit ${code}): ${why}`));
    });
    p.stdin.on('error', () => { /* the script may exit before reading: its exit code says why */ });
    p.stdin.end(req);
  });
  return JSON.parse(out);
}
