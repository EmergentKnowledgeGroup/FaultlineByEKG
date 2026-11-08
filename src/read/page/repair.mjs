// node repair.mjs <project dir> [--budgets 20,60]
// After placement: every chart whose saved layout still has a hard defect (an overlap, a line through a box, a label on a label ...) is placed again with a longer search, up to the listed budgets in seconds.
// Prints the charts that still have a defect at the end (none is the goal) and exits 1 when any is left.
import { loadModelReport } from '../../model/index.mjs';
import { chartsFromModel } from '../../build/charts.mjs';
import * as LY from '../../build/layout.mjs';
const args = process.argv.slice(2);
const dir = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
if (!dir) { console.error('usage: repair.mjs <project dir> [--budgets 20,60]'); process.exit(2); }
const { model, refusals } = loadModelReport(dir);
if (refusals.length) { console.error('model refused', refusals.slice(0, 3)); process.exit(2); }
const charts = chartsFromModel(model).filter((c) => c.kind === 'detail');
const hardOf = async () => {
  const L = await LY.loadLayouts(dir, model, charts);
  return Object.entries(L.metrics).filter(([, m]) => LY.HARD.some((k) => m[k] > 0)).map(([id]) => id).concat(L.missing ?? []);
};
let bad = await hardOf();
console.log(`charts with a hard defect: ${bad.length}`);
for (const b of (opt('--budgets', '20,60')).split(',').map(Number)) {
  for (const id of bad) await LY.placeProject(dir, model, chartsFromModel(model), { only: [id], force: true, budgetSeconds: b, log: () => {} });
  bad = await hardOf();
  console.log(`after a search of ${b} s: ${bad.length} left${bad.length ? ' (' + bad.join(' ') + ')' : ''}`);
  if (!bad.length) break;
}
process.exit(bad.length ? 1 : 0);
