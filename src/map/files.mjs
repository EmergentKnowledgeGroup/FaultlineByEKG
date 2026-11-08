// Which files a map reads, and a digest of exactly those files.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cmpCp } from './canon.mjs';
import { RootedSource } from '../story/source.mjs';

/** Folders no reader enters: dependencies, build output, caches, version control. */
export const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'venv', '.venv', 'dist', 'build', 'vendor', '.faultline']);

/** Thrown when an input was made from sources other than the ones on disk now. */
export class StaleInput extends Error {
  constructor(msg) { super(msg); this.name = 'StaleInput'; }
}

const escapeRe = (c) => c.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');

/** A glob (`*` within a folder, `**` across folders, `?` one character) as an anchored regular expression over a '/' path. */
export function globRe(g) {
  g = g.replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < g.length;) {
    if (g.startsWith('**/', i)) { out += '(?:.*/)?'; i += 3; }
    else if (g.startsWith('**', i)) { out += '.*'; i += 2; }
    else if (g[i] === '*') { out += '[^/]*'; i += 1; }
    else if (g[i] === '?') { out += '[^/]'; i += 1; }
    else { out += escapeRe(g[i]); i += 1; }
  }
  return new RegExp('^' + out + '$', 's');
}

/** Directory entries sorted by name (code point), with every link left out, to a file or to a folder: a link can lead outside the root, and the discovery
 *  walk (extract/walk.mjs) drops them too. */
export function listDir(dir) {
  const ents = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    ents.push({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() });
  }
  return ents.sort((a, b) => cmpCp(a.name, b.name));
}

/** The files under `root` whose relative path ends with one of `exts`, matches one of the `include` globs (all when none),
 *  and is neither matched by an `exclude` glob nor inside an `exclude` folder written without a wildcard. Sorted by code point. */
export function findFiles(root, include, exclude, exts) {
  const inc = (include || []).map(globRe);
  const exc = (exclude || []).map(globRe);
  const plain = (exclude || []).filter((g) => !g.includes('*'));
  const res = [];
  const walk = (dir, rel) => {
    for (const e of listDir(dir)) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDir) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r); continue; }
      if (!e.isFile || !exts.some((x) => e.name.endsWith(x))) continue;
      const ex = exc.some((re) => re.test(r)) || plain.some((g) => r === g || r.startsWith(g.replace(/\/+$/, '') + '/'));
      if ((!inc.length || inc.some((re) => re.test(r))) && !ex) res.push(r);
    }
  };
  walk(root, '');
  return res.sort(cmpCp);
}

/** sha256 over the sorted relative paths, each followed by the sha256 of that file's bytes. Throws StaleInput when a listed file cannot be read, or when its
 *  path is not a plain one inside `root` (absolute, `..`, a link that leads out): such a file counts as changed and is never opened. The list may come from a
 *  map folder somebody else made, so this must not read outside the source. It sees only the paths it is given: a file added after the map was built is not
 *  noticed, and the digest compares files with the map's own record, it does not check the map. */
export function fileDigest(root, rels) {
  const h = createHash('sha256'), gate = new RootedSource(root);
  for (const rel of [...rels].sort(cmpCp)) {
    const real = gate.resolve(rel);
    if (!real && gate.whyNot(rel) === 'outside') throw new StaleInput(`${JSON.stringify(String(rel).slice(0, 200))} is listed by the input but is not a plain path inside ${root}`);
    let b = null;
    if (real) try { b = fs.readFileSync(real); } catch { /* gone or unreadable: said below */ }
    if (!b) throw new StaleInput(`${rel} is listed by the input but cannot be read under ${root}`);
    h.update(rel + '\0' + createHash('sha256').update(b).digest('hex') + '\n');
  }
  return h.digest('hex');
}

/** Absolute, forward-slash path, or throw with the reason. A relative folder means one thing here and another where a checker is started. */
export function requireAbsolute(label, p) {
  if (!p) return p;
  if (!path.isAbsolute(p) || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('\\\\'))) {
    throw new Error(`${label} must be an absolute path; it is ${JSON.stringify(p)}. The type checker runs in another folder and would read a relative one differently.`);
  }
  return p;
}

export const fwd = (p) => p.replace(/\\/g, '/');
