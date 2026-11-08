// FIXTURE for the viewer: a tiny fake parcel system ("Parcel desk": intake, a durable queue with leases and retries, delivery and a report).
// It exists so the page can be tested alone, without the extractor, checker or placer. Nothing here is real code.
//   import { makeAtlasData } from './fixture.mjs';   const data = await makeAtlasData();          // the blob the page embeds (atlasData)
//   node viewer/fixture.mjs --freeze                  // re-runs the engine layout and rewrites viewer/fixture-geom.mjs (frozen geometry)
//   node viewer/fixture.mjs --out <file.json>         // writes the atlasData as JSON
// Geometry comes from the frozen fixture-geom.mjs when it exists (so a test never needs the layout engine), else from src/engine/gridlayout.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- the model: stages, boxes, routes, loops, terms --------------------------------------------------------------------------
export const STAGES = [
  { id: 's_intake', title: 'Intake', blurb: 'A parcel arrives and is checked against the weight and address rules, then accepted or refused.' },
  { id: 's_queue', title: 'Queue', blurb: 'Accepted parcels wait in a durable queue. A worker takes a lease, and a lost lease sends the parcel back for another try.' },
  { id: 's_delivery', title: 'Delivery', blurb: 'The parcel is handed to a courier and a receipt is written.' },
];

