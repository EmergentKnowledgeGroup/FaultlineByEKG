// The agent commands (CONTRACTS section 10). Each takes the agent blob (agentData), returns plain text under its token budget, and ends with
// a deep link a person can open. Dense on purpose: ids everywhere, no decoration. "candidate", "not drawn", "No limit shown" - never "bug".
import { shortestRoute, weightedRoute, trunc, uniq, plural } from '../build/util.mjs';
import { HEARD_WORDS } from '../model/heard.mjs';
import { makeCtx, finish, resolve, levelOf, routeWords, stageTitle, tok, BUDGET, ACCEPTED } from './view.mjs';
import { readLines, questionLines, failingLine, breaksText, statusLines, pinSaid } from './toolmap.mjs';
import { locate, fnOfBox } from './locate.mjs';
import { whereFunction, whereFile, calledFromLines } from './fnwhere.mjs';
import { whole } from './words.mjs';
import { pathBetween, impactOf } from './flow.mjs';

const routeList = (data) => Object.entries(data.routes).map(([id, r]) => ({ id, ...r }));
const boxList = (data) => Object.keys(data.boxes).map((id) => ({ id, ...data.boxes[id] }));
const fixLevels = (build, levels, tokens, linkLine, more) => {
  for (const lv of levels) { const lines = build(lv); if (tok(lines.join('\n') + '\nopen: ' + linkLine) <= tokens) return lines.join('\n') + '\nopen: ' + linkLine; }
  return finish(build(levels[levels.length - 1]), linkLine, tokens, more);
};

// ---------------------------------------------------------------------------------------------------------------- brief
export function brief(data, o = {}) {
  const c = makeCtx(data, o), T = c.budget('brief'), link = c.link('overview', null);
  const nStage = Object.fromEntries(data.stages.map((s) => [s.id, s]));
  const toStages = (s) => uniq(routeList(data).filter((r) => r.type !== 'return' && data.boxes[r.from].stage === s.id && data.boxes[r.to].stage !== s.id).map((r) => data.boxes[r.to].stage)).filter((x) => nStage[x]);
  const endings = ['success', 'failure', 'refusal', 'neutral'].map((oc) => [oc, boxList(data).filter((b) => b.kind === 'end' && (b.outcome || 'neutral') === oc).map((b) => b.id)]).filter(([, l]) => l.length);
  const cands = data.findings.filter((f) => f.shown), tmx = data.toolMap || null;     // a tool map: the reading's numbers and questions, none of the hand-written way's words
  const build = (lv) => {
    const L = [], i = lv + 1, pathCap = [400, 60, 28, 14, 8][i], blurb = [400, 90, 60, 30, 0][i], candCap = [40, 8, 5, 3, 2][i], per = [40, 10, 6, 4, 3][i];
    L.push(`FAULTLINE BRIEF  ${data.system.name || 'system'}  ${tmx ? 'TOOL MAP' : data.state.toUpperCase()}${data.pin ? '  pin ' + pinSaid(data.pin) : ''}`);
    if (data.system.tagline || data.system.summary) L.push(trunc(data.system.summary || data.system.tagline, [800, 320, 220, 140, 90][i]));
    if (data.system.purpose && !tmx && lv < 3) L.push('Success means: ' + trunc(data.system.purpose, [500, 220, 140, 90][i] || 90));
    const ce = data.census, acc = (k) => (ce[k] ? `${k} ${ce[k].accounted}/${ce[k].total}` : '');
    const tm = !!data.system.toolMap;        // a map the tool drew has no ledger to account for and no order of running: the brief says neither
    if (tmx) L.push(...readLines(data, lv));
    else L.push(`${data.counts.boxes} boxes, ${data.counts.routes} routes (${data.counts.inferred} inferred), ${data.counts.stages} stages, ${data.counts.loops} loops. Accounted: ${[acc('endings'), acc('branches'), acc('modules')].filter(Boolean).join(', ') || 'no census'}.`);
    L.push(tm ? 'STAGES largest first (by functions), in no claimed order of running (id title: boxes; then -> stages it hands to)' : 'STAGES in order (id title: boxes; then -> stages it hands to)');
    for (const s of data.stages) { const nx = toStages(s); L.push(tmx ? ` ${s.id} ${s.title}: ${blurb ? trunc(s.blurb, blurb + 20) : ''}${nx.length ? ' -> ' + nx.join(',') : ''}` : ` ${s.order ?? ''} ${s.id} ${s.title}: ${s.boxes.length}${blurb ? '; ' + trunc(s.blurb, blurb) : ''}${nx.length ? ' -> ' + nx.join(',') : ''}`); }
    const mp = data.main;
    if (mp.length) L.push(`MAIN PATH ${mp.length}: ` + (mp.length > pathCap ? mp.slice(0, pathCap - 3).join(' > ') + ` > ... ${mp.length - pathCap + 1} more ... > ${mp[mp.length - 1]}` : mp.join(' > ')));
    if (data.loops.length) {
      L.push('LOOPS (limit = what bounds the repeat)');
      for (const l of data.loops.slice(0, per)) L.push(` ${l.id} ${l.title}: ${l.limit ? 'limit ' + trunc(l.limit, 60) : 'NO LIMIT SHOWN'}`);
      if (data.loops.length > per) L.push(` ... ${data.loops.length - per} more loops: faultline breaks lists the ones with no limit shown`);
    }
    if (endings.length) {
      const allEnds = endings.flatMap(([, ids]) => ids), back = allEnds.filter((id) => data.boxes[id].ending === 'back').length;
      L.push(tmx ? `ENDINGS in the code ${tmx.nums.endings}; drawn as ${plural(allEnds.length, 'box', 'boxes')} (a box can stand for several; ${allEnds.length - back} stop there, ${back} hand back to their caller)` : `ENDINGS ${allEnds.length} (${allEnds.length - back} stop here, ${back} hand back to their caller)`); for (const [oc, ids] of endings) L.push(` ${oc}: ${ids.slice(0, per).join(' ')}${ids.length > per ? ` +${ids.length - per}` : ''}`); }
    if (tmx) { const fl = failingLine(data); if (fl && lv < 3) L.push(fl); }
    else if (data.silent && data.silent.length) L.push(`SILENT FAILURES ${data.silent.length}: a failure the map says only a log or nobody hears (faultline breaks --silent)`);
    if (tmx) L.push(...questionLines(data, candCap, [300, 120, 90, 70, 50][i]));
    else if (cands.length) {
      L.push(`CANDIDATES ${cands.length} (suspected shapes, not confirmed; one question each)`);
      for (const f of cands.slice(0, candCap)) L.push(` ${f.key} [${f.boxes.slice(0, 3).join(',')}] ${trunc(f.question, [300, 120, 90, 70, 50][i])}`);
      if (cands.length > candCap) L.push(` ... ${cands.length - candCap} more: faultline breaks`);
    } else L.push('CANDIDATES none found by the checks that ran (that is not proof the map is clean)');
    const nd = data.notDrawn, ndTotal = nd.endings + nd.branches + nd.modules;
    if (!tmx) L.push(ndTotal ? `NOT DRAWN YET: ${ndTotal} census rows (${nd.endings} endings, ${nd.branches} decisions, ${nd.modules} files)` : 'NOT DRAWN YET: nothing the census lists');
    if (data.evidence && data.evidence.walks) L.push(`EVIDENCE: ${data.evidence.walks} walk(s); seen ${data.evidence.seen.length}, proved ${data.evidence.proved.length}${data.evidence.stale.length ? ', stale ' + data.evidence.stale.length : ''}${data.evidence.unexplored.length ? ', unexplored ' + data.evidence.unexplored.length : ''}`);
    L.push(tmx ? 'NEXT: faultline breaks | where <box|function|file:line> | path <a> <b> | impact <box> | status' : 'NEXT: faultline where <box|file:line|symbol> | breaks | path <a> <b> | impact <box|file> | status');
    return L;
  };
  return fixLevels(build, T > BUDGET.brief ? [-1, 0, 1, 2, 3] : [0, 1, 2, 3], T, link, 'faultline brief --budget ' + T * 2);
}

