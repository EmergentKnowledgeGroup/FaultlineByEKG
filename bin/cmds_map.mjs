// Commands for the tool map: setup, map, review (queue check view), story (check apply page).
//   map reads the code and writes a true map and a readable page with no agent. review and story work on what map wrote (<project>/map).
import fs from 'node:fs';
import path from 'node:path';
import { resolveProject, projectKind, CliError } from '../src/build/project.mjs';
import { parse } from './args.mjs';
import { plural } from '../src/build/util.mjs';

const out = (s = '') => console.log(s);
const rel = (p) => path.relative(process.cwd(), p).split(path.sep).join('/') || '.';
const abs = (p) => path.resolve(p).replace(/\\/g, '/');
const readJson = (file, what) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new CliError(`cannot read ${what} (${file}): ${e.message}`, 1); }
};
// The page and the text commands name a box f58.0; map/model.json, the review questions and the story check name it parcelworks.jobqueue.Queue.fail.s0.
// Both work in every command. Where a long id is printed, the short one is printed beside it.
function shortIds(projDir) {
  for (const [file, pick] of [['page/ask.json', (j) => j.ids], ['read/words.json', (j) => Object.fromEntries(Object.entries(j).filter(([, w]) => w && w.page).map(([k, w]) => [k, w.page]))]]) {
    try { return pick(JSON.parse(fs.readFileSync(path.join(projDir, file), 'utf8'))) || {}; } catch { /* try the next */ }
  }
  return {};
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** The short ids of the long box ids written in a piece of text, in order, each once. */
function shortsIn(text, ids) {
  const out = [];
  for (const raw of String(text ?? '').match(/[A-Za-z0-9_.$-]+/g) || []) {
    const t = raw.replace(/[-.]+$/, '');
    if (has(ids, t) && !out.includes(ids[t])) out.push(ids[t]);
  }
  return out;
}
/** Beside every long box id under the keys box, from and to, the short one (page, fromPage, toPage). Changes the object. */
function addShortIds(x, ids) {
  if (Array.isArray(x)) x.forEach((y) => addShortIds(y, ids));
  else if (x && typeof x === 'object') {
    for (const [k, name] of [['box', 'page'], ['from', 'fromPage'], ['to', 'toPage']]) if (typeof x[k] === 'string' && has(ids, x[k])) x[name] = ids[x[k]];
    for (const v of Object.values(x)) addShortIds(v, ids);
  }
  return x;
}
const write = (file, text) => { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, text, { encoding: 'utf8' }); };

export async function setup(argv) {
  const { o } = parse(argv, { str: ['dir'], bool: ['status'] });
  const { installTy, tyBinary, versionOf, toolsBase, oldToolsNote } = await import('../src/map/tools.mjs');
  const old = oldToolsNote(o.dir);
  if (o.status) {
    const exe = tyBinary(o.dir);
    out(exe ? `the Python type checker is installed: ${exe}` : `the Python type checker (ty) is not installed (looked in ${toolsBase(o.dir).replace(/\\/g, '/')}). Run  faultline setup.`);
    if (old) out(old);
    return exe ? 0 : 3;
  }
  const exe = await installTy(o.dir, out);
  const cache = path.join(toolsBase(o.dir), 'cache');
  fs.mkdirSync(cache, { recursive: true });
  out(`${exe} | ${await versionOf(exe, cache)}`);
  out(`tools folder: ${toolsBase(o.dir).replace(/\\/g, '/')}   (the tests find the checker only through FAULTLINE_TOOLS=<this folder>)`);
  if (old) out(old);
  out('Next: faultline map --source <your code folder>');
  return 0;
}

const inQuotes = (x) => (/\s/.test(x) ? `"${x}"` : x);

/** Words left over after the options of  faultline map: nearly always one path with a space in it that was not put in quotes. Says so, and names the quoted form when that folder exists. */
function refuseStrayWords(o, pos) {
  if (!pos.length) return;
  const last = o.source !== undefined ? ['source', o.source] : o.project !== undefined ? ['project', o.project] : null;
  const joined = last ? [last[1], ...pos].join(' ') : null;
  const exists = joined && fs.existsSync(path.resolve(joined));
  const quoteHint = last ? `If ${last[0] === 'source' ? 'the folder' : 'the project folder'} is called "${joined}", put the whole path in quotes:  faultline map --${last[0]} "${joined}"${exists ? '' : '  (that folder was not found either)'}.` : '';
  throw new CliError(`faultline map did not use the extra word${pos.length > 1 ? 's' : ''} ${pos.map((w) => `"${w}"`).join(' ')}. A path with a space in it needs quotes around it. ${quoteHint}`.trim(), 2);
}

