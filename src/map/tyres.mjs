// The Python resolver: ty over its language server, one `textDocument/definition` at the NAME token of every call.
//
// What goes in: the Python reader's document (each call op carries `nl`/`nc`, the callee name token). What comes out, per site, is a list of canonical
// definitions, never a machine path:
//   { k: 'proj', p: rel path, l: line, c: col }     a definition inside the project (a def, a class, or a variable/parameter)
//   { k: 'ext',  m: module, q: qualified name }      a definition outside it (str.replace is builtins / str.replace)
// An empty list means ty made no claim; null means it could not be asked or never gave a steady answer. Canonical output is sorted, so two runs give
// the same bytes. The answers file is keyed on a hash of the mirrored sources, the ty version, the Python found and the sites, and is reused while that hash matches.
//
// ty never touches the mapped system: the included sources are COPIED to a mirror under the work folder and ty runs there. Its own cache (the typeshed
// it unpacks) is redirected to the work folder too (tools.resolverEnv).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Lsp } from './lsp.mjs';
import { cmpCp, canonJson } from './canon.mjs';
import { requireAbsolute, fwd } from './files.mjs';
import { tyBinary, versionOf, resolverEnv, toolsBase } from './tools.mjs';
import { findPython, headerEnv } from './pyenv.mjs';

export const CANON = 2;   // the shape of a canonical answer; part of the cache key, so an answers file in another shape is never reused

