// The claim register: every statement the tool makes about the code gets a confidence and a reason code. A pure function of the finished map.
//
//     buildClaims(M, findingsRows) -> [claim, ...]        sorted by id; the same map gives the same bytes.
//
// A claim is {id, type, subject, fn, path, line, says, conf, reason, why, pinned, ...}.
//   conf    'confident' | 'not-confident'. Confident means: a type checker, the control-flow graph or a definition table decided it, and no open end
//           sits behind it. Not-confident means: the tool wrote the label but the evidence is thinner than the words (a name match, several possible
//           targets, an open end), or it declined to write the label at all (`maybe:store`). Not-confident is the list an agent can research.
//   pinned  true when the checker or the flow graph pinned the claim. A review answer can never touch a pinned claim.
// Types: kind effect declined wait hears exc-road title negative entry call-road cfg-road link-road
// Reason codes are in reasons.mjs. Nothing here changes a box, a road or a byte of the model.
import { REASONS, PINNED } from './reasons.mjs';
import { classify3, regionSilent, reachNodes } from './heard3.mjs';
import { outsideMentions } from './lookup.mjs';
import { cmp, PYWS } from './pyrt.mjs';

export const CONF = 'confident';
export const NOT = 'not-confident';
const TITLE_PHRASE = new RegExp(`\\(([^()]*(?:\\([^()]*\\))?[^()]*)\\)[${PYWS}]*$`);
const RS_WORDS = {
  none: 'no checker ran for this language', silent: 'the checker made no claim for this call', dynamic: 'the callee is a variable or a parameter',
  ext: 'the definition is outside the project and in no table row', project: 'a project function: its own body decides',
};
const ABSENCE_KINDS = ['unreferenced_store', 'unreferenced_delete', 'flag_never_cleared', 'written_never_read', 'swallowed_known_failure', 'swallowed_known_failure_unknown', 'handler_nothing_can_reach'];
const ROAD_TYPES = { call: 'call-road', link: 'link-road', 'exc-edge': 'exc-road' };

const fnPath = (fid) => fid.slice(0, fid.indexOf('::') === -1 ? fid.length : fid.indexOf('::'));
const secondPart = (fid) => fid.split('::')[1];
const shortOf = (fid) => secondPart(fid).split('.').pop().split('~')[0];
const py = (x) => (x === null || x === undefined ? 'None' : String(x));
const lastDot = (s) => s.slice(s.lastIndexOf('.') + 1);
const joinWhy = (ws) => ws.map((w) => w.map(String).join(' ')).join('; ');

function mk(cid, type, subject, fid, line, says, conf, reason, why = '', extra = null) {
  const c = { id: cid, type, subject, fn: fid, path: fid ? fnPath(fid) : '', line, says, conf, reason, why: why || REASONS[reason] || reason, pinned: conf === CONF && PINNED.has(reason) };
  return extra ? Object.assign(c, extra) : c;
}

/** The call/with ops that sit in the nodes a box was made from (steps, tries) or at its line (waits, ends). */
function boxOps(P, b) {
  const fn = P.fns.get(b.prov.fn);
  const nodes = b.prov.nodes;
  const isCall = (o) => o.t === 'call' || o.t === 'with';
  if (nodes?.length) return nodes.flatMap((i) => (fn.nodes[i].ops ?? []).filter(isCall));
  const [lo, hi] = b.prov.folded_lines?.length ? b.prov.folded_lines : [b.prov.line, b.prov.line];
  return fn.nodes.flatMap((nd) => (nd.ops ?? []).filter((o) => isCall(o) && lo <= o.line && o.line <= Math.max(hi, lo)));
}

/** the checker's definition, or the imports' */
const effectBasis = (o) => (o.rs === 'ext' ? 'definition-by-checker' : 'definition-by-imports');

/** The function names an absence claim ("nothing names it", "nothing calls it") may be made about: the search of the rest of the repo looks for these. */
function absenceNames(M, rows) {
  const names = new Set();
  for (const b of M.boxes.values()) if (b.prov.rule === 'end' && (b.prov.class ?? '').startsWith('RB')) names.add(shortOf(b.fn));
  for (const kind of ['unreferenced_store', 'unreferenced_delete']) for (const row of rows?.get(kind) ?? []) if (row.fn) names.add(shortOf(row.fn));
  return names;
}

