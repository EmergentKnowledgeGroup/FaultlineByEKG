// Who hears about an ending. Optional top-level model data, merged from any fragment:
//   "heardBy": {"<box id>": {"by": "person|outside|event|caller|log|nobody|unclear", "how": "short phrase"}}
// It usually sits on an end box, but any box may carry it: a failure can be heard about while the story goes on (an 'error' event emitted at a step, then the flow continues).
// Only the code can say it, so nothing here is ever guessed: a box with no entry is "not said yet".
// Shared by the page builder (atlasdata.mjs, counts.mjs), the agent view and the check (W-heard).

export const HEARD_BY = ['person', 'outside', 'event', 'caller', 'log', 'nobody', 'unclear'];
// the plain words for each value, used verbatim by the page, the agent view and the docs
export const HEARD_WORDS = {
  person: 'a person using the system is told',
  outside: 'sent to a party outside the system',
  event: 'published for whoever listens (an event, a metric, a webhook)',
  caller: 'thrown or returned to the code that called',
  log: 'only written to a log',
  nobody: 'no trace',
  unclear: 'the code does not settle it',
};
// the short label for a group heading or a filter button
export const HEARD_SHORT = { person: 'A person is told', outside: 'An outside party', event: 'Published as an event', caller: 'Goes back to the caller', log: 'Only in a log', nobody: 'Nobody', unclear: 'Not settled by the code' };
// the values that leave a failure with nobody told: they open the "Failures nobody is told about" section
export const SILENT_BY = new Set(['nobody', 'log']);
// a box belongs in "Failures and refusals nobody is told about" when it is heard by nobody (a failure or a refusal: the person clicked and nothing showed) or only by a log (a failure only:
// a refusal that is logged is the system saying no in its own way). A success or a neutral ending never does. A box with no outcome counts: a step can fail quietly.
export const silentBox = (b, h) => {
  if (!h || !SILENT_BY.has(h.by)) return false;
  const o = String(b.outcome || '');
  if (o === 'success' || o === 'neutral') return false;
  return !(h.by === 'log' && o === 'refusal');
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

// the clean map {boxId: {by, how}}: an entry with an unknown `by` is dropped here (the check names it)
export function heardMap(model) {
  const out = {};
  for (const [id, e] of Object.entries(isObj(model && model.heardBy) ? model.heardBy : {})) {
    if (!isObj(e) || !HEARD_BY.includes(text(e.by))) continue;
    out[id] = { by: text(e.by), ...(text(e.how) ? { how: text(e.how) } : {}) };
  }
  return out;
}

// W-heard problems, never a refusal: a failure or refusal END box with no entry; an entry that names a box that does not exist; an entry with an unknown `by`. A box that is not an end box may carry an entry.
export function heardIssues(model) {
  const boxes = model.boxes || [], byId = new Map(boxes.map((b) => [b.id, b])), raw = isObj(model.heardBy) ? model.heardBy : {}, out = [];
  const need = boxes.filter((b) => b.kind === 'end' && (b.outcome === 'failure' || b.outcome === 'refusal'));
  for (const b of need) if (!(b.id in raw)) out.push({ code: 'W-heard', kind: 'missing', at: b.id, msg: `box ${b.id} is a ${b.outcome} ending with no heardBy entry: say who hears it (person, outside, event, caller, log, nobody) or "unclear"` });
  for (const [id, e] of Object.entries(raw)) {
    const b = byId.get(id);
    if (!b) out.push({ code: 'W-heard', kind: 'unknown-box', at: id, msg: `heardBy names ${id}, which is not a box` });
    if (!isObj(e) || !HEARD_BY.includes(text(e.by))) out.push({ code: 'W-heard', kind: 'bad-by', at: id, msg: `heardBy for ${id} says by "${isObj(e) ? text(e.by) : String(e)}": use one of ${HEARD_BY.join(', ')}` });
  }
  return out;
}