// ---------------------------------------------------------------------------------------------------------------- where
export function where(data, query, o = {}) {
  if (o.reading && data.toolMap) return whereTool(data, o.reading, query, o);
  const c = makeCtx(data, o), T = c.budget('where'), r = resolve(data, query);
  const link0 = c.link(c.wholeId, null);
  if (!r.boxes.length && r.fnRows) {                    // a file whose functions are all outlines on the page
    return finish([`WHERE ${query} -> file ${r.file}: ${plural(r.fnRows.length, 'function')} read, none with a box`, ...r.fnRows.slice(0, 12).map((x) => ` ${x[0]} line ${x[3]} [${x[4]}] ${x[6] ? 'chart ' + x[6] : 'outline only'}`), r.fnRows.length > 12 ? ` ... ${r.fnRows.length - 12} more` : null], link0, T, 'faultline where <function> --budget ' + T * 2);
  }
  if (!r.boxes.length && r.fnRow) {                    // a tool map's function the page lists as an outline: no chart, no box
    const [fid, label, file, line, stage, nBoxes, chart, callers] = r.fnRow;
    return finish([`WHERE ${query} -> function ${fid}  [${stage} ${stageTitle(data, stage)}]`, `${label}: ${file}:${line}. ${r.note}.`, `${nBoxes ? plural(nBoxes, 'box', 'boxes') + ', ' : ''}${chart ? 'chart ' + chart : 'no chart of its own (the Reader lists it as an outline)'}; called from ${plural(callers, 'function')}.`], link0, T, 'faultline where <box> --budget ' + T * 2);
  }
  if (!r.boxes.length) return finish([`WHERE ${query}: ${r.note || 'no match'}`, data.toolMap ? `Nothing matches. Accepted: ${ACCEPTED}.${data.toolMap.nums.noBoxes ? ` ${plural(data.toolMap.nums.noBoxes, 'function')} on this map ${data.toolMap.nums.noBoxes === 1 ? 'has' : 'have'} no box at all and cannot be found by name (faultline status).` : ''}` : 'Not drawn is not the same as absent: the file may be cited by no box yet. faultline status lists the gaps.'], link0, T, 'faultline where <box> --budget ' + T * 2);
  return boxAnswer(data, c, T, query, r, null);
}

