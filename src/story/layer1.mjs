// Layer 1: the tool map (model.json, claims.json, story-index.json, all written by `map` with no agent) loaded and indexed for the story check.
// Everything the checker may say about the code comes from here and from the source lines it cites, never from the story.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cmp, normSymbol } from './canon.mjs';

/** A cited line counts as "near" a tool box when it is the rest of the statement that box starts (a wrapped call, an argument list), or the line that opens the block the box stands in.
 *  A statement spread over more lines than this is data, not a step. */
export const MAX_STATEMENT_LINES = 40;

export class MapError extends Error {}

function readJson(dir, name) {
  const p = path.join(dir, name);
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { throw new MapError(`the tool map is missing ${name} in ${dir.replace(/\\/g, '/')}; run map first`); }
  try { return JSON.parse(text); } catch (e) { throw new MapError(`${name} is not valid JSON: ${String(e.message).slice(0, 80)}`); }
}

/** sha256 over the sorted relative paths, each followed by the sha256 of that file's bytes (the same sum `map` records as source_digest). */
export function sourceDigest(root, rels) {
  const h = createHash('sha256');
  for (const rel of [...rels].sort(cmp)) {
    let b;
    try { b = fs.readFileSync(path.join(root, rel)); } catch { return null; }
    h.update(rel + '\0' + createHash('sha256').update(b).digest('hex') + '\n');
  }
  return h.digest('hex');
}

const fnPath = (fid) => fid.split('::')[0];
const num = (x) => (Number.isInteger(x) ? x : null);

export class Layer1 {
  constructor(mapDir) {
    this.model = readJson(mapDir, 'model.json');
    this.claims = readJson(mapDir, 'claims.json');
    this.idx = readJson(mapDir, 'story-index.json');
    if (this.model.schema !== 'faultline.model/1') throw new MapError(`model.json has an unknown schema (${String(this.model.schema).slice(0, 40)})`);
    if (this.idx.schema !== 'faultline.story-index/1') throw new MapError(`story-index.json has an unknown schema (${String(this.idx.schema).slice(0, 40)})`);
    this.digest = this.idx.source_digest ?? null;
    this.mods = new Set(Object.keys(this.idx.files ?? {}));
    this.boxes = new Map(this.model.boxes.map((b) => [b.id, b]));
    this.roads = new Map(this.model.routes.map((r) => [r.id, r]));
    this.fns = new Map(Object.entries(this.idx.fns ?? {}).map(([id, f]) => [id, { path: f.p, qual: f.q, line: f.l, end: f.e, br: f.br ?? [], ca: f.ca ?? [], rt: f.rt ?? [] }]));
    this.fnNames = new Set([...this.fns.keys()].map(normSymbol));
    this._index();
  }