// [id, stage, kind, title, handle, status, plain, why, inputs, outputs, failure, ref(path::symbol@line), switch]
const B = (id, stage, kind, title, handle, status, plain, why, inputs, outputs, failure, ref, sw) => ({ id, stage, kind, title, handle, status, plain, why, inputs, outputs, failure, ref, sw });
export const BOXES = [
  B('intake.receive', 's_intake', 'step', 'Receive a parcel', '', 'live', 'A parcel arrives with a weight, an address and a customs value. The desk gives it an id and a time stamp.', 'Everything downstream needs one id per parcel.', ['weight, address, customs value'], ['parcel with an id'], 'A parcel with no weight is refused at the next check.', 'parcelworks/intake.py::receive@12'),
  B('intake.check_weight', 's_intake', 'decision', 'Is it light enough?', 'MAX_WEIGHT_G', 'live', 'The weight is compared with the limit. Over the limit means refusal; at or under means the address check comes next.', 'Heavy parcels need a different carrier.', ['parcel'], ['pass or refusal'], 'A missing limit setting falls back to the built-in default.', 'parcelworks/intake.py::check_weight@28'),
  B('intake.check_address', 's_intake', 'decision', 'Is the address usable?', '', 'live', 'The address needs a street, a city and a postal code. A missing part means refusal.', 'A parcel with no usable address can never be delivered.', ['parcel'], ['pass or refusal'], 'An address in an unknown format is refused as incomplete.', 'parcelworks/intake.py::check_address@41'),
  B('intake.refuse', 's_intake', 'end', 'Refuse the parcel', '', 'live', 'The parcel is turned away with a code that says which rule it broke. Nothing is queued.', 'The sender can fix the problem and try again.', ['parcel', 'rule code'], ['refusal notice'], '', 'parcelworks/intake.py::refuse@57', ''),
  B('intake.accept', 's_intake', 'step', 'Accept the parcel', '', 'live', 'The parcel passed every rule. It is stamped as accepted and written to the intake log.', 'Only accepted parcels may enter the queue.', ['parcel'], ['accepted parcel'], 'If the log write fails the parcel is not accepted.', 'parcelworks/intake.py::accept@66'),
  B('intake.log', 's_intake', 'store', 'Intake log', '', 'live', 'An append-only list of every accepted parcel, kept so a person can see what came in and when.', 'It is the record an auditor reads first.', ['accepted parcel'], ['log line'], '', 'parcelworks/intake.py::append_log@80'),
  B('queue.pending', 's_queue', 'store', 'Pending queue', '', 'live', 'Parcels wait here, oldest first, until a worker is free to take one.', 'A durable queue survives a restart.', ['accepted parcel'], ['next parcel'], 'A full disk stops new parcels from being queued.', 'parcelworks/jobqueue.py::Queue.enqueue@22'),
  B('queue.claim', 's_queue', 'step', 'Claim the next parcel', '', 'live', 'A free worker takes the oldest waiting parcel and marks it as taken.', 'Two workers must never take the same parcel.', ['pending parcel'], ['claimed parcel'], 'If the queue is empty the worker waits.', 'parcelworks/jobqueue.py::Queue.claim@40'),
  B('queue.lease', 's_queue', 'wait', 'Hold the lease', 'Lease', 'live', 'The worker holds a time-limited lease on the parcel. If the worker goes quiet the lease runs out.', 'A lease lets the system recover a parcel from a dead worker.', ['claimed parcel'], ['finished work or an expired lease'], 'A lease that is never renewed expires.', 'parcelworks/worker.py::Worker.hold@28'),
  B('queue.expire', 's_queue', 'step', 'Lease ran out', '', 'live', 'The lease timer ended before the work finished. The parcel is taken back from the worker.', 'Without this a crashed worker would keep a parcel forever.', ['expired lease'], ['released parcel'], '', 'parcelworks/jobqueue.py::Queue.reclaim@88'),
  B('queue.retry', 's_queue', 'decision', 'Any attempts left?', 'MAX_ATTEMPTS', 'default-on', 'The attempt count is compared with the limit. Below the limit the parcel goes round again after a delay; at the limit it fails for good.', 'It is what stops the retry loop.', ['released parcel', 'attempt count'], ['retry or failure'], 'A limit of zero fails every parcel on the first lost lease.', 'parcelworks/jobqueue.py::Queue.fail@104', 'MAX_ATTEMPTS'),
  B('queue.backoff', 's_queue', 'wait', 'Wait before trying again', 'Backoff', 'live', 'The parcel waits a little longer after every failed try, so a struggling worker is not hammered.', 'Spreads retries out in time.', ['released parcel'], ['parcel ready again'], '', 'parcelworks/jobqueue.py::backoff_delay@96'),
  B('queue.fail', 's_queue', 'end', 'Fail the parcel', '', 'live', 'The parcel ran out of attempts. It is marked failed and a person is told.', 'A parcel that cannot be delivered must not stay hidden in the queue.', ['released parcel'], ['failure notice'], '', 'parcelworks/jobqueue.py::Queue.fail@104'),
  B('delivery.pick', 's_delivery', 'step', 'Pick the lane', '', 'live', 'The worker decides which lane carries the parcel: the normal lane, or the express lane when it is switched on.', 'Express is optional and off until someone turns it on.', ['leased parcel'], ['lane'], '', 'parcelworks/worker.py::Worker.pick_lane@52'),
  B('delivery.fast_lane', 's_delivery', 'gate', 'Express lane open?', 'FAST_LANE', 'off', 'When the express switch is on and a slot is free the parcel skips the normal courier queue.', 'Lets a team try express delivery without changing the normal path.', ['lane choice'], ['express slot or normal lane'], 'With the switch off this box is never reached.', 'parcelworks/worker.py::express_open@60', 'FAST_LANE'),
  B('delivery.handoff', 's_delivery', 'external', 'Courier takes the parcel', '', 'live', 'The courier collects the parcel. Everything after this point happens outside the desk.', 'The desk can only record what the courier tells it.', ['parcel'], ['courier receipt'], 'A courier that never confirms leaves the parcel with no outcome.', 'parcelworks/worker.py::Worker.handoff@70'),
  B('delivery.report', 's_delivery', 'step', 'Write the receipt', 'Receipt', 'live', 'The delivery result is written to the receipts file so a person can look it up later.', 'The receipt is the proof that the parcel left the desk.', ['courier receipt'], ['saved receipt'], 'A failed write is tried again.', 'parcelworks/report.py::save_receipt@18'),
  B('delivery.retry_write', 's_delivery', 'decision', 'Receipt write failed?', '', 'live', 'The receipts file could not be written. The write is tried again straight away.', 'A lost receipt would leave no record of the delivery.', ['write error'], ['another try'], 'Nothing in the drawing says how many times this repeats.', 'parcelworks/report.py::save_receipt@34'),
  B('delivery.done', 's_delivery', 'end', 'Delivered', '', 'live', 'The courier confirmed and the receipt is saved. The parcel is finished.', 'This is the happy ending.', ['saved receipt'], ['delivered parcel'], '', 'parcelworks/report.py::finish@52'),
  B('delivery.lost', 's_delivery', 'end', 'Parcel lost in transit', '', 'test-only', 'The courier reports the parcel as lost. Only a test can reach this ending today.', 'It documents a failure the real system should plan for.', ['courier report'], ['lost notice'], 'No real run has produced this ending yet.', 'parcelworks/report.py::mark_lost@64'),
];
const OUTCOME = { 'intake.refuse': 'refusal', 'queue.fail': 'failure', 'delivery.done': 'success', 'delivery.lost': 'failure' };

