// How a function ends, decided from what the code shows: an HTTP status of 400 or more, a refusal-shaped name, a raise.
// An open end ("N calls not followed") is not an ending; it is "continues, call not followed" and never counted as one.
import { squash, clip, langOf } from './util.mjs';

/** Names of the HTTP status constants of Python's `http.HTTPStatus` (and the same names in other libraries) with their codes. */
const STATUS_NAMES = {
  CONTINUE: 100, SWITCHING_PROTOCOLS: 101, OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, RESET_CONTENT: 205, PARTIAL_CONTENT: 206,
  MOVED_PERMANENTLY: 301, FOUND: 302, SEE_OTHER: 303, NOT_MODIFIED: 304, TEMPORARY_REDIRECT: 307, PERMANENT_REDIRECT: 308,
  BAD_REQUEST: 400, UNAUTHORIZED: 401, PAYMENT_REQUIRED: 402, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, NOT_ACCEPTABLE: 406,
  PROXY_AUTHENTICATION_REQUIRED: 407, REQUEST_TIMEOUT: 408, CONFLICT: 409, GONE: 410, LENGTH_REQUIRED: 411, PRECONDITION_FAILED: 412,
  REQUEST_ENTITY_TOO_LARGE: 413, CONTENT_TOO_LARGE: 413, PAYLOAD_TOO_LARGE: 413, REQUEST_URI_TOO_LONG: 414, URI_TOO_LONG: 414, UNSUPPORTED_MEDIA_TYPE: 415,
  REQUESTED_RANGE_NOT_SATISFIABLE: 416, RANGE_NOT_SATISFIABLE: 416, EXPECTATION_FAILED: 417, IM_A_TEAPOT: 418, MISDIRECTED_REQUEST: 421,
  UNPROCESSABLE_ENTITY: 422, UNPROCESSABLE_CONTENT: 422, LOCKED: 423, FAILED_DEPENDENCY: 424, TOO_EARLY: 425, UPGRADE_REQUIRED: 426,
  PRECONDITION_REQUIRED: 428, TOO_MANY_REQUESTS: 429, REQUEST_HEADER_FIELDS_TOO_LARGE: 431, UNAVAILABLE_FOR_LEGAL_REASONS: 451,
  INTERNAL_SERVER_ERROR: 500, NOT_IMPLEMENTED: 501, BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503, GATEWAY_TIMEOUT: 504,
  HTTP_VERSION_NOT_SUPPORTED: 505, INSUFFICIENT_STORAGE: 507, LOOP_DETECTED: 508, NOT_EXTENDED: 510, NETWORK_AUTHENTICATION_REQUIRED: 511,
};

