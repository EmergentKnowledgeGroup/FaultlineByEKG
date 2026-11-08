// `faultline where` on a tool map: the function a query means, who calls it, and its body. Also the pieces the other commands share (names, callers, fitting lines into a cap).
import { tok } from '../build/util.mjs';
import { bodyOf, itemText, fnWord } from './body.mjs';
import { stageTitle } from './view.mjs';
import { whole } from './words.mjs';

const MAX_CALLERS = 8;             // callers listed by name; the rest are counted
const MAX_OTHERS = 4;              // other functions sharing a name that are listed
const MAX_UNFOLLOWED = 8;          // names of calls not followed that are listed
const MARKS = { may: ' (may)', linked: ' (linked)', proven: '' };

/** Names of functions as a list, each with the file only where two share a name. */
export function nameList(R, fns) {
  const dn = (F) => (F.anon ? F.long || F.name : F.name);
  const count = new Map();
  for (const F of fns) count.set(dn(F), (count.get(dn(F)) || 0) + 1);
  return fns.map((F) => `${dn(F)}${count.get(dn(F)) > 1 ? ` [${F.path}]` : ''}${F.n ? ' ' + F.n : ''}`);
}

/** The callers of a function, as lines: name, its id, the line of the call, how sure. Named even when the caller is an unnamed function. */
export function callerLines(R, F) {
  const inn = (R.inn.get(F.id) || []).map((e) => ({ e, G: R.byId.get(e.from) })).filter((x) => x.G);
  inn.sort((a, b) => ({ proven: 0, linked: 1, may: 2 }[a.e.tier] - { proven: 0, linked: 1, may: 2 }[b.e.tier]) || (a.G.id < b.G.id ? -1 : 1));
  const names = nameList(R, inn.map((x) => x.G));
  const shown = inn.slice(0, MAX_CALLERS).map((x, i) => `${names[i]} L${x.e.line}${MARKS[x.e.tier]}${x.G.chart || x.G.boxes > 1 ? '' : ''}`);
  return { n: inn.length, text: shown.join('; ') + (inn.length > MAX_CALLERS ? `; +${inn.length - MAX_CALLERS} more` : '') };
}

/** Lines that say what the call list knows about who reaches a function. Never "none" unless the list holds no caller and no enclosing function. */
export function calledFromLines(R, F) {
  const L = [], c = callerLines(R, F);
  if (c.n) L.push(`CALLED FROM ${c.n}: ${c.text}`);
  const parent = F.parent && R.byId.get(F.parent);
  if (parent) L.push(`DEFINED INSIDE ${parent.n ? parent.n + ' ' : ''}${parent.name}${c.n ? '' : ' (no call to it is in the call list; it may be handed to a call there)'}`);
  const starts = R.startsOf.get(F.id);
  if (starts) L.push(`STARTS ${starts.length === 1 ? 'journey' : 'journeys'} ${starts.slice(0, 3).map((i) => `${R.journeyIds[i]} "${R.journeyNames[i]}"`).join(', ')}${starts.length > 3 ? ` +${starts.length - 3}` : ''}`);
  if (!c.n && !parent && !starts) L.push('CALLED FROM nothing in the call list (an entry point, or called by name or at run time, which the list cannot see)');
  const kids = F.children.map((id) => R.byId.get(id)).filter(Boolean);
  if (kids.length) L.push(`INNER ${kids.length}: ${nameList(R, kids.slice(0, 4)).join(', ')}${kids.length > 4 ? ` +${kids.length - 4}` : ''}`);
  return L;
}

/** Put head, body and tail lines under `tokens`: the body gives way first, line by line, and says how many lines and from where. */
export function fitBody(head, body, tail, linkLine, tokens, moreCmd, firstLineOf) {
  const link = 'open: ' + linkLine;
  const note = (k) => `[${body.length - k} more body line(s), from ${firstLineOf(k)}. More: ${moreCmd}]`;
  const text = (k) => [...head, ...body.slice(0, k), ...(k < body.length ? [note(k)] : []), ...tail, link].join('\n');
  let k = body.length;
  while (k > 0 && tok(text(k)) > tokens) k--;
  return text(k);
}

