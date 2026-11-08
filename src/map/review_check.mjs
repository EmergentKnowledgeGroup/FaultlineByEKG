// The gate that re-checks an agent's answer to a review question, and the view of the claim register with the checked answers beside it.
//
//   checkAnswer(item, answer, src, claimsById) -> result   the answer must be {item, choice, cite, quote} and nothing else. The tool re-reads the cited
//                                                          file: the line must exist, hold the quote, and (for a positive answer) hold evidence that
//                                                          the rule for that question accepts.
//   view(claims, results, withAgent) -> claims             withAgent = false is the claim list byte for byte.
//
// What an answer can and cannot do:
//   - it can only ANNOTATE a not-confident claim. It cannot add a box or a road, delete anything, or touch a claim a type checker or the flow graph
//     pinned (pinned claims are not in the queue, and an answer naming one is refused).
//   - a negative answer ("not caught", "not used", "no") cannot be checked against a line, so it is stored as an opinion and never moves a flag.
//   - status: checked (line holds evidence the rule accepts) | cited-only (line exists and holds the quote; nothing more is shown) | opinion (negative
//     answer) | no-answer (cannot-tell) | refused (why).
import { createHash } from 'node:crypto';
import { TEMPLATES, CANT, norm } from './review.mjs';
import { cpSlice, cpLen, pyStrip, dumps, pyRepr } from './pyrt.mjs';

