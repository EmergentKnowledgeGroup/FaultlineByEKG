// walkPaths(projectDir, model, facts) -> [{id, tool, kind, title, outcome, strength, count, says, label, boxes:[ordered box ids]}]
// The evidence importer folds walks into per-box levels; the viewer also wants each ordered run as a path it can light. This reads the same
// walk files again and keeps, per outcome, the boxes its mapped steps touched in order (consecutive repeats dropped). Unordered evidence
// (coverage) has no path and is skipped. Reads only.
import fs from 'node:fs';
import path from 'node:path';
import { readWalkFile, validateWalk, buildIndex, mapStep, lights } from '../evidence/index.mjs';
import { scrubText } from '../evidence/scrub.mjs';

export function walkPaths(projectDir, model, facts, { maxPaths = 40 } = {}) {
  const dir = path.join(projectDir, 'walks');
  if (!fs.existsSync(dir) || !facts) return [];
  const ix = buildIndex(model, facts), out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.walk.jsonl')).sort()) {
    let w, v;
    try { w = readWalkFile(path.join(dir, f)); v = validateWalk(w); } catch { continue; }
    if (!v.ok) continue;
    w.outcomes.forEach((o, i) => {
      if (o.unordered || out.length >= maxPaths) return;
      const boxes = []; let prev = null;
      for (const s of o.steps.slice(0, 5000)) {
        const L = lights(mapStep(ix, s));
        if (!L.length) continue;
        const pick = (prev && L.find((b) => ix.between.has(prev + '\u0000' + b))) || L[0];
        if (pick !== prev) { boxes.push(pick); prev = pick; }
      }
      const m = /^(end|stuck):(.+)$/.exec(o.outcome || '');
      if (m && ix.boxes.has(m[2]) && boxes[boxes.length - 1] !== m[2]) boxes.push(m[2]);
      if (boxes.length < 2) return;
      const outcome = scrubText(o.outcome, { cap: 200 });          // these go into the page: no path, email or secret from the walk's own words
      out.push({ id: `${scrubText(f.replace(/\.walk\.jsonl$/, ''), { cap: 120 })}#${i + 1}`, tool: scrubText(w.header.tool, { cap: 60 }), kind: w.header.kind, title: outcome, outcome, strength: o.strength,
        count: o.count || 1, label: v.effectiveLabel, says: v.says, boxes });
    });
  }
  return out;
}
