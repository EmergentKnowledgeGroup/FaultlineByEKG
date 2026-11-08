// File discovery for the extractor: default excludes, test/source roles, include/exclude globs, and the pin.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { realInside } from '../story/source.mjs';

export const LANG = { '.py': 'py', '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.lua': 'lua' };
const DIR_EXCLUDE = new Set(['node_modules', '.git', '.hg', '.svn', '.faultline', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.cache',
  '__pycache__', '.venv', 'venv', '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'site-packages', 'vendor', 'vendored', 'third_party',
  'third-party', 'thirdparty', 'external', 'bower_components', 'jspm_packages', '.idea', '.vscode', 'htmlcov', '.eggs', 'generated', '__generated__',
  '.turbo', '.parcel-cache', '.gradle', '.terraform', '__snapshots__', 'fixtures', '__fixtures__', 'testdata', 'storybook-static']);
// A documentation site sits beside the code it describes and holds its own scripts, themes and examples, which are not the system. Skipped only at the top
// of the mapped folder, so a package that happens to be called docs deeper in the code is still read. To map one, give it as the source folder.
export const DOC_DIRS = new Set(['docs', 'doc', 'documentation', 'website', 'docs_src']);
const TEST_DIR = new Set(['tests', 'test', '__tests__', 'spec', 'specs', 'e2e', '__mocks__', 'cypress', 'playwright', 'testing']);
const TEST_FILE = /(?:^test_.*\.py$|_test\.py$|^conftest\.py$|\.(?:test|spec|e2e-spec)\.[cm]?[jt]sx?$)/;
const GEN_FILE = /(?:_pb2(?:_grpc)?\.py$|\.generated\.[a-z]+$|\.gen\.[a-z]+$|\.min\.[cm]?js$|\.bundle\.[cm]?js$|\.d\.[cm]?ts$)/;
const GEN_HEAD = /@generated|Code generated|DO NOT EDIT|auto-?generated/i;
const MAX_BYTES = 4 * 1024 * 1024;

export function globToRe(g) {
  g = g.replace(/\\/g, '/').replace(/^\.\//, '');
  const hasGlob = /[*?]/.test(g);
  if (!hasGlob) return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '') + '(?:/|$)');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp((g.includes('/') ? '^' : '(?:^|/)') + re + '$');
}

const literalPrefix = (g) => { const i = g.search(/[*?]/); const p = i < 0 ? g : g.slice(0, i); return p.slice(0, p.lastIndexOf('/') + 1).replace(/\/$/, ''); };

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LINKED_GIT = /\/\.git\/(?:worktrees\/[^/]+|modules\/.+)$/;       // where a `.git` pointer file may lead: a linked worktree or a submodule keeps its state there
const fwd = (p) => p.replace(/\\/g, '/');
// a ref name as git writes it: under refs/, no part that is empty or starts with a dot, none of the characters git forbids
const okRef = (r) => /^refs\/[^\s\\:*?[\]^~\u0000-\u001f\u007f]+$/.test(r) && !r.includes('..') && !r.includes('@{') && r.split('/').every((s) => s && !s.startsWith('.'));

/** Text of a small file in the git folder `rg` (a real path): null when it is missing, false when it is a link or its real path leaves `rg`. */
function gitFile(rg, f) {
  let st;
  try { st = fs.lstatSync(f); } catch { return null; }
  if (!st.isFile()) return false;
  try { return realInside(fwd(rg), fwd(fs.realpathSync(f))) ? fs.readFileSync(f, 'utf8') : false; } catch { return false; }
}

/** Reads the HEAD commit id straight from the .git folder (no git command). No link is followed; only a 40 or 64 digit hex id comes back, else null. */
export function gitHead(root) {
  try {
    const dot = path.join(root, '.git');
    const st = fs.lstatSync(dot);
    let g = dot, pointed = false;
    if (st.isFile()) {                                              // a worktree or submodule: `gitdir: <path>`
      const m = /^gitdir:[ \t]*(.+)/.exec(fs.readFileSync(dot, 'utf8').slice(0, 4096));
      if (!m) return null;
      g = path.resolve(root, m[1].trim());
      pointed = true;
    } else if (!st.isDirectory()) return null;                      // a link is not followed
    const rg = fs.realpathSync(g);
    if (pointed ? !LINKED_GIT.test(fwd(rg)) : !realInside(fwd(fs.realpathSync(root)), fwd(rg))) return null;
    const head = gitFile(rg, path.join(rg, 'HEAD'));
    if (typeof head !== 'string') return null;
    const h = head.trim();
    if (!h.startsWith('ref:')) return COMMIT_ID.test(h) ? h : null;
    const ref = h.slice(4).trim();
    if (!okRef(ref)) return null;
    const loose = gitFile(rg, path.join(rg, ref));
    if (loose === false) return null;
    if (loose !== null) return COMMIT_ID.test(loose.trim()) ? loose.trim() : null;
    const packed = gitFile(rg, path.join(rg, 'packed-refs'));
    const line = typeof packed === 'string' ? packed.split('\n').find((l) => l.endsWith(' ' + ref)) : null;
    const id = line ? line.split(' ')[0] : '';
    return COMMIT_ID.test(id) ? id : null;
  } catch { return null; }
}

