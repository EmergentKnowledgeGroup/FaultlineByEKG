// Plain words for every box: one template per rule, filled from the tool's claims and the source line.
// The tool's own phrase is kept as `raw` (provenance); the reader sees `title` (fits a box) and `plain` (a full sentence).
import { clip, quoted, squash } from './util.mjs';
import { summarizeExpr, headName } from './outcomes.mjs';
import { routeOfTest } from './routes.mjs';

export const TITLE_MAX = 40;
export const PLAIN_MAX = 320;

const EFFECT_ORDER = ['delete', 'store', 'emit', 'print', 'respond', 'record', 'network', 'process', 'gui', 'db'];
const SQL_CALLS = new Set(['execute', 'executemany', 'executescript', 'query', 'run', 'all', 'get', 'prepare', 'exec', 'raw']);
const SQL_RE = /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|SELECT\b[^;]*?\bFROM|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+["'`]?([A-Za-z_][\w.]*)/i;
const DISPOSITIONS = {
  print: 'print it', record: 'record it', log: 'log it', reraise: 'raise it again', translate: 'raise a different error instead',
  swallow: 'ignore it', return: 'return instead', emit: 'announce it as an event', respond: 'send an error reply', unknown: 'do something the tool could not classify',
};
const WAIT_ON = { machine: 'another program or task', person: 'a person', time: 'a timer' };

function strLit(s) {
  const m = /^[rbfuRBFU]*(["'`])([\s\S]*)\1$/.exec(s.trim());
  return m ? m[2] : null;
}

/** Strip a leading `await`/`yield`/`return`, a trailing `;`, and keep one line. */
function bare(expr) {
  return squash(expr).replace(/^(?:await|yield|return)\s+/, '').replace(/;$/, '');
}

/** Effect groups of a box: one per (call, line) with its effects, from the claim register. */
export function effectGroups(W, box) {
  const groups = new Map();
  for (const c of W.claimsOf(box.id)) {
    if (c.type !== 'effect' && c.type !== 'declined') continue;
    const eff = (c.effect ?? c.says.replace(/^does /, '')).replace(/^maybe:/, '');
    const key = `${c.call}@${c.line}`;
    if (!groups.has(key)) groups.set(key, { call: c.call ?? '', line: c.line ?? box.prov.line, effects: [], maybe: c.type === 'declined' || c.conf !== 'confident' });
    const g = groups.get(key);
    if (c.type === 'effect' && c.conf === 'confident') g.maybe = false;
    if (!g.effects.includes(eff)) g.effects.push(eff);
  }
  return [...groups.values()].sort((a, b) => a.line - b.line || (a.call < b.call ? -1 : 1));
}

/** The verb and target the code shows for one effect group. */
export function effectTarget(W, box, g) {
  const path = box.refs?.[0]?.path ?? box.prov.fn.split('::')[0];
  const tail = g.call.split('.').pop();
  const calls = W.source.calls(path, g.line, g.line + 12).filter((c) => c.full === g.call || c.name === tail);
  const c = calls[0];
  const out = { verb: '', target: '', call: g.call, line: g.line };
  if (!c) return out;
  const args = W.source.args(path, c.open);
  const recv = c.recv && !/^(self|this|cls)$/.test(c.recv) ? c.recv.replace(/^(self|this)\./, '') : '';
  const first = args[0];
  const lit0 = first ? strLit(first.text) : null;
  if (lit0 !== null && /^[A-Z][A-Z_]{1,19}$/.test(lit0) && args.length > 1) return { ...out, verb: lit0, target: bare(args[1].text) };
  if (g.effects.includes('emit') && lit0 !== null) return { ...out, verb: tail, target: `the ${quoted(lit0, 30)} event` };
  if (lit0 !== null && SQL_CALLS.has(tail)) {
    const m = SQL_RE.exec(lit0);
    if (m) return { ...out, verb: m[1].split(/\s+/)[0].toUpperCase(), target: `table ${m[2]}` };
  }
  if (lit0 !== null && /^[A-Za-z_]{2,20}$/.test(lit0) && args.length > 1 && !g.effects.includes('print')) {
    return { ...out, verb: lit0, target: bare(args[1].text) };
  }
  if (recv) return { ...out, verb: tail, target: recv };
  if (first) return { ...out, verb: tail, target: lit0 !== null ? quoted(lit0, 30) : bare(first.text) };
  return { ...out, verb: tail, target: '' };
}

/** One sentence for an effect group, e.g. "Writes to path.parent (mkdir)". */
export function effectPhrase(W, box, g, limit = 34) {
  const t = effectTarget(W, box, g);
  const main = EFFECT_ORDER.find((e) => g.effects.includes(e)) ?? g.effects[0] ?? 'store';
  const tgt = t.target ? clip(t.target, limit) : '';
  const via = t.verb && t.verb !== tgt ? ` (${clip(t.verb, 16)})` : '';
  let s;
  if (main === 'store') s = tgt ? `Writes to ${tgt}${via}` : `Writes something via ${t.call || 'a call'}`;
  else if (main === 'delete') s = tgt ? `Deletes from ${tgt}${via}` : `Deletes something via ${t.call || 'a call'}`;
  else if (main === 'emit') s = tgt ? (/^the ".*" event$/.test(tgt) ? `Announces ${tgt}` : `Announces on ${tgt}${via}`) : `Announces an event via ${t.call || 'a call'}`;
  else if (main === 'print') s = tgt ? `Prints ${tgt}` : `Prints via ${t.call || 'a call'}`;
  else if (main === 'respond') s = `Sends a reply${t.call ? ` (${t.call})` : ''}`;
  else if (main === 'record') s = tgt ? `Records ${tgt}` : `Records via ${t.call || 'a call'}`;
  else if (main === 'network') s = `Calls out over the network${t.call ? ` (${t.call})` : ''}`;
  else if (main === 'process') s = `Starts or talks to another process${t.call ? ` (${t.call})` : ''}`;
  else if (main === 'gui') s = `Changes what is on screen${t.call ? ` (${t.call})` : ''}`;
  else if (main === 'db') s = tgt ? `${/^(SELECT)$/i.test(t.verb) ? 'Reads from' : 'Uses'} ${tgt}${via}` : `Uses the database${t.call ? ` (${t.call})` : ''}`;
  else s = `Does ${main}${t.call ? ` (${t.call})` : ''}`;
  if (g.effects.includes('db') && main !== 'db') s += ' [database]';
  if (g.maybe) s = `Possibly ${s.charAt(0).toLowerCase()}${s.slice(1)}`;
  return s;
}

/** Parse the tool's step phrase "runs F ; does a, b ; calls X, Y..." into parts. */
export function parseStepPhrase(detail) {
  const parts = squash(detail).split(/\s*;\s*/).filter(Boolean);
  const out = { runs: '', does: [], calls: [], other: [] };
  for (const p of parts) {
    let m;
    if ((m = /^runs\s+(.*)$/.exec(p))) out.runs = m[1].replace(/\.\.\.$/, '');
    else if ((m = /^does\s+(.*)$/.exec(p))) out.does = m[1].split(/\s*,\s*/);
    else if ((m = /^calls\s+(.*)$/.exec(p))) out.calls = m[1].replace(/\.\.\.$/, '').split(/\s*,\s*/).filter(Boolean);
    else out.other.push(p);
  }
  return out;
}

function joinList(items, max = 4) {
  const xs = items.slice(0, max);
  const more = items.length > max ? ` and ${items.length - max} more` : '';
  if (xs.length <= 1) return xs.join('') + more;
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}${more}`;
}

/** Words for a handler box: "On any error: print it". */
export function handlerWords(box) {
  const raw = box.title;
  const m = /^on\s+(.+?):\s*([\w]+)(~?)\s*$/.exec(box.detail ?? box.title);
  if (!m) return { title: clip(raw, TITLE_MAX), plain: `An error handler: ${raw}.`, raw };
  const types = m[1] === '*' ? 'any error' : m[1].split(/[/|]/).map((t) => t.trim()).join(' or ');
  const what = DISPOSITIONS[m[2]] ?? m[2];
  const maybe = m[3] ? 'probably ' : '';
  return {
    title: clip(`On ${types}: ${maybe}${what}`, TITLE_MAX),
    plain: `If ${m[1] === '*' ? 'anything goes wrong here' : `${types} is raised`}, this handler will ${maybe}${what}.${m[3] ? ' The tool is not sure of that.' : ''}`,
    raw,
  };
}

/** Words for a loop box from the source line. */
export function loopWords(W, box, path) {
  const raw = box.title;
  const cond = W.source.condition(path, box.prov.line);
  const fallback = (box.detail ?? box.title).replace(/^loop:\s*/, '');
  const text = cond && squash(cond.text).startsWith(squash(fallback).slice(0, 18)) ? cond.text : fallback;
  let title;
  let plain;
  const forEach = /^(?:const|let|var)?\s*\(?([\w$,\s[\]{}]+?)\)?\s+(of|in)\s+([\s\S]+)$/.exec(text);
  if (cond?.kind === 'for' && forEach) {
    title = `For each ${forEach[1].replace(/^(const|let|var)\s+/, '').trim()} in ${forEach[3].trim()}`;
    plain = `Repeats once for each ${forEach[1].replace(/^(const|let|var)\s+/, '').trim()} in ${forEach[3].trim()}.`;
  } else if (/^(true|True|1|!0)$/.test(text.trim())) {
    title = 'Repeats until it stops itself';
    plain = 'Repeats with no condition of its own; it ends only through a return, break or error inside it.';
  } else if (cond?.kind === 'for') {
    title = `Repeats: ${text}`;
    plain = `A counting loop: ${text}.`;
  } else {
    title = `Repeats while ${text}`;
    plain = `Repeats while ${text}.`;
  }
  return { title: clip(title, TITLE_MAX), plain: clip(plain, PLAIN_MAX), raw };
}

/** True when a loop box iterates over a literal list written in the code. */
export function loopOverLiteral(box) {
  const t = (box.detail ?? box.title).replace(/^loop:\s*/, '');
  if (/\b(?:of|in)\s+[[({]/.test(t)) return true;
  if (/\bin\s+(?:range\(\s*\d+\s*(?:,\s*\d+\s*)?\)|ipairs\(\s*\{)/.test(t)) return true;
  if (/^[\w$]+\s*=\s*\d+\s*,\s*\d+/.test(t)) return true;
  return false;
}

/** "( a or b )" is "a or b": drop one pair of brackets that wraps the whole expression. */
export function stripOuterParens(t) {
  let x = squash(t);
  while (x.startsWith('(') && x.endsWith(')')) {
    let d = 0;
    let whole = true;
    for (let i = 0; i < x.length; i++) {
      if (x[i] === '(') d++;
      else if (x[i] === ')' && --d === 0 && i < x.length - 1) {
        whole = false;
        break;
      }
    }
    if (!whole) break;
    x = x.slice(1, -1).trim();
  }
  return x;
}

/** Words for a decision box. */
export function decisionWords(W, box, path, fnQual) {
  const raw = box.title;
  const fallback = box.detail ?? box.title;
  const head = squash(fallback).replace(/\.\.\.$/, '').split(' | ')[0].replace(/\s+/g, '');
  const lead = (x) => x.replace(/\s+/g, '').replace(/^[(!]+/, '').replace(/^await/, '');
  const startsLike = (t) => lead(t).startsWith(lead(head).slice(0, 10)) || lead(head).startsWith(lead(t).slice(0, 10));
  // the tool joins consecutive tests it folded into one box with " | ": read each test in full from its own line
  const lines = box.prov.chain?.length > 1 ? box.prov.chain : [box.prov.line];
  const tests = lines.map((ln) => stripOuterParens(W.source.condition(path, ln)?.text ?? '')).filter(Boolean);
  const first = tests.length && startsLike(tests[0]) ? tests : null;
  const full = first ? first.join(' | ') : fallback;
  const route = routeOfTest(first ? first[0] : full, fnQual);
  if (route) return { title: clip(`Is it ${route.label}?`, TITLE_MAX), plain: `Checks whether the request is ${route.label} (${first ? first[0] : full}).`, raw, full, route };
  if (first && first.length > 1) {
    return { title: clip(`${first[0]} (+${first.length - 1} more)`, TITLE_MAX), plain: clip(`Checks, in turn: ${first.map((t, i) => `(${i + 1}) ${t}`).join('; ')}.`, PLAIN_MAX * 2), raw, full };
  }
  return { title: clip(full, TITLE_MAX), plain: clip(`Checks whether ${full}.`, PLAIN_MAX * 2), raw, full };
}

/** Words for a step / store / external box. */
/** Make the tool's qualified names readable: an inner function has no name of its own, so say what it is. */
export function plainName(s) {
  return s.replace(/\.?<anon@\d+>/g, ' (inner function)').replace(/~\d+/g, '').replace(/\s+/g, ' ').trim();
}

export function stepWords(W, box, names) {
  const raw = box.detail ?? box.title;
  const ph = parseStepPhrase(raw);
  ph.runs = plainName(ph.runs);
  ph.calls = ph.calls.map(plainName);
  const groups = effectGroups(W, box);
  const bits = [];
  const sentences = [];
  if (ph.runs) {
    bits.push('Starts');
    sentences.push(`Starts ${ph.runs}.`);
  }
  const eff = groups.map((g) => effectPhrase(W, box, g));
  const effFull = groups.map((g) => effectPhrase(W, box, g, 160));
  if (eff.length) {
    sentences.push(`${[...new Set(effFull)].join('; ')}.`);
  } else if (ph.does.length) {
    sentences.push(`Does ${joinList(ph.does)} (what and where was not read).`);
  }
  if (ph.calls.length) sentences.push(`Calls ${joinList(ph.calls)}.`);
  for (const o of ph.other) sentences.push(`${o}.`);
  let title;
  if (eff.length) title = eff[0] + (eff.length > 1 ? ` +${eff.length - 1}` : '');
  else if (ph.does.length) title = `Does ${ph.does.join(', ')}`;
  else if (ph.calls.length) title = `Calls ${ph.calls.join(', ')}`;
  else if (ph.runs) title = `Starts ${ph.runs}`;
  else title = raw;
  if (ph.runs && (eff.length || ph.calls.length) && title.length < TITLE_MAX - 8) title = title;
  return { title: clip(title.replace(/\.\.\.$/, ''), TITLE_MAX), plain: clip(sentences.join(' ') || raw, PLAIN_MAX), raw, pure: !eff.length && !ph.does.length };
}

/** Words for a wait box. */
export function waitWords(W, box, path) {
  const raw = box.title;
  const st = W.source.statement(path, box.prov.line);
  let target = (box.detail ?? box.title).replace(/^waits:\s*/, '');
  if (st) {
    const aw = /\bawait\s+([^;]+?)\s*;?\s*$/.exec(squash(st.text)) || /\bwith\s+([^:]+):/.exec(squash(st.text));
    if (aw) target = aw[1];
  }
  const claim = W.claimsOf(box.id).find((c) => c.type === 'wait');
  const on = claim ? /waits on (\w+)/.exec(claim.says)?.[1] : '';
  const who = on && WAIT_ON[on] ? ` It is waiting on ${WAIT_ON[on]}.` : '';
  return { title: clip(`Waits for ${target}`, TITLE_MAX), plain: clip(`Waits here until ${target} is done.${who}`, PLAIN_MAX), raw };
}

/** Words for the try box. */
export function tryWords(box) {
  const raw = box.title;
  const what = raw.replace(/^tries\s+/, '');
  if (what === '?') return { title: 'Tries something the tool did not name', plain: `Tries something that the tool could not name (line ${box.prov.line}); errors go to the handler.`, raw };
  return { title: clip(`Tries ${what}`, TITLE_MAX), plain: `Tries ${what}; if it fails, the handler below takes over.`, raw };
}

/** Words for one ending site: a title that fits a box and one sentence. */
export function endSiteLabel(end, s) {
  if (s.kind === 'raise' || s.kind === 'throw') {
    // the real exception: the class written in the code, else the class the tool found; a bare `raise` or a variable is the error it caught
    const fromCls = (end.cls ?? '').split(':').pop();
    const nm = headName(s.expr) || (fromCls && fromCls !== '*' && /^[A-Za-z_$][\w$.]*$/.test(fromCls) ? fromCls : '');
    const msg = /["'`]([^"'`\n]{3,120})["'`]/.exec(s.expr ?? '')?.[1] ?? '';
    if (!nm) {
      const v = bare(s.expr ?? '');
      return v ? { t: clip(`Raises ${v}`, 40), p: `Raises the error held in ${v}.` } : { t: 'Raises the error it caught', p: 'Raises the error it caught again.' };
    }
    return { t: `Fails with ${nm}`, p: `Raises ${nm}${msg ? `: ${quoted(msg, 120)}` : s.expr.includes('(') ? `: ${clip(s.expr, 140)}` : ''}.`, msg };
  }
  if (s.kind === 'exit' || end.cls === 'X') return { t: 'Exits the program', p: 'Stops the whole program here.' };
  if (!s.expr) return { t: 'Returns nothing', p: 'Returns with no value.' };
  const st = /HTTP (\d{3})/.exec(s.why);
  const e = bare(s.expr);
  if (st) return { t: `Answers HTTP ${st[1]}`, p: `Answers with HTTP status ${st[1]}: ${clip(e, 160)}.` };
  return { t: `Returns ${summarizeExpr(e, 28)}`, p: `Returns ${clip(e, 200)}.` };
}

/** Words for an end box, given its classified sites (from outcomes.mjs). */
export function endWords(box, end, names) {
  const raw = box.detail ?? box.title;
  const fn = names ? names.label(box.prov.fn) : '';
  if (!end) return { title: clip(box.title, TITLE_MAX), plain: raw, raw };
  const s0 = end.sites[0];
  const several = end.sites.length > 1;
  const label = (s) => endSiteLabel(end, s);
  const a = label(s0);
  let title = a.t;
  let plain = a.p;
  if (end.outcome === 'mixed') {
    title = `Ends ${end.sites.length} ways`;
    plain = `${end.sites.length} different endings share this box: ${end.sites.map((s) => `${label(s).t.toLowerCase()} (${s.outcome})`).join('; ')}.`;
  } else if (several) {
    plain += ` The same ending is reached at ${end.sites.length} places in ${fn || 'this function'}.`;
    if (!/places/.test(title)) title = clip(`${title} (${end.sites.length}x)`, TITLE_MAX);
  }
  if (end.sites.some((s) => s.caught)) plain += ` (${end.sites[0].caught}.)`;
  return { title: clip(title, TITLE_MAX), plain: clip(plain, PLAIN_MAX), raw };
}
