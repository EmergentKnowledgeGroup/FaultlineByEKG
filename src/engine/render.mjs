// Shared SVG renderer (pure string builder; runs in node and in the browser).
// renderSVG(geom, opts) -> '<svg ...>' string with data-node / data-edge hooks for the viewer.
//
// Look tables. Node kinds are the model's box kinds (CONTRACTS section 5): colour is the box outline and its left tab; a wait box is dashed;
// an end box is a pill without a tab. Route types: forward, return (red dashed), record (writes evidence or a side effect), deliver (hands
// something to a person or outside). A kind or type that is not in the table falls back to step / forward. opts.kinds / opts.edges merge
// over these tables (e.g. { kinds: { gate: { color: '#c08' } } }).
export const KIND = {
  step: { color: '#59b7a1' },
  decision: { color: '#7db6bd' },
  gate: { color: '#8aa6dd' },
  wait: { color: '#e2af69', dash: '7 4' },
  store: { color: '#52a9de' },
  external: { color: '#b598e8' },
  end: { color: '#9aa9b9', pill: true },
};
export const EDGE = {
  forward: { color: '#8fb0ba', dash: '' },
  deliver: { color: '#5fb4ee', dash: '' },
  record: { color: '#bda2e5', dash: '' },
  return: { color: '#ec8f86', dash: '7 5' },
};
const kindOf = n => n.kind ?? n.category;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f = n => Math.round(n * 10) / 10;

// ---- official handle chips (the box's own name for itself, shown as a tab on its top border) ---------------------------
// Colour families come from OPTIONS, never from the shape of the handle text:
//   opts.chips = { families: { <key>: { name, fill, line, ink } }, familyOf: (handle, node) => key, maxChars: 16 }
// familyOf defaults to node.family (else 'default'; build sets family to the stage id). A key with no entry in `families` takes the next
// colour of CHIP_PALETTE in order of first appearance, so every family is distinct with no configuration at all.
export const CHIP_PALETTE = [
  { fill: '#43296f', line: '#b995ff', ink: '#f6f0ff' },
  { fill: '#1d3f73', line: '#6aa6ff', ink: '#eef4ff' },
  { fill: '#0f4a46', line: '#3fd0bf', ink: '#e8fbf8' },
  { fill: '#5a3d0b', line: '#f0b44a', ink: '#fff6e6' },
  { fill: '#2f3d4a', line: '#a9bccb', ink: '#f1f5f8' },
];
const hasHandle = n => n.handle && String(n.handle).trim();
const famKey = (n, copt) => String((copt.familyOf ? copt.familyOf(String(n.handle).trim(), n) : n.family) || 'default');
const famClass = k => String(k).replace(/[^\w-]/g, '-');
// resolved families of the handles present on a chart: { key: { name, fill, line, ink } } (also what a legend lists)
export function chipFamilies(g, copt = {}) {
  const out = {}; let next = 0;
  for (const n of g.nodes) {
    if (!hasHandle(n)) continue;
    const k = famKey(n, copt);
    if (!out[k]) out[k] = copt.families?.[k] || { name: k, ...CHIP_PALETTE[next++ % CHIP_PALETTE.length] };
  }
  return out;
}
const CHIP_H = 18, CHIP_CH = 7.05, CHIP_PAD = 12, CHIP_MAX = 16, CHIP_GROW = 1.4;
const MONO = 'ui-monospace,SFMono-Regular,Consolas,Menlo,monospace';
export const CUT = '···';                                       // the mark of a cut tab. Three middle dots: the low dots of an ellipsis read as an underscore in the code font, and a name can hold an underscore, never this
const chipText = (tag, max = CHIP_MAX) => { const t = String(tag).trim(); return t.length > max ? t.slice(0, max - CUT.length) + CUT : t; };
const chipW = (tag, max = CHIP_MAX) => Math.round(chipText(tag, max).length * CHIP_CH + CHIP_PAD);