// The answer for one drawn box: its words, its roads in and out, its source lines. `R` (the reading of a tool map) adds the function it belongs to and who calls that function.
function boxAnswer(data, c, T, query, r, R) {
  const id = r.boxes[0], b = data.boxes[id], L = [];
  L.push(`WHERE ${query === id ? id : `${query} -> ${id}`}  [${b.stage} ${stageTitle(data, b.stage)}]  ${b.kind}  ${b.status}  ${b.chart || ''}`);
  L.push(`${b.title}${b.handle ? '  (system name: ' + b.handle + ')' : ''}`);
  if (b.plain) L.push(R ? whole(b.plain, 260) || null : trunc(b.plain, 260));
  if (b.why) L.push(R ? (whole(b.why, 160) ? 'why: ' + whole(b.why, 160) : null) : 'why: ' + trunc(b.why, 120));
  if (b.failure) L.push('if it goes wrong: ' + (R ? whole(b.failure, 160) : trunc(b.failure, 110)));
  if (b.switch) L.push('setting: ' + b.switch);
  L.push('level: ' + levelOf(data, id));
  if (b.kind === 'end') L.push(b.ending === 'back' ? `ending: HANDS BACK to its caller (${plural(b.out.length, 'road')} out)` : 'ending: STOPS HERE (no road out)');
  if (b.heard) L.push(`who hears: ${HEARD_WORDS[b.heard.by] || b.heard.by}${b.heard.how ? ' (' + trunc(b.heard.how, 110) + ')' : ''}`);
  else if (b.kind === 'end' && (b.outcome === 'failure' || b.outcome === 'refusal')) L.push(`who hears: ${data.toolMap ? 'not known from the code' : 'not said yet'}`);
  const rs = (ids, dir) => ids.map((rid) => { const x = data.routes[rid], other = dir === 'in' ? x.from : x.to; return `  ${dir === 'in' ? '<-' : '->'} ${other} ${routeWords(x)} (${rid})`; });
  L.push(b.in.length ? `ROADS IN ${b.in.length}` : R ? 'ROADS IN none drawn on the page' : 'ROADS IN none drawn');
  L.push(...rs(b.in.slice(0, 6), 'in'));
  if (b.in.length > 6) L.push(`  ... ${b.in.length - 6} more in`);
  L.push(b.out.length ? `ROADS OUT ${b.out.length}` : (b.kind === 'end' ? 'ROADS OUT none (it stops here)' : 'ROADS OUT none drawn'));
  L.push(...rs(b.out.slice(0, 6), 'out'));
  if (b.out.length > 6) L.push(`  ... ${b.out.length - 6} more out`);
  if (R) L.push(...toolBoxContext(data, R, id, b));
  L.push('src: ' + b.refs.slice(0, 3).map((x) => `${x[0]}:${x[1]}${x[2] ? ' ' + x[2].split('::').pop() : ''}`).join(' | '));
  const here = data.findings.filter((f) => f.boxes.includes(id));
  for (const f of here.slice(0, 2)) L.push(`candidate ${f.key}: ${trunc(f.question, 130)}`);
  if (r.boxes.length > 1) L.push(`same ${r.kind === 'line' || r.kind === 'function' ? 'function' : 'match'} also cited by: ${r.boxes.slice(1, 7).join(', ')}${r.boxes.length > 7 ? ` +${r.boxes.length - 7}` : ''}`);
  if (r.note) L.push(r.note);
  return finish(L, c.linkBox(id), T, `faultline where ${id} --budget ${T * 2}`);
}

// A tool map's box also sits in a function: say which, what a card stands for, and who calls the function when this box is where it starts.
function toolBoxContext(data, R, id, b) {
  const owner = R.byN.get(id.split('.')[0]), target = fnOfBox(R, data, id), L = [];
  if (owner) L.push(`in function ${owner.n} ${owner.id}: faultline where ${owner.n} gives its body`);
  if (b.refs.length && target && owner && target.id !== owner.id) L.push(`this box is a card for ${target.n || target.id} ${target.name}${target.n ? `: faultline where ${target.n}` : ''}`);
  if (b.handle && owner) L.push(...calledFromLines(R, owner));
  return L;
}

