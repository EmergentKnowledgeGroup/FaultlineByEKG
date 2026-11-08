// After `faultline build`: rewrites the page's data (folded stage list, who hears, questions, not-confident marks, the tool-map banner) and adds the Reader.
// atlas.html as built is first copied to atlas.plain.html; the result is atlas.html. Running it again starts from the plain copy, so it is idempotent.
import fs from 'node:fs';
import path from 'node:path';
import { packReading } from './pack.mjs';
import { cmp } from '../util.mjs';
import { plural } from '../../build/util.mjs';
import { buildBreaks } from './agentx.mjs';

export { buildBreaks };

export const SMALL_FUNCTION_BOXES = 2;   // functions of this many boxes or fewer are folded behind a count in the chart list
const DATA_TAG = /<script type="application\/json" id="atlas-data">([\s\S]*?)<\/script>/;
const MARK = '<!--rl-injected-->';
/** The off-by-default answer in one line, with "default false" kept apart from "off". */
export function switchLine(sw) {
  const value = Math.max(0, sw.found - sw.offByDefault - sw.defaultFalsy - sw.defaultOn - sw.defaultNotRead);   // a default that is a number or a text: neither on nor off, so it is said, and the parts add up to the whole
  return `${sw.found} switches found: ${sw.offByDefault} off by default, ${sw.defaultFalsy} default to false or none without the name saying that means off, ${sw.defaultOn} default to on, ${value ? `${value} default to a value that is neither on nor off, ` : ''}${sw.defaultNotRead} have no default the tool could read.`;
}