// [id, from, to, type, when, why, inferred]
const R = (id, from, to, type, when, why, inferred) => ({ id, from, to, type: type || 'forward', when: when || '', why: why || '', inferred: !!inferred });
export const ROUTES = [
  R('r_recv', 'intake.receive', 'intake.check_weight', 'forward', '', 'Every parcel is weighed first.'),
  R('r_heavy', 'intake.check_weight', 'intake.refuse', 'forward', 'Over MAX_WEIGHT_G', 'The weight is above the limit setting.'),
  R('r_light', 'intake.check_weight', 'intake.check_address', 'forward', 'Within the limit', 'The weight is at or under the limit.'),
  R('r_noaddr', 'intake.check_address', 'intake.refuse', 'forward', 'Address incomplete', 'Street, city or postal code is missing.'),
  R('r_addr', 'intake.check_address', 'intake.accept', 'forward', 'Address usable', 'All three address parts are present.'),
  R('r_logit', 'intake.accept', 'intake.log', 'record', '', 'Each accepted parcel is appended to the intake log.'),
  R('r_enq', 'intake.accept', 'queue.pending', 'forward', '', 'The accepted parcel joins the queue.'),
  R('r_claim', 'queue.pending', 'queue.claim', 'forward', 'Worker free', 'A free worker asks the queue for work.'),
  R('r_hold', 'queue.claim', 'queue.lease', 'forward', '', 'Taking a parcel starts its lease.'),
  R('r_leased', 'queue.lease', 'delivery.pick', 'forward', 'Lease held', 'The worker still holds the lease and carries on.'),
  R('r_timeout', 'queue.lease', 'queue.expire', 'forward', 'Lease timed out', 'The lease timer ended before the work did.'),
  R('r_recl', 'queue.expire', 'queue.retry', 'forward', '', 'A released parcel counts as one more attempt.'),
  R('r_more', 'queue.retry', 'queue.backoff', 'forward', 'Attempts left', 'The attempt count is below MAX_ATTEMPTS.'),
  R('r_cap', 'queue.retry', 'queue.fail', 'forward', 'MAX_ATTEMPTS reached', 'The attempt count reached the limit.'),
  R('r_again', 'queue.backoff', 'queue.pending', 'return', 'After the delay', 'The parcel goes back to the queue once the delay has passed.'),
  R('r_lane', 'delivery.pick', 'delivery.fast_lane', 'forward', 'Express on', 'The express switch is on.'),
  R('r_norm', 'delivery.pick', 'delivery.handoff', 'forward', 'Normal lane', 'The express switch is off.'),
  R('r_exp', 'delivery.fast_lane', 'delivery.handoff', 'deliver', 'Slot free', 'An express slot is free.'),
  R('r_courier', 'delivery.handoff', 'delivery.report', 'deliver', 'Courier confirms', 'The courier sent a receipt.', true),
  R('r_lost', 'delivery.handoff', 'delivery.lost', 'forward', 'Courier reports loss', 'The courier says the parcel is gone.', true),
  R('r_wfail', 'delivery.report', 'delivery.retry_write', 'forward', 'Write failed', 'The receipts file could not be written.'),
  R('r_wagain', 'delivery.retry_write', 'delivery.report', 'return', 'Try again', 'The write is repeated at once.'),
  R('r_done', 'delivery.report', 'delivery.done', 'forward', 'Receipt saved', 'The receipt is on disk.'),
];

