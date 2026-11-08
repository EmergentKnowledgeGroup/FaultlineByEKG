// FAKE EVIDENCE for the viewer's evidence-layer tests: given any atlasData (the parcel-desk fixture, the big grid, the large made-up map) it writes a believable
// chart.evidence on every chart, in the shape evidence.js reads (see the head of viewer/evidence.js). Nothing is run: a few seeded walks are simulated over the
// chart's own routes, candidates are found from the chart's own shape (a box whose only way out goes back, many roads in and one out, a loop with no limit shown,
// an ending no walk reached), and a handful of boxes are made proved, stale, or seen-stuck. Deterministic.
//   import { addFakeEvidence } from './fake-evidence.mjs';   addFakeEvidence(data, { seed: 3, walks: 4 });   // mutates and returns data
const CHECK_Q = {
  'can-only-go-back': (n) => `${n} roads in, only exit goes back upstream: what triggers the later request?`,
  'pile-up': (n) => `${n} roads in and one way out: does every road deserve the same next step?`,
  'no-way-out': () => 'Roads arrive and none is drawn leaving: where does the work go next?',
  'no-limit-loop': () => 'This loop shows no limit: what stops it repeating?',
  'hedged-route': () => 'A route is worded "sometimes": what decides it?',
  'ending-no-test': () => 'No walk reached this ending: is it reachable in real use?',
  'unreached-from-start': () => 'No drawn road leads here from the start: what enters here?'
};