/** Calls whose first number argument is an HTTP status: send_error(403), abort(404), res.sendStatus(500), reply.code(403) ... */
const STATUS_CALLS = /\b(?:send_error|abort|sendStatus|status|code|set_status|writeHead|send_response|error|HTTPException|createError|json_response|jsonify)\s*\(\s*(?:status(?:_code)?\s*=\s*)?([1-5]\d\d)\b/;
const STATUS_KEYS = /\b(?:status(?:_?code)?|statusCode|http_status)\s*[:=]\s*([1-5]\d\d)\b/i;

/** Words that make a name or a message "refusal-shaped". Case-insensitive, on identifiers split at underscores and capitals. */
const REFUSAL_WORDS = /(refus|reject|deni|deny|forbid|unauthori[sz]|notallowed|not_allowed|disallow|prohibit|permissiondenied|noaccess)/i;
const FAILURE_KEYS = /["']?(?:ok|success|allowed|accepted)["']?\s*[:=]\s*(?:False|false|0)\b/;
const ERROR_KEY = /["']error["']\s*:\s*[^\s,}]/;
/** An answer that says in a field that it failed: `{"status": "failed"}`, `{ state: 'error' }`. */
const FAILED_STATE = /["']?(?:status|state|result|outcome)["']?\s*[:=]\s*["'](?:fail(?:ed|ure)?|error(?:ed)?|denied|rejected|refused|invalid)["']/i;
/** A returned call whose name says it makes an error or a failure (`make_error(..)`, `failure(..)`, `ValueError(..)`, `errorResponse(..)`). */
const ERROR_CALL = /^(?:error|fail|failure|failed)(?:_\w+)?$|_(?:error|failure|failed)$|[a-z](?:Error|Failure|Failed|Exception)$|^(?:error|failure)[A-Z]\w*$/;
/** A negative number, alone or first in a list of returned values (`-1`, `-1, "why"`): by habit an error code. */
const NEGATIVE_FIRST = /^-\s*\d+(?:\.\d+)?\s*(?:,|$)/;

/** Where a line comment starts, by language. */
const COMMENT_MARKS = { lua: ['--'], py: ['#'], ts: ['//', '/*'] };

/**
 * The expression of a return or raise without what trails it on the same line: a line comment, the `end` that closes a one-line Lua block, a
 * semicolon. Quotes are respected, so a marker inside a string stays. `lang` is the language of the file (py, ts, lua); without it nothing is cut.
 */
export function cleanExit(text, lang = '') {
  let t = String(text ?? '');
  const marks = COMMENT_MARKS[lang] ?? [];
  let quote = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || (c === '`' && lang === 'ts')) quote = c;
    else if (marks.some((m) => t.startsWith(m, i))) {
      t = t.slice(0, i);
      break;
    }
  }
  t = t.trim();
  if (lang === 'lua') while (/(?:^|[\s;)\]}])end\s*[;,)]*\s*$/.test(t)) t = t.replace(/\s*\bend\s*[;,)]*\s*$/, '').trim();
  return squash(t.replace(/[;\s]+$/, ''));
}

