// Small word tools for the story check. Nothing here reads meaning: it finds names that look like code, shared words, and a few closed word lists.

export const STOP = new Set('the a an of to in on is are be as at by for or and if it its this that with from into not no then than when where which who has have had does do did can may will would should could one two all any each every per via out off up over under again once only also just'.split(' '));
const DOTTED = /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g;
const CAMEL = /\b(?:[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)\b/g;
const SNAKE = /\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/g;
const CAPS = /\b[A-Z]{3,}[A-Z0-9]*\b/g;
const BACKT = /`([^`\n]{2,80})`/g;
const FILEEXT = /\.(?:ts|js|lua|py|json|md|tsx|mjs|html|css|sql|txt|yml|yaml)$/i;
/** Short acronyms and plain words that look like names but are not: finding them nowhere in the code says nothing. */
export const GENERIC = new Set('json http https sql url uri api html css utf ascii ttl fifo lifo lua tcp udp ssl tls id ids cpu gpu ram uuid xml yaml cli get set del put post not and the for null none true false todo note'.split(' '));

/** Code-looking names in plain text: `backticked`, dotted, camelCase, snake_case, ALLCAPS. Returns Map(token -> the most specific lowercase segment). */
export function nameTokens(text) {
  const out = new Map();
  const cands = [];
  for (const m of String(text ?? '').matchAll(BACKT)) cands.push(m[1]);
  for (const rx of [DOTTED, CAMEL, SNAKE, CAPS]) for (const m of String(text ?? '').matchAll(rx)) cands.push(m[0]);
  for (let c of cands) {
    c = c.trim().replace(/^[.,;:()]+|[.,;:()]+$/g, '');
    if (!c || FILEEXT.test(c)) continue;
    const segs = (c.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter((s) => s.length >= 3 && !STOP.has(s.toLowerCase()));
    if (!segs.length) continue;
    const pick = c.length > 40 || c.includes(' ') ? segs.reduce((a, b) => (b.length > a.length ? b : a)) : segs[segs.length - 1];
    const key = pick.replace(/^_+|_+$/g, '');
    if (key.length < 3 || GENERIC.has(key.toLowerCase()) || STOP.has(key.toLowerCase())) continue;
    out.set(c, key.toLowerCase());
  }
  return out;
}

/** Informative lowercase words of a text, camelCase and snake_case split. */
export function words(text) {
  const t = String(text ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return new Set((t.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)));
}

export const shares = (a, b) => { for (const w of a) if (b.has(w)) return true; return false; };

/** A label is about a test when it uses at least half of the test's informative words (and at least one). One shared word out of three is a coincidence of a common word, not the same subject. */
export const MIN_TEST_SHARE = 0.5;
export function covers(testWords, labelWords) {
  let n = 0;
  for (const w of testWords) if (labelWords.has(w)) n++;
  return n >= 1 && n / testWords.size >= MIN_TEST_SHARE;
}

/** Labels that only mean "the other way": the arm of a decision that is not the tested one. A closed list; it does not read sentences. */
const ELSE_LABEL = /^\s*(?:else|otherwise|if not|or else|if it is not|if it isn't|failing that|in any other case|in all other cases)\s*[.:]?\s*$/i;
export const isElseLabel = (s) => ELSE_LABEL.test(String(s ?? ''));

/** Words that state a negation outright. A closed list: a label that means "no" in other words is not seen. */
const NEGATION = /\b(?:not|no|never|none|nothing|neither|nor|without|cannot)\b|n't\b/i;
export const hasNegation = (s) => NEGATION.test(String(s ?? ''));

/** Words that say a thing is absent, empty or off, without a "no" or "not". A label with one of these is not read as saying the thing is there. */
const ABSENCE = /\b(?:empty|missing|absent|unset|blank|zero|nil|null|undefined|gone|lost|lacks?|lacking|expired|stale|invalid|false|off|disabled|closed|finished|exhausted|done)\b/i;
export const hasAbsence = (s) => ABSENCE.test(String(s ?? ''));

/** Words that say a thing went well, and words that say it went wrong: used only to compare a label with an arm the tool shows as an error path. */
const GOOD = /\b(?:success|successful|successfully|succeed|succeeds|succeeded|ok|okay|done|complete|completes|completed|finished|worked|works|accepted)\b/i;
const BAD = /\b(?:fail|fails|failed|failure|error|errors|raise|raises|raised|refuse|refuses|refused|reject|rejects|rejected|throw|throws|threw|cannot|unable|exception|invalid|denied)\b|n't\b/i;
export const readsAsGood = (s) => GOOD.test(String(s ?? ''));
export const readsAsBad = (s) => BAD.test(String(s ?? ''));

/** What a test text says about being there or not, when that is plain. 'pos' = the test is about something being present, 'neg' = about it being absent, null = not plain.
 *  Only these shapes are read: a bare name, a negated bare name, a comparison with nothing, and a ">" or ">=" against a number. Anything else is left alone. */
const NOTHING_RHS = /(?:null|undefined|nil|none|None|false|False|0|""|''|\[\]|\{\})/.source;
const OPERAND = /[A-Za-z_$@][\w$.@]*(?:\(\))?(?:\[[^\]]*\])?/.source;
const RX = {
  absent: new RegExp(String.raw`^\s*${OPERAND}\s*(?:===?|==|is)\s*${NOTHING_RHS}\s*$|^\s*(?:!(?!=)|not\s+)\s*${OPERAND}\s*$`),
  present: new RegExp(String.raw`^\s*${OPERAND}\s*(?:!==?|~=|is\s+not)\s*${NOTHING_RHS}\s*$|^\s*${OPERAND}\s*(?:>|>=)\s*\d+\s*$|^\s*${OPERAND}\s*$`),
};
export function testPolarity(test) {
  const t = String(test ?? '');
  if (RX.absent.test(t)) return 'neg';
  if (RX.present.test(t)) return 'pos';
  return null;
}
