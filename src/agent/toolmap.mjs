// The text commands on a tool map (one `faultline map` made). They say what was read, what is open and what to do next, in the reading's own numbers,
// and list the same ranked questions the page's "Where it can break" lists, with the same counts. A map written by hand uses the words in commands.mjs.
import { trunc, plural, tok } from '../build/util.mjs';

const num = (n) => Number(n || 0);
const langs = (l) => Object.entries(l || {}).map(([k, v]) => `${v} ${k}`).join(', ');

/** The three lines that open a tool map's brief: what was read, what was not, what is open. Shorter at each level (0 = most words). */
export function readLines(data, lv) {
  const t = data.toolMap, n = t.nums, notes = t.notes || [];
  const L = [];
  L.push(`READ ${plural(n.functions, 'function')} in ${plural(n.files, 'file')}${lv < 2 && langs(n.languages) ? ` (${langs(n.languages)})` : ''}: ${n.boxes} boxes, ${n.roads} roads, ${plural(n.stages, 'stage')}, ${plural(n.loops, 'loop')}. ${n.claims} claims: ${n.claimsConfident} confident, ${n.claimsNotConfident} not. Read from the code, no agent, nothing run.`);
  const nr = [n.noBoxes ? `${plural(n.noBoxes, 'function')} with no box` : '', n.unresolved ? `${plural(n.unresolved, 'call')} not followed` : '', n.severalTargets ? `${plural(n.severalTargets, 'call')} that may run several functions` : '', n.unreadFiles ? `${plural(n.unreadFiles, 'file')} unreadable` : ''].filter(Boolean);
  const noteWords = notes.length ? `${notes.length > 1 ? `${notes.length} notes` : 'note'}: ${trunc(notes[0], lv < 2 ? 150 : 70)}${notes.length > 1 ? ` (+${notes.length - 1})` : ''}` : '';
  L.push(`NOT READ: ${[...nr, noteWords].filter(Boolean).join('; ') || 'nothing the tool knows of'}.`);
  L.push(`OPEN: ${plural(n.questions, 'question')} (${n.questionsSure} the tool is sure of), ${plural(n.gaps, 'gap')} in the drawing, ${n.hearerUnknown} of ${plural(n.failing, 'failing ending')} with no known hearer.`);
  return L;
}

/** The list of questions in a brief: the first `cap`, one line each. */
export function questionLines(data, cap, width) {
  const qs = data.findings.filter((f) => f.shown), L = [];
  if (!qs.length) return ['QUESTIONS none raised by the checks that ran (that is not proof the code is clean)'];
  L.push(`QUESTIONS ${qs.length}, ranked (a candidate to look into, never a verdict)`);
  for (const f of qs.slice(0, cap)) L.push(` ${f.key} ${f.check}${f.boxes.length ? ` [${f.boxes.slice(0, 2).join(',')}]` : ''} ${trunc(f.question, width)}`);
  if (qs.length > cap) L.push(` ... ${qs.length - cap} more: faultline breaks`);
  return L;
}

/** What the brief says about failing endings, from the reading: who hears is known only where the code says it. */
export function failingLine(data) {
  const h = data.toolMap.nums;
  return h.failing ? `FAILING ENDINGS ${h.failing}: who hears is not known from the code for ${h.hearerUnknown} (faultline where <ending box>)` : '';
}