function rng(seed) { let s = (seed * 2654435761) % 2147483647 || 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

export function addFakeEvidence(data, { seed = 3, walks = 4, maxFindings = 14 } = {}) {
  Object.values(data.charts).forEach((chart, ci) => { chart.evidence = evidenceFor(chart, seed + ci * 17, walks, maxFindings, data.meta); });
  return data;
}

export function evidenceFor(chart, seed, nWalks, maxFindings, meta) {
  const rnd = rng(seed), ids = Object.keys(chart.nodes), E = Object.values(chart.edges);
  const out = {}, inn = {}; ids.forEach(i => { out[i] = []; inn[i] = []; });
  E.forEach(e => { if (out[e.from]) out[e.from].push(e); if (inn[e.to]) inn[e.to].push(e); });
  const starts = ids.filter(i => !inn[i].length), ends = ids.filter(i => !out[i].length);
  const boxes = {}, routes = {}, walkList = [];
  const bump = (m, k, by = 1) => (m[k] = (m[k] || 0) + by);
  const counts = {}, rcounts = {};
  const tools = ['coverage.py@7', 'trace-replay', 'model-check'];
  for (let w = 0; w < nWalks; w++) {                                    // seeded walks over the chart's own routes
    let cur = (starts.length ? starts : ids)[Math.floor(rnd() * (starts.length || ids.length))];
    const path = [cur], used = [], len = 6 + Math.floor(rnd() * 22), times = 1 + Math.floor(rnd() * (w === 0 ? 40 : 6));
    for (let k = 0; k < len; k++) {
      const outs = out[cur]; if (!outs.length) break;
      const fwd = outs.filter(e => e.type !== 'return'), pool = (w % 2 && rnd() < 0.5) ? outs : (fwd.length ? fwd : outs), e = pool[Math.floor(rnd() * pool.length)];
      used.push(e.id); path.push(e.to); cur = e.to; if (path.length > 3 && rnd() < 0.04) break;
    }
    const last = path[path.length - 1], stuck = !chart.nodes[last].kind || (chart.nodes[last].kind !== 'end' && !out[last].length) || w === 2;
    new Set(path).forEach(b => bump(counts, b, times)); new Set(used).forEach(r => bump(rcounts, r, times));
    walkList.push({ id: 'walk' + (w + 1), tool: tools[w % tools.length], kind: w % 3 === 2 ? 'modelcheck' : w % 2 ? 'test' : 'run', outcome: (stuck ? 'stuck:' : 'end:') + last, strength: w === 2 ? 'proved-in-model' : w === 1 ? 'replayable' : 'observed', count: times,
      says: stuck ? `ended stuck at ${chart.nodes[last].title}` : `ended at ${chart.nodes[last].title}`, boxes: path, routes: used, _last: last, _stuck: stuck });
  }
  ids.forEach(id => {
    const n = counts[id]; if (!n) return;
    boxes[id] = { level: 'seen', count: n, modeled: 0, visits: 1 + Math.floor(n / 3), reasons: [`${tools[0]}: body ran`, `${tools[1]}: reached it`].slice(0, 1 + Math.floor(rnd() * 2)), stale: false, tools: [tools[0]] };
  });
  walkList.forEach(w => {
    if (w.strength === 'observed') { if (w._stuck && boxes[w._last]) { boxes[w._last].outcomes = ['stuck']; boxes[w._last].reasons.push(`${w.tool}: observed stuck here`); } return; }
    const b = boxes[w._last]; if (!b) return;
    b.level = 'proved'; b.count = w.strength === 'replayable' ? 1 : 0; b.modeled = w.strength === 'proved-in-model' ? 1 : 0; b.reasons = [`${w.strength === 'replayable' ? 'replayed' : 'proved in the model'} ${w._stuck ? 'stuck' : 'ended'} here (${w.tool})`];
    if (w._stuck) b.outcomes = ['stuck'];
    b.tools = [w.tool];
  });
  const seenIds = Object.keys(boxes);
  if (seenIds.length > 3) {                                             // one end box lit only because a cited line ran; one stale box
    const e = ends.find(x => boxes[x]); if (e) boxes[e].anchorOnly = true;
    const st = ids.find(x => !boxes[x] && rnd() < 0.5) || ids.find(x => !boxes[x]); if (st) boxes[st] = { level: 'drawn', count: 0, visits: 0, reasons: ['the cited function changed since the run'], stale: true, staleLevel: 'seen', tools: [tools[0]] };
  }
  Object.keys(rcounts).forEach(r => { routes[r] = { count: rcounts[r], maybe: 0, modeled: 0 }; });
  // candidates from the chart's own shape
  const F = [], add = (check, bs, rs, q, ev) => { if (F.length < maxFindings + 3) F.push({ key: check + ':' + (bs[0] || rs[0]), check, boxes: bs, routes: rs, level: 'suspected', question: q, evidence: 'candidate: ' + ev }); };
  ids.forEach(id => {
    const ins = inn[id], outs = out[id];
    if (ins.length >= 2 && outs.length && outs.every(e => e.type === 'return')) add('can-only-go-back', [id], [], CHECK_Q['can-only-go-back'](ins.length), `${ins.length} roads in, only exit goes back upstream`);
    else if (ins.length >= 3 && outs.length === 1) add('pile-up', [id], [], CHECK_Q['pile-up'](ins.length), `in from ${ins.slice(0, 4).map(e => e.from).join(', ')}; out ${outs[0].to}`);
    else if (ins.length && !outs.length && chart.nodes[id].kind !== 'end') add('no-way-out', [id], [], CHECK_Q['no-way-out'](), `${ins.length} roads in, none drawn out, kind ${chart.nodes[id].kind}`);
  });
  (chart.loops || []).forEach(l => { if (!l.limit && l.boxes && l.boxes.length) add('no-limit-loop', l.boxes.filter(b => chart.nodes[b]), [], CHECK_Q['no-limit-loop'](), `no limit shown on the loop ${l.title || l.id}`); });
  ends.filter(e => !boxes[e]).slice(0, 3).forEach(e => add('ending-no-test', [e], [], CHECK_Q['ending-no-test'](), 'not seen in the loaded test evidence'));
  E.filter(e => e.type === 'record').slice(0, 1).forEach(e => add('hedged-route', [], [e.id], CHECK_Q['hedged-route'](), `route ${e.id} says "sometimes", a hedge word with no condition`));
  const pick = ids.filter(i => !F.some(f => f.boxes.includes(i)) && out[i].length && inn[i].length);       // a small chart may show none of those shapes: give it a couple of plain ones
  while (F.length < 2 && pick.length) { const i = pick.splice(Math.floor(rnd() * pick.length), 1)[0]; add(F.length ? 'unreached-from-start' : 'pile-up', [i], [], F.length ? CHECK_Q['unreached-from-start']() : CHECK_Q['pile-up'](inn[i].length + 2), F.length ? 'no path from the start' : 'in from ' + inn[i].map(e => e.from).join(', ')); }
  const spread = [];                                                    // a spread of check kinds first, then the rest: the cap of ten must not hide a whole kind
  const kinds = [...new Set(F.map(f => f.check))];
  while (spread.length < F.length) kinds.forEach(k => { const f = F.find(x => x.check === k && !spread.includes(x)); if (f) spread.push(f); });
  const findings = spread.slice(0, maxFindings);
  walkList.push({ id: 'walk-nopath', tool: 'summary-only', kind: 'run', says: 'a count without a stored path', count: 5, boxes: [] });
  return {
    boxes, routes, findings, walks: walkList.map(({ _last, _stuck, ...w }) => w),
    notDrawn: (meta && meta.notDrawn) || { count: 3, items: ['jobs/cleanup.py', 'jobs/mailer.py', 'tools/seed.py'] },
    notMapped: [{ key: 'Queue.get', count: 4, why: 'cited by no box', example: { sym: 'pkg/queue.py::Queue.get' } }, { key: 'Queue.all_jobs', count: 1, why: 'cited by no box', example: { sym: 'pkg/queue.py::Queue.all_jobs' } }],
    missingRoutes: ids.length > 4 ? [{ from: [ids[1]], to: [ids[ids.length - 2]], count: 2, evidence: 'two steps in a row with no route between them' }] : [],
    unexplored: [{ walk: 'walk1', tool: tools[0], at: ids[ids.length - 1], boxes: [ids[ids.length - 1]], why: 'budget cut' }],
    stale: [{ walk: 'walk1', fn: 'pkg/queue.py::Queue.claim', boxes: [], why: 'the function changed since the run' }],
    labels: [
      { walk: 'walk1', tool: tools[0], kind: 'run', label: 'SAMPLED', effective: 'SAMPLED', controls_passed: false, says: 'sampled runs only: a stuck ending is not found in what was checked, but more may exist' },
      { walk: 'walk3', tool: tools[2], kind: 'modelcheck', label: 'BOUNDED_INCOMPLETE', effective: 'BOUNDED_INCOMPLETE', controls_passed: true, says: 'a bounded search of the model: not found in what was checked, the search stopped at its budget' }
    ],
    untested: ids.filter(i => !boxes[i]).slice(0, 2), neverSeen: ids.filter(i => !boxes[i])
  };
}
