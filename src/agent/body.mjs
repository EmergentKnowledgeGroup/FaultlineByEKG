// A function's body as text lines, in the order the code runs: the decisions, loops, calls and endings the page's chart or outline holds for it, and, marked "+",
// what the scan sees at a line that no box shows (a call, an exit, a decision). A function the map drew no box for gets the scan's list alone.
// The lines are built from the same reading the page's outline uses (read/charts.json), so the agent and the page say the same thing.

const MAX_PLUS = 8;                // lines of "the scan sees this, no box shows it" kept for one function; the rest are counted
const TEST_WIDTH = 70;             // longest condition text shown in a scan-only line
const SHOWN_KINDS = new Set(['if', 'elif', 'for', 'while', 'repeat', 'match', 'handler']);
const KIND_WORDS = { if: 'if', elif: 'elif', for: 'loop for', while: 'loop while', repeat: 'loop repeat', match: 'match', handler: 'catch handler' };

const clipText = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + ' ...' : s; };
const ARM_ORDER = ['yes', 'no', 'then', 'each time round', 'when done', 'if it fails', 'continues', 'and'];
const armRank = (w) => { const i = ARM_ORDER.indexOf(w); return i < 0 ? ARM_ORDER.length : i; };
const sfx = (id) => { const i = id.indexOf('.'); return i < 0 ? id : id.slice(i); };

/** The boxes and roads the page holds for a function: every part of its chart, or its outline. null when the reading has neither. */
function drawn(R, F) {
  const c = R.chartOf.get(F.id);
  if (c) {
    const seen = new Set(), boxes = [], roads = [];
    for (const p of c.parts) { for (const b of p.boxes) if (!seen.has(b.id)) { seen.add(b.id); boxes.push(b); } roads.push(...p.roads); }
    return { boxes, roads, source: 'chart' };
  }
  const o = R.outlineOf.get(F.id);
  return o ? { boxes: o.boxes, roads: o.roads, source: 'outline' } : null;
}

/** The function a card stands for: by the function id the chart keeps, else by the file and line the card's text starts with. */
function calleeOf(R, b) {
  if (b.raw && R.byId.has(b.raw)) return R.byId.get(b.raw);
  const m = /^(.+?):(\d+)\./.exec(b.plain || '');
  if (!m) return null;
  return (R.byFile.get(m[1]) || []).find((f) => f.mapped && (f.cline === +m[2] || f.line === +m[2])) || null;
}
export const fnWord = (F) => (F.n ? `${F.n} ${F.name}` : `${F.name} (${F.path.split('/').pop()}:${F.line})`);

/**
 * @returns {{source:'chart'|'outline'|'scan', items:{line:number, text:string, plus?:boolean, box?:string}[], plusMore:number, boxes:number, notFollowed:{name:string,line:number}[], libraryCalls:number}}
 */