// ---- locations <-> paths ------------------------------------------------------------------------------------------------
const UNRESERVED = /[A-Za-z0-9_.\-~\/:]/;
/** file:///... for an absolute path: every byte but letters, digits, _ . - ~ / : is percent-encoded. */
export function uriOf(p) {
  let out = 'file:///';
  for (const b of Buffer.from(path.resolve(p).replace(/\\/g, '/'), 'utf8')) {
    const c = String.fromCharCode(b);
    out += b < 128 && UNRESERVED.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function pathOf(u) {
  let p = u.replace(/^file:\/\//, '').split(/[?#]/)[0];
  try { p = decodeURIComponent(p); } catch { /* keep the text as it is */ }
  if (p.length > 2 && p[0] === '/' && p[2] === ':') p = p.slice(1);
  return p.replace(/\\/g, '/');
}

// ---- canonical definitions ----------------------------------------------------------------------------------------------
// Python's notion of white space and of a word character, spelled out because the JS \s and \w differ from it.
const WS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const W = '[\\p{L}\\p{N}_]';
const DEF_RE = new RegExp(`^([${WS}]*)(async[${WS}]+def|def|class)[${WS}]+(${W}+)`, 'u');
const VAR_RE = new RegExp(`^([${WS}]*)([A-Za-z_]${W}*)[${WS}]*(?::[^=]+)?=(?!=)`, 'u');
const LEAD = new RegExp(`^[${WS}]*`);
const pyStrip = (s) => s.replace(new RegExp(`^[${WS}]+|[${WS}]+$`, 'g'), '');
const lines = new Map();

function expandTabs(s) {
  let col = 0, out = '';
  for (const ch of s) {
    if (ch === '\t') { const n = 8 - (col % 8); out += ' '.repeat(n); col += n; } else { out += ch; col = ch === '\n' || ch === '\r' ? 0 : col + 1; }
  }
  return out;
}
const indentOf = (ws) => [...expandTabs(ws)].length;

function linesOf(p) {
  if (!lines.has(p)) {
    let text = null;
    // \r\n and a lone \r end a line, as they do for the language server
    try { text = fs.readFileSync(p).toString('utf8').replace(/\r\n?/g, '\n').split('\n'); } catch { /* unreadable: no names */ }
    lines.set(p, text);
  }
  return lines.get(p);
}

/** Qualified name of the def / class / simple assignment that starts on `line` of a stub or a source file: ['Path.replace', 'def'].
 *  Read from the indentation of the file, not with a Python parser: a stub may use syntax the reader's Python does not know, and then the answer would
 *  depend on which Python ran the tool. A def inside a function gets `.<locals>.`. */
export function qualAt(file, line) {
  const ls = linesOf(file);
  if (ls === null || !(line >= 1 && line <= ls.length)) return ['?', '?'];
  const text = ls[line - 1];
  let name, kind, ind, m = DEF_RE.exec(text);
  if (m) { name = m[3]; kind = m[2] === 'class' ? 'class' : 'def'; ind = indentOf(m[1]); }
  else {
    m = VAR_RE.exec(text);
    if (!m) return ['?', '?'];
    name = m[2]; kind = 'var'; ind = indentOf(m[1]);
  }
  let prefix = '', cur = ind;
  for (let k = line - 2; k >= 0; k--) {
    const t = ls[k], st = pyStrip(t);
    if (!st || /^[#@)\]}]/.test(st)) continue;
    const ti = indentOf(LEAD.exec(t)[0]);
    if (ti < cur) {
      const mm = DEF_RE.exec(t);
      if (mm) prefix = mm[3] + (mm[2] === 'class' ? '.' : '.<locals>.') + prefix;
      cur = ti;
      if (cur === 0) break;
    }
  }
  return [prefix + name, kind];
}

/** [module name, origin] of a non-project file ty pointed at. */
export function moduleOf(file) {
  const p = file.replace(/\\/g, '/');
  let rel, origin;
  if (p.includes('/vendored/typeshed/') && p.includes('/stdlib/')) { rel = p.split('/stdlib/').slice(1).join('/stdlib/'); origin = 'stub'; }
  else if (p.includes('/site-packages/')) { rel = p.split('/site-packages/').slice(1).join('/site-packages/'); origin = 'pkg'; }
  else {
    const k = p.toLowerCase().lastIndexOf('/lib/');
    rel = k >= 0 ? p.slice(k + 5) : path.posix.basename(p); origin = 'src';
    if (rel.startsWith('python3') && rel.includes('/')) rel = rel.slice(rel.indexOf('/') + 1);
  }
  for (const suf of ['.pyi', '.py']) if (rel.endsWith(suf)) rel = rel.slice(0, -suf.length);
  if (rel.endsWith('/__init__')) rel = rel.slice(0, -9);
  return [rel.replace(/\//g, '.'), origin];
}

/** Canonical answer for one site: project definitions as (path, line, column); outside definitions as (module, qualified name) only. The kind of the
 *  definition and where the file lives (typeshed stub or the interpreter's own source) follow the machine's Python, not the code, so they are not kept;
 *  a `?` qualified name next to a named one of the same module is noise from a source file and is dropped. */
export function canon(locs, mirror) {
  const seen = new Map();
  const mir = fwd(mirror).replace(/\/+$/, '') + '/';
  for (const [u, line, col] of locs) {
    const p = pathOf(u);
    const t = p.toLowerCase().startsWith(mir.toLowerCase()) ? ['proj', p.slice(mir.length), line, col] : ['ext', moduleOf(p)[0], qualAt(p, line)[0]];
    seen.set(JSON.stringify(t), t);
  }
  const named = new Set([...seen.values()].filter((t) => t[0] === 'ext' && t[2] !== '?').map((t) => t[1]));
  const cmp = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      return typeof a[i] === 'number' ? a[i] - b[i] : cmpCp(a[i], b[i]);
    }
    return a.length - b.length;
  };
  const res = [];
  for (const t of [...seen.values()].sort(cmp)) {
    if (t[0] === 'ext' && t[2] === '?' && named.has(t[1])) continue;
    res.push(t[0] === 'proj' ? { k: 'proj', p: t[1], l: t[2], c: t[3] } : { k: 'ext', m: t[1], q: t[2] });
  }
  return res;
}

// ---- the run -------------------------------------------------------------------------------------------------------------
/** Copy the included Python sources to `dest` (same relative paths). -> a hash of their content. */
export function mirrorSources(root, rels, dest) {
  const h = createHash('sha256');
  for (const rel of [...rels].sort(cmpCp)) {
    const src = path.join(root, rel), dst = path.join(dest, rel);
    const data = fs.readFileSync(src);
    h.update(Buffer.concat([Buffer.from(rel, 'utf8'), Buffer.from([0]), createHash('sha256').update(data).digest()]));
    let same = false;
    try { same = fs.statSync(dst).size === data.length && fs.readFileSync(dst).equals(data); } catch { /* not copied yet */ }
    if (!same) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, data); }
  }
  return h.digest('hex');
}

/** The call sites of the reader's document: { path: [[line, col], ...] }, files and sites in order. */
export function collectSites(doc) {
  const byFile = new Map();
  for (const f of doc.files) {
    const seen = new Map();
    for (const fn of f.fns) for (const nd of fn.nodes) for (const o of nd.ops || []) {
      if ((o.t === 'call' || o.t === 'with') && o.nl !== undefined) seen.set(o.nl + ':' + o.nc, [o.nl, o.nc]);
    }
    if (seen.size) byFile.set(f.path, [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  }
  return new Map([...byFile].sort((a, b) => cmpCp(a[0], b[0])));
}

const siteKey = (rel, l, c) => `${rel}:${l}:${c}`;
const stripBom = (b) => (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b);

/** One pass over every site -> { raw: Map(siteKey -> [[uri, line, col]] | null), nreq, nerr, aborted } */
async function ask(L, mirror, sites, window, budget, t0) {
  const raw = new Map();
  let nreq = 0, nerr = 0, aborted = null;
  for (const [rel, ss] of sites) {
    const file = path.join(mirror, rel), u = uriOf(file);
    L.notify('textDocument/didOpen', { textDocument: { uri: u, languageId: 'python', version: 1, text: stripBom(fs.readFileSync(file)).toString('utf8') } });
    const todo = [...ss].reverse(), inflight = new Map();
    while (todo.length || inflight.size) {
      while (todo.length && inflight.size < window) {
        const s = todo.pop();
        inflight.set(L.request('textDocument/definition', { textDocument: { uri: u }, position: { line: s[0] - 1, character: s[1] } }), s);
        nreq++;
      }
      const m = await L.pump(60000);
      if (m === null || m.closed) { aborted = `timeout or closed at ${rel} with ${inflight.size} in flight`; break; }
      if (inflight.has(m.id)) {
        const s = inflight.get(m.id);
        inflight.delete(m.id);
        if (m.error) { nerr++; raw.set(siteKey(rel, s[0], s[1]), null); }
        else {
          const r = Array.isArray(m.result) ? m.result : m.result ? [m.result] : [];
          raw.set(siteKey(rel, s[0], s[1]), r.filter((x) => x.uri || x.targetUri).map((x) => {
            const st = (x.range || x.targetSelectionRange).start;
            return [x.uri || x.targetUri, st.line + 1, st.character];
          }));
        }
      }
      if ((Date.now() - t0) / 1000 > budget) { aborted = `budget exhausted at ${rel}`; break; }
    }
    L.notify('textDocument/didClose', { textDocument: { uri: u } });
    if (aborted) break;
  }
  return { raw, nreq, nerr, aborted };
}

/** A comparable form of one answer, so two answers can be checked for equality. */
function norm(v) {
  return v === null || v === undefined ? 'null' : JSON.stringify([...v].sort((a, b) => cmpCp(a[0], b[0]) || a[1] - b[1] || a[2] - b[2]));
}

/** Ask ty at every site until the answers STAND STILL.
 *  ty unpacks its bundled typeshed into the cache while it answers; on a cold cache the first questions about a module can be answered before its file is
 *  there (an empty or shorter answer), so a cold and a warm run could differ. Now: pass 1 and pass 2 over all sites; every site on which they differ is
 *  asked again one at a time until two consecutive answers agree. A site that never settles gets NO answer (null) and is counted, not cached as if it were known. */
export async function runTy({ exe, args = ['server'], mirror, sites, cache, window = 120, budget = 230, log = () => {} }) {
  const L = new Lsp(exe, args, { cwd: mirror, env: resolverEnv(cache) });
  L.folders = [{ uri: uriOf(mirror), name: 'root' }];
  const rid = L.request('initialize', {
    processId: process.pid, rootUri: uriOf(mirror), workspaceFolders: L.folders,
    capabilities: { textDocument: { definition: { linkSupport: false } }, workspace: { configuration: true, workspaceFolders: true } }, clientInfo: { name: 'faultline' },
  });
  for (;;) {
    const m = await L.pump(120000);
    if (m === null || m.closed) { L.kill(); throw new Error('ty did not answer initialize'); }
    if (m.id === rid) break;
  }
  L.notify('initialized', {});
  const t0 = Date.now();
  const p1 = await ask(L, mirror, sites, window, budget, t0);
  let nreq = p1.nreq, aborted = p1.aborted, raw = new Map(p1.raw);
  const meta = { passes: 1, differed_between_passes: 0, unstable: 0 };
  if (!aborted) {
    const p2 = await ask(L, mirror, sites, window, budget * 2, t0);
    nreq += p2.nreq;
    aborted = aborted || p2.aborted;
    meta.passes = 2;
    const diff = [...p1.raw.keys()].filter((k) => norm(p1.raw.get(k)) !== norm(p2.raw.get(k)));
    raw = new Map(p2.raw);
    meta.differed_between_passes = diff.length;
    if (diff.length && !aborted) {
      const where = new Map();
      for (const [rel, ss] of sites) for (const [l, c] of ss) where.set(siteKey(rel, l, c), [rel, l, c]);
      const byFile = new Map();
      for (const k of diff) {
        const [rel, l, c] = where.get(k);
        if (!byFile.has(rel)) byFile.set(rel, []);
        byFile.get(rel).push([l, c]);
      }
      const again_sites = new Map([...byFile].sort((a, b) => cmpCp(a[0], b[0])).map(([r, v]) => [r, v.sort((a, b) => a[0] - b[0] || a[1] - b[1])]));
      const prev = new Map(diff.map((k) => [k, p2.raw.get(k)]));
      const settled = new Map();
      for (let rnd = 0; rnd < 4; rnd++) {          // serial re-asks: one request in flight at a time, so nothing races
        const a = await ask(L, mirror, again_sites, 1, budget * 3, t0);
        nreq += a.nreq;
        aborted = aborted || a.aborted;
        for (const k of diff) {
          if (!settled.has(k) && norm(a.raw.get(k)) === norm(prev.get(k))) settled.set(k, a.raw.get(k));
          prev.set(k, a.raw.get(k));
        }
        meta.passes++;
        if (settled.size === diff.length || aborted) break;
      }
      for (const k of diff) {
        if (settled.has(k)) raw.set(k, settled.get(k));
        else { raw.set(k, null); meta.unstable++; }
      }
    }
  }
  try { L.request('shutdown', null); await L.pump(5000); L.notify('exit', null); } catch { /* already gone */ }
  L.kill();
  log(`ty: ${nreq} requests in ${meta.passes} passes, ${p1.nerr} errors, ${((Date.now() - t0) / 1000).toFixed(1)} s, ${meta.differed_between_passes} sites changed between pass 1 and 2, ${meta.unstable} never settled${aborted ? `, ABORTED: ${aborted}` : ''}`);
  return { raw, meta: { requests: nreq, errors: p1.nerr, aborted, ...meta } };
}

/** The interpreter ty is told to analyse against, pinned in ty.toml in the mirror so the answers do not depend on which python ty would find by itself. */
export function writeTyConfig(mirror, py) {
  const lines_ = ['[environment]'];
  if (py) lines_.push(`python = "${py.prefix}"`, `python-version = "${py.version[0]}.${py.version[1]}"`);
  else lines_.push('python-version = "3.13"');
  const txt = lines_.join('\n') + '\n', p = path.join(mirror, 'ty.toml');
  let have = null;
  try { have = fs.readFileSync(p, 'utf8'); } catch { /* none yet */ }
  if (have !== txt) fs.writeFileSync(p, txt);
}

/** -> { tool, version, env, key, sites_asked, meta, answers } for the Python call sites of the reader's document, or null when ty is not installed.
 *  The answers are cached in <work>/answers/<name>.ty.json under a hash of (sources, ty version, the Python environment, sites). A run that was cut short, or
 *  that left sites that never settled, is returned but NOT written: a partial answer must never be the one that sticks. */
export async function resolvePython({ doc, name = 'system', root, rels, work, tools, interpreter, log = () => {} }) {
  requireAbsolute('the work folder', work);
  const exe = tyBinary(tools);
  if (!exe) return null;
  const cache = path.join(work, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const mirror = fwd(path.join(work, 'mirror', name));
  fs.mkdirSync(mirror, { recursive: true });
  const srcHash = mirrorSources(root, rels.filter((r) => r.endsWith('.py')), mirror);
  const sites = collectSites(doc);
  const ver = await versionOf(exe, cache);
  const py = await findPython(interpreter);
  writeTyConfig(mirror, py);
  const envh = { ty: ver, python: py ? headerEnv(py) : 'none' };
  const key = createHash('sha256').update(canonJson([srcHash, ver, envh, Object.fromEntries(sites), CANON])).digest('hex');
  const out = path.join(work, 'answers', `${name}.ty.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out)) {
    const d = JSON.parse(fs.readFileSync(out, 'utf8'));
    if (d.key === key && !d.incomplete && !(d.meta || {}).unstable) { log(`ty: answers reused from ${out}`); return d; }
  }
  const { raw, meta } = await runTy({ exe, mirror, sites, cache, log });
  const answers = {};
  for (const [k, locs] of raw) answers[k] = locs === null ? null : canon(locs, mirror);
  const d = { tool: 'ty', version: ver, env: envh, key, sites_asked: [...sites.values()].reduce((a, v) => a + v.length, 0), meta, answers };
  if (meta.aborted || meta.unstable) d.incomplete = true;
  else fs.writeFileSync(out, canonJson(d));
  return d;
}

export { toolsBase };