// ---- what each tab says -------------------------------------------------------------------------------------------------------
// A tab hangs from its box's top-left corner and is never much wider than the box (TAB_MAX characters at most; copt.maxChars fixes the number instead).
// A handle that fits is shown whole. One that does not:
//   1. when 3 or more tabs of the chart start the same way ("Parser."), that start is left out of those tabs and the page says it once (plan.prefix);
//   2. what is still too long is cut in the middle, so the start and the end both survive;
//   3. two tabs that would read the same get another cut point.
// One handle held by 3 or more boxes AND by 40% of the chart's tabs is said once in the header (plan.shared) and drawn on none of those boxes.
// The full name is a tooltip on every tab that shows less (chipSVG).
const TAB_MAX = 32;
const SEPR = /[._\/:\-\s]/;
const boundaryAt = (s, i) => i > 0 && i < s.length && (SEPR.test(s[i - 1]) || (/[a-z0-9]/.test(s[i - 1]) && /[A-Z]/.test(s[i])));
function sharedStart(a, b) {                                          // the longest start both share that ends where a word ends, 0 when none
  let n = 0; const m = Math.min(a.length, b.length);
  while (n < m && a[n] === b[n]) n++;
  while (n > 0 && !(n < a.length && n < b.length && boundaryAt(a, n))) n--;
  return n;
}
export function middleCut(s, cap, tail) {                             // s cut to at most cap characters: head + "…" + the last `tail` characters, both ends moved to a word boundary when one is near
  if (s.length <= cap) return s;
  let head = Math.max(2, cap - CUT.length - tail), t = Math.min(tail, cap - 4);
  // first choice: both ends on a word or path boundary ("Open /" ... "orders", never "Open /" ... "rders"): of the pairs that fit in cap and lie within 8 characters of the plan, the one that keeps the most text
  let best = null;
  const hs = [], us = [], lim = Math.min(cap, 30);                    // (a cut tab is never wider than 30 characters, as before)
  for (let h = Math.max(3, head - 8); h <= head + 8; h++) if (boundaryAt(s, h)) hs.push(h);       // the boundaries within reach of each end, found once
  for (let u = Math.max(3, t - 8); u <= t + 8; u++) if (boundaryAt(s, s.length - u)) us.push(u);
  for (const h of hs) for (const u of us) {
    if (h + u + CUT.length > lim || h + u > s.length - 3) continue;
    const c = (h + u) * 10 - (Math.abs(h - head) + Math.abs(u - t));
    if (!best || c > best.c) best = { h, u, c };
  }
  if (best) return s.slice(0, best.h) + CUT + s.slice(s.length - best.u);
  for (let k = 0; k <= 6; k++) if (boundaryAt(s, head - k) && head - k >= 3) { head -= k; break; }
  for (let k = 0; k <= 6; k++) if (t - k >= 3 && boundaryAt(s, s.length - t + k)) { t -= k; break; }
  return s.slice(0, head) + CUT + s.slice(s.length - t);
}
function tabVariants(plan, n) {                                        // the tab's text, then shorter cuts of it: a long tab that would sit on a road or a label gives way to a shorter one
  const t0 = plan.text[n.id], out = [t0], base = plan.base[n.id];
  for (let c = t0.length - 4; c >= 14; c -= 4) out.push(middleCut(base, c, Math.round((c - 1) * 0.42)));
  return out;
}
export function chipPlan(g, copt = {}) {
  const plan = { text: {}, base: {}, full: {}, drop: {}, prefix: '', shared: null };
  let live = g.nodes.filter(hasHandle);
  if (!live.length) return plan;
  for (const n of live) plan.full[n.id] = String(n.handle).trim();
  const capOf = n => (copt.maxChars != null ? copt.maxChars : Math.max(14, Math.min(TAB_MAX, Math.floor((n.w + 30 - CHIP_PAD) / CHIP_CH))));
  const cnt = new Map(); for (const n of live) cnt.set(plan.full[n.id], (cnt.get(plan.full[n.id]) || 0) + 1);
  for (const [h, c] of cnt) if (c >= 3 && c >= 0.4 * live.length && (!plan.shared || c > plan.shared.count)) plan.shared = { handle: h, count: c };
  if (plan.shared) live = live.filter(n => { if (plan.full[n.id] === plan.shared.handle) { plan.drop[n.id] = true; return false; } return true; });
  let cut = 0, members = [];
  if (live.length >= 3 && live.length <= 60) {                                // a chart; the whole map is laid out per stage and keeps its own tabs (and its open time)
    const seen = new Set(), hs = live.map(n => plan.full[n.id]); let best = null;
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
      const k = sharedStart(hs[i], hs[j]); if (k < 4) continue;
      const P = hs[i].slice(0, k); if (seen.has(P) || !(k >= 10 || /[.\/:]$/.test(P))) continue; seen.add(P);     // a start worth leaving out: a qualifier ("Queue.", "/api/") or a long one, never a verb like "move"
      const mem = live.filter(n => plan.full[n.id].startsWith(P) && plan.full[n.id].length - k >= 2);
      if (mem.length < 3 || !(mem.some(n => plan.full[n.id].length > capOf(n)) || mem.length >= 0.5 * live.length)) continue;
      if (!best || mem.length * k > best.score) best = { P, mem, score: mem.length * k };
    }
    if (best) { plan.prefix = best.P; cut = best.P.length; members = best.mem; }
  }
  const inPrefix = new Set(members.map(n => n.id)), used = new Map();
  for (const n of live) {
    const cap = capOf(n), base = inPrefix.has(n.id) ? plan.full[n.id].slice(cut) : plan.full[n.id];
    const tails = [Math.round((cap - 1) * 0.42), Math.round((cap - 1) * 0.3), Math.round((cap - 1) * 0.55), 5, 6, 7, 8, 9, 10, 11, 12];
    let t = middleCut(base, cap, tails[0]);
    if (used.has(t) && used.get(t) !== base) for (const tl of tails) { const c = middleCut(base, cap, tl); if (!used.has(c) || used.get(c) === base) { t = c; break; } }
    used.set(t, base); plan.text[n.id] = t; plan.base[n.id] = base;
  }
  return plan;
}

const drawnLabel = (e, shifts) => { const sh = shifts && shifts.get(e.id), b = e.labelBox; return sh ? { x: b.x + sh.dx, y: b.y + sh.dy, w: b.w, h: b.h } : b; };
const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const grow = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });

// Where does each handled node's chip go?  Default: a tab straddling the TOP-LEFT border.  If that spot would touch a route end,
// an arrowhead, an edge-label pill, another node, a cluster caption, the node's own text or another chip, slide it along the top
// border, then try hanging off the top-left corner, then the bottom border.  Never moves geometry; returns {nodeId: {x,y,w,h,text,fam,anchor,clean}}.
export function chipLayout(g, copt = {}) {
  const out = {}, plan = chipPlan(g, copt);
  // a tab is drawn larger than it is laid out (the viewer grows it as the chart shrinks, from its left edge). copt.grow is the growth the caller expects at the zoom the chart opens at; the layout first looks for a place clear at that growth,
  // then at half of it, then at none. Without it the reserve is CHIP_GROW, as before.
  const GROWTH = copt.grow != null ? Math.max(1, Math.min(1.6, copt.grow)) : CHIP_GROW, GROWS = copt.grow == null ? [CHIP_GROW, 1] : GROWTH > 1.03 ? [GROWTH, 1 + (GROWTH - 1) / 2, 1] : [1], NEED = copt.grow != null ? GROWTH : 1;
  const tagged = g.nodes.filter(n => hasHandle(n) && plan.text[n.id] != null);
  if (!tagged.length) return out;
  const obst = [], shifts = tagged.length <= 60 && copt.attach !== false ? labelShifts(g) : null;       // {r, kind, owner}
  for (const n of g.nodes) obst.push({ r: grow(n, 2), kind: 'node', owner: n.id });
  for (const e of g.edges) {
    const P = e.pts;
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1], last = i === P.length - 2;
      // the final run carries the arrowhead (about 12 long, 12 wide): keep chips clear of that whole strip
      const m = last ? 8 : 4;
      obst.push({ r: { x: Math.min(a[0], b[0]) - m, y: Math.min(a[1], b[1]) - m, w: Math.abs(a[0] - b[0]) + 2 * m, h: Math.abs(a[1] - b[1]) + 2 * m }, kind: 'edge', owner: e.id });
    }
    if (e.labelBox) obst.push({ r: grow(drawnLabel(e, shifts), 4), kind: 'label', owner: e.id });       // the pill is drawn where labelShifts puts it
  }
  for (const c of g.clusters || []) {
    const t = String(c.title || ''); if (t) obst.push({ r: { x: c.x + 12, y: c.y + 8, w: t.length * 9.8 + 8, h: 22 }, kind: 'cluster', owner: c.id });
  }
  const placed = [];
  const words = [];                                      // every box's own words (a conservative width: 8 px per character at 15 px): a tab that grows onto another box's name is not a place worth keeping
  for (const m of g.nodes) { const L = m.lines.length, lh = 19, ty0 = m.y + m.h / 2 - ((L - 1) * lh) / 2 + 5.2; m.lines.forEach((l, i) => { const tw = l.length * 8 + 6; words.push({ owner: m.id, r: { x: m.x + m.w / 2 + 2 - tw / 2, y: ty0 + i * lh - 13, w: tw, h: 17 } }); }); }
  const order = tagged.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  for (const n of order) {
   let result = null, keep = null;
   for (const text of tagged.length > 60 ? [plan.text[n.id]] : tabVariants(plan, n)) {
    const w = Math.round(text.length * CHIP_CH + CHIP_PAD), h = CHIP_H;
    const cands = [];
    const topY = n.y - h / 2, botY = n.y + n.h - h / 2;
    const xMin = n.x + 10, xMax = n.x + n.w - w - 10;
    cands.push({ x: xMin, y: topY, a: 'top-left' });
    for (let x = xMin + 14; x <= Math.max(xMin, xMax) + 0.1; x += 14) cands.push({ x, y: topY, a: 'top' });
    if (xMax > xMin + 1) cands.push({ x: xMax, y: topY, a: 'top-right' });
    cands.push({ x: n.x - w + 20, y: topY - 2, a: 'corner' });
    cands.push({ x: xMin, y: botY, a: 'bottom-left' });
    for (let x = xMin + 14; x <= Math.max(xMin, xMax) + 0.1; x += 14) cands.push({ x, y: botY, a: 'bottom' });
    // the node's own text (conservative width estimate: 8px per character at 15px)
    const L = n.lines.length, lh = 19, ty0 = n.y + n.h / 2 - ((L - 1) * lh) / 2 + 5.2;
    const own = n.lines.map((l, i) => { const tw = l.length * 8 + 6; return { x: n.x + n.w / 2 + 2 - tw / 2, y: ty0 + i * lh - 13, w: tw, h: 17 }; });
    let best = null;
    // pass 1 reserves room for the viewer's low-zoom enlargement (it scales a chip from its left edge); pass 2 only if nothing fits
    for (const gr of GROWS) {
      for (const c of cands) {
        const r = { x: c.x, y: c.y - (gr > 1 ? 3 : 0), w: Math.round(w * gr), h: h + (gr > 1 ? 6 : 0) };
        let bad = 0, edgeHit = 0;
        for (const o of obst) {
          if (o.kind === 'node' && o.owner === n.id) continue;
          if (hit(r, o.r)) { bad++; if (o.kind === 'edge') edgeHit++; }
        }
        for (const t of own) if (hit(r, t)) bad += 3;
        for (const p of placed) if (hit(r, grow(p.env, 3))) bad++;
        if (bad === 0) { best = { c, bad, edgeHit, gr }; break; }
        if (!best || bad < best.bad) best = { c, bad, edgeHit, gr };
      }
      if (best && best.bad === 0) break;
    }
    // pass 3, only for a chip that needs it. A chip that is clean AND inside the chart is never touched, so every such placement stays identical.
    //  (a) nothing clean above (a long handle on a narrow box whose route enters at the middle of the top border): hang it off a corner, nudged clear of labels beside the box;
    //  (b) the clean spot hangs OUTSIDE the chart (more than 14px past an edge: the standalone viewBox then grows and the page's Fit is off): look for a clean spot inside; keep the old one if there is none.
    const outside = c => c.x < -14 || c.y < -14 || c.x + w > g.width + 14 || c.y + h > g.height + 14;
    if (best && (best.bad > 0 || outside(best.c))) {
      const extra = [];
      for (const dy of [0, 5, 9]) extra.push({ x: n.x + n.w - 20, y: topY - 2 - dy, a: 'corner-right' });
      for (const dy of [5, 9]) extra.push({ x: n.x - w + 20, y: topY - 2 - dy, a: 'corner-left' });                                            // dy 0 is the 'corner' candidate above
      for (const dy of [0, 5, 9]) extra.push({ x: n.x + n.w - 20, y: botY + 2 + dy, a: 'corner-bottom-right' }, { x: n.x - w + 20, y: botY + 2 + dy, a: 'corner-bottom-left' });
      const pool = cands.concat(extra); let found = null; const fine = [];
      for (const inOnly of best.bad > 0 ? [true, false] : [true]) {
        for (const gr of GROWS) {
          for (const c of pool) {
            if (inOnly && outside(c)) continue;
            const r = { x: c.x, y: c.y - (gr > 1 ? 3 : 0), w: Math.round(w * gr), h: h + (gr > 1 ? 6 : 0) };
            let bad = 0, edgeHit = 0;
            for (const o of obst) {
              if (o.kind === 'node' && o.owner === n.id) continue;
              if (hit(r, o.r)) { bad++; if (o.kind === 'edge') edgeHit++; }
            }
            for (const t of own) if (hit(r, t)) bad += 3;
            for (const q of placed) if (hit(r, grow(q.env, 3))) bad++;
            if (bad === 0) { found = { c, bad, edgeHit, gr }; break; }
          }
          if (found) break;
        }
        if (found) break;
      }
      // pass 4, only when pass 3 found nothing (dense layouts): sweep the top and bottom borders in 4px steps, then straddle a side wall
      if (!found && best.bad > 0) {
        for (let x = n.x + 4; x <= n.x + n.w - w - 4 + 0.1; x += 4) fine.push({ x, y: topY, a: 'top' }, { x, y: botY, a: 'bottom' });
        for (let y = n.y + 4; y <= n.y + n.h - h - 4 + 0.1; y += 5) fine.push({ x: n.x - w + 14, y, a: 'left' }, { x: n.x + n.w - 14, y, a: 'right' });
        for (const k of [4, 8, 12, 16, 20, 24, 28]) fine.push({ x: n.x - w + 20 - k, y: topY - 2, a: 'corner-left' }, { x: n.x + n.w - 20 + k, y: topY - 2, a: 'corner-right' },
          { x: n.x - w + 20 - k, y: botY + 2, a: 'corner-bottom-left' }, { x: n.x + n.w - 20 + k, y: botY + 2, a: 'corner-bottom-right' });
        for (const gr of GROWS) {
          for (const c of fine) {
            if (outside(c)) continue;
            const r = { x: c.x, y: c.y - (gr > 1 ? 3 : 0), w: Math.round(w * gr), h: h + (gr > 1 ? 6 : 0) };
            let bad = 0, edgeHit = 0;
            for (const o of obst) {
              if (o.kind === 'node' && o.owner === n.id) continue;
              if (hit(r, o.r)) { bad++; if (o.kind === 'edge') edgeHit++; }
            }
            for (const t of own) if (hit(r, t)) bad += 3;
            for (const q of placed) if (hit(r, grow(q.env, 3))) bad++;
            if (bad === 0) { found = { c, bad, edgeHit, gr }; break; }
          }
          if (found) break;
        }
      }
      if (found) best = found;
      else if (best.bad > 0) {
        // no clean place on this chart. Of every place tried, take the one that touches the fewest WORDS: a road condition or the box's own name counts most, another box or tab next, a road least
        // (a tab over a road is a blemish; a tab over words is unreadable). Only a tab that has no clean place is moved by this.
        const weigh = (r) => {
          let k = 0;
          for (const o of obst) { if (o.kind === 'node' && o.owner === n.id) continue; if (hit(r, o.r)) k += o.kind === 'label' ? 100 : o.kind === 'node' ? 60 : o.kind === 'cluster' ? 20 : 1; }
          for (const t of own) if (hit(r, t)) k += 100;
          for (const q of placed) if (hit(r, grow(q.env, 3))) k += 60;
          return k;
        };
        let lo = null;
        for (const gr of GROWS) for (const c of pool.concat(fine)) {
          const r = { x: c.x, y: c.y - (gr > 1 ? 3 : 0), w: Math.round(w * gr), h: h + (gr > 1 ? 6 : 0) };
          const k = weigh(r) + (outside(c) ? 30 : 0) + (gr > 1 ? 0 : 2);
          if (!lo || k < lo.k) lo = { k, c, gr };
        }
        if (lo) {
          const r = { x: lo.c.x, y: lo.c.y - (lo.gr > 1 ? 3 : 0), w: Math.round(w * lo.gr), h: h + (lo.gr > 1 ? 6 : 0) };
          let bad = 0, edgeHit = 0; for (const o of obst) { if (o.kind === 'node' && o.owner === n.id) continue; if (hit(r, o.r)) { bad++; if (o.kind === 'edge') edgeHit++; } }
          for (const t of own) if (hit(r, t)) bad += 3;
          for (const q of placed) if (hit(r, grow(q.env, 3))) bad++;
          if (weigh({ x: best.c.x, y: best.c.y - (best.gr > 1 ? 3 : 0), w: Math.round(w * best.gr), h: h + (best.gr > 1 ? 6 : 0) }) > lo.k) best = { c: lo.c, bad, edgeHit, gr: lo.gr };
        }
      }
    }
    const pl = { x: best.c.x, y: best.c.y, w, h, text, full: plan.full[n.id], fam: famKey(n, copt), anchor: best.c.a, clean: best.bad === 0, edgeHit: best.edgeHit, grow: best.gr };
    // clean only at less growth than the caller expects. That is fine while no WORDS (a road condition, a box's own name) are under the tab at the whole growth (a road or a box edge under it is a blemish, not a defect);
    // otherwise a shorter cut of the tab may be clean at the whole growth, and the first clean one is kept in case none is
    let okFull = best.bad === 0 && (best.gr >= NEED - 1e-6 || (() => { const rN = { x: best.c.x, y: best.c.y - 3, w: Math.round(w * NEED), h: h + 6 }; return !obst.some(o => o.kind === 'label' && hit(rN, o.r)) && !own.some(t => hit(rN, t)) && !words.some(t => t.owner !== n.id && hit(rN, t.r)); })());
    result = { pl, env: { x: pl.x, y: pl.y, w: Math.round(w * Math.max(best.gr, NEED)), h }, gr: best.gr, okFull };      // the room a tab keeps for itself is what it will take at the size the chart opens at, so a later tab does not settle where the first one grows into it
    if (best.bad === 0) { if (okFull) break; if (!keep) keep = result; }
   }
   if (keep && !(result.pl.clean && result.okFull)) result = keep;
   out[n.id] = result.pl; placed.push({ env: result.env });
  }
  return out;
}
const chipTextSVG = (t) => { const i = t.indexOf(CUT); return i < 0 ? esc(t) : esc(t.slice(0, i)) + `<tspan class="chip-cut">${CUT}</tspan>` + esc(t.slice(i + CUT.length)); };
function chipSVG(pl, tag, fams) {
  const F = fams[pl.fam];
  return `<g class="chip fam-${famClass(pl.fam)}" data-handle="${esc(tag)}" data-anchor="${pl.anchor}">${pl.full && pl.full !== pl.text ? `<title>${esc(pl.full)}</title>` : ''}<rect class="chip-bg" x="${f(pl.x)}" y="${f(pl.y)}" width="${pl.w}" height="${pl.h}" rx="5" fill="${F.fill}" stroke="${F.line}" stroke-width="1"/>` +
    `<text class="chip-text" x="${f(pl.x + pl.w / 2)}" y="${f(pl.y + 12.7)}" text-anchor="middle" font-family="${MONO}" font-size="11.5" font-weight="700" fill="${F.ink}">${chipTextSVG(pl.text)}</text></g>`;
}