/** `faultline breaks` on a tool map. */
export function breaksText(data, o, c, T) {
  const stage = o.stage || null;
  const all = data.findings.filter((f) => f.shown);
  const pool = all.filter((f) => !stage || f.cluster === stage);
  const n = data.toolMap.nums;
  const by = {};
  for (const f of pool) by[f.check] = (by[f.check] || 0) + 1;
  const kinds = Object.entries(by).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const link = c.link(c.wholeId, null);
  const sure = pool.filter((f) => f.sure).length;
  const L = [`BREAKS ${stage ? `stage ${stage} ` : ''}${plural(pool.length, 'question')} the reading raised${stage ? ` (${all.length} in all)` : ''}, ${sure} of them ones the tool is sure of, ranked with the most useful first. A candidate to look into, never a verdict: nothing was run.`];
  if (o.leads) L.push('A tool map has no held-back leads: every question the reading raised is listed here.');
  if (o.silent) L.push(`Failing endings nobody is told about are on the page's "How it fails"; ${n.hearerUnknown} of ${n.failing} have no known hearer (faultline where <ending box> says what the code shows).`);
  if (kinds.length) L.push(`by kind: ${kinds.slice(0, 5).map(([k, v]) => `${v} ${k}`).join(', ')}${kinds.length > 5 ? ', ...' : ''}`);
  if (n.gaps) L.push(`${plural(n.gaps, 'gap')} in the drawing ${n.gaps === 1 ? 'is' : 'are'} folded behind a count, not listed: ${n.gaps === 1 ? 'it says' : 'they say'} how the map is drawn, not what the code does.`);
  const reserve = tok(`open: ${link}\n[cut 99 line(s) at the ${T}-token budget. More: faultline breaks --all --budget ${T * 2}]\nShowing 999 of 999 in ${T} tokens; the rest: faultline breaks --all --budget 99999 (or --stage <id>)`);
  const cap = o.all ? 60 : 12;
  const rows = [];
  let shown = 0;
  for (const f of pool.slice(0, cap)) {
    const e = [`${f.key} ${f.check}  [${f.boxes.length ? f.boxes.join(',') : 'no box'}]${f.sure ? '  sure' : ''}${f.wait ? '  wait' : ''}`, `   ? ${trunc(f.question, 190)}`, `   because: ${trunc(f.evidence, 170)}`];
    if (tok([...L, ...rows, ...e].join('\n')) + reserve > T && shown > 0) break;
    rows.push(...e); shown++;
  }
  L.push(pool.length ? `Showing ${shown} of ${pool.length}${shown < pool.length ? ` within ${T} tokens; the rest: faultline breaks --all${T < 3000 ? ' --budget 3000' : ''}${stage ? '' : ' (or --stage <id> for one stage)'}` : ''}.` : (stage ? `none for ${stage}` : 'none from the checks that ran; the code may still hide breaks the checks cannot see'));
  L.push(...rows);
  return { lines: L, link, more: `faultline breaks ${stage ? `--stage ${stage} ` : ''}--all --budget ${T * 2}` };
}

// a git pin is where HEAD was, not the bytes read: the files are read as they lie, uncommitted edits too, so agent text says so
export const pinSaid = (pin) => (/^git /.test(pin || '') ? `${pin} (HEAD; the files read may hold uncommitted edits)` : pin || '');

/** `faultline status` on a tool map: what was read, what is open, whether the page matches the stored map (the code is not looked at), what to do next. Under 200 tokens. */
export function statusLines(data, page, refresh) {
  const t = data.toolMap, n = t.nums, notes = t.notes || [];
  const L = [`STATUS TOOL MAP${data.pin ? `  pin ${pinSaid(data.pin)}` : ''}  read from the code; no agent, nothing run`];
  L.push(`read: ${plural(n.functions, 'function')} in ${plural(n.files, 'file')}${langs(n.languages) ? ` (${langs(n.languages)})` : ''}; ${n.boxes} boxes, ${n.roads} roads, ${plural(n.stages, 'stage')}; ${n.claims} claims, ${n.claimsNotConfident} not confident`);
  const nr = [n.noBoxes ? `${plural(n.noBoxes, 'function')} with no box` : '', n.unresolved ? `${plural(n.unresolved, 'call')} not followed` : '', n.severalTargets ? `${n.severalTargets} with several targets` : ''].filter(Boolean);
  L.push(`not read: ${nr.join(', ') || 'nothing the tool knows of'}${notes.length ? `; ${trunc(notes[0], 90)}` : ''}`);
  L.push(`open: ${plural(n.questions, 'question')} (${n.questionsSure} sure), ${plural(n.gaps, 'gap')} in the drawing, ${n.hearerUnknown}/${n.failing} failing endings with no known hearer`);
  const f = data.findings.filter((x) => x.shown).length;
  const fresh = !page || (page.built && page.current);
  L.push(!page ? 'page: not checked' : !page.built ? 'page: NOT BUILT' : page.current ? 'page: built, matches the map as stored (code not checked)' : page.recorded ? `page: OUT OF DATE (${page.changed})` : 'page: built by an older version, cannot tell if it matches the map');     // matches = the page's recorded inputs equal the project files now; no source file is opened
  const src = refresh || 'faultline map --source <the code folder>';       // refresh is the whole command that makes the map again
  L.push(!page || !page.built ? `next: ${src}` : !fresh ? 'next: faultline build   (rebuilds the page from the map, no source needed)' : f ? 'next: faultline breaks   (the questions, ranked)' : n.claimsNotConfident ? 'next: faultline review queue --source <the code folder>' : 'next: faultline brief');
  return L;
}
