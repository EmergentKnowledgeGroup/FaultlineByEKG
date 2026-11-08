// Shared parts of the agent commands: budgets, the deep link, resolving what an agent typed to boxes, and the plain level words.
import { tok } from '../build/util.mjs';

export const BUDGET = { brief: 1200, where: 600, breaks: 800, path: 400, impact: 500, status: 200 };

export function makeCtx(data, opts = {}) {
  const base = opts.linkBase || '.faultline/dist/atlas.html';
  const chartIds = new Set((data.charts || []).map((c) => c.id));
  const whole = (data.charts || []).find((c) => c.kind === 'whole');
  const wholeId = whole ? whole.id : 'overview';   // a map that draws no whole-system chart (one the tool read from the code) opens its overview, which every page has
  const enc = (s) => encodeURIComponent(s).replace(/%3A/g, ':').replace(/%2F/g, '/');
  const homeOf = (node) => (!whole && node && data.boxes && data.boxes[node] && chartIds.has(data.boxes[node].chart) ? data.boxes[node].chart : '');   // with no whole map, a box is opened on the chart that holds it
  const link = (chart, node, extra = '') => `${base}#chart=${enc(homeOf(node) || (chartIds.has(chart) ? chart : wholeId))}${node ? '&node=' + enc(node) : ''}${extra}`;
  const linkBox = (id) => link(data.boxes[id] ? data.boxes[id].chart : wholeId, id);
  return { data, link, linkBox, wholeId, budget: (cmd) => (opts.budget > 0 ? opts.budget : BUDGET[cmd]) };
}

// End the answer with its deep link; never exceed the budget (chars/4). A cut says how to get more, and the link line always survives.
export function finish(lines, linkLine, tokens, moreCmd) {
  const tail = 'open: ' + linkLine;
  let body = lines.filter((l) => l !== null && l !== undefined);
  const total = (b, note) => tok(b.join('\n') + (note ? '\n' + note : '') + '\n' + tail);
  if (total(body) <= tokens) return body.join('\n') + '\n' + tail;
  const note = (n) => `[cut ${n} line(s) at the ${tokens}-token budget. More: ${moreCmd}]`;
  let n = body.length;
  while (n > 1 && total(body.slice(0, n), note(body.length - n)) > tokens) n--;
  let text = body.slice(0, n).join('\n');
  if (n === 1 && total(body.slice(0, 1), note(body.length - 1)) > tokens) {            // one huge line: cut inside it
    const room = Math.max(40, tokens * 4 - note(0).length - tail.length - 4);
    text = text.slice(0, room) + '…';
  }
  return text + '\n' + note(body.length - n) + '\n' + tail;
}

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
const lastSeg = (s) => String(s).split('::').pop();

