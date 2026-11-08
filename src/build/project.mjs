// Project directory handling: where the .faultline folder is, what is in it, and plain JSON reads and writes.
//   resolveProject({project, root, cwd}) -> {dir, root, rootKnown, rootFrom, rootSetAside, exists, fresh}   (exists: a project was named or found; fresh: none was, dir is where init would make one;
//                                            rootFrom: 'flag' | 'config' | 'facts' | 'guess'; rootSetAside: a remembered root outside the project's folder, not used)
//   requireRoot(p) stops with rootSetAsideNote(p) when the code folder was set aside (extract, signals); mayQuoteCode(p) says whether build --excerpts may copy lines from p.root
//   readProject(dir) -> {facts, census, signals, graph, dismissed, config}
// "Every step works from a project dir": run from the repo, from inside .faultline, or pass --project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRoot } from '../extract/root.mjs';

export const NAME = '.faultline';
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}
export function writeJson(file, data, { pretty = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)) + '\n');
}
export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const hasFragment = (d) => { try { return fs.readdirSync(path.join(d, 'model')).some((f) => f.endsWith('.json') && fs.readFileSync(path.join(d, 'model', f), 'utf8').slice(0, 400).includes('faultline.model/1')); } catch { return false; } };
const lower = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// The user's home folder is never a project: tools and caches of other programs live under it, and every folder below it would otherwise resolve to it.
const isHome = (d) => { try { return lower(path.resolve(d)) === lower(path.resolve(os.homedir())); } catch { return false; } };

// A folder named .faultline is a project only if something a project writes is in it. A folder holding only tools, or nothing, is not one.
export const looksLikeProjectDir = (d) => ['facts.json', 'census.json', 'config.json', 'map/model.json', 'dist/atlas.agent.json'].some((f) => isFile(path.join(d, f))) || hasFragment(d);
const looksLikeProject = (d) => (path.basename(d) === NAME ? looksLikeProjectDir(d) && !isHome(path.dirname(d)) : (isFile(path.join(d, 'facts.json')) && isFile(path.join(d, 'census.json'))) || hasFragment(d));

// --project wins. Else: the current folder if it looks like a project, else a .faultline folder that looks like a project here or in a parent folder up to (not including) the home folder, else <cwd>/.faultline (for init).
// --project may also name the folder that HOLDS the .faultline folder: when it is not a project itself but its .faultline is, that is the project.
export function resolveProject({ project, root, cwd = process.cwd() } = {}) {
  let dir = null;
  if (project) {
    dir = path.resolve(cwd, project);
    const inner = path.join(dir, NAME);
    if (path.basename(dir) !== NAME && !looksLikeProject(dir) && isDir(inner) && looksLikeProjectDir(inner)) dir = inner;
  } else if (looksLikeProject(cwd)) dir = cwd;
  else {
    for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
      if (isHome(d)) break;                                              // the search ends at the home folder: its .faultline is never a project, and nothing above it is looked at
      if (isDir(path.join(d, NAME)) && looksLikeProjectDir(path.join(d, NAME))) { dir = path.join(d, NAME); break; }
      if (path.dirname(d) === d) break;
    }
  }
  const fresh = !dir;
  if (!dir) dir = path.join(path.resolve(cwd), NAME);
  const link = isDir(dir) ? linkIn(dir) : null;
  if (link) throw new CliError(`The project folder ${shown(dir)} holds a link (${shown(link)}). Faultline writes into that folder and will not write through a link. Delete the folder and map again, or map into a new one with  --project <new folder>`, 2);
  const facts = readJson(path.join(dir, 'facts.json'));
  const cfg = readJson(path.join(dir, 'config.json'), {}) || {};
  let src = root ? path.resolve(cwd, root) : null;
  let rootFrom = src ? 'flag' : null;
  // A root the project remembers (config.json, facts.json) travels with a cloned repo or a map someone else made, so it is taken only when it is the
  // folder that holds the project or a folder inside it. One that points anywhere else is set aside: the commands that read code then ask for --source.
  const holder = holderOf(dir);
  let rootSetAside = null;
  const remembered = (cand, from) => {
    if (src || !cand) return;
    if (holds(holder, cand)) { src = cand; rootFrom = from; } else if (!rootSetAside) rootSetAside = cand;
  };
  if (typeof cfg.root === 'string' && cfg.root) remembered(path.resolve(dir, cfg.root), 'config');
  const stored = resolveRoot(facts && facts.root, dir);                    // facts.json holds '..'-style or an older absolute root
  if (stored && isDir(stored)) remembered(stored, 'facts');
  const rootKnown = !!src;                                                // false: the folder below is a guess (the project's parent), not something the project remembers
  if (!src) src = path.basename(dir) === NAME ? path.dirname(dir) : path.resolve(cwd);
  return { dir, root: src, rootKnown, rootFrom: rootFrom || 'guess', rootSetAside, exists: !fresh && isDir(dir), fresh, named: !!project };
}

// The folder that holds a project: the parent of its .faultline folder, or the project folder itself when it has another name.
const holderOf = (dir) => (path.basename(dir) === NAME ? path.dirname(dir) : dir);

// Is `inner` the folder `outer` or below it? Links are resolved first, so a linked folder inside `outer` that leads elsewhere does not count.
function holds(outer, inner) {
  const real = (p) => { try { return lower(fs.realpathSync(p).replace(/\\/g, '/')).replace(/\/+$/, ''); } catch { return null; } };
  const a = real(outer), b = real(inner);
  return a != null && b != null && (b === a || b.startsWith(a + '/')); // a folder that cannot be resolved is not held: it may be a spelling Windows reads differently
}