// ---- cross-chart PORTALS (where a flow enters this chart from another chart / leaves it for another chart) -------------------
// renderSVG(g, { portals: chart.portals }) marks every node that has a portal:
//   * a RING 5px outside the box: cool green = entry from another chart, warm orange = exit to another chart, split (left half cool,
//     right half warm) when both.  The ring is dashed with GAPS exactly where a route touches the box, so no arrowhead is ever covered.
//   * a small round BADGE on the node's right side (arrow glyph; a digit when there are several connections).
// Pure overlay: no geometry moves.  portals = [{node, dir:'in'|'out', chart, node2, kind, label, why}] (absent / malformed entries are ignored).
export const PORTAL = { in: { fill: '#35d39b', ink: '#07241c', line: '#35d39b' }, out: { fill: '#ffab40', ink: '#2a1600', line: '#ffab40' } };
const PB_H = 18, PB_RING = 5;
const PB_GLYPH = { in: 'M4.6 -4.2 V4.2 M-4.4 0 H2.2 M-0.8 -3 L2.4 0 L-0.8 3', out: 'M-4.6 -4.2 V4.2 M-2.2 0 H4.4 M1.2 -3 L4.4 0 L1.2 3' };   // enter = arrow into a wall, exit = arrow out of a wall
// Drill-down links (kind 'detail': "this box opens in a finer chart") are NOT flow entries/exits, and on overview charts every box has one, so by
// default they get no ring or badge (they live in the flow bar and the inspector).  portals.detailMarks / opts.detailMarks = true marks them too.
export function portalMap(g, portals, detailMarks = false) {
  const m = {}; if (!Array.isArray(portals)) return m;
  const have = new Set(g.nodes.map(n => n.id));
  for (const p of portals) {
    if (!p || !have.has(p.node)) continue;
    if (!detailMarks && p.kind === 'detail') continue;
    const d = p.dir === 'out' ? 'out' : 'in';
    (m[p.node] || (m[p.node] = { in: 0, out: 0 }))[d]++;
  }
  return m;
}
function ringGeom(n, d, pill) {
  const base = pill ? n.h / 2 : 11, r = Math.min(base + d, (n.h + 2 * d) / 2), w = n.w + 2 * d, h = n.h + 2 * d;
  const sx = Math.max(0, w - 2 * r), sy = Math.max(0, h - 2 * r), arc = Math.PI * r / 2;
  return { x: n.x - d, y: n.y - d, w, h, r, sx, sy, arc, P: 2 * sx + 2 * sy + 4 * arc, topMid: sx / 2, botMid: sx + arc + sy + arc + sx / 2 };
}
function ringPos(R, n, px, py) {       // perimeter position (clockwise from the top-left straight) of the border point nearest to (px,py)
  const dl = Math.abs(px - n.x), dr = Math.abs(px - (n.x + n.w)), dt = Math.abs(py - n.y), db = Math.abs(py - (n.y + n.h));
  const m = Math.min(dl, dr, dt, db), cl = (v, a, b) => Math.max(a, Math.min(b, v));
  if (m === dt) return cl(px - (R.x + R.r), 0, R.sx);
  if (m === dr) return R.sx + R.arc + cl(py - (R.y + R.r), 0, R.sy);
  if (m === db) return R.sx + R.arc + R.sy + R.arc + cl(R.x + R.w - R.r - px, 0, R.sx);
  return 2 * R.sx + R.sy + 3 * R.arc + cl(R.y + R.h - R.r - py, 0, R.sy);
}
function subtractGaps(on, gaps) {
  let out = on.map(a => a.slice());
  for (const [g0, g1] of gaps) {
    const next = [];
    for (const [a, b] of out) { if (g1 <= a || g0 >= b) { next.push([a, b]); continue; } if (g0 > a) next.push([a, g0]); if (g1 < b) next.push([g1, b]); }
    out = next;
  }
  return out.filter(([a, b]) => b - a > 0.5).sort((p, q) => p[0] - q[0]);
}
function dashFrom(on, P) {            // sorted "on" intervals -> a stroke-dasharray that starts "on" at 0 and sums to P
  if (!on.length) return null;
  const d = []; let cur = 0;
  on.forEach(([a, b], i) => {
    if (i === 0 && a > 0.01) d.push(0, +a.toFixed(1)); else if (i > 0) d.push(+(a - cur).toFixed(1));
    d.push(+(b - a).toFixed(1)); cur = b;
  });
  d.push(+(P - cur).toFixed(1));
  return d;
}
function ringSVG(n, mp, g, pill) {
  const R = ringGeom(n, PB_RING, pill), gaps = [];
  for (const e of g.edges) {
    const P = e.pts; if (!P || P.length < 2) continue;
    if (e.to === n.id) gaps.push([ringPos(R, n, P[P.length - 1][0], P[P.length - 1][1]), 10]);
    if (e.from === n.id) gaps.push([ringPos(R, n, P[0][0], P[0][1]), 6]);
  }
  const wrap = ([a, b]) => (a < 0 ? [[0, b], [R.P + a, R.P]] : b > R.P ? [[a, R.P], [0, b - R.P]] : [[a, b]]);
  const gaps2 = gaps.flatMap(([c, hw]) => wrap([c - hw, c + hw]));
  const mk = (dir, on) => {
    const da = dashFrom(subtractGaps(on, gaps2), R.P); if (!da) return '';
    return '<rect class="portal-ring pr-' + dir + '" x="' + f(R.x) + '" y="' + f(R.y) + '" width="' + f(R.w) + '" height="' + f(R.h) + '" rx="' + f(R.r) + '" fill="none" style="stroke:var(--p-' + dir + ',' + PORTAL[dir].line + ')" stroke-width="2.6" stroke-dasharray="' + da.join(' ') + '"/>';
  };
  if (mp.in && mp.out) return mk('in', [[R.botMid, R.P], [0, R.topMid]]) + mk('out', [[R.topMid, R.botMid]]);   // left half cool, right half warm
  return mk(mp.in ? 'in' : 'out', [[0, R.P]]);
}
const pbParts = mp => (mp.in ? [{ dir: 'in', c: mp.in }] : []).concat(mp.out ? [{ dir: 'out', c: mp.out }] : []);
const pbSegW = c => (c > 1 ? 15 + String(c).length * 6.4 + 3 : PB_H);
const pbSize = mp => ({ w: pbParts(mp).reduce((a, x) => a + pbSegW(x.c), 0), h: PB_H });
// Where does each node's badge go?  Straddling the node's right border (right end 7px outside): top corner first, then bottom corner,
// then along the edge, then the bottom/top border near the right end, then the left side.  Avoids routes (and arrowheads), labels,
// other nodes, the node's own text, handle chips and other badges.  Returns {nodeId: {x,y,w,h,clean}}.
// pg: how much larger than its layout a badge is drawn when the chart opens (the viewer grows it about its middle as the chart shrinks); the places are tested at that size, and a place on a tab or on a road condition counts against it more than one on a road
export function portalLayout(g, pmap, chips, pg = 1) {
  const out = {}, ids = Object.keys(pmap); if (!ids.length) return out;
  const PG = Math.max(1, Math.min(2.6, pg || 1)), big = (r) => (PG > 1.02 ? { x: r.x - r.w * (PG - 1) / 2, y: r.y - r.h * (PG - 1) / 2, w: r.w * PG, h: r.h * PG } : r);
  const obst = [], shifts = g.nodes.length <= 150 ? labelShifts(g) : null;
  for (const n of g.nodes) obst.push({ r: grow(n, 2), kind: 'node', owner: n.id });
  for (const e of g.edges) {
    const P = e.pts;
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1], last = i === P.length - 2, m = last ? 8 : 3.5;
      obst.push({ r: { x: Math.min(a[0], b[0]) - m, y: Math.min(a[1], b[1]) - m, w: Math.abs(a[0] - b[0]) + 2 * m, h: Math.abs(a[1] - b[1]) + 2 * m }, kind: 'edge', owner: e.id });
    }
    if (e.labelBox) obst.push({ r: grow(drawnLabel(e, shifts), 4), kind: 'label', owner: e.id });       // the pill is drawn where labelShifts puts it
  }
  for (const c of g.clusters || []) { const t = String(c.title || ''); if (t) obst.push({ r: { x: c.x + 12, y: c.y + 8, w: t.length * 9.8 + 8, h: 22 }, kind: 'cluster', owner: c.id }); }
  for (const id in chips || {}) { const c = chips[id]; obst.push({ r: grow({ x: c.x, y: c.y, w: Math.round(c.w * (c.grow || CHIP_GROW)), h: c.h }, 3), kind: 'chip', owner: id }); }
  const placed = [];
  const nodes = g.nodes.filter(n => pmap[n.id]).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const n of nodes) {
    const sz = pbSize(pmap[n.id]), W = sz.w, H = sz.h, rightX = n.x + n.w + 7 - W, midX = n.x + n.w - W / 2 - 4, cands = [];
    cands.push({ x: rightX, y: n.y + 2 }, { x: rightX, y: n.y + n.h - H - 2 });
    for (const t of [0.3, 0.7, 0.5]) cands.push({ x: rightX, y: n.y + n.h * t - H / 2 });
    cands.push({ x: midX, y: n.y - H / 2 }, { x: midX, y: n.y + n.h - H / 2 });
    cands.push({ x: n.x + 6, y: n.y + n.h - H / 2 }, { x: n.x - W + 7, y: n.y + n.h - H - 2 }, { x: n.x - W + 7, y: n.y + 2 });
    for (const t of [0.85, 0.7, 0.55, 0.4, 0.25]) cands.push({ x: n.x + n.w * t - W / 2, y: n.y + n.h - H / 2 }, { x: n.x + n.w * t - W / 2, y: n.y - H / 2 });
    for (const t of [0.2, 0.8]) cands.push({ x: n.x - W + 7, y: n.y + n.h * t - H / 2 });
    const L = n.lines.length, lh = 19, ty0 = n.y + n.h / 2 - ((L - 1) * lh) / 2 + 5.2;
    const own = n.lines.map((l, i) => { const tw = l.length * 8 + 6; return { x: n.x + n.w / 2 + 2 - tw / 2, y: ty0 + i * lh - 13, w: tw, h: 17 }; });
    let best = null;
    for (const c of cands) {
      const r = big({ x: c.x, y: c.y, w: W, h: H });
      let bad = 0;
      for (const o of obst) { if (o.kind === 'node' && o.owner === n.id) continue; if (hit(r, o.r)) bad += o.kind === 'chip' || o.kind === 'label' ? 4 : 1; }
      for (const t of own) if (hit(r, t)) bad += 3;
      for (const p of placed) if (hit(r, grow(big(p), 3))) bad += 2;
      if (!best || bad < best.bad) best = { c, bad };
      if (bad === 0) break;
    }
    const pl = { x: best.c.x, y: best.c.y, w: W, h: H, clean: best.bad === 0 };
    out[n.id] = pl; placed.push(pl);
  }
  return out;
}
function badgeSVG(pl, mp) {
  const parts = pbParts(mp), both = parts.length === 2, y = pl.y, h = PB_H, rr = h / 2;
  let x = pl.x, s = '<g class="pbadge" data-pin="' + mp.in + '" data-pout="' + mp.out + '" aria-hidden="true">';
  parts.forEach((p, i) => {
    const w = pbSegW(p.c), C = PORTAL[p.dir], st = 'style="fill:var(--p-' + p.dir + ',' + C.fill + ')"';
    if (!both) s += '<rect class="pb-bg pb-' + p.dir + '" x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + h + '" rx="' + rr + '" ' + st + '/>';
    else if (i === 0) s += '<path class="pb-bg pb-' + p.dir + '" d="M' + f(x + w) + ' ' + f(y) + 'H' + f(x + rr) + 'A' + rr + ' ' + rr + ' 0 0 0 ' + f(x + rr) + ' ' + f(y + h) + 'H' + f(x + w) + 'Z" ' + st + '/>';
    else s += '<path class="pb-bg pb-' + p.dir + '" d="M' + f(x) + ' ' + f(y) + 'H' + f(x + w - rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + f(x + w - rr) + ' ' + f(y + h) + 'H' + f(x) + 'Z" ' + st + '/>';
    const gx = x + (p.c > 1 ? 9 : w / 2), gy = y + h / 2;
    s += '<path class="pb-glyph" transform="translate(' + f(gx) + ' ' + f(gy) + ')" d="' + PB_GLYPH[p.dir] + '" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--p-ink-' + p.dir + ',' + C.ink + ')"/>';
    if (p.c > 1) s += '<text class="pb-n" x="' + f(x + 15) + '" y="' + f(y + 12.6) + '" font-family="' + MONO + '" font-size="10.5" font-weight="700" style="fill:var(--p-ink-' + p.dir + ',' + C.ink + ')">' + p.c + '</text>';
    x += w;
  });
  return s + '</g>';
}

// ---- edge path with rounded corners + hop-overs at crossings -------------------------------------------------
function segs(pts) { const s = []; for (let i = 0; i < pts.length - 1; i++) s.push([pts[i], pts[i + 1]]); return s; }

export function edgePath(pts, others = [], R = 9, HOP = 5) {
  if (pts.length < 2) return '';
  const verts = others.flatMap(o => segs(o).filter(([a, b]) => Math.abs(a[0] - b[0]) < 0.5)); // vertical segs of other edges
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const horiz = Math.abs(a[1] - b[1]) < 0.5, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.01) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    const rIn = i > 0 ? Math.min(R, len / 2) : 0, rOut = i < pts.length - 2 ? Math.min(R, len / 2) : 0;
    const sx = a[0] + ux * rIn, sy = a[1] + uy * rIn, ex = b[0] - ux * rOut, ey = b[1] - uy * rOut;
    if (i > 0) d += ` Q${f(a[0])} ${f(a[1])} ${f(sx)} ${f(sy)}`;
    if (horiz) {
      const y = a[1], x0 = Math.min(sx, ex), x1 = Math.max(sx, ex), hits = [];
      for (const [p, q] of verts) {
        const vx = p[0], y0 = Math.min(p[1], q[1]), y1 = Math.max(p[1], q[1]);
        if (vx > x0 + HOP + 2 && vx < x1 - HOP - 2 && y > y0 + 1 && y < y1 - 1) hits.push(vx);
      }
      hits.sort((m, n) => (ux > 0 ? m - n : n - m));
      let last = -1e9;
      for (const hx of hits) {
        if (Math.abs(hx - last) < HOP * 2 + 2) continue; last = hx;
        d += ` L${f(hx - ux * HOP)} ${f(y)} A${HOP} ${HOP} 0 0 ${ux > 0 ? 1 : 0} ${f(hx + ux * HOP)} ${f(y)}`;
      }
    }
    d += ` L${f(ex)} ${f(ey)}`;
  }
  return d;
}

