// Does the code still match the map? A map is a snapshot. `faultline map` writes map/sources.json: every file the readers took (size and sha256) and the options that
// found them. codeVsMap(projectDir, root) compares that record with the folder as it is now, so `faultline status` can say when the map is behind.
//   sources.json  { schema: 'faultline.sources/1', files: { '<path below the code folder>': { size, sha256 } }, walk: { by: 'scan', include, exclude, noDefaults, languages }
//                                                                                                                 | { by: 'config', python?, typescript?, lua? } }
//   codeVsMap(projectDir, root) -> { state: 'matches'|'behind'|'unknown', changed:[], missing:[], added:[], refused:n, checked:n, why }
// Every file is opened only through RootedSource: a recorded path that is not a plain path inside the code folder, or leads out through a link, is counted as
// refused and never opened. The record sits in the map folder, so one made by someone else can list anything. Nothing here writes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RootedSource } from '../story/source.mjs';
import { discover } from '../extract/walk.mjs';
import { findFiles, SKIP_DIRS } from './files.mjs';
import { tsFiles } from './tsir.mjs';
import { luaWalk } from './luair.mjs';
import { canonJson, cmpCp } from './canon.mjs';

export const SOURCES_SCHEMA = 'faultline.sources/1';
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const strs = (a) => (Array.isArray(a) && a.every((x) => typeof x === 'string') ? a : null);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** The files the scanner counts as source, by language: what a map reads when no language is named. */
export function scanSources(root, { include = [], exclude = [], noDefaults = false } = {}) {
  const src = discover(root, { include, exclude, defaults: !noDefaults }).files.filter((f) => f.role === 'src');
  const by = (...langs) => src.filter((f) => langs.includes(f.lang)).map((f) => f.path);
  return { py: by('py'), ts: by('ts', 'js'), lua: by('lua') };
}

/** The walk to record, from what chooseLanguages chose (`chosen`) and what the readers produced (`ir`): only a language that was read is listed. */
function walkOf(chosen, ir) {
  const strOrEmpty = (a) => strs(a) || [];
  if (chosen.by === 'scan') {
    return { by: 'scan', include: strOrEmpty(chosen.include), exclude: strOrEmpty(chosen.exclude), noDefaults: chosen.noDefaults === true, languages: [ir.py && 'py', ir.ts && 'ts', ir.lua && 'lua'].filter(Boolean) };
  }
  const w = { by: 'config' };
  if (chosen.python && ir.py) w.python = { include: strOrEmpty(chosen.python.include), exclude: strOrEmpty(chosen.python.exclude) };
  if (chosen.typescript && ir.ts) w.typescript = { prefix: String(chosen.typescript.prefix || ''), exclude: strOrEmpty(chosen.typescript.exclude), ...(strs(chosen.typescript.only) ? { only: chosen.typescript.only } : {}) };
  if (chosen.lua && ir.lua) w.lua = { prefix: String(chosen.lua.prefix || ''), ...(strs(chosen.lua.only) ? { only: chosen.lua.only } : {}) };
  return w;
}

/** The text of map/sources.json: every file any reader took, with its size and sha256 (read through the gate), and the walk that found them. */
export function sourcesText(root, ir, chosen) {
  const gate = new RootedSource(root), files = {};
  for (const doc of Object.values(ir)) {
    if (!doc) continue;
    for (const f of doc.files) {
      const real = gate.resolve(f.path);
      if (!real) continue;                         // the readers took it through the same gate; a file gone since is not recorded
      const b = fs.readFileSync(real);
      files[f.path] = { sha256: sha256(b), size: b.length };
    }
  }
  return canonJson({ files, schema: SOURCES_SCHEMA, walk: walkOf(chosen, ir) });
}

/** The record in <projectDir>/map/sources.json: { files, walk }, or { why } when there is none or it is not one this version reads. */
function readSources(projectDir) {
  const file = path.join(projectDir, 'map', 'sources.json');
  let raw;
  try {
    if (fs.statSync(file).size > MAX_RECORD_BYTES) return { why: 'map/sources.json is too large to read' };
    raw = fs.readFileSync(file, 'utf8');
  } catch { return { why: 'this map has no map/sources.json (it was made by an older version), so what it read is not recorded; run  faultline map  again' }; }
  let j;
  try { j = JSON.parse(raw); } catch { return { why: 'map/sources.json is not valid JSON; run  faultline map  again' }; }
  if (!isObj(j) || j.schema !== SOURCES_SCHEMA || !isObj(j.files)) return { why: 'map/sources.json is not a record this version reads; run  faultline map  again' };
  for (const v of Object.values(j.files)) if (!isObj(v) || !Number.isSafeInteger(v.size) || v.size < 0 || typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256)) return { why: 'map/sources.json has an entry this version cannot read; run  faultline map  again' };
  return { files: j.files, walk: j.walk };
}