// The tool map's where: the function a query means with its body, a file's functions, or a drawn box.
function whereTool(data, R, query, o) {
  const c = makeCtx(data, o), T = c.budget('where'), res = locate(R, data, query);
  if (res.kind === 'function') return whereFunction(R, data, res, query, c, T);
  if (res.kind === 'file') return whereFile(R, data, res, query, c, T);
  if (res.kind === 'box') return boxAnswer(data, c, T, query, { kind: 'box', boxes: [res.box] }, R);
  if (res.kind === 'titles') return boxAnswer(data, c, T, query, { kind: 'title', boxes: res.boxes, note: res.boxes.length > 1 ? `${res.boxes.length} boxes have those words in their title; the first is shown` : '' }, R);
  return finish([`WHERE ${query}: ${res.note}`, `Accepted: ${ACCEPTED}.`], c.link(c.wholeId, null), T, 'faultline where <function> --budget ' + T * 2);
}

// ---------------------------------------------------------------------------------------------------------------- breaks
const topChecks = (rows) => { const by = {}; for (const f of rows) by[f.check] = (by[f.check] || 0) + 1; const e = Object.entries(by).sort((a, b) => b[1] - a[1]); return e.slice(0, 4).map(([c, n]) => `${n} ${c}`).join(', ') + (e.length > 4 ? ', ...' : ''); };
const RANK = { drawn: 0, seen: 1, proved: 2 };
function evWord(data, ids) {                                  // the strongest evidence on the boxes a candidate names, in plain words ('' when only drawn)
  let best = null;
  for (const id of ids) { const b = data.boxes[id]; if (b && (!best || RANK[b.level] > RANK[best.level] || (RANK[b.level] === RANK[best.level] && best.anchorOnly && !b.anchorOnly))) best = b; }
  if (!best || best.level === 'drawn') return best && best.stale ? 'stale' : '';
  return best.anchorOnly ? 'cited line ran, nobody arrives' : best.level + (best.stale ? ' (stale)' : '');
}
export function breaks(data, o = {}) {
  if (data.toolMap) { const c0 = makeCtx(data, o), T0 = c0.budget('breaks'), r = breaksText(data, o, c0, T0); return finish(r.lines, r.link, T0, r.more); }
  const c = makeCtx(data, o), T = c.budget('breaks'), stage = o.stage || null;
  const inStage = (f) => !stage || f.cluster === stage || f.boxes.some((b) => data.boxes[b] && data.boxes[b].stage === stage);
  const dismissed = (f) => f.resolution && f.resolution.state === 'dismissed', suspect = (f) => f.resolution && f.resolution.state === 'suspect';
  const pool = data.findings.filter(inStage), leadsAll = pool.filter((f) => f.lead && !dismissed(f));
  const fs = o.silent ? [] : o.leads ? leadsAll : pool.filter((f) => !f.lead && (o.all || f.shown));
  const silent = (data.silent || []).filter((id) => data.boxes[id] && (!stage || data.boxes[id].stage === stage));   // failure endings the map says nobody hears, or only a log
  const link = c.link(c.wholeId, null, '&ev=1');
  const L = [o.silent ? `BREAKS --silent ${stage ? 'stage ' + stage + ' ' : ''}${silent.length} failure ending(s) nobody is told about, ${data.state}. Each asks: what happens, and who should know? A question the map raises, not a verdict.` : o.leads ? `BREAKS --leads ${stage ? 'stage ' + stage + ' ' : ''}${fs.length} lead(s), ${data.state}. A lead is a weak shape (too often meant on purpose) kept out of the candidates; it needs a person's eye, not a dismissal by habit.`
    : `BREAKS ${stage ? 'stage ' + stage + ' ' : ''}${fs.length} candidate(s), ${data.state}. A candidate is a shape worth a question, not a confirmed bug.`];
  // Order is: kept suspects (a person already read the code, at most half the slots), then open candidates by how many checks agree and the fixed check order.
  // Say what is shown and what is held back right here, above the list, so a token cut at the end can never drop it.
  if (!o.leads && !o.silent) {
    const keptAll = pool.filter(suspect), openAll = pool.filter((f) => !f.lead && !f.resolution);
    const keptShown = fs.filter(suspect).length, openShown = fs.filter((f) => !f.resolution).length;
    const heldRows = pool.filter((f) => !f.lead && !f.shown && !dismissed(f)), held = heldRows.length;
    L.push(`Showing ${keptAll.length ? `${keptShown} of ${keptAll.length} kept suspect(s) (already read) and ` : ''}${openShown} of ${openAll.length} open candidate(s).${held && !o.all ? ` ${held} more held back (${heldRows.filter(suspect).length} kept, ${heldRows.filter((f) => !f.resolution).length} open; lower rank: ${topChecks(heldRows)}): faultline breaks --all${stage ? '' : ' (or --stage <id> for one stage)'}` : ''}`);
    if (leadsAll.length) L.push(`${leadsAll.length} lead(s) kept out (${topChecks(leadsAll)}): they do not count as candidates; faultline breaks --leads`);
  }
  if (silent.length && !o.leads) {                         // said above the list too: a token cut at the end can never drop it
    if (!o.silent) L.splice(2, 0, `${silent.length} failure ending(s) nobody is told about (heard by nobody, or only a log) are listed after the candidates; faultline breaks --silent lists them all`);
  }
  const stuck = boxList(data).filter((b) => b.level === 'proved' || (b.walkOutcomes || []).some((w) => /stuck|error/.test(w)));
  fs.slice(0, o.all || o.leads ? 40 : 10).forEach((f, i) => {
    const ev = evWord(data, f.boxes);
    L.push(`${i + 1}. ${f.key}  [${f.boxes.length ? trunc(f.boxes.join(','), 60) : 'no box cites it'}]${f.lead ? '  LEAD' : ''}${f.agree > 1 ? `  ${f.agree} checks agree` : ''}${ev ? '  evidence: ' + ev : ''}`);
    if (f.resolution && f.resolution.state === 'suspect') { L.push(`   kept as a suspect: ${trunc(f.resolution.why, 160)}`); return; }   // a person already wrote the substance
    L.push(`   ? ${trunc(f.question, 170)}`);
    L.push(`   because: ${trunc(f.evidence, 170)}`);
    if (f.check === 'shared-decision' || f.check === 'lost-wakeup') L.push('   to dismiss: answer the question asked; "one function, same arguments" is not an answer');
    if (f.resolution) L.push(`   dismissed: ${trunc(f.resolution.why, 120)}`);
  });
  if (!o.leads) for (const id of silent.slice(0, o.silent ? 60 : 5)) {
    const b = data.boxes[id], h = b.heard || {};
    L.push(`silent ${id}  [${b.stage}]  ${trunc(b.title, 60)}: ${HEARD_WORDS[h.by] || h.by}${h.how ? ' (' + trunc(h.how, 100) + ')' : ''}. What happens, and who should know?`);
  }
  if (o.silent && !silent.length) L.push('none: no failure ending is said to be heard by nobody or only a log' + (Object.values(data.boxes).some((b) => b.heard) ? '' : ' (no heardBy data in this model yet)'));
  const lit = stuck.filter((b) => !stage || b.stage === stage);
  if (lit.length) L.push('SEEN STUCK/FAILING: ' + lit.slice(0, 8).map((b) => `${b.id}[${b.level}${(b.walkOutcomes || []).length ? ' ' + b.walkOutcomes.join('/') : ''}]`).join(' '));
  const mr = (data.evidence && data.evidence.missingRoutes) || [];
  if (mr.length) L.push('MAP LACKS A ROAD a walk took: ' + mr.slice(0, 3).map((m) => `${m.from.join('|')} -> ${m.to.join('|')}${m.count > 1 ? ' x' + m.count : ''}`).join('; '));
  if (data.evidence && data.evidence.labels.length) for (const l of data.evidence.labels.slice(0, 2)) L.push(`checked (${l.tool}): ${trunc(l.says, 150)}`);
  else L.push('No walk loaded: nothing is seen or proved yet, every box is only drawn. faultline walk add <file> or coverage import <file>.');
  if (!fs.length) L.push(stage ? `none for ${stage}` : 'none from the checks that ran; the map may still hide breaks the checks cannot see');
  return finish(L, link, T, `faultline breaks ${stage ? '--stage ' + stage + ' ' : ''}--all --budget ${T * 2}`);
}