// ---- a label says which road is its own ------------------------------------------------------------------------------------------
// The engine puts a pill NEXT to its road (a few units off), and on a chart with bundles of parallel roads that left the reader guessing. So the
// renderer draws each label that does not sit on its road with (1) a dot on its own road, at the point nearest the label, joined to the pill by a short stem,
// both in the road's colour, and (2) the words moved to the side of the pill that faces the road (left-aligned when the road is on the left, right-aligned when it is
// on the right), and the pill itself moved up to 2.5 units from the road. Nothing in the geometry moves: labelBox, metrics and every hard count are what they were.
// labelAttach(pts, box) -> { gap, q: [x, y] on the road, side: 'l'|'r'|'t'|'b'|'' (where the road lies relative to the box), axis: 'x'|'y'|'' }
export function labelAttach(pts, b) {
  let best = null;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const nearRange = (a0, a1, r0, r1, rc) => {                     // the coordinate on [a0,a1] nearest to the interval [r0,r1], and the gap between them
    const lo = Math.max(a0, r0), hi = Math.min(a1, r1);
    if (lo <= hi) return { v: clamp(rc, lo, hi), d: 0 };
    return a1 < r0 ? { v: a1, d: r0 - a1 } : { v: a0, d: a0 - r1 };
  };
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    let q, gap;
    if (Math.abs(x0 - x1) < 0.5) {                                 // vertical run at x
      const gx = Math.max(b.x - x0, x0 - (b.x + b.w), 0), r = nearRange(Math.min(y0, y1), Math.max(y0, y1), b.y, b.y + b.h, cy);
      q = [x0, r.v]; gap = Math.hypot(gx, r.d);
    } else if (Math.abs(y0 - y1) < 0.5) {                          // horizontal run at y
      const gy = Math.max(b.y - y0, y0 - (b.y + b.h), 0), r = nearRange(Math.min(x0, x1), Math.max(x0, x1), b.x, b.x + b.w, cx);
      q = [r.v, y0]; gap = Math.hypot(gy, r.d);
    } else {                                                        // a diagonal: sample it
      gap = 1e9; for (let k = 0; k <= 20; k++) { const x = x0 + (x1 - x0) * k / 20, y = y0 + (y1 - y0) * k / 20, d = Math.hypot(Math.max(b.x - x, x - (b.x + b.w), 0), Math.max(b.y - y, y - (b.y + b.h), 0)); if (d < gap) { gap = d; q = [x, y]; } }
    }
    if (!best || gap < best.gap - 1e-6) best = { gap, q };
  }
  if (!best) return null;
  const q = best.q, left = q[0] < b.x, right = q[0] > b.x + b.w, above = q[1] < b.y, below = q[1] > b.y + b.h;
  best.axis = left || right ? (above || below ? '' : 'x') : above || below ? 'y' : '';
  best.side = best.axis === 'x' ? (left ? 'l' : 'r') : best.axis === 'y' ? (above ? 't' : 'b') : '';
  return best;
}