export function bodyOf(R, F) {
  const d = drawn(R, F), items = [];
  const sites = R.callSites.get(F.id) || [];
  const returns = R.returnsOf(F.id);
  const resolved = (s) => s.to.filter((t) => R.byId.has(t));
  const notFollowed = sites.filter((s) => !s.to.length && s.how === 'unresolved' && s.rs !== 'ext').map((s) => ({ name: s.name, line: s.line }));
  const libraryCalls = sites.filter((s) => !s.to.length && (s.rs === 'ext' || s.how === 'builtin')).length;
  const coveredCalls = new Set(), coveredLines = new Set(), coveredExits = new Set(), titleAt = new Map();    // titleAt: line -> the titles of the boxes drawn there
  let boxCount = 0;

  if (d) {
    const byId = new Map(d.boxes.map((b) => [b.id, b]));
    const outs = new Map();
    for (const r of d.roads) { if (!outs.has(r.from)) outs.set(r.from, []); outs.get(r.from).push(r); }
    const follow = (id) => { let b = byId.get(id), guard = 0; while (b && b.shape === 'link' && guard++ < 4) { const n = (outs.get(b.id) || [])[0]; b = n ? byId.get(n.to) : null; } return b; };
    const own = d.boxes.filter((b) => !b.shape || b.shape === 'own' || b.shape === 'stub');
    const ownIndex = new Map(d.boxes.filter((b) => !b.shape || b.shape === 'own').sort((a, b) => a.line - b.line).map((b, i) => [b.id, i]));
    boxCount = own.filter((b) => !b.shape || b.shape === 'own').length;
    for (const b of own) {
      const stub = b.shape === 'stub';
      const calls = [], arms = new Map();
      for (const r of outs.get(b.id) || []) {
        const t = follow(r.to);
        if (!t || t.shape === 'open') continue;
        if (t.shape === 'card') {
          const G = calleeOf(R, t);
          if (G) coveredCalls.add(G.id);
          const may = r.tier === 'may' || /^→\?/.test(t.title || '') ? ' (may)' : r.tier === 'linked' ? ' (linked)' : '';
          const w = G ? fnWord(G) : String(t.title || '').replace(/^→\??\s*/, '');
          if (!calls.includes(w + may)) calls.push(w + may);
        } else if (t.shape === 'more') {
          const names = /called from this box: (.*)\.$/.exec(t.plain || '');
          calls.push(`and ${String(t.title).replace(/^→\s*/, '')}${names ? ': ' + names[1] : ''}`);
        } else {
          const w = r.when || 'then';
          const target = `${sfx(t.id)}${ownIndex.has(t.id) && ownIndex.get(t.id) <= ownIndex.get(b.id) ? ' (loops back)' : ''}`;
          if (!arms.has(w)) arms.set(w, []);
          if (!arms.get(w).includes(target)) arms.get(w).push(target);
        }
      }
      const kind = b.rule === 'loop' ? 'loop' : stub ? 'exit' : b.kind;
      const bits = [`${sfx(b.id)} L${b.line} ${kind} ${clipText(b.title, 90)}${b.outcome && b.outcome !== 'success' && b.outcome !== 'neutral' ? ` [${b.outcome}]` : ''}`];
      if (calls.length) bits.push('calls ' + calls.join(', '));
      for (const w of [...arms.keys()].sort((x, y) => armRank(x) - armRank(y))) bits.push(`${w} -> ${arms.get(w).join(', ')}`);
      items.push({ line: b.line, order: stub ? 2 : 0, text: bits.join(' | '), box: b.id });
      coveredLines.add(b.line);
      if (!stub) titleAt.set(b.line, (titleAt.get(b.line) || '') + ' ' + b.title);
      if (b.kind === 'end' || stub) coveredExits.add(b.line);
    }
    // a stub is listed once, where it was first seen, however many arms lead to it
  }

  // ---- what the scan sees that no box shows -----------------------------------------------------------------------------------
  const plus = [];
  const callText = (s) => {
    const to = resolved(s);
    if (to.length) return `calls ${to.slice(0, 3).map((t) => fnWord(R.byId.get(t))).join(' or ')}${to.length > 3 ? ` +${to.length - 3}` : ''}${s.tier === 'may' ? ' (may)' : s.tier === 'linked' ? ' (linked)' : ''}`;
    return `calls ${s.name} (not followed)`;
  };
  for (const s of sites) {
    if (!s.to.length && (s.rs === 'ext' || s.how === 'builtin')) continue;           // a library call: counted, not listed
    const to = resolved(s);
    if (d && to.length && to.every((t) => coveredCalls.has(t) || (titleAt.get(s.line) || '').includes(R.byId.get(t).name))) continue;      // a card, or a box that names it on that line
    if (d && !to.length) continue;                                                    // an unfollowed call is listed once, below, with the others
    plus.push({ line: s.line, order: 1, text: callText(s) });
  }
  for (const [line, kind, test] of F.br) {
    if (!SHOWN_KINDS.has(kind) || (d && coveredLines.has(line))) continue;
    plus.push({ line, order: 1, text: `${KIND_WORDS[kind]}${test ? ' ' + clipText(test, TEST_WIDTH) : ''}` });
  }
  const exits = F.rt.filter(([line]) => !(d && coveredExits.has(line)));
  const seenExit = new Set();
  for (const [line, kind] of exits) {
    if (seenExit.has(line)) continue;
    seenExit.add(line);
    const expr = returns && returns.get(line);
    plus.push({ line, order: 1, text: `${kind === 'raise' ? 'raises' : 'returns'}${expr ? ' ' + clipText(expr, TEST_WIDTH) : ''}` });
  }
  plus.sort((a, b) => a.line - b.line || a.order - b.order);
  const shownPlus = plus.slice(0, d ? MAX_PLUS : 60);
  for (const p of shownPlus) items.push({ ...p, plus: true });
  items.sort((a, b) => a.line - b.line || a.order - b.order || 0);
  return { source: d ? d.source : 'scan', items, plusMore: plus.length - shownPlus.length, boxes: boxCount, notFollowed, libraryCalls };
}

/** The text of one body item, with its marker for the "+" kind. */
export const itemText = (it) => (it.plus ? `+ L${it.line} ${it.text}` : it.text);

/**
 * The box of F that holds the call to G: the one with a road to G's card, else the last box at or before the call's line. null when F has no drawn box.
 * @returns {{id:string, line:number, kind:string, title:string}|null}
 */
export function callSiteBox(R, F, G) {
  const d = drawn(R, F);
  if (!d) return null;
  const byId = new Map(d.boxes.map((b) => [b.id, b]));
  for (const r of d.roads) {
    const t = byId.get(r.to), from = byId.get(r.from);
    if (t && t.shape === 'card' && from && calleeOf(R, t) === G) return { id: from.id, line: from.line, kind: from.kind, title: from.title };
  }
  const e = (R.out.get(F.id) || []).find((x) => x.to === G.id);
  if (!e || !e.line) return null;
  const own = d.boxes.filter((b) => !b.shape || b.shape === 'own').filter((b) => b.line <= e.line).sort((a, b) => b.line - a.line);
  return own[0] ? { id: own[0].id, line: own[0].line, kind: own[0].kind, title: own[0].title } : null;
}
