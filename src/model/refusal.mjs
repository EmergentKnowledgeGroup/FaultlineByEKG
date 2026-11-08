// Refusal text: REFUSE <code> <what>: <first offender>. Fix: <how>.
// One refusal per code and kind of offence; `offenders` keeps every id so a caller can list more on request.

const strip = (s) => String(s ?? '').trim().replace(/[.\s]+$/, '');

export function refusal(code, what, offender, fix, { at = '', offenders = null, count = null, extra = null } = {}) {
  const list = offenders ? [...offenders] : [];
  const n = count ?? (list.length || 1);
  const more = n > 1 ? ` (and ${n - 1} more)` : '';
  const out = { code, msg: plainWords(`REFUSE ${code} ${what}: ${strip(offender)}${more}. Fix: ${strip(fix)}.`), at: String(at || list[0] || '') };
  if (list.length) out.offenders = list;
  if (n > 1 || list.length) out.count = n;
  if (extra) Object.assign(out, extra);
  return out;
}

// Raised by loadModel. Carries the same {code,msg,at} records validateModel returns.
export class ModelRefusal extends Error {
  constructor(refusals) {
    super(refusals.map((r) => r.msg).join('\n'));
    this.name = 'ModelRefusal';
    this.refusals = refusals;
  }
}

// Plain-words guard for generated text. The word 'bug' never reaches a reader; neither do the hard claims the
// contracts rule out. Used on every sentence analyze builds, and by the tests as a final sweep.
const BANNED = [
  [/\bbugs?\b/gi, 'problem'],
  [/\bdead[- ]ends?\b/gi, 'no way on'],
  [/\bunbounded\b/gi, 'no limit shown'],
  [/\bdoes not exist\b/gi, 'is not drawn'],
  [/\bdoesn't exist\b/gi, 'is not drawn'],
];
export function plainWords(s) {
  let t = String(s ?? '');
  for (const [re, to] of BANNED) t = t.replace(re, to);
  return t;
}
export function hasBannedWord(s) {
  const t = String(s ?? '');
  return BANNED.some(([re]) => { re.lastIndex = 0; return re.test(t); });
}
