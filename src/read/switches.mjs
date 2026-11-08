// What is off by default: decisions that test an option, a config value, a flag, an environment variable or an enabled-style name,
// each with where it is tested and the literal default when the code shows one ("default not read" when it does not).
import { cmp, squash, tally, langOf } from './util.mjs';

const OPTION_ROOTS = '(?:opts?|options|config|cfg|settings|flags|features|conf)';
const PATH_RE = new RegExp(`(?<![\\w$.])(?:(?:this|self)\\s*\\??\\.\\s*)?(${OPTION_ROOTS}(?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*)+)`, 'g');
const ENV_RES = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
  /os\.environ(?:\.get)?\s*[([]\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  /(?:os\.)?getenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
];
const FLAG_SNAKE = /^(?:is_)?(?:enable[ds]?|disable[ds]?|skip|auto_?[a-z0-9_]*|use_[a-z0-9_]+|allow_?[a-z0-9_]*|no_[a-z0-9_]+|dry_?run|debug|verbose|feature_?[a-z0-9_]*|flag_?[a-z0-9_]*)$|_(?:enabled|disabled|enable|disable)$/;
const FLAG_CAMEL = /^(?:is)?(?:[Ee]nable[ds]?|disable[ds]?|skip[A-Z]\w*|skip|autorun|auto[A-Z]\w*|use[A-Z]\w*|allow[A-Z]?\w*|no[A-Z]\w*|dryRun|debug|verbose|feature[A-Z]\w*|flag[A-Z]\w*)$|(?:Enabled|Disabled)$/;
const isFlagName = (tail) => FLAG_SNAKE.test(tail) || FLAG_CAMEL.test(tail);
const LITERAL = String.raw`(true|false|True|False|None|null|undefined|-?\d+(?:\.\d+)?(?:e\d+)?|"[^"\n]{0,40}"|'[^'\n]{0,40}')`;
// a name, an optional type written after it (no comma outside brackets: `{ a: x, b: true }` gives b, never a), then `:` or `=` and a plain value
const TYPE_ANNOTATION = String.raw`(?::\s*[\w.|?]+(?:\[[^\]]*\]|<[^<>]*>)?(?:\s*\|\s*[\w.]+)*)?`;
const ASSIGN_RE = new RegExp(String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*${TYPE_ANNOTATION}\s*[:=]\s*${LITERAL}\s*[,;)}]*\s*(?:#.*|//.*)?$`);
const COALESCE_RE = new RegExp(String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\?|\|\|)\s*${LITERAL}(?![\w$])`, 'g');
const ENV_DEFAULT_RES = [
  new RegExp(String.raw`process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\?\?|\|\|)\s*${LITERAL}`, 'g'),
  new RegExp(String.raw`os\.environ\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*,\s*${LITERAL}`, 'g'),
  new RegExp(String.raw`getenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*,\s*${LITERAL}`, 'g'),
];

export const CANNOT_SEE = [
  'It reads only decisions whose test names an option, config value, flag, environment variable or an enabled/disabled-style name.',
  'It does not see options that are only passed along without a decision, values set by command-line arguments, or settings changed while the program runs.',
  'A default is shown only when the code writes it as a plain literal next to the name; computed defaults and defaults in another language or a config file are "default not read".',
];

const OFF_VALUES = new Set(['false', 'False', 'None', 'null', 'undefined', '0', '""', "''"]);
const ON_VALUES = new Set(['true', 'True', '1']);

/** Names a test refers to that look like switches: [{name, kind}] */
export function switchNamesIn(test) {
  const out = [];
  const t = test ?? '';
  for (const m of t.matchAll(PATH_RE)) out.push({ name: m[1].replace(/\s+/g, '').replace(/\?\./g, '.'), kind: 'option' });
  for (const re of ENV_RES) for (const m of t.matchAll(re)) out.push({ name: m[1], kind: 'env' });
  for (const m of t.matchAll(/(?<![\w$])((?:(?:this|self)\.)?(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)/g)) {
    const full = m[1];
    const tail = full.split('.').pop();
    if (isFlagName(tail) && !out.some((o) => o.name.endsWith(tail))) out.push({ name: full.replace(/^(?:this|self)\./, ''), kind: 'flag' });
  }
  const seen = new Set();
  return out.filter((o) => (seen.has(o.name) ? false : seen.add(o.name)));
}

/** The default-value index of the source: name -> [{path, line, literal, env}]. */
function buildDefaultIndex(W, paths) {
  const idx = new Map();
  const add = (name, rec) => {
    if (!idx.has(name)) idx.set(name, []);
    const a = idx.get(name);
    if (a.length < 16) a.push(rec);
  };
  for (const p of paths) {
    const f = W.source.file(p);
    if (!f) continue;
    for (let n = 1; n <= f.lineCount; n++) {
      const line = f.line(n);
      if (line.length > 300 || /^\s*(?:\/\/|#|\*|--|\/\*)/.test(line)) continue;
      let m = ASSIGN_RE.exec(line);
      const at = { path: p, lang: langOf(p) };
      if (m) add(m[1], { ...at, line: n, literal: m[2], ...blockAbove(f, n), text: line.toLowerCase() });
      COALESCE_RE.lastIndex = 0;
      for (m of line.matchAll(COALESCE_RE)) add(m[1], { ...at, line: n, literal: m[2], ...blockAbove(f, n), text: line.toLowerCase() });
      for (const re of ENV_DEFAULT_RES) for (m of line.matchAll(re)) add(m[1], { ...at, line: n, literal: m[2], env: true, block: '', inClass: false });
    }
  }
  return idx;
}

/** The nearest block above a line that is indented less than it (an object, a class, a function): {block: its name in lower case, inClass: it is a class}. */
function blockAbove(f, n) {
  const ind = (t) => t.length - t.trimStart().length;
  const here = ind(f.line(n));
  for (let k = n - 1; k >= Math.max(1, n - 60); k--) {
    const t = f.line(k);
    if (!t.trim() || ind(t) >= here) continue;
    const m = /^\s*(?:export\s+)?(?:const|let|var|class|interface|type|def|function|public|private|readonly|static|async\s+def)?\s*([A-Za-z_$][\w$]*)/.exec(t);
    return { block: m ? m[1].toLowerCase() : '', inClass: /^\s*(?:export\s+)?(?:abstract\s+)?class\b/.test(t) };
  }
  return { block: '', inClass: false };
}

function stateOf(tail, literal) {
  const enable = /(^|[._])(is_?)?(enable[ds]?|use_?\w*|allow\w*|auto\w*)$|enabled$/i.test(tail);
  const disable = /(disable[ds]?|skip\w*|^no[A-Z_]\w*)$/i.test(tail);
  if (!enable && !disable) return null;
  if (OFF_VALUES.has(literal)) return enable ? true : false;
  if (ON_VALUES.has(literal)) return enable ? false : true;
  return null;
}

/**
 * @returns {{items: object[], count: number, withDefault: number, notRead: number, offByDefault: number, cannotSee: string[]}}
 */
export function findSwitches(W, words) {
  const uses = new Map();
  const paths = new Set();
  for (const fid of W.mappedIds) {
    const f = W.fns.get(fid);
    paths.add(f.path);
    for (const b of f.boxes) {
      if (b.kind !== 'decision' || b.prov.rule === 'loop') continue;
      const full = words.get(b.id)?.full ?? b.detail ?? b.title;
      const names = switchNamesIn(full);
      for (const nm of names) {
        const key = nm.name;
        if (!uses.has(key)) uses.set(key, { name: key, kind: nm.kind, uses: [] });
        const neg = new RegExp(`!\\s*(?:this\\.|self\\.)?${key.replace(/[.$]/g, '\\$&')}\\b|\\bnot\\s+(?:self\\.)?${key.replace(/[.$]/g, '\\$&')}\\b`).test(full.replace(/\?\./g, '.'));   // `!opts?.flag` is the same test as `!opts.flag`
        uses.get(key).uses.push({ path: f.path, line: b.prov.line, fn: fid, box: b.id, test: squash(full), negated: neg });
      }
    }
  }
  const index = buildDefaultIndex(W, [...paths].sort(cmp));
  // the scanner's own list of config, constants and environment reads, when it was given
  const factsDefault = new Map();
  for (const s of W.facts?.switches ?? []) {
    if (s.default === null || s.default === undefined || s.default === '') continue;
    if (!factsDefault.has(s.name)) factsDefault.set(s.name, { path: s.path, line: s.line, literal: String(s.default) });
  }
  const items = [];
  for (const key of [...uses.keys()].sort(cmp)) {
    const u = uses.get(key);
    const tail = key.split('.').pop();
    // a default belongs to this switch only when it is written in the same language, and, for an option reached through an owner
    // (config.features.labels), not a field of some class that has nothing to do with the owner (a class field `delay = 0` is not `opts.delay`)
    const langs = new Set(u.uses.map((x) => langOf(x.path)));
    const owner = key.includes('.') ? key.split('.').slice(-2, -1)[0].toLowerCase() : '';
    let recs = (index.get(tail) ?? []).filter((r) => (u.kind === 'env' ? r.env : langs.has(r.lang) && (!owner || r.block.includes(owner) || (r.text ?? '').includes(owner) || !r.inClass)));
    if (!recs.length && factsDefault.has(tail) && langs.has(langOf(factsDefault.get(tail).path)) && (!owner || u.uses.some((x) => x.path === factsDefault.get(tail).path))) recs = [factsDefault.get(tail)];   // the scanner's default counts when it is in a file that tests the option
    const distinct = [...new Set(recs.map((r) => r.literal))];
    let def = null;
    let note = 'default not read';
    if (distinct.length === 1) {
      def = { literal: distinct[0], path: recs[0].path, line: recs[0].line };
      note = '';
    } else if (distinct.length > 1) {
      note = `default not read: the code gives several values (${distinct.slice(0, 4).join(', ')})`;
    } else if (u.kind === 'env') {
      note = 'default not read: an environment variable, set outside the code';
    } else if ((index.get(tail) ?? []).length) {
      note = 'default not read: the name is written with a value elsewhere, but not where this option is read from';
    }
    const off = def ? stateOf(tail, def.literal) : null;
    const falsy = !!def && OFF_VALUES.has(def.literal);
    items.push({
      defaultIs: !def ? 'unread' : off === true ? 'off' : falsy ? 'falsy' : ON_VALUES.has(def.literal) ? 'on' : 'value',
      name: key, kind: u.kind, uses: u.uses.sort((a, b) => cmp(a.path, b.path) || a.line - b.line).slice(0, 12), useCount: u.uses.length,
      default: def, note, offByDefault: off,
    });
  }
  items.sort((a, b) => b.useCount - a.useCount || cmp(a.name, b.name));
  const byKind = Object.fromEntries(tally(items, (i) => i.kind));
  return {
    items, count: items.length, withDefault: items.filter((i) => i.default).length, notRead: items.filter((i) => !i.default).length,
    offByDefault: items.filter((i) => i.offByDefault === true).length, defaultFalsy: items.filter((i) => i.defaultIs === 'falsy').length, defaultOn: items.filter((i) => i.defaultIs === 'on').length,
    byKind, cannotSee: CANNOT_SEE,
  };
}
