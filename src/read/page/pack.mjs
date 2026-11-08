// Packs a reading into the compact JSON the Reader page embeds. Everything the page says in words or numbers comes from the reading;
// nothing is counted here except lengths of lists that are shown.
import { cmp, clip } from '../util.mjs';
import { HOT_BYTES, HOT_FLOOR, LIMIT, MAX_CALLS } from '../charts.mjs';

export const GAPS_SHOWN = 60;           // engine gaps listed on the page (the count is always the full number)
export const USES_SHOWN = 8;            // places a switch is tested that the page lists (the count is the full number)

const VIA_EVIDENCE = { map: 'the map draws this road', scan: 'found by the scanner; the map draws no road here', linked: 'joined by the tool from a name written in the code' };

/** One sentence for how a journey got into a function. */
export function viaText(v) {
  if (!v || v.kind === 'trigger') return '';
  if (v.kind === 'function value') return `run by ${v.by} (a function passed to it, line ${v.line})`;
  const e = VIA_EVIDENCE[v.evidence] ?? '';
  return `call at line ${v.line}${e ? ` (${e})` : ''}`;
}

/**
 * Hops that are not roads of the map but that a journey took: a call the scanner resolved where the map draws no road, and a function passed to another that runs it.
 * Each is [from function, to function, one phrase saying who found it], so a trace can use them and say so.
 */
export function scanHops(reading, fxByFid) {
  const out = [];
  const seen = new Set();
  const add = (a, b, phrase) => { if (a === undefined || b === undefined || a === b || seen.has(a + ':' + b)) return; seen.add(a + ':' + b); out.push([a, b, phrase]); };
  for (const g of reading.journeys.engineGaps) add(fxByFid.get(g.from), fxByFid.get(g.to), `found by the scanner at ${g.path}:${g.line}; the map draws no road there`);
  for (const j of reading.journeys.list) {
    const at = [];
    for (const s of j.steps) {
      if (s.kind !== 'enter') continue;
      at[s.depth] = fxByFid.get(s.fid);
      if (s.via?.kind === 'function value' && s.depth > 0) add(at[s.depth - 1], at[s.depth], `a function passed to ${s.via.by} (line ${s.via.line}), which runs it`);
      else if (s.via?.kind && s.via.kind !== 'trigger' && s.depth > 0) add(at[s.depth - 1], at[s.depth], `a call at line ${s.via.line} that the journey "${j.name}" follows`);
    }
  }
  return out;
}

/**
 * @param {{reading:object, charts:object, side:object}} d
 */