export const LOOPS = [
  { id: 'l_retry', title: 'Retry loop', blurb: 'A lost lease sends the parcel back to the queue after a delay.', boxes: ['queue.pending', 'queue.claim', 'queue.lease', 'queue.expire', 'queue.retry', 'queue.backoff'], limit: 'MAX_ATTEMPTS' },
  { id: 'l_write', title: 'Receipt write retry', blurb: 'A failed receipt write is repeated at once.', boxes: ['delivery.report', 'delivery.retry_write'], limit: '' },
];
export const SPINE = ['intake.receive', 'intake.check_weight', 'intake.check_address', 'intake.accept', 'queue.pending', 'queue.claim', 'queue.lease', 'delivery.pick', 'delivery.handoff', 'delivery.report', 'delivery.done'];

export const TERMS = [
  { term: 'Lease', meaning: 'A time-limited claim a worker holds on a parcel. If the worker goes quiet the lease runs out and the parcel can be taken back.', family: 'Concept' },
  { term: 'Backoff', meaning: 'A delay that grows after every failed try, so retries are spread out.', family: 'Concept' },
  { term: 'Receipt', meaning: 'The saved record that a parcel left the desk and what became of it.', family: 'Concept' },
  { term: 'MAX_WEIGHT_G', meaning: 'Setting: the heaviest parcel the desk accepts, in grams.', family: 'Setting' },
  { term: 'MAX_ATTEMPTS', meaning: 'Setting: how many times a parcel may be tried before it fails for good.', family: 'Setting' },
  { term: 'FAST_LANE', meaning: 'Switch: lets parcels use the express lane. Off by default.', family: 'Setting', aliases: ['express'] },
];

// ---- charts: which boxes each shows and how they sit on the grid (gridLayout config: one string per row, "." is an empty cell) ----
const OV_BOXES = [
  { id: 's_intake', title: 'Intake', kind: 'step', plain: 'A parcel arrives and is weighed and checked.', stage: 's_intake', ref: 'parcelworks/intake.py::receive@12' },
  { id: 's_queue', title: 'Queue', kind: 'store', plain: 'Accepted parcels wait for a worker, with leases and retries.', stage: 's_queue', ref: 'parcelworks/jobqueue.py::Queue.claim@40' },
  { id: 's_delivery', title: 'Delivery', kind: 'external', plain: 'A courier takes the parcel and a receipt is saved.', stage: 's_delivery', ref: 'parcelworks/worker.py::Worker.handoff@70' },
  { id: 'end_refused', title: 'Refused', kind: 'end', plain: 'The parcel broke a rule and was turned away.', ref: 'parcelworks/intake.py::refuse@57', outcome: 'refusal' },
  { id: 'end_done', title: 'Delivered', kind: 'end', plain: 'The courier confirmed and the receipt is saved.', ref: 'parcelworks/report.py::finish@52', outcome: 'success' },
];
const OV_ROUTES = [
  R('o1', 's_intake', 's_queue', 'forward', 'Parcel accepted', 'Only accepted parcels are queued.'),
  R('o2', 's_intake', 'end_refused', 'forward', 'Parcel refused', 'A weight or address rule failed.'),
  R('o3', 's_queue', 's_delivery', 'forward', 'Lease held', 'A worker holds the lease and carries on.'),
  R('o4', 's_delivery', 'end_done', 'deliver', 'Receipt saved', 'The courier confirmed.'),
];
export const CHART_DEFS = [
  { id: 'overview', title: 'The parcel desk at a glance', navLabel: 'Overview', navSub: 'Three stages from arrival to delivery', kind: 'overview',
    summary: 'A parcel arrives, waits in a durable queue, is handed to a courier and ends as delivered or refused. Each box here opens a finer chart.',
    ov: true, map: ['s_intake s_queue s_delivery end_done', 'end_refused . . .'], flow: { role: 'overview', order: 1, next: ['stage_intake'], blurb: 'Start here: the three stages and the two ends.' } },
  { id: 'stage_intake', title: 'Intake: receive, check, accept or refuse', navLabel: 'Intake', navSub: 'Weight and address rules', kind: 'stage', stage: 's_intake',
    summary: 'A parcel arrives and is checked against the weight limit and the address rules. It is either accepted into the queue or refused with a reason.',
    map: ['intake.receive intake.check_weight intake.check_address intake.accept', '. intake.refuse . intake.log'], flow: { role: 'stage', order: 2, prev: ['overview'], next: ['stage_queue'], blurb: 'The first stage. Accepted parcels join the queue.' } },
  { id: 'stage_queue', title: 'Queue: claim, lease, expire, retry', navLabel: 'Queue', navSub: 'Leases and the retry loop', kind: 'stage', stage: 's_queue',
    summary: 'Accepted parcels wait here. A worker takes a lease; if the lease runs out the parcel goes back after a delay, up to a fixed number of attempts.',
    map: ['queue.pending queue.claim queue.lease queue.expire', 'queue.backoff . . queue.retry', '. . . queue.fail'], flow: { role: 'loop', order: 3, prev: ['stage_intake'], next: ['stage_delivery'], blurb: 'Leases and retries live here.' } },
  { id: 'stage_delivery', title: 'Delivery: pick a lane, hand over, write the receipt', navLabel: 'Delivery', navSub: 'Express switch and receipt', kind: 'stage', stage: 's_delivery',
    summary: 'The worker picks a lane (express is off by default), the courier takes the parcel and a receipt is written. Writing the receipt can repeat.',
    map: ['delivery.pick delivery.handoff delivery.report delivery.done', 'delivery.fast_lane delivery.lost delivery.retry_write .'], flow: { role: 'stage', order: 4, prev: ['stage_queue'], next: ['whole'], blurb: 'The last stage.' } },
  { id: 'whole', title: 'The whole parcel desk, end to end', navLabel: 'Whole system', navSub: 'Every box on one map', kind: 'whole',
    summary: 'All three stages on one map: intake on the left, the queue in the middle and delivery below it. Hover a stage in the Regions list to light it up.',
    all: true, map: [
      'intake.receive intake.check_weight intake.check_address . queue.pending queue.claim queue.lease',
      '. intake.refuse intake.accept . queue.backoff queue.retry queue.expire',
      '. . intake.log . . queue.fail .',
      '. . . . . . .',
      '. . . . delivery.pick delivery.fast_lane .',
      '. . . . delivery.handoff delivery.report delivery.done',
      '. . . . delivery.lost delivery.retry_write .'],
    flow: { role: 'whole', order: 5, prev: ['stage_delivery'], blurb: 'Everything on one page.' } },
];

