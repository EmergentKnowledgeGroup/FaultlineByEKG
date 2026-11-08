// Everything the rules declined to assert, in one list an agent can be sent to research.
//
// The rules never guess a label they cannot decide. They write one of these instead, and this module collects them:
//   effect   a call that is NAMED like an effect (store, delete, emit, network, wait ...) whose definition is unknown or in no table: `maybe:<effect>` on the op.
//            It is never work: no box, no kind, no title comes from it.
//   ending   a raise ending whose "nobody catches it" claim is `unknown` (raise-open) or only partly followed (raise-caught with open ends): the open ends say why.
//   road     a road in tier `may` (a possible target: nominal class hierarchy, several targets, an override, an unconfirmed guess) or `linked`.
//   box      a box whose title the tool shortened to "N places" because the sites disagree.
//
// undecided(M) -> rows {kind, where (path:line), label, why, id}; summary(M) -> {kind/label: count}, which the model header carries (system.undecided).
// Both are pure functions of the finished map: same input, same bytes.
import { sorted, cmp } from './pyrt.mjs';

const fnPath = (fid) => fid.slice(0, fid.indexOf('::'));

export function undecided(M) {
  const { P } = M;
  const rows = [];
  for (const fid of P.fids) {
    const fn = P.fns.get(fid);
    for (const nd of fn.nodes) {
      for (const o of nd.ops ?? []) {
        for (const e of (o.eff ?? []).filter((x) => x.startsWith('maybe:') && x !== 'maybe:call')) {
          rows.push({ kind: 'effect', where: `${fn.path}:${o.line}`, label: e, why: `${o.f ?? 'None'}: ` + (['none', 'silent', 'dynamic'].includes(o.rs) ? 'no checker answered' : 'the definition is in no table'), id: fid });
        }
      }
    }
  }
  for (const id of sorted(M.boxes.keys())) {
    const pv = M.boxes.get(id).prov;
    const c = pv.class ?? '';
    if ((c.startsWith('raise-open') || c.startsWith('raise-caught')) && pv.nobody_catches?.open_ends) {
      const nc = pv.nobody_catches;
      rows.push({ kind: 'ending', where: `${fnPath(pv.fn)}:${pv.line}`, label: c.split(':')[0], why: `${nc.open_ends} open end(s): ` + (nc.why ?? []).slice(0, 3).map((w) => w.map(String).join(' ')).join('; '), id });
    }
    if (pv.messages?.length && new Set(pv.messages.map((m) => m[1])).size > 1) {
      rows.push({ kind: 'box', where: `${fnPath(pv.fn)}:${pv.line}`, label: 'places-differ', why: `${pv.sites.length} raise sites with different messages`, id });
    }
  }
  for (const rid of sorted(M.roads.keys())) {
    const r = M.roads.get(rid);
    const t = r.prov.tier;
    if (t === 'may' || t === 'linked') rows.push({ kind: 'road', where: `${fnPath(r.prov.fn ?? '')}:${r.prov.line}`, label: t, why: r.prov.basis || r.prov.rule, id: rid });
  }
  return rows;
}

export function summary(M) {
  const c = new Map();
  for (const r of undecided(M)) {
    const k = JSON.stringify([r.kind, r.label]);
    c.set(k, (c.get(k) ?? 0) + 1);
  }
  const out = {};
  for (const [k, v] of [...c].sort((a, b) => cmp(JSON.parse(a[0]), JSON.parse(b[0])))) {
    const [kind, label] = JSON.parse(k);
    out[`${kind}/${label}`] = v;
  }
  return out;
}