// where each road-condition pill is DRAWN: against its road (labelAttach), unless moving there would touch another pill or a box that its original place did not. A pure function of the geometry,
// so the tab layout (chipLayout) can keep clear of the pill where it is drawn, not where the placer left it.
export function labelShifts(g) {
  const shiftOf = new Map(), bg = (r) => ({ x: r.x - 3, y: r.y - 1, w: r.w + 6, h: r.h + 2 }), cross = (p, q) => Math.max(0, Math.min(Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x), Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y)));   // how deep two rectangles overlap (0 when they do not)
  const moved = [];
  for (const e of g.edges) {
    if (!e.labelBox) continue;
    const A = labelAttach(e.pts, e.labelBox); if (!A || A.gap <= 2.5 || !A.axis) continue;
    const pad = A.axis === 'x' ? 3 : 1, sh = Math.min(Math.max(A.gap - pad - 1.5, 0), 6); if (sh <= 0) continue;
    const dx = A.side === 'l' ? -sh : A.side === 'r' ? sh : 0, dy = A.side === 't' ? -sh : A.side === 'b' ? sh : 0;
    moved.push({ e, dx, dy, now: bg({ x: e.labelBox.x + dx, y: e.labelBox.y + dy, w: e.labelBox.w, h: e.labelBox.h }), was: bg(e.labelBox) });
    shiftOf.set(e.id, { dx, dy });
  }
  const labelled = g.edges.filter(e => e.labelBox);
  for (const m of moved) {
    let bad = g.nodes.some(n => cross(m.now, n) > cross(m.was, n) + 0.25);
    for (const e2 of labelled) {
      if (bad || e2 === m.e) break;
      const o2 = shiftOf.get(e2.id), r2 = bg(o2 ? { x: e2.labelBox.x + o2.dx, y: e2.labelBox.y + o2.dy, w: e2.labelBox.w, h: e2.labelBox.h } : e2.labelBox);
      if (cross(m.now, r2) > cross(m.was, bg(e2.labelBox)) + 0.25) bad = true;
    }
    if (bad) shiftOf.set(m.e.id, { dx: 0, dy: 0 });
  }
  return shiftOf;
}

