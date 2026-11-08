// What the system is, in the project's own words, with where the words come from. Nothing found: say so.
import { clip, squash } from './util.mjs';

const README_NAMES = ['README.md', 'README.markdown', 'README.rst', 'README.txt', 'README', 'readme.md', 'Readme.md'];
const MODULE_PREFERENCE = ['__init__', 'index', 'main', 'app', 'cli', 'server', 'mod'];
const PURPOSE_MAX = 420;

/** The first paragraph of prose in a README: not a title, a badge, a link line, a table or a code block. */
export function readmeProse(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const paras = [];
  let cur = [];
  let fence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (line === '') {
      if (cur.length) paras.push(cur);
      cur = [];
      continue;
    }
    // titles, underlines, badges, images, html, tables, block quotes of links, bare links
    if (/^#{1,6}\s/.test(line) || /^[=\-~*_]{3,}$/.test(line) || /^!?\[!?\[/.test(line) || /^!\[/.test(line) || /^</.test(line) || /^\|/.test(line)) {
      if (cur.length) paras.push(cur);
      cur = [];
      continue;
    }
    if (/^\[[^\]]+\]:\s*\S+/.test(line) || /^https?:\/\/\S+$/.test(line)) continue;
    cur.push(line.replace(/^>\s?/, ''));
  }
  if (cur.length) paras.push(cur);
  for (const p of paras) {
    const t = squash(p.join(' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]{1,3}/g, ''));
    if (t.length >= 40 && t.split(/\s+/).length >= 8 && /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(t) && !/^(table of contents|contents|install|installation|usage|license|development snapshot|version|release|status|last updated|copyright|note\b)/i.test(t) && (t.match(/\d/g) ?? []).length / t.length < 0.12) return t;
  }
  return '';
}

function sentenceCut(t) {
  const m = /^(.{40,}?[.!?])(\s|$)/.exec(t);
  return clip(m ? m[1] : t, PURPOSE_MAX);
}

function fromPackageJson(text) {
  try {
    const d = JSON.parse(text);
    return typeof d.description === 'string' ? squash(d.description) : '';
  } catch {
    return '';
  }
}

function fromToml(text) {
  const sec = /^\s*\[(project|tool\.poetry|package)\]\s*$/m.exec(text);
  const body = sec ? text.slice(sec.index + sec[0].length) : text;
  const end = /^\s*\[/m.exec(body);
  const scope = end ? body.slice(0, end.index) : body;
  const m = /^\s*description\s*=\s*(?:"""([\s\S]*?)"""|"((?:[^"\\]|\\.)*)"|'([^']*)')/m.exec(scope);
  return m ? squash(m[1] ?? m[2] ?? m[3] ?? '') : '';
}

function fromCfg(text) {
  const m = /^\s*description\s*=\s*(.+)$/m.exec(text);
  return m ? squash(m[1]) : '';
}

/**
 * @param {import('./source.mjs').Source} source
 * @param {object|null} facts
 * @returns {{text:string|null, source:string|null, from:string|null, note:string}}
 */