/** A project folder this run made, or filled, is not left half-made when the run stops before it wrote a map: what the run added is taken out again. A folder that already held a project is left as it was. */
function undoHalfMade(dir, before) {
  try {
    if (!fs.existsSync(dir) || (before && before.size) || projectKind(dir) === 'tool-map') return;
    if (before === null) { fs.rmSync(dir, { recursive: true, force: true }); return; }
    for (const name of fs.readdirSync(dir)) if (!before.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  } catch { /* a file in use: the next command says the project was never finished */ }
}

// What  faultline map  says when it stops on purpose (nothing to read, a folder that is not there): one line, no stack, and where the person can go next.
const PLAIN_STOPS = /^(nothing to read|the source folder|.* holds a map written by hand)/;

export async function map(argv) {
  const { pos, o } = parse(argv, {
    str: ['source', 'name', 'config', 'typescript', 'tsconfig', 'lua', 'tools', 'interpreter', 'work'],
    rep: ['python', 'python-exclude', 'ts-exclude'], bool: ['no-page', 'quiet'],
  });
  const source = o.source || o.root;
  if (!source) {
    const hint = pos.length ? `  Did you mean:  faultline map --source ${inQuotes(pos.join(' '))}` : '';
    throw new CliError(`Usage: faultline map --source <folder with the code> [--project DIR] [--no-page]${hint}`, 2);
  }
  refuseStrayWords(o, pos);
  // --project may name the folder that holds .faultline: that is the project, as for every other command
  const project = o.project ? resolveProject({ project: o.project }).dir : path.join(process.cwd(), '.faultline');
  const { mapToPage } = await import('../src/read/page/run.mjs');
  const { tyBinary, oldToolsNote } = await import('../src/map/tools.mjs');
  if (!o.quiet && !tyBinary(o.tools)) { const old = oldToolsNote(o.tools); if (old) out(old); }
  const t0 = performance.now();
  const before = fs.existsSync(project) ? new Set(fs.readdirSync(project)) : null;
  let r;
  try { r = await mapToPage({ ...o, source, project }, out); } catch (e) {
    undoHalfMade(project, before);
    if (!e || e.cli || !PLAIN_STOPS.test(String(e.message))) throw e;
    const docs = await docFolderNote(source);
    throw new CliError(`${e.message}${docs ? `. ${docs[0].toUpperCase()}${docs.slice(1)}` : ''}`, 1);
  }
  if (o.quiet) { out(r.line); if (r.page) out(`page: ${rel(r.page)}`); return 0; }
  const docs = await docFolderNote(source);
  if (docs) out(`note: ${docs}`);
  const t = r.times;
  out(`times (seconds): ${Object.entries(t).map(([k, v]) => `${k} ${v}`).join(', ')}; ${((performance.now() - t0) / 1000).toFixed(1)} in all`);
  out(`map files: ${rel(r.files.map)}/ (model.json claims.json review-index.json story-index.json calls.json)   reading: ${rel(r.files.read)}/`);
  if (r.page) {
    out(`page: ${rel(r.page)} (${(r.pageBytes / 1048576).toFixed(2)} MB)${r.hardLeft ? `; ${r.hardLeft} chart(s) still have a hard layout defect` : ''}`);
    out('Open it in a browser, or ask for a small text view:  faultline brief   faultline breaks   faultline where <name>');
  } else out(`stopped before the page (--no-page). The page project is in ${rel(r.files.project)}; run  faultline map  again without --no-page to place and build it.`);
  return 0;
}

/** One sentence when the source folder has documentation folders that were not read (they are skipped by default), else ''. */
async function docFolderNote(source) {
  try {
    const { docFoldersSkipped } = await import('../src/extract/walk.mjs');
    const list = docFoldersSkipped(path.resolve(source));
    if (!list.length) return '';
    const names = list.map((d) => `${d.dir}/ (${d.files} code file${d.files === 1 ? '' : 's'})`).join(', ');
    const from = abs(source).replace(/\/+$/, '');
    return `documentation folders are not read by default: ${names}. They describe the system and are not part of it. To map one, give it as the source:  faultline map --source ${inQuotes(`${from}/${list[0].dir}`)}`;
  } catch { return ''; }
}

// The folder the map was made from: --source, else what the project remembers. A project on another drive cannot remember it as a relative path, so the code is looked for and, when it is not there, the person is asked.
function sourceRoot(o, p, dir) {
  const root = abs(o.source || o.root || p.root);
  let first = null;
  try { first = JSON.parse(fs.readFileSync(path.join(dir, 'review-index.json'), 'utf8')).mods?.[0] ?? null; } catch { /* no index: the commands say so themselves */ }
  if (first && !fs.existsSync(path.join(root, first))) throw new CliError(`The code this map was made from is not under ${root}. Pass --source <the folder you gave to faultline map>.`, 2);
  return root;
}

// ---- review: the work-list for an agent, and the gate that re-checks its answers ----------------------------------------------------
async function mapContext(o) {
  const p = resolveProject({ project: o.project, root: o.source || o.root });
  const dir = o.map ? abs(o.map) : abs(path.join(p.dir, 'map'));
  if (!fs.existsSync(path.join(dir, 'model.json'))) throw new CliError(`No tool map in ${dir}. Fix: run  faultline map --source <folder>  first, or pass --map DIR.`, 2);
  return { p, dir, root: sourceRoot(o, p, dir), ids: shortIds(p.dir) };
}

export async function review(argv) {
  const [command, ...rest] = argv;
  if (!['queue', 'check', 'view'].includes(command)) throw new CliError('Usage: faultline review <queue|check|view> [--limit N] [--out FILE] [--answers FILE] [--store FILE] [--without-agent] [--map DIR] [--source DIR]', 2);
  const { o } = parse(rest, { str: ['map', 'source', 'limit', 'out', 'answers', 'store'], bool: ['without-agent'] });
  const { buildItems, order, reviewView, SCHEMA_Q, Src } = await import('../src/map/review.mjs');
  const { checkAnswer, view, reviewText } = await import('../src/map/review_check.mjs');
  const { fileDigest, StaleInput } = await import('../src/map/files.mjs');
  const { cpSlice } = await import('../src/map/pyrt.mjs');
  const { dir, root, ids } = await mapContext(o);
  const model = readJson(path.join(dir, 'model.json'), 'the model');
  const claims = readJson(path.join(dir, 'claims.json'), 'the claims');
  const index = readJson(path.join(dir, 'review-index.json'), 'the review index');
  try {
    if (fileDigest(root, index.mods) !== index.source_digest) throw new StaleInput(`the sources under ${root} changed after this map was built; run  faultline map  again`);
  } catch (e) {
    if (e instanceof StaleInput) throw new CliError(e.message, 1);
    throw e;
  }
  const map = reviewView(model, index);
  const store = o.store ?? path.join(dir, 'review-checked.json');
  const system = model.system.name;
  if (command === 'queue') {
    const items = order(buildItems(map, claims, root)).map((it) => ({ ...it, ...(shortsIn(it.item, ids).length ? { page: shortsIn(it.item, ids) } : {}) }));
    const nc = claims.filter((c) => c.conf === 'not-confident').length;
    out(`${system}: ${plural(claims.length, 'claim')}, ${nc} not confident, ${plural(items.length, 'question')} (${(100 * items.length / claims.length).toFixed(1)}% of all claims)`);
    for (const it of items.slice(0, Number(o.limit ?? 20))) {
      out(`\n#${it.rank} [${it.tier}] ${it.item}${it.page ? `   (box ${it.page.join(', ')} on the page)` : ''}\n  Q: ${it.question}\n  answers: ${it.answers.join(' | ')}`);
      for (const l of it.lines.slice(0, 6)) out(`    ${l.path}:${l.line} | ${cpSlice(l.text, 0, 110)}`);
    }
    if (o.out) write(o.out, reviewText({ schema: SCHEMA_Q, system, items }));
  } else if (command === 'check') {
    if (!o.answers) throw new CliError('review check needs --answers FILE', 2);
    const items = new Map(buildItems(map, claims, root).map((i) => [i.item, i]));
    const byId = new Map(claims.map((c) => [c.id, c]));
    const src = new Src(root);
    const ans = readJson(o.answers, 'the answers');
    const results = ans.answers.map((x) => checkAnswer(items.get(x.item) ?? null, x, src, byId));
    write(store, reviewText({ schema: 'faultline.review-checked/1', system, results }));
    const tally = {};
    for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
    out(`${JSON.stringify(tally)} -> ${store}`);
  } else {
    const results = fs.existsSync(store) ? readJson(store, 'the checked answers').results : [];
    const v = view(claims, results, !o['without-agent']).map((c) => { const sh = shortsIn(`${c.subject ?? ''} ${c.id ?? ''}`, ids); return sh.length ? { ...c, page: sh } : c; });
    if (o.out) { write(o.out, reviewText(v)); out(plural(v.length, 'claim')); } else out(reviewText(v));
  }
  return 0;
}

// ---- story: an agent's map, checked against the tool map ------------------------------------------------------------------------------
export async function story(argv) {
  const [command, ...rest] = argv;
  const usage = 'Usage: faultline story check --story <file|folder> [--out FILE] [--allow-stale]\n       faultline story apply --words <file> [--out FILE] [--report FILE]\n       faultline story page [--check FILE] [--page atlas.html] [--out FILE]\n(all take --project DIR; check also --map DIR --source DIR)';
  if (!['check', 'apply', 'page'].includes(command)) throw new CliError(usage, 2);
  const { o } = parse(rest, { str: ['story', 'map', 'source', 'out', 'words', 'report', 'check', 'page'], bool: ['allow-stale'] });
  const { canonJson } = await import('../src/story/canon.mjs');
  const refuse = (list) => { for (const r of list) console.error(`REFUSE ${r.code}: ${r.msg}${r.at ? ` (${r.at})` : ''}`); };
  const p = resolveProject({ project: o.project, root: o.source || o.root });
  const ids = shortIds(p.dir);
  const mapDir = o.map ? abs(o.map) : abs(path.join(p.dir, 'map'));
  const storyDir = path.join(p.dir, 'story');
  if (command === 'check') {
    if (!o.story) throw new CliError(usage, 2);
    const { loadStory } = await import('../src/story/load.mjs');
    const { checkStory, MapError } = await import('../src/story/check.mjs');
    const outFile = o.out || path.join(storyDir, 'check.json');
    const { story: st, refusals } = loadStory(o.story);
    if (refusals.length) { refuse(refusals); write(outFile, canonJson({ schema: 'faultline.story-check/2', refused: refusals })); return 3; }
    let res;
    try { res = checkStory(st, { mapDir, root: sourceRoot(o, p, mapDir), allowStale: !!o['allow-stale'] }); } catch (e) {
      if (e instanceof MapError) { console.error(`REFUSE M-map: ${e.message}`); return 4; }
      throw e;
    }
    write(outFile, canonJson(res.refused ? res : addShortIds(res, ids)));
    if (res.refused) { refuse(res.refused); return 4; }
    out(res.summary.header);
    out(`marked: ${plural(res.summary.marked.roads, 'road')}, ${plural(res.summary.marked.boxes, 'box', 'boxes')}   (${rel(outFile)})`);
    return 0;
  }
  if (command === 'apply') {
    if (!o.words) throw new CliError(usage, 2);
    const { applyWords, APPLY_SCHEMA } = await import('../src/story/apply.mjs');
    const { MapError } = await import('../src/story/check.mjs');
    let words;
    try { words = JSON.parse(fs.readFileSync(o.words, 'utf8')); } catch (e) { refuse([{ code: 'A-read', msg: `cannot read the words file: ${String(e.message).slice(0, 80)}`, at: '' }]); return 3; }
    let res;
    try { res = applyWords(mapDir, words); } catch (e) {
      if (e instanceof MapError) { console.error(`REFUSE M-map: ${e.message}`); return 4; }
      throw e;
    }
    if (o.report) write(o.report, canonJson(res.report));
    const r = res.report;
    out(`${APPLY_SCHEMA}: ${r.wordsAccepted} fields accepted, ${r.wordsRefused} refused, ${r.forbidden} not words, ${r.claimsRefused} roads refused; structure changed: ${r.structureChanged}`);
    if (r.overlayRefused) { refuse(r.refusals.slice(0, 5).map((m) => ({ code: 'A-refused', msg: m, at: '' }))); return 3; }
    write(o.out || path.join(storyDir, 'model.json'), canonJson(res.model));
    return 0;
  }
  const { buildPage } = await import('../src/story/page.mjs');
  const checkFile = o.check || path.join(storyDir, 'check.json');
  const pageFile = o.page || path.join(p.dir, 'dist', 'atlas.html');
  const outFile = o.out || path.join(p.dir, 'dist', 'atlas.story.html');
  const r = buildPage(checkFile, pageFile);
  write(outFile, r.html);
  out(`page written: ${rel(outFile)} (${r.html.length} bytes; overlay data ${r.dataBytes} bytes; ${plural(r.nRoads, 'road')}, ${plural(r.nBoxes, 'box', 'boxes')})`);
  return 0;
}