// ---------------------------------------------------------------------------------------------------------------- path
// Both ends on one declared path (data.paths, first listed wins): answer along that path and say which. Otherwise a weighted search over forward roads
// (each road 1, each change of stage about 6, a main-path road far less): "a route the roads allow, not a promise that one request takes it". --shortest is the plain
// fewest-hops search and skips the declared paths.
function alongPath(data, A, B, rt) {
  const road = (x, y) => rt.find((r) => r.from === x && r.to === y && r.type !== 'return') || rt.find((r) => r.from === x && r.to === y);
  for (const p of data.paths || []) {
    const ia = p.boxes.indexOf(A), ib = ia < 0 ? -1 : p.boxes.indexOf(B, ia + 1);   // a path may repeat a box: B is looked for AFTER A
    if (ia < 0 || ib <= ia) continue;
    const hops = [];
    for (let i = ia; i < ib; i++) { const r = road(p.boxes[i], p.boxes[i + 1]); if (!r) { hops.length = 0; break; } hops.push(r); }
    if (hops.length) return { p, hops };
  }
  return null;
}
export function path(data, a, b, o = {}) {
  const c = makeCtx(data, o), T = c.budget('path');
  if (o.reading && data.toolMap) {                         // a tool map: between functions by the call list, unless both ends are drawn boxes
    const ra = locate(o.reading, data, a), rb = locate(o.reading, data, b);
    if (!(ra.kind === 'box' && rb.kind === 'box')) return pathBetween(o.reading, data, ra, rb, a, b, c, T, !!o.shortest);
  }
  const ra = resolve(data, a), rb = resolve(data, b), A = ra.boxes[0], B = rb.boxes[0];
  const link = c.link(c.wholeId, A || null);
  if (!A || !B) return finish([`PATH: ${!A ? `"${a}" matches no box` : `"${b}" matches no box`}. Use a box id (faultline where <name> resolves one).`], link, T, 'faultline path <a> <b>');
  const bl = boxList(data), rt = routeList(data).map((r) => ({ ...r }));
  const short = shortestRoute(bl, rt, A, B);
  const via = o.shortest ? null : alongPath(data, A, B, rt);
  const wopts = { main: data.main || [], stageOf: (x) => x.stage };
  const weighted = o.shortest || via ? null : weightedRoute(bl, rt, A, B, wopts);
  let p = via ? via.hops : o.shortest ? short : weighted, viaReturn = false;
  if (!p) { p = o.shortest ? shortestRoute(bl, rt, A, B, { allowReturn: true }) : weightedRoute(bl, rt, A, B, { ...wopts, allowReturn: true }); viaReturn = !!p; }
  if (!p) {
    const back = shortestRoute(bl, rt, B, A, { allowReturn: true });
    return finish([`PATH ${A} -> ${B}: NO ROUTE DRAWN. Not drawn is not the same as impossible: the map may be missing a road.`, back ? `A route exists the other way (${back.length} hops): faultline path ${B} ${A}` : 'None the other way either.'], link, T, 'faultline path <a> <b>');
  }
  const how = via ? `along the declared path ${via.p.id}${via.p.title && via.p.title !== via.p.id ? ` "${trunc(via.p.title, 30)}"` : ''}` : viaReturn ? 'only by going back through a return route' : o.shortest ? 'shortest, return routes avoided' : 'a route the roads allow';
  const L = [`PATH ${A} -> ${B}  ${p.length} hop(s)  (${how})`];
  const changes = p.filter((r) => data.boxes[r.from] && data.boxes[r.to] && data.boxes[r.from].stage !== data.boxes[r.to].stage).length;
  if (!o.shortest && !via) L.push(`A route the roads allow, not a promise that one request takes it.${changes ? ` It changes stage ${plural(changes, 'time')}.` : ''}`);
  if (via && short && short.length < p.length) L.push(`a shorter road of ${short.length} hop(s) exists off that path: faultline path ${A} ${B} --shortest`);
  const show = p.length > 14 ? [...p.slice(0, 8), null, ...p.slice(-4)] : p;
  for (const r of show) L.push(r ? `${r.from} ${routeWords(r)} -> ${r.to}  (${r.id})` : `... ${p.length - 12} hops ...`);
  const inferred = p.filter((r) => r.inferred).length;
  if (inferred) L.push(`${plural(inferred, 'hop')} inferred (no code path proves it)`);
  return finish(L, link, T, `faultline path ${A} ${B} --budget ${T * 2}`);
}