// ---- assembling atlasData ------------------------------------------------------------------------------------------------------
const refOf = s => { const m = /^(.*)::(.*)@(\d+)$/.exec(s || ''); return m ? [{ path: m[1], symbol: m[1] + '::' + m[2], line: +m[3] }] : []; };
const nodeData = b => ({ id: b.id, title: b.title, kind: b.kind, status: b.status || 'live', handle: b.handle || '', plain: b.plain, summary: b.plain, why: b.why || '', inputs: b.inputs || [], outputs: b.outputs || [], failure: b.failure || '',
  refs: refOf(b.ref), switch: b.sw || '', outcome: b.outcome || OUTCOME[b.id] || '', stage: b.stage || '', family: b.stage || '' });

function chartParts(def) {
  const boxes = def.ov ? OV_BOXES : BOXES.filter(b => def.all || b.stage === def.stage);
  const ids = new Set(boxes.map(b => b.id));
  const routes = (def.ov ? OV_ROUTES : ROUTES).filter(r => ids.has(r.from) && ids.has(r.to));
  return { boxes, routes };
}
export function graphOf(def) {
  const { boxes, routes } = chartParts(def);
  return { id: def.id, title: def.title, nodes: boxes.map(b => ({ id: b.id, title: b.title, kind: b.kind, ...(b.handle ? { handle: b.handle } : {}), family: b.stage || '' })),
    edges: routes.map(r => ({ id: def.id + ':' + r.id, from: r.from, to: r.to, type: r.type, label: r.when, ...(r.inferred ? { inferred: true } : {}) })) };
}
export function layoutCfgOf(def) {
  const cfg = { map: def.map, gapX: 120, gapY: 64 };
  if (def.all) {
    cfg.groups = STAGES.map(s => ({ id: s.id, title: s.title.toUpperCase(), nodes: BOXES.filter(b => b.stage === s.id).map(b => b.id), pad: 26 }));
    cfg.spine = SPINE; cfg.colGap = { 2: 60 }; cfg.rowGap = { 2: 40 };
  }
  return cfg;
}