/** The name a call expression starts with (`await self._refuse(x)` gives `_refuse`); '' when the expression is not a call. */
export function headName(expr) {
  const m = /^(?:await\s+|new\s+)*([A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*)*)\s*(?:<[^()]*>)?\s*\(/.exec(squash(expr));
  return m ? m[1].split(/[.?]+/).pop() : '';
}

/** HTTP status named in an expression: {code, via} or null. */
export function httpStatusIn(expr) {
  if (!expr) return null;
  const n = /\b(?:HTTPStatus|http\.client|status|constants|StatusCodes|HttpStatus)\.([A-Z][A-Z_]+)\b/.exec(expr);
  if (n && STATUS_NAMES[n[1]]) return { code: STATUS_NAMES[n[1]], via: `${n[0]}` };
  const c = STATUS_CALLS.exec(expr) || STATUS_KEYS.exec(expr);
  if (c) return { code: Number(c[1]), via: squash(c[0]) };
  return null;
}

export function refusalShaped(text) {
  return REFUSAL_WORDS.test(text ?? '');
}

/**
 * Decide one ending site.
 * @param {{kind:'return'|'raise'|'throw'|'exit'|'', expr:string, cls:string, fnName:string}} s
 * @returns {{outcome:'success'|'refusal'|'failure'|'neutral', why:string}}
 */
export function classifySite(s) {
  const expr = cleanExit(s.expr ?? '', s.lang ?? '');
  const st = httpStatusIn(expr);
  if (st) {
    if (st.code >= 500) return { outcome: 'failure', why: `answers HTTP ${st.code} (${st.via})` };
    if (st.code >= 400) return { outcome: 'refusal', why: `answers HTTP ${st.code} (${st.via})` };
    return { outcome: 'success', why: `answers HTTP ${st.code}` };
  }
  const head = headName(expr);
  const raised = s.kind === 'raise' || s.kind === 'throw' || (s.cls ?? '').startsWith('raise');
  if (raised) {
    const named = `${(s.cls ?? '').split(':').pop()} ${head}`;
    if (refusalShaped(named)) return { outcome: 'refusal', why: 'raises a refusal-shaped error' };
    return { outcome: 'failure', why: 'raises an error' };
  }
  if (s.cls === 'X') return { outcome: 'neutral', why: 'exits the program' };
  if (FAILURE_KEYS.test(expr)) return { outcome: 'refusal', why: 'returns an answer marked not ok' };
  if (refusalShaped(head)) return { outcome: 'refusal', why: 'returns through a refusal-shaped call' };
  if (ERROR_KEY.test(expr)) return { outcome: 'failure', why: 'returns an error answer' };
  if (FAILED_STATE.test(expr)) return { outcome: 'failure', why: 'returns an answer marked failed' };
  if (ERROR_CALL.test(head)) return { outcome: 'failure', why: 'returns through an error-shaped call' };
  const bareFalse = /^(?:False|false|None|null|undefined|0)?$/.test(expr.trim()) || /^R:const:(False|None)/.test(s.cls ?? '');
  if (bareFalse && refusalShaped(s.fnName)) return { outcome: 'refusal', why: 'a refusal-shaped function returns nothing/false' };
  if (!expr.trim() || /^R0/.test(s.cls ?? '') || /^(None|null|undefined|nil)$/.test(expr.trim())) return { outcome: 'neutral', why: 'returns nothing' };
  if (/^(false|False)$/.test(expr.trim())) return { outcome: 'neutral', why: 'returns false' };
  if (NEGATIVE_FIRST.test(expr.trim())) return { outcome: 'neutral', why: 'returns a negative number (often an error code); the tool does not call that a success' };
  return { outcome: 'success', why: 'returns a value' };
}

/** Compress a long expression for a title: drop type arguments, then collapse call arguments, then cut at a word edge. */
export function summarizeExpr(expr, n = 31) {
  let e = squash(expr);
  if (e.length <= n) return e;
  e = e.replace(/<(?:[^<>()]|<[^<>]*>)*>(?=\()/g, '');
  if (e.length <= n) return e;
  // collapse the arguments of the outermost call
  const m = /^([^()]*?)\((.*)\)\s*$/.exec(e);
  if (m && m[2].trim()) {
    const c = `${m[1]}(…)`;
    if (c.length <= n) return c;
    return clip(c, n);
  }
  return clip(e, n);
}

/**
 * All endings of the map. Each end box gets its sites classified from the source; a box whose sites differ is `mixed`.
 * @returns {{ends: object[], bySite: object[]}}
 */
export function classifyEnds(W, names) {
  const ends = [];
  const sites = [];
  for (const fid of W.mappedIds) {
    const f = W.fns.get(fid);
    for (const b of f.boxes) {
      if (b.kind !== 'end') continue;
      const cls = b.prov.class ?? '';
      const lines = b.prov.sites?.length ? b.prov.sites : [b.prov.line];
      const out = [];
      for (const ln of lines) {
        const ex = W.source.exitExpr(f.path, ln);
        let kind = ex?.kind ?? '';
        if (!kind) kind = cls.startsWith('raise') ? 'raise' : cls === 'X' ? 'exit' : 'return';
        const expr = cleanExit(ex?.text ?? '', langOf(f.path));
        const r = classifySite({ kind, expr, cls, fnName: names.label(fid) });
        out.push({ line: ln, kind, expr, outcome: r.outcome, why: r.why, caught: cls.startsWith('raise-caught') ? 'caught on a known path' : cls.startsWith('raise-open') ? 'no known catcher' : '' });
      }
      const set = [...new Set(out.map((s) => s.outcome))];
      const outcome = set.length === 1 ? set[0] : 'mixed';
      const rec = { box: b.id, fn: fid, path: f.path, line: b.prov.line, cls, outcome, sites: out };
      ends.push(rec);
      for (const s of out) sites.push({ box: b.id, fn: fid, path: f.path, ...s });
    }
  }
  return { ends, sites };
}