// ---------------------------------------------------------------------------------------------------------------- impact
// What is downstream of a box, kept true and useful on a large map. Forward and deliver roads only (return and record roads
// are left out and counted). The walk lists a box with more than FUNNEL roads in but does not go through it, and says so.
export const FUNNEL = 12;
const FORWARD = new Set(['forward', 'deliver']);
function reach(start, routes, { ok, dir }) {
  const next = new Map();
  for (const r of routes) { if (!ok(r)) continue; const [x, y] = dir === 'down' ? [r.from, r.to] : [r.to, r.from]; if (!next.has(x)) next.set(x, []); next.get(x).push(y); }
  const seen = new Set(start), q = [...start];
  for (let h = 0; h < q.length; h++) for (const y of next.get(q[h]) || []) if (!seen.has(y)) { seen.add(y); q.push(y); }
  return seen;
}
function walk(start, next, data, stopAtFunnels) {                       // box -> hops from the start; a funnel is reached but not left
  const dist = new Map(start.map((s) => [s, 0])), q = [...start];
  for (let h = 0; h < q.length; h++) {
    const v = q[h];
    if (stopAtFunnels && dist.get(v) > 0 && data.boxes[v].in.length > FUNNEL) continue;
    for (const y of next.get(v) || []) if (!dist.has(y)) { dist.set(y, dist.get(v) + 1); q.push(y); }
  }
  return dist;
}
export function impact(data, query, o = {}) {
  const c = makeCtx(data, o), T = c.budget('impact');
  if (o.reading && data.toolMap) {
    const res = locate(o.reading, data, query);
    if (res.kind !== 'box') return impactOf(o.reading, data, res, query, c, T);
  }
  const r = resolve(data, query), rt = routeList(data);
  if (!r.boxes.length) return finish([`IMPACT ${query}: ${r.note || 'no match'}`], c.link(c.wholeId, null), T, 'faultline impact <box|file>');
  const start = r.boxes.slice(0, 12), id = start[0], isStart = new Set(start);
  const next = new Map();
  for (const x of rt) if (FORWARD.has(x.type)) { if (!next.has(x.from)) next.set(x.from, []); next.get(x.from).push(x.to); }
  const A = walk(start, next, data, true), B = walk(start, next, data, false);
  const everything = reach(start, rt, { ok: () => true, dir: 'down' }), up = reach(start, rt, { ok: (x) => FORWARD.has(x.type), dir: 'up' });
  start.forEach((s) => { A.delete(s); B.delete(s); everything.delete(s); up.delete(s); });
  const at = (d) => [...A.entries()].filter(([, k]) => k === d).map(([b]) => b);
  const dists = [...new Set(A.values())].sort((x, y) => x - y);
  const byHop = dists.slice(0, 8).map((d) => `${d}:${at(d).length}`).join(' ') + (dists.length > 8 ? ` ... to ${dists[dists.length - 1]} hops` : '');
  const funnels = [...A.keys()].filter((b) => data.boxes[b].in.length > FUNNEL);
  const cut = B.size - A.size, viaBack = everything.size - B.size;
  const name = (b) => `${b} "${trunc(data.boxes[b].title, 26)}"`;
  const ids = (list, cap) => list.slice(0, cap).join(' ') + (list.length > cap ? ` +${list.length - cap}` : '');
  const L = [`IMPACT ${r.boxes.length > 1 ? `${query} (${r.boxes.length} boxes: ${start.join(', ')})` : id + '  ' + trunc(data.boxes[id].title, 40)}  [${r.kind}]`];
  if (start.length === 1 && data.boxes[id].kind === 'end') {            // an ending hands back to whoever called it: say who, and what that caller does next
    const back = rt.filter((x) => x.from === id && x.type === 'return'), tos = uniq(back.map((x) => x.to));
    if (back.length) {
      L.push(`HANDS BACK to ${tos.slice(0, 4).map(name).join(', ')}${tos.length > 4 ? ` +${tos.length - 4}` : ''} (${plural(back.length, 'return road')}); that, not the box count below, is where it goes next`);
      const next = tos.slice(0, 3).map((t) => { const o = rt.filter((x) => x.from === t && x.type !== 'return' && x.type !== 'record' && x.to !== id).slice(0, 3); return o.length ? `${t} goes on to ${o.map((x) => `${x.to}${x.when ? ` (${trunc(x.when, 24)})` : ''}`).join(', ')}` : `${t} has no road on`; });
      L.push(`THE CALLER THEN: ${next.join('; ')}${tos.length > 3 ? '; ...' : ''}`);
    } else L.push('STOPS HERE: no road leaves this ending');
  }
  L.push(`DOWNSTREAM ${B.size} box(es) by forward roads${viaBack > 0 ? ` (+${viaBack} more only through return or record roads, left out)` : ''}. Boxes by hops: ${byHop || 'none'}`);
  if (cut > 0) L.push(`CUT: the walk stops at ${funnels.length} shared funnel(s) (more than ${FUNNEL} roads in) and does not go through them, so ${cut} box(es) beyond are not listed below: ${funnels.slice(0, 4).map((b) => `${b} (${data.boxes[b].in.length} in)`).join(' ')}${funnels.length > 4 ? ` +${funnels.length - 4}` : ''}`);
  else if (funnels.length) L.push(`SHARED FUNNELS on the way (more than ${FUNNEL} roads in; they lead nowhere new): ${ids(funnels, 4)}`);
  const h1 = at(1), h2 = at(2);
  if (h1.length) L.push(`1 HOP (${h1.length}): ${h1.slice(0, 8).map(name).join(', ')}${h1.length > 8 ? ` +${h1.length - 8}` : ''}`);
  if (h2.length) L.push(`2 HOPS (${h2.length}): ${ids(h2, 12)}`);
  const ends = Object.keys(data.boxes).filter((b) => data.boxes[b].kind === 'end'), tag = (b) => `${b}[${data.boxes[b].outcome || 'neutral'}]`;
  const near = ends.filter((b) => A.has(b) && A.get(b) <= 4 || isStart.has(b)).sort((x, y) => (A.get(x) || 0) - (A.get(y) || 0)), anyEnd = ends.filter((b) => B.has(b) || isStart.has(b));
  L.push(`ENDINGS within 4 hops: ${near.length ? ids(near.map(tag), 8) : 'none'}; reachable at all by forward roads ${anyEnd.length} of ${ends.length}`);
  const rest = [...A.entries()].filter(([, d]) => d > 2).map(([b]) => b), per = {};
  for (const b of rest) per[data.boxes[b].stage] = (per[data.boxes[b].stage] || 0) + 1;
  if (rest.length) { const ps = Object.entries(per).sort((x, y) => y[1] - x[1]); L.push(`BEYOND 2 HOPS ${rest.length} box(es), by stage: ${ps.slice(0, 6).map(([s, n]) => `${s} ${n}`).join(', ')}${ps.length > 6 ? ` +${ps.length - 6} stages` : ''}`); }
  const feeders = uniq(start.flatMap((s) => data.boxes[s].in.map((rid) => data.routes[rid].from))).filter((x) => !isStart.has(x));
  L.push(`DEPENDS ON (upstream ${up.size}): ${ids(feeders, 5) || 'nothing drawn feeds it'}`);
  const loops = data.loops.filter((l) => start.some((s) => l.boxes.includes(s)));
  if (loops.length) L.push('IN LOOPS: ' + loops.map((l) => `${l.id}${l.limit ? '' : ' (no limit shown)'}`).join(', '));
  const sw = uniq(start.map((s) => data.boxes[s].switch).filter(Boolean));
  if (sw.length) L.push('SETTINGS: ' + sw.join(', '));
  const cand = data.findings.filter((f) => f.shown && (f.boxes.some((b) => isStart.has(b) || A.has(b))));
  if (cand.length) L.push(`CANDIDATES in or after it: ${cand.slice(0, 3).map((f) => f.key).join(' ')}${cand.length > 3 ? ` +${cand.length - 3}` : ''}`);
  return finish(L, c.linkBox(id), T, `faultline impact ${id} --budget ${T * 2}`);
}