/** The answer for a function: where it is, who calls it, what it does in order. */
export function whereFunction(R, data, res, query, c, T) {
  const F = res.F, stage = F.stage ? `[${F.stage} ${stageTitle(data, F.stage)}]` : '';
  const head = [`WHERE ${query === F.id ? F.id : `${query} -> ${F.n ? F.n + ' ' : ''}${F.id}`}  ${stage}`.trimEnd()];
  const lines = F.end - F.line + 1;
  const draw = F.chart ? `${plural(F.boxes, 'box', 'boxes')}, drawn chart ${F.chart}` : F.boxes ? `${plural(F.boxes, 'box', 'boxes')}, no drawn chart (the page lists it as an outline)` : 'no box: the map drew nothing for it (the scan\'s list is below)';
  const jn = R.mainSet.has(F.id) ? ', on the main journey' : R.jr.has(F.id) ? `, on journey ${R.journeyIds[R.jr.get(F.id)]}` : '';
  head.push(`${F.path}:${F.line}-${F.end} (${plural(lines, 'line')}); ${draw}${jn}`);
  if (res.others && res.others.length) {
    const o = res.others;
    head.push(`SAME NAME: ${o.length + 1} functions are called "${query}"; this one is shown because ${res.why}. Others: ${o.slice(0, MAX_OTHERS).map((G) => G.n || G.id).join(', ')}${o.length > MAX_OTHERS ? `, +${o.length - MAX_OTHERS}` : ''} (${o.slice(0, 2).map((G) => `${G.n || G.id} is ${G.path}:${G.line}`).join('; ')}). To pick one: faultline where <its number or function id>`);
  }
  if (res.fileOthers && res.fileOthers.length) head.push(`SAME FILE NAME: ${res.fileOthers.length + 1} files end in that name; shown ${res.file}. Others: ${res.fileOthers.slice(0, 3).join(', ')}${res.fileOthers.length > 3 ? ', ...' : ''}`);
  if (res.how === 'line') head.push(`LINE ${res.line}: inside ${F.id.split('::').pop()}${F.qual === '<module>' ? ' (the top level of the file)' : ''}`);
  head.push(...calledFromLines(R, F));
  const b = bodyOf(R, F);
  const mark = res.how === 'line' ? res.line : null;
  const items = b.items.map((it) => ({ ...it, hit: (mark != null && it === nearest(b.items, mark)) || (res.mark && it.box === res.mark) }));
  const body = items.map((it) => itemText(it) + (it.hit ? (mark != null ? `   <== line ${mark} is here or just after` : '   <== asked for') : ''));
  const legend = b.source === 'scan'
    ? 'BODY no box was drawn for this function. The scan\'s list of its decisions, calls and exits, in line order (not a flow chart; "(not followed)" = the call could not be traced to project code):'
    : `BODY ${plural(b.boxes, 'box', 'boxes')}, in the order the code runs (.k = box ${F.n}.k; .sK = an exit, shared by exits that read alike; yes/no = a decision's arms; (may) = not proven; + = the scan sees it at that line, no box shows it):`;
  head.push(legend);
  const tail = [];
  if (b.plusMore) tail.push(`+ ${b.plusMore} more scan-only line(s) not listed`);
  if (b.notFollowed.length && b.source !== 'scan') {
    const names = [...new Set(b.notFollowed.map((x) => x.name))];
    tail.push(`NOT FOLLOWED ${b.notFollowed.length} call(s) the tool could not trace to project code (the function carries on there): ${names.slice(0, MAX_UNFOLLOWED).join(', ')}${names.length > MAX_UNFOLLOWED ? ` +${names.length - MAX_UNFOLLOWED}` : ''}`);
  }
  const here = data.findings.filter((f) => F.n && f.boxes.some((x) => x.startsWith(F.n + '.')));
  for (const f of here.slice(0, 2)) { const q = whole(f.question, 140); tail.push(`QUESTION ${f.key} ${f.check}${q ? ': ' + q : ''}`); }
  const link = F.chart && data.boxes[`${F.n}.0`] ? c.linkBox(`${F.n}.0`) : c.link(c.wholeId, null);
  return fitBody(head, body, tail, link, T, `faultline where ${F.n || F.id} --budget ${T * 2}`, (k) => `L${items[k] ? items[k].line : F.end}`);
}

function nearest(items, line) {
  let best = null;
  for (const it of items) if (it.line <= line && (!best || it.line >= best.line)) best = it;
  return best;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

/** The answer for a file given without a line: its functions in order. */
export function whereFile(R, data, res, query, c, T) {
  const fns = res.fns;
  const L = [`WHERE ${query} -> file ${res.file}: ${plural(fns.length, 'function')} the scan found, ${fns.filter((F) => F.mapped).length} with a box`];
  if (res.others.length) L.push(`SAME FILE NAME: ${res.others.length + 1} files end in that name; shown ${res.file}. Others: ${res.others.slice(0, 3).join(', ')}${res.others.length > 3 ? ', ...' : ''}`);
  const rows = fns.map((F) => `${F.n || '-'} L${F.line}-${F.end} ${F.anon ? F.long : F.name}${F.chart ? ' [chart]' : F.mapped ? '' : ' [no box]'}`);
  const link = c.link(c.wholeId, null);
  const head = L, cmd = `faultline where ${res.file} --budget ${T * 2}`;
  return fitBody(head, rows, [], link, T, cmd, (k) => `${fns[k] ? 'L' + fns[k].line : 'the end'}`);
}
export { fnWord };