// A project folder that holds a link is refused: Faultline writes into it, and a write through a planted link lands outside. -> the first link's path, or null.
function linkIn(dir) {
  try { if (fs.lstatSync(dir).isSymbolicLink()) return '.'; } catch { return null; }
  const walk = (d, rel) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) return r;
      if (e.isDirectory()) { const hit = walk(path.join(d, e.name), r); if (hit) return hit; }
    }
    return null;
  };
  return walk(dir, '');
}

const shown = (s) => String(s).replace(/\\/g, '/').replace(/[\u0000-\u001f\u007f]/g, '?'); // someone else's text: no control characters reach the terminal

/** The line a command prints when the project remembered a root outside the folder that holds it and that root was not used. '' when nothing was set aside. */
export const rootSetAsideNote = (p) => (p && p.rootSetAside && !p.rootKnown
  ? `This project remembers its code at ${shown(p.rootSetAside)}, outside the folder that holds the project, so Faultline did not read there. If that is right, pass  --source ${shown(p.rootSetAside)}`
  : '');

/** Stops with that note when the project remembers its code outside the folder that holds it and the person gave no --source: a command that reads the code asks, it does not read a guess. */
export function requireRoot(p) {
  const n = rootSetAsideNote(p);
  if (n) throw new CliError(n, 2);
}

/**
 * May a command copy lines of the code into what it writes (build --excerpts)? Yes when the person named the folder, or the folder is the one that holds the project or lies inside it.
 * No when a remembered root was set aside, and no when the folder is only where the person stands: a received project must not pick which files get copied.
 */
export function mayQuoteCode(p) {
  if (p.rootFrom === 'flag') return true;
  return !rootSetAsideNote(p) && holds(holderOf(p.dir), p.root);
}

/**
 * What a project folder holds: 'tool-map' (faultline map made it), 'hand' (a map written by hand, or its extract), 'unfinished' (faultline map began
 * and stopped before it wrote the facts: map/ or read/ exist and nothing else does), 'empty' (nothing a project writes).
 */
export function projectKind(dir) {
  if (!isDir(dir)) return 'missing';
  if (isToolMapProject(dir)) return 'tool-map';
  if (hasFragment(dir) || (isFile(path.join(dir, 'facts.json')) && isFile(path.join(dir, 'census.json')))) return 'hand';
  if (isDir(path.join(dir, 'map')) || isDir(path.join(dir, 'read'))) return 'unfinished';
  return 'empty';
}

const quoted = (x) => (/\s/.test(x) ? `"${x}"` : x);
const slashed = (x) => String(x).replace(/\\/g, '/');

/** Stops with the plain "no project" sentence unless `p` (from resolveProject) is a project a command can read: a tool map or one written by hand. */
export function requireProject(p, arg = null) {
  const kind = p.exists ? projectKind(p.dir) : 'missing';
  if (kind === 'tool-map' || kind === 'hand') return;
  throw new CliError(noProjectMessage(p, arg), 2);
}

/**
 * The plain sentence for "there is no project to work on", with the command that makes one. `p` is what resolveProject returned, `arg` the
 * --project the person typed (or null). The first words differ by case: a named folder that is not there, a folder that holds a map that was never finished, or nothing found.
 */
export function noProjectMessage(p, arg = null) {
  const into = arg ? ` --project ${quoted(arg)}` : '';
  const kind = p && p.dir ? projectKind(p.dir) : 'missing';
  if (kind === 'unfinished') {
    return `The project in ${slashed(p.dir)} was never finished: faultline map stopped before it wrote the facts. Fix: run  faultline map --source <the code folder>${into}  again.`;
  }
  if (arg && kind === 'missing') {
    return `The project folder ${slashed(path.resolve(arg))} does not exist. Fix: to map your code into it, run  faultline map --source <the code folder>${into}  (for a map written by hand: faultline init${into}).`;
  }
  if (arg) {
    return `${slashed(p.dir)} is a folder but holds no project. Fix: to map your code into it, run  faultline map --source <the code folder>${into}  (for a map written by hand: faultline init${into}).`;
  }
  return 'No project here: there is no .faultline folder in this folder or the folders above it. Fix: to map your code, run  faultline map --source <the code folder>  (for a map written by hand: faultline init).';
}

// facts.json stores its root as '..' steps (or null, or an older absolute path); the rest of the program reads the real folder on this machine, in memory only
const withRoot = (facts, dir) => { if (facts && typeof facts === 'object') facts.root = resolveRoot(facts.root, dir); return facts; };

export function readProject(dir) {
  return {
    facts: withRoot(readJson(path.join(dir, 'facts.json')), dir),
    census: readJson(path.join(dir, 'census.json')),
    signals: readJson(path.join(dir, 'signals.json'), null),
    graph: readJson(path.join(dir, 'graph.json')),
    dismissed: readJson(path.join(dir, 'dismissed.json'), {}) || {},
    config: readJson(path.join(dir, 'config.json'), {}) || {},
  };
}

/** Was this project folder made by  faultline map  (its model says so)? A map written by hand never has this mark. */
export function isToolMapProject(dir) {
  const s = readJson(path.join(dir, 'model', '00-system.json'));
  return !!(s && s.system && s.system.toolMap);
}

export const distDir = (dir) => path.join(dir, 'dist');
export const hasDist = (dir) => isFile(path.join(dir, 'dist', 'atlas.agent.json'));
export { isDir, isFile };

// A friendly error: message only, no stack, exit code 2 (usage) or 1 (refused)
export class CliError extends Error {
  constructor(msg, code = 1) { super(msg); this.code = code; this.cli = true; }
}
