// Stages (a rule you can defend), loops, and the model file. Byte-identical for the same input.
import { summary as undecidedSummary } from './confidence.mjs';
import { sorted, cpLen, cpSlice, dumps } from './pyrt.mjs';

export const VERSION = 'fldet-0.1';
const STAGE_LIMIT = 250; // a stage holds at most this many boxes before it splits by the next path part
const STAGE_MIN = 12; // a group smaller than this fuses into its parent's `misc`

function commonPrefix(paths) {
  const parts = paths.map((p) => p.split('/').slice(0, -1));
  if (!parts.length) return [];
  let pre = parts[0];
  for (const p of parts.slice(1)) {
    let k = 0;
    while (k < pre.length && k < p.length && pre[k] === p[k]) k++;
    pre = pre.slice(0, k);
  }
  return pre;
}

/** Directory tree first; a directory over `limit` boxes splits by the next path part; a file over `limit` splits by class. Groups under `minsize`
 *  boxes fuse into their parent's `misc`. -> Map box id -> array of path parts. */
export function assignStages(boxes, limit = STAGE_LIMIT, minsize = STAGE_MIN) {
  const pre = commonPrefix(boxes.map((b) => b.refs[0].path));
  const keyOf = (b) => {
    const path = b.refs[0].path.split('/').slice(pre.length);
    const qual = b.handle.split('.');
    return qual.length > 1 ? [...path, qual[0]] : path;
  };
  const keys = new Map(boxes.map((b) => [b, keyOf(b)]));
  const out = new Map();
  const rec = (items, prefix) => {
    if (items.length <= limit) {
      for (const b of items) out.set(b.id, prefix);
      return;
    }
    const groups = new Map();
    for (const b of items) {
      const k = keys.get(b);
      const g = k.length > prefix.length ? k[prefix.length] : '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(b);
    }
    if (groups.size === 1 && groups.has('')) {
      for (const b of items) out.set(b.id, prefix);
      return;
    }
    const misc = [];
    for (const g of sorted(groups.keys())) {
      if (g === '' || groups.get(g).length < minsize) misc.push(...groups.get(g));
      else rec(groups.get(g), [...prefix, g]);
    }
    for (const b of misc) out.set(b.id, prefix.length ? [...prefix, 'misc'] : ['misc']);
  };
  rec(boxes, []);
  return out;
}

export const stageId = (t) => 's_' + (t.length ? t : ['all']).join('_').replaceAll('.', '_').replaceAll('-', '_');

const LANG_NAMES = { py: ['Python', 'ty'], ts: ['TypeScript / JavaScript', 'tsc'] };

/** What resolved the calls, and, when a checker is missing, the plain sentence that says what that costs. */
export function resolverHeader(P) {
  const present = sorted(new Set([...P.mods.values()].map((m) => m.lang).filter((l) => Object.hasOwn(LANG_NAMES, l))));
  const says = [];
  for (const lg of present) {
    const [name, tool] = LANG_NAMES[lg];
    if (!P.resolvers[lg]) {
      says.push(`No type checker (${tool}) ran for ${name}: negative claims about ${name} code (nobody catches it, nobody reads it, nobody calls it, nobody hears it) ` +
        'are off and stay `unknown`; what a call does (store, delete, emit ...) is marked `maybe:` unless the imports alone prove it; ' +
        `only \`exact\` call roads are proven, the rest are drawn thin. Run \`setup\` to install ${tool}.`);
    }
  }
  const environment = {};
  const resolvers = {};
  for (const lg of present) {
    if (P.env?.[lg]) environment[LANG_NAMES[lg][0]] = P.env[lg];
    resolvers[LANG_NAMES[lg][0]] = P.resolvers[lg] || 'none';
  }
  const unread = sorted(P.errors).map(([path, why]) => ({ path, why }));
  return { resolvers, environment, unread, says };
}

export function modelOf(M, rootName) {
  const boxes = sorted(M.boxes.keys()).map((k) => M.boxes.get(k));
  const st = assignStages(boxes);
  const stageKeys = new Map();
  const sizes = new Map();
  for (const t of st.values()) {
    const k = JSON.stringify(t);
    stageKeys.set(k, t);
    sizes.set(k, (sizes.get(k) ?? 0) + 1);
  }
  const stageRows = sorted(stageKeys.values()).map((t, i) => ({ id: stageId(t), title: t.join('/') || 'all', order: i + 1, blurb: `${sizes.get(JSON.stringify(t))} boxes (grouped by directory, file, class)` }));
  const outBoxes = boxes.map((b) => {
    const o = {};
    for (const [k, v] of Object.entries(b)) if (k !== 'fn') o[k] = v;
    o.stage = stageId(st.get(b.id));
    o.plain = '';
    o.detail = o.title;
    o.title = cpLen(o.title) <= 40 ? o.title : cpSlice(o.title, 0, 37) + '...';
    if (o.kind === 'end') {
      const c = o.prov.class ?? '';
      o.outcome = c.startsWith('raise') ? 'failure' : c === 'X' ? 'neutral' : c === 'R0' || c === 'R:const:False' ? 'refusal' : 'success';
    }
    return o;
  });
  const routes = sorted(M.roads.keys()).map((k) => {
    const r = M.roads.get(k);
    const long = cpLen(r.when) > 28;
    return { id: r.id, from: r.from, to: r.to, type: r.type, when: long ? cpSlice(r.when, 0, 25) + '...' : r.when, why: long ? r.why + ' | ' + r.when : r.why, refs: [], inferred: false, prov: r.prov };
  });
  const loops = boxes.filter((b) => b.prov.rule === 'loop').map((b) => ({ id: 'l_' + b.id, title: b.title, blurb: '', boxes: [b.id], limit: b.prov.bound === 'none' ? '' : cpSlice(b.title, 6) }));
  // every function the readers saw, and how many of them have no box: the Reader says "no box" about all of them, not only the ones the scanner listed
  const withBox = new Set(boxes.map((b) => b.prov.fn));
  const functions = { read: M.P.fns.size, withoutBoxes: [...M.P.fns.keys()].filter((id) => !withBox.has(id)).length };
  return {
    schema: 'faultline.model/1',
    tool: VERSION,
    system: { name: rootName, tagline: 'deterministic reading, no agent words', summary: '', purpose: '', functions, ...resolverHeader(M.P), undecided: undecidedSummary(M) },
    stages: stageRows, boxes: outBoxes, routes, loops, paths: [], charts: [], terms: [],
  };
}

/** The model as the bytes written to disk. */
export const modelText = (model) => dumps(model, 1);