// geom: the frozen file when present, else the engine (src/engine/gridlayout.mjs)
async function geomFor(def, frozen) {
  if (frozen && frozen[def.id]) return frozen[def.id];
  const { gridLayout } = await import(pathToFileURL(path.join(here, '..', 'src', 'engine', 'gridlayout.mjs')).href);
  return JSON.parse(JSON.stringify(await gridLayout(graphOf(def), layoutCfgOf(def))));
}
async function loadFrozen() {
  const f = path.join(here, 'fixture-geom.mjs');
  if (!fs.existsSync(f)) return null;
  try { return (await import(pathToFileURL(f).href)).default; } catch { return null; }
}

export async function makeAtlasData({ live = false } = {}) {
  const frozen = live ? null : await loadFrozen();
  const charts = {};
  for (const def of CHART_DEFS) {
    const { boxes, routes } = chartParts(def), geom = await geomFor(def, frozen);
    const nodes = {};
    boxes.forEach(b => { nodes[b.id] = def.ov ? { id: b.id, title: b.title, kind: b.kind, status: 'live', handle: '', plain: b.plain, summary: b.plain, why: '', inputs: [], outputs: [], failure: '', refs: refOf(b.ref), switch: '', outcome: b.outcome || '', stage: b.stage || '', family: b.stage || '' } : nodeData(b); });
    const srcRef = {}; BOXES.forEach(b => { srcRef[b.id] = refOf(b.ref); });
    const edges = {};
    routes.forEach(r => { const id = def.id + ':' + r.id; edges[id] = { id, from: r.from, to: r.to, type: r.type, label: r.when, short: r.when, why: r.why, refs: srcRef[r.from] || [], inferred: r.inferred }; });
    const c = { id: def.id, title: def.title, navLabel: def.navLabel, navSub: def.navSub, codes: [...new Set(boxes.map(b => b.handle).filter(Boolean))], summary: def.summary, kind: def.kind,
      geom, nodes, edges, metrics: { size: [geom.width, geom.height] }, flow: def.flow, portals: [] };
    if (def.all) {
      c.stages = STAGES.map(s => ({ id: s.id, title: s.title, blurb: s.blurb }));
      c.regions = STAGES.map(s => ({ id: s.id, title: s.title, kind: 'stage', blurb: s.blurb, nodes: BOXES.filter(b => b.stage === s.id).map(b => b.id) }))
        .concat(LOOPS.map(l => ({ id: l.id, title: l.title, kind: 'loop', blurb: l.blurb, limit: l.limit, nodes: l.boxes })));
      c.spine = SPINE;
    } else if (def.stage) {
      c.loops = LOOPS.filter(l => l.boxes.every(id => nodes[id])).map(l => ({ id: l.id, title: l.title, blurb: l.blurb, boxes: l.boxes, limit: l.limit }));
      c.spine = SPINE.filter(id => nodes[id]);
    }
    charts[def.id] = c;
  }
  const P = (chart, node, dir, other, node2, label, why, kind = 'handoff') => charts[chart].portals.push({ id: chart + ':' + node + ':' + dir, node, dir, chart: other, node2, kind, label, why });
  P('stage_intake', 'intake.accept', 'out', 'stage_queue', 'queue.pending', 'Accepted parcels join the queue', 'Only accepted parcels are queued.');
  P('stage_queue', 'queue.pending', 'in', 'stage_intake', 'intake.accept', 'Accepted parcels arrive', 'The queue is fed by intake.');
  P('stage_queue', 'queue.lease', 'out', 'stage_delivery', 'delivery.pick', 'Lease held: carry on to delivery', 'A held lease means the worker may deliver.');
  P('stage_delivery', 'delivery.pick', 'in', 'stage_queue', 'queue.lease', 'A leased parcel arrives', 'Delivery only starts for a parcel with a lease.');
  for (const [from, to, first] of [['s_intake', 'stage_intake', 'intake.receive'], ['s_queue', 'stage_queue', 'queue.pending'], ['s_delivery', 'stage_delivery', 'delivery.pick']]) P('overview', from, 'out', to, first, 'Open this stage in detail', 'The finer chart for this stage.', 'detail');
  return {
    meta: { title: 'Parcel desk · interactive atlas', draft: true, pin: 'fixture-0001', sourceBase: 'https://example.invalid/parcelworks/blob/main/',
      census: { endings: { total: 14, accounted: 4 }, branches: { total: 22, accounted: 9 }, passes: { total: 6, accounted: 2 }, modules: { total: 9, accounted: 8 } },
      notDrawn: { count: 6, items: [{ path: 'parcelworks/cli.py', why: 'no box cites it yet' }, { path: 'parcelworks/config.py', why: 'settings are named but not drawn' }, { path: 'web/client.ts', why: 'the status client has no stage yet' }, { path: 'web/status.ts', why: 'no box cites it yet' }, { path: 'parcelworks/jobqueue.py::Queue.hold', why: 'a road out of the lease is not drawn' }, { path: 'parcelworks/report.py::OSError branch', why: 'the failing write is only partly drawn' }] },
      roleWords: { loop: 'Retry loop' } },
    nav: [{ group: 'Start here', items: ['overview', 'whole'] }, { group: 'Stages', items: ['stage_intake', 'stage_queue', 'stage_delivery'] }],
    charts, terms: TERMS,
    paths: [{ id: 'main', title: 'Main path', blurb: 'A parcel from the door to the courier.', boxes: SPINE }],
    breaks: [
      { key: 'sticky-flag:a', check: 'sticky-flag', state: 'suspect', boxes: ['queue.lease'], routes: [], question: 'A lease is set, and nothing clears it after a stop. Does anything read it?', evidence: 'candidate: a flag is set at parcelworks/jobqueue.py:88', stage: 's_queue', why: 'Read the code: the stop path skips the clear.' },
      { key: 'wait:queue.pending', check: 'wait-no-timeout', state: 'wait', boxes: ['queue.pending'], routes: [], question: 'What ends this wait if nothing arrives?', evidence: 'No timeout or time-based exit is drawn.', stage: 's_queue' },
      { key: 'loop:l_write', check: 'no-limit-loop', state: 'loop', boxes: ['delivery.report', 'delivery.handoff'], routes: [], question: 'What stops this loop?', evidence: 'Loop: no limit is shown on the map.', stage: 's_delivery' },
      { key: 'swallowed-error:x', check: 'swallowed-error', state: 'lead', boxes: ['intake.check_weight'], routes: [], question: 'This failure disappears here. Who finds out?', evidence: 'candidate: an error is caught at parcelworks/cli.py:9', stage: 's_intake' },
      { key: 'shared-decision:d', check: 'shared-decision', state: 'dismissed', boxes: ['intake.accept'], routes: [], question: 'This is reached from three places. What has each finished?', evidence: 'candidate', stage: 's_intake', why: 'All three callers finish the weight check first.' }
    ],
    sections: [{ id: 'sec_arrive', title: 'Arrive', charts: ['overview', 'stage_intake'] }, { id: 'sec_wait', title: 'Wait and retry', charts: ['stage_queue'] }, { id: 'sec_hand', title: 'Hand over', charts: ['stage_delivery', 'whole'] }],
  };
}

// ---- command line ----------------------------------------------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2), flag = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
  if (args.includes('--freeze')) {
    const geoms = {};
    for (const def of CHART_DEFS) { geoms[def.id] = await geomFor(def, null); console.log('laid out', def.id, geoms[def.id].nodes.length, 'boxes', Math.round(geoms[def.id].width) + 'x' + Math.round(geoms[def.id].height)); }
    fs.writeFileSync(path.join(here, 'fixture-geom.mjs'), '// Frozen geometry for the viewer fixture (generated by: node viewer/fixture.mjs --freeze). Do not edit by hand.\nexport default ' + JSON.stringify(geoms) + ';\n');
    console.log('wrote viewer/fixture-geom.mjs');
  }
  if (flag('out')) { const d = await makeAtlasData({ live: args.includes('--live') }); fs.writeFileSync(path.resolve(flag('out')), JSON.stringify(d)); console.log('wrote', flag('out'), Object.keys(d.charts).length, 'charts'); }
}
