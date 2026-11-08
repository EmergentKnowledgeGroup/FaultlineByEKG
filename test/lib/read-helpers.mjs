// An invented map of the fixture project "shop" (fixtures/read/shop), written out by hand in the shape the tool's map has.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHOP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'read', 'shop');
const P = 'src/orders.ts';
export const FN = {
  place: `${P}::Orders.placeOrder`, validate: `${P}::Orders.validate`, retry: `${P}::Orders.withRetry`, charge: `${P}::Orders.charge`,
  notify: `${P}::Orders.notify`, handler: `${P}::handler`, lonely: `${P}::lonely`,
};

let boxes;
let routes;

function box(id, fn, line, kind, rule, title, extra = {}) {
  const b = { id, kind, title, detail: extra.detail ?? title, plain: '', stage: 's_src', status: 'live', handle: fn.split('::')[1], refs: [{ path: P, line, symbol: fn }], prov: { fn, line, rule, src: 'det', ...(extra.prov ?? {}) } };
  if (extra.outcome) b.outcome = extra.outcome;
  boxes.push(b);
}

function road(from, to, type, when, prov = {}) {
  routes.push({ id: `${from}->${to}:${when}`, from, to, type, when, why: '', refs: [], inferred: false, prov: { rule: 'cfg-edge', tier: 'proven', basis: 'control-flow', src: 'det', line: 0, ...prov } });
}