export function renderSVG(g, o = {}) {
  // o.chipsAt: a handle-chip layout the caller already computed (chipLayout is quadratic: a big map computes it per stage, see viewer/whole.js)
  // o.hitCross === false: long roads (e.cross) get no wide invisible hit path; the viewer adds them when the map is zoomed in
  // g.nodeFont: box text size in map units (default 15); the overview poster sets it, the layout was measured for it (src/build/layout.mjs)
  const { hops = true, labels = true, idPrefix = '', handles = true, portals = null } = o;
  const kinds = o.kinds ? { ...KIND, ...o.kinds } : KIND, edgeStyle = o.edges ? { ...EDGE, ...o.edges } : EDGE;
  const copt = o.chips || {}, fams = chipFamilies(g, copt);
  const chips = handles ? (o.chipsAt || chipLayout(g, copt)) : {};
  const dropped = handles && !o.chipsAt ? chipPlan(g, copt).drop : {};              // a handle said once in the chart's header: no tab on its boxes, but the box still carries it
  const nk = (g.nodeFont || 15) / 15;
  const pmap = portalMap(g, portals, !!o.detailMarks), pplace = Object.keys(pmap).length ? portalLayout(g, pmap, chips, copt.pgrow) : {};
  // the page is padded 20px, but handle chips / portal badges can straddle a box that touches the chart edge: grow the standalone viewBox to hold them
  let vx0 = -20, vy0 = -20, vx1 = g.width + 20, vy1 = g.height + 20;
  for (const id in chips) { const c = chips[id]; vx0 = Math.min(vx0, c.x - 6); vy0 = Math.min(vy0, c.y - 6); vx1 = Math.max(vx1, c.x + c.w + 6); vy1 = Math.max(vy1, c.y + c.h + 6); }
  for (const id in pplace) { const c = pplace[id]; vx0 = Math.min(vx0, c.x - 6); vy0 = Math.min(vy0, c.y - 6); vx1 = Math.max(vx1, c.x + c.w + 6); vy1 = Math.max(vy1, c.y + c.h + 6); }
  const pad = 20, W = vx1 - vx0, H = vy1 - vy0;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" class="atlas-svg" viewBox="${f(vx0)} ${f(vy0)} ${f(W)} ${f(H)}" width="${f(W)}" height="${f(H)}" font-family="system-ui,Segoe UI,Helvetica,Arial,sans-serif">`);
  out.push('<defs>' + Object.entries(edgeStyle).map(([t, e]) =>
    `<marker id="${idPrefix}arr-${t}" viewBox="0 0 12 12" refX="10.5" refY="6" markerWidth="11" markerHeight="11" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1 1.2 L11 6 L1 10.8 L3.6 6 Z" fill="${e.color}"/></marker>`).join('') + '</defs>');

  // clusters (stage bands)
  for (const c of g.clusters || []) {
    out.push(`<g class="cluster" data-cluster="${esc(c.id)}"><rect x="${f(c.x)}" y="${f(c.y)}" width="${f(c.w)}" height="${f(c.h)}" rx="18" class="cluster-box"/>` +
      `<text x="${f(c.x + 16)}" y="${f(c.y + 24)}" class="cluster-title">${esc(c.title || '')}</text></g>`);
  }

  // edges (drawn before nodes). Hop-overs: an edge hops over edges that come earlier in the list.
  const polys = hops ? g.edges.map(e => e.pts) : [];
  out.push('<g class="edges">');
  g.edges.forEach((e, i) => {
    const ty = edgeStyle[e.type] ? e.type : 'forward', t = edgeStyle[ty];
    const d = edgePath(e.pts, hops ? polys.slice(0, i) : []);
    out.push(`<g class="edge e-${ty}${e.inferred ? ' inferred' : ''}${e.spine ? ' spine' : ''}" data-edge="${esc(e.id)}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"${e.inferred ? ' data-inferred="1"' : ''}${e.cross ? ' data-cross="1"' : ''}>` +
      `${e.cross && o.hitCross === false ? '' : `<path class="edge-hit" d="${d}"/>`}<path class="edge-line" d="${d}" stroke="${t.color}"${t.dash ? ` stroke-dasharray="${t.dash}"` : ''} marker-end="url(#${idPrefix}arr-${ty})"/></g>`);
  });
  out.push('</g>');

  // nodes
  out.push('<g class="nodes"' + (nk !== 1 ? ' style="--nf:' + f(15 * nk) + 'px"' : '') + '>');
  for (const n of g.nodes) {
    const kind = kinds[kindOf(n)] ? kindOf(n) : 'step', K = kinds[kind], col = K.color, pill = !!K.pill;
    const lh = 19 * nk, ty = n.y + n.h / 2 - ((n.lines.length - 1) * lh) / 2 + 5.2 * nk;
    const rx = pill ? n.h / 2 : 11, dash = K.dash ? ` stroke-dasharray="${K.dash}"` : '';
    const pm = pmap[n.id], pdir = pm ? (pm.in && pm.out ? 'both' : pm.in ? 'in' : 'out') : '';
    out.push(`<g class="node" data-node="${esc(n.id)}" data-kind="${esc(kind)}"${chips[n.id] || dropped[n.id] ? ` data-handle="${esc(n.handle)}"` : ''}${pdir ? ` data-portal="${pdir}"` : ''}${n.spine ? ' data-spine="1"' : ''} tabindex="0"><rect class="node-box" x="${f(n.x)}" y="${f(n.y)}" width="${f(n.w)}" height="${f(n.h)}" rx="${f(rx)}" stroke="${col}"${dash}/>` +
      (pill ? '' : kind === 'decision' ? `<path class="node-tab node-diamond" d="M${f(n.x + 1.5)} ${f(n.y + n.h / 2)} L${f(n.x + 7.5)} ${f(n.y + n.h / 2 - 9)} L${f(n.x + 13.5)} ${f(n.y + n.h / 2)} L${f(n.x + 7.5)} ${f(n.y + n.h / 2 + 9)} Z" fill="${col}" stroke="${col}" stroke-width="1.6" stroke-linejoin="round"/>` : `<rect class="node-tab" x="${f(n.x + 0.8)}" y="${f(n.y + 12)}" width="4.5" height="${f(n.h - 24)}" rx="2.2" fill="${col}"/>`) +
      (pm && o.rings ? `<g class="portal pt-${pdir}">${ringSVG(n, pm, g, pill)}</g>` : '') +   // a box that hands on to another chart carries ONE mark, the corner badge; the dashed ring (a second frame, cut into arcs by tabs and badges) is drawn only with o.rings
      n.lines.map((l, i) => `<text class="node-text" x="${f(n.x + n.w / 2 + 2)}" y="${f(ty + i * lh)}" text-anchor="middle">${esc(l)}</text>`).join('') +
      (chips[n.id] ? chipSVG(chips[n.id], n.handle, fams) : '') + (pm && pplace[n.id] ? badgeSVG(pplace[n.id], pm) : '') + '</g>');
  }
  out.push('</g>');

  // edge labels on top, with a halo/pill so routes never cut through text
  if (labels) {
    out.push('<g class="edge-labels">');
    // where each pill sits: against its road, unless moving there would touch another pill or a box that its original place did not (then it stays and only gets the dot)
    const shiftOf = o.attach === false ? new Map() : labelShifts(g);
    for (const e of g.edges) {
      if (!e.labelBox) continue;
      const b0 = e.labelBox, A = o.attach === false ? null : labelAttach(e.pts, b0), col = (edgeStyle[e.type] || edgeStyle.forward).color, SH = shiftOf.get(e.id);
      let b = b0, lead = '', anchor = 'middle', tx = b0.x + b0.w / 2;
      if (A && A.gap > 2.5) {                                    // beside its road: pull the pill to 1.5 units from it (the pill's own padding is 3 across, 1 along), hug the road with the words, mark the road
        const dx = SH ? SH.dx : 0, dy = SH ? SH.dy : 0;
        b = { x: b0.x + dx, y: b0.y + dy, w: b0.w, h: b0.h };
        if (A.axis === 'x') { anchor = A.side === 'l' ? 'start' : 'end'; tx = A.side === 'l' ? b.x + 1 : b.x + b.w - 1; }
        const px = Math.max(b.x - 3, Math.min(b.x + b.w + 3, A.q[0])), py = Math.max(b.y - 1, Math.min(b.y + b.h + 1, A.q[1]));
        lead = (Math.hypot(px - A.q[0], py - A.q[1]) > 0.5 ? `<path class="elabel-lead" d="M${f(px)} ${f(py)} L${f(A.q[0])} ${f(A.q[1])}" stroke="${col}"/>` : '') + `<circle class="elabel-dot" cx="${f(A.q[0])}" cy="${f(A.q[1])}" r="3.1" fill="${col}"/>`;
      }
      out.push(`<g class="elabel" data-edge-label="${esc(e.id)}"${lead ? ' data-attached="1"' : ''}><rect x="${f(b.x - 3)}" y="${f(b.y - 1)}" width="${f(b.w + 6)}" height="${f(b.h + 2)}" rx="6" class="elabel-bg"/>` +
        e.lines.map((l, i) => `<text x="${f(tx)}" y="${f(b.y + 12.5 + i * 15)}" text-anchor="${anchor}" class="elabel-text">${esc(l)}</text>`).join('') + lead + '</g>');
    }
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('');
}

// default CSS for stand-alone previews / SVG export (the viewer ships its own themed copy)
export const BASE_CSS = `
:root{--bg:#0d1a21;--panel:#14252d;--ink:#e5eff2;--muted:#a4bdc7}
.atlas-svg{background:var(--bg)}
.node-box{fill:#152a32;stroke-width:1.8}.node-text{fill:#ebf4f5;font-size:var(--nf,15px);font-weight:550}
.edge-line{fill:none;stroke-width:1.9;stroke-linejoin:round}.edge-hit{fill:none;stroke:transparent;stroke-width:16}
.elabel-bg{fill:#0d1a21;opacity:.92}.elabel-text{fill:#c4d6dc;font-size:13px}
.cluster-box{fill:rgba(125,182,189,.05);stroke:#2c4752;stroke-width:1.2}.cluster-title{fill:#7e9ca6;font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.chip-text{pointer-events:none}
`;