export function packReading({ reading, charts, side }) {
  const stageIx = new Map(reading.districts.list.map((d, i) => [d.id, i]));
  const fns = charts.functions;
  const fx = new Map(fns.map((f, i) => [f.id, i]));
  const fxByFid = new Map(fns.map((f, i) => [f.fid, i]));
  const partsOf = new Map(charts.charts.map((c) => [c.fid, c.parts.map((p) => p.id)]));
  const boxPart = new Map();
  const openCount = new Map();
  for (const c of charts.charts) {
    for (const p of c.parts) for (const b of p.boxes) { boxPart.set(b.id, p.id); if (b.shape === 'open') openCount.set(c.fid, Number.parseInt(b.raw, 10) || 0); }
  }
  for (const o of charts.outlines) for (const b of o.boxes) if (b.shape === 'open') openCount.set(o.fid, Number.parseInt(/(\d+)/.exec(b.title)?.[1] ?? '0', 10));

  const rows = fns.map((f) => {
    const r = { i: f.id, n: f.label, p: f.path, l: f.line, g: stageIx.get(f.district) ?? 0, b: f.boxes, cb: f.callers, ce: f.callees.map((c) => fx.get(c)).filter((x) => x !== undefined), c: partsOf.get(f.fid) ?? [] };
    if (f.long !== f.label) r.q = f.long;
    if (openCount.get(f.fid)) r.oc = openCount.get(f.fid);
    if (f.anonymous) r.an = 1;
    return r;
  });

  const cards = {};
  for (const c of charts.charts) for (const p of c.parts) for (const b of p.boxes) if (b.shape === 'card' && fxByFid.has(b.raw)) cards[b.id] = fxByFid.get(b.raw);
  const outl = {};
  for (const o of charts.outlines) {
    const ix = fx.get(o.fn);
    if (ix === undefined) continue;
    const idx = new Map(o.boxes.map((b, i) => [b.id, i]));
    const calleeOf = (b) => (b.shape === 'card' && b.raw && fxByFid.has(b.raw) ? fxByFid.get(b.raw) : -1);
    const ordered = o.boxes.slice().sort((a, b) => a.line - b.line || cmp(a.id, b.id));
    const order = new Map(ordered.map((b, i) => [b.id, i]));
    outl[ix] = {
      b: ordered.map((b) => [b.kind, b.title, b.line ?? 0, calleeOf(b), b.shape ?? 'own', ]),
      r: o.roads.filter((r) => idx.has(r.from) && idx.has(r.to)).map((r) => [order.get(r.from), order.get(r.to), r.when, r.tier === 'proven' || r.tier === 'linked' ? 0 : 1]),
    };
  }

  const throughFn = new Map();
  const journeys = reading.journeys.list.map((j) => {
    const steps = j.steps.map((s) => {
      const d = s.depth;
      const part = s.pageBox ? boxPart.get(s.pageBox) : undefined;
      switch (s.kind) {
        case 'enter': {
          const ix = fxByFid.get(s.fid);
          if (ix !== undefined) { if (!throughFn.has(ix)) throughFn.set(ix, new Set()); throughFn.get(ix).add(j.id); }
          const o = { k: 'e', d, t: s.fn, w: s.where, v: viaText(s.via) };
          if (ix !== undefined) { o.f = ix; if (rows[ix].c.length) o.c = rows[ix].c[0]; }
          const note = s.stuck ?? s.note;
          if (note) o.s = note;
          if (s.hl) o.h = 1;
          o.hd = s.hd ?? 0;
          if (s.col) o.ci = s.col;
          if (s.more) o.mo = s.more;
          return o;
        }
        case 'choice': return { k: 'ch', d, o: s.options, n: s.more ?? 0, l: s.line, ...(s.hl ? { h: 1, hd: s.hd } : {}) };
        case 'folded': return { k: 'f', d, t: s.fn, n: s.steps, l: s.line, f: fxByFid.get(s.fid), ...(s.hl ? { h: 1, hd: s.hd } : {}) };
        case 'break': return { k: 'b', d, t: s.reason, l: s.line, g: s.gap ? 1 : 0, ...(s.hl ? { h: 1, hd: s.hd } : {}) };
        case 'note': return { k: 't', d, t: s.text, ...(s.hl ? { h: 1, hd: s.hd } : {}) };
        case 'finish': return { k: 'fin', d: 0, t: s.title, p: s.plain, st: s.state, u: s.outcome ?? '', h: 1, hd: 0 };
        default: {
          const o = { k: { decision: 'd', loop: 'l', work: 'x', wait: 'w', end: 'n', step: 's' }[s.kind] ?? 's', d, t: s.title, l: s.line };
          if (part) { o.c = part; o.b = s.pageBox; }
          if (s.took) o.o = s.took;
          if (s.notTaken?.length) o.a = s.notTaken.map((x) => `${x.when}${x.to ? ` goes to ${x.to}` : ''}`);
          if (s.outcome) o.u = s.outcome;
          if (s.final) o.fi = 1;
          if (s.hl) { o.h = 1; o.hd = s.hd ?? 0; }
          return o;
        }
      }
    });
    // The short walk prefers steps that have a chart, so pressing Walk visibly moves: charted steps from the full detail are added, in order,
    // until it has four (or all there are); then steps with no chart go, the deepest and latest first, until at least half the walk is on a chart.
    // The ending and the breaks always stay. A journey with no chart anywhere is left as it was and offers no Walk.
    const charted = steps.filter((x) => x.c).length;
    const SHORT_CHARTED = 4;
    if (charted) {
      const inShort = () => steps.filter((x) => x.h && x.c).length;
      for (const x of steps) { if (inShort() >= Math.min(SHORT_CHARTED, charted)) break; if (x.c && !x.h) { x.h = 1; x.hd = x.hd ?? 0; } }
      const drop = steps.map((x, i) => [x, i]).filter(([x]) => x.h && !x.c && x.k !== 'fin' && x.k !== 'b').sort((p, q) => (q[0].hd ?? 0) - (p[0].hd ?? 0) || q[1] - p[1]);
      for (const [x] of drop) { if (inShort() * 2 >= steps.filter((y) => y.h).length) break; delete x.h; delete x.hd; }
    }
    const stats = { ...j.stats, headline: steps.filter((x) => x.h).length };
    const fin = j.steps.find((x) => x.final) ?? j.steps.find((x) => x.kind === 'finish');
    const end = fin?.kind === 'finish' ? { state: fin.state === 'returned' ? 'returned' : 'stopped', title: fin.title, plain: fin.plain } : { state: 'ended', title: fin?.title ?? '', outcome: fin?.outcome ?? '' };
    return { id: j.id, name: j.name, trig: j.trigger, st: stats, ch: charted, steps, files: j.files.length, end };
  });
  for (const [ix, set] of throughFn) rows[ix].j = [...set].sort(cmp);

  // a question or a switch use points at the chart of the function that holds it
  const fnAt = (path, label, line) => {
    let best = -1;
    for (let i = 0; i < fns.length; i++) {
      const f = fns[i];
      if (f.path !== path) continue;
      if (f.label === label || f.long === label) return i;
      if (line && f.line <= line && (best < 0 || f.line > fns[best].line)) best = i;
    }
    return best;
  };
  const switches = reading.switches.items.map((s) => ({
    name: s.name, kind: s.kind, n: s.useCount, def: s.default, note: s.note, off: s.offByDefault, di: s.defaultIs,
    uses: s.uses.slice(0, USES_SHOWN).map((u) => ({ path: u.path, line: u.line, test: clip(u.test, 120), neg: u.negated, f: fnAt(u.path, u.fn.split('::').pop(), u.line), part: boxPart.get(side.pageOfRef?.[u.box]) ?? null, b: side.pageOfRef?.[u.box] ?? null })),
  }));
  const failing = reading.endings.failing.map((e) => { const [path, line] = [e.where.slice(0, e.where.lastIndexOf(':')), Number(e.where.slice(e.where.lastIndexOf(':') + 1))]; return { b: e.page, c: e.page ? boxPart.get(e.page) : null, fn: e.fn, w: e.where, o: e.outcome, t: e.title, p: clip(e.plain ?? '', 170), h: e.whoHears, f: fnAt(path, e.fn, line), ...(e.route ? { route: e.route } : {}), ...(e.status ? { status: e.status } : {}) }; });

  return {
    v: 1,
    system: reading.system,
    st: reading.statements,
    num: reading.numbers,
    hears: reading.whoHears,
    stages: reading.districts.list.map((d) => ({ id: d.id, t: d.title, p: d.path, ab: d.about, abf: d.aboutFrom, fns: d.functions, boxes: d.boxes, ent: d.entries, out: d.callsOut.map((x) => [stageIx.get(x.district), x.calls]), in: d.callsIn.map((x) => [stageIx.get(x.district), x.calls]) })),
    rule: reading.districts.rule,
    prefix: reading.districts.prefix,
    rules: `Charts: the functions a journey passes through come first, then the functions with the most boxes, until about ${Math.round(HOT_BYTES / 1e6)} MB of charts are drawn; a function needs at least ${HOT_FLOOR} boxes. A chart over ${LIMIT} boxes is cut into parts. One box shows at most ${MAX_CALLS} called functions; the rest are gathered into one card. Every other function has a text outline in this Reader.`,
    fns: rows,
    cards,
    outl,
    journeys,
    jnone: reading.journeys.none,
    rank: { ...reading.journeys.ranking, main: reading.journeys.ranking?.main ? { ...reading.journeys.ranking.main, id: reading.journeys.main } : null },
    jrejected: reading.journeys.rejected,
    triggers: reading.journeys.triggers.length,
    gaps: reading.journeys.engineGaps.slice(0, GAPS_SHOWN).map((g) => ({ w: `${g.path}:${g.line}`, from: g.fromLabel, to: g.toLabel, j: g.journeys })),
    gapsTotal: reading.journeys.engineGaps.length,
    scan: scanHops(reading, fxByFid),
    qcounts: reading.triage.counts,
    gapKinds: reading.triage.gaps.byKind,
    switches,
    swInfo: { count: reading.switches.count, withDefault: reading.switches.withDefault, off: reading.switches.offByDefault, notRead: reading.switches.notRead, falsy: reading.switches.defaultFalsy, on: reading.switches.defaultOn, cannotSee: reading.switches.cannotSee },
    failing,
    conf: { boxes: Object.keys(side.notConfident.boxes).length, roads: Object.keys(side.notConfident.roads).length },
    wordsBy: side.wordsBy ?? null,
    tagline: side.tagline ?? null,
  };
}
