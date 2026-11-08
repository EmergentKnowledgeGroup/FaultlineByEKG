// page: copy the story's own atlas page and add the overlay (marks, counts, a switch, the tool's words on hover).
// The page's own data and scripts are not touched. The overlay is one style block, one data block and one script, between two comment marks, so
// running this again on its own output replaces the block instead of stacking a second one.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CANNOT_SEE, WORD_FLAGS, isMark } from './check.mjs';
import { flagText } from './texts.mjs';
import { NOT_DRAWN } from './arm.mjs';
import { plain, jsonWhere } from './canon.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const START = '<!--story-overlay-->';
const END = '<!--/story-overlay-->';
const SHORT = 56;
const ARROW = ' → ';
const BS = String.fromCharCode(92);       // a backslash, so the escapes below are written into the page as text
const LS = new RegExp(String.fromCharCode(0x2028), 'g');
const PS = new RegExp(String.fromCharCode(0x2029), 'g');

const L = (k, t) => ({ k, t });
const pl = (n, one, many) => (n === 1 ? one : many);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const COMPARED = {
  none: '',
  'not-compared': 'The label is not compared with anything: the tool sees no test here.',
  'no-contradiction': 'The tool sees nothing against the label. It does not read what the label means.',
  contradicts: 'The label contradicts the side of the test the tool draws.',
};

function roadTip(r) {
  const out = { h: r.joinWords + (r.hops > 1 && r.scope === 'boxes' ? ` (${r.hops} tool roads)` : ''), l: [] };
  out.l.push(L('line', cap(r.why) + '.'));
  if (r.route?.length && r.route[0].road) {
    out.l.push(L('line', 'Tool route: ' + [plain(r.route[0].fromPhrase, SHORT), ...r.route.slice(0, 5).map((e) => plain(e.toPhrase, SHORT))].join(ARROW) + (r.route.length > 5 ? ARROW + '…' : '')));
  }
  if (r.inherits) out.l.push(L('line', 'It stands on ' + r.inherits + '.'));
  if (r.when.text) {
    out.l.push(L('words', `Agent's condition: “${r.when.text}” (words, not checked)`));
    const t = r.when.tool;
    const unpinned = t?.arm === NOT_DRAWN;
    if (t) out.l.push(L('tool', `${unpinned ? 'The tool at the cited line' : 'The tool where this road starts'}: ${t.phrase}${t.arm === 'else' ? ' [else side]' : t.arm && !unpinned && t.arm !== t.phrase ? ` [${t.arm}]` : ''}  ${t.at}`));
    if (unpinned) out.l.push(L('line', 'The tool sees this test at the cited line but draws no road from it to this target, so the label is not compared.'));
    else if (COMPARED[r.when.compared]) out.l.push(L('line', COMPARED[r.when.compared]));
  } else if (r.type !== 'forward') out.l.push(L('line', `Typed ${r.type}.`));
  for (const f of r.flags) out.l.push(L('flag', flagText(f)));
  return out;
}

function boxTip(b) {
  const out = { h: b.foundWords, l: [] };
  out.l.push(L('line', cap(b.why) + '.'));
  out.l.push(L('words', `Title and sentence are the agent's words, not checked: “${b.words.title}”`));
  if (b.toolPhrase) out.l.push(L('tool', `The tool at the cited line: ${b.toolPhrase}`));
  for (const f of b.flags) out.l.push(L('flag', flagText(f)));
  return out;
}

export function overlayData(check) {
  const S = check.summary;
  const roads = {}, boxes = {};
  for (const [id, r] of Object.entries(check.roads)) {
    roads[id] = { j: r.join === 'related' ? 'related' : r.join === 'none' ? 'none' : '', f: r.flags.some((f) => WORD_FLAGS.has(f)) ? 1 : 0, ...roadTip(r) };
  }
  for (const [id, b] of Object.entries(check.boxes)) boxes[id] = { b: b.found === 'partial' ? 'partial' : b.found === 'none' ? 'none' : '', f: isMark(b.flags) ? 1 : 0, ...boxTip(b) };
  const joined = S.join.line + S.join.route;
  const bad = S.found.partial + S.found.none;
  const contra = S.whenLabel.contradicts ?? 0;
  const counts = [
    { n: joined, t: pl(joined, 'road joined', 'roads joined'), tip: 'Roads whose two cited places the tool joins, at the cited line or by a route. The words on them are not checked.', mark: false },
    { n: S.join.related, t: 'related', tip: 'Related in the code: the tool relates the code but draws no road between these places, or the cited line is not where its road is.', mark: S.join.related > 0 },
    { n: S.join.none, t: 'no link found', tip: 'Nothing in the tool map joins these places.', mark: S.join.none > 0 },
    ...(contra ? [{ n: contra, t: pl(contra, 'label disagrees', 'labels disagree'), tip: 'Joined roads whose label contradicts the side of the test the tool draws, in the few ways it can see.', mark: true }] : []),
    { n: S.found.boxed + S.found.code, t: pl(S.found.boxed + S.found.code, 'box found', 'boxes found'), tip: 'Boxes whose cited lines are in a tool box or in real code the tool read.', mark: false },
    { n: bad, t: pl(bad, 'box flagged', 'boxes flagged'), tip: 'Boxes found only partly, or not at all.', mark: bad > 0 },
  ];
  const about = [
    'Marks show whether the tool’s own map backs the places this story cites. A road or box the tool supports keeps the page’s own look; hover any of them for the tool’s words.',
    'Dashed road: related in the code. Dotted road with a ring: no link found. Small dot: the label or type of a joined road is questioned. Dashed or dotted outline on a box: found partly, or not found.',
    'Every title, sentence and condition on this page is the agent’s words. The tool has not checked them. Hover shows the tool’s own phrase at the cited line beside them.',
    'What the tool cannot see:',
    ...CANNOT_SEE,
  ];
  return { counts, about, roads, boxes };
}

/** @returns {{html, dataBytes, nRoads, nBoxes}} */
export function buildPage(checkPath, pagePath) {
  let check;
  try { check = JSON.parse(fs.readFileSync(checkPath, 'utf8')); } catch (e) { throw e instanceof SyntaxError ? new Error(`the check file ${checkPath} is ${jsonWhere(e)}`) : e; } // V8's message would quote the start of the file
  if (check.refused) throw new Error('the check was refused, so there is nothing to show: ' + check.refused.map((x) => x.msg).join('; '));
  let html = fs.readFileSync(pagePath, 'utf8');
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a >= 0 && b > a) html = html.slice(0, a) + html.slice(b + END.length + (html.charCodeAt(b + END.length) === 10 ? 1 : 0));
  const data = overlayData(check);
  const blob = JSON.stringify(data).replace(/</g, BS + 'u003c').replace(LS, BS + 'u2028').replace(PS, BS + 'u2029');
  const css = fs.readFileSync(HERE + 'overlay/overlay.css', 'utf8');
  const js = fs.readFileSync(HERE + 'overlay/overlay.js', 'utf8');
  const frag = `${START}\n<style>${css}</style>\n<script type="application/json" id="sc-data">${blob}</script>\n<script>${js.replace(/<\/script/gi, '<\\/script')}</script>\n${END}\n`;
  const i = html.lastIndexOf('</body>');
  if (i < 0) throw new Error('the page has no </body> to add the overlay before');
  return { html: html.slice(0, i) + frag + html.slice(i), dataBytes: blob.length, nRoads: Object.keys(data.roads).length, nBoxes: Object.keys(data.boxes).length };
}