const handlerNode = (P, fid, line) => {
  const i = P.fns.get(fid).nodes.findIndex((nd) => nd.k === 'handler' && nd.line === line);
  return i < 0 ? null : i;
};

export function buildClaims(M, findingsRows = null, hear = true) {
  const { P, F } = M;
  const N = F.neg;
  const out = [];
  const add = (c) => out.push(c);
  const mentions = outsideMentions(P, absenceNames(M, findingsRows));
  const sameName = (t) => [...P.classes.values()].filter((k) => k.name === t).length;
  for (const bid of [...M.boxes.keys()].sort(cmp)) {
    const b = M.boxes.get(bid);
    const pv = b.prov;
    const fid = b.fn;
    const kind = b.kind;
    const rule = pv.rule;
    const line = pv.line;
    if (rule === 'end') {
      const c = pv.class;
      const sites = pv.sites ?? [];
      const base = c.split(':')[0];
      let r = 'ending-in-flow-graph';
      let why = '';
      if (base.startsWith('raise')) {
        const t = c.includes(':') ? c.slice(c.indexOf(':') + 1) : '*';
        if (t === '*') r = 'exception-type-unknown';
        else if (sameName(t) > 1) { r = 'exception-name-in-several-classes'; why = `${sameName(t)} project classes are named ${t}`; }
      }
      add(mk('k:' + bid, 'kind', bid, fid, line, `ending: ${c}`, r === 'ending-in-flow-graph' ? CONF : NOT, r, why));
      const msgs = pv.messages ?? [];
      if (sites.length > 1 && new Set(msgs.map((m) => m[1])).size > 1) add(mk('t:' + bid, 'title', bid, fid, line, b.title, NOT, 'one-box-covers-several-sites', `${sites.length} sites with different messages`));
      else add(mk('t:' + bid, 'title', bid, fid, line, b.title, CONF, sites.length > 1 ? 'sites-agree' : 'title-is-a-source-slice'));
      const nb = pv.nobody_catches ?? null;
      if (base === 'raise-up' || base === 'raise-open') {
        if (nb && nb.value === 'proven') add(mk('n:' + bid, 'negative', bid, fid, line, 'nothing in the mapped folder above it catches it', CONF, 'negative-proven', '', { paths: nb.paths }));
        else {
          const noChecker = !!(nb && nb.why.length && nb.why[0][0] === 'no-type-checker');
          add(mk('n:' + bid, 'negative', bid, fid, line, 'nobody in the mapped folder catches it (declined)', NOT, noChecker ? 'no-type-checker' : 'negative-open-ends',
            `${nb?.open_ends ?? 0} open end(s): ${joinWhy((nb?.why ?? []).slice(0, 3))}`, { template: 'catch' }));
        }
      }
      if (base === 'RB') {
        const oe = N.openEnds(fid);
        const en = N.enabled(fid);
        const entrySays = 'entry: nothing in the mapped folder calls it';
        if (F.callers.get(fid)?.length) {
          const cs = [...F.callers.get(fid)].sort(cmp).slice(0, 3);
          add(mk('y:' + bid, 'entry', bid, fid, line, entrySays, NOT, 'a-caller-is-on-the-map', 'the map shows: ' + cs.map((x) => `${secondPart(x[0])}:${x[2]}`).join(', ')));
        } else if (oe.length || !en) {
          add(mk('y:' + bid, 'entry', bid, fid, line, entrySays, NOT, !en ? 'no-type-checker' : 'entry-with-open-ends', oe.slice(0, 4).map(([k, v]) => `${k} ${v}`).join('; ') || 'no type checker',
            { template: 'entry', open_ends: oe.slice(0, 5).map(([k, v]) => [k, String(v)]) }));
        } else if (mentions.has(shortOf(fid))) {
          const where = mentions.get(shortOf(fid));
          add(mk('y:' + bid, 'entry', bid, fid, line, entrySays, NOT, 'named-outside-the-mapped-folder', `named at ${where[0]}:${where[1]}`, { template: 'entry' }));
        } else add(mk('y:' + bid, 'entry', bid, fid, line, entrySays, CONF, 'no-known-caller-closed'));
      }
      if (base.startsWith('raise') && hear) {
        const res = classify3(M, fid, sites.length ? sites[0] : line);
        const mt = TITLE_PHRASE.exec(b.title);
        const phrase = mt ? mt[1] : '';
        const doubt = res?.via ? F.handlerDoubt(res.via[0], res.via[1]) : null;
        if (res === null) add(mk('h:' + bid, 'hears', bid, fid, line, phrase || 'who hears', NOT, 'heard-unknown', 'no node near the raise to classify'));
        else if (res.value === 'heard' && doubt) add(mk('h:' + bid, 'hears', bid, fid, line, phrase || 'heard by ' + py(res.by), NOT, doubt, res.how, { template: 'hears' }));
        else if (res.value === 'heard') {
          if (base === 'raise-heard' || base === 'raise-caught') {
            const full = base === 'raise-heard' || (pv.nobody_catches?.open_ends ?? 0) === 0;
            add(mk('h:' + bid, 'hears', bid, fid, line, phrase, full ? CONF : NOT, full ? 'heard' : 'caught-on-some-paths-others-open', res.how));
          } else add(mk('h:' + bid, 'hears', bid, fid, line, 'heard by ' + py(res.by), CONF, 'heard', res.how));
        } else if (res.value === 'nobody') add(mk('h:' + bid, 'hears', bid, fid, line, 'nobody hears it', CONF, 'nobody-closed', res.how));
        else {
          const r = base === 'raise-heard' ? 'title-says-more-than-who-hears-proves' : res.how.includes('(no type checker)') ? 'no-type-checker' : 'heard-unknown';
          add(mk('h:' + bid, 'hears', bid, fid, line, phrase || 'who hears', NOT, r, res.how, { open: res.open ?? 0, template: 'hears' }));
        }
      }
    } else if (rule === 'decision' || rule === 'loop') {
      const ok = (pv.arms ?? 2) >= 2 || rule === 'loop';
      add(mk('k:' + bid, 'kind', bid, fid, line, `${rule === 'loop' ? 'loop' : 'decision'}: ${b.title}`, ok ? CONF : NOT, ok ? (rule === 'loop' ? 'loop-in-flow-graph' : 'branch-in-flow-graph') : 'one-way-out'));
      add(mk('t:' + bid, 'title', bid, fid, line, b.title, CONF, 'title-is-a-source-slice'));
      for (const e of pv.test_effects ?? []) { // the condition of the decision does this as well
        if (e.startsWith('wait')) continue;
        const inst = (pv.test_nodes ?? []).flatMap((i) => (P.fns.get(fid).nodes[i].ops ?? []).filter((o) => (o.t === 'call' || o.t === 'with') && (o.eff ?? []).includes(e)));
        let reason = inst.length ? effectBasis(inst[0]) : 'definition-by-imports';
        if (inst.some((o) => o.rs === 'ext')) reason = 'definition-by-checker';
        add(mk(`e:${bid}:${e}`, 'effect', bid, fid, inst.length ? inst[0].line : line, 'does ' + e.replaceAll('ext:', ''), CONF, reason, '', { call: inst.length ? inst[0].f ?? null : null }));
      }
    } else if (rule === 'wait') {
      const ops = boxOps(P, b).filter((o) => (o.eff ?? []).some((e) => e.startsWith('wait') || e === 'lockwith'));
      const real = ops.filter((o) => (o.eff ?? []).some((e) => e.startsWith('wait')));
      const onlyLock = ops.length > 0 && !real.length;
      const reason = onlyLock ? 'lock-matched-by-name-only' : real.length && real.some((o) => o.rs === 'ext') ? 'wait-by-definition' : 'wait-kind-by-name';
      const conf = reason === 'wait-by-definition' ? CONF : NOT;
      add(mk('k:' + bid, 'kind', bid, fid, line, 'wait: ' + b.title, conf, reason, '', { template: onlyLock ? 'lock' : null, call: ops.length ? ops[0].f ?? null : null }));
      add(mk('w:' + bid, 'wait', bid, fid, line, `waits on ${pv.on}`, conf, reason !== 'lock-matched-by-name-only' ? reason : 'wait-kind-by-name', 'on=' + pv.on, { template: onlyLock ? 'lock' : null }));
      add(mk('t:' + bid, 'title', bid, fid, line, b.title, CONF, 'title-is-a-source-slice'));
    } else if (rule === 'handler') {
      const hl = pv.labels;
      const d = pv.disposition;
      const hn = handlerNode(P, fid, line);
      let r;
      if (d === 'unknown') {
        r = (hn !== null ? F.handlerDoubt(fid, hn) : null) ?? (hl.includes('return_other') ? 'handler-returns-something-else'
          : hl.includes('uses_exc') && !hl.some((x) => x.startsWith('maybe:')) ? 'handler-reads-the-error-only' : 'handler-calls-something-unknown');
      } else if (d.endsWith('~')) r = 'handler-effect-only-a-candidate';
      else if (d === 'swallow') {
        const fn = P.fns.get(fid);
        const tail = new Map();
        if (hn !== null) for (const x of [...fn.nodes.filter((x) => (x.h ?? null) === hn), ...reachNodes(M.red.get(fid), fn, fn.nodes[hn])]) tail.set(x.i, x);
        r = N.enabled(fid) && hn !== null && regionSilent(F, [...tail.keys()].sort((a, c) => a - c).map((i) => tail.get(i)), N._silent) ? 'nobody-closed' : 'handler-swallow-not-closed';
      } else if (d === 'reraise-sometimes') r = 'handler-passes-it-on-on-some-paths';
      else r = 'handler-effect-by-definition';
      if (r === 'handler-effect-by-definition' && hn !== null && F.handlerDoubt(fid, hn)) r = F.handlerDoubt(fid, hn);
      const conf = r === 'nobody-closed' || r === 'handler-effect-by-definition' || r === 'handler-passes-it-on-on-some-paths' ? CONF : NOT;
      add(mk('k:' + bid, 'kind', bid, fid, line, 'handler: ' + b.title, CONF, 'branch-in-flow-graph'));
      add(mk('h:' + bid, 'hears', bid, fid, line, b.title, conf, r, `disposition ${d}`, { template: conf === NOT ? 'handler' : null }));
    } else if (rule === 'try') {
      add(mk('k:' + bid, 'kind', bid, fid, line, b.title, CONF, 'branch-in-flow-graph'));
      add(mk('t:' + bid, 'title', bid, fid, line, b.title, b.title.includes('?') ? NOT : CONF, b.title.includes('?') ? 'title-has-a-hole' : 'title-is-a-source-slice'));
    } else if (rule === 'step') {
      add(mk('k:' + bid, 'kind', bid, fid, line, `${kind}: ${b.title}`, CONF, 'control-flow-edge'));
      const ops = boxOps(P, b);
      for (const e of pv.effects ?? []) {
        if (e.startsWith('wait')) continue;
        const inst = ops.filter((o) => (o.eff ?? []).includes(e));
        let reason = inst.length ? effectBasis(inst[0]) : 'definition-by-imports';
        if (inst.some((o) => o.rs === 'ext')) reason = 'definition-by-checker';
        add(mk(`e:${bid}:${e}`, 'effect', bid, fid, line, 'does ' + e.replaceAll('ext:', ''), CONF, reason, '', { call: inst.length ? inst[0].f ?? null : null }));
      }
      const poss = [];
      for (const i of pv.nodes ?? []) {
        for (const o of P.fns.get(fid).nodes[i].ops ?? []) {
          if (o.t === 'call' && o.to?.length && ['exact', 'self', 'typed'].includes(o.how)) poss.push(...o.to.filter((g) => M.mapped.has(g) && (o.may ?? []).includes(g)));
        }
      }
      const named = b.title.includes(' ; calls ') ? b.title.split(' ; calls ')[1].split(', ') : [];
      const hit = [...new Set(poss)].filter((g) => named.includes(secondPart(g)));
      if (hit.length) add(mk('t:' + bid, 'title', bid, fid, line, b.title, NOT, 'title-names-a-possible-target', 'possible: ' + hit.slice(0, 3).map(secondPart).join(', '), { template: 'target' }));
      else add(mk('t:' + bid, 'title', bid, fid, line, b.title, CONF, 'title-is-a-source-slice'));
    }
  }
  // ---- declined effects (`maybe:<effect>`, never work)
  for (const fid of P.fids) {
    for (const nd of P.fns.get(fid).nodes) {
      for (const o of nd.ops ?? []) {
        for (const e of o.eff ?? []) {
          if (!e.startsWith('maybe:') || e === 'maybe:call') continue;
          const why = RS_WORDS[o.rs] ?? py(o.rs);
          const defs = (o.defs ?? []).slice(0, 2).map((d) => d.join('.')).join('; ');
          add(mk(`d:${fid}:${o.line}:${py(o.f)}:${e}`, 'declined', `${fid}:${o.line}`, fid, o.line, `${py(o.f)} might be ${e.slice(6)} (not asserted)`, NOT, 'effect-candidate',
            why + (defs ? ` (${defs})` : ''), { template: 'effect', effect: e.slice(6), call: o.f ?? null, rs: o.rs ?? null }));
        }
      }
    }
  }
  // ---- roads
  for (const rid of [...M.roads.keys()].sort(cmp)) {
    const r = M.roads.get(rid);
    const pv = r.prov;
    const fid = pv.fn ?? '';
    const rl = pv.rule;
    const tier = pv.tier ?? null;
    const line = pv.line ?? null;
    const says = `${r.when}: ${lastDot(r.from)} -> ${lastDot(r.to)}`;
    if ((pv.anchor === 'before' || pv.anchor === 'unplaced') && ROAD_TYPES[rl]) {
      add(mk('r:' + rid, ROAD_TYPES[rl], rid, fid, line, says, NOT, 'road-starts-on-a-stand-in-box', `anchor ${pv.anchor}`));
      continue;
    }
    if (rl === 'cfg-edge') add(mk('r:' + rid, 'cfg-road', rid, fid, line, says, CONF, 'control-flow-edge'));
    else if (rl === 'exc-edge') {
      if (tier === 'proven') add(mk('r:' + rid, 'exc-road', rid, fid, line, says, CONF, 'handler-type-matches'));
      else add(mk('r:' + rid, 'exc-road', rid, fid, line, says, NOT, 'handler-may-catch', `handler at line ${py(pv.handler_line)}`, { template: 'excroad' }));
    } else if (rl === 'link' || tier === 'linked') {
      const a = M.boxes.get(r.from);
      const b = M.boxes.get(r.to);
      const lids = new Set(pv.link_ids ?? []);
      const arms = [];
      for (const nd of P.fns.get(fid).nodes) for (const o of nd.ops ?? []) if (o.t === 'link' && lids.has(o.lid) && o.to_line) arms.push(o.to_line);
      const armSet = [...new Set(arms)].sort((x, y) => x - y);
      if (armSet.length > 1) add(mk('r:' + rid, 'link-road', rid, fid, line, says, NOT, 'link-merges-several-arms', `one road for links to arms at lines [${armSet.slice(0, 4).join(', ')}]`));
      else if (arms.length && b && b.prov.line !== Math.min(...arms)) add(mk('r:' + rid, 'link-road', rid, fid, line, says, NOT, 'link-lands-on-a-nearby-box', `arm at line ${Math.min(...arms)}, box at line ${b.prov.line}`));
      else if (a && a.kind === 'end') add(mk('r:' + rid, 'link-road', rid, fid, line, says, NOT, 'link-starts-in-an-ending', 'the starting box is an ending'));
      else add(mk('r:' + rid, 'link-road', rid, fid, line, says, CONF, 'linked-by-literal', pv.basis ?? ''));
    } else if (rl === 'call') {
      if (tier === 'proven') add(mk('r:' + rid, 'call-road', rid, fid, line, says, CONF, pv.basis === 'callback' ? 'callback-called-by-callee' : pv.basis === 'resolver' ? 'resolved-by-checker' : 'lexical-exact'));
      else {
        const role = pv.role ?? null;
        const reason = pv.basis === 'callback' ? 'callback-handed-over' : pv.stub_with_overrides ? 'stub-with-overrides' : pv.replaceable ? 'callee-may-be-replaced' : role === 'override' ? 'override-may-run' : pv.basis === 'lexical' ? 'matched-by-name-checker-silent' : 'several-possible-targets';
        add(mk('r:' + rid, 'call-road', rid, fid, line, says, NOT, reason, pv.replaceable || `role ${py(role)}, basis ${py(pv.basis)}`, { template: 'target', to: r.to }));
      }
    }
  }
  // ---- absence findings
  if (findingsRows) {
    for (const kind of [...findingsRows.keys()].sort(cmp)) {
      if (!ABSENCE_KINDS.includes(kind)) continue;
      findingsRows.get(kind).forEach((row, k) => {
        const cl = row.claim ?? {};
        const site = (row.at?.length ? row.at : row.set_true?.length ? row.set_true : [[null, null]])[0];
        const fid = row.fn || site[0] || '';
        const line = row.line || row.handler_line || site[1];
        const lineS = py(line);
        const what = {
          unreferenced_store: 'nothing in the mapped folder or the rest of the repo names this function (it writes)',
          unreferenced_delete: 'nothing in the mapped folder or the rest of the repo names this function (it deletes)',
          flag_never_cleared: `flag ${py(row.attr)} is set to true at ${fnPath(fid)}:${lineS} and nothing in the mapped folder sets it back`,
          written_never_read: `${py(row.attr)} is written at ${fnPath(fid)}:${lineS} and never read in the mapped folder`,
          swallowed_known_failure: 'the handler swallows a failure that can happen',
          swallowed_known_failure_unknown: 'the handler may swallow a failure that can happen',
          handler_nothing_can_reach: 'nothing can raise into this handler',
        }[kind];
        const proven = cl.value === 'proven';
        const outside = (kind === 'unreferenced_store' || kind === 'unreferenced_delete') && fid ? mentions.get(shortOf(fid)) : undefined;
        const why = joinWhy((cl.why ?? []).slice(0, 3));
        const noChk = !!(cl.why?.length && cl.why[0][0] === 'no-type-checker');
        const id = `f:${kind}:${fid}:${lineS}:${k}`;
        if (outside) {
          add(mk(id, 'negative', `${fid}:${lineS}`, fid, line, what, NOT, 'named-outside-the-mapped-folder', `named at ${outside[0]}:${outside[1]}`, { template: 'absence', finding: kind, attr: row.attr ?? null }));
          return;
        }
        add(mk(id, 'negative', `${fid}:${lineS}`, fid, line, what, proven ? CONF : NOT, proven ? 'negative-proven' : noChk ? 'no-type-checker' : 'absence-with-open-ends',
          why || `${cl.open_ends ?? 0} open end(s)`, { template: !proven ? 'absence' : null, finding: kind, attr: row.attr ?? null }));
      });
    }
  }
  const byid = new Map(out.map((c) => [c.id, c]));
  for (const c of out) { // a title that repeats a phrase is only as sure as that phrase
    if (c.type === 'title' && c.conf === CONF && c.id.startsWith('t:')) {
      const bx = c.id.slice(2);
      const y = byid.get('y:' + bx);
      const h = byid.get('h:' + bx);
      if ((y && y.conf === NOT && c.says.includes('(entry)')) || (h && h.conf === NOT && (c.says.includes('(a handler tells someone)') || c.says.includes('(caught on a known path')))) {
        Object.assign(c, { conf: NOT, reason: 'title-carries-a-claim-that-is-not-confident', why: REASONS['title-carries-a-claim-that-is-not-confident'], pinned: false });
      }
    }
  }
  const keyed = out.map((c) => [[c.id, c.says, c.line || 0, c.conf, c.reason], c]);
  keyed.sort((a, b) => cmp(a[0], b[0]));
  const sorted1 = keyed.map((x) => x[1]);
  const seen = new Map();
  for (const c of sorted1) { // ids are unique: two identical calls on one line get #2, #3 ...
    const n = (seen.get(c.id) ?? 0) + 1;
    seen.set(c.id, n);
    if (n > 1) c.id = `${c.id}#${n}`;
  }
  return sorted1.sort((a, b) => cmp(a.id, b.id));
}