/** The files the same walk finds now, sorted, or null when the recorded walk cannot be run (it is malformed, or names a folder outside the code folder). Starts at the root; links are left out. */
function walkAgain(root, walk) {
  if (!isObj(walk)) return null;
  const out = new Set();
  try {
    if (walk.by === 'scan') {
      const include = strs(walk.include), exclude = strs(walk.exclude), langs = strs(walk.languages);
      if (!include || !exclude || !langs) return null;
      const s = scanSources(root, { include, exclude, noDefaults: walk.noDefaults === true });
      // the readers take exactly these, narrowed by their own walks: Python skips SKIP_DIRS folders, TypeScript and Lua walk the root and keep the listed ones
      if (langs.includes('py')) for (const r of s.py) if (!r.split('/').slice(0, -1).some((d) => SKIP_DIRS.has(d))) out.add(r);
      if (langs.includes('ts')) for (const r of tsFiles(root, { only: s.ts })) out.add(r);
      if (langs.includes('lua')) { const only = new Set(s.lua); for (const r of luaWalk(root, '')) if (only.has(r)) out.add(r); }
    } else if (walk.by === 'config') {
      const { python, typescript, lua } = walk;
      if (python) {
        const include = strs(python.include), exclude = strs(python.exclude);
        if (!include || !exclude) return null;
        for (const r of findFiles(root, include, exclude, ['.py'])) out.add(r);
      }
      if (typescript) {
        const exclude = strs(typescript.exclude), only = typescript.only === undefined ? null : strs(typescript.only);
        if (typeof typescript.prefix !== 'string' || !exclude || (typescript.only !== undefined && !only)) return null;
        for (const r of tsFiles(root, { prefix: typescript.prefix, exclude, only })) out.add(r);
      }
      if (lua) {
        const only = lua.only === undefined ? null : strs(lua.only);
        if (typeof lua.prefix !== 'string' || (lua.only !== undefined && !only)) return null;
        let top = root, rel = '';
        if (lua.prefix) {                           // the folder to start in must be a plain one inside the code folder
          const gate = new RootedSource(root), r = gate.ref(lua.prefix), real = r.ok ? gate.resolve(r.rel) : null;
          if (!real || !isDir(real)) return null;
          top = real; rel = r.rel;
        }
        const keep = only ? new Set(only) : null;
        for (const r of luaWalk(top, rel)) if (!keep || keep.has(r)) out.add(r);
      }
    } else return null;
  } catch { return null; }
  return [...out].sort(cmpCp);
}

/** Compare the code under `root` with the map in `projectDir`. See the top of this file. */
export function codeVsMap(projectDir, root) {
  const out = { state: 'unknown', changed: [], missing: [], added: [], refused: 0, checked: 0, why: '' };
  const rec = readSources(projectDir);
  if (rec.why) return { ...out, why: rec.why };
  if (!root || !isDir(root)) return { ...out, why: `the code folder${root ? ` ${String(root).replace(/\\/g, '/')}` : ''} is not there; pass --source <the code folder>` };
  const gate = new RootedSource(root);
  for (const rel of Object.keys(rec.files).sort(cmpCp)) {
    const want = rec.files[rel];
    const real = gate.resolve(rel);
    if (!real) { if (gate.ref(rel).ok && gate.whyNot(rel) === 'missing') out.missing.push(rel); else out.refused++; continue; }
    let st;
    try { st = fs.statSync(real); } catch { out.missing.push(rel); continue; }
    if (!st.isFile()) { out.missing.push(rel); continue; }
    out.checked++;
    if (st.size !== want.size) { out.changed.push(rel); continue; }
    let b;
    try { b = fs.readFileSync(real); } catch { out.missing.push(rel); continue; }
    if (sha256(b) !== want.sha256) out.changed.push(rel);
  }
  const now = walkAgain(root, rec.walk);
  if (now) out.added = now.filter((r) => !Object.hasOwn(rec.files, r));
  else out.why = 'files added since the map were not looked for: the map does not say how it found its files';
  out.state = out.changed.length || out.missing.length || out.added.length || out.refused ? 'behind' : 'matches';
  return out;
}

/** codeVsMap for what resolveProject returned: 'unknown' when the project does not say which folder holds its code (or remembers one outside its own folder, which was set aside). */
export function codeCheck(p) {
  if (p.rootKnown) return codeVsMap(p.dir, p.root);
  const away = p.rootSetAside ? `the project remembers its code at ${String(p.rootSetAside).replace(/\\/g, '/').replace(/[\u0000-\u001f\u007f]/g, '?')}, outside the folder that holds it, so Faultline did not look there; pass --source <the code folder>` : 'the project does not say which folder holds its code; pass --source <the code folder>';
  return { state: 'unknown', changed: [], missing: [], added: [], refused: 0, checked: 0, why: away };
}