  _index() {
    // claims by subject: the tool's own confidence in each road and box
    this.claimOf = new Map();
    this.effects = new Map();          // fid -> [{line, effect, conf, call}]
    this.hears = new Map();            // fid -> [{line, conf, says}]
    for (const c of this.claims) {
      if (c.subject != null && (c.type === 'cfg-road' || c.type === 'call-road' || c.type === 'link-road' || c.type === 'exc-road')) {
        const k = c.id.startsWith('r:') ? c.id.slice(2) : c.subject;
        this.claimOf.set(k, c);
      }
      if ((c.type === 'effect' || c.type === 'declined') && c.effect && c.fn && num(c.line) != null) {
        if (!this.effects.has(c.fn)) this.effects.set(c.fn, []);
        this.effects.get(c.fn).push({ line: c.line, effect: c.effect, conf: c.conf, call: c.call ?? '' });
      }
      if (c.type === 'hears' && c.fn && num(c.line) != null) {
        if (!this.hears.has(c.fn)) this.hears.set(c.fn, []);
        this.hears.get(c.fn).push({ line: c.line, conf: c.conf, says: c.says ?? '' });
      }
    }
    // function spans by file, widest first for a stable order
    this.spans = new Map();
    for (const [fid, f] of this.fns) {
      if (num(f.line) == null || num(f.end) == null) continue;
      const p = fnPath(fid);
      if (!this.spans.has(p)) this.spans.set(p, []);
      this.spans.get(p).push([f.line, f.end, fid]);
    }
    for (const a of this.spans.values()) a.sort((x, y) => x[0] - y[0] || y[1] - x[1] || cmp(x[2], y[2]));
    // boxes by function: the lines a box stands on, its folded ranges, its anchors
    this.lineBoxes = new Map();        // fid -> Map(line -> [box ids])
    this.ranges = new Map();           // fid -> [[a, b, box id]]
    this.anchors = new Map();          // fid -> [[line, box id]] sorted
    this.boxesOfFn = new Map();
    for (const [id, b] of this.boxes) {
      const pv = b.prov ?? {};
      const fid = pv.fn;
      if (!fid) continue;
      if (!this.boxesOfFn.has(fid)) this.boxesOfFn.set(fid, []);
      this.boxesOfFn.get(fid).push(id);
      if (!this.lineBoxes.has(fid)) this.lineBoxes.set(fid, new Map());
      const lm = this.lineBoxes.get(fid);
      for (const l of new Set([pv.line, ...(pv.sites ?? []), ...(pv.chain ?? [])].filter((x) => num(x) != null))) {
        if (!lm.has(l)) lm.set(l, []);
        lm.get(l).push(id);
      }
      const fl = pv.folded_lines;
      if (Array.isArray(fl) && fl.length === 2 && num(fl[0]) != null && num(fl[1]) != null) {
        if (!this.ranges.has(fid)) this.ranges.set(fid, []);
        this.ranges.get(fid).push([fl[0], fl[1], id]);
      }
      if (num(pv.line) != null) {
        if (!this.anchors.has(fid)) this.anchors.set(fid, []);
        this.anchors.get(fid).push([pv.line, id]);
      }
    }
    for (const a of this.anchors.values()) a.sort((x, y) => x[0] - y[0] || cmp(x[1], y[1]));
    // a call or a failure road the tool draws is a fact at its line: the box it leaves stands there, and for a call the box it enters too
    this.callAt = new Map();           // fid -> Map(line -> [road ids])
    for (const [id, r] of this.roads) {
      const pv = r.prov ?? {};
      if ((pv.rule === 'call' || pv.rule === 'link' || pv.rule === 'exc-edge') && pv.fn && num(pv.line) != null) {
        if (!this.callAt.has(pv.fn)) this.callAt.set(pv.fn, new Map());
        const m = this.callAt.get(pv.fn);
        if (!m.has(pv.line)) m.set(pv.line, []);
        m.get(pv.line).push(id);
      }
    }
    // roads: a road is confident when the tool says so twice (its tier, and its own claim when there is one)
    this.out = new Map();
    this.inn = new Map();
    for (const [id, r] of this.roads) {
      const tier = r.prov?.tier ?? 'unknown';
      const cl = this.claimOf.get(id);
      const sure = tier === 'proven' && (!cl || cl.conf === 'confident');
      const e = { id, from: r.from, to: r.to, tier, sure };
      if (!this.out.has(r.from)) this.out.set(r.from, []);
      this.out.get(r.from).push(e);
      if (!this.inn.has(r.to)) this.inn.set(r.to, []);
      this.inn.get(r.to).push(e);
    }
    for (const a of this.out.values()) a.sort((x, y) => cmp(x.to, y.to) || cmp(x.id, y.id));
    // function-level calls the tool drew: caller function -> [callee function, line]
    this.fcalls = new Map();
    for (const [, r] of this.roads) {
      const pv = r.prov ?? {};
      if ((pv.rule !== 'call' && pv.rule !== 'link') || !pv.fn || num(pv.line) == null) continue;
      const to = this.boxes.get(r.to)?.prov?.fn;
      if (!to || to === pv.fn) continue;
      if (!this.fcalls.has(pv.fn)) this.fcalls.set(pv.fn, []);
      this.fcalls.get(pv.fn).push([to, pv.line]);
    }
    for (const a of this.fcalls.values()) a.sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1]);
  }

  /** The functions that call roads within `slack` lines of `line` in one function enter. */
  callTargets(fid, line, slack) {
    const out = new Set();
    for (const [to, l] of this.fcalls.get(fid) ?? []) if (Math.abs(l - line) <= slack) out.add(to);
    return out;
  }

  /** Is the map still the one the files under `root` make? true, false, or null when a mapped file cannot be read. */
  isFresh(root) {
    if (!this.digest) return null;
    const d = sourceDigest(root, this.mods);
    return d == null ? null : d === this.digest;
  }

  /** Every function whose span holds the line, innermost first. */
  chain(p, line) {
    const out = [];
    for (const [l, e, fid] of this.spans.get(p) ?? []) if (l <= line && line <= e) out.push([l, e, fid]);
    out.sort((x, y) => y[0] - x[0] || x[1] - y[1] || cmp(x[2], y[2]));
    return out.map((x) => x[2]);
  }

  /** How the tool's boxes stand at a line of one function: exact (a box stands on the line, spans it, or a call the tool draws is made on it),
   *  near (the line is the rest of a statement a box starts, or the line that opens the block a box stands in), fn-only, fn-unboxed.
   *  `shape`: { continuesFrom(a) -> bool, opens() -> bool }, read from the source text. Returns [how, box ids, call road ids]. */
  cover(fid, line, shape) {
    const hit = [...(this.lineBoxes.get(fid)?.get(line) ?? [])];
    for (const [a, b, id] of this.ranges.get(fid) ?? []) if (a <= line && line <= b && !hit.includes(id)) hit.push(id);
    const calls = this.callAt.get(fid)?.get(line) ?? [];
    for (const rid of calls) { const r = this.roads.get(rid); for (const x of r.prov.rule === 'exc-edge' ? [r.from] : [r.from, r.to]) if (!hit.includes(x)) hit.push(x); }
    if (hit.length) return ['exact', hit.sort(cmp), calls];
    const an = this.anchors.get(fid);
    if (!an) return ['fn-unboxed', [], []];
    const above = an.filter(([l]) => l < line && line - l <= MAX_STATEMENT_LINES);
    if (above.length) {
      const at = Math.max(...above.map((x) => x[0]));
      if (shape && shape.continuesFrom(at)) return ['near', [...new Set(above.filter(([l]) => l === at).map((x) => x[1]))].sort(cmp), []];
    }
    const below = an.filter(([l]) => l === line + 1);
    if (below.length && shape && shape.opens()) return ['near', [...new Set(below.map((x) => x[1]))].sort(cmp), []];
    return ['fn-only', [], []];
  }

  /** The function and every function written inside it (closures, callbacks): the code a box "in" a function really includes. */
  withClosures(fids) {
    const out = new Set(fids);
    for (const fid of fids) {
      const f = this.fns.get(fid);
      if (!f) continue;
      for (const [l, e, g] of this.spans.get(fnPath(fid)) ?? []) if (f.line <= l && e <= f.end) out.add(g);
    }
    return out;
  }
}

export { fnPath };