export function discover(rootDir, { include = [], exclude = [], defaults = true } = {}) {
  const inc = include.map((g) => ({ g, re: globToRe(g), pre: literalPrefix(g.replace(/\\/g, '/').replace(/^\.\//, '')) }));
  const exc = exclude.map((g) => globToRe(g));
  const matchInc = (rel) => inc.some((x) => x.re.test(rel));
  const files = [], skipped = [];
  const canEnter = (rel) => inc.some((x) => x.pre && (x.pre === rel || x.pre.startsWith(rel + '/') || rel.startsWith(x.pre + '/')));
  const walk = (abs, rel) => {
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (defaults && ents.some((e) => e.name === 'pyvenv.cfg') && !matchInc(rel)) return;
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        const lname = e.name.toLowerCase();
        const dflt = defaults && (DIR_EXCLUDE.has(lname) || e.name.endsWith('.egg-info') || (lname === 'runtime' && !rel) || (!rel && DOC_DIRS.has(lname)));
        if (dflt && !canEnter(r)) continue;
        if (exc.some((x) => x.test(r))) continue;
        walk(path.join(abs, e.name), r);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      const lang = LANG[ext];
      if (!lang) continue;
      if (exc.some((x) => x.test(r))) continue;
      const explicit = inc.length > 0 && matchInc(r);
      if (inc.length && !explicit) continue;
      let role = 'src';
      const inDefaultSkip = defaults && r.split('/').slice(0, -1).some((d) => DIR_EXCLUDE.has(d.toLowerCase()));
      if (defaults && !explicit) {
        if (inDefaultSkip) continue;
        if (r.split('/').slice(0, -1).some((d) => TEST_DIR.has(d.toLowerCase())) || TEST_FILE.test(e.name)) role = 'test';
        if (GEN_FILE.test(e.name)) continue;
      }
      let size = 0;
      try { size = fs.statSync(path.join(abs, e.name)).size; } catch { continue; }
      if (size > MAX_BYTES) { skipped.push({ path: r, why: `file over ${MAX_BYTES >> 20} MB` }); continue; }
      if (defaults && !explicit && role === 'src') {
        try {
          const fd = fs.openSync(path.join(abs, e.name), 'r');
          const buf = Buffer.alloc(Math.min(400, size));
          fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
          if (GEN_HEAD.test(buf.toString('utf8'))) { skipped.push({ path: r, why: 'generated file header' }); continue; }
          if (size > 100000 && lang !== 'py') {
            const t = fs.readFileSync(path.join(abs, e.name), 'utf8');
            if (t.length / Math.max(1, t.split('\n').length) > 500) { skipped.push({ path: r, why: 'looks minified' }); continue; }
          }
        } catch { continue; }
      }
      if (role === 'test' && lang === 'lua') continue;
      files.push({ path: r, role, lang });
    }
  };
  walk(rootDir, '');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped };
}

/** The documentation folders at the top of `rootDir` that discover() leaves out and that hold code files: [{ dir, files }]. */
export function docFoldersSkipped(rootDir) {
  const count = (abs) => {
    let n = 0, ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return 0; }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!DIR_EXCLUDE.has(e.name.toLowerCase())) n += count(path.join(abs, e.name)); } else if (LANG[path.extname(e.name).toLowerCase()]) n++;
    }
    return n;
  };
  let top;
  try { top = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { return []; }
  return top.filter((e) => e.isDirectory() && !e.isSymbolicLink() && DOC_DIRS.has(e.name.toLowerCase()))
    .map((e) => ({ dir: e.name, files: count(path.join(rootDir, e.name)) })).filter((d) => d.files > 0).sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

export function treePin(rootDir, files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    const fh = crypto.createHash('sha256').update(fs.readFileSync(path.join(rootDir, f.path))).digest('hex');
    h.update(`${f.path}\t${fh}\n`);
  }
  return h.digest('hex');
}
