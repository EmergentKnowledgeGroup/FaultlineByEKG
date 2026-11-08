// Display rules and shared word lists. Limits come from CONTRACTS section 5.
export const LIMITS = { titleTarget: 34, titleMax: 40, plainMax: 260, whenMax: 28 };
export const KINDS = ['step', 'decision', 'wait', 'end', 'store', 'external', 'gate'];
export const STATUSES = ['live', 'default-on', 'off', 'test-only'];
export const OUTCOMES = ['success', 'failure', 'refusal', 'neutral'];
export const ROUTE_TYPES = ['forward', 'return', 'record', 'deliver'];
// A route label is a condition. These openers mean it is a description of what the box does instead.
export const DESCRIPTION_VERBS = ['checks', 'handles', 'manages', 'processes', 'uses', 'supports', 'can', 'may', 'might'];

export const len = (s) => [...String(s ?? '')].length;
export const firstWord = (s) => (String(s ?? '').trim().match(/^[A-Za-z']+/) || [''])[0].toLowerCase();
export const startsWithDescriptionVerb = (s) => DESCRIPTION_VERBS.includes(firstWord(s));

// Words that read as "something outside the map acts first". Matched on a route's `when`, and on its `why` only
// when the route is drawn as inferred (no code path proves it).
export const OUTSIDE_EVENT = /\b(?:(?:later|another|next|subsequent|new)\s+(?:request|event|call|input|message|attempt|trigger)s?|external|operator|admin|manual(?:ly)?|resum(?:e|es|ed)|re-?evaluat\w*|timeout|scheduled|webhook|callback|later)\b/i;
// A route label with a hedge word and no condition in it is a description, not a condition.
export const HEDGE = /\b(?:can|may|might|could|inform(?:s|ed)?|possibly|optionally|sometimes|potentially|typically|generally|related|relates|influences?)\b/i;   // "support" and "help" are also plain nouns ("help text", "support ticket"), so they are not hedges
export const CONDITION = /\b(?:if|when|unless|only|else|otherwise|not|no|none|fewer|more|less|exceeds?|reached|at least|at most|equals?|matches?|fails?|passes?|valid|invalid|missing|present|absent|true|false|yes|accepted|rejected|blocked|allowed|denied|empty|unavailable|exhausted|complete|done|over|under|within|bad|ok|tries|left|late|full|first|last)\b|[<>=?]|\d/i;
// Words that say what bounds a loop. Underscores and camelCase are split first so MAX_TICKS reads as "max ticks".
const CAP_WORDS = /\b(?:cap|capped|limit|limits|limited|max|maximum|bounded|bound|at most|up to|attempts?|retr(?:y|ies)|budget|quota|cooldown|exhaust\w*|ceiling|threshold|times|tries|rounds?|iterations?|timeout|poll|fewer than|within|remaining|left|until|once|twice|only|stops?|ticks?)\b/i;
export const splitWords = (s) => String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.\-:/]+/g, ' ');
export const hasCapWord = (s) => CAP_WORDS.test(splitWords(s));
// A loop's `limit` field that says nothing: empty, or a placeholder.
export const limitIsEmpty = (s) => { const t = String(s ?? '').trim(); return !t || /^(?:none|nothing|n\/a|na|nil|no limit|unknown|tbd|\?+|-+)\b[\s.]*$/i.test(t); };

export const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
export const uniq = (a) => [...new Set(a)];
export const cap = (a, n) => (a.length > n ? a.slice(0, n) : a);
// Cut at a word boundary, with an ellipsis, so evidence lines never end mid-word.
export function clip(s, n) {
  const t = String(s ?? '').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n), sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}...`;
}

// Wording helpers for the sentences a reader sees (evidence). A box id inside one stays an id: the page turns it into the box's name.
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many ?? `${one}s`}`;
export const upFirst = (s) => { const t = String(s ?? ''); return t ? t[0].toUpperCase() + t.slice(1) : t; };
// "a, b, c and 3 more": at most `max` shown. `sep` is '; ' when the items carry commas of their own.
export function listMore(xs, max = 4, sep = ', ') {
  const shown = xs.slice(0, max).join(sep), rest = xs.length - max;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}
// a sentence ends with one full stop, however its last piece ended (a cut mark "..." stays as it is)
export const stop = (s) => { const t = String(s ?? '').trim(); return /\.\.\.$/.test(t) ? t : `${t.replace(/[\s;,:.]+$/, '')}.`; };
