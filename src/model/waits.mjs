// What a wait box waits for. Optional top-level model data, merged from any fragment:
//   "waitsFor": {"<wait box id>": {"on": "person|machine|outside|time", "how": "short phrase"}}
// Only the model's author can say it: the page never guesses it from the words of a box. A wait with no entry is treated as it always was.
// A wait on a person (a reply, a click, a form filled in) is the system doing what it should, so the page files it apart ("Waiting for a person"), outside the count of things to look at.
// Shared by the page builder (atlasdata.mjs, counts.mjs), the agent view and the check (W-waits).

export const WAIT_ON = ['person', 'machine', 'outside', 'time'];
export const WAIT_WORDS = { person: 'a person', machine: 'another part of the system', outside: 'something outside the system', time: 'the clock' };

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

// the clean map {boxId: {on, how}}: an entry with an unknown `on` is dropped here (the check names it)
export function waitsMap(model) {
  const out = {};
  for (const [id, e] of Object.entries(isObj(model && model.waitsFor) ? model.waitsFor : {})) {
    if (!isObj(e) || !WAIT_ON.includes(text(e.on))) continue;
    out[id] = { on: text(e.on), ...(text(e.how) ? { how: text(e.how) } : {}) };
  }
  return out;
}

// W-waits problems, never a refusal: an entry that names a box that does not exist, one that names a box that is not a wait, one with an unknown `on`
export function waitIssues(model) {
  const boxes = model.boxes || [], byId = new Map(boxes.map((b) => [b.id, b])), raw = isObj(model.waitsFor) ? model.waitsFor : {}, out = [];
  for (const [id, e] of Object.entries(raw)) {
    const b = byId.get(id);
    if (!b) out.push({ code: 'W-waits', kind: 'unknown-box', at: id, msg: `waitsFor names ${id}, which is not a box` });
    else if (b.kind !== 'wait') out.push({ code: 'W-waits', kind: 'not-a-wait', at: id, msg: `waitsFor names ${id}, which is a ${b.kind || 'step'} and not a wait box` });
    if (!isObj(e) || !WAIT_ON.includes(text(e.on))) out.push({ code: 'W-waits', kind: 'bad-on', at: id, msg: `waitsFor for ${id} says on "${isObj(e) ? text(e.on) : String(e)}": use one of ${WAIT_ON.join(', ')}` });
  }
  return out;
}
