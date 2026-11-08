// Which Python this machine has, and what is installed in it. The Python checker is told to analyse against one interpreter, and the answers depend on
// the packages that interpreter has, so the version and a digest of the installed packages go in the map's header.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fwd } from './files.mjs';

export const MIN_PYTHON = [3, 10];

const PROBE = [
  'import sys, json',
  'try:',
  '    import importlib.metadata as m',
  "    d = sorted({(x.metadata['Name'] or '').lower() + '==' + x.version for x in m.distributions() if x.metadata['Name']})",
  'except Exception:',
  '    d = []',
  "print(json.dumps({'prefix': sys.prefix, 'version': list(sys.version_info[:3]), 'dists': d}))",
].join('\n');

const run = (exe, args, opts = {}) => new Promise((resolve) => {
  execFile(exe, args, { timeout: 60000, windowsHide: true, maxBuffer: 64 << 20, ...opts }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

/** Ask one interpreter who it is. -> { exe, version: [major, minor, patch], prefix, dists } or null when it is not a working Python. */
export async function probePython(exe) {
  const r = await run(exe, ['-I', '-c', PROBE]);
  if (r.err) return null;
  try {
    const d = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    return { exe, version: d.version, prefix: fwd(d.prefix), dists: d.dists };
  } catch { return null; }
}

/** The interpreter to use: the one named, else $FAULTLINE_PYTHON, else the first of `python`, `python3` that answers.
 *  -> the probe, or null. Never guesses: a named interpreter that does not answer is an error, not a reason to try another. */
export async function findPython(named) {
  const want = named || process.env.FAULTLINE_PYTHON;
  if (want) {
    const p = await probePython(want);
    if (!p) throw new Error(`the Python interpreter ${JSON.stringify(want)} did not run; name a working one with config.interpreter or FAULTLINE_PYTHON`);
    return p;
  }
  for (const exe of ['python', 'python3']) {
    const p = await probePython(exe);
    if (p) return p;
  }
  return null;
}

/** Refuse a Python older than the minimum, with the version found. */
export function requireRecentPython(p) {
  if (!p) throw new Error(`no Python interpreter found; Python ${MIN_PYTHON.join('.')} or newer is needed to read Python files (set FAULTLINE_PYTHON or config.interpreter)`);
  const [a, b] = p.version;
  if (a < MIN_PYTHON[0] || (a === MIN_PYTHON[0] && b < MIN_PYTHON[1])) throw new Error(`Python ${MIN_PYTHON.join('.')} or newer is needed to read Python files; ${p.exe} is ${p.version.join('.')}`);
  return p;
}

/** The part of the interpreter that goes in the header: its major.minor version and a digest of the installed packages. The prefix is a machine path and stays out. */
export function headerEnv(p) {
  if (!p) return null;
  return { version: `${p.version[0]}.${p.version[1]}`, packages: createHash('sha256').update(p.dists.join('\n')).digest('hex').slice(0, 12), count: p.dists.length };
}