// ---------------------------------------------------------------------------------------------------------------- status
// FINISHED is printed only when the gates pass AND the page is built, current, and every chart has a layout. Anything less says what is missing.
export function status(data, o = {}) {
  if (data.toolMap) { const c0 = makeCtx(data, o); return finish(statusLines(data, data.layout && data.layout.page, o.refresh), c0.link('overview', null), c0.budget('status'), 'faultline status --budget ' + c0.budget('status') * 2); }
  const c = makeCtx(data, o), T = c.budget('status'), L = [], lay = data.layout, page = lay && lay.page;
  const gates = data.state === 'finished', allPlaced = !lay || (lay.placed === lay.charts && !lay.stale.length);
  const done = gates && allPlaced && (!lay || (page && page.built && page.current));
  const head = done ? 'FINISHED' : gates ? 'GATES PASS, NOT FINISHED' : data.state.toUpperCase();
  L.push(`STATUS ${head}${data.pin ? '  pin ' + pinSaid(data.pin) : ''}  ${data.counts.boxes} boxes, ${data.counts.routes} routes, ${data.counts.stages} stages`);
  if (data.gaps.length) { for (const g of data.gaps.slice(0, 2)) L.push(` gap ${g.code}: ${trunc(g.msg, 80)}`); if (data.gaps.length > 2) L.push(` ... ${data.gaps.length - 2} more gaps: faultline check`); }
  else L.push(gates ? ' no gaps: every gate passed' : ' no gaps');
  if (lay) {
    L.push(page && page.built ? (page.current ? `page: built ${String(page.builtAt).slice(0, 16).replace('T', ' ')}, current` : page.recorded === false ? 'page: built by an older version, cannot tell if current. Fix: faultline build' : `page: OUT OF DATE (${page.changed}). Fix: faultline build`) : 'page: NOT BUILT. Fix: faultline build');
    L.push(`charts placed: ${lay.placed}/${lay.charts}${lay.stale.length ? `, not placed: ${lay.stale.slice(0, 3).join(',')}${lay.stale.length > 3 ? ` +${lay.stale.length - 3}` : ''}` : ''}${lay.hard ? `, HARD metrics on ${lay.hard}` : ''}`);
  }
  const ev = data.evidence;
  L.push(ev && ev.walks ? `evidence: ${ev.walks} walk(s); stale ${ev.stale.reduce((n, s) => n + s.boxes.length, 0)}, unexplored ${ev.unexplored.length}` : 'evidence: no walks');
  L.push(`candidates: ${data.findings.filter((f) => f.shown).length} shown, ${data.findings.filter((f) => !f.shown && !f.lead && !(f.resolution && f.resolution.state === 'dismissed')).length} held back${data.findings.some((f) => f.lead) ? `, ${data.findings.filter((f) => f.lead && !(f.resolution && f.resolution.state === 'dismissed')).length} leads` : ''}`);
  L.push(done ? 'next: faultline brief' : data.gaps.length ? 'next: add ledger rows or boxes, then faultline check --finished' : 'next: faultline place, build --finished');
  return finish(L, c.link('overview', null, '&ev=1'), T, 'faultline status --budget ' + T * 2);
}

export const COMMANDS = { brief, where, breaks, path, impact, status };
