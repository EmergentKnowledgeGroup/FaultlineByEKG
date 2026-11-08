// W-part-name: the names of chart parts (a stage above 21 boxes is split into parts, each named by a box's `partName`, by model.partNames {boxId: name}, or
// else by its first box's title). partNameWarnings(model, charts) reads the charts chartsFromModel made and says where a name misleads:
//   - two parts of one stage with the same name (the page numbers the second "Name (5)")
//   - one name given to boxes that now sit in different parts: a name follows a box when the part is cut differently, so it can describe a box that went elsewhere
//   - one part named twice, by two boxes with different names: only the first in reading order counts
//   - a partNames entry for a box that is not in the model
// Pure: charts are plain objects ({id, kind, stage, name, nameDup, nameOther, entry, boxes}), so the model layer needs nothing from src/build.
export function partNameWarnings(model, charts) {
  const w = [];
  if (!Array.isArray(charts)) return w;
  const add = (msg, at) => w.push({ code: 'W-part-name', msg, at });
  const ids = new Set((model.boxes || []).map((b) => b.id)), byId = new Map((model.boxes || []).map((b) => [b.id, b]));
  const given = (id) => { const t = (model.partNames || {})[id] ?? (byId.get(id) || {}).partName; return typeof t === 'string' ? t.trim() : ''; };
  const parts = charts.filter((c) => c.kind === 'stage' && c.parts > 1);
  const reported = new Set();                                                       // "stage|name" already said
  for (const c of parts) {
    if (!c.nameDup) continue;
    const first = parts.find((x) => x.stage === c.stage && x.name === c.nameDup);
    reported.add(`${c.stage}|${c.nameDup}`);
    add(`parts ${first ? first.id : '?'} and ${c.id} of stage ${c.stage} are both named "${c.nameDup}" (the page numbers the second "${c.name}"): a name given to boxes of one part now sits in several; name each part for what it holds, in model/95-parts.json`, c.entry || (c.boxes[0] || {}).id);
  }
  for (const stage of [...new Set(parts.map((c) => c.stage))]) {
    const where = new Map();                                                         // name -> Map(chart id -> a box that gives it)
    for (const c of parts.filter((x) => x.stage === stage)) for (const b of c.boxes) {
      const t = given(b.id); if (!t) continue;
      if (!where.has(t)) where.set(t, new Map());
      if (!where.get(t).has(c.id)) where.get(t).set(c.id, b.id);
    }
    for (const [t, m] of where) {
      if (m.size < 2 || reported.has(`${stage}|${t}`)) continue;
      const list = [...m.entries()];
      add(`the name "${t}" is given to boxes in ${m.size} parts of stage ${stage} (${list.slice(0, 3).map(([c, b]) => `${b} in ${c}`).join(', ')}${m.size > 3 ? ', ...' : ''}): it follows a box when the parts are cut again, so it may describe a box that went elsewhere; check each part's name`, list[0][1]);
    }
  }
  for (const c of parts) if ((c.nameOther || []).length) {
    const o = c.nameOther[0];
    add(`part ${c.id} is named "${c.name}" by box ${c.nameBox} and also "${o.name}" by box ${o.box}${c.nameOther.length > 1 ? ` (and ${c.nameOther.length - 1} more)` : ''}: only the first in reading order counts`, c.nameBox);
  }
  for (const k of Object.keys(model.partNames || {})) if (!ids.has(k)) add(`partNames names box ${k}, which is not in the model: the name is ignored`, k);
  return w;
}