const PURE_ANN = '(?:str|int|float|bool|bytes|list|dict|set|tuple|string|number|boolean|Path|List\\[\\w+\\]|Dict\\[.*\\]|string\\[\\]|number\\[\\])';
const YES = {
  store: /open\([^)]*['"][wax+]|\bPath\(|\bos\.|shutil\.|sqlite3|\.write\(|\bfs\.|redis|Redis|mkdtemp|NamedTemporaryFile|writeFile|\.cursor\(|connect\(/,
  delete: /\bPath\(|\bos\.|shutil\.|\bfs\.|redis|Redis|unlink|rmtree|connect\(/,
  emit: /Queue\(|queue|EventEmitter|\.emit\(|Event\(|Signal|dispatch|publish|subscribe/,
  respond: /wfile|send_response|jsonify|JSONResponse|HTMLResponse|make_response|\bres\.(?:send|status|end)\(|\.write\(/,
  wait: /Event\(|Queue\(|Lock\(|Semaphore\(|Condition\(|Thread\(|Future|Promise|asyncio|sleep|Barrier\(/,
  ext: /requests|httpx|urllib|socket|aiohttp|fetch|Client\(|subprocess|Popen|sqlite3|connect\(/,
};
const TELL = /log(?:ger|ging)?\.\w+\(|print\(|console\.|respond|emit|send_|\.send\(|write\(|record|raise\b|throw\b|report|notify|alert|warn|publish|show/;
const LOCKS = /(?:Lock|RLock|Semaphore|BoundedSemaphore|Condition|Event|Queue|Barrier|Mutex|Lock)\(|asyncio\.(?:Lock|Event|Queue|Semaphore)|threading\.|multiprocessing\./;
const MIN_QUOTE = 3; // a quote shorter than this proves nothing
const MAX_QUOTE = 200;
const ALLOWED_KEYS = ['item', 'choice', 'cite', 'quote'];
const idents = (s) => new Set(s.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasAny = (a, b) => [...a].some((x) => b.has(x));

/** -> {status, rule, why, line_text, line_sha}. ans: {item, choice, cite, quote}. */
export function checkAnswer(item, ans, src, claimsById, strict = true) {
  const base = { item: ans.item ?? null, choice: ans.choice ?? null, cite: ans.cite ?? null, claims: item ? item.claims : [] };
  const refuse = (rule, why, extra = {}) => ({ ...base, status: 'refused', rule, why, ...extra });
  const extra = Object.keys(ans).filter((k) => !ALLOWED_KEYS.includes(k)).sort();
  if (extra.length) return refuse('schema', 'keys not allowed (an answer annotates, it cannot add or remove structure): ' + extra.join(', '));
  if (item === null) return refuse('no-such-item', 'no such item in the queue');
  for (const cid of item.claims) {
    const c = claimsById.get(cid);
    if (!c || c.pinned || c.conf !== 'not-confident') return refuse('pinned', `claim ${cid} is not a not-confident claim (pinned by the checker / flow graph, or confident)`);
  }
  const ch = ans.choice;
  if (!item.answers.includes(ch)) return refuse('choice', `"${ch}" is not in the answer set ${pyRepr(item.answers)}`);
  if (ch === CANT) return { ...base, status: 'no-answer', rule: 'cannot-tell', why: 'the agent could not tell' };
  const { cite, quote } = ans;
  if (typeof cite !== 'string' || typeof quote !== 'string' || !cite.includes(':')) return refuse('cite', 'cite must be "path:line" and quote a string');
  const at = cite.lastIndexOf(':');
  const rel = cite.slice(0, at);
  const lnText = cite.slice(at + 1);
  if (!/^\p{Nd}+$/u.test(lnText) || Number(lnText) < 1 || rel.startsWith('/') || rel.startsWith('..') || rel.split('/').includes('..') || rel.includes(':')) return refuse('cite', 'cite is not a project-relative path:line');
  const ls = src.lines(rel);
  if (ls === null) return refuse('line-exists', `${rel} is not a file in the project`);
  const ln = Number(lnText);
  if (ln > ls.length) return refuse('line-exists', `${rel} has ${ls.length} lines, not ${ln}`);
  const text = ls[ln - 1];
  const q = norm(quote);
  if (cpLen(q) < MIN_QUOTE || cpLen(q) > MAX_QUOTE || !norm(text).includes(q)) return refuse('quote', 'the cited line does not hold the quote', { line_text: cpSlice(pyStrip(text), 0, 200) });
  const res = { ...base, line_text: cpSlice(pyStrip(text), 0, 200), line_sha: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16) };
  const tpl = item.template;
  const spec = TEMPLATES[tpl];
  if (tpl === 'effect' && ch === 'no' && item.recv) {
    const r = escapeRe(item.recv);
    const QU = '["\']';
    const pat1 = new RegExp(`(?<![A-Za-z0-9_.])${r}\\s*(?::\\s*${PURE_ANN}\\b|=\\s*(?:${QU}|f${QU}|str\\(|int\\(|float\\(|\\[|\\{|dict\\(|list\\(|set\\(|b${QU}))`);
    const pat2 = new RegExp(`\\b${r}\\b\\s*(?:=|:)\\s*.*\\.(?:join|format)\\(`);
    if (pat1.test(q) || pat2.test(q)) return { ...res, status: 'checked', rule: 'line-binds-the-receiver-to-a-plain-value', why: 'the cited line binds the receiver to a string, number, list or dict' };
  }
  if (spec.neg.includes(ch)) return { ...res, status: 'opinion', rule: 'negative-answer', why: 'a negative answer cannot be checked against a line: stored as an opinion, no flag moves' };
  const subject = item.subject ?? [];
  const mentions = subject.length ? hasAny(idents(q), new Set(subject)) : true;
  let ok = false;
  let rule = '';
  if (tpl === 'effect') {
    const e = (item.effect ?? 'store').split(':')[0];
    if (ch === 'yes') {
      [ok, rule] = [(YES[e] ?? YES.store).test(q), 'line-shows-an-effect-api'];
      if (strict && ok && rel === item.path && ln === item.line) [ok, rule] = [false, 'the-cited-line-is-the-call-itself']; // it only repeats the name the tool already had
    }
  } else if (tpl === 'catch') [ok, rule] = [/^\s*(?:\}\s*)?(?:except|catch)\b/.test(q) || /\bexcept\b|\bcatch\b|\.catch\(/.test(q), 'line-is-a-handler'];
  else if (tpl === 'entry' || tpl === 'absence') {
    [ok, rule] = [mentions && subject.length > 0, 'line-names-it'];
    if (ok && rel === item.path && Math.abs(ln - item.line) < 2 && /^\s*(async\s+)?(def|function|class)\b/.test(q)) [ok, rule] = [false, 'the-line-is-its-own-definition'];
  } else if (tpl === 'target') [ok, rule] = [(item.candidates ?? []).includes(ch) && hasAny(idents(q), new Set(ch.split('.'))), 'line-names-the-chosen-target'];
  else if (tpl === 'hears' || tpl === 'handler') [ok, rule] = [TELL.test(q), 'line-tells-someone'];
  else if (tpl === 'lock') {
    [ok, rule] = [LOCKS.test(q), 'line-makes-a-lock-or-queue'];
    if (strict && ok && rel === item.path && ln === item.line) [ok, rule] = [false, 'the-cited-line-is-the-claim-itself'];
  } else if (tpl === 'type') [ok, rule] = [/\bclass\s+\w+|\bimport\b|\bfrom\s+\S+\s+import\b|\brequire\(/.test(q), 'line-defines-or-imports-a-class'];
  else if (tpl === 'excroad') [ok, rule] = [/\braise\b|\bthrow\b|Error\(|Exception\(/.test(q), 'line-raises'];
  else if (tpl === 'places') [ok, rule] = [false, 'meaning-is-not-checkable'];
  if (ok) return { ...res, status: 'checked', rule, why: 'the cited line exists, holds the quote, and shows ' + rule.replaceAll('-', ' ') };
  return { ...res, status: 'cited-only', rule: rule || 'no-rule', why: 'the cited line exists and holds the quote; it does not show what the answer says (' + (rule || 'no rule') + ')' };
}

/** The claim list as a reader sees it. withAgent = false returns the claims untouched. Otherwise each not-confident claim an answer touched gains `agent`
 *  (the answer, its status and the line); `conf` and `reason` are never rewritten. */
export function view(claims, results, withAgent = true) {
  if (!withAgent) return claims;
  const by = new Map();
  for (const r of results) {
    if (r.status === 'refused') continue;
    for (const cid of r.claims) {
      if (!by.has(cid)) by.set(cid, []);
      by.get(cid).push(Object.fromEntries(['choice', 'status', 'cite', 'rule', 'line_text'].map((k) => [k, r[k] ?? null])));
    }
  }
  return claims.map((c) => (by.has(c.id) ? { ...c, agent: by.get(c.id) } : c));
}

export const reviewText = (x) => dumps(x, 1);