// what the agent typed -> boxes. Order: box id (short, or the long one of map/model.json), function id (path::Class.method), file[:line], bare function name, box title.
// A function's entry box comes first among the boxes that cite it. On a tool map a function with no box of its own is found too, and is answered as a function.
const entryFirst = (data, ids) => ids.map((id, i) => [id, i]).sort((a, b) => (data.boxes[a[0]].handle ? 0 : 1) - (data.boxes[b[0]].handle ? 0 : 1) || a[1] - b[1]).map((x) => x[0]);
const fnRows = (data, test) => ((data.toolMap && data.toolMap.fns) || []).filter(test);
export const ACCEPTED = 'a box id (f58.0, or the long id from map/model.json), a function number (f58), a function id (path/file.py::Class.method), a bare function name (Class.method or method), file or file:line (the function that line is in), or words from a box title';
export function resolve(data, q) {
  const raw = String(q || '').trim();
  if (!raw) return { kind: 'none', boxes: [], note: 'nothing given' };
  const ids = Object.keys(data.boxes);
  if (data.boxes[raw]) return { kind: 'box', boxes: [raw] };
  const al = data.alias && Object.prototype.hasOwnProperty.call(data.alias, raw) ? data.alias[raw] : null;
  if (al && data.boxes[al]) return { kind: 'box', boxes: [al], long: raw };
  const lc = raw.toLowerCase();
  const un = data.toolMap && data.toolMap.undrawn && Object.prototype.hasOwnProperty.call(data.toolMap.undrawn, raw) ? data.toolMap.undrawn[raw] : null;
  if (un !== null) {                                        // a box of the map the page draws no box for: say whose it is
    const row = fnRows(data, (x) => x[0] === un)[0];
    return { kind: 'function', boxes: [], ...(row ? { fnRow: row } : {}), note: `${raw} is a box in map/model.json that the page draws no box for${un ? `; it belongs to ${un}, which the page lists as an outline` : ''}` };
  }
  const exactCI = ids.filter((id) => id.toLowerCase() === lc);
  if (exactCI.length === 1) return { kind: 'box', boxes: exactCI };
  const citing = (pred) => ids.filter((id) => data.boxes[id].refs.some(pred));
  if (raw.includes('::')) {
    const hit = citing((r) => r[2] === raw || norm(r[2]) === norm(raw));
    if (hit.length) return { kind: 'function', boxes: entryFirst(data, hit), fn: raw };
    const row = fnRows(data, (x) => norm(x[0]) === norm(raw))[0];
    if (row) return { kind: 'function', boxes: [], fnRow: row, note: `${raw} has no box of its own on the map` };
  }
  const m = /^(.+?):(\d+)$/.exec(norm(raw));
  const file = m ? m[1] : norm(raw), line = m ? +m[2] : null;
  const files = Object.keys(data.fnRanges || {}), allFiles = new Set(ids.flatMap((id) => data.boxes[id].refs.map((r) => norm(r[0]))));
  const fileHit = [...allFiles].filter((f) => f === file || f.endsWith('/' + file));
  if (fileHit.length === 1 || (fileHit.length > 1 && fileHit.includes(file))) {
    const f = fileHit.includes(file) ? file : fileHit[0], inFile = citing((r) => norm(r[0]) === f);
    if (line == null) return { kind: 'file', boxes: inFile, file: f };
    const fns = (data.fnRanges[f] || data.fnRanges[files.find((x) => norm(x) === f)] || []).filter((x) => line >= x[0] && line <= x[1]).sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
    for (const fn of fns) {                                                   // innermost function first
      const hit = citing((r) => r[2] === fn[2]);
      if (hit.length) {
        const dist = (id) => Math.min(...data.boxes[id].refs.filter((r) => r[2] === fn[2]).map((r) => Math.abs((r[1] || line) - line)));
        return { kind: 'line', boxes: hit.sort((a, b) => dist(a) - dist(b)), file: f, line, fn: fn[2] };
      }
    }
    const near = inFile.slice().sort((a, b) => Math.min(...data.boxes[a].refs.map((r) => Math.abs((r[1] || 0) - line))) - Math.min(...data.boxes[b].refs.map((r) => Math.abs((r[1] || 0) - line))));
    return { kind: 'line', boxes: near.slice(0, 1), file: f, line, note: `line ${line} is in no function a box cites; nearest cited box shown` };
  }
  const inFns = data.toolMap && !line ? fnRows(data, (x) => norm(x[2]) === file || norm(x[2]).endsWith('/' + file)) : [];
  if (inFns.length) return { kind: 'file', boxes: [], fnRows: inFns, file, note: `${file} has functions the page lists as outlines, none with a box` };
  const sym = citing((r) => lastSeg(r[2]) === raw || lastSeg(r[2]).endsWith('.' + raw));
  if (sym.length) {
    const fns = [...new Set(sym.flatMap((id) => data.boxes[id].refs.filter((r) => lastSeg(r[2]) === raw || lastSeg(r[2]).endsWith('.' + raw)).map((r) => r[2])))];
    return { kind: 'symbol', boxes: entryFirst(data, sym), ...(fns.length > 1 ? { note: `${fns.length} functions are called ${raw}: ${fns.slice(0, 4).join(', ')}${fns.length > 4 ? ', ...' : ''}. The first is shown; give path::name to pick one` } : {}) };
  }
  const bare = fnRows(data, (x) => lastSeg(x[0]) === raw || lastSeg(x[0]).endsWith('.' + raw));
  if (bare.length) return { kind: 'function', boxes: [], fnRow: bare[0], note: `${raw} has no box of its own on the map${bare.length > 1 ? ` (${bare.length} functions are called that)` : ''}` };
  const suffix = ids.filter((id) => id.toLowerCase().endsWith('.' + lc) || id.toLowerCase().endsWith('_' + lc));
  if (suffix.length) return { kind: 'name', boxes: suffix };
  const title = ids.filter((id) => data.boxes[id].title.toLowerCase().includes(lc));
  if (title.length) return { kind: 'title', boxes: title };
  return { kind: 'none', boxes: [], note: `no box, function, file or title matches "${raw}"` };
}

// the plain level words (CONTRACTS section 8): drawn / candidate / seen / proved. Nothing unproven is called fine or safe.
export function levelOf(data, id) {
  const b = data.boxes[id], cands = (data.findings || []).filter((f) => f.shown && f.boxes.includes(id));
  const bits = [];
  if (b.level === 'proved') bits.push('proved' + (b.walkOutcomes ? ' ' + b.walkOutcomes.join('/') : ''));
  else if (b.level === 'seen') bits.push('seen' + (b.count ? ' x' + b.count : ''));
  else bits.push('drawn');
  if (b.stale) bits.push('STALE (code changed since the walk)');
  if (b.untested) bits.push('untested (cited code never ran)');
  if (b.anchorOnly) bits.push('line ran, nobody arrives');
  if (cands.length) bits.push('candidate: ' + cands.map((f) => f.check).join(', '));
  return bits.join('; ');
}

export const routeWords = (r) => (r.when ? `"${r.when}"` : 'always') + (r.inferred ? ' (inferred)' : '') + (r.type !== 'forward' ? ' [' + r.type + ']' : '');
export const stageTitle = (data, id) => ((data.stages || []).find((s) => s.id === id) || {}).title || id;
export { tok };