export const PROVEN_WHY = 'A road the tool is sure of.';
const json = (v) => JSON.stringify(v).replace(/<\//g, '<\\/');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** The chart list: one folded group per stage, a row per function (its parts together, in number order), small functions behind a count. */
export function buildNav(atlas, charts) {
  const fnByFid = new Map(charts.functions.map((f) => [f.fid, f]));
  const rowsBy = new Map(atlas.stages.map((s) => [s.id, []]));
  for (const c of charts.charts) {
    const fn = fnByFid.get(c.fid);
    const ids = c.parts.map((p) => p.id).filter((id) => atlas.charts[id]);
    if (!ids.length || !rowsBy.has(c.district)) continue;
    rowsBy.get(c.district).push({ id: ids[0], parts: ids, label: fn.label, boxes: fn.boxes });
  }
  const nav = [{ group: 'Start here', items: ['overview'] }];
  for (const s of atlas.stages) {
    const rows = rowsBy.get(s.id).sort((a, b) => cmp(a.label.toLowerCase(), b.label.toLowerCase()) || cmp(a.id, b.id));
    if (!rows.length) continue;
    const big = rows.filter((r) => r.boxes > SMALL_FUNCTION_BOXES);
    const small = rows.filter((r) => r.boxes <= SMALL_FUNCTION_BOXES);
    nav.push({ group: s.title, stage: s.id, fold: true, rows: big, small, items: big.concat(small).flatMap((r) => r.parts) });
  }
  return nav;
}

/** Leaves out what the page never reads: empty fields, a summary that repeats the plain text, the default "proven" reason on a road. The page stays under its size limit. */
export function trimAtlas(atlas) {
  for (const ch of Object.values(atlas.charts)) {
    if (ch.kind !== 'detail') continue;
    for (const n of Object.values(ch.nodes)) {
      for (const k of ['inputs', 'outputs']) if (Array.isArray(n[k]) && !n[k].length) delete n[k];
      for (const k of ['failure', 'switch', 'outcome', 'handle']) if (n[k] === '') delete n[k];
      if (n.summary === n.plain) delete n.summary;
      if (n.family === n.stage) delete n.family;
      if (n.status === 'live') delete n.status;
      if (!n.why) delete n.why;
    }
    for (const e of Object.values(ch.edges)) {
      if (e.short === e.label) delete e.short;
      if (Array.isArray(e.refs) && !e.refs.length) delete e.refs;
      if (e.inferred === false) delete e.inferred;
      if (e.why === PROVEN_WHY) delete e.why;
      const from = ch.nodes[e.from];
      if (Array.isArray(e.refs) && e.refs.length === 1 && from?.refs?.length && e.refs[0].path === from.refs[0].path && e.refs[0].line === from.refs[0].line) delete e.refs;   // the road's source is the box it leaves
    }
  }
}

/** The order of "Next chart": the overview, then the charts a journey passes through, the main path first, then the rest in the chart list's order. */
export function journeyChartOrder(atlas, rl) {
  const out = ['overview'];
  const seen = new Set(out);
  const add = (id) => { if (id && atlas.charts[id] && !seen.has(id)) { seen.add(id); out.push(id); } };
  const partsOfChart = new Map();
  for (const g of atlas.nav) if (g.fold) for (const r of [...g.rows, ...g.small]) for (const p of r.parts) partsOfChart.set(p, r.parts);
  const js = [...rl.journeys].sort((a, b) => (a.id === rl.rank?.main?.id ? -1 : 0) - (b.id === rl.rank?.main?.id ? -1 : 0));
  for (const j of js) for (const st of j.steps) if (st.c) for (const p of partsOfChart.get(st.c) ?? [st.c]) add(p);
  for (const g of atlas.nav.slice(1)) for (const id of g.items) add(id);
  return out;
}

export function injectPage({ readDir, projDir, readerDir }) {
  const dist = path.join(projDir, 'dist');
  const html = path.join(dist, 'atlas.html');
  const plain = path.join(dist, 'atlas.plain.html');
  const cur = fs.readFileSync(html, 'utf8');
  if (cur.includes(MARK)) { if (!fs.existsSync(plain)) throw new Error('atlas.html already has the reader and there is no atlas.plain.html: run faultline build again'); } else fs.copyFileSync(html, plain);
  const src = fs.readFileSync(plain, 'utf8');
  const m = DATA_TAG.exec(src);
  const atlas = JSON.parse(m[1]);
  const reading = read(path.join(readDir, 'reading.json'));
  const charts = read(path.join(readDir, 'charts.json'));
  const words = read(path.join(readDir, 'words.json'));
  const side = read(path.join(projDir, 'page', 'side.json'));
  side.pageOfRef = Object.fromEntries(Object.entries(words).filter(([, w]) => w.page).map(([k, w]) => [k, w.page]));

  const rl = packReading({ reading, charts, side });
  const fnById = new Map(charts.functions.map((f) => [f.fid, f]));
  const entryBoxOf = new Map();
  const info = new Map();
  for (const c of charts.charts) for (const p of c.parts) for (const b of p.boxes) {
    info.set(b.id, b);
    if (b.entry && b.shape === 'own') entryBoxOf.set(c.fn, b.id);
  }

  // nodes and roads carry their function, their shape and, when the tool is not confident, why
  let ncBoxes = 0;
  let ncRoads = 0;
  for (const ch of Object.values(atlas.charts)) {
    if (ch.kind !== 'detail') continue;
    let nb = 0;
    let nr = 0;
    for (const [id, n] of Object.entries(ch.nodes)) {
      const b = info.get(id);
      n.fn = id.split('.')[0];
      if (b) { n.shape = b.shape; if (b.shape === 'card' && b.raw && fnById.has(b.raw)) n.target = fnById.get(b.raw).id; if (b.outcome === 'mixed') n.outcome = 'mixed'; }
      const why = side.notConfident.boxes[id];
      if (why) { n.nc = why; nb++; }
    }
    for (const [id, e] of Object.entries(ch.edges)) { const why = side.notConfident.roads[id]; if (why) { e.nc = why; nr++; } }
    if (nb || nr) ch.ncCount = { boxes: nb, roads: nr };
    ncBoxes += nb; ncRoads += nr;
  }
  rl.conf = { boxes: ncBoxes, roads: ncRoads };

  atlas.nav = buildNav(atlas, charts);
  atlas.journeyOrder = journeyChartOrder(atlas, rl);
  atlas.sections = [{ id: 'sec_start', title: 'The big picture', charts: ['overview'] }, ...atlas.nav.slice(1).map((g) => ({ id: `sec_${g.stage}`, title: g.group, charts: g.items }))];
  atlas.breaks = buildBreaks(reading, charts.functions, entryBoxOf);
  atlas.findings = atlas.breaks.map((b) => ({ key: b.key, check: b.check, boxes: b.boxes }));
  if (atlas.evidence) atlas.evidence.findings = [];
  trimAtlas(atlas);
  // the stage overview: no claim of a run order, and its ending groups say they count the ending boxes drawn, which is not the reading's count of endings in the code
  const ov = atlas.charts.overview;
  if (ov?.flow) ov.flow.blurb = 'Start here: the stages (largest first, not in the order they run) and the ways the system ends.';
  for (const nd of Object.values(ov?.nodes ?? {})) {
    if (nd.synth !== 'outcome') continue;
    const k = nd.outcome ? nd.outcome[0].toUpperCase() + nd.outcome.slice(1) : 'Other';
    nd.title = `${k} ${(reading.numbers.endings.byOutcome[nd.outcome] ?? 0) === 1 ? 'ending' : 'endings'}`;
    const drawn = Array.isArray(nd.boxes) ? nd.boxes.length : 0;
    nd.plain = `${plural(drawn, 'ending box', 'ending boxes')} drawn on the charts ${drawn === 1 ? 'has' : 'have'} the outcome ${nd.outcome}. That is a count of boxes. The reading counts something else: ${plural(reading.numbers.endings.byOutcome[nd.outcome] ?? 0, 'place')} in the code that return${(reading.numbers.endings.byOutcome[nd.outcome] ?? 0) === 1 ? 's' : ''} or raise${(reading.numbers.endings.byOutcome[nd.outcome] ?? 0) === 1 ? 's' : ''} with that outcome (How it fails lists every failing one), so the two numbers differ.`;
    nd.summary = nd.plain;
  }
  const stageById = new Map(reading.districts.list.map((d) => [d.id, d]));
  for (const nd of Object.values(ov?.nodes ?? {})) {
    if (nd.synth !== 'stage') continue;
    const d = stageById.get(nd.stage);
    if (!d) continue;
    nd.title = d.title;
    nd.plain = `${d.about ? `${d.about} ` : 'No comment in the code describes this stage. '}${plural(d.functions, 'function')} and ${plural(d.boxes, 'box', 'boxes')} in the map (${d.path}).`;
    nd.summary = nd.plain;
    nd.why = d.aboutFrom ? `The sentence is from ${d.aboutFrom}. Open the stage for its functions.` : 'Open the stage for its functions.';
  }
  const roadName = new Map();
  for (const ch of Object.values(atlas.charts)) {
    if (ch.kind !== 'detail') continue;
    for (const [id, e] of Object.entries(ch.edges)) roadName.set(id, `${ch.nodes[e.from]?.title ?? '?'} to ${ch.nodes[e.to]?.title ?? '?'}`);
  }
  for (const e of Object.values(ov?.edges ?? {})) {
    if (!Array.isArray(e.via) || !e.via.length) continue;
    const named = [...new Set(e.via.map((r) => roadName.get(r)).filter(Boolean))].slice(0, 3);
    e.why = `${e.via.length} ${e.via.length === 1 ? 'road carries' : 'roads carry'} this stage-to-stage road${named.length ? `, for example ${named.join('; ')}` : ''}${e.via.length > named.length ? ' and others' : ''}.`;
  }
  const M = atlas.meta;
  const n = reading.numbers;
  M.draft = false;
  delete M.census; delete M.notDrawn;
  // the page's totals for failures and questions are the reading's, so the pills, the chart list and the guides say the same numbers
  const hc = reading.whoHears.counts;
  const byFails = { person: hc.person, outside: hc.client, event: hc.event, caller: hc.caller, log: hc.log, nobody: hc.nobody, unclear: hc.someone, unsaid: hc.unknown };
  M.counts = M.counts ?? {};
  M.counts.fails = { total: hc.total, failure: reading.endings.byOutcome.failure ?? 0, refusal: reading.endings.byOutcome.refusal ?? 0, steps: 0, by: byFails, said: hc.total - hc.unknown, reachPerson: hc.person, silent: 0 };
  const waits = atlas.breaks.filter((b) => b.check === 'wait-no-wake').length;
  for (const b of atlas.breaks) if (b.check === 'wait-no-wake') b.state = 'wait';
  M.counts.breaks = { kept: 0, open: atlas.breaks.length - waits, waits, loops: 0, silent: 0, look: atlas.breaks.length, leads: 0, dismissed: 0, setAside: 0, person: 0 };
  const mainId = reading.journeys.main;
  const mainJ = mainId ? rl.journeys.find((j) => j.id === mainId) : null;
  const mainStages = mainJ ? new Set(mainJ.steps.filter((x) => x.k === 'e' && x.f !== undefined).map((x) => rl.fns[x.f].g)).size : 0;
  const by = n.endings.byOutcome;
  const successText = `What the code shows: ${n.endings.total} endings (a place where a function returns or raises). ${by.success ?? 0} return normally, with a value or an HTTP status below 400; ${by.failure ?? 0} raise an error or answer HTTP 500 or more; ${by.refusal ?? 0} answer HTTP 4xx or are named like a refusal; ${by.neutral ?? 0} return nothing, false or a negative number. The tool decides this from the code at each ending; it does not know what the project itself counts as success.`;
  const headline = mainJ ? mainJ.steps.filter((x) => x.h && ['e', 'x', 'w', 'n', 'fin'].includes(x.k)).map((x) => ({ k: x.k, t: x.t, d: x.hd ?? 0 })).slice(0, 14) : [];
  const rk = reading.journeys.ranking ?? {};
  M.toolMap = {
    mainPath: mainJ ? { id: mainJ.id, name: mainJ.name, stages: mainStages, steps: headline, why: rk.main?.why ?? '', rule: rk.rule ?? '' } : null,
    mainTile: mainJ ? `the main path runs through ${mainStages} of them` : 'no main path found',
    rule: rk.rule ?? '',
    successText,
    endings: { total: n.endings.total, byOutcome: by, failing: n.endings.failing },
    stageNames: Object.fromEntries(reading.districts.list.map((d) => [d.id, { t: d.title, p: d.path, about: d.about, from: d.aboutFrom, fns: d.functions, boxes: d.boxes }])),
    read: reading.statements.read, notRead: reading.statements.notRead, open: reading.statements.open,
    conf: rl.conf, tagline: atlas.system.tagline, wordsBy: side.wordsBy, stageOrder: false,
    nums: { functions: n.read.functions, files: n.read.files, boxes: n.read.boxes, roads: n.read.roads, loops: n.read.loops, stages: n.read.districts, journeys: n.journeys.kept, roadsUnsure: n.notRead.callsWithSeveralTargets, claims: n.read.claims, claimsNotConfident: n.read.claimsNotConfident, questions: n.open.questions, questionsSure: n.open.questionsConfident, gapsInDrawing: n.open.gapsInDrawing },
    sw: { count: n.switches.found, withDefault: n.switches.withDefault, off: n.switches.offByDefault, notRead: n.switches.defaultNotRead, falsy: n.switches.defaultFalsy, on: n.switches.defaultOn, line: switchLine(n.switches) },
    guides: [{ label: 'Journeys', view: 'journeys', chip: '▶', count: reading.journeys.list.length, word: 'journeys' }, { label: 'How it fails', view: 'fails', chip: '✗', count: hc.total, word: 'failures and refusals', top: true }, { label: 'Off by default', view: 'switches', chip: '○', count: n.switches.offByDefault, word: `off by default, of ${n.switches.found} switches found` }],
    hideGuides: ['fails'],
  };

  const css = fs.readFileSync(path.join(readerDir, 'reader.css'), 'utf8');
  const js = ['reader-core.js', 'reader-views.js'].map((f) => fs.readFileSync(path.join(readerDir, f), 'utf8')).join('\n');
  const frag = `${MARK}\n<style>${css}</style>\n<div id="rl" class="rl" hidden role="dialog" aria-label="Reader: what it is, journeys, stages and functions"><div class="rl-head"><button type="button" class="rl-b rl-back" hidden>Back</button><div class="rl-crumb"></div><button type="button" class="rl-close">Close, show the chart</button></div><div class="rl-body"></div></div>\n<script type="application/json" id="rl-data">${json(rl)}</script>\n<script>${js}</script>\n`;
  const withData = src.slice(0, m.index) + `<script type="application/json" id="atlas-data">${json(atlas)}</script>` + src.slice(m.index + m[0].length);
  const i = withData.lastIndexOf('</body>');
  const out = withData.slice(0, i) + frag + withData.slice(i);
  fs.writeFileSync(html, out);
  return `page ${out.length} bytes (plain build ${src.length}); reader data ${json(rl).length}; ${atlas.nav.length - 1} stages in the list; ${atlas.breaks.length} questions; not confident: ${ncBoxes} boxes, ${ncRoads} roads`;
}