export function findPurpose(source, facts) {
  for (const name of README_NAMES) {
    const t = source.rootText(name);
    if (t) {
      const p = readmeProse(t);
      if (p) return { text: sentenceCut(p), source: `From the project's README (${name})`, from: name, note: '' };
    }
  }
  const meta = [
    ['package.json', fromPackageJson, 'package.json'],
    ['pyproject.toml', fromToml, 'pyproject.toml'],
    ['Cargo.toml', fromToml, 'Cargo.toml'],
    ['setup.cfg', fromCfg, 'setup.cfg'],
  ];
  for (const [file, fn, label] of meta) {
    const t = source.rootText(file);
    const d = t ? fn(t) : '';
    if (d.length >= 12) return { text: clip(d, PURPOSE_MAX), source: `From the project's ${label} description`, from: file, note: '' };
  }
  const mods = (facts?.modules ?? []).filter((m) => m.doc && m.doc.length >= 30).map((m) => {
    const base = (m.path.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
    const pref = MODULE_PREFERENCE.indexOf(base);
    return { m, depth: m.path.split('/').length, pref: pref < 0 ? 99 : pref };
  });
  mods.sort((a, b) => a.depth - b.depth || a.pref - b.pref || (a.m.path < b.m.path ? -1 : 1));
  if (mods.length) {
    const m = mods[0].m;
    return { text: sentenceCut(squash(m.doc)), source: `From the top comment of ${m.path}`, from: m.path, note: '' };
  }
  return { text: null, source: null, from: null, note: 'No purpose statement was found: the README has no opening prose, there is no package description, and no top-level module has a docstring.' };
}

const GENERIC_FOLDERS = /^(?:repo|src|code|app|project|source|main|master|checkout|clone|work|tmp|mapped)$/i;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

function metadataName(source, dir) {
  const at = (n) => source.rootText(dir ? `${dir}/${n}` : n);
  const pj = at('package.json');
  if (pj) {
    try {
      const n = JSON.parse(pj).name;
      if (typeof n === 'string' && n.trim()) return n.replace(/^@[^/]+\//, '').trim();
    } catch { /* not JSON: ignore */ }
  }
  for (const f of ['pyproject.toml', 'Cargo.toml']) {
    const t = at(f);
    if (!t) continue;
    const sec = /^\s*\[(project|tool\.poetry|package)\]\s*$/m.exec(t);
    if (!sec) continue;
    const body = t.slice(sec.index + sec[0].length);
    const end = /^\s*\[/m.exec(body);
    const m = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(end ? body.slice(0, end.index) : body);
    if (m) return m[1].trim();
  }
  const cfg = at('setup.cfg');
  const sm = cfg ? /^\s*\[metadata\][\s\S]*?^\s*name\s*=\s*(\S.*)$/m.exec(cfg) : null;
  if (sm) return sm[1].trim();
  const co = at('composer.json');
  if (co) {
    try {
      const n = JSON.parse(co).name;
      if (typeof n === 'string' && n.trim()) return n.split('/').pop().trim();
    } catch { /* not JSON: ignore */ }
  }
  const gm = at('go.mod');
  const gmm = gm ? /^module\s+(\S+)/m.exec(gm) : null;
  if (gmm) return gmm[1].split('/').pop();
  return '';
}

/** The first heading of the README, as plain text, or ''. */
function readmeTitle(source) {
  for (const name of README_NAMES) {
    const t = source.rootText(name);
    if (!t) continue;
    const m = /^#\s+(.+?)\s*#*\s*$/m.exec(t.replace(/\r/g, ''));
    if (m) {
      const h = squash(m[1].replace(/<[^>]*>/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, ''));
      if (h && h.length <= 40) return h;
    }
  }
  return '';
}

/**
 * The project's name: from its package metadata (the root, else the folders just under it), written as its README heading writes it when
 * that heading is the same name; failing both, the name of the folder it was read from. Never a label from anyone's configuration.
 * @returns {{name:string, from:string}}
 */
export function findName(source) {
  let meta = metadataName(source, '');
  let where = 'package metadata';
  if (!meta) {
    for (const d of source.rootNames()) {
      if (/^(?:node_modules|\.git|docs?|tests?|examples?|scripts?|vendor)$/i.test(d) || d.startsWith('.') || source.isLink(d)) continue;     // a linked folder may lead out of the project
      meta = metadataName(source, d);
      if (meta) break;
    }
  }
  const title = readmeTitle(source);
  if (meta) {
    const first = norm(meta.split(/[-_.\s]/)[0]);
    if (title && first.length >= 3 && (norm(title).startsWith(first) || first.startsWith(norm(title))) && norm(title).length >= 3) return { name: title, from: 'the README heading (the same name as its package metadata)' };
    return { name: meta, from: where };
  }
  if (title) return { name: title, from: 'the README heading' };
  const folder = source.root ? source.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';       // the last name of the path, whichever way the machine writes its separators
  if (folder && !GENERIC_FOLDERS.test(folder)) return { name: folder, from: 'the name of the folder it was read from' };
  return { name: '', from: '' };
}