/** @returns {{model:object, claims:object[], facts:object, root:string}} */
export function makeShop({ only } = {}) {
  boxes = [];
  routes = [];
  const f = FN;
  // placeOrder
  box('po.s0', f.place, 6, 'step', 'step', 'runs Orders.placeOrder');
  box('po.d1', f.place, 6, 'decision', 'decision', '!id', { prov: { arms: 2, why: 'E' } });
  box('po.e0', f.place, 7, 'end', 'end', 'raises Error: missing id', { outcome: 'failure', prov: { class: 'raise:Error', sites: [7] } });
  box('po.s2', f.place, 9, 'step', 'step', 'calls Orders.validate');
  box('po.t3', f.place, 10, 'step', 'try', 'tries this.withRetry');
  box('po.h4', f.place, 12, 'step', 'handler', 'on *: print', { prov: { disposition: 'print' } });
  box('po.s5', f.place, 13, 'store', 'step', 'does print', { prov: { effects: ['print'] } });
  road('po.s0', 'po.d1', 'forward', 'then');
  road('po.d1', 'po.e0', 'forward', '!id');
  road('po.d1', 'po.s2', 'forward', 'else');
  road('po.s2', 'po.t3', 'forward', 'then');
  road('po.t3', 'po.h4', 'forward', 'if it fails', { rule: 'exc-edge', tier: 'may' });
  road('po.h4', 'po.s5', 'forward', 'then');
  // validate
  box('va.s0', f.validate, 19, 'step', 'step', 'runs Orders.validate');
  box('va.d1', f.validate, 19, 'decision', 'decision', 'id.length > 40');
  box('va.e0', f.validate, 20, 'end', 'end', 'raises Error: id too long', { outcome: 'failure', prov: { class: 'raise:Error', sites: [20] } });
  box('va.e1', f.validate, 22, 'end', 'end', 'returns true', { outcome: 'success', prov: { class: 'R:const:bool', sites: [22] } });
  road('va.s0', 'va.d1', 'forward', 'then');
  road('va.d1', 'va.e0', 'forward', 'id.length > 40');
  road('va.d1', 'va.e1', 'forward', 'else');
  // withRetry
  box('wr.s0', f.retry, 26, 'step', 'step', 'runs Orders.withRetry');
  box('wr.e0', f.retry, 26, 'end', 'end', 'returns the result of fn() to its caller (entry)', { outcome: 'success', prov: { class: 'RB:call:fn', sites: [26] } });
  road('wr.s0', 'wr.e0', 'forward', 'then');
  // charge
  box('ch.s0', f.charge, 30, 'step', 'step', 'runs Orders.charge');
  box('ch.d1', f.charge, 30, 'decision', 'decision', 'this.opts.autoCharge');
  box('ch.st2', f.charge, 31, 'store', 'step', 'does store', { prov: { effects: ['store'] } });
  box('ch.e3', f.charge, 33, 'end', 'end', 'returns { ok: true }', { outcome: 'success', prov: { class: 'R:dict', sites: [33] } });
  road('ch.s0', 'ch.d1', 'forward', 'then');
  road('ch.d1', 'ch.st2', 'record', 'this.opts.autoCharge');
  road('ch.d1', 'ch.e3', 'forward', 'else');
  road('ch.st2', 'ch.e3', 'forward', 'then');
  // notify
  box('no.st0', f.notify, 37, 'store', 'step', 'does store', { prov: { effects: ['store'] } });
  // handler
  box('ha.d0', f.handler, 42, 'decision', 'decision', "req.url === '/api/orders'");
  box('ha.e1', f.handler, 43, 'end', 'end', 'returns the result of placeOrder() to its caller (entry)', { outcome: 'success', prov: { class: 'RB:call:placeOrder', sites: [43] } });
  box('ha.e2', f.handler, 45, 'end', 'end', 'returns a value to its caller (entry)', { outcome: 'success', prov: { class: 'RB', sites: [45] } });
  road('ha.d0', 'ha.e1', 'forward', "req.url === '/api/orders'");
  road('ha.d0', 'ha.e2', 'forward', 'else');
  // lonely
  box('lo.e0', f.lonely, 49, 'end', 'end', 'returns 1', { outcome: 'success', prov: { class: 'R:const:int', sites: [49] } });
  // call roads the map draws (the others are left for the scanner to supply)
  road('po.s2', 'va.s0', 'forward', 'calls Orders.validate', { rule: 'call', line: 9, lines: [9], how: 'self' });
  road('po.t3', 'wr.s0', 'forward', 'calls Orders.withRetry', { rule: 'call', line: 11, lines: [11], how: 'self' });
  road('ha.d0', 'po.s0', 'forward', 'calls Orders.placeOrder', { rule: 'call', line: 43, lines: [43], how: 'typed' });

  const keep = only ? boxes.filter((b) => only.includes(b.prov.fn)) : boxes;
  const ids = new Set(keep.map((b) => b.id));
  const model = { schema: 'faultline.model/1', tool: 'test', system: { name: 'shop', resolvers: {}, environment: {}, says: [], undecided: {}, unread: [] }, stages: [], boxes: keep, routes: routes.filter((r) => ids.has(r.from) && ids.has(r.to)), loops: [], paths: [], charts: [], terms: [] };
  const claim = (type, subject, extra) => ({ id: `${type}:${subject}`, type, subject, conf: 'confident', pinned: true, ...extra });
  const claims = [
    claim('effect', 'ch.st2', { call: 'this.db.save', says: 'does store', effect: 'store', line: 31, path: P, fn: f.charge, reason: 'definition-by-checker' }),
    claim('effect', 'no.st0', { call: 'this.queue.push', says: 'does store', effect: 'store', line: 37, path: P, fn: f.notify, reason: 'definition-by-checker' }),
    claim('hears', 'po.e0', { says: 'heard by caller', reason: 'heard', path: P, fn: f.place, line: 7 }),
    claim('hears', 'va.e0', { says: 'who hears', conf: 'not-confident', reason: 'heard-unknown', path: P, fn: f.validate, line: 20 }),
  ];
  const fx = (qual, line, end, calls, callAt, branches, extra = {}) => ({ path: P, qual, line, end, doc: '', async: false, decorators: [], calls, unresolved: [], branches, returns: [], raises: [], excepts: [], loops: [], callAt, ...extra });
  const facts = {
    schema: 'faultline.facts/1',
    modules: [{ path: P, lang: 'ts', lines: 50, imports: [], doc: '' }],
    functions: {
      [f.place]: fx('Orders.placeOrder', 5, 16, [f.validate, f.retry, f.charge, f.notify], [[0, 9], [1, 11], [2, 11], [3, 14]], [
        { line: 6, kind: 'if', test: '!id', end: 8, then: [7, 7], tk: 'bool', tt: 'raise', et: 'none' },
        { line: 10, kind: 'try', test: 'except Error', end: 15, then: [11, 11], tk: 'try', tt: 'return', else: [12, 15], et: 'other' },
      ], { doc: 'Place one order for a customer.' }),
      [f.validate]: fx('Orders.validate', 18, 23, [], [], [{ line: 19, kind: 'if', test: 'id.length > 40', end: 21, then: [20, 20], tk: 'cmp', tt: 'raise', et: 'none' }]),
      [f.retry]: fx('Orders.withRetry', 25, 27, [], [], []),
      [f.charge]: fx('Orders.charge', 29, 34, [], [], [{ line: 30, kind: 'if', test: 'this.opts.autoCharge', end: 32, then: [31, 31], tk: 'none', tt: 'other', et: 'none' }]),
      [f.notify]: fx('Orders.notify', 36, 38, [], [], []),
      [f.handler]: fx('handler', 41, 46, [f.place], [[0, 43]], [{ line: 42, kind: 'if', test: "req.url === '/api/orders'", end: 44, then: [43, 43], tk: 'cmp', tt: 'return', et: 'none' }]),
      [f.lonely]: fx('lonely', 48, 50, [], [], []),
    },
    entries: [
      { fn: f.place, kind: 'export', why: 'public method of Orders, exported from src/index.ts' },
      { fn: f.lonely, kind: 'export', why: 'exported from src/index.ts' },
    ],
    switches: [{ name: 'autoCharge', path: P, line: 2, default: 'false', kind: 'config', fn: null }],
  };
  if (only) {
    for (const k of Object.keys(facts.functions)) if (!only.includes(k)) delete facts.functions[k];
    facts.entries = facts.entries.filter((e) => only.includes(e.fn));
  }
  return { model, claims, facts, root: SHOP_ROOT };
}
